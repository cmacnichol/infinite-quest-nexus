import { createDatabasePool, loadRuntimeConfig } from "../../../packages/database/src/index.js";
import { migrateDatabase } from "../../../packages/database/src/migrate.js";
import { buildServer } from "../../api/src/server.js";
import { runWorker } from "../../worker/src/worker.js";

const config = loadRuntimeConfig();
const pool = createDatabasePool(config.databaseUrl, config.databaseMaxConnections);
const abortController = new AbortController();

async function shutdown(signal: string): Promise<void> {
  console.log(JSON.stringify({ event: "shutdown_requested", signal }));
  abortController.abort();
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

try {
  if (config.role === "migrate") {
    const applied = await migrateDatabase(pool, config.migrationDirectory);
    console.log(JSON.stringify({ event: "migrations_complete", applied }));
  } else if (config.role === "api") {
    const server = await buildServer({ config, pool });
    await server.listen({ host: config.host, port: config.port });
    await new Promise<void>((resolve) => abortController.signal.addEventListener("abort", () => resolve(), { once: true }));
    await server.close();
  } else if (config.role === "worker") {
    await runWorker(pool, config, abortController.signal);
  } else {
    const server = await buildServer({ config, pool });
    await server.listen({ host: config.host, port: config.port });
    await runWorker(pool, config, abortController.signal);
    await server.close();
  }
} finally {
  await pool.end();
}
