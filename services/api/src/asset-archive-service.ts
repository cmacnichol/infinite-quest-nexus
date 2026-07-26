import { lstat, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import type { DatabaseClient } from "../../../packages/database/src/pool.js";
import {
  archiveAssetRecordSchema,
  sanitizePortableMetadata,
  type ArchiveAssetBinding,
  type ArchiveAssetRecord,
  type ArchiveEntry,
  type ArchiveManifest
} from "../../../packages/contracts/src/archives.js";
import { imageExtensionForMimeType, verifyOriginalImage, persistOriginalImage, type FilesystemAssetStore } from "./asset-service.js";

export type ArchiveAssetSourceRow = {
  id: string;
  owner_user_id: string;
  content_hash: string;
  mime_type: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  byte_length: number | string;
  pixel_width: number;
  pixel_height: number;
  storage_driver: string;
  storage_path: string;
  technical_metadata: unknown;
  created_at: Date | string;
  title: string;
  caption: string;
  notes: string;
  tags: string[];
  origin: "generated" | "imported" | "uploaded";
  review_status: "unreviewed" | "eligible" | "restricted" | "blocked";
  reuse_scope: "private" | "campaign" | "world" | "owner_library" | "shared";
  automatic_reuse_enabled: boolean;
  content_categories: string[];
  favorite: boolean;
  archived_at: Date | string | null;
  bindings: ArchiveAssetBinding[];
};

export type CampaignAssetInventory = {
  records: ArchiveAssetRecord[];
  uniqueOriginals: Array<{
    contentHash: string;
    archivePath: string;
    sourceAssetIds: string[];
    mimeType: ArchiveAssetSourceRow["mime_type"];
    byteLength: number;
  }>;
};

export type ValidatedArchiveAsset = ArchiveAssetRecord & {
  bytes: Buffer;
  createThumbnail: false;
};

export type ValidatedArchiveAssetSet = { assets: ValidatedArchiveAsset[] };
export type ArchiveIdMap = Map<string, string>;

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function archivePathFor(hash: string, mimeType: string): string {
  return `assets/sha256/${hash.slice(0, 2)}/${hash}${imageExtensionForMimeType(mimeType)}`;
}

export function projectCampaignArchiveAssets(rows: readonly ArchiveAssetSourceRow[]): CampaignAssetInventory {
  const records = rows.map((row) => archiveAssetRecordSchema.parse({
    sourceAssetId: row.id,
    contentHash: row.content_hash,
    archivePath: archivePathFor(row.content_hash, row.mime_type),
    mimeType: row.mime_type,
    byteLength: Number(row.byte_length),
    pixelWidth: row.pixel_width,
    pixelHeight: row.pixel_height,
    technicalMetadata: sanitizePortableMetadata(row.technical_metadata ?? {}),
    library: {
      title: row.title ?? "", caption: row.caption ?? "", notes: row.notes ?? "", tags: row.tags ?? [],
      origin: row.origin, reviewStatus: row.review_status, reuseScope: row.reuse_scope,
      automaticReuseEnabled: row.automatic_reuse_enabled, contentCategories: row.content_categories ?? [],
      favorite: row.favorite, archivedAt: row.archived_at === null ? null : iso(row.archived_at)
    },
    createdAt: iso(row.created_at),
    bindings: [...row.bindings].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
  })).sort((left, right) => left.sourceAssetId.localeCompare(right.sourceAssetId));
  const grouped = new Map<string, CampaignAssetInventory["uniqueOriginals"][number]>();
  for (const record of records) {
    const current = grouped.get(record.contentHash);
    if (current) current.sourceAssetIds.push(record.sourceAssetId);
    else grouped.set(record.contentHash, {
      contentHash: record.contentHash, archivePath: record.archivePath, sourceAssetIds: [record.sourceAssetId],
      mimeType: record.mimeType, byteLength: record.byteLength
    });
  }
  return { records, uniqueOriginals: [...grouped.values()].sort((left, right) => left.contentHash.localeCompare(right.contentHash)) };
}

export async function collectCampaignArchiveAssets(
  client: DatabaseClient,
  ownerUserId: string,
  campaignId: string,
  worldVersionId: string,
  worldId: string
): Promise<CampaignAssetInventory> {
  const result = await client.query<ArchiveAssetSourceRow>(
    `SELECT assets.id, assets.owner_user_id, assets.content_hash, assets.mime_type, assets.byte_length,
            assets.pixel_width, assets.pixel_height, assets.storage_driver, assets.storage_path,
            assets.technical_metadata, assets.created_at, library.title, library.caption, library.notes,
            library.tags, library.origin, library.review_status, library.reuse_scope,
            library.automatic_reuse_enabled, library.content_categories, library.favorite, library.archived_at,
            COALESCE(jsonb_agg(DISTINCT jsonb_build_object('role', 'campaign_asset', 'campaignId', $2::text))
              FILTER (WHERE refs.asset_id IS NOT NULL), '[]'::jsonb) AS bindings
       FROM assets
       JOIN asset_library_entries library ON library.asset_id = assets.id AND library.owner_user_id = $1
       LEFT JOIN asset_references refs ON refs.asset_id = assets.id AND refs.owner_user_id = $1
         AND refs.campaign_id = $2
       LEFT JOIN asset_generation_contexts contexts ON contexts.asset_id = assets.id AND contexts.owner_user_id = $1
         AND (contexts.campaign_id = $2 OR contexts.world_version_id = $3 OR contexts.world_id = $4)
      WHERE assets.owner_user_id = $1
        AND (refs.asset_id IS NOT NULL OR contexts.asset_id IS NOT NULL)
      GROUP BY assets.id, library.asset_id
      ORDER BY assets.id`, [ownerUserId, campaignId, worldVersionId, worldId]
  );
  return projectCampaignArchiveAssets(result.rows);
}

export async function verifyAndWriteArchiveAssets(input: {
  records: readonly ArchiveAssetRecord[];
  readOriginal: (sourceAssetId: string) => Promise<Buffer>;
  outputRoot: string;
}): Promise<ArchiveEntry[]> {
  const entries: ArchiveEntry[] = [];
  const written = new Set<string>();
  for (const record of [...input.records].sort((a, b) => a.archivePath.localeCompare(b.archivePath))) {
    if (written.has(record.archivePath)) continue;
    const bytes = await input.readOriginal(record.sourceAssetId);
    const verified = await verifyOriginalImage(bytes, record.mimeType);
    const actualHash = createHash("sha256").update(bytes).digest("hex");
    if (actualHash !== record.contentHash || bytes.length !== record.byteLength
      || verified.width !== record.pixelWidth || verified.height !== record.pixelHeight) {
      throw new Error(`Archive asset '${record.sourceAssetId}' failed content verification.`);
    }
    const target = resolve(input.outputRoot, record.archivePath);
    const rootPrefix = `${resolve(input.outputRoot)}${sep}`;
    if (!target.startsWith(rootPrefix)) throw new Error("Archive asset path escaped the output root.");
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes, { flag: "wx" }).catch(async (error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await readFile(target);
      if (!existing.equals(bytes)) throw new Error(`Archive asset path collision at '${record.archivePath}'.`);
    });
    written.add(record.archivePath);
    entries.push({ path: record.archivePath, logicalType: "asset-original", mediaType: record.mimeType, byteLength: bytes.length, sha256: actualHash });
  }
  return entries;
}

