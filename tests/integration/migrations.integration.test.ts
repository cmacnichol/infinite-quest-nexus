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

  it("backfills existing campaigns with their pinned legacy character without changing campaign state", async () => {
    const databaseName = `infinitequest_character_migration_${crypto.randomUUID().replaceAll("-", "")}`;
    const databaseUrlValue = new URL(databaseUrl!);
    databaseUrlValue.pathname = `/${databaseName}`;
    const migrationDirectory = await mkdtemp(join(tmpdir(), "infinitequest-character-migrations-"));
    let isolatedPool: DatabasePool | null = null;
    try {
      await pool.query(`CREATE DATABASE ${databaseName}`);
      for (const file of await readdir(resolve("database/migrations"))) {
        if (file.endsWith(".sql") && file < "0017_campaign_characters.sql") {
          await copyFile(join(resolve("database/migrations"), file), join(migrationDirectory, file));
        }
      }
      isolatedPool = createDatabasePool(databaseUrlValue.toString(), 2);
      await migrateDatabase(isolatedPool, migrationDirectory);
      const owner = await isolatedPool.query<{ id: string }>("SELECT id FROM users WHERE system_key = 'initial-owner'");
      const world = await isolatedPool.query<{ id: string }>(
        "INSERT INTO worlds (owner_user_id, title) VALUES ($1, 'Existing World') RETURNING id",
        [owner.rows[0]!.id]
      );
      const version = await isolatedPool.query<{ id: string }>(
        `INSERT INTO world_versions (world_id, owner_user_id, version_number, content)
         VALUES ($1,$2,1,$3) RETURNING id`,
        [world.rows[0]!.id, owner.rows[0]!.id, JSON.stringify({
          schemaVersion: 2,
          world: { title: "Existing World", character: "Existing Hero\nKeeps the original campaign identity." },
          rpgStats: [{ id: "existing-stat", name: "Existing Stat", value: 55 }],
          defaultTriggers: [{ id: "existing-tracker", name: "Existing Tracker", value: "Existing" }]
        })]
      );
      const campaign = await isolatedPool.query<{ id: string }>(
        "INSERT INTO campaigns (owner_user_id, world_version_id, title) VALUES ($1,$2,'Existing Campaign') RETURNING id",
        [owner.rows[0]!.id, version.rows[0]!.id]
      );
      await migrateDatabase(isolatedPool, resolve("database/migrations"));
      const backfilled = await isolatedPool.query<any>(
        "SELECT selected_character_id, character_snapshot FROM campaigns WHERE id = $1",
        [campaign.rows[0]!.id]
      );
      expect(backfilled.rows[0]).toMatchObject({
        selected_character_id: "legacy-default",
        character_snapshot: {
          name: "Existing Hero",
          characterText: "Existing Hero\nKeeps the original campaign identity.",
          rpgStats: [{ id: "existing-stat" }],
          defaultTriggers: [{ id: "existing-tracker" }],
          legacy: true
        }
      });
    } finally {
      if (isolatedPool) await isolatedPool.end();
      await pool.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
      await rm(migrationDirectory, { recursive: true, force: true });
    }
  });
});
