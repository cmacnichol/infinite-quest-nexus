import { expect, it } from "vitest";
import { deploymentSettingsPolicySchema } from "../../packages/contracts/src/instance-settings.js";
import { settingsReportsCompatible, resolveRuntimeSettingsState, settingsDigest } from "../../services/runtime/src/instance-settings.js";
import { createSeedPolicy, exportCompatibilityEnvironment, exportSettingsSeed, reconcileSettingsSeeds, createLocalSingleUserPolicy } from "../../services/runtime/src/settings-operator.js";
import { loadLocalSingleUserPolicy } from "../../services/runtime/src/local-single-user-settings.js";
import { bootstrap, runtimePolicy } from "../helpers/instance-settings-runtime.js";

it("bounds all live processes, counts only eligible registrations and verifies even stopping peers", () => {
  const policy = runtimePolicy();
  policy.expectedRoles = [{ role: "worker", replicas: 2, maximumReplicas: 3, databaseMaxConnections: 12 }];
  const resolved = resolveRuntimeSettingsState({ mode: "environment", active: null, activeRevision: null, requested: null, requestedRevision: null, policyDigest: null, installationId: null, schemaVersion: 1, activationEpoch: "0" }, bootstrap(), policy);
  const ready = { role: "worker", active_revision: null, activation_epoch: "0", protocol_version: 1, policy_digest: resolved.policyDigest, effective_configuration_digest: resolved.effectiveDigest, fresh: true, readiness_state: "ready" };
  const blocked = { ...ready, readiness_state: "blocked" }, stopping = { ...ready, readiness_state: "stopping" };
  const accepts = (reports: typeof ready[], serving = true) => settingsReportsCompatible(reports, resolved, policy, serving);
  expect(accepts([ready, ready, blocked])).toBe(true);
  expect(accepts([ready, blocked, stopping], false)).toBe(true);
  expect(accepts([ready, blocked, stopping])).toBe(false);
  expect(accepts([ready, ready, stopping])).toBe(true);
  expect(accepts([ready, ready, ready, stopping])).toBe(false);
  expect(accepts([ready, ready, { ...stopping, protocol_version: 2 }])).toBe(false);
  expect(accepts([ready, ready, { ...ready, role: "api" }])).toBe(false);
  expect(deploymentSettingsPolicySchema.safeParse({ ...policy, expectedRoles: [{ ...policy.expectedRoles[0], maximumReplicas: 1 }] }).success).toBe(false);
  expect(deploymentSettingsPolicySchema.safeParse({ ...policy, expectedRoles: [...policy.expectedRoles, ...policy.expectedRoles] }).success).toBe(false);
});

it("builds a conservative policy from all reviewed role seeds and exports only the 42 scalar environment assignments", () => {
  const seed = exportSettingsSeed(bootstrap());
  const policy = createSeedPolicy([seed, seed], runtimePolicy().installationId);
  expect(policy.expectedRoles).toEqual([{ ...seed.role, replicas: 2 }]);
  expect(policy.numericBounds.workerPollIntervalMs).toEqual({ min: seed.snapshot.workerPollIntervalMs, max: seed.snapshot.workerPollIntervalMs });
  expect(policy.featureGates.castDiscoveryEnabled).toBe(false);
  expect(() => createSeedPolicy([{ ...seed, digest: "0".repeat(64) }], policy.installationId)).toThrow();
  const entries = exportCompatibilityEnvironment(seed.snapshot);
  expect(Object.keys(entries)).toHaveLength(42);
  expect(entries.CAST_AUTO_MATCH_ENABLED).toBe("false");
  expect(entries.CAMPAIGN_ARCHIVE_MAX_ENTRIES).toBe(String(seed.snapshot.campaignArchiveLimits.maxEntries));
  expect(JSON.stringify(entries)).not.toMatch(/postgres|secret|credential|password/i);
});


it("loads an old seed without altering its digest", () => {
  const seed = exportSettingsSeed(bootstrap());
  const oldSnapshot = { ...seed.snapshot } as Partial<typeof seed.snapshot>;
  delete oldSnapshot.castPresetsEnabled;
  delete oldSnapshot.castContextWithoutDiscoveryEnabled;
  const oldSeed = { ...seed, snapshot: oldSnapshot, digest: settingsDigest(oldSnapshot) };
  const policy = createSeedPolicy([oldSeed], "00000000-0000-4000-8000-000000000001");
  const result = reconcileSettingsSeeds([oldSeed], policy);
  expect(result.castPresetsEnabled).toBe(false);
  expect(result.castContextWithoutDiscoveryEnabled).toBe(false);
});

