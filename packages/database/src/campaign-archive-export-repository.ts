import type { ArchiveAssetBinding, ArchiveAssetRecord } from "../../contracts/src/archives.js";
import { archiveAssetRecordSchema, sanitizePortableMetadata } from "../../contracts/src/archives.js";
import type { WorldContent } from "../../contracts/src/world-library.js";
import type { DatabaseClient, DatabasePool } from "./pool.js";

type SnapshotCampaign = Record<string, any> & {
  id: string;
  world_id: string;
  world_version_id: string;
  version_number: number;
  content: WorldContent;
  revision: number;
};

type AssetSourceRow = {
  id: string;
  content_hash: string;
  mime_type: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  byte_length: number | string;
  pixel_width: number;
  pixel_height: number;
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
};

export type CampaignArchiveExportAssetInventory = Readonly<{
  records: readonly ArchiveAssetRecord[];
  uniqueOriginals: readonly Readonly<{
    contentHash: string;
    archivePath: string;
    sourceAssetIds: readonly string[];
    mimeType: AssetSourceRow["mime_type"];
    byteLength: number;
    pixelWidth: number;
    pixelHeight: number;
  }>[];
}>;

export type CampaignArchiveExportSnapshot = Readonly<{
  ownerUserId: string;
  campaign: SnapshotCampaign;
  turns: readonly Record<string, any>[];
  profileEdits: readonly unknown[];
  stateEdits: readonly unknown[];
  narrationCorrections: readonly unknown[];
  migrations: readonly unknown[];
  illustrationConfig: unknown | null;
  illustrationSets: readonly unknown[];
  illustrationSegments: readonly unknown[];
  costs: readonly unknown[];
  memories: readonly unknown[];
  summaries: readonly unknown[];
  legacyHistory: Readonly<{ content: unknown; through_turn: number }> | null;
  assets: CampaignArchiveExportAssetInventory;
}>;

const legacyAssetPointer = /^\/api\/v1\/assets\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/iu;

