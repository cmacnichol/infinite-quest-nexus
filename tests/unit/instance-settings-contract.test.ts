import { describe, expect, it } from "vitest";
import { instanceSettingsSchema, instanceSettingsPatchSchema, settingsRevisionSchema } from "../../packages/contracts/src/instance-settings.js";
import { settingsFixture } from "../fixtures/instance-settings.js";


describe("installation settings contracts", () => {
  it.each(["abc", "0", "-1", "1.2", "01", "9223372036854775808"])("rejects invalid revision %s without throwing", (revision) => {
    expect(settingsRevisionSchema.safeParse(revision).success).toBe(false);
  });
  it.each(["fatal", "error", "warn", "info", "debug", "trace", "silent"])("accepts log level %s", (logLevel) => {
    expect(instanceSettingsSchema.parse({ ...settingsFixture(), logLevel }).logLevel).toBe(logLevel);
  });
  it.each([{ unknown: true }, { credentialEncryptionKey: "secret" }, { workerPollIntervalMs: "250" }, { workerPollIntervalMs: NaN }, { apiAssetBodyLimitBytes: -1 }, { logLevel: "verbose" }, { workerGenerationConcurrency: 5 }])("rejects unsafe settings %j", (changes) => {
    expect(instanceSettingsSchema.safeParse({ ...settingsFixture(), ...changes }).success).toBe(false);
  });
  it("validates strict nested patches and decimal revision references", () => {
    expect(instanceSettingsPatchSchema.safeParse({ expectedRequestedRevision: "1", changes: { campaignArchiveLimits: { maxEntries: 20 } }, reason: "Reduce archive capacity" }).success).toBe(true);
    for (const changes of [{}, { systemArchiveLimits: { token: "secret" } }, { castEditingEnabled: "true" }]) {
      expect(instanceSettingsPatchSchema.safeParse({ expectedRequestedRevision: "1", changes, reason: "test" }).success).toBe(false);
    }
    expect(instanceSettingsPatchSchema.safeParse({ expectedRequestedRevision: 1, changes: { logLevel: "warn" }, reason: "test" }).success).toBe(false);
  });
});
