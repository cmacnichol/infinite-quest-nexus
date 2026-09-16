import { z } from "zod";
import { createHash } from "node:crypto";
import { canonicalEvidenceJson, generationEvidenceManifestSchema, type GenerationEvidenceManifest, type StoryEvidence } from "../../packages/application/src/memory/generation-context.js";
import { isAbsolute, relative, resolve } from "node:path";
import fixtureCorpus from "../fixtures/story-continuity-evaluator-corpus.v1.json" with { type: "json" };

export type EvaluationOutcome = "pass" | "fail" | "skipped" | "uncertain";
export type EvaluationTrajectory = "teacher_forced" | "rollout";
export type EvaluationOutputMode = "baseline" | "observe" | "repaired";

export type StoryContinuityEvidence = Readonly<{
  id: string;
  text: string;
  required: boolean;
  sourceId?: string; sourcePath?: string; contentHash?: string;
  /** Exact required spans in the independently read normalized source field. */
  spans?: readonly Readonly<{ start: number; end: number }>[];
}>;

export type StoryContinuityScenario = Readonly<{
  id: string;
  corpusScenarioId?: string;
  trajectory: EvaluationTrajectory;
  sourceEvidence: readonly StoryContinuityEvidence[];
}>;

export type ReplacementFieldResult = Readonly<{
  path: string;
  evidenceId: string;
  status: EvaluationOutcome;
  failureKind?: "omission" | "contradiction" | "unsupported";
}>;

export type EvaluationReviewFinding = Readonly<{
  kind: "contradiction" | "omission";
  evidenceId: string;
  quote: string;
  target: "source" | "candidate";
  candidateText?: string;
}>;

export type AcceptedOutputObservation = Readonly<{
  outcome: EvaluationOutcome;
  ignoredEvidenceIds: readonly string[];
  narrationContradictionEvidenceIds: readonly string[];
  unsupportedStateEvidenceIds: readonly string[];
  omissionWarningEvidenceIds: readonly string[];
  excludedPrivateEvidenceIds: readonly string[];
  replacementFields: readonly ReplacementFieldResult[];
  replay: Readonly<{ status: EvaluationOutcome; replacementFields: readonly ReplacementFieldResult[]; requestFields?: readonly ReplacementFieldResult[] }>;
  reviewFindings?: readonly EvaluationReviewFinding[];
}>;

export type StoryContinuityRun = Readonly<{
  scenarioId: string;
  trajectory: EvaluationTrajectory;
  outputMode: EvaluationOutputMode;
  provider: Readonly<{ id: string; model: string; settingsHash: string }>;
  sourceAvailableIds: readonly string[];
  candidateRetrievedIds: readonly string[];
  sentEvidenceIds: readonly string[];
  accepted: AcceptedOutputObservation;
  adjudication?: Readonly<{
    blinded: true; assessorId: string; labelVersion: string; rubricVersion: string;
    contradictionTruePositive: number; contradictionFalsePositive: number; contradictionFalseNegative: number;
    semanticFalseBlock: boolean; operationalFalseBlock: boolean; completed: boolean;
    writingQuality: number; directionCoverage: number;
  }>;
  providerCalls?: number; repairCalls?: number;
  latencyMs?: number;
  usage?: Readonly<{ inputTokens: number; outputTokens: number; costUsd: number }>;
}>;

export type StoryContinuityEvaluationInput = Readonly<{
  corpusVersion: string;
  scenarios: readonly StoryContinuityScenario[];
  runs: readonly StoryContinuityRun[];
  preregistration?: Readonly<{ seeds: readonly string[]; pairedMethod: string; frozenLabelVersion: string; blindedRubricVersion: string }>;
}>;

const corpusSchema = z.object({
  version: z.string().min(1),
  preregistration: z.object({ seeds: z.array(z.string().min(1)).min(1), pairedMethod: z.string(), frozenLabelVersion: z.string(), blindedRubricVersion: z.string() }),
  scenarios: z.array(z.object({ id: z.string().min(1), trajectory: z.enum(["teacher_forced", "rollout"]), evidence: z.string(),
    sourceKind: z.enum(["world_rule", "campaign_profile", "current_correction", "canonical_fact", "recent_history", "current_scene"]).default("current_scene"),
    oracle: z.object({ expectedState: z.object({ continuitySummary: z.string().optional(), openThreads: z.array(z.string()).optional() }), forbiddenContradictions: z.array(z.string()), authoritativeEvidence: z.object({ sourcePath: z.string() }) }) })),
  candidates: z.array(z.object({ scenarioId: z.string().min(1), narration: z.string(), state: z.object({ continuitySummary: z.string(), openThreads: z.array(z.string()) }), repairedNarration: z.string(), repairedState: z.object({ continuitySummary: z.string(), openThreads: z.array(z.string()) }) }))
});
export function parseContinuityCorpus(value: unknown) {
  const corpus = corpusSchema.parse(value);
  const ids = new Set(corpus.scenarios.map((scenario) => scenario.id));
  if (ids.size !== corpus.scenarios.length || corpus.candidates.length !== ids.size || new Set(corpus.candidates.map((candidate) => candidate.scenarioId)).size !== ids.size
    || corpus.candidates.some((candidate) => !ids.has(candidate.scenarioId))) throw new Error("Corpus candidates must map one-to-one to scenario IDs.");
  return corpus;
}

