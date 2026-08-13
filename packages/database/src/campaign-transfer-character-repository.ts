import { z } from "zod";
import type {
  CampaignTransferRepositoryPort,
  CampaignScope,
  CharacterProfileRepositoryPort,
  WorldCampaignErrorDetails,
  WorldCampaignRepositoryResult,
  WorldCampaignTransitionFailureReason
} from "../../application/src/world-campaign/index.js";
import type { MemoryGenerationTransactionPort } from "../../application/src/memory/index.js";
import { WorldCampaignApplicationError } from "../../application/src/world-campaign/index.js";
import {
  campaignTransferCommitRequestSchema,
  campaignTransferFindingSchema,
  campaignTransferPreviewRequestSchema,
  type CampaignTransferFinding,
  type CampaignTransferPreviewRequest
} from "../../contracts/src/campaign-transfer.js";
import {
  campaignTrackerSchema,
  playerEventTriggerSchema,
  playerRpgStatSchema
} from "../../contracts/src/generation.js";
import {
  campaignCharacterProfileSchema,
  campaignCharacterProfileUpdateSchema,
  characterProfileSchema,
  playableCharacterSchema,
  worldContentSchema
} from "../../contracts/src/world-library.js";
import { assessCampaignTransferCompatibility } from "../../domain/src/campaign-transfer.js";
import { normalizeCampaignStateSnapshot, normalizeCampaignTrackers } from "../../domain/src/campaign-trackers.js";
import { removeProviderSecrets, sha256, stableStringify } from "../../domain/src/text.js";
import { effectiveCampaignCharacter } from "../../domain/src/world-characters.js";
import type { DatabaseClient } from "./pool.js";
import { worldCampaignDatabaseClient } from "./world-campaign-transaction.js";

const profileReadRowSchema = z.object({
  selectedCharacterId: z.string().trim().min(1).nullable(),
  characterSnapshot: playableCharacterSchema.nullable(),
  characterProfile: campaignCharacterProfileSchema.nullable(),
  characterProfileRevision: z.number().int().min(0),
  rpgStats: z.array(playerRpgStatSchema),
  defaultTriggers: z.array(z.union([playerEventTriggerSchema, campaignTrackerSchema])),
  trackers: z.array(campaignTrackerSchema)
});

const profileLockRowSchema = z.object({
  characterProfile: campaignCharacterProfileSchema.nullable(),
  characterProfileRevision: z.number().int().min(0)
});

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

function unavailable(scope: CampaignScope): never {
  throw new WorldCampaignApplicationError("unavailable", "invalid_transition", {
    campaignId: scope.campaignId
  });
}

function parsePersisted<T>(schema: z.ZodType<T>, value: unknown, scope: CampaignScope): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) unavailable(scope);
  return parsed.data;
}

function parseRequest<T>(schema: z.ZodType<T>, value: unknown, scope: CampaignScope): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new WorldCampaignApplicationError("invalid_request", "invalid_transition", {
      campaignId: scope.campaignId
    });
  }
  return parsed.data;
}

