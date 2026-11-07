import { describe, it, expect } from "vitest";
import { createSettingsUseCases, validateSettingsSnapshot, type SettingsRepositoryPort, type SettingsState } from "../../packages/application/src/settings/index.js";
import { INSTANCE_SETTING_FIELDS, resolveInstanceSettings } from "../../packages/domain/src/instance-settings.js";
import type { DeploymentSettingsPolicy } from "../../packages/contracts/src/instance-settings.js";
import { settingsFixture } from "../fixtures/instance-settings.js";
function policyFixture(): DeploymentSettingsPolicy {
  const snapshot = settingsFixture();
  return { version: 1, installationId: "00000000-0000-4000-8000-000000000001", minimumSettingsProtocolVersion: 1,
    featureGates: Object.fromEntries(INSTANCE_SETTING_FIELDS.filter((field) => field.kind === "boolean").map((field) => [field.key, true])) as DeploymentSettingsPolicy["featureGates"],
    numericBounds: Object.fromEntries(INSTANCE_SETTING_FIELDS.filter((field) => field.kind === "integer").map((field) => [field.key, { min: field.minimum!, max: field.maximum! }])) as DeploymentSettingsPolicy["numericBounds"],
    approvedRateTuples: [{ windowSeconds: snapshot.apiRateLimitWindowSeconds, providerRequests: snapshot.apiRateLimitProviderRequests, generationRequests: snapshot.apiRateLimitGenerationRequests, importRequests: snapshot.apiRateLimitImportRequests }],
    expectedRoles: [{ role: "worker", replicas: 1, databaseMaxConnections: 8 }], systemArchiveAllowLimitIncrease: false };
}
function fixture() {
  const actor = { userId: "00000000-0000-4000-8000-000000000002", cliReference: "unit-operator" };
  const state: SettingsState = { installationId: policyFixture().installationId, mode: "environment", schemaVersion: 1, activeRevision: null, requestedRevision: "1", activationEpoch: "0", active: null, requested: settingsFixture(), policyDigest: "a".repeat(64) };
  const writes: Parameters<SettingsRepositoryPort["propose"]>[0][] = [];
  const repository: SettingsRepositoryPort = {
    read: async () => state,
    seed: async () => state,
    propose: async (input) => { writes.push(input); return { ...state, requested: input.snapshot }; },
    activate: async () => state
  };
  return { actor, state, writes, repository, useCases: createSettingsUseCases(repository, policyFixture(), resolveInstanceSettings) };
}
describe("settings application boundary", () => {
  it("rejects incompatible archive capacity before a revision write", async () => {
    const { useCases, actor, writes } = fixture();
    await expect(useCases.propose({ expectedRequestedRevision: "1", changes: { systemArchiveLimits: { maxCompressedBytes: 1 } }, reason: "archive-capacity" }, actor)).rejects.toThrow("settings_policy_rejected");
    expect(writes).toHaveLength(0);
  });
  it("requires an explicit policy resolver instead of silently selecting one", () => {
    const { repository } = fixture();
    expect(() => Reflect.apply(createSettingsUseCases, undefined, [repository, policyFixture()])).toThrow("settings_policy_resolver_required");
  });
  it("honors the injected resolver and passes each role without replica metadata", async () => {
    const { repository, actor } = fixture();
    const policy = policyFixture();
    policy.expectedRoles.push({ role: "api", replicas: 2, databaseMaxConnections: 12 });
    const capacities: unknown[] = [];
    const useCases = createSettingsUseCases(repository, policy, (snapshot, effectivePolicy, capacity) => {
      capacities.push(capacity);
      return capacity.role === "api" ? { ok: false } : resolveInstanceSettings(snapshot, effectivePolicy, capacity);
    });
    await expect(useCases.propose({ expectedRequestedRevision: "1", changes: { logLevel: "debug" }, reason: "operator" }, actor)).rejects.toThrow("settings_policy_rejected");
    expect(capacities).toEqual([{ role: "worker", databaseMaxConnections: 8 }, { role: "api", databaseMaxConnections: 12 }]);
  });
  it("rejects secret-shaped and invalid values before persistence", () => {
    expect(() => validateSettingsSnapshot({ ...settingsFixture(), token: "secret" })).toThrow();
    expect(() => validateSettingsSnapshot({ ...settingsFixture(), workerPollIntervalMs: "500" })).toThrow();
    expect(validateSettingsSnapshot(settingsFixture())).toEqual(settingsFixture());
  });
  it("merges nested patches and supplies actor from the trusted argument", async () => {
    const { useCases, writes, actor, state } = fixture();
    const value = await useCases.propose({ expectedRequestedRevision: "1", changes: { campaignArchiveLimits: { maxEntries: 100 } }, reason: "operator" }, actor);
    expect(value.requested!.campaignArchiveLimits).toEqual({ ...state.requested!.campaignArchiveLimits, maxEntries: 100 });
    expect(writes[0]!.actor).toEqual(actor);
  });
  it("rejects stale drafts, actor injection, and incompatible rate policy before persistence", async () => {
    const { useCases, writes, actor } = fixture();
    await expect(useCases.propose({ expectedRequestedRevision: "2", changes: { logLevel: "debug" }, reason: "operator" }, actor)).rejects.toThrow("settings_conflict");
    await expect(useCases.propose({ expectedRequestedRevision: "1", changes: { apiRateLimitWindowSeconds: 1 }, reason: "operator" }, actor)).rejects.toThrow("settings_policy_rejected");
    await expect(useCases.propose({ expectedRequestedRevision: "1", changes: { logLevel: "debug" }, reason: "operator", actor }, actor)).rejects.toThrow();
    expect(writes).toHaveLength(0);
  });
  it("validates rollback against current policy and always appends via proposal", async () => {
    const { useCases, writes, actor } = fixture();
    await useCases.proposeRollback({ expectedRequestedRevision: "1", snapshot: settingsFixture(), actor, reason: "rollback" });
    expect(writes[0]!.kind).toBe("rollback");
    expect(() => useCases.proposeRollback({ expectedRequestedRevision: "1", snapshot: { ...settingsFixture(), apiRateLimitWindowSeconds: 1 }, actor, reason: "rollback" })).toThrow("settings_policy_rejected");
  });
  it("rejects activation for another installation", async () => {
    const { useCases, state, actor } = fixture();
    state.installationId = "00000000-0000-4000-8000-000000000099";
    await expect(useCases.activate({ expectedActiveRevision: null, expectedRequestedRevision: "1", policyDigest: state.policyDigest!, maintenanceReference: "drained", actor })).rejects.toThrow("settings_installation_mismatch");
  });
});
