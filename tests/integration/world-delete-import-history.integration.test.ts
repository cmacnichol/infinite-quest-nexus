import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { createDatabasePool, initialOwnerId, type DatabasePool } from "../../packages/database/src/pool.js";
import { createPostgresWorldRepositoryAdapters } from "../../packages/database/src/world-repository.js";
import { memoryGeneration } from "../helpers/memory-applications.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration("World deletion with durable import history", () => {
  let pool: DatabasePool;
  let ownerUserId: string;

  beforeAll(async () => {
    pool = createDatabasePool(databaseUrl!, 4);
    await migrateDatabase(pool, resolve("database/migrations"));
    ownerUserId = await initialOwnerId(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("deletes an imported world while preserving its committed import audit and unrelated imports", async () => {
    const adapters = createPostgresWorldRepositoryAdapters(pool, { memory: memoryGeneration(pool) });
    const title = "Synthetic imported deletion world";
    const created = await adapters.transaction.command((transaction) => adapters.worlds.createWorld(
      transaction, { ownerUserId }, { title }
    ));
    if (!created.ok) throw new Error("world fixture creation failed");
    const worldId = created.value.id;
    const version = await pool.query<{ id: string }>(
      "INSERT INTO world_versions (world_id,owner_user_id,version_number,content) VALUES ($1,$2,1,'{}') RETURNING id",
      [worldId, ownerUserId]
    );
    const versionId = version.rows[0]!.id;
    const imported = await pool.query<{ id: string }>(
      `INSERT INTO imports (owner_user_id,source_type,source_name,source_hash,status,world_id,world_version_id,stats)
       VALUES ($1,'world','synthetic-world.json',$2,'completed',$3,$4,'{"worldCount":1}') RETURNING id`,
      [ownerUserId, crypto.randomUUID(), worldId, versionId]
    );
    const importId = imported.rows[0]!.id;
    const filesystem = await pool.query<{ id: string }>(
      `INSERT INTO durable_filesystem_operations (
         owner_user_id,operation_token_hash,purpose,resource_kind,operation_scope_hash,
         lease_id,lease_owner,lease_expires_at,expires_at
       ) VALUES ($1,$2,'portable_staging','portable',$2,gen_random_uuid(),'delete-test',now()+interval '1 hour',now()+interval '1 hour')
       RETURNING id`,
      [ownerUserId, "a".repeat(64)]
    );
    const staged = await pool.query<{ id: string }>(
      `INSERT INTO portable_staged_inputs (owner_user_id,handle_token_hash,filesystem_operation_id,content_hash,byte_length,expires_at)
       VALUES ($1,$2,$3,$2,1,now()+interval '1 hour') RETURNING id`,
      [ownerUserId, "b".repeat(64), filesystem.rows[0]!.id]
    );
    const operation = await pool.query<{ id: string }>(
      `INSERT INTO portable_import_operations (
         owner_user_id,staged_input_id,import_kind,preview_token_hash,result_retrieval_token_hash,
         content_fingerprint,destination_fingerprint,destination_kind,status,preview_projection,
         idempotency_key_hash,commit_request_fingerprint,import_id,result_projection,expires_at,completed_at
       ) VALUES ($1,$2,'world_json',$3,$3,$3,$3,'create_world','committed','{}',$3,$3,$4,$5,now()+interval '1 hour',now())
       RETURNING id`,
      [ownerUserId, staged.rows[0]!.id, "c".repeat(64), importId, JSON.stringify({ worldId, worldVersionId: versionId })]
    );
    const unrelated = await pool.query<{ id: string }>(
      `INSERT INTO imports (owner_user_id,source_type,source_name,source_hash,status)
       VALUES ($1,'world','unrelated.json',$2,'completed') RETURNING id`,
      [ownerUserId, crypto.randomUUID()]
    );
    const beforeImport = (await pool.query("SELECT * FROM imports WHERE id=$1", [importId])).rows[0];
    const beforeOperation = (await pool.query("SELECT * FROM portable_import_operations WHERE id=$1", [operation.rows[0]!.id])).rows[0];
    const beforeUnrelated = (await pool.query("SELECT * FROM imports WHERE id=$1", [unrelated.rows[0]!.id])).rows[0];

    const foreignDeletion = await adapters.transaction.command((transaction) => adapters.worlds.deleteWorld(
      transaction, { ownerUserId: crypto.randomUUID(), worldId }, { confirmation: "DELETE", expectedTitle: title }
    ));
    expect(foreignDeletion).toMatchObject({ ok: false, failure: { reason: "world_not_found" } });
    const staleDeletion = await adapters.transaction.command((transaction) => adapters.worlds.deleteWorld(
      transaction, { ownerUserId, worldId }, { confirmation: "DELETE", expectedTitle: "Wrong title" }
    ));
    expect(staleDeletion).toMatchObject({ ok: false, failure: { reason: "invalid_transition" } });
    expect((await pool.query("SELECT * FROM imports WHERE id=$1", [importId])).rows[0]).toEqual(beforeImport);

    const deleted = await adapters.transaction.command((transaction) => adapters.worlds.deleteWorld(
      transaction, { ownerUserId, worldId }, { confirmation: "DELETE", expectedTitle: title }
    ));
    expect(deleted).toEqual({ ok: true, value: undefined });
    expect((await pool.query("SELECT id FROM worlds WHERE id=$1", [worldId])).rowCount).toBe(0);
    expect((await pool.query("SELECT id FROM world_versions WHERE world_id=$1", [worldId])).rowCount).toBe(0);
    expect((await pool.query("SELECT world_id FROM world_drafts WHERE world_id=$1", [worldId])).rowCount).toBe(0);
    expect((await pool.query("SELECT * FROM imports WHERE id=$1", [importId])).rows[0])
      .toEqual({ ...beforeImport, world_id: null, world_version_id: null });
    expect((await pool.query("SELECT * FROM portable_import_operations WHERE id=$1", [operation.rows[0]!.id])).rows[0])
      .toEqual(beforeOperation);
    expect((await pool.query("SELECT * FROM imports WHERE id=$1", [unrelated.rows[0]!.id])).rows[0])
      .toEqual(beforeUnrelated);
  });
});
