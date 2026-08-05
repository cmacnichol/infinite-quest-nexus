import type {
  BoundedCampaignTurnPage,
  BoundedCampaignTurnPageRequest,
  CampaignBranchRequest,
  CampaignCharacterProfileUpdate,
  CampaignCreateRequest,
  CampaignListView,
  CampaignRewindRequest,
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
  CampaignView,
  CampaignWorldMigrationRequest,
  CharacterProfileOrganizationRequest,
  CharacterProfileView,
  DashboardView,
  PlayerCampaignConfig,
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
  WorldDraftUpdateRequest,
  WorldForkRequest,
  WorldGenerationPreviewRequest,
  WorldGenerationProgressScope,
  WorldGenerationProgressUpdate,
  WorldGenerationProgressView,
  WorldGenerationView,
  WorldImportRequest,
  WorldListView,
  WorldPublishRequest,
  WorldScope,
  WorldStatusUpdateRequest,
  WorldVersionDeleteRequest,
  WorldVersionScope,
  WorldView
} from "./types.js";
import type { OwnerScope } from "../generation/types.js";

export interface WorldCampaignTransactionPort {
  command<T>(work: (transaction: WorldCampaignCommandContext) => Promise<T>): Promise<T>;
  read<T>(work: (transaction: WorldCampaignReadContext) => Promise<T>): Promise<T>;
}

export interface WorldRepositoryPort {
  listWorlds(transaction: WorldCampaignReadContext, scope: OwnerScope): Promise<WorldListView>;
  getWorld(transaction: WorldCampaignReadContext, scope: WorldScope): Promise<WorldView>;
  createWorld(transaction: WorldCampaignCommandContext, scope: OwnerScope, request: WorldCreateRequest): Promise<WorldCampaignRepositoryResult<WorldView>>;
  updateWorldDraft(transaction: WorldCampaignCommandContext, scope: WorldScope, request: WorldDraftUpdateRequest): Promise<WorldCampaignRepositoryResult<WorldView>>;
  publishWorld(transaction: WorldCampaignCommandContext, scope: WorldScope, request: WorldPublishRequest): Promise<WorldCampaignRepositoryResult<WorldView>>;
  updateWorldStatus(transaction: WorldCampaignCommandContext, scope: WorldScope, request: WorldStatusUpdateRequest): Promise<WorldCampaignRepositoryResult<WorldView>>;
  forkWorld(transaction: WorldCampaignCommandContext, scope: WorldScope, request: WorldForkRequest): Promise<WorldCampaignRepositoryResult<WorldView>>;
  exportWorld(transaction: WorldCampaignReadContext, scope: WorldScope | WorldVersionScope): Promise<PortableWorldPayload>;
  previewWorldImport(transaction: WorldCampaignReadContext, scope: OwnerScope, request: WorldImportRequest): Promise<WorldView>;
  importWorld(transaction: WorldCampaignCommandContext, scope: OwnerScope, request: WorldImportRequest): Promise<WorldCampaignRepositoryResult<WorldView>>;
  deleteWorld(transaction: WorldCampaignCommandContext, scope: WorldScope, request: ResourceDeleteRequest): Promise<WorldCampaignRepositoryResult<void>>;
  deleteWorldVersion(transaction: WorldCampaignCommandContext, scope: WorldVersionScope, request: WorldVersionDeleteRequest): Promise<WorldCampaignRepositoryResult<void>>;
  promoteCampaignDiscoveries(transaction: WorldCampaignCommandContext, scope: CampaignScope, request: Readonly<{ draftWorldId: string; expectedWorldVersionId: string; discoveryFactIds: readonly string[] }>): Promise<WorldCampaignRepositoryResult<WorldView>>;
}

