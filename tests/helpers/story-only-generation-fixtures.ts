import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { generationRequestSchema } from "../../packages/contracts/src/generation.js";
import { storyImportRequestSchema } from "../../packages/contracts/src/imports.js";
import { PROMPT_TEMPLATE_CATALOG, type PromptTemplateKey } from "../../packages/contracts/src/prompt-library.js";
import { createPostgresGenerationExecutionRepository } from "../../packages/database/src/generation-execution-repository.js";
import { createPostgresGenerationCommandRepository } from "../../packages/database/src/generation-repository.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { createDatabasePool, initialOwnerId, type DatabasePool } from "../../packages/database/src/pool.js";
import type { StreamingIllustrationConfig } from "../../packages/application/src/illustration/types.js";
import { createGenerationExecutor, type GenerationExecutionCollaborators } from "../../services/runtime/src/generation-executor-adapter.js";
import { importLegacyStory } from "./memory-aware-services.js";
import { memoryGeneration } from "./memory-applications.js";
import { createProvider, loadPromptSnapshotForTest, providerPromptProtocolVersion, readTurnReportedCostsForTest } from "./provider-application-fixtures.js";
import { assertOwnedStoryOnlyDatabase, assertStoryOnlyRuntimeTarget } from "./story-only-runtime-fixture.js";

const credentialSecret = "story-only-benchmark-fixture-secret";
const disabledIllustration: StreamingIllustrationConfig = {
  enabled: false, sourcePolicy: "off", matchingScope: "world", confidenceProfile: "balanced", repetitionWindow: 5,
  providerProfileId: null, model: "", size: "1024x1024", aspectRatio: "1:1", quality: "auto", outputFormat: "png",
  maxAttempts: 3, segmentWordCount: 500, imagesPerSegment: 1, segmentPromptMode: "direct", refinementPrompt: "disabled",
  defaultRefinementPrompt: "disabled", updatedAt: null, campaignImageProviderProfileId: null, campaignTextProviderProfileId: null
};

export type StoryOnlyFixtureScenario = "clean" | "events_configured" | "choice_repair" | "invalid_narration" | "output_limited" | "lease_reclaim";
export type StoryOnlyFixturePlayMode = "story_only" | "legacy_action" | "legacy_scene" | "legacy_events";
export type StoryOnlyFixture = Readonly<{ close(): Promise<void> }>;
export type StoryOnlyFixtureResult = Readonly<{
  operations: readonly string[];
  committed: boolean;
  timingsMs: Readonly<{ setup: number; generation: number }>;
  beforeState: string;
  afterState: string;
  failures: number;
  tokenEstimates: Readonly<{ request: number; output: number }>;
  providerReportedTokens: number | null;
  postgresVersion: string;
}>;

type PrivateFixture = Readonly<{
  pool: DatabasePool;
  ownerUserId: string;
  providerProfileId: string;
  campaignId: string;
  playMode: StoryOnlyFixturePlayMode;
  scenario: StoryOnlyFixtureScenario;
  delayMs: number;
  databaseName: string;
  baseUrl: URL;
  beforeState: string;
  setupMs: number;
  closed: { value: boolean };
}>;

const fixtures = new WeakMap<StoryOnlyFixture, PrivateFixture>();

function fullStory(choices = ["Enter the observatory.", "Call for the keeper.", "Study the wet threshold.", "Circle the tower."]) {
  return JSON.stringify({
    narration: "Rain turns the observatory glass silver as Mara opens the west door.", choices,
    custom_action_suggestion: "Ask why the lantern is burning.", scratchpad: "Mara opened the west door.",
    tracker_updates: [{ name: "west door", value: "open" }], image_prompt: "Rainy moonlit observatory doorway.",
    continuity_summary: "Mara opened the west door in the rain.", canonical_facts: ["The west door is open."],
    superseded_facts: [], canonical_fact_updates: [], open_threads: ["Find the missing keeper."]
  });
}

function choiceRepair() {
  return JSON.stringify({
    choices: ["Enter the observatory.", "Call for the keeper.", "Study the wet threshold.", "Circle the tower."],
    custom_action_suggestion: "Ask why the lantern is burning."
  });
}

