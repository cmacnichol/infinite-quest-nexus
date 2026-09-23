import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabasePool, initialOwnerId, type DatabasePool, withTransaction } from "../../packages/database/src/pool.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { createPostgresCampaignCastRepository } from "../../packages/database/src/campaign-cast-repository.js";
import { storyImportRequestSchema } from "../../packages/contracts/src/imports.js";
import { importLegacyStory, branchCampaign, rewindCampaign, previewCampaignWorldTransfer, transferCampaignWorld } from "../helpers/memory-aware-services.js";
import { applyCastBoundaryChange } from "../../packages/database/src/campaign-cast-lifecycle.js";
import { createPostgresTurnCorrectionRepository } from "../../packages/database/src/turn-correction-repository.js";
import { memoryGeneration } from "../helpers/memory-applications.js";
import { sha256 } from "../../packages/domain/src/text.js";
import { campaignTransferPreviewRequestSchema, campaignTransferCommitRequestSchema } from "../../packages/contracts/src/campaign-transfer.js";

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
      expect.objectContaining({ name: "Mara", origin: { kind: "world", worldVersionId: sourceVersion, entityId: "mara" }, profile: { "story.role": "guide" } })
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
