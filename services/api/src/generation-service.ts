import type { DatabaseClient, DatabasePool } from "../../../packages/database/src/pool.js";
import { initialOwnerId, withTransaction } from "../../../packages/database/src/pool.js";
import {
  pendingEventTriggerSchema,
  playerEventTriggerSchema,
  playerRpgStatSchema,
  type CampaignBranchRequest,
  type CampaignRewindRequest,
  type GenerationRequest,
  type GenerationRetryLatestRequest,
  type PlayerCampaignConfig,
  type PlayerEventTrigger,
  type PlayerRpgStat,
  type StoryTurnOutput
} from "../../../packages/contracts/src/generation.js";
import type { MemoryContextQuery } from "../../../packages/contracts/src/memory.js";
import {
  storyLengthProfileFromUnknown,
  storyLengthWordRange,
  type StoryLengthProfile,
  type StoryLengthWordRange
} from "../../../packages/contracts/src/story-settings.js";
import { buildTurnFictionMemory } from "../../../packages/story-engine/src/chronicle.js";
import {
  activatedEventsFromResponse,
  applyTriggerHits,
  buildEventExtensionPrompt,
  buildEventTriggerPrompt,
  buildRpgAssessmentPrompt,
  buildStoryUserPrompt,
  buildSceneCoveragePrompt,
  callTextProvider,
  containsMechanicsLanguage,
  EVENT_EXTENSION_SYSTEM_PROMPT,
  EVENT_TRIGGER_SYSTEM_PROMPT,
  fictionGuidanceForEvents,
  fictionGuidanceForRoll,
  formatNarrationParagraphs,
  localRpgAssessment,
  logProviderTransportError,
  mechanicsLanguageMatches,
  mechanicsLeakFields,
  parseEventExtension,
  parseRpgAssessment,
  parseStoryOutput,
  parseSceneCoverageOutput,
  extractPartialNarration,
  performPrivateRoll,
  recoveryInstruction,
  RPG_ASSESSMENT_SYSTEM_PROMPT,
  STORY_PROMPT_PROTOCOL_VERSION,
  STORY_SYSTEM_PROMPT,
  SCENE_COVERAGE_SYSTEM_PROMPT,
  sceneCoverageRewriteInstruction,
  providerTransportErrorDetails,
  type ActivatedEvent,
  type PrivateRollResolution
} from "../../../packages/story-engine/src/index.js";
import { estimateTokens, sha256, stableStringify } from "../../../packages/domain/src/text.js";
import { autoEnableCampaignEmbeddingIfAvailable, buildContextPreview, enqueueEmbeddingReindex, rebuildCampaignMemories, storeDerivedTurnMemories } from "./memory-service.js";
import { loadTextProvider, resolveEffectiveProviderId } from "./provider-service.js";
import { enqueueAcceptedTurnIllustration } from "./image-service.js";
import { attributeGenerationCostsToTurn, recordProfileCost, turnReportedCosts } from "./cost-service.js";

function json(value: unknown): string { return JSON.stringify(value ?? null); }

function budgetTokenEstimate(text: string): number {
  return Math.max(estimateTokens(text), Math.ceil(text.length / 3));
}

function storyMemoryDefaultsFromContext(context: unknown) {
  if (!context || typeof context !== "object") return {};
  const chronicle = Array.isArray((context as { chronicle?: unknown }).chronicle)
    ? (context as { chronicle: unknown[] }).chronicle
    : [];
  const entries = chronicle.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const memory = entry as { kind?: unknown; ordinal?: unknown; content?: unknown };
    return typeof memory.content === "string"
      ? [{ kind: String(memory.kind || ""), ordinal: Number(memory.ordinal || 0), content: memory.content }]
      : [];
  });
  const latest = (kind: string) => entries
    .filter((entry) => entry.kind === kind)
    .sort((left, right) => right.ordinal - left.ordinal)[0];
  const summary = latest("campaign_summary")?.content.trim();
  const openThreads = latest("open_thread")?.content.split("\n").slice(1)
    .map((line) => line.replace(/^[-•]\s*/, "").trim())
    .filter(Boolean);
  return {
    ...(summary ? { continuitySummary: summary } : {}),
    canonicalFacts: [],
    supersededFacts: [],
    ...(openThreads ? { openThreads } : {})
  };
}

type ClaimedJob = {
  id: string;
  owner_user_id: string;
  campaign_id: string;
  provider_profile_id: string;
  expected_turn_number: number;
  operation_kind: "append" | "replace_latest";
  replacement_turn_id: string | null;
  base_turn_number: number | null;
  base_state_private: Record<string, unknown>;
  base_scratchpad_safe_for_prompt: boolean;
  action: string;
  requested_input_mode: "auto" | "action" | "scene";
  resolved_input_mode: "action" | "scene";
  input_mode_source: "explicit" | "auto" | "generated_choice" | "opening_action" | "fallback";
  requested_model: string;
  context_options: MemoryContextQuery & {
    modelContextWindowTokens?: number;
    storyLengthProfile?: StoryLengthProfile;
    narrationMinWords?: number;
    narrationMaxWords?: number;
  };
  prompt_protocol_version: string;
  attempts: number;
  orchestration_private: OrchestrationPrivate;
};

export function safeTurnInput(value: string): string {
  const trimmed = value.trim();
  const matches = mechanicsLanguageMatches(trimmed);
  if (!trimmed || matches.length) {
    const findings = matches.map((match) => ({
      category: match.category,
      text: match.text,
      index: match.index
    }));
    const findingSummary = findings.length
      ? ` Blocked ${findings.length === 1 ? "fragment" : "fragments"}: ${findings.map((finding) => `"${finding.text}" (${finding.category.replaceAll("_", " ")})`).join(", ")}.`
      : " The input was empty after trimming whitespace.";
    throw Object.assign(new Error(`The turn input contains game-mechanics or engine language that cannot be sent to story generation.${findingSummary} Edit the input and retry; no part of it was silently removed.`), {
      statusCode: 400,
      code: "unsafe_turn_input",
      details: { code: "unsafe_turn_input", findings }
    });
  }
  return trimmed;
}

async function validateTurnInputMode(
  client: DatabaseClient,
  ownerUserId: string,
  campaignId: string,
  request: GenerationRequest,
  turnControlStyle: string
) {
  if (turnControlStyle === "action_only" && request.resolvedInputMode !== "action") {
    throw Object.assign(new Error("This campaign accepts player actions only."), { statusCode: 400 });
  }
  if (request.requestedInputMode !== "auto") {
    if (request.classificationId) throw Object.assign(new Error("Classification IDs are valid only for Auto input."), { statusCode: 400 });
    if (request.requestedInputMode !== request.resolvedInputMode) {
      throw Object.assign(new Error("Explicit turn input mode does not match the resolved mode."), { statusCode: 400 });
    }
    return null;
  }
  if (!request.classificationId) throw Object.assign(new Error("Auto input requires a current classification."), { statusCode: 400 });
  const result = await client.query<{ id: string; resolved_mode: "action" | "scene" }>(
    `SELECT id, resolved_mode FROM turn_input_classifications
      WHERE id = $1 AND owner_user_id = $2 AND campaign_id = $3 AND input_hash = $4
        AND consumed_at IS NULL AND expires_at > now() FOR UPDATE`,
    [request.classificationId, ownerUserId, campaignId, sha256(request.action)]
  );
  const classification = result.rows[0];
  if (!classification) throw Object.assign(new Error("The Auto classification is missing, expired, consumed, or does not match this input."), { statusCode: 409 });
  if (classification.resolved_mode !== request.resolvedInputMode) {
    throw Object.assign(new Error("The submitted turn mode does not match the Auto classification."), { statusCode: 409 });
  }
  await client.query("UPDATE turn_input_classifications SET consumed_at = now() WHERE id = $1", [classification.id]);
  return classification.id;
}

type StoryCostOperation = "rpg_assessment" | "event_trigger_before" | "story_generation"
  | "story_recovery" | "event_trigger_after" | "event_extension" | "scene_coverage_validation" | "scene_coverage_rewrite";

async function callCampaignTextProvider(
  pool: DatabasePool,
  provider: Awaited<ReturnType<typeof loadTextProvider>>,
  job: ClaimedJob,
  operation: StoryCostOperation,
  request: Parameters<typeof callTextProvider>[1]
) {
  try {
    const result = await callTextProvider(provider, request);
    await recordProfileCost(pool, provider, {
      ownerUserId: job.owner_user_id,
      campaignId: job.campaign_id,
      generationJobId: job.id,
      category: "story",
      operation
    }, result);
    return result;
  } catch (error) {
    logProviderTransportError(error, {
      generationJobId: job.id,
      campaignId: job.campaign_id,
      providerProfileId: job.provider_profile_id,
      storyOperation: operation
    });
    throw error;
  }
}

function snapshottedStoryLength(context: ClaimedJob["context_options"]): StoryLengthWordRange {
  const profile = storyLengthProfileFromUnknown(context.storyLengthProfile);
  const fallback = storyLengthWordRange(profile);
  const minWords = Number(context.narrationMinWords);
  const maxWords = Number(context.narrationMaxWords);
  if (!Number.isInteger(minWords) || !Number.isInteger(maxWords) || minWords < 100 || maxWords > 10_000 || minWords > maxWords) return fallback;
  return { profile, minWords, maxWords };
}

type OrchestrationPrivate = {
  roll?: PrivateRollResolution | null;
  rpgAssessmentError?: string;
  beforeEvents?: ActivatedEvent[];
  beforeTriggerError?: string;
  afterEvents?: ActivatedEvent[];
  afterTriggerError?: string;
  extension?: { additionalText: string; scratchpad?: string; trackerUpdates: Array<Record<string, unknown>> };
  extensionError?: string;
};

type OrchestrationInputs = {
  useRpgStats: boolean;
  suppressEventTriggers: boolean;
  rpgStats: PlayerRpgStat[];
  eventTriggers: PlayerEventTrigger[];
  pendingEventTriggers: ActivatedEvent[];
  storyMemoryDefaults: {
    continuitySummary?: string;
    canonicalFacts: string[];
    supersededFacts: string[];
    openThreads?: string[];
  };
};

