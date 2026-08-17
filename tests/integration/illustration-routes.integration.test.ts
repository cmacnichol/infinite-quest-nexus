import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RuntimeConfig } from "../../packages/database/src/config.js";
import { storyImportRequestSchema } from "../../packages/contracts/src/imports.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { createDatabasePool, initialOwnerId, type DatabasePool } from "../../packages/database/src/pool.js";
import { importLegacyStory } from "../helpers/memory-aware-services.js";
import { createProvider } from "../helpers/provider-application-fixtures.js";
import { buildServer } from "../../services/api/src/server.js";
import { inertStorageServerOptions as serverOptions } from "../helpers/build-server-options.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
const credentialSecret = "illustration-route-parity-secret";

function config(assetStorageRoot: string): RuntimeConfig {
  return {
    role: "all",
    host: "127.0.0.1",
    port: 8080,
    databaseUrl: databaseUrl!,
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
    assetStorageRoot,
    archiveStorageRoot: resolve("local-data/archives"),
    archivePreviewTtlSeconds: 1_800,
    systemArchiveArtifactTtlSeconds: 86_400,
    campaignArchiveLimits: {
      maxCompressedBytes: 2_147_483_648,
      maxUncompressedBytes: 21_474_836_480,
      maxEntries: 100_000,
      maxExpansionRatio: 100,
      maxManifestBytes: 5_242_880,
      maxJsonEntryBytes: 1_073_741_824,
      maxOriginalImageBytes: 26_214_400
    },
    systemArchiveLimits: {
      maxCompressedBytes: 53_687_091_200,
      maxUncompressedBytes: 214_748_364_800,
      maxEntries: 1_000_000,
      maxExpansionRatio: 100,
      maxManifestBytes: 5_242_880,
      maxJsonEntryBytes: 1_073_741_824,
      maxOriginalImageBytes: 26_214_400
    },
    credentialEncryptionKey: credentialSecret,
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

integration("illustration HTTP route parity", () => {
  let pool: DatabasePool;
  let app: Awaited<ReturnType<typeof buildServer>>;
  let ownerUserId = "";
  let imageProviderId = "";
  let assetRoot = "";

  beforeAll(async () => {
    pool = createDatabasePool(databaseUrl!, 4);
    await migrateDatabase(pool, resolve("database/migrations"));
    ownerUserId = await initialOwnerId(pool);
    assetRoot = await mkdtemp(join(tmpdir(), "infinitequest-illustration-routes-"));
    imageProviderId = (await createProvider(pool, {
      name: `Illustration route image ${crypto.randomUUID()}`,
      providerType: "openai_compatible",
      providerRole: "image",
      baseUrl: "http://127.0.0.1:9911",
      defaultModel: "route-image-model",
      contextWindowTokens: 32_768,
      maxOutputTokens: 4_096,
      temperature: 0,
      enabled: true,
      isDefault: true,
      configuration: {}
    }, credentialSecret)).id;
    app = await buildServer(serverOptions({ config: config(assetRoot), pool }));
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
    await rm(assetRoot, { recursive: true, force: true });
  });

  async function campaign() {
    const fixture = JSON.parse(await readFile(resolve("tests/fixtures/legacy-story.json"), "utf8"));
    fixture.world.title = `Illustration route campaign ${crypto.randomUUID()}`;
    const imported = await importLegacyStory(pool, storyImportRequestSchema.parse({
      sourceName: `illustration-route-${crypto.randomUUID()}.story`,
      story: fixture
    }));
    const turn = await pool.query<{ id: string }>(
      "SELECT id FROM turns WHERE campaign_id = $1 AND owner_user_id = $2 ORDER BY turn_number DESC LIMIT 1",
      [imported.campaignId, ownerUserId]
    );
    const narration = Array.from({ length: 20 }, (_, index) =>
      `A lantern bearer crosses the moonlit observatory path beside silver trees number ${index + 1}.`
    ).join(" ");
    await pool.query(
      "UPDATE turns SET narration = $3, image_prompt = $4 WHERE id = $1 AND campaign_id = $2",
      [turn.rows[0]!.id, imported.campaignId, narration, "A lantern bearer crosses a moonlit observatory path beside silver trees."]
    );
    return { ...imported, turnId: turn.rows[0]!.id };
  }

  async function ownedAsset(campaignId: string, turnId: string) {
    const asset = await pool.query<{ id: string }>(
      `INSERT INTO assets (
         owner_user_id, campaign_id, turn_id, content_hash, storage_driver,
         storage_path, mime_type, byte_length
       ) VALUES ($1,$2,$3,$4,'filesystem',$5,'image/png',68) RETURNING id`,
      [ownerUserId, campaignId, turnId,
        crypto.randomUUID().replaceAll("-", "").padEnd(64, "0").slice(0, 64),
        `illustration-route/${crypto.randomUUID()}.png`]
    );
    return asset.rows[0]!.id;
  }

  const illustrationConfig = {
    enabled: true,
    sourcePolicy: "generate_only",
    matchingScope: "world",
    confidenceProfile: "balanced",
    repetitionWindow: 5,
    providerProfileId: "",
    model: "route-image-model",
    size: "1024x1024",
    aspectRatio: "1:1",
    quality: "auto",
    outputFormat: "png",
    maxAttempts: 3,
    segmentWordCount: 100,
    imagesPerSegment: 1,
    segmentPromptMode: "direct",
    refinementPrompt: "Return only a concise fiction-only illustration prompt."
  };

  // Inventory: every illustration route in services/api/src/server.ts is covered here or by the owned-scope matrix below.
  it("preserves status, duplicate, and selection parity across configured illustration routes", async () => {
    const imported = await campaign();
    const configResponse = await app.inject({
      method: "PUT",
      url: `/api/v1/campaigns/${imported.campaignId}/illustration-config`,
      payload: { ...illustrationConfig, providerProfileId: imageProviderId }
    });
    expect(configResponse.statusCode).toBe(200);
    expect(configResponse.json()).toMatchObject({
      enabled: true,
      sourcePolicy: "generate_only",
      providerProfileId: imageProviderId,
      segmentWordCount: 100,
      imagesPerSegment: 1
    });
    const readConfig = await app.inject({ method: "GET", url: `/api/v1/campaigns/${imported.campaignId}/illustration-config` });
    expect(readConfig.statusCode).toBe(200);
    expect(readConfig.json()).toMatchObject(configResponse.json());

    const worldCover = await app.inject({
      method: "POST",
      url: `/api/v1/worlds/${imported.worldId}/cover`,
      payload: { prompt: "A moonlit observatory above silver pines." }
    });
    expect(worldCover.statusCode).toBe(202);
    expect(worldCover.json()).toMatchObject({ id: expect.any(String), targetType: "world_cover", duplicate: false });
    const duplicateWorldCover = await app.inject({
      method: "POST",
      url: `/api/v1/worlds/${imported.worldId}/cover`,
      payload: { prompt: "A moonlit observatory above silver pines." }
    });
    expect(duplicateWorldCover.statusCode).toBe(200);
    expect(duplicateWorldCover.json()).toMatchObject({ id: worldCover.json().id, targetType: "world_cover", duplicate: true });
    const worldCoverJob = await app.inject({ method: "GET", url: `/api/v1/worlds/${imported.worldId}/cover-job` });
    expect(worldCoverJob.statusCode).toBe(200);
    expect(worldCoverJob.json()).toMatchObject({ id: worldCover.json().id, targetType: "world_cover" });

    const assetId = await ownedAsset(imported.campaignId, imported.turnId);
    const selectCover = await app.inject({
      method: "PUT",
      url: `/api/v1/worlds/${imported.worldId}/cover-asset`,
      payload: { assetId }
    });
    expect(selectCover.statusCode).toBe(200);
    expect(selectCover.json()).toEqual({ assetUrl: `/api/v1/assets/${assetId}` });

    const turnImage = await app.inject({
      method: "POST",
      url: `/api/v1/turns/${imported.turnId}/illustrations`,
      payload: { prompt: "A lantern bearer crosses a moonlit observatory path." }
    });
    expect(turnImage.statusCode).toBe(202);
    expect(turnImage.json()).toMatchObject({ id: expect.any(String), turnId: imported.turnId, duplicate: false, status: "queued" });
    const imageJobId = turnImage.json().id as string;
    const duplicateTurnImage = await app.inject({
      method: "POST",
      url: `/api/v1/turns/${imported.turnId}/illustrations`,
      payload: { prompt: "A lantern bearer crosses a moonlit observatory path." }
    });
    expect(duplicateTurnImage.statusCode).toBe(200);
    expect(duplicateTurnImage.json()).toMatchObject({ id: imageJobId, turnId: imported.turnId, duplicate: true, status: "queued" });
    const selectTurnIllustration = await app.inject({
      method: "PUT",
      url: `/api/v1/turns/${imported.turnId}/illustration-asset`,
      payload: { assetId }
    });
    expect(selectTurnIllustration.statusCode).toBe(200);
    expect(selectTurnIllustration.json()).toEqual({ assetUrl: `/api/v1/assets/${assetId}` });
    const jobs = await app.inject({ method: "GET", url: `/api/v1/campaigns/${imported.campaignId}/image-jobs` });
    expect(jobs.statusCode).toBe(200);
    expect(jobs.json()).toMatchObject({ jobs: [expect.objectContaining({ id: imageJobId, turnId: imported.turnId })] });
    const imageJob = await app.inject({ method: "GET", url: `/api/v1/image-jobs/${imageJobId}` });
    expect(imageJob.statusCode).toBe(200);
    expect(imageJob.json()).toMatchObject({ id: imageJobId, campaignId: imported.campaignId, status: "queued" });
    const queuedRetry = await app.inject({ method: "POST", url: `/api/v1/image-jobs/${imageJobId}/retry` });
    expect(queuedRetry.statusCode).toBe(409);
    const missingRetry = await app.inject({ method: "POST", url: `/api/v1/image-jobs/${crypto.randomUUID()}/retry` });
    expect(missingRetry.statusCode).toBe(404);
    await pool.query("UPDATE image_jobs SET status = 'failed' WHERE id = $1", [imageJobId]);
    const retry = await app.inject({ method: "POST", url: `/api/v1/image-jobs/${imageJobId}/retry` });
    expect(retry.statusCode).toBe(202);
    expect(retry.json()).toMatchObject({ id: imageJobId, status: "queued", attempts: 0, generationRevision: 1 });

    const segments = await app.inject({
      method: "POST",
      url: `/api/v1/turns/${imported.turnId}/illustration-segments`,
      payload: { mode: "rebuild" }
    });
    expect(segments.statusCode).toBe(202);
    expect(segments.json()).toMatchObject({ setId: expect.any(String), duplicate: false, segmentCount: expect.any(Number) });
    const duplicateSegments = await app.inject({
      method: "POST",
      url: `/api/v1/turns/${imported.turnId}/illustration-segments`,
      payload: { mode: "rebuild" }
    });
    expect(duplicateSegments.statusCode).toBe(202);
    expect(duplicateSegments.json()).toMatchObject({
      setId: expect.any(String),
      duplicate: false,
      segmentCount: segments.json().segmentCount
    });
    expect(duplicateSegments.json().setId).not.toBe(segments.json().setId);
    const existingSegments = await app.inject({
      method: "POST",
      url: `/api/v1/turns/${imported.turnId}/illustration-segments`,
      payload: { mode: "missing" }
    });
    expect(existingSegments.statusCode).toBe(200);
    expect(existingSegments.json()).toMatchObject({
      setId: duplicateSegments.json().setId,
      duplicate: true,
      segmentCount: 0
    });
    const listSegments = await app.inject({ method: "GET", url: `/api/v1/campaigns/${imported.campaignId}/illustration-segments` });
    expect(listSegments.statusCode).toBe(200);
    expect(listSegments.json().segments).toEqual(expect.arrayContaining([
      expect.objectContaining({ turnId: imported.turnId, id: expect.any(String) })
    ]));
    const segmentId = listSegments.json().segments[0].id as string;
    await pool.query("UPDATE image_jobs SET status = 'failed' WHERE segment_id = $1", [segmentId]);
    const regenerate = await app.inject({
      method: "POST",
      url: `/api/v1/illustration-segments/${segmentId}/images`,
      payload: { prompt: "A lantern bearer on a moonlit observatory path.", variantIndex: 0 }
    });
    expect(regenerate.statusCode).toBe(202);
    expect(regenerate.json()).toMatchObject({ id: expect.any(String), segmentId, variantIndex: 0, duplicate: false, status: "queued" });
    const duplicateRegenerate = await app.inject({
      method: "POST",
      url: `/api/v1/illustration-segments/${segmentId}/images`,
      payload: { prompt: "A lantern bearer on a moonlit observatory path.", variantIndex: 0 }
    });
    expect(duplicateRegenerate.statusCode).toBe(200);
    expect(duplicateRegenerate.json()).toMatchObject({
      id: regenerate.json().id,
      segmentId,
      variantIndex: 0,
      duplicate: true
    });

    await pool.query(
      `INSERT INTO turn_illustration_segment_assets (segment_id, owner_user_id, asset_id, variant_index)
       VALUES ($1,$2,$3,0)`,
      [segmentId, ownerUserId, assetId]
    );
    const deleteVariant = await app.inject({
      method: "DELETE",
      url: `/api/v1/illustration-segments/${segmentId}/images/0`
    });
    expect(deleteVariant.statusCode).toBe(200);
    expect(deleteVariant.json()).toEqual({ segmentId, variantIndex: 0, removedAssetId: assetId, retainedInLibrary: true });

    const preview = await app.inject({
      method: "POST",
      url: `/api/v1/campaigns/${imported.campaignId}/illustration-backfill/preview`,
      payload: { mode: "missing" }
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject({ campaignId: imported.campaignId, mode: "missing", totalCampaignTurns: 2 });
    const backfillIdempotencyKey = `route-backfill-${crypto.randomUUID()}`;
    const backfill = await app.inject({
      method: "POST",
      url: `/api/v1/campaigns/${imported.campaignId}/illustration-backfill`,
      payload: {
        mode: "missing",
        idempotencyKey: backfillIdempotencyKey,
        expectedConfigUpdatedAt: preview.json().configUpdatedAt,
        expectedTurnCount: preview.json().totalCampaignTurns
      }
    });
    expect(backfill.statusCode).toBe(202);
    expect(backfill.json()).toMatchObject({ id: expect.any(String), status: "completed", duplicate: false });
    const duplicateBackfill = await app.inject({
      method: "POST",
      url: `/api/v1/campaigns/${imported.campaignId}/illustration-backfill`,
      payload: {
        mode: "missing",
        idempotencyKey: backfillIdempotencyKey,
        expectedConfigUpdatedAt: preview.json().configUpdatedAt,
        expectedTurnCount: preview.json().totalCampaignTurns
      }
    });
    expect(duplicateBackfill.statusCode).toBe(202);
    expect(duplicateBackfill.json()).toMatchObject({ id: backfill.json().id, status: "completed", duplicate: true });

    await pool.query(
      `INSERT INTO illustration_resolution_jobs (
         owner_user_id, campaign_id, turn_id, source_policy, matching_scope, confidence_profile,
         query_context_snapshot, status, completed_at
       ) VALUES ($1,$2,$3,'library_only','world','balanced','{}'::jsonb,'completed',now())`,
      [ownerUserId, imported.campaignId, imported.turnId]
    );
    const resolution = await app.inject({ method: "GET", url: `/api/v1/turns/${imported.turnId}/illustration-resolution` });
    expect(resolution.statusCode).toBe(200);
    expect(resolution.json()).toMatchObject({ campaignId: imported.campaignId, turnId: imported.turnId, status: "completed", candidates: [] });
    const rematch = await app.inject({ method: "POST", url: `/api/v1/turns/${imported.turnId}/illustration-match` });
    expect(rematch.statusCode).toBe(202);
    expect(rematch.json()).toMatchObject({ id: resolution.json().id, status: "queued" });
  });

  it("returns 404 rather than exposing every foreign-owned illustration resource route", async () => {
    const foreignUserId = crypto.randomUUID();
    await pool.query("INSERT INTO users (id, display_name) VALUES ($1, 'Foreign illustration route owner')", [foreignUserId]);
    const foreignWorld = await pool.query<{ id: string }>(
      "INSERT INTO worlds (owner_user_id, title) VALUES ($1, 'Foreign illustration route world') RETURNING id",
      [foreignUserId]
    );
    const foreignVersion = await pool.query<{ id: string }>(
      "INSERT INTO world_versions (world_id, owner_user_id, version_number, content) VALUES ($1,$2,1,$3::jsonb) RETURNING id",
      [foreignWorld.rows[0]!.id, foreignUserId, JSON.stringify({ schemaVersion: 4, world: { title: "Foreign illustration route world" } })]
    );
    const foreignCampaign = await pool.query<{ id: string }>(
      "INSERT INTO campaigns (owner_user_id, world_version_id, title, active_turn_number) VALUES ($1,$2,'Foreign illustration route campaign',1) RETURNING id",
      [foreignUserId, foreignVersion.rows[0]!.id]
    );
    await pool.query("INSERT INTO campaign_state (campaign_id, owner_user_id) VALUES ($1,$2)", [foreignCampaign.rows[0]!.id, foreignUserId]);
    const foreignTurn = await pool.query<{ id: string }>(
      "INSERT INTO turns (owner_user_id, campaign_id, turn_number, narration) VALUES ($1,$2,1,'Foreign moonlit observatory.') RETURNING id",
      [foreignUserId, foreignCampaign.rows[0]!.id]
    );
    const foreignSet = await pool.query<{ id: string }>(
      `INSERT INTO turn_illustration_sets (
         owner_user_id, campaign_id, turn_id, source_text_hash, segment_word_count, images_per_segment, prompt_mode
       ) VALUES ($1,$2,$3,'foreign-route-segment',100,1,'direct') RETURNING id`,
      [foreignUserId, foreignCampaign.rows[0]!.id, foreignTurn.rows[0]!.id]
    );
    const foreignSegment = await pool.query<{ id: string }>(
      `INSERT INTO turn_illustration_segments (
         owner_user_id, illustration_set_id, campaign_id, turn_id, ordinal, start_offset, end_offset,
         start_word, end_word, source_text, source_text_hash, direct_prompt
       ) VALUES ($1,$2,$3,$4,0,0,27,0,4,'Foreign moonlit observatory.','foreign-route-segment','Foreign moonlit observatory.') RETURNING id`,
      [foreignUserId, foreignSet.rows[0]!.id, foreignCampaign.rows[0]!.id, foreignTurn.rows[0]!.id]
    );
    const foreignProvider = await pool.query<{ id: string }>(
      `INSERT INTO provider_profiles (
         owner_user_id, name, provider_type, provider_role, base_url, default_model
       ) VALUES ($1,'Foreign route image provider','openai_compatible','image','http://127.0.0.1:9911','foreign-image-model')
       RETURNING id`,
      [foreignUserId]
    );
    const foreignJob = await pool.query<{ id: string }>(
      `INSERT INTO image_jobs (
         owner_user_id, campaign_id, turn_id, provider_profile_id, requested_model, prompt, prompt_hash,
         status, provider_type, world_id, target_type, completed_at
       ) VALUES ($1,NULL,NULL,$2,'foreign-image-model','Foreign observatory','foreign-route-job','failed',
                 'openai_compatible',$3,'world_cover',now()) RETURNING id`,
      [foreignUserId, foreignProvider.rows[0]!.id, foreignWorld.rows[0]!.id]
    );
    const foreignConfigPayload = { ...illustrationConfig, providerProfileId: imageProviderId };
    const foreignBackfillPayload = {
      mode: "missing",
      idempotencyKey: `foreign-backfill-${crypto.randomUUID()}`,
      expectedConfigUpdatedAt: new Date().toISOString(),
      expectedTurnCount: 1
    };
    const foreignCampaignId = foreignCampaign.rows[0]!.id;
    const foreignWorldId = foreignWorld.rows[0]!.id;
    const foreignTurnId = foreignTurn.rows[0]!.id;
    const foreignSegmentId = foreignSegment.rows[0]!.id;
    const foreignJobId = foreignJob.rows[0]!.id;

    const expectNotFound = async (route: string, response: PromiseLike<{ statusCode: number }>) => {
      expect((await response).statusCode, route).toBe(404);
    };
    await Promise.all([
      expectNotFound("campaign illustration config read", app.inject({ method: "GET", url: `/api/v1/campaigns/${foreignCampaignId}/illustration-config` })),
      expectNotFound("campaign illustration config write", app.inject({ method: "PUT", url: `/api/v1/campaigns/${foreignCampaignId}/illustration-config`, payload: foreignConfigPayload })),
      expectNotFound("world cover enqueue", app.inject({ method: "POST", url: `/api/v1/worlds/${foreignWorldId}/cover`, payload: { prompt: "Foreign observatory cover." } })),
      expectNotFound("world cover job read", app.inject({ method: "GET", url: `/api/v1/worlds/${foreignWorldId}/cover-job` })),
      expectNotFound("world cover selection", app.inject({ method: "PUT", url: `/api/v1/worlds/${foreignWorldId}/cover-asset`, payload: { assetId: null } })),
      expectNotFound("campaign image jobs list", app.inject({ method: "GET", url: `/api/v1/campaigns/${foreignCampaignId}/image-jobs` })),
      expectNotFound("campaign illustration segments list", app.inject({ method: "GET", url: `/api/v1/campaigns/${foreignCampaignId}/illustration-segments` })),
      expectNotFound("illustration backfill preview", app.inject({ method: "POST", url: `/api/v1/campaigns/${foreignCampaignId}/illustration-backfill/preview`, payload: { mode: "missing" } })),
      expectNotFound("illustration backfill enqueue", app.inject({ method: "POST", url: `/api/v1/campaigns/${foreignCampaignId}/illustration-backfill`, payload: foreignBackfillPayload })),
      expectNotFound("turn segment generation", app.inject({ method: "POST", url: `/api/v1/turns/${foreignTurnId}/illustration-segments`, payload: { mode: "missing" } })),
      expectNotFound("segment image regeneration", app.inject({ method: "POST", url: `/api/v1/illustration-segments/${foreignSegmentId}/images`, payload: { prompt: "Foreign observatory.", variantIndex: 0 } })),
      expectNotFound("segment variant deletion", app.inject({ method: "DELETE", url: `/api/v1/illustration-segments/${foreignSegmentId}/images/0` })),
      expectNotFound("turn illustration enqueue", app.inject({ method: "POST", url: `/api/v1/turns/${foreignTurnId}/illustrations`, payload: { prompt: "Foreign observatory." } })),
      expectNotFound("turn illustration selection", app.inject({ method: "PUT", url: `/api/v1/turns/${foreignTurnId}/illustration-asset`, payload: { assetId: null } })),
      expectNotFound("turn illustration resolution", app.inject({ method: "GET", url: `/api/v1/turns/${foreignTurnId}/illustration-resolution` })),
      expectNotFound("turn illustration rematch", app.inject({ method: "POST", url: `/api/v1/turns/${foreignTurnId}/illustration-match` })),
      expectNotFound("image job read", app.inject({ method: "GET", url: `/api/v1/image-jobs/${foreignJobId}` })),
      expectNotFound("image job retry", app.inject({ method: "POST", url: `/api/v1/image-jobs/${foreignJobId}/retry` }))
    ]);
  });
});
