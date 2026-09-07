import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { authoringRuntimeFixture, deferred } from "../helpers/authoring-runtime.js";
import { runWorker } from "../../services/worker/src/worker.js";
import { runRuntimeLifecycle } from "../../services/runtime/src/lifecycle.js";
import { inertWorkerIllustration, inertWorkerMemory } from "../helpers/memory-applications.js";
import { authoringSubmitSchema, playableCharacterSchema, worldContentSchema } from "../../packages/contracts/src/index.js";
import { createAuthoringApplication } from "../../packages/application/src/authoring/use-cases.js";
import { createAuthoringWorkerApplication } from "../../packages/application/src/authoring/worker.js";
import type { AuthoringClaim } from "../../packages/application/src/authoring/ports.js";
import { createPostgresAuthoringRepository, createPostgresAuthoringTargetPort } from "../../packages/database/src/authoring-job-repository.js";
import { createDatabasePool, initialOwnerId, type DatabasePool } from "../../packages/database/src/pool.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { logger } from "../../packages/logger/src/index.js";
import { CHARACTER_AUTHORING_PROMPT_PROTOCOL_VERSION, WORLD_AUTHORING_PROMPT_PROTOCOL_VERSION } from "../../packages/domain/src/authoring-prompts.js";
import { AuthoringResponseError } from "../../services/runtime/src/authoring-response-adapter.js";
import { createRuntimeAuthoringWorkerApplication } from "../../services/runtime/src/authoring-composition.js";
import { createAuthoringExecutionSnapshot, createRuntimeAuthoringStageDispatcher, executeAuthoringStage } from "../../services/runtime/src/authoring-stage-adapter.js";
import type { RuntimeProviderExecutionPort, RuntimeTextExecution } from "../../services/runtime/src/provider-credential-transport-adapter.js";
import type { ProviderRequest, ProviderResult } from "../../packages/story-engine/src/providers.js";
import { ProviderHttpError } from "../../packages/story-engine/src/providers.js";
import { assembleGeneratedWorld } from "../../services/runtime/src/provider-world-generation-adapter.js";
import fixture from "../fixtures/authoring/reliability.json" with { type: "json" };

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const integration = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const result = (content: string): ProviderResult => ({ content, responseId: "synthetic", finishReason: "stop", outputLimited: false, modelInstanceId: "synthetic", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, reportedCost: null, rawMetadata: {} });

