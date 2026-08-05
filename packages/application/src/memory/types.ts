import type { CampaignEmbeddingConfig, MemoryContextQuery } from "@infinite-quest/contracts";

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
}>;

export type ChronicleMetricsView = Readonly<Record<string, unknown>>;
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

export type MemoryWorkerClaimRequest = Readonly<{
  workerId: string;
  leaseSeconds: number;
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
}>;

export type MemoryContextPreviewRequest = MemoryContextQuery & Readonly<{
  /** API preview is pinned to a world-version even when campaign version later changes. */
  throughTurnNumber?: number;
}>;

export type MemoryEmbeddingConfigInput = CampaignEmbeddingConfig;
