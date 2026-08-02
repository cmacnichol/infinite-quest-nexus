import type { GenerationRequest } from "../../contracts/src/index.js";
import type { StoredGenerationSubmission } from "./generation/types.js";

export interface Clock {
  now(): number;
}

export interface IdFactory {
  create(): string;
}

export interface AbortSignalLike {
  readonly aborted: boolean;
  addEventListener(type: "abort", listener: () => void, options?: { once?: boolean }): void;
  removeEventListener(type: "abort", listener: () => void): void;
}

export interface DelayScheduler {
  wait(milliseconds: number, signal: AbortSignalLike): Promise<void>;
}

/**
 * The complete request envelope retained until a generation request reaches a
 * terminal state. The idempotency key stays in `request` so replays send the
 * original server contract without manufacturing a new request identity.
 */
export interface PendingGenerationSubmission {
  request: GenerationRequest;
  operationKind: "append" | "replace_latest";
  expectedTurnNumber: number;
  createdAt: number;
}

export interface PendingSubmissionStore {
  load(campaignId: string): StoredGenerationSubmission | null;
  save(campaignId: string, submission: StoredGenerationSubmission): void;
  clear(campaignId: string): void;
}

/**
 * Identity seam. The deployment is currently pre-authentication: the server
 * resolves every request to the database-backed initial owner and browser-
 * supplied identity is not authorization. OIDC is planned, so the seam is
 * defined now and implemented as a no-op.
 */
export interface SessionPort {
  /** Headers to attach to outbound requests. Currently always empty. */
  authorization(): Promise<Record<string, string>>;
  /**
   * Invoked on 401/403. Returns true when the caller should retry once.
   * The current no-op implementation always returns false.
   */
  onUnauthorized(response: { statusCode: number }): Promise<boolean>;
}
