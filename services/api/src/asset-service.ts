import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, extname, resolve, sep } from "node:path";
import type { DatabaseClient, DatabasePool } from "../../../packages/database/src/pool.js";
import { sha256 } from "../../../packages/domain/src/text.js";

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
  mimeType: string;
  byteLength: number;
  createdAt: string;
  campaignId: string | null;
  turnId: string | null;
};

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
  campaignId: string,
  turnId: string,
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
  campaignId: string,
  turnId: string,
  bytes: Buffer,
  mimeType: string
): Promise<StoredAsset> {
  return persistImage(client, store, ownerUserId, bytes, mimeType, { campaignId, turnId });
}

export async function persistWorldCover(
  client: DatabaseClient,
  store: FilesystemAssetStore,
  ownerUserId: string,
  bytes: Buffer,
  mimeType: string
): Promise<StoredAsset> {
  return persistImage(client, store, ownerUserId, bytes, mimeType);
}

async function persistImage(
  client: DatabaseClient,
  store: FilesystemAssetStore,
  ownerUserId: string,
  bytes: Buffer,
  mimeType: string,
  provenance?: { campaignId: string; turnId: string }
): Promise<StoredAsset> {
  const extension = ALLOWED_IMAGE_TYPES.get(mimeType);
  if (!extension) throw new Error(`Generated image type '${mimeType}' is not supported.`);
  if (!bytes.length) throw new Error("Generated image data was empty.");
  if (bytes.length > MAX_IMPORTED_IMAGE_BYTES) throw new Error("Generated image exceeded the 25 MB per-image limit.");
  if (!matchesImageSignature(bytes, mimeType)) throw new Error(`Image bytes did not match declared type '${mimeType}'.`);
  const contentHash = sha256(bytes.toString("base64"));
  const storagePath = await writeContentAddressed(store, contentHash, extension, bytes);
  const assetResult = await client.query<{ id: string }>(
    `INSERT INTO assets (
       owner_user_id, campaign_id, turn_id, content_hash, storage_driver, storage_path, mime_type, byte_length
     ) VALUES ($1,$2,$3,$4,'filesystem',$5,$6,$7)
     ON CONFLICT (owner_user_id, content_hash)
     DO UPDATE SET content_hash = EXCLUDED.content_hash
     RETURNING id`,
    [ownerUserId, provenance?.campaignId ?? null, provenance?.turnId ?? null, contentHash, storagePath, mimeType, bytes.length]
  );
  const assetId = assetResult.rows[0]?.id;
  if (!assetId) throw new Error("Could not persist imported image metadata.");
  if (provenance) {
    await client.query(
      `INSERT INTO asset_references (owner_user_id, asset_id, campaign_id, turn_id, asset_role)
       VALUES ($1,$2,$3,$4,'turn_illustration') ON CONFLICT DO NOTHING`,
      [ownerUserId, assetId, provenance.campaignId, provenance.turnId]
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

export async function listAssets(pool: DatabasePool, ownerUserId: string, limit = 100): Promise<AssetLibraryItem[]> {
  const boundedLimit = Math.max(1, Math.min(250, Math.trunc(limit)));
  const result = await pool.query<{
    id: string;
    mime_type: string;
    byte_length: string;
    created_at: Date;
    campaign_id: string | null;
    turn_id: string | null;
  }>(
    `SELECT id, mime_type, byte_length::text, created_at, campaign_id, turn_id
       FROM assets
      WHERE owner_user_id = $1
      ORDER BY created_at DESC, id DESC
      LIMIT $2`,
    [ownerUserId, boundedLimit]
  );
  return result.rows.map((row) => ({
    id: row.id,
    url: `/api/v1/assets/${row.id}`,
    mimeType: row.mime_type,
    byteLength: Number(row.byte_length),
    createdAt: row.created_at.toISOString(),
    campaignId: row.campaign_id,
    turnId: row.turn_id
  }));
}

async function requireOwnedAsset(client: DatabaseClient, ownerUserId: string, assetId: string): Promise<void> {
  const result = await client.query("SELECT id FROM assets WHERE id = $1 AND owner_user_id = $2", [assetId, ownerUserId]);
  if (!result.rowCount) throw Object.assign(new Error("Asset not found."), { statusCode: 404 });
}

export async function selectWorldCover(pool: DatabasePool, ownerUserId: string, worldId: string, assetId: string): Promise<{ assetUrl: string }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await requireOwnedAsset(client, ownerUserId, assetId);
    const updated = await client.query(
      "UPDATE worlds SET cover_asset_id = $3, updated_at = now() WHERE id = $1 AND owner_user_id = $2 RETURNING id",
      [worldId, ownerUserId, assetId]
    );
    if (!updated.rowCount) throw Object.assign(new Error("World not found."), { statusCode: 404 });
    await client.query("COMMIT");
    return { assetUrl: `/api/v1/assets/${assetId}` };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function selectTurnIllustration(pool: DatabasePool, ownerUserId: string, turnId: string, assetId: string): Promise<{ assetUrl: string }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await requireOwnedAsset(client, ownerUserId, assetId);
    const turn = await client.query<{ campaign_id: string }>(
      "SELECT campaign_id FROM turns WHERE id = $1 AND owner_user_id = $2 FOR UPDATE",
      [turnId, ownerUserId]
    );
    const campaignId = turn.rows[0]?.campaign_id;
    if (!campaignId) throw Object.assign(new Error("Turn not found."), { statusCode: 404 });
    const assetUrl = `/api/v1/assets/${assetId}`;
    await client.query("UPDATE turns SET image_url = $3 WHERE id = $1 AND owner_user_id = $2", [turnId, ownerUserId, assetUrl]);
    await client.query(
      "DELETE FROM asset_references WHERE owner_user_id = $1 AND campaign_id = $2 AND turn_id = $3 AND asset_role = 'turn_illustration'",
      [ownerUserId, campaignId, turnId]
    );
    await client.query(
      `INSERT INTO asset_references (owner_user_id, asset_id, campaign_id, turn_id, asset_role)
       VALUES ($1,$2,$3,$4,'turn_illustration') ON CONFLICT DO NOTHING`,
      [ownerUserId, assetId, campaignId, turnId]
    );
    await client.query("COMMIT");
    return { assetUrl };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