export type Score = Readonly<{
  numerator: number;
  denominator: number;
  pass: number;
  fail: number;
  skipped: number;
  uncertain: number;
  interval: WilsonInterval;
}>;

export type WilsonInterval = Readonly<{ lower: number; upper: number; numerator: number; denominator: number }>;

type LayerName = "sourceAvailable" | "candidateRetrieved" | "evidenceSent" | "acceptedOutputConsistent";
type LayerScores = Readonly<Record<LayerName, Score>>;
type ErrorRecord = Readonly<{ scenarioId: string; trajectory: EvaluationTrajectory; outputMode: EvaluationOutputMode; evidenceId: string; reason?: string }>;

export type StoryContinuityEvaluationReport = Readonly<{
  version: "story-continuity-evaluation-report-v1";
  corpusVersion: string;
  /** Quality is only meaningful within one trajectory/output-mode stratum. */
  strata: readonly (Readonly<{ trajectory: EvaluationTrajectory; outputMode: EvaluationOutputMode; layers: LayerScores; replacementState: Score; replay: Score; contradictions: Readonly<{ proposed: number; validated: number; precision: WilsonInterval; recall: WilsonInterval }>; adjudication: ReturnType<typeof stratumMeasurements>; operational: ReturnType<typeof stratumOperations> }>)[];
  errors: Readonly<{
    missingEvidence: readonly ErrorRecord[];
    evidencePresentButIgnored: readonly ErrorRecord[];
    narrationContradictions: readonly ErrorRecord[];
    unsupportedProposedState: readonly ErrorRecord[];
    omissionWarnings: readonly ErrorRecord[];
    excludedPrivateFields: readonly ErrorRecord[];
    invalidReviewEvidence: readonly ErrorRecord[];
  }>;
  preregistration: Readonly<{ scenarioCount: number; sampleCount: number; seeds: readonly string[]; pairedMethod: string; frozenLabelVersion: string; blindedRubricVersion: string }>;
  evidenceLayer: Readonly<{
    fixtureEvidence: "deterministic";
    realExecutorIntegration: "not_run" | "completed";
    liveProvider: "not_run";
    note: string;
  }>;
}>;

export type CappedLiveResult = Readonly<{ calls: number; inputTokens: number; outputTokens: number; costUsd: number }>;

/** Executes only a caller-provided copied-campaign transport and stops before any configured ceiling is exceeded. */
export async function executeCappedLiveEvaluation(
  configuration: LiveConfiguration,
  dispatch: (index: number) => Promise<Readonly<{ inputTokens: number; outputTokens: number; costUsd: number }>>,
  reserve: (index: number) => Readonly<{ inputTokens: number; outputTokens: number; costUsd: number }>
): Promise<CappedLiveResult> {
  let inputTokens = 0; let outputTokens = 0; let costUsd = 0; let calls = 0;
  const valid = (value: Readonly<{ inputTokens: number; outputTokens: number; costUsd: number }>) => Object.values(value).every((number) => Number.isFinite(number) && number >= 0);
  for (let index = 0; index < configuration.maxCalls; index += 1) {
    // Reservation must bound the complete serialized input, configured maximum
    // output and provider price. Refuse the call before incurring usage.
    const maximum = reserve(index);
    if (!valid(maximum)) throw new Error("Invalid live usage reservation.");
    if (inputTokens + maximum.inputTokens > configuration.maxInputTokens || outputTokens + maximum.outputTokens > configuration.maxOutputTokens || costUsd + maximum.costUsd > configuration.maxCostUsd) break;
    const next = await dispatch(index); calls += 1;
    if (!valid(next) || next.inputTokens > maximum.inputTokens || next.outputTokens > maximum.outputTokens || next.costUsd > maximum.costUsd) throw new Error("Live transport exceeded its pre-dispatch reservation; evaluation stopped.");
    inputTokens += next.inputTokens; outputTokens += next.outputTokens; costUsd += next.costUsd;
  }
  return { calls, inputTokens, outputTokens, costUsd };
}

