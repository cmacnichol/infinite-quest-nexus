import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabasePool, initialOwnerId, type DatabasePool } from "../../packages/database/src/pool.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { createInstanceSettingsRepository } from "../../packages/database/src/instance-settings-repository.js";
import { createSettingsActivationGuard } from "../../services/runtime/src/settings-activation.js";
import { loadActiveRuntimeSettings } from "../../services/runtime/src/instance-settings.js";
import { createSettingsOperatorRepository } from "../../packages/database/src/settings-operator-repository.js";
import { createSettingsOperatorSessions } from "../../services/api/src/settings-operator-session.js";
import { buildServer } from "../../services/api/src/server.js";
import { inertStorageServerOptions } from "../helpers/build-server-options.js";
import { bootstrap, runtimePolicy } from "../helpers/instance-settings-runtime.js";
import { settingsFixture } from "../fixtures/instance-settings.js";
import { resolveRuntimeSettingsState, settingsDigest } from "../../services/runtime/src/instance-settings.js";
import { settingsFeatureGatesSchema } from "../../packages/contracts/src/instance-settings.js";

const features = Object.keys(settingsFeatureGatesSchema.shape) as (keyof typeof settingsFeatureGatesSchema.shape)[];
const allEnabled = Object.fromEntries(features.map(key => [key, true]));
describe("active feature preferences", () => {
  it.each(features)("applies only active %s and preserves deployment denial", key => {
    const policy = runtimePolicy();
    const active = { ...settingsFixture(), ...allEnabled, [key]: false };
    const state = { installationId: policy.installationId, mode: "database" as const, schemaVersion: 1, activeRevision: "1", requestedRevision: "2", activationEpoch: "1", active, requested: { ...active, [key]: true }, policyDigest: settingsDigest(policy) };
    const config = { ...bootstrap(), ...allEnabled };
    expect(resolveRuntimeSettingsState(state, config, policy).config[key]).toBe(false);
    policy.featureGates[key] = false;
    const denied = { ...state, active: { ...active, [key]: true }, policyDigest: settingsDigest(policy) };
    expect(resolveRuntimeSettingsState(denied, { ...config, [key]: false }, policy).config[key]).toBe(false);
  });
});

