import { createHash } from "node:crypto";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runner } from "node-pg-migrate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import {
  createDatabasePool,
  initialOwnerId,
  type DatabasePool
} from "../../packages/database/src/pool.js";
import { dropTestDatabaseWhenIdle } from "./database-test-helpers.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function migrateLatestDown(pool: DatabasePool): Promise<void> {
  const client = await pool.connect();
  try {
    await runner({
      dbClient: client,
      dir: resolve("database/migrations"),
      direction: "down",
      count: 1,
      migrationsTable: "schema_migrations",
      checkOrder: true,
      singleTransaction: true,
      advisoryLockMode: "wait",
      verbose: false,
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined }
    });
  } finally {
    client.release();
  }
}

integration("Task 14e3e1b normalized publication migration", () => {
  let pool: DatabasePool;

  beforeAll(() => {
    pool = createDatabasePool(databaseUrl!, 4);
  });

  afterAll(async () => {
    await pool.end();
  });

  it("backfills complete, verification-required, and prepared canonical arbitration without requiring an assets row", async () => {
    const databaseName = `infinitequest_14e3e1b_${crypto.randomUUID().replaceAll("-", "")}`;
    const databaseUrlValue = new URL(databaseUrl!);
    databaseUrlValue.pathname = `/${databaseName}`;
    const migrationDirectory = await mkdtemp(join(tmpdir(), "infinitequest-14e3e1b-migrations-"));
    let isolated: DatabasePool | undefined;
    try {
      await pool.query(`CREATE DATABASE ${databaseName}`);
      for (const file of await readdir(resolve("database/migrations"))) {
        if (file.endsWith(".sql") && file < "0064_normalized_asset_publication_requests.sql") {
          await copyFile(join(resolve("database/migrations"), file), join(migrationDirectory, file));
        }
      }
      isolated = createDatabasePool(databaseUrlValue.toString(), 4);
      await migrateDatabase(isolated, migrationDirectory);
      const ownerUserId = await initialOwnerId(isolated);
      const complete = await isolated.query<{ id: string }>(
        `INSERT INTO assets (
           owner_user_id,content_hash,storage_driver,storage_path,mime_type,byte_length,
           pixel_width,pixel_height,technical_metadata
         ) VALUES ($1,$2,'filesystem','legacy/complete.png','image/png',1,10,20,
                   '{"format":"png","pages":1,"orientation":1}'::jsonb)
         RETURNING id`,
        [ownerUserId, "a".repeat(64)],
      );
      const incomplete = await isolated.query<{ id: string }>(
        `INSERT INTO assets (
           owner_user_id,content_hash,storage_driver,storage_path,mime_type,byte_length,technical_metadata
         ) VALUES ($1,$2,'filesystem','legacy/incomplete.png','image/png',1,'{}'::jsonb)
         RETURNING id`,
        [ownerUserId, "b".repeat(64)],
      );
      const preparedAssetId = crypto.randomUUID();
      const preparedHash = "c".repeat(64);
      await isolated.query(
        `INSERT INTO asset_publication_identities (
           asset_id,owner_user_id,idempotency_key_hash,request_fingerprint,lifecycle
         ) VALUES ($1,$2,$3,$4,'prepared')`,
        [preparedAssetId, ownerUserId, sha256("prepared-idempotency"), sha256("prepared-request")],
      );
      const operation = await isolated.query<{ id: string }>(
        `INSERT INTO durable_filesystem_operations (
           owner_user_id,operation_token_hash,purpose,resource_kind,asset_id,
           lease_id,lease_owner,lease_expires_at,expires_at
         ) VALUES ($1,$2,'asset_original','asset',$3,gen_random_uuid(),'14e3e1b',
                   clock_timestamp()+interval '1 minute',clock_timestamp()+interval '1 minute')
         RETURNING id`,
        [ownerUserId, sha256("prepared-operation"), preparedAssetId],
      );
      await isolated.query(
        `UPDATE durable_filesystem_operations
            SET lifecycle='attached',candidate_token_hash=$2,locator_token_hash=$3,
                attached_at=clock_timestamp()
          WHERE id=$1`,
        [operation.rows[0]!.id, sha256("prepared-candidate"), sha256("prepared-locator")],
      );
      await isolated.query(
        `INSERT INTO durable_filesystem_descriptors (
           operation_id,owner_user_id,descriptor_role,ordinal,relative_path,
           device_id,file_id,change_token,content_hash,byte_length
         ) VALUES ($1,$2,'delivery',0,$3,'device','file','change',$4,1)`,
        [operation.rows[0]!.id, ownerUserId, `assets/content/${preparedHash}`, preparedHash],
      );
      const attachedAssetId = crypto.randomUUID();
      const attachedResult = { assetId: attachedAssetId, status: "attached" };
      await isolated.query(
        `INSERT INTO asset_publication_identities (
           asset_id,owner_user_id,idempotency_key_hash,request_fingerprint,lifecycle,result,pending_finalization
         ) VALUES ($1,$2,$3,$4,'attached',$5::jsonb,$6::jsonb)`,
        [
          attachedAssetId,
          ownerUserId,
          sha256("attached-idempotency"),
          sha256("attached-request"),
          JSON.stringify(attachedResult),
          JSON.stringify({ operationIds: [] })
        ],
      );

      await migrateDatabase(isolated, resolve("database/migrations"));

      await expect(isolated.query<{
        content_hash: string;
        canonical_asset_id: string;
        verification_state: string;
      }>(
        `SELECT content_hash,canonical_asset_id,verification_state
           FROM asset_publication_content_arbitrations
          WHERE owner_user_id=$1
          ORDER BY content_hash`,
        [ownerUserId],
      )).resolves.toMatchObject({
        rows: [
          { content_hash: "a".repeat(64), canonical_asset_id: complete.rows[0]!.id, verification_state: "verified" },
          { content_hash: "b".repeat(64), canonical_asset_id: incomplete.rows[0]!.id, verification_state: "verification_required" },
          { content_hash: preparedHash, canonical_asset_id: preparedAssetId, verification_state: "verified" }
        ]
      });
      await expect(isolated.query<{
        canonical_asset_id: string;
        lifecycle: string;
      }>(
        `SELECT canonical_asset_id,lifecycle
           FROM asset_publication_requests
          WHERE owner_user_id=$1
          ORDER BY canonical_asset_id`,
        [ownerUserId],
      )).resolves.toMatchObject({
        rows: expect.arrayContaining([{ canonical_asset_id: preparedAssetId, lifecycle: "prepared" }])
      });
      await expect(isolated.query<{
        request_id: string;
        result: unknown;
      }>(
        `SELECT result.request_id,result.result
           FROM asset_publication_request_results result
           JOIN asset_publication_requests request
             ON request.id=result.request_id
            AND request.owner_user_id=result.owner_user_id
          WHERE request.canonical_asset_id=$1`,
        [attachedAssetId],
      )).resolves.toMatchObject({
        rows: [{ result: attachedResult }]
      });

      const reservationSchema = await isolated.query<{
        column_name: string;
        is_nullable: string;
      }>(
        `SELECT column_name,is_nullable
           FROM information_schema.columns
          WHERE table_schema='public'
            AND table_name IN ('portable_import_asset_reservation_intents','portable_import_asset_publications')
            AND column_name='request_id'
          ORDER BY table_name`,
      );
      expect(reservationSchema.rows).toEqual([
        { column_name: "request_id", is_nullable: "NO" },
        { column_name: "request_id", is_nullable: "NO" }
      ]);
      const reservationConstraints = await isolated.query<{ definition: string }>(
        `SELECT pg_get_constraintdef(table_constraint.oid) AS definition
           FROM pg_constraint table_constraint
           JOIN pg_class relation ON relation.oid=table_constraint.conrelid
          WHERE relation.relname='portable_import_asset_reservation_intents'`,
      );
      const reservationDefinitions = reservationConstraints.rows.map((row) => row.definition).join("\n");
      expect(reservationDefinitions).not.toMatch(/UNIQUE \(owner_user_id, asset_id\)/i);
      expect(reservationDefinitions).toMatch(/FOREIGN KEY \(request_id, owner_user_id\).*asset_publication_requests/i);

      await expect(isolated.query(
        `INSERT INTO asset_publication_requests (
           owner_user_id,idempotency_key_hash,request_fingerprint,canonical_content_hash,canonical_asset_id
         ) VALUES ($1,$2,$3,$4,$5)`,
        [
          ownerUserId,
          sha256("incomplete-reuse-idempotency"),
          sha256("incomplete-reuse-request"),
          "b".repeat(64),
          incomplete.rows[0]!.id
        ],
      )).rejects.toThrow(/verification_required/i);
      await expect(isolated.query(
        `INSERT INTO asset_publication_requests (
           owner_user_id,idempotency_key_hash,request_fingerprint,canonical_content_hash,canonical_asset_id
         ) VALUES
           ($1,$2,$3,$4,$5),
           ($1,$6,$7,$4,$5)`,
        [
          ownerUserId,
          sha256("verified-reuse-idempotency-a"),
          sha256("verified-reuse-request-a"),
          "a".repeat(64),
          complete.rows[0]!.id,
          sha256("verified-reuse-idempotency-b"),
          sha256("verified-reuse-request-b")
        ],
      )).resolves.toMatchObject({ rowCount: 2 });

      const requestSource = await isolated.query<{ id: string }>(
        `SELECT id FROM asset_publication_requests
          WHERE canonical_asset_id=$1`,
        [preparedAssetId],
      );
      await isolated.query(
        `INSERT INTO asset_publication_request_sources (
           request_id,owner_user_id,ordinal,source_kind,source_asset_id,requested_library_snapshot
         ) VALUES ($1,$2,0,'campaign_zip','fixture-source','{}'::jsonb)`,
        [requestSource.rows[0]!.id, ownerUserId],
      );
      await expect(isolated.query(
        `UPDATE asset_publication_request_sources
            SET source_asset_id='rewritten-source'
          WHERE request_id=$1 AND owner_user_id=$2 AND ordinal=0`,
        [requestSource.rows[0]!.id, ownerUserId],
      )).rejects.toThrow(/immutable/i);

      const initializedAssetId = crypto.randomUUID();
      const initializedHash = "d".repeat(64);
      await isolated.query(
        `INSERT INTO asset_publication_identities (
           asset_id,owner_user_id,idempotency_key_hash,request_fingerprint,lifecycle
         ) VALUES ($1,$2,$3,$4,'prepared')`,
        [initializedAssetId, ownerUserId, sha256("initializer-idempotency"), sha256("initializer-request")],
      );
      await isolated.query(
        `INSERT INTO asset_publication_content_arbitrations (
           owner_user_id,content_hash,canonical_asset_id,verification_state
         ) VALUES ($1,$2,$3,'verified')`,
        [ownerUserId, initializedHash, initializedAssetId],
      );
      const publicationRequest = await isolated.query<{ id: string }>(
        `INSERT INTO asset_publication_requests (
           owner_user_id,idempotency_key_hash,request_fingerprint,canonical_content_hash,canonical_asset_id
         ) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [ownerUserId, sha256("library-idempotency"), sha256("library-request"), initializedHash, initializedAssetId],
      );
      await isolated.query(
        `INSERT INTO asset_publication_library_initializations (
           request_id,owner_user_id,canonical_asset_id,library_snapshot
         ) VALUES ($1,$2,$3,$4::jsonb)`,
        [publicationRequest.rows[0]!.id, ownerUserId, initializedAssetId, JSON.stringify({
          title: "First request title",
          caption: "Frozen caption",
          notes: "Frozen notes",
          tags: ["forest", "moon"],
          origin: "generated",
          reuseScope: "campaign",
          automaticReuseEnabled: true,
          reviewStatus: "eligible",
          contentCategories: ["fantasy"],
          favorite: true,
          archivedAt: null
        })],
      );
      await isolated.query(
        `INSERT INTO assets (
           id,owner_user_id,content_hash,storage_driver,storage_path,mime_type,byte_length,
           pixel_width,pixel_height,technical_metadata
         ) VALUES ($1,$2,$3,'filesystem','normalized/first.png','image/png',1,10,20,
                   '{"format":"png"}'::jsonb)`,
        [initializedAssetId, ownerUserId, initializedHash],
      );
      await expect(isolated.query<{
        title: string;
        origin: string;
        reuse_scope: string;
        review_status: string;
        favorite: boolean;
        state: string;
      }>(
        `SELECT library.title,library.origin,library.reuse_scope,library.review_status,library.favorite,initialization.state
           FROM asset_library_entries library
           JOIN asset_publication_library_initializations initialization
             ON initialization.canonical_asset_id=library.asset_id
            AND initialization.owner_user_id=library.owner_user_id
          WHERE library.asset_id=$1`,
        [initializedAssetId],
      )).resolves.toMatchObject({
        rows: [{
          title: "First request title",
          origin: "generated",
          reuse_scope: "campaign",
          review_status: "eligible",
          favorite: true,
          state: "applied"
        }]
      });
      await expect(migrateLatestDown(isolated)).rejects.toThrow(/cannot downgrade normalized asset publication authority/i);
    } finally {
      if (isolated) await isolated.end();
      await dropTestDatabaseWhenIdle(pool, databaseName);
      await rm(migrationDirectory, { recursive: true, force: true });
    }
  });

  it("restores the 0063 portable guards when an empty normalized authority is downgraded", async () => {
    const databaseName = `infinitequest_14e3e1b_empty_${crypto.randomUUID().replaceAll("-", "")}`;
    const databaseUrlValue = new URL(databaseUrl!);
    databaseUrlValue.pathname = `/${databaseName}`;
    let isolated: DatabasePool | undefined;
    try {
      await pool.query(`CREATE DATABASE ${databaseName}`);
      isolated = createDatabasePool(databaseUrlValue.toString(), 4);
      await migrateDatabase(isolated, resolve("database/migrations"));
      await migrateLatestDown(isolated);
      const requestColumn = await isolated.query<{ column_name: string }>(
        `SELECT column_name
           FROM information_schema.columns
          WHERE table_schema='public'
            AND table_name='portable_import_asset_reservation_intents'
            AND column_name='request_id'`,
      );
      expect(requestColumn.rows).toEqual([]);
      const restoredGuard = await isolated.query<{ definition: string }>(
        `SELECT pg_get_functiondef('enforce_portable_import_asset_reservation_intent'::regproc) AS definition`,
      );
      expect(restoredGuard.rows[0]!.definition).toMatch(/publication\.lifecycle\s*=\s*'prepared'/);
      expect(restoredGuard.rows[0]!.definition).not.toContain("asset_publication_requests");
    } finally {
      if (isolated) await isolated.end();
      await dropTestDatabaseWhenIdle(pool, databaseName);
    }
  });
});
