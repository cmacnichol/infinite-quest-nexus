import type { GenerationStreamSnapshot } from "@infinite-quest/contracts";
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
    && left.resultTurnId === right.resultTurnId;
}

export interface GenerationMachine {
  observe(snapshot: GenerationStreamSnapshot): GenerationMachineObservation;
  acknowledgeRetry(): void;
  acknowledgeDiscard(): void;
  acknowledgeCancel(): void;
}

export function createGenerationMachine(): GenerationMachine {
  let highWater: GenerationStreamSnapshot | null = null;
  let retryAcknowledged = false;
  let terminalTransition: "discarded" | "cancelled" | null = null;

  return {
    observe(snapshot) {
      if (!highWater) {
        highWater = snapshot;
        return accepted(snapshot, snapshot.partialNarration != null);
      }

      const currentRank = statusRanks[highWater.status];
      const nextRank = statusRanks[snapshot.status];
      const isRetryQueue = retryAcknowledged
        && (highWater.status === "recoverable" || highWater.status === "failed")
        && snapshot.attempts === highWater.attempts
        && (snapshot.status === "queued" || snapshot.status === "replacement_queued");
      const isAcknowledgedTerminalTransition = terminalTransition === snapshot.status
        && highWater.attempts === snapshot.attempts
        && terminalStatuses.has(highWater.status)
        && terminalStatuses.has(snapshot.status);

      if (isRetryQueue) {
        retryAcknowledged = false;
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
  };
}
