import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, readFile, rm, stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { once } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import { ZipArchive } from "archiver";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { createDatabasePool, initialOwnerId, withTransaction, type DatabasePool } from "../../packages/database/src/pool.js";
import { inspectArchive, readVerifiedEntry, type ArchiveLimits } from "../../services/api/src/archive-io.js";
import { stageArchiveUpload } from "../../services/api/src/archive-io.js";
import { persistOriginalImage } from "../../services/api/src/asset-service.js";
import { exportCampaign, previewCampaignArchive } from "../../services/api/src/campaign-archive-service.js";
import { importCampaignArchive } from "../../services/api/src/import-service.js";
import type { RuntimeConfig } from "../../packages/database/src/config.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

const limits: ArchiveLimits = {
  maxCompressedBytes: 10 * 1024 * 1024,
  maxUncompressedBytes: 50 * 1024 * 1024,
  maxEntries: 1000,
  maxManifestBytes: 1024 * 1024,
  maxJsonEntryBytes: 5 * 1024 * 1024,
  maxExpansionRatio: 100,
  maxOriginalImageBytes: 25 * 1024 * 1024
};

integration("campaign archive export", () => {
  let pool: DatabasePool;
  let root = "";
  let campaignId = "";
  let requiredAssetId = "";
  let unrelatedAssetId = "";
  let worldCoverAssetId = "";
  let segmentAssetIds: string[] = [];
  let turnId = "";
  let worldId = "";
  let sourceWorldVersionId = "";
  let mismatchedWorldVersionId = "";
  let segmentId = "";

  beforeAll(async () => {
    pool = createDatabasePool(databaseUrl!, 4);
    await migrateDatabase(pool, resolve("database/migrations"));
    root = await mkdtemp(join(tmpdir(), "infinitequest-campaign-archive-"));
    const ownerUserId = await initialOwnerId(pool);
    const world = await pool.query<{ id: string }>(
      "INSERT INTO worlds (owner_user_id, title) VALUES ($1,$2) RETURNING id",
      [ownerUserId, "Archive world"]
    );
    worldId = world.rows[0]!.id;
    const firstVersion = await pool.query<{ id: string }>(
      `INSERT INTO world_versions (world_id, owner_user_id, version_number, content)
       VALUES ($1,$2,1,$3::jsonb) RETURNING id`,
      [world.rows[0]!.id, ownerUserId, JSON.stringify({ schemaVersion: 4, world: { title: "Archive world", firstAction: "Begin.", provider: { apiKey: "nested-secret" } } })]
    );
    const secondVersion = await pool.query<{ id: string }>(
      `INSERT INTO world_versions (world_id, owner_user_id, version_number, content)
       VALUES ($1,$2,2,$3::jsonb) RETURNING id`,
      [world.rows[0]!.id, ownerUserId, JSON.stringify({ schemaVersion: 4, world: { title: "Archive world v2", firstAction: "Ignore me." } })]
    );
    sourceWorldVersionId = firstVersion.rows[0]!.id;
    mismatchedWorldVersionId = secondVersion.rows[0]!.id;
    const campaign = await pool.query<{ id: string }>(
      `INSERT INTO campaigns (owner_user_id, world_version_id, title, active_turn_number, character_profile, character_profile_revision)
       VALUES ($1,$2,'Archive campaign',1,$3::jsonb,1) RETURNING id`,
      [ownerUserId, firstVersion.rows[0]!.id, JSON.stringify({ name: "Avery", profile: { identity: { aliases: [] } } })]
    );
    campaignId = campaign.rows[0]!.id;
    await pool.query(
      "INSERT INTO campaign_state (campaign_id, owner_user_id) VALUES ($1,$2)",
      [campaignId, ownerUserId]
    );
    await pool.query(
      `INSERT INTO campaigns (owner_user_id, world_version_id, title) VALUES ($1,$2,'Unrelated campaign')`,
      [ownerUserId, secondVersion.rows[0]!.id]
    );
    const turn = await pool.query<{ id: string }>(
      `INSERT INTO turns (owner_user_id, campaign_id, turn_number, action, narration, accepted_at)
       VALUES ($1,$2,1,'Open the door.','The archive door opens.',now()) RETURNING id`,
      [ownerUserId, campaignId]
    );
    turnId = turn.rows[0]!.id;
    await pool.query(
      `INSERT INTO campaign_state_edits (owner_user_id, campaign_id, effective_turn_number, revision, state_snapshot_private, changed_fields)
       VALUES ($1,$2,1,1,$3::jsonb,'["scratchpad"]'::jsonb)`,
      [ownerUserId, campaignId, JSON.stringify({ scratchpad: "State edit." })]
    );
    await pool.query("UPDATE campaign_state SET revision=1 WHERE campaign_id=$1", [campaignId]);
    await pool.query(
      `INSERT INTO campaign_character_profile_edits (owner_user_id, campaign_id, revision, next_profile, edit_source)
       VALUES ($1,$2,1,$3::jsonb,'manual')`,
      [ownerUserId, campaignId, JSON.stringify({ name: "Avery", profile: { identity: { aliases: [] } } })]
    );
    await pool.query(
      `INSERT INTO summary_checkpoints (owner_user_id, campaign_id, summary_kind, through_turn, content)
       VALUES ($1,$2,'legacy_full_history',1,$3::jsonb)`,
      [ownerUserId, campaignId, JSON.stringify({ history: "Checkpoint" })]
    );
    await pool.query(
      `INSERT INTO chronicle_memories (owner_user_id, campaign_id, world_version_id, memory_kind, ordinal, content, token_estimate, importance, entities, metadata)
       VALUES ($1,$2,$3,'legacy_summary',1,'Chronicle marker',2,0.5,ARRAY[]::text[],'{}'::jsonb)`,
      [ownerUserId, campaignId, firstVersion.rows[0]!.id]
    );
    requiredAssetId = await withTransaction(pool, async (client) => (await persistOriginalImage(
      client,
      { root },
      ownerUserId,
      { bytes: await sharp({ create: { width: 2, height: 2, channels: 4, background: "#ff0000" } }).png().toBuffer(), mimeType: "image/png", createThumbnail: false }
    )).id);
    unrelatedAssetId = await withTransaction(pool, async (client) => (await persistOriginalImage(
      client,
      { root },
      ownerUserId,
      { bytes: await sharp({ create: { width: 2, height: 2, channels: 4, background: "#00ff00" } }).png().toBuffer(), mimeType: "image/png", createThumbnail: false }
    )).id);
    worldCoverAssetId = await withTransaction(pool, async (client) => (await persistOriginalImage(
      client,
      { root },
      ownerUserId,
      { bytes: await sharp({ create: { width: 2, height: 2, channels: 4, background: "#0000ff" } }).png().toBuffer(), mimeType: "image/png", createThumbnail: false }
    )).id);
    segmentAssetIds = await Promise.all(["#ffff00", "#00ffff"].map(async (background) => withTransaction(pool, async (client) => {
      const stored = await persistOriginalImage(client, { root }, ownerUserId, {
        bytes: await sharp({ create: { width: 2, height: 2, channels: 4, background } }).png().toBuffer(),
        mimeType: "image/png",
        createThumbnail: false
      });
      return stored.id;
    })));
    await pool.query(
      "INSERT INTO asset_references (owner_user_id, asset_id, campaign_id, turn_id, asset_role) SELECT owner_user_id,id,$2,NULL,'import_attachment' FROM assets WHERE id=$1",
      [requiredAssetId, campaignId]
    );
    await pool.query("UPDATE worlds SET cover_asset_id=$2 WHERE id=$1", [world.rows[0]!.id, worldCoverAssetId]);
    await pool.query(
      `UPDATE campaigns SET legacy_settings=$2::jsonb WHERE id=$1`,
      [campaignId, JSON.stringify({ provider: { apiKey: "nested-secret", encryptionKey: "encrypted-secret" } })]
    );
    await pool.query(
      `UPDATE campaign_state SET import_provenance=$2::jsonb WHERE campaign_id=$1`,
      [campaignId, JSON.stringify({ world: { source: "fixture" }, story: { source: "fixture" } })]
    );
    await pool.query(
      `INSERT INTO campaign_world_migrations (owner_user_id,campaign_id,from_world_version_id,to_world_version_id,note)
       VALUES ($1,$2,$3,$4,'Fixture migration provenance')`,
      [ownerUserId, campaignId, secondVersion.rows[0]!.id, firstVersion.rows[0]!.id]
    );
    await pool.query(
      `INSERT INTO campaign_illustration_configs (campaign_id,owner_user_id,enabled,model)
       VALUES ($1,$2,false,'')`,
      [campaignId, ownerUserId]
    );
    const set = await pool.query<{ id: string }>(
      `INSERT INTO turn_illustration_sets (owner_user_id,campaign_id,turn_id,source_text_hash,segment_word_count,images_per_segment,prompt_mode,status,is_active,character_visual_reference,completed_at)
       VALUES ($1,$2,$3,'fixture-hash',100,2,'direct','completed',true,'Avery wears a blue coat.',now()) RETURNING id`,
      [ownerUserId, campaignId, turnId]
    );
    const segment = await pool.query<{ id: string }>(
      `INSERT INTO turn_illustration_segments (owner_user_id,illustration_set_id,campaign_id,turn_id,ordinal,start_offset,end_offset,start_word,end_word,source_text,source_text_hash,direct_prompt,resolved_prompt,prompt_source,status)
       VALUES ($1,$2,$3,$4,0,0,10,0,2,'Archive door opens.','fixture-hash','An archive door.','An archive door.','direct','completed') RETURNING id`,
      [ownerUserId, set.rows[0]!.id, campaignId, turnId]
    );
    segmentId = segment.rows[0]!.id;
    await pool.query(
      `INSERT INTO turn_illustration_segment_assets (segment_id,owner_user_id,asset_id,variant_index)
       VALUES ($1,$2,$3,0),($1,$2,$4,1)`,
      [segment.rows[0]!.id, ownerUserId, segmentAssetIds[0], segmentAssetIds[1]]
    );
    await pool.query(
      `INSERT INTO provider_cost_events (owner_user_id,campaign_id,turn_id,provider_type,category,operation,requested_model,resolved_model,amount,currency,usage_metadata)
       VALUES ($1,$2,$3,'openai_compatible','image','illustration','fixture-image','fixture-image',0.01,'USD','{}'::jsonb)`,
      [ownerUserId, campaignId, turnId]
    );
  });

  afterAll(async () => {
    await pool?.end();
    if (root) await rm(root, { recursive: true, force: true });
  });

  function runtimeConfig(ttlSeconds = 1_800): RuntimeConfig {
    return {
      assetStorageRoot: root,
      archiveStorageRoot: root,
      archivePreviewTtlSeconds: ttlSeconds,
      campaignArchiveLimits: limits
    } as RuntimeConfig;
  }

  async function stagedExport() {
    const artifact = await exportCampaign(pool, campaignId, { assetStore: { root }, archiveRoot: root, limits });
    return stageArchiveUpload(Readable.from(await readFile(artifact.absolutePath)), root, limits);
  }

  async function createCompatibleDestination(title: string): Promise<{ worldId: string; worldVersionId: string }> {
    const source = await pool.query<{ content: unknown }>("SELECT content FROM world_versions WHERE id=$1", [sourceWorldVersionId]);
    const createdWorld = await pool.query<{ id: string }>("INSERT INTO worlds (owner_user_id,title) SELECT owner_user_id,$2 FROM worlds WHERE id=$1 RETURNING id", [worldId, title]);
    const createdVersion = await pool.query<{ id: string }>(
      "INSERT INTO world_versions (world_id,owner_user_id,version_number,content) SELECT $1,owner_user_id,1,$2::jsonb FROM worlds WHERE id=$1 RETURNING id",
      [createdWorld.rows[0]!.id, JSON.stringify(source.rows[0]!.content)]
    );
    return { worldId: createdWorld.rows[0]!.id, worldVersionId: createdVersion.rows[0]!.id };
  }

  it("exports only the selected campaign and pinned world version as a deterministic manifest archive", async () => {
    const artifact = await exportCampaign(pool, campaignId, { assetStore: { root }, archiveRoot: root, limits });
    const repeated = await exportCampaign(pool, campaignId, { assetStore: { root }, archiveRoot: root, limits });
    expect(repeated.contentFingerprint).toBe(artifact.contentFingerprint);
    const archive = await inspectArchive({ relativePath: artifact.relativePath, absolutePath: artifact.absolutePath, compressedBytes: artifact.byteLength }, limits, "campaign");
    const paths = [...archive.entries.keys()].sort();
    expect(paths).toEqual([
      "assets/assets.json",
      ...archive.manifest.assets.map((asset) => asset.archivePath),
      "campaign.json", "chronicle.json", "world.json"
    ].sort());
    const campaign = JSON.parse((await readVerifiedEntry(archive, "campaign.json", limits.maxJsonEntryBytes)).toString("utf8"));
    const world = JSON.parse((await readVerifiedEntry(archive, "world.json", limits.maxJsonEntryBytes)).toString("utf8"));
    expect(campaign.world.canonicalHash).toBe(world.canonicalHash);
    const manifest = archive.manifest;
    expect(manifest.archiveType).toBe("campaign");
    expect(manifest.campaignId).toBe(campaignId);
    expect(manifest.assets.map((asset) => asset.sourceAssetId)).toEqual(expect.arrayContaining([
      requiredAssetId, worldCoverAssetId, ...segmentAssetIds
    ]));
    expect(manifest.assets.map((asset) => asset.sourceAssetId)).not.toContain(unrelatedAssetId);
    expect(manifest.assets.find((asset) => asset.sourceAssetId === requiredAssetId)?.bindings).toEqual([
      { role: "imported_attachment", campaignId, turnId: null }
    ]);
    expect(manifest.assets.find((asset) => asset.sourceAssetId === worldCoverAssetId)?.bindings).toEqual([
      { role: "world_cover", worldId }
    ]);
    expect(manifest.assets.find((asset) => asset.sourceAssetId === segmentAssetIds[0])?.bindings).toEqual([
      { role: "illustration_segment_variant", campaignId, turnId, segmentId, variantIndex: 0 }
    ]);
    expect(manifest.assets.find((asset) => asset.sourceAssetId === segmentAssetIds[1])?.bindings).toEqual([
      { role: "illustration_segment_variant", campaignId, turnId, segmentId, variantIndex: 1 }
    ]);
    const serialized = await Promise.all(["campaign.json", "world.json", "chronicle.json", "assets/assets.json"].map(async (path) => (
      (await readVerifiedEntry(archive, path, limits.maxJsonEntryBytes)).toString("utf8")
    )));
    const combined = serialized.join("\n");
    expect(combined).not.toContain("nested-secret");
    expect(combined).not.toMatch(/credential|thumbnail|embedding|providerProfile|responseChain|private reasoning/i);
    expect(campaign.archiveRecords.worldMigrations).toHaveLength(1);
    expect(campaign.archiveRecords.worldMigrations[0]).toMatchObject({ note: "Fixture migration provenance" });
    expect(campaign.archiveRecords.characterProfileEdits).toEqual([
      expect.objectContaining({ revision: 1, edit_source: "manual" })
    ]);
    expect(campaign.archiveRecords.stateEdits).toEqual([
      expect.objectContaining({ effective_turn_number: 1, revision: 1, state_snapshot_private: { scratchpad: "State edit." } })
    ]);
    expect(campaign.archiveRecords.illustrationConfig).toMatchObject({ enabled: false, model: "", images_per_segment: 1 });
    expect(campaign.archiveRecords.illustrationSets).toEqual([
      expect.objectContaining({ turn_id: turnId, source_text_hash: "fixture-hash", images_per_segment: 2, prompt_mode: "direct" })
    ]);
    expect(campaign.archiveRecords.illustrationSegments).toEqual([
      expect.objectContaining({ id: segmentId, turn_id: turnId, ordinal: 0, direct_prompt: "An archive door.", prompt_source: "direct" })
    ]);
    expect(campaign.archiveRecords.costs).toEqual([
      expect.objectContaining({ turn_id: turnId, provider_type: "openai_compatible", category: "image", operation: "illustration", amount: "0.01", currency: "USD" })
    ]);
    const chronicle = JSON.parse((await readVerifiedEntry(archive, "chronicle.json", limits.maxJsonEntryBytes)).toString("utf8"));
    expect(chronicle.memories).toEqual([
      expect.objectContaining({ memory_kind: "legacy_summary", content: "Chronicle marker" })
    ]);
    expect(chronicle.summaries).toEqual([
      expect.objectContaining({ summary_kind: "legacy_full_history", through_turn: 1, content: { history: "Checkpoint" } })
    ]);
  });

  it("fails closed for an archive that exceeds configured limits", async () => {
    await expect(exportCampaign(pool, campaignId, {
      assetStore: { root }, archiveRoot: root, limits: { ...limits, maxEntries: 1 }
    })).rejects.toMatchObject({ code: "archive-limit-exceeded" });
  });

  it("fails closed when a required original exceeds the configured export image limit", async () => {
    await expect(exportCampaign(pool, campaignId, {
      assetStore: { root }, archiveRoot: root, limits: { ...limits, maxOriginalImageBytes: 1 }
    })).rejects.toMatchObject({ code: "archive-limit-exceeded" });
  });

  it("rejects a campaign state revision that does not match its edit ledger", async () => {
    await pool.query("UPDATE campaign_state SET revision=2 WHERE campaign_id=$1", [campaignId]);
    await expect(exportCampaign(pool, campaignId, null)).rejects.toMatchObject({ code: "archive-export-inconsistent" });
    await pool.query("UPDATE campaign_state SET revision=1 WHERE campaign_id=$1", [campaignId]);
  });

  it("fails closed when a required original is absent", async () => {
    const source = await pool.query<{ storage_path: string }>("SELECT storage_path FROM assets WHERE id=$1", [requiredAssetId]);
    await unlink(resolve(root, source.rows[0]!.storage_path));
    await expect(exportCampaign(pool, campaignId, { assetStore: { root }, archiveRoot: root, limits }))
      .rejects.toMatchObject({ code: "archive-asset-missing", assetIds: [requiredAssetId] });
  });

  it("previews without writes and imports a campaign with fresh campaign-owned identities", async () => {
    const config = {
      assetStorageRoot: root,
      archiveStorageRoot: root,
      archivePreviewTtlSeconds: 1_800,
      campaignArchiveLimits: limits
    } as RuntimeConfig;
    const artifact = await exportCampaign(pool, campaignId, { assetStore: { root }, archiveRoot: root, limits });
    const staged = await stageArchiveUpload(Readable.from(await readFile(artifact.absolutePath)), root, limits);
    const before = await pool.query<{ worlds: string; campaigns: string; assets: string }>(
      `SELECT (SELECT count(*)::text FROM worlds) AS worlds,
              (SELECT count(*)::text FROM campaigns) AS campaigns,
              (SELECT count(*)::text FROM assets) AS assets`
    );

    const preview = await previewCampaignArchive(pool, config, staged, "fixture-campaign.zip", { kind: "embedded" });

    expect(preview).toMatchObject({
      valid: true,
      archiveType: "campaign",
      campaign: { title: "Archive campaign", acceptedTurnCount: 1, activeTurnNumber: 1, selectedCharacter: { name: "Avery" } },
      chronicle: { memoryCount: 1, summaryCount: 1 },
      assets: { originalCount: 4 },
      providerDataIncluded: false,
      previewToken: expect.any(String),
      destination: { kind: "embedded", operation: "reuse_world_version" }
    });
    const afterPreview = await pool.query<{ worlds: string; campaigns: string; assets: string }>(
      `SELECT (SELECT count(*)::text FROM worlds) AS worlds,
              (SELECT count(*)::text FROM campaigns) AS campaigns,
              (SELECT count(*)::text FROM assets) AS assets`
    );
    expect(afterPreview.rows[0]).toEqual(before.rows[0]);

    const imported = await importCampaignArchive(pool, config, { root }, {
      previewToken: preview.previewToken,
      destination: { kind: "embedded" }
    });
    expect(imported).toMatchObject({ duplicate: false, worldId, worldVersionId: expect.any(String), campaignId: expect.any(String) });
    expect(imported.campaignId).not.toBe(campaignId);
    expect(imported.worldVersionId).toBe((await pool.query<{ id: string }>(
      "SELECT world_version_id AS id FROM campaigns WHERE id=$1", [campaignId]
    )).rows[0]!.id);
    const importedTurn = await pool.query<{ id: string; image_url: string }>(
      "SELECT id,image_url FROM turns WHERE campaign_id=$1 ORDER BY turn_number", [imported.campaignId]
    );
    expect(importedTurn).toHaveLength(1);
    expect(importedTurn.rows[0]!.id).not.toBe(turnId);
    expect(imported.stats).toMatchObject({ turnCount: 1, memoryCount: 1 });
  });

  it("rejects an explicitly selected destination version whose canonical world content differs", async () => {
    await expect(previewCampaignArchive(
      pool,
      runtimeConfig(),
      await stagedExport(),
      "mismatched-destination.zip",
      { kind: "existing_world_version", worldVersionId: mismatchedWorldVersionId }
    )).rejects.toMatchObject({ code: "archive-world-mismatch" });
  });

  it("attaches only exact world versions and scopes idempotency to the selected destination", async () => {
    const firstDestination = await createCompatibleDestination("Exact destination one");
    const secondDestination = await createCompatibleDestination("Exact destination two");
    const firstPreview = await previewCampaignArchive(pool, runtimeConfig(), await stagedExport(), "exact-one.zip", {
      kind: "existing_world_version", worldVersionId: firstDestination.worldVersionId
    });
    const firstImport = await importCampaignArchive(pool, runtimeConfig(), { root }, {
      previewToken: firstPreview.previewToken,
      destination: { kind: "existing_world_version", worldVersionId: firstDestination.worldVersionId }
    });
    const secondPreview = await previewCampaignArchive(pool, runtimeConfig(), await stagedExport(), "exact-two.zip", {
      kind: "existing_world_version", worldVersionId: secondDestination.worldVersionId
    });
    const secondImport = await importCampaignArchive(pool, runtimeConfig(), { root }, {
      previewToken: secondPreview.previewToken,
      destination: { kind: "existing_world_version", worldVersionId: secondDestination.worldVersionId }
    });

    expect(firstImport).toMatchObject({ duplicate: false, worldId: firstDestination.worldId, worldVersionId: firstDestination.worldVersionId });
    expect(secondImport).toMatchObject({ duplicate: false, worldId: secondDestination.worldId, worldVersionId: secondDestination.worldVersionId });
    expect(secondImport.campaignId).not.toBe(firstImport.campaignId);
  });

  it("rejects expired, consumed, and application-stale preview tokens", async () => {
    const expiredPreview = await previewCampaignArchive(pool, runtimeConfig(-1), await stagedExport(), "expired.zip", { kind: "embedded" });
    await expect(importCampaignArchive(pool, runtimeConfig(-1), { root }, {
      previewToken: expiredPreview.previewToken,
      destination: { kind: "embedded" }
    })).rejects.toMatchObject({ code: "archive-preview-stale" });

    const destination = await createCompatibleDestination("Consumed token destination");
    const consumedPreview = await previewCampaignArchive(pool, runtimeConfig(), await stagedExport(), "consumed.zip", {
      kind: "existing_world_version", worldVersionId: destination.worldVersionId
    });
    await expect(importCampaignArchive(pool, runtimeConfig(), { root }, {
      previewToken: consumedPreview.previewToken,
      destination: { kind: "existing_world_version", worldVersionId: destination.worldVersionId }
    })).resolves.toMatchObject({ duplicate: false });
    await expect(importCampaignArchive(pool, runtimeConfig(), { root }, {
      previewToken: consumedPreview.previewToken,
      destination: { kind: "existing_world_version", worldVersionId: destination.worldVersionId }
    })).rejects.toMatchObject({ code: "archive-preview-stale" });

    const stalePreview = await previewCampaignArchive(pool, runtimeConfig(), await stagedExport(), "stale-version.zip", { kind: "embedded" });
    const staleHash = createHash("sha256").update(stalePreview.previewToken, "utf8").digest("hex");
    await pool.query("UPDATE archive_previews SET application_version='obsolete' WHERE token_hash=$1", [staleHash]);
    await expect(importCampaignArchive(pool, runtimeConfig(), { root }, {
      previewToken: stalePreview.previewToken,
      destination: { kind: "embedded" }
    })).rejects.toMatchObject({ code: "archive-preview-stale" });
  });

  it("previews manifest-less legacy ZIPs with compatibility warnings", async () => {
    const archivePath = join(root, "manifest-less-legacy.zip");
    const output = createWriteStream(archivePath, { flags: "wx" });
    const archive = new ZipArchive({ zlib: { level: 9 } });
    const completed = once(output, "close");
    archive.pipe(output);
    archive.append(Buffer.from(JSON.stringify({ world: { schemaVersion: 4, world: { title: "Manifest-less legacy" } }, turns: [] }), "utf8"), { name: "campaign.json" });
    await archive.finalize();
    await completed;
    const preview = await previewCampaignArchive(pool, runtimeConfig(), await stageArchiveUpload(createReadStream(archivePath), root, limits), "manifest-less-legacy.zip", { kind: "embedded" });
    expect(preview.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/no archive manifest/i)]));
  });

  it("rolls back database state and removes newly persisted archive originals after a forced binding failure", async () => {
    const staged = await stagedExport();
    const sourceAsset = await pool.query<{ storage_path: string }>("SELECT storage_path FROM assets WHERE id=$1", [requiredAssetId]);
    const originalPath = resolve(root, sourceAsset.rows[0]!.storage_path);
    await pool.query("DELETE FROM asset_references WHERE asset_id=$1", [requiredAssetId]);
    await pool.query("DELETE FROM assets WHERE id=$1", [requiredAssetId]);
    await unlink(originalPath);
    const before = await pool.query<{ count: string }>("SELECT count(*)::text AS count FROM assets");
    const triggerSuffix = randomUUID().replaceAll("-", "");
    const functionName = `campaign_archive_force_failure_${triggerSuffix}`;
    const triggerName = `campaign_archive_force_failure_trigger_${triggerSuffix}`;
    await pool.query(`CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced archive binding failure'; END; $$`);
    await pool.query(`CREATE TRIGGER ${triggerName} BEFORE INSERT ON asset_references FOR EACH ROW EXECUTE FUNCTION ${functionName}()`);
    try {
      const destination = await createCompatibleDestination("Rollback destination");
      const preview = await previewCampaignArchive(pool, runtimeConfig(), staged, "rollback.zip", {
        kind: "existing_world_version", worldVersionId: destination.worldVersionId
      });
      await expect(importCampaignArchive(pool, runtimeConfig(), { root }, {
        previewToken: preview.previewToken,
        destination: { kind: "existing_world_version", worldVersionId: destination.worldVersionId }
      })).rejects.toThrow("forced archive binding failure");
    } finally {
      await pool.query(`DROP TRIGGER IF EXISTS ${triggerName} ON asset_references`);
      await pool.query(`DROP FUNCTION IF EXISTS ${functionName}()`);
    }
    const after = await pool.query<{ count: string }>("SELECT count(*)::text AS count FROM assets");
    expect(after.rows[0]!.count).toBe(before.rows[0]!.count);
    await expect(stat(originalPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
