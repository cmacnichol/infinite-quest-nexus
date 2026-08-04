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
  IllustrationWorkerRequest,
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

export type IllustrationApplicationDependencies = Readonly<{
  config: IllustrationConfigRepository;
  jobs: IllustrationJobRepository;
  segments: IllustrationSegmentRepository;
  resolutions: IllustrationResolutionRepository;
  streaming: IllustrationStreamingRepository;
}>;

export interface IllustrationApplication
  extends IllustrationConfigRepository,
    IllustrationJobRepository,
    IllustrationSegmentRepository,
    IllustrationResolutionRepository,
    IllustrationStreamingRepository {}

export interface IllustrationWorkerExecutor {
  runNextIllustration(request: IllustrationWorkerRequest): Promise<boolean>;
}

export interface IllustrationWorkerApplication {
  runNextIllustration(request: IllustrationWorkerRequest): Promise<boolean>;
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
