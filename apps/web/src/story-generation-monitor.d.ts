import type { GenerationRun, GenerationSubmissionInput, GenerationWorkflow } from "@infinite-quest/client-core";
import type { GenerationRequest, GenerationRetryLatestRequest } from "@infinite-quest/contracts";

export type StoryGenerationEvent =
  | { type: "status"; snapshot: Record<string, unknown> }
  | { type: "narration"; text: string }
  | { type: "degraded"; reason: string; consecutiveFailures: number }
  | { type: "detached"; jobId: string }
  | { type: "result_unavailable"; jobId: string; error: Error }
  | { type: "settled"; outcome: "completed"; result: Record<string, unknown> }
  | { type: "settled"; outcome: "failed" | "cancelled" | "discarded" | "unrecoverable"; error: Error };

export function presentGenerationEvents(events: AsyncIterable<StoryGenerationEvent>, handlers: {
  onStatus(snapshot: Record<string, unknown>): void;
  onNarration(text: string): void;
  onDegraded(reason: string, consecutiveFailures: number): void;
  onDetached?(jobId: string): void;
  onResultUnavailable(jobId: string, error: Error): void;
  onCompleted(result: Record<string, unknown>): Promise<void>;
  onCancelled(error: Error): Promise<void>;
  onTerminalFailure(error: Error, outcome: string): void;
}): Promise<void>;

export interface CompletedGenerationRun {
  fetchResult(): Promise<
    | Extract<StoryGenerationEvent, { type: "settled"; outcome: "completed" }>
    | Extract<StoryGenerationEvent, { type: "result_unavailable" }>
  >;
}

export function fetchCompletedGenerationResult(run: CompletedGenerationRun, handlers: {
  onCompleted(result: Record<string, unknown>): Promise<void> | void;
  onResultUnavailable(jobId: string, error: Error): void;
}): Promise<
  | Extract<StoryGenerationEvent, { type: "settled"; outcome: "completed" }>
  | Extract<StoryGenerationEvent, { type: "result_unavailable" }>
>;

export function generationSubmissionInput(
  pending: { operationKind: "append"; expectedTurnNumber: number },
  request: GenerationRequest
): Extract<GenerationSubmissionInput, { operationKind: "append" }>;

export function generationSubmissionInput(
  pending: { operationKind: "replace_latest"; expectedTurnNumber: number },
  request: GenerationRetryLatestRequest
): Extract<GenerationSubmissionInput, { operationKind: "replace_latest" }>;

export function observeGenerationRunEvents<Result>(
  run: Pick<GenerationRun, "watch" | "retryGeneration">,
  retryFirst: boolean,
  controllerState: { abortController: AbortController | null },
  present: (events: ReturnType<GenerationRun["watch"]>) => Promise<Result>
): Promise<Result>;

export function activeGenerationConflict(error: unknown): Record<string, unknown> | null;

export function resumeActiveGenerationConflict(
  error: unknown,
  campaignId: string,
  workflow: Pick<GenerationWorkflow, "resume">
): Promise<{
  message: "a turn is already generating";
  pendingGeneration: Record<string, unknown>;
  run: GenerationRun;
} | null>;
