import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { createDatabasePool, initialOwnerId, withTransaction, type DatabasePool } from "../../packages/database/src/pool.js";
import {
  collectCampaignArchiveAssets,
  persistArchiveAssets,
  restoreAssetBindings,
  validateArchiveAssets,
  verifyAndWriteArchiveAssets,
  type ArchiveIdMap,
  type CampaignAssetInventory
} from "../../services/api/src/asset-archive-service.js";
import { persistOriginalImage } from "../../services/api/src/asset-service.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration("asset archive portability", () => {
  let pool: DatabasePool;
  let assetRoot = "";
  let archiveRoot = "";
  let ownerUserId = "";
  let destinationOwnerId = "";
  let sourceWorldId = "";
  let sourceWorldVersionId = "";
  let sourceCampaignId = "";
  let foreignCampaignId = "";
  let sourceTurnId = "";
  let sourceSegmentId = "";
  let sourceContextId = "";
  let turnAssetId = "";
  let nullableTurnAssetId = "";
  let nullableTurnIllustrationAssetId = "";
  let coverAssetId = "";
  let historicalCoverJobAssetId = "";
  let streamingJobAssetId = "";
  let contextAssetId = "";
  let foreignContextAssetId = "";
  let segmentAssetId = "";
  let inventory: CampaignAssetInventory;

  async function image(red: number, green: number, blue: number): Promise<Buffer> {
    return sharp({
      create: { width: 2, height: 2, channels: 4, background: { r: red, g: green, b: blue, alpha: 1 } }
    }).png().toBuffer();
  }

  async function insertWorld(title: string): Promise<string> {
    const result = await pool.query<{ id: string }>(
      "INSERT INTO worlds (owner_user_id, title) VALUES ($1, $2) RETURNING id",
      [ownerUserId, title]
    );
    return result.rows[0]!.id;
  }

  async function insertWorldVersion(worldId: string, title: string): Promise<string> {
    const result = await pool.query<{ id: string }>(
      `INSERT INTO world_versions (world_id, owner_user_id, version_number, content)
       VALUES ($1, $2, 1, $3::jsonb) RETURNING id`,
      [worldId, ownerUserId, JSON.stringify({ schemaVersion: 4, world: { title } })]
    );
    return result.rows[0]!.id;
  }

  async function insertCampaign(worldVersionId: string, title: string, userId = ownerUserId): Promise<string> {
    const result = await pool.query<{ id: string }>(
      "INSERT INTO campaigns (owner_user_id, world_version_id, title) VALUES ($1, $2, $3) RETURNING id",
      [userId, worldVersionId, title]
    );
    return result.rows[0]!.id;
  }

  async function insertTurn(campaignId: string, userId = ownerUserId): Promise<string> {
    const result = await pool.query<{ id: string }>(
      `INSERT INTO turns (owner_user_id, campaign_id, turn_number, action, narration)
       VALUES ($1, $2, 1, 'Enter the archive.', 'A synthetic archive fixture opens.') RETURNING id`,
      [userId, campaignId]
    );
    return result.rows[0]!.id;
  }

  async function persistSourceImage(bytes: Buffer): Promise<string> {
    return withTransaction(pool, async (client) => {
      const stored = await persistOriginalImage(client, { root: assetRoot }, ownerUserId, {
        bytes,
        mimeType: "image/png",
        createThumbnail: false
      });
      return stored.id;
    });
  }

  async function insertProviderProfile(): Promise<string> {
    const result = await pool.query<{ id: string }>(
      `INSERT INTO provider_profiles (
         owner_user_id, name, provider_type, provider_role, base_url, default_model,
         context_window_tokens, max_output_tokens, temperature
       ) VALUES ($1, $2, 'openai_compatible', 'image', 'http://127.0.0.1', 'archive-image', 4096, 128, 0)
       RETURNING id`,
      [ownerUserId, `archive-image-${randomUUID()}`]
    );
    return result.rows[0]!.id;
  }

  async function createSourceFixture(): Promise<void> {
    ownerUserId = await initialOwnerId(pool);
    const destinationUser = await pool.query<{ id: string }>(
      `INSERT INTO users (system_key, display_name) VALUES ($1, 'Archive Destination Owner') RETURNING id`,
      [`archive-destination-owner-${randomUUID()}`]
    );
    destinationOwnerId = destinationUser.rows[0]!.id;

    sourceWorldId = await insertWorld("Archive Source World");
    sourceWorldVersionId = await insertWorldVersion(sourceWorldId, "Archive Source World");
    sourceCampaignId = await insertCampaign(sourceWorldVersionId, "Archive Source Campaign");
    foreignCampaignId = await insertCampaign(sourceWorldVersionId, "Archive Foreign Campaign");
    sourceTurnId = await insertTurn(sourceCampaignId);

    turnAssetId = await persistSourceImage(await image(200, 20, 20));
    nullableTurnAssetId = await persistSourceImage(await image(20, 200, 20));
    nullableTurnIllustrationAssetId = await persistSourceImage(await image(200, 120, 20));
    coverAssetId = await persistSourceImage(await image(20, 20, 200));
    historicalCoverJobAssetId = await persistSourceImage(await image(200, 200, 20));
    streamingJobAssetId = await persistSourceImage(await image(200, 20, 200));
    contextAssetId = await persistSourceImage(await image(20, 200, 200));
    foreignContextAssetId = await persistSourceImage(await image(120, 120, 120));
    segmentAssetId = await persistSourceImage(await image(80, 30, 180));

    await pool.query(
      "UPDATE turns SET image_url = $3 WHERE id = $1 AND owner_user_id = $2",
      [sourceTurnId, ownerUserId, `/api/v1/assets/${turnAssetId}`]
    );
    await pool.query(
      "INSERT INTO asset_references (owner_user_id, asset_id, campaign_id, turn_id, asset_role) VALUES ($1, $2, $3, NULL, 'import_attachment')",
      [ownerUserId, nullableTurnAssetId, sourceCampaignId]
    );
    await pool.query(
      "INSERT INTO asset_references (owner_user_id, asset_id, campaign_id, turn_id, asset_role) VALUES ($1, $2, $3, NULL, 'turn_illustration')",
      [ownerUserId, nullableTurnIllustrationAssetId, sourceCampaignId]
    );
    await pool.query(
      "UPDATE worlds SET cover_asset_id = $3 WHERE id = $1 AND owner_user_id = $2",
      [sourceWorldId, ownerUserId, coverAssetId]
    );

    const providerProfileId = await insertProviderProfile();
    await pool.query(
      `INSERT INTO image_jobs (
         owner_user_id, campaign_id, turn_id, provider_profile_id, requested_model, prompt,
         prompt_hash, status, asset_id, provider_type, world_id, target_type, completed_at
       ) VALUES ($1, NULL, NULL, $2, 'archive-image', 'Historical world cover', 'historical-cover', 'completed', $3,
                 'openai_compatible', $4, 'world_cover', now())`,
      [ownerUserId, providerProfileId, historicalCoverJobAssetId, sourceWorldId]
    );

    const generationJob = await pool.query<{ id: string }>(
      `INSERT INTO generation_jobs (
         owner_user_id, campaign_id, provider_profile_id, idempotency_key, expected_turn_number,
         action, status, requested_model, completed_at
       ) VALUES ($1, $2, $3, $4, 2, 'Archive streaming fixture', 'completed', 'archive-image', now()) RETURNING id`,
      [ownerUserId, sourceCampaignId, providerProfileId, `archive-generation-${randomUUID()}`]
    );
    await pool.query(
      `INSERT INTO image_jobs (
         owner_user_id, campaign_id, turn_id, provider_profile_id, requested_model, prompt,
         prompt_hash, status, asset_id, provider_type, world_id, target_type, generation_job_id, completed_at
       ) VALUES ($1, $2, NULL, $3, 'archive-image', 'Streaming fixture', 'streaming-fixture', 'completed', $4,
                 'openai_compatible', NULL, 'streaming_illustration', $5, now())`,
      [ownerUserId, sourceCampaignId, providerProfileId, streamingJobAssetId, generationJob.rows[0]!.id]
    );

    await pool.query(
      `INSERT INTO asset_generation_contexts (
         owner_user_id, asset_id, created_by_user_id, world_id, world_version_id, campaign_id, turn_id,
         target_type, fiction_prompt, model
       ) VALUES ($1, $2, $1, $3, $4, $5, $6, 'other', 'Source campaign context', 'archive-image') RETURNING id`,
      [ownerUserId, contextAssetId, sourceWorldId, sourceWorldVersionId, sourceCampaignId, sourceTurnId]
    ).then((result) => { sourceContextId = result.rows[0]!.id; });
    await pool.query(
      `INSERT INTO asset_generation_contexts (
         owner_user_id, asset_id, created_by_user_id, world_id, world_version_id, campaign_id,
         target_type, fiction_prompt, model
       ) VALUES ($1, $2, $1, $3, $4, $5, 'other', 'Foreign campaign context', 'archive-image')`,
      [ownerUserId, foreignContextAssetId, sourceWorldId, sourceWorldVersionId, foreignCampaignId]
    );

    const illustrationSet = await pool.query<{ id: string }>(
      `INSERT INTO turn_illustration_sets (
         owner_user_id, campaign_id, turn_id, source_text_hash, segment_word_count,
         images_per_segment, prompt_mode, status, is_active, completed_at
       ) VALUES ($1, $2, $3, 'archive-segment', 100, 1, 'direct', 'completed', true, now()) RETURNING id`,
      [ownerUserId, sourceCampaignId, sourceTurnId]
    );
    const segment = await pool.query<{ id: string }>(
      `INSERT INTO turn_illustration_segments (
         owner_user_id, illustration_set_id, campaign_id, turn_id, ordinal,
         start_offset, end_offset, start_word, end_word, source_text, source_text_hash,
         direct_prompt, resolved_prompt, prompt_source, status
       ) VALUES ($1, $2, $3, $4, 0, 0, 10, 0, 2, 'Archive segment', 'archive-segment',
                 'Archive segment prompt', 'Archive segment prompt', 'direct', 'completed') RETURNING id`,
      [ownerUserId, illustrationSet.rows[0]!.id, sourceCampaignId, sourceTurnId]
    );
    sourceSegmentId = segment.rows[0]!.id;
    await pool.query(
      `INSERT INTO turn_illustration_segment_assets (segment_id, owner_user_id, asset_id, variant_index)
       VALUES ($1, $2, $3, 0)`,
      [sourceSegmentId, ownerUserId, segmentAssetId]
    );
  }

  beforeAll(async () => {
    pool = createDatabasePool(databaseUrl!, 6);
    await migrateDatabase(pool, resolve("database/migrations"));
    assetRoot = await mkdtemp(join(tmpdir(), "infinitequest-asset-archive-"));
    archiveRoot = await mkdtemp(join(assetRoot, "archive-"));
    await createSourceFixture();
  });

  afterAll(async () => {
    if (pool) await pool.end();
    if (assetRoot) await rm(assetRoot, { recursive: true, force: true });
  });

  it("uses real SQL projections and keeps inventory within the requested campaign and authoritative cover", async () => {
    inventory = await withTransaction(pool, (client) => collectCampaignArchiveAssets(
      client,
      ownerUserId,
      sourceCampaignId,
      sourceWorldVersionId,
      sourceWorldId
    ));
    const ids = new Set(inventory.records.map((record) => record.sourceAssetId));
    expect(ids).toEqual(new Set([
      turnAssetId,
      nullableTurnAssetId,
      nullableTurnIllustrationAssetId,
      coverAssetId,
      streamingJobAssetId,
      contextAssetId,
      segmentAssetId
    ]));
    expect(ids.has(historicalCoverJobAssetId)).toBe(false);
    expect(ids.has(foreignContextAssetId)).toBe(false);

    const bindings = inventory.records.flatMap((record) => record.bindings);
    expect(bindings).toEqual(expect.arrayContaining([
      { role: "turn_illustration", campaignId: sourceCampaignId, turnId: sourceTurnId },
      { role: "imported_attachment", campaignId: sourceCampaignId, turnId: null },
      { role: "world_cover", worldId: sourceWorldId },
      { role: "campaign_asset", campaignId: sourceCampaignId },
      {
        role: "generation_context",
        campaignId: sourceCampaignId,
        worldId: sourceWorldId,
        worldVersionId: sourceWorldVersionId,
        turnId: sourceTurnId,
        sourceContextId
      },
      {
        role: "illustration_segment_variant",
        campaignId: sourceCampaignId,
        turnId: sourceTurnId,
        segmentId: sourceSegmentId,
        variantIndex: 0
      }
    ]));
    expect(inventory.records.find((record) => record.sourceAssetId === nullableTurnIllustrationAssetId)?.bindings)
      .toEqual([{ role: "campaign_asset", campaignId: sourceCampaignId }]);
    expect(bindings.some((binding) => "sourceContextId" in binding && binding.sourceContextId !== sourceContextId)).toBe(false);
  });

  it("writes and validates original bytes before importing them into a different owner", async () => {
    const sourcePaths = await pool.query<{ id: string; storage_path: string }>(
      "SELECT id, storage_path FROM assets WHERE owner_user_id = $1 AND id = ANY($2::uuid[])",
      [ownerUserId, inventory.records.map((record) => record.sourceAssetId)]
    );
    const paths = new Map(sourcePaths.rows.map((row) => [row.id, row.storage_path]));
    const entries = await verifyAndWriteArchiveAssets({
      records: inventory.records,
      outputRoot: archiveRoot,
      readOriginal: async (sourceAssetId) => readFile(resolve(assetRoot, paths.get(sourceAssetId)!))
    });
    expect(entries).toHaveLength(inventory.uniqueOriginals.length);
    expect(entries.every((entry) => entry.logicalType === "asset-original")).toBe(true);

    const validated = await validateArchiveAssets(
      { records: inventory.records },
      (path) => readFile(resolve(archiveRoot, path))
    );
    expect(validated.assets).toHaveLength(inventory.records.length);
    expect(validated.assets.every((asset) => asset.createThumbnail === false)).toBe(true);
  });

  it("remaps archive IDs and restores legacy, nullable-turn, cover, segment, and context bindings", async () => {
    const destinationWorldId = await (async () => {
      const result = await pool.query<{ id: string }>(
        "INSERT INTO worlds (owner_user_id, title) VALUES ($1, 'Archive Destination World') RETURNING id",
        [destinationOwnerId]
      );
      return result.rows[0]!.id;
    })();
    const destinationWorldVersionId = (await pool.query<{ id: string }>(
      `INSERT INTO world_versions (world_id, owner_user_id, version_number, content)
       VALUES ($1, $2, 1, '{}'::jsonb) RETURNING id`,
      [destinationWorldId, destinationOwnerId]
    )).rows[0]!.id;
    const destinationCampaignId = (await pool.query<{ id: string }>(
      "INSERT INTO campaigns (owner_user_id, world_version_id, title) VALUES ($1, $2, 'Archive Destination Campaign') RETURNING id",
      [destinationOwnerId, destinationWorldVersionId]
    )).rows[0]!.id;
    const destinationTurnId = (await pool.query<{ id: string }>(
      `INSERT INTO turns (owner_user_id, campaign_id, turn_number, action, narration, image_url)
       VALUES ($1, $2, 1, 'Destination action', 'Destination narration', $3) RETURNING id`,
      [destinationOwnerId, destinationCampaignId, `/api/v1/assets/${turnAssetId}`]
    )).rows[0]!.id;
    const destinationSetId = (await pool.query<{ id: string }>(
      `INSERT INTO turn_illustration_sets (
         owner_user_id, campaign_id, turn_id, source_text_hash, segment_word_count,
         images_per_segment, prompt_mode, status, is_active
       ) VALUES ($1, $2, $3, 'destination-segment', 100, 1, 'direct', 'completed', true) RETURNING id`,
      [destinationOwnerId, destinationCampaignId, destinationTurnId]
    )).rows[0]!.id;
    const destinationSegmentId = (await pool.query<{ id: string }>(
      `INSERT INTO turn_illustration_segments (
         owner_user_id, illustration_set_id, campaign_id, turn_id, ordinal,
         start_offset, end_offset, start_word, end_word, source_text, source_text_hash,
         direct_prompt, resolved_prompt, prompt_source, status
       ) VALUES ($1, $2, $3, $4, 0, 0, 10, 0, 2, 'Destination segment', 'destination-segment',
                 'Destination prompt', 'Destination prompt', 'direct', 'completed') RETURNING id`,
      [destinationOwnerId, destinationSetId, destinationCampaignId, destinationTurnId]
    )).rows[0]!.id;
    const destinationTurnCountBeforeRestore = (await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM turns WHERE owner_user_id = $1 AND campaign_id = $2",
      [destinationOwnerId, destinationCampaignId]
    )).rows[0]!.count;

    const validated = await validateArchiveAssets(
      { records: inventory.records },
      (path) => readFile(resolve(archiveRoot, path))
    );
    const idMap = new Map() as ArchiveIdMap;
    idMap.set("world", new Map([[sourceWorldId, destinationWorldId]]));
    idMap.set("worldVersion", new Map([[sourceWorldVersionId, destinationWorldVersionId]]));
    idMap.set("campaign", new Map([[sourceCampaignId, destinationCampaignId]]));
    idMap.set("turn", new Map([[sourceTurnId, destinationTurnId]]));
    idMap.set("illustrationSegment", new Map([[sourceSegmentId, destinationSegmentId]]));

    const restored = await withTransaction(pool, (client) => persistArchiveAssets(
      client,
      { root: assetRoot },
      destinationOwnerId,
      validated,
      idMap
    ));
    expect(new Set(restored.assetIds.values()).size).toBe(inventory.uniqueOriginals.length);
    expect(restored.assetIds.get(turnAssetId)).not.toBe(turnAssetId);

    const destinationContextId = (await pool.query<{ id: string }>(
      `INSERT INTO asset_generation_contexts (
         owner_user_id, asset_id, created_by_user_id, world_id, world_version_id, campaign_id, turn_id,
         target_type, fiction_prompt, model
       ) VALUES ($1, $2, $1, $3, $4, $5, $6, 'other', 'Destination context', 'archive-image') RETURNING id`,
      [destinationOwnerId, restored.assetIds.get(turnAssetId), destinationWorldId, destinationWorldVersionId, destinationCampaignId, destinationTurnId]
    )).rows[0]!.id;
    idMap.set("generationContext", new Map([[sourceContextId, destinationContextId]]));

    await withTransaction(pool, (client) => restoreAssetBindings(
      client,
      destinationOwnerId,
      inventory.records,
      restored.assetIds,
      idMap
    ));

    const destinationWorld = await pool.query<{ cover_asset_id: string | null }>(
      "SELECT cover_asset_id FROM worlds WHERE id = $1 AND owner_user_id = $2",
      [destinationWorldId, destinationOwnerId]
    );
    expect(destinationWorld.rows[0]!.cover_asset_id).toBe(restored.assetIds.get(coverAssetId));

    const destinationTurn = await pool.query<{ image_url: string }>(
      "SELECT image_url FROM turns WHERE id = $1 AND owner_user_id = $2",
      [destinationTurnId, destinationOwnerId]
    );
    expect(destinationTurn.rows[0]!.image_url).toBe(`/api/v1/assets/${restored.assetIds.get(turnAssetId)}`);

    const references = await pool.query<{ asset_id: string; turn_id: string | null; asset_role: string }>(
      `SELECT asset_id, turn_id, asset_role FROM asset_references
       WHERE owner_user_id = $1 AND campaign_id = $2 ORDER BY asset_role, turn_id NULLS FIRST`,
      [destinationOwnerId, destinationCampaignId]
    );
    expect(references.rows).toEqual(expect.arrayContaining([
      { asset_id: restored.assetIds.get(turnAssetId), turn_id: destinationTurnId, asset_role: "turn_illustration" },
      { asset_id: restored.assetIds.get(nullableTurnAssetId), turn_id: null, asset_role: "import_attachment" },
      { asset_id: restored.assetIds.get(nullableTurnIllustrationAssetId), turn_id: null, asset_role: "world_asset" },
      { asset_id: restored.assetIds.get(streamingJobAssetId), turn_id: null, asset_role: "world_asset" }
    ]));
    expect(references.rows.some((row) => row.asset_id === turnAssetId || row.asset_id === nullableTurnAssetId)).toBe(false);

    const nullableTurnIllustrationReferences = await pool.query<{ asset_id: string; turn_id: string | null; asset_role: string }>(
      `SELECT asset_id, turn_id, asset_role FROM asset_references
       WHERE owner_user_id = $1 AND campaign_id = $2 AND asset_id = $3`,
      [destinationOwnerId, destinationCampaignId, restored.assetIds.get(nullableTurnIllustrationAssetId)]
    );
    expect(nullableTurnIllustrationReferences.rows).toEqual([
      { asset_id: restored.assetIds.get(nullableTurnIllustrationAssetId), turn_id: null, asset_role: "world_asset" }
    ]);
    const destinationTurnCountAfterRestore = (await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM turns WHERE owner_user_id = $1 AND campaign_id = $2",
      [destinationOwnerId, destinationCampaignId]
    )).rows[0]!.count;
    expect(destinationTurnCountAfterRestore).toBe(destinationTurnCountBeforeRestore);

    const segmentAsset = await pool.query<{ asset_id: string; variant_index: number }>(
      `SELECT asset_id, variant_index FROM turn_illustration_segment_assets
       WHERE owner_user_id = $1 AND segment_id = $2`,
      [destinationOwnerId, destinationSegmentId]
    );
    expect(segmentAsset.rows).toEqual([{ asset_id: restored.assetIds.get(segmentAssetId), variant_index: 0 }]);

    const context = await pool.query<{ asset_id: string }>(
      "SELECT asset_id FROM asset_generation_contexts WHERE id = $1 AND owner_user_id = $2",
      [destinationContextId, destinationOwnerId]
    );
    expect(context.rows[0]!.asset_id).toBe(restored.assetIds.get(contextAssetId));
  });
});