integration("durable authoring real repository and stage dispatcher", () => {
  let pool: DatabasePool;
  let ownerUserId: string;
  beforeAll(async () => {
    pool = createDatabasePool(process.env.TEST_DATABASE_URL!, 8);
    await migrateDatabase(pool, resolve("database/migrations"));
    ownerUserId = await initialOwnerId(pool);
  });
  afterEach(async () => {
    await pool.query("DELETE FROM authoring_jobs WHERE owner_user_id = $1", [ownerUserId]);
    await pool.query("DELETE FROM worlds WHERE owner_user_id = $1", [ownerUserId]);
  });
  afterAll(async () => { await pool?.end(); });

  function runtime(execute: (request: ProviderRequest) => Promise<ProviderResult>) {
    const provider: RuntimeTextExecution = { id: randomUUID(), name: "Synthetic", providerRole: "text", providerType: "lmstudio", model: "pinned-model", contextWindowTokens: 32768, maxOutputTokens: 4096, temperature: 0.7, requestTimeoutMs: 30000, endpointIdentity: "opaque-endpoint", configuration: {}, execute };
    const snapshot = createAuthoringExecutionSnapshot(provider, { world_generation: "Pinned world prompt.", character_generation: "Pinned character prompt.", world_character_generation: "Pinned seed prompt." }, { world: WORLD_AUTHORING_PROMPT_PROTOCOL_VERSION, character: CHARACTER_AUTHORING_PROMPT_PROTOCOL_VERSION }, sha256);
    const loads: string[] = [];
    const execution: RuntimeProviderExecutionPort = {
      text: async (_scope, id, _role, model) => { loads.push(id); expect(id).toBe(provider.id); expect(model).toBe(provider.model); return provider; },
      embedding: async () => { throw new Error("not used"); }, image: async () => { throw new Error("not used"); }
    };
    return { snapshot, loads, dispatch: createRuntimeAuthoringStageDispatcher({ execution, sha256 }) };
  }

  it.each(["heartbeat false", "heartbeat error", "shutdown"])("leaves a real job resumable after %s, drains and resumes its pinned snapshot after expiry", async (mode) => {
    const repository = createPostgresAuthoringRepository(pool);
    const started = deferred<void>();
    const finish = deferred<ProviderResult>();
    const lost = deferred<void>();
    const events: string[] = [];
    const executeA = vi.fn(async () => { events.push("provider:start"); started.resolve(); const output = await finish.promise; events.push("provider:end"); return output; });
    const runtimeA = authoringRuntimeFixture(executeA);
    const job = await repository.submit({ ownerUserId }, runtimeA.input, sha256(JSON.stringify(runtimeA.input)));
    const controller = new AbortController();
    const removeListener = vi.spyOn(controller.signal, "removeEventListener");
    const claim = vi.fn(repository.claim);
    const heartbeat = vi.fn(async () => {
      await started.promise;
      lost.resolve();
      if (mode === "heartbeat error") throw new Error("synthetic heartbeat failure");
      return false;
    });
    const workerA = createRuntimeAuthoringWorkerApplication({ repository: { ...repository, claim, heartbeat }, providers: runtimeA.providers, sha256, signal: controller.signal, heartbeatMilliseconds: mode === "shutdown" ? 10000 : 10 });
    let closed = false;
    const running = mode === "shutdown"
      ? runRuntimeLifecycle({ role: "worker" } as never, controller, {
        createPool: () => ({ end: async () => { closed = true; events.push("pool:close"); } }) as never,
        createTransport: () => ({ close: async () => { events.push("transport:close"); } }) as never,
        configureTransport: () => undefined,
        createGenerationEvents: () => { throw new Error("worker has no event listener"); },
        dispatchRole: async () => runWorker(pool, { workerGenerationConcurrency: 1, workerLeaseSeconds: 30, workerPollIntervalMs: 5, aiAuthoringJobsEnabled: true } as never, controller.signal, {
          generation: { claimNext: async () => null, executeClaimed: async () => false },
          illustration: inertWorkerIllustration, memory: inertWorkerMemory,
          optionalLanes: { illustration: async () => false, chronicle: async () => false, asset: async () => false, authoring: () => workerA.runNext({ workerId: "worker-a", leaseSeconds: 30 }) }
        })
      })
      : workerA.runNext({ workerId: "worker-a", leaseSeconds: 30 });
    await started.promise;
    if (mode === "shutdown") controller.abort();
    else await lost.promise;
    expect(closed).toBe(false);
    const currentClaim = (await claim.mock.results[0]!.value)!;
    // This checks the real database fence is still valid, independent of local loss.
    expect(await repository.loadClaim(currentClaim)).not.toBeNull();
    const originalSnapshot = (await repository.loadClaim(currentClaim))!.snapshot;
    finish.resolve(result(fixture.malformed));
    await running;
    expect(executeA).toHaveBeenCalledTimes(1);
    expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
    const stranded = (await repository.read({ ownerUserId }, job.id))!;
    expect(stranded.status).toBe("running");
    expect(stranded.stages[0]).toMatchObject({ status: "running" });
    expect((await pool.query("SELECT output, failure FROM authoring_job_stages WHERE id = $1", [currentClaim.stageId])).rows[0]).toEqual({ output: null, failure: null });
    if (mode === "shutdown") {
      expect(events).toEqual(["provider:start", "provider:end", "transport:close", "pool:close"]);
      await expect(workerA.runNext({ workerId: "stopped", leaseSeconds: 30 })).resolves.toBe(false);
      expect(claim).toHaveBeenCalledTimes(1);
    }
    await pool.query("UPDATE authoring_job_stages SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE id = $1", [currentClaim.stageId]);
    const executeB = vi.fn(async (request: ProviderRequest) => { expect(request.systemPrompt).toContain("Pinned character prompt."); return result(JSON.stringify(fixture.character)); });
    const runtimeB = authoringRuntimeFixture(executeB);
    const changedDefault = vi.fn(async () => { throw new Error("Changed default must not be resolved on recovery"); });
    const changedPrompts = vi.fn(async () => { throw new Error("Changed prompts must not be resolved on recovery"); });
    const providerLoad = vi.fn(runtimeB.providers.execution.text);
    const workerB = createRuntimeAuthoringWorkerApplication({ repository, providers: { ...runtimeB.providers, resolution: { ...runtimeB.providers.resolution, resolveDirect: changedDefault }, prompts: { ...runtimeB.providers.prompts, loadWorldGenerationPromptSnapshot: changedPrompts }, execution: { ...runtimeB.providers.execution, text: providerLoad } }, sha256 });
    await expect(workerB.runNext({ workerId: "worker-b", leaseSeconds: 30 })).resolves.toBe(true);
    expect(changedDefault).not.toHaveBeenCalled();
    expect(changedPrompts).not.toHaveBeenCalled();
    expect(providerLoad).toHaveBeenCalledWith({ ownerUserId }, originalSnapshot.providerProfileId, "text", originalSnapshot.model);
    expect(executeB).toHaveBeenCalledTimes(1);
    expect((await repository.read({ ownerUserId }, job.id))!.status).toBe("awaiting_review");
    await expect(repository.loadClaim(currentClaim)).resolves.toBeNull();
  });

  it.each(["new standalone", "existing-world addition", "canonical existing edit", "local-parent edit"] as const)("preserves %s identity through submit, replay, claim recovery and explicit retry", async (mode) => {
    const repository = createPostgresAuthoringRepository(pool);
    const application = createAuthoringApplication({ repository, targets: createPostgresAuthoringTargetPort(pool), worlds: {} as never, sha256 });
    const edit = mode.endsWith("edit");
    const content = worldContentSchema.parse({ world: { title: "Identity fixture" }, playableCharacters: edit ? [playableCharacterSchema.parse({ ...fixture.character, id: "existing-hero" })] : [] });
    let target: { kind: "new_world" } | { kind: "world_draft"; worldId: string; expectedRevision: number } = { kind: "new_world" };
    if (mode.startsWith("existing-world") || mode.startsWith("canonical")) {
      const world = await pool.query<{ id: string }>("INSERT INTO worlds (owner_user_id, title, status) VALUES ($1, 'Identity fixture', 'draft') RETURNING id", [ownerUserId]);
      const worldId = world.rows[0]!.id;
      await pool.query("INSERT INTO world_drafts (world_id, owner_user_id, revision, content) VALUES ($1, $2, 1, $3::jsonb)", [worldId, ownerUserId, JSON.stringify(content)]);
      target = { kind: "world_draft", worldId, expectedRevision: 1 };
    }
    const request = authoringSubmitSchema.parse({ kind: "character", idempotencyKey: randomUUID(), target, content, prompt: "Create a cartographer.", ...(edit ? { characterId: "existing-hero" } : {}) });
    const submitted = await application.submit({ ownerUserId }, request);
    const stageKey = submitted.stages[0]!.key;
    const identity = stageKey.slice("character:".length);
    if (edit) expect(identity).toBe("existing-hero");
    else {
      expect(identity).toMatch(/^[0-9a-f-]{36}$/u);
      expect(submitted.request).not.toHaveProperty("characterId");
    }
    expect(authoringSubmitSchema.parse(submitted.request)).toEqual(submitted.request);
    expect((await application.submit({ ownerUserId }, request)).stages).toEqual(submitted.stages);
    expect((await repository.read({ ownerUserId }, submitted.id))!.request).toEqual(submitted.request);
    const requests: ProviderRequest[] = [];
    let malformed = true;
    const adapter = runtime(async (providerRequest) => {
      requests.push(providerRequest);
      return result(malformed ? fixture.malformed : JSON.stringify({ ...fixture.character, id: "model-cannot-replace-identity" }));
    });
    const abandoned = (await repository.claim("abandoned", 60))!;
    await repository.initializeExecutionSnapshot(abandoned, adapter.snapshot);
    expect((await repository.loadClaim(abandoned))!.stageKey).toBe(stageKey);
    await pool.query("UPDATE authoring_job_stages SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE id = $1", [abandoned.stageId]);
    const recovered = (await repository.claim("recovered", 60))!;
    expect(recovered.stageId).toBe(abandoned.stageId);
    expect((await repository.loadClaim(recovered))!.stageKey).toBe(stageKey);
    await expect(repository.loadClaim(abandoned)).resolves.toBeNull();
    try {
      await executeAuthoringStage({ claim: recovered, repository, dispatch: adapter.dispatch });
      throw new Error("Malformed provider output should fail");
    } catch (error) {
      expect(error).toBeInstanceOf(AuthoringResponseError);
      await expect(repository.fail(recovered, (error as AuthoringResponseError).authoringFailure)).resolves.toBe(true);
    }
    expect(requests).toHaveLength(2);
    const failed = (await repository.read({ ownerUserId }, submitted.id))!;
    await repository.retry({ ownerUserId }, submitted.id, recovered.stageId, failed.revision);
    malformed = false;
    const retry = (await repository.claim("retry", 60))!;
    const loaded = (await repository.loadClaim(retry))!;
    expect(loaded.stageKey).toBe(stageKey);
    expect(loaded.snapshot).toEqual(adapter.snapshot);
    const output = await executeAuthoringStage({ claim: retry, repository, dispatch: adapter.dispatch, resolveSnapshot: async () => { throw new Error("Must not resolve a changed default"); } });
    expect(output).toMatchObject({ kind: "character", character: { id: identity } });
    await expect(repository.checkpoint(retry, output)).resolves.toBe(true);
    expect(requests).toHaveLength(3);
    expect(requests.every((providerRequest) => providerRequest.systemPrompt.includes("Pinned character prompt."))).toBe(true);
    expect((await application.submit({ ownerUserId }, request)).stages.every((stage) => stage.key === stageKey)).toBe(true);
    if (output?.kind !== "character") throw new Error("Expected a character checkpoint");
    const reviewJob = (await repository.read({ ownerUserId }, submitted.id))!;
    await expect(repository.review({ ownerUserId }, submitted.id, {
      expectedRevision: reviewJob.revision, selectedStageIds: [retry.stageId], content: { ...output.character, id: "replacement-review-id" }
    })).rejects.toMatchObject({ code: "invalid_state" });
    await expect(repository.review({ ownerUserId }, submitted.id, {
      expectedRevision: reviewJob.revision, selectedStageIds: [retry.stageId], content: { ...output.character, name: "Reviewed cartographer" }
    })).resolves.toMatchObject({ reviewedContent: { id: identity, name: "Reviewed cartographer" } });
    logger.info({ mode, stageKey, providerCalls: requests.length, providerLoads: adapter.loads }, "Durable identity evidence");
  });

  it("refuses a late deferred provider result after lease expiry and a replacement runtime worker checkpoints", async () => {
    const repository = createPostgresAuthoringRepository(pool);
    const request = authoringSubmitSchema.parse({ kind: "character", target: { kind: "new_world" }, idempotencyKey: randomUUID(), prompt: "Create a cartographer.", content: worldContentSchema.parse({ world: { title: "Lease fixture" } }) });
    await repository.submit({ ownerUserId }, request, sha256(JSON.stringify(request)));
    let providerStarted!: () => void;
    const providerStart = new Promise<void>((resolve) => { providerStarted = resolve; });
    let finishA!: (value: ProviderResult) => void;
    const deferred = new Promise<ProviderResult>((resolve) => { finishA = resolve; });
    let providerACalls = 0;
    let providerBCalls = 0;
    const provider = (execute: (request: ProviderRequest) => Promise<ProviderResult>): RuntimeTextExecution => ({ id: "00000000-0000-4000-8000-000000000011", name: "Synthetic", providerRole: "text", providerType: "lmstudio", model: "pinned-model", contextWindowTokens: 32768, maxOutputTokens: 4096, temperature: 0.7, requestTimeoutMs: 30000, endpointIdentity: "opaque-endpoint", configuration: {}, execute });
    const providers = (execute: (request: ProviderRequest) => Promise<ProviderResult>) => ({
      resolution: { resolveDirect: async () => ({ status: "resolved" as const, providerProfileId: "00000000-0000-4000-8000-000000000011", model: "pinned-model" }) },
      execution: { text: async () => provider(execute) },
      prompts: { loadWorldGenerationPromptSnapshot: async () => ({ snapshot: { character_generation: { content: "Pinned character prompt." } } }) },
      promptTools: { content: (snapshot: any, key: string) => snapshot[key]?.content ?? "" }
    });
    const workerA = createRuntimeAuthoringWorkerApplication({ repository, providers: providers(async () => { providerACalls += 1; providerStarted(); return deferred; }) as never, sha256, heartbeatMilliseconds: 10_000 });
    const runningA = workerA.runNext({ workerId: "worker-a", leaseSeconds: 30 });
    await providerStart;
    const running = await pool.query<{ id: string }>("SELECT id FROM authoring_job_stages WHERE status = 'running'");
    await pool.query("UPDATE authoring_job_stages SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE id = $1", [running.rows[0]!.id]);
    const workerB = createRuntimeAuthoringWorkerApplication({ repository, providers: providers(async () => { providerBCalls += 1; return result(JSON.stringify(fixture.character)); }) as never, sha256, heartbeatMilliseconds: 10_000 });
    await expect(workerB.runNext({ workerId: "worker-b", leaseSeconds: 30 })).resolves.toBe(true);
    finishA(result(JSON.stringify({ ...fixture.character, name: "Late output" })));
    await expect(runningA).resolves.toBe(false);
    const output = await pool.query<{ output: any }>("SELECT output FROM authoring_job_stages WHERE id = $1", [running.rows[0]!.id]);
    expect(output.rows[0]!.output.character.name).not.toBe("Late output");
    expect({ providerACalls, providerBCalls }).toEqual({ providerACalls: 1, providerBCalls: 1 });
  });

  it("checkpoints outline and first character, fails the second twice, and retries only missing work with successful bytes unchanged", async () => {
    const repository = createPostgresAuthoringRepository(pool);
    const request = authoringSubmitSchema.parse({ kind: "world_concept", target: { kind: "new_world" }, idempotencyKey: randomUUID(), prompt: "Create a world of glass roads." });
    const job = await repository.submit({ ownerUserId }, request, sha256(JSON.stringify(request)));
    const providerCalls: { key: string; repair: boolean }[] = [];
    const stageCalls: string[] = [];
    let failingId: string | undefined;
    let failSecond = true;
    const adapter = runtime(async (providerRequest) => {
      const input = JSON.parse(providerRequest.input) as { seed?: { id: string; name: string } };
      const key = input.seed ? `character:${input.seed.id}` : "world";
      providerCalls.push({ key, repair: providerRequest.rejectedResponse !== undefined });
      if (!input.seed) return result(JSON.stringify(fixture.world));
      if (input.seed.id === failingId && failSecond) return result(fixture.malformed);
      return result(JSON.stringify({ ...fixture.character, id: input.seed.id, name: input.seed.name }));
    });
    const executeNext = async (reserved?: AuthoringClaim) => {
      const claim = reserved ?? (await repository.claim("stage-worker", 60))!;
      expect(claim).not.toBeNull();
      try {
        const output = await executeAuthoringStage({ claim, repository, resolveSnapshot: async () => adapter.snapshot, dispatch: async (stage) => { stageCalls.push(stage.stageKey); return adapter.dispatch(stage); } });
        await expect(repository.checkpoint(claim, output)).resolves.toBe(true);
        return { claim, output };
      } catch (error) {
        expect(error).toBeInstanceOf(AuthoringResponseError);
        await expect(repository.fail(claim, (error as AuthoringResponseError).authoringFailure)).resolves.toBe(true);
        return { claim, output: null };
      }
    };
    const world = await executeNext();
    expect(world.output?.kind).toBe("outline");
    if (world.output?.kind === "outline") {
      expect(world.output.outline.seeds.every((seed) => !fixture.world.character_seeds.some((modelSeed) => modelSeed.id === seed.id))).toBe(true);
    }
    const first = await executeNext();
    expect(first.output?.kind).toBe("character");
    const successful = async () => (await pool.query<{ id: string; bytes: string }>("SELECT id, output::text AS bytes FROM authoring_job_stages WHERE id = ANY($1::uuid[]) ORDER BY id", [[world.claim.stageId, first.claim.stageId]])).rows.map((row) => ({ ...row, hash: sha256(row.bytes) }));
    const original = await successful();
    const beforeFailure = (await repository.read({ ownerUserId }, job.id))!;
    const queued = beforeFailure.stages.filter((stage) => stage.status === "queued").sort((a, b) => a.key.localeCompare(b.key));
    failingId = queued[0]!.key.slice("character:".length);
    const secondClaim = (await repository.claim("second-worker", 60))!;
    await executeNext(); // Complete the independent third seed while the second is leased.
    const failed = await executeNext(secondClaim);
    expect(failed.output).toBeNull();
    expect(providerCalls.filter((call) => call.key === `character:${failingId}`)).toHaveLength(2);
    const partial = (await repository.read({ ownerUserId }, job.id))!;
    expect(partial).toMatchObject({ status: "recoverable", incomplete: true });
    expect(partial.result?.playableCharacters).toHaveLength(2);
    const beforeRetry = (await repository.read({ ownerUserId }, job.id))!;
    await repository.retry({ ownerUserId }, job.id, failed.claim.stageId, beforeRetry.revision);
    const boundary = stageCalls.length;
    const providerBoundary = providerCalls.length;
    failSecond = false;
    const retried = await executeNext();
    expect(retried.output?.kind).toBe("character");
    expect(stageCalls.slice(boundary)).toEqual([`character:${failingId}`]);
    expect(providerCalls.slice(providerBoundary)).toEqual([{ key: `character:${failingId}`, repair: false }]);
    expect(await successful()).toEqual(original);
    expect((await repository.read({ ownerUserId }, job.id))!).toMatchObject({ status: "awaiting_review", incomplete: false });
    await expect(repository.claim("no-more-work", 60)).resolves.toBeNull();
    logger.info({ stageCalls, providerCalls, original, reloaded: await successful() }, "Durable checkpoint evidence");
  });

  it.each(["initial", "transport retry", "repair", "acceptance"] as const)("fences actual durable cancellation before %s", async (boundary) => {
    const repository = createPostgresAuthoringRepository(pool);
    const request = authoringSubmitSchema.parse({ kind: "character", target: { kind: "new_world" }, idempotencyKey: randomUUID(), prompt: "Create a cartographer.", content: worldContentSchema.parse({ world: { title: "Cancellation fixture" } }) });
    const job = await repository.submit({ ownerUserId }, request, sha256(JSON.stringify(request)));
    const claim = (await repository.claim("cancellation-worker", 60))!;
    let providerCalls = 0;
    const cancel = async () => {
      const current = (await repository.read({ ownerUserId }, job.id))!;
      await repository.cancel({ ownerUserId }, job.id, current.revision);
    };
    const adapter = runtime(async () => {
      providerCalls += 1;
      await cancel();
      if (boundary === "transport retry") throw new ProviderHttpError(429, 1, "synthetic rate limit");
      return result(boundary === "repair" ? fixture.malformed : JSON.stringify(fixture.character));
    });
    await repository.initializeExecutionSnapshot(claim, adapter.snapshot);
    if (boundary === "initial") {
      await cancel();
      await expect(executeAuthoringStage({ claim, repository, dispatch: adapter.dispatch })).resolves.toBeNull();
    } else {
      await expect(executeAuthoringStage({ claim, repository, dispatch: adapter.dispatch })).rejects.toMatchObject({ authoringFailure: { code: "authoring_cancelled", retryable: false } });
    }
    expect(providerCalls).toBe(boundary === "initial" ? 0 : 1);
    const rows = await pool.query<{ output: unknown }>("SELECT output FROM authoring_job_stages WHERE job_id = $1", [job.id]);
    expect(rows.rows.every((row) => row.output === null)).toBe(true);
    await expect(repository.loadClaim(claim)).resolves.toBeNull();
  });

  it("cancels while the repair provider request is in flight and rejects its late valid result", async () => {
    const repository = createPostgresAuthoringRepository(pool);
    const request = authoringSubmitSchema.parse({ kind: "character", target: { kind: "new_world" }, idempotencyKey: randomUUID(), prompt: "Create a cartographer.", content: worldContentSchema.parse({ world: { title: "In-flight repair fixture" } }) });
    const job = await repository.submit({ ownerUserId }, request, sha256(JSON.stringify(request)));
    const claim = (await repository.claim("in-flight-repair", 60))!;
    const repairing = deferred<void>();
    const finishRepair = deferred<ProviderResult>();
    let calls = 0;
    const adapter = runtime(async providerRequest => {
      calls += 1;
      if (calls === 1) return result(fixture.malformed);
      expect(providerRequest.rejectedResponse).toBeDefined();
      repairing.resolve();
      return finishRepair.promise;
    });
    await repository.initializeExecutionSnapshot(claim, adapter.snapshot);
    const execution = executeAuthoringStage({ claim, repository, dispatch: adapter.dispatch });
    await repairing.promise;
    const current = (await repository.read({ ownerUserId }, job.id))!;
    await repository.cancel({ ownerUserId }, job.id, current.revision);
    finishRepair.resolve(result(JSON.stringify(fixture.character)));
    await expect(execution).rejects.toMatchObject({ authoringFailure: { code: "authoring_cancelled", retryable: false } });
    expect(calls).toBe(2);
    expect((await pool.query("SELECT output FROM authoring_job_stages WHERE job_id = $1", [job.id])).rows).toEqual([{ output: null }]);
    await expect(repository.loadClaim(claim)).resolves.toBeNull();
    await expect(repository.claim("no-post-cancel-stage", 60)).resolves.toBeNull();
  });

  it("projects application-owned world mechanics identically to synchronous assembly with zero, one or two completed characters", async () => {
    const repository = createPostgresAuthoringRepository(pool);
    const request = authoringSubmitSchema.parse({ kind: "world_concept", target: { kind: "new_world" }, idempotencyKey: randomUUID(), prompt: "Create a glass road world." });
    if (request.kind !== "world_concept") throw new Error("Expected a world concept input.");
    const job = await repository.submit({ ownerUserId }, request, sha256(JSON.stringify(request)));
    const raw = {
      ...fixture.world,
      rpg_statistics: [{ id: "model-stat", name: "Resolve", value: 3 }],
      default_triggers: [{ id: "model-trigger", name: "Lantern", value: "lit" }],
      event_triggers: [{ id: "model-event", name: "Dawn", condition: "Sun rises" }]
    };
    const adapter = runtime(async (providerRequest) => {
      const input = JSON.parse(providerRequest.input) as { seed?: { id: string; name: string } };
      return result(JSON.stringify(input.seed ? { ...fixture.character, id: input.seed.id, name: input.seed.name } : raw));
    });
    const claim = (await repository.claim("mechanics-outline", 60))!;
    const output = await executeAuthoringStage({ claim, repository, resolveSnapshot: async () => adapter.snapshot, dispatch: adapter.dispatch });
    if (output?.kind !== "outline") throw new Error("Expected real outline output");
    await expect(repository.checkpoint(claim, output)).resolves.toBe(true);
    const synchronousInput = { sourceName: "test", sourceKind: "prompt" as const, title: "Roads", summary: request.prompt, keywords: [], excerpts: [] };
    const characters = output.outline.seeds.map((seed) => ({ ...fixture.character, id: seed.id, name: seed.name, profile: playableCharacterSchema.parse(fixture.character).profile }));
    const complete = assembleGeneratedWorld({ input: synchronousInput, outline: output.outline, characters });
    const expectedMechanics = {
      rpgStats: [{ id: "world-wide-stat-1", name: "Resolve", value: 3, note: "" }],
      defaultTriggers: [{ id: "world-wide-tracker-1", name: "Lantern", value: "lit", rules: "Track Lantern whenever it changes." }],
      eventTriggers: [{ id: "generated-world-event-1", name: "Dawn", condition: "Sun rises" }]
    };
    expect(complete).toMatchObject(expectedMechanics);
    for (const count of [0, 1, 2]) {
      const partial = (await repository.read({ ownerUserId }, job.id))!;
      expect(partial.incomplete).toBe(true);
      expect(partial.result!.playableCharacters).toHaveLength(count);
      expect({ rpgStats: partial.result!.rpgStats, defaultTriggers: partial.result!.defaultTriggers, eventTriggers: partial.result!.eventTriggers }).toEqual(expectedMechanics);
      expect(partial.result!.world).toEqual(complete.world);
      expect(() => assembleGeneratedWorld({ input: synchronousInput, outline: output.outline, characters: characters.slice(0, count) })).toThrow();
      const child = (await repository.claim("mechanics-character", 60))!;
      const character = await executeAuthoringStage({ claim: child, repository, dispatch: adapter.dispatch });
      await expect(repository.checkpoint(child, character)).resolves.toBe(true);
    }
    expect((await repository.read({ ownerUserId }, job.id))!.incomplete).toBe(false);
  });
});
