import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import {
  createDatabasePool,
  initialOwnerId,
  type DatabasePool
} from "../../packages/database/src/pool.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

integration("Task 14e3b4 pre-write and portable recovery migration", () => {
  let pool: DatabasePool;
  let ownerUserId = "";

  beforeAll(async () => {
    pool = createDatabasePool(databaseUrl!, 6);
    await migrateDatabase(pool, resolve("database/migrations"));
    ownerUserId = await initialOwnerId(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  async function reserve(purpose: "portable_staging" | "portable_export"): Promise<string> {
    const seed = crypto.randomUUID();
    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO durable_filesystem_operations (
         owner_user_id,operation_token_hash,purpose,resource_kind,operation_scope_hash,
         lease_id,lease_owner,lease_expires_at,expires_at
       ) VALUES ($1,$2,$3,'portable',$4,gen_random_uuid(),'b4-migration',
                 clock_timestamp()+interval '1 hour',clock_timestamp()+interval '1 hour')
       RETURNING id`,
      [ownerUserId, hash(`operation-${seed}`), purpose, hash(`scope-${seed}`)],
    );
    return inserted.rows[0]!.id;
  }

  it("persists only the operation-derived immutable pre-write target and created node identity", async () => {
    const operationId = await reserve("portable_staging");
    const relativePath = `staging/${operationId}.pending`;
    await expect(pool.query(
      `INSERT INTO durable_filesystem_prewrite_nodes (
         operation_id,owner_user_id,purpose,relative_path,device_id,file_id
       ) VALUES ($1,$2,'portable_staging',$3,'device-1','file-1')`,
      [operationId, ownerUserId, relativePath],
    )).resolves.toMatchObject({ rowCount: 1 });

    await expect(pool.query(
      "UPDATE durable_filesystem_prewrite_nodes SET file_id='replacement' WHERE operation_id=$1",
      [operationId],
    )).rejects.toMatchObject({ code: "55000" });
    await expect(pool.query(
      "DELETE FROM durable_filesystem_prewrite_nodes WHERE operation_id=$1",
      [operationId],
    )).rejects.toMatchObject({ code: "55000" });
  });

  it("rejects caller-selected paths and pre-write evidence after reservation", async () => {
    const wrongPathOperation = await reserve("portable_export");
    await expect(pool.query(
      `INSERT INTO durable_filesystem_prewrite_nodes (
         operation_id,owner_user_id,purpose,relative_path,device_id,file_id
       ) VALUES ($1,$2,'portable_export','exports/caller-selected.pending','device-2','file-2')`,
      [wrongPathOperation, ownerUserId],
    )).rejects.toMatchObject({ code: "23514" });

    const lateOperation = await reserve("portable_staging");
    await pool.query(
      "UPDATE durable_filesystem_operations SET lifecycle='cleanup_pending',cleanup_requested_at=clock_timestamp() WHERE id=$1",
      [lateOperation],
    );
    await expect(pool.query(
      `INSERT INTO durable_filesystem_prewrite_nodes (
         operation_id,owner_user_id,purpose,relative_path,device_id,file_id
       ) VALUES ($1,$2,'portable_staging',$3,'device-3','file-3')`,
      [lateOperation, ownerUserId, `staging/${lateOperation}.pending`],
    )).rejects.toMatchObject({ code: "55000" });
  });

  it("adds the partial-write and paired portable recovery indexes", async () => {
    const indexes = await pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
        WHERE schemaname=current_schema()
          AND indexname IN (
            'durable_filesystem_prewrite_recovery_idx',
            'durable_filesystem_portable_expiry_recovery_idx'
          )
        ORDER BY indexname`,
    );
    expect(indexes.rows.map((row) => row.indexname)).toEqual([
      "durable_filesystem_portable_expiry_recovery_idx",
      "durable_filesystem_prewrite_recovery_idx"
    ]);
  });
});
