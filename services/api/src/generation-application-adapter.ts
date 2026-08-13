import type {
  GenerationRequest,
  GenerationRetryLatestRequest
} from "../../../packages/contracts/src/generation.js";
import type { GenerationResult } from "../../../packages/contracts/src/client-api.js";
import {
  GenerationApplicationError,
  type EnqueueGenerationResult,
  type GenerationApplication,
  type GenerationJob,
  type GenerationMutationResult,
  type OwnerScope
} from "../../../packages/application/src/index.js";

export type GenerationHttpError = Error & {
  statusCode: number;
  details?: unknown;
};

export type GenerationApplicationAdapter = Readonly<{
  enqueueGeneration(ownerScope: OwnerScope, campaignId: string, request: GenerationRequest): Promise<EnqueueGenerationResult>;
  enqueueLatestReplacement(ownerScope: OwnerScope, campaignId: string, request: GenerationRetryLatestRequest): Promise<EnqueueGenerationResult>;
  getGenerationJob(ownerScope: OwnerScope, jobId: string): Promise<GenerationJob>;
  getGenerationResult(ownerScope: OwnerScope, jobId: string): Promise<GenerationResult>;
  retryGeneration(ownerScope: OwnerScope, jobId: string): Promise<GenerationMutationResult>;
  cancelGeneration(ownerScope: OwnerScope, jobId: string): Promise<GenerationMutationResult>;
  discardGeneration(ownerScope: OwnerScope, jobId: string): Promise<GenerationMutationResult>;
}>;

function generationHttpError(message: string, statusCode: number, details?: unknown): GenerationHttpError {
  return Object.assign(new Error(message), {
    statusCode,
    ...(details === undefined ? {} : { details })
  });
}

export function mapGenerationApplicationError(error: GenerationApplicationError): GenerationHttpError {
  const details = error.details;
  switch (details.reason) {
    case "idempotency_mismatch":
      return generationHttpError("The idempotency key was already used for a different generation request.", 409);
    case "action_only_mode":
      return generationHttpError("This campaign accepts player actions only.", 400);
    case "explicit_input_mode_mismatch":
      return generationHttpError("Explicit turn input mode does not match the resolved mode.", 400);
    case "classification_id_forbidden":
      return generationHttpError("Classification IDs are valid only for Auto input.", 400);
    case "classification_missing_or_expired":
      return error.kind === "conflict"
        ? generationHttpError("The Auto classification is missing, expired, consumed, or does not match this input.", 409)
        : generationHttpError("Auto input requires a current classification.", 400);
    case "classification_mode_mismatch":
      return generationHttpError("The submitted turn mode does not match the Auto classification.", 409);
    case "selected_provider_unavailable":
      return generationHttpError("Enabled text provider profile not found.", 400);
    case "no_text_provider":
      return generationHttpError("Select a text provider for this campaign or mark a default text provider.", 409);
    case "stale_current_turn":
      return generationHttpError(`Campaign is at turn ${details.actualTurnNumber}, not ${details.expectedTurnNumber}.`, 409);
    case "missing_latest_turn":
      return generationHttpError("The latest accepted turn was not found.", 404);
    case "active_generation":
      return generationHttpError("This campaign already has an active story generation.", 409, {
        code: "active_generation_exists",
        pendingGeneration: details.pendingGeneration ?? null
      });
    case "active_illustration":
      return generationHttpError("Wait for the latest turn illustration to finish before retrying the turn.", 409);
    case "result_not_completed":
      return generationHttpError(
        ["failed", "recoverable", "cancelled", "discarded"].includes(details.generationStatus ?? "")
          ? "Generation could not be completed."
          : `Generation is ${details.generationStatus}.`,
        409
      );
    case "retry_source_state":
      return generationHttpError("Only recoverable or failed generation jobs can be retried.", 409);
    case "cancel_source_state":
      return generationHttpError("Only active generation jobs can be cancelled.", 409);
    case "discard_source_state":
      return generationHttpError("Only recoverable or failed generation jobs can be discarded.", 409);
    default:
      if (error.kind === "not_found") {
        return generationHttpError(details.campaignId ? "Campaign not found." : "Generation job not found.", 404);
      }
      return generationHttpError("Generation command could not be completed.", 409);
  }
}

async function mapApplicationErrors<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof GenerationApplicationError) throw mapGenerationApplicationError(error);
    throw error;
  }
}

export function createGenerationApplicationAdapter(application: GenerationApplication): GenerationApplicationAdapter {
  return {
    enqueueGeneration: (ownerScope, campaignId, request) => mapApplicationErrors(() =>
      application.enqueueAppend({ ownerUserId: ownerScope.ownerUserId, campaignId }, request)
    ),
    enqueueLatestReplacement: (ownerScope, campaignId, request) => mapApplicationErrors(() =>
      application.enqueueReplacement({ ownerUserId: ownerScope.ownerUserId, campaignId }, request)
    ),
    getGenerationJob: (ownerScope, jobId) => mapApplicationErrors(() =>
      application.getJob({ ownerUserId: ownerScope.ownerUserId, jobId })
    ),
    getGenerationResult: (ownerScope, jobId) => mapApplicationErrors(() =>
      application.getResult({ ownerUserId: ownerScope.ownerUserId, jobId })
    ),
    retryGeneration: (ownerScope, jobId) => mapApplicationErrors(() =>
      application.retry({ ownerUserId: ownerScope.ownerUserId, jobId })
    ),
    cancelGeneration: (ownerScope, jobId) => mapApplicationErrors(() =>
      application.cancel({ ownerUserId: ownerScope.ownerUserId, jobId })
    ),
    discardGeneration: (ownerScope, jobId) => mapApplicationErrors(() =>
      application.discard({ ownerUserId: ownerScope.ownerUserId, jobId })
    )
  };
}
