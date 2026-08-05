import {
  createMemoryApplication,
  createMemoryWorkerApplication,
  type ChronicleWorkerExecutor,
  type MemoryApplication,
  type MemoryWorkerApplication
} from "../../../packages/application/src/memory/index.js";
import {
  createPostgresChronicleRepositories,
  createPostgresChronicleWorkerAdapters,
  type ChronicleGenerationTransactionDependencies
} from "../../../packages/database/src/chronicle-repository.js";
import type { DatabasePool } from "../../../packages/database/src/pool.js";
import { logProviderTransportError } from "../../../packages/story-engine/src/providers.js";
import { createChronicleWorkerExecutor } from "./chronicle-platform-adapter.js";
import { createChroniclePlatformBindings } from "./chronicle-platform-bindings.js";
import { runClaimedChronicleJob } from "./chronicle-platform-service.js";

export type ApiMemoryCompositionDependencies = Readonly<{
  credentialSecret: string;
  embeddings?: ChronicleGenerationTransactionDependencies["embeddings"];
}>;

/**
 * This composition is intentionally unused until 14b3 performs the atomic API
 * cutover. It makes the concrete repository construction testable without
 * making server routes depend on parallel implementations.
 */
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

export type WorkerMemoryCompositionFactories = Readonly<{
  createExecutor(pool: DatabasePool): ChronicleWorkerExecutor;
  createApplication(dependencies: Readonly<{
    state: ReturnType<typeof createPostgresChronicleWorkerAdapters>["state"];
    retrieval: ReturnType<typeof createPostgresChronicleWorkerAdapters>["retrieval"];
    executor: ChronicleWorkerExecutor;
  }>): MemoryWorkerApplication;
}>;

/**
 * The supplied `runClaim` body remains the named compatibility binding until
 * 14b3. The application lifecycle itself is fully repository-backed now.
 */
export function createWorkerMemoryApplication(
  pool: DatabasePool,
  factories: WorkerMemoryCompositionFactories,
): MemoryWorkerApplication {
  const adapters = createPostgresChronicleWorkerAdapters(pool);
  return factories.createApplication({ ...adapters, executor: factories.createExecutor(pool) });
}

export type ChronicleCompatibilityRunClaim = Readonly<{
  runClaim: Parameters<typeof createChronicleWorkerExecutor>[0]["runClaim"];
  logProviderTransportError: Parameters<typeof createChronicleWorkerExecutor>[0]["logProviderTransportError"];
}>;

export function createRepositoryBackedChronicleExecutor(
  pool: DatabasePool,
  compatibility: ChronicleCompatibilityRunClaim,
): ChronicleWorkerExecutor {
  const adapters = createPostgresChronicleWorkerAdapters(pool);
  return createChronicleWorkerExecutor({ ...adapters, ...compatibility });
}

/** The worker claims through the direct Chronicle state port and dispatches
 * the runtime-owned body only after that lease has been established. */
export function createLiveWorkerMemoryApplication(
  pool: DatabasePool,
  credentialSecret: string,
): MemoryWorkerApplication {
  const adapters = createPostgresChronicleWorkerAdapters(pool);
  const executor = createChronicleWorkerExecutor({
    ...adapters,
    runClaim: async (claim) => {
      await runClaimedChronicleJob(pool, {
        id: claim.jobId,
        owner_user_id: claim.ownerUserId,
        campaign_id: claim.campaignId,
        job_type: claim.jobType,
        work_version: claim.workVersion,
        worker_id: claim.workerId,
        lease_seconds: claim.leaseSeconds
      }, credentialSecret, adapters.state, claim);
    },
    logProviderTransportError
  });
  return createMemoryWorkerApplication({ ...adapters, executor });
}
