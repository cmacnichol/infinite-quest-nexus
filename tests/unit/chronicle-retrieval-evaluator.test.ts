import { describe, expect, it, vi } from "vitest";
import {
  evaluateChronicleRetrieval,
  leakageCounts,
  percentile,
  recallAt,
  reciprocalRank,
  type ChronicleRetrievalApplication,
  type ChronicleRetrievalCorpus
} from "../../scripts/lib/chronicle-retrieval-evaluator.js";

const corpus: ChronicleRetrievalCorpus = {
  version: "v1",
  cases: [{
    id: "exact-reference",
    scope: {
      ownerUserId: "owner-a",
      campaignId: "campaign-a",
      worldVersionId: "world-version-a",
      request: { budgetTokens: 100, compression: "auto", query: "safe query", recentTurns: 2 }
    },
    expectedLabels: ["a", "b"],
    labelByMemoryId: { "memory-a": "a", "memory-b": "b", "memory-x": "x" }
  }]
};

describe("Chronicle retrieval evaluator metrics", () => {
  it("calculates rank metrics from hand-labelled results", () => {
    expect(recallAt(["a", "x", "b"], new Set(["a", "b"]), 2)).toBe(0.5);
    expect(reciprocalRank(["x", "b"], new Set(["b"]))).toBe(0.5);
    expect(leakageCounts([])).toEqual({ crossCampaign: 0, futureTurn: 0, supersededFact: 0 });
    expect(percentile([10, 20, 30, 40], 0.95)).toBe(40);
  });

  it("evaluates only through the generation context-preview seam", async () => {
    const buildContextPreview = vi.fn()
      .mockResolvedValue({
        retrieval: { mode: "hybrid", semanticAvailable: true },
        scopes: {
          chronicle: [
            { id: "memory-x", estimatedTokens: 2, relevance: 0.4, lexicalRelevance: 0.8, semanticRelevance: 0.1 },
            { id: "memory-a", estimatedTokens: 3, relevance: 0.9, lexicalRelevance: 0, semanticRelevance: 0.9 },
            { id: "memory-b", estimatedTokens: 4, relevance: 0.6, lexicalRelevance: 0.4, semanticRelevance: 0.3 }
          ]
        }
      });
    const generation: ChronicleRetrievalApplication["generation"] = new Proxy({ buildContextPreview }, {
      get(target, property, receiver) {
        if (property !== "buildContextPreview") {
          throw new Error(`The evaluator bypassed the public retrieval seam with ${String(property)}.`);
        }
        return Reflect.get(target, property, receiver);
      }
    });
    const application: ChronicleRetrievalApplication = { generation };

    const report = await evaluateChronicleRetrieval(
      application,
      { transaction: "caller-owned" },
      corpus,
      { implementation: "legacy_hybrid", now: vi.fn().mockReturnValueOnce(10).mockReturnValueOnce(30) }
    );

    expect(buildContextPreview).toHaveBeenCalledWith(
      { transaction: "caller-owned" },
      corpus.cases[0]!.scope
    );
    expect(report.metrics).toMatchObject({
      recallAt5: 1,
      recallAt10: 1,
      recallAt20: 1,
      mrr: 0.5,
      duplicateRate: 0,
      relevantMemoriesPerPromptToken: 2 / 9,
      leakageCounts: { crossCampaign: 0, futureTurn: 0, supersededFact: 0 },
      latencyMs: { p50: 20, p95: 20 },
      embedding: { requests: 1, cost: 0 },
      semanticOnlyHits: 1,
      promotions: 1,
      demotions: 1
    });
    expect(report.cases).toEqual([expect.objectContaining({
      id: "exact-reference",
      retrievedLabels: ["x", "a", "b"],
      ranks: { a: 2, b: 3 }
    })]);
  });
});
