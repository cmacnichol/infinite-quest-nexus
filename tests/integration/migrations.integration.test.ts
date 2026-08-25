import { createHash } from "node:crypto";
import { copyFile, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  migrateDatabase,
  pendingDatabaseMigrations,
  waitForDatabaseMigrations
} from "../../packages/database/src/migrate.js";
import { createDatabasePool, type DatabasePool } from "../../packages/database/src/pool.js";
import {
  createPostgresChronicleChunkBatchPort,
  createPostgresChronicleChunkJobStatePort,
  createPostgresChronicleChunkParentPort,
  enqueuePostgresChronicleChunkIndex
} from "../../packages/database/src/chronicle-chunk-repository.js";
import { dropTestDatabaseWhenIdle } from "./database-test-helpers.js";
import { snapshotTurnRows } from "../helpers/turn-row-snapshot.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration("standard database migration runner", () => {
  let pool: DatabasePool;

  beforeAll(async () => {
    pool = createDatabasePool(databaseUrl!, 2);
    await migrateDatabase(pool, resolve("database/migrations"));
  });

  afterAll(async () => {
    if (pool) await pool.end();
  });

  it("adds minimal owner-scoped admission buckets and leases", async () => {
    const columns = await pool.query<{
      table_name: string;
      column_name: string;
    }>(
      `SELECT table_name, column_name
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = ANY($1::text[])
        ORDER BY table_name, ordinal_position`,
      [["api_admission_buckets", "api_admission_leases"]]
    );
    expect(columns.rows).toEqual([
      { table_name: "api_admission_buckets", column_name: "owner_user_id" },
      { table_name: "api_admission_buckets", column_name: "operation" },
      { table_name: "api_admission_buckets", column_name: "window_started_at" },
      { table_name: "api_admission_buckets", column_name: "window_expires_at" },
      { table_name: "api_admission_buckets", column_name: "accepted_count" },
      { table_name: "api_admission_buckets", column_name: "created_at" },
      { table_name: "api_admission_buckets", column_name: "updated_at" },
      { table_name: "api_admission_leases", column_name: "id" },
      { table_name: "api_admission_leases", column_name: "owner_user_id" },
      { table_name: "api_admission_leases", column_name: "operation" },
      { table_name: "api_admission_leases", column_name: "request_id" },
      { table_name: "api_admission_leases", column_name: "expires_at" },
      { table_name: "api_admission_leases", column_name: "created_at" }
    ]);
    expect(columns.rows.map((row) => row.column_name)).not.toEqual(expect.arrayContaining([
      "ip_address",
      "story",
      "provider",
      "provider_profile_id",
      "campaign_id"
    ]));

    const indexes = await pool.query<{ indexname: string }>(
      `SELECT indexname
         FROM pg_indexes
        WHERE schemaname = 'public'
          AND indexname = ANY($1::text[])
        ORDER BY indexname`,
      [[
        "api_admission_buckets_expiry_idx",
        "api_admission_leases_scope_expiry_idx"
      ]]
    );
    expect(indexes.rows.map((row) => row.indexname)).toEqual([
      "api_admission_buckets_expiry_idx",
      "api_admission_leases_scope_expiry_idx"
    ]);
  });

  it("creates owner-scoped staged archive previews without storing raw tokens or absolute paths", async () => {
    const owner = await pool.query<{ id: string }>("SELECT id FROM users WHERE system_key = 'initial-owner'");
    const columns = await pool.query<{ column_name: string; data_type: string; is_nullable: string }>(
      `SELECT column_name, data_type, is_nullable
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'archive_previews'
        ORDER BY ordinal_position`
    );
    expect(columns.rows.map((row) => row.column_name)).toEqual([
      "id", "owner_user_id", "archive_type", "token_hash", "content_fingerprint",
      "destination_hash", "application_version", "staged_archive_path", "source_name",
      "preview", "status", "expires_at", "consumed_at", "result", "created_at", "updated_at",
      "storage_security_state", "secure_staged_input_id", "legacy_drain_policy"
    ]);
    expect(columns.rows.find((row) => row.column_name === "id")).toMatchObject({ data_type: "uuid", is_nullable: "NO" });
    expect(columns.rows.find((row) => row.column_name === "owner_user_id")).toMatchObject({ data_type: "uuid", is_nullable: "NO" });

    const constraints = await pool.query<{ constraint_name: string; constraint_definition: string }>(
      `SELECT tc.constraint_name, pg_get_constraintdef(c.oid) AS constraint_definition
         FROM information_schema.table_constraints tc
         JOIN pg_constraint c ON c.conname = tc.constraint_name
        WHERE tc.table_schema = 'public' AND tc.table_name = 'archive_previews'
        ORDER BY tc.constraint_name`
    );
    expect(constraints.rows.map((row) => row.constraint_definition).join("\n")).toMatch(/archive_type.*campaign.*system/i);
    expect(constraints.rows.map((row) => row.constraint_definition).join("\n")).toMatch(/status.*previewed.*superseded.*consumed.*expired.*failed/i);
    expect(constraints.rows.map((row) => row.constraint_definition).join("\n")).toMatch(/UNIQUE.*token_hash/i);

    const indexes = await pool.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname,indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'archive_previews' ORDER BY indexname`
    );
    expect(indexes.rows.map((row) => row.indexname)).toEqual(expect.arrayContaining([
      "archive_previews_token_hash_key",
      "archive_previews_owner_fingerprint_destination_live_idx",
      "archive_previews_expiry_idx"
    ]));
    expect(indexes.rows.find((row) => row.indexname === "archive_previews_owner_fingerprint_destination_live_idx")?.indexdef)
      .toMatch(/owner_user_id.*archive_type.*content_fingerprint.*destination_hash.*WHERE.*status.*previewed/i);

    const rawToken = "raw-preview-token-must-not-be-stored";
    const rawTokenHash = createHash("sha256").update(rawToken, "utf8").digest("hex");
    const stagedPath = "staging/preview.zip";
    const inserted = await pool.query<{ token_hash: string; staged_archive_path: string }>(
      `INSERT INTO archive_previews (
         owner_user_id, archive_type, token_hash, content_fingerprint, destination_hash,
         application_version, staged_archive_path, source_name, preview, status, expires_at
       ) VALUES ($1,'campaign',$2,repeat('a',64),repeat('b',64),'test', $3, 'fixture.zip', '{}'::jsonb, 'previewed', now() + interval '30 minutes')
       RETURNING token_hash, staged_archive_path`,
      [owner.rows[0]!.id, rawTokenHash, stagedPath]
    );
    expect(inserted.rows[0]).toEqual({
      token_hash: expect.not.stringContaining(rawToken),
      staged_archive_path: stagedPath
    });
    expect(inserted.rows[0]!.staged_archive_path).not.toMatch(/^[A-Za-z]:[\\/]|^\\\\|^\//);
    await pool.query("DELETE FROM archive_previews WHERE token_hash = $1", [inserted.rows[0]!.token_hash]);
  });

  it("creates owner-scoped durable asset and portable-operation schema with hashed-only capabilities", async () => {
    const tableNames = [
      "asset_metadata_backfill_jobs",
      "asset_mutation_idempotency",
      "durable_filesystem_operations",
      "durable_filesystem_descriptors",
      "portable_staged_inputs",
      "portable_import_operations",
      "portable_export_artifacts"
    ];
    const tables = await pool.query<{ table_name: string }>(
      `SELECT table_name
         FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = ANY($1::text[])
        ORDER BY table_name`,
      [tableNames]
    );
    expect(tables.rows.map((row) => row.table_name)).toEqual([...tableNames].sort());

    const owners = await pool.query<{ table_name: string; is_nullable: string }>(
      `SELECT table_name, is_nullable
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = ANY($1::text[])
          AND column_name = 'owner_user_id'
        ORDER BY table_name`,
      [tableNames]
    );
    expect(owners.rows).toHaveLength(tableNames.length);
    expect(owners.rows.every((row) => row.is_nullable === "NO")).toBe(true);

    const capabilityColumns = await pool.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = ANY($1::text[])
          AND column_name ~ '(token|candidate|locator|retrieval|idempotency)'
        ORDER BY table_name, column_name`,
      [tableNames]
    );
    expect(capabilityColumns.rows).not.toHaveLength(0);
    expect(capabilityColumns.rows.filter((row) => (
      row.column_name !== "change_token" && !row.column_name.endsWith("_hash")
    ))).toEqual([]);

    const constraints = await pool.query<{ table_name: string; definition: string }>(
      `SELECT relations.relname AS table_name, pg_get_constraintdef(constraints.oid) AS definition
         FROM pg_constraint constraints
         JOIN pg_class relations ON relations.oid = constraints.conrelid
         JOIN pg_namespace namespaces ON namespaces.oid = relations.relnamespace
        WHERE namespaces.nspname = 'public' AND relations.relname = ANY($1::text[])
        ORDER BY relations.relname, constraints.conname`,
      [tableNames]
    );
    const definitions = constraints.rows.map((row) => `${row.table_name}: ${row.definition}`).join("\n");
    expect(definitions).toMatch(/asset_metadata_backfill_jobs:.*queued.*running.*recoverable.*completed.*failed/i);
    expect(definitions).toMatch(/durable_filesystem_operations:.*reserved.*attached.*finalized.*cleanup_pending.*cleaned/i);
    expect(definitions).toMatch(/portable_import_operations:.*campaign_zip.*legacy_story.*infinite_worlds.*cyoa.*world_json.*world_text.*story_text/i);
    expect(definitions).toMatch(/asset_metadata_unavailable.*filesystem_race_detected/i);

    // The exact portable-import publication mapping uses this owner-scoped key
    // as its composite foreign-key target; it does not prevent import cleanup
    // unless an immutable publication mapping still retains the import.
    const importOwnerConstraint = await pool.query<{ constraint_name: string }>(
      `SELECT constraint_name
         FROM information_schema.table_constraints
        WHERE table_schema='public' AND table_name='imports'
          AND constraint_name='imports_id_owner_unique'`
    );
    expect(importOwnerConstraint.rows).toEqual([{ constraint_name: "imports_id_owner_unique" }]);

    const indexes = await pool.query<{ indexname: string }>(
      `SELECT indexname
         FROM pg_indexes
        WHERE schemaname = 'public' AND indexname = ANY($1::text[])
        ORDER BY indexname`,
      [[
        "asset_metadata_backfill_claim_idx",
        "durable_filesystem_operations_recovery_idx",
        "portable_staged_inputs_expiry_idx",
        "portable_import_operations_expiry_idx",
        "portable_export_artifacts_expiry_idx"
      ]]
    );
    expect(indexes.rows.map((row) => row.indexname)).toEqual([
      "asset_metadata_backfill_claim_idx",
      "durable_filesystem_operations_recovery_idx",
      "portable_export_artifacts_expiry_idx",
      "portable_import_operations_expiry_idx",
      "portable_staged_inputs_expiry_idx"
    ]);
  });

  it("adds owner-scoped System Archive job and upload persistence with hashed-only handles", async () => {
    const tableNames = [
      "system_archive_jobs",
      "system_archive_upload_chunks",
      "system_archive_uploads"
    ];
    const tables = await pool.query<{ table_name: string }>(
      `SELECT table_name
         FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = ANY($1::text[])
        ORDER BY table_name`,
      [tableNames]
    );
    expect(tables.rows.map((row) => row.table_name)).toEqual([...tableNames].sort());

    const columns = await pool.query<{ table_name: string; column_name: string; is_nullable: string }>(
      `SELECT table_name,column_name,is_nullable
         FROM information_schema.columns
        WHERE table_schema='public' AND table_name=ANY($1::text[])
        ORDER BY table_name,ordinal_position`,
      [tableNames]
    );
    expect(columns.rows.filter((row) => row.column_name === "owner_user_id"))
      .toEqual(tableNames.map((tableName) => ({
        table_name: tableName,
        column_name: "owner_user_id",
        is_nullable: "NO"
      })));
    expect(columns.rows.filter((row) => row.column_name.includes("token") && !row.column_name.endsWith("_hash")))
      .toEqual([]);

    const constraints = await pool.query<{ table_name: string; definition: string }>(
      `SELECT relations.relname AS table_name,pg_get_constraintdef(constraints.oid) AS definition
         FROM pg_constraint constraints
         JOIN pg_class relations ON relations.oid=constraints.conrelid
         JOIN pg_namespace namespaces ON namespaces.oid=relations.relnamespace
        WHERE namespaces.nspname='public'
          AND relations.relname=ANY($1::text[])
        ORDER BY relations.relname,constraints.conname`,
      [tableNames]
    );
    const definitions = constraints.rows.map((row) => `${row.table_name}: ${row.definition}`).join("\n");
    expect(definitions).toMatch(/system_archive_jobs:.*export.*import/i);
    expect(definitions).toMatch(/system_archive_jobs:.*queued.*capturing.*authoritative_committed.*expired/i);
    expect(definitions).toMatch(/system_archive_uploads:.*created.*uploading.*completed.*expired.*failed/i);
    expect(definitions).toMatch(/system_archive_upload_chunks:.*durable_filesystem_operations/i);

    const indexes = await pool.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname,indexdef
         FROM pg_indexes
        WHERE schemaname='public'
          AND tablename=ANY($1::text[])
        ORDER BY indexname`,
      [tableNames]
    );
    expect(indexes.rows.map((row) => row.indexname)).toEqual(expect.arrayContaining([
      "system_archive_jobs_claim_idx",
      "system_archive_jobs_one_active_export_per_owner_idx",
      "system_archive_jobs_one_active_import_idx",
      "system_archive_upload_chunks_offset_key",
      "system_archive_uploads_expiry_idx",
      "system_archive_uploads_handle_token_hash_key"
    ]));
  });

  it("validates expanded portable artifact constraints before the short final swap", async () => {
    const migration = await readFile(resolve("database/migrations/0078_system_archive_jobs.sql"), "utf8");
    expect(migration.startsWith("-- infinitequest:migration-mode=phased-transactions-v1\n")).toBe(true);
    expect(migration.match(/^-- infinitequest:transaction-boundary$/gmu)).toHaveLength(2);
    const addKind = migration.indexOf("portable_export_artifacts_export_kind_check_system_archive");
    const addScope = migration.indexOf("portable_export_scope_check_system_archive");
    const validateKind = migration.indexOf(
      "VALIDATE CONSTRAINT portable_export_artifacts_export_kind_check_system_archive"
    );
    const validateScope = migration.indexOf(
      "VALIDATE CONSTRAINT portable_export_scope_check_system_archive"
    );
    const dropOriginal = migration.indexOf("DROP CONSTRAINT portable_export_artifacts_export_kind_check");

    expect(addKind).toBeGreaterThanOrEqual(0);
    expect(addScope).toBeGreaterThanOrEqual(0);
    expect(migration.slice(addKind, validateKind)).toContain("NOT VALID");
    expect(migration.slice(addScope, validateScope)).toContain("NOT VALID");
    expect(validateKind).toBeGreaterThan(addKind);
    expect(validateScope).toBeGreaterThan(addScope);
    expect(dropOriginal).toBeGreaterThan(validateKind);
    expect(dropOriginal).toBeGreaterThan(validateScope);
  });

  it("runs only the registered online migration phases in separate transactions", async () => {
    const databaseName = `infinitequest_phased_migration_${crypto.randomUUID().replaceAll("-", "")}`;
    const databaseUrlValue = new URL(databaseUrl!);
    databaseUrlValue.pathname = `/${databaseName}`;
    const migrationDirectory = await mkdtemp(join(tmpdir(), "infinitequest-phased-migration-"));
    const migrationName = "0078_system_archive_jobs";
    const phasedSql = `-- infinitequest:migration-mode=phased-transactions-v1
CREATE TABLE migration_phase_audit (
  phase text PRIMARY KEY,
  transaction_id bigint NOT NULL
);
INSERT INTO migration_phase_audit VALUES ('add-not-valid', txid_current());
-- infinitequest:transaction-boundary
COMMIT;
BEGIN;
INSERT INTO migration_phase_audit VALUES ('validate', txid_current());
-- infinitequest:transaction-boundary
COMMIT;
BEGIN;
INSERT INTO migration_phase_audit VALUES ('final-swap', txid_current());
`;
    let isolatedPool: DatabasePool | null = null;
    try {
      await pool.query(`CREATE DATABASE ${databaseName}`);
      isolatedPool = createDatabasePool(databaseUrlValue.toString(), 2);
      await writeFile(join(migrationDirectory, `${migrationName}.sql`), phasedSql);

      await expect(migrateDatabase(isolatedPool, migrationDirectory)).resolves.toEqual([migrationName]);
      const phases = await isolatedPool.query<{ phase: string; transaction_id: string }>(
        "SELECT phase,transaction_id::text FROM migration_phase_audit ORDER BY transaction_id"
      );
      expect(phases.rows.map((row) => row.phase)).toEqual([
        "add-not-valid",
        "validate",
        "final-swap"
      ]);
      expect(new Set(phases.rows.map((row) => row.transaction_id)).size).toBe(3);
      await expect(isolatedPool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM schema_migrations WHERE name=$1",
        [migrationName]
      )).resolves.toMatchObject({ rows: [{ count: "1" }] });
      await expect(migrateDatabase(isolatedPool, migrationDirectory)).resolves.toEqual([]);

      const unregisteredCases = [
        {
          migrationName: "0079_unregistered_end",
          tableName: "unregistered_end_audit",
          sql: "CREATE TABLE unregistered_end_audit (id integer); END;"
        },
        {
          migrationName: "0080_unregistered_commit_chain",
          tableName: "unregistered_commit_chain_audit",
          sql: "CREATE TABLE unregistered_commit_chain_audit (id integer); COMMIT AND CHAIN;"
        },
        {
          migrationName: "0081_unregistered_same_line",
          tableName: "unregistered_same_line_audit",
          sql: "CREATE TABLE unregistered_same_line_audit (id integer); COMMIT; BEGIN;"
        },
        {
          migrationName: "0082_unregistered_after_atomic_body",
          tableName: "unregistered_after_atomic_body_audit",
          sql: `CREATE FUNCTION unregistered_atomic_body() RETURNS integer
                LANGUAGE SQL BEGIN ATOMIC RETURN 1; END;
                CREATE TABLE unregistered_after_atomic_body_audit (id integer);
                COMMIT;`
        }
      ] as const;
      for (const unregistered of unregisteredCases) {
        const migrationPath = join(migrationDirectory, `${unregistered.migrationName}.sql`);
        await writeFile(migrationPath, unregistered.sql);
        await expect(migrateDatabase(isolatedPool, migrationDirectory)).rejects.toThrow(
          `Migration ${unregistered.migrationName} contains transaction control without an approved phased contract.`
        );
        await expect(isolatedPool.query(`SELECT to_regclass('public.${unregistered.tableName}') AS table_name`))
          .resolves.toMatchObject({ rows: [{ table_name: null }] });
        await rm(migrationPath);
      }
    } finally {
      if (isolatedPool) await isolatedPool.end();
      await dropTestDatabaseWhenIdle(pool, databaseName);
      await rm(migrationDirectory, { recursive: true, force: true });
    }
  });

  it("rejects transaction control after dollar-bearing unquoted identifiers before any side effect", async () => {
    const databaseName = `infinitequest_identifier_dollar_migration_${crypto.randomUUID().replaceAll("-", "")}`;
    const databaseUrlValue = new URL(databaseUrl!);
    databaseUrlValue.pathname = `/${databaseName}`;
    const migrationDirectory = await mkdtemp(join(tmpdir(), "infinitequest-identifier-dollar-migration-"));
    const migrationName = "0001_unregistered_identifier_dollar_commit";
    const tableNames = [
      "unregistered_identifier_dollar_audit_a",
      "unregistered_identifier_dollar_audit_b"
    ] as const;
    let isolatedPool: DatabasePool | null = null;
    try {
      await pool.query(`CREATE DATABASE ${databaseName}`);
      isolatedPool = createDatabasePool(databaseUrlValue.toString(), 2);
      await writeFile(
        join(migrationDirectory, `${migrationName}.sql`),
        `CREATE TABLE ${tableNames[0]} (foo$tag$ integer); COMMIT; `
          + `CREATE TABLE ${tableNames[1]} (bar$tag$ integer);`
      );

      await expect(migrateDatabase(isolatedPool, migrationDirectory)).rejects.toThrow(
        `Migration ${migrationName} contains transaction control without an approved phased contract.`
      );
      await expect(isolatedPool.query<{ table_name: string | null }>(
        "SELECT to_regclass('public.' || name)::text AS table_name FROM unnest($1::text[]) AS name ORDER BY name",
        [[...tableNames]]
      )).resolves.toMatchObject({ rows: [{ table_name: null }, { table_name: null }] });
    } finally {
      if (isolatedPool) await isolatedPool.end();
      await dropTestDatabaseWhenIdle(pool, databaseName);
      await rm(migrationDirectory, { recursive: true, force: true });
    }
  });

  it("rejects transaction control after begin atomic appears in a routine header", async () => {
    const databaseName = `infinitequest_atomic_header_migration_${crypto.randomUUID().replaceAll("-", "")}`;
    const databaseUrlValue = new URL(databaseUrl!);
    databaseUrlValue.pathname = `/${databaseName}`;
    const migrationDirectory = await mkdtemp(join(tmpdir(), "infinitequest-atomic-header-migration-"));
    const migrationName = "0001_unregistered_after_atomic_header";
    const tableNames = [
      "unregistered_atomic_header_audit_a",
      "unregistered_atomic_header_audit_b"
    ] as const;
    const migrationSql = `CREATE TABLE ${tableNames[0]} (id integer);
CREATE DOMAIN atomic AS integer;
CREATE FUNCTION migration_atomic_header(begin atomic) RETURNS integer
LANGUAGE SQL RETURN 1;
COMMIT;
CREATE TABLE ${tableNames[1]} (id integer);`;
    let isolatedPool: DatabasePool | null = null;
    try {
      await pool.query(`CREATE DATABASE ${databaseName}`);
      isolatedPool = createDatabasePool(databaseUrlValue.toString(), 2);
      await writeFile(join(migrationDirectory, `${migrationName}.sql`), migrationSql);

      await expect(migrateDatabase(isolatedPool, migrationDirectory)).rejects.toThrow(
        `Migration ${migrationName} contains transaction control without an approved phased contract.`
      );
      await expect(isolatedPool.query<{ table_name: string | null }>(
        "SELECT to_regclass('public.' || name)::text AS table_name FROM unnest($1::text[]) AS name ORDER BY name",
        [[...tableNames]]
      )).resolves.toMatchObject({ rows: [{ table_name: null }, { table_name: null }] });
    } finally {
      if (isolatedPool) await isolatedPool.end();
      await dropTestDatabaseWhenIdle(pool, databaseName);
      await rm(migrationDirectory, { recursive: true, force: true });
    }
  });

  it("rejects transaction control after high-bit dollar-bearing identifiers before any side effect", async () => {
    const databaseName = `infinitequest_high_bit_identifier_migration_${crypto.randomUUID().replaceAll("-", "")}`;
    const databaseUrlValue = new URL(databaseUrl!);
    databaseUrlValue.pathname = `/${databaseName}`;
    const migrationDirectory = await mkdtemp(join(tmpdir(), "infinitequest-high-bit-identifier-migration-"));
    const migrationName = "0001_unregistered_high_bit_identifier_commit";
    const tableNames = [
      "unregistered_high_bit_identifier_audit_a",
      "unregistered_high_bit_identifier_audit_b"
    ] as const;
    let isolatedPool: DatabasePool | null = null;
    try {
      await pool.query(`CREATE DATABASE ${databaseName}`);
      isolatedPool = createDatabasePool(databaseUrlValue.toString(), 2);
      await writeFile(
        join(migrationDirectory, `${migrationName}.sql`),
        `CREATE TABLE ${tableNames[0]} (foo😀$tag$ integer); COMMIT; `
          + `CREATE TABLE ${tableNames[1]} (bar😀$tag$ integer);`
      );

      await expect(migrateDatabase(isolatedPool, migrationDirectory)).rejects.toThrow(
        `Migration ${migrationName} contains transaction control without an approved phased contract.`
      );
      await expect(isolatedPool.query<{ table_name: string | null }>(
        "SELECT to_regclass('public.' || name)::text AS table_name FROM unnest($1::text[]) AS name ORDER BY name",
        [[...tableNames]]
      )).resolves.toMatchObject({ rows: [{ table_name: null }, { table_name: null }] });
    } finally {
      if (isolatedPool) await isolatedPool.end();
      await dropTestDatabaseWhenIdle(pool, databaseName);
      await rm(migrationDirectory, { recursive: true, force: true });
    }
  });

  it("accepts quoted, ASCII and high-bit dollar-quoted, DO, and SQL-standard atomic function bodies", async () => {
    const databaseName = `infinitequest_function_body_migration_${crypto.randomUUID().replaceAll("-", "")}`;
    const databaseUrlValue = new URL(databaseUrl!);
    databaseUrlValue.pathname = `/${databaseName}`;
    const migrationDirectory = await mkdtemp(join(tmpdir(), "infinitequest-function-body-migration-"));
    const migrationName = "0001_valid_function_bodies";
    const migrationSql = `CREATE FUNCTION migration_quoted_body(input_value integer) RETURNS integer
AS 'BEGIN RETURN input_value + 1; END;'
LANGUAGE plpgsql;

CREATE FUNCTION migration_dollar_body(input_value integer) RETURNS integer
AS $function$
BEGIN
  RETURN input_value + 2;
END;
$function$
LANGUAGE plpgsql;

CREATE FUNCTION migration_high_bit_dollar_body(input_value integer) RETURNS integer
AS $😀$
BEGIN
  RETURN input_value + 3;
END;
$😀$
LANGUAGE plpgsql;

DO $body$
BEGIN
  PERFORM migration_dollar_body(1);
END;
$body$;

CREATE FUNCTION migration_atomic_body(input_value integer) RETURNS integer
LANGUAGE SQL
BEGIN ATOMIC
  RETURN input_value + 4;
END;
`;
    let isolatedPool: DatabasePool | null = null;
    try {
      await pool.query(`CREATE DATABASE ${databaseName}`);
      isolatedPool = createDatabasePool(databaseUrlValue.toString(), 2);
      await writeFile(join(migrationDirectory, `${migrationName}.sql`), migrationSql);

      await expect(migrateDatabase(isolatedPool, migrationDirectory)).resolves.toEqual([migrationName]);
      await expect(isolatedPool.query<{
        quoted_result: number;
        dollar_result: number;
        high_bit_dollar_result: number;
        atomic_result: number;
      }>(
        `SELECT migration_quoted_body(1) AS quoted_result,
                migration_dollar_body(1) AS dollar_result,
                migration_high_bit_dollar_body(1) AS high_bit_dollar_result,
                migration_atomic_body(1) AS atomic_result`
      )).resolves.toMatchObject({
        rows: [{ quoted_result: 2, dollar_result: 3, high_bit_dollar_result: 4, atomic_result: 5 }]
      });
    } finally {
      if (isolatedPool) await isolatedPool.end();
      await dropTestDatabaseWhenIdle(pool, databaseName);
      await rm(migrationDirectory, { recursive: true, force: true });
    }
  });

  it("adds restart-realizable private filesystem authority without classifying legacy asset paths", async () => {
    const authorityTables = [
      "durable_filesystem_candidate_authorities",
      "private_filesystem_delivery_grants"
    ];
    const tables = await pool.query<{ table_name: string }>(
      `SELECT table_name
         FROM information_schema.tables
        WHERE table_schema='public' AND table_name=ANY($1::text[])
        ORDER BY table_name`,
      [authorityTables]
    );
    expect(tables.rows.map((row) => row.table_name)).toEqual(authorityTables.sort());

    const privateColumns = await pool.query<{ table_name: string; column_name: string }>(
      `SELECT table_name,column_name
         FROM information_schema.columns
        WHERE table_schema='public'
          AND table_name=ANY($1::text[])
          AND column_name ~ '(token|candidate|grant|locator)'
        ORDER BY table_name,column_name`,
      [authorityTables]
    );
    expect(privateColumns.rows).not.toHaveLength(0);
    expect(privateColumns.rows.filter((row) => (
      row.column_name !== "change_token" && !row.column_name.endsWith("_hash")
    ))).toEqual([]);

    const bindings = await pool.query<{ table_name: string; column_name: string; is_nullable: string }>(
      `SELECT table_name,column_name,is_nullable
         FROM information_schema.columns
        WHERE table_schema='public'
          AND table_name IN ('assets','asset_derivatives')
          AND column_name IN ('filesystem_operation_id','filesystem_operation_purpose')
        ORDER BY table_name,column_name`
    );
    expect(bindings.rows).toEqual([
      { table_name: "asset_derivatives", column_name: "filesystem_operation_id", is_nullable: "YES" },
      { table_name: "asset_derivatives", column_name: "filesystem_operation_purpose", is_nullable: "NO" },
      { table_name: "assets", column_name: "filesystem_operation_id", is_nullable: "YES" },
      { table_name: "assets", column_name: "filesystem_operation_purpose", is_nullable: "NO" }
    ]);

    const legacyRows = await pool.query<{
      asset_bindings: string;
      derivative_bindings: string;
    }>(
      `SELECT
         (SELECT count(*)::text FROM assets WHERE filesystem_operation_id IS NOT NULL) AS asset_bindings,
         (SELECT count(*)::text FROM asset_derivatives WHERE filesystem_operation_id IS NOT NULL) AS derivative_bindings`
    );
    expect(legacyRows.rows).toEqual([{ asset_bindings: "0", derivative_bindings: "0" }]);

    const indexes = await pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
        WHERE schemaname='public' AND indexname=ANY($1::text[])
        ORDER BY indexname`,
      [[
        "assets_filesystem_operation_idx",
        "asset_derivatives_filesystem_operation_idx",
        "durable_filesystem_candidate_authorities_expiry_idx",
        "private_filesystem_delivery_grants_expiry_idx"
      ]]
    );
    expect(indexes.rows.map((row) => row.indexname)).toEqual([
      "asset_derivatives_filesystem_operation_idx",
      "assets_filesystem_operation_idx",
      "durable_filesystem_candidate_authorities_expiry_idx",
      "private_filesystem_delivery_grants_expiry_idx"
    ]);
  });

  it("enforces exact asset bindings and restart-safe candidate and delivery grant authority", async () => {
    const client = await pool.connect();
    const hash = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
    let savepointOrdinal = 0;
    const statementWasRejected = async (sql: string, parameters: unknown[] = []): Promise<boolean> => {
      const savepoint = `task_14e3b1_rejection_${savepointOrdinal += 1}`;
      await client.query(`SAVEPOINT ${savepoint}`);
      let rejected = false;
      try {
        await client.query(sql, parameters);
      } catch {
        rejected = true;
      } finally {
        await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        await client.query(`RELEASE SAVEPOINT ${savepoint}`);
      }
      return rejected;
    };

    try {
      await client.query("BEGIN");
      const ownerOne = (await client.query<{ id: string }>(
        "SELECT id FROM users WHERE system_key='initial-owner'"
      )).rows[0]!.id;
      const ownerTwo = (await client.query<{ id: string }>(
        "INSERT INTO users (display_name) VALUES ('Task 14e3b1 foreign owner') RETURNING id"
      )).rows[0]!.id;
      const insertAsset = async (ownerUserId: string, label: string): Promise<string> => (
        await client.query<{ id: string }>(
          `INSERT INTO assets (
             owner_user_id,content_hash,storage_driver,storage_path,mime_type,byte_length,pixel_width,pixel_height
           ) VALUES ($1,$2,'filesystem',$3,'image/png',7,1,1) RETURNING id`,
          [ownerUserId, hash(`asset-${label}-${crypto.randomUUID()}`), `legacy/${label}.png`]
        )
      ).rows[0]!.id;
      const assetOne = await insertAsset(ownerOne, "one");
      const assetTwo = await insertAsset(ownerOne, "two");
      const foreignAsset = await insertAsset(ownerTwo, "foreign");
      const derivative = (await client.query<{ id: string }>(
        `INSERT INTO asset_derivatives (
           owner_user_id,source_asset_id,derivative_kind,transform_version,pixel_width,pixel_height,
           storage_driver,storage_path,mime_type,byte_length,content_hash
         ) VALUES ($1,$2,'thumbnail',1,1,1,'filesystem','legacy/one-thumb.webp','image/webp',3,$3)
         RETURNING id`,
        [ownerOne, assetOne, hash(`derivative-${crypto.randomUUID()}`)]
      )).rows[0]!.id;

      const insertAssetOperation = async (
        ownerUserId: string,
        purpose: "asset_original" | "asset_derivative",
        assetId: string,
        label: string,
      ): Promise<string> => (await client.query<{ id: string }>(
        `INSERT INTO durable_filesystem_operations (
           owner_user_id,operation_token_hash,purpose,resource_kind,asset_id,
           lease_id,lease_owner,lease_expires_at,expires_at
         ) VALUES ($1,$2,$3,'asset',$4,gen_random_uuid(),'task-14e3b1',
                   now()+interval '5 minutes',now()+interval '1 hour') RETURNING id`,
        [ownerUserId, hash(`operation-${label}-${crypto.randomUUID()}`), purpose, assetId]
      )).rows[0]!.id;

      const originalOperation = await insertAssetOperation(ownerOne, "asset_original", assetOne, "original");
      const derivativeOperation = await insertAssetOperation(ownerOne, "asset_derivative", assetOne, "derivative");
      const otherAssetOperation = await insertAssetOperation(ownerOne, "asset_original", assetTwo, "other");
      const foreignOperation = await insertAssetOperation(ownerTwo, "asset_original", foreignAsset, "foreign");

      const initialBindings = await client.query<{
        asset_one: string | null;
        asset_two: string | null;
        derivative: string | null;
      }>(
        `SELECT
           (SELECT filesystem_operation_id::text FROM assets WHERE id=$1) AS asset_one,
           (SELECT filesystem_operation_id::text FROM assets WHERE id=$2) AS asset_two,
           (SELECT filesystem_operation_id::text FROM asset_derivatives WHERE id=$3) AS derivative`,
        [assetOne, assetTwo, derivative]
      );
      expect(initialBindings.rows).toEqual([{ asset_one: null, asset_two: null, derivative: null }]);

      await client.query("UPDATE assets SET filesystem_operation_id=$2 WHERE id=$1", [assetOne, originalOperation]);
      await client.query(
        "UPDATE asset_derivatives SET filesystem_operation_id=$2 WHERE id=$1",
        [derivative, derivativeOperation]
      );
      expect(await statementWasRejected(
        "UPDATE assets SET filesystem_operation_id=$2 WHERE id=$1",
        [assetTwo, derivativeOperation]
      )).toBe(true);
      expect(await statementWasRejected(
        "UPDATE assets SET filesystem_operation_id=$2 WHERE id=$1",
        [assetTwo, originalOperation]
      )).toBe(true);
      expect(await statementWasRejected(
        "UPDATE assets SET filesystem_operation_id=$2 WHERE id=$1",
        [assetTwo, foreignOperation]
      )).toBe(true);
      expect(await statementWasRejected(
        "UPDATE assets SET filesystem_operation_id=$2 WHERE id=$1",
        [assetOne, otherAssetOperation]
      )).toBe(true);
      expect(await statementWasRejected(
        "UPDATE assets SET filesystem_operation_id=NULL WHERE id=$1",
        [assetOne]
      )).toBe(true);

      const rawCandidate = `raw-candidate-${crypto.randomUUID()}`;
      const candidateHash = hash(rawCandidate);
      const descriptorHash = hash(`descriptor-${crypto.randomUUID()}`);
      const insertCandidateSql = `INSERT INTO durable_filesystem_candidate_authorities (
        candidate_token_hash,operation_id,owner_user_id,purpose,resource_kind,asset_id,
        relative_path,device_id,file_id,change_token,content_hash,byte_length,expires_at
      ) VALUES ($1,$2,$3,$4,'asset',$5,'private/original.png','device-1','file-1','change-1',$6,7,$7)`;
      await client.query(insertCandidateSql, [
        candidateHash,
        originalOperation,
        ownerOne,
        "asset_original",
        assetOne,
        descriptorHash,
        new Date(Date.now() + 30 * 60_000)
      ]);
      const persistedCandidate = await client.query<{
        candidate_token_hash: string;
        relative_path: string;
        lifecycle: string;
      }>(
        `SELECT candidate_token_hash,relative_path,lifecycle
           FROM durable_filesystem_candidate_authorities WHERE operation_id=$1`,
        [originalOperation]
      );
      expect(persistedCandidate.rows).toEqual([{
        candidate_token_hash: candidateHash,
        relative_path: "private/original.png",
        lifecycle: "issued"
      }]);
      expect(persistedCandidate.rows[0]!.candidate_token_hash).not.toContain(rawCandidate);

      expect(await statementWasRejected(insertCandidateSql, [
        hash(`wrong-owner-${crypto.randomUUID()}`), originalOperation, ownerTwo, "asset_original",
        assetOne, descriptorHash, new Date(Date.now() + 20 * 60_000)
      ])).toBe(true);
      expect(await statementWasRejected(insertCandidateSql, [
        hash(`wrong-purpose-${crypto.randomUUID()}`), originalOperation, ownerOne, "asset_derivative",
        assetOne, descriptorHash, new Date(Date.now() + 20 * 60_000)
      ])).toBe(true);
      expect(await statementWasRejected(insertCandidateSql, [
        hash(`wrong-asset-${crypto.randomUUID()}`), originalOperation, ownerOne, "asset_original",
        assetTwo, descriptorHash, new Date(Date.now() + 20 * 60_000)
      ])).toBe(true);
      expect(await statementWasRejected(insertCandidateSql, [
        hash(`stale-${crypto.randomUUID()}`), otherAssetOperation, ownerOne, "asset_original",
        assetTwo, descriptorHash, new Date(Date.now() - 60_000)
      ])).toBe(true);
      expect(await statementWasRejected(
        "UPDATE durable_filesystem_candidate_authorities SET relative_path='private/mutated.png' WHERE operation_id=$1",
        [originalOperation]
      )).toBe(true);
      expect(await statementWasRejected(
        "DELETE FROM durable_filesystem_candidate_authorities WHERE operation_id=$1",
        [originalOperation]
      )).toBe(true);

      await client.query(
        `UPDATE durable_filesystem_operations
            SET lifecycle='attached',candidate_token_hash=$2,locator_token_hash=$3,attached_at=now()
          WHERE id=$1`,
        [originalOperation, candidateHash, hash(`locator-${crypto.randomUUID()}`)]
      );
      await client.query(
        `INSERT INTO durable_filesystem_descriptors (
           operation_id,owner_user_id,descriptor_role,ordinal,relative_path,device_id,file_id,
           change_token,content_hash,byte_length
         ) VALUES ($1,$2,'delivery',0,'private/original.png','device-1','file-1','change-1',$3,7)`,
        [originalOperation, ownerOne, descriptorHash]
      );
      await client.query(
        "UPDATE durable_filesystem_candidate_authorities SET lifecycle='attached',updated_at=now() WHERE operation_id=$1",
        [originalOperation]
      );

      const insertGrantSql = `INSERT INTO private_filesystem_delivery_grants (
        grant_token_hash,candidate_token_hash,operation_id,owner_user_id,purpose,
        resource_kind,asset_id,expires_at
      ) VALUES ($1,$2,$3,$4,$5,'asset',$6,$7)`;
      expect(await statementWasRejected(insertGrantSql, [
        hash(`premature-grant-${crypto.randomUUID()}`), candidateHash, originalOperation,
        ownerOne, "asset_original", assetOne, new Date(Date.now() + 30_000)
      ])).toBe(true);

      await client.query(
        "UPDATE durable_filesystem_operations SET lifecycle='finalized',finalized_at=now() WHERE id=$1",
        [originalOperation]
      );
      expect(await statementWasRejected(insertGrantSql, [
        hash(`overlong-grant-${crypto.randomUUID()}`), candidateHash, originalOperation,
        ownerOne, "asset_original", assetOne, new Date(Date.now() + 2 * 60_000)
      ])).toBe(true);
      const rawGrant = `raw-grant-${crypto.randomUUID()}`;
      const grantHash = hash(rawGrant);
      await client.query(insertGrantSql, [
        grantHash, candidateHash, originalOperation, ownerOne, "asset_original",
        assetOne, new Date(Date.now() + 30_000)
      ]);
      const persistedGrant = await client.query<{
        grant_token_hash: string;
        candidate_token_hash: string;
        lifecycle: string;
      }>(
        `SELECT grant_token_hash,candidate_token_hash,lifecycle
           FROM private_filesystem_delivery_grants WHERE grant_token_hash=$1`,
        [grantHash]
      );
      expect(persistedGrant.rows).toEqual([{
        grant_token_hash: grantHash,
        candidate_token_hash: candidateHash,
        lifecycle: "issued"
      }]);
      expect(persistedGrant.rows[0]!.grant_token_hash).not.toContain(rawGrant);

      expect(await statementWasRejected(insertGrantSql, [
        hash(`wrong-scope-grant-${crypto.randomUUID()}`), candidateHash, originalOperation,
        ownerOne, "asset_original", assetTwo, new Date(Date.now() + 30_000)
      ])).toBe(true);
      expect(await statementWasRejected(insertGrantSql, [
        hash(`stale-grant-${crypto.randomUUID()}`), candidateHash, originalOperation,
        ownerOne, "asset_original", assetOne, new Date(Date.now() - 60_000)
      ])).toBe(true);
      expect(await statementWasRejected(
        "UPDATE private_filesystem_delivery_grants SET expires_at=expires_at+interval '1 minute' WHERE grant_token_hash=$1",
        [grantHash]
      )).toBe(true);
      expect(await statementWasRejected(
        "DELETE FROM private_filesystem_delivery_grants WHERE grant_token_hash=$1",
        [grantHash]
      )).toBe(true);

      await client.query(
        `UPDATE private_filesystem_delivery_grants
            SET lifecycle='redeemed',redeemed_at=now(),updated_at=now()
          WHERE grant_token_hash=$1`,
        [grantHash]
      );
      expect(await statementWasRejected(
        "UPDATE private_filesystem_delivery_grants SET redeemed_at=now() WHERE grant_token_hash=$1",
        [grantHash]
      )).toBe(true);

      const revokedCandidateGrantHash = hash(`revoked-candidate-grant-${crypto.randomUUID()}`);
      await client.query(insertGrantSql, [
        revokedCandidateGrantHash, candidateHash, originalOperation, ownerOne, "asset_original",
        assetOne, new Date(Date.now() + 30_000)
      ]);
      await client.query(
        "UPDATE durable_filesystem_candidate_authorities SET lifecycle='revoked',updated_at=now() WHERE operation_id=$1",
        [originalOperation]
      );
      expect(await statementWasRejected(
        `UPDATE private_filesystem_delivery_grants
            SET lifecycle='redeemed',redeemed_at=now(),updated_at=now()
          WHERE grant_token_hash=$1`,
        [revokedCandidateGrantHash]
      )).toBe(true);

      const legacyStillUnclassified = await client.query<{
        filesystem_operation_id: string | null;
        storage_path: string;
      }>(
        "SELECT filesystem_operation_id::text,storage_path FROM assets WHERE id=$1",
        [assetTwo]
      );
      expect(legacyStillUnclassified.rows).toEqual([{
        filesystem_operation_id: null,
        storage_path: "legacy/two.png"
      }]);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  it("enforces durable authority, purpose, owner, retention, and portable scope relationships in PostgreSQL", async () => {
    const client = await pool.connect();
    const hash = (label: string) => createHash("sha256").update(`${label}-${crypto.randomUUID()}`, "utf8").digest("hex");
    let savepointOrdinal = 0;
    const statementError = async (sql: string, parameters: unknown[] = []): Promise<Error | null> => {
      const savepoint = `task_14e2b1_rejection_${savepointOrdinal += 1}`;
      await client.query(`SAVEPOINT ${savepoint}`);
      let rejection: Error | null = null;
      try {
        await client.query(sql, parameters);
      } catch (error) {
        rejection = error instanceof Error ? error : new Error(String(error));
      } finally {
        await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        await client.query(`RELEASE SAVEPOINT ${savepoint}`);
      }
      return rejection;
    };
    const statementWasRejected = async (sql: string, parameters: unknown[] = []): Promise<boolean> => (
      await statementError(sql, parameters)
    ) !== null;
    try {
      await client.query("BEGIN");
      const ownerOne = (await client.query<{ id: string }>(
        "SELECT id FROM users WHERE system_key='initial-owner'"
      )).rows[0]!.id;
      const ownerTwo = (await client.query<{ id: string }>(
        "INSERT INTO users (display_name) VALUES ('Migration isolation owner') RETURNING id"
      )).rows[0]!.id;
      const assetOne = (await client.query<{ id: string }>(
        `INSERT INTO assets (
           owner_user_id,content_hash,storage_driver,storage_path,mime_type,byte_length,pixel_width,pixel_height
         ) VALUES ($1,$2,'filesystem',$3,'image/png',1,1,1) RETURNING id`,
        [ownerOne, hash("asset-one"), `migration/${crypto.randomUUID()}.png`]
      )).rows[0]!.id;
      const assetTwo = (await client.query<{ id: string }>(
        `INSERT INTO assets (
           owner_user_id,content_hash,storage_driver,storage_path,mime_type,byte_length,pixel_width,pixel_height
         ) VALUES ($1,$2,'filesystem',$3,'image/png',1,1,1) RETURNING id`,
        [ownerOne, hash("asset-two"), `migration/${crypto.randomUUID()}.png`]
      )).rows[0]!.id;

      const insertOperation = async (
        ownerUserId: string,
        purpose: "asset_original" | "asset_derivative" | "portable_staging" | "portable_export",
        assetId: string | null
      ): Promise<string> => (await client.query<{ id: string }>(
        `INSERT INTO durable_filesystem_operations (
           owner_user_id,operation_token_hash,purpose,resource_kind,asset_id,operation_scope_hash,
           lease_id,lease_owner,lease_expires_at,expires_at
         ) VALUES ($1,$2,$3,$4,$5,$6,gen_random_uuid(),'migration-test',now()+interval '5 minutes',now()+interval '1 hour')
         RETURNING id`,
        [
          ownerUserId,
          hash(`operation-${purpose}`),
          purpose,
          assetId === null ? "portable" : "asset",
          assetId,
          assetId === null ? hash(`scope-${purpose}`) : null
        ]
      )).rows[0]!.id;

      const crossOwnerAssetRejected = await statementWasRejected(
        `INSERT INTO durable_filesystem_operations (
           owner_user_id,operation_token_hash,purpose,resource_kind,asset_id,
           lease_id,lease_owner,lease_expires_at,expires_at
         ) VALUES ($1,$2,'asset_original','asset',$3,gen_random_uuid(),'migration-test',now()+interval '5 minutes',now()+interval '1 hour')`,
        [ownerTwo, hash("cross-owner-operation"), assetOne]
      );
      const nonexistentAssetRejected = await statementWasRejected(
        `INSERT INTO durable_filesystem_operations (
           owner_user_id,operation_token_hash,purpose,resource_kind,asset_id,
           lease_id,lease_owner,lease_expires_at,expires_at
         ) VALUES ($1,$2,'asset_original','asset',$3,gen_random_uuid(),'migration-test',now()+interval '5 minutes',now()+interval '1 hour')`,
        [ownerOne, hash("missing-asset-operation"), crypto.randomUUID()]
      );
      const nonReservedCapabilityInsertRejected = await statementWasRejected(
        `INSERT INTO durable_filesystem_operations (
           owner_user_id,operation_token_hash,purpose,resource_kind,operation_scope_hash,lifecycle,
           candidate_token_hash,locator_token_hash,lease_id,lease_owner,lease_expires_at,expires_at,attached_at
         ) VALUES ($1,$2,'portable_staging','portable',$3,'attached',$4,$5,
                   gen_random_uuid(),'migration-test',now()+interval '5 minutes',now()+interval '1 hour',now())`,
        [ownerOne, hash("nonreserved-operation"), hash("nonreserved-scope"), hash("nonreserved-candidate"), hash("nonreserved-locator")]
      );

      const reservedDeletionOperationId = await insertOperation(ownerOne, "asset_derivative", assetTwo);
      const reservedOperationDeletionRejected = await statementWasRejected(
        "DELETE FROM durable_filesystem_operations WHERE id=$1",
        [reservedDeletionOperationId]
      );
      const invalidDiagnosticRejected = await statementWasRejected(
        "UPDATE durable_filesystem_operations SET diagnostic_code='not_allowlisted' WHERE id=$1",
        [reservedDeletionOperationId]
      );
      const invalidLifecycleValueRejected = await statementWasRejected(
        "UPDATE durable_filesystem_operations SET lifecycle='unknown_state' WHERE id=$1",
        [reservedDeletionOperationId]
      );
      const reservedToFinalizedMintRejected = await statementWasRejected(
        `UPDATE durable_filesystem_operations
            SET lifecycle='finalized',candidate_token_hash=$2,locator_token_hash=$3,
                attached_at=now(),finalized_at=now()
          WHERE id=$1`,
        [reservedDeletionOperationId, hash("illegal-finalized-candidate"), hash("illegal-finalized-locator")]
      );

      const cleanupWithoutCandidateOperationId = await insertOperation(ownerOne, "portable_staging", null);
      await client.query(
        `UPDATE durable_filesystem_operations
            SET lifecycle='cleanup_pending',cleanup_requested_at=now()
          WHERE id=$1`,
        [cleanupWithoutCandidateOperationId]
      );
      const cleanupPendingFirstMintRejected = await statementWasRejected(
        `UPDATE durable_filesystem_operations
            SET candidate_token_hash=$2,locator_token_hash=$3,attached_at=now()
          WHERE id=$1`,
        [cleanupWithoutCandidateOperationId, hash("late-candidate"), hash("late-locator")]
      );
      await client.query(
        `UPDATE durable_filesystem_operations
            SET lifecycle='cleaned',cleaned_at=now()
          WHERE id=$1`,
        [cleanupWithoutCandidateOperationId]
      );
      const cleanedNoCandidateOperationDeletionAllowed = !(await statementWasRejected(
        "DELETE FROM durable_filesystem_operations WHERE id=$1",
        [cleanupWithoutCandidateOperationId]
      ));

      const assetOperationId = await insertOperation(ownerOne, "asset_original", assetOne);
      const operationTokenMutationRejected = await statementWasRejected(
        "UPDATE durable_filesystem_operations SET operation_token_hash=$2 WHERE id=$1",
        [assetOperationId, hash("mutated-operation-token")]
      );
      const purposeMutationRejected = await statementWasRejected(
        "UPDATE durable_filesystem_operations SET purpose='asset_derivative' WHERE id=$1",
        [assetOperationId]
      );
      const assetMutationRejected = await statementWasRejected(
        "UPDATE durable_filesystem_operations SET asset_id=$2 WHERE id=$1",
        [assetOperationId, assetTwo]
      );
      const assetDeletionRejected = await statementWasRejected(
        "DELETE FROM assets WHERE id=$1",
        [assetOne]
      );

      const candidateHash = hash("candidate");
      const locatorHash = hash("locator");
      await client.query(
        `UPDATE durable_filesystem_operations
            SET lifecycle='attached',candidate_token_hash=$2,locator_token_hash=$3,attached_at=now()
          WHERE id=$1`,
        [assetOperationId, candidateHash, locatorHash]
      );
      await client.query(
        `UPDATE durable_filesystem_operations
            SET lease_id=gen_random_uuid(),lease_owner='migration-recovery',work_version=work_version+1,
                lease_expires_at=now()+interval '10 minutes',updated_at=now()
          WHERE id=$1`,
        [assetOperationId]
      );
      const legalLifecycle = await client.query<{ lifecycle: string; lease_owner: string; work_version: number }>(
        "SELECT lifecycle,lease_owner,work_version FROM durable_filesystem_operations WHERE id=$1",
        [assetOperationId]
      );
      expect(legalLifecycle.rows).toEqual([{ lifecycle: "attached", lease_owner: "migration-recovery", work_version: 2 }]);
      const candidateMutationRejected = await statementWasRejected(
        "UPDATE durable_filesystem_operations SET candidate_token_hash=$2 WHERE id=$1",
        [assetOperationId, hash("replacement-candidate")]
      );
      const locatorMutationRejected = await statementWasRejected(
        "UPDATE durable_filesystem_operations SET locator_token_hash=$2 WHERE id=$1",
        [assetOperationId, hash("replacement-locator")]
      );

      await client.query(
        `INSERT INTO durable_filesystem_descriptors (
           operation_id,owner_user_id,descriptor_role,ordinal,relative_path,device_id,file_id,
           change_token,content_hash,byte_length
         ) VALUES ($1,$2,'delivery',0,'assets/original.png','device-1','file-1','change-1',$3,1)`,
        [assetOperationId, ownerOne, hash("descriptor-content")]
      );
      const descriptorUpdateRejected = await statementWasRejected(
        "UPDATE durable_filesystem_descriptors SET change_token='change-2' WHERE operation_id=$1",
        [assetOperationId]
      );
      const descriptorDeleteRejected = await statementWasRejected(
        "DELETE FROM durable_filesystem_descriptors WHERE operation_id=$1",
        [assetOperationId]
      );
      await client.query(
        `UPDATE durable_filesystem_operations
            SET lifecycle='cleanup_pending',cleanup_requested_at=now()
          WHERE id=$1`,
        [assetOperationId]
      );
      await client.query(
        `UPDATE durable_filesystem_operations
            SET lifecycle='cleaned',cleaned_at=now()
          WHERE id=$1`,
        [assetOperationId]
      );
      const cleanedAttachedOperationDeletionRejected = await statementWasRejected(
        "DELETE FROM durable_filesystem_operations WHERE id=$1",
        [assetOperationId]
      );

      const stagingOperationId = await insertOperation(ownerOne, "portable_staging", null);
      const exportOperationId = await insertOperation(ownerOne, "portable_export", null);
      const portableOwnerMutationRejected = await statementWasRejected(
        "UPDATE durable_filesystem_operations SET owner_user_id=$2 WHERE id=$1",
        [stagingOperationId, ownerTwo]
      );
      const portableScopeMutationRejected = await statementWasRejected(
        "UPDATE durable_filesystem_operations SET operation_scope_hash=$2 WHERE id=$1",
        [stagingOperationId, hash("replacement-scope")]
      );
      const stagedWrongPurposeRejected = await statementWasRejected(
        `INSERT INTO portable_staged_inputs (
           owner_user_id,handle_token_hash,filesystem_operation_id,content_hash,byte_length,expires_at
         ) VALUES ($1,$2,$3,$4,1,now()+interval '1 hour')`,
        [ownerOne, hash("wrong-staged-handle"), exportOperationId, hash("wrong-staged-content")]
      );
      const stagedInputId = (await client.query<{ id: string }>(
        `INSERT INTO portable_staged_inputs (
           owner_user_id,handle_token_hash,filesystem_operation_id,content_hash,byte_length,expires_at
         ) VALUES ($1,$2,$3,$4,1,now()+interval '1 hour') RETURNING id`,
        [ownerOne, hash("staged-handle"), stagingOperationId, hash("staged-content")]
      )).rows[0]!.id;

      await client.query(
        `INSERT INTO portable_import_operations (
           owner_user_id,staged_input_id,import_kind,preview_token_hash,content_fingerprint,
           destination_fingerprint,destination_kind,preview_projection,expires_at
         ) VALUES ($1,$2,'legacy_story',$3,$4,$5,'create_world',$6::jsonb,now()+interval '1 hour')`,
        [
          ownerOne,
          stagedInputId,
          hash("legacy-create-world-token"),
          hash("legacy-create-world-content"),
          hash("legacy-create-world-destination"),
          JSON.stringify({
            kind: "campaign",
            valid: true,
            title: "Portable Legacy Story",
            duplicate: false,
            existingCampaignId: null,
            counts: { turns: 0, completeHistoryCharacters: 0, estimatedHistoryTokens: 0 },
            warnings: []
          })
        ]
      );

      const worldOne = (await client.query<{ id: string }>(
        "INSERT INTO worlds (owner_user_id,title) VALUES ($1,'Portable world one') RETURNING id",
        [ownerOne]
      )).rows[0]!.id;
      const worldTwo = (await client.query<{ id: string }>(
        "INSERT INTO worlds (owner_user_id,title) VALUES ($1,'Portable world two') RETURNING id",
        [ownerOne]
      )).rows[0]!.id;
      const worldThree = (await client.query<{ id: string }>(
        "INSERT INTO worlds (owner_user_id,title) VALUES ($1,'Portable world three') RETURNING id",
        [ownerOne]
      )).rows[0]!.id;
      const worldVersionOne = (await client.query<{ id: string }>(
        `INSERT INTO world_versions (world_id,owner_user_id,version_number,content)
         VALUES ($1,$2,1,'{}'::jsonb) RETURNING id`,
        [worldOne, ownerOne]
      )).rows[0]!.id;
      const worldVersionTwo = (await client.query<{ id: string }>(
        `INSERT INTO world_versions (world_id,owner_user_id,version_number,content)
         VALUES ($1,$2,1,'{}'::jsonb) RETURNING id`,
        [worldTwo, ownerOne]
      )).rows[0]!.id;
      const campaignOne = (await client.query<{ id: string }>(
        "INSERT INTO campaigns (owner_user_id,world_version_id,title) VALUES ($1,$2,'Portable campaign') RETURNING id",
        [ownerOne, worldVersionOne]
      )).rows[0]!.id;

      const mismatchedPreviewRejected = await statementWasRejected(
        `INSERT INTO portable_import_operations (
           owner_user_id,staged_input_id,import_kind,preview_token_hash,content_fingerprint,
           destination_fingerprint,destination_kind,destination_world_id,destination_world_version_id,
           preview_projection,expires_at
         ) VALUES ($1,$2,'legacy_story',$3,$4,$5,'existing_world_version',$6,$7,'{}'::jsonb,now()+interval '1 hour')`,
        [
          ownerOne, stagedInputId, hash("mismatch-preview-token"), hash("mismatch-preview-content"),
          hash("mismatch-preview-destination"), worldTwo, worldVersionOne
        ]
      );

      const foreignImportId = (await client.query<{ id: string }>(
        `INSERT INTO imports (owner_user_id,source_type,source_name,source_hash,status)
         VALUES ($1,'legacy_story','foreign.json',$2,'completed') RETURNING id`,
        [ownerTwo, hash("foreign-import")]
      )).rows[0]!.id;
      const crossOwnerImportRejected = await statementWasRejected(
        `INSERT INTO portable_import_operations (
           owner_user_id,staged_input_id,import_kind,preview_token_hash,content_fingerprint,
           destination_fingerprint,destination_kind,destination_world_id,destination_world_version_id,
           preview_projection,import_id,expires_at
         ) VALUES ($1,$2,'legacy_story',$3,$4,$5,'existing_world_version',$6,$7,'{}'::jsonb,$8,now()+interval '1 hour')`,
        [
          ownerOne, stagedInputId, hash("foreign-import-token"), hash("foreign-import-content"),
          hash("foreign-import-destination"), worldOne, worldVersionOne, foreignImportId
        ]
      );
      const localImportId = (await client.query<{ id: string }>(
        `INSERT INTO imports (owner_user_id,source_type,source_name,source_hash,status)
         VALUES ($1,'legacy_story','local.json',$2,'completed') RETURNING id`,
        [ownerOne, hash("local-import")]
      )).rows[0]!.id;
      await client.query(
        `INSERT INTO portable_import_operations (
           owner_user_id,staged_input_id,import_kind,preview_token_hash,content_fingerprint,
           destination_fingerprint,destination_kind,destination_world_id,destination_world_version_id,
           preview_projection,import_id,expires_at
         ) VALUES ($1,$2,'legacy_story',$3,$4,$5,'existing_world_version',$6,$7,'{}'::jsonb,$8,now()+interval '1 hour')`,
        [
          ownerOne, stagedInputId, hash("local-import-token"), hash("local-import-content"),
          hash("local-import-destination"), worldOne, worldVersionOne, localImportId
        ]
      );

      const exportWrongPurposeRejected = await statementWasRejected(
        `INSERT INTO portable_export_artifacts (
           owner_user_id,retrieval_token_hash,filesystem_operation_id,export_kind,campaign_id,
           world_id,world_version_id,content_type,content_hash,byte_length,expires_at
         ) VALUES ($1,$2,$3,'campaign_zip',$4,$5,$6,'application/zip',$7,1,now()+interval '1 hour')`,
        [ownerOne, hash("wrong-export-token"), stagingOperationId, campaignOne, worldOne, worldVersionOne, hash("wrong-export-content")]
      );
      const mismatchedCampaignExportRejected = await statementWasRejected(
        `INSERT INTO portable_export_artifacts (
           owner_user_id,retrieval_token_hash,filesystem_operation_id,export_kind,campaign_id,
           world_id,world_version_id,content_type,content_hash,byte_length,expires_at
         ) VALUES ($1,$2,$3,'campaign_zip',$4,$5,$6,'application/zip',$7,1,now()+interval '1 hour')`,
        [ownerOne, hash("mismatch-export-token"), exportOperationId, campaignOne, worldTwo, worldVersionTwo, hash("mismatch-export-content")]
      );
      await client.query(
        `INSERT INTO portable_export_artifacts (
           owner_user_id,retrieval_token_hash,filesystem_operation_id,export_kind,campaign_id,
           world_id,world_version_id,content_type,content_hash,byte_length,expires_at
         ) VALUES ($1,$2,$3,'campaign_zip',$4,$5,$6,'application/zip',$7,1,now()+interval '1 hour')`,
        [ownerOne, hash("valid-export-token"), exportOperationId, campaignOne, worldOne, worldVersionOne, hash("valid-export-content")]
      );

      const importParentUpdateError = await statementError(
        "UPDATE imports SET owner_user_id=$2 WHERE id=$1",
        [localImportId, ownerTwo]
      );
      expect(importParentUpdateError?.message).toContain("referenced import owner scope is immutable");
      const worldVersionParentUpdateError = await statementError(
        "UPDATE world_versions SET world_id=$2 WHERE id=$1",
        [worldVersionOne, worldThree]
      );
      expect(worldVersionParentUpdateError?.message).toContain("referenced world version portable scope is immutable");
      const campaignParentUpdateError = await statementError(
        "UPDATE campaigns SET world_version_id=$2 WHERE id=$1",
        [campaignOne, worldVersionTwo]
      );
      expect(campaignParentUpdateError?.message).toContain("referenced campaign portable scope is immutable");

      expect({
        crossOwnerAssetRejected,
        nonexistentAssetRejected,
        nonReservedCapabilityInsertRejected,
        reservedOperationDeletionRejected,
        invalidDiagnosticRejected,
        invalidLifecycleValueRejected,
        reservedToFinalizedMintRejected,
        cleanupPendingFirstMintRejected,
        cleanedNoCandidateOperationDeletionAllowed,
        cleanedAttachedOperationDeletionRejected,
        operationTokenMutationRejected,
        purposeMutationRejected,
        assetMutationRejected,
        assetDeletionRejected,
        candidateMutationRejected,
        locatorMutationRejected,
        descriptorUpdateRejected,
        descriptorDeleteRejected,
        portableOwnerMutationRejected,
        portableScopeMutationRejected,
        stagedWrongPurposeRejected,
        mismatchedPreviewRejected,
        crossOwnerImportRejected,
        exportWrongPurposeRejected,
        mismatchedCampaignExportRejected
      }).toEqual({
        crossOwnerAssetRejected: true,
        nonexistentAssetRejected: true,
        nonReservedCapabilityInsertRejected: true,
        reservedOperationDeletionRejected: true,
        invalidDiagnosticRejected: true,
        invalidLifecycleValueRejected: true,
        reservedToFinalizedMintRejected: true,
        cleanupPendingFirstMintRejected: true,
        cleanedNoCandidateOperationDeletionAllowed: true,
        cleanedAttachedOperationDeletionRejected: true,
        operationTokenMutationRejected: true,
        purposeMutationRejected: true,
        assetMutationRejected: true,
        assetDeletionRejected: true,
        candidateMutationRejected: true,
        locatorMutationRejected: true,
        descriptorUpdateRejected: true,
        descriptorDeleteRejected: true,
        portableOwnerMutationRejected: true,
        portableScopeMutationRejected: true,
        stagedWrongPurposeRejected: true,
        mismatchedPreviewRejected: true,
        crossOwnerImportRejected: true,
        exportWrongPurposeRejected: true,
        mismatchedCampaignExportRejected: true
      });
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  it("adds scoped entity identity columns and indexes to Chronicle records", async () => {
    const columns = await pool.query<{
      table_name: string;
      is_nullable: string;
      column_default: string | null;
    }>(
      `SELECT table_name, is_nullable, column_default
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND column_name = 'entity_ids'
          AND table_name = ANY($1::text[])
        ORDER BY table_name`,
      [["campaign_canonical_facts", "chronicle_memories"]]
    );
    expect(columns.rows).toEqual([
      {
        table_name: "campaign_canonical_facts",
        is_nullable: "NO",
        column_default: "ARRAY[]::text[]"
      },
      {
        table_name: "chronicle_memories",
        is_nullable: "NO",
        column_default: "ARRAY[]::text[]"
      }
    ]);

    const indexes = await pool.query<{ indexname: string }>(
      `SELECT indexname
         FROM pg_indexes
        WHERE schemaname = 'public'
          AND indexname = ANY($1::text[])
        ORDER BY indexname`,
      [[
        "campaign_canonical_facts_entity_ids_idx",
        "chronicle_memories_entity_ids_idx"
      ]]
    );
    expect(indexes.rows.map((row) => row.indexname)).toEqual([
      "campaign_canonical_facts_entity_ids_idx",
      "chronicle_memories_entity_ids_idx"
    ]);
  });

  it("supports state-edit canonical facts and correction-aware replacement jobs", async () => {
    const columns = await pool.query<{
      table_name: string;
      column_name: string;
      is_nullable: string;
    }>(
      `SELECT table_name, column_name, is_nullable
         FROM information_schema.columns
        WHERE (table_name = 'generation_jobs' AND column_name IN (
          'state_edit_id', 'state_edit_revision', 'state_edit_snapshot_private'
        )) OR (table_name = 'campaign_canonical_facts' AND column_name IN (
          'source_turn_id', 'source_state_edit_id'
        ))
        ORDER BY table_name, column_name`
    );
    expect(columns.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ table_name: "generation_jobs", column_name: "state_edit_id" }),
      expect.objectContaining({ table_name: "generation_jobs", column_name: "state_edit_revision" }),
      expect.objectContaining({ table_name: "generation_jobs", column_name: "state_edit_snapshot_private" }),
      expect.objectContaining({ table_name: "campaign_canonical_facts", column_name: "source_state_edit_id" }),
      expect.objectContaining({ table_name: "campaign_canonical_facts", column_name: "source_turn_id", is_nullable: "YES" })
    ]));
  });

  it("bootstraps the initial owner exactly once when migrations run again", async () => {
    const migrationName = "0001_initial_nexus";
    const databaseName = `infinitequest_initial_owner_migration_${crypto.randomUUID().replaceAll("-", "")}`;
    const databaseUrlValue = new URL(databaseUrl!);
    databaseUrlValue.pathname = `/${databaseName}`;
    const migrationDirectory = await mkdtemp(join(tmpdir(), "infinitequest-initial-owner-migration-"));
    let isolatedPool: DatabasePool | null = null;
    try {
      await copyFile(
        resolve("database/migrations/0001_initial_nexus.sql"),
        join(migrationDirectory, "0001_initial_nexus.sql")
      );
      await pool.query(`CREATE DATABASE ${databaseName}`);
      isolatedPool = createDatabasePool(databaseUrlValue.toString(), 2);
      await expect(migrateDatabase(isolatedPool, migrationDirectory)).resolves.toEqual([migrationName]);

      const firstRun = await isolatedPool.query<{ id: string }>(
        "SELECT id FROM users WHERE system_key = 'initial-owner'"
      );
      expect(firstRun.rows).toHaveLength(1);

      await isolatedPool.query("DELETE FROM schema_migrations WHERE name = $1", [migrationName]);

      await expect(migrateDatabase(isolatedPool, migrationDirectory)).resolves.toEqual([migrationName]);

      const secondRun = await isolatedPool.query<{ id: string; count: string }>(
        `SELECT min(id::text)::uuid AS id, count(*)::text AS count
           FROM users
          WHERE system_key = 'initial-owner'`
      );
      expect(secondRun.rows).toEqual([{ id: firstRun.rows[0]!.id, count: "1" }]);
    } finally {
      if (isolatedPool) await isolatedPool.end();
      await dropTestDatabaseWhenIdle(pool, databaseName);
      await rm(migrationDirectory, { recursive: true, force: true });
    }
  });

  it("atomically upgrades legacy asset and archive data without changing authoritative imports or asset identities", async () => {
    const migrationName = "0053_durable_asset_portable_operations";
    const databaseName = `infinitequest_asset_portable_migration_${crypto.randomUUID().replaceAll("-", "")}`;
    const databaseUrlValue = new URL(databaseUrl!);
    databaseUrlValue.pathname = `/${databaseName}`;
    const migrationDirectory = await mkdtemp(join(tmpdir(), "infinitequest-asset-portable-migrations-"));
    const failingMigrationDirectory = await mkdtemp(join(tmpdir(), "infinitequest-asset-portable-rollback-"));
    let isolatedPool: DatabasePool | null = null;
    try {
      await pool.query(`CREATE DATABASE ${databaseName}`);
      for (const file of await readdir(resolve("database/migrations"))) {
        if (file.endsWith(".sql") && file < `${migrationName}.sql`) {
          await copyFile(join(resolve("database/migrations"), file), join(migrationDirectory, file));
        }
      }
      isolatedPool = createDatabasePool(databaseUrlValue.toString(), 2);
      await migrateDatabase(isolatedPool, migrationDirectory);

      const owner = await isolatedPool.query<{ id: string }>("SELECT id FROM users WHERE system_key = 'initial-owner'");
      const ownerUserId = owner.rows[0]!.id;
      const incompleteAsset = await isolatedPool.query<{ id: string }>(
        `INSERT INTO assets (
           owner_user_id, content_hash, storage_driver, storage_path, mime_type, byte_length, technical_metadata
         ) VALUES ($1, repeat('a',64), 'filesystem', 'legacy/incomplete.png', 'image/png', 12,
                   jsonb_build_object('format', 'png', 'backfillError', 'secret /srv/private/assets/incomplete.png'))
         RETURNING id`,
        [ownerUserId]
      );
      const completeAsset = await isolatedPool.query<{ id: string }>(
        `INSERT INTO assets (
           owner_user_id, content_hash, storage_driver, storage_path, mime_type, byte_length,
           pixel_width, pixel_height, technical_metadata
         ) VALUES ($1, repeat('b',64), 'filesystem', 'legacy/complete.png', 'image/png', 24, 10, 10,
                   jsonb_build_object('format', 'png'))
         RETURNING id`,
        [ownerUserId]
      );
      await isolatedPool.query(
        `INSERT INTO asset_derivatives (
           owner_user_id, source_asset_id, derivative_kind, transform_version, pixel_width, pixel_height,
           storage_driver, storage_path, mime_type, byte_length, content_hash
         ) VALUES ($1,$2,'thumbnail',1,10,10,'filesystem','legacy/complete.webp','image/webp',8,repeat('c',64))`,
        [ownerUserId, completeAsset.rows[0]!.id]
      );
      const importRecord = await isolatedPool.query<{ id: string }>(
        `INSERT INTO imports (owner_user_id, source_type, source_name, source_hash, status)
         VALUES ($1,'legacy_story','legacy.json',repeat('d',64),'completed') RETURNING id`,
        [ownerUserId]
      );
      const previewTokenHash = createHash("sha256").update("legacy-preview-token", "utf8").digest("hex");
      const legacyPreview = await isolatedPool.query<{ id: string; expires_at: Date }>(
        `INSERT INTO archive_previews (
           owner_user_id, archive_type, token_hash, content_fingerprint, destination_hash,
           application_version, staged_archive_path, source_name, preview, status, expires_at
         ) VALUES ($1,'campaign',$2,repeat('e',64),repeat('f',64),'legacy-v1','staging/legacy.zip',
                   'legacy.zip','{}'::jsonb,'previewed',date_trunc('second', now()) + interval '30 minutes')
         RETURNING id, expires_at`,
        [ownerUserId, previewTokenHash]
      );

      const migrationSql = await readFile(resolve(`database/migrations/${migrationName}.sql`), "utf8");
      await writeFile(
        join(failingMigrationDirectory, `${migrationName}.sql`),
        migrationSql.replace("\n-- Down Migration\n", "\nSELECT 1 / 0;\n\n-- Down Migration\n")
      );
      await expect(migrateDatabase(isolatedPool, failingMigrationDirectory)).rejects.toThrow();
      await expect(isolatedPool.query("SELECT to_regclass('public.asset_metadata_backfill_jobs') AS table_name"))
        .resolves.toMatchObject({ rows: [{ table_name: null }] });
      await expect(isolatedPool.query<{ technical_metadata: Record<string, unknown> }>(
        "SELECT technical_metadata FROM assets WHERE id = $1",
        [incompleteAsset.rows[0]!.id]
      )).resolves.toMatchObject({
        rows: [{ technical_metadata: { format: "png", backfillError: "secret /srv/private/assets/incomplete.png" } }]
      });
      await expect(isolatedPool.query("SELECT name FROM schema_migrations WHERE name = $1", [migrationName]))
        .resolves.toMatchObject({ rows: [] });

      await expect(migrateDatabase(isolatedPool, resolve("database/migrations"))).resolves.toEqual([
        migrationName,
        "0054_private_filesystem_authority",
        "0055_private_portable_repository_guards",
        "0056_private_filesystem_current_clock",
        "0057_finalized_asset_delivery_authority",
        "0058_secure_storage_lifecycle",
        "0059_secure_storage_target_intent",
        "0060_asset_publication_identities",
        "0061_portable_import_composition",
        "0062_portable_import_asset_publications",
        "0063_portable_legacy_story_asset_publications",
        "0064_normalized_asset_publication_requests",
        "0065_illustration_asset_publications",
        "0066_portable_normalized_asset_publications",
        "0067_asset_metadata_backfill_executor",
        "0068_portable_legacy_story_create_world",
        "0069_import_progress_status",
        "0070_turn_narration_corrections",
        "0071_world_share_links",
        "0072_chronicle_memory_chunks",
        "0073_chronicle_chunk_job_fencing",
        "0074_chronicle_retrieval_observability",
        "0075_chronicle_query_embedding_cache",
        "0076_chronicle_chunk_skip_reasons",
        "0077_chronicle_chunk_processed_signature",
        "0078_system_archive_jobs",
        "0079_resumable_system_archive_uploads"
      ]);

      const scrubbed = await isolatedPool.query<{ technical_metadata: Record<string, unknown> }>(
        "SELECT technical_metadata FROM assets WHERE id = $1",
        [incompleteAsset.rows[0]!.id]
      );
      expect(scrubbed.rows).toEqual([{
        technical_metadata: { format: "png", backfillError: "asset_metadata_unavailable" }
      }]);
      const jobs = await isolatedPool.query<{
        asset_id: string;
        owner_user_id: string;
        status: string;
        diagnostic_code: string | null;
      }>(
        `SELECT asset_id, owner_user_id, status, diagnostic_code
           FROM asset_metadata_backfill_jobs ORDER BY asset_id`
      );
      expect(jobs.rows).toEqual([{
        asset_id: incompleteAsset.rows[0]!.id,
        owner_user_id: ownerUserId,
        status: "recoverable",
        diagnostic_code: "asset_metadata_unavailable"
      }]);
      await expect(isolatedPool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM durable_filesystem_operations"
      )).resolves.toMatchObject({ rows: [{ count: "0" }] });

      const preserved = await isolatedPool.query<{
        asset_ids: string[];
        import_id: string;
        source_hash: string;
        import_count: string;
      }>(
        `SELECT ARRAY(SELECT id::text FROM assets ORDER BY id)::text[] AS asset_ids,
                min(id::text) FILTER (WHERE id = $1)::text AS import_id,
                min(source_hash) FILTER (WHERE id = $1) AS source_hash,
                count(*) FILTER (WHERE id = $1)::text AS import_count
           FROM imports`,
        [importRecord.rows[0]!.id]
      );
      expect(preserved.rows[0]).toEqual({
        asset_ids: [incompleteAsset.rows[0]!.id, completeAsset.rows[0]!.id].sort(),
        import_id: importRecord.rows[0]!.id,
        source_hash: "d".repeat(64),
        import_count: "1"
      });
      await expect(isolatedPool.query(
        `SELECT worlds.cover_asset_id, image_jobs.asset_id, segment_assets.asset_id
           FROM worlds
           FULL JOIN image_jobs ON false
           FULL JOIN turn_illustration_segment_assets segment_assets ON false
          LIMIT 0`
      )).resolves.toMatchObject({ rows: [] });

      const preview = await isolatedPool.query<{
        status: string;
        storage_security_state: string;
        secure_staged_input_id: string | null;
        expires_at: Date;
        legacy_drain_policy: string;
        staged_archive_path: string;
      }>(
        `SELECT status, storage_security_state, secure_staged_input_id, expires_at,
                legacy_drain_policy, staged_archive_path
           FROM archive_previews WHERE id = $1`,
        [legacyPreview.rows[0]!.id]
      );
      expect(preview.rows).toEqual([{
        status: "previewed",
        storage_security_state: "legacy_path_v1",
        secure_staged_input_id: null,
        expires_at: legacyPreview.rows[0]!.expires_at,
        legacy_drain_policy: "retain_until_secure_cleanup",
        staged_archive_path: "staging/legacy.zip"
      }]);

      await expect(migrateDatabase(isolatedPool, resolve("database/migrations"))).resolves.toEqual([]);
      await expect(isolatedPool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM asset_metadata_backfill_jobs WHERE asset_id = $1",
        [incompleteAsset.rows[0]!.id]
      )).resolves.toMatchObject({ rows: [{ count: "1" }] });
    } finally {
      if (isolatedPool) await isolatedPool.end();
      await dropTestDatabaseWhenIdle(pool, databaseName);
      await rm(migrationDirectory, { recursive: true, force: true });
      await rm(failingMigrationDirectory, { recursive: true, force: true });
    }
  });

  it("blocks maintenance migrations on an existing database until explicitly allowed", async () => {
    const sourceDirectory = resolve("database/migrations");
    const migrationDirectory = await mkdtemp(join(tmpdir(), "infinitequest-migrations-"));
    const migrationName = "9999_runner_policy.maintenance";
    const tableName = "migration_runner_policy_test";
    try {
      for (const file of await readdir(sourceDirectory)) {
        if (file.endsWith(".sql")) await copyFile(join(sourceDirectory, file), join(migrationDirectory, file));
      }
      await writeFile(join(migrationDirectory, `${migrationName}.sql`), `CREATE TABLE ${tableName} (id integer PRIMARY KEY);\n`);

      await expect(pendingDatabaseMigrations(pool, migrationDirectory)).resolves.toContain(migrationName);
      await expect(migrateDatabase(pool, migrationDirectory)).rejects.toThrow("Database maintenance migration required");
      await expect(pool.query("SELECT to_regclass($1) AS table_name", [`public.${tableName}`]))
        .resolves.toMatchObject({ rows: [{ table_name: null }] });

      await expect(migrateDatabase(pool, migrationDirectory, { allowMaintenanceMigrations: true }))
        .resolves.toEqual([migrationName]);
      await expect(pool.query("SELECT to_regclass($1) AS table_name", [`public.${tableName}`]))
        .resolves.toMatchObject({ rows: [{ table_name: tableName }] });
    } finally {
      await pool.query(`DROP TABLE IF EXISTS ${tableName}`);
      await pool.query("DELETE FROM schema_migrations WHERE name = $1", [migrationName]);
      await rm(migrationDirectory, { recursive: true, force: true });
    }
  });

  it("serializes concurrent migrators while worker-only replicas wait without applying migrations", async () => {
    const databaseName = `infinitequest_concurrent_migration_${crypto.randomUUID().replaceAll("-", "")}`;
    const migrationDirectory = await mkdtemp(join(tmpdir(), "infinitequest-concurrent-migrations-"));
    const migrationName = "0001_concurrent_replica";
    const gateLockId = 710_202_607;
    const firstMigratorName = "migration-test-migrator-one";
    const secondMigratorName = "migration-test-migrator-two";
    const workerName = "migration-test-worker-only";
    const connectionUrl = (applicationName: string): string => {
      const value = new URL(databaseUrl!);
      value.pathname = `/${databaseName}`;
      value.searchParams.set("application_name", applicationName);
      return value.toString();
    };
    let controlPool: DatabasePool | null = null;
    let firstMigratorPool: DatabasePool | null = null;
    let secondMigratorPool: DatabasePool | null = null;
    let workerPool: DatabasePool | null = null;
    let gateClient: PoolClient | null = null;
    let gateHeld = false;
    try {
      await pool.query(`CREATE DATABASE ${databaseName}`);
      await writeFile(
        join(migrationDirectory, `${migrationName}.sql`),
        `CREATE TABLE migration_application_audit (
           application_name text PRIMARY KEY,
           applications integer NOT NULL
         );
         INSERT INTO migration_application_audit (application_name, applications)
         VALUES (current_setting('application_name'), 1);
         SELECT pg_advisory_lock(${gateLockId});
         SELECT pg_advisory_unlock(${gateLockId});
        `
      );

      controlPool = createDatabasePool(connectionUrl("migration-test-control"), 2);
      firstMigratorPool = createDatabasePool(connectionUrl(firstMigratorName), 2);
      secondMigratorPool = createDatabasePool(connectionUrl(secondMigratorName), 2);
      workerPool = createDatabasePool(connectionUrl(workerName), 1);
      gateClient = await controlPool.connect();

      await expect(
        waitForDatabaseMigrations(workerPool, migrationDirectory, 100, 10)
      ).rejects.toThrow(`Pending: ${migrationName}`);
      await expect(controlPool.query("SELECT to_regclass('public.migration_application_audit') AS table_name"))
        .resolves.toMatchObject({ rows: [{ table_name: null }] });

      await gateClient!.query("SELECT pg_advisory_lock($1)", [gateLockId]);
      gateHeld = true;

      const firstMigration = migrateDatabase(firstMigratorPool, migrationDirectory);
      await expect.poll(async () => {
        const result = await controlPool!.query<{ waiting: string }>(
          `SELECT count(*)::text AS waiting
             FROM pg_locks locks
             JOIN pg_stat_activity activity ON activity.pid = locks.pid
            WHERE activity.datname = current_database()
              AND activity.application_name = $1
              AND locks.locktype = 'advisory'
              AND locks.granted = false
              AND locks.objid::bigint = $2`,
          [firstMigratorName, gateLockId]
        );
        return result.rows[0]?.waiting;
      }, { timeout: 5_000, interval: 10 }).toBe("1");

      const workerWaiting = waitForDatabaseMigrations(workerPool, migrationDirectory, 5_000, 10);
      const secondMigration = migrateDatabase(secondMigratorPool, migrationDirectory);
      await expect.poll(async () => {
        const result = await controlPool!.query<{ backends: string; waiting: string }>(
          `SELECT count(*)::text AS backends,
                  count(*) FILTER (WHERE wait_event = 'advisory')::text AS waiting
             FROM pg_stat_activity
            WHERE datname = current_database()
              AND application_name = $1`,
          [secondMigratorName]
        );
        return result.rows[0];
      }, { timeout: 5_000, interval: 10 }).toEqual({ backends: "1", waiting: "1" });

      await gateClient!.query("SELECT pg_advisory_unlock($1)", [gateLockId]);
      gateHeld = false;

      await expect(firstMigration).resolves.toEqual([migrationName]);
      await expect(secondMigration).resolves.toEqual([]);
      await expect(workerWaiting).resolves.toBeUndefined();
      await expect(controlPool.query(
        "SELECT application_name, applications FROM migration_application_audit"
      )).resolves.toMatchObject({
        rows: [{ application_name: firstMigratorName, applications: 1 }]
      });
      await expect(controlPool.query<{ name: string }>(
        "SELECT name FROM schema_migrations ORDER BY run_on, name"
      )).resolves.toMatchObject({ rows: [{ name: migrationName }] });
    } finally {
      if (gateHeld && gateClient) {
        await gateClient.query("SELECT pg_advisory_unlock($1)", [gateLockId]);
      }
      gateClient?.release();
      if (workerPool) await workerPool.end();
      if (secondMigratorPool) await secondMigratorPool.end();
      if (firstMigratorPool) await firstMigratorPool.end();
      if (controlPool) await controlPool.end();
      await dropTestDatabaseWhenIdle(pool, databaseName);
      await rm(migrationDirectory, { recursive: true, force: true });
    }
  });

  it("backfills existing campaigns with their pinned legacy character without changing campaign state", async () => {
    const databaseName = `infinitequest_character_migration_${crypto.randomUUID().replaceAll("-", "")}`;
    const databaseUrlValue = new URL(databaseUrl!);
    databaseUrlValue.pathname = `/${databaseName}`;
    const migrationDirectory = await mkdtemp(join(tmpdir(), "infinitequest-character-migrations-"));
    let isolatedPool: DatabasePool | null = null;
    try {
      await pool.query(`CREATE DATABASE ${databaseName}`);
      for (const file of await readdir(resolve("database/migrations"))) {
        if (file.endsWith(".sql") && file < "0017_campaign_characters.sql") {
          await copyFile(join(resolve("database/migrations"), file), join(migrationDirectory, file));
        }
      }
      isolatedPool = createDatabasePool(databaseUrlValue.toString(), 2);
      await migrateDatabase(isolatedPool, migrationDirectory);
      const owner = await isolatedPool.query<{ id: string }>("SELECT id FROM users WHERE system_key = 'initial-owner'");
      const world = await isolatedPool.query<{ id: string }>(
        "INSERT INTO worlds (owner_user_id, title) VALUES ($1, 'Existing World') RETURNING id",
        [owner.rows[0]!.id]
      );
      const version = await isolatedPool.query<{ id: string }>(
        `INSERT INTO world_versions (world_id, owner_user_id, version_number, content)
         VALUES ($1,$2,1,$3) RETURNING id`,
        [world.rows[0]!.id, owner.rows[0]!.id, JSON.stringify({
          schemaVersion: 2,
          world: { title: "Existing World", character: "Existing Hero\nKeeps the original campaign identity." },
          rpgStats: [{ id: "existing-stat", name: "Existing Stat", value: 55 }],
          defaultTriggers: [{ id: "existing-tracker", name: "Existing Tracker", value: "Existing" }]
        })]
      );
      const campaign = await isolatedPool.query<{ id: string }>(
        "INSERT INTO campaigns (owner_user_id, world_version_id, title) VALUES ($1,$2,'Existing Campaign') RETURNING id",
        [owner.rows[0]!.id, version.rows[0]!.id]
      );
      await migrateDatabase(isolatedPool, resolve("database/migrations"));
      const backfilled = await isolatedPool.query<any>(
        "SELECT selected_character_id, character_snapshot FROM campaigns WHERE id = $1",
        [campaign.rows[0]!.id]
      );
      expect(backfilled.rows[0]).toMatchObject({
        selected_character_id: "legacy-default",
        character_snapshot: {
          name: "Existing Hero",
          characterText: "Existing Hero\nKeeps the original campaign identity.",
          rpgStats: [{ id: "existing-stat" }],
          defaultTriggers: [{ id: "existing-tracker" }],
          legacy: true
        }
      });
      const profileState = await isolatedPool.query(
        "SELECT character_profile, character_profile_revision FROM campaigns WHERE id = $1",
        [campaign.rows[0]!.id]
      );
      expect(profileState.rows[0]).toEqual({ character_profile: null, character_profile_revision: 0 });
    } finally {
      if (isolatedPool) await isolatedPool.end();
      await dropTestDatabaseWhenIdle(pool, databaseName);
      await rm(migrationDirectory, { recursive: true, force: true });
    }
  });

  it("deterministically seeds structured campaign profiles from pre-0036 snapshots", async () => {
    const databaseName = `infinitequest_profile_migration_${crypto.randomUUID().replaceAll("-", "")}`;
    const databaseUrlValue = new URL(databaseUrl!);
    databaseUrlValue.pathname = `/${databaseName}`;
    const migrationDirectory = await mkdtemp(join(tmpdir(), "infinitequest-profile-migrations-"));
    let isolatedPool: DatabasePool | null = null;
    try {
      await pool.query(`CREATE DATABASE ${databaseName}`);
      for (const file of await readdir(resolve("database/migrations"))) {
        if (file.endsWith(".sql") && file < "0036_structured_character_profiles.sql") {
          await copyFile(join(resolve("database/migrations"), file), join(migrationDirectory, file));
        }
      }
      isolatedPool = createDatabasePool(databaseUrlValue.toString(), 2);
      await migrateDatabase(isolatedPool, migrationDirectory);
      const owner = await isolatedPool.query<{ id: string }>("SELECT id FROM users WHERE system_key = 'initial-owner'");
      const world = await isolatedPool.query<{ id: string }>(
        "INSERT INTO worlds (owner_user_id, title) VALUES ($1, 'Structured Existing World') RETURNING id",
        [owner.rows[0]!.id]
      );
      const characterSnapshot = {
        id: "mira",
        name: "Mira",
        characterText: "Original legacy source.",
        profile: {
          identity: { aliases: ["The Fox"], pronouns: "she/her" },
          story: { role: "Scout" },
          appearance: { hair: "black braid" },
          unclassifiedNotes: ""
        },
        importedExtension: { preserve: true }
      };
      const version = await isolatedPool.query<{ id: string }>(
        `INSERT INTO world_versions (world_id, owner_user_id, version_number, content)
         VALUES ($1,$2,1,$3) RETURNING id`,
        [world.rows[0]!.id, owner.rows[0]!.id, JSON.stringify({
          schemaVersion: 5,
          world: { title: "Structured Existing World" },
          playableCharacters: [characterSnapshot]
        })]
      );
      const campaign = await isolatedPool.query<{ id: string }>(
        `INSERT INTO campaigns (
           owner_user_id, world_version_id, title, selected_character_id, character_snapshot
         ) VALUES ($1,$2,'Structured Existing Campaign','mira',$3) RETURNING id`,
        [owner.rows[0]!.id, version.rows[0]!.id, JSON.stringify(characterSnapshot)]
      );

      await migrateDatabase(isolatedPool, resolve("database/migrations"));

      const migrated = await isolatedPool.query<any>(
        `SELECT character_snapshot, character_profile, character_profile_revision
           FROM campaigns WHERE id = $1`,
        [campaign.rows[0]!.id]
      );
      expect(migrated.rows[0]).toEqual({
        character_snapshot: characterSnapshot,
        character_profile: { name: "Mira", profile: characterSnapshot.profile },
        character_profile_revision: 1
      });
      const audit = await isolatedPool.query<any>(
        `SELECT revision, previous_profile, next_profile, edit_source
           FROM campaign_character_profile_edits WHERE campaign_id = $1`,
        [campaign.rows[0]!.id]
      );
      expect(audit.rows).toEqual([{
        revision: 1,
        previous_profile: null,
        next_profile: { name: "Mira", profile: characterSnapshot.profile },
        edit_source: "world_version_seed"
      }]);
    } finally {
      if (isolatedPool) await isolatedPool.end();
      await dropTestDatabaseWhenIdle(pool, databaseName);
      await rm(migrationDirectory, { recursive: true, force: true });
    }
  });

  it("adds isolated Chronicle chunks without changing accepted turns", async () => {
    const migrationName = "0072_chronicle_memory_chunks";
    const fencingMigrationName = "0073_chronicle_chunk_job_fencing";
    const databaseName = `infinitequest_chronicle_chunks_${crypto.randomUUID().replaceAll("-", "")}`;
    const databaseUrlValue = new URL(databaseUrl!);
    databaseUrlValue.pathname = `/${databaseName}`;
    const migrationDirectory = await mkdtemp(join(tmpdir(), "infinitequest-chronicle-chunks-"));
    let isolatedPool: DatabasePool | null = null;
    try {
      await pool.query(`CREATE DATABASE ${databaseName}`);
      for (const file of await readdir(resolve("database/migrations"))) {
        if (file.endsWith(".sql") && file <= "0071_world_share_links.sql") {
          await copyFile(join(resolve("database/migrations"), file), join(migrationDirectory, file));
        }
      }
      isolatedPool = createDatabasePool(databaseUrlValue.toString(), 2);
      await migrateDatabase(isolatedPool, migrationDirectory);

      const owner = await isolatedPool.query<{ id: string }>("SELECT id FROM users WHERE system_key = 'initial-owner'");
      const ownerUserId = owner.rows[0]!.id;
      const otherOwner = await isolatedPool.query<{ id: string }>(
        "INSERT INTO users (system_key, display_name) VALUES ('chunk-other-owner', 'Chunk Other Owner') RETURNING id"
      );
      const firstWorld = await isolatedPool.query<{ id: string }>(
        "INSERT INTO worlds (owner_user_id, title) VALUES ($1, 'Chunk World One') RETURNING id",
        [ownerUserId]
      );
      const secondWorld = await isolatedPool.query<{ id: string }>(
        "INSERT INTO worlds (owner_user_id, title) VALUES ($1, 'Chunk World Two') RETURNING id",
        [ownerUserId]
      );
      const firstVersion = await isolatedPool.query<{ id: string }>(
        `INSERT INTO world_versions (world_id, owner_user_id, version_number, content)
         VALUES ($1, $2, 1, '{"schemaVersion":2}'::jsonb) RETURNING id`,
        [firstWorld.rows[0]!.id, ownerUserId]
      );
      const secondVersion = await isolatedPool.query<{ id: string }>(
        `INSERT INTO world_versions (world_id, owner_user_id, version_number, content)
         VALUES ($1, $2, 1, '{"schemaVersion":2}'::jsonb) RETURNING id`,
        [secondWorld.rows[0]!.id, ownerUserId]
      );
      const firstCampaign = await isolatedPool.query<{ id: string }>(
        "INSERT INTO campaigns (owner_user_id, world_version_id, title) VALUES ($1, $2, 'Chunk Campaign One') RETURNING id",
        [ownerUserId, firstVersion.rows[0]!.id]
      );
      const secondCampaign = await isolatedPool.query<{ id: string }>(
        "INSERT INTO campaigns (owner_user_id, world_version_id, title) VALUES ($1, $2, 'Chunk Campaign Two') RETURNING id",
        [ownerUserId, secondVersion.rows[0]!.id]
      );
      await isolatedPool.query(
        `INSERT INTO turns (owner_user_id, campaign_id, turn_number, action, narration, choices, state_snapshot_private, model_metadata, import_metadata)
         VALUES ($1, $2, 1, 'Listen', 'The lantern flickers.', '[{"id":"choice-1"}]'::jsonb, '{"place":"bridge"}'::jsonb, '{"model":"fixture"}'::jsonb, '{"source":"fixture"}'::jsonb),
                ($1, $2, 2, 'Cross', 'The bridge holds.', '[]'::jsonb, '{"place":"far-bank"}'::jsonb, '{"model":"fixture"}'::jsonb, '{"source":"fixture"}'::jsonb)`,
        [ownerUserId, firstCampaign.rows[0]!.id]
      );
      const parentMemory = await isolatedPool.query<{ id: string }>(
        `INSERT INTO chronicle_memories (
           owner_user_id, campaign_id, world_version_id, memory_kind, ordinal, content, token_estimate, metadata
         ) VALUES ($1, $2, $3, 'campaign_summary', 2, 'The bridge is safe.', 5, '{"fixture":"parent"}'::jsonb)
         RETURNING id`,
        [ownerUserId, firstCampaign.rows[0]!.id, firstVersion.rows[0]!.id]
      );
      const embeddingProvider = await isolatedPool.query<{ id: string }>(
        `INSERT INTO provider_profiles (owner_user_id, name, provider_type, provider_role, base_url, default_model)
         VALUES ($1, 'Chunk embedding provider', 'openai_compatible', 'embedding', 'http://example.test', 'chunk-model')
         RETURNING id`,
        [ownerUserId]
      );
      await isolatedPool.query(
        `INSERT INTO campaign_memory_configs (
           campaign_id, owner_user_id, embedding_enabled, embedding_provider_profile_id, embedding_model
         ) VALUES ($1, $2, true, $3, 'chunk-model')`,
        [firstCampaign.rows[0]!.id, ownerUserId, embeddingProvider.rows[0]!.id]
      );
      const beforeTurns = await snapshotTurnRows(isolatedPool, ownerUserId, firstCampaign.rows[0]!.id);
      const beforeTurnColumns = await isolatedPool.query<{
        column_name: string;
        data_type: string;
        is_nullable: string;
        column_default: string | null;
      }>(
        `SELECT column_name, data_type, is_nullable, column_default
           FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'turns'
          ORDER BY ordinal_position`
      );
      const beforeConstraints = await isolatedPool.query<{
        table_name: string;
        constraint_name: string;
        definition: string;
      }>(
        `SELECT conrelid::regclass::text AS table_name, conname AS constraint_name, pg_get_constraintdef(oid) AS definition
           FROM pg_constraint
          WHERE conrelid IN ('chronicle_memories'::regclass, 'campaign_memory_configs'::regclass)
          ORDER BY conrelid::regclass::text, conname`
      );

      await copyFile(
        resolve(`database/migrations/${migrationName}.sql`),
        join(migrationDirectory, `${migrationName}.sql`)
      );
      await expect(migrateDatabase(isolatedPool, migrationDirectory)).resolves.toEqual([migrationName]);

      await expect(isolatedPool.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema='public' AND table_name='chronicle_chunk_jobs'
            AND column_name IN ('lease_token','work_signature')`
      )).resolves.toMatchObject({ rows: [] });
      const legacyClaim = await isolatedPool.query<{ id: string; work_version: string }>(
        `UPDATE chronicle_chunk_jobs
            SET status='running',lease_owner='legacy-worker',
                lease_expires_at=clock_timestamp()+interval '5 minutes',
                progress='{"processedParents":1}'::jsonb
          WHERE campaign_id=$1
          RETURNING id,work_version::text`,
        [firstCampaign.rows[0]!.id]
      );
      expect(legacyClaim.rows).toHaveLength(1);
      const parentContentHash = createHash("sha256")
        .update("The bridge is safe.", "utf8")
        .digest("hex");
      const expectedWorkSignature = createHash("sha256")
        .update(`${firstVersion.rows[0]!.id}\x1f2:${parentMemory.rows[0]!.id}:${parentContentHash}`, "utf8")
        .digest("hex");

      await copyFile(
        resolve(`database/migrations/${fencingMigrationName}.sql`),
        join(migrationDirectory, `${fencingMigrationName}.sql`)
      );
      await expect(migrateDatabase(isolatedPool, migrationDirectory)).resolves.toEqual([fencingMigrationName]);
      await expect(isolatedPool.query<{
        status: string;
        work_version: string;
        lease_owner: string | null;
        lease_token: string | null;
        lease_expires_at: string | null;
        progress: Record<string, unknown>;
        work_signature: string;
      }>(
        `SELECT status,work_version::text,lease_owner,lease_token,lease_expires_at,progress,work_signature
           FROM chronicle_chunk_jobs WHERE id=$1`,
        [legacyClaim.rows[0]!.id]
      )).resolves.toMatchObject({ rows: [{
        status: "queued",
        work_version: "2",
        lease_owner: null,
        lease_token: null,
        lease_expires_at: null,
        progress: {},
        work_signature: expectedWorkSignature
      }] });

      expect(await snapshotTurnRows(isolatedPool, ownerUserId, firstCampaign.rows[0]!.id)).toEqual(beforeTurns);
      await expect(isolatedPool.query(
        `SELECT column_name, data_type, is_nullable, column_default
           FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'turns'
          ORDER BY ordinal_position`
      )).resolves.toEqual(beforeTurnColumns);

      const retrievalColumns = await isolatedPool.query<{
        column_name: string;
        column_default: string | null;
        is_nullable: string;
      }>(
        `SELECT column_name, column_default, is_nullable
           FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'campaign_memory_configs'
            AND column_name IN ('retrieval_implementation', 'retrieval_shadow_enabled')
          ORDER BY column_name`
      );
      expect(retrievalColumns.rows).toEqual([
        {
          column_name: "retrieval_implementation",
          column_default: "'legacy_hybrid'::text",
          is_nullable: "NO"
        },
        {
          column_name: "retrieval_shadow_enabled",
          column_default: "false",
          is_nullable: "NO"
        }
      ]);
      await expect(isolatedPool.query<{ retrieval_implementation: string; retrieval_shadow_enabled: boolean }>(
        `UPDATE campaign_memory_configs
            SET retrieval_implementation = 'chunked_hybrid', retrieval_shadow_enabled = true
          WHERE campaign_id = $1
          RETURNING retrieval_implementation, retrieval_shadow_enabled`,
        [firstCampaign.rows[0]!.id]
      )).resolves.toMatchObject({
        rows: [{ retrieval_implementation: "chunked_hybrid", retrieval_shadow_enabled: true }]
      });
      await expect(isolatedPool.query(
        "UPDATE campaign_memory_configs SET retrieval_implementation = 'unsupported' WHERE campaign_id = $1",
        [firstCampaign.rows[0]!.id]
      )).rejects.toMatchObject({ code: "23514" });

      const generatedColumns = await isolatedPool.query<{
        table_name: string;
        column_name: string;
        data_type: string;
        is_generated: string;
      }>(
        `SELECT table_name, column_name, data_type, is_generated
           FROM information_schema.columns
          WHERE table_schema = 'public'
            AND (table_name = 'chronicle_memories' AND column_name = 'content_hash'
              OR table_name = 'chronicle_memory_chunks' AND column_name IN ('content_hash', 'search_document'))
          ORDER BY table_name, column_name`
      );
      expect(generatedColumns.rows).toEqual([
        { table_name: "chronicle_memories", column_name: "content_hash", data_type: "text", is_generated: "ALWAYS" },
        { table_name: "chronicle_memory_chunks", column_name: "content_hash", data_type: "text", is_generated: "ALWAYS" },
        { table_name: "chronicle_memory_chunks", column_name: "search_document", data_type: "tsvector", is_generated: "ALWAYS" }
      ]);
      await expect(isolatedPool.query<{ content_hash: string }>(
        "SELECT content_hash FROM chronicle_memories WHERE id = $1",
        [parentMemory.rows[0]!.id]
      )).resolves.toMatchObject({
        rows: [{ content_hash: createHash("sha256").update("The bridge is safe.", "utf8").digest("hex") }]
      });

      const chunkColumns = await isolatedPool.query<{ column_name: string; column_default: string | null; is_nullable: string }>(
        `SELECT column_name, column_default, is_nullable
           FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'chronicle_memory_chunks'
          ORDER BY ordinal_position`
      );
      expect(chunkColumns.rows.map((row) => row.column_name)).toEqual([
        "id", "owner_user_id", "campaign_id", "world_version_id", "parent_memory_id", "parent_content_hash",
        "chunking_protocol_version", "chunk_ordinal", "chunk_kind", "content", "content_hash", "source_start_offset",
        "source_end_offset", "token_estimate", "entities", "entity_ids", "metadata", "embedding", "embedding_status",
        "embedding_skip_reason", "embedding_provider_profile_id", "embedding_model", "embedding_dimensions",
        "embedding_protocol_version", "embedding_provider_fingerprint", "embedding_content_hash", "embedding_updated_at",
        "search_document", "created_at", "updated_at"
      ]);
      expect(chunkColumns.rows.find((row) => row.column_name === "embedding_status")).toMatchObject({
        column_default: "'pending'::text", is_nullable: "NO"
      });

      const jobColumns = await isolatedPool.query<{ column_name: string; column_default: string | null; is_nullable: string }>(
        `SELECT column_name, column_default, is_nullable
           FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'chronicle_chunk_jobs'
          ORDER BY ordinal_position`
      );
      expect(jobColumns.rows.map((row) => row.column_name)).toEqual([
        "id", "owner_user_id", "campaign_id", "job_type", "status", "attempts", "work_version", "lease_owner",
        "lease_expires_at", "progress", "error_message", "created_at", "updated_at", "completed_at", "lease_token",
        "work_signature"
      ]);
      expect(jobColumns.rows.find((row) => row.column_name === "job_type")).toMatchObject({
        column_default: "'index_memory_chunks_v2'::text", is_nullable: "NO"
      });
      expect(jobColumns.rows.find((row) => row.column_name === "work_signature")).toMatchObject({
        is_nullable: "NO"
      });

      const constraints = await isolatedPool.query<{ table_name: string; constraint_name: string; definition: string }>(
        `SELECT conrelid::regclass::text AS table_name, conname AS constraint_name, pg_get_constraintdef(oid) AS definition
           FROM pg_constraint
          WHERE conrelid IN (
            'chronicle_memories'::regclass,
            'campaign_memory_configs'::regclass,
            'chronicle_memory_chunks'::regclass,
            'chronicle_chunk_jobs'::regclass
          )
          ORDER BY conrelid::regclass::text, conname`
      );
      const beforeConstraintKeys = new Set(beforeConstraints.rows.map((row) => `${row.table_name}:${row.constraint_name}`));
      const migrationConstraints = constraints.rows.filter(
        (row) => !beforeConstraintKeys.has(`${row.table_name}:${row.constraint_name}`)
      );
      const expectedNotNullConstraints = (tableName: string, columns: readonly string[]) => columns.map((columnName) => ({
        table_name: tableName,
        constraint_name: `${tableName}_${columnName}_not_null`,
        definition: `NOT NULL ${columnName}`
      }));
      const expectedMigrationConstraints = [
        {
          table_name: "campaign_memory_configs",
          constraint_name: "campaign_memory_configs_retrieval_implementation_check",
          definition: "CHECK ((retrieval_implementation = ANY (ARRAY['legacy_hybrid'::text, 'chunked_hybrid'::text])))"
        },
        ...expectedNotNullConstraints("campaign_memory_configs", [
          "retrieval_implementation", "retrieval_shadow_enabled"
        ]),
        {
          table_name: "chronicle_memories",
          constraint_name: "chronicle_memories_chunk_parent_scope_unique",
          definition: "UNIQUE (id, owner_user_id, campaign_id, world_version_id)"
        },
        {
          table_name: "chronicle_memory_chunks",
          constraint_name: "chronicle_memory_chunks_campaign_id_owner_user_id_fkey",
          definition: "FOREIGN KEY (campaign_id, owner_user_id) REFERENCES campaigns(id, owner_user_id) ON DELETE CASCADE"
        },
        {
          table_name: "chronicle_memory_chunks",
          constraint_name: "chronicle_memory_chunks_check",
          definition: "CHECK ((source_end_offset >= source_start_offset))"
        },
        {
          table_name: "chronicle_memory_chunks",
          constraint_name: "chronicle_memory_chunks_chunk_kind_check",
          definition: "CHECK ((chunk_kind = ANY (ARRAY['turn_action'::text, 'turn_narration'::text, 'legacy_summary'::text, 'campaign_summary'::text, 'canonical_fact'::text, 'open_thread'::text])))"
        },
        {
          table_name: "chronicle_memory_chunks",
          constraint_name: "chronicle_memory_chunks_chunk_ordinal_check",
          definition: "CHECK ((chunk_ordinal >= 0))"
        },
        {
          table_name: "chronicle_memory_chunks",
          constraint_name: "chronicle_memory_chunks_chunking_protocol_version_check",
          definition: "CHECK (((length(btrim(chunking_protocol_version)) >= 1) AND (length(btrim(chunking_protocol_version)) <= 200)))"
        },
        {
          table_name: "chronicle_memory_chunks",
          constraint_name: "chronicle_memory_chunks_embedding_dimensions_check",
          definition: "CHECK ((embedding_dimensions > 0))"
        },
        {
          table_name: "chronicle_memory_chunks",
          constraint_name: "chronicle_memory_chunks_embedding_metadata_check",
          definition: "CHECK ((((embedding_status = 'pending'::text) AND (embedding IS NULL) AND (embedding_skip_reason IS NULL) AND (embedding_provider_profile_id IS NULL) AND (embedding_model IS NULL) AND (embedding_dimensions IS NULL) AND (embedding_protocol_version IS NULL) AND (embedding_provider_fingerprint IS NULL) AND (embedding_content_hash IS NULL) AND (embedding_updated_at IS NULL)) OR ((embedding_status = 'embedded'::text) AND (embedding IS NOT NULL) AND (embedding_skip_reason IS NULL) AND (embedding_provider_profile_id IS NOT NULL) AND (embedding_model IS NOT NULL) AND (embedding_dimensions IS NOT NULL) AND (embedding_protocol_version IS NOT NULL) AND (embedding_provider_fingerprint IS NOT NULL) AND (embedding_content_hash = content_hash) AND (embedding_updated_at IS NOT NULL)) OR ((embedding_status = 'skipped'::text) AND (embedding IS NULL) AND (embedding_skip_reason IS NOT NULL) AND (embedding_provider_profile_id IS NULL) AND (embedding_model IS NULL) AND (embedding_dimensions IS NULL) AND (embedding_protocol_version IS NULL) AND (embedding_provider_fingerprint IS NULL) AND (embedding_content_hash IS NULL) AND (embedding_updated_at IS NULL))))"
        },
        {
          table_name: "chronicle_memory_chunks",
          constraint_name: "chronicle_memory_chunks_embedding_provider_profile_id_owne_fkey",
          definition: "FOREIGN KEY (embedding_provider_profile_id, owner_user_id) REFERENCES provider_profiles(id, owner_user_id)"
        },
        {
          table_name: "chronicle_memory_chunks",
          constraint_name: "chronicle_memory_chunks_embedding_skip_reason_check",
          definition: "CHECK (((embedding_skip_reason IS NULL) OR ((length(btrim(embedding_skip_reason)) >= 1) AND (length(btrim(embedding_skip_reason)) <= 512))))"
        },
        {
          table_name: "chronicle_memory_chunks",
          constraint_name: "chronicle_memory_chunks_embedding_status_check",
          definition: "CHECK ((embedding_status = ANY (ARRAY['pending'::text, 'embedded'::text, 'skipped'::text])))"
        },
        {
          table_name: "chronicle_memory_chunks",
          constraint_name: "chronicle_memory_chunks_parent_content_hash_check",
          definition: "CHECK ((parent_content_hash ~ '^[0-9a-f]{64}$'::text))"
        },
        {
          table_name: "chronicle_memory_chunks",
          constraint_name: "chronicle_memory_chunks_parent_memory_id_owner_user_id_cam_fkey",
          definition: "FOREIGN KEY (parent_memory_id, owner_user_id, campaign_id, world_version_id) REFERENCES chronicle_memories(id, owner_user_id, campaign_id, world_version_id) ON DELETE CASCADE"
        },
        {
          table_name: "chronicle_memory_chunks",
          constraint_name: "chronicle_memory_chunks_parent_version_ordinal_key",
          definition: "UNIQUE (parent_memory_id, parent_content_hash, chunking_protocol_version, chunk_ordinal)"
        },
        {
          table_name: "chronicle_memory_chunks",
          constraint_name: "chronicle_memory_chunks_pkey",
          definition: "PRIMARY KEY (id)"
        },
        {
          table_name: "chronicle_memory_chunks",
          constraint_name: "chronicle_memory_chunks_source_start_offset_check",
          definition: "CHECK ((source_start_offset >= 0))"
        },
        {
          table_name: "chronicle_memory_chunks",
          constraint_name: "chronicle_memory_chunks_token_estimate_check",
          definition: "CHECK ((token_estimate >= 0))"
        },
        {
          table_name: "chronicle_memory_chunks",
          constraint_name: "chronicle_memory_chunks_world_version_id_owner_user_id_fkey",
          definition: "FOREIGN KEY (world_version_id, owner_user_id) REFERENCES world_versions(id, owner_user_id)"
        },
        ...expectedNotNullConstraints("chronicle_memory_chunks", [
          "id", "owner_user_id", "campaign_id", "world_version_id", "parent_memory_id", "parent_content_hash",
          "chunking_protocol_version", "chunk_ordinal", "chunk_kind", "content", "source_start_offset",
          "source_end_offset", "token_estimate", "entities", "entity_ids", "metadata", "embedding_status",
          "created_at", "updated_at"
        ]),
        {
          table_name: "chronicle_chunk_jobs",
          constraint_name: "chronicle_chunk_jobs_attempts_check",
          definition: "CHECK ((attempts >= 0))"
        },
        {
          table_name: "chronicle_chunk_jobs",
          constraint_name: "chronicle_chunk_jobs_campaign_id_owner_user_id_fkey",
          definition: "FOREIGN KEY (campaign_id, owner_user_id) REFERENCES campaigns(id, owner_user_id) ON DELETE CASCADE"
        },
        {
          table_name: "chronicle_chunk_jobs",
          constraint_name: "chronicle_chunk_jobs_completed_check",
          definition: "CHECK ((((status = 'completed'::text) AND (completed_at IS NOT NULL)) OR ((status <> 'completed'::text) AND (completed_at IS NULL))))"
        },
        {
          table_name: "chronicle_chunk_jobs",
          constraint_name: "chronicle_chunk_jobs_job_type_check",
          definition: "CHECK ((job_type = 'index_memory_chunks_v2'::text))"
        },
        {
          table_name: "chronicle_chunk_jobs",
          constraint_name: "chronicle_chunk_jobs_lease_check",
          definition: "CHECK ((((status = 'running'::text) AND (lease_owner IS NOT NULL) AND (btrim(lease_owner) <> ''::text) AND (lease_token IS NOT NULL) AND (lease_expires_at IS NOT NULL)) OR ((status <> 'running'::text) AND (lease_owner IS NULL) AND (lease_token IS NULL) AND (lease_expires_at IS NULL))))"
        },
        {
          table_name: "chronicle_chunk_jobs",
          constraint_name: "chronicle_chunk_jobs_pkey",
          definition: "PRIMARY KEY (id)"
        },
        {
          table_name: "chronicle_chunk_jobs",
          constraint_name: "chronicle_chunk_jobs_status_check",
          definition: "CHECK ((status = ANY (ARRAY['queued'::text, 'running'::text, 'completed'::text, 'failed'::text])))"
        },
        {
          table_name: "chronicle_chunk_jobs",
          constraint_name: "chronicle_chunk_jobs_work_signature_check",
          definition: "CHECK ((work_signature ~ '^[0-9a-f]{64}$'::text))"
        },
        {
          table_name: "chronicle_chunk_jobs",
          constraint_name: "chronicle_chunk_jobs_work_version_check",
          definition: "CHECK ((work_version > 0))"
        },
        ...expectedNotNullConstraints("chronicle_chunk_jobs", [
          "id", "owner_user_id", "campaign_id", "job_type", "status", "attempts", "work_version",
          "work_signature", "progress", "created_at", "updated_at"
        ])
      ];
      const compareConstraints = (left: { table_name: string; constraint_name: string }, right: { table_name: string; constraint_name: string }) =>
        `${left.table_name}:${left.constraint_name}`.localeCompare(`${right.table_name}:${right.constraint_name}`);
      expect([...migrationConstraints].sort(compareConstraints)).toEqual(
        [...expectedMigrationConstraints].sort(compareConstraints)
      );

      const indexes = await isolatedPool.query<{ indexname: string; indexdef: string }>(
        `SELECT indexname, indexdef
           FROM pg_indexes
          WHERE schemaname = 'public' AND tablename IN ('chronicle_memory_chunks', 'chronicle_chunk_jobs')
          ORDER BY indexname`
      );
      expect(indexes.rows.map((row) => row.indexname)).toEqual([
        "chronicle_chunk_jobs_claim_idx",
        "chronicle_chunk_jobs_one_active_campaign_idx",
        "chronicle_chunk_jobs_pkey",
        "chronicle_chunk_jobs_running_lease_idx",
        "chronicle_memory_chunks_embedded_scope_idx",
        "chronicle_memory_chunks_entity_ids_idx",
        "chronicle_memory_chunks_parent_version_ordinal_key",
        "chronicle_memory_chunks_pkey",
        "chronicle_memory_chunks_scope_idx",
        "chronicle_memory_chunks_search_idx"
      ]);
      expect(indexes.rows.find((row) => row.indexname === "chronicle_memory_chunks_search_idx")?.indexdef)
        .toMatch(/USING gin \(search_document\)/i);
      expect(indexes.rows.find((row) => row.indexname === "chronicle_memory_chunks_entity_ids_idx")?.indexdef)
        .toMatch(/USING gin \(entity_ids\)/i);
      expect(indexes.rows.find((row) => row.indexname === "chronicle_memory_chunks_embedded_scope_idx")?.indexdef)
        .toMatch(/WHERE \(embedding_status = 'embedded'::text\)/i);
      expect(indexes.rows.find((row) => row.indexname === "chronicle_chunk_jobs_one_active_campaign_idx")?.indexdef)
        .toMatch(/WHERE \(status = ANY \(ARRAY\['queued'::text, 'running'::text\]\)\)/i);

      const legacyJobConstraints = await isolatedPool.query<{ definition: string }>(
        "SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid = 'chronicle_jobs'::regclass"
      );
      expect(legacyJobConstraints.rows.map((row) => row.definition).join("\n")).not.toContain("index_memory_chunks_v2");

      const job = await isolatedPool.query<{ campaign_id: string; job_type: string; status: string }>(
        "SELECT campaign_id, job_type, status FROM chronicle_chunk_jobs WHERE campaign_id = $1",
        [firstCampaign.rows[0]!.id]
      );
      expect(job.rows).toEqual([{
        campaign_id: firstCampaign.rows[0]!.id,
        job_type: "index_memory_chunks_v2",
        status: "queued"
      }]);

      const validChunk = await isolatedPool.query<{ id: string; content_hash: string; search_document: string }>(
        `INSERT INTO chronicle_memory_chunks (
           owner_user_id, campaign_id, world_version_id, parent_memory_id, parent_content_hash,
           chunking_protocol_version, chunk_ordinal, chunk_kind, content, token_estimate
         ) VALUES ($1, $2, $3, $4, encode(digest('The bridge is safe.', 'sha256'), 'hex'),
                   'chronicle-chunk-v1', 0, 'campaign_summary', 'The bridge is safe.', 5)
         RETURNING id, content_hash, search_document::text`,
        [ownerUserId, firstCampaign.rows[0]!.id, firstVersion.rows[0]!.id, parentMemory.rows[0]!.id]
      );
      const invalidChunk = (ownerId: string, campaignId: string, worldVersionId: string) => isolatedPool!.query(
        `INSERT INTO chronicle_memory_chunks (
           owner_user_id, campaign_id, world_version_id, parent_memory_id, parent_content_hash,
           chunking_protocol_version, chunk_ordinal, chunk_kind, content, token_estimate
         ) VALUES ($1, $2, $3, $4, repeat('a', 64), 'chronicle-chunk-v1', 99, 'campaign_summary', 'mismatch', 1)`,
        [ownerId, campaignId, worldVersionId, parentMemory.rows[0]!.id]
      );
      await expect(invalidChunk(ownerUserId, secondCampaign.rows[0]!.id, firstVersion.rows[0]!.id)).rejects.toThrow();
      await expect(invalidChunk(ownerUserId, firstCampaign.rows[0]!.id, secondVersion.rows[0]!.id)).rejects.toThrow();
      await expect(invalidChunk(otherOwner.rows[0]!.id, firstCampaign.rows[0]!.id, firstVersion.rows[0]!.id)).rejects.toThrow();
      expect(validChunk.rows).toEqual([expect.objectContaining({
        content_hash: createHash("sha256").update("The bridge is safe.", "utf8").digest("hex"),
        search_document: expect.stringContaining("bridg")
      })]);

      await isolatedPool.query("DELETE FROM campaigns WHERE id = $1", [firstCampaign.rows[0]!.id]);
      await expect(isolatedPool.query<{ count: string }>("SELECT count(*)::text AS count FROM chronicle_memory_chunks"))
        .resolves.toMatchObject({ rows: [{ count: "0" }] });
      await expect(isolatedPool.query<{ count: string }>("SELECT count(*)::text AS count FROM chronicle_chunk_jobs"))
        .resolves.toMatchObject({ rows: [{ count: "0" }] });
    } finally {
      if (isolatedPool) await isolatedPool.end();
      await dropTestDatabaseWhenIdle(pool, databaseName);
      await rm(migrationDirectory, { recursive: true, force: true });
    }
  });

  it("upgrades an already-indexed Chronicle database without rewriting turns, chunks, or vectors", async () => {
    const databaseName = `infinitequest_chunk_upgrade_${crypto.randomUUID().replaceAll("-", "")}`;
    const databaseUrlValue = new URL(databaseUrl!);
    databaseUrlValue.pathname = `/${databaseName}`;
    const beforeDirectory = await mkdtemp(join(tmpdir(), "infinitequest-chunk-upgrade-before-"));
    let isolatedPool: DatabasePool | null = null;
    try {
      await pool.query(`CREATE DATABASE ${databaseName}`);
      // A database that predates the incremental-indexing work: migrated only through 0075.
      for (const file of await readdir(resolve("database/migrations"))) {
        if (file.endsWith(".sql") && file < "0076_") {
          await copyFile(join(resolve("database/migrations"), file), join(beforeDirectory, file));
        }
      }
      isolatedPool = createDatabasePool(databaseUrlValue.toString(), 2);
      await migrateDatabase(isolatedPool, beforeDirectory);
      const ownerUserId = (await isolatedPool.query<{ id: string }>(
        "SELECT id FROM users WHERE system_key = 'initial-owner'"
      )).rows[0]!.id;

      const world = await isolatedPool.query<{ id: string }>(
        "INSERT INTO worlds (owner_user_id,title) VALUES ($1,'Upgrade world') RETURNING id", [ownerUserId]
      );
      const version = await isolatedPool.query<{ id: string }>(
        `INSERT INTO world_versions (world_id,owner_user_id,version_number,content)
         VALUES ($1,$2,1,'{"world":{"title":"Upgrade world"}}'::jsonb) RETURNING id`,
        [world.rows[0]!.id, ownerUserId]
      );
      const campaign = await isolatedPool.query<{ id: string }>(
        `INSERT INTO campaigns (owner_user_id,world_version_id,title,active_turn_number)
         VALUES ($1,$2,'Upgrade campaign',1) RETURNING id`,
        [ownerUserId, version.rows[0]!.id]
      );
      await isolatedPool.query("INSERT INTO campaign_state (campaign_id,owner_user_id) VALUES ($1,$2)",
        [campaign.rows[0]!.id, ownerUserId]);
      const provider = await isolatedPool.query<{ id: string }>(
        `INSERT INTO provider_profiles (owner_user_id,name,provider_type,provider_role,base_url,default_model)
         VALUES ($1,'Upgrade provider','openai_compatible','embedding','http://upgrade.invalid/v1','embed-v1')
         RETURNING id`, [ownerUserId]
      );
      await isolatedPool.query(
        `INSERT INTO campaign_memory_configs
           (campaign_id,owner_user_id,embedding_enabled,embedding_provider_profile_id,embedding_model,
            retrieval_implementation)
         VALUES ($1,$2,true,$3,'embed-v1','chunked_hybrid')`,
        [campaign.rows[0]!.id, ownerUserId, provider.rows[0]!.id]
      );
      const turnRow = await isolatedPool.query<{ id: string }>(
        `INSERT INTO turns (owner_user_id,campaign_id,turn_number,action,narration,state_snapshot_private,accepted_at)
         VALUES ($1,$2,1,'Cross the bridge.','The bridge holds.','{}'::jsonb,now()) RETURNING id`,
        [ownerUserId, campaign.rows[0]!.id]
      );
      const parents = await isolatedPool.query<{ id: string; content_hash: string }>(
        `INSERT INTO chronicle_memories
           (owner_user_id,campaign_id,world_version_id,turn_id,memory_kind,ordinal,content,token_estimate)
         VALUES ($1,$2,$3,$4,'turn_fiction',1,'The bridge holds.',5),
                ($1,$2,$3,NULL,'campaign_summary',2,'The party crossed safely.',6)
         RETURNING id,content_hash`,
        [ownerUserId, campaign.rows[0]!.id, version.rows[0]!.id, turnRow.rows[0]!.id]
      );
      // Pre-upgrade chunk rows: one embedded, one skipped with the only reason the old writer
      // could produce. Both must remain valid under the closed-set constraint added by 0076.
      await isolatedPool.query(
        `INSERT INTO chronicle_memory_chunks
           (owner_user_id,campaign_id,world_version_id,parent_memory_id,parent_content_hash,
            chunking_protocol_version,chunk_ordinal,chunk_kind,content,token_estimate,
            embedding,embedding_status,embedding_provider_profile_id,embedding_model,embedding_dimensions,
            embedding_protocol_version,embedding_provider_fingerprint,embedding_content_hash,embedding_updated_at)
         VALUES ($1,$2,$3,$4,$5,'chronicle-chunk-v1',0,'turn_narration','The bridge holds.',5,
                 '[0.5,0.5]'::vector,'embedded',$6,'embed-v1',2,'chronicle-embedding-v1','legacy-fingerprint',$7,now())`,
        [ownerUserId, campaign.rows[0]!.id, version.rows[0]!.id, parents.rows[0]!.id,
          parents.rows[0]!.content_hash, provider.rows[0]!.id,
          createHash("sha256").update("The bridge holds.", "utf8").digest("hex")]
      );
      await isolatedPool.query(
        `INSERT INTO chronicle_memory_chunks
           (owner_user_id,campaign_id,world_version_id,parent_memory_id,parent_content_hash,
            chunking_protocol_version,chunk_ordinal,chunk_kind,content,token_estimate,
            embedding_status,embedding_skip_reason)
         VALUES ($1,$2,$3,$4,$5,'chronicle-chunk-v1',0,'campaign_summary','The party crossed safely.',6,
                 'skipped','chunk_embedding_skipped')`,
        [ownerUserId, campaign.rows[0]!.id, version.rows[0]!.id, parents.rows[1]!.id,
          parents.rows[1]!.content_hash]
      );
      await isolatedPool.query(
        `INSERT INTO chronicle_chunk_jobs (owner_user_id,campaign_id,status,completed_at,work_signature,progress)
         VALUES ($1,$2,'completed',now(),repeat('b',64),
                 '{"parentCursor":"2:x","processedParents":2,"embeddedChunks":1,"skippedChunks":1,
                   "totalParents":2,"capabilityFingerprint":"legacy-capability"}'::jsonb)`,
        [ownerUserId, campaign.rows[0]!.id]
      );

      const beforeTurns = await snapshotTurnRows(isolatedPool, ownerUserId, campaign.rows[0]!.id);
      const beforeChunks = await isolatedPool.query(
        `SELECT id,embedding::text AS embedding,embedding_status,embedding_skip_reason,content_hash
           FROM chronicle_memory_chunks ORDER BY chunk_kind`
      );

      const applied = await migrateDatabase(isolatedPool, resolve("database/migrations"));
      expect(applied).toEqual([
        "0076_chronicle_chunk_skip_reasons",
        "0077_chronicle_chunk_processed_signature",
        "0078_system_archive_jobs",
        "0079_resumable_system_archive_uploads"
      ]);

      // Accepted turns and every derived vector survive the upgrade untouched.
      expect(await snapshotTurnRows(isolatedPool, ownerUserId, campaign.rows[0]!.id)).toEqual(beforeTurns);
      expect(await isolatedPool.query(
        `SELECT id,embedding::text AS embedding,embedding_status,embedding_skip_reason,content_hash
           FROM chronicle_memory_chunks ORDER BY chunk_kind`
      )).toMatchObject({ rows: beforeChunks.rows });

      // The pre-existing skip reason is inside the closed set; anything else is now rejected.
      await expect(isolatedPool.query(
        "UPDATE chronicle_memory_chunks SET embedding_skip_reason='provider refused' WHERE embedding_status='skipped'"
      )).rejects.toMatchObject({ constraint: "chronicle_memory_chunks_embedding_skip_reason_check" });

      // Jobs carried over from before the upgrade have no recorded prefix, so the next enqueue
      // conservatively restarts them rather than trusting a cursor it cannot verify.
      expect(await isolatedPool.query<{ processed_signature: string | null }>(
        "SELECT processed_signature FROM chronicle_chunk_jobs"
      )).toMatchObject({ rows: [{ processed_signature: null }] });

      // The upgraded worker must recognise the pre-upgrade index as current. Enqueueing after
      // the upgrade creates a job that finds no parent needing work, so an existing campaign is
      // not re-embedded just because the code changed.
      const upgradedJob = await enqueuePostgresChronicleChunkIndex(isolatedPool, {
        ownerUserId, campaignId: campaign.rows[0]!.id, worldVersionId: version.rows[0]!.id
      });
      expect(upgradedJob).not.toBeNull();
      const claim = await createPostgresChronicleChunkJobStatePort(isolatedPool)
        .claimNext({ workerId: "upgrade-worker", leaseSeconds: 30 });
      if (!claim) throw new Error("upgraded chunk job was not claimed");
      const page = await createPostgresChronicleChunkParentPort(isolatedPool)
        .loadForClaim(claim, { batchLimit: 10, cursor: null });
      expect(page.parents).toEqual([]);
      expect(page.totalParents).toBe(2);

      // A job that was mid-flight at upgrade time carries an older capability fingerprint. That
      // is the one case that still costs a rebuild, and it clears vectors rather than silently
      // mixing embeddings produced under different capabilities.
      await isolatedPool.query(
        `UPDATE chronicle_chunk_jobs
            SET progress=jsonb_set(progress,'{capabilityFingerprint}','"legacy-capability"')
          WHERE id=$1`,
        [claim.jobId]
      );
      await expect(createPostgresChronicleChunkBatchPort(isolatedPool, { recordCost: async () => null })
        .prepareClaim(claim, { capabilityFingerprint: "upgraded-capability" })).resolves.toBe("requeued");
      expect(await isolatedPool.query<{ pending: string }>(
        "SELECT count(*)::text AS pending FROM chronicle_memory_chunks WHERE embedding_status='pending'"
      )).toMatchObject({ rows: [{ pending: "2" }] });
    } finally {
      if (isolatedPool) await isolatedPool.end();
      await dropTestDatabaseWhenIdle(pool, databaseName);
      await rm(beforeDirectory, { recursive: true, force: true });
    }
  });
});
