import { createDatabasePool, loadRuntimeConfig } from "../../../packages/database/src/index.js";
import { migrateDatabase, waitForDatabaseMigrations } from "../../../packages/database/src/migrate.js";
import { buildServer } from "../../api/src/server.js";
import { runWorker } from "../../worker/src/worker.js";
import { logger } from "../../../packages/logger/src/index.js";
import { createProviderNetworkPolicy } from "../../../packages/security/src/provider-network-policy.js";
import {
  configureDefaultProviderTransport,
  createProviderTransport
} from "../../../packages/story-engine/src/provider-transport.js";
import { runRuntimeLifecycle } from "./lifecycle.js";
import { createApiGenerationApplication } from "./generation-api-composition.js";
import { createWorkerGenerationApplication } from "./generation-worker-composition.js";
import {
  createApiIllustrationApplication,
  createWorkerIllustrationApplication
} from "./illustration-composition.js";
import { dispatchRuntimeRole } from "./runtime-role.js";
import { createRuntimeGenerationEventSource } from "./generation-event-composition.js";
import { createApiMemoryApplication, createWorkerMemoryApplication } from "./memory-composition.js";
import { createApiWorldCampaignApplication } from "./world-campaign-composition.js";

const config = loadRuntimeConfig();
const abortController = new AbortController();

async function shutdown(signal: string): Promise<void> {
  logger.info({ event: "shutdown_requested", signal });
  abortController.abort();
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

await runRuntimeLifecycle(config, abortController, {
  createPool: (roleConfig) => createDatabasePool(roleConfig.databaseUrl, roleConfig.databaseMaxConnections),
  createTransport: (roleConfig) => createProviderTransport({
    policy: createProviderNetworkPolicy({
      allowlist: roleConfig.security.providerNetworkAllowlist
    })
  }),
  configureTransport: configureDefaultProviderTransport,
  createGenerationEvents: createRuntimeGenerationEventSource,
  dispatchRole: (roleConfig, pool, signal, generationEvents) => dispatchRuntimeRole(roleConfig, pool, signal, {
    migrateDatabase,
    waitForDatabaseMigrations,
    createApiGeneration: createApiGenerationApplication,
    createApiIllustration: createApiIllustrationApplication,
    createApiMemory: (pool, credentialSecret) => createApiMemoryApplication(pool, { credentialSecret }),
    createApiWorldCampaign: (pool, credentialSecret) => createApiWorldCampaignApplication(pool, { credentialSecret }),
    createWorkerMemory: createWorkerMemoryApplication,
    createWorkerIllustration: (pool, credentialSecret, assetStorageRoot) => createWorkerIllustrationApplication(
      pool,
      credentialSecret,
      { root: assetStorageRoot }
    ),
    createWorkerGeneration: (pool, credentialSecret, illustration, memory) => createWorkerGenerationApplication(
      pool,
      credentialSecret,
      illustration,
      memory
    ),
    buildServer,
    runWorker
  }, generationEvents)
});
