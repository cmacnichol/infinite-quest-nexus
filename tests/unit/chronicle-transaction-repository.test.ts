import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  createPostgresChronicleConfigurationRepository,
  createPostgresChronicleGenerationTransactionPort,
  createPostgresChronicleJobRepository,
  createPostgresChronicleWorkerStatePort,
  type ChronicleTransactionEmbeddingPort
} from "../../packages/database/src/chronicle-repository.js";
import type { DatabaseClient, DatabasePool } from "../../packages/database/src/pool.js";

type QueryResult = Readonly<{
  rows: readonly Record<string, unknown>[];
  rowCount?: number;
}>;

function databaseClient(
  query: (sql: string, values: readonly unknown[]) => QueryResult | Promise<QueryResult>
): DatabaseClient {
  return { query: vi.fn(query) } as unknown as DatabaseClient;
}

function embeddingPort(
  overrides: Partial<ChronicleTransactionEmbeddingPort> = {}
): ChronicleTransactionEmbeddingPort {
  const unavailable = async (): Promise<never> => {
    throw new Error("unexpected embedding operation");
  };
  return {
    resolve: unavailable,
    load: unavailable,
    embed: unavailable,
    fingerprint: unavailable,
    recordHealth: unavailable,
    recordCost: unavailable,
    logDiagnostic: vi.fn(),
    ...overrides
  };
}

const scope = {
  ownerUserId: "owner-1",
  campaignId: "campaign-1",
  worldVersionId: "world-version-1"
} as const;

