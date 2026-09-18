import {
  projectSafeGenerationDiagnostic,
  generationReviewDetailSchema,
  generationReviewSummarySchema,
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

export type GenerationDiagnosticPresentation = GenerationRecoveryGuidance & Readonly<{
  details: readonly string[];
}>;

export type GenerationReviewPresentation =
  | Readonly<{
      state: "review";
      message: string;
      canKeep: boolean;
      canRetry: boolean;
      keepDescription: string;
      retryDescription: string;
      retryFailure: string | null;
    }>
  | Readonly<{
      state: "unsupported";
      message: string;
      canKeep: false;
      canRetry: false;
      keepDescription: string;
      retryDescription: string;
      retryFailure: null;
    }>;

const recoveryGuidanceByAction: Readonly<Record<SafeGenerationDiagnostic["action"], GenerationRecoveryGuidance>> = {
  adjust_context: { message: "Review the campaign context settings, then retry the generation.", retryable: true },
  adjust_output_or_state: { message: "Review the current campaign state or output settings, then retry the generation.", retryable: true },
  check_provider_window: { message: "Review the selected provider context window, then retry the generation.", retryable: true },
  repair_authority: { message: "Discard this attempt, correct the campaign state or character profile, then generate a new turn. Your draft can be reused.", retryable: false },
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

/**
 * Presents review actions solely from the server's review authority. Legacy
 * diagnostics remain explanatory and must not remove a server-offered Keep.
 */
export function generationReviewPresentation(review: unknown, _diagnostic?: unknown, detail?: unknown): GenerationReviewPresentation {
  const summary = generationReviewSummarySchema.safeParse(review);
  if (!summary.success) {
    return {
      state: "unsupported",
      message: "This generation review needs a newer client before a decision can be made.",
      canKeep: false,
      canRetry: false,
      keepDescription: "Keep is unavailable until the saved review can be verified.",
      retryDescription: "Reload the generation status for safe recovery guidance.",
      retryFailure: null
    };
  }
  const parsedDetail = generationReviewDetailSchema.safeParse(detail);
  const matchesDetail = parsedDetail.success
    && parsedDetail.data.reviewId === summary.data.reviewId
    && parsedDetail.data.revision === summary.data.revision;
  const fallbackMessage = summary.data.reasons.includes("invalid_structure")
    ? "The candidate does not meet the required story structure."
    : "This turn needs your review.";
  return {
    state: "review",
    message: fallbackMessage,
    canKeep: summary.data.canKeep,
    canRetry: summary.data.canRetry,
    keepDescription: summary.data.candidateScope === "main"
      ? "Keep this text and finish the turn; normal event content may still be added."
      : "Keep this saved turn exactly as reviewed.",
    retryDescription: matchesDetail ? parsedDetail.data.retryDescription : "Retry this generation stage.",
    retryFailure: matchesDetail ? parsedDetail.data.retryFailure : null
  };
}

/**
 * Presents only the allowlisted diagnostic projection. The detail strings are
 * deliberately derived from fixed labels and numeric counts, never persisted
 * prompt text, source IDs, excerpts, or provider errors.
 */
export function generationDiagnosticPresentation(value: unknown): GenerationDiagnosticPresentation {
  const diagnostic = projectSafeGenerationDiagnostic(value);
  if (!diagnostic) return {
    message: "Generation needs attention. Reload its status before choosing a recovery action.",
    retryable: false,
    details: []
  };
  const guidance = recoveryGuidanceByAction[diagnostic.action];
  const details: string[] = [];
  if (diagnostic.code === "context_evidence_omitted") {
    details.push("Some optional story evidence was omitted to fit the current context.");
  }
  if (diagnostic.protocolIdentity) details.push(`Prompt protocol: ${diagnostic.protocolIdentity}.`);
  if (diagnostic.policyIdentity) details.push(`Story Memory policy: ${diagnostic.policyIdentity}.`);
  if (diagnostic.queryVariantCount !== undefined) details.push(`Context queries: ${diagnostic.queryVariantCount}.`);
  const counts = diagnostic.counts;
  if (counts?.recentTurnsTarget !== undefined && counts.recentTurnsIncluded !== undefined) {
    details.push(`Recent turns: ${counts.recentTurnsIncluded} of ${counts.recentTurnsTarget} included.`);
  }
  if (counts?.optionalEvidenceOmitted) details.push(`Optional evidence: ${counts.optionalEvidenceOmitted} omitted.`);
  if (counts?.worldReferencesIncluded !== undefined || counts?.worldReferencesOmitted !== undefined) {
    details.push(`World references: ${counts.worldReferencesIncluded ?? 0} included, ${counts.worldReferencesOmitted ?? 0} omitted.`);
  }
  if (counts?.excerptsComplete !== undefined || counts?.excerptsPartial !== undefined) {
    details.push(`Historical excerpts: ${counts.excerptsComplete ?? 0} complete, ${counts.excerptsPartial ?? 0} limited.`);
  }
  if (counts?.sourceValidationFailures) details.push(`Source validation: ${counts.sourceValidationFailures} issue${counts.sourceValidationFailures === 1 ? "" : "s"}.`);
  if (counts?.duplicateSources) details.push(`Duplicate sources omitted: ${counts.duplicateSources}.`);
  if (diagnostic.reasonCodes?.length) details.push(`Context limits: ${diagnostic.reasonCodes.join(", ")}.`);
  if (diagnostic.protectedComponents) {
    const labels: Readonly<Record<keyof typeof diagnostic.protectedComponents, string>> = {
      rules: "rules", world_canon: "world canon", character_profile: "character profile",
      current_state: "current state", current_scene: "current scene", direction: "direction"
    };
    const estimates = (Object.entries(diagnostic.protectedComponents) as Array<[keyof typeof diagnostic.protectedComponents, number | undefined]>)
      .filter((entry): entry is [keyof typeof diagnostic.protectedComponents, number] => entry[1] !== undefined)
      .map(([key, value]) => `${labels[key]} ${value}`);
    if (estimates.length) details.push(`Protected context estimates: ${estimates.join(", ")}.`);
  }
  if (diagnostic.review) {
    const reviewDetail = diagnostic.review.status === "passed"
      ? "Continuity review passed for the supplied scope only."
      : diagnostic.review.status === "observed"
        ? "Continuity review was observed; it did not block this generation."
        : diagnostic.review.status === "off"
          ? "Continuity review was off."
          : diagnostic.review.status === "conflict"
            ? "Continuity review found a conflict in the supplied scope."
            : diagnostic.review.status === "uncertain"
              ? "Continuity review is uncertain; it was not a full-history pass."
              : "Continuity review was unavailable; no pass was recorded.";
    details.push(reviewDetail);
    if (diagnostic.review.automaticRepair === "consumed") details.push("The one automatic repair attempt was already used.");
    if (diagnostic.review.automaticRepair === "unavailable") details.push("Automatic repair was unavailable for this generation.");
  }
  return {
    message: diagnostic.code === "context_evidence_omitted"
      ? "Some optional story evidence was omitted to fit the current context."
      : guidance.message,
    retryable: guidance.retryable,
    details
  };
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
        ...(snapshot.diagnostic === undefined ? {} : { diagnostic: snapshot.diagnostic }),
        ...(snapshot.review === undefined ? {} : { review: snapshot.review })
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
        ...(snapshot.diagnostic === undefined ? {} : { diagnostic: snapshot.diagnostic }),
        ...(snapshot.review === undefined ? {} : { review: snapshot.review })
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
