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
import type { DatabasePool } from "../../../packages/database/src/pool.js";
import { logProviderTransportError } from "../../../packages/story-engine/src/providers.js";
import { createChronicleWorkerExecutor } from "./chronicle-platform-adapter.js";
import { createChroniclePlatformBindings } from "./chronicle-platform-bindings.js";
import { createChronicleClaimExecution } from "./chronicle-worker-execution.js";

export type ApiMemoryCompositionDependencies = Readonly<{
  credentialSecret: string;
  embeddings?: ChronicleGenerationTransactionDependencies["embeddings"];
}>;

/** Composes the API's sole Chronicle application over PostgreSQL ports. */
export function createApiMemoryApplication(
  pool: DatabasePool,
  dependencies: ApiMemoryCompositionDependencies,
): MemoryApplication {
  const transactionDependencies: ChronicleGenerationTransactionDependencies = {
    credentialSecret: dependencies.credentialSecret,
    embeddings: dependencies.embeddings ?? createChroniclePlatformBindings().embeddings
  };
  return createMemoryApplication(createPostgresChronicleRepositories(pool, transactionDependencies));
}

export function createWorkerMemoryApplication(
  pool: DatabasePool,
  credentialSecret: string,
): MemoryWorkerApplication {
  const adapters = createPostgresChronicleWorkerAdapters(pool);
  const bindings = createChroniclePlatformBindings();
  const generation = createPostgresChronicleGenerationTransactionPort({
    credentialSecret,
    embeddings: bindings.embeddings
  });
  const batches = createPostgresChronicleEmbeddingBatchPort(pool, {
    recordCost: bindings.embeddings.recordCost
  });
  const executor = createChronicleWorkerExecutor({
    ...adapters,
    execution: createChronicleClaimExecution(pool, {
      retrieval: adapters.retrieval,
      embeddings: bindings.embeddings,
      batches,
      generation,
      credentialSecret
    }),
    logProviderTransportError
  });
  return createMemoryWorkerApplication({ ...adapters, executor });
}