export interface CampaignRepositoryPort {
  listCampaigns(transaction: WorldCampaignReadContext, scope: OwnerScope): Promise<CampaignListView>;
  createCampaign(transaction: WorldCampaignCommandContext, scope: OwnerScope, request: CampaignCreateRequest): Promise<WorldCampaignRepositoryResult<CampaignView>>;
  updateCampaign(transaction: WorldCampaignCommandContext, scope: CampaignScope, request: CampaignUpdateRequest): Promise<WorldCampaignRepositoryResult<CampaignView>>;
  deleteCampaign(transaction: WorldCampaignCommandContext, scope: CampaignScope, request: ResourceDeleteRequest): Promise<WorldCampaignRepositoryResult<void>>;
  listWorldVersionPlayableCharacters(transaction: WorldCampaignReadContext, scope: WorldVersionScope): Promise<Readonly<Record<string, unknown>>>;
  getWorldVersionPlayableCharacterSummary(transaction: WorldCampaignReadContext, scope: WorldVersionScope): Promise<Readonly<Record<string, unknown>>>;
  migrateCampaignWorldVersion(transaction: WorldCampaignCommandContext, scope: CampaignScope, request: CampaignWorldMigrationRequest): Promise<WorldCampaignRepositoryResult<CampaignView>>;
  syncPlayerCampaignConfig(transaction: WorldCampaignCommandContext, scope: CampaignScope, request: PlayerCampaignConfig): Promise<WorldCampaignRepositoryResult<CampaignView>>;
  rewindCampaign(transaction: WorldCampaignCommandContext, scope: CampaignScope, request: CampaignRewindRequest): Promise<WorldCampaignRepositoryResult<CampaignView>>;
  branchCampaign(transaction: WorldCampaignCommandContext, scope: CampaignScope, request: CampaignBranchRequest): Promise<WorldCampaignRepositoryResult<CampaignView>>;
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
  updateCampaignCharacterProfile(transaction: WorldCampaignCommandContext, scope: CampaignScope, request: CampaignCharacterProfileUpdate): Promise<WorldCampaignRepositoryResult<CharacterProfileView>>;
}

