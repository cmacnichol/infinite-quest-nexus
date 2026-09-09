import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabasePool, initialOwnerId, type DatabasePool } from "../../packages/database/src/pool.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration("story-only campaign policy migration", () => {
  let pool: DatabasePool;
  let ownerUserId: string;

  beforeAll(async () => {
    pool = createDatabasePool(databaseUrl!, 2);
    await migrateDatabase(pool, resolve("database/migrations"));
    ownerUserId = await initialOwnerId(pool);
  });

  afterAll(async () => { await pool?.end(); });

  it("adds nullable historical policy columns and keeps the initial owner profile readable", async () => {
    const columns = await pool.query<{ table_name: string; is_nullable: string }>(
      `SELECT table_name, is_nullable FROM information_schema.columns
        WHERE table_schema = 'public' AND column_name = 'generation_policy'
        ORDER BY table_name`,
    );
    expect(columns.rows).toEqual([
      { table_name: "generation_jobs", is_nullable: "YES" },
      { table_name: "turns", is_nullable: "YES" }
    ]);
    expect(ownerUserId).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it("requires non-null policies to use numeric version one and typed story prompts on both tables", async () => {
    const constraints = await pool.query<{ table_name: string; definition: string }>(
      `SELECT r.relname AS table_name, pg_get_constraintdef(c.oid) AS definition
         FROM pg_constraint c
         JOIN pg_class r ON r.oid = c.conrelid
         JOIN pg_namespace n ON n.oid = r.relnamespace
        WHERE n.nspname = 'public'
          AND r.relname IN ('generation_jobs', 'turns')
          AND c.conname IN ('generation_jobs_generation_policy_valid', 'turns_generation_policy_valid')
        ORDER BY r.relname`,
    );
    expect(constraints.rows).toHaveLength(2);
    for (const constraint of constraints.rows) {
      expect(constraint.definition).toContain("jsonb_typeof((generation_policy -> 'version'::text)) = 'number'::text");
      expect(constraint.definition).toContain("COALESCE");
      expect(constraint.definition).toContain("choiceRepairSystemHash");
    }
  });
});