it("reconstructs the original local policy digest while permitting the new controls", async () => {
  const config = { ...bootstrap(), role: "all" as const, instanceSettingsAccessMode: "local-single-user" as const };
  const seed = exportSettingsSeed(config);
  const oldSnapshot = { ...seed.snapshot } as Partial<typeof seed.snapshot>;
  delete oldSnapshot.castPresetsEnabled;
  delete oldSnapshot.castContextWithoutDiscoveryEnabled;
  const installationId = "00000000-0000-4000-8000-000000000001";
  const oldPolicy = createLocalSingleUserPolicy(seed.snapshot, installationId, config.databaseMaxConnections);
  oldPolicy.version = 1;
  delete oldPolicy.featureGates.castPresetsEnabled;
  delete oldPolicy.featureGates.castContextWithoutDiscoveryEnabled;
  const digest = settingsDigest(oldPolicy);
  const pool = { query: async (sql: string) => sql.includes("instance_settings_state")
    ? { rows: [{ installation_id: installationId, mode: "database", schema_version: 1, active_revision: "1", requested_revision: "1", activation_epoch: "1", active: oldSnapshot, requested: oldSnapshot, policy_digest: digest }] }
    : { rows: [{ snapshot: oldSnapshot, policy_digest: digest, local_single_user: true }] } };
  const loaded = await loadLocalSingleUserPolicy(pool as never, config);
  expect(settingsDigest(loaded)).toBe(digest);
  expect(loaded.featureGates.castPresetsEnabled).toBeUndefined();
  expect(loaded.featureGates.castContextWithoutDiscoveryEnabled).toBeUndefined();
  expect(Object.keys(loaded.featureGates)).not.toContain("castPresetsEnabled");
});

it("derives legacy local gates explicitly without changing the v1 policy representation or managed behavior", async () => {
  const { deriveSettingsPolicyForLocalMode } = await import("../../packages/domain/src/instance-settings.js");
  const legacy = runtimePolicy();
  legacy.version = 1;
  delete legacy.featureGates.castPresetsEnabled;
  delete legacy.featureGates.castContextWithoutDiscoveryEnabled;
  const digest = settingsDigest(legacy), before = JSON.stringify(legacy);
  const local = deriveSettingsPolicyForLocalMode(legacy, true);
  expect(local.featureGates).toMatchObject({ castPresetsEnabled: true, castContextWithoutDiscoveryEnabled: true });
  expect(JSON.stringify(legacy)).toBe(before);
  expect(settingsDigest(legacy)).toBe(digest);
  expect(deriveSettingsPolicyForLocalMode(JSON.parse(before), false).featureGates.castPresetsEnabled).toBeUndefined();
  expect(deriveSettingsPolicyForLocalMode(JSON.parse(before), true)).toEqual(local);
});

it("uses derived legacy gates consistently after JSON round-trip and keeps mounted policies constrained", () => {
  const raw = runtimePolicy();
  raw.version = 1; delete raw.featureGates.castPresetsEnabled; delete raw.featureGates.castContextWithoutDiscoveryEnabled;
  const policy = JSON.parse(JSON.stringify(raw));
  const config = { ...bootstrap(), instanceSettingsAccessMode: "local-single-user" as const, castEditingEnabled: true,
    castPresetsEnabled: false, castContextWithoutDiscoveryEnabled: false };
  const active = { ...exportSettingsSeed(config).snapshot, castEditingEnabled: true, castPresetsEnabled: true, castContextWithoutDiscoveryEnabled: true };
  const state = { mode: "database" as const, active, activeRevision: "1", requested: active, requestedRevision: "1", policyDigest: settingsDigest(policy),
    installationId: policy.installationId, schemaVersion: 1, activationEpoch: "1" };
  const local = resolveRuntimeSettingsState(state, config, policy);
  expect(local.policyDigest).toBe(settingsDigest(raw));
  expect(local.config).toMatchObject({ castPresetsEnabled: true, castContextWithoutDiscoveryEnabled: true });
  const mounted = resolveRuntimeSettingsState(state, { ...config, instanceSettingsPolicyFile: "managed-policy.json" }, policy);
  expect(mounted.config).toMatchObject({ castPresetsEnabled: false, castContextWithoutDiscoveryEnabled: false });
});

it("keeps policy versions strict and requires the new gates on v2", () => {
  const legacy = runtimePolicy();
  delete legacy.featureGates.castPresetsEnabled;
  delete legacy.featureGates.castContextWithoutDiscoveryEnabled;
  expect(deploymentSettingsPolicySchema.safeParse(legacy).success).toBe(true);
  expect(deploymentSettingsPolicySchema.safeParse({ ...legacy, version: 2 }).success).toBe(false);
  expect(deploymentSettingsPolicySchema.safeParse({ ...legacy, version: 3 }).success).toBe(false);
});
