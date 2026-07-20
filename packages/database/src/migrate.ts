import { runner, type RunnerOption } from "node-pg-migrate";
import type { DatabasePool } from "./pool.js";

const MIGRATIONS_TABLE = "schema_migrations";
const MAINTENANCE_SUFFIX = ".maintenance";

type MigrationRunOptions = {
  allowMaintenanceMigrations?: boolean;
};

const migrationLogger: NonNullable<RunnerOption["logger"]> = {
  info: (message) => console.log(JSON.stringify({ event: "database_migration", level: "info", message })),
  warn: (message) => console.warn(JSON.stringify({ event: "database_migration", level: "warn", message })),
  error: (message) => console.error(JSON.stringify({ event: "database_migration", level: "error", message }))
};

const silentMigrationLogger: NonNullable<RunnerOption["logger"]> = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined
};

async function runMigrations(
  pool: DatabasePool,
  migrationDirectory: string,
  dryRun: boolean
): Promise<string[]> {
  const client = await pool.connect();
  try {
    const migrations = await runner({
      dbClient: client,
      dir: migrationDirectory,
      direction: "up",
      migrationsTable: MIGRATIONS_TABLE,
      checkOrder: true,
      singleTransaction: true,
      advisoryLockMode: "wait",
      dryRun,
      verbose: false,
      logger: dryRun ? silentMigrationLogger : migrationLogger
    });
    return migrations.map((migration) => migration.name);
  } finally {
    client.release();
  }
}

async function appliedMigrationCount(pool: DatabasePool): Promise<number> {
  const result = await pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM ${MIGRATIONS_TABLE}`);
  return Number.parseInt(result.rows[0]?.count ?? "0", 10);
}

export async function pendingDatabaseMigrations(pool: DatabasePool, migrationDirectory: string): Promise<string[]> {
  return runMigrations(pool, migrationDirectory, true);
}

export async function migrateDatabase(
  pool: DatabasePool,
  migrationDirectory: string,
  options: MigrationRunOptions = {}
): Promise<string[]> {
  const pending = await pendingDatabaseMigrations(pool, migrationDirectory);
  if (pending.length === 0) return [];
  const maintenance = pending.filter((name) => name.endsWith(MAINTENANCE_SUFFIX));
  const isNewDatabase = (await appliedMigrationCount(pool)) === 0;
  if (maintenance.length > 0 && !isNewDatabase && !options.allowMaintenanceMigrations) {
    throw new Error(
      `Database maintenance migration required: ${maintenance.join(", ")}. ` +
      "Back up the database and run the migrate role or set ALLOW_MAINTENANCE_MIGRATIONS=true."
    );
  }
  return runMigrations(pool, migrationDirectory, false);
}

export async function waitForDatabaseMigrations(
  pool: DatabasePool,
  migrationDirectory: string,
  timeoutMs: number,
  pollIntervalMs = 1000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let pending: string[] = [];
  let lastError: unknown;
  do {
    try {
      pending = await pendingDatabaseMigrations(pool, migrationDirectory);
      lastError = undefined;
      if (pending.length === 0) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  } while (Date.now() < deadline);

  if (lastError instanceof Error) {
    throw new Error(`Database migrations were not ready within ${timeoutMs}ms: ${lastError.message}`, { cause: lastError });
  }
  throw new Error(`Database migrations were not ready within ${timeoutMs}ms. Pending: ${pending.join(", ")}`);
}
