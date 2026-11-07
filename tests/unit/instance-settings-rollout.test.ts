import { expect, it } from "vitest";
import { deploymentSettingsPolicySchema } from "../../packages/contracts/src/instance-settings.js";
import { settingsReportsCompatible, resolveRuntimeSettingsState } from "../../services/runtime/src/instance-settings.js";
import { createSeedPolicy, exportCompatibilityEnvironment, exportSettingsSeed } from "../../services/runtime/src/settings-operator.js";
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

it("builds a conservative policy from all reviewed role seeds and exports only the forty scalar environment assignments", () => {
  const seed = exportSettingsSeed(bootstrap());
  const policy = createSeedPolicy([seed, seed], runtimePolicy().installationId);
  expect(policy.expectedRoles).toEqual([{ ...seed.role, replicas: 2 }]);
  expect(policy.numericBounds.workerPollIntervalMs).toEqual({ min: seed.snapshot.workerPollIntervalMs, max: seed.snapshot.workerPollIntervalMs });
  expect(policy.featureGates.castDiscoveryEnabled).toBe(false);
  expect(() => createSeedPolicy([{ ...seed, digest: "0".repeat(64) }], policy.installationId)).toThrow();
  const entries = exportCompatibilityEnvironment(seed.snapshot);
  expect(Object.keys(entries)).toHaveLength(40);
  expect(entries.CAST_AUTO_MATCH_ENABLED).toBe("false");
  expect(entries.CAMPAIGN_ARCHIVE_MAX_ENTRIES).toBe(String(seed.snapshot.campaignArchiveLimits.maxEntries));
  expect(JSON.stringify(entries)).not.toMatch(/postgres|secret|credential|password/i);
});
