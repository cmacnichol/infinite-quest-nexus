import type {
  GenerationRequest,
  GenerationRetryLatestRequest
} from "../../../packages/contracts/src/generation.js";
import {
  GenerationApplicationError,
  type GenerationCommandRepository,
  type GenerationMutationResult
} from "../../../packages/application/src/index.js";
import type { DatabasePool } from "../../../packages/database/src/pool.js";
import { logger } from "../../../packages/logger/src/index.js";
import { mechanicsLanguageMatches } from "../../../packages/story-engine/src/index.js";

type LegacyGenerationError = Error & {
  statusCode: number;
  code?: string;
  details?: unknown;
};

type GenerationLifecycleLogContext = Readonly<{
  generationJobId: string;
  campaignId: string;
  providerProfileId: string;
  expectedTurnNumber: number;
  operationKind: "append" | "replace_latest";
  jobAttempt: number;
}>;

export type GenerationCommandCompatibilityDependencies = Readonly<{
  pool: DatabasePool;
  repository: GenerationCommandRepository;
  initialOwnerId: (pool: DatabasePool) => Promise<string>;
}>;

function legacyError(message: string, statusCode: number, details?: unknown): LegacyGenerationError {
  return Object.assign(new Error(message), {
    statusCode,
    ...(details === undefined ? {} : { details })
  });
}

function publicMutationResult(result: GenerationMutationResult): GenerationMutationResult {
  return result.operationKind === "append"
    ? { id: result.id, status: result.status, operationKind: "append", replacementTurnId: null }
    : {
      id: result.id,
      status: result.status,
      operationKind: "replace_latest",
      replacementTurnId: result.replacementTurnId
    };
}

async function generationLifecycleLogContext(
  pool: DatabasePool,
  ownerUserId: string,
  generationJobId: string
): Promise<GenerationLifecycleLogContext | null> {
  const result = await pool.query<GenerationLifecycleLogContext>(
    `SELECT id AS "generationJobId", campaign_id AS "campaignId", provider_profile_id AS "providerProfileId",
            expected_turn_number AS "expectedTurnNumber", operation_kind AS "operationKind", attempts AS "jobAttempt"
       FROM generation_jobs WHERE id = $1 AND owner_user_id = $2`,
    [generationJobId, ownerUserId]
  );
  return result.rows[0] || null;
}

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

export function mapGenerationApplicationError(error: GenerationApplicationError): LegacyGenerationError {
  const details = error.details;
  switch (details.reason) {
    case "idempotency_mismatch":
      return legacyError("The idempotency key was already used for a different generation request.", 409);
    case "action_only_mode":
      return legacyError("This campaign accepts player actions only.", 400);
    case "explicit_input_mode_mismatch":
      return legacyError("Explicit turn input mode does not match the resolved mode.", 400);
    case "classification_id_forbidden":
      return legacyError("Classification IDs are valid only for Auto input.", 400);
    case "classification_missing_or_expired":
      return error.kind === "conflict"
        ? legacyError("The Auto classification is missing, expired, consumed, or does not match this input.", 409)
        : legacyError("Auto input requires a current classification.", 400);
    case "classification_mode_mismatch":
      return legacyError("The submitted turn mode does not match the Auto classification.", 409);
    case "selected_provider_unavailable":
      return legacyError("Enabled text provider profile not found.", 400);
    case "no_text_provider":
      return legacyError("Select a text provider for this campaign or mark a default text provider.", 409);
    case "stale_current_turn":
      return legacyError(`Campaign is at turn ${details.actualTurnNumber}, not ${details.expectedTurnNumber}.`, 409);
    case "missing_latest_turn":
      return legacyError("The latest accepted turn was not found.", 404);
    case "active_generation":
      return legacyError("This campaign already has an active story generation.", 409, {
        code: "active_generation_exists",
        pendingGeneration: details.pendingGeneration ?? null
      });
    case "active_illustration":
      return legacyError("Wait for the latest turn illustration to finish before retrying the turn.", 409);
    case "result_not_completed":
      return legacyError(
        ["failed", "recoverable", "cancelled", "discarded"].includes(details.generationStatus ?? "")
          ? "Generation could not be completed."
          : `Generation is ${details.generationStatus}.`,
        409
      );
    case "retry_source_state":
      return legacyError("Only recoverable or failed generation jobs can be retried.", 409);
    case "cancel_source_state":
      return legacyError("Only active generation jobs can be cancelled.", 409);
    case "discard_source_state":
      return legacyError("Only recoverable or failed generation jobs can be discarded.", 409);
    default:
      if (error.kind === "not_found") {
        return legacyError(details.campaignId ? "Campaign not found." : "Generation job not found.", 404);
      }
      return legacyError("Generation command could not be completed.", 409);
  }
}

export function createGenerationCommandCompatibility({
  pool,
  repository,
  initialOwnerId
}: GenerationCommandCompatibilityDependencies) {
  async function withOwner<T>(work: (ownerUserId: string) => Promise<T>): Promise<T> {
    try {
      return await work(await initialOwnerId(pool));
    } catch (error) {
      if (error instanceof GenerationApplicationError) throw mapGenerationApplicationError(error);
      throw error;
    }
  }

  return {
    enqueueGeneration: async (campaignId: string, request: GenerationRequest) => {
      safeTurnInput(request.action);
      return withOwner((ownerUserId) => repository.enqueueAppend({ ownerUserId, campaignId }, request));
    },
    enqueueLatestReplacement: async (campaignId: string, request: GenerationRetryLatestRequest) => {
      safeTurnInput(request.action);
      return withOwner((ownerUserId) => repository.enqueueReplacement({ ownerUserId, campaignId }, request));
    },
    getGenerationJob: (jobId: string) => withOwner((ownerUserId) => repository.getJob({ ownerUserId, jobId })),
    getGenerationResult: (jobId: string) => withOwner((ownerUserId) => repository.getResult({ ownerUserId, jobId })),
    retryGeneration: async (jobId: string) => {
      return withOwner(async (ownerUserId) => {
        const context = await generationLifecycleLogContext(pool, ownerUserId, jobId);
        const requeued = await repository.retry({ ownerUserId, jobId });
        if (context) logger.info({
          event: "turn_generation_requeued",
          ...context
        });
        return publicMutationResult(requeued);
      });
    },
    cancelGeneration: async (jobId: string) => {
      return withOwner(async (ownerUserId) => {
        const context = await generationLifecycleLogContext(pool, ownerUserId, jobId);
        const cancelled = await repository.cancel({ ownerUserId, jobId });
        if (context) logger.info({
          event: "turn_generation_cancelled",
          generationJobId: context.generationJobId,
          campaignId: context.campaignId,
          operationKind: context.operationKind
        });
        return publicMutationResult(cancelled);
      });
    },
    discardGeneration: (jobId: string) => withOwner((ownerUserId) => repository.discard({ ownerUserId, jobId }))
  };
}
