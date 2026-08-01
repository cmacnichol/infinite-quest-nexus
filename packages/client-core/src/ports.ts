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
 * The normalized data accepted by the contracts `generationRequestSchema`.
 * This structural declaration keeps client-core free of the contracts
 * module's runtime Web and Node globals while retaining the complete request
 * needed for a durable replay. Task C5 consumes the enclosing submission
 * rather than creating a second pending-request representation.
 */
export interface PersistedGenerationRequest {
  action: string;
  requestedInputMode: "auto" | "action" | "scene";
  resolvedInputMode: "action" | "scene";
  inputModeSource: "explicit" | "auto" | "generated_choice" | "opening_action" | "fallback";
  classificationId?: string | undefined;
  providerProfileId?: string | undefined;
  model?: string | undefined;
  idempotencyKey: string;
  context: {
    budgetTokens: number;
    compression: "auto" | "full" | "balanced" | "compact" | "summary";
    recentTurns: number;
    modelContextWindowTokens?: number | undefined;
  };
}

/**
 * The complete request envelope retained until a generation request reaches a
 * terminal state. The idempotency key stays in `request` so replays send the
 * original server contract without manufacturing a new request identity.
 */
export interface PendingGenerationSubmission {
  request: PersistedGenerationRequest;
  operationKind: "append" | "replace_latest";
  expectedTurnNumber: number;
  createdAt: number;
}

export interface PendingSubmissionStore {
  load(campaignId: string): PendingGenerationSubmission | null;
  save(campaignId: string, submission: PendingGenerationSubmission): void;
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
