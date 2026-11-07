import { afterAll, beforeAll, expect, it } from "vitest";
import { resolve } from "node:path";
import { createDatabasePool, initialOwnerId, type DatabasePool } from "../../packages/database/src/pool.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { createInstanceSettingsRepository } from "../../packages/database/src/instance-settings-repository.js";
import { createSettingsActivationGuard } from "../../services/runtime/src/settings-activation.js";
import { exportRollback, transitionToEnvironment, verifyRollback } from "../../services/runtime/src/settings-rollback.js";
import { createSeedPolicy, exportSettingsSeed } from "../../services/runtime/src/settings-operator.js";
import { settingsDigest } from "../../services/runtime/src/instance-settings.js";
import { bootstrap } from "../helpers/instance-settings-runtime.js";

let pool: DatabasePool;
beforeAll(async () => {
  pool = createDatabasePool(process.env.TEST_DATABASE_URL!);
  await migrateDatabase(pool, resolve("database/migrations"));
}, 60000);
afterAll(async () => { await pool?.end(); });

it("guards pre-settings rollback, preserves every revision and fences stale or replayed maintenance evidence", async () => {
  const config = bootstrap(), seed = exportSettingsSeed(config);
  const policy = createSeedPolicy([seed], "00000000-0000-4000-8000-000000000001");
  const actor = { userId: await initialOwnerId(pool), cliReference: "fixture-maintenance" };
  const repo = createInstanceSettingsRepository(pool, { activationGuard: createSettingsActivationGuard(policy) });
  const request = { expectedActiveRevision: null, expectedRequestedRevision: "1", policyDigest: settingsDigest(policy), maintenanceReference: "fixture/shutdown-evidence", actor };
  await repo.seed({ snapshot: seed.snapshot, installationId: policy.installationId, policyDigest: request.policyDigest, seedDigest: seed.digest, actor });
  await repo.activate(request);
  const exported = await exportRollback(pool, config, policy);
  const bundle = { exported, seeds: [seed] };
  expect(verifyRollback(bundle, policy)).toEqual(exported);
  expect(() => verifyRollback({ ...bundle, exported: { ...exported, environment: { ...exported.environment, LOG_LEVEL: "trace" } } }, policy)).toThrow();
  const transition = (input: unknown = bundle) => transitionToEnvironment(pool, config, policy, input, request.maintenanceReference, actor);
  await pool.query("INSERT INTO api_admission_windows(owner_user_id,operation,window_started_at,window_expires_at,max_requests) VALUES($1,'provider',clock_timestamp(),clock_timestamp()+interval '1 second',3)", [actor.userId]);
  await expect(transition()).rejects.toThrow("settings_admission_windows_active");
  await pool.query("UPDATE api_admission_windows SET window_started_at=clock_timestamp()-interval '2 seconds',window_expires_at=clock_timestamp()-interval '1 second'");
  await expect(transition({ ...bundle, exported: { ...exported, activationEpoch: "99" } })).rejects.toThrow("settings_rollback_stale");
  await transition();
  expect(await repo.read()).toMatchObject({ mode: "environment", activeRevision: null, requestedRevision: "1", activationEpoch: "2" });
  expect((await pool.query("SELECT reason_code FROM instance_settings_events ORDER BY id DESC LIMIT 1")).rows[0].reason_code).toBe("maintenance_environment");
  await expect(repo.activate(request)).rejects.toThrow("settings_activation_epoch_mismatch");
  await repo.activate({ ...request, expectedEpoch: "2" });
  await expect(transition()).rejects.toThrow("settings_rollback_stale");
  expect((await repo.read()).activeRevision).toBe("1");
});
