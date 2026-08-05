import type {
  CampaignCostSummaryView,
  CampaignCostScope,
  CreateProviderProfileCommand,
  DeleteProviderProfileCommand,
  DeleteProviderProfileResult,
  DirectProviderResolution,
  DirectProviderRole,
  EmbeddingProviderResolution,
  EmbeddingResolutionRequest,
  GenerationCostAttributionScope,
  PromptLibraryView,
  PromptPreviewRequest,
  PromptPreviewView,
  PromptScope,
  PromptSnapshotVersion,
  ProviderCandidate,
  ProviderCostRecordCommand,
  ProviderCostTransactionContext,
  ProviderHealthRecord,
  ProviderModelInventory,
  ProviderModelInventoryRequest,
  ProviderProfileMutationResult,
  ProviderProfileView,
  ProviderResolutionRequest,
  ProviderRole,
  ReportedCostView,
  ResetPromptOverrideCommand,
  SafeProviderConfiguration,
  SavePromptOverrideCommand,
  SetDefaultProviderCommand,
  TurnCostScope,
  TurnIntentClassificationCommand,
  TurnIntentClassificationView,
  UpdateProviderProfileCommand
} from "./types.js";
import type { OwnerScope } from "../generation/types.js";

export interface ProviderProfilePort {
  listProfiles(scope: OwnerScope): Promise<readonly ProviderProfileView[]>;
  createProfile(command: CreateProviderProfileCommand): Promise<ProviderProfileView>;
  updateProfile(command: UpdateProviderProfileCommand): Promise<ProviderProfileView>;
  deleteProfile(command: DeleteProviderProfileCommand): Promise<DeleteProviderProfileResult>;
  setDefaultProfile(command: SetDefaultProviderCommand): Promise<ProviderProfileView>;
}

export interface ProviderModelInventoryPort {
  listModels(request: ProviderModelInventoryRequest): Promise<ProviderModelInventory>;
  discoverCandidateModels(candidate: ProviderCandidate): Promise<ProviderModelInventory>;
}

export interface ProviderHealthPort {
  recordHealth(record: ProviderHealthRecord): Promise<void>;
}

export interface ProviderResolutionPort {
  resolveDirect<R extends DirectProviderRole>(
    request: ProviderResolutionRequest<R>,
  ): Promise<DirectProviderResolution<R>>;
  resolveEmbedding(request: EmbeddingResolutionRequest): Promise<EmbeddingProviderResolution>;
}

export interface PromptLibraryPort {
  listPromptLibrary(scope: PromptScope): Promise<PromptLibraryView>;
  previewPrompt(request: PromptPreviewRequest): Promise<PromptPreviewView>;
  savePromptOverride(command: SavePromptOverrideCommand): Promise<PromptLibraryView>;
  resetPromptOverride(command: ResetPromptOverrideCommand): Promise<PromptLibraryView>;
  loadPromptSnapshot(scope: PromptScope): Promise<PromptSnapshotVersion>;
}

export interface TurnIntentClassificationPort {
  classifyTurnIntent(command: TurnIntentClassificationCommand): Promise<TurnIntentClassificationView>;
}

export interface ProviderCostPort {
  recordCost(
    database: ProviderCostTransactionContext,
    command: ProviderCostRecordCommand,
  ): Promise<string | null>;
  attributeGenerationCostsToTurn(
    database: ProviderCostTransactionContext,
    scope: GenerationCostAttributionScope,
  ): Promise<void>;
  getTurnCosts(scope: TurnCostScope): Promise<ReadonlyMap<string, ReportedCostView>>;
  getCampaignCostSummary(scope: CampaignCostScope): Promise<CampaignCostSummaryView>;
}

/** Opaque capability; it never contains plaintext or encrypted credential material. */
export type OpaqueProviderCredentialReference = Readonly<{
  kind: "provider_credential_reference";
  referenceId: string;
}>;

/** Server-side association record, observable only through the runtime lease port. */
export type ProviderCredentialReferenceRecord = OwnerScope & Readonly<{
  providerProfileId: string;
  providerRole: ProviderRole;
  credential: OpaqueProviderCredentialReference | null;
}>;

/**
 * Runtime-only lease for pinned provider transport. It contains an opaque
 * reference, never an API key, ciphertext, nonce, authentication tag, or key.
 */
export type ProviderTransportLease<R extends ProviderRole = ProviderRole> = OwnerScope & Readonly<{
  leaseId: string;
  providerProfileId: string;
  providerRole: R;
  baseUrl: string;
  model: string;
  requestTimeoutMs: number;
  configuration: SafeProviderConfiguration;
  credential: OpaqueProviderCredentialReference | null;
  expiresAt: string;
}>;

