import type {
  IllustrationWorkerApplication,
  MemoryApplication,
  MemoryGenerationTransactionPort,
  MemoryWorkerApplication
} from "../../packages/application/src/index.js";
import type { DatabasePool } from "../../packages/database/src/pool.js";
import { createApiMemoryApplication, createWorkerMemoryApplication } from "../../services/runtime/src/memory-composition.js";
import { apiProviderGraph, workerProviderGraph } from "./provider-application-fixtures.js";

export function apiMemoryApplication(
  pool: DatabasePool,
  credentialSecret = "test-credential-secret",
): MemoryApplication {
  return createApiMemoryApplication(pool, apiProviderGraph(pool, credentialSecret).chronicle);
}

export function memoryGeneration(
  pool: DatabasePool,
  credentialSecret = "test-credential-secret",
): MemoryGenerationTransactionPort {
  return apiMemoryApplication(pool, credentialSecret).generation;
}

export function workerMemoryApplication(
  pool: DatabasePool,
  credentialSecret = "test-credential-secret",
): MemoryWorkerApplication {
  return createWorkerMemoryApplication(pool, workerProviderGraph(pool, credentialSecret).chronicle);
}

export const inertWorkerMemory: MemoryWorkerApplication = {
  claimNext: async () => null,
  loadClaimedJob: async () => null,
  heartbeatClaim: async () => false,
  completeClaim: async () => false,
  failClaim: async () => false,
  requeueClaim: async () => false,
  loadForClaim: async () => ({ config: { enabled: false }, memories: [], totalMemories: 0, batchLimit: 1, nextCursor: null }),
  runNextChronicle: async () => false,
  runClaimed: async () => false
};

export const inertWorkerIllustration = {
  runNextIllustration: async () => false
} as unknown as IllustrationWorkerApplication;
