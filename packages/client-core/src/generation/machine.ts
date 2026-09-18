import { generationReviewSummarySchema, type GenerationReviewSummary, type GenerationStreamSnapshot } from "@infinite-quest/contracts";
import { GenerationWorkflowProtocolError } from "./types.js";

type GenerationStatus = GenerationStreamSnapshot["status"];

export type GenerationMachineObservation =
  | { kind: "accepted"; snapshot: GenerationStreamSnapshot; narrationChanged: boolean; terminal: boolean }
  | { kind: "duplicate" }
  | { kind: "stale" };

const terminalStatuses = new Set<GenerationStatus>(["completed", "failed", "discarded", "cancelled", "recoverable"]);
const statusRanks: Record<GenerationStatus, number> = {
  queued: 0,
  replacement_queued: 0,
  assessing: 1,
  generating: 2,
  validating: 3,
  committing: 4,
  completed: 5,
  failed: 5,
  discarded: 5,
  cancelled: 5,
  recoverable: 5
};

function isSameSnapshot(left: GenerationStreamSnapshot, right: GenerationStreamSnapshot): boolean {
  return left.id === right.id
    && left.campaignId === right.campaignId
    && left.expectedTurnNumber === right.expectedTurnNumber
    && left.status === right.status
    && left.action === right.action
    && left.operationKind === right.operationKind
    && left.replacementTurnId === right.replacementTurnId
    && left.attempts === right.attempts
    && left.partialNarration === right.partialNarration
    && left.errorCode === right.errorCode
    && left.errorMessage === right.errorMessage
    && left.resultTurnId === right.resultTurnId
    && isSameReview(supportedReview(left.review), supportedReview(right.review))
    && isSameResponseFormat(left.responseFormat, right.responseFormat);
}

/** Compares the fixed browser-safe response-format projection without reading private job metadata. */
function isSameResponseFormat(
  left: GenerationStreamSnapshot["responseFormat"],
  right: GenerationStreamSnapshot["responseFormat"]
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.version === right.version
    && left.savedPolicy === right.savedPolicy
    && left.effectiveMode === right.effectiveMode
    && left.schemaVersion === right.schemaVersion
    && left.schemaHash === right.schemaHash
    && left.operation === right.operation
    && left.streaming === right.streaming
    && left.requestedModel === right.requestedModel
    && left.returnedModel === right.returnedModel
    && left.returnedRoute === right.returnedRoute
    && left.preflight === right.preflight
    && left.preflightDiagnostic === right.preflightDiagnostic
    && left.diagnosticCode === right.diagnosticCode;
}

function isSameReview(left: GenerationReviewSummary | undefined, right: GenerationReviewSummary | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left?.version === right?.version
    && left?.reviewId === right?.reviewId
    && left?.revision === right?.revision
    && left?.state === right?.state
    && left?.stage === right?.stage
    && left?.candidateScope === right?.candidateScope
    && left?.canKeep === right?.canKeep
    && left?.canRetry === right?.canRetry
    && left.reasons.length === right.reasons.length
    && left.reasons.every((reason, index) => reason === right.reasons[index]);
}

