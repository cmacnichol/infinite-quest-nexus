import type { IllustrationApplication, MemoryApplication } from "../../packages/application/src/index.js";
import type { DatabasePool } from "../../packages/database/src/pool.js";
import type { FilesystemAssetStore } from "../legacy-api/src/asset-service.js";
import { createApiGenerationApplication as composeApiGeneration } from "../../services/runtime/src/generation-api-composition.js";
import { createWorkerGenerationApplication as composeWorkerGeneration } from "../../services/runtime/src/generation-worker-composition.js";
import {
  createApiIllustrationApplication as composeApiIllustration,
  createWorkerIllustrationApplication as composeWorkerIllustration
} from "../../services/runtime/src/illustration-composition.js";
import { apiProviderGraph, workerProviderGraph } from "./provider-application-fixtures.js";
import { createApiWorldCampaignApplication as composeWorldCampaign } from "../../services/runtime/src/world-campaign-composition.js";
import {
  createApiMemoryApplication as composeApiMemory,
  createWorkerMemoryApplication as composeWorkerMemory
} from "../../services/runtime/src/memory-composition.js";

const DEFAULT_SECRET = "integration-test-credential-secret";

export function createApiGenerationApplication(pool: DatabasePool, credentialSecret = DEFAULT_SECRET) {
  return composeApiGeneration(pool, apiProviderGraph(pool, credentialSecret).generation);
}

export function createApiIllustrationApplication(pool: DatabasePool, credentialSecret = DEFAULT_SECRET) {
  return composeApiIllustration(pool, apiProviderGraph(pool, credentialSecret).illustration);
}

export function createWorkerGenerationApplication(
  pool: DatabasePool,
  credentialSecret: string,
  illustration: IllustrationApplication,
  memory: MemoryApplication,
) {
  return composeWorkerGeneration(
    pool,
    illustration,
    memory,
    workerProviderGraph(pool, credentialSecret).generation,
  );
}

export function createWorkerIllustrationApplication(
  pool: DatabasePool,
  credentialSecret: string,
  store: FilesystemAssetStore,
) {
  return composeWorkerIllustration(
    pool,
    workerProviderGraph(pool, credentialSecret).illustration,
  );
}

export function createApiWorldCampaignApplication(
  pool: DatabasePool,
  dependencies: Readonly<{ credentialSecret: string }>,
) {
  return composeWorldCampaign(pool, apiProviderGraph(pool, dependencies.credentialSecret));
}

export function createApiMemoryApplication(
  pool: DatabasePool,
  dependencies: Readonly<{ credentialSecret: string }>,
) {
  return composeApiMemory(pool, apiProviderGraph(pool, dependencies.credentialSecret).chronicle);
}

export function createWorkerMemoryApplication(pool: DatabasePool, credentialSecret: string) {
  return composeWorkerMemory(pool, workerProviderGraph(pool, credentialSecret).chronicle);
}
