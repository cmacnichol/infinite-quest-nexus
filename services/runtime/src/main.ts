import { createDatabasePool, loadRuntimeConfig, type DatabasePool, type RuntimeConfig } from "../../../packages/database/src/index.js";
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

const config = loadRuntimeConfig();
const abortController = new AbortController();

async function shutdown(signal: string): Promise<void> {
  logger.info({ event: "shutdown_requested", signal });
  abortController.abort();
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

async function dispatchRuntimeRole(
  roleConfig: RuntimeConfig,
  pool: DatabasePool,
  signal: AbortSignal
): Promise<void> {
  if (roleConfig.role === "migrate") {
    const applied = await migrateDatabase(pool, roleConfig.migrationDirectory, { allowMaintenanceMigrations: true });
    logger.info({ event: "migrations_complete", applied });
  } else {
    if (roleConfig.role === "worker") {
      await waitForDatabaseMigrations(pool, roleConfig.migrationDirectory, roleConfig.migrationWaitSeconds * 1000);
      logger.info({ event: "migrations_verified", role: roleConfig.role });
    } else {
      const applied = await migrateDatabase(pool, roleConfig.migrationDirectory, {
        allowMaintenanceMigrations: roleConfig.allowMaintenanceMigrations
      });
      logger.info({ event: "migrations_complete", role: roleConfig.role, applied });
    }
  }

  if (roleConfig.role === "api") {
    const generation = createApiGenerationApplication(pool);
    const server = await buildServer({ config: roleConfig, pool, generation });
    await server.listen({ host: roleConfig.host, port: roleConfig.port });
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    await server.close();
  } else if (roleConfig.role === "worker") {
    await runWorker(pool, roleConfig, signal);
  } else if (roleConfig.role === "all") {
    const generation = createApiGenerationApplication(pool);
    const server = await buildServer({ config: roleConfig, pool, generation });
    await server.listen({ host: roleConfig.host, port: roleConfig.port });
    await runWorker(pool, roleConfig, signal);
    await server.close();
  }
}

await runRuntimeLifecycle(config, abortController, {
  createPool: (roleConfig) => createDatabasePool(roleConfig.databaseUrl, roleConfig.databaseMaxConnections),
  createTransport: (roleConfig) => createProviderTransport({
    policy: createProviderNetworkPolicy({
      allowlist: roleConfig.security.providerNetworkAllowlist
    })
  }),
  configureTransport: configureDefaultProviderTransport,
  dispatchRole: dispatchRuntimeRole
});
