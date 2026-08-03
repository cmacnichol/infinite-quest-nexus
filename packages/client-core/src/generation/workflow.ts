import { generationStreamSnapshotSchema, type GenerationActionResponse } from "@infinite-quest/contracts";
import { createGenerationMachine } from "./machine.js";
import { createGenerationSubmissionCoordinator } from "./submission.js";
import {
  GenerationWorkflowProtocolError,
  type GenerationEvent,
  type GenerationRun,
  type GenerationSubmissionInput,
  type GenerationWorkflow,
  type GenerationWorkflowDependencies
} from "./types.js";

type GenerationOperation =
  | Pick<Extract<import("@infinite-quest/contracts").GenerationStreamSnapshot, { operationKind: "append" }>, "operationKind" | "replacementTurnId">
  | Pick<Extract<import("@infinite-quest/contracts").GenerationStreamSnapshot, { operationKind: "replace_latest" }>, "operationKind" | "replacementTurnId">;

export function createGenerationWorkflow(dependencies: GenerationWorkflowDependencies): GenerationWorkflow {
  const submissions = createGenerationSubmissionCoordinator({
    api: dependencies.api,
    clock: dependencies.clock,
    store: dependencies.pendingSubmissions
  });

  return {
    async submit(campaignId, submission) {
      const response = await submissions.submit(campaignId, submission);
      return createRun(campaignId, response.id, response, dependencies);
    },
    async resume(campaignId) {
      const sync = await dependencies.api.syncStatus(campaignId);
      if (sync.pendingGeneration) {
        dependencies.pendingSubmissions.clear(campaignId);
        return createRun(campaignId, sync.pendingGeneration.id, sync.pendingGeneration, dependencies);
      }
      const recovery = sync.generationRecovery;
      const completedTurnAlreadyLoaded = recovery?.status === "completed"
        && recovery.resultTurnId !== null
        && sync.turns?.turns.some((turn) => turn.id === recovery.resultTurnId);
      if (completedTurnAlreadyLoaded) {
        dependencies.pendingSubmissions.clear(campaignId);
        return null;
      }
      if (recovery) {
        dependencies.pendingSubmissions.clear(campaignId);
        return createRun(campaignId, recovery.id, recovery, dependencies);
      }
      const submission = submissions.load(campaignId);
      if (!submission) return null;
      const completedReplacementAlreadyLoaded = submission.jobId !== undefined
        && submission.operationKind === "replace_latest"
        && sync.turns?.turns.some((turn) => (
          turn.turnNumber === submission.expectedTurnNumber
          && turn.id !== submission.replacementTurnId
        ));
      if (completedReplacementAlreadyLoaded) {
        dependencies.pendingSubmissions.clear(campaignId);
        return null;
      }
      if (submission.jobId) {
        if (submission.operationKind === "append") {
          return createRun(campaignId, submission.jobId, { operationKind: "append", replacementTurnId: null }, dependencies);
        }
        return createRun(campaignId, submission.jobId, {
          operationKind: "replace_latest",
          replacementTurnId: submission.replacementTurnId
        }, dependencies);
      }
      const response = await submissions.replay(campaignId, submission);
      return createRun(campaignId, response.id, response, dependencies);
    }
  };
}