export async function enqueueGeneration(pool: DatabasePool, campaignId: string, request: GenerationRequest) {
  safeTurnInput(request.action);
  const ownerUserId = await initialOwnerId(pool);
  return withTransaction(pool, async (client) => {
    const requestFingerprint = sha256(stableStringify(request));
    const existing = await client.query(`SELECT id, status, result_turn_id AS "resultTurnId", action, operation_kind AS "operationKind", recovery_metadata AS "recoveryMetadata" FROM generation_jobs WHERE campaign_id = $1 AND idempotency_key = $2 AND owner_user_id = $3`, [campaignId, request.idempotencyKey, ownerUserId]);
    if (existing.rows[0]) {
      const savedFingerprint = existing.rows[0].recoveryMetadata?.requestFingerprint;
      if (existing.rows[0].action !== request.action || existing.rows[0].operationKind !== "append"
          || (savedFingerprint && savedFingerprint !== requestFingerprint)) {
        throw Object.assign(new Error("The idempotency key was already used for a different generation request."), { statusCode: 409 });
      }
      return { ...existing.rows[0], duplicate: true };
    }
    const campaign = await client.query<{ active_turn_number: number; text_provider_profile_id: string | null; story_length_profile: string; turn_control_style: string }>(`SELECT active_turn_number, text_provider_profile_id, story_length_profile, turn_control_style FROM campaigns WHERE id = $1 AND owner_user_id = $2 FOR UPDATE`, [campaignId, ownerUserId]);
    const row = campaign.rows[0];
    if (!row) throw Object.assign(new Error("Campaign not found."), { statusCode: 404 });
    const classificationId = await validateTurnInputMode(client, ownerUserId, campaignId, request, row.turn_control_style);
    const providerProfileId = await resolveEffectiveProviderId(client, ownerUserId, "text", request.providerProfileId || row.text_provider_profile_id);
    if (!providerProfileId) throw Object.assign(new Error("Select a text provider for this campaign or mark a default text provider."), { statusCode: 409 });
    const storyLengthProfile = storyLengthProfileFromUnknown(row.story_length_profile);
    const storyLength = storyLengthWordRange(storyLengthProfile);
    const contextSnapshot = {
      ...request.context,
      storyLengthProfile,
      narrationMinWords: storyLength.minWords,
      narrationMaxWords: storyLength.maxWords
    };
    try {
      const result = await client.query(
        `INSERT INTO generation_jobs (
           owner_user_id, campaign_id, provider_profile_id, idempotency_key, expected_turn_number,
           action, requested_input_mode, resolved_input_mode, input_mode_source, turn_input_classification_id,
           requested_model, context_options, prompt_protocol_version, recovery_metadata
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         RETURNING id, status, expected_turn_number AS "expectedTurnNumber", created_at AS "createdAt"`,
        [ownerUserId, campaignId, providerProfileId, request.idempotencyKey, row.active_turn_number + 1,
          request.action, request.requestedInputMode, request.resolvedInputMode, request.inputModeSource, classificationId,
          request.model || "", json(contextSnapshot), STORY_PROMPT_PROTOCOL_VERSION, json({ requestFingerprint })]
      );
      return { ...result.rows[0], duplicate: false };
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && (error as { code: string }).code === "23505") {
        const active = await client.query(
          `SELECT id, status, action, operation_kind AS "operationKind", expected_turn_number AS "expectedTurnNumber"
             FROM generation_jobs WHERE campaign_id = $1 AND owner_user_id = $2
              AND status IN ('queued','replacement_queued','assessing','generating','validating','committing','recoverable') LIMIT 1`,
          [campaignId, ownerUserId]
        );
        throw Object.assign(new Error("This campaign already has an active story generation."), {
          statusCode: 409,
          details: { code: "active_generation_exists", pendingGeneration: active.rows[0] || null }
        });
      }
      throw error;
    }
  });
}

export async function enqueueLatestReplacement(pool: DatabasePool, campaignId: string, request: GenerationRetryLatestRequest) {
  safeTurnInput(request.action);
  const ownerUserId = await initialOwnerId(pool);
  return withTransaction(pool, async (client) => {
    const existing = await client.query<{
      id: string;
      status: string;
      resultTurnId: string | null;
      action: string;
      operationKind: string;
      expectedTurnNumber: number;
      recoveryMetadata: Record<string, unknown>;
    }>(
      `SELECT id, status, result_turn_id AS "resultTurnId", action,
              operation_kind AS "operationKind", expected_turn_number AS "expectedTurnNumber",
              recovery_metadata AS "recoveryMetadata"
         FROM generation_jobs
        WHERE campaign_id = $1 AND idempotency_key = $2 AND owner_user_id = $3`,
      [campaignId, request.idempotencyKey, ownerUserId]
    );
    if (existing.rows[0]) {
      const job = existing.rows[0];
      const requestFingerprint = sha256(stableStringify(request));
      if (job.action !== request.action || job.operationKind !== "replace_latest"
          || job.expectedTurnNumber !== request.expectedCurrentTurnNumber
          || (job.recoveryMetadata?.requestFingerprint && job.recoveryMetadata.requestFingerprint !== requestFingerprint)) {
        throw Object.assign(new Error("The idempotency key was already used for a different generation request."), { statusCode: 409 });
      }
      return { ...job, duplicate: true };
    }

    const campaignResult = await client.query<{
      active_turn_number: number;
      text_provider_profile_id: string | null;
      story_length_profile: string;
      turn_control_style: string;
    }>(
      `SELECT active_turn_number, text_provider_profile_id, story_length_profile, turn_control_style
         FROM campaigns WHERE id = $1 AND owner_user_id = $2 FOR UPDATE`,
      [campaignId, ownerUserId]
    );
    const campaign = campaignResult.rows[0];
    if (!campaign) throw Object.assign(new Error("Campaign not found."), { statusCode: 404 });
    const classificationId = await validateTurnInputMode(client, ownerUserId, campaignId, request, campaign.turn_control_style);
    if (campaign.active_turn_number !== request.expectedCurrentTurnNumber) {
      throw Object.assign(
        new Error(`Campaign is at turn ${campaign.active_turn_number}, not ${request.expectedCurrentTurnNumber}.`),
        { statusCode: 409 }
      );
    }

    const replacement = await client.query<{ id: string }>(
      `SELECT id FROM turns
        WHERE campaign_id = $1 AND owner_user_id = $2 AND turn_number = $3 FOR UPDATE`,
      [campaignId, ownerUserId, campaign.active_turn_number]
    );
    const replacementTurnId = replacement.rows[0]?.id;
    if (!replacementTurnId) throw Object.assign(new Error("The latest accepted turn was not found."), { statusCode: 404 });

    const activeImage = await client.query(
      `SELECT id FROM image_jobs
        WHERE campaign_id = $1 AND owner_user_id = $2 AND turn_id = $3
          AND status = 'generating' LIMIT 1`,
      [campaignId, ownerUserId, replacementTurnId]
    );
    if (activeImage.rows[0]) {
      throw Object.assign(new Error("Wait for the latest turn illustration to finish before retrying the turn."), { statusCode: 409 });
    }
    await client.query(
      `DELETE FROM image_jobs
        WHERE campaign_id = $1 AND owner_user_id = $2 AND turn_id = $3 AND status = 'queued'`,
      [campaignId, ownerUserId, replacementTurnId]
    );

    const providerProfileId = await resolveEffectiveProviderId(
      client,
      ownerUserId,
      "text",
      request.providerProfileId || campaign.text_provider_profile_id
    );
    if (!providerProfileId) {
      throw Object.assign(new Error("Select a text provider for this campaign or mark a default text provider."), { statusCode: 409 });
    }

    const baseTurnNumber = campaign.active_turn_number - 1;
    let baseState: Record<string, unknown> = {};
    let baseScratchpadSafeForPrompt = false;
    if (baseTurnNumber === 0) {
      const initial = await client.query<{ initial_state_snapshot: Record<string, unknown> }>(
        `SELECT initial_state_snapshot FROM campaign_state
          WHERE campaign_id = $1 AND owner_user_id = $2`,
        [campaignId, ownerUserId]
      );
      baseState = initial.rows[0]?.initial_state_snapshot || {};
    } else {
      const baseTurn = await client.query<{ state_snapshot_private: Record<string, unknown>; model_metadata: Record<string, unknown> }>(
        `SELECT state_snapshot_private, model_metadata FROM turns
          WHERE campaign_id = $1 AND owner_user_id = $2 AND turn_number = $3`,
        [campaignId, ownerUserId, baseTurnNumber]
      );
      if (!baseTurn.rows[0]) throw new Error("The replacement base turn was not found.");
      baseState = baseTurn.rows[0].state_snapshot_private || {};
      baseScratchpadSafeForPrompt = typeof baseTurn.rows[0].model_metadata?.promptProtocolVersion === "string";
    }
    const baseEdit = await client.query<{ state_snapshot_private: Record<string, unknown> }>(
      `SELECT state_snapshot_private FROM campaign_state_edits
        WHERE campaign_id = $1 AND owner_user_id = $2 AND effective_turn_number = $3
        ORDER BY revision DESC LIMIT 1`,
      [campaignId, ownerUserId, baseTurnNumber]
    );
    if (baseEdit.rows[0]) {
      baseState = baseEdit.rows[0].state_snapshot_private || baseState;
      baseScratchpadSafeForPrompt = true;
    }

    const storyLength = storyLengthWordRange(storyLengthProfileFromUnknown(campaign.story_length_profile));
    const contextSnapshot = {
      ...request.context,
      storyLengthProfile: storyLength.profile,
      narrationMinWords: storyLength.minWords,
      narrationMaxWords: storyLength.maxWords
    };
    try {
      const inserted = await client.query(
        `INSERT INTO generation_jobs (
           owner_user_id, campaign_id, provider_profile_id, idempotency_key, expected_turn_number,
           action, requested_input_mode, resolved_input_mode, input_mode_source, turn_input_classification_id,
           requested_model, context_options, prompt_protocol_version, recovery_metadata,
           operation_kind, replacement_turn_id, base_turn_number, base_state_private, base_scratchpad_safe_for_prompt, status
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'replace_latest',$15,$16,$17,$18,'replacement_queued')
         RETURNING id, status, expected_turn_number AS "expectedTurnNumber",
                   operation_kind AS "operationKind", replacement_turn_id AS "replacementTurnId", created_at AS "createdAt"`,
        [ownerUserId, campaignId, providerProfileId, request.idempotencyKey, campaign.active_turn_number,
          request.action, request.requestedInputMode, request.resolvedInputMode, request.inputModeSource, classificationId,
          request.model || "", json(contextSnapshot), STORY_PROMPT_PROTOCOL_VERSION,
          json({ requestFingerprint: sha256(stableStringify(request)) }), replacementTurnId, baseTurnNumber, json(baseState), baseScratchpadSafeForPrompt]
      );
      return { ...inserted.rows[0], duplicate: false };
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && (error as { code: string }).code === "23505") {
        const active = await client.query(
          `SELECT id, status, action, operation_kind AS "operationKind", expected_turn_number AS "expectedTurnNumber"
             FROM generation_jobs WHERE campaign_id = $1 AND owner_user_id = $2
              AND status IN ('queued','replacement_queued','assessing','generating','validating','committing','recoverable') LIMIT 1`,
          [campaignId, ownerUserId]
        );
        throw Object.assign(new Error("This campaign already has an active story generation."), {
          statusCode: 409,
          details: { code: "active_generation_exists", pendingGeneration: active.rows[0] || null }
        });
      }
      throw error;
    }
  });
}

