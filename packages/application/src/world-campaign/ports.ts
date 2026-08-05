import type {
  BoundedCampaignTurnPage,
  BoundedCampaignTurnPageRequest,
  CampaignBranchRequest,
  CampaignBranchView,
  CampaignCharacterProfileUpdate,
  CampaignCreateView,
  CampaignCreateRequest,
  CampaignListView,
  CampaignMigrationView,
  CampaignPlayerConfigSyncView,
  CampaignRewindRequest,
  CampaignRewindView,
  CampaignRuntimeStateUpdate,
  CampaignScope,
  CampaignStateCorrectionView,
  CampaignStateEditView,
  CampaignSyncSnapshot,
  CampaignSyncStatusView,
  CampaignTransferCommitRequest,
  CampaignTransferPreviewRequest,
  CampaignTransferResultView,
  CampaignTransferView,
  CampaignUpdateRequest,
  CampaignUpdateView,
  CampaignWorldMigrationRequest,
  CharacterProfileOrganizationRequest,
  CharacterProfileOrganizationView,
  CharacterProfileUpdateView,
  CharacterProfileView,
  DashboardView,
  GeneratedPlayableCharacterView,
  GeneratedWorldPreviewView,
  PlayerCampaignConfig,
  PlayableCharacterSummaryItemView,
  PlayableCharacterSummaryView,
  PlayableCharacterGenerationPreviewRequest,
  PlayableCharacterGenerationRequest,
  PortableWorldPayload,
  ResourceDeleteRequest,
  SessionProfileView,
  SyncStatusRequest,
  UserProfileUpdate,
  WorldCampaignCommandContext,
  WorldCampaignReadContext,
  WorldCampaignRepositoryResult,
  WorldCreateRequest,
  WorldCreateView,
  WorldDraftUpdateView,
  WorldDraftUpdateRequest,
  WorldForkRequest,
  WorldForkView,
  WorldGenerationPreviewRequest,
  WorldGenerationProgressScope,
  WorldGenerationProgressUpdate,
  WorldGenerationProgressView,
  WorldImportRequest,
  WorldImportPreviewView,
  WorldImportResultView,
  WorldListSource,
  WorldListView,
  WorldPublishRequest,
  WorldPublicationView,
  WorldPromotionView,
  WorldScope,
  WorldAggregateView,
  WorldStatusUpdateRequest,
  WorldStatusView,
  WorldVersionDeleteRequest,
  WorldVersionScope
} from "./types.js";
import type { OwnerScope } from "../generation/types.js";

export interface WorldCampaignTransactionPort {
  command<T>(work: (transaction: WorldCampaignCommandContext) => Promise<T>): Promise<T>;
  read<T>(work: (transaction: WorldCampaignReadContext) => Promise<T>): Promise<T>;
}

export interface WorldRepositoryPort {
  listWorlds(transaction: WorldCampaignReadContext, scope: OwnerScope): Promise<WorldListSource>;
  getWorld(transaction: WorldCampaignReadContext, scope: WorldScope): Promise<WorldAggregateView>;
  createWorld(transaction: WorldCampaignCommandContext, scope: OwnerScope, request: WorldCreateRequest): Promise<WorldCampaignRepositoryResult<WorldCreateView>>;
  updateWorldDraft(transaction: WorldCampaignCommandContext, scope: WorldScope, request: WorldDraftUpdateRequest): Promise<WorldCampaignRepositoryResult<WorldDraftUpdateView>>;
  publishWorld(transaction: WorldCampaignCommandContext, scope: WorldScope, request: WorldPublishRequest): Promise<WorldCampaignRepositoryResult<WorldPublicationView>>;
  updateWorldStatus(transaction: WorldCampaignCommandContext, scope: WorldScope, request: WorldStatusUpdateRequest): Promise<WorldCampaignRepositoryResult<WorldStatusView>>;
  forkWorld(transaction: WorldCampaignCommandContext, scope: WorldScope, request: WorldForkRequest): Promise<WorldCampaignRepositoryResult<WorldForkView>>;
  exportWorld(transaction: WorldCampaignReadContext, scope: WorldScope | WorldVersionScope): Promise<PortableWorldPayload>;
  previewWorldImport(transaction: WorldCampaignReadContext, scope: OwnerScope, request: WorldImportRequest): Promise<WorldImportPreviewView>;
  importWorld(transaction: WorldCampaignCommandContext, scope: OwnerScope, request: WorldImportRequest): Promise<WorldCampaignRepositoryResult<WorldImportResultView>>;
  deleteWorld(transaction: WorldCampaignCommandContext, scope: WorldScope, request: ResourceDeleteRequest): Promise<WorldCampaignRepositoryResult<void>>;
  deleteWorldVersion(transaction: WorldCampaignCommandContext, scope: WorldVersionScope, request: WorldVersionDeleteRequest): Promise<WorldCampaignRepositoryResult<void>>;
  promoteCampaignDiscoveries(transaction: WorldCampaignCommandContext, scope: CampaignScope, request: Readonly<{ draftWorldId: string; expectedWorldVersionId: string; discoveryFactIds: readonly string[] }>): Promise<WorldCampaignRepositoryResult<WorldPromotionView>>;
}

