import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { sha256 } from "../../../packages/domain/src/text.js";
import { withTransaction, type DatabaseClient, type DatabasePool } from "../../../packages/database/src/pool.js";
import { archiveAssetRecordSchema, sanitizePortableMetadata, type ArchiveAssetBinding, type ArchiveAssetRecord, type ArchiveEntry, type ArchiveManifest } from "../../../packages/contracts/src/archives.js";
import { imageExtensionForMimeType, lockOriginalAsset, persistOriginalImage, verifyOriginalImage, type FilesystemAssetStore } from "./asset-service.js";
import { preflightArchivePath, removeArchivePath } from "./archive-io.js";

export type ArchiveAssetSourceRow = {
  id: string; owner_user_id: string; content_hash: string; mime_type: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  byte_length: number | string; pixel_width: number; pixel_height: number; storage_driver: string; storage_path: string;
  technical_metadata: unknown; created_at: Date | string; title: string; caption: string; notes: string; tags: string[];
  origin: "generated" | "imported" | "uploaded"; review_status: "unreviewed" | "eligible" | "restricted" | "blocked";
  reuse_scope: "private" | "campaign" | "world" | "owner_library" | "shared"; automatic_reuse_enabled: boolean;
  content_categories: string[]; favorite: boolean; archived_at: Date | string | null; bindings: ArchiveAssetBinding[];
};
type ArchiveAssetBindingRow = { asset_id: string; binding: ArchiveAssetBinding };
type ArchiveCampaignImageJobRow = {
  asset_id: string;
  target_type: "turn_illustration" | "streaming_illustration";
  campaign_id: string;
  turn_id: string | null;
};
type ArchiveAssetDetailRow = Omit<ArchiveAssetSourceRow, "bindings">;
export type CampaignAssetInventory = { records: ArchiveAssetRecord[]; uniqueOriginals: Array<{ contentHash: string; archivePath: string; sourceAssetIds: string[]; mimeType: ArchiveAssetSourceRow["mime_type"]; byteLength: number }> };
export type ValidatedArchiveAsset = ArchiveAssetRecord & { bytes: Buffer; createThumbnail: false };
export type ValidatedArchiveAssetSet = { assets: ValidatedArchiveAsset[] };
export type ArchiveIdKind = "world" | "worldVersion" | "campaign" | "turn" | "memory" | "summary" | "profileEdit" | "stateEdit" | "migration" | "transfer" | "illustrationSet" | "illustrationSegment" | "asset" | "generationContext";
export type ArchiveIdMap = Map<ArchiveIdKind, Map<string, string>>;

export class ArchiveAssetPersistenceError extends Error {
  readonly createdPaths: string[];

