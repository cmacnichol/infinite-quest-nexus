import type {
  GenerationRequest,
  GenerationReviewDecisionRequest,
  GenerationReviewDetail,
  GenerationResult,
  GenerationRetryLatestRequest
} from "../../contracts/src/index.js";
import { readQueuedResponsePolicyVersioned, type QueuedResponsePolicyVersioned } from "../../contracts/src/generation-response-contract.js";
import {
  GenerationApplicationError,
  type GenerationCommandRepository,
  type GenerationJob,
  type GenerationMutationResult,
  type GenerationReviewDecisionResult
} from "../../application/src/index.js";
import { generationReviewCheckpointSchema, generationReviewFindingsHash } from "../../application/src/generation/review-checkpoint.js";
import { canKeepGenerationCandidate } from "../../application/src/generation/review-policy.js";
import { generationReviewDecisionRequestSchema, projectGenerationFailureDiagnostic, projectGenerationReviewDetail, projectGenerationValidationIssues } from "../../contracts/src/generation-review.js";
import { continuityReviewCheckpointSchema } from "../../application/src/memory/continuity-review-checkpoint.js";
import {
  assertStoryPromptCompatibility,
  assertStoryMemoryPromptCompatibility,
  assertContinuityReviewPromptSnapshot,
  readPromptSnapshot,
  type PromptSnapshot,
  type PromptSnapshotV2
} from "../../contracts/src/prompt-library.js";
import { campaignTurnControlStyleSchema, generationPolicySnapshotSchema, type GenerationPolicySnapshot } from "../../contracts/src/campaign-generation-policy.js";
import { storyLengthProfileFromUnknown, storyLengthWordRange } from "../../contracts/src/story-settings.js";
import { parseStoredChronicleRetrievalAudit } from "../../contracts/src/memory.js";
import { sha256, stableStringify } from "../../domain/src/index.js";
import { extractPartialNarration, formatNarrationParagraphs, generationExecutionProtocolIdentity, storyOnlyPromptSnapshot } from "../../story-engine/src/index.js";
import type { DatabaseClient, DatabasePool } from "./pool.js";
import { withTransaction } from "./pool.js";
import { resolveGenerationAuthoritySnapshot } from "./generation-authority.js";
import { storyMemoryPolicySnapshotSchema, type StoryMemoryPolicySnapshot } from "../../contracts/src/story-memory-policy.js";
import { generationReviewSummaryProjection, projectBoundedGenerationReviewSummary } from "./generation-review-summary-projection.js";
import { generationResponseFormatProjection } from "./generation-response-format-projection.js";
import { projectGenerationResponseFormat } from "../../contracts/src/generation-response-format-projection.js";
import { textExecutionRouteBasisSchema, type TextExecutionRouteBasis } from "../../contracts/src/text-execution-plan.js";
import type { TextExecutionOverrides } from "../../contracts/src/text-execution-plan.js";
import { selectionCompatibilityId, type TextModelSelection } from "../../contracts/src/provider-selection.js";
import type { ModelParameterAdvertisement } from "../../contracts/src/text-response-format.js";

type OperationKind = "append" | "replace_latest";
type JobStatus = GenerationJob["status"];

function requestedModelFor(request: Pick<GenerationRequest, "model" | "textSelection">): string {
  return request.textSelection ? selectionCompatibilityId(request.textSelection) : request.model || "";
}

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
  failureDiagnostic: unknown;
  reviewSummary: unknown;
  responseFormat: unknown;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  partialOutput: string | null;
  generationPolicy: GenerationPolicySnapshot | null;
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

class ReplacementInsertUniqueConflict extends Error {}

export type PostgresGenerationCommandRepositoryDependencies = Readonly<{
  resolvePromptSnapshot: (
    client: DatabaseClient,
    ownerUserId: string,
    campaignId: string,
    storyMemoryPolicy?: StoryMemoryPolicySnapshot | null
  ) => Promise<PromptSnapshot | PromptSnapshotV2>;
  promptProtocolVersion: (snapshot: PromptSnapshot) => string;
  resolveStoryMemoryPolicySnapshot?: (client: DatabaseClient, scope: Readonly<{
    ownerUserId: string; campaignId: string; providerProfileId: string; requestedModel: string; modelContextWindowTokens?: number;
    /** Native v2 supplies the revision-fenced route capture so memory review
     * binds its final commit to the same frozen settings as dispatch. */
    textExecutionRouteBasis?: TextExecutionRouteBasis;
  }>) => Promise<StoryMemoryPolicySnapshot | null>;
  /** Trusted, local-only queue metadata. It is deliberately not a browser request field. */
  resolveQueuedResponsePolicy?: (client: DatabaseClient, scope: Readonly<{
    ownerUserId: string; campaignId: string; providerProfileId: string; requestedModel: string;
    modelContextWindowTokens?: number; operationKind: OperationKind; generationPolicy: GenerationPolicySnapshot;
    storyMemoryPolicy: StoryMemoryPolicySnapshot | null;
    /** Remote metadata was resolved before this transaction and passed through
     * the matching revision fence below. */
    preparedTextExecution?: PreparedQueuedTextExecution;
  }>) => Promise<QueuedResponsePolicyVersioned | undefined>;
  /** Remote-capable preflight. It is deliberately called before beginning the enqueue transaction. */
  prepareQueuedTextExecution?: (scope: Readonly<{
    ownerUserId: string; campaignId: string; requestedProviderProfileId: string | null; requestedModel: string;
    requestedTextSelection?: TextModelSelection;
    requestedTextExecutionOverrides?: TextExecutionOverrides | null;
    operationKind: OperationKind;
  }>) => Promise<PreparedQueuedTextExecution | undefined>;
  /** Transaction-local revision and authority fence for metadata already resolved by preflight. */
  verifyQueuedTextExecution?: (client: DatabaseClient, scope: Readonly<{
    ownerUserId: string; campaignId: string; providerProfileId: string; requestedModel: string;
    preparedTextExecution: PreparedQueuedTextExecution;
  }>) => Promise<boolean>;
  /** Historical Task 3 seam retained for v1 callers while v2 captures the
   * richer preflight record above. */
  prepareTextExecutionRouteBasis?: (scope: Readonly<{
    ownerUserId: string; campaignId: string; requestedProviderProfileId: string | null; requestedModel: string;
    requestedTextSelection?: TextModelSelection; operationKind: OperationKind;
  }>) => Promise<TextExecutionRouteBasis | undefined>;
  verifyTextExecutionRouteBasis?: (client: DatabaseClient, scope: Readonly<{
    ownerUserId: string; campaignId: string; providerProfileId: string; requestedModel: string;
    routeBasis: TextExecutionRouteBasis;
  }>) => Promise<boolean>;
  readTurnReportedCosts: (
    ownerUserId: string,
    campaignId: string,
    turnIds: readonly string[],
  ) => Promise<ReadonlyMap<string, GenerationResult["reportedCost"]>>;
}>;

