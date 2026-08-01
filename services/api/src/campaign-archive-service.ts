import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { resolve } from "node:path";
import { Readable } from "node:stream";
import { z } from "zod";
import type { DatabaseClient, DatabasePool } from "../../../packages/database/src/pool.js";
import { initialOwnerId, withTransaction } from "../../../packages/database/src/pool.js";
import type { RuntimeConfig } from "../../../packages/database/src/config.js";
import { canonicalizeWorldContent, WORLD_CONTENT_SCHEMA_VERSION, type WorldContent } from "../../../packages/contracts/src/world-library.js";
import { characterLegacyText } from "../../../packages/domain/src/world-characters.js";
import { archiveAssetRecordSchema, canonicalArchiveJson, campaignArchiveDestinationSchema, campaignArchivePreviewResponseSchema, sanitizePortableMetadata, type ArchiveAssetBinding, type ArchiveAssetRecord, type ArchiveEntry, type ArchiveManifest, type CampaignArchiveDestination as ContractCampaignArchiveDestination, type CampaignArchivePreviewResponse } from "../../../packages/contracts/src/archives.js";
import { calculateContentFingerprint } from "../../../packages/contracts/src/archives-node.js";
import { removeProviderSecrets, sha256, stableStringify } from "../../../packages/domain/src/text.js";
import { collectCampaignArchiveAssets, validateArchiveAssets, verifyAndWriteArchiveAssets, type CampaignAssetInventory, type ValidatedArchiveAssetSet } from "./asset-archive-service.js";
import { ArchiveError, createArchiveStagingDirectory, inspectArchive, inspectArchiveContainer, readVerifiedContainerEntry, readVerifiedEntry, removeArchivePath, writeArchiveArtifact, type ArchiveLimits, type CompletedArchiveArtifact, type InspectedArchive, type StagedArchive } from "./archive-io.js";
import { imageExtensionForMimeType, readAsset, verifyOriginalImage, type FilesystemAssetStore } from "./asset-service.js";

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
export type CampaignArchiveDestination = ContractCampaignArchiveDestination;
export type CampaignArchivePreview = CampaignArchivePreviewResponse;
export type DecodedCampaignArchive = {
  inspected: InspectedArchive;
  campaign: PortableCampaignV3 & { archiveRecords: CampaignArchiveRecordsV1 };
  world: PortableWorldPayload;
  chronicle: PortableCampaignChronicleV1;
  assets: ValidatedAssetArchive;
  contentFingerprint: string;
  warnings: string[];
};
export type ValidatedAssetArchive = ValidatedArchiveAssetSet;
export type ArchiveCleanupLogger = {
  warn(bindings: Record<string, unknown>, message: string): void;
};
export type ArchivePreviewCleanupResult = {
  expiredCount: number;
  cleanupFailureCount: number;
};

const migrationHistoryCompatibilityWarning = "Migration history references source world versions not included in this Campaign Archive; those audit rows will not be recreated.";
const transientIllustrationCompatibilityWarning = (setCount: number, segmentCount: number) =>
  `Ignored ${setCount} turnless illustration ${setCount === 1 ? "set" : "sets"} and ${segmentCount} turnless illustration ${segmentCount === 1 ? "segment" : "segments"} because provisional illustration work is not portable.`;

const APPLICATION_VERSION = process.env.APP_VERSION?.trim() || process.env.npm_package_version?.trim() || "0.1.0";
const campaignPayloadSchema = z.object({ world: z.unknown(), turns: z.array(z.unknown()) }).passthrough();
const campaignAssetPayloadSchema = z.object({
  formatVersion: z.literal(1),
  assets: z.array(archiveAssetRecordSchema)
}).strict();

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
    || /^(?:baseurl|endpoint|customendpoint|lmstudioendpoint|imageendpoint|providerurl)$/.test(normalized)
    || /^nexus(?:provider|imageprovider|embeddingprovider)/.test(normalized)
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

function portableWorldContent(value: unknown): WorldContent {
  return canonicalizeWorldContent(sanitizeWorldValue(value) as WorldContent);
}

function portableLegacyWorldContent(campaign: Record<string, unknown>): WorldContent {
  const source = archiveObject(campaign.world);
  if (source.world && typeof source.world === "object" && !Array.isArray(source.world)) {
    return portableWorldContent(source);
  }
  const title = typeof source.title === "string" && source.title.trim()
    ? source.title.trim()
    : "Imported adventure";
  const characterText = typeof source.character === "string" ? source.character.trim() : "";
  const characterName = characterText.split(/\r?\n/).find((line) => line.trim())?.trim() || "Default character";
  const world: Record<string, unknown> = { ...source, title };
  delete world.character;
  return portableWorldContent({
    schemaVersion: WORLD_CONTENT_SCHEMA_VERSION,
    world,
    playableCharacters: [{
      id: `legacy-import-character-${sha256(stableStringify({
        characterText,
        rpgStats: campaign.rpgStats ?? [],
        defaultTriggers: campaign.defaultTriggers ?? campaign.baseTrackersAtStart ?? []
      })).slice(0, 24)}`,
      name: characterName.slice(0, 200),
      characterText,
      rpgStats: campaign.rpgStats ?? [],
      defaultTriggers: campaign.defaultTriggers ?? campaign.baseTrackersAtStart ?? [],
      source: { type: "legacy-campaign-import" }
    }],
    rpgStats: [],
    defaultTriggers: [],
    eventTriggers: campaign.eventTriggers ?? [],
    importedFromLegacyStory: true
  });
}

