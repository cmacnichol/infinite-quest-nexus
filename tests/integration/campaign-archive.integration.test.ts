import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { once } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import { ZipArchive } from "archiver";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { createDatabasePool, initialOwnerId, withTransaction, type DatabasePool } from "../../packages/database/src/pool.js";
import { calculateContentFingerprint, canonicalArchiveJson } from "../../packages/contracts/src/archives.js";
import { inspectArchive, readVerifiedEntry, type ArchiveLimits } from "../../services/api/src/archive-io.js";
import { stageArchiveUpload } from "../../services/api/src/archive-io.js";
import { persistOriginalImage } from "../../services/api/src/asset-service.js";
import { cleanupExpiredArchivePreviews, exportCampaign, previewCampaignArchive } from "../../services/api/src/campaign-archive-service.js";
import { importCampaignArchive } from "../../services/api/src/import-service.js";
import { buildServer } from "../../services/api/src/server.js";
import type { RuntimeConfig } from "../../packages/database/src/config.js";

const archiveCleanupTestState = vi.hoisted(() => ({
  failOncePaths: new Set<string>()
}));

vi.mock("../../services/api/src/archive-io.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../services/api/src/archive-io.js")>();
  return {
    ...actual,
    removeArchivePath: async (archiveRoot: string, relativePath: string) => {
      if (archiveCleanupTestState.failOncePaths.delete(relativePath)) {
        throw Object.assign(new Error("forced transient archive cleanup failure"), { code: "EBUSY" });
      }
      return actual.removeArchivePath(archiveRoot, relativePath);
    }
  };
});

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

afterEach(() => {
  archiveCleanupTestState.failOncePaths.clear();
});