export async function getGenerationJob(pool: DatabasePool, jobId: string) {
  const ownerUserId = await initialOwnerId(pool);
  const result = await pool.query(
    `SELECT id, campaign_id AS "campaignId", provider_profile_id AS "providerProfileId",
            expected_turn_number AS "expectedTurnNumber", action, status, attempts,
            requested_input_mode AS "requestedInputMode", resolved_input_mode AS "resolvedInputMode",
            input_mode_source AS "inputModeSource",
            operation_kind AS "operationKind", replacement_turn_id AS "replacementTurnId",
            base_turn_number AS "baseTurnNumber",
            requested_model AS "requestedModel", provider_response_id AS "providerResponseId",
            provider_finish_reason AS "providerFinishReason", result_turn_id AS "resultTurnId",
            error_code AS "errorCode", error_message AS "errorMessage", recovery_metadata AS "recoveryMetadata",
            created_at AS "createdAt", updated_at AS "updatedAt", completed_at AS "completedAt",
            partial_output AS "partialOutput"
       FROM generation_jobs WHERE id = $1 AND owner_user_id = $2`, [jobId, ownerUserId]
  );
  const row = result.rows[0];
  if (!row) throw Object.assign(new Error("Generation job not found."), { statusCode: 404 });
  row.partialNarration = row.partialOutput ? extractPartialNarration(row.partialOutput) : null;
  return row;
}

export async function getGenerationResult(pool: DatabasePool, jobId: string) {
  const ownerUserId = await initialOwnerId(pool);
  const result = await pool.query(
    `SELECT j.id, j.status, j.campaign_id AS "campaignId", j.expected_turn_number AS "expectedTurnNumber",
            j.result_turn_id AS "resultTurnId", j.error_code AS "errorCode", j.error_message AS "errorMessage",
            t.turn_number AS "turnNumber", t.action, COALESCE(t.input_mode, 'action') AS "inputMode",
            COALESCE(t.input_mode_source, 'explicit') AS "inputModeSource", t.narration, t.choices,
            t.custom_action_suggestion AS "customActionSuggestion", t.image_prompt AS "imagePrompt",
            t.model_metadata AS "modelMetadata", t.mechanics_private AS mechanics,
            t.accepted_at AS "acceptedAt",
            jsonb_build_object(
              'scratchpad', cs.scratchpad_private,
              'trackers', cs.trackers,
              'eventTriggers', cs.event_triggers,
              'pendingEventTriggers', cs.pending_event_triggers,
              'rpgStats', cs.rpg_stats
            ) AS "stateSnapshot"
       FROM generation_jobs j
       LEFT JOIN turns t ON t.id = j.result_turn_id AND t.owner_user_id = j.owner_user_id
       LEFT JOIN campaign_state cs ON cs.campaign_id = j.campaign_id AND cs.owner_user_id = j.owner_user_id
      WHERE j.id = $1 AND j.owner_user_id = $2`,
    [jobId, ownerUserId]
  );
  const row = result.rows[0];
  if (!row) throw Object.assign(new Error("Generation job not found."), { statusCode: 404 });
  if (row.status !== "completed" || !row.resultTurnId) {
    throw Object.assign(new Error(row.errorMessage || `Generation is ${row.status}.`), { statusCode: 409 });
  }
  const costs = await turnReportedCosts(pool, ownerUserId, [row.resultTurnId]);
  return {
    ...row,
    narration: formatNarrationParagraphs(String(row.narration || "")),
    reportedCost: costs.get(row.resultTurnId) || null
  };
}

export async function retryGeneration(pool: DatabasePool, jobId: string) {
  const ownerUserId = await initialOwnerId(pool);
  const result = await pool.query(
    `UPDATE generation_jobs SET status = CASE WHEN operation_kind = 'replace_latest' THEN 'replacement_queued' ELSE 'queued' END,
            lease_owner = NULL, lease_expires_at = NULL,
            error_code = NULL, error_message = NULL, prompt_protocol_version = $3, updated_at = now()
      WHERE id = $1 AND owner_user_id = $2 AND status IN ('recoverable', 'failed')
      RETURNING id, status`, [jobId, ownerUserId, STORY_PROMPT_PROTOCOL_VERSION]
  );
  if (!result.rows[0]) throw Object.assign(new Error("Only recoverable or failed generation jobs can be retried."), { statusCode: 409 });
  return result.rows[0];
}

export async function discardGeneration(pool: DatabasePool, jobId: string) {
  const ownerUserId = await initialOwnerId(pool);
  const result = await pool.query(
    `UPDATE generation_jobs SET status = 'discarded', lease_owner = NULL, lease_expires_at = NULL,
            partial_output = NULL, updated_at = now()
      WHERE id = $1 AND owner_user_id = $2 AND status IN ('recoverable', 'failed')
      RETURNING id, status, campaign_id AS "campaignId", operation_kind AS "operationKind"`,
    [jobId, ownerUserId]
  );
  if (!result.rows[0]) throw Object.assign(new Error("Only recoverable or failed generation jobs can be discarded."), { statusCode: 409 });
  return result.rows[0];
}

export async function syncPlayerCampaignConfig(pool: DatabasePool, campaignId: string, config: PlayerCampaignConfig) {
  const ownerUserId = await initialOwnerId(pool);
  return withTransaction(pool, async (client) => {
    const campaign = await client.query<{ active_turn_number: number }>(
      `SELECT active_turn_number FROM campaigns WHERE id = $1 AND owner_user_id = $2 FOR UPDATE`,
      [campaignId, ownerUserId]
    );
    const row = campaign.rows[0];
    if (!row) throw Object.assign(new Error("Campaign not found."), { statusCode: 404 });
    if (row.active_turn_number !== config.expectedTurnNumber) {
      throw Object.assign(new Error(`Campaign is at turn ${row.active_turn_number}, not expected turn ${config.expectedTurnNumber}.`), { statusCode: 409 });
    }
    const activeJob = await client.query(
      `SELECT id FROM generation_jobs
        WHERE campaign_id = $1 AND owner_user_id = $2
          AND status IN ('queued','replacement_queued','assessing','generating','validating','committing','recoverable')
        LIMIT 1`,
      [campaignId, ownerUserId]
    );
    if (activeJob.rows[0]) {
      throw Object.assign(new Error("Campaign configuration cannot change while a story generation is active."), { statusCode: 409 });
    }
    await client.query(
      `UPDATE campaigns
          SET legacy_settings = legacy_settings || $3::jsonb, updated_at = now()
        WHERE id = $1 AND owner_user_id = $2`,
      [campaignId, ownerUserId, json({ useRpgStats: config.useRpgStats, suppressEventTriggers: config.suppressEventTriggers })]
    );
    await client.query(
      `UPDATE campaign_state
          SET rpg_stats = $3, event_triggers = $4, pending_event_triggers = $5,
              revision = revision + 1, updated_at = now()
        WHERE campaign_id = $1 AND owner_user_id = $2`,
      [campaignId, ownerUserId, json(config.rpgStats), json(config.eventTriggers), json(config.pendingEventTriggers)]
    );
    if (row.active_turn_number === 0) {
      await client.query(
        `UPDATE campaign_state
            SET initial_state_snapshot = jsonb_build_object(
              'scratchpad', scratchpad_private,
              'trackers', trackers,
              'eventTriggers', $3::jsonb,
              'pendingEventTriggers', $4::jsonb,
              'rpgStats', $5::jsonb
            )
          WHERE campaign_id = $1 AND owner_user_id = $2`,
        [campaignId, ownerUserId, json(config.eventTriggers), json(config.pendingEventTriggers), json(config.rpgStats)]
      );
    }
    return { campaignId, activeTurnNumber: row.active_turn_number, synchronized: true };
  });
}

