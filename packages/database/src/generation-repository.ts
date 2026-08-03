import type {
  GenerationRequest,
  GenerationResult,
  GenerationRetryLatestRequest
} from "../../contracts/src/index.js";
import {
  GenerationApplicationError,
  type GenerationCommandRepository,
  type GenerationJob,
  type GenerationMutationResult
} from "../../application/src/index.js";
import type { PromptSnapshot } from "../../contracts/src/prompt-library.js";
import { storyLengthProfileFromUnknown, storyLengthWordRange } from "../../contracts/src/story-settings.js";
import { sha256, stableStringify } from "../../domain/src/index.js";
import { extractPartialNarration, formatNarrationParagraphs, STORY_PROMPT_PROTOCOL_VERSION } from "../../story-engine/src/index.js";
import type { DatabaseClient, DatabasePool } from "./pool.js";
import { withTransaction } from "./pool.js";

type OperationKind = "append" | "replace_latest";
type JobStatus = GenerationJob["status"];

type EnqueueRow = {
  id: string;
  status: JobStatus;
  action: string;
  operationKind: OperationKind;
  replacementTurnId: string | null;
  expectedTurnNumber: number;
  createdAt: string;
  resultTurnId?: string | null;
  recoveryMetadata?: Record<string, unknown>;
};

type JobRow = {
  id: string;
  campaignId: string;
  providerProfileId: string | null;
  expectedTurnNumber: number;
  action: string;
  status: JobStatus;
  attempts: number;
  requestedInputMode: "auto" | "action" | "scene";
  resolvedInputMode: "action" | "scene";
  inputModeSource: "explicit" | "auto" | "generated_choice" | "opening_action" | "fallback";
  operationKind: OperationKind;
  replacementTurnId: string | null;
  baseTurnNumber: number | null;
  requestedModel: string;
  providerResponseId: string | null;
  providerFinishReason: string | null;
  resultTurnId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  recoveryMetadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  partialOutput: string | null;
};

type ResultRow = {
  id: string;
  status: JobStatus;
  campaignId: string;
  expectedTurnNumber: number;
  resultTurnId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  turnNumber: number | null;
  action: string | null;
  inputMode: "action" | "scene" | null;
  inputModeSource: "explicit" | "auto" | "generated_choice" | "opening_action" | "fallback" | null;
  narration: string | null;
  choices: string[] | null;
  customActionSuggestion: string | null;
  imagePrompt: string | null;
  modelMetadata: Record<string, unknown> | null;
  mechanics: Record<string, unknown> | null;
  acceptedAt: string | null;
  stateSnapshot: Record<string, unknown> | null;
};

type MutationRow = {
  id: string;
  status: "queued" | "replacement_queued" | "cancelled" | "discarded";
  campaignId?: string;
  providerProfileId?: string;
  expectedTurnNumber?: number;
  attempts?: number;
  operationKind: OperationKind;
  replacementTurnId: string | null;
};

export type PostgresGenerationCommandRepositoryDependencies = Readonly<{
  resolvePromptSnapshot: (
    client: DatabaseClient,
    ownerUserId: string,
    campaignId: string,
  ) => Promise<PromptSnapshot>;
  promptProtocolVersion: (snapshot: PromptSnapshot) => string;
  readTurnReportedCosts: (
    ownerUserId: string,
    turnIds: readonly string[],
  ) => Promise<ReadonlyMap<string, GenerationResult["reportedCost"]>>;
}>;

