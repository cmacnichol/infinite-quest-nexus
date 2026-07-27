import { createHash } from "node:crypto";
import { copyFile, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateDatabase, pendingDatabaseMigrations } from "../../packages/database/src/migrate.js";
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
      "preview", "status", "expires_at", "consumed_at", "result", "created_at", "updated_at"
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
