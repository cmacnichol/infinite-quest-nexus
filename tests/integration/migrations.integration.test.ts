import { copyFile, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateDatabase, pendingDatabaseMigrations } from "../../packages/database/src/migrate.js";
import { createDatabasePool, type DatabasePool } from "../../packages/database/src/pool.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration("standard database migration runner", () => {
  let pool: DatabasePool;

  beforeAll(async () => {
    pool = createDatabasePool(databaseUrl!, 2);
    await migrateDatabase(pool, resolve("database/migrations"));
  });

  afterAll(async () => {
    if (pool) await pool.end();
  });

  it("blocks maintenance migrations on an existing database until explicitly allowed", async () => {
    const sourceDirectory = resolve("database/migrations");
    const migrationDirectory = await mkdtemp(join(tmpdir(), "infinitequest-migrations-"));
    const migrationName = "9999_runner_policy.maintenance";
    const tableName = "migration_runner_policy_test";
    try {
      for (const file of await readdir(sourceDirectory)) {
        if (file.endsWith(".sql")) await copyFile(join(sourceDirectory, file), join(migrationDirectory, file));
      }
      await writeFile(join(migrationDirectory, `${migrationName}.sql`), `CREATE TABLE ${tableName} (id integer PRIMARY KEY);\n`);

      await expect(pendingDatabaseMigrations(pool, migrationDirectory)).resolves.toContain(migrationName);
      await expect(migrateDatabase(pool, migrationDirectory)).rejects.toThrow("Database maintenance migration required");
      await expect(pool.query("SELECT to_regclass($1) AS table_name", [`public.${tableName}`]))
        .resolves.toMatchObject({ rows: [{ table_name: null }] });

      await expect(migrateDatabase(pool, migrationDirectory, { allowMaintenanceMigrations: true }))
        .resolves.toEqual([migrationName]);
      await expect(pool.query("SELECT to_regclass($1) AS table_name", [`public.${tableName}`]))
        .resolves.toMatchObject({ rows: [{ table_name: tableName }] });
    } finally {
      await pool.query(`DROP TABLE IF EXISTS ${tableName}`);
      await pool.query("DELETE FROM schema_migrations WHERE name = $1", [migrationName]);
      await rm(migrationDirectory, { recursive: true, force: true });
    }
  });
});