export function createPostgresCharacterProfileRepository(): CharacterProfileRepositoryPort {
  return {
    async getCampaignCharacterProfile(transaction, scope) {
      const client = worldCampaignDatabaseClient(transaction);
      const result = await client.query(
        `SELECT c.selected_character_id AS "selectedCharacterId",
                c.character_snapshot AS "characterSnapshot",
                c.character_profile AS "characterProfile",
                c.character_profile_revision AS "characterProfileRevision",
                cs.rpg_stats AS "rpgStats",
                cs.default_triggers AS "defaultTriggers",
                cs.trackers
           FROM campaigns c
           JOIN campaign_state cs
             ON cs.campaign_id = c.id
            AND cs.owner_user_id = c.owner_user_id
          WHERE c.id = $1 AND c.owner_user_id = $2`,
        [scope.campaignId, scope.ownerUserId],
      );
      const raw = result.rows[0];
      if (!raw) {
        throw new WorldCampaignApplicationError("not_found", "campaign_not_found", {
          campaignId: scope.campaignId
        });
      }
      const row = parsePersisted(profileReadRowSchema, raw, scope);
      const effective = effectiveCampaignCharacter(row.characterProfile, row.characterSnapshot);
      return {
        campaignId: scope.campaignId,
        characterId: row.selectedCharacterId,
        revision: row.characterProfileRevision,
        name: effective.name,
        profile: effective.profile ?? characterProfileSchema.parse({}),
        storedProfile: row.characterProfile,
        inheritedFromSnapshot: row.characterProfile === null && effective.profile !== null,
        legacyCharacterText: effective.legacyGuidance,
        rpgStats: row.rpgStats,
        defaultTriggers: [...row.defaultTriggers, ...row.trackers]
      };
    },

    async updateCampaignCharacterProfile(transaction, scope, input) {
      const client = worldCampaignDatabaseClient(transaction);
      const request = parseRequest(campaignCharacterProfileUpdateSchema, input, scope);
      if (request.editSource === "ai_organized" && !request.organizerProtocolVersion) {
        throw new WorldCampaignApplicationError("invalid_request", "invalid_transition", {
          campaignId: scope.campaignId
        });
      }
      const current = await client.query(
        `SELECT character_profile AS "characterProfile",
                character_profile_revision AS "characterProfileRevision"
           FROM campaigns
          WHERE id = $1 AND owner_user_id = $2
          FOR UPDATE`,
        [scope.campaignId, scope.ownerUserId],
      );
      const raw = current.rows[0];
      if (!raw) return failure("campaign_not_found", { campaignId: scope.campaignId });
      const row = parsePersisted(profileLockRowSchema, raw, scope);
      if (row.characterProfileRevision !== request.expectedRevision) {
        return failure("state_revision_changed", {
          campaignId: scope.campaignId,
          expectedStateRevision: request.expectedRevision,
          actualStateRevision: row.characterProfileRevision
        });
      }
      const active = await client.query(
        `SELECT 1
           FROM generation_jobs
          WHERE campaign_id = $1 AND owner_user_id = $2
            AND status IN (
              'queued', 'replacement_queued', 'assessing', 'generating',
              'validating', 'committing', 'recoverable'
            )
          LIMIT 1`,
        [scope.campaignId, scope.ownerUserId],
      );
      if (active.rowCount) {
        return failure("invalid_transition", { campaignId: scope.campaignId });
      }
      const nextProfile = campaignCharacterProfileSchema.parse({
        name: request.name,
        profile: request.profile
      });
      const revision = row.characterProfileRevision + 1;
      await client.query(
        `UPDATE campaigns
            SET character_profile = $3,
                character_profile_revision = $4,
                updated_at = now()
          WHERE id = $1 AND owner_user_id = $2`,
        [scope.campaignId, scope.ownerUserId, json(nextProfile), revision],
      );
      await client.query(
        `INSERT INTO campaign_character_profile_edits (
           owner_user_id, campaign_id, revision, previous_profile, next_profile, edit_source
         ) VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          scope.ownerUserId,
          scope.campaignId,
          revision,
          row.characterProfile ? json(row.characterProfile) : null,
          json(nextProfile),
          request.editSource
        ],
      );
      await client.query(
        `UPDATE model_chains
            SET active = false, updated_at = now()
          WHERE campaign_id = $1 AND owner_user_id = $2`,
        [scope.campaignId, scope.ownerUserId],
      );
      await client.query(
        `INSERT INTO activity_events (
           owner_user_id, campaign_id, event_type, correlation_id, details
         ) VALUES ($1, $2, 'campaign_character_profile_updated', $4, $3)`,
        [scope.ownerUserId, scope.campaignId, json({
          characterProfileRevision: revision,
          editSource: request.editSource,
          organizerProtocolVersion: request.editSource === "ai_organized"
            ? request.organizerProtocolVersion
            : null
        }), scope.campaignId],
      );
      return success({
        campaignId: scope.campaignId,
        revision,
        ...nextProfile
      });
    }
  };
}

const sourceRowSchema = z.object({
  id: z.uuid(), title: z.string(), status: z.string(), active_turn_number: z.number().int().nonnegative(),
  story_length_profile: z.string(), turn_control_style: z.string(), selected_character_id: z.string().nullable(),
  character_snapshot: playableCharacterSchema.nullable(), character_profile: campaignCharacterProfileSchema.nullable(),
  legacy_settings: z.record(z.string(), z.unknown()), text_provider_profile_id: z.uuid().nullable(), image_provider_profile_id: z.uuid().nullable(),
  world_version_id: z.uuid(), world_id: z.uuid(), world_title: z.string(), world_version_number: z.number().int().positive(),
  world_content: worldContentSchema, state_revision: z.number().int().nonnegative(), scratchpad_private: z.string(),
  scratchpad_safe_for_prompt: z.boolean(), trackers: z.array(z.unknown()), default_triggers: z.array(z.unknown()),
  event_triggers: z.array(z.unknown()), pending_event_triggers: z.array(z.unknown()), rpg_stats: z.array(z.unknown()),
  import_provenance: z.record(z.string(), z.unknown()), initial_state_snapshot: z.record(z.string(), z.unknown()),
  state_updated_at: z.date(), campaign_updated_at: z.date(), latest_turn_id: z.uuid().nullable()
});
type SourceRow = z.infer<typeof sourceRowSchema>;

const targetRowSchema = z.object({
  id: z.uuid(), world_id: z.uuid(), world_title: z.string(), world_status: z.string(),
  version_number: z.number().int().positive(), content: worldContentSchema
});
type TargetRow = z.infer<typeof targetRowSchema>;

const countRowSchema = z.object({
  turn_count: z.number().int().nonnegative(), state_edit_count: z.number().int().nonnegative(),
  summary_count: z.number().int().nonnegative(), asset_count: z.number().int().nonnegative(),
  active_generation_count: z.number().int().nonnegative(), active_image_count: z.number().int().nonnegative()
});
type CountRow = z.infer<typeof countRowSchema>;

function transferUnavailable(scope: CampaignScope, worldVersionId?: string): never {
  throw new WorldCampaignApplicationError("unavailable", "invalid_transition", {
    campaignId: scope.campaignId,
    ...(worldVersionId ? { worldVersionId } : {})
  });
}

function transferableLegacySettings(value: Record<string, unknown>): Record<string, unknown> {
  const sanitize = (candidate: unknown): unknown => {
    if (Array.isArray(candidate)) return candidate.map(sanitize);
    if (!candidate || typeof candidate !== "object") return candidate;
    return Object.fromEntries(Object.entries(candidate as Record<string, unknown>).flatMap(([key, entry]) => {
      const normalized = key.replaceAll(/[^a-z]/gi, "").toLocaleLowerCase();
      const sensitive = /(?:apikey|password|authorization|credential|secret|endpoint|baseurl|providerurl)/.test(normalized)
        || /^(?:token|accesstoken|refreshtoken)$/.test(normalized);
      return sensitive ? [] : [[key, sanitize(entry)]];
    }));
  };
  return sanitize(removeProviderSecrets(value)) as Record<string, unknown>;
}

async function loadTransferSource(client: DatabaseClient, scope: CampaignScope, lock = false): Promise<SourceRow> {
  const result = await client.query(
    `SELECT c.id, c.title, c.status, c.active_turn_number, c.story_length_profile, c.turn_control_style,
            c.selected_character_id, c.character_snapshot, c.character_profile, c.legacy_settings,
            c.text_provider_profile_id, c.image_provider_profile_id, c.world_version_id,
            w.id AS world_id, w.title AS world_title, wv.version_number AS world_version_number,
            wv.content AS world_content, cs.revision AS state_revision, cs.scratchpad_private,
            cs.scratchpad_safe_for_prompt, cs.trackers, cs.default_triggers, cs.event_triggers,
            cs.pending_event_triggers, cs.rpg_stats, cs.import_provenance, cs.initial_state_snapshot,
            cs.updated_at AS state_updated_at, c.updated_at AS campaign_updated_at,
            (SELECT t.id FROM turns t WHERE t.owner_user_id = c.owner_user_id AND t.campaign_id = c.id
              ORDER BY t.turn_number DESC LIMIT 1) AS latest_turn_id
       FROM campaigns c
       JOIN campaign_state cs ON cs.campaign_id = c.id AND cs.owner_user_id = c.owner_user_id
       JOIN world_versions wv ON wv.id = c.world_version_id AND wv.owner_user_id = c.owner_user_id
       JOIN worlds w ON w.id = wv.world_id AND w.owner_user_id = c.owner_user_id
      WHERE c.id = $1 AND c.owner_user_id = $2${lock ? " FOR UPDATE OF c, cs" : ""}`,
    [scope.campaignId, scope.ownerUserId],
  );
  if (!result.rows[0]) {
    throw new WorldCampaignApplicationError("not_found", "campaign_not_found", { campaignId: scope.campaignId });
  }
  const parsed = sourceRowSchema.safeParse(result.rows[0]);
  if (!parsed.success) transferUnavailable(scope);
  return parsed.data;
}

async function loadTransferTarget(client: DatabaseClient, scope: CampaignScope, id: string, lock = false): Promise<TargetRow> {
  const result = await client.query(
    `SELECT wv.id, wv.world_id, w.title AS world_title, w.status AS world_status,
            wv.version_number, wv.content
       FROM world_versions wv
       JOIN worlds w ON w.id = wv.world_id AND w.owner_user_id = wv.owner_user_id
      WHERE wv.id = $1 AND wv.owner_user_id = $2${lock ? " FOR KEY SHARE OF wv, w" : ""}`,
    [id, scope.ownerUserId],
  );
  if (!result.rows[0]) {
    throw new WorldCampaignApplicationError("not_found", "world_version_not_found", { worldVersionId: id });
  }
  const parsed = targetRowSchema.safeParse(result.rows[0]);
  if (!parsed.success) transferUnavailable(scope, id);
  return parsed.data;
}

async function transferCounts(client: DatabaseClient, scope: CampaignScope): Promise<CountRow> {
  const result = await client.query(
    `SELECT
       (SELECT count(*)::int FROM turns WHERE owner_user_id = $1 AND campaign_id = $2) AS turn_count,
       (SELECT count(*)::int FROM campaign_state_edits WHERE owner_user_id = $1 AND campaign_id = $2) AS state_edit_count,
       (SELECT count(*)::int FROM summary_checkpoints WHERE owner_user_id = $1 AND campaign_id = $2) AS summary_count,
       (SELECT count(*)::int FROM asset_references WHERE owner_user_id = $1 AND campaign_id = $2) AS asset_count,
       (SELECT count(*)::int FROM generation_jobs WHERE owner_user_id = $1 AND campaign_id = $2
          AND status IN ('queued','replacement_queued','assessing','generating','validating','committing','recoverable')) AS active_generation_count,
       (SELECT count(*)::int FROM image_jobs WHERE owner_user_id = $1 AND campaign_id = $2
          AND status IN ('queued','generating','provider_pending','downloading','recoverable')) AS active_image_count`,
    [scope.ownerUserId, scope.campaignId],
  );
  const parsed = countRowSchema.safeParse(result.rows[0]);
  if (!parsed.success) transferUnavailable(scope);
  return parsed.data;
}

function transferFingerprint(source: SourceRow, targetWorldVersionId: string, request: CampaignTransferPreviewRequest): string {
  return sha256(stableStringify({
    campaignId: source.id, title: source.title, status: source.status,
    activeTurnNumber: source.active_turn_number, stateRevision: source.state_revision,
    stateUpdatedAt: source.state_updated_at.toISOString(), campaignUpdatedAt: source.campaign_updated_at.toISOString(),
    latestTurnId: source.latest_turn_id, worldVersionId: source.world_version_id, targetWorldVersionId,
    requestedTitle: request.title || null, characterStrategy: request.characterStrategy,
    stateStrategy: request.stateStrategy, targetDefaultsPolicy: request.targetDefaultsPolicy
  }));
}

function transferCompatibility(source: SourceRow, target: TargetRow, counts: CountRow): CampaignTransferFinding[] {
  return campaignTransferFindingSchema.array().parse(assessCampaignTransferCompatibility({
    sourceWorldId: source.world_id, targetWorldId: target.world_id, targetWorldStatus: target.world_status,
    sourceContent: source.world_content, targetContent: target.content, selectedCharacterId: source.selected_character_id,
    characterSnapshot: source.character_snapshot, campaignState: {
      rpgStats: source.rpg_stats, defaultTriggers: source.default_triggers, eventTriggers: source.event_triggers
    },
    activeGenerationJobs: counts.active_generation_count, activeImageJobs: counts.active_image_count
  }));
}

type TransferMemory = Pick<MemoryGenerationTransactionPort, "rebuildCampaignMemories" | "enqueueEmbeddingReindex">;

async function cloneTransferredCampaign(
  client: DatabaseClient,
  memory: TransferMemory,
  scope: CampaignScope,
  source: SourceRow,
  target: TargetRow,
  title: string,
  transferId: string,
): Promise<{ campaignId: string; memoryCount: number; embeddingJobId: string | null }> {
  const created = await client.query<{ id: string }>(
    `INSERT INTO campaigns (
       owner_user_id, world_version_id, title, status, active_turn_number, story_length_profile, turn_control_style,
       selected_character_id, character_snapshot, character_profile, character_profile_revision,
       legacy_settings, text_provider_profile_id, image_provider_profile_id
     ) VALUES ($1,$2,$3,'active',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
    [scope.ownerUserId, target.id, title, source.active_turn_number, source.story_length_profile,
      source.turn_control_style, source.selected_character_id, json(source.character_snapshot),
      source.character_profile ? json(source.character_profile) : null, source.character_profile ? 1 : 0,
      json(transferableLegacySettings(source.legacy_settings)), source.text_provider_profile_id, source.image_provider_profile_id],
  );
  const campaignId = created.rows[0]?.id;
  if (!campaignId) transferUnavailable(scope, target.id);
  if (source.character_profile) {
    await client.query(
      `INSERT INTO campaign_character_profile_edits (
         owner_user_id, campaign_id, revision, previous_profile, next_profile, edit_source
       ) VALUES ($1,$2,1,NULL,$3,'transfer')`,
      [scope.ownerUserId, campaignId, json(source.character_profile)],
    );
  }
  const provenance = {
    ...source.import_provenance,
    transfer: { type: "nexus_world_transfer", transferId, sourceCampaignId: source.id, sourceWorldVersionId: source.world_version_id }
  };
  await client.query(
    `INSERT INTO campaign_state (
       campaign_id, owner_user_id, scratchpad_private, scratchpad_safe_for_prompt, trackers,
       default_triggers, event_triggers, pending_event_triggers, rpg_stats, import_provenance,
       initial_state_snapshot, revision
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [campaignId, scope.ownerUserId, source.scratchpad_private, source.scratchpad_safe_for_prompt,
      json(normalizeCampaignTrackers(source.trackers)), json(normalizeCampaignTrackers(source.default_triggers)),
      json(source.event_triggers), json(source.pending_event_triggers), json(source.rpg_stats), json(provenance),
      json(normalizeCampaignStateSnapshot(source.initial_state_snapshot)), source.state_revision],
  );
  await client.query(
    `INSERT INTO campaign_state_edits (
       owner_user_id, campaign_id, effective_turn_number, revision, state_snapshot_private, changed_fields, created_at
     ) SELECT owner_user_id, $1, effective_turn_number, revision, state_snapshot_private, changed_fields, created_at
         FROM campaign_state_edits WHERE owner_user_id = $2 AND campaign_id = $3 ORDER BY revision`,
    [campaignId, scope.ownerUserId, source.id],
  );

  const sourceTurns = await client.query(
    `SELECT t.*,
            gj.operation_kind AS "operationKind",
            gj.replacement_turn_id AS "replacementTurnId"
       FROM turns t
       LEFT JOIN LATERAL (
         SELECT operation_kind, replacement_turn_id
           FROM generation_jobs
          WHERE owner_user_id = t.owner_user_id AND campaign_id = t.campaign_id
            AND result_turn_id = t.id AND status = 'completed'
          ORDER BY completed_at DESC NULLS LAST, created_at DESC LIMIT 1
       ) gj ON true
      WHERE t.owner_user_id = $1 AND t.campaign_id = $2 ORDER BY t.turn_number`,
    [scope.ownerUserId, source.id],
  );
  const turnIds = new Map<string, string>();
  for (const raw of sourceTurns.rows) {
    const parsed = z.object({
      id: z.uuid(), turn_number: z.number().int().positive(), source_turn_id: z.string().nullable(),
      action: z.string(), input_mode: z.string(), input_mode_source: z.string(), narration: z.string(),
      choices: z.array(z.unknown()), custom_action_suggestion: z.string(), image_prompt: z.string(),
      image_url: z.string(), mechanics_private: z.record(z.string(), z.unknown()).nullable(),
      state_snapshot_private: z.record(z.string(), z.unknown()), model_metadata: z.record(z.string(), z.unknown()),
      import_metadata: z.record(z.string(), z.unknown()), accepted_at: z.date(), created_at: z.date(),
      operationKind: z.enum(["append", "replace_latest"]).nullable(), replacementTurnId: z.uuid().nullable()
    }).safeParse(raw);
    if (!parsed.success) transferUnavailable(scope, target.id);
    const turn = parsed.data;
    const priorTransfer = turn.import_metadata.transfer;
    const turnProvenance: Record<string, unknown> = {
      sourceType: "nexus_world_transfer", transferId, sourceCampaignId: source.id,
      sourceTurnId: turn.id, sourceTurnNumber: turn.turn_number,
      operationKind: turn.operationKind, replacementTurnId: turn.replacementTurnId
    };
    if (priorTransfer && typeof priorTransfer === "object" && !Array.isArray(priorTransfer)) {
      turnProvenance.parent = priorTransfer;
    }
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO turns (
         campaign_id, owner_user_id, turn_number, source_turn_id, action, input_mode, input_mode_source,
         narration, choices, custom_action_suggestion, image_prompt, image_url, mechanics_private,
         state_snapshot_private, model_metadata, import_metadata, accepted_at, created_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING id`,
      [campaignId, scope.ownerUserId, turn.turn_number, turn.source_turn_id, turn.action, turn.input_mode,
        turn.input_mode_source, turn.narration, json(turn.choices), turn.custom_action_suggestion,
        turn.image_prompt, turn.image_url, json(turn.mechanics_private), json(turn.state_snapshot_private),
        json(turn.model_metadata), json({ ...turn.import_metadata, transfer: turnProvenance }),
        turn.accepted_at, turn.created_at],
    );
    turnIds.set(turn.id, inserted.rows[0]!.id);
  }
  await client.query(
    `INSERT INTO summary_checkpoints (owner_user_id, campaign_id, through_turn, summary_kind, content, token_estimate, created_at)
     SELECT owner_user_id, $1, through_turn, summary_kind, content, token_estimate, created_at
       FROM summary_checkpoints WHERE owner_user_id = $2 AND campaign_id = $3`,
    [campaignId, scope.ownerUserId, source.id],
  );
  await client.query(
    `INSERT INTO campaign_illustration_configs (
       campaign_id, owner_user_id, enabled, source_policy, matching_scope, confidence_profile, repetition_window,
       provider_profile_id, model, size, aspect_ratio, quality, output_format, max_attempts,
       segment_word_count, images_per_segment, segment_prompt_mode, refinement_prompt, created_at, updated_at
     ) SELECT $1, owner_user_id, enabled, source_policy, matching_scope, confidence_profile, repetition_window,
              provider_profile_id, model, size, aspect_ratio, quality, output_format, max_attempts,
              segment_word_count, images_per_segment, segment_prompt_mode, refinement_prompt, created_at, updated_at
         FROM campaign_illustration_configs WHERE owner_user_id = $2 AND campaign_id = $3`,
    [campaignId, scope.ownerUserId, source.id],
  );
  await client.query(
    `INSERT INTO campaign_memory_configs (
       campaign_id, owner_user_id, embedding_enabled, embedding_provider_profile_id, embedding_model,
       embedding_batch_size, embedding_document_prefix, embedding_query_prefix, created_at, updated_at
     ) SELECT $1, owner_user_id, embedding_enabled, embedding_provider_profile_id, embedding_model,
              embedding_batch_size, embedding_document_prefix, embedding_query_prefix, created_at, updated_at
         FROM campaign_memory_configs WHERE owner_user_id = $2 AND campaign_id = $3`,
    [campaignId, scope.ownerUserId, source.id],
  );
  const references = await client.query<{ asset_id: string; turn_id: string | null; asset_role: string; created_at: Date }>(
    `SELECT asset_id, turn_id, asset_role, created_at FROM asset_references
      WHERE owner_user_id = $1 AND campaign_id = $2 ORDER BY created_at`,
    [scope.ownerUserId, source.id],
  );
  for (const reference of references.rows) {
    const mappedTurnId = reference.turn_id ? turnIds.get(reference.turn_id) : null;
    if (reference.turn_id && !mappedTurnId) transferUnavailable(scope, target.id);
    await client.query(
      `INSERT INTO asset_references (owner_user_id, asset_id, campaign_id, turn_id, asset_role, created_at)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [scope.ownerUserId, reference.asset_id, campaignId, mappedTurnId, reference.asset_role, reference.created_at],
    );
  }
  const memoryScope = { ownerUserId: scope.ownerUserId, campaignId, worldVersionId: target.id };
  const memoryCount = await memory.rebuildCampaignMemories(client, memoryScope);
  const embeddingJobId = await memory.enqueueEmbeddingReindex(client, memoryScope);
  return { campaignId, memoryCount, embeddingJobId };
}

async function existingTransfer(client: DatabaseClient, scope: CampaignScope, idempotencyKey: string) {
  const result = await client.query(
    `SELECT cwt.id, cwt.source_campaign_id, cwt.target_campaign_id, cwt.from_world_version_id,
            cwt.to_world_version_id, cwt.source_fingerprint, cwt.warnings, wv.world_id AS target_world_id
       FROM campaign_world_transfers cwt
       JOIN world_versions wv ON wv.id = cwt.to_world_version_id AND wv.owner_user_id = cwt.owner_user_id
      WHERE cwt.owner_user_id = $1 AND cwt.idempotency_key = $2`,
    [scope.ownerUserId, idempotencyKey],
  );
  if (!result.rows[0]) return null;
  const parsed = z.object({
    id: z.uuid(), source_campaign_id: z.uuid().nullable(), target_campaign_id: z.uuid().nullable(),
    from_world_version_id: z.uuid(), to_world_version_id: z.uuid(), target_world_id: z.uuid(),
    source_fingerprint: z.string().regex(/^[a-f0-9]{64}$/), warnings: campaignTransferFindingSchema.array()
  }).safeParse(result.rows[0]);
  if (!parsed.success || !parsed.data.source_campaign_id || !parsed.data.target_campaign_id) transferUnavailable(scope);
  const transfer = parsed.data;
  const sourceCampaignId = transfer.source_campaign_id;
  const targetCampaignId = transfer.target_campaign_id;
  if (!sourceCampaignId || !targetCampaignId) transferUnavailable(scope);
  const campaign = await client.query<{ active_turn_number: number }>(
    "SELECT active_turn_number FROM campaigns WHERE owner_user_id = $1 AND id = $2",
    [scope.ownerUserId, targetCampaignId],
  );
  if (!campaign.rows[0]) transferUnavailable(scope);
  const memory = await client.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM chronicle_memories WHERE owner_user_id = $1 AND campaign_id = $2",
    [scope.ownerUserId, targetCampaignId],
  );
  const job = await client.query<{ id: string }>(
    `SELECT id FROM chronicle_jobs WHERE owner_user_id = $1 AND campaign_id = $2 AND job_type = 'embed_campaign'
      ORDER BY created_at DESC LIMIT 1`,
    [scope.ownerUserId, targetCampaignId],
  );
  return {
    transferId: transfer.id, sourceCampaignId,
    targetCampaignId, fromWorldVersionId: transfer.from_world_version_id,
    targetWorldId: transfer.target_world_id, targetWorldVersionId: transfer.to_world_version_id,
    sourceFingerprint: transfer.source_fingerprint, activeTurnNumber: campaign.rows[0].active_turn_number,
    chronicleMemoryCount: memory.rows[0]?.count ?? 0, embeddingJobId: job.rows[0]?.id ?? null,
    warnings: transfer.warnings, reused: true as const
  };
}

export function createPostgresCampaignTransferRepository(
  collaborators: Readonly<{ memory: TransferMemory }>,
): CampaignTransferRepositoryPort {
  return {
    async previewCampaignWorldTransfer(transaction, scope, input) {
      const request = parseRequest(campaignTransferPreviewRequestSchema, input, scope);
      const client = worldCampaignDatabaseClient(transaction);
      const source = await loadTransferSource(client, scope);
      const target = await loadTransferTarget(client, scope, request.targetWorldVersionId);
      const counts = await transferCounts(client, scope);
      const findings = transferCompatibility(source, target, counts);
      const snapshotName = source.character_profile?.name ?? source.character_snapshot?.name ?? null;
      return {
        allowed: !findings.some((finding) => finding.severity === "blocking"),
        source: {
          campaignId: source.id, campaignTitle: source.title, worldId: source.world_id,
          worldTitle: source.world_title, worldVersionId: source.world_version_id,
          worldVersionNumber: source.world_version_number
        },
        target: {
          worldId: target.world_id, worldTitle: target.world_title,
          worldVersionId: target.id, worldVersionNumber: target.version_number
        },
        proposedTitle: request.title || `${source.title} (${target.world_title})`,
        counts: { turns: counts.turn_count, stateEdits: counts.state_edit_count, summaries: counts.summary_count, assets: counts.asset_count },
        character: {
          id: source.selected_character_id, name: snapshotName,
          targetMatches: target.content.playableCharacters.filter((character) => (
            character.id === source.selected_character_id
            || Boolean(snapshotName && character.name.toLocaleLowerCase() === snapshotName.toLocaleLowerCase())
          )).map((character) => ({ id: character.id, name: character.name }))
        },
        findings, expectedActiveTurnNumber: source.active_turn_number,
        expectedStateRevision: source.state_revision,
        sourceFingerprint: transferFingerprint(source, target.id, request)
      };
    },

    async transferCampaignWorld(transaction, scope, input) {
      const request = parseRequest(campaignTransferCommitRequestSchema, input, scope);
      const client = worldCampaignDatabaseClient(transaction);
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`${scope.ownerUserId}:${request.idempotencyKey}`]);
      const prior = await existingTransfer(client, scope, request.idempotencyKey);
      if (prior) {
        if (prior.sourceCampaignId !== scope.campaignId
          || prior.targetWorldVersionId !== request.targetWorldVersionId
          || prior.sourceFingerprint !== request.sourceFingerprint) {
          return failure("idempotency_mismatch", { campaignId: scope.campaignId, worldVersionId: request.targetWorldVersionId });
        }
        return success(prior);
      }
      const source = await loadTransferSource(client, scope, true);
      const target = await loadTransferTarget(client, scope, request.targetWorldVersionId, true);
      const counts = await transferCounts(client, scope);
      const findings = transferCompatibility(source, target, counts);
      if (source.active_turn_number !== request.expectedActiveTurnNumber) {
        return failure("active_turn_changed", {
          campaignId: scope.campaignId, expectedTurnNumber: request.expectedActiveTurnNumber,
          actualTurnNumber: source.active_turn_number
        });
      }
      if (source.state_revision !== request.expectedStateRevision) {
        return failure("state_revision_changed", {
          campaignId: scope.campaignId, expectedStateRevision: request.expectedStateRevision,
          actualStateRevision: source.state_revision
        });
      }
      const blockers = findings.filter((finding) => finding.severity === "blocking");
      if (blockers.length) return failure("invalid_transition", { campaignId: scope.campaignId, findings });
      const currentFingerprint = transferFingerprint(source, target.id, request);
      if (currentFingerprint !== request.sourceFingerprint) {
        return failure("state_revision_changed", {
          campaignId: scope.campaignId, expectedStateRevision: request.expectedStateRevision,
          actualStateRevision: source.state_revision
        });
      }
      const transferId = crypto.randomUUID();
      const clone = await cloneTransferredCampaign(
        client, collaborators.memory, scope, source, target,
        request.title || `${source.title} (${target.world_title})`, transferId,
      );
      const warnings = findings.filter((finding) => finding.severity !== "blocking");
      await client.query(
        `INSERT INTO campaign_world_transfers (
           id, owner_user_id, idempotency_key, source_campaign_id, target_campaign_id,
           from_world_version_id, to_world_version_id, character_strategy, state_strategy,
           target_defaults_policy, source_fingerprint, warnings, note
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [transferId, scope.ownerUserId, request.idempotencyKey, source.id, clone.campaignId,
          source.world_version_id, target.id, request.characterStrategy, request.stateStrategy,
          request.targetDefaultsPolicy, currentFingerprint, json(warnings), request.note],
      );
      const details = json({
        transferId, sourceCampaignId: source.id, targetCampaignId: clone.campaignId,
        fromWorldVersionId: source.world_version_id, toWorldVersionId: target.id,
        copiedTurns: counts.turn_count, copiedStateEdits: counts.state_edit_count,
        copiedAssetReferences: counts.asset_count, compatibilityCodes: warnings.map((finding) => finding.code)
      });
      await client.query(
        `INSERT INTO activity_events (owner_user_id, campaign_id, event_type, correlation_id, details)
         VALUES ($1,$2,'campaign_world_transfer_source',$3,$4),
                ($1,$5,'campaign_world_transfer_target',$3,$4)`,
        [scope.ownerUserId, source.id, transferId, details, clone.campaignId],
      );
      return success({
        transferId, sourceCampaignId: source.id, targetCampaignId: clone.campaignId,
        fromWorldVersionId: source.world_version_id, targetWorldId: target.world_id,
        targetWorldVersionId: target.id, activeTurnNumber: source.active_turn_number,
        chronicleMemoryCount: clone.memoryCount, embeddingJobId: clone.embeddingJobId,
        warnings, reused: false
      });
    }
  };
}
