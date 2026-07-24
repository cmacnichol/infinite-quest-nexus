import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, extname, resolve, sep } from "node:path";
import sharp from "sharp";
import type { DatabaseClient, DatabasePool } from "../../../packages/database/src/pool.js";
import type { AssetListQuery, AssetMetadataUpdate } from "../../../packages/contracts/src/assets.js";
import { sha256, stableStringify } from "../../../packages/domain/src/text.js";

const ALLOWED_IMAGE_TYPES = new Map([
  ["image/png", ".png"],
  ["image/jpeg", ".jpg"],
  ["image/webp", ".webp"],
  ["image/gif", ".gif"]
]);
const MAX_IMPORTED_IMAGE_BYTES = 25 * 1024 * 1024;

function matchesImageSignature(bytes: Buffer, mimeType: string): boolean {
  if (mimeType === "image/png") return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (mimeType === "image/jpeg") return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mimeType === "image/webp") return bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP";
  if (mimeType === "image/gif") return bytes.length >= 6 && ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"));
  return false;
}

export type FilesystemAssetStore = {
  root: string;
};

export type StoredAsset = {
  id: string;
  publicUrl: string;
  contentHash: string;
};

export type AssetLibraryItem = {
  id: string;
  url: string;
  thumbnailUrl: string;
  mimeType: string;
  byteLength: number;
  width: number | null;
  height: number | null;
  createdAt: string;
  campaignId: string | null;
  turnId: string | null;
  title: string;
  caption: string;
  alt: string;
  tags: string[];
  origin: "generated" | "imported" | "uploaded";
  reuseScope: "private" | "campaign" | "world" | "owner_library" | "shared";
  automaticReuseEnabled: boolean;
  reviewStatus: "unreviewed" | "eligible" | "restricted" | "blocked";
  contentCategories: string[];
  favorite: boolean;
  archived: boolean;
  metadataRevision: number;
  provider: string | null;
  model: string | null;
  worldId: string | null;
  worldVersionId: string | null;
  usageCount: number;
};

export type AssetLibraryResult = {
  assets: AssetLibraryItem[];
  nextCursor: string | null;
  total: number;
  facets: {
    origin: Record<string, number>;
    reviewStatus: Record<string, number>;
    reuseScope: Record<string, number>;
    tags: Record<string, number>;
  };
};

type GenerationContext = {
  imageJobId: string;
  targetType: "turn_illustration" | "world_cover" | "streaming_illustration";
  variantIndex: number;
  prompt: string;
  providerProfileId: string;
  providerType: string;
  model: string;
  generationParameters: Record<string, unknown>;
};

type VerifiedImage = {
  width: number;
  height: number;
  format: string;
  pages: number;
  orientation: number | null;
  thumbnail: { bytes: Buffer; width: number; height: number; contentHash: string } | null;
};

async function verifyImage(bytes: Buffer): Promise<VerifiedImage> {
  const metadata = await sharp(bytes, { animated: true }).metadata();
  if (!metadata.width || !metadata.height || !metadata.format) throw new Error("Stored image dimensions could not be decoded.");
  const rotated = [5, 6, 7, 8].includes(metadata.orientation || 0);
  const width = rotated ? metadata.height : metadata.width;
  const height = rotated ? metadata.width : metadata.height;
  const thumbnailBytes = await sharp(bytes, { animated: false })
    .rotate()
    .resize({ width: 480, height: 480, fit: "inside", withoutEnlargement: true })
    .webp({ quality: 78 })
    .toBuffer();
  const thumbnailMetadata = await sharp(thumbnailBytes).metadata();
  return {
    width,
    height,
    format: metadata.format,
    pages: metadata.pages || 1,
    orientation: metadata.orientation || null,
    thumbnail: thumbnailMetadata.width && thumbnailMetadata.height
      ? { bytes: thumbnailBytes, width: thumbnailMetadata.width, height: thumbnailMetadata.height, contentHash: sha256(thumbnailBytes.toString("base64")) }
      : null
  };
}

