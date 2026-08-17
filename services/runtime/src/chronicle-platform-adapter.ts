import type {
  ChronicleClaimExecutionPort,
  ChronicleClaimFailure,
  ChronicleChunkJobStatePort,
  ChronicleChunkLeaseScope,
  ChronicleLeaseScope,
  ChronicleWorkerExecutor,
  ChronicleWorkerRetrieval,
  ChronicleWorkerRetrievalPort,
  ChronicleWorkerRunRequest,
  ChronicleWorkerStatePort,
  MemoryTransactionContext
} from "../../../packages/application/src/memory/index.js";
import type { ChronicleChunkWorkerExecution } from "./chronicle-chunk-worker-execution.js";
import type {
  ChronicleTransactionEmbeddingPort,
  ChronicleTransactionEmbeddingExecution,
  ChronicleTransactionEmbeddingProvider,
  ChronicleTransactionEmbeddingResolution,
  ChronicleTransactionEmbeddingResult
} from "../../../packages/database/src/chronicle-repository.js";
import { providerModelFingerprint } from "../../../packages/domain/src/chronicle-memory-helpers.js";

export type ChronicleEmbeddingProvider = ChronicleTransactionEmbeddingExecution;
export type ChronicleEmbeddingResult = ChronicleTransactionEmbeddingResult;

export type ChronicleEmbeddingProviderScope = Readonly<{
  ownerUserId: string;
  providerProfileId: string;
  model: string;
}>;

export type ChronicleEmbeddingProviderSelectionScope = Readonly<{
  ownerUserId: string;
  campaignId: string;
  selectedProviderProfileId?: string | null;
}>;

/**
 * Runtime-only provider binding. Task 14d owns its replacement alongside the
 * rest of provider configuration; application commands never see credentials.
 */
export type ChronicleEmbeddingProviderDependencies = Readonly<{
  loadEmbeddingExecution(
    ownerUserId: string,
    providerProfileId: string,
    model: string,
  ): Promise<ChronicleEmbeddingProvider>;
  resolveEmbeddingProvider(
    database: MemoryTransactionContext,
    ownerUserId: string,
    campaignId: string,
    selectedProviderProfileId?: string | null,
  ): Promise<ChronicleTransactionEmbeddingResolution>;
  recordProviderHealth(
    database: MemoryTransactionContext,
    ownerUserId: string,
    providerProfileId: string,
    healthy: boolean,
    errorMessage?: string,
  ): Promise<void>;
  recordProfileCost(
    database: MemoryTransactionContext,
    provider: ChronicleTransactionEmbeddingProvider,
    attribution: Readonly<{
      ownerUserId: string;
      campaignId: string;
      generationJobId?: string;
      chronicleJobId?: string;
      operation: "memory_embedding" | "retrieval_embedding" | "context_preview_embedding";
    }>,
    result: ChronicleEmbeddingResult,
  ): Promise<string | null>;
  logProviderTransportError(error: unknown, context: Readonly<Record<string, unknown>>): void;
}>;

export type ChronicleEmbeddingProviderPort = ChronicleTransactionEmbeddingPort;

export function createChronicleEmbeddingProviderPort(
  dependencies: ChronicleEmbeddingProviderDependencies,
): ChronicleEmbeddingProviderPort {
  return {
    resolve: (database, scope) => dependencies.resolveEmbeddingProvider(
      database,
      scope.ownerUserId,
      scope.campaignId,
      scope.selectedProviderProfileId ?? null,
    ),
    load: (_database, scope) => dependencies.loadEmbeddingExecution(
      scope.ownerUserId,
      scope.providerProfileId,
      scope.model,
    ),
    embed: (provider, documents) => provider.embed(documents),
    fingerprint: async (provider, prefixes) => providerModelFingerprint({
      ...provider,
      // The provider id is the opaque endpoint identity at this boundary.
      baseUrl: provider.id,
    }, prefixes),
    recordHealth: (database, scope, healthy, diagnostic = "") => dependencies.recordProviderHealth(
      database,
      scope.ownerUserId,
      scope.providerProfileId,
      healthy,
      diagnostic,
    ),
    recordCost: (database, provider, scope, result) => dependencies.recordProfileCost(
      database,
      provider,
      scope,
      result,
    ),
    logDiagnostic: (error, context) => dependencies.logProviderTransportError(error, context)
  };
}