function supportedReview(value: GenerationStreamSnapshot["review"]): GenerationReviewSummary | undefined {
  const parsed = generationReviewSummarySchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function isOlderReview(current: GenerationReviewSummary | undefined, next: GenerationReviewSummary | undefined): boolean {
  if (!current || !next) return false;
  if (next.revision < current.revision) return true;
  if (next.revision > current.revision) return false;
  if (next.reviewId !== current.reviewId) return true;
  return current.state === "decided" && next.state === "pending";
}

export interface GenerationMachine {
  observe(snapshot: GenerationStreamSnapshot): GenerationMachineObservation;
  acknowledgeRetry(): void;
  acknowledgeReviewDecision(reviewId: string, revision: number): void;
  acknowledgeDiscard(): void;
  acknowledgeCancel(): void;
}

export function createGenerationMachine(): GenerationMachine {
  let highWater: GenerationStreamSnapshot | null = null;
  let retryAcknowledged = false;
  let reviewDecisionAcknowledged: { reviewId: string; revision: number } | null = null;
  let terminalTransition: "discarded" | "cancelled" | null = null;

  return {
    observe(snapshot) {
      if (!highWater) {
        highWater = snapshot;
        return accepted(snapshot, snapshot.partialNarration != null);
      }

      const currentRank = statusRanks[highWater.status];
      const nextRank = statusRanks[snapshot.status];
      const currentReview = supportedReview(highWater.review);
      const nextReview = supportedReview(snapshot.review);
      if (isOlderReview(currentReview, nextReview)) return { kind: "stale" };
      const isRetryQueue = retryAcknowledged
        && (highWater.status === "recoverable" || highWater.status === "failed")
        && snapshot.attempts === highWater.attempts
        && (snapshot.status === "queued" || snapshot.status === "replacement_queued");
      const isAcknowledgedReviewQueue = reviewDecisionAcknowledged !== null
        && currentReview !== undefined
        && reviewDecisionAcknowledged.reviewId === currentReview.reviewId
        && reviewDecisionAcknowledged.revision === currentReview.revision;
      const isReviewQueue = highWater.status === "recoverable"
        && highWater.attempts === snapshot.attempts
        && (snapshot.status === "queued" || snapshot.status === "replacement_queued")
        && (isAcknowledgedReviewQueue || currentReview?.state === "decided"
          || (currentReview !== undefined && nextReview !== undefined
            && nextReview.revision > currentReview.revision && nextReview.state === "decided"));
      const isAcknowledgedTerminalTransition = terminalTransition === snapshot.status
        && highWater.attempts === snapshot.attempts
        && terminalStatuses.has(highWater.status)
        && terminalStatuses.has(snapshot.status);

      if (isRetryQueue || isReviewQueue) {
        retryAcknowledged = false;
        reviewDecisionAcknowledged = null;
        const narrationChanged = highWater.partialNarration !== snapshot.partialNarration;
        highWater = snapshot;
        return accepted(snapshot, narrationChanged);
      }

      if (snapshot.attempts < highWater.attempts
        || (snapshot.attempts === highWater.attempts && nextRank < currentRank)) {
        return { kind: "stale" };
      }

      if (snapshot.attempts === highWater.attempts && nextRank === currentRank) {
        if (isSameSnapshot(highWater, snapshot)) return { kind: "duplicate" };
        if (terminalStatuses.has(highWater.status)
          && terminalStatuses.has(snapshot.status)
          && highWater.status !== snapshot.status
          && !isAcknowledgedTerminalTransition) {
          throw new GenerationWorkflowProtocolError("invalid_snapshot");
        }
        const narrationChanged = highWater.partialNarration !== snapshot.partialNarration;
        highWater = snapshot;
        terminalTransition = null;
        return accepted(snapshot, narrationChanged);
      }

      const narrationChanged = highWater.partialNarration !== snapshot.partialNarration;
      highWater = snapshot;
      terminalTransition = null;
      return accepted(snapshot, narrationChanged);
    },
    acknowledgeRetry() {
      retryAcknowledged = true;
    },
    acknowledgeReviewDecision(reviewId, revision) {
      reviewDecisionAcknowledged = { reviewId, revision };
    },
    acknowledgeDiscard() {
      terminalTransition = "discarded";
    },
    acknowledgeCancel() {
      terminalTransition = "cancelled";
    }
  };
}

function accepted(snapshot: GenerationStreamSnapshot, narrationChanged: boolean): GenerationMachineObservation {
  return {
    kind: "accepted",
    snapshot,
    narrationChanged,
    terminal: terminalStatuses.has(snapshot.status)
      && !(snapshot.status === "recoverable" && snapshot.review !== undefined)
  };
}
