import type {
  CampaignBranchRequest,
  CampaignCharacterProfile,
  CampaignCharacterProfileUpdate,
  CampaignCreateRequest,
  CampaignRewindRequest,
  CampaignRuntimeState,
  CampaignRuntimeStateUpdate,
  CampaignTransferCommitRequest,
  CampaignTransferPreviewRequest,
  CampaignUpdateRequest,
  CampaignWorldMigrationRequest,
  CharacterProfileOrganizationRequest,
  PlayerCampaignConfig,
  PlayableCharacterGenerationPreviewRequest,
  PlayableCharacterGenerationRequest,
  ResourceDeleteRequest,
  SyncStatusRequest,
  UserProfile,
  UserProfileUpdate,
  WorldCreateRequest,
  WorldDraftUpdateRequest,
  WorldForkRequest,
  WorldGenerationPreviewRequest,
  WorldImportRequest,
  WorldPublishRequest,
  WorldStatusUpdateRequest,
  WorldVersionDeleteRequest
} from "@infinite-quest/contracts";
import type { OwnerScope } from "../generation/types.js";

/** Resolved by trusted composition. Browser input must never construct this authority. */
export type WorldCampaignOwnerScope = OwnerScope;

export type WorldScope = OwnerScope & Readonly<{ worldId: string }>;
export type WorldVersionScope = WorldScope & Readonly<{ worldVersionId: string }>;
export type CampaignScope = OwnerScope & Readonly<{ campaignId: string }>;
export type CampaignTurnScope = CampaignScope & Readonly<{ turnId: string }>;
export type WorldGenerationProgressScope = OwnerScope & Readonly<{ progressKey: string }>;

/** Opaque contexts created only by the transaction adapter. */
export type WorldCampaignCommandContext = object;
export type WorldCampaignReadContext = object;

export type WorldCampaignApplicationErrorKind =
  | "not_found"
  | "invalid_request"
  | "conflict"
  | "stale_state"
  | "unavailable";

export type WorldCampaignTransitionFailureReason =
  | "owner_scope_required"
  | "world_not_found"
  | "world_version_not_found"
  | "campaign_not_found"
  | "published_version_immutable"
  | "draft_revision_changed"
  | "version_number_conflict"
  | "world_version_changed"
  | "already_on_world_version"
  | "world_transfer_required"
  | "promotion_requires_current_version"
  | "fact_id_conflict"
  | "fact_not_found"
  | "fact_campaign_mismatch"
  | "fact_already_replaced"
  | "active_turn_changed"
  | "state_revision_changed"
  | "idempotency_mismatch"
  | "deletion_blocked"
  | "invalid_transition"
  | "generation_collaborator_unavailable";

export type WorldCampaignTransitionFailure = Readonly<{
  reason: WorldCampaignTransitionFailureReason;
  details?: Readonly<Record<string, unknown>>;
}>;

export type WorldCampaignRepositoryResult<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; failure: WorldCampaignTransitionFailure }>;

export type DeepReadonly<T> =
  T extends (...args: never[]) => unknown ? T
    : T extends readonly (infer Item)[] ? readonly DeepReadonly<Item>[]
      : T extends object ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
        : T;

export type WorldDraftAggregate<Content extends Record<string, unknown> = Record<string, unknown>> = Readonly<{
  ownerUserId: string;
  worldId: string;
  draftRevision: number;
  content: Content;
  publishedVersions: readonly Readonly<{ worldVersionId: string; versionNumber: number }>[];
}>;

export type WorldPublicationRequest = Readonly<{
  expectedDraftRevision: number;
  versionId: string;
  versionNumber: number;
  publishedAt: string;
}>;

export type PublishedWorldVersion<Content extends Record<string, unknown> = Record<string, unknown>> = Readonly<{
  ownerUserId: string;
  worldId: string;
  worldVersionId: string;
  versionNumber: number;
  publishedAt: string;
  content: DeepReadonly<Content>;
}>;

export type CampaignVersionBinding = Readonly<{
  ownerUserId: string;
  campaignId: string;
  worldId: string;
  worldVersionId: string;
  activeTurnNumber: number;
  stateRevision: number;
}>;

export type CampaignMigrationPlanRequest = Readonly<{
  targetWorldId: string;
  targetWorldVersionId: string;
  expectedWorldVersionId: string;
  note: string;
}>;

