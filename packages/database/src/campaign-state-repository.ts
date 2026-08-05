import {
  campaignRewindSchema,
  campaignRuntimeStateContentSchema,
  campaignRuntimeStateSchema,
  campaignRuntimeStateUpdateSchema,
  playerCampaignConfigSchema,
  PUBLIC_GENERATION_FAILURE_CODE,
  PUBLIC_GENERATION_FAILURE_MESSAGE,
  type CampaignRuntimeStateContent
} from "../../contracts/src/generation.js";
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
import type { MemoryGenerationTransactionPort } from "../../application/src/memory/index.js";
import { normalizeCampaignTrackers } from "../../domain/src/campaign-trackers.js";
import { characterLegacyText, effectiveCampaignCharacter } from "../../domain/src/world-characters.js";
import { containsMechanicsLanguage, sha256, stableStringify } from "../../domain/src/text.js";
import { formatNarrationParagraphs } from "../../story-engine/src/narration-formatting.js";
import { readTurnPage } from "./play-loop-read-repository.js";
import type { DatabaseClient, DatabasePool } from "./pool.js";
import {
  createPostgresWorldCampaignTransactionPort,
  worldCampaignDatabaseClient
} from "./world-campaign-transaction.js";

export type CampaignSyncAdapterCollaborators = Readonly<{
  turnPages: BoundedCampaignTurnPagePort;
  memory: Pick<MemoryGenerationTransactionPort, "enqueueEmbeddingReindex" | "rebuildCampaignMemories">;
}>;

type PostgresCampaignAuthorityRepository = Pick<
  CampaignRepositoryPort,
  "rewindCampaign" | "syncPlayerCampaignConfig"
>;

const campaignPlayerConfigSyncRequestSchema = playerCampaignConfigSchema.extend({
  expectedStateRevision: z.coerce.number().int().min(0)
});

const campaignRewindRequestSchema = campaignRewindSchema.extend({
  expectedCurrentTurnNumber: z.coerce.number().int().min(0),
  expectedStateRevision: z.coerce.number().int().min(0)
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
    canonicalFacts: canonicalFacts?.length
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
    ? await client.query<{ stateSnapshotPrivate: Record<string, unknown>; acceptedAt: Date | string }>(
      `SELECT state_snapshot_private AS "stateSnapshotPrivate", accepted_at AS "acceptedAt"
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

    async getCampaignRuntimeState(transaction, scope, requestedTurnNumber) {
      return loadRuntimeState(worldCampaignDatabaseClient(transaction), scope, requestedTurnNumber);
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
      const currentSnapshot = current.activeTurnNumber === 0
        ? current.initialStateSnapshot
        : accepted?.rows[0]?.stateSnapshotPrivate;
      if (!currentSnapshot || typeof currentSnapshot !== "object" || Array.isArray(currentSnapshot)) {
        invalidBoundaryData("unavailable", scope);
      }

      const existingFacts = await activeCanonicalFacts(client, scope, current.activeTurnNumber);
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
          : existing && existing.sourceTurnNumber === current.activeTurnNumber
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
        ...objectValue(currentSnapshot),
        scratchpad: current.scratchpadPrivate,
        trackers: current.trackers,
        rpgStats: current.rpgStats,
        eventTriggers: current.eventTriggers,
        pendingEventTriggers: current.pendingEventTriggers
      }, existingFacts.map((fact) => ({ id: fact.id, content: fact.content })), scope);
      const changedFields = (Object.keys(correctedContent) as Array<keyof CampaignRuntimeStateContent>)
        .filter((field) => json(correctedContent[field]) !== json(currentContent[field]));
      if (!changedFields.length) return success(await loadRuntimeState(client, scope));

      const nextRevision = current.revision + 1;
      const snapshot = { ...objectValue(currentSnapshot), ...correctedContent };
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
          current.activeTurnNumber,
          nextRevision,
          json(snapshot),
          json(changedFields)
        ]
      );
      await collaborators.memory.rebuildCampaignMemories(client, {
        ownerUserId: scope.ownerUserId,
        campaignId: scope.campaignId,
        worldVersionId: current.worldVersionId
      });
      await client.query(
        "DELETE FROM model_chains WHERE campaign_id = $1 AND owner_user_id = $2",
        [scope.campaignId, scope.ownerUserId]
      );
      await client.query(
        `INSERT INTO activity_events (owner_user_id, campaign_id, event_type, details)
         VALUES ($1,$2,'campaign_state_edited',$3)`,
        [scope.ownerUserId, scope.campaignId, json({
          effectiveTurnNumber: current.activeTurnNumber,
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
    state: createPostgresCampaignStateRepository(collaborators),
    campaigns: createPostgresCampaignAuthorityRepository(collaborators),
    sync: createPostgresCampaignSyncRepository(),
    turnPages: collaborators.turnPages
  };
}
