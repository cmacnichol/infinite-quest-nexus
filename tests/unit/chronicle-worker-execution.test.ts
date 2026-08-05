import { describe, expect, it, vi } from "vitest";
import { createChronicleClaimExecution } from "../../services/runtime/src/chronicle-worker-execution.js";

const claim = {
  jobId: "job-1",
  ownerUserId: "owner-1",
  campaignId: "campaign-1",
  worldVersionId: "world-1",
  jobType: "embed_campaign" as const,
  workVersion: 3,
  workerId: "worker-1",
  leaseSeconds: 30
};

const provider = {
  id: "provider-1",
  model: "embed-v1",
  providerType: "openai",
  baseUrl: "https://example.test"
};

function firstPage(nextCursor: string | null = null) {
  return {
    config: { enabled: true, providerProfileId: "provider-1", model: "embed-v1", batchSize: 1 },
    memories: [{ id: "11111111-1111-4111-8111-111111111111", content: "First memory" }],
    totalMemories: nextCursor ? 2 : 1,
    batchLimit: 1,
    nextCursor
  };
}

function dependencies(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    retrieval: { loadForClaim: vi.fn() },
    embeddings: {
      load: vi.fn().mockResolvedValue(provider),
      fingerprint: vi.fn().mockResolvedValue("fingerprint"),
      embed: vi.fn().mockResolvedValue({ embeddings: [[0.1]], responseId: "response", usage: {}, reportedCost: null }),
      recordHealth: vi.fn().mockResolvedValue(undefined)
    },
    batches: { commitClaimBatch: vi.fn().mockResolvedValue(true) },
    generation: {
      rebuildCampaignMemories: vi.fn(),
      enqueueEmbeddingReindex: vi.fn()
    },
    credentialSecret: "secret",
    ...overrides
  } as never;
}

describe("createChronicleClaimExecution", () => {
  it("commits every bounded embedding page through the guarded claim-batch port", async () => {
    const loadForClaim = vi.fn().mockResolvedValue({
      ...firstPage(),
      memories: [{ id: "22222222-2222-4222-8222-222222222222", content: "Second memory" }],
      totalMemories: 2
    });
    const commitClaimBatch = vi.fn().mockResolvedValue(true);
    const execution = createChronicleClaimExecution({} as never, dependencies({
      retrieval: { loadForClaim },
      batches: { commitClaimBatch }
    }));

    await expect(execution.execute(claim, firstPage("1:11111111-1111-4111-8111-111111111111")))
      .resolves.toEqual({ embedded: 2, skipped: 0, total: 2 });

    expect(loadForClaim).toHaveBeenCalledOnce();
    expect(loadForClaim).toHaveBeenCalledWith(claim, {
      batchLimit: 1,
      cursor: "1:11111111-1111-4111-8111-111111111111"
    });
    expect(commitClaimBatch).toHaveBeenCalledTimes(2);
    expect(commitClaimBatch.mock.calls.map(([, input]) => input.processed)).toEqual([1, 2]);
    expect(commitClaimBatch.mock.calls.map(([, input]) => input.total)).toEqual([2, 2]);
  });

  it("stops immediately when the guarded batch commit reports a lost lease", async () => {
    const loadForClaim = vi.fn();
    const embed = vi.fn().mockResolvedValue({ embeddings: [[0.1]], responseId: "response", usage: {}, reportedCost: null });
    const execution = createChronicleClaimExecution({} as never, dependencies({
      retrieval: { loadForClaim },
      embeddings: {
        load: vi.fn().mockResolvedValue(provider),
        fingerprint: vi.fn().mockResolvedValue("fingerprint"),
        embed,
        recordHealth: vi.fn().mockResolvedValue(undefined)
      },
      batches: { commitClaimBatch: vi.fn().mockResolvedValue(false) }
    }));

    await expect(execution.execute(claim, firstPage("next-page")))
      .rejects.toThrow("Chronicle job lease was lost during embedding batch commit.");
    expect(embed).toHaveBeenCalledOnce();
    expect(loadForClaim).not.toHaveBeenCalled();
  });

  it("records a fixed unhealthy diagnostic without sending raw provider errors to health state", async () => {
    const recordHealth = vi.fn().mockResolvedValue(undefined);
    const execution = createChronicleClaimExecution({} as never, dependencies({
      embeddings: {
        load: vi.fn().mockResolvedValue(provider),
        fingerprint: vi.fn().mockResolvedValue("fingerprint"),
        embed: vi.fn().mockRejectedValue(new Error("https://private.example/token=secret")),
        recordHealth
      }
    }));

    await expect(execution.execute(claim, firstPage())).rejects.toThrow("token=secret");
    expect(recordHealth).toHaveBeenCalledWith(
      expect.anything(),
      { ownerUserId: "owner-1", providerProfileId: "provider-1", model: "embed-v1" },
      false,
      "chronicle_embedding_failed"
    );
    expect(JSON.stringify(recordHealth.mock.calls)).not.toContain("private.example");
  });

  it("rebuilds and enqueues embedding work on the same caller-owned transaction", async () => {
    const database = {
      query: vi.fn().mockResolvedValue({ rows: [] }),
      release: vi.fn()
    };
    const pool = { connect: vi.fn().mockResolvedValue(database) };
    const rebuildCampaignMemories = vi.fn().mockResolvedValue(4);
    const enqueueEmbeddingReindex = vi.fn().mockResolvedValue("embedding-job");
    const execution = createChronicleClaimExecution(pool as never, dependencies({
      generation: { rebuildCampaignMemories, enqueueEmbeddingReindex }
    }));
    const rebuildClaim = { ...claim, jobType: "reindex_campaign" as const };

    await expect(execution.execute(rebuildClaim, {
      config: { enabled: false }, memories: [], totalMemories: 0, batchLimit: 1, nextCursor: null
    })).resolves.toEqual({ rebuilt: 4 });

    expect(rebuildCampaignMemories).toHaveBeenCalledWith(database, rebuildClaim);
    expect(enqueueEmbeddingReindex).toHaveBeenCalledWith(database, rebuildClaim);
    expect(database.query.mock.calls.map(([sql]) => sql)).toEqual(["BEGIN", "COMMIT"]);
    expect(database.release).toHaveBeenCalledOnce();
  });
});
