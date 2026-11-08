import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabasePool, initialOwnerId, withTransaction, type DatabasePool } from "../../packages/database/src/pool.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { createInstanceSettingsRepository } from "../../packages/database/src/instance-settings-repository.js";
import { createSettingsActivationGuard } from "../../services/runtime/src/settings-activation.js";
import { settingsDigest } from "../../services/runtime/src/instance-settings.js";
import { settingsFixture } from "../fixtures/instance-settings.js";
import { runtimePolicy } from "../helpers/instance-settings-runtime.js";
import { runDispatchRecovery } from "../helpers/recover-cancelled-dispatches.js";

describe("cancelled dispatch recovery and settings activation", () => {
  let pool: DatabasePool;
  beforeAll(async () => {
    pool = createDatabasePool(process.env.TEST_DATABASE_URL!);
    await migrateDatabase(pool, resolve("database/migrations"));
  }, 60000);
  afterAll(async () => { await pool?.end(); });

  it("preserves reviewed story and cast dispatches and blocks activation when either receipt becomes stale", async () => {
    const owner = await initialOwnerId(pool);
    const world = randomUUID(), version = randomUUID(), campaign = randomUUID(), turn = randomUUID(), profile = randomUUID();
    await pool.query("INSERT INTO worlds(id,owner_user_id,title) VALUES($1,$2,'Recovery fixture')", [world, owner]);
    await pool.query("INSERT INTO world_versions(id,world_id,owner_user_id,version_number,content) VALUES($1,$2,$3,1,'{}')", [version, world, owner]);
    await pool.query("INSERT INTO campaigns(id,owner_user_id,world_version_id,title,active_turn_number) VALUES($1,$2,$3,'Recovery fixture',1)", [campaign, owner, version]);
    await pool.query("INSERT INTO turns(id,owner_user_id,campaign_id,turn_number,narration) VALUES($1,$2,$3,1,'A door opens.')", [turn, owner, campaign]);
    await pool.query("INSERT INTO provider_profiles(id,owner_user_id,name,provider_type,base_url) VALUES($1,$2,$3,'openrouter','https://fixture.invalid')", [profile, owner, randomUUID()]);
    const story = (await pool.query(`INSERT INTO generation_jobs(owner_user_id,campaign_id,provider_profile_id,idempotency_key,expected_turn_number,action,status)
      VALUES($1,$2,$3,$4,2,'Continue','cancelled') RETURNING id`, [owner, campaign, profile, randomUUID()])).rows[0].id;
    const cast = (await pool.query(`INSERT INTO campaign_cast_discovery_jobs(owner_user_id,campaign_id,turn_id,turn_number,narration_revision,timeline_revision,source_hash,protocol,source,chunks,execution_snapshot,status)
      VALUES($1,$2,$3,1,0,0,$4,'cast-discovery-v1','{}','[]','{}','cancelled') RETURNING id`, [owner, campaign, turn, "a".repeat(64)])).rows[0].id;
    for (const [kind, parent] of [["story", story], ["cast_discovery", cast]] as const) {
      const reservation = kind === "story" ? { generationJobId: parent } : { jobId: parent };
      await pool.query(`INSERT INTO prepared_text_physical_attempts(owner_user_id,logical_kind,reservation_key,logical_reservation,plan_hash,candidate_ordinal,requested_model,provider_policy,request_payload_hash,request_body,status,dispatched_at)
        VALUES($1,$2,$3,$4,$5,0,'fixture','{}',$5,'{}','dispatched',clock_timestamp())`, [owner, kind, randomUUID(), JSON.stringify(reservation), "a".repeat(64)]);
    }
    const readLedger = () => withTransaction(pool, async client => {
      await client.query("SET LOCAL TIME ZONE 'UTC'");
      return (await client.query<{ id: string; kind: "story" | "cast_discovery"; fingerprint: string; ledger: string }>(`
        SELECT id, logical_kind AS kind, md5(to_jsonb(a)::text) AS fingerprint, to_jsonb(a)::text AS ledger
        FROM prepared_text_physical_attempts a ORDER BY logical_kind
      `)).rows;
    });
    const before = await readLedger();
    expect(before.map(row => row.kind)).toEqual(["cast_discovery", "story"]);
    const manifest = before.map(row => ({
      attempt_id: row.id,
      parent_job: row.kind === "story" ? story : cast,
      kind: row.kind,
      parent_status: "cancelled",
      row_fingerprint: row.fingerprint
    }));
    const policy = runtimePolicy(), digest = settingsDigest(policy), snapshot = settingsFixture();
    const repository = createInstanceSettingsRepository(pool, { activationGuard: createSettingsActivationGuard(policy) });
    const actor = { userId: owner, cliReference: "recovery-test" };
    await repository.seed({ installationId: policy.installationId, snapshot, policyDigest: digest, seedDigest: settingsDigest(snapshot), actor });
    const request = { expectedActiveRevision: null, expectedRequestedRevision: "1", policyDigest: digest, maintenanceReference: "test/recovery", actor };
    await expect(repository.activate(request)).rejects.toThrow("settings_active_invocations");
    runDispatchRecovery(manifest, "test/recovery");
    expect((await pool.query("SELECT count(*)::int AS n FROM cancelled_dispatch_recoveries")).rows[0].n).toBe(2);
    await repository.activate(request);
    expect(await readLedger()).toEqual(before);
    await repository.propose({ expectedRequestedRevision: "1", snapshot: { ...snapshot, logLevel: "debug" }, policyDigest: digest, actor, reason: "recovery-check" });
    const next = { ...request, expectedActiveRevision: "1", expectedRequestedRevision: "2" };
    for (const item of manifest) {
      await pool.query("UPDATE prepared_text_physical_attempts SET request_body='changed' WHERE id=$1", [item.attempt_id]);
      await expect(repository.activate(next)).rejects.toThrow("settings_active_invocations");
      await pool.query("UPDATE prepared_text_physical_attempts SET request_body='{}' WHERE id=$1", [item.attempt_id]);
    }
    for (const [table, id] of [["generation_jobs", story], ["campaign_cast_discovery_jobs", cast]] as const) {
      await pool.query(`UPDATE ${table} SET status='failed' WHERE id=$1`, [id]);
      await expect(repository.activate(next)).rejects.toThrow("settings_active_invocations");
      await pool.query(`UPDATE ${table} SET status='cancelled' WHERE id=$1`, [id]);
    }
    await repository.activate(next);
    expect((await repository.read()).activeRevision).toBe("2");
    expect(await readLedger()).toEqual(before);
  });
});
