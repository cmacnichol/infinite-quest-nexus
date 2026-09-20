import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { authoringRuntimeFixture, deferred } from "../helpers/authoring-runtime.js";
import { runWorker } from "../../services/worker/src/worker.js";
import { runRuntimeLifecycle } from "../../services/runtime/src/lifecycle.js";
import { inertWorkerIllustration, inertWorkerMemory } from "../helpers/memory-applications.js";
import { authoringSubmitSchema, getProviderOutputSchemaV2, playableCharacterSchema, worldContentSchema, type SchemaVerificationV2 } from "../../packages/contracts/src/index.js";
import { createAuthoringApplication } from "../../packages/application/src/authoring/use-cases.js";
import { createAuthoringWorkerApplication } from "../../packages/application/src/authoring/worker.js";
import type { AuthoringClaim } from "../../packages/application/src/authoring/ports.js";
import { createPostgresAuthoringRepository, createPostgresAuthoringTargetPort } from "../../packages/database/src/authoring-job-repository.js";
import { createDatabasePool, initialOwnerId, type DatabasePool } from "../../packages/database/src/pool.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { logger } from "../../packages/logger/src/index.js";
import { CHARACTER_AUTHORING_PROMPT_PROTOCOL_VERSION, WORLD_AUTHORING_PROMPT_PROTOCOL_VERSION } from "../../packages/domain/src/authoring-prompts.js";
import { AuthoringResponseError } from "../../services/runtime/src/authoring-response-adapter.js";
import { createRuntimeAuthoringApplication, createRuntimeAuthoringWorkerApplication } from "../../services/runtime/src/authoring-composition.js";
import { createAuthoringExecutionSnapshot, createRuntimeAuthoringStageDispatcher, executeAuthoringStage } from "../../services/runtime/src/authoring-stage-adapter.js";
import { prepareAuthoringResponseContractExecution } from "../../services/runtime/src/authoring-text-execution-preparation.js";
import { deriveTextExecutionPlan, textExecutionRouteBasisHash } from "../../packages/contracts/src/text-execution-plan.js";
import { capabilityRouteConfigHash } from "../../services/runtime/src/provider-capability-cache.js";
import { createProviderResponseFormatCapabilities } from "../../services/runtime/src/provider-response-format-capabilities.js";
import type { RuntimeProviderExecutionPort, RuntimeTextExecution } from "../../services/runtime/src/provider-credential-transport-adapter.js";
import type { ProviderRequest, ProviderResult } from "../../packages/story-engine/src/providers.js";
import { ProviderHttpError } from "../../packages/story-engine/src/providers.js";
import { composePresetPrompt } from "../../packages/story-engine/src/preset-prompt.js";
import { buildSourceExtractionPrompt, buildSourceWorldPrompt } from "../../packages/domain/src/authoring-prompts.js";
import { assembleGeneratedWorld } from "../../services/runtime/src/provider-world-generation-adapter.js";
import { createWorkerProviderApplicationComposition } from "../../services/runtime/src/provider-application-composition.js";
import { createProvider } from "../helpers/provider-application-fixtures.js";
import { currentIntegrationProviderTransport, installIntegrationProviderTransport } from "./provider-transport-test-helper.js";
import fixture from "../fixtures/authoring/reliability.json" with { type: "json" };

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const integration = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const result = (content: string): ProviderResult => ({ content, responseId: "synthetic", finishReason: "stop", outputLimited: false, modelInstanceId: "synthetic", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, reportedCost: null, rawMetadata: {} });

