import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabasePool, initialOwnerId, type DatabasePool, withTransaction } from "../../packages/database/src/pool.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { applyCastBatchWithClient, createPostgresCampaignCastRepository } from "../../packages/database/src/campaign-cast-repository.js";
import { exportCampaignCast, importCampaignCast } from "../../packages/database/src/campaign-cast-portability.js";
import { loadCampaignArchiveExportSnapshot } from "../../packages/database/src/campaign-archive-export-repository.js";
import { campaignArchivePayloads } from "../../services/runtime/src/campaign-archive-export-composition.js";
import { createPostgresSystemArchiveExportRepository } from "../../packages/database/src/system-archive-export-repository.js";
import { importLegacyStory } from "../helpers/memory-aware-services.js";
import { storyImportRequestSchema } from "../../packages/contracts/src/imports.js";
import { SYSTEM_ARCHIVE_DOMAINS, type SystemRecordEnvelope } from "../../packages/contracts/src/system-archives.js";
import { createPostgresSystemArchiveImportRepository } from "../../packages/database/src/system-archive-import-repository.js";
import { createPostgresPortableFamilyMutationRepository } from "../../packages/database/src/portable-import-family-repository.js";
import { createPostgresWorldRepositoryAdapters } from "../../packages/database/src/world-repository.js";
import { memoryGeneration } from "../helpers/memory-applications.js";
import { sha256 } from "../../packages/domain/src/text.js";
import { applyCastBoundaryChange, copyCampaignCast } from "../../packages/database/src/campaign-cast-lifecycle.js";

