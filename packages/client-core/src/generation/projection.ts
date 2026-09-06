import {
  projectSafeGenerationDiagnostic,
  type GenerationResult,
  type GenerationStreamSnapshot,
  type SafeGenerationDiagnostic,
  type TurnSummary
} from "@infinite-quest/contracts";
import { ApiContractError, NexusApiError } from "../errors.js";

export type GenerationOperation =
  | { readonly operationKind: "append"; readonly replacementTurnId: null }
  | { readonly operationKind: "replace_latest"; readonly replacementTurnId: string };

export interface SafeUnavailableError {
  readonly message: string;
  readonly correlationId: string | null;
}

export const GENERIC_FAILURE_MESSAGE = "Generation could not complete.";
export const GENERIC_UNAVAILABLE_MESSAGE = "Accepted result is temporarily unavailable. Try loading it again.";

export type GenerationRecoveryGuidance = Readonly<{
  message: string;
  retryable: boolean;
}>;

const recoveryGuidanceByAction: Readonly<Record<SafeGenerationDiagnostic["action"], GenerationRecoveryGuidance>> = {
  adjust_context: { message: "Review the campaign context settings, then retry the generation.", retryable: true },
  adjust_output_or_state: { message: "Review the current campaign state or output settings, then retry the generation.", retryable: true },
  check_provider_window: { message: "Review the selected provider context window, then retry the generation.", retryable: true },
  repair_authority: { message: "Review the current campaign state before retrying the generation.", retryable: true },
  update_prompt: { message: "Review the active prompt override, then retry the generation.", retryable: true },
  discard_and_reenqueue: { message: "Discard this generation and submit the turn again.", retryable: false },
  retry_event: { message: "Retry the generation to re-evaluate the event.", retryable: true },
  shorten_or_replace_turn: { message: "Shorten or replace the current turn context, then retry the generation.", retryable: true }
};

/** Converts only a validated public diagnostic into a legacy-player recovery instruction. */
export function generationRecoveryGuidance(value: unknown): GenerationRecoveryGuidance | null {
  const diagnostic = projectSafeGenerationDiagnostic(value);
  return diagnostic ? recoveryGuidanceByAction[diagnostic.action] : null;
}

export function copyOperation(value: GenerationOperation): GenerationOperation {
  return value.operationKind === "append"
    ? { operationKind: "append", replacementTurnId: null }
    : { operationKind: "replace_latest", replacementTurnId: value.replacementTurnId };
}

export function copySnapshot(snapshot: GenerationStreamSnapshot): GenerationStreamSnapshot {
  return snapshot.operationKind === "append"
    ? {
        id: snapshot.id,
        campaignId: snapshot.campaignId,
        expectedTurnNumber: snapshot.expectedTurnNumber,
        status: snapshot.status,
        action: snapshot.action,
        operationKind: "append",
        replacementTurnId: null,
        attempts: snapshot.attempts,
        partialNarration: snapshot.partialNarration,
        resultTurnId: snapshot.resultTurnId,
        errorCode: snapshot.errorCode,
        errorMessage: snapshot.errorMessage,
        ...(snapshot.diagnostic === undefined ? {} : { diagnostic: snapshot.diagnostic })
      }
    : {
        id: snapshot.id,
        campaignId: snapshot.campaignId,
        expectedTurnNumber: snapshot.expectedTurnNumber,
        status: snapshot.status,
        action: snapshot.action,
        operationKind: "replace_latest",
        replacementTurnId: snapshot.replacementTurnId,
        attempts: snapshot.attempts,
        partialNarration: snapshot.partialNarration,
        resultTurnId: snapshot.resultTurnId,
        errorCode: snapshot.errorCode,
        errorMessage: snapshot.errorMessage,
        ...(snapshot.diagnostic === undefined ? {} : { diagnostic: snapshot.diagnostic })
      };
}

export function turnFromGenerationResult(result: GenerationResult): TurnSummary {
  return {
    id: result.resultTurnId,
    turnNumber: result.turnNumber,
    action: result.action,
    inputMode: result.inputMode,
    inputModeSource: result.inputModeSource,
    narration: result.narration,
    choices: [...result.choices],
    customActionSuggestion: result.customActionSuggestion,
    imagePrompt: result.imagePrompt,
    imageUrl: null,
    acceptedAt: result.acceptedAt,
    chronicleRetrieval: copyValue(result.chronicleRetrieval),
    reportedCost: copyValue(result.reportedCost)
  };
}

export function copyStateSnapshot(snapshot: Record<string, unknown>): Record<string, unknown> {
  return copyValue(snapshot);
}

export function safeFailureMessage(error: Error): string {
  return error instanceof NexusApiError || error instanceof ApiContractError
    ? error.message
    : GENERIC_FAILURE_MESSAGE;
}

export function safeUnavailableError(error: Error): SafeUnavailableError {
  if (error instanceof NexusApiError || error instanceof ApiContractError) {
    return { message: error.message, correlationId: error.correlationId };
  }
  return { message: GENERIC_UNAVAILABLE_MESSAGE, correlationId: null };
}

function copyValue<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => copyValue(item)) as T;
  if (value !== null && typeof value === "object") {
    const copied: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) copied[key] = copyValue(item);
    return copied as T;
  }
  return value;
}
