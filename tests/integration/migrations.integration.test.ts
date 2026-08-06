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
import { dropTestDatabaseWhenIdle } from "./database-test-helpers.js";

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
    expect(definitions).toMatch(/portable_import_operations: FOREIGN KEY \(import_id, owner_user_id\).*imports\(id, owner_user_id\)/i);

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

      await expect(migrateDatabase(isolatedPool, resolve("database/migrations"))).resolves.toEqual([migrationName]);

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
        legacy_drain_policy: "serve_until_expiry_then_identity_cleanup",
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
});
