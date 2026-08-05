import type {
  WorldCampaignApplicationErrorKind,
  WorldCampaignErrorDetails,
  WorldCampaignTransitionFailure,
  WorldCampaignTransitionFailureReason
} from "./types.js";

export class WorldCampaignApplicationError extends Error {
  readonly kind: WorldCampaignApplicationErrorKind;
  readonly reason: WorldCampaignTransitionFailureReason;
  readonly details: WorldCampaignErrorDetails;

  constructor(
    kind: WorldCampaignApplicationErrorKind,
    reason: WorldCampaignTransitionFailureReason,
    details: WorldCampaignErrorDetails = {},
  ) {
    super(reason);
    this.name = "WorldCampaignApplicationError";
    this.kind = kind;
    this.reason = reason;
    this.details = details;
  }
}

const NOT_FOUND_REASONS: ReadonlySet<WorldCampaignTransitionFailureReason> = new Set([
  "world_not_found",
  "world_version_not_found",
  "campaign_not_found",
  "fact_not_found"
]);

const INVALID_REQUEST_REASONS: ReadonlySet<WorldCampaignTransitionFailureReason> = new Set([
  "owner_scope_required",
  "world_transfer_required",
  "fact_campaign_mismatch",
  "invalid_transition"
]);

const STALE_REASONS: ReadonlySet<WorldCampaignTransitionFailureReason> = new Set([
  "draft_revision_changed",
  "world_version_changed",
  "promotion_requires_current_version",
  "active_turn_changed",
  "state_revision_changed"
]);

export function mapWorldCampaignTransitionFailure(
  failure: WorldCampaignTransitionFailure,
): WorldCampaignApplicationError {
  const kind: WorldCampaignApplicationErrorKind = NOT_FOUND_REASONS.has(failure.reason)
    ? "not_found"
    : INVALID_REQUEST_REASONS.has(failure.reason)
      ? "invalid_request"
      : STALE_REASONS.has(failure.reason)
        ? "stale_state"
        : failure.reason === "generation_collaborator_unavailable"
          ? "unavailable"
          : "conflict";
  return new WorldCampaignApplicationError(kind, failure.reason, failure.details);
}