export type CapturedSourceRecord = Readonly<{ sourceId: string; sourcePath: string; contentHash: string; content: string }>;
export type EvaluationFieldOracle = Readonly<{ path: string; evidenceId: string; expected?: unknown; forbidden?: readonly string[] }>;
export type ExecutorCapture = Readonly<{
  scenarioId: string; trajectory: EvaluationTrajectory; outputMode: EvaluationOutputMode;
  provider: StoryContinuityRun["provider"]; sourceEvidence: readonly StoryContinuityEvidence[];
  sourceRecords: readonly CapturedSourceRecord[]; candidateRecords: readonly CapturedSourceRecord[];
  sourceEvidenceManifest: GenerationEvidenceManifest; capturedRequestBody: string; originalRequestBody?: string;
  acceptedTurn: Readonly<{ narration: string; continuitySummary: string; openThreads?: readonly string[]; canonicalFacts?: readonly string[] }>;
  fieldOracles: readonly EvaluationFieldOracle[]; replayState: unknown; replayRequestBody: string;
}>;
const contentHash = (text: string): string => createHash("sha256").update(text).digest("hex");
function fieldAt(source: unknown, pointer: string): unknown {
  if (!/^(?:\/(?:[^~/]|~[01])*)*$/u.test(pointer)) return undefined;
  let result = source;
  for (const raw of pointer === "" ? [] : pointer.slice(1).split("/")) {
    const key = raw.replaceAll("~1", "/").replaceAll("~0", "~");
    if (!result || typeof result !== "object" || !Object.hasOwn(result, key)) return undefined;
    result = Reflect.get(result, key);
  }
  return result;
}
function capturedStoryEnvelope(body: string): Record<string, unknown> | null {
  const wire = JSON.parse(body) as Record<string, unknown>;
  const messages = Array.isArray(wire.messages) ? wire.messages : Array.isArray(wire.input) ? wire.input : [];
  const candidates: string[] = typeof wire.input === "string" ? [wire.input] : [];
  for (const message of messages) {
    if (message?.role !== "user") continue;
    if (typeof message.content === "string") candidates.push(message.content);
    else if (Array.isArray(message.content)) for (const part of message.content) if (typeof part.text === "string") candidates.push(part.text);
  }
  for (const candidate of candidates) {
    try { const value = JSON.parse(candidate); if (value && typeof value === "object" && (Object.hasOwn(value, "authoritative_context") || value.protocol === "story-continuity-repair-v1")) return value; } catch { /* Non-story user content is not evidence. */ }
  }
  return null;
}
function entryIsSent(entry: StoryEvidence, envelope: Record<string, unknown>): boolean {
  if (envelope.protocol === "story-continuity-repair-v1") {
    const entries = envelope.protected_authority;
    return Array.isArray(entries) && entries.some((value) => value.id === entry.id && value.content === entry.content);
  }
  const authority = envelope.authoritative_context;
  let field: unknown;
  if (entry.selectionGroup === "direction") field = fieldAt(envelope, "/current_turn_input/text");
  else if (entry.selectionGroup === "world") {
    const references = fieldAt(authority, "/worldReferences");
    field = Array.isArray(references) ? references.find((value) => value.sourceId === entry.source.id && value.sourcePath === entry.sourcePath)?.content : undefined;
  } else if (entry.form === "excerpt") {
    const chronicle = fieldAt(authority, "/chronicle");
    field = Array.isArray(chronicle) ? chronicle.find((value) => (value.turnId ?? value.id) === entry.source.id && value.sourceHash === entry.source.contentHash)?.content : undefined;
  } else field = fieldAt(authority, entry.sourcePath);
  return field !== undefined && (typeof field === "string" ? field : canonicalEvidenceJson(field)) === entry.content;
}