export interface CampaignRepositoryPort {
  listCampaigns(transaction: WorldCampaignReadContext, scope: OwnerScope): Promise<CampaignListView>;
  createCampaign(transaction: WorldCampaignCommandContext, scope: OwnerScope, request: CampaignCreateRequest): Promise<WorldCampaignRepositoryResult<CampaignCreateView>>;
  updateCampaign(transaction: WorldCampaignCommandContext, scope: CampaignScope, request: CampaignUpdateRequest): Promise<WorldCampaignRepositoryResult<CampaignUpdateView>>;
  deleteCampaign(transaction: WorldCampaignCommandContext, scope: CampaignScope, request: ResourceDeleteRequest): Promise<WorldCampaignRepositoryResult<void>>;
  listWorldVersionPlayableCharacters(transaction: WorldCampaignReadContext, scope: WorldVersionScope): Promise<readonly PlayableCharacterSummaryItemView[]>;
  getWorldVersionPlayableCharacterSummary(transaction: WorldCampaignReadContext, scope: WorldVersionScope): Promise<PlayableCharacterSummaryView>;
  migrateCampaignWorldVersion(transaction: WorldCampaignCommandContext, scope: CampaignScope, request: CampaignWorldMigrationRequest): Promise<WorldCampaignRepositoryResult<CampaignMigrationView>>;
  syncPlayerCampaignConfig(transaction: WorldCampaignCommandContext, scope: CampaignScope, request: PlayerCampaignConfig): Promise<WorldCampaignRepositoryResult<CampaignPlayerConfigSyncView>>;
  rewindCampaign(transaction: WorldCampaignCommandContext, scope: CampaignScope, request: CampaignRewindRequest): Promise<WorldCampaignRepositoryResult<CampaignRewindView>>;
  branchCampaign(transaction: WorldCampaignCommandContext, scope: CampaignScope, request: CampaignBranchRequest): Promise<WorldCampaignRepositoryResult<CampaignBranchView>>;
}

export interface CampaignStateRepositoryPort {
  loadEffectiveCampaignStateEdit(transaction: WorldCampaignReadContext, scope: CampaignScope): Promise<CampaignStateEditView>;
  getCampaignRuntimeState(transaction: WorldCampaignReadContext, scope: CampaignScope, requestedTurnNumber?: number): Promise<CampaignStateCorrectionView>;
  updateCampaignRuntimeState(transaction: WorldCampaignCommandContext, scope: CampaignScope, request: CampaignRuntimeStateUpdate): Promise<WorldCampaignRepositoryResult<CampaignStateCorrectionView>>;
}

export interface CampaignSyncRepositoryPort {
  readCampaignSyncSnapshot(transaction: WorldCampaignReadContext, scope: CampaignScope): Promise<CampaignSyncSnapshot>;
}

/** Adapter contract for the existing B4 bounded cursor/snapshot reader. */
export interface BoundedCampaignTurnPagePort {
  readTurnPage(scope: CampaignScope, request: BoundedCampaignTurnPageRequest): Promise<BoundedCampaignTurnPage>;
}

export interface CharacterProfileRepositoryPort {
  getCampaignCharacterProfile(transaction: WorldCampaignReadContext, scope: CampaignScope): Promise<CharacterProfileView>;
  updateCampaignCharacterProfile(transaction: WorldCampaignCommandContext, scope: CampaignScope, request: CampaignCharacterProfileUpdate): Promise<WorldCampaignRepositoryResult<CharacterProfileUpdateView>>;
}