function createRun(
  campaignId: string,
  jobId: string,
  operation: GenerationOperation,
  dependencies: GenerationWorkflowDependencies
): GenerationRun {
  const machine = createGenerationMachine();
  let watcherActive = false;
  let inFlightTerminalAction: {
    action: "cancel" | "discard";
    response: Promise<GenerationActionResponse>;
  } | null = null;

  async function fetchResult(): Promise<
    | Extract<GenerationEvent, { type: "settled"; outcome: "completed" }>
    | Extract<GenerationEvent, { type: "result_unavailable" }>
  > {
    try {
      const result = await dependencies.api.result(jobId);
      dependencies.pendingSubmissions.clear(campaignId);
      return { type: "settled", outcome: "completed", result };
    } catch (cause) {
      return { type: "result_unavailable", jobId, error: toError(cause) };
    }
  }

  async function performAction(
    action: "retry" | "cancel" | "discard"
  ): Promise<GenerationActionResponse> {
    const response = dependencies.api[action](jobId).then((actionResponse) => {
      const expectedStatus = action === "retry"
        ? ["queued", "replacement_queued"]
        : action === "cancel"
          ? ["cancelled"]
          : ["discarded"];
      if (actionResponse.id !== jobId
        || !expectedStatus.includes(actionResponse.status)
        || actionResponse.operationKind !== operation.operationKind
        || actionResponse.replacementTurnId !== operation.replacementTurnId) {
        throw new GenerationWorkflowProtocolError("action_response_mismatch");
      }
      if (action === "retry") machine.acknowledgeRetry();
      if (action === "cancel") machine.acknowledgeCancel();
      if (action === "discard") machine.acknowledgeDiscard();
      return actionResponse;
    });
    if (action === "cancel" || action === "discard") {
      inFlightTerminalAction = { action, response };
    }
    return response;
  }

  async function retryOrUnrecoverable(): Promise<Error | null> {
    try {
      await performAction("retry");
      return null;
    } catch (cause) {
      if (cause instanceof GenerationWorkflowProtocolError) throw cause;
      return toError(cause);
    }
  }

  async function observeSnapshot(snapshot: import("@infinite-quest/contracts").GenerationStreamSnapshot) {
    if (snapshot.operationKind !== operation.operationKind || snapshot.replacementTurnId !== operation.replacementTurnId) {
      throw new GenerationWorkflowProtocolError("invalid_snapshot");
    }
    try {
      return machine.observe(snapshot);
    } catch (cause) {
      const action = inFlightTerminalAction;
      const matchesInFlightTerminal = cause instanceof GenerationWorkflowProtocolError
        && cause.kind === "invalid_snapshot"
        && action != null
        && ((action.action === "cancel" && snapshot.status === "cancelled")
          || (action.action === "discard" && snapshot.status === "discarded"));
      if (!matchesInFlightTerminal) throw cause;
      await action.response;
      return machine.observe(snapshot);
    }
  }

  async function* observe(signal: import("../ports.js").AbortSignalLike, retryFirst: boolean): AsyncIterable<GenerationEvent> {
    if (watcherActive) throw new GenerationWorkflowProtocolError("watch_already_active");
    watcherActive = true;
    try {
      if (signal.aborted) {
        yield { type: "detached", jobId };
        return;
      }
      if (retryFirst) {
        const retryError = await retryOrUnrecoverable();
        if (retryError) {
          yield { type: "settled", outcome: "unrecoverable", error: retryError };
          return;
        }
      }

      while (true) {
        let restart = false;
        let terminalAccepted = false;
        let deferredFailedSnapshot: import("@infinite-quest/contracts").GenerationStreamSnapshot | null = null;
        const iterator = dependencies.source.watch(jobId, signal)[Symbol.asyncIterator]();
        const aborted = Symbol("aborted");
        let resolveAbort: (() => void) | undefined;
        const abortPromise = new Promise<typeof aborted>((resolve) => {
          resolveAbort = () => resolve(aborted);
        });
        const onAbort = () => {
          resolveAbort?.();
          void closeIterator();
        };
        let iteratorClosed = false;
        const closeIterator = async () => {
          if (iteratorClosed) return;
          iteratorClosed = true;
          await iterator.return?.();
        };
        signal.addEventListener("abort", onAbort, { once: true });
        try {
          while (true) {
            if (signal.aborted) {
              await closeIterator();
              yield { type: "detached", jobId };
              return;
            }
            const next = await Promise.race([iterator.next(), abortPromise]);
            if (next === aborted) {
              await closeIterator();
              yield { type: "detached", jobId };
              return;
            }
            if (next.done) break;
            const sourceEvent = next.value;
            if (sourceEvent.kind === "degraded") {
              yield { type: "degraded", reason: sourceEvent.reason, consecutiveFailures: sourceEvent.consecutiveFailures };
              continue;
            }
            const parsed = generationStreamSnapshotSchema.safeParse(sourceEvent.snapshot);
            if (!parsed.success) throw new GenerationWorkflowProtocolError("invalid_snapshot", { cause: parsed.error });
            const observation = await observeSnapshot(parsed.data);
            if (observation.kind !== "accepted") continue;
            yield { type: "status", snapshot: observation.snapshot };
            if (observation.narrationChanged) {
              yield { type: "narration", text: observation.snapshot.partialNarration ?? "" };
            }
            if (!observation.terminal) continue;
            terminalAccepted = true;

            if (observation.snapshot.status === "completed") {
              yield await fetchResult();
              return;
            }
            if (observation.snapshot.status === "recoverable") {
              if (observation.snapshot.attempts === 1) {
                try {
                  const retryError = await retryOrUnrecoverable();
                  if (retryError) {
                    yield { type: "settled", outcome: "unrecoverable", error: retryError };
                    return;
                  }
                  restart = true;
                  break;
                } catch (cause) {
                  throw cause;
                }
              }
              yield { type: "settled", outcome: "unrecoverable", error: terminalError(observation.snapshot.errorMessage) };
              return;
            }
            if (observation.snapshot.status === "cancelled" || observation.snapshot.status === "discarded") {
              dependencies.pendingSubmissions.clear(campaignId);
              yield {
                type: "settled",
                outcome: observation.snapshot.status,
                error: terminalError(observation.snapshot.errorMessage)
              };
              return;
            }
            if (observation.snapshot.status === "failed") {
              if (inFlightTerminalAction) {
                deferredFailedSnapshot = observation.snapshot;
                continue;
              }
              yield {
                type: "settled",
                outcome: "failed",
                error: terminalError(observation.snapshot.errorMessage)
              };
              return;
            }
            throw new GenerationWorkflowProtocolError("invalid_snapshot");
          }
        } finally {
          signal.removeEventListener("abort", onAbort);
          await closeIterator();
        }
        if (signal.aborted) {
          yield { type: "detached", jobId };
          return;
        }
        if (restart) continue;
        if (deferredFailedSnapshot) {
          yield {
            type: "settled",
            outcome: "failed",
            error: terminalError(deferredFailedSnapshot.errorMessage)
          };
          return;
        }
        if (!terminalAccepted) throw new GenerationWorkflowProtocolError("source_ended_before_terminal");
        return;
      }
    } finally {
      watcherActive = false;
    }
  }

  const run = {
    campaignId,
    jobId,
    watch(signal: import("../ports.js").AbortSignalLike) {
      return observe(signal, false);
    },
    retryGeneration(signal: import("../ports.js").AbortSignalLike) {
      return observe(signal, true);
    },
    cancelGeneration() {
      return performAction("cancel");
    },
    discardGeneration() {
      return performAction("discard");
    },
    fetchResult
  };
  return operation.operationKind === "append"
    ? { ...run, operationKind: "append", replacementTurnId: null }
    : { ...run, operationKind: "replace_latest", replacementTurnId: operation.replacementTurnId };
}

function terminalError(message: string | null | undefined): Error {
  return new Error(message ?? "Generation reached a terminal state.");
}

function toError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}