export async function runAssetMetadataBackfill(
  pool: DatabasePool,
  store: FilesystemAssetStore,
  limit = 10
): Promise<boolean> {
  const pending = await pool.query<{
    id: string;
    owner_user_id: string;
    storage_driver: string;
    storage_path: string;
  }>(
    `SELECT id, owner_user_id, storage_driver, storage_path
       FROM assets
      WHERE (pixel_width IS NULL OR pixel_height IS NULL)
        AND NOT (technical_metadata ? 'backfillError')
      ORDER BY created_at ASC, id ASC LIMIT $1`,
    [Math.max(1, Math.min(50, limit))]
  );
  for (const asset of pending.rows) {
    try {
      if (asset.storage_driver !== "filesystem") throw new Error(`Unsupported storage driver '${asset.storage_driver}'.`);
      const absolutePath = resolve(store.root, asset.storage_path);
      const rootPrefix = `${resolve(store.root)}${sep}`;
      if (!absolutePath.startsWith(rootPrefix)) throw new Error("Stored asset path is outside the configured root.");
      const bytes = await readFile(absolutePath);
      const verified = await verifyImage(bytes);
      await withAssetBackfillTransaction(pool, async (client) => {
        await client.query(
          `UPDATE assets SET pixel_width = $3, pixel_height = $4,
             technical_metadata = technical_metadata || $5::jsonb
           WHERE id = $1 AND owner_user_id = $2`,
          [asset.id, asset.owner_user_id, verified.width, verified.height,
            JSON.stringify({ format: verified.format, pages: verified.pages, orientation: verified.orientation, backfilledAt: new Date().toISOString() })]
        );
        if (verified.thumbnail) {
          const path = await writeContentAddressed(store, verified.thumbnail.contentHash, ".webp", verified.thumbnail.bytes);
          await client.query(
            `INSERT INTO asset_derivatives (
               owner_user_id, source_asset_id, derivative_kind, transform_version, pixel_width, pixel_height,
               storage_driver, storage_path, mime_type, byte_length, content_hash
             ) VALUES ($1,$2,'thumbnail',1,$3,$4,'filesystem',$5,'image/webp',$6,$7)
             ON CONFLICT (owner_user_id, source_asset_id, derivative_kind, transform_version, pixel_width, pixel_height)
             DO NOTHING`,
            [asset.owner_user_id, asset.id, verified.thumbnail.width, verified.thumbnail.height,
              path, verified.thumbnail.bytes.length, verified.thumbnail.contentHash]
          );
        }
      });
    } catch (error) {
      await pool.query(
        `UPDATE assets SET technical_metadata = technical_metadata || jsonb_build_object('backfillError', $3::text)
          WHERE id = $1 AND owner_user_id = $2`,
        [asset.id, asset.owner_user_id, (error instanceof Error ? error.message : String(error)).slice(0, 500)]
      );
    }
  }
  return pending.rows.length > 0;
}

async function withAssetBackfillTransaction<T>(pool: DatabasePool, work: (client: DatabaseClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const value = await work(client);
    await client.query("COMMIT");
    return value;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function parseDataImage(value: string): { mimeType: string; bytes: Buffer; extension: string } | null {
  const match = /^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\r\n]+)$/i.exec(value.trim());
  if (!match?.[1] || !match[2]) return null;
  const mimeType = match[1].toLowerCase();
  const extension = ALLOWED_IMAGE_TYPES.get(mimeType);
  if (!extension) throw new Error(`Imported image type '${mimeType}' is not supported.`);
  const bytes = Buffer.from(match[2].replace(/\s+/g, ""), "base64");
  if (!bytes.length) throw new Error("Imported image data was empty.");
  if (bytes.length > MAX_IMPORTED_IMAGE_BYTES) throw new Error("Imported image exceeded the 25 MB per-image limit.");
  return { mimeType, bytes, extension };
}

