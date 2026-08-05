import type {
  CampaignBranchResponse,
  CampaignBranchRequest,
  CampaignCharacterProfile,
  CampaignCharacterProfileUpdate,
  CampaignCreateResponse,
  CampaignCreateRequest,
  CampaignListResponse,
  CampaignRewindResponse,
  CampaignRewindRequest as ContractCampaignRewindRequest,
  CampaignRuntimeState,
  CampaignRuntimeStateContent,
  CampaignRuntimeStateUpdate,
  CampaignSyncStatus,
  CampaignTracker,
  CampaignTransferCommitRequest,
  CampaignTransferFinding,
  CampaignTransferPreviewRequest,
  CampaignUpdateRequest,
  CampaignWorldMigrationRequest,
  CharacterProfileOrganizationResult,
  CharacterProfileOrganizationRequest,
  PlayerCampaignConfig,
  PlayerEventTrigger,
  PlayerRpgStat,
  PlayableCharacter,
  PlayableCharacterGenerationPreviewRequest,
  PlayableCharacterGenerationRequest,
  PlayableCharacterListResponse,
  ResourceDeleteRequest,
  SyncStatusRequest,
  TurnSummary,
  UserProfile,
  UserProfileUpdate,
  WorldContent,
  WorldCreateResponse,
  WorldCreateRequest,
  WorldDraftUpdateRequest,
  WorldForkRequest,
  WorldGenerationPreviewRequest,
  WorldImportRequest,
  WorldListResponse,
  WorldPublishRequest,
  WorldStatusUpdateRequest,
  WorldVersionDeleteRequest
} from "@infinite-quest/contracts";
import type { OwnerScope } from "../generation/types.js";

/** Resolved by trusted composition. Browser input must never construct this authority. */
export type WorldCampaignOwnerScope = OwnerScope;

export type WorldScope = OwnerScope & Readonly<{ worldId: string }>;
export type WorldVersionScope = WorldScope & Readonly<{ worldVersionId: string }>;
export type WorldVersionLookupScope = OwnerScope & Readonly<{ worldVersionId: string }>;
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
  details?: WorldCampaignErrorDetails;
}>;

export type WorldCampaignErrorDetails = Readonly<{
  worldId?: string;
  worldVersionId?: string;
  targetWorldId?: string;
  campaignId?: string;
  factId?: string;
  versionNumber?: number;
  expectedDraftRevision?: number;
  actualDraftRevision?: number;
  expectedWorldVersionId?: string;
  actualWorldVersionId?: string;
  expectedTurnNumber?: number;
  actualTurnNumber?: number;
  expectedStateRevision?: number;
  actualStateRevision?: number;
  blockers?: readonly string[];
  findings?: readonly CampaignTransferFinding[];
}>;

export type WorldCampaignRepositoryResult<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; failure: WorldCampaignTransitionFailure }>;

export type DeepReadonly<T> =
  T extends Date ? string
    : T extends (...args: never[]) => unknown ? T
    : T extends readonly (infer Item)[] ? readonly DeepReadonly<Item>[]
      : T extends object ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
        : T;

