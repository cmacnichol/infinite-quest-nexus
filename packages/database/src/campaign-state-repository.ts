import {
  campaignBranchSchema,
  campaignRewindSchema,
  campaignRuntimeStateContentSchema,
  campaignRuntimeStateSchema,
  campaignRuntimeStateUpdateSchema,
  playerCampaignConfigSchema,
  recordedResolutionSchema,
  PUBLIC_GENERATION_FAILURE_CODE,
  PUBLIC_GENERATION_FAILURE_MESSAGE,
  type CampaignRuntimeStateContent
} from "../../contracts/src/generation.js";
import { storyContextBudgetTokensSchema } from "../../contracts/src/story-settings.js";
import { z } from "zod";
import {
  campaignSyncSourceProjectionSchema,
  turnSummarySchema
} from "../../contracts/src/client-api.js";
import type {
  BoundedCampaignTurnPagePort,
  CampaignRepositoryPort,
  CampaignScope,
  CampaignStateEditSource,
  CampaignStateRepositoryPort,
  CampaignSyncRepositoryPort,
  CampaignSyncSnapshotSource,
  WorldCampaignErrorDetails,
  WorldCampaignRepositoryResult,
  WorldCampaignTransitionFailureReason
} from "../../application/src/world-campaign/index.js";
import { WorldCampaignApplicationError } from "../../application/src/world-campaign/index.js";
import type {
  CampaignWorldVersionMemoryScope,
  MemoryGenerationTransactionPort
} from "../../application/src/memory/index.js";
import {
  normalizeCampaignStateSnapshot,
  normalizeCampaignTrackers
} from "../../domain/src/campaign-trackers.js";
import { characterLegacyText, effectiveCampaignCharacter } from "../../domain/src/world-characters.js";
import { containsMechanicsLanguage, sha256, stableStringify } from "../../domain/src/text.js";
import { formatNarrationParagraphs } from "../../story-engine/src/narration-formatting.js";
import {
  preseedAcceptedTurnSnapshotFactIds,
  remapAcceptedTurnSnapshotFactReferences,
  remapCorrectionSnapshotFactIds
} from "./canonical-fact-reference-remapping.js";
import { readTurnPage } from "./play-loop-read-repository.js";
import type { DatabaseClient, DatabasePool } from "./pool.js";
import {
  createPostgresWorldCampaignTransactionPort,
  worldCampaignDatabaseClient
} from "./world-campaign-transaction.js";

export type CampaignSyncAdapterCollaborators = Readonly<{
  turnPages: BoundedCampaignTurnPagePort;
  memory: Pick<
    MemoryGenerationTransactionPort,
    "autoEnableCampaignEmbedding" | "enqueueEmbeddingReindex" | "enqueueChunkIndex" | "rebuildCampaignMemories" | "applyCampaignStateCorrection"
  >;
}>;

async function enqueueChunkIndexBestEffort(
  client: DatabaseClient,
  memory: CampaignSyncAdapterCollaborators["memory"],
  scope: CampaignWorldVersionMemoryScope,
): Promise<void> {
  await client.query("SAVEPOINT campaign_lifecycle_chunk_enqueue");
  try {
    await memory.enqueueChunkIndex(client, scope);
    await client.query("RELEASE SAVEPOINT campaign_lifecycle_chunk_enqueue");
  } catch {
    await client.query("ROLLBACK TO SAVEPOINT campaign_lifecycle_chunk_enqueue");
    await client.query("RELEASE SAVEPOINT campaign_lifecycle_chunk_enqueue");
  }
}

type PostgresCampaignAuthorityRepository = Pick<
  CampaignRepositoryPort,
  "branchCampaign" | "rewindCampaign" | "syncPlayerCampaignConfig"
>;

const campaignPlayerConfigSyncRequestSchema = playerCampaignConfigSchema.extend({
  expectedStateRevision: z.coerce.number().int().min(0)
});

const campaignRewindRequestSchema = campaignRewindSchema.extend({
  expectedCurrentTurnNumber: z.coerce.number().int().min(0),
  expectedStateRevision: z.coerce.number().int().min(0)
});

const campaignBranchRequestSchema = campaignBranchSchema;

const branchCampaignRowSchema = z.object({
  activeTurnNumber: z.number().int().min(0),
  worldVersionId: z.uuid(),
  title: z.string().trim().min(1),
  storyLengthProfile: z.enum(["brief", "standard", "long", "extended"]),
  storyContextBudgetTokens: storyContextBudgetTokensSchema,
  turnControlStyle: z.enum(["action_only", "flexible_auto", "flexible_action", "flexible_scene"]),
  selectedCharacterId: z.string().nullable(),
  characterSnapshot: z.record(z.string(), z.unknown()).nullable(),
  characterProfile: z.record(z.string(), z.unknown()).nullable(),
  characterProfileRevision: z.number().int().min(0),
  legacySettings: z.record(z.string(), z.unknown()),
  textProviderProfileId: z.uuid().nullable(),
  imageProviderProfileId: z.uuid().nullable(),
  stateRevision: z.number().int().min(0),
  defaultTriggers: z.unknown(),
  initialStateSnapshot: z.record(z.string(), z.unknown()),
  importProvenance: z.record(z.string(), z.unknown())
});

const branchTurnRowSchema = z.object({
  id: z.uuid(),
  turnNumber: z.number().int().positive(),
  stateSnapshotPrivate: z.record(z.string(), z.unknown()),
  modelMetadata: z.record(z.string(), z.unknown()),
  importMetadata: z.record(z.string(), z.unknown())
});

const branchStateEditRowSchema = z.object({
  id: z.uuid(),
  effectiveTurnNumber: z.number().int().min(0),
  revision: z.number().int().positive(),
  stateSnapshotPrivate: z.record(z.string(), z.unknown())
});

type CampaignStateRow = {
  activeTurnNumber: number;
  worldVersionId: string;
  revision: number;
  scratchpadPrivate: string;
  trackers: unknown;
  rpgStats: unknown;
  eventTriggers: unknown;
  pendingEventTriggers: unknown;
  initialStateSnapshot: Record<string, unknown>;
  updatedAt: Date | string;
};

type CampaignStateEditRow = {
  id: string;
  revision: number;
  effectiveTurnNumber: number;
  stateSnapshotPrivate: Record<string, unknown>;
  createdAt: Date | string;
};

type CanonicalFactRow = {
  id: string;
  content: string;
  sourceTurnNumber: number;
};