const integration = process.env.TEST_DATABASE_URL ? describe : describe.skip;
integration("sharing feature restart boundaries", () => {
  let pool: DatabasePool, owner: string;
  const apps: Awaited<ReturnType<typeof buildServer>>[] = [];
  beforeAll(async () => { pool = createDatabasePool(process.env.TEST_DATABASE_URL!, 4); await migrateDatabase(pool, resolve("database/migrations")); owner = await initialOwnerId(pool); });
  afterAll(async () => { for (const app of apps) await app.close(); await pool?.end(); });
  async function server(enabled: boolean) {
    const app = await buildServer(inertStorageServerOptions({ pool, config: { ...bootstrap(), role: "api", databaseUrl: process.env.TEST_DATABASE_URL!, worldSharingEnabled: enabled } }));
    apps.push(app); return app;
  }
  async function world(ownerUserId = owner) {
    const worldId = randomUUID(), versionId = randomUUID();
    await pool.query("INSERT INTO worlds(id,owner_user_id,title) VALUES($1,$2,'Feature fixture')", [worldId, ownerUserId]);
    await pool.query("INSERT INTO world_versions(id,world_id,owner_user_id,version_number,content) VALUES($1,$2,$3,1,$4)", [versionId, worldId, ownerUserId, { schemaVersion: 1, world: { title: "Feature fixture" } }]);
    return { worldId, versionId };
  }
  it("loads all nine preferences from the activated snapshot, never the staged revision", async () => {
    const policy = runtimePolicy(), active = { ...settingsFixture(), ...allEnabled };
    policy.expectedRoles.push({ role: "api", replicas: 1, databaseMaxConnections: 12 });
    const repository = createInstanceSettingsRepository(pool, { activationGuard: createSettingsActivationGuard(policy) });
    const actor = { userId: owner, cliReference: "feature-preferences-test" };
    await repository.seed({ installationId: policy.installationId, snapshot: active, policyDigest: settingsDigest(policy), seedDigest: settingsDigest(active), actor });
    await repository.activate({ expectedActiveRevision: null, expectedRequestedRevision: "1", policyDigest: settingsDigest(policy), maintenanceReference: "feature-test-drained", actor });
    const staged = { ...active, ...Object.fromEntries(features.map(key => [key, false])) };
    await repository.propose({ expectedRequestedRevision: "1", snapshot: staged, actor, reason: "disable-features" });
    const startup = { ...bootstrap(), ...allEnabled };
    const before = await loadActiveRuntimeSettings(pool, startup, policy);
    for (const key of features) expect(before.config[key]).toBe(true);
    expect((await loadActiveRuntimeSettings(pool, { ...startup, role: "api" }, policy)).config.systemArchiveEnabled).toBe(before.config.systemArchiveEnabled);
    await expect(loadActiveRuntimeSettings(pool, { ...startup, systemArchiveEnabled: false }, policy)).rejects.toThrow("settings_deployment_divergence");
    await repository.activate({ expectedActiveRevision: "1", expectedRequestedRevision: "2", policyDigest: settingsDigest(policy), maintenanceReference: "feature-test-drained", actor });
    const after = await loadActiveRuntimeSettings(pool, startup, policy);
    for (const key of features) expect(after.config[key]).toBe(false);
    expect((await loadActiveRuntimeSettings(pool, { ...startup, role: "api" }, policy)).config.systemArchiveEnabled).toBe(after.config.systemArchiveEnabled);
    expect(after.activeRevision).toBe("2");
  });
  it("retains owner list and revoke while create/redemption are off and never revives expired/revoked links", async () => {
    const enabled = await server(true), disabled = await server(false), f = await world();
    const create = async () => {
      const response = await enabled.inject({ method: "POST", url: `/api/v1/worlds/${f.worldId}/share-links`, payload: { worldVersionId: f.versionId, expiresInSeconds: 3600 } });
      expect(response.statusCode).toBe(201); return response.json();
    };
    const valid = await create(), expired = await create(), revoked = await create();
    await pool.query("UPDATE world_share_links SET expires_at=now()-interval '1 second' WHERE id=$1", [expired.id]);
    const list = await disabled.inject(`/api/v1/worlds/${f.worldId}/share-links`);
    expect(list.statusCode).toBe(200); expect(list.json().shares).toHaveLength(3);
    expect((await disabled.inject({ method: "DELETE", url: `/api/v1/worlds/${f.worldId}/share-links/${revoked.id}` })).statusCode).toBe(204);
    expect((await disabled.inject({ method: "POST", url: `/api/v1/worlds/${f.worldId}/share-links`, payload: { worldVersionId: f.versionId, expiresInSeconds: 3600 } })).statusCode).toBe(404);
    for (const link of [valid, expired, revoked]) expect((await disabled.inject(`/api/v1/world-shares/${link.token}`)).statusCode).toBe(404);
    expect((await enabled.inject(`/api/v1/world-shares/${valid.token}`)).statusCode).toBe(200);
    for (const link of [expired, revoked]) expect((await enabled.inject(`/api/v1/world-shares/${link.token}`)).statusCode).toBe(404);
    expect((await pool.query("SELECT redeemed_count::int AS redeemed_count FROM world_share_links WHERE id=$1", [valid.id])).rows[0].redeemed_count).toBe(1);
  });
  it("does not let disabled sharing management cross owner/world boundaries", async () => {
    const disabled = await server(false);
    const other = randomUUID(); await pool.query("INSERT INTO users(id,display_name) VALUES($1,'Other owner')", [other]);
    const sessions = createSettingsOperatorSessions(createSettingsOperatorRepository(pool), () => "feature-test-operator-key-".repeat(3));
    const session = await sessions.unlock("feature-test-operator-key-".repeat(3), owner, "feature-owner-test");
    expect((await sessions.authorize(session.token, owner)).actorUserId).toBe(owner);
    const headers = { cookie: `iq_settings_operator=${session.token}`, "x-owner-user-id": other };
    const foreign = await world(other), local = await world();
    const { rows: [share] } = await pool.query("INSERT INTO world_share_links(owner_user_id,world_id,world_version_id,token_hash,expires_at) VALUES($1,$2,$3,$4,now()+interval '1 hour') RETURNING id", [other, foreign.worldId, foreign.versionId, "a".repeat(64)]);
    expect((await disabled.inject(`/api/v1/worlds/${foreign.worldId}/share-links`)).json()).toEqual({ shares: [] });
    for (const worldId of [foreign.worldId, local.worldId]) expect((await disabled.inject({ method: "DELETE", url: `/api/v1/worlds/${worldId}/share-links/${share.id}`, headers })).statusCode).toBe(404);
    expect((await pool.query("SELECT revoked_at FROM world_share_links WHERE id=$1", [share.id])).rows[0].revoked_at).toBeNull();
  });
});