  constructor(cause: unknown, createdPaths: readonly string[]) {
    super("Archive asset persistence failed.", { cause });
    this.name = "ArchiveAssetPersistenceError";
    this.createdPaths = [...new Set(createdPaths)];
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

const iso = (value: Date | string) => value instanceof Date ? value.toISOString() : new Date(value).toISOString();
const archivePathFor = (hash: string, mime: string) => `assets/sha256/${hash.slice(0, 2)}/${hash}${imageExtensionForMimeType(mime)}`;
const missing = (ids: readonly string[]) => Object.assign(new Error(`Required archive assets are missing: ${ids.join(", ")}`), { code: "archive-asset-missing", assetIds: [...ids] });
const legacyAssetPointer = /^\/api\/v1\/assets\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;

function safeRelativeCleanupPath(root: string, candidate: string): string | null {
  const normalizedCandidate = candidate.replaceAll("\\", "/");
  if (!normalizedCandidate || normalizedCandidate.startsWith("/") || /^[A-Za-z]:/.test(normalizedCandidate)) return null;
  const canonical = /^([0-9a-f]{2})\/([0-9a-f]{64})\.(?:png|jpg|webp|gif)$/.exec(normalizedCandidate);
  if (!canonical || canonical[1] !== canonical[2]?.slice(0, 2)) return null;
  const absolute = resolve(root, normalizedCandidate);
  const relativePath = relative(resolve(root), absolute);
  if (!relativePath || relativePath === ".." || relativePath.startsWith(`..${sep}`)) return null;
  return relativePath.replaceAll("\\", "/");
}

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
  const relationshipResults = await Promise.all([
    client.query<ArchiveAssetBindingRow>(`SELECT r.asset_id,
      CASE
        WHEN r.asset_role = 'turn_illustration' AND r.turn_id IS NOT NULL THEN jsonb_build_object('role','turn_illustration','campaignId',r.campaign_id,'turnId',r.turn_id)
        WHEN r.asset_role = 'turn_illustration' THEN jsonb_build_object('role','campaign_asset','campaignId',r.campaign_id)
        WHEN r.asset_role = 'import_attachment' THEN jsonb_build_object('role','imported_attachment','campaignId',r.campaign_id,'turnId',r.turn_id)
        ELSE jsonb_build_object('role','campaign_asset','campaignId',r.campaign_id)
      END AS binding
      FROM asset_references r
      WHERE r.owner_user_id=$1 AND r.campaign_id=$2`, [ownerUserId, campaignId]),
    client.query<ArchiveAssetBindingRow>(`SELECT s.asset_id, jsonb_build_object('role','illustration_segment_variant','campaignId',seg.campaign_id,'turnId',seg.turn_id,'segmentId',seg.id,'variantIndex',s.variant_index) AS binding
      FROM turn_illustration_segment_assets s
      JOIN turn_illustration_segments seg ON seg.id=s.segment_id AND seg.owner_user_id=s.owner_user_id
      JOIN turns t ON t.id=seg.turn_id AND t.campaign_id=seg.campaign_id AND t.owner_user_id=seg.owner_user_id
     WHERE s.owner_user_id=$1 AND seg.campaign_id=$2`, [ownerUserId, campaignId]),
    client.query<ArchiveCampaignImageJobRow>(`SELECT j.asset_id, j.target_type, j.campaign_id, j.turn_id
      FROM image_jobs j
     WHERE j.owner_user_id=$1 AND j.status='completed' AND j.asset_id IS NOT NULL
       AND j.campaign_id=$2
       AND (j.target_type='streaming_illustration' OR (j.target_type='turn_illustration' AND j.turn_id IS NOT NULL))`, [ownerUserId, campaignId]),
    client.query<ArchiveAssetBindingRow>(`SELECT w.cover_asset_id AS asset_id, jsonb_build_object('role','world_cover','worldId',w.id) AS binding
      FROM worlds w
     WHERE w.id=$2 AND w.owner_user_id=$1 AND w.cover_asset_id IS NOT NULL`, [ownerUserId, worldId]),
    client.query<ArchiveAssetBindingRow>(`SELECT c.asset_id, jsonb_build_object('role','generation_context','campaignId',c.campaign_id,'worldId',c.world_id,'worldVersionId',c.world_version_id,'turnId',c.turn_id,'sourceContextId',c.id) AS binding
      FROM asset_generation_contexts c
      LEFT JOIN campaigns cp ON cp.id=c.campaign_id AND cp.owner_user_id=c.owner_user_id
      LEFT JOIN worlds w ON w.id=c.world_id AND w.owner_user_id=c.owner_user_id
      LEFT JOIN world_versions v ON v.id=c.world_version_id AND v.owner_user_id=c.owner_user_id
      LEFT JOIN turns t ON t.id=c.turn_id AND t.owner_user_id=c.owner_user_id AND t.campaign_id=c.campaign_id
     WHERE c.owner_user_id=$1
       AND ((c.campaign_id=$2 AND cp.id IS NOT NULL)
         OR (c.campaign_id IS NULL AND c.world_version_id=$3 AND v.world_id=$4)
         OR (c.campaign_id IS NULL AND c.world_id=$4 AND w.id IS NOT NULL))
       AND (c.world_id IS NULL OR w.id IS NOT NULL)
       AND (c.world_version_id IS NULL OR v.id IS NOT NULL)
       AND (c.turn_id IS NULL OR t.id IS NOT NULL)
       AND c.asset_id IS NOT NULL`, [ownerUserId, campaignId, worldVersionId, worldId])
  ]);
  const turnPointers = await client.query<{ id: string; image_url: string }>(
    `SELECT id, image_url FROM turns WHERE owner_user_id=$1 AND campaign_id=$2 AND image_url <> '' ORDER BY id`,
    [ownerUserId, campaignId]
  );
  const pinnedVersion = await client.query<{ content: unknown }>(
    `SELECT content FROM world_versions WHERE id=$1 AND world_id=$2 AND owner_user_id=$3`,
    [worldVersionId, worldId, ownerUserId]
  );
  const bindingMap = new Map<string, ArchiveAssetBinding[]>();
  const addBinding = (assetId: string, binding: ArchiveAssetBinding) => {
    const current = bindingMap.get(assetId) ?? [];
    if (!current.some((existing) => bindingKey(existing) === bindingKey(binding))) current.push(binding);
    bindingMap.set(assetId, current);
  };
  const [assetReferences, segmentAssets, campaignImageJobs, worldCover, generationContexts] = relationshipResults;
  for (const relationships of [assetReferences, segmentAssets, worldCover, generationContexts]) {
    for (const row of relationships.rows) addBinding(row.asset_id, row.binding);
  }
  for (const job of campaignImageJobs.rows) {
    addBinding(job.asset_id, job.target_type === "turn_illustration"
      ? { role: "turn_illustration", campaignId: job.campaign_id, turnId: job.turn_id! }
      : { role: "campaign_asset", campaignId: job.campaign_id });
  }
  const addLegacyPointer = (value: unknown, binding: ArchiveAssetBinding) => {
    if (typeof value !== "string") return;
    const assetId = legacyAssetPointer.exec(value)?.[1];
    if (!assetId) return;
    addBinding(assetId, binding);
  };
  for (const turn of turnPointers.rows) addLegacyPointer(turn.image_url, { role: "turn_illustration", campaignId, turnId: turn.id });
  const visit = (value: unknown) => {
    if (Array.isArray(value)) { for (const child of value) visit(child); return; }
    if (value && typeof value === "object") { for (const child of Object.values(value)) visit(child); return; }
    addLegacyPointer(value, { role: "world_version_asset", worldId, worldVersionId });
  };
  visit(pinnedVersion.rows[0]?.content);
  const selectedAssetIds = [...bindingMap.keys()];
  if (!selectedAssetIds.length) return { records: [], uniqueOriginals: [] };
  const assets = await client.query<ArchiveAssetDetailRow>(`SELECT a.id,a.owner_user_id,a.content_hash,a.mime_type,a.byte_length,a.pixel_width,a.pixel_height,a.storage_driver,a.storage_path,a.technical_metadata,a.created_at,
    l.title,l.caption,l.notes,l.tags,l.origin,l.review_status,l.reuse_scope,l.automatic_reuse_enabled,l.content_categories,l.favorite,l.archived_at
  FROM assets a JOIN asset_library_entries l ON l.asset_id=a.id AND l.owner_user_id=a.owner_user_id
 WHERE a.owner_user_id=$1 AND a.id = ANY($2::uuid[]) ORDER BY a.id`, [ownerUserId, selectedAssetIds]);
  const foundIds = new Set(assets.rows.map((asset) => asset.id));
  const missingIds = selectedAssetIds.filter((assetId) => !foundIds.has(assetId));
  if (missingIds.length) throw missing([...new Set(missingIds)].sort());
  return projectCampaignArchiveAssets(assets.rows.map((asset) => ({ ...asset, bindings: bindingMap.get(asset.id) ?? [] })));
}

export async function verifyAndWriteArchiveAssets(input: { records: readonly ArchiveAssetRecord[]; readOriginal: (sourceAssetId: string) => Promise<Buffer>; outputRoot: string; assertOutputRoot?: () => Promise<void> }): Promise<ArchiveEntry[]> {
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
    await input.assertOutputRoot?.();
    const target = resolve(input.outputRoot, record.archivePath); const root = `${resolve(input.outputRoot)}${sep}`; if (!target.startsWith(root)) throw new Error("Archive asset path escaped the output root."); await mkdir(dirname(target), { recursive: true }); await writeFile(target, bytes, { flag: "wx" }).catch(async (error: unknown) => { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; if (!(await readFile(target)).equals(bytes)) throw new Error(`Archive asset path collision at '${record.archivePath}'.`); });
    await input.assertOutputRoot?.();
    entries.push({ path: record.archivePath, logicalType: "asset-original", mediaType: record.mimeType, byteLength: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

export async function validateArchiveAssets(manifestOrInput: Pick<ArchiveManifest, "assets"> | ArchiveManifest | { records: readonly ArchiveAssetRecord[] }, readEntry: (path: string) => Promise<Buffer>): Promise<ValidatedArchiveAssetSet> {
  const hasFullManifest = "entries" in manifestOrInput;
  const manifest = "assets" in manifestOrInput ? manifestOrInput : { assets: manifestOrInput.records };
  const entries = hasFullManifest ? new Map(manifestOrInput.entries.map((entry) => [entry.path, entry])) : undefined;
  const assets: ValidatedArchiveAsset[] = [];
  for (const record of manifest.assets) {
    const expectedPath = archivePathFor(record.contentHash, record.mimeType);
    if (record.archivePath !== expectedPath) throw new Error(`Archive asset '${record.sourceAssetId}' does not use the canonical path '${expectedPath}'.`);
    if (entries) {
      const entry = entries.get(record.archivePath);
      if (!entry || entry.logicalType !== "asset-original" || entry.mediaType !== record.mimeType) {
        throw new Error(`Archive asset '${record.sourceAssetId}' is missing a matching asset-original entry.`);
      }
    }
    const bytes = await readEntry(record.archivePath); const verified = await verifyOriginalImage(bytes, record.mimeType);
    if (sha256(bytes.toString("base64")) !== record.contentHash || bytes.length !== record.byteLength || verified.width !== record.pixelWidth || verified.height !== record.pixelHeight) throw missing([record.sourceAssetId]);
    assets.push({ ...record, bytes, createThumbnail: false });
  }
  return { assets };
}

/**
 * Persist originals inside the caller's import transaction. If this throws an
 * ArchiveAssetPersistenceError, the caller must roll back first, then pass
 * error.createdPaths to cleanupUnreferencedCreatedPaths using the database
 * pool so surviving owner-scoped rows win the race with cleanup.
 */
export async function persistArchiveAssets(
  client: DatabaseClient,
  store: FilesystemAssetStore,
  ownerUserId: string,
  validated: ValidatedArchiveAssetSet,
  idMap: ArchiveIdMap = new Map()
): Promise<{ assetIds: Map<string, string>; createdPaths: string[] }> {
  const assetIds = new Map<string, string>(); const createdPaths: string[] = []; const byHash = new Map<string, ValidatedArchiveAsset>();
  for (const asset of validated.assets) byHash.set(asset.contentHash, byHash.get(asset.contentHash) ?? asset);
  try {
    const sourceAssetIds = new Set(validated.assets.map((asset) => asset.sourceAssetId));
    for (const sourceAssetId of idMap.get("asset")?.keys() ?? []) {
      if (!sourceAssetIds.has(sourceAssetId)) throw new Error(`Unknown archive asset mapping '${sourceAssetId}'.`);
    }
    for (const asset of [...byHash.values()].sort((a, b) => a.archivePath.localeCompare(b.archivePath))) {
      const stored = await persistOriginalImage(client, store, ownerUserId, {
        bytes: asset.bytes,
        mimeType: asset.mimeType,
        createThumbnail: false,
        onOriginalCreated: (storagePath) => {
          const safePath = safeRelativeCleanupPath(store.root, storagePath);
          if (safePath) createdPaths.push(safePath);
        }
      });
      assetIds.set(asset.sourceAssetId, stored.id);
      const updated = await client.query<{ asset_id: string }>(`UPDATE asset_library_entries SET title=$3,caption=$4,notes=$5,tags=$6,origin=$7,review_status=$8,reuse_scope=$9,automatic_reuse_enabled=$10,content_categories=$11,favorite=$12,archived_at=$13 WHERE asset_id=$1 AND owner_user_id=$2 RETURNING asset_id`, [stored.id, ownerUserId, asset.library.title, asset.library.caption, asset.library.notes, asset.library.tags, asset.library.origin, asset.library.reviewStatus, asset.library.reuseScope, asset.library.automaticReuseEnabled, asset.library.contentCategories, asset.library.favorite, asset.library.archivedAt]);
      if (!updated.rowCount) throw new Error(`Asset library metadata row is missing for '${stored.id}'.`);
    }
    for (const asset of validated.assets) {
      const destination = assetIds.get(byHash.get(asset.contentHash)?.sourceAssetId ?? ""); if (!destination) throw new Error(`Missing restored asset mapping for '${asset.sourceAssetId}'.`); assetIds.set(asset.sourceAssetId, destination);
    }
    if (idMap) idMap.set("asset", assetIds); return { assetIds, createdPaths };
  } catch (primaryError) {
    throw new ArchiveAssetPersistenceError(primaryError, createdPaths);
  }
}

function mapped(idMap: ArchiveIdMap, kind: ArchiveIdKind, source: string): string {
  const value = idMap.get(kind)?.get(source); if (!value) throw new Error(`Unknown archive ${kind} reference '${source}'.`); return value;
}
async function requireScope(client: DatabaseClient, owner: string, table: string, id: string, extra = "", extraValues: readonly unknown[] = []): Promise<void> {
  const result = await client.query(`SELECT 1 FROM ${table} WHERE id=$1 AND owner_user_id=$2 ${extra}`, [id, owner, ...extraValues]); if (!result.rowCount) throw new Error(`Archive target '${id}' is outside the requested scope.`);
}

export async function restoreAssetBindings(client: DatabaseClient, ownerUserId: string, records: readonly ArchiveAssetRecord[], assetIds: Map<string, string>, idMap: ArchiveIdMap): Promise<void> {
  for (const record of records) {
    const assetId = assetIds.get(record.sourceAssetId); if (!assetId) throw new Error(`Missing restored asset mapping for '${record.sourceAssetId}'.`);
    await requireScope(client, ownerUserId, "assets", assetId);
    for (const binding of [...record.bindings].sort((a, b) => bindingKey(a).localeCompare(bindingKey(b)))) {
      if (binding.role === "world_cover") { const worldId = mapped(idMap, "world", binding.worldId); await requireScope(client, ownerUserId, "worlds", worldId); await client.query("UPDATE worlds SET cover_asset_id=$3 WHERE id=$1 AND owner_user_id=$2", [worldId, ownerUserId, assetId]); }
      else if (binding.role === "world_version_asset") { const worldId = mapped(idMap, "world", binding.worldId); const versionId = mapped(idMap, "worldVersion", binding.worldVersionId); await requireScope(client, ownerUserId, "world_versions", versionId, "AND world_id=$3", [worldId]); }
      else if (binding.role === "campaign_asset" || binding.role === "turn_illustration" || binding.role === "imported_attachment") { const campaignId = mapped(idMap, "campaign", binding.campaignId); await requireScope(client, ownerUserId, "campaigns", campaignId); const turnSourceId = "turnId" in binding ? binding.turnId : null; const turnId = turnSourceId ? mapped(idMap, "turn", turnSourceId) : null; if (turnId) await requireScope(client, ownerUserId, "turns", turnId, "AND campaign_id=$3", [campaignId]); await client.query("INSERT INTO asset_references (owner_user_id,asset_id,campaign_id,turn_id,asset_role) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING", [ownerUserId, assetId, campaignId, turnId, binding.role === "imported_attachment" ? "import_attachment" : binding.role === "campaign_asset" ? "world_asset" : "turn_illustration"]); if (binding.role === "turn_illustration" && turnId) await client.query("UPDATE turns SET image_url=$3 WHERE id=$1 AND owner_user_id=$2 AND campaign_id=$4", [turnId, ownerUserId, `/api/v1/assets/${assetId}`, campaignId]); }
      else if (binding.role === "illustration_segment_variant") { const campaignId = mapped(idMap, "campaign", binding.campaignId); const turnId = mapped(idMap, "turn", binding.turnId); const segmentId = mapped(idMap, "illustrationSegment", binding.segmentId); await requireScope(client, ownerUserId, "campaigns", campaignId); await requireScope(client, ownerUserId, "turns", turnId, "AND campaign_id=$3", [campaignId]); await requireScope(client, ownerUserId, "turn_illustration_segments", segmentId, "AND campaign_id=$3 AND turn_id=$4", [campaignId, turnId]); await client.query("INSERT INTO turn_illustration_segment_assets (segment_id,owner_user_id,asset_id,variant_index) VALUES ($1,$2,$3,$4) ON CONFLICT (segment_id,variant_index) DO UPDATE SET asset_id=EXCLUDED.asset_id", [segmentId, ownerUserId, assetId, binding.variantIndex]); }
      else { const campaignId = binding.campaignId === null ? null : mapped(idMap, "campaign", binding.campaignId); const worldId = binding.worldId === null ? null : mapped(idMap, "world", binding.worldId); const versionId = binding.worldVersionId === null ? null : mapped(idMap, "worldVersion", binding.worldVersionId); const turnId = binding.turnId === null ? null : mapped(idMap, "turn", binding.turnId); const contextId = mapped(idMap, "generationContext", binding.sourceContextId); const context = await client.query<{ campaign_id: string | null; world_id: string | null; world_version_id: string | null; turn_id: string | null }>("SELECT campaign_id,world_id,world_version_id,turn_id FROM asset_generation_contexts WHERE id=$1 AND owner_user_id=$2", [contextId, ownerUserId]); const target = context.rows[0]; if (!target || target.campaign_id !== campaignId || target.world_id !== worldId || target.world_version_id !== versionId || target.turn_id !== turnId) throw new Error(`Archive destination context '${contextId}' does not match its binding relationships.`); await client.query("UPDATE asset_generation_contexts SET asset_id=$3 WHERE id=$1 AND owner_user_id=$2", [contextId, ownerUserId, assetId]); }
    }
  }
}

/**
 * Run only after the transaction that called persistArchiveAssets has rolled
 * back. The pool-owned transaction acquires all candidate locks, re-reads
 * references from the authoritative database, and deletes while those locks
 * remain held so concurrent or surviving owner-scoped assets retain bytes.
 */
export async function cleanupUnreferencedCreatedPaths(
  database: DatabasePool,
  store: FilesystemAssetStore,
  _ownerUserId: string,
  createdPaths: readonly string[]
): Promise<void> {
  const candidates = [...new Set(createdPaths.map((path) => safeRelativeCleanupPath(store.root, path)).filter((path): path is string => path !== null))].sort();
  const preflightedCandidates: string[] = [];
  for (const path of candidates) {
    if (await preflightArchivePath(store.root, path)) preflightedCandidates.push(path);
  }
  if (!preflightedCandidates.length) return;
  await withTransaction(database, async (client) => {
    for (const path of preflightedCandidates) await lockOriginalAsset(client, _ownerUserId, path);
    const references = await client.query<{ storage_path: string }>(
      `SELECT storage_path
         FROM assets
        WHERE storage_path = ANY($1::text[])
        UNION
       SELECT storage_path
         FROM asset_derivatives
        WHERE storage_path = ANY($1::text[])`,
      [preflightedCandidates]
    );
    const referencedPaths = new Set(references.rows.map((row) => row.storage_path.replaceAll("\\", "/")));
    for (const path of preflightedCandidates) {
      if (!referencedPaths.has(path)) await removeArchivePath(store.root, path);
    }
  });
}
