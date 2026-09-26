import { vi } from "vitest";
import { PreparedResponseContractError } from "../../packages/story-engine/src/provider-response-format.js";
import { PreparedRouteTerminalError } from "../../packages/story-engine/src/preset-route-execution.js";
import { createPostgresGenerationExecutionRepository, reconcileNextAcceptedStreamingIllustration } from "../../packages/database/src/generation-execution-repository.js";
import { createGenerationExecutionCollaborators } from "../../services/runtime/src/generation-worker-composition.js";
import { createGenerationExecutor } from "../../services/runtime/src/generation-executor-adapter.js";
import { estimateStoryTokens } from "../../packages/story-engine/src/token-estimate.js";
import { createApiIllustrationApplication } from "../../services/runtime/src/illustration-composition.js";
import { apiMemoryApplication } from "../helpers/memory-applications.js";
import { workerProviderGraph } from "../helpers/provider-application-fixtures.js";
import { createHash, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { generationRequestSchema, generationRetryLatestRequestSchema, illustrationConfigSchema } from "../../packages/contracts/src/generation.js";
import { storyImportRequestSchema } from "../../packages/contracts/src/imports.js";
import { createDatabasePool, initialOwnerId, type DatabaseClient, type DatabasePool } from "../../packages/database/src/pool.js";
import { loadRuntimeConfig } from "../../packages/database/src/config.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { loadPostgresChronicleGenerationAuthorityContext } from "../../packages/database/src/chronicle-generation-context.js";
import { resolveGenerationAuthoritySnapshot } from "../../packages/database/src/generation-authority.js";
import type { GenerationEvidenceManifest } from "../../packages/application/src/memory/generation-context.js";
import { canonicalEvidenceJson } from "../../packages/application/src/memory/generation-context.js";
import { sha256Hex } from "../../packages/contracts/src/hash.js";
import { sha256, stableStringify } from "../../packages/domain/src/text.js";
import { createProvider } from "../helpers/provider-application-fixtures.js";
import { createApiGenerationApplication as composeGeneration } from "../../services/runtime/src/generation-api-composition.js";
import { apiProviderGraph } from "../helpers/provider-application-fixtures.js";
import { saveStoryMemoryEnrollment } from "../../packages/database/src/story-memory-policy-repository.js";
import { getCampaignRuntimeState, importLegacyStory, updateCampaignRuntimeState } from "../helpers/memory-aware-services.js";
import { snapshotCorrectionEvidence } from "../helpers/campaign-state-correction-fixtures.js";
import { runGenerationJob } from "../helpers/generation-worker-harness.js";
import { setIllustrationConfig } from "../helpers/illustration-job-fixtures.js";
import { loadConfig, prepareIllustrationTextExecution } from "../../services/runtime/src/illustration-segment-job-adapter.js";
import { installIntegrationProviderTransport } from "./provider-transport-test-helper.js";
import { deriveStoryContinuityRunFromExecutorCapture, evaluateStoryContinuity, type StoryContinuityEvidence } from "../../scripts/lib/story-continuity-evaluator.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
const credentialSecret = "story-continuity-evaluator-fixture-secret";
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
// These historical compatibility scenarios exercise the Legacy response-contract path.
// Keep every temporary profile update explicit so one test cannot silently change
// the policy seen by the next case.
const legacyContinuityResponseFormatConfiguration = { textResponseFormatPolicy: "legacy" } as const;
const legacyStreamingContinuityResponseFormatConfiguration = {
  ...legacyContinuityResponseFormatConfiguration,
  streaming: true
} as const;
type CorpusScenario = Readonly<{
  id: string;
  trajectory: "teacher_forced" | "rollout";
  evidence: string;
  oracle: Readonly<{
    expectedState: Readonly<{ continuitySummary?: string; openThreads?: readonly string[] }>;
    forbiddenContradictions: readonly string[];
    authoritativeEvidence: Readonly<{ sourcePath: string }>;
  }>;
}>;
type CapturedDispatch = Readonly<{ body: string; jobId: string; manifest: GenerationEvidenceManifest }>;

function reply(narration: string, trackerUpdates: Record<string, unknown>[] = []): string {
  return JSON.stringify({ narration, choices: ["Continue.", "Wait.", "Listen.", "Leave."], custom_action_suggestion: "Study the lantern.", scratchpad: "private fixture", tracker_updates: trackerUpdates, image_prompt: "Fixture relay.", continuity_summary: narration, canonical_facts: [], superseded_facts: [], canonical_fact_updates: [], open_threads: [] });
}

integration("T17 durable continuity review", () => {
  let pool: DatabasePool;
  let server: Server;
  let ownerUserId = "";
  let providerId = "";
  let reviewVerdict: "pass" | "uncertain" | "conflict" = "pass";
  let reviewUnavailable = false;
  let reviewSequence: Array<"pass" | "uncertain" | "conflict"> = [];
  const requests: string[] = [];
  let needsChoiceRepair = false;
  let invalidChoiceRepair = false;
  let invalidPrimary = false;
  let malformedFactFormatting = false;
  let primaryFinishReason: "stop" | "length" = "stop";
  let semanticRepairNeedsChoiceRepair = false;
  let extensionConflict = false;
  let invalidSemanticRepair = false;
  let nestedTrackerUpdates: Record<string, unknown>[] | null = null;
  let eventCoverageSequence: boolean[] = [];
  let sceneCoverageSequence: boolean[] = [];
  let rejectSceneRewriteResponseFormat = false;
  let repairSupersedesFactId: string | null = null;
  let primaryNarration = "Mira waits at the observatory.";
  let interruptedPrimary: string | null = null;

  function reviewResponse(body: string): string {
    const userInput = (() => { try { return JSON.parse(JSON.parse(body).messages[1].content) as Record<string, unknown>; } catch { return null; } })();
    const system = (() => { try { return String(JSON.parse(body).messages[0].content || ""); } catch { return ""; } })();
    if ((userInput?.phase === "before" || userInput?.phase === "after") && Array.isArray(userInput.triggers)) return JSON.stringify({ activated_trigger_ids: userInput.triggers.map((trigger: { id: string }) => trigger.id), reasons: {} });
    if (system.includes("complete an already validated adventure turn")) return reply("Mira waits at the observatory.\n\nThe bell rings as the keeper arrives.");
    if (body.includes("The immediate event fiction could not be verified.")) return reply("Mira waits at the observatory.\n\nThe bell rings as the keeper arrives.");
    if (body.includes("Rewrite the complete story JSON so the narration visibly dramatizes every required scene beat")) return reply("Mira waits at the observatory.\n\nThe bell rings as the keeper arrives.");
    if (userInput?.protocol === "story-continuity-repair-v1" && repairSupersedesFactId) return JSON.stringify({ ...JSON.parse(reply("Mira waits at the observatory.")), canonical_fact_updates: [{ content: "The keeper has arrived.", supersedes_fact_ids: [repairSupersedesFactId] }] });
    if (extensionConflict && userInput?.protocol === "story-continuity-repair-v1") return reply("Mira waits at the observatory.\n\nThe bell rings as the keeper arrives.");
    if (semanticRepairNeedsChoiceRepair && userInput?.protocol === "story-continuity-repair-v1") {
      return JSON.stringify({ ...JSON.parse(reply("Mira waits at the observatory.")), choices: ["Wait.", "Wait.", "Listen.", "Leave."] });
    }
    if (invalidSemanticRepair && userInput?.protocol === "story-continuity-repair-v1") {
      return JSON.stringify({ narration: "This invalid repair omits the required turn fields." });
    }
    if (userInput?.task === "Determine whether the narration includes all concrete required beats without contradiction."
        && !Array.isArray(userInput?.required_events)) {
      const covered = sceneCoverageSequence.shift() ?? true;
      return JSON.stringify({ covered, missing_required_beats: covered ? [] : ["The requested scene beat is absent."], contradictions: [] });
    }
    if (system.includes("validate whether generated fiction") && Array.isArray(userInput?.required_events)) {
      const covered = eventCoverageSequence.shift() ?? true;
      return JSON.stringify({ event_results: (userInput.required_events as Array<{ event_id: string }>).map((event) => ({ event_id: event.event_id, covered,
        missing_required_beats: covered ? [] : ["The bell must ring."], contradictions: [] })) });
    }
    if (userInput?.protocol !== "story-continuity-review-v1") {
      if (needsChoiceRepair && body.includes("final_narration")) return JSON.stringify(invalidChoiceRepair
        ? { choices: ["Wait.", "Wait."] }
        : { choices: ["Continue.", "Wait.", "Listen.", "Leave."], custom_action_suggestion: "Study the lantern." });
      if (invalidPrimary) return JSON.stringify({ narration: "Mira waits at the observatory." });
      const story = JSON.parse(reply(primaryNarration, nestedTrackerUpdates ?? []));
      if (malformedFactFormatting) story.canonical_facts = [{ id: "keeper-arrival", content: "The keeper has arrived." }];
      if (needsChoiceRepair) story.choices = ["Wait.", "Wait.", "Listen.", "Leave."];
      return JSON.stringify(story);
    }
    if (reviewUnavailable) return "not a continuity review result";
    const input = userInput as { draft: { narration: string }; evidence: Array<{ id: string; content: string }> };
    const start = extensionConflict ? input.draft.narration.indexOf("The bell rings") : 0;
    const quote = input.draft.narration.slice(start, start + 4);
    const basis = input.evidence.find((entry) => entry.content.length > 0);
    if (!basis) throw new Error("Review fixture requires selected evidence.");
    const verdict = reviewSequence.shift() ?? reviewVerdict;
    return JSON.stringify({ version: "story-continuity-review-v1", verdict, findings: verdict === "conflict" ? [{ kind: "contradiction", category: "location", severity: "contradiction", basis: { kind: "source", evidenceId: basis.id, quote: basis.content.slice(0, 20) }, output: { path: "/narration", start, end: start + quote.length, quote }, explanation: "PRIVATE_REVIEW_CANARY: fixture reviewer reports a grounded conflict." }] : [] });
  }

  beforeAll(async () => {
    pool = createDatabasePool(databaseUrl!, 6);
    await migrateDatabase(pool, resolve(repositoryRoot, "database/migrations"));
    ownerUserId = await initialOwnerId(pool);
    const transport = installIntegrationProviderTransport();
    server = createServer((request, response) => {
      if (request.url === "/models" || request.url === "/v1/models") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: [
          { id: "t17-capturing-fake", context_length: 65_536 },
          { id: "t17-native-frozen", context_length: 163_840 }
        ] }));
        return;
      }
      if (request.url === "/presets/keep") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: {
          slug: "keep", name: "Frozen Keep", status: "active",
          designated_version: { id: "keep-v1", version: 1, system_prompt: "Native frozen preset instruction.", config: { model: "t17-native-frozen", temperature: 0.2 } }
        } }));
        return;
      }
      let body = "";
      request.setEncoding("utf8"); request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        if (request.url?.endsWith("/chat/completions")) requests.push(body);
        if (rejectSceneRewriteResponseFormat
            && body.includes("Rewrite the complete story JSON so the narration visibly dramatizes every required scene beat")
            && body.includes("\"response_format\"")) {
          response.writeHead(400, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: { message: "response_format is not supported" } }));
          return;
        }
        const content = reviewResponse(body);
        const providerRequest = JSON.parse(body) as { stream?: boolean };
        if (providerRequest.stream === true) {
          response.writeHead(200, { "content-type": "text/event-stream" });
          if (interruptedPrimary !== null) {
            const interrupted = interruptedPrimary;
            interruptedPrimary = null;
            response.write(`data: ${JSON.stringify({ id: "interrupted-fixture", choices: [{ delta: { content: interrupted }, finish_reason: null }] })}\n\n`);
            setTimeout(() => response.destroy(), 30);
            return;
          }
          const midpoint = Math.max(1, Math.floor(content.length / 2));
          for (const chunk of [content.slice(0, midpoint), content.slice(midpoint)]) {
            response.write(`data: ${JSON.stringify({ id: randomUUID(), model: "t17-capturing-fake", choices: [{ delta: { content: chunk }, finish_reason: null }] })}\n\n`);
          }
          response.write(`data: ${JSON.stringify({ id: randomUUID(), model: "t17-capturing-fake", choices: [{ delta: {}, finish_reason: primaryFinishReason }], usage: { prompt_tokens: 80, completion_tokens: 30, total_tokens: 110 } })}\n\n`);
          response.end("data: [DONE]\n\n");
          return;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ id: randomUUID(), model: "t17-capturing-fake", choices: [{ message: { content }, finish_reason: primaryFinishReason }], usage: { prompt_tokens: 80, completion_tokens: 30, total_tokens: 110, cost: 0.001 } }));
      });
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("T17 fake provider did not bind.");
    providerId = (await createProvider(pool, { name: `T17 capturing fake ${randomUUID()}`, providerType: "openai_compatible", providerRole: "text", baseUrl: `http://127.0.0.1:${address.port}`, defaultModel: "t17-capturing-fake", contextWindowTokens: 65_536, maxOutputTokens: 4_096, temperature: 0, enabled: true, configuration: legacyContinuityResponseFormatConfiguration }, credentialSecret)).id;
    (server as Server & { transport?: { close(): Promise<void> } }).transport = transport;
  });

  afterAll(async () => { await new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done())); await (server as Server & { transport?: { close(): Promise<void> } }).transport?.close(); await pool.end(); });

  afterEach(() => {
    interruptedPrimary = null;
    reviewVerdict = "pass";
    reviewUnavailable = false;
    reviewSequence = [];
    requests.length = 0;
    needsChoiceRepair = false;
    invalidChoiceRepair = false;
    invalidPrimary = false;
    malformedFactFormatting = false;
    primaryFinishReason = "stop";
    semanticRepairNeedsChoiceRepair = false;
    extensionConflict = false;
    invalidSemanticRepair = false;
    nestedTrackerUpdates = null;
    eventCoverageSequence = [];
    sceneCoverageSequence = [];
    rejectSceneRewriteResponseFormat = false;
    repairSupersedesFactId = null;
    primaryNarration = "Mira waits at the observatory.";
  });

  async function enqueue(
    mode: "off" | "observe" | "enforce",
    scene = false,
    prepareCampaign?: (campaignId: string) => Promise<void>,
    action = "Wait at the observatory.",
    storyOnly = scene,
    textProviderProfileId = providerId
  ) {
    const story = JSON.parse(await readFile(resolve(repositoryRoot, "tests/fixtures/legacy-story.json"), "utf8"));
    story.world.title = `Review ${randomUUID()}`;
    const imported = await importLegacyStory(pool, storyImportRequestSchema.parse({ sourceName: "review.story", story }));
    await saveStoryMemoryEnrollment(pool, { ownerUserId, campaignId: imported.campaignId }, { capability: "r3", reviewMode: mode }, { installedCapability: "r3", enforceEnabled: true });
    if (storyOnly) await pool.query("UPDATE campaigns SET turn_control_style='flexible_scene' WHERE id=$1", [imported.campaignId]);
    await prepareCampaign?.(imported.campaignId);
    const application = composeGeneration(pool, apiProviderGraph(pool, credentialSecret).generation, undefined, { installedCapability: "r3", enforceEnabled: true });
    const job = await application.enqueueAppend({ ownerUserId, campaignId: imported.campaignId }, generationRequestSchema.parse({ action, requestedInputMode: scene ? "scene" : "action", resolvedInputMode: scene ? "scene" : "action", inputModeSource: "explicit", providerProfileId: textProviderProfileId, idempotencyKey: randomUUID(), context: { budgetTokens: 32000, compression: "full", recentTurns: 8 } }));
    return { job, application, campaignId: imported.campaignId };
  }

  async function enqueueReplacement(mode: "off" | "observe" | "enforce", scene: boolean) {
    const story = JSON.parse(await readFile(resolve(repositoryRoot, "tests/fixtures/legacy-story.json"), "utf8"));
    story.world.title = `Review replacement ${randomUUID()}`;
    const imported = await importLegacyStory(pool, storyImportRequestSchema.parse({ sourceName: "review-replacement.story", story }));
    await saveStoryMemoryEnrollment(pool, { ownerUserId, campaignId: imported.campaignId }, { capability: "r3", reviewMode: mode }, { installedCapability: "r3", enforceEnabled: true });
    if (scene) await pool.query("UPDATE campaigns SET turn_control_style='flexible_scene' WHERE id=$1", [imported.campaignId]);
    const application = composeGeneration(pool, apiProviderGraph(pool, credentialSecret).generation, undefined, { installedCapability: "r3", enforceEnabled: true });
    const current = (await pool.query<{ active_turn_number: number }>("SELECT active_turn_number FROM campaigns WHERE id=$1", [imported.campaignId])).rows[0]!;
    const job = await application.enqueueReplacement({ ownerUserId, campaignId: imported.campaignId }, generationRetryLatestRequestSchema.parse({
      action: "Replace the observatory turn.", expectedCurrentTurnNumber: current.active_turn_number,
      requestedInputMode: scene ? "scene" : "action", resolvedInputMode: scene ? "scene" : "action", inputModeSource: "explicit",
      providerProfileId: providerId, idempotencyKey: randomUUID(), context: { budgetTokens: 32000, compression: "full", recentTurns: 8 }
    }));
    return { job, application, campaignId: imported.campaignId };
  }

  it.each([false, true])("retains an interrupted corrected candidate for explicit Keep (replacement=%s)", async (replacement) => {
    await pool.query("UPDATE provider_profiles SET configuration=$2::jsonb WHERE id=$1", [providerId, JSON.stringify(legacyStreamingContinuityResponseFormatConfiguration)]);
    try {
      const { job, application, campaignId } = replacement ? await enqueueReplacement("off", true) : await enqueue("off");
      const before = await acceptedAuthoritySnapshot(campaignId);
      const correct = reply("Mira waits at the observatory.");
      const malformed = JSON.parse(correct);
      delete malformed.custom_action_suggestion;
      interruptedPrimary = JSON.stringify(malformed) + "\n```json\n" + correct + "\n```\n" + correct.slice(0, 70);
      await runGenerationJob(pool, `interrupted-${randomUUID()}`, 30, credentialSecret);
      expect(await application.getJob({ ownerUserId, jobId: job.id })).toMatchObject({ status: "recoverable" });
      const offered = await application.getReview({ ownerUserId, jobId: job.id });
      expect(offered).toMatchObject({ canKeep: true, narration: "Mira waits at the observatory.", reasons: ["provider_interrupted"] });
      expect(await acceptedAuthoritySnapshot(campaignId)).toEqual(before);
      const count = requests.length;
      await application.decideReview({ ownerUserId, jobId: job.id }, { reviewId: offered.reviewId, revision: offered.revision, decision: "keep" });
      await runGenerationJob(pool, `interrupted-keep-${randomUUID()}`, 30, credentialSecret);
      expect(await application.getJob({ ownerUserId, jobId: job.id })).toMatchObject({ status: "completed" });
      expect(requests).toHaveLength(count);
    } finally {
      await pool.query("UPDATE provider_profiles SET configuration=$2::jsonb WHERE id=$1", [providerId, JSON.stringify(legacyContinuityResponseFormatConfiguration)]);
    }
  });

  it.each(["incomplete", "ambiguous"])("preserves %s interrupted output without permitting Keep", async (kind) => {
    await pool.query("UPDATE provider_profiles SET configuration=$2::jsonb WHERE id=$1", [providerId, JSON.stringify(legacyStreamingContinuityResponseFormatConfiguration)]);
    try {
      const { job, application, campaignId } = await enqueue("off");
      const before = await acceptedAuthoritySnapshot(campaignId);
      const raw = kind === "incomplete" ? reply("Mira waits.").slice(0, -5)
        : reply("Mira waits.") + reply("Mira leaves.");
      interruptedPrimary = raw;
      await runGenerationJob(pool, `interrupted-invalid-${randomUUID()}`, 30, credentialSecret);
      expect(await application.getJob({ ownerUserId, jobId: job.id })).toMatchObject({ status: "recoverable",
        failureDiagnostic: { code: "provider_transport_error" } });
      expect(await application.getReview({ ownerUserId, jobId: job.id })).toMatchObject({ canKeep: false, canRetry: true });
      expect(await acceptedAuthoritySnapshot(campaignId)).toEqual(before);
      expect((await pool.query("SELECT raw_output FROM generation_attempts WHERE generation_job_id=$1", [job.id])).rows[0].raw_output).toBe(raw);
    } finally {
      await pool.query("UPDATE provider_profiles SET configuration=$2::jsonb WHERE id=$1", [providerId, JSON.stringify(legacyContinuityResponseFormatConfiguration)]);
    }
  });

  function loadDefaultRuntimeStoryMemoryConfig() {
    const previousDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = databaseUrl!;
    try {
      const config = loadRuntimeConfig();
      expect(config).toMatchObject({ storyMemoryCapability: "r3", storyMemoryEnforceEnabled: true });
      return config;
    } finally {
      if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousDatabaseUrl;
    }
  }

  /**
   * Accepted authority is the only state a rejected or pending repair may not
   * change.  Keep this as direct PostgreSQL evidence instead of inferring it
   * from the job projection, which intentionally includes private pending
   * review state.
   */
  async function acceptedAuthoritySnapshot(campaignId: string) {
    const result = await pool.query<{
      turns: unknown;
      campaignState: unknown;
      facts: unknown;
      acceptedChronicle: unknown;
    }>(
      `SELECT
         COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.turn_number, t.id)
                   FROM turns t
                   WHERE t.campaign_id=$1 AND t.accepted_at IS NOT NULL), '[]'::jsonb) AS turns,
         (SELECT to_jsonb(cs) FROM campaign_state cs WHERE cs.campaign_id=$1) AS "campaignState",
         COALESCE((SELECT jsonb_agg(to_jsonb(f) ORDER BY f.source_turn_number, f.source_fact_index, f.id)
                   FROM campaign_canonical_facts f WHERE f.campaign_id=$1), '[]'::jsonb) AS facts,
         COALESCE((SELECT jsonb_agg(to_jsonb(m) ORDER BY m.created_at, m.id)
                   FROM chronicle_memories m
                   JOIN turns t ON t.id=m.turn_id
                   WHERE m.campaign_id=$1 AND t.accepted_at IS NOT NULL), '[]'::jsonb) AS "acceptedChronicle"`,
      [campaignId]
    );
    return result.rows[0]!;
  }

  function expectOneFactFormatRepairApplication(
    orchestration: Record<string, any>,
    expected: { jobId: string; reviewId: string; revision: number; planHash: string; sourceResponseId?: string; rawOutputReference?: string; producingRequestHash?: string; providerConfigurationHash?: string }
  ) {
    expect(orchestration.factFormatRepairApplications).toEqual([expect.objectContaining({
      version: 1,
      ...expected,
      rawOutputHash: expect.any(String),
      resultHash: expect.any(String)
    })]);
  }

  it("repairs malformed fact formatting once from the retained primary response", async () => {
    const { job, application, campaignId } = await enqueue("enforce");
    malformedFactFormatting = true;
    reviewVerdict = "pass";
    requests.length = 0;
    const acceptedBefore = (await pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM turns WHERE campaign_id=$1 AND accepted_at IS NOT NULL", [campaignId]
    )).rows[0]!.count;
    await runGenerationJob(pool, `format-offer-${randomUUID()}`, 30, credentialSecret);
    const offered = await application.getReview({ ownerUserId, jobId: job.id });
    expect(offered).toMatchObject({ version: 2, stage: "structure", canRepairFormat: true });
    await expect(pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM turns WHERE campaign_id=$1 AND accepted_at IS NOT NULL", [campaignId]
    )).resolves.toMatchObject({ rows: [{ count: acceptedBefore }] });
    const planHash = offered.version === 2 ? offered.formatRepair?.planHash : null;
    expect(planHash).toEqual(expect.any(String));
    await application.decideReview({ ownerUserId, jobId: job.id }, {
      reviewId: offered.reviewId, revision: offered.revision, decision: "repair_format", repairPlanHash: planHash!
    });
    await runGenerationJob(pool, `format-apply-${randomUUID()}`, 30, credentialSecret);
    expect(await application.getJob({ ownerUserId, jobId: job.id })).toMatchObject({ status: "completed" });
    expect(requests.filter((body) => !body.includes("story-continuity-review-v1"))).toHaveLength(1);
    await expect(pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM turns WHERE campaign_id=$1 AND accepted_at IS NOT NULL", [campaignId]
    )).resolves.toMatchObject({ rows: [{ count: acceptedBefore + 1 }] });
    await expect(pool.query<{ narration: string }>(
      "SELECT narration FROM turns WHERE campaign_id=$1 AND accepted_at IS NOT NULL ORDER BY turn_number DESC LIMIT 1", [campaignId]
    )).resolves.toMatchObject({ rows: [{ narration: "Mira waits at the observatory." }] });
    const saved = (await pool.query<{ orchestration_private: Record<string, unknown> }>(
      "SELECT orchestration_private FROM generation_jobs WHERE id=$1", [job.id]
    )).rows[0]!.orchestration_private;
    expect(saved.validatedMainDraft).toMatchObject({ factFormatRepair: { planHash } });
  });

  it("keeps a nested private tracker through local fact repair, a crashed enforce review, and one reclaimed commit", async () => {
    const nestedTracker = [{
      tracker_private_canary: "do-not-project",
      id: "observatory-archive",
      name: "Observatory archive",
      value: "open",
      rules: "Fiction-only location state.",
      private_nested: {
        shelves: [3, { sealed: false, labels: ["astral", "ledger"] }],
        discoveries: [{ title: "brass key", tags: ["cold", "etched"] }, "keeper-note"]
      },
      active: true,
      urgency: 2
    }];
    await pool.query("UPDATE provider_profiles SET configuration=$2::jsonb WHERE id=$1", [providerId, JSON.stringify({ textResponseFormatPolicy: "auto" })]);
    nestedTrackerUpdates = nestedTracker;
    malformedFactFormatting = true;
    reviewVerdict = "pass";
    requests.length = 0;
    try {
      const { job, application, campaignId } = await enqueue("enforce");
      const acceptedBefore = await acceptedAuthoritySnapshot(campaignId);
      const derivedBefore = await snapshotCorrectionEvidence(pool, campaignId);

      await expect(runGenerationJob(pool, `nested-format-offer-${randomUUID()}`, 30, credentialSecret)).resolves.toBe(true);
      expect(await application.getJob({ ownerUserId, jobId: job.id })).toMatchObject({ status: "recoverable", errorCode: "generation_review_required" });
      expect(await acceptedAuthoritySnapshot(campaignId)).toEqual(acceptedBefore);
      expect(await snapshotCorrectionEvidence(pool, campaignId)).toEqual(derivedBefore);
      const formatOffer = await application.getReview({ ownerUserId, jobId: job.id });
      if (formatOffer.version !== 2 || !formatOffer.formatRepair) throw new Error("Expected malformed facts to offer a local repair.");
      const beforeRepair = (await pool.query<{ orchestration_private: Record<string, any> }>(
        "SELECT orchestration_private FROM generation_jobs WHERE id=$1", [job.id]
      )).rows[0]!.orchestration_private;
      expect(beforeRepair.queuedResponsePolicy).toMatchObject({ policy: "auto", invocationKeys: expect.arrayContaining(["story:nonstream", "continuity_review:nonstream"]) });
      expect(beforeRepair.primaryResult.response.content).toContain("tracker_private_canary");
      const frozenBeforeRepair = beforeRepair.frozenResponseContracts;
      const primaryBeforeRepair = beforeRepair.primaryResult;
      const callsBeforeRepair = requests.length;

      await application.decideReview({ ownerUserId, jobId: job.id }, {
        reviewId: formatOffer.reviewId, revision: formatOffer.revision, decision: "repair_format", repairPlanHash: formatOffer.formatRepair.planHash
      });
      expect(requests).toHaveLength(callsBeforeRepair);

      const repository = createPostgresGenerationExecutionRepository(pool);
      const providers = workerProviderGraph(pool, credentialSecret);
      const collaborators = createGenerationExecutionCollaborators(pool, createApiIllustrationApplication(pool, providers.illustration), apiMemoryApplication(pool, credentialSecret), providers.generation);
      const illustrationInputs: string[] = [];
      const enqueueIllustrations = collaborators.illustration.enqueueAcceptedTurnIllustrationSegments;
      collaborators.illustration.enqueueAcceptedTurnIllustrationSegments = async (...args) => {
        illustrationInputs.push(JSON.stringify(args));
        return enqueueIllustrations(...args);
      };
      let interrupted = false;
      const crashingRepository = {
        ...repository,
        async saveOrchestration(scope: Parameters<typeof repository.saveOrchestration>[0], value: Parameters<typeof repository.saveOrchestration>[1]) {
          const saved = await repository.saveOrchestration(scope, value);
          if (!interrupted && value.continuityReview?.status === "completed") {
            interrupted = true;
            await pool.query("UPDATE generation_jobs SET lease_expires_at=now()-interval '1 second' WHERE id=$1", [job.id]);
            throw Object.assign(new Error("Injected termination after persisted nested-tracker continuity review."), { code: "generation_cancelled" });
          }
          return saved;
        }
      };
      const firstWorkerId = `nested-format-crash-a-${randomUUID()}`;
      const firstClaim = await repository.claimNext({ workerId: firstWorkerId, leaseSeconds: 30 });
      expect(firstClaim?.jobId).toBe(job.id);
      await expect(createGenerationExecutor({ pool, repository: crashingRepository, collaborators })
        .execute({ claim: firstClaim!, workerId: firstWorkerId, leaseSeconds: 30 })).resolves.toBe(true);
      expect(interrupted).toBe(true);
      expect(await acceptedAuthoritySnapshot(campaignId)).toEqual(acceptedBefore);
      const checkpoint = (await pool.query<{ orchestration_private: Record<string, any>; attempts: number }>(
        "SELECT orchestration_private,attempts FROM generation_jobs WHERE id=$1", [job.id]
      )).rows[0]!;
      expect(checkpoint.orchestration_private.frozenResponseContracts).toEqual(frozenBeforeRepair);
      expect(checkpoint.orchestration_private.primaryResult).toEqual(primaryBeforeRepair);
      expect(checkpoint.orchestration_private.continuityReview).toMatchObject({ status: "completed", verdict: "pass" });
      const reviewRequest = requests.find((request) => request.includes("story-continuity-review-v1"));
      expect(reviewRequest).toBeDefined();
      expect(reviewRequest).not.toContain("tracker_private_canary");
      expect(requests).toHaveLength(callsBeforeRepair + 1);

      const secondWorkerId = `nested-format-crash-b-${randomUUID()}`;
      const secondClaim = await repository.claimNext({ workerId: secondWorkerId, leaseSeconds: 30 });
      expect(secondClaim?.jobId).toBe(job.id);
      await expect(createGenerationExecutor({ pool, repository, collaborators })
        .execute({ claim: secondClaim!, workerId: secondWorkerId, leaseSeconds: 30 })).resolves.toBe(true);
      const accepted = (await pool.query<{ state_snapshot_private: {
        trackers: Array<Record<string, unknown>>;
        acceptedTrackerUpdateEvidence: { version: number; updates: unknown };
      } }>(
        "SELECT state_snapshot_private FROM turns WHERE id=(SELECT result_turn_id FROM generation_jobs WHERE id=$1)", [job.id]
      )).rows[0]!;
      expect(accepted.state_snapshot_private.acceptedTrackerUpdateEvidence).toEqual({ version: 1, updates: nestedTracker });
      expect(accepted.state_snapshot_private.trackers).toEqual(expect.arrayContaining([{
        id: "observatory-archive", name: "Observatory archive", value: "open", rules: "Fiction-only location state."
      }]));
      expect(accepted.state_snapshot_private.trackers).not.toContainEqual(expect.objectContaining({ private_nested: expect.anything() }));
      expect(illustrationInputs).toHaveLength(1);
      expect(illustrationInputs[0]).not.toContain("tracker_private_canary");
      const completed = (await pool.query<{ status: string; attempts: number; orchestration_private: Record<string, any> }>(
        "SELECT status,attempts,orchestration_private FROM generation_jobs WHERE id=$1", [job.id]
      )).rows[0]!;
      expect(completed).toMatchObject({ status: "completed" });
      expect(completed.attempts).toBeGreaterThan(checkpoint.attempts);
      expect(completed.orchestration_private.frozenResponseContracts).toEqual(frozenBeforeRepair);
      expect(completed.orchestration_private.primaryResult).toEqual(primaryBeforeRepair);
      expect(requests).toHaveLength(callsBeforeRepair + 1);
      expect(await runGenerationJob(pool, `nested-format-crash-idempotent-${randomUUID()}`, 30, credentialSecret)).toBe(false);
      expect(requests).toHaveLength(callsBeforeRepair + 1);
      expect((await pool.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM turns WHERE id=(SELECT result_turn_id FROM generation_jobs WHERE id=$1)", [job.id]
      )).rows[0]!.count).toBe(1);
    } finally {
      await pool.query("UPDATE provider_profiles SET configuration=$2::jsonb WHERE id=$1", [providerId, JSON.stringify(legacyContinuityResponseFormatConfiguration)]);
    }
  }, 60_000);

  it("offers an explicit format repair for complete JSON marked length-limited by the provider", async () => {
    const { job, application, campaignId } = await enqueue("enforce");
    malformedFactFormatting = true;
    primaryFinishReason = "length";
    const acceptedBefore = await acceptedAuthoritySnapshot(campaignId);

    await runGenerationJob(pool, `format-length-offer-${randomUUID()}`, 30, credentialSecret);

    expect(await application.getJob({ ownerUserId, jobId: job.id })).toMatchObject({
      status: "recoverable", errorCode: "generation_review_required"
    });
    const offer = await application.getReview({ ownerUserId, jobId: job.id });
    expect(offer).toMatchObject({ version: 2, stage: "structure", canRepairFormat: true });
    expect(await acceptedAuthoritySnapshot(campaignId)).toEqual(acceptedBefore);
  });

  it("does not offer fact formatting repair when the same candidate has invalid Story Direction choices", async () => {
    const { job, application, campaignId } = await enqueue("enforce", true);
    malformedFactFormatting = true;
    needsChoiceRepair = true;
    const acceptedBefore = await acceptedAuthoritySnapshot(campaignId);

    await runGenerationJob(pool, `format-invalid-scene-choices-${randomUUID()}`, 30, credentialSecret);

    expect(await application.getJob({ ownerUserId, jobId: job.id })).toMatchObject({
      status: "recoverable", errorCode: "generation_review_required"
    });
    const offer = await application.getReview({ ownerUserId, jobId: job.id });
    expect(offer).toMatchObject({ version: 1, stage: "structure" });
    expect("canRepairFormat" in offer && offer.canRepairFormat).toBe(false);
    expect(await acceptedAuthoritySnapshot(campaignId)).toEqual(acceptedBefore);
  });

  it("keeps accepted authority frozen through the repair offer and receipt, then commits the exact repaired candidate once", async () => {
    const { job, application, campaignId } = await enqueue("enforce");
    malformedFactFormatting = true;
    reviewVerdict = "pass";
    requests.length = 0;
    const acceptedBefore = await acceptedAuthoritySnapshot(campaignId);

    await runGenerationJob(pool, `format-authority-offer-${randomUUID()}`, 30, credentialSecret);
    expect(await application.getJob({ ownerUserId, jobId: job.id })).toMatchObject({ status: "recoverable", errorCode: "generation_review_required" });
    expect(await acceptedAuthoritySnapshot(campaignId)).toEqual(acceptedBefore);
    const offer = await application.getReview({ ownerUserId, jobId: job.id });
    if (offer.version !== 2 || !offer.formatRepair) throw new Error("Expected the malformed fact candidate to offer a v2 repair.");
    const savedAtOffer = (await pool.query("SELECT orchestration_private FROM generation_jobs WHERE id=$1", [job.id])).rows[0]!.orchestration_private;
    const original = JSON.parse(savedAtOffer.primaryResult.response.content);
    const primaryCalls = requests.filter((body) => !body.includes("story-continuity-review-v1") && !body.includes("story-continuity-repair-v1"));
    expect(primaryCalls).toHaveLength(1);

    await Promise.all([
      application.decideReview({ ownerUserId, jobId: job.id }, { reviewId: offer.reviewId, revision: offer.revision, decision: "repair_format", repairPlanHash: offer.formatRepair.planHash }),
      application.decideReview({ ownerUserId, jobId: job.id }, { reviewId: offer.reviewId, revision: offer.revision, decision: "repair_format", repairPlanHash: offer.formatRepair.planHash })
    ]);
    expect(await acceptedAuthoritySnapshot(campaignId)).toEqual(acceptedBefore);

    await runGenerationJob(pool, `format-authority-apply-${randomUUID()}`, 30, credentialSecret);
    expect(await application.getJob({ ownerUserId, jobId: job.id })).toMatchObject({ status: "completed" });
    expect(requests.filter((body) => !body.includes("story-continuity-review-v1") && !body.includes("story-continuity-repair-v1"))).toHaveLength(1);
    expect(requests.filter((body) => body.includes("story-continuity-review-v1"))).toHaveLength(1);
    const costs = await pool.query<{ operation: string }>("SELECT operation FROM provider_cost_events WHERE generation_job_id=$1 ORDER BY created_at", [job.id]);
    expect(costs.rows.filter((row) => row.operation === "story_generation")).toHaveLength(1);
    expect(costs.rows.filter((row) => row.operation === "story_continuity_review")).toHaveLength(1);

    const accepted = await application.getResult({ ownerUserId, jobId: job.id });
    expect(accepted).toMatchObject({
      narration: original.narration,
      choices: original.choices,
      customActionSuggestion: original.custom_action_suggestion
    });
    await expect(pool.query<{ content: string }>(
      "SELECT content FROM campaign_canonical_facts WHERE campaign_id=$1 ORDER BY source_turn_number,source_fact_index,id", [campaignId]
    )).resolves.toEqual(expect.objectContaining({ rows: expect.arrayContaining([{ content: "The keeper has arrived." }]) }));
    const after = await acceptedAuthoritySnapshot(campaignId);
    expect((after.turns as unknown[]).length).toBe((acceptedBefore.turns as unknown[]).length + 1);
    const saved = (await pool.query("SELECT orchestration_private FROM generation_jobs WHERE id=$1", [job.id])).rows[0]!.orchestration_private;
    expect(saved.generationReview.decisionJournal.filter((entry: { decision: string }) => entry.decision === "repair_format")).toHaveLength(1);
    expect(saved.generationReview.factFormatRepair).toMatchObject({ status: "applied", planHash: offer.formatRepair.planHash });
    expect(saved.validatedMainDraft).toMatchObject({ factFormatRepair: { planHash: offer.formatRepair.planHash } });
    expectOneFactFormatRepairApplication(saved, {
      jobId: job.id, reviewId: offer.reviewId, revision: offer.revision, planHash: offer.formatRepair.planHash,
      sourceResponseId: savedAtOffer.primaryResult.response.responseId, rawOutputReference: savedAtOffer.primaryResult.rawOutputReference,
      producingRequestHash: savedAtOffer.primaryResult.requestPayloadHash, providerConfigurationHash: savedAtOffer.primaryResult.providerConfigurationHash
    });

    expect(await runGenerationJob(pool, `format-authority-duplicate-${randomUUID()}`, 30, credentialSecret)).toBe(false);
    expect(await acceptedAuthoritySnapshot(campaignId)).toEqual(after);
  });

  it.each([
    { mode: "off" as const, semanticCalls: 0 },
    { mode: "observe" as const, semanticCalls: 1 },
    { mode: "enforce" as const, semanticCalls: 1 }
  ])("preserves the $mode continuity policy after an explicit fact-format repair", async ({ mode, semanticCalls }) => {
    const { job, application } = await enqueue(mode);
    malformedFactFormatting = true;
    reviewVerdict = "pass";
    requests.length = 0;

    await runGenerationJob(pool, `format-policy-offer-${mode}-${randomUUID()}`, 30, credentialSecret);
    const offer = await application.getReview({ ownerUserId, jobId: job.id });
    if (offer.version !== 2 || !offer.formatRepair) throw new Error("Expected a format repair offer.");
    await application.decideReview({ ownerUserId, jobId: job.id }, {
      reviewId: offer.reviewId, revision: offer.revision, decision: "repair_format", repairPlanHash: offer.formatRepair.planHash
    });
    await runGenerationJob(pool, `format-policy-apply-${mode}-${randomUUID()}`, 30, credentialSecret);

    expect(await application.getJob({ ownerUserId, jobId: job.id })).toMatchObject({ status: "completed" });
    expect(requests.filter((body) => !body.includes("story-continuity-review-v1") && !body.includes("story-continuity-repair-v1"))).toHaveLength(1);
    expect(requests.filter((body) => body.includes("story-continuity-review-v1"))).toHaveLength(semanticCalls);
    const saved = (await pool.query("SELECT orchestration_private FROM generation_jobs WHERE id=$1", [job.id])).rows[0]!.orchestration_private;
    if (mode === "off") expect(saved.continuityReview).toBeUndefined();
    else expect(saved.continuityReview).toMatchObject({ mode, status: "completed", verdict: "pass" });
  });

  it.each([
    { label: "Action append", operation: "append", scene: false },
    { label: "Action replace-latest", operation: "replace_latest", scene: false },
    { label: "Story Direction append", operation: "append", scene: true },
    { label: "Story Direction replace-latest", operation: "replace_latest", scene: true }
  ] as const)("applies a format repair for $label without replacing the primary candidate", async ({ operation, scene }) => {
    const fixture = operation === "append"
      ? await enqueue("enforce", scene)
      : await enqueueReplacement("enforce", scene);
    const { job, application, campaignId } = fixture;
    malformedFactFormatting = true;
    reviewVerdict = "pass";
    requests.length = 0;
    const acceptedBefore = await acceptedAuthoritySnapshot(campaignId);

    await runGenerationJob(pool, `format-operation-offer-${randomUUID()}`, 30, credentialSecret);
    const offer = await application.getReview({ ownerUserId, jobId: job.id });
    if (offer.version !== 2 || !offer.formatRepair) throw new Error("Expected a format repair offer.");
    await application.decideReview({ ownerUserId, jobId: job.id }, {
      reviewId: offer.reviewId, revision: offer.revision, decision: "repair_format", repairPlanHash: offer.formatRepair.planHash
    });
    await runGenerationJob(pool, `format-operation-apply-${randomUUID()}`, 30, credentialSecret);

    expect(await application.getJob({ ownerUserId, jobId: job.id })).toMatchObject({ status: "completed", operationKind: operation });
    expect(requests.filter((body) => !body.includes("story-continuity-review-v1") && !body.includes("story-continuity-repair-v1"))).toHaveLength(1);
    expect(requests.filter((body) => body.includes("story-continuity-review-v1"))).toHaveLength(1);
    const acceptedAfter = await acceptedAuthoritySnapshot(campaignId);
    expect((acceptedAfter.turns as unknown[]).length).toBe((acceptedBefore.turns as unknown[]).length + (operation === "append" ? 1 : 0));
    expect((await pool.query<{ count: number }>("SELECT count(*)::int AS count FROM turns WHERE id=(SELECT result_turn_id FROM generation_jobs WHERE id=$1)", [job.id])).rows[0]!.count).toBe(1);
  });

  it("keeps a repaired turn accepted when its optional illustration enqueue fails, without a duplicate enqueue on resume", async () => {
    const { job, application, campaignId } = await enqueue("enforce");
    malformedFactFormatting = true;
    reviewVerdict = "pass";
    requests.length = 0;
    const acceptedBefore = await acceptedAuthoritySnapshot(campaignId);
    await runGenerationJob(pool, `format-artwork-offer-${randomUUID()}`, 30, credentialSecret);
    const offer = await application.getReview({ ownerUserId, jobId: job.id });
    if (offer.version !== 2 || !offer.formatRepair) throw new Error("Expected a format repair offer.");
    await application.decideReview({ ownerUserId, jobId: job.id }, {
      reviewId: offer.reviewId, revision: offer.revision, decision: "repair_format", repairPlanHash: offer.formatRepair.planHash
    });

    const repository = createPostgresGenerationExecutionRepository(pool);
    const providers = workerProviderGraph(pool, credentialSecret);
    const collaborators = createGenerationExecutionCollaborators(pool, createApiIllustrationApplication(pool, providers.illustration), apiMemoryApplication(pool, credentialSecret), providers.generation);
    const enqueueIllustrations = vi.fn(async () => { throw new Error("Injected optional illustration enqueue failure."); });
    collaborators.illustration.enqueueAcceptedTurnIllustrationSegments = enqueueIllustrations;
    const workerId = `format-artwork-${randomUUID()}`;
    const claim = await repository.claimNext({ workerId, leaseSeconds: 30 });
    await createGenerationExecutor({ pool, repository, collaborators }).execute({ claim: claim!, workerId, leaseSeconds: 30 });

    expect(await application.getJob({ ownerUserId, jobId: job.id })).toMatchObject({ status: "completed" });
    expect(enqueueIllustrations).toHaveBeenCalledTimes(1);
    expect((await acceptedAuthoritySnapshot(campaignId)).turns as unknown[]).toHaveLength((acceptedBefore.turns as unknown[]).length + 1);
    expect(await runGenerationJob(pool, `format-artwork-duplicate-${randomUUID()}`, 30, credentialSecret)).toBe(false);
    expect(enqueueIllustrations).toHaveBeenCalledTimes(1);
  });

  it("rejects a foreign owner and an actual foreign campaign repair scope without accepted writes", async () => {
    const { job, application, campaignId } = await enqueue("enforce");
    malformedFactFormatting = true;
    reviewVerdict = "pass";
    requests.length = 0;
    await runGenerationJob(pool, `format-scope-offer-${randomUUID()}`, 30, credentialSecret);
    const offer = await application.getReview({ ownerUserId, jobId: job.id });
    if (offer.version !== 2 || !offer.formatRepair) throw new Error("Expected a format repair offer.");
    const acceptedBefore = await acceptedAuthoritySnapshot(campaignId);
    const foreignOwner = (await pool.query<{ id: string }>(
      "INSERT INTO users(display_name) VALUES($1) RETURNING id", [`format repair foreign owner ${randomUUID()}`]
    )).rows[0]!.id;
    const foreignStory = JSON.parse(await readFile(resolve(repositoryRoot, "tests/fixtures/legacy-story.json"), "utf8"));
    foreignStory.world.title = `Format repair foreign campaign ${randomUUID()}`;
    const foreignCampaign = await importLegacyStory(pool, storyImportRequestSchema.parse({ sourceName: "format-repair-foreign.story", story: foreignStory }));
    const foreignBefore = await acceptedAuthoritySnapshot(foreignCampaign.campaignId);

    await expect(application.decideReview({ ownerUserId: foreignOwner, jobId: job.id }, {
      reviewId: offer.reviewId, revision: offer.revision, decision: "repair_format", repairPlanHash: offer.formatRepair.planHash
    })).rejects.toThrow();
    expect(await acceptedAuthoritySnapshot(campaignId)).toEqual(acceptedBefore);

    await application.decideReview({ ownerUserId, jobId: job.id }, {
      reviewId: offer.reviewId, revision: offer.revision, decision: "repair_format", repairPlanHash: offer.formatRepair.planHash
    });
    const saved = (await pool.query<{ orchestration_private: Record<string, any> }>(
      "SELECT orchestration_private FROM generation_jobs WHERE id=$1", [job.id]
    )).rows[0]!.orchestration_private;
    const repair = saved.generationReview.factFormatRepair;
    repair.campaignId = foreignCampaign.campaignId;
    const receipt = saved.generationReview.decisionJournal.find((entry: { decision: string }) => entry.decision === "repair_format");
    receipt.repair.campaignId = foreignCampaign.campaignId;
    await pool.query("UPDATE generation_jobs SET orchestration_private=$2::jsonb WHERE id=$1", [job.id, JSON.stringify(saved)]);

    await runGenerationJob(pool, `format-scope-apply-${randomUUID()}`, 30, credentialSecret);
    expect(await application.getJob({ ownerUserId, jobId: job.id })).toMatchObject({ status: expect.stringMatching(/^(recoverable|failed)$/u) });
    expect(await acceptedAuthoritySnapshot(campaignId)).toEqual(acceptedBefore);
    expect(requests.filter((body) => !body.includes("story-continuity-review-v1") && !body.includes("story-continuity-repair-v1"))).toHaveLength(1);
    expect(await acceptedAuthoritySnapshot(foreignCampaign.campaignId)).toEqual(foreignBefore);
  });

  it.each([
    { boundary: "before decision", point: "before_decision" },
    { boundary: "after receipt", point: "after_receipt" },
    { boundary: "after applied repair checkpoint", point: "after_applied" },
    { boundary: "after semantic-review checkpoint", point: "after_semantic" },
    { boundary: "before commit", point: "before_commit" },
    { boundary: "after commit acknowledgement loss", point: "after_commit" }
  ] as const)("reclaims an explicit repair crash $boundary without a second accepted turn or primary call", async ({ point }) => {
    const { job, application, campaignId } = await enqueue("enforce");
    malformedFactFormatting = true;
    reviewVerdict = "pass";
    requests.length = 0;
    const acceptedBefore = await acceptedAuthoritySnapshot(campaignId);
    await runGenerationJob(pool, `format-crash-offer-${point}-${randomUUID()}`, 30, credentialSecret);
    const offer = await application.getReview({ ownerUserId, jobId: job.id });
    if (offer.version !== 2 || !offer.formatRepair) throw new Error("Expected a format repair offer.");
    const offeredOrchestration = (await pool.query<{ orchestration_private: Record<string, any> }>(
      "SELECT orchestration_private FROM generation_jobs WHERE id=$1", [job.id]
    )).rows[0]!.orchestration_private;
    const originalPrimary = offeredOrchestration.primaryResult;
    expect(originalPrimary).toMatchObject({
      rawOutputReference: expect.any(String), requestPayloadHash: expect.any(String),
      providerConfigurationHash: expect.any(String), response: { responseId: expect.any(String), content: expect.any(String) }
    });
    let acceptedIllustrationEnqueueCount = 0;

    if (point === "before_decision") {
      expect(await runGenerationJob(pool, `format-crash-pending-${randomUUID()}`, 30, credentialSecret)).toBe(false);
    }
    await application.decideReview({ ownerUserId, jobId: job.id }, {
      reviewId: offer.reviewId, revision: offer.revision, decision: "repair_format", repairPlanHash: offer.formatRepair.planHash
    });

    if (point === "after_receipt") {
      const repository = createPostgresGenerationExecutionRepository(pool);
      const claim = await repository.claimNext({ workerId: `format-crash-receipt-${randomUUID()}`, leaseSeconds: 30 });
      expect(claim?.jobId).toBe(job.id);
      await pool.query("UPDATE generation_jobs SET lease_expires_at=now()-interval '1 second' WHERE id=$1", [job.id]);
    } else if (point !== "before_decision") {
      const repository = createPostgresGenerationExecutionRepository(pool);
      const providers = workerProviderGraph(pool, credentialSecret);
      const collaborators = createGenerationExecutionCollaborators(pool, createApiIllustrationApplication(pool, providers.illustration), apiMemoryApplication(pool, credentialSecret), providers.generation);
      if (point === "before_commit" || point === "after_commit") {
        const enqueueIllustrations = collaborators.illustration.enqueueAcceptedTurnIllustrationSegments;
        collaborators.illustration.enqueueAcceptedTurnIllustrationSegments = async (...args) => {
          acceptedIllustrationEnqueueCount += 1;
          return enqueueIllustrations(...args);
        };
      }
      let interrupted = false;
      const wrapped = {
        ...repository,
        async saveOrchestration(scope: Parameters<typeof repository.saveOrchestration>[0], value: Parameters<typeof repository.saveOrchestration>[1]) {
          const updated = await repository.saveOrchestration(scope, value);
          const factRepair = (value as { generationReview?: { factFormatRepair?: { status?: string } } }).generationReview?.factFormatRepair;
          const continuity = (value as { continuityReview?: { status?: string } }).continuityReview;
          if (!interrupted && ((point === "after_applied" && factRepair?.status === "applied")
            || (point === "after_semantic" && continuity?.status === "completed"))) {
            interrupted = true;
            await pool.query("UPDATE generation_jobs SET lease_expires_at=now()-interval '1 second' WHERE id=$1", [job.id]);
            throw Object.assign(new Error(`Injected repair crash at ${point}.`), { code: "generation_cancelled" });
          }
          return updated;
        },
        async commitAcceptedTurn(input: Parameters<typeof repository.commitAcceptedTurn>[0]) {
          if (point === "before_commit") {
            interrupted = true;
            await pool.query("UPDATE generation_jobs SET lease_expires_at=now()-interval '1 second' WHERE id=$1", [job.id]);
            throw Object.assign(new Error("Injected repair crash before commit."), { code: "generation_cancelled" });
          }
          const committed = await repository.commitAcceptedTurn(input);
          if (point === "after_commit") {
            interrupted = true;
            throw Object.assign(new Error("Injected acknowledgement loss after repair commit."), { code: "generation_cancelled" });
          }
          return committed;
        }
      };
      const workerId = `format-crash-${point}-${randomUUID()}`;
      const claim = await repository.claimNext({ workerId, leaseSeconds: 30 });
      expect(claim?.jobId).toBe(job.id);
      await createGenerationExecutor({ pool, repository: wrapped, collaborators }).execute({ claim: claim!, workerId, leaseSeconds: 30 });
      expect(interrupted).toBe(true);
      if (point === "before_commit" || point === "after_commit") {
        expect(acceptedIllustrationEnqueueCount).toBe(point === "after_commit" ? 1 : 0);
      }
    }

    const authorityBeforeReclaim = await acceptedAuthoritySnapshot(campaignId);
    if (point === "after_commit") {
      expect((authorityBeforeReclaim.turns as unknown[]).length).toBe((acceptedBefore.turns as unknown[]).length + 1);
    } else {
      expect(authorityBeforeReclaim).toEqual(acceptedBefore);
    }
    const callsBeforeReclaim = requests.length;
    await runGenerationJob(pool, `format-crash-reclaim-${point}-${randomUUID()}`, 30, credentialSecret);
    expect(await application.getJob({ ownerUserId, jobId: job.id })).toMatchObject({ status: "completed" });
    expect(requests.filter((body) => !body.includes("story-continuity-review-v1") && !body.includes("story-continuity-repair-v1"))).toHaveLength(1);
    expect(requests.filter((body) => body.includes("story-continuity-review-v1"))).toHaveLength(1);
    expect(requests.length).toBeGreaterThanOrEqual(callsBeforeReclaim);
    const after = await acceptedAuthoritySnapshot(campaignId);
    expect((after.turns as unknown[]).length).toBe((acceptedBefore.turns as unknown[]).length + 1);
    expect((await pool.query<{ count: number }>("SELECT count(*)::int AS count FROM turns WHERE id=(SELECT result_turn_id FROM generation_jobs WHERE id=$1)", [job.id])).rows[0]!.count).toBe(1);
    if (point === "after_commit") expect(after).toEqual(authorityBeforeReclaim);
    const saved = (await pool.query<{ orchestration_private: Record<string, any> }>(
      "SELECT orchestration_private FROM generation_jobs WHERE id=$1", [job.id]
    )).rows[0]!.orchestration_private;
    expect(saved.primaryResult).toMatchObject({
      rawOutputReference: originalPrimary.rawOutputReference,
      requestPayloadHash: originalPrimary.requestPayloadHash,
      providerConfigurationHash: originalPrimary.providerConfigurationHash,
      response: { responseId: originalPrimary.response.responseId, content: originalPrimary.response.content }
    });
    const receipts = saved.generationReview.decisionJournal.filter((entry: { decision: string }) => entry.decision === "repair_format");
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ reviewId: offer.reviewId, revision: offer.revision, planHash: offer.formatRepair.planHash });
    expect(saved.generationReview.factFormatRepair).toMatchObject({ status: "applied", planHash: offer.formatRepair.planHash });
    expect(saved.validatedMainDraft).toMatchObject({
      requestPayloadHash: originalPrimary.requestPayloadHash,
      response: { responseId: originalPrimary.response.responseId },
      factFormatRepair: { planHash: offer.formatRepair.planHash }
    });
    expectOneFactFormatRepairApplication(saved, {
      jobId: job.id, reviewId: offer.reviewId, revision: offer.revision, planHash: offer.formatRepair.planHash,
      sourceResponseId: originalPrimary.response.responseId, rawOutputReference: originalPrimary.rawOutputReference,
      producingRequestHash: originalPrimary.requestPayloadHash, providerConfigurationHash: originalPrimary.providerConfigurationHash
    });
  });

  it("retains an applied format-repair receipt through a later continuity Keep", async () => {
    const { job, application } = await enqueue("enforce");
    malformedFactFormatting = true;
    reviewSequence = ["conflict"];
    requests.length = 0;
    await runGenerationJob(pool, `format-continuity-offer-${randomUUID()}`, 30, credentialSecret);
    const offer = await application.getReview({ ownerUserId, jobId: job.id });
    if (offer.version !== 2 || !offer.formatRepair) throw new Error("Expected format repair offer.");
    await application.decideReview({ ownerUserId, jobId: job.id }, {
      reviewId: offer.reviewId, revision: offer.revision, decision: "repair_format", repairPlanHash: offer.formatRepair.planHash
    });
    await runGenerationJob(pool, `format-continuity-review-${randomUUID()}`, 30, credentialSecret);
    const continuity = await application.getReview({ ownerUserId, jobId: job.id });
    expect(continuity).toMatchObject({ stage: "continuity", canKeep: true });
    await application.decideReview({ ownerUserId, jobId: job.id }, {
      reviewId: continuity.reviewId, revision: continuity.revision, decision: "keep"
    });
    await runGenerationJob(pool, `format-continuity-keep-${randomUUID()}`, 30, credentialSecret);
    expect(await application.getJob({ ownerUserId, jobId: job.id })).toMatchObject({ status: "completed" });
    const saved = (await pool.query<{ orchestration_private: { generationReview: { decisionJournal: Array<{ decision: string }> } } }>(
      "SELECT orchestration_private FROM generation_jobs WHERE id=$1", [job.id]
    )).rows[0]!.orchestration_private;
    expect(saved.generationReview.decisionJournal.map((entry) => entry.decision)).toEqual(["repair_format", "keep"]);
    expect(requests.filter((body) => !body.includes("story-continuity-review-v1"))).toHaveLength(1);
  });

  it("re-opens the normal continuity decision after a repaired candidate conflicts, without a primary rewrite", async () => {
    const { job, application, campaignId } = await enqueue("enforce");
    malformedFactFormatting = true;
    reviewSequence = ["conflict"];
    requests.length = 0;
    const acceptedBefore = await acceptedAuthoritySnapshot(campaignId);

    await runGenerationJob(pool, `format-conflict-offer-${randomUUID()}`, 30, credentialSecret);
    const offer = await application.getReview({ ownerUserId, jobId: job.id });
    if (offer.version !== 2 || !offer.formatRepair) throw new Error("Expected format repair offer.");
    await application.decideReview({ ownerUserId, jobId: job.id }, {
      reviewId: offer.reviewId, revision: offer.revision, decision: "repair_format", repairPlanHash: offer.formatRepair.planHash
    });
    await runGenerationJob(pool, `format-conflict-review-${randomUUID()}`, 30, credentialSecret);

    expect(await application.getJob({ ownerUserId, jobId: job.id })).toMatchObject({ status: "recoverable", errorCode: "generation_review_required" });
    const continuity = await application.getReview({ ownerUserId, jobId: job.id });
    expect(continuity).toMatchObject({ stage: "continuity", canKeep: true, canRetry: true });
    expect(await acceptedAuthoritySnapshot(campaignId)).toEqual(acceptedBefore);
    expect(requests.filter((body) => !body.includes("story-continuity-review-v1") && !body.includes("story-continuity-repair-v1"))).toHaveLength(1);
    expect(requests.filter((body) => body.includes("story-continuity-review-v1"))).toHaveLength(1);
    expect(await runGenerationJob(pool, `format-conflict-pending-${randomUUID()}`, 30, credentialSecret)).toBe(false);
    const saved = (await pool.query<{ orchestration_private: Record<string, any> }>(
      "SELECT orchestration_private FROM generation_jobs WHERE id=$1", [job.id]
    )).rows[0]!.orchestration_private;
    expect(saved.generationReview).toMatchObject({ state: "pending", stage: "continuity", factFormatRepair: { status: "applied", planHash: offer.formatRepair.planHash } });
    expectOneFactFormatRepairApplication(saved, {
      jobId: job.id, reviewId: offer.reviewId, revision: offer.revision, planHash: offer.formatRepair.planHash
    });
  });

  it("repairs the replacement primary after an explicit full Retry", async () => {
    const { job, application, campaignId } = await enqueue("enforce");
    malformedFactFormatting = true;
    reviewVerdict = "pass";
    requests.length = 0;
    const acceptedBefore = await acceptedAuthoritySnapshot(campaignId);

    await runGenerationJob(pool, `format-second-repair-first-offer-${randomUUID()}`, 30, credentialSecret);
    const firstOffer = await application.getReview({ ownerUserId, jobId: job.id });
    if (firstOffer.version !== 2 || !firstOffer.formatRepair) throw new Error("Expected first format repair offer.");
    const firstPrimary = (await pool.query<{ orchestration_private: Record<string, any> }>(
      "SELECT orchestration_private FROM generation_jobs WHERE id=$1", [job.id]
    )).rows[0]!.orchestration_private.primaryResult;
    await application.decideReview({ ownerUserId, jobId: job.id }, {
      reviewId: firstOffer.reviewId, revision: firstOffer.revision, decision: "retry"
    });
    await runGenerationJob(pool, `format-second-repair-full-retry-${randomUUID()}`, 30, credentialSecret);
    expect(await acceptedAuthoritySnapshot(campaignId)).toEqual(acceptedBefore);
    const secondOffer = await application.getReview({ ownerUserId, jobId: job.id });
    if (secondOffer.version !== 2 || !secondOffer.formatRepair) throw new Error(`Expected second format repair offer: ${JSON.stringify({ secondOffer, job: await application.getJob({ ownerUserId, jobId: job.id }) })}`);
    expect(secondOffer.reviewId).not.toBe(firstOffer.reviewId);
    const secondPrimary = (await pool.query<{ orchestration_private: Record<string, any> }>(
      "SELECT orchestration_private FROM generation_jobs WHERE id=$1", [job.id]
    )).rows[0]!.orchestration_private.primaryResult;
    expect(secondPrimary.response.responseId).not.toBe(firstPrimary.response.responseId);

    await application.decideReview({ ownerUserId, jobId: job.id }, {
      reviewId: secondOffer.reviewId, revision: secondOffer.revision, decision: "repair_format", repairPlanHash: secondOffer.formatRepair.planHash
    });
    await runGenerationJob(pool, `format-second-repair-apply-${randomUUID()}`, 30, credentialSecret);

    expect(await application.getJob({ ownerUserId, jobId: job.id })).toMatchObject({ status: "completed" });
    expect(requests.filter((body) => !body.includes("story-continuity-review-v1") && !body.includes("story-continuity-repair-v1"))).toHaveLength(2);
    expect(requests.filter((body) => body.includes("story-continuity-review-v1"))).toHaveLength(1);
    const saved = (await pool.query<{ orchestration_private: Record<string, any> }>(
      "SELECT orchestration_private FROM generation_jobs WHERE id=$1", [job.id]
    )).rows[0]!.orchestration_private;
    const repairs = saved.generationReview.decisionJournal.filter((entry: { decision: string }) => entry.decision === "repair_format");
    expect(repairs).toHaveLength(1);
    expect(repairs[0]).toMatchObject({ reviewId: secondOffer.reviewId, revision: secondOffer.revision, planHash: secondOffer.formatRepair.planHash });
    expect(saved.generationReview.decisionJournal.map((entry: { decision: string }) => entry.decision)).toEqual(["retry", "repair_format"]);
    expect(saved.validatedMainDraft).toMatchObject({
      requestPayloadHash: secondPrimary.requestPayloadHash,
      response: { responseId: secondPrimary.response.responseId },
      factFormatRepair: { reviewId: secondOffer.reviewId, planHash: secondOffer.formatRepair.planHash }
    });
    expectOneFactFormatRepairApplication(saved, {
      jobId: job.id, reviewId: secondOffer.reviewId, revision: secondOffer.revision, planHash: secondOffer.formatRepair.planHash,
      sourceResponseId: secondPrimary.response.responseId, rawOutputReference: secondPrimary.rawOutputReference,
      producingRequestHash: secondPrimary.requestPayloadHash, providerConfigurationHash: secondPrimary.providerConfigurationHash
    });
    expect((await acceptedAuthoritySnapshot(campaignId)).turns as unknown[]).toHaveLength((acceptedBefore.turns as unknown[]).length + 1);
  });

  it.each(["matching", "incompatible"] as const)("%s event-extension checkpoints bind to the repaired main before resume", async (extensionState) => {
    const { job, application, campaignId } = await enqueue("enforce");
    const triggerId = randomUUID();
    await pool.query("UPDATE campaign_state SET event_triggers=$2::jsonb WHERE campaign_id=$1", [campaignId, JSON.stringify([{
      id: triggerId, label: "Keeper arrival", timing: "after", condition: "Mira waits.",
      effect: "The bell rings as the keeper arrives.", addTextAfter: true, triggeredCount: 0,
      lastTriggeredTurn: null, lastTriggeredAt: null
    }])]);
    malformedFactFormatting = true;
    reviewVerdict = "pass";
    requests.length = 0;
    const acceptedBefore = await acceptedAuthoritySnapshot(campaignId);

    await runGenerationJob(pool, `format-extension-offer-${extensionState}-${randomUUID()}`, 30, credentialSecret);
    const offer = await application.getReview({ ownerUserId, jobId: job.id });
    if (offer.version !== 2 || !offer.formatRepair) throw new Error("Expected format repair offer.");
    await application.decideReview({ ownerUserId, jobId: job.id }, {
      reviewId: offer.reviewId, revision: offer.revision, decision: "repair_format", repairPlanHash: offer.formatRepair.planHash
    });

    const repository = createPostgresGenerationExecutionRepository(pool);
    const providers = workerProviderGraph(pool, credentialSecret);
    const collaborators = createGenerationExecutionCollaborators(pool, createApiIllustrationApplication(pool, providers.illustration), apiMemoryApplication(pool, credentialSecret), providers.generation);
    let interrupted = false;
    const wrapped = {
      ...repository,
      async saveOrchestration(scope: Parameters<typeof repository.saveOrchestration>[0], value: Parameters<typeof repository.saveOrchestration>[1]) {
        const saved = await repository.saveOrchestration(scope, value);
        if (!interrupted && value.extension) {
          interrupted = true;
          await pool.query("UPDATE generation_jobs SET lease_expires_at=now()-interval '1 second' WHERE id=$1", [job.id]);
          throw Object.assign(new Error("Injected stop after repaired event-extension checkpoint."), { code: "generation_cancelled" });
        }
        return saved;
      }
    };
    const workerId = `format-extension-${extensionState}-${randomUUID()}`;
    const claim = await repository.claimNext({ workerId, leaseSeconds: 30 });
    expect(claim?.jobId).toBe(job.id);
    await createGenerationExecutor({ pool, repository: wrapped, collaborators }).execute({ claim: claim!, workerId, leaseSeconds: 30 });
    expect(interrupted).toBe(true);
    const checkpoint = (await pool.query<{ orchestration_private: Record<string, any> }>(
      "SELECT orchestration_private FROM generation_jobs WHERE id=$1", [job.id]
    )).rows[0]!.orchestration_private;
    expect(checkpoint.extension).toMatchObject({
      validatedMainDraftHash: checkpoint.validatedMainDraft.draftHash,
      finalStoryHash: expect.any(String), producingRequestPayloadHash: expect.any(String)
    });
    expect(await acceptedAuthoritySnapshot(campaignId)).toEqual(acceptedBefore);
    if (extensionState === "incompatible") {
      checkpoint.extension.validatedMainDraftHash = "0".repeat(64);
      await pool.query("UPDATE generation_jobs SET orchestration_private=$2::jsonb WHERE id=$1", [job.id, JSON.stringify(checkpoint)]);
    }

    const callsBeforeReclaim = requests.length;
    await runGenerationJob(pool, `format-extension-reclaim-${extensionState}-${randomUUID()}`, 30, credentialSecret);
    const saved = (await pool.query<{ orchestration_private: Record<string, any> }>(
      "SELECT orchestration_private FROM generation_jobs WHERE id=$1", [job.id]
    )).rows[0]!.orchestration_private;
    if (extensionState === "incompatible") {
      expect(await application.getJob({ ownerUserId, jobId: job.id })).toMatchObject({ status: "recoverable", errorCode: "generation_checkpoint_incompatible" });
      expect(await acceptedAuthoritySnapshot(campaignId)).toEqual(acceptedBefore);
      expect(requests).toHaveLength(callsBeforeReclaim);
    } else {
      expect(await application.getJob({ ownerUserId, jobId: job.id })).toMatchObject({ status: "completed" });
      expect(saved.extension.story.narration.startsWith(saved.validatedMainDraft.story.narration)).toBe(true);
      expect(saved.generationReview.factFormatRepair).toMatchObject({ status: "applied", planHash: offer.formatRepair.planHash });
      expectOneFactFormatRepairApplication(saved, {
        jobId: job.id, reviewId: offer.reviewId, revision: offer.revision, planHash: offer.formatRepair.planHash
      });
    }
  });

  it("pauses invalid Story Direction choices until one retry repairs the retained narration", async () => {
    const { job, application, campaignId } = await enqueue("enforce", true);
    reviewVerdict = "pass"; requests.length = 0; needsChoiceRepair = true;
    try {
      const acceptedBefore = (await pool.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM turns WHERE campaign_id=$1 AND accepted_at IS NOT NULL", [campaignId]
      )).rows[0]!.count;
      await runGenerationJob(pool, `choices-${randomUUID()}`, 30, credentialSecret);
      expect(await application.getJob({ ownerUserId, jobId: job.id })).toMatchObject({
        status: "recoverable", errorCode: "generation_review_required"
      });
      const savedBeforeDecision = (await pool.query("SELECT orchestration_private FROM generation_jobs WHERE id=$1", [job.id])).rows[0].orchestration_private;
      const originalStory = JSON.parse(savedBeforeDecision.primaryResult.response.content);
      expect(savedBeforeDecision.generationReview).toMatchObject({ state: "pending", stage: "choices", candidateScope: "main" });
      expect(savedBeforeDecision.generationReview.gateCandidate.story).toBeNull();
      expect(requests).toHaveLength(1);
      expect(requests[0]).not.toContain("story-only-choice-repair-v1");
      expect((await pool.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM turns WHERE campaign_id=$1 AND accepted_at IS NOT NULL", [campaignId]
      )).rows[0]!.count).toBe(acceptedBefore);

      const review = await application.getReview({ ownerUserId, jobId: job.id });
      expect(review).toMatchObject({ stage: "choices", canKeep: false });
      await application.decideReview({ ownerUserId, jobId: job.id }, {
        reviewId: review.reviewId, revision: review.revision, decision: "retry"
      });

      await runGenerationJob(pool, `choices-retry-${randomUUID()}`, 30, credentialSecret);
      expect(await application.getJob({ ownerUserId, jobId: job.id })).toMatchObject({ status: "completed" });
      const saved = (await pool.query("SELECT orchestration_private FROM generation_jobs WHERE id=$1", [job.id])).rows[0].orchestration_private;
      expect(requests).toHaveLength(3);
      expect(saved.primaryResult).toMatchObject({
        requestPayloadHash: createHash("sha256").update(requests[0]!).digest("hex"),
        response: { responseId: expect.any(String) }
      });
      expect(saved.choiceRepair).toMatchObject({ status: "validated", authorizedReviewId: review.reviewId, authorizedRevision: review.revision });
      expect(saved.logicalAttempt).toMatchObject({ choiceRepairsConsumed: 1 });
      expect(saved.continuityReview.binding.auxiliaryRequestHashes).toEqual([createHash("sha256").update(requests[1]!).digest("hex")]);
      expect(saved.continuityReview.binding.producingRequestHash).toBe(createHash("sha256").update(requests[0]!).digest("hex"));
      expect(JSON.parse(JSON.parse(requests[2]!).messages[1].content).draft.choices).toEqual(["Continue.", "Wait.", "Listen.", "Leave."]);
      expect((await pool.query<{ narration: string }>(
        "SELECT narration FROM turns WHERE campaign_id=$1 AND accepted_at IS NOT NULL ORDER BY turn_number DESC LIMIT 1", [campaignId]
      )).rows[0]!.narration).toBe(originalStory.narration);
    } finally { needsChoiceRepair = false; }
  });

  it("re-offers the original choice candidate when its authorized repair fails", async () => {
    const { job, application } = await enqueue("enforce", true);
    reviewVerdict = "pass"; requests.length = 0; needsChoiceRepair = true; invalidChoiceRepair = true;
    try {
      await runGenerationJob(pool, `choice-reoffer-initial-${randomUUID()}`, 30, credentialSecret);
      const first = await application.getReview({ ownerUserId, jobId: job.id });
      expect(first).toMatchObject({ stage: "choices", state: "pending", canRetry: true, narration: null });

      await application.decideReview({ ownerUserId, jobId: job.id }, { reviewId: first.reviewId, revision: first.revision, decision: "retry" });
      await runGenerationJob(pool, `choice-reoffer-retry-${randomUUID()}`, 30, credentialSecret);

      const reoffered = await application.getReview({ ownerUserId, jobId: job.id });
      expect(await application.getJob({ ownerUserId, jobId: job.id })).toMatchObject({ status: "recoverable", errorCode: "generation_review_required" });
      expect(reoffered).toMatchObject({ stage: "choices", state: "pending", canRetry: false, narration: null });
      expect(reoffered.revision).toBeGreaterThan(first.revision);
    } finally { needsChoiceRepair = false; invalidChoiceRepair = false; }
  });

  it("re-offers the original structure candidate when its authorized retry fails", async () => {
    const { job, application } = await enqueue("enforce");
    reviewVerdict = "pass"; requests.length = 0; invalidPrimary = true;
    try {
      await runGenerationJob(pool, `structure-reoffer-initial-${randomUUID()}`, 30, credentialSecret);
      const first = await application.getReview({ ownerUserId, jobId: job.id });
      expect(first).toMatchObject({ stage: "structure", state: "pending", canRetry: true, narration: null });

      await application.decideReview({ ownerUserId, jobId: job.id }, { reviewId: first.reviewId, revision: first.revision, decision: "retry" });
      await runGenerationJob(pool, `structure-reoffer-retry-${randomUUID()}`, 30, credentialSecret);

      const reoffered = await application.getReview({ ownerUserId, jobId: job.id });
      expect(await application.getJob({ ownerUserId, jobId: job.id })).toMatchObject({ status: "recoverable", errorCode: "generation_review_required" });
      expect(reoffered).toMatchObject({ stage: "structure", state: "pending", canRetry: false, narration: null });
      expect(reoffered.revision).toBeGreaterThan(first.revision);
    } finally { invalidPrimary = false; }
  });

  it("does not dispatch a primary replacement from a historical structure retry receipt", async () => {
    const { job, application } = await enqueue("enforce");
    reviewVerdict = "pass"; requests.length = 0; invalidPrimary = true;
    try {
      await runGenerationJob(pool, `structure-stale-initial-${randomUUID()}`, 30, credentialSecret);
      const gate = await application.getReview({ ownerUserId, jobId: job.id });
      await application.decideReview({ ownerUserId, jobId: job.id }, { reviewId: gate.reviewId, revision: gate.revision, decision: "retry" });
      const saved = (await pool.query<{ orchestration_private: Record<string, unknown> }>("SELECT orchestration_private FROM generation_jobs WHERE id=$1", [job.id])).rows[0]!.orchestration_private;
      const review = saved.generationReview as { decisionJournal: Array<Record<string, unknown>> };
      const receipt = review.decisionJournal.at(-1)!;
      receipt.reviewId = randomUUID();
      delete saved.primaryResult;
      (saved.primaryReservation as { status: string }).status = "reserved";
      await pool.query("UPDATE generation_jobs SET orchestration_private=$2::jsonb WHERE id=$1", [job.id, JSON.stringify(saved)]);

      await runGenerationJob(pool, `structure-stale-reclaim-${randomUUID()}`, 30, credentialSecret);
      expect(requests).toHaveLength(1);
      expect(await application.getJob({ ownerUserId, jobId: job.id })).toMatchObject({ status: "recoverable" });
    } finally { invalidPrimary = false; }
  });

  it.each(["observe", "enforce"] as const)("%s completes a review when selected pinned world references are sent", async (mode) => {
    const worldLore = "The Sable Relay remembers every oath sworn beneath its lens.";
    const relationshipLore = "The keeper answers the Sable Relay after dusk.";
    const { job, application } = await enqueue(mode, false, async (campaignId) => {
      const version = (await pool.query<{ world_version_id: string }>("SELECT world_version_id FROM campaigns WHERE id=$1", [campaignId])).rows[0]!.world_version_id;
      await pool.query(
        `UPDATE world_versions SET content=jsonb_set(jsonb_set(content,'{entities}',$2::jsonb,true),'{relationships}',$3::jsonb,true) WHERE id=$1`,
        [version, JSON.stringify([{ id: "relay", name: "Sable Relay", description: worldLore }, { id: "keeper", name: "Relay Keeper", description: "Maintains the lens." }]), JSON.stringify([{ id: "relay-keeper", from: "relay", to: "keeper", description: relationshipLore }])]
      );
    }, "Ask the Sable Relay and its keeper about their oath.");
    reviewVerdict = "pass"; requests.length = 0;

    await runGenerationJob(pool, `world-reference-${mode}-${randomUUID()}`, 30, credentialSecret);

    expect(await application.getJob({ ownerUserId, jobId: job.id })).toMatchObject({ status: "completed" });
    const saved = (await pool.query("SELECT orchestration_private FROM generation_jobs WHERE id=$1", [job.id])).rows[0].orchestration_private;
    expect(saved.continuityReview).toMatchObject({ mode, verdict: "pass", binding: { manifestHash: expect.any(String) } });
    expect(requests).toHaveLength(2);
    expect(requests[0]).toContain(worldLore);
    expect(requests[0]).toContain(relationshipLore);
  });

  it.each([
    { label: "conflict", unavailable: false, verdict: "conflict" as const },
    { label: "unavailable", unavailable: true, verdict: "pass" as const }
  ])("commits the exact final Keep offline after a $label review", async ({ unavailable, verdict }) => {
    await pool.query("UPDATE provider_profiles SET configuration=$2::jsonb WHERE id=$1", [providerId, JSON.stringify(legacyStreamingContinuityResponseFormatConfiguration)]);
    const { job, application, campaignId } = await enqueue("enforce");
    reviewVerdict = verdict; reviewUnavailable = unavailable; requests.length = 0;
    try {
      await runGenerationJob(pool, `offline-final-keep-initial-${randomUUID()}`, 30, credentialSecret);
      const pending = await application.getJob({ ownerUserId, jobId: job.id });
      expect(pending).toMatchObject({ status: "recoverable", errorCode: "generation_review_required" });
      const beforeAccepted = await pool.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM turns WHERE campaign_id=$1 AND accepted_at IS NOT NULL", [campaignId]
      );
      const savedBefore = (await pool.query<{ orchestration_private: { generationReview: { gateCandidate: { story: { narration: string }; storyHash: string }; state: string } } }>(
        "SELECT orchestration_private FROM generation_jobs WHERE id=$1", [job.id]
      )).rows[0]!.orchestration_private;
      expect(savedBefore.generationReview).toMatchObject({ state: "pending" });
      expect(requests.filter((body) => body.includes("story-continuity-repair-v1"))).toHaveLength(0);

      const review = await application.getReview({ ownerUserId, jobId: job.id });
      await application.decideReview({ ownerUserId, jobId: job.id }, {
        reviewId: review.reviewId, revision: review.revision, decision: "keep"
      });
      await pool.query(
        `UPDATE generation_jobs
            SET streaming_segments_state=jsonb_build_object(
              'illustrationTextExecutionSnapshot',
              jsonb_build_object('version',2,'state','unavailable','errorCode','illustration_text_route_unavailable')
            )
          WHERE id=$1`,
        [job.id]
      );
      const requestsBeforeOfflineKeep = requests.length;
      const repository = createPostgresGenerationExecutionRepository(pool);
      const providers = workerProviderGraph(pool, credentialSecret);
      const loadTextExecution = vi.fn(async () => { throw new Error("text provider must remain offline for final Keep"); });
      const prepareIllustrationTextExecution = vi.fn(async () => { throw new Error("Keep must reuse the saved illustration snapshot"); });
      const collaborators = {
        ...createGenerationExecutionCollaborators(pool, createApiIllustrationApplication(pool, providers.illustration), apiMemoryApplication(pool, credentialSecret), providers.generation),
        loadTextExecution,
        prepareIllustrationTextExecution
      };
      const workerId = `offline-final-keep-resume-${randomUUID()}`;
      const claim = await repository.claimNext({ workerId, leaseSeconds: 30 });
      expect(claim?.jobId).toBe(job.id);
      await expect(createGenerationExecutor({ pool, repository, collaborators }).execute({ claim: claim!, workerId, leaseSeconds: 30 })).resolves.toBe(true);

      expect(loadTextExecution).not.toHaveBeenCalled();
      expect(prepareIllustrationTextExecution).not.toHaveBeenCalled();
      expect(requests).toHaveLength(requestsBeforeOfflineKeep);
      expect(await application.getJob({ ownerUserId, jobId: job.id })).toMatchObject({ status: "completed" });
      const acceptedAfter = await pool.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM turns WHERE campaign_id=$1 AND accepted_at IS NOT NULL", [campaignId]
      );
      expect(acceptedAfter.rows).toEqual([{ count: beforeAccepted.rows[0]!.count + 1 }]);
      const keptTurn = await pool.query<{ narration: string }>(
        `SELECT narration FROM turns WHERE campaign_id=$1 AND accepted_at IS NOT NULL
          ORDER BY turn_number DESC LIMIT 1`, [campaignId]
      );
      expect(keptTurn.rows).toEqual([{ narration: savedBefore.generationReview.gateCandidate.story.narration }]);
      const savedAfter = (await pool.query<{ orchestration_private: { generationReview: { gateCandidate: { storyHash: string } } } }>(
        "SELECT orchestration_private FROM generation_jobs WHERE id=$1", [job.id]
      )).rows[0]!.orchestration_private;
      expect(savedAfter.generationReview.gateCandidate.storyHash).toBe(savedBefore.generationReview.gateCandidate.storyHash);
      expect(requests.filter((request) => JSON.parse(request).stream === true)).toHaveLength(1);
    } finally {
      reviewUnavailable = false;
      reviewVerdict = "pass";
      await pool.query("UPDATE provider_profiles SET configuration=$2::jsonb WHERE id=$1", [providerId, JSON.stringify(legacyContinuityResponseFormatConfiguration)]);
    }
  });

  it("fails the final Keep commit closed when its persisted producing ledger identity is corrupted", async () => {
    await pool.query("UPDATE provider_profiles SET configuration=$2::jsonb WHERE id=$1", [
      providerId, JSON.stringify({ streaming: true, textResponseFormatPolicy: "auto" })
    ]);
    const { job, application, campaignId } = await enqueue("enforce");
    reviewVerdict = "conflict";
    requests.length = 0;
    try {
      await runGenerationJob(pool, `corrupted-keep-initial-${randomUUID()}`, 30, credentialSecret);
      const review = await application.getReview({ ownerUserId, jobId: job.id });
      expect(review).toMatchObject({ state: "pending", stage: "continuity", canKeep: true });
      const durableResponseContract = (await pool.query<{
        orchestration_private: {
          queuedResponsePolicy?: unknown;
          frozenResponseContracts?: unknown;
          responseContractInvocations?: Array<{ operation?: string; status?: string }>;
        };
      }>("SELECT orchestration_private FROM generation_jobs WHERE id=$1", [job.id])).rows[0]!.orchestration_private;
      expect(durableResponseContract.queuedResponsePolicy).toMatchObject({ policy: "auto" });
      expect(durableResponseContract.frozenResponseContracts).toMatchObject({ queuedPolicy: { policy: "auto" } });
      expect(durableResponseContract.responseContractInvocations).toEqual(expect.arrayContaining([
        expect.objectContaining({ operation: "story_generation", status: "completed" })
      ]));
      await application.decideReview({ ownerUserId, jobId: job.id }, {
        reviewId: review.reviewId, revision: review.revision, decision: "keep"
      });

      const authorityBefore = await acceptedAuthoritySnapshot(campaignId);
      const requestsBeforeCommit = requests.length;
      const repository = createPostgresGenerationExecutionRepository(pool);
      const providers = workerProviderGraph(pool, credentialSecret);
      const loadTextExecution = vi.fn(async () => { throw new Error("a final Keep commit must not invoke the text provider"); });
      const collaborators = {
        ...createGenerationExecutionCollaborators(pool, createApiIllustrationApplication(pool, providers.illustration), apiMemoryApplication(pool, credentialSecret), providers.generation),
        loadTextExecution
      };
      let commitAttempts = 0;
      const corruptedCommitRepository = {
        ...repository,
        async commitAcceptedTurn(input: Parameters<typeof repository.commitAcceptedTurn>[0]) {
          commitAttempts += 1;
          await pool.query(
            "UPDATE generation_jobs SET orchestration_private=jsonb_set(orchestration_private,'{primaryResult,requestPayloadHash}',$2::jsonb) WHERE id=$1",
            [job.id, JSON.stringify("f".repeat(64))]
          );
          return repository.commitAcceptedTurn(input);
        }
      };
      const workerId = `corrupted-keep-commit-${randomUUID()}`;
      const claim = await repository.claimNext({ workerId, leaseSeconds: 30 });
      expect(claim?.jobId).toBe(job.id);
      await expect(createGenerationExecutor({ pool, repository: corruptedCommitRepository, collaborators })
        .execute({ claim: claim!, workerId, leaseSeconds: 30 })).resolves.toBe(true);

      expect(commitAttempts).toBe(1);
      expect(loadTextExecution).not.toHaveBeenCalled();
      expect(requests).toHaveLength(requestsBeforeCommit);
      expect(await application.getJob({ ownerUserId, jobId: job.id }))
        .toMatchObject({ status: "recoverable", errorCode: "generation_checkpoint_incompatible" });
      expect(await acceptedAuthoritySnapshot(campaignId)).toEqual(authorityBefore);
      await expect(pool.query<{ result_turn_id: string | null }>(
        "SELECT result_turn_id FROM generation_jobs WHERE id=$1", [job.id]
      )).resolves.toMatchObject({ rows: [{ result_turn_id: null }] });
    } finally {
      reviewVerdict = "pass";
      await pool.query("UPDATE provider_profiles SET configuration=$2::jsonb WHERE id=$1", [providerId, JSON.stringify(legacyContinuityResponseFormatConfiguration)]);
    }
  });

  it.each([
    { label: "append Action", operation: "append", scene: false, storyOnly: false },
    { label: "append scene", operation: "append", scene: true, storyOnly: false },
    { label: "replacement Action", operation: "replace_latest", scene: false, storyOnly: false },
    { label: "replacement scene", operation: "replace_latest", scene: true, storyOnly: false },
    { label: "Story-only scene", operation: "append", scene: true, storyOnly: true }
  ] as const)("streams a complete primary candidate and commits the exact final Keep for $label", async ({ operation, scene, storyOnly }) => {
    await pool.query("UPDATE provider_profiles SET configuration=$2::jsonb WHERE id=$1", [providerId, JSON.stringify(legacyStreamingContinuityResponseFormatConfiguration)]);
    try {
      const fixture = operation === "append"
        ? await enqueue("enforce", scene, undefined, "Wait at the observatory.", storyOnly)
        : await enqueueReplacement("enforce", scene);
      const { job, application, campaignId } = fixture;
      reviewVerdict = "conflict";
      requests.length = 0;
      const acceptedBefore = (await pool.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM turns WHERE campaign_id=$1 AND accepted_at IS NOT NULL", [campaignId]
      )).rows[0]!.count;
      await runGenerationJob(pool, `streamed-final-keep-${randomUUID()}`, 30, credentialSecret);

      expect(await application.getJob({ ownerUserId, jobId: job.id })).toMatchObject({
        status: "recoverable", errorCode: "generation_review_required", partialNarration: "Mira waits at the observatory."
      });
      const review = await application.getReview({ ownerUserId, jobId: job.id });
      expect(review).toMatchObject({ state: "pending", stage: "continuity", canKeep: true });
      expect(review.narration).toBe("Mira waits at the observatory.");
      expect(JSON.parse(requests[0]!).stream).toBe(true);
      const savedBefore = (await pool.query<{ orchestration_private: { generationReview: { gateCandidate: { storyHash: string; story: { narration: string; choices: string[]; custom_action_suggestion: string } } } } }>(
        "SELECT orchestration_private FROM generation_jobs WHERE id=$1", [job.id]
      )).rows[0]!.orchestration_private;
      expect(savedBefore.generationReview.gateCandidate.story.narration).toBe(review.narration);
      expect(savedBefore.generationReview.gateCandidate.storyHash)
        .toBe(sha256Hex(canonicalEvidenceJson(savedBefore.generationReview.gateCandidate.story)));
      const primaryRequests = requests.filter((request) => {
        const body = JSON.parse(request) as { stream?: boolean; messages?: Array<{ content?: string }> };
        return body.stream === true && !body.messages?.some((message) => message.content?.includes("story-continuity-review-v1") || message.content?.includes("story-continuity-repair-v1"));
      });
      expect(primaryRequests).toHaveLength(1);
      expect(requests.filter((request) => request.includes("story-continuity-repair-v1"))).toHaveLength(0);

      await application.decideReview({ ownerUserId, jobId: job.id }, { reviewId: review.reviewId, revision: review.revision, decision: "keep" });
      const requestsBeforeKeep = requests.length;
      await runGenerationJob(pool, `streamed-final-keep-commit-${randomUUID()}`, 30, credentialSecret);

      expect(requests).toHaveLength(requestsBeforeKeep);
      expect(await application.getJob({ ownerUserId, jobId: job.id })).toMatchObject({ status: "completed", operationKind: operation });
      const savedAfter = (await pool.query<{ orchestration_private: { generationReview: { gateCandidate: { storyHash: string } } } }>(
        "SELECT orchestration_private FROM generation_jobs WHERE id=$1", [job.id]
      )).rows[0]!.orchestration_private;
      expect(savedAfter.generationReview.gateCandidate.storyHash).toBe(savedBefore.generationReview.gateCandidate.storyHash);
      expect(primaryRequests).toHaveLength(1);
      expect(requests.filter((request) => request.includes("story-continuity-repair-v1"))).toHaveLength(0);
      await expect(pool.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM turns WHERE campaign_id=$1 AND accepted_at IS NOT NULL", [campaignId]
      )).resolves.toMatchObject({ rows: [{ count: acceptedBefore + (operation === "append" ? 1 : 0) }] });
      await expect(pool.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM turns WHERE id=(SELECT result_turn_id FROM generation_jobs WHERE id=$1)", [job.id]
      )).resolves.toMatchObject({ rows: [{ count: 1 }] });
      const accepted = await application.getResult({ ownerUserId, jobId: job.id });
      expect(accepted).toMatchObject({
        narration: savedBefore.generationReview.gateCandidate.story.narration,
        choices: savedBefore.generationReview.gateCandidate.story.choices,
        customActionSuggestion: savedBefore.generationReview.gateCandidate.story.custom_action_suggestion
      });
    } finally {
      reviewVerdict = "pass";
      await pool.query("UPDATE provider_profiles SET configuration=$2::jsonb WHERE id=$1", [providerId, JSON.stringify(legacyContinuityResponseFormatConfiguration)]);
    }
  }, 60_000);

  it("reclaims a streamed captured candidate and a persisted Keep decision without another text call", async () => {
    await pool.query("UPDATE provider_profiles SET configuration=$2::jsonb WHERE id=$1", [providerId, JSON.stringify(legacyStreamingContinuityResponseFormatConfiguration)]);
    const { job, application } = await enqueue("enforce");
    reviewVerdict = "conflict";
    requests.length = 0;
    try {
      const repository = createPostgresGenerationExecutionRepository(pool);
      const providers = workerProviderGraph(pool, credentialSecret);
      const collaborators = createGenerationExecutionCollaborators(pool, createApiIllustrationApplication(pool, providers.illustration), apiMemoryApplication(pool, credentialSecret), providers.generation);
      let interrupted = false;
      const wrapped = { ...repository, async saveOrchestration(scope: Parameters<typeof repository.saveOrchestration>[0], value: Parameters<typeof repository.saveOrchestration>[1]) {
        const updated = await repository.saveOrchestration(scope, value);
        if (!interrupted && value.primaryResult) {
          interrupted = true;
          await pool.query("UPDATE generation_jobs SET lease_expires_at=now()-interval '1 second' WHERE id=$1", [job.id]);
          throw Object.assign(new Error("Injected restart after streamed primary capture."), { code: "generation_cancelled" });
        }
        return updated;
      } };
      const workerId = `streamed-capture-${randomUUID()}`;
      const firstClaim = await repository.claimNext({ workerId, leaseSeconds: 30 });
      await createGenerationExecutor({ pool, repository: wrapped, collaborators }).execute({ claim: firstClaim!, workerId, leaseSeconds: 30 });
      expect(interrupted).toBe(true);
      const primaryRequests = requests.filter((request) => JSON.parse(request).stream === true);
      expect(primaryRequests).toHaveLength(1);
      const callsAfterCapture = requests.length;

      await runGenerationJob(pool, `streamed-capture-reclaim-${randomUUID()}`, 30, credentialSecret);
      expect(requests).toHaveLength(callsAfterCapture + 1);
      expect(requests.filter((request) => request.includes("story-continuity-review-v1"))).toHaveLength(1);
      expect(requests.filter((request) => JSON.parse(request).stream === true)).toHaveLength(1);
      const review = await application.getReview({ ownerUserId, jobId: job.id });
      expect(review).toMatchObject({ state: "pending", stage: "continuity", canKeep: true });
      await application.decideReview({ ownerUserId, jobId: job.id }, { reviewId: review.reviewId, revision: review.revision, decision: "keep" });
      const imageFailure = vi.fn(async () => { throw new Error("Injected accepted-illustration enqueue failure."); });
      collaborators.illustration.enqueueAcceptedTurnIllustrationSegments = imageFailure;
      const decisionWorkerId = `streamed-decision-restart-${randomUUID()}`;
      const decisionClaim = await repository.claimNext({ workerId: decisionWorkerId, leaseSeconds: 30 });
      await createGenerationExecutor({ pool, repository, collaborators }).execute({ claim: decisionClaim!, workerId: decisionWorkerId, leaseSeconds: 30 });

      expect(requests).toHaveLength(callsAfterCapture + 1);
      expect(imageFailure).toHaveBeenCalledTimes(1);
      expect(await application.getJob({ ownerUserId, jobId: job.id })).toMatchObject({ status: "completed" });
      expect(await application.getResult({ ownerUserId, jobId: job.id })).toMatchObject({ narration: review.narration });

      const foreignStory = JSON.parse(await readFile(resolve(repositoryRoot, "tests/fixtures/legacy-story.json"), "utf8"));
      foreignStory.world.title = `Foreign retrieval ${randomUUID()}`;
      const foreign = await importLegacyStory(pool, storyImportRequestSchema.parse({ sourceName: "foreign-retrieval.story", story: foreignStory }));
      const foreignTurn = (await pool.query<{ id: string }>(
        "INSERT INTO turns (owner_user_id,campaign_id,turn_number,narration,accepted_at) VALUES ($1,$2,3,$3,now()) RETURNING id",
        [ownerUserId, foreign.campaignId, "FOREIGN_ACCEPTED_FICTION_CANARY"]
      )).rows[0]!;
      const foreignVersion = (await pool.query<{ world_version_id: string }>("SELECT world_version_id FROM campaigns WHERE id=$1", [foreign.campaignId])).rows[0]!;
      await pool.query("UPDATE campaigns SET active_turn_number=3 WHERE id=$1", [foreign.campaignId]);
      await pool.query(
        "INSERT INTO chronicle_memories (owner_user_id,campaign_id,world_version_id,turn_id,memory_kind,ordinal,content,token_estimate) VALUES ($1,$2,$3,$4,'campaign_summary',3,$5,4)",
        [ownerUserId, foreign.campaignId, foreignVersion.world_version_id, foreignTurn.id, "FOREIGN_ACCEPTED_FICTION_CANARY"]
      );
      reviewVerdict = "pass";
      const next = await application.enqueueAppend({ ownerUserId, campaignId: (await pool.query<{ campaign_id: string }>("SELECT campaign_id FROM generation_jobs WHERE id=$1", [job.id])).rows[0]!.campaign_id }, generationRequestSchema.parse({
        action: "Continue from the observatory.", requestedInputMode: "action", resolvedInputMode: "action", inputModeSource: "explicit",
        providerProfileId: providerId, idempotencyKey: randomUUID(), context: { budgetTokens: 32_000, compression: "full", recentTurns: 8 }
      }));
      const beforeNextTurn = requests.length;
      await runGenerationJob(pool, `streamed-next-turn-${randomUUID()}`, 30, credentialSecret);
      const nextPrimary = requests.slice(beforeNextTurn).map((request) => JSON.parse(request) as { stream?: boolean; messages?: Array<{ content?: string }> })
        .find((request) => request.stream === true && !request.messages?.some((message) => message.content?.includes("story-continuity-review-v1")));
      expect(JSON.stringify(nextPrimary)).toContain(review.narration);
      await expect(pool.query("SELECT content FROM chronicle_memories WHERE campaign_id=(SELECT campaign_id FROM generation_jobs WHERE id=$1) AND content LIKE '%PRIVATE_REVIEW_CANARY%'", [job.id]))
        .resolves.toMatchObject({ rows: [] });
      for (const canary of ["PRIVATE_REVIEW_CANARY", "FOREIGN_ACCEPTED_FICTION_CANARY"]) {
        expect(JSON.stringify(nextPrimary)).not.toContain(canary);
      }
      expect(await application.getJob({ ownerUserId, jobId: next.id })).toMatchObject({ status: "completed" });
    } finally {
      reviewVerdict = "pass";
      await pool.query("UPDATE provider_profiles SET configuration=$2::jsonb WHERE id=$1", [providerId, JSON.stringify(legacyContinuityResponseFormatConfiguration)]);
    }
  }, 60_000);

  it("keeps the accepted streamed turn when promoted native illustration children roll back, then reconciles their frozen snapshot", async () => {
    // The primary turn uses the historical streaming path; only illustration
    // refinement in this scenario is admitted as a native preset operation.
    const streamingStoryProviderId = (await createProvider(pool, {
      name: `T17 concrete streaming story ${randomUUID()}`,
      providerType: "openai_compatible",
      providerRole: "text",
      baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
      defaultModel: "t17-capturing-fake",
      contextWindowTokens: 65_536,
      maxOutputTokens: 4_096,
      temperature: 0.2,
      enabled: true,
      configuration: legacyStreamingContinuityResponseFormatConfiguration
    }, credentialSecret)).id;
    const nativeTextProviderId = (await createProvider(pool, {
      name: `T17 native streaming illustration ${randomUUID()}`,
      providerType: "openrouter",
      providerRole: "text",
      baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
      defaultModel: "@preset/keep",
      textSelection: { kind: "openrouter_preset", slug: "keep" },
      contextWindowTokens: 65_536,
      maxOutputTokens: 4_096,
      temperature: 0.2,
      enabled: true,
      configuration: legacyStreamingContinuityResponseFormatConfiguration
    }, credentialSecret)).id;
    const imageProviderId = (await createProvider(pool, {
      name: `T17 illustration image ${randomUUID()}`,
      providerType: "openai_compatible",
      providerRole: "image",
      baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
      defaultModel: "t17-image",
      contextWindowTokens: 16_384,
      maxOutputTokens: 1_024,
      temperature: 0,
      enabled: true,
      configuration: {}
    }, credentialSecret)).id;
    primaryNarration = Array.from({ length: 15 }, () =>
      "Mira follows the lantern through the fogbound causeway while silver leaves turn slowly above the quiet observatory road."
    ).join(" ");
    const providers = workerProviderGraph(pool, credentialSecret);
    const resolvePreset = vi.fn(async () => ({
      slug: "keep", name: "Frozen Keep", versionId: "keep-v1", version: 1,
      configHash: "e".repeat(64), config: { model: "t17-native-frozen", temperature: 0.2 },
      systemPrompt: "PRIVATE_STREAMED_NATIVE_PROMPT"
    }));
    const discoverModels = vi.fn(async () => [
      { id: "t17-native-frozen", contextWindowTokens: 65_536, maxOutputTokens: 4_096 }
    ]);
    const nativeIllustration = {
      ...providers.illustration,
      illustrationTextPlans: {
        nativePresetPlansEnabled: true,
        ports: { resolvePreset, discoverModels },
        preparedExecutor: { execute: vi.fn() },
        loadAuthority: async ({ ownerUserId: authorityOwnerId, providerProfileId }: { ownerUserId: string; providerProfileId: string }) => {
          const current = await providers.illustration.execution.text({ ownerUserId: authorityOwnerId }, providerProfileId, "text");
          return { id: current.id, providerRole: current.providerRole, authorityRevision: current.authorityRevision!, endpointIdentity: current.endpointIdentity! };
        }
      }
    } as never;
    const { job, application, campaignId } = await enqueue(
      "off",
      false,
      async (configuredCampaignId) => {
        await pool.query("UPDATE campaigns SET text_provider_profile_id=$2 WHERE id=$1", [configuredCampaignId, nativeTextProviderId]);
        await setIllustrationConfig(pool, configuredCampaignId, illustrationConfigSchema.parse({
          sourcePolicy: "library_only", providerProfileId: imageProviderId, model: "t17-image",
          segmentPromptMode: "ai_refined", segmentWordCount: 100, imagesPerSegment: 1
        }));
      },
      "Stream a native illustrated turn.",
      false,
      streamingStoryProviderId
    );
    const illustration = createApiIllustrationApplication(pool, nativeIllustration);
    const baseCollaborators = createGenerationExecutionCollaborators(
      pool, illustration, apiMemoryApplication(pool, credentialSecret), providers.generation
    );
    let frozenSnapshot: unknown;
    const prepareIllustration = vi.fn(async ({ ownerUserId: preparationOwnerId, campaignId: preparationCampaignId, operationPrompt }: {
      ownerUserId: string; campaignId: string; operationPrompt: string;
    }) => {
      const prepared = await prepareIllustrationTextExecution(
        preparationOwnerId,
        preparationCampaignId,
        await loadConfig(pool, preparationOwnerId, preparationCampaignId),
        operationPrompt,
        nativeIllustration,
      );
      expect(prepared).toMatchObject({ version: 3, state: "prepared", plan: { prompt: expect.stringContaining("PRIVATE_STREAMED_NATIVE_PROMPT") } });
      frozenSnapshot = prepared;
      return prepared;
    });
    const promote = baseCollaborators.illustration.promoteProvisionalSet;
    const promotedChildWrites = vi.fn(async (...args: Parameters<typeof promote>) => {
      await promote(...args);
      const [database, scope] = args;
      const childWrite = await (database as DatabaseClient).query(
        "UPDATE turn_illustration_segments SET resolved_prompt=$2 WHERE generation_job_id=$1",
        [scope.generationJobId, "SAVEDPOINT_ROLLBACK_CHILD_CANARY"]
      );
      expect(childWrite.rowCount).toBeGreaterThan(0);
      throw new Error("Injected promoted illustration child failure after write.");
    });
    const collaborators = {
      ...baseCollaborators,
      prepareIllustrationTextExecution: prepareIllustration,
      illustration: { ...baseCollaborators.illustration, promoteProvisionalSet: promotedChildWrites }
    };

    const repository = createPostgresGenerationExecutionRepository(pool);
    const workerId = `native-streamed-savepoint-${randomUUID()}`;
    const claim = await repository.claimNext({ workerId, leaseSeconds: 30 });
    expect(claim?.jobId).toBe(job.id);
    await expect(createGenerationExecutor({ pool, repository, collaborators })
      .execute({ claim: claim!, workerId, leaseSeconds: 30 })).resolves.toBe(true);

    expect(prepareIllustration).toHaveBeenCalledTimes(1);
    expect(resolvePreset).toHaveBeenCalledTimes(1);
    expect(discoverModels).toHaveBeenCalledTimes(1);
    expect(promotedChildWrites).toHaveBeenCalledTimes(1);
    expect(await application.getJob({ ownerUserId, jobId: job.id })).toMatchObject({ status: "completed" });
    const accepted = await application.getResult({ ownerUserId, jobId: job.id });
    expect(accepted.narration.replace(/\s+/g, " ").trim()).toBe(primaryNarration.replace(/\s+/g, " ").trim());
    const resultTurnId = (await pool.query<{ result_turn_id: string }>(
      "SELECT result_turn_id FROM generation_jobs WHERE id=$1", [job.id]
    )).rows[0]!.result_turn_id;
    expect(resultTurnId).toEqual(expect.any(String));
    await expect(pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM chronicle_memories WHERE turn_id=$1 AND memory_kind='turn_fiction'", [resultTurnId]
    )).resolves.toMatchObject({ rows: [{ count: 1 }] });
    const savedState = (await pool.query<{ streaming_segments_state: Record<string, unknown> }>(
      "SELECT streaming_segments_state FROM generation_jobs WHERE id=$1", [job.id]
    )).rows[0]!.streaming_segments_state;
    expect(savedState).toMatchObject({
      provisionalIllustrationReconciliation: "pending",
      illustrationTextExecutionSnapshot: frozenSnapshot
    });
    await expect(pool.query<{ turn_id: string | null; status: string }>(
      "SELECT turn_id,status FROM turn_illustration_sets WHERE generation_job_id=$1", [job.id]
    )).resolves.toMatchObject({ rows: [{ turn_id: null, status: "provisional" }] });
    await expect(pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM turn_illustration_segments WHERE generation_job_id=$1 AND resolved_prompt='SAVEDPOINT_ROLLBACK_CHILD_CANARY'", [job.id]
    )).resolves.toMatchObject({ rows: [{ count: 0 }] });

    expect(await reconcileNextAcceptedStreamingIllustration(pool, illustration.generation)).toBe(true);
    const reconciled = await pool.query<{ turn_id: string; text_execution_snapshot: unknown }>(
      `SELECT segments.turn_id,prompt_jobs.text_execution_snapshot
         FROM turn_illustration_segments segments
         JOIN illustration_prompt_jobs prompt_jobs ON prompt_jobs.segment_id=segments.id
        WHERE segments.generation_job_id=$1
        ORDER BY segments.ordinal`,
      [job.id]
    );
    expect(reconciled.rows.length).toBeGreaterThan(1);
    expect(reconciled.rows.map((row) => row.turn_id)).toEqual(
      Array.from({ length: reconciled.rows.length }, () => resultTurnId)
    );
    expect(reconciled.rows.map((row) => row.text_execution_snapshot)).toEqual(
      Array.from({ length: reconciled.rows.length }, () => frozenSnapshot)
    );
  }, 60_000);

  it("re-runs an uncertain continuity reviewer before requiring a new conflict decision", async () => {
    const { job, application } = await enqueue("enforce");
    reviewVerdict = "pass"; reviewSequence = ["uncertain", "conflict"]; requests.length = 0;
    try {
      await runGenerationJob(pool, `continuity-uncertain-initial-${randomUUID()}`, 30, credentialSecret);
      const uncertain = await application.getReview({ ownerUserId, jobId: job.id });
      expect(uncertain).toMatchObject({ stage: "continuity", state: "pending", reasons: ["review_uncertain"] });

      await application.decideReview({ ownerUserId, jobId: job.id }, { reviewId: uncertain.reviewId, revision: uncertain.revision, decision: "retry" });
      await runGenerationJob(pool, `continuity-uncertain-rerun-${randomUUID()}`, 30, credentialSecret);

      const conflict = await application.getReview({ ownerUserId, jobId: job.id });
      expect(await application.getJob({ ownerUserId, jobId: job.id })).toMatchObject({ status: "recoverable", errorCode: "generation_review_required" });
      expect(conflict).toMatchObject({ stage: "continuity", state: "pending", reasons: ["narrative_conflict"], canKeep: true, canRetry: true });
      expect(requests.filter((body) => body.includes("story-continuity-review-v1"))).toHaveLength(2);
      expect(requests.filter((body) => body.includes("story-continuity-repair-v1"))).toHaveLength(0);
    } finally { reviewSequence = []; }
  });

  it("re-offers the original final candidate after a failed authorized continuity retry and keeps it offline", async () => {
    await pool.query("UPDATE provider_profiles SET configuration=$2::jsonb WHERE id=$1", [providerId, JSON.stringify({ streaming: true, textResponseFormatPolicy: "auto" })]);
    const { job, application, campaignId } = await enqueue("enforce");
    reviewVerdict = "pass"; reviewSequence = ["conflict"]; requests.length = 0;
    try {
      await runGenerationJob(pool, `continuity-reoffer-initial-${randomUUID()}`, 30, credentialSecret);
      const initialReview = await application.getReview({ ownerUserId, jobId: job.id });
      const savedBeforeRetry = (await pool.query<{ orchestration_private: { generationReview: { gateCandidate: { storyHash: string } } } }>(
        "SELECT orchestration_private FROM generation_jobs WHERE id=$1", [job.id]
      )).rows[0]!.orchestration_private;
      const acceptedBefore = (await pool.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM turns WHERE campaign_id=$1 AND accepted_at IS NOT NULL", [campaignId]
      )).rows[0]!.count;

      await application.decideReview({ ownerUserId, jobId: job.id }, {
        reviewId: initialReview.reviewId, revision: initialReview.revision, decision: "retry"
      });
      invalidSemanticRepair = true;
      await runGenerationJob(pool, `continuity-reoffer-retry-${randomUUID()}`, 30, credentialSecret);

      const reoffered = await application.getReview({ ownerUserId, jobId: job.id });
      expect(reoffered).toMatchObject({ state: "pending", stage: "continuity", canKeep: true, canRetry: false, retryFailure: expect.any(String) });
      const savedAfterFailure = (await pool.query<{ orchestration_private: { generationReview: { gateCandidate: { storyHash: string }; decisionJournal: unknown[] } } }>(
        "SELECT orchestration_private FROM generation_jobs WHERE id=$1", [job.id]
      )).rows[0]!.orchestration_private;
      expect(savedAfterFailure.generationReview.gateCandidate.storyHash).toBe(savedBeforeRetry.generationReview.gateCandidate.storyHash);
      expect(savedAfterFailure.generationReview.decisionJournal).toHaveLength(1);
      expect(requests.filter((body) => body.includes("story-continuity-repair-v1"))).toHaveLength(1);
      expect((await pool.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM turns WHERE campaign_id=$1 AND accepted_at IS NOT NULL", [campaignId]
      )).rows[0]!.count).toBe(acceptedBefore);

      const basisWithoutHash = {
        version: 2 as const,
        selection: { kind: "openrouter_preset" as const, slug: "keep" },
        preset: { slug: "keep", versionId: "keep-v1", configHash: "c".repeat(64) },
        candidates: [{ modelId: "keep-model", providerPolicy: {}, contextWindowTokens: 32768, maxOutputTokens: 4096 }],
        presetSystemPrompt: "Keep frozen prompt.",
        parameters: { temperature: 0.2 },
        endpointReference: "frozen-provider-endpoint",
        credentialReference: providerId,
        profileRevision: "b".repeat(64),
        authorityRevision: "a".repeat(64),
        requestTimeoutMs: 23456,
        protocolVersion: "text-execution-route-basis-v2"
      };
      const routeBasis = { ...basisWithoutHash, routeBasisHash: sha256(stableStringify(basisWithoutHash)) };
      await pool.query(
        "UPDATE generation_jobs SET orchestration_private=orchestration_private || jsonb_build_object('textExecutionRouteBasis',$2::jsonb) WHERE id=$1",
        [job.id, JSON.stringify(routeBasis)]
      );

      await application.decideReview({ ownerUserId, jobId: job.id }, {
        reviewId: reoffered.reviewId, revision: reoffered.revision, decision: "keep"
      });
      const repository = createPostgresGenerationExecutionRepository(pool);
      const providers = workerProviderGraph(pool, credentialSecret);
      const loadTextExecution = vi.fn(async () => { throw new Error("text provider must remain offline for re-offered final Keep"); });
      const verifyTextExecutionRouteAuthority = vi.fn(async () => { throw new Error("native route authority must remain offline for re-offered final Keep"); });
      const collaborators = {
        ...createGenerationExecutionCollaborators(pool, createApiIllustrationApplication(pool, providers.illustration), apiMemoryApplication(pool, credentialSecret), providers.generation),
        loadTextExecution,
        verifyTextExecutionRouteAuthority
      };
      const workerId = `continuity-reoffer-keep-${randomUUID()}`;
      const claim = await repository.claimNext({ workerId, leaseSeconds: 30 });
      await expect(createGenerationExecutor({ pool, repository, collaborators }).execute({ claim: claim!, workerId, leaseSeconds: 30 })).resolves.toBe(true);
      expect(loadTextExecution).not.toHaveBeenCalled();
      expect(verifyTextExecutionRouteAuthority).not.toHaveBeenCalled();
      expect(requests.filter((body) => body.includes("story-continuity-repair-v1"))).toHaveLength(1);
      expect((await pool.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM turns WHERE campaign_id=$1 AND accepted_at IS NOT NULL", [campaignId]
      )).rows[0]!.count).toBe(acceptedBefore + 1);
      expect(requests.filter((request) => JSON.parse(request).stream === true)).toHaveLength(1);
    } finally {
      invalidSemanticRepair = false;
      reviewSequence = [];
      await pool.query("UPDATE provider_profiles SET configuration=$2::jsonb WHERE id=$1", [providerId, JSON.stringify(legacyContinuityResponseFormatConfiguration)]);
    }
  });

  it.each(["complete", "deadline", "unbound"])("keeps a queue-produced native preset candidate without a second prepared execution (outcome=%s)", async (outcome) => {
    const deadline = outcome !== "complete";
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("T17 fake provider did not bind.");
    const nativeProvider = await createProvider(pool, {
      name: `T17 native Keep ${randomUUID()}`,
      providerType: "openrouter",
      providerRole: "text",
      baseUrl: `http://127.0.0.1:${address.port}`,
      defaultModel: "@preset/keep",
      contextWindowTokens: 163_840,
      maxOutputTokens: 48_000,
      temperature: 0,
      enabled: true,
      configuration: { textResponseFormatPolicy: "auto" },
      apiKey: "native-keep-fixture"
    }, credentialSecret);
    const story = JSON.parse(await readFile(resolve(repositoryRoot, "tests/fixtures/legacy-story.json"), "utf8"));
    story.world.title = `Native Keep ${randomUUID()}`;
    const imported = await importLegacyStory(pool, storyImportRequestSchema.parse({ sourceName: "native-keep.story", story }));
    await saveStoryMemoryEnrollment(pool, { ownerUserId, campaignId: imported.campaignId }, { capability: "r3", reviewMode: "enforce" }, { installedCapability: "r3", enforceEnabled: true });
    const application = composeGeneration(pool, apiProviderGraph(pool, credentialSecret).generation, undefined, { installedCapability: "r3", enforceEnabled: true }, true);
    const job = await application.enqueueAppend({ ownerUserId, campaignId: imported.campaignId }, generationRequestSchema.parse({
      action: "Wait for the observatory keeper.",
      requestedInputMode: "action",
      resolvedInputMode: "action",
      inputModeSource: "explicit",
      providerProfileId: nativeProvider.id,
      textSelection: { kind: "openrouter_preset", slug: "keep" },
      idempotencyKey: randomUUID(),
      context: { budgetTokens: 32000, compression: "full", recentTurns: 8 }
    }));
    await expect(pool.query<{ basis: { preset: { slug: string }; parameters: { temperature: number }; candidates: Array<{ modelId: string }> } }>(
      "SELECT orchestration_private->'textExecutionRouteBasis' AS basis FROM generation_jobs WHERE id=$1", [job.id]
    )).resolves.toMatchObject({ rows: [{ basis: { preset: { slug: "keep" }, parameters: { temperature: 0.2 }, candidates: [{ modelId: "@preset/keep" }] } }] });

    reviewVerdict = deadline ? "pass" : "conflict";
    const repository = createPostgresGenerationExecutionRepository(pool);
    const providers = workerProviderGraph(pool, credentialSecret);
    const preparedTextExecutor = vi.fn(async ({ plan, operation, request, preparedRequest }: { plan: { prompt: string; candidates: Array<{ modelId: string }> }; operation: string; request: { input: string; systemPrompt: string }; preparedRequest?: { body: string; payloadHash: string } }) => {
      if (deadline && operation === "story_generation") {
        if (outcome === "unbound") throw new PreparedRouteTerminalError("prepared_route_deadline_exceeded", "deadline", "Missing wire evidence.");
        const content = reply("Mira waits at the observatory.");
        const invalid = JSON.parse(content);
        delete invalid.custom_action_suggestion;
        throw new PreparedResponseContractError(new PreparedRouteTerminalError("prepared_route_deadline_exceeded", "deadline", "Fixture deadline."), preparedRequest!, {
          partialContent: JSON.stringify(invalid) + "\n" + content + "\n" + content.slice(0, 50),
          responseId: "interrupted-native", returnedModel: plan.candidates[0]!.modelId
        });
      }
      return {
      content: reviewResponse(JSON.stringify({ messages: [{ content: plan.prompt }, { content: request.input }] })),
      responseId: randomUUID(), finishReason: "stop", outputLimited: false, modelInstanceId: plan.candidates[0]!.modelId,
      usage: { inputTokens: 80, outputTokens: 30, totalTokens: 110 }, reportedCost: null, rawMetadata: {},
      ...(preparedRequest ? { preparedRequest } : {})
    }; });
    const composedCollaborators = createGenerationExecutionCollaborators(
      pool,
      createApiIllustrationApplication(pool, providers.illustration),
      apiMemoryApplication(pool, credentialSecret),
      providers.generation
    );
    const nativeAuthorityVerifier = composedCollaborators.verifyTextExecutionRouteAuthority;
    if (!nativeAuthorityVerifier) throw new Error("Native route authority verification is unavailable.");
    const verifyTextExecutionRouteAuthority = vi.fn(async (...input: Parameters<typeof nativeAuthorityVerifier>) => nativeAuthorityVerifier(...input));
    const collaborators = {
      ...composedCollaborators,
      loadTextExecution: vi.fn(async () => { throw new Error("native route must use the prepared executor"); }),
      verifyTextExecutionRouteAuthority,
      preparedTextExecutor: { execute: preparedTextExecutor }
    };
    const initialWorker = `native-keep-initial-${randomUUID()}`;
    const initialClaim = await repository.claimNext({ workerId: initialWorker, leaseSeconds: 30 });
    expect(initialClaim?.jobId).toBe(job.id);
    await expect(createGenerationExecutor({ pool, repository, collaborators }).execute({ claim: initialClaim!, workerId: initialWorker, leaseSeconds: 30 })).resolves.toBe(true);
    if (deadline) {
      expect(await application.getJob({ ownerUserId, jobId: job.id })).toMatchObject({
        failureDiagnostic: { code: "provider_request_timeout", message: "The provider request timed out." }
      });
    }
    if (outcome === "unbound") {
      expect(await application.getJob({ ownerUserId, jobId: job.id })).toMatchObject({ status: "failed", resultTurnId: null });
      expect(preparedTextExecutor).toHaveBeenCalledTimes(1);
      return;
    }
    const review = await application.getReview({ ownerUserId, jobId: job.id });
    expect(review).toMatchObject({ state: "pending", stage: "continuity", canKeep: true });
    expect(preparedTextExecutor.mock.calls.map(([input]) => input.operation)).toEqual(["story_generation", "story_continuity_review"]);
    for (const [input] of preparedTextExecutor.mock.calls) {
      expect(input.request.systemPrompt).toBe(input.plan.prompt);
      expect(input.plan.prompt).toContain("Native frozen preset instruction.");
      expect(input.preparedRequest?.body).toBeDefined();
    }
    const durableNativeRequests = (await pool.query<{
      orchestrationPrivate: { primaryReservation: { requestBody: string }; primaryResult: { contextDiagnostics: { requestTokens: number } }; responseContractInvocations: Array<{ requestPayloadHash: string }> };
    }>("SELECT orchestration_private AS \"orchestrationPrivate\" FROM generation_jobs WHERE id=$1", [job.id])).rows[0]!.orchestrationPrivate;
    const preparedBodies = preparedTextExecutor.mock.calls.map(([input]) => input.preparedRequest!.body);
    expect(preparedBodies.map((body) => JSON.parse(body).max_tokens)).toEqual([48_000, 48_000]);
    expect(preparedBodies[0]).toBe(durableNativeRequests.primaryReservation.requestBody);
    expect(durableNativeRequests.primaryResult.contextDiagnostics.requestTokens).toBe(estimateStoryTokens(preparedBodies[0]!));
    expect(preparedBodies.map(sha256Hex)).toEqual(durableNativeRequests.responseContractInvocations.map((entry) => entry.requestPayloadHash));
    expect(verifyTextExecutionRouteAuthority).toHaveBeenCalled();
    const candidate = (await pool.query<{ candidate: { storyHash: string; story: { narration: string } } }>(
      "SELECT orchestration_private->'generationReview'->'gateCandidate' AS candidate FROM generation_jobs WHERE id=$1", [job.id]
    )).rows[0]!.candidate;
    expect(sha256Hex(canonicalEvidenceJson(candidate.story))).toBe(candidate.storyHash);

    await application.decideReview({ ownerUserId, jobId: job.id }, { reviewId: review.reviewId, revision: review.revision, decision: "keep" });
    const offlinePreparedExecutor = vi.fn(async () => { throw new Error("Keep must not execute a prepared native route"); });
    const offlineAuthority = vi.fn(async () => { throw new Error("Keep must not read native route authority"); });
    const offlineLoadTextExecution = vi.fn(async () => { throw new Error("Keep must not load text execution"); });
    const offlineCollaborators = { ...collaborators,
      preparedTextExecutor: { execute: offlinePreparedExecutor },
      verifyTextExecutionRouteAuthority: offlineAuthority,
      loadTextExecution: offlineLoadTextExecution
    };
    const keepWorker = `native-keep-final-${randomUUID()}`;
    const keepClaim = await repository.claimNext({ workerId: keepWorker, leaseSeconds: 30 });
    expect(keepClaim?.jobId).toBe(job.id);
    await expect(createGenerationExecutor({ pool, repository, collaborators: offlineCollaborators }).execute({ claim: keepClaim!, workerId: keepWorker, leaseSeconds: 30 })).resolves.toBe(true);
    expect(offlinePreparedExecutor).not.toHaveBeenCalled();
    expect(offlineAuthority).not.toHaveBeenCalled();
    expect(offlineLoadTextExecution).not.toHaveBeenCalled();
    await expect(application.getJob({ ownerUserId, jobId: job.id })).resolves.toMatchObject({ status: "completed" });
    await expect(pool.query<{ narration: string; candidateHash: string }>(
      "SELECT narration,model_metadata->'reviewAcceptance'->>'candidateHash' AS \"candidateHash\" FROM turns WHERE campaign_id=$1 AND turn_number=$2",
      [imported.campaignId, job.expectedTurnNumber]
    )).resolves.toMatchObject({ rows: [{ narration: candidate.story.narration, candidateHash: candidate.storyHash }] });
  });

  it("keeps an uncovered scene main exactly, then pauses again for a later final continuity conflict", async () => {
    const { job, application, campaignId } = await enqueue("enforce", true, undefined, "Wait at the observatory.", false);
    reviewVerdict = "conflict"; sceneCoverageSequence = [false]; requests.length = 0;
    try {
      await runGenerationJob(pool, `scene-review-initial-${randomUUID()}`, 30, credentialSecret);
      expect(await application.getJob({ ownerUserId, jobId: job.id })).toMatchObject({ status: "recoverable", errorCode: "generation_review_required" });
      expect(requests).toHaveLength(2);
      expect(requests.filter((body) => body.includes("Rewrite the complete story JSON so the narration visibly dramatizes every required scene beat"))).toHaveLength(0);
      const firstReview = await application.getReview({ ownerUserId, jobId: job.id });
      expect(firstReview).toMatchObject({ stage: "scene_coverage", state: "pending", canKeep: true });
      const before = await pool.query<{ count: number }>("SELECT count(*)::int AS count FROM turns WHERE campaign_id=$1 AND accepted_at IS NOT NULL", [campaignId]);
      const mainNarration = firstReview.narration;

      await application.decideReview({ ownerUserId, jobId: job.id }, { reviewId: firstReview.reviewId, revision: firstReview.revision, decision: "keep" });
      await runGenerationJob(pool, `scene-review-keep-${randomUUID()}`, 30, credentialSecret);

      expect(requests).toHaveLength(3);
      expect(requests[2]).toContain("story-continuity-review-v1");
      expect(requests.filter((body) => body.includes("Rewrite the complete story JSON so the narration visibly dramatizes every required scene beat"))).toHaveLength(0);
      const laterReview = await application.getReview({ ownerUserId, jobId: job.id });
      expect(laterReview).toMatchObject({ stage: "continuity", state: "pending", narration: mainNarration });
      await expect(pool.query<{ count: number }>("SELECT count(*)::int AS count FROM turns WHERE campaign_id=$1 AND accepted_at IS NOT NULL", [campaignId]))
        .resolves.toMatchObject({ rows: [{ count: before.rows[0]!.count }] });
    } finally { sceneCoverageSequence = []; reviewVerdict = "pass"; }
  });

  it("re-offers the original scene candidate when its authorized rewrite fails", async () => {
    const { job, application } = await enqueue("enforce", true, undefined, "Wait at the observatory.", false);
    reviewVerdict = "pass"; sceneCoverageSequence = [false, false, false]; requests.length = 0;
    try {
      await runGenerationJob(pool, `scene-reoffer-initial-${randomUUID()}`, 30, credentialSecret);
      const first = await application.getReview({ ownerUserId, jobId: job.id });
      expect(first).toMatchObject({ stage: "scene_coverage", state: "pending", canKeep: true, canRetry: true });

      await application.decideReview({ ownerUserId, jobId: job.id }, { reviewId: first.reviewId, revision: first.revision, decision: "retry" });
      await runGenerationJob(pool, `scene-reoffer-retry-${randomUUID()}`, 30, credentialSecret);

      const reoffered = await application.getReview({ ownerUserId, jobId: job.id });
      expect(await application.getJob({ ownerUserId, jobId: job.id })).toMatchObject({ status: "recoverable", errorCode: "generation_review_required" });
      expect(reoffered).toMatchObject({ stage: "scene_coverage", state: "pending", canKeep: true, canRetry: false, narration: first.narration });
      expect(reoffered.revision).toBeGreaterThan(first.revision);
      expect(requests.filter((body) => body.includes("Rewrite the complete story JSON so the narration visibly dramatizes every required scene beat"))).toHaveLength(1);
    } finally { sceneCoverageSequence = []; }
  });

  it("reclaims a dispatched scene rewrite without another transport call and re-offers the original", async () => {
    const { job, application } = await enqueue("enforce", true, undefined, "Wait at the observatory.", false);
    reviewVerdict = "pass"; sceneCoverageSequence = [false, false]; requests.length = 0;
    try {
      await runGenerationJob(pool, `scene-dispatch-gate-${randomUUID()}`, 30, credentialSecret);
      const gate = await application.getReview({ ownerUserId, jobId: job.id });
      await application.decideReview({ ownerUserId, jobId: job.id }, { reviewId: gate.reviewId, revision: gate.revision, decision: "retry" });

      const repository = createPostgresGenerationExecutionRepository(pool);
      const providers = workerProviderGraph(pool, credentialSecret);
      const collaborators = createGenerationExecutionCollaborators(pool, createApiIllustrationApplication(pool, providers.illustration), apiMemoryApplication(pool, credentialSecret), providers.generation);
      let interrupted = false;
      const wrapped = { ...repository, async saveOrchestration(scope: Parameters<typeof repository.saveOrchestration>[0], value: Parameters<typeof repository.saveOrchestration>[1]) {
        const sceneRepair = (value as { sceneCoverageRepair?: { status?: string } }).sceneCoverageRepair;
        if (!interrupted && sceneRepair?.status === "validated") {
          interrupted = true;
          await pool.query("UPDATE generation_jobs SET lease_expires_at=now()-interval '1 second' WHERE id=$1", [job.id]);
          throw Object.assign(new Error("Injected worker termination after scene rewrite transport."), { code: "generation_cancelled" });
        }
        return repository.saveOrchestration(scope, value);
      } };
      const workerId = `scene-dispatch-crash-${randomUUID()}`;
      const claim = await repository.claimNext({ workerId, leaseSeconds: 30 });
      await createGenerationExecutor({ pool, repository: wrapped, collaborators }).execute({ claim: claim!, workerId, leaseSeconds: 30 });

      expect(interrupted).toBe(true);
      expect(requests.filter((body) => body.includes("Rewrite the complete story JSON so the narration visibly dramatizes every required scene beat"))).toHaveLength(1);
      await runGenerationJob(pool, `scene-dispatch-reclaim-${randomUUID()}`, 30, credentialSecret);
      const reoffered = await application.getReview({ ownerUserId, jobId: job.id });
      expect(reoffered).toMatchObject({ state: "pending", stage: "scene_coverage", canKeep: true, canRetry: false, narration: gate.narration });
      expect(requests.filter((body) => body.includes("Rewrite the complete story JSON so the narration visibly dramatizes every required scene beat"))).toHaveLength(1);
    } finally { sceneCoverageSequence = []; }
  });

  it("records the actual response-format fallback body for a validated scene rewrite", async () => {
    const { job, application } = await enqueue("enforce", true, undefined, "Wait at the observatory.", false);
    reviewVerdict = "pass"; sceneCoverageSequence = [false, false, true]; requests.length = 0;
    rejectSceneRewriteResponseFormat = true;
    try {
      await runGenerationJob(pool, `scene-fallback-gate-${randomUUID()}`, 30, credentialSecret);
      const gate = await application.getReview({ ownerUserId, jobId: job.id });
      await application.decideReview({ ownerUserId, jobId: job.id }, { reviewId: gate.reviewId, revision: gate.revision, decision: "retry" });
      await runGenerationJob(pool, `scene-fallback-retry-${randomUUID()}`, 30, credentialSecret);

      const rewriteBodies = requests.filter((body) => body.includes("Rewrite the complete story JSON so the narration visibly dramatizes every required scene beat"));
      expect(rewriteBodies).toHaveLength(2);
      expect(rewriteBodies[0]).toContain("\"response_format\"");
      expect(rewriteBodies[1]).not.toContain("\"response_format\"");
      const saved = (await pool.query<{ orchestration_private: { sceneCoverageRepair: { status: string; repairRequestBody: string; repairRequestPayloadHash: string } } }>(
        "SELECT orchestration_private FROM generation_jobs WHERE id=$1", [job.id]
      )).rows[0]!.orchestration_private;
      expect(saved.sceneCoverageRepair).toMatchObject({
        status: "validated",
        repairRequestBody: rewriteBodies[1],
        repairRequestPayloadHash: createHash("sha256").update(rewriteBodies[1]!).digest("hex")
      });
    } finally {
      sceneCoverageSequence = [];
      rejectSceneRewriteResponseFormat = false;
    }
  });

  it("reserves one semantic repair, replaces the main, and reviews the repaired request before commit", async () => {
    const { job, application } = await enqueue("enforce");
    reviewVerdict = "pass"; reviewSequence = ["conflict", "pass"]; requests.length = 0;
    await runGenerationJob(pool, `semantic-main-${randomUUID()}`, 30, credentialSecret);
    const gate = await application.getReview({ ownerUserId, jobId: job.id });
    expect(gate).toMatchObject({ state: "pending", stage: "continuity" });
    expect(requests.filter((body) => body.includes("story-continuity-repair-v1"))).toHaveLength(0);
    await application.decideReview({ ownerUserId, jobId: job.id }, { reviewId: gate.reviewId, revision: gate.revision, decision: "retry" });
    await runGenerationJob(pool, `semantic-main-retry-${randomUUID()}`, 30, credentialSecret);
    const completed = await application.getJob({ ownerUserId, jobId: job.id });
    expect(completed).toMatchObject({ status: "completed" });
    expect(requests).toHaveLength(4);
    const saved = (await pool.query("SELECT orchestration_private FROM generation_jobs WHERE id=$1", [job.id])).rows[0].orchestration_private;
    expect(saved.semanticRepair).toMatchObject({ status: "validated", scope: "main" });
    expect(saved.logicalAttempt).toMatchObject({ semanticRepairsConsumed: 1, reviewsConsumed: 2 });
    expect(saved.validatedMainDraft.requestPayloadHash).toBe(createHash("sha256").update(requests[2]!).digest("hex"));
    expect(saved.continuityReview.binding.producingRequestHash).toBe(createHash("sha256").update(requests[2]!).digest("hex"));
    expect(requests[2]).toContain("story-continuity-repair-v1");
    expect(requests[2]).not.toContain("private fixture");
  });

  it("does not dispatch continuity repair from a receipt for a different stage", async () => {
    const { job, application } = await enqueue("enforce");
    reviewVerdict = "pass"; reviewSequence = ["conflict"]; requests.length = 0;
    try {
      await runGenerationJob(pool, `continuity-stage-initial-${randomUUID()}`, 30, credentialSecret);
      const gate = await application.getReview({ ownerUserId, jobId: job.id });
      await application.decideReview({ ownerUserId, jobId: job.id }, { reviewId: gate.reviewId, revision: gate.revision, decision: "retry" });
      const saved = (await pool.query<{ orchestration_private: Record<string, unknown> }>("SELECT orchestration_private FROM generation_jobs WHERE id=$1", [job.id])).rows[0]!.orchestration_private;
      const review = saved.generationReview as { decisionJournal: Array<Record<string, unknown>> };
      review.decisionJournal.at(-1)!.nextStage = "scene_coverage";
      await pool.query("UPDATE generation_jobs SET orchestration_private=$2::jsonb WHERE id=$1", [job.id, JSON.stringify(saved)]);

      await runGenerationJob(pool, `continuity-stage-reclaim-${randomUUID()}`, 30, credentialSecret);
      expect(requests.filter((body) => body.includes("story-continuity-repair-v1"))).toHaveLength(0);
      expect(await application.getJob({ ownerUserId, jobId: job.id })).toMatchObject({ status: "recoverable", errorCode: "generation_review_required" });
    } finally { reviewSequence = []; }
  });

  it("does not spend a second semantic repair when the post-repair review still conflicts", async () => {
    const { job, application } = await enqueue("enforce");
    reviewVerdict = "pass"; reviewSequence = ["conflict", "conflict"]; requests.length = 0;
    await runGenerationJob(pool, `semantic-exhausted-${randomUUID()}`, 30, credentialSecret);
    const gate = await application.getReview({ ownerUserId, jobId: job.id });
    await application.decideReview({ ownerUserId, jobId: job.id }, { reviewId: gate.reviewId, revision: gate.revision, decision: "retry" });
    await runGenerationJob(pool, `semantic-exhausted-retry-${randomUUID()}`, 30, credentialSecret);
    expect(await application.getJob({ ownerUserId, jobId: job.id })).toMatchObject({ status: "recoverable", errorCode: "continuity_review_conflict" });
    expect(requests).toHaveLength(4);
    const saved = (await pool.query("SELECT orchestration_private FROM generation_jobs WHERE id=$1", [job.id])).rows[0].orchestration_private;
    expect(saved.logicalAttempt).toMatchObject({ semanticRepairsConsumed: 1, reviewsConsumed: 2 });
  });

  it("repairs only an appended event extension and preserves the validated main prefix", async () => {
    const { job, application, campaignId } = await enqueue("enforce");
    const triggerId = randomUUID();
    await pool.query("UPDATE campaign_state SET event_triggers=$2::jsonb WHERE campaign_id=$1", [campaignId, JSON.stringify([{ id: triggerId, label: "Keeper arrival", timing: "after", condition: "Mira waits.", effect: "The bell rings as the keeper arrives.", addTextAfter: true, triggeredCount: 0, lastTriggeredTurn: null, lastTriggeredAt: null }])]);
    reviewVerdict = "pass"; reviewSequence = ["conflict", "pass"]; extensionConflict = true; requests.length = 0;
    try {
      await runGenerationJob(pool, `semantic-extension-${randomUUID()}`, 30, credentialSecret);
      const gate = await application.getReview({ ownerUserId, jobId: job.id });
      expect(gate).toMatchObject({ state: "pending", stage: "continuity" });
      await application.decideReview({ ownerUserId, jobId: job.id }, { reviewId: gate.reviewId, revision: gate.revision, decision: "retry" });
      await runGenerationJob(pool, `semantic-extension-retry-${randomUUID()}`, 30, credentialSecret);
      const completed = await application.getJob({ ownerUserId, jobId: job.id });
      expect(completed, JSON.stringify(completed)).toMatchObject({ status: "completed" });
      const saved = (await pool.query("SELECT orchestration_private FROM generation_jobs WHERE id=$1", [job.id])).rows[0].orchestration_private;
      expect(saved.semanticRepair).toMatchObject({ status: "validated", scope: "extension_only" });
      expect(saved.extension.story.narration).toContain("The bell rings");
      expect(saved.extension.story.narration.startsWith(saved.validatedMainDraft.story.narration)).toBe(true);
      expect(requests.filter((body) => body.includes("story-continuity-repair-v1"))).toHaveLength(1);
    } finally { extensionConflict = false; }
  });

  it("re-evaluates after events and builds a fresh extension after a main repair", async () => {
    const { job, application, campaignId } = await enqueue("enforce");
    const triggerId = randomUUID();
    await pool.query("UPDATE campaign_state SET event_triggers=$2::jsonb WHERE campaign_id=$1", [campaignId, JSON.stringify([{ id: triggerId, label: "Keeper arrival", timing: "after", condition: "Mira waits.", effect: "The bell rings as the keeper arrives.", addTextAfter: true, triggeredCount: 0, lastTriggeredTurn: null, lastTriggeredAt: null }])]);
    reviewVerdict = "pass"; reviewSequence = ["conflict", "pass"]; extensionConflict = false; requests.length = 0;
    await runGenerationJob(pool, `semantic-main-event-${randomUUID()}`, 30, credentialSecret);
    const gate = await application.getReview({ ownerUserId, jobId: job.id });
    expect(gate).toMatchObject({ state: "pending", stage: "continuity" });
    await application.decideReview({ ownerUserId, jobId: job.id }, { reviewId: gate.reviewId, revision: gate.revision, decision: "retry" });
    await runGenerationJob(pool, `semantic-main-event-retry-${randomUUID()}`, 30, credentialSecret);
    expect(await application.getJob({ ownerUserId, jobId: job.id })).toMatchObject({ status: "completed" });
    const saved = (await pool.query("SELECT orchestration_private FROM generation_jobs WHERE id=$1", [job.id])).rows[0].orchestration_private;
    expect(saved.semanticRepair).toMatchObject({ status: "validated", scope: "main" });
    expect(saved.validatedMainDraft.story.narration).not.toContain("The bell rings");
    expect(saved.extension.story.narration).toContain("The bell rings");
    expect(saved.extension.story.narration.match(/The bell rings/gu)).toHaveLength(1);
    expect(requests.filter((body) => body.includes("story-continuity-repair-v1"))).toHaveLength(1);
    expect(requests.filter((body) => body.includes("complete an already validated adventure turn"))).toHaveLength(2);
    const repair = JSON.parse(JSON.parse(requests.find((body) => body.includes("story-continuity-repair-v1"))!).messages[1].content);
    expect(repair.original_main.narration).not.toContain("The bell rings");
    expect(repair.rejected_final.narration).toContain("The bell rings");
  });

  it("pauses final event coverage before one authorized rewrite while preserving the main prefix", async () => {
    const { job, application, campaignId } = await enqueue("enforce");
    const triggerId = randomUUID();
    await pool.query("UPDATE campaign_state SET event_triggers=$2::jsonb WHERE campaign_id=$1", [campaignId, JSON.stringify([{ id: triggerId, label: "Keeper arrival", timing: "after", condition: "Mira waits.", effect: "The bell rings as the keeper arrives.", addTextAfter: true, triggeredCount: 0, lastTriggeredTurn: null, lastTriggeredAt: null }])]);
    reviewVerdict = "pass"; eventCoverageSequence = [false, true, true]; requests.length = 0;
    try {
      const acceptedBefore = (await pool.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM turns WHERE campaign_id=$1 AND accepted_at IS NOT NULL", [campaignId]
      )).rows[0]!.count;
      await runGenerationJob(pool, `event-coverage-gate-${randomUUID()}`, 30, credentialSecret);

      expect(await application.getJob({ ownerUserId, jobId: job.id })).toMatchObject({ status: "recoverable", errorCode: "generation_review_required" });
      const gate = await application.getReview({ ownerUserId, jobId: job.id });
      expect(gate).toMatchObject({ stage: "event_coverage", candidateScope: "final", canKeep: false, canRetry: true });
      expect(requests.filter((body) => body.includes("Rewrite the complete story JSON so the narration visibly dramatizes every required scene beat"))).toHaveLength(0);
      expect((await pool.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM turns WHERE campaign_id=$1 AND accepted_at IS NOT NULL", [campaignId]
      )).rows[0]!.count).toBe(acceptedBefore);

      await application.decideReview({ ownerUserId, jobId: job.id }, { reviewId: gate.reviewId, revision: gate.revision, decision: "retry" });
      await runGenerationJob(pool, `event-coverage-retry-${randomUUID()}`, 30, credentialSecret);
      expect(await application.getJob({ ownerUserId, jobId: job.id })).toMatchObject({ status: "completed" });
      const saved = (await pool.query("SELECT orchestration_private FROM generation_jobs WHERE id=$1", [job.id])).rows[0].orchestration_private;
      expect(saved.eventCoverageRepair).toMatchObject({ authorizedReviewId: gate.reviewId, authorizedRevision: gate.revision });
      expect(saved.extension.story.narration.startsWith(saved.validatedMainDraft.story.narration)).toBe(true);
      expect(requests.filter((body) => body.includes("Rewrite the complete story JSON so the narration visibly dramatizes every required scene beat"))).toHaveLength(1);
    } finally { eventCoverageSequence = []; }
  });

  it("pauses before-event coverage before one authorized rewrite", async () => {
    const { job, application, campaignId } = await enqueue("enforce");
    const triggerId = randomUUID();
    await pool.query("UPDATE campaign_state SET event_triggers=$2::jsonb WHERE campaign_id=$1", [campaignId, JSON.stringify([{ id: triggerId, label: "Keeper arrival", timing: "before", condition: "Mira waits.", effect: "The bell rings as the keeper arrives.", addTextAfter: false, triggeredCount: 0, lastTriggeredTurn: null, lastTriggeredAt: null }])]);
    reviewVerdict = "pass"; eventCoverageSequence = [false, true, true]; requests.length = 0;
    try {
      const acceptedBefore = (await pool.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM turns WHERE campaign_id=$1 AND accepted_at IS NOT NULL", [campaignId]
      )).rows[0]!.count;
      await runGenerationJob(pool, `before-event-gate-${randomUUID()}`, 30, credentialSecret);
      const gate = await application.getReview({ ownerUserId, jobId: job.id });
      expect(await application.getJob({ ownerUserId, jobId: job.id })).toMatchObject({ status: "recoverable", errorCode: "generation_review_required" });
      expect(gate).toMatchObject({ stage: "event_coverage", candidateScope: "main", canKeep: false, canRetry: true });
      expect(requests.filter((body) => body.includes("Rewrite the complete story JSON so the narration visibly dramatizes every required scene beat"))).toHaveLength(0);
      expect((await pool.query<{ count: number }>("SELECT count(*)::int AS count FROM turns WHERE campaign_id=$1 AND accepted_at IS NOT NULL", [campaignId])).rows[0]!.count).toBe(acceptedBefore);

      await application.decideReview({ ownerUserId, jobId: job.id }, { reviewId: gate.reviewId, revision: gate.revision, decision: "retry" });
      await runGenerationJob(pool, `before-event-retry-${randomUUID()}`, 30, credentialSecret);
      expect(await application.getJob({ ownerUserId, jobId: job.id })).toMatchObject({ status: "completed" });
      const saved = (await pool.query("SELECT orchestration_private FROM generation_jobs WHERE id=$1", [job.id])).rows[0].orchestration_private;
      expect(saved.eventCoverageRepair).toMatchObject({ authorizedReviewId: gate.reviewId, authorizedRevision: gate.revision, mainRepairConsumed: true });
      expect(requests.filter((body) => body.includes("Rewrite the complete story JSON so the narration visibly dramatizes every required scene beat"))).toHaveLength(1);
    } finally { eventCoverageSequence = []; }
  });

  it("does not repeat an event-coverage rewrite after a semantic main restart", async () => {
    const { job, application, campaignId } = await enqueue("enforce");
    const triggerId = randomUUID();
    await pool.query("UPDATE campaign_state SET event_triggers=$2::jsonb WHERE campaign_id=$1", [campaignId, JSON.stringify([{ id: triggerId, label: "Keeper arrival", timing: "after", condition: "Mira waits.", effect: "The bell rings as the keeper arrives.", addTextAfter: true, triggeredCount: 0, lastTriggeredTurn: null, lastTriggeredAt: null }])]);
    reviewVerdict = "pass"; reviewSequence = ["conflict"]; eventCoverageSequence = [false, true, true, true, true, true, true, false]; requests.length = 0;
    try {
      await runGenerationJob(pool, `coverage-then-semantic-${randomUUID()}`, 30, credentialSecret);
      const eventGate = await application.getReview({ ownerUserId, jobId: job.id });
      expect(eventGate).toMatchObject({ state: "pending", stage: "event_coverage" });
      await application.decideReview({ ownerUserId, jobId: job.id }, { reviewId: eventGate.reviewId, revision: eventGate.revision, decision: "retry" });
      await runGenerationJob(pool, `coverage-then-semantic-event-retry-${randomUUID()}`, 30, credentialSecret);
      const continuityGate = await application.getReview({ ownerUserId, jobId: job.id });
      expect(continuityGate).toMatchObject({ state: "pending", stage: "continuity" });
      await application.decideReview({ ownerUserId, jobId: job.id }, { reviewId: continuityGate.reviewId, revision: continuityGate.revision, decision: "retry" });
      await runGenerationJob(pool, `coverage-then-semantic-continuity-retry-${randomUUID()}`, 30, credentialSecret);
      expect(await application.getJob({ ownerUserId, jobId: job.id })).toMatchObject({ status: "recoverable", errorCode: "generation_review_required" });
      const laterEventGate = await application.getReview({ ownerUserId, jobId: job.id });
      expect(laterEventGate).toMatchObject({ state: "pending", stage: "event_coverage", canRetry: false });
      const saved = (await pool.query("SELECT orchestration_private FROM generation_jobs WHERE id=$1", [job.id])).rows[0].orchestration_private;
      expect(saved.logicalAttempt).toMatchObject({ semanticRepairsConsumed: 1, eventCoverageRepairsConsumed: 1 });
      expect(requests.filter((body) => body.includes("Rewrite the complete story JSON so the narration visibly dramatizes every required scene beat"))).toHaveLength(1);
      expect(requests.filter((body) => body.includes("story-continuity-repair-v1"))).toHaveLength(1);
    } finally { eventCoverageSequence = []; }
  });

  it("invalidates a consumed choice repair after a semantic restart without dispatching another choice repair", async () => {
    const { job, application } = await enqueue("enforce", true);
    reviewVerdict = "pass"; reviewSequence = ["conflict"]; needsChoiceRepair = true; semanticRepairNeedsChoiceRepair = true; requests.length = 0;
    try {
      await runGenerationJob(pool, `choice-then-semantic-${randomUUID()}`, 30, credentialSecret);
      const choiceGate = await application.getReview({ ownerUserId, jobId: job.id });
      expect(choiceGate).toMatchObject({ state: "pending", stage: "choices" });
      await application.decideReview({ ownerUserId, jobId: job.id }, { reviewId: choiceGate.reviewId, revision: choiceGate.revision, decision: "retry" });
      await runGenerationJob(pool, `choice-then-semantic-choice-retry-${randomUUID()}`, 30, credentialSecret);
      const continuityGate = await application.getReview({ ownerUserId, jobId: job.id });
      expect(continuityGate).toMatchObject({ state: "pending", stage: "continuity" });
      await application.decideReview({ ownerUserId, jobId: job.id }, { reviewId: continuityGate.reviewId, revision: continuityGate.revision, decision: "retry" });
      await runGenerationJob(pool, `choice-then-semantic-continuity-retry-${randomUUID()}`, 30, credentialSecret);
      expect(await application.getJob({ ownerUserId, jobId: job.id })).toMatchObject({ status: "recoverable", errorCode: "generation_checkpoint_incompatible" });
      const saved = (await pool.query("SELECT orchestration_private FROM generation_jobs WHERE id=$1", [job.id])).rows[0].orchestration_private;
      expect(saved.logicalAttempt).toMatchObject({ semanticRepairsConsumed: 1, choiceRepairsConsumed: 1 });
      expect(saved.choiceRepair).toBeUndefined();
      expect(requests.filter((body) => body.includes("final_narration"))).toHaveLength(1);
      expect(requests.filter((body) => body.includes("story-continuity-repair-v1"))).toHaveLength(1);
    } finally { needsChoiceRepair = false; semanticRepairNeedsChoiceRepair = false; }
  });

  it("commits a semantic repair that supersedes a complete canonical fact sent in its repair authority", async () => {
    let factId = "";
    const { job, application } = await enqueue("enforce", false, async (campaignId) => {
      const state = await getCampaignRuntimeState(pool, campaignId);
      const corrected = await updateCampaignRuntimeState(pool, campaignId, {
        ...state,
        expectedTurnNumber: state.activeTurnNumber,
        expectedRevision: state.revision,
        canonicalFacts: [...state.canonicalFacts, { id: null, content: "The keeper is absent." }]
      });
      factId = corrected.canonicalFacts.find((fact) => fact.content === "The keeper is absent.")?.id ?? "";
      if (!factId) throw new Error("Fixture state correction did not persist the canonical fact ID.");
    });
    reviewVerdict = "pass"; reviewSequence = ["conflict", "pass"]; repairSupersedesFactId = factId; requests.length = 0;
    try {
      await runGenerationJob(pool, `semantic-fact-${randomUUID()}`, 30, credentialSecret);
      const gate = await application.getReview({ ownerUserId, jobId: job.id });
      await application.decideReview({ ownerUserId, jobId: job.id }, { reviewId: gate.reviewId, revision: gate.revision, decision: "retry" });
      await runGenerationJob(pool, `semantic-fact-retry-${randomUUID()}`, 30, credentialSecret);
      const completed = await application.getJob({ ownerUserId, jobId: job.id });
      expect(completed, JSON.stringify({ completed, repair: requests.find((body) => body.includes("story-continuity-repair-v1")) })).toMatchObject({ status: "completed" });
      expect(requests.find((body) => body.includes("story-continuity-repair-v1"))).toContain(factId);
    } finally { repairSupersedesFactId = null; }
  });

  it("rejects a semantic repair that supersedes a canonical fact omitted from its repair authority", async () => {
    const { job, application, campaignId } = await enqueue("enforce");
    const source = (await pool.query<{ world_version_id: string; id: string; turn_number: number }>("SELECT c.world_version_id,t.id,t.turn_number FROM campaigns c JOIN turns t ON t.campaign_id=c.id AND t.turn_number=c.active_turn_number WHERE c.id=$1", [campaignId])).rows[0]!;
    const factId = randomUUID();
    await pool.query("INSERT INTO campaign_canonical_facts (id,owner_user_id,campaign_id,world_version_id,source_turn_id,source_turn_number,source_fact_index,content,normalized_content,valid_from_turn) VALUES ($1,$2,$3,$4,$5,$6,0,$7,$8,$6)", [factId, ownerUserId, campaignId, source.world_version_id, source.id, source.turn_number, "The keeper is absent.", "the keeper is absent."]);
    reviewVerdict = "pass"; reviewSequence = ["conflict", "pass"]; repairSupersedesFactId = factId; requests.length = 0;
    try {
      await runGenerationJob(pool, `semantic-omitted-fact-${randomUUID()}`, 30, credentialSecret);
      const gate = await application.getReview({ ownerUserId, jobId: job.id });
      await application.decideReview({ ownerUserId, jobId: job.id }, { reviewId: gate.reviewId, revision: gate.revision, decision: "retry" });
      await runGenerationJob(pool, `semantic-omitted-fact-retry-${randomUUID()}`, 30, credentialSecret);
      const repair = requests.find((body) => body.includes("story-continuity-repair-v1"));
      expect(repair).not.toContain(factId);
      expect(await application.getJob({ ownerUserId, jobId: job.id })).toMatchObject({ status: "failed", errorCode: "generation_failed" });
    } finally { repairSupersedesFactId = null; }
  });

  it.each(["dispatched", "validated"] as const)("reclaims a %s semantic-repair checkpoint without a second repair dispatch", async (crashAt) => {
    const { job, application } = await enqueue("enforce");
    reviewVerdict = "pass"; reviewSequence = ["conflict", "pass"]; requests.length = 0;
    await runGenerationJob(pool, `semantic-gate-${crashAt}-${randomUUID()}`, 30, credentialSecret);
    const gate = await application.getReview({ ownerUserId, jobId: job.id });
    expect(gate).toMatchObject({ state: "pending", stage: "continuity" });
    await application.decideReview({ ownerUserId, jobId: job.id }, { reviewId: gate.reviewId, revision: gate.revision, decision: "retry" });
    const repository = createPostgresGenerationExecutionRepository(pool);
    const providers = workerProviderGraph(pool, credentialSecret);
    const collaborators = createGenerationExecutionCollaborators(pool, createApiIllustrationApplication(pool, providers.illustration), apiMemoryApplication(pool, credentialSecret), providers.generation);
    let interrupted = false;
    const wrapped = { ...repository, async saveOrchestration(scope: Parameters<typeof repository.saveOrchestration>[0], value: Parameters<typeof repository.saveOrchestration>[1]) {
      const updated = await repository.saveOrchestration(scope, value);
      if (!interrupted && value.semanticRepair?.status === crashAt) {
        interrupted = true;
        await pool.query("UPDATE generation_jobs SET lease_expires_at=now()-interval '1 second' WHERE id=$1", [job.id]);
        throw Object.assign(new Error("Injected termination after semantic repair checkpoint"), { code: "generation_cancelled" });
      }
      return updated;
    } };
    const workerId = `semantic-crash-${randomUUID()}`;
    const claim = await repository.claimNext({ workerId, leaseSeconds: 30 });
    await createGenerationExecutor({ pool, repository: wrapped, collaborators }).execute({ claim: claim!, workerId, leaseSeconds: 30 });
    const before = requests.length;
    await runGenerationJob(pool, `semantic-reclaim-${randomUUID()}`, 30, credentialSecret);
    const repairCalls = requests.filter((body) => body.includes("story-continuity-repair-v1"));
    expect(repairCalls).toHaveLength(crashAt === "dispatched" ? 0 : 1);
    expect(await application.getJob({ ownerUserId, jobId: job.id })).toMatchObject({ status: crashAt === "validated" ? "completed" : "recoverable" });
    expect(requests.length).toBeGreaterThanOrEqual(before);
  });

  it.each([
    { crashAt: "dispatched", mutation: "none" },
    { crashAt: "completed", mutation: "none", initialTemperature: 0.37 },
    { crashAt: "completed", mutation: "provider", initialTemperature: 0.37 },
    { crashAt: "completed", mutation: "authority" }
  ] as const)("reclaims $crashAt review with $mutation change without duplicating calls", async ({ crashAt, mutation, initialTemperature }) => {
    if (initialTemperature !== undefined) await pool.query("UPDATE provider_profiles SET temperature=$2 WHERE id=$1", [providerId, initialTemperature]);
    const { job, application, campaignId } = await enqueue("enforce");
    reviewVerdict = "pass"; requests.length = 0;
    const repository = createPostgresGenerationExecutionRepository(pool);
    const providers = workerProviderGraph(pool, credentialSecret);
    const collaborators = createGenerationExecutionCollaborators(pool, createApiIllustrationApplication(pool, providers.illustration), apiMemoryApplication(pool, credentialSecret), providers.generation);
    const loadIllustration = vi.fn(collaborators.illustration.loadStreamingIllustrationConfig);
    collaborators.illustration.loadStreamingIllustrationConfig = loadIllustration;
    let interrupted = false;
    const wrapped = { ...repository, async saveOrchestration(scope: Parameters<typeof repository.saveOrchestration>[0], value: Parameters<typeof repository.saveOrchestration>[1]) {
      const updated = await repository.saveOrchestration(scope, value);
      if (!interrupted && value.continuityReview?.status === crashAt) {
        interrupted = true;
        await pool.query("UPDATE generation_jobs SET lease_expires_at=now()-interval '1 second' WHERE id=$1", [job.id]);
        throw Object.assign(new Error("Injected worker termination after durable checkpoint"), { code: "generation_cancelled" });
      }
      return updated;
    } };
    const workerId = `crash-${randomUUID()}`;
    const claim = await repository.claimNext({ workerId, leaseSeconds: 30 });
    expect(claim?.jobId).toBe(job.id);
    await createGenerationExecutor({ pool, repository: wrapped, collaborators }).execute({ claim: claim!, workerId, leaseSeconds: 30 });
    const before = requests.length;
    if (mutation === "provider") await pool.query("UPDATE provider_profiles SET temperature=0.1 WHERE id=$1", [providerId]);
    if (mutation === "authority") await pool.query("UPDATE campaigns SET character_profile_revision=character_profile_revision+1 WHERE id=$1", [campaignId]);
    await runGenerationJob(pool, `reclaim-${randomUUID()}`, 30, credentialSecret);
    expect(requests).toHaveLength(before);
    expect(await application.getJob({ ownerUserId, jobId: job.id })).toMatchObject({ status: crashAt === "completed" && mutation === "none" ? "completed" : "recoverable" });
    if (mutation === "provider" || initialTemperature !== undefined) await pool.query("UPDATE provider_profiles SET temperature=0 WHERE id=$1", [providerId]);
    expect(loadIllustration).not.toHaveBeenCalled();
    expect(await runGenerationJob(pool, `duplicate-${randomUUID()}`, 30, credentialSecret)).toBe(false);
  });

  it("preserves the candidate and exposes review budget counts when complete evidence cannot fit", async () => {
    await pool.query("UPDATE provider_profiles SET context_window_tokens=20000 WHERE id=$1", [providerId]);
    try {
      const { job, application, campaignId } = await enqueue("enforce");
      primaryNarration = "The lantern shines. ".repeat(900).trim();
      requests.length = 0;
      const before = (await pool.query("SELECT count(*)::int AS count FROM turns WHERE campaign_id=$1", [campaignId])).rows[0].count;
      await runGenerationJob(pool, `review-overflow-${randomUUID()}`, 30, credentialSecret);
      expect(await application.getJob({ ownerUserId, jobId: job.id })).toMatchObject({ status: "recoverable" });
      expect(await application.getReview({ ownerUserId, jobId: job.id })).toMatchObject({ stage: "continuity", canKeep: true });
      const saved = (await pool.query("SELECT orchestration_private FROM generation_jobs WHERE id=$1", [job.id])).rows[0].orchestration_private;
      expect(saved.contextDiagnostic).toMatchObject({ code: "context_budget_exceeded", operation: "story_continuity_review", scope: "provider_request", requiredTokens: expect.any(Number), availableTokens: 20_000 });
      expect(saved.contextDiagnostic.requiredTokens).toBeGreaterThan(20_000);
      expect(saved.continuityReview).toMatchObject({ verdict: "unavailable", unavailableReason: "context_budget_exceeded" });
      expect(saved.generationReview.gateCandidate.story).toEqual(saved.validatedMainDraft.story);
      expect(saved.generationReview.gateCandidate.story.narration.replace(/\s+/g, " ")).toBe(primaryNarration);
      expect((await pool.query("SELECT count(*)::int AS count FROM turns WHERE campaign_id=$1", [campaignId])).rows[0].count).toBe(before);
      expect(requests).toHaveLength(1);
    } finally {
      await pool.query("UPDATE provider_profiles SET context_window_tokens=65536 WHERE id=$1", [providerId]);
    }
  });

  it.each(["observe", "enforce"] as const)("%s handles unavailable evidence and defers artwork until acceptance", async (mode) => {
    const { job, application } = await enqueue(mode); reviewVerdict = "pass"; requests.length = 0;
    const repository = createPostgresGenerationExecutionRepository(pool);
    const providers = workerProviderGraph(pool, credentialSecret);
    const collaborators = createGenerationExecutionCollaborators(pool, createApiIllustrationApplication(pool, providers.illustration), apiMemoryApplication(pool, credentialSecret), providers.generation);
    const acceptedImages = vi.fn(collaborators.illustration.enqueueAcceptedTurnIllustrationSegments);
    collaborators.illustration.enqueueAcceptedTurnIllustrationSegments = acceptedImages;
    const wrapped = { ...repository, async saveOrchestration(scope: Parameters<typeof repository.saveOrchestration>[0], value: Parameters<typeof repository.saveOrchestration>[1]) {
      if (value.validatedMainDraft && !value.continuityReview) delete value.sourceEvidenceManifest;
      return repository.saveOrchestration(scope, value);
    } };
    const workerId = `missing-evidence-${randomUUID()}`;
    const claim = await repository.claimNext({ workerId, leaseSeconds: 30 });
    await createGenerationExecutor({ pool, repository: wrapped, collaborators }).execute({ claim: claim!, workerId, leaseSeconds: 30 });
    expect(await application.getJob({ ownerUserId, jobId: job.id })).toMatchObject({ status: mode === "observe" ? "completed" : "recoverable" });
    const saved = (await pool.query("SELECT orchestration_private FROM generation_jobs WHERE id=$1", [job.id])).rows[0].orchestration_private;
    expect(saved.continuityReview).toMatchObject({ verdict: "unavailable", binding: { manifestHash: null }, unavailableReason: "evidence_unavailable" });
    expect(requests).toHaveLength(1);
    expect(acceptedImages).toHaveBeenCalledTimes(mode === "observe" ? 1 : 0);
  });

  it("commit refuses a changed final draft even when its persisted review passed", async () => {
    const { job, application } = await enqueue("enforce"); reviewVerdict = "pass"; requests.length = 0;
    const repository = createPostgresGenerationExecutionRepository(pool);
    const providers = workerProviderGraph(pool, credentialSecret);
    const collaborators = createGenerationExecutionCollaborators(pool, createApiIllustrationApplication(pool, providers.illustration), apiMemoryApplication(pool, credentialSecret), providers.generation);
    const workerId = `tamper-${randomUUID()}`;
    const claim = await repository.claimNext({ workerId, leaseSeconds: 30 });
    const wrapped = { ...repository, commitAcceptedTurn: (input: Parameters<typeof repository.commitAcceptedTurn>[0]) => repository.commitAcceptedTurn({ ...input, story: { ...input.story, continuity_summary: "A different unreviewed summary." } }) };
    await createGenerationExecutor({ pool, repository: wrapped, collaborators }).execute({ claim: claim!, workerId, leaseSeconds: 30 });
    expect(await application.getJob({ ownerUserId, jobId: job.id })).toMatchObject({ status: "recoverable" });
    expect((await pool.query("SELECT result_turn_id FROM generation_jobs WHERE id=$1", [job.id])).rows[0].result_turn_id).toBeNull();
  });

  it("refuses old provisional artwork on reviewed jobs before any provider dispatch", async () => {
    const { job, application } = await enqueue("observe");
    requests.length = 0;
    await pool.query("UPDATE generation_jobs SET streaming_segments_state=$2::jsonb WHERE id=$1", [job.id, JSON.stringify({ provisionalSetId: randomUUID() })]);
    await runGenerationJob(pool, `provisional-${randomUUID()}`, 30, credentialSecret);
    expect(requests).toHaveLength(0);
    expect(await application.getJob({ ownerUserId, jobId: job.id })).toMatchObject({ status: "recoverable" });
    await expect(application.retry({ ownerUserId, jobId: job.id })).rejects.toThrow();
  });

  it.each([{ verdict: "pass", expected: "completed" }, { verdict: "uncertain", expected: "completed" }] as const)("skips review for a new campaign by default even when the reviewer would return $verdict", async ({ verdict, expected }) => {
    const story = JSON.parse(await readFile(resolve(repositoryRoot, "tests/fixtures/legacy-story.json"), "utf8"));
    story.world.title = `Default Max review ${randomUUID()}`;
    const imported = await importLegacyStory(pool, storyImportRequestSchema.parse({ sourceName: "default-max-review.story", story }));
    const runtimeConfig = loadDefaultRuntimeStoryMemoryConfig();
    const application = composeGeneration(pool, apiProviderGraph(pool, credentialSecret).generation, undefined, {
      installedCapability: runtimeConfig.storyMemoryCapability ?? null,
      enforceEnabled: runtimeConfig.storyMemoryEnforceEnabled === true
    });
    reviewVerdict = verdict;
    requests.length = 0;
    try {
      const job = await application.enqueueAppend({ ownerUserId, campaignId: imported.campaignId }, generationRequestSchema.parse({ action: "Wait at the observatory.", requestedInputMode: "action", resolvedInputMode: "action", inputModeSource: "explicit", providerProfileId: providerId, idempotencyKey: randomUUID(), context: { budgetTokens: 32000, compression: "full", recentTurns: 8 } }));
      const queued = (await pool.query<{ context_options: { storyMemoryPolicy?: unknown } }>("SELECT context_options FROM generation_jobs WHERE id=$1", [job.id])).rows[0]!;
      expect(queued.context_options.storyMemoryPolicy).toMatchObject({ policy: { capability: "r3", continuityReview: "off" } });

      await runGenerationJob(pool, `default-max-review-${randomUUID()}`, 30, credentialSecret);

      expect(await application.getJob({ ownerUserId, jobId: job.id })).toMatchObject({ status: expected });
      const saved = (await pool.query<{ orchestration_private: { continuityReview?: unknown } }>("SELECT orchestration_private FROM generation_jobs WHERE id=$1", [job.id])).rows[0]!;
      expect(saved.orchestration_private.continuityReview).toBeUndefined();
      expect(requests.filter((body) => body.includes("story-continuity-review-v1"))).toHaveLength(0);
    } finally {
      reviewVerdict = "pass";
      requests.length = 0;
    }
  });

  it.each([{ mode: "observe", verdict: "conflict", expected: "completed" }, { mode: "observe", verdict: "uncertain", expected: "completed" }, { mode: "enforce", verdict: "pass", expected: "completed" }, { mode: "enforce", verdict: "uncertain", expected: "recoverable" }] as const)("$mode review $verdict ends $expected with bound private checkpoint", async ({ mode, verdict, expected }) => {
    const story = JSON.parse(await readFile(resolve(repositoryRoot, "tests/fixtures/legacy-story.json"), "utf8"));
    story.world.title = `Review ${randomUUID()}`;
    const imported = await importLegacyStory(pool, storyImportRequestSchema.parse({ sourceName: "review.story", story }));
    await saveStoryMemoryEnrollment(pool, { ownerUserId, campaignId: imported.campaignId }, { capability: "r3", reviewMode: mode }, { installedCapability: "r3", enforceEnabled: true });
    const application = composeGeneration(pool, apiProviderGraph(pool, credentialSecret).generation, undefined, { installedCapability: "r3", enforceEnabled: true });
    reviewVerdict = verdict; requests.length = 0;
    const job = await application.enqueueAppend({ ownerUserId, campaignId: imported.campaignId }, generationRequestSchema.parse({ action: "Wait at the observatory.", requestedInputMode: "action", resolvedInputMode: "action", inputModeSource: "explicit", providerProfileId: providerId, idempotencyKey: randomUUID(), context: { budgetTokens: 32000, compression: "full", recentTurns: 8 } }));
    await runGenerationJob(pool, `review-${randomUUID()}`, 30, credentialSecret);
    expect(await application.getJob({ ownerUserId, jobId: job.id })).toMatchObject({ status: expected });
    const saved = (await pool.query("SELECT orchestration_private,streaming_segments_state FROM generation_jobs WHERE id=$1", [job.id])).rows[0];
    expect(saved.orchestration_private.continuityReview).toMatchObject({ mode, status: "completed", verdict });
    expect(saved.streaming_segments_state?.provisionalSetId).toBeFalsy();
    expect(requests).toHaveLength(2);
    const reviewInput = JSON.parse(JSON.parse(requests[1]!).messages[1].content);
    expect(reviewInput.draft).not.toHaveProperty("scratchpad");
    expect(saved.orchestration_private.continuityReview.reviewRequestHash).toBe(createHash("sha256").update(requests[1]!).digest("hex"));
    const costs = await pool.query("SELECT operation FROM provider_cost_events WHERE generation_job_id=$1 ORDER BY created_at", [job.id]);
    expect(costs.rows.map((row) => row.operation)).toContain("story_continuity_review");
  });
});
