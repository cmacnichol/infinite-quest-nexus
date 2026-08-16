import { createHash } from "node:crypto";
import type { MemoryGenerationContextPreviewScope, MemoryGenerationTransactionPort } from "../../packages/application/src/memory/index.js";
import type { ChronicleProductionRankFusionProfile } from "../../packages/domain/src/chronicle-rank-fusion.js";

export type ChronicleRetrievalApplication = Readonly<{
  generation: Pick<MemoryGenerationTransactionPort, "buildContextPreview">;
}>;

type ChroniclePreviewEntry = Readonly<{
  id: string;
  estimatedTokens?: number;
  relevance?: number | null;
  lexicalRelevance?: number | null;
  semanticRelevance?: number | null;
}>;

export type ChronicleRetrievalCase = Readonly<{
  id: string;
  scope: MemoryGenerationContextPreviewScope;
  expectedLabels: readonly string[];
  labelByMemoryId: Readonly<Record<string, string>>;
  forbiddenLabels?: Readonly<{
    crossCampaign?: readonly string[];
    futureTurn?: readonly string[];
    supersededFact?: readonly string[];
  }>;
  excludedLabels?: Readonly<Record<string, readonly string[]>>;
}>;

export type ChronicleRetrievalCorpus = Readonly<{
  version: string;
  cases: readonly ChronicleRetrievalCase[];
}>;

export type ChronicleEvaluationCaseResult = Readonly<{
  id: string;
  caseHash: string;
  expectedLabels: readonly string[];
  retrievedLabels: readonly string[];
  ranks: Readonly<Record<string, number | null>>;
  promptTokens: number;
  latencyMs: number;
  embeddingRequests: number;
  embeddingCost: number;
  semanticOnlyHits: number;
  promotions: number;
  demotions: number;
  leakage: Readonly<{ crossCampaign: number; futureTurn: number; supersededFact: number }>;
}>;

export type ChronicleEvaluationMetrics = Readonly<{
  recallAt5: number;
  recallAt10: number;
  recallAt20: number;
  mrr: number;
  ndcg: number;
  duplicateRate: number;
  relevantMemoriesPerPromptToken: number;
  leakageCounts: Readonly<{ crossCampaign: number; futureTurn: number; supersededFact: number }>;
  latencyMs: Readonly<{ p50: number; p95: number }>;
  embedding: Readonly<{ requests: number; cost: number }>;
  semanticOnlyHits: number;
  promotions: number;
  demotions: number;
}>;

export type ChronicleEvaluationReport = Readonly<{
  corpusVersion: string;
  corpusHash: string;
  implementation: string;
  cases: readonly ChronicleEvaluationCaseResult[];
  metrics: ChronicleEvaluationMetrics;
}>;

export type ChronicleRetrievalEvaluationOptions = Readonly<{
  implementation?: string;
  now?: () => number;
  corpusHash?: string;
}>;

export type ChronicleRetrievalProfileParameters = Readonly<{
  rrfK: number;
  semanticVariantWeight: number;
  lexicalEntityWeight: number;
  recencyChronologyWeight: number;
  candidateLimit: number;
}>;

export type ChronicleCalibrationCandidate = Readonly<{
  profile: ChronicleRetrievalProfileParameters;
  metrics: ChronicleEvaluationMetrics;
}>;

export type ChronicleRetrievalProfileV2 = ChronicleProductionRankFusionProfile & Readonly<{
  version: "chronicle-retrieval-profile-v2";
  corpusHash: string;
  metrics: ChronicleEvaluationMetrics;
  generatedAt: string;
}>;

const RRF_K_GRID = [20, 40, 60] as const;
const SEMANTIC_VARIANT_WEIGHT_GRID = [0.5, 0.75, 1] as const;
const LEXICAL_ENTITY_WEIGHT_GRID = [0.75, 1, 1.25] as const;
const RECENCY_CHRONOLOGY_WEIGHT_GRID = [0.25, 0.5, 0.75] as const;
const CANDIDATE_LIMIT_GRID = [32, 64, 96] as const;

