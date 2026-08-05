import { describe, expect, it, vi } from "vitest";
import {
  createChronicleEmbeddingProviderPort,
  createChronicleWorkerExecutor
} from "../../services/runtime/src/chronicle-platform-adapter.js";
import {
  createChroniclePlatformBindings,
  resolveChronicleEmbeddingProviderId
} from "../../services/runtime/src/chronicle-platform-bindings.js";
import {
  createApiMemoryApplication,
  createWorkerMemoryApplication
} from "../../services/runtime/src/memory-composition.js";
import { createMemoryWorkerApplication } from "../../packages/application/src/memory/index.js";
import type { DatabaseClient, DatabasePool } from "../../packages/database/src/pool.js";

describe("Chronicle runtime adapters", () => {
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
      runClaim: vi.fn().mockRejectedValue(new Error("https://embedding.example/token=private")),
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

  it("composes the additive worker application from repository adapters without changing a live worker consumer", async () => {
    const runNextChronicle = vi.fn().mockResolvedValue(false);
    const createExecutor = vi.fn().mockReturnValue({ runNextChronicle, runClaimed: vi.fn() });
    const application = createWorkerMemoryApplication({} as never, {
      createExecutor,
      createApplication: createMemoryWorkerApplication
    });

    await expect(application.runNextChronicle({
      workerId: "worker-1", leaseSeconds: 30, retrieval: { batchLimit: 8 }
    })).resolves.toBe(false);

    expect(createExecutor).toHaveBeenCalledOnce();
    expect(runNextChronicle).toHaveBeenCalledWith({
      workerId: "worker-1", leaseSeconds: 30, retrieval: { batchLimit: 8 }
    });
  });
});
