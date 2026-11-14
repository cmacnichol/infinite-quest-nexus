import { resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { createDatabasePool } from "../../packages/database/src/pool.js";

const integration = process.env.TEST_DATABASE_URL ? describe : describe.skip;
integration("fresh cast review baseline", () => {
  const pool = createDatabasePool(process.env.TEST_DATABASE_URL!, 2);
  afterAll(async () => { await pool.end(); });
  it("installs the baseline and decision migration together", async () => {
    expect(await migrateDatabase(pool, resolve("database/migrations"))).toEqual(["0133_baseline", "0134_cast_review_decisions"]);
    expect((await pool.query("SELECT to_regclass('campaign_cast_review_decisions') AS name")).rows[0].name).toBe("campaign_cast_review_decisions");
  });
});
