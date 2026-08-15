import type { TurnCorrectionFailure, TurnCorrectionFailureReason } from "./types.js";

export type TurnCorrectionApplicationErrorKind =
  | "invalid_request"
  | "not_found"
  | "stale_state"
  | "conflict";

export class TurnCorrectionApplicationError extends Error {
  readonly kind: TurnCorrectionApplicationErrorKind;
  readonly reason: TurnCorrectionFailureReason;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    kind: TurnCorrectionApplicationErrorKind,
    reason: TurnCorrectionFailureReason,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(reason);
    this.name = "TurnCorrectionApplicationError";
    this.kind = kind;
    this.reason = reason;
    this.details = details;
  }
}

export function mapTurnCorrectionFailure(
  failure: TurnCorrectionFailure,
): TurnCorrectionApplicationError {
  const kind: TurnCorrectionApplicationErrorKind = failure.reason === "campaign_not_found"
    || failure.reason === "turn_not_found"
    ? "not_found"
    : failure.reason === "active_turn_changed"
      || failure.reason === "correction_revision_changed"
      ? "stale_state"
      : failure.reason === "generation_active"
        ? "conflict"
        : "invalid_request";
  return new TurnCorrectionApplicationError(kind, failure.reason, failure.details);
}
