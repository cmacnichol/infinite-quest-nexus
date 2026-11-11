import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, copyFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createDatabasePool, initialOwnerId, type DatabasePool } from "../../packages/database/src/pool.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { createInstanceSettingsRepository } from "../../packages/database/src/instance-settings-repository.js";
import { createLocalSingleUserPolicy, createSeedPolicy, exportSettingsSeed } from "../../services/runtime/src/settings-operator.js";
import { loadLocalSingleUserPolicy } from "../../services/runtime/src/local-single-user-settings.js";
import { loadActiveRuntimeSettings, loadDeploymentSettingsPolicy, projectRuntimeSettings, settingsDigest } from "../../services/runtime/src/instance-settings.js";
import { createSettingsActivationGuard } from "../../services/runtime/src/settings-activation.js";
import { buildServer } from "../../services/api/src/server.js";
import { createApiCampaignCastApplication } from "../../services/runtime/src/campaign-cast-composition.js";
import { inertStorageServerOptions } from "../helpers/build-server-options.js";
import { bootstrap } from "../helpers/instance-settings-runtime.js";

let pool: DatabasePool;
let oldMigrations: string;
beforeAll(async () => {
  pool = createDatabasePool(process.env.TEST_DATABASE_URL!);
  oldMigrations = await mkdtemp(join(tmpdir(), "iq-character-settings-upgrade-"));
  for (const file of await readdir(resolve("database/migrations"))) {
    if (file < "0129_") await copyFile(resolve("database/migrations", file), join(oldMigrations, file));
  }
  await migrateDatabase(pool, oldMigrations);
});
afterAll(async () => { await pool?.end(); if (oldMigrations) await rm(oldMigrations, { recursive: true, force: true }); });