export type ChronicleWorkerExecutorDependencies = Readonly<{
  state: ChronicleWorkerStatePort;
  retrieval: ChronicleWorkerRetrievalPort;
  execution: ChronicleClaimExecutionPort;
  chunks?: Readonly<{
    state: ChronicleChunkJobStatePort;
    execution: ChronicleChunkWorkerExecution;
  }>;
  logProviderTransportError(error: unknown, context: Readonly<Record<string, unknown>>): void;
}>;

type HeartbeatState<T> = Readonly<{
  heartbeatClaim(scope: T): Promise<boolean>;
}>;

function privateFailure(): ChronicleClaimFailure {
  return { diagnosticCode: "chronicle_execution_failed" };
}

function leaseHeartbeatLost(cause?: unknown): Error {
  return new Error("Chronicle job lease heartbeat was lost.", cause === undefined ? undefined : { cause });
}

function startClaimHeartbeat<T extends Readonly<{ leaseSeconds: number }>>(
  state: HeartbeatState<T>,
  claim: T,
): Readonly<{
  lifecycle: Readonly<{
    readonly leaseLost: boolean;
    throwIfLeaseLost(): void;
    waitForLeaseLoss(): Promise<Error>;
  }>;
  stop(): Promise<Error | null>;
}> {
  const intervalMs = Math.max(1, Math.floor(claim.leaseSeconds * 1_000 / 3));
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let wake: (() => void) | null = null;
  let loss: Error | null = null;
  let resolveLoss!: (error: Error) => void;
  const lossEvent = new Promise<Error>((resolve) => {
    resolveLoss = resolve;
  });

  const lose = (cause?: unknown): void => {
    if (loss) return;
    loss = leaseHeartbeatLost(cause);
    resolveLoss(loss);
  };
  const waitForInterval = (): Promise<void> => new Promise((resolve) => {
    wake = resolve;
    timer = setTimeout(resolve, intervalMs);
    timer.unref();
  });
  const loop = (async () => {
    while (!stopped) {
      await waitForInterval();
      timer = null;
      wake = null;
      if (stopped) break;
      try {
        if (!await state.heartbeatClaim(claim)) {
          lose();
          break;
        }
      } catch (error) {
        lose(error);
        break;
      }
    }
  })();

  return {
    lifecycle: {
      get leaseLost() {
        return loss !== null;
      },
      throwIfLeaseLost() {
        if (loss) throw loss;
      },
      waitForLeaseLoss() {
        return lossEvent;
      }
    },
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      wake?.();
      await loop;
      return loss;
    }
  };
}

/**
 * Owns the typed lifecycle seam around the runtime-owned Chronicle work body.
 */
