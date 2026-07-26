import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import type { DatabaseClient, DatabasePool } from "../../../packages/database/src/pool.js";
import { initialOwnerId } from "../../../packages/database/src/pool.js";
import { canonicalizeWorldContent, type WorldContent } from "../../../packages/contracts/src/world-library.js";
import { characterLegacyText } from "../../../packages/domain/src/world-characters.js";
import { calculateContentFingerprint, canonicalArchiveJson, sanitizePortableMetadata, type ArchiveManifest } from "../../../packages/contracts/src/archives.js";
import { removeProviderSecrets, stableStringify } from "../../../packages/domain/src/text.js";
import { collectCampaignArchiveAssets, verifyAndWriteArchiveAssets, type CampaignAssetInventory } from "./asset-archive-service.js";
import { writeArchiveArtifact, type ArchiveLimits, type CompletedArchiveArtifact } from "./archive-io.js";
import { readAsset, type FilesystemAssetStore } from "./asset-service.js";

export type PortableWorldPayload = { canonicalHash: string; sourceWorldId: string; sourceWorldVersionId: string; versionNumber: number; content: unknown };
export type PortableCampaignChronicleV1 = { formatVersion: 1; memories: unknown[]; summaries: unknown[] };
export type CampaignArchiveRecordsV1 = {
  formatVersion: 1;
  characterProfileEdits: unknown[];
  stateEdits: unknown[];
  worldMigrations: unknown[];
  illustrationConfig: unknown | null;
  illustrationSets: unknown[];
  illustrationSegments: unknown[];
  costs: unknown[];
};
export type PortableCampaignV3 = Record<string, unknown>;
export type CampaignArchivePayloads = {
  campaign: PortableCampaignV3 & { archiveRecords: CampaignArchiveRecordsV1 };
  world: PortableWorldPayload;
  chronicle: PortableCampaignChronicleV1;
};
export type CampaignArchiveExportOptions = { assetStore: FilesystemAssetStore; archiveRoot: string; limits: ArchiveLimits };

type SnapshotCampaign = Record<string, any> & { id: string; world_id: string; world_version_id: string; version_number: number; content: WorldContent; revision: number };
export type CampaignArchiveSnapshot = {
  ownerUserId: string;
  campaign: SnapshotCampaign;
  turns: Record<string, any>[];
  profileEdits: unknown[];
  stateEdits: unknown[];
  migrations: unknown[];
  illustrationConfig: unknown | null;
  illustrationSets: unknown[];
  illustrationSegments: unknown[];
  costs: unknown[];
  memories: unknown[];
  summaries: unknown[];
  legacyHistory: { content: unknown; through_turn: number } | null;
  assets: CampaignAssetInventory;
};

function exportError(message: string, statusCode = 409): Error {
  return Object.assign(new Error(message), { code: "archive-export-inconsistent", statusCode });
}

function secretKey(key: string): boolean {
  const normalized = key.replaceAll(/[^a-z0-9]/gi, "").toLowerCase();
  return /(?:apikey|password|authorization|credential|secret|privatekey|encryptionkey|encrypted|accesstoken|refreshtoken|bearertoken|authtag|nonce)/.test(normalized)
    || normalized === "token" || normalized.endsWith("token");
}

function excludedPortableKey(key: string): boolean {
  const normalized = key.replaceAll(/[^a-z0-9]/gi, "").toLowerCase();
  return secretKey(key)
    || /(?:embedding|vector|thumbnail|providerprofile|responsechain|rawresponse)/.test(normalized);
}

function sanitizePortableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizePortableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key]) => !excludedPortableKey(key))
    .map(([key, child]) => [key, sanitizePortableValue(child)]));
}

function portableSettings(value: Record<string, unknown> | undefined): Record<string, unknown> {
  return sanitizePortableValue(removeProviderSecrets(value)) as Record<string, unknown>;
}

function portableModelMetadata(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const source = value as Record<string, unknown>;
  return Object.fromEntries(["providerType", "model", "promptProtocolVersion"].flatMap((key) => (
    typeof source[key] === "string" && source[key] ? [[key, source[key]]] : []
  )));
}

function sanitizeWorldValue(value: unknown): unknown {
  return sanitizePortableValue(value);
}

function iso(value: unknown): unknown {
  return value instanceof Date ? value.toISOString() : value;
}

