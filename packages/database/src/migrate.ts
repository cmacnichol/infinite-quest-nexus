import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { runner, type RunnerOption } from "node-pg-migrate";
import type { DatabasePool } from "./pool.js";
import { logger } from "../../logger/src/index.js";

const MIGRATIONS_TABLE = "schema_migrations";
const MAINTENANCE_SUFFIX = ".maintenance";
const PHASED_MIGRATION_DIRECTIVE = "-- infinitequest:migration-mode=phased-transactions-v1";
const PHASE_BOUNDARY = "-- infinitequest:transaction-boundary";
const PHASED_MIGRATION_BOUNDARIES = new Map<string, number>([
  ["0078_system_archive_jobs", 2]
]);

type MigrationRunOptions = {
  allowMaintenanceMigrations?: boolean;
};

const migrationLogger: NonNullable<RunnerOption["logger"]> = {
  info: (message) => logger.info({ event: "database_migration", message }),
  warn: (message) => logger.warn({ event: "database_migration", message }),
  error: (message) => logger.error({ event: "database_migration", message })
};

const silentMigrationLogger: NonNullable<RunnerOption["logger"]> = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined
};

function topLevelSqlStatements(source: string): string[] {
  const statements: string[] = [];
  let statement = "";
  let index = 0;
  const finishStatement = (): void => {
    const value = statement.trim();
    if (value) statements.push(value);
    statement = "";
  };

  while (index < source.length) {
    if (source.startsWith("--", index)) {
      const newline = source.indexOf("\n", index + 2);
      index = newline < 0 ? source.length : newline + 1;
      statement += " ";
      continue;
    }
    if (source.startsWith("/*", index)) {
      let depth = 1;
      index += 2;
      while (index < source.length && depth > 0) {
        if (source.startsWith("/*", index)) {
          depth += 1;
          index += 2;
        } else if (source.startsWith("*/", index)) {
          depth -= 1;
          index += 2;
        } else {
          index += 1;
        }
      }
      statement += " ";
      continue;
    }

    const character = source[index]!;
    if (character === "'" || character === "\"") {
      const quote = character;
      const escapeQuoted = quote === "'"
        && (/^[eE]$/u.test(source[index - 1] ?? "")
          || source.slice(Math.max(0, index - 2), index).toUpperCase() === "U&");
      index += 1;
      while (index < source.length) {
        if (escapeQuoted && source[index] === "\\") {
          index += Math.min(2, source.length - index);
        } else if (source[index] === quote && source[index + 1] === quote) {
          index += 2;
        } else if (source[index] === quote) {
          index += 1;
          break;
        } else {
          index += 1;
        }
      }
      statement += " ";
      continue;
    }

    if (character === "$") {
      const dollarTag = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/u.exec(source.slice(index))?.[0];
      if (dollarTag) {
        const closing = source.indexOf(dollarTag, index + dollarTag.length);
        index = closing < 0 ? source.length : closing + dollarTag.length;
        statement += " ";
        continue;
      }
    }

    if (character === ";") {
      finishStatement();
      index += 1;
      continue;
    }
    statement += character;
    index += 1;
  }
  finishStatement();
  return statements;
}

type TransactionControl = Readonly<{
  command: string;
  statement: string;
}>;

function transactionControl(statement: string): TransactionControl | null {
  const tokens = statement.match(/[A-Za-z_][A-Za-z0-9_$]*/gu)?.map((token) => token.toUpperCase()) ?? [];
  const first = tokens[0];
  if (!first) return null;
  if (["ABORT", "BEGIN", "COMMIT", "END", "RELEASE", "ROLLBACK", "SAVEPOINT"].includes(first)) {
    return { command: first, statement };
  }
  if (first === "START" && tokens[1] === "TRANSACTION") {
    return { command: "START TRANSACTION", statement };
  }
  if (first === "PREPARE" && tokens[1] === "TRANSACTION") {
    return { command: "PREPARE TRANSACTION", statement };
  }
  if (first === "SET" && (
    tokens[1] === "TRANSACTION"
    || tokens.slice(1, 5).join(" ") === "SESSION CHARACTERISTICS AS TRANSACTION"
  )) {
    return { command: "SET TRANSACTION", statement };
  }
  return null;
}

