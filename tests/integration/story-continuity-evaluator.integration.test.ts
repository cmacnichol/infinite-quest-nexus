import { createHash, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generationRequestSchema } from "../../packages/contracts/src/generation.js";
import { storyImportRequestSchema } from "../../packages/contracts/src/imports.js";
import { createDatabasePool, initialOwnerId, type DatabaseClient, type DatabasePool } from "../../packages/database/src/pool.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { loadPostgresChronicleGenerationAuthorityContext } from "../../packages/database/src/chronicle-generation-context.js";
import { resolveGenerationAuthoritySnapshot } from "../../packages/database/src/generation-authority.js";
import { canonicalEvidenceJson, type GenerationEvidenceManifest } from "../../packages/application/src/memory/generation-context.js";
import { createProvider } from "../helpers/provider-application-fixtures.js";
import { createApiGenerationApplication as composeGeneration } from "../../services/runtime/src/generation-api-composition.js";
import { apiProviderGraph } from "../helpers/provider-application-fixtures.js";
import { saveStoryMemoryEnrollment } from "../../packages/database/src/story-memory-policy-repository.js";
import { getCampaignCharacterProfile, getCampaignRuntimeState, importLegacyStory, updateCampaignCharacterProfile, updateCampaignRuntimeState } from "../helpers/memory-aware-services.js";
import { runGenerationJob } from "../helpers/generation-worker-harness.js";
import { installIntegrationProviderTransport } from "./provider-transport-test-helper.js";
import { deriveStoryContinuityRunFromExecutorCapture, evaluateStoryContinuity, parseContinuityCorpus, type StoryContinuityEvidence } from "../../scripts/lib/story-continuity-evaluator.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
const credentialSecret = "story-continuity-evaluator-fixture-secret";
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
type CorpusScenario = ReturnType<typeof parseContinuityCorpus>["scenarios"][number];
type CapturedDispatch = Readonly<{ body: string; jobId: string; manifest: GenerationEvidenceManifest; originalBody: string; repairCalls: number; calls: number; latencyMs: number }>;
type CapturedAuthorityRecord = Readonly<{ sourceId: string; sourcePath: string; contentHash: string; content: string }>;
const privateMechanicsKeys = new Set(["rpgStats", "eventTriggers", "pendingEventTriggers", "defaultTriggers", "mechanicsPrivate", "roll"]);

function reply(narration: string): string {
  return JSON.stringify({ narration, choices: ["Continue.", "Wait.", "Listen.", "Leave."], custom_action_suggestion: "Continue.", scratchpad: "private fixture", tracker_updates: [], image_prompt: "Fixture relay.", continuity_summary: narration, canonical_facts: [], superseded_facts: [], canonical_fact_updates: [], open_threads: [] });
}

