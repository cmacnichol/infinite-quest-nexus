import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CHRONICLE_RETRIEVAL_PROFILE_V2 } from "../../packages/domain/src/generated/chronicle-retrieval-profile-v2.js";
import {
  CHRONICLE_RETRIEVAL_CALIBRATION_GRID,
  calibrateChronicleRetrievalProfile,
  chronicleProfilePassesGates,
  chronicleRetrievalCorpusHash,
  renderChronicleRetrievalProfileModule,
  selectChronicleRetrievalProfile,
  type ChronicleCalibrationCandidate,
  type ChronicleEvaluationMetrics,
  type ChronicleRetrievalCorpus,
  type ChronicleRetrievalProfileParameters
} from "../../scripts/lib/chronicle-retrieval-evaluator.js";

const CORPUS_HASH = "1cd534c1585a81865572beb4fd7748e7ac817d248269a3c0c7ebcb93d415951f";
const GENERATED_AT = "2026-08-16T12:00:00.000Z";

function metrics(overrides: Partial<ChronicleEvaluationMetrics> = {}): ChronicleEvaluationMetrics {
  return {
    recallAt5: 0.8,
    recallAt10: 0.8,
    recallAt20: 0.8,
    mrr: 0.75,
    ndcg: 0.7,
    duplicateRate: 0.1,
    relevantMemoriesPerPromptToken: 0.08,
    leakageCounts: { crossCampaign: 0, futureTurn: 0, supersededFact: 0 },
    latencyMs: { p50: 50, p95: 100 },
    embedding: { requests: 4, cost: 0 },
    semanticOnlyHits: 2,
    promotions: 2,
    demotions: 1,
    ...overrides
  };
}

function candidate(
  profile: ChronicleRetrievalProfileParameters,
  overrides: Partial<ChronicleEvaluationMetrics> = {}
): ChronicleCalibrationCandidate {
  return { profile, metrics: metrics(overrides) };
}

