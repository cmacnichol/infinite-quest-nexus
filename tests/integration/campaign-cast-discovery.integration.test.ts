import { randomUUID } from "node:crypto";
import { executePresetRoutes } from "../../packages/story-engine/src/preset-route-execution.js";
import Fastify from "fastify";
import { registerCampaignCastRoutes } from "../../services/api/src/campaign-cast-routes.js";
import { createCampaignCastApplication } from "../../packages/application/src/campaign-cast/use-cases.js";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDatabasePool, initialOwnerId, withTransaction, type DatabasePool } from "../../packages/database/src/pool.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { createCastDiscoveryJobRepository, enqueueCastDiscoveryWithClient } from "../../packages/database/src/campaign-cast-job-repository.js";
import { applyCastBatchWithClient, createPostgresCampaignCastRepository, captureCastGenerationSnapshotWithClient } from "../../packages/database/src/campaign-cast-repository.js";
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
import { createApiCampaignCastApplication, createWorkerCampaignCastApplication } from "../../services/runtime/src/campaign-cast-composition.js";
import { applyCastBoundaryChange } from "../../packages/database/src/campaign-cast-lifecycle.js";
import { exportCampaignCast, importCampaignCast } from "../../packages/database/src/campaign-cast-portability.js";

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
  async function fixture(count = 1, initialize = true) {
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
    if (initialize) await createPostgresCampaignCastRepository(pool).initialize(scope);
    const basis = { version: 2 as const, selection: { kind: "model" as const, modelId: "fixture" }, preset: null,
      candidates: [{ modelId: "fixture", providerPolicy: {}, contextWindowTokens: 8000, maxOutputTokens: 2000 }],
      presetSystemPrompt: "", parameters: {}, endpointReference: "fixture-endpoint", credentialReference: providerProfileId,
      profileRevision: "fixture", authorityRevision: "fixture", requestTimeoutMs: 30000, protocolVersion: "cast-discovery-v1", routeBasisHash: "0".repeat(64) };
    const execution = { providerProfileId, plan: deriveTextExecutionPlan({ ...basis, routeBasisHash: textExecutionRouteBasisHash(basis) }, CAST_DISCOVERY_SYSTEM_PROMPT) };
    const enqueue = (n = 0, enabled = true) => withTransaction(pool, (client) => enqueueCastDiscoveryWithClient(client, { scope, turnId: turnIds[n]!, execution, enabled }));
    return { scope, turnIds, enqueue, execution, versionId };
  }
  const emptyOutput = { version: 1 as const, characters: [] };
  it.each(["provider failure", "source race"])("leaves failed discovery intact on retry admission %s", async (mode) => {
    const f = await fixture();
    const id = (await withTransaction(pool, (client) => enqueueCastDiscoveryWithClient(client,
      { scope: f.scope, turnId: f.turnIds[0]!, enabled: true, admissionUnavailable: true })))!;
    const application = createApiCampaignCastApplication(pool, { castEditingEnabled: true, castDiscoveryEnabled: true }, {
      resolution: { async resolveDirect() { return { status: "resolved", providerProfileId: f.execution.providerProfileId }; } },
      execution: { async text() { return { id: f.execution.providerProfileId }; } },
      async prepareCastDiscoveryExecution() {
        if (mode === "provider failure") throw new Error("PRIVATE_PROVIDER_DIAGNOSTIC");
        await pool.query("UPDATE turns SET narration='Changed source.' WHERE id=$1", [f.turnIds[0]]);
        return f.execution;
      }
    } as never);
    await expect(application.retryDiscovery(f.scope, id, { expectedCastRevision: 0,
      expectedBoundary: { turnNumber: 1, timelineRevision: 0 }, idempotencyKey: "recovery" }))
      .rejects.toMatchObject({ code: mode === "provider failure" ? "cast_discovery_unavailable" : "cast_revision_conflict" });
    expect((await pool.query("SELECT status,retry_generation FROM campaign_cast_discovery_jobs WHERE id=$1", [id])).rows[0])
      .toEqual({ status: "failed", retry_generation: 0 });
    expect((await pool.query("SELECT count(*)::integer n FROM campaign_cast_discovery_retries WHERE job_id=$1", [id])).rows[0].n).toBe(0);
  });
  it("reprepares failed admission outside the retry transaction through the owner-bound API", async () => {
    const f = await fixture();
    const jobId = (await withTransaction(pool, (client) => enqueueCastDiscoveryWithClient(client,
      { scope: f.scope, turnId: f.turnIds[0]!, enabled: true, admissionUnavailable: true })))!;
    const single = createDatabasePool(process.env.TEST_DATABASE_URL!, 1);
    let preparations = 0;
    const providers = { resolution: { async resolveDirect(input: unknown) {
      expect(input).toMatchObject({ ownerUserId, providerRole: "text" }); return { status: "resolved", providerProfileId: f.execution.providerProfileId };
    } }, execution: { async text() { return { id: f.execution.providerProfileId }; } },
      async prepareCastDiscoveryExecution() { preparations++; await single.query("SELECT 1"); return f.execution; } };
    const app = Fastify();
    await app.register(registerCampaignCastRoutes, { application: createApiCampaignCastApplication(single,
      { castEditingEnabled: true, castDiscoveryEnabled: true }, providers as never), enabled: true, resolveOwner: async () => ({ ownerUserId }) });
    try {
      const url = `/api/v1/campaigns/${f.scope.campaignId}/cast/discovery/${jobId}/retry`;
      const payload = { expectedCastRevision: 0, expectedBoundary: { turnNumber: 1, timelineRevision: 0 }, idempotencyKey: "retry-http" };
      expect((await app.inject({ method: "POST", url, payload: { ...payload, ownerUserId: randomUUID() } })).statusCode).toBe(422);
      const response = await app.inject({ method: "POST", url, payload }); expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ jobId, retryGeneration: 1 });
      expect((await app.inject({ method: "POST", url, payload })).json()).toEqual(response.json());
      expect(preparations).toBe(1);
      expect((await createCastDiscoveryJobRepository(pool, () => true).claim("http-retry"))?.execution).toEqual(f.execution);
    } finally { await app.close(); await single.end(); }
  });
  it("preserves completed chunks and parsed output through an explicit retry", async () => {
    const f = await fixture();
    await pool.query("UPDATE turns SET narration=$2 WHERE id=$1", [f.turnIds[0], "Mara waits. ".repeat(2000)]);
    await f.enqueue();
    const jobs = createCastDiscoveryJobRepository(pool, () => true), first = (await jobs.claim("first"))!;
    await jobs.checkpoint(first, emptyOutput); expect(await jobs.publish(first)).toBe("next_chunk");
    const second = (await jobs.claim("second"))!; await jobs.checkpoint(second, emptyOutput);
    await pool.query("UPDATE campaign_cast_discovery_jobs SET status='failed',lease_token=NULL,lease_owner=NULL,lease_expires_at=NULL WHERE id=$1", [first.id]);
    const cast = await createPostgresCampaignCastRepository(pool).current(f.scope);
    await jobs.retryFailed(f.scope, first.id, { expectedCastRevision: cast.revision, expectedBoundary: cast.boundary, idempotencyKey: "retry-publication" });
    const retry = (await jobs.claim("recover"))!;
    expect(retry).toMatchObject({ chunkOrdinal: 1, output: emptyOutput, retryGeneration: 1, attempt: 0, identities: second.identities });
    expect((await pool.query("SELECT count(*)::integer n FROM campaign_cast_discovery_receipts WHERE job_id=$1", [first.id])).rows[0].n).toBe(1);
    expect(["next_chunk", "complete"]).toContain(await jobs.publish(retry));
    expect((await pool.query("SELECT count(*)::integer n FROM prepared_text_physical_attempts WHERE logical_reservation->>'jobId'=$1", [first.id])).rows[0].n).toBe(0);
  });
  it("fences disabled, foreign, stale and active-generation retries and requires prepared admission", async () => {
    const f = await fixture(), jobs = createCastDiscoveryJobRepository(pool, () => true);
    const id = (await withTransaction(pool, (client) => enqueueCastDiscoveryWithClient(client,
      { scope: f.scope, turnId: f.turnIds[0]!, enabled: true, admissionUnavailable: true })))!;
    const request = { expectedCastRevision: 0, expectedBoundary: { turnNumber: 1, timelineRevision: 0 }, idempotencyKey: "retry" };
    await expect(createCastDiscoveryJobRepository(pool, () => false).retryFailed(f.scope, id, request, f.execution)).rejects.toMatchObject({ code: "cast_discovery_disabled" });
    await expect(jobs.retryFailed({ ...f.scope, ownerUserId: randomUUID() }, id, request, f.execution)).rejects.toMatchObject({ code: "cast_not_found" });
    await expect(jobs.retryFailed(f.scope, id, { ...request, expectedCastRevision: 99 }, f.execution)).rejects.toMatchObject({ code: "cast_revision_conflict" });
    await expect(jobs.retryFailed(f.scope, id, request)).rejects.toMatchObject({ code: "cast_discovery_admission_required" });
    await pool.query("INSERT INTO provider_profiles(id,owner_user_id,name,provider_type,base_url) VALUES($1,$2,$3,'openrouter','https://fixture.invalid')",
      [f.execution.providerProfileId, ownerUserId, randomUUID()]);
    const generation = (await pool.query(`INSERT INTO generation_jobs(owner_user_id,campaign_id,provider_profile_id,idempotency_key,expected_turn_number,action,status)
      VALUES($1,$2,$3,$4,2,'Continue','queued') RETURNING id`, [ownerUserId, f.scope.campaignId, f.execution.providerProfileId, randomUUID()])).rows[0];
    await expect(jobs.retryFailed(f.scope, id, request, f.execution)).rejects.toMatchObject({ code: "cast_generation_active" });
    await pool.query("UPDATE generation_jobs SET status='failed' WHERE id=$1", [generation.id]);
    expect(await jobs.retryFailed(f.scope, id, request, f.execution)).toEqual({ jobId: id, retryGeneration: 1 });
    const recovered = (await jobs.claim("reprepared"))!; expect(recovered.execution).toEqual(f.execution);
    await pool.query("UPDATE turns SET narration='Changed narration.' WHERE id=$1", [f.turnIds[0]]);
    await expect(jobs.retryFailed(f.scope, id, request, f.execution)).rejects.toMatchObject({ code: "cast_revision_conflict" });
    expect((await pool.query("SELECT count(*)::integer n FROM campaign_cast_discovery_retries WHERE job_id=$1", [id])).rows[0].n).toBe(1);
  });
  it("retries failed discovery idempotently with a fresh paid-call allowance and retains prior accounting", async () => {
    const f = await fixture(); await f.enqueue();
    const jobs = createCastDiscoveryJobRepository(pool, () => true), first = (await jobs.claim("first"))!;
    const accounting = createPostgresPreparedTextAttemptRepository(pool);
    const reservation = { kind: "cast_discovery" as const, ownerUserId, jobId: first.id, chunkOrdinal: 0, claimAttempt: first.attempt, leaseToken: first.leaseToken };
    const input = { logicalReservation: reservation, planProvenance: { planHash: f.execution.plan.planHash, preset: null },
      candidateOrdinal: 0, candidate: { modelId: "fixture", providerPolicy: {}, contextWindowTokens: 8000, maxOutputTokens: 2000 }, request: { body: "{}", payloadHash: "a".repeat(64) } };
    for (const candidateOrdinal of [0, 1]) {
      const attempt = (await accounting.reserve({ ...input, candidateOrdinal }))!;
      expect(await accounting.markDispatched(reservation, attempt.id, input.request.payloadHash)).not.toBeNull();
    }
    await jobs.fail(first, "provider_failed");
    await pool.query("UPDATE campaign_cast_discovery_jobs SET available_at=clock_timestamp() WHERE id=$1", [first.id]);
    const second = (await jobs.claim("second"))!; await jobs.fail(second, "provider_failed");
    const request = { expectedCastRevision: 0, expectedBoundary: { turnNumber: 1, timelineRevision: 0 }, idempotencyKey: "explicit-retry" };
    const results = await Promise.all([jobs.retryFailed(f.scope, first.id, request), jobs.retryFailed(f.scope, first.id, request)]);
    expect(results[0]).toEqual({ jobId: first.id, retryGeneration: 1 }); expect(results[1]).toEqual(results[0]);
    const retried = (await jobs.claim("user-retry"))!;
    expect(retried).toMatchObject({ id: first.id, attempt: 1, chunkOrdinal: 0, retryGeneration: 1 });
    expect(await jobs.retryFailed(f.scope, first.id, request)).toEqual(results[0]);
    const nextReservation = { ...reservation, retryGeneration: 1, claimAttempt: retried.attempt, leaseToken: retried.leaseToken };
    const paid = (await accounting.reserve({ ...input, logicalReservation: nextReservation }))!;
    expect(paid).not.toBeNull();
    expect(await accounting.markDispatched(nextReservation, paid.id, input.request.payloadHash)).not.toBeNull();
    const secondPaid = (await accounting.reserve({ ...input, logicalReservation: nextReservation, candidateOrdinal: 1 }))!;
    expect(await accounting.markDispatched(nextReservation, secondPaid.id, input.request.payloadHash)).not.toBeNull();
    expect(await accounting.reserve({ ...input, logicalReservation: nextReservation, candidateOrdinal: 2 })).toBeNull();
    expect(await accounting.reserve(input)).toBeNull();
    expect((await pool.query("SELECT count(*)::integer n FROM prepared_text_physical_attempts WHERE logical_reservation->>'jobId'=$1 AND dispatched_at IS NOT NULL", [first.id])).rows[0].n).toBe(4);
    await expect(jobs.retryFailed(f.scope, first.id, { ...request, expectedCastRevision: 99 })).rejects.toMatchObject({ code: "cast_idempotency_conflict" });
    const migration = await readFile(resolve("database/migrations/0108_campaign_cast_discovery_retry.sql"), "utf8");
    await expect(withTransaction(pool, (client) => client.query(migration.split("-- Down Migration")[1]!))).rejects.toThrow(/Retain cast retry generations/);
  });
  it("captures pinned playable identities with fiction hints and preserves their world provenance", async () => {
    const f = await fixture();
    await pool.query("UPDATE world_versions SET content=$2 WHERE id=$1", [f.versionId, JSON.stringify({
      playableCharacters: [{ id: "mara-playable", name: "Mara", characterText: "Mara has blue eyes.",
        profile: { identity: { aliases: ["Watcher"] }, appearance: { eyes: "blue eyes" }, story: { role: "gatekeeper" }, secretExtension: "PRIVATE_MARKER" },
        rpgStats: [{ name: "Strength", value: 20 }], source: { private: "PRIVATE_MARKER" } }],
      entities: [{ id: "iven", kind: "npc", name: "Iven", description: "Iven is a ferryman." }]
    })]);
    await f.enqueue();
    const jobs = createCastDiscoveryJobRepository(pool, () => true), job = (await jobs.claim("world"))!;
    expect(job.identities.worldCharacters).toContainEqual(expect.objectContaining({ entityId: "mara-playable", name: "Mara", aliases: ["Watcher"], identityHints: expect.arrayContaining(["blue eyes"]) }));
    expect(job.identities.worldCharacters).toContainEqual(expect.objectContaining({ entityId: "iven", identityHints: ["Iven is a ferryman."] }));
    expect(JSON.stringify(job.identities)).not.toContain("PRIVATE_MARKER");
    expect(JSON.stringify(job.identities)).not.toContain("Strength");
    await jobs.checkpoint(job, proposal());
    expect(await jobs.publish(job)).toBe("complete");
    expect((await createPostgresCampaignCastRepository(pool).current(f.scope)).characters.find((person) => person.name === "Mara")?.origin)
      .toEqual({ kind: "world", worldVersionId: f.versionId, entityId: "mara-playable" });
  });
  it("stops actual fallback dispatch after two calls while allowing the next source chunk", async () => {
    const f = await fixture();
    await pool.query("UPDATE turns SET narration=$2 WHERE id=$1", [f.turnIds[0], "Mara waits by the bridge. ".repeat(900)]);
    await pool.query("INSERT INTO provider_profiles(id,owner_user_id,name,provider_type,base_url) VALUES($1,$2,$3,'openrouter','https://fixture.invalid')",
      [f.execution.providerProfileId, ownerUserId, randomUUID()]);
    await f.enqueue();
    const jobs = createCastDiscoveryJobRepository(pool, () => true), first = (await jobs.claim("routes"))!;
    const attempts = createPostgresPreparedTextAttemptRepository(pool);
    let calls = 0;
    const execute = (job: typeof first) => executePresetRoutes({
      candidates: [0, 1, 2].map((ordinal) => ({ modelId: `fixture-${ordinal}`, providerPolicy: {}, contextWindowTokens: 8000, maxOutputTokens: 2000 })),
      planProvenance: { planHash: f.execution.plan.planHash, preset: null },
      logicalReservation: { kind: "cast_discovery", ownerUserId, jobId: job.id, chunkOrdinal: job.chunkOrdinal, claimAttempt: job.attempt, leaseToken: job.leaseToken },
      attempts, prepareCandidate: () => ({ body: "{}", payloadHash: "a".repeat(64) }),
      invoke: async () => { calls++; throw { routeFailureReason: "provider_unavailable" }; },
      totalDeadlineMs: 30000, sleep: async () => undefined
    });
    await expect(execute(first)).rejects.toMatchObject({ code: "prepared_route_lease_lost" });
    expect(calls).toBe(2);
    await pool.query("UPDATE campaign_cast_discovery_jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [first.id]);
    const retry = (await jobs.claim("retry"))!;
    await expect(execute(retry)).rejects.toMatchObject({ code: "prepared_route_lease_lost" });
    expect(calls).toBe(2);
    // Publishing an already obtained checkpoint is unpaid and must remain recoverable.
    await jobs.checkpoint(retry, emptyOutput);
    expect(await jobs.publish(retry)).toBe("next_chunk");
    const next = (await jobs.claim("next"))!;
    expect(next.chunkOrdinal).toBe(1);
    await expect(execute(next)).rejects.toMatchObject({ code: "prepared_route_lease_lost" });
    expect(calls).toBe(4);
    expect((await pool.query("SELECT chunk, count(*)::integer n FROM (SELECT logical_reservation->>'chunkOrdinal' chunk FROM prepared_text_physical_attempts WHERE logical_reservation->>'jobId'=$1 AND dispatched_at IS NOT NULL AND status='completed') attempts GROUP BY chunk ORDER BY chunk", [first.id])).rows)
      .toEqual([{ chunk: "0", n: 2 }, { chunk: "1", n: 2 }]);
  });
  it("shares a two-dispatch chunk budget across fallback candidates and reclaimed logical attempts", async () => {
    const f = await fixture(); await f.enqueue();
    const jobs = createCastDiscoveryJobRepository(pool, () => true), first = (await jobs.claim("first"))!;
    const accounting = createPostgresPreparedTextAttemptRepository(pool);
    const reservation = { kind: "cast_discovery" as const, ownerUserId, jobId: first.id, chunkOrdinal: 0, claimAttempt: first.attempt, leaseToken: first.leaseToken };
    const input = { logicalReservation: reservation, planProvenance: { planHash: f.execution.plan.planHash, preset: null },
      candidateOrdinal: 0, candidate: { modelId: "fixture", providerPolicy: {}, contextWindowTokens: 8000, maxOutputTokens: 2000 },
      request: { body: "{}", payloadHash: "a".repeat(64) } };
    const reserved = await Promise.all([0, 1, 2].map((candidateOrdinal) => accounting.reserve({ ...input, candidateOrdinal })));
    expect(reserved.every(Boolean)).toBe(true);
    const dispatched = await Promise.all(reserved.map((attempt) => accounting.markDispatched(reservation, attempt!.id, input.request.payloadHash)));
    expect(dispatched.filter(Boolean)).toHaveLength(2);
    await pool.query("UPDATE campaign_cast_discovery_jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [first.id]);
    const retry = (await jobs.claim("retry"))!;
    expect(retry.attempt).toBe(2);
    const nextReservation = { ...reservation, claimAttempt: retry.attempt, leaseToken: retry.leaseToken };
    expect(await accounting.reserve({ ...input, logicalReservation: nextReservation })).toBeNull();
    expect((await pool.query("SELECT count(*)::integer n FROM prepared_text_physical_attempts WHERE logical_reservation->>'jobId'=$1 AND dispatched_at IS NOT NULL", [first.id])).rows[0].n).toBe(2);
  });
  it("records an automatically confirmed identity even when no profile fact changes", async () => {
    const f = await fixture(), editor = createPostgresCampaignCastRepository(pool, { editingEnabled: true });
    await pool.query("UPDATE campaigns SET active_turn_number=0 WHERE id=$1", [f.scope.campaignId]);
    const person = await editor.create(f.scope, { expectedCastRevision: 0, expectedBoundary: { turnNumber: 0, timelineRevision: 0 },
      idempotencyKey: "existing", name: "Mara", aliases: [], profile: { "appearance.description": "blue eyes" } });
    await pool.query("UPDATE campaigns SET active_turn_number=1 WHERE id=$1", [f.scope.campaignId]);
    await f.enqueue(); const jobs = createCastDiscoveryJobRepository(pool, () => true), job = (await jobs.claim("mention"))!;
    const candidate = proposal().characters[0]!;
    await jobs.checkpoint(job, { version: 1, characters: [{ ...candidate, existingCharacterId: person.character.id, observations: [] }] });
    expect(await jobs.publish(job)).toBe("complete");
    expect((await editor.current(f.scope)).characters.find((p) => p.id === person.character.id))
      .toMatchObject({ firstObservedTurn: 0, lastObservedTurn: 1, profile: { "appearance.description": "blue eyes" } });
  });
  it("lists and resolves pending identities through the owner-bound HTTP API", async () => {
    const f = await fixture(), editor = createPostgresCampaignCastRepository(pool, { editingEnabled: true });
    await editor.create(f.scope, { expectedCastRevision: 0, expectedBoundary: { turnNumber: 1, timelineRevision: 0 },
      idempotencyKey: "existing", name: "Mara", aliases: [], profile: {} });
    await f.enqueue(); const jobs = createCastDiscoveryJobRepository(pool, () => true), job = (await jobs.claim("http"))!;
    await jobs.checkpoint(job, proposal()); await jobs.publish(job);
    const app = Fastify();
    await app.register(registerCampaignCastRoutes, { application: createCampaignCastApplication(editor), enabled: true, resolveOwner: async () => ({ ownerUserId }) });
    try {
      const base = `/api/v1/campaigns/${f.scope.campaignId}/cast/candidates`;
      const response = await app.inject({ method: "GET", url: base }); expect(response.statusCode).toBe(200);
      const pending = response.json(), url = `${base}/${pending.candidates[0].id}/resolve`;
      const payload = { expectedCastRevision: pending.revision, expectedBoundary: pending.boundary, idempotencyKey: "http-resolve", action: "create" };
      expect((await app.inject({ method: "POST", url, payload: { ...payload, ownerUserId: randomUUID() } })).statusCode).toBe(422);
      const resolved = await app.inject({ method: "POST", url, payload }); expect(resolved.statusCode).toBe(200);
      expect(resolved.json().character.name).toBe("Mara");
      expect((await app.inject({ method: "POST", url, payload })).json()).toEqual(resolved.json());
      expect((await app.inject({ method: "GET", url: base })).json().candidates).toEqual([]);
    } finally { await app.close(); }
  });
  it.each(["attach", "create"] as const)("resolves a held identity by explicit %s with a replayable receipt and portable evidence", async (action) => {
    const f = await fixture(), editor = createPostgresCampaignCastRepository(pool, { editingEnabled: true });
    const existing = await editor.create(f.scope, { expectedCastRevision: 0, expectedBoundary: { turnNumber: 1, timelineRevision: 0 },
      idempotencyKey: "existing", name: "Mara", aliases: [], profile: { "appearance.description": "green eyes" } });
    await f.enqueue();
    const jobs = createCastDiscoveryJobRepository(pool, () => true), job = (await jobs.claim("held"))!;
    await jobs.checkpoint(job, proposal()); await jobs.publish(job);
    const pending = await editor.candidates(f.scope, {});
    expect(pending.candidates).toHaveLength(1);
    const candidateId = pending.candidates[0]!.id;
    const request = { expectedCastRevision: pending.revision, expectedBoundary: pending.boundary, idempotencyKey: "resolve-one",
      ...(action === "attach" ? { action, characterId: existing.character.id } : { action }) };
    const resolved = await editor.resolveCandidate(f.scope, candidateId, request);
    expect(resolved.character.id === existing.character.id).toBe(action === "attach");
    expect(resolved.character.profile["appearance.description"]).toBe(action === "attach" ? "green eyes" : "blue eyes");
    expect(await editor.resolveCandidate(f.scope, candidateId, request)).toEqual(resolved);
    expect((await editor.candidates(f.scope, {})).candidates).toEqual([]);
    await expect(editor.resolveCandidate(f.scope, candidateId, { ...request, expectedCastRevision: 999 })).rejects.toMatchObject({ code: "cast_idempotency_conflict" });
    const archive = await withTransaction(pool, (client) => exportCampaignCast(client, f.scope));
    expect(archive?.events.some((event) => event.commands.some((item) => item.command.kind === "mention"))).toBe(true);
    expect((await editor.detail(f.scope, resolved.character.id)).identityEvents.some((event) => event.evidence.kind === "turn")).toBe(true);
    expect((await pool.query("SELECT count(*)::integer n FROM campaign_cast_observations WHERE campaign_id=$1", [f.scope.campaignId])).rows[0].n).toBe(1);
  });
  it("preserves source-backed identity mentions through export and scoped import without inventing profile facts", async () => {
    const f = await fixture(2), destination = await fixture(2, false);
    const editor = createPostgresCampaignCastRepository(pool, { editingEnabled: true });
    await pool.query("UPDATE campaigns SET active_turn_number=0 WHERE id=$1", [f.scope.campaignId]);
    const person = await editor.create(f.scope, { expectedCastRevision: 0, expectedBoundary: { turnNumber: 0, timelineRevision: 0 },
      idempotencyKey: "manual", name: "Mara Reed", aliases: [], profile: {} });
    await pool.query("UPDATE campaigns SET active_turn_number=2 WHERE id=$1", [f.scope.campaignId]);
    await f.enqueue(1);
    const job = (await createCastDiscoveryJobRepository(pool, () => true).claim("mention"))!;
    const evidence = { kind: "turn" as const, turnId: job.source.turnId, turnNumber: 2, narrationRevision: 0,
      sourceHash: job.source.sourceHash, paragraphId: "p1", quote: "Mara has blue eyes." };
    await editor.applyBatch(f.scope, { boundary: { turnNumber: 2, timelineRevision: 0 }, idempotencyKey: "reviewed-mention",
      commands: [{ kind: "mention", characterId: person.character.id, evidence }] });
    const archive = await withTransaction(pool, (client) => exportCampaignCast(client, f.scope));
    expect(archive?.events.some((event) => event.commands.some((item) => item.command.kind === "mention"))).toBe(true);
    await withTransaction(pool, (client) => importCampaignCast(client, destination.scope, archive,
      { turns: new Map(f.turnIds.map((id, index) => [id, destination.turnIds[index]!])), worlds: new Map() }));
    const imported = (await editor.current(destination.scope)).characters.find((p) => p.name === "Mara Reed")!;
    expect(imported).toMatchObject({ profile: {}, firstObservedTurn: 0, lastObservedTurn: 2 });
    expect(imported.id).not.toBe(person.character.id);
    const source = (await pool.query("SELECT payload FROM campaign_cast_events WHERE campaign_id=$1 ORDER BY sequence DESC LIMIT 1", [destination.scope.campaignId])).rows[0].payload[0].command.evidence;
    expect(source.turnId).toBe(destination.turnIds[1]);
    await pool.query("UPDATE turns SET narration='Iven waits.' WHERE id=$1", [destination.turnIds[1]]);
    expect((await editor.current(destination.scope)).characters.find((p) => p.id === imported.id)?.lastObservedTurn).toBe(0);
    await pool.query("DELETE FROM turns WHERE id=$1", [f.turnIds[1]]);
    const replacementId = randomUUID();
    await pool.query("INSERT INTO turns(id,owner_user_id,campaign_id,turn_number,narration) VALUES($1,$2,$3,2,'Iven waits.')", [replacementId, ownerUserId, f.scope.campaignId]);
    const replacedArchive = await withTransaction(pool, (client) => exportCampaignCast(client, f.scope));
    const afterReplacement = await fixture(2, false);
    await withTransaction(pool, (client) => importCampaignCast(client, afterReplacement.scope, replacedArchive,
      { turns: new Map([[f.turnIds[0]!, afterReplacement.turnIds[0]!], [replacementId, afterReplacement.turnIds[1]!]]), worlds: new Map() }));
    expect((await editor.current(afterReplacement.scope)).characters.find((p) => p.name === "Mara Reed"))
      .toMatchObject({ firstObservedTurn: 0, lastObservedTurn: 0, profile: {} });
  });
  it("rejects disabled, foreign, stale, active-generation and unsupported candidate resolutions without partial writes", async () => {
    const f = await fixture(), editor = createPostgresCampaignCastRepository(pool, { editingEnabled: true });
    await editor.create(f.scope, { expectedCastRevision: 0, expectedBoundary: { turnNumber: 1, timelineRevision: 0 },
      idempotencyKey: "existing", name: "Mara", aliases: [], profile: {} });
    await f.enqueue(); const jobs = createCastDiscoveryJobRepository(pool, () => true), job = (await jobs.claim("held"))!;
    await jobs.checkpoint(job, proposal()); await jobs.publish(job);
    const pending = await editor.candidates(f.scope, {}), id = pending.candidates[0]!.id;
    const request = { action: "create" as const, expectedCastRevision: pending.revision, expectedBoundary: pending.boundary, idempotencyKey: "guarded" };
    await expect(createPostgresCampaignCastRepository(pool).resolveCandidate(f.scope, id, request)).rejects.toMatchObject({ code: "cast_editing_disabled" });
    await expect(editor.resolveCandidate({ ...f.scope, ownerUserId: randomUUID() }, id, request)).rejects.toMatchObject({ code: "cast_not_found" });
    await expect(editor.resolveCandidate(f.scope, id, { ...request, expectedCastRevision: 999 })).rejects.toMatchObject({ code: "cast_revision_conflict" });
    await expect(editor.resolveCandidate(f.scope, id, { ...request, action: "attach", characterId: randomUUID() })).rejects.toMatchObject({ code: "cast_invalid_request" });
    const profile = randomUUID();
    await pool.query("INSERT INTO provider_profiles(id,owner_user_id,name,provider_type,base_url) VALUES($1,$2,'Fixture','openrouter','https://fixture.invalid')", [profile, ownerUserId]);
    const generation = (await pool.query(`INSERT INTO generation_jobs(owner_user_id,campaign_id,provider_profile_id,idempotency_key,expected_turn_number,action,status)
      VALUES($1,$2,$3,$4,2,'Continue','queued') RETURNING id`, [ownerUserId, f.scope.campaignId, profile, randomUUID()])).rows[0];
    await expect(editor.resolveCandidate(f.scope, id, request)).rejects.toMatchObject({ code: "cast_generation_active" });
    await pool.query("UPDATE generation_jobs SET status='failed' WHERE id=$1", [generation.id]);
    const malformed = proposal().characters[0]!;
    malformed.observations[0]!.value = "invented purple eyes";
    await pool.query("UPDATE campaign_cast_discovery_candidates SET proposal=$2 WHERE id=$1", [id, JSON.stringify(malformed)]);
    await expect(editor.resolveCandidate(f.scope, id, request)).rejects.toMatchObject({ code: "cast_invalid_request" });
    expect((await editor.current(f.scope)).revision).toBe(pending.revision);
    expect((await pool.query("SELECT status,resolution_receipt FROM campaign_cast_discovery_candidates WHERE id=$1", [id])).rows[0])
      .toEqual({ status: "pending", resolution_receipt: null });
    await withTransaction(pool, async (client) => {
      await client.query("UPDATE turns SET narration='Iven waits.' WHERE id=$1", [f.turnIds[0]]);
      await applyCastBoundaryChange(client, f.scope, { turnNumber: 1, changeKey: "candidate-correction" });
    });
    await expect(editor.resolveCandidate(f.scope, id, request)).rejects.toMatchObject({ code: "cast_revision_conflict" });
    expect((await editor.candidates(f.scope, {})).candidates).toEqual([]);
  });
  it("backfills forward enrollment when upgrading an existing discovery database", async () => {
    const f = await fixture(3), untracked = await fixture();
    await f.enqueue(1); const discarded = await f.enqueue(2);
    await pool.query("UPDATE campaign_cast_discovery_jobs SET status='cancelled' WHERE id=$1", [discarded]);
    const migration = await readFile(resolve("database/migrations/0107_campaign_cast_coverage.sql"), "utf8");
    await withTransaction(pool, async (client) => {
      await client.query(migration.split("-- Down Migration")[1]!);
      await client.query(migration.split("-- Down Migration")[0]!);
    });
    expect(await createPostgresCampaignCastRepository(pool, { discoveryEnabled: true }).discoveryStatus(f.scope))
      .toMatchObject({ coverageStartTurn: 2, trackedThroughTurn: 1 });
    expect(await createPostgresCampaignCastRepository(pool).discoveryStatus(untracked.scope)).toMatchObject({ coverageStartTurn: null });
  });
  it("withdraws completed coverage after correction and clears enrollment when rewound before its start", async () => {
    const f = await fixture(2); await f.enqueue(1);
    const repo = createCastDiscoveryJobRepository(pool, () => true), job = (await repo.claim("coverage"))!;
    await repo.checkpoint(job, emptyOutput); await repo.publish(job, applied);
    const cast = createPostgresCampaignCastRepository(pool, { discoveryEnabled: true });
    expect(await cast.discoveryStatus(f.scope)).toMatchObject({ state: "complete", coverageStartTurn: 2, trackedThroughTurn: 2 });
    await withTransaction(pool, async (client) => {
      await client.query(`INSERT INTO turn_narration_corrections(owner_user_id,campaign_id,turn_id,revision,narration,previous_effective_narration_hash,source,created_by_user_id)
        SELECT owner_user_id,campaign_id,turn_id,1,'Iven has green eyes.',source_hash,'user_edit',owner_user_id FROM campaign_cast_discovery_jobs WHERE id=$1`, [job.id]);
      await applyCastBoundaryChange(client, f.scope, { turnNumber: 2, changeKey: "coverage-correction" });
    });
    expect(await cast.discoveryStatus(f.scope)).toMatchObject({ state: "catching_up", coverageStartTurn: 2, trackedThroughTurn: 1 });
    await withTransaction(pool, async (client) => {
      await applyCastBoundaryChange(client, f.scope, { turnNumber: 1, changeKey: "coverage-rewind" });
      await client.query("UPDATE campaigns SET active_turn_number=1 WHERE id=$1", [f.scope.campaignId]);
    });
    expect(await cast.discoveryStatus(f.scope)).toMatchObject({ state: "not_enrolled", coverageStartTurn: null, trackedThroughTurn: null });
  });
  it("reports forward-only contiguous coverage, failed gaps, and unresolved review separately", async () => {
    const f = await fixture(4);
    const cast = createPostgresCampaignCastRepository(pool, { discoveryEnabled: true });
    expect(await cast.discoveryStatus(f.scope)).toMatchObject({ state: "not_enrolled", coverageStartTurn: null, trackedThroughTurn: null });
    const start = await f.enqueue(1);
    const repo = createCastDiscoveryJobRepository(pool, () => true), first = (await repo.claim("coverage"))!;
    await repo.checkpoint(first, emptyOutput); await repo.publish(first, applied);
    await f.enqueue(3);
    expect(await cast.discoveryStatus(f.scope)).toMatchObject({ state: "catching_up", coverageStartTurn: 2, trackedThroughTurn: 2,
      activeTurnNumber: 4, firstGap: { turnNumber: 3, jobId: null, status: "missing" }, unresolvedCount: 0 });
    const failed = await withTransaction(pool, (client) => enqueueCastDiscoveryWithClient(client,
      { scope: f.scope, turnId: f.turnIds[2]!, enabled: true, admissionUnavailable: true }));
    expect(await cast.discoveryStatus(f.scope)).toMatchObject({ state: "failed", trackedThroughTurn: 2,
      firstGap: { jobId: failed, status: "failed", diagnosticCode: "admission_unavailable" } });
    const captured = await withTransaction(pool, (client) => captureCastGenerationSnapshotWithClient(client, f.scope, { discoveryEnabled: true }));
    expect(captured.snapshot).toMatchObject({ coverageStartTurn: 2, trackedThroughTurn: 2, discoveryStatus: "failed", boundary: { turnNumber: 4 } });
    const retained = await withTransaction(pool, (client) => captureCastGenerationSnapshotWithClient(client, f.scope,
      { discoveryEnabled: true, boundary: { turnNumber: 2, timelineRevision: 0 } }));
    expect(retained.snapshot).toMatchObject({ coverageStartTurn: 2, trackedThroughTurn: 2, discoveryStatus: "current" });
    await pool.query(`INSERT INTO campaign_cast_discovery_candidates(owner_user_id,campaign_id,job_id,chunk_ordinal,local_key,source,proposal,reason)
      SELECT owner_user_id,campaign_id,id,0,'mara',source,'{}','ambiguous' FROM campaign_cast_discovery_jobs WHERE id=$1`, [start]);
    expect(await cast.discoveryStatus(f.scope)).toMatchObject({ trackedThroughTurn: 2, unresolvedCount: 1 });
    expect(await createPostgresCampaignCastRepository(pool).discoveryStatus(f.scope)).toMatchObject({ enabled: false, state: "disabled", trackedThroughTurn: 2 });
    await expect(cast.discoveryStatus({ ...f.scope, ownerUserId: randomUUID() })).rejects.toMatchObject({ code: "cast_not_found" });
  });
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
  it.each([
    { routeKind: "preset", outcome: "success" }, { routeKind: "model", outcome: "success" },
    { routeKind: "model", outcome: "timeout" }, { routeKind: "model", outcome: "malformed" }
  ] as const)("executes frozen $routeKind discovery with $outcome through physical accounting", async ({ routeKind, outcome }) => {
    const f = await fixture();
    const acceptedBefore = (await pool.query("SELECT id,narration,accepted_at FROM turns WHERE campaign_id=$1 ORDER BY turn_number", [f.scope.campaignId])).rows;
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
        if (outcome === "timeout") throw Object.assign(new Error("Deterministic provider deadline"), { routeFailureReason: "deadline" });
        return { content: outcome === "malformed" ? "{incomplete" : JSON.stringify(proposal()), responseId: "cast-runtime-fixture", finishReason: "stop", outputLimited: false,
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
    const worker = createWorkerCampaignCastApplication(pool, { castDiscoveryEnabled: true }, executor);
    const extractionStarted = performance.now();
    expect(await worker.runNext("runtime")).toBe(outcome === "success");
    if (process.env.CAST_TEST_TIMINGS === "true") process.stdout.write(JSON.stringify({ measurement: "discovery_worker_tick", routeKind, outcome,
      elapsedMs: performance.now() - extractionStarted, discoveryProviderCalls: calls, narrationProviderCalls: 0,
      fixture: "deterministic_local_postgres" }) + "\n");
    expect(calls).toBe(1);
    if (outcome !== "success") {
      const diagnostic = outcome === "timeout" ? "provider_timeout" : "invalid_output";
      expect((await pool.query("SELECT status,diagnostic_code,checkpoint FROM campaign_cast_discovery_jobs WHERE campaign_id=$1", [f.scope.campaignId])).rows)
        .toEqual([{ status: "retry_wait", diagnostic_code: diagnostic, checkpoint: null }]);
      await pool.query("UPDATE campaign_cast_discovery_jobs SET available_at=clock_timestamp() WHERE campaign_id=$1", [f.scope.campaignId]);
      expect(await worker.runNext("retry")).toBe(false);
      expect(await worker.runNext("exhausted")).toBe(false);
      expect(calls).toBe(2);
      expect((await pool.query("SELECT status,diagnostic_code FROM campaign_cast_discovery_jobs WHERE campaign_id=$1", [f.scope.campaignId])).rows)
        .toEqual([{ status: "failed", diagnostic_code: diagnostic }]);
      expect((await pool.query("SELECT id,narration,accepted_at FROM turns WHERE campaign_id=$1 ORDER BY turn_number", [f.scope.campaignId])).rows).toEqual(acceptedBefore);
      expect((await createPostgresCampaignCastRepository(pool).current(f.scope)).characters.some((p) => p.name === "Mara")).toBe(false);
      return;
    }
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
