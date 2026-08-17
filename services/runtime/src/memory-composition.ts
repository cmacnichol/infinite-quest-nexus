import {
  createMemoryApplication,
  createMemoryWorkerApplication,
  type MemoryApplication,
  type MemoryWorkerApplication
} from "../../../packages/application/src/memory/index.js";
import {
  createPostgresChronicleRepositories,
  createPostgresChronicleEmbeddingBatchPort,
  createPostgresChronicleGenerationTransactionPort,
  createPostgresChronicleWorkerAdapters,
  type ChronicleGenerationTransactionDependencies
} from "../../../packages/database/src/chronicle-repository.js";
import {
  createPostgresChronicleChunkBatchPort,
  createPostgresChronicleChunkJobStatePort,
  createPostgresChronicleChunkParentPort
} from "../../../packages/database/src/chronicle-chunk-repository.js";
import type { DatabasePool } from "../../../packages/database/src/pool.js";
import { logProviderTransportError } from "../../../packages/story-engine/src/providers.js";
import { createChronicleWorkerExecutor } from "./chronicle-platform-adapter.js";
import { createChroniclePlatformBindings } from "./chronicle-platform-bindings.js";
import { createChronicleClaimExecution } from "./chronicle-worker-execution.js";
import { createChronicleChunkWorkerExecution } from "./chronicle-chunk-worker-execution.js";
import type { ChronicleProviderCollaborators } from "./provider-application-composition.js";

export type ApiMemoryCompositionDependencies = Readonly<{
  embeddings?: ChronicleGenerationTransactionDependencies["embeddings"];
}>;

/** Composes the API's sole Chronicle application over PostgreSQL ports. */
export function createApiMemoryApplication(
  pool: DatabasePool,
  providers: ChronicleProviderCollaborators,
  dependencies: ApiMemoryCompositionDependencies = {},
): MemoryApplication {
  const transactionDependencies: ChronicleGenerationTransactionDependencies = {
    embeddings: dependencies.embeddings ?? createChroniclePlatformBindings(providers).embeddings
  };
  return createMemoryApplication(createPostgresChronicleRepositories(pool, transactionDependencies));
}

export function createWorkerMemoryApplication(
  pool: DatabasePool,
  providers: ChronicleProviderCollaborators,
): MemoryWorkerApplication {
  const adapters = createPostgresChronicleWorkerAdapters(pool);
  const bindings = createChroniclePlatformBindings(providers);
  const generation = createPostgresChronicleGenerationTransactionPort({
    embeddings: bindings.embeddings
  });
  const batches = createPostgresChronicleEmbeddingBatchPort(pool, {
    recordCost: bindings.embeddings.recordCost
  });
  const chunkState = createPostgresChronicleChunkJobStatePort(pool);
  const chunkParents = createPostgresChronicleChunkParentPort(pool);
  const chunkBatches = createPostgresChronicleChunkBatchPort(pool, {
    recordCost: bindings.embeddings.recordCost
  });
  const executor = createChronicleWorkerExecutor({
    ...adapters,
    execution: createChronicleClaimExecution(pool, {
      retrieval: adapters.retrieval,
      embeddings: bindings.embeddings,
      batches,
      generation
    }),
    chunks: {
      state: chunkState,
      execution: createChronicleChunkWorkerExecution({
        parents: chunkParents,
        batches: chunkBatches,
        embeddings: {
          load: (scope) => bindings.embeddings.load(pool, scope),
          embed: (provider, documents) => bindings.embeddings.embed(provider, documents),
          fingerprint: (provider, prefixes) => bindings.embeddings.fingerprint(provider, prefixes),
          recordHealth: (scope, healthy, diagnostic) =>
            bindings.embeddings.recordHealth(pool, scope, healthy, diagnostic)
        }
      })
    },
    logProviderTransportError
  });
  return createMemoryWorkerApplication({ ...adapters, executor });
}