/** Matches the canonical world representation written to Campaign Archives. */
export function portableWorldContentHash(value: unknown): string {
  return sha256(stableStringify(portableWorldContent(value)));
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
      queryRows(client, "SELECT enabled,source_policy,matching_scope,confidence_profile,repetition_window,model,size,aspect_ratio,quality,output_format,max_attempts,segment_word_count,images_per_segment,segment_prompt_mode,refinement_prompt,created_at,updated_at FROM campaign_illustration_configs WHERE owner_user_id=$1 AND campaign_id=$2", values),
      queryRows(client, "SELECT id,turn_id,source_text_hash,segment_word_count,images_per_segment,prompt_mode,status,is_active,character_visual_reference,created_at,completed_at FROM turn_illustration_sets WHERE owner_user_id=$1 AND campaign_id=$2 AND turn_id IS NOT NULL ORDER BY created_at,id", values),
      queryRows(client, `SELECT seg.id,seg.illustration_set_id,seg.turn_id,seg.ordinal,seg.start_offset,seg.end_offset,seg.start_word,seg.end_word,
                               seg.source_text,seg.source_text_hash,seg.direct_prompt,seg.resolved_prompt,seg.prompt_source,seg.status,seg.created_at,seg.updated_at
                          FROM turn_illustration_segments seg
                          JOIN turn_illustration_sets illustration_set
                            ON illustration_set.id=seg.illustration_set_id
                           AND illustration_set.owner_user_id=seg.owner_user_id
                           AND illustration_set.campaign_id=seg.campaign_id
                           AND illustration_set.turn_id=seg.turn_id
                         WHERE seg.owner_user_id=$1 AND seg.campaign_id=$2 AND seg.turn_id IS NOT NULL
                         ORDER BY seg.illustration_set_id,seg.ordinal`, values),
      queryRows(client, "SELECT id,turn_id,local_call_id,provider_type,category,operation,requested_model,resolved_model,trim(trailing '.' from trim(trailing '0' from amount::text)) AS amount,currency,usage_metadata,occurred_at,created_at FROM provider_cost_events WHERE owner_user_id=$1 AND campaign_id=$2 ORDER BY occurred_at,id", values),
      queryRows(client, "SELECT id,turn_id,memory_kind,ordinal,content,token_estimate,importance,entities,entity_ids,metadata,created_at,updated_at FROM chronicle_memories WHERE owner_user_id=$1 AND campaign_id=$2 ORDER BY ordinal,id", values),
      queryRows(client, "SELECT id,summary_kind,through_turn,content,created_at FROM summary_checkpoints WHERE owner_user_id=$1 AND campaign_id=$2 ORDER BY through_turn,id", values)
    ]);
    const legacy = await client.query<{ content: unknown; through_turn: number }>(
      "SELECT content,through_turn FROM summary_checkpoints WHERE owner_user_id=$1 AND campaign_id=$2 AND summary_kind='legacy_full_history' ORDER BY through_turn DESC,created_at DESC LIMIT 1", values
    );
    const latestStateRevision = Math.max(0, ...stateEdits.map((edit) => Number((edit as { revision?: unknown }).revision || 0)));
    if (latestStateRevision > Number(campaign.state_revision)) {
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
  const content = portableWorldContent(row.content);
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
  const content = portableWorldContent(snapshot.campaign.content);
  const canonicalHash = portableWorldContentHash(snapshot.campaign.content);
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
  const oversizedAssetIds = snapshot.assets.records
    .filter((asset) => asset.byteLength > options.limits.maxOriginalImageBytes)
    .map((asset) => asset.sourceAssetId)
    .sort();
  if (oversizedAssetIds.length) {
    throw new ArchiveError(
      "archive-limit-exceeded",
      "A required original image exceeds the configured export byte limit.",
      400,
      { assetIds: oversizedAssetIds }
    );
  }
  const staging = await createArchiveStagingDirectory(options.archiveRoot, "campaign-export-");
  try {
    const assetEntries = await verifyAndWriteArchiveAssets({
      records: snapshot.assets.records,
      outputRoot: staging.operationPath,
      assertOutputRoot: () => staging.assertStable(),
      readOriginal: async (assetId) => (await readAsset(pool, options.assetStore, snapshot.ownerUserId, assetId)).bytes
    });
    await staging.assertStable();
    const jsonEntries = [
      ["campaign.json", "campaign", projected.campaign],
      ["world.json", "world", projected.world],
      ["chronicle.json", "chronicle", projected.chronicle],
      ["assets/assets.json", "assets", { formatVersion: 1, assets: snapshot.assets.records }]
    ] as const;
    return await writeArchiveArtifact(options.archiveRoot, [
      ...jsonEntries.map(([path, logicalType, value]) => ({ path, logicalType, mediaType: "application/json", source: Readable.from(Buffer.from(canonicalArchiveJson(value), "utf8")) })),
      ...assetEntries.map((entry) => ({ path: entry.path, logicalType: entry.logicalType, mediaType: entry.mediaType, source: createReadStream(resolve(staging.operationPath, entry.path)) }))
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
    await staging.cleanup();
  }
}

function archiveJson(value: Buffer, name: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value.toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    return parsed as Record<string, unknown>;
  } catch {
    throw new ArchiveError("archive-json-invalid", `The ${name} payload is not valid JSON.`);
  }
}

function archiveFingerprint(inspected: InspectedArchive): string {
  return calculateContentFingerprint({
    payloadHashes: inspected.manifest.entries.filter((entry) => entry.mediaType === "application/json").map((entry) => entry.sha256),
    originalAssetHashes: inspected.manifest.assets.map((asset) => asset.contentHash)
  });
}

function previewAppVersion(): string {
  return APPLICATION_VERSION;
}

function cleanupErrorCode(error: unknown): string {
  const code = error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" && code.length <= 80 ? code : "cleanup-failed";
}

function safeCleanupWarning(logger: ArchiveCleanupLogger | undefined, error: unknown, message: string): void {
  try {
    logger?.warn({ errorCode: cleanupErrorCode(error) }, message);
  } catch {
    // Cleanup reporting must never change an already committed lifecycle result.
  }
}

async function removeStagedPreviewPath(
  config: RuntimeConfig,
  stagedPath: string,
  logger?: ArchiveCleanupLogger,
  message = "campaign archive preview staging cleanup failed"
): Promise<boolean> {
  try {
    await removeArchivePath(config.archiveStorageRoot, stagedPath);
    return true;
  } catch (error) {
    safeCleanupWarning(logger, error, message);
    return false;
  }
}

async function cleanupPendingArchivePreviewPaths(
  pool: DatabasePool,
  config: RuntimeConfig,
  ownerUserId: string,
  logger?: ArchiveCleanupLogger,
  previewId?: string
): Promise<number> {
  const pending = await pool.query<{ id: string; staged_archive_path: string; status: string }>(
    `SELECT id,staged_archive_path,status
       FROM archive_previews
      WHERE owner_user_id=$1 AND archive_type='campaign'
        AND status IN ('superseded','consumed','expired','failed')
        AND result->>'stagingCleanupPending'='true'
        AND ($2::uuid IS NULL OR id=$2)
      ORDER BY updated_at,id`,
    [ownerUserId, previewId ?? null]
  );
  let cleanupFailureCount = 0;
  for (const row of pending.rows) {
    const activeReference = await pool.query(
      `SELECT 1
         FROM archive_previews
        WHERE owner_user_id=$1 AND archive_type='campaign'
          AND staged_archive_path=$2 AND status='previewed'
        LIMIT 1`,
      [ownerUserId, row.staged_archive_path]
    );
    if (activeReference.rows.length) continue;
    if (!(await removeStagedPreviewPath(config, row.staged_archive_path, logger))) {
      cleanupFailureCount += 1;
      continue;
    }
    await pool.query(
      `UPDATE archive_previews
          SET result=jsonb_set(
                CASE WHEN jsonb_typeof(result)='object' THEN result ELSE '{}'::jsonb END,
                '{stagingCleanupPending}',
                'false'::jsonb,
                true
              ),
              updated_at=now()
        WHERE id=$1 AND owner_user_id=$2 AND archive_type='campaign'
          AND staged_archive_path=$3
          AND status IN ('superseded','consumed','expired','failed')
          AND result->>'stagingCleanupPending'='true'`,
      [row.id, ownerUserId, row.staged_archive_path]
    );
  }
  return cleanupFailureCount;
}

export async function cleanupArchivePreviewStaging(
  pool: DatabasePool,
  config: RuntimeConfig,
  previewId: string,
  logger?: ArchiveCleanupLogger
): Promise<number> {
  const ownerUserId = await initialOwnerId(pool);
  return cleanupPendingArchivePreviewPaths(pool, config, ownerUserId, logger, previewId);
}

export async function cleanupExpiredArchivePreviews(
  pool: DatabasePool,
  config: RuntimeConfig,
  now = new Date(),
  logger?: ArchiveCleanupLogger
): Promise<ArchivePreviewCleanupResult> {
  const ownerUserId = await initialOwnerId(pool);
  const newlyExpired = await pool.query<{ id: string; staged_archive_path: string }>(
    `UPDATE archive_previews
        SET status='expired',
            result=jsonb_set(
              CASE WHEN jsonb_typeof(result)='object' THEN result ELSE '{}'::jsonb END,
              '{stagingCleanupPending}',
              'true'::jsonb,
              true
            ),
            updated_at=now()
      WHERE owner_user_id=$1 AND archive_type='campaign' AND status='previewed' AND expires_at <= $2
    RETURNING id,staged_archive_path`,
    [ownerUserId, now]
  );
  await pool.query(
    `UPDATE archive_previews
        SET result=jsonb_set(
              CASE WHEN jsonb_typeof(result)='object' THEN result ELSE '{}'::jsonb END,
              '{stagingCleanupPending}',
              'true'::jsonb,
              true
            ),
            updated_at=now()
      WHERE owner_user_id=$1 AND archive_type='campaign' AND status='expired'
        AND result->>'stagingCleanupPending' IS NULL`,
    [ownerUserId]
  );
  const cleanupFailureCount = await cleanupPendingArchivePreviewPaths(pool, config, ownerUserId, logger);
  return { expiredCount: newlyExpired.rows.length, cleanupFailureCount };
}

function destinationHash(destination: ContractCampaignArchiveDestination): string {
  return sha256(`campaign-archive-destination-v1\0${canonicalArchiveJson(campaignArchiveDestinationSchema.parse(destination))}`);
}

function rootRelativeStagedPath(staged: StagedArchive): string {
  const path = staged.relativePath.replaceAll("\\", "/");
  if (!path || path.startsWith("/") || /^[A-Za-z]:/.test(path) || path.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new ArchiveError("archive-entry-unsafe", "The staged archive path is not a safe relative path.");
  }
  return path;
}

function selectedCharacter(campaign: Record<string, unknown>): { id: string; name: string } | null {
  const metadata = campaign.campaign && typeof campaign.campaign === "object" ? campaign.campaign as Record<string, unknown> : {};
  const snapshot = metadata.characterSnapshot && typeof metadata.characterSnapshot === "object" ? metadata.characterSnapshot as Record<string, unknown> : null;
  const profile = metadata.characterProfile && typeof metadata.characterProfile === "object" ? metadata.characterProfile as Record<string, unknown> : null;
  const name = typeof snapshot?.name === "string" ? snapshot.name.trim() : typeof profile?.name === "string" ? profile.name.trim() : "";
  const id = typeof metadata.selectedCharacterId === "string" && metadata.selectedCharacterId.trim() ? metadata.selectedCharacterId.trim() : name ? "legacy-default" : "";
  return id && name ? { id, name } : null;
}

function archiveObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function assertPortableTurnReference(
  turnIds: ReadonlySet<string>,
  payload: "campaign" | "chronicle",
  collection: string,
  value: unknown,
  nullable: boolean
): void {
  const row = archiveObject(value);
  if ((nullable && row.turn_id === null) || (typeof row.turn_id === "string" && turnIds.has(row.turn_id))) return;
  const recordId = typeof row.id === "string" ? row.id : undefined;
  const referenceId = typeof row.turn_id === "string" ? row.turn_id : undefined;
  throw new ArchiveError(
    "archive-json-invalid",
    `${payload}.${collection}${recordId ? `[${recordId}]` : ""}.turn_id references a turn not present in campaign.turns.`,
    400,
    {
      payload,
      collection,
      field: "turn_id",
      ...(recordId ? { recordId } : {}),
      ...(referenceId ? { referenceId } : {})
    }
  );
}

function validateCampaignTurnReferences(
  campaign: Record<string, unknown>,
  chronicle: Record<string, unknown>,
  records: Record<string, unknown>
): void {
  const turnIds = new Set(
    (Array.isArray(campaign.turns) ? campaign.turns : [])
      .map((turn) => archiveObject(turn).id)
      .filter((id): id is string => typeof id === "string" && Boolean(id.trim()))
  );
  const collections = [
    { payload: "campaign" as const, name: "archiveRecords.illustrationSets", values: records.illustrationSets, nullable: false },
    { payload: "campaign" as const, name: "archiveRecords.illustrationSegments", values: records.illustrationSegments, nullable: false },
    { payload: "campaign" as const, name: "archiveRecords.costs", values: records.costs, nullable: true },
    { payload: "chronicle" as const, name: "memories", values: chronicle.memories, nullable: true }
  ];
  for (const collection of collections) {
    for (const value of Array.isArray(collection.values) ? collection.values : []) {
      assertPortableTurnReference(turnIds, collection.payload, collection.name, value, collection.nullable);
    }
  }
  const illustrationSetTurns = new Map<string, string>();
  for (const value of Array.isArray(records.illustrationSets) ? records.illustrationSets : []) {
    const set = archiveObject(value);
    if (typeof set.id === "string" && typeof set.turn_id === "string") illustrationSetTurns.set(set.id, set.turn_id);
  }
  for (const value of Array.isArray(records.illustrationSegments) ? records.illustrationSegments : []) {
    const segment = archiveObject(value);
    const recordId = typeof segment.id === "string" ? segment.id : undefined;
    const setId = typeof segment.illustration_set_id === "string" ? segment.illustration_set_id : undefined;
    const setTurnId = setId ? illustrationSetTurns.get(setId) : undefined;
    if (!setTurnId) {
      throw new ArchiveError(
        "archive-json-invalid",
        `campaign.archiveRecords.illustrationSegments${recordId ? `[${recordId}]` : ""}.illustration_set_id references a set not present in archiveRecords.illustrationSets.`,
        400,
        {
          payload: "campaign",
          collection: "archiveRecords.illustrationSegments",
          field: "illustration_set_id",
          ...(recordId ? { recordId } : {}),
          ...(setId ? { referenceId: setId } : {})
        }
      );
    }
    if (segment.turn_id !== setTurnId) {
      throw new ArchiveError(
        "archive-json-invalid",
        `campaign.archiveRecords.illustrationSegments${recordId ? `[${recordId}]` : ""}.turn_id does not match its illustration set.`,
        400,
        {
          payload: "campaign",
          collection: "archiveRecords.illustrationSegments",
          field: "turn_id",
          ...(recordId ? { recordId } : {}),
          ...(typeof segment.turn_id === "string" ? { referenceId: segment.turn_id } : {}),
          expectedReferenceId: setTurnId
        }
      );
    }
  }
}

function normalizePortableIllustrations(records: Record<string, unknown>): {
  records: CampaignArchiveRecordsV1;
  ignoredSetCount: number;
  ignoredSegmentCount: number;
} {
  const sourceSets = Array.isArray(records.illustrationSets) ? records.illustrationSets : [];
  const ignoredSetIds = new Set<string>();
  const illustrationSets = sourceSets.filter((value) => {
    const set = archiveObject(value);
    if (set.turn_id !== null) return true;
    if (typeof set.id === "string") ignoredSetIds.add(set.id);
    return false;
  });
  const sourceSegments = Array.isArray(records.illustrationSegments) ? records.illustrationSegments : [];
  const illustrationSegments = sourceSegments.filter((value) => {
    const segment = archiveObject(value);
    return segment.turn_id !== null
      || typeof segment.illustration_set_id !== "string"
      || !ignoredSetIds.has(segment.illustration_set_id);
  });
  return {
    records: {
      ...records,
      illustrationSets,
      illustrationSegments
    } as CampaignArchiveRecordsV1,
    ignoredSetCount: sourceSets.length - illustrationSets.length,
    ignoredSegmentCount: sourceSegments.length - illustrationSegments.length
  };
}

function worldTitle(content: unknown): string {
  if (!content || typeof content !== "object") return "Imported world";
  const world = (content as Record<string, unknown>).world;
  if (world && typeof world === "object" && typeof (world as Record<string, unknown>).title === "string") return String((world as Record<string, unknown>).title);
  return typeof (content as Record<string, unknown>).title === "string" ? String((content as Record<string, unknown>).title) : "Imported world";
}

async function readCampaignArchive(staged: StagedArchive, limits: ArchiveLimits): Promise<DecodedCampaignArchive> {
  let inspected: InspectedArchive;
  try {
    inspected = await inspectArchive(staged, limits, "campaign");
  } catch (error) {
    if (error instanceof ArchiveError && error.code !== "archive-format-unrecognized" && error.code !== "archive-entry-missing") throw error;
    return adaptLegacyCampaignZip(staged, limits);
  }
  const actualFingerprint = archiveFingerprint(inspected);
  if (actualFingerprint !== inspected.manifest.contentFingerprint) {
    throw new ArchiveError("archive-checksum-mismatch", "The archive content fingerprint does not match its manifest.");
  }
  const campaign = archiveJson(await readVerifiedEntry(inspected, "campaign.json", limits.maxJsonEntryBytes), "campaign");
  const world = archiveJson(await readVerifiedEntry(inspected, "world.json", limits.maxJsonEntryBytes), "world");
  const chronicle = archiveJson(await readVerifiedEntry(inspected, "chronicle.json", limits.maxJsonEntryBytes), "Chronicle");
  const assetPayload = campaignAssetPayloadSchema.safeParse(
    archiveJson(await readVerifiedEntry(inspected, "assets/assets.json", limits.maxJsonEntryBytes), "assets")
  );
  if (!assetPayload.success) {
    throw new ArchiveError("archive-asset-invalid", "The asset metadata payload is invalid.", 400, { payload: "assets" });
  }
  if (canonicalArchiveJson(assetPayload.data.assets) !== canonicalArchiveJson(inspected.manifest.assets)) {
    throw new ArchiveError("archive-asset-invalid", "The asset metadata payload does not match the archive manifest.", 400, { payload: "assets" });
  }
  const campaignParsed = campaignPayloadSchema.safeParse(campaign);
  if (!campaignParsed.success) throw new ArchiveError("archive-json-invalid", "The campaign payload is invalid.", 400, { payload: "campaign" });
  const worldPayload = world as Partial<PortableWorldPayload>;
  if (typeof worldPayload.canonicalHash !== "string" || typeof worldPayload.sourceWorldId !== "string" || typeof worldPayload.sourceWorldVersionId !== "string" || !worldPayload.content) {
    throw new ArchiveError("archive-json-invalid", "The world payload is invalid.", 400, { payload: "world" });
  }
  const canonicalContent = portableWorldContent(worldPayload.content);
  const computedWorldHash = portableWorldContentHash(worldPayload.content);
  if (computedWorldHash !== worldPayload.canonicalHash || (campaign.world as Record<string, unknown> | undefined)?.canonicalHash !== worldPayload.canonicalHash) {
    throw new ArchiveError("archive-world-mismatch", "The campaign and world payloads do not describe the same world version.");
  }
  if (worldPayload.versionNumber === undefined || !Number.isInteger(worldPayload.versionNumber) || Number(worldPayload.versionNumber) < 1) {
    throw new ArchiveError("archive-json-invalid", "The world version number is invalid.");
  }
  if (chronicle.formatVersion !== 1 || !Array.isArray(chronicle.memories) || !Array.isArray(chronicle.summaries)) {
    throw new ArchiveError("archive-json-invalid", "The Chronicle payload is invalid.", 400, { payload: "chronicle" });
  }
  const records = campaign.archiveRecords;
  if (!records || typeof records !== "object" || (records as Record<string, unknown>).formatVersion !== 1) {
    throw new ArchiveError("archive-json-invalid", "The campaign archive records are invalid.", 400, { payload: "campaign" });
  }
  const normalizedIllustrations = normalizePortableIllustrations(records as Record<string, unknown>);
  const normalizedCampaign = {
    ...campaign,
    archiveRecords: normalizedIllustrations.records
  } as PortableCampaignV3 & { archiveRecords: CampaignArchiveRecordsV1 };
  validateCampaignTurnReferences(normalizedCampaign, chronicle, normalizedIllustrations.records);
  const worldMigrations = (records as Record<string, unknown>).worldMigrations;
  const migrationHistoryIsIncomplete = Array.isArray(worldMigrations) && worldMigrations.some((migrationValue) => {
    const migration = archiveObject(migrationValue);
    return [migration.from_world_version_id, migration.to_world_version_id].some(
      (worldVersionId) => worldVersionId !== worldPayload.sourceWorldVersionId
    );
  });
  const assets = await validateArchiveAssets(inspected.manifest, (path) => readVerifiedEntry(inspected, path, limits.maxOriginalImageBytes));
  assertDeclaredPortableAssetPointers(
    normalizedCampaign,
    { ...worldPayload, content: canonicalContent } as PortableWorldPayload,
    inspected.manifest.assets
  );
  return {
    inspected,
    campaign: normalizedCampaign,
    world: { ...worldPayload, content: canonicalContent } as PortableWorldPayload,
    chronicle: chronicle as PortableCampaignChronicleV1,
    assets,
    contentFingerprint: actualFingerprint,
    warnings: [
      ...(migrationHistoryIsIncomplete ? [migrationHistoryCompatibilityWarning] : []),
      ...(normalizedIllustrations.ignoredSetCount || normalizedIllustrations.ignoredSegmentCount
        ? [transientIllustrationCompatibilityWarning(
            normalizedIllustrations.ignoredSetCount,
            normalizedIllustrations.ignoredSegmentCount
          )]
        : [])
    ]
  };
}

function legacyAssetMime(path: string): "image/png" | "image/jpeg" | "image/webp" | "image/gif" {
  const extension = path.toLocaleLowerCase("en-US").split(".").pop();
  if (extension === "png") return "image/png";
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  if (extension === "webp") return "image/webp";
  if (extension === "gif") return "image/gif";
  throw new ArchiveError("archive-asset-invalid", "Legacy campaign archive assets must be PNG, JPEG, WebP, or GIF images.");
}

const portableAssetPointerPattern = /\/api\/v1\/assets\/([0-9a-f-]{36})/gi;

function portableAssetPointers(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap((item) => portableAssetPointers(item));
  if (value && typeof value === "object") return Object.values(value as Record<string, unknown>).flatMap((item) => portableAssetPointers(item));
  return typeof value === "string"
    ? [...value.matchAll(portableAssetPointerPattern)].map((match) => match[1]!)
    : [];
}

function assertDeclaredPortableAssetPointers(
  campaign: PortableCampaignV3 & { archiveRecords: CampaignArchiveRecordsV1 },
  world: PortableWorldPayload,
  assets: readonly ArchiveAssetRecord[]
): void {
  const records = new Map(assets.map((asset) => [asset.sourceAssetId.toLowerCase(), asset]));
  const requireBinding = (sourceAssetId: string, matches: (binding: ArchiveAssetBinding) => boolean): void => {
    const record = records.get(sourceAssetId.toLowerCase());
    if (!record || !record.bindings.some(matches)) {
      throw new ArchiveError("archive-asset-missing", "A portable asset pointer is not declared with a compatible archive binding.", 400, { sourceAssetId });
    }
  };

  for (const sourceAssetId of portableAssetPointers(world.content)) {
    requireBinding(sourceAssetId, (binding) => binding.role === "world_version_asset"
      && binding.worldId === world.sourceWorldId
      && binding.worldVersionId === world.sourceWorldVersionId);
  }
  const sourceCampaignId = typeof archiveObject(campaign.campaign).sourceCampaignId === "string"
    ? String(archiveObject(campaign.campaign).sourceCampaignId)
    : "";
  for (const turnValue of Array.isArray(campaign.turns) ? campaign.turns : []) {
    const turn = archiveObject(turnValue);
    const turnId = typeof turn.id === "string" ? turn.id : "";
    for (const sourceAssetId of portableAssetPointers(turn.imageUrl)) {
      requireBinding(sourceAssetId, (binding) => binding.role === "turn_illustration"
        && binding.campaignId === sourceCampaignId
        && binding.turnId === turnId);
    }
  }
}

export async function adaptLegacyCampaignZip(staged: StagedArchive, limits: ArchiveLimits): Promise<DecodedCampaignArchive> {
  let container;
  try {
    container = await inspectArchiveContainer(staged, limits);
  } catch (error) {
    if (error instanceof ArchiveError) throw error;
    throw new ArchiveError("archive-format-unrecognized", "The uploaded file is not a Campaign Archive or supported legacy campaign ZIP.");
  }
  const containerEntries = [...container.entries.values()];
  const campaignEntries = containerEntries.filter((entry) => entry.path === "campaign.json" || entry.path === "infinite-quest-campaign.json");
  const campaignEntry = campaignEntries[0];
  if (campaignEntries.length !== 1 || !campaignEntry || containerEntries.some((entry) => entry.path !== campaignEntry.path && !/^assets\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(?:png|jpe?g|webp|gif)$/i.test(entry.path))) {
    throw new ArchiveError("archive-format-unrecognized", "Legacy campaign ZIPs may contain only campaign.json and assets/<uuid>.<extension>.");
  }
  let legacyCampaign: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse((await readVerifiedContainerEntry(container, campaignEntry.path, limits.maxJsonEntryBytes)).toString("utf8"));
    const result = campaignPayloadSchema.safeParse(parsed);
    if (!result.success) throw new Error("invalid");
    legacyCampaign = result.data as unknown as Record<string, unknown>;
  } catch {
    throw new ArchiveError("archive-json-invalid", "The legacy campaign JSON payload is invalid.");
  }
  const campaignMetadata = archiveObject(legacyCampaign.campaign);
  const sourceCampaignId = typeof campaignMetadata.sourceCampaignId === "string" ? campaignMetadata.sourceCampaignId : randomUUID();
  const sourceWorldVersionId = typeof campaignMetadata.sourceWorldVersionId === "string" ? campaignMetadata.sourceWorldVersionId : randomUUID();
  const sourceWorldId = randomUUID();
  const content = portableLegacyWorldContent(legacyCampaign);
  const worldHash = portableWorldContentHash(content);
  const normalizedTurns = (Array.isArray(legacyCampaign.turns) ? legacyCampaign.turns : []).map((turnValue) => {
    const turn = archiveObject(turnValue);
    return { ...turn, id: typeof turn.id === "string" && turn.id ? turn.id : randomUUID() };
  });
  const campaign = {
    ...legacyCampaign,
    campaign: { ...campaignMetadata, sourceCampaignId, sourceWorldVersionId },
    turns: normalizedTurns,
    world: { canonicalHash: worldHash, sourceWorldId, sourceWorldVersionId },
    archiveRecords: { formatVersion: 1, characterProfileEdits: [], stateEdits: [], worldMigrations: [], illustrationConfig: null, illustrationSets: [], illustrationSegments: [], costs: [] }
  } as PortableCampaignV3 & { archiveRecords: CampaignArchiveRecordsV1 };
  const chronicle: PortableCampaignChronicleV1 = { formatVersion: 1, memories: [], summaries: [] };
  const entries: ArchiveEntry[] = [];
  const entryBytes = new Map<string, Buffer>();
  const assets = [];
  const legacyTurnBindings = new Map<string, { role: "turn_illustration"; campaignId: string; turnId: string }>();
  for (const turnValue of normalizedTurns) {
    const turn = archiveObject(turnValue);
    const pointer = typeof turn.imageUrl === "string" ? /^\/api\/v1\/assets\/([0-9a-f-]{36})$/i.exec(turn.imageUrl) : null;
    if (pointer && typeof turn.id === "string") legacyTurnBindings.set(pointer[1]!, { role: "turn_illustration", campaignId: sourceCampaignId, turnId: turn.id });
  }
  for (const entry of containerEntries.filter((entry) => entry.path !== campaignEntry.path)) {
    const bytes = await readVerifiedContainerEntry(container, entry.path, limits.maxOriginalImageBytes);
    const mimeType = legacyAssetMime(entry.path);
    const verified = await verifyOriginalImage(bytes, mimeType).catch(() => null);
    if (!verified) throw new ArchiveError("archive-asset-invalid", `Legacy campaign asset '${entry.path}' is not a valid image.`);
    const sourceAssetId = entry.path.split("/").pop()!.split(".")[0]!;
    const contentHash = sha256(bytes.toString("base64"));
    const archivePath = `assets/sha256/${contentHash.slice(0, 2)}/${contentHash}${imageExtensionForMimeType(mimeType)}`;
    entryBytes.set(archivePath, bytes);
    assets.push(archiveAssetRecordSchema.parse({
      sourceAssetId, contentHash, archivePath, mimeType, byteLength: bytes.byteLength, pixelWidth: verified.width, pixelHeight: verified.height,
      technicalMetadata: {}, library: { title: "", caption: "", notes: "", tags: [], origin: "imported", reviewStatus: "unreviewed", reuseScope: "campaign", automaticReuseEnabled: false, contentCategories: [], favorite: false, archivedAt: null },
      createdAt: new Date().toISOString(), bindings: [legacyTurnBindings.get(sourceAssetId) ?? { role: "imported_attachment", campaignId: sourceCampaignId, turnId: null }]
    }));
  }
  const jsonEntries: Array<[string, unknown]> = [["campaign.json", campaign], ["world.json", { canonicalHash: worldHash, sourceWorldId, sourceWorldVersionId, versionNumber: Number(campaignMetadata.sourceWorldVersionNumber || 1), content }], ["chronicle.json", chronicle]];
  for (const [path, value] of jsonEntries) {
    const bytes = Buffer.from(canonicalArchiveJson(value), "utf8");
    entries.push({ path, logicalType: path.slice(0, -5), mediaType: "application/json", byteLength: bytes.byteLength, sha256: sha256(bytes.toString()) });
  }
  for (const asset of assets) entries.push({ path: asset.archivePath, logicalType: "asset-original", mediaType: asset.mimeType, byteLength: asset.byteLength, sha256: asset.contentHash });
  const manifest = {
    format: "infinite-quest-archive", formatVersion: 1, archiveType: "campaign", createdAt: new Date().toISOString(),
    contentFingerprint: calculateContentFingerprint({ payloadHashes: entries.filter((entry) => entry.mediaType === "application/json").map((entry) => entry.sha256), originalAssetHashes: assets.map((asset) => asset.contentHash) }),
    campaignId: sourceCampaignId, worldId: sourceWorldId, worldVersionId: sourceWorldVersionId,
    entries, payloads: jsonEntries.map(([path]) => ({ kind: path === "campaign.json" ? "campaign" : path === "world.json" ? "world" : "chronicle", path, formatVersion: 1 })), assets
  } satisfies ArchiveManifest;
  const inspected: InspectedArchive = { manifest, staged, entries: new Map(entries.map((entry) => [entry.path, { ...entry, compressedBytes: entry.byteLength, uncompressedBytes: entry.byteLength }])), uncompressedBytes: entries.reduce((sum, entry) => sum + entry.byteLength, 0) };
  const validated = await validateArchiveAssets(manifest, async (path) => {
    const bytes = entryBytes.get(path);
    if (!bytes) throw new ArchiveError("archive-entry-missing", `Legacy campaign asset '${path}' is missing.`);
    return bytes;
  });
  const adaptedWorld = { canonicalHash: worldHash, sourceWorldId, sourceWorldVersionId, versionNumber: Number(campaignMetadata.sourceWorldVersionNumber || 1), content };
  assertDeclaredPortableAssetPointers(campaign, adaptedWorld, assets);
  return { inspected, campaign, world: adaptedWorld, chronicle, assets: validated, contentFingerprint: manifest.contentFingerprint, warnings: ["This legacy ZIP had no archive manifest or source checksums; the payload was adapted for compatibility.", "Legacy ZIP image bindings were inferred as campaign attachments; explicit binding guarantees were absent."] };
}

