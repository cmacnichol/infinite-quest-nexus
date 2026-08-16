import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import JSZip from "jszip";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createDatabasePool,
  initialOwnerId,
  withTransaction,
  type DatabaseClient,
  type DatabasePool
} from "../../packages/database/src/pool.js";
import { sha256 } from "../../packages/domain/src/text.js";
import { chronicleContentHash } from "../../packages/domain/src/chronicle-memory-helpers.js";
import { createCanonicalFactId } from "../../packages/domain/src/canonical-facts.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import type { RuntimeConfig } from "../../packages/database/src/config.js";
import { storyImportRequestSchema } from "../../packages/contracts/src/imports.js";
import { resourceDeleteSchema } from "../../packages/contracts/src/world-library.js";
import { importLegacyStory } from "../helpers/memory-aware-services.js";
import { memoryGeneration } from "../helpers/memory-applications.js";
import { exportCampaign } from "../legacy-api/src/campaign-archive-service.js";
import { importLegacyStory as importLegacyStoryApplication } from "../legacy-api/src/import-service.js";
import {
  buildContextPreview,
  deleteCampaign,
  enqueueChronicleReindex,
  enqueueEmbeddingReindex,
  getChronicleMetrics,
  rebuildCampaignMemories,
  runNextChronicle,
  setCampaignEmbeddingConfig
} from "../helpers/memory-aware-services.js";
import { installIntegrationProviderTransport } from "./provider-transport-test-helper.js";
import { buildServer } from "../../services/api/src/server.js";
import { createApiMemoryApplication } from "../helpers/runtime-application-fixtures.js";
import { inertStorageServerOptions as serverOptions } from "../helpers/build-server-options.js";
import type { MemoryGenerationTransactionPort } from "../../packages/application/src/memory/index.js";
import { createPostgresProviderRepositories } from "../../packages/database/src/provider-repository.js";
import { supportsSecureGeneratedArchiveStaging } from "../../services/api/src/archive-io.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
const secureGeneratedArchiveIt = it.runIf(supportsSecureGeneratedArchiveStaging());

function routeConfig(url: string, storageRoot: string): RuntimeConfig {
  const archiveLimits = {
    maxCompressedBytes: 53_687_091_200,
    maxUncompressedBytes: 214_748_364_800,
    maxEntries: 1_000_000,
    maxExpansionRatio: 100,
    maxManifestBytes: 5_242_880,
    maxJsonEntryBytes: 1_073_741_824,
    maxOriginalImageBytes: 26_214_400
  };
  return {
    role: "all",
    host: "127.0.0.1",
    port: 8080,
    databaseUrl: url,
    databaseMaxConnections: 4,
    migrationDirectory: resolve("database/migrations"),
    migrationWaitSeconds: 10,
    allowMaintenanceMigrations: false,
    workerPollIntervalMs: 1_000,
    workerLeaseSeconds: 60,
    workerGenerationConcurrency: 1,
    legacyWebRoot: resolve("apps/web/public"),
    nextWebRoot: resolve("apps/web-next"),
    assetStorageDriver: "filesystem",
    assetStorageRoot: storageRoot,
    archiveStorageRoot: storageRoot,
    archivePreviewTtlSeconds: 1_800,
    systemArchiveArtifactTtlSeconds: 86_400,
    campaignArchiveLimits: { ...archiveLimits, maxCompressedBytes: 2_147_483_648, maxUncompressedBytes: 21_474_836_480, maxEntries: 100_000 },
    systemArchiveLimits: archiveLimits,
    credentialEncryptionKey: "memory-route-integration-secret",
    security: {
      corsAllowedOrigins: [],
      providerNetworkAllowlist: ["localhost", "127.0.0.0/8", "::1/128"],
      cspImageAllowedOrigins: [],
      apiDefaultBodyLimitBytes: 1_048_576,
      apiImportBodyLimitBytes: 16_777_216,
      apiAssetBodyLimitBytes: 33_554_432,
      apiRateLimitWindowSeconds: 60,
      apiRateLimitProviderRequests: 10,
      apiRateLimitGenerationRequests: 12,
      apiRateLimitImportRequests: 4,
      apiConcurrencyProviderRequests: 2,
      apiConcurrencyImportRequests: 1,
      trustProxyHops: 0
    }
  };
}

