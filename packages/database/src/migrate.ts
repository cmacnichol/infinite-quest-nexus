import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { DatabasePool } from "./pool.js";

const MIGRATION_LOCK_KEY = 7_164_281_923;

export async function migrateDatabase(pool: DatabasePool, migrationDirectory: string): Promise<string[]> {
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const files = (await readdir(migrationDirectory))
      .filter((file) => /^\d+_.+\.sql$/i.test(file))
      .sort((left, right) => left.localeCompare(right));

    for (const file of files) {
      const version = basename(file, ".sql");
      const exists = await client.query("SELECT 1 FROM schema_migrations WHERE version = $1", [version]);
      if (exists.rowCount) continue;
      const sql = await readFile(join(migrationDirectory, file), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT DO NOTHING", [version]);
        await client.query("COMMIT");
        applied.push(version);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
    return applied;
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]).catch(() => undefined);
    client.release();
  }
}