function json(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function success<T>(value: T): WorldCampaignRepositoryResult<T> {
  return { ok: true, value };
}

function failure(
  reason: WorldCampaignTransitionFailureReason,
  details?: WorldCampaignErrorDetails,
): WorldCampaignRepositoryResult<never> {
  return details === undefined
    ? { ok: false, failure: { reason } }
    : { ok: false, failure: { reason, details } };
}

function invalidBoundaryData(
  kind: "invalid_request" | "unavailable",
  scope: CampaignScope,
): never {
  throw new WorldCampaignApplicationError(kind, "invalid_transition", {
    campaignId: scope.campaignId
  });
}

function parseBoundary<T>(
  schema: z.ZodType<T>,
  value: unknown,
  kind: "invalid_request" | "unavailable",
  scope: CampaignScope,
): T {
  try {
    return schema.parse(value);
  } catch (error) {
    if (error instanceof z.ZodError) invalidBoundaryData(kind, scope);
    throw error;
  }
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function publicRecordedResolution(value: unknown) {
  const roll = objectValue(objectValue(value).roll);
  const parsed = recordedResolutionSchema.safeParse({
    statName: roll.statName,
    base: roll.base,
    modifier: roll.modifier,
    target: roll.target,
    roll: roll.roll,
    success: roll.success,
    margin: roll.margin,
    difficultyLabel: roll.difficultyLabel
  });
  return parsed.success ? parsed.data : null;
}

function persistedTrackers(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return value.some((entry) => entry && typeof entry === "object" && "id" in entry)
    ? value
    : normalizeCampaignTrackers(value);
}

function persistedCanonicalFacts(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return value.map((fact) => {
    if (typeof fact === "string") return { id: null, content: fact };
    return fact;
  });
}

function runtimeStateContent(
  snapshot: unknown,
  canonicalFacts: readonly Readonly<{ id: string | null; content: string }>[] | undefined,
  scope: CampaignScope,
): CampaignRuntimeStateContent {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    invalidBoundaryData("unavailable", scope);
  }
  const source = snapshot as Record<string, unknown>;
  const candidate = {
    continuitySummary: source.continuitySummary ?? "",
    openThreads: source.openThreads ?? [],
    canonicalFacts: canonicalFacts !== undefined
      ? canonicalFacts
      : persistedCanonicalFacts(source.canonicalFacts ?? []),
    scratchpad: source.scratchpad ?? "",
    trackers: persistedTrackers(source.trackers ?? []),
    rpgStats: source.rpgStats ?? [],
    eventTriggers: source.eventTriggers ?? [],
    pendingEventTriggers: source.pendingEventTriggers ?? []
  };
  return parseBoundary(campaignRuntimeStateContentSchema, candidate, "unavailable", scope);
}

function fictionFields(content: CampaignRuntimeStateContent): readonly string[] {
  return [
    content.continuitySummary,
    ...content.openThreads,
    ...content.canonicalFacts.map((fact) => fact.content),
    content.scratchpad,
    ...content.trackers.flatMap((tracker) => [tracker.name, tracker.value, tracker.rules])
  ];
}

async function activeCanonicalFacts(
  client: DatabaseClient | DatabasePool,
  scope: CampaignScope,
  throughTurnNumber: number,
): Promise<CanonicalFactRow[]> {
  const result = await client.query<CanonicalFactRow>(
    `SELECT id, content, source_turn_number AS "sourceTurnNumber"
       FROM campaign_canonical_facts
      WHERE owner_user_id = $1 AND campaign_id = $2
        AND valid_from_turn <= $3
        AND (valid_until_turn IS NULL OR valid_until_turn > $3)
      ORDER BY source_turn_number, source_fact_index`,
    [scope.ownerUserId, scope.campaignId, throughTurnNumber]
  );
  return result.rows;
}

async function loadStateRow(
  client: DatabaseClient | DatabasePool,
  scope: CampaignScope,
  lock = false,
): Promise<CampaignStateRow | null> {
  const result = await client.query<CampaignStateRow>(
    `SELECT c.active_turn_number AS "activeTurnNumber", c.world_version_id AS "worldVersionId",
            cs.revision, cs.scratchpad_private AS "scratchpadPrivate", cs.trackers,
            cs.rpg_stats AS "rpgStats", cs.event_triggers AS "eventTriggers",
            cs.pending_event_triggers AS "pendingEventTriggers",
            cs.initial_state_snapshot AS "initialStateSnapshot", cs.updated_at AS "updatedAt"
       FROM campaigns c
       JOIN campaign_state cs ON cs.campaign_id = c.id AND cs.owner_user_id = c.owner_user_id
      WHERE c.id = $1 AND c.owner_user_id = $2
      ${lock ? "FOR UPDATE OF c, cs" : ""}`,
    [scope.campaignId, scope.ownerUserId]
  );
  return result.rows[0] ?? null;
}

async function loadEffectiveStateEdit(
  client: DatabaseClient | DatabasePool,
  scope: CampaignScope,
  throughTurnNumber: number,
): Promise<CampaignStateEditRow | null> {
  const result = await client.query<CampaignStateEditRow>(
    `SELECT id, revision, effective_turn_number AS "effectiveTurnNumber",
            state_snapshot_private AS "stateSnapshotPrivate", created_at AS "createdAt"
       FROM campaign_state_edits
      WHERE owner_user_id = $1 AND campaign_id = $2 AND effective_turn_number <= $3
      ORDER BY effective_turn_number DESC, revision DESC
      LIMIT 1`,
    [scope.ownerUserId, scope.campaignId, throughTurnNumber]
  );
  return result.rows[0] ?? null;
}

async function loadRuntimeState(
  client: DatabaseClient | DatabasePool,
  scope: CampaignScope,
  requestedTurnNumber?: number,
  includeRecordedResolution = false,
) {
  const row = await loadStateRow(client, scope);
  if (!row) {
    throw new WorldCampaignApplicationError("not_found", "campaign_not_found", {
      campaignId: scope.campaignId
    });
  }
  const viewedTurnNumber = requestedTurnNumber ?? row.activeTurnNumber;
  if (!Number.isInteger(viewedTurnNumber) || viewedTurnNumber < 0 || viewedTurnNumber > row.activeTurnNumber) {
    throw new WorldCampaignApplicationError("stale_state", "active_turn_changed", {
      campaignId: scope.campaignId,
      expectedTurnNumber: viewedTurnNumber,
      actualTurnNumber: row.activeTurnNumber
    });
  }
  const historical = viewedTurnNumber > 0
    ? await client.query<{ stateSnapshotPrivate: Record<string, unknown>; mechanicsPrivate?: unknown; acceptedAt: Date | string }>(
      includeRecordedResolution
        ? `SELECT state_snapshot_private AS "stateSnapshotPrivate", mechanics_private AS "mechanicsPrivate", accepted_at AS "acceptedAt"
         FROM turns
        WHERE owner_user_id = $1 AND campaign_id = $2 AND turn_number = $3`
        : `SELECT state_snapshot_private AS "stateSnapshotPrivate", accepted_at AS "acceptedAt"
         FROM turns
        WHERE owner_user_id = $1 AND campaign_id = $2 AND turn_number = $3`,
      [scope.ownerUserId, scope.campaignId, viewedTurnNumber]
    )
    : null;
  if (viewedTurnNumber > 0 && !historical?.rows[0]) {
    throw new WorldCampaignApplicationError("not_found", "invalid_transition", {
      campaignId: scope.campaignId,
      expectedTurnNumber: viewedTurnNumber
    });
  }
  const baseSnapshot = viewedTurnNumber === 0
    ? row.initialStateSnapshot
    : historical?.rows[0]?.stateSnapshotPrivate;
  if (!baseSnapshot || typeof baseSnapshot !== "object" || Array.isArray(baseSnapshot)) {
    invalidBoundaryData("unavailable", scope);
  }
  const edit = await loadEffectiveStateEdit(client, scope, viewedTurnNumber);
  const exactEdit = edit?.effectiveTurnNumber === viewedTurnNumber ? edit : null;
  const canonicalFacts = exactEdit
    ? undefined
    : (await activeCanonicalFacts(client, scope, viewedTurnNumber))
      .map((fact) => ({ id: fact.id, content: fact.content }));
  const materializedSnapshot = viewedTurnNumber === row.activeTurnNumber && !exactEdit
    ? {
      ...objectValue(baseSnapshot),
      scratchpad: row.scratchpadPrivate,
      trackers: row.trackers,
      rpgStats: row.rpgStats,
      eventTriggers: row.eventTriggers,
      pendingEventTriggers: row.pendingEventTriggers
    }
    : baseSnapshot;
  const content = runtimeStateContent(
    exactEdit?.stateSnapshotPrivate ?? materializedSnapshot,
    canonicalFacts,
    scope
  );
  return parseBoundary(campaignRuntimeStateSchema, {
    campaignId: scope.campaignId,
    activeTurnNumber: row.activeTurnNumber,
    viewedTurnNumber,
    isCurrent: viewedTurnNumber === row.activeTurnNumber,
    revision: row.revision,
    updatedAt: exactEdit?.createdAt ?? historical?.rows[0]?.acceptedAt ?? row.updatedAt,
    recordedResolution: includeRecordedResolution && viewedTurnNumber > 0
      ? publicRecordedResolution(historical?.rows[0]?.mechanicsPrivate)
      : null,
    ...content
  }, "unavailable", scope);
}

function createPostgresCampaignStateRepository(
  collaborators: Pick<CampaignSyncAdapterCollaborators, "memory">,
): CampaignStateRepositoryPort {
  return {
    async loadEffectiveCampaignStateEdit(transaction, scope): Promise<CampaignStateEditSource> {
      const client = worldCampaignDatabaseClient(transaction);
      const state = await loadStateRow(client, scope);
      if (!state) {
        throw new WorldCampaignApplicationError("not_found", "campaign_not_found", {
          campaignId: scope.campaignId
        });
      }
      const row = await loadEffectiveStateEdit(client, scope, state.activeTurnNumber);
      if (!row) invalidBoundaryData("unavailable", scope);
      return {
        id: row.id,
        revision: row.revision,
        effectiveTurnNumber: row.effectiveTurnNumber,
        snapshot: runtimeStateContent(row.stateSnapshotPrivate, undefined, scope),
        updatedAt: row.createdAt
      };
    },

    async getCampaignRuntimeState(transaction, scope, requestedTurnNumber, includeRecordedResolution = false) {
      return loadRuntimeState(worldCampaignDatabaseClient(transaction), scope, requestedTurnNumber, includeRecordedResolution);
    },

    async updateCampaignRuntimeState(transaction, scope, request) {
      const client = worldCampaignDatabaseClient(transaction);
      const parsed = parseBoundary(campaignRuntimeStateUpdateSchema, request, "invalid_request", scope);
      const content = campaignRuntimeStateContentSchema.parse(parsed);
      if (fictionFields(content).some(containsMechanicsLanguage)) {
        return failure("invalid_transition", { campaignId: scope.campaignId });
      }
      const current = await loadStateRow(client, scope, true);
      if (!current) return failure("campaign_not_found", { campaignId: scope.campaignId });
      if (current.activeTurnNumber !== parsed.expectedTurnNumber) {
        return failure("active_turn_changed", {
          campaignId: scope.campaignId,
          expectedTurnNumber: parsed.expectedTurnNumber,
          actualTurnNumber: current.activeTurnNumber
        });
      }
      if (current.revision !== parsed.expectedRevision) {
        return failure("state_revision_changed", {
          campaignId: scope.campaignId,
          expectedStateRevision: parsed.expectedRevision,
          actualStateRevision: current.revision
        });
      }
      const effectiveTurnNumber = parsed.effectiveTurnNumber ?? parsed.expectedTurnNumber;
      if (effectiveTurnNumber !== current.activeTurnNumber) {
        return failure("active_turn_changed", {
          campaignId: scope.campaignId,
          expectedTurnNumber: effectiveTurnNumber,
          actualTurnNumber: current.activeTurnNumber
        });
      }
      const activeJob = await client.query(
        `SELECT 1 FROM generation_jobs
          WHERE campaign_id = $1 AND owner_user_id = $2
            AND status IN ('queued','replacement_queued','assessing','generating','validating','committing','recoverable')
          LIMIT 1`,
        [scope.campaignId, scope.ownerUserId]
      );
      if (activeJob.rowCount) return failure("invalid_transition", { campaignId: scope.campaignId });

      const accepted = current.activeTurnNumber === 0
        ? null
        : await client.query<{ stateSnapshotPrivate: Record<string, unknown> }>(
          `SELECT state_snapshot_private AS "stateSnapshotPrivate"
             FROM turns
            WHERE owner_user_id = $1 AND campaign_id = $2 AND turn_number = $3`,
          [scope.ownerUserId, scope.campaignId, current.activeTurnNumber]
        );
      const acceptedSnapshot = current.activeTurnNumber === 0
        ? current.initialStateSnapshot
        : accepted?.rows[0]?.stateSnapshotPrivate;
      if (!acceptedSnapshot || typeof acceptedSnapshot !== "object" || Array.isArray(acceptedSnapshot)) {
        invalidBoundaryData("unavailable", scope);
      }
      const priorEdit = await loadEffectiveStateEdit(client, scope, current.activeTurnNumber);
      const exactPriorEdit = priorEdit?.effectiveTurnNumber === current.activeTurnNumber ? priorEdit : null;
      const targetSnapshot = exactPriorEdit?.stateSnapshotPrivate ?? acceptedSnapshot;

      const persistedFacts = await activeCanonicalFacts(client, scope, current.activeTurnNumber);
      const existingFacts = persistedFacts;
      const existingById = new Map(existingFacts.map((fact) => [fact.id, fact]));
      const usedIds = new Set<string>();
      const correctedFacts: Array<{ id: string; content: string }> = [];
      for (const fact of content.canonicalFacts) {
        const existing = fact.id ? existingById.get(fact.id) : undefined;
        if (fact.id && !existing) {
          return failure("fact_not_found", { campaignId: scope.campaignId, factId: fact.id });
        }
        const id = existing && existing.content === fact.content
          ? existing.id
          : existing && existing.sourceTurnNumber === effectiveTurnNumber
            ? existing.id
            : crypto.randomUUID();
        if (usedIds.has(id)) {
          return failure("fact_id_conflict", { campaignId: scope.campaignId, factId: id });
        }
        usedIds.add(id);
        correctedFacts.push({ id, content: fact.content });
      }
      const correctedContent = { ...content, canonicalFacts: correctedFacts };
      const currentContent = runtimeStateContent({
        ...objectValue(targetSnapshot),
        scratchpad: current.scratchpadPrivate,
        trackers: current.trackers,
        rpgStats: current.rpgStats,
        eventTriggers: current.eventTriggers,
        pendingEventTriggers: current.pendingEventTriggers
      }, exactPriorEdit ? undefined : existingFacts.map((fact) => ({ id: fact.id, content: fact.content })), scope);
      const changedFields = (Object.keys(correctedContent) as Array<keyof CampaignRuntimeStateContent>)
        .filter((field) => json(correctedContent[field]) !== json(currentContent[field]));
      if (!changedFields.length) {
        return success(await loadRuntimeState(client, scope));
      }

      const nextRevision = current.revision + 1;
      const snapshot = { ...objectValue(targetSnapshot), ...correctedContent };
      const editId = crypto.randomUUID();
      await client.query(
        `UPDATE campaign_state
          SET scratchpad_private = $3, scratchpad_safe_for_prompt = true,
              trackers = $4, rpg_stats = $5, event_triggers = $6,
              pending_event_triggers = $7, revision = $8, updated_at = now()
         WHERE campaign_id = $1 AND owner_user_id = $2`,
        [
          scope.campaignId,
          scope.ownerUserId,
          correctedContent.scratchpad,
          json(correctedContent.trackers),
          json(correctedContent.rpgStats),
          json(correctedContent.eventTriggers),
          json(correctedContent.pendingEventTriggers),
          nextRevision
        ]
      );
      if (current.activeTurnNumber === 0) {
        await client.query(
          `UPDATE campaign_state SET initial_state_snapshot = $3
            WHERE campaign_id = $1 AND owner_user_id = $2`,
          [scope.campaignId, scope.ownerUserId, json(snapshot)]
        );
      }
      await client.query(
        `INSERT INTO campaign_state_edits (
           id, owner_user_id, campaign_id, effective_turn_number, revision,
           state_snapshot_private, changed_fields
         ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          editId,
          scope.ownerUserId,
          scope.campaignId,
          effectiveTurnNumber,
          nextRevision,
          json(snapshot),
          json(changedFields)
        ]
      );
      if (effectiveTurnNumber === current.activeTurnNumber) {
        const memoryScope = {
          ownerUserId: scope.ownerUserId,
          campaignId: scope.campaignId,
          worldVersionId: current.worldVersionId
        };
        const memoryChanges = await collaborators.memory.applyCampaignStateCorrection(client, { ...memoryScope, stateEditId: editId });
        if (memoryChanges.changedMemoryIds.length || memoryChanges.removedMemoryIds.length) {
          await collaborators.memory.enqueueEmbeddingReindex(client, memoryScope);
          await collaborators.memory.enqueueChunkIndex(client, memoryScope);
        }
        await client.query(
          "DELETE FROM model_chains WHERE campaign_id = $1 AND owner_user_id = $2",
          [scope.campaignId, scope.ownerUserId]
        );
      }
      await client.query(
        `INSERT INTO activity_events (owner_user_id, campaign_id, event_type, details)
         VALUES ($1,$2,'campaign_state_edited',$3)`,
        [scope.ownerUserId, scope.campaignId, json({
          effectiveTurnNumber,
          fromRevision: current.revision,
          toRevision: nextRevision,
          changedFields
        })]
      );
      return success(await loadRuntimeState(client, scope));
    }
  };
}

function createPostgresCampaignAuthorityRepository(
  collaborators: Pick<CampaignSyncAdapterCollaborators, "memory">,
): PostgresCampaignAuthorityRepository {
  return {
    async branchCampaign(transaction, scope, request) {
      const client = worldCampaignDatabaseClient(transaction);
      const parsed = parseBoundary(campaignBranchRequestSchema, request, "invalid_request", scope);
      const sourceResult = await client.query<Record<string, unknown>>(
        `SELECT c.active_turn_number AS "activeTurnNumber",
                c.world_version_id AS "worldVersionId", c.title,
                c.story_length_profile AS "storyLengthProfile",
                c.story_context_budget_tokens AS "storyContextBudgetTokens",
                c.turn_control_style AS "turnControlStyle",
                c.selected_character_id AS "selectedCharacterId",
                c.character_snapshot AS "characterSnapshot",
                c.character_profile AS "characterProfile",
                c.character_profile_revision AS "characterProfileRevision",
                c.legacy_settings AS "legacySettings",
                c.text_provider_profile_id AS "textProviderProfileId",
                c.image_provider_profile_id AS "imageProviderProfileId",
                cs.revision AS "stateRevision", cs.default_triggers AS "defaultTriggers",
                cs.initial_state_snapshot AS "initialStateSnapshot",
                cs.import_provenance AS "importProvenance"
           FROM campaigns c
           JOIN campaign_state cs
             ON cs.campaign_id = c.id AND cs.owner_user_id = c.owner_user_id
          WHERE c.id = $1 AND c.owner_user_id = $2
          FOR UPDATE OF c, cs`,
        [scope.campaignId, scope.ownerUserId]
      );
      if (!sourceResult.rows[0]) {
        return failure("campaign_not_found", { campaignId: scope.campaignId });
      }
      const source = parseBoundary(
        branchCampaignRowSchema,
        sourceResult.rows[0],
        "unavailable",
        scope
      );
      if (parsed.expectedCurrentTurnNumber !== undefined
        && parsed.expectedCurrentTurnNumber !== source.activeTurnNumber) {
        return failure("active_turn_changed", {
          campaignId: scope.campaignId,
          expectedTurnNumber: parsed.expectedCurrentTurnNumber,
          actualTurnNumber: source.activeTurnNumber
        });
      }
      if (parsed.targetTurnNumber > source.activeTurnNumber) {
        return failure("invalid_transition", {
          campaignId: scope.campaignId,
          expectedTurnNumber: parsed.targetTurnNumber,
          actualTurnNumber: source.activeTurnNumber
        });
      }

      const sourceTurnsResult = parsed.targetTurnNumber === 0
        ? { rows: [] as Record<string, unknown>[] }
        : await client.query<Record<string, unknown>>(
          `SELECT id, turn_number AS "turnNumber",
                  state_snapshot_private AS "stateSnapshotPrivate",
                  model_metadata AS "modelMetadata", import_metadata AS "importMetadata"
             FROM turns
            WHERE campaign_id = $1 AND owner_user_id = $2 AND turn_number <= $3
            ORDER BY turn_number
            FOR SHARE`,
          [scope.campaignId, scope.ownerUserId, parsed.targetTurnNumber]
        );
      const sourceTurns = sourceTurnsResult.rows.map((row) => parseBoundary(
        branchTurnRowSchema,
        row,
        "unavailable",
        scope
      ));
      if (sourceTurns.length !== parsed.targetTurnNumber
        || sourceTurns.some((turn, index) => turn.turnNumber !== index + 1)) {
        return failure("invalid_transition", {
          campaignId: scope.campaignId,
          expectedTurnNumber: parsed.targetTurnNumber
        });
      }

      const sourceEditsResult = await client.query<Record<string, unknown>>(
        `SELECT id, effective_turn_number AS "effectiveTurnNumber", revision,
                state_snapshot_private AS "stateSnapshotPrivate"
           FROM campaign_state_edits
          WHERE campaign_id = $1 AND owner_user_id = $2 AND effective_turn_number <= $3
          ORDER BY revision
          FOR SHARE`,
        [scope.campaignId, scope.ownerUserId, parsed.targetTurnNumber]
      );
      const sourceEdits = sourceEditsResult.rows.map((row) => parseBoundary(
        branchStateEditRowSchema,
        row,
        "unavailable",
        scope
      ));
      const destinationFactIds = new Map<string, string>();
      const targetTurn = sourceTurns.at(-1);
      const targetEdit = [...sourceEdits]
        .reverse()
        .find((edit) => edit.effectiveTurnNumber === parsed.targetTurnNumber);
      const targetSnapshot = targetEdit?.stateSnapshotPrivate
        ?? targetTurn?.stateSnapshotPrivate
        ?? source.initialStateSnapshot;
      const materializedTarget = runtimeStateContent({
        ...targetSnapshot,
        scratchpad: typeof targetSnapshot.scratchpad === "string" ? targetSnapshot.scratchpad : "",
        trackers: targetSnapshot.trackers ?? [],
        eventTriggers: targetSnapshot.eventTriggers ?? [],
        pendingEventTriggers: targetSnapshot.pendingEventTriggers ?? [],
        rpgStats: targetSnapshot.rpgStats ?? []
      }, undefined, scope);
      const branchId = crypto.randomUUID();
      const branchProvenance = {
        sourceType: "nexus_campaign_branch",
        branchId,
        parentCampaignId: scope.campaignId,
        branchTurnNumber: parsed.targetTurnNumber,
        ...(source.importProvenance.branch === undefined
          ? {}
          : { parent: source.importProvenance.branch })
      };
      const title = parsed.title?.trim()
        || `${source.title} (Branch Turn ${parsed.targetTurnNumber})`;
      const branchCampaign = await client.query<{ id: string }>(
        `INSERT INTO campaigns (
           owner_user_id, world_version_id, title, status, active_turn_number,
           story_length_profile, story_context_budget_tokens, turn_control_style, selected_character_id,
           character_snapshot, character_profile, character_profile_revision,
           legacy_settings, text_provider_profile_id, image_provider_profile_id
         ) VALUES ($1,$2,$3,'active',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         RETURNING id`,
        [
          scope.ownerUserId,
          source.worldVersionId,
          title,
          parsed.targetTurnNumber,
          source.storyLengthProfile,
          source.storyContextBudgetTokens,
          source.turnControlStyle,
          source.selectedCharacterId,
          json(source.characterSnapshot),
          source.characterProfile === null ? null : json(source.characterProfile),
          source.characterProfile === null ? 0 : 1,
          json(source.legacySettings),
          source.textProviderProfileId,
          source.imageProviderProfileId
        ]
      );
      const branchCampaignId = branchCampaign.rows[0]?.id;
      if (!branchCampaignId) invalidBoundaryData("unavailable", scope);
      const copiedTurns = sourceTurns.map((turn) => {
        const id = crypto.randomUUID();
        preseedAcceptedTurnSnapshotFactIds(turn.stateSnapshotPrivate, {
          sourceCampaignId: scope.campaignId,
          sourceTurnId: turn.id,
          destinationCampaignId: branchCampaignId,
          destinationTurnId: id,
          factIds: destinationFactIds
        });
        return {
          sourceId: turn.id,
          id,
          stateSnapshotPrivate: turn.stateSnapshotPrivate
        };
      });
      const normalizedStateEdits = sourceEdits.map((edit) => ({
        sourceId: edit.id,
        id: crypto.randomUUID(),
        revision: edit.revision,
        stateSnapshotPrivate: remapCorrectionSnapshotFactIds(
          normalizeCampaignStateSnapshot(edit.stateSnapshotPrivate),
          destinationFactIds,
          () => crypto.randomUUID()
        )
      }));
      const normalizedTurns = copiedTurns.map((turn) => ({
        ...turn,
        stateSnapshotPrivate: remapAcceptedTurnSnapshotFactReferences(turn.stateSnapshotPrivate, {
          sourceCampaignId: scope.campaignId,
          sourceTurnId: turn.sourceId,
          destinationCampaignId: branchCampaignId,
          destinationTurnId: turn.id,
          factIds: destinationFactIds
        })
      }));

      if (source.characterProfile !== null) {
        await client.query(
          `INSERT INTO campaign_character_profile_edits (
             owner_user_id, campaign_id, revision, previous_profile, next_profile, edit_source
           ) VALUES ($1,$2,1,NULL,$3,'branch')`,
          [scope.ownerUserId, branchCampaignId, json(source.characterProfile)]
        );
      }
      const branchStateRevision = sourceEdits.reduce(
        (revision, edit) => Math.max(revision, edit.revision),
        0
      );
      const initialStateSnapshot = normalizeCampaignStateSnapshot(source.initialStateSnapshot);
      await client.query(
        `INSERT INTO campaign_state (
           campaign_id, owner_user_id, scratchpad_private, scratchpad_safe_for_prompt,
           trackers, default_triggers, event_triggers, pending_event_triggers, rpg_stats,
           import_provenance, initial_state_snapshot, revision
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          branchCampaignId,
          scope.ownerUserId,
          materializedTarget.scratchpad,
          targetEdit !== undefined
            || typeof targetTurn?.modelMetadata.promptProtocolVersion === "string",
          json(materializedTarget.trackers),
          json(normalizeCampaignTrackers(source.defaultTriggers)),
          json(materializedTarget.eventTriggers),
          json(materializedTarget.pendingEventTriggers),
          json(materializedTarget.rpgStats),
          json({ ...source.importProvenance, branch: branchProvenance }),
          json(initialStateSnapshot),
          branchStateRevision
        ]
      );
      if (sourceEdits.length) {
        await client.query(
          `INSERT INTO campaign_state_edits (
             id, owner_user_id, campaign_id, effective_turn_number, revision,
             state_snapshot_private, changed_fields, created_at
           )
            SELECT normalized.id, source.owner_user_id, $1, source.effective_turn_number, source.revision,
                   normalized."stateSnapshotPrivate", source.changed_fields, source.created_at
             FROM campaign_state_edits source
             JOIN jsonb_to_recordset($5::jsonb) AS normalized(
               "sourceId" uuid,
               id uuid,
               revision integer,
               "stateSnapshotPrivate" jsonb
             ) ON normalized."sourceId" = source.id
            WHERE source.campaign_id = $2
              AND source.owner_user_id = $3
              AND source.effective_turn_number <= $4
            ORDER BY source.revision`,
          [
            branchCampaignId,
            scope.campaignId,
            scope.ownerUserId,
            parsed.targetTurnNumber,
            json(normalizedStateEdits)
          ]
        );
      }
      await client.query(
        `INSERT INTO campaign_illustration_configs (
           campaign_id, owner_user_id, enabled, source_policy, matching_scope,
           confidence_profile, repetition_window, provider_profile_id, model, size,
           aspect_ratio, quality, output_format, max_attempts, segment_word_count,
           images_per_segment, segment_prompt_mode, refinement_prompt
         )
         SELECT $1, owner_user_id, enabled, source_policy, matching_scope,
                confidence_profile, repetition_window, provider_profile_id, model, size,
                aspect_ratio, quality, output_format, max_attempts, segment_word_count,
                images_per_segment, segment_prompt_mode, refinement_prompt
           FROM campaign_illustration_configs
          WHERE campaign_id = $2 AND owner_user_id = $3
         ON CONFLICT DO NOTHING`,
        [branchCampaignId, scope.campaignId, scope.ownerUserId]
      );
      await client.query(
        `INSERT INTO campaign_memory_configs (
           campaign_id, owner_user_id, embedding_enabled, embedding_provider_profile_id,
           embedding_model, embedding_batch_size, embedding_document_prefix,
           embedding_query_prefix, retrieval_implementation, retrieval_shadow_enabled
         )
         SELECT $1, owner_user_id, embedding_enabled, embedding_provider_profile_id,
                embedding_model, embedding_batch_size, embedding_document_prefix,
                embedding_query_prefix, retrieval_implementation, retrieval_shadow_enabled
           FROM campaign_memory_configs
          WHERE campaign_id = $2 AND owner_user_id = $3
         ON CONFLICT DO NOTHING`,
        [branchCampaignId, scope.campaignId, scope.ownerUserId]
      );
      await collaborators.memory.autoEnableCampaignEmbedding(client, {
        ownerUserId: scope.ownerUserId,
        campaignId: branchCampaignId,
        worldVersionId: source.worldVersionId
      });

      if (parsed.targetTurnNumber > 0) {
        await client.query(
          `INSERT INTO turns (
             id, campaign_id, owner_user_id, turn_number, source_turn_id, action,
             input_mode, input_mode_source, narration, choices, custom_action_suggestion,
             image_prompt, image_url, mechanics_private, state_snapshot_private,
             model_metadata, import_metadata, accepted_at, created_at
           )
           SELECT normalized.id, $1, turn.owner_user_id, turn.turn_number, turn.source_turn_id, turn.action,
                  turn.input_mode, turn.input_mode_source, turn.narration, turn.choices,
                  turn.custom_action_suggestion, turn.image_prompt, turn.image_url,
                 turn.mechanics_private, normalized."stateSnapshotPrivate", turn.model_metadata,
                  turn.import_metadata || jsonb_build_object(
                    'branch',
                    jsonb_build_object(
                      'sourceType', 'nexus_campaign_branch',
                      'branchId', $5::text,
                      'parentCampaignId', $2::text,
                      'sourceTurnId', turn.id::text,
                      'sourceTurnNumber', turn.turn_number,
                      'operationKind', provenance.operation_kind,
                      'replacementTurnId', provenance.replacement_turn_id
                    ) || CASE WHEN turn.import_metadata ? 'branch'
                              THEN jsonb_build_object('parent', turn.import_metadata->'branch')
                              ELSE '{}'::jsonb END
                  ),
                  turn.accepted_at, turn.created_at
             FROM turns turn
             JOIN jsonb_to_recordset($6::jsonb) AS normalized(
               "sourceId" uuid,
               id uuid,
               "stateSnapshotPrivate" jsonb
             ) ON normalized."sourceId" = turn.id
             LEFT JOIN LATERAL (
               SELECT job.operation_kind, job.replacement_turn_id
                 FROM generation_jobs job
                WHERE job.campaign_id = turn.campaign_id
                  AND job.owner_user_id = turn.owner_user_id
                  AND job.result_turn_id = turn.id
                  AND job.status = 'completed'
                ORDER BY job.completed_at DESC NULLS LAST, job.created_at DESC, job.id DESC
                LIMIT 1
             ) provenance ON true
            WHERE turn.campaign_id = $2::uuid AND turn.owner_user_id = $3
              AND turn.turn_number <= $4
            ORDER BY turn.turn_number`,
          [branchCampaignId, scope.campaignId, scope.ownerUserId, parsed.targetTurnNumber, branchId, json(normalizedTurns)]
        );
        const correctionCopy = await client.query<{
          sourceCount: number;
          insertedCount: number;
        }>(
          `WITH source_corrections AS MATERIALIZED (
             SELECT correction.revision, correction.narration,
                    correction.previous_effective_narration_hash,
                    correction.reason, correction.source,
                    correction.created_by_user_id, correction.created_at,
                    source_turn.turn_number
               FROM turn_narration_corrections correction
               JOIN turns source_turn
                 ON source_turn.id = correction.turn_id
                AND source_turn.campaign_id = correction.campaign_id
                AND source_turn.owner_user_id = correction.owner_user_id
              WHERE correction.campaign_id = $2
                AND correction.owner_user_id = $3
                AND source_turn.turn_number <= $4
           ), inserted AS (
             INSERT INTO turn_narration_corrections (
               owner_user_id, campaign_id, turn_id, revision, narration,
               previous_effective_narration_hash, reason, source,
               created_by_user_id, created_at
             )
             SELECT $3, $1, target_turn.id, correction.revision, correction.narration,
                    correction.previous_effective_narration_hash, correction.reason,
                    correction.source, correction.created_by_user_id, correction.created_at
               FROM source_corrections correction
               JOIN turns target_turn
                 ON target_turn.campaign_id = $1
                AND target_turn.owner_user_id = $3
                AND target_turn.turn_number = correction.turn_number
              ORDER BY correction.turn_number, correction.revision
             RETURNING id
           )
           SELECT (SELECT count(*)::int FROM source_corrections) AS "sourceCount",
                  (SELECT count(*)::int FROM inserted) AS "insertedCount"`,
          [branchCampaignId, scope.campaignId, scope.ownerUserId, parsed.targetTurnNumber]
        );
        if (!correctionCopy.rows[0]
          || correctionCopy.rows[0].sourceCount !== correctionCopy.rows[0].insertedCount) {
          invalidBoundaryData("unavailable", scope);
        }
        await client.query(
          `INSERT INTO summary_checkpoints (
             owner_user_id, campaign_id, through_turn, summary_kind, content,
             token_estimate, created_at
           )
           SELECT owner_user_id, $1, through_turn, summary_kind, content,
                  token_estimate, created_at
             FROM summary_checkpoints
            WHERE campaign_id = $2 AND owner_user_id = $3 AND through_turn <= $4`,
          [branchCampaignId, scope.campaignId, scope.ownerUserId, parsed.targetTurnNumber]
        );
        await client.query(
          `INSERT INTO asset_references (
             owner_user_id, asset_id, campaign_id, turn_id, asset_role, created_at
           )
           SELECT source_ref.owner_user_id, source_ref.asset_id, $1, target_turn.id,
                  source_ref.asset_role, source_ref.created_at
             FROM asset_references source_ref
             JOIN turns source_turn
               ON source_turn.id = source_ref.turn_id
              AND source_turn.campaign_id = source_ref.campaign_id
              AND source_turn.owner_user_id = source_ref.owner_user_id
             JOIN turns target_turn
               ON target_turn.campaign_id = $1
              AND target_turn.owner_user_id = source_ref.owner_user_id
              AND target_turn.turn_number = source_turn.turn_number
            WHERE source_ref.campaign_id = $2 AND source_ref.owner_user_id = $3
              AND source_turn.turn_number <= $4
           ON CONFLICT DO NOTHING`,
          [branchCampaignId, scope.campaignId, scope.ownerUserId, parsed.targetTurnNumber]
        );
        const illustrationCopy = await client.query<{
          sourceSetCount: number;
          insertedSetCount: number;
          sourceSegmentCount: number;
          insertedSegmentCount: number;
          sourceAssetCount: number;
          insertedAssetCount: number;
        }>(
          `WITH source_sets AS MATERIALIZED (
             SELECT source_set.id AS source_set_id, gen_random_uuid() AS target_set_id,
                    target_turn.id AS target_turn_id, source_set.source_text_hash,
                    source_set.segment_word_count, source_set.images_per_segment,
                    source_set.prompt_mode, source_set.status, source_set.is_active,
                    source_set.character_visual_reference, source_set.created_at,
                    source_set.completed_at
               FROM turn_illustration_sets source_set
               JOIN turns source_turn
                 ON source_turn.id = source_set.turn_id
                AND source_turn.campaign_id = source_set.campaign_id
                AND source_turn.owner_user_id = source_set.owner_user_id
               JOIN turns target_turn
                 ON target_turn.campaign_id = $1
                AND target_turn.owner_user_id = source_set.owner_user_id
                AND target_turn.turn_number = source_turn.turn_number
              WHERE source_set.campaign_id = $2
                AND source_set.owner_user_id = $3
                AND source_turn.turn_number <= $4
           ), inserted_sets AS (
             INSERT INTO turn_illustration_sets (
               id, owner_user_id, campaign_id, turn_id, source_text_hash,
               segment_word_count, images_per_segment, prompt_mode, status,
               is_active, character_visual_reference, generation_job_id,
               created_at, completed_at
             )
             SELECT source_set.target_set_id, $3, $1, source_set.target_turn_id,
                    source_set.source_text_hash, source_set.segment_word_count,
                    source_set.images_per_segment, source_set.prompt_mode,
                    source_set.status, source_set.is_active,
                    source_set.character_visual_reference, NULL,
                    source_set.created_at, source_set.completed_at
               FROM source_sets source_set
             RETURNING id
           ), source_segments AS MATERIALIZED (
             SELECT source_segment.id AS source_segment_id,
                    gen_random_uuid() AS target_segment_id,
                    source_set.target_set_id, source_set.target_turn_id,
                    source_segment.ordinal, source_segment.start_offset,
                    source_segment.end_offset, source_segment.start_word,
                    source_segment.end_word, source_segment.source_text,
                    source_segment.source_text_hash, source_segment.direct_prompt,
                    source_segment.resolved_prompt, source_segment.prompt_source,
                    source_segment.status, source_segment.created_at,
                    source_segment.updated_at
               FROM turn_illustration_segments source_segment
               JOIN source_sets source_set
                 ON source_set.source_set_id = source_segment.illustration_set_id
               JOIN inserted_sets inserted_set
                 ON inserted_set.id = source_set.target_set_id
              WHERE source_segment.campaign_id = $2
                AND source_segment.owner_user_id = $3
           ), inserted_segments AS (
             INSERT INTO turn_illustration_segments (
               id, owner_user_id, illustration_set_id, campaign_id, turn_id,
               ordinal, start_offset, end_offset, start_word, end_word,
               source_text, source_text_hash, direct_prompt, resolved_prompt,
               prompt_source, status, generation_job_id, created_at, updated_at
             )
             SELECT source_segment.target_segment_id, $3,
                    source_segment.target_set_id, $1, source_segment.target_turn_id,
                    source_segment.ordinal, source_segment.start_offset,
                    source_segment.end_offset, source_segment.start_word,
                    source_segment.end_word, source_segment.source_text,
                    source_segment.source_text_hash, source_segment.direct_prompt,
                    source_segment.resolved_prompt, source_segment.prompt_source,
                    source_segment.status, NULL, source_segment.created_at,
                    source_segment.updated_at
               FROM source_segments source_segment
             RETURNING id
           ), source_assets AS MATERIALIZED (
             SELECT source_segment.target_segment_id, source_asset.asset_id,
                    source_asset.variant_index, source_asset.created_at
               FROM turn_illustration_segment_assets source_asset
               JOIN source_segments source_segment
                 ON source_segment.source_segment_id = source_asset.segment_id
              WHERE source_asset.owner_user_id = $3
           ), inserted_assets AS (
             INSERT INTO turn_illustration_segment_assets (
               segment_id, owner_user_id, asset_id, image_job_id,
               variant_index, created_at
             )
             SELECT source_asset.target_segment_id, $3, source_asset.asset_id,
                    NULL, source_asset.variant_index, source_asset.created_at
               FROM source_assets source_asset
               JOIN inserted_segments inserted_segment
                 ON inserted_segment.id = source_asset.target_segment_id
             RETURNING segment_id
           )
           SELECT (SELECT count(*)::int FROM source_sets) AS "sourceSetCount",
                  (SELECT count(*)::int FROM inserted_sets) AS "insertedSetCount",
                  (SELECT count(*)::int FROM source_segments) AS "sourceSegmentCount",
                  (SELECT count(*)::int FROM inserted_segments) AS "insertedSegmentCount",
                  (SELECT count(*)::int FROM source_assets) AS "sourceAssetCount",
                  (SELECT count(*)::int FROM inserted_assets) AS "insertedAssetCount"`,
          [branchCampaignId, scope.campaignId, scope.ownerUserId, parsed.targetTurnNumber]
        );
        const illustrationCounts = illustrationCopy.rows[0];
        if (!illustrationCounts
          || illustrationCounts.sourceSetCount !== illustrationCounts.insertedSetCount
          || illustrationCounts.sourceSegmentCount !== illustrationCounts.insertedSegmentCount
          || illustrationCounts.sourceAssetCount !== illustrationCounts.insertedAssetCount) {
          invalidBoundaryData("unavailable", scope);
        }
      }
      await client.query(
        `INSERT INTO asset_references (
           owner_user_id, asset_id, campaign_id, turn_id, asset_role, created_at
         )
         SELECT owner_user_id, asset_id, $1, NULL, asset_role, created_at
           FROM asset_references
          WHERE campaign_id = $2 AND owner_user_id = $3 AND turn_id IS NULL
         ON CONFLICT DO NOTHING`,
        [branchCampaignId, scope.campaignId, scope.ownerUserId]
      );

      const memoryScope = {
        ownerUserId: scope.ownerUserId,
        campaignId: branchCampaignId,
        worldVersionId: source.worldVersionId
      };
      await collaborators.memory.rebuildCampaignMemories(client, memoryScope);
      await enqueueChunkIndexBestEffort(client, collaborators.memory, memoryScope);
      await collaborators.memory.enqueueEmbeddingReindex(client, memoryScope);
      await client.query(
        `INSERT INTO activity_events (owner_user_id, campaign_id, event_type, details)
         VALUES ($1,$2,'campaign_branched',$3)`,
        [scope.ownerUserId, branchCampaignId, json({
          parentCampaignId: scope.campaignId,
          branchTurnNumber: parsed.targetTurnNumber,
          branchId
        })]
      );
      return success({
        id: branchCampaignId,
        title,
        activeTurnNumber: parsed.targetTurnNumber,
        worldVersionId: source.worldVersionId
      });
    },

    async rewindCampaign(transaction, scope, request) {
      const client = worldCampaignDatabaseClient(transaction);
      const parsed = parseBoundary(campaignRewindRequestSchema, request, "invalid_request", scope);
      const current = await loadStateRow(client, scope, true);
      if (!current) return failure("campaign_not_found", { campaignId: scope.campaignId });
      if (current.activeTurnNumber !== parsed.expectedCurrentTurnNumber) {
        return failure("active_turn_changed", {
          campaignId: scope.campaignId,
          expectedTurnNumber: parsed.expectedCurrentTurnNumber,
          actualTurnNumber: current.activeTurnNumber
        });
      }
      if (current.revision !== parsed.expectedStateRevision) {
        return failure("state_revision_changed", {
          campaignId: scope.campaignId,
          expectedStateRevision: parsed.expectedStateRevision,
          actualStateRevision: current.revision
        });
      }
      if (parsed.targetTurnNumber > current.activeTurnNumber) {
        return failure("invalid_transition", {
          campaignId: scope.campaignId,
          expectedTurnNumber: parsed.targetTurnNumber,
          actualTurnNumber: current.activeTurnNumber
        });
      }

      let targetSnapshot: Record<string, unknown>;
      let targetModelMetadata: Record<string, unknown> | null = null;
      if (parsed.targetTurnNumber === 0) {
        targetSnapshot = current.initialStateSnapshot;
      } else {
        const target = await client.query<{
          stateSnapshotPrivate: Record<string, unknown>;
          modelMetadata: Record<string, unknown> | null;
        }>(
          `SELECT state_snapshot_private AS "stateSnapshotPrivate",
                  model_metadata AS "modelMetadata"
             FROM turns
            WHERE campaign_id = $1 AND owner_user_id = $2 AND turn_number = $3
            FOR UPDATE`,
          [scope.campaignId, scope.ownerUserId, parsed.targetTurnNumber]
        );
        if (!target.rows[0]) {
          return failure("invalid_transition", {
            campaignId: scope.campaignId,
            expectedTurnNumber: parsed.targetTurnNumber
          });
        }
        targetSnapshot = target.rows[0].stateSnapshotPrivate;
        targetModelMetadata = target.rows[0].modelMetadata;
      }
      if (!targetSnapshot || typeof targetSnapshot !== "object" || Array.isArray(targetSnapshot)) {
        invalidBoundaryData("unavailable", scope);
      }
      const targetEdit = await client.query<{ stateSnapshotPrivate: Record<string, unknown> }>(
        `SELECT state_snapshot_private AS "stateSnapshotPrivate"
           FROM campaign_state_edits
          WHERE campaign_id = $1 AND owner_user_id = $2 AND effective_turn_number = $3
          ORDER BY revision DESC
          LIMIT 1`,
        [scope.campaignId, scope.ownerUserId, parsed.targetTurnNumber]
      );
      const editedSnapshot = targetEdit.rows[0]?.stateSnapshotPrivate;
      if (editedSnapshot !== undefined) {
        if (!editedSnapshot || typeof editedSnapshot !== "object" || Array.isArray(editedSnapshot)) {
          invalidBoundaryData("unavailable", scope);
        }
        targetSnapshot = editedSnapshot;
      }
      const materializedTarget = runtimeStateContent({
        ...targetSnapshot,
        scratchpad: typeof targetSnapshot.scratchpad === "string" ? targetSnapshot.scratchpad : "",
        trackers: targetSnapshot.trackers ?? [],
        eventTriggers: Array.isArray(targetSnapshot.eventTriggers)
          ? targetSnapshot.eventTriggers
          : current.eventTriggers,
        pendingEventTriggers: Array.isArray(targetSnapshot.pendingEventTriggers)
          ? targetSnapshot.pendingEventTriggers
          : [],
        rpgStats: Array.isArray(targetSnapshot.rpgStats) ? targetSnapshot.rpgStats : current.rpgStats
      }, undefined, scope);
      const stateSnapshot = {
        scratchpad: materializedTarget.scratchpad,
        trackers: materializedTarget.trackers,
        eventTriggers: materializedTarget.eventTriggers,
        pendingEventTriggers: materializedTarget.pendingEventTriggers,
        rpgStats: materializedTarget.rpgStats
      };
      if (parsed.targetTurnNumber === current.activeTurnNumber) {
        return success({
          campaignId: scope.campaignId,
          activeTurnNumber: current.activeTurnNumber,
          discardedTurnCount: 0,
          stateSnapshot
        });
      }

      const activeGeneration = await client.query(
        `SELECT id FROM generation_jobs
          WHERE campaign_id = $1 AND owner_user_id = $2
            AND status IN ('queued','replacement_queued','assessing','generating','validating','committing','recoverable')
          LIMIT 1 FOR UPDATE`,
        [scope.campaignId, scope.ownerUserId]
      );
      const futureIllustrations = await client.query<{ status: string }>(
        `SELECT status FROM image_jobs
          WHERE campaign_id = $1 AND owner_user_id = $2
            AND turn_id IN (
              SELECT id FROM turns
               WHERE campaign_id = $1 AND owner_user_id = $2 AND turn_number > $3
            )
          FOR UPDATE`,
        [scope.campaignId, scope.ownerUserId, parsed.targetTurnNumber]
      );
      const futureResolutions = await client.query<{ status: string }>(
        `SELECT status FROM illustration_resolution_jobs
          WHERE campaign_id = $1 AND owner_user_id = $2
            AND turn_id IN (
              SELECT id FROM turns
               WHERE campaign_id = $1 AND owner_user_id = $2 AND turn_number > $3
            )
          FOR UPDATE`,
        [scope.campaignId, scope.ownerUserId, parsed.targetTurnNumber]
      );
      const activeChronicle = await client.query(
        `SELECT id FROM chronicle_jobs
          WHERE campaign_id = $1 AND owner_user_id = $2 AND status = 'running'
          LIMIT 1 FOR UPDATE`,
        [scope.campaignId, scope.ownerUserId]
      );
      if (activeGeneration.rowCount
        || futureIllustrations.rows.some((row) => ["queued", "generating", "provider_pending", "downloading"].includes(row.status))
        || futureResolutions.rows.some((row) => ["queued", "matching", "recoverable", "generation_queued"].includes(row.status))
        || activeChronicle.rowCount) {
        return failure("invalid_transition", { campaignId: scope.campaignId });
      }

      const discardedTurnCount = current.activeTurnNumber - parsed.targetTurnNumber;
      await client.query(
        `DELETE FROM generation_jobs
          WHERE campaign_id = $1 AND owner_user_id = $2 AND expected_turn_number > $3`,
        [scope.campaignId, scope.ownerUserId, parsed.targetTurnNumber]
      );
      await client.query(
        `DELETE FROM campaign_state_edits
          WHERE campaign_id = $1 AND owner_user_id = $2 AND effective_turn_number > $3`,
        [scope.campaignId, scope.ownerUserId, parsed.targetTurnNumber]
      );
      await client.query(
        `DELETE FROM turns
          WHERE campaign_id = $1 AND owner_user_id = $2 AND turn_number > $3`,
        [scope.campaignId, scope.ownerUserId, parsed.targetTurnNumber]
      );
      await client.query(
        `DELETE FROM summary_checkpoints
          WHERE campaign_id = $1 AND owner_user_id = $2 AND through_turn > $3`,
        [scope.campaignId, scope.ownerUserId, parsed.targetTurnNumber]
      );
      await client.query(
        `DELETE FROM chronicle_jobs
          WHERE campaign_id = $1 AND owner_user_id = $2 AND status <> 'running'`,
        [scope.campaignId, scope.ownerUserId]
      );
      const memoryScope = {
        ownerUserId: scope.ownerUserId,
        campaignId: scope.campaignId,
        worldVersionId: current.worldVersionId
      };
      await collaborators.memory.rebuildCampaignMemories(client, memoryScope);
      await enqueueChunkIndexBestEffort(client, collaborators.memory, memoryScope);
      await collaborators.memory.enqueueEmbeddingReindex(client, memoryScope);
      await client.query(
        "DELETE FROM model_chains WHERE campaign_id = $1 AND owner_user_id = $2",
        [scope.campaignId, scope.ownerUserId]
      );
      await client.query(
        `UPDATE campaign_state
            SET scratchpad_private = $3, scratchpad_safe_for_prompt = $4,
                trackers = $5, event_triggers = $6, pending_event_triggers = $7,
                rpg_stats = $8, revision = revision + 1, updated_at = now()
          WHERE campaign_id = $1 AND owner_user_id = $2`,
        [
          scope.campaignId,
          scope.ownerUserId,
          stateSnapshot.scratchpad,
          editedSnapshot !== undefined || typeof targetModelMetadata?.promptProtocolVersion === "string",
          json(stateSnapshot.trackers),
          json(stateSnapshot.eventTriggers),
          json(stateSnapshot.pendingEventTriggers),
          json(stateSnapshot.rpgStats)
        ]
      );
      await client.query(
        `UPDATE campaigns SET active_turn_number = $3, updated_at = now()
          WHERE id = $1 AND owner_user_id = $2`,
        [scope.campaignId, scope.ownerUserId, parsed.targetTurnNumber]
      );
      await client.query(
        `INSERT INTO activity_events (owner_user_id, campaign_id, event_type, details)
         VALUES ($1,$2,'campaign_rewound',$3)`,
        [scope.ownerUserId, scope.campaignId, json({
          fromTurnNumber: current.activeTurnNumber,
          targetTurnNumber: parsed.targetTurnNumber,
          discardedTurnCount
        })]
      );
      return success({
        campaignId: scope.campaignId,
        activeTurnNumber: parsed.targetTurnNumber,
        discardedTurnCount,
        stateSnapshot
      });
    },

    async syncPlayerCampaignConfig(transaction, scope, request) {
      const client = worldCampaignDatabaseClient(transaction);
      const config = parseBoundary(
        campaignPlayerConfigSyncRequestSchema,
        request,
        "invalid_request",
        scope
      );
      const current = await loadStateRow(client, scope, true);
      if (!current) return failure("campaign_not_found", { campaignId: scope.campaignId });
      if (current.activeTurnNumber !== config.expectedTurnNumber) {
        return failure("active_turn_changed", {
          campaignId: scope.campaignId,
          expectedTurnNumber: config.expectedTurnNumber,
          actualTurnNumber: current.activeTurnNumber
        });
      }
      if (current.revision !== config.expectedStateRevision) {
        return failure("state_revision_changed", {
          campaignId: scope.campaignId,
          expectedStateRevision: config.expectedStateRevision,
          actualStateRevision: current.revision
        });
      }
      const activeJob = await client.query(
        `SELECT 1 FROM generation_jobs
          WHERE campaign_id = $1 AND owner_user_id = $2
            AND status IN ('queued','replacement_queued','assessing','generating','validating','committing','recoverable')
          LIMIT 1`,
        [scope.campaignId, scope.ownerUserId]
      );
      if (activeJob.rowCount) return failure("invalid_transition", { campaignId: scope.campaignId });

      await client.query(
        `UPDATE campaigns
            SET legacy_settings = legacy_settings || $3::jsonb, updated_at = now()
          WHERE id = $1 AND owner_user_id = $2`,
        [scope.campaignId, scope.ownerUserId, json({
          useRpgStats: config.useRpgStats,
          suppressEventTriggers: config.suppressEventTriggers
        })]
      );
      await client.query(
        `UPDATE campaign_state
            SET rpg_stats = $3, event_triggers = $4, pending_event_triggers = $5,
                revision = revision + 1, updated_at = now()
          WHERE campaign_id = $1 AND owner_user_id = $2`,
        [
          scope.campaignId,
          scope.ownerUserId,
          json(config.rpgStats),
          json(config.eventTriggers),
          json(config.pendingEventTriggers)
        ]
      );
      if (current.activeTurnNumber === 0) {
        if (!current.initialStateSnapshot
          || typeof current.initialStateSnapshot !== "object"
          || Array.isArray(current.initialStateSnapshot)) {
          invalidBoundaryData("unavailable", scope);
        }
        const initialStateSnapshot = {
          ...objectValue(current.initialStateSnapshot),
          scratchpad: current.scratchpadPrivate,
          trackers: normalizeCampaignTrackers(current.trackers),
          rpgStats: config.rpgStats,
          eventTriggers: config.eventTriggers,
          pendingEventTriggers: config.pendingEventTriggers
        };
        await client.query(
          `UPDATE campaign_state SET initial_state_snapshot = $3
            WHERE campaign_id = $1 AND owner_user_id = $2`,
          [scope.campaignId, scope.ownerUserId, json(initialStateSnapshot)]
        );
      }
      return success({
        campaignId: scope.campaignId,
        activeTurnNumber: current.activeTurnNumber,
        synchronized: true
      });
    }
  };
}

type CampaignTurnReportedCost = Readonly<{
  amount: string;
  currency: string;
  byCategory: Readonly<Record<"story" | "image" | "memory", string>>;
}>;

export type CampaignTurnReportedCostReader = (
  client: DatabasePool,
  ownerUserId: string,
  campaignId: string,
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
  storyContextBudgetTokens: 32_000 | 64_000 | 128_000 | 256_000 | 1_000_000;
  turnControlStyle: "action_only" | "flexible_auto" | "flexible_action" | "flexible_scene";
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
                c.story_length_profile AS "storyLengthProfile",
                c.story_context_budget_tokens AS "storyContextBudgetTokens",
                c.turn_control_style AS "turnControlStyle",
                c.updated_at AS "updatedAt",
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
        storyContextBudgetTokens: row.storyContextBudgetTokens,
        turnControlStyle: row.turnControlStyle,
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
        scope.campaignId,
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
    state: createPostgresCampaignStateRepository(collaborators),
    campaigns: createPostgresCampaignAuthorityRepository(collaborators),
    sync: createPostgresCampaignSyncRepository(),
    turnPages: collaborators.turnPages
  };
}
