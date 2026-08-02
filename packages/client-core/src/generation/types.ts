import type {
  GenerationActionResponse,
  GenerationResult,
  GenerationStreamSnapshot
} from "../../../contracts/src/index.js";
import type { AbortSignalLike, Clock, PendingGenerationSubmission, PendingSubmissionStore } from "../ports.js";

export type GenerationSourceEvent =
  | { kind: "snapshot"; snapshot: GenerationStreamSnapshot }
  | { kind: "degraded"; reason: "stream_lost" | "poll_failed"; consecutiveFailures: number };

export interface GenerationSnapshotSource {
  watch(jobId: string, signal: AbortSignalLike): AsyncIterable<GenerationSourceEvent>;
}

export type GenerationEvent =
  | { type: "status"; snapshot: GenerationStreamSnapshot }
  | { type: "narration"; text: string }
  | { type: "degraded"; reason: "stream_lost" | "poll_failed"; consecutiveFailures: number }
  | { type: "detached"; jobId: string }
  | { type: "result_unavailable"; jobId: string; error: Error }
  | { type: "settled"; outcome: "completed"; result: GenerationResult }
  | { type: "settled"; outcome: "failed" | "cancelled" | "discarded" | "unrecoverable"; error: Error };

export type GenerationWorkflowProtocolErrorKind =
  | "watch_already_active"
  | "invalid_snapshot"
  | "source_ended_before_terminal"
  | "action_response_mismatch";

export class GenerationWorkflowProtocolError extends Error {
  readonly kind: GenerationWorkflowProtocolErrorKind;

  constructor(kind: GenerationWorkflowProtocolErrorKind, options: { cause?: unknown } = {}) {
    if (options.cause === undefined) {
      super(kind);
    } else {
      super(kind, { cause: options.cause });
    }
    this.name = "GenerationWorkflowProtocolError";
    this.kind = kind;
  }
}

export interface GenerationApiPort {
  enqueue(campaignId: string, request: import("../../../contracts/src/index.js").GenerationRequest): Promise<import("../../../contracts/src/index.js").GenerationEnqueueResponse>;
  enqueueReplacement(campaignId: string, request: import("../../../contracts/src/index.js").GenerationRetryLatestRequest): Promise<import("../../../contracts/src/index.js").GenerationEnqueueResponse>;
  syncStatus(campaignId: string): Promise<import("../../../contracts/src/index.js").CampaignSyncStatus>;
  result(jobId: string): Promise<GenerationResult>;
  retry(jobId: string): Promise<GenerationActionResponse>;
  cancel(jobId: string): Promise<GenerationActionResponse>;
  discard(jobId: string): Promise<GenerationActionResponse>;
}

export interface StoredGenerationSubmission extends PendingGenerationSubmission {
  jobId?: string;
}

export type GenerationSubmissionInput = Omit<StoredGenerationSubmission, "createdAt" | "jobId">;

export interface GenerationRun {
  readonly campaignId: string;
  readonly jobId: string;
  watch(signal: AbortSignalLike): AsyncIterable<GenerationEvent>;
  retryGeneration(signal: AbortSignalLike): AsyncIterable<GenerationEvent>;
  cancelGeneration(): Promise<GenerationActionResponse>;
  discardGeneration(): Promise<GenerationActionResponse>;
  fetchResult(): Promise<
    | Extract<GenerationEvent, { type: "settled"; outcome: "completed" }>
    | Extract<GenerationEvent, { type: "result_unavailable" }>
  >;
}

export interface GenerationWorkflow {
  submit(campaignId: string, submission: GenerationSubmissionInput): Promise<GenerationRun>;
  resume(campaignId: string): Promise<GenerationRun | null>;
}

export interface GenerationWorkflowDependencies {
  api: GenerationApiPort;
  source: GenerationSnapshotSource;
  clock: Clock;
  pendingSubmissions: PendingSubmissionStore;
}
