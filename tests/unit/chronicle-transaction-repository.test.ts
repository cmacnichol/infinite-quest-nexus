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
  return {
    query: vi.fn((sql: string, values: readonly unknown[]) => {
      if (/^(?:SAVEPOINT|RELEASE SAVEPOINT|ROLLBACK TO SAVEPOINT) chronicle_(?:retrieval|query_embedding_cache)_/.test(sql)) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("UPDATE chronicle_query_embedding_cache")) return { rows: [], rowCount: 0 };
      if (sql.includes("INSERT INTO chronicle_query_embedding_cache")
        || sql.includes("DELETE FROM chronicle_query_embedding_cache")
        || (sql.includes("pg_advisory_xact_lock")
          && typeof values[0] === "string" && values[0].startsWith("chronicle-query-cache:"))) {
        return { rows: [], rowCount: 0 };
      }
      return query(sql, values);
    })
  } as unknown as DatabaseClient;
}

function databasePool(
  query: (sql: string, values: readonly unknown[]) => QueryResult | Promise<QueryResult>
): DatabasePool {
  const client = {
    ...databaseClient((sql, values) => {
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rows: [], rowCount: 0 };
      return query(sql, values);
    }),
    release: vi.fn()
  } as unknown as DatabaseClient;
  return {
    connect: vi.fn(async () => client),
    query: vi.fn(query)
  } as unknown as DatabasePool;
}

