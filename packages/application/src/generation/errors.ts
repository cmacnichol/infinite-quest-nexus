import type { GenerationJobStatus } from "@infinite-quest/contracts";

export type GenerationApplicationErrorKind =
  | "not_found"
  | "conflict"
  | "invalid_state"
  | "stale_turn"
  | "provider_required"
  | "active_job";

export type GenerationApplicationErrorReason =
  | "idempotency_mismatch"
  | "action_only_mode"
  | "explicit_input_mode_mismatch"
  | "classification_id_forbidden"
  | "classification_missing_or_expired"
  | "classification_mode_mismatch"
  | "selected_provider_unavailable"
  | "no_text_provider"
  | "stale_current_turn"
  | "missing_latest_turn"
  | "active_generation"
  | "active_illustration"
  | "result_not_completed"
  | "retry_source_state"
  | "cancel_source_state"
  | "discard_source_state";

export type PendingGeneration = Readonly<{
  id: string;
  status: GenerationJobStatus["status"];
  action: string;
  operationKind: "append" | "replace_latest";
  expectedTurnNumber: number;
}>;

export type GenerationApplicationErrorDetails = Readonly<{
  campaignId?: string;
  reason?: GenerationApplicationErrorReason;
  expectedTurnNumber?: number;
  actualTurnNumber?: number;
  generationStatus?: GenerationJobStatus["status"];
  jobId?: string;
  pendingGeneration?: PendingGeneration | null;
  providerProfileId?: string;
  replacementTurnId?: string;
}>;

export class GenerationApplicationError extends Error {
  readonly kind: GenerationApplicationErrorKind;
  readonly details: GenerationApplicationErrorDetails;

  constructor(kind: GenerationApplicationErrorKind, details: GenerationApplicationErrorDetails = {}) {
    super(kind);
    this.name = "GenerationApplicationError";
    this.kind = kind;
    this.details = details;
  }
}