export async function validateArchiveAssets(
  manifestOrInput: Pick<ArchiveManifest, "assets"> | ArchiveManifest | { records: readonly ArchiveAssetRecord[] },
  readEntry: (path: string) => Promise<Buffer>
): Promise<ValidatedArchiveAssetSet> {
  const manifest = "assets" in manifestOrInput ? manifestOrInput : { assets: manifestOrInput.records };
  const assets: ValidatedArchiveAsset[] = [];
  for (const record of manifest.assets) {
    const bytes = await readEntry(record.archivePath);
    const verified = await verifyOriginalImage(bytes, record.mimeType);
    const hash = createHash("sha256").update(bytes).digest("hex");
    if (hash !== record.contentHash || bytes.length !== record.byteLength || verified.width !== record.pixelWidth || verified.height !== record.pixelHeight) {
      throw new Error(`Archive asset '${record.sourceAssetId}' failed validation.`);
    }
    assets.push({ ...record, bytes, createThumbnail: false });
  }
  return { assets };
}

export async function persistArchiveAssets(
  client: DatabaseClient,
  store: FilesystemAssetStore,
  ownerUserId: string,
  validated: ValidatedArchiveAssetSet,
  idMap: ArchiveIdMap = new Map()
): Promise<{ assetIds: Map<string, string>; createdPaths: string[] }> {
  const assetIds = new Map(idMap);
  const createdPaths: string[] = [];
  for (const asset of validated.assets) {
    const existing = assetIds.get(asset.contentHash);
    if (existing) { assetIds.set(asset.sourceAssetId, existing); continue; }
    const stored = await persistOriginalImage(client, store, ownerUserId, {
      bytes: asset.bytes, mimeType: asset.mimeType, createThumbnail: false
    });
    assetIds.set(asset.contentHash, stored.id);
    assetIds.set(asset.sourceAssetId, stored.id);
    createdPaths.push(`${asset.contentHash.slice(0, 2)}/${asset.contentHash}${imageExtensionForMimeType(asset.mimeType)}`);
    await client.query(
      `UPDATE asset_library_entries SET title=$3, caption=$4, notes=$5, tags=$6, origin=$7,
          review_status=$8, reuse_scope=$9, automatic_reuse_enabled=$10, content_categories=$11,
          favorite=$12, archived_at=$13 WHERE asset_id=$1 AND owner_user_id=$2`,
      [stored.id, ownerUserId, asset.library.title, asset.library.caption, asset.library.notes, asset.library.tags,
        asset.library.origin, asset.library.reviewStatus, asset.library.reuseScope, asset.library.automaticReuseEnabled,
        asset.library.contentCategories, asset.library.favorite, asset.library.archivedAt]
    );
  }
  return { assetIds, createdPaths };
}

