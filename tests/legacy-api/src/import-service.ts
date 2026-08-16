/** Frozen pre-14e3g import regression oracle; never production authority. */
import { randomUUID } from "node:crypto";
import type { DatabaseClient, DatabasePool } from "../../../packages/database/src/pool.js";
import { initialOwnerId, withTransaction } from "../../../packages/database/src/pool.js";
import type { RuntimeConfig } from "../../../packages/database/src/config.js";
import type { LegacyStory, LegacyTurn, StoryImportRequest, StoryImportResult } from "../../../packages/contracts/src/imports.js";
import { campaignArchiveCommitRequestSchema, campaignArchiveDestinationSchema, canonicalArchiveJson, type CampaignArchiveCommitRequest, type CampaignArchiveDestination } from "../../../packages/contracts/src/archives.js";
import { storyLengthProfileFromUnknown } from "../../../packages/contracts/src/story-settings.js";
import { buildTurnFictionMemory, formatLegacySummary, turnNarration } from "../../../packages/story-engine/src/chronicle.js";
import { estimateTokens, removeProviderSecrets, sha256, stableStringify } from "../../../packages/domain/src/text.js";
import { legacyWorldContent } from "../../../packages/domain/src/legacy-story-world.js";
import { campaignCharacterSeed, campaignProfileFromCharacter, characterSnapshot } from "../../../packages/domain/src/world-characters.js";
import { buildScopedEntityCatalog, resolveEntityMetadata } from "../../../packages/domain/src/entity-references.js";
import type { MemoryGenerationTransactionPort } from "../../../packages/application/src/memory/index.js";
import { normalizeCampaignStateSnapshot, normalizeCampaignTrackers } from "../../../packages/domain/src/campaign-trackers.js";
import {
  playableCharacterSchema,
  worldContentSchema,
  type WorldContent
} from "../../../packages/contracts/src/world-library.js";
import { cleanupUnreferencedCreatedPaths, persistArchiveAssets, restoreAssetBindings, type ArchiveIdMap } from "./asset-archive-service.js";
import { detectMimeType, lockOriginalImages, parseDataImage, persistTurnImage, persistWorldCover, importTurnImage, safeExternalImageUrl, type FilesystemAssetStore } from "./asset-service.js";
import { ArchiveError, rehydratePersistedStagedArchive } from "../../../services/api/src/archive-io.js";
import { campaignArchiveApplicationVersion, cleanupArchivePreviewStaging, cleanupExpiredArchivePreviews, decodeCampaignArchive, portableWorldContentHash, type ArchiveCleanupLogger, type DecodedCampaignArchive } from "./campaign-archive-service.js";

export type CampaignArchiveImportResult = {
  importId: string;
  worldId: string;
  worldVersionId: string;
  campaignId: string;
  duplicate: boolean;
  stats: { turnCount: number; memoryCount: number; summaryCount: number; assetCount: number; assetBytes: number };
};

export type LegacyAssetSource = {
  assetIds(): Iterable<string>;
  read(assetId: string): Promise<Buffer | undefined>;
};

type LegacyAssets = Map<string, Buffer> | LegacyAssetSource;

function legacyAssetIds(assets: LegacyAssets): Iterable<string> {
  return assets instanceof Map ? assets.keys() : assets.assetIds();
}

async function readLegacyAsset(assets: LegacyAssets, assetId: string): Promise<Buffer | undefined> {
  return assets instanceof Map ? assets.get(assetId) : assets.read(assetId);
}

function legacyAssetLookupKeys(value: string): string[] {
  const uuid = value.match(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/)?.[0];
  const name = value.split("/").pop()?.split("?")[0];
  const stem = name?.split(".")[0];
  return [...new Set([uuid, name, stem].filter((key): key is string => Boolean(key)))];
}

async function readLegacyAssetUrl(assets: LegacyAssets, value: string): Promise<Buffer | undefined> {
  for (const key of legacyAssetLookupKeys(value)) {
    const bytes = await readLegacyAsset(assets, key);
    if (bytes) return bytes;
  }
  return undefined;
}

type ArchivePreviewRow = {
  id: string;
  owner_user_id: string;
  content_fingerprint: string;
  destination_hash: string;
  application_version: string;
  staged_archive_path: string;
  source_name: string;
  preview: Record<string, unknown>;
  status: "previewed" | "superseded" | "consumed" | "expired" | "failed";
  expires_at: Date | string;
};

const archiveIdKinds = ["world", "worldVersion", "campaign", "turn", "memory", "summary", "profileEdit", "stateEdit", "migration", "transfer", "illustrationSet", "illustrationSegment", "asset", "generationContext"] as const;

function newArchiveIdMap(): ArchiveIdMap {
  return new Map(archiveIdKinds.map((kind) => [kind, new Map<string, string>()]));
}

function mapArchiveId(idMap: ArchiveIdMap, kind: typeof archiveIdKinds[number], source: unknown): string {
  if (typeof source !== "string" || !source.trim()) throw new ArchiveError("archive-json-invalid", `The archive contains an unknown ${kind} reference.`);
  const existing = idMap.get(kind)?.get(source);
  if (existing) return existing;
  const destination = randomUUID();
  idMap.get(kind)!.set(source, destination);
  return destination;
}

function requireMapped(idMap: ArchiveIdMap, kind: typeof archiveIdKinds[number], source: unknown): string {
  if (typeof source !== "string" || !idMap.get(kind)?.has(source)) throw new ArchiveError("archive-json-invalid", `The archive contains an unknown ${kind} reference.`);
  return idMap.get(kind)!.get(source)!;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function jsonValue(value: unknown, fallback: unknown): string {
  return JSON.stringify(value === undefined ? fallback : value);
}

function importedDate(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? null : date.toISOString();
}

function rewriteAssetPointers(value: unknown, assetIds: Map<string, string>): unknown {
  if (Array.isArray(value)) return value.map((item) => rewriteAssetPointers(item, assetIds));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, child]) => [key, rewriteAssetPointers(child, assetIds)]));
  if (typeof value !== "string") return value;
  return value.replaceAll(/\/api\/v1\/assets\/([0-9a-f-]{36})/gi, (_whole, sourceId: string) => {
    const destination = assetIds.get(sourceId) ?? assetIds.get(sourceId.toLowerCase());
    if (!destination) {
      throw new ArchiveError("archive-asset-missing", "A portable asset pointer is not declared by the validated archive.", 400, { sourceAssetId: sourceId });
    }
    return `/api/v1/assets/${destination}`;
  });
}

