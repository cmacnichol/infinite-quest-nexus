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
import { saveStoryMemoryEnrollment } from "../../packages/database/src/story-memory-policy-repository.js";
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
const credentialSecret = "strict-operation-contract-fixture-secret";
const digest = "d".repeat(64);
const model = "strict-operation-model";
const configuration = { textResponseFormatPolicy: "required" };
const verificationNow = Date.parse("2026-09-18T12:00:00.000Z");

function story(choices = ["Wait.", "Wait.", "Listen.", "Leave."]) {
  return JSON.stringify({ narration: "Mira waits at the observatory.", choices, custom_action_suggestion: "Study the lantern.", scratchpad: "private fixture", tracker_updates: [], image_prompt: "Fixture relay.", continuity_summary: "Mira waits at the observatory.", canonical_facts: [], superseded_facts: [], canonical_fact_updates: [], open_threads: [] });
}

integration("strict response-contract operation workflow", () => {
  let pool: DatabasePool;
  let server: Server;
  let ownerUserId = "";
  let providerId = "";
  let endpointIdentity = "";
  const requests: string[] = [];
  let reviewCalls = 0;
  let primaryHasDuplicateChoices = true;
  let eventCoverageSequence: boolean[] = [];
  let sceneCoverageSequence: boolean[] = [];

  beforeAll(async () => {
    pool = createDatabasePool(databaseUrl!, 6);
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
      request.setEncoding("utf8"); request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        if (request.url?.endsWith("/embeddings")) {
          const input = JSON.parse(body) as { input?: unknown };
          const documents = Array.isArray(input.input) ? input.input : [input.input];
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ object: "list", model, data: documents.map((_document, index) => ({ object: "embedding", index, embedding: [0.25, 0.75] })), usage: { prompt_tokens: documents.length, total_tokens: documents.length } }));
          return;
        }
        if (!request.url?.endsWith("/chat/completions")) {
          response.writeHead(404, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: { code: "fixture_route_not_found" } }));
          return;
        }
        requests.push(body);
        const parsed = JSON.parse(body) as { messages: Array<{ content: string }> };
        const input = JSON.parse(parsed.messages[1]!.content) as Record<string, unknown>;
        const evidence = Array.isArray(input.evidence) ? input.evidence[0] as { id: string; content: string } | undefined : undefined;
        const system = parsed.messages[0]?.content || "";
        const content = (input.phase === "before" || input.phase === "after") && Array.isArray(input.triggers)
          ? JSON.stringify({ activated_trigger_ids: input.triggers.map((trigger: { id: string }) => trigger.id), reasons: {} })
          : input.task === "Determine whether the narration includes all concrete required beats without contradiction."
            ? JSON.stringify((() => { const covered = sceneCoverageSequence.shift() ?? true; return { covered, missing_required_beats: covered ? [] : ["The requested scene beat is absent."], contradictions: [] }; })())
            : system.includes("validate whether generated fiction") && Array.isArray(input.required_events)
              ? JSON.stringify((() => { const covered = eventCoverageSequence.shift() ?? true; return { event_results: input.required_events.map((event: { event_id: string }) => ({ event_id: event.event_id, covered, missing_required_beats: covered ? [] : ["The bell must ring."], contradictions: [] })) }; })())
          : system.includes("complete an already validated adventure turn") || body.includes("Rewrite the complete story JSON so the narration visibly dramatizes every required scene beat")
            ? story(["Continue.", "Wait.", "Listen.", "Leave."]).replace("Mira waits at the observatory.", "Mira waits at the observatory.\n\nThe bell rings as the keeper arrives.")
          : input.protocol === "story-continuity-review-v1"
          ? JSON.stringify({ version: "story-continuity-review-v1", verdict: reviewCalls++ === 0 ? "conflict" : "pass", findings: reviewCalls === 1 ? [{ kind: "contradiction", category: "location", severity: "contradiction", basis: { kind: "source", evidenceId: evidence?.id ?? "missing", quote: evidence?.content.slice(0, 20) ?? "missing" }, output: { path: "/narration", start: 0, end: 4, quote: "Mira" }, explanation: "Fixture conflict." }] : [] })
          : input.protocol === "story-continuity-repair-v1" ? story(["Continue.", "Wait.", "Listen.", "Leave."])
            : body.includes("final_narration") ? JSON.stringify({ choices: ["Continue.", "Wait.", "Listen.", "Leave."], custom_action_suggestion: "Study the lantern." })
              : story(primaryHasDuplicateChoices ? undefined : ["Continue.", "Wait.", "Listen.", "Leave."]);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ id: randomUUID(), model, provider: "strict-route", choices: [{ message: { content }, finish_reason: "stop" }], usage: { prompt_tokens: 80, completion_tokens: 30, total_tokens: 110 } }));
      });
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address(); if (!address || typeof address === "string") throw new Error("strict provider did not bind");
    const baseUrl = `http://127.0.0.1:${address.port}/v1`;
    endpointIdentity = createHash("sha256").update(baseUrl).digest("hex");
    providerId = (await createProvider(pool, { name: `strict operations ${randomUUID()}`, providerType: "openrouter", providerRole: "text", baseUrl, defaultModel: model, contextWindowTokens: 65_536, maxOutputTokens: 4_096, temperature: 0, enabled: true, configuration, apiKey: "test" }, credentialSecret)).id;
    (server as Server & { transport?: { close(): Promise<void> } }).transport = transport;
  });

  afterAll(async () => { await new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done())); await (server as Server & { transport?: { close(): Promise<void> } }).transport?.close(); await pool.end(); });
  afterEach(() => { requests.length = 0; reviewCalls = 0; primaryHasDuplicateChoices = true; eventCoverageSequence = []; sceneCoverageSequence = []; });

  function records() {
    return (["story", "choices", "continuity_review"] as const).map((operation) => ({
      version: 1 as const, providerType: "openrouter" as const, endpointIdentity, model,
      routeConfigHash: capabilityRouteConfigHash(configuration), adapterProtocol: "text-schema-adapter-v1" as const,
      operation, schemaHash: getProviderOutputSchema(operation).schemaHash, streaming: false,
      verifiedAt: "2026-09-01T00:00:00.000Z", expiresAt: "2026-09-30T00:00:00.000Z",
      providerRoutingSlugs: ["strict-route"], nativeOpenTrackerObjects: true
    }));
  }

  async function enqueue(storyOnly = true) {
    const fixture = JSON.parse(await readFile(resolve("tests/fixtures/legacy-story.json"), "utf8"));
    fixture.world.title = `strict operations ${randomUUID()}`;
    const imported = await importLegacyStory(pool, storyImportRequestSchema.parse({ sourceName: "strict-operations.story", story: fixture }));
    if (storyOnly) await pool.query("UPDATE campaigns SET turn_control_style='flexible_scene' WHERE id=$1", [imported.campaignId]);
    await saveStoryMemoryEnrollment(pool, { ownerUserId, campaignId: imported.campaignId }, { capability: "r3", reviewMode: "enforce" }, { installedCapability: "r3", enforceEnabled: true });
    const apiGraph = createApiProviderApplicationComposition(pool, { credentialSecret, transport: currentIntegrationProviderTransport(), schemaVerifications: records(), schemaVerificationDigest: digest, clock: () => verificationNow });
    const application = createApiGenerationApplication(pool, apiGraph.generation, undefined, { installedCapability: "r3", enforceEnabled: true });
    const job = await application.enqueueAppend({ ownerUserId, campaignId: imported.campaignId }, generationRequestSchema.parse({ action: "Wait at the observatory.", requestedInputMode: "scene", resolvedInputMode: "scene", inputModeSource: "explicit", providerProfileId: providerId, idempotencyKey: randomUUID(), context: { budgetTokens: 32_000, compression: "full", recentTurns: 8 } }));
    return { application, job, campaignId: imported.campaignId };
  }

  it("uses verified strict schemas for primary, choice repair, continuity review, and semantic repair", async () => {
    const fixture = await enqueue();
    const workerGraph = createWorkerProviderApplicationComposition(pool, { credentialSecret, transport: currentIntegrationProviderTransport(), schemaVerifications: records(), schemaVerificationDigest: digest, clock: () => verificationNow });
    const collaborators = createGenerationExecutionCollaborators(pool, createApiIllustrationApplication(pool, workerGraph.illustration), apiMemoryApplication(pool, credentialSecret), workerGraph.generation);
    const repository = createPostgresGenerationExecutionRepository(pool);
    const workerId = `strict-operations-${randomUUID()}`;
    const claim = await repository.claimNext({ workerId, leaseSeconds: 30 });
    await expect(createGenerationExecutor({ pool, repository, collaborators }).execute({ claim: claim!, workerId, leaseSeconds: 30 })).resolves.toBe(true);
    const choiceReview = await fixture.application.getReview({ ownerUserId, jobId: fixture.job.id });
    expect(choiceReview).toMatchObject({ stage: "choices", state: "pending" });
    await fixture.application.decideReview({ ownerUserId, jobId: fixture.job.id }, {
      reviewId: choiceReview.reviewId, revision: choiceReview.revision, decision: "retry"
    });
    const repairWorkerId = `strict-operations-repair-${randomUUID()}`;
    const repairClaim = await repository.claimNext({ workerId: repairWorkerId, leaseSeconds: 30 });
    await expect(createGenerationExecutor({ pool, repository, collaborators }).execute({ claim: repairClaim!, workerId: repairWorkerId, leaseSeconds: 30 })).resolves.toBe(true);
    const continuityReview = await fixture.application.getReview({ ownerUserId, jobId: fixture.job.id });
    expect(continuityReview).toMatchObject({ stage: "continuity", state: "pending" });
    await fixture.application.decideReview({ ownerUserId, jobId: fixture.job.id }, {
      reviewId: continuityReview.reviewId, revision: continuityReview.revision, decision: "retry"
    });
    const semanticWorkerId = `strict-operations-semantic-${randomUUID()}`;
    const semanticClaim = await repository.claimNext({ workerId: semanticWorkerId, leaseSeconds: 30 });
    await expect(createGenerationExecutor({ pool, repository, collaborators }).execute({ claim: semanticClaim!, workerId: semanticWorkerId, leaseSeconds: 30 })).resolves.toBe(true);
    const row = await pool.query<{ status: string; generationPolicy: { playMode: string }; orchestrationPrivate: Record<string, any> }>("SELECT status,generation_policy AS \"generationPolicy\",orchestration_private AS \"orchestrationPrivate\" FROM generation_jobs WHERE id=$1", [fixture.job.id]);
    expect(row.rows[0]?.status).toBe("completed");
    expect(row.rows[0]!.generationPolicy.playMode).toBe("story_only");
    expect(row.rows[0]!.orchestrationPrivate.queuedResponsePolicy.invocationKeys).toEqual(["story:nonstream", "choices:nonstream", "continuity_review:nonstream"]);
    const invocations = row.rows[0]!.orchestrationPrivate.responseContractInvocations as Array<{ operation: string; requestPayloadHash: string }>;
    expect(row.rows[0]!.orchestrationPrivate.generationReview?.decisionJournal).toEqual(expect.arrayContaining([
      expect.objectContaining({ reviewId: choiceReview.reviewId, revision: choiceReview.revision, decision: "retry" }),
      expect.objectContaining({ reviewId: continuityReview.reviewId, revision: continuityReview.revision, decision: "retry" })
    ]));
    const expectedOperations = ["story_generation", "story_choice_repair", "story_continuity_review", "story_continuity_repair", "story_continuity_review"];
    expect(invocations.map((entry) => entry.operation)).toEqual(expectedOperations);
    const expectedSchemas = ["story", "choices", "continuity_review", "story", "continuity_review"] as const;
    expect(requests).toHaveLength(expectedSchemas.length);
    for (const [index, body] of requests.entries()) {
      const wire = JSON.parse(body);
      const schema = getProviderOutputSchema(expectedSchemas[index]!);
      expect(wire.model).toBe(model);
      expect(wire.response_format).toEqual({ type: "json_schema", json_schema: { name: schema.name, strict: true, schema: schema.schema } });
      expect(wire.provider).toEqual({ require_parameters: true, only: ["strict-route"] });
      expect(invocations[index]!.requestPayloadHash).toBe(createHash("sha256").update(body).digest("hex"));
    }
  }, 60_000);

  it("reclaims a completed strict primary audit without a usable result and makes zero new provider calls", async () => {
    const fixture = await enqueue();
    const workerGraph = createWorkerProviderApplicationComposition(pool, { credentialSecret, transport: currentIntegrationProviderTransport(), schemaVerifications: records(), schemaVerificationDigest: digest, clock: () => verificationNow });
    const collaborators = createGenerationExecutionCollaborators(pool, createApiIllustrationApplication(pool, workerGraph.illustration), apiMemoryApplication(pool, credentialSecret), workerGraph.generation);
    const repository = createPostgresGenerationExecutionRepository(pool);
    const workerId = `strict-audit-crash-a-${randomUUID()}`;
    const firstClaim = await repository.claimNext({ workerId, leaseSeconds: 30 });
    let interrupted = false;
    const crashingRepository = {
      ...repository,
      async completeResponseContractInvocation(...args: Parameters<NonNullable<typeof repository.completeResponseContractInvocation>>) {
        const completed = await repository.completeResponseContractInvocation!(...args);
        if (!interrupted && completed?.status === "completed") {
          interrupted = true;
          await pool.query("UPDATE generation_jobs SET lease_expires_at=now()-interval '1 second' WHERE id=$1", [fixture.job.id]);
          throw Object.assign(new Error("Injected termination after provider response audit completion."), { code: "generation_cancelled" });
        }
        return completed;
      }
    };
    await expect(createGenerationExecutor({ pool, repository: crashingRepository, collaborators })
      .execute({ claim: firstClaim!, workerId, leaseSeconds: 30 })).resolves.toBe(true);
    expect(interrupted).toBe(true);
    const beforeReclaim = requests.length;
    const crashed = await pool.query<{ orchestrationPrivate: Record<string, any> }>("SELECT orchestration_private AS \"orchestrationPrivate\" FROM generation_jobs WHERE id=$1", [fixture.job.id]);
    expect(crashed.rows[0]!.orchestrationPrivate.responseContractInvocations).toEqual([
      expect.objectContaining({ operation: "story_generation", status: "completed" })
    ]);
    expect(crashed.rows[0]!.orchestrationPrivate.primaryResult).toBeUndefined();
    const reclaimWorker = `strict-audit-crash-b-${randomUUID()}`;
    const reclaim = await repository.claimNext({ workerId: reclaimWorker, leaseSeconds: 30 });
    await expect(createGenerationExecutor({ pool, repository, collaborators })
      .execute({ claim: reclaim!, workerId: reclaimWorker, leaseSeconds: 30 })).resolves.toBe(true);
    expect(requests).toHaveLength(beforeReclaim);
    const result = await pool.query<{ status: string; errorCode: string | null }>("SELECT status,error_code AS \"errorCode\" FROM generation_jobs WHERE id=$1", [fixture.job.id]);
    expect(result.rows[0]).toMatchObject({ status: "recoverable", errorCode: "generation_review_required" });
  }, 60_000);

  it("uses the strict story contract for an event extension after the exempt event assessment", async () => {
    const fixture = await enqueue(false);
    primaryHasDuplicateChoices = false;
    reviewCalls = 1;
    eventCoverageSequence = [true, true];
    const triggerId = randomUUID();
    await pool.query("UPDATE campaign_state SET event_triggers=$2::jsonb WHERE campaign_id=$1", [fixture.campaignId, JSON.stringify([{ id: triggerId, label: "Keeper arrival", timing: "after", condition: "Mira waits.", effect: "The bell rings as the keeper arrives.", addTextAfter: true, triggeredCount: 0, lastTriggeredTurn: null, lastTriggeredAt: null }])]);
    const workerGraph = createWorkerProviderApplicationComposition(pool, { credentialSecret, transport: currentIntegrationProviderTransport(), schemaVerifications: records(), schemaVerificationDigest: digest, clock: () => verificationNow });
    const collaborators = createGenerationExecutionCollaborators(pool, createApiIllustrationApplication(pool, workerGraph.illustration), apiMemoryApplication(pool, credentialSecret), workerGraph.generation);
    const repository = createPostgresGenerationExecutionRepository(pool);
    const workerId = `strict-extension-${randomUUID()}`;
    const claim = await repository.claimNext({ workerId, leaseSeconds: 30 });
    await expect(createGenerationExecutor({ pool, repository, collaborators }).execute({ claim: claim!, workerId, leaseSeconds: 30 })).resolves.toBe(true);
    expect(await fixture.application.getJob({ ownerUserId, jobId: fixture.job.id })).toMatchObject({ status: "completed" });
    const saved = (await pool.query<{ orchestrationPrivate: Record<string, any> }>("SELECT orchestration_private AS \"orchestrationPrivate\" FROM generation_jobs WHERE id=$1", [fixture.job.id])).rows[0]!.orchestrationPrivate;
    const invocations = saved.responseContractInvocations as Array<{ operation: string; requestPayloadHash: string }>;
    expect(invocations.map((entry) => entry.operation)).toEqual(["story_generation", "event_extension", "story_continuity_review"]);
    const extensionIndex = invocations.findIndex((entry) => entry.operation === "event_extension");
    const extensionBody = requests.find((body) => JSON.parse(body).messages[0].content.includes("complete an already validated adventure turn"));
    expect(extensionBody).toBeDefined();
    const wire = JSON.parse(extensionBody!);
    const schema = getProviderOutputSchema("story");
    expect(wire).toMatchObject({ model, response_format: { type: "json_schema", json_schema: { name: schema.name, strict: true, schema: schema.schema } }, provider: { require_parameters: true, only: ["strict-route"] } });
    expect(invocations[extensionIndex]!.requestPayloadHash).toBe(createHash("sha256").update(extensionBody!).digest("hex"));
  }, 60_000);

  it("uses one strict scene rewrite and does not redispatch it after a response-captured crash", async () => {
    const fixture = await enqueue(false);
    primaryHasDuplicateChoices = false;
    reviewCalls = 1;
    sceneCoverageSequence = [false, false];
    const workerGraph = createWorkerProviderApplicationComposition(pool, { credentialSecret, transport: currentIntegrationProviderTransport(), schemaVerifications: records(), schemaVerificationDigest: digest, clock: () => verificationNow });
    const collaborators = createGenerationExecutionCollaborators(pool, createApiIllustrationApplication(pool, workerGraph.illustration), apiMemoryApplication(pool, credentialSecret), workerGraph.generation);
    const repository = createPostgresGenerationExecutionRepository(pool);
    const initialWorker = `strict-scene-gate-${randomUUID()}`;
    const initialClaim = await repository.claimNext({ workerId: initialWorker, leaseSeconds: 30 });
    await expect(createGenerationExecutor({ pool, repository, collaborators }).execute({ claim: initialClaim!, workerId: initialWorker, leaseSeconds: 30 })).resolves.toBe(true);
    expect(await fixture.application.getJob({ ownerUserId, jobId: fixture.job.id })).toMatchObject({ status: "recoverable", errorCode: "generation_review_required" });
    const gate = await fixture.application.getReview({ ownerUserId, jobId: fixture.job.id });
    expect(gate).toMatchObject({ stage: "scene_coverage", state: "pending" });
    await fixture.application.decideReview({ ownerUserId, jobId: fixture.job.id }, { reviewId: gate.reviewId, revision: gate.revision, decision: "retry" });
    let interrupted = false;
    const crashingRepository = { ...repository, async saveOrchestration(scope: Parameters<typeof repository.saveOrchestration>[0], value: Parameters<typeof repository.saveOrchestration>[1]) {
      const repair = (value as { sceneCoverageRepair?: { status?: string } }).sceneCoverageRepair;
      if (!interrupted && repair?.status === "validated") {
        interrupted = true;
        await pool.query("UPDATE generation_jobs SET lease_expires_at=now()-interval '1 second' WHERE id=$1", [fixture.job.id]);
        throw Object.assign(new Error("Injected termination after strict scene rewrite response."), { code: "generation_cancelled" });
      }
      return repository.saveOrchestration(scope, value);
    } };
    const rewriteWorker = `strict-scene-rewrite-${randomUUID()}`;
    const rewriteClaim = await repository.claimNext({ workerId: rewriteWorker, leaseSeconds: 30 });
    await expect(createGenerationExecutor({ pool, repository: crashingRepository, collaborators }).execute({ claim: rewriteClaim!, workerId: rewriteWorker, leaseSeconds: 30 })).resolves.toBe(true);
    expect(interrupted).toBe(true);
    const rewriteBodies = requests.filter((body) => body.includes("Rewrite the complete story JSON so the narration visibly dramatizes every required scene beat"));
    expect(rewriteBodies).toHaveLength(1);
    const strictRewrite = JSON.parse(rewriteBodies[0]!);
    const schema = getProviderOutputSchema("story");
    expect(strictRewrite).toMatchObject({ model, response_format: { type: "json_schema", json_schema: { name: schema.name, strict: true, schema: schema.schema } }, provider: { require_parameters: true, only: ["strict-route"] } });
    const beforeReclaim = requests.length;
    const reclaimWorker = `strict-scene-reclaim-${randomUUID()}`;
    const reclaim = await repository.claimNext({ workerId: reclaimWorker, leaseSeconds: 30 });
    await expect(createGenerationExecutor({ pool, repository, collaborators }).execute({ claim: reclaim!, workerId: reclaimWorker, leaseSeconds: 30 })).resolves.toBe(true);
    expect(requests).toHaveLength(beforeReclaim);
    const saved = (await pool.query<{ orchestrationPrivate: Record<string, any> }>("SELECT orchestration_private AS \"orchestrationPrivate\" FROM generation_jobs WHERE id=$1", [fixture.job.id])).rows[0]!.orchestrationPrivate;
    const invocation = (saved.responseContractInvocations as Array<{ operation: string; requestPayloadHash: string }>).find((entry) => entry.operation === "scene_coverage_rewrite");
    expect(invocation?.requestPayloadHash).toBe(createHash("sha256").update(rewriteBodies[0]!).digest("hex"));
  }, 60_000);
});