export function createChronicleWorkerExecutor(
  dependencies: ChronicleWorkerExecutorDependencies,
): ChronicleWorkerExecutor {
  const executeClaim = async (
    claim: ChronicleLeaseScope,
    prepare: () => Promise<ChronicleWorkerRetrieval> = async () => ({
      config: { enabled: false, providerProfileId: null, model: "", batchSize: 1, documentPrefix: null, queryPrefix: null },
      memories: [], totalMemories: 0, batchLimit: 1, nextCursor: null
    }),
  ): Promise<boolean> => {
    const heartbeat = startClaimHeartbeat(dependencies.state, claim);
    let progress: Readonly<Record<string, unknown>> | null = null;
    let executionError: unknown = null;
    try {
      heartbeat.lifecycle.throwIfLeaseLost();
      const retrieval = await prepare();
      heartbeat.lifecycle.throwIfLeaseLost();
      progress = await dependencies.execution.execute(claim, retrieval, heartbeat.lifecycle);
      heartbeat.lifecycle.throwIfLeaseLost();
    } catch (error) {
      executionError = error;
    }
    const heartbeatLoss = await heartbeat.stop();
    if (heartbeatLoss) executionError = heartbeatLoss;

    if (executionError === null && progress !== null) {
      try {
        if (!await dependencies.state.completeClaim(claim, { progress })) {
          throw new Error("Chronicle job lease was lost before completion could be recorded.");
        }
        return true;
      } catch (error) {
        executionError = error;
      }
    }

    const error = executionError ?? new Error("Chronicle claim execution ended without progress.");
    let claimIsStale = false;
    try {
      claimIsStale = await dependencies.state.loadClaimedJob(claim) === null;
    } catch {
      // Preserve the original execution failure when the stale-claim probe
      // cannot prove that newer work superseded this lease.
    }
    if (claimIsStale) {
      try {
        if (await dependencies.state.completeClaim(claim, {
          progress: { retryReason: "work_version_changed" }
        })) {
          return true;
        }
      } catch {
        // The guarded transition is best-effort here. If it cannot prove the
        // newer work was requeued, use the ordinary private failure path.
      }
    }
    dependencies.logProviderTransportError(error, {
      chronicleJobId: claim.jobId,
      campaignId: claim.campaignId,
      jobType: claim.jobType,
      workerId: claim.workerId
    });
    await dependencies.state.failClaim(claim, privateFailure());
    return true;
  };
  const runClaimed = (claim: ChronicleLeaseScope): Promise<boolean> => executeClaim(
    claim,
    () => dependencies.retrieval.loadForClaim(claim, { batchLimit: 128 }),
  );
  const executeChunkClaim = async (claim: ChronicleChunkLeaseScope): Promise<boolean> => {
    const chunks = dependencies.chunks;
    if (!chunks) return false;
    const heartbeat = startClaimHeartbeat(chunks.state, claim);
    let progress = null;
    let executionError: unknown = null;
    try {
      progress = await chunks.execution.execute(claim, heartbeat.lifecycle);
      heartbeat.lifecycle.throwIfLeaseLost();
    } catch (error) {
      executionError = error;
    }
    const heartbeatLoss = await heartbeat.stop();
    if (heartbeatLoss) executionError = heartbeatLoss;
    if (executionError === null && progress !== null) {
      if (await chunks.state.completeClaim(claim, { progress })) return true;
      executionError = new Error("Chronicle chunk job lease was lost before completion could be recorded.");
    }
    try {
      if (await chunks.state.loadClaimedJob(claim) === null) {
        await chunks.state.completeClaim(claim, { progress: claim.progress }).catch(() => false);
        return true;
      }
    } catch {
      // Preserve the private execution failure and use the guarded failure path.
    }
    dependencies.logProviderTransportError(executionError, {
      chronicleJobId: claim.jobId,
      campaignId: claim.campaignId,
      jobType: claim.jobType,
      workerId: claim.workerId
    });
    await chunks.state.failClaim(claim, privateFailure());
    return true;
  };

  return {
    async runNextChronicle(request: ChronicleWorkerRunRequest): Promise<boolean> {
      const claim = await dependencies.state.claimNext({
        workerId: request.workerId,
        leaseSeconds: request.leaseSeconds
      });
      if (!claim) {
        const chunkClaim = await dependencies.chunks?.state.claimNext({
          workerId: request.workerId,
          leaseSeconds: request.leaseSeconds
        }) ?? null;
        return chunkClaim ? executeChunkClaim(chunkClaim) : false;
      }
      return executeClaim(claim, async () => {
        // Validate the bounded retrieval contract inside the same lease-fenced
        // failure path that owns dispatch and terminalization.
        return dependencies.retrieval.loadForClaim(claim, request.retrieval);
      });
    },
    runClaimed
  };
}
