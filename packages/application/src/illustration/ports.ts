import type {
  AcceptedTurnIllustrationRequest,
  CampaignIllustrationScope,
  CampaignIllustrationSegments,
  GenerationIllustrationScope,
  IllustrationBackfillPreview,
  IllustrationBackfillPreviewResult,
  IllustrationBackfillRequest,
  IllustrationBackfillResult,
  IllustrationConfig,
  IllustrationConfigView,
  IllustrationImageArtifact,
  IllustrationImageExecutionRequest,
  IllustrationImageExecutionResult,
  IllustrationImageJob,
  IllustrationPromptRefinementRequest,
  IllustrationPromptRefinementResult,
  IllustrationRematchResult,
  IllustrationRequest,
  IllustrationSegmentImageRequest,
  IllustrationSegmentImageResult,
  IllustrationSegmentRequest,
  IllustrationSegmentSetResult,
  IllustrationTransactionContext,
  IllustrationWorkerJobScope,
  IllustrationWorkerJobTransition,
  IllustrationWorkerPromptResolution,
  IllustrationWorkerRequest,
  IllustrationWorkerRetry,
  ClaimedIllustrationWorkerJob,
  ImageJobScope,
  PromoteProvisionalIllustrationRequest,
  PromotedIllustrationScope,
  ProvisionalIllustrationSegmentRequest,
  ProvisionalIllustrationSetRequest,
  ProvisionalSegmentScope,
  QueuedIllustrationImageJob,
  RemovedIllustrationVariant,
  SegmentIllustrationScope,
  StreamingIllustrationConfig,
  TurnIllustrationResolution,
  TurnIllustrationScope,
  WorldCoverRequest,
  WorldIllustrationScope
} from "./types.js";

export interface IllustrationConfigRepository {
  getIllustrationConfig(scope: CampaignIllustrationScope): Promise<IllustrationConfigView>;
  setIllustrationConfig(
    scope: CampaignIllustrationScope,
    config: IllustrationConfig,
  ): Promise<IllustrationConfigView>;
}

export interface IllustrationJobRepository {
  enqueueWorldCover(
    scope: WorldIllustrationScope,
    request: WorldCoverRequest,
  ): Promise<QueuedIllustrationImageJob>;
  getLatestWorldCoverJob(scope: WorldIllustrationScope): Promise<IllustrationImageJob | null>;
  enqueueAcceptedTurnIllustration(
    scope: TurnIllustrationScope,
    request: AcceptedTurnIllustrationRequest,
  ): Promise<string | null>;
  enqueueIllustration(
    scope: TurnIllustrationScope,
    request: IllustrationRequest,
  ): Promise<QueuedIllustrationImageJob>;
  getImageJob(scope: ImageJobScope): Promise<IllustrationImageJob>;
  listCampaignImageJobs(scope: CampaignIllustrationScope): Promise<readonly IllustrationImageJob[]>;
  retryImageJob(scope: ImageJobScope): Promise<IllustrationImageJob>;
}

export interface IllustrationSegmentRepository {
  generateTurnIllustrationSegments(
    scope: TurnIllustrationScope,
    request: IllustrationSegmentRequest,
  ): Promise<IllustrationSegmentSetResult>;
  enqueueAcceptedTurnIllustrationSegments(
    scope: TurnIllustrationScope,
  ): Promise<IllustrationSegmentSetResult | null>;
  previewIllustrationBackfill(
    scope: CampaignIllustrationScope,
    request: IllustrationBackfillPreview,
  ): Promise<IllustrationBackfillPreviewResult>;
  enqueueIllustrationBackfill(
    scope: CampaignIllustrationScope,
    request: IllustrationBackfillRequest,
  ): Promise<IllustrationBackfillResult>;
  listCampaignIllustrationSegments(
    scope: CampaignIllustrationScope,
  ): Promise<CampaignIllustrationSegments>;
  regenerateSegmentIllustration(
    scope: SegmentIllustrationScope,
    request: IllustrationSegmentImageRequest,
  ): Promise<IllustrationSegmentImageResult>;
  removeSegmentIllustrationVariant(
    scope: SegmentIllustrationScope,
    variantIndex: number,
  ): Promise<RemovedIllustrationVariant>;
}

