import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { generationJobSnapshotSchema, generationRequestSchema, generationRetryLatestRequestSchema, generationStreamSnapshotSchema } from "../../packages/contracts/src/generation.js";
import { sceneCoverageReplayResultHash } from "../../packages/contracts/src/generation-response-contract.js";
import { deriveTextExecutionPlan, textExecutionRouteBasisHash } from "../../packages/contracts/src/text-execution-plan.js";
import { storyImportRequestSchema } from "../../packages/contracts/src/imports.js";
import { getProviderOutputSchema } from "../../packages/story-engine/src/provider-output-schema.js";
import { getProviderOutputSchemaV2, type ProviderOutputSchemaOperationV2 } from "../../packages/contracts/src/provider-output-schema.js";
import { createDatabasePool, initialOwnerId, type DatabasePool } from "../../packages/database/src/pool.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { createPostgresGenerationExecutionRepository } from "../../packages/database/src/generation-execution-repository.js";
import { createProviderCostRepository } from "../../packages/database/src/cost-repository.js";
import { saveStoryMemoryEnrollment } from "../../packages/database/src/story-memory-policy-repository.js";
import { createApiGenerationApplication } from "../../services/runtime/src/generation-api-composition.js";
import { createGenerationExecutionCollaborators } from "../../services/runtime/src/generation-worker-composition.js";
import { createGenerationExecutor, responseContractInvocationDetails } from "../../services/runtime/src/generation-executor-adapter.js";
import { createApiIllustrationApplication } from "../../services/runtime/src/illustration-composition.js";
import { createApiProviderApplicationComposition, createWorkerProviderApplicationComposition } from "../../services/runtime/src/provider-application-composition.js";
import { capabilityRouteConfigHash } from "../../services/runtime/src/provider-capability-cache.js";
import { loadSchemaVerificationFile } from "../../services/runtime/src/provider-schema-verification.js";
import { createProvider } from "../helpers/provider-application-fixtures.js";
import { importLegacyStory, syncPlayerCampaignConfig } from "../helpers/memory-aware-services.js";
import { apiMemoryApplication } from "../helpers/memory-applications.js";
import { installIntegrationProviderTransport, currentIntegrationProviderTransport } from "./provider-transport-test-helper.js";
import { logger } from "../../packages/logger/src/index.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
const credentialSecret = "response-contract-failure-fixture-secret";
const model = "response-contract-failure-model";
const fallbackModels = ["response-contract-route-a", "response-contract-route-b"] as const;
const digest = "f".repeat(64);
const verificationNow = Date.parse("2026-09-18T12:00:00.000Z");
const canary = "PRIVATE_PROVIDER_FAILURE_CANARY";
const partialJson = `{\"narration\":\"Mira reaches the observatory.\",\"scratchpad\":\"${canary}`;
const successfulRpgAssessment = JSON.stringify({ stat_id: "insight", difficulty_modifier: 0, rationale: "The archive must be studied carefully.", favorable_outcome: "Mira recognizes the lantern's old signal.", setback_outcome: "Dust obscures the archive's first clue." });

type Scenario = "schema_rejection" | "recovery_schema_rejection" | "aux_schema_rejection" | "aux_trigger_schema_rejection" | "aux_scene_schema_rejection" | "aux_event_coverage_schema_rejection" | "aux_event_schema_rejection" | "scene_rewrite_overflow_rejection" | "historical_http_error" | "refusal" | "partial_stream" | "route_partial_stream" | "success" | "choice_repair" | "route_fallback" | "route_exhausted" | "route_invalid_identity" | "route_refusal";
const successfulStory = JSON.stringify({ narration: "Mira reaches the observatory.", choices: ["Wait.", "Listen.", "Enter.", "Leave."], custom_action_suggestion: "Study the lantern.", scratchpad: "private fixture", tracker_updates: [], image_prompt: "", continuity_summary: "Mira reaches the observatory.", canonical_facts: [], superseded_facts: [], canonical_fact_updates: [], open_threads: [] });
const duplicateChoiceStory = JSON.stringify({ ...JSON.parse(successfulStory), choices: ["Wait.", "Wait.", "Enter.", "Leave."] });
const successfulChoiceRepair = JSON.stringify({ choices: ["Search the archive.", "Follow the lantern.", "Call for the archivist.", "Leave a marker."], custom_action_suggestion: "Study the constellation chart." });
const successfulEventExtension = JSON.stringify({ ...JSON.parse(successfulStory), narration: "Mira reaches the observatory. A lantern glows beside the opened archive." });
const sceneRejectedDraftCanary = "PRIVATE_SCENE_REJECTED_DRAFT_CANARY";
const oversizedSceneStory = JSON.stringify({ ...JSON.parse(successfulStory), scratchpad: `${sceneRejectedDraftCanary}${"x".repeat(90_000)}` });