/** Scores independent identity-bound source reads, selection, exact wire fields, and state oracles. */
export function deriveStoryContinuityRunFromExecutorCapture(capture: ExecutorCapture): StoryContinuityRun {
  const manifest = generationEvidenceManifestSchema.parse(capture.sourceEvidenceManifest);
  if (manifest.producingRequestHash !== contentHash(capture.capturedRequestBody)) throw new Error("Captured request does not match its producing manifest.");
  const envelope = capturedStoryEnvelope(capture.capturedRequestBody);
  const matches = (item: StoryContinuityEvidence, record: CapturedSourceRecord): boolean => Boolean(item.sourceId && item.sourcePath && item.contentHash
    && record.sourceId === item.sourceId && record.sourcePath === item.sourcePath && record.contentHash === item.contentHash
    && contentHash(record.content) === record.contentHash
    && (item.spans?.length ? item.spans.every((span) => span.start >= 0 && span.end > span.start && span.end <= record.content.length)
      && item.spans.map((span) => record.content.slice(span.start, span.end)).join("\n[…]\n") === item.text : record.content === item.text));
  const sourceAvailableIds = capture.sourceEvidence.filter((item) => capture.sourceRecords.some((record) => matches(item, record))).map((item) => item.id);
  const candidateRetrievedIds = capture.sourceEvidence.filter((item) => capture.candidateRecords.some((record) => matches(item, record))).map((item) => item.id);
  const sentEvidenceIds = capture.sourceEvidence.filter((item) => envelope && manifest.entries.some((entry) => {
    if (entry.source.id !== item.sourceId || entry.sourcePath !== item.sourcePath || !entryIsSent(entry, envelope)) return false;
    const record = capture.sourceRecords.find((candidate) => matches(item, candidate));
    if (!record) return false;
    if (entry.form === "excerpt") {
      // The normalized parent hash and exact source spans are independently
      // rebound; matching an excerpt's words elsewhere is insufficient.
      if (entry.source.contentHash !== record.contentHash || entry.sourceLength !== record.content.length
        || entry.spans.map((span) => record.content.slice(span.start, span.end)).join("\n[…]\n") !== entry.content) return false;
      const required = item.spans?.length ? item.spans : [{ start: 0, end: record.content.length }];
      return required.every((span) => entry.spans.some((sent) => sent.start <= span.start && sent.end >= span.end));
    }
    // Complete protected/history entries hash the actual normalized authority
    // document, while the independent record binds this field to its DB source.
    const sourceEnvelope = envelope.protocol === "story-continuity-repair-v1" && capture.originalRequestBody
      ? capturedStoryEnvelope(capture.originalRequestBody) : envelope;
    if (!sourceEnvelope?.authoritative_context) return false;
    const authorityHash = contentHash(canonicalEvidenceJson(sourceEnvelope.authoritative_context));
    return entry.source.contentHash === authorityHash && entry.content === record.content;
  })).map((item) => item.id);
  const fields = (state: unknown): ReplacementFieldResult[] => capture.fieldOracles.map((oracle) => {
    if (!capture.sourceEvidence.some((item) => item.id === oracle.evidenceId)) throw new Error("Field oracle references unknown evidence.");
    const actual = fieldAt(state, oracle.path);
    const status = actual === undefined ? "uncertain" : (oracle.expected === undefined || canonicalEvidenceJson(actual) === canonicalEvidenceJson(oracle.expected))
      && !(oracle.forbidden ?? []).some((text) => canonicalEvidenceJson(actual).includes(text)) ? "pass" : "fail";
    const missing = Array.isArray(oracle.expected) && Array.isArray(actual)
      ? oracle.expected.some((item) => !actual.some((value) => canonicalEvidenceJson(value) === canonicalEvidenceJson(item)))
      : oracle.expected !== undefined && oracle.expected !== "" && actual === "";
    const forbidden = actual !== undefined && (oracle.forbidden ?? []).some((text) => canonicalEvidenceJson(actual).includes(text));
    return { path: oracle.path, evidenceId: oracle.evidenceId, status,
      ...(status === "fail" ? { failureKind: forbidden ? "contradiction" as const : missing ? "omission" as const : "unsupported" as const } : {}) };
  });
  const replacementFields = fields(capture.acceptedTurn); const replayFields = fields(capture.replayState);
  let replayEnvelope: Record<string, unknown> | null = null;
  try { replayEnvelope = capturedStoryEnvelope(capture.replayRequestBody); } catch { /* Missing/invalid next request is not a pass. */ }
  const replayAuthority = replayEnvelope?.authoritative_context;
  const replayRequestFields: ReplacementFieldResult[] = [
    ["/currentContinuity/continuitySummary", capture.acceptedTurn.continuitySummary],
    ["/currentContinuity/openThreads", capture.acceptedTurn.openThreads],
    ["/currentScene/narration", capture.acceptedTurn.narration]
  ].flatMap(([path, expected]) => {
    if (expected === undefined) return [];
    const actual = fieldAt(replayAuthority, path as string);
    return [{ path: path as string, evidenceId: capture.sourceEvidence[0]?.id ?? "replay-authority",
      status: actual === undefined ? "uncertain" as const : canonicalEvidenceJson(actual) === canonicalEvidenceJson(expected) ? "pass" as const : "fail" as const }];
  });
  const outcome = (values: readonly ReplacementFieldResult[]): EvaluationOutcome => !values.length ? "uncertain" : allStageOutcome(values.map((field) => field.status));
  const failures = replacementFields.filter((field) => field.status === "fail");
  return {
    scenarioId: capture.scenarioId, trajectory: capture.trajectory, outputMode: capture.outputMode, provider: capture.provider,
    sourceAvailableIds, candidateRetrievedIds, sentEvidenceIds,
    accepted: {
      outcome: outcome(replacementFields), ignoredEvidenceIds: [...new Set(failures.filter((field) => sentEvidenceIds.includes(field.evidenceId)).map((field) => field.evidenceId))],
      narrationContradictionEvidenceIds: [...new Set(failures.filter((field) => field.path === "/narration").map((field) => field.evidenceId))],
      unsupportedStateEvidenceIds: [...new Set(failures.filter((field) => field.path !== "/narration" && field.failureKind !== "omission").map((field) => field.evidenceId))],
      omissionWarningEvidenceIds: [...new Set(failures.filter((field) => field.failureKind === "omission").map((field) => field.evidenceId))], excludedPrivateEvidenceIds: [], replacementFields,
      replay: { status: allStageOutcome([outcome(replayFields), outcome(replayRequestFields)]), replacementFields: replayFields, requestFields: replayRequestFields }
    }
  };
}

