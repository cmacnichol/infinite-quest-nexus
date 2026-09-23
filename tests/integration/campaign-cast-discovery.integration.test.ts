import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDatabasePool, initialOwnerId, withTransaction, type DatabasePool } from "../../packages/database/src/pool.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { createCastDiscoveryJobRepository, enqueueCastDiscoveryWithClient } from "../../packages/database/src/campaign-cast-job-repository.js";
import { applyCastBatchWithClient, createPostgresCampaignCastRepository } from "../../packages/database/src/campaign-cast-repository.js";
import { deriveTextExecutionPlan, textExecutionRouteBasisHash } from "../../packages/contracts/src/text-execution-plan.js";
import { CAST_DISCOVERY_SYSTEM_PROMPT } from "../../packages/contracts/src/prompt-library.js";
import { createPostgresPreparedTextAttemptRepository } from "../../packages/database/src/prepared-text-attempt-repository.js";
import { runCastDiscoveryOnce } from "../../packages/application/src/campaign-cast/discovery.js";
import { prepareCastDiscoveryExecution } from "../../services/runtime/src/campaign-cast-discovery-adapter.js";
import { createPreparedTextExecutor } from "../../services/runtime/src/prepared-text-executor.js";
import type { RuntimeTextExecution } from "../../services/runtime/src/provider-credential-transport-adapter.js";
import { createProviderResponseFormatCapabilities } from "../../services/runtime/src/provider-response-format-capabilities.js";
import { capabilityRouteConfigHash } from "../../services/runtime/src/provider-capability-cache.js";
import { getProviderOutputSchemaV2 } from "../../packages/contracts/src/provider-output-schema.js";
import { createWorkerCampaignCastApplication } from "../../services/runtime/src/campaign-cast-composition.js";
import { applyCastBoundaryChange } from "../../packages/database/src/campaign-cast-lifecycle.js";

