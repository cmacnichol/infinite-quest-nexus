import type {
  ChronicleClaimExecutionLifecycle,
  ChronicleClaimExecutionPort,
  ChronicleLeaseScope,
  ChronicleWorkerRetrieval,
  ChronicleWorkerRetrievalPort,
  MemoryGenerationTransactionPort
} from "../../../packages/application/src/memory/index.js";
import {
  CHRONICLE_EMBEDDING_PROTOCOL_VERSION,
  chronicleContentHash,
  modelAwareEmbeddingPrefixes
} from "../../../packages/domain/src/chronicle-memory-helpers.js";
import type {
  ChronicleEmbeddingBatchPort
} from "../../../packages/database/src/chronicle-repository.js";
import type { DatabasePool } from "../../../packages/database/src/pool.js";
import { withTransaction } from "../../../packages/database/src/pool.js";
import { logger as applicationLogger } from "../../../packages/logger/src/index.js";
import { ProviderResponseTooLargeError } from "../../../packages/story-engine/src/provider-response.js";
import { providerTransportErrorDetails } from "../../../packages/story-engine/src/providers.js";
import type { ChronicleEmbeddingProviderPort } from "./chronicle-platform-adapter.js";

export type ChronicleWorkerExecutionDependencies = Readonly<{
  retrieval: ChronicleWorkerRetrievalPort;
  embeddings: ChronicleEmbeddingProviderPort;
  batches: ChronicleEmbeddingBatchPort;
  generation: MemoryGenerationTransactionPort;
  logger?: Pick<typeof applicationLogger, "error">;
}>;

type EmbeddingFailureDiagnostic = Readonly<{
  diagnosticCode:
    | "provider_response_too_large"
    | "provider_transport_error"
    | "provider_http_error"
    | "provider_response_invalid"
    | "embedding_failed";
  providerStatusCode?: number;
}>;

function providerStatusCode(error: unknown): number | null {
  if (typeof error !== "object" || error === null) return null;
  const statusCode = Number((error as { statusCode?: unknown }).statusCode);
  return Number.isInteger(statusCode) && statusCode >= 400 && statusCode <= 599
    ? statusCode
    : null;
}

function isInvalidEmbeddingResponse(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.message === "Embedding provider returned an incomplete Chronicle batch."
    || /^Embedding provider returned \d+ vectors for \d+ inputs\.$/.test(error.message)
    || /^Embedding result \d+ did not contain a vector\.$/.test(error.message)
    || /^Embedding result \d+ contained a non-finite value\.$/.test(error.message)
    || /^Embedding result \d+ exceeded the supported dimensionality\.$/.test(error.message)
    || error.message === "Embedding provider returned vectors with inconsistent dimensions.";
}

function embeddingFailureDiagnostic(error: unknown): EmbeddingFailureDiagnostic {
  if (error instanceof ProviderResponseTooLargeError) {
    return { diagnosticCode: "provider_response_too_large" };
  }
  if (providerTransportErrorDetails(error)) {
    return { diagnosticCode: "provider_transport_error" };
  }
  const statusCode = providerStatusCode(error);
  if (statusCode !== null) {
    return { diagnosticCode: "provider_http_error", providerStatusCode: statusCode };
  }
  if (isInvalidEmbeddingResponse(error)) {
    return { diagnosticCode: "provider_response_invalid" };
  }
  return { diagnosticCode: "embedding_failed" };
}

function batchMemories(retrieval: ChronicleWorkerRetrieval) {
  return retrieval.memories.map((memory) => {
    const id = typeof memory.id === "string" ? memory.id : "";
    const content = typeof memory.content === "string" ? memory.content : "";
    if (!id || !content) throw new Error("Chronicle retrieval returned an invalid embedding row.");
    return { id, content, contentHash: chronicleContentHash(content) };
  });
}

function throwIfLeaseLost(lifecycle?: ChronicleClaimExecutionLifecycle): void {
  lifecycle?.throwIfLeaseLost();
}

/** Executes only typed runtime dependencies. The state-machine adapter owns
 * claim, retrieval failure handling, and the terminal lease transition. */
