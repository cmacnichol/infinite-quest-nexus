import type {
  IllustrationBackfillPreview,
  IllustrationBackfillRequest,
  IllustrationConfig,
  IllustrationRequest,
  IllustrationSegmentImageRequest,
  IllustrationSegmentRequest,
  WorldCoverRequest
} from "@infinite-quest/contracts";

export type IllustrationOwnerScope = Readonly<{
  ownerUserId: string;
}>;

export type CampaignIllustrationScope = IllustrationOwnerScope & Readonly<{
  campaignId: string;
}>;

export type WorldIllustrationScope = IllustrationOwnerScope & Readonly<{
  worldId: string;
}>;

export type TurnIllustrationScope = CampaignIllustrationScope & Readonly<{
  turnId: string;
}>;

export type SegmentIllustrationScope = TurnIllustrationScope & Readonly<{
  segmentId: string;
}>;

export type IllustrationSegmentExecutionScope = CampaignIllustrationScope & Readonly<{
  turnId: string | null;
  segmentId: string;
}>;

export type ImageJobScope = IllustrationOwnerScope & Readonly<{
  jobId: string;
}>;

export type GenerationIllustrationScope = CampaignIllustrationScope & Readonly<{
  generationJobId: string;
}>;

export type ProvisionalSegmentScope = GenerationIllustrationScope & Readonly<{
  setId: string;
}>;

export type PromotedIllustrationScope = GenerationIllustrationScope & Readonly<{
  turnId: string;
}>;

export type IllustrationConfigView = Readonly<
  Omit<IllustrationConfig, "sourcePolicy"> & {
    sourcePolicy: "off" | "library_only" | "library_then_generate" | "generate_only";
    defaultRefinementPrompt: string;
    updatedAt: string | null;
  }
>;

export type StreamingIllustrationConfig = IllustrationConfigView & Readonly<{
  campaignImageProviderProfileId: string | null;
  campaignTextProviderProfileId: string | null;
}>;

export type IllustrationImageJobStatus =
  | "queued"
  | "generating"
  | "provider_pending"
  | "downloading"
  | "completed"
  | "recoverable"
  | "failed"
  | "cancelled"
  | "expired";

export type IllustrationImageJob = Readonly<{
  id: string;
  campaignId: string | null;
  turnId: string | null;
  worldId: string | null;
  targetType: "turn_illustration" | "world_cover" | "streaming_illustration";
  segmentId: string | null;
  generationJobId: string | null;
  imageCount: 1 | 2;
  providerProfileId: string;
  model: string;
  status: IllustrationImageJobStatus;
  attempts: number;
  maxAttempts: number;
  size: string;
  aspectRatio: string;
  quality: IllustrationConfig["quality"];
  outputFormat: IllustrationConfig["outputFormat"];
  assetId: string | null;
  assetUrl: string;
  providerType: string | null;
  generationRevision: number;
  remoteJobId: string | null;
  providerStatus: string | null;
  providerProgress: number | null;
  providerQueuePosition: number | null;
  providerEtaAt: string | null;
  submittedAt: string | null;
  lastPolledAt: string | null;
  nextPollAt: string | null;
  generationDeadline: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}>;

export type QueuedIllustrationImageJob = IllustrationImageJob & Readonly<{
  duplicate: boolean;
}>;

export type IllustrationSegmentSlice = Readonly<{
  ordinal: number;
  startOffset: number;
  endOffset: number;
  startWord: number;
  endWord: number;
  wordCount: number;
  text: string;
}>;

export type IllustrationSegmentSetResult = Readonly<{
  setId: string;
  duplicate: boolean;
  segmentCount: number;
}>;

export type IllustrationBackfillPreviewResult = Readonly<{
  campaignId: string;
  mode: IllustrationBackfillPreview["mode"];
  turnCount: number;
  segmentCount: number;
  imageCount: number;
  providerRequestCount: number;
  refinementCallCount: number;
  configUpdatedAt: string;
  totalCampaignTurns: number;
  settings: Readonly<{
    segmentWordCount: number;
    imagesPerSegment: number;
    segmentPromptMode: IllustrationConfig["segmentPromptMode"];
  }>;
}>;

export type IllustrationBackfillResult = Readonly<{
  id: string;
  status: string;
  turnCount: number;
  segmentCount: number;
  imageCount: number;
  queuedSets: number;
  duplicate: boolean;
}>;

export type IllustrationSegmentVariant = Readonly<{
  assetId: string;
  url: string;
  variantIndex: number;
  prompt: string;
  providerType: string | null;
  model: string | null;
  createdAt: string;
  selectionReason: string | null;
  matchScore: number | null;
  matchThreshold: number | null;
  matchingAlgorithm: string | null;
}>;

export type IllustrationSegmentView = Readonly<{
  setId: string;
  turnId: string;
  setStatus: string;
  segmentWordCount: number;
  imagesPerSegment: number;
  promptMode: IllustrationConfig["segmentPromptMode"];
  id: string;
  ordinal: number;
  startOffset: number;
  endOffset: number;
  startWord: number;
  endWord: number;
  text: string;
  status: string;
  promptSource: string;
  directPrompt: string;
  resolvedPrompt: string;
  variants: readonly IllustrationSegmentVariant[];
  imageJobId: string | null;
  imageJobStatus: IllustrationImageJobStatus | null;
  providerStatus: string | null;
  providerProgress: number | null;
  errorMessage: string | null;
  promptJobStatus: string | null;
}>;

