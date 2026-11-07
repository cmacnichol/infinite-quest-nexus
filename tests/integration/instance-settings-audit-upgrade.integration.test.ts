import { afterAll, beforeAll, expect, it } from "vitest";
import { mkdtemp, readdir, copyFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createDatabasePool, initialOwnerId, type DatabasePool } from "../../packages/database/src/pool.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";

let pool: DatabasePool;
let oldMigrations: string;
beforeAll(async () => {
  pool = createDatabasePool(process.env.TEST_DATABASE_URL!);
  oldMigrations = await mkdtemp(join(tmpdir(), "iq-settings-upgrade-"));
  for (const file of await readdir(resolve("database/migrations"))) {
    if (file < "0126_") await copyFile(resolve("database/migrations", file), join(oldMigrations, file));
  }
  await migrateDatabase(pool, oldMigrations);
});
afterAll(async () => { await pool?.end(); if (oldMigrations) await rm(oldMigrations, { recursive: true, force: true }); });

it("preserves existing operator and CLI evidence and enforces local attribution after upgrading", async () => {
  const user = await initialOwnerId(pool);
  const session = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  await pool.query(`INSERT INTO instance_settings_revisions(revision,snapshot,schema_version,actor_user_id,operator_session_id,kind,policy_digest) VALUES(1,'{}',1,$1,$2,'seed',$3)`, [user,session,"a".repeat(64)]);
  await pool.query(`INSERT INTO instance_settings_revisions(revision,previous_revision,snapshot,schema_version,actor_user_id,cli_reference,kind,policy_digest) VALUES(2,1,'{}',1,$1,'existing-cli','proposal',$2)`, [user,"a".repeat(64)]);
  await pool.query(`INSERT INTO instance_settings_events(kind,revision,actor_user_id,operator_session_id,reason_code) VALUES('seed',1,$1,$2,'seed_import')`, [user,session]);
  await pool.query(`INSERT INTO instance_settings_events(kind,revision,actor_user_id,cli_reference,reason_code) VALUES('proposal',2,$1,'existing-cli','operator_change')`, [user]);
  await migrateDatabase(pool, resolve("database/migrations"));
  const revisions = await pool.query("SELECT revision,operator_session_id,cli_reference,local_single_user FROM instance_settings_revisions ORDER BY revision");
  expect(revisions.rows).toEqual([{ revision:"1",operator_session_id:session,cli_reference:null,local_single_user:false },{ revision:"2",operator_session_id:null,cli_reference:"existing-cli",local_single_user:false }]);
  const events = await pool.query("SELECT revision,operator_session_id,cli_reference,local_single_user FROM instance_settings_events ORDER BY id");
  expect(events.rows).toEqual(revisions.rows);
  await pool.query(`INSERT INTO instance_settings_revisions(revision,previous_revision,snapshot,schema_version,actor_user_id,local_single_user,kind,policy_digest) VALUES(3,2,'{}',1,$1,true,'proposal',$2)`, [user,"a".repeat(64)]);
  await expect(pool.query(`INSERT INTO instance_settings_revisions(revision,previous_revision,snapshot,schema_version,actor_user_id,kind,policy_digest) VALUES(4,3,'{}',1,$1,'proposal',$2)`, [user,"a".repeat(64)])).rejects.toThrow();
  await expect(pool.query(`INSERT INTO instance_settings_revisions(revision,previous_revision,snapshot,schema_version,actor_user_id,cli_reference,local_single_user,kind,policy_digest) VALUES(4,3,'{}',1,$1,'forged',true,'proposal',$2)`, [user,"a".repeat(64)])).rejects.toThrow();
  await pool.query(`INSERT INTO instance_settings_events(kind,revision,actor_user_id,local_single_user,reason_code) VALUES('proposal',2,$1,true,'operator_change')`, [user]);
  await expect(pool.query(`INSERT INTO instance_settings_events(kind,revision,actor_user_id,reason_code) VALUES('proposal',2,$1,'operator_change')`, [user])).rejects.toThrow();
  await expect(pool.query(`INSERT INTO instance_settings_events(kind,revision,actor_user_id,operator_session_id,local_single_user,reason_code) VALUES('proposal',2,$1,$2,true,'operator_change')`, [user,session])).rejects.toThrow();
});