function acceptsDisabledAutomaticChunkEnqueue(sql: string): QueryResult | null {
  if (sql === "SAVEPOINT automatic_chronicle_chunk_enqueue"
    || sql === "RELEASE SAVEPOINT automatic_chronicle_chunk_enqueue") {
    return { rows: [], rowCount: 0 };
  }
  if (sql.includes("JOIN campaign_memory_configs config")) return { rows: [] };
  return null;
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
      const automaticChunkEnqueue = acceptsDisabledAutomaticChunkEnqueue(sql);
      if (automaticChunkEnqueue) return automaticChunkEnqueue;
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
      const automaticChunkEnqueue = acceptsDisabledAutomaticChunkEnqueue(sql);
      if (automaticChunkEnqueue) return automaticChunkEnqueue;
      if (sql.includes("FROM campaigns") && sql.includes("world_versions")) {
        return { rows: [campaignRow] };
      }
      if (sql.includes("FROM turns turn_row") && sql.includes("effective_turn_narrations")) {
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
      const automaticChunkEnqueue = acceptsDisabledAutomaticChunkEnqueue(sql);
      if (automaticChunkEnqueue) return automaticChunkEnqueue;
      if (sql.includes("FROM campaigns") && sql.includes("world_versions")) {
        return { rows: [{
          id: scope.campaignId,
          world_version_id: scope.worldVersionId,
          world_content: {},
          character_snapshot: null,
          character_profile: null
        }] };
      }
      if (sql.includes("FROM turns turn_row") && sql.includes("effective_turn_narrations")) return { rows: [] };
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
            embed: async () => ({ embeddings: [], responseId: "unused", usage: {}, reportedCost: null }),
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
      retrieval: {
        mode: "hybrid",
        semanticAvailable: true,
        embeddingRequests: 1,
        queryCacheHits: 0,
        queryCacheMisses: 1
      },
      scopes: {
        campaignCanon: { continuityScratchpad: "The Moon Warden is alert." },
        currentScene: { memoryId: "memory-1" }
      }
    });
    expect(JSON.stringify(preview)).not.toMatch(/diceResult|privateReasoning|credential-secret|embedding\.example/i);
  });

  it("uses the complete legacy preview with an explicit fallback when the current chunk index is not terminal", async () => {
    const queries: Array<{ sql: string; values: readonly unknown[] }> = [];
    const client = databaseClient((sql, values) => {
      queries.push({ sql, values });
      if (sql.includes("FROM campaigns c") && sql.includes("campaign_state")) {
        return { rows: [{
          id: scope.campaignId,
          title: "Fallback Gate",
          active_turn_number: 2,
          world_version_id: scope.worldVersionId,
          selected_character_id: null,
          character_profile_revision: 0,
          world_content: { world: { title: "Fallback Gate" } },
          character_snapshot: null,
          character_profile: null,
          scratchpad_private: "",
          scratchpad_safe_for_prompt: false,
          trackers: []
        }] };
      }
      if (sql.includes("WITH base AS") && sql.includes("chronicle_memories")) {
        return { rows: [{
          id: "legacy-memory",
          turn_id: "turn-2",
          memory_kind: "turn_fiction",
          ordinal: 2,
          content: "Turn 2\nNarration: The fallback gate opens.",
          token_estimate: 12,
          importance: 0.8,
          entities: ["Fallback Gate"],
          entity_ids: ["world:fallback-gate"],
          relevance: 0.4
        }] };
      }
      if (sql.includes("FROM campaign_memory_configs")) {
        return { rows: [{
          embedding_enabled: false,
          embedding_provider_profile_id: null,
          embedding_model: "embed-v1",
          embedding_batch_size: 8,
          embedding_document_prefix: null,
          embedding_query_prefix: null,
          retrieval_implementation: "chunked_hybrid",
          retrieval_shadow_enabled: true
        }] };
      }
      if (sql.includes("AS chunk_index_ready")) {
        return { rows: [{ chunk_index_ready: false }] };
      }
      if (sql.includes("estimated_tokens") && sql.includes("memory_count")) {
        return { rows: [{
          turns: "2", characters: "80", estimated_tokens: "20", memory_count: "1", memory_tokens: "12",
          embedded_memories: "0", turn_memory_tokens: "12", recent_turn_tokens: "12", summary_tokens: "0"
        }] };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const transaction = createPostgresChronicleGenerationTransactionPort({ embeddings: embeddingPort() });

    const preview = await transaction.buildContextPreview(client, {
      ...scope,
      request: { budgetTokens: 4_000, compression: "auto", recentTurns: 2, query: "fallback gate" }
    });

    expect(preview).toMatchObject({
      retrieval: {
        mode: "lexical",
        semanticAvailable: false,
        fallbackReason: "chunk_index_not_ready"
      },
      scopes: { currentScene: { memoryId: "legacy-memory" } }
    });
    expect(queries.some(({ sql }) => sql.includes("AS chunk_index_ready"))).toBe(false);
    expect(queries.some(({ sql }) => sql.includes("chronicle_rank:"))).toBe(false);
  });

  it("creates every chunk rank input only after owner, campaign, version, and cutoff authorization", async () => {
    const rankQueries: string[] = [];
    const memoryQueries: string[] = [];
    const client = databaseClient((sql) => {
      if (sql.includes("FROM campaigns c") && sql.includes("campaign_state")) {
        return { rows: [{
          id: scope.campaignId,
          title: "Authorized Gate",
          active_turn_number: 3,
          world_version_id: scope.worldVersionId,
          selected_character_id: null,
          character_profile_revision: 0,
          world_content: {
            world: { title: "Authorized Gate" },
            entities: [{ id: "moon-warden", name: "Moon Warden", aliases: ["Shade"] }]
          },
          character_snapshot: null,
          character_profile: null,
          scratchpad_private: "",
          scratchpad_safe_for_prompt: false,
          trackers: []
        }] };
      }
      if (sql.includes("WITH base AS") && sql.includes("chronicle_memories")) {
        memoryQueries.push(sql);
        return { rows: [{
          id: "authorized-memory",
          turn_id: "turn-3",
          memory_kind: "turn_fiction",
          ordinal: 3,
          content: "Turn 3\nNarration: The Moon Warden waits at the gate.",
          token_estimate: 14,
          importance: 0.8,
          entities: ["Moon Warden"],
          entity_ids: ["world:moon-warden"],
          relevance: 0.5
        }] };
      }
      if (sql.includes("FROM campaign_canonical_facts")) return { rows: [] };
      if (sql.includes("FROM campaign_memory_configs")) {
        return { rows: [{
          embedding_enabled: true,
          embedding_provider_profile_id: "embedding-profile",
          embedding_model: "embed-v1",
          embedding_batch_size: 8,
          embedding_document_prefix: null,
          embedding_query_prefix: null,
          retrieval_implementation: "chunked_hybrid",
          retrieval_shadow_enabled: false
        }] };
      }
      if (sql.includes("FROM chronicle_query_embedding_cache")) return { rows: [] };
      if (sql.includes("AS chunk_index_ready")) return { rows: [{ chunk_index_ready: true }] };
      // Fused candidate vectors are loaded once per preview instead of being rendered
      // inside every rank query.
      if (sql.includes("embedding::text AS embedding")) return { rows: [] };
      if (sql.includes("chronicle_rank:")) {
        rankQueries.push(sql);
        return { rows: [{
          candidate_id: "authorized-chunk",
          parent_memory_id: "authorized-memory",
          parent_turn_id: "turn-3",
          parent_memory_kind: "turn_fiction",
          parent_ordinal: 3,
          parent_content: "Turn 3\nNarration: The Moon Warden waits at the gate.",
          parent_token_estimate: 14,
          parent_importance: 0.8,
          parent_entities: ["Moon Warden"],
          parent_entity_ids: ["world:moon-warden"],
          parent_metadata: {},
          chunk_ordinal: 0,
          chunk_kind: "turn_narration",
          chunk_content: "The Moon Warden waits at the gate.",
          active_fact: true
        }] };
      }
      if (sql.includes("estimated_tokens") && sql.includes("memory_count")) {
        return { rows: [{
          turns: "3", characters: "120", estimated_tokens: "30", memory_count: "1", memory_tokens: "14",
          embedded_memories: "0", turn_memory_tokens: "14", recent_turn_tokens: "14", summary_tokens: "0"
        }] };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const transaction = createPostgresChronicleGenerationTransactionPort({
      embeddings: embeddingPort({
        resolve: async () => "embedding-profile",
        load: async () => ({
          id: "embedding-profile",
          model: "embed-v1",
          providerType: "openai_compatible",
          configuration: { embeddingDimensions: 2 },
          embed: async () => ({ embeddings: [], responseId: "unused", usage: {}, reportedCost: null })
        }),
        embed: async (_provider, documents) => ({
          embeddings: documents.map(() => [1, 0]),
          responseId: "query-batch",
          usage: {},
          reportedCost: null
        }),
        fingerprint: async () => "fingerprint",
        recordCost: async () => null,
        recordHealth: async () => undefined
      })
    });

    const preview = await transaction.buildContextPreview(client, {
      ...scope,
      request: {
        budgetTokens: 4_000,
        compression: "auto",
        recentTurns: 2,
        query: "Moon Warden",
        throughTurnNumber: 3
      }
    });

    expect(preview).toMatchObject({ retrieval: { implementation: "chunked_hybrid" } });
    expect(memoryQueries.length).toBeGreaterThan(0);
    expect(memoryQueries.every((sql) => sql.includes(
      "CASE WHEN jsonb_typeof(metadata->'structuredFactIds')='array'"
    ))).toBe(true);
    expect(rankQueries.length).toBeGreaterThan(0);
    expect(rankQueries.filter((sql) => sql.includes("chronicle_rank:entity"))).toHaveLength(1);
    for (const sql of rankQueries) {
      const authorization = sql.indexOf("authorized AS MATERIALIZED");
      const ranking = sql.indexOf("ranked AS");
      expect(authorization).toBeGreaterThanOrEqual(0);
      expect(ranking).toBeGreaterThan(authorization);
      expect(sql.slice(authorization, ranking)).toMatch(
        /owner_user_id\s*=\s*\$1[\s\S]*campaign_id\s*=\s*\$2[\s\S]*world_version_id\s*=\s*\$3[\s\S]*parent\.ordinal\s*<=\s*\$4/i
      );
      expect(sql.slice(authorization, ranking)).toContain(
        "CASE WHEN jsonb_typeof(parent.metadata->'structuredFactIds')='array'"
      );
    }
  });

  it("does not derive historical entity ranks from a current character-profile-only alias", async () => {
    const rankQueries: Array<{ sql: string; values: readonly unknown[] }> = [];
    const client = databaseClient((sql, values) => {
      if (sql.includes("FROM campaigns c") && sql.includes("campaign_state")) {
        return { rows: [{
          id: scope.campaignId,
          title: "Historical Alias Gate",
          active_turn_number: 4,
          world_version_id: scope.worldVersionId,
          selected_character_id: "hero",
          character_profile_revision: 2,
          world_content: { world: { title: "Historical Alias Gate" } },
          character_snapshot: { id: "hero", name: "Moon Warden" },
          character_profile: { profile: { identity: { aliases: ["Future Codename"] } } },
          scratchpad_private: "",
          scratchpad_safe_for_prompt: false,
          trackers: []
        }] };
      }
      if (sql.includes("WITH base AS") && sql.includes("chronicle_memories")) {
        return { rows: [{
          id: "historical-memory",
          turn_id: "turn-1",
          memory_kind: "turn_fiction",
          ordinal: 1,
          content: "Turn 1\nNarration: The moonlit court is quiet.",
          token_estimate: 12,
          importance: 0.8,
          entities: ["Moon Warden"],
          entity_ids: ["character:hero"],
          relevance: 0
        }] };
      }
      if (sql.includes("FROM campaign_canonical_facts")) return { rows: [] };
      if (sql.includes("FROM campaign_memory_configs")) {
        return { rows: [{
          embedding_enabled: false,
          embedding_provider_profile_id: null,
          embedding_model: "embed-v1",
          embedding_batch_size: 8,
          embedding_document_prefix: null,
          embedding_query_prefix: null,
          retrieval_implementation: "chunked_hybrid",
          retrieval_shadow_enabled: false
        }] };
      }
      if (sql.includes("AS chunk_index_ready")) return { rows: [{ chunk_index_ready: true }] };
      // Fused candidate vectors are loaded once per preview instead of being rendered
      // inside every rank query.
      if (sql.includes("embedding::text AS embedding")) return { rows: [] };
      if (sql.includes("chronicle_rank:")) {
        rankQueries.push({ sql, values });
        return { rows: [] };
      }
      if (sql.includes("estimated_tokens") && sql.includes("memory_count")) {
        return { rows: [{
          turns: "1", characters: "60", estimated_tokens: "15", memory_count: "1", memory_tokens: "12",
          embedded_memories: "0", turn_memory_tokens: "12", recent_turn_tokens: "12", summary_tokens: "0"
        }] };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const transaction = createPostgresChronicleGenerationTransactionPort({ embeddings: embeddingPort() });

    await transaction.buildContextPreview(client, {
      ...scope,
      request: {
        budgetTokens: 4_000,
        compression: "auto",
        recentTurns: 1,
        query: "Future Codename",
        throughTurnNumber: 1
      }
    });

    expect(rankQueries.filter(({ sql }) => sql.includes("chronicle_rank:entity"))).toHaveLength(0);
    expect(rankQueries.flatMap(({ values }) => values).join("\n")).not.toContain("Moon Warden");
  });

  it("keeps post-cutoff character aliases out of legacy and readiness-fallback provider inputs", async () => {
    for (const retrievalImplementation of ["legacy_hybrid", "chunked_hybrid"] as const) {
      const providerInputs: string[] = [];
      const client = databaseClient((sql) => {
        if (sql.includes("FROM campaigns c") && sql.includes("campaign_state")) {
          return { rows: [{
            id: scope.campaignId,
            title: "Historical Provider Alias Gate",
            active_turn_number: 4,
            world_version_id: scope.worldVersionId,
            selected_character_id: "hero",
            character_profile_revision: 2,
            world_content: { world: { title: "Historical Provider Alias Gate" } },
            character_snapshot: { id: "hero", name: "Moon Warden" },
            character_profile: { profile: { identity: { aliases: ["Future Codename"] } } },
            scratchpad_private: "",
            scratchpad_safe_for_prompt: false,
            trackers: []
          }] };
        }
        if (sql.includes("WITH base AS") && sql.includes("chronicle_memories")) {
          return { rows: [{
            id: "historical-memory",
            turn_id: "turn-1",
            memory_kind: "turn_fiction",
            ordinal: 1,
            content: "Turn 1\nNarration: The moonlit court is quiet.",
            token_estimate: 12,
            importance: 0.8,
            entities: ["Moon Warden"],
            entity_ids: ["character:hero"],
            relevance: 0
          }] };
        }
        if (sql.includes("FROM campaign_canonical_facts")) return { rows: [] };
        if (sql.includes("FROM campaign_memory_configs")) {
          return { rows: [{
            embedding_enabled: true,
            embedding_provider_profile_id: "embedding-profile",
            embedding_model: "embed-v1",
            embedding_batch_size: 8,
            embedding_document_prefix: null,
            embedding_query_prefix: null,
            retrieval_implementation: retrievalImplementation,
            retrieval_shadow_enabled: false
          }] };
        }
        if (sql.includes("AS chunk_index_ready")) return { rows: [{ chunk_index_ready: false }] };
        if (sql.includes("1 - (embedding <=>")) return { rows: [] };
        if (sql.includes("estimated_tokens") && sql.includes("memory_count")) {
          return { rows: [{
            turns: "1", characters: "60", estimated_tokens: "15", memory_count: "1", memory_tokens: "12",
            embedded_memories: "0", turn_memory_tokens: "12", recent_turn_tokens: "12", summary_tokens: "0"
          }] };
        }
        throw new Error(`Unexpected SQL: ${sql}`);
      });
      const transaction = createPostgresChronicleGenerationTransactionPort({
        embeddings: embeddingPort({
          resolve: async () => "embedding-profile",
          load: async () => ({
            id: "embedding-profile",
            model: "embed-v1",
            providerType: "openai_compatible",
            embed: async () => ({ embeddings: [], responseId: "unused", usage: {}, reportedCost: null })
          }),
          embed: async (_provider, documents) => {
            providerInputs.push(...documents);
            return { embeddings: [[1, 0]], responseId: "legacy-query", usage: {}, reportedCost: null };
          },
          fingerprint: async () => "fingerprint",
          recordCost: async () => null,
          recordHealth: async () => undefined
        })
      });

      await transaction.buildContextPreview(client, {
        ...scope,
        request: {
          budgetTokens: 4_000,
          compression: "auto",
          recentTurns: 1,
          query: "Future Codename",
          throughTurnNumber: 1
        }
      });

      expect(providerInputs).toHaveLength(1);
      expect(providerInputs[0]).toContain("Future Codename");
      expect(providerInputs[0]).not.toContain("Moon Warden");
    }
  });

  it("keeps nonsemantic fused candidates out of semantic and lexical diagnostics", async () => {
    const candidate = (id: string, kind: "turn_fiction" | "open_thread", content: string) => ({
      candidate_id: `${id}-chunk`,
      parent_memory_id: id,
      parent_turn_id: kind === "turn_fiction" ? "turn-1" : null,
      parent_memory_kind: kind,
      parent_ordinal: kind === "turn_fiction" ? 1 : 2,
      parent_content: content,
      parent_token_estimate: 12,
      parent_importance: 0.8,
      parent_entities: [],
      parent_entity_ids: [],
      active_fact: true
    });
    const client = databaseClient((sql) => {
      if (sql.includes("FROM campaigns c") && sql.includes("campaign_state")) {
        return { rows: [{
          id: scope.campaignId,
          title: "Signal Diagnostics",
          active_turn_number: 3,
          world_version_id: scope.worldVersionId,
          selected_character_id: null,
          character_profile_revision: 0,
          world_content: { world: { title: "Signal Diagnostics" } },
          character_snapshot: null,
          character_profile: null,
          scratchpad_private: "",
          scratchpad_safe_for_prompt: false,
          trackers: []
        }] };
      }
      if (sql.includes("WITH base AS") && sql.includes("chronicle_memories")) {
        return { rows: [{
          id: "current-memory",
          turn_id: "turn-3",
          memory_kind: "turn_fiction",
          ordinal: 3,
          content: "Turn 3\nNarration: The current scene remains quiet.",
          token_estimate: 12,
          importance: 0.8,
          entities: [],
          entity_ids: [],
          relevance: 0
        }] };
      }
      if (sql.includes("FROM campaign_memory_configs")) {
        return { rows: [{
          embedding_enabled: true,
          embedding_provider_profile_id: "embedding-profile",
          embedding_model: "embed-v1",
          embedding_batch_size: 8,
          embedding_document_prefix: null,
          embedding_query_prefix: null,
          retrieval_implementation: "chunked_hybrid",
          retrieval_shadow_enabled: false
        }] };
      }
      if (sql.includes("AS chunk_index_ready")) return { rows: [{ chunk_index_ready: true }] };
      // Fused candidate vectors are loaded once per preview instead of being rendered
      // inside every rank query.
      if (sql.includes("embedding::text AS embedding")) return { rows: [] };
      if (sql.includes("chronicle_rank:semantic")) {
        return { rows: [candidate("semantic-parent", "turn_fiction", "A semantically related memory.")] };
      }
      if (sql.includes("chronicle_rank:full_text") || sql.includes("chronicle_rank:entity")) return { rows: [] };
      if (sql.includes("chronicle_rank:")) {
        return { rows: [candidate("skipped-parent", "open_thread", "A nonsemantic open thread.")] };
      }
      if (sql.includes("estimated_tokens") && sql.includes("memory_count")) {
        return { rows: [{
          turns: "3", characters: "120", estimated_tokens: "30", memory_count: "1", memory_tokens: "12",
          embedded_memories: "0", turn_memory_tokens: "12", recent_turn_tokens: "12", summary_tokens: "0"
        }] };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const transaction = createPostgresChronicleGenerationTransactionPort({
      embeddings: embeddingPort({
        resolve: async () => "embedding-profile",
        load: async () => ({
          id: "embedding-profile",
          model: "embed-v1",
          providerType: "openai_compatible",
          embed: async () => ({ embeddings: [], responseId: "unused", usage: {}, reportedCost: null })
        }),
        embed: async (_provider, documents) => ({
          embeddings: documents.map(() => [1, 0]),
          responseId: "query-batch",
          usage: {},
          reportedCost: null
        }),
        fingerprint: async () => "fingerprint",
        recordCost: async () => null,
        recordHealth: async () => undefined
      })
    });

    const preview = await transaction.buildContextPreview(client, {
      ...scope,
      request: { budgetTokens: 4_000, compression: "auto", recentTurns: 1, query: "find the old oath" }
    });
    const chronicle = (preview.scopes as { chronicle: Array<Record<string, unknown>> }).chronicle;
    const nonsemantic = chronicle.find((memory) => memory.id === "skipped-parent");

    expect(preview.scopes).toMatchObject({
      currentScene: { memoryId: "current-memory", ordinal: 3 }
    });
    expect(nonsemantic?.relevance).toEqual(expect.any(Number));
    expect(Number(nonsemantic?.relevance)).toBeGreaterThan(0);
    expect(nonsemantic).toMatchObject({ semanticRelevance: 0, lexicalRelevance: 0 });
  });

  it("discards all semantic rank inputs when one query variant fails", async () => {
    let semanticQueries = 0;
    let nonsemanticRankQueries = 0;
    const client = databaseClient((sql) => {
      if (sql.includes("FROM campaigns c") && sql.includes("campaign_state")) {
        return { rows: [{
          id: scope.campaignId,
          title: "Semantic Failure Gate",
          active_turn_number: 2,
          world_version_id: scope.worldVersionId,
          selected_character_id: null,
          character_profile_revision: 0,
          world_content: { world: { title: "Semantic Failure Gate" } },
          character_snapshot: null,
          character_profile: null,
          scratchpad_private: "",
          scratchpad_safe_for_prompt: false,
          trackers: []
        }] };
      }
      if (sql.includes("WITH base AS") && sql.includes("chronicle_memories")) {
        return { rows: [{
          id: "current-memory",
          turn_id: "turn-2",
          memory_kind: "turn_fiction",
          ordinal: 2,
          content: "Turn 2\nNarration: The current scene remains quiet.",
          token_estimate: 12,
          importance: 0.8,
          entities: [],
          entity_ids: [],
          relevance: 0
        }] };
      }
      if (sql.includes("FROM campaign_memory_configs")) {
        return { rows: [{
          embedding_enabled: true,
          embedding_provider_profile_id: "embedding-profile",
          embedding_model: "embed-v1",
          embedding_batch_size: 8,
          embedding_document_prefix: null,
          embedding_query_prefix: null,
          retrieval_implementation: "chunked_hybrid",
          retrieval_shadow_enabled: false
        }] };
      }
      if (sql.includes("AS chunk_index_ready")) return { rows: [{ chunk_index_ready: true }] };
      // Fused candidate vectors are loaded once per preview instead of being rendered
      // inside every rank query.
      if (sql.includes("embedding::text AS embedding")) return { rows: [] };
      if (sql.includes("chronicle_rank:semantic")) {
        semanticQueries += 1;
        if (semanticQueries === 2) throw new Error("second semantic rank failed");
        return { rows: [{
          candidate_id: "partial-semantic-chunk",
          parent_memory_id: "partial-semantic-parent",
          parent_turn_id: "turn-1",
          parent_memory_kind: "turn_fiction",
          parent_ordinal: 1,
          parent_content: "Turn 1\nNarration: Partial semantic content must not survive.",
          parent_token_estimate: 12,
          parent_importance: 0.8,
          parent_entities: [],
          parent_entity_ids: [],
          active_fact: true
        }] };
      }
      // Fused candidate vectors are loaded once per preview instead of being rendered
      // inside every rank query.
      if (sql.includes("embedding::text AS embedding")) return { rows: [] };
      if (sql.includes("chronicle_rank:")) {
        nonsemanticRankQueries += 1;
        return { rows: [] };
      }
      if (sql.includes("estimated_tokens") && sql.includes("memory_count")) {
        return { rows: [{
          turns: "2", characters: "80", estimated_tokens: "20", memory_count: "1", memory_tokens: "12",
          embedded_memories: "0", turn_memory_tokens: "12", recent_turn_tokens: "12", summary_tokens: "0"
        }] };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const transaction = createPostgresChronicleGenerationTransactionPort({
      embeddings: embeddingPort({
        resolve: async () => "embedding-profile",
        load: async () => ({
          id: "embedding-profile",
          model: "embed-v1",
          providerType: "openai_compatible",
          embed: async () => ({ embeddings: [], responseId: "unused", usage: {}, reportedCost: null })
        }),
        embed: async (_provider, documents) => ({
          embeddings: documents.map(() => [1, 0]),
          responseId: "query-batch",
          usage: {},
          reportedCost: null
        }),
        fingerprint: async () => "fingerprint",
        recordCost: async () => null,
        recordHealth: async () => undefined
      })
    });

    const preview = await transaction.buildContextPreview(client, {
      ...scope,
      request: { budgetTokens: 4_000, compression: "auto", recentTurns: 1, query: "quiet scene" }
    });

    expect(semanticQueries).toBe(2);
    expect(preview).toMatchObject({
      retrieval: {
        semanticAvailable: false,
        fallbackReason: "semantic_retrieval_unavailable"
      }
    });
    expect(nonsemanticRankQueries).toBe(0);
    expect(JSON.stringify(preview.scopes)).not.toContain("Partial semantic content must not survive");
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
    const pool = databasePool((sql) => {
      if (sql.includes("SELECT world_version_id FROM campaigns")) {
        return { rows: [{ world_version_id: scope.worldVersionId }] };
      }
      if (sql.includes("FROM campaign_memory_configs")) return { rows: [] };
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
    });
    const configuration = createPostgresChronicleConfigurationRepository(pool);

    await expect(configuration.setEmbeddingConfig(scope, {
      ...input,
      providerProfileId: "image-profile"
    })).rejects.toMatchObject({ statusCode: 400 });
    expect(persisted).toBe(false);
  });

  it("rejects a text provider while a dedicated embedding provider is enabled", async () => {
    let persisted = false;
    const pool = databasePool((sql) => {
      if (sql.includes("SELECT world_version_id FROM campaigns")) {
        return { rows: [{ world_version_id: scope.worldVersionId }] };
      }
      if (sql.includes("FROM campaign_memory_configs")) return { rows: [] };
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
    });
    const configuration = createPostgresChronicleConfigurationRepository(pool);

    await expect(configuration.setEmbeddingConfig(scope, {
      ...input,
      providerProfileId: "text-profile"
    })).rejects.toMatchObject({ statusCode: 400 });
    expect(persisted).toBe(false);
  });

  it("persists the enabled dedicated default when the provider is omitted", async () => {
    let persistedProviderId: unknown;
    const pool = databasePool((sql, values) => {
      if (sql.includes("SELECT world_version_id FROM campaigns")) {
        return { rows: [{ world_version_id: scope.worldVersionId }] };
      }
      if (sql.includes("provider_role = 'embedding'")) {
        return { rows: [{ id: "embedding-default", is_default: true }] };
      }
      if (sql.includes("FROM campaign_memory_configs")) {
        return { rows: [{
          embedding_enabled: false,
          embedding_provider_profile_id: null,
          embedding_model: null,
          embedding_batch_size: 16,
          embedding_document_prefix: null,
          embedding_query_prefix: null,
          retrieval_implementation: "legacy_hybrid",
          retrieval_shadow_enabled: false
        }] };
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
      if (sql.includes("UPDATE chronicle_memory_chunks")) return { rows: [], rowCount: 0 };
      if (sql.includes("JOIN campaign_memory_configs config")) {
        return { rows: [{
          world_version_id: scope.worldVersionId,
          embedding_enabled: true,
          embedding_provider_profile_id: "embedding-default",
          embedding_model: "embed-v1",
          embedding_batch_size: 16,
          embedding_document_prefix: null,
          embedding_query_prefix: null,
          retrieval_implementation: "legacy_hybrid",
          retrieval_shadow_enabled: false
        }] };
      }
      if (sql.includes("INSERT INTO chronicle_chunk_jobs")) return { rows: [{ id: "chunk-job-1" }] };
      throw new Error(`Unexpected SQL: ${sql}`);
    });
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