/**
 * Sanitized R1 matrix.  Candidate prose is deliberately a sibling fixture,
 * never a source-oracle value, so it cannot satisfy a retrieval/payload score.
 */
export function buildDeterministicFixtureEvaluation(): StoryContinuityEvaluationInput & Readonly<{ candidateOutputs: readonly string[] }> {
  const corpus = parseContinuityCorpus(fixtureCorpus);
  if (corpus.scenarios.length < 20 || corpus.candidates.length !== corpus.scenarios.length) {
    throw new Error("Deterministic continuity corpus must include the complete 20-scenario matrix and one candidate per scenario.");
  }
  const scenarios = corpus.scenarios.map((fixture) => ({
    id: fixture.id,
    trajectory: fixture.trajectory,
    sourceEvidence: [{ id: `source:${fixture.id}`, text: fixture.evidence, required: true }]
  }));
  // The corpus is a plan. It deliberately contains no fabricated execution
  // results; only deriveStoryContinuityRunFromExecutorCapture may add a run.
  return { corpusVersion: corpus.version, scenarios, runs: [], candidateOutputs: corpus.scenarios.map((scenario) => corpus.candidates.find((candidate) => candidate.scenarioId === scenario.id)!.narration), ...(corpus.preregistration ? { preregistration: corpus.preregistration } : {}) };
}

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`${label} contains duplicate identifiers.`);
}

function assertKnown(ids: readonly string[], known: ReadonlySet<string>, label: string): void {
  for (const id of ids) if (!known.has(id)) throw new Error(`${label} references unknown evidence ${id}.`);
}

function emptyOutcomeCounts(): Record<EvaluationOutcome, number> {
  return { pass: 0, fail: 0, skipped: 0, uncertain: 0 };
}

function score(outcomes: readonly EvaluationOutcome[]): Score {
  const counts = emptyOutcomeCounts();
  for (const outcome of outcomes) counts[outcome] += 1;
  const denominator = outcomes.length;
  return {
    numerator: counts.pass,
    denominator,
    ...counts,
    interval: wilsonInterval(counts.pass, denominator)
  };
}

function groupScore(runs: readonly EvaluatedRun[], selector: (run: EvaluatedRun) => EvaluationOutcome): Score {
  return score(runs.map(selector));
}

type EvaluatedRun = Readonly<{
  input: StoryContinuityRun;
  scenario: StoryContinuityScenario;
  source: EvaluationOutcome;
  candidate: EvaluationOutcome;
  sent: EvaluationOutcome;
  accepted: EvaluationOutcome;
  replacement: readonly EvaluationOutcome[];
  replay: EvaluationOutcome;
}>;

function stageOutcome(required: boolean, id: string, values: ReadonlySet<string>): EvaluationOutcome {
  if (values.has(id)) return "pass";
  return required ? "fail" : "skipped";
}

function allStageOutcome(outcomes: readonly EvaluationOutcome[]): EvaluationOutcome {
  if (outcomes.includes("uncertain")) return "uncertain";
  if (outcomes.includes("fail")) return "fail";
  if (outcomes.every((outcome) => outcome === "skipped")) return "skipped";
  return "pass";
}

function addError(collection: ErrorRecord[], run: StoryContinuityRun, evidenceId: string, reason?: string): void {
  collection.push({ scenarioId: run.scenarioId, trajectory: run.trajectory, outputMode: run.outputMode, evidenceId, ...(reason === undefined ? {} : { reason }) });
}

function validateReviewFinding(
  finding: EvaluationReviewFinding,
  evidence: ReadonlyMap<string, StoryContinuityEvidence>
): string | null {
  const source = evidence.get(finding.evidenceId);
  if (!source) return "unknown_evidence";
  const target = finding.target === "source" ? source.text : finding.candidateText;
  if (typeof target !== "string") return "missing_candidate_text";
  if (!finding.quote || !target.includes(finding.quote)) return "quote_not_found";
  return null;
}

/**
 * Scores the source -> candidate -> actual-payload -> accepted-output chain.
 * Every stage is keyed by evidence ID; similar wording cannot create a pass.
 */