export const CHRONICLE_RETRIEVAL_CALIBRATION_GRID: readonly ChronicleRetrievalProfileParameters[] = Object.freeze(
  RRF_K_GRID.flatMap((rrfK) => SEMANTIC_VARIANT_WEIGHT_GRID.flatMap((semanticVariantWeight) => (
    LEXICAL_ENTITY_WEIGHT_GRID.flatMap((lexicalEntityWeight) => RECENCY_CHRONOLOGY_WEIGHT_GRID.flatMap(
      (recencyChronologyWeight) => CANDIDATE_LIMIT_GRID.map((candidateLimit) => Object.freeze({
        rrfK,
        semanticVariantWeight,
        lexicalEntityWeight,
        recencyChronologyWeight,
        candidateLimit
      }))
    ))
  )))
);

type LeakCategory = keyof ReturnType<typeof emptyLeakage>;

function emptyLeakage() {
  return { crossCampaign: 0, futureTurn: 0, supersededFact: 0 };
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function deterministicChronicleEvaluationUuid(
  corpusVersion: string,
  caseId: string,
  role: string,
): string {
  const digest = hash({ corpusVersion, caseId, role });
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

function average(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function serializedProfile(profile: ChronicleRetrievalProfileParameters): string {
  return JSON.stringify(profile);
}

export function chronicleProductionRankFusionProfile(
  parameters: ChronicleRetrievalProfileParameters,
): ChronicleProductionRankFusionProfile {
  return Object.freeze({
    rrfK: parameters.rrfK,
    weights: Object.freeze({
      signals: Object.freeze({
        semantic: 1,
        full_text: parameters.lexicalEntityWeight,
        entity: parameters.lexicalEntityWeight,
        recency: parameters.recencyChronologyWeight,
        chronology: parameters.recencyChronologyWeight,
        importance: 1,
        kind: 1,
        temporal: 1
      }),
      variants: Object.freeze({
        action: 1,
        entity_expanded: parameters.semanticVariantWeight,
        scene: parameters.semanticVariantWeight,
        open_thread: parameters.semanticVariantWeight
      })
    }),
    candidateLimits: Object.freeze({ perSignal: parameters.candidateLimit }),
    diversityPolicy: Object.freeze({
      maximumParents: 16,
      maximumParentsPerTurn: 2,
      includeAdjacentNarration: true,
      semanticSimilarityPenalty: 4,
      kindDiversityBonus: 1,
      entityDiversityBonus: 0.5
    })
  });
}

function productionProfile(
  corpusHash: string,
  candidate: ChronicleCalibrationCandidate,
  generatedAt: string,
): ChronicleRetrievalProfileV2 {
  if (!/^[a-f0-9]{64}$/u.test(corpusHash)) {
    throw new Error("Chronicle retrieval corpus hash must be a lowercase SHA-256 digest.");
  }
  if (!Number.isFinite(Date.parse(generatedAt))) {
    throw new Error("Chronicle retrieval profile generation timestamp must be an ISO date.");
  }
  return Object.freeze({
    version: "chronicle-retrieval-profile-v2",
    corpusHash,
    ...chronicleProductionRankFusionProfile(candidate.profile),
    metrics: candidate.metrics,
    generatedAt
  });
}

export function chronicleRetrievalCorpusHash(corpus: ChronicleRetrievalCorpus): string {
  return hash(corpus);
}

export function chronicleProfilePassesGates(
  candidate: ChronicleEvaluationMetrics,
  legacy: ChronicleEvaluationMetrics,
): boolean {
  const leakage = candidate.leakageCounts;
  const maximumP95 = Math.max(legacy.latencyMs.p95 * 1.2, legacy.latencyMs.p95 + 25);
  return leakage.crossCampaign === 0
    && leakage.futureTurn === 0
    && leakage.supersededFact === 0
    && candidate.recallAt10 >= legacy.recallAt10
    && candidate.ndcg >= legacy.ndcg
    && candidate.duplicateRate <= legacy.duplicateRate
    && candidate.latencyMs.p95 <= maximumP95;
}

function compareCalibrationCandidates(
  left: ChronicleCalibrationCandidate,
  right: ChronicleCalibrationCandidate,
): number {
  return right.metrics.recallAt10 - left.metrics.recallAt10
    || right.metrics.ndcg - left.metrics.ndcg
    || right.metrics.relevantMemoriesPerPromptToken - left.metrics.relevantMemoriesPerPromptToken
    || left.metrics.embedding.requests - right.metrics.embedding.requests
    || left.metrics.latencyMs.p95 - right.metrics.latencyMs.p95
    || left.metrics.duplicateRate - right.metrics.duplicateRate
    || compareText(serializedProfile(left.profile), serializedProfile(right.profile));
}

export function selectChronicleRetrievalProfile(input: Readonly<{
  corpusHash: string;
  baselineMetrics: ChronicleEvaluationMetrics;
  candidates: readonly ChronicleCalibrationCandidate[];
  generatedAt: string;
}>): ChronicleRetrievalProfileV2 {
  const selected = input.candidates
    .filter((candidate) => chronicleProfilePassesGates(candidate.metrics, input.baselineMetrics))
    .sort(compareCalibrationCandidates)[0];
  if (!selected) {
    throw new Error("No Chronicle retrieval profile satisfied every calibration gate.");
  }
  return productionProfile(input.corpusHash, selected, input.generatedAt);
}

export async function calibrateChronicleRetrievalProfile(input: Readonly<{
  corpusHash: string;
  baselineMetrics: ChronicleEvaluationMetrics;
  generatedAt?: string;
  evaluate(profile: ChronicleRetrievalProfileParameters): Promise<ChronicleEvaluationMetrics>;
}>): Promise<ChronicleRetrievalProfileV2> {
  const candidates: ChronicleCalibrationCandidate[] = [];
  for (const profile of CHRONICLE_RETRIEVAL_CALIBRATION_GRID) {
    candidates.push({ profile, metrics: await input.evaluate(profile) });
  }
  return selectChronicleRetrievalProfile({
    corpusHash: input.corpusHash,
    baselineMetrics: input.baselineMetrics,
    candidates,
    generatedAt: input.generatedAt ?? new Date().toISOString()
  });
}

export function renderChronicleRetrievalProfileModule(profile: ChronicleRetrievalProfileV2): string {
  return `// Generated by pnpm evaluate:chronicle -- --calibrate. Do not edit by hand.\n`
    + `export const CHRONICLE_RETRIEVAL_PROFILE_V2 = Object.freeze(${JSON.stringify(profile, null, 2)} as const);\n`;
}

function readChronicleEntries(preview: unknown): readonly ChroniclePreviewEntry[] {
  if (!preview || typeof preview !== "object") return [];
  const scopes = (preview as { scopes?: unknown }).scopes;
  if (!scopes || typeof scopes !== "object") return [];
  const chronicle = (scopes as { chronicle?: unknown }).chronicle;
  if (!Array.isArray(chronicle)) return [];
  return chronicle.filter((entry): entry is ChroniclePreviewEntry => (
    Boolean(entry) && typeof entry === "object" && typeof (entry as { id?: unknown }).id === "string"
  ));
}

function safePreviewMetadata(preview: unknown): Readonly<{ semanticAvailable: boolean; embeddingCost: number }> {
  if (!preview || typeof preview !== "object") return { semanticAvailable: false, embeddingCost: 0 };
  const retrieval = (preview as { retrieval?: unknown }).retrieval;
  if (!retrieval || typeof retrieval !== "object") return { semanticAvailable: false, embeddingCost: 0 };
  const value = retrieval as { semanticAvailable?: unknown; embeddingCost?: unknown };
  return {
    semanticAvailable: value.semanticAvailable === true,
    embeddingCost: typeof value.embeddingCost === "number" && Number.isFinite(value.embeddingCost) ? value.embeddingCost : 0
  };
}

export function recallAt(rankedLabels: readonly string[], relevantLabels: ReadonlySet<string>, limit: number): number {
  if (relevantLabels.size === 0) return 1;
  const found = new Set(rankedLabels.slice(0, limit).filter((label) => relevantLabels.has(label)));
  return found.size / relevantLabels.size;
}

export function reciprocalRank(rankedLabels: readonly string[], relevantLabels: ReadonlySet<string>): number {
  const rank = rankedLabels.findIndex((label) => relevantLabels.has(label));
  return rank === -1 ? 0 : 1 / (rank + 1);
}

export function ndcgAt(rankedLabels: readonly string[], relevantLabels: ReadonlySet<string>, limit = 20): number {
  if (relevantLabels.size === 0) return 1;
  const actual = rankedLabels.slice(0, limit).reduce((sum, label, index) => (
    sum + (relevantLabels.has(label) ? 1 / Math.log2(index + 2) : 0)
  ), 0);
  const ideal = [...relevantLabels].slice(0, limit).reduce((sum, _label, index) => sum + 1 / Math.log2(index + 2), 0);
  return ideal === 0 ? 0 : actual / ideal;
}

export function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))]!;
}