function standaloneModelCapabilities(input: Readonly<{ endpointIdentity: string; model: string; configuration: Record<string, unknown> }>) {
  const schema = getProviderOutputSchemaV2("standalone_character");
  const verification: SchemaVerificationV2 = {
    version: 2, providerType: "openrouter", endpointIdentity: input.endpointIdentity, model: input.model,
    routeConfigHash: capabilityRouteConfigHash(input.configuration), adapterProtocol: "text-schema-adapter-v2",
    operation: "standalone_character", schemaHash: schema.schemaHash, streaming: false,
    verifiedAt: "2026-09-19T00:00:00.000Z", expiresAt: "2027-09-19T00:00:00.000Z",
    providerRoutingSlugs: ["openai"], nativeOpenTrackerObjects: true
  };
  return createProviderResponseFormatCapabilities({
    records: [verification], registryDigest: sha256("authoring-model-registry"),
    now: () => Date.parse("2026-09-20T00:00:00.000Z")
  });
}

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

  async function historicalAuthoringClaim(workerId: string, seconds = 60): Promise<AuthoringClaim | null> {
    return (await (async () => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const jobs = await client.query<any>(`SELECT jobs.id,jobs.owner_user_id,jobs.execution_generation,jobs.review_generation
          FROM authoring_jobs jobs WHERE jobs.kind = ANY($1::text[]) AND jobs.status IN ('queued','running')
            AND jobs.expires_at > clock_timestamp() AND EXISTS (
              SELECT 1 FROM authoring_job_stages stages WHERE stages.job_id = jobs.id
                AND stages.owner_user_id = jobs.owner_user_id
                AND stages.generation = (SELECT max(current.generation) FROM authoring_job_stages current WHERE current.job_id = stages.job_id AND current.stage_key = stages.stage_key)
                AND NOT EXISTS (SELECT 1 FROM jsonb_each_text(stages.parent_generations) dependency
                  LEFT JOIN authoring_job_stages parent ON parent.job_id = stages.job_id AND parent.stage_key = dependency.key
                    AND parent.generation = dependency.value::int AND parent.status = 'validated'
                    AND parent.generation = (SELECT max(current.generation) FROM authoring_job_stages current WHERE current.job_id = parent.job_id AND current.stage_key = parent.stage_key)
                  WHERE parent.id IS NULL)
                AND (stages.status = 'queued' AND ((stages.attempt_count = 0 AND stages.retry_count = 0) OR stages.next_attempt_at <= clock_timestamp())
                  OR stages.status = 'running' AND stages.lease_expires_at <= clock_timestamp() AND stages.attempt_count <= 3))
          ORDER BY jobs.created_at,jobs.id FOR UPDATE SKIP LOCKED LIMIT 1`, [["world_concept", "character", "story_source"]]);
        const job = jobs.rows[0];
        if (!job) { await client.query("COMMIT"); return null; }
        const stages = await client.query<any>(`SELECT stages.id,stages.generation,stages.lease_token,stages.lease_expires_at
          FROM authoring_job_stages stages WHERE stages.job_id = $1 AND stages.owner_user_id = $2
            AND (stages.source_review_generation IS NULL OR stages.source_review_generation = $3)
            AND stages.generation = (SELECT max(current.generation) FROM authoring_job_stages current WHERE current.job_id = stages.job_id AND current.stage_key = stages.stage_key)
            AND NOT EXISTS (SELECT 1 FROM jsonb_each_text(stages.parent_generations) dependency
              LEFT JOIN authoring_job_stages parent ON parent.job_id = stages.job_id AND parent.stage_key = dependency.key
                AND parent.generation = dependency.value::int AND parent.status = 'validated'
                AND parent.generation = (SELECT max(current.generation) FROM authoring_job_stages current WHERE current.job_id = parent.job_id AND current.stage_key = parent.stage_key)
              WHERE parent.id IS NULL)
            AND ((stages.status = 'queued' AND ((stages.attempt_count = 0 AND stages.retry_count = 0) OR stages.next_attempt_at <= clock_timestamp()))
              OR (stages.status = 'running' AND stages.lease_expires_at <= clock_timestamp() AND stages.attempt_count <= 3))
          ORDER BY stages.next_attempt_at,stages.created_at,stages.id FOR UPDATE SKIP LOCKED LIMIT 1`, [job.id, job.owner_user_id, job.review_generation]);
        const stage = stages.rows[0];
        if (!stage) { await client.query("COMMIT"); return null; }
        await client.query("UPDATE authoring_job_stages SET status = 'running', attempt_count = attempt_count + 1, lease_token = gen_random_uuid(), lease_owner = $2, lease_expires_at = clock_timestamp() + make_interval(secs => $3::int), started_at = COALESCE(started_at, clock_timestamp()), updated_at = clock_timestamp() WHERE id = $1", [stage.id, workerId, seconds]);
        const row = (await client.query<any>("SELECT id,generation,lease_token,lease_expires_at FROM authoring_job_stages WHERE id=$1", [stage.id])).rows[0]!;
        await client.query("UPDATE authoring_jobs SET status = 'running', last_activity_at = clock_timestamp(), expires_at = clock_timestamp() + interval '7 days', updated_at = clock_timestamp() WHERE id = $1", [job.id]);
        await client.query("COMMIT");
        return { jobId: job.id, stageId: row.id, ownerUserId: job.owner_user_id, jobGeneration: job.execution_generation,
          stageGeneration: row.generation, leaseToken: row.lease_token, leaseExpiresAt: row.lease_expires_at.toISOString() };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally { client.release(); }
    })());
  }

  it.each(["queued", "expired"] as const)("fences an exact historical authoring %s claim before snapshot initialization and dispatch", async (state) => {
    const protocolRepository = (createPostgresAuthoringRepository as unknown as (
      value: DatabasePool,
      options: { textPlanProtocol: 2 }
    ) => ReturnType<typeof createPostgresAuthoringRepository>)(pool, { textPlanProtocol: 2 });
    const input = authoringSubmitSchema.parse({ kind: "character", target: { kind: "new_world" }, idempotencyKey: randomUUID(), prompt: "Create a fenced cartographer.", content: worldContentSchema.parse({ world: { title: "Fenced authoring" } }) });
    const job = await protocolRepository.submit({ ownerUserId }, input, sha256(JSON.stringify(input)));
    await expect(pool.query<{ text_plan_protocol: number | null }>(
      "SELECT text_plan_protocol FROM authoring_jobs WHERE id=$1", [job.id]
    )).resolves.toMatchObject({ rows: [{ text_plan_protocol: 2 }] });
    let priorClaim: AuthoringClaim | null = null;
    if (state === "expired") {
      priorClaim = await protocolRepository.claim("compatible-authoring", 60);
      expect(priorClaim?.jobId).toBe(job.id);
      await pool.query("UPDATE authoring_job_stages SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [priorClaim!.stageId]);
    }
    const before = (await pool.query(
      `SELECT jobs.status AS job_status,jobs.last_activity_at,jobs.expires_at,jobs.execution_generation,
              stages.id AS stage_id,stages.generation AS stage_generation,
              stages.status AS stage_status,stages.attempt_count,stages.lease_token,stages.lease_owner,stages.lease_expires_at
         FROM authoring_jobs jobs JOIN authoring_job_stages stages ON stages.job_id=jobs.id WHERE jobs.id=$1`,
      [job.id]
    )).rows[0];
    let synthetic: AuthoringClaim;
    if (state === "queued") {
      await expect(historicalAuthoringClaim("old-authoring")).rejects.toThrow(TypeError);
      synthetic = {
        jobId: job.id,
        stageId: before.stage_id,
        ownerUserId,
        jobGeneration: before.execution_generation,
        stageGeneration: before.stage_generation,
        leaseToken: randomUUID(),
        leaseExpiresAt: new Date(Date.now() + 60_000).toISOString()
      };
    } else {
      synthetic = (await historicalAuthoringClaim("compatible-authoring"))!;
      expect(synthetic.jobId).toBe(job.id);
    }
    expect((await pool.query(
      `SELECT jobs.status AS job_status,jobs.last_activity_at,jobs.expires_at,jobs.execution_generation,
              stages.id AS stage_id,stages.generation AS stage_generation,
              stages.status AS stage_status,stages.attempt_count,stages.lease_token,stages.lease_owner,stages.lease_expires_at
         FROM authoring_jobs jobs JOIN authoring_job_stages stages ON stages.job_id=jobs.id WHERE jobs.id=$1`,
      [job.id]
    )).rows[0]).toEqual(before);
    const runtimeFixture = runtime(async () => result(JSON.stringify(fixture.character)));
    expect(await protocolRepository.loadClaim(synthetic!)).toBeNull();
    expect(await protocolRepository.initializeExecutionSnapshot(synthetic!, runtimeFixture.snapshot)).toBeNull();
    expect(await protocolRepository.heartbeat(synthetic!, 60)).toBe(false);
    const dispatch = vi.fn(async () => ({ kind: "character", character: fixture.character } as const));
    await expect(executeAuthoringStage({ claim: synthetic, repository: protocolRepository, dispatch: dispatch as never })).resolves.toBeNull();
    expect(dispatch).not.toHaveBeenCalled();
    const compatible = await protocolRepository.claim("compatible-authoring-reclaim", 60);
    expect(compatible).toMatchObject({ jobId: job.id, stageId: synthetic.stageId });
    expect(compatible?.stageGeneration).toBe(synthetic.stageGeneration);
  });

  it("keeps genuine v1 authoring snapshots on the historical claim path", async () => {
    const repository = createPostgresAuthoringRepository(pool);
    const input = authoringSubmitSchema.parse({ kind: "character", target: { kind: "new_world" }, idempotencyKey: randomUUID(), prompt: "Create a historical cartographer.", content: worldContentSchema.parse({ world: { title: "Historical authoring" } }) });
    const job = await repository.submit({ ownerUserId }, input, sha256(JSON.stringify(input)));
    const claim = (await repository.claim("v1-snapshot-initial", 60))!;
    const historical = runtime(async () => result(JSON.stringify(fixture.character))).snapshot;
    expect("version" in historical).toBe(false);
    await expect(repository.initializeExecutionSnapshot(claim, historical)).resolves.toEqual(historical);
    await expect(pool.query<{ text_plan_protocol: number | null }>(
      "SELECT text_plan_protocol FROM authoring_jobs WHERE id=$1", [job.id]
    )).resolves.toMatchObject({ rows: [{ text_plan_protocol: null }] });
    await pool.query("UPDATE authoring_job_stages SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [claim.stageId]);
    await expect(historicalAuthoringClaim("historical-v1-authoring"))
      .resolves.toMatchObject({ jobId: job.id, stageId: claim.stageId });
    await expect(pool.query<{ attempt_count: number; lease_owner: string }>(
      "SELECT attempt_count,lease_owner FROM authoring_job_stages WHERE id=$1", [claim.stageId]
    )).resolves.toMatchObject({ rows: [{ attempt_count: 2, lease_owner: "historical-v1-authoring" }] });
  });

  it("classifies shallow malformed historical authoring snapshots as protected", async () => {
    const malformed = {
      version: 2, providerProfileId: "", model: "", configurationHash: "x",
      contextWindowTokens: -1, maxOutputTokens: 0, requestTimeoutMs: -1,
      prompts: {}, protocols: {}, textExecutionPlans: { bogus: {} }
    };
    await expect(pool.query<{ required: boolean }>(
      "SELECT authoring_snapshot_requires_text_plan_protocol($1::jsonb) AS required",
      [JSON.stringify(malformed)]
    )).resolves.toMatchObject({ rows: [{ required: true }] });
  });

  it("classifies a fully shaped historical authoring plan with a changed plan hash as protected", async () => {
    const routeDraft = {
      version: 2 as const, selection: { kind: "model" as const, modelId: "historical-authoring-model" }, preset: null,
      candidates: [{ modelId: "historical-authoring-model", providerPolicy: { max_price: { prompt: 1e21 } }, contextWindowTokens: 8192, maxOutputTokens: 1024 }],
      presetSystemPrompt: "Historical authoring system prompt.", parameters: { temperature: 1e-7 },
      endpointReference: "historical-authoring-endpoint", credentialReference: randomUUID(), profileRevision: "profile-v1",
      requestTimeoutMs: 30_000, protocolVersion: "text-execution-plan-v2"
    };
    const routeBasis = { ...routeDraft, routeBasisHash: textExecutionRouteBasisHash({ ...routeDraft, routeBasisHash: "0".repeat(64) }) };
    const plan = deriveTextExecutionPlan(routeBasis, "Create Élodie's historical world outline.");
    const snapshot = {
      version: 2 as const, providerProfileId: routeDraft.credentialReference, model: "historical-authoring-model",
      configurationHash: "a".repeat(64), contextWindowTokens: 8192, maxOutputTokens: 1024, requestTimeoutMs: 30_000,
      prompts: { world_generation: "Historical authoring system prompt." }, protocols: { world: "world-authoring-v1" },
      textExecutionPlans: { worldOutline: plan }
    };
    const tampered = { ...snapshot, textExecutionPlans: { worldOutline: { ...plan, planHash: "b".repeat(64) } } };
    const { planHash: _planHash, ...unhashedPlan } = plan;
    const canonicalNumbers = '{"large":1e+21,"precise":0.30000000000000004,"small":1e-7}';
    const canonicalClient = await pool.connect();
    try {
      await canonicalClient.query("SET extra_float_digits = -15");
      await expect(canonicalClient.query<{ text: string; hash: string }>(
        "SELECT canonical_jsonb_text($1::jsonb) AS text,canonical_jsonb_sha256($1::jsonb) AS hash",
        [JSON.stringify({ small: 1e-7, precise: 0.30000000000000004, large: 1e21 })]
      )).resolves.toMatchObject({ rows: [{ text: canonicalNumbers, hash: sha256(canonicalNumbers) }] });
    } finally {
      await canonicalClient.query("RESET extra_float_digits");
      canonicalClient.release();
    }
    await expect(pool.query<{ hash: string }>(
      "SELECT canonical_jsonb_sha256($1::jsonb) AS hash",
      [JSON.stringify(unhashedPlan)]
    )).resolves.toMatchObject({ rows: [{ hash: plan.planHash }] });
    await expect(pool.query<{ required: boolean }>(
      "SELECT authoring_snapshot_requires_text_plan_protocol($1::jsonb) AS required",
      [JSON.stringify(snapshot)]
    )).resolves.toMatchObject({ rows: [{ required: false }] });
    await expect(pool.query<{ required: boolean }>(
      "SELECT authoring_snapshot_requires_text_plan_protocol($1::jsonb) AS required",
      [JSON.stringify(tampered)]
    )).resolves.toMatchObject({ rows: [{ required: true }] });
  });

  it("marks native authoring intent in API composition before the first claim and permits terminal cleanup", async () => {
    const application = createRuntimeAuthoringApplication(pool, sha256, { nativePresetPlansEnabled: true });
    const input = authoringSubmitSchema.parse({ kind: "character", target: { kind: "new_world" }, idempotencyKey: randomUUID(), prompt: "Create an API-marked cartographer.", content: worldContentSchema.parse({ world: { title: "API marker" } }) });
    const job = await application.submit({ ownerUserId }, input);
    await expect(pool.query<{ text_plan_protocol: number | null; status: string; execution_snapshot: unknown }>(
      "SELECT text_plan_protocol,status,execution_snapshot FROM authoring_jobs WHERE id=$1", [job.id]
    )).resolves.toMatchObject({ rows: [{ text_plan_protocol: 2, status: "queued", execution_snapshot: null }] });
    await expect(application.cancel({ ownerUserId }, job.id, job.revision)).resolves.toMatchObject({ status: "cancelled" });
    await expect(pool.query<{ text_plan_protocol: number | null; status: string }>(
      "SELECT text_plan_protocol,status FROM authoring_jobs WHERE id=$1", [job.id]
    )).resolves.toMatchObject({ rows: [{ text_plan_protocol: 2, status: "cancelled" }] });
  });

  it("persists one private bound-v3 contract and reclaims it after ordinary edits without metadata reload", async () => {
    const repository = createPostgresAuthoringRepository(pool);
    const input = authoringSubmitSchema.parse({ kind: "character", target: { kind: "new_world" }, idempotencyKey: randomUUID(), prompt: "Create a cartographer.", content: worldContentSchema.parse({ world: { title: "V2" } }) });
    const job = await repository.submit({ ownerUserId }, input, sha256(JSON.stringify(input)));
    const claim = (await repository.claim("v2-initial", 60))!;
    const provider: RuntimeTextExecution = { id: "00000000-0000-4000-8000-000000000011", name: "Native", providerRole: "text", providerType: "openrouter", model: "default-model", contextWindowTokens: 8192, maxOutputTokens: 1024, temperature: 0.7, requestTimeoutMs: 30_000, endpointIdentity: "endpoint-a", executionRevision: "ordinary-a", authorityRevision: "authority-a", textSelection: { kind: "openrouter_preset", slug: "authoring" }, configuration: {}, execute: async () => result(JSON.stringify(fixture.character)) };
    const resolvePreset = vi.fn(async () => ({ slug: "authoring", name: "Authoring", versionId: "v1", version: 1, configHash: "a".repeat(64), config: { models: ["native-model"] }, systemPrompt: "Preset system." }));
    const discoverModels = vi.fn(async () => [{ id: "native-model", contextWindowTokens: 8192, maxOutputTokens: 1024 }]);
    const prepared = await prepareAuthoringResponseContractExecution({
      ownerUserId, execution: provider,
      operationPrompts: {
        standaloneCharacter: "Create a cartographer.", standaloneCharacterRepair: "Create a cartographer.",
        organizer: "Organize the character.", organizerRepair: "Repair the organization."
      },
      ports: { resolvePreset, discoverModels }
    });
    const snapshot = createAuthoringExecutionSnapshot(provider, { character_generation: "legacy" }, { character: CHARACTER_AUTHORING_PROMPT_PROTOCOL_VERSION }, sha256, prepared);
    if (!("routeBasis" in snapshot)) throw new Error("Expected a bound authoring snapshot.");
    const planOnlySnapshot = createAuthoringExecutionSnapshot(
      provider, { character_generation: "legacy" }, { character: CHARACTER_AUTHORING_PROMPT_PROTOCOL_VERSION }, sha256,
      { standaloneCharacter: snapshot.textExecutionPlans.standaloneCharacter! }
    );
    expect(planOnlySnapshot).toMatchObject({ version: 2, textExecutionPlans: { standaloneCharacter: expect.any(Object) } });
    const planOnlyInput = authoringSubmitSchema.parse({ ...input, idempotencyKey: randomUUID() });
    const planOnlyJob = await repository.submit({ ownerUserId }, planOnlyInput, sha256(JSON.stringify(planOnlyInput)));
    const planOnlyClaim = (await repository.claim("plan-v2-initial", 60))!;
    expect(planOnlyClaim.jobId).toBe(planOnlyJob.id);
    await repository.initializeExecutionSnapshot(planOnlyClaim, planOnlySnapshot);
    await pool.query("UPDATE authoring_job_stages SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [planOnlyClaim.stageId]);
    await expect(historicalAuthoringClaim("historical-plan-v2")).resolves.toMatchObject({ jobId: planOnlyJob.id, stageId: planOnlyClaim.stageId });
    await pool.query("UPDATE authoring_jobs SET status='cancelled' WHERE id=$1", [planOnlyJob.id]);
    await pool.query("UPDATE authoring_job_stages SET status='cancelled',lease_token=NULL,lease_owner=NULL,lease_expires_at=NULL WHERE job_id=$1", [planOnlyJob.id]);
    await repository.initializeExecutionSnapshot(claim, snapshot);
    const conflicting = createAuthoringExecutionSnapshot(provider, { character_generation: "conflicting" }, { character: "conflicting" }, sha256);
    expect(await repository.initializeExecutionSnapshot(claim, conflicting)).toEqual(snapshot);
    const publicView = (await repository.read({ ownerUserId }, job.id))!;
    expect(publicView).not.toHaveProperty("executionSnapshot");
    expect(JSON.stringify(publicView)).not.toContain("Preset system.");
    expect(resolvePreset).toHaveBeenCalledOnce();
    expect(discoverModels).toHaveBeenCalledOnce();
    await pool.query("UPDATE authoring_job_stages SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE id = $1", [claim.stageId]);
    const reclaimed = (await repository.claim("v2-reclaim", 60))!;
    const loaded = (await repository.loadClaim(reclaimed))!;
    expect(loaded.snapshot).toEqual(snapshot);
    const executed = vi.fn(async ({ request, preparedRequest, frozenResponseContracts, routeBasis, trustedOperationPrompt }: any) => {
      expect(request.systemPrompt).toBe("Preset system.\n\nCreate a cartographer.");
      expect(JSON.parse(preparedRequest.body).response_format.json_schema.name).toBe("infinite_quest_standalone_character_v1");
      expect(preparedRequest.body.match(/Preset system\./g)).toHaveLength(1);
      expect(preparedRequest.budgetAudit).toMatchObject({ countMode: "estimated", outputReserveTokens: 1024 });
      expect(frozenResponseContracts.version).toBe(2);
      expect(routeBasis.routeBasisHash).toBe(snapshot.routeBasis.routeBasisHash);
      expect(trustedOperationPrompt).toBe("Create a cartographer.");
      return result(JSON.stringify(fixture.character));
    });
    const dispatch = createRuntimeAuthoringStageDispatcher({ execution: { text: async () => ({ ...provider, executionRevision: "ordinary-edited" }) } as never, sha256, preparedExecutor: { execute: executed } });
    await expect(executeAuthoringStage({ claim: reclaimed, repository, dispatch })).resolves.toMatchObject({ kind: "character" });
    expect(executed).toHaveBeenCalledWith(expect.objectContaining({ ownerUserId, providerProfileId: provider.id }));
    for (const tamper of ["whole-unused-invocation", "unused-repair-half"] as const) {
      const tamperedInput = authoringSubmitSchema.parse({ ...input, idempotencyKey: randomUUID() });
      const tamperedJob = await repository.submit({ ownerUserId }, tamperedInput, sha256(JSON.stringify(tamperedInput)));
      const tamperedClaim = (await repository.claim("closure-" + tamper + "-initial", 60))!;
      expect(tamperedClaim.jobId).toBe(tamperedJob.id);
      await repository.initializeExecutionSnapshot(tamperedClaim, snapshot);
      const tamperedSnapshot = structuredClone(snapshot) as any;
      const removed = tamper === "whole-unused-invocation" ? ["organizer", "organizerRepair"] : ["organizerRepair"];
      for (const operation of removed) {
        delete tamperedSnapshot.textExecutionPlans[operation];
        delete tamperedSnapshot.trustedOperationPrompts[operation];
      }
      await expect(pool.query(
        "UPDATE authoring_jobs SET execution_snapshot = $2::jsonb WHERE id = $1",
        [tamperedJob.id, JSON.stringify(tamperedSnapshot)]
      )).rejects.toThrow(/immutable/i);
      expect(executed).toHaveBeenCalledOnce();
    }
    const denied = vi.fn();
    const authorityChanged = createRuntimeAuthoringStageDispatcher({ execution: { text: async () => ({ ...provider, authorityRevision: "authority-revoked" }) } as never, sha256, preparedExecutor: { execute: denied } });
    await expect(authorityChanged({ ...loaded, jobId: reclaimed.jobId, stageId: reclaimed.stageId, stageGeneration: reclaimed.stageGeneration, ownerUserId })).rejects.toMatchObject({ authoringFailure: { code: "authoring_provider_unavailable" } });
    expect(denied).not.toHaveBeenCalled();
    expect(resolvePreset).toHaveBeenCalledOnce();
    expect(discoverModels).toHaveBeenCalledOnce();
  });

  it("reclaims a complete inherited-Model contract after ordinary edits and rejects current authority drift", async () => {
    const repository = createPostgresAuthoringRepository(pool);
    const input = authoringSubmitSchema.parse({ kind: "character", target: { kind: "new_world" }, idempotencyKey: randomUUID(), prompt: "Create a model-bound cartographer.", content: worldContentSchema.parse({ world: { title: "Model V2" } }) });
    const job = await repository.submit({ ownerUserId }, input, sha256(JSON.stringify(input)));
    const claim = (await repository.claim("model-initial", 60))!;
    const configuration = { providerRouting: { only: ["openai"] } };
    const provider: RuntimeTextExecution = {
      id: "00000000-0000-4000-8000-000000000021", name: "Native model", providerRole: "text",
      providerType: "openrouter", model: "openai/model-authoring", contextWindowTokens: 8192,
      maxOutputTokens: 1024, temperature: 0.6, requestTimeoutMs: 30_000,
      endpointIdentity: "endpoint-model", executionRevision: "ordinary-model-a", authorityRevision: "authority-model-a",
      configuration, execute: async () => { throw new Error("legacy model execution must not run"); }
    };
    const prepared = await prepareAuthoringResponseContractExecution({
      ownerUserId, execution: provider,
      operationPrompts: { standaloneCharacter: "Create a model-bound cartographer.", standaloneCharacterRepair: "Repair the model-bound cartographer." },
      ports: {
        resolvePreset: async () => { throw new Error("inherited Model must not resolve a preset"); },
        discoverModels: async () => [{
          id: provider.model, contextWindowTokens: provider.contextWindowTokens, maxOutputTokens: provider.maxOutputTokens,
          responseFormatAdvertisement: { supportedParameters: ["response_format", "structured_outputs"], discoveredAt: "2026-09-20T00:00:00.000Z" }
        }]
      },
      responseFormatCapabilities: standaloneModelCapabilities({ endpointIdentity: provider.endpointIdentity!, model: provider.model, configuration })
    });
    const snapshot = createAuthoringExecutionSnapshot(provider, { character_generation: "legacy" }, { character: CHARACTER_AUTHORING_PROMPT_PROTOCOL_VERSION }, sha256, prepared);
    if (!("routeBasis" in snapshot)) throw new Error("Expected a bound authoring snapshot.");
    expect(snapshot).toMatchObject({ version: 3, providerType: "openrouter", routeBasis: { selection: { kind: "model", modelId: provider.model } } });
    expect(JSON.stringify(snapshot)).not.toContain("presetSlug");
    await repository.initializeExecutionSnapshot(claim, snapshot);
    await pool.query("UPDATE authoring_job_stages SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE id = $1", [claim.stageId]);
    const reclaimed = (await repository.claim("model-reclaim", 60))!;
    const loaded = (await repository.loadClaim(reclaimed))!;
    expect(loaded.snapshot).toEqual(snapshot);
    const executed = vi.fn(async ({ preparedRequest, frozenResponseContracts, routeBasis, trustedOperationPrompt }: any) => {
      const body = JSON.parse(preparedRequest.body);
      expect(body.response_format.json_schema.name).toBe(getProviderOutputSchemaV2("standalone_character").name);
      expect(body.provider).toEqual({ require_parameters: true, only: ["openai"] });
      expect(preparedRequest.budgetAudit).toMatchObject({ countMode: "estimated", outputReserveTokens: 1024 });
      expect(frozenResponseContracts.contracts["standalone_character:nonstream"].admission.basis).toBe("model_verified");
      expect(routeBasis.routeBasisHash).toBe(snapshot.routeBasis.routeBasisHash);
      expect(trustedOperationPrompt).toBe("Create a model-bound cartographer.");
      return result(JSON.stringify(fixture.character));
    });
    const ordinaryEdited = {
      ...provider, executionRevision: "ordinary-model-edited", temperature: 1.4,
      requestTimeoutMs: 5_000, contextWindowTokens: 4096, maxOutputTokens: 512,
      configuration: { providerRouting: { only: ["changed-later"] } }
    };
    const dispatch = createRuntimeAuthoringStageDispatcher({ execution: { text: async () => ordinaryEdited } as never, sha256, preparedExecutor: { execute: executed } });
    const output = await executeAuthoringStage({ claim: reclaimed, repository, dispatch });
    expect(output).toMatchObject({ kind: "character" });
    await expect(repository.checkpoint(reclaimed, output!)).resolves.toBe(true);
    expect(executed).toHaveBeenCalledOnce();
    const denied = vi.fn();
    const authorityChanged = createRuntimeAuthoringStageDispatcher({ execution: { text: async () => ({ ...ordinaryEdited, authorityRevision: "authority-model-revoked" }) } as never, sha256, preparedExecutor: { execute: denied } });
    await expect(authorityChanged({ ...loaded, jobId: reclaimed.jobId, stageId: reclaimed.stageId, stageGeneration: reclaimed.stageGeneration, ownerUserId })).rejects.toMatchObject({ authoringFailure: { code: "authoring_provider_unavailable" } });
    expect(denied).not.toHaveBeenCalled();
    expect((await repository.read({ ownerUserId }, job.id))!.status).toBe("awaiting_review");

    const tamperedInput = authoringSubmitSchema.parse({ ...input, idempotencyKey: randomUUID() });
    const tamperedJob = await repository.submit({ ownerUserId }, tamperedInput, sha256(JSON.stringify(tamperedInput)));
    const tamperedClaim = (await repository.claim("model-tamper-initial", 60))!;
    expect(tamperedClaim.jobId).toBe(tamperedJob.id);
    await repository.initializeExecutionSnapshot(tamperedClaim, snapshot);
    await expect(pool.query(
      "UPDATE authoring_jobs SET execution_snapshot = jsonb_set(execution_snapshot, '{frozenResponseContracts,selectionHash}', to_jsonb($2::text)) WHERE id = $1",
      [tamperedJob.id, "0".repeat(64)]
    )).rejects.toThrow(/immutable/i);
    expect(executed).toHaveBeenCalledOnce();

    const missingSingle = structuredClone(snapshot) as any;
    delete missingSingle.requestConfiguration;
    const missingSingleExecutor = vi.fn();
    const missingSingleDispatch = createRuntimeAuthoringStageDispatcher({
      execution: { text: async () => ordinaryEdited } as never, sha256,
      preparedExecutor: { execute: missingSingleExecutor }
    });
    await expect(missingSingleDispatch({ ...loaded, snapshot: missingSingle, jobId: reclaimed.jobId, stageId: reclaimed.stageId, stageGeneration: reclaimed.stageGeneration, ownerUserId }))
      .rejects.toThrow(/invalid|required|snapshot/i);
    expect(missingSingleExecutor).not.toHaveBeenCalled();

    const downgradeInput = authoringSubmitSchema.parse({ ...input, idempotencyKey: randomUUID() });
    const downgradeJob = await repository.submit({ ownerUserId }, downgradeInput, sha256(JSON.stringify(downgradeInput)));
    const downgradeClaim = (await repository.claim("model-downgrade-initial", 60))!;
    expect(downgradeClaim.jobId).toBe(downgradeJob.id);
    await repository.initializeExecutionSnapshot(downgradeClaim, snapshot);
    await pool.query("UPDATE authoring_job_stages SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE id = $1", [downgradeClaim.stageId]);
    await expect(pool.query(
      `UPDATE authoring_jobs
          SET execution_snapshot = execution_snapshot - ARRAY['providerType','requestConfiguration','routeBasis','frozenResponseContracts','trustedOperationPrompts']::text[]
        WHERE id = $1`,
      [downgradeJob.id]
    )).rejects.toThrow(/immutable/i);
    expect(missingSingleExecutor).not.toHaveBeenCalled();
  });

  it.each([false, true])("composition captures native plans only when admission is enabled: %s", async (nativePresetPlansEnabled) => {
    const repository = createPostgresAuthoringRepository(pool);
    const input = authoringSubmitSchema.parse({ kind: "character", target: { kind: "new_world" }, idempotencyKey: randomUUID(), prompt: "Create a cartographer.", content: worldContentSchema.parse({ world: { title: "Gate" } }) });
    const job = await repository.submit({ ownerUserId }, input, sha256(JSON.stringify(input)));
    const provider: RuntimeTextExecution = { id: "00000000-0000-4000-8000-000000000012", name: "Native", providerRole: "text", providerType: "openrouter", model: "default-model", contextWindowTokens: 8192, maxOutputTokens: 1024, temperature: 0.7, requestTimeoutMs: 30_000, endpointIdentity: "endpoint-a", executionRevision: "ordinary-a", authorityRevision: "authority-a", textSelection: { kind: "openrouter_preset", slug: "authoring" }, configuration: {}, execute: async () => result(JSON.stringify(fixture.character)) };
    const getPreset = vi.fn(async (_input?: unknown) => ({ preset: { slug: "authoring", name: "Authoring", versionId: "v1", version: 1, configHash: "a".repeat(64), config: { models: ["native-model"] }, systemPrompt: "Preset system." } }));
    const listModels = vi.fn(async (_input?: unknown) => ({ models: [{ id: "native-model", name: "Native", contextWindowTokens: 8192 }] }));
    const worker = createRuntimeAuthoringWorkerApplication({ repository, nativePresetPlansEnabled, sha256, providers: { resolution: { resolveDirect: async () => ({ status: "resolved", providerProfileId: provider.id, model: provider.model }) }, execution: { text: async () => provider }, inventory: { getPreset, listModels }, prompts: { loadWorldGenerationPromptSnapshot: async () => ({ snapshot: { character_generation: { content: "Character template." } } }) }, promptTools: { content: (snapshot: any, key: string) => snapshot[key]?.content ?? "" }, authoringTextPlans: { nativePresetPlansEnabled, preparedExecutor: { execute: async () => result("{}") }, loadAuthority: async () => provider, ports: { resolvePreset: async (input: any) => (await getPreset(input)).preset, discoverModels: async (input: any) => (await listModels(input)).models } } } as never, dispatch: (async (stage: { stageKey: string }) => ({ kind: "character", character: { ...fixture.character, id: stage.stageKey.slice("character:".length) } })) as never });
    await expect(worker.runNext({ workerId: "gate", leaseSeconds: 60 })).resolves.toBe(true);
    const persisted = (await pool.query<{ execution_snapshot: unknown }>("SELECT execution_snapshot FROM authoring_jobs WHERE id = $1", [job.id])).rows[0]!.execution_snapshot as Record<string, unknown>;
    expect("version" in persisted).toBe(nativePresetPlansEnabled);
    expect(getPreset).toHaveBeenCalledTimes(nativePresetPlansEnabled ? 1 : 0);
    expect(listModels).toHaveBeenCalledTimes(nativePresetPlansEnabled ? 1 : 0);
  });

  it("isolates two matching durable jobs through the composed prepared executor and exact provider body", async () => {
    const credentialSecret = "task-5c-authoring-composition-secret";
    const requestBodies: string[] = [];
    installIntegrationProviderTransport();
    const server = createServer((request, response) => {
      if (request.url === "/v1/models" || request.url === "/models") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: [{ id: "native-model", context_length: 16_384, supported_parameters: ["response_format", "structured_outputs"] }] }));
        return;
      }
      if (request.url === "/v1/presets/authoring" || request.url === "/presets/authoring") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: {
          slug: "authoring", name: "Authoring", status: "active",
          designated_version: { id: "authoring-v1", version: 1, system_prompt: "Frozen durable preset.", config: { model: "native-model", temperature: 0.2 } }
        } }));
        return;
      }
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        if (!request.url?.endsWith("/chat/completions")) {
          response.writeHead(404, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: { code: "fixture_route_not_found" } }));
          return;
        }
        requestBodies.push(body);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          id: randomUUID(), model: "native-model",
          choices: [{ message: { content: JSON.stringify(fixture.world) }, finish_reason: "stop" }],
          usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 }
        }));
      });
    });
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("authoring fixture server did not bind");
      const provider = await createProvider(pool, {
        name: `task-5c-authoring-${randomUUID()}`, providerType: "openrouter", providerRole: "text",
        baseUrl: `http://127.0.0.1:${address.port}/v1`, defaultModel: "@preset/authoring",
        textSelection: { kind: "openrouter_preset", slug: "authoring" }, contextWindowTokens: 16_384,
        maxOutputTokens: 2_048, temperature: 0.2, enabled: true, isDefault: true, configuration: {}, apiKey: "test"
      }, credentialSecret);
      const repository = createPostgresAuthoringRepository(pool, { textPlanProtocol: 2 });
      const makeInput = () => authoringSubmitSchema.parse({
        kind: "world_concept", target: { kind: "new_world" }, idempotencyKey: randomUUID(), prompt: "Create the same durable world."
      });
      const firstInput = makeInput();
      const secondInput = makeInput();
      const first = await repository.submit({ ownerUserId }, firstInput, sha256(JSON.stringify(firstInput)));
      const second = await repository.submit({ ownerUserId }, secondInput, sha256(JSON.stringify(secondInput)));
      const graph = createWorkerProviderApplicationComposition(pool, {
        credentialSecret, transport: currentIntegrationProviderTransport(), nativeTextExecutionPlanAdmission: true
      });
      expect(graph.worldGeneration.authoringTextPlans?.preparedExecutor).toBe(graph.generation.preparedTextExecutor);
      const worker = createRuntimeAuthoringWorkerApplication({
        pool, repository, providers: graph.worldGeneration, nativePresetPlansEnabled: true, sha256
      });
      const [firstRun, secondRun] = await Promise.all([
        worker.runNext({ workerId: "task-5c-authoring-a", leaseSeconds: 60 }),
        worker.runNext({ workerId: "task-5c-authoring-b", leaseSeconds: 60 })
      ]);
      const jobOutcomes = await pool.query<{ id: string; status: string; stage_status: string; failure: unknown }>(
        `SELECT jobs.id,jobs.status,stages.status AS stage_status,stages.failure
           FROM authoring_jobs jobs
           JOIN authoring_job_stages stages ON stages.job_id=jobs.id
          WHERE jobs.id=ANY($1::uuid[])
          ORDER BY jobs.id`,
        [[first.id, second.id]]
      );
      expect([firstRun, secondRun], JSON.stringify(jobOutcomes.rows)).toEqual([true, true]);

      const attempts = await pool.query<{
        id: string; reservation_key: string; request_body: string; outcome: string;
        logical_reservation: { jobId: string; operation: string };
      }>(
        `SELECT id,reservation_key,request_body,outcome,logical_reservation
           FROM prepared_text_physical_attempts
          WHERE logical_kind='authoring' AND logical_reservation->>'jobId'=ANY($1::text[])
          ORDER BY logical_reservation->>'jobId'`,
        [[first.id, second.id]]
      );
      expect(attempts.rows).toHaveLength(2);
      expect(new Set(attempts.rows.map((row) => row.id)).size).toBe(2);
      expect(new Set(attempts.rows.map((row) => row.reservation_key)).size).toBe(2);
      expect(new Set(attempts.rows.map((row) => row.logical_reservation.jobId))).toEqual(new Set([first.id, second.id]));
      expect(attempts.rows.every((row) => row.logical_reservation.operation === "initial" && row.outcome === "succeeded")).toBe(true);
      expect(attempts.rows[0]!.request_body).toBe(attempts.rows[1]!.request_body);
      expect(requestBodies).toHaveLength(2);
      expect(requestBodies[0]).toBe(requestBodies[1]);
      const body = JSON.parse(requestBodies[0]!);
      expect(body.response_format.json_schema.name).toBe("infinite_quest_world_outline_v1");
      expect(requestBodies[0]!.match(/Frozen durable preset\./g)).toHaveLength(1);
      expect(provider.textSelection).toEqual({ kind: "openrouter_preset", slug: "authoring" });
    } finally {
      await new Promise<void>((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose()));
    }
  });

  it.each(["faithful", "expand"] as const)("composition freezes exact native source prompts for %s mode", async (mode) => {
    const repository = createPostgresAuthoringRepository(pool);
    const input = authoringSubmitSchema.parse({ kind: "story_source", target: { kind: "new_world" }, idempotencyKey: randomUUID(), name: "chapter.txt", text: "Iris wears a blue coat.", mode, boundaryParagraphId: "paragraph:0", instructions: "Keep evidence." });
    const job = await repository.submit({ ownerUserId }, input, sha256(JSON.stringify(input)));
    const provider: RuntimeTextExecution = { id: "00000000-0000-4000-8000-000000000013", name: "Native", providerRole: "text", providerType: "openrouter", model: "default-model", contextWindowTokens: 8192, maxOutputTokens: 1024, temperature: 0.7, requestTimeoutMs: 30_000, endpointIdentity: "endpoint-a", executionRevision: "ordinary-a", authorityRevision: "authority-a", textSelection: { kind: "openrouter_preset", slug: "authoring" }, configuration: {}, execute: async () => result('{"facts":[]}') };
    const preset = "Preset system.";
    const resolvedPreset = { slug: "authoring", name: "Authoring", versionId: "v1", version: 1, configHash: "a".repeat(64), config: { models: ["native-model"] }, systemPrompt: preset };
    const models = [{ id: "native-model", name: "Native", contextWindowTokens: 8192 }];
    const worker = createRuntimeAuthoringWorkerApplication({ repository, nativePresetPlansEnabled: true, sha256, providers: { resolution: { resolveDirect: async () => ({ status: "resolved", providerProfileId: provider.id, model: provider.model }) }, execution: { text: async () => provider }, inventory: { getPreset: async () => ({ preset: resolvedPreset }), listModels: async () => ({ models }) }, prompts: { loadWorldGenerationPromptSnapshot: async () => ({ snapshot: {} }) }, promptTools: { content: () => "" }, authoringTextPlans: { nativePresetPlansEnabled: true, preparedExecutor: { execute: async () => result("{}") }, loadAuthority: async () => provider, ports: { resolvePreset: async () => resolvedPreset, discoverModels: async () => models } } } as never, dispatch: (async () => ({ kind: "source_plan", chunks: [{ id: "chunk", sourceId: "source", sourceRange: { start: 0, end: 1 }, contentHash: "a".repeat(64), spans: [{ paragraphId: "paragraph:0", start: 0, end: 1 }] }] })) as never });
    await expect(worker.runNext({ workerId: "source-plans", leaseSeconds: 60 })).resolves.toBe(true);
    const row = (await pool.query<{ execution_snapshot: any }>("SELECT execution_snapshot FROM authoring_jobs WHERE id = $1", [job.id])).rows[0]!.execution_snapshot;
    const plans = row.textExecutionPlans;
    const extraction = (repair: boolean) => buildSourceExtractionPrompt({ instructions: "", sourceText: "", mode, chunk: { sourceRange: { start: 0, end: 0 }, paragraphSpans: [] }, repair }).systemPrompt;
    const world = (repair: boolean) => buildSourceWorldPrompt({ instructions: "", reviewGeneration: 0, selection: { source: { id: "snapshot", name: "snapshot", sha256: "0".repeat(64) }, boundaryParagraphId: "snapshot", acceptedFacts: [], selectedCharacterFactIds: [], characterIdentityGroups: [], mode }, repair }).systemPrompt;
    expect(plans.sourceExtraction.prompt).toBe(composePresetPrompt({ presetPrompt: preset, operationPrompt: extraction(false) }));
    expect(plans.sourceExtractionRepair.prompt).toBe(composePresetPrompt({ presetPrompt: preset, operationPrompt: extraction(true) }));
    expect(plans.sourceSynthesis.prompt).toBe(composePresetPrompt({ presetPrompt: preset, operationPrompt: world(false) }));
    expect(plans.sourceSynthesisRepair.prompt).toBe(composePresetPrompt({ presetPrompt: preset, operationPrompt: world(true) }));
    expect(plans.sourceCharacter.prompt).toBe(composePresetPrompt({ presetPrompt: preset, operationPrompt: world(false) }));
    expect(plans.sourceCharacterRepair.prompt).toBe(composePresetPrompt({ presetPrompt: preset, operationPrompt: world(true) }));
  });

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
    expect(providerLoad).toHaveBeenCalledWith({ ownerUserId }, originalSnapshot.providerProfileId, "text", originalSnapshot.model, originalSnapshot.contextWindowTokens);
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