it("upgrades an active local v1 seed and keeps character preferences across restart and an unrelated edit", async () => {
  const config = { ...bootstrap(), role: "all" as const, instanceSettingsAccessMode: "local-single-user" as const, castEditingEnabled: true, castDiscoveryEnabled: false, castContextEnabled: false };
  const seed = exportSettingsSeed(config);
  const snapshot = { ...seed.snapshot } as Partial<typeof seed.snapshot>;
  delete snapshot.castLifecycleEnabled;
  delete snapshot.castPresetsEnabled;
  delete snapshot.castContextWithoutDiscoveryEnabled;
  const installationId = randomUUID();
  const oldPolicy = createLocalSingleUserPolicy(seed.snapshot, installationId, config.databaseMaxConnections);
  oldPolicy.version = 1;
  delete oldPolicy.featureGates.castLifecycleEnabled;
  delete oldPolicy.featureGates.castPresetsEnabled;
  delete oldPolicy.featureGates.castContextWithoutDiscoveryEnabled;
  oldPolicy.featureGates.castContextEnabled = config.castContextEnabled;
  oldPolicy.featureGates.castEditingEnabled = config.castEditingEnabled;
  const policyDigest = settingsDigest(oldPolicy);
  const owner = await initialOwnerId(pool);
  await pool.query(`INSERT INTO instance_settings_revisions(revision,snapshot,schema_version,actor_user_id,local_single_user,kind,policy_digest) VALUES(1,$1,1,$2,true,'seed',$3)`, [snapshot, owner, policyDigest]);
  await pool.query(`UPDATE instance_settings_state SET installation_id=$1,active_revision=1,requested_revision=1,mode='database',activation_epoch=1,seed_digest=$2`, [installationId, settingsDigest(snapshot)]);
  await pool.query(`INSERT INTO instance_settings_events(kind,revision,actor_user_id,local_single_user,reason_code) VALUES('seed',1,$1,true,'seed_import')`, [owner]);
  await migrateDatabase(pool, resolve("database/migrations"));
  const policy = await loadLocalSingleUserPolicy(pool, config);
  expect(settingsDigest(policy)).toBe(policyDigest);
  const actor = { userId: owner, localSingleUser: true as const };
  const repository = createInstanceSettingsRepository(pool, { activationGuard: createSettingsActivationGuard(policy, { implicitLocal: true }) });
  const before = await repository.read();
  expect(before.active).toMatchObject({ castPresetsEnabled: false, castContextWithoutDiscoveryEnabled: false });
  const { createInstanceSettingsHttpComposition } = await import("../../services/api/src/instance-settings-composition.js");
  const running = await loadActiveRuntimeSettings(pool, config, JSON.parse(JSON.stringify(policy)));
  expect(running.config.castLifecycleEnabled).toBe(false);
  const previouslyEnabled = await loadActiveRuntimeSettings(pool, { ...config, castLifecycleEnabled: true }, policy);
  expect(previouslyEnabled.config.castLifecycleEnabled).toBe(true);
  const ui = createInstanceSettingsHttpComposition(pool, config, running.config, { loadDeploymentSettingsPolicy, projectRuntimeSettings, settingsDigest, localPolicy: JSON.parse(JSON.stringify(policy)) });
  const view = await ui.settings.patch({ expectedRequestedRevision: "1", changes: { castLifecycleEnabled: true, castPresetsEnabled: true, castContextWithoutDiscoveryEnabled: true }, reason: "Enable character options" }, actor);
  expect(view.requested).toMatchObject({ castLifecycleEnabled: true, castPresetsEnabled: true, castContextWithoutDiscoveryEnabled: true });
  expect(view.active.castLifecycleEnabled).toBe(false);
  await repository.activate({ expectedActiveRevision: "1", expectedRequestedRevision: "2", policyDigest, maintenanceReference: "upgrade-test", actor });
  const restarted = await loadActiveRuntimeSettings(pool, config, policy);
  expect(restarted.config).toMatchObject({ castLifecycleEnabled: true, castPresetsEnabled: true, castContextWithoutDiscoveryEnabled: true, castDiscoveryEnabled: false });
  const app = await buildServer({ ...inertStorageServerOptions({ pool, config: restarted.config }),
    cast: createApiCampaignCastApplication(pool, restarted.config) });
  try {
    const world = randomUUID(), version = randomUUID(), campaign = randomUUID();
    await pool.query("INSERT INTO worlds(id,owner_user_id,title) VALUES($1,$2,'Settings fixture')", [world, owner]);
    await pool.query("INSERT INTO world_versions(id,world_id,owner_user_id,version_number,content) VALUES($1,$2,$3,1,'{}')", [version, world, owner]);
    await pool.query("INSERT INTO campaigns(id,owner_user_id,world_version_id,title) VALUES($1,$2,$3,'Merge fixture')", [campaign, owner, version]);
    const url = `/api/v1/campaigns/${campaign}/cast`;
    const roster = await app.inject({ method: "GET", url });
    expect(roster.json().capabilities.castLifecycle).toBe(true);
    const create = async (name: string, revision: number) => {
      const response = await app.inject({ method: "POST", url, payload: { expectedCastRevision: revision,
        expectedBoundary: roster.json().boundary, idempotencyKey: randomUUID(), name, aliases: [], profile: {} } });
      expect(response.statusCode).toBe(201);
      return response.json();
    };
    const target = await create("Guide", roster.json().revision);
    const source = await create("Traveler", target.revision);
    const merged = await app.inject({ method: "POST", url: url + "/" + target.character.id + "/merge",
      payload: { sourceCharacterId: source.character.id, expectedCharacterRevision: target.character.revision,
        expectedSourceCharacterRevision: source.character.revision, expectedCastRevision: source.revision,
        expectedBoundary: source.boundary, reviewedAliases: [], choices: {}, idempotencyKey: randomUUID() } });
    expect(merged.statusCode).toBe(200);
    expect(merged.json().character.id).toBe(target.character.id);
  } finally { await app.close(); }
  const current = await repository.read();
  await repository.propose({ expectedRequestedRevision: "2", snapshot: { ...current.requested!, logLevel: "debug" }, actor, reason: "Unrelated change" });
  const saved = await repository.read();
  expect(saved.requested).toMatchObject({ castLifecycleEnabled: true, castPresetsEnabled: true, castContextWithoutDiscoveryEnabled: true, logLevel: "debug" });
  const events = await pool.query("SELECT changed_keys FROM instance_settings_events WHERE kind='proposal' ORDER BY id");
  expect(events.rows.map(row => row.changed_keys)).toEqual([["castLifecycleEnabled", "castPresetsEnabled", "castContextWithoutDiscoveryEnabled"], ["logLevel"]]);
});


