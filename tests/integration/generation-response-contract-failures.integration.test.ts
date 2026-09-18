import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { generationRequestSchema } from "../../packages/contracts/src/generation.js";
import { storyImportRequestSchema } from "../../packages/contracts/src/imports.js";
import { getProviderOutputSchema } from "../../packages/story-engine/src/provider-output-schema.js";
import { createDatabasePool, initialOwnerId, type DatabasePool } from "../../packages/database/src/pool.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { createPostgresGenerationExecutionRepository } from "../../packages/database/src/generation-execution-repository.js";
import { createApiGenerationApplication } from "../../services/runtime/src/generation-api-composition.js";
import { createGenerationExecutionCollaborators } from "../../services/runtime/src/generation-worker-composition.js";
import { createGenerationExecutor } from "../../services/runtime/src/generation-executor-adapter.js";
import { createApiIllustrationApplication } from "../../services/runtime/src/illustration-composition.js";
import { createApiProviderApplicationComposition, createWorkerProviderApplicationComposition } from "../../services/runtime/src/provider-application-composition.js";
import { capabilityRouteConfigHash } from "../../services/runtime/src/provider-capability-cache.js";
import { createProvider } from "../helpers/provider-application-fixtures.js";
import { importLegacyStory } from "../helpers/memory-aware-services.js";
import { apiMemoryApplication } from "../helpers/memory-applications.js";
import { installIntegrationProviderTransport, currentIntegrationProviderTransport } from "./provider-transport-test-helper.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
const credentialSecret = "response-contract-failure-fixture-secret";
const model = "response-contract-failure-model";
const digest = "f".repeat(64);
const verificationNow = Date.parse("2026-09-18T12:00:00.000Z");
const canary = "PRIVATE_PROVIDER_FAILURE_CANARY";

type Scenario = "schema_rejection" | "refusal" | "partial_stream";