function portableRow(row: Record<string, unknown>, excluded: readonly string[] = []): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  const excludedKeys = new Set([...excluded, "owner_user_id", "provider_profile_id", "embedding", "response_metadata", "provider_response_id", "response_id", "lease_owner", "lease_expires_at"]);
  for (const [key, value] of Object.entries(row)) {
    if (!excludedKeys.has(key)) output[key] = sanitizePortableValue(sanitizePortableMetadata(iso(value)));
  }
  return output;
}

async function queryRows(client: DatabaseClient, sql: string, values: unknown[]): Promise<unknown[]> {
  return (await client.query<Record<string, unknown>>(sql, values)).rows.map((row) => portableRow(row));
}

export async function captureCampaignArchiveSnapshot(pool: DatabasePool, campaignId: string): Promise<CampaignArchiveSnapshot> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const ownerUserId = await initialOwnerId(client);
    const campaignResult = await client.query<SnapshotCampaign>(
      `SELECT c.*, w.id AS world_id, w.title AS world_title, wv.version_number, wv.content, cs.*, cs.revision AS state_revision
         FROM campaigns c
         JOIN world_versions wv ON wv.id=c.world_version_id AND wv.owner_user_id=c.owner_user_id
         JOIN worlds w ON w.id=wv.world_id AND w.owner_user_id=c.owner_user_id
         JOIN campaign_state cs ON cs.campaign_id=c.id AND cs.owner_user_id=c.owner_user_id
        WHERE c.id=$1 AND c.owner_user_id=$2`,
      [campaignId, ownerUserId]
    );
    const campaign = campaignResult.rows[0];
    if (!campaign) throw Object.assign(new Error("Campaign not found."), { statusCode: 404 });
    const turns = (await client.query<Record<string, any>>(
      `SELECT id,turn_number,action,input_mode,input_mode_source,narration,choices,custom_action_suggestion,image_prompt,image_url,
              mechanics_private,state_snapshot_private,model_metadata,accepted_at
         FROM turns WHERE campaign_id=$1 AND owner_user_id=$2 AND accepted_at IS NOT NULL ORDER BY turn_number`,
      [campaignId, ownerUserId]
    )).rows;
    const maxTurn = turns.at(-1)?.turn_number ?? 0;
    if (Number(maxTurn) !== Number(campaign.active_turn_number)) throw exportError("Accepted turns do not match the campaign active turn number.");
    const values = [ownerUserId, campaignId];
    const [profileEdits, stateEdits, migrations, illustrationConfigRows, illustrationSets, illustrationSegments, costs, memories, summaries] = await Promise.all([
      queryRows(client, "SELECT id,revision,previous_profile,next_profile,edit_source,created_at FROM campaign_character_profile_edits WHERE owner_user_id=$1 AND campaign_id=$2 ORDER BY revision", values),
      queryRows(client, "SELECT id,effective_turn_number,revision,state_snapshot_private,changed_fields,created_at FROM campaign_state_edits WHERE owner_user_id=$1 AND campaign_id=$2 ORDER BY revision", values),
      queryRows(client, "SELECT id,from_world_version_id,to_world_version_id,note,created_at FROM campaign_world_migrations WHERE owner_user_id=$1 AND campaign_id=$2 ORDER BY created_at,id", values),
      queryRows(client, "SELECT enabled,model,size,aspect_ratio,quality,output_format,max_attempts,segment_word_count,images_per_segment,segment_prompt_mode,created_at,updated_at FROM campaign_illustration_configs WHERE owner_user_id=$1 AND campaign_id=$2", values),
      queryRows(client, "SELECT id,turn_id,source_text_hash,segment_word_count,images_per_segment,prompt_mode,status,is_active,character_visual_reference,created_at,completed_at FROM turn_illustration_sets WHERE owner_user_id=$1 AND campaign_id=$2 ORDER BY created_at,id", values),
      queryRows(client, "SELECT id,illustration_set_id,turn_id,ordinal,start_offset,end_offset,start_word,end_word,source_text,source_text_hash,direct_prompt,resolved_prompt,prompt_source,status,created_at,updated_at FROM turn_illustration_segments WHERE owner_user_id=$1 AND campaign_id=$2 ORDER BY illustration_set_id,ordinal", values),
      queryRows(client, "SELECT id,turn_id,local_call_id,provider_type,category,operation,requested_model,resolved_model,amount::text,currency,usage_metadata,occurred_at,created_at FROM provider_cost_events WHERE owner_user_id=$1 AND campaign_id=$2 ORDER BY occurred_at,id", values),
      queryRows(client, "SELECT id,turn_id,memory_kind,ordinal,content,token_estimate,importance,entities,entity_ids,metadata,created_at,updated_at FROM chronicle_memories WHERE owner_user_id=$1 AND campaign_id=$2 ORDER BY ordinal,id", values),
      queryRows(client, "SELECT id,summary_kind,through_turn,content,created_at FROM summary_checkpoints WHERE owner_user_id=$1 AND campaign_id=$2 ORDER BY through_turn,id", values)
    ]);
    const legacy = await client.query<{ content: unknown; through_turn: number }>(
      "SELECT content,through_turn FROM summary_checkpoints WHERE owner_user_id=$1 AND campaign_id=$2 AND summary_kind='legacy_full_history' ORDER BY through_turn DESC,created_at DESC LIMIT 1", values
    );
    const latestStateRevision = Math.max(0, ...stateEdits.map((edit) => Number((edit as { revision?: unknown }).revision || 0)));
    if (latestStateRevision !== Number(campaign.state_revision)) {
      throw exportError("Campaign state revision does not match the captured state edit ledger.");
    }
    const assets = await collectCampaignArchiveAssets(client, ownerUserId, campaignId, campaign.world_version_id, campaign.world_id);
    await client.query("COMMIT");
    return { ownerUserId, campaign, turns, profileEdits, stateEdits, migrations, illustrationConfig: illustrationConfigRows[0] ?? null, illustrationSets, illustrationSegments, costs, memories, summaries, legacyHistory: legacy.rows[0] ?? null, assets };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function legacyPayload(snapshot: CampaignArchiveSnapshot, exportedAt = new Date().toISOString()): Record<string, unknown> {
  const row = snapshot.campaign;
  const content = canonicalizeWorldContent(sanitizeWorldValue(row.content) as WorldContent);
  const sourceWorld = content.world && typeof content.world === "object" ? content.world : {};
  const { character: _storedCharacter, ...worldWithoutStoredCharacter } = sourceWorld as Record<string, unknown>;
  const profile = row.character_profile as Record<string, unknown> | null;
  const selectedCharacterText = characterLegacyText(row.character_profile, row.character_snapshot);
  return sanitizePortableValue({
    format: "infinite-quest-campaign", formatVersion: 3, exportedAt,
    campaign: { title: row.title, sourceCampaignId: row.id, sourceWorldVersionId: row.world_version_id, sourceWorldVersionNumber: row.version_number, selectedCharacterId: row.selected_character_id ?? null, characterSnapshot: row.character_snapshot ?? null, characterProfile: row.character_profile ?? null, characterProfileRevision: Number(row.character_profile_revision || 0), stateRevision: Number(row.revision || 0) },
    world: { ...worldWithoutStoredCharacter, ...(selectedCharacterText ? { character: selectedCharacterText } : {}) },
    settings: { ...portableSettings(row.legacy_settings), storyLength: row.story_length_profile, turnControlStyle: row.turn_control_style },
    turns: snapshot.turns.map((turn) => ({ id: turn.id, turnNumber: turn.turn_number, action: turn.action, inputMode: turn.input_mode || "action", inputModeSource: turn.input_mode_source || "explicit", narration: turn.narration, choices: turn.choices, customActionSuggestion: turn.custom_action_suggestion, imagePrompt: turn.image_prompt, imageUrl: turn.image_url, roll: turn.mechanics_private, worldStateSnapshot: turn.state_snapshot_private, llmModelInfo: portableModelMetadata(turn.model_metadata), createdAt: iso(turn.accepted_at) })),
    rpgStats: row.rpg_stats, defaultTriggers: row.default_triggers, eventTriggers: row.event_triggers, pendingEventTriggers: row.pending_event_triggers, trackers: row.trackers, baseTrackersAtStart: row.default_triggers, scratchpad: row.scratchpad_private,
    ...(snapshot.legacyHistory ? { fullHistory: snapshot.legacyHistory.content, fullHistoryCompressedThroughTurn: snapshot.legacyHistory.through_turn } : {}),
    worldImportProvenance: row.import_provenance?.world ?? null,
    storyImportProvenance: { ...(row.import_provenance?.story ?? {}), sourceType: "nexus_campaign_export", worldVersionId: row.world_version_id, worldVersionNumber: row.version_number, selectedCharacterId: row.selected_character_id ?? null, selectedCharacterName: profile?.name ?? row.character_snapshot?.name ?? null }
  }) as Record<string, unknown>;
}

