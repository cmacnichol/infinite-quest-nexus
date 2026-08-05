import { describe, expect, it, vi } from "vitest";
import type { ChronicleEmbeddingProviderPort } from "../../services/runtime/src/chronicle-platform-adapter.js";
import { resolveChronicleEmbeddingProviderId } from "../../services/runtime/src/chronicle-platform-bindings.js";
import { createPostgresChronicleGenerationTransactionPort } from "../../packages/database/src/chronicle-repository.js";
import type { DatabaseClient } from "../../packages/database/src/pool.js";
import { DEFAULT_EMBEDDING_MODEL } from "../../packages/contracts/src/memory.js";

const scope = { ownerUserId: "owner-id", campaignId: "campaign-id", worldVersionId: "wv-1" };

describe("Semantic memory auto-enabling on campaign creation", () => {
  it("resolves the dedicated embedding provider when one is enabled", async () => {
    const database = {
      query: vi.fn(async (sql: string) => sql.includes("provider_role = 'embedding'")
        ? { rows: [{ id: "embed-provider-id", is_default: true }] }
        : { rows: [] })
    } as unknown as DatabaseClient;

    await expect(resolveChronicleEmbeddingProviderId(database, {
      ownerUserId: scope.ownerUserId,
      campaignId: scope.campaignId
    })).resolves.toBe("embed-provider-id");
  });

  it("falls back to the campaign's enabled text provider when no dedicated provider exists", async () => {
    const database = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("provider_role = 'embedding'")) return { rows: [] };
        if (sql.includes("SELECT text_provider_profile_id FROM campaigns")) {
          return { rows: [{ text_provider_profile_id: "text-provider-id" }] };
        }
        if (sql.includes("provider_role = 'text' AND enabled = true") && sql.includes("id = $1")) {
          return { rows: [{ id: "text-provider-id" }] };
        }
        return { rows: [] };
      })
    } as unknown as DatabaseClient;

    await expect(resolveChronicleEmbeddingProviderId(database, {
      ownerUserId: scope.ownerUserId,
      campaignId: scope.campaignId
    })).resolves.toBe("text-provider-id");
  });

  it("returns null when no embedding or fallback provider is available", async () => {
    const database = {
      query: vi.fn(async (sql: string) => sql.includes("SELECT text_provider_profile_id FROM campaigns")
        ? { rows: [{ text_provider_profile_id: null }] }
        : { rows: [] })
    } as unknown as DatabaseClient;

    await expect(resolveChronicleEmbeddingProviderId(database, {
      ownerUserId: scope.ownerUserId,
      campaignId: scope.campaignId
    })).resolves.toBeNull();
  });

  it("auto-enables semantic memory and queues embed_campaign through the transaction port", async () => {
    const queries: string[] = [];
    const database = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
        if (sql.startsWith("SELECT world_version_id FROM campaigns")) return { rows: [{ world_version_id: scope.worldVersionId }] };
        if (sql.includes("SELECT default_model FROM provider_profiles")) return { rows: [{ default_model: "custom-nomic-v1.5" }] };
        if (sql.includes("INSERT INTO campaign_memory_configs")) {
          return { rows: [{
            embedding_enabled: true,
            embedding_provider_profile_id: "embed-provider-1",
            embedding_model: "custom-nomic-v1.5",
            embedding_batch_size: 16,
            embedding_document_prefix: null,
            embedding_query_prefix: null
          }] };
        }
        return { rows: [] };
      })
    } as unknown as DatabaseClient;
    const embeddings = {
      resolve: vi.fn().mockResolvedValue("embed-provider-1")
    } as unknown as ChronicleEmbeddingProviderPort;
    const memory = createPostgresChronicleGenerationTransactionPort({ credentialSecret: "secret", embeddings });

    await expect(memory.autoEnableCampaignEmbedding(database, scope)).resolves.toMatchObject({
      enabled: true,
      providerProfileId: "embed-provider-1",
      model: "custom-nomic-v1.5"
    });
    expect(queries.some((sql) => sql.includes("INSERT INTO campaign_memory_configs"))).toBe(true);
    expect(queries.some((sql) => sql.includes("INSERT INTO chronicle_jobs") && sql.includes("'embed_campaign'"))).toBe(true);
  });

  it("keeps semantic memory disabled when provider selection returns null", async () => {
    const queries: string[] = [];
    const database = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
        if (sql.startsWith("SELECT world_version_id FROM campaigns")) return { rows: [{ world_version_id: scope.worldVersionId }] };
        return { rows: [] };
      })
    } as unknown as DatabaseClient;
    const embeddings = { resolve: vi.fn().mockResolvedValue(null) } as unknown as ChronicleEmbeddingProviderPort;
    const memory = createPostgresChronicleGenerationTransactionPort({ credentialSecret: "secret", embeddings });

    await expect(memory.autoEnableCampaignEmbedding(database, scope)).resolves.toMatchObject({
      enabled: false,
      providerProfileId: null,
      model: DEFAULT_EMBEDDING_MODEL
    });
    expect(queries.some((sql) => sql.includes("INSERT INTO campaign_memory_configs"))).toBe(false);
  });
});