/** Private, queue-time remote evidence. It never projects to clients and is
 * stored only through the selected preset basis. */
export type PreparedQueuedTextExecution = Readonly<{
  providerProfileId: string;
  selection: TextModelSelection;
  executionRevision: string;
  authorityRevision: string;
  endpointIdentity: string;
  advertisement: ModelParameterAdvertisement | null;
  routeBasis?: TextExecutionRouteBasis;
}>;

function json(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function assertQueuedResponsePolicyIdentity(
  value: QueuedResponsePolicyVersioned | undefined,
  providerProfileId: string,
  requestedModel: string
): QueuedResponsePolicyVersioned | undefined {
  if (!value) return undefined;
  const modelMismatch = value.version === 1
    ? requestedModel.length > 0 && value.model !== requestedModel
    : value.authority.kind === "model_verified" && requestedModel.length > 0 && value.authority.model !== requestedModel;
  if (value.providerProfileId !== providerProfileId || modelMismatch) {
    throw new GenerationApplicationError("invalid_state");
  }
  return value;
}

function readTextExecutionRouteBasis(value: unknown): TextExecutionRouteBasis | undefined {
  const parsed = textExecutionRouteBasisSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const { routeBasisHash, ...unhashed } = parsed.data;
  return sha256(stableStringify(unhashed)) === routeBasisHash ? parsed.data : undefined;
}

async function earlyReplay(
  pool: DatabasePool, scope: Readonly<{ ownerUserId: string; campaignId: string }>, request: GenerationRequest | GenerationRetryLatestRequest,
  operationKind: OperationKind
): Promise<ReturnType<typeof enqueueResult> | undefined> {
  const requestFingerprint = sha256(stableStringify(request));
  const result = await pool.query<EnqueueRow & { recoveryMetadata: Record<string, unknown> }>(
    `SELECT id, status, result_turn_id AS "resultTurnId", action, operation_kind AS "operationKind",
            replacement_turn_id AS "replacementTurnId", expected_turn_number AS "expectedTurnNumber",
            recovery_metadata AS "recoveryMetadata", created_at AS "createdAt"
       FROM generation_jobs WHERE campaign_id=$1 AND idempotency_key=$2 AND owner_user_id=$3`,
    [scope.campaignId, request.idempotencyKey, scope.ownerUserId]
  );
  const existing = result.rows[0];
  if (!existing) return undefined;
  const replacementMatches = operationKind !== "replace_latest" || existing.expectedTurnNumber === (request as GenerationRetryLatestRequest).expectedCurrentTurnNumber;
  if (existing.action !== request.action || existing.operationKind !== operationKind || !replacementMatches
      || (existing.recoveryMetadata.requestFingerprint && existing.recoveryMetadata.requestFingerprint !== requestFingerprint)) {
    throw new GenerationApplicationError("conflict", { reason: "idempotency_mismatch" });
  }
  return enqueueResult(existing, true);
}

function executionProtocolIdentity(
  promptProtocol: string,
  generationPolicy: GenerationPolicySnapshot,
  storyMemoryPolicy: StoryMemoryPolicySnapshot | null,
  storyPromptContractProtocol?: string
): string {
  const legacyIdentity = generationExecutionProtocolIdentity(promptProtocol, generationPolicy);
  if (storyMemoryPolicy) return `story-memory-v1|${legacyIdentity}`;
  return storyPromptContractProtocol ? `story-prompt-v1|${storyPromptContractProtocol}|${legacyIdentity}` : legacyIdentity;
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

function reviewDecisionResult(
  receipt: GenerationMutationResult,
  newlyQueued: boolean
): GenerationReviewDecisionResult {
  return Object.defineProperty(receipt, "newlyQueued", {
    value: newlyQueued,
    enumerable: false
  }) as GenerationReviewDecisionResult;
}

function checkpointCanKeep(checkpoint: ReturnType<typeof generationReviewCheckpointSchema.parse>): boolean {
  return checkpoint.gateCandidate.story !== null && canKeepGenerationCandidate({
    ...checkpoint.eligibility,
    stage: checkpoint.stage,
    candidateScope: checkpoint.candidateScope,
    reasons: checkpoint.reasons
  });
}

function jobResult(row: JobRow): GenerationJob {
  const review = projectBoundedGenerationReviewSummary(row.reviewSummary, row.status);
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
    failureDiagnostic: projectGenerationFailureDiagnostic(row.failureDiagnostic),
    responseFormat: projectGenerationResponseFormat({ ...(typeof row.responseFormat === "object" && row.responseFormat !== null ? row.responseFormat as Record<string, unknown> : {}), errorCode: row.errorCode }),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    completedAt: row.completedAt,
    partialOutput: row.partialOutput,
    partialNarration: row.partialOutput ? extractPartialNarration(row.partialOutput) : null
    , generationPolicy: row.generationPolicy,
    ...(review ? { review } : {})
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
  if (request.requestedInputMode === "auto" || request.inputModeSource === "auto" || request.inputModeSource === "fallback" || request.classificationId) {
    throw new GenerationApplicationError("invalid_state", { reason: "turn_input_classification_removed" });
  }
  if (turnControlStyle === "action_only" && request.resolvedInputMode !== "action") {
    throw new GenerationApplicationError("invalid_state", { reason: "action_only_mode" });
  }
  if (request.requestedInputMode !== request.resolvedInputMode) {
    throw new GenerationApplicationError("invalid_state", { reason: "explicit_input_mode_mismatch" });
  }
  return null;
}

function generationPolicyForStyle(turnControlStyle: string): GenerationPolicySnapshot {
  const parsedStyle = campaignTurnControlStyleSchema.safeParse(turnControlStyle);
  if (!parsedStyle.success) {
    throw new GenerationApplicationError("invalid_state", { reason: "turn_control_style_invalid" });
  }
  const style = parsedStyle.data;
  if (style === "flexible_scene") {
    return {
      version: 1,
      playMode: "story_only",
      turnControlStyle: style,
      protocolVersion: "story-only-v1",
      prompts: storyOnlyPromptSnapshot()
    };
  }
  return {
    version: 1,
    playMode: "legacy",
    turnControlStyle: style
  };
}

export async function resolveTextProviderId(
  client: DatabaseClient | DatabasePool,
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

async function activeGenerationConflict(client: DatabaseClient | DatabasePool, ownerUserId: string, campaignId: string): Promise<never> {
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
      const requestedModel = requestedModelFor(request);
      const replay = await earlyReplay(pool, scope, request, "append");
      if (replay) return replay;
      const preparedTextExecution = dependencies.prepareQueuedTextExecution
        ? await dependencies.prepareQueuedTextExecution({ ownerUserId: scope.ownerUserId, campaignId: scope.campaignId,
          requestedProviderProfileId: request.providerProfileId || null, requestedModel,
          ...(request.textSelection ? { requestedTextSelection: request.textSelection } : {}),
          ...(request.textExecutionOverrides === undefined ? {} : { requestedTextExecutionOverrides: request.textExecutionOverrides }),
          operationKind: "append" })
        : undefined;
      const legacyPreparedValue = !preparedTextExecution && dependencies.prepareTextExecutionRouteBasis
        ? await dependencies.prepareTextExecutionRouteBasis({ ownerUserId: scope.ownerUserId, campaignId: scope.campaignId,
          requestedProviderProfileId: request.providerProfileId || null, requestedModel,
          ...(request.textSelection ? { requestedTextSelection: request.textSelection } : {}), operationKind: "append" })
        : undefined;
      const legacyPreparedBasis = legacyPreparedValue === undefined
        ? undefined
        : readTextExecutionRouteBasis(legacyPreparedValue);
      if (legacyPreparedValue !== undefined && legacyPreparedBasis === undefined) {
        throw new GenerationApplicationError("invalid_state");
      }
      const preparedBasis = preparedTextExecution?.routeBasis
        ? readTextExecutionRouteBasis(preparedTextExecution.routeBasis)
        : legacyPreparedBasis;
      if (preparedTextExecution?.routeBasis && !preparedBasis) {
        throw new GenerationApplicationError("conflict", { reason: "provider_profile_changed_refresh_required" });
      }
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
          story_context_budget_tokens: number;
          turn_control_style: string;
        }>(
          `SELECT active_turn_number, text_provider_profile_id, story_length_profile, story_context_budget_tokens, turn_control_style
             FROM campaigns WHERE id = $1 AND owner_user_id = $2 FOR UPDATE`,
          [scope.campaignId, scope.ownerUserId]
        );
        const campaign = campaignResult.rows[0];
        if (!campaign) throw notFound({ campaignId: scope.campaignId });
        const classificationId = await validateTurnInputMode(client, scope.ownerUserId, scope.campaignId, request, campaign.turn_control_style);
        const generationPolicy = generationPolicyForStyle(campaign.turn_control_style);
        const providerProfileId = await resolveTextProviderId(client, scope.ownerUserId, request.providerProfileId || campaign.text_provider_profile_id);
        if (!providerProfileId) throw new GenerationApplicationError("provider_required", { reason: "no_text_provider" });
        if (preparedTextExecution && (!dependencies.verifyQueuedTextExecution || !await dependencies.verifyQueuedTextExecution(client, {
          ownerUserId: scope.ownerUserId, campaignId: scope.campaignId, providerProfileId, requestedModel, preparedTextExecution
        }))) throw new GenerationApplicationError("conflict", { reason: "provider_profile_changed_refresh_required" });
        if (legacyPreparedBasis && dependencies.verifyTextExecutionRouteBasis && !await dependencies.verifyTextExecutionRouteBasis(client, {
          ownerUserId: scope.ownerUserId, campaignId: scope.campaignId, providerProfileId, requestedModel, routeBasis: legacyPreparedBasis
        })) throw new GenerationApplicationError("conflict", { reason: "provider_profile_changed_refresh_required" });
        const storyMemoryPolicy = dependencies.resolveStoryMemoryPolicySnapshot
          ? await dependencies.resolveStoryMemoryPolicySnapshot(client, { ownerUserId: scope.ownerUserId, campaignId: scope.campaignId, providerProfileId, requestedModel, ...(request.context.modelContextWindowTokens === undefined ? {} : { modelContextWindowTokens: request.context.modelContextWindowTokens }), ...(preparedTextExecution?.routeBasis ? { textExecutionRouteBasis: preparedTextExecution.routeBasis } : {}) })
          : null;
        const queuedResponsePolicy = assertQueuedResponsePolicyIdentity(readQueuedResponsePolicyVersioned(await dependencies.resolveQueuedResponsePolicy?.(client, {
          ownerUserId: scope.ownerUserId, campaignId: scope.campaignId, providerProfileId, requestedModel,
          ...(request.context.modelContextWindowTokens === undefined ? {} : { modelContextWindowTokens: request.context.modelContextWindowTokens }),
          operationKind: "append", generationPolicy, storyMemoryPolicy,
          ...(preparedTextExecution ? { preparedTextExecution } : {})
        })), providerProfileId, requestedModel);
        const storyLengthProfile = request.storyLengthProfileOverride
          ?? storyLengthProfileFromUnknown(campaign.story_length_profile);
        const storyLength = storyLengthWordRange(storyLengthProfile);
        const authority = await resolveGenerationAuthoritySnapshot(client, {
          ownerUserId: scope.ownerUserId,
          campaignId: scope.campaignId,
          operationKind: "append",
          expectedTurnNumber: campaign.active_turn_number + 1,
          ...(storyMemoryPolicy ? {
            baseIdentityVersion: "generation-base-v3" as const,
            captureRecentWindow: storyMemoryPolicy.policy.recentTurnTarget > 1
          } : {})
        });
        const promptSnapshot = await dependencies.resolvePromptSnapshot(client, scope.ownerUserId, scope.campaignId, storyMemoryPolicy);
        const readablePromptSnapshot = storyMemoryPolicy
          ? assertContinuityReviewPromptSnapshot(assertStoryMemoryPromptCompatibility(promptSnapshot), storyMemoryPolicy.policy.continuityReview)
          : readPromptSnapshot(promptSnapshot);
        const contextSnapshot = {
          ...request.context,
          budgetTokens: campaign.story_context_budget_tokens,
          storyLengthProfile,
          narrationMinWords: storyLength.minWords,
          narrationMaxWords: storyLength.maxWords
          , ...(storyMemoryPolicy ? { storyMemoryPolicy } : {})
        };
        await client.query("SAVEPOINT enqueue_generation_insert");
        try {
          const inserted = await client.query<EnqueueRow>(
            `INSERT INTO generation_jobs (
               owner_user_id, campaign_id, provider_profile_id, idempotency_key, expected_turn_number,
               action, requested_input_mode, resolved_input_mode, input_mode_source, turn_input_classification_id,
               requested_model, context_options, prompt_protocol_version, recovery_metadata, prompt_snapshot,
               generation_base_identity, generation_policy, orchestration_private
             ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
             RETURNING id, status, action, operation_kind AS "operationKind", replacement_turn_id AS "replacementTurnId",
                       expected_turn_number AS "expectedTurnNumber", created_at AS "createdAt"`,
            [scope.ownerUserId, scope.campaignId, providerProfileId, request.idempotencyKey, campaign.active_turn_number + 1,
              request.action, generationPolicy.playMode === "story_only" ? "scene" : request.requestedInputMode,
              generationPolicy.playMode === "story_only" ? "scene" : request.resolvedInputMode,
              generationPolicy.playMode === "story_only" ? "explicit" : request.inputModeSource, classificationId,
              requestedModel, json(contextSnapshot), executionProtocolIdentity(dependencies.promptProtocolVersion(readablePromptSnapshot.templates as PromptSnapshot), generationPolicy, storyMemoryPolicy, readablePromptSnapshot.storyPromptCompatibility?.protocolIdentity),
              json({ requestFingerprint }), json(promptSnapshot), json(authority.baseIdentity), json(generationPolicy), json({
                ...(queuedResponsePolicy ? { queuedResponsePolicy } : {}),
                ...(preparedBasis ? { textExecutionRouteBasis: preparedBasis } : {})
              })]
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
      const requestedModel = requestedModelFor(request);
      const requestFingerprint = sha256(stableStringify(request));
      const early = await earlyReplay(pool, scope, request, "replace_latest");
      if (early) return early;
      const preparedTextExecution = dependencies.prepareQueuedTextExecution
        ? await dependencies.prepareQueuedTextExecution({ ownerUserId: scope.ownerUserId, campaignId: scope.campaignId,
          requestedProviderProfileId: request.providerProfileId || null, requestedModel,
          ...(request.textSelection ? { requestedTextSelection: request.textSelection } : {}),
          ...(request.textExecutionOverrides === undefined ? {} : { requestedTextExecutionOverrides: request.textExecutionOverrides }),
          operationKind: "replace_latest" })
        : undefined;
      const legacyPreparedValue = !preparedTextExecution && dependencies.prepareTextExecutionRouteBasis
        ? await dependencies.prepareTextExecutionRouteBasis({ ownerUserId: scope.ownerUserId, campaignId: scope.campaignId,
          requestedProviderProfileId: request.providerProfileId || null, requestedModel,
          ...(request.textSelection ? { requestedTextSelection: request.textSelection } : {}), operationKind: "replace_latest" })
        : undefined;
      const legacyPreparedBasis = legacyPreparedValue === undefined
        ? undefined
        : readTextExecutionRouteBasis(legacyPreparedValue);
      if (legacyPreparedValue !== undefined && legacyPreparedBasis === undefined) {
        throw new GenerationApplicationError("invalid_state");
      }
      const preparedBasis = preparedTextExecution?.routeBasis
        ? readTextExecutionRouteBasis(preparedTextExecution.routeBasis)
        : legacyPreparedBasis;
      if (preparedTextExecution?.routeBasis && !preparedBasis) {
        throw new GenerationApplicationError("conflict", { reason: "provider_profile_changed_refresh_required" });
      }
      try {
        return await withTransaction(pool, async (client) => {
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
          story_context_budget_tokens: number;
          turn_control_style: string;
        }>(
          `SELECT active_turn_number, text_provider_profile_id, story_length_profile, story_context_budget_tokens, turn_control_style
             FROM campaigns WHERE id = $1 AND owner_user_id = $2 FOR UPDATE`,
          [scope.campaignId, scope.ownerUserId]
        );
        const campaign = campaignResult.rows[0];
        if (!campaign) throw notFound({ campaignId: scope.campaignId });
        const classificationId = await validateTurnInputMode(client, scope.ownerUserId, scope.campaignId, request, campaign.turn_control_style);
        const generationPolicy = generationPolicyForStyle(campaign.turn_control_style);
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
        if (preparedTextExecution && (!dependencies.verifyQueuedTextExecution || !await dependencies.verifyQueuedTextExecution(client, {
          ownerUserId: scope.ownerUserId, campaignId: scope.campaignId, providerProfileId, requestedModel, preparedTextExecution
        }))) throw new GenerationApplicationError("conflict", { reason: "provider_profile_changed_refresh_required" });
        if (legacyPreparedBasis && dependencies.verifyTextExecutionRouteBasis && !await dependencies.verifyTextExecutionRouteBasis(client, {
          ownerUserId: scope.ownerUserId, campaignId: scope.campaignId, providerProfileId, requestedModel, routeBasis: legacyPreparedBasis
        })) throw new GenerationApplicationError("conflict", { reason: "provider_profile_changed_refresh_required" });
        const storyMemoryPolicy = dependencies.resolveStoryMemoryPolicySnapshot
          ? await dependencies.resolveStoryMemoryPolicySnapshot(client, { ownerUserId: scope.ownerUserId, campaignId: scope.campaignId, providerProfileId, requestedModel, ...(request.context.modelContextWindowTokens === undefined ? {} : { modelContextWindowTokens: request.context.modelContextWindowTokens }), ...(preparedTextExecution?.routeBasis ? { textExecutionRouteBasis: preparedTextExecution.routeBasis } : {}) })
          : null;
        const queuedResponsePolicy = assertQueuedResponsePolicyIdentity(readQueuedResponsePolicyVersioned(await dependencies.resolveQueuedResponsePolicy?.(client, {
          ownerUserId: scope.ownerUserId, campaignId: scope.campaignId, providerProfileId, requestedModel,
          ...(request.context.modelContextWindowTokens === undefined ? {} : { modelContextWindowTokens: request.context.modelContextWindowTokens }),
          operationKind: "replace_latest", generationPolicy, storyMemoryPolicy,
          ...(preparedTextExecution ? { preparedTextExecution } : {})
        })), providerProfileId, requestedModel);
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
        const storyLengthProfile = request.storyLengthProfileOverride
          ?? storyLengthProfileFromUnknown(campaign.story_length_profile);
        const storyLength = storyLengthWordRange(storyLengthProfile);
        const authority = await resolveGenerationAuthoritySnapshot(client, {
          ownerUserId: scope.ownerUserId,
          campaignId: scope.campaignId,
          operationKind: "replace_latest",
          expectedTurnNumber: campaign.active_turn_number,
          ...(storyMemoryPolicy ? {
            baseIdentityVersion: "generation-base-v3" as const,
            captureRecentWindow: storyMemoryPolicy.policy.recentTurnTarget > 1
          } : {})
        });
        const promptSnapshot = await dependencies.resolvePromptSnapshot(client, scope.ownerUserId, scope.campaignId, storyMemoryPolicy);
        const readablePromptSnapshot = storyMemoryPolicy
          ? assertContinuityReviewPromptSnapshot(assertStoryMemoryPromptCompatibility(promptSnapshot), storyMemoryPolicy.policy.continuityReview)
          : readPromptSnapshot(promptSnapshot);
        const contextSnapshot = {
          ...request.context,
          budgetTokens: campaign.story_context_budget_tokens,
          storyLengthProfile,
          narrationMinWords: storyLength.minWords,
          narrationMaxWords: storyLength.maxWords
          , ...(storyMemoryPolicy ? { storyMemoryPolicy } : {})
        };
        await client.query("SAVEPOINT enqueue_replacement_insert");
        try {
          const inserted = await client.query<EnqueueRow>(
            `INSERT INTO generation_jobs (
               owner_user_id, campaign_id, provider_profile_id, idempotency_key, expected_turn_number,
               action, requested_input_mode, resolved_input_mode, input_mode_source, turn_input_classification_id,
               requested_model, context_options, prompt_protocol_version, recovery_metadata, prompt_snapshot,
               operation_kind, replacement_turn_id, base_turn_number, base_state_private, base_scratchpad_safe_for_prompt,
               generation_base_identity, status, generation_policy, orchestration_private
             ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'replace_latest',$16,$17,$18,$19,$20,'replacement_queued',$21,$22)
            RETURNING id, status, action, expected_turn_number AS "expectedTurnNumber",
                      operation_kind AS "operationKind", replacement_turn_id AS "replacementTurnId", created_at AS "createdAt"`,
            [scope.ownerUserId, scope.campaignId, providerProfileId, request.idempotencyKey, campaign.active_turn_number,
              request.action, generationPolicy.playMode === "story_only" ? "scene" : request.requestedInputMode,
              generationPolicy.playMode === "story_only" ? "scene" : request.resolvedInputMode,
              generationPolicy.playMode === "story_only" ? "explicit" : request.inputModeSource, classificationId,
               requestedModel, json(contextSnapshot), executionProtocolIdentity(dependencies.promptProtocolVersion(readablePromptSnapshot.templates as PromptSnapshot), generationPolicy, storyMemoryPolicy, readablePromptSnapshot.storyPromptCompatibility?.protocolIdentity),
              json({ requestFingerprint }), json(promptSnapshot), replacementTurnId,
              baseTurnNumber, json(baseState), baseScratchpadSafeForPrompt, json(authority.baseIdentity), json(generationPolicy), json({
                ...(queuedResponsePolicy ? { queuedResponsePolicy } : {}),
                ...(preparedBasis ? { textExecutionRouteBasis: preparedBasis } : {})
              })]
          );
          await client.query("RELEASE SAVEPOINT enqueue_replacement_insert");
          return enqueueResult(inserted.rows[0]!, false);
          } catch (error) {
            if (sqlState(error) === "23505") {
              await client.query("ROLLBACK TO SAVEPOINT enqueue_replacement_insert");
              await client.query("RELEASE SAVEPOINT enqueue_replacement_insert");
              throw new ReplacementInsertUniqueConflict();
            }
            throw error;
          }
        });
      } catch (error) {
        if (!(error instanceof ReplacementInsertUniqueConflict)) throw error;
        const replay = await pool.query<EnqueueRow & { recoveryMetadata: Record<string, unknown> }>(
          `SELECT id, status, result_turn_id AS "resultTurnId", action, operation_kind AS "operationKind",
                  replacement_turn_id AS "replacementTurnId", expected_turn_number AS "expectedTurnNumber",
                  recovery_metadata AS "recoveryMetadata", created_at AS "createdAt"
             FROM generation_jobs
            WHERE campaign_id = $1 AND idempotency_key = $2 AND owner_user_id = $3`,
          [scope.campaignId, request.idempotencyKey, scope.ownerUserId]
        );
        const replayJob = replay.rows[0];
        if (replayJob
            && replayJob.action === request.action
            && replayJob.operationKind === "replace_latest"
            && replayJob.expectedTurnNumber === request.expectedCurrentTurnNumber
            && replayJob.recoveryMetadata.requestFingerprint === requestFingerprint) {
          return enqueueResult(replayJob, true);
        }
        return activeGenerationConflict(pool, scope.ownerUserId, scope.campaignId);
      }
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
                orchestration_private->'lastFailureDiagnostic' AS "failureDiagnostic",
                ${generationReviewSummaryProjection("orchestration_private")} AS "reviewSummary",
                ${generationResponseFormatProjection("orchestration_private")} AS "responseFormat",
                created_at AS "createdAt", updated_at AS "updatedAt", completed_at AS "completedAt",
                partial_output AS "partialOutput", generation_policy AS "generationPolicy"
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
      const costs = await dependencies.readTurnReportedCosts(scope.ownerUserId, row.campaignId, [row.resultTurnId]);
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
        chronicleRetrieval: parseStoredChronicleRetrievalAudit(row.modelMetadata?.chronicleRetrieval),
        modelMetadata: row.modelMetadata,
        mechanics: row.mechanics,
        acceptedAt: row.acceptedAt!,
        stateSnapshot: row.stateSnapshot || {},
        reportedCost: costs.get(row.resultTurnId) || null
      } as GenerationResult;
    },

    async getReview(scope): Promise<GenerationReviewDetail> {
      const result = await pool.query<{ orchestrationPrivate: Record<string, unknown>; status: JobStatus }>(
        `SELECT orchestration_private AS "orchestrationPrivate", status
           FROM generation_jobs WHERE id = $1 AND owner_user_id = $2`,
        [scope.jobId, scope.ownerUserId]
      );
      const row = result.rows[0];
      if (!row) throw notFound({ jobId: scope.jobId });
      const checkpoint = generationReviewCheckpointSchema.safeParse(row.orchestrationPrivate?.generationReview);
      if (!checkpoint.success) throw new GenerationApplicationError("invalid_state");
      const producingResponseId = checkpoint.data.gateCandidate.producingResponseId;
      const attempts = row.status !== "recoverable" || checkpoint.data.state !== "pending" || producingResponseId === null ? [] : (await pool.query<{ validationErrors: unknown }>(
        `SELECT validation_errors AS "validationErrors"
           FROM generation_attempts
          WHERE generation_job_id = $1 AND owner_user_id = $2 AND provider_response_id = $3
          LIMIT 2`,
        [scope.jobId, scope.ownerUserId, producingResponseId]
      )).rows;
      const validationErrors = attempts.length === 1 && Array.isArray(attempts[0]!.validationErrors)
        && attempts[0]!.validationErrors.every((error): error is string => typeof error === "string")
        ? attempts[0]!.validationErrors
        : [];
      const validationIssues = projectGenerationValidationIssues(validationErrors);
      return projectGenerationReviewDetail({
        review: {
          ...checkpoint.data,
          canKeep: row.status === "recoverable" && checkpoint.data.state === "pending" && checkpointCanKeep(checkpoint.data),
          canRetry: row.status === "recoverable" && checkpoint.data.state === "pending" && checkpoint.data.eligibility.retryAvailable,
          ...(checkpoint.data.version === 2 ? (() => {
            const repair = checkpoint.data.factFormatRepair!;
            const offered = row.status === "recoverable" && checkpoint.data.state === "pending" && repair.status === "offered";
            return {
              canRepairFormat: offered,
              formatRepair: offered ? {
                planHash: repair.planHash,
                changedFactCount: repair.plan.changes.length,
                description: "Repair fact formatting and keep the narration unchanged."
              } : null
            };
          })() : {})
        },
        candidate: checkpoint.data.gateCandidate.story
          ? { narration: checkpoint.data.gateCandidate.story.narration, choices: checkpoint.data.gateCandidate.story.choices }
          : null,
        continuityReview: (() => {
          const state = checkpoint.data.gateCandidate.resumeDependencies.stageState as Record<string, unknown>;
          const continuity = continuityReviewCheckpointSchema.safeParse(
            state.continuityReview ?? row.orchestrationPrivate?.continuityReview
          );
          return continuity.success ? continuity.data.result : null;
        })(),
        ...(validationIssues.length ? { validationIssues } : {})
      });
    },

    async decideReview(scope, request) {
      return withTransaction(pool, async (client) => {
        const parsedRequest = generationReviewDecisionRequestSchema.parse(request);
        const source = await client.query<MutationRow & { generationStatus: JobStatus; orchestrationPrivate: Record<string, unknown> }>(
          `SELECT id, status AS "generationStatus", campaign_id AS "campaignId", operation_kind AS "operationKind",
                  replacement_turn_id AS "replacementTurnId", orchestration_private AS "orchestrationPrivate"
             FROM generation_jobs WHERE id = $1 AND owner_user_id = $2 FOR UPDATE`,
          [scope.jobId, scope.ownerUserId]
        );
        const job = source.rows[0];
        if (!job) throw notFound({ jobId: scope.jobId });
        const parsed = generationReviewCheckpointSchema.safeParse(job.orchestrationPrivate?.generationReview);
        if (!parsed.success) throw new GenerationApplicationError("conflict");
        const checkpoint = parsed.data;
        const recorded = checkpoint.decisionJournal.find((entry) => entry.reviewId === parsedRequest.reviewId && entry.revision === parsedRequest.revision);
        if (recorded) {
          if (recorded.decision !== parsedRequest.decision
            || (parsedRequest.decision === "repair_format" && (recorded.decision !== "repair_format" || recorded.planHash !== parsedRequest.repairPlanHash))) {
            throw new GenerationApplicationError("conflict");
          }
          return recorded.actionReceipt.operationKind === "append"
            ? reviewDecisionResult({ id: recorded.actionReceipt.jobId, status: recorded.actionReceipt.status, operationKind: "append", replacementTurnId: null }, false)
            : reviewDecisionResult({ id: recorded.actionReceipt.jobId, status: recorded.actionReceipt.status, operationKind: "replace_latest", replacementTurnId: recorded.actionReceipt.replacementTurnId! }, false);
        }
        if (job.generationStatus !== "recoverable" || checkpoint.state !== "pending"
            || checkpoint.reviewId !== parsedRequest.reviewId || checkpoint.revision !== parsedRequest.revision) {
          throw new GenerationApplicationError("conflict");
        }
        if (parsedRequest.decision === "keep" && !checkpointCanKeep(checkpoint)) throw new GenerationApplicationError("conflict");
        if (parsedRequest.decision === "retry" && !checkpoint.eligibility.retryAvailable) throw new GenerationApplicationError("conflict");
        if (parsedRequest.decision === "repair_format" && (checkpoint.version !== 2 || !checkpoint.factFormatRepair
          || checkpoint.factFormatRepair.status !== "offered" || checkpoint.factFormatRepair.planHash !== parsedRequest.repairPlanHash)) {
          throw new GenerationApplicationError("conflict");
        }
        const status = job.operationKind === "replace_latest" ? "replacement_queued" as const : "queued" as const;
        const actionReceipt = {
          jobId: job.id, status, operationKind: job.operationKind,
          replacementTurnId: job.operationKind === "replace_latest" ? job.replacementTurnId! : null
        };
        const receipt = {
          reviewId: parsedRequest.reviewId, revision: parsedRequest.revision, actorUserId: scope.ownerUserId, decision: parsedRequest.decision,
          decidedAt: new Date().toISOString(), candidateScope: checkpoint.candidateScope,
          candidateHash: checkpoint.gateCandidate.storyHash,
          findingsHash: generationReviewFindingsHash(checkpoint.reasons),
          nextStage: parsedRequest.decision === "keep" ? null : checkpoint.stage,
          offeredCandidate: checkpoint.gateCandidate, offeredReasons: checkpoint.reasons, actionReceipt,
          ...(parsedRequest.decision === "repair_format" ? { planHash: parsedRequest.repairPlanHash,
            repair: checkpoint.factFormatRepair } : {})
        };
        const next = generationReviewCheckpointSchema.parse({
          ...checkpoint,
          state: "decided",
          revision: checkpoint.revision + 1,
          ...(parsedRequest.decision === "repair_format" ? { factFormatRepair: { ...checkpoint.factFormatRepair!, status: "authorized" } } : {}),
          decisionJournal: [...checkpoint.decisionJournal, receipt]
        });
        const updated = await client.query<MutationRow>(
          `UPDATE generation_jobs SET status = $3, lease_owner = NULL, lease_expires_at = NULL,
              error_code = NULL, error_message = NULL,
              orchestration_private = orchestration_private || jsonb_build_object('generationReview', $4::jsonb)
                || CASE WHEN $5::boolean AND orchestration_private ? 'queuedResponsePolicy' THEN jsonb_build_object(
                  'logicalAttempt', COALESCE(orchestration_private->'logicalAttempt',
                    '{"version":1,"semanticRepairsConsumed":0,"reviewsConsumed":0,"automaticRepairsConsumed":0,"choiceRepairsConsumed":0,"eventCoverageRepairsConsumed":0}'::jsonb)
                    || jsonb_build_object('id', gen_random_uuid()::text)
                ) ELSE '{}'::jsonb END,
              updated_at = now()
            WHERE id = $1 AND owner_user_id = $2
            RETURNING id, status, operation_kind AS "operationKind", replacement_turn_id AS "replacementTurnId"`,
          [scope.jobId, scope.ownerUserId, status, json(next), parsedRequest.decision === "retry"]
        );
        return reviewDecisionResult(mutationResult(updated.rows[0]!), true);
      });
    },

    async retry(scope) {
      return withTransaction(pool, async (client) => {
        const source = await client.query<MutationRow & {
          generationStatus: JobStatus;
          promptSnapshot: PromptSnapshot;
           promptProtocolVersion: string;
           generationPolicy: GenerationPolicySnapshot | null;
           contextOptions: Record<string, unknown>;
           errorCode: string | null; orchestrationPrivate: Record<string, unknown>;
        }>(
          `SELECT id, status AS "generationStatus", campaign_id AS "campaignId", provider_profile_id AS "providerProfileId",
                  expected_turn_number AS "expectedTurnNumber", attempts, operation_kind AS "operationKind",
                  replacement_turn_id AS "replacementTurnId", prompt_snapshot AS "promptSnapshot",
                   prompt_protocol_version AS "promptProtocolVersion", generation_policy AS "generationPolicy",
                   context_options AS "contextOptions", error_code AS "errorCode", orchestration_private AS "orchestrationPrivate"
             FROM generation_jobs WHERE id = $1 AND owner_user_id = $2 FOR UPDATE`,
          [scope.jobId, scope.ownerUserId]
        );
        const job = source.rows[0];
        if (!job) throw notFound({ jobId: scope.jobId });
        const review = generationReviewCheckpointSchema.safeParse(job.orchestrationPrivate?.generationReview);
        if (job.generationStatus === "recoverable" && review.success && review.data.state === "pending") {
          throw new GenerationApplicationError("conflict", { reason: "review_decision_required" });
        }
        if (job.generationStatus !== "recoverable" && job.generationStatus !== "failed") {
          throw new GenerationApplicationError("invalid_state", { reason: "retry_source_state", generationStatus: job.generationStatus });
        }
        const storedPolicy = job.contextOptions && Object.hasOwn(job.contextOptions, "storyMemoryPolicy")
          ? storyMemoryPolicySnapshotSchema.safeParse(job.contextOptions.storyMemoryPolicy) : null;
        if (storedPolicy && (!storedPolicy.success
          || ["generation_checkpoint_incompatible", "story_memory_policy_worker_incompatible", "story_memory_policy_invalid", "generation_authority_stale", "generation_prompt_snapshot_invalid"].includes(job.errorCode ?? ""))) {
          throw new GenerationApplicationError("conflict", { reason: "retry_protocol_incompatible" });
        }
        let promptSnapshot: ReturnType<typeof readPromptSnapshot> | null = null;
        try {
          promptSnapshot = storedPolicy
            ? assertContinuityReviewPromptSnapshot(assertStoryMemoryPromptCompatibility(job.promptSnapshot), storedPolicy.data.policy.continuityReview)
            : assertStoryPromptCompatibility(job.promptSnapshot);
        } catch { promptSnapshot = null; }
        const generationPolicy = job.generationPolicy === null
          ? null
          : generationPolicySnapshotSchema.safeParse(job.generationPolicy);
        let protocolCompatible = false;
        try {
          protocolCompatible = promptSnapshot !== null
            && (generationPolicy === null || generationPolicy.success)
            && executionProtocolIdentity(
              dependencies.promptProtocolVersion(promptSnapshot.templates as PromptSnapshot),
              generationPolicy === null ? { version: 1, playMode: "legacy", turnControlStyle: "flexible_action" } : generationPolicy.data,
              storedPolicy?.success ? storedPolicy.data : null,
              promptSnapshot.storyPromptCompatibility?.protocolIdentity
            ) === job.promptProtocolVersion;
        } catch {
          protocolCompatible = false;
        }
        if (!protocolCompatible) {
          throw new GenerationApplicationError("conflict", { reason: "retry_protocol_incompatible" });
        }
        const updated = await client.query<MutationRow>(
          `UPDATE generation_jobs
              SET status = CASE WHEN operation_kind = 'replace_latest' THEN 'replacement_queued' ELSE 'queued' END,
                  lease_owner = NULL, lease_expires_at = NULL, error_code = NULL, error_message = NULL, updated_at = now()
                  , orchestration_private = (orchestration_private - 'automaticRepair' - 'continuityReview' - 'semanticRepair' - 'eventCoverageRepair') || jsonb_build_object(
                    'logicalAttempt', jsonb_build_object('version', 1, 'id', gen_random_uuid()::text,
                      'semanticRepairsConsumed', 0, 'reviewsConsumed', 0, 'automaticRepairsConsumed', 0,
                      'choiceRepairsConsumed', 0, 'eventCoverageRepairsConsumed', 0))
            WHERE id = $1 AND owner_user_id = $2
            RETURNING id, status, operation_kind AS "operationKind", replacement_turn_id AS "replacementTurnId"`,
          [scope.jobId, scope.ownerUserId]
        );
        const row = updated.rows[0]!;
        return {
          ...mutationResult(row),
          campaignId: job.campaignId!,
          providerProfileId: job.providerProfileId!,
          expectedTurnNumber: job.expectedTurnNumber!,
          attempts: job.attempts!
        };
      });
    },

    async cancel(scope) {
      return withTransaction(pool, async (client) => {
        const result = await client.query<MutationRow>(
          `UPDATE generation_jobs
              SET status = 'cancelled', lease_owner = NULL, lease_expires_at = NULL, partial_output = NULL,
                  error_code = 'cancelled_by_player', error_message = 'Cancelled by player.', updated_at = now()
            WHERE id = $1 AND owner_user_id = $2
              AND status IN ('queued', 'replacement_queued', 'assessing', 'generating', 'validating', 'committing', 'recoverable')
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