export type CampaignIllustrationSegments = Readonly<{
  segments: readonly IllustrationSegmentView[];
}>;

export type IllustrationSegmentImageResult = Readonly<{
  id: string;
  duplicate: boolean;
  segmentId: string;
  variantIndex: number;
  status?: "queued";
}>;

export type RemovedIllustrationVariant = Readonly<{
  segmentId: string;
  variantIndex: number;
  removedAssetId: string;
  retainedInLibrary: true;
}>;

export type IllustrationMatchCandidate = Readonly<{
  assetId: string;
  rank: number;
  score: number;
  scoreComponents: Readonly<Record<string, unknown>>;
  rejectionReasons: readonly string[];
}>;

export type TurnIllustrationResolution = Readonly<{
  id: string;
  campaignId: string;
  turnId: string;
  sourcePolicy?: string;
  matchingScope?: string;
  confidenceProfile?: string;
  status: string;
  selectedAssetId?: string | null;
  selectedScore?: number | null;
  resolvedThreshold?: number | null;
  algorithmVersion?: string | null;
  imageJobId?: string | null;
  reasonCode?: string | null;
  createdAt?: string;
  updatedAt?: string;
  completedAt?: string | null;
  candidates: readonly IllustrationMatchCandidate[];
}>;

export type IllustrationRematchResult = Readonly<{
  id: string;
  status: "queued";
}>;

export type AcceptedTurnIllustrationRequest = Readonly<{
  imagePrompt: string;
}>;

export type ProvisionalIllustrationSetRequest = Readonly<{
  visualReference?: string;
}>;

export type ProvisionalIllustrationSegmentRequest = Readonly<{
  segment: IllustrationSegmentSlice;
  config: StreamingIllustrationConfig;
  visualReference?: string;
}>;

export type PromoteProvisionalIllustrationRequest = Readonly<{
  finalNarration: string;
  config: StreamingIllustrationConfig;
  visualReference?: string;
}>;

export type IllustrationWorkerRequest = Readonly<{
  workerId: string;
  leaseSeconds: number;
}>;

export type IllustrationWorkerJobFamily = "prompt" | "resolution" | "image";

export type IllustrationWorkerJobScope = IllustrationOwnerScope & Readonly<{
  jobId: string;
  workerId: string;
  leaseSeconds: number;
  family: IllustrationWorkerJobFamily;
}>;

export type ClaimedIllustrationWorkerJob = IllustrationWorkerJobScope & Readonly<{
  campaignId: string | null;
  turnId: string | null;
  worldId: string | null;
  attempts: number;
  maxAttempts: number;
}>;

export type IllustrationWorkerJobTransition = Readonly<{
  status: "generating" | "provider_pending" | "downloading" | "completed" | "recoverable" | "failed" | "cancelled";
  metadata?: Readonly<Record<string, unknown>>;
}>;

export type IllustrationWorkerRetry = Readonly<{
  code: string;
  message: string;
  retryAt?: string;
}>;

export type IllustrationWorkerPromptResolution = Readonly<{
  prompt: string;
  providerProfileId: string | null;
  model: string | null;
}>;

/**
 * Platform-neutral transaction token. Application code must pass this opaque
 * value through to one transaction-scoped adapter rather than opening a second
 * transaction while an accepted turn is being committed.
 */
export type IllustrationTransactionContext = object;

export type IllustrationImageExecutionRequest = ImageJobScope & Readonly<{
  providerProfileId: string;
  model: string;
  prompt: string;
  generationRevision: number;
  idempotencyKey: string;
  imageCount: 1 | 2;
  size: string;
  aspectRatio: string;
  quality: IllustrationConfig["quality"];
  outputFormat: IllustrationConfig["outputFormat"];
  remoteJobId: string | null;
}>;

type IllustrationImageExecutionResultBase = Readonly<{
  providerRole: "image";
  providerProfileId: string;
  model: string;
  metadata: Readonly<Record<string, unknown>>;
}>;

export type IllustrationImageArtifact =
  | Readonly<{
      source: "url";
      url: string;
      mimeType?: string;
      fileName?: string;
    }>
  | Readonly<{
      source: "base64";
      base64: string;
      mimeType?: string;
      fileName?: string;
    }>;

export type IllustrationImageExecutionResult =
  | (IllustrationImageExecutionResultBase & Readonly<{
      status: "pending";
      remoteJobId: string;
      pollAfterMs: number;
      progress: number | null;
      queuePosition: number | null;
      etaSeconds: number | null;
    }>)
  | (IllustrationImageExecutionResultBase & Readonly<{
      status: "completed";
      artifacts: readonly IllustrationImageArtifact[];
      usage: Readonly<Record<string, unknown>>;
      reportedCost: Readonly<{ amount: string; currency: string }> | null;
    }>);

export type IllustrationPromptRefinementRequest = IllustrationSegmentExecutionScope & Readonly<{
  providerProfileId: string;
  model: string;
  systemPrompt: string;
  fictionText: string;
  storyContext: string;
}>;

export type IllustrationPromptRefinementResult = Readonly<{
  providerRole: "text";
  providerProfileId: string;
  model: string;
  prompt: string;
  metadata: Readonly<Record<string, unknown>>;
}>;

export type {
  IllustrationBackfillPreview,
  IllustrationBackfillRequest,
  IllustrationConfig,
  IllustrationRequest,
  IllustrationSegmentImageRequest,
  IllustrationSegmentRequest,
  WorldCoverRequest
};
