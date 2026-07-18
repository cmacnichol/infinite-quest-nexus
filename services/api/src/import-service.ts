import type { DatabaseClient, DatabasePool } from "../../../packages/database/src/pool.js";
import { initialOwnerId, withTransaction } from "../../../packages/database/src/pool.js";
import type { LegacyStory, LegacyTurn, StoryImportRequest, StoryImportResult } from "../../../packages/contracts/src/imports.js";
import { buildTurnFictionMemory, formatLegacySummary, turnNarration } from "../../../packages/story-engine/src/chronicle.js";
import { estimateTokens, removeProviderSecrets, sha256, stableStringify } from "../../../packages/domain/src/text.js";
import { importTurnImage, safeExternalImageUrl, type FilesystemAssetStore } from "./asset-service.js";

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

function legacyWorldContent(story: LegacyStory): Record<string, unknown> {
  return {
    schemaVersion: 1,
    world: story.world,
    rpgStats: story.rpgStats ?? [],
    defaultTriggers: story.defaultTriggers ?? story.baseTrackersAtStart ?? [],
    eventTriggers: story.eventTriggers ?? [],
    importedFromLegacyStory: true
  };
}

function sanitizedStoryForHash(story: LegacyStory): Record<string, unknown> {
  const settings = removeProviderSecrets(story.settings);
  delete settings.nexusCampaignId;
  delete settings.nexusCampaignTurnCount;
  delete settings.nexusPendingGeneration;
  return {
    ...story,
    settings
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

export async function importLegacyStory(
  pool: DatabasePool,
  request: StoryImportRequest,
  assetStore?: FilesystemAssetStore
): Promise<StoryImportResult> {
  const sanitizedStory = sanitizedStoryForHash(request.story);
  const sourceHash = sha256(stableStringify(sanitizedStory));

  return withTransaction(pool, async (client) => {
    const ownerUserId = await initialOwnerId(client);
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`${ownerUserId}:${sourceHash}`]);
    const prior = await existingImport(client, ownerUserId, sourceHash);
    if (prior) return duplicateResult(prior);

    const importInsert = await client.query<{ id: string }>(
      `INSERT INTO imports (owner_user_id, source_type, source_name, source_hash, status)
       VALUES ($1, 'legacy_story_json', $2, $3, 'processing')
       RETURNING id`,
      [ownerUserId, request.sourceName, sourceHash]
    );
    const importId = importInsert.rows[0]?.id;
    if (!importId) throw new Error("Could not create the import record.");

    const worldInsert = await client.query<{ id: string }>(
      `INSERT INTO worlds (owner_user_id, title, status)
       VALUES ($1, $2, 'active') RETURNING id`,
      [ownerUserId, worldTitle(request.story)]
    );
    const worldId = worldInsert.rows[0]?.id;
    if (!worldId) throw new Error("Could not create the imported world.");

    const worldVersionInsert = await client.query<{ id: string }>(
      `INSERT INTO world_versions (world_id, owner_user_id, version_number, content, source_hash)
       VALUES ($1, $2, 1, $3, $4) RETURNING id`,
      [worldId, ownerUserId, json(legacyWorldContent(request.story)), sourceHash]
    );
    const worldVersionId = worldVersionInsert.rows[0]?.id;
    if (!worldVersionId) throw new Error("Could not create the imported world version.");

    const sanitizedSettings = removeProviderSecrets(request.story.settings);
    delete sanitizedSettings.nexusCampaignId;
    delete sanitizedSettings.nexusCampaignTurnCount;
    delete sanitizedSettings.nexusPendingGeneration;
    const campaignInsert = await client.query<{ id: string }>(
      `INSERT INTO campaigns (owner_user_id, world_version_id, title, active_turn_number, legacy_settings)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [ownerUserId, worldVersionId, worldTitle(request.story), request.story.turns.length, json(sanitizedSettings)]
    );
    const campaignId = campaignInsert.rows[0]?.id;
    if (!campaignId) throw new Error("Could not create the imported campaign.");

    await client.query(
      `INSERT INTO campaign_state (
         campaign_id, owner_user_id, scratchpad_private, trackers, default_triggers,
         event_triggers, pending_event_triggers, rpg_stats, import_provenance
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        campaignId,
        ownerUserId,
        request.story.scratchpad ?? "",
        json(request.story.trackers ?? []),
        json(request.story.defaultTriggers ?? request.story.baseTrackersAtStart ?? []),
        json(request.story.eventTriggers ?? []),
        json(request.story.pendingEventTriggers ?? []),
        json(request.story.rpgStats ?? []),
        json({
          sourceType: "legacy_story_json",
          sourceName: request.sourceName,
          sourceHash,
          world: request.story.worldImportProvenance ?? null,
          story: request.story.storyImportProvenance ?? null
        })
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
           owner_user_id, campaign_id, turn_number, source_turn_id, action, narration, choices,
           custom_action_suggestion, image_prompt, image_url, mechanics_private,
           state_snapshot_private, model_metadata, import_metadata, accepted_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         RETURNING id`,
        [
          ownerUserId,
          campaignId,
          ordinal,
          turn.id ?? null,
          action,
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
      if (memory.sanitized) sanitizedMemoryCount += 1;
      await client.query(
        `INSERT INTO chronicle_memories (
           owner_user_id, campaign_id, world_version_id, turn_id, memory_kind, ordinal,
           content, token_estimate, importance, entities, metadata
         ) VALUES ($1,$2,$3,$4,'turn_fiction',$5,$6,$7,$8,$9,$10)`,
        [
          ownerUserId,
          campaignId,
          worldVersionId,
          turnId,
          ordinal,
          memory.content,
          memory.tokenEstimate,
          Math.min(1, 0.45 + ordinal / Math.max(20, request.story.turns.length * 2)),
          memory.entities,
          json({ sanitized: memory.sanitized, removedMechanicsSegments: memory.removedMechanicsSegments })
        ]
      );
      memoryCount += 1;
    }

    const legacySummary = formatLegacySummary(request.story.fullHistory);
    const importedSummary = Boolean(legacySummary);
    if (legacySummary) {
      const summaryTokens = estimateTokens(legacySummary);
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
           content, token_estimate, importance, metadata
         ) VALUES ($1,$2,$3,'legacy_summary',0,$4,$5,0.75,$6)`,
        [ownerUserId, campaignId, worldVersionId, legacySummary, summaryTokens, json({ derivedFromLegacyFullHistory: true })]
      );
      memoryCount += 1;
    }

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