export function evaluateStoryContinuity(input: StoryContinuityEvaluationInput): StoryContinuityEvaluationReport {
  if (!input.corpusVersion.trim()) throw new Error("A scenario corpus version is required.");
  const scenarios = new Map(input.scenarios.map((scenario) => [scenario.id, scenario]));
  if (scenarios.size !== input.scenarios.length) throw new Error("Scenario identifiers must be unique.");
  const errors = {
    missingEvidence: [] as ErrorRecord[], evidencePresentButIgnored: [] as ErrorRecord[],
    narrationContradictions: [] as ErrorRecord[], unsupportedProposedState: [] as ErrorRecord[],
    omissionWarnings: [] as ErrorRecord[], excludedPrivateFields: [] as ErrorRecord[], invalidReviewEvidence: [] as ErrorRecord[]
  };
  const evaluated: EvaluatedRun[] = [];
  for (const run of input.runs) {
    const scenario = scenarios.get(run.scenarioId);
    if (!scenario) throw new Error(`Run references unknown scenario ${run.scenarioId}.`);
    if (run.trajectory !== scenario.trajectory) throw new Error(`Run trajectory differs from scenario ${run.scenarioId}.`);
    if (!/^[a-f0-9]{64}$/u.test(run.provider.settingsHash)) throw new Error(`Run ${run.scenarioId} must pin a provider settings hash.`);
    const evidence = new Map(scenario.sourceEvidence.map((value) => [value.id, value]));
    if (evidence.size !== scenario.sourceEvidence.length) throw new Error(`Scenario ${scenario.id} has duplicate source evidence.`);
    const known = new Set(evidence.keys());
    assertUnique(run.sourceAvailableIds, "sourceAvailableIds"); assertKnown(run.sourceAvailableIds, known, "sourceAvailableIds");
    assertUnique(run.candidateRetrievedIds, "candidateRetrievedIds"); assertKnown(run.candidateRetrievedIds, known, "candidateRetrievedIds");
    assertUnique(run.sentEvidenceIds, "sentEvidenceIds"); assertKnown(run.sentEvidenceIds, known, "sentEvidenceIds");
    const sourceStages = scenario.sourceEvidence.map((item) => stageOutcome(item.required, item.id, new Set(run.sourceAvailableIds)));
    const candidateStages = scenario.sourceEvidence.map((item) => stageOutcome(item.required, item.id, new Set(run.candidateRetrievedIds)));
    const sentStages = scenario.sourceEvidence.map((item) => stageOutcome(item.required, item.id, new Set(run.sentEvidenceIds)));
    for (const item of scenario.sourceEvidence.filter((value) => value.required)) {
      if (!run.sourceAvailableIds.includes(item.id) || !run.candidateRetrievedIds.includes(item.id) || !run.sentEvidenceIds.includes(item.id)) {
        addError(errors.missingEvidence, run, item.id);
      }
    }
    for (const id of run.accepted.ignoredEvidenceIds) {
      assertKnown([id], known, "ignoredEvidenceIds");
      if (run.sentEvidenceIds.includes(id)) addError(errors.evidencePresentButIgnored, run, id);
    }
    for (const [ids, target] of [
      [run.accepted.narrationContradictionEvidenceIds, errors.narrationContradictions],
      [run.accepted.unsupportedStateEvidenceIds, errors.unsupportedProposedState],
      [run.accepted.omissionWarningEvidenceIds, errors.omissionWarnings],
      [run.accepted.excludedPrivateEvidenceIds, errors.excludedPrivateFields]
    ] as const) {
      for (const id of ids) { assertKnown([id], known, "accepted output evidence"); addError(target, run, id); }
    }
    let hasInvalidReview = false;
    for (const finding of run.accepted.reviewFindings ?? []) {
      if (finding.kind !== "contradiction") continue;
      const reason = validateReviewFinding(finding, evidence);
      if (reason) { hasInvalidReview = true; addError(errors.invalidReviewEvidence, run, finding.evidenceId, reason); }
      // A grounded quote is not an independent correctness label.
    }
    const replacement = run.accepted.replacementFields.map((field) => {
      assertKnown([field.evidenceId], known, "replacement field");
      return field.status;
    });
    for (const field of run.accepted.replay.replacementFields) {
      assertKnown([field.evidenceId], known, "replay replacement field");
    }
    let accepted = run.accepted.outcome;
    if (hasInvalidReview) accepted = "uncertain";
    else if (run.accepted.ignoredEvidenceIds.some((id) => run.sentEvidenceIds.includes(id))
      || run.accepted.narrationContradictionEvidenceIds.length > 0
      || run.accepted.unsupportedStateEvidenceIds.length > 0
      || run.accepted.excludedPrivateEvidenceIds.length > 0
      || replacement.includes("fail")) accepted = "fail";
    evaluated.push({ input: run, scenario, source: allStageOutcome(sourceStages), candidate: allStageOutcome(candidateStages), sent: allStageOutcome(sentStages), accepted, replacement, replay: run.accepted.replay.status });
  }
  const strata = [...new Map(evaluated.map((run) => [`${run.input.trajectory}:${run.input.outputMode}`, { trajectory: run.input.trajectory, outputMode: run.input.outputMode }])).values()]
    .map((group) => {
      const selected = evaluated.filter((run) => run.input.trajectory === group.trajectory && run.input.outputMode === group.outputMode);
      const replacement = selected.flatMap((run) => run.input.accepted.replacementFields.map((field) => field.status));
      const replay = selected.map((run) => run.replay);
      const adjudication = stratumMeasurements(selected.map((run) => run.input), input.preregistration);
      return { ...group, layers: {
        sourceAvailable: groupScore(selected, (run) => run.source), candidateRetrieved: groupScore(selected, (run) => run.candidate),
        evidenceSent: groupScore(selected, (run) => run.sent), acceptedOutputConsistent: groupScore(selected, (run) => run.accepted)
      }, replacementState: score(replacement), replay: score(replay),
      contradictions: { proposed: adjudication.contradictionPrecision.denominator, validated: adjudication.contradictionPrecision.numerator, precision: adjudication.contradictionPrecision, recall: adjudication.contradictionRecall },
      adjudication,
      operational: stratumOperations(selected.map((run) => run.input)) };
    });
  const preregistration = input.preregistration ?? { seeds: [], pairedMethod: "not_registered", frozenLabelVersion: "not_registered", blindedRubricVersion: "not_registered" };
  return {
    version: "story-continuity-evaluation-report-v1", corpusVersion: input.corpusVersion, strata, errors,
    preregistration: { scenarioCount: new Set(input.scenarios.map((scenario) => scenario.corpusScenarioId ?? scenario.id)).size, sampleCount: input.runs.length, ...preregistration },
    evidenceLayer: { fixtureEvidence: "deterministic", realExecutorIntegration: "not_run", liveProvider: "not_run", note: "This report is fixture-only. The real executor/PostgreSQL capture belongs to the separately run T01 integration fixture; neither result establishes live provider quality." }
  };
}

