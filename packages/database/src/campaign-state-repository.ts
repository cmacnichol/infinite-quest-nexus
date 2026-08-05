import {
  PUBLIC_GENERATION_FAILURE_CODE,
  PUBLIC_GENERATION_FAILURE_MESSAGE
} from "../../contracts/src/generation.js";
import { z } from "zod";
import {
  campaignSyncSourceProjectionSchema,
  turnSummarySchema
} from "../../contracts/src/client-api.js";
import type {
  BoundedCampaignTurnPagePort,
  CampaignSyncRepositoryPort,
  CampaignSyncSnapshotSource
} from "../../application/src/world-campaign/index.js";
import { WorldCampaignApplicationError } from "../../application/src/world-campaign/index.js";
import { characterLegacyText, effectiveCampaignCharacter } from "../../domain/src/world-characters.js";
import { sha256, stableStringify } from "../../domain/src/text.js";
import { formatNarrationParagraphs } from "../../story-engine/src/narration-formatting.js";
import { readTurnPage } from "./play-loop-read-repository.js";
import type { DatabasePool } from "./pool.js";
import {
  createPostgresWorldCampaignTransactionPort,
  worldCampaignDatabaseClient
} from "./world-campaign-transaction.js";

export type CampaignSyncAdapterCollaborators = Readonly<{
  turnPages: BoundedCampaignTurnPagePort;
}>;

type CampaignTurnReportedCost = Readonly<{
  amount: string;
  currency: string;
  byCategory: Readonly<Record<"story" | "image" | "memory", string>>;
}>;

export type CampaignTurnReportedCostReader = (
  client: DatabasePool,
  ownerUserId: string,
  turnIds: string[]
) => Promise<Map<string, CampaignTurnReportedCost>>;

export type CampaignTurnPageAdapterCollaborators = Readonly<{
  turnReportedCosts: CampaignTurnReportedCostReader;
}>;

type CampaignSyncRow = {
  id: string;
  title: string;
  activeTurnNumber: number;
  worldVersionId: string;
  storyLengthProfile: "brief" | "standard" | "long" | "extended";
  updatedAt: Date | string;
  selectedCharacterId: string | null;
  characterSnapshot: Record<string, unknown> | null;
  characterProfile: Record<string, unknown> | null;
  characterProfileRevision: number;
  legacySettings: Record<string, unknown> | null;
  status: "active" | "archived";
  worldId: string;
  worldTitle: string;
  worldVersionNumber: number;
  worldContent: Record<string, unknown> | string;
  rpgStats: unknown[] | null;
  eventTriggers: unknown[] | null;
  trackers: unknown[] | null;
  pendingGenerationId: string | null;
  pendingGenerationStatus: "queued" | "replacement_queued" | "assessing" | "generating" | "validating" | "committing" | null;
  pendingGenerationAction: string | null;
  pendingGenerationOperationKind: "append" | "replace_latest" | null;
  pendingGenerationExpectedTurnNumber: number | null;
  pendingGenerationReplacementTurnId: string | null;
  pendingGenerationCreatedAt: Date | string | null;
  pendingGenerationUpdatedAt: Date | string | null;
  recoveryId: string | null;
  recoveryStatus: "recoverable" | "failed" | "completed" | null;
  recoveryOperationKind: "append" | "replace_latest" | null;
  recoveryExpectedTurnNumber: number | null;
  recoveryAttempts: number | null;
  recoveryResultTurnId: string | null;
  recoveryReplacementTurnId: string | null;
  recoveryResultIsRecent: boolean | null;
  latestTurnId: string | null;
  latestTurnNumber: number | null;
};

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function publicGenerationError(status: unknown) {
  return ["failed", "recoverable", "cancelled", "discarded"].includes(String(status))
    ? { errorCode: PUBLIC_GENERATION_FAILURE_CODE, errorMessage: PUBLIC_GENERATION_FAILURE_MESSAGE }
    : { errorCode: null, errorMessage: null };
}

