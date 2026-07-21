import { createDatabasePool } from "./pool.js";
import { loadRuntimeConfig } from "./config.js";
import { migrateDatabase } from "./migrate.js";
import { logger } from "../../logger/src/index.js";

const config = loadRuntimeConfig();
const pool = createDatabasePool(config.databaseUrl, 2);

try {
  const applied = await migrateDatabase(pool, config.migrationDirectory, { allowMaintenanceMigrations: process.env.ALLOW_MAINTENANCE_MIGRATIONS === "true" });
  logger.info({ event: "migrations_complete", applied });
} catch (error) {
  logger.error({ event: "database_migration", error });
  process.exit(1);
} finally {
  await pool.end();
}