export interface IllustrationResolutionRepository {
  getTurnIllustrationResolution(
    scope: TurnIllustrationScope,
  ): Promise<TurnIllustrationResolution | null>;
  rematchTurnIllustration(scope: TurnIllustrationScope): Promise<IllustrationRematchResult>;
}

export interface IllustrationStreamingRepository {
  loadStreamingIllustrationConfig(
    scope: CampaignIllustrationScope,
  ): Promise<StreamingIllustrationConfig>;
  createProvisionalSet(
    scope: GenerationIllustrationScope,
    request: ProvisionalIllustrationSetRequest,
  ): Promise<string | null>;
  createProvisionalSegment(
    scope: ProvisionalSegmentScope,
    request: ProvisionalIllustrationSegmentRequest,
  ): Promise<boolean>;
  promoteProvisionalSet(
    scope: PromotedIllustrationScope,
    request: PromoteProvisionalIllustrationRequest,
  ): Promise<void>;
  orphanProvisionalSet(scope: GenerationIllustrationScope): Promise<void>;
}

/**
 * Generation owns the outer accepted-turn transaction. These callbacks keep
 * illustration reads and writes inside that caller-owned transaction so
 * optional image work cannot split authoritative turn acceptance into a second
 * commit.
 */
export interface IllustrationGenerationTransactionPort {
  loadStreamingIllustrationConfig(
    database: IllustrationTransactionContext,
    scope: CampaignIllustrationScope,
  ): Promise<StreamingIllustrationConfig>;
  createProvisionalSet(
    database: IllustrationTransactionContext,
    scope: GenerationIllustrationScope,
    request: ProvisionalIllustrationSetRequest,
  ): Promise<string | null>;
  createProvisionalSegment(
    database: IllustrationTransactionContext,
    scope: ProvisionalSegmentScope,
    request: ProvisionalIllustrationSegmentRequest,
  ): Promise<boolean>;
  promoteProvisionalSet(
    database: IllustrationTransactionContext,
    scope: PromotedIllustrationScope,
    request: PromoteProvisionalIllustrationRequest,
  ): Promise<void>;
  orphanProvisionalSet(
    database: IllustrationTransactionContext,
    scope: GenerationIllustrationScope,
  ): Promise<void>;
  enqueueAcceptedTurnIllustrationSegments(
    database: IllustrationTransactionContext,
    scope: TurnIllustrationScope,
  ): Promise<IllustrationSegmentSetResult | null>;
}

export type IllustrationApplicationDependencies = Readonly<{
  config: IllustrationConfigRepository;
  jobs: IllustrationJobRepository;
  segments: IllustrationSegmentRepository;
  resolutions: IllustrationResolutionRepository;
  streaming: IllustrationStreamingRepository;
  transaction: IllustrationGenerationTransactionPort;
}>;

export interface IllustrationApplication
  extends IllustrationConfigRepository,
    IllustrationJobRepository,
    IllustrationSegmentRepository,
    IllustrationResolutionRepository,
    IllustrationStreamingRepository {
  readonly generation: IllustrationGenerationTransactionPort;
}

export interface IllustrationWorkerExecutor {
  runNextIllustration(request: IllustrationWorkerRequest): Promise<boolean>;
}

/**
 * Typed state-machine surface for the three durable illustration job families.
 * Claim fencing and status transitions remain authoritative database work; they
 * are deliberately separate from provider, artifact, and asset ports.
 */
export interface IllustrationWorkerStateMachinePort {
  claimNextPromptJob(request: IllustrationWorkerRequest): Promise<ClaimedIllustrationWorkerJob | null>;
  claimNextResolutionJob(request: IllustrationWorkerRequest): Promise<ClaimedIllustrationWorkerJob | null>;
  claimNextImageJob(request: IllustrationWorkerRequest): Promise<ClaimedIllustrationWorkerJob | null>;
  loadClaimedJob(scope: IllustrationWorkerJobScope): Promise<ClaimedIllustrationWorkerJob | null>;
  heartbeatClaim(scope: IllustrationWorkerJobScope): Promise<boolean>;
  transitionClaim(scope: IllustrationWorkerJobScope, transition: IllustrationWorkerJobTransition): Promise<boolean>;
  scheduleRetry(scope: IllustrationWorkerJobScope, retry: IllustrationWorkerRetry): Promise<boolean>;
  resolvePrompt(scope: IllustrationWorkerJobScope): Promise<IllustrationWorkerPromptResolution | null>;
  runPromptHandler(request: IllustrationWorkerRequest): Promise<boolean>;
  runResolutionHandler(request: IllustrationWorkerRequest): Promise<boolean>;
  runImageHandler(request: IllustrationWorkerRequest): Promise<boolean>;
}