integration("legacy import and Chronicle integration", () => {
  let pool: DatabasePool;
  let providerTransport: ReturnType<typeof installIntegrationProviderTransport>;
  let campaignId = "";
  let assetRoot = "";

  beforeAll(async () => {
    pool = createDatabasePool(databaseUrl!, 4);
    providerTransport = installIntegrationProviderTransport(["127.0.0.0/8", "embedding.test"]);
    assetRoot = await mkdtemp(resolve(tmpdir(), "infinitequest-assets-"));
    await migrateDatabase(pool, resolve("database/migrations"));
    const fixture = JSON.parse(await readFile(resolve("tests/fixtures/legacy-story.json"), "utf8"));
    const request = storyImportRequestSchema.parse({ sourceName: "legacy-story.json", story: fixture });
    const imported = await importLegacyStory(pool, request);
    campaignId = imported.campaignId;
  });

  afterAll(async () => {
    if (providerTransport) await providerTransport.close();
    if (pool) await pool.end();
    if (assetRoot) await rm(assetRoot, { recursive: true, force: true });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("imports idempotently", async () => {
    const fixture = JSON.parse(await readFile(resolve("tests/fixtures/legacy-story.json"), "utf8"));
    fixture.settings = {
      ...(fixture.settings || {}),
      nexusCampaignId: crypto.randomUUID(),
      nexusCampaignTurnCount: 999,
      nexusPendingGeneration: { jobId: crypto.randomUUID() }
    };
    const request = storyImportRequestSchema.parse({ sourceName: "same-content.story", story: fixture });
    const result = await importLegacyStory(pool, request);
    expect(result.campaignId).toBe(campaignId);
    expect(result.duplicate).toBe(true);
    const draft = await pool.query<{ based_on_world_version_id: string; revision: number }>(
      `SELECT wd.based_on_world_version_id, wd.revision
         FROM world_drafts wd JOIN campaigns c ON c.world_version_id = wd.based_on_world_version_id
        WHERE c.id = $1`,
      [campaignId]
    );
    expect(draft.rows[0]).toMatchObject({ revision: 1 });
  });

  it("queues destination chunk work only after publishing a new import", async () => {
    const fixture = JSON.parse(await readFile(resolve("tests/fixtures/legacy-story.json"), "utf8"));
    fixture.world.title = `Published chunk import ${crypto.randomUUID()}`;
    const baseMemory = memoryGeneration(pool);
    const observedStatuses: string[] = [];
    const enqueueChunkIndex = vi.fn(async (
      database: DatabaseClient,
      scope: Parameters<MemoryGenerationTransactionPort["enqueueChunkIndex"]>[1]
    ) => {
      const published = await database.query<{ status: string }>(
        "SELECT status FROM imports WHERE owner_user_id=$1 AND campaign_id=$2",
        [scope.ownerUserId, scope.campaignId]
      );
      observedStatuses.push(...published.rows.map((row) => row.status));
      return baseMemory.enqueueChunkIndex(database, scope);
    });

    const imported = await importLegacyStoryApplication(
      pool,
      storyImportRequestSchema.parse({
        sourceName: `published-chunk-import-${crypto.randomUUID()}.story`,
        story: fixture
      }),
      { ...baseMemory, enqueueChunkIndex }
    );

    expect(enqueueChunkIndex).toHaveBeenCalledOnce();
    expect(observedStatuses).toEqual(["completed"]);
    expect(enqueueChunkIndex).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      campaignId: imported.campaignId,
      worldVersionId: imported.worldVersionId
    }));
  });

  it("keeps a published import committed when derived chunk enqueue fails", async () => {
    const fixture = JSON.parse(await readFile(resolve("tests/fixtures/legacy-story.json"), "utf8"));
    fixture.world.title = `Fail-open chunk import ${crypto.randomUUID()}`;
    const baseMemory = memoryGeneration(pool);
    const enqueueChunkIndex = vi.fn(async (database: DatabaseClient) => {
      await database.query("SELECT * FROM task_11_missing_chunk_enqueue_relation");
      return null;
    });

    const imported = await importLegacyStoryApplication(
      pool,
      storyImportRequestSchema.parse({
        sourceName: `fail-open-chunk-import-${crypto.randomUUID()}.story`,
        story: fixture
      }),
      { ...baseMemory, enqueueChunkIndex }
    );

    expect(enqueueChunkIndex).toHaveBeenCalledOnce();
    await expect(pool.query<{ status: string }>(
      "SELECT status FROM imports WHERE campaign_id=$1",
      [imported.campaignId]
    )).resolves.toMatchObject({ rows: [{ status: "completed" }] });
    await expect(pool.query("SELECT id FROM campaigns WHERE id=$1", [imported.campaignId]))
      .resolves.toMatchObject({ rows: [{ id: imported.campaignId }] });
  });

  it("deletes an embedding provider without deleting Chronicle text and falls back lexically", async () => {
    const fixture = JSON.parse(await readFile(resolve("tests/fixtures/legacy-story.json"), "utf8"));
    fixture.world.title = `Provider lifecycle ${crypto.randomUUID()}`;
    const imported = await importLegacyStory(pool, storyImportRequestSchema.parse({
      sourceName: `provider-lifecycle-${crypto.randomUUID()}.story`,
      story: fixture
    }));
    const ownerUserId = await initialOwnerId(pool);
    const provider = await pool.query<{ id: string }>(
      `INSERT INTO provider_profiles (
         owner_user_id,name,provider_type,provider_role,base_url,default_model
       ) VALUES ($1,$2,'openai_compatible','embedding','http://embedding.test','task-11-embed') RETURNING id`,
      [ownerUserId, `Task 11 provider ${crypto.randomUUID()}`]
    );
    const providerProfileId = provider.rows[0]!.id;
    await setCampaignEmbeddingConfig(pool, imported.campaignId, {
      enabled: true,
      providerProfileId,
      model: "task-11-embed",
      batchSize: 8
    });
    const parent = await pool.query<{
      id: string;
      world_version_id: string;
      content: string;
      content_hash: string;
      token_estimate: number;
    }>(
      `SELECT id,world_version_id,content,content_hash,token_estimate
         FROM chronicle_memories WHERE campaign_id=$1 AND memory_kind='legacy_summary'`,
      [imported.campaignId]
    );
    const parentRow = parent.rows[0]!;
    const chunk = await pool.query<{ id: string }>(
      `INSERT INTO chronicle_memory_chunks (
         owner_user_id,campaign_id,world_version_id,parent_memory_id,parent_content_hash,
         chunking_protocol_version,chunk_ordinal,chunk_kind,content,source_end_offset,token_estimate,
         embedding,embedding_status,embedding_provider_profile_id,embedding_model,embedding_dimensions,
         embedding_protocol_version,embedding_provider_fingerprint,embedding_content_hash,embedding_updated_at
       ) VALUES ($1,$2,$3,$4,$5,'chronicle-chunk-v1',0,'legacy_summary',$6,length($6),$7,
                 '[1,0,0]'::vector,'embedded',$8,'task-11-embed',3,
                 'chronicle-embedding-v1','task11-provider-fingerprint',encode(digest($6,'sha256'),'hex'),now())
       RETURNING id`,
      [ownerUserId, imported.campaignId, parentRow.world_version_id, parentRow.id,
        parentRow.content_hash, parentRow.content, parentRow.token_estimate, providerProfileId]
    );
    await pool.query(
      `INSERT INTO chronicle_query_embedding_cache (
         owner_user_id,campaign_id,normalized_query_hash,provider_profile_id,
         embedding_model_hash,provider_fingerprint_hash,query_prefix_hash,
         embedding_protocol_version,embedding,embedding_dimensions
       ) VALUES ($1,$2,repeat('1',64),$3,repeat('2',64),repeat('3',64),repeat('4',64),
                 'chronicle-embedding-v1','[1,0,0]'::vector,3)`,
      [ownerUserId, imported.campaignId, providerProfileId]
    );

    await withTransaction(pool, async (client) => {
      await createPostgresProviderRepositories(client).profiles.deleteProfile({ ownerUserId, providerProfileId });
    });

    await expect(pool.query<{ content: string }>(
      "SELECT content FROM chronicle_memories WHERE id=$1",
      [parentRow.id]
    )).resolves.toMatchObject({ rows: [{ content: parentRow.content }] });
    await expect(pool.query<{ content: string; embedding_status: string; embedded: boolean }>(
      "SELECT content,embedding_status,embedding IS NOT NULL AS embedded FROM chronicle_memory_chunks WHERE id=$1",
      [chunk.rows[0]!.id]
    )).resolves.toMatchObject({ rows: [{
      content: parentRow.content,
      embedding_status: "pending",
      embedded: false
    }] });
    await expect(pool.query(
      "SELECT id FROM chronicle_query_embedding_cache WHERE provider_profile_id=$1",
      [providerProfileId]
    )).resolves.toMatchObject({ rows: [] });
    await expect(pool.query<{ embedding_enabled: boolean; embedding_provider_profile_id: string | null }>(
      "SELECT embedding_enabled,embedding_provider_profile_id FROM campaign_memory_configs WHERE campaign_id=$1",
      [imported.campaignId]
    )).resolves.toMatchObject({ rows: [{ embedding_enabled: false, embedding_provider_profile_id: null }] });
    const fallback = await buildContextPreview(pool, imported.campaignId, {
      budgetTokens: 4096,
      compression: "auto",
      query: "Location Beta",
      recentTurns: 1
    });
    expect(["lexical", "lexical_fallback"]).toContain(fallback.retrieval.mode);
    expect(JSON.stringify(fallback.scopes)).toContain("Location Beta");
  });

  it("cascades deletion through only the selected campaign's derived chunk state", async () => {
    const fixtureA = JSON.parse(await readFile(resolve("tests/fixtures/legacy-story.json"), "utf8"));
    const fixtureB = structuredClone(fixtureA);
    fixtureA.world.title = `Delete derived A ${crypto.randomUUID()}`;
    fixtureB.world.title = `Delete derived B ${crypto.randomUUID()}`;
    const [campaignA, campaignB] = await Promise.all([
      importLegacyStory(pool, storyImportRequestSchema.parse({
        sourceName: `delete-derived-a-${crypto.randomUUID()}.story`,
        story: fixtureA
      })),
      importLegacyStory(pool, storyImportRequestSchema.parse({
        sourceName: `delete-derived-b-${crypto.randomUUID()}.story`,
        story: fixtureB
      }))
    ]);
    const ownerUserId = await initialOwnerId(pool);
    const provider = await pool.query<{ id: string }>(
      `INSERT INTO provider_profiles (
         owner_user_id,name,provider_type,provider_role,base_url,default_model
       ) VALUES ($1,$2,'openai_compatible','embedding','http://embedding.test','task-11-delete') RETURNING id`,
      [ownerUserId, `Task 11 deletion provider ${crypto.randomUUID()}`]
    );
    const providerProfileId = provider.rows[0]!.id;

    for (const campaign of [campaignA, campaignB]) {
      await pool.query(
        `INSERT INTO campaign_memory_configs
           (campaign_id,owner_user_id,embedding_enabled,retrieval_shadow_enabled)
         VALUES ($1,$2,false,true)
         ON CONFLICT (campaign_id) DO UPDATE
           SET retrieval_shadow_enabled=EXCLUDED.retrieval_shadow_enabled`,
        [campaign.campaignId, ownerUserId]
      );
      await rebuildCampaignMemories(pool, campaign.campaignId);
      await pool.query(
        `INSERT INTO chronicle_memory_chunks (
           owner_user_id,campaign_id,world_version_id,parent_memory_id,parent_content_hash,
           chunking_protocol_version,chunk_ordinal,chunk_kind,content,source_end_offset,
           token_estimate,embedding_status,embedding_skip_reason
         ) SELECT owner_user_id,campaign_id,world_version_id,id,content_hash,
                  'chronicle-chunk-v1',0,'legacy_summary',content,length(content),
                  token_estimate,'skipped','semantic_disabled'
             FROM chronicle_memories
            WHERE campaign_id=$1 AND memory_kind='legacy_summary'`,
        [campaign.campaignId]
      );
      await pool.query(
        `INSERT INTO chronicle_retrieval_runs (
           owner_user_id,campaign_id,world_version_id,query_hash,production_implementation,
           shadow_enabled,retrieval_version,embedding_protocol_version,chunk_protocol_version,query_token_estimate
         ) VALUES ($1,$2,$3,repeat('5',64),'legacy_hybrid',true,
                   'chronicle-retrieval-v1','chronicle-embedding-v1','chronicle-chunk-v1',1)`,
        [ownerUserId, campaign.campaignId, campaign.worldVersionId]
      );
      await pool.query(
        `INSERT INTO chronicle_query_embedding_cache (
           owner_user_id,campaign_id,normalized_query_hash,provider_profile_id,
           embedding_model_hash,provider_fingerprint_hash,query_prefix_hash,
           embedding_protocol_version,embedding,embedding_dimensions
         ) VALUES ($1,$2,repeat('6',64),$3,repeat('7',64),repeat('8',64),repeat('9',64),
                   'chronicle-embedding-v1','[1,0]'::vector,2)`,
        [ownerUserId, campaign.campaignId, providerProfileId]
      );
    }
    const derivedCounts = async (selectedCampaignId: string) => (await pool.query<{
      chunks: number;
      jobs: number;
      runs: number;
      cache: number;
    }>(
      `SELECT
         (SELECT count(*)::int FROM chronicle_memory_chunks WHERE campaign_id=$1) AS chunks,
         (SELECT count(*)::int FROM chronicle_chunk_jobs WHERE campaign_id=$1) AS jobs,
         (SELECT count(*)::int FROM chronicle_retrieval_runs WHERE campaign_id=$1) AS runs,
         (SELECT count(*)::int FROM chronicle_query_embedding_cache WHERE campaign_id=$1) AS cache`,
      [selectedCampaignId]
    )).rows[0]!;
    const retainedBefore = await derivedCounts(campaignB.campaignId);
    expect(Object.values(await derivedCounts(campaignA.campaignId)).every((count) => count > 0)).toBe(true);
    expect(Object.values(retainedBefore).every((count) => count > 0)).toBe(true);
    const title = await pool.query<{ title: string }>("SELECT title FROM campaigns WHERE id=$1", [campaignA.campaignId]);

    await deleteCampaign(pool, campaignA.campaignId, resourceDeleteSchema.parse({
      confirmation: "DELETE",
      expectedTitle: title.rows[0]!.title
    }));

    expect(await derivedCounts(campaignA.campaignId)).toEqual({ chunks: 0, jobs: 0, runs: 0, cache: 0 });
    expect(await derivedCounts(campaignB.campaignId)).toEqual(retainedBefore);
    await expect(pool.query("SELECT id FROM campaigns WHERE id=$1", [campaignB.campaignId]))
      .resolves.toMatchObject({ rows: [{ id: campaignB.campaignId }] });
    await pool.query("DELETE FROM campaigns WHERE id=$1", [campaignB.campaignId]);
    await pool.query("DELETE FROM provider_profiles WHERE id=$1", [providerProfileId]);
  });

  it("indexes scoped entity identities while importing turns and summaries", async () => {
    const ownerUserId = await initialOwnerId(pool);
    const fixture = JSON.parse(await readFile(resolve("tests/fixtures/legacy-story.json"), "utf8"));
    fixture.world.title = `Entity import ${crypto.randomUUID()}`;
    const baseContent = await pool.query<{ content: Record<string, unknown> }>(
      `SELECT wv.content
         FROM campaigns c JOIN world_versions wv ON wv.id = c.world_version_id
        WHERE c.id = $1`,
      [campaignId]
    );
    const targetContent = {
      ...baseContent.rows[0]!.content,
      entities: [
        { id: "marker-one", name: "Marker One", kind: "artifact" },
        { id: "location-alpha", name: "Location Alpha", kind: "location" }
      ]
    };
    const world = await pool.query<{ id: string }>(
      "INSERT INTO worlds (owner_user_id, title, status) VALUES ($1,$2,'active') RETURNING id",
      [ownerUserId, `Entity import target ${crypto.randomUUID()}`]
    );
    const version = await pool.query<{ id: string }>(
      `INSERT INTO world_versions (world_id, owner_user_id, version_number, content)
       VALUES ($1,$2,1,$3) RETURNING id`,
      [world.rows[0]!.id, ownerUserId, JSON.stringify(targetContent)]
    );
    const imported = await importLegacyStory(pool, storyImportRequestSchema.parse({
      sourceName: `entity-import-${crypto.randomUUID()}.story`,
      story: fixture,
      targetWorldVersionId: version.rows[0]!.id,
      characterStrategy: "map_to_target"
    }));

    const memories = await pool.query<{ memory_kind: string; entity_ids: string[] }>(
      `SELECT memory_kind, entity_ids
         FROM chronicle_memories
        WHERE campaign_id = $1
          AND ((memory_kind = 'turn_fiction' AND ordinal = 1) OR memory_kind = 'legacy_summary')
        ORDER BY memory_kind`,
      [imported.campaignId]
    );
    expect(memories.rows).toEqual([
      {
        memory_kind: "legacy_summary",
        entity_ids: expect.arrayContaining(["world:location-alpha", "world:marker-one"])
      },
      {
        memory_kind: "turn_fiction",
        entity_ids: expect.arrayContaining(["world:marker-one", "world:location-alpha"])
      }
    ]);
  });

  it("assigns tracker IDs to imported campaign state and turn snapshots", async () => {
    const fixture = JSON.parse(await readFile(resolve("tests/fixtures/legacy-story.json"), "utf8"));
    fixture.world.title = `Tracker import ${crypto.randomUUID()}`;
    fixture.trackers = [{ name: "Imported clue", value: "hidden", rules: "Update when discovered." }];
    fixture.turns[0].trackersSnapshot = [{ name: "Imported clue", value: "hidden", rules: "Update when discovered." }];
    const imported = await importLegacyStory(pool, storyImportRequestSchema.parse({
      sourceName: `tracker-import-${crypto.randomUUID()}.story`,
      story: fixture
    }));

    const state = await pool.query<{ trackers: unknown }>(
      "SELECT trackers FROM campaign_state WHERE campaign_id = $1",
      [imported.campaignId]
    );
    const turn = await pool.query<{ state_snapshot_private: { trackers?: unknown } }>(
      "SELECT state_snapshot_private FROM turns WHERE campaign_id = $1 AND turn_number = 1",
      [imported.campaignId]
    );
    expect(state.rows[0]?.trackers).toEqual([
      expect.objectContaining({ id: "Imported clue", name: "Imported clue" })
    ]);
    expect(turn.rows[0]?.state_snapshot_private.trackers).toEqual([
      expect.objectContaining({ id: "Imported clue", name: "Imported clue" })
    ]);
  });

  it("attaches a portable campaign to another world while preserving its character snapshot", async () => {
    const ownerUserId = await initialOwnerId(pool);
    const portable = JSON.parse(JSON.stringify(await exportCampaign(pool, campaignId, null)));
    portable.campaign.title = `Portable transferred campaign ${crypto.randomUUID()}`;
    portable.campaign.characterProfile = {
      name: "Portable Hero",
      profile: {
        identity: { aliases: ["The Wayfinder"], pronouns: "they/them" },
        story: { role: "Explorer" },
        appearance: { clothing: "red travel coat" },
        unclassifiedNotes: ""
      }
    };
    portable.campaign.characterProfileRevision = 7;
    const sourceCharacter = portable.campaign.characterSnapshot;
    const world = await pool.query<{ id: string }>(
      "INSERT INTO worlds (owner_user_id, title, status) VALUES ($1,$2,'active') RETURNING id",
      [ownerUserId, `Portable target ${crypto.randomUUID()}`]
    );
    const targetContent = {
      schemaVersion: 4,
      world: {
        title: "Portable target",
        genre: "test",
        tone: "neutral",
        premise: "A distinct target world.",
        backgroundStory: "Target-only background.",
        firstAction: "Arrive.",
        rules: "Target-only rules."
      },
      playableCharacters: [{
        id: "unrelated-target-character",
        name: "Unrelated Target Character",
        characterText: "This roster identity must not replace the exported protagonist.",
        rpgStats: [],
        defaultTriggers: [],
        source: {}
      }],
      entities: [], relationships: [], rpgStats: [], defaultTriggers: [], eventTriggers: [], assets: [], defaults: {}
    };
    const version = await pool.query<{ id: string }>(
      `INSERT INTO world_versions (world_id, owner_user_id, version_number, content, source_hash)
       VALUES ($1,$2,1,$3,$4) RETURNING id`,
      [world.rows[0]!.id, ownerUserId, JSON.stringify(targetContent), `portable-target-${crypto.randomUUID()}`]
    );
    const result = await importLegacyStory(pool, storyImportRequestSchema.parse({
      sourceName: `portable-transfer-${crypto.randomUUID()}.story`,
      story: portable,
      targetWorldVersionId: version.rows[0]!.id,
      characterStrategy: "preserve_source"
    }));
    const imported = await pool.query<{
      world_version_id: string;
      character_snapshot: unknown;
      character_profile: unknown;
      character_profile_revision: number;
    }>(
      `SELECT world_version_id, character_snapshot, character_profile, character_profile_revision
         FROM campaigns WHERE id = $1 AND owner_user_id = $2`,
      [result.campaignId, ownerUserId]
    );
    expect(imported.rows[0]).toMatchObject({
      world_version_id: version.rows[0]!.id,
      character_snapshot: sourceCharacter,
      character_profile: portable.campaign.characterProfile,
      character_profile_revision: 7
    });
    const profileAudit = await pool.query<any>(
      `SELECT revision, edit_source, next_profile
         FROM campaign_character_profile_edits WHERE campaign_id = $1`,
      [result.campaignId]
    );
    expect(profileAudit.rows).toMatchObject([{
      revision: 7,
      edit_source: "imported",
      next_profile: portable.campaign.characterProfile
    }]);
  });

  it("reconnects an exact ledger when its saved world-version id is stale", async () => {
    const fixture = JSON.parse(await readFile(resolve("tests/fixtures/legacy-story.json"), "utf8"));
    const before = await pool.query<{ worlds: string; campaigns: string; world_id: string }>(
      `SELECT (SELECT count(*) FROM worlds)::text AS worlds,
              (SELECT count(*) FROM campaigns)::text AS campaigns,
              wv.world_id
         FROM campaigns c JOIN world_versions wv ON wv.id = c.world_version_id
        WHERE c.id = $1`,
      [campaignId]
    );
    const result = await importLegacyStory(pool, storyImportRequestSchema.parse({
      sourceName: `stale-link-${crypto.randomUUID()}.story`,
      story: fixture,
      targetWorldVersionId: crypto.randomUUID()
    }));
    const after = await pool.query<{ worlds: string; campaigns: string }>(
      `SELECT (SELECT count(*) FROM worlds)::text AS worlds,
              (SELECT count(*) FROM campaigns)::text AS campaigns`
    );
    expect(result).toMatchObject({ campaignId, worldId: before.rows[0]?.world_id, duplicate: true });
    expect(after.rows[0]).toEqual({ worlds: before.rows[0]?.worlds, campaigns: before.rows[0]?.campaigns });
  });

  it("creates an explicit campaign branch while reusing identical world canon", async () => {
    const fixture = JSON.parse(await readFile(resolve("tests/fixtures/legacy-story.json"), "utf8"));
    fixture.storyImportProvenance = {
      sourceType: "nexus_campaign_branch",
      parentCampaignId: campaignId,
      branchTurnNumber: fixture.turns.length,
      branchId: crypto.randomUUID()
    };
    const before = await pool.query<{ worlds: string; campaigns: string; world_id: string }>(
      `SELECT (SELECT count(*) FROM worlds)::text AS worlds,
              (SELECT count(*) FROM campaigns)::text AS campaigns,
              wv.world_id
         FROM campaigns c JOIN world_versions wv ON wv.id = c.world_version_id
        WHERE c.id = $1`,
      [campaignId]
    );
    const result = await importLegacyStory(pool, storyImportRequestSchema.parse({
      sourceName: `explicit-branch-${crypto.randomUUID()}.story`,
      story: fixture,
      targetWorldVersionId: crypto.randomUUID()
    }));
    const after = await pool.query<{ worlds: string; campaigns: string }>(
      `SELECT (SELECT count(*) FROM worlds)::text AS worlds,
              (SELECT count(*) FROM campaigns)::text AS campaigns`
    );
    expect(result.campaignId).not.toBe(campaignId);
    expect(result.worldId).toBe(before.rows[0]?.world_id);
    expect(Number(after.rows[0]?.worlds)).toBe(Number(before.rows[0]?.worlds));
    expect(Number(after.rows[0]?.campaigns)).toBe(Number(before.rows[0]?.campaigns) + 1);
  });

  it("serializes concurrent imports of identical content", async () => {
    const fixture = JSON.parse(await readFile(resolve("tests/fixtures/legacy-story.json"), "utf8"));
    fixture.world.title = `Concurrent import ${crypto.randomUUID()}`;
    const request = storyImportRequestSchema.parse({ sourceName: "concurrent.story", story: fixture });
    const results = await Promise.all([
      importLegacyStory(pool, request),
      importLegacyStory(pool, request)
    ]);
    expect(results[0]?.campaignId).toBe(results[1]?.campaignId);
    expect(results.map((result) => result.duplicate).sort()).toEqual([false, true]);
  });

  it("retains complete history metrics", async () => {
    const metrics = await getChronicleMetrics(pool, campaignId);
    expect(metrics.turns).toBe(2);
    expect(metrics.memoryCount).toBe(3);
    expect(metrics.estimatedCompleteHistoryTokens).toBeGreaterThan(0);
    expect(metrics.semanticHealth).toMatchObject({ status: "chronicle_available", enabled: false, totalMemories: 3 });
  });

  it("serves complete owner-scoped metrics with resumable and safe semantic health projections", async () => {
    const fixture = JSON.parse(await readFile(resolve("tests/fixtures/legacy-story.json"), "utf8"));
    fixture.world.title = `Metrics route ${crypto.randomUUID()}`;
    const imported = await importLegacyStory(pool, storyImportRequestSchema.parse({
      sourceName: `metrics-route-${crypto.randomUUID()}.story`,
      story: fixture
    }));
    const ownerUserId = await initialOwnerId(pool);
    const campaign = await pool.query<{ world_version_id: string }>(
      "SELECT world_version_id FROM campaigns WHERE id = $1 AND owner_user_id = $2",
      [imported.campaignId, ownerUserId]
    );
    const worldVersionId = campaign.rows[0]!.world_version_id;
    await pool.query("DELETE FROM campaign_memory_configs WHERE campaign_id = $1", [imported.campaignId]);
    const app = await buildServer(serverOptions({ config: routeConfig(databaseUrl!, assetRoot), pool }));
    const memory = createApiMemoryApplication(pool, { credentialSecret: "memory-route-integration-secret" });
    const scope = { ownerUserId, campaignId: imported.campaignId, worldVersionId };
    const privateDiagnostic = "https://private.embedding.example/v1?token=secret-route-key";
    let foreignUserId = "";
    let foreignWorldId = "";
    let foreignWorldVersionId = "";
    let foreignCampaignId = "";
    let metricsProviderProfileId = "";
    try {
      const disabledResponse = await app.inject({
        method: "GET",
        url: `/api/v1/campaigns/${imported.campaignId}/memory/metrics`
      });
      expect(disabledResponse.statusCode).toBe(200);
      const disabled = disabledResponse.json();
      expect(Object.keys(disabled).sort()).toEqual([
        "completeHistoryCharacters", "compressionEstimates", "embeddedMemories",
        "estimatedCompleteHistoryTokens", "memoryCount", "memoryTokens", "semanticHealth", "turns"
      ]);
      expect(disabled).toMatchObject({
        turns: 2,
        completeHistoryCharacters: expect.any(Number),
        estimatedCompleteHistoryTokens: expect.any(Number),
        memoryCount: 3,
        memoryTokens: expect.any(Number),
        embeddedMemories: 0,
        compressionEstimates: {
          full: expect.any(Number),
          balanced: expect.any(Number),
          compact: expect.any(Number),
          summary: expect.any(Number)
        },
        semanticHealth: {
          status: "chronicle_available",
          enabled: false,
          totalMemories: 3,
          jobId: null,
          jobStatus: null,
          progress: {},
          lastCompletedAt: null
        }
      });
      expect(disabled.completeHistoryCharacters).toBeGreaterThan(0);
      expect(disabled.estimatedCompleteHistoryTokens).toBeGreaterThan(0);
      expect(disabled.memoryTokens).toBeGreaterThan(0);
      expect(disabled.compressionEstimates.full).toBeGreaterThan(0);
      expect(disabled.compressionEstimates.balanced).toBe(Math.ceil(disabled.compressionEstimates.full * 0.62));
      expect(disabled.compressionEstimates.compact).toBe(Math.ceil(disabled.compressionEstimates.full * 0.3));
      expect(await memory.getMetrics(scope)).toEqual(disabled);

      const provider = await pool.query<{ id: string }>(
        `INSERT INTO provider_profiles (
           owner_user_id, name, provider_type, provider_role, base_url, default_model
         ) VALUES ($1,$2,'lmstudio','embedding','http://embedding.test','metrics-embedding-model') RETURNING id`,
        [ownerUserId, `Metrics provider ${crypto.randomUUID()}`]
      );
      const providerProfileId = provider.rows[0]!.id;
      metricsProviderProfileId = providerProfileId;
      await setCampaignEmbeddingConfig(pool, imported.campaignId, {
        enabled: true,
        providerProfileId,
        model: "metrics-embedding-model",
        batchSize: 2
      });
      const memoryRow = await pool.query<{ id: string; content: string }>(
        `SELECT id, content FROM chronicle_memories
          WHERE owner_user_id = $1 AND campaign_id = $2 AND world_version_id = $3
          ORDER BY ordinal, id LIMIT 1`,
        [ownerUserId, imported.campaignId, worldVersionId]
      );
      await pool.query(
        `UPDATE chronicle_memories
            SET embedding = '[1,0,0]'::vector,
                embedding_dimensions = 3,
                embedding_content_hash = $2,
                embedding_provider_profile_id = $3,
                embedding_model = 'metrics-embedding-model',
                embedding_provider_fingerprint = 'metrics-fingerprint',
                embedding_updated_at = now()
          WHERE id = $1`,
        [memoryRow.rows[0]!.id, chronicleContentHash(memoryRow.rows[0]!.content), providerProfileId]
      );
      const queued = await memory.enqueueEmbeddingReindex(scope);
      expect(queued).toMatchObject({ status: "queued", jobId: expect.any(String) });
      const queuedJobId = queued!.jobId;
      await pool.query(
        `UPDATE chronicle_jobs
            SET status = 'running', progress = $2::jsonb, attempts = 1, updated_at = now()
          WHERE id = $1`,
        [queuedJobId, JSON.stringify({ embedded: 1, total: 3, updated: 1, skipped: 0 })]
      );

      const indexingResponse = await app.inject({
        method: "GET",
        url: `/api/v1/campaigns/${imported.campaignId}/memory/metrics`
      });
      expect(indexingResponse.statusCode).toBe(200);
      expect(indexingResponse.json().semanticHealth).toMatchObject({
        status: "indexing",
        enabled: true,
        providerProfileId,
        model: "metrics-embedding-model",
        indexedMemories: 1,
        totalMemories: 3,
        coveragePercent: 33,
        jobId: queuedJobId,
        jobStatus: "running",
        progress: { embedded: 1, total: 3, updated: 1, skipped: 0 },
        lastCompletedAt: null
      });

      await pool.query(
        "UPDATE chronicle_jobs SET status = 'failed', error_message = $2, updated_at = now() WHERE id = $1",
        [queuedJobId, privateDiagnostic]
      );
      const failedResponse = await app.inject({
        method: "GET",
        url: `/api/v1/campaigns/${imported.campaignId}/memory/metrics`
      });
      expect(failedResponse.statusCode).toBe(200);
      const failed = failedResponse.json();
      expect(failed.semanticHealth).toMatchObject({
        status: "rebuild_required",
        message: "Semantic retrieval requires a Chronicle index rebuild.",
        errorMessage: "Chronicle memory is unavailable.",
        jobId: queuedJobId,
        jobStatus: "failed"
      });
      expect(JSON.stringify(failed)).not.toContain(privateDiagnostic);
      expect(await memory.getMetrics(scope)).toEqual(failed);

      const foreignUser = await pool.query<{ id: string }>(
        "INSERT INTO users (display_name) VALUES ($1) RETURNING id",
        [`Foreign metrics owner ${crypto.randomUUID()}`]
      );
      foreignUserId = foreignUser.rows[0]!.id;
      const foreignWorld = await pool.query<{ id: string }>(
        "INSERT INTO worlds (owner_user_id, title) VALUES ($1,$2) RETURNING id",
        [foreignUserId, "Foreign metrics world"]
      );
      foreignWorldId = foreignWorld.rows[0]!.id;
      const foreignVersion = await pool.query<{ id: string }>(
        "INSERT INTO world_versions (world_id, owner_user_id, version_number, content) VALUES ($1,$2,1,'{}'::jsonb) RETURNING id",
        [foreignWorldId, foreignUserId]
      );
      foreignWorldVersionId = foreignVersion.rows[0]!.id;
      const foreignCampaign = await pool.query<{ id: string }>(
        "INSERT INTO campaigns (owner_user_id, world_version_id, title) VALUES ($1,$2,$3) RETURNING id",
        [foreignUserId, foreignWorldVersionId, "Foreign metrics campaign"]
      );
      foreignCampaignId = foreignCampaign.rows[0]!.id;
      const [missingResponse, foreignResponse] = await Promise.all([
        app.inject({ method: "GET", url: `/api/v1/campaigns/${crypto.randomUUID()}/memory/metrics` }),
        app.inject({ method: "GET", url: `/api/v1/campaigns/${foreignCampaignId}/memory/metrics` })
      ]);
      expect(missingResponse.statusCode).toBe(404);
      expect(foreignResponse.statusCode).toBe(404);
    } finally {
      await app.close();
      await pool.query(
        `UPDATE chronicle_memories
            SET embedding = NULL, embedding_provider_profile_id = NULL, embedding_model = NULL,
                embedding_dimensions = NULL, embedding_content_hash = NULL, embedding_updated_at = NULL,
                embedding_provider_fingerprint = NULL
          WHERE campaign_id = $1`,
        [imported.campaignId]
      );
      await pool.query("DELETE FROM campaign_memory_configs WHERE campaign_id = $1", [imported.campaignId]);
      if (metricsProviderProfileId) await pool.query("DELETE FROM provider_profiles WHERE id = $1", [metricsProviderProfileId]);
      if (foreignCampaignId) await pool.query("DELETE FROM campaigns WHERE id = $1", [foreignCampaignId]);
      if (foreignWorldVersionId) await pool.query("DELETE FROM world_versions WHERE id = $1", [foreignWorldVersionId]);
      if (foreignWorldId) await pool.query("DELETE FROM worlds WHERE id = $1", [foreignWorldId]);
      if (foreignUserId) await pool.query("DELETE FROM users WHERE id = $1", [foreignUserId]);
    }
  });

  it("round-trips loadable story settings and history without credentials", async () => {
    const exported = await exportCampaign(pool, campaignId, null) as Record<string, any>;
    expect(exported.format).toBe("infinite-quest-campaign");
    expect(exported.formatVersion).toBe(3);
    expect(exported.exportedAt).toEqual(expect.any(String));
    expect(exported.settings.aiProvider).toBe("openrouter");
    expect(exported.settings).not.toHaveProperty("apiKey");
    expect(exported.settings.storyHistoryTokenLimit).toBe(128000);
    expect(exported.settings.storyLength).toBe("long");
    expect((await pool.query<{ story_length_profile: string }>("SELECT story_length_profile FROM campaigns WHERE id = $1", [campaignId])).rows[0]?.story_length_profile).toBe("long");
    expect(exported.fullHistory).toMatchObject({
      characters: "Test Character remains present.",
      otherImportantNotes: "Object Gamma remains unresolved."
    });
    expect(exported.fullHistoryCompressedThroughTurn).toBe(2);
    expect(exported.baseTrackersAtStart).toEqual(exported.defaultTriggers);
  });

  it("builds a relevant fiction-only context without private mechanics", async () => {
    const context = await buildContextPreview(pool, campaignId, {
      budgetTokens: 4096,
      compression: "auto",
      query: "Location Beta Object Gamma",
      recentTurns: 8
    });
    const serialized = JSON.stringify(context.scopes);
    expect(context.budget.estimatedSelectedTokens).toBeLessThanOrEqual(context.budget.configuredTokens);
    expect(context.scopes.authoritativeRules).toBe("Use synthetic fixture markers only.");
    expect(context.scopes.worldCanon).not.toHaveProperty("rules");
    expect(serialized).toContain("Location Beta");
    expect(serialized).toContain("Object Gamma");
    expect(serialized).not.toContain("d100");
    expect(serialized).not.toContain("target was 65");
    expect(serialized).not.toContain("Private synthetic state");
  });

  it("keeps semantic retrieval inside a historical turn cutoff", async () => {
    const fixture = JSON.parse(await readFile(resolve("tests/fixtures/legacy-story.json"), "utf8"));
    fixture.world.title = `Temporal semantic fixture ${crypto.randomUUID()}`;
    const imported = await importLegacyStory(
      pool,
      storyImportRequestSchema.parse({ sourceName: "temporal-semantic.story", story: fixture })
    );
    const ownerUserId = await initialOwnerId(pool);
    const campaign = await pool.query<{ world_version_id: string }>(
      "SELECT world_version_id FROM campaigns WHERE id = $1 AND owner_user_id = $2",
      [imported.campaignId, ownerUserId]
    );
    await pool.query(
      `INSERT INTO chronicle_memories (
         owner_user_id, campaign_id, world_version_id, memory_kind, ordinal, content,
         token_estimate, importance, entities, metadata
       ) VALUES ($1,$2,$3,'canonical_fact',99,$4,8,1,$5,'{}'::jsonb)`,
      [ownerUserId, imported.campaignId, campaign.rows[0]!.world_version_id,
        "Canonical facts established at future turn\n- Future Semantic Marker", ["Future Semantic Marker"]]
    );
    const provider = await pool.query<{ id: string }>(
      `INSERT INTO provider_profiles (
         owner_user_id, name, provider_type, provider_role, base_url, default_model
       ) VALUES ($1,$2,'openai_compatible','embedding','http://embedding.test','text-embedding-nomic-embed-text-v1.5') RETURNING id`,
      [ownerUserId, `Temporal embedding fixture ${crypto.randomUUID()}`]
    );
    await setCampaignEmbeddingConfig(pool, imported.campaignId, {
      enabled: true,
      providerProfileId: provider.rows[0]!.id,
      model: "text-embedding-nomic-embed-text-v1.5",
      batchSize: 8
    });
    vi.stubGlobal("fetch", vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (!init?.body) {
        return new Response(JSON.stringify({ data: [{ id: "text-embedding-nomic-embed-text-v1.5" }] }), { status: 200 });
      }
      const { input } = JSON.parse(String(init?.body)) as { input: string[] };
      return new Response(JSON.stringify({
        model: "text-embedding-nomic-embed-text-v1.5",
        data: input.map((_content, index) => ({ index, embedding: [1, 0, 0] }))
      }), { status: 200 });
    }));
    const embeddingJobId = await enqueueEmbeddingReindex(pool, imported.campaignId);
    expect(embeddingJobId).toBeTruthy();
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const pending = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM chronicle_jobs
          WHERE campaign_id = $1 AND status IN ('queued','running')`,
        [imported.campaignId]
      );
      if (Number(pending.rows[0]?.count) === 0) break;
      expect(await runNextChronicle(pool, `temporal-embedding-worker-${attempt}`, 30, "")).toBe(true);
    }
    const completed = await pool.query<{ status: string }>("SELECT status FROM chronicle_jobs WHERE id = $1", [embeddingJobId]);
    expect(completed.rows[0]?.status).toBe("completed");
    const remaining = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM chronicle_jobs
        WHERE campaign_id = $1 AND status IN ('queued','running')`,
      [imported.campaignId]
    );
    expect(Number(remaining.rows[0]?.count)).toBe(0);

    const historical = await buildContextPreview(
      pool,
      imported.campaignId,
      { budgetTokens: 4096, compression: "auto", query: "Future Semantic Marker", recentTurns: 8 },
      "",
      {},
      { throughTurnNumber: 1 }
    );
    expect(historical.retrieval.mode).toBe("hybrid");
    expect(JSON.stringify(historical.scopes)).not.toContain("Future Semantic Marker");
    const current = await buildContextPreview(pool, imported.campaignId, {
      budgetTokens: 4096,
      compression: "auto",
      query: "Future Semantic Marker",
      recentTurns: 8
    });
    expect(JSON.stringify(current.scopes)).toContain("Future Semantic Marker");
    await setCampaignEmbeddingConfig(pool, imported.campaignId, {
      enabled: false,
      providerProfileId: provider.rows[0]!.id,
      model: "text-embedding-nomic-embed-text-v1.5",
      batchSize: 8
    });
    await pool.query("UPDATE provider_profiles SET enabled = false WHERE id = $1", [provider.rows[0]!.id]);
  });

  it("rebuilds stable canonical facts and supersedes paraphrased facts by id", async () => {
    const fixture = JSON.parse(await readFile(resolve("tests/fixtures/legacy-story.json"), "utf8"));
    fixture.world.title = `Structured facts ${crypto.randomUUID()}`;
    const imported = await importLegacyStory(
      pool,
      storyImportRequestSchema.parse({ sourceName: "structured-facts.story", story: fixture })
    );
    const ownerUserId = await initialOwnerId(pool);
    const turns = await pool.query<{ id: string; turn_number: number }>(
      "SELECT id, turn_number FROM turns WHERE campaign_id = $1 ORDER BY turn_number",
      [imported.campaignId]
    );
    const firstTurn = turns.rows.find((turn) => turn.turn_number === 1)!;
    const secondTurn = turns.rows.find((turn) => turn.turn_number === 2)!;
    const originalContent = "The eastern gate is open to travelers.";
    const replacementContent = "No traveler can pass through the eastern gate now.";
    const originalFactId = createCanonicalFactId({
      campaignId: imported.campaignId,
      sourceTurnId: firstTurn.id,
      factIndex: 0,
      content: originalContent
    });
    const replacementFactId = createCanonicalFactId({
      campaignId: imported.campaignId,
      sourceTurnId: secondTurn.id,
      factIndex: 0,
      content: replacementContent
    });
    await pool.query(
      `UPDATE turns SET state_snapshot_private = state_snapshot_private || $3::jsonb
        WHERE campaign_id = $1 AND id = $2`,
      [imported.campaignId, firstTurn.id, JSON.stringify({
        canonicalFacts: [originalContent],
        supersededFacts: [],
        canonicalFactUpdates: [{ content: originalContent, supersedesFactIds: [] }]
      })]
    );
    await pool.query(
      `UPDATE turns SET state_snapshot_private = state_snapshot_private || $3::jsonb
        WHERE campaign_id = $1 AND id = $2`,
      [imported.campaignId, secondTurn.id, JSON.stringify({
        canonicalFacts: [replacementContent],
        supersededFacts: [],
        canonicalFactUpdates: [{ content: replacementContent, supersedesFactIds: [originalFactId] }]
      })]
    );

    await rebuildCampaignMemories(pool, imported.campaignId);
    const facts = await pool.query<{
      id: string;
      content: string;
      valid_until_turn: number | null;
      superseded_by_fact_id: string | null;
    }>(
      `SELECT id, content, valid_until_turn, superseded_by_fact_id
         FROM campaign_canonical_facts
        WHERE owner_user_id = $1 AND campaign_id = $2 ORDER BY source_turn_number`,
      [ownerUserId, imported.campaignId]
    );
    expect(facts.rows).toEqual([
      { id: originalFactId, content: originalContent, valid_until_turn: 2, superseded_by_fact_id: replacementFactId },
      { id: replacementFactId, content: replacementContent, valid_until_turn: null, superseded_by_fact_id: null }
    ]);

    const current = await buildContextPreview(pool, imported.campaignId, {
      budgetTokens: 4096,
      compression: "auto",
      query: "eastern gate",
      recentTurns: 8
    });
    expect(JSON.stringify(current.scopes)).toContain(replacementContent);
    expect(JSON.stringify(current.scopes)).not.toContain(originalContent);
    const historical = await buildContextPreview(
      pool,
      imported.campaignId,
      { budgetTokens: 4096, compression: "auto", query: "eastern gate", recentTurns: 8 },
      "",
      {},
      { throughTurnNumber: 1 }
    );
    expect(JSON.stringify(historical.scopes)).toContain(originalContent);
    expect(JSON.stringify(historical.scopes)).not.toContain(replacementContent);

    await rebuildCampaignMemories(pool, imported.campaignId);
    const rebuiltIds = await pool.query<{ id: string }>(
      "SELECT id FROM campaign_canonical_facts WHERE campaign_id = $1 ORDER BY source_turn_number",
      [imported.campaignId]
    );
    expect(rebuiltIds.rows.map((fact) => fact.id)).toEqual([originalFactId, replacementFactId]);
  });

  it("retrieves canonical entity mentions through scoped aliases", async () => {
    const fixture = JSON.parse(await readFile(resolve("tests/fixtures/legacy-story.json"), "utf8"));
    fixture.world.title = `Alias memory ${crypto.randomUUID()}`;
    const imported = await importLegacyStory(
      pool,
      storyImportRequestSchema.parse({ sourceName: "alias-memory.story", story: fixture })
    );
    const isolatedFixture = structuredClone(fixture);
    isolatedFixture.world.title = `Isolated alias memory ${crypto.randomUUID()}`;
    const isolated = await importLegacyStory(
      pool,
      storyImportRequestSchema.parse({ sourceName: "isolated-alias-memory.story", story: isolatedFixture })
    );
    const ownerUserId = await initialOwnerId(pool);
    const campaigns = await pool.query<{ id: string; world_version_id: string }>(
      "SELECT id, world_version_id FROM campaigns WHERE id = ANY($1::uuid[])",
      [[imported.campaignId, isolated.campaignId]]
    );
    for (const campaign of campaigns.rows) {
      await pool.query(
        `UPDATE world_versions
            SET content = jsonb_set(content, '{entities}', $2::jsonb, true)
          WHERE id = $1`,
        [campaign.world_version_id, JSON.stringify([
          { id: "warden", name: "Lady Seraphine", aliases: ["the warden"], kind: "character" }
        ])]
      );
    }
    await pool.query(
      "UPDATE turns SET narration = $2 WHERE campaign_id = $1 AND turn_number = 2",
      [imported.campaignId, "Lady Seraphine sealed the moonlit archive before dawn."]
    );
    await pool.query(
      "UPDATE turns SET narration = $2 WHERE campaign_id = $1 AND turn_number = 2",
      [isolated.campaignId, "Lady Seraphine hid the cross-campaign secret beneath the observatory."]
    );
    await rebuildCampaignMemories(pool, imported.campaignId);
    await rebuildCampaignMemories(pool, isolated.campaignId);

    const indexed = await pool.query<{ entity_ids: string[] }>(
      `SELECT entity_ids FROM chronicle_memories
        WHERE campaign_id = $1 AND memory_kind = 'turn_fiction' AND ordinal = 2`,
      [imported.campaignId]
    );
    expect(indexed.rows[0]?.entity_ids).toContain("world:warden");

    const context = await buildContextPreview(pool, imported.campaignId, {
      budgetTokens: 4096,
      compression: "auto",
      query: "What did the warden seal?",
      recentTurns: 1
    });
    const serialized = JSON.stringify(context.scopes);
    expect(serialized).toContain("Lady Seraphine sealed the moonlit archive");
    expect(serialized).not.toContain("cross-campaign secret");
    expect(serialized).not.toContain("world:warden");

    const historical = await buildContextPreview(
      pool,
      imported.campaignId,
      { budgetTokens: 4096, compression: "auto", query: "What did the warden seal?", recentTurns: 1 },
      "",
      {},
      { throughTurnNumber: 1 }
    );
    expect(JSON.stringify(historical.scopes)).not.toContain("Lady Seraphine sealed the moonlit archive");

    await rebuildCampaignMemories(pool, imported.campaignId);
    const rebuilt = await pool.query<{ entity_ids: string[] }>(
      `SELECT entity_ids FROM chronicle_memories
        WHERE campaign_id = $1 AND memory_kind = 'turn_fiction' AND ordinal = 2`,
      [imported.campaignId]
    );
    expect(rebuilt.rows[0]?.entity_ids).toEqual(indexed.rows[0]?.entity_ids);
  });

  it("moves imported data-URL illustrations into filesystem asset storage", async () => {
    const fixture = JSON.parse(await readFile(resolve("tests/fixtures/legacy-story.json"), "utf8"));
    fixture.world.title = `Asset import fixture ${crypto.randomUUID()}`;
    fixture.turns[0].imageUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    const request = storyImportRequestSchema.parse({ sourceName: "asset-import.story", story: fixture });
    const imported = await importLegacyStory(pool, request, { root: assetRoot });
    const result = await pool.query<{ image_url: string; storage_path: string }>(
      `SELECT t.image_url, a.storage_path
         FROM turns t
         JOIN asset_references ar ON ar.turn_id = t.id AND ar.campaign_id = t.campaign_id
         JOIN assets a ON a.id = ar.asset_id
        WHERE t.campaign_id = $1 AND t.turn_number = 1`,
      [imported.campaignId]
    );
    expect(result.rows[0]?.image_url).toMatch(/^\/api\/v1\/assets\//);
    expect(await readFile(resolve(assetRoot, result.rows[0]!.storage_path))).toBeInstanceOf(Buffer);
  });

  it("persists and links zip archive asset buffers (JPEG/PNG/WebP) to imported campaign turns", async () => {
    const fixture = JSON.parse(await readFile(resolve("tests/fixtures/legacy-story.json"), "utf8"));
    const assetId = "9a3f2b1d-8e4c-4a31-b657-123456789abc";
    fixture.world.title = `Zip asset import fixture ${crypto.randomUUID()}`;
    fixture.turns[0].imageUrl = `/api/v1/assets/${assetId}`;

    const jpegBuffer = await sharp({
      create: {
        width: 1,
        height: 1,
        channels: 3,
        background: { r: 255, g: 255, b: 255 }
      }
    }).jpeg().toBuffer();

    const assetBuffers = new Map<string, Buffer>();
    assetBuffers.set(assetId, jpegBuffer);

    const request = storyImportRequestSchema.parse({ sourceName: "zip-asset-import.story", story: fixture });
    const imported = await importLegacyStory(pool, request, { root: assetRoot }, assetBuffers);

    const result = await pool.query<{ image_url: string; mime_type: string; storage_path: string }>(
      `SELECT t.image_url, a.mime_type, a.storage_path
         FROM turns t
         JOIN asset_references ar ON ar.turn_id = t.id AND ar.campaign_id = t.campaign_id
         JOIN assets a ON a.id = ar.asset_id
        WHERE t.campaign_id = $1 AND t.turn_number = 1`,
      [imported.campaignId]
    );

    expect(result.rows[0]?.image_url).toMatch(/^\/api\/v1\/assets\//);
    expect(result.rows[0]?.mime_type).toBe("image/jpeg");
    expect(await readFile(resolve(assetRoot, result.rows[0]!.storage_path))).toEqual(jpegBuffer);

    const configRes = await pool.query<{ enabled: boolean }>(
      "SELECT enabled FROM campaign_illustration_configs WHERE campaign_id = $1",
      [imported.campaignId]
    );
    expect(configRes.rows[0]?.enabled).toBe(true);

    const segAssetRes = await pool.query<{ asset_id: string }>(
      `SELECT tisa.asset_id
         FROM turn_illustration_segment_assets tisa
         JOIN turn_illustration_segments tis ON tis.id = tisa.segment_id
        WHERE tis.campaign_id = $1`,
      [imported.campaignId]
    );
    expect(segAssetRes.rows[0]?.asset_id).toBeDefined();
  });

  secureGeneratedArchiveIt("rejects a path-traversal asset record when exporting a portable campaign ZIP", async () => {
    const fixture = JSON.parse(await readFile(resolve("tests/fixtures/legacy-story.json"), "utf8"));
    fixture.world.title = `Asset traversal export ${crypto.randomUUID()}`;
    fixture.turns[0].imageUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    const imported = await importLegacyStory(pool, storyImportRequestSchema.parse({
      sourceName: "asset-traversal.json",
      story: fixture
    }), { root: assetRoot });
    const asset = await pool.query<{ id: string; storage_path: string }>(
      `SELECT a.id, a.storage_path
       FROM assets a
       JOIN asset_references ar ON ar.asset_id = a.id AND ar.owner_user_id = a.owner_user_id
       WHERE ar.campaign_id = $1
       LIMIT 1`,
      [imported.campaignId]
    );
    const storedAsset = asset.rows[0];
    expect(storedAsset).toBeDefined();
    if (!storedAsset) throw new Error("Expected imported asset for traversal test");

    const escapedName = `infinitequest-export-escape-${crypto.randomUUID()}.bin`;
    const escapedPath = resolve(assetRoot, "..", escapedName);
    const sentinel = Buffer.from(`not-an-asset-${crypto.randomUUID()}`);
    await writeFile(escapedPath, sentinel);
    try {
      await pool.query("UPDATE assets SET storage_path = $2 WHERE id = $1", [storedAsset.id, `../${escapedName}`]);
      await expect(exportCampaign(pool, imported.campaignId, {
        assetStore: { root: assetRoot },
        archiveRoot: assetRoot,
        limits: {
          maxCompressedBytes: 10 * 1024 * 1024,
          maxUncompressedBytes: 50 * 1024 * 1024,
          maxEntries: 1_000,
          maxExpansionRatio: 100,
          maxManifestBytes: 1024 * 1024,
          maxJsonEntryBytes: 5 * 1024 * 1024,
          maxOriginalImageBytes: 25 * 1024 * 1024
        }
      })).rejects.toMatchObject({ code: "archive-asset-missing", assetIds: [storedAsset.id] });
      expect(await readFile(escapedPath)).toEqual(sentinel);
    } finally {
      await pool.query("UPDATE assets SET storage_path = $2 WHERE id = $1", [storedAsset.id, storedAsset.storage_path]);
      await rm(escapedPath, { force: true });
    }
  });

  it("deduplicates active reindex requests and lets worker replicas claim different campaigns", async () => {
    const firstJob = await enqueueChronicleReindex(pool, campaignId);
    const duplicateJob = await enqueueChronicleReindex(pool, campaignId);
    expect(duplicateJob).toBe(firstJob);

    const fixture = JSON.parse(await readFile(resolve("tests/fixtures/legacy-story.json"), "utf8"));
    fixture.world.title = `Worker replica fixture ${crypto.randomUUID()}`;
    const secondCampaign = await importLegacyStory(
      pool,
      storyImportRequestSchema.parse({ sourceName: "worker-replica.story", story: fixture })
    );
    const secondJob = await enqueueChronicleReindex(pool, secondCampaign.campaignId);

    const claims = await Promise.all([
      runNextChronicle(pool, "integration-worker-a", 30),
      runNextChronicle(pool, "integration-worker-b", 30)
    ]);
    expect(claims).toEqual([true, true]);

    const jobs = await pool.query<{ id: string; status: string; attempts: number }>(
      "SELECT id, status, attempts FROM chronicle_jobs WHERE id = ANY($1::uuid[]) ORDER BY id",
      [[firstJob, secondJob]]
    );
    expect(jobs.rows).toHaveLength(2);
    expect(jobs.rows.every((job) => job.status === "completed" && job.attempts === 1)).toBe(true);
  });

  it("indexes fresh vectors and uses hybrid retrieval with a safe lexical fallback", async () => {
    const ownerUserId = await initialOwnerId(pool);
    const provider = await pool.query<{ id: string }>(
      `INSERT INTO provider_profiles (
         owner_user_id, name, provider_type, provider_role, base_url, default_model
       ) VALUES ($1,$2,'lmstudio','embedding','http://embedding.test','text-embedding-nomic-embed-text-v1.5') RETURNING id`,
      [ownerUserId, `Embedding fixture ${crypto.randomUUID()}`]
    );
    await setCampaignEmbeddingConfig(pool, campaignId, {
      enabled: true,
      providerProfileId: provider.rows[0]!.id,
      model: "text-embedding-nomic-embed-text-v1.5",
      batchSize: 2
    });
    const embeddingInputs: string[][] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const { input } = JSON.parse(String(init?.body)) as { input: string[] };
      embeddingInputs.push(input);
      return new Response(JSON.stringify({
        model: "text-embedding-nomic-embed-text-v1.5",
        data: input.map((content, index) => ({
          index,
          embedding: /Object Gamma|related marker|Marker One/i.test(content) ? [1, 0, 0] : [0, 1, 0]
        }))
      }), { status: 200 });
    }));
    const jobId = await enqueueEmbeddingReindex(pool, campaignId);
    expect(jobId).toBeTruthy();
    expect(await runNextChronicle(pool, "embedding-worker", 30, "")).toBe(true);
    expect(embeddingInputs.flat().every((input) => input.startsWith("search_document: "))).toBe(true);
    const indexed = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM chronicle_memories
        WHERE owner_user_id = $1 AND campaign_id = $2 AND embedding IS NOT NULL
          AND embedding_content_hash IS NOT NULL`,
      [ownerUserId, campaignId]
    );
    expect(Number(indexed.rows[0]?.count)).toBeGreaterThan(0);
    const health = (await getChronicleMetrics(pool, campaignId)).semanticHealth;
    expect(health).toMatchObject({
      status: "healthy",
      providerHealth: "healthy",
      coveragePercent: 100,
      jobId,
      jobStatus: "completed"
    });
    expect(health.indexedMemories).toBe(health.totalMemories);

    const hybrid = await buildContextPreview(pool, campaignId, {
      budgetTokens: 4096,
      compression: "auto",
      query: "related marker",
      recentTurns: 1
    });
    expect(hybrid.retrieval.mode).toBe("hybrid");
    expect(embeddingInputs.at(-1)?.[0]).toMatch(/^search_query: /);
    expect(hybrid.scopes.chronicle.some((memory: Record<string, unknown>) => Number(memory.semanticRelevance) > 0.9)).toBe(true);

    vi.stubGlobal("fetch", vi.fn(async () => new Response("offline", { status: 503 })));
    const fallback = await buildContextPreview(pool, campaignId, {
      budgetTokens: 4096,
      compression: "auto",
      query: "Location Beta",
      recentTurns: 1
    });
    expect(fallback.retrieval.mode).toBe("lexical_fallback");
    expect(JSON.stringify(fallback.scopes)).toContain("Location Beta");
  });

  it("requeues a running embedding job when Chronicle content changes concurrently", async () => {
    const ownerUserId = await initialOwnerId(pool);
    const provider = await pool.query<{ id: string }>(
      `INSERT INTO provider_profiles (
         owner_user_id, name, provider_type, provider_role, base_url, default_model
       ) VALUES ($1,$2,'lmstudio','embedding','http://embedding.test','text-embedding-nomic-embed-text-v1.5') RETURNING id`,
      [ownerUserId, `Embedding race fixture ${crypto.randomUUID()}`]
    );
    await setCampaignEmbeddingConfig(pool, campaignId, {
      enabled: true,
      providerProfileId: provider.rows[0]!.id,
      model: "text-embedding-nomic-embed-text-v1.5",
      batchSize: 2
    });
    await pool.query(
      `UPDATE chronicle_memories SET content = content || E'\\nRace preparation.'
        WHERE id = (SELECT id FROM chronicle_memories WHERE campaign_id = $1 ORDER BY ordinal LIMIT 1)`,
      [campaignId]
    );
    let releaseFirstBatch!: () => void;
    let markStarted!: () => void;
    const firstBatchStarted = new Promise<void>((resolveStarted) => { markStarted = resolveStarted; });
    const release = new Promise<void>((resolveRelease) => { releaseFirstBatch = resolveRelease; });
    vi.stubGlobal("fetch", vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (!init?.body) {
        return new Response(JSON.stringify({ data: [{ id: "text-embedding-nomic-embed-text-v1.5" }] }), { status: 200 });
      }
      const { input } = JSON.parse(String(init.body)) as { input: string[] };
      markStarted();
      await release;
      return new Response(JSON.stringify({
        model: "text-embedding-nomic-embed-text-v1.5",
        data: input.map((_content, index) => ({ index, embedding: [1, 0, 0] }))
      }), { status: 200 });
    }));
    const jobId = await enqueueEmbeddingReindex(pool, campaignId);
    expect(jobId).toBeTruthy();
    const firstRun = runNextChronicle(pool, "embedding-race-worker-a", 30, "");
    await firstBatchStarted;
    await pool.query(
      `UPDATE chronicle_memories SET content = content || E'\\nConcurrent accepted fact.'
        WHERE id = (SELECT id FROM chronicle_memories WHERE campaign_id = $1 ORDER BY ordinal LIMIT 1)`,
      [campaignId]
    );
    expect(await enqueueEmbeddingReindex(pool, campaignId)).toBe(jobId);
    releaseFirstBatch();
    expect(await firstRun).toBe(true);
    const queued = await pool.query<{ status: string; work_version: string }>(
      "SELECT status, work_version::text FROM chronicle_jobs WHERE id = $1",
      [jobId]
    );
    expect(queued.rows[0]?.status).toBe("queued");

    vi.stubGlobal("fetch", vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (!init?.body) {
        return new Response(JSON.stringify({ data: [{ id: "text-embedding-nomic-embed-text-v1.5" }] }), { status: 200 });
      }
      const { input } = JSON.parse(String(init.body)) as { input: string[] };
      return new Response(JSON.stringify({
        model: "text-embedding-nomic-embed-text-v1.5",
        data: input.map((_content, index) => ({ index, embedding: [1, 0, 0] }))
      }), { status: 200 });
    }));
    expect(await runNextChronicle(pool, "embedding-race-worker-b", 30, "")).toBe(true);
    const fresh = await pool.query<{ content: string; embedding_content_hash: string | null; embedded: boolean }>(
      `SELECT content, embedding_content_hash, embedding IS NOT NULL AS embedded
         FROM chronicle_memories WHERE campaign_id = $1`,
      [campaignId]
    );
    expect(fresh.rows.every((memory) => memory.embedded && memory.embedding_content_hash === sha256(memory.content))).toBe(true);
  });

  it("keeps long-history retrieval bounded while recovering a middle-period fact", async () => {
    const fixture = JSON.parse(await readFile(resolve("tests/fixtures/legacy-story.json"), "utf8"));
    fixture.world.title = `Long Chronicle ${crypto.randomUUID()}`;
    const imported = await importLegacyStory(pool, storyImportRequestSchema.parse({ sourceName: "long-chronicle.story", story: fixture }));
    const ownerUserId = await initialOwnerId(pool);
    await pool.query(
      `INSERT INTO turns (owner_user_id, campaign_id, turn_number, action, narration)
       SELECT $1, $2, ordinal, 'Continue the expedition.',
              CASE WHEN ordinal = 350 THEN 'NeedleMiddleMarker is hidden beneath Location Delta.'
                   ELSE 'The expedition advances through a synthetic location.' END
         FROM generate_series(3, 702) ordinal`,
      [ownerUserId, imported.campaignId]
    );
    await pool.query(
      `INSERT INTO chronicle_memories (
         owner_user_id, campaign_id, world_version_id, turn_id, memory_kind, ordinal,
         content, token_estimate, importance, entities, metadata
       )
       SELECT t.owner_user_id, t.campaign_id, c.world_version_id, t.id, 'turn_fiction', t.turn_number,
              'Turn ' || t.turn_number || E'\nPlayer action: ' || t.action || E'\nNarration: ' || t.narration,
              24, 0.5, ARRAY[]::text[], '{}'::jsonb
         FROM turns t JOIN campaigns c ON c.id = t.campaign_id
        WHERE t.campaign_id = $1 AND t.turn_number >= 3`,
      [imported.campaignId]
    );
    await pool.query("UPDATE campaigns SET active_turn_number = 702 WHERE id = $1", [imported.campaignId]);
    const context = await buildContextPreview(pool, imported.campaignId, {
      budgetTokens: 4096,
      compression: "auto",
      query: "Where is NeedleMiddleMarker?",
      recentTurns: 8
    });
    expect(JSON.stringify(context.scopes)).toContain("NeedleMiddleMarker");
    expect(context.scopes.chronicle.length).toBeLessThan(100);
    expect(context.budget.estimatedSelectedTokens).toBeLessThanOrEqual(4096);
    expect(context.metrics.turns).toBe(702);
  });
});
