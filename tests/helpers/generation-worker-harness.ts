import type { GenerationWorkerApplication } from "../../packages/application/src/index.js";
import type { DatabasePool } from "../../packages/database/src/pool.js";
import { createWorkerGenerationApplication } from "../../services/runtime/src/generation-worker-composition.js";
import { createApiIllustrationApplication } from "../../services/runtime/src/illustration-composition.js";
import { startNextGeneration } from "../../services/worker/src/worker.js";
import { apiMemoryApplication } from "./memory-applications.js";
import { workerProviderGraph } from "./provider-application-fixtures.js";

const applications = new WeakMap<DatabasePool, Map<string, GenerationWorkerApplication>>();

function generationApplication(
  pool: DatabasePool,
  credentialSecret: string
): GenerationWorkerApplication {
  let byCredential = applications.get(pool);
  if (!byCredential) {
    byCredential = new Map();
    applications.set(pool, byCredential);
  }

  const existing = byCredential.get(credentialSecret);
  if (existing) return existing;

  const providers = workerProviderGraph(pool, credentialSecret);
  const application = createWorkerGenerationApplication(
    pool,
    createApiIllustrationApplication(pool, providers.illustration),
    apiMemoryApplication(pool, credentialSecret),
    providers.generation,
  );
  byCredential.set(credentialSecret, application);
  return application;
}

export async function runGenerationJob(
  pool: DatabasePool,
  workerId: string,
  leaseSeconds: number,
  credentialSecret: string
): Promise<boolean> {
  const application = generationApplication(pool, credentialSecret);
  const started = await startNextGeneration(application, workerId, leaseSeconds);
  return started ? started.execution : false;
}
