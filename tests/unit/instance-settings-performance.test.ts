import { describe, expect, it } from "vitest";
import pino from "pino";
import { adoptRuntimeLoggerSettings, createLoggerOptions, logger } from "../../packages/logger/src/index.js";
import { instanceSettingsSchema } from "../../packages/contracts/src/instance-settings.js";
import { resolveInstanceSettings } from "../../packages/domain/src/instance-settings.js";
import { resolveRuntimeSettingsState, settingsDigest } from "../../services/runtime/src/instance-settings.js";
import { bootstrap, runtimePolicy } from "../helpers/instance-settings-runtime.js";
import { settingsFixture } from "../fixtures/instance-settings.js";

describe("active performance and diagnostics settings", () => {
  it("adopts only the active logger level and keeps redaction at trace level", () => {
    const previous = logger.level;
    try {
      adoptRuntimeLoggerSettings({ logLevel: "trace" });
      expect(logger.level).toBe("trace");
      let output = "";
      const { transport: _transport, ...options } = createLoggerOptions("trace");
      const log = pino(options, { write: (line) => { output += line; } });
      log.trace({ managementKey: "secret-marker", apiKey: "secret-marker", req: { body: "secret-marker", headers: { authorization: "secret-marker" } } });
      expect(output).not.toContain("secret-marker");
      expect(output).toContain("[Redacted]");
    } finally { logger.level = previous; }
  });
  it("rejects invalid log levels and polling intervals", () => {
    const snapshot = settingsFixture();
    for (const logLevel of ["verbose", "off", "INFO"]) expect(instanceSettingsSchema.safeParse({ ...snapshot, logLevel }).success).toBe(false);
    for (const workerPollIntervalMs of [249, 60001]) expect(instanceSettingsSchema.safeParse({ ...snapshot, workerPollIntervalMs }).success).toBe(false);
    for (const workerPollIntervalMs of [250, 60000]) expect(instanceSettingsSchema.safeParse({ ...snapshot, workerPollIntervalMs }).success).toBe(true);
  });
  it("requires role-specific pool headroom for four generation jobs", () => {
    const snapshot = { ...settingsFixture(), workerGenerationConcurrency: 4 };
    for (const [role, required] of [["all", 12], ["worker", 8]] as const) {
      expect(resolveInstanceSettings(snapshot, runtimePolicy(), { role, databaseMaxConnections: required }).ok).toBe(true);
      expect(resolveInstanceSettings(snapshot, runtimePolicy(), { role, databaseMaxConnections: required - 1 }).ok).toBe(false);
    }
  });
  it("keeps active slots, polling and shared text capacity unchanged by a pending revision", () => {
    const policy = runtimePolicy();
    const active = { ...settingsFixture(), workerGenerationConcurrency: 2, textProviderConcurrency: 1, workerPollIntervalMs: 250, logLevel: "warn" as const };
    const requested = { ...active, workerGenerationConcurrency: 4, textProviderConcurrency: 8, workerPollIntervalMs: 500, logLevel: "trace" as const };
    const state = { installationId: policy.installationId, mode: "database" as const, schemaVersion: 1, activeRevision: "1", requestedRevision: "2", activationEpoch: "1", active, requested, policyDigest: settingsDigest(policy) };
    const resolved = resolveRuntimeSettingsState(state, bootstrap(), policy);
    expect(resolved.config).toMatchObject({ workerGenerationConcurrency: 2, textProviderConcurrency: 1, workerPollIntervalMs: 250, logLevel: "warn" });
    expect(resolved.effectiveDigest).toBe(settingsDigest(active));
  });
});