async function findDestination(pool: DatabasePool, ownerUserId: string, archive: DecodedCampaignArchive, destination: ContractCampaignArchiveDestination): Promise<CampaignArchivePreviewResponse["destination"]> {
  const embedded = destination.kind === "embedded";
  if (destination.kind === "existing_world_version") {
    const selected = await pool.query<{ world_id: string; id: string; content: WorldContent }>(
      `SELECT wv.id,wv.world_id,wv.content FROM world_versions wv
         JOIN worlds w ON w.id=wv.world_id AND w.owner_user_id=wv.owner_user_id
        WHERE wv.id=$1 AND wv.owner_user_id=$2`, [destination.worldVersionId, ownerUserId]
    );
    if (!selected.rowCount) throw new ArchiveError("archive-destination-not-empty", "The selected destination world version was not found.", 404);
    if (portableWorldContentHash(selected.rows[0]!.content) !== archive.world.canonicalHash) {
      throw new ArchiveError("archive-world-mismatch", "The selected destination world version does not match the archive world.");
    }
    return { kind: "existing_world_version", operation: "attach_existing_world_version", worldId: selected.rows[0]!.world_id, worldVersionId: selected.rows[0]!.id };
  }
  const candidates = await pool.query<{ world_id: string; world_version_id: string; content: WorldContent }>(
    `SELECT wv.world_id,wv.id AS world_version_id,wv.content FROM world_versions wv
       JOIN worlds w ON w.id=wv.world_id AND w.owner_user_id=wv.owner_user_id
      WHERE wv.owner_user_id=$1 ORDER BY wv.created_at DESC`, [ownerUserId]
  );
  const exact = candidates.rows.find((row) => portableWorldContentHash(row.content) === archive.world.canonicalHash);
  return exact
    ? { kind: "embedded", operation: "reuse_world_version", worldId: exact.world_id, worldVersionId: exact.world_version_id }
    : { kind: "embedded", operation: "create_world", worldId: null, worldVersionId: null };
}

