import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import {
  createDatabasePool,
  initialOwnerId,
  type DatabaseClient,
  type DatabasePool
} from "../../packages/database/src/pool.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

type WorldScope = Readonly<{
  campaignId: string;
  worldId: string;
  worldVersionId: string;
}>;

integration("Task 14e3b2a private portable repository guards", () => {
  let pool: DatabasePool;
  let ownerUserId = "";
  let foreignOwnerUserId = "";
  let scope: WorldScope;
  let foreignScope: WorldScope;

  beforeAll(async () => {
    pool = createDatabasePool(databaseUrl!, 6);
    await migrateDatabase(pool, resolve("database/migrations"));
    ownerUserId = await initialOwnerId(pool);
    foreignOwnerUserId = await createOwner("b2a-foreign");
    scope = await createWorldScope(ownerUserId, "B2a owner");
    foreignScope = await createWorldScope(foreignOwnerUserId, "B2a foreign");
  });

  afterAll(async () => {
    await pool.end();
  });

  async function createOwner(prefix: string): Promise<string> {
    const created = await pool.query<{ id: string }>(
      "INSERT INTO users (system_key,display_name) VALUES ($1,$2) RETURNING id",
      [`${prefix}-${crypto.randomUUID()}`, prefix],
    );
    return created.rows[0]!.id;
  }

  async function createWorldScope(scopedOwner: string, title: string): Promise<WorldScope> {
    const world = await pool.query<{ id: string }>(
      "INSERT INTO worlds (owner_user_id,title) VALUES ($1,$2) RETURNING id",
      [scopedOwner, `${title} ${crypto.randomUUID()}`],
    );
    const worldId = world.rows[0]!.id;
    const version = await pool.query<{ id: string }>(
      `INSERT INTO world_versions (world_id,owner_user_id,version_number,content)
       VALUES ($1,$2,1,'{}'::jsonb) RETURNING id`,
      [worldId, scopedOwner],
    );
    const worldVersionId = version.rows[0]!.id;
    const campaign = await pool.query<{ id: string }>(
      `INSERT INTO campaigns (owner_user_id,world_version_id,title)
       VALUES ($1,$2,$3) RETURNING id`,
      [scopedOwner, worldVersionId, title],
    );
    return { worldId, worldVersionId, campaignId: campaign.rows[0]!.id };
  }

  async function finalizedOperation(
    scopedOwner: string,
    purpose: "portable_staging" | "portable_export",
    seed = crypto.randomUUID(),
  ): Promise<Readonly<{ operationId: string; contentHash: string }>> {
    const contentHash = hash(`content-${seed}`);
    const created = await pool.query<{ id: string }>(
      `INSERT INTO durable_filesystem_operations (
         owner_user_id,operation_token_hash,purpose,resource_kind,operation_scope_hash,
         lease_id,lease_owner,lease_expires_at,expires_at
       ) VALUES ($1,$2,$3,'portable',$4,gen_random_uuid(),'b2a-worker',
                 now()+interval '5 minutes',now()+interval '1 day')
       RETURNING id`,
      [scopedOwner, hash(`operation-${seed}`), purpose, hash(`scope-${seed}`)],
    );
    const operationId = created.rows[0]!.id;
    await pool.query(
      `UPDATE durable_filesystem_operations
          SET lifecycle='attached',candidate_token_hash=$2,locator_token_hash=$3,attached_at=now()
        WHERE id=$1`,
      [operationId, hash(`candidate-${seed}`), hash(`locator-${seed}`)],
    );
    await pool.query(
      `INSERT INTO durable_filesystem_descriptors (
         operation_id,owner_user_id,descriptor_role,ordinal,relative_path,
         device_id,file_id,change_token,content_hash,byte_length
       ) VALUES ($1,$2,'delivery',0,$3,$4,$5,$6,$7,64)`,
      [
        operationId,
        scopedOwner,
        `${purpose}/${contentHash}.bin`,
        `device-${seed}`,
        `file-${seed}`,
        `change-${seed}`,
        contentHash
      ],
    );
    await pool.query(
      "UPDATE durable_filesystem_operations SET lifecycle='finalized',finalized_at=now() WHERE id=$1",
      [operationId],
    );
    return { operationId, contentHash };
  }

  async function stagedRow(
    operation: Readonly<{ operationId: string; contentHash: string }>,
    scopedOwner = ownerUserId,
  ): Promise<string> {
    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO portable_staged_inputs (
         owner_user_id,handle_token_hash,filesystem_operation_id,content_hash,byte_length,expires_at
       ) VALUES ($1,$2,$3,$4,64,now()+interval '1 hour') RETURNING id`,
      [scopedOwner, hash(`staged-${crypto.randomUUID()}`), operation.operationId, operation.contentHash],
    );
    return inserted.rows[0]!.id;
  }

  async function exportRow(
    operation: Readonly<{ operationId: string; contentHash: string }>,
    exportScope = scope,
    scopedOwner = ownerUserId,
  ): Promise<string> {
    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO portable_export_artifacts (
         owner_user_id,retrieval_token_hash,filesystem_operation_id,export_kind,campaign_id,
         world_id,world_version_id,content_type,content_hash,byte_length,expires_at
       ) VALUES ($1,$2,$3,'campaign_zip',$4,$5,$6,'application/zip',$7,64,
                 now()+interval '1 hour') RETURNING id`,
      [
        scopedOwner,
        hash(`export-${crypto.randomUUID()}`),
        operation.operationId,
        exportScope.campaignId,
        exportScope.worldId,
        exportScope.worldVersionId,
        operation.contentHash
      ],
    );
    return inserted.rows[0]!.id;
  }

  async function transitionTogether(
    table: "portable_staged_inputs" | "portable_export_artifacts",
    portableId: string,
    operationId: string,
    lifecycle: "cleanup_pending" | "cleaned",
  ): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `UPDATE ${table} SET status=$2,updated_at=now() WHERE id=$1`,
        [portableId, lifecycle],
      );
      await client.query(
        `UPDATE durable_filesystem_operations
            SET lifecycle=$2,
                cleanup_requested_at=CASE WHEN $2='cleanup_pending' THEN now() ELSE cleanup_requested_at END,
                cleaned_at=CASE WHEN $2='cleaned' THEN now() ELSE cleaned_at END,
                updated_at=now()
          WHERE id=$1`,
        [operationId, lifecycle],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async function expectCommitRejected(
    mutate: (client: DatabaseClient) => Promise<void>,
  ): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await mutate(client);
      await expect(client.query("COMMIT")).rejects.toMatchObject({ code: "55000" });
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
  }

  it("creates unique operation bindings and exact authority lookup indexes", async () => {
    const indexes = await pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
        WHERE schemaname='public' AND indexname = ANY($1::text[])
        ORDER BY indexname`,
      [[
        "portable_export_artifacts_authority_lookup_idx",
        "portable_export_artifacts_filesystem_operation_key",
        "portable_staged_inputs_authority_lookup_idx",
        "portable_staged_inputs_filesystem_operation_key"
      ]],
    );
    expect(indexes.rows.map((row) => row.indexname)).toEqual([
      "portable_export_artifacts_authority_lookup_idx",
      "portable_export_artifacts_filesystem_operation_key",
      "portable_staged_inputs_authority_lookup_idx",
      "portable_staged_inputs_filesystem_operation_key"
    ]);

    const stagedOperation = await finalizedOperation(ownerUserId, "portable_staging");
    await stagedRow(stagedOperation);
    await expect(stagedRow(stagedOperation)).rejects.toMatchObject({ code: "23505" });

    const exportOperation = await finalizedOperation(ownerUserId, "portable_export");
    await exportRow(exportOperation);
    await expect(exportRow(exportOperation)).rejects.toMatchObject({ code: "23505" });
  });

  it("makes staged bearer, operation, owner, descriptor, and expiry authority write-once", async () => {
    const operation = await finalizedOperation(ownerUserId, "portable_staging");
    const stagedId = await stagedRow(operation);
    const replacement = await finalizedOperation(ownerUserId, "portable_staging");
    const mutations = [
      ["handle_token_hash", hash(`replacement-${crypto.randomUUID()}`)],
      ["filesystem_operation_id", replacement.operationId],
      ["owner_user_id", foreignOwnerUserId],
      ["content_hash", hash(`replacement-content-${crypto.randomUUID()}`)],
      ["byte_length", "65"],
      ["expires_at", new Date(Date.now() + 7_200_000).toISOString()]
    ] as const;

    for (const [column, value] of mutations) {
      await expect(pool.query(
        `UPDATE portable_staged_inputs SET ${column}=$2 WHERE id=$1`,
        [stagedId, value],
      )).rejects.toMatchObject({ code: "55000" });
    }
  });

  it("makes export bearer, operation, owner, descriptor, expiry, and full scope write-once", async () => {
    const operation = await finalizedOperation(ownerUserId, "portable_export");
    const artifactId = await exportRow(operation);
    const replacement = await finalizedOperation(ownerUserId, "portable_export");
    const mutations = [
      ["retrieval_token_hash", hash(`replacement-${crypto.randomUUID()}`)],
      ["filesystem_operation_id", replacement.operationId],
      ["owner_user_id", foreignOwnerUserId],
      ["content_hash", hash(`replacement-content-${crypto.randomUUID()}`)],
      ["byte_length", "65"],
      ["content_type", "application/json"],
      ["expires_at", new Date(Date.now() + 7_200_000).toISOString()],
      ["export_kind", "world_json"],
      ["campaign_id", foreignScope.campaignId],
      ["world_id", foreignScope.worldId],
      ["world_version_id", foreignScope.worldVersionId]
    ] as const;

    for (const [column, value] of mutations) {
      await expect(pool.query(
        `UPDATE portable_export_artifacts SET ${column}=$2 WHERE id=$1`,
        [artifactId, value],
      )).rejects.toMatchObject({ code: "55000" });
    }
  });

  it("allows only forward portable lifecycle transitions", async () => {
    const stagedOperation = await finalizedOperation(ownerUserId, "portable_staging");
    const stagedId = await stagedRow(stagedOperation);
    await pool.query(
      "UPDATE portable_staged_inputs SET status='consumed',consumed_at=now(),updated_at=now() WHERE id=$1",
      [stagedId],
    );
    await expect(pool.query(
      "UPDATE portable_staged_inputs SET status='staged',consumed_at=NULL WHERE id=$1",
      [stagedId],
    )).rejects.toMatchObject({ code: "55000" });
    await transitionTogether(
      "portable_staged_inputs", stagedId, stagedOperation.operationId, "cleanup_pending",
    );
    await transitionTogether(
      "portable_staged_inputs", stagedId, stagedOperation.operationId, "cleaned",
    );

    const exportedOperation = await finalizedOperation(ownerUserId, "portable_export");
    const artifactId = await exportRow(exportedOperation);
    await pool.query(
      "UPDATE portable_export_artifacts SET status='failed',updated_at=now() WHERE id=$1",
      [artifactId],
    );
    await transitionTogether(
      "portable_export_artifacts", artifactId, exportedOperation.operationId, "cleanup_pending",
    );
    await transitionTogether(
      "portable_export_artifacts", artifactId, exportedOperation.operationId, "cleaned",
    );
    await expect(pool.query(
      "UPDATE portable_export_artifacts SET status='ready' WHERE id=$1",
      [artifactId],
    )).rejects.toMatchObject({ code: "55000" });
  });

  it("rejects journal or portable cleanup_pending and cleaned split states at commit", async () => {
    const journalOnlyOperation = await finalizedOperation(ownerUserId, "portable_staging");
    await stagedRow(journalOnlyOperation);
    await expectCommitRejected(async (client) => {
      await client.query(
        `UPDATE durable_filesystem_operations
            SET lifecycle='cleanup_pending',cleanup_requested_at=now()
          WHERE id=$1`,
        [journalOnlyOperation.operationId],
      );
    });

    const portableOnlyOperation = await finalizedOperation(ownerUserId, "portable_export");
    const portableOnlyId = await exportRow(portableOnlyOperation);
    await expectCommitRejected(async (client) => {
      await client.query(
        "UPDATE portable_export_artifacts SET status='cleanup_pending',updated_at=now() WHERE id=$1",
        [portableOnlyId],
      );
    });

    await transitionTogether(
      "portable_export_artifacts",
      portableOnlyId,
      portableOnlyOperation.operationId,
      "cleanup_pending",
    );
    await expectCommitRejected(async (client) => {
      await client.query(
        "UPDATE durable_filesystem_operations SET lifecycle='cleaned',cleaned_at=now() WHERE id=$1",
        [portableOnlyOperation.operationId],
      );
    });
  });
});