/** Distinct runtime boundary; ProviderApplication never accepts or returns a lease. */
export interface ProviderRuntimeLeasePort {
  credentialReference(scope: OwnerScope, providerProfileId: string): Promise<ProviderCredentialReferenceRecord>;
  leaseResolved<R extends ProviderRole>(
    scope: OwnerScope,
    providerProfileId: string,
    providerRole: R,
    model: string,
  ): Promise<ProviderTransportLease<R>>;
}

export type CampaignProviderConsumerScope = OwnerScope & Readonly<{ campaignId: string }>;
export type WorldProviderConsumerScope = OwnerScope & Readonly<{ worldId: string }>;
export type ImportProviderConsumerScope = OwnerScope & Readonly<{ importId: string }>;

export interface GenerationPromptPort {
  loadGenerationPromptSnapshot(scope: CampaignProviderConsumerScope): Promise<PromptSnapshotVersion>;
}

export interface IllustrationPromptPort {
  loadIllustrationPromptSnapshot(scope: CampaignProviderConsumerScope): Promise<PromptSnapshotVersion>;
}

export interface ChroniclePromptPort {
  loadChroniclePromptSnapshot(scope: CampaignProviderConsumerScope): Promise<PromptSnapshotVersion>;
}

export interface WorldGenerationPromptPort {
  loadWorldGenerationPromptSnapshot(scope: WorldProviderConsumerScope): Promise<PromptSnapshotVersion>;
}

export interface CharacterOrganizationPromptPort {
  loadCharacterOrganizationPromptSnapshot(
    scope: WorldProviderConsumerScope & Readonly<{ characterId: string }>,
  ): Promise<PromptSnapshotVersion>;
}

export interface InfiniteWorldsPromptPort {
  loadInfiniteWorldsPromptSnapshot(scope: ImportProviderConsumerScope): Promise<PromptSnapshotVersion>;
}

export type ProviderCostRecordFor<C extends ProviderCostRecordCommand["category"]> =
  Omit<ProviderCostRecordCommand, "category"> & Readonly<{ category: C }>;

export interface GenerationCostPort {
  recordGenerationCost(
    database: ProviderCostTransactionContext,
    command: ProviderCostRecordFor<"story">,
  ): Promise<string | null>;
}

export interface ProviderIllustrationCostPort {
  recordIllustrationCost(
    database: ProviderCostTransactionContext,
    command: ProviderCostRecordFor<"image">,
  ): Promise<string | null>;
}

export interface ChronicleCostPort {
  recordChronicleCost(
    database: ProviderCostTransactionContext,
    command: ProviderCostRecordFor<"memory">,
  ): Promise<string | null>;
}

export interface WorldGenerationCostPort {
  recordWorldGenerationCost(
    database: ProviderCostTransactionContext,
    command: ProviderCostRecordFor<"story">,
  ): Promise<string | null>;
}

export interface CharacterOrganizationCostPort {
  recordCharacterOrganizationCost(
    database: ProviderCostTransactionContext,
    command: ProviderCostRecordFor<"story">,
  ): Promise<string | null>;
}

export interface InfiniteWorldsCostPort {
  recordInfiniteWorldsCost(
    database: ProviderCostTransactionContext,
    command: ProviderCostRecordFor<"story">,
  ): Promise<string | null>;
}

/** Exact temporary 14c seam; 14d3 owns replacing and deleting its bridge. */
export interface Task14dWorldGenerationBridgePort {
  generateWorld(input: WorldProviderConsumerScope & Readonly<{
    generationId: string;
    request: Readonly<Record<string, unknown>>;
  }>): Promise<Readonly<Record<string, unknown>>>;
}

/** Exact temporary 14c seam; 14d3 owns replacing and deleting its bridge. */
export interface Task14dCharacterProfileOrganizerBridgePort {
  organizeCharacter(input: WorldProviderConsumerScope & Readonly<{
    characterId: string;
    request: Readonly<Record<string, unknown>>;
  }>): Promise<Readonly<Record<string, unknown>>>;
}

export type ProviderApplicationDependencies = Readonly<{
  profiles: ProviderProfilePort;
  inventory: ProviderModelInventoryPort;
  health: ProviderHealthPort;
  resolution: ProviderResolutionPort;
  prompts: PromptLibraryPort;
  intent: TurnIntentClassificationPort;
  costs: ProviderCostPort;
}>;

export interface ProviderApplication
  extends Omit<ProviderProfilePort, "createProfile" | "updateProfile">,
    ProviderModelInventoryPort,
    ProviderHealthPort,
    ProviderResolutionPort,
    PromptLibraryPort,
    TurnIntentClassificationPort,
    ProviderCostPort {
  createProfile(command: CreateProviderProfileCommand): Promise<ProviderProfileMutationResult>;
  updateProfile(command: UpdateProviderProfileCommand): Promise<ProviderProfileMutationResult>;
}