/** Temporary 14c -> 14d provider/prompt collaborator; it carries no profile or credential object. */
export interface CharacterProfileOrganizerPort {
  organizeCampaignCharacterProfile(scope: CampaignScope, request: CharacterProfileOrganizationRequest): Promise<CharacterProfileOrganizationView>;
  organizeWorldCharacterProfile(scope: WorldScope, request: CharacterProfileOrganizationRequest): Promise<CharacterProfileOrganizationView>;
}

export interface CampaignTransferRepositoryPort {
  previewCampaignWorldTransfer(transaction: WorldCampaignReadContext, scope: CampaignScope, request: CampaignTransferPreviewRequest): Promise<CampaignTransferView>;
  transferCampaignWorld(transaction: WorldCampaignCommandContext, scope: CampaignScope, request: CampaignTransferCommitRequest): Promise<WorldCampaignRepositoryResult<CampaignTransferResultView>>;
}

export interface DashboardRepositoryPort {
  getDashboard(transaction: WorldCampaignReadContext, scope: OwnerScope): Promise<DashboardView>;
}

export interface SessionProfileRepositoryPort {
  getSessionProfile(transaction: WorldCampaignReadContext, scope: OwnerScope): Promise<SessionProfileView>;
  updateSessionProfile(transaction: WorldCampaignCommandContext, scope: OwnerScope, request: UserProfileUpdate): Promise<WorldCampaignRepositoryResult<SessionProfileView>>;
}

/** Temporary 14c -> 14d text-generation collaborator; transport and model selection stay outside application. */
export interface WorldGenerationCollaboratorPort {
  generateWorldPreview(scope: OwnerScope, request: WorldGenerationPreviewRequest): Promise<GeneratedWorldPreviewView>;
  generatePlayableCharacterPreview(scope: OwnerScope, request: PlayableCharacterGenerationPreviewRequest): Promise<GeneratedPlayableCharacterView>;
  generatePlayableCharacter(scope: WorldScope, request: PlayableCharacterGenerationRequest): Promise<GeneratedPlayableCharacterView>;
}

export interface WorldGenerationProgressRepositoryPort {
  createWorldGenerationProgress(transaction: WorldCampaignCommandContext, scope: WorldGenerationProgressScope): Promise<WorldCampaignRepositoryResult<void>>;
  updateWorldGenerationProgress(transaction: WorldCampaignCommandContext, scope: WorldGenerationProgressScope, update: WorldGenerationProgressUpdate): Promise<WorldCampaignRepositoryResult<void>>;
  getWorldGenerationProgress(transaction: WorldCampaignReadContext, scope: WorldGenerationProgressScope): Promise<WorldGenerationProgressView | null>;
  deleteExpiredWorldGenerationProgress(transaction: WorldCampaignCommandContext, scope: OwnerScope, expiredBefore: string): Promise<WorldCampaignRepositoryResult<number>>;
}

export type WorldCampaignApplicationDependencies = Readonly<{
  transaction: WorldCampaignTransactionPort;
  worlds: WorldRepositoryPort;
  campaigns: CampaignRepositoryPort;
  state: CampaignStateRepositoryPort;
  sync: CampaignSyncRepositoryPort;
  turnPages: BoundedCampaignTurnPagePort;
  characters: CharacterProfileRepositoryPort;
  characterOrganizer: CharacterProfileOrganizerPort;
  transfers: CampaignTransferRepositoryPort;
  dashboard: DashboardRepositoryPort;
  sessionProfile: SessionProfileRepositoryPort;
  worldGeneration: WorldGenerationCollaboratorPort;
  progress: WorldGenerationProgressRepositoryPort;
}>;

