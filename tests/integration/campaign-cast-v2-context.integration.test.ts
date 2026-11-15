import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createDatabasePool, initialOwnerId, withTransaction, type DatabasePool } from "../../packages/database/src/pool.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { captureCastGenerationSnapshotWithClient, createPostgresCampaignCastRepository } from "../../packages/database/src/campaign-cast-repository.js";
import { sha256 } from "../../packages/domain/src/text.js";
import { CAST_V2_STORY_MEMORY_CONTEXT_POLICY_VERSION, CAST_V3_STORY_MEMORY_CONTEXT_POLICY_VERSION } from "../../packages/contracts/src/story-prompt.js";
import { resolveGenerationAuthoritySnapshot } from "../../packages/database/src/generation-authority.js";
import { selectCastContext } from "../../packages/domain/src/campaign-cast-context.js";

let pool: DatabasePool;
beforeAll(async () => { pool = createDatabasePool(process.env.TEST_DATABASE_URL!, 8); await migrateDatabase(pool, resolve("database/migrations")); }, 60_000);
afterAll(async () => { await pool?.end(); });
it("keeps v1 replay stable and captures only bounded v2 fiction with discovery off", async () => {
  const ownerUserId = await initialOwnerId(pool), worldId = randomUUID(), worldVersionId = randomUUID(), campaignId = randomUUID();
  const role = "A harbor keeper. <think>PRIVATE_REASONING_CANARY remains secret.</think> Roll 1d20. She protects travelers.";
  await pool.query("INSERT INTO worlds(id,owner_user_id,title) VALUES($1,$2,'Context fixture')", [worldId, ownerUserId]);
  await pool.query("INSERT INTO world_versions(id,world_id,owner_user_id,version_number,content) VALUES($1,$2,$3,1,$4)", [worldVersionId, worldId, ownerUserId, JSON.stringify({ world: { title: "Fixture" }, playableCharacters: [{ id: "mara", name: "Mara", characterText: "A watchful keeper.", campaignUse: "supporting", profile: { story: { role, goals: "Find the lost ship", background: "b".repeat(1000), extension: "PRIVATE_EXTENSION_CANARY" }, appearance: { ancestryOrSpecies: "Roll 1d20", hair: "silver", distinguishingFeatures: ["a red scar"], extension: "PRIVATE_APPEARANCE_CANARY" } } }] })]);
  await pool.query("INSERT INTO campaigns(id,owner_user_id,world_version_id,title,active_turn_number) VALUES($1,$2,$3,'Context fixture',1)", [campaignId, ownerUserId, worldVersionId]);
  const turnId = randomUUID(), narration = "Mara seeks the hidden chart at the harbor.";
  await pool.query("INSERT INTO turns(id,owner_user_id,campaign_id,turn_number,narration) VALUES($1,$2,$3,1,$4)", [turnId, ownerUserId, campaignId, narration]);
  const scope = { ownerUserId, campaignId }, repository = createPostgresCampaignCastRepository(pool, { editingEnabled: true, castPresetsEnabled: true });
  const preview = await repository.fromWorldPreview!(scope, { characterId: "mara" });
  const created = await repository.fromWorld!(scope, { characterId: "mara", expectedWorldVersionId: worldVersionId, previewFingerprint: preview.previewFingerprint, expectedCastRevision: preview.castRevision, expectedBoundary: preview.boundary, idempotencyKey: "seed" });
  const changed = await repository.editAuthoredProfile!(scope, created.character.id, { expectedCastRevision: created.revision,
    expectedCharacterRevision: created.character.revision, expectedBoundary: created.boundary, idempotencyKey: "edit-relationship",
    set: { "story.keyRelationships": "Trusts the ferry captain" } });
  await repository.applyBatch(scope, { boundary: changed.boundary, idempotencyKey: "observe-goal", commands: [{ kind: "observe", characterId: created.character.id,
    field: "story.goals", value: "Find the hidden chart", mode: "fact", speakerCharacterId: null, supersedesObservationId: null,
    evidence: { kind: "turn", turnId, turnNumber: 1, narrationRevision: 0, sourceHash: sha256(narration), paragraphId: "p1", quote: narration } }] });
  const capture = (version: "cast-context-v1" | "cast-context-v2") => withTransaction(pool, client => captureCastGenerationSnapshotWithClient(client, scope, { discoveryEnabled: false, version }));
  const legacy = await capture("cast-context-v1"), replay = await capture("cast-context-v1");
  expect(replay.fingerprint).toBe(legacy.fingerprint);
  const modern = await capture("cast-context-v2");
  expect(modern.snapshot.discoveryStatus).toBe("off");
  expect(modern.snapshot.fiction!.find(item => item.characterId === created.character.id)!.fields.find(item => item.field === "story.goals")).toMatchObject({ value: "Find the hidden chart", source: "observation" });
  const gap = await withTransaction(pool, client => captureCastGenerationSnapshotWithClient(client, scope, { discoveryEnabled: true, version: "cast-context-v2" }));
  expect(gap.snapshot.discoveryStatus).toBe("pending");
  expect(gap.snapshot.fiction!.find(item => item.characterId === created.character.id)!.fields.find(item => item.field === "story.goals")).toMatchObject({ value: "Find the hidden chart", source: "observation" });
  await pool.query("UPDATE campaign_cast_state SET coverage_start_turn=1 WHERE campaign_id=$1", [campaignId]);
  const jobId = randomUUID();
  await pool.query(`INSERT INTO campaign_cast_discovery_jobs(id,owner_user_id,campaign_id,turn_id,turn_number,narration_revision,timeline_revision,source_hash,protocol,source,chunks,execution_snapshot,status)
    VALUES($1,$2,$3,$4,1,0,0,$5,'cast-discovery-v1','{}','[]','{}','complete')`, [jobId, ownerUserId, campaignId, turnId, sha256(narration)]);
  const current = await withTransaction(pool, client => captureCastGenerationSnapshotWithClient(client, scope, { discoveryEnabled: true, version: "cast-context-v2" }));
  expect(current.snapshot.discoveryStatus).toBe("current");
  expect(current.snapshot.fiction!.find(item => item.characterId === created.character.id)!.fields.find(item => item.field === "story.goals")).toMatchObject({ value: "Find the hidden chart", source: "observation" });
  await pool.query("UPDATE campaign_cast_discovery_jobs SET status='failed' WHERE id=$1", [jobId]);
  await repository.applyBatch(scope, { boundary: changed.boundary, idempotencyKey: "goal-override", commands: [{ kind: "override", characterId: created.character.id, field: "story.goals", value: "Protect the captain" }] });
  const overridden = await withTransaction(pool, client => captureCastGenerationSnapshotWithClient(client, scope, { discoveryEnabled: true, version: "cast-context-v2" }));
  expect(overridden.snapshot.fiction!.find(item => item.characterId === created.character.id)!.fields.find(item => item.field === "story.goals")).toMatchObject({ value: "Protect the captain", source: "override" });
  await repository.applyBatch(scope, { boundary: changed.boundary, idempotencyKey: "clear-goal-override", commands: [{ kind: "clear_override", characterId: created.character.id, field: "story.goals" }] });
  const cleared = await withTransaction(pool, client => captureCastGenerationSnapshotWithClient(client, scope, { discoveryEnabled: true, version: "cast-context-v2" }));
  expect(cleared.snapshot.fiction!.find(item => item.characterId === created.character.id)!.fields.find(item => item.field === "story.goals")).toMatchObject({ value: "Find the hidden chart", source: "observation" });


  expect(modern.fingerprint).not.toBe(legacy.fingerprint);
  const selection = selectCastContext({ snapshot: modern.snapshot, direction: "Ask Mara", currentScene: "", openThreads: [], budgetTokens: 3000 });
  expect(selection.content).toContain("harbor keeper");
  expect(selection.content).toContain("silver");
  expect(selection.content).toContain("a red scar");
  expect(selection.content).toContain("Trusts the ferry captain");
  const fields = modern.snapshot.fiction!.find(item => item.characterId === created.character.id)!.fields;
  expect(fields.find(item => item.field === "story.role")).toMatchObject({ source: "authored", evidenceId: `${created.character.originProfile!.seedEventId}:story.role` });
  const edited = fields.find(item => item.field === "story.keyRelationships")!;
  expect(edited.source).toBe("campaign_edit");
  const selectedFields = selection.records.find(record => record.characterId === created.character.id)!.fields;
  expect(selectedFields).toContainEqual(expect.objectContaining({ field: "story.role", authority: "authored", evidenceId: `${created.character.originProfile!.seedEventId}:story.role`, source: { kind: "world" } }));
  expect(selectedFields).toContainEqual(expect.objectContaining({ field: "story.keyRelationships", authority: "user", evidenceId: edited.evidenceId, source: { kind: "user" } }));
  expect(edited.evidenceId).toMatch(/:story\.keyRelationships$/);
  expect(edited.evidenceId).not.toBe(`${created.character.originProfile!.seedEventId}:story.keyRelationships`);
  expect(changed.character.fieldSources?.["story.keyRelationships"]).toBe("campaign_edit");
  expect(selection.content).not.toMatch(/PRIVATE_REASONING_CANARY|PRIVATE_EXTENSION_CANARY|PRIVATE_APPEARANCE_CANARY|1d20/);
  expect(selection.estimatedTokens).toBeLessThanOrEqual(3000);
  expect((await repository.detail(scope, created.character.id)).character.originProfile?.profile.story.role).toBe(role);
  const captured = JSON.stringify(modern.snapshot);
  expect(captured).not.toMatch(/PRIVATE_REASONING_CANARY|PRIVATE_EXTENSION_CANARY|PRIVATE_APPEARANCE_CANARY|1d20/);

  // Capture pins the old precedence while V3 yields to later accepted evidence.
  await repository.applyBatch(scope, { boundary: changed.boundary, idempotencyKey: "location-edit", commands: [{ kind: "override", characterId: created.character.id, field: "state.location", value: "the docks" }] });
  const beforeAdded = await repository.detail(scope, created.character.id);
  const added = await repository.create(scope, { expectedCastRevision: beforeAdded.revision, expectedBoundary: beforeAdded.boundary, idempotencyKey: "added-cast", name: "Iven", aliases: [], profile: {} });
  const dynamicFields = ["state.location", "state.condition", "state.clothing", "story.goals"] as const;
  await repository.applyBatch(scope, { boundary: changed.boundary, idempotencyKey: "added-edits", commands: dynamicFields.map(field => ({ kind: "override" as const, characterId: added.character.id, field, value: "earlier edit" })) });
  const laterTurn = randomUUID(), laterNarration = "Mara waits at the palace.";
  await pool.query("UPDATE campaigns SET active_turn_number=2 WHERE id=$1", [campaignId]);
  await pool.query("INSERT INTO turns(id,owner_user_id,campaign_id,turn_number,narration) VALUES($1,$2,$3,2,$4)", [laterTurn, ownerUserId, campaignId, laterNarration]);
  await repository.applyBatch(scope, { boundary: { turnNumber: 2, timelineRevision: 0 }, idempotencyKey: "location-observation", commands: [{ kind: "observe", characterId: created.character.id, field: "state.location", value: "the palace", mode: "fact", speakerCharacterId: null, supersedesObservationId: null, evidence: { kind: "turn", turnId: laterTurn, turnNumber: 2, narrationRevision: 0, sourceHash: sha256(laterNarration), paragraphId: "p1", quote: laterNarration } }] });
  await repository.applyBatch(scope, { boundary: { turnNumber: 2, timelineRevision: 0 }, idempotencyKey: "condition-observation", commands: [{ kind: "observe", characterId: created.character.id, field: "state.condition", value: "well rested", mode: "fact", speakerCharacterId: null, supersedesObservationId: null, evidence: { kind: "turn", turnId: laterTurn, turnNumber: 2, narrationRevision: 0, sourceHash: sha256(laterNarration), paragraphId: "p1", quote: laterNarration } }] });
  await pool.query("INSERT INTO campaign_state(campaign_id,owner_user_id) VALUES($1,$2) ON CONFLICT DO NOTHING", [campaignId, ownerUserId]);
  for (const [contextProtocol, value] of [[CAST_V2_STORY_MEMORY_CONTEXT_POLICY_VERSION, "the docks"], [CAST_V3_STORY_MEMORY_CONTEXT_POLICY_VERSION, "the palace"]] as const) {
    const authority = await withTransaction(pool, client => resolveGenerationAuthoritySnapshot(client, { ...scope, operationKind: "append", expectedTurnNumber: 3,
      baseIdentityVersion: "generation-base-v4", castContextVersion: "cast-context-v2", castDiscoveryEnabled: false, contextProtocol }));
    expect(authority.castSnapshot!.fiction!.find(item => item.characterId === created.character.id)!.fields).toContainEqual(expect.objectContaining({ field: "state.location", value }));
    const direct = await withTransaction(pool, client => captureCastGenerationSnapshotWithClient(client, scope, { discoveryEnabled: false, version: "cast-context-v2", contextProtocol }));
    expect(authority.baseIdentity).toMatchObject({ castFingerprint: direct.fingerprint });
  }
  const captureGap = (contextProtocol: typeof CAST_V2_STORY_MEMORY_CONTEXT_POLICY_VERSION | typeof CAST_V3_STORY_MEMORY_CONTEXT_POLICY_VERSION, discoveryEnabled: boolean) => withTransaction(pool, client => captureCastGenerationSnapshotWithClient(client, scope, { discoveryEnabled, version: "cast-context-v2", contextProtocol }));
  const gapV3 = await captureGap(CAST_V3_STORY_MEMORY_CONTEXT_POLICY_VERSION, true);
  expect(gapV3.snapshot.discoveryStatus).toBe("failed");
  const gapFields = gapV3.snapshot.fiction!.find(item => item.characterId === created.character.id)!.fields;
  expect(gapFields).toContainEqual(expect.objectContaining({ field: "state.location", value: "the palace", source: "observation", evidenceKind: "turn", effectiveTurn: 2 }));
  // Unedited current-state fields stay as dated last-known state during gaps, as in V2.
  expect(gapFields).toContainEqual(expect.objectContaining({ field: "state.condition", value: "well rested", source: "observation" }));
  await pool.query("UPDATE campaign_cast_discovery_jobs SET status='complete' WHERE id=$1", [jobId]);
  const pendingV3 = await captureGap(CAST_V3_STORY_MEMORY_CONTEXT_POLICY_VERSION, true);
  expect(pendingV3.snapshot.discoveryStatus).toBe("pending");
  expect(pendingV3.snapshot.fiction!.find(item => item.characterId === created.character.id)!.fields).toContainEqual(expect.objectContaining({ field: "state.condition", value: "well rested", source: "observation" }));
  const selectionV3 = selectCastContext({ snapshot: gapV3.snapshot, contextProtocol: CAST_V3_STORY_MEMORY_CONTEXT_POLICY_VERSION, direction: "Mara", currentScene: "", openThreads: [], budgetTokens: 3000 });
  expect(selectionV3.omittedFieldCount).toBe(0);
  expect(selectionV3.records[0]!.fields).toContainEqual(expect.objectContaining({ field: "state.condition", value: "well rested", authority: "observation" }));
  expect(selectionV3.records[0]!.fields).toContainEqual(expect.objectContaining({ field: "state.location", value: "the palace", authority: "observation" }));
  for (const result of [await captureGap(CAST_V2_STORY_MEMORY_CONTEXT_POLICY_VERSION, true), await captureGap(CAST_V3_STORY_MEMORY_CONTEXT_POLICY_VERSION, false)]) {
    expect(result.snapshot.fiction!.find(item => item.characterId === created.character.id)!.fields).toContainEqual(expect.objectContaining({ field: "state.condition", value: "well rested", source: "observation" }));
  }
  const boundary2 = { turnNumber: 2, timelineRevision: 0 };
  const evidence2 = { kind: "turn" as const, turnId: laterTurn, turnNumber: 2, narrationRevision: 0, sourceHash: sha256(laterNarration), paragraphId: "p1", quote: laterNarration };
  const observed = await repository.applyBatch(scope, { boundary: boundary2, idempotencyKey: "added-observations", commands: dynamicFields.map(field => ({ kind: "observe" as const, characterId: added.character.id, field, value: "later evidence", mode: "fact" as const, speakerCharacterId: null, supersedesObservationId: null, evidence: evidence2 })) });
  const tied = await repository.applyBatch(scope, { boundary: boundary2, idempotencyKey: "added-tie", commands: [{ kind: "observe", characterId: added.character.id, field: "state.location", value: "later evidence", mode: "fact", speakerCharacterId: null, supersedesObservationId: null, evidence: evidence2 }] });
  const superseding = await repository.applyBatch(scope, { boundary: boundary2, idempotencyKey: "added-supersede", commands: [{ kind: "observe", characterId: added.character.id, field: "state.clothing", value: "new clothing", mode: "fact", speakerCharacterId: null, supersedesObservationId: observed.observationIds[2]!, evidence: evidence2 }] });
  const addedCapture = await captureGap(CAST_V3_STORY_MEMORY_CONTEXT_POLICY_VERSION, true);
  const addedFields = addedCapture.snapshot.fiction!.find(item => item.characterId === added.character.id)!.fields;
  for (const field of dynamicFields) expect(addedFields).toContainEqual(expect.objectContaining({ field, source: "observation", value: field === "state.clothing" ? "new clothing" : "later evidence" }));
  expect(addedFields).toContainEqual(expect.objectContaining({ field: "state.location", evidenceId: `${tied.observationIds[0]}:state.location` }));
  expect(addedFields).toContainEqual(expect.objectContaining({ field: "state.clothing", evidenceId: `${superseding.observationIds[0]}:state.clothing` }));
  const detail = await repository.detail(scope, added.character.id);
  await repository.applyObservationDecision(scope, added.character.id, observed.observationIds[1]!, { action: "retract", expectedCastRevision: detail.revision, expectedCharacterRevision: detail.character.revision, expectedBoundary: boundary2, idempotencyKey: "added-retract" });
  const afterRetraction = await captureGap(CAST_V3_STORY_MEMORY_CONTEXT_POLICY_VERSION, true);
  expect(afterRetraction.snapshot.fiction!.find(item => item.characterId === added.character.id)!.fields).toContainEqual(expect.objectContaining({ field: "state.condition", value: "earlier edit", source: "override", evidenceKind: "user" }));
  for (const [contextProtocol, value, source] of [[CAST_V2_STORY_MEMORY_CONTEXT_POLICY_VERSION, "the docks", "override"], [CAST_V3_STORY_MEMORY_CONTEXT_POLICY_VERSION, "the palace", "observation"]] as const) {
    const result = await withTransaction(pool, client => captureCastGenerationSnapshotWithClient(client, scope, { discoveryEnabled: false, version: "cast-context-v2", contextProtocol }));
    expect(result.snapshot.fiction!.find(item => item.characterId === created.character.id)!.fields).toContainEqual(expect.objectContaining({ field: "state.location", value, source }));
  }

});
