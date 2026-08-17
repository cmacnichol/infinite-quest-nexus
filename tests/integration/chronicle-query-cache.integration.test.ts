import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createPostgresChronicleGenerationTransactionPort } from "../../packages/database/src/chronicle-repository.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { createDatabasePool, type DatabaseClient, type DatabasePool, withTransaction } from "../../packages/database/src/pool.js";
import { createPostgresProviderRepositories } from "../../packages/database/src/provider-repository.js";
import {
  createPostgresChronicleQueryCacheRepository,
  type ChronicleQueryEmbeddingCacheKey,
  type ChronicleQueryEmbeddingCacheScope
} from "../../packages/database/src/chronicle-query-cache-repository.js";
import { chronicleContentHash } from "../../packages/domain/src/chronicle-memory-helpers.js";
import {
  evaluateChronicleRetrieval,
  type ChronicleEvaluationReport,
  type ChronicleRetrievalCorpus
} from "../../scripts/lib/chronicle-retrieval-evaluator.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe.sequential : describe.skip;

type CampaignFixture = ChronicleQueryEmbeddingCacheScope & Readonly<{ worldVersionId: string }>;

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

integration("PostgreSQL Chronicle query embedding cache", () => {
  let pool: DatabasePool;
  let ownerUserId = "";
  let campaignA: CampaignFixture;
  let campaignB: CampaignFixture;
  let providerA = "";
  let providerB = "";

  const key = (overrides: Partial<ChronicleQueryEmbeddingCacheKey> = {}): ChronicleQueryEmbeddingCacheKey => ({
    normalizedQueryHash: digest("expanded query"),
    providerProfileId: providerA,
    model: "embed-v1",
    providerFingerprint: "fingerprint-a",
    queryPrefixHash: digest("search_query: "),
    embeddingProtocolVersion: "chronicle-embedding-v1",
    ...overrides
  });

  async function createCampaign(label: string): Promise<CampaignFixture> {
    const world = await pool.query<{ id: string }>(
      "INSERT INTO worlds(owner_user_id,title) VALUES($1,$2) RETURNING id",
      [ownerUserId, `Query cache world ${label}`]
    );
    const version = await pool.query<{ id: string }>(
      "INSERT INTO world_versions(world_id,owner_user_id,version_number,content) VALUES($1,$2,1,$3::jsonb) RETURNING id",
      [world.rows[0]!.id, ownerUserId, JSON.stringify({ world: { title: `Query cache ${label}` }, entities: [] })]
    );
    const campaign = await pool.query<{ id: string }>(
      "INSERT INTO campaigns(owner_user_id,world_version_id,title) VALUES($1,$2,$3) RETURNING id",
      [ownerUserId, version.rows[0]!.id, `Query cache campaign ${label}`]
    );
    await pool.query("INSERT INTO campaign_state(campaign_id,owner_user_id) VALUES($1,$2)", [campaign.rows[0]!.id, ownerUserId]);
    return { ownerUserId, campaignId: campaign.rows[0]!.id, worldVersionId: version.rows[0]!.id };
  }

  async function createEmbeddingProvider(label: string): Promise<string> {
    const result = await pool.query<{ id: string }>(
      `INSERT INTO provider_profiles
         (owner_user_id,name,provider_type,provider_role,base_url,default_model)
       VALUES($1,$2,'openai_compatible','embedding','http://fixture.invalid/v1','embed-v1') RETURNING id`,
      [ownerUserId, `Query cache provider ${label} ${randomUUID()}`]
    );
    return result.rows[0]!.id;
  }

  async function withCache<T>(
    work: (repository: ReturnType<typeof createPostgresChronicleQueryCacheRepository>, client: DatabaseClient) => Promise<T>,
    logDiagnostic = vi.fn(),
  ): Promise<T> {
    return withTransaction(pool, (client) => work(
      createPostgresChronicleQueryCacheRepository(client, { logDiagnostic }),
      client
    ));
  }

  beforeAll(async () => {
    pool = createDatabasePool(databaseUrl!, 4);
    await migrateDatabase(pool, resolve("database/migrations"));
    const owner = await pool.query<{ id: string }>("INSERT INTO users(display_name) VALUES($1) RETURNING id", ["Query cache owner"]);
    ownerUserId = owner.rows[0]!.id;
    campaignA = await createCampaign("a");
    campaignB = await createCampaign("b");
    providerA = await createEmbeddingProvider("a");
    providerB = await createEmbeddingProvider("b");
  });

  afterEach(async () => {
    await pool.query("DELETE FROM chronicle_query_embedding_cache WHERE owner_user_id=$1", [ownerUserId]);
  });

  afterAll(async () => {
    if (!pool) return;
    await pool.query("DELETE FROM users WHERE id=$1", [ownerUserId]).catch(() => undefined);
    await pool.end();
  });

  it("hits only the exact owner, campaign, query, provider, model, fingerprint, prefix, and protocol key", async () => {
    await withCache((cache) => cache.putQueryEmbedding(campaignA, key(), [0.25, 0.75]));
    await expect(withCache((cache) => cache.getQueryEmbedding(campaignA, key()))).resolves.toEqual([0.25, 0.75]);

    const misses: readonly [ChronicleQueryEmbeddingCacheScope, ChronicleQueryEmbeddingCacheKey][] = [
      [{ ownerUserId: randomUUID(), campaignId: campaignA.campaignId }, key()],
      [campaignB, key()],
      [campaignA, key({ normalizedQueryHash: digest("different query") })],
      [campaignA, key({ providerProfileId: providerB })],
      [campaignA, key({ model: "embed-v2" })],
      [campaignA, key({ providerFingerprint: "fingerprint-b" })],
      [campaignA, key({ queryPrefixHash: digest("query: ") })],
      [campaignA, key({ embeddingProtocolVersion: "chronicle-embedding-v2" })]
    ];
    for (const [scope, missKey] of misses) {
      await expect(withCache((cache) => cache.getQueryEmbedding(scope, missKey))).resolves.toBeNull();
    }
    const metadata = await pool.query<{ hit_count: string }>(
      "SELECT hit_count::text FROM chronicle_query_embedding_cache WHERE campaign_id=$1",
      [campaignA.campaignId]
    );
    expect(metadata.rows).toEqual([{ hit_count: "1" }]);
    const storedIdentity = await pool.query<{
      embedding_model_hash: string;
      provider_fingerprint_hash: string;
    }>(
      `SELECT embedding_model_hash,provider_fingerprint_hash
         FROM chronicle_query_embedding_cache WHERE campaign_id=$1`,
      [campaignA.campaignId]
    );
    expect(storedIdentity.rows).toEqual([{
      embedding_model_hash: digest("embed-v1"),
      provider_fingerprint_hash: digest("fingerprint-a")
    }]);
    const columns = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema=current_schema() AND table_name='chronicle_query_embedding_cache'
        ORDER BY ordinal_position`
    );
    expect(columns.rows.map((row) => row.column_name)).not.toEqual(expect.arrayContaining([
      "query", "query_text", "query_prefix", "embedding_model", "provider_fingerprint",
      "prompt", "response", "endpoint", "credential"
    ]));
  });

  it("expires after seven days, validates dimensions, and emits only a fixed best-effort diagnostic", async () => {
    await withCache((cache) => cache.putQueryEmbedding(campaignA, key(), [1, 2, 3]));
    const stored = await pool.query<{ embedding_dimensions: number; lifetime: string }>(
      `SELECT embedding_dimensions,
              (extract(epoch FROM (expires_at-created_at))::integer)::text AS lifetime
         FROM chronicle_query_embedding_cache WHERE campaign_id=$1`,
      [campaignA.campaignId]
    );
    expect(stored.rows).toEqual([{ embedding_dimensions: 3, lifetime: "604800" }]);
    await pool.query(
      "UPDATE chronicle_query_embedding_cache SET expires_at=clock_timestamp()-interval '1 second' WHERE campaign_id=$1",
      [campaignA.campaignId]
    );
    await expect(withCache((cache) => cache.getQueryEmbedding(campaignA, key()))).resolves.toBeNull();

    const diagnostics = vi.fn(() => { throw new Error("diagnostic sink unavailable"); });
    await expect(withCache(
      (cache) => cache.putQueryEmbedding(campaignA, key({ normalizedQueryHash: digest("invalid") }), [1, Number.NaN]),
      diagnostics
    )).resolves.toBeUndefined();
    expect(diagnostics).toHaveBeenCalledWith(
      expect.objectContaining({ message: "chronicle_query_embedding_cache_failed" }),
      expect.objectContaining({ campaignId: campaignA.campaignId, cacheOperation: "put" })
    );
    const remaining = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM chronicle_query_embedding_cache WHERE campaign_id=$1",
      [campaignA.campaignId]
    );
    expect(remaining.rows[0]?.count).toBe("1");
  });

  it("recovers cache SQL failures without aborting the caller transaction", async () => {
    const diagnostics = vi.fn();
    await withTransaction(pool, async (client) => {
      const cache = createPostgresChronicleQueryCacheRepository(client, { logDiagnostic: diagnostics });
      await expect(cache.putQueryEmbedding(
        campaignA,
        key({ providerProfileId: randomUUID(), normalizedQueryHash: digest("missing provider") }),
        [1, 0]
      )).resolves.toBeUndefined();
      await expect(cache.getQueryEmbedding(
        campaignA,
        key({ providerProfileId: "not-a-uuid", normalizedQueryHash: digest("invalid provider") })
      )).resolves.toBeNull();
      await expect(client.query("SELECT 1 AS caller_transaction_usable"))
        .resolves.toMatchObject({ rows: [{ caller_transaction_usable: 1 }] });
    });
    expect(diagnostics).toHaveBeenCalledTimes(2);
    expect(diagnostics).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ message: "chronicle_query_embedding_cache_failed" }),
      expect.objectContaining({ campaignId: campaignA.campaignId, cacheOperation: "put" })
    );
    expect(diagnostics).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ message: "chronicle_query_embedding_cache_failed" }),
      expect.objectContaining({ campaignId: campaignA.campaignId, cacheOperation: "get" })
    );
  });

  it("keeps the 256 most recently used entries after each insert", async () => {
    for (let index = 0; index < 256; index += 1) {
      await withCache((cache) => cache.putQueryEmbedding(
        campaignA,
        key({ normalizedQueryHash: digest(`query-${index}`) }),
        [index, index + 1]
      ));
    }
    await expect(withCache((cache) => cache.getQueryEmbedding(
      campaignA,
      key({ normalizedQueryHash: digest("query-0") })
    ))).resolves.toEqual([0, 1]);
    await withCache((cache) => cache.putQueryEmbedding(
      campaignA,
      key({ normalizedQueryHash: digest("query-256") }),
      [256, 257]
    ));

    await expect(withCache((cache) => cache.getQueryEmbedding(
      campaignA,
      key({ normalizedQueryHash: digest("query-0") })
    ))).resolves.toEqual([0, 1]);
    await expect(withCache((cache) => cache.getQueryEmbedding(
      campaignA,
      key({ normalizedQueryHash: digest("query-1") })
    ))).resolves.toBeNull();
    const count = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM chronicle_query_embedding_cache WHERE campaign_id=$1",
      [campaignA.campaignId]
    );
    expect(count.rows[0]?.count).toBe("256");
  }, 30_000);

  it("invalidates on provider update/delete while cache deletion cannot delete its campaign or provider", async () => {
    const updateProviderId = await createEmbeddingProvider("update");
    const deleteProviderId = await createEmbeddingProvider("delete");
    await withCache(async (cache) => {
      await cache.putQueryEmbedding(campaignA, key({ providerProfileId: updateProviderId }), [1, 0]);
      await cache.putQueryEmbedding(campaignA, key({ providerProfileId: deleteProviderId }), [0, 1]);
    });
    await pool.query("DELETE FROM chronicle_query_embedding_cache WHERE provider_profile_id=$1", [updateProviderId]);
    expect((await pool.query("SELECT id FROM campaigns WHERE id=$1", [campaignA.campaignId])).rowCount).toBe(1);
    expect((await pool.query("SELECT id FROM provider_profiles WHERE id=$1", [updateProviderId])).rowCount).toBe(1);
    await withCache((cache) => cache.putQueryEmbedding(campaignA, key({ providerProfileId: updateProviderId }), [1, 0]));

    await withTransaction(pool, async (client) => {
      await createPostgresProviderRepositories(client).profiles.updateProfile({
        ownerUserId,
        providerProfileId: updateProviderId,
        changes: { name: "Updated query cache provider" }
      });
    });
    expect((await pool.query(
      "SELECT id FROM chronicle_query_embedding_cache WHERE provider_profile_id=$1",
      [updateProviderId]
    )).rowCount).toBe(0);

    await withTransaction(pool, async (client) => {
      await createPostgresProviderRepositories(client).profiles.deleteProfile({ ownerUserId, providerProfileId: deleteProviderId });
    });
    expect((await pool.query(
      "SELECT id FROM chronicle_query_embedding_cache WHERE provider_profile_id=$1",
      [deleteProviderId]
    )).rowCount).toBe(0);

    const cascadingCampaign = await createCampaign("cascade");
    await withCache((cache) => cache.putQueryEmbedding(cascadingCampaign, key(), [1, 1]));
    await pool.query("DELETE FROM campaigns WHERE id=$1 AND owner_user_id=$2", [cascadingCampaign.campaignId, ownerUserId]);
    expect((await pool.query(
      "SELECT id FROM chronicle_query_embedding_cache WHERE campaign_id=$1",
      [cascadingCampaign.campaignId]
    )).rowCount).toBe(0);
  });

  it("reuses a context-preview query and preserves evaluator rankings with fewer provider requests", async () => {
    const fixture = await createCampaign("context");
    await pool.query(
      `INSERT INTO campaign_memory_configs
         (campaign_id,owner_user_id,embedding_enabled,embedding_provider_profile_id,embedding_model)
       VALUES($1,$2,true,$3,'embed-v1')`,
      [fixture.campaignId, ownerUserId, providerA]
    );
    const content = "The silver beacon marks the safe crossing.";
    const memory = await pool.query<{ id: string }>(
      `INSERT INTO chronicle_memories
         (owner_user_id,campaign_id,world_version_id,memory_kind,ordinal,content,token_estimate,
          embedding,embedding_provider_profile_id,embedding_model,embedding_dimensions,
          embedding_content_hash,embedding_updated_at,embedding_provider_fingerprint)
       VALUES($1,$2,$3,'campaign_summary',1,$4,9,'[1,0]'::vector,$5,'embed-v1',2,$6,now(),'context-fingerprint')
       RETURNING id`,
      [ownerUserId, fixture.campaignId, fixture.worldVersionId, content, providerA, chronicleContentHash(content)]
    );
    let providerRequests = 0;
    const generation = createPostgresChronicleGenerationTransactionPort({
      embeddings: {
        async resolve() { return { status: "resolved" as const, resolutionSource: "dedicated_embedding" as const, resolvedRole: "embedding" as const, providerProfileId: providerA, providerType: "openai_compatible", model: "embed-v1" }; },
        async load() {
          return {
            id: providerA,
            model: "embed-v1",
            providerType: "openai_compatible",
            async embed(documents: readonly string[]) {
              providerRequests += 1;
              return { embeddings: documents.map(() => [1, 0]), responseId: "query", usage: {}, reportedCost: null };
            }
          };
        },
        async embed(provider, documents) { return provider.embed(documents); },
        async fingerprint() { return "context-fingerprint"; },
        async recordHealth() {},
        async recordCost() { return null; },
        logDiagnostic() {}
      }
    });
    const previewScope = {
      ...fixture,
      request: { budgetTokens: 4_096, compression: "auto" as const, query: "Where is the safe crossing?", recentTurns: 2 }
    };
    const firstPreview = await withTransaction(pool, (client) => generation.buildContextPreview(client, previewScope));
    const secondPreview = await withTransaction(pool, (client) => generation.buildContextPreview(client, previewScope));
    expect(firstPreview.retrieval).toMatchObject({ embeddingRequests: 1, queryCacheHits: 0, queryCacheMisses: 1 });
    expect(secondPreview.retrieval).toMatchObject({ embeddingRequests: 0, queryCacheHits: 1, queryCacheMisses: 0 });
    expect(firstPreview.chronicleRetrieval).toMatchObject({ queryVectorPath: "provider_only", providerCallOutcome: "succeeded" });
    expect(secondPreview.chronicleRetrieval).toMatchObject({ queryVectorPath: "cache_only", providerCallOutcome: "not_attempted" });
    expect(secondPreview.scopes).toEqual(firstPreview.scopes);
    expect(providerRequests).toBe(1);

    const caseDistinctPreview = await withTransaction(pool, (client) => generation.buildContextPreview(client, {
      ...previewScope,
      request: { ...previewScope.request, query: "WHERE IS THE SAFE CROSSING?" }
    }));
    expect(caseDistinctPreview.retrieval).toMatchObject({
      embeddingRequests: 1,
      queryCacheHits: 0,
      queryCacheMisses: 1
    });
    expect(providerRequests).toBe(2);

    await pool.query("DELETE FROM chronicle_query_embedding_cache WHERE campaign_id=$1", [fixture.campaignId]);
    const corpus: ChronicleRetrievalCorpus = {
      version: "query-cache-v1",
      cases: [{
        id: "same-campaign-retry",
        scope: previewScope,
        expectedLabels: ["safe-crossing"],
        labelByMemoryId: { [memory.rows[0]!.id]: "safe-crossing" }
      }]
    };
    const run = () => {
      const times = [10, 20];
      return withTransaction(pool, (client) => evaluateChronicleRetrieval(
        { generation },
        client,
        corpus,
        { implementation: "legacy_hybrid", now: () => times.shift() ?? 20 }
      ));
    };
    const first = await run();
    const second = await run();
    expect(first.metrics.embedding.requests).toBe(1);
    expect(second.metrics.embedding.requests).toBe(0);
    const comparable = (report: ChronicleEvaluationReport) => ({
      ...report,
      cases: report.cases.map(({ latencyMs: _latency, embeddingRequests: _requests, ...value }) => value),
      metrics: {
        ...report.metrics,
        latencyMs: undefined,
        embedding: { ...report.metrics.embedding, requests: undefined }
      }
    });
    expect(comparable(second)).toEqual(comparable(first));
  });
});
