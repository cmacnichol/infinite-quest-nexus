import type {
  AcceptedTurnFictionScope,
  CampaignMemoryScope,
  CampaignWorldVersionMemoryScope,
  ChronicleClaimCompletion,
  ChronicleClaimFailure,
  ChronicleClaimRetry,
  ChronicleContextPreview,
  ChronicleJobScope,
  ChronicleJobView,
  ChronicleLeaseScope,
  ChronicleMetricsView,
  ChronicleWorkerRetrievalRequest,
  ChronicleWorkerRunRequest,
  ChronicleWorkerRetrieval,
  ClaimedChronicleJob,
  DerivedStoryMemory,
  DerivedTurnMemoryScope,
  EmbeddingConfigView,
  MemoryContextPreviewRequest,
  MemoryEmbeddingConfigInput,
  MemoryGenerationContextPreviewScope,
  MemoryPublicResult,
  MemoryTransactionContext,
  MemoryWorkerClaimRequest,
  QueuedChronicleJob
} from "./types.js";

export interface MemoryConfigurationRepository {
  /** Includes retrieval selection controls; the generation-facing retrieval seam remains buildContextPreview. */
  getEmbeddingConfig(scope: CampaignMemoryScope): Promise<EmbeddingConfigView>;
  setEmbeddingConfig(scope: CampaignMemoryScope, input: MemoryEmbeddingConfigInput): Promise<EmbeddingConfigView>;
}

export interface MemoryQueryRepository {
  getMetrics(scope: CampaignWorldVersionMemoryScope): Promise<MemoryPublicResult<ChronicleMetricsView>>;
  previewContext(
    scope: CampaignWorldVersionMemoryScope,
    request: MemoryContextPreviewRequest,
  ): Promise<MemoryPublicResult<ChronicleContextPreview>>;
}

export interface ChronicleJobRepository {
  enqueueChronicleReindex(scope: CampaignWorldVersionMemoryScope): Promise<QueuedChronicleJob>;
  enqueueEmbeddingReindex(scope: CampaignWorldVersionMemoryScope): Promise<QueuedChronicleJob | null>;
  getJob(scope: ChronicleJobScope): Promise<ChronicleJobView>;
}

/**
 * The accepted-turn repository owns the outer transaction. All five temporary
 * Task 10d callbacks and the direct fiction row write must use this exact
 * context. This port intentionally has no pool, begin, or transaction factory.
 */
export interface MemoryGenerationTransactionPort {
  autoEnableCampaignEmbedding(
    database: MemoryTransactionContext,
    scope: CampaignWorldVersionMemoryScope,
  ): Promise<EmbeddingConfigView>;
  buildContextPreview(
    database: MemoryTransactionContext,
    scope: MemoryGenerationContextPreviewScope,
  ): Promise<ChronicleContextPreview>;
  enqueueEmbeddingReindex(
    database: MemoryTransactionContext,
    scope: CampaignWorldVersionMemoryScope,
  ): Promise<string | null>;
  rebuildCampaignMemories(
    database: MemoryTransactionContext,
    scope: CampaignWorldVersionMemoryScope,
  ): Promise<number>;
  storeDerivedTurnMemories(
    database: MemoryTransactionContext,
    scope: DerivedTurnMemoryScope & Readonly<{ derived: DerivedStoryMemory }>,
  ): Promise<void>;
  writeAcceptedTurnFiction(
    database: MemoryTransactionContext,
    scope: AcceptedTurnFictionScope,
  ): Promise<void>;
}

export interface ChronicleWorkerStatePort {
  /** Oldest-first SKIP LOCKED claim; the returned scope supplies all authority. */
  claimNext(request: MemoryWorkerClaimRequest): Promise<ClaimedChronicleJob | null>;
  loadClaimedJob(scope: ChronicleLeaseScope): Promise<ClaimedChronicleJob | null>;
  heartbeatClaim(scope: ChronicleLeaseScope): Promise<boolean>;
  completeClaim(scope: ChronicleLeaseScope, completion: ChronicleClaimCompletion): Promise<boolean>;
  failClaim(scope: ChronicleLeaseScope, failure: ChronicleClaimFailure): Promise<boolean>;
  requeueClaim(scope: ChronicleLeaseScope, retry: ChronicleClaimRetry): Promise<boolean>;
}

export interface ChronicleWorkerRetrievalPort {
  loadForClaim(
    scope: ChronicleLeaseScope,
    request: ChronicleWorkerRetrievalRequest,
  ): Promise<ChronicleWorkerRetrieval>;
}

export interface ChronicleClaimExecutionLifecycle {
  readonly leaseLost: boolean;
  throwIfLeaseLost(): void;
  waitForLeaseLoss(): Promise<Error>;
}

/** Runtime-composed work body. Lifecycle ownership remains in the application executor. */
export interface ChronicleClaimExecutionPort {
  execute(
    scope: ChronicleLeaseScope,
    firstPage: ChronicleWorkerRetrieval,
    lifecycle?: ChronicleClaimExecutionLifecycle,
  ): Promise<Readonly<Record<string, unknown>>>;
}

export interface ChronicleWorkerExecutor {
  /**
   * Platform-free lane seam. The concrete 14b2 executor owns claim, heartbeat,
   * retrieval, terminal transition, and safe diagnostics behind these ports.
   */
  runNextChronicle(request: ChronicleWorkerRunRequest): Promise<boolean>;
  runClaimed(claim: ClaimedChronicleJob): Promise<boolean>;
}

export type MemoryApplicationDependencies = Readonly<{
  configuration: MemoryConfigurationRepository;
  queries: MemoryQueryRepository;
  jobs: ChronicleJobRepository;
  transaction: MemoryGenerationTransactionPort;
}>;

export interface MemoryApplication
  extends MemoryConfigurationRepository,
    MemoryQueryRepository,
    ChronicleJobRepository {
  readonly generation: MemoryGenerationTransactionPort;
}

export type MemoryWorkerApplicationDependencies = Readonly<{
  state: ChronicleWorkerStatePort;
  retrieval: ChronicleWorkerRetrievalPort;
  executor: ChronicleWorkerExecutor;
}>;

export interface MemoryWorkerApplication
  extends ChronicleWorkerStatePort,
    ChronicleWorkerRetrievalPort,
    ChronicleWorkerExecutor {}