integration("T15 executor-backed continuity evidence", () => {
  let pool: DatabasePool;
  let server: Server;
  let ownerUserId = "";
  let providerId = "";
  const replies: string[] = [];
  const requests: string[] = [];
  let conflictNextReview = false;
  let repairedReply = "";

  beforeAll(async () => {
    pool = createDatabasePool(databaseUrl!, 6);
    await migrateDatabase(pool, resolve(repositoryRoot, "database/migrations"));
    ownerUserId = await initialOwnerId(pool);
    const transport = installIntegrationProviderTransport();
    server = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8"); request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        if (!request.url?.endsWith("/chat/completions")) { response.writeHead(404); response.end("Unsupported fixture operation"); return; }
        requests.push(body);
        const input = JSON.parse(JSON.parse(body).messages[1].content);
        let content: string;
        if (input.protocol === "story-continuity-repair-v1") content = repairedReply;
        else if (input.protocol === "story-continuity-review-v1") {
          const conflict = conflictNextReview; conflictNextReview = false;
          const basis = input.evidence.find((entry: { content: string }) => entry.content.length > 0);
          const quote = input.draft.narration.slice(0, 4);
          content = JSON.stringify({ version: "story-continuity-review-v1", verdict: conflict ? "conflict" : "pass", findings: conflict ? [{ kind: "contradiction", category: "location", severity: "contradiction", basis: { kind: "source", evidenceId: basis.id, quote: basis.content.slice(0, 20) }, output: { path: "/narration", start: 0, end: quote.length, quote }, explanation: "Deterministic fixture conflict." }] : [] });
        } else content = replies.shift() ?? reply("Fallback fixture narration.");
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ id: randomUUID(), model: "t15-capturing-fake", choices: [{ message: { content }, finish_reason: "stop" }], usage: { prompt_tokens: 80, completion_tokens: 30, total_tokens: 110 } }));
      });
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("T15 fake provider did not bind.");
    providerId = (await createProvider(pool, { name: `T15 capturing fake ${randomUUID()}`, providerType: "openai_compatible", providerRole: "text", baseUrl: `http://127.0.0.1:${address.port}`, defaultModel: "t15-capturing-fake", contextWindowTokens: 65_536, maxOutputTokens: 4_096, temperature: 0, enabled: true, configuration: { textResponseFormatPolicy: "auto" } }, credentialSecret)).id;
    (server as Server & { transport?: { close(): Promise<void> } }).transport = transport;
  });

  afterAll(async () => { await new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done())); await (server as Server & { transport?: { close(): Promise<void> } }).transport?.close(); await pool.end(); });

  async function campaign(label: string, mode: "baseline" | "observe" | "repaired", sourceKind: CorpusScenario["sourceKind"], sourceText: string): Promise<{ campaignId: string; worldVersionId: string }> {
    const story = JSON.parse(await readFile(resolve(repositoryRoot, "tests/fixtures/legacy-story.json"), "utf8"));
    story.world.title = `T15 ${label.replace(/:(baseline|observe|repaired)$/u, "")}`;
    if (sourceKind === "world_rule") story.world.rules = sourceText;
    const imported = await importLegacyStory(pool, storyImportRequestSchema.parse({ sourceName: "t15-evaluator.story", story }));
    const result = await pool.query<{ world_version_id: string }>("SELECT world_version_id FROM campaigns WHERE id=$1", [imported.campaignId]);
    await saveStoryMemoryEnrollment(pool, { ownerUserId, campaignId: imported.campaignId }, { capability: "r3", reviewMode: mode === "baseline" ? "off" : mode === "observe" ? "observe" : "enforce" }, { installedCapability: "r3", enforceEnabled: true });
    return { campaignId: imported.campaignId, worldVersionId: result.rows[0]!.world_version_id };
  }

  async function dispatch(campaignId: string, action: string, retryPendingReview = false): Promise<CapturedDispatch> {
    const before = requests.length;
    const started = performance.now();
    const application = composeGeneration(pool, apiProviderGraph(pool, credentialSecret).generation, undefined, { installedCapability: "r3", enforceEnabled: true });
    const job = await application.enqueueAppend({ ownerUserId, campaignId }, generationRequestSchema.parse({ action, requestedInputMode: "action", resolvedInputMode: "action", inputModeSource: "explicit", providerProfileId: providerId, idempotencyKey: randomUUID(), context: { budgetTokens: 32_000, compression: "full", recentTurns: 8 } }));
    expect(await runGenerationJob(pool, `t15-${randomUUID()}`, 30, credentialSecret)).toBe(true);
    if (retryPendingReview) {
      const review = await application.getReview({ ownerUserId, jobId: job.id });
      expect(review).toMatchObject({ stage: "continuity", canRetry: true });
      await application.decideReview({ ownerUserId, jobId: job.id }, {
        reviewId: review.reviewId,
        revision: review.revision,
        decision: "retry"
      });
      expect(await runGenerationJob(pool, `t15-retry-${randomUUID()}`, 30, credentialSecret)).toBe(true);
    }
    expect(await application.getJob({ ownerUserId, jobId: job.id })).toMatchObject({ status: "completed" });
    const originalBody = requests.at(before);
    if (!originalBody) throw new Error("The executor did not call the T15 capturing fake provider.");
    const manifestResult = await pool.query<{ orchestration_private: { sourceEvidenceManifest?: GenerationEvidenceManifest } }>(
      "SELECT orchestration_private FROM generation_jobs WHERE id=$1 AND owner_user_id=$2",
      [job.id, ownerUserId]
    );
    const manifest = manifestResult.rows[0]?.orchestration_private.sourceEvidenceManifest;
    if (!manifest) throw new Error("The enrolled R1 executor did not persist a source evidence manifest.");
    const captured = requests.slice(before).find((body) => createHash("sha256").update(body).digest("hex") === manifest.producingRequestHash);
    if (!captured) throw new Error("The persisted source evidence manifest is not bound to the captured provider request.");
    return { body: captured, jobId: job.id, manifest, originalBody, repairCalls: requests.slice(before).filter((body) => JSON.parse(JSON.parse(body).messages[1].content).protocol === "story-continuity-repair-v1").length, calls: requests.length - before, latencyMs: performance.now() - started };
  }

  async function acceptedTurn(campaignId: string): Promise<{ id: string; turnNumber: number; narration: string; state: Record<string, unknown> }> {
    const result = await pool.query<{ id: string; turn_number: number; narration: string; state_snapshot_private: Record<string, unknown> }>("SELECT id,turn_number,narration,state_snapshot_private FROM turns WHERE campaign_id=$1 ORDER BY turn_number DESC LIMIT 1", [campaignId]);
    return { id: result.rows[0]!.id, turnNumber: result.rows[0]!.turn_number, narration: result.rows[0]!.narration, state: result.rows[0]!.state_snapshot_private };
  }

  function authorityRecord(sourceId: string, sourcePath: string, value: unknown): CapturedAuthorityRecord {
    const content = typeof value === "string" ? value : canonicalEvidenceJson(value);
    return { sourceId, sourcePath, content, contentHash: createHash("sha256").update(content).digest("hex") };
  }

  /** Match the private planner's fiction-safe state projection without reading its manifest. */
  function fictionSafeRecord(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(fictionSafeRecord);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !privateMechanicsKeys.has(key))
      .map(([key, child]) => [key, fictionSafeRecord(child)]));
  }

  async function readPersistedAuthority(
    scope: { campaignId: string; worldVersionId: string },
    base: { id: string; turnNumber: number },
    sourceKind: CorpusScenario["sourceKind"],
    sourceTurnId?: string,
    canonicalFactId?: string,
  ): Promise<CapturedAuthorityRecord> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const frozen = await resolveGenerationAuthoritySnapshot(client, {
        ownerUserId, campaignId: scope.campaignId, operationKind: "append",
        expectedTurnNumber: base.turnNumber + 1, baseIdentityVersion: "generation-base-v3", captureRecentWindow: sourceKind === "recent_history"
      });
      const authority = await loadPostgresChronicleGenerationAuthorityContext(client, {
        ownerUserId, campaignId: scope.campaignId, worldVersionId: scope.worldVersionId,
        operationKind: "append", expectedTurnNumber: base.turnNumber + 1,
        query: "Continue the fixture history.", expectedBaseIdentity: frozen.baseIdentity
      });
      if (frozen.baseIdentity.baseTurnId !== base.id) throw new Error("The protected authority read is not bound to the accepted base turn.");
      switch (sourceKind) {
        case "world_rule":
          return authorityRecord(frozen.worldVersionId, "/authoritativeRules", authority.authority.rules);
        case "campaign_profile": {
          const sourceId = authority.authority.selectedCharacterId ?? authority.authority.characterAuthority?.name;
          if (!sourceId || !authority.authority.characterAuthority) throw new Error("The persisted character authority is unavailable.");
          return authorityRecord(sourceId, "/selectedCharacterAuthority", authority.authority.characterAuthority);
        }
        case "current_correction":
          return authorityRecord(frozen.baseIdentity.baseTurnId, "/currentContinuity", fictionSafeRecord(authority.authority.currentContinuity));
        case "canonical_fact": {
          const index = authority.authority.currentContinuity.canonicalFacts.findIndex((fact) => fact.id === canonicalFactId);
          if (index < 0 || !canonicalFactId) throw new Error("The persisted canonical fact is unavailable.");
          return authorityRecord(canonicalFactId, `/currentContinuity/canonicalFacts/${index}`, authority.authority.currentContinuity.canonicalFacts[index]);
        }
        case "recent_history": {
          const index = authority.recentTurns?.findIndex((turn) => turn.turnId === sourceTurnId) ?? -1;
          if (index < 0 || !sourceTurnId) throw new Error(`The persisted recent-history authority is unavailable (${sourceTurnId}; ${authority.recentTurns?.map((turn) => turn.turnId).join(",") ?? "none"}).`);
          return authorityRecord(sourceTurnId, `/recentTurns/${index}/acceptedNarration`, authority.recentTurns![index]!.narration);
        }
        case "current_scene": {
          const latest = authority.authority.latestTurn;
          if (!latest) throw new Error("The persisted current scene is unavailable.");
          return authorityRecord(frozen.baseIdentity.baseTurnId, "/currentScene/narration", latest.narration);
        }
      }
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
  }

  async function executeHistory(scenario: CorpusScenario, candidateNarration: string, candidateState: { continuitySummary: string; openThreads: string[] }, outputMode: "baseline" | "observe" | "repaired", repair: { narration: string; state: { continuitySummary: string; openThreads: string[] } }) {
    const { id, trajectory } = scenario;
    const persistedAuthorityText = trajectory === "teacher_forced" ? scenario.evidence : "Earlier accepted rollout state: the wrong route leads south.";
    const fixture = await campaign(id, outputMode, scenario.sourceKind, persistedAuthorityText);
    replies.length = 0;
    replies.push(reply(["current_scene", "recent_history"].includes(scenario.sourceKind) ? persistedAuthorityText : "A neutral fixture scene establishes the base turn."));
    await dispatch(fixture.campaignId, "Establish fixture history.");
    const source = await acceptedTurn(fixture.campaignId);
    let base = source;
    let canonicalFactId: string | undefined;
    if (scenario.sourceKind === "campaign_profile") {
      const profile = await getCampaignCharacterProfile(pool, fixture.campaignId);
      await updateCampaignCharacterProfile(pool, fixture.campaignId, {
        name: profile.name || "T15 Fixture",
        profile: { ...profile.profile, unclassifiedNotes: persistedAuthorityText },
        expectedRevision: profile.revision,
        editSource: "manual"
      });
    } else if (scenario.sourceKind === "current_correction" || scenario.sourceKind === "canonical_fact") {
      const state = await getCampaignRuntimeState(pool, fixture.campaignId);
      const updated = await updateCampaignRuntimeState(pool, fixture.campaignId, {
        ...state, expectedTurnNumber: state.activeTurnNumber, expectedRevision: state.revision,
        ...(scenario.sourceKind === "current_correction" ? { continuitySummary: persistedAuthorityText } : {
          canonicalFacts: [...state.canonicalFacts, { id: null, content: persistedAuthorityText }]
        })
      });
      if (scenario.sourceKind === "canonical_fact") {
        canonicalFactId = updated.canonicalFacts.find((fact) => fact.content === persistedAuthorityText)?.id ?? undefined;
        if (!canonicalFactId) throw new Error("Canonical-fact setup did not persist a scoped fact ID.");
      }
    } else if (scenario.sourceKind === "recent_history") {
      replies.push(reply("A neutral bridge scene follows the historical authority."));
      await dispatch(fixture.campaignId, "Advance beyond the historical authority.");
      base = await acceptedTurn(fixture.campaignId);
    }
    const sourceRecord = await readPersistedAuthority(fixture, base, scenario.sourceKind, source.id, canonicalFactId);
    if (sourceRecord.sourcePath !== scenario.oracle.authoritativeEvidence.sourcePath) {
      throw new Error(`Corpus source path ${scenario.oracle.authoritativeEvidence.sourcePath} does not match persisted ${scenario.sourceKind} authority ${sourceRecord.sourcePath}.`);
    }
    const evidence: StoryContinuityEvidence = {
      id: `source:${id}`,
      text: trajectory === "teacher_forced" ? sourceRecord.content : scenario.evidence,
      required: true,
      sourceId: sourceRecord.sourceId,
      sourcePath: sourceRecord.sourcePath,
      contentHash: createHash("sha256").update(trajectory === "teacher_forced" ? sourceRecord.content : scenario.evidence).digest("hex")
    };
    // The private loader independently reads the actual protected/history candidate,
    // including its typed source identity; the current scene is not every source.
    const candidateRecord = await readPersistedAuthority(fixture, base, scenario.sourceKind, source.id, canonicalFactId);
    const candidate = { ...JSON.parse(reply(candidateNarration)), continuity_summary: candidateState.continuitySummary, open_threads: candidateState.openThreads };
    replies.push(JSON.stringify(candidate));
    conflictNextReview = outputMode === "repaired";
    repairedReply = JSON.stringify({ ...JSON.parse(reply(repair.narration)), continuity_summary: repair.state.continuitySummary, open_threads: repair.state.openThreads });
    const captured = await dispatch(fixture.campaignId, "Continue fixture history.", outputMode === "repaired");
    const accepted = await acceptedTurn(fixture.campaignId);
    const manifestEntry = captured.manifest.entries.find((entry) => entry.source.id === sourceRecord.sourceId && entry.sourcePath === sourceRecord.sourcePath);
    if (!manifestEntry || manifestEntry.content !== sourceRecord.content) throw new Error(`The captured manifest does not identify ${scenario.sourceKind} (${sourceRecord.sourceId} ${sourceRecord.sourcePath}) by its independently persisted content.`);
    if (!evidence.sourcePath || !evidence.contentHash) throw new Error("The source oracle is missing its exact source identity.");
    // Rollout continues from its accepted state; no oracle text repairs history.
    replies.push(JSON.stringify({ ...candidate, narration: "The party continues along the accepted route." }));
    const replay = await dispatch(fixture.campaignId, "Replay the accepted fixture state.");
    const replayTurn = await acceptedTurn(fixture.campaignId);
    const run = deriveStoryContinuityRunFromExecutorCapture({
      scenarioId: id, trajectory, outputMode,
      provider: { id: providerId, model: "t15-capturing-fake", settingsHash: createHash("sha256").update(JSON.stringify({ providerType: "openai_compatible", model: "t15-capturing-fake", temperature: 0, contextWindowTokens: 65_536, maxOutputTokens: 4_096, configuration: { textResponseFormatPolicy: "auto" } })).digest("hex") },
      sourceEvidence: [evidence], sourceRecords: [sourceRecord], candidateRecords: [candidateRecord],
      sourceEvidenceManifest: captured.manifest, capturedRequestBody: captured.body, originalRequestBody: captured.originalBody,
      acceptedTurn: { narration: accepted.narration, continuitySummary: String(accepted.state.continuitySummary ?? ""), openThreads: accepted.state.openThreads as string[] },
      fieldOracles: [...Object.entries(scenario.oracle.expectedState).map(([key, expected]) => ({ path: `/${key}`, evidenceId: evidence.id, expected, forbidden: scenario.oracle.forbiddenContradictions })), { path: "/narration", evidenceId: evidence.id, forbidden: scenario.oracle.forbiddenContradictions }],
      replayState: { ...replayTurn.state, narration: replayTurn.narration }, replayRequestBody: replay.body
    });
    return { run: { ...run, providerCalls: captured.calls, repairCalls: captured.repairCalls, latencyMs: captured.latencyMs, usage: { inputTokens: captured.calls * 80, outputTokens: captured.calls * 30, costUsd: 0 } }, evidence, privateCapture: {
      scenarioId: id, capturedRequestBody: captured.body, replayRequestBody: replay.body,
      sourceEvidenceManifest: captured.manifest, acceptedState: accepted.state, replayState: replayTurn.state
    } };
  }

  it("executes the complete matrix through enqueue, worker, accepted rows, and next-turn captures", async () => {
    const corpus = parseContinuityCorpus(JSON.parse(await readFile(resolve(repositoryRoot, "scripts/fixtures/story-continuity-evaluator-corpus.v1.json"), "utf8")));
    expect(corpus.scenarios).toHaveLength(20);
    expect(new Set(corpus.scenarios.map((scenario) => scenario.sourceKind))).toEqual(new Set([
      "world_rule", "campaign_profile", "current_correction", "canonical_fact", "recent_history", "current_scene"
    ]));
    const runs = [] as ReturnType<typeof deriveStoryContinuityRunFromExecutorCapture>[];
    const scenarios = [] as { id: string; corpusScenarioId: string; trajectory: "teacher_forced" | "rollout"; sourceEvidence: StoryContinuityEvidence[] }[];
    const privateCaptures: unknown[] = [];
    for (const seed of corpus.preregistration.seeds) for (const outputMode of ["baseline", "observe", "repaired"] as const) {
      for (const [index, scenario] of corpus.scenarios.entries()) {
        const paired = { ...scenario, id: `${scenario.id}:${seed}:${outputMode}` };
        const candidate = corpus.candidates.find((item) => item.scenarioId === scenario.id)!;
        const result = await executeHistory(paired, candidate.narration, candidate.state, outputMode, { narration: candidate.repairedNarration, state: candidate.repairedState });
        runs.push(result.run); scenarios.push({ id: paired.id, corpusScenarioId: scenario.id, trajectory: scenario.trajectory, sourceEvidence: [result.evidence] }); privateCaptures.push(result.privateCapture);
      }
    }
    const report = evaluateStoryContinuity({ corpusVersion: corpus.version, scenarios, runs, preregistration: corpus.preregistration });
    expect(report).not.toHaveProperty("layers");
    expect(report.strata).toEqual(expect.arrayContaining([
      expect.objectContaining({ trajectory: "teacher_forced", outputMode: "baseline" }),
      expect.objectContaining({ trajectory: "rollout", outputMode: "baseline" })
    ]));
    expect(report.preregistration.sampleCount).toBe(120);
    expect(report.preregistration.scenarioCount).toBe(20);
    expect(report.strata.reduce((total, stratum) => total + stratum.layers.sourceAvailable.denominator, 0)).toBe(120);
    expect(report.strata).toHaveLength(6);
    for (const trajectory of ["teacher_forced", "rollout"]) {
      const pair = report.strata.filter((stratum) => stratum.trajectory === trajectory && stratum.outputMode !== "repaired");
      expect(pair[0]!.layers).toEqual(pair[1]!.layers);
    }
    const rollouts = report.strata.filter((stratum) => stratum.trajectory === "rollout");
    expect(rollouts.every((stratum) => stratum.layers.sourceAvailable.fail > 0)).toBe(true);
    const teacherRuns = runs.filter((run) => run.trajectory === "teacher_forced");
    expect(teacherRuns.every((run) => run.sourceAvailableIds.length === 1 && run.candidateRetrievedIds.length === 1 && run.sentEvidenceIds.length === 1)).toBe(true);
    const rolloutRuns = runs.filter((run) => run.trajectory === "rollout");
    expect(rolloutRuns.every((run) => run.sourceAvailableIds.length === 0 && run.sentEvidenceIds.length === 0)).toBe(true);
    expect(report.errors.unsupportedProposedState.length).toBeGreaterThan(0);
    expect(report.errors.narrationContradictions.length).toBeGreaterThan(0);
    expect(report.errors.omissionWarnings.length).toBeGreaterThan(0);
    const reportPath = process.env.STORY_CONTINUITY_EVALUATOR_REPORT;
    if (reportPath) await writeFile(reportPath, JSON.stringify(report), "utf8");
    const artifactPath = process.env.STORY_CONTINUITY_EVALUATOR_PRIVATE_ARTIFACT;
    if (artifactPath) {
      await mkdir(dirname(artifactPath), { recursive: true });
      await writeFile(artifactPath, `${JSON.stringify({ version: "story-continuity-private-artifact-v1", report, captures: privateCaptures })}\n`, { encoding: "utf8", flag: "wx" });
    }
  }, 180_000);
});
