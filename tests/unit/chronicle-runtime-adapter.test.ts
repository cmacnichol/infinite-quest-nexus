import { describe, expect, it, vi } from "vitest";
import {
  createChronicleEmbeddingProviderPort,
  createChronicleWorkerExecutor
} from "../../services/runtime/src/chronicle-platform-adapter.js";
import {
  createChroniclePlatformBindings,
  resolveChronicleEmbeddingProviderId
} from "../../services/runtime/src/chronicle-platform-bindings.js";
import { createChronicleClaimExecution } from "../../services/runtime/src/chronicle-worker-execution.js";
import {
  createApiMemoryApplication
} from "../../services/runtime/src/memory-composition.js";
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
          enqueueEmbeddingReindex: vi.fn()
        },
        credentialSecret: "secret"
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

  it("selects a dedicated enabled embedding profile before text and never queries image roles", async () => {
    const roles: string[] = [];
    const database = {
      query: vi.fn(async (sql: string, values: readonly unknown[]) => {
        roles.push(sql);
        if (sql.includes("provider_role = 'embedding'")) {
          return { rows: [{ id: "embedding-profile", is_default: true }] };
        }
        throw new Error(`Unexpected fallback query: ${sql} ${JSON.stringify(values)}`);
      })
    } as unknown as DatabaseClient;

    await expect(resolveChronicleEmbeddingProviderId(database, {
      ownerUserId: "owner-1",
      campaignId: "campaign-1",
      selectedProviderProfileId: "text-profile"
    })).resolves.toBe("embedding-profile");
    expect(roles.join("\n")).not.toMatch(/provider_role = 'image'|provider_role IN \([^)]*image/i);
    expect(roles).toHaveLength(1);
  });

  it("uses an enabled text profile only when no dedicated embedding profile is enabled", async () => {
    const sqlStatements: string[] = [];
    const database = {
      query: vi.fn(async (sql: string) => {
        sqlStatements.push(sql);
        if (sql.includes("provider_role = 'embedding'")) return { rows: [] };
        if (sql.includes("provider_role = 'text'") && sql.includes("id = $1")) {
          return { rows: [{ id: "text-profile" }] };
        }
        throw new Error(`Unexpected query: ${sql}`);
      })
    } as unknown as DatabaseClient;

    await expect(resolveChronicleEmbeddingProviderId(database, {
      ownerUserId: "owner-1",
      campaignId: "campaign-1",
      selectedProviderProfileId: "text-profile"
    })).resolves.toBe("text-profile");
    expect(sqlStatements.join("\n")).not.toMatch(/provider_role = 'image'|provider_role IN \([^)]*image/i);
  });

  it("binds profile selection to the caller database without a captured pool fallback", async () => {
    const database = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("provider_role = 'embedding'")) {
          return { rows: [{ id: "embedding-profile", is_default: true }] };
        }
        throw new Error(`Unexpected query: ${sql}`);
      })
    } as unknown as DatabaseClient;
    const bindings = createChroniclePlatformBindings();

    await expect(bindings.embeddings.resolve(database, {
      ownerUserId: "owner-1",
      campaignId: "campaign-1"
    })).resolves.toBe("embedding-profile");
    expect(database.query).toHaveBeenCalledOnce();
  });

  it("composes a direct generation transaction port that never falls back to the repository pool", async () => {
    const poolQuery = vi.fn(() => {
      throw new Error("repository pool fallback was used");
    });
    const pool = { query: poolQuery } as unknown as DatabasePool;
    const caller = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("FROM campaigns")) return { rows: [{ world_version_id: "world-version-1" }] };
        if (sql.includes("SELECT default_model FROM provider_profiles")) return { rows: [{ default_model: "embed-v1" }] };
        if (sql.includes("INSERT INTO campaign_memory_configs")) return { rows: [{
          embedding_enabled: true,
          embedding_provider_profile_id: "embedding-profile",
          embedding_model: "embed-v1",
          embedding_batch_size: 16,
          embedding_document_prefix: null,
          embedding_query_prefix: null
        }] };
        if (sql.includes("INSERT INTO chronicle_jobs")) return { rows: [{ id: "embedding-job-1" }] };
        throw new Error(`Unexpected caller SQL: ${sql}`);
      })
    } as unknown as DatabaseClient;
    const application = createApiMemoryApplication(pool, {
      credentialSecret: "credential-secret",
      embeddings: {
        resolve: async (database: DatabaseClient) => {
          expect(database).toBe(caller);
          return "embedding-profile";
        }
      } as never
    });

    await expect(application.generation.autoEnableCampaignEmbedding(caller, {
      ownerUserId: "owner-1",
      campaignId: "campaign-1",
      worldVersionId: "world-version-1"
    })).resolves.toMatchObject({ enabled: true, providerProfileId: "embedding-profile" });
    expect(poolQuery).not.toHaveBeenCalled();
  });

  it("binds the runtime embedding platform by default in API composition", async () => {
    const poolQuery = vi.fn(async () => {
      throw new Error("repository pool fallback was used");
    });
    const pool = { query: poolQuery } as unknown as DatabasePool;
    const caller = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("FROM campaigns") && !sql.includes("provider_profiles")) {
          return { rows: [{ world_version_id: "world-version-1" }] };
        }
        if (sql.includes("provider_role = 'embedding'")) {
          return { rows: [{ id: "embedding-profile", is_default: true }] };
        }
        if (sql.includes("SELECT default_model FROM provider_profiles")) {
          return { rows: [{ default_model: "embed-v1" }] };
        }
        if (sql.includes("INSERT INTO campaign_memory_configs")) return { rows: [{
          embedding_enabled: true,
          embedding_provider_profile_id: "embedding-profile",
          embedding_model: "embed-v1",
          embedding_batch_size: 16,
          embedding_document_prefix: null,
          embedding_query_prefix: null
        }] };
        if (sql.includes("INSERT INTO chronicle_jobs")) return { rows: [{ id: "embedding-job-1" }] };
        throw new Error(`Unexpected caller SQL: ${sql}`);
      })
    } as unknown as DatabaseClient;
    const application = createApiMemoryApplication(pool, {
      credentialSecret: "credential-secret"
    });

    await expect(application.generation.autoEnableCampaignEmbedding(caller, {
      ownerUserId: "owner-1",
      campaignId: "campaign-1",
      worldVersionId: "world-version-1"
    })).resolves.toMatchObject({ enabled: true, providerProfileId: "embedding-profile" });
    expect(poolQuery).not.toHaveBeenCalled();
  });

  it("loads and fingerprints an embedding provider through the exact caller database context", async () => {
    const load = vi.fn().mockResolvedValue({
      id: "embedding-profile",
      model: "embed-v1",
      providerType: "openai-compatible",
      baseUrl: "https://embedding.example/v1///",
      configuration: { dimensions: 768 }
    });
    const resolveEmbeddingProviderId = vi.fn().mockResolvedValue("embedding-profile");
    const database = { transaction: "accepted-turn" } as never;
    const port = createChronicleEmbeddingProviderPort({
      loadEmbeddingProvider: load,
      callEmbeddingProvider: vi.fn(),
      recordProviderHealth: vi.fn(),
      recordProfileCost: vi.fn(),
      logProviderTransportError: vi.fn(),
      resolveEmbeddingProviderId
    });

    const provider = await port.load(database, {
      ownerUserId: "owner-1",
      providerProfileId: "embedding-profile",
      model: "embed-v1"
    }, "credential-secret");

    expect(provider).toMatchObject({
      id: "embedding-profile",
      model: "embed-v1",
      providerType: "openai-compatible",
      baseUrl: "https://embedding.example/v1///"
    });
    expect(load).toHaveBeenCalledWith(
      database,
      "owner-1",
      "embedding-profile",
      "credential-secret",
      "embed-v1"
    );
    expect(load.mock.calls[0]).not.toContain("image");
    await expect(port.resolve(database, { ownerUserId: "owner-1", campaignId: "campaign-1" }))
      .resolves.toBe("embedding-profile");
    expect(resolveEmbeddingProviderId).toHaveBeenCalledWith(database, "owner-1", "campaign-1", null);
    const prefixes = { documentPrefix: "search_document: ", queryPrefix: "search_query: ", automatic: true };
    await expect(port.fingerprint(provider, prefixes)).resolves.toEqual(expect.stringMatching(/^[a-f0-9]{64}$/));
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
      loadEmbeddingProvider: vi.fn(),
      resolveEmbeddingProviderId: vi.fn(),
      callEmbeddingProvider: vi.fn(),
      recordProviderHealth,
      recordProfileCost,
      logProviderTransportError: vi.fn()
    });
    const provider = {
      id: "embedding-profile",
      model: "embed-v1",
      providerType: "openai-compatible",
      baseUrl: "https://embedding.example/v1"
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
