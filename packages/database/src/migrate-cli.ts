import { createDatabasePool } from "./pool.js";
import { loadRuntimeConfig } from "./config.js";
import { migrateDatabase } from "./migrate.js";

const config = loadRuntimeConfig();
const pool = createDatabasePool(config.databaseUrl, 2);

try {
  const applied = await migrateDatabase(pool, config.migrationDirectory);
  console.log(JSON.stringify({ event: "migrations_complete", applied }));
} finally {
  await pool.end();
}
