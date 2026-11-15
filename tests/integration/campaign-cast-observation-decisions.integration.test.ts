import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyCastBatchWithClient, captureCastGenerationSnapshotWithClient, createPostgresCampaignCastRepository } from "../../packages/database/src/campaign-cast-repository.js";
import { createDatabasePool, initialOwnerId, withTransaction, type DatabasePool } from "../../packages/database/src/pool.js";
import { selectCastContext } from "../../packages/domain/src/campaign-cast-context.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import type { CastEvidence } from "../../packages/contracts/src/campaign-cast.js";
import { sha256 } from "../../packages/domain/src/text.js";

const integration = process.env.TEST_DATABASE_URL ? describe : describe.skip;
integration("cast observation decisions", () => {
  let pool: DatabasePool, ownerUserId: string;
  beforeAll(async () => { pool = createDatabasePool(process.env.TEST_DATABASE_URL!, 8); await migrateDatabase(pool, resolve("database/migrations")); ownerUserId = await initialOwnerId(pool); }, 60_000);
  afterAll(async () => { await pool?.end(); });
  it("previews, retracts and restores an observed fact without changing its source", async () => {
    const worldId = randomUUID(), versionId = randomUUID(), campaignId = randomUUID(), turnId = randomUUID();
    const narration = "Mara waits at the harbor.";
    await pool.query("INSERT INTO worlds(id,owner_user_id,title) VALUES($1,$2,'Decision')", [worldId, ownerUserId]);
    await pool.query("INSERT INTO world_versions(id,world_id,owner_user_id,version_number,content) VALUES($1,$2,$3,1,'{}')", [versionId, worldId, ownerUserId]);
    await pool.query("INSERT INTO campaigns(id,owner_user_id,world_version_id,title,active_turn_number,character_profile) VALUES($1,$2,$3,'Decision',1,'{}')", [campaignId, ownerUserId, versionId]);
    await pool.query("INSERT INTO turns(id,owner_user_id,campaign_id,turn_number,narration) VALUES($1,$2,$3,1,$4)", [turnId, ownerUserId, campaignId, narration]);
    const scope = { ownerUserId, campaignId }, boundary = { turnNumber: 1, timelineRevision: 0 };
    const repo = createPostgresCampaignCastRepository(pool, { editingEnabled: true, lifecycleEnabled: true });
    const created = await repo.create(scope, { expectedCastRevision: 0, expectedBoundary: boundary, idempotencyKey: randomUUID(), name: "Mara", aliases: [], profile: {} });
    const fact = await repo.applyBatch(scope, { boundary, idempotencyKey: randomUUID(), commands: [{ kind: "observe", characterId: created.character.id, field: "state.location", value: "harbor", mode: "fact", speakerCharacterId: null, supersedesObservationId: null, evidence: { kind: "turn", turnId, turnNumber: 1, narrationRevision: 0, sourceHash: sha256(narration), paragraphId: "p1", quote: narration } }] });
    const detail = await repo.detail(scope, created.character.id);
    const request = { action: "retract" as const, expectedCastRevision: detail.revision, expectedCharacterRevision: detail.character.revision, expectedBoundary: boundary, idempotencyKey: randomUUID() };
    const decisions = repo as typeof repo & { previewObservationDecision: (...args: any[]) => Promise<any>; applyObservationDecision: (...args: any[]) => Promise<any> };
    await expect(decisions.previewObservationDecision({ ...scope, ownerUserId: randomUUID() }, created.character.id, fact.observationIds[0], request)).rejects.toMatchObject({ code: "cast_not_found" });
    await expect(decisions.previewObservationDecision(scope, randomUUID(), fact.observationIds[0], request)).rejects.toMatchObject({ code: "cast_not_found" });
    await expect(decisions.previewObservationDecision(scope, created.character.id, randomUUID(), request)).rejects.toMatchObject({ code: "cast_invalid_request" });
    await expect(repo.applyBatch(scope, { boundary, idempotencyKey: randomUUID(), commands: [{ kind: "retract_observation", characterId: created.character.id, observationId: fact.observationIds[0]! }] })).rejects.toThrow(/dedicated/i);
    const providerId = randomUUID();
    await pool.query("INSERT INTO provider_profiles(id,owner_user_id,name,provider_type,base_url) VALUES($1,$2,'Fixture','openai_compatible','http://fixture.invalid')", [providerId, ownerUserId]);
    const job = (await pool.query("INSERT INTO generation_jobs(owner_user_id,campaign_id,provider_profile_id,idempotency_key,expected_turn_number,action,status) VALUES($1,$2,$3,$4,2,'fixture','queued') RETURNING id", [ownerUserId, campaignId, providerId, randomUUID()])).rows[0];
    await expect(decisions.applyObservationDecision(scope, created.character.id, fact.observationIds[0], request)).rejects.toMatchObject({ code: "cast_generation_active" });
    await pool.query("UPDATE generation_jobs SET status='cancelled' WHERE id=$1", [job.id]);
    const protagonist = (await repo.current(scope)).characters.find(item => item.origin.kind === "protagonist")!;
    await expect(decisions.previewObservationDecision(scope, protagonist.id, fact.observationIds[0], request)).rejects.toMatchObject({ code: "cast_protagonist_read_only" });
    const countBeforePreview = (await pool.query("SELECT count(*)::int AS count FROM campaign_cast_events WHERE campaign_id=$1", [campaignId])).rows[0].count;
    const preview = await decisions.previewObservationDecision(scope, created.character.id, fact.observationIds[0], request);
    expect((await pool.query("SELECT count(*)::int AS count FROM campaign_cast_events WHERE campaign_id=$1", [campaignId])).rows[0].count).toBe(countBeforePreview);
    expect(preview).toMatchObject({ currentValue: "harbor", projectedValue: null, currentConflict: false, projectedConflict: false });
    const result = await decisions.applyObservationDecision(scope, created.character.id, fact.observationIds[0], request);
    expect((await repo.detail(scope, created.character.id)).character.profile["state.location"] ?? null).toBe(preview.projectedValue);
    expect(await decisions.applyObservationDecision(scope, created.character.id, fact.observationIds[0], request)).toEqual(result);
    await expect(decisions.applyObservationDecision(scope, created.character.id, fact.observationIds[0], { ...request, idempotencyKey: randomUUID() })).rejects.toMatchObject({ code: "cast_revision_conflict" });
    await expect(decisions.applyObservationDecision(scope, created.character.id, randomUUID(), request)).rejects.toMatchObject({ code: "cast_idempotency_conflict" });
    const restore = { ...request, action: "restore" as const, retractionEventId: result.decisionEventId, expectedCastRevision: result.revision, expectedCharacterRevision: result.character.revision, idempotencyKey: randomUUID() };
    const restored = await decisions.applyObservationDecision(scope, created.character.id, fact.observationIds[0], restore);
    await expect(decisions.applyObservationDecision(scope, created.character.id, fact.observationIds[0], { ...restore, expectedCastRevision: restored.revision, expectedCharacterRevision: restored.character.revision, idempotencyKey: randomUUID() })).rejects.toMatchObject({ code: "cast_invalid_request" });
    expect(restored.character.profile["state.location"]).toBe("harbor");
    const secondRetraction = await decisions.applyObservationDecision(scope, created.character.id, fact.observationIds[0], { ...request, expectedCastRevision: restored.revision, expectedCharacterRevision: restored.character.revision, idempotencyKey: randomUUID() });
    await expect(decisions.applyObservationDecision(scope, created.character.id, fact.observationIds[0], { ...restore, expectedCastRevision: secondRetraction.revision, expectedCharacterRevision: secondRetraction.character.revision, idempotencyKey: randomUUID() })).rejects.toMatchObject({ code: "cast_invalid_request" });
    await pool.query("UPDATE world_versions SET content=$2 WHERE id=$1", [versionId, JSON.stringify({ entities: [{ id: "mara", name: "Mara" }] })]);
    const worldFact = await repo.applyBatch(scope, { boundary, idempotencyKey: randomUUID(), commands: [{ kind: "observe", characterId: created.character.id, field: "story.role", value: "sailor", mode: "fact", speakerCharacterId: null, supersedesObservationId: null, evidence: { kind: "world", worldVersionId: versionId, sourcePath: "/entities/0" } }] });
    const next = await repo.detail(scope, created.character.id);
    await expect(decisions.previewObservationDecision(scope, created.character.id, worldFact.observationIds[0], { ...request, expectedCastRevision: next.revision, expectedCharacterRevision: next.character.revision, idempotencyKey: randomUUID() })).rejects.toMatchObject({ code: "cast_invalid_request" });
    const claim = await repo.applyBatch(scope, { boundary, idempotencyKey: randomUUID(), commands: [{ kind: "observe", characterId: created.character.id, field: "story.role", value: "captain", mode: "claim", speakerCharacterId: created.character.id, supersedesObservationId: null, evidence: { kind: "turn", turnId, turnNumber: 1, narrationRevision: 0, sourceHash: sha256(narration), paragraphId: "p1", quote: narration } }] });
    const afterClaim = await repo.detail(scope, created.character.id);
    await expect(decisions.previewObservationDecision(scope, created.character.id, claim.observationIds[0], { ...request, expectedCastRevision: afterClaim.revision, expectedCharacterRevision: afterClaim.character.revision, idempotencyKey: randomUUID() })).rejects.toMatchObject({ code: "cast_invalid_request" });
    const appearance = async (value: string) => repo.applyBatch(scope, { boundary, idempotencyKey: randomUUID(), commands: [{ kind: "observe", characterId: created.character.id, field: "appearance.description", value, mode: "fact", speakerCharacterId: null, supersedesObservationId: null, evidence: { kind: "turn", turnId, turnNumber: 1, narrationRevision: 0, sourceHash: sha256(narration), paragraphId: "p1", quote: narration } }] });
    await appearance("blue eyes");
    const conflicting = await appearance("green eyes"), beforeConflict = await repo.detail(scope, created.character.id);
    const conflictRequest = { ...request, expectedCastRevision: beforeConflict.revision, expectedCharacterRevision: beforeConflict.character.revision, idempotencyKey: randomUUID() };
    expect((await repo.workspaceRead!(scope)).conflictIds).toContain(created.character.id);
    const conflictPreview = await decisions.previewObservationDecision(scope, created.character.id, conflicting.observationIds[0], conflictRequest);
    expect(conflictPreview).toMatchObject({ currentConflict: true, projectedConflict: false, currentValue: null, projectedValue: "blue eyes" });
    const resolved = await decisions.applyObservationDecision(scope, created.character.id, conflicting.observationIds[0], conflictRequest);
    expect(resolved.character.profile["appearance.description"]).toBe(conflictPreview.projectedValue);
    expect((await repo.workspaceRead!(scope)).conflictIds).not.toContain(created.character.id);
    expect((await repo.current(scope)).characters.find(item => item.id === created.character.id)?.profile["appearance.description"]).toBe(conflictPreview.projectedValue);
    expect((await repo.detail(scope, created.character.id)).observations.some(item => item.id === conflicting.observationIds[0])).toBe(true);
    expect((await pool.query("SELECT count(*)::int AS count FROM campaign_cast_events WHERE campaign_id=$1 AND payload @> $2::jsonb", [campaignId, JSON.stringify([{ command: { kind: "override" } }])])).rows[0].count).toBe(0);
    await pool.query("UPDATE turns SET narration='Changed source.' WHERE id=$1", [turnId]);
    await expect(decisions.previewObservationDecision(scope, created.character.id, conflicting.observationIds[0], { action: "restore", retractionEventId: resolved.decisionEventId, expectedCastRevision: resolved.revision, expectedCharacterRevision: resolved.character.revision, expectedBoundary: boundary, idempotencyKey: randomUUID() })).rejects.toMatchObject({ code: "cast_revision_conflict" });
    await pool.query("UPDATE turns SET narration=$2 WHERE id=$1", [turnId, narration]);
    const removed = await repo.changeRemoval!(scope, created.character.id, "remove", { expectedCastRevision: resolved.revision, expectedCharacterRevision: resolved.character.revision, expectedBoundary: boundary, idempotencyKey: randomUUID() });
    await expect(decisions.previewObservationDecision(scope, created.character.id, conflicting.observationIds[0], { action: "restore", retractionEventId: resolved.decisionEventId, expectedCastRevision: removed.revision, expectedCharacterRevision: removed.character.revision, expectedBoundary: boundary, idempotencyKey: randomUUID() })).rejects.toMatchObject({ code: "cast_character_removed" });
    expect((await pool.query("SELECT narration FROM turns WHERE id=$1", [turnId])).rows[0].narration).toBe(narration);
    expect((await pool.query("SELECT evidence FROM campaign_cast_observations WHERE id=$1", [fact.observationIds[0]])).rows[0].evidence.quote).toBe(narration);
  });

  async function projectionFixture(seeded = false) {
    const worldId = randomUUID(), versionId = randomUUID(), campaignId = randomUUID();
    const content = { world: { title: "Decision" }, playableCharacters: [{ id: "mara", name: "Mara", characterText: "", campaignUse: "supporting", profile: { story: { goals: "Find home" } } }] };
    await pool.query("INSERT INTO worlds(id,owner_user_id,title) VALUES($1,$2,'Decision')", [worldId, ownerUserId]);
    await pool.query("INSERT INTO world_versions(id,world_id,owner_user_id,version_number,content) VALUES($1,$2,$3,1,$4)", [versionId, worldId, ownerUserId, JSON.stringify(content)]);
    await pool.query("INSERT INTO campaigns(id,owner_user_id,world_version_id,title,active_turn_number,character_profile) VALUES($1,$2,$3,'Decision',2,'{}')", [campaignId, ownerUserId, versionId]);
    const evidence: Extract<CastEvidence, { kind: "turn" }>[] = [];
    for (const turnNumber of [1, 2]) {
      const turnId = randomUUID(), narration = `Mara has blue hair in scene ${turnNumber}.`;
      await pool.query("INSERT INTO turns(id,owner_user_id,campaign_id,turn_number,narration) VALUES($1,$2,$3,$4,$5)", [turnId, ownerUserId, campaignId, turnNumber, narration]);
      evidence.push({ kind: "turn" as const, turnId, turnNumber, narrationRevision: 0, sourceHash: sha256(narration), paragraphId: "p1", quote: narration });
    }
    const scope = { ownerUserId, campaignId }, boundary = { turnNumber: 2, timelineRevision: 0 };
    const repo = createPostgresCampaignCastRepository(pool, { editingEnabled: true, castPresetsEnabled: true });
    let characterId: string;
    if (seeded) {
      const preview = await repo.fromWorldPreview!(scope, { characterId: "mara" });
      characterId = (await repo.fromWorld!(scope, { characterId: "mara", expectedWorldVersionId: versionId, previewFingerprint: preview.previewFingerprint, expectedCastRevision: preview.castRevision, expectedBoundary: preview.boundary, idempotencyKey: randomUUID() })).character.id;
    } else {
      characterId = (await repo.create(scope, { expectedCastRevision: 0, expectedBoundary: boundary, idempotencyKey: randomUUID(), name: "Mara", aliases: [], profile: {} })).character.id;
    }
    const observe = async (field: "state.location" | "story.goals" | "appearance.description", value: string, turnIndex: number) => {
      const receipt = await repo.applyBatch(scope, { boundary, idempotencyKey: randomUUID(), commands: [{ kind: "observe", characterId, field, value, mode: "fact", speakerCharacterId: null, supersedesObservationId: null, evidence: evidence[turnIndex]! }] });
      return receipt.observationIds[0]!;
    };
    return { scope, boundary, repo, characterId, observe, evidence };
  }

  async function verifyDecisionCycle(f: Awaited<ReturnType<typeof projectionFixture>>, observationId: string,
    field: "state.location" | "story.goals" | "appearance.description", before: string, after: string) {
    const { scope, boundary, repo, characterId } = f;
    const detail = await repo.detail(scope, characterId);
    const request = { action: "retract" as const, expectedCastRevision: detail.revision, expectedCharacterRevision: detail.character.revision, expectedBoundary: boundary, idempotencyKey: randomUUID() };
    const preview = await repo.previewObservationDecision(scope, characterId, observationId, request);
    expect(preview).toMatchObject({ field, currentValue: before, projectedValue: after, currentConflict: false, projectedConflict: false });
    const result = await repo.applyObservationDecision(scope, characterId, observationId, request);
    expect(result.character.profile[field]).toBe(preview.projectedValue);
    expect((await repo.current(scope)).characters.find(item => item.id === characterId)?.profile[field]).toBe(preview.projectedValue);
    expect((await repo.detail(scope, characterId)).character.profile[field]).toBe(preview.projectedValue);
    expect((await repo.workspaceRead!(scope)).conflictIds).not.toContain(characterId);
    const restore = { action: "restore" as const, retractionEventId: result.decisionEventId, expectedCastRevision: result.revision, expectedCharacterRevision: result.character.revision, expectedBoundary: boundary, idempotencyKey: randomUUID() };
    const restorePreview = await repo.previewObservationDecision(scope, characterId, observationId, restore);
    expect(restorePreview).toMatchObject({ field, currentValue: after, projectedValue: before, currentConflict: false, projectedConflict: false });
    const restored = await repo.applyObservationDecision(scope, characterId, observationId, restore);
    expect(restored.character.profile[field]).toBe(restorePreview.projectedValue);
    expect((await repo.current(scope)).characters.find(item => item.id === characterId)?.profile[field]).toBe(restorePreview.projectedValue);
    expect((await repo.detail(scope, characterId)).character.profile[field]).toBe(restorePreview.projectedValue);
    expect((await repo.workspaceRead!(scope)).conflictIds).not.toContain(characterId);
  }

  it("reveals an older dynamic fact when the latest is retracted and restores the latest", async () => {
    const f = await projectionFixture();
    await f.observe("state.location", "forest", 0);
    const latest = await f.observe("state.location", "harbor", 1);
    await verifyDecisionCycle(f, latest, "state.location", "harbor", "forest");
  });

  it("retains an explicit override through retraction and restoration", async () => {
    const f = await projectionFixture();
    await f.observe("state.location", "forest", 0);
    const latest = await f.observe("state.location", "harbor", 1);
    const detail = await f.repo.detail(f.scope, f.characterId);
    await f.repo.edit(f.scope, f.characterId, { expectedCastRevision: detail.revision, expectedCharacterRevision: detail.character.revision, expectedBoundary: f.boundary, idempotencyKey: randomUUID(), setOverrides: { "state.location": "tower" } });
    await verifyDecisionCycle(f, latest, "state.location", "tower", "tower");
  });

  it("uses authored goals fallback and latest observed appearance for a seeded character", async () => {
    const f = await projectionFixture(true);
    const goal = await f.observe("story.goals", "Sail away", 1);
    await verifyDecisionCycle(f, goal, "story.goals", "Sail away", "Find home");
    await f.observe("appearance.description", "blue coat", 0);
    const latest = await f.observe("appearance.description", "green coat", 1);
    await verifyDecisionCycle(f, latest, "appearance.description", "green coat", "blue coat");
  });


  it.each([false, true])("freezes retraction-aware context and evidence for seeded=%s", async seeded => {
    const f = await projectionFixture(seeded);
    const older = await f.observe("appearance.description", "blue hair", 0);
    const newer = await f.observe("appearance.description", "blue hair", 1);
    const capture = (version: "cast-context-v1" | "cast-context-v2") => withTransaction(pool, client => captureCastGenerationSnapshotWithClient(client, f.scope, { discoveryEnabled: false, version }));
    const oldV1 = await capture("cast-context-v1"), oldV2 = await capture("cast-context-v2");
    const detail = await f.repo.detail(f.scope, f.characterId);
    const beforeContext = await f.repo.draftPreviewContext!(f.scope, f.characterId, { expectedCastRevision: detail.revision, expectedCharacterRevision: detail.character.revision, expectedBoundary: f.boundary });
    expect(beforeContext.evidence.map(e => e.evidenceId)).toContain(newer);
    const request = { action: "retract" as const, expectedCastRevision: detail.revision, expectedCharacterRevision: detail.character.revision, expectedBoundary: f.boundary, idempotencyKey: randomUUID() };
    const result = await f.repo.applyObservationDecision(f.scope, f.characterId, newer, request);
    const v1 = await capture("cast-context-v1"), v2 = await capture("cast-context-v2");
    const select = (snapshot: typeof v1.snapshot) => selectCastContext({ snapshot, direction: "Mara", currentScene: "", openThreads: [], budgetTokens: 3000 });
    expect(select(v1.snapshot).records.find(r => r.characterId === f.characterId)?.fields.find(x => x.field === "appearance.description")?.evidenceId).toBe(older);
    expect(v2.snapshot.fiction!.find(r => r.characterId === f.characterId)?.fields.find(x => x.field === "appearance.description")?.evidenceId).toBe(`${older}:appearance.description`);
    expect(select(oldV1.snapshot).records.find(r => r.characterId === f.characterId)?.fields.find(x => x.field === "appearance.description")?.evidenceId).toBe(newer);
    expect(oldV2.snapshot.fiction!.find(r => r.characterId === f.characterId)?.fields.find(x => x.field === "appearance.description")?.evidenceId).toBe(`${newer}:appearance.description`);
    expect(v1.fingerprint).not.toBe(oldV1.fingerprint);
    const context = await f.repo.draftPreviewContext!(f.scope, f.characterId, { expectedCastRevision: result.revision, expectedCharacterRevision: result.character.revision, expectedBoundary: f.boundary });
    expect(context.evidence.map(e => e.evidenceId)).not.toContain(newer);
    const restored = await f.repo.applyObservationDecision(f.scope, f.characterId, newer, { action: "restore", retractionEventId: result.decisionEventId, expectedCastRevision: result.revision, expectedCharacterRevision: result.character.revision, expectedBoundary: f.boundary, idempotencyKey: randomUUID() });
    expect(restored.character.profile["appearance.description"]).toBe("blue hair");
    expect((await capture("cast-context-v2")).snapshot.fiction!.find(r => r.characterId === f.characterId)?.fields.find(x => x.field === "appearance.description")?.evidenceId).toBe(`${newer}:appearance.description`);
    expect(select(v1.snapshot).records.find(r => r.characterId === f.characterId)?.fields.find(x => x.field === "appearance.description")?.evidenceId).toBe(older);
  });

  it("captures the seeded latest appearance on both sides of retraction", async () => {
    const f = await projectionFixture(true);
    const older = await f.observe("appearance.description", "blue coat", 0);
    const newer = await f.observe("appearance.description", "green coat", 1);
    const capture = (version: "cast-context-v1" | "cast-context-v2") => withTransaction(pool, client => captureCastGenerationSnapshotWithClient(client, f.scope, { discoveryEnabled: false, version }));
    const selection = (snapshot: Awaited<ReturnType<typeof capture>>["snapshot"]) => selectCastContext({ snapshot, direction: "Mara", currentScene: "", openThreads: [], budgetTokens: 3000 }).records.find(r => r.characterId === f.characterId)?.fields.find(x => x.field === "appearance.description");
    const before = await capture("cast-context-v1");
    expect(selection(before.snapshot)).toMatchObject({ value: "green coat", evidenceId: newer });
    const detail = await f.repo.detail(f.scope, f.characterId);
    const result = await f.repo.applyObservationDecision(f.scope, f.characterId, newer, { action: "retract", expectedCastRevision: detail.revision, expectedCharacterRevision: detail.character.revision, expectedBoundary: f.boundary, idempotencyKey: randomUUID() });
    const after = await capture("cast-context-v1"), modern = await capture("cast-context-v2");
    expect(selection(after.snapshot)).toMatchObject({ value: "blue coat", evidenceId: older });
    expect(modern.snapshot.fiction!.find(r => r.characterId === f.characterId)?.fields.find(x => x.field === "appearance.description")).toMatchObject({ value: "blue coat", evidenceId: `${older}:appearance.description` });
    await f.repo.applyObservationDecision(f.scope, f.characterId, newer, { action: "restore", retractionEventId: result.decisionEventId, expectedCastRevision: result.revision, expectedCharacterRevision: result.character.revision, expectedBoundary: f.boundary, idempotencyKey: randomUUID() });
    expect(selection((await capture("cast-context-v1")).snapshot)).toMatchObject({ value: "green coat", evidenceId: newer });
    expect(selection(after.snapshot)).toMatchObject({ value: "blue coat", evidenceId: older });
  });

  it.each(["mention", "attachment"] as const)("does not offer or accept %s evidence overlapping a retracted fact", async kind => {
    const f = await projectionFixture();
    const fact = await f.observe("appearance.description", "blue hair", 0);
    const unrelatedNarration = "Mara is a kind guide.";
    const unrelated = { ...f.evidence[1]!, quote: unrelatedNarration, sourceHash: sha256(unrelatedNarration) };
    await pool.query("UPDATE turns SET narration=$2 WHERE id=$1", [unrelated.turnId, unrelatedNarration]);
    const source = { ...f.evidence[0]!, quote: "Mara" };
    const range = { turnId: source.turnId, narrationRevision: source.narrationRevision, sourceHash: source.sourceHash, paragraphId: source.paragraphId, start: 0, end: 4 };
    const batch = { boundary: f.boundary, idempotencyKey: randomUUID(), commands: [{ kind: "mention" as const, characterId: f.characterId, evidence: source }] };
    const mentioned = kind === "attachment" ? await withTransaction(pool, client => applyCastBatchWithClient(client, f.scope, batch, { attachment: { characterId: f.characterId, basis: "unique_name", sourceRanges: [range] } })) : await f.repo.applyBatch(f.scope, batch);
    const other = await f.repo.applyBatch(f.scope, { boundary: f.boundary, idempotencyKey: randomUUID(), commands: [{ kind: "mention", characterId: f.characterId, evidence: { ...unrelated, quote: "Mara" } }] });
    const detail = await f.repo.detail(f.scope, f.characterId);
    const beforeRequest = { expectedCastRevision: detail.revision, expectedCharacterRevision: detail.character.revision, expectedBoundary: f.boundary };
    const before = await f.repo.draftPreviewContext!(f.scope, f.characterId, beforeRequest);
    const staleEvidence = before.evidence.find(e => e.evidenceId === mentioned.eventId)!;
    expect(staleEvidence?.quote).toContain("blue hair");
    expect(before.evidence.some(e => e.evidenceId === other.eventId)).toBe(true);
    const result = await f.repo.applyObservationDecision(f.scope, f.characterId, fact, { action: "retract", ...beforeRequest, idempotencyKey: randomUUID() });
    const request = { expectedCastRevision: result.revision, expectedCharacterRevision: result.character.revision, expectedBoundary: f.boundary };
    const after = await f.repo.draftPreviewContext!(f.scope, f.characterId, request);
    expect(after.evidence.some(e => e.evidenceId === mentioned.eventId)).toBe(false);
    expect(after.evidence.some(e => e.evidenceId === other.eventId)).toBe(true);
    await expect(f.repo.edit(f.scope, f.characterId, { ...request, idempotencyKey: randomUUID(), setOverrides: { "appearance.description": "blue hair" }, draftEvidenceFences: [{ path: "appearance.description", value: "blue hair", evidence: [staleEvidence] }] })).rejects.toMatchObject({ code: "cast_draft_evidence_changed" });
  });

  it("does not treat a superseded predecessor as an observed path when its successor is retracted", async () => {
    const f = await projectionFixture();
    const older = await f.observe("appearance.description", "blue hair", 0);
    const newer = await f.repo.applyBatch(f.scope, { boundary: f.boundary, idempotencyKey: randomUUID(), commands: [{ kind: "observe", characterId: f.characterId, field: "appearance.description", value: "green hair", mode: "fact", speakerCharacterId: null, supersedesObservationId: older, evidence: f.evidence[1]! }] });
    const detail = await f.repo.detail(f.scope, f.characterId);
    const result = await f.repo.applyObservationDecision(f.scope, f.characterId, newer.observationIds[0]!, { action: "retract", expectedCastRevision: detail.revision, expectedCharacterRevision: detail.character.revision, expectedBoundary: f.boundary, idempotencyKey: randomUUID() });
    const context = await f.repo.draftPreviewContext!(f.scope, f.characterId, { expectedCastRevision: result.revision, expectedCharacterRevision: result.character.revision, expectedBoundary: f.boundary });
    expect(context.observedPaths).not.toContain("appearance.description");
    expect(context.evidence.some(e => e.evidenceId === older)).toBe(false);
  });

  it("retains an unrelated fact span in the same paragraph", async () => {
    const f = await projectionFixture(), narration = "Mara has blue hair. Mara is a kind guide.";
    const source = { ...f.evidence[0]!, sourceHash: sha256(narration) };
    await pool.query("UPDATE turns SET narration=$2 WHERE id=$1", [source.turnId, narration]);
    const write = async (field: "appearance.description" | "story.role", value: string, quote: string) => f.repo.applyBatch(f.scope, { boundary: f.boundary, idempotencyKey: randomUUID(), commands: [{ kind: "observe", characterId: f.characterId, field, value, mode: "fact", speakerCharacterId: null, supersedesObservationId: null, evidence: { ...source, quote } }] });
    const fact = await write("appearance.description", "blue hair", "Mara has blue hair.");
    const other = await write("story.role", "kind guide", "Mara is a kind guide.");
    const detail = await f.repo.detail(f.scope, f.characterId);
    const result = await f.repo.applyObservationDecision(f.scope, f.characterId, fact.observationIds[0]!, { action: "retract", expectedCastRevision: detail.revision, expectedCharacterRevision: detail.character.revision, expectedBoundary: f.boundary, idempotencyKey: randomUUID() });
    const context = await f.repo.draftPreviewContext!(f.scope, f.characterId, { expectedCastRevision: result.revision, expectedCharacterRevision: result.character.revision, expectedBoundary: f.boundary });
    expect(context.evidence.map(e => e.evidenceId)).toContain(other.observationIds[0]);
    expect(context.evidence.map(e => e.evidenceId)).not.toContain(fact.observationIds[0]);
  });

});
