import type {
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
import type { ChronicleEmbeddingProviderPort } from "./chronicle-platform-adapter.js";

export type ChronicleWorkerExecutionDependencies = Readonly<{
  retrieval: ChronicleWorkerRetrievalPort;
  embeddings: ChronicleEmbeddingProviderPort;
  batches: ChronicleEmbeddingBatchPort;
  generation: MemoryGenerationTransactionPort;
  credentialSecret: string;
}>;

function batchMemories(retrieval: ChronicleWorkerRetrieval) {
  return retrieval.memories.map((memory) => {
    const id = typeof memory.id === "string" ? memory.id : "";
    const content = typeof memory.content === "string" ? memory.content : "";
    if (!id || !content) throw new Error("Chronicle retrieval returned an invalid embedding row.");
    return { id, content, contentHash: chronicleContentHash(content) };
  });
}

/** Executes only typed runtime dependencies. The state-machine adapter owns
 * claim, retrieval failure handling, and the terminal lease transition. */
async function executeChronicleClaim(
  pool: DatabasePool,
  claim: ChronicleLeaseScope,
  first: ChronicleWorkerRetrieval,
  dependencies: ChronicleWorkerExecutionDependencies,
): Promise<Readonly<Record<string, unknown>>> {
  if (claim.jobType === "reindex_campaign") {
    const rebuilt = await withTransaction(pool, async (database) => {
      const count = await dependencies.generation.rebuildCampaignMemories(database, claim);
      await dependencies.generation.enqueueEmbeddingReindex(database, claim);
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
  }, dependencies.credentialSecret);
  const prefixes = modelAwareEmbeddingPrefixes(config.model, config.documentPrefix ?? null, config.queryPrefix ?? null);
  const fingerprint = await dependencies.embeddings.fingerprint(provider, prefixes);
  let processed = 0;
  try {
    while (true) {
      const memories = batchMemories(retrieval);
      if (memories.length) {
        const result = await dependencies.embeddings.embed(provider, memories.map((memory) => `${prefixes.documentPrefix}${memory.content}`));
        if (result.embeddings.length !== memories.length) throw new Error("Embedding provider returned an incomplete Chronicle batch.");
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
      retrieval = await dependencies.retrieval.loadForClaim(claim, {
        batchLimit: retrieval.batchLimit,
        cursor: retrieval.nextCursor
      });
      if (retrieval.totalMemories < processed) throw new Error("Chronicle retrieval total regressed during a claim.");
    }
    await dependencies.embeddings.recordHealth(pool, {
      ownerUserId: claim.ownerUserId,
      providerProfileId: config.providerProfileId,
      model: config.model
    }, true);
  } catch (error) {
    await dependencies.embeddings.recordHealth(pool, {
      ownerUserId: claim.ownerUserId,
      providerProfileId: config.providerProfileId,
      model: config.model
    }, false, "chronicle_embedding_failed").catch(() => undefined);
    throw error;
  }
  return { embedded: processed, skipped: 0, total: first.totalMemories };
}

export function createChronicleClaimExecution(
  pool: DatabasePool,
  dependencies: ChronicleWorkerExecutionDependencies,
): ChronicleClaimExecutionPort {
  return {
    execute: (scope, firstPage) => executeChronicleClaim(pool, scope, firstPage, dependencies)
  };
}
