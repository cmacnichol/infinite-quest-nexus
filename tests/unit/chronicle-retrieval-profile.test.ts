import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CHRONICLE_RETRIEVAL_PROFILE_V2 } from "../../packages/domain/src/generated/chronicle-retrieval-profile-v2.js";
import {
  assertCorpusResultInvariants,
  calibrationMetricsIfCorpusInvariantsHold
} from "../../scripts/evaluate-chronicle-retrieval.js";
import {
  CHRONICLE_RETRIEVAL_CALIBRATION_GRID,
  calibrateChronicleRetrievalProfile,
  chronicleProfilePassesGates,
  chronicleRetrievalCorpusHash,
  renderChronicleRetrievalProfileModule,
  selectChronicleRetrievalProfile,
  type ChronicleCalibrationCandidate,
  type ChronicleEvaluationCaseResult,
  type ChronicleEvaluationMetrics,
  type ChronicleEvaluationReport,
  type ChronicleRetrievalCorpus,
  type ChronicleRetrievalProfileParameters
} from "../../scripts/lib/chronicle-retrieval-evaluator.js";

const CORPUS_HASH = "4ce28d185827a5f932ab6b8cb4c8be97dfe0de483aed86e574c64522e85074f4";
const GENERATED_AT = "2026-08-16T12:00:00.000Z";
const V3_LEGACY_BASELINE_GATE_METRICS = Object.freeze({
  recallAt10: 0.675,
  ndcg: 0.6613147192765458,
  duplicateRate: 0,
  latencyMs: { p50: 6, p95: 17 }
});

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

function invariantCase(
  id: string,
  expectedLabels: readonly string[],
  promptTokens: number,
): ChronicleEvaluationCaseResult {
  return {
    id,
    caseHash: id,
    expectedLabels,
    retrievedLabels: expectedLabels,
    ranks: Object.fromEntries(expectedLabels.map((label) => [label, 1])),
    promptTokens,
    latencyMs: 0,
    embeddingRequests: 0,
    embeddingCost: 0,
    semanticOnlyHits: 0,
    promotions: 0,
    demotions: 0,
    leakage: { crossCampaign: 0, futureTurn: 0, supersededFact: 0 }
  };
}

function reportSatisfyingLongParentInvariants(corpus: ChronicleRetrievalCorpus): ChronicleEvaluationReport {
  const longParentCases = corpus.cases.filter((value) => value.longParent);
  return {
    corpusVersion: corpus.version,
    corpusHash: chronicleRetrievalCorpusHash(corpus),
    implementation: "chunked_hybrid",
    metrics: metrics(),
    cases: [
      ...longParentCases.map((value) => invariantCase(
        value.id,
        value.expectedLabels,
        value.scope.request.budgetTokens ?? 0,
      )),
      invariantCase("superseded-fact", [
        "superseded-fact-memory",
        "superseded-fact-canonical-replacement"
      ], 0)
    ]
  };
}

