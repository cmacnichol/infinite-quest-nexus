import type {
  ChronicleClaimExecutionPort,
  ChronicleClaimFailure,
  ChronicleLeaseScope,
  ChronicleWorkerExecutor,
  ChronicleWorkerRetrieval,
  ChronicleWorkerRetrievalPort,
  ChronicleWorkerRunRequest,
  ChronicleWorkerStatePort,
  MemoryTransactionContext
} from "../../../packages/application/src/memory/index.js";
import type {
  ChronicleTransactionEmbeddingPort,
  ChronicleTransactionEmbeddingProvider,
  ChronicleTransactionEmbeddingResult
} from "../../../packages/database/src/chronicle-repository.js";
import { providerModelFingerprint } from "../../../packages/domain/src/chronicle-memory-helpers.js";

export type ChronicleEmbeddingProvider = ChronicleTransactionEmbeddingProvider;
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
  loadEmbeddingProvider(
    database: MemoryTransactionContext,
    ownerUserId: string,
    providerProfileId: string,
    credentialSecret: string,
    model: string,
  ): Promise<ChronicleEmbeddingProvider>;
  resolveEmbeddingProviderId(
    database: MemoryTransactionContext,
    ownerUserId: string,
    campaignId: string,
    selectedProviderProfileId?: string | null,
  ): Promise<string | null>;
  callEmbeddingProvider(provider: ChronicleEmbeddingProvider, documents: readonly string[]): Promise<ChronicleEmbeddingResult>;
  recordProviderHealth(
    database: MemoryTransactionContext,
    ownerUserId: string,
    providerProfileId: string,
    healthy: boolean,
    errorMessage?: string,
  ): Promise<void>;
  recordProfileCost(
    database: MemoryTransactionContext,
    provider: ChronicleEmbeddingProvider,
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
    resolve: (database, scope) => dependencies.resolveEmbeddingProviderId(
      database,
      scope.ownerUserId,
      scope.campaignId,
      scope.selectedProviderProfileId ?? null,
    ),
    load: (database, scope, credentialSecret) => dependencies.loadEmbeddingProvider(
      database,
      scope.ownerUserId,
      scope.providerProfileId,
      credentialSecret,
      scope.model,
    ),
    embed: (provider, documents) => dependencies.callEmbeddingProvider(provider, documents),
    fingerprint: async (provider, prefixes) => providerModelFingerprint(provider, prefixes),
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
  logProviderTransportError(error: unknown, context: Readonly<Record<string, unknown>>): void;
}>;

function privateFailure(): ChronicleClaimFailure {
  return { diagnosticCode: "chronicle_execution_failed" };
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
    const heartbeatInterval = setInterval(() => {
      void dependencies.state.heartbeatClaim(claim).catch(() => undefined);
    }, Math.max(1, Math.floor(claim.leaseSeconds * 1_000 / 3)));
    heartbeatInterval.unref();
    try {
      const retrieval = await prepare();
      const progress = await dependencies.execution.execute(claim, retrieval);
      if (!await dependencies.state.completeClaim(claim, { progress })) {
        throw new Error("Chronicle job lease was lost before completion could be recorded.");
      }
      return true;
    } catch (error) {
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
    } finally {
      clearInterval(heartbeatInterval);
    }
  };
  const runClaimed = (claim: ChronicleLeaseScope): Promise<boolean> => executeClaim(
    claim,
    () => dependencies.retrieval.loadForClaim(claim, { batchLimit: 128 }),
  );

  return {
    async runNextChronicle(request: ChronicleWorkerRunRequest): Promise<boolean> {
      const claim = await dependencies.state.claimNext({
        workerId: request.workerId,
        leaseSeconds: request.leaseSeconds
      });
      if (!claim) return false;
      return executeClaim(claim, async () => {
        // Validate the bounded retrieval contract inside the same lease-fenced
        // failure path that owns dispatch and terminalization.
        return dependencies.retrieval.loadForClaim(claim, request.retrieval);
      });
    },
    runClaimed
  };
}
