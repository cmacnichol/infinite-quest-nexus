import { createDatabasePool, loadRuntimeConfig } from "../../../packages/database/src/index.js";
import { migrateDatabase, waitForDatabaseMigrations } from "../../../packages/database/src/migrate.js";
import { buildServer } from "../../api/src/server.js";
import { runWorker } from "../../worker/src/worker.js";
import { logger } from "../../../packages/logger/src/index.js";

const config = loadRuntimeConfig();
const pool = createDatabasePool(config.databaseUrl, config.databaseMaxConnections);
const abortController = new AbortController();

async function shutdown(signal: string): Promise<void> {
  logger.info({ event: "shutdown_requested", signal });
  abortController.abort();
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

try {
  if (config.role === "migrate") {
    const applied = await migrateDatabase(pool, config.migrationDirectory, { allowMaintenanceMigrations: true });
    logger.info({ event: "migrations_complete", applied });
  } else {
    if (config.role === "worker") {
      await waitForDatabaseMigrations(pool, config.migrationDirectory, config.migrationWaitSeconds * 1000);
      logger.info({ event: "migrations_verified", role: config.role });
    } else {
      const applied = await migrateDatabase(pool, config.migrationDirectory, {
        allowMaintenanceMigrations: config.allowMaintenanceMigrations
      });
      logger.info({ event: "migrations_complete", role: config.role, applied });
    }
  }

  if (config.role === "api") {
    const server = await buildServer({ config, pool });
    await server.listen({ host: config.host, port: config.port });
    await new Promise<void>((resolve) => abortController.signal.addEventListener("abort", () => resolve(), { once: true }));
    await server.close();
  } else if (config.role === "worker") {
    await runWorker(pool, config, abortController.signal);
  } else if (config.role === "all") {
    const server = await buildServer({ config, pool });
    await server.listen({ host: config.host, port: config.port });
    await runWorker(pool, config, abortController.signal);
    await server.close();
  }
} finally {
  await pool.end();
}