function payloads(snapshot: CampaignArchiveSnapshot): CampaignArchivePayloads {
  const legacy = legacyPayload(snapshot, String(iso(snapshot.campaign.updated_at)));
  const content = canonicalizeWorldContent(sanitizeWorldValue(snapshot.campaign.content) as WorldContent);
  const canonicalHash = createHash("sha256").update(stableStringify(content)).digest("hex");
  const world: PortableWorldPayload = { canonicalHash, sourceWorldId: snapshot.campaign.world_id, sourceWorldVersionId: snapshot.campaign.world_version_id, versionNumber: Number(snapshot.campaign.version_number), content };
  const records: CampaignArchiveRecordsV1 = { formatVersion: 1, characterProfileEdits: snapshot.profileEdits, stateEdits: snapshot.stateEdits, worldMigrations: snapshot.migrations, illustrationConfig: snapshot.illustrationConfig, illustrationSets: snapshot.illustrationSets, illustrationSegments: snapshot.illustrationSegments, costs: snapshot.costs };
  const campaign = { ...legacy, world: { canonicalHash, sourceWorldId: world.sourceWorldId, sourceWorldVersionId: world.sourceWorldVersionId }, archiveRecords: records };
  return { campaign, world, chronicle: { formatVersion: 1, memories: snapshot.memories, summaries: snapshot.summaries } };
}