function stratumOperations(runs: readonly StoryContinuityRun[]) {
  const latencies = runs.flatMap((run) => run.latencyMs === undefined ? [] : [run.latencyMs]).sort((a, b) => a - b);
  const percentile = (value: number) => latencies.length ? latencies[Math.ceil(value * latencies.length) - 1]! : null;
  return { p50LatencyMs: percentile(0.5), p95LatencyMs: percentile(0.95),
    inputTokens: runs.reduce((sum, run) => sum + (run.usage?.inputTokens ?? 0), 0),
    outputTokens: runs.reduce((sum, run) => sum + (run.usage?.outputTokens ?? 0), 0),
    costUsd: runs.reduce((sum, run) => sum + (run.usage?.costUsd ?? 0), 0),
    extraProviderCalls: runs.reduce((sum, run) => sum + Math.max(0, (run.providerCalls ?? 1) - 1), 0),
    repairRate: wilsonInterval(runs.filter((run) => (run.repairCalls ?? 0) > 0).length, runs.length) };
}

function stratumMeasurements(runs: readonly StoryContinuityRun[], registration: StoryContinuityEvaluationInput["preregistration"]) {
  const labels = runs.flatMap((run) => run.adjudication ? [run.adjudication] : []);
  for (const label of labels) {
    if (label.blinded !== true || !label.assessorId.trim() || label.labelVersion !== registration?.frozenLabelVersion || label.rubricVersion !== registration?.blindedRubricVersion
      || [label.contradictionTruePositive, label.contradictionFalsePositive, label.contradictionFalseNegative].some((value) => !Number.isInteger(value) || value < 0)
      || !Number.isFinite(label.writingQuality) || label.writingQuality < 1 || label.writingQuality > 5
      || !Number.isFinite(label.directionCoverage) || label.directionCoverage < 0 || label.directionCoverage > 1) throw new Error("Independent adjudication must match the preregistered blinded rubric and valid counts.");
  }
  const count = (key: "contradictionTruePositive" | "contradictionFalsePositive" | "contradictionFalseNegative") => labels.reduce((sum, label) => sum + label[key], 0);
  const tp = count("contradictionTruePositive");
  // Missing labels are retained explicitly; no unlabelled output becomes a pass.
  return { status: labels.length === runs.length && labels.length ? "measured" as const : labels.length ? "partial" as const : "skipped" as const,
    labelled: labels.length, unlabelled: runs.length - labels.length,
    contradictionPrecision: wilsonInterval(tp, tp + count("contradictionFalsePositive")),
    contradictionRecall: wilsonInterval(tp, tp + count("contradictionFalseNegative")),
    semanticFalseBlocks: wilsonInterval(labels.filter((label) => label.semanticFalseBlock).length, labels.length),
    operationalFalseBlocks: wilsonInterval(labels.filter((label) => label.operationalFalseBlock).length, labels.length),
    completionRate: wilsonInterval(labels.filter((label) => label.completed).length, runs.length),
    writingQuality: labels.map((label) => label.writingQuality), directionCoverage: labels.map((label) => label.directionCoverage) };
}

export function wilsonInterval(numerator: number, denominator: number, z = 1.96): WilsonInterval {
  if (!Number.isInteger(numerator) || !Number.isInteger(denominator) || numerator < 0 || denominator < 0 || numerator > denominator) {
    throw new Error("Wilson numerator must be an integer from zero through its denominator.");
  }
  if (denominator === 0) return { lower: 0, upper: 0, numerator, denominator };
  const proportion = numerator / denominator;
  const z2 = z ** 2;
  const center = (proportion + z2 / (2 * denominator)) / (1 + z2 / denominator);
  const radius = (z * Math.sqrt((proportion * (1 - proportion) + z2 / (4 * denominator)) / denominator)) / (1 + z2 / denominator);
  return { lower: Math.max(0, center - radius), upper: Math.min(1, center + radius), numerator, denominator };
}