export interface WorldCampaignApplication {
  listWorlds(scope: OwnerScope): Promise<WorldListView>;
  getWorld(scope: WorldScope): Promise<WorldAggregateView>;
  createWorld(scope: OwnerScope, request: WorldCreateRequest): Promise<WorldCreateView>;
  updateWorldDraft(scope: WorldScope, request: WorldDraftUpdateRequest): Promise<WorldDraftUpdateView>;
  publishWorld(scope: WorldScope, request: WorldPublishRequest): Promise<WorldPublicationView>;
  updateWorldStatus(scope: WorldScope, request: WorldStatusUpdateRequest): Promise<WorldStatusView>;
  forkWorld(scope: WorldScope, request: WorldForkRequest): Promise<WorldForkView>;
  exportWorld(scope: WorldScope | WorldVersionScope): Promise<PortableWorldPayload>;
  previewWorldImport(scope: OwnerScope, request: WorldImportRequest): Promise<WorldImportPreviewView>;
  importWorld(scope: OwnerScope, request: WorldImportRequest): Promise<WorldImportResultView>;
  deleteWorld(scope: WorldScope, request: ResourceDeleteRequest): Promise<void>;
  deleteWorldVersion(scope: WorldVersionScope, request: WorldVersionDeleteRequest): Promise<void>;
  promoteCampaignDiscoveries(scope: CampaignScope, request: Readonly<{ draftWorldId: string; expectedWorldVersionId: string; discoveryFactIds: readonly string[] }>): Promise<WorldPromotionView>;
  listCampaigns(scope: OwnerScope): Promise<CampaignListView>;
  createCampaign(scope: OwnerScope, request: CampaignCreateRequest): Promise<CampaignCreateView>;
  updateCampaign(scope: CampaignScope, request: CampaignUpdateRequest): Promise<CampaignUpdateView>;
  deleteCampaign(scope: CampaignScope, request: ResourceDeleteRequest): Promise<void>;
  listWorldVersionPlayableCharacters(scope: WorldVersionScope): Promise<readonly PlayableCharacterSummaryItemView[]>;
  getWorldVersionPlayableCharacterSummary(scope: WorldVersionScope): Promise<PlayableCharacterSummaryView>;
  migrateCampaignWorldVersion(scope: CampaignScope, request: CampaignWorldMigrationRequest): Promise<CampaignMigrationView>;
  syncPlayerCampaignConfig(scope: CampaignScope, request: PlayerCampaignConfig): Promise<CampaignPlayerConfigSyncView>;
  rewindCampaign(scope: CampaignScope, request: CampaignRewindRequest): Promise<CampaignRewindView>;
  branchCampaign(scope: CampaignScope, request: CampaignBranchRequest): Promise<CampaignBranchView>;
  loadEffectiveCampaignStateEdit(scope: CampaignScope): Promise<CampaignStateEditView>;
  getCampaignRuntimeState(scope: CampaignScope, requestedTurnNumber?: number): Promise<CampaignStateCorrectionView>;
  updateCampaignRuntimeState(scope: CampaignScope, request: CampaignRuntimeStateUpdate): Promise<CampaignStateCorrectionView>;
  getCampaignSyncStatus(scope: CampaignScope, request: SyncStatusRequest): Promise<CampaignSyncStatusView>;
  getCampaignCharacterProfile(scope: CampaignScope): Promise<CharacterProfileView>;
  updateCampaignCharacterProfile(scope: CampaignScope, request: CampaignCharacterProfileUpdate): Promise<CharacterProfileUpdateView>;
  organizeCampaignCharacterProfile(scope: CampaignScope, request: CharacterProfileOrganizationRequest): Promise<CharacterProfileOrganizationView>;
  organizeWorldCharacterProfile(scope: WorldScope, request: CharacterProfileOrganizationRequest): Promise<CharacterProfileOrganizationView>;
  previewCampaignWorldTransfer(scope: CampaignScope, request: CampaignTransferPreviewRequest): Promise<CampaignTransferView>;
  transferCampaignWorld(scope: CampaignScope, request: CampaignTransferCommitRequest): Promise<CampaignTransferResultView>;
  getDashboard(scope: OwnerScope): Promise<DashboardView>;
  getSessionProfile(scope: OwnerScope): Promise<SessionProfileView>;
  updateSessionProfile(scope: OwnerScope, request: UserProfileUpdate): Promise<SessionProfileView>;
  generateWorldPreview(scope: OwnerScope, request: WorldGenerationPreviewRequest): Promise<GeneratedWorldPreviewView>;
  generatePlayableCharacterPreview(scope: OwnerScope, request: PlayableCharacterGenerationPreviewRequest): Promise<GeneratedPlayableCharacterView>;
  generatePlayableCharacter(scope: WorldScope, request: PlayableCharacterGenerationRequest): Promise<GeneratedPlayableCharacterView>;
  createWorldGenerationProgress(scope: WorldGenerationProgressScope): Promise<void>;
  updateWorldGenerationProgress(scope: WorldGenerationProgressScope, update: WorldGenerationProgressUpdate): Promise<void>;
  getWorldGenerationProgress(scope: WorldGenerationProgressScope): Promise<WorldGenerationProgressView | null>;
  deleteExpiredWorldGenerationProgress(scope: OwnerScope, expiredBefore: string): Promise<number>;
}
