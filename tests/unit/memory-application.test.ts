import { describe, expect, it, vi } from "vitest";
import {
  createMemoryApplication,
  createMemoryWorkerApplication,
  type MemoryApplicationDependencies,
  type MemoryWorkerApplicationDependencies
} from "../../packages/application/src/memory/index.js";

const scope = {
  ownerUserId: "owner-1",
  campaignId: "campaign-1",
  worldVersionId: "world-version-1"
} as const;

describe("MemoryApplication", () => {
  it("delegates owner-scoped API operations without exposing raw failures", async () => {
    const publicFailure = { code: "memory_unavailable", message: "Chronicle memory is unavailable." } as const;
    const dependencies: MemoryApplicationDependencies = {
      configuration: {
        getEmbeddingConfig: vi.fn().mockResolvedValue({ enabled: false }),
        setEmbeddingConfig: vi.fn().mockResolvedValue({ enabled: true })
      },
      queries: {
        getMetrics: vi.fn().mockResolvedValue({ failure: publicFailure }),
        previewContext: vi.fn().mockResolvedValue({ failure: publicFailure })
      },
      jobs: {
        enqueueChronicleReindex: vi.fn().mockResolvedValue({ jobId: "chronicle-1", status: "queued" }),
        enqueueEmbeddingReindex: vi.fn().mockResolvedValue({ jobId: "embedding-1", status: "queued" }),
        getJob: vi.fn().mockResolvedValue({ id: "chronicle-1", status: "failed", failure: publicFailure })
      },
      transaction: {
        autoEnableCampaignEmbedding: vi.fn().mockResolvedValue({ enabled: true }),
        enqueueEmbeddingReindex: vi.fn().mockResolvedValue("embedding-1"),
        rebuildCampaignMemories: vi.fn().mockResolvedValue(3),
        storeDerivedTurnMemories: vi.fn().mockResolvedValue(undefined),
        writeAcceptedTurnFiction: vi.fn().mockResolvedValue(undefined)
      }
    };
    const application = createMemoryApplication(dependencies);

    await expect(application.getEmbeddingConfig(scope)).resolves.toEqual({ enabled: false });
    await expect(application.getMetrics(scope)).resolves.toEqual({ failure: publicFailure });
    await expect(application.previewContext(scope, {
      budgetTokens: 32_000,
      compression: "auto",
      query: "safe action",
      recentTurns: 8
    })).resolves.toEqual({ failure: publicFailure });
    await expect(application.enqueueChronicleReindex(scope)).resolves.toEqual({ jobId: "chronicle-1", status: "queued" });
    await expect(application.getJob({ ownerUserId: scope.ownerUserId, jobId: "chronicle-1" })).resolves.toEqual({
      id: "chronicle-1", status: "failed", failure: publicFailure
    });

    expect(dependencies.configuration.getEmbeddingConfig).toHaveBeenCalledWith(scope);
    expect(dependencies.queries.getMetrics).toHaveBeenCalledWith(scope);
    expect(dependencies.jobs.getJob).toHaveBeenCalledWith({ ownerUserId: scope.ownerUserId, jobId: "chronicle-1" });
  });

  it("keeps all five generation memory operations on the caller-owned transaction", async () => {
    const transaction = { transactionId: "outer-transaction" };
    const callbacks = {
      autoEnableCampaignEmbedding: vi.fn().mockResolvedValue({ enabled: true }),
      enqueueEmbeddingReindex: vi.fn().mockResolvedValue("embedding-1"),
      rebuildCampaignMemories: vi.fn().mockResolvedValue(2),
      storeDerivedTurnMemories: vi.fn().mockResolvedValue(undefined),
      writeAcceptedTurnFiction: vi.fn().mockResolvedValue(undefined)
    };
    const application = createMemoryApplication({
      configuration: { getEmbeddingConfig: vi.fn(), setEmbeddingConfig: vi.fn() },
      queries: { getMetrics: vi.fn(), previewContext: vi.fn() },
      jobs: { enqueueChronicleReindex: vi.fn(), enqueueEmbeddingReindex: vi.fn(), getJob: vi.fn() },
      transaction: callbacks
    });

    await application.generation.autoEnableCampaignEmbedding(transaction, scope);
    await application.generation.enqueueEmbeddingReindex(transaction, scope);
    await application.generation.rebuildCampaignMemories(transaction, scope);
    await application.generation.storeDerivedTurnMemories(transaction, {
      ...scope,
      turnId: "turn-1",
      ordinal: 1,
      derived: { continuitySummary: "safe fiction" }
    });
    await application.generation.writeAcceptedTurnFiction(transaction, {
      ...scope,
      turnId: "turn-1",
      ordinal: 1,
      action: "safe action",
      narration: "safe narration"
    });

    for (const callback of Object.values(callbacks)) {
      expect(callback).toHaveBeenCalledWith(transaction, expect.anything());
    }
  });
});

describe("MemoryWorkerApplication", () => {
  it("delegates claim, lease, requeue, rebuild, and retrieval ports with a claimed scope", async () => {
    const dependencies: MemoryWorkerApplicationDependencies = {
      state: {
        claimNext: vi.fn().mockResolvedValue({
          jobId: "chronicle-1", ownerUserId: "owner-1", campaignId: "campaign-1", worldVersionId: "world-version-1",
          jobType: "embed_campaign", workVersion: 1, workerId: "worker-1", leaseSeconds: 30
        }),
        loadClaimedJob: vi.fn().mockResolvedValue(null),
        heartbeatClaim: vi.fn().mockResolvedValue(true),
        completeClaim: vi.fn().mockResolvedValue(true),
        failClaim: vi.fn().mockResolvedValue(true),
        requeueClaim: vi.fn().mockResolvedValue(true)
      },
      retrieval: { loadForClaim: vi.fn().mockResolvedValue({ config: { enabled: true }, memories: [] }) },
      executor: { runClaimed: vi.fn().mockResolvedValue(true) }
    };
    const worker = createMemoryWorkerApplication(dependencies);
    const claim = await worker.claimNext({ workerId: "worker-1", leaseSeconds: 30 });

    expect(claim?.ownerUserId).toBe("owner-1");
    if (!claim) throw new Error("test fixture did not claim a job");
    await worker.heartbeatClaim(claim);
    await worker.requeueClaim(claim, { reason: "work_version_changed" });
    await worker.runClaimed(claim);
    expect(dependencies.executor.runClaimed).toHaveBeenCalledWith(claim);
  });
});