export type LiveConfiguration = Readonly<{
  explicitLive: true; providerId: string; providerModel: string; scenarioVersion: string; sourceCampaignId: string; copiedCampaignId: string;
  maxCalls: number; maxInputTokens: number; maxOutputTokens: number; maxCostUsd: number;
}>;

export function validateLiveConfiguration(value: Record<string, unknown>): LiveConfiguration {
  const missing: string[] = [];
  const text = (key: string): string => typeof value[key] === "string" && value[key].trim() ? value[key].trim() : (missing.push(key), "");
  if (value.explicitLive !== true) missing.push("--live");
  const providerId = text("providerId"); const providerModel = text("providerModel"); const scenarioVersion = text("scenarioVersion");
  const sourceCampaignId = text("sourceCampaignId"); const copiedCampaignId = text("copiedCampaignId");
  const number = (key: string, positive = true): number => typeof value[key] === "number" && Number.isFinite(value[key]) && (positive ? value[key] > 0 : value[key] >= 0) ? value[key] : (missing.push(key), 0);
  const maxCalls = number("maxCalls"); const maxInputTokens = number("maxInputTokens"); const maxOutputTokens = number("maxOutputTokens"); const maxCostUsd = number("maxCostUsd", false);
  if (![maxCalls, maxInputTokens, maxOutputTokens].every(Number.isInteger)) missing.push("integer call and token ceilings");
  if (sourceCampaignId && sourceCampaignId === copiedCampaignId) missing.push("copiedCampaignId must differ from sourceCampaignId");
  if (missing.length) {
    const labels: Record<string, string> = {
      providerId: "provider", providerModel: "provider model", scenarioVersion: "scenario version",
      sourceCampaignId: "source campaign", copiedCampaignId: "campaign copy", maxCalls: "maxCalls",
      maxInputTokens: "token ceiling", maxOutputTokens: "token ceiling", maxCostUsd: "cost ceiling"
    };
    throw new Error(`Live evaluation requires explicit ${[...new Set(missing.map((item) => labels[item] ?? item))].join(", ")}.`);
  }
  return { explicitLive: true, providerId, providerModel, scenarioVersion, sourceCampaignId, copiedCampaignId, maxCalls, maxInputTokens, maxOutputTokens, maxCostUsd };
}

export type PrivateArtifactManifest = Readonly<{
  version: "story-continuity-private-artifact-manifest-v1"; runId: string; sourceAuthorization: string; copiedDestination: string;
  privateArtifactDirectory: string; artifactPaths: readonly string[]; accessPolicy: string; issuedAt: string; expiresAt: string;
}>;

export function createPrivateArtifactManifest(input: Readonly<{
  runId: string; sourceAuthorization: string; copiedDestination: string; privateArtifactDirectory: string; artifactPaths: readonly string[];
  accessPolicy: string; issuedAt: string; retentionDays?: number;
}>): PrivateArtifactManifest {
  if (!input.runId.trim() || !input.sourceAuthorization.trim() || !input.copiedDestination.trim() || !input.accessPolicy.trim()) throw new Error("Private artifact manifests require run, authorization, destination, and access policy.");
  if (!isAbsolute(input.privateArtifactDirectory) || input.privateArtifactDirectory.toLocaleLowerCase("en-US").includes("public")) throw new Error("Private artifact directory must be an absolute non-public path.");
  const privateRoot = resolve(input.privateArtifactDirectory);
  if (!input.artifactPaths.every((value) => {
    if (!isAbsolute(value)) return false;
    const path = relative(privateRoot, resolve(value));
    return path !== "" && !path.startsWith("..") && !isAbsolute(path);
  })) throw new Error("Every artifact path must stay under the private artifact directory.");
  const issuedAt = new Date(input.issuedAt);
  if (Number.isNaN(issuedAt.valueOf())) throw new Error("Manifest issuedAt must be an ISO timestamp.");
  const retentionDays = input.retentionDays ?? 30;
  if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 365) throw new Error("Retention must be an explicit whole number from one to 365 days.");
  const expiresAt = new Date(issuedAt.valueOf() + retentionDays * 86_400_000).toISOString();
  return { version: "story-continuity-private-artifact-manifest-v1", runId: input.runId, sourceAuthorization: input.sourceAuthorization, copiedDestination: input.copiedDestination, privateArtifactDirectory: input.privateArtifactDirectory, artifactPaths: [...input.artifactPaths], accessPolicy: input.accessPolicy, issuedAt: issuedAt.toISOString(), expiresAt };
}