export async function previewCampaignArchive(
  pool: DatabasePool,
  config: RuntimeConfig,
  staged: StagedArchive,
  sourceName: string,
  destination: ContractCampaignArchiveDestination,
  logger?: ArchiveCleanupLogger
): Promise<CampaignArchivePreviewResponse> {
  const parsedDestination = campaignArchiveDestinationSchema.parse(destination);
  const archive = await readCampaignArchive(staged, config.campaignArchiveLimits);
  await cleanupExpiredArchivePreviews(pool, config, new Date(), logger);
  const ownerUserId = await initialOwnerId(pool);
  const boundDestinationHash = destinationHash(parsedDestination);
  const destinationPreview = await findDestination(pool, ownerUserId, archive, parsedDestination);
  const campaignData = archive.campaign.campaign as Record<string, unknown> | undefined;
  const responseBase = {
    valid: true as const,
    archiveType: "campaign" as const,
    formatVersion: 1 as const,
    contentFingerprint: archive.contentFingerprint,
    campaign: {
      title: typeof campaignData?.title === "string" ? campaignData.title : "Imported campaign",
      sourceCampaignId: typeof campaignData?.sourceCampaignId === "string" ? campaignData.sourceCampaignId : archive.inspected.manifest.campaignId!,
      acceptedTurnCount: Array.isArray(archive.campaign.turns) ? archive.campaign.turns.length : 0,
      activeTurnNumber: Array.isArray(archive.campaign.turns) ? Math.max(0, ...archive.campaign.turns.map((turn) => Number((turn as Record<string, unknown>).turnNumber ?? 0))) : 0,
      selectedCharacter: selectedCharacter(archive.campaign)
    },
    world: {
      title: worldTitle(archive.world.content),
      sourceWorldId: archive.world.sourceWorldId,
      sourceWorldVersionId: archive.world.sourceWorldVersionId,
      versionNumber: archive.world.versionNumber
    },
    chronicle: { memoryCount: archive.chronicle.memories.length, summaryCount: archive.chronicle.summaries.length },
    assets: { originalCount: archive.assets.originals.length, totalBytes: archive.assets.originals.reduce((sum, asset) => sum + asset.byteLength, 0) },
    destination: destinationPreview,
    providerDataIncluded: false as const,
    warnings: archive.warnings
  };
  const rawToken = randomBytes(32).toString("base64url");
  const tokenHash = createHash("sha256").update(rawToken, "utf8").digest("hex");
  const expiresAt = new Date(Date.now() + config.archivePreviewTtlSeconds * 1000);
  const preview = { ...responseBase, previewToken: rawToken, expiresAt: expiresAt.toISOString() };
  const storedPreview = { ...preview, previewToken: undefined, stagedCompressedBytes: staged.compressedBytes };
  const stagedPath = rootRelativeStagedPath(staged);
  const supersededPreviewId = await withTransaction(pool, async (client) => {
    const previewScope = `${ownerUserId}:campaign:${archive.contentFingerprint}:${boundDestinationHash}`;
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [previewScope]);
    const superseded = await client.query<{ id: string }>(
      `UPDATE archive_previews
          SET status='superseded',
              result=jsonb_set(
                CASE WHEN jsonb_typeof(result)='object' THEN result ELSE '{}'::jsonb END,
                '{stagingCleanupPending}',
                'true'::jsonb,
                true
              ),
              updated_at=now()
        WHERE owner_user_id=$1 AND archive_type='campaign' AND content_fingerprint=$2
          AND destination_hash=$3 AND status='previewed'
      RETURNING id`,
      [ownerUserId, archive.contentFingerprint, boundDestinationHash]
    );
    await client.query(
      `INSERT INTO archive_previews (
         owner_user_id,archive_type,token_hash,content_fingerprint,destination_hash,application_version,
         staged_archive_path,source_name,preview,status,expires_at
       ) VALUES ($1,'campaign',$2,$3,$4,$5,$6,$7,$8::jsonb,'previewed',$9)`,
      [ownerUserId, tokenHash, archive.contentFingerprint, boundDestinationHash, previewAppVersion(), stagedPath, sourceName, JSON.stringify(storedPreview), expiresAt]
    );
    return superseded.rows[0]?.id ?? null;
  });
  if (supersededPreviewId) {
    await cleanupPendingArchivePreviewPaths(pool, config, ownerUserId, logger, supersededPreviewId)
      .catch((error) => safeCleanupWarning(logger, error, "superseded campaign archive preview staging cleanup failed"));
  }
  return campaignArchivePreviewResponseSchema.parse(preview);
}

export function campaignArchiveApplicationVersion(): string {
  return previewAppVersion();
}

export async function decodeCampaignArchive(staged: StagedArchive, limits: ArchiveLimits): Promise<DecodedCampaignArchive> {
  return readCampaignArchive(staged, limits);
}