function coverageResponse(input: string): string {
  try {
    const value = JSON.parse(input) as { required_events?: unknown };
    if (Array.isArray(value.required_events)) {
      const eventIds = value.required_events.map((event) => event !== null && typeof event === "object" && typeof (event as { event_id?: unknown }).event_id === "string"
        ? (event as { event_id: string }).event_id : null);
      if (eventIds.every((eventId): eventId is string => eventId !== null)) {
        return JSON.stringify({ event_results: eventIds.map((event_id) => ({ event_id, covered: true, missing_required_beats: [], contradictions: [] })) });
      }
    }
  } catch { /* ordinary scene coverage has the same response shape without event ids */ }
  return JSON.stringify({ covered: true, missing_required_beats: [], contradictions: [] });
}

function adminUrl(baseUrl: URL): string {
  const value = new URL(baseUrl);
  value.pathname = "/postgres";
  return value.toString();
}

function ownedDatabaseUrl(baseUrl: URL, databaseName: string): string {
  assertOwnedStoryOnlyDatabase(databaseName);
  const value = new URL(baseUrl);
  value.pathname = `/${databaseName}`;
  return value.toString();
}

async function campaignSnapshot(pool: DatabasePool, campaignId: string): Promise<string> {
  const result = await pool.query<{ snapshot: string }>(
    `SELECT jsonb_build_object(
       'state', (SELECT to_jsonb(s) FROM campaign_state s WHERE s.campaign_id=$1),
       'turns', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.turn_number) FROM turns t WHERE t.campaign_id=$1), '[]'::jsonb)
     )::text AS snapshot`, [campaignId]
  );
  return result.rows[0]!.snapshot;
}

function commandRepository(pool: DatabasePool) {
  return createPostgresGenerationCommandRepository(pool, {
    resolvePromptSnapshot: (client, ownerUserId, campaignId) => loadPromptSnapshotForTest(client, ownerUserId, campaignId),
    promptProtocolVersion: providerPromptProtocolVersion,
    readTurnReportedCosts: (ownerUserId, _campaignId, turnIds) => readTurnReportedCostsForTest(pool, ownerUserId, [...turnIds])
  });
}

export async function createStoryOnlyFixture(options: Readonly<{
  playMode: StoryOnlyFixturePlayMode;
  scenario: StoryOnlyFixtureScenario;
  delayMs?: number;
  seed?: string;
}>): Promise<StoryOnlyFixture> {
  const setupStartedAt = performance.now();
  const configured = JSON.parse(await readFile(resolve("tmp/story-only-test/database.json"), "utf8")) as { url?: unknown };
  if (typeof configured.url !== "string") throw new Error("Story-only fixture requires a configured dedicated test database target.");
  const target = assertStoryOnlyRuntimeTarget(configured.url);
  const databaseName = `infinitequest_storyonly_fixture_${randomUUID().replaceAll("-", "")}`;
  const admin = createDatabasePool(adminUrl(target.baseUrl), 1);
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  await admin.end();
  const pool = createDatabasePool(ownedDatabaseUrl(target.baseUrl, databaseName), 6);
  try {
    await migrateDatabase(pool, resolve("database/migrations"));
    const ownerUserId = await initialOwnerId(pool);
    const providerProfileId = (await createProvider(pool, {
      name: `Story-only benchmark ${options.seed ?? randomUUID()}`, providerType: "openai_compatible", providerRole: "text",
      baseUrl: "http://127.0.0.1:9911", defaultModel: "story-only-benchmark-model", contextWindowTokens: 32_768,
      maxOutputTokens: 4_096, temperature: 0, enabled: true, configuration: {}
    }, credentialSecret)).id;
    const turnControlStyle = options.playMode === "story_only" ? "flexible_scene"
      : options.playMode === "legacy_action" ? "action_only" : "flexible_action";
    const imported = await importLegacyStory(pool, storyImportRequestSchema.parse({
      sourceName: "story-only-benchmark.story",
      story: {
        world: { title: `Story-only benchmark ${randomUUID()}`, genre: "test", tone: "neutral", premise: "A fictional benchmark fixture.", backgroundStory: "", character: "", firstAction: "Continue.", rules: "" },
        settings: { storyLength: "standard", textProviderProfileId: providerProfileId, turnControlStyle },
        turns: [{ id: "fixture-opening", turnNumber: 1, action: "Wait at the observatory.", narration: "Mara waits by the west door.", choices: ["Continue."] }], scratchpad: "", trackers: []
      }
    }));
    if (options.scenario === "events_configured" || options.playMode === "legacy_events") {
      await pool.query(
        `UPDATE campaign_state SET rpg_stats=$2::jsonb,event_triggers=$3::jsonb,pending_event_triggers=$4::jsonb WHERE campaign_id=$1`,
        [imported.campaignId, JSON.stringify(options.playMode === "legacy_events" ? [] : [{ id: "fixture-stat", name: "Courage", value: 3 }]),
          JSON.stringify([{ id: "fixture-event", label: "Fixture event", timing: "before", condition: options.playMode === "legacy_events" ? "always evaluate" : "never", effect: "none", addTextAfter: false, triggeredCount: 0, lastTriggeredTurn: null, lastTriggeredAt: null }]),
          JSON.stringify(options.playMode === "legacy_events" ? [] : [{ id: "fixture-pending", sourceTriggerId: "fixture-event", name: "Pending", timing: "before", condition: "", effect: "", instructions: "remain dormant", reason: "fixture", sourceTurn: 1 }])]
      );
    }
    const beforeState = await campaignSnapshot(pool, imported.campaignId);
    const closed = { value: false };
    const fixture: StoryOnlyFixture = Object.freeze({
      close: async () => {
        if (closed.value) return;
        closed.value = true;
        await pool.end();
        const cleanup = createDatabasePool(adminUrl(target.baseUrl), 1);
        try {
          assertOwnedStoryOnlyDatabase(databaseName);
          await cleanup.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid <> pg_backend_pid()", [databaseName]);
          await cleanup.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
        } finally { await cleanup.end(); }
      }
    });
    fixtures.set(fixture, Object.freeze({ pool, ownerUserId, providerProfileId, campaignId: imported.campaignId, playMode: options.playMode, scenario: options.scenario,
      delayMs: options.delayMs ?? 0, databaseName, baseUrl: target.baseUrl, beforeState, setupMs: performance.now() - setupStartedAt, closed }));
    return fixture;
  } catch (error) {
    await pool.end();
    const cleanup = createDatabasePool(adminUrl(target.baseUrl), 1);
    try { await cleanup.query(`DROP DATABASE IF EXISTS "${databaseName}"`); } finally { await cleanup.end(); }
    throw error;
  }
}

