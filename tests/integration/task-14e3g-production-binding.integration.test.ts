import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPostgresImportProgressRepository } from "../../packages/database/src/import-progress-repository.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import {
  createDatabasePool,
  type DatabasePool
} from "../../packages/database/src/pool.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration("Task 14e3g production binding", () => {
  let pool: DatabasePool;
  let ownerUserId = "";
  let foreignOwnerUserId = "";

  beforeAll(async () => {
    pool = createDatabasePool(databaseUrl!, 4);
    await migrateDatabase(pool, resolve("database/migrations"));
    const users = await pool.query<{ id: string }>(
      `INSERT INTO users (display_name,status)
       VALUES ('e3g progress owner','active'),('e3g foreign progress owner','active')
       RETURNING id`,
    );
    ownerUserId = users.rows[0]!.id;
    foreignOwnerUserId = users.rows[1]!.id;
  });

  afterAll(async () => {
    await pool.query("DELETE FROM import_progress_status WHERE owner_user_id=ANY($1::uuid[])", [[ownerUserId, foreignOwnerUserId]]);
    await pool.query("DELETE FROM users WHERE id=ANY($1::uuid[])", [[ownerUserId, foreignOwnerUserId]]);
    await pool.end();
  });

  it("persists owner-scoped import progress across repository reconstruction without storing the raw key", async () => {
    const key = `canals-${crypto.randomUUID()}.json:1234`;
    const owner = { ownerUserId };
    const repository = createPostgresImportProgressRepository(pool);

    await repository.begin({ owner, key }, {
      phase: "extracting",
      progressPercent: 5,
      message: "Parsing the source export."
    });
    await repository.update({ owner, key }, {
      phase: "generating",
      progressPercent: 45,
      message: "Generating the world and playable characters."
    });

    const restarted = createPostgresImportProgressRepository(pool);
    await expect(restarted.read({ owner, key })).resolves.toEqual({
      status: "processing",
      phase: "generating",
      progressPercent: 45,
      message: "Generating the world and playable characters."
    });
    await expect(restarted.read({ owner: { ownerUserId: foreignOwnerUserId }, key }))
      .resolves.toBeNull();
    await expect(pool.query<{ lookup_key_hash: string; raw_key_present: boolean }>(
      `SELECT lookup_key_hash,
              position($2 in row_to_json(progress)::text) > 0 AS raw_key_present
         FROM import_progress_status progress
        WHERE owner_user_id=$1`,
      [ownerUserId, key],
    )).resolves.toMatchObject({ rows: [{
      lookup_key_hash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      raw_key_present: false
    }] });

    const worldId = crypto.randomUUID();
    const worldVersionId = crypto.randomUUID();
    await repository.complete({ owner, key }, {
      phase: "completed",
      message: "World generation completed.",
      worldId,
      worldVersionId,
      duplicate: false
    });
    await expect(restarted.read({ owner, key })).resolves.toEqual({
      status: "completed",
      phase: "completed",
      progressPercent: 100,
      message: "World generation completed.",
      worldId,
      worldVersionId,
      duplicate: false
    });

    await repository.begin({ owner, key }, {
      phase: "extracting",
      progressPercent: 5,
      message: "Retrying the source export."
    });
    await repository.fail({ owner, key }, {
      phase: "failed",
      message: "The selected provider is unavailable.",
      errorMessage: "The selected provider is unavailable."
    });
    await expect(restarted.read({ owner, key })).resolves.toEqual({
      status: "failed",
      phase: "failed",
      progressPercent: 100,
      message: "The selected provider is unavailable.",
      errorMessage: "The selected provider is unavailable."
    });
  });
});