async function executeChronicleClaim(
  pool: DatabasePool,
  claim: ChronicleLeaseScope,
  first: ChronicleWorkerRetrieval,
  dependencies: ChronicleWorkerExecutionDependencies,
  lifecycle?: ChronicleClaimExecutionLifecycle,
): Promise<Readonly<Record<string, unknown>>> {
  throwIfLeaseLost(lifecycle);
  if (claim.jobType === "reindex_campaign") {
    const rebuilt = await withTransaction(pool, async (database) => {
      throwIfLeaseLost(lifecycle);
      const count = await dependencies.generation.rebuildCampaignMemories(database, claim);
      throwIfLeaseLost(lifecycle);
      await dependencies.generation.enqueueEmbeddingReindex(database, claim);
      throwIfLeaseLost(lifecycle);
      return count;
    });
    return { rebuilt };
  }

  let retrieval = first;
  const config = retrieval.config;
  if (!config.enabled || !config.providerProfileId || !config.model) {
    return { embedded: 0, skipped: 0, total: 0 };
  }
  const provider = await dependencies.embeddings.load(pool, {
    ownerUserId: claim.ownerUserId,
    providerProfileId: config.providerProfileId,
    model: config.model
  });
  throwIfLeaseLost(lifecycle);
  const prefixes = modelAwareEmbeddingPrefixes(config.model, config.documentPrefix ?? null, config.queryPrefix ?? null);
  const fingerprint = await dependencies.embeddings.fingerprint(provider, prefixes);
  throwIfLeaseLost(lifecycle);
  const providerScope = {
    ownerUserId: claim.ownerUserId,
    providerProfileId: config.providerProfileId,
    model: config.model
  };
  let processed = 0;
  while (true) {
    throwIfLeaseLost(lifecycle);
    const memories = batchMemories(retrieval);
    if (memories.length) {
      let result: Awaited<ReturnType<ChronicleEmbeddingProviderPort["embed"]>>;
      try {
        result = await dependencies.embeddings.embed(provider, memories.map((memory) => `${prefixes.documentPrefix}${memory.content}`));
        if (result.embeddings.length !== memories.length) throw new Error("Embedding provider returned an incomplete Chronicle batch.");
      } catch (error) {
        (dependencies.logger ?? applicationLogger).error({
          event: "chronicle_embedding_batch_failed",
          ...embeddingFailureDiagnostic(error),
          chronicleJobId: claim.jobId,
          campaignId: claim.campaignId,
          providerProfileId: config.providerProfileId,
          configuredBatchSize: config.batchSize,
          effectiveBatchLimit: retrieval.batchLimit,
          attemptedBatchSize: memories.length
        });
        await dependencies.embeddings.recordHealth(
          pool,
          providerScope,
          false,
          "chronicle_embedding_failed"
        ).catch(() => undefined);
        throw error;
      }
      throwIfLeaseLost(lifecycle);
      const nextProcessed = processed + memories.length;
      const committed = await dependencies.batches.commitClaimBatch(claim, {
        provider,
        providerFingerprint: fingerprint,
        protocolVersion: CHRONICLE_EMBEDDING_PROTOCOL_VERSION,
        memories,
        result,
        processed: nextProcessed,
        total: first.totalMemories
      });
      if (!committed) throw new Error("Chronicle job lease was lost during embedding batch commit.");
      processed = nextProcessed;
    }
    if (!retrieval.nextCursor) break;
    throwIfLeaseLost(lifecycle);
    retrieval = await dependencies.retrieval.loadForClaim(claim, {
      batchLimit: retrieval.batchLimit,
      cursor: retrieval.nextCursor
    });
    if (retrieval.totalMemories < processed) throw new Error("Chronicle retrieval total regressed during a claim.");
  }
  await dependencies.embeddings.recordHealth(pool, providerScope, true);
  throwIfLeaseLost(lifecycle);
  return { embedded: processed, skipped: 0, total: first.totalMemories };
}

export function createChronicleClaimExecution(
  pool: DatabasePool,
  dependencies: ChronicleWorkerExecutionDependencies,
): ChronicleClaimExecutionPort {
  return {
    execute: (scope, firstPage, lifecycle) => executeChronicleClaim(
      pool,
      scope,
      firstPage,
      dependencies,
      lifecycle
    )
  };
}