/**
 * Temporary 14a -> 14d binding. It deliberately exposes only image execution;
 * text-provider credentials and response chains cannot flow through this port.
 */
export interface IllustrationImageProviderPort {
  executeImage(request: IllustrationImageExecutionRequest): Promise<IllustrationImageExecutionResult>;
}

/**
 * Temporary 14a -> 14d binding for fiction-only prompt refinement. Keeping it
 * separate from IllustrationImageProviderPort prevents endpoint/credential reuse.
 */
export interface IllustrationPromptRefinementPort {
  refinePrompt(
    request: IllustrationPromptRefinementRequest,
  ): Promise<IllustrationPromptRefinementResult>;
}

export interface IllustrationPromptSnapshotPort {
  loadIllustrationPromptSnapshot(
    scope: CampaignIllustrationScope,
  ): Promise<Readonly<Record<string, unknown>>>;
}

export interface IllustrationCostPort {
  recordIllustrationCost(input: Readonly<{
    ownerUserId: string;
    campaignId?: string;
    imageJobId?: string;
    promptJobId?: string;
    providerProfileId: string;
    operation: "image_generation" | "prompt_refinement";
    usage: Readonly<Record<string, unknown>>;
  }>): Promise<string | null>;
}

/** Temporary 14a -> 14e binding for durable asset persistence. */
export interface IllustrationAssetPort {
  persistTurnIllustration(input: Readonly<{
    ownerUserId: string;
    campaignId: string;
    turnId: string | null;
    imageJobId: string;
    bytes: Uint8Array;
    mimeType: string;
  }>): Promise<Readonly<{ assetId: string }>>;
  persistWorldCover(input: Readonly<{
    ownerUserId: string;
    worldId: string;
    imageJobId: string;
    bytes: Uint8Array;
    mimeType: string;
  }>): Promise<Readonly<{ assetId: string }>>;
  bindSegmentAsset(input: Readonly<{
    ownerUserId: string;
    campaignId: string;
    turnId: string | null;
    segmentId: string;
    imageJobId: string;
    assetId: string;
    variantIndex: number;
  }>): Promise<boolean>;
}

export interface IllustrationArtifactDownloadPort {
  downloadArtifact(input: Readonly<{
    ownerUserId: string;
    imageJobId: string;
    artifact: IllustrationImageArtifact;
    timeoutMs: number;
    allowPrivateHosts: boolean;
    maximumBytes: number;
  }>): Promise<Readonly<{
    bytes: Uint8Array;
    mimeType: string;
  }>>;
}

export type IllustrationWorkerPorts = Readonly<{
  imageProvider: IllustrationImageProviderPort;
  promptRefinement: IllustrationPromptRefinementPort;
  artifactDownload: IllustrationArtifactDownloadPort;
  assets: IllustrationAssetPort;
}>;

export type IllustrationWorkerApplicationDependencies = Readonly<{
  executor: IllustrationWorkerExecutor;
  ports: IllustrationWorkerPorts;
  state: IllustrationWorkerStateMachinePort;
}>;

/**
 * The worker application owns the execution boundary and the concrete ports
 * that image, refinement, artifact, and asset handlers require. Task 14a3
 * will switch the live lanes to these methods; 14a2 deliberately does not.
 */
export interface IllustrationWorkerApplication
  extends IllustrationWorkerExecutor,
    IllustrationWorkerStateMachinePort,
    IllustrationImageProviderPort,
    IllustrationPromptRefinementPort,
    IllustrationArtifactDownloadPort,
    IllustrationAssetPort {}
