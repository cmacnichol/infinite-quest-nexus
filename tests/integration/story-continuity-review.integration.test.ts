import { vi } from "vitest";
import { createPostgresGenerationExecutionRepository } from "../../packages/database/src/generation-execution-repository.js";
import { createGenerationExecutionCollaborators } from "../../services/runtime/src/generation-worker-composition.js";
import { createGenerationExecutor } from "../../services/runtime/src/generation-executor-adapter.js";
import { createApiIllustrationApplication } from "../../services/runtime/src/illustration-composition.js";
import { apiMemoryApplication } from "../helpers/memory-applications.js";
import { workerProviderGraph } from "../helpers/provider-application-fixtures.js";
import { createHash, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generationRequestSchema } from "../../packages/contracts/src/generation.js";
import { storyImportRequestSchema } from "../../packages/contracts/src/imports.js";
import { createDatabasePool, initialOwnerId, type DatabaseClient, type DatabasePool } from "../../packages/database/src/pool.js";
import { loadRuntimeConfig } from "../../packages/database/src/config.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { loadPostgresChronicleGenerationAuthorityContext } from "../../packages/database/src/chronicle-generation-context.js";
import { resolveGenerationAuthoritySnapshot } from "../../packages/database/src/generation-authority.js";
import type { GenerationEvidenceManifest } from "../../packages/application/src/memory/generation-context.js";
import { createProvider } from "../helpers/provider-application-fixtures.js";
import { createApiGenerationApplication as composeGeneration } from "../../services/runtime/src/generation-api-composition.js";
import { apiProviderGraph } from "../helpers/provider-application-fixtures.js";
import { saveStoryMemoryEnrollment } from "../../packages/database/src/story-memory-policy-repository.js";
import { getCampaignRuntimeState, importLegacyStory, updateCampaignRuntimeState } from "../helpers/memory-aware-services.js";
import { runGenerationJob } from "../helpers/generation-worker-harness.js";
import { installIntegrationProviderTransport } from "./provider-transport-test-helper.js";
import { deriveStoryContinuityRunFromExecutorCapture, evaluateStoryContinuity, type StoryContinuityEvidence } from "../../scripts/lib/story-continuity-evaluator.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
const credentialSecret = "story-continuity-evaluator-fixture-secret";
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
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

