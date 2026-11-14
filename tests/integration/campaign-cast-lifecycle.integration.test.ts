import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabasePool, initialOwnerId, type DatabasePool, withTransaction } from "../../packages/database/src/pool.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { applyCastBatchWithClient, createPostgresCampaignCastRepository } from "../../packages/database/src/campaign-cast-repository.js";
import { campaignCreateSchema, worldCreateSchema, worldPublishSchema } from "../../packages/contracts/src/world-library.js";
import { storyImportRequestSchema } from "../../packages/contracts/src/imports.js";
import { importLegacyStory, branchCampaign, rewindCampaign, previewCampaignWorldTransfer, transferCampaignWorld, createWorld, publishWorld, createCampaign } from "../helpers/memory-aware-services.js";
import { applyCastBoundaryChange } from "../../packages/database/src/campaign-cast-lifecycle.js";
import { createPostgresTurnCorrectionRepository } from "../../packages/database/src/turn-correction-repository.js";
import { memoryGeneration } from "../helpers/memory-applications.js";
import { sha256 } from "../../packages/domain/src/text.js";
import { campaignTransferPreviewRequestSchema, campaignTransferCommitRequestSchema } from "../../packages/contracts/src/campaign-transfer.js";
import { readCastDiscoveryStatus } from "../../packages/database/src/campaign-cast-status-repository.js";
import { enqueueCastDiscoveryWithClient } from "../../packages/database/src/campaign-cast-job-repository.js";

