import type { GenerationResult, GenerationStreamSnapshot, TurnSummary } from "@infinite-quest/contracts";
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
        errorMessage: snapshot.errorMessage
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
        errorMessage: snapshot.errorMessage
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