async function writeContentAddressed(store: FilesystemAssetStore, contentHash: string, extension: string, bytes: Buffer): Promise<string> {
  const relativePath = `${contentHash.slice(0, 2)}/${contentHash}${extension}`;
  const finalPath = resolve(store.root, relativePath);
  const rootPrefix = `${resolve(store.root)}${sep}`;
  if (!finalPath.startsWith(rootPrefix)) throw new Error("Refusing to write an asset outside the configured storage root.");
  await mkdir(dirname(finalPath), { recursive: true });
  const temporaryPath = `${finalPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporaryPath, bytes, { flag: "wx", mode: 0o640 });
  try {
    await rename(temporaryPath, finalPath);
  } catch (error) {
    const existing = await readFile(finalPath).catch(() => null);
    if (!existing || !existing.equals(bytes)) throw error;
  }
  return relativePath.replaceAll("\\", "/");
}

export function safeExternalImageUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  try {
    const url = new URL(trimmed);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : "";
  } catch {
    return "";
  }
}

export async function importTurnImage(
  client: DatabaseClient,
  store: FilesystemAssetStore,
  ownerUserId: string,
  campaignId: string | null,
  turnId: string | null,
  imageUrl: string
): Promise<StoredAsset | null> {
  const parsed = parseDataImage(imageUrl);
  if (!parsed) return null;
  return persistTurnImage(client, store, ownerUserId, campaignId, turnId, parsed.bytes, parsed.mimeType);
}

export async function persistTurnImage(
  client: DatabaseClient,
  store: FilesystemAssetStore,
  ownerUserId: string,
  campaignId: string | null,
  turnId: string | null,
  bytes: Buffer,
  mimeType: string,
  options?: { generationContext?: GenerationContext; attachReference?: boolean }
): Promise<StoredAsset> {
  return persistImage(client, store, ownerUserId, bytes, mimeType, { campaignId, turnId }, options);
}

export async function persistWorldCover(
  client: DatabaseClient,
  store: FilesystemAssetStore,
  ownerUserId: string,
  bytes: Buffer,
  mimeType: string,
  options?: { generationContext?: GenerationContext }
): Promise<StoredAsset> {
  return persistImage(client, store, ownerUserId, bytes, mimeType, undefined, options);
}

async function persistImage(
  client: DatabaseClient,
  store: FilesystemAssetStore,
  ownerUserId: string,
  bytes: Buffer,
  mimeType: string,
  provenance?: { campaignId: string | null; turnId: string | null },
  options?: { generationContext?: GenerationContext; attachReference?: boolean }
): Promise<StoredAsset> {
  const extension = ALLOWED_IMAGE_TYPES.get(mimeType);
  if (!extension) throw new Error(`Generated image type '${mimeType}' is not supported.`);
  if (!bytes.length) throw new Error("Generated image data was empty.");
  if (bytes.length > MAX_IMPORTED_IMAGE_BYTES) throw new Error("Generated image exceeded the 25 MB per-image limit.");
  if (!matchesImageSignature(bytes, mimeType)) throw new Error(`Image bytes did not match declared type '${mimeType}'.`);
  const verified = await verifyImage(bytes);
  const contentHash = sha256(bytes.toString("base64"));
  const storagePath = await writeContentAddressed(store, contentHash, extension, bytes);
  const assetResult = await client.query<{ id: string }>(
    `INSERT INTO assets (
       owner_user_id, campaign_id, turn_id, content_hash, storage_driver, storage_path, mime_type, byte_length,
       pixel_width, pixel_height, technical_metadata
     ) VALUES ($1,$2,$3,$4,'filesystem',$5,$6,$7,$8,$9,$10)
     ON CONFLICT (owner_user_id, content_hash)
     DO UPDATE SET pixel_width = COALESCE(assets.pixel_width, EXCLUDED.pixel_width),
                   pixel_height = COALESCE(assets.pixel_height, EXCLUDED.pixel_height),
                   technical_metadata = CASE WHEN assets.technical_metadata = '{}'::jsonb THEN EXCLUDED.technical_metadata ELSE assets.technical_metadata END
     RETURNING id`,
    [ownerUserId, provenance?.campaignId ?? null, provenance?.turnId ?? null, contentHash, storagePath, mimeType, bytes.length,
      verified.width, verified.height, JSON.stringify({ format: verified.format, pages: verified.pages, orientation: verified.orientation })]
  );
  const assetId = assetResult.rows[0]?.id;
  if (!assetId) throw new Error("Could not persist imported image metadata.");
  if (verified.thumbnail) {
    const thumbnailPath = await writeContentAddressed(store, verified.thumbnail.contentHash, ".webp", verified.thumbnail.bytes);
    await client.query(
      `INSERT INTO asset_derivatives (
         owner_user_id, source_asset_id, derivative_kind, transform_version, pixel_width, pixel_height,
         storage_driver, storage_path, mime_type, byte_length, content_hash
       ) VALUES ($1,$2,'thumbnail',1,$3,$4,'filesystem',$5,'image/webp',$6,$7)
       ON CONFLICT (owner_user_id, source_asset_id, derivative_kind, transform_version, pixel_width, pixel_height)
       DO UPDATE SET storage_path = EXCLUDED.storage_path, byte_length = EXCLUDED.byte_length, content_hash = EXCLUDED.content_hash`,
      [ownerUserId, assetId, verified.thumbnail.width, verified.thumbnail.height, thumbnailPath,
        verified.thumbnail.bytes.length, verified.thumbnail.contentHash]
    );
  }
  if (provenance && options?.attachReference !== false) {
    await client.query(
      `INSERT INTO asset_references (owner_user_id, asset_id, campaign_id, turn_id, asset_role)
       VALUES ($1,$2,$3,$4,'turn_illustration') ON CONFLICT DO NOTHING`,
      [ownerUserId, assetId, provenance.campaignId, provenance.turnId]
    );
  }
  if (options?.generationContext) {
    const context = options.generationContext;
    await client.query(
      `INSERT INTO asset_generation_contexts (
         owner_user_id, asset_id, created_by_user_id, image_job_id, world_id, world_version_id, campaign_id, turn_id,
         target_type, variant_index, fiction_prompt, provider_profile_id, provider_type, model, generation_parameters
       )
       SELECT $1,$2,$1,$3,
              CASE WHEN $4 = 'world_cover' THEN jobs.world_id ELSE world_versions.world_id END,
              campaigns.world_version_id, jobs.campaign_id, jobs.turn_id,
              $4,$5,$6,$7,$8,$9,$10
         FROM image_jobs jobs
         LEFT JOIN campaigns ON campaigns.id = jobs.campaign_id AND campaigns.owner_user_id = jobs.owner_user_id
         LEFT JOIN world_versions ON world_versions.id = campaigns.world_version_id
          AND world_versions.owner_user_id = jobs.owner_user_id
        WHERE jobs.id = $3 AND jobs.owner_user_id = $1
       ON CONFLICT (image_job_id, variant_index) WHERE image_job_id IS NOT NULL
       DO UPDATE SET asset_id = EXCLUDED.asset_id`,
      [ownerUserId, assetId, context.imageJobId, context.targetType, context.variantIndex, context.prompt,
        context.providerProfileId, context.providerType, context.model, JSON.stringify(context.generationParameters)]
    );
    await client.query(
      `UPDATE asset_library_entries
          SET origin = 'generated', reuse_scope = $3,
              automatic_reuse_enabled = true, review_status = 'eligible', updated_at = now()
        WHERE asset_id = $1 AND owner_user_id = $2`,
      [assetId, ownerUserId, context.targetType === "world_cover" ? "world" : "campaign"]
    );
  }
  return { id: assetId, publicUrl: `/api/v1/assets/${assetId}`, contentHash };
}

export async function readAsset(pool: DatabasePool, store: FilesystemAssetStore, ownerUserId: string, assetId: string) {
  const result = await pool.query<{ storage_driver: string; storage_path: string; mime_type: string; content_hash: string }>(
    `SELECT storage_driver, storage_path, mime_type, content_hash
       FROM assets WHERE id = $1 AND owner_user_id = $2`,
    [assetId, ownerUserId]
  );
  const asset = result.rows[0];
  if (!asset) throw Object.assign(new Error("Asset not found."), { statusCode: 404 });
  if (asset.storage_driver !== "filesystem") throw new Error(`Unsupported asset storage driver '${asset.storage_driver}'.`);
  const absolutePath = resolve(store.root, asset.storage_path);
  const rootPrefix = `${resolve(store.root)}${sep}`;
  if (!absolutePath.startsWith(rootPrefix) || !ALLOWED_IMAGE_TYPES.has(asset.mime_type) || !extname(absolutePath)) {
    throw new Error("Stored asset metadata failed validation.");
  }
  return { bytes: await readFile(absolutePath), mimeType: asset.mime_type, contentHash: asset.content_hash };
}

export async function readAssetDerivative(
  pool: DatabasePool,
  store: FilesystemAssetStore,
  ownerUserId: string,
  assetId: string,
  derivativeKind: "thumbnail"
) {
  const result = await pool.query<{ storage_driver: string; storage_path: string; mime_type: string; content_hash: string }>(
    `SELECT storage_driver, storage_path, mime_type, content_hash
       FROM asset_derivatives
      WHERE source_asset_id = $1 AND owner_user_id = $2 AND derivative_kind = $3
      ORDER BY pixel_width DESC LIMIT 1`,
    [assetId, ownerUserId, derivativeKind]
  );
  const derivative = result.rows[0];
  if (!derivative) return readAsset(pool, store, ownerUserId, assetId);
  if (derivative.storage_driver !== "filesystem") throw new Error(`Unsupported asset storage driver '${derivative.storage_driver}'.`);
  const absolutePath = resolve(store.root, derivative.storage_path);
  const rootPrefix = `${resolve(store.root)}${sep}`;
  if (!absolutePath.startsWith(rootPrefix) || !ALLOWED_IMAGE_TYPES.has(derivative.mime_type)) {
    throw new Error("Stored derivative metadata failed validation.");
  }
  return { bytes: await readFile(absolutePath), mimeType: derivative.mime_type, contentHash: derivative.content_hash };
}

type AssetQueryRow = {
  id: string;
  mime_type: string;
  byte_length: string;
  pixel_width: number | null;
  pixel_height: number | null;
  created_at: Date;
  campaign_id: string | null;
  turn_id: string | null;
  title: string;
  caption: string;
  tags: string[];
  origin: AssetLibraryItem["origin"];
  reuse_scope: AssetLibraryItem["reuseScope"];
  automatic_reuse_enabled: boolean;
  review_status: AssetLibraryItem["reviewStatus"];
  content_categories: string[];
  favorite: boolean;
  archived_at: Date | null;
  metadata_revision: number;
  provider_type: string | null;
  model: string | null;
  world_id: string | null;
  world_version_id: string | null;
  usage_count: number;
  sort_title: string;
};

type AssetCursor = {
  fingerprint: string;
  id: string;
  createdAt: string;
  title: string;
  usageCount: number;
};

function assetQueryFingerprint(query: AssetListQuery): string {
  return sha256(stableStringify({ ...query, cursor: undefined }));
}

function decodeCursor(value: string, fingerprint: string): AssetCursor {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<AssetCursor>;
    if (parsed.fingerprint !== fingerprint || typeof parsed.id !== "string" || typeof parsed.createdAt !== "string"
        || typeof parsed.title !== "string" || typeof parsed.usageCount !== "number") throw new Error("invalid cursor");
    return parsed as AssetCursor;
  } catch {
    throw Object.assign(new Error("Asset cursor is invalid or belongs to a different filter."), { statusCode: 400 });
  }
}

function encodeCursor(row: AssetQueryRow, fingerprint: string): string {
  return Buffer.from(JSON.stringify({
    fingerprint,
    id: row.id,
    createdAt: row.created_at.toISOString(),
    title: row.sort_title,
    usageCount: row.usage_count
  } satisfies AssetCursor)).toString("base64url");
}

function mapAssetRow(row: AssetQueryRow): AssetLibraryItem {
  const title = row.title.trim();
  const caption = row.caption.trim();
  return {
    id: row.id,
    url: `/api/v1/assets/${row.id}`,
    thumbnailUrl: `/api/v1/assets/${row.id}/thumbnail`,
    mimeType: row.mime_type,
    byteLength: Number(row.byte_length),
    width: row.pixel_width,
    height: row.pixel_height,
    createdAt: row.created_at.toISOString(),
    campaignId: row.campaign_id,
    turnId: row.turn_id,
    title,
    caption,
    alt: caption || title || "Retained story illustration",
    tags: row.tags || [],
    origin: row.origin,
    reuseScope: row.reuse_scope,
    automaticReuseEnabled: row.automatic_reuse_enabled,
    reviewStatus: row.review_status,
    contentCategories: row.content_categories || [],
    favorite: row.favorite,
    archived: Boolean(row.archived_at),
    metadataRevision: row.metadata_revision,
    provider: row.provider_type,
    model: row.model,
    worldId: row.world_id,
    worldVersionId: row.world_version_id,
    usageCount: Number(row.usage_count)
  };
}

function facetRecord(rows: Array<{ value: string; count: number }>): Record<string, number> {
  return Object.fromEntries(rows.map((row) => [row.value, Number(row.count)]));
}

export async function queryAssets(pool: DatabasePool, ownerUserId: string, query: AssetListQuery): Promise<AssetLibraryResult> {
  const params: unknown[] = [ownerUserId];
  const add = (value: unknown) => { params.push(value); return `$${params.length}`; };
  const where: string[] = ["a.owner_user_id = $1"];
  if (query.q) {
    const value = add(query.q);
    where.push(`to_tsvector('simple', concat_ws(' ', le.title, le.caption, le.notes, array_to_string(le.tags, ' '), COALESCE(context.fiction_prompt, '')))
      @@ websearch_to_tsquery('simple', ${value})`);
  }
  if (query.creator === "me") where.push("le.created_by_user_id = $1");
  if (query.scope === "campaign" && query.campaignId) {
    const value = add(query.campaignId);
    where.push(`EXISTS (SELECT 1 FROM asset_references ar WHERE ar.asset_id = a.id AND ar.owner_user_id = $1 AND ar.campaign_id = ${value})`);
  } else if (query.scope === "world" && query.worldId) {
    const value = add(query.worldId);
    where.push(`EXISTS (SELECT 1 FROM asset_generation_contexts agc WHERE agc.asset_id = a.id AND agc.owner_user_id = $1 AND agc.world_id = ${value})`);
  } else if (query.scope === "owner_library") where.push("le.reuse_scope = 'owner_library'");
  else if (query.scope === "shared") where.push("false /* shared-library grants are not implemented */");
  if (query.campaignId && query.scope !== "campaign") {
    const value = add(query.campaignId);
    where.push(`EXISTS (SELECT 1 FROM asset_generation_contexts agc WHERE agc.asset_id = a.id AND agc.owner_user_id = $1 AND agc.campaign_id = ${value})`);
  }
  if (query.worldId && query.scope !== "world") {
    const value = add(query.worldId);
    where.push(`EXISTS (SELECT 1 FROM asset_generation_contexts agc WHERE agc.asset_id = a.id AND agc.owner_user_id = $1 AND agc.world_id = ${value})`);
  }
  if (query.worldVersionId) {
    const value = add(query.worldVersionId);
    where.push(`EXISTS (SELECT 1 FROM asset_generation_contexts agc WHERE agc.asset_id = a.id AND agc.owner_user_id = $1 AND agc.world_version_id = ${value})`);
  }
  if (query.origin.length) where.push(`le.origin = ANY(${add(query.origin)}::text[])`);
  if (query.tags.length) where.push(query.allTags ? `le.tags @> ${add(query.tags)}::text[]` : `le.tags && ${add(query.tags)}::text[]`);
  if (query.entityIds.length) where.push(`COALESCE(context.entities, '[]'::jsonb) ?| ${add(query.entityIds)}::text[]`);
  if (query.locationIds.length) where.push(`COALESCE(context.locations, '[]'::jsonb) ?| ${add(query.locationIds)}::text[]`);
  if (query.provider.length) where.push(`context.provider_type = ANY(${add(query.provider)}::text[])`);
  if (query.model.length) where.push(`context.model = ANY(${add(query.model)}::text[])`);
  if (query.reviewStatus.length) where.push(`le.review_status = ANY(${add(query.reviewStatus)}::text[])`);
  if (query.reuseScope.length) where.push(`le.reuse_scope = ANY(${add(query.reuseScope)}::text[])`);
  if (query.eligible !== undefined) where.push(`le.automatic_reuse_enabled = ${add(query.eligible)}`);
  if (query.favorite !== undefined) where.push(`le.favorite = ${add(query.favorite)}`);
  where.push(query.archived ? "le.archived_at IS NOT NULL" : "le.archived_at IS NULL");
  if (query.mimeType.length) where.push(`a.mime_type = ANY(${add(query.mimeType)}::text[])`);
  if (query.aspect.length) {
    const value = add(query.aspect);
    where.push(`CASE
      WHEN a.pixel_width IS NULL OR a.pixel_height IS NULL THEN 'unknown'
      WHEN abs(a.pixel_width::numeric / a.pixel_height - 1) <= 0.08 THEN 'square'
      WHEN a.pixel_width > a.pixel_height THEN 'landscape'
      ELSE 'portrait' END = ANY(${value}::text[])`);
  }
  if (query.createdFrom) where.push(`a.created_at >= ${add(query.createdFrom)}::timestamptz`);
  if (query.createdTo) where.push(`a.created_at <= ${add(query.createdTo)}::timestamptz`);

  const base = `WITH library AS (
    SELECT a.id, a.mime_type, a.byte_length::text, a.pixel_width, a.pixel_height, a.created_at, a.campaign_id, a.turn_id,
           le.title, le.caption, le.tags, le.origin, le.reuse_scope, le.automatic_reuse_enabled, le.review_status,
           le.content_categories, le.favorite, le.archived_at, le.metadata_revision,
           context.provider_type, context.model, context.world_id, context.world_version_id,
           COALESCE(usage.usage_count, 0)::int AS usage_count,
           lower(COALESCE(NULLIF(le.title, ''), a.id::text)) AS sort_title
      FROM assets a
      JOIN asset_library_entries le ON le.asset_id = a.id AND le.owner_user_id = a.owner_user_id
      LEFT JOIN LATERAL (
        SELECT agc.provider_type, agc.model, agc.world_id, agc.world_version_id, agc.fiction_prompt, agc.entities, agc.locations
          FROM asset_generation_contexts agc
         WHERE agc.asset_id = a.id AND agc.owner_user_id = a.owner_user_id
         ORDER BY agc.created_at DESC, agc.id DESC LIMIT 1
      ) context ON true
      LEFT JOIN LATERAL (
        SELECT count(*)::int AS usage_count FROM asset_references ar
         WHERE ar.asset_id = a.id AND ar.owner_user_id = a.owner_user_id
      ) usage ON true
     WHERE ${where.join(" AND ")}
  )`;
  const fingerprint = assetQueryFingerprint(query);
  const cursor = query.cursor ? decodeCursor(query.cursor, fingerprint) : null;
  let cursorWhere = "";
  let orderBy = "created_at DESC, id DESC";
  if (query.sort === "oldest") orderBy = "created_at ASC, id ASC";
  if (query.sort === "title") orderBy = "sort_title ASC, id ASC";
  if (query.sort === "most_used") orderBy = "usage_count DESC, id DESC";
  if (cursor) {
    if (query.sort === "newest") cursorWhere = `WHERE (created_at, id) < (${add(cursor.createdAt)}::timestamptz, ${add(cursor.id)}::uuid)`;
    if (query.sort === "oldest") cursorWhere = `WHERE (created_at, id) > (${add(cursor.createdAt)}::timestamptz, ${add(cursor.id)}::uuid)`;
    if (query.sort === "title") cursorWhere = `WHERE (sort_title, id) > (${add(cursor.title)}, ${add(cursor.id)}::uuid)`;
    if (query.sort === "most_used") cursorWhere = `WHERE (usage_count, id) < (${add(cursor.usageCount)}::int, ${add(cursor.id)}::uuid)`;
  }
  const limitValue = add(query.limit + 1);
  const pageResult = await pool.query<AssetQueryRow>(`${base}
    SELECT * FROM library ${cursorWhere} ORDER BY ${orderBy} LIMIT ${limitValue}`, params);
  const hasMore = pageResult.rows.length > query.limit;
  const rows = pageResult.rows.slice(0, query.limit);

  const summaryParams = params.slice(0, params.length - (cursor ? 3 : 1));
  const summary = await pool.query<{
    total: number;
    origin: Array<{ value: string; count: number }>;
    review_status: Array<{ value: string; count: number }>;
    reuse_scope: Array<{ value: string; count: number }>;
    tags: Array<{ value: string; count: number }>;
  }>(`${base}
    SELECT count(*)::int AS total,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('value', origin, 'count', count)) FROM (SELECT origin, count(*)::int AS count FROM library GROUP BY origin ORDER BY origin) x), '[]') AS origin,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('value', review_status, 'count', count)) FROM (SELECT review_status, count(*)::int AS count FROM library GROUP BY review_status ORDER BY review_status) x), '[]') AS review_status,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('value', reuse_scope, 'count', count)) FROM (SELECT reuse_scope, count(*)::int AS count FROM library GROUP BY reuse_scope ORDER BY reuse_scope) x), '[]') AS reuse_scope,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('value', tag, 'count', count)) FROM (SELECT tag, count(*)::int AS count FROM library, unnest(tags) tag GROUP BY tag ORDER BY count DESC, tag LIMIT 100) x), '[]') AS tags
    FROM library`, summaryParams);
  const counts = summary.rows[0] || { total: 0, origin: [], review_status: [], reuse_scope: [], tags: [] };
  return {
    assets: rows.map(mapAssetRow),
    nextCursor: hasMore && rows.length ? encodeCursor(rows[rows.length - 1]!, fingerprint) : null,
    total: Number(counts.total),
    facets: {
      origin: facetRecord(counts.origin),
      reviewStatus: facetRecord(counts.review_status),
      reuseScope: facetRecord(counts.reuse_scope),
      tags: facetRecord(counts.tags)
    }
  };
}

export async function listAssets(pool: DatabasePool, ownerUserId: string, limit = 100): Promise<AssetLibraryItem[]> {
  const query = {
    q: "", scope: "all", origin: [], tags: [], allTags: false, entityIds: [], locationIds: [], provider: [], model: [],
    reviewStatus: [], reuseScope: [], archived: false, mimeType: [], aspect: [], sort: "newest", limit: Math.max(1, Math.min(100, limit))
  } as AssetListQuery;
  return (await queryAssets(pool, ownerUserId, query)).assets;
}

export async function updateAssetMetadata(
  pool: DatabasePool,
  ownerUserId: string,
  assetId: string,
  update: AssetMetadataUpdate
): Promise<{ assetId: string; metadataRevision: number }> {
  if (update.reuseScope === "shared") {
    throw Object.assign(new Error("Shared-library publication is unavailable until authentication and grants are implemented."), { statusCode: 409 });
  }
  const result = await pool.query<{ metadata_revision: number }>(
    `UPDATE asset_library_entries SET
       title = COALESCE($4, title), caption = COALESCE($5, caption), notes = COALESCE($6, notes),
       tags = COALESCE($7, tags), reuse_scope = COALESCE($8, reuse_scope),
       automatic_reuse_enabled = COALESCE($9, automatic_reuse_enabled), review_status = COALESCE($10, review_status),
       content_categories = COALESCE($11, content_categories), favorite = COALESCE($12, favorite),
       archived_at = CASE WHEN $13::boolean IS NULL THEN archived_at WHEN $13 THEN COALESCE(archived_at, now()) ELSE NULL END,
       metadata_revision = metadata_revision + 1, updated_at = now()
     WHERE asset_id = $1 AND owner_user_id = $2 AND metadata_revision = $3
     RETURNING metadata_revision`,
    [assetId, ownerUserId, update.expectedRevision, update.title ?? null, update.caption ?? null, update.notes ?? null,
      update.tags ? [...new Set(update.tags.map((tag) => tag.toLocaleLowerCase()))].sort() : null,
      update.reuseScope ?? null, update.automaticReuseEnabled ?? null, update.reviewStatus ?? null,
      update.contentCategories ? [...new Set(update.contentCategories)].sort() : null, update.favorite ?? null, update.archived ?? null]
  );
  if (!result.rows[0]) {
    const exists = await pool.query("SELECT 1 FROM asset_library_entries WHERE asset_id = $1 AND owner_user_id = $2", [assetId, ownerUserId]);
    throw Object.assign(new Error(exists.rowCount ? "Image metadata changed; reload before saving again." : "Asset not found."), { statusCode: exists.rowCount ? 409 : 404 });
  }
  return { assetId, metadataRevision: result.rows[0].metadata_revision };
}

async function requireOwnedAsset(client: DatabaseClient, ownerUserId: string, assetId: string): Promise<void> {
  const result = await client.query("SELECT id FROM assets WHERE id = $1 AND owner_user_id = $2", [assetId, ownerUserId]);
  if (!result.rowCount) throw Object.assign(new Error("Asset not found."), { statusCode: 404 });
}

export async function selectWorldCover(pool: DatabasePool, ownerUserId: string, worldId: string, assetId: string | null): Promise<{ assetUrl: string }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (assetId) await requireOwnedAsset(client, ownerUserId, assetId);
    const updated = await client.query(
      "UPDATE worlds SET cover_asset_id = $3, updated_at = now() WHERE id = $1 AND owner_user_id = $2 RETURNING id",
      [worldId, ownerUserId, assetId]
    );
    if (!updated.rowCount) throw Object.assign(new Error("World not found."), { statusCode: 404 });
    await client.query("COMMIT");
    return { assetUrl: assetId ? `/api/v1/assets/${assetId}` : "" };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function selectTurnIllustration(pool: DatabasePool, ownerUserId: string, turnId: string, assetId: string | null): Promise<{ assetUrl: string }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (assetId) await requireOwnedAsset(client, ownerUserId, assetId);
    const turn = await client.query<{ campaign_id: string }>(
      "SELECT campaign_id FROM turns WHERE id = $1 AND owner_user_id = $2 FOR UPDATE",
      [turnId, ownerUserId]
    );
    const campaignId = turn.rows[0]?.campaign_id;
    if (!campaignId) throw Object.assign(new Error("Turn not found."), { statusCode: 404 });
    const assetUrl = assetId ? `/api/v1/assets/${assetId}` : "";
    await client.query("UPDATE turns SET image_url = $3 WHERE id = $1 AND owner_user_id = $2", [turnId, ownerUserId, assetUrl]);
    await client.query(
      "DELETE FROM asset_references WHERE owner_user_id = $1 AND campaign_id = $2 AND turn_id = $3 AND asset_role = 'turn_illustration'",
      [ownerUserId, campaignId, turnId]
    );
    if (assetId) {
      await client.query(
        `INSERT INTO asset_references (owner_user_id, asset_id, campaign_id, turn_id, asset_role)
         VALUES ($1,$2,$3,$4,'turn_illustration') ON CONFLICT DO NOTHING`,
        [ownerUserId, assetId, campaignId, turnId]
      );
    }
    await client.query("COMMIT");
    return { assetUrl };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