async function validateMigrationTransactionContracts(
  migrationDirectory: string,
  migrationNames: readonly string[]
): Promise<void> {
  for (const migrationName of migrationNames) {
    let source: string;
    try {
      source = await readFile(join(migrationDirectory, `${migrationName}.sql`), "utf8");
    } catch (error: any) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }

    const controls = topLevelSqlStatements(source)
      .map(transactionControl)
      .filter((control): control is TransactionControl => control !== null);
    const expectedBoundaries = PHASED_MIGRATION_BOUNDARIES.get(migrationName);
    if (expectedBoundaries === undefined) {
      if (controls.length > 0) {
        throw new Error(
          `Migration ${migrationName} contains transaction control without an approved phased contract.`
        );
      }
      continue;
    }

    if (!source.startsWith(`${PHASED_MIGRATION_DIRECTIVE}\n`)) {
      throw new Error(`Migration ${migrationName} is missing its approved phased transaction directive.`);
    }
    const boundaryCount = source.match(/^-- infinitequest:transaction-boundary$/gmu)?.length ?? 0;
    if (boundaryCount !== expectedBoundaries) {
      throw new Error(
        `Migration ${migrationName} must contain exactly ${expectedBoundaries} approved transaction boundaries.`
      );
    }
    const expectedControls = Array.from(
      { length: expectedBoundaries },
      () => ["COMMIT", "BEGIN"]
    ).flat();
    if (controls.length !== expectedControls.length
      || controls.some((control, index) => (
        control.command !== expectedControls[index]
        || control.statement.toUpperCase() !== expectedControls[index]
      ))) {
      throw new Error(`Migration ${migrationName} has invalid phased transaction control.`);
    }
    for (const phase of source.split(PHASE_BOUNDARY).slice(1)) {
      if (!/^\r?\nCOMMIT;\r?\nBEGIN;/u.test(phase)) {
        throw new Error(`Migration ${migrationName} has an invalid transaction boundary marker.`);
      }
    }
  }
}

async function runMigrations(
  pool: DatabasePool,
  migrationDirectory: string,
  dryRun: boolean,
  expectedMigrations?: readonly string[]
): Promise<string[]> {
  if (!dryRun && expectedMigrations) {
    await validateMigrationTransactionContracts(migrationDirectory, expectedMigrations);
  }
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
    const names = migrations.map((migration) => migration.name);
    if (dryRun) await validateMigrationTransactionContracts(migrationDirectory, names);
    return names;
  } finally {
    client.release();
  }
}

const MIGRATION_ADVISORY_LOCK_ID = 482910481;

async function withMigrationLock<T>(pool: DatabasePool, action: () => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_ADVISORY_LOCK_ID]);
    return await action();
  } finally {
    try {
      await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_ADVISORY_LOCK_ID]);
    } catch {
      // ignore unlock failure if connection broke
    }
    client.release();
  }
}

async function appliedMigrationCount(pool: DatabasePool): Promise<number> {
  try {
    const result = await pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM ${MIGRATIONS_TABLE}`);
    return Number.parseInt(result.rows[0]?.count ?? "0", 10);
  } catch (error: any) {
    if (error?.code === "42P01") {
      return 0;
    }
    throw error;
  }
}

export async function pendingDatabaseMigrations(pool: DatabasePool, migrationDirectory: string): Promise<string[]> {
  return runMigrations(pool, migrationDirectory, true);
}

export async function migrateDatabase(
  pool: DatabasePool,
  migrationDirectory: string,
  options: MigrationRunOptions = {}
): Promise<string[]> {
  return withMigrationLock(pool, async () => {
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
    return runMigrations(pool, migrationDirectory, false, pending);
  });
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
