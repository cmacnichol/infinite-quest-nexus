import type {
  AcceptedTurnCorrectionRequest,
  AcceptedTurnCorrectionView
} from "@infinite-quest/contracts";

export type TurnCorrectionScope = Readonly<{
  ownerUserId: string;
  campaignId: string;
}>;

export type TurnCorrectionFailureReason =
  | "owner_scope_required"
  | "invalid_request"
  | "campaign_not_found"
  | "turn_not_found"
  | "active_turn_changed"
  | "correction_revision_changed"
  | "generation_active"
  | "mechanics_leak";

export type TurnCorrectionFailure = Readonly<{
  reason: TurnCorrectionFailureReason;
  details?: Readonly<Record<string, unknown>>;
}>;

export type TurnCorrectionRepositoryResult<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; failure: TurnCorrectionFailure }>;

export type {
  AcceptedTurnCorrectionRequest,
  AcceptedTurnCorrectionView
};