integration("response-contract provider failures", () => {
  let pool: DatabasePool;
  let server: Server;
  let ownerUserId = "";
  let endpointIdentity = "";
  let scenario: Scenario = "schema_rejection";
  let continuityReviewCalls = 0;
  let presetMetadataAvailable = true;
  let sceneCoverageResults: boolean[] = [];
  let sceneStoryRequestCount = 0;
  const requestBodies: string[] = [];
  const ownedJobIds: string[] = [];

  beforeAll(async () => {
    pool = createDatabasePool(databaseUrl!, 4);
    await migrateDatabase(pool, resolve("database/migrations"));
    ownerUserId = await initialOwnerId(pool);
    await pool.query(
      `UPDATE generation_jobs SET status='cancelled',lease_owner=NULL,lease_expires_at=NULL
        WHERE status IN ('queued','replacement_queued','assessing','generating','validating','committing','recoverable')
          AND provider_profile_id IN (SELECT id FROM provider_profiles WHERE name LIKE 'response-contract-failure-%')`
    );
    const transport = installIntegrationProviderTransport();
    server = createServer((request, response) => {
      if (request.url === "/v1/models" || request.url === "/models") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: [model, ...fallbackModels].map((id) => ({ id, context_length: 65_536, supported_parameters: ["response_format", "structured_outputs"] })) }));
        return;
      }
      if (request.url === "/presets/native-fallback" || request.url === "/v1/presets/native-fallback") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: {
          slug: "native-fallback", name: "Native fallback", status: "active",
          designated_version: { id: "native-fallback-v1", version: 1,
            system_prompt: "Native preset fallback instruction.",
            config: { models: fallbackModels, temperature: 0.25, provider: { only: ["preset-route"], data_collection: "deny" } } }
        } }));
        return;
      }
      if (request.url === "/presets/native-success" || request.url === "/v1/presets/native-success") {
        if (!presetMetadataAvailable) {
          response.writeHead(503, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: { code: "preset_metadata_unavailable" } }));
          return;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: {
          slug: "native-success", name: "Native success", status: "active",
          designated_version: { id: "native-success-v1", version: 1,
            system_prompt: "Native preset success instruction.",
            config: { model, temperature: 0.25, provider: { require_parameters: false, only: ["preset-route"] } } }
        } }));
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
        if (scenario === "route_invalid_identity" || scenario === "route_refusal") {
          const requestedModel = JSON.parse(body).model as string;
          const responseId = `charged-terminal-${scenario}-${requestBodies.length}`;
          response.writeHead(200, { "content-type": "application/json", "x-generation-id": responseId });
          response.end(JSON.stringify({ id: responseId, model: scenario === "route_invalid_identity" ? "wrong-served-model" : requestedModel,
            provider: "preset-route", choices: [{ message: scenario === "route_refusal" ? { refusal: "No response." } : { content: successfulStory }, finish_reason: scenario === "route_refusal" ? "content_filter" : "stop" }],
            usage: { prompt_tokens: 21, cost: "0.0064", currency: "USD" } }));
          return;
        }
        if ((scenario === "route_fallback" || scenario === "route_exhausted") && JSON.parse(body).model === fallbackModels[0]) {
          response.writeHead(429, { "content-type": "application/json", "retry-after": "0" });
          response.end(JSON.stringify({ error: { code: "rate_limit", message: "fixture availability rejection" } }));
          return;
        }
        if (scenario === "route_exhausted" && JSON.parse(body).model === fallbackModels[1]) {
          response.writeHead(400, { "content-type": "application/json", "x-generation-id": "fallback-schema-id" });
          response.end(JSON.stringify({ id: "fallback-schema-id", model: fallbackModels[1], provider: "preset-route",
            error: { code: "response_format_invalid", message: canary } }));
          return;
        }
        if (scenario === "historical_http_error") {
          response.writeHead(502, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: { code: "upstream_failure", message: canary } }));
          return;
        }
        const schemaName = (JSON.parse(body) as { response_format?: { json_schema?: { name?: unknown } } }).response_format?.json_schema?.name;
        if (scenario === "scene_rewrite_overflow_rejection" && schemaName === getProviderOutputSchemaV2("story").name
          && ++sceneStoryRequestCount > 1) {
          response.writeHead(400, { "content-type": "application/json", "x-generation-id": "scene-rewrite-overflow-id" });
          response.end(JSON.stringify({ id: "scene-rewrite-overflow-id", model, provider: "preset-route", error: { code: "response_format_invalid", message: canary } }));
          return;
        }
        if (scenario === "schema_rejection") {
          response.writeHead(400, { "content-type": "application/json", "x-generation-id": "schema-400-id" });
          response.end(JSON.stringify({ id: "schema-400-id", model: "observed-schema-model", provider: "observed-schema-route", error: { code: "response_format_invalid", message: canary } }));
          return;
        }
        if (scenario === "aux_schema_rejection"
            && JSON.parse(body).response_format?.json_schema?.name === getProviderOutputSchemaV2("rpg_assessment").name) {
          response.writeHead(400, { "content-type": "application/json", "x-generation-id": "aux-schema-400-id" });
          response.end(JSON.stringify({ id: "aux-schema-400-id", model: "observed-schema-model", provider: "observed-schema-route", error: { code: "response_format_invalid", message: canary } }));
          return;
        }
        if (scenario === "aux_trigger_schema_rejection"
            && JSON.parse(body).response_format?.json_schema?.name === getProviderOutputSchemaV2("event_trigger_before").name) {
          response.writeHead(400, { "content-type": "application/json", "x-generation-id": "trigger-schema-400-id" });
          response.end(JSON.stringify({ id: "trigger-schema-400-id", model: "observed-schema-model", provider: "observed-schema-route", error: { code: "response_format_invalid", message: canary } }));
          return;
        }
        if (scenario === "aux_scene_schema_rejection"
            && JSON.parse(body).response_format?.json_schema?.name === getProviderOutputSchemaV2("scene_coverage").name) {
          response.writeHead(400, { "content-type": "application/json", "x-generation-id": "scene-schema-400-id" });
          response.end(JSON.stringify({ id: "scene-schema-400-id", model: "observed-schema-model", provider: "observed-schema-route", error: { code: "response_format_invalid", message: canary } }));
          return;
        }
        if (scenario === "aux_event_coverage_schema_rejection"
            && JSON.parse(body).response_format?.json_schema?.name === getProviderOutputSchemaV2("event_coverage").name) {
          response.writeHead(400, { "content-type": "application/json", "x-generation-id": "event-coverage-schema-400-id" });
          response.end(JSON.stringify({ id: "event-coverage-schema-400-id", model: "observed-schema-model", provider: "observed-schema-route", error: { code: "response_format_invalid", message: canary } }));
          return;
        }
        if (scenario === "recovery_schema_rejection" && requestBodies.length > 1) {
          response.writeHead(400, { "content-type": "application/json", "x-generation-id": "recovery-schema-400-id" });
          response.end(JSON.stringify({ id: "recovery-schema-400-id", model: "observed-schema-model", provider: "observed-schema-route", error: { code: "response_format_invalid", message: canary } }));
          return;
        }
        if (scenario === "aux_event_schema_rejection") {
          const parsed = JSON.parse(body) as { messages?: Array<{ content?: string }> };
          const input = typeof parsed.messages?.[1]?.content === "string" ? JSON.parse(parsed.messages[1].content) as Record<string, unknown> : {};
          if (Array.isArray(input.fictional_event_instructions)) {
            response.writeHead(400, { "content-type": "application/json", "x-generation-id": "event-schema-400-id" });
            response.end(JSON.stringify({ id: "event-schema-400-id", model: "observed-schema-model", provider: "observed-schema-route", error: { code: "response_format_invalid", message: canary } }));
            return;
          }
        }
        if (scenario === "refusal") {
          response.writeHead(200, { "content-type": "application/json", "x-generation-id": "refusal-id" });
          response.end(JSON.stringify({ id: "refusal-id", model: "observed-refusal-model", provider: "observed-refusal-route", choices: [{ message: { refusal: canary }, finish_reason: "content_filter" }] }));
          return;
        }
        if (scenario === "success" || scenario === "choice_repair" || scenario === "route_fallback" || scenario === "aux_event_schema_rejection" || scenario === "aux_scene_schema_rejection" || scenario === "aux_event_coverage_schema_rejection" || scenario === "recovery_schema_rejection" || scenario === "scene_rewrite_overflow_rejection") {
          const parsed = JSON.parse(body) as {
            model?: string;
            response_format?: { json_schema?: { name?: string } };
            messages?: Array<{ content?: string }>;
            provider?: { only?: string[] };
          };
          const input = typeof parsed.messages?.[1]?.content === "string" ? JSON.parse(parsed.messages[1].content) as Record<string, unknown> : {};
          const evidence = Array.isArray(input.evidence) ? input.evidence[0] as { id?: unknown; content?: unknown } | undefined : undefined;
          const content = parsed.response_format?.json_schema?.name === getProviderOutputSchemaV2("rpg_assessment").name
            ? successfulRpgAssessment
            : parsed.response_format?.json_schema?.name === getProviderOutputSchemaV2("event_trigger_before").name
              ? JSON.stringify({ activated_trigger_ids: ["native-before"], reasons: { "native-before": "The archive opens." } })
            : parsed.response_format?.json_schema?.name === getProviderOutputSchemaV2("event_trigger_after").name
              ? JSON.stringify({ activated_trigger_ids: ["native-after"], reasons: { "native-after": "The archive opens." } })
            : parsed.response_format?.json_schema?.name === getProviderOutputSchemaV2("scene_coverage").name
              ? JSON.stringify((() => { const covered = sceneCoverageResults.shift() ?? true; return { covered, missing_required_beats: covered ? [] : ["The archive must open."], contradictions: [] }; })())
            : parsed.response_format?.json_schema?.name === getProviderOutputSchemaV2("event_coverage").name
              ? JSON.stringify({ event_results: (Array.isArray(input.required_events) ? input.required_events : []).map((event) => ({ event_id: (event as { event_id: string }).event_id, covered: true, missing_required_beats: [], contradictions: [] })) })
            : parsed.response_format?.json_schema?.name === getProviderOutputSchemaV2("choices").name
              ? successfulChoiceRepair
            : parsed.response_format?.json_schema?.name === getProviderOutputSchemaV2("continuity_review").name
              ? JSON.stringify({
                version: "story-continuity-review-v1",
                verdict: continuityReviewCalls++ === 0 ? "conflict" : "pass",
                findings: continuityReviewCalls === 1 ? [{
                  kind: "contradiction", category: "location", severity: "contradiction",
                  basis: { kind: "source", evidenceId: evidence?.id, quote: typeof evidence?.content === "string" ? evidence.content.slice(0, 20) : "missing evidence" },
                  output: { path: "/narration", start: 0, end: 4, quote: "Mira" }, explanation: "Fixture conflict."
                }] : []
              })
              : scenario === "recovery_schema_rejection" ? JSON.stringify({ narration: "Incomplete fixture response." })
                : Array.isArray(input.fictional_event_instructions) ? successfulEventExtension
                : scenario === "choice_repair" ? duplicateChoiceStory : successfulStory;
          const selectedContent = scenario === "scene_rewrite_overflow_rejection"
            && parsed.response_format?.json_schema?.name === getProviderOutputSchemaV2("story").name
            ? oversizedSceneStory
            : content;
          response.writeHead(200, { "content-type": "application/json", "x-generation-id": "success-id" });
          response.end(JSON.stringify({
            id: "success-id", model: parsed.model ?? model, provider: parsed.provider?.only?.[0] ?? "verified-route",
            choices: [{ message: { content: selectedContent }, finish_reason: "stop" }],
            usage: { prompt_tokens: 80, completion_tokens: 30, total_tokens: 110,
              ...(scenario === "route_fallback" ? { cost: "0.0042", currency: "USD" } : {}) }
          }));
          return;
        }
        const partialRequest = JSON.parse(body) as { model?: string; provider?: { only?: string[] } };
        response.writeHead(200, { "content-type": "text/event-stream", "x-generation-id": "partial-stream-id" });
        response.end(`data: ${JSON.stringify({
          id: "partial-stream-id",
          model: scenario === "route_partial_stream" ? partialRequest.model : "observed-stream-model",
          provider: scenario === "route_partial_stream" ? partialRequest.provider?.only?.[0] : "observed-stream-route",
          choices: [{ delta: { content: partialJson }, finish_reason: null }]
        })}\n\n`);
      });
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address(); if (!address || typeof address === "string") throw new Error("failure provider did not bind");
    endpointIdentity = createHash("sha256").update(`http://127.0.0.1:${address.port}/v1`).digest("hex");
    (server as Server & { transport?: { close(): Promise<void> } }).transport = transport;
  });

  afterAll(async () => { await new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done())); await (server as Server & { transport?: { close(): Promise<void> } }).transport?.close(); await pool.end(); });
  afterEach(async () => {
    if (ownedJobIds.length) {
      await pool.query(
        "UPDATE generation_jobs SET status='cancelled',lease_owner=NULL,lease_expires_at=NULL WHERE id=ANY($1::uuid[]) AND status IN ('queued','replacement_queued','assessing','generating','validating','committing','recoverable')",
        [ownedJobIds]
      );
      ownedJobIds.length = 0;
    }
    requestBodies.length = 0; continuityReviewCalls = 0; presetMetadataAvailable = true; sceneCoverageResults = []; sceneStoryRequestCount = 0;
  });

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

  function v2Records(streaming = false, providerType: "openrouter" | "openai_compatible" = "openrouter") {
    const operations: readonly ProviderOutputSchemaOperationV2[] = [
      "story", "choices", "continuity_review", "rpg_assessment", "event_trigger_before", "event_trigger_after", "scene_coverage", "event_coverage"
    ];
    const base = operations.map((operation) => ({
      version: 2 as const, providerType, endpointIdentity, model,
      routeConfigHash: capabilityRouteConfigHash({ textResponseFormatPolicy: "required", ...(streaming ? { streaming: true } : {}) }),
      adapterProtocol: "text-schema-adapter-v2" as const, operation,
      schemaHash: getProviderOutputSchemaV2(operation).schemaHash, streaming: false,
      verifiedAt: "2026-09-01T00:00:00.000Z", expiresAt: "2026-09-30T00:00:00.000Z", providerRoutingSlugs: providerType === "openrouter" ? ["verified-route"] : [], nativeOpenTrackerObjects: true
    }));
    return streaming ? [...base, { ...base[0]!, streaming: true }] : base;
  }

  async function fileLoadedV2Verification(streaming = false, providerType: "openrouter" | "openai_compatible" = "openrouter") {
    const directory = await mkdtemp(join(tmpdir(), "infinitequest-v2-schema-"));
    const path = join(directory, "verification.json");
    try {
      await writeFile(path, JSON.stringify(v2Records(streaming, providerType)), "utf8");
      return loadSchemaVerificationFile(path);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  async function fixture(
    policy: "legacy" | "auto" | "required",
    streaming = false,
    native = false,
    selection: "model" | "preset" | "fallback" = "model",
    options: Readonly<{ storyOnly?: boolean; scene?: boolean; rpg?: boolean; triggers?: boolean; eventExtension?: boolean; continuity?: "enforce"; contextWindowTokens?: number; providerType?: "openrouter" | "openai_compatible"; verificationProviderType?: "openrouter" | "openai_compatible" }> = {}
  ) {
    const address = server.address(); if (!address || typeof address === "string") throw new Error("failure provider did not bind");
    const configuration = { textResponseFormatPolicy: policy, ...(streaming ? { streaming: true } : {}) };
    // Keep the profile default a concrete model: imported campaigns may use it
    // for independent embedding fallback. The queued explicit selection below
    // is the preset behavior this fixture exercises.
    const provider = await createProvider(pool, { name: `response-contract-failure-${randomUUID()}`, providerType: options.providerType ?? "openrouter", providerRole: "text", baseUrl: `http://127.0.0.1:${address.port}/v1`, defaultModel: model, contextWindowTokens: options.contextWindowTokens ?? 65_536, maxOutputTokens: 4_096, temperature: 0, enabled: true, configuration, apiKey: "test" }, credentialSecret);
    const legacy = JSON.parse(await readFile(resolve("tests/fixtures/legacy-story.json"), "utf8"));
    legacy.world.title = `response-contract-failure-${randomUUID()}`;
    const imported = await importLegacyStory(pool, storyImportRequestSchema.parse({ sourceName: "response-contract-failure.story", story: legacy }));
    if (options.continuity === "enforce") {
      await saveStoryMemoryEnrollment(pool, { ownerUserId, campaignId: imported.campaignId }, { capability: "r3", reviewMode: "enforce" }, { installedCapability: "r3", enforceEnabled: true });
    } else {
      await pool.query("UPDATE campaign_story_memory_enrollments SET review_mode='off' WHERE campaign_id=$1", [imported.campaignId]);
    }
    if (options.storyOnly) await pool.query("UPDATE campaigns SET turn_control_style='flexible_scene' WHERE id=$1", [imported.campaignId]);
    if (options.rpg) {
      const currentTurn = (await pool.query<{ activeTurnNumber: number }>(
        "SELECT active_turn_number AS \"activeTurnNumber\" FROM campaigns WHERE id=$1", [imported.campaignId]
      )).rows[0]!.activeTurnNumber;
      await syncPlayerCampaignConfig(pool, imported.campaignId, {
        expectedTurnNumber: currentTurn,
        useRpgStats: true,
        suppressEventTriggers: false,
        rpgStats: [{ id: "insight", name: "Insight", value: 65, note: "Notices concealed details." }],
        eventTriggers: [], pendingEventTriggers: []
      });
    }
    if (options.triggers) {
      const currentTurn = (await pool.query<{ activeTurnNumber: number }>(
        "SELECT active_turn_number AS \"activeTurnNumber\" FROM campaigns WHERE id=$1", [imported.campaignId]
      )).rows[0]!.activeTurnNumber;
      await syncPlayerCampaignConfig(pool, imported.campaignId, {
        expectedTurnNumber: currentTurn,
        useRpgStats: false,
        suppressEventTriggers: false,
        rpgStats: [],
        eventTriggers: [
          { id: "native-before", label: "Native before", timing: "before", condition: "The archive opens.", effect: "A bell rings.", addTextAfter: false, triggeredCount: 0, lastTriggeredTurn: null, lastTriggeredAt: null },
          { id: "native-after", label: "Native after", timing: "after", condition: "The archive opens.", effect: "A lantern glows.", addTextAfter: options.eventExtension === true, triggeredCount: 0, lastTriggeredTurn: null, lastTriggeredAt: null }
        ], pendingEventTriggers: []
      });
    }
    const verification = native ? await fileLoadedV2Verification(streaming, options.verificationProviderType ?? options.providerType) : { records: policy === "required" ? records(streaming) : [], digest };
    const apiGraph = createApiProviderApplicationComposition(pool, { credentialSecret, transport: currentIntegrationProviderTransport(), schemaVerifications: verification.records, schemaVerificationDigest: verification.digest, clock: () => verificationNow });
    const application = createApiGenerationApplication(pool, apiGraph.generation, undefined, { installedCapability: "r3", enforceEnabled: true }, native);
    const request = generationRequestSchema.parse({ action: "Open the observatory archive.", providerProfileId: provider.id, ...(options.storyOnly || options.scene ? { requestedInputMode: "scene" as const, resolvedInputMode: "scene" as const, inputModeSource: "explicit" as const } : {}), ...(selection === "preset" || selection === "fallback" ? { textSelection: { kind: "openrouter_preset", slug: selection === "fallback" ? "native-fallback" : "native-success" } } : {}), idempotencyKey: randomUUID(), context: { budgetTokens: 16_000, compression: "full", recentTurns: 8 } });
    const job = await application.enqueueAppend({ ownerUserId, campaignId: imported.campaignId }, request);
    ownedJobIds.push(job.id);
    const workerGraph = createWorkerProviderApplicationComposition(pool, { credentialSecret, transport: currentIntegrationProviderTransport(), schemaVerifications: verification.records, schemaVerificationDigest: verification.digest, clock: () => verificationNow });
    const collaborators = createGenerationExecutionCollaborators(pool, createApiIllustrationApplication(pool, workerGraph.illustration), apiMemoryApplication(pool, credentialSecret), workerGraph.generation);
    return { application, campaignId: imported.campaignId, providerId: provider.id, request, job, collaborators };
  }

  async function authority(campaignId: string) {
    return (await pool.query(`SELECT (SELECT count(*)::int FROM turns WHERE campaign_id=$1 AND accepted_at IS NOT NULL) AS accepted, (SELECT to_jsonb(cs) FROM campaign_state cs WHERE cs.campaign_id=$1) AS state, (SELECT count(*)::int FROM campaign_canonical_facts WHERE campaign_id=$1) AS facts, (SELECT count(*)::int FROM chronicle_jobs WHERE campaign_id=$1) AS chronicle`, [campaignId])).rows[0];
  }

  async function executeJob(value: Awaited<ReturnType<typeof fixture>>, job: { id: string }, expectedExecution = true) {
    const repository = createPostgresGenerationExecutionRepository(pool);
    const workerId = `response-contract-failure-${randomUUID()}`;
    const claim = await repository.claimNext({ workerId, leaseSeconds: 30 });
    expect(claim?.jobId).toBe(job.id);
    await expect(createGenerationExecutor({ pool, repository, collaborators: value.collaborators }).execute({ claim: claim!, workerId, leaseSeconds: 30 })).resolves.toBe(expectedExecution);
    return repository;
  }

  async function executeOnce(value: Awaited<ReturnType<typeof fixture>>, expectedExecution = true) {
    return executeJob(value, value.job, expectedExecution);
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

  it("returns a native preset idempotency duplicate before retrying unavailable preset metadata", async () => {
    scenario = "success";
    const value = await fixture("required", false, true, "preset");
    presetMetadataAvailable = false;
    const duplicate = await value.application.enqueueAppend({ ownerUserId, campaignId: value.campaignId }, value.request);
    expect(duplicate.id).toBe(value.job.id);
    await expect(pool.query<{ count: number }>("SELECT count(*)::int AS count FROM generation_jobs WHERE campaign_id=$1", [value.campaignId]))
      .resolves.toMatchObject({ rows: [{ count: 1 }] });
    expect(requestBodies).toHaveLength(0);
  }, 60_000);

  it("keeps native v2 queue and worker failures isolated to the authorized owner and campaign", async () => {
    scenario = "schema_rejection";
    const value = await fixture("required", false, true, "model");
    const sibling = await fixture("required", false, true, "model");
    const foreignOwner = (await pool.query<{ id: string }>(
      "INSERT INTO users (display_name,status) VALUES ($1,'active') RETURNING id",
      [`response-contract foreign ${randomUUID()}`]
    )).rows[0]!.id;
    const siblingAuthorityBefore = await authority(sibling.campaignId);
    const siblingJobBefore = await pool.query<{ orchestrationPrivate: Record<string, unknown> }>(
      "SELECT orchestration_private AS \"orchestrationPrivate\" FROM generation_jobs WHERE id=$1", [sibling.job.id]
    );

    await expect(value.application.getJob({ ownerUserId: foreignOwner, jobId: value.job.id }))
      .rejects.toMatchObject({ kind: "not_found" });
    await expect(value.application.enqueueAppend({ ownerUserId: foreignOwner, campaignId: value.campaignId }, value.request))
      .rejects.toMatchObject({ kind: "not_found" });
    await executeOnce(value);

    const siblingJobAfter = await pool.query<{ status: string; orchestrationPrivate: Record<string, unknown> }>(
      "SELECT status,orchestration_private AS \"orchestrationPrivate\" FROM generation_jobs WHERE id=$1", [sibling.job.id]
    );
    expect(siblingJobAfter.rows[0]).toMatchObject({ status: "queued" });
    expect(siblingJobAfter.rows[0]!.orchestrationPrivate).toEqual(siblingJobBefore.rows[0]!.orchestrationPrivate);
    expect(await authority(sibling.campaignId)).toEqual(siblingAuthorityBefore);
    expect(requestBodies).toHaveLength(1);
  }, 60_000);

  it("loads direct-model v2 evidence from a verification file, freezes the complete closure, and fails a wrapped schema rejection without fallback", async () => {
    scenario = "schema_rejection";
    const value = await fixture("required", false, true); const before = await authority(value.campaignId);
    await executeOnce(value);
    const row = await pool.query<{ status: string; orchestrationPrivate: Record<string, any> }>(
      "SELECT status,orchestration_private AS \"orchestrationPrivate\" FROM generation_jobs WHERE id=$1",
      [value.job.id]
    );
    const privateState = row.rows[0]!.orchestrationPrivate;
    const frozen = privateState.frozenResponseContracts;
    const request = JSON.parse(requestBodies[0]!);
    expect(row.rows[0]!.status).toBe("failed");
    expect(privateState.queuedResponsePolicy).toMatchObject({ version: 2, policy: "required", admission: { basis: "model_verified" }, authority: { kind: "model_verified", model } });
    expect(frozen).toMatchObject({ version: 2, queuedPolicy: { version: 2 }, contracts: {
      "story:nonstream": { version: 2, mode: "json_schema", operation: "story" },
      "rpg_assessment:nonstream": { version: 2, operation: "rpg_assessment" },
      "event_trigger_before:nonstream": { version: 2, operation: "event_trigger_before" },
      "event_trigger_after:nonstream": { version: 2, operation: "event_trigger_after" },
      "scene_coverage:nonstream": { version: 2, operation: "scene_coverage" },
      "event_coverage:nonstream": { version: 2, operation: "event_coverage" }
    } });
    expect(frozen.queuedPolicy.invocationKeys).toEqual([
      "story:nonstream", "rpg_assessment:nonstream", "event_trigger_before:nonstream", "event_trigger_after:nonstream", "scene_coverage:nonstream", "event_coverage:nonstream"
    ]);
    expect(request.response_format).toEqual({ type: "json_schema", json_schema: {
      name: getProviderOutputSchemaV2("story").name, strict: true, schema: getProviderOutputSchemaV2("story").schema
    } });
    expect(privateState.primaryReservation.requestBody).toBe(requestBodies[0]);
    expect(privateState.preparedResponseFailures).toEqual([expect.objectContaining({ version: 2, diagnosticCode: "provider_schema_invalid", requestBody: requestBodies[0] })]);
    expect(privateState.responseContractInvocations).toEqual([expect.objectContaining({ version: 2, invocationKey: "story:nonstream", status: "completed", response: expect.objectContaining({ diagnosticCode: "provider_schema_invalid" }) })]);
    expect(privateState.lastFailureDiagnostic).toMatchObject({ code: "provider_schema_invalid" });
    expect(await authority(value.campaignId)).toEqual(before);
    expect(requestBodies).toHaveLength(1);
  }, 60_000);

  it.each(["unsafe", "throwing"] as const)("sanitizes a %s provider error name and completes the v2 invocation", async (nameKind) => {
    scenario = "success";
    const value = await fixture("required", false, true);
    const before = await authority(value.campaignId);
    const privateName = "PRIVATE_PROVIDER_NAME_CANARY";
    const providerError = Object.assign(new Error("Synthetic provider failure."), { code: "provider_transport_error" });
    Object.defineProperty(providerError, "name", {
      get: () => {
        if (nameKind === "throwing") throw new Error(privateName);
        return privateName;
      }
    });
    const infoSpy = vi.spyOn(logger, "info");
    const warnSpy = vi.spyOn(logger, "warn");
    const errorSpy = vi.spyOn(logger, "error");
    const repository = createPostgresGenerationExecutionRepository(pool);
    const workerId = `response-contract-unsafe-name-${randomUUID()}`;
    try {
      const claim = await repository.claimNext({ workerId, leaseSeconds: 30 });
      expect(claim?.jobId).toBe(value.job.id);
      await expect(createGenerationExecutor({
        pool, repository,
        collaborators: { ...value.collaborators, onProviderDispatch: () => { throw providerError; } }
      }).execute({ claim: claim!, workerId, leaseSeconds: 30 })).resolves.toBe(true);

      const row = await pool.query<{ status: string; orchestrationPrivate: Record<string, any> }>(
        'SELECT status,orchestration_private AS "orchestrationPrivate" FROM generation_jobs WHERE id=$1', [value.job.id]
      );
      expect(row.rows[0]!.orchestrationPrivate.responseContractInvocations).toEqual([
        expect.objectContaining({ version: 2, status: "completed" })
      ]);
      expect(row.rows[0]!.status).not.toBe("completed");
      expect(requestBodies).toHaveLength(0);
      expect(await authority(value.campaignId)).toEqual(before);
      const failureLogs = warnSpy.mock.calls.map(([event]) => event)
        .filter((event): event is Record<string, unknown> => typeof event === "object" && event !== null && "event" in event)
        .filter((event) => event.event === "turn_generation_provider_failed");
      expect(failureLogs).toEqual([expect.objectContaining({ errorName: "Error", errorCode: "provider_transport_error" })]);
      expect(JSON.stringify([...infoSpy.mock.calls, ...warnSpy.mock.calls, ...errorSpy.mock.calls])).not.toContain(privateName);
    } finally {
      infoSpy.mockRestore();
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }
  }, 60_000);

  it("executes a file-verified direct Model v2 append through the prepared transport with one canonical durable body", async () => {
    scenario = "success";
    const value = await fixture("required", false, true);
    await executeOnce(value);
    const row = await pool.query<{ status: string; errorCode: string | null; errorMessage: string | null; orchestrationPrivate: Record<string, any> }>(
      "SELECT status,error_code AS \"errorCode\",error_message AS \"errorMessage\",orchestration_private AS \"orchestrationPrivate\" FROM generation_jobs WHERE id=$1", [value.job.id]
    );
    const privateState = row.rows[0]!.orchestrationPrivate;
    expect(row.rows[0]!.status).toBe("completed");
    expect(requestBodies).toHaveLength(1);
    expect(privateState.primaryReservation.requestBody).toBe(requestBodies[0]);
    expect(privateState.responseContractInvocations).toEqual([
      expect.objectContaining({ version: 2, operation: "story_generation", status: "completed", requestPayloadHash: createHash("sha256").update(requestBodies[0]!).digest("hex") })
    ]);
    expect(JSON.parse(requestBodies[0]!).response_format).toEqual({ type: "json_schema", json_schema: {
      name: getProviderOutputSchemaV2("story").name, strict: true, schema: getProviderOutputSchemaV2("story").schema
    } });
  }, 60_000);

  it("executes an OpenAI-compatible direct Model with exact v2 authority", async () => {
    scenario = "success";
    const value = await fixture("required", false, true, "model", { providerType: "openai_compatible" });
    await executeOnce(value);
    const row = await pool.query<{ status: string; orchestrationPrivate: Record<string, any> }>(
      'SELECT status,orchestration_private AS "orchestrationPrivate" FROM generation_jobs WHERE id=$1', [value.job.id]
    );
    expect(row.rows[0]!.status).toBe("completed");
    expect(row.rows[0]!.orchestrationPrivate.queuedResponsePolicy.authority).toMatchObject({
      kind: "model_verified", providerType: "openai_compatible"
    });
    expect(requestBodies).toHaveLength(1);
  }, 60_000);

  it("blocks an OpenAI-compatible Model when verification names another provider type", async () => {
    scenario = "success";
    const before = (await pool.query<{ count: string }>("SELECT count(*)::text AS count FROM generation_jobs")).rows[0]!.count;
    await expect(fixture("required", false, true, "model", {
      providerType: "openai_compatible", verificationProviderType: "openrouter"
    })).rejects.toBeDefined();
    expect((await pool.query<{ count: string }>("SELECT count(*)::text AS count FROM generation_jobs")).rows[0]!.count).toBe(before);
    expect(requestBodies).toHaveLength(0);
  }, 60_000);

  it("executes a file-verified native v2 stream with the exact frozen stream schema and reserved body", async () => {
    scenario = "success";
    const value = await fixture("required", true, true);
    await executeOnce(value);
    const row = await pool.query<{ status: string; orchestrationPrivate: Record<string, any>; partialOutput: string | null }>(
      "SELECT status,partial_output AS \"partialOutput\",orchestration_private AS \"orchestrationPrivate\" FROM generation_jobs WHERE id=$1", [value.job.id]
    );
    expect(row.rows[0]!.status).toBe("completed");
    expect(requestBodies).toHaveLength(1);
    expect(row.rows[0]!.partialOutput).toBeNull();
    const body = JSON.parse(requestBodies[0]!);
    expect(body.stream).toBe(true);
    expect(body.response_format).toEqual({ type: "json_schema", json_schema: {
      name: getProviderOutputSchemaV2("story").name, strict: true, schema: getProviderOutputSchemaV2("story").schema
    } });
    expect(row.rows[0]!.orchestrationPrivate.frozenResponseContracts.contracts["story:stream"]).toMatchObject({ version: 2, streaming: true });
    expect(row.rows[0]!.orchestrationPrivate.primaryReservation.requestBody).toBe(requestBodies[0]);
    expect(row.rows[0]!.orchestrationPrivate.responseContractInvocations[0]).toMatchObject({
      version: 2, invocationKey: "story:stream", requestPayloadHash: createHash("sha256").update(requestBodies[0]!).digest("hex")
    });
  }, 60_000);

  it("propagates a wrapped auxiliary v2 schema rejection without inferring a Story response", async () => {
    scenario = "aux_schema_rejection";
    const value = await fixture("required", false, true, "model", { rpg: true });
    const before = await authority(value.campaignId);
    await executeOnce(value);
    const row = await pool.query<{ status: string; errorCode: string | null; orchestrationPrivate: Record<string, any> }>(
      "SELECT status,error_code AS \"errorCode\",orchestration_private AS \"orchestrationPrivate\" FROM generation_jobs WHERE id=$1", [value.job.id]
    );
    expect(row.rows[0]).toMatchObject({ status: "failed", errorCode: "provider_schema_invalid" });
    expect(requestBodies).toHaveLength(1);
    expect(JSON.parse(requestBodies[0]!).response_format).toEqual({ type: "json_schema", json_schema: {
      name: getProviderOutputSchemaV2("rpg_assessment").name, strict: true, schema: getProviderOutputSchemaV2("rpg_assessment").schema
    } });
    expect(row.rows[0]!.orchestrationPrivate.preparedResponseFailures).toEqual([
      expect.objectContaining({ version: 2, diagnosticCode: "provider_schema_invalid", requestBody: requestBodies[0] })
    ]);
    expect(row.rows[0]!.orchestrationPrivate.responseContractInvocations).toEqual([
      expect.objectContaining({ version: 2, operation: "rpg_assessment", status: "completed", response: expect.objectContaining({ diagnosticCode: "provider_schema_invalid" }) })
    ]);
    expect(await authority(value.campaignId)).toEqual(before);
  }, 60_000);

  it("propagates a wrapped native retried-primary schema rejection without a third inference", async () => {
    scenario = "recovery_schema_rejection";
    const value = await fixture("required", false, true, "model");
    const before = await authority(value.campaignId);
    await executeOnce(value);
    const review = await value.application.getReview({ ownerUserId, jobId: value.job.id });
    expect(review).toMatchObject({ state: "pending", canRetry: true });
    await value.application.decideReview({ ownerUserId, jobId: value.job.id }, {
      reviewId: review.reviewId, revision: review.revision, decision: "retry"
    });
    await executeOnce(value);
    const row = await pool.query<{ status: string; errorCode: string | null; orchestrationPrivate: Record<string, any> }>(
      "SELECT status,error_code AS \"errorCode\",orchestration_private AS \"orchestrationPrivate\" FROM generation_jobs WHERE id=$1", [value.job.id]
    );
    expect(row.rows[0]).toMatchObject({ status: "failed", errorCode: "provider_schema_invalid" });
    expect(requestBodies).toHaveLength(2);
    expect(row.rows[0]!.orchestrationPrivate.responseContractInvocations).toEqual([
      expect.objectContaining({ version: 2, operation: "story_generation", status: "completed" }),
      expect.objectContaining({ version: 2, operation: "story_generation", status: "completed", response: expect.objectContaining({ diagnosticCode: "provider_schema_invalid" }) })
    ]);
    for (const bodyText of requestBodies) {
      expect(JSON.parse(bodyText).response_format.json_schema.name).toBe(getProviderOutputSchemaV2("story").name);
    }
    expect(await authority(value.campaignId)).toEqual(before);
  }, 60_000);

  it("executes native v2 before and after trigger schemas with the frozen preset prompt", async () => {
    scenario = "success";
    const value = await fixture("required", false, true, "preset", { triggers: true });
    await executeOnce(value);
    const saved = await pool.query<{ status: string; orchestrationPrivate: Record<string, any> }>(
      "SELECT status,orchestration_private AS \"orchestrationPrivate\" FROM generation_jobs WHERE id=$1", [value.job.id]
    );
    expect(saved.rows[0]!.status).toBe("completed");
    expect(saved.rows[0]!.orchestrationPrivate.frozenResponseContracts.contracts).toHaveProperty("event_trigger_before:nonstream");
    expect(requestBodies).toHaveLength(4);
    const expected = ["event_trigger_before", "story", "event_trigger_after", "event_coverage"] as const;
    for (const [index, operation] of expected.entries()) {
      const body = JSON.parse(requestBodies[index]!);
      expect(body.response_format).toEqual({ type: "json_schema", json_schema: {
        name: getProviderOutputSchemaV2(operation).name, strict: true, schema: getProviderOutputSchemaV2(operation).schema
      } });
      expect(body.messages[0].content.split("Native preset success instruction.").length - 1).toBe(1);
    }
    expect(saved.rows[0]!.orchestrationPrivate.responseContractInvocations).toEqual(expect.arrayContaining(
      requestBodies.map((body) => expect.objectContaining({ version: 2, requestPayloadHash: createHash("sha256").update(body).digest("hex"), status: "completed" }))
    ));
    await expect(pool.query<{ eventTriggers: Array<{ id: string; triggeredCount: number }> }>(
      "SELECT event_triggers AS \"eventTriggers\" FROM campaign_state WHERE campaign_id=$1", [value.campaignId]
    )).resolves.toMatchObject({ rows: [{ eventTriggers: expect.arrayContaining([
      expect.objectContaining({ id: "native-before", triggeredCount: 1 })
    ]) }] });
  }, 60_000);

  it("propagates a wrapped native trigger schema rejection without later Story inference", async () => {
    scenario = "aux_trigger_schema_rejection";
    const value = await fixture("required", false, true, "preset", { triggers: true });
    const before = await authority(value.campaignId);
    await executeOnce(value);
    const row = await pool.query<{ status: string; errorCode: string | null; orchestrationPrivate: Record<string, any> }>(
      "SELECT status,error_code AS \"errorCode\",orchestration_private AS \"orchestrationPrivate\" FROM generation_jobs WHERE id=$1", [value.job.id]
    );
    expect(row.rows[0]).toMatchObject({ status: "failed", errorCode: "provider_schema_invalid" });
    expect(requestBodies).toHaveLength(1);
    expect(JSON.parse(requestBodies[0]!).response_format.json_schema.name).toBe(getProviderOutputSchemaV2("event_trigger_before").name);
    expect(row.rows[0]!.orchestrationPrivate.preparedResponseFailures).toEqual([
      expect.objectContaining({ version: 2, diagnosticCode: "provider_schema_invalid", requestBody: requestBodies[0] })
    ]);
    expect(await authority(value.campaignId)).toEqual(before);
  }, 60_000);

  it("commits a native v2 event extension through the frozen Story schema and exact prepared body", async () => {
    scenario = "success";
    const value = await fixture("required", false, true, "preset", { triggers: true, eventExtension: true });
    await executeOnce(value);
    const row = await pool.query<{ status: string; errorCode: string | null; errorMessage: string | null; orchestrationPrivate: Record<string, any> }>(
      "SELECT status,error_code AS \"errorCode\",error_message AS \"errorMessage\",orchestration_private AS \"orchestrationPrivate\" FROM generation_jobs WHERE id=$1", [value.job.id]
    );
    expect(row.rows[0]).toMatchObject({ status: "completed", errorCode: null, errorMessage: null });
    const extensionBody = requestBodies.find((body) => {
      const input = JSON.parse(JSON.parse(body).messages[1].content);
      return Array.isArray(input.fictional_event_instructions);
    });
    expect(extensionBody).toBeDefined();
    const extension = JSON.parse(extensionBody!);
    expect(extension.response_format).toEqual({ type: "json_schema", json_schema: {
      name: getProviderOutputSchemaV2("story").name, strict: true, schema: getProviderOutputSchemaV2("story").schema
    } });
    expect(extension.messages[0].content.split("Native preset success instruction.").length - 1).toBe(1);
    expect(row.rows[0]!.orchestrationPrivate.extension).toMatchObject({
      producingOperation: "event_extension", producingRequestBody: extensionBody,
      producingRequestPayloadHash: createHash("sha256").update(extensionBody!).digest("hex")
    });
    expect(row.rows[0]!.orchestrationPrivate.responseContractInvocations).toEqual(expect.arrayContaining([
      expect.objectContaining({ version: 2, operation: "event_extension", requestPayloadHash: createHash("sha256").update(extensionBody!).digest("hex"), status: "completed" })
    ]));
    await expect(pool.query<{ narration: string }>(
      "SELECT narration FROM turns WHERE id=(SELECT result_turn_id FROM generation_jobs WHERE id=$1)", [value.job.id]
    )).resolves.toMatchObject({ rows: [{ narration: "Mira reaches the observatory. A lantern glows beside the opened archive." }] });
  }, 60_000);

  it("propagates a wrapped native event-extension schema rejection without later inference or mutation", async () => {
    scenario = "aux_event_schema_rejection";
    const value = await fixture("required", false, true, "preset", { triggers: true, eventExtension: true });
    const before = await authority(value.campaignId);
    await executeOnce(value);
    const row = await pool.query<{ status: string; errorCode: string | null; orchestrationPrivate: Record<string, any> }>(
      "SELECT status,error_code AS \"errorCode\",orchestration_private AS \"orchestrationPrivate\" FROM generation_jobs WHERE id=$1", [value.job.id]
    );
    expect(row.rows[0]).toMatchObject({ status: "failed", errorCode: "provider_schema_invalid" });
    const extensionBody = requestBodies.find((body) => {
      const input = JSON.parse(JSON.parse(body).messages[1].content);
      return Array.isArray(input.fictional_event_instructions);
    });
    expect(extensionBody).toBeDefined();
    expect(JSON.parse(extensionBody!).response_format).toEqual({ type: "json_schema", json_schema: {
      name: getProviderOutputSchemaV2("story").name, strict: true, schema: getProviderOutputSchemaV2("story").schema
    } });
    expect(row.rows[0]!.orchestrationPrivate.preparedResponseFailures).toEqual(expect.arrayContaining([
      expect.objectContaining({ version: 2, diagnosticCode: "provider_schema_invalid", requestBody: extensionBody })
    ]));
    expect(requestBodies.slice(requestBodies.indexOf(extensionBody!) + 1)).toHaveLength(0);
    expect(await authority(value.campaignId)).toEqual(before);
  }, 60_000);

  it("propagates a wrapped native scene-coverage schema rejection without review, rewrite, or mutation", async () => {
    scenario = "aux_scene_schema_rejection";
    const value = await fixture("required", false, true, "preset", { scene: true });
    const before = await authority(value.campaignId);
    await executeOnce(value);
    const row = await pool.query<{ status: string; errorCode: string | null; orchestrationPrivate: Record<string, any> }>(
      "SELECT status,error_code AS \"errorCode\",orchestration_private AS \"orchestrationPrivate\" FROM generation_jobs WHERE id=$1", [value.job.id]
    );
    expect(row.rows[0]).toMatchObject({ status: "failed", errorCode: "provider_schema_invalid" });
    const coverageIndex = requestBodies.findIndex((body) => JSON.parse(body).response_format?.json_schema?.name === getProviderOutputSchemaV2("scene_coverage").name);
    expect(coverageIndex).toBeGreaterThanOrEqual(0);
    expect(requestBodies.slice(coverageIndex + 1)).toHaveLength(0);
    expect(row.rows[0]!.orchestrationPrivate.preparedResponseFailures).toEqual(expect.arrayContaining([
      expect.objectContaining({ version: 2, diagnosticCode: "provider_schema_invalid", requestBody: requestBodies[coverageIndex] })
    ]));
    expect(await authority(value.campaignId)).toEqual(before);
  }, 60_000);

  it("propagates a wrapped native event-coverage schema rejection without later inference or mutation", async () => {
    scenario = "aux_event_coverage_schema_rejection";
    const value = await fixture("required", false, true, "preset", { triggers: true });
    const before = await authority(value.campaignId);
    await executeOnce(value);
    const row = await pool.query<{ status: string; errorCode: string | null; orchestrationPrivate: Record<string, any> }>(
      "SELECT status,error_code AS \"errorCode\",orchestration_private AS \"orchestrationPrivate\" FROM generation_jobs WHERE id=$1", [value.job.id]
    );
    expect(row.rows[0]).toMatchObject({ status: "failed", errorCode: "provider_schema_invalid" });
    const coverageIndex = requestBodies.findIndex((body) => JSON.parse(body).response_format?.json_schema?.name === getProviderOutputSchemaV2("event_coverage").name);
    expect(coverageIndex).toBeGreaterThanOrEqual(0);
    expect(requestBodies.slice(coverageIndex + 1)).toHaveLength(0);
    expect(row.rows[0]!.orchestrationPrivate.preparedResponseFailures).toEqual(expect.arrayContaining([
      expect.objectContaining({ version: 2, diagnosticCode: "provider_schema_invalid", requestBody: requestBodies[coverageIndex] })
    ]));
    expect(await authority(value.campaignId)).toEqual(before);
  }, 60_000);

  it("repairs native v2 preset scene coverage through an authorized Story Direction review", async () => {
    scenario = "success";
    sceneCoverageResults = [false, true];
    const value = await fixture("required", false, true, "preset", { scene: true, continuity: "enforce" });
    await executeOnce(value);
    const review = await value.application.getReview({ ownerUserId, jobId: value.job.id });
    expect(review).toMatchObject({ stage: "scene_coverage", state: "pending" });
    await value.application.decideReview({ ownerUserId, jobId: value.job.id }, {
      reviewId: review.reviewId, revision: review.revision, decision: "retry"
    });
    await executeOnce(value);
    const continuity = await value.application.getReview({ ownerUserId, jobId: value.job.id });
    expect(continuity).toMatchObject({ stage: "continuity", state: "pending" });
    await value.application.decideReview({ ownerUserId, jobId: value.job.id }, {
      reviewId: continuity.reviewId, revision: continuity.revision, decision: "retry"
    });
    await executeOnce(value);
    const row = await pool.query<{ status: string; orchestrationPrivate: Record<string, any> }>(
      "SELECT status,orchestration_private AS \"orchestrationPrivate\" FROM generation_jobs WHERE id=$1", [value.job.id]
    );
    expect(row.rows[0]!.status).toBe("completed");
    const invocations = row.rows[0]!.orchestrationPrivate.responseContractInvocations as Array<Record<string, unknown>>;
    expect(invocations).toEqual(expect.arrayContaining([
      expect.objectContaining({ version: 2, operation: "scene_coverage_validation" }),
      expect.objectContaining({ version: 2, operation: "scene_coverage_rewrite" })
    ]));
    const coverageInvocations = invocations.filter((entry) => entry.operation === "scene_coverage_validation");
    expect(coverageInvocations).toHaveLength(2);
    const replay = row.rows[0]!.orchestrationPrivate.sceneCoverageRepair.validatedCoverage;
    expect(replay).toMatchObject({
      version: 1,
      requestBody: expect.any(String),
      requestPayloadHash: createHash("sha256").update(replay.requestBody).digest("hex"),
      result: { content: expect.any(String), outputLimited: false },
      resultHash: expect.any(String)
    });
    expect(coverageInvocations.filter((entry) => entry.requestPayloadHash === replay.requestPayloadHash)).toHaveLength(1);
    expect(coverageInvocations.find((entry) => entry.requestPayloadHash === replay.requestPayloadHash)?.response)
      .toMatchObject({ resultHash: replay.resultHash });
    expect(requestBodies.filter((body) => body === replay.requestBody)).toHaveLength(1);
    for (const bodyText of requestBodies) {
      const body = JSON.parse(bodyText);
      expect(body.messages[0].content.split("Native preset success instruction.").length - 1).toBe(1);
      expect(body.response_format.type).toBe("json_schema");
    }
    await expect(pool.query<{ narration: string }>(
      "SELECT narration FROM turns WHERE id=(SELECT result_turn_id FROM generation_jobs WHERE id=$1)", [value.job.id]
    )).resolves.toMatchObject({ rows: [{ narration: "Mira reaches the observatory." }] });
  }, 60_000);

  it("reserves the checked clean-regeneration scene rewrite before a provider failure", async () => {
    scenario = "scene_rewrite_overflow_rejection";
    sceneCoverageResults = [false];
    const value = await fixture("required", false, true, "preset", { scene: true, continuity: "enforce", contextWindowTokens: 20_000 });
    await executeOnce(value);
    const review = await value.application.getReview({ ownerUserId, jobId: value.job.id });
    expect(review).toMatchObject({ stage: "scene_coverage", state: "pending" });
    await value.application.decideReview({ ownerUserId, jobId: value.job.id }, {
      reviewId: review.reviewId, revision: review.revision, decision: "retry"
    });

    await executeOnce(value);
    const row = await pool.query<{ status: string; errorCode: string | null; orchestrationPrivate: Record<string, any> }>(
      "SELECT status,error_code AS \"errorCode\",orchestration_private AS \"orchestrationPrivate\" FROM generation_jobs WHERE id=$1",
      [value.job.id]
    );
    expect(row.rows[0]).toMatchObject({ status: "failed", errorCode: "provider_schema_invalid" });
    const rewriteBody = requestBodies.find((body) => body.includes("CLEAN REGENERATION REQUIREMENT"));
    expect(rewriteBody).toBeDefined();
    expect(rewriteBody).not.toContain(sceneRejectedDraftCanary);
    const rewriteInvocation = row.rows[0]!.orchestrationPrivate.responseContractInvocations.find(
      (entry: Record<string, unknown>) => entry.operation === "scene_coverage_rewrite"
    );
    const rewriteFailure = row.rows[0]!.orchestrationPrivate.preparedResponseFailures.find(
      (entry: Record<string, unknown>) => entry.invocationId === rewriteInvocation.id
    );
    expect(row.rows[0]!.orchestrationPrivate.sceneCoverageRepair).toMatchObject({
      status: "dispatched",
      repairRequestBody: rewriteBody,
      repairRequestPayloadHash: createHash("sha256").update(rewriteBody!).digest("hex")
    });
    expect(rewriteInvocation).toMatchObject({
      status: "completed",
      requestPayloadHash: createHash("sha256").update(rewriteBody!).digest("hex")
    });
    expect(rewriteFailure).toMatchObject({ requestBody: rewriteBody, requestPayloadHash: rewriteInvocation.requestPayloadHash });
  }, 60_000);

  it("rejects a schema-valid tampered native scene replay result before a reclaim can dispatch", async () => {
    scenario = "success";
    sceneCoverageResults = [false, true];
    const value = await fixture("required", false, true, "preset", { scene: true, continuity: "enforce" });
    await executeOnce(value);
    const sceneReview = await value.application.getReview({ ownerUserId, jobId: value.job.id });
    await value.application.decideReview({ ownerUserId, jobId: value.job.id }, {
      reviewId: sceneReview.reviewId, revision: sceneReview.revision, decision: "retry"
    });
    await executeOnce(value);
    const continuity = await value.application.getReview({ ownerUserId, jobId: value.job.id });
    expect(continuity).toMatchObject({ stage: "continuity", state: "pending" });
    const before = await authority(value.campaignId);
    const dispatched = requestBodies.length;
    const alteredResult = {
      content: JSON.stringify({ covered: true, missing_required_beats: [], contradictions: ["Altered but schema-valid replay content."] }),
      outputLimited: false,
      returnedModel: null,
      returnedProviderRoute: null
    };
    await pool.query(
      `UPDATE generation_jobs
          SET orchestration_private=jsonb_set(jsonb_set(
            orchestration_private,
            '{sceneCoverageRepair,validatedCoverage,result,content}', to_jsonb($2::text), false
          ), '{sceneCoverageRepair,validatedCoverage,resultHash}', to_jsonb($3::text), false)
        WHERE id=$1 AND owner_user_id=$4`,
      [value.job.id, alteredResult.content, sceneCoverageReplayResultHash(alteredResult), ownerUserId]
    );
    await value.application.decideReview({ ownerUserId, jobId: value.job.id }, {
      reviewId: continuity.reviewId, revision: continuity.revision, decision: "retry"
    });
    await executeOnce(value, false);
    await expect(pool.query<{ status: string; errorCode: string | null }>(
      "SELECT status,error_code AS \"errorCode\" FROM generation_jobs WHERE id=$1", [value.job.id]
    )).resolves.toMatchObject({ rows: [{ status: "recoverable", errorCode: "generation_checkpoint_incompatible" }] });
    expect(requestBodies).toHaveLength(dispatched);
    expect(await authority(value.campaignId)).toEqual(before);
  }, 60_000);

  it("executes a trusted preset v2 append through the same prepared transport without a capability gate", async () => {
    scenario = "success";
    const value = await fixture("required", false, true, "preset");
    await executeOnce(value);
    const row = await pool.query<{ status: string; errorCode: string | null; errorMessage: string | null; orchestrationPrivate: Record<string, any> }>(
      "SELECT status,error_code AS \"errorCode\",error_message AS \"errorMessage\",orchestration_private AS \"orchestrationPrivate\" FROM generation_jobs WHERE id=$1", [value.job.id]
    );
    const attempts = await pool.query(
      "SELECT status,outcome,failure_reason AS \"failureReason\",requested_model AS \"requestedModel\",returned_model AS \"returnedModel\",provider_policy AS \"providerPolicy\",returned_provider_route AS \"returnedProviderRoute\" FROM prepared_text_physical_attempts WHERE logical_reservation->>'generationJobId'=$1",
      [value.job.id]
    );
    const privateState = row.rows[0]!.orchestrationPrivate;
    expect(attempts.rows).toEqual([expect.objectContaining({ status: "completed", outcome: "succeeded", failureReason: null })]);
    expect(row.rows[0]).toMatchObject({ status: "completed", errorCode: null, errorMessage: null });
    expect(privateState.queuedResponsePolicy).toMatchObject({ version: 2, admission: { basis: "preset_trusted" }, authority: { kind: "preset_trusted" } });
    expect(privateState.textExecutionRouteBasis).toMatchObject({ selection: { kind: "openrouter_preset", slug: "native-success" }, presetSystemPrompt: "Native preset success instruction.", parameters: { temperature: 0.25 } });
    expect(requestBodies).toHaveLength(1);
    const body = JSON.parse(requestBodies[0]!);
    expect(body).toMatchObject({ model, temperature: 0.25, provider: { only: ["preset-route"], require_parameters: true } });
    expect(body.response_format).toEqual({ type: "json_schema", json_schema: {
      name: getProviderOutputSchemaV2("story").name, strict: true, schema: getProviderOutputSchemaV2("story").schema
    } });
    expect(body.messages[0].content).toContain("Native preset success instruction.");
    expect(privateState.primaryReservation.requestBody).toBe(requestBodies[0]);
    expect(privateState.responseContractInvocations[0].requestPayloadHash).toBe(createHash("sha256").update(requestBodies[0]!).digest("hex"));
  }, 60_000);

  it("advances one frozen preset route after a conclusive rate limit and commits one turn and logical charge", async () => {
    scenario = "route_fallback";
    const value = await fixture("required", false, true, "fallback");
    const before = await authority(value.campaignId);
    await executeOnce(value);
    const job = (await pool.query<{ status: string; errorCode: string | null; errorMessage: string | null; recoveryMetadata: Record<string, unknown>; resultTurnId: string; orchestrationPrivate: Record<string, any> }>(
      "SELECT status,error_code AS \"errorCode\",error_message AS \"errorMessage\",recovery_metadata AS \"recoveryMetadata\",result_turn_id AS \"resultTurnId\",orchestration_private AS \"orchestrationPrivate\" FROM generation_jobs WHERE id=$1",
      [value.job.id]
    )).rows[0]!;
    const attempts = await pool.query<{
      id: string; candidateOrdinal: number; requestedModel: string; outcome: string;
      failureReason: string | null; usage: Record<string, number> | null; reportedCost: Record<string, string> | null;
    }>(
      `SELECT id,candidate_ordinal AS "candidateOrdinal",requested_model AS "requestedModel",outcome,
              failure_reason AS "failureReason",usage,reported_cost AS "reportedCost"
         FROM prepared_text_physical_attempts
        WHERE logical_reservation->>'generationJobId'=$1 ORDER BY candidate_ordinal`,
      [value.job.id]
    );
    const costs = await pool.query<{ localCallId: string; turnId: string; amount: string; usage: Record<string, number> }>(
      `SELECT local_call_id AS "localCallId",turn_id AS "turnId",
              trim(trailing '.' from trim(trailing '0' from amount::text)) AS amount,usage_metadata AS usage
         FROM provider_cost_events WHERE generation_job_id=$1 AND operation='story_generation'`,
      [value.job.id]
    );
    const after = await authority(value.campaignId);

    expect(job).toMatchObject({ status: "completed", errorCode: null, errorMessage: null, recoveryMetadata: {} });
    expect(after.accepted).toBe(before.accepted + 1);
    expect(requestBodies).toHaveLength(2);
    for (const [index, bodyText] of requestBodies.entries()) {
      const body = JSON.parse(bodyText);
      expect(body).toMatchObject({
        model: fallbackModels[index], temperature: 0.25,
        provider: { only: ["preset-route"], data_collection: "deny", require_parameters: true }
      });
      expect(body.messages[0].content.split("Native preset fallback instruction.").length - 1).toBe(1);
      expect(body.response_format).toEqual({ type: "json_schema", json_schema: {
        name: getProviderOutputSchemaV2("story").name, strict: true, schema: getProviderOutputSchemaV2("story").schema
      } });
    }
    expect(job.orchestrationPrivate.responseContractInvocations).toEqual([
      expect.objectContaining({ status: "completed", operation: "story_generation" })
    ]);
    expect(attempts.rows).toEqual([
      expect.objectContaining({ candidateOrdinal: 0, requestedModel: fallbackModels[0], outcome: "failed", failureReason: "rate_limit", usage: null, reportedCost: null }),
      expect.objectContaining({ candidateOrdinal: 1, requestedModel: fallbackModels[1], outcome: "succeeded", failureReason: null,
        usage: { inputTokens: 80, outputTokens: 30, totalTokens: 110 }, reportedCost: { amount: "0.0042", currency: "USD" } })
    ]);
    expect(costs.rows).toEqual([
      expect.objectContaining({ localCallId: attempts.rows[1]!.id, turnId: job.resultTurnId, amount: "0.0042",
        usage: { inputTokens: 80, outputTokens: 30, totalTokens: 110 } })
    ]);
    expect(await createProviderCostRepository(pool).getCampaignCostSummary({ ownerUserId, campaignId: value.campaignId })).toMatchObject({
      totals: [{ currency: "USD", amount: "0.0042", byCategory: { story: "0.0042" } }]
    });
  }, 60_000);

  it("attributes terminal candidate evidence to the second physical attempt after safe route exhaustion", async () => {
    scenario = "route_exhausted";
    const value = await fixture("required", false, true, "fallback");
    const before = await authority(value.campaignId);
    await executeOnce(value);
    const job = (await pool.query<{ status: string; errorCode: string | null; orchestrationPrivate: Record<string, any> }>(
      "SELECT status,error_code AS \"errorCode\",orchestration_private AS \"orchestrationPrivate\" FROM generation_jobs WHERE id=$1",
      [value.job.id]
    )).rows[0]!;
    const attempts = await pool.query<{
      id: string; candidateOrdinal: number; outcome: string; failureReason: string;
      usage: unknown; reportedCost: unknown;
    }>(
      `SELECT id,candidate_ordinal AS "candidateOrdinal",outcome,failure_reason AS "failureReason",usage,
              reported_cost AS "reportedCost"
         FROM prepared_text_physical_attempts
        WHERE logical_reservation->>'generationJobId'=$1 ORDER BY candidate_ordinal`,
      [value.job.id]
    );
    const secondBodyHash = createHash("sha256").update(requestBodies[1]!).digest("hex");

    expect(job).toMatchObject({ status: "failed", errorCode: "provider_schema_invalid" });
    expect(requestBodies).toHaveLength(2);
    expect(attempts.rows).toEqual([
      expect.objectContaining({ candidateOrdinal: 0, outcome: "failed", failureReason: "rate_limit", usage: null, reportedCost: null }),
      expect.objectContaining({ candidateOrdinal: 1, outcome: "failed", failureReason: "schema_invalid", usage: null, reportedCost: null })
    ]);
    expect(job.orchestrationPrivate.preparedResponseFailures).toEqual([
      expect.objectContaining({ responseId: "fallback-schema-id", diagnosticCode: "provider_schema_invalid",
        requestBody: requestBodies[1], requestPayloadHash: secondBodyHash })
    ]);
    expect(job.orchestrationPrivate.responseContractInvocations).toEqual([
      expect.objectContaining({ status: "completed", response: expect.objectContaining({
        physicalAttemptId: attempts.rows[1]!.id, physicalRequestPayloadHash: secondBodyHash
      }) })
    ]);
    expect(await authority(value.campaignId)).toEqual(before);
  }, 60_000);

  it.each(["route_invalid_identity", "route_refusal"] as const)("retains partial usage and reported cost for charged 2xx %s without fallback or state mutation", async (failureScenario) => {
    scenario = failureScenario;
    const value = await fixture("required", false, true, "fallback");
    const before = await authority(value.campaignId);
    await executeOnce(value);
    const attempts = await pool.query<{ id: string; outcome: string; failure_reason: string; usage: unknown; reported_cost: unknown }>(
      `SELECT id,outcome,failure_reason,usage,reported_cost FROM prepared_text_physical_attempts
         WHERE owner_user_id=$1 AND logical_reservation->>'generationJobId'=$2 ORDER BY candidate_ordinal`,
      [ownerUserId, value.job.id]
    );
    expect(requestBodies).toHaveLength(1);
    expect(attempts.rows).toEqual([expect.objectContaining({ outcome: "failed", failure_reason: failureScenario === "route_refusal" ? "refusal" : "invalid_identity",
      usage: { inputTokens: 21 }, reported_cost: { amount: "0.0064", currency: "USD" } })]);
    const event = await pool.query<{
      localCallId: string; generationJobId: string | null; providerProfileId: string | null;
      amount: string; currency: string; usage: Record<string, unknown>;
    }>(
      `SELECT local_call_id AS "localCallId",generation_job_id AS "generationJobId",
              provider_profile_id AS "providerProfileId",amount::text,currency,usage_metadata AS usage
         FROM provider_cost_events WHERE owner_user_id=$1 AND local_call_id=$2`,
      [ownerUserId, attempts.rows[0]!.id]
    );
    expect(event.rows).toEqual([{
      localCallId: attempts.rows[0]!.id, generationJobId: value.job.id, providerProfileId: value.providerId,
      amount: "0.0064", currency: "USD", usage: { inputTokens: 21 }
    }]);
    await pool.query("DELETE FROM generation_jobs WHERE id=$1 AND owner_user_id=$2", [value.job.id, ownerUserId]);
    await expect(pool.query(
      "SELECT generation_job_id,provider_profile_id FROM provider_cost_events WHERE owner_user_id=$1 AND local_call_id=$2",
      [ownerUserId, attempts.rows[0]!.id]
    )).resolves.toMatchObject({ rows: [{ generation_job_id: null, provider_profile_id: value.providerId }] });
    const costs = createProviderCostRepository(pool);
    for (let replay = 0; replay < 2; replay += 1) {
      expect(await costs.getCampaignCostSummary({ ownerUserId, campaignId: value.campaignId })).toMatchObject({
        hasReportedCosts: true,
        totals: [{ currency: "USD", amount: "0.0064", turnAttributed: "0", byCategory: { story: "0.0064" } }]
      });
    }
    expect(await authority(value.campaignId)).toEqual(before);
  }, 60_000);

  it("persists response-start and partial output evidence without advancing the frozen Story route", async () => {
    scenario = "route_partial_stream";
    const value = await fixture("required", true, true, "fallback");
    const before = await authority(value.campaignId);
    await executeOnce(value);
    const job = (await pool.query<{ status: string; orchestrationPrivate: Record<string, any> }>(
      "SELECT status,orchestration_private AS \"orchestrationPrivate\" FROM generation_jobs WHERE id=$1", [value.job.id]
    )).rows[0]!;
    const attempts = await pool.query<{
      candidateOrdinal: number; status: string; outcome: string; failureReason: string;
      providerResponseId: string | null; responseStartedAt: Date | null; usage: unknown; reportedCost: unknown;
    }>(
      `SELECT candidate_ordinal AS "candidateOrdinal",status,outcome,failure_reason AS "failureReason",
              provider_response_id AS "providerResponseId",response_started_at AS "responseStartedAt",usage,reported_cost AS "reportedCost"
         FROM prepared_text_physical_attempts
        WHERE logical_reservation->>'generationJobId'=$1 ORDER BY candidate_ordinal`,
      [value.job.id]
    );

    expect(job.status).toBe("failed");
    expect(requestBodies).toHaveLength(1);
    expect(JSON.parse(requestBodies[0]!).model).toBe(fallbackModels[0]);
    expect(attempts.rows).toEqual([
      expect.objectContaining({ candidateOrdinal: 0, status: "completed", outcome: "failed", failureReason: "unknown",
        providerResponseId: "partial-stream-id", responseStartedAt: expect.any(Date), usage: null, reportedCost: null })
    ]);
    expect(job.orchestrationPrivate.preparedResponseFailures).toEqual([
      expect.objectContaining({ responseId: "partial-stream-id", partialContent: partialJson,
        requestPayloadHash: createHash("sha256").update(requestBodies[0]!).digest("hex") })
    ]);
    expect(job.orchestrationPrivate.responseContractInvocations).toEqual([
      expect.objectContaining({ status: "completed", response: expect.objectContaining({
        physicalAttemptId: expect.any(String),
        physicalRequestPayloadHash: createHash("sha256").update(requestBodies[0]!).digest("hex")
      }) })
    ]);
    expect(await authority(value.campaignId)).toEqual(before);
  }, 60_000);

  it.each(["model", "preset"] as const)("executes a native v2 %s replacement using the queued frozen candidate", async (selection) => {
    scenario = "success";
    const value = await fixture("required", false, true, selection);
    await executeOnce(value);
    const currentTurn = (await pool.query<{ activeTurnNumber: number }>(
      "SELECT active_turn_number AS \"activeTurnNumber\" FROM campaigns WHERE id=$1", [value.campaignId]
    )).rows[0]!.activeTurnNumber;
    const replacement = await value.application.enqueueReplacement(
      { ownerUserId, campaignId: value.campaignId },
      generationRetryLatestRequestSchema.parse({
        action: "Replace the observatory turn with the frozen native candidate.",
        providerProfileId: value.providerId,
        ...(selection === "preset" ? { textSelection: { kind: "openrouter_preset", slug: "native-success" } } : {}),
        expectedCurrentTurnNumber: currentTurn,
        idempotencyKey: randomUUID(),
        context: { budgetTokens: 16_000, compression: "full", recentTurns: 8 }
      })
    );
    await executeJob(value, replacement);
    const row = await pool.query<{ status: string; orchestrationPrivate: Record<string, any> }>(
      "SELECT status,orchestration_private AS \"orchestrationPrivate\" FROM generation_jobs WHERE id=$1", [replacement.id]
    );
    expect(row.rows[0]!.status).toBe("completed");
    expect(requestBodies).toHaveLength(2);
    expect(row.rows[0]!.orchestrationPrivate.primaryReservation.requestBody).toBe(requestBodies[1]);
    expect(row.rows[0]!.orchestrationPrivate.responseContractInvocations).toEqual([
      expect.objectContaining({ version: 2, operation: "story_generation", status: "completed", requestPayloadHash: createHash("sha256").update(requestBodies[1]!).digest("hex") })
    ]);
    if (selection === "preset") {
      expect(JSON.parse(requestBodies[1]!).messages[0].content).toContain("Native preset success instruction.");
    }
  }, 60_000);

  it("executes native v2 Action RPG assessment and primary schemas through the frozen prepared candidate", async () => {
    scenario = "success";
    const value = await fixture("required", false, true, "model", { rpg: true });
    await executeOnce(value);
    const row = await pool.query<{ status: string; orchestrationPrivate: Record<string, any> }>(
      "SELECT status,orchestration_private AS \"orchestrationPrivate\" FROM generation_jobs WHERE id=$1", [value.job.id]
    );
    expect(row.rows[0]!.status).toBe("completed");
    expect(requestBodies).toHaveLength(2);
    expect(JSON.parse(requestBodies[0]!).response_format.json_schema.name).toBe(getProviderOutputSchemaV2("rpg_assessment").name);
    expect(JSON.parse(requestBodies[1]!).response_format.json_schema.name).toBe(getProviderOutputSchemaV2("story").name);
    expect(row.rows[0]!.orchestrationPrivate.responseContractInvocations).toEqual([
      expect.objectContaining({ version: 2, operation: "rpg_assessment", requestPayloadHash: createHash("sha256").update(requestBodies[0]!).digest("hex") }),
      expect.objectContaining({ version: 2, operation: "story_generation", requestPayloadHash: createHash("sha256").update(requestBodies[1]!).digest("hex") })
    ]);
    expect(row.rows[0]!.orchestrationPrivate.primaryReservation.requestBody).toBe(requestBodies[1]);
  }, 60_000);

  it("executes native v2 Preset Story Direction without mechanical inference", async () => {
    scenario = "success";
    const value = await fixture("required", false, true, "preset", { storyOnly: true });
    await executeOnce(value);
    const row = await pool.query<{ status: string; generationPolicy: { playMode: string }; orchestrationPrivate: Record<string, any> }>(
      "SELECT status,generation_policy AS \"generationPolicy\",orchestration_private AS \"orchestrationPrivate\" FROM generation_jobs WHERE id=$1", [value.job.id]
    );
    expect(row.rows[0]!.status).toBe("completed");
    expect(row.rows[0]!.generationPolicy.playMode).toBe("story_only");
    expect(requestBodies).toHaveLength(1);
    expect(row.rows[0]!.orchestrationPrivate.responseContractInvocations).toEqual([
      expect.objectContaining({ version: 2, operation: "story_generation", requestPayloadHash: createHash("sha256").update(requestBodies[0]!).digest("hex") })
    ]);
    expect(JSON.parse(requestBodies[0]!).messages[0].content).toContain("Native preset success instruction.");
  }, 60_000);

  it("repairs native v2 preset Story Direction choices through the frozen choices schema after an explicit review", async () => {
    scenario = "choice_repair";
    const value = await fixture("required", false, true, "preset", { storyOnly: true });
    await executeOnce(value);
    const review = await value.application.getReview({ ownerUserId, jobId: value.job.id });
    expect(review).toMatchObject({ stage: "choices", state: "pending", canKeep: false, canRetry: true });
    await value.application.decideReview({ ownerUserId, jobId: value.job.id }, {
      reviewId: review.reviewId, revision: review.revision, decision: "retry"
    });
    await executeOnce(value);
    const row = await pool.query<{ status: string; orchestrationPrivate: Record<string, any> }>(
      "SELECT status,orchestration_private AS \"orchestrationPrivate\" FROM generation_jobs WHERE id=$1", [value.job.id]
    );
    expect(row.rows[0]!.status).toBe("completed");
    expect(requestBodies).toHaveLength(2);
    const expected = ["story", "choices"] as const;
    for (const [index, operation] of expected.entries()) {
      const body = JSON.parse(requestBodies[index]!);
      expect(body.response_format).toEqual({ type: "json_schema", json_schema: {
        name: getProviderOutputSchemaV2(operation).name, strict: true, schema: getProviderOutputSchemaV2(operation).schema
      } });
      expect(body.messages[0].content.startsWith("Native preset success instruction.\n\n")).toBe(true);
      expect(body.messages[0].content.split("Native preset success instruction.").length - 1).toBe(1);
    }
    expect(row.rows[0]!.orchestrationPrivate.choiceRepair).toMatchObject({
      status: "validated", originalRequestBody: requestBodies[0], repairRequestBody: requestBodies[1]
    });
    expect(row.rows[0]!.orchestrationPrivate.responseContractInvocations).toEqual([
      expect.objectContaining({ version: 2, operation: "story_generation", requestPayloadHash: createHash("sha256").update(requestBodies[0]!).digest("hex") }),
      expect.objectContaining({ version: 2, operation: "story_choice_repair", requestPayloadHash: createHash("sha256").update(requestBodies[1]!).digest("hex") })
    ]);
    await expect(pool.query<{ narration: string }>(
      "SELECT narration FROM turns WHERE id=(SELECT result_turn_id FROM generation_jobs WHERE id=$1)", [value.job.id]
    )).resolves.toMatchObject({ rows: [{ narration: "Mira reaches the observatory." }] });
  }, 60_000);

  it("stops a new native v2 logical invocation at the durable 24-entry ledger limit before transport", async () => {
    scenario = "choice_repair";
    const value = await fixture("required", false, true, "preset", { storyOnly: true });
    await executeOnce(value);
    const review = await value.application.getReview({ ownerUserId, jobId: value.job.id });
    expect(review).toMatchObject({ stage: "choices", state: "pending" });
    await value.application.decideReview({ ownerUserId, jobId: value.job.id }, {
      reviewId: review.reviewId, revision: review.revision, decision: "retry"
    });

    const repository = createPostgresGenerationExecutionRepository(pool);
    const workerId = `response-contract-capacity-${randomUUID()}`;
    const claim = await repository.claimNext({ workerId, leaseSeconds: 30 });
    expect(claim?.jobId).toBe(value.job.id);
    const payload = await repository.loadExecutionPayload({ claim: claim!, workerId, leaseSeconds: 30 });
    expect(payload?.orchestration_private.responseContractInvocations).toHaveLength(1);
    const routeBasis = payload!.orchestration_private.textExecutionRouteBasis!;
    const scope = { jobId: claim!.jobId, ownerUserId: claim!.ownerUserId, workerId };
    for (let index = 0; index < 23; index += 1) {
      const prompt = `Capacity placeholder ${index}.`;
      const plan = deriveTextExecutionPlan(routeBasis, prompt);
      const hash = createHash("sha256").update(`capacity-${index}`).digest("hex");
      const invocation = responseContractInvocationDetails(
        payload!, "story_generation", false, hash, { model: routeBasis.candidates[0]!.modelId }, prompt, plan
      );
      expect(invocation).toBeDefined();
      const reserved = await repository.reserveResponseContractInvocation!(scope, invocation!);
      expect(reserved).not.toBeNull();
      expect(reserved).toMatchObject({ version: 2, status: "reserved", requestPayloadHash: hash });
    }
    const callsBefore = requestBodies.length;
    await expect(createGenerationExecutor({ pool, repository, collaborators: value.collaborators })
      .execute({ claim: claim!, workerId, leaseSeconds: 30 })).resolves.toBe(true);
    const row = await pool.query<{ status: string; errorCode: string | null; orchestrationPrivate: Record<string, any> }>(
      "SELECT status,error_code AS \"errorCode\",orchestration_private AS \"orchestrationPrivate\" FROM generation_jobs WHERE id=$1", [value.job.id]
    );
    expect(row.rows[0]).toMatchObject({ status: "recoverable", errorCode: "response_contract_unavailable" });
    expect(row.rows[0]!.orchestrationPrivate.responseContractInvocations).toHaveLength(24);
    expect(requestBodies).toHaveLength(callsBefore);
  }, 60_000);

  it("binds native v2 preset continuity review and repair to their own exact schemas and frozen prompt", async () => {
    scenario = "success";
    const value = await fixture("required", false, true, "preset", { storyOnly: true, continuity: "enforce" });
    await executeOnce(value);
    const review = await value.application.getReview({ ownerUserId, jobId: value.job.id });
    expect(review).toMatchObject({ stage: "continuity", state: "pending" });
    await value.application.decideReview({ ownerUserId, jobId: value.job.id }, {
      reviewId: review.reviewId, revision: review.revision, decision: "retry"
    });
    await executeOnce(value);
    const row = await pool.query<{ status: string; orchestrationPrivate: Record<string, any>; contextOptions: Record<string, any> }>(
      "SELECT status,orchestration_private AS \"orchestrationPrivate\",context_options AS \"contextOptions\" FROM generation_jobs WHERE id=$1", [value.job.id]
    );
    expect(row.rows[0]!.orchestrationPrivate.sourceEvidenceManifest).toBeDefined();
    expect(row.rows[0]!.orchestrationPrivate.continuityReview).toMatchObject({
      status: "completed", verdict: "pass", binding: { producingRequestHash: createHash("sha256").update(requestBodies[2]!).digest("hex") }
    });
    expect(row.rows[0]!.orchestrationPrivate.continuityReview.binding.providerConfigurationHash)
      .toBe(row.rows[0]!.contextOptions.storyMemoryPolicy.providerConfigurationFingerprint);
    expect(row.rows[0]!.status).toBe("completed");
    expect(requestBodies).toHaveLength(4);
    const expected = ["story", "continuity_review", "story", "continuity_review"] as const;
    for (const [index, operation] of expected.entries()) {
      const body = JSON.parse(requestBodies[index]!);
      expect(body.response_format).toEqual({ type: "json_schema", json_schema: {
        name: getProviderOutputSchemaV2(operation).name, strict: true, schema: getProviderOutputSchemaV2(operation).schema
      } });
      expect(body.messages[0].content).toContain("Native preset success instruction.");
    }
    expect(row.rows[0]!.orchestrationPrivate.responseContractInvocations).toEqual(expected.map((operation, index) => expect.objectContaining({
      version: 2,
      operation: index === 0 ? "story_generation" : index === 1 || index === 3 ? "story_continuity_review" : "story_continuity_repair",
      requestPayloadHash: createHash("sha256").update(requestBodies[index]!).digest("hex")
    })));
    expect(row.rows[0]!.orchestrationPrivate.primaryReservation.requestBody).toBe(requestBodies[0]);
  }, 60_000);

  it("rejects a tampered native preset continuity binding at the final commit after the reviewed repair", async () => {
    scenario = "success";
    const value = await fixture("required", false, true, "preset", { storyOnly: true, continuity: "enforce" });
    await executeOnce(value);
    const review = await value.application.getReview({ ownerUserId, jobId: value.job.id });
    await value.application.decideReview({ ownerUserId, jobId: value.job.id }, {
      reviewId: review.reviewId, revision: review.revision, decision: "retry"
    });
    const before = await authority(value.campaignId);
    const repository = createPostgresGenerationExecutionRepository(pool);
    const tamperingRepository = {
      ...repository,
      async commitAcceptedTurn(input: Parameters<typeof repository.commitAcceptedTurn>[0]) {
        await pool.query(
          "UPDATE generation_jobs SET orchestration_private=jsonb_set(orchestration_private,'{continuityReview,binding,draftHash}',to_jsonb($2::text),false) WHERE id=$1",
          [input.job.id, "0".repeat(64)]
        );
        return repository.commitAcceptedTurn(input);
      }
    };
    const workerId = `response-contract-continuity-tamper-${randomUUID()}`;
    const claim = await repository.claimNext({ workerId, leaseSeconds: 30 });
    expect(claim?.jobId).toBe(value.job.id);
    await expect(createGenerationExecutor({ pool, repository: tamperingRepository, collaborators: value.collaborators })
      .execute({ claim: claim!, workerId, leaseSeconds: 30 })).resolves.toBe(true);
    const row = await pool.query<{ status: string; errorCode: string | null }>(
      "SELECT status,error_code AS \"errorCode\" FROM generation_jobs WHERE id=$1", [value.job.id]
    );
    expect(row.rows[0]).toEqual({ status: "failed", errorCode: "generation_failed" });
    expect(await authority(value.campaignId)).toEqual(before);
    expect(requestBodies).toHaveLength(4);
  }, 60_000);

  it("does not adopt changed direct-model settings when a queued v2 job is claimed", async () => {
    scenario = "success";
    const value = await fixture("required", false, true);
    await pool.query(
      "UPDATE provider_profiles SET temperature=$2 WHERE id=$1 AND owner_user_id=$3",
      [value.providerId, 0.73, ownerUserId]
    );
    await executeOnce(value);
    const row = await pool.query<{ status: string; errorCode: string | null; orchestrationPrivate: Record<string, any> }>(
      "SELECT status,error_code AS \"errorCode\",orchestration_private AS \"orchestrationPrivate\" FROM generation_jobs WHERE id=$1", [value.job.id]
    );
    expect(row.rows[0]).toMatchObject({ status: "completed", errorCode: null });
    expect(requestBodies).toHaveLength(1);
    expect(JSON.parse(requestBodies[0]!).temperature).toBe(0);
    const privateState = row.rows[0]!.orchestrationPrivate;
    expect(privateState.queuedResponsePolicy.authority.routeBasisHash).toBe(privateState.textExecutionRouteBasis.routeBasisHash);
    expect(privateState.frozenResponseContracts.contracts["story:nonstream"].authority.routeBasisHash)
      .toBe(privateState.textExecutionRouteBasis.routeBasisHash);
    expect(row.rows[0]!.orchestrationPrivate.primaryReservation.requestBody).toBe(requestBodies[0]);
    expect(row.rows[0]!.orchestrationPrivate.responseContractInvocations[0].requestPayloadHash)
      .toBe(createHash("sha256").update(requestBodies[0]!).digest("hex"));
  }, 60_000);

  it.each(["rehashed-temperature", "rehashed-policy", "missing-basis", "removed-binding"] as const)(
    "blocks a native direct Model %s tamper at the durable SQL fence before transport",
    async (tamper) => {
      scenario = "success";
      const value = await fixture("required", false, true);
      const saved = await pool.query<{ orchestrationPrivate: Record<string, any> }>(
        "SELECT orchestration_private AS \"orchestrationPrivate\" FROM generation_jobs WHERE id=$1 AND owner_user_id=$2",
        [value.job.id, ownerUserId]
      );
      const privateState = saved.rows[0]!.orchestrationPrivate;
      if (tamper === "rehashed-temperature") {
        const basis = privateState.textExecutionRouteBasis;
        basis.parameters = { ...basis.parameters, temperature: 0.91 };
        basis.routeBasisHash = textExecutionRouteBasisHash(basis);
      } else if (tamper === "rehashed-policy") {
        const basis = privateState.textExecutionRouteBasis;
        basis.candidates[0] = { ...basis.candidates[0], providerPolicy: { only: ["tampered-route"] } };
        basis.routeBasisHash = textExecutionRouteBasisHash(basis);
      } else if (tamper === "missing-basis") {
        delete privateState.textExecutionRouteBasis;
      } else {
        delete privateState.queuedResponsePolicy.authority.routeBasisHash;
      }
      await expect(pool.query(
        "UPDATE generation_jobs SET orchestration_private=$2::jsonb WHERE id=$1 AND owner_user_id=$3",
        [value.job.id, JSON.stringify(privateState), ownerUserId]
      )).rejects.toMatchObject({ message: expect.stringMatching(/immutable/) });
      await expect(pool.query<{ status: string; errorCode: string | null }>(
        "SELECT status,error_code AS \"errorCode\" FROM generation_jobs WHERE id=$1", [value.job.id]
      )).resolves.toMatchObject({ rows: [{ status: "queued", errorCode: null }] });
      expect(requestBodies).toHaveLength(0);
    },
    60_000
  );

  it("reclaims a native preset v2 job after ordinary profile edits and dispatches its saved frozen route once", async () => {
    scenario = "success";
    const value = await fixture("required", false, true, "preset");
    const repository = createPostgresGenerationExecutionRepository(pool);
    const abandoned = await repository.claimNext({ workerId: `native-preset-abandoned-${randomUUID()}`, leaseSeconds: 30 });
    expect(abandoned?.jobId).toBe(value.job.id);
    await pool.query("UPDATE generation_jobs SET lease_expires_at=now()-interval '1 second' WHERE id=$1", [value.job.id]);
    await pool.query("UPDATE provider_profiles SET temperature=$2,configuration=configuration || '{\"streaming\":true}'::jsonb WHERE id=$1", [value.providerId, 0.73]);
    await executeOnce(value);
    const row = await pool.query<{ status: string; attempts: number; orchestrationPrivate: Record<string, any> }>(
      "SELECT status,attempts,orchestration_private AS \"orchestrationPrivate\" FROM generation_jobs WHERE id=$1", [value.job.id]
    );
    expect(row.rows[0]!.status).toBe("completed");
    expect(row.rows[0]!.attempts).toBeGreaterThan(1);
    expect(requestBodies).toHaveLength(1);
    expect(JSON.parse(requestBodies[0]!)).toMatchObject({ temperature: 0.25, provider: { only: ["preset-route"], require_parameters: true } });
    expect(row.rows[0]!.orchestrationPrivate.primaryReservation.requestBody).toBe(requestBodies[0]);
    expect(row.rows[0]!.orchestrationPrivate.responseContractInvocations).toEqual([
      expect.objectContaining({ version: 2, requestPayloadHash: createHash("sha256").update(requestBodies[0]!).digest("hex") })
    ]);
  }, 60_000);

  it("reclaims a native preset v2 job while preset metadata is unavailable", async () => {
    scenario = "success";
    const value = await fixture("required", false, true, "preset");
    const repository = createPostgresGenerationExecutionRepository(pool);
    const abandoned = await repository.claimNext({ workerId: `native-preset-outage-${randomUUID()}`, leaseSeconds: 30 });
    expect(abandoned?.jobId).toBe(value.job.id);
    await pool.query("UPDATE generation_jobs SET lease_expires_at=now()-interval '1 second' WHERE id=$1", [value.job.id]);
    presetMetadataAvailable = false;
    await executeOnce(value);
    const row = await pool.query<{ status: string; orchestrationPrivate: Record<string, any> }>(
      "SELECT status,orchestration_private AS \"orchestrationPrivate\" FROM generation_jobs WHERE id=$1", [value.job.id]
    );
    expect(row.rows[0]!.status).toBe("completed");
    expect(requestBodies).toHaveLength(1);
    expect(row.rows[0]!.orchestrationPrivate.textExecutionRouteBasis.presetSystemPrompt).toBe("Native preset success instruction.");
  }, 60_000);

  it("blocks a tampered v2 direct authority revision at the durable SQL fence before any provider dispatch", async () => {
    scenario = "schema_rejection";
    const value = await fixture("required", false, true);
    await expect(pool.query(
      "UPDATE generation_jobs SET orchestration_private = orchestration_private #- '{queuedResponsePolicy,authority,authorityRevision}' WHERE id=$1 AND owner_user_id=$2",
      [value.job.id, ownerUserId]
    )).rejects.toMatchObject({ message: expect.stringMatching(/immutable/) });
    const row = await pool.query<{ status: string; errorCode: string | null }>(
      "SELECT status,error_code AS \"errorCode\" FROM generation_jobs WHERE id=$1", [value.job.id]
    );
    expect(row.rows[0]).toEqual({ status: "queued", errorCode: null });
    expect(requestBodies).toHaveLength(0);
  }, 60_000);

  it("rejects native preset dispatch when the current endpoint authority is revoked", async () => {
    scenario = "success";
    const value = await fixture("required", false, true, "preset");
    const before = await authority(value.campaignId);
    await pool.query("UPDATE provider_profiles SET base_url=$2 WHERE id=$1", [value.providerId, "http://127.0.0.1:1/v1"]);
    await executeOnce(value);
    const row = await pool.query<{ status: string; errorCode: string | null }>(
      "SELECT status,error_code AS \"errorCode\" FROM generation_jobs WHERE id=$1", [value.job.id]
    );
    expect(row.rows[0]).toEqual({ status: "recoverable", errorCode: "generation_checkpoint_incompatible" });
    expect(requestBodies).toHaveLength(0);
    expect(await authority(value.campaignId)).toEqual(before);
  }, 60_000);

  it("rejects native preset dispatch when its current credential authority is revoked", async () => {
    scenario = "success";
    const value = await fixture("required", false, true, "preset");
    const before = await authority(value.campaignId);
    await pool.query(
      "UPDATE provider_profiles SET encrypted_api_key=NULL,credential_nonce=NULL,credential_auth_tag=NULL,credential_key_version=NULL WHERE id=$1",
      [value.providerId]
    );
    await executeOnce(value);
    const row = await pool.query<{ status: string; errorCode: string | null }>(
      "SELECT status,error_code AS \"errorCode\" FROM generation_jobs WHERE id=$1", [value.job.id]
    );
    expect(row.rows[0]).toEqual({ status: "recoverable", errorCode: "generation_checkpoint_incompatible" });
    expect(requestBodies).toHaveLength(0);
    expect(await authority(value.campaignId)).toEqual(before);
  }, 60_000);

  it("keeps a historical provider HTTP body out of terminal generation logs", async () => {
    scenario = "historical_http_error";
    const errorSpy = vi.spyOn(logger, "error");
    try {
      const value = await fixture("legacy");
      await executeOnce(value);
      const terminal = errorSpy.mock.calls.map(([event]) => event).find((event) => {
        if (!event || typeof event !== "object") return false;
        const record = event as Record<string, unknown>;
        return record.event === "turn_generation_failed" && record.generationJobId === value.job.id;
      }) as Record<string, unknown> | undefined;
      expect(terminal).toMatchObject({ errorCode: "generation_failed", errorType: "Error" });
      expect(terminal).not.toHaveProperty("errorMessage");
      expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(canary);
    } finally {
      errorSpy.mockRestore();
    }
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
    expect(failure).toMatchObject({ responseId: "partial-stream-id", requestBody: requestBodies[0], requestPayloadHash: createHash("sha256").update(requestBodies[0]!).digest("hex"), partialContent: partialJson, returnedModel: "observed-stream-model", returnedProviderRoute: "observed-stream-route", diagnosticCode: null });
    expect(row.rows[0]!.orchestrationPrivate.responseContractInvocations).toEqual([expect.objectContaining({ status: "completed", response: expect.objectContaining({ returnedModel: "observed-stream-model", returnedProviderRoute: "observed-stream-route", diagnosticCode: null }) })]);
    expect(await authority(value.campaignId)).toEqual(before);
    const internalJob = await value.application.getJob({ ownerUserId, jobId: value.job.id });
    const publicJob = generationJobSnapshotSchema.parse(internalJob);
    const publicStream = generationStreamSnapshotSchema.parse(internalJob);
    expect(publicJob.partialNarration).toBe("Mira reaches the observatory.");
    expect(publicStream.partialNarration).toBe("Mira reaches the observatory.");
    expect(publicJob).not.toHaveProperty("partialOutput");
    expect(JSON.stringify(publicJob)).not.toContain(canary);
    expect(JSON.stringify(publicStream)).not.toContain(canary);
    const repository = createPostgresGenerationExecutionRepository(pool);
    expect(await repository.claimNext({ workerId: `response-contract-failure-reclaim-${randomUUID()}`, leaseSeconds: 30 })).toBeNull();
    expect(requestBodies).toHaveLength(1);
  }, 60_000);
});
