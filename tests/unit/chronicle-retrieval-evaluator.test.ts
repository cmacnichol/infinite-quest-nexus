import { describe, expect, it, vi } from "vitest";
import {
  deterministicChronicleEvaluationUuid,
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
        retrieval: { mode: "hybrid", semanticAvailable: true, embeddingRequests: 0 },
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
      embedding: { requests: 0, cost: 0 },
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

  it("preserves the legacy semantic request estimate when a preview omits the explicit counter", async () => {
    const report = await evaluateChronicleRetrieval({
      generation: {
        async buildContextPreview() {
          return { retrieval: { semanticAvailable: true }, scopes: { chronicle: [] } };
        }
      }
    }, {}, corpus, { now: vi.fn().mockReturnValue(10) });

    expect(report.metrics.embedding.requests).toBe(1);
    expect(report.cases[0]?.embeddingRequests).toBe(1);
  });

  it("keeps independently constructed evaluation identities, case hashes, and metrics repeatable", async () => {
    const memoryId = deterministicChronicleEvaluationUuid("v1", "repeatable", "memory:expected:0");
    expect(memoryId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/u);
    expect(deterministicChronicleEvaluationUuid("v1", "repeatable", "memory:expected:0")).toBe(memoryId);
    expect(deterministicChronicleEvaluationUuid("v1", "repeatable", "memory:expected:1")).not.toBe(memoryId);
    const buildCorpus = (): ChronicleRetrievalCorpus => ({
      version: "v1",
      cases: [{
        id: "repeatable",
        scope: {
          ownerUserId: "runtime-owner",
          campaignId: "runtime-campaign",
          worldVersionId: "runtime-world",
          request: { budgetTokens: 100, compression: "auto", query: "repeatable", recentTurns: 1 }
        },
        expectedLabels: ["repeatable-label"],
        labelByMemoryId: { [memoryId]: "repeatable-label" }
      }]
    });
    const evaluate = () => {
      const timestamps = [10, 20];
      return evaluateChronicleRetrieval({
        generation: {
          async buildContextPreview() {
            return {
              retrieval: { semanticAvailable: false },
              scopes: { chronicle: [{ id: memoryId, estimatedTokens: 2, relevance: 1 }] }
            };
          }
        }
      }, {}, buildCorpus(), { now: () => timestamps.shift() ?? 20 });
    };

    const first = await evaluate();
    const second = await evaluate();
    expect(second.cases.map((result) => result.caseHash)).toEqual(first.cases.map((result) => result.caseHash));
    expect(second.metrics).toEqual(first.metrics);
  });
});