describe("Chronicle retrieval profile calibration", () => {
  it("enumerates the exact deterministic 567-profile coordinate search grid", () => {
    expect(CHRONICLE_RETRIEVAL_CALIBRATION_GRID).toHaveLength(567);
    expect(new Set(CHRONICLE_RETRIEVAL_CALIBRATION_GRID.map((value) => JSON.stringify(value)))).toHaveLength(567);
    expect([...new Set(CHRONICLE_RETRIEVAL_CALIBRATION_GRID.map((value) => value.rrfK))]).toEqual([20, 40, 60]);
    expect([...new Set(CHRONICLE_RETRIEVAL_CALIBRATION_GRID.map((value) => value.entityExpandedVariantWeight))])
      .toEqual([1, 0.5, 0.75]);
    expect([...new Set(CHRONICLE_RETRIEVAL_CALIBRATION_GRID.map((value) => value.sceneVariantWeight))])
      .toEqual([1, 0.5, 0.75]);
    expect([...new Set(CHRONICLE_RETRIEVAL_CALIBRATION_GRID.map((value) => value.openThreadVariantWeight))])
      .toEqual([1, 0.5, 0.75]);
    expect([...new Set(CHRONICLE_RETRIEVAL_CALIBRATION_GRID.map((value) => value.lexicalEntityWeight))])
      .toEqual([0.75, 1, 1.25]);
    expect([...new Set(CHRONICLE_RETRIEVAL_CALIBRATION_GRID.map((value) => value.recencyChronologyWeight))])
      .toEqual([0.25, 0.5, 0.75]);
    expect([...new Set(CHRONICLE_RETRIEVAL_CALIBRATION_GRID.map((value) => value.candidateLimit))])
      .toEqual([16, 32, 64]);

    expect(CHRONICLE_RETRIEVAL_CALIBRATION_GRID).toContainEqual({
      rrfK: 20,
      entityExpandedVariantWeight: 0.5,
      sceneVariantWeight: 1,
      openThreadVariantWeight: 1,
      lexicalEntityWeight: 0.75,
      recencyChronologyWeight: 0.25,
      candidateLimit: 16
    });
    expect(CHRONICLE_RETRIEVAL_CALIBRATION_GRID).toContainEqual({
      rrfK: 20,
      entityExpandedVariantWeight: 1,
      sceneVariantWeight: 0.5,
      openThreadVariantWeight: 1,
      lexicalEntityWeight: 0.75,
      recencyChronologyWeight: 0.25,
      candidateLimit: 16
    });
    expect(CHRONICLE_RETRIEVAL_CALIBRATION_GRID).toContainEqual({
      rrfK: 20,
      entityExpandedVariantWeight: 1,
      sceneVariantWeight: 1,
      openThreadVariantWeight: 0.5,
      lexicalEntityWeight: 0.75,
      recencyChronologyWeight: 0.25,
      candidateLimit: 16
    });
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

    const selectedProfiles = selections.map(({ metrics: _metrics, ...profile }) => JSON.stringify(profile));
    for (const selection of selectedProfiles) {
      expect(selection).toBe(selectedProfiles[0]);
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

  it("does not select candidates excluded by evaluator invariants", async () => {
    const accepted = CHRONICLE_RETRIEVAL_CALIBRATION_GRID[0];
    if (!accepted) throw new Error("Expected a calibration profile.");

    const selected = await calibrateChronicleRetrievalProfile({
      corpusHash: CORPUS_HASH,
      baselineMetrics: metrics(),
      generatedAt: GENERATED_AT,
      async evaluate(profile) {
        return profile === accepted ? metrics() : null;
      }
    });

    expect(selected.rrfK).toBe(accepted.rrfK);
    expect(selected.candidateLimits.perSignal).toBe(accepted.candidateLimit);
  });

  it("continues calibration after the production callback excludes a long-parent violation", async () => {
    const corpus = JSON.parse(readFileSync(
      "tests/fixtures/chronicle-retrieval-evaluation.v3.json",
      "utf8"
    )) as ChronicleRetrievalCorpus;
    const compliantReport = reportSatisfyingLongParentInvariants(corpus);
    const missingLabel = "long-parent-budget-1024-a";
    const invalidReport: ChronicleEvaluationReport = {
      ...compliantReport,
      cases: compliantReport.cases.map((value) => value.id === "long-parent-budget-1024" ? {
        ...value,
        retrievedLabels: [],
        ranks: { ...value.ranks, [missingLabel]: null }
      } : value)
    };
    const accepted = CHRONICLE_RETRIEVAL_CALIBRATION_GRID[0];
    if (!accepted) throw new Error("Expected a calibration profile.");
    let evaluations = 0;

    const selected = await calibrateChronicleRetrievalProfile({
      corpusHash: CORPUS_HASH,
      baselineMetrics: metrics(),
      generatedAt: GENERATED_AT,
      async evaluate(profile) {
        evaluations += 1;
        return calibrationMetricsIfCorpusInvariantsHold(
          profile === accepted ? compliantReport : invalidReport,
          corpus
        );
      }
    });

    expect(evaluations).toBe(CHRONICLE_RETRIEVAL_CALIBRATION_GRID.length);
    expect(selected.rrfK).toBe(accepted.rrfK);
    expect(selected.candidateLimits.perSignal).toBe(accepted.candidateLimit);
  });

  it("rejects calibration when a long-parent expected label is absent", async () => {
    const corpus = JSON.parse(readFileSync(
      "tests/fixtures/chronicle-retrieval-evaluation.v3.json",
      "utf8"
    )) as ChronicleRetrievalCorpus;
    const report = reportSatisfyingLongParentInvariants(corpus);
    const missingLabel = "long-parent-budget-1024-a";
    const missingLabelReport: ChronicleEvaluationReport = {
      ...report,
      cases: report.cases.map((value) => value.id === "long-parent-budget-1024" ? {
        ...value,
        retrievedLabels: [],
        ranks: { ...value.ranks, [missingLabel]: null }
      } : value)
    };

    await expect(calibrateChronicleRetrievalProfile({
      corpusHash: CORPUS_HASH,
      baselineMetrics: metrics(),
      generatedAt: GENERATED_AT,
      async evaluate() {
        assertCorpusResultInvariants(missingLabelReport, corpus);
        return metrics();
      }
    })).rejects.toThrow("long-parent-budget-1024");
  });

  it("rejects calibration when a long-parent result leaks across a protected boundary", async () => {
    const corpus = JSON.parse(readFileSync(
      "tests/fixtures/chronicle-retrieval-evaluation.v3.json",
      "utf8"
    )) as ChronicleRetrievalCorpus;
    const report = reportSatisfyingLongParentInvariants(corpus);
    const leakedReport: ChronicleEvaluationReport = {
      ...report,
      cases: report.cases.map((value) => value.id === "long-parent-budget-2048" ? {
        ...value,
        leakage: { crossCampaign: 1, futureTurn: 0, supersededFact: 0 }
      } : value)
    };

    await expect(calibrateChronicleRetrievalProfile({
      corpusHash: CORPUS_HASH,
      baselineMetrics: metrics(),
      generatedAt: GENERATED_AT,
      async evaluate() {
        assertCorpusResultInvariants(leakedReport, corpus);
        return metrics();
      }
    })).rejects.toThrow("long-parent-budget-2048");
  });

  it("rejects calibration when a long-parent result exceeds its token budget", async () => {
    const corpus = JSON.parse(readFileSync(
      "tests/fixtures/chronicle-retrieval-evaluation.v3.json",
      "utf8"
    )) as ChronicleRetrievalCorpus;
    const report = reportSatisfyingLongParentInvariants(corpus);
    const overBudgetReport: ChronicleEvaluationReport = {
      ...report,
      cases: report.cases.map((value) => value.id === "long-parent-budget-4096" ? {
        ...value,
        promptTokens: 4_097
      } : value)
    };

    await expect(calibrateChronicleRetrievalProfile({
      corpusHash: CORPUS_HASH,
      baselineMetrics: metrics(),
      generatedAt: GENERATED_AT,
      async evaluate() {
        assertCorpusResultInvariants(overBudgetReport, corpus);
        return metrics();
      }
    })).rejects.toThrow("long-parent-budget-4096");
  });

  it("keeps the corpus discriminating rather than saturated at a perfect score", () => {
    const fixture = JSON.parse(readFileSync(
      "tests/fixtures/chronicle-retrieval-evaluation.v3.json",
      "utf8"
    )) as ChronicleRetrievalCorpus;
    const longParentCases = fixture.cases.filter((value) => value.longParent);
    const ordinaryRankingCases = fixture.cases.filter((value) => !value.longParent && (value.distractorCount ?? 0) > 0);

    // A corpus every candidate aces cannot order candidates, so calibration collapses onto
    // tie-breakers. Each ranking case must offer more plausible memories than prompt slots.
    expect(ordinaryRankingCases.length).toBeGreaterThanOrEqual(10);
    for (const value of ordinaryRankingCases) {
      expect(value.distractorCount ?? 0).toBeGreaterThanOrEqual(16);
      expect(value.scope.request.budgetTokens ?? 0).toBeGreaterThanOrEqual(4_096);
    }
    expect(longParentCases).toHaveLength(3);
    expect(longParentCases.map((value) => value.scope.request.budgetTokens)).toEqual([1_024, 2_048, 4_096]);
    for (const value of longParentCases) expect(value.distractorCount ?? 0).toBeGreaterThanOrEqual(16);
    // Headroom on the primary selection key, so a better profile can still be measured.
    expect(CHRONICLE_RETRIEVAL_PROFILE_V2.metrics.recallAt10).toBeLessThan(1);
    expect(CHRONICLE_RETRIEVAL_PROFILE_V2.metrics.ndcg).toBeLessThan(1);
    // The k cutoffs must actually differ, or recall@k measures nothing.
    expect(CHRONICLE_RETRIEVAL_PROFILE_V2.metrics.recallAt20)
      .toBeGreaterThan(CHRONICLE_RETRIEVAL_PROFILE_V2.metrics.recallAt10);
  });

  it("renders a deterministic safe module and checks in a gated corpus-matched profile", () => {
    const fixture = JSON.parse(readFileSync(
      "tests/fixtures/chronicle-retrieval-evaluation.v3.json",
      "utf8"
    )) as ChronicleRetrievalCorpus;
    expect(chronicleRetrievalCorpusHash(fixture)).toBe(CORPUS_HASH);
    expect(CHRONICLE_RETRIEVAL_PROFILE_V2.corpusHash).toBe(CORPUS_HASH);
    const v3LegacyBaseline = metrics(V3_LEGACY_BASELINE_GATE_METRICS);
    expect(chronicleProfilePassesGates(CHRONICLE_RETRIEVAL_PROFILE_V2.metrics, v3LegacyBaseline)).toBe(true);
    expect(chronicleProfilePassesGates({
      ...CHRONICLE_RETRIEVAL_PROFILE_V2.metrics,
      latencyMs: { p50: 6, p95: 43 }
    }, v3LegacyBaseline)).toBe(false);
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
