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

const CORPUS_HASH = "f1942b9d57c5d45aadc02922c80aa5c7915071d75945c9d63bb2c170917631ed";
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
      { left: { ...base, relevantMemoriesPerPromptToken: 0.081 }, right: base, selected: first },
      { left: { ...base, embedding: { requests: 3, cost: 10 } }, right: base, selected: first },
      { left: { ...base, latencyMs: { p50: 90, p95: 99 } }, right: base, selected: first },
      { left: { ...base, duplicateRate: 0.19 }, right: base, selected: first },
      { left: base, right: base, selected: first }
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

  it("renders a deterministic safe module and checks in a gated corpus-matched profile", () => {
    const fixture = JSON.parse(readFileSync(
      "tests/fixtures/chronicle-retrieval-evaluation.v1.json",
      "utf8"
    )) as ChronicleRetrievalCorpus;
    expect(chronicleRetrievalCorpusHash(fixture)).toBe(CORPUS_HASH);
    expect(CHRONICLE_RETRIEVAL_PROFILE_V2.corpusHash).toBe(CORPUS_HASH);
    expect(chronicleProfilePassesGates(CHRONICLE_RETRIEVAL_PROFILE_V2.metrics, metrics({
      recallAt10: 0.9117647058823529,
      ndcg: 0.9317318575468456,
      duplicateRate: 0,
      latencyMs: { p50: 6, p95: 19 }
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