/** Temporary 14c -> 14d provider/prompt collaborator; it carries no profile or credential object. */
export interface CharacterProfileOrganizerPort {
  organizeCampaignCharacterProfile(scope: CampaignScope, request: CharacterProfileOrganizationRequest): Promise<CharacterProfileView>;
  organizeWorldCharacterProfile(scope: WorldScope, request: CharacterProfileOrganizationRequest): Promise<CharacterProfileView>;
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
  generateWorldPreview(scope: OwnerScope, request: WorldGenerationPreviewRequest): Promise<WorldGenerationView>;
  generatePlayableCharacterPreview(scope: OwnerScope, request: PlayableCharacterGenerationPreviewRequest): Promise<WorldGenerationView>;
  generatePlayableCharacter(scope: WorldScope, request: PlayableCharacterGenerationRequest): Promise<WorldGenerationView>;
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
  getWorld(scope: WorldScope): Promise<WorldView>;
  createWorld(scope: OwnerScope, request: WorldCreateRequest): Promise<WorldView>;
  updateWorldDraft(scope: WorldScope, request: WorldDraftUpdateRequest): Promise<WorldView>;
  publishWorld(scope: WorldScope, request: WorldPublishRequest): Promise<WorldView>;
  updateWorldStatus(scope: WorldScope, request: WorldStatusUpdateRequest): Promise<WorldView>;
  forkWorld(scope: WorldScope, request: WorldForkRequest): Promise<WorldView>;
  exportWorld(scope: WorldScope | WorldVersionScope): Promise<PortableWorldPayload>;
  previewWorldImport(scope: OwnerScope, request: WorldImportRequest): Promise<WorldView>;
  importWorld(scope: OwnerScope, request: WorldImportRequest): Promise<WorldView>;
  deleteWorld(scope: WorldScope, request: ResourceDeleteRequest): Promise<void>;
  deleteWorldVersion(scope: WorldVersionScope, request: WorldVersionDeleteRequest): Promise<void>;
  promoteCampaignDiscoveries(scope: CampaignScope, request: Readonly<{ draftWorldId: string; expectedWorldVersionId: string; discoveryFactIds: readonly string[] }>): Promise<WorldView>;
  listCampaigns(scope: OwnerScope): Promise<CampaignListView>;
  createCampaign(scope: OwnerScope, request: CampaignCreateRequest): Promise<CampaignView>;
  updateCampaign(scope: CampaignScope, request: CampaignUpdateRequest): Promise<CampaignView>;
  deleteCampaign(scope: CampaignScope, request: ResourceDeleteRequest): Promise<void>;
  listWorldVersionPlayableCharacters(scope: WorldVersionScope): Promise<Readonly<Record<string, unknown>>>;
  getWorldVersionPlayableCharacterSummary(scope: WorldVersionScope): Promise<Readonly<Record<string, unknown>>>;
  migrateCampaignWorldVersion(scope: CampaignScope, request: CampaignWorldMigrationRequest): Promise<CampaignView>;
  syncPlayerCampaignConfig(scope: CampaignScope, request: PlayerCampaignConfig): Promise<CampaignView>;
  rewindCampaign(scope: CampaignScope, request: CampaignRewindRequest): Promise<CampaignView>;
  branchCampaign(scope: CampaignScope, request: CampaignBranchRequest): Promise<CampaignView>;
  loadEffectiveCampaignStateEdit(scope: CampaignScope): Promise<CampaignStateEditView>;
  getCampaignRuntimeState(scope: CampaignScope, requestedTurnNumber?: number): Promise<CampaignStateCorrectionView>;
  updateCampaignRuntimeState(scope: CampaignScope, request: CampaignRuntimeStateUpdate): Promise<CampaignStateCorrectionView>;
  getCampaignSyncStatus(scope: CampaignScope, request: SyncStatusRequest): Promise<CampaignSyncStatusView>;
  getCampaignCharacterProfile(scope: CampaignScope): Promise<CharacterProfileView>;
  updateCampaignCharacterProfile(scope: CampaignScope, request: CampaignCharacterProfileUpdate): Promise<CharacterProfileView>;
  organizeCampaignCharacterProfile(scope: CampaignScope, request: CharacterProfileOrganizationRequest): Promise<CharacterProfileView>;
  organizeWorldCharacterProfile(scope: WorldScope, request: CharacterProfileOrganizationRequest): Promise<CharacterProfileView>;
  previewCampaignWorldTransfer(scope: CampaignScope, request: CampaignTransferPreviewRequest): Promise<CampaignTransferView>;
  transferCampaignWorld(scope: CampaignScope, request: CampaignTransferCommitRequest): Promise<CampaignTransferResultView>;
  getDashboard(scope: OwnerScope): Promise<DashboardView>;
  getSessionProfile(scope: OwnerScope): Promise<SessionProfileView>;
  updateSessionProfile(scope: OwnerScope, request: UserProfileUpdate): Promise<SessionProfileView>;
  generateWorldPreview(scope: OwnerScope, request: WorldGenerationPreviewRequest): Promise<WorldGenerationView>;
  generatePlayableCharacterPreview(scope: OwnerScope, request: PlayableCharacterGenerationPreviewRequest): Promise<WorldGenerationView>;
  generatePlayableCharacter(scope: WorldScope, request: PlayableCharacterGenerationRequest): Promise<WorldGenerationView>;
  createWorldGenerationProgress(scope: WorldGenerationProgressScope): Promise<void>;
  updateWorldGenerationProgress(scope: WorldGenerationProgressScope, update: WorldGenerationProgressUpdate): Promise<void>;
  getWorldGenerationProgress(scope: WorldGenerationProgressScope): Promise<WorldGenerationProgressView | null>;
  deleteExpiredWorldGenerationProgress(scope: OwnerScope, expiredBefore: string): Promise<number>;
}
