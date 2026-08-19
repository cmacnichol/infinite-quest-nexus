import {
  appendExpectedTurnNumber,
  type CampaignStoreController,
  type GenerationEvent,
  type GenerationProjectionSession,
  type GenerationRun,
  type GenerationWorkflow,
  type IdFactory,
  type StoryTurnInputMode
} from "@infinite-quest/client-core";
import type { GenerationResult, TurnInputModeSource } from "@infinite-quest/contracts";

const GENERATION_CONTEXT = { budgetTokens: 32_000, compression: "auto" as const, recentTurns: 8 };

export interface StoryGenerationCampaign {
  readonly id: string;
  readonly activeTurnNumber: number;
}

export interface StoryGenerationSubmission {
  readonly action: string;
  readonly requestedInputMode: StoryTurnInputMode;
  readonly resolvedInputMode: "action" | "scene";
  readonly inputModeSource: TurnInputModeSource;
  readonly classificationId?: string;
}

export interface StoryGenerationController {
  resume(campaignId: string): Promise<boolean>;
  submitAppend(submission: StoryGenerationSubmission): Promise<boolean>;
  submitReplacement(replacementTurnId: string, submission: StoryGenerationSubmission): Promise<boolean>;
  cancel(): Promise<boolean>;
  retry(): Promise<boolean>;
  discard(): Promise<boolean>;
  dispose(): void;
}

export interface StoryGenerationControllerDependencies {
  readonly workflow: GenerationWorkflow;
  readonly campaignStore: CampaignStoreController;
  readonly idFactory: IdFactory;
  /** The controller refuses to apply a run after this authoritative scope changes. */
  readonly currentCampaign: () => StoryGenerationCampaign | null;
  readonly onCompleted?: (result: GenerationResult) => void | Promise<void>;
  readonly onError?: (error: unknown) => void;
}

interface AttachedRun {
  readonly run: GenerationRun;
  readonly session: GenerationProjectionSession;
  readonly abort: AbortController;
  readonly epoch: number;
}

/**
 * Coordinates the shared durable generation workflow with the campaign store.
 * It deliberately owns neither HTTP transport nor a second accepted-turn cache.
 */
