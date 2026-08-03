export type GenerationApplicationErrorKind =
  | "not_found"
  | "conflict"
  | "invalid_state"
  | "stale_turn"
  | "provider_required"
  | "active_job";

export type GenerationApplicationErrorDetails = Readonly<{
  campaignId?: string;
  expectedTurnNumber?: number;
  jobId?: string;
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
