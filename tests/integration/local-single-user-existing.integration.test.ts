import { afterAll, beforeAll, expect, it } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createDatabasePool, initialOwnerId, type DatabasePool } from "../../packages/database/src/pool.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { createInstanceSettingsRepository } from "../../packages/database/src/instance-settings-repository.js";
import { createSeedPolicy, exportSettingsSeed } from "../../services/runtime/src/settings-operator.js";
import { createSettingsActivationGuard } from "../../services/runtime/src/settings-activation.js";
import { initializeLocalSingleUserSettings } from "../../services/runtime/src/local-single-user-settings.js";
import { settingsDigest } from "../../services/runtime/src/instance-settings.js";
import { bootstrap } from "../helpers/instance-settings-runtime.js";
let pool: DatabasePool;
beforeAll(async () => { pool = createDatabasePool(process.env.TEST_DATABASE_URL!); await migrateDatabase(pool, resolve("database/migrations")); }, 60000);
afterAll(async () => { await pool?.end(); });
it("preserves an externally seeded installation only with its matching mounted policy", async () => {
  const config = { ...bootstrap(), role: "all" as const, instanceSettingsAccessMode: "local-single-user" as const };
  const seed = exportSettingsSeed(config);
  const policy = createSeedPolicy([seed], "00000000-0000-4000-8000-000000000001");
  const actor = { userId: await initialOwnerId(pool), cliReference: "existing-operator" };
  const repo = createInstanceSettingsRepository(pool, { activationGuard: createSettingsActivationGuard(policy) });
  await repo.seed({ installationId: policy.installationId, snapshot: seed.snapshot, seedDigest: seed.digest, policyDigest: settingsDigest(policy), actor });
  await repo.activate({ expectedActiveRevision: null, expectedRequestedRevision: "1", policyDigest: settingsDigest(policy), maintenanceReference: "existing/maintenance", actor });
  await repo.propose({ expectedRequestedRevision: "1", snapshot: { ...seed.snapshot, logLevel: "debug" }, policyDigest: settingsDigest(policy), actor, reason: "test" });
  await expect(initializeLocalSingleUserSettings(pool, config)).rejects.toThrow("settings_local_existing_installation");
  const directory = await mkdtemp(join(tmpdir(), "nexus-policy-"));
  try {
    const file = join(directory, "policy.json");
    await writeFile(file, JSON.stringify({ ...policy, installationId: "00000000-0000-4000-8000-000000000002" }));
    await expect(initializeLocalSingleUserSettings(pool, { ...config, instanceSettingsPolicyFile: file })).rejects.toThrow("settings_policy_mismatch");
    await writeFile(file, JSON.stringify(policy));
    expect(await initializeLocalSingleUserSettings(pool, { ...config, instanceSettingsPolicyFile: file })).toEqual(policy);
    expect(await repo.read()).toMatchObject({ activeRevision: "1", requestedRevision: "2", requested: { logLevel: "debug" } });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
