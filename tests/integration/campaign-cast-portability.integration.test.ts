import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabasePool, initialOwnerId, type DatabasePool, withTransaction } from "../../packages/database/src/pool.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { createPostgresCampaignCastRepository } from "../../packages/database/src/campaign-cast-repository.js";
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
import { applyCastBoundaryChange } from "../../packages/database/src/campaign-cast-lifecycle.js";

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
    await pool.query("INSERT INTO world_versions(id,world_id,owner_user_id,version_number,content) VALUES($1,$2,$3,1,'{}')", [version, world, ownerUserId]);
    await pool.query("INSERT INTO campaigns(id,owner_user_id,world_version_id,title) VALUES($1,$2,$3,'Cast portable')", [campaignId, ownerUserId, version]);
    return { ownerUserId, campaignId };
  }
  it("restores cast through the real System Archive transaction after turns are restored", async () => {
    const story = JSON.parse(await readFile(resolve("tests/fixtures/legacy-story.json"), "utf8"));
    story.world.title = `Cast system restore ${randomUUID()}`;
    const imported = await importLegacyStory(pool, storyImportRequestSchema.parse({ sourceName: "cast.story", story }));
    const scope = { ownerUserId, campaignId: imported.campaignId };
    const repo = createPostgresCampaignCastRepository(pool, { editingEnabled: true });
    const initial = await repo.current(scope);
    await repo.create(scope, { expectedCastRevision: initial.revision, expectedBoundary: initial.boundary, idempotencyKey: "system",
      name: "Mara", aliases: [], profile: { "appearance.description": "" } });
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
      const value = await createPostgresCampaignCastRepository(destination).current({ ...target, campaignId: scope.campaignId });
      expect(value.characters.filter((c) => c.origin.kind !== "protagonist")).toEqual([
        expect.objectContaining({ name: "Mara", profile: { "appearance.description": "" } })
      ]);
    } finally { await destination.end(); await pool.query(`DROP DATABASE ${databaseName}`); }
  });
  it("round-trips separate identities and user blanks with new IDs and no profile caches", async () => {
    const source = await fixture(), destination = await fixture();
    const repo = createPostgresCampaignCastRepository(pool, { editingEnabled: true });
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
    const repo = createPostgresCampaignCastRepository(pool, { editingEnabled: true });
    const initial = await repo.current(scope);
    await repo.create(scope, { expectedCastRevision: initial.revision, expectedBoundary: initial.boundary, idempotencyKey: "cast-export",
      name: "Mara", aliases: [], profile: { "appearance.description": "" } });
    const projected = campaignArchivePayloads(await loadCampaignArchiveExportSnapshot(pool, ownerUserId, scope.campaignId));
    expect(projected.campaign.archiveRecords).toHaveProperty("cast.formatVersion", 1);
    const mutations = createPostgresPortableFamilyMutationRepository(createPostgresWorldRepositoryAdapters(pool, { memory: memoryGeneration(pool) }).worlds);
    const restored = await withTransaction(pool, (client) => mutations.commitCampaignZip(client, {
      owner: { ownerUserId }, destination: { kind: "existing_world_version", worldId: imported.worldId, worldVersionId: imported.worldVersionId },
      authorityFingerprint: randomUUID().replaceAll("-", ""), publishedAssets: [],
      payload: JSON.parse(JSON.stringify({ archiveFormat: "manifest_v1", sourceName: "cast.zip", ...projected }))
    }));
    expect((await repo.current({ ownerUserId, campaignId: restored.campaignId! })).characters.filter((c) => c.origin.kind !== "protagonist"))
      .toEqual([expect.objectContaining({ name: "Mara", profile: { "appearance.description": "" } })]);
    const system = createPostgresSystemArchiveExportRepository(pool, { sourceApplicationVersion: "0.1.0" });
    await system.withOwnerSnapshot({ ownerUserId }, async (snapshot) => {
      let found = false;
      for await (const envelope of snapshot.streamDomain("campaigns")) if (envelope.sourceId === scope.campaignId) {
        expect(envelope.record).toHaveProperty("cast.formatVersion", 1);
        found = true;
      }
      expect(found).toBe(true);
    });
  });
});
