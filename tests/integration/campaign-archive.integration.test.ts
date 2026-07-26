import { mkdtemp, readFile, rm, stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { createDatabasePool, initialOwnerId, withTransaction, type DatabasePool } from "../../packages/database/src/pool.js";
import { inspectArchive, readVerifiedEntry, type ArchiveLimits } from "../../services/api/src/archive-io.js";
import { persistOriginalImage } from "../../services/api/src/asset-service.js";
import { exportCampaign } from "../../services/api/src/campaign-archive-service.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

const limits: ArchiveLimits = {
  maxCompressedBytes: 10 * 1024 * 1024,
  maxUncompressedBytes: 50 * 1024 * 1024,
  maxEntries: 1000,
  maxManifestBytes: 1024 * 1024,
  maxJsonEntryBytes: 5 * 1024 * 1024,
  maxExpansionRatio: 100
};

integration("campaign archive export", () => {
  let pool: DatabasePool;
  let root = "";
  let campaignId = "";
  let requiredAssetId = "";
  let unrelatedAssetId = "";

  beforeAll(async () => {
    pool = createDatabasePool(databaseUrl!, 4);
    await migrateDatabase(pool, resolve("database/migrations"));
    root = await mkdtemp(join(tmpdir(), "infinitequest-campaign-archive-"));
    const ownerUserId = await initialOwnerId(pool);
    const world = await pool.query<{ id: string }>(
      "INSERT INTO worlds (owner_user_id, title) VALUES ($1,$2) RETURNING id",
      [ownerUserId, "Archive world"]
    );
    const firstVersion = await pool.query<{ id: string }>(
      `INSERT INTO world_versions (world_id, owner_user_id, version_number, content)
       VALUES ($1,$2,1,$3::jsonb) RETURNING id`,
      [world.rows[0]!.id, ownerUserId, JSON.stringify({ schemaVersion: 4, world: { title: "Archive world", firstAction: "Begin." } })]
    );
    const secondVersion = await pool.query<{ id: string }>(
      `INSERT INTO world_versions (world_id, owner_user_id, version_number, content)
       VALUES ($1,$2,2,$3::jsonb) RETURNING id`,
      [world.rows[0]!.id, ownerUserId, JSON.stringify({ schemaVersion: 4, world: { title: "Archive world v2", firstAction: "Ignore me." } })]
    );
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
    await pool.query(
      `INSERT INTO turns (owner_user_id, campaign_id, turn_number, action, narration, accepted_at)
       VALUES ($1,$2,1,'Open the door.','The archive door opens.',now())`,
      [ownerUserId, campaignId]
    );
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
    await pool.query(
      "INSERT INTO asset_references (owner_user_id, asset_id, campaign_id, turn_id, asset_role) SELECT owner_user_id,id,$2,NULL,'import_attachment' FROM assets WHERE id=$1",
      [requiredAssetId, campaignId]
    );
  });

  afterAll(async () => {
    await pool?.end();
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("exports only the selected campaign and pinned world version as a deterministic manifest archive", async () => {
    const artifact = await exportCampaign(pool, campaignId, { assetStore: { root }, archiveRoot: root });
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
    expect(manifest.assets.map((asset) => asset.sourceAssetId)).toContain(requiredAssetId);
    expect(manifest.assets.map((asset) => asset.sourceAssetId)).not.toContain(unrelatedAssetId);
    const serialized = await Promise.all(["campaign.json", "world.json", "chronicle.json", "assets/assets.json"].map(async (path) => (
      (await readVerifiedEntry(archive, path, limits.maxJsonEntryBytes)).toString("utf8")
    )));
    expect(serialized.join("\n")).not.toMatch(/credential|thumbnail|embedding|providerProfile|responseChain|private reasoning/i);
  });

  it("fails closed when a required original is absent", async () => {
    const source = await pool.query<{ storage_path: string }>("SELECT storage_path FROM assets WHERE id=$1", [requiredAssetId]);
    await unlink(resolve(root, source.rows[0]!.storage_path));
    await expect(exportCampaign(pool, campaignId, { assetStore: { root }, archiveRoot: root }))
      .rejects.toMatchObject({ code: "archive-asset-missing", assetIds: [requiredAssetId] });
  });
});
