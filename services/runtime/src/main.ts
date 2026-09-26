import { createDatabasePool, loadRuntimeConfig } from "../../../packages/database/src/index.js";
import { migrateDatabase, waitForDatabaseMigrations } from "../../../packages/database/src/migrate.js";
import { buildServer } from "../../api/src/server.js";
import { createApiCampaignCastApplication, createWorkerCampaignCastApplication } from "./campaign-cast-composition.js";
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
import { createRuntimeAuthoringApplication, createRuntimeAuthoringWorkerApplication } from "./authoring-composition.js";
import { createHash } from "node:crypto";
import {
  createApiProviderApplicationComposition,
  createWorkerProviderApplicationComposition
} from "./provider-application-composition.js";
import { createProviderApplicationAdapter } from "../../api/src/provider-application-adapter.js";
import { loadSchemaVerificationFile } from "./provider-schema-verification.js";

const config = loadRuntimeConfig();
const schemaVerification = loadSchemaVerificationFile(process.env.TEXT_SCHEMA_VERIFICATION_FILE?.trim() || undefined);
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
  dispatchRole: (roleConfig, pool, signal, providerTransport, generationEvents) => dispatchRuntimeRole(roleConfig, pool, signal, {
    migrateDatabase,
    waitForDatabaseMigrations,
    createApiProviders: (pool, credentialSecret, transport) => createApiProviderApplicationComposition(
      pool,
      { credentialSecret, transport, schemaVerifications: schemaVerification.records, schemaVerificationDigest: schemaVerification.digest,
        nativeTextExecutionPlanAdmission: config.nativeTextExecutionPlanAdmission === true, castDiscoveryEnabled: config.castDiscoveryEnabled === true, castContextEnabled: config.castContextEnabled === true, textProviderConcurrency: config.textProviderConcurrency ?? 2 }
    ),
    createWorkerProviders: (pool, credentialSecret, transport) => createWorkerProviderApplicationComposition(
      pool,
      { credentialSecret, transport, schemaVerifications: schemaVerification.records, schemaVerificationDigest: schemaVerification.digest,
        nativeTextExecutionPlanAdmission: config.nativeTextExecutionPlanAdmission === true, castDiscoveryEnabled: config.castDiscoveryEnabled === true, castContextEnabled: config.castContextEnabled === true, textProviderConcurrency: config.textProviderConcurrency ?? 2 }
    ),
    createProviderApiAdapter: createProviderApplicationAdapter,
    createApiGeneration: (pool, providers, operatorConfig) => createApiGenerationApplication(
      pool, providers, undefined, operatorConfig, config.nativeTextExecutionPlanAdmission === true
    ),
    createApiIllustration: createApiIllustrationApplication,
    createApiMemory: createApiMemoryApplication,
    createApiWorldCampaign: createApiWorldCampaignApplication,
    createWorkerMemory: createWorkerMemoryApplication,
    createWorkerIllustration: createWorkerIllustrationApplication,
    createWorkerGeneration: createWorkerGenerationApplication,
    createWorkerCastDiscovery: (pool, config, providers) => createWorkerCampaignCastApplication(pool, config, providers.preparedTextExecutor),
    createWorkerAuthoring: (pool, providers, signal) => createRuntimeAuthoringWorkerApplication({
      pool, providers, signal, sha256: (value) => createHash("sha256").update(value).digest("hex"),
      nativePresetPlansEnabled: config.nativeTextExecutionPlanAdmission === true
    }),
    createApiAuthoring: (pool) => createRuntimeAuthoringApplication(
      pool,
      (value) => createHash("sha256").update(value).digest("hex"),
      { nativePresetPlansEnabled: config.nativeTextExecutionPlanAdmission === true }
    ),
    createApiCast: createApiCampaignCastApplication,
    buildServer,
    runWorker
  }, providerTransport, generationEvents)
});