export async function rewindCampaign(pool: DatabasePool, campaignId: string, request: CampaignRewindRequest) {
  const ownerUserId = await initialOwnerId(pool);
  return withTransaction(pool, async (client) => {
    const campaignResult = await client.query<{ active_turn_number: number }>(
      `SELECT active_turn_number FROM campaigns
        WHERE id = $1 AND owner_user_id = $2 FOR UPDATE`,
      [campaignId, ownerUserId]
    );
    const campaign = campaignResult.rows[0];
    if (!campaign) throw Object.assign(new Error("Campaign not found."), { statusCode: 404 });
    if (request.expectedCurrentTurnNumber !== undefined
        && request.expectedCurrentTurnNumber !== campaign.active_turn_number) {
      throw Object.assign(
        new Error(`Campaign is at turn ${campaign.active_turn_number}, not ${request.expectedCurrentTurnNumber}.`),
        { statusCode: 409 }
      );
    }
    if (request.targetTurnNumber > campaign.active_turn_number) {
      throw Object.assign(new Error(`Campaign has only ${campaign.active_turn_number} accepted turns.`), { statusCode: 409 });
    }

    // Resolve the target state snapshot — either from a turn row or the initial snapshot.
    let targetSnapshot: Record<string, unknown>;
    let targetModelMetadata: Record<string, unknown> | null = null;
    let targetStateEdited = false;
    if (request.targetTurnNumber === 0) {
      const initialResult = await client.query<{ initial_state_snapshot: Record<string, unknown> }>(
        `SELECT initial_state_snapshot FROM campaign_state
          WHERE campaign_id = $1 AND owner_user_id = $2 FOR UPDATE`,
        [campaignId, ownerUserId]
      );
      if (!initialResult.rows[0]) throw new Error("Campaign state was not found.");
      targetSnapshot = initialResult.rows[0].initial_state_snapshot || {};
    } else {
      const target = await client.query<{
        state_snapshot_private: Record<string, unknown>;
        model_metadata: Record<string, unknown>;
      }>(
        `SELECT state_snapshot_private, model_metadata FROM turns
          WHERE campaign_id = $1 AND owner_user_id = $2 AND turn_number = $3`,
        [campaignId, ownerUserId, request.targetTurnNumber]
      );
      const targetTurn = target.rows[0];
      if (!targetTurn) throw Object.assign(new Error("The requested rewind turn was not found."), { statusCode: 404 });
      targetSnapshot = targetTurn.state_snapshot_private || {};
      targetModelMetadata = targetTurn.model_metadata || null;
    }
    const targetEdit = await client.query<{ state_snapshot_private: Record<string, unknown> }>(
      `SELECT state_snapshot_private FROM campaign_state_edits
        WHERE campaign_id = $1 AND owner_user_id = $2 AND effective_turn_number = $3
        ORDER BY revision DESC LIMIT 1`,
      [campaignId, ownerUserId, request.targetTurnNumber]
    );
    if (targetEdit.rows[0]) {
      targetSnapshot = targetEdit.rows[0].state_snapshot_private || targetSnapshot;
      targetStateEdited = true;
    }
    if (request.targetTurnNumber === campaign.active_turn_number) {
      return {
        campaignId,
        activeTurnNumber: campaign.active_turn_number,
        discardedTurnCount: 0,
        stateSnapshot: targetSnapshot
      };
    }
    const activeGeneration = await client.query(
      `SELECT id FROM generation_jobs
        WHERE campaign_id = $1 AND owner_user_id = $2
          AND status IN ('queued','replacement_queued','assessing','generating','validating','committing','recoverable')
        LIMIT 1 FOR UPDATE`,
      [campaignId, ownerUserId]
    );
    const futureIllustrations = await client.query<{ status: string }>(
      `SELECT status FROM image_jobs
        WHERE campaign_id = $1 AND owner_user_id = $2
          AND turn_id IN (SELECT id FROM turns WHERE campaign_id = $1 AND turn_number > $3)
        FOR UPDATE`,
      [campaignId, ownerUserId, request.targetTurnNumber]
    );
    const futureResolutions = await client.query<{ status: string }>(
      `SELECT status FROM illustration_resolution_jobs
        WHERE campaign_id = $1 AND owner_user_id = $2
          AND turn_id IN (SELECT id FROM turns WHERE campaign_id = $1 AND turn_number > $3)
        FOR UPDATE`,
      [campaignId, ownerUserId, request.targetTurnNumber]
    );
    const activeChronicle = await client.query(
      `SELECT id FROM chronicle_jobs
        WHERE campaign_id = $1 AND owner_user_id = $2 AND status = 'running'
        LIMIT 1 FOR UPDATE`,
      [campaignId, ownerUserId]
    );
    if (activeGeneration.rows[0]
        || futureIllustrations.rows.some((row) => ["queued", "generating", "provider_pending", "downloading"].includes(row.status))
        || futureResolutions.rows.some((row) => ["queued", "matching", "recoverable", "generation_queued"].includes(row.status))
        || activeChronicle.rows[0]) {
      throw Object.assign(new Error("Wait for active campaign work to finish before resetting to an earlier turn."), { statusCode: 409 });
    }

    const currentStateResult = await client.query<{
      event_triggers: unknown;
      rpg_stats: unknown;
    }>(
      `SELECT event_triggers, rpg_stats FROM campaign_state
        WHERE campaign_id = $1 AND owner_user_id = $2 FOR UPDATE`,
      [campaignId, ownerUserId]
    );
    const currentState = currentStateResult.rows[0];
    if (!currentState) throw new Error("Campaign state was not found.");
    const snapshot = targetSnapshot;
    const scratchpad = typeof snapshot.scratchpad === "string" ? snapshot.scratchpad : "";
    const trackers = Array.isArray(snapshot.trackers) ? snapshot.trackers : [];
    const eventTriggers = Array.isArray(snapshot.eventTriggers) ? snapshot.eventTriggers : currentState.event_triggers;
    const pendingEventTriggers = Array.isArray(snapshot.pendingEventTriggers) ? snapshot.pendingEventTriggers : [];
    const rpgStats = Array.isArray(snapshot.rpgStats) ? snapshot.rpgStats : currentState.rpg_stats;
    const scratchpadSafeForPrompt = targetStateEdited || typeof targetModelMetadata?.promptProtocolVersion === "string";
    const discardedTurnCount = campaign.active_turn_number - request.targetTurnNumber;

    await client.query(
      `DELETE FROM generation_jobs
        WHERE campaign_id = $1 AND owner_user_id = $2 AND expected_turn_number > $3`,
      [campaignId, ownerUserId, request.targetTurnNumber]
    );
    await client.query(
      `DELETE FROM campaign_state_edits
        WHERE campaign_id = $1 AND owner_user_id = $2 AND effective_turn_number > $3`,
      [campaignId, ownerUserId, request.targetTurnNumber]
    );
    await client.query(
      `DELETE FROM turns
        WHERE campaign_id = $1 AND owner_user_id = $2 AND turn_number > $3`,
      [campaignId, ownerUserId, request.targetTurnNumber]
    );
    await client.query(
      `DELETE FROM summary_checkpoints
        WHERE campaign_id = $1 AND owner_user_id = $2 AND through_turn > $3`,
      [campaignId, ownerUserId, request.targetTurnNumber]
    );
    await client.query(
      `DELETE FROM chronicle_jobs
        WHERE campaign_id = $1 AND owner_user_id = $2 AND status <> 'running'`,
      [campaignId, ownerUserId]
    );
    await rebuildCampaignMemories(client, ownerUserId, campaignId);
    await enqueueEmbeddingReindex(client, campaignId);
    await client.query(
      `DELETE FROM model_chains WHERE campaign_id = $1 AND owner_user_id = $2`,
      [campaignId, ownerUserId]
    );
    await client.query(
      `UPDATE campaign_state SET scratchpad_private = $3, scratchpad_safe_for_prompt = $4,
         trackers = $5, event_triggers = $6, pending_event_triggers = $7, rpg_stats = $8,
         revision = revision + 1, updated_at = now()
        WHERE campaign_id = $1 AND owner_user_id = $2`,
      [campaignId, ownerUserId, scratchpad, scratchpadSafeForPrompt, json(trackers), json(eventTriggers),
        json(pendingEventTriggers), json(rpgStats)]
    );
    await client.query(
      `UPDATE campaigns SET active_turn_number = $3, updated_at = now()
        WHERE id = $1 AND owner_user_id = $2`,
      [campaignId, ownerUserId, request.targetTurnNumber]
    );
    await client.query(
      `INSERT INTO activity_events (owner_user_id, campaign_id, event_type, details)
       VALUES ($1,$2,'campaign_rewound',$3)`,
      [ownerUserId, campaignId, json({ fromTurnNumber: campaign.active_turn_number, targetTurnNumber: request.targetTurnNumber, discardedTurnCount })]
    );
    return {
      campaignId,
      activeTurnNumber: request.targetTurnNumber,
      discardedTurnCount,
      stateSnapshot: { scratchpad, trackers, eventTriggers, pendingEventTriggers, rpgStats }
    };
  });
}