const integration = process.env.TEST_DATABASE_URL ? describe : describe.skip;
integration("campaign cast portable authority", () => {
  let pool: DatabasePool, ownerUserId: string;
  beforeAll(async () => {
    pool = createDatabasePool(process.env.TEST_DATABASE_URL!, 8);
    await migrateDatabase(pool, resolve("database/migrations"));
    ownerUserId = await initialOwnerId(pool);
  }, 60_000);
  afterAll(async () => { await pool?.end(); });
  async function fixture() {
    const world = randomUUID(), version = randomUUID(), campaignId = randomUUID();
    await pool.query("INSERT INTO worlds(id,owner_user_id,title) VALUES($1,$2,'Cast portable')", [world, ownerUserId]);
    await pool.query("INSERT INTO world_versions(id,world_id,owner_user_id,version_number,content) VALUES($1,$2,$3,1,$4)", [version, world, ownerUserId, { world: { title: "Cast portable" } }]);
    await pool.query("INSERT INTO campaigns(id,owner_user_id,world_version_id,title) VALUES($1,$2,$3,'Cast portable')", [campaignId, ownerUserId, version]);
    return { ownerUserId, campaignId };
  }
  it("round-trips v4 merge receipts and preserves later alias edits through undo", async () => {
    const source = await fixture(), destination = await fixture();
    const repo = createPostgresCampaignCastRepository(pool, { editingEnabled: true, lifecycleEnabled: true });
    const initial = await repo.current(source);
    const target = await repo.create(source, { expectedCastRevision: initial.revision, expectedBoundary: initial.boundary,
      idempotencyKey: randomUUID(), name: "Mara", aliases: ["First"], profile: {} });
    const other = await repo.create(source, { expectedCastRevision: target.revision, expectedBoundary: target.boundary,
      idempotencyKey: randomUUID(), name: "Mara Two", aliases: [], profile: {} });
    const beforeArchive = await withTransaction(pool, client => exportCampaignCast(client, source));
    const before = await repo.current(source), a = before.characters.find(person => person.id === target.character.id)!, b = before.characters.find(person => person.id === other.character.id)!;
    const merged = await repo.merge!(source, a.id, { expectedCastRevision: before.revision, expectedBoundary: before.boundary,
      expectedCharacterRevision: a.revision, expectedSourceCharacterRevision: b.revision, sourceCharacterId: b.id,
      reviewedAliases: ["First", "Mara Two"], choices: {}, idempotencyKey: randomUUID() });
    await repo.edit(source, a.id, { expectedCastRevision: merged.revision, expectedBoundary: merged.boundary,
      expectedCharacterRevision: merged.character.revision, aliases: ["Mara Two", "Later"], idempotencyKey: randomUUID() });
    const archive = await withTransaction(pool, client => exportCampaignCast(client, source));
    expect(archive?.formatVersion).toBe(4);
    const malformed = structuredClone(archive!);
    const laterIdentity = malformed.events.flatMap(event => event.commands).find(item => item.command.kind === "identity" && item.command.aliasChanges);
    if (!laterIdentity || laterIdentity.command.kind !== "identity" || !laterIdentity.command.aliasChanges) throw new Error("Expected later alias edit");
    laterIdentity.command.aliasChanges.added = [];
    await expect(withTransaction(pool, client => importCampaignCast(client, destination, malformed, { turns: new Map(), worlds: new Map() }))).rejects.toThrow();
    expect((await pool.query("SELECT count(*)::int AS n FROM campaign_cast_state WHERE campaign_id=$1", [destination.campaignId])).rows[0].n).toBe(0);
    if (process.env.IQ_PHASE6_BASELINE) {
      const oldReader = await import(`${process.env.IQ_PHASE6_BASELINE}/packages/contracts/src/campaign-cast.ts`);
      expect(oldReader.portableCampaignCastSchema.safeParse(beforeArchive).success).toBe(true);
      expect(oldReader.portableCampaignCastSchema.safeParse(archive).success).toBe(false);
    }
    await withTransaction(pool, client => importCampaignCast(client, destination, archive, { turns: new Map(), worlds: new Map() }));
    const restored = await repo.current(destination), restoredTarget = restored.characters.find(person => person.name === "Mara")!;
    const restoredSource = restored.characters.find(person => person.name === "Mara Two")!;
    expect(restoredSource.mergedIntoCharacterId).toBe(restoredTarget.id);
    expect(restoredTarget.activeMerges?.[0]?.sourceCharacterId).toBe(restoredSource.id);
    const imported = await withTransaction(pool, client => exportCampaignCast(client, destination));
    const receipt = imported!.events.at(-1)!.receipt!.result!.character;
    expect(receipt.activeMerges?.[0]?.sourceCharacterId).toBe(restoredSource.id);
    expect(receipt.activeMerges?.[0]?.mergeEventId).toBe(restoredTarget.activeMerges![0]!.mergeEventId);
    const branch = await fixture();
    await withTransaction(pool, client => copyCampaignCast(client, source, branch, 0, new Map()));
    const branchCast = await repo.current(branch), branchTarget = branchCast.characters.find(person => person.name === "Mara")!;
    const branchSource = branchCast.characters.find(person => person.name === "Mara Two")!;
    expect(branchSource.mergedIntoCharacterId).toBe(branchTarget.id);
    expect(branchTarget.activeMerges?.[0]?.sourceCharacterId).toBe(branchSource.id);
    expect(branchTarget.activeMerges?.[0]?.mergeEventId).not.toBe(restoredTarget.activeMerges?.[0]?.mergeEventId);
    const undone = await repo.unmerge!(destination, restoredTarget.id, { expectedCastRevision: restored.revision,
      expectedBoundary: restored.boundary, expectedCharacterRevision: restoredTarget.revision,
      expectedSourceCharacterRevision: restoredSource.revision, mergeEventId: restoredTarget.activeMerges![0]!.mergeEventId, idempotencyKey: randomUUID() });
    expect(undone.character.aliases).toEqual(["Later"]);
  });
  it("round-trips empty-cast eligibility in both archive families and defaults historical records to false", async () => {
    const samples: Array<{ campaignId: string; worldId: string; worldVersionId: string; selectedWorldId: string | null; marker: boolean | undefined }> = [];
    for (const marker of [true, false, undefined]) {
      const story = JSON.parse(await readFile(resolve("tests/fixtures/legacy-story.json"), "utf8"));
      story.world.title = `Empty eligibility ${randomUUID()}`;
      const imported = await importLegacyStory(pool, storyImportRequestSchema.parse({ sourceName: "empty.story", story }));
      const selectedWorldId = marker === true ? imported.worldId : marker === false ? randomUUID() : null;
      await pool.query("UPDATE campaigns SET first_appearance_eligible=$2,selected_character_world_id=$3 WHERE id=$1", [imported.campaignId, marker === true, selectedWorldId]);
      expect((await pool.query("SELECT count(*)::int AS n FROM campaign_cast_events WHERE campaign_id=$1", [imported.campaignId])).rows[0].n).toBe(0);
      samples.push({ ...imported, marker, selectedWorldId });
    }
    const mutations = createPostgresPortableFamilyMutationRepository(createPostgresWorldRepositoryAdapters(pool, { memory: memoryGeneration(pool) }).worlds);
    for (const sample of samples) {
      const payload = JSON.parse(JSON.stringify(campaignArchivePayloads(await loadCampaignArchiveExportSnapshot(pool, ownerUserId, sample.campaignId))));
      expect(payload.campaign.archiveRecords.cast).toBeUndefined();
      if (sample.marker === undefined) { delete payload.campaign.campaign.firstAppearanceEligible; delete payload.campaign.campaign.selectedCharacterWorldId; payload.campaign.formatVersion = 4; }
      const restored = await withTransaction(pool, client => mutations.commitCampaignZip(client, {
        owner: { ownerUserId }, destination: { kind: "existing_world_version", worldId: sample.worldId, worldVersionId: sample.worldVersionId },
        authorityFingerprint: sha256(randomUUID()), publishedAssets: [],
        payload: { archiveFormat: "manifest_v1", sourceName: "empty.zip", ...payload }
      }));
      expect((await pool.query("SELECT first_appearance_eligible,selected_character_world_id FROM campaigns WHERE id=$1", [restored.campaignId])).rows[0]).toEqual({ first_appearance_eligible: sample.marker === true, selected_character_world_id: sample.selectedWorldId });
      expect((await pool.query("SELECT count(*)::int AS n FROM campaign_cast_events WHERE campaign_id=$1", [restored.campaignId])).rows[0].n).toBe(0);
    }
    const records: SystemRecordEnvelope[] = [];
    await createPostgresSystemArchiveExportRepository(pool, { sourceApplicationVersion: "0.1.0" }).withOwnerSnapshot({ ownerUserId }, async snapshot => {
      for (const domain of SYSTEM_ARCHIVE_DOMAINS) for await (const record of snapshot.streamDomain(domain)) records.push(record);
    });
    const historical = records.find(record => record.domain === "campaigns" && record.sourceId === samples[2]!.campaignId)!;
    delete (historical.record as { selectedCharacterWorldId?: string | null }).selectedCharacterWorldId;
    delete (historical.record as { firstAppearanceEligible?: boolean }).firstAppearanceEligible;
    delete (historical.record as { campaignRecordVersion?: number }).campaignRecordVersion;
    const databaseName = `cast_empty_${randomUUID().replaceAll("-", "")}`;
    await pool.query(`CREATE DATABASE ${databaseName}`);
    const url = new URL(process.env.TEST_DATABASE_URL!); url.pathname = `/${databaseName}`;
    const destination = createDatabasePool(url.toString(), 4);
    try {
      await migrateDatabase(destination, resolve("database/migrations"));
      const target = { ownerUserId: await initialOwnerId(destination) }, imports = createPostgresSystemArchiveImportRepository(destination);
      await imports.withAtomicImport(target, { destination: await imports.destinationFingerprint(target, {}), ignore: {} }, transaction => transaction.insertLogicalDomains(records));
      for (const sample of samples) {
        expect((await destination.query("SELECT first_appearance_eligible,selected_character_world_id FROM campaigns WHERE id=$1", [sample.campaignId])).rows[0]).toEqual({ first_appearance_eligible: sample.marker === true, selected_character_world_id: sample.selectedWorldId });
        expect((await destination.query("SELECT count(*)::int AS n FROM campaign_cast_events WHERE campaign_id=$1", [sample.campaignId])).rows[0].n).toBe(0);
      }
    } finally { await destination.end(); await pool.query(`DROP DATABASE ${databaseName}`); }
  });
  it("restores cast through the real System Archive transaction after turns are restored", async () => {
    const story = JSON.parse(await readFile(resolve("tests/fixtures/legacy-story.json"), "utf8"));
    story.world.title = `Cast system restore ${randomUUID()}`;
    const imported = await importLegacyStory(pool, storyImportRequestSchema.parse({ sourceName: "cast.story", story }));
    const scope = { ownerUserId, campaignId: imported.campaignId };
    const repo = createPostgresCampaignCastRepository(pool, { editingEnabled: true, lifecycleEnabled: true });
    const initial = await repo.current(scope);
    const created = await repo.create(scope, { expectedCastRevision: initial.revision, expectedBoundary: initial.boundary, idempotencyKey: "system",
      name: "Mara", aliases: [], profile: { "appearance.description": "" } });
    const turn = (await pool.query("SELECT turn_id,turn_number,correction_revision,effective_narration FROM effective_turn_narrations WHERE campaign_id=$1 ORDER BY turn_number LIMIT 1", [scope.campaignId])).rows[0];
    const quote = turn.effective_narration.slice(0, 10), sourceHash = sha256(turn.effective_narration);
    await withTransaction(pool, client => applyCastBatchWithClient(client, scope, { boundary: initial.boundary, idempotencyKey: "system-attachment",
      commands: [{ kind: "observe", characterId: created.character.id, field: "appearance.description", value: "blue eyes", mode: "fact", speakerCharacterId: null, supersedesObservationId: null,
        evidence: { kind: "turn", turnId: turn.turn_id, turnNumber: turn.turn_number, narrationRevision: turn.correction_revision, sourceHash, paragraphId: "p1", quote } }] },
      { attachment: { characterId: created.character.id, basis: "unique_name", sourceRanges: [{ turnId: turn.turn_id, narrationRevision: turn.correction_revision, sourceHash, paragraphId: "p1", start: 0, end: quote.length }] } }));
    const current = await repo.current(scope);
    const second = await repo.create(scope, { expectedCastRevision: current.revision, expectedBoundary: current.boundary,
      idempotencyKey: "system-second", name: "Mary", aliases: [], profile: {} });
    const targetBefore = (await repo.current(scope)).characters.find(person => person.id === created.character.id)!;
    await repo.merge!(scope, created.character.id, { expectedCastRevision: second.revision, expectedBoundary: second.boundary,
      expectedCharacterRevision: targetBefore.revision, expectedSourceCharacterRevision: second.character.revision,
      sourceCharacterId: second.character.id, reviewedAliases: ["Mary"], choices: {}, idempotencyKey: "system-merge" });
    await pool.query("UPDATE campaigns SET first_appearance_eligible=true WHERE id=$1", [scope.campaignId]);
    const records: SystemRecordEnvelope[] = [];
    await createPostgresSystemArchiveExportRepository(pool, { sourceApplicationVersion: "0.1.0" }).withOwnerSnapshot({ ownerUserId }, async (snapshot) => {
      for (const domain of SYSTEM_ARCHIVE_DOMAINS) for await (const record of snapshot.streamDomain(domain)) records.push(record);
    });
    const databaseName = `cast_restore_${randomUUID().replaceAll("-", "")}`;
    await pool.query(`CREATE DATABASE ${databaseName}`);
    const url = new URL(process.env.TEST_DATABASE_URL!); url.pathname = `/${databaseName}`;
    const destination = createDatabasePool(url.toString(), 4);
    try {
      await migrateDatabase(destination, resolve("database/migrations"));
      const target = { ownerUserId: await initialOwnerId(destination) };
      const imports = createPostgresSystemArchiveImportRepository(destination);
      await imports.withAtomicImport(target, { destination: await imports.destinationFingerprint(target, {}), ignore: {} }, async (transaction) => {
        await transaction.insertLogicalDomains(records);
      });
      expect((await destination.query("SELECT first_appearance_eligible FROM campaigns WHERE id=$1", [scope.campaignId])).rows[0].first_appearance_eligible).toBe(true);
      const value = await createPostgresCampaignCastRepository(destination).current({ ...target, campaignId: scope.campaignId });
      const person = value.characters.find(character => character.name === "Mara")!;
      const hidden = value.characters.find(character => character.name === "Mary")!;
      expect(person.profile).toEqual({ "appearance.description": "" });
      expect(hidden.mergedIntoCharacterId).toBe(person.id);
      expect(person.activeMerges?.[0]?.sourceCharacterId).toBe(hidden.id);
      const restoredRepository = createPostgresCampaignCastRepository(destination, { editingEnabled: true });
      const restoredScope = { ...target, campaignId: scope.campaignId };
      const detail = await restoredRepository.detail(restoredScope, person.id);
      expect(detail.autoMatches).toHaveLength(1);
      await restoredRepository.detachAttachment(restoredScope, person.id, detail.autoMatches[0]!.eventId, {
        expectedCastRevision: detail.revision, expectedBoundary: detail.boundary, expectedCharacterRevision: person.revision, idempotencyKey: "restore-undo" });
      expect((await restoredRepository.detail(restoredScope, person.id)).observations).toEqual([]);
    } finally { await destination.end(); await pool.query(`DROP DATABASE ${databaseName}`); }
  });
  it("selects v3 for a long ordinary goal and rejects an invalid v2 declaration atomically", async () => {
    const source = await fixture(), destination = await fixture(), repo = createPostgresCampaignCastRepository(pool, { editingEnabled: true });
    const character = await repo.create(source, { expectedCastRevision: 0, expectedBoundary: { turnNumber: 0, timelineRevision: 0 },
      idempotencyKey: "long-goal", name: "Mara", aliases: [], profile: { "story.goals": "g".repeat(20_000) } });
    const payload = await withTransaction(pool, client => exportCampaignCast(client, source));
    expect(payload?.formatVersion).toBe(3);
    expect(payload?.events[0]?.receipt?.result?.character.profile).toEqual(character.character.profile);
    await expect(withTransaction(pool, client => importCampaignCast(client, destination, { ...payload, formatVersion: 2 },
      { turns: new Map(), worlds: new Map() }))).rejects.toThrow();
    expect((await pool.query("SELECT id FROM campaign_cast_events WHERE campaign_id=$1", [destination.campaignId])).rowCount).toBe(0);
    await withTransaction(pool, client => importCampaignCast(client, destination, payload, { turns: new Map(), worlds: new Map() }));
    expect((await repo.current(destination)).characters.find(person => person.name === "Mara")?.profile).toEqual(character.character.profile);
  });
  it("remaps archived seed activations, edits and receipts and rejects a dangling activation before restore", async () => {
    const source = await fixture(), destination = await fixture();
    const version = (await pool.query("SELECT world_version_id FROM campaigns WHERE id=$1", [source.campaignId])).rows[0].world_version_id;
    await pool.query("UPDATE world_versions SET content=$2 WHERE id=$1", [version, JSON.stringify({ world: { title: "Test world" },
      playableCharacters: [{ id: "keeper", name: "Keeper", characterText: "Original note", campaignUse: "supporting", profile: { story: { background: "b".repeat(3000) } } }] })]);
    const repo = createPostgresCampaignCastRepository(pool, { editingEnabled: true, castPresetsEnabled: true });
    const preview = await repo.fromWorldPreview!(source, { characterId: "keeper" });
    const added = await repo.fromWorld!(source, { characterId: "keeper", expectedWorldVersionId: version, expectedCastRevision: preview.castRevision,
      expectedBoundary: preview.boundary, idempotencyKey: "add", previewFingerprint: preview.previewFingerprint });
    const edited = await repo.editAuthoredProfile!(source, added.character.id, { expectedCastRevision: added.revision, expectedBoundary: added.boundary,
      expectedCharacterRevision: added.character.revision, idempotencyKey: "edit", set: { "story.role": "Warden" }, setOverrides: { "story.goals": "g".repeat(20000) } });
    const payload = (await withTransaction(pool, client => exportCampaignCast(client, source)))!;
    const forgedReceipt = structuredClone(payload);
    forgedReceipt.events.at(-1)!.receipt!.result!.character.originProfile!.rosterName = "Forged origin";
    await expect(withTransaction(pool, client => importCampaignCast(client, destination, forgedReceipt,
      { turns: new Map(), worlds: new Map() }))).rejects.toThrow();
    expect((await pool.query("SELECT count(*)::int n FROM campaign_cast_state WHERE campaign_id=$1", [destination.campaignId])).rows[0].n).toBe(0);
    const mappedDestination = await fixture();
    const mappedVersion = (await pool.query("SELECT world_version_id FROM campaigns WHERE id=$1", [mappedDestination.campaignId])).rows[0].world_version_id;
    await expect(withTransaction(pool, client => importCampaignCast(client, mappedDestination, payload,
      { turns: new Map(), worlds: new Map([[version, mappedVersion]]) }))).rejects.toThrow("cast_archive_reference_invalid");
    expect((await pool.query("SELECT count(*)::int n FROM campaign_cast_state WHERE campaign_id=$1", [mappedDestination.campaignId])).rows[0].n).toBe(0);
    await pool.query("UPDATE world_versions SET content=$2 WHERE id=$1", [mappedVersion,
      JSON.stringify({ world: { title: "Other" }, playableCharacters: [{ id: "different", name: "Different", characterText: "" }] })]);
    await expect(withTransaction(pool, client => importCampaignCast(client, mappedDestination, payload,
      { turns: new Map(), worlds: new Map([[version, mappedVersion]]) }))).rejects.toThrow("cast_archive_reference_invalid");
    const sourceContent = (await pool.query("SELECT content FROM world_versions WHERE id=$1", [version])).rows[0].content;
    await pool.query("UPDATE world_versions SET content=$2 WHERE id=$1", [mappedVersion, JSON.stringify(sourceContent)]);
    await withTransaction(pool, client => importCampaignCast(client, mappedDestination, payload, { turns: new Map(), worlds: new Map([[version, mappedVersion]]) }));
    const mappedPerson = (await repo.current(mappedDestination)).characters.find(person => person.name === "Keeper")!;
    expect(mappedPerson.originProfile).toMatchObject({ worldVersionId: mappedVersion, evidence: { kind: "world", worldVersionId: mappedVersion } });
    const broken = structuredClone(payload);
    const command = broken.events.flatMap(event => event.commands).find(item => item.command.kind === "edit_authored_profile")!.command;
    if (command.kind === "edit_authored_profile") command.seedEventId = randomUUID();
    await expect(withTransaction(pool, client => importCampaignCast(client, destination, broken, { turns: new Map(), worlds: new Map() }))).rejects.toThrow();
    await withTransaction(pool, client => importCampaignCast(client, destination, payload, { turns: new Map(), worlds: new Map() }));
    const restored = (await repo.current(destination)).characters.find(person => person.name === "Keeper")!;
    expect(restored.profile).toEqual(edited.character.profile);
    expect(restored.originProfile).toMatchObject({ legacyCharacterText: "Original note", evidence: { kind: "historical_world", sourceWorldVersionId: version } });
    expect(restored.originProfile?.seedEventId).not.toBe(added.character.originProfile?.seedEventId);
    const saved = (await withTransaction(pool, client => exportCampaignCast(client, destination)))!;
    const { removed: _removed, mergedIntoCharacterId: _merged, activeMerges: _merges, ...preLifecycle } = restored;
    expect(saved.events.at(-1)?.receipt?.result?.character).toEqual(preLifecycle);
  });
  it("round-trips separate identities and user blanks with new IDs and no profile caches", async () => {
    const source = await fixture(), destination = await fixture();
    const repo = createPostgresCampaignCastRepository(pool, { editingEnabled: true, lifecycleEnabled: true });
    const first = await repo.create(source, { expectedCastRevision: 0, expectedBoundary: { turnNumber: 0, timelineRevision: 0 }, idempotencyKey: "first", name: "Mara", aliases: [], profile: { "appearance.description": "" } });
    await repo.create(source, { expectedCastRevision: first.revision, expectedBoundary: first.boundary, idempotencyKey: "second", name: "Mara", aliases: [], profile: { "story.role": "guide" } });
    await withTransaction(pool, async (client) => {
      const payload = await exportCampaignCast(client, source);
      expect(payload).not.toHaveProperty("profiles");
      expect(JSON.stringify(payload)).not.toContain("owner_user_id");
      await importCampaignCast(client, destination, payload, { turns: new Map(), worlds: new Map() });
    });
    const restored = (await repo.current(destination)).characters.filter((c) => c.origin.kind !== "protagonist");
    expect(restored).toHaveLength(2);
    expect(restored.map((c) => c.name)).toEqual(["Mara", "Mara"]);
    expect(restored.map((c) => c.profile)).toContainEqual({ "appearance.description": "" });
    expect(restored.map((c) => c.id)).not.toContain(first.character.id);
  });
  it("rejects newer formats, forged ownership and foreign references before inserting cast rows", async () => {
    const scope = await fixture();
    for (const payload of [ { formatVersion: 99 }, { formatVersion: 1, revision: 0, characters: [], events: [], ownerUserId: randomUUID() } ]) {
      await expect(withTransaction(pool, (client) => importCampaignCast(client, scope, payload, { turns: new Map(), worlds: new Map() }))).rejects.toThrow();
    }
    expect((await pool.query("SELECT count(*)::int n FROM campaign_cast_state WHERE campaign_id=$1", [scope.campaignId])).rows[0].n).toBe(0);
  });
  it("rejects forged attachment ranges before writing cast authority", async () => {
    const scope = await fixture(), characterId = randomUUID(), turnId = randomUUID(), createId = randomUUID(), eventId = randomUUID(), observationId = randomUUID();
    await pool.query("INSERT INTO turns(id,owner_user_id,campaign_id,turn_number,narration) VALUES($1,$2,$3,1,'Mara waits.')", [turnId, scope.ownerUserId, scope.campaignId]);
    await pool.query("UPDATE campaigns SET active_turn_number=1 WHERE id=$1", [scope.campaignId]);
    const origin = { kind: "manual" }, evidence = { kind: "turn", turnId, turnNumber: 1, narrationRevision: 0,
      sourceHash: sha256("Mara waits."), paragraphId: "p1", quote: "Mara" };
    const payload = { formatVersion: 2, revision: 2, characters: [{ id: characterId, origin, firstObservedTurn: 0 }], events: [
      { id: createId, effectiveTurnNumber: 0, revision: 1, commands: [{ characterId, command: { kind: "create", name: "Mara", aliases: [], origin } }] },
      { id: eventId, effectiveTurnNumber: 1, revision: 2, commands: [{ observationId, command: { kind: "observe", characterId,
        field: "story.role", value: "guide", mode: "fact", speakerCharacterId: null, evidence, supersedesObservationId: null } }],
        attachment: { eventId, characterId, basis: "unique_name", sourceRanges: [{ turnId, narrationRevision: 0,
          sourceHash: evidence.sourceHash, paragraphId: "p1", start: 5, end: 10 }], observationIds: [observationId] } }
    ] };
    await expect(withTransaction(pool, (client) => importCampaignCast(client, scope, payload, { turns: new Map([[turnId, turnId]]), worlds: new Map() }))).rejects.toThrow("cast_archive_reference_invalid");
    expect((await pool.query("SELECT count(*)::int n FROM campaign_cast_state WHERE campaign_id=$1", [scope.campaignId])).rows[0].n).toBe(0);
  });
  it("rejects forged identity chronology before writing authority", async () => {
    const scope = await fixture(), characterId = randomUUID();
    await pool.query("UPDATE campaigns SET active_turn_number=2 WHERE id=$1", [scope.campaignId]);
    const payload = { formatVersion: 1, revision: 1, characters: [{ id: characterId, origin: { kind: "manual" }, firstObservedTurn: 2 }],
      events: [{ id: randomUUID(), effectiveTurnNumber: 1, revision: 1, commands: [{ characterId, command: { kind: "create", name: "Mara", aliases: [], origin: { kind: "manual" } } }] }] };
    await expect(withTransaction(pool, (client) => importCampaignCast(client, scope, payload, { turns: new Map(), worlds: new Map() }))).rejects.toThrow();
    const futureIntroduction = { ...payload, characters: [{ id: characterId, origin: { kind: "discovered" }, firstObservedTurn: 2 }],
      events: [{ ...payload.events[0], commands: [{ characterId, command: { kind: "create", name: "Mara", aliases: [], origin: { kind: "discovered" },
        evidence: { kind: "turn", turnId: randomUUID(), turnNumber: 2, invalidated: true, narrationRevision: 0,
          sourceHash: sha256("Mara arrives."), paragraphId: "p1", quote: "Mara arrives." } } }] }] };
    await expect(withTransaction(pool, (client) => importCampaignCast(client, scope, futureIntroduction, { turns: new Map(), worlds: new Map() }))).rejects.toThrow();
    expect((await pool.query("SELECT count(*)::int n FROM campaign_cast_state WHERE campaign_id=$1", [scope.campaignId])).rows[0].n).toBe(0);
  });
  it("accepts old archives without cast", async () => {
    const scope = await fixture();
    await withTransaction(pool, (client) => importCampaignCast(client, scope, undefined, { turns: new Map(), worlds: new Map() }));
    const view = await createPostgresCampaignCastRepository(pool).current(scope);
    expect(view.characters.filter((c) => c.origin.kind !== "protagonist")).toEqual([]);
  });
  it("preserves historical world provenance when the source world is not part of a campaign import", async () => {
    const source = await fixture(), destination = await fixture();
    const version = (await pool.query("SELECT world_version_id FROM campaigns WHERE id=$1", [source.campaignId])).rows[0].world_version_id;
    await pool.query(`UPDATE world_versions SET content='{"entities":[{"id":"mara","name":"Mara"}]}' WHERE id=$1`, [version]);
    const repo = createPostgresCampaignCastRepository(pool);
    const boundary = { turnNumber: 0, timelineRevision: 0 };
    const evidence = { kind: "world" as const, worldVersionId: version, sourcePath: "/entities/0" };
    const created = await repo.applyBatch(source, { boundary, idempotencyKey: "world-person", commands: [{ kind: "create", name: "Mara", aliases: [],
      origin: { kind: "world", worldVersionId: version, entityId: "mara" }, evidence }] });
    await repo.applyBatch(source, { boundary, idempotencyKey: "world-fact", commands: [{ kind: "observe", characterId: created.characterIds[0]!,
      field: "story.role", value: "guide", mode: "fact", speakerCharacterId: null, supersedesObservationId: null, evidence }] });
    await withTransaction(pool, async (client) => importCampaignCast(client, destination, await exportCampaignCast(client, source), { turns: new Map(), worlds: new Map() }));
    expect((await repo.current(destination)).characters.filter((c) => c.origin.kind !== "protagonist")).toEqual([
      expect.objectContaining({ name: "Mara", profile: { "story.role": "guide" }, origin: { kind: "historical_world", sourceWorldVersionId: version, entityId: "mara" } })
    ]);
  });
  it("preserves a user-corrected identity after its introduction turn has been replaced", async () => {
    const source = await fixture(), destination = await fixture();
    const oldTurnId = randomUUID();
    await pool.query("UPDATE campaigns SET active_turn_number=1 WHERE id IN ($1,$2)", [source.campaignId, destination.campaignId]);
    await pool.query("INSERT INTO turns(id,owner_user_id,campaign_id,turn_number,narration) VALUES($1,$2,$3,1,'Mara arrives.')", [oldTurnId, ownerUserId, source.campaignId]);
    const repo = createPostgresCampaignCastRepository(pool, { editingEnabled: true });
    const boundary = { turnNumber: 1, timelineRevision: 0 };
    const created = await repo.applyBatch(source, { boundary, idempotencyKey: "intro", commands: [{ kind: "create", name: "Mara", aliases: [], origin: { kind: "discovered" },
      evidence: { kind: "turn", turnId: oldTurnId, turnNumber: 1, narrationRevision: 0, sourceHash: sha256("Mara arrives."), paragraphId: "p1", quote: "Mara arrives." } }] });
    await repo.edit(source, created.characterIds[0]!, { expectedCastRevision: created.revision, expectedCharacterRevision: 1, expectedBoundary: boundary, idempotencyKey: "user-retain", name: "Mara Reed" });
    await withTransaction(pool, async (client) => {
      await client.query("DELETE FROM turns WHERE id=$1", [oldTurnId]);
      await client.query("INSERT INTO turns(owner_user_id,campaign_id,turn_number,narration) VALUES($1,$2,1,'The empty road curves away.')", [ownerUserId, source.campaignId]);
      await applyCastBoundaryChange(client, source, { turnNumber: 1, changeKey: "replacement:test" });
      const payload = await exportCampaignCast(client, source);
      await importCampaignCast(client, destination, payload, { turns: new Map(), worlds: new Map() });
    });
    expect((await repo.current(destination)).characters.filter((c) => c.origin.kind !== "protagonist")).toEqual([
      expect.objectContaining({ name: "Mara Reed", profile: {} })
    ]);
  });
  it("includes cast in the actual Campaign and System Archive export projections", async () => {
    const story = JSON.parse(await readFile(resolve("tests/fixtures/legacy-story.json"), "utf8"));
    story.world.title = `Cast export ${randomUUID()}`;
    const imported = await importLegacyStory(pool, storyImportRequestSchema.parse({ sourceName: "cast.story", story }));
    const scope = { ownerUserId, campaignId: imported.campaignId };
    const repo = createPostgresCampaignCastRepository(pool, { editingEnabled: true, lifecycleEnabled: true });
    const initial = await repo.current(scope);
    const created = await repo.create(scope, { expectedCastRevision: initial.revision, expectedBoundary: initial.boundary, idempotencyKey: "cast-export",
      name: "Mara", aliases: [], profile: { "appearance.description": "" } });
    await repo.changeRemoval!(scope, created.character.id, "remove", { expectedCastRevision: created.revision, expectedBoundary: created.boundary,
      expectedCharacterRevision: created.character.revision, idempotencyKey: "cast-export-remove" });
    const projected = campaignArchivePayloads(await loadCampaignArchiveExportSnapshot(pool, ownerUserId, scope.campaignId));
    expect(projected.campaign.archiveRecords).toHaveProperty("cast.formatVersion", 4);
    const mutations = createPostgresPortableFamilyMutationRepository(createPostgresWorldRepositoryAdapters(pool, { memory: memoryGeneration(pool) }).worlds);
    const restored = await withTransaction(pool, (client) => mutations.commitCampaignZip(client, {
      owner: { ownerUserId }, destination: { kind: "existing_world_version", worldId: imported.worldId, worldVersionId: imported.worldVersionId },
      authorityFingerprint: randomUUID().replaceAll("-", ""), publishedAssets: [],
      payload: JSON.parse(JSON.stringify({ archiveFormat: "manifest_v1", sourceName: "cast.zip", ...projected }))
    }));
    expect((await repo.current({ ownerUserId, campaignId: restored.campaignId! })).characters.filter((c) => c.origin.kind !== "protagonist"))
      .toEqual([expect.objectContaining({ name: "Mara", removed: true, profile: { "appearance.description": "" } })]);
    const system = createPostgresSystemArchiveExportRepository(pool, { sourceApplicationVersion: "0.1.0" });
    await system.withOwnerSnapshot({ ownerUserId }, async (snapshot) => {
      let found = false;
      for await (const envelope of snapshot.streamDomain("campaigns")) if (envelope.sourceId === scope.campaignId) {
        expect(envelope.record).toHaveProperty("cast.formatVersion", 4);
        found = true;
      }
      expect(found).toBe(true);
    });
  });
});
