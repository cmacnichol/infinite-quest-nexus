import { describe, expect, it } from "vitest";
import { INSTANCE_SETTING_FIELDS, resolveInstanceSettings } from "../../packages/domain/src/instance-settings.js";
import type { DeploymentSettingsPolicy } from "../../packages/contracts/src/instance-settings.js";
import { settingsFixture } from "../fixtures/instance-settings.js";

const workerCapacity = { role: "worker", databaseMaxConnections: 8 } as const;
export function policyFixture(): DeploymentSettingsPolicy {
  return {
    version: 1, installationId: "00000000-0000-4000-8000-000000000001", minimumSettingsProtocolVersion: 1,
    featureGates: Object.fromEntries(INSTANCE_SETTING_FIELDS.filter((field) => field.kind === "boolean").map((field) => [field.key, true])) as DeploymentSettingsPolicy["featureGates"],
    numericBounds: Object.fromEntries(INSTANCE_SETTING_FIELDS.filter((field) => field.kind === "integer").map((field) => [field.key, { min: field.minimum!, max: field.maximum! }])) as DeploymentSettingsPolicy["numericBounds"],
    approvedRateTuples: [{ windowSeconds: 60, providerRequests: 10, generationRequests: 12, importRequests: 4 }],
    expectedRoles: [{ role: "worker", replicas: 1, databaseMaxConnections: 8 }], systemArchiveAllowLimitIncrease: false
  };
}