it("upgrades a managed v1 policy only after explicit v2 reissue and matching environment gates", async () => {
  const databaseName = `iq_managed_upgrade_${randomUUID().replaceAll("-", "")}`;
  await pool.query(`CREATE DATABASE ${databaseName}`);
  const url = new URL(process.env.TEST_DATABASE_URL!); url.pathname = `/${databaseName}`;
  const managed = createDatabasePool(url.toString());
  try {
    await migrateDatabase(managed, oldMigrations);
    const config = { ...bootstrap(), role: "all" as const, castEditingEnabled: true, castDiscoveryEnabled: false,
      castPresetsEnabled: false, castContextWithoutDiscoveryEnabled: false };
    const exported = exportSettingsSeed(config), snapshot = { ...exported.snapshot } as Partial<typeof exported.snapshot>;
    delete snapshot.castLifecycleEnabled; delete snapshot.castPresetsEnabled; delete snapshot.castContextWithoutDiscoveryEnabled;
    const installationId = randomUUID(), oldSeed = { ...exported, snapshot, digest: settingsDigest(snapshot) };
    const oldPolicy = createSeedPolicy([oldSeed], installationId);
    oldPolicy.version = 1; delete oldPolicy.featureGates.castLifecycleEnabled; delete oldPolicy.featureGates.castPresetsEnabled; delete oldPolicy.featureGates.castContextWithoutDiscoveryEnabled;
    const oldDigest = settingsDigest(oldPolicy), owner = await initialOwnerId(managed);
    await managed.query(`INSERT INTO instance_settings_revisions(revision,snapshot,schema_version,actor_user_id,local_single_user,cli_reference,kind,policy_digest) VALUES(1,$1,1,$2,false,'upgrade-test','seed',$3)`, [snapshot, owner, oldDigest]);
    await managed.query(`UPDATE instance_settings_state SET installation_id=$1,active_revision=1,requested_revision=1,mode='database',activation_epoch=1,seed_digest=$2`, [installationId, settingsDigest(snapshot)]);
    await managed.query(`INSERT INTO instance_settings_events(kind,revision,actor_user_id,cli_reference,reason_code) VALUES('seed',1,$1,'upgrade-test','seed_import')`, [owner]);
    await migrateDatabase(managed, resolve("database/migrations"));
    const oldRunning = await loadActiveRuntimeSettings(managed, config, oldPolicy);
    const environmentEnabled = await loadActiveRuntimeSettings(managed, { ...config, castLifecycleEnabled: true }, oldPolicy);
    expect(environmentEnabled.config.castLifecycleEnabled).toBe(true);
    expect(oldRunning.policyDigest).toBe(oldDigest);
    expect(oldRunning.config).toMatchObject({ castPresetsEnabled: false, castContextWithoutDiscoveryEnabled: false });
    const reissued = { ...oldPolicy, version: 2 as const, featureGates: { ...oldPolicy.featureGates, castPresetsEnabled: true, castContextWithoutDiscoveryEnabled: true } };
    const newDigest = settingsDigest(reissued), actor = { userId: owner, cliReference: "upgrade-test" };
    const repository = createInstanceSettingsRepository(managed, { activationGuard: createSettingsActivationGuard(reissued) });
    const state = await repository.read();
    await repository.propose({ expectedRequestedRevision: "1", snapshot: { ...state.requested!, castPresetsEnabled: true, castContextWithoutDiscoveryEnabled: true },
      policyDigest: newDigest, actor, reason: "Review updated deployment gates" });
    await repository.activate({ expectedActiveRevision: "1", expectedRequestedRevision: "2", policyDigest: newDigest, maintenanceReference: "managed-reissue", actor });
    await expect(loadActiveRuntimeSettings(managed, config, reissued)).rejects.toThrow("settings_deployment_divergence");
    const allowed = await loadActiveRuntimeSettings(managed, { ...config, castPresetsEnabled: true, castContextWithoutDiscoveryEnabled: true }, reissued);
    expect(allowed.policyDigest).toBe(newDigest);
    expect(allowed.config).toMatchObject({ castPresetsEnabled: true, castContextWithoutDiscoveryEnabled: true });
  } finally { await managed.end(); await pool.query(`DROP DATABASE ${databaseName}`); }
});