function createPostgresCampaignSyncRepository(): CampaignSyncRepositoryPort {
  return {
    async readCampaignSyncSnapshot(transaction, scope): Promise<CampaignSyncSnapshotSource> {
      const client = worldCampaignDatabaseClient(transaction);
      const result = await client.query<CampaignSyncRow>(
        `SELECT c.id, c.title, c.active_turn_number AS "activeTurnNumber", c.world_version_id AS "worldVersionId",
                c.story_length_profile AS "storyLengthProfile", c.updated_at AS "updatedAt",
                c.selected_character_id AS "selectedCharacterId", c.character_snapshot AS "characterSnapshot",
                c.character_profile AS "characterProfile", c.character_profile_revision AS "characterProfileRevision",
                c.legacy_settings AS "legacySettings", c.status,
                w.id AS "worldId", w.title AS "worldTitle", wv.version_number AS "worldVersionNumber",
                wv.content AS "worldContent", cs.rpg_stats AS "rpgStats",
                cs.event_triggers AS "eventTriggers", cs.trackers,
                pending.id AS "pendingGenerationId", pending.status AS "pendingGenerationStatus",
                pending.action AS "pendingGenerationAction", pending.operation_kind AS "pendingGenerationOperationKind",
                pending.expected_turn_number AS "pendingGenerationExpectedTurnNumber",
                pending.replacement_turn_id AS "pendingGenerationReplacementTurnId",
                pending.created_at AS "pendingGenerationCreatedAt", pending.updated_at AS "pendingGenerationUpdatedAt",
                recovery.id AS "recoveryId", recovery.status AS "recoveryStatus",
                recovery.operation_kind AS "recoveryOperationKind",
                recovery.expected_turn_number AS "recoveryExpectedTurnNumber", recovery.attempts AS "recoveryAttempts",
                recovery.result_turn_id AS "recoveryResultTurnId",
                recovery.replacement_turn_id AS "recoveryReplacementTurnId",
                latest_turn.id AS "latestTurnId", latest_turn.turn_number AS "latestTurnNumber",
                (recovery.result_turn_id IS NOT NULL AND EXISTS (
                  SELECT 1 FROM (
                    SELECT recent_turn.id FROM turns recent_turn
                     WHERE recent_turn.campaign_id = c.id
                       AND recent_turn.owner_user_id = c.owner_user_id
                     ORDER BY recent_turn.turn_number DESC, recent_turn.id DESC LIMIT 50
                  ) recent_turn_window WHERE recent_turn_window.id = recovery.result_turn_id
                )) AS "recoveryResultIsRecent"
           FROM campaigns c
           JOIN world_versions wv ON wv.id = c.world_version_id AND wv.owner_user_id = c.owner_user_id
           JOIN worlds w ON w.id = wv.world_id AND w.owner_user_id = c.owner_user_id
           LEFT JOIN campaign_state cs ON cs.campaign_id = c.id AND cs.owner_user_id = c.owner_user_id
           LEFT JOIN LATERAL (
             SELECT id, status, action, operation_kind, replacement_turn_id,
                    expected_turn_number, created_at, updated_at
               FROM generation_jobs
              WHERE campaign_id = c.id AND owner_user_id = c.owner_user_id
                AND status IN ('queued','replacement_queued','assessing','generating','validating','committing')
              ORDER BY created_at DESC LIMIT 1
           ) pending ON true
           LEFT JOIN LATERAL (
             SELECT id, status, operation_kind, expected_turn_number, attempts,
                    result_turn_id, replacement_turn_id
               FROM generation_jobs
              WHERE campaign_id = c.id AND owner_user_id = c.owner_user_id
                AND status IN ('recoverable','failed','completed')
              ORDER BY updated_at DESC, id DESC LIMIT 1
           ) recovery ON true
           LEFT JOIN LATERAL (
             SELECT id, turn_number FROM turns
              WHERE campaign_id = c.id AND owner_user_id = c.owner_user_id
              ORDER BY turn_number DESC, id DESC LIMIT 1
           ) latest_turn ON true
          WHERE c.id = $1 AND c.owner_user_id = $2`,
        [scope.campaignId, scope.ownerUserId]
      );
      const row = result.rows[0];
      if (!row) {
        throw new WorldCampaignApplicationError(
          "not_found",
          "campaign_not_found",
          { campaignId: scope.campaignId }
        );
      }
      const content = typeof row.worldContent === "string"
        ? objectValue(JSON.parse(row.worldContent))
        : objectValue(row.worldContent);
      const overview = objectValue(content.world);
      const effectiveCharacter = effectiveCampaignCharacter(row.characterProfile, row.characterSnapshot);
      const campaign = {
        id: row.id,
        title: row.title,
        activeTurnNumber: row.activeTurnNumber,
        worldVersionId: row.worldVersionId,
        storyLengthProfile: row.storyLengthProfile,
        updatedAt: row.updatedAt,
        selectedCharacterId: row.selectedCharacterId,
        selectedCharacterName: effectiveCharacter.name,
        characterSnapshot: row.characterSnapshot,
        characterProfile: row.characterProfile,
        characterProfileRevision: row.characterProfileRevision,
        status: row.status
      };
      const world = {
        id: row.worldId,
        title: row.worldTitle || String(overview.title || ""),
        versionNumber: row.worldVersionNumber,
        genre: String(overview.genre || ""),
        tone: String(overview.tone || ""),
        premise: String(overview.premise || ""),
        backgroundStory: String(overview.backgroundStory || ""),
        character: characterLegacyText(row.characterProfile, row.characterSnapshot) || "",
        firstAction: String(overview.firstAction || ""),
        rules: String(overview.rules || ""),
        playableCharacters: Array.isArray(content.playableCharacters) ? content.playableCharacters : []
      };
      const settings = objectValue(row.legacySettings);
      const playerConfig = {
        selectedCharacterId: row.selectedCharacterId,
        selectedCharacterName: effectiveCharacter.name,
        characterSnapshot: row.characterSnapshot,
        characterProfile: row.characterProfile,
        characterProfileRevision: row.characterProfileRevision,
        rpgStats: row.rpgStats ?? [],
        trackers: row.trackers ?? [],
        eventTriggers: row.eventTriggers ?? [],
        useRpgStats: Boolean(settings.useRpgStats),
        suppressEventTriggers: Boolean(settings.suppressEventTriggers)
      };
      const pendingBase = row.pendingGenerationId && row.pendingGenerationStatus
        && row.pendingGenerationExpectedTurnNumber !== null && row.pendingGenerationCreatedAt !== null
        && row.pendingGenerationUpdatedAt !== null
        ? {
          id: row.pendingGenerationId,
          status: row.pendingGenerationStatus,
          action: row.pendingGenerationAction || "",
          expectedTurnNumber: row.pendingGenerationExpectedTurnNumber,
          createdAt: row.pendingGenerationCreatedAt,
          updatedAt: row.pendingGenerationUpdatedAt
        }
        : null;
      const pendingGeneration = pendingBase && row.pendingGenerationOperationKind === "append"
        ? { ...pendingBase, operationKind: "append" as const, replacementTurnId: null }
        : pendingBase && row.pendingGenerationOperationKind === "replace_latest"
          && row.pendingGenerationReplacementTurnId
          ? {
            ...pendingBase,
            operationKind: "replace_latest" as const,
            replacementTurnId: row.pendingGenerationReplacementTurnId
          }
          : null;
      const recoveryBase = row.recoveryId && row.recoveryStatus
        && row.recoveryExpectedTurnNumber !== null && row.recoveryAttempts !== null
        && !row.recoveryResultIsRecent
        ? {
          id: row.recoveryId,
          status: row.recoveryStatus,
          expectedTurnNumber: row.recoveryExpectedTurnNumber,
          attempts: row.recoveryAttempts,
          ...publicGenerationError(row.recoveryStatus),
          resultTurnId: row.recoveryResultTurnId
        }
        : null;
      const generationRecovery = recoveryBase && row.recoveryOperationKind === "append"
        ? { ...recoveryBase, operationKind: "append" as const, replacementTurnId: null }
        : recoveryBase && row.recoveryOperationKind === "replace_latest" && row.recoveryReplacementTurnId
          ? {
            ...recoveryBase,
            operationKind: "replace_latest" as const,
            replacementTurnId: row.recoveryReplacementTurnId
          }
          : null;
      let projection;
      try {
        projection = campaignSyncSourceProjectionSchema.parse({
          ...campaign,
          campaign,
          world,
          playerConfig,
          pendingGeneration,
          generationRecovery
        });
      } catch (error) {
        if (error instanceof z.ZodError) {
          throw new WorldCampaignApplicationError(
            "unavailable",
            "invalid_transition",
            { campaignId: scope.campaignId }
          );
        }
        throw error;
      }
      const syncToken = sha256(stableStringify({
        ownerUserId: scope.ownerUserId,
        campaign: projection.campaign,
        world: projection.world,
        playerConfig: projection.playerConfig,
        latestTurnId: row.latestTurnId,
        latestTurnNumber: row.latestTurnNumber,
        pendingGenerationId: pendingGeneration?.id ?? null,
        pendingGenerationStatus: pendingGeneration?.status ?? null,
        pendingGenerationUpdatedAt: pendingGeneration?.updatedAt ?? null,
        recoveryId: generationRecovery?.id ?? null,
        recoveryStatus: generationRecovery?.status ?? null,
        recoveryAttempts: generationRecovery?.attempts ?? null,
        recoveryReplacementTurnId: generationRecovery?.replacementTurnId ?? null
      }));
      return {
        syncToken,
        projection
      };
    }
  };
}

export function createPostgresBoundedCampaignTurnPageAdapter(
  pool: DatabasePool,
  collaborators: CampaignTurnPageAdapterCollaborators,
): BoundedCampaignTurnPagePort {
  return {
    async readTurnPage(scope, request) {
      const page = await readTurnPage(
        pool,
        scope.ownerUserId,
        scope.campaignId,
        request.before,
        request.limit
      );
      const reportedCosts = await collaborators.turnReportedCosts(
        pool,
        scope.ownerUserId,
        page.turns.map((turn) => turn.id)
      );
      return {
        turns: page.turns.map((turn) => turnSummarySchema.parse({
          ...turn,
          narration: formatNarrationParagraphs(turn.narration),
          reportedCost: reportedCosts.get(turn.id) ?? null
        })),
        nextCursor: page.nextCursor
      };
    }
  };
}

export function createPostgresCampaignAuthorityAdapters(
  pool: DatabasePool,
  collaborators: CampaignSyncAdapterCollaborators,
) {
  return {
    transaction: createPostgresWorldCampaignTransactionPort(pool),
    sync: createPostgresCampaignSyncRepository(),
    turnPages: collaborators.turnPages
  };
}
