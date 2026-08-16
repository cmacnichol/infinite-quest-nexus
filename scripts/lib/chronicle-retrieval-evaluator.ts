import { createHash } from "node:crypto";
import type { MemoryGenerationContextPreviewScope, MemoryGenerationTransactionPort } from "../../packages/application/src/memory/index.js";

export type ChronicleRetrievalApplication = Readonly<{
  generation: Pick<MemoryGenerationTransactionPort, "buildContextPreview">;
}>;

type ChroniclePreviewEntry = Readonly<{
  id: string;
  estimatedTokens?: number;
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
  baselinePreview?: Readonly<{
    retrieval?: Readonly<{ mode?: string; semanticAvailable?: boolean; embeddingCost?: number }>;
    scopes?: Readonly<{ chronicle?: readonly ChroniclePreviewEntry[] }>;
  }>;
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

export type ChronicleEvaluationReport = Readonly<{
  corpusVersion: string;
  corpusHash: string;
  implementation: string;
  cases: readonly ChronicleEvaluationCaseResult[];
  metrics: Readonly<{
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
}>;

export type ChronicleRetrievalEvaluationOptions = Readonly<{
  implementation?: string;
  now?: () => number;
}>;

type LeakCategory = keyof ReturnType<typeof emptyLeakage>;

function emptyLeakage() {
  return { crossCampaign: 0, futureTurn: 0, supersededFact: 0 };
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function average(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
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
      promotions: 0,
      demotions: 0,
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
    corpusHash: hash(corpus),
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
