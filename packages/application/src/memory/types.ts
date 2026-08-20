import type {
  CampaignEmbeddingConfig,
  ChronicleHealth,
  ChronicleRetrievalAudit,
  MemoryContextQuery,
  RetrievalImplementation
} from "@infinite-quest/contracts";

/** Resolved at the API boundary or read from a claimed worker job; never caller supplied. */
export type MemoryOwnerScope = Readonly<{
  ownerUserId: string;
}>;

export type CampaignMemoryScope = MemoryOwnerScope & Readonly<{
  campaignId: string;
}>;

/** Chronicle reads and writes are always pinned to the campaign's world-version. */
export type CampaignWorldVersionMemoryScope = CampaignMemoryScope & Readonly<{
  worldVersionId: string;
}>;

export type ChronicleJobScope = MemoryOwnerScope & Readonly<{
  jobId: string;
}>;

/**
 * Deliberately opaque caller-owned database context. Application code must pass
 * it through; concrete adapters may never replace it with a pool transaction.
 */
export type MemoryTransactionContext = object;

export type EmbeddingConfigView = Readonly<{
  enabled: boolean;
  providerProfileId?: string | null;
  model?: string;
  batchSize?: number;
  documentPrefix?: string | null;
  queryPrefix?: string | null;
  effectiveDocumentPrefix?: string;
  effectiveQueryPrefix?: string;
  prefixesAutomatic?: boolean;
  retrievalImplementation?: RetrievalImplementation;
  retrievalShadowEnabled?: boolean;
}>;

export type ChronicleMetricsView = Readonly<{
  turns: number;
  completeHistoryCharacters: number;
  estimatedCompleteHistoryTokens: number;
  memoryCount: number;
  memoryTokens: number;
  embeddedMemories: number;
  compressionEstimates: Readonly<{
    full: number;
    balanced: number;
    compact: number;
    summary: number;
  }>;
  semanticHealth: ChronicleHealth;
}>;
export type ChronicleContextPreview = Readonly<Record<string, unknown> & {
  chronicleRetrieval: ChronicleRetrievalAudit;
}>;

/** Fixed public projection: adapters must keep diagnostics and provider details private. */
export const MEMORY_PUBLIC_FAILURE_CODE = "memory_unavailable" as const;
export const MEMORY_PUBLIC_FAILURE_MESSAGE = "Chronicle memory is unavailable." as const;

export type MemoryPublicFailure = Readonly<{
  code: typeof MEMORY_PUBLIC_FAILURE_CODE;
  message: typeof MEMORY_PUBLIC_FAILURE_MESSAGE;
}>;

/** Public reads either contain their safe projection or this fixed failure. */
export type MemoryPublicResult<T> = T | Readonly<{
  failure: MemoryPublicFailure;
}>;

export const memoryPublicFailure = (): MemoryPublicFailure => ({
  code: MEMORY_PUBLIC_FAILURE_CODE,
  message: MEMORY_PUBLIC_FAILURE_MESSAGE
});

export type ChronicleJobStatus = "queued" | "running" | "completed" | "failed";

export type ChronicleJobView = Readonly<{
  id: string;
  campaignId?: string;
  jobType?: "reindex_campaign" | "embed_campaign";
  status: ChronicleJobStatus;
  attempts?: number;
  progress?: Readonly<Record<string, unknown>>;
  createdAt?: string;
  updatedAt?: string;
  completedAt?: string | null;
  /** Present only for terminal public failure; never provider/raw-error text. */
  failure?: MemoryPublicFailure | null;
}>;

export type QueuedChronicleJob = Readonly<{
  jobId: string;
  status: "queued";
  duplicate?: boolean;
}>;

export type DerivedStoryMemory = Readonly<{
  continuitySummary?: string;
  canonicalFacts?: readonly string[];
  supersededFacts?: readonly string[];
  canonicalFactUpdates?: readonly Readonly<{
    content: string;
    supersedesFactIds?: readonly string[];
  }>[];
  openThreads?: readonly string[];
  entityCatalog?: readonly unknown[];
}>;

export type DerivedTurnMemoryScope = CampaignWorldVersionMemoryScope & Readonly<{
  turnId: string;
  ordinal: number;
}>;

export type AcceptedTurnFictionScope = DerivedTurnMemoryScope & Readonly<{
  action: string;
  narration: string;
}>;

/**
 * Generation context retrieval stays inside the caller-owned generation
 * context. Provider credentials remain a runtime binding rather than an
 * application command field.
 */
export type MemoryGenerationContextPreviewScope = CampaignWorldVersionMemoryScope & Readonly<{
  request: MemoryContextPreviewRequest;
  stateOverride?: Readonly<Record<string, unknown>>;
  scratchpadSafeForPrompt?: boolean;
  costAttribution?: Readonly<{
    generationJobId?: string;
    operation?: "retrieval_embedding" | "context_preview_embedding";
  }>;
}>;

export type MemoryWorkerClaimRequest = Readonly<{
  workerId: string;
  leaseSeconds: number;
}>;

