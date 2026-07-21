import { describe, expect, it, vi } from "vitest";
import { autoEnableCampaignEmbeddingIfAvailable, resolveCampaignEmbeddingProviderId } from "../../services/api/src/memory-service.js";
import { DEFAULT_EMBEDDING_MODEL } from "../../packages/contracts/src/memory.js";

describe("Semantic memory auto-enabling on campaign creation", () => {
  it("resolves the dedicated embedding provider when one is enabled", async () => {
    const mockClient = {
      query: vi.fn().mockImplementation(async (sql: string, params: unknown[]) => {
        if (sql.includes("FROM provider_profiles WHERE owner_user_id = $1 AND provider_role = 'embedding'")) {
          return { rowCount: 1, rows: [{ id: "embed-provider-id" }] };
        }
        if (sql.includes("SELECT id, is_default FROM provider_profiles")) {
          return { rows: [{ id: "embed-provider-id", is_default: true }] };
        }
        return { rows: [] };
      })
    } as any;

    const providerId = await resolveCampaignEmbeddingProviderId(mockClient, "owner-id", "campaign-id");
    expect(providerId).toBe("embed-provider-id");
  });

  it("falls back to the campaign's text provider when no dedicated embedding provider is available", async () => {
    const mockClient = {
      query: vi.fn().mockImplementation(async (sql: string, params: unknown[]) => {
        if (sql.includes("FROM provider_profiles WHERE owner_user_id = $1 AND provider_role = 'embedding'")) {
          return { rowCount: 0, rows: [] };
        }
        if (sql.includes("FROM campaigns WHERE id = $1")) {
          return { rows: [{ text_provider_profile_id: "text-provider-id" }] };
        }
        if (sql.includes("SELECT id FROM provider_profiles WHERE id = $1 AND owner_user_id = $2 AND provider_role = $3")) {
          return { rows: [{ id: "text-provider-id" }] };
        }
        return { rows: [] };
      })
    } as any;

    const providerId = await resolveCampaignEmbeddingProviderId(mockClient, "owner-id", "campaign-id");
    expect(providerId).toBe("text-provider-id");
  });

  it("returns null when no embedding or fallback provider is available", async () => {
    const mockClient = {
      query: vi.fn().mockImplementation(async (sql: string) => {
        if (sql.includes("FROM provider_profiles WHERE owner_user_id = $1 AND provider_role = 'embedding'")) {
          return { rowCount: 0, rows: [] };
        }
        if (sql.includes("FROM campaigns WHERE id = $1")) {
          return { rows: [{ text_provider_profile_id: null }] };
        }
        if (sql.includes("SELECT id, is_default FROM provider_profiles")) {
          return { rows: [] };
        }
        return { rows: [] };
      })
    } as any;

    const providerId = await resolveCampaignEmbeddingProviderId(mockClient, "owner-id", "campaign-id");
    expect(providerId).toBeNull();
  });

  it("auto-enables hybrid semantic memory and queues embed_campaign when a valid provider exists", async () => {
    const queries: { sql: string; params?: unknown[] }[] = [];
    const mockClient = {
      query: vi.fn().mockImplementation(async (sql: string, params: unknown[]) => {
        queries.push({ sql, params });
        if (sql.includes("FROM users WHERE system_key = 'initial-owner'")) {
          return { rows: [{ id: "owner-id" }] };
        }
        if (sql.includes("FROM campaigns c") || sql.includes("FROM campaigns WHERE id = $1")) {
          return {
            rows: [{
              id: "campaign-id",
              title: "Test Campaign",
              active_turn_number: 0,
              world_version_id: "wv-1",
              world_content: {},
              character_snapshot: null,
              scratchpad_private: "",
              scratchpad_safe_for_prompt: true,
              trackers: []
            }]
          };
        }
        if (sql.includes("FROM provider_profiles WHERE owner_user_id = $1 AND provider_role = 'embedding'")) {
          return { rowCount: 1, rows: [{ id: "embed-provider-1" }] };
        }
        if (sql.includes("SELECT id, is_default FROM provider_profiles WHERE owner_user_id = $1 AND provider_role = $2")) {
          return { rows: [{ id: "embed-provider-1", is_default: true }] };
        }
        if (sql.includes("SELECT default_model FROM provider_profiles")) {
          return { rows: [{ default_model: "custom-nomic-v1.5" }] };
        }
        if (sql.includes("INSERT INTO campaign_memory_configs")) {
          return {
            rows: [{
              embedding_enabled: true,
              embedding_provider_profile_id: "embed-provider-1",
              embedding_model: "custom-nomic-v1.5",
              embedding_batch_size: 16,
              embedding_document_prefix: null,
              embedding_query_prefix: null,
              updated_at: new Date()
            }]
          };
        }
        if (sql.includes("FROM campaign_memory_configs WHERE campaign_id = $1")) {
          return {
            rows: [{
              embedding_enabled: true,
              embedding_provider_profile_id: "embed-provider-1",
              embedding_model: "custom-nomic-v1.5",
              embedding_batch_size: 16,
              embedding_document_prefix: null,
              embedding_query_prefix: null,
              updated_at: new Date()
            }]
          };
        }
        if (sql.includes("INSERT INTO chronicle_jobs")) {
          return { rows: [{ id: "job-123" }] };
        }
        return { rows: [] };
      })
    } as any;

    const config = await autoEnableCampaignEmbeddingIfAvailable(mockClient, "owner-id", "campaign-id");
    expect(config.enabled).toBe(true);
    expect(config.providerProfileId).toBe("embed-provider-1");
    expect(config.model).toBe("custom-nomic-v1.5");

    const insertConfig = queries.find((q) => q.sql.includes("INSERT INTO campaign_memory_configs"));
    expect(insertConfig).toBeDefined();
    expect(insertConfig?.sql).toContain("true");
    expect(insertConfig?.params).toContain("embed-provider-1");
    expect(insertConfig?.params).toContain("custom-nomic-v1.5");

    const insertJob = queries.find((q) => q.sql.includes("INSERT INTO chronicle_jobs") && q.sql.includes("'embed_campaign'"));
    expect(insertJob).toBeDefined();
  });

  it("does not enable hybrid semantic memory when no valid provider exists", async () => {
    const queries: { sql: string; params?: unknown[] }[] = [];
    const mockClient = {
      query: vi.fn().mockImplementation(async (sql: string, params: unknown[]) => {
        queries.push({ sql, params });
        if (sql.includes("FROM provider_profiles WHERE owner_user_id = $1 AND provider_role = 'embedding'")) {
          return { rowCount: 0, rows: [] };
        }
        if (sql.includes("FROM campaigns WHERE id = $1")) {
          return { rows: [{ text_provider_profile_id: null }] };
        }
        if (sql.includes("SELECT id, is_default FROM provider_profiles")) {
          return { rows: [] };
        }
        if (sql.includes("FROM campaign_memory_configs WHERE campaign_id = $1")) {
          return { rows: [] };
        }
        return { rows: [] };
      })
    } as any;

    const config = await autoEnableCampaignEmbeddingIfAvailable(mockClient, "owner-id", "campaign-id");
    expect(config.enabled).toBe(false);
    expect(config.providerProfileId).toBeNull();
    expect(config.model).toBe(DEFAULT_EMBEDDING_MODEL);

    const insertConfig = queries.find((q) => q.sql.includes("INSERT INTO campaign_memory_configs"));
    expect(insertConfig).toBeUndefined();
  });
});
