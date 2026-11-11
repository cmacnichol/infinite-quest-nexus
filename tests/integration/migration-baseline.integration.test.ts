import { expect, it } from "vitest";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createDatabasePool, initialOwnerId } from "../../packages/database/src/pool.js";
import { migrateDatabase, pendingDatabaseMigrations } from "../../packages/database/src/migrate.js";

it("installs the baseline once, preserves the owner, and applies subsequent migrations in order", async () => {
  const pool = createDatabasePool(process.env.TEST_DATABASE_URL!);
  const directory = resolve("database/migrations");
  const nextRelease = await mkdtemp(join(tmpdir(), "iq-after-baseline-"));
  try {
    expect(await migrateDatabase(pool, directory)).toEqual(["0133_baseline"]);
    const owner = await initialOwnerId(pool);
    expect(await pendingDatabaseMigrations(pool, directory)).toEqual([]);
    expect(await migrateDatabase(pool, directory)).toEqual([]);
    expect(await initialOwnerId(pool)).toBe(owner);

    await copyFile(join(directory, "0133_baseline.sql"), join(nextRelease, "0133_baseline.sql"));
    await writeFile(join(nextRelease, "0134_test.sql"), "CREATE TABLE baseline_test (id integer PRIMARY KEY);");
    expect(await pendingDatabaseMigrations(pool, nextRelease)).toEqual(["0134_test"]);
    expect(await migrateDatabase(pool, nextRelease)).toEqual(["0134_test"]);
    expect(await migrateDatabase(pool, nextRelease)).toEqual([]);
  } finally {
    await pool.end();
    await rm(nextRelease, { recursive: true, force: true });
  }
});
