import type {
  ChronicleClaimFailure,
  ChronicleLeaseScope,
  ChronicleWorkerExecutor,
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
  runClaim(claim: ChronicleLeaseScope): Promise<void>;
  logProviderTransportError(error: unknown, context: Readonly<Record<string, unknown>>): void;
}>;

function privateFailure(): ChronicleClaimFailure {
  return { diagnosticCode: "chronicle_execution_failed" };
}

/**
 * Owns only the typed lifecycle seam. The legacy work body remains a named
 * runtime binding until the atomic 14b3 consumer cutover moves it behind the
 * repository and embedding ports.
 */
export function createChronicleWorkerExecutor(
  dependencies: ChronicleWorkerExecutorDependencies,
): ChronicleWorkerExecutor {
  const runClaimed = async (claim: ChronicleLeaseScope): Promise<boolean> => {
    try {
      await dependencies.runClaim(claim);
      return true;
    } catch (error) {
      dependencies.logProviderTransportError(error, {
        chronicleJobId: claim.jobId,
        campaignId: claim.campaignId,
        jobType: claim.jobType,
        workerId: claim.workerId
      });
      await dependencies.state.failClaim(claim, privateFailure());
      return true;
    }
  };

  return {
    async runNextChronicle(request: ChronicleWorkerRunRequest): Promise<boolean> {
      const claim = await dependencies.state.claimNext({
        workerId: request.workerId,
        leaseSeconds: request.leaseSeconds
      });
      if (!claim) return false;
      // Validate the bounded retrieval contract before dispatching the job.
      await dependencies.retrieval.loadForClaim(claim, request.retrieval);
      return runClaimed(claim);
    },
    runClaimed
  };
}