export function createStoryGenerationController(
  dependencies: StoryGenerationControllerDependencies
): StoryGenerationController {
  let disposed = false;
  let epoch = 0;
  let active: AttachedRun | null = null;
  let submitting = false;

  const isCurrent = (entry: AttachedRun) => !disposed
    && active === entry
    && entry.epoch === epoch
    && dependencies.currentCampaign()?.id === entry.run.campaignId;

  const detach = () => {
    active?.abort.abort();
    active = null;
    epoch += 1;
  };

  const finalizeCompleted = async (entry: AttachedRun, result: GenerationResult): Promise<boolean> => {
    if (!isCurrent(entry)) return false;
    await dependencies.onCompleted?.(result);
    if (!isCurrent(entry)) return false;
    active = null;
    epoch += 1;
    return true;
  };

  const finalizeTerminal = (entry: AttachedRun): boolean => {
    if (!isCurrent(entry)) return false;
    entry.abort.abort();
    active = null;
    epoch += 1;
    return true;
  };

  const monitor = (entry: AttachedRun, retryFirst = false) => {
    void (async () => {
      try {
        const events = retryFirst ? entry.run.retryGeneration(entry.abort.signal) : entry.run.watch(entry.abort.signal);
        for await (const event of events) {
          if (!isCurrent(entry)) return;
          entry.session.apply(event);
          if (event.type === "settled" && event.outcome === "completed" && isCurrent(entry)) {
            await finalizeCompleted(entry, event.result);
          } else if (event.type === "settled" && (event.outcome === "cancelled" || event.outcome === "discarded") && isCurrent(entry)) {
            finalizeTerminal(entry);
          }
        }
      } catch (error) {
        if (isCurrent(entry)) dependencies.onError?.(error);
      }
    })();
  };

  const attach = (run: GenerationRun, retryFirst = false): boolean => {
    const campaign = dependencies.currentCampaign();
    if (disposed || campaign?.id !== run.campaignId) return false;
    detach();
    const entry: AttachedRun = {
      run,
      session: dependencies.campaignStore.attachGeneration(run),
      abort: new AbortController(),
      epoch
    };
    active = entry;
    monitor(entry, retryFirst);
    return true;
  };

  const submissionRequest = (submission: StoryGenerationSubmission) => ({
    action: submission.action,
    requestedInputMode: submission.requestedInputMode,
    resolvedInputMode: submission.resolvedInputMode,
    inputModeSource: submission.inputModeSource,
    ...(submission.classificationId ? { classificationId: submission.classificationId } : {}),
    idempotencyKey: dependencies.idFactory.create(),
    context: GENERATION_CONTEXT
  });

  return {
    async resume(campaignId) {
      if (disposed || active !== null || submitting || dependencies.currentCampaign()?.id !== campaignId) return false;
      try {
        const run = await dependencies.workflow.resume(campaignId);
        return run !== null && attach(run);
      } catch (error) {
        dependencies.onError?.(error);
        return false;
      }
    },
    async submitAppend(submission) {
      const campaign = dependencies.currentCampaign();
      if (disposed || campaign === null || active !== null || submitting) return false;
      submitting = true;
      try {
        const run = await dependencies.workflow.submit(campaign.id, {
          operationKind: "append",
          expectedTurnNumber: appendExpectedTurnNumber(campaign),
          request: submissionRequest(submission)
        });
        return attach(run);
      } catch (error) {
        dependencies.onError?.(error);
        return false;
      } finally {
        submitting = false;
      }
    },
    async submitReplacement(replacementTurnId, submission) {
      const campaign = dependencies.currentCampaign();
      if (disposed || campaign === null || active !== null || submitting || !replacementTurnId || campaign.activeTurnNumber < 1) return false;
      submitting = true;
      try {
        const run = await dependencies.workflow.submit(campaign.id, {
          operationKind: "replace_latest",
          request: { ...submissionRequest(submission), expectedCurrentTurnNumber: campaign.activeTurnNumber }
        });
        if (run.operationKind !== "replace_latest" || run.replacementTurnId !== replacementTurnId) {
          dependencies.onError?.(new Error("Replacement generation did not preserve its authoritative target."));
          return false;
        }
        return attach(run);
      } catch (error) {
        dependencies.onError?.(error);
        return false;
      } finally {
        submitting = false;
      }
    },
    async cancel() {
      const entry = active;
      if (!entry || !isCurrent(entry)) return false;
      try {
        await entry.run.cancelGeneration();
        return true;
      } catch (error) {
        if (isCurrent(entry)) dependencies.onError?.(error);
        return false;
      }
    },
    async retry() {
      const entry = active;
      if (!entry || !isCurrent(entry)) return false;
      try {
        const generation = dependencies.campaignStore.store.get().generation;
        if (generation?.result.state === "unavailable") {
          const event = await entry.run.fetchResult();
          if (!isCurrent(entry)) return false;
          entry.session.apply(event);
          return event.type === "settled" && event.outcome === "completed"
            ? finalizeCompleted(entry, event.result)
            : true;
        }
        return attach(entry.run, true);
      } catch (error) {
        if (isCurrent(entry)) dependencies.onError?.(error);
        return false;
      }
    },
    async discard() {
      const entry = active;
      if (!entry || !isCurrent(entry)) return false;
      try {
        await entry.run.discardGeneration();
        if (!isCurrent(entry)) return false;
        entry.session.apply({ type: "settled", outcome: "discarded", error: new Error("Generation discarded.") });
        return finalizeTerminal(entry);
      } catch (error) {
        if (isCurrent(entry)) dependencies.onError?.(error);
        return false;
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      detach();
    }
  };
}