function campaignArchiveSourceHash(fingerprint: string, destination: CampaignArchiveDestination): string {
  return sha256(`campaign-archive-v1\0${fingerprint}\0${sha256(canonicalArchiveJson(campaignArchiveDestinationSchema.parse(destination)))}`);
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

async function markArchivePreviewFailed(
  pool: DatabasePool,
  previewId: string,
  tokenHash: string,
  stagedPath: string,
  error: unknown,
  logger?: ArchiveCleanupLogger
): Promise<string | null> {
  try {
    const updated = await pool.query<{ id: string }>(
      `UPDATE archive_previews
          SET status='failed',result=$2::jsonb,updated_at=now()
        WHERE id=$1 AND token_hash=$3 AND staged_archive_path=$4 AND status IN ('previewed','expired')
      RETURNING id`,
      [previewId, JSON.stringify({
        error: error instanceof ArchiveError ? error.code : "archive-import-failed",
        stagingCleanupPending: true
      }), tokenHash, stagedPath]
    );
    return updated.rows[0]?.id ?? null;
  } catch (updateError) {
    safeCleanupWarning(logger, updateError, "campaign archive preview failure status update failed");
    return null;
  }
}

type ImportRow = {
  id: string;
  world_id: string | null;
  world_version_id: string | null;
  campaign_id: string | null;
  status: string;
  stats: StoryImportResult["stats"];
};

function json(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function safeDate(value: unknown): Date {
  if (typeof value === "string") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return new Date();
}

async function withOptionalImportStep<T>(
  client: DatabaseClient,
  callback: () => Promise<T>
): Promise<T | null> {
  await client.query("SAVEPOINT optional_import_step");
  try {
    const result = await callback();
    await client.query("RELEASE SAVEPOINT optional_import_step");
    return result;
  } catch {
    await client.query("ROLLBACK TO SAVEPOINT optional_import_step");
    await client.query("RELEASE SAVEPOINT optional_import_step");
    return null;
  }
}

function choices(turn: LegacyTurn): string[] {
  return Array.isArray(turn.choices)
    ? turn.choices.map((choice) => String(choice ?? "").trim()).filter(Boolean).slice(0, 4)
    : [];
}

function worldTitle(story: LegacyStory): string {
  return story.world.title?.trim() || "Imported adventure";
}

function campaignTitle(story: LegacyStory): string {
  return story.campaign?.title?.trim() || worldTitle(story);
}

export { legacyWorldContent };

function sanitizedStoryForHash(story: LegacyStory): Record<string, unknown> {
  const settings = removeProviderSecrets(story.settings);
  delete settings.nexusCampaignId;
  delete settings.nexusCampaignTurnCount;
  delete settings.nexusPendingGeneration;
  delete settings.nexusCampaignWorldVersionId;
  delete settings.nexusBranchWorldVersionId;
  return {
    ...story,
    settings
  };
}

function importSourceHash(request: StoryImportRequest): string {
  return sha256(stableStringify({
    story: sanitizedStoryForHash(request.story),
    targetWorldVersionId: request.targetWorldVersionId ?? null,
    selectedCharacterId: requestedCharacterId(request) ?? null,
    characterStrategy: request.characterStrategy ?? null
  }));
}

function requestedCharacterId(request: StoryImportRequest): string | undefined {
  if (request.selectedCharacterId) return request.selectedCharacterId;
  if (request.story.campaign?.selectedCharacterId) return request.story.campaign.selectedCharacterId;
  const provenance = request.story.storyImportProvenance;
  if (!provenance || typeof provenance !== "object" || Array.isArray(provenance)) return undefined;
  const value = (provenance as Record<string, unknown>).selectedCharacterId;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isPortableCampaign(request: StoryImportRequest): boolean {
  return request.story.format === "infinite-quest-campaign";
}

async function linkImportedTurnIllustration(
  client: DatabaseClient,
  ownerUserId: string,
  campaignId: string,
  turnId: string,
  narration: string,
  imagePrompt: string,
  assetId: string
) {
  const sourceText = narration || "Imported turn illustration";
  const sourceTextHash = sha256(sourceText);
  const prompt = (imagePrompt || narration || "Turn illustration").slice(0, 2000);
  const wordCount = sourceText.trim() ? sourceText.trim().split(/\s+/).length : 0;
  await client.query(
    `INSERT INTO campaign_illustration_configs (
       campaign_id, owner_user_id, source_policy, matching_scope, confidence_profile,
       repetition_window, segment_word_count, images_per_segment, enabled
     ) VALUES ($1, $2, 'library_only', 'campaign', 'balanced', 3, 150, 1, true)
     ON CONFLICT (owner_user_id, campaign_id)
     DO UPDATE SET enabled = true,
                   source_policy = CASE WHEN campaign_illustration_configs.source_policy = 'off' THEN 'library_only' ELSE campaign_illustration_configs.source_policy END,
                   updated_at = now()`,
    [campaignId, ownerUserId]
  );

  const setRes = await client.query<{ id: string }>(
    `INSERT INTO turn_illustration_sets (
       owner_user_id, campaign_id, turn_id, source_text_hash, is_active, status, prompt_mode,
       images_per_segment, segment_word_count, completed_at
     ) VALUES ($1, $2, $3, $4, true, 'completed', 'legacy', 1, 150, now())
     RETURNING id`,
    [ownerUserId, campaignId, turnId, sourceTextHash]
  );
  const setId = setRes.rows[0]?.id;
  if (!setId) return;

  const segRes = await client.query<{ id: string }>(
    `INSERT INTO turn_illustration_segments (
       owner_user_id, campaign_id, turn_id, illustration_set_id, ordinal, start_offset, end_offset,
       start_word, end_word, source_text, source_text_hash, direct_prompt, resolved_prompt, prompt_source, status
     ) VALUES ($1, $2, $3, $4, 0, 0, $5, 0, $6, $7, $8, $9, $9, 'legacy', 'completed')
     RETURNING id`,
    [ownerUserId, campaignId, turnId, setId, sourceText.length, wordCount, sourceText, sourceTextHash, prompt]
  );
  const segmentId = segRes.rows[0]?.id;
  if (!segmentId) return;

  await client.query(
    `INSERT INTO turn_illustration_segment_assets (
       segment_id, owner_user_id, asset_id, variant_index
     ) VALUES ($1, $2, $3, 0)
     ON CONFLICT (segment_id, variant_index)
     DO UPDATE SET asset_id = EXCLUDED.asset_id, created_at = now()`,
    [segmentId, ownerUserId, assetId]
  );
}

function importedCharacterSeed(
  pinnedContent: WorldContent,
  request: StoryImportRequest,
  attachingToExistingWorld: boolean
) {
  const strategy = request.characterStrategy
    ?? (attachingToExistingWorld && isPortableCampaign(request) ? "preserve_source" : "map_to_target");
  if (!attachingToExistingWorld || strategy === "map_to_target") {
    return campaignCharacterSeed(pinnedContent, requestedCharacterId(request));
  }

  const storedSnapshot = request.story.campaign?.characterSnapshot;
  const character = storedSnapshot
    ? playableCharacterSchema.parse(storedSnapshot)
    : legacyWorldContent(request.story, requestedCharacterId(request)).playableCharacters[0];
  if (!character) throw Object.assign(new Error("The portable campaign does not contain a character snapshot to preserve."), { statusCode: 400 });
  return {
    character,
    rpgStats: Array.isArray(character.rpgStats) ? character.rpgStats : [],
    defaultTriggers: Array.isArray(character.defaultTriggers) ? character.defaultTriggers : []
  };
}

function duplicateResult(row: ImportRow): StoryImportResult {
  if (!row.world_id || !row.world_version_id || !row.campaign_id || row.status !== "completed") {
    throw new Error("An import with the same source is already being processed. Try again shortly.");
  }
  return {
    importId: row.id,
    worldId: row.world_id,
    worldVersionId: row.world_version_id,
    campaignId: row.campaign_id,
    duplicate: true,
    stats: row.stats
  };
}

async function existingImport(client: DatabaseClient, ownerUserId: string, sourceHash: string): Promise<ImportRow | null> {
  const result = await client.query<ImportRow>(
    `SELECT id, world_id, world_version_id, campaign_id, status, stats
       FROM imports
      WHERE owner_user_id = $1 AND source_hash = $2`,
    [ownerUserId, sourceHash]
  );
  return result.rows[0] ?? null;
}

function turnIdentity(turn: LegacyTurn): string {
  return stableStringify({
    action: String(turn.action ?? "").trim(),
    narration: turnNarration(turn),
    choices: choices(turn),
    customActionSuggestion: String(turn.customActionSuggestion ?? turn.custom_action_suggestion ?? "").trim(),
    imagePrompt: String(turn.imagePrompt ?? "").trim()
  });
}

function isExplicitCampaignBranch(story: LegacyStory): boolean {
  const provenance = story.storyImportProvenance;
  return Boolean(provenance && typeof provenance === "object" && !Array.isArray(provenance)
    && (provenance as Record<string, unknown>).sourceType === "nexus_campaign_branch");
}

async function reconnectMatchingCampaign(
  client: DatabaseClient,
  ownerUserId: string,
  sourceHash: string,
  request: StoryImportRequest,
  requiredWorldVersionId?: string,
  priorImport?: ImportRow | null
): Promise<StoryImportResult | null> {
  if (isExplicitCampaignBranch(request.story)) return null;
  const candidates = await client.query<{ campaign_id: string; world_version_id: string; world_id: string }>(
    `SELECT c.id AS campaign_id, c.world_version_id, wv.world_id
       FROM campaigns c
       JOIN world_versions wv ON wv.id = c.world_version_id AND wv.owner_user_id = c.owner_user_id
      WHERE c.owner_user_id = $1 AND c.title = $2 AND c.active_turn_number = $3
        AND ($4::uuid IS NULL OR c.world_version_id = $4)
        AND ($5::text IS NULL OR c.selected_character_id = $5)
      ORDER BY (c.id = $6::uuid) DESC, c.updated_at DESC
      FOR SHARE OF c`,
    [ownerUserId, campaignTitle(request.story), request.story.turns.length, requiredWorldVersionId ?? null,
      requestedCharacterId(request) ?? null, priorImport?.campaign_id ?? null]
  );
  const requestedTurns = request.story.turns.map(turnIdentity);
  if (candidates.rows.length === 0) return null;

  const candidateIds = candidates.rows.map(c => c.campaign_id);
  const allStoredTurns = await client.query<{
    campaign_id: string;
    action: string;
    narration: string;
    choices: unknown;
    custom_action_suggestion: string;
    image_prompt: string;
  }>(
    `SELECT campaign_id, action, narration, choices, custom_action_suggestion, image_prompt
       FROM turns WHERE campaign_id = ANY($1::uuid[]) AND owner_user_id = $2 ORDER BY turn_number`,
    [candidateIds, ownerUserId]
  );

  const turnsByCampaign = new Map<string, typeof allStoredTurns.rows>();
  for (const turn of allStoredTurns.rows) {
    let list = turnsByCampaign.get(turn.campaign_id);
    if (!list) {
      list = [];
      turnsByCampaign.set(turn.campaign_id, list);
    }
    list.push(turn);
  }

  for (const candidate of candidates.rows) {
    const storedTurnsRows = turnsByCampaign.get(candidate.campaign_id) ?? [];

    const storedIdentities = storedTurnsRows.map((turn) => turnIdentity({
      action: turn.action,
      narration: turn.narration,
      choices: Array.isArray(turn.choices) ? turn.choices : [],
      customActionSuggestion: turn.custom_action_suggestion,
      imagePrompt: turn.image_prompt
    }));
    if (storedIdentities.length !== requestedTurns.length
      || storedIdentities.some((identity, index) => identity !== requestedTurns[index])) continue;

    const memoryStats = await client.query<{ memory_count: string; sanitized_count: string; imported_summary: boolean }>(
      `SELECT count(*)::text AS memory_count,
              count(*) FILTER (WHERE metadata->>'sanitized' = 'true')::text AS sanitized_count,
              bool_or(memory_kind = 'legacy_summary') AS imported_summary
         FROM chronicle_memories WHERE campaign_id = $1 AND owner_user_id = $2`,
      [candidate.campaign_id, ownerUserId]
    );
    const completeHistoryCharacters = request.story.turns.reduce((total, turn) => (
      total + String(turn.action ?? "").length + turnNarration(turn).length
    ), 0);
    const stats: StoryImportResult["stats"] = {
      turnCount: request.story.turns.length,
      memoryCount: Number(memoryStats.rows[0]?.memory_count || 0),
      completeHistoryCharacters,
      estimatedHistoryTokens: request.story.turns.reduce((total, turn) => (
        total + estimateTokens(`${String(turn.action ?? "")}\n${turnNarration(turn)}`)
      ), 0),
      importedSummary: memoryStats.rows[0]?.imported_summary === true,
      sanitizedMemoryCount: Number(memoryStats.rows[0]?.sanitized_count || 0)
    };
    const reconnect = priorImport
      ? await client.query<{ id: string }>(
        `UPDATE imports SET source_type = 'campaign_reconnect', source_name = $2, status = 'completed',
                world_id = $3, world_version_id = $4, campaign_id = $5, stats = $6, completed_at = now()
          WHERE id = $1 AND owner_user_id = $7 RETURNING id`,
        [priorImport.id, request.sourceName, candidate.world_id, candidate.world_version_id,
          candidate.campaign_id, json(stats), ownerUserId]
      )
      : await client.query<{ id: string }>(
        `INSERT INTO imports (
           owner_user_id, source_type, source_name, source_hash, status,
           world_id, world_version_id, campaign_id, stats, completed_at
         ) VALUES ($1,'campaign_reconnect',$2,$3,'completed',$4,$5,$6,$7,now()) RETURNING id`,
        [ownerUserId, request.sourceName, sourceHash, candidate.world_id, candidate.world_version_id,
          candidate.campaign_id, json(stats)]
      );
    const importId = reconnect.rows[0]?.id;
    if (!importId) throw new Error("Could not record the campaign reconnection.");
    await client.query(
      `INSERT INTO activity_events (owner_user_id, campaign_id, event_type, correlation_id, details)
       VALUES ($1,$2,'campaign_reconnected',$3,$4)`,
      [ownerUserId, candidate.campaign_id, importId, json({ sourceName: request.sourceName, sourceHash, turnCount: stats.turnCount })]
    );
    return {
      importId,
      worldId: candidate.world_id,
      worldVersionId: candidate.world_version_id,
      campaignId: candidate.campaign_id,
      duplicate: true,
      stats
    };
  }
  return null;
}

async function matchingWorldVersion(client: DatabaseClient, ownerUserId: string, story: LegacyStory, selectedCharacterId?: string) {
  const result = await client.query<{ world_id: string; world_version_id: string }>(
    `SELECT world_id, id AS world_version_id
       FROM world_versions
      WHERE owner_user_id = $1 AND content = $2::jsonb
      ORDER BY created_at DESC LIMIT 1`,
    [ownerUserId, json(legacyWorldContent(story, selectedCharacterId))]
  );
  return result.rows[0] ?? null;
}

async function importLegacyStoryWithTransaction(
  transaction: <T>(work: (client: DatabaseClient) => Promise<T>) => Promise<T>,
  request: StoryImportRequest,
  memory: MemoryGenerationTransactionPort,
  assetStore?: FilesystemAssetStore,
  legacyAssets?: LegacyAssets
): Promise<StoryImportResult> {
  const sourceHash = importSourceHash(request);
  return transaction(async (client) => {
    const ownerUserId = await initialOwnerId(client);
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`${ownerUserId}:${sourceHash}`]);
    const prior = await existingImport(client, ownerUserId, sourceHash);

    const requestedTarget = request.targetWorldVersionId
      ? await client.query<{ world_id: string; world_version_id: string }>(
        `SELECT world_id, id AS world_version_id FROM world_versions WHERE id = $1 AND owner_user_id = $2`,
        [request.targetWorldVersionId, ownerUserId]
      )
      : null;
    const existingTarget = requestedTarget?.rows[0] ?? null;
    const reconnected = await reconnectMatchingCampaign(
      client,
      ownerUserId,
      sourceHash,
      request,
      existingTarget?.world_version_id,
      prior
    );
    if (reconnected) return reconnected;
    if (prior) return duplicateResult(prior);

    const importInsert = await client.query<{ id: string }>(
      `INSERT INTO imports (owner_user_id, source_type, source_name, source_hash, status)
       VALUES ($1, $2, $3, $4, 'processing')
       RETURNING id`,
      [ownerUserId, request.targetWorldVersionId ? "infinite_worlds_story_txt" : "legacy_story_json", request.sourceName, sourceHash]
    );
    const importId = importInsert.rows[0]?.id;
    if (!importId) throw new Error("Could not create the import record.");

    let worldId: string;
    let worldVersionId: string;
    if (existingTarget) {
      worldId = existingTarget.world_id;
      worldVersionId = existingTarget.world_version_id;
    } else {
      const selectedCharacterId = requestedCharacterId(request);
      const worldContent = legacyWorldContent(request.story, selectedCharacterId);
      const matchingVersion = await matchingWorldVersion(client, ownerUserId, request.story, selectedCharacterId);
      if (matchingVersion) {
        worldId = matchingVersion.world_id;
        worldVersionId = matchingVersion.world_version_id;
      } else {
        const worldInsert = await client.query<{ id: string }>(
          `INSERT INTO worlds (owner_user_id, title, status)
           VALUES ($1, $2, 'active') RETURNING id`,
          [ownerUserId, worldTitle(request.story)]
        );
        const newWorldId = worldInsert.rows[0]?.id;
        if (!newWorldId) throw new Error("Could not create the imported world.");
        worldId = newWorldId;

        const worldVersionInsert = await client.query<{ id: string }>(
          `INSERT INTO world_versions (world_id, owner_user_id, version_number, content, source_hash)
           VALUES ($1, $2, 1, $3, $4) RETURNING id`,
          [worldId, ownerUserId, json(worldContent), sourceHash]
        );
        const newWorldVersionId = worldVersionInsert.rows[0]?.id;
        if (!newWorldVersionId) throw new Error("Could not create the imported world version.");
        worldVersionId = newWorldVersionId;
        await client.query(
          `INSERT INTO world_drafts (world_id, owner_user_id, based_on_world_version_id, revision, content)
           VALUES ($1,$2,$3,1,$4)`,
          [worldId, ownerUserId, worldVersionId, json(worldContent)]
        );
      }
    }

    const pinnedContentResult = await client.query<{ content: WorldContent }>(
      "SELECT content FROM world_versions WHERE id = $1 AND owner_user_id = $2",
      [worldVersionId, ownerUserId]
    );
    const pinnedContent = worldContentSchema.parse(pinnedContentResult.rows[0]?.content);
    const characterSeed = importedCharacterSeed(pinnedContent, request, Boolean(existingTarget));
    const selectedCharacterSnapshot = characterSnapshot(characterSeed.character);
    const portableProfile = request.story.campaign?.characterProfile;
    const importedProfile = portableProfile ?? campaignProfileFromCharacter(characterSeed.character);
    const importedProfileRevision = importedProfile
      ? portableProfile && request.story.campaign?.characterProfileRevision !== undefined
        ? Number(request.story.campaign.characterProfileRevision)
        : 1
      : 0;
    const entityCatalog = buildScopedEntityCatalog({
      worldContent: pinnedContent,
      characterSnapshot: selectedCharacterSnapshot,
      characterProfile: importedProfile
    });

    const sanitizedSettings = removeProviderSecrets(request.story.settings);
    delete sanitizedSettings.nexusCampaignId;
    delete sanitizedSettings.nexusCampaignTurnCount;
    delete sanitizedSettings.nexusPendingGeneration;
    delete sanitizedSettings.nexusCampaignWorldVersionId;
    delete sanitizedSettings.nexusBranchWorldVersionId;
    const storyLengthProfile = storyLengthProfileFromUnknown(request.story.settings?.storyLength ?? request.story.settings?.story_length);
    const importedTurnControlStyle = request.story.settings?.turnControlStyle;
    const turnControlStyle = importedTurnControlStyle === "action_only" || importedTurnControlStyle === "flexible_auto"
      || importedTurnControlStyle === "flexible_action" || importedTurnControlStyle === "flexible_scene"
      ? importedTurnControlStyle : "flexible_action";
    const campaignInsert = await client.query<{ id: string }>(
      `INSERT INTO campaigns (
         owner_user_id, world_version_id, title, active_turn_number, story_length_profile, turn_control_style,
         legacy_settings, selected_character_id, character_snapshot, character_profile, character_profile_revision
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
      [ownerUserId, worldVersionId, campaignTitle(request.story), request.story.turns.length, storyLengthProfile,
        turnControlStyle, json(sanitizedSettings), characterSeed.character.id, json(selectedCharacterSnapshot),
        importedProfile ? json(importedProfile) : null, importedProfileRevision]
    );
    const campaignId = campaignInsert.rows[0]?.id;
    if (!campaignId) throw new Error("Could not create the imported campaign.");
    if (importedProfile && importedProfileRevision > 0) {
      await client.query(
        `INSERT INTO campaign_character_profile_edits (
           owner_user_id, campaign_id, revision, previous_profile, next_profile, edit_source
         ) VALUES ($1,$2,$3,NULL,$4,'imported')`,
        [ownerUserId, campaignId, importedProfileRevision, json(importedProfile)]
      );
    }



    if (assetStore) {
      async function* originalImages() {
        if (legacyAssets) {
          for (const assetId of legacyAssetIds(legacyAssets)) {
            const bytes = await readLegacyAsset(legacyAssets, assetId);
            if (bytes) yield { bytes, mimeType: detectMimeType(bytes) };
          }
        }
        for (const turn of request.story.turns) {
          if (!turn.imageUrl?.startsWith("data:image/")) continue;
          const parsed = parseDataImage(turn.imageUrl);
          if (parsed) yield { bytes: parsed.bytes, mimeType: parsed.mimeType };
        }
      }
      await lockOriginalImages(client, ownerUserId, originalImages());
    }

    if (assetStore && legacyAssets && !existingTarget) {
      const coverUrl = typeof request.story.world.coverImageUrl === 'string' ? request.story.world.coverImageUrl : '';
      if (coverUrl) {
        const bytes = await readLegacyAssetUrl(legacyAssets, coverUrl);
        if (bytes) {
          await withOptionalImportStep(client, async () => {
            const asset = await persistWorldCover(client, assetStore, ownerUserId, bytes, detectMimeType(bytes));
            await client.query("UPDATE worlds SET cover_asset_id = $2 WHERE id = $1", [worldId, asset.id]);
          });
        }
      }
    }

    const initialTrackers = normalizeCampaignTrackers(request.story.trackers ?? []);
    const defaultTriggers = normalizeCampaignTrackers(
      request.story.defaultTriggers ?? request.story.baseTrackersAtStart ?? []
    );
    const eventTriggers = request.story.eventTriggers ?? [];
    const pendingEventTriggers = request.story.pendingEventTriggers ?? [];
    const rpgStats = request.story.rpgStats ?? [];

    await client.query(
      `INSERT INTO campaign_state (
         campaign_id, owner_user_id, scratchpad_private, trackers, default_triggers,
         event_triggers, pending_event_triggers, rpg_stats, import_provenance, initial_state_snapshot
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        campaignId,
        ownerUserId,
        request.story.scratchpad ?? "",
        json(initialTrackers),
        json(defaultTriggers),
        json(eventTriggers),
        json(pendingEventTriggers),
        json(rpgStats),
        json({
          sourceType: request.targetWorldVersionId ? "infinite_worlds_story_txt" : "legacy_story_json",
          sourceName: request.sourceName,
          sourceHash,
          selectedCharacterId: characterSeed.character.id,
          characterStrategy: request.characterStrategy
            ?? (existingTarget && isPortableCampaign(request) ? "preserve_source" : "map_to_target"),
          world: request.story.worldImportProvenance ?? null,
          story: request.story.storyImportProvenance ?? null
        }),
        json({ scratchpad: "", trackers: initialTrackers, eventTriggers, pendingEventTriggers: [], rpgStats })
      ]
    );

    let completeHistoryCharacters = 0;
    let estimatedHistoryTokens = 0;
    let sanitizedMemoryCount = 0;
    let memoryCount = 0;

    for (const [index, turn] of request.story.turns.entries()) {
      const ordinal = index + 1;
      const narration = turnNarration(turn);
      if (!narration) throw new Error(`Turn ${ordinal} has no narration, story, or text content.`);
      const action = turn.action?.trim() ?? "";
      completeHistoryCharacters += action.length + narration.length;
      estimatedHistoryTokens += estimateTokens(`${action}\n${narration}`);

      const rawStateSnapshot = typeof turn.worldStateSnapshot === "object" && turn.worldStateSnapshot !== null
        ? turn.worldStateSnapshot
        : { scratchpad: turn.scratchpadSnapshot ?? "", trackers: turn.trackersSnapshot ?? [] };
      const stateSnapshot = normalizeCampaignStateSnapshot(rawStateSnapshot);
      const turnInsert = await client.query<{ id: string }>(
        `INSERT INTO turns (
           owner_user_id, campaign_id, turn_number, source_turn_id, action, input_mode, input_mode_source, narration, choices,
           custom_action_suggestion, image_prompt, image_url, mechanics_private,
           state_snapshot_private, model_metadata, import_metadata, accepted_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
         RETURNING id`,
        [
          ownerUserId,
          campaignId,
          ordinal,
          turn.id ?? null,
          action,
          turn.inputMode ?? "action",
          turn.inputModeSource ?? "explicit",
          narration,
          json(choices(turn)),
          turn.customActionSuggestion ?? turn.custom_action_suggestion ?? "",
          turn.imagePrompt ?? "",
          safeExternalImageUrl(turn.imageUrl ?? ""),
          turn.roll == null ? null : json(turn.roll),
          json(stateSnapshot),
          json(turn.llmModelInfo ?? {}),
          json({ importedFrom: turn.importedFrom ?? null, legacyCreatedAt: turn.createdAt ?? null }),
          safeDate(turn.createdAt)
        ]
      );
      const turnId = turnInsert.rows[0]!.id;
      let importedAssetId: string | null = null;

      if (assetStore && turn.imageUrl?.startsWith("data:image/")) {
        const asset = await importTurnImage(client, assetStore, ownerUserId, campaignId, turnId, turn.imageUrl);
        if (asset) {
          importedAssetId = asset.id;
          await client.query("UPDATE turns SET image_url = $2 WHERE id = $1", [turnId, asset.publicUrl]);
        }
      } else if (assetStore && legacyAssets && turn.imageUrl) {
        const bytes = await readLegacyAssetUrl(legacyAssets, turn.imageUrl);
        if (bytes) {
          const persisted = await withOptionalImportStep(client, async () => {
            const asset = await persistTurnImage(client, assetStore, ownerUserId, campaignId, turnId, bytes, detectMimeType(bytes));
            if (asset) {
              await client.query("UPDATE turns SET image_url = $2 WHERE id = $1", [turnId, asset.publicUrl]);
            }
            return asset;
          });
          importedAssetId = persisted?.id ?? null;
        }
      }

      if (importedAssetId && campaignId) {
        await withOptionalImportStep(client, async () => {
          await linkImportedTurnIllustration(client, ownerUserId, campaignId, turnId, narration, turn.imagePrompt || "", importedAssetId);
        });
      }

      const memory = buildTurnFictionMemory(turn, ordinal);
      const entityMetadata = resolveEntityMetadata(memory.content, entityCatalog);
      if (memory.sanitized) sanitizedMemoryCount += 1;
      await client.query(
        `INSERT INTO chronicle_memories (
           owner_user_id, campaign_id, world_version_id, turn_id, memory_kind, ordinal,
           content, token_estimate, importance, entities, entity_ids, metadata
         ) VALUES ($1,$2,$3,$4,'turn_fiction',$5,$6,$7,$8,$9,$10,$11)`,
        [
          ownerUserId,
          campaignId,
          worldVersionId,
          turnId,
          ordinal,
          memory.content,
          memory.tokenEstimate,
          Math.min(1, 0.45 + ordinal / Math.max(20, request.story.turns.length * 2)),
          entityMetadata.entities,
          entityMetadata.entityIds,
          json({ sanitized: memory.sanitized, removedMechanicsSegments: memory.removedMechanicsSegments })
        ]
      );
      memoryCount += 1;
    }

    const legacySummary = formatLegacySummary(request.story.fullHistory);
    const importedSummary = Boolean(legacySummary);
    if (legacySummary) {
      const summaryTokens = estimateTokens(legacySummary);
      const entityMetadata = resolveEntityMetadata(legacySummary, entityCatalog);
      await client.query(
        `INSERT INTO summary_checkpoints (
           owner_user_id, campaign_id, through_turn, summary_kind, content, token_estimate
         ) VALUES ($1,$2,$3,'legacy_full_history',$4,$5)`,
        [
          ownerUserId,
          campaignId,
          Math.min(request.story.turns.length, request.story.fullHistoryCompressedThroughTurn ?? request.story.turns.length),
          json(request.story.fullHistory),
          summaryTokens
        ]
      );
      await client.query(
        `INSERT INTO chronicle_memories (
           owner_user_id, campaign_id, world_version_id, memory_kind, ordinal,
           content, token_estimate, importance, entities, entity_ids, metadata
         ) VALUES ($1,$2,$3,'legacy_summary',0,$4,$5,0.75,$6,$7,$8)`,
        [ownerUserId, campaignId, worldVersionId, legacySummary, summaryTokens,
          entityMetadata.entities, entityMetadata.entityIds,
          json({ derivedFromLegacyFullHistory: true })]
      );
      memoryCount += 1;
    }

    await memory.autoEnableCampaignEmbedding(client, {
      ownerUserId,
      campaignId,
      worldVersionId
    });

    const stats: StoryImportResult["stats"] = {
      turnCount: request.story.turns.length,
      memoryCount,
      completeHistoryCharacters,
      estimatedHistoryTokens,
      importedSummary,
      sanitizedMemoryCount
    };
    await client.query(
      `UPDATE imports
          SET status = 'completed', world_id = $2, world_version_id = $3, campaign_id = $4,
              stats = $5, completed_at = now()
        WHERE id = $1`,
      [importId, worldId, worldVersionId, campaignId, json(stats)]
    );
    await client.query(
      `INSERT INTO activity_events (owner_user_id, campaign_id, event_type, correlation_id, details)
       VALUES ($1,$2,'legacy_story_imported',$3,$4)`,
      [ownerUserId, campaignId, importId, json({ sourceName: request.sourceName, sourceHash, ...stats })]
    );
    await withOptionalImportStep(client, () => memory.enqueueChunkIndex(client, {
      ownerUserId,
      campaignId,
      worldVersionId
    }));

    return { importId, worldId, worldVersionId, campaignId, duplicate: false, stats };
  });
}

export function importLegacyStoryWithClient(
  client: DatabaseClient,
  request: StoryImportRequest,
  memory: MemoryGenerationTransactionPort,
  assetStore?: FilesystemAssetStore,
  legacyAssets?: LegacyAssets
): Promise<StoryImportResult> {
  return importLegacyStoryWithTransaction(
    (work) => work(client),
    request,
    memory,
    assetStore,
    legacyAssets,
  );
}

export async function importLegacyStory(
  pool: DatabasePool,
  request: StoryImportRequest,
  memory: MemoryGenerationTransactionPort,
  assetStore?: FilesystemAssetStore,
  legacyAssets?: LegacyAssets
): Promise<StoryImportResult> {
  return importLegacyStoryWithTransaction(
    (work) => withTransaction(pool, work),
    request,
    memory,
    assetStore,
    legacyAssets,
  );
}

export async function previewLegacyStoryImport(pool: DatabasePool, request: StoryImportRequest) {
  const sourceHash = importSourceHash(request);
  const ownerUserId = await initialOwnerId(pool);
  let targetContent: WorldContent | null = null;
  if (request.targetWorldVersionId) {
    const target = await pool.query<{ content: WorldContent }>(
      "SELECT content FROM world_versions WHERE id = $1 AND owner_user_id = $2",
      [request.targetWorldVersionId, ownerUserId]
    );
    if (!target.rowCount) throw Object.assign(new Error("The selected target world version was not found."), { statusCode: 404 });
    targetContent = worldContentSchema.parse(target.rows[0]?.content);
    importedCharacterSeed(targetContent, request, true);
  }
  const prior = await pool.query<{ campaign_id: string | null }>(
    "SELECT campaign_id FROM imports WHERE owner_user_id = $1 AND source_hash = $2 AND status = 'completed'",
    [ownerUserId, sourceHash]
  );
  const missingNarration = request.story.turns
    .map((turn, index) => ({ turn, index }))
    .filter(({ turn }) => !turnNarration(turn))
    .map(({ index }) => index + 1);
  const completeHistoryCharacters = request.story.turns.reduce((total, turn) => (
    total + String(turn.action ?? "").length + turnNarration(turn).length
  ), 0);
  const sanitizedSettings = removeProviderSecrets(request.story.settings);
  const credentialsRemoved = stableStringify(sanitizedSettings) !== stableStringify(request.story.settings ?? {});
  const warnings = [
    ...(credentialsRemoved ? ["Provider credentials and endpoint secrets will not be imported."] : []),
    ...(missingNarration.length ? [`${missingNarration.length} turn(s) have no narration and must be corrected before import.`] : []),
    ...(targetContent && isPortableCampaign(request) && (request.characterStrategy ?? "preserve_source") === "preserve_source"
      ? ["The exported campaign character and accumulated state will be preserved; target-world defaults will not be merged automatically."]
      : []),
    ...(targetContent && isPortableCampaign(request) && (request.story.formatVersion ?? 1) < 2
      ? ["This older campaign backup does not contain a complete character snapshot; Nexus will preserve the compatible character text and campaign state available in the file."]
      : [])
  ];
  return {
    kind: "campaign" as const,
    title: campaignTitle(request.story),
    duplicate: Boolean(prior.rows[0]?.campaign_id),
    existingCampaignId: prior.rows[0]?.campaign_id ?? null,
    valid: missingNarration.length === 0,
    counts: {
      turns: request.story.turns.length,
      completeHistoryCharacters,
      estimatedHistoryTokens: request.story.turns.reduce((total, turn) => total + estimateTokens(`${turn.action ?? ""}\n${turnNarration(turn)}`), 0)
    },
    warnings
  };
}

async function resolveImportedWorld(
  client: DatabaseClient,
  ownerUserId: string,
  archive: DecodedCampaignArchive,
  preview: Record<string, unknown>,
  idMap: ArchiveIdMap
): Promise<{ worldId: string; worldVersionId: string; created: boolean }> {
  const destination = objectValue(preview.destination);
  const operation = destination.operation;
  let worldId = "";
  let worldVersionId = "";
  if (destination.kind === "existing_world_version" || operation === "attach_existing_world_version" || operation === "reuse_world_version") {
    worldId = String(destination.worldId || "");
    worldVersionId = String(destination.worldVersionId || "");
    const selected = await client.query<{ world_id: string; content: WorldContent }>(
      "SELECT world_id,content FROM world_versions WHERE id=$1 AND owner_user_id=$2", [worldVersionId, ownerUserId]
    );
    if (!selected.rowCount || selected.rows[0]!.world_id !== worldId) throw new ArchiveError("archive-destination-not-empty", "The destination world version is no longer available.");
    const destinationHash = portableWorldContentHash(selected.rows[0]!.content);
    if (destinationHash !== archive.world.canonicalHash) {
      throw new ArchiveError("archive-world-mismatch", "The destination world version no longer matches the archive world.");
    }
  } else {
    const createdWorld = await client.query<{ id: string }>(
      "INSERT INTO worlds (owner_user_id,title) VALUES ($1,$2) RETURNING id", [ownerUserId, String(objectValue(archive.world.content).world && objectValue(objectValue(archive.world.content).world).title || "Imported world")]
    );
    worldId = createdWorld.rows[0]!.id;
    const createdVersion = await client.query<{ id: string }>(
      `INSERT INTO world_versions (world_id,owner_user_id,version_number,content,source_hash)
       VALUES ($1,$2,1,$3::jsonb,$4) RETURNING id`,
      [worldId, ownerUserId, JSON.stringify(archive.world.content), archive.world.canonicalHash]
    );
    worldVersionId = createdVersion.rows[0]!.id;
  }
  idMap.get("world")!.set(archive.world.sourceWorldId, worldId);
  idMap.get("worldVersion")!.set(archive.world.sourceWorldVersionId, worldVersionId);
  return { worldId, worldVersionId, created: operation !== "reuse_world_version" && operation !== "attach_existing_world_version" };
}

async function insertImportedRecords(
  client: DatabaseClient,
  ownerUserId: string,
  archive: DecodedCampaignArchive,
  idMap: ArchiveIdMap,
  worldVersionId: string
): Promise<{ campaignId: string; turnCount: number; memoryCount: number; summaryCount: number }> {
  const sourceCampaign = objectValue(archive.campaign.campaign);
  const sourceCampaignId = sourceCampaign.sourceCampaignId || archive.inspected.manifest.campaignId;
  const campaignId = mapArchiveId(idMap, "campaign", sourceCampaignId);
  const turns = Array.isArray(archive.campaign.turns) ? archive.campaign.turns : [];
  for (const turn of turns) mapArchiveId(idMap, "turn", objectValue(turn).id);
  const records = archive.campaign.archiveRecords;
  const profileEdits = Array.isArray(records.characterProfileEdits) ? records.characterProfileEdits : [];
  const stateEdits = Array.isArray(records.stateEdits) ? records.stateEdits : [];
  const migrations = Array.isArray(records.worldMigrations) ? records.worldMigrations : [];
  const illustrationSets = Array.isArray(records.illustrationSets) ? records.illustrationSets : [];
  const illustrationSegments = Array.isArray(records.illustrationSegments) ? records.illustrationSegments : [];
  for (const row of profileEdits) mapArchiveId(idMap, "profileEdit", objectValue(row).id);
  for (const row of stateEdits) mapArchiveId(idMap, "stateEdit", objectValue(row).id);
  for (const row of migrations) mapArchiveId(idMap, "migration", objectValue(row).id);
  for (const row of illustrationSets) mapArchiveId(idMap, "illustrationSet", objectValue(row).id);
  for (const row of illustrationSegments) mapArchiveId(idMap, "illustrationSegment", objectValue(row).id);
  for (const memory of archive.chronicle.memories) mapArchiveId(idMap, "memory", objectValue(memory).id);
  for (const summary of archive.chronicle.summaries) mapArchiveId(idMap, "summary", objectValue(summary).id);

  const settings = objectValue(archive.campaign.settings);
  const title = String(sourceCampaign.title || "Imported campaign");
  const activeTurnNumber = Math.max(0, ...turns.map((turn) => Number(objectValue(turn).turnNumber || 0)));
  const campaign = await client.query<{ id: string }>(
    `INSERT INTO campaigns (
       id,owner_user_id,world_version_id,title,active_turn_number,legacy_settings,story_length_profile,
       turn_control_style,selected_character_id,character_snapshot,character_profile,character_profile_revision
     ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10::jsonb,$11::jsonb,$12) RETURNING id`,
    [campaignId, ownerUserId, worldVersionId, title, activeTurnNumber,
      jsonValue(settings, {}), String(settings.storyLength || "standard"), String(settings.turnControlStyle || "flexible_action"),
      sourceCampaign.selectedCharacterId || null,
      sourceCampaign.characterSnapshot == null ? null : jsonValue(sourceCampaign.characterSnapshot, null),
      sourceCampaign.characterProfile == null ? null : jsonValue(sourceCampaign.characterProfile, null),
      Number(sourceCampaign.characterProfileRevision || 0)]
  );
  if (!campaign.rowCount) throw new Error("Could not create imported campaign.");

  const importedTrackers = normalizeCampaignTrackers(archive.campaign.trackers);
  const importedDefaultTriggers = normalizeCampaignTrackers(archive.campaign.defaultTriggers);
  const importedInitialSnapshot = normalizeCampaignStateSnapshot({
    scratchpad: "",
    trackers: archive.campaign.baseTrackersAtStart ?? []
  });
  await client.query(
    `INSERT INTO campaign_state (
       campaign_id,owner_user_id,scratchpad_private,trackers,default_triggers,event_triggers,pending_event_triggers,
       rpg_stats,import_provenance,initial_state_snapshot,revision
     ) VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7::jsonb,$8::jsonb,$9::jsonb,$10::jsonb,$11)`,
    [campaignId, ownerUserId, String(archive.campaign.scratchpad || ""), json(importedTrackers), json(importedDefaultTriggers), jsonValue(archive.campaign.eventTriggers, []), jsonValue(archive.campaign.pendingEventTriggers, []), jsonValue(archive.campaign.rpgStats, []), jsonValue({ world: archive.campaign.worldImportProvenance ?? null, story: archive.campaign.storyImportProvenance ?? null }, {}), json(importedInitialSnapshot), Number(sourceCampaign.stateRevision || 0)]
  );

  for (const turnValue of turns) {
    const turn = objectValue(turnValue);
    const sourceTurnId = turn.id;
    await client.query(
      `INSERT INTO turns (
         id,owner_user_id,campaign_id,turn_number,source_turn_id,action,input_mode,input_mode_source,narration,
         choices,custom_action_suggestion,image_prompt,image_url,mechanics_private,state_snapshot_private,model_metadata,import_metadata,accepted_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,'',$13::jsonb,$14::jsonb,$15::jsonb,$16::jsonb,$17)`,
      [requireMapped(idMap, "turn", sourceTurnId), ownerUserId, campaignId, Number(turn.turnNumber || 0), String(sourceTurnId), String(turn.action || ""), String(turn.inputMode || "action"), String(turn.inputModeSource || "explicit"), String(turn.narration || turn.story || turn.text || ""), jsonValue(turn.choices, []), String(turn.customActionSuggestion || ""), String(turn.imagePrompt || ""), turn.roll ?? null, json(normalizeCampaignStateSnapshot(turn.worldStateSnapshot)), jsonValue(turn.llmModelInfo, {}), jsonValue(turn.importedFrom, {}), importedDate(turn.createdAt) ?? new Date().toISOString()]
    );
  }
  for (const rowValue of profileEdits) {
    const row = objectValue(rowValue);
    await client.query(
      `INSERT INTO campaign_character_profile_edits (id,owner_user_id,campaign_id,revision,previous_profile,next_profile,edit_source)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7)`,
      [requireMapped(idMap, "profileEdit", row.id), ownerUserId, campaignId, Number(row.revision || 1), jsonValue(row.previous_profile, null), jsonValue(row.next_profile, {}), ["world_version_seed", "manual", "ai_organized", "imported", "branch", "transfer"].includes(String(row.edit_source)) ? String(row.edit_source) : "imported"]
    );
  }
  for (const rowValue of stateEdits) {
    const row = objectValue(rowValue);
    const stateSnapshot = normalizeCampaignStateSnapshot(row.state_snapshot_private);
    await client.query(
      `INSERT INTO campaign_state_edits (id,owner_user_id,campaign_id,effective_turn_number,revision,state_snapshot_private,changed_fields)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb)`,
      [requireMapped(idMap, "stateEdit", row.id), ownerUserId, campaignId, Number(row.effective_turn_number || 0), Number(row.revision || 1), json(stateSnapshot), jsonValue(row.changed_fields, [])]
    );
  }
  for (const rowValue of migrations) {
    const row = objectValue(rowValue);
    const fromVersion = typeof row.from_world_version_id === "string"
      ? idMap.get("worldVersion")!.get(row.from_world_version_id)
      : undefined;
    const toVersion = typeof row.to_world_version_id === "string"
      ? idMap.get("worldVersion")!.get(row.to_world_version_id)
      : undefined;
    if (!fromVersion || !toVersion) continue;
    if (fromVersion === toVersion) continue;
    await client.query(
      `INSERT INTO campaign_world_migrations (id,owner_user_id,campaign_id,from_world_version_id,to_world_version_id,note,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [requireMapped(idMap, "migration", row.id), ownerUserId, campaignId, fromVersion, toVersion, String(row.note || ""), importedDate(row.created_at) ?? new Date().toISOString()]
    );
  }
  for (const memoryValue of archive.chronicle.memories) {
    const memory = objectValue(memoryValue);
    await client.query(
      `INSERT INTO chronicle_memories (id,owner_user_id,campaign_id,world_version_id,turn_id,memory_kind,ordinal,content,token_estimate,importance,entities,entity_ids,metadata,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14)`,
      [requireMapped(idMap, "memory", memory.id), ownerUserId, campaignId, requireMapped(idMap, "worldVersion", memory.world_version_id || archive.world.sourceWorldVersionId), memory.turn_id ? requireMapped(idMap, "turn", memory.turn_id) : null, String(memory.memory_kind || "legacy_summary"), Number(memory.ordinal || 0), String(memory.content || ""), Number(memory.token_estimate || 0), Number(memory.importance ?? 0.5), memory.entities || [], memory.entity_ids || [], jsonValue(memory.metadata, {}), importedDate(memory.created_at) ?? new Date().toISOString()]
    );
  }
  for (const summaryValue of archive.chronicle.summaries) {
    const summary = objectValue(summaryValue);
    await client.query(
      `INSERT INTO summary_checkpoints (id,owner_user_id,campaign_id,through_turn,summary_kind,content,token_estimate,created_at)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8)`,
      [requireMapped(idMap, "summary", summary.id), ownerUserId, campaignId, Number(summary.through_turn || 0), String(summary.summary_kind || "campaign_summary"), jsonValue(summary.content, {}), Number(summary.token_estimate || 0), importedDate(summary.created_at) ?? new Date().toISOString()]
    );
  }

  const config = records.illustrationConfig && typeof records.illustrationConfig === "object" ? records.illustrationConfig as Record<string, unknown> : null;
  if (config) {
    const legacyEnabled = config.enabled === true || config.enabled === "true";
    const sourcePolicy = ["off", "library_only", "library_then_generate", "generate_only"].includes(String(config.source_policy))
      ? String(config.source_policy)
      : legacyEnabled ? "generate_only" : "off";
    const matchingScope = ["campaign", "world", "owner_library", "shared"].includes(String(config.matching_scope))
      ? String(config.matching_scope)
      : "world";
    const confidenceProfile = ["strict", "balanced", "broad"].includes(String(config.confidence_profile))
      ? String(config.confidence_profile)
      : "balanced";
    const repetitionWindow = Number(config.repetition_window);
    await client.query(
      `INSERT INTO campaign_illustration_configs (
         campaign_id,owner_user_id,enabled,source_policy,matching_scope,confidence_profile,repetition_window,
         model,size,aspect_ratio,quality,output_format,max_attempts,segment_word_count,images_per_segment,
         segment_prompt_mode,refinement_prompt
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
      [campaignId, ownerUserId, sourcePolicy !== "off", sourcePolicy, matchingScope, confidenceProfile,
        Number.isInteger(repetitionWindow) && repetitionWindow >= 0 && repetitionWindow <= 100 ? repetitionWindow : 5,
        String(config.model || ""), String(config.size || "1024x1024"), String(config.aspect_ratio || "1:1"), ["auto", "low", "medium", "high"].includes(String(config.quality)) ? String(config.quality) : "auto", ["png", "jpeg", "webp"].includes(String(config.output_format)) ? String(config.output_format) : "png", Number(config.max_attempts || 3), Number(config.segment_word_count || 500), Number(config.images_per_segment || 1), ["direct", "ai_refined"].includes(String(config.segment_prompt_mode)) ? String(config.segment_prompt_mode) : "direct", typeof config.refinement_prompt === "string" ? config.refinement_prompt : ""]
    );
  }
  for (const setValue of illustrationSets) {
    const set = objectValue(setValue);
    await client.query(
      `INSERT INTO turn_illustration_sets (id,owner_user_id,campaign_id,turn_id,source_text_hash,segment_word_count,images_per_segment,prompt_mode,status,is_active,character_visual_reference,created_at,completed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [requireMapped(idMap, "illustrationSet", set.id), ownerUserId, campaignId, requireMapped(idMap, "turn", set.turn_id), String(set.source_text_hash || ""), Number(set.segment_word_count || 100), Number(set.images_per_segment || 1), ["direct", "ai_refined", "legacy"].includes(String(set.prompt_mode)) ? String(set.prompt_mode) : "direct", ["queued", "refining", "generating", "completed", "partial", "failed", "superseded"].includes(String(set.status)) ? String(set.status) : "failed", Boolean(set.is_active), String(set.character_visual_reference || ""), importedDate(set.created_at) ?? new Date().toISOString(), importedDate(set.completed_at)]
    );
  }
  for (const segmentValue of illustrationSegments) {
    const segment = objectValue(segmentValue);
    await client.query(
      `INSERT INTO turn_illustration_segments (id,owner_user_id,illustration_set_id,campaign_id,turn_id,ordinal,start_offset,end_offset,start_word,end_word,source_text,source_text_hash,direct_prompt,resolved_prompt,prompt_source,status,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$17)`,
      [requireMapped(idMap, "illustrationSegment", segment.id), ownerUserId, requireMapped(idMap, "illustrationSet", segment.illustration_set_id), campaignId, requireMapped(idMap, "turn", segment.turn_id), Number(segment.ordinal || 0), Number(segment.start_offset || 0), Number(segment.end_offset || 0), Number(segment.start_word || 0), Number(segment.end_word || 0), String(segment.source_text || ""), String(segment.source_text_hash || ""), String(segment.direct_prompt || ""), String(segment.resolved_prompt || ""), ["direct", "ai_refined", "ai_fallback", "legacy"].includes(String(segment.prompt_source)) ? String(segment.prompt_source) : "legacy", ["queued", "refining", "generating", "completed", "partial", "recoverable", "failed", "superseded"].includes(String(segment.status)) ? String(segment.status) : "failed", importedDate(segment.created_at) ?? new Date().toISOString()]
    );
  }
  const costs = Array.isArray(records.costs) ? records.costs : [];
  for (const costValue of costs) {
    const cost = objectValue(costValue);
    await client.query(
      `INSERT INTO provider_cost_events (owner_user_id,campaign_id,turn_id,local_call_id,provider_type,category,operation,requested_model,resolved_model,amount,currency,usage_metadata,occurred_at,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$13)`,
      [ownerUserId, campaignId, cost.turn_id ? requireMapped(idMap, "turn", cost.turn_id) : null, randomUUID(),
        String(cost.provider_type || "openai_compatible"), String(cost.category || "image"), String(cost.operation || "illustration"),
        String(cost.requested_model || ""), String(cost.resolved_model || ""), String(cost.amount || "0"), String(cost.currency || "USD"),
        jsonValue(cost.usage_metadata, {}), importedDate(cost.occurred_at) ?? new Date().toISOString()]
    );
  }
  return { campaignId, turnCount: turns.length, memoryCount: archive.chronicle.memories.length, summaryCount: archive.chronicle.summaries.length };
}

export async function importCampaignArchive(
  pool: DatabasePool,
  config: RuntimeConfig,
  assetStore: FilesystemAssetStore,
  request: CampaignArchiveCommitRequest,
  logger?: ArchiveCleanupLogger
): Promise<CampaignArchiveImportResult> {
  await cleanupExpiredArchivePreviews(pool, config, new Date(), logger);
  const parsed = campaignArchiveCommitRequestSchema.parse(request);
  const ownerUserId = await initialOwnerId(pool);
  const tokenHash = sha256(parsed.previewToken);
  const client = await pool.connect();
  let clientReleased = false;
  const releaseClient = () => {
    if (clientReleased) return;
    client.release();
    clientReleased = true;
  };
  let failedPreviewId = "";
  let failedPreviewPath = "";
  let createdPaths: string[] = [];
  try {
    await client.query("BEGIN");
    const previewResult = await client.query<ArchivePreviewRow>(
      `SELECT id,owner_user_id,content_fingerprint,destination_hash,application_version,staged_archive_path,source_name,preview,status,expires_at
         FROM archive_previews WHERE owner_user_id=$1 AND token_hash=$2 FOR UPDATE`, [ownerUserId, tokenHash]
    );
    const preview = previewResult.rows[0];
    if (!preview) throw new ArchiveError("archive-preview-stale", "The archive preview token is invalid or expired.");
    if (preview.status !== "previewed" || new Date(preview.expires_at).getTime() <= Date.now() || preview.application_version !== campaignArchiveApplicationVersion()) {
      if (preview.status === "previewed" && new Date(preview.expires_at).getTime() <= Date.now()) await client.query("UPDATE archive_previews SET status='expired',updated_at=now() WHERE id=$1", [preview.id]);
      throw new ArchiveError("archive-preview-stale", "The archive preview is no longer valid.");
    }
    const expectedDestinationHash = sha256(`campaign-archive-destination-v1\0${canonicalArchiveJson(parsed.destination)}`);
    if (expectedDestinationHash !== preview.destination_hash) throw new ArchiveError("archive-preview-stale", "The destination changed after preview.");
    const compressedBytes = preview.preview.stagedCompressedBytes;
    if (typeof compressedBytes !== "number" || !Number.isSafeInteger(compressedBytes) || compressedBytes < 0) {
      throw new ArchiveError("archive-preview-stale", "The archive preview is missing its staged compressed size.");
    }
    failedPreviewId = preview.id;
    failedPreviewPath = preview.staged_archive_path;
    const staged = await rehydratePersistedStagedArchive({
      archiveRoot: config.archiveStorageRoot,
      relativePath: preview.staged_archive_path,
      compressedBytes
    });
    const archive = await decodeCampaignArchive(staged, config.campaignArchiveLimits);
    if (archive.contentFingerprint !== preview.content_fingerprint) throw new ArchiveError("archive-preview-stale", "The staged archive changed after preview.");
    const sourceHash = campaignArchiveSourceHash(archive.contentFingerprint, parsed.destination);
    const prior = await client.query<ImportRow>("SELECT id,world_id,world_version_id,campaign_id,status,stats FROM imports WHERE owner_user_id=$1 AND source_hash=$2 FOR UPDATE", [ownerUserId, sourceHash]);
    if (prior.rows[0]?.status === "completed") {
      const row = prior.rows[0];
      await client.query(
        `UPDATE archive_previews
            SET status='consumed',consumed_at=now(),result=$2::jsonb,updated_at=now()
          WHERE id=$1 AND token_hash=$3 AND staged_archive_path=$4 AND status='previewed'`,
        [preview.id, JSON.stringify({ importId: row.id, duplicate: true, stagingCleanupPending: true }), tokenHash, preview.staged_archive_path]
      );
      await client.query("COMMIT");
      releaseClient();
      await cleanupArchivePreviewStaging(pool, config, preview.id, logger)
        .catch((error) => safeCleanupWarning(logger, error, "consumed campaign archive preview staging cleanup failed"));
      return { importId: row.id, worldId: row.world_id!, worldVersionId: row.world_version_id!, campaignId: row.campaign_id!, duplicate: true, stats: row.stats as unknown as CampaignArchiveImportResult["stats"] };
    }
    if (prior.rows[0]) throw new ArchiveError("archive-import-conflict", "An import with this archive is already in progress.");
    const importRecord = await client.query<{ id: string }>(
      `INSERT INTO imports (owner_user_id,source_type,source_name,source_hash,status) VALUES ($1,'campaign_archive',$2,$3,'processing') RETURNING id`, [ownerUserId, preview.source_name, sourceHash]
    );
    const importId = importRecord.rows[0]!.id;
    const idMap = newArchiveIdMap();
    const destinationPreview = objectValue(preview.preview).destination;
    const world = await resolveImportedWorld(client, ownerUserId, archive, objectValue({ destination: destinationPreview }), idMap);
    const inserted = await insertImportedRecords(client, ownerUserId, archive, idMap, world.worldVersionId);
    const persisted = await persistArchiveAssets(client, assetStore, ownerUserId, archive.assets, idMap);
    createdPaths = persisted.createdPaths;
    const insertedGenerationContexts = new Set<string>();
    for (const record of archive.inspected.manifest.assets) {
      for (const binding of record.bindings) {
        if (binding.role !== "generation_context") continue;
        const contextId = mapArchiveId(idMap, "generationContext", binding.sourceContextId);
        if (insertedGenerationContexts.has(contextId)) continue;
        insertedGenerationContexts.add(contextId);
        const assetId = persisted.assetIds.get(record.sourceAssetId);
        if (!assetId) throw new ArchiveError("archive-json-invalid", "The archive generation context asset mapping is missing.");
        await client.query(
          `INSERT INTO asset_generation_contexts (id,owner_user_id,asset_id,created_by_user_id,world_id,world_version_id,campaign_id,turn_id,target_type,variant_index)
           VALUES ($1,$2,$3,$2,$4,$5,$6,$7,'other',0)`,
          [contextId, ownerUserId, assetId, binding.worldId === null ? null : requireMapped(idMap, "world", binding.worldId), binding.worldVersionId === null ? null : requireMapped(idMap, "worldVersion", binding.worldVersionId), binding.campaignId === null ? null : requireMapped(idMap, "campaign", binding.campaignId), binding.turnId === null ? null : requireMapped(idMap, "turn", binding.turnId)]
        );
      }
    }
    if (world.created) {
      await client.query("UPDATE world_versions SET content=$2::jsonb WHERE id=$1 AND owner_user_id=$3", [world.worldVersionId, JSON.stringify(rewriteAssetPointers(archive.world.content, persisted.assetIds)), ownerUserId]);
    }
    await restoreAssetBindings(client, ownerUserId, archive.inspected.manifest.assets, persisted.assetIds, idMap);
    const stats: CampaignArchiveImportResult["stats"] = { turnCount: inserted.turnCount, memoryCount: inserted.memoryCount, summaryCount: inserted.summaryCount, assetCount: archive.assets.originals.length, assetBytes: archive.assets.originals.reduce((sum, asset) => sum + asset.byteLength, 0) };
    await client.query("UPDATE imports SET status='completed',world_id=$2,world_version_id=$3,campaign_id=$4,stats=$5::jsonb,completed_at=now() WHERE id=$1", [importId, world.worldId, world.worldVersionId, inserted.campaignId, JSON.stringify(stats)]);
    await client.query(
      `UPDATE archive_previews
          SET status='consumed',consumed_at=now(),result=$2::jsonb,updated_at=now()
        WHERE id=$1 AND token_hash=$3 AND staged_archive_path=$4 AND status='previewed'`,
      [preview.id, JSON.stringify({
        importId,
        worldId: world.worldId,
        worldVersionId: world.worldVersionId,
        campaignId: inserted.campaignId,
        stats,
        stagingCleanupPending: true
      }), tokenHash, preview.staged_archive_path]
    );
    await client.query("COMMIT");
    releaseClient();
    await cleanupArchivePreviewStaging(pool, config, preview.id, logger)
      .catch((error) => safeCleanupWarning(logger, error, "consumed campaign archive preview staging cleanup failed"));
    return { importId, worldId: world.worldId, worldVersionId: world.worldVersionId, campaignId: inserted.campaignId, duplicate: false, stats };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    releaseClient();
    const persistedFailure = error && typeof error === "object" && "createdPaths" in error
      ? (error as { createdPaths?: unknown }).createdPaths
      : undefined;
    if (Array.isArray(persistedFailure)) createdPaths = [...new Set([...createdPaths, ...persistedFailure.filter((path): path is string => typeof path === "string")])];
    if (createdPaths.length) {
      await cleanupUnreferencedCreatedPaths(pool, assetStore, ownerUserId, createdPaths)
        .catch((cleanupError) => safeCleanupWarning(logger, cleanupError, "failed campaign archive asset cleanup failed"));
    }
    if (failedPreviewId) {
      const failedId = await markArchivePreviewFailed(pool, failedPreviewId, tokenHash, failedPreviewPath, error, logger);
      if (failedId) {
        await cleanupArchivePreviewStaging(pool, config, failedId, logger)
          .catch((cleanupError) => safeCleanupWarning(logger, cleanupError, "failed campaign archive preview staging cleanup failed"));
      }
    }
    throw error;
  } finally {
    releaseClient();
  }
}