export async function restoreAssetBindings(
  client: DatabaseClient,
  ownerUserId: string,
  records: readonly ArchiveAssetRecord[],
  assetIds: ArchiveIdMap,
  _idMap: ArchiveIdMap = new Map()
): Promise<void> {
  for (const record of records) {
    const assetId = assetIds.get(record.sourceAssetId) ?? assetIds.get(record.contentHash);
    if (!assetId) throw new Error(`Missing restored asset mapping for '${record.sourceAssetId}'.`);
    for (const binding of record.bindings) {
      if (binding.role === "world_cover") {
        await client.query("UPDATE worlds SET cover_asset_id = $3 WHERE id = $1 AND owner_user_id = $2", [binding.worldId, ownerUserId, assetId]);
      } else if (binding.role === "illustration_segment_variant") {
        await client.query(
          `INSERT INTO turn_illustration_segment_assets (segment_id, owner_user_id, asset_id, variant_index)
           VALUES ($1,$2,$3,$4) ON CONFLICT (segment_id, variant_index)
           DO UPDATE SET asset_id = EXCLUDED.asset_id`,
          [binding.segmentId, ownerUserId, assetId, binding.variantIndex]
        );
      } else if (binding.role === "turn_illustration" || binding.role === "imported_attachment") {
        await client.query(
          `INSERT INTO asset_references (owner_user_id, asset_id, campaign_id, turn_id, asset_role)
           VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
          [ownerUserId, assetId, binding.campaignId, binding.turnId, binding.role === "turn_illustration" ? binding.role : "import_attachment"]
        );
      } else if (binding.role === "campaign_asset") {
        await client.query(
          `INSERT INTO asset_references (owner_user_id, asset_id, campaign_id, turn_id, asset_role)
           VALUES ($1,$2,$3,NULL,'world_asset') ON CONFLICT DO NOTHING`,
          [ownerUserId, assetId, binding.campaignId]
        );
      }
    }
  }
}

export async function cleanupUnreferencedCreatedPaths(
  store: FilesystemAssetStore,
  createdPaths: readonly string[],
  referencedAbsolutePaths: ReadonlySet<string>
): Promise<void> {
  const root = resolve(store.root);
  for (const path of createdPaths) {
    const absolute = resolve(root, path);
    const relativePath = relative(root, absolute);
    if (!relativePath || relativePath === ".." || relativePath.startsWith(`..${sep}`) || referencedAbsolutePaths.has(absolute)) continue;
    const file = await lstat(absolute).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
    if (!file || !file.isFile() || file.isSymbolicLink()) continue;
    await unlink(absolute).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
  }
}