function multipartBody(parts: Array<{ name: string; value: string | Buffer; filename?: string; contentType?: string }>) {
  const boundary = `----infinitequest-${randomUUID()}`;
  const chunks: Buffer[] = [];
  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`, "utf8"));
    const disposition = part.filename
      ? `Content-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\nContent-Type: ${part.contentType ?? "application/octet-stream"}\r\n\r\n`
      : `Content-Disposition: form-data; name="${part.name}"\r\n\r\n`;
    chunks.push(Buffer.from(disposition, "utf8"), Buffer.isBuffer(part.value) ? part.value : Buffer.from(part.value, "utf8"), Buffer.from("\r\n", "utf8"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, "utf8"));
  return { payload: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

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

  function serverConfig(): RuntimeConfig {
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
      webRoot: resolve("apps/web/public"),
      assetStorageDriver: "filesystem",
      assetStorageRoot: root,
      archiveStorageRoot: root,
      archivePreviewTtlSeconds: 1_800,
      systemArchiveArtifactTtlSeconds: 86_400,
      campaignArchiveLimits: limits,
      systemArchiveLimits: limits,
      credentialEncryptionKey: "",
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

  async function artifactNames(): Promise<string[]> {
    try {
      return await readdir(join(root, "artifacts"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async function stagedExport() {
    const artifact = await exportCampaign(pool, campaignId, { assetStore: { root }, archiveRoot: root, limits });
    return stageArchiveUpload(Readable.from(await readFile(artifact.absolutePath)), root, limits);
  }

  async function stagedExportWithContradictoryAssetPayload() {
    const artifact = await exportCampaign(pool, campaignId, { assetStore: { root }, archiveRoot: root, limits });
    const stagedArtifact = await stageArchiveUpload(
      Readable.from(await readFile(artifact.absolutePath)),
      root,
      limits
    );
    const inspected = await inspectArchive(stagedArtifact, limits, "campaign");
    const entryBytes = new Map<string, Buffer>();
    for (const entry of inspected.manifest.entries) {
      entryBytes.set(entry.path, await readVerifiedEntry(
        inspected,
        entry.path,
        entry.mediaType === "application/json" ? limits.maxJsonEntryBytes : limits.maxOriginalImageBytes
      ));
    }
    const assetPayload = JSON.parse(entryBytes.get("assets/assets.json")!.toString("utf8"));
    assetPayload.assets[0].library.title = "Contradictory payload title";
    const contradictoryBytes = Buffer.from(canonicalArchiveJson(assetPayload), "utf8");
    entryBytes.set("assets/assets.json", contradictoryBytes);
    const entries = inspected.manifest.entries.map((entry) => entry.path === "assets/assets.json"
      ? {
          ...entry,
          byteLength: contradictoryBytes.byteLength,
          sha256: createHash("sha256").update(contradictoryBytes).digest("hex")
        }
      : entry);
    const manifest = {
      ...inspected.manifest,
      entries,
      contentFingerprint: calculateContentFingerprint({
        payloadHashes: entries.filter((entry) => entry.mediaType === "application/json").map((entry) => entry.sha256),
        originalAssetHashes: inspected.manifest.assets.map((asset) => asset.contentHash)
      })
    };
    const archivePath = join(root, `contradictory-assets-${randomUUID()}.zip`);
    const output = createWriteStream(archivePath, { flags: "wx" });
    const archive = new ZipArchive({ zlib: { level: 9 } });
    const completed = once(output, "close");
    archive.pipe(output);
    for (const entry of entries) archive.append(entryBytes.get(entry.path)!, { name: entry.path });
    archive.append(Buffer.from(canonicalArchiveJson(manifest), "utf8"), { name: "manifest.json" });
    await archive.finalize();
    await completed;
    const staged = await stageArchiveUpload(createReadStream(archivePath), root, limits);
    await unlink(archivePath);
    return staged;
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

  async function previewRow(previewToken: string) {
    const tokenHash = createHash("sha256").update(previewToken, "utf8").digest("hex");
    return (await pool.query<{ staged_archive_path: string; status: string; result: Record<string, unknown> | null }>(
      "SELECT staged_archive_path,status,result FROM archive_previews WHERE token_hash=$1",
      [tokenHash]
    )).rows[0]!;
  }

  it("exports only the selected campaign and pinned world version as a deterministic manifest archive", async () => {
    const artifact = await exportCampaign(pool, campaignId, { assetStore: { root }, archiveRoot: root, limits });
    const repeated = await exportCampaign(pool, campaignId, { assetStore: { root }, archiveRoot: root, limits });
    expect(repeated.contentFingerprint).toBe(artifact.contentFingerprint);
    const stagedArtifact = await stageArchiveUpload(
      Readable.from(await readFile(artifact.absolutePath)),
      root,
      limits
    );
    const archive = await inspectArchive(stagedArtifact, limits, "campaign");
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

  it("serves campaign exports as no-store attachments and removes the response artifact", async () => {
    const app = await buildServer({ config: serverConfig(), pool });
    const before = await artifactNames();
    try {
      const response = await app.inject({ method: "GET", url: `/api/v1/campaigns/${campaignId}/export` });

      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toContain("application/zip");
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers["content-disposition"]).toBe('attachment; filename="infinite-quest-campaign.zip"');
      expect(response.headers["x-content-type-options"]).toBe("nosniff");
      await expect.poll(async () => artifactNames(), { interval: 10, timeout: 1_000 }).toEqual(before);
    } finally {
      await app.close();
    }
  });

  it("previews multipart Campaign Archives and commits the bound JSON request", async () => {
    const app = await buildServer({ config: serverConfig(), pool });
    const destination = await createCompatibleDestination("Route archive destination");
    const artifact = await exportCampaign(pool, campaignId, { assetStore: { root }, archiveRoot: root, limits });
    const upload = multipartBody([
      { name: "file", filename: "campaign.zip", value: await readFile(artifact.absolutePath) },
      { name: "destination", value: JSON.stringify({ kind: "existing_world_version", worldVersionId: destination.worldVersionId }) }
    ]);
    await unlink(artifact.absolutePath);
    try {
      const preview = await app.inject({
        method: "POST",
        url: "/api/v1/imports/campaign-archive/preview",
        headers: { "content-type": upload.contentType },
        payload: upload.payload
      });

      expect(preview.statusCode).toBe(200);
      const previewBody = preview.json();
      expect(previewBody).toMatchObject({ archiveType: "campaign", destination: { worldVersionId: destination.worldVersionId } });

      const commit = await app.inject({
        method: "POST",
        url: "/api/v1/imports/campaign-archive",
        headers: { "content-type": "application/json" },
        payload: { previewToken: previewBody.previewToken, destination: { kind: "existing_world_version", worldVersionId: destination.worldVersionId } }
      });
      expect([200, 201]).toContain(commit.statusCode);
      expect(commit.json()).toMatchObject({ worldVersionId: destination.worldVersionId });

      const multipartCommit = await app.inject({
        method: "POST",
        url: "/api/v1/imports/campaign-archive",
        headers: { "content-type": upload.contentType },
        payload: upload.payload
      });
      expect(multipartCommit.statusCode).toBe(400);
      expect(multipartCommit.json()).toMatchObject({ error: "archive-json-invalid" });
    } finally {
      await app.close();
    }
  });

  it("does not export a foreign-owner campaign", async () => {
    const foreignUserId = randomUUID();
    await pool.query("INSERT INTO users (id,display_name) VALUES ($1,'Foreign archive owner')", [foreignUserId]);
    const foreignWorld = await pool.query<{ id: string }>("INSERT INTO worlds (owner_user_id,title) VALUES ($1,'Foreign archive world') RETURNING id", [foreignUserId]);
    const foreignVersion = await pool.query<{ id: string }>("INSERT INTO world_versions (world_id,owner_user_id,version_number,content) VALUES ($1,$2,1,$3::jsonb) RETURNING id", [foreignWorld.rows[0]!.id, foreignUserId, JSON.stringify({ schemaVersion: 4, world: { title: "Foreign archive world" } })]);
    const foreignCampaign = await pool.query<{ id: string }>("INSERT INTO campaigns (owner_user_id,world_version_id,title) VALUES ($1,$2,'Foreign archive campaign') RETURNING id", [foreignUserId, foreignVersion.rows[0]!.id]);
    await pool.query("INSERT INTO campaign_state (campaign_id,owner_user_id) VALUES ($1,$2)", [foreignCampaign.rows[0]!.id, foreignUserId]);
    const app = await buildServer({ config: serverConfig(), pool });
    try {
      const response = await app.inject({ method: "GET", url: `/api/v1/campaigns/${foreignCampaign.rows[0]!.id}/export` });
      expect(response.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it("returns the typed safe archive error for malformed archive uploads", async () => {
    const app = await buildServer({ config: serverConfig(), pool });
    const upload = multipartBody([
      { name: "file", filename: "broken.zip", value: Buffer.from("not a zip archive", "utf8") },
      { name: "destination", value: JSON.stringify({ kind: "embedded" }) }
    ]);
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/imports/campaign-archive/preview",
        headers: { "content-type": upload.contentType },
        payload: upload.payload
      });
      const body = response.json();
      expect(response.statusCode).toBe(400);
      expect(body).toMatchObject({ error: "archive-format-unrecognized", details: {} });
      expect(JSON.stringify(body)).not.toContain(root);
      expect(JSON.stringify(body)).not.toContain("not a zip archive");
    } finally {
      await app.close();
    }
  });

  it("rejects an assets payload that contradicts manifest asset metadata", async () => {
    await expect(previewCampaignArchive(
      pool,
      runtimeConfig(),
      await stagedExportWithContradictoryAssetPayload(),
      "contradictory-assets.zip",
      { kind: "embedded" }
    )).rejects.toMatchObject({ code: "archive-asset-invalid", details: { payload: "assets" } });
  });

  it("keeps legacy JSON imports and manifest-less ZIP previews available", async () => {
    const app = await buildServer({ config: serverConfig(), pool });
    const legacyZipPath = join(root, `legacy-route-${randomUUID()}.zip`);
    const output = createWriteStream(legacyZipPath, { flags: "wx" });
    const archive = new ZipArchive({ zlib: { level: 9 } });
    const completed = once(output, "close");
    archive.pipe(output);
    archive.append(Buffer.from(JSON.stringify({ world: { title: "Manifest-less route archive" }, turns: [] }), "utf8"), { name: "campaign.json" });
    await archive.finalize();
    await completed;
    const upload = multipartBody([
      { name: "file", filename: "legacy-route.zip", value: await readFile(legacyZipPath) },
      { name: "destination", value: JSON.stringify({ kind: "embedded" }) }
    ]);
    await unlink(legacyZipPath);
    try {
      const legacyJson = await app.inject({
        method: "POST",
        url: "/api/v1/imports/legacy-story",
        headers: { "content-type": "application/json" },
        payload: { sourceName: `legacy-json-${randomUUID()}.story`, story: { world: { title: "Legacy JSON route" }, turns: [] } }
      });
      expect([200, 201]).toContain(legacyJson.statusCode);

      const legacyZip = await app.inject({
        method: "POST",
        url: "/api/v1/imports/campaign-archive/preview",
        headers: { "content-type": upload.contentType },
        payload: upload.payload
      });
      expect(legacyZip.statusCode).toBe(200);
      expect(legacyZip.json().warnings).toEqual(expect.arrayContaining([expect.stringMatching(/no archive manifest/i)]));
    } finally {
      await app.close();
    }
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
    const originalPath = resolve(root, source.rows[0]!.storage_path);
    const originalBytes = await readFile(originalPath);
    await unlink(originalPath);
    try {
      await expect(exportCampaign(pool, campaignId, { assetStore: { root }, archiveRoot: root, limits }))
        .rejects.toMatchObject({ code: "archive-asset-missing", assetIds: [requiredAssetId] });
    } finally {
      await writeFile(originalPath, originalBytes, { flag: "wx" });
    }
  });

  it("preview cleanup removes a successful new import upload after commit", async () => {
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
    const stagedPath = (await previewRow(preview.previewToken)).staged_archive_path;

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
    expect(imported).toMatchObject({
      duplicate: false,
      worldId: preview.destination.worldId,
      worldVersionId: preview.destination.worldVersionId,
      campaignId: expect.any(String)
    });
    expect(imported.campaignId).not.toBe(campaignId);
    expect(imported.worldVersionId).toBe(preview.destination.worldVersionId);
    const importedTurn = await pool.query<{ id: string; image_url: string }>(
      "SELECT id,image_url FROM turns WHERE campaign_id=$1 ORDER BY turn_number", [imported.campaignId]
    );
    expect(importedTurn.rows).toHaveLength(1);
    expect(importedTurn.rows[0]!.id).not.toBe(turnId);
    expect(imported.stats).toMatchObject({ turnCount: 1, memoryCount: 1 });
    await expect(stat(resolve(root, stagedPath))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(previewRow(preview.previewToken)).resolves.toMatchObject({ status: "consumed" });
  });

  it("migration history omits audit rows whose world versions are not portable", async () => {
    const destination = await createCompatibleDestination("Migration history destination");
    const before = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM world_versions WHERE world_id=$1",
      [destination.worldId]
    );
    const preview = await previewCampaignArchive(
      pool,
      runtimeConfig(),
      await stagedExport(),
      "migration-history.zip",
      { kind: "existing_world_version", worldVersionId: destination.worldVersionId }
    );

    expect(preview.warnings).toContain(
      "Migration history references source world versions not included in this Campaign Archive; those audit rows will not be recreated."
    );

    const imported = await importCampaignArchive(pool, runtimeConfig(), { root }, {
      previewToken: preview.previewToken,
      destination: { kind: "existing_world_version", worldVersionId: destination.worldVersionId }
    });
    const [after, importedCampaign, importedMigrations] = await Promise.all([
      pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM world_versions WHERE world_id=$1",
        [destination.worldId]
      ),
      pool.query<{ world_version_id: string }>(
        "SELECT world_version_id FROM campaigns WHERE id=$1",
        [imported.campaignId]
      ),
      pool.query<{ from_world_version_id: string; to_world_version_id: string }>(
        "SELECT from_world_version_id,to_world_version_id FROM campaign_world_migrations WHERE campaign_id=$1",
        [imported.campaignId]
      )
    ]);

    expect(after.rows[0]).toEqual(before.rows[0]);
    expect(imported.worldVersionId).toBe(destination.worldVersionId);
    expect(importedCampaign.rows).toEqual([{ world_version_id: destination.worldVersionId }]);
    expect(importedMigrations.rows).toEqual([]);
  });

  it("preview cleanup retries a superseded upload without deleting the replacement", async () => {
    const config = runtimeConfig();
    const firstStaged = await stagedExport();
    const firstPreview = await previewCampaignArchive(pool, config, firstStaged, "superseded-first.zip", { kind: "embedded" });
    const firstPath = (await previewRow(firstPreview.previewToken)).staged_archive_path;
    archiveCleanupTestState.failOncePaths.add(firstPath);
    const secondStaged = await stagedExport();
    const secondPreview = await previewCampaignArchive(pool, config, secondStaged, "superseded-second.zip", { kind: "embedded" });
    const secondRow = await previewRow(secondPreview.previewToken);

    expect((await stat(resolve(root, firstPath))).isFile()).toBe(true);
    await expect(previewRow(firstPreview.previewToken)).resolves.toMatchObject({
      staged_archive_path: firstPath,
      status: "superseded",
      result: { stagingCleanupPending: true }
    });
    await expect(cleanupExpiredArchivePreviews(pool, config, new Date())).resolves.toMatchObject({
      expiredCount: 0,
      cleanupFailureCount: 0
    });
    await expect(stat(resolve(root, firstPath))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(previewRow(firstPreview.previewToken)).resolves.toMatchObject({
      status: "superseded",
      result: { stagingCleanupPending: false }
    });
    expect((await stat(resolve(root, secondRow.staged_archive_path))).isFile()).toBe(true);
    expect(secondRow).toMatchObject({ staged_archive_path: secondStaged.relativePath, status: "previewed" });
  });

  it("commits a persisted staged archive from only the preview token and destination", async () => {
    const config = runtimeConfig();
    const destination = await createCompatibleDestination("Persisted staged destination");
    const preview = await (async () => {
      const staged = await stagedExport();
      return previewCampaignArchive(pool, config, staged, "persisted-staged.zip", {
        kind: "existing_world_version",
        worldVersionId: destination.worldVersionId
      });
    })();

    const imported = await importCampaignArchive(pool, config, { root }, {
      previewToken: preview.previewToken,
      destination: { kind: "existing_world_version", worldVersionId: destination.worldVersionId }
    });

    const inserted = await pool.query<{ campaign_id: string; world_id: string }>(
      `SELECT c.id AS campaign_id,w.id AS world_id
         FROM campaigns c
         JOIN world_versions wv ON wv.id=c.world_version_id
         JOIN worlds w ON w.id=wv.world_id
        WHERE c.id=$1 AND w.id=$2`,
      [imported.campaignId, imported.worldId]
    );
    expect(imported).toMatchObject({ duplicate: false, campaignId: expect.any(String), worldId: expect.any(String) });
    expect(inserted.rows).toEqual([{ campaign_id: imported.campaignId, world_id: imported.worldId }]);
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

  it("attaches an explicitly selected world version when only export-removed provider secrets differ", async () => {
    const destination = await createCompatibleDestination("Secret-compatible destination");
    await pool.query(
      "UPDATE world_versions SET content=jsonb_set(content,'{world,provider,apiKey}','\"destination-only-secret\"'::jsonb,true) WHERE id=$1",
      [destination.worldVersionId]
    );
    const preview = await previewCampaignArchive(pool, runtimeConfig(), await stagedExport(), "secret-compatible.zip", {
      kind: "existing_world_version", worldVersionId: destination.worldVersionId
    });
    const imported = await importCampaignArchive(pool, runtimeConfig(), { root }, {
      previewToken: preview.previewToken,
      destination: { kind: "existing_world_version", worldVersionId: destination.worldVersionId }
    });

    expect(preview.destination).toMatchObject({ operation: "attach_existing_world_version", worldVersionId: destination.worldVersionId });
    expect(imported).toMatchObject({ duplicate: false, worldId: destination.worldId, worldVersionId: destination.worldVersionId });
  });

  it("revalidates explicit attachment through export-compatible sanitization after a secret changes post-preview", async () => {
    const destination = await createCompatibleDestination("Post-preview secret destination");
    await pool.query("UPDATE world_versions SET content=content #- '{world,provider,apiKey}' WHERE id=$1", [destination.worldVersionId]);
    const preview = await previewCampaignArchive(pool, runtimeConfig(), await stagedExport(), "post-preview-secret.zip", {
      kind: "existing_world_version", worldVersionId: destination.worldVersionId
    });
    await pool.query(
      "UPDATE world_versions SET content=jsonb_set(content,'{world,provider,apiKey}','\"post-preview-secret\"'::jsonb,true) WHERE id=$1",
      [destination.worldVersionId]
    );

    await expect(importCampaignArchive(pool, runtimeConfig(), { root }, {
      previewToken: preview.previewToken,
      destination: { kind: "existing_world_version", worldVersionId: destination.worldVersionId }
    })).resolves.toMatchObject({ duplicate: false, worldId: destination.worldId, worldVersionId: destination.worldVersionId });
  });

  it("preview cleanup removes an idempotent duplicate import upload after commit", async () => {
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

    const duplicateStaged = await stagedExport();
    const duplicatePreview = await previewCampaignArchive(pool, runtimeConfig(), duplicateStaged, "exact-one-repeat.zip", {
      kind: "existing_world_version", worldVersionId: firstDestination.worldVersionId
    });
    archiveCleanupTestState.failOncePaths.add(duplicateStaged.relativePath);
    await expect(importCampaignArchive(pool, runtimeConfig(), { root }, {
      previewToken: duplicatePreview.previewToken,
      destination: { kind: "existing_world_version", worldVersionId: firstDestination.worldVersionId }
    })).resolves.toMatchObject({
      duplicate: true,
      importId: firstImport.importId,
      worldId: firstImport.worldId,
      worldVersionId: firstImport.worldVersionId,
      campaignId: firstImport.campaignId
    });
    expect((await stat(duplicateStaged.absolutePath)).isFile()).toBe(true);
    await expect(previewRow(duplicatePreview.previewToken)).resolves.toMatchObject({
      status: "consumed",
      result: { stagingCleanupPending: true }
    });
    await expect(cleanupExpiredArchivePreviews(pool, runtimeConfig(), new Date())).resolves.toMatchObject({
      expiredCount: 0,
      cleanupFailureCount: 0
    });
    await expect(stat(duplicateStaged.absolutePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(previewRow(duplicatePreview.previewToken)).resolves.toMatchObject({
      status: "consumed",
      result: { stagingCleanupPending: false }
    });
  });

  it("preview cleanup retries a consumed upload without rolling back the committed import", async () => {
    const config = runtimeConfig();
    const destination = await createCompatibleDestination("Consumed cleanup retry destination");
    const staged = await stagedExport();
    const preview = await previewCampaignArchive(pool, config, staged, "consumed-cleanup-retry.zip", {
      kind: "existing_world_version",
      worldVersionId: destination.worldVersionId
    });
    archiveCleanupTestState.failOncePaths.add(staged.relativePath);

    const imported = await importCampaignArchive(pool, config, { root }, {
      previewToken: preview.previewToken,
      destination: { kind: "existing_world_version", worldVersionId: destination.worldVersionId }
    });

    await expect(previewRow(preview.previewToken)).resolves.toMatchObject({
      status: "consumed",
      result: { stagingCleanupPending: true }
    });
    expect((await stat(staged.absolutePath)).isFile()).toBe(true);
    await expect(pool.query("SELECT id FROM campaigns WHERE id=$1", [imported.campaignId])).resolves.toMatchObject({
      rows: [{ id: imported.campaignId }]
    });

    await expect(cleanupExpiredArchivePreviews(pool, config, new Date())).resolves.toMatchObject({
      expiredCount: 0,
      cleanupFailureCount: 0
    });
    await expect(previewRow(preview.previewToken)).resolves.toMatchObject({
      status: "consumed",
      result: { stagingCleanupPending: false }
    });
    await expect(stat(staged.absolutePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preview cleanup retries expired staging after a transient deletion failure", async () => {
    const config = runtimeConfig();
    const staged = await stagedExport();
    const preview = await previewCampaignArchive(pool, config, staged, "cleanup-expired.zip", { kind: "embedded" });
    const stagedBytes = await readFile(staged.absolutePath);
    await pool.query("UPDATE archive_previews SET expires_at=now() - interval '1 second' WHERE token_hash=$1", [
      createHash("sha256").update(preview.previewToken, "utf8").digest("hex")
    ]);
    await unlink(staged.absolutePath);
    await mkdir(staged.absolutePath);

    await expect(cleanupExpiredArchivePreviews(pool, config, new Date())).resolves.toMatchObject({
      expiredCount: 1,
      cleanupFailureCount: 1
    });
    await expect(previewRow(preview.previewToken)).resolves.toMatchObject({
      status: "expired",
      result: { stagingCleanupPending: true }
    });
    await rmdir(staged.absolutePath);
    await writeFile(staged.absolutePath, stagedBytes, { flag: "wx" });

    await expect(cleanupExpiredArchivePreviews(pool, config, new Date())).resolves.toMatchObject({
      expiredCount: 0,
      cleanupFailureCount: 0
    });
    await expect(previewRow(preview.previewToken)).resolves.toMatchObject({
      status: "expired",
      result: { stagingCleanupPending: false }
    });
    await expect(stat(staged.absolutePath)).rejects.toMatchObject({ code: "ENOENT" });
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

  it("preview cleanup lets a failed commit supersede expiry after rollback", async () => {
    const config = runtimeConfig();
    const staged = await stagedExport();
    const destination = await createCompatibleDestination("Expired rollback destination");
    const preview = await previewCampaignArchive(pool, config, staged, "expired-rollback.zip", {
      kind: "existing_world_version",
      worldVersionId: destination.worldVersionId
    });
    const lockKey = Number.parseInt(randomUUID().slice(0, 7), 16);
    const triggerSuffix = randomUUID().replaceAll("-", "");
    const functionName = `campaign_archive_expired_failure_${triggerSuffix}`;
    const triggerName = `campaign_archive_expired_failure_trigger_${triggerSuffix}`;
    const blocker = await pool.connect();
    let blockerReleased = false;
    await blocker.query("SELECT pg_advisory_lock($1)", [lockKey]);
    await pool.query(`CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(${lockKey}); RAISE EXCEPTION 'forced expired archive failure'; END; $$`);
    await pool.query(`CREATE TRIGGER ${triggerName} BEFORE INSERT ON asset_references FOR EACH ROW EXECUTE FUNCTION ${functionName}()`);
    const importResultPromise = importCampaignArchive(pool, config, { root }, {
      previewToken: preview.previewToken,
      destination: { kind: "existing_world_version", worldVersionId: destination.worldVersionId }
    }).then(
      () => ({ error: null }),
      (error: unknown) => ({ error })
    );
    try {
      await expect.poll(async () => Number((await pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM pg_locks WHERE locktype='advisory' AND NOT granted"
      )).rows[0]!.count), { interval: 10, timeout: 2_000 }).toBeGreaterThan(0);
      const cleanupPromise = cleanupExpiredArchivePreviews(pool, config, new Date(Date.now() + 3_600_000));
      await expect.poll(async () => Number((await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM pg_stat_activity
          WHERE datname=current_database() AND state='active' AND wait_event_type='Lock'
            AND query ILIKE '%UPDATE archive_previews%'`
      )).rows[0]!.count), { interval: 10, timeout: 2_000 }).toBeGreaterThan(0);
      await blocker.query("SELECT pg_advisory_unlock($1)", [lockKey]);
      blocker.release();
      blockerReleased = true;
      const [importResult] = await Promise.all([importResultPromise, cleanupPromise]);
      expect(importResult.error).toMatchObject({ message: "forced expired archive failure" });
    } finally {
      if (!blockerReleased) {
        await blocker.query("SELECT pg_advisory_unlock($1)", [lockKey]).catch(() => undefined);
        blocker.release();
      }
      await pool.query(`DROP TRIGGER IF EXISTS ${triggerName} ON asset_references`);
      await pool.query(`DROP FUNCTION IF EXISTS ${functionName}()`);
    }
    await expect(previewRow(preview.previewToken)).resolves.toMatchObject({ status: "failed" });
    await expect(stat(staged.absolutePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preview cleanup marks failed commits failed and removes staging plus newly persisted archive originals", async () => {
    const staged = await stagedExport();
    const sourceAsset = await pool.query<{ storage_path: string }>("SELECT storage_path FROM assets WHERE id=$1", [requiredAssetId]);
    const originalPath = resolve(root, sourceAsset.rows[0]!.storage_path);
    await pool.query("DELETE FROM asset_references WHERE asset_id=$1", [requiredAssetId]);
    await pool.query("DELETE FROM assets WHERE id=$1", [requiredAssetId]);
    await unlink(originalPath);
    const destination = await createCompatibleDestination("Rollback destination");
    const before = await pool.query<{ assets: string; worlds: string; campaigns: string; imports: string }>(
      `SELECT (SELECT count(*)::text FROM assets) AS assets,
              (SELECT count(*)::text FROM worlds) AS worlds,
              (SELECT count(*)::text FROM campaigns) AS campaigns,
              (SELECT count(*)::text FROM imports) AS imports`
    );
    const triggerSuffix = randomUUID().replaceAll("-", "");
    const functionName = `campaign_archive_force_failure_${triggerSuffix}`;
    const triggerName = `campaign_archive_force_failure_trigger_${triggerSuffix}`;
    await pool.query(`CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced archive binding failure'; END; $$`);
    await pool.query(`CREATE TRIGGER ${triggerName} BEFORE INSERT ON asset_references FOR EACH ROW EXECUTE FUNCTION ${functionName}()`);
    let failedPreviewToken = "";
    try {
      const preview = await previewCampaignArchive(pool, runtimeConfig(), staged, "rollback.zip", {
        kind: "existing_world_version", worldVersionId: destination.worldVersionId
      });
      failedPreviewToken = preview.previewToken;
      archiveCleanupTestState.failOncePaths.add(staged.relativePath);
      await expect(importCampaignArchive(pool, runtimeConfig(), { root }, {
        previewToken: preview.previewToken,
        destination: { kind: "existing_world_version", worldVersionId: destination.worldVersionId }
      })).rejects.toThrow("forced archive binding failure");
    } finally {
      await pool.query(`DROP TRIGGER IF EXISTS ${triggerName} ON asset_references`);
      await pool.query(`DROP FUNCTION IF EXISTS ${functionName}()`);
    }
    const after = await pool.query<{ assets: string; worlds: string; campaigns: string; imports: string }>(
      `SELECT (SELECT count(*)::text FROM assets) AS assets,
              (SELECT count(*)::text FROM worlds) AS worlds,
              (SELECT count(*)::text FROM campaigns) AS campaigns,
              (SELECT count(*)::text FROM imports) AS imports`
    );
    expect(after.rows[0]).toEqual(before.rows[0]);
    await expect(stat(originalPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await stat(staged.absolutePath)).isFile()).toBe(true);
    await expect(previewRow(failedPreviewToken)).resolves.toMatchObject({
      status: "failed",
      result: { stagingCleanupPending: true }
    });
    await expect(cleanupExpiredArchivePreviews(pool, runtimeConfig(), new Date())).resolves.toMatchObject({
      expiredCount: 0,
      cleanupFailureCount: 0
    });
    await expect(stat(staged.absolutePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(previewRow(failedPreviewToken)).resolves.toMatchObject({
      status: "failed",
      result: { stagingCleanupPending: false }
    });
  });
});