describe("PostgreSQL Chronicle generation transaction port", () => {
  it("auto-enables semantic memory and queues embedding work on the exact caller client", async () => {
    let callerClient: DatabaseClient;
    const queries: string[] = [];
    const client = databaseClient((sql) => {
      queries.push(sql);
      if (sql.includes("FROM campaigns")) {
        return { rows: [{ world_version_id: scope.worldVersionId }] };
      }
      if (sql.includes("SELECT default_model FROM provider_profiles")) {
        return { rows: [{ default_model: "embed-v1" }] };
      }
      if (sql.includes("INSERT INTO campaign_memory_configs")) {
        return { rows: [{
          embedding_enabled: true,
          embedding_provider_profile_id: "embedding-profile",
          embedding_model: "embed-v1",
          embedding_batch_size: 16,
          embedding_document_prefix: null,
          embedding_query_prefix: null
        }] };
      }
      if (sql.includes("INSERT INTO chronicle_jobs")) {
        return { rows: [{ id: "embedding-job-1" }] };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    callerClient = client;
    const transaction = createPostgresChronicleGenerationTransactionPort({
      credentialSecret: "credential-secret",
      embeddings: embeddingPort({
        resolve: async (database, requestedScope) => {
          expect(database).toBe(callerClient);
          expect(requestedScope).toEqual({
            ownerUserId: scope.ownerUserId,
            campaignId: scope.campaignId,
            selectedProviderProfileId: null
          });
          return "embedding-profile";
        }
      })
    });

    await expect(transaction.autoEnableCampaignEmbedding(client, scope)).resolves.toMatchObject({
      enabled: true,
      providerProfileId: "embedding-profile",
      model: "embed-v1",
      effectiveDocumentPrefix: "",
      effectiveQueryPrefix: ""
    });
    expect(queries.some((sql) => sql.includes("INSERT INTO campaign_memory_configs"))).toBe(true);
    expect(queries.some((sql) => sql.includes("INSERT INTO chronicle_jobs"))).toBe(true);
  });

  it("enqueues embedding reindex work directly when the caller transaction has an eligible config", async () => {
    let callerClient: DatabaseClient;
    const client = databaseClient((sql) => {
      if (sql.includes("FROM campaigns")) {
        return { rows: [{ world_version_id: scope.worldVersionId }] };
      }
      if (sql.includes("FROM campaign_memory_configs")) {
        return { rows: [{
          embedding_enabled: true,
          embedding_provider_profile_id: "embedding-profile",
          embedding_model: "embed-v1",
          embedding_batch_size: 8,
          embedding_document_prefix: null,
          embedding_query_prefix: null
        }] };
      }
      if (sql.includes("INSERT INTO chronicle_jobs")) {
        return { rows: [{ id: "embedding-job-2" }] };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    callerClient = client;
    const transaction = createPostgresChronicleGenerationTransactionPort({
      credentialSecret: "credential-secret",
      embeddings: embeddingPort({
        resolve: async (database, requestedScope) => {
          expect(database).toBe(callerClient);
          expect(requestedScope.selectedProviderProfileId).toBe("embedding-profile");
          return "embedding-profile";
        }
      })
    });

    await expect(transaction.enqueueEmbeddingReindex(client, scope)).resolves.toBe("embedding-job-2");
  });

  it("writes only sanitized accepted fiction with owner, campaign, and world-version scope", async () => {
    let inserted: readonly unknown[] = [];
    const client = databaseClient((sql, values) => {
      if (sql.includes("FROM campaigns") && sql.includes("world_versions")) {
        return { rows: [{
          id: scope.campaignId,
          world_version_id: scope.worldVersionId,
          world_content: {},
          character_snapshot: null,
          character_profile: null
        }] };
      }
      if (sql.includes("INSERT INTO chronicle_memories")) {
        inserted = values;
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const transaction = createPostgresChronicleGenerationTransactionPort({
      credentialSecret: "credential-secret",
      embeddings: embeddingPort()
    });

    await transaction.writeAcceptedTurnFiction(client, {
      ...scope,
      turnId: "turn-1",
      ordinal: 4,
      action: "Open the ancient gate. [[ROLL d20=19]]",
      narration: "The gate opens. Difficulty: hard. Beyond it waits the Moon Warden."
    });

    expect(inserted.slice(0, 5)).toEqual([
      scope.ownerUserId,
      scope.campaignId,
      scope.worldVersionId,
      "turn-1",
      4
    ]);
    expect(String(inserted[5])).toContain("The gate opens.");
    expect(String(inserted[5])).toContain("Moon Warden");
    expect(String(inserted[5])).not.toMatch(/ROLL|Difficulty|d20/i);
    expect(String(inserted.at(-1))).toContain('"generated":true');
  });

  it("stores sanitized derived summary, canonical facts, and open threads directly", async () => {
    const memoryWrites: Array<{ sql: string; values: readonly unknown[] }> = [];
    const client = databaseClient((sql, values) => {
      if (sql.includes("FROM campaigns") && sql.includes("world_versions")) {
        return { rows: [{
          id: scope.campaignId,
          world_version_id: scope.worldVersionId,
          world_content: {},
          character_snapshot: null,
          character_profile: null
        }] };
      }
      if (sql.includes("INSERT INTO campaign_canonical_facts")) {
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("UPDATE campaign_canonical_facts")) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("SELECT id, source_turn_id") && sql.includes("campaign_canonical_facts")) {
        return { rows: [{
          id: "fact-1",
          source_turn_id: "turn-2",
          source_turn_number: 2,
          content: "The Moon Warden guards the gate.",
          entities: ["Moon Warden"],
          entity_ids: []
        }] };
      }
      if (sql.includes("DELETE FROM chronicle_memories")) {
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("INSERT INTO chronicle_memories")) {
        memoryWrites.push({ sql, values });
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const transaction = createPostgresChronicleGenerationTransactionPort({
      credentialSecret: "credential-secret",
      embeddings: embeddingPort()
    });

    await transaction.storeDerivedTurnMemories(client, {
      ...scope,
      turnId: "turn-2",
      ordinal: 2,
      derived: {
        continuitySummary: "The Moon Warden wakes. [[ROLL 1d20=20]]",
        canonicalFacts: ["The Moon Warden guards the gate. Difficulty: 18"],
        openThreads: ["Find the silver key. [CHECK dexterity]"]
      }
    });

    expect(memoryWrites.map(({ sql }) => sql.match(/'(canonical_fact|campaign_summary|open_thread)'/)?.[1]))
      .toEqual(["canonical_fact", "campaign_summary", "open_thread"]);
    const serializedValues = JSON.stringify(memoryWrites.map(({ values }) => values));
    expect(serializedValues).toContain("Moon Warden");
    expect(serializedValues).toContain("silver key");
    expect(serializedValues).not.toMatch(/ROLL|CHECK|Difficulty|1d20|dexterity/i);
  });

  it("rebuilds Chronicle rows from accepted turns without opening a nested transaction", async () => {
    const sqlStatements: string[] = [];
    const rebuiltFiction: string[] = [];
    const campaignRow = {
      id: scope.campaignId,
      world_version_id: scope.worldVersionId,
      world_content: {},
      character_snapshot: null,
      character_profile: null
    };
    const client = databaseClient((sql, values) => {
      sqlStatements.push(sql);
      if (sql.includes("FROM campaigns") && sql.includes("world_versions")) {
        return { rows: [campaignRow] };
      }
      if (sql.includes("FROM turns") && sql.includes("ORDER BY turn_number")) {
        return { rows: [
          { id: "turn-1", turn_number: 1, action: "Enter.", narration: "The Moon Warden watches.", state_snapshot_private: {} },
          { id: "turn-2", turn_number: 2, action: "Advance.", narration: "The gate opens.", state_snapshot_private: {} }
        ] };
      }
      if (sql.includes("FROM campaign_state_edits")) return { rows: [] };
      if (sql.includes("SELECT id, source_turn_id") && sql.includes("campaign_canonical_facts")) return { rows: [] };
      if (sql.includes("INSERT INTO chronicle_memories") && sql.includes("'turn_fiction'")) {
        rebuiltFiction.push(String(values[5]));
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("DELETE FROM") || sql.includes("INSERT INTO chronicle_memories")) {
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const transaction = createPostgresChronicleGenerationTransactionPort({
      credentialSecret: "credential-secret",
      embeddings: embeddingPort()
    });

    await expect(transaction.rebuildCampaignMemories(client, scope)).resolves.toBe(2);
    expect(rebuiltFiction).toHaveLength(2);
    expect(rebuiltFiction.join("\n")).toContain("Moon Warden");
    expect(sqlStatements.some((sql) => /^\s*(BEGIN|COMMIT|ROLLBACK)\b/i.test(sql))).toBe(false);
  });

  it("replays state edits with state-edit provenance and no fabricated turn id", async () => {
    const canonicalWrites: Array<{ sql: string; values: readonly unknown[] }> = [];
    const memoryWrites: Array<{ sql: string; values: readonly unknown[] }> = [];
    const client = databaseClient((sql, values) => {
      if (sql.includes("FROM campaigns") && sql.includes("world_versions")) {
        return { rows: [{
          id: scope.campaignId,
          world_version_id: scope.worldVersionId,
          world_content: {},
          character_snapshot: null,
          character_profile: null
        }] };
      }
      if (sql.includes("FROM turns") && sql.includes("ORDER BY turn_number")) return { rows: [] };
      if (sql.includes("FROM campaign_state_edits")) {
        return { rows: [{
          id: "state-edit-1",
          effective_turn_number: 3,
          state_snapshot_private: {
            continuitySummary: "The gate was corrected to open.",
            openThreads: ["Find the silver key."],
            canonicalFacts: [{ id: null, content: "The moon gate is open." }]
          }
        }] };
      }
      if (sql.includes("FROM campaign_canonical_facts") && sql.includes("valid_from_turn <=")) {
        return { rows: [] };
      }
      if (sql.includes("INSERT INTO campaign_canonical_facts")) {
        canonicalWrites.push({ sql, values });
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("SELECT id, source_turn_id") && sql.includes("valid_until_turn IS NULL")) {
        return { rows: [{
          id: "corrected-fact-1",
          source_turn_id: null,
          source_turn_number: 3,
          content: "The moon gate is open.",
          entities: [],
          entity_ids: []
        }] };
      }
      if (sql.includes("INSERT INTO chronicle_memories")) {
        memoryWrites.push({ sql, values });
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("DELETE FROM")) return { rows: [], rowCount: 1 };
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const transaction = createPostgresChronicleGenerationTransactionPort({
      credentialSecret: "credential-secret",
      embeddings: embeddingPort()
    });

    await expect(transaction.rebuildCampaignMemories(client, scope)).resolves.toBe(0);

    expect(canonicalWrites).toHaveLength(1);
    expect(canonicalWrites[0]!.sql).toContain("source_state_edit_id");
    expect(canonicalWrites[0]!.values).toContain("state-edit-1");
    const canonicalMemory = memoryWrites.find(({ sql }) => sql.includes("'canonical_fact'"));
    expect(canonicalMemory?.values[3]).toBeNull();
    expect(memoryWrites.every(({ values }) => String(values.at(-1)).includes('"stateEditId":"state-edit-1"'))).toBe(true);
    expect(memoryWrites.every(({ values }) => values[3] !== "state-edit-1")).toBe(true);
  });

  it("builds a scoped context preview and attributes semantic retrieval on the caller client", async () => {
    let callerClient: DatabaseClient;
    const client = databaseClient((sql) => {
      if (sql.includes("FROM campaigns c") && sql.includes("campaign_state")) {
        return { rows: [{
          id: scope.campaignId,
          title: "Moon Gate",
          active_turn_number: 2,
          world_version_id: scope.worldVersionId,
          selected_character_id: null,
          character_profile_revision: 0,
          world_content: { world: { rules: "The gate answers only to moonlight." } },
          character_snapshot: null,
          character_profile: null,
          scratchpad_private: "The Moon Warden is alert.",
          scratchpad_safe_for_prompt: true,
          trackers: [{ privateReasoning: "secret", label: "Gate is open" }]
        }] };
      }
      if (sql.includes("WITH base AS") && sql.includes("chronicle_memories")) {
        return { rows: [{
          id: "memory-1",
          turn_id: "turn-2",
          memory_kind: "turn_fiction",
          ordinal: 2,
          content: "Turn 2\nNarration: The Moon Warden opens the gate.",
          token_estimate: 14,
          importance: 0.8,
          entities: ["Moon Warden"],
          entity_ids: [],
          relevance: 0.5
        }] };
      }
      if (sql.includes("FROM campaign_memory_configs")) {
        return { rows: [{
          embedding_enabled: true,
          embedding_provider_profile_id: "embedding-profile",
          embedding_model: "embed-v1",
          embedding_batch_size: 8,
          embedding_document_prefix: null,
          embedding_query_prefix: null
        }] };
      }
      if (sql.includes("SELECT") && sql.includes("estimated_tokens") && sql.includes("memory_count")) {
        return { rows: [{
          turns: "2",
          characters: "100",
          estimated_tokens: "25",
          memory_count: "1",
          memory_tokens: "14",
          embedded_memories: "1",
          turn_memory_tokens: "14",
          recent_turn_tokens: "14",
          summary_tokens: "0"
        }] };
      }
      if (sql.includes("embedding <=>")) {
        const content = "Turn 2\nNarration: The Moon Warden opens the gate.";
        return { rows: [{
          id: "memory-1",
          turn_id: "turn-2",
          memory_kind: "turn_fiction",
          ordinal: 2,
          content,
          token_estimate: 14,
          importance: 0.8,
          entities: ["Moon Warden"],
          entity_ids: [],
          relevance: 0,
          embedding_content_hash: createHash("sha256").update(content).digest("hex"),
          semantic_relevance: 0.9
        }] };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    callerClient = client;
    const transaction = createPostgresChronicleGenerationTransactionPort({
      credentialSecret: "credential-secret",
      embeddings: embeddingPort({
        resolve: async (database) => {
          expect(database).toBe(callerClient);
          return "embedding-profile";
        },
        load: async (database) => {
          expect(database).toBe(callerClient);
          return {
            id: "embedding-profile",
            model: "embed-v1",
            providerType: "openai-compatible",
            baseUrl: "https://embedding.example/v1"
          };
        },
        embed: async (_provider, documents) => {
          expect(documents.join("\n")).toContain("Moon Warden");
          return {
            embeddings: [[0.1, 0.2]],
            responseId: "embedding-response-1",
            usage: { inputTokens: 4 },
            reportedCost: { amount: "0.001", currency: "USD" }
          };
        },
        fingerprint: async () => "fingerprint-1",
        recordHealth: async (database, _providerScope, healthy) => {
          expect(database).toBe(callerClient);
          expect(healthy).toBe(true);
        },
        recordCost: async (database, _provider, attribution) => {
          expect(database).toBe(callerClient);
          expect(attribution).toMatchObject({
            ownerUserId: scope.ownerUserId,
            campaignId: scope.campaignId,
            generationJobId: "generation-1",
            operation: "retrieval_embedding"
          });
          return "cost-1";
        }
      })
    });

    const preview = await transaction.buildContextPreview(client, {
      ...scope,
      request: { budgetTokens: 4_000, compression: "auto", recentTurns: 4, query: "Moon Warden" },
      costAttribution: { generationJobId: "generation-1", operation: "retrieval_embedding" }
    });

    expect(preview).toMatchObject({
      campaign: { id: scope.campaignId, worldVersionId: scope.worldVersionId },
      retrieval: { mode: "hybrid", semanticAvailable: true },
      scopes: {
        campaignCanon: { continuityScratchpad: "The Moon Warden is alert." },
        currentScene: { memoryId: "memory-1" }
      }
    });
    expect(JSON.stringify(preview)).not.toMatch(/diceResult|privateReasoning|credential-secret|embedding\.example/i);
  });
});

describe("PostgreSQL Chronicle worker state port", () => {
  it("unconditionally requeues stale completed work even when the legacy opt-in flag is false", async () => {
    const job = { status: "running", workVersion: 2 };
    const pool = databaseClient((sql, values) => {
      const claimedWorkVersion = Number(values[4]);
      const stale = job.workVersion > claimedWorkVersion;
      const optInGatePresent = sql.includes("$8::boolean");
      const shouldRequeue = stale && (!optInGatePresent || values[7] === true);
      job.status = shouldRequeue ? "queued" : "completed";
      return { rows: [{ status: job.status }], rowCount: 1 };
    }) as unknown as DatabasePool;
    const state = createPostgresChronicleWorkerStatePort(pool);

    await expect(state.completeClaim({
      ...scope,
      jobId: "chronicle-job-1",
      jobType: "embed_campaign",
      workVersion: 1,
      workerId: "worker-1",
      leaseSeconds: 30
    }, {
      progress: { embedded: 12 },
      requeueIfWorkVersionChanged: false
    })).resolves.toBe(true);

    expect(job.status).toBe("queued");
  });
});

describe("PostgreSQL Chronicle embedding configuration policy", () => {
  const input = {
    enabled: true,
    providerProfileId: "embedding-profile",
    model: "embed-v1",
    batchSize: 16,
    documentPrefix: null,
    queryPrefix: null
  } as const;

  it("rejects an image provider before persisting embedding configuration", async () => {
    let persisted = false;
    const pool = databaseClient((sql) => {
      if (sql.includes("SELECT world_version_id FROM campaigns")) {
        return { rows: [{ world_version_id: scope.worldVersionId }] };
      }
      if (sql.includes("provider_role = 'embedding'")) return { rows: [] };
      if (sql.includes("SELECT provider_role FROM provider_profiles")) {
        return { rows: [{ provider_role: "image" }] };
      }
      if (sql.includes("INSERT INTO campaign_memory_configs")) {
        persisted = true;
        return { rows: [{
          embedding_enabled: true,
          embedding_provider_profile_id: "image-profile",
          embedding_model: "embed-v1",
          embedding_batch_size: 16,
          embedding_document_prefix: null,
          embedding_query_prefix: null
        }] };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    }) as unknown as DatabasePool;
    const configuration = createPostgresChronicleConfigurationRepository(pool);

    await expect(configuration.setEmbeddingConfig(scope, {
      ...input,
      providerProfileId: "image-profile"
    })).rejects.toMatchObject({ statusCode: 400 });
    expect(persisted).toBe(false);
  });

  it("rejects a text provider while a dedicated embedding provider is enabled", async () => {
    let persisted = false;
    const pool = databaseClient((sql) => {
      if (sql.includes("SELECT world_version_id FROM campaigns")) {
        return { rows: [{ world_version_id: scope.worldVersionId }] };
      }
      if (sql.includes("provider_role = 'embedding'")) {
        return { rows: [{ id: "embedding-profile", is_default: true }] };
      }
      if (sql.includes("SELECT provider_role FROM provider_profiles")) {
        return { rows: [{ provider_role: "text" }] };
      }
      if (sql.includes("INSERT INTO campaign_memory_configs")) {
        persisted = true;
        return { rows: [] };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    }) as unknown as DatabasePool;
    const configuration = createPostgresChronicleConfigurationRepository(pool);

    await expect(configuration.setEmbeddingConfig(scope, {
      ...input,
      providerProfileId: "text-profile"
    })).rejects.toMatchObject({ statusCode: 400 });
    expect(persisted).toBe(false);
  });

  it("persists the enabled dedicated default when the provider is omitted", async () => {
    let persistedProviderId: unknown;
    const pool = databaseClient((sql, values) => {
      if (sql.includes("SELECT world_version_id FROM campaigns")) {
        return { rows: [{ world_version_id: scope.worldVersionId }] };
      }
      if (sql.includes("provider_role = 'embedding'")) {
        return { rows: [{ id: "embedding-default", is_default: true }] };
      }
      if (sql.includes("INSERT INTO campaign_memory_configs")) {
        persistedProviderId = values[3];
        return { rows: [{
          embedding_enabled: true,
          embedding_provider_profile_id: values[3],
          embedding_model: "embed-v1",
          embedding_batch_size: 16,
          embedding_document_prefix: null,
          embedding_query_prefix: null
        }] };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    }) as unknown as DatabasePool;
    const configuration = createPostgresChronicleConfigurationRepository(pool);

    await expect(configuration.setEmbeddingConfig(scope, {
      ...input,
      providerProfileId: null
    })).resolves.toMatchObject({ providerProfileId: "embedding-default" });
    expect(persistedProviderId).toBe("embedding-default");
  });

  it("rejects a stored text fallback before enqueue when a dedicated provider is enabled", async () => {
    let enqueued = false;
    const pool = databaseClient((sql) => {
      if (sql.includes("SELECT world_version_id FROM campaigns")) {
        return { rows: [{ world_version_id: scope.worldVersionId }] };
      }
      if (sql.includes("FROM campaign_memory_configs")) {
        return { rows: [{
          embedding_enabled: true,
          embedding_provider_profile_id: "text-profile",
          embedding_model: "embed-v1",
          embedding_batch_size: 16,
          embedding_document_prefix: null,
          embedding_query_prefix: null
        }] };
      }
      if (sql.includes("provider_role = 'embedding'")) {
        return { rows: [{ id: "embedding-profile", is_default: true }] };
      }
      if (sql.includes("SELECT provider_role FROM provider_profiles")) {
        return { rows: [{ provider_role: "text" }] };
      }
      if (sql.includes("INSERT INTO chronicle_jobs")) {
        enqueued = true;
        return { rows: [{ id: "job-1" }] };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    }) as unknown as DatabasePool;
    const jobs = createPostgresChronicleJobRepository(pool);

    await expect(jobs.enqueueEmbeddingReindex(scope)).rejects.toMatchObject({ statusCode: 400 });
    expect(enqueued).toBe(false);
  });
});