integration("response-contract provider failures", () => {
  let pool: DatabasePool;
  let server: Server;
  let ownerUserId = "";
  let endpointIdentity = "";
  let scenario: Scenario = "schema_rejection";
  const requestBodies: string[] = [];

  beforeAll(async () => {
    pool = createDatabasePool(databaseUrl!, 4);
    await migrateDatabase(pool, resolve("database/migrations"));
    ownerUserId = await initialOwnerId(pool);
    const transport = installIntegrationProviderTransport();
    server = createServer((request, response) => {
      if (request.url === "/v1/models" || request.url === "/models") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: [{ id: model, supported_parameters: ["response_format", "structured_outputs"] }] }));
        return;
      }
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        if (request.url?.endsWith("/embeddings")) {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ object: "list", model, data: [{ object: "embedding", index: 0, embedding: [0.5, 0.5] }] }));
          return;
        }
        if (!request.url?.endsWith("/chat/completions")) {
          response.writeHead(404, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: { code: "fixture_route_not_found" } }));
          return;
        }
        requestBodies.push(body);
        if (scenario === "schema_rejection") {
          response.writeHead(400, { "content-type": "application/json", "x-generation-id": "schema-400-id" });
          response.end(JSON.stringify({ id: "schema-400-id", model: "observed-schema-model", provider: "observed-schema-route", error: { code: "response_format_invalid", message: canary } }));
          return;
        }
        if (scenario === "refusal") {
          response.writeHead(200, { "content-type": "application/json", "x-generation-id": "refusal-id" });
          response.end(JSON.stringify({ id: "refusal-id", model: "observed-refusal-model", provider: "observed-refusal-route", choices: [{ message: { refusal: canary }, finish_reason: "content_filter" }] }));
          return;
        }
        response.writeHead(200, { "content-type": "text/event-stream", "x-generation-id": "partial-stream-id" });
        response.end(`data: ${JSON.stringify({ id: "partial-stream-id", model: "observed-stream-model", provider: "observed-stream-route", choices: [{ delta: { content: `partial ${canary}` }, finish_reason: null }] })}\n\n`);
      });
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address(); if (!address || typeof address === "string") throw new Error("failure provider did not bind");
    endpointIdentity = createHash("sha256").update(`http://127.0.0.1:${address.port}/v1`).digest("hex");
    (server as Server & { transport?: { close(): Promise<void> } }).transport = transport;
  });

  afterAll(async () => { await new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done())); await (server as Server & { transport?: { close(): Promise<void> } }).transport?.close(); await pool.end(); });
  afterEach(() => { requestBodies.length = 0; });

  function records(streaming: boolean) {
    const operationRecords = streaming
      ? [{ operation: "story" as const, streaming: false }, { operation: "story" as const, streaming: true }]
      : ["story", "choices", "continuity_review"].map((operation) => ({ operation: operation as "story" | "choices" | "continuity_review", streaming: false }));
    return operationRecords.map(({ operation, streaming: verifiedStreaming }) => ({
      version: 1 as const, providerType: "openrouter" as const, endpointIdentity, model,
      routeConfigHash: capabilityRouteConfigHash({ textResponseFormatPolicy: "required", ...(streaming ? { streaming: true } : {}) }),
      adapterProtocol: "text-schema-adapter-v1" as const, operation,
      schemaHash: getProviderOutputSchema(operation).schemaHash, streaming: verifiedStreaming,
      verifiedAt: "2026-09-01T00:00:00.000Z", expiresAt: "2026-09-30T00:00:00.000Z", providerRoutingSlugs: ["verified-route"], nativeOpenTrackerObjects: true
    }));
  }

  async function fixture(policy: "auto" | "required", streaming = false) {
    const address = server.address(); if (!address || typeof address === "string") throw new Error("failure provider did not bind");
    const configuration = { textResponseFormatPolicy: policy, ...(streaming ? { streaming: true } : {}) };
    const provider = await createProvider(pool, { name: `response-contract-failure-${randomUUID()}`, providerType: "openrouter", providerRole: "text", baseUrl: `http://127.0.0.1:${address.port}/v1`, defaultModel: model, contextWindowTokens: 65_536, maxOutputTokens: 4_096, temperature: 0, enabled: true, configuration, apiKey: "test" }, credentialSecret);
    const legacy = JSON.parse(await readFile(resolve("tests/fixtures/legacy-story.json"), "utf8"));
    legacy.world.title = `response-contract-failure-${randomUUID()}`;
    const imported = await importLegacyStory(pool, storyImportRequestSchema.parse({ sourceName: "response-contract-failure.story", story: legacy }));
    await pool.query("UPDATE campaign_story_memory_enrollments SET review_mode='off' WHERE campaign_id=$1", [imported.campaignId]);
    const apiGraph = createApiProviderApplicationComposition(pool, { credentialSecret, transport: currentIntegrationProviderTransport(), schemaVerifications: policy === "required" ? records(streaming) : [], schemaVerificationDigest: digest, clock: () => verificationNow });
    const application = createApiGenerationApplication(pool, apiGraph.generation, undefined, { installedCapability: "r3", enforceEnabled: true });
    const job = await application.enqueueAppend({ ownerUserId, campaignId: imported.campaignId }, generationRequestSchema.parse({ action: "Open the observatory archive.", providerProfileId: provider.id, idempotencyKey: randomUUID(), context: { budgetTokens: 16_000, compression: "full", recentTurns: 8 } }));
    const workerGraph = createWorkerProviderApplicationComposition(pool, { credentialSecret, transport: currentIntegrationProviderTransport(), schemaVerifications: policy === "required" ? records(streaming) : [], schemaVerificationDigest: digest, clock: () => verificationNow });
    const collaborators = createGenerationExecutionCollaborators(pool, createApiIllustrationApplication(pool, workerGraph.illustration), apiMemoryApplication(pool, credentialSecret), workerGraph.generation);
    return { application, campaignId: imported.campaignId, job, collaborators };
  }

  async function authority(campaignId: string) {
    return (await pool.query(`SELECT (SELECT count(*)::int FROM turns WHERE campaign_id=$1 AND accepted_at IS NOT NULL) AS accepted, (SELECT to_jsonb(cs) FROM campaign_state cs WHERE cs.campaign_id=$1) AS state, (SELECT count(*)::int FROM campaign_canonical_facts WHERE campaign_id=$1) AS facts, (SELECT count(*)::int FROM chronicle_jobs WHERE campaign_id=$1) AS chronicle`, [campaignId])).rows[0];
  }

  async function executeOnce(value: Awaited<ReturnType<typeof fixture>>) {
    const repository = createPostgresGenerationExecutionRepository(pool);
    const workerId = `response-contract-failure-${randomUUID()}`;
    const claim = await repository.claimNext({ workerId, leaseSeconds: 30 });
    expect(claim?.jobId).toBe(value.job.id);
    await expect(createGenerationExecutor({ pool, repository, collaborators: value.collaborators }).execute({ claim: claim!, workerId, leaseSeconds: 30 })).resolves.toBe(true);
    return repository;
  }

  it("persists a verified strict schema rejection once with exact private request evidence and no accepted mutation", async () => {
    scenario = "schema_rejection";
    const value = await fixture("required"); const before = await authority(value.campaignId);
    const repository = await executeOnce(value);
    const row = await pool.query<{ status: string; orchestrationPrivate: Record<string, any> }>("SELECT status,orchestration_private AS \"orchestrationPrivate\" FROM generation_jobs WHERE id=$1", [value.job.id]);
    const privateState = row.rows[0]!.orchestrationPrivate;
    const failure = privateState.preparedResponseFailures[0]; const invocation = privateState.responseContractInvocations[0];
    expect(row.rows[0]!.status).toBe("failed");
    expect(privateState.frozenResponseContracts).toMatchObject({ queuedPolicy: { policy: "required" }, contracts: { "story:nonstream": { mode: "json_schema" } } });
    expect(failure).toMatchObject({ responseId: "schema-400-id", requestBody: requestBodies[0], requestPayloadHash: createHash("sha256").update(requestBodies[0]!).digest("hex"), returnedModel: "observed-schema-model", returnedProviderRoute: "observed-schema-route", diagnosticCode: "provider_schema_invalid" });
    expect(invocation).toMatchObject({ status: "completed", response: { returnedModel: "observed-schema-model", returnedProviderRoute: "observed-schema-route", diagnosticCode: "provider_schema_invalid" } });
    expect(await authority(value.campaignId)).toEqual(before);
    expect(JSON.stringify(await value.application.getJob({ ownerUserId, jobId: value.job.id }))).not.toContain(canary);
    expect(await repository.claimNext({ workerId: `response-contract-failure-reclaim-${randomUUID()}`, leaseSeconds: 30 })).toBeNull();
    expect(requestBodies).toHaveLength(1);
  }, 60_000);

  it("persists an auto JSON-object refusal with finite observed provenance and never redispatches it", async () => {
    scenario = "refusal";
    const value = await fixture("auto"); const before = await authority(value.campaignId);
    await executeOnce(value);
    const row = await pool.query<{ status: string; orchestrationPrivate: Record<string, any> }>("SELECT status,orchestration_private AS \"orchestrationPrivate\" FROM generation_jobs WHERE id=$1", [value.job.id]);
    const failure = row.rows[0]!.orchestrationPrivate.preparedResponseFailures[0];
    expect(row.rows[0]!.status).toBe("failed");
    expect(row.rows[0]!.orchestrationPrivate.frozenResponseContracts).toMatchObject({ queuedPolicy: { policy: "auto" }, contracts: { "story:nonstream": { mode: "json_object" } } });
    expect(failure).toMatchObject({ responseId: "refusal-id", requestBody: requestBodies[0], requestPayloadHash: createHash("sha256").update(requestBodies[0]!).digest("hex"), returnedModel: "observed-refusal-model", returnedProviderRoute: "observed-refusal-route", diagnosticCode: "provider_refusal" });
    expect(row.rows[0]!.orchestrationPrivate.responseContractInvocations).toEqual([expect.objectContaining({ status: "completed", response: expect.objectContaining({ diagnosticCode: "provider_refusal" }) })]);
    expect(await authority(value.campaignId)).toEqual(before);
    expect(JSON.stringify(await value.application.getJob({ ownerUserId, jobId: value.job.id }))).not.toContain(canary);
    const repository = createPostgresGenerationExecutionRepository(pool);
    expect(await repository.claimNext({ workerId: `response-contract-failure-reclaim-${randomUUID()}`, leaseSeconds: 30 })).toBeNull();
    expect(requestBodies).toHaveLength(1);
  }, 60_000);

  it("persists interrupted strict streaming content privately with its finite provenance and no accepted mutation", async () => {
    scenario = "partial_stream";
    const value = await fixture("required", true); const before = await authority(value.campaignId);
    await executeOnce(value);
    const row = await pool.query<{ status: string; orchestrationPrivate: Record<string, any> }>("SELECT status,orchestration_private AS \"orchestrationPrivate\" FROM generation_jobs WHERE id=$1", [value.job.id]);
    const failure = row.rows[0]!.orchestrationPrivate.preparedResponseFailures[0];
    expect(row.rows[0]!.status).toBe("failed");
    expect(row.rows[0]!.orchestrationPrivate.frozenResponseContracts).toMatchObject({ queuedPolicy: { policy: "required", invocationKeys: ["story:nonstream", "story:stream"] }, contracts: { "story:stream": { mode: "json_schema", streaming: true } } });
    expect(failure).toMatchObject({ responseId: "partial-stream-id", requestBody: requestBodies[0], requestPayloadHash: createHash("sha256").update(requestBodies[0]!).digest("hex"), partialContent: `partial ${canary}`, returnedModel: "observed-stream-model", returnedProviderRoute: "observed-stream-route", diagnosticCode: null });
    expect(row.rows[0]!.orchestrationPrivate.responseContractInvocations).toEqual([expect.objectContaining({ status: "completed", response: expect.objectContaining({ returnedModel: "observed-stream-model", returnedProviderRoute: "observed-stream-route", diagnosticCode: null }) })]);
    expect(await authority(value.campaignId)).toEqual(before);
    expect(JSON.stringify(await value.application.getJob({ ownerUserId, jobId: value.job.id }))).not.toContain(canary);
    const repository = createPostgresGenerationExecutionRepository(pool);
    expect(await repository.claimNext({ workerId: `response-contract-failure-reclaim-${randomUUID()}`, leaseSeconds: 30 })).toBeNull();
    expect(requestBodies).toHaveLength(1);
  }, 60_000);
});