function exportError(message: string, statusCode = 409): Error {
  return Object.assign(new Error(message), { code: "archive-export-inconsistent", statusCode });
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function imageExtension(mimeType: string): string {
  switch (mimeType) {
    case "image/jpeg": return ".jpg";
    case "image/webp": return ".webp";
    case "image/gif": return ".gif";
    default: return ".png";
  }
}

function bindingKey(binding: ArchiveAssetBinding): string {
  const fields = ["campaignId", "worldId", "worldVersionId", "turnId", "segmentId", "variantIndex", "sourceContextId"];
  return `${binding.role}|${fields.map((field) => `${field}=${String((binding as Record<string, unknown>)[field] ?? "")}`).join("|")}`;
}

function portableRow(row: Record<string, unknown>): Record<string, unknown> {
  const excluded = new Set([
    "owner_user_id", "provider_profile_id", "embedding", "response_metadata",
    "provider_response_id", "response_id", "lease_owner", "lease_expires_at",
  ]);
  return Object.fromEntries(Object.entries(row).flatMap(([key, value]) => (
    excluded.has(key) ? [] : [[key, sanitizePortableMetadata(value instanceof Date ? value.toISOString() : value)]]
  )));
}

async function queryRows(client: DatabaseClient, sql: string, values: readonly unknown[]): Promise<readonly unknown[]> {
  return (await client.query<Record<string, unknown>>(sql, [...values])).rows.map(portableRow);
}

async function collectAssets(
  client: DatabaseClient,
  ownerUserId: string,
  campaignId: string,
  worldVersionId: string,
  worldId: string,
): Promise<CampaignArchiveExportAssetInventory> {
  type BindingRow = { asset_id: string; binding: ArchiveAssetBinding };
  const references = await client.query<BindingRow>(`SELECT r.asset_id,
      CASE
        WHEN r.asset_role = 'turn_illustration' AND r.turn_id IS NOT NULL THEN jsonb_build_object('role','turn_illustration','campaignId',r.campaign_id,'turnId',r.turn_id)
        WHEN r.asset_role = 'turn_illustration' THEN jsonb_build_object('role','campaign_asset','campaignId',r.campaign_id)
        WHEN r.asset_role = 'import_attachment' THEN jsonb_build_object('role','imported_attachment','campaignId',r.campaign_id,'turnId',r.turn_id)
        ELSE jsonb_build_object('role','campaign_asset','campaignId',r.campaign_id)
      END AS binding
      FROM asset_references r WHERE r.owner_user_id=$1 AND r.campaign_id=$2`, [ownerUserId, campaignId]);
  const segmentAssets = await client.query<BindingRow>(`SELECT s.asset_id, jsonb_build_object('role','illustration_segment_variant','campaignId',seg.campaign_id,'turnId',seg.turn_id,'segmentId',seg.id,'variantIndex',s.variant_index) AS binding
      FROM turn_illustration_segment_assets s
      JOIN turn_illustration_segments seg ON seg.id=s.segment_id AND seg.owner_user_id=s.owner_user_id
      JOIN turns t ON t.id=seg.turn_id AND t.campaign_id=seg.campaign_id AND t.owner_user_id=seg.owner_user_id
     WHERE s.owner_user_id=$1 AND seg.campaign_id=$2`, [ownerUserId, campaignId]);
  const imageJobs = await client.query<{ asset_id: string; target_type: "turn_illustration" | "streaming_illustration"; campaign_id: string; turn_id: string | null }>(`SELECT asset_id,target_type,campaign_id,turn_id FROM image_jobs
      WHERE owner_user_id=$1 AND status='completed' AND asset_id IS NOT NULL AND campaign_id=$2
        AND (target_type='streaming_illustration' OR (target_type='turn_illustration' AND turn_id IS NOT NULL))`, [ownerUserId, campaignId]);
  const worldCover = await client.query<BindingRow>(`SELECT cover_asset_id AS asset_id, jsonb_build_object('role','world_cover','worldId',id) AS binding
      FROM worlds WHERE id=$2 AND owner_user_id=$1 AND cover_asset_id IS NOT NULL`, [ownerUserId, worldId]);
  const generationContexts = await client.query<BindingRow>(`SELECT c.asset_id, jsonb_build_object('role','generation_context','campaignId',c.campaign_id,'worldId',c.world_id,'worldVersionId',c.world_version_id,'turnId',c.turn_id,'sourceContextId',c.id) AS binding
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
       AND (c.turn_id IS NULL OR t.id IS NOT NULL) AND c.asset_id IS NOT NULL`, [ownerUserId, campaignId, worldVersionId, worldId]);
  const turnPointers = await client.query<{ id: string; image_url: string }>(
      "SELECT id,image_url FROM turns WHERE owner_user_id=$1 AND campaign_id=$2 AND image_url <> '' ORDER BY id",
      [ownerUserId, campaignId],
    );
  const pinnedVersion = await client.query<{ content: unknown }>(
      "SELECT content FROM world_versions WHERE id=$1 AND world_id=$2 AND owner_user_id=$3",
      [worldVersionId, worldId, ownerUserId],
    );
  const bindings = new Map<string, ArchiveAssetBinding[]>();
  const add = (assetId: string, binding: ArchiveAssetBinding) => {
    const current = bindings.get(assetId) ?? [];
    if (!current.some((candidate) => bindingKey(candidate) === bindingKey(binding))) current.push(binding);
    bindings.set(assetId, current);
  };
  for (const result of [references, segmentAssets, worldCover, generationContexts]) {
    for (const row of result.rows) add(row.asset_id, row.binding);
  }
  for (const job of imageJobs.rows) {
    add(job.asset_id, job.target_type === "turn_illustration"
      ? { role: "turn_illustration", campaignId: job.campaign_id, turnId: job.turn_id! }
      : { role: "campaign_asset", campaignId: job.campaign_id });
  }
  const addPointer = (value: unknown, binding: ArchiveAssetBinding) => {
    if (typeof value !== "string") return;
    const assetId = legacyAssetPointer.exec(value)?.[1];
    if (assetId) add(assetId, binding);
  };
  for (const turn of turnPointers.rows) addPointer(turn.image_url, { role: "turn_illustration", campaignId, turnId: turn.id });
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) return void value.forEach(visit);
    if (value && typeof value === "object") return void Object.values(value).forEach(visit);
    addPointer(value, { role: "world_version_asset", worldId, worldVersionId });
  };
  visit(pinnedVersion.rows[0]?.content);
  const assetIds = [...bindings.keys()];
  if (assetIds.length === 0) return { records: [], uniqueOriginals: [] };
  const assets = await client.query<AssetSourceRow>(`SELECT a.id,a.content_hash,a.mime_type,a.byte_length,a.pixel_width,a.pixel_height,a.technical_metadata,a.created_at,
      l.title,l.caption,l.notes,l.tags,l.origin,l.review_status,l.reuse_scope,l.automatic_reuse_enabled,l.content_categories,l.favorite,l.archived_at
    FROM assets a JOIN asset_library_entries l ON l.asset_id=a.id AND l.owner_user_id=a.owner_user_id
   WHERE a.owner_user_id=$1 AND a.id=ANY($2::uuid[]) ORDER BY a.id`, [ownerUserId, assetIds]);
  const found = new Set(assets.rows.map((asset) => asset.id));
  const missing = assetIds.filter((assetId) => !found.has(assetId)).sort();
  if (missing.length > 0) throw Object.assign(new Error("Required archive assets are missing."), { code: "archive-asset-missing", assetIds: missing });
  const records = assets.rows.map((asset) => archiveAssetRecordSchema.parse({
    sourceAssetId: asset.id,
    contentHash: asset.content_hash,
    archivePath: `assets/sha256/${asset.content_hash.slice(0, 2)}/${asset.content_hash}${imageExtension(asset.mime_type)}`,
    mimeType: asset.mime_type,
    byteLength: Number(asset.byte_length),
    pixelWidth: asset.pixel_width,
    pixelHeight: asset.pixel_height,
    technicalMetadata: sanitizePortableMetadata(asset.technical_metadata ?? {}),
    library: {
      title: asset.title ?? "", caption: asset.caption ?? "", notes: asset.notes ?? "", tags: asset.tags ?? [],
      origin: asset.origin, reviewStatus: asset.review_status, reuseScope: asset.reuse_scope,
      automaticReuseEnabled: asset.automatic_reuse_enabled, contentCategories: asset.content_categories ?? [],
      favorite: asset.favorite, archivedAt: asset.archived_at === null ? null : iso(asset.archived_at),
    },
    createdAt: iso(asset.created_at),
    bindings: [...(bindings.get(asset.id) ?? [])].sort((left, right) => bindingKey(left).localeCompare(bindingKey(right))),
  })).sort((left, right) => left.sourceAssetId.localeCompare(right.sourceAssetId));
  const grouped = new Map<string, CampaignArchiveExportAssetInventory["uniqueOriginals"][number] & { sourceAssetIds: string[] }>();
  for (const record of records) {
    const current = grouped.get(record.contentHash);
    if (current) {
      current.sourceAssetIds.push(record.sourceAssetId);
      if (current.mimeType !== record.mimeType || current.byteLength !== record.byteLength
        || current.archivePath !== record.archivePath || current.pixelWidth !== record.pixelWidth
        || current.pixelHeight !== record.pixelHeight) throw exportError("Assets with one content identity have inconsistent metadata.");
    } else {
      grouped.set(record.contentHash, {
        contentHash: record.contentHash, archivePath: record.archivePath, sourceAssetIds: [record.sourceAssetId],
        mimeType: record.mimeType, byteLength: record.byteLength, pixelWidth: record.pixelWidth, pixelHeight: record.pixelHeight,
      });
    }
  }
  return { records, uniqueOriginals: [...grouped.values()].sort((left, right) => left.contentHash.localeCompare(right.contentHash)) };
}