export async function branchCampaign(pool: DatabasePool, campaignId: string, request: CampaignBranchRequest) {
  const ownerUserId = await initialOwnerId(pool);
  return withTransaction(pool, async (client) => {
    const campaignResult = await client.query<{
      active_turn_number: number;
      world_version_id: string;
      title: string;
      story_length_profile: string;
      turn_control_style: string;
      selected_character_id: string | null;
      character_snapshot: Record<string, unknown> | null;
      legacy_settings: Record<string, unknown>;
      text_provider_profile_id: string | null;
      image_provider_profile_id: string | null;
    }>(
      `SELECT active_turn_number, world_version_id, title, story_length_profile, turn_control_style,
              selected_character_id, character_snapshot, legacy_settings,
              text_provider_profile_id, image_provider_profile_id
         FROM campaigns
        WHERE id = $1 AND owner_user_id = $2 FOR UPDATE`,
      [campaignId, ownerUserId]
    );
    const campaign = campaignResult.rows[0];
    if (!campaign) throw Object.assign(new Error("Campaign not found."), { statusCode: 404 });
    if (request.expectedCurrentTurnNumber !== undefined
        && request.expectedCurrentTurnNumber !== campaign.active_turn_number) {
      throw Object.assign(
        new Error(`Campaign is at turn ${campaign.active_turn_number}, not ${request.expectedCurrentTurnNumber}.`),
        { statusCode: 409 }
      );
    }
    if (request.targetTurnNumber > campaign.active_turn_number) {
      throw Object.assign(new Error(`Campaign has only ${campaign.active_turn_number} accepted turns.`), { statusCode: 409 });
    }

    const parentStateResult = await client.query<{
      default_triggers: unknown;
      initial_state_snapshot: Record<string, unknown>;
    }>(
      `SELECT default_triggers, initial_state_snapshot FROM campaign_state
        WHERE campaign_id = $1 AND owner_user_id = $2 FOR UPDATE`,
      [campaignId, ownerUserId]
    );
    const parentState = parentStateResult.rows[0] || { default_triggers: [], initial_state_snapshot: {} };

    let targetSnapshot: Record<string, unknown>;
    let targetModelMetadata: Record<string, unknown> | null = null;
    let targetStateEdited = false;
    if (request.targetTurnNumber === 0) {
      targetSnapshot = parentState.initial_state_snapshot || {};
    } else {
      const target = await client.query<{
        state_snapshot_private: Record<string, unknown>;
        model_metadata: Record<string, unknown>;
      }>(
        `SELECT state_snapshot_private, model_metadata FROM turns
          WHERE campaign_id = $1 AND owner_user_id = $2 AND turn_number = $3`,
        [campaignId, ownerUserId, request.targetTurnNumber]
      );
      const targetTurn = target.rows[0];
      if (!targetTurn) throw Object.assign(new Error("The requested branch turn was not found."), { statusCode: 404 });
      targetSnapshot = targetTurn.state_snapshot_private || {};
      targetModelMetadata = targetTurn.model_metadata || null;
    }
    const targetEdit = await client.query<{ state_snapshot_private: Record<string, unknown> }>(
      `SELECT state_snapshot_private FROM campaign_state_edits
        WHERE campaign_id = $1 AND owner_user_id = $2 AND effective_turn_number = $3
        ORDER BY revision DESC LIMIT 1`,
      [campaignId, ownerUserId, request.targetTurnNumber]
    );
    if (targetEdit.rows[0]) {
      targetSnapshot = targetEdit.rows[0].state_snapshot_private || targetSnapshot;
      targetStateEdited = true;
    }

    const branchTitle = request.title?.trim() || `${campaign.title} (Branch Turn ${request.targetTurnNumber})`;
    const newCampaignRes = await client.query<{ id: string }>(
      `INSERT INTO campaigns (
         owner_user_id, world_version_id, title, status, active_turn_number,
         story_length_profile, turn_control_style, selected_character_id, character_snapshot, legacy_settings,
         text_provider_profile_id, image_provider_profile_id
       ) VALUES ($1,$2,$3,'active',$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [
        ownerUserId, campaign.world_version_id, branchTitle, request.targetTurnNumber,
        campaign.story_length_profile, campaign.turn_control_style, campaign.selected_character_id, json(campaign.character_snapshot), json(campaign.legacy_settings),
        campaign.text_provider_profile_id, campaign.image_provider_profile_id
      ]
    );
    const newCampaignId = newCampaignRes.rows[0]?.id;
    if (!newCampaignId) throw new Error("Could not create campaign branch.");

    const scratchpad = typeof targetSnapshot.scratchpad === "string" ? targetSnapshot.scratchpad : "";
    const trackers = Array.isArray(targetSnapshot.trackers) ? targetSnapshot.trackers : [];
    const eventTriggers = Array.isArray(targetSnapshot.eventTriggers) ? targetSnapshot.eventTriggers : [];
    const pendingEventTriggers = Array.isArray(targetSnapshot.pendingEventTriggers) ? targetSnapshot.pendingEventTriggers : [];
    const rpgStats = Array.isArray(targetSnapshot.rpgStats) ? targetSnapshot.rpgStats : [];
    const scratchpadSafeForPrompt = targetStateEdited || typeof targetModelMetadata?.promptProtocolVersion === "string";

    const branchProvenance = {
      sourceType: "nexus_campaign_branch",
      parentCampaignId: campaignId,
      branchTurnNumber: request.targetTurnNumber,
      branchId: crypto.randomUUID()
    };

    await client.query(
      `INSERT INTO campaign_state (
         campaign_id, owner_user_id, scratchpad_private, scratchpad_safe_for_prompt,
         trackers, default_triggers, event_triggers, pending_event_triggers, rpg_stats,
         import_provenance, initial_state_snapshot
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        newCampaignId, ownerUserId, scratchpad, scratchpadSafeForPrompt,
        json(trackers), json(parentState.default_triggers), json(eventTriggers), json(pendingEventTriggers), json(rpgStats),
        json(branchProvenance), json(parentState.initial_state_snapshot)
      ]
    );
    if (targetStateEdited) {
      await client.query(
        `INSERT INTO campaign_state_edits (
           owner_user_id, campaign_id, effective_turn_number, revision, state_snapshot_private, changed_fields
         ) VALUES ($1,$2,$3,1,$4,$5)`,
        [ownerUserId, newCampaignId, request.targetTurnNumber, json(targetSnapshot), json(["branchedState"])]
      );
      await client.query(
        `UPDATE campaign_state SET revision = 1 WHERE campaign_id = $1 AND owner_user_id = $2`,
        [newCampaignId, ownerUserId]
      );
    }

    await client.query(
      `INSERT INTO campaign_illustration_configs (
         campaign_id, owner_user_id, enabled, source_policy, matching_scope, confidence_profile, repetition_window,
         provider_profile_id, model, size, aspect_ratio, quality, output_format, max_attempts
       ) SELECT $1, owner_user_id, enabled, source_policy, matching_scope, confidence_profile, repetition_window,
                provider_profile_id, model, size, aspect_ratio, quality, output_format, max_attempts
           FROM campaign_illustration_configs WHERE campaign_id = $2 AND owner_user_id = $3 ON CONFLICT DO NOTHING`,
      [newCampaignId, campaignId, ownerUserId]
    );

    await client.query(
      `INSERT INTO campaign_memory_configs (
         campaign_id, owner_user_id, embedding_enabled, embedding_provider_profile_id, embedding_model, embedding_batch_size,
         embedding_document_prefix, embedding_query_prefix
       ) SELECT $1, owner_user_id, embedding_enabled, embedding_provider_profile_id, embedding_model, embedding_batch_size,
                embedding_document_prefix, embedding_query_prefix
           FROM campaign_memory_configs WHERE campaign_id = $2 AND owner_user_id = $3 ON CONFLICT DO NOTHING`,
      [newCampaignId, campaignId, ownerUserId]
    );
    await autoEnableCampaignEmbeddingIfAvailable(client, ownerUserId, newCampaignId);

    if (request.targetTurnNumber > 0) {
      await client.query(
        `INSERT INTO turns (
           campaign_id, owner_user_id, turn_number, source_turn_id, action, input_mode, input_mode_source, narration,
           choices, custom_action_suggestion, image_prompt, image_url, mechanics_private,
           state_snapshot_private, model_metadata, import_metadata, accepted_at, created_at
         ) SELECT $1, owner_user_id, turn_number, source_turn_id, action, input_mode, input_mode_source, narration,
                  choices, custom_action_suggestion, image_prompt, image_url, mechanics_private,
                  state_snapshot_private, model_metadata, import_metadata, accepted_at, created_at
             FROM turns WHERE campaign_id = $2 AND owner_user_id = $3 AND turn_number <= $4
            ORDER BY turn_number ASC`,
        [newCampaignId, campaignId, ownerUserId, request.targetTurnNumber]
      );
      await client.query(
        `INSERT INTO summary_checkpoints (
           owner_user_id, campaign_id, through_turn, summary_kind, content, token_estimate, created_at
         ) SELECT owner_user_id, $1, through_turn, summary_kind, content, token_estimate, created_at
             FROM summary_checkpoints WHERE campaign_id = $2 AND owner_user_id = $3 AND through_turn <= $4`,
        [newCampaignId, campaignId, ownerUserId, request.targetTurnNumber]
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
          WHERE source_ref.campaign_id = $2
            AND source_ref.owner_user_id = $3
            AND source_turn.turn_number <= $4
         ON CONFLICT DO NOTHING`,
        [newCampaignId, campaignId, ownerUserId, request.targetTurnNumber]
      );
    }

    await client.query(
      `INSERT INTO asset_references (
         owner_user_id, asset_id, campaign_id, turn_id, asset_role, created_at
       )
       SELECT owner_user_id, asset_id, $1, NULL, asset_role, created_at
         FROM asset_references
        WHERE campaign_id = $2 AND owner_user_id = $3 AND turn_id IS NULL
       ON CONFLICT DO NOTHING`,
      [newCampaignId, campaignId, ownerUserId]
    );

    await rebuildCampaignMemories(client, ownerUserId, newCampaignId);
    await enqueueEmbeddingReindex(client, newCampaignId);

    await client.query(
      `INSERT INTO activity_events (owner_user_id, campaign_id, event_type, details)
       VALUES ($1,$2,'campaign_branched',$3)`,
      [ownerUserId, newCampaignId, json({ parentCampaignId: campaignId, branchTurnNumber: request.targetTurnNumber })]
    );

    return {
      id: newCampaignId,
      title: branchTitle,
      status: "active",
      activeTurnNumber: request.targetTurnNumber,
      storyLengthProfile: campaign.story_length_profile,
      turnControlStyle: campaign.turn_control_style,
      worldVersionId: campaign.world_version_id,
      selectedCharacterId: campaign.selected_character_id,
      textProviderProfileId: campaign.text_provider_profile_id,
      imageProviderProfileId: campaign.image_provider_profile_id
    };
  });
}

async function claimGeneration(pool: DatabasePool, workerId: string, leaseSeconds: number): Promise<ClaimedJob | null> {
  return withTransaction(pool, async (client) => {
    const result = await client.query<ClaimedJob>(
      `WITH candidate AS (
         SELECT id FROM generation_jobs
          WHERE status IN ('queued','replacement_queued') OR (status IN ('assessing','generating','validating','committing') AND lease_expires_at < now())
          ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1
       )
       UPDATE generation_jobs j SET status = 'assessing', attempts = attempts + 1, lease_owner = $1,
              lease_expires_at = now() + ($2::text || ' seconds')::interval, updated_at = now()
         FROM candidate WHERE j.id = candidate.id
       RETURNING j.id, j.owner_user_id, j.campaign_id, j.provider_profile_id, j.expected_turn_number,
                 j.action, j.operation_kind, j.replacement_turn_id, j.base_turn_number, j.base_state_private,
                 j.base_scratchpad_safe_for_prompt,
                 j.requested_input_mode, j.resolved_input_mode, j.input_mode_source,
                 j.requested_model, j.context_options, j.prompt_protocol_version, j.attempts,
                 j.orchestration_private`,
      [workerId, leaseSeconds]
    );
    return result.rows[0] ?? null;
  });
}

function mergedTrackers(current: unknown, updates: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const existing = Array.isArray(current) ? current.filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null) : [];
  const map = new Map(existing.map((item, index) => [String(item.id || item.name || index), item]));
  for (const update of updates) {
    const key = String(update.id || update.name || crypto.randomUUID());
    map.set(key, { ...(map.get(key) || {}), ...update });
  }
  return [...map.values()];
}

async function loadOrchestrationInputs(pool: DatabasePool, job: ClaimedJob): Promise<OrchestrationInputs> {
  const result = await pool.query<{
    legacy_settings: Record<string, unknown>;
    rpg_stats: unknown;
    event_triggers: unknown;
    pending_event_triggers: unknown;
    state_snapshot_private: Record<string, unknown> | null;
  }>(
    `SELECT c.legacy_settings, cs.rpg_stats, cs.event_triggers, cs.pending_event_triggers,
            latest.state_snapshot_private
       FROM campaigns c
       JOIN campaign_state cs ON cs.campaign_id = c.id AND cs.owner_user_id = c.owner_user_id
       LEFT JOIN LATERAL (
         SELECT state_snapshot_private FROM turns
          WHERE campaign_id = c.id AND owner_user_id = c.owner_user_id
          ORDER BY turn_number DESC LIMIT 1
       ) latest ON true
      WHERE c.id = $1 AND c.owner_user_id = $2`,
    [job.campaign_id, job.owner_user_id]
  );
  const row = result.rows[0];
  if (!row) throw new Error("Campaign orchestration state was not found.");
  const stagedState = job.operation_kind === "replace_latest" ? job.base_state_private || {} : null;
  const rpgSource = stagedState && Array.isArray(stagedState.rpgStats) ? stagedState.rpgStats : row.rpg_stats;
  const eventSource = stagedState && Array.isArray(stagedState.eventTriggers) ? stagedState.eventTriggers : row.event_triggers;
  const pendingSource = stagedState && Array.isArray(stagedState.pendingEventTriggers) ? stagedState.pendingEventTriggers : row.pending_event_triggers;
  const rpgStats = (Array.isArray(rpgSource) ? rpgSource : []).flatMap((entry) => {
    const parsed = playerRpgStatSchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
  const eventTriggers = (Array.isArray(eventSource) ? eventSource : []).flatMap((entry) => {
    const parsed = playerEventTriggerSchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
  const pendingEventTriggers = (Array.isArray(pendingSource) ? pendingSource : []).flatMap((entry) => {
    const parsed = pendingEventTriggerSchema.safeParse(entry);
    return parsed.success ? [{ ...parsed.data, addTextAfter: false }] : [];
  });
  const latestSnapshot = stagedState || row.state_snapshot_private || {};
  const continuitySummary = typeof latestSnapshot.continuitySummary === "string"
    ? latestSnapshot.continuitySummary.trim()
    : "";
  const openThreads = Array.isArray(latestSnapshot.openThreads)
    ? latestSnapshot.openThreads.filter((value): value is string => typeof value === "string" && Boolean(value.trim()))
    : undefined;
  return {
    useRpgStats: row.legacy_settings?.useRpgStats === true,
    suppressEventTriggers: row.legacy_settings?.suppressEventTriggers === true,
    rpgStats,
    eventTriggers,
    pendingEventTriggers,
    storyMemoryDefaults: {
      ...(continuitySummary ? { continuitySummary } : {}),
      canonicalFacts: [],
      supersededFacts: [],
      ...(openThreads ? { openThreads } : {})
    }
  };
}

async function persistOrchestration(pool: DatabasePool, job: ClaimedJob, patch: Partial<OrchestrationPrivate>, workerId: string): Promise<OrchestrationPrivate> {
  const merged = { ...(job.orchestration_private || {}), ...patch };
  const result = await pool.query(
    `UPDATE generation_jobs SET orchestration_private = $3, updated_at = now()
      WHERE id = $1 AND owner_user_id = $2 AND lease_owner = $4
      RETURNING id`,
    [job.id, job.owner_user_id, json(merged), workerId]
  );
  if (!result.rows[0]) throw Object.assign(new Error("Generation lease was lost while persisting private orchestration."), { code: "lease_lost" });
  job.orchestration_private = merged;
  return merged;
}

async function evaluateTriggers(
  pool: DatabasePool,
  provider: Awaited<ReturnType<typeof loadTextProvider>>,
  phase: "before" | "after",
  context: unknown,
  job: ClaimedJob,
  triggers: PlayerEventTrigger[],
  narration = ""
): Promise<ActivatedEvent[]> {
  if (!triggers.length) return [];
  const response = await callCampaignTextProvider(pool, provider, job,
    phase === "before" ? "event_trigger_before" : "event_trigger_after", {
    systemPrompt: EVENT_TRIGGER_SYSTEM_PROMPT,
    input: buildEventTriggerPrompt(phase, context, job.action, job.expected_turn_number, triggers, narration)
  });
  if (response.outputLimited) throw new Error("The private event evaluation reached its output limit.");
  return activatedEventsFromResponse(response.content, triggers, job.expected_turn_number);
}

async function commitStory(
  client: DatabaseClient,
  job: ClaimedJob,
  story: StoryTurnOutput,
  provider: Awaited<ReturnType<typeof loadTextProvider>>,
  response: Awaited<ReturnType<typeof callTextProvider>>,
  contextFingerprint: string,
  contextDiagnostics: Record<string, unknown>,
  inputs: OrchestrationInputs,
  orchestration: OrchestrationPrivate,
  fictionAction: string,
  workerId: string
): Promise<string> {
  const lease = await client.query<{ lease_owner: string | null }>(
    `SELECT lease_owner FROM generation_jobs WHERE id = $1 AND owner_user_id = $2 FOR UPDATE`,
    [job.id, job.owner_user_id]
  );
  if (lease.rows[0]?.lease_owner !== workerId) throw Object.assign(new Error("Generation lease was lost before commit."), { code: "lease_lost" });
  const campaignResult = await client.query<{ active_turn_number: number; world_version_id: string }>(
    `SELECT active_turn_number, world_version_id FROM campaigns WHERE id = $1 AND owner_user_id = $2 FOR UPDATE`, [job.campaign_id, job.owner_user_id]
  );
  const campaign = campaignResult.rows[0];
  if (!campaign) throw new Error("Campaign disappeared before story commit.");
  const isReplacement = job.operation_kind === "replace_latest";
  const expectedCampaignTurn = isReplacement ? job.expected_turn_number : job.expected_turn_number - 1;
  if (campaign.active_turn_number !== expectedCampaignTurn) {
    throw Object.assign(new Error("Campaign advanced before this generation could commit."), { code: "stale_campaign" });
  }
  if (isReplacement) {
    const replacement = await client.query<{ id: string }>(
      `SELECT id FROM turns
        WHERE id = $1 AND campaign_id = $2 AND owner_user_id = $3 AND turn_number = $4 FOR UPDATE`,
      [job.replacement_turn_id, job.campaign_id, job.owner_user_id, job.expected_turn_number]
    );
    if (!replacement.rows[0]) throw Object.assign(new Error("The turn selected for replacement changed before commit."), { code: "stale_campaign" });
    const conflictingWork = await client.query(
      `SELECT 'image' AS kind FROM image_jobs
        WHERE campaign_id = $1 AND owner_user_id = $2 AND turn_id = $3 AND status IN ('queued','generating')
       UNION ALL
       SELECT 'chronicle' AS kind FROM chronicle_jobs
        WHERE campaign_id = $1 AND owner_user_id = $2 AND status = 'running'
       LIMIT 1`,
      [job.campaign_id, job.owner_user_id, job.replacement_turn_id]
    );
    if (conflictingWork.rows[0]) {
      throw Object.assign(new Error("Active derived work prevented the replacement from committing safely."), { code: "replacement_work_active" });
    }
  }
  const stateResult = await client.query<{ trackers: unknown }>(`SELECT trackers FROM campaign_state WHERE campaign_id = $1 AND owner_user_id = $2 FOR UPDATE`, [job.campaign_id, job.owner_user_id]);
  const trackerBase = isReplacement && Array.isArray(job.base_state_private?.trackers)
    ? job.base_state_private.trackers
    : stateResult.rows[0]?.trackers;
  const trackers = mergedTrackers(trackerBase, story.tracker_updates);
  const allEvents = [...(orchestration.beforeEvents || []), ...(orchestration.afterEvents || [])];
  const newlyActivated = allEvents.filter((event) => event.sourceTurn === job.expected_turn_number);
  const eventTriggers = applyTriggerHits(inputs.eventTriggers, newlyActivated, new Date().toISOString());
  const pendingEventTriggers = (orchestration.afterEvents || [])
    .filter((event) => !event.addTextAfter || Boolean(orchestration.extensionError))
    .map(({ addTextAfter: _addTextAfter, ...event }) => event);
  const mechanicsPrivate = {
    roll: orchestration.roll || null,
    beforeEvents: orchestration.beforeEvents || [],
    afterEvents: orchestration.afterEvents || [],
    extensionApplied: Boolean((orchestration.afterEvents || []).some((event) => event.addTextAfter) && !orchestration.extensionError)
  };
  if (isReplacement) {
    await client.query(
      `DELETE FROM campaign_state_edits
        WHERE campaign_id = $1 AND owner_user_id = $2 AND effective_turn_number > $3`,
      [job.campaign_id, job.owner_user_id, job.base_turn_number ?? 0]
    );
    await client.query(
      `DELETE FROM summary_checkpoints
        WHERE campaign_id = $1 AND owner_user_id = $2 AND through_turn > $3`,
      [job.campaign_id, job.owner_user_id, job.base_turn_number ?? 0]
    );
    await client.query(
      `DELETE FROM chronicle_jobs
        WHERE campaign_id = $1 AND owner_user_id = $2 AND status <> 'running'`,
      [job.campaign_id, job.owner_user_id]
    );
    await client.query(
      `DELETE FROM model_chains WHERE campaign_id = $1 AND owner_user_id = $2`,
      [job.campaign_id, job.owner_user_id]
    );
    await client.query(
      `DELETE FROM turns WHERE id = $1 AND campaign_id = $2 AND owner_user_id = $3`,
      [job.replacement_turn_id, job.campaign_id, job.owner_user_id]
    );
  }
  const turnResult = await client.query<{ id: string }>(
    `INSERT INTO turns (owner_user_id, campaign_id, turn_number, action, input_mode, input_mode_source, narration, choices,
       custom_action_suggestion, image_prompt, mechanics_private, state_snapshot_private, model_metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
    [job.owner_user_id, job.campaign_id, job.expected_turn_number, job.action, job.resolved_input_mode, job.input_mode_source,
      story.narration, json(story.choices),
      story.custom_action_suggestion, story.image_prompt, json(mechanicsPrivate),
      json({ scratchpad: story.scratchpad, trackers, eventTriggers, pendingEventTriggers, rpgStats: inputs.rpgStats,
        continuitySummary: story.continuity_summary, canonicalFacts: story.canonical_facts,
        supersededFacts: story.superseded_facts,
        canonicalFactUpdates: story.canonical_fact_updates.map((update) => ({
          content: update.content,
          supersedesFactIds: update.supersedes_fact_ids
        })),
        openThreads: story.open_threads }),
      json({ providerProfileId: provider.id, providerType: provider.providerType, model: provider.model, modelInstanceId: response.modelInstanceId,
        responseId: response.responseId, usage: response.usage, promptProtocolVersion: job.prompt_protocol_version,
        contextFingerprint, contextDiagnostics })]
  );
  const turnId = turnResult.rows[0]?.id;
  if (!turnId) throw new Error("Story turn insert did not return an ID.");
  await attributeGenerationCostsToTurn(client, job.owner_user_id, job.campaign_id, job.id, turnId);
  await client.query(
    `UPDATE campaign_state SET scratchpad_private = $3, scratchpad_safe_for_prompt = true, trackers = $4, event_triggers = $5,
       pending_event_triggers = $6, rpg_stats = $7, revision = revision + 1, updated_at = now()
      WHERE campaign_id = $1 AND owner_user_id = $2`,
    [job.campaign_id, job.owner_user_id, story.scratchpad, json(trackers), json(eventTriggers), json(pendingEventTriggers), json(inputs.rpgStats)]
  );
  await client.query(`UPDATE campaigns SET active_turn_number = $3, updated_at = now() WHERE id = $1 AND owner_user_id = $2`, [job.campaign_id, job.owner_user_id, job.expected_turn_number]);
  if (isReplacement) {
    await rebuildCampaignMemories(client, job.owner_user_id, job.campaign_id);
    await client.query(
      `INSERT INTO activity_events (owner_user_id, campaign_id, event_type, correlation_id, details)
       VALUES ($1,$2,'campaign_turn_replaced',$3,$4)`,
      [job.owner_user_id, job.campaign_id, job.id, json({ turnNumber: job.expected_turn_number, replacementTurnId: turnId })]
    );
  } else {
    await storeDerivedTurnMemories(client, job.owner_user_id, job.campaign_id, campaign.world_version_id, turnId,
      job.expected_turn_number, {
        continuitySummary: story.continuity_summary,
        canonicalFacts: story.canonical_facts,
        supersededFacts: story.superseded_facts,
        canonicalFactUpdates: story.canonical_fact_updates.map((update) => ({
          content: update.content,
          supersedesFactIds: update.supersedes_fact_ids
        })),
        openThreads: story.open_threads
      });
    const memory = buildTurnFictionMemory({ action: fictionAction, narration: story.narration }, job.expected_turn_number);
    await client.query(
      `INSERT INTO chronicle_memories (owner_user_id, campaign_id, world_version_id, turn_id, memory_kind, ordinal, content, token_estimate, importance, entities, metadata)
       VALUES ($1,$2,$3,$4,'turn_fiction',$5,$6,$7,$8,$9,$10)`,
      [job.owner_user_id, job.campaign_id, campaign.world_version_id, turnId, job.expected_turn_number, memory.content, memory.tokenEstimate,
        Math.min(1, 0.5 + job.expected_turn_number / 100), memory.entities, json({ sanitized: memory.sanitized, removedMechanicsSegments: memory.removedMechanicsSegments, generated: true })]
    );
  }
  await enqueueAcceptedTurnIllustration(client, job.owner_user_id, job.campaign_id, turnId, story.image_prompt);
  await enqueueEmbeddingReindex(client, job.campaign_id);
  await client.query(
    `UPDATE generation_jobs SET status = 'completed', result_turn_id = $3, provider_response_id = $4,
       provider_finish_reason = $5, completed_at = now(), updated_at = now(), lease_owner = NULL, lease_expires_at = NULL,
       partial_output = NULL, error_code = NULL, error_message = NULL
     WHERE id = $1 AND owner_user_id = $2 AND lease_owner = $6`,
    [job.id, job.owner_user_id, turnId, response.responseId || null, response.finishReason || null, workerId]
  );
  return turnId;
}

export async function runGenerationJob(pool: DatabasePool, workerId: string, leaseSeconds: number, credentialSecret: string): Promise<boolean> {
  const job = await claimGeneration(pool, workerId, leaseSeconds);
  if (!job) return false;
  const heartbeat = setInterval(() => {
    void pool.query(
      `UPDATE generation_jobs SET lease_expires_at = now() + ($3::text || ' seconds')::interval, updated_at = now()
        WHERE id = $1 AND lease_owner = $2 AND status IN ('assessing','generating','validating','committing')`,
      [job.id, workerId, leaseSeconds]
    ).catch(() => undefined);
  }, Math.max(5000, Math.floor(leaseSeconds * 1000 / 3)));
  try {
    const provider = await loadTextProvider(pool, job.owner_user_id, job.provider_profile_id, credentialSecret, job.requested_model);
    const safeAction = safeTurnInput(job.action);
    const storyLength = snapshottedStoryLength(job.context_options);
    const requestedContextWindow = Number(job.context_options.modelContextWindowTokens || provider.contextWindowTokens);
    const effectiveContextWindow = Math.min(provider.contextWindowTokens, requestedContextWindow);
    const inputTokenLimit = effectiveContextWindow - provider.maxOutputTokens;
    const emptyPromptContext = { worldCanon: {}, campaignCanon: {}, chronicle: [], currentScene: null };
    const fixedPromptEnvelope = budgetTokenEstimate(STORY_SYSTEM_PROMPT)
      + budgetTokenEstimate(buildStoryUserPrompt(emptyPromptContext, safeAction, false, [], storyLength, job.resolved_input_mode))
      + 1024;
    if (inputTokenLimit - fixedPromptEnvelope < 512) {
      throw Object.assign(new Error(`The provider context window (${effectiveContextWindow}) cannot fit the configured output reserve (${provider.maxOutputTokens}) and story prompt envelope.`), { code: "context_budget_invalid" });
    }
    const safeContextBudget = Math.max(512, Math.min(
      Number(job.context_options.budgetTokens || 32000),
      inputTokenLimit - fixedPromptEnvelope
    ));
    const context = await buildContextPreview(
      pool,
      job.campaign_id,
      { ...job.context_options, budgetTokens: safeContextBudget, query: safeAction },
      credentialSecret,
      { generationJobId: job.id, operation: "retrieval_embedding" },
      job.operation_kind === "replace_latest"
        ? {
            throughTurnNumber: job.base_turn_number ?? 0,
            stateOverride: job.base_state_private,
            scratchpadSafeForPrompt: job.base_scratchpad_safe_for_prompt
          }
        : {}
    );
    const promptContext = context.scopes;
    const inputs = await loadOrchestrationInputs(pool, job);
    let orchestration = job.orchestration_private || {};
    if (orchestration.roll === undefined) {
      if (job.resolved_input_mode === "action" && inputs.useRpgStats && job.expected_turn_number > 1 && inputs.rpgStats.length) {
        let assessment;
        let assessmentError = "";
        try {
          const response = await callCampaignTextProvider(pool, provider, job, "rpg_assessment", {
            systemPrompt: RPG_ASSESSMENT_SYSTEM_PROMPT,
            input: buildRpgAssessmentPrompt(promptContext, job.action, inputs.rpgStats)
          });
          if (response.outputLimited) throw new Error("The private RPG assessment reached its output limit.");
          assessment = parseRpgAssessment(response.content);
        } catch (error) {
          assessmentError = error instanceof Error ? error.message : String(error);
          assessment = localRpgAssessment(job.action, inputs.rpgStats);
        }
        orchestration = await persistOrchestration(pool, job, {
          roll: performPrivateRoll(assessment, inputs.rpgStats),
          ...(assessmentError ? { rpgAssessmentError: assessmentError.slice(0, 2000) } : {})
        }, workerId);
      } else {
        orchestration = await persistOrchestration(pool, job, { roll: null }, workerId);
      }
    }
    if (orchestration.beforeEvents === undefined) {
      let activated: ActivatedEvent[] = [];
      let triggerError = "";
      if (!inputs.suppressEventTriggers) {
        const triggers = inputs.eventTriggers.filter((trigger) => trigger.timing === "before");
        try {
          activated = await evaluateTriggers(pool, provider, "before", promptContext, job, triggers);
        } catch (error) {
          triggerError = error instanceof Error ? error.message : String(error);
        }
      }
      orchestration = await persistOrchestration(pool, job, {
        beforeEvents: [...inputs.pendingEventTriggers, ...activated],
        ...(triggerError ? { beforeTriggerError: triggerError.slice(0, 2000) } : {})
      }, workerId);
    }
    const safeGuidance = [
      ...fictionGuidanceForRoll(orchestration.roll || null),
      ...fictionGuidanceForEvents(orchestration.beforeEvents || [])
    ].filter((entry) => entry && !containsMechanicsLanguage(entry));
    await pool.query(`UPDATE generation_jobs SET status = 'generating', updated_at = now() WHERE id = $1 AND lease_owner = $2`, [job.id, workerId]);
    let storyInput = buildStoryUserPrompt(promptContext, safeAction, false, safeGuidance, storyLength, job.resolved_input_mode);
    const removalPriority = ["chronological", "relevant", "summary_checkpoint", "recent", "open_threads"];
    while (budgetTokenEstimate(STORY_SYSTEM_PROMPT) + budgetTokenEstimate(storyInput) > inputTokenLimit && promptContext.chronicle.length) {
      let removalIndex = -1;
      for (const reason of removalPriority) {
        removalIndex = promptContext.chronicle.findIndex((memory) => memory.reason === reason);
        if (removalIndex >= 0) break;
      }
      promptContext.chronicle.splice(removalIndex >= 0 ? removalIndex : 0, 1);
      storyInput = buildStoryUserPrompt(promptContext, safeAction, false, safeGuidance, storyLength, job.resolved_input_mode);
    }
    const estimatedPromptTokens = budgetTokenEstimate(STORY_SYSTEM_PROMPT) + budgetTokenEstimate(storyInput);
    if (estimatedPromptTokens > inputTokenLimit) {
      throw Object.assign(new Error(`The fixed authoritative story context requires about ${estimatedPromptTokens} input tokens but only ${inputTokenLimit} are available.`), { code: "context_budget_exceeded" });
    }
    const contextFingerprint = sha256(stableStringify({
      provider: provider.id,
      model: provider.model,
      protocol: job.prompt_protocol_version,
      expectedTurnNumber: job.expected_turn_number,
      action: safeAction,
      inputMode: job.resolved_input_mode,
      storyLength,
      context: promptContext
    }));
    const contextDiagnostics = {
      effectiveContextWindow,
      inputTokenLimit,
      reservedOutputTokens: provider.maxOutputTokens,
      estimatedPromptTokens,
      storyLength,
      selectedMemoryIds: promptContext.chronicle.map((memory) => memory.id),
      selectedMemoryHashes: promptContext.chronicle.map((memory) => sha256(memory.content)),
      selectedCompression: context.selectedCompression,
      retrieval: context.retrieval
    };
    const storyMemoryDefaults = {
      ...storyMemoryDefaultsFromContext(promptContext),
      ...inputs.storyMemoryDefaults
    };
    let lastPartialUpdate = 0;
    let lastPartialContent = "";
    const onChunk = async (_delta: string, accumulated: string) => {
      const now = Date.now();
      if (now - lastPartialUpdate >= 350 && accumulated !== lastPartialContent) {
        lastPartialUpdate = now;
        lastPartialContent = accumulated;
        try {
          await pool.query(
            `UPDATE generation_jobs SET partial_output = $2, updated_at = now() WHERE id = $1 AND lease_owner = $3`,
            [job.id, accumulated, workerId]
          );
        } catch {
          // ignore transient update errors during active streaming
        }
      }
    };
    const supportsStreaming = Boolean(provider.configuration && (provider.configuration.streaming === true || provider.configuration.streamingSupport === true));
    const baseRequest = { systemPrompt: STORY_SYSTEM_PROMPT, input: storyInput, ...(supportsStreaming ? { onChunk } : {}) };
    let result = await callCampaignTextProvider(pool, provider, job, "story_generation", baseRequest);
    let parsed = parseStoryOutput(result.content, storyMemoryDefaults);
    const firstReason = result.outputLimited ? "output_limit" : (!parsed.ok ? parsed.code : null);
    const initialValidationErrors = parsed.ok ? [] : parsed.errors;
    const initialAttemptNumber = job.attempts * 2 - 1;
    await pool.query(
      `INSERT INTO generation_attempts (owner_user_id, generation_job_id, attempt_number, recovery_kind, request_metadata,
         response_metadata, provider_response_id, finish_reason, raw_output, validation_errors, completed_at)
       VALUES ($1,$2,$3,'initial',$4,$5,$6,$7,$8,$9,now())
       ON CONFLICT (generation_job_id, attempt_number) DO UPDATE SET response_metadata = EXCLUDED.response_metadata,
         provider_response_id = EXCLUDED.provider_response_id, finish_reason = EXCLUDED.finish_reason,
         raw_output = EXCLUDED.raw_output, validation_errors = EXCLUDED.validation_errors, completed_at = now()`,
      [job.owner_user_id, job.id, initialAttemptNumber, json({ model: provider.model, providerType: provider.providerType, contextFingerprint, contextDiagnostics }),
        json({ usage: result.usage, outputLimited: result.outputLimited, modelInstanceId: result.modelInstanceId }), result.responseId || null,
        result.finishReason || null, result.content || null, json(initialValidationErrors)]
    );
    if (firstReason) {
      const recoveryKind = firstReason === "mechanics_leak" ? "mechanics_cleanup" : firstReason === "output_limit" ? "compact_completion" : "schema_repair";
      const rejectedResponse = result.content;
      result = await callCampaignTextProvider(pool, provider, job, "story_recovery", {
        ...baseRequest,
        ...(provider.providerType === "lmstudio" && result.responseId && firstReason !== "mechanics_leak" ? { previousResponseId: result.responseId } : {}),
        recoveryInput: recoveryInstruction(firstReason, initialValidationErrors, storyLength),
        rejectedResponse
      });
      parsed = parseStoryOutput(result.content, storyMemoryDefaults);
      await pool.query(
        `INSERT INTO generation_attempts (owner_user_id, generation_job_id, attempt_number, recovery_kind, request_metadata,
           response_metadata, provider_response_id, finish_reason, raw_output, validation_errors, completed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now())`,
        [job.owner_user_id, job.id, initialAttemptNumber + 1, recoveryKind, json({ model: provider.model, providerType: provider.providerType,
          previousResponseIdUsed: provider.providerType === "lmstudio" && firstReason !== "mechanics_leak", rejectedResponseIncluded: Boolean(rejectedResponse) }),
          json({ usage: result.usage, outputLimited: result.outputLimited, modelInstanceId: result.modelInstanceId }), result.responseId || null,
          result.finishReason || null, result.content || null, json(parsed.ok ? [] : parsed.errors)]
      );
    }
    const validationFailure = "code" in parsed ? parsed : null;
    if (result.outputLimited || validationFailure) {
      const code = result.outputLimited ? "output_limit" : validationFailure?.code || "invalid_schema";
      const messages = result.outputLimited ? ["The provider stopped before a complete story object was available."] : validationFailure?.errors || ["Story validation failed."];
      const recoverable = await pool.query(
        `UPDATE generation_jobs SET status = 'recoverable', provider_response_id = $3, provider_finish_reason = $4,
           partial_output = $5, error_code = $6, error_message = $7, recovery_metadata = recovery_metadata || $8::jsonb,
           lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
         WHERE id = $1 AND owner_user_id = $2 AND lease_owner = $9
         RETURNING id`,
        [job.id, job.owner_user_id, result.responseId || null, result.finishReason || null, result.content || null, code,
          messages.join(" ").slice(0, 4000), json({ retryable: true, attemptCount: firstReason ? 2 : 1 }), workerId]
      );
      if (!recoverable.rows[0]) throw Object.assign(new Error("Generation lease was lost before recovery state could be saved."), { code: "lease_lost" });
      return true;
    }
    if (!parsed.ok) throw new Error("Story validation invariant failed.");
    if (mechanicsLeakFields(parsed.story).length) throw new Error("Mechanics validation invariant failed.");
    if (job.resolved_input_mode === "scene") {
      let coverage;
      try {
        const coverageResponse = await callCampaignTextProvider(pool, provider, job, "scene_coverage_validation", {
          systemPrompt: SCENE_COVERAGE_SYSTEM_PROMPT,
          input: buildSceneCoveragePrompt(safeAction, parsed.story.narration)
        });
        coverage = coverageResponse.outputLimited ? null : parseSceneCoverageOutput(coverageResponse.content);
      } catch {
        coverage = null;
      }
      if (!coverage?.covered) {
        const rejectedResponse = result.content;
        result = await callCampaignTextProvider(pool, provider, job, "scene_coverage_rewrite", {
          ...baseRequest,
          recoveryInput: sceneCoverageRewriteInstruction(coverage?.missing_required_beats || ["Coverage could not be verified."], coverage?.contradictions || []),
          rejectedResponse
        });
        parsed = parseStoryOutput(result.content, storyMemoryDefaults);
        let repairedCoverage = null;
        if (parsed.ok && !result.outputLimited) {
          try {
            const coverageResponse = await callCampaignTextProvider(pool, provider, job, "scene_coverage_validation", {
              systemPrompt: SCENE_COVERAGE_SYSTEM_PROMPT,
              input: buildSceneCoveragePrompt(safeAction, parsed.story.narration)
            });
            repairedCoverage = coverageResponse.outputLimited ? null : parseSceneCoverageOutput(coverageResponse.content);
          } catch {
            repairedCoverage = null;
          }
        }
        if (!parsed.ok || result.outputLimited || !repairedCoverage?.covered) {
          const details = repairedCoverage
            ? [...repairedCoverage.missing_required_beats, ...repairedCoverage.contradictions]
            : ["The required scene beats could not be verified after one rewrite."];
          await pool.query(
            `UPDATE generation_jobs SET status = 'recoverable', provider_response_id = $3, provider_finish_reason = $4,
               partial_output = $5, error_code = 'scene_coverage', error_message = $6,
               recovery_metadata = recovery_metadata || $7::jsonb, lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
             WHERE id = $1 AND owner_user_id = $2 AND lease_owner = $8`,
            [job.id, job.owner_user_id, result.responseId || null, result.finishReason || null, result.content || null,
              details.join(" ").slice(0, 4000), json({ retryable: true, sceneCoverageRewriteAttempted: true }), workerId]
          );
          return true;
        }
      }
    }
    await pool.query(`UPDATE generation_jobs SET status = 'validating', updated_at = now() WHERE id = $1 AND lease_owner = $2`, [job.id, workerId]);
    if (orchestration.afterEvents === undefined) {
      let activated: ActivatedEvent[] = [];
      let triggerError = "";
      if (!inputs.suppressEventTriggers) {
        const triggers = inputs.eventTriggers.filter((trigger) => trigger.timing === "after");
        try {
          activated = await evaluateTriggers(pool, provider, "after", promptContext, job, triggers, parsed.story.narration);
        } catch (error) {
          triggerError = error instanceof Error ? error.message : String(error);
        }
      }
      orchestration = await persistOrchestration(pool, job, {
        afterEvents: activated,
        ...(triggerError ? { afterTriggerError: triggerError.slice(0, 2000) } : {})
      }, workerId);
    }
    const immediateEvents = (orchestration.afterEvents || []).filter((event) => event.addTextAfter);
    if (immediateEvents.length && !orchestration.extension && !orchestration.extensionError) {
      try {
        const guidance = fictionGuidanceForEvents(immediateEvents);
        if (!guidance.length) throw new Error("Activated extension instructions were not safe for a fiction prompt.");
        const extensionResponse = await callCampaignTextProvider(pool, provider, job, "event_extension", {
          systemPrompt: EVENT_EXTENSION_SYSTEM_PROMPT,
          input: buildEventExtensionPrompt(parsed.story.narration, guidance)
        });
        if (extensionResponse.outputLimited) throw new Error("The optional event extension reached its output limit.");
        const extension = parseEventExtension(extensionResponse.content);
        orchestration = await persistOrchestration(pool, job, {
          extension: {
            additionalText: extension.additional_text,
            ...(extension.scratchpad !== undefined ? { scratchpad: extension.scratchpad } : {}),
            trackerUpdates: extension.tracker_updates
          }
        }, workerId);
      } catch (error) {
        orchestration = await persistOrchestration(pool, job, { extensionError: (error instanceof Error ? error.message : String(error)).slice(0, 2000) }, workerId);
      }
    }
    const committedStory: StoryTurnOutput = orchestration.extension ? {
      ...parsed.story,
      narration: formatNarrationParagraphs(`${parsed.story.narration}\n\n${orchestration.extension.additionalText}`),
      scratchpad: orchestration.extension.scratchpad ?? parsed.story.scratchpad,
      tracker_updates: [...parsed.story.tracker_updates, ...orchestration.extension.trackerUpdates]
    } : parsed.story;
    if (mechanicsLeakFields(committedStory).length) throw new Error("Mechanics validation invariant failed after event extension.");
    await pool.query(`UPDATE generation_jobs SET status = 'committing', updated_at = now() WHERE id = $1 AND lease_owner = $2`, [job.id, workerId]);
    await withTransaction(pool, (client) => commitStory(client, job, committedStory, provider, result, contextFingerprint,
      contextDiagnostics, inputs, orchestration, safeAction, workerId));
  } catch (error) {
    const transportError = providerTransportErrorDetails(error);
    const code = transportError
      ? (transportError.timedOut ? "provider_request_timeout" : "provider_transport_error")
      : typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : "generation_failed";
    await pool.query(
      `UPDATE generation_jobs SET status = 'failed', error_code = $3, error_message = $4,
         recovery_metadata = recovery_metadata || $5::jsonb,
         lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
       WHERE id = $1 AND owner_user_id = $2 AND status <> 'completed' AND lease_owner = $6`,
      [job.id, job.owner_user_id, code, (error instanceof Error ? error.message : String(error)).slice(0, 4000),
        json(transportError ? { transportError } : {}), workerId]
    );
  } finally {
    clearInterval(heartbeat);
  }
  return true;
}