export type WorldDraftAggregate<Content extends object = WorldContent> = Readonly<{
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

export type PublishedWorldVersion<Content extends object = WorldContent> = Readonly<{
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

export type ApiTimestamp = string;
export type AdapterTimestamp = string | Date;

/** Adapter input; application views canonicalize its Date branch to an ISO string. */
export type WorldListSource = WorldListResponse;
export type WorldListView = DeepReadonly<WorldListResponse>;

export type PublishedWorldSummaryView = Readonly<{
  id: string;
  versionNumber: number;
  sourceHash: string | null;
  releaseNotes: string;
  createdFromRevision: number;
  publishedAt: ApiTimestamp;
  createdAt: ApiTimestamp;
  deletable: boolean;
  deletionBlockers: Readonly<{
    currentCampaigns: number;
    campaignMigrations: number;
    campaignTransfers: number;
    chronicleMemories: number;
    modelChains: number;
  }>;
  detachments: Readonly<{ drafts: number; forks: number; imports: number }>;
}>;
export type PublishedWorldSummarySource = Readonly<
  Omit<PublishedWorldSummaryView, "publishedAt" | "createdAt"> & {
    publishedAt: AdapterTimestamp;
    createdAt: AdapterTimestamp;
  }
>;

export type WorldCampaignReferenceView = Readonly<{
  id: string;
  title: string;
  status: "active" | "archived";
  activeTurnNumber: number;
  worldVersionId: string;
  worldVersionNumber: number;
  selectedCharacterId: string | null;
  selectedCharacterName: string | null;
  turnControlStyle: CampaignUpdateRequest["turnControlStyle"];
  updatedAt: ApiTimestamp;
}>;
export type WorldCampaignReferenceSource = Readonly<
  Omit<WorldCampaignReferenceView, "updatedAt"> & { updatedAt: AdapterTimestamp }
>;

export type WorldAggregateView = Readonly<{
  id: string;
  title: string;
  status: "draft" | "active" | "archived";
  imageUrl: string;
  forkedFromWorldId: string | null;
  forkedFromWorldVersionId: string | null;
  createdAt: ApiTimestamp;
  updatedAt: ApiTimestamp;
  draftRevision: number | null;
  draftContent: DeepReadonly<WorldContent> | null;
  draftBasedOnWorldVersionId: string | null;
  draftUpdatedAt: ApiTimestamp | null;
  versions: readonly PublishedWorldSummaryView[];
  campaigns: readonly WorldCampaignReferenceView[];
}>;
export type WorldAggregateSource = Readonly<
  Omit<WorldAggregateView, "createdAt" | "updatedAt" | "draftUpdatedAt" | "versions" | "campaigns"> & {
    createdAt: AdapterTimestamp;
    updatedAt: AdapterTimestamp;
    draftUpdatedAt: AdapterTimestamp | null;
    versions: readonly PublishedWorldSummarySource[];
    campaigns: readonly WorldCampaignReferenceSource[];
  }
>;

export type WorldCreateSource = WorldCreateResponse;
export type WorldCreateView = DeepReadonly<WorldCreateResponse>;
export type WorldDraftUpdateView = Readonly<{
  worldId: string;
  title: string;
  revision: number;
  content: DeepReadonly<WorldContent>;
  updatedAt: ApiTimestamp;
}>;
export type WorldDraftUpdateSource = Readonly<
  Omit<WorldDraftUpdateView, "updatedAt"> & { updatedAt: AdapterTimestamp }
>;
export type WorldPublicationView = Readonly<{
  worldId: string;
  worldVersionId: string;
  versionNumber: number;
  draftRevision: number;
  publishedAt: ApiTimestamp;
}>;
export type WorldPublicationSource = Readonly<
  Omit<WorldPublicationView, "publishedAt"> & { publishedAt: AdapterTimestamp }
>;
export type WorldStatusView = Readonly<{
  id: string;
  title: string;
  status: "draft" | "active" | "archived";
  updatedAt: ApiTimestamp;
}>;
export type WorldStatusSource = Readonly<
  Omit<WorldStatusView, "updatedAt"> & { updatedAt: AdapterTimestamp }
>;
export type WorldForkView = Readonly<{
  worldId: string;
  sourceWorldId: string;
  sourceWorldVersionId: string;
  title: string;
  revision: number;
}>;
export type WorldImportPreviewView = Readonly<{
  kind: "world";
  title: string;
  duplicate: boolean;
  existingWorldId: string | null;
  counts: Readonly<{ entities: number; relationships: number; triggers: number }>;
  warnings: readonly string[];
}>;
export type WorldImportResultView = Readonly<{
  importId: string;
  worldId: string;
  worldVersionId: string;
  duplicate: boolean;
}>;
export type WorldPromotionView = Readonly<{
  worldId: string;
  draftRevision: number;
  promotedFactCount: number;
}>;

export type CampaignListSource = CampaignListResponse;
export type CampaignListView = DeepReadonly<CampaignListSource>;
export type CampaignCreateView = DeepReadonly<CampaignCreateResponse>;
export type CampaignUpdateView = Readonly<{
  id: string;
  title: string;
  status: "active" | "archived";
  activeTurnNumber: number;
  textProviderProfileId: string | null;
  imageProviderProfileId: string | null;
  storyLengthProfile: CampaignCreateResponse["storyLengthProfile"];
  turnControlStyle: NonNullable<CampaignUpdateRequest["turnControlStyle"]>;
  updatedAt: ApiTimestamp;
}>;
export type CampaignUpdateSource = Readonly<
  Omit<CampaignUpdateView, "updatedAt"> & { updatedAt: AdapterTimestamp }
>;
export type CampaignMigrationView = Readonly<{
  migrationId: string;
  campaignId: string;
  fromWorldVersionId: string;
  toWorldVersionId: string;
  worldVersionNumber: number;
  migratedAt: ApiTimestamp;
}>;
export type CampaignMigrationSource = Readonly<
  Omit<CampaignMigrationView, "migratedAt"> & { migratedAt: AdapterTimestamp }
>;
export type CampaignPlayerConfigSyncView = Readonly<{
  campaignId: string;
  activeTurnNumber: number;
  synchronized: true;
}>;
export type CampaignPlayerConfigSyncRequest = Readonly<PlayerCampaignConfig & {
  expectedStateRevision: number;
}>;
export type CampaignRewindRequest = Readonly<Omit<ContractCampaignRewindRequest, "expectedCurrentTurnNumber"> & {
  expectedCurrentTurnNumber: number;
  expectedStateRevision: number;
}>;
export type CampaignRewindView = DeepReadonly<CampaignRewindResponse>;
export type CampaignBranchView = DeepReadonly<CampaignBranchResponse>;
export type CampaignStateEditView = Readonly<{
  id: string;
  revision: number;
  effectiveTurnNumber: number;
  snapshot: DeepReadonly<CampaignRuntimeStateContent>;
  updatedAt: ApiTimestamp;
}>;
export type CampaignStateEditSource = Readonly<
  Omit<CampaignStateEditView, "updatedAt"> & { updatedAt: AdapterTimestamp }
>;
export type CampaignStateCorrectionSource = CampaignRuntimeState;
export type CampaignStateCorrectionView = DeepReadonly<CampaignStateCorrectionSource>;

export type CharacterProfileView = Readonly<{
  campaignId: string;
  characterId: string | null;
  revision: number;
  name: string;
  profile: DeepReadonly<CampaignCharacterProfile["profile"]>;
  storedProfile: DeepReadonly<CampaignCharacterProfile> | null;
  inheritedFromSnapshot: boolean;
  legacyCharacterText: string;
  rpgStats: readonly DeepReadonly<PlayerRpgStat>[];
  defaultTriggers: readonly DeepReadonly<PlayerEventTrigger | CampaignTracker>[];
}>;
export type CharacterProfileUpdateView = Readonly<{
  campaignId: string;
  revision: number;
  name: string;
  profile: DeepReadonly<CampaignCharacterProfile["profile"]>;
}>;
export type CharacterProfileOrganizationView = DeepReadonly<CharacterProfileOrganizationResult>;

export type DashboardProviderCostTotalView = Readonly<{
  providerProfileId: string | null;
  providerName: string | null;
  providerType: string;
  category: "story" | "image" | "memory";
  currency: string;
  amount: string;
  eventCount: number;
  lastReportedAt: ApiTimestamp;
}>;
export type DashboardProviderCostTotalSource = Readonly<
  Omit<DashboardProviderCostTotalView, "lastReportedAt"> & { lastReportedAt: AdapterTimestamp }
>;
type DashboardProjection<ProviderCostTotal> = Readonly<{
  worlds: Readonly<{ available: number; total: number; published: number; drafts: number; archived: number }>;
  campaigns: Readonly<{ open: number; total: number; archived: number }>;
  turns: Readonly<{ accepted: number }>;
  providerCosts: Readonly<{
    hasReportedCosts: boolean;
    totals: readonly ProviderCostTotal[];
  }>;
}>;
export type DashboardSource = DashboardProjection<DashboardProviderCostTotalSource>;
export type DashboardView = DashboardProjection<DashboardProviderCostTotalView>;
export type SessionProfileView = DeepReadonly<UserProfile>;
export type GeneratedWorldPreviewView = Readonly<{ title: string; content: DeepReadonly<WorldContent> }>;
export type GeneratedPlayableCharacterView = Readonly<{ character: DeepReadonly<PlayableCharacter> }>;
export type PlayableCharacterSummaryView = DeepReadonly<PlayableCharacterListResponse>;
export type PlayableCharacterSummaryItemView = PlayableCharacterSummaryView["characters"][number];
export type WorldGenerationProgressStatus = "processing" | "completed" | "failed";
export type WorldGenerationProgressView = Readonly<{
  status: WorldGenerationProgressStatus;
  phase: string;
  progressPercent: number;
  message: string;
  errorMessage?: string;
}>;

export type BoundedCampaignTurn = DeepReadonly<TurnSummary>;
export type BoundedCampaignTurnSource = TurnSummary;

export type BoundedCampaignTurnPage = Readonly<{
  turns: readonly BoundedCampaignTurn[];
  nextCursor: string | null;
}>;
export type BoundedCampaignTurnPageSource = Readonly<{
  turns: readonly BoundedCampaignTurnSource[];
  nextCursor: string | null;
}>;

export type BoundedCampaignTurnPageRequest = Readonly<{
  before: string | undefined;
  limit: number;
}>;

export type CampaignSyncSnapshotSource = Readonly<{
  syncToken: string;
  projection: CampaignSyncSourceProjection;
}>;

type UnchangedCampaignSyncStatus = Extract<CampaignSyncStatus, { turnWindowMode: "unchanged" }>;
export type CampaignSyncSourceProjection = Omit<UnchangedCampaignSyncStatus, "syncToken" | "turnWindowMode" | "turns">;
export type CampaignSyncProjection = DeepReadonly<CampaignSyncSourceProjection>;
export type CampaignSyncStatusView = DeepReadonly<CampaignSyncStatus>;

export type PortableWorldPayload = DeepReadonly<WorldImportRequest["worldExport"]>;

export type CampaignTransferView = Readonly<{
  allowed: boolean;
  source: Readonly<{
    campaignId: string;
    campaignTitle: string;
    worldId: string;
    worldTitle: string;
    worldVersionId: string;
    worldVersionNumber: number;
  }>;
  target: Readonly<{ worldId: string; worldTitle: string; worldVersionId: string; worldVersionNumber: number }>;
  proposedTitle: string;
  counts: Readonly<{ turns: number; stateEdits: number; summaries: number; assets: number }>;
  character: Readonly<{
    id: string | null;
    name: string | null;
    targetMatches: readonly Readonly<{ id: string; name: string }>[];
  }>;
  findings: readonly DeepReadonly<CampaignTransferFinding>[];
  expectedActiveTurnNumber: number;
  expectedStateRevision: number;
  sourceFingerprint: string;
}>;
export type CampaignTransferResultView = Readonly<{
  transferId: string;
  sourceCampaignId: string;
  targetCampaignId: string;
  fromWorldVersionId: string;
  targetWorldId: string;
  targetWorldVersionId: string;
  activeTurnNumber: number;
  chronicleMemoryCount: number;
  embeddingJobId: string | null;
  warnings: readonly DeepReadonly<CampaignTransferFinding>[];
  reused: boolean;
}>;

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