describe("Chronicle retrieval profile calibration", () => {
  it("enumerates the exact deterministic 243-profile search grid", () => {
    expect(CHRONICLE_RETRIEVAL_CALIBRATION_GRID).toHaveLength(243);
    expect(new Set(CHRONICLE_RETRIEVAL_CALIBRATION_GRID.map((value) => JSON.stringify(value)))).toHaveLength(243);
    expect([...new Set(CHRONICLE_RETRIEVAL_CALIBRATION_GRID.map((value) => value.rrfK))]).toEqual([20, 40, 60]);
    expect([...new Set(CHRONICLE_RETRIEVAL_CALIBRATION_GRID.map((value) => value.semanticVariantWeight))])
      .toEqual([0.5, 0.75, 1]);
    expect([...new Set(CHRONICLE_RETRIEVAL_CALIBRATION_GRID.map((value) => value.lexicalEntityWeight))])
      .toEqual([0.75, 1, 1.25]);
    expect([...new Set(CHRONICLE_RETRIEVAL_CALIBRATION_GRID.map((value) => value.recencyChronologyWeight))])
      .toEqual([0.25, 0.5, 0.75]);
    expect([...new Set(CHRONICLE_RETRIEVAL_CALIBRATION_GRID.map((value) => value.candidateLimit))])
      .toEqual([32, 64, 96]);
  });

  it("rejects every quality, leakage, duplication, and latency gate independently", () => {
    const legacy = metrics();
    const allowedP95 = Math.max(legacy.latencyMs.p95 * 1.2, legacy.latencyMs.p95 + 25);
    expect(allowedP95).toBe(125);
    expect(chronicleProfilePassesGates(metrics(), legacy)).toBe(true);

    const rejected = [
      metrics({ leakageCounts: { crossCampaign: 1, futureTurn: 0, supersededFact: 0 } }),
      metrics({ leakageCounts: { crossCampaign: 0, futureTurn: 1, supersededFact: 0 } }),
      metrics({ leakageCounts: { crossCampaign: 0, futureTurn: 0, supersededFact: 1 } }),
      metrics({ recallAt10: 0.799999 }),
      metrics({ ndcg: 0.699999 }),
      metrics({ duplicateRate: 0.100001 }),
      metrics({ latencyMs: { p50: 50, p95: 125.001 } })
    ];
    for (const value of rejected) expect(chronicleProfilePassesGates(value, legacy)).toBe(false);
    expect(chronicleProfilePassesGates(metrics({ latencyMs: { p50: 50, p95: 125 } }), legacy)).toBe(true);
  });

  it("uses the prescribed metric priority and serialized profile as the final tie-breaker", () => {
    const [first, second] = CHRONICLE_RETRIEVAL_CALIBRATION_GRID;
    if (!first || !second) throw new Error("Expected at least two calibration profiles.");
    const legacy = metrics({ recallAt10: 0.5, ndcg: 0.5, duplicateRate: 0.5, latencyMs: { p50: 50, p95: 200 } });
    const base = metrics({ recallAt10: 0.8, ndcg: 0.8, duplicateRate: 0.2, relevantMemoriesPerPromptToken: 0.08, latencyMs: { p50: 40, p95: 100 }, embedding: { requests: 4, cost: 0 } });
    const cases: readonly Readonly<{
      left: Partial<ChronicleEvaluationMetrics>;
      right: Partial<ChronicleEvaluationMetrics>;
      selected: ChronicleRetrievalProfileParameters;
    }>[] = [
      { left: { ...base, recallAt10: 0.81 }, right: base, selected: first },
      { left: { ...base, ndcg: 0.81 }, right: base, selected: first },
      { left: { ...base, mrr: 0.76 }, right: base, selected: first },
      { left: { ...base, recallAt5: 0.81 }, right: base, selected: first },
      { left: { ...base, recallAt20: 0.81 }, right: base, selected: first },
      { left: { ...base, relevantMemoriesPerPromptToken: 0.081 }, right: base, selected: first },
      { left: { ...base, duplicateRate: 0.19 }, right: base, selected: first },
      { left: base, right: base, selected: first },
      // Quality-tied: a strictly better request count or latency must not decide the
      // profile, or cache warmth and wall-clock jitter would pick production ranking.
      { left: base, right: { ...base, embedding: { requests: 0, cost: 0 } }, selected: first },
      { left: base, right: { ...base, latencyMs: { p50: 1, p95: 1 } }, selected: first },
      // A genuine quality win still beats the serialized-profile tie-breaker.
      { left: base, right: { ...base, recallAt10: 0.81 }, selected: second }
    ];

    for (const value of cases) {
      expect(selectChronicleRetrievalProfile({
        corpusHash: CORPUS_HASH,
        baselineMetrics: legacy,
        candidates: [candidate(first, value.left), candidate(second, value.right)],
        generatedAt: GENERATED_AT
      }).rrfK).toBe(value.selected.rrfK);
      expect(selectChronicleRetrievalProfile({
        corpusHash: CORPUS_HASH,
        baselineMetrics: legacy,
        candidates: [candidate(first, value.left), candidate(second, value.right)],
        generatedAt: GENERATED_AT
      }).candidateLimits.perSignal).toBe(value.selected.candidateLimit);
    }
  });

  it("selects the same profile regardless of latency noise, cache warmth, and candidate order", () => {
    const legacy = metrics({ recallAt10: 0.5, ndcg: 0.5, duplicateRate: 0.5, latencyMs: { p50: 50, p95: 400 } });
    // Every candidate ties on quality, which is exactly the saturated case that let
    // measurement noise choose the production profile before this was made deterministic.
    const build = (seed: number) => CHRONICLE_RETRIEVAL_CALIBRATION_GRID.map((profile, index) => candidate(profile, {
      recallAt10: 0.9,
      ndcg: 0.9,
      mrr: 0.9,
      recallAt5: 0.9,
      recallAt20: 0.9,
      duplicateRate: 0,
      relevantMemoriesPerPromptToken: 0.1,
      latencyMs: { p50: (index * seed) % 40, p95: 100 + ((index * seed) % 200) },
      embedding: { requests: (index * seed) % 17, cost: 0 }
    }));
    const shuffle = (values: readonly ChronicleCalibrationCandidate[], seed: number) => (
      values.map((value, index) => ({ value, key: (index * seed) % values.length }))
        .sort((left, right) => left.key - right.key)
        .map((entry) => entry.value)
    );

    const selections = [1, 7, 13, 29].map((seed) => selectChronicleRetrievalProfile({
      corpusHash: CORPUS_HASH,
      baselineMetrics: legacy,
      candidates: shuffle(build(seed), seed),
      generatedAt: GENERATED_AT
    }));

    for (const selection of selections) {
      expect(JSON.stringify(selection)).toBe(JSON.stringify(selections[0]));
    }
  });

  it("fails rather than substituting defaults when no profile survives", async () => {
    await expect(calibrateChronicleRetrievalProfile({
      corpusHash: CORPUS_HASH,
      baselineMetrics: metrics(),
      generatedAt: GENERATED_AT,
      async evaluate() {
        return metrics({ leakageCounts: { crossCampaign: 1, futureTurn: 0, supersededFact: 0 } });
      }
    })).rejects.toThrow("No Chronicle retrieval profile satisfied every calibration gate.");
  });

  it("keeps the corpus discriminating rather than saturated at a perfect score", () => {
    const fixture = JSON.parse(readFileSync(
      "tests/fixtures/chronicle-retrieval-evaluation.v2.json",
      "utf8"
    )) as ChronicleRetrievalCorpus;
    const ranking = fixture.cases.filter((value) => (value.distractorCount ?? 0) > 0);

    // A corpus every candidate aces cannot order candidates, so calibration collapses onto
    // tie-breakers. Each ranking case must offer more plausible memories than prompt slots.
    expect(ranking.length).toBeGreaterThanOrEqual(10);
    for (const value of ranking) {
      expect(value.distractorCount ?? 0).toBeGreaterThanOrEqual(16);
      expect(value.scope.request.budgetTokens ?? 0).toBeGreaterThanOrEqual(4_096);
    }
    // Headroom on the primary selection key, so a better profile can still be measured.
    expect(CHRONICLE_RETRIEVAL_PROFILE_V2.metrics.recallAt10).toBeLessThan(1);
    expect(CHRONICLE_RETRIEVAL_PROFILE_V2.metrics.ndcg).toBeLessThan(1);
    // The k cutoffs must actually differ, or recall@k measures nothing.
    expect(CHRONICLE_RETRIEVAL_PROFILE_V2.metrics.recallAt20)
      .toBeGreaterThan(CHRONICLE_RETRIEVAL_PROFILE_V2.metrics.recallAt10);
  });

  it("renders a deterministic safe module and checks in a gated corpus-matched profile", () => {
    const fixture = JSON.parse(readFileSync(
      "tests/fixtures/chronicle-retrieval-evaluation.v2.json",
      "utf8"
    )) as ChronicleRetrievalCorpus;
    expect(chronicleRetrievalCorpusHash(fixture)).toBe(CORPUS_HASH);
    expect(CHRONICLE_RETRIEVAL_PROFILE_V2.corpusHash).toBe(CORPUS_HASH);
    expect(chronicleProfilePassesGates(CHRONICLE_RETRIEVAL_PROFILE_V2.metrics, metrics({
      recallAt10: 0.7352941176470589,
      ndcg: 0.7552612693115515,
      duplicateRate: 0,
      latencyMs: { p50: 6, p95: 20 }
    }))).toBe(true);
    const source = renderChronicleRetrievalProfileModule({
      ...CHRONICLE_RETRIEVAL_PROFILE_V2,
      generatedAt: GENERATED_AT
    });
    expect(source).toContain("export const CHRONICLE_RETRIEVAL_PROFILE_V2");
    expect(source).toContain(`\"generatedAt\": \"${GENERATED_AT}\"`);
    expect(source).not.toContain("safe query");
    expect(source).not.toContain("credential-value");
    expect(source).toBe(renderChronicleRetrievalProfileModule({
      ...CHRONICLE_RETRIEVAL_PROFILE_V2,
      generatedAt: GENERATED_AT
    }));
  });
});