/**
 * Every worker retrieval is explicitly bounded. Adapters must reject invalid
 * limits and return a cursor only for the claim's owner/campaign/world version.
 */
export type ChronicleWorkerRetrievalRequest = Readonly<{
  batchLimit: number;
  cursor?: string | null;
}>;

/** One worker lane invocation includes both lease authority and its read window. */
export type ChronicleWorkerRunRequest = MemoryWorkerClaimRequest & Readonly<{
  retrieval: ChronicleWorkerRetrievalRequest;
}>;

export type ClaimedChronicleJob = CampaignWorldVersionMemoryScope & Readonly<{
  jobId: string;
  jobType: "reindex_campaign" | "embed_campaign";
  workVersion: number;
  workerId: string;
  leaseSeconds: number;
}>;

export type ChronicleLeaseScope = ClaimedChronicleJob;

export type ChronicleClaimCompletion = Readonly<{
  progress: Readonly<Record<string, unknown>>;
  /** A newer work version must atomically requeue rather than complete. */
  requeueIfWorkVersionChanged?: boolean;
}>;

export type ChronicleClaimFailure = Readonly<{
  /** Private adapter diagnostics; never copied to ChronicleJobView.failure. */
  diagnosticCode: string;
}>;

export type ChronicleClaimRetry = Readonly<{
  reason: "work_version_changed" | "provider_configuration_changed" | "lease_reclaimed";
}>;

export type ChronicleWorkerRetrieval = Readonly<{
  config: EmbeddingConfigView;
  /** Bounded, owner/campaign/world-version-scoped rows only. */
  memories: readonly Readonly<Record<string, unknown>>[];
  /** Stable total used to guard exact embedding-batch progress. */
  totalMemories: number;
  batchLimit: number;
  nextCursor: string | null;
}>;

export type ChronicleChunkJobProgress = Readonly<{
  parentCursor: string | null;
  processedParents: number;
  embeddedChunks: number;
  skippedChunks: number;
  totalParents: number;
  capabilityFingerprint: string | null;
}>;

export type ClaimedChronicleChunkJob = CampaignWorldVersionMemoryScope & Readonly<{
  jobId: string;
  jobType: "index_memory_chunks_v2";
  workVersion: number;
  workerId: string;
  /** Opaque per-claim authority; regenerated even when the same worker reclaims unchanged work. */
  leaseToken: string;
  leaseSeconds: number;
  progress: ChronicleChunkJobProgress;
}>;

export type ChronicleChunkLeaseScope = ClaimedChronicleChunkJob;

export type ChronicleChunkParent = Readonly<{
  id: string;
  ordinal: number;
  memoryKind: "turn_fiction" | "legacy_summary" | "campaign_summary" | "canonical_fact" | "open_thread";
  content: string;
  contentHash: string;
  entities: readonly string[];
  entityIds: readonly string[];
  metadata: Readonly<Record<string, unknown>>;
}>;

export type ChronicleChunkParentPage = Readonly<{
  config: EmbeddingConfigView;
  providerCapability: Readonly<{
    model: string;
    contextWindowTokens: number;
    requestTimeoutMs: number;
    configuration: Readonly<Record<string, unknown>>;
  }> | null;
  parents: readonly ChronicleChunkParent[];
  totalParents: number;
  batchLimit: number;
  nextCursor: string | null;
}>;

export type ChronicleChunkDraftCommit = Readonly<{
  protocolVersion: "chronicle-chunk-v1";
  parentMemoryId: string;
  kind: "turn_action" | "turn_narration" | "legacy_summary" | "campaign_summary" | "canonical_fact" | "open_thread";
  chunkIndex: number;
  content: string;
  contentHash: string;
  estimatedTokens: number;
  sourceStartOffset: number;
  sourceEndOffset: number;
  embedding: readonly number[] | null;
  skipReason: string | null;
}>;

export type ChronicleChunkEmbeddingProvider = Readonly<{
  id: string;
  model: string;
  providerType: string;
}>;

export type ChronicleChunkEmbeddingResult = Readonly<{
  embeddings: readonly (readonly number[])[];
  responseId: string;
  usage: unknown;
  reportedCost: Readonly<{ amount: string; currency: string }> | null;
}>;

export type ChronicleChunkBatchCommit = Readonly<{
  parent: ChronicleChunkParent;
  previousParentCursor: string | null;
  provider: ChronicleChunkEmbeddingProvider | null;
  providerFingerprint: string | null;
  capabilityFingerprint: string;
  embeddingProtocolVersion: string;
  chunks: readonly ChronicleChunkDraftCommit[];
  embeddingEvidence: readonly (readonly number[])[];
  costResults: readonly ChronicleChunkEmbeddingResult[];
  progress: ChronicleChunkJobProgress;
}>;

export type MemoryContextPreviewRequest = MemoryContextQuery & Readonly<{
  /** API preview is pinned to a world-version even when campaign version later changes. */
  throughTurnNumber?: number;
}>;

export type MemoryEmbeddingConfigInput = CampaignEmbeddingConfig;
