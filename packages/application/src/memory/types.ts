import type { CampaignEmbeddingConfig, MemoryContextQuery, RetrievalImplementation } from "@infinite-quest/contracts";

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
  semanticHealth: Readonly<{
    status: "disabled" | "indexing" | "healthy" | "degraded" | "failed" | "unavailable";
    message: string;
    enabled: boolean;
    providerProfileId: string | null;
    providerName: string;
    providerHealth: "unknown" | "healthy" | "degraded" | "unavailable";
    model: string;
    indexedMemories: number;
    totalMemories: number;
    coveragePercent: number;
    jobId: string | null;
    jobStatus: "queued" | "running" | "completed" | "failed" | null;
    progress: Readonly<{ embedded?: number; total?: number; updated?: number; skipped?: number }>;
    errorMessage: string;
    lastCompletedAt: string | null;
  }>;
}>;
export type ChronicleContextPreview = Readonly<Record<string, unknown>>;

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

export type MemoryContextPreviewRequest = MemoryContextQuery & Readonly<{
  /** API preview is pinned to a world-version even when campaign version later changes. */
  throughTurnNumber?: number;
}>;

export type MemoryEmbeddingConfigInput = CampaignEmbeddingConfig;