export function leakageCounts(results: readonly Pick<ChronicleEvaluationCaseResult, "leakage">[]) {
  return results.reduce((total, result) => ({
    crossCampaign: total.crossCampaign + result.leakage.crossCampaign,
    futureTurn: total.futureTurn + result.leakage.futureTurn,
    supersededFact: total.supersededFact + result.leakage.supersededFact
  }), emptyLeakage());
}

function caseLeakage(retrievedLabels: readonly string[], fixture: ChronicleRetrievalCase) {
  const forbidden = fixture.forbiddenLabels ?? {};
  const result = emptyLeakage();
  for (const category of Object.keys(result) as LeakCategory[]) {
    const labels = new Set(forbidden[category] ?? []);
    result[category] = retrievedLabels.filter((label) => labels.has(label)).length;
  }
  return result;
}

function rankLabels(retrievedLabels: readonly string[], expectedLabels: readonly string[]) {
  return Object.fromEntries(expectedLabels.map((label) => {
    const index = retrievedLabels.indexOf(label);
    return [label, index === -1 ? null : index + 1];
  }));
}

function orderedRanks(entries: readonly ChroniclePreviewEntry[], score: (entry: ChroniclePreviewEntry) => number): ReadonlyMap<string, number> {
  return new Map(entries
    .map((entry, index) => ({ entry, index, score: score(entry) }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map(({ entry }, index) => [entry.id, index + 1]));
}

function rankingMovements(entries: readonly ChroniclePreviewEntry[]) {
  const lexicalRanks = orderedRanks(entries, (entry) => Number(entry.lexicalRelevance ?? 0));
  const selectedRanks = orderedRanks(entries, (entry) => Number(entry.relevance ?? entry.lexicalRelevance ?? 0));
  return entries.reduce((totals, entry) => {
    const lexicalRank = lexicalRanks.get(entry.id)!;
    const selectedRank = selectedRanks.get(entry.id)!;
    if (selectedRank < lexicalRank) totals.promotions += 1;
    if (selectedRank > lexicalRank) totals.demotions += 1;
    return totals;
  }, { promotions: 0, demotions: 0 });
}

export async function evaluateChronicleRetrieval(
  application: ChronicleRetrievalApplication,
  database: unknown,
  corpus: ChronicleRetrievalCorpus,
  options: ChronicleRetrievalEvaluationOptions = {},
): Promise<ChronicleEvaluationReport> {
  const now = options.now ?? Date.now;
  const cases: ChronicleEvaluationCaseResult[] = [];
  for (const fixture of corpus.cases) {
    const startedAt = now();
    const preview = await application.generation.buildContextPreview(database as never, fixture.scope);
    const latencyMs = Math.max(0, now() - startedAt);
    const entries = readChronicleEntries(preview);
    const retrievedLabels = entries.map((entry) => fixture.labelByMemoryId[entry.id] ?? `hash:${hash(entry.id).slice(0, 16)}`);
    const metadata = safePreviewMetadata(preview);
    const semanticOnlyHits = entries.filter((entry) => (
      Number(entry.semanticRelevance ?? 0) > 0 && Number(entry.lexicalRelevance ?? 0) <= 0
    )).length;
    const movements = rankingMovements(entries);
    cases.push({
      id: fixture.id,
      caseHash: hash({ id: fixture.id, expectedLabels: fixture.expectedLabels, labelByMemoryId: fixture.labelByMemoryId }),
      expectedLabels: fixture.expectedLabels,
      retrievedLabels,
      ranks: rankLabels(retrievedLabels, fixture.expectedLabels),
      promptTokens: entries.reduce((sum, entry) => sum + Math.max(0, Number(entry.estimatedTokens ?? 0)), 0),
      latencyMs,
      embeddingRequests: metadata.semanticAvailable ? 1 : 0,
      embeddingCost: metadata.embeddingCost,
      semanticOnlyHits,
      promotions: movements.promotions,
      demotions: movements.demotions,
      leakage: caseLeakage(retrievedLabels, fixture)
    });
  }

  const expectedSets = cases.map((result) => new Set(result.expectedLabels));
  const retrievedTotal = cases.reduce((sum, result) => sum + result.retrievedLabels.length, 0);
  const duplicateTotal = cases.reduce((sum, result) => sum + result.retrievedLabels.length - new Set(result.retrievedLabels).size, 0);
  const relevantSelected = cases.reduce((sum, result) => sum + result.retrievedLabels.filter(
    (label) => result.expectedLabels.includes(label)
  ).length, 0);
  const promptTokens = cases.reduce((sum, result) => sum + result.promptTokens, 0);
  return {
    corpusVersion: corpus.version,
    corpusHash: options.corpusHash ?? chronicleRetrievalCorpusHash(corpus),
    implementation: options.implementation ?? "legacy_hybrid",
    cases,
    metrics: {
      recallAt5: average(cases.map((result, index) => recallAt(result.retrievedLabels, expectedSets[index]!, 5))),
      recallAt10: average(cases.map((result, index) => recallAt(result.retrievedLabels, expectedSets[index]!, 10))),
      recallAt20: average(cases.map((result, index) => recallAt(result.retrievedLabels, expectedSets[index]!, 20))),
      mrr: average(cases.map((result, index) => reciprocalRank(result.retrievedLabels, expectedSets[index]!))),
      ndcg: average(cases.map((result, index) => ndcgAt(result.retrievedLabels, expectedSets[index]!))),
      duplicateRate: retrievedTotal === 0 ? 0 : duplicateTotal / retrievedTotal,
      relevantMemoriesPerPromptToken: promptTokens === 0 ? 0 : relevantSelected / promptTokens,
      leakageCounts: leakageCounts(cases),
      latencyMs: { p50: percentile(cases.map((result) => result.latencyMs), 0.5), p95: percentile(cases.map((result) => result.latencyMs), 0.95) },
      embedding: {
        requests: cases.reduce((sum, result) => sum + result.embeddingRequests, 0),
        cost: cases.reduce((sum, result) => sum + result.embeddingCost, 0)
      },
      semanticOnlyHits: cases.reduce((sum, result) => sum + result.semanticOnlyHits, 0),
      promotions: cases.reduce((sum, result) => sum + result.promotions, 0),
      demotions: cases.reduce((sum, result) => sum + result.demotions, 0)
    }
  };
}