function reply(narration: string): string {
  return JSON.stringify({ narration, choices: ["Continue.", "Wait.", "Listen.", "Leave."], custom_action_suggestion: "Continue.", scratchpad: "private fixture", tracker_updates: [], image_prompt: "Fixture relay.", continuity_summary: narration, canonical_facts: [], superseded_facts: [], canonical_fact_updates: [], open_threads: [] });
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
  let semanticRepairNeedsChoiceRepair = false;
  let extensionConflict = false;
  let invalidSemanticRepair = false;
  let eventCoverageSequence: boolean[] = [];
  let sceneCoverageSequence: boolean[] = [];
  let repairSupersedesFactId: string | null = null;

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
      const story = JSON.parse(reply("Mira waits at the observatory."));
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
    return JSON.stringify({ version: "story-continuity-review-v1", verdict, findings: verdict === "conflict" ? [{ kind: "contradiction", category: "location", severity: "contradiction", basis: { kind: "source", evidenceId: basis.id, quote: basis.content.slice(0, 20) }, output: { path: "/narration", start, end: start + quote.length, quote }, explanation: "Fixture reviewer reports a grounded conflict." }] : [] });
  }

  beforeAll(async () => {
    pool = createDatabasePool(databaseUrl!, 6);
    await migrateDatabase(pool, resolve(repositoryRoot, "database/migrations"));
    ownerUserId = await initialOwnerId(pool);
    const transport = installIntegrationProviderTransport();
    server = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8"); request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        if (request.url?.endsWith("/chat/completions")) requests.push(body);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ id: randomUUID(), model: "t17-capturing-fake", choices: [{ message: { content: reviewResponse(body) }, finish_reason: "stop" }], usage: { prompt_tokens: 80, completion_tokens: 30, total_tokens: 110, cost: 0.001 } }));
      });
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("T17 fake provider did not bind.");
    providerId = (await createProvider(pool, { name: `T17 capturing fake ${randomUUID()}`, providerType: "openai_compatible", providerRole: "text", baseUrl: `http://127.0.0.1:${address.port}`, defaultModel: "t17-capturing-fake", contextWindowTokens: 65_536, maxOutputTokens: 4_096, temperature: 0, enabled: true, configuration: {} }, credentialSecret)).id;
    (server as Server & { transport?: { close(): Promise<void> } }).transport = transport;
  });

  afterAll(async () => { await new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done())); await (server as Server & { transport?: { close(): Promise<void> } }).transport?.close(); await pool.end(); });

  async function enqueue(
    mode: "off" | "observe" | "enforce",
    scene = false,
    prepareCampaign?: (campaignId: string) => Promise<void>,
    action = "Wait at the observatory.",
    storyOnly = scene
  ) {
    const story = JSON.parse(await readFile(resolve(repositoryRoot, "tests/fixtures/legacy-story.json"), "utf8"));
    story.world.title = `Review ${randomUUID()}`;
    const imported = await importLegacyStory(pool, storyImportRequestSchema.parse({ sourceName: "review.story", story }));
    await saveStoryMemoryEnrollment(pool, { ownerUserId, campaignId: imported.campaignId }, { capability: "r3", reviewMode: mode }, { installedCapability: "r3", enforceEnabled: true });
    if (storyOnly) await pool.query("UPDATE campaigns SET turn_control_style='flexible_scene' WHERE id=$1", [imported.campaignId]);
    await prepareCampaign?.(imported.campaignId);
    const application = composeGeneration(pool, apiProviderGraph(pool, credentialSecret).generation, undefined, { installedCapability: "r3", enforceEnabled: true });
    const job = await application.enqueueAppend({ ownerUserId, campaignId: imported.campaignId }, generationRequestSchema.parse({ action, requestedInputMode: scene ? "scene" : "action", resolvedInputMode: scene ? "scene" : "action", inputModeSource: "explicit", providerProfileId: providerId, idempotencyKey: randomUUID(), context: { budgetTokens: 32000, compression: "full", recentTurns: 8 } }));
    return { job, application, campaignId: imported.campaignId };
  }

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
      const requestsBeforeOfflineKeep = requests.length;
      const repository = createPostgresGenerationExecutionRepository(pool);
      const providers = workerProviderGraph(pool, credentialSecret);
      const loadTextExecution = vi.fn(async () => { throw new Error("text provider must remain offline for final Keep"); });
      const collaborators = {
        ...createGenerationExecutionCollaborators(pool, createApiIllustrationApplication(pool, providers.illustration), apiMemoryApplication(pool, credentialSecret), providers.generation),
        loadTextExecution
      };
      const workerId = `offline-final-keep-resume-${randomUUID()}`;
      const claim = await repository.claimNext({ workerId, leaseSeconds: 30 });
      expect(claim?.jobId).toBe(job.id);
      await expect(createGenerationExecutor({ pool, repository, collaborators }).execute({ claim: claim!, workerId, leaseSeconds: 30 })).resolves.toBe(true);

      expect(loadTextExecution).not.toHaveBeenCalled();
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
    } finally { reviewUnavailable = false; reviewVerdict = "pass"; }
  });

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

      await application.decideReview({ ownerUserId, jobId: job.id }, {
        reviewId: reoffered.reviewId, revision: reoffered.revision, decision: "keep"
      });
      const repository = createPostgresGenerationExecutionRepository(pool);
      const providers = workerProviderGraph(pool, credentialSecret);
      const loadTextExecution = vi.fn(async () => { throw new Error("text provider must remain offline for re-offered final Keep"); });
      const collaborators = {
        ...createGenerationExecutionCollaborators(pool, createApiIllustrationApplication(pool, providers.illustration), apiMemoryApplication(pool, credentialSecret), providers.generation),
        loadTextExecution
      };
      const workerId = `continuity-reoffer-keep-${randomUUID()}`;
      const claim = await repository.claimNext({ workerId, leaseSeconds: 30 });
      await expect(createGenerationExecutor({ pool, repository, collaborators }).execute({ claim: claim!, workerId, leaseSeconds: 30 })).resolves.toBe(true);
      expect(loadTextExecution).not.toHaveBeenCalled();
      expect(requests.filter((body) => body.includes("story-continuity-repair-v1"))).toHaveLength(1);
      expect((await pool.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM turns WHERE campaign_id=$1 AND accepted_at IS NOT NULL", [campaignId]
      )).rows[0]!.count).toBe(acceptedBefore + 1);
    } finally { invalidSemanticRepair = false; reviewSequence = []; }
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

  it("reserves one semantic repair, replaces the main, and reviews the repaired request before commit", async () => {
    const { job, application } = await enqueue("enforce");
    reviewVerdict = "pass"; reviewSequence = ["conflict", "pass"]; requests.length = 0;
    await runGenerationJob(pool, `semantic-main-${randomUUID()}`, 30, credentialSecret);
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

  it("does not spend a second semantic repair when the post-repair review still conflicts", async () => {
    const { job, application } = await enqueue("enforce");
    reviewVerdict = "pass"; reviewSequence = ["conflict", "conflict"]; requests.length = 0;
    await runGenerationJob(pool, `semantic-exhausted-${randomUUID()}`, 30, credentialSecret);
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
    reviewVerdict = "pass"; reviewSequence = ["conflict"]; eventCoverageSequence = [false, true, true, false]; requests.length = 0;
    try {
      await runGenerationJob(pool, `coverage-then-semantic-${randomUUID()}`, 30, credentialSecret);
      expect(await application.getJob({ ownerUserId, jobId: job.id })).toMatchObject({ status: "recoverable", errorCode: "event_coverage_failed" });
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
      const repair = requests.find((body) => body.includes("story-continuity-repair-v1"));
      expect(repair).not.toContain(factId);
      expect(await application.getJob({ ownerUserId, jobId: job.id })).toMatchObject({ status: "failed", errorCode: "generation_failed" });
    } finally { repairSupersedesFactId = null; }
  });

  it.each(["dispatched", "validated"] as const)("reclaims a %s semantic-repair checkpoint without a second repair dispatch", async (crashAt) => {
    const { job, application } = await enqueue("enforce");
    reviewVerdict = "pass"; reviewSequence = ["conflict", "pass"]; requests.length = 0;
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

  it.each([{ crashAt: "dispatched", mutation: "none" }, { crashAt: "completed", mutation: "none" }, { crashAt: "completed", mutation: "provider" }, { crashAt: "completed", mutation: "authority" }] as const)("reclaims $crashAt review with $mutation change without duplicating calls", async ({ crashAt, mutation }) => {
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
    if (mutation === "provider") await pool.query("UPDATE provider_profiles SET temperature=0 WHERE id=$1", [providerId]);
    expect(loadIllustration).not.toHaveBeenCalled();
    expect(await runGenerationJob(pool, `duplicate-${randomUUID()}`, 30, credentialSecret)).toBe(false);
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
    expect(saved.continuityReview).toMatchObject({ verdict: "unavailable", binding: { manifestHash: null } });
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

  it.each([{ verdict: "pass", expected: "completed" }, { verdict: "uncertain", expected: "recoverable" }] as const)("uses the imported campaign's default Max policy when runtime review is $verdict", async ({ verdict, expected }) => {
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
      expect(queued.context_options.storyMemoryPolicy).toMatchObject({ policy: { capability: "r3", continuityReview: "enforce" } });

      await runGenerationJob(pool, `default-max-review-${randomUUID()}`, 30, credentialSecret);

      expect(await application.getJob({ ownerUserId, jobId: job.id })).toMatchObject({ status: expected });
      const saved = (await pool.query<{ orchestration_private: { continuityReview?: unknown } }>("SELECT orchestration_private FROM generation_jobs WHERE id=$1", [job.id])).rows[0]!;
      expect(saved.orchestration_private.continuityReview).toMatchObject({ mode: "enforce", status: "completed", verdict });
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
