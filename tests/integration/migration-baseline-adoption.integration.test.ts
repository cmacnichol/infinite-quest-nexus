import { expect, it } from "vitest";
import { resolve } from "node:path";
import { historicalMigrations } from "../fixtures/historical-migrations.js";
import { createDatabasePool, initialOwnerId } from "../../packages/database/src/pool.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";

it("adopts the complete historical ledger without replaying SQL against tenant data", async () => {
  const pool = createDatabasePool(process.env.TEST_DATABASE_URL!);
  const directory = resolve("database/migrations");
  try {
    expect(await migrateDatabase(pool, historicalMigrations)).toHaveLength(133);
    const owner = await initialOwnerId(pool);
    const world = (await pool.query("INSERT INTO worlds(owner_user_id,title) VALUES($1,'Existing world') RETURNING id", [owner])).rows[0];
    await pool.query("UPDATE schema_migrations SET name='unexpected' WHERE name='0001_initial_nexus'");
    await expect(migrateDatabase(pool, directory)).rejects.toThrow();
    expect((await pool.query("SELECT name FROM schema_migrations")).rowCount).toBe(133);
    await pool.query("UPDATE schema_migrations SET name='0001_initial_nexus' WHERE name='unexpected'");
    await migrateDatabase(pool, directory);
    expect((await pool.query("SELECT name FROM schema_migrations")).rows).toEqual([{name:"0133_baseline"}]);
    expect(await migrateDatabase(pool, directory)).toEqual([]);
    expect(await initialOwnerId(pool)).toBe(owner);
    expect((await pool.query("SELECT owner_user_id,title FROM worlds WHERE id=$1", [world.id])).rows)
      .toEqual([{owner_user_id:owner,title:"Existing world"}]);
  } finally { await pool.end(); }
});