describe("durable cast discovery", () => {
  let pool: DatabasePool, ownerUserId: string;
  const campaignIds: string[] = [];
  beforeAll(async () => {
    pool = createDatabasePool(process.env.TEST_DATABASE_URL!, 8);
    await migrateDatabase(pool, resolve("database/migrations"));
    ownerUserId = await initialOwnerId(pool);
  }, 60000);
  afterAll(async () => { await pool?.end(); });
  afterEach(async () => { await pool.query("DELETE FROM campaigns WHERE id=ANY($1::uuid[])", [campaignIds.splice(0)]); });
  async function fixture(count = 1) {
    const worldId = randomUUID(), versionId = randomUUID(), campaignId = randomUUID(), providerProfileId = randomUUID();
    campaignIds.push(campaignId);
    await pool.query("INSERT INTO worlds(id,owner_user_id,title) VALUES($1,$2,'Discovery fixture')", [worldId, ownerUserId]);
    await pool.query("INSERT INTO world_versions(id,world_id,owner_user_id,version_number,content) VALUES($1,$2,$3,1,'{}')", [versionId, worldId, ownerUserId]);
    await pool.query("INSERT INTO campaigns(id,owner_user_id,world_version_id,title,active_turn_number) VALUES($1,$2,$3,'Discovery fixture',$4)", [campaignId, ownerUserId, versionId, count]);
    const turnIds: string[] = [];
    for (let n = 1; n <= count; n++) {
      const id = randomUUID(); turnIds.push(id);
      await pool.query("INSERT INTO turns(id,owner_user_id,campaign_id,turn_number,narration) VALUES($1,$2,$3,$4,'Mara has blue eyes.')", [id, ownerUserId, campaignId, n]);
    }
    const scope = { ownerUserId, campaignId };
    await createPostgresCampaignCastRepository(pool).initialize(scope);
    const basis = { version: 2 as const, selection: { kind: "model" as const, modelId: "fixture" }, preset: null,
      candidates: [{ modelId: "fixture", providerPolicy: {}, contextWindowTokens: 8000, maxOutputTokens: 2000 }],
      presetSystemPrompt: "", parameters: {}, endpointReference: "fixture-endpoint", credentialReference: providerProfileId,
      profileRevision: "fixture", authorityRevision: "fixture", requestTimeoutMs: 30000, protocolVersion: "cast-discovery-v1", routeBasisHash: "0".repeat(64) };
    const execution = { providerProfileId, plan: deriveTextExecutionPlan({ ...basis, routeBasisHash: textExecutionRouteBasisHash(basis) }, CAST_DISCOVERY_SYSTEM_PROMPT) };
    const enqueue = (n = 0, enabled = true) => withTransaction(pool, (client) => enqueueCastDiscoveryWithClient(client, { scope, turnId: turnIds[n]!, execution, enabled }));
    return { scope, turnIds, enqueue, execution, versionId };
  }
  const emptyOutput = { version: 1 as const, characters: [] };
  it("rebases retained discovery checkpoints and fences leases across an idempotent rewind boundary", async () => {
    const f = await fixture(2);
    const retainedId = await f.enqueue(), discardedId = await f.enqueue(1);
    const repo = createCastDiscoveryJobRepository(pool, () => true), old = (await repo.claim("old"))!;
    await repo.checkpoint(old, proposal());
    const boundary = { turnNumber: 1, changeKey: "fixture-rewind" };
    await withTransaction(pool, (client) => applyCastBoundaryChange(client, f.scope, boundary));
    await withTransaction(pool, (client) => applyCastBoundaryChange(client, f.scope, boundary));
    expect(await repo.publish(old, applied)).toBe("lost_lease");
    expect(await repo.checkpoint(old, emptyOutput)).toBe(false);
    const next = (await repo.claim("new"))!;
    expect(next).toMatchObject({ id: retainedId, attempt: old.attempt, output: proposal(), source: { timelineRevision: 1 } });
    expect(await repo.publish(next)).toBe("complete");
    expect((await createPostgresCampaignCastRepository(pool).current(f.scope)).characters.find((p) => p.name === "Mara")?.profile)
      .toEqual({ "appearance.description": "blue eyes" });
    expect((await pool.query("SELECT status FROM campaign_cast_discovery_jobs WHERE id=$1", [discardedId])).rows[0].status).toBe("cancelled");
    expect(await repo.claim("idle")).toBeNull();
  });
  it("does not reset exhausted discovery attempts or failed admission at a retained history boundary", async () => {
    const f = await fixture(2);
    const first = await f.enqueue();
    await withTransaction(pool, (client) => enqueueCastDiscoveryWithClient(client, { scope: f.scope, turnId: f.turnIds[1]!, enabled: true, admissionUnavailable: true }));
    await pool.query("UPDATE campaign_cast_discovery_jobs SET attempt=2,status='failed',diagnostic_code='provider_failed' WHERE id=$1", [first]);
    await withTransaction(pool, (client) => applyCastBoundaryChange(client, f.scope, { turnNumber: 2, changeKey: "retained-boundary" }));
    expect((await pool.query("SELECT status,attempt,diagnostic_code,timeline_revision FROM campaign_cast_discovery_jobs WHERE campaign_id=$1 ORDER BY turn_number", [f.scope.campaignId])).rows)
      .toEqual([{ status: "failed", attempt: 2, diagnostic_code: "provider_failed", timeline_revision: 1 },
        { status: "failed", attempt: 0, diagnostic_code: "admission_unavailable", timeline_revision: 1 }]);
    expect(await createCastDiscoveryJobRepository(pool, () => true).claim("idle")).toBeNull();
  });
  it("requeues changed narration, cancels its pending candidates, and preserves another campaign", async () => {
    const f = await fixture(), other = await fixture();
    const priorId = await f.enqueue(), otherId = await other.enqueue();
    await pool.query("UPDATE campaign_cast_discovery_jobs SET status='complete' WHERE id=$1", [priorId]);
    await pool.query(`INSERT INTO campaign_cast_discovery_candidates(owner_user_id,campaign_id,job_id,chunk_ordinal,local_key,source,proposal,reason)
      SELECT owner_user_id,campaign_id,id,0,'mara',source,'{}','ambiguous' FROM campaign_cast_discovery_jobs WHERE id=$1`, [priorId]);
    await withTransaction(pool, async (client) => {
      await client.query(`INSERT INTO turn_narration_corrections(owner_user_id,campaign_id,turn_id,revision,narration,previous_effective_narration_hash,source,created_by_user_id)
        SELECT owner_user_id,campaign_id,turn_id,1,'Iven has green eyes.',source_hash,'user_edit',owner_user_id FROM campaign_cast_discovery_jobs WHERE id=$1`, [priorId]);
      await applyCastBoundaryChange(client, f.scope, { turnNumber: 1, changeKey: "fixture-correction" });
    });
    const rows = (await pool.query("SELECT id,status,narration_revision,timeline_revision,source FROM campaign_cast_discovery_jobs WHERE campaign_id=$1 ORDER BY created_at", [f.scope.campaignId])).rows;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ id: priorId, status: "cancelled" });
    expect(rows[1]).toMatchObject({ status: "queued", narration_revision: 1, timeline_revision: 1 });
    expect(rows[1].source.paragraphs.map((p: { text: string }) => p.text).join("")).toBe("Iven has green eyes.");
    expect((await pool.query("SELECT status FROM campaign_cast_discovery_candidates WHERE job_id=$1", [priorId])).rows[0].status).toBe("cancelled");
    expect((await pool.query("SELECT status,timeline_revision FROM campaign_cast_discovery_jobs WHERE id=$1", [otherId])).rows[0]).toEqual({ status: "queued", timeline_revision: 0 });
  });
  it.each(["preset", "model"] as const)("persists frozen %s admission and executes discovery through physical accounting into validated cast authority", async (routeKind) => {
    const f = await fixture();
    await pool.query("INSERT INTO provider_profiles(id,owner_user_id,name,provider_type,base_url) VALUES($1,$2,$3,'openrouter','https://fixture.invalid')",
      [f.execution.providerProfileId, ownerUserId, randomUUID()]);
    let calls = 0;
    const execution: RuntimeTextExecution = { id: f.execution.providerProfileId, name: "Fixture", providerRole: "text", providerType: "openrouter",
      model: "fixture", contextWindowTokens: 32768, maxOutputTokens: 2048, temperature: 0.2, requestTimeoutMs: 120000,
      configuration: {}, executionRevision: "revision", authorityRevision: "authority", endpointIdentity: "endpoint",
      textSelection: routeKind === "preset" ? { kind: "openrouter_preset", slug: "fixture" } : { kind: "model", modelId: "fixture" }, async execute(request, policy) {
        calls++;
        expect(request.preparedRequest?.body).toContain("Mara has blue eyes.");
        expect(request.preparedRequest?.body).toContain("infinite_quest_cast_discovery_v1");
        expect(policy?.requestTimeoutMs).toBe(30000);
        return { content: JSON.stringify(proposal()), responseId: "cast-runtime-fixture", finishReason: "stop", outputLimited: false,
          modelInstanceId: "fixture", usage: { inputTokens: 17, outputTokens: 19, totalTokens: 36 },
          reportedCost: { amount: "0.002", currency: "USD" }, rawMetadata: {} };
      } };
    const responseFormatCapabilities = createProviderResponseFormatCapabilities({ now: () => Date.parse("2026-09-20T00:00:00.000Z"), records: [{
      version: 2, providerType: "openrouter", endpointIdentity: "endpoint", model: "fixture", routeConfigHash: capabilityRouteConfigHash({}),
      adapterProtocol: "text-schema-adapter-v2", operation: "cast_discovery", schemaHash: getProviderOutputSchemaV2("cast_discovery").schemaHash,
      streaming: false, verifiedAt: "2026-09-19T00:00:00.000Z", expiresAt: "2027-09-19T00:00:00.000Z", providerRoutingSlugs: [], nativeOpenTrackerObjects: true
    }] });
    const frozen = await prepareCastDiscoveryExecution({ ownerUserId, execution, responseFormatCapabilities, ports: {
      async resolvePreset() { return { slug: "fixture", name: "Fixture", versionId: "v1", version: 1, configHash: "a".repeat(64),
        config: { model: "fixture" }, systemPrompt: "Frozen preset." }; },
      async discoverModels() { return [{ id: "fixture", contextWindowTokens: 32768, maxOutputTokens: 2048,
        responseFormatAdvertisement: { supportedParameters: ["response_format", "structured_outputs"], discoveredAt: "2026-09-20T00:00:00.000Z" } }]; }
    } });
    await expect(withTransaction(pool, (client) => enqueueCastDiscoveryWithClient(client, { scope: f.scope, turnId: f.turnIds[0]!,
      execution: { ...frozen, providerProfileId: randomUUID() }, enabled: true }))).rejects.toThrow("Invalid cast discovery provider binding");
    await expect(withTransaction(pool, (client) => enqueueCastDiscoveryWithClient(client, { scope: f.scope, turnId: f.turnIds[0]!,
      execution: { ...frozen, plan: deriveTextExecutionPlan(frozen.admission!.routeBasis, "Changed prompt and recomputed hash.") }, enabled: true }))).rejects.toThrow();
    await withTransaction(pool, (client) => enqueueCastDiscoveryWithClient(client, { scope: f.scope, turnId: f.turnIds[0]!, execution: frozen, enabled: true }));
    const executor = createPreparedTextExecutor({ attempts: createPostgresPreparedTextAttemptRepository(pool),
      async loadAuthority(owner, profile) { expect(owner).toBe(ownerUserId); expect(profile).toBe(execution.id); return execution; } });
    expect(await createWorkerCampaignCastApplication(pool, { castDiscoveryEnabled: false }, executor).runNext("disabled")).toBe(false);
    expect(calls).toBe(0);
    expect(await createWorkerCampaignCastApplication(pool, { castDiscoveryEnabled: true }, executor).runNext("runtime")).toBe(true);
    expect(calls).toBe(1);
    expect((await createPostgresCampaignCastRepository(pool).current(f.scope)).characters.find((p) => p.name === "Mara")?.profile)
      .toEqual({ "appearance.description": "blue eyes" });
    expect((await pool.query("SELECT operation FROM provider_cost_events WHERE campaign_id=$1", [f.scope.campaignId])).rows).toEqual([{ operation: "cast_discovery" }]);
  });
  it("accounts discovery calls under a live chunk lease and attributes cost once to its accepted turn", async () => {
    const f = await fixture();
    await pool.query("INSERT INTO provider_profiles(id,owner_user_id,name,provider_type,base_url) VALUES($1,$2,$3,'openrouter','https://fixture.invalid')",
      [f.execution.providerProfileId, ownerUserId, randomUUID()]);
    await f.enqueue();
    const jobs = createCastDiscoveryJobRepository(pool, () => true), claim = (await jobs.claim("accounting"))!;
    const accounting = createPostgresPreparedTextAttemptRepository(pool);
    const reservation = { kind: "cast_discovery" as const, ownerUserId, jobId: claim.id,
      chunkOrdinal: claim.chunkOrdinal, claimAttempt: claim.attempt, leaseToken: claim.leaseToken };
    const input = { logicalReservation: reservation, planProvenance: { planHash: f.execution.plan.planHash, preset: null },
      candidateOrdinal: 0, candidate: { modelId: "fixture", providerPolicy: {}, contextWindowTokens: 8000, maxOutputTokens: 2000 },
      request: { body: "{}", payloadHash: "a".repeat(64) } };
    const attempt = await accounting.reserve(input);
    expect(attempt).not.toBeNull();
    expect((await accounting.reserve(input))?.id).toBe(attempt!.id);
    for (const invalid of [{ leaseToken: randomUUID() }, { ownerUserId: randomUUID() }, { chunkOrdinal: 1 }, { claimAttempt: 2 }]) {
      expect(await accounting.markDispatched({ ...reservation, ...invalid }, attempt!.id, input.request.payloadHash)).toBeNull();
    }
    expect(await accounting.markDispatched(reservation, attempt!.id, input.request.payloadHash)).toMatchObject({ status: "dispatched" });
    const completion = { outcome: "succeeded" as const, providerResponseId: "cast-fixture", returnedModel: "fixture",
      returnedProviderRoute: null, emittedOutput: true, usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18 },
      reportedCost: { amount: "0.001", currency: "USD" } };
    expect(await accounting.complete(reservation, attempt!.id, completion)).toMatchObject({ status: "completed" });
    expect(await accounting.complete(reservation, attempt!.id, completion)).toBeNull();
    expect((await pool.query("SELECT campaign_id,turn_id,category,operation FROM provider_cost_events WHERE local_call_id=$1", [attempt!.id])).rows)
      .toEqual([{ campaign_id: f.scope.campaignId, turn_id: f.turnIds[0], category: "story", operation: "cast_discovery" }]);
    expect(await accounting.summarize({ kind: "job", ownerUserId, logicalKind: "cast_discovery", scopeId: claim.id }))
      .toMatchObject({ attemptCount: 1, completedCount: 1, observedUsage: completion.usage, reportedCosts: [completion.reportedCost] });
    await pool.query("UPDATE campaign_cast_discovery_jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [claim.id]);
    expect(await accounting.reserve({ ...input, candidateOrdinal: 1 })).toBeNull();
    const replacement = (await jobs.claim("replacement"))!;
    const retryReservation = { ...reservation, claimAttempt: replacement.attempt, leaseToken: replacement.leaseToken };
    expect(await accounting.reserve(input)).toBeNull();
    const retry = await accounting.reserve({ ...input, logicalReservation: retryReservation });
    expect(retry).not.toBeNull(); expect(retry!.id).not.toBe(attempt!.id);
    await pool.query("UPDATE campaign_cast_state SET timeline_revision=timeline_revision+1 WHERE campaign_id=$1", [f.scope.campaignId]);
    expect(await accounting.markDispatched(retryReservation, retry!.id, input.request.payloadHash)).toBeNull();
    await pool.query("UPDATE campaign_cast_state SET timeline_revision=timeline_revision-1 WHERE campaign_id=$1", [f.scope.campaignId]);
    await jobs.checkpoint(replacement, emptyOutput);
    expect(await accounting.markDispatched(retryReservation, retry!.id, input.request.payloadHash)).toBeNull();
  });
  const applied = async () => ({ characterIds: [], observationIds: [] });
  const proposal = (existingCharacterId: string | null = null) => ({ version: 1 as const, characters: [{ localKey: "mara", name: "Mara", aliases: [] as string[], existingCharacterId,
    identityEvidence: [{ paragraphId: "p1", quote: "Mara has blue eyes." }], observations: [{ field: "appearance.description" as const,
      value: "blue eyes", mode: "fact" as const, speakerCharacterId: null, paragraphId: "p1", quote: "Mara has blue eyes." }] }] });

  it("publishes validated sparse identities and evidence from the durable checkpoint", async () => {
    const f = await fixture(); await f.enqueue();
    const repo = createCastDiscoveryJobRepository(pool, () => true), job = (await repo.claim("a"))!;
    await repo.checkpoint(job, proposal());
    expect(await repo.publish(job)).toBe("complete");
    const cast = await createPostgresCampaignCastRepository(pool).current(f.scope);
    const mara = cast.characters.find((p) => p.name === "Mara")!;
    expect(mara).toMatchObject({ origin: { kind: "discovered" }, profile: { "appearance.description": "blue eyes" } });
    expect((await createPostgresCampaignCastRepository(pool).detail(f.scope, mara.id)).observations[0]?.evidence)
      .toMatchObject({ turnId: f.turnIds[0], narrationRevision: 0, quote: "Mara has blue eyes." });
  });
  it("recovers application publication from its durable response without repeating extraction or changing accepted narration", async () => {
    const f = await fixture(); await f.enqueue();
    const repository = createCastDiscoveryJobRepository(pool, () => true);
    let calls = 0;
    const extractor = { async extract() { calls++; return proposal(); } };
    expect(await runCastDiscoveryOnce({ workerId: "first", extractor,
      repository: { ...repository, async publish() { throw new Error("simulated publication interruption"); } } })).toBe("publication_failed");
    const saved = (await pool.query("SELECT id,checkpoint FROM campaign_cast_discovery_jobs WHERE campaign_id=$1", [f.scope.campaignId])).rows[0];
    expect(saved.checkpoint).toEqual(proposal());
    await pool.query("UPDATE campaign_cast_discovery_jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [saved.id]);
    expect(await runCastDiscoveryOnce({ workerId: "recovered", extractor, repository })).toBe("complete");
    expect(calls).toBe(1);
    expect((await createPostgresCampaignCastRepository(pool).current(f.scope)).characters.some((p) => p.name === "Mara")).toBe(true);
    expect((await pool.query("SELECT narration FROM turns WHERE campaign_id=$1", [f.scope.campaignId])).rows).toEqual([{ narration: "Mara has blue eyes." }]);
  });
  it("captures identities before extraction and preserves a later manual override", async () => {
    const f = await fixture(), editor = createPostgresCampaignCastRepository(pool, { editingEnabled: true });
    const created = await editor.create(f.scope, { expectedCastRevision: 0, expectedBoundary: { turnNumber: 1, timelineRevision: 0 },
      idempotencyKey: "manual-mara", name: "Mara", aliases: [], profile: { "appearance.description": "blue eyes" } });
    await f.enqueue();
    const repo = createCastDiscoveryJobRepository(pool, () => true), job = (await repo.claim("a"))!;
    expect(job.identities.characters.find((p) => p.id === created.character.id)?.profile).toEqual({ "appearance.description": "blue eyes" });
    await repo.checkpoint(job, proposal(created.character.id));
    await editor.edit(f.scope, created.character.id, { expectedCastRevision: created.revision, expectedCharacterRevision: created.character.revision,
      expectedBoundary: created.boundary, idempotencyKey: "manual-green", setOverrides: { "appearance.description": "green eyes" } });
    expect(await repo.publish(job)).toBe("complete");
    const detail = await editor.detail(f.scope, created.character.id);
    expect(detail.character.profile["appearance.description"]).toBe("green eyes");
    expect(detail.observations.map((o) => o.value)).toEqual(["blue eyes"]);
  });
  it("retains ambiguous identities for review and rejects forged evidence without creating characters", async () => {
    const f = await fixture(), editor = createPostgresCampaignCastRepository(pool, { editingEnabled: true });
    await editor.create(f.scope, { expectedCastRevision: 0, expectedBoundary: { turnNumber: 1, timelineRevision: 0 },
      idempotencyKey: "existing-mara", name: "Mara", aliases: [], profile: {} });
    await f.enqueue();
    const repo = createCastDiscoveryJobRepository(pool, () => true), job = (await repo.claim("a"))!;
    const output = proposal();
    output.characters.push({ ...output.characters[0]!, localKey: "forged", name: "Dara", identityEvidence: [{ paragraphId: "p1", quote: "Dara is here." }] });
    await repo.checkpoint(job, output);
    expect(await repo.publish(job)).toBe("complete");
    const pending = (await pool.query("SELECT reason,proposal FROM campaign_cast_discovery_candidates WHERE job_id=$1", [job.id])).rows;
    expect(pending).toHaveLength(1); expect(pending[0].reason).toBe("identity_needs_review");
    expect(pending[0].proposal.name).toBe("Mara");
    expect((await editor.current(f.scope)).characters).toHaveLength(2);
    const receipt = (await pool.query("SELECT validation_summary FROM campaign_cast_discovery_receipts WHERE job_id=$1", [job.id])).rows[0];
    expect(receipt.validation_summary).toMatchObject({ accepted: 0, unresolved: 1, rejected: [{ localKey: "forged", code: "quote_not_in_source" }] });
  });
  it("links a character from a pinned legacy world entity map", async () => {
    const f = await fixture(2), narration = "Mara is also known as the Watcher. Mara has blue eyes.";
    await pool.query("UPDATE world_versions SET content=$2 WHERE id=$1", [f.versionId, JSON.stringify({ entities: { mara: { name: "Mara", kind: "character", aliases: ["the Watcher"] } } })]);
    await pool.query("UPDATE turns SET narration=$2 WHERE id=ANY($1::uuid[])", [f.turnIds, narration]);
    await f.enqueue();
    const repo = createCastDiscoveryJobRepository(pool, () => true), job = (await repo.claim("a"))!;
    const output = proposal();
    output.characters[0]!.aliases = ["the Watcher"];
    output.characters[0]!.identityEvidence = [{ paragraphId: "p1", quote: narration }];
    await repo.checkpoint(job, output);
    expect(await repo.publish(job)).toBe("complete");
    const cast = await createPostgresCampaignCastRepository(pool).current(f.scope);
    const mara = cast.characters.find((p) => p.name === "Mara")!;
    expect(mara.origin).toEqual({ kind: "world", worldVersionId: f.versionId, entityId: "mara" });
    const editor = createPostgresCampaignCastRepository(pool, { editingEnabled: true });
    await editor.edit(f.scope, mara.id, { expectedCastRevision: cast.revision, expectedCharacterRevision: mara.revision,
      expectedBoundary: cast.boundary, idempotencyKey: "rename-world-person", name: "The Elder", aliases: [], pinned: true, ignored: true });
    await f.enqueue(1);
    const next = (await repo.claim("b"))!;
    await repo.checkpoint(next, output);
    expect(await repo.publish(next)).toBe("complete");
    const retained = await editor.current(f.scope);
    expect(retained.characters).toHaveLength(2);
    expect(retained.characters.find((p) => p.id === mara.id)).toMatchObject({ name: "The Elder", aliases: [], pinned: true, ignored: true });
  });
  it("holds a new same-name manual identity created after extraction began", async () => {
    const f = await fixture(); await f.enqueue();
    const repo = createCastDiscoveryJobRepository(pool, () => true), job = (await repo.claim("a"))!;
    await repo.checkpoint(job, proposal());
    const editor = createPostgresCampaignCastRepository(pool, { editingEnabled: true });
    await editor.create(f.scope, { expectedCastRevision: 0, expectedBoundary: { turnNumber: 1, timelineRevision: 0 },
      idempotencyKey: "late-mara", name: "Mara", aliases: [], profile: {} });
    expect(await repo.publish(job)).toBe("complete");
    expect((await editor.current(f.scope)).characters).toHaveLength(2);
    expect((await pool.query("SELECT reason FROM campaign_cast_discovery_candidates WHERE job_id=$1", [job.id])).rows).toEqual([{ reason: "identity_needs_review" }]);
  });
  it("rechecks alias collisions after each identity created in the same output", async () => {
    const f = await fixture(), quote = "Mara is known as the Watcher. The Watcher is known as Mara.";
    await pool.query("UPDATE turns SET narration=$2 WHERE id=$1", [f.turnIds[0], quote]); await f.enqueue();
    const repo = createCastDiscoveryJobRepository(pool, () => true), job = (await repo.claim("a"))!;
    await repo.checkpoint(job, { version: 1, characters: [
      { localKey: "mara", name: "Mara", aliases: ["the Watcher"], existingCharacterId: null, identityEvidence: [{ paragraphId: "p1", quote }], observations: [] },
      { localKey: "watcher", name: "the Watcher", aliases: ["Mara"], existingCharacterId: null, identityEvidence: [{ paragraphId: "p1", quote }], observations: [] }
    ] });
    expect(await repo.publish(job)).toBe("complete");
    expect((await createPostgresCampaignCastRepository(pool).current(f.scope)).characters).toHaveLength(2);
    expect((await pool.query("SELECT local_key FROM campaign_cast_discovery_candidates WHERE job_id=$1", [job.id])).rows).toEqual([{ local_key: "watcher" }]);
  });

  it("enqueues once in the caller transaction, freezes execution, and does nothing while disabled", async () => {
    const f = await fixture();
    expect(await f.enqueue(0, false)).toBeNull();
    const first = await f.enqueue();
    expect(await f.enqueue()).toBe(first);
    const row = (await pool.query("SELECT execution_snapshot FROM campaign_cast_discovery_jobs WHERE id=$1", [first])).rows[0];
    expect(row.execution_snapshot).toEqual(f.execution);
    await expect(withTransaction(pool, async (client) => {
      await enqueueCastDiscoveryWithClient(client, { scope: { ...f.scope, ownerUserId: randomUUID() }, turnId: f.turnIds[0]!, execution: f.execution, enabled: true });
    })).rejects.toThrow(/not found/i);
  });

  it("recovers a checkpoint with a new lease and publishes it exactly once", async () => {
    const f = await fixture(); await f.enqueue();
    const repo = createCastDiscoveryJobRepository(pool, () => true);
    const first = (await repo.claim("worker-a"))!;
    expect(first.scope).toEqual(f.scope);
    expect(await repo.checkpoint(first, emptyOutput)).toBe(true);
    await pool.query("UPDATE campaign_cast_discovery_jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [first.id]);
    const restarted = createCastDiscoveryJobRepository(pool, () => true);
    const second = (await restarted.claim("worker-b"))!;
    expect(second.output).toEqual(emptyOutput);
    expect(second.leaseToken).not.toBe(first.leaseToken);
    expect(await repo.checkpoint(first, emptyOutput)).toBe(false);
    expect(await repo.fail(first, "provider_timeout")).toBe(false);
    expect(await repo.publish(first, applied)).toBe("lost_lease");
    expect(await restarted.publish(second, applied)).toBe("complete");
    expect(await restarted.publish(second, applied)).toBe("lost_lease");
    expect((await pool.query("SELECT count(*)::int n FROM campaign_cast_discovery_receipts WHERE job_id=$1", [second.id])).rows[0].n).toBe(1);
    expect(await restarted.claim("worker-c")).toBeNull();
  });
  it("rolls back enqueue with the accepted-turn transaction", async () => {
    const f = await fixture();
    await expect(withTransaction(pool, async (client) => {
      await enqueueCastDiscoveryWithClient(client, { scope: f.scope, turnId: f.turnIds[0]!, execution: f.execution, enabled: true });
      throw new Error("acceptance rolled back");
    })).rejects.toThrow("acceptance rolled back");
    expect((await pool.query("SELECT count(*)::int n FROM campaign_cast_discovery_jobs WHERE campaign_id=$1", [f.scope.campaignId])).rows[0].n).toBe(0);
  });
  it("rejects a persisted chunk that no longer binds the job's accepted source", async () => {
    const f = await fixture(2), id = await f.enqueue();
    const row = (await pool.query("SELECT chunks FROM campaign_cast_discovery_jobs WHERE id=$1", [id])).rows[0];
    row.chunks[0].turnId = f.turnIds[1]; row.chunks[0].turnNumber = 2;
    await pool.query("UPDATE campaign_cast_discovery_jobs SET chunks=$2 WHERE id=$1", [id, JSON.stringify(row.chunks)]);
    await expect(createCastDiscoveryJobRepository(pool, () => true).claim("a")).rejects.toThrow(/source binding/i);
    expect((await pool.query("SELECT status FROM campaign_cast_discovery_jobs WHERE id=$1", [id])).rows[0].status).toBe("queued");
  });
  it("exhausts abandoned extraction leases without issuing a third attempt", async () => {
    const f = await fixture(2); await f.enqueue(0); await f.enqueue(1);
    const repo = createCastDiscoveryJobRepository(pool, () => true);
    for (const attempt of [1, 2]) {
      const job = (await repo.claim("worker"))!;
      expect(job.attempt).toBe(attempt);
      await pool.query("UPDATE campaign_cast_discovery_jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [job.id]);
    }
    expect(await repo.claim("worker")).toBeNull();
    const jobs = (await pool.query("SELECT status,attempt FROM campaign_cast_discovery_jobs WHERE campaign_id=$1 ORDER BY turn_number", [f.scope.campaignId])).rows;
    expect(jobs).toEqual([{ status: "failed", attempt: 2 }, { status: "queued", attempt: 0 }]);
  });

  it("serializes a campaign in source order and retains failed gaps", async () => {
    const f = await fixture(2); await f.enqueue(1); await f.enqueue(0);
    const repo = createCastDiscoveryJobRepository(pool, () => true);
    const claims = await Promise.all([repo.claim("a"), repo.claim("b")]);
    const first = claims.find(Boolean)!;
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(first.source.turnNumber).toBe(1);
    expect(await repo.fail(first, "provider_timeout")).toBe(true);
    expect(await repo.claim("a")).toBeNull();
    await pool.query("UPDATE campaign_cast_discovery_jobs SET available_at=clock_timestamp()-interval '1 second' WHERE id=$1", [first.id]);
    const retry = (await repo.claim("a"))!;
    expect(retry.attempt).toBe(2);
    await repo.fail(retry, "provider_timeout");
    expect(await repo.claim("a")).toBeNull();
    expect((await pool.query("SELECT status,diagnostic_code FROM campaign_cast_discovery_jobs WHERE id=$1", [first.id])).rows[0])
      .toEqual({ status: "failed", diagnostic_code: "provider_timeout" });
  });

  it("fences changed sources and disables claims and publication without losing checkpoints", async () => {
    const f = await fixture(); await f.enqueue();
    let enabled = true;
    const repo = createCastDiscoveryJobRepository(pool, () => enabled);
    const job = (await repo.claim("a"))!; await repo.checkpoint(job, emptyOutput);
    enabled = false;
    expect(await repo.claim("b")).toBeNull();
    expect(await repo.publish(job, applied)).toBe("disabled");
    enabled = true;
    await pool.query("UPDATE campaign_cast_state SET timeline_revision=timeline_revision+1 WHERE campaign_id=$1", [f.scope.campaignId]);
    expect(await repo.publish(job, applied)).toBe("stale_source");
    expect((await pool.query("SELECT status FROM campaign_cast_discovery_jobs WHERE id=$1", [job.id])).rows[0].status).toBe("cancelled");
  });
  it("defers publication through every active generation stage and retains the parsed output", async () => {
    const f = await fixture(); await f.enqueue();
    const provider = randomUUID();
    await pool.query(`INSERT INTO provider_profiles(id,owner_user_id,provider_role,name,base_url,default_model,provider_type)
      VALUES($1,$2,'text','Cast fixture','http://localhost:1234','fixture','lmstudio')`, [provider, ownerUserId]);
    const generation = (await pool.query(`INSERT INTO generation_jobs(owner_user_id,campaign_id,provider_profile_id,idempotency_key,expected_turn_number,action,status)
      VALUES($1,$2,$3,$4,2,'Continue','queued') RETURNING id`, [ownerUserId, f.scope.campaignId, provider, randomUUID()])).rows[0];
    const repo = createCastDiscoveryJobRepository(pool, () => true), job = (await repo.claim("a"))!;
    await repo.checkpoint(job, emptyOutput);
    for (const status of ["queued", "replacement_queued", "assessing", "generating", "validating", "committing", "recoverable"]) {
      await pool.query("UPDATE generation_jobs SET status=$2 WHERE id=$1", [generation.id, status]);
      expect(await repo.publish(job, applied), status).toBe("generation_active");
    }
    expect((await pool.query("SELECT checkpoint FROM campaign_cast_discovery_jobs WHERE id=$1", [job.id])).rows[0].checkpoint).toEqual(emptyOutput);
    await pool.query("UPDATE generation_jobs SET status='failed' WHERE id=$1", [generation.id]);
    expect(await repo.publish(job, applied)).toBe("complete");
  });
  it("rolls back publication and its receipt together, then resumes the retained checkpoint", async () => {
    const f = await fixture(); await f.enqueue();
    const repo = createCastDiscoveryJobRepository(pool, () => true), job = (await repo.claim("a"))!;
    await repo.checkpoint(job, emptyOutput);
    await expect(repo.publish(job, async (client) => {
      await client.query("UPDATE campaigns SET title='uncommitted publication' WHERE id=$1", [f.scope.campaignId]);
      throw new Error("synthetic apply failure");
    })).rejects.toThrow("synthetic apply failure");
    expect((await pool.query("SELECT title FROM campaigns WHERE id=$1", [f.scope.campaignId])).rows[0].title).toBe("Discovery fixture");
    expect((await pool.query("SELECT count(*)::int n FROM campaign_cast_discovery_receipts WHERE job_id=$1", [job.id])).rows[0].n).toBe(0);
    expect(await repo.publish(job, applied)).toBe("complete");
  });
  it("retains all source chunks and finishes only after the last atomic publication", async () => {
    const f = await fixture();
    const narration = "Mara waits by the bridge. ".repeat(900);
    await pool.query("UPDATE turns SET narration=$2 WHERE id=$1", [f.turnIds[0], narration]);
    await f.enqueue();
    const repo = createCastDiscoveryJobRepository(pool, () => true);
    let text = "", count = 0;
    for (let job = await repo.claim("a"); job; job = await repo.claim("a")) {
      text += job.source.paragraphs.map((p) => p.text).join(""); count++;
      await repo.checkpoint(job, emptyOutput);
      expect(await repo.publish(job, applied)).toBe(count === job.chunkCount ? "complete" : "next_chunk");
    }
    expect(count).toBeGreaterThan(1); expect(text).toBe(narration);
  });
  it("commits cast authority with the job receipt and rolls both back on failure", async () => {
    const f = await fixture(); await f.enqueue();
    const repo = createCastDiscoveryJobRepository(pool, () => true), job = (await repo.claim("a"))!;
    await repo.checkpoint(job, emptyOutput);
    const batch = { boundary: { turnNumber: 1, timelineRevision: 0 }, idempotencyKey: `discovery:${job.id}:0`,
      commands: [{ kind: "create" as const, name: "Mara", aliases: [], origin: { kind: "discovered" as const }, evidence: {
        kind: "turn" as const, turnId: job.source.turnId, turnNumber: 1, narrationRevision: 0, sourceHash: job.source.sourceHash,
        paragraphId: "p1", quote: "Mara has blue eyes." } }] };
    await expect(repo.publish(job, async (client) => {
      await applyCastBatchWithClient(client, f.scope, batch);
      throw new Error("abort after authority");
    })).rejects.toThrow("abort after authority");
    expect((await createPostgresCampaignCastRepository(pool).initialize(f.scope)).characters).toHaveLength(1);
    expect(await repo.publish(job, (client) => applyCastBatchWithClient(client, f.scope, batch))).toBe("complete");
    const cast = await createPostgresCampaignCastRepository(pool).initialize(f.scope);
    const person = cast.characters.find((p) => p.name === "Mara")!;
    const receipt = (await pool.query("SELECT character_ids FROM campaign_cast_discovery_receipts WHERE job_id=$1", [job.id])).rows[0];
    expect(receipt.character_ids).toEqual([person.id]);
    expect(cast.characters).toHaveLength(2);
  });
});
