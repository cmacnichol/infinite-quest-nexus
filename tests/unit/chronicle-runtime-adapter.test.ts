import { describe, expect, it, vi } from "vitest";
import {
  createChronicleEmbeddingProviderPort,
  createChronicleWorkerExecutor
} from "../../services/runtime/src/chronicle-platform-adapter.js";
import { createChroniclePlatformBindings } from "../../services/runtime/src/chronicle-platform-bindings.js";
import { createChronicleClaimExecution } from "../../services/runtime/src/chronicle-worker-execution.js";
import {
  type ChronicleWorkerStatePort
} from "../../packages/application/src/memory/index.js";
import type { DatabaseClient, DatabasePool } from "../../packages/database/src/pool.js";

describe("Chronicle runtime adapters", () => {
  it("serializes heartbeats and joins the in-flight heartbeat before completion", async () => {
    vi.useFakeTimers();
    let finishExecution!: (progress: Readonly<Record<string, unknown>>) => void;
    let finishFirstHeartbeat!: (renewed: boolean) => void;
    let finishSecondHeartbeat!: (renewed: boolean) => void;
    const execution = new Promise<Readonly<Record<string, unknown>>>((resolve) => {
      finishExecution = resolve;
    });
    const firstHeartbeat = new Promise<boolean>((resolve) => {
      finishFirstHeartbeat = resolve;
    });
    const secondHeartbeat = new Promise<boolean>((resolve) => {
      finishSecondHeartbeat = resolve;
    });
    const claim = {
      jobId: "job-heartbeat-1",
      ownerUserId: "owner-1",
      campaignId: "campaign-1",
      worldVersionId: "world-version-1",
      jobType: "embed_campaign" as const,
      workVersion: 1,
      workerId: "worker-1",
      leaseSeconds: 3
    };
    const state = {
      claimNext: vi.fn().mockResolvedValue(claim),
      loadClaimedJob: vi.fn().mockResolvedValue(claim),
      heartbeatClaim: vi.fn()
        .mockResolvedValue(true)
        .mockReturnValueOnce(firstHeartbeat)
        .mockReturnValueOnce(secondHeartbeat),
      completeClaim: vi.fn().mockResolvedValue(true),
      requeueClaim: vi.fn(),
      failClaim: vi.fn()
    };
    const executor = createChronicleWorkerExecutor({
      state,
      retrieval: { loadForClaim: vi.fn().mockResolvedValue({
        config: { enabled: true }, memories: [], totalMemories: 0, batchLimit: 8, nextCursor: null
      }) },
      execution: { execute: vi.fn().mockReturnValue(execution) },
      logProviderTransportError: vi.fn()
    });

    try {
      const running = executor.runNextChronicle({
        workerId: "worker-1", leaseSeconds: 3, retrieval: { batchLimit: 8 }
      });
      await vi.advanceTimersByTimeAsync(1_000);

      expect(state.heartbeatClaim).toHaveBeenCalledWith(claim);
      expect(state.completeClaim).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(state.heartbeatClaim).toHaveBeenCalledTimes(1);

      finishFirstHeartbeat(true);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(state.heartbeatClaim).toHaveBeenCalledTimes(2);

      finishExecution({ embedded: 1, total: 1 });
      await vi.advanceTimersByTimeAsync(0);
      expect(state.completeClaim).not.toHaveBeenCalled();
      finishSecondHeartbeat(true);
      await expect(running).resolves.toBe(true);
      expect(state.completeClaim).toHaveBeenCalledWith(claim, {
        progress: { embedded: 1, total: 1 }
      });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["false", "rejection"] as const)(
    "surfaces heartbeat %s as lease loss through the execution lifecycle",
    async (heartbeatFailure) => {
      vi.useFakeTimers();
      const claim = {
        jobId: `job-heartbeat-${heartbeatFailure}`,
        ownerUserId: "owner-1",
        campaignId: "campaign-1",
        worldVersionId: "world-version-1",
        jobType: "embed_campaign" as const,
        workVersion: 1,
        workerId: "worker-1",
        leaseSeconds: 3
      };
      let executionLifecycle: Readonly<{
        leaseLost: boolean;
        throwIfLeaseLost(): void;
        waitForLeaseLoss(): Promise<Error>;
      }> | undefined;
      const state = {
        claimNext: vi.fn().mockResolvedValue(claim),
        loadClaimedJob: vi.fn().mockResolvedValue(claim),
        heartbeatClaim: vi.fn().mockImplementation(() => heartbeatFailure === "false"
          ? Promise.resolve(false)
          : Promise.reject(new Error("heartbeat transport failed"))),
        completeClaim: vi.fn().mockResolvedValue(true),
        requeueClaim: vi.fn(),
        failClaim: vi.fn().mockResolvedValue(true)
      };
      const logProviderTransportError = vi.fn();
      const executor = createChronicleWorkerExecutor({
        state,
        retrieval: { loadForClaim: vi.fn().mockResolvedValue({
          config: { enabled: true }, memories: [], totalMemories: 0, batchLimit: 8, nextCursor: null
        }) },
        execution: { execute: vi.fn((_claim, _retrieval, lifecycle) => {
          executionLifecycle = lifecycle;
          return lifecycle!.waitForLeaseLoss().then((error: Error) => Promise.reject(error));
        }) },
        logProviderTransportError
      });

      try {
        const running = executor.runNextChronicle({
          workerId: "worker-1", leaseSeconds: 3, retrieval: { batchLimit: 8 }
        });
        await vi.advanceTimersByTimeAsync(1_000);

        expect(executionLifecycle?.leaseLost).toBe(true);
        expect(() => executionLifecycle?.throwIfLeaseLost()).toThrow("Chronicle job lease heartbeat was lost.");
        await expect(running).resolves.toBe(true);
        expect(state.completeClaim).not.toHaveBeenCalled();
        expect(state.failClaim).toHaveBeenCalledWith(claim, {
          diagnosticCode: "chronicle_execution_failed"
        });
        expect(logProviderTransportError).toHaveBeenCalledWith(
          expect.objectContaining({ message: "Chronicle job lease heartbeat was lost." }),
          expect.objectContaining({ chronicleJobId: claim.jobId })
        );
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    }
  );

  it("joins an in-flight heartbeat before failing an execution", async () => {
    vi.useFakeTimers();
    let finishHeartbeat!: (renewed: boolean) => void;
    let failExecution!: (error: Error) => void;
    const claim = {
      jobId: "job-heartbeat-failed-execution",
      ownerUserId: "owner-1",
      campaignId: "campaign-1",
      worldVersionId: "world-version-1",
      jobType: "embed_campaign" as const,
      workVersion: 1,
      workerId: "worker-1",
      leaseSeconds: 3
    };
    const heartbeat = new Promise<boolean>((resolve) => {
      finishHeartbeat = resolve;
    });
    const execution = new Promise<Readonly<Record<string, unknown>>>((_resolve, reject) => {
      failExecution = reject;
    });
    const state = {
      claimNext: vi.fn().mockResolvedValue(claim),
      loadClaimedJob: vi.fn().mockResolvedValue(claim),
      heartbeatClaim: vi.fn().mockReturnValue(heartbeat),
      completeClaim: vi.fn(),
      requeueClaim: vi.fn(),
      failClaim: vi.fn().mockResolvedValue(true)
    };
    const executor = createChronicleWorkerExecutor({
      state,
      retrieval: { loadForClaim: vi.fn().mockResolvedValue({
        config: { enabled: true }, memories: [], totalMemories: 0, batchLimit: 8, nextCursor: null
      }) },
      execution: { execute: vi.fn().mockReturnValue(execution) },
      logProviderTransportError: vi.fn()
    });

    try {
      const running = executor.runNextChronicle({
        workerId: "worker-1", leaseSeconds: 3, retrieval: { batchLimit: 8 }
      });
      await vi.advanceTimersByTimeAsync(1_000);
      failExecution(new Error("provider failed"));
      await vi.advanceTimersByTimeAsync(0);
      expect(state.failClaim).not.toHaveBeenCalled();

      finishHeartbeat(true);
      await expect(running).resolves.toBe(true);
      expect(state.failClaim).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["false", "rejection"] as const)(
    "preserves healthy provider state when a late heartbeat %s loses the lease",
    async (heartbeatFailure) => {
      vi.useFakeTimers();
      const claim = {
        jobId: `job-late-heartbeat-${heartbeatFailure}`,
        ownerUserId: "owner-1",
        campaignId: "campaign-1",
        worldVersionId: "world-version-1",
        jobType: "embed_campaign" as const,
        workVersion: 1,
        workerId: "worker-1",
        leaseSeconds: 3
      };
      let releaseHealthyWrite!: () => void;
      let markHealthyWriteStarted!: () => void;
      const healthyWriteStarted = new Promise<void>((resolve) => {
        markHealthyWriteStarted = resolve;
      });
      const healthyWriteHeld = new Promise<void>((resolve) => {
        releaseHealthyWrite = resolve;
      });
      const providerHealth = { status: "degraded", consecutiveFailures: 2 };
      const recordHealth = vi.fn(async (
        _pool: unknown,
        _scope: unknown,
        healthy: boolean,
      ) => {
        if (healthy) {
          providerHealth.status = "healthy";
          providerHealth.consecutiveFailures = 0;
          markHealthyWriteStarted();
          await healthyWriteHeld;
          return;
        }
        providerHealth.consecutiveFailures += 1;
        providerHealth.status = providerHealth.consecutiveFailures >= 3 ? "unavailable" : "degraded";
      });
      const state = {
        claimNext: vi.fn().mockResolvedValue(claim),
        loadClaimedJob: vi.fn().mockResolvedValue(null),
        heartbeatClaim: vi.fn().mockImplementation(() => heartbeatFailure === "false"
          ? Promise.resolve(false)
          : Promise.reject(new Error("late heartbeat transport failure"))),
        completeClaim: vi.fn().mockResolvedValue(true),
        requeueClaim: vi.fn(),
        failClaim: vi.fn()
      };
      const execution = createChronicleClaimExecution({} as never, {
        retrieval: { loadForClaim: vi.fn() },
        embeddings: {
          resolve: vi.fn(),
          load: vi.fn().mockResolvedValue({
            id: "provider-1",
            model: "embed-v1",
            providerType: "openai",
            baseUrl: "https://example.test"
          }),
          fingerprint: vi.fn().mockResolvedValue("fingerprint"),
          embed: vi.fn().mockResolvedValue({
            embeddings: [[0.1]], responseId: "response", usage: {}, reportedCost: null
          }),
          recordHealth,
          recordCost: vi.fn(),
          logDiagnostic: vi.fn()
        },
        batches: { commitClaimBatch: vi.fn().mockResolvedValue(true) },
        generation: {
          autoEnableCampaignEmbedding: vi.fn(),
          buildContextPreview: vi.fn(),
          storeDerivedTurnMemories: vi.fn(),
          writeAcceptedTurnFiction: vi.fn(),
          rebuildCampaignMemories: vi.fn(),
          enqueueEmbeddingReindex: vi.fn(),
          enqueueChunkIndex: vi.fn()
        },

      });
      const logProviderTransportError = vi.fn();
      const executor = createChronicleWorkerExecutor({
        state,
        retrieval: { loadForClaim: vi.fn().mockResolvedValue({
          config: {
            enabled: true,
            providerProfileId: "provider-1",
            model: "embed-v1",
            batchSize: 1
          },
          memories: [{ id: "11111111-1111-4111-8111-111111111111", content: "First memory" }],
          totalMemories: 1,
          batchLimit: 1,
          nextCursor: null
        }) },
        execution,
        logProviderTransportError
      });

      try {
        const running = executor.runNextChronicle({
          workerId: "worker-1", leaseSeconds: 3, retrieval: { batchLimit: 1 }
        });
        await healthyWriteStarted;
        expect(providerHealth).toEqual({ status: "healthy", consecutiveFailures: 0 });

        await vi.advanceTimersByTimeAsync(1_000);
        releaseHealthyWrite();
        await expect(running).resolves.toBe(true);

        expect(providerHealth).toEqual({ status: "healthy", consecutiveFailures: 0 });
        expect(recordHealth).toHaveBeenCalledTimes(1);
        expect(state.completeClaim).toHaveBeenCalledOnce();
        expect(state.completeClaim).toHaveBeenCalledWith(claim, {
          progress: { retryReason: "work_version_changed" }
        });
        expect(state.failClaim).not.toHaveBeenCalled();
        expect(logProviderTransportError).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    }
  );

  it("loads and fingerprints an embedding provider through the exact caller database context", async () => {
    const load = vi.fn().mockResolvedValue({
      id: "embedding-profile",
      model: "embed-v1",
      providerType: "openai-compatible",
      configuration: { dimensions: 768 },
      embed: vi.fn(),
    });
    const resolveEmbeddingProvider = vi.fn().mockResolvedValue({
      status: "resolved",
      resolutionSource: "dedicated_embedding",
      resolvedRole: "embedding",
      providerProfileId: "embedding-profile",
      providerType: "openai-compatible",
      model: "embed-v1"
    });
    const database = { transaction: "accepted-turn" } as never;
    const port = createChronicleEmbeddingProviderPort({
      loadEmbeddingExecution: load,
      recordProviderHealth: vi.fn(),
      recordProfileCost: vi.fn(),
      logProviderTransportError: vi.fn(),
      resolveEmbeddingProvider
    });

    const provider = await port.load(database, {
      ownerUserId: "owner-1",
      providerProfileId: "embedding-profile",
      model: "embed-v1"
    });

    expect(provider).toMatchObject({
      id: "embedding-profile",
      model: "embed-v1",
      providerType: "openai-compatible"
    });
    expect(load).toHaveBeenCalledWith(
      "owner-1",
      "embedding-profile",
      "embed-v1"
    );
    expect(load.mock.calls[0]).not.toContain("image");
    await expect(port.resolve(database, {
      ownerUserId: "owner-1", campaignId: "campaign-1", model: "campaign-configured-model"
    }))
      .resolves.toEqual({
        status: "resolved",
        resolutionSource: "dedicated_embedding",
        resolvedRole: "embedding",
        providerProfileId: "embedding-profile",
        providerType: "openai-compatible",
        model: "campaign-configured-model"
      });
    expect(resolveEmbeddingProvider).toHaveBeenCalledWith(
      database, "owner-1", "campaign-1", null, "campaign-configured-model"
    );
    const prefixes = { documentPrefix: "search_document: ", queryPrefix: "search_query: ", automatic: true };
    await expect(port.fingerprint(provider, prefixes)).resolves.toEqual(expect.stringMatching(/^[a-f0-9]{64}$/));
  });

  it("projects only reviewed embedding capability values into Chronicle provider execution", async () => {
    const bindings = createChroniclePlatformBindings({
      resolution: {
        resolveEmbedding: vi.fn().mockResolvedValue({
          status: "resolved", providerProfileId: "embedding-profile", resolvedRole: "embedding", model: "embed-v1"
        })
      },
      execution: {
        embedding: vi.fn().mockResolvedValue({
          id: "embedding-profile",
          model: "embed-v1",
          providerType: "openai_compatible",
          contextWindowTokens: 16_384,
          requestTimeoutMs: 30_000,
          configuration: {
            embeddingMaxInputTokens: 1_024,
            embeddingDimensions: 768,
            apiKey: "must-not-project"
          },
          embed: vi.fn()
        })
      },
      health: { recordHealth: vi.fn() },
      costs: { recordChronicleCost: vi.fn() },
      costContext: vi.fn()
    } as never);

    const provider = await bindings.embeddings.load({} as never, {
      ownerUserId: "owner-1",
      providerProfileId: "embedding-profile",
      model: "embed-v1"
    });

    expect(provider).toMatchObject({
      id: "embedding-profile",
      model: "embed-v1",
      configuration: { embeddingMaxInputTokens: 1_024, embeddingDimensions: 768 }
    });
    expect(JSON.stringify(provider)).not.toContain("must-not-project");
  });

  it("preserves dedicated, text-fallback, and unconfigured embedding resolution provenance", async () => {
    const resolveEmbedding = vi.fn()
      .mockResolvedValueOnce({
        status: "resolved",
        requestedRole: "embedding",
        source: "dedicated_embedding",
        resolvedRole: "embedding",
        providerProfileId: "embedding-profile",
        providerType: "openrouter",
        model: "embed-model"
      })
      .mockResolvedValueOnce({
        status: "resolved",
        requestedRole: "embedding",
        source: "text_fallback",
        resolvedRole: "text",
        providerProfileId: "text-profile",
        providerType: "openrouter",
        model: "text-model"
      })
      .mockResolvedValueOnce({
        status: "unconfigured",
        requestedRole: "embedding",
        source: "none",
        resolvedRole: null
      });
    const bindings = createChroniclePlatformBindings({
      resolution: { resolveEmbedding },
      execution: { embedding: vi.fn() },
      health: { recordHealth: vi.fn() },
      costs: { recordChronicleCost: vi.fn() },
      costContext: vi.fn()
    } as never);
    const database = { transaction: "accepted-turn" } as never;
    const scope = {
      ownerUserId: "owner-1",
      campaignId: "campaign-1",
      model: "campaign-configured-model"
    };

    await expect(bindings.embeddings.resolve(database, scope)).resolves.toEqual({
      status: "resolved",
      resolutionSource: "dedicated_embedding",
      resolvedRole: "embedding",
      providerProfileId: "embedding-profile",
      providerType: "openrouter",
      model: "campaign-configured-model"
    });
    await expect(bindings.embeddings.resolve(database, scope)).resolves.toEqual({
      status: "resolved",
      resolutionSource: "text_fallback",
      resolvedRole: "text",
      providerProfileId: "text-profile",
      providerType: "openrouter",
      model: "campaign-configured-model"
    });
    await expect(bindings.embeddings.resolve(database, scope)).resolves.toEqual({
      status: "unconfigured",
      resolutionSource: "none",
      resolvedRole: null
    });
    expect(resolveEmbedding).toHaveBeenNthCalledWith(1, {
      ownerUserId: "owner-1",
      selectedProviderProfileId: null,
      model: "campaign-configured-model",
      allowTextFallback: true
    });
  });

  it("turns provider failures into private diagnostics while the worker lease is safely failed", async () => {
    const state = {
      claimNext: vi.fn().mockResolvedValue({
        jobId: "job-1", ownerUserId: "owner-1", campaignId: "campaign-1", worldVersionId: "world-version-1",
        jobType: "embed_campaign", workVersion: 1, workerId: "worker-1", leaseSeconds: 30
      }),
      loadClaimedJob: vi.fn(),
      heartbeatClaim: vi.fn(),
      completeClaim: vi.fn(),
      requeueClaim: vi.fn(),
      failClaim: vi.fn().mockResolvedValue(true)
    };
    const logProviderTransportError = vi.fn();
    const executor = createChronicleWorkerExecutor({
      state,
      retrieval: { loadForClaim: vi.fn().mockResolvedValue({ config: { enabled: true }, memories: [], batchLimit: 8, nextCursor: null }) },
      execution: { execute: vi.fn().mockRejectedValue(new Error("https://embedding.example/token=private")) },
      logProviderTransportError
    });

    await expect(executor.runNextChronicle({
      workerId: "worker-1", leaseSeconds: 30, retrieval: { batchLimit: 8 }
    })).resolves.toBe(true);

    expect(state.failClaim).toHaveBeenCalledWith(expect.objectContaining({ jobId: "job-1" }), {
      diagnosticCode: "chronicle_execution_failed"
    });
    expect(logProviderTransportError).toHaveBeenCalledWith(expect.any(Error), expect.objectContaining({
      chronicleJobId: "job-1", campaignId: "campaign-1"
    }));
  });

  it("terminalizes a claimed job when bounded retrieval fails before dispatch", async () => {
    let durableStatus: "queued" | "running" | "failed" = "queued";
    const claim = {
      jobId: "job-retrieval-1",
      ownerUserId: "owner-1",
      campaignId: "campaign-1",
      worldVersionId: "world-version-1",
      jobType: "embed_campaign" as const,
      workVersion: 1,
      workerId: "worker-1",
      leaseSeconds: 30
    };
    const state: ChronicleWorkerStatePort = {
      claimNext: async () => {
        durableStatus = "running";
        return claim;
      },
      loadClaimedJob: async () => claim,
      heartbeatClaim: async () => true,
      completeClaim: async () => false,
      requeueClaim: async () => false,
      failClaim: async (failedClaim) => {
        if (durableStatus !== "running" || failedClaim.jobId !== claim.jobId) return false;
        durableStatus = "failed";
        return true;
      }
    };
    const executor = createChronicleWorkerExecutor({
      state,
      retrieval: {
        loadForClaim: async () => {
          throw new Error("database connection interrupted");
        }
      },
      execution: { execute: async () => {
        throw new Error("dispatch must not run after retrieval failure");
      } },
      logProviderTransportError: () => undefined
    });

    await expect(executor.runNextChronicle({
      workerId: "worker-1", leaseSeconds: 30, retrieval: { batchLimit: 8 }
    })).resolves.toBe(true);
    expect(durableStatus).toBe("failed");
  });

  it("requeues newer work through the guarded completion transition after a stale claim fails", async () => {
    const claim = {
      jobId: "job-stale-1",
      ownerUserId: "owner-1",
      campaignId: "campaign-1",
      worldVersionId: "world-version-1",
      jobType: "embed_campaign" as const,
      workVersion: 1,
      workerId: "worker-1",
      leaseSeconds: 30
    };
    const state = {
      claimNext: vi.fn().mockResolvedValue(claim),
      loadClaimedJob: vi.fn().mockResolvedValue(null),
      heartbeatClaim: vi.fn(),
      completeClaim: vi.fn().mockResolvedValue(true),
      requeueClaim: vi.fn(),
      failClaim: vi.fn()
    };
    const logProviderTransportError = vi.fn();
    const executor = createChronicleWorkerExecutor({
      state,
      retrieval: { loadForClaim: vi.fn().mockResolvedValue({
        config: { enabled: true }, memories: [], totalMemories: 0, batchLimit: 8, nextCursor: null
      }) },
      execution: { execute: vi.fn().mockRejectedValue(new Error("Chronicle job lease was lost during embedding batch commit.")) },
      logProviderTransportError
    });

    await expect(executor.runNextChronicle({
      workerId: "worker-1", leaseSeconds: 30, retrieval: { batchLimit: 8 }
    })).resolves.toBe(true);
    expect(state.completeClaim).toHaveBeenCalledWith(claim, {
      progress: { retryReason: "work_version_changed" }
    });
    expect(state.failClaim).not.toHaveBeenCalled();
    expect(logProviderTransportError).not.toHaveBeenCalled();
  });

  it("records embedding health and cost through the supplied caller transaction", async () => {
    const transaction = { transaction: "accepted-turn" } as never;
    const recordProviderHealth = vi.fn().mockResolvedValue(undefined);
    const recordProfileCost = vi.fn().mockResolvedValue("cost-1");
    const port = createChronicleEmbeddingProviderPort({
      loadEmbeddingExecution: vi.fn(),
      resolveEmbeddingProvider: vi.fn(),
      recordProviderHealth,
      recordProfileCost,
      logProviderTransportError: vi.fn()
    });
    const provider = {
      id: "embedding-profile",
      model: "embed-v1",
      providerType: "openai-compatible"
    };
    const result = { embeddings: [[0.1, 0.2]], responseId: "response-1", usage: { inputTokens: 4 }, reportedCost: null };

    await port.recordHealth(
      transaction,
      { ownerUserId: "owner-1", providerProfileId: provider.id, model: provider.model },
      false,
      "private endpoint failure"
    );
    await expect(port.recordCost(transaction, provider, {
      ownerUserId: "owner-1",
      campaignId: "campaign-1",
      generationJobId: "generation-1",
      operation: "retrieval_embedding"
    }, result)).resolves.toBe("cost-1");

    expect(recordProviderHealth).toHaveBeenCalledWith(
      transaction,
      "owner-1",
      "embedding-profile",
      false,
      "private endpoint failure"
    );
    expect(recordProfileCost).toHaveBeenCalledWith(transaction, provider, {
      ownerUserId: "owner-1",
      campaignId: "campaign-1",
      generationJobId: "generation-1",
      operation: "retrieval_embedding"
    }, result);
  });

});
