import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootstrap, runtimePolicy } from "../helpers/instance-settings-runtime.js";
import { settingsFixture } from "../fixtures/instance-settings.js";
import { settingsDigest, mergeRuntimeSettings } from "../../services/runtime/src/instance-settings.js";
import { createInstanceSettingsHttpComposition } from "../../services/api/src/instance-settings-composition.js";
import type { DatabasePool } from "../../packages/database/src/pool.js";
const { read } = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("../../packages/database/src/instance-settings-repository.js", () => ({ createInstanceSettingsRepository: () => ({ read }) }));
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function fixture(mode: "environment" | "database", allowed = true) {
  const directory = mkdtempSync(join(tmpdir(), "iq-settings-projection-")); directories.push(directory);
  const policy = runtimePolicy(); policy.featureGates.castEditingEnabled = allowed;
  const path = join(directory, "policy.json"); writeFileSync(path, JSON.stringify(policy));
  const config = { ...bootstrap(), castEditingEnabled: true, instanceSettingsPolicyFile: path };
  const active = { ...settingsFixture(), castEditingEnabled: true };
  read.mockResolvedValue({ installationId: policy.installationId, mode, activeRevision: mode === "database" ? "1" : null, requestedRevision: "2", active: mode === "database" ? active : null, requested: active, policyDigest: "f".repeat(64) });
  const query = vi.fn(async () => ({ rows: [{ policy_digest: settingsDigest(policy) }] }));
  const pool = { query } as unknown as DatabasePool;
  const running = mergeRuntimeSettings(config, active);
  const composition = createInstanceSettingsHttpComposition(pool, config, running);
  return { composition, policy, path, query };
}
describe("running installation projection", () => {
  it("keeps environment values and field effective values equal despite a restrictive proposal policy", async () => {
    const { composition } = fixture("environment", false);
    const view = await composition.settings.read();
    expect(view.active.castEditingEnabled).toBe(true);
    expect(view.fields.find(field => field.key === "castEditingEnabled")).toMatchObject({ effectiveValue: true, source: "environment", lockReason: "deployment_disabled" });
  });
  it("keeps active provenance separate from a different requested policy and rejects mounted policy drift", async () => {
    const { composition, policy, path } = fixture("database");
    expect((await composition.settings.read()).active.castEditingEnabled).toBe(true);
    policy.featureGates.castEditingEnabled = false; writeFileSync(path, JSON.stringify(policy));
    await expect(composition.settings.read()).rejects.toMatchObject({ code: "settings_policy_mismatch", statusCode: 503 });
  });
  it("rejects an active revision whose policy does not match the running policy", async () => {
    const { composition, query } = fixture("database");
    query.mockResolvedValue({ rows: [{ policy_digest: "e".repeat(64) }] });
    await expect(composition.settings.read()).rejects.toMatchObject({ code: "settings_policy_mismatch", statusCode: 503 });
  });
});