export async function exportCampaign(pool: DatabasePool, campaignId: string, options?: null): Promise<Record<string, any>>;
export async function exportCampaign(pool: DatabasePool, campaignId: string, options: CampaignArchiveExportOptions): Promise<CompletedArchiveArtifact>;
export async function exportCampaign(pool: DatabasePool, campaignId: string, options: CampaignArchiveExportOptions | null = null): Promise<Record<string, any> | CompletedArchiveArtifact> {
  const snapshot = await captureCampaignArchiveSnapshot(pool, campaignId);
  if (!options) return legacyPayload(snapshot);
  const projected = payloads(snapshot);
  const stagingParent = resolve(options.archiveRoot, "staging");
  await mkdir(stagingParent, { recursive: true });
  const assetStagingRoot = await mkdtemp(join(stagingParent, "campaign-export-"));
  try {
    const assetEntries = await verifyAndWriteArchiveAssets({
      records: snapshot.assets.records,
      outputRoot: assetStagingRoot,
      readOriginal: async (assetId) => (await readAsset(pool, options.assetStore, snapshot.ownerUserId, assetId)).bytes
    });
    const jsonEntries = [
      ["campaign.json", "campaign", projected.campaign],
      ["world.json", "world", projected.world],
      ["chronicle.json", "chronicle", projected.chronicle],
      ["assets/assets.json", "assets", { formatVersion: 1, assets: snapshot.assets.records }]
    ] as const;
    return await writeArchiveArtifact(options.archiveRoot, [
      ...jsonEntries.map(([path, logicalType, value]) => ({ path, logicalType, mediaType: "application/json", source: Readable.from(Buffer.from(canonicalArchiveJson(value), "utf8")) })),
      ...assetEntries.map((entry) => ({ path: entry.path, logicalType: entry.logicalType, mediaType: entry.mediaType, source: createReadStream(resolve(assetStagingRoot, entry.path)) }))
    ], (entries) => {
      const payloadHashes = entries.filter((entry) => entry.mediaType === "application/json").map((entry) => entry.sha256);
      return {
        format: "infinite-quest-archive", formatVersion: 1, archiveType: "campaign", createdAt: new Date().toISOString(),
        contentFingerprint: calculateContentFingerprint({ payloadHashes, originalAssetHashes: snapshot.assets.uniqueOriginals.map((asset) => asset.contentHash) }),
        campaignId: snapshot.campaign.id, worldId: snapshot.campaign.world_id, worldVersionId: snapshot.campaign.world_version_id,
        entries: [...entries],
        payloads: jsonEntries.map(([path, kind]) => ({ kind, path, formatVersion: kind === "campaign" ? 3 : 1 })),
        assets: snapshot.assets.records
      } satisfies ArchiveManifest;
    }, options.limits);
  } finally {
    await rm(assetStagingRoot, { recursive: true, force: true });
  }
}