function json(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function sqlState(error: unknown): string | null {
  return typeof error === "object" && error !== null && "code" in error && typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code
    : null;
}

function enqueueResult(row: EnqueueRow, duplicate: boolean) {
  if (row.operationKind === "append") {
    return {
      id: row.id,
      status: row.status,
      duplicate,
      operationKind: "append" as const,
      replacementTurnId: null,
      action: row.action,
      expectedTurnNumber: row.expectedTurnNumber,
      createdAt: row.createdAt,
      ...(row.resultTurnId === undefined ? {} : { resultTurnId: row.resultTurnId }),
      ...(row.recoveryMetadata === undefined ? {} : { recoveryMetadata: row.recoveryMetadata })
    };
  }
  return {
    id: row.id,
    status: row.status,
    duplicate,
    operationKind: "replace_latest" as const,
    replacementTurnId: row.replacementTurnId!,
    action: row.action,
    expectedTurnNumber: row.expectedTurnNumber,
    createdAt: row.createdAt,
    ...(row.resultTurnId === undefined ? {} : { resultTurnId: row.resultTurnId }),
    ...(row.recoveryMetadata === undefined ? {} : { recoveryMetadata: row.recoveryMetadata })
  };
}

function mutationResult(row: MutationRow): GenerationMutationResult {
  if (row.operationKind === "append") {
    return { id: row.id, status: row.status, operationKind: "append", replacementTurnId: null };
  }
  return { id: row.id, status: row.status, operationKind: "replace_latest", replacementTurnId: row.replacementTurnId! };
}

function jobResult(row: JobRow): GenerationJob {
  const base = {
    id: row.id,
    campaignId: row.campaignId,
    providerProfileId: row.providerProfileId,
    expectedTurnNumber: row.expectedTurnNumber,
    action: row.action,
    status: row.status,
    attempts: row.attempts,
    requestedInputMode: row.requestedInputMode,
    resolvedInputMode: row.resolvedInputMode,
    inputModeSource: row.inputModeSource,
    baseTurnNumber: row.baseTurnNumber,
    requestedModel: row.requestedModel,
    providerResponseId: row.providerResponseId,
    providerFinishReason: row.providerFinishReason,
    resultTurnId: row.resultTurnId,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    recoveryMetadata: row.recoveryMetadata,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    completedAt: row.completedAt,
    partialOutput: row.partialOutput,
    partialNarration: row.partialOutput ? extractPartialNarration(row.partialOutput) : null
  };
  return row.operationKind === "append"
    ? { ...base, operationKind: "append", replacementTurnId: null }
    : { ...base, operationKind: "replace_latest", replacementTurnId: row.replacementTurnId! };
}

function notFound(details: { campaignId?: string; jobId?: string }) {
  return new GenerationApplicationError("not_found", details);
}

async function validateTurnInputMode(
  client: DatabaseClient,
  ownerUserId: string,
  campaignId: string,
  request: GenerationRequest,
  turnControlStyle: string
): Promise<string | null> {
  if (turnControlStyle === "action_only" && request.resolvedInputMode !== "action") {
    throw new GenerationApplicationError("invalid_state", { reason: "action_only_mode" });
  }
  if (request.requestedInputMode !== "auto") {
    if (request.classificationId) {
      throw new GenerationApplicationError("invalid_state", { reason: "classification_id_forbidden" });
    }
    if (request.requestedInputMode !== request.resolvedInputMode) {
      throw new GenerationApplicationError("invalid_state", { reason: "explicit_input_mode_mismatch" });
    }
    return null;
  }
  if (!request.classificationId) {
    throw new GenerationApplicationError("invalid_state", { reason: "classification_missing_or_expired" });
  }
  const result = await client.query<{ id: string; resolved_mode: "action" | "scene" }>(
    `SELECT id, resolved_mode FROM turn_input_classifications
      WHERE id = $1 AND owner_user_id = $2 AND campaign_id = $3 AND input_hash = $4
        AND consumed_at IS NULL AND expires_at > now() FOR UPDATE`,
    [request.classificationId, ownerUserId, campaignId, sha256(request.action)]
  );
  const classification = result.rows[0];
  if (!classification) {
    throw new GenerationApplicationError("conflict", { reason: "classification_missing_or_expired" });
  }
  if (classification.resolved_mode !== request.resolvedInputMode) {
    throw new GenerationApplicationError("conflict", { reason: "classification_mode_mismatch" });
  }
  await client.query("UPDATE turn_input_classifications SET consumed_at = now() WHERE id = $1", [classification.id]);
  return classification.id;
}

async function resolveTextProviderId(
  client: DatabaseClient,
  ownerUserId: string,
  selectedId: string | null | undefined
): Promise<string | null> {
  if (selectedId) {
    const selected = await client.query<{ id: string }>(
      "SELECT id FROM provider_profiles WHERE id = $1 AND owner_user_id = $2 AND provider_role = 'text' AND enabled = true",
      [selectedId, ownerUserId]
    );
    if (!selected.rows[0]) {
      throw new GenerationApplicationError("provider_required", { reason: "selected_provider_unavailable", providerProfileId: selectedId });
    }
    return selectedId;
  }
  const result = await client.query<{ id: string; is_default: boolean }>(
    "SELECT id, is_default FROM provider_profiles WHERE owner_user_id = $1 AND provider_role = 'text' AND enabled = true ORDER BY is_default DESC, name",
    [ownerUserId]
  );
  if (result.rows.length === 1 || result.rows[0]?.is_default) return result.rows[0]?.id ?? null;
  return null;
}

async function activeGenerationConflict(client: DatabaseClient, ownerUserId: string, campaignId: string): Promise<never> {
  const active = await client.query<{
    id: string;
    status: JobStatus;
    action: string;
    operationKind: OperationKind;
    expectedTurnNumber: number;
  }>(
    `SELECT id, status, action, operation_kind AS "operationKind", expected_turn_number AS "expectedTurnNumber"
       FROM generation_jobs WHERE campaign_id = $1 AND owner_user_id = $2
        AND status IN ('queued','replacement_queued','assessing','generating','validating','committing','recoverable') LIMIT 1`,
    [campaignId, ownerUserId]
  );
  const pending = active.rows[0];
  throw new GenerationApplicationError("active_job", {
    reason: "active_generation",
    pendingGeneration: pending
      ? {
          id: pending.id,
          status: pending.status,
          action: pending.action,
          operationKind: pending.operationKind,
          expectedTurnNumber: pending.expectedTurnNumber
        }
      : null
  });
}

export function createPostgresGenerationCommandRepository(
  pool: DatabasePool,
  dependencies: PostgresGenerationCommandRepositoryDependencies,
): GenerationCommandRepository {
  return {
    async enqueueAppend(scope, request) {
      return withTransaction(pool, async (client) => {
        const requestFingerprint = sha256(stableStringify(request));
        const existing = await client.query<EnqueueRow & { recoveryMetadata: Record<string, unknown> }>(
          `SELECT id, status, result_turn_id AS "resultTurnId", action, operation_kind AS "operationKind",
                  replacement_turn_id AS "replacementTurnId", expected_turn_number AS "expectedTurnNumber",
                  recovery_metadata AS "recoveryMetadata", created_at AS "createdAt"
             FROM generation_jobs WHERE campaign_id = $1 AND idempotency_key = $2 AND owner_user_id = $3`,
          [scope.campaignId, request.idempotencyKey, scope.ownerUserId]
        );
        const existingJob = existing.rows[0];
        if (existingJob) {
          if (existingJob.action !== request.action || existingJob.operationKind !== "append"
              || (existingJob.recoveryMetadata.requestFingerprint && existingJob.recoveryMetadata.requestFingerprint !== requestFingerprint)) {
            throw new GenerationApplicationError("conflict", { reason: "idempotency_mismatch" });
          }
          return enqueueResult(existingJob, true);
        }
        const campaignResult = await client.query<{
          active_turn_number: number;
          text_provider_profile_id: string | null;
          story_length_profile: string;
          turn_control_style: string;
        }>(
          `SELECT active_turn_number, text_provider_profile_id, story_length_profile, turn_control_style
             FROM campaigns WHERE id = $1 AND owner_user_id = $2 FOR UPDATE`,
          [scope.campaignId, scope.ownerUserId]
        );
        const campaign = campaignResult.rows[0];
        if (!campaign) throw notFound({ campaignId: scope.campaignId });
        const classificationId = await validateTurnInputMode(client, scope.ownerUserId, scope.campaignId, request, campaign.turn_control_style);
        const providerProfileId = await resolveTextProviderId(client, scope.ownerUserId, request.providerProfileId || campaign.text_provider_profile_id);
        if (!providerProfileId) throw new GenerationApplicationError("provider_required", { reason: "no_text_provider" });
        const storyLengthProfile = storyLengthProfileFromUnknown(campaign.story_length_profile);
        const storyLength = storyLengthWordRange(storyLengthProfile);
        const promptSnapshot = await dependencies.resolvePromptSnapshot(client, scope.ownerUserId, scope.campaignId);
        const contextSnapshot = {
          ...request.context,
          storyLengthProfile,
          narrationMinWords: storyLength.minWords,
          narrationMaxWords: storyLength.maxWords
        };
        await client.query("SAVEPOINT enqueue_generation_insert");
        try {
          const inserted = await client.query<EnqueueRow>(
            `INSERT INTO generation_jobs (
               owner_user_id, campaign_id, provider_profile_id, idempotency_key, expected_turn_number,
               action, requested_input_mode, resolved_input_mode, input_mode_source, turn_input_classification_id,
               requested_model, context_options, prompt_protocol_version, recovery_metadata, prompt_snapshot
             ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
             RETURNING id, status, action, operation_kind AS "operationKind", replacement_turn_id AS "replacementTurnId",
                       expected_turn_number AS "expectedTurnNumber", created_at AS "createdAt"`,
            [scope.ownerUserId, scope.campaignId, providerProfileId, request.idempotencyKey, campaign.active_turn_number + 1,
              request.action, request.requestedInputMode, request.resolvedInputMode, request.inputModeSource, classificationId,
              request.model || "", json(contextSnapshot), dependencies.promptProtocolVersion(promptSnapshot),
              json({ requestFingerprint }), json(promptSnapshot)]
          );
          return enqueueResult(inserted.rows[0]!, false);
        } catch (error) {
          if (sqlState(error) === "23505") {
            await client.query("ROLLBACK TO SAVEPOINT enqueue_generation_insert");
            return activeGenerationConflict(client, scope.ownerUserId, scope.campaignId);
          }
          throw error;
        }
      });
    },

    async enqueueReplacement(scope, request) {
      return withTransaction(pool, async (client) => {
        const existing = await client.query<EnqueueRow & { recoveryMetadata: Record<string, unknown> }>(
          `SELECT id, status, result_turn_id AS "resultTurnId", action, operation_kind AS "operationKind",
                  replacement_turn_id AS "replacementTurnId", expected_turn_number AS "expectedTurnNumber",
                  recovery_metadata AS "recoveryMetadata", created_at AS "createdAt"
             FROM generation_jobs
            WHERE campaign_id = $1 AND idempotency_key = $2 AND owner_user_id = $3`,
          [scope.campaignId, request.idempotencyKey, scope.ownerUserId]
        );
        const existingJob = existing.rows[0];
        if (existingJob) {
          const requestFingerprint = sha256(stableStringify(request));
          if (existingJob.action !== request.action || existingJob.operationKind !== "replace_latest"
              || existingJob.expectedTurnNumber !== request.expectedCurrentTurnNumber
              || (existingJob.recoveryMetadata.requestFingerprint && existingJob.recoveryMetadata.requestFingerprint !== requestFingerprint)) {
            throw new GenerationApplicationError("conflict", { reason: "idempotency_mismatch" });
          }
          return enqueueResult(existingJob, true);
        }
        const campaignResult = await client.query<{
          active_turn_number: number;
          text_provider_profile_id: string | null;
          story_length_profile: string;
          turn_control_style: string;
        }>(
          `SELECT active_turn_number, text_provider_profile_id, story_length_profile, turn_control_style
             FROM campaigns WHERE id = $1 AND owner_user_id = $2 FOR UPDATE`,
          [scope.campaignId, scope.ownerUserId]
        );
        const campaign = campaignResult.rows[0];
        if (!campaign) throw notFound({ campaignId: scope.campaignId });
        const classificationId = await validateTurnInputMode(client, scope.ownerUserId, scope.campaignId, request, campaign.turn_control_style);
        if (campaign.active_turn_number !== request.expectedCurrentTurnNumber) {
          throw new GenerationApplicationError("stale_turn", {
            reason: "stale_current_turn",
            expectedTurnNumber: request.expectedCurrentTurnNumber,
            actualTurnNumber: campaign.active_turn_number
          });
        }
        const replacement = await client.query<{ id: string }>(
          `SELECT id FROM turns
            WHERE campaign_id = $1 AND owner_user_id = $2 AND turn_number = $3 FOR UPDATE`,
          [scope.campaignId, scope.ownerUserId, campaign.active_turn_number]
        );
        const replacementTurnId = replacement.rows[0]?.id;
        if (!replacementTurnId) throw new GenerationApplicationError("not_found", { reason: "missing_latest_turn", campaignId: scope.campaignId });
        const activeImage = await client.query<{ id: string }>(
          `SELECT id FROM image_jobs
            WHERE campaign_id = $1 AND owner_user_id = $2 AND turn_id = $3
              AND status = 'generating' LIMIT 1`,
          [scope.campaignId, scope.ownerUserId, replacementTurnId]
        );
        if (activeImage.rows[0]) throw new GenerationApplicationError("active_job", { reason: "active_illustration" });
        await client.query(
          `DELETE FROM image_jobs
            WHERE campaign_id = $1 AND owner_user_id = $2 AND turn_id = $3 AND status = 'queued'`,
          [scope.campaignId, scope.ownerUserId, replacementTurnId]
        );
        const providerProfileId = await resolveTextProviderId(client, scope.ownerUserId, request.providerProfileId || campaign.text_provider_profile_id);
        if (!providerProfileId) throw new GenerationApplicationError("provider_required", { reason: "no_text_provider" });
        const baseTurnNumber = campaign.active_turn_number - 1;
        let baseState: Record<string, unknown> = {};
        let baseScratchpadSafeForPrompt = false;
        if (baseTurnNumber === 0) {
          const initial = await client.query<{ initial_state_snapshot: Record<string, unknown> }>(
            `SELECT initial_state_snapshot FROM campaign_state
              WHERE campaign_id = $1 AND owner_user_id = $2`,
            [scope.campaignId, scope.ownerUserId]
          );
          baseState = initial.rows[0]?.initial_state_snapshot || {};
        } else {
          const baseTurn = await client.query<{ state_snapshot_private: Record<string, unknown>; model_metadata: Record<string, unknown> }>(
            `SELECT state_snapshot_private, model_metadata FROM turns
              WHERE campaign_id = $1 AND owner_user_id = $2 AND turn_number = $3`,
            [scope.campaignId, scope.ownerUserId, baseTurnNumber]
          );
          if (!baseTurn.rows[0]) throw new Error("The replacement base turn was not found.");
          baseState = baseTurn.rows[0].state_snapshot_private || {};
          baseScratchpadSafeForPrompt = typeof baseTurn.rows[0].model_metadata?.promptProtocolVersion === "string";
        }
        const baseEdit = await client.query<{ state_snapshot_private: Record<string, unknown> }>(
          `SELECT state_snapshot_private FROM campaign_state_edits
            WHERE campaign_id = $1 AND owner_user_id = $2 AND effective_turn_number = $3
            ORDER BY revision DESC LIMIT 1`,
          [scope.campaignId, scope.ownerUserId, baseTurnNumber]
        );
        if (baseEdit.rows[0]) {
          baseState = baseEdit.rows[0].state_snapshot_private || baseState;
          baseScratchpadSafeForPrompt = true;
        }
        const storyLength = storyLengthWordRange(storyLengthProfileFromUnknown(campaign.story_length_profile));
        const promptSnapshot = await dependencies.resolvePromptSnapshot(client, scope.ownerUserId, scope.campaignId);
        const contextSnapshot = {
          ...request.context,
          storyLengthProfile: storyLength.profile,
          narrationMinWords: storyLength.minWords,
          narrationMaxWords: storyLength.maxWords
        };
        await client.query("SAVEPOINT enqueue_replacement_insert");
        try {
          const inserted = await client.query<EnqueueRow>(
            `INSERT INTO generation_jobs (
               owner_user_id, campaign_id, provider_profile_id, idempotency_key, expected_turn_number,
               action, requested_input_mode, resolved_input_mode, input_mode_source, turn_input_classification_id,
               requested_model, context_options, prompt_protocol_version, recovery_metadata, prompt_snapshot,
               operation_kind, replacement_turn_id, base_turn_number, base_state_private, base_scratchpad_safe_for_prompt, status
             ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'replace_latest',$16,$17,$18,$19,'replacement_queued')
            RETURNING id, status, action, expected_turn_number AS "expectedTurnNumber",
                      operation_kind AS "operationKind", replacement_turn_id AS "replacementTurnId", created_at AS "createdAt"`,
            [scope.ownerUserId, scope.campaignId, providerProfileId, request.idempotencyKey, campaign.active_turn_number,
              request.action, request.requestedInputMode, request.resolvedInputMode, request.inputModeSource, classificationId,
              request.model || "", json(contextSnapshot), dependencies.promptProtocolVersion(promptSnapshot),
              json({ requestFingerprint: sha256(stableStringify(request)) }), json(promptSnapshot), replacementTurnId,
              baseTurnNumber, json(baseState), baseScratchpadSafeForPrompt]
          );
          await client.query("RELEASE SAVEPOINT enqueue_replacement_insert");
          return enqueueResult(inserted.rows[0]!, false);
        } catch (error) {
          if (sqlState(error) === "23505") {
            await client.query("ROLLBACK TO SAVEPOINT enqueue_replacement_insert");
            await client.query("RELEASE SAVEPOINT enqueue_replacement_insert");
            return activeGenerationConflict(client, scope.ownerUserId, scope.campaignId);
          }
          throw error;
        }
      });
    },

    async getJob(scope) {
      const result = await pool.query<JobRow>(
        `SELECT id, campaign_id AS "campaignId", provider_profile_id AS "providerProfileId",
                expected_turn_number AS "expectedTurnNumber", action, status, attempts,
                requested_input_mode AS "requestedInputMode", resolved_input_mode AS "resolvedInputMode",
                input_mode_source AS "inputModeSource", operation_kind AS "operationKind",
                replacement_turn_id AS "replacementTurnId", base_turn_number AS "baseTurnNumber",
                requested_model AS "requestedModel", provider_response_id AS "providerResponseId",
                provider_finish_reason AS "providerFinishReason", result_turn_id AS "resultTurnId",
                error_code AS "errorCode", error_message AS "errorMessage", recovery_metadata AS "recoveryMetadata",
                created_at AS "createdAt", updated_at AS "updatedAt", completed_at AS "completedAt",
                partial_output AS "partialOutput"
           FROM generation_jobs WHERE id = $1 AND owner_user_id = $2`,
        [scope.jobId, scope.ownerUserId]
      );
      const row = result.rows[0];
      if (!row) throw notFound({ jobId: scope.jobId });
      return jobResult(row);
    },

    async getResult(scope) {
      const result = await pool.query<ResultRow>(
        `SELECT j.id, j.status, j.campaign_id AS "campaignId", j.expected_turn_number AS "expectedTurnNumber",
                j.result_turn_id AS "resultTurnId", j.error_code AS "errorCode", j.error_message AS "errorMessage",
                t.turn_number AS "turnNumber", t.action, COALESCE(t.input_mode, 'action') AS "inputMode",
                COALESCE(t.input_mode_source, 'explicit') AS "inputModeSource", t.narration, t.choices,
                t.custom_action_suggestion AS "customActionSuggestion", t.image_prompt AS "imagePrompt",
                t.model_metadata AS "modelMetadata", t.mechanics_private AS mechanics, t.accepted_at AS "acceptedAt",
                jsonb_build_object(
                  'scratchpad', cs.scratchpad_private, 'trackers', cs.trackers, 'eventTriggers', cs.event_triggers,
                  'pendingEventTriggers', cs.pending_event_triggers, 'rpgStats', cs.rpg_stats
                ) AS "stateSnapshot"
           FROM generation_jobs j
           LEFT JOIN turns t ON t.id = j.result_turn_id AND t.owner_user_id = j.owner_user_id
           LEFT JOIN campaign_state cs ON cs.campaign_id = j.campaign_id AND cs.owner_user_id = j.owner_user_id
          WHERE j.id = $1 AND j.owner_user_id = $2`,
        [scope.jobId, scope.ownerUserId]
      );
      const row = result.rows[0];
      if (!row) throw notFound({ jobId: scope.jobId });
      if (row.status !== "completed" || !row.resultTurnId) {
        throw new GenerationApplicationError("invalid_state", {
          reason: "result_not_completed",
          generationStatus: row.status
        });
      }
      const costs = await dependencies.readTurnReportedCosts(scope.ownerUserId, [row.resultTurnId]);
      return {
        id: row.id,
        status: "completed",
        campaignId: row.campaignId,
        expectedTurnNumber: row.expectedTurnNumber,
        resultTurnId: row.resultTurnId,
        errorCode: row.errorCode,
        errorMessage: row.errorMessage,
        turnNumber: row.turnNumber!,
        action: row.action!,
        inputMode: row.inputMode!,
        inputModeSource: row.inputModeSource!,
        narration: formatNarrationParagraphs(String(row.narration || "")),
        choices: row.choices || [],
        customActionSuggestion: row.customActionSuggestion || "",
        imagePrompt: row.imagePrompt || "",
        modelMetadata: row.modelMetadata,
        mechanics: row.mechanics,
        acceptedAt: row.acceptedAt!,
        stateSnapshot: row.stateSnapshot || {},
        reportedCost: costs.get(row.resultTurnId) || null
      } as GenerationResult;
    },

    async retry(scope) {
      const result = await pool.query<MutationRow & { generationStatus: JobStatus }>(
        `WITH source AS (
           SELECT id, status, campaign_id AS "campaignId", provider_profile_id AS "providerProfileId",
                  expected_turn_number AS "expectedTurnNumber", attempts
             FROM generation_jobs WHERE id = $1 AND owner_user_id = $2
         ), updated AS (
           UPDATE generation_jobs SET status = CASE WHEN operation_kind = 'replace_latest' THEN 'replacement_queued' ELSE 'queued' END,
               lease_owner = NULL, lease_expires_at = NULL, error_code = NULL, error_message = NULL,
               prompt_protocol_version = $3, updated_at = now()
             WHERE id IN (SELECT id FROM source) AND status IN ('recoverable', 'failed')
             RETURNING id, status, operation_kind AS "operationKind", replacement_turn_id AS "replacementTurnId"
         ) SELECT updated.id, updated.status, updated."operationKind", updated."replacementTurnId", source.status AS "generationStatus",
                  source."campaignId", source."providerProfileId", source."expectedTurnNumber", source.attempts
             FROM source LEFT JOIN updated ON updated.id = source.id`,
        [scope.jobId, scope.ownerUserId, STORY_PROMPT_PROTOCOL_VERSION]
      );
      const row = result.rows[0];
      if (!row) throw notFound({ jobId: scope.jobId });
      if (!row.id) throw new GenerationApplicationError("invalid_state", { reason: "retry_source_state", generationStatus: row.generationStatus });
      return {
        ...mutationResult(row),
        campaignId: row.campaignId!,
        providerProfileId: row.providerProfileId!,
        expectedTurnNumber: row.expectedTurnNumber!,
        attempts: row.attempts!
      };
    },

    async cancel(scope) {
      return withTransaction(pool, async (client) => {
        const result = await client.query<MutationRow>(
          `UPDATE generation_jobs
              SET status = 'cancelled', lease_owner = NULL, lease_expires_at = NULL, partial_output = NULL,
                  error_code = 'cancelled_by_player', error_message = 'Cancelled by player.', updated_at = now()
            WHERE id = $1 AND owner_user_id = $2
              AND status IN ('queued', 'replacement_queued', 'assessing', 'generating', 'validating', 'committing')
            RETURNING id, status, campaign_id AS "campaignId", operation_kind AS "operationKind", replacement_turn_id AS "replacementTurnId"`,
          [scope.jobId, scope.ownerUserId]
        );
        let job = result.rows[0];
        if (!job) {
          const existing = await client.query<MutationRow & { status: JobStatus }>(
            `SELECT id, status, campaign_id AS "campaignId", operation_kind AS "operationKind", replacement_turn_id AS "replacementTurnId"
               FROM generation_jobs WHERE id = $1 AND owner_user_id = $2 FOR UPDATE`,
            [scope.jobId, scope.ownerUserId]
          );
          const row = existing.rows[0];
          if (!row) throw notFound({ jobId: scope.jobId });
          if (row.status === "cancelled") return { ...mutationResult(row), campaignId: row.campaignId };
          throw new GenerationApplicationError("invalid_state", { reason: "cancel_source_state", generationStatus: row.status });
        }
        const cancelledImages = await client.query<{ id: string }>(
          `UPDATE image_jobs SET status = 'cancelled', asset_id = NULL, lease_owner = NULL, lease_expires_at = NULL,
              completed_at = now(), updated_at = now()
            WHERE generation_job_id = $1 AND owner_user_id = $2 AND campaign_id = $3
              AND target_type = 'streaming_illustration'
              AND status IN ('queued', 'generating', 'provider_pending', 'downloading', 'completed') RETURNING id`,
          [job.id, scope.ownerUserId, job.campaignId]
        );
        if (cancelledImages.rows.length) {
          await client.query(
            `DELETE FROM turn_illustration_segment_assets
              WHERE owner_user_id = $1 AND image_job_id = ANY($2::uuid[])`,
            [scope.ownerUserId, cancelledImages.rows.map((image) => image.id)]
          );
        }
        await client.query(
          `DELETE FROM asset_references refs USING illustration_resolution_jobs resolutions, turn_illustration_segments segments
            WHERE resolutions.segment_id = segments.id AND segments.generation_job_id = $1 AND segments.owner_user_id = $2
              AND segments.campaign_id = $3 AND segments.turn_id IS NULL AND refs.owner_user_id = segments.owner_user_id
              AND refs.campaign_id = segments.campaign_id AND refs.asset_id = resolutions.selected_asset_id
              AND refs.turn_id IS NOT DISTINCT FROM resolutions.turn_id AND refs.asset_role = 'turn_illustration'`,
          [job.id, scope.ownerUserId, job.campaignId]
        );
        await client.query(
          `DELETE FROM turn_illustration_segment_assets assets USING turn_illustration_segments segments
            WHERE assets.segment_id = segments.id AND assets.owner_user_id = segments.owner_user_id
              AND segments.generation_job_id = $1 AND segments.owner_user_id = $2
              AND segments.campaign_id = $3 AND segments.turn_id IS NULL`,
          [job.id, scope.ownerUserId, job.campaignId]
        );
        await client.query(
          `UPDATE turn_illustration_segments SET status = 'failed', updated_at = now()
            WHERE generation_job_id = $1 AND owner_user_id = $2 AND turn_id IS NULL AND status = 'completed'`,
          [job.id, scope.ownerUserId]
        );
        await client.query(
          `UPDATE illustration_prompt_jobs prompts SET status = 'cancelled', lease_owner = NULL, lease_expires_at = NULL,
              error_code = 'generation_cancelled', error_message = 'Parent generation was cancelled.', completed_at = now(), updated_at = now()
             FROM turn_illustration_segments segments
            WHERE prompts.segment_id = segments.id AND prompts.owner_user_id = segments.owner_user_id
              AND segments.generation_job_id = $1 AND segments.owner_user_id = $2 AND segments.campaign_id = $3
              AND segments.turn_id IS NULL AND prompts.status IN ('queued', 'refining', 'recoverable', 'fallback')`,
          [job.id, scope.ownerUserId, job.campaignId]
        );
        await client.query(
          `UPDATE illustration_resolution_jobs resolutions SET status = 'cancelled', reason_code = 'generation_cancelled',
              lease_owner = NULL, lease_expires_at = NULL, completed_at = now(), updated_at = now()
             FROM turn_illustration_segments segments
            WHERE resolutions.segment_id = segments.id AND resolutions.owner_user_id = segments.owner_user_id
              AND segments.generation_job_id = $1 AND segments.owner_user_id = $2 AND segments.campaign_id = $3
              AND segments.turn_id IS NULL AND resolutions.status IN ('queued', 'matching', 'recoverable', 'generation_queued')`,
          [job.id, scope.ownerUserId, job.campaignId]
        );
        await client.query(
          `UPDATE turn_illustration_sets SET status = 'orphaned', completed_at = NULL
            WHERE generation_job_id = $1 AND owner_user_id = $2 AND turn_id IS NULL AND status <> 'orphaned'`,
          [job.id, scope.ownerUserId]
        );
        return { ...mutationResult(job), campaignId: job.campaignId };
      });
    },

    async discard(scope) {
      const result = await pool.query<MutationRow & { generationStatus: JobStatus }>(
        `WITH source AS (
           SELECT id, status FROM generation_jobs WHERE id = $1 AND owner_user_id = $2
         ), updated AS (
           UPDATE generation_jobs SET status = 'discarded', lease_owner = NULL, lease_expires_at = NULL,
               partial_output = NULL, updated_at = now()
             WHERE id IN (SELECT id FROM source) AND status IN ('recoverable', 'failed')
             RETURNING id, status, operation_kind AS "operationKind", replacement_turn_id AS "replacementTurnId"
         ) SELECT updated.id, updated.status, updated."operationKind", updated."replacementTurnId", source.status AS "generationStatus"
             FROM source LEFT JOIN updated ON updated.id = source.id`,
        [scope.jobId, scope.ownerUserId]
      );
      const row = result.rows[0];
      if (!row) throw notFound({ jobId: scope.jobId });
      if (!row.id) throw new GenerationApplicationError("invalid_state", { reason: "discard_source_state", generationStatus: row.generationStatus });
      return mutationResult(row);
    }
  };
}