export async function runStoryOnlyFixture(fixture: StoryOnlyFixture): Promise<StoryOnlyFixtureResult> {
  const privateFixture = fixtures.get(fixture);
  if (!privateFixture || privateFixture.closed.value) throw new Error("Story-only fixture is not active.");
  const { pool, ownerUserId, providerProfileId, campaignId, scenario, delayMs } = privateFixture;
  const inputMode = privateFixture.playMode === "legacy_action" || privateFixture.playMode === "legacy_events" ? "action" : "scene";
  const queued = await commandRepository(pool).enqueueAppend({ ownerUserId, campaignId }, generationRequestSchema.parse({
    action: inputMode === "scene" ? "Set the rain-soaked observatory scene." : "Open the west door.", providerProfileId,
    idempotencyKey: randomUUID(), requestedInputMode: inputMode, resolvedInputMode: inputMode, inputModeSource: "explicit",
    context: { budgetTokens: 16_000, compression: "full", recentTurns: 8 }
  }));
  const responses = scenario === "choice_repair"
    ? [{ content: fullStory(["Wait.", " wait. ", "Listen.", "Look."]), outputLimited: false }, { content: choiceRepair(), outputLimited: false }]
    : scenario === "invalid_narration"
      ? [{ content: "{not-json", outputLimited: false }, { content: "{still-not-json", outputLimited: false }]
      : scenario === "output_limited"
        ? [{ content: "{\"narration\":\"Rain turns the observatory", outputLimited: true }]
        : [{ content: fullStory(), outputLimited: false }];
  const operations: string[] = [];
  const requests: string[] = [];
  let dispatchOperation = "";
  let failedDispatches = 0;
  let outputTokens = 0;
  const collaborators: GenerationExecutionCollaborators = {
    memory: memoryGeneration(pool, credentialSecret),
    illustration: { loadStreamingIllustrationConfig: async () => disabledIllustration, createProvisionalSet: async () => null,
      createProvisionalSegment: async () => false, promoteProvisionalSet: async () => undefined, orphanProvisionalSet: async () => undefined,
      enqueueAcceptedTurnIllustrationSegments: async () => null } as GenerationExecutionCollaborators["illustration"],
    loadTextExecution: async () => ({
      id: providerProfileId, name: "Story-only benchmark provider", providerRole: "text", providerType: "openai_compatible", model: "story-only-benchmark-model",
      contextWindowTokens: 32_768, maxOutputTokens: 4_096, temperature: 0, requestTimeoutMs: 1_000, configuration: {},
      execute: async (request: { input?: string }) => {
        requests.push(String(request.input ?? ""));
        if (delayMs > 0) await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, delayMs));
        const response = dispatchOperation === "event_trigger_before" || dispatchOperation === "event_trigger_after"
          ? { content: JSON.stringify({ activated_trigger_ids: [] }), outputLimited: false }
          : dispatchOperation === "scene_coverage_validation"
          ? { content: coverageResponse(String(request.input ?? "")), outputLimited: false }
          : responses.shift();
        if (!response) { failedDispatches += 1; throw new Error("Synthetic response queue exhausted."); }
        outputTokens += Math.ceil(response.content.length / 4);
        return { content: response.content, responseId: randomUUID(), finishReason: response.outputLimited ? "length" : "stop", outputLimited: response.outputLimited,
          modelInstanceId: "synthetic-story-only", usage: { inputTokens: Math.ceil(String(request.input ?? "").length / 4), outputTokens: Math.ceil(response.content.length / 4), totalTokens: Math.ceil((String(request.input ?? "").length + response.content.length) / 4) }, reportedCost: null, rawMetadata: {} };
      }
    }),
    promptFromSnapshot: (snapshot, key) => (snapshot as Record<string, { content?: string }> | undefined)?.[key as PromptTemplateKey]?.content ?? PROMPT_TEMPLATE_CATALOG[key].defaultContent,
    recordProfileCost: async () => null,
    onProviderDispatch: (operation) => { dispatchOperation = operation; operations.push(operation); },
    attributeGenerationCostsToTurn: async () => undefined
  };
  const repository = createPostgresGenerationExecutionRepository(pool);
  const firstClaim = await repository.claimNext({ workerId: "story-only-fixture-worker-a", leaseSeconds: 30 });
  if (firstClaim?.jobId !== queued.id) throw new Error("Story-only fixture could not claim its queued generation.");
  const startedAt = performance.now();
  let leaseExpired = false;
  const firstRepository = scenario === "lease_reclaim" ? {
    ...repository,
    saveOrchestration: async (...args: Parameters<typeof repository.saveOrchestration>) => {
      const saved = await repository.saveOrchestration(...args);
      const value = args[1];
      if (!leaseExpired && value.validatedMainDraft) {
        leaseExpired = true;
        await pool.query("UPDATE generation_jobs SET lease_expires_at=now()-interval '1 second' WHERE id=$1", [queued.id]);
      }
      return saved;
    }
  } : repository;
  await createGenerationExecutor({ pool, repository: firstRepository, collaborators }).execute({ workerId: "story-only-fixture-worker-a", leaseSeconds: 30, claim: firstClaim });
  if (scenario === "lease_reclaim") {
    if (!leaseExpired) throw new Error("Lease-reclaim fixture did not expire worker A after its saved main draft.");
    const reclaimed = await repository.claimNext({ workerId: "story-only-fixture-worker-b", leaseSeconds: 30 });
    if (reclaimed?.jobId !== queued.id) throw new Error("Lease-reclaim fixture worker B did not claim worker A's expired job.");
    await createGenerationExecutor({ pool, repository, collaborators }).execute({ workerId: "story-only-fixture-worker-b", leaseSeconds: 30, claim: reclaimed });
  }
  const timingsMs = { setup: privateFixture.setupMs, generation: Math.max(0, performance.now() - startedAt) };
  const status = await pool.query<{ status: string; result_turn_id: string | null }>("SELECT status,result_turn_id FROM generation_jobs WHERE id=$1", [queued.id]);
  const databaseVersion = await pool.query<{ server_version: string }>("SHOW server_version");
  const committed = status.rows[0]?.status === "completed" && status.rows[0]?.result_turn_id !== null;
  return Object.freeze({ operations: Object.freeze(operations), committed, timingsMs: Object.freeze(timingsMs), beforeState: privateFixture.beforeState,
    afterState: await campaignSnapshot(pool, campaignId), failures: failedDispatches,
    tokenEstimates: Object.freeze({ request: requests.reduce((sum, request) => sum + Math.ceil(request.length / 4), 0), output: outputTokens }),
    providerReportedTokens: null, postgresVersion: databaseVersion.rows[0]!.server_version });
}