export type CampaignMigrationPlan = Readonly<{
  ownerUserId: string;
  campaignId: string;
  sourceWorldVersionId: string;
  targetWorldVersionId: string;
  activeTurnNumber: number;
  stateRevision: number;
  note: string;
}>;

export type CampaignDiscoveryPromotionRequest = Readonly<{
  draftWorldId: string;
  expectedWorldVersionId: string;
  discoveryFactIds: readonly string[];
}>;

export type CampaignDiscoveryPromotionPlan = Readonly<{
  ownerUserId: string;
  campaignId: string;
  sourceWorldVersionId: string;
  draftWorldId: string;
  discoveryFactIds: readonly string[];
}>;

export type CampaignFact = Readonly<{
  id: string;
  campaignId: string;
  turnId: string;
  content: string;
  replacesFactId: string | null;
}>;

export type AppendCampaignFactInput = Readonly<Omit<CampaignFact, "replacesFactId">>;
export type ReplaceCampaignFactInput = Readonly<Omit<CampaignFact, "replacesFactId"> & {
  replacesFactId: string;
}>;

export type WorldListView = Readonly<{ worlds: readonly Readonly<Record<string, unknown>>[] }>;
export type WorldView = Readonly<Record<string, unknown>>;
export type CampaignListView = Readonly<{ campaigns: readonly Readonly<Record<string, unknown>>[] }>;
export type CampaignView = Readonly<Record<string, unknown>>;
export type CampaignStateEditView = Readonly<Record<string, unknown>>;
export type CampaignStateCorrectionView = CampaignRuntimeState;
export type CharacterProfileView = CampaignCharacterProfile;
export type DashboardView = Readonly<Record<string, unknown>>;
export type SessionProfileView = UserProfile;
export type WorldGenerationView = Readonly<Record<string, unknown>>;
export type WorldGenerationProgressStatus = "processing" | "completed" | "failed";
export type WorldGenerationProgressView = Readonly<{
  status: WorldGenerationProgressStatus;
  phase: string;
  progressPercent: number;
  message: string;
  errorMessage?: string;
}>;

export type BoundedCampaignTurn = Readonly<{
  id: string;
  turnNumber: number;
  action: string;
  inputMode: string;
  inputModeSource: string;
  narration: string;
  choices: readonly string[];
  customActionSuggestion: string;
  imagePrompt: string;
  imageUrl: string | null;
  acceptedAt: string | Date;
  reportedCost?: Readonly<Record<string, unknown>> | null;
}>;

export type BoundedCampaignTurnPage = Readonly<{
  turns: readonly BoundedCampaignTurn[];
  nextCursor: string | null;
}>;

export type BoundedCampaignTurnPageRequest = Readonly<{
  before: string | undefined;
  limit: number;
}>;

export type CampaignSyncSnapshot = Readonly<{
  syncToken: string;
  projection: Readonly<Record<string, unknown>>;
}>;

export type CampaignSyncStatusView = Readonly<Record<string, unknown>> & Readonly<{
  syncToken: string;
  turnWindowMode: "unchanged" | "replace";
  turns: null | Readonly<{
    campaignId: string;
    turns: readonly BoundedCampaignTurn[];
    nextCursor: string | null;
  }>;
}>;

export type PortableWorldPayload = Readonly<{
  sourceName: string;
  value: unknown;
}>;

export type CampaignTransferView = Readonly<Record<string, unknown>>;
export type CampaignTransferResultView = Readonly<Record<string, unknown>>;

export type WorldGenerationProgressUpdate = Readonly<{
  status: WorldGenerationProgressStatus;
  phase: string;
  progressPercent: number;
  message: string;
  errorMessage?: string;
}>;

export type {
  CampaignBranchRequest,
  CampaignCharacterProfileUpdate,
  CampaignCreateRequest,
  CampaignRewindRequest,
  CampaignRuntimeStateUpdate,
  CampaignTransferCommitRequest,
  CampaignTransferPreviewRequest,
  CampaignUpdateRequest,
  CampaignWorldMigrationRequest,
  CharacterProfileOrganizationRequest,
  PlayerCampaignConfig,
  PlayableCharacterGenerationPreviewRequest,
  PlayableCharacterGenerationRequest,
  ResourceDeleteRequest,
  SyncStatusRequest,
  UserProfileUpdate,
  WorldCreateRequest,
  WorldDraftUpdateRequest,
  WorldForkRequest,
  WorldGenerationPreviewRequest,
  WorldImportRequest,
  WorldPublishRequest,
  WorldStatusUpdateRequest,
  WorldVersionDeleteRequest
};
