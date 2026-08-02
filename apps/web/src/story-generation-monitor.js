/**
 * Maps the shared GenerationWorkflow event stream to Story Player rendering.
 * Transport selection, retries, and terminal-state validation belong to
 * client-core/client-web; this module only presents their validated events.
 */
export async function presentGenerationEvents(events, handlers) {
  for await (const event of events) {
    if (event.type === "status") handlers.onStatus(event.snapshot);
    if (event.type === "narration") handlers.onNarration(event.text);
    if (event.type === "degraded") handlers.onDegraded(event.reason, event.consecutiveFailures);
    if (event.type === "detached") handlers.onDetached?.(event.jobId);
    if (event.type === "result_unavailable") handlers.onResultUnavailable(event.jobId, event.error);
    if (event.type === "settled" && event.outcome === "completed") await handlers.onCompleted(event.result);
    if (event.type === "settled" && event.outcome === "cancelled") await handlers.onCancelled(event.error);
    if (event.type === "settled" && event.outcome !== "completed" && event.outcome !== "cancelled") {
      handlers.onTerminalFailure(event.error, event.outcome);
    }
  }
}

export async function fetchCompletedGenerationResult(run, handlers) {
  const event = await run.fetchResult();
  if (event.type === "result_unavailable") {
    handlers.onResultUnavailable(event.jobId, event.error);
    return event;
  }
  await handlers.onCompleted(event.result);
  return event;
}

export function generationSubmissionInput(pending, request) {
  return pending.operationKind === "append"
    ? {
        operationKind: "append",
        expectedTurnNumber: pending.expectedTurnNumber,
        request
      }
    : { operationKind: "replace_latest", request };
}

export async function observeGenerationRunEvents(run, retryFirst, controllerState, present) {
  const existingController = controllerState.abortController;
  const controller = existingController && !existingController.signal.aborted
    ? existingController
    : new AbortController();
  controllerState.abortController = controller;
  try {
    const events = retryFirst
      ? run.retryGeneration(controller.signal)
      : run.watch(controller.signal);
    return await present(events);
  } finally {
    if (controllerState.abortController === controller) controllerState.abortController = null;
  }
}

export function activeGenerationConflict(error) {
  if (error?.statusCode !== 409 || error?.domainCode !== "active_generation_exists") return null;
  return error.details?.pendingGeneration || null;
}

export async function resumeActiveGenerationConflict(error, campaignId, workflow) {
  const pendingGeneration = activeGenerationConflict(error);
  if (!pendingGeneration) return null;
  const run = await workflow.resume(campaignId);
  if (!run) throw new Error("The active generation could not be resumed.");
  return { message: "a turn is already generating", pendingGeneration, run };
}
