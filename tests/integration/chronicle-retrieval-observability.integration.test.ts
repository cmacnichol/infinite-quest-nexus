import { resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import * as memoryContracts from "../../packages/contracts/src/memory.js";
import {
  createPostgresChronicleGenerationTransactionPort,
  createPostgresChronicleQueryRepository
} from "../../packages/database/src/chronicle-repository.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import {
  createDatabasePool,
  initialOwnerId,
  type DatabasePool,
  withTransaction
} from "../../packages/database/src/pool.js";
import {
  CHRONICLE_EMBEDDING_PROTOCOL_VERSION,
  chronicleContentHash,
  modelAwareEmbeddingPrefixes,
  providerModelFingerprint
} from "../../packages/domain/src/chronicle-memory-helpers.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe.sequential : describe.skip;

type Fixture = Readonly<{
  campaignId: string;
  worldId: string;
  worldVersionId: string;
}>;

const safeCandidate = {
  candidateId: "11111111-1111-4111-8111-111111111111",
  parentMemoryId: "22222222-2222-4222-8222-222222222222",
  rank: 1,
  reason: "full_text",
  tokenEstimate: 12,
  selected: true
} as const;

integration("Chronicle retrieval observability", () => {
  let pool: DatabasePool;
  let ownerUserId = "";

  beforeAll(async () => {
    pool = createDatabasePool(databaseUrl!, 6);
    await migrateDatabase(pool, resolve("database/migrations"));
    ownerUserId = await initialOwnerId(pool);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await pool.query("DELETE FROM campaigns");
    await pool.query("DELETE FROM provider_profiles");
    await pool.query("DELETE FROM world_versions");
    await pool.query("DELETE FROM worlds");
  });

  afterAll(async () => {
    await pool?.end();
  });

  async function fixture(label: string): Promise<Fixture> {
    const world = await pool.query<{ id: string }>(
      "INSERT INTO worlds (owner_user_id,title) VALUES ($1,$2) RETURNING id",
      [ownerUserId, `${label} world`]
    );
    const worldVersion = await pool.query<{ id: string }>(
      `INSERT INTO world_versions (world_id,owner_user_id,version_number,content)
       VALUES ($1,$2,1,$3::jsonb) RETURNING id`,
      [world.rows[0]!.id, ownerUserId, JSON.stringify({
        world: { title: `${label} world`, rules: "Only accepted fiction is authoritative." },
        entities: []
      })]
    );
    const campaign = await pool.query<{ id: string }>(
      "INSERT INTO campaigns (owner_user_id,world_version_id,title) VALUES ($1,$2,$3) RETURNING id",
      [ownerUserId, worldVersion.rows[0]!.id, `${label} campaign`]
    );
    await pool.query(
      "INSERT INTO campaign_state (campaign_id,owner_user_id) VALUES ($1,$2)",
      [campaign.rows[0]!.id, ownerUserId]
    );
    return {
      campaignId: campaign.rows[0]!.id,
      worldId: world.rows[0]!.id,
      worldVersionId: worldVersion.rows[0]!.id
    };
  }

  function safeRun(value: Readonly<{
    campaignId: string;
    worldVersionId: string;
    comparisons?: readonly unknown[];
  }>) {
    return {
      ownerUserId,
      campaignId: value.campaignId,
      worldVersionId: value.worldVersionId,
      queryHash: "a".repeat(64),
      productionImplementation: "legacy_hybrid",
      shadowEnabled: false,
      retrievalVersion: "chronicle-retrieval-v1",
      embeddingProtocolVersion: "chronicle-embedding-v1",
      chunkProtocolVersion: "chronicle-chunk-v1",
      providerFingerprint: "b".repeat(64),
      queryTokenEstimate: 7,
      costIds: ["33333333-3333-4333-8333-333333333333"],
      comparisons: value.comparisons ?? [{
        implementation: "legacy_hybrid",
        latencyMs: 4,
        fallbackCode: null,
        selectedForProduction: true,
        candidates: [safeCandidate]
      }]
    };
  }

  it("uses a closed telemetry schema that rejects every raw or secret-bearing field", () => {
    const schema = (memoryContracts as unknown as Record<string, unknown>).chronicleRetrievalRunSchema as {
      safeParse(value: unknown): { success: boolean };
    } | undefined;
    expect(schema).toBeDefined();
    const base = safeRun({
      campaignId: "44444444-4444-4444-8444-444444444444",
      worldVersionId: "55555555-5555-4555-8555-555555555555"
    });
    expect(schema!.safeParse(base).success).toBe(true);
    expect(schema!.safeParse({ ...base, shadowEnabled: true }).success).toBe(false);

    for (const forbidden of ["query", "action", "narration", "prompt", "response", "credential"] as const) {
      expect(schema!.safeParse({ ...base, [forbidden]: `private-${forbidden}` }).success, forbidden).toBe(false);
      expect(schema!.safeParse({
        ...base,
        comparisons: [{
          ...(base.comparisons[0] as Record<string, unknown>),
          [forbidden]: `private-${forbidden}`
        }]
      }).success, `comparison.${forbidden}`).toBe(false);
      expect(schema!.safeParse({
        ...base,
        comparisons: [{
          ...(base.comparisons[0] as Record<string, unknown>),
          candidates: [{ ...safeCandidate, [forbidden]: `private-${forbidden}` }]
        }]
      }).success, `candidate.${forbidden}`).toBe(false);
    }
  });

  it("executes migration 0074 and prunes expired and over-limit campaign runs atomically", async () => {
    const current = await fixture("observability retention");
    const migration = await pool.query<{ name: string }>(
      "SELECT name FROM schema_migrations WHERE name = '0074_chronicle_retrieval_observability'"
    );
    expect(migration.rows).toEqual([{ name: "0074_chronicle_retrieval_observability" }]);

    const parent = await pool.query<{ id: string }>(
      `INSERT INTO chronicle_memories
         (owner_user_id,campaign_id,world_version_id,memory_kind,ordinal,content,token_estimate)
       VALUES ($1,$2,$3,'campaign_summary',1,'Safe retention parent.',5) RETURNING id`,
      [ownerUserId, current.campaignId, current.worldVersionId]
    );
    const retainedCandidate = {
      ...safeCandidate,
      candidateId: parent.rows[0]!.id,
      parentMemoryId: parent.rows[0]!.id
    };
    const firstRun = safeRun({
      ...current,
      comparisons: [{
        implementation: "legacy_hybrid",
        latencyMs: 4,
        fallbackCode: null,
        selectedForProduction: true,
        candidates: [retainedCandidate]
      }]
    });

    const repository = await import("../../packages/database/src/chronicle-retrieval-observability-repository.js");
    await repository.recordRetrievalComparison(pool, firstRun);
    await pool.query(
      "UPDATE chronicle_retrieval_runs SET created_at = now() - interval '31 days' WHERE campaign_id = $1",
      [current.campaignId]
    );
    await pool.query(
      `INSERT INTO chronicle_retrieval_runs (
         owner_user_id,campaign_id,world_version_id,query_hash,production_implementation,shadow_enabled,
         retrieval_version,embedding_protocol_version,chunk_protocol_version,query_token_estimate,created_at
       )
       SELECT $1,$2,$3,encode(digest(value::text,'sha256'),'hex'),'legacy_hybrid',true,
              'chronicle-retrieval-v1','chronicle-embedding-v1','chronicle-chunk-v1',1,
              now() - (value::text || ' milliseconds')::interval
         FROM generate_series(1,5000) value`,
      [ownerUserId, current.campaignId, current.worldVersionId]
    );

    await repository.recordRetrievalComparison(pool, {
      ...firstRun,
      queryHash: "c".repeat(64),
      costIds: [],
      comparisons: [{
        implementation: "legacy_hybrid",
        latencyMs: 8,
        fallbackCode: "provider_unavailable",
        selectedForProduction: true,
        candidates: [retainedCandidate]
      }]
    });

    const retained = await pool.query<{ count: string; expired: string }>(
      `SELECT count(*)::text AS count,
              count(*) FILTER (WHERE created_at < now() - interval '30 days')::text AS expired
         FROM chronicle_retrieval_runs WHERE campaign_id = $1`,
      [current.campaignId]
    );
    expect(retained.rows[0]).toEqual({ count: "5000", expired: "0" });

    const candidateCount = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM chronicle_retrieval_candidates WHERE campaign_id = $1",
      [current.campaignId]
    );
    expect(candidateCount.rows[0]).toEqual({ count: "1" });

    await pool.query("DELETE FROM campaigns WHERE id = $1", [current.campaignId]);
    await expect(pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM chronicle_retrieval_runs WHERE campaign_id = $1",
      [current.campaignId]
    )).resolves.toMatchObject({ rows: [{ count: "0" }] });
    await expect(pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM chronicle_retrieval_candidates WHERE campaign_id = $1",
      [current.campaignId]
    )).resolves.toMatchObject({ rows: [{ count: "0" }] });
  });

  it("does not report incompatible chunk vectors healthy and falls open to lexical ranking", async () => {
    const current = await fixture("vector compatibility health");
    const providerConfiguration = { embeddingDimensions: 2 };
    const provider = await pool.query<{ id: string }>(
      `INSERT INTO provider_profiles
         (owner_user_id,name,provider_type,provider_role,base_url,default_model,configuration,health_status)
       VALUES ($1,$2,'openai_compatible','embedding','http://compatibility.invalid/v1',
               'compatibility-model',$3::jsonb,'healthy')
       RETURNING id`,
      [ownerUserId, "Current compatibility provider", JSON.stringify(providerConfiguration)]
    );
    const incompatibleProvider = await pool.query<{ id: string }>(
      `INSERT INTO provider_profiles
         (owner_user_id,name,provider_type,provider_role,base_url,default_model,health_status)
       VALUES ($1,$2,'openai_compatible','embedding','http://stale-compatibility.invalid/v1',
               'compatibility-model','healthy')
       RETURNING id`,
      [ownerUserId, "Stale compatibility provider"]
    );
    const providerId = provider.rows[0]!.id;
    const currentFingerprint = providerModelFingerprint({
      providerType: "openai_compatible",
      baseUrl: providerId,
      model: "compatibility-model",
      configuration: providerConfiguration,
      protocolVersion: CHRONICLE_EMBEDDING_PROTOCOL_VERSION
    }, modelAwareEmbeddingPrefixes("compatibility-model", null, null));
    await pool.query(
      `INSERT INTO campaign_memory_configs
         (campaign_id,owner_user_id,embedding_enabled,embedding_provider_profile_id,embedding_model,
          retrieval_implementation,retrieval_shadow_enabled,updated_at)
       VALUES ($1,$2,true,$3,'compatibility-model','chunked_hybrid',false,clock_timestamp())`,
      [current.campaignId, ownerUserId, providerId]
    );

    const mismatches = [
      {
        providerProfileId: incompatibleProvider.rows[0]!.id,
        model: "compatibility-model",
        dimensions: 2,
        vector: "[1,0]",
        protocolVersion: CHRONICLE_EMBEDDING_PROTOCOL_VERSION,
        fingerprint: currentFingerprint
      },
      {
        providerProfileId: providerId,
        model: "stale-compatibility-model",
        dimensions: 2,
        vector: "[1,0]",
        protocolVersion: CHRONICLE_EMBEDDING_PROTOCOL_VERSION,
        fingerprint: currentFingerprint
      },
      {
        providerProfileId: providerId,
        model: "compatibility-model",
        dimensions: 3,
        vector: "[1,0,0]",
        protocolVersion: CHRONICLE_EMBEDDING_PROTOCOL_VERSION,
        fingerprint: currentFingerprint
      },
      {
        providerProfileId: providerId,
        model: "compatibility-model",
        dimensions: 2,
        vector: "[1,0]",
        protocolVersion: "chronicle-embedding-v0",
        fingerprint: currentFingerprint
      },
      {
        providerProfileId: providerId,
        model: "compatibility-model",
        dimensions: 2,
        vector: "[1,0]",
        protocolVersion: CHRONICLE_EMBEDDING_PROTOCOL_VERSION,
        fingerprint: "stale-provider-fingerprint"
      }
    ] as const;
    for (const [index, mismatch] of mismatches.entries()) {
      const content = `Astral key compatibility record ${index + 1}.`;
      const turn = await pool.query<{ id: string }>(
        `INSERT INTO turns (owner_user_id,campaign_id,turn_number,action,narration)
         VALUES ($1,$2,$3,'Compatibility fixture action',$4) RETURNING id`,
        [ownerUserId, current.campaignId, index + 1, content]
      );
      const memory = await pool.query<{ id: string; content_hash: string }>(
        `INSERT INTO chronicle_memories
           (owner_user_id,campaign_id,world_version_id,turn_id,memory_kind,ordinal,content,token_estimate,importance)
         VALUES ($1,$2,$3,$4,'turn_fiction',$5,$6,8,0.8)
         RETURNING id,content_hash`,
        [ownerUserId, current.campaignId, current.worldVersionId, turn.rows[0]!.id, index + 1, content]
      );
      await pool.query(
        `INSERT INTO chronicle_memory_chunks
           (owner_user_id,campaign_id,world_version_id,parent_memory_id,parent_content_hash,
            chunking_protocol_version,chunk_ordinal,chunk_kind,content,source_start_offset,source_end_offset,
            token_estimate,embedding,embedding_status,embedding_provider_profile_id,embedding_model,
            embedding_dimensions,embedding_protocol_version,embedding_provider_fingerprint,
            embedding_content_hash,embedding_updated_at)
         VALUES ($1,$2,$3,$4,$5,'chronicle-chunk-v1',0,'turn_narration',$6,0,length($6),8,
                 $7::vector,'embedded',$8,$9,$10,$11,$12,$13,clock_timestamp())`,
        [ownerUserId, current.campaignId, current.worldVersionId, memory.rows[0]!.id,
          memory.rows[0]!.content_hash, content, mismatch.vector, mismatch.providerProfileId,
          mismatch.model, mismatch.dimensions, mismatch.protocolVersion, mismatch.fingerprint,
          chronicleContentHash(content)]
      );
    }
    await pool.query(
      `INSERT INTO chronicle_chunk_jobs
         (owner_user_id,campaign_id,status,progress,completed_at,created_at,updated_at)
       VALUES ($1,$2,'completed',$3::jsonb,clock_timestamp(),clock_timestamp(),clock_timestamp())`,
      [ownerUserId, current.campaignId, JSON.stringify({
        processedParents: mismatches.length,
        totalParents: mismatches.length,
        embeddedChunks: mismatches.length,
        skippedChunks: 0
      })]
    );

    const queryRepository = createPostgresChronicleQueryRepository(pool, {
      embeddings: {
        async resolve() { return providerId; },
        async load() {
          return {
            id: providerId,
            model: "compatibility-model",
            providerType: "openai_compatible",
            configuration: providerConfiguration,
            async embed(documents: readonly string[]) {
              return {
                embeddings: documents.map(() => [1, 0]),
                responseId: "compatibility-response",
                usage: {},
                reportedCost: null
              };
            }
          };
        },
        async embed(loaded, documents) { return loaded.embed(documents); },
        async fingerprint() { return currentFingerprint; },
        async recordHealth() {},
        async recordCost() { return null; },
        logDiagnostic() {}
      }
    });
    const memoryScope = {
      ownerUserId,
      campaignId: current.campaignId,
      worldVersionId: current.worldVersionId
    };
    const metrics = await queryRepository.getMetrics(memoryScope);
    if ("failure" in metrics) throw new Error("Expected Chronicle metrics for the compatibility fixture.");
    expect(metrics.semanticHealth).toMatchObject({
      status: "rebuild_required",
      indexedMemories: 0,
      totalMemories: mismatches.length
    });

    const preview = await queryRepository.previewContext(memoryScope, {
      budgetTokens: 4_096,
      compression: "auto",
      query: "Where is the astral key?",
      recentTurns: 2
    });
    if ("failure" in preview) throw new Error("Expected Chronicle preview for the compatibility fixture.");
    expect(preview.retrieval).toMatchObject({
      implementation: "chunked_hybrid",
      mode: "lexical_fallback",
      semanticAvailable: false,
      fallbackReason: "incompatible_chunk_embeddings",
      embeddedCandidates: 0
    });
    const scopes = preview.scopes as { chronicle: readonly unknown[] };
    expect(scopes.chronicle.length).toBeGreaterThan(0);
  });

  it("runs lexical, legacy, and chunked comparisons while preserving the configured production selection", async () => {
    const current = await fixture("shadow isolation");
    const provider = await pool.query<{ id: string }>(
      `INSERT INTO provider_profiles
         (owner_user_id,name,provider_type,provider_role,base_url,default_model,health_status)
       VALUES ($1,$2,'openai_compatible','embedding','http://shadow.invalid/v1','shadow-model','healthy')
       RETURNING id`,
      [ownerUserId, "Shadow provider"]
    );
    const providerId = provider.rows[0]!.id;
    await pool.query(
      `INSERT INTO campaign_memory_configs
         (campaign_id,owner_user_id,embedding_enabled,embedding_provider_profile_id,embedding_model,
          retrieval_implementation,retrieval_shadow_enabled)
       VALUES ($1,$2,true,$3,'shadow-model','chunked_hybrid',false)`,
      [current.campaignId, ownerUserId, providerId]
    );
    const rows = [] as Array<{ id: string; contentHash: string }>;
    for (const [ordinal, kind, chunkKind, content, vector] of [
      [1, "campaign_summary", "campaign_summary", "The brass observatory key rests beneath the moon chart.", "[1,0]"],
      [2, "open_thread", "open_thread", "Rain drums against the sealed western gate.", "[0,1]"]
    ] as const) {
      const memory = await pool.query<{ id: string; content_hash: string }>(
        `INSERT INTO chronicle_memories
           (owner_user_id,campaign_id,world_version_id,memory_kind,ordinal,content,token_estimate,importance,
            embedding,embedding_provider_profile_id,embedding_model,embedding_dimensions,
            embedding_content_hash,embedding_updated_at,embedding_provider_fingerprint)
         VALUES ($1,$2,$3,$4,$5,$6,12,0.8,$7::vector,$8,'shadow-model',2,$9,now(),$10)
         RETURNING id,content_hash`,
        [ownerUserId, current.campaignId, current.worldVersionId, kind, ordinal, content, vector, providerId,
          chronicleContentHash(content), "shadow-fingerprint"]
      );
      rows.push({ id: memory.rows[0]!.id, contentHash: memory.rows[0]!.content_hash });
      await pool.query(
        `INSERT INTO chronicle_memory_chunks
           (owner_user_id,campaign_id,world_version_id,parent_memory_id,parent_content_hash,
            chunking_protocol_version,chunk_ordinal,chunk_kind,content,source_start_offset,source_end_offset,
            token_estimate,embedding,embedding_status,embedding_provider_profile_id,embedding_model,
            embedding_dimensions,embedding_protocol_version,embedding_provider_fingerprint,
            embedding_content_hash,embedding_updated_at)
         VALUES ($1,$2,$3,$4,$5,'chronicle-chunk-v1',0,$6,$7,0,length($7),12,
                 $8::vector,'embedded',$9,'shadow-model',2,'chronicle-embedding-v1',$10,$11,now())`,
        [ownerUserId, current.campaignId, current.worldVersionId, memory.rows[0]!.id,
          memory.rows[0]!.content_hash, chunkKind, content, vector, providerId, "shadow-fingerprint", chronicleContentHash(content)]
      );
    }

    const embeddedQueries: string[][] = [];
    const diagnostics: unknown[] = [];
    const privateShadowFailure = "private_shadow_resolution_detail_must_not_escape";
    const privateProviderFailure = "Bearer private-shadow-provider-secret must not escape";
    let remainingSuccessfulResolutions = Number.POSITIVE_INFINITY;
    let remainingSuccessfulEmbeddings = Number.POSITIVE_INFINITY;
    let diagnosticLoggerThrows = false;
    const generation = createPostgresChronicleGenerationTransactionPort({
      embeddings: {
        async resolve(database, request) {
          if (request.selectedProviderProfileId !== providerId) return null;
          if (remainingSuccessfulResolutions <= 0) {
            await (database as { query(sql: string): Promise<unknown> }).query(`SELECT * FROM ${privateShadowFailure}`);
          }
          remainingSuccessfulResolutions -= 1;
          return providerId;
        },
        async load() {
          return {
            id: providerId,
            model: "shadow-model",
            providerType: "openai_compatible",
            async embed(documents: readonly string[]) {
              return { embeddings: documents.map(() => [1, 0]), responseId: "shadow-response", usage: {}, reportedCost: null };
            }
          };
        },
        async embed(loaded, documents) {
          if (remainingSuccessfulEmbeddings <= 0) throw new Error(privateProviderFailure);
          remainingSuccessfulEmbeddings -= 1;
          embeddedQueries.push([...documents]);
          return loaded.embed(documents);
        },
        async fingerprint() { return "shadow-fingerprint"; },
        async recordHealth() {},
        async recordCost() { return null; },
        logDiagnostic(error) {
          if (diagnosticLoggerThrows) throw new Error("diagnostic sink unavailable");
          diagnostics.push(error);
        }
      }
    });
    const scope = {
      ownerUserId,
      campaignId: current.campaignId,
      worldVersionId: current.worldVersionId,
      request: {
        budgetTokens: 4_096,
        compression: "auto" as const,
        query: "Where is the observatory key?",
        recentTurns: 2
      }
    };

    remainingSuccessfulResolutions = 1;
    const withoutShadow = await withTransaction(pool, (database) => generation.buildContextPreview(database, scope));
    remainingSuccessfulResolutions = Number.POSITIVE_INFINITY;
    remainingSuccessfulEmbeddings = 0;
    const productionFallbackWithPrivateProviderFailure = await withTransaction(
      pool,
      (database) => generation.buildContextPreview(database, scope)
    );
    expect(productionFallbackWithPrivateProviderFailure.retrieval).toMatchObject({
      implementation: "chunked_hybrid",
      mode: "lexical_fallback",
      semanticAvailable: false
    });
    expect(diagnostics.at(-1)).toMatchObject({ message: "chronicle_retrieval_failed" });
    expect(JSON.stringify(diagnostics)).not.toContain(privateProviderFailure);
    diagnostics.length = 0;
    diagnosticLoggerThrows = true;
    const fallbackDespiteDiagnosticFailure = await withTransaction(
      pool,
      (database) => generation.buildContextPreview(database, scope)
    );
    expect(fallbackDespiteDiagnosticFailure.retrieval).toMatchObject({
      implementation: "chunked_hybrid",
      mode: "lexical_fallback",
      semanticAvailable: false
    });
    remainingSuccessfulResolutions = 0;
    remainingSuccessfulEmbeddings = Number.POSITIVE_INFINITY;
    const fallbackDespiteProductionSqlFailure = await withTransaction(
      pool,
      (database) => generation.buildContextPreview(database, scope)
    );
    expect(fallbackDespiteProductionSqlFailure.retrieval).toMatchObject({
      implementation: "chunked_hybrid",
      mode: "lexical_fallback",
      semanticAvailable: false
    });
    remainingSuccessfulEmbeddings = Number.POSITIVE_INFINITY;
    diagnosticLoggerThrows = false;
    await pool.query(
      "UPDATE campaign_memory_configs SET retrieval_shadow_enabled = true WHERE campaign_id = $1",
      [current.campaignId]
    );
    remainingSuccessfulResolutions = 1;
    const withShadow = await withTransaction(pool, (database) => generation.buildContextPreview(database, scope));

    expect(withShadow.scopes).toEqual(withoutShadow.scopes);
    expect(withShadow.retrieval).toMatchObject({ implementation: "chunked_hybrid" });
    expect(embeddedQueries).toHaveLength(2);
    expect(diagnostics).toEqual([expect.objectContaining({ message: "chronicle_retrieval_shadow_failed" })]);
    expect(JSON.stringify(diagnostics)).not.toContain(privateShadowFailure);

    remainingSuccessfulResolutions = Number.POSITIVE_INFINITY;
    remainingSuccessfulEmbeddings = Number.POSITIVE_INFINITY;
    const directPoolPreview = await generation.buildContextPreview(pool, scope);
    expect(directPoolPreview.scopes).toEqual(withoutShadow.scopes);
    expect(directPoolPreview.retrieval).toMatchObject({ implementation: "chunked_hybrid" });

    remainingSuccessfulResolutions = Number.POSITIVE_INFINITY;
    remainingSuccessfulEmbeddings = 1;
    const previewDespitePrivateProviderFailure = await withTransaction(
      pool,
      (database) => generation.buildContextPreview(database, scope)
    );
    expect(previewDespitePrivateProviderFailure.scopes).toEqual(withoutShadow.scopes);
    expect(diagnostics.at(-1)).toMatchObject({ message: "chronicle_retrieval_shadow_failed" });
    expect(JSON.stringify(diagnostics)).not.toContain(privateProviderFailure);
    const comparisonRows = await pool.query<{
      implementation: string;
      production_selection: boolean;
    }>(
      `SELECT DISTINCT implementation,production_selection
         FROM chronicle_retrieval_candidates
        WHERE campaign_id = $1
        ORDER BY implementation`,
      [current.campaignId]
    );
    expect(comparisonRows.rows.map((row) => row.implementation)).toEqual([
      "chunked_hybrid",
      "legacy_hybrid",
      "lexical"
    ]);
    expect(comparisonRows.rows.filter((row) => row.production_selection)
      .every((row) => row.implementation === "chunked_hybrid")).toBe(true);
    const serialized = JSON.stringify(await pool.query(
      `SELECT run.*,candidate.*
         FROM chronicle_retrieval_runs run
         JOIN chronicle_retrieval_candidates candidate ON candidate.run_id = run.id
        WHERE run.campaign_id = $1`,
      [current.campaignId]
    ));
    expect(serialized).not.toContain(scope.request.query);
    expect(serialized).not.toContain("http://shadow.invalid/v1");

    const privateTelemetryFailure = "private telemetry write detail must not escape";
    await pool.query(`
      CREATE FUNCTION fail_chronicle_retrieval_telemetry() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION '${privateTelemetryFailure}';
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER fail_chronicle_retrieval_telemetry_trigger
      BEFORE INSERT ON chronicle_retrieval_runs
      FOR EACH ROW EXECUTE FUNCTION fail_chronicle_retrieval_telemetry()
    `);
    try {
      remainingSuccessfulResolutions = 1;
      remainingSuccessfulEmbeddings = Number.POSITIVE_INFINITY;
      const previewDespiteTelemetryFailure = await withTransaction(
        pool,
        (database) => generation.buildContextPreview(database, scope)
      );
      expect(previewDespiteTelemetryFailure.scopes).toEqual(withoutShadow.scopes);
      expect(diagnostics.at(-1)).toMatchObject({ message: "chronicle_retrieval_telemetry_failed" });
      expect(JSON.stringify(diagnostics)).not.toContain(privateTelemetryFailure);
      diagnosticLoggerThrows = true;
      remainingSuccessfulResolutions = 1;
      const previewDespiteTelemetryAndDiagnosticFailure = await withTransaction(
        pool,
        (database) => generation.buildContextPreview(database, scope)
      );
      expect(previewDespiteTelemetryAndDiagnosticFailure.scopes).toEqual(withoutShadow.scopes);
    } finally {
      diagnosticLoggerThrows = false;
      await pool.query("DROP TRIGGER fail_chronicle_retrieval_telemetry_trigger ON chronicle_retrieval_runs");
      await pool.query("DROP FUNCTION fail_chronicle_retrieval_telemetry()");
    }

    await pool.query(
      `UPDATE campaign_memory_configs
          SET embedding_enabled = false,
              embedding_provider_profile_id = NULL,
              embedding_model = '',
              retrieval_implementation = 'legacy_hybrid',
              retrieval_shadow_enabled = true,
              updated_at = clock_timestamp()
        WHERE campaign_id = $1 AND owner_user_id = $2`,
      [current.campaignId, ownerUserId]
    );
    await pool.query(
      `UPDATE chronicle_memory_chunks
          SET embedding = NULL,
              embedding_status = 'skipped',
              embedding_skip_reason = 'chunk_embedding_skipped',
              embedding_provider_profile_id = NULL,
              embedding_model = NULL,
              embedding_dimensions = NULL,
              embedding_protocol_version = NULL,
              embedding_provider_fingerprint = NULL,
              embedding_content_hash = NULL,
              embedding_updated_at = NULL
        WHERE campaign_id = $1 AND owner_user_id = $2`,
      [current.campaignId, ownerUserId]
    );
    const disabledSemanticPreview = await withTransaction(
      pool,
      (database) => generation.buildContextPreview(database, scope)
    );
    expect(disabledSemanticPreview.retrieval).toMatchObject({
      implementation: "legacy_hybrid",
      semanticAvailable: false
    });
    const disabledSemanticShadow = await pool.query<{
      chunked_hybrid_fallback_code: string | null;
      chunked_candidates: string;
    }>(
      `SELECT run.chunked_hybrid_fallback_code,
              count(candidate.id) FILTER (WHERE candidate.implementation = 'chunked_hybrid')::text AS chunked_candidates
         FROM chronicle_retrieval_runs run
         LEFT JOIN chronicle_retrieval_candidates candidate ON candidate.run_id = run.id
        WHERE run.campaign_id = $1
        GROUP BY run.id
        ORDER BY run.created_at DESC,run.id DESC LIMIT 1`,
      [current.campaignId]
    );
    expect(disabledSemanticShadow.rows[0]).toMatchObject({
      chunked_hybrid_fallback_code: "semantic_not_configured"
    });
    expect(Number.parseInt(disabledSemanticShadow.rows[0]!.chunked_candidates, 10)).toBeGreaterThan(0);
  });
});
