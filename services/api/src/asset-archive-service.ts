import { lstat, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { sha256 } from "../../../packages/domain/src/text.js";
import type { DatabaseClient } from "../../../packages/database/src/pool.js";
import { archiveAssetRecordSchema, sanitizePortableMetadata, type ArchiveAssetBinding, type ArchiveAssetRecord, type ArchiveEntry, type ArchiveManifest } from "../../../packages/contracts/src/archives.js";
import { imageExtensionForMimeType, persistOriginalImage, verifyOriginalImage, type FilesystemAssetStore } from "./asset-service.js";

export type ArchiveAssetSourceRow = {
  id: string; owner_user_id: string; content_hash: string; mime_type: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  byte_length: number | string; pixel_width: number; pixel_height: number; storage_driver: string; storage_path: string;
  technical_metadata: unknown; created_at: Date | string; title: string; caption: string; notes: string; tags: string[];
  origin: "generated" | "imported" | "uploaded"; review_status: "unreviewed" | "eligible" | "restricted" | "blocked";
  reuse_scope: "private" | "campaign" | "world" | "owner_library" | "shared"; automatic_reuse_enabled: boolean;
  content_categories: string[]; favorite: boolean; archived_at: Date | string | null; bindings: ArchiveAssetBinding[];
};
export type CampaignAssetInventory = { records: ArchiveAssetRecord[]; uniqueOriginals: Array<{ contentHash: string; archivePath: string; sourceAssetIds: string[]; mimeType: ArchiveAssetSourceRow["mime_type"]; byteLength: number }> };
export type ValidatedArchiveAsset = ArchiveAssetRecord & { bytes: Buffer; createThumbnail: false };
export type ValidatedArchiveAssetSet = { assets: ValidatedArchiveAsset[] };
export type ArchiveIdKind = "world" | "worldVersion" | "campaign" | "turn" | "memory" | "summary" | "profileEdit" | "stateEdit" | "migration" | "transfer" | "illustrationSet" | "illustrationSegment" | "asset" | "generationContext";
export type ArchiveIdMap = Map<ArchiveIdKind, Map<string, string>>;

const iso = (value: Date | string) => value instanceof Date ? value.toISOString() : new Date(value).toISOString();
const archivePathFor = (hash: string, mime: string) => `assets/sha256/${hash.slice(0, 2)}/${hash}${imageExtensionForMimeType(mime)}`;
const missing = (ids: readonly string[]) => Object.assign(new Error(`Required archive assets are missing: ${ids.join(", ")}`), { code: "archive-asset-missing", assetIds: [...ids] });

function bindingKey(binding: ArchiveAssetBinding): string {
  const ids = ["campaignId", "worldId", "worldVersionId", "turnId", "segmentId", "variantIndex", "sourceContextId"].map((key) => `${key}=${String((binding as Record<string, unknown>)[key] ?? "")}`);
  return `${binding.role}|${ids.join("|")}`;
}

export function projectCampaignArchiveAssets(rows: readonly ArchiveAssetSourceRow[]): CampaignAssetInventory {
  const records = rows.map((row) => archiveAssetRecordSchema.parse({
    sourceAssetId: row.id, contentHash: row.content_hash, archivePath: archivePathFor(row.content_hash, row.mime_type), mimeType: row.mime_type,
    byteLength: Number(row.byte_length), pixelWidth: row.pixel_width, pixelHeight: row.pixel_height, technicalMetadata: sanitizePortableMetadata(row.technical_metadata ?? {}),
    library: { title: row.title ?? "", caption: row.caption ?? "", notes: row.notes ?? "", tags: row.tags ?? [], origin: row.origin, reviewStatus: row.review_status, reuseScope: row.reuse_scope, automaticReuseEnabled: row.automatic_reuse_enabled, contentCategories: row.content_categories ?? [], favorite: row.favorite, archivedAt: row.archived_at === null ? null : iso(row.archived_at) },
    createdAt: iso(row.created_at), bindings: [...row.bindings].sort((a, b) => bindingKey(a).localeCompare(bindingKey(b)))
  })).sort((a, b) => a.sourceAssetId.localeCompare(b.sourceAssetId));
  const grouped = new Map<string, CampaignAssetInventory["uniqueOriginals"][number]>();
  for (const record of records) {
    const current = grouped.get(record.contentHash);
    if (current) { current.sourceAssetIds.push(record.sourceAssetId); if (current.mimeType !== record.mimeType || current.byteLength !== record.byteLength || current.archivePath !== record.archivePath) throw new Error(`Inconsistent metadata for content hash '${record.contentHash}'.`); }
    else grouped.set(record.contentHash, { contentHash: record.contentHash, archivePath: record.archivePath, sourceAssetIds: [record.sourceAssetId], mimeType: record.mimeType, byteLength: record.byteLength });
  }
  return { records, uniqueOriginals: [...grouped.values()].sort((a, b) => a.contentHash.localeCompare(b.contentHash)) };
}

export async function collectCampaignArchiveAssets(client: DatabaseClient, ownerUserId: string, campaignId: string, worldVersionId: string, worldId: string): Promise<CampaignAssetInventory> {
  const result = await client.query<ArchiveAssetSourceRow>(`WITH bindings AS (
    SELECT r.asset_id, jsonb_build_object('role', CASE WHEN r.asset_role='turn_illustration' THEN 'turn_illustration' WHEN r.asset_role='import_attachment' THEN 'imported_attachment' ELSE 'campaign_asset' END, 'campaignId', r.campaign_id, 'turnId', r.turn_id) binding
      FROM asset_references r WHERE r.owner_user_id=$1 AND r.campaign_id=$2
    UNION ALL SELECT s.asset_id, jsonb_build_object('role','illustration_segment_variant','campaignId',$2::text,'turnId',s.turn_id,'segmentId',s.segment_id,'variantIndex',s.variant_index)
      FROM turn_illustration_segment_assets s JOIN turn_illustration_segments seg ON seg.id=s.segment_id AND seg.owner_user_id=s.owner_user_id JOIN turns t ON t.id=seg.turn_id AND t.campaign_id=$2 AND t.owner_user_id=s.owner_user_id WHERE s.owner_user_id=$1
    UNION ALL SELECT j.asset_id, jsonb_build_object('role','world_cover','worldId',j.world_id)
      FROM image_jobs j WHERE j.owner_user_id=$1 AND j.status='completed' AND j.asset_id IS NOT NULL AND j.target_type='world_cover' AND j.world_id=$4
    UNION ALL SELECT j.asset_id, jsonb_build_object('role','turn_illustration','campaignId',j.campaign_id,'turnId',j.turn_id)
      FROM image_jobs j WHERE j.owner_user_id=$1 AND j.status='completed' AND j.asset_id IS NOT NULL AND j.target_type='turn_illustration' AND j.campaign_id=$2
    UNION ALL SELECT w.cover_asset_id, jsonb_build_object('role','world_cover','worldId',w.id) FROM worlds w WHERE w.id=$4 AND w.owner_user_id=$1 AND w.cover_asset_id IS NOT NULL
    UNION ALL SELECT c.asset_id, jsonb_build_object('role','generation_context','campaignId',c.campaign_id,'worldId',c.world_id,'worldVersionId',c.world_version_id,'turnId',c.turn_id,'sourceContextId',c.id)
      FROM asset_generation_contexts c WHERE c.owner_user_id=$1 AND (c.campaign_id=$2 OR c.world_version_id=$3 OR c.world_id=$4)
    UNION ALL SELECT a.id, jsonb_build_object('role','turn_illustration','campaignId',t.campaign_id,'turnId',t.id)
      FROM assets a JOIN turns t ON t.owner_user_id=$1 AND t.campaign_id=$2 AND (t.image_url LIKE '%/assets/'||a.id::text OR t.image_url LIKE '%'||a.id::text) WHERE a.owner_user_id=$1
    UNION ALL SELECT a.id, jsonb_build_object('role','world_cover','worldId',w.id)
      FROM assets a JOIN worlds w ON w.owner_user_id=$1 AND w.id=$4 AND (w.image_url LIKE '%/assets/'||a.id::text OR w.image_url LIKE '%'||a.id::text) WHERE a.owner_user_id=$1
  ), selected AS (SELECT DISTINCT asset_id FROM bindings WHERE asset_id IS NOT NULL)
  SELECT a.id,a.owner_user_id,a.content_hash,a.mime_type,a.byte_length,a.pixel_width,a.pixel_height,a.storage_driver,a.storage_path,a.technical_metadata,a.created_at,
    l.title,l.caption,l.notes,l.tags,l.origin,l.review_status,l.reuse_scope,l.automatic_reuse_enabled,l.content_categories,l.favorite,l.archived_at,
    COALESCE((SELECT jsonb_agg(DISTINCT b.binding) FROM bindings b WHERE b.asset_id=a.id),'[]'::jsonb) bindings
  FROM assets a JOIN selected s ON s.asset_id=a.id JOIN asset_library_entries l ON l.asset_id=a.id AND l.owner_user_id=$1 WHERE a.owner_user_id=$1 ORDER BY a.id`, [ownerUserId, campaignId, worldVersionId, worldId]);
  return projectCampaignArchiveAssets(result.rows);
}

export async function verifyAndWriteArchiveAssets(input: { records: readonly ArchiveAssetRecord[]; readOriginal: (sourceAssetId: string) => Promise<Buffer>; outputRoot: string }): Promise<ArchiveEntry[]> {
  const groups = new Map<string, ArchiveAssetRecord[]>();
  for (const record of input.records) { const group = groups.get(record.contentHash) ?? []; group.push(record); groups.set(record.contentHash, group); }
  const failures: string[] = []; const entries: ArchiveEntry[] = []; const staged: Array<{ record: ArchiveAssetRecord; bytes: Buffer }> = [];
  for (const [contentHash, records] of [...groups.entries()].sort()) {
    const first = records[0]!;
    if (records.some((record) => record.mimeType !== first.mimeType || record.byteLength !== first.byteLength || record.pixelWidth !== first.pixelWidth || record.pixelHeight !== first.pixelHeight || record.archivePath !== first.archivePath)) throw new Error(`Inconsistent metadata for content hash '${contentHash}'.`);
    const reads = await Promise.all(records.map(async (record) => { try { return { record, bytes: await input.readOriginal(record.sourceAssetId) }; } catch { failures.push(record.sourceAssetId); return null; } }));
    const read = reads.find(Boolean) as { record: ArchiveAssetRecord; bytes: Buffer } | undefined; if (!read) continue;
    try { const verified = await verifyOriginalImage(read.bytes, first.mimeType); if (sha256(read.bytes.toString("base64")) !== contentHash || read.bytes.length !== first.byteLength || verified.width !== first.pixelWidth || verified.height !== first.pixelHeight) throw new Error("verification");
      staged.push({ record: first, bytes: read.bytes });
    } catch { failures.push(...records.map((record) => record.sourceAssetId)); }
  }
  if (failures.length) throw missing([...new Set(failures)].sort());
  for (const { record, bytes } of staged) {
    const target = resolve(input.outputRoot, record.archivePath); const root = `${resolve(input.outputRoot)}${sep}`; if (!target.startsWith(root)) throw new Error("Archive asset path escaped the output root."); await mkdir(dirname(target), { recursive: true }); await writeFile(target, bytes, { flag: "wx" }).catch(async (error: unknown) => { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; if (!(await readFile(target)).equals(bytes)) throw new Error(`Archive asset path collision at '${record.archivePath}'.`); });
    entries.push({ path: record.archivePath, logicalType: "asset-original", mediaType: record.mimeType, byteLength: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

export async function validateArchiveAssets(manifestOrInput: Pick<ArchiveManifest, "assets"> | ArchiveManifest | { records: readonly ArchiveAssetRecord[] }, readEntry: (path: string) => Promise<Buffer>): Promise<ValidatedArchiveAssetSet> {
  const manifest = "assets" in manifestOrInput ? manifestOrInput : { assets: manifestOrInput.records };
  const assets: ValidatedArchiveAsset[] = [];
  for (const record of manifest.assets) {
    const bytes = await readEntry(record.archivePath); const verified = await verifyOriginalImage(bytes, record.mimeType);
    if (sha256(bytes.toString("base64")) !== record.contentHash || bytes.length !== record.byteLength || verified.width !== record.pixelWidth || verified.height !== record.pixelHeight) throw missing([record.sourceAssetId]);
    assets.push({ ...record, bytes, createThumbnail: false });
  }
  return { assets };
}

export async function persistArchiveAssets(client: DatabaseClient, store: FilesystemAssetStore, ownerUserId: string, validated: ValidatedArchiveAssetSet, idMap: ArchiveIdMap = new Map()): Promise<{ assetIds: Map<string, string>; createdPaths: string[] }> {
  const assetIds = new Map(idMap.get("asset") ?? []); const createdPaths: string[] = []; const byHash = new Map<string, ValidatedArchiveAsset>();
  for (const asset of validated.assets) byHash.set(asset.contentHash, byHash.get(asset.contentHash) ?? asset);
  for (const asset of byHash.values()) {
    const stored = await persistOriginalImage(client, store, ownerUserId, { bytes: asset.bytes, mimeType: asset.mimeType, createThumbnail: false });
    assetIds.set(asset.sourceAssetId, stored.id); assetIds.set(asset.contentHash, stored.id); createdPaths.push(`${asset.contentHash.slice(0, 2)}/${asset.contentHash}${imageExtensionForMimeType(asset.mimeType)}`);
    const updated = await client.query<{ asset_id: string }>(`UPDATE asset_library_entries SET title=$3,caption=$4,notes=$5,tags=$6,origin=$7,review_status=$8,reuse_scope=$9,automatic_reuse_enabled=$10,content_categories=$11,favorite=$12,archived_at=$13 WHERE asset_id=$1 AND owner_user_id=$2 RETURNING asset_id`, [stored.id, ownerUserId, asset.library.title, asset.library.caption, asset.library.notes, asset.library.tags, asset.library.origin, asset.library.reviewStatus, asset.library.reuseScope, asset.library.automaticReuseEnabled, asset.library.contentCategories, asset.library.favorite, asset.library.archivedAt]);
    if (!updated.rowCount) throw new Error(`Asset library metadata row is missing for '${stored.id}'.`);
  }
  for (const asset of validated.assets) {
    const destination = assetIds.get(asset.contentHash); if (!destination) throw new Error(`Missing restored asset mapping for '${asset.sourceAssetId}'.`); assetIds.set(asset.sourceAssetId, destination);
  }
  if (idMap) idMap.set("asset", assetIds); return { assetIds, createdPaths };
}

function mapped(idMap: ArchiveIdMap, kind: ArchiveIdKind, source: string): string {
  const value = idMap.get(kind)?.get(source); if (!value) throw new Error(`Unknown archive ${kind} reference '${source}'.`); return value;
}
async function requireScope(client: DatabaseClient, owner: string, table: string, id: string, extra = "", extraValues: readonly unknown[] = []): Promise<void> {
  const result = await client.query(`SELECT 1 FROM ${table} WHERE id=$1 AND owner_user_id=$2 ${extra}`, [id, owner, ...extraValues]); if (!result.rowCount) throw new Error(`Archive target '${id}' is outside the requested scope.`);
}

export async function restoreAssetBindings(client: DatabaseClient, ownerUserId: string, records: readonly ArchiveAssetRecord[], assetIds: Map<string, string>, idMap: ArchiveIdMap): Promise<void> {
  for (const record of records) {
    const assetId = assetIds.get(record.sourceAssetId) ?? assetIds.get(record.contentHash); if (!assetId) throw new Error(`Missing restored asset mapping for '${record.sourceAssetId}'.`);
    await requireScope(client, ownerUserId, "assets", assetId);
    for (const binding of [...record.bindings].sort((a, b) => bindingKey(a).localeCompare(bindingKey(b)))) {
      if (binding.role === "world_cover") { const worldId = mapped(idMap, "world", binding.worldId); await requireScope(client, ownerUserId, "worlds", worldId); await client.query("UPDATE worlds SET cover_asset_id=$3 WHERE id=$1 AND owner_user_id=$2", [worldId, ownerUserId, assetId]); }
      else if (binding.role === "world_version_asset") { const worldId = mapped(idMap, "world", binding.worldId); const versionId = mapped(idMap, "worldVersion", binding.worldVersionId); await requireScope(client, ownerUserId, "world_versions", versionId, "AND world_id=$3", [worldId]); await client.query("INSERT INTO asset_references (owner_user_id,asset_id,campaign_id,turn_id,asset_role) SELECT $1,$2,c.id,NULL,'world_asset' FROM campaigns c WHERE c.owner_user_id=$1 AND c.world_version_id=$3 ON CONFLICT DO NOTHING", [ownerUserId, assetId, versionId]); }
      else if (binding.role === "campaign_asset" || binding.role === "turn_illustration" || binding.role === "imported_attachment") { const campaignId = mapped(idMap, "campaign", binding.campaignId); await requireScope(client, ownerUserId, "campaigns", campaignId); const turnId = "turnId" in binding && binding.turnId ? mapped(idMap, "turn", binding.turnId) : null; if (turnId) await requireScope(client, ownerUserId, "turns", turnId, "AND campaign_id=$3", [campaignId]); await client.query("INSERT INTO asset_references (owner_user_id,asset_id,campaign_id,turn_id,asset_role) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING", [ownerUserId, assetId, campaignId, turnId, binding.role === "imported_attachment" ? "import_attachment" : binding.role === "campaign_asset" ? "world_asset" : "turn_illustration"]); }
      else if (binding.role === "illustration_segment_variant") { const campaignId = mapped(idMap, "campaign", binding.campaignId); const turnId = mapped(idMap, "turn", binding.turnId); const segmentId = mapped(idMap, "illustrationSegment", binding.segmentId); await requireScope(client, ownerUserId, "campaigns", campaignId); await requireScope(client, ownerUserId, "turns", turnId, "AND campaign_id=$3", [campaignId]); await requireScope(client, ownerUserId, "turn_illustration_segments", segmentId); await client.query("INSERT INTO turn_illustration_segment_assets (segment_id,owner_user_id,asset_id,variant_index) VALUES ($1,$2,$3,$4) ON CONFLICT (segment_id,variant_index) DO UPDATE SET asset_id=EXCLUDED.asset_id", [segmentId, ownerUserId, assetId, binding.variantIndex]); }
      else { const campaignId = binding.campaignId ? mapped(idMap, "campaign", binding.campaignId) : null; const turnId = binding.turnId ? mapped(idMap, "turn", binding.turnId) : null; const contextId = mapped(idMap, "generationContext", binding.sourceContextId); if (campaignId) await requireScope(client, ownerUserId, "campaigns", campaignId); if (turnId) await requireScope(client, ownerUserId, "turns", turnId, campaignId ? "AND campaign_id=$3" : "", campaignId ? [campaignId] : []); await requireScope(client, ownerUserId, "asset_generation_contexts", contextId); await client.query("UPDATE asset_generation_contexts SET asset_id=$3 WHERE id=$1 AND owner_user_id=$2", [contextId, ownerUserId, assetId]); }
    }
  }
}

export async function cleanupUnreferencedCreatedPaths(store: FilesystemAssetStore, createdPaths: readonly string[], referencedAbsolutePaths: ReadonlySet<string>): Promise<void> {
  const root = resolve(store.root); for (const path of createdPaths) { const absolute = resolve(root, path); const relativePath = relative(root, absolute); if (!relativePath || relativePath === ".." || relativePath.startsWith(`..${sep}`) || referencedAbsolutePaths.has(absolute)) continue; const file = await lstat(absolute).catch((error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT" ? null : Promise.reject(error)); if (!file || !file.isFile() || file.isSymbolicLink()) continue; await unlink(absolute).catch((error: unknown) => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }); }
}
