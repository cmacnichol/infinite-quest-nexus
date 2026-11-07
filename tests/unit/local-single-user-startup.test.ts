import { afterEach, expect, it } from "vitest";
import { loadRuntimeConfig } from "../../packages/database/src/config.js";
import { createLocalSingleUserPolicy } from "../../services/runtime/src/settings-operator.js";
import { bootstrap } from "../helpers/instance-settings-runtime.js";
import { projectRuntimeSettings } from "../../services/runtime/src/instance-settings.js";
const original = { ...process.env };
afterEach(() => { process.env = { ...original }; });
it("requires an explicit supported mode and rejects proxy trust and split roles", () => {
  process.env = { DATABASE_URL: "postgresql://test@localhost/test", APP_ROLE: "all", INSTANCE_SETTINGS_ACCESS_MODE: "local-single-user" };
  expect(loadRuntimeConfig().instanceSettingsAccessMode).toBe("local-single-user");
  process.env.TRUST_PROXY_HOPS = "1";
  expect(() => loadRuntimeConfig()).toThrow();
  process.env.TRUST_PROXY_HOPS = "0"; process.env.APP_ROLE = "api";
  expect(() => loadRuntimeConfig()).toThrow();
  process.env.APP_ROLE = "all"; process.env.INSTANCE_SETTINGS_ACCESS_MODE = "typo";
  expect(() => loadRuntimeConfig()).toThrow();
});
it("derives the same bounded local policy from the original persisted seed", () => {
  const config = { ...bootstrap(), role: "all" as const };
  const snapshot = projectRuntimeSettings(config);
  const id = "00000000-0000-4000-8000-000000000001";
  const policy = createLocalSingleUserPolicy(snapshot, id, config.databaseMaxConnections);
  expect(policy).toEqual(createLocalSingleUserPolicy(snapshot, id, config.databaseMaxConnections));
  expect(policy.numericBounds.workerPollIntervalMs).toEqual({ min: snapshot.workerPollIntervalMs, max: 60000 });
  expect(policy.expectedRoles).toEqual([{ role: "all", databaseMaxConnections: config.databaseMaxConnections, replicas: 1 }]);
});