export async function loadCampaignArchiveExportSnapshot(
  pool: DatabasePool,
  ownerUserId: string,
  campaignId: string,
): Promise<CampaignArchiveExportSnapshot> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const campaign = (await client.query<SnapshotCampaign>(`SELECT c.*,w.id AS world_id,w.title AS world_title,wv.version_number,wv.content,cs.*,cs.revision AS state_revision
      FROM campaigns c JOIN world_versions wv ON wv.id=c.world_version_id AND wv.owner_user_id=c.owner_user_id
      JOIN worlds w ON w.id=wv.world_id AND w.owner_user_id=c.owner_user_id
      JOIN campaign_state cs ON cs.campaign_id=c.id AND cs.owner_user_id=c.owner_user_id
     WHERE c.id=$1 AND c.owner_user_id=$2`, [campaignId, ownerUserId])).rows[0];
    if (!campaign) throw Object.assign(new Error("Campaign not found."), { statusCode: 404, expose: true });
    const turns = (await client.query<Record<string, any>>(`SELECT id,turn_number,action,input_mode,input_mode_source,narration,choices,custom_action_suggestion,image_prompt,image_url,
      mechanics_private,state_snapshot_private,model_metadata,accepted_at FROM turns
      WHERE campaign_id=$1 AND owner_user_id=$2 AND accepted_at IS NOT NULL ORDER BY turn_number`, [campaignId, ownerUserId])).rows;
    if (Number(turns.at(-1)?.turn_number ?? 0) !== Number(campaign.active_turn_number)) {
      throw exportError("Accepted turns do not match the campaign active turn number.");
    }
    const values = [ownerUserId, campaignId] as const;
    const profileEdits = await queryRows(client, "SELECT id,revision,previous_profile,next_profile,edit_source,created_at FROM campaign_character_profile_edits WHERE owner_user_id=$1 AND campaign_id=$2 ORDER BY revision", values);
    const stateEdits = await queryRows(client, "SELECT id,effective_turn_number,revision,state_snapshot_private,changed_fields,created_at FROM campaign_state_edits WHERE owner_user_id=$1 AND campaign_id=$2 ORDER BY revision", values);
    const narrationCorrections = await queryRows(client, `SELECT id,turn_id,revision,narration,
      previous_effective_narration_hash,reason,source,created_at
      FROM turn_narration_corrections WHERE owner_user_id=$1 AND campaign_id=$2
      ORDER BY turn_id,revision`, values);
    const migrations = await queryRows(client, "SELECT id,from_world_version_id,to_world_version_id,note,created_at FROM campaign_world_migrations WHERE owner_user_id=$1 AND campaign_id=$2 ORDER BY created_at,id", values);
    const illustrationConfigs = await queryRows(client, "SELECT enabled,source_policy,matching_scope,confidence_profile,repetition_window,model,size,aspect_ratio,quality,output_format,max_attempts,segment_word_count,images_per_segment,segment_prompt_mode,refinement_prompt,created_at,updated_at FROM campaign_illustration_configs WHERE owner_user_id=$1 AND campaign_id=$2", values);
    const illustrationSets = await queryRows(client, "SELECT id,turn_id,source_text_hash,segment_word_count,images_per_segment,prompt_mode,status,is_active,character_visual_reference,created_at,completed_at FROM turn_illustration_sets WHERE owner_user_id=$1 AND campaign_id=$2 AND turn_id IS NOT NULL ORDER BY created_at,id", values);
    const illustrationSegments = await queryRows(client, `SELECT seg.id,seg.illustration_set_id,seg.turn_id,seg.ordinal,seg.start_offset,seg.end_offset,seg.start_word,seg.end_word,seg.source_text,seg.source_text_hash,seg.direct_prompt,seg.resolved_prompt,seg.prompt_source,seg.status,seg.created_at,seg.updated_at
        FROM turn_illustration_segments seg JOIN turn_illustration_sets illustration_set ON illustration_set.id=seg.illustration_set_id AND illustration_set.owner_user_id=seg.owner_user_id AND illustration_set.campaign_id=seg.campaign_id AND illustration_set.turn_id=seg.turn_id
       WHERE seg.owner_user_id=$1 AND seg.campaign_id=$2 AND seg.turn_id IS NOT NULL ORDER BY seg.illustration_set_id,seg.ordinal`, values);
    const costs = await queryRows(client, "SELECT id,turn_id,local_call_id,provider_type,category,operation,requested_model,resolved_model,trim(trailing '.' from trim(trailing '0' from amount::text)) AS amount,currency,usage_metadata,occurred_at,created_at FROM provider_cost_events WHERE owner_user_id=$1 AND campaign_id=$2 ORDER BY occurred_at,id", values);
    const memories = await queryRows(client, "SELECT id,turn_id,memory_kind,ordinal,content,token_estimate,importance,entities,entity_ids,metadata,created_at,updated_at FROM chronicle_memories WHERE owner_user_id=$1 AND campaign_id=$2 ORDER BY ordinal,id", values);
    const summaries = await queryRows(client, "SELECT id,summary_kind,through_turn,content,created_at FROM summary_checkpoints WHERE owner_user_id=$1 AND campaign_id=$2 ORDER BY through_turn,id", values);
    const legacy = await client.query<{ content: unknown; through_turn: number }>("SELECT content,through_turn FROM summary_checkpoints WHERE owner_user_id=$1 AND campaign_id=$2 AND summary_kind='legacy_full_history' ORDER BY through_turn DESC,created_at DESC LIMIT 1", [...values]);
    const assets = await collectAssets(client, ownerUserId, campaignId, campaign.world_version_id, campaign.world_id);
    const latestStateRevision = Math.max(0, ...stateEdits.map((edit) => Number((edit as { revision?: unknown }).revision ?? 0)));
    if (latestStateRevision > Number(campaign.state_revision)) throw exportError("Campaign state revision does not match the captured state edit ledger.");
    await client.query("COMMIT");
    return {
      ownerUserId, campaign, turns, profileEdits, stateEdits, narrationCorrections, migrations,
      illustrationConfig: illustrationConfigs[0] ?? null, illustrationSets, illustrationSegments,
      costs, memories, summaries, legacyHistory: legacy.rows[0] ?? null, assets,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