const integration = process.env.TEST_DATABASE_URL ? describe : describe.skip;
integration("campaign cast lifecycle", () => {
  let pool: DatabasePool, ownerUserId: string;
  beforeAll(async () => {
    pool = createDatabasePool(process.env.TEST_DATABASE_URL!, 8);
    await migrateDatabase(pool, resolve("database/migrations"));
    ownerUserId = await initialOwnerId(pool);
  }, 60_000);
  afterAll(async () => { await pool?.end(); });
  async function fixture() {
    const story = JSON.parse(await readFile(resolve("tests/fixtures/legacy-story.json"), "utf8"));
    story.world.title = `Cast lifecycle ${randomUUID()}`;
    const imported = await importLegacyStory(pool, storyImportRequestSchema.parse({ sourceName: "cast.story", story }));
    const scope = { ownerUserId, campaignId: imported.campaignId };
    const repo = createPostgresCampaignCastRepository(pool, { editingEnabled: true });
    return { scope, repo };
  }
  it.each(["branch", "transfer"] as const)("keeps invalidated lexical evidence and its range together through %s and archive restore", async operation => {
    const { scope } = await fixture();
    const { exportCampaignCast, importCampaignCast } = await import("../../packages/database/src/campaign-cast-portability.js");
    const turnId = (await pool.query("SELECT id FROM turns WHERE campaign_id=$1 AND turn_number=1", [scope.campaignId])).rows[0].id;
    const characterId = randomUUID();
    const sourceHash = sha256("Mara waits.");
    // A supported archive may retain invalidated evidence even when that turn still exists.
    const archive = { formatVersion: 2, revision: 2,
      characters: [{ id: characterId, origin: { kind: "manual" }, firstObservedTurn: 1 }],
      events: [
        { id: randomUUID(), effectiveTurnNumber: 1, revision: 1,
          commands: [{ characterId, command: { kind: "create", name: "Mara", aliases: [], origin: { kind: "manual" } } }] },
        { id: randomUUID(), effectiveTurnNumber: 1, revision: 2,
          commands: [{ command: { kind: "mention", characterId, kindOfMention: "lexical",
            evidence: { kind: "turn", turnId, turnNumber: 1, invalidated: true, narrationRevision: 0, sourceHash, paragraphId: "p1", quote: "Mara" },
            sourceRange: { turnId, narrationRevision: 0, sourceHash, paragraphId: "p1", start: 0, end: 4 } } }] }
      ] };
    await withTransaction(pool, client => importCampaignCast(client, scope, archive, { turns: new Map(), worlds: new Map() }));
    let campaignId: string;
    if (operation === "branch") {
      campaignId = (await branchCampaign(pool, scope.campaignId, { targetTurnNumber: 1, title: "Historical mention branch" })).id;
    } else {
      const destination = await fixture();
      const version = (await pool.query("SELECT world_version_id FROM campaigns WHERE id=$1", [destination.scope.campaignId])).rows[0].world_version_id;
      const request = campaignTransferPreviewRequestSchema.parse({ targetWorldVersionId: version });
      const preview = await previewCampaignWorldTransfer(pool, scope.campaignId, request);
      const transfer = await transferCampaignWorld(pool, scope.campaignId, campaignTransferCommitRequestSchema.parse({ ...request, idempotencyKey: randomUUID(),
        expectedActiveTurnNumber: preview.expectedActiveTurnNumber, expectedStateRevision: preview.expectedStateRevision, sourceFingerprint: preview.sourceFingerprint }));
      campaignId = transfer.targetCampaignId;
    }
    const copied = await withTransaction(pool, client => exportCampaignCast(client, { ownerUserId, campaignId }));
    const mention = copied!.events.flatMap(event => event.commands).find(item => item.command.kind === "mention")!.command;
    expect(mention).toMatchObject({ evidence: { turnId, invalidated: true }, sourceRange: { turnId } });
    const destination = await fixture();
    await withTransaction(pool, client => importCampaignCast(client, destination.scope, copied, { turns: new Map(), worlds: new Map() }));
    const restored = await destination.repo.current(destination.scope);
    expect(restored.characters.find(person => person.name === "Mara")?.lastMentionedTurn).toBeNull();
  });
  it("preserves active v4 merge authority through actual branch and world transfer", async () => {
    const { scope } = await fixture();
    const repo = createPostgresCampaignCastRepository(pool, { editingEnabled: true, lifecycleEnabled: true });
    const initial = await repo.current(scope);
    const target = await repo.create(scope, { expectedCastRevision: initial.revision, expectedBoundary: initial.boundary, idempotencyKey: randomUUID(), name: "Mara", aliases: [], profile: {} });
    const source = await repo.create(scope, { expectedCastRevision: target.revision, expectedBoundary: target.boundary, idempotencyKey: randomUUID(), name: "Mary", aliases: [], profile: {} });
    const merged = await repo.merge!(scope, target.character.id, { expectedCastRevision: source.revision, expectedBoundary: source.boundary,
      expectedCharacterRevision: target.character.revision, expectedSourceCharacterRevision: source.character.revision,
      sourceCharacterId: source.character.id, reviewedAliases: ["Mary"], choices: {}, idempotencyKey: randomUUID() });
    const branch = await branchCampaign(pool, scope.campaignId, { targetTurnNumber: merged.boundary.turnNumber, title: "Merged branch" });
    const destination = await fixture();
    const version = (await pool.query("SELECT world_version_id FROM campaigns WHERE id=$1", [destination.scope.campaignId])).rows[0].world_version_id;
    const request = campaignTransferPreviewRequestSchema.parse({ targetWorldVersionId: version });
    const preview = await previewCampaignWorldTransfer(pool, scope.campaignId, request);
    const transfer = await transferCampaignWorld(pool, scope.campaignId, campaignTransferCommitRequestSchema.parse({ ...request, idempotencyKey: randomUUID(),
      expectedActiveTurnNumber: preview.expectedActiveTurnNumber, expectedStateRevision: preview.expectedStateRevision, sourceFingerprint: preview.sourceFingerprint }));
    for (const campaignId of [branch.id, transfer.targetCampaignId]) {
      const copied = await repo.current({ ownerUserId, campaignId });
      const a = copied.characters.find(person => person.name === "Mara")!, b = copied.characters.find(person => person.name === "Mary")!;
      expect(b.mergedIntoCharacterId).toBe(a.id);
      expect(a.activeMerges?.[0]?.sourceCharacterId).toBe(b.id);
      expect(a.activeMerges?.[0]?.mergeEventId).not.toBe(merged.character.activeMerges?.[0]?.mergeEventId);
    }
  });
  it("replays remove and restore and discards later lifecycle events on rewind with presets disabled", async () => {
    const { scope } = await fixture();
    const repo = createPostgresCampaignCastRepository(pool, { editingEnabled: true, lifecycleEnabled: true, castPresetsEnabled: false });
    const initial = await repo.current(scope);
    const created = await repo.create(scope, { expectedCastRevision: initial.revision, expectedBoundary: initial.boundary,
      idempotencyKey: randomUUID(), name: "Mara", aliases: [], profile: {} });
    const second = await repo.create(scope, { expectedCastRevision: created.revision, expectedBoundary: created.boundary,
      idempotencyKey: randomUUID(), name: "Mary", aliases: [], profile: {} });
    const laterTurn = initial.boundary.turnNumber + 1, turnId = randomUUID();
    await pool.query("INSERT INTO turns(id,owner_user_id,campaign_id,turn_number,narration) VALUES($1,$2,$3,$4,'Mara leaves.')", [turnId, ownerUserId, scope.campaignId, laterTurn]);
    await pool.query("UPDATE campaigns SET active_turn_number=$2 WHERE id=$1", [scope.campaignId, laterTurn]);
    const before = await repo.current(scope), person = before.characters.find(item => item.id === created.character.id)!;
    const remove = { expectedCastRevision: before.revision, expectedBoundary: before.boundary, expectedCharacterRevision: person.revision, idempotencyKey: randomUUID() };
    const removed = await repo.changeRemoval!(scope, person.id, "remove", remove);
    expect(removed.character.removed).toBe(true);
    expect(await repo.changeRemoval!(scope, person.id, "remove", remove)).toEqual(removed);
    const restore = { expectedCastRevision: removed.revision, expectedBoundary: removed.boundary, expectedCharacterRevision: removed.character.revision, idempotencyKey: randomUUID() };
    const restored = await repo.changeRemoval!(scope, person.id, "restore", restore);
    expect(restored.character.removed).toBe(false);
    expect(await repo.changeRemoval!(scope, person.id, "restore", restore)).toEqual(restored);
    const current = await repo.current(scope), source = current.characters.find(item => item.id === second.character.id)!;
    const merge = { expectedCastRevision: current.revision, expectedBoundary: current.boundary, expectedCharacterRevision: restored.character.revision,
      expectedSourceCharacterRevision: source.revision, sourceCharacterId: source.id, reviewedAliases: ["Mary"], choices: {}, idempotencyKey: randomUUID() };
    const merged = await repo.merge!(scope, person.id, merge);
    expect(await repo.merge!(scope, person.id, merge)).toEqual(merged);
    const hidden = (await repo.current(scope)).characters.find(item => item.id === source.id)!;
    const undo = { expectedCastRevision: merged.revision, expectedBoundary: merged.boundary, expectedCharacterRevision: merged.character.revision,
      expectedSourceCharacterRevision: hidden.revision, mergeEventId: merged.character.activeMerges![0]!.mergeEventId, idempotencyKey: randomUUID() };
    const unmerged = await repo.unmerge!(scope, person.id, undo);
    expect(await repo.unmerge!(scope, person.id, undo)).toEqual(unmerged);
    await withTransaction(pool, async client => {
      await client.query("UPDATE campaigns SET active_turn_number=$2 WHERE id=$1", [scope.campaignId, initial.boundary.turnNumber]);
      await applyCastBoundaryChange(client, scope, { turnNumber: initial.boundary.turnNumber, changeKey: randomUUID() });
    });
    expect((await repo.current(scope)).characters.find(item => item.id === person.id)?.removed).toBe(false);
    const remaining = (await pool.query("SELECT payload FROM campaign_cast_events WHERE campaign_id=$1", [scope.campaignId])).rows.flatMap(row => row.payload.map((item: { command: { kind: string } }) => item.command.kind));
    expect(remaining).not.toContain("remove");
    expect(remaining).not.toContain("restore");
    expect(remaining).not.toContain("merge");
    expect(remaining).not.toContain("unmerge");
  });
  it("retains an automatic attachment independently of candidates and detaches only its evidence", async () => {
    const { scope, repo } = await fixture();
    const initial = await repo.current(scope);
    const created = await repo.create(scope, { expectedCastRevision: initial.revision, expectedBoundary: initial.boundary,
      idempotencyKey: randomUUID(), name: "Mara", aliases: [], profile: { "appearance.description": "" } });
    const source = (await pool.query(`SELECT turn_id,turn_number,correction_revision,effective_narration FROM effective_turn_narrations
      WHERE campaign_id=$1 ORDER BY turn_number LIMIT 1`, [scope.campaignId])).rows[0];
    const { buildCastDiscoverySource } = await import("../../packages/domain/src/campaign-cast-discovery.js");
    const parsed = buildCastDiscoverySource({ scope, turnId: source.turn_id, turnNumber: source.turn_number,
      narrationRevision: source.correction_revision, timelineRevision: initial.boundary.timelineRevision, narration: source.effective_narration });
    const paragraph = parsed.paragraphs[0]!; const quote = paragraph.text.slice(0, 10);
    const evidence = { kind: "turn" as const, turnId: source.turn_id, turnNumber: source.turn_number,
      narrationRevision: source.correction_revision, sourceHash: parsed.sourceHash, paragraphId: paragraph.id, quote };
    const batch = { boundary: created.boundary, idempotencyKey: randomUUID(), commands: [{ kind: "observe" as const,
      characterId: created.character.id, field: "appearance.description" as const, value: "Blue eyes", mode: "fact" as const,
      speakerCharacterId: null, evidence, supersedesObservationId: null }] };
    const attachment = { characterId: created.character.id, basis: "unique_name" as const,
      sourceRanges: [{ turnId: source.turn_id, narrationRevision: source.correction_revision, sourceHash: parsed.sourceHash,
        paragraphId: paragraph.id, start: 0, end: quote.length }] };
    const receipt = await withTransaction(pool, (client) => applyCastBatchWithClient(client, scope, batch, { attachment }));
    expect((await repo.detail(scope, created.character.id)).autoMatches).toHaveLength(1);
    const branch = await branchCampaign(pool, scope.campaignId, { targetTurnNumber: created.boundary.turnNumber, title: "Attachment branch" });
    const branchScope = { ownerUserId, campaignId: branch.id };
    const branchPerson = (await repo.current(branchScope)).characters.find(person => person.name === "Mara")!;
    const branchDetail = await repo.detail(branchScope, branchPerson.id);
    expect(branchDetail.autoMatches).toHaveLength(1);
    expect(branchDetail.autoMatches[0]!.eventId).not.toBe(receipt.eventId);
    expect(branchDetail.autoMatches[0]!.sourceRanges[0]!.turnId).not.toBe(source.turn_id);
    const { exportCampaignCast, importCampaignCast } = await import("../../packages/database/src/campaign-cast-portability.js");
    const destination = await fixture();
    const originalTurns = (await pool.query("SELECT id,turn_number FROM turns WHERE campaign_id=$1", [scope.campaignId])).rows;
    const copiedTurns = (await pool.query("SELECT id,turn_number FROM turns WHERE campaign_id=$1", [destination.scope.campaignId])).rows;
    await withTransaction(pool, async client => {
      const archive = await exportCampaignCast(client, scope);
      await importCampaignCast(client, destination.scope, archive, { turns: new Map(originalTurns.map(turn => [turn.id, copiedTurns.find(copy => copy.turn_number === turn.turn_number)!.id])), worlds: new Map() });
    });
    const restoredPerson = (await repo.current(destination.scope)).characters.find(person => person.name === "Mara")!;
    const restored = await repo.detail(destination.scope, restoredPerson.id);
    expect(restored.autoMatches).toHaveLength(1);
    await repo.detachAttachment(destination.scope, restoredPerson.id, restored.autoMatches[0]!.eventId,
      { expectedBoundary: restored.boundary, expectedCastRevision: restored.revision, expectedCharacterRevision: restored.character.revision, idempotencyKey: randomUUID() });
    expect((await repo.detail(destination.scope, restoredPerson.id)).observations).toEqual([]);
    const targetVersion = (await pool.query("SELECT world_version_id FROM campaigns WHERE id=$1", [destination.scope.campaignId])).rows[0].world_version_id;
    const transferRequest = campaignTransferPreviewRequestSchema.parse({ targetWorldVersionId: targetVersion });
    const transferPreview = await previewCampaignWorldTransfer(pool, scope.campaignId, transferRequest);
    const transferred = await transferCampaignWorld(pool, scope.campaignId, campaignTransferCommitRequestSchema.parse({ ...transferRequest,
      idempotencyKey: randomUUID(), expectedActiveTurnNumber: transferPreview.expectedActiveTurnNumber,
      expectedStateRevision: transferPreview.expectedStateRevision, sourceFingerprint: transferPreview.sourceFingerprint }));
    const transferScope = { ownerUserId, campaignId: transferred.targetCampaignId };
    const transferredPerson = (await repo.current(transferScope)).characters.find(person => person.name === "Mara")!;
    const transferredDetail = await repo.detail(transferScope, transferredPerson.id);
    expect(transferredDetail.autoMatches).toHaveLength(1);
    await repo.detachAttachment(transferScope, transferredPerson.id, transferredDetail.autoMatches[0]!.eventId,
      { expectedBoundary: transferredDetail.boundary, expectedCastRevision: transferredDetail.revision, expectedCharacterRevision: transferredPerson.revision, idempotencyKey: randomUUID() });
    expect((await repo.detail(transferScope, transferredPerson.id)).observations).toEqual([]);
    const before = await repo.detail(scope, created.character.id);
    const detach = { expectedBoundary: before.boundary, expectedCastRevision: before.revision,
      expectedCharacterRevision: before.character.revision, idempotencyKey: randomUUID() };
    const detached = await repo.detachAttachment(scope, created.character.id, receipt.eventId, detach);
    expect(await repo.detachAttachment(scope, created.character.id, receipt.eventId, detach)).toEqual(detached);
    const detail = await repo.detail(scope, created.character.id);
    expect(detail.autoMatches).toEqual([]); expect(detail.observations).toEqual([]);
    expect(detail.character.profile["appearance.description"]).toBe("");
    const candidates = await repo.candidates(scope, {});
    expect(candidates.candidates.some((candidate) => candidate.reason === "detached_attachment")).toBe(true);
    await expect(repo.detachAttachment(scope, created.character.id, receipt.eventId, { ...detach,
      expectedCastRevision: detail.revision, expectedCharacterRevision: detail.character.revision, idempotencyKey: randomUUID() })).rejects.toThrow();
  });
  it("records textual recency separately and isolates hook failures", async () => {
    const { scope, repo } = await fixture();
    const current = await repo.current(scope);
    const created = await repo.create(scope, { expectedCastRevision: current.revision, expectedBoundary: current.boundary,
      idempotencyKey: randomUUID(), name: "Mara", aliases: [], profile: {} });
    const turnId = randomUUID(), number = current.boundary.turnNumber + 1;
    const { recordAcceptedTurnCastMentions } = await import("../../packages/database/src/campaign-cast-mentions.js");
    await withTransaction(pool, async (client) => {
      await client.query("INSERT INTO turns(id,owner_user_id,campaign_id,turn_number,narration) VALUES($1,$2,$3,$4,$5)",
        [turnId, scope.ownerUserId, scope.campaignId, number, "Mara waits. Mara speaks."]);
      await client.query("UPDATE campaigns SET active_turn_number=$2 WHERE id=$1", [scope.campaignId, number]);
      await recordAcceptedTurnCastMentions(client, scope, turnId, () => { throw new Error("unexpected hook failure"); });
      await recordAcceptedTurnCastMentions(client, scope, turnId, () => { throw new Error("unexpected retry failure"); });
    });
    const person = (await repo.current(scope)).characters.find((item) => item.id === created.character.id)!;
    expect(person.lastMentionedTurn).toBe(number);
    expect(person.lastObservedTurn).toBe(created.character.lastObservedTurn);
    expect((await repo.detail(scope, created.character.id)).identityEvents.filter((item) => item.evidence.kind === "turn")).toEqual([]);
    const hash = sha256("Mara waits. Mara speaks.");
    const evidence = { kind: "turn" as const, turnId, turnNumber: number, narrationRevision: 0, sourceHash: hash, paragraphId: "p1", quote: "Mara" };
    const attachments = [];
    for (const start of [0, 12]) {
      const now = await repo.current(scope);
      attachments.push(await withTransaction(pool, (client) => applyCastBatchWithClient(client, scope,
        { boundary: now.boundary, idempotencyKey: randomUUID(), commands: [{ kind: "mention", characterId: person.id, evidence }] },
        { attachment: { characterId: person.id, basis: "unique_name", sourceRanges: [{ turnId, narrationRevision: 0,
          sourceHash: hash, paragraphId: "p1", start, end: start + 4 }] } })));
    }
    for (const [index, attachment] of attachments.entries()) {
      const detail = await repo.detail(scope, person.id);
      await repo.detachAttachment(scope, person.id, attachment.eventId, { expectedBoundary: detail.boundary,
        expectedCastRevision: detail.revision, expectedCharacterRevision: detail.character.revision, idempotencyKey: randomUUID() });
      const after = (await repo.current(scope)).characters.find((item) => item.id === person.id)!;
      expect(after.lastMentionedTurn).toBe(index === 0 ? number : null);
    }
    const destination = await fixture(), targetTurn = randomUUID();
    await pool.query("INSERT INTO turns(id,owner_user_id,campaign_id,turn_number,narration) VALUES($1,$2,$3,$4,$5)",
      [targetTurn, ownerUserId, destination.scope.campaignId, number, "Mara waits. Mara speaks."]);
    await pool.query("UPDATE campaigns SET active_turn_number=$2 WHERE id=$1", [destination.scope.campaignId, number]);
    const originalTurns = (await pool.query("SELECT id,turn_number FROM turns WHERE campaign_id=$1", [scope.campaignId])).rows;
    const targetTurns = (await pool.query("SELECT id,turn_number FROM turns WHERE campaign_id=$1", [destination.scope.campaignId])).rows;
    const { exportCampaignCast, importCampaignCast } = await import("../../packages/database/src/campaign-cast-portability.js");
    await withTransaction(pool, async (client) => importCampaignCast(client, destination.scope, await exportCampaignCast(client, scope),
      { turns: new Map(originalTurns.map((turn) => [turn.id, targetTurns.find((target) => target.turn_number === turn.turn_number)!.id])), worlds: new Map() }));
    expect((await repo.current(destination.scope)).characters.find((item) => item.name === "Mara")!.lastMentionedTurn).toBeNull();
    const gatedOff = await createPostgresTurnCorrectionRepository(pool, { memory: memoryGeneration(pool) }).correctNarration(scope,
      { turnId, expectedActiveTurnNumber: number, expectedCorrectionRevision: 0, narration: "Mara pauses.", source: "user_edit" });
    expect(gatedOff.ok).toBe(true);
    expect((await repo.current(scope)).characters.find((item) => item.id === person.id)!.lastMentionedTurn).toBeNull();
    const correction = await createPostgresTurnCorrectionRepository(pool, { memory: memoryGeneration(pool), castLexicalMentionsEnabled: true }).correctNarration(scope,
      { turnId, expectedActiveTurnNumber: number, expectedCorrectionRevision: 1, narration: "Mara returns.", source: "user_edit" });
    expect(correction.ok).toBe(true);
    expect((await repo.current(scope)).characters.find((item) => item.id === person.id)!.lastMentionedTurn).toBe(number);
    const correctedDestination = await fixture(), correctedTurn = randomUUID();
    await pool.query("INSERT INTO turns(id,owner_user_id,campaign_id,turn_number,narration) VALUES($1,$2,$3,$4,$5)",
      [correctedTurn, ownerUserId, correctedDestination.scope.campaignId, number, "Mara waits. Mara speaks."]);
    await pool.query("UPDATE campaigns SET active_turn_number=$2 WHERE id=$1", [correctedDestination.scope.campaignId, number]);
    await pool.query(`INSERT INTO turn_narration_corrections(owner_user_id,campaign_id,turn_id,revision,narration,
      previous_effective_narration_hash,reason,source,created_by_user_id)
      SELECT $1,$2,$3,revision,narration,previous_effective_narration_hash,reason,source,$1
      FROM turn_narration_corrections WHERE turn_id=$4`, [ownerUserId, correctedDestination.scope.campaignId, correctedTurn, turnId]);
    const correctedTurns = (await pool.query("SELECT id,turn_number FROM turns WHERE campaign_id=$1", [correctedDestination.scope.campaignId])).rows;
    await withTransaction(pool, async (client) => {
      const archive = await exportCampaignCast(client, scope);
      const stale = archive!.events.flatMap((event) => event.commands).filter((item) => item.command.kind === "mention"
        && item.command.kindOfMention === "lexical" && item.command.evidence.invalidated);
      expect(stale).toHaveLength(2);
      await importCampaignCast(client, correctedDestination.scope, archive,
        { turns: new Map(originalTurns.map((turn) => [turn.id, correctedTurns.find((target) => target.turn_number === turn.turn_number)!.id])), worlds: new Map() });
    });
    expect((await repo.current(correctedDestination.scope)).characters.find((item) => item.name === "Mara")!.lastMentionedTurn).toBe(number);
    const count = await pool.query(`SELECT count(*)::integer AS n FROM campaign_cast_events WHERE campaign_id=$1 AND idempotency_key LIKE 'lexical:%'`, [scope.campaignId]);
    expect(count.rows[0].n).toBe(2);
    let failed = false;
    await withTransaction(pool, async (client) => {
      await recordAcceptedTurnCastMentions(client, { ...scope, campaignId: "invalid" }, turnId, () => { failed = true; });
      expect((await client.query("SELECT 1 AS value")).rows[0].value).toBe(1);
    });
    expect(failed).toBe(true);
  });
  it.each(["branch", "transfer"] as const)("starts inherited %s discovery after copied history without copying jobs or claiming old coverage", async (operation) => {
    const { scope, repo } = await fixture();
    const initial = await repo.current(scope);
    const sourceTurnId = (await pool.query("SELECT id FROM turns WHERE campaign_id=$1 AND turn_number=1", [scope.campaignId])).rows[0].id;
    await withTransaction(pool, (client) => enqueueCastDiscoveryWithClient(client, { scope, turnId: sourceTurnId, enabled: true, admissionUnavailable: true }));
    let campaignId: string, throughTurn: number;
    if (operation === "branch") {
      throughTurn = 1;
      campaignId = (await branchCampaign(pool, scope.campaignId, { targetTurnNumber: throughTurn, title: "Tracking branch" })).id;
    } else {
      throughTurn = initial.boundary.turnNumber;
      const target = await fixture();
      const targetWorldVersionId = (await pool.query("SELECT world_version_id FROM campaigns WHERE id=$1", [target.scope.campaignId])).rows[0].world_version_id;
      const request = campaignTransferPreviewRequestSchema.parse({ targetWorldVersionId });
      const preview = await previewCampaignWorldTransfer(pool, scope.campaignId, request);
      campaignId = (await transferCampaignWorld(pool, scope.campaignId, campaignTransferCommitRequestSchema.parse({ ...request,
        idempotencyKey: randomUUID(), expectedActiveTurnNumber: preview.expectedActiveTurnNumber,
        expectedStateRevision: preview.expectedStateRevision, sourceFingerprint: preview.sourceFingerprint }))).targetCampaignId;
    }
    const destination = { ownerUserId, campaignId };
    expect(await readCastDiscoveryStatus(pool, destination, true)).toMatchObject({ coverageStartTurn: throughTurn + 1,
      trackedThroughTurn: throughTurn, firstGap: null, unresolvedCount: 0 });
    expect((await pool.query("SELECT count(*)::integer n FROM campaign_cast_discovery_jobs WHERE campaign_id=$1", [campaignId])).rows[0].n).toBe(0);
    const turnId = randomUUID();
    await withTransaction(pool, async (client) => {
      await client.query("INSERT INTO turns(id,owner_user_id,campaign_id,turn_number,narration) VALUES($1,$2,$3,$4,'Mara waits.')", [turnId, ownerUserId, campaignId, throughTurn + 1]);
      await client.query("UPDATE campaigns SET active_turn_number=$2 WHERE id=$1", [campaignId, throughTurn + 1]);
      await enqueueCastDiscoveryWithClient(client, { scope: destination, turnId, enabled: true, admissionUnavailable: true });
    });
    expect(await readCastDiscoveryStatus(pool, destination, true)).toMatchObject({ coverageStartTurn: throughTurn + 1,
      trackedThroughTurn: throughTurn, state: "failed", firstGap: { turnNumber: throughTurn + 1, diagnosticCode: "admission_unavailable" } });
    expect((await readCastDiscoveryStatus(pool, scope, true)).coverageStartTurn).toBe(1);
    expect((await pool.query("SELECT count(*)::integer n FROM campaign_cast_discovery_jobs WHERE campaign_id=$1", [scope.campaignId])).rows[0].n).toBe(1);
  });
  it("keeps a production-shaped lag-published seed through branch and rewind", async () => {
    const { scope, repo } = await fixture();
    await pool.query("UPDATE campaigns SET active_turn_number=2 WHERE id=$1", [scope.campaignId]);
    await repo.initialize(scope);
    const source = (await pool.query(`SELECT turn_id,correction_revision,effective_narration FROM effective_turn_narrations WHERE campaign_id=$1 AND turn_number=1`, [scope.campaignId])).rows[0];
    const { worldVersionId } = (await pool.query(`SELECT world_version_id AS "worldVersionId" FROM campaigns WHERE id=$1`, [scope.campaignId])).rows[0];
    await pool.query("UPDATE world_versions SET content=jsonb_set(content,'{playableCharacters}',$2::jsonb) WHERE id=$1", [worldVersionId, JSON.stringify([{ id: "lagged", name: "Lagged", characterText: "Keeper", campaignUse: "supporting", rpgStats: [], defaultTriggers: [] }])]);
    const { buildCastDiscoverySource } = await import("../../packages/domain/src/campaign-cast-discovery.js");
    const { playableCharacterSchema } = await import("../../packages/contracts/src/world-library.js");
    const { seedCampaignCastWithClient } = await import("../../packages/database/src/campaign-cast-repository.js");
    const parsed = buildCastDiscoverySource({ scope, turnId: source.turn_id, turnNumber: 1, narrationRevision: source.correction_revision, timelineRevision: 0, narration: source.effective_narration });
    const paragraph = parsed.paragraphs[0]!, quote = paragraph.text.slice(0, 10), characterId = randomUUID();
    await withTransaction(pool, client => seedCampaignCastWithClient(client, scope, { characterId, worldVersionId, index: 0, idempotencyKey: "lag-seed", boundary: { turnNumber: 2, timelineRevision: 0 },
      entry: playableCharacterSchema.parse({ id: "lagged", name: "Lagged", characterText: "Keeper", campaignUse: "supporting" }),
      evidenceCommands: [{ kind: "mention", characterId, evidence: { kind: "turn", turnId: source.turn_id, turnNumber: 1, narrationRevision: source.correction_revision, sourceHash: parsed.sourceHash, paragraphId: paragraph.id, quote } }] }));
    expect((await pool.query("SELECT first_observed_turn FROM campaign_cast_characters WHERE id=$1", [characterId])).rows[0].first_observed_turn).toBe(1);
    const branch = await branchCampaign(pool, scope.campaignId, { targetTurnNumber: 1, title: "Lag seed branch" });
    expect((await repo.current({ ownerUserId, campaignId: branch.id })).characters.some(person => person.name === "Lagged")).toBe(true);
    await withTransaction(pool, client => applyCastBoundaryChange(client, scope, { turnNumber: 1, changeKey: "lag-seed-rewind" }));
    await pool.query("UPDATE campaigns SET active_turn_number=1 WHERE id=$1", [scope.campaignId]);
    expect((await repo.current(scope)).characters.find(person => person.id === characterId)?.originProfile?.rosterName).toBe("Lagged");
  });
  it("retains lagged create and seed across branch and rewind, then suppresses detached and corrected evidence", async () => {
    const { scope, repo } = await fixture();
    await pool.query("UPDATE campaigns SET active_turn_number=2 WHERE id=$1", [scope.campaignId]);
    await repo.initialize(scope);
    const source = (await pool.query(`SELECT turn_id,turn_number,correction_revision,effective_narration FROM effective_turn_narrations
      WHERE campaign_id=$1 AND turn_number=1`, [scope.campaignId])).rows[0];
    const version = (await pool.query("SELECT world_version_id FROM campaigns WHERE id=$1", [scope.campaignId])).rows[0].world_version_id;
    const { characterProfileSchema } = await import("../../packages/contracts/src/world-library.js");
    const { buildCastDiscoverySource } = await import("../../packages/domain/src/campaign-cast-discovery.js");
    const parsed = buildCastDiscoverySource({ scope, turnId: source.turn_id, turnNumber: 1, narrationRevision: source.correction_revision,
      timelineRevision: 0, narration: source.effective_narration });
    const paragraph = parsed.paragraphs[0]!, quote = paragraph.text.slice(0, 10);
    const characterId = randomUUID(), eventId = randomUUID();
    const turnEvidence = { kind: "turn", turnId: source.turn_id, turnNumber: 1, narrationRevision: source.correction_revision,
      sourceHash: parsed.sourceHash, paragraphId: paragraph.id, quote };
    const worldEvidence = { kind: "world", worldVersionId: version, sourcePath: "/world" };
    const seed = { kind: "seed_profile", characterId, worldVersionId: version, entityId: "lagged", rosterName: "Lagged", rosterAliases: [],
      legacyCharacterText: "Legacy", profile: characterProfileSchema.parse({ story: { role: "Keeper" } }), evidence: worldEvidence };
    const payload = [{ characterId, command: { kind: "create", name: "Lagged", aliases: [], origin: { kind: "discovered" }, evidence: turnEvidence } },
      { command: seed }, { command: { kind: "pin", characterId, value: true } }];
    const attachment = { eventId, characterId, basis: "unique_world_name", sourceRanges: [{ turnId: source.turn_id,
      narrationRevision: source.correction_revision, sourceHash: parsed.sourceHash, paragraphId: paragraph.id, start: 0, end: quote.length }], observationIds: [] };
    await pool.query("INSERT INTO campaign_cast_characters(id,owner_user_id,campaign_id,origin,first_observed_turn) VALUES($1,$2,$3,$4,1)", [characterId, ownerUserId, scope.campaignId, JSON.stringify({ kind: "discovered" })]);
    await pool.query(`INSERT INTO campaign_cast_events(id,owner_user_id,campaign_id,effective_turn_number,timeline_revision,idempotency_key,request_hash,payload,receipt,attachment)
      VALUES($1,$2,$3,2,0,'lagged-seed',$4,$5,$6,$7)`, [eventId, ownerUserId, scope.campaignId, "a".repeat(64), JSON.stringify(payload),
      JSON.stringify({ eventId, revision: 1, characterIds: [characterId], observationIds: [] }), JSON.stringify(attachment)]);
    await pool.query("UPDATE campaign_cast_state SET revision=1 WHERE campaign_id=$1", [scope.campaignId]);
    const branch = await branchCampaign(pool, scope.campaignId, { targetTurnNumber: 1, title: "Lagged seed branch" });
    const copied = (await repo.current({ ownerUserId, campaignId: branch.id })).characters.find((person) => person.name === "Lagged")!;
    expect(copied.profile["story.role"]).toBe("Keeper");
    expect(copied.originProfile?.seedEventId).not.toBe(eventId);
    expect(copied.pinned).toBe(false);
    await rewindCampaign(pool, scope.campaignId, { targetTurnNumber: 1 });
    const retained = (await repo.current(scope)).characters.find((person) => person.id === characterId)!;
    expect(retained.profile["story.role"]).toBe("Keeper");
    expect(retained.pinned).toBe(false);
    const detail = await repo.detail(scope, characterId);
    await repo.detachAttachment(scope, characterId, eventId, { expectedBoundary: detail.boundary, expectedCastRevision: detail.revision,
      expectedCharacterRevision: detail.character.revision, idempotencyKey: "detach-lagged" });
    expect((await repo.detail(scope, characterId)).character.originProfile).toBeUndefined();
    const correction = await createPostgresTurnCorrectionRepository(pool, { memory: memoryGeneration(pool) }).correctNarration(scope,
      { turnId: source.turn_id, expectedActiveTurnNumber: 1, expectedCorrectionRevision: source.correction_revision,
        narration: "Changed evidence.", source: "user_edit" });
    expect(correction.ok).toBe(true);
    expect((await repo.current(scope)).characters.some((person) => person.id === characterId)).toBe(false);
  });

  it("turn-gates an existing-row seed and preserves v3 edits through cross-world transfer and restore", async () => {
    const { scope } = await fixture(), destination = await fixture(), restore = await fixture();
    const sourceVersion = (await pool.query("SELECT world_version_id FROM campaigns WHERE id=$1", [scope.campaignId])).rows[0].world_version_id;
    const targetVersion = (await pool.query("SELECT world_version_id FROM campaigns WHERE id=$1", [destination.scope.campaignId])).rows[0].world_version_id;
    await pool.query(`UPDATE world_versions SET content=jsonb_set(content,'{playableCharacters}', $2::jsonb) WHERE id=$1`, [sourceVersion,
      JSON.stringify([{ id: "mara", name: "Mara", characterText: "Legacy guidance", campaignUse: "supporting", profile: { story: { role: "Guide", background: "b".repeat(3000) } } }])]);
    const repo = createPostgresCampaignCastRepository(pool, { editingEnabled: true, castPresetsEnabled: true });
    await pool.query("UPDATE campaigns SET active_turn_number=1 WHERE id=$1", [scope.campaignId]);
    const initial = await repo.current(scope);
    const manual = await repo.create(scope, { name: "Mara", aliases: [], profile: { "story.role": "Scout" }, expectedCastRevision: initial.revision,
      expectedBoundary: initial.boundary, idempotencyKey: "manual-mara" });
    await pool.query("UPDATE campaigns SET active_turn_number=2 WHERE id=$1", [scope.campaignId]);
    const preview = await repo.fromWorldPreview!(scope, { characterId: "mara", targetCastCharacterId: manual.character.id });
    const seeded = await repo.fromWorld!(scope, { characterId: "mara", targetCastCharacterId: manual.character.id,
      expectedCharacterRevision: manual.character.revision, expectedWorldVersionId: sourceVersion, previewFingerprint: preview.previewFingerprint,
      expectedCastRevision: preview.castRevision, expectedBoundary: preview.boundary, idempotencyKey: "seed-existing" });
    const edited = await repo.editAuthoredProfile!(scope, manual.character.id, { expectedCastRevision: seeded.revision,
      expectedCharacterRevision: seeded.character.revision, expectedBoundary: seeded.boundary, idempotencyKey: "seed-edit",
      set: { "story.role": "Warden" }, setOverrides: { "story.goals": "g".repeat(20000) } });
    const early = await branchCampaign(pool, scope.campaignId, { targetTurnNumber: 1, title: "Before seed" });
    const earlyPerson = (await repo.current({ ownerUserId, campaignId: early.id })).characters.find((person) => person.name === "Mara")!;
    expect(earlyPerson.originProfile).toBeUndefined();
    expect(earlyPerson.profile["story.role"]).toBe("Scout");
    const later = await branchCampaign(pool, scope.campaignId, { targetTurnNumber: 2, title: "After seed" });
    const laterPerson = (await repo.current({ ownerUserId, campaignId: later.id })).characters.find((person) => person.name === "Mara")!;
    expect(laterPerson.profile["story.role"]).toBe("Warden");
    expect(laterPerson.originProfile?.seedEventId).not.toBe(edited.character.originProfile!.seedEventId);
    const request = campaignTransferPreviewRequestSchema.parse({ targetWorldVersionId: targetVersion });
    const transferPreview = await previewCampaignWorldTransfer(pool, scope.campaignId, request);
    const transferred = await transferCampaignWorld(pool, scope.campaignId, campaignTransferCommitRequestSchema.parse({ ...request, idempotencyKey: randomUUID(),
      expectedActiveTurnNumber: transferPreview.expectedActiveTurnNumber, expectedStateRevision: transferPreview.expectedStateRevision, sourceFingerprint: transferPreview.sourceFingerprint }));
    const transferredScope = { ownerUserId, campaignId: transferred.targetCampaignId };
    const person = (await repo.current(transferredScope)).characters.find((item) => item.name === "Mara")!;
    expect(person.originProfile?.evidence).toMatchObject({ kind: "historical_world", sourceWorldVersionId: sourceVersion });
    expect(person.profile["story.role"]).toBe("Warden");
    expect(person.profile["story.goals"]).toHaveLength(20000);
    const { exportCampaignCast, importCampaignCast } = await import("../../packages/database/src/campaign-cast-portability.js");
    const sourceTurns = (await pool.query("SELECT id,turn_number FROM turns WHERE campaign_id=$1", [transferredScope.campaignId])).rows;
    const targetTurns = (await pool.query("SELECT id,turn_number FROM turns WHERE campaign_id=$1", [restore.scope.campaignId])).rows;
    await withTransaction(pool, async (client) => {
      const archive = await exportCampaignCast(client, transferredScope);
      expect(archive?.formatVersion).toBe(3);
      const seedEvent = archive!.events.find((event) => event.commands.some((item) => item.command.kind === "seed_profile"))!;
      const editEvent = archive!.events.find((event) => event.commands.some((item) => item.command.kind === "edit_authored_profile"))!;
      const seedCommand = seedEvent.commands.find((item) => item.command.kind === "seed_profile")!.command;
      const editCommand = editEvent.commands.find((item) => item.command.kind === "edit_authored_profile")!.command;
      expect(seedCommand.kind === "seed_profile" && seedCommand.evidence).toMatchObject({ kind: "historical_world", sourceWorldVersionId: sourceVersion });
      expect(editCommand.kind === "edit_authored_profile" && editCommand.seedEventId).toBe(seedEvent.id);
      expect(editEvent.receipt?.result?.character.profile["story.goals"]).toHaveLength(20000);
      await importCampaignCast(client, restore.scope, archive, { worlds: new Map(), turns: new Map(sourceTurns.map((turn) => [turn.id, targetTurns.find((item) => item.turn_number === turn.turn_number)!.id])) });
    });
    const restored = (await repo.current(restore.scope)).characters.find((item) => item.name === "Mara")!;
    expect(restored.originProfile?.evidence).toMatchObject({ kind: "historical_world", sourceWorldVersionId: sourceVersion });
    expect(restored.profile["story.role"]).toBe("Warden");
    expect(restored.profile["story.goals"]).toHaveLength(20000);
    await rewindCampaign(pool, scope.campaignId, { targetTurnNumber: 1 });
    const rewound = (await repo.current(scope)).characters.find((item) => item.id === manual.character.id)!;
    expect(rewound.originProfile).toBeUndefined();
    expect(rewound.profile["story.role"]).toBe("Scout");
  });

  it("reserves the protagonist by source world through transfers, a branch, and return to source", async () => {
    const createPublished = async (title: string, campaignUse: "playable" | "both") => {
      const world = await createWorld(pool, worldCreateSchema.parse({ title, content: { world: { title, premise: "A story", firstAction: "Begin" },
        playableCharacters: [{ id: "hero", name: campaignUse === "both" ? "Different hero" : "Original hero", characterText: "A thoughtful traveller.", campaignUse }] } }));
      const version = await publishWorld(pool, world.id, worldPublishSchema.parse({ expectedRevision: world.draftRevision, releaseNotes: "Test" }));
      return { world, version };
    };
    const source = await createPublished(`Source ${randomUUID()}`, "playable"), destination = await createPublished(`Destination ${randomUUID()}`, "both");
    const campaign = await createCampaign(pool, campaignCreateSchema.parse({ worldVersionId: source.version.worldVersionId, title: "Protagonist", selectedCharacterId: "hero" }));
    const original = { ownerUserId, campaignId: campaign.id };
    expect((await pool.query("SELECT selected_character_world_id FROM campaigns WHERE id=$1", [campaign.id])).rows[0].selected_character_world_id).toBe(source.world.id);
    const transfer = async (campaignId: string, targetWorldVersionId: string) => {
      const request = campaignTransferPreviewRequestSchema.parse({ targetWorldVersionId });
      const preview = await previewCampaignWorldTransfer(pool, campaignId, request);
      return transferCampaignWorld(pool, campaignId, campaignTransferCommitRequestSchema.parse({ ...request, idempotencyKey: randomUUID(),
        expectedActiveTurnNumber: preview.expectedActiveTurnNumber, expectedStateRevision: preview.expectedStateRevision, sourceFingerprint: preview.sourceFingerprint }));
    };
    const moved = await transfer(campaign.id, destination.version.worldVersionId);
    const movedScope = { ownerUserId, campaignId: moved.targetCampaignId }, repo = createPostgresCampaignCastRepository(pool, { editingEnabled: true, castPresetsEnabled: true });
    await pool.query("UPDATE campaigns SET selected_character_world_id=NULL WHERE id=$1", [movedScope.campaignId]);
    await expect(repo.fromWorldPreview!(movedScope, { characterId: "hero" })).rejects.toMatchObject({ code: "cast_world_character_unavailable" });
    await pool.query("UPDATE campaigns SET selected_character_world_id=$2 WHERE id=$1", [movedScope.campaignId, source.world.id]);
    const preview = await repo.fromWorldPreview!(movedScope, { characterId: "hero" });
    expect(preview.worldVersionId).toBe(destination.version.worldVersionId);
    const { readFirstAppearanceDecision } = await import("../../packages/database/src/campaign-cast-first-appearance.js");
    const decision = (scope: typeof movedScope, worldId: string) => withTransaction(pool, (client) => readFirstAppearanceDecision(client, scope, {
      frozenPermission: true, livePermission: true, sourceWorldId: worldId, rosterCharacterId: "hero", identityStillSupported: true, unique: true, detached: false }));
    await pool.query("UPDATE campaigns SET first_appearance_eligible=true WHERE id=$1", [movedScope.campaignId]);
    expect(await decision(movedScope, destination.world.id)).toBe("seed");
    const added = await repo.fromWorld!(movedScope, { characterId: "hero", expectedWorldVersionId: destination.version.worldVersionId,
      expectedCastRevision: preview.castRevision, expectedBoundary: preview.boundary, previewFingerprint: preview.previewFingerprint, idempotencyKey: "collision-add" });
    expect(added.character.name).toBe("Different hero");
    expect(added.character.originProfile?.entityId).toBe("hero");
    const branch = await branchCampaign(pool, movedScope.campaignId, { targetTurnNumber: 0, title: "Transferred branch" });
    const branchScope = { ownerUserId, campaignId: branch.id };
    expect((await pool.query("SELECT selected_character_world_id FROM campaigns WHERE id=$1", [branch.id])).rows[0].selected_character_world_id).toBe(source.world.id);
    expect((await repo.current(branchScope)).characters.some((person) => person.name === "Different hero" && person.originProfile?.entityId === "hero")).toBe(true);
    const returned = await transfer(branch.id, source.version.worldVersionId), returnedScope = { ownerUserId, campaignId: returned.targetCampaignId };
    expect((await pool.query("SELECT selected_character_world_id FROM campaigns WHERE id=$1", [returnedScope.campaignId])).rows[0].selected_character_world_id).toBe(source.world.id);
    await expect(repo.fromWorldPreview!(returnedScope, { characterId: "hero" })).rejects.toMatchObject({ code: "cast_world_character_unavailable" });
    expect(await decision(returnedScope, source.world.id)).toBe("protagonist");
    expect((await pool.query("SELECT selected_character_world_id FROM campaigns WHERE id=$1", [original.campaignId])).rows[0].selected_character_world_id).toBe(source.world.id);
  });

  it("branches only retained identities, remaps IDs and preserves user blanks", async () => {
    const { scope, repo } = await fixture();
    await pool.query("UPDATE campaigns SET active_turn_number=1 WHERE id=$1", [scope.campaignId]);
    const early = await repo.create(scope, { expectedCastRevision: 0, expectedBoundary: { turnNumber: 1, timelineRevision: 0 }, idempotencyKey: "early",
      name: "Mara", aliases: [], profile: { "appearance.description": "" } });
    await pool.query("UPDATE campaigns SET active_turn_number=2 WHERE id=$1", [scope.campaignId]);
    await repo.create(scope, { expectedCastRevision: early.revision, expectedBoundary: { turnNumber: 2, timelineRevision: 0 }, idempotencyKey: "later", name: "Later", aliases: [], profile: {} });
    const branch = await branchCampaign(pool, scope.campaignId, { targetTurnNumber: 1, title: "Cast branch" });
    const value = await repo.current({ ownerUserId, campaignId: branch.id });
    expect(value.characters.filter((c) => c.origin.kind !== "protagonist")).toEqual([
      expect.objectContaining({ id: expect.not.stringMatching(early.character.id), name: "Mara", profile: { "appearance.description": "" } })
    ]);
    expect(value.characters.filter((c) => c.origin.kind === "protagonist")).toHaveLength(1);
    expect((await readCastDiscoveryStatus(pool, { ownerUserId, campaignId: branch.id }, true)).coverageStartTurn).toBeNull();
  });
  it("rewinds edits permanently and fences stale batches even after turn numbers advance again", async () => {
    const { scope, repo } = await fixture();
    await pool.query("UPDATE campaigns SET active_turn_number=1 WHERE id=$1", [scope.campaignId]);
    const early = await repo.create(scope, { expectedCastRevision: 0, expectedBoundary: { turnNumber: 1, timelineRevision: 0 }, idempotencyKey: "early", name: "Mara", aliases: [], profile: {} });
    await pool.query("UPDATE campaigns SET active_turn_number=2 WHERE id=$1", [scope.campaignId]);
    await repo.edit(scope, early.character.id, { expectedCastRevision: early.revision, expectedCharacterRevision: early.character.revision,
      expectedBoundary: { turnNumber: 2, timelineRevision: 0 }, idempotencyKey: "future", name: "Discarded edit" });
    await rewindCampaign(pool, scope.campaignId, { targetTurnNumber: 1 });
    const retained = await repo.current(scope);
    expect(retained.boundary.timelineRevision).toBe(1);
    expect(retained.characters.find((c) => c.id === early.character.id)!.name).toBe("Mara");
    await pool.query("UPDATE campaigns SET active_turn_number=2 WHERE id=$1", [scope.campaignId]);
    await expect(repo.applyBatch(scope, { boundary: { turnNumber: 2, timelineRevision: 0 }, idempotencyKey: "stale-worker",
      commands: [{ kind: "identity", characterId: early.character.id, name: "Stale", aliases: [] }] })).rejects.toThrow(/boundary/i);
    expect((await repo.current(scope)).characters.find((c) => c.id === early.character.id)!.name).toBe("Mara");
  });
  it("applies an identical boundary notification once within its caller transaction", async () => {
    const { scope, repo } = await fixture();
    await repo.initialize(scope);
    await withTransaction(pool, async (client) => {
      await applyCastBoundaryChange(client, scope, { turnNumber: 2, changeKey: "correction:synthetic:1" });
      await applyCastBoundaryChange(client, scope, { turnNumber: 2, changeKey: "correction:synthetic:1" });
    });
    expect((await repo.current(scope)).boundary.timelineRevision).toBe(1);
  });
  it("invalidates corrected facts while retaining explicit edits through the production correction path", async () => {
    const { scope, repo } = await fixture();
    const initial = await repo.current(scope);
    const created = await repo.create(scope, { expectedCastRevision: initial.revision, expectedBoundary: initial.boundary,
      idempotencyKey: "person", name: "Mara", aliases: [], profile: { "story.role": "guide" } });
    const turn = (await pool.query("SELECT turn_id,turn_number,effective_narration,correction_revision FROM effective_turn_narrations WHERE campaign_id=$1 ORDER BY turn_number LIMIT 1", [scope.campaignId])).rows[0];
    await repo.applyBatch(scope, { boundary: initial.boundary, idempotencyKey: "observe", commands: [{ kind: "observe", characterId: created.character.id,
      field: "state.location", value: "harbor", mode: "fact", speakerCharacterId: null, supersedesObservationId: null,
      evidence: { kind: "turn", turnId: turn.turn_id, turnNumber: turn.turn_number, narrationRevision: turn.correction_revision,
        sourceHash: sha256(turn.effective_narration), paragraphId: "p1", quote: turn.effective_narration.slice(0, 100) } }] });
    const correction = await createPostgresTurnCorrectionRepository(pool, { memory: memoryGeneration(pool) }).correctNarration(scope,
      { turnId: turn.turn_id, expectedActiveTurnNumber: initial.boundary.turnNumber, expectedCorrectionRevision: 0,
        narration: "The silver moon rises above the quiet harbor.", source: "user_edit" });
    expect(correction.ok).toBe(true);
    const current = await repo.current(scope);
    expect(current.boundary.timelineRevision).toBe(1);
    expect(current.characters.find((c) => c.id === created.character.id)!.profile).toEqual({ "story.role": "guide" });
  });
  it("preserves world-origin identity and facts across a cross-world transfer", async () => {
    const { scope, repo } = await fixture();
    const { scope: destination } = await fixture();
    const sourceVersion = (await pool.query("SELECT world_version_id FROM campaigns WHERE id=$1", [scope.campaignId])).rows[0].world_version_id;
    const targetVersion = (await pool.query("SELECT world_version_id FROM campaigns WHERE id=$1", [destination.campaignId])).rows[0].world_version_id;
    await pool.query(`UPDATE world_versions SET content=jsonb_set(content,'{entities}',content->'entities' || '[{"id":"mara","name":"Mara","kind":"npc","summary":"guide"}]'::jsonb) WHERE id=$1`, [sourceVersion]);
    const initial = await repo.current(scope);
    const evidence = { kind: "world" as const, worldVersionId: sourceVersion, sourcePath: "/world/title" };
    const created = await repo.applyBatch(scope, { boundary: initial.boundary, idempotencyKey: "world-person", commands: [{ kind: "create",
      name: "Mara", aliases: [], origin: { kind: "world", worldVersionId: sourceVersion, entityId: "mara" }, evidence }] });
    await repo.applyBatch(scope, { boundary: initial.boundary, idempotencyKey: "world-observation", commands: [{ kind: "observe", characterId: created.characterIds[0]!,
      field: "story.role", value: "guide", mode: "fact", speakerCharacterId: null, supersedesObservationId: null, evidence }] });
    const request = campaignTransferPreviewRequestSchema.parse({ targetWorldVersionId: targetVersion });
    const preview = await previewCampaignWorldTransfer(pool, scope.campaignId, request);
    const transferred = await transferCampaignWorld(pool, scope.campaignId, campaignTransferCommitRequestSchema.parse({ ...request,
      idempotencyKey: randomUUID(), expectedActiveTurnNumber: preview.expectedActiveTurnNumber,
      expectedStateRevision: preview.expectedStateRevision, sourceFingerprint: preview.sourceFingerprint }));
    const current = await repo.current({ ownerUserId, campaignId: transferred.targetCampaignId });
    expect(current.characters.filter((c) => c.origin.kind !== "protagonist")).toEqual([
      expect.objectContaining({ name: "Mara", origin: { kind: "historical_world", sourceWorldVersionId: sourceVersion, entityId: "mara" }, profile: { "story.role": "guide" } })
    ]);
  });
  it("preserves corrected evidence and never reactivates old facts during transfer", async () => {
    const { scope, repo } = await fixture(), target = await fixture();
    const initial = await repo.current(scope);
    const created = await repo.create(scope, { expectedCastRevision: 0, expectedBoundary: initial.boundary, idempotencyKey: "manual", name: "Mara", aliases: [], profile: {} });
    const turn = (await pool.query("SELECT turn_id,turn_number,effective_narration FROM effective_turn_narrations WHERE campaign_id=$1 ORDER BY turn_number LIMIT 1", [scope.campaignId])).rows[0];
    const observe = (revision: number, narration: string, value: string) => ({ kind: "observe" as const, characterId: created.character.id,
      field: "state.location" as const, value, mode: "fact" as const, speakerCharacterId: null, supersedesObservationId: null,
      evidence: { kind: "turn" as const, turnId: turn.turn_id, turnNumber: turn.turn_number, narrationRevision: revision,
        sourceHash: sha256(narration), paragraphId: "p1", quote: narration.slice(0, 100) } });
    await repo.applyBatch(scope, { boundary: initial.boundary, idempotencyKey: "old", commands: [observe(0, turn.effective_narration, "forest")] });
    const narration = "Mara waits at the harbor.";
    await createPostgresTurnCorrectionRepository(pool, { memory: memoryGeneration(pool) }).correctNarration(scope,
      { turnId: turn.turn_id, expectedActiveTurnNumber: initial.boundary.turnNumber, expectedCorrectionRevision: 0, narration, source: "user_edit" });
    const current = await repo.current(scope);
    await repo.applyBatch(scope, { boundary: current.boundary, idempotencyKey: "new", commands: [observe(1, narration, "harbor")] });
    const targetVersion = (await pool.query("SELECT world_version_id FROM campaigns WHERE id=$1", [target.scope.campaignId])).rows[0].world_version_id;
    const request = campaignTransferPreviewRequestSchema.parse({ targetWorldVersionId: targetVersion });
    const preview = await previewCampaignWorldTransfer(pool, scope.campaignId, request);
    const transferred = await transferCampaignWorld(pool, scope.campaignId, campaignTransferCommitRequestSchema.parse({ ...request, idempotencyKey: randomUUID(),
      expectedActiveTurnNumber: preview.expectedActiveTurnNumber, expectedStateRevision: preview.expectedStateRevision, sourceFingerprint: preview.sourceFingerprint }));
    expect((await repo.current({ ownerUserId, campaignId: transferred.targetCampaignId })).characters.find((c) => c.name === "Mara")!.profile)
      .toEqual({ "state.location": "harbor" });
  });
  it("retains historical speaker identity without making an invalidated introduction visible", async () => {
    const { scope, repo } = await fixture();
    const initial = await repo.current(scope);
    const turns = (await pool.query("SELECT turn_id,turn_number,effective_narration FROM effective_turn_narrations WHERE campaign_id=$1 ORDER BY turn_number", [scope.campaignId])).rows;
    const evidence = (turn: typeof turns[number]) => ({ kind: "turn" as const, turnId: turn.turn_id, turnNumber: turn.turn_number, narrationRevision: 0,
      sourceHash: sha256(turn.effective_narration), paragraphId: "p1", quote: turn.effective_narration.slice(0, 100) });
    const speaker = await repo.applyBatch(scope, { boundary: initial.boundary, idempotencyKey: "speaker", commands: [{ kind: "create", name: "Speaker", aliases: [], origin: { kind: "discovered" }, evidence: evidence(turns[0]!) }] });
    const subject = await repo.create(scope, { expectedCastRevision: speaker.revision, expectedBoundary: initial.boundary, idempotencyKey: "subject", name: "Mara", aliases: [], profile: {} });
    await repo.applyBatch(scope, { boundary: initial.boundary, idempotencyKey: "claim", commands: [{ kind: "observe", characterId: subject.character.id,
      field: "story.role", value: "guide", mode: "claim", speakerCharacterId: speaker.characterIds[0]!, supersedesObservationId: null, evidence: evidence(turns[1]!) }] });
    await createPostgresTurnCorrectionRepository(pool, { memory: memoryGeneration(pool) }).correctNarration(scope,
      { turnId: turns[0]!.turn_id, expectedActiveTurnNumber: initial.boundary.turnNumber, expectedCorrectionRevision: 0, narration: "Nobody appears on the road.", source: "user_edit" });
    const branch = await branchCampaign(pool, scope.campaignId, { targetTurnNumber: initial.boundary.turnNumber, title: "Historical speaker" });
    const value = await repo.current({ ownerUserId, campaignId: branch.id });
    expect(value.characters.some((c) => c.name === "Speaker")).toBe(false);
    const person = value.characters.find((c) => c.name === "Mara")!;
    const detail = await repo.detail({ ownerUserId, campaignId: branch.id }, person.id);
    expect(detail.observations).toEqual([expect.objectContaining({ mode: "claim", speakerCharacterId: expect.any(String) })]);
    expect(detail.observations[0]!.speakerCharacterId).not.toBe(speaker.characterIds[0]);
    expect(person.profile).toEqual({});
  });
});