describe("installation settings policy", () => {
  it.each(["castAutoMatchEnabled", "systemArchiveEnabled", "aiAuthoringJobsEnabled", "worldSharingEnabled"] as const)("honors the direct %s emergency gate", (key) => {
    const policy = policyFixture();
    policy.featureGates[key] = false;
    const requested = { ...settingsFixture(), castEditingEnabled: true, castDiscoveryEnabled: true, [key]: true };
    const result = resolveInstanceSettings(requested, policy, workerCapacity);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success");
    expect(result.effective[key]).toBe(false);
    expect(result.fields.find((field) => field.key === key)?.lockReason).toBe("deployment_disabled");
    expect(requested[key]).toBe(true);
  });
  it("maps each reviewed environment control exactly once", () => {
    expect(INSTANCE_SETTING_FIELDS).toHaveLength(40);
    const names = [
      "LOG_LEVEL",
      "WORKER_POLL_INTERVAL_MS",
      "TEXT_PROVIDER_CONCURRENCY",
      "ARCHIVE_PREVIEW_TTL_SECONDS",
      "SYSTEM_ARCHIVE_ARTIFACT_TTL_SECONDS",
      "SYSTEM_ARCHIVE_UPLOAD_TTL_SECONDS",
      "SYSTEM_ARCHIVE_CHUNK_BYTES",
      "AI_AUTHORING_JOBS_ENABLED",
      "AI_STORY_SOURCE_AUTHORING_ENABLED",
      "CAST_EDITING_ENABLED",
      "CAST_DISCOVERY_ENABLED",
      "CAST_AUTO_MATCH_ENABLED",
      "CAST_CONTEXT_ENABLED",
      "CAST_BACKFILL_ENABLED",
      "WORLD_SHARING_ENABLED",
      "SYSTEM_ARCHIVE_ENABLED",
      "WORKER_GENERATION_CONCURRENCY",
      "API_DEFAULT_BODY_LIMIT_BYTES",
      "API_IMPORT_BODY_LIMIT_BYTES",
      "API_ASSET_BODY_LIMIT_BYTES",
      "API_RATE_LIMIT_WINDOW_SECONDS",
      "API_RATE_LIMIT_PROVIDER_REQUESTS",
      "API_RATE_LIMIT_GENERATION_REQUESTS",
      "API_RATE_LIMIT_IMPORT_REQUESTS",
      "API_CONCURRENCY_PROVIDER_REQUESTS",
      "API_CONCURRENCY_IMPORT_REQUESTS",
      "CAMPAIGN_ARCHIVE_MAX_COMPRESSED_BYTES",
      "CAMPAIGN_ARCHIVE_MAX_UNCOMPRESSED_BYTES",
      "CAMPAIGN_ARCHIVE_MAX_ENTRIES",
      "CAMPAIGN_ARCHIVE_MAX_EXPANSION_RATIO",
      "CAMPAIGN_ARCHIVE_MAX_MANIFEST_BYTES",
      "CAMPAIGN_ARCHIVE_MAX_JSON_ENTRY_BYTES",
      "CAMPAIGN_ARCHIVE_MAX_ORIGINAL_IMAGE_BYTES",
      "SYSTEM_ARCHIVE_MAX_COMPRESSED_BYTES",
      "SYSTEM_ARCHIVE_MAX_UNCOMPRESSED_BYTES",
      "SYSTEM_ARCHIVE_MAX_ENTRIES",
      "SYSTEM_ARCHIVE_MAX_EXPANSION_RATIO",
      "SYSTEM_ARCHIVE_MAX_MANIFEST_BYTES",
      "SYSTEM_ARCHIVE_MAX_JSON_ENTRY_BYTES",
      "SYSTEM_ARCHIVE_MAX_ORIGINAL_IMAGE_BYTES",
    ];
    expect(INSTANCE_SETTING_FIELDS.map((field) => field.environmentName).sort()).toEqual(names.sort());
    expect(new Set(INSTANCE_SETTING_FIELDS.map((field) => field.key)).size).toBe(40);
  });
  it("suppresses deployment-disabled features and dependencies without changing saved preferences", () => {
    const autoMatchOn = { ...settingsFixture(), castEditingEnabled: true, castDiscoveryEnabled: true, castAutoMatchEnabled: true };
    const editingOffPolicy = policyFixture();
    editingOffPolicy.featureGates.castEditingEnabled = false;
    const result = resolveInstanceSettings(autoMatchOn, editingOffPolicy, workerCapacity);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success");
    expect(result.effective.castAutoMatchEnabled).toBe(false);
    expect(autoMatchOn.castAutoMatchEnabled).toBe(true);
    expect(result.fields.find((field) => field.key === "castAutoMatchEnabled")?.lockReason).toBe("dependency_disabled");
    expect(result.fields.every((field) => field.applyMode === "restart")).toBe(true);
  });
  it.each([ ["worker", 7, false], ["worker", 8, true], ["all", 11, false], ["all", 12, true], ["api", 2, true] ] as const)("checks %s pool %i", (role, databaseMaxConnections, ok) => {
    expect(resolveInstanceSettings({ ...settingsFixture(), workerGenerationConcurrency: 4 }, policyFixture(), { role, databaseMaxConnections }).ok).toBe(ok);
  });
  it("rejects numeric ceiling violations rather than clamping", () => {
    const policy = policyFixture();
    policy.numericBounds.textProviderConcurrency = { min: 1, max: 2 };
    expect(resolveInstanceSettings({ ...settingsFixture(), textProviderConcurrency: 3 }, policy, workerCapacity)).toMatchObject({ ok: false, errors: [{ code: "policy_bound", field: "textProviderConcurrency" }] });
  });
  it("rejects a smaller rate window with the same counts", () => {
    expect(resolveInstanceSettings({ ...settingsFixture(), apiRateLimitWindowSeconds: 1 }, policyFixture(), workerCapacity)).toMatchObject({ ok: false, errors: [{ code: "rate_policy" }] });
  });
  it("preserves reviewed archive maxima unless explicitly approved", () => {
    const requested = settingsFixture();
    requested.systemArchiveLimits.maxEntries = 1_000_001;
    const policy = policyFixture();
    policy.numericBounds["systemArchiveLimits.maxEntries"] = { min: 1, max: 2_000_000 };
    expect(resolveInstanceSettings(requested, policy, workerCapacity).ok).toBe(false);
    policy.systemArchiveAllowLimitIncrease = true;
    expect(resolveInstanceSettings(requested, policy, workerCapacity).ok).toBe(true);
    requested.campaignArchiveLimits.maxEntries = 100_001;
    expect(resolveInstanceSettings(requested, policy, workerCapacity).ok).toBe(false);
  });
  it("rejects malformed policy and invalid runtime input", () => {
    expect(resolveInstanceSettings({ ...settingsFixture(), workerGenerationConcurrency: 0 }, policyFixture(), workerCapacity).ok).toBe(false);
    expect(resolveInstanceSettings(settingsFixture(), { ...policyFixture(), secret: "bad" } as DeploymentSettingsPolicy, workerCapacity).ok).toBe(false);
  });
});
