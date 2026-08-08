import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runner } from "node-pg-migrate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { createPostgresAssetPublicationRepository } from "../../packages/database/src/asset-publication-repository.js";
import { toAssetMutationIdempotencyKey } from "../../packages/application/src/assets/types.js";
import {
  createDatabasePool,
  initialOwnerId,
  type DatabasePool
} from "../../packages/database/src/pool.js";
import { dropTestDatabaseWhenIdle } from "./database-test-helpers.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration("Task 14e3c asset-publication identities", () => {
  let pool: DatabasePool;
  let ownerUserId = "";

  beforeAll(async () => {
    pool = createDatabasePool(databaseUrl!, 4);
    await migrateDatabase(pool, resolve("database/migrations"));
    ownerUserId = await initialOwnerId(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  it("reserves a stable owner-scoped asset identity without creating a phantom asset row", async () => {
    const assetId = crypto.randomUUID();
    const requestHash = "a".repeat(64);
    const idempotencyHash = "b".repeat(64);

    await pool.query(
      `INSERT INTO asset_publication_identities (
         asset_id,owner_user_id,request_fingerprint,idempotency_key_hash,lifecycle
       ) VALUES ($1,$2,$3,$4,'prepared')`,
      [assetId, ownerUserId, requestHash, idempotencyHash],
    );
    await pool.query(
      `INSERT INTO durable_filesystem_operations (
         owner_user_id,operation_token_hash,purpose,resource_kind,asset_id,
         lease_id,lease_owner,lease_expires_at,expires_at
       ) VALUES ($1,$2,'asset_original','asset',$3,gen_random_uuid(),'14e3c-red',
                 clock_timestamp()+interval '1 minute',clock_timestamp()+interval '1 minute')`,
      [ownerUserId, "c".repeat(64), assetId],
    );

    await expect(pool.query(
      "SELECT id FROM assets WHERE id=$1 AND owner_user_id=$2",
      [assetId, ownerUserId],
    )).resolves.toMatchObject({ rows: [] });
    await expect(pool.query(
      `SELECT asset_id,owner_user_id,lifecycle
         FROM asset_publication_identities
        WHERE asset_id=$1 AND owner_user_id=$2`,
      [assetId, ownerUserId],
    )).resolves.toMatchObject({
      rows: [{ asset_id: assetId, owner_user_id: ownerUserId, lifecycle: "prepared" }]
    });
  });

  it("allows storage reservation under caller revalidation while retaining the publication fence", async () => {
    const bytes = new Uint8Array([14, 3, 7]);
    const contentHash = createHash("sha256").update(bytes).digest("hex");
    const command = {
      owner: { ownerUserId },
      idempotencyKey: toAssetMutationIdempotencyKey(`14e3c-lock-${crypto.randomUUID()}`),
      leaseOwner: "14e3c-lock",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      original: {
        bytes,
        mimeType: "image/png" as const,
        byteLength: bytes.byteLength,
        contentHash,
      },
      derivatives: [],
      provenance: { origin: "imported" as const },
    };
    const repository = createPostgresAssetPublicationRepository(pool, {} as never);
    const identity = await repository.prepareIdentity(command);
    const caller = await pool.connect();
    try {
      await caller.query("BEGIN");
      await expect(repository.prepareIdentityInTransaction(caller, command)).resolves.toMatchObject({
        assetId: identity.assetId,
        lifecycle: "prepared",
      });
      await expect(pool.query(
        `INSERT INTO durable_filesystem_operations (
           owner_user_id,operation_token_hash,purpose,resource_kind,asset_id,
           lease_id,lease_owner,lease_expires_at,expires_at
         ) VALUES ($1,$2,'asset_original','asset',$3,gen_random_uuid(),'14e3c-storage',
                   clock_timestamp()+interval '1 minute',clock_timestamp()+interval '1 minute')`,
        [ownerUserId, createHash("sha256").update(crypto.randomUUID()).digest("hex"), identity.assetId],
      )).resolves.toMatchObject({ rowCount: 1 });

      const competingPublication = repository.prepareIdentity(command);
      await expect(Promise.race([
        competingPublication.then(() => "released"),
        new Promise<string>((resolveBlocked) => setTimeout(() => resolveBlocked("blocked"), 100)),
      ])).resolves.toBe("blocked");
      await caller.query("COMMIT");
      await expect(competingPublication).resolves.toMatchObject({ assetId: identity.assetId });
    } finally {
      await caller.query("ROLLBACK").catch(() => undefined);
      caller.release();
    }
  });

  it("rejects cross-owner and nonexistent identities, and rolls back an uncommitted reservation", async () => {
    const foreignOwner = await pool.query<{ id: string }>(
      `INSERT INTO users (system_key,display_name,status)
       VALUES ($1,$2,'active') RETURNING id`,
      [`14e3c-foreign:${crypto.randomUUID()}`, "14e3c foreign"],
    );
    const assetId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO asset_publication_identities (
         asset_id,owner_user_id,request_fingerprint,idempotency_key_hash,lifecycle
       ) VALUES ($1,$2,$3,$4,'prepared')`,
      [assetId, ownerUserId, "d".repeat(64), "e".repeat(64)],
    );
    await expect(pool.query(
      `INSERT INTO durable_filesystem_operations (
         owner_user_id,operation_token_hash,purpose,resource_kind,asset_id,
         lease_id,lease_owner,lease_expires_at,expires_at
       ) VALUES ($1,$2,'asset_original','asset',$3,gen_random_uuid(),'14e3c-foreign',
                 clock_timestamp()+interval '1 minute',clock_timestamp()+interval '1 minute')`,
      [foreignOwner.rows[0]!.id, "f".repeat(64), assetId],
    )).rejects.toThrow();
    await expect(pool.query(
      `INSERT INTO durable_filesystem_operations (
         owner_user_id,operation_token_hash,purpose,resource_kind,asset_id,
         lease_id,lease_owner,lease_expires_at,expires_at
       ) VALUES ($1,$2,'asset_original','asset',$3,gen_random_uuid(),'14e3c-missing',
                 clock_timestamp()+interval '1 minute',clock_timestamp()+interval '1 minute')`,
      [ownerUserId, "1".repeat(64), crypto.randomUUID()],
    )).rejects.toThrow();

    const rolledBackAssetId = crypto.randomUUID();
    const transaction = await pool.connect();
    try {
      await transaction.query("BEGIN");
      await transaction.query(
        `INSERT INTO asset_publication_identities (
           asset_id,owner_user_id,request_fingerprint,idempotency_key_hash,lifecycle
         ) VALUES ($1,$2,$3,$4,'prepared')`,
        [rolledBackAssetId, ownerUserId, "2".repeat(64), "3".repeat(64)],
      );
      await transaction.query(
        `INSERT INTO durable_filesystem_operations (
           owner_user_id,operation_token_hash,purpose,resource_kind,asset_id,
           lease_id,lease_owner,lease_expires_at,expires_at
         ) VALUES ($1,$2,'asset_original','asset',$3,gen_random_uuid(),'14e3c-rollback',
                   clock_timestamp()+interval '1 minute',clock_timestamp()+interval '1 minute')`,
        [ownerUserId, "4".repeat(64), rolledBackAssetId],
      );
    } finally {
      await transaction.query("ROLLBACK");
      transaction.release();
    }
    await expect(pool.query(
      "SELECT asset_id FROM asset_publication_identities WHERE asset_id=$1",
      [rolledBackAssetId],
    )).resolves.toMatchObject({ rows: [] });
  });

  it("seeds legacy assets and refuses a downgrade that would discard a prepared retry identity", async () => {
    const databaseName = `infinitequest_14e3c_${crypto.randomUUID().replaceAll("-", "")}`;
    const isolatedUrl = new URL(databaseUrl!);
    isolatedUrl.pathname = `/${databaseName}`;
    const migrationDirectory = await mkdtemp(join(tmpdir(), "iqn-14e3c-migrations-"));
    let isolated: DatabasePool | undefined;
    try {
      await pool.query(`CREATE DATABASE ${databaseName}`);
      for (const file of await readdir(resolve("database/migrations"))) {
        if (file.endsWith(".sql") && file < "0060_asset_publication_identities.sql") {
          await copyFile(join(resolve("database/migrations"), file), join(migrationDirectory, file));
        }
      }
      isolated = createDatabasePool(isolatedUrl.toString(), 4);
      await migrateDatabase(isolated, migrationDirectory);
      const owner = await initialOwnerId(isolated);
      const legacy = await isolated.query<{ id: string }>(
        `INSERT INTO assets (
           owner_user_id,content_hash,storage_driver,storage_path,mime_type,byte_length
         ) VALUES ($1,$2,'filesystem','legacy/seeded.png','image/png',1)
         RETURNING id`,
        [owner, "5".repeat(64)],
      );
      await copyFile(
        resolve("database/migrations/0060_asset_publication_identities.sql"),
        join(migrationDirectory, "0060_asset_publication_identities.sql"),
      );
      await expect(migrateDatabase(isolated, migrationDirectory)).resolves.toEqual([
        "0060_asset_publication_identities"
      ]);
      await expect(isolated.query(
        `SELECT asset_id,owner_user_id,lifecycle,idempotency_key_hash,request_fingerprint
           FROM asset_publication_identities WHERE asset_id=$1`,
        [legacy.rows[0]!.id],
      )).resolves.toMatchObject({
        rows: [{
          asset_id: legacy.rows[0]!.id,
          owner_user_id: owner,
          lifecycle: "legacy",
          idempotency_key_hash: null,
          request_fingerprint: null
        }]
      });
      await isolated.query(
        `INSERT INTO durable_filesystem_operations (
           owner_user_id,operation_token_hash,purpose,resource_kind,asset_id,
           lease_id,lease_owner,lease_expires_at,expires_at
         ) VALUES ($1,$2,'asset_original','asset',$3,gen_random_uuid(),'14e3c-retention',
                   clock_timestamp()+interval '1 minute',clock_timestamp()+interval '1 minute')`,
        [owner, "8".repeat(64), legacy.rows[0]!.id],
      );
      await expect(isolated.query(
        "DELETE FROM assets WHERE id=$1 AND owner_user_id=$2",
        [legacy.rows[0]!.id, owner],
      )).rejects.toMatchObject({ code: "23503" });

      const raced = await isolated.query<{ id: string }>(
        `INSERT INTO assets (
           owner_user_id,content_hash,storage_driver,storage_path,mime_type,byte_length
         ) VALUES ($1,$2,'filesystem','legacy/raced.png','image/png',1)
         RETURNING id`,
        [owner, "9".repeat(64)],
      );
      const deleting = await isolated.connect();
      const inserting = await isolated.connect();
      try {
        await deleting.query("BEGIN");
        await deleting.query(
          "DELETE FROM assets WHERE id=$1 AND owner_user_id=$2",
          [raced.rows[0]!.id, owner],
        );
        const insert = inserting.query(
          `INSERT INTO durable_filesystem_operations (
             owner_user_id,operation_token_hash,purpose,resource_kind,asset_id,
             lease_id,lease_owner,lease_expires_at,expires_at
           ) VALUES ($1,$2,'asset_original','asset',$3,gen_random_uuid(),'14e3c-delete-wins',
                     clock_timestamp()+interval '1 minute',clock_timestamp()+interval '1 minute')`,
          [owner, "a1".padEnd(64, "1"), raced.rows[0]!.id],
        );
        const remainedBlocked = await Promise.race([
          insert.then(() => false, () => false),
          new Promise<boolean>((resolveBlocked) => setTimeout(() => resolveBlocked(true), 100))
        ]);
        expect(remainedBlocked).toBe(true);
        await deleting.query("COMMIT");
        await expect(insert).rejects.toMatchObject({ code: "23503" });
      } finally {
        await deleting.query("ROLLBACK").catch(() => undefined);
        deleting.release();
        inserting.release();
      }
      await isolated.query(
        "DELETE FROM asset_publication_identities WHERE asset_id=$1 AND owner_user_id=$2",
        [raced.rows[0]!.id, owner],
      );
      await isolated.query(
        `INSERT INTO asset_publication_identities (
           asset_id,owner_user_id,request_fingerprint,idempotency_key_hash,lifecycle
         ) VALUES ($1,$2,$3,$4,'prepared')`,
        [crypto.randomUUID(), owner, "6".repeat(64), "7".repeat(64)],
      );
      const migrationClient = await isolated.connect();
      try {
        await expect(runner({
          dbClient: migrationClient,
          dir: migrationDirectory,
          direction: "down",
          count: 1,
          migrationsTable: "schema_migrations",
          checkOrder: true,
          singleTransaction: true,
          verbose: false,
          logger: { info: () => undefined, warn: () => undefined, error: () => undefined }
        })).rejects.toThrow("asset publication identity downgrade would discard pending authority");
      } finally {
        migrationClient.release();
      }
      await isolated.query(
        "DELETE FROM asset_publication_identities WHERE lifecycle='prepared' AND owner_user_id=$1",
        [owner],
      );
      const successfulDownClient = await isolated.connect();
      try {
        await expect(runner({
          dbClient: successfulDownClient,
          dir: migrationDirectory,
          direction: "down",
          count: 1,
          migrationsTable: "schema_migrations",
          checkOrder: true,
          singleTransaction: true,
          verbose: false,
          logger: { info: () => undefined, warn: () => undefined, error: () => undefined }
        })).resolves.toBeDefined();
      } finally {
        successfulDownClient.release();
      }
      await expect(isolated.query("SELECT to_regclass('asset_publication_identities') AS table_name"))
        .resolves.toMatchObject({ rows: [{ table_name: null }] });
    } finally {
      if (isolated) await isolated.end();
      await dropTestDatabaseWhenIdle(pool, databaseName);
      await rm(migrationDirectory, { recursive: true, force: true });
    }
  });
});
