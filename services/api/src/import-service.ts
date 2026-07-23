import type { DatabaseClient, DatabasePool } from "../../../packages/database/src/pool.js";
import { initialOwnerId, withTransaction } from "../../../packages/database/src/pool.js";
import type { LegacyStory, LegacyTurn, StoryImportRequest, StoryImportResult } from "../../../packages/contracts/src/imports.js";
import { storyLengthProfileFromUnknown } from "../../../packages/contracts/src/story-settings.js";
import { buildTurnFictionMemory, formatLegacySummary, turnNarration } from "../../../packages/story-engine/src/chronicle.js";
import { estimateTokens, removeProviderSecrets, sha256, stableStringify } from "../../../packages/domain/src/text.js";
import { campaignCharacterSeed, campaignProfileFromCharacter, characterSnapshot } from "../../../packages/domain/src/world-characters.js";
import { buildScopedEntityCatalog, resolveEntityMetadata } from "../../../packages/domain/src/entity-references.js";
import {
  canonicalizeWorldContent,
  playableCharacterSchema,
  worldContentSchema,
  WORLD_CONTENT_SCHEMA_VERSION,
  type WorldContent
} from "../../../packages/contracts/src/world-library.js";
import { importTurnImage, safeExternalImageUrl, type FilesystemAssetStore } from "./asset-service.js";
import { autoEnableCampaignEmbeddingIfAvailable } from "./memory-service.js";

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

export function legacyWorldContent(story: LegacyStory, requestedSelectedCharacterId?: string): WorldContent {
  const provenance = story.storyImportProvenance && typeof story.storyImportProvenance === "object" && !Array.isArray(story.storyImportProvenance)
    ? story.storyImportProvenance as Record<string, unknown>
    : {};
  const provenanceCharacterId = typeof provenance.selectedCharacterId === "string" ? provenance.selectedCharacterId.trim() : "";
  const characterText = String(story.world.character || "").trim();
  const characterName = (typeof provenance.selectedCharacterName === "string" && provenance.selectedCharacterName.trim()
    ? provenance.selectedCharacterName.trim()
    : characterText.split(/\r?\n/).find((line) => line.trim())?.trim() || "Default character").slice(0, 200);
  const selectedCharacterId = requestedSelectedCharacterId?.trim() || provenanceCharacterId || `legacy-import-character-${sha256(stableStringify({
    characterText,
    rpgStats: story.rpgStats ?? [],
    defaultTriggers: story.defaultTriggers ?? story.baseTrackersAtStart ?? []
  })).slice(0, 24)}`;
  const world = { ...story.world, title: worldTitle(story) };
  delete world.character;
  return canonicalizeWorldContent({
    schemaVersion: WORLD_CONTENT_SCHEMA_VERSION,
    world,
    playableCharacters: [{
      id: selectedCharacterId,
      name: characterName,
      characterText,
      rpgStats: story.rpgStats ?? [],
      defaultTriggers: story.defaultTriggers ?? story.baseTrackersAtStart ?? [],
      source: {
        type: provenanceCharacterId ? "nexus-campaign-export" : "legacy-campaign-import"
      }
    }],
    rpgStats: [],
    defaultTriggers: [],
    eventTriggers: story.eventTriggers ?? [],
    importedFromLegacyStory: true
  });
}

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

export async function importLegacyStory(
  pool: DatabasePool,
  request: StoryImportRequest,
  assetStore?: FilesystemAssetStore
): Promise<StoryImportResult> {
  const sourceHash = importSourceHash(request);

  return withTransaction(pool, async (client) => {
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

    const initialTrackers = request.story.trackers ?? [];
    const defaultTriggers = request.story.defaultTriggers ?? request.story.baseTrackersAtStart ?? [];
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

      const stateSnapshot = typeof turn.worldStateSnapshot === "object" && turn.worldStateSnapshot !== null
        ? turn.worldStateSnapshot
        : { scratchpad: turn.scratchpadSnapshot ?? "", trackers: turn.trackersSnapshot ?? [] };
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
      const turnId = turnInsert.rows[0]?.id;
      if (!turnId) throw new Error(`Could not create imported turn ${ordinal}.`);

      if (assetStore && turn.imageUrl?.startsWith("data:image/")) {
        const asset = await importTurnImage(client, assetStore, ownerUserId, campaignId, turnId, turn.imageUrl);
        if (asset) await client.query("UPDATE turns SET image_url = $2 WHERE id = $1", [turnId, asset.publicUrl]);
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

    await autoEnableCampaignEmbeddingIfAvailable(client, ownerUserId, campaignId);

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

    return { importId, worldId, worldVersionId, campaignId, duplicate: false, stats };
  });
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
