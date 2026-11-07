import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabasePool, initialOwnerId, type DatabasePool } from "../../packages/database/src/pool.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { createInstanceSettingsRepository } from "../../packages/database/src/instance-settings-repository.js";
import { createSettingsActivationGuard } from "../../services/runtime/src/settings-activation.js";
import { loadActiveRuntimeSettings, settingsDigest } from "../../services/runtime/src/instance-settings.js";
import { settingsFixture } from "../fixtures/instance-settings.js";
import { bootstrap, runtimePolicy } from "../helpers/instance-settings-runtime.js";
// @ts-expect-error Tool launcher intentionally has no TypeScript declarations.
import { tsxCommand } from "../../scripts/node-tool-command.mjs";

async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 15000;
  while (!await check()) { if (Date.now() > deadline) throw new Error("performance_fixture_timeout"); await delay(25); }
}
describe("active performance in two independent worker processes", () => {
  let pool: DatabasePool;
  beforeAll(async () => { pool = createDatabasePool(process.env.TEST_DATABASE_URL!, 8); await migrateDatabase(pool, resolve("database/migrations")); }, 60000);
  afterAll(async () => { await pool?.end(); });
  it("keeps staged capacity inactive, reports the same active digest and drains independent lanes", async () => {
    const policy = { ...runtimePolicy(), expectedRoles: [{ role: "worker" as const, replicas: 2, databaseMaxConnections: 8 }] };
    const repository = createInstanceSettingsRepository(pool, { activationGuard: createSettingsActivationGuard(policy) });
    const actor = { userId: await initialOwnerId(pool), cliReference: "performance-test" };
    const active = { ...settingsFixture(), castEditingEnabled: true, castDiscoveryEnabled: true, workerGenerationConcurrency: 2, textProviderConcurrency: 1, workerPollIntervalMs: 250, logLevel: "warn" as const };
    await repository.seed({ installationId: policy.installationId, snapshot: active, policyDigest: settingsDigest(policy), seedDigest: settingsDigest(active), actor });
    await repository.activate({ expectedActiveRevision: null, expectedRequestedRevision: "1", policyDigest: settingsDigest(policy), maintenanceReference: "isolated-test-drained", actor });
    await pool.query("CREATE TABLE settings_performance_jobs(id integer PRIMARY KEY, status text NOT NULL DEFAULT 'queued')");
    await pool.query("INSERT INTO settings_performance_jobs(id) SELECT generate_series(1,12)");
    let calls = 0, running = 0, peak = 0;
    const pending: (() => void)[] = [];
    let release = false;
    const server = createServer((_request, response) => {
      calls++; running++; peak = Math.max(peak, running);
      const finish = () => { running--; response.end("accepted fiction"); };
      if (release) finish(); else pending.push(finish);
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address() as { port: number };
    const children: ChildProcess[] = [], events: { event: string; lane?: string; digest?: string; level?: string; slots?: number; poll?: number; sharedCapacity?: number }[][] = [[], []], exits: Promise<number | null>[] = [];
    let errors = "";
    try {
      for (let index = 0; index < 2; index++) {
        const command = tsxCommand(["tests/helpers/instance-settings-performance-worker.ts"]);
        const child = spawn(command.executable, command.arguments, { env: { ...process.env, PERFORMANCE_PROVIDER_URL: `http://127.0.0.1:${address.port}`, NODE_ENV: "production" }, stdio: ["ignore", "ignore", "pipe", "ipc"] });
        children.push(child); child.on("message", (event) => events[index]!.push(event as (typeof events)[number][number])); child.stderr?.on("data", (chunk) => { errors += chunk; });
        exits.push(new Promise((done) => child.on("exit", done)));
      }
      await until(() => events.every((list) => list.some((event) => event.event === "ready")));
      await until(() => events.every((list) => list.filter((event) => event.event === "claim").length === 2));
      await until(() => calls === 1);
      const staged = { ...active, workerGenerationConcurrency: 4, textProviderConcurrency: 4, workerPollIntervalMs: 500, logLevel: "trace" as const };
      await repository.propose({ expectedRequestedRevision: "1", snapshot: staged, actor, reason: "performance-stage" });
      await delay(350);
      children.forEach((child) => child.send("inspect"));
      await until(() => events.every((list) => list.some((event) => event.event === "active")));
      expect(calls).toBe(1);
      expect(events.map((list) => list.filter((event) => event.event === "claim").length)).toEqual([2, 2]);
      for (const list of events) {
        expect(list.find((event) => event.event === "ready")).toMatchObject({ digest: settingsDigest(active), level: "warn", slots: 2, poll: 250, sharedCapacity: 1 });
        expect(list.find((event) => event.event === "active")).toMatchObject({ digest: settingsDigest(active), level: "warn", slots: 2, poll: 250, sharedCapacity: 1 });
        expect(new Set(list.filter((event) => event.event === "lane").map((event) => event.lane))).toEqual(new Set(["illustration", "chronicle", "asset"]));
      }
      const reports = await pool.query("SELECT effective_configuration_digest FROM instance_settings_runtime_reports");
      expect(reports.rows).toEqual([{ effective_configuration_digest: settingsDigest(active) }, { effective_configuration_digest: settingsDigest(active) }]);
      const reloaded = await loadActiveRuntimeSettings(pool, { ...bootstrap(), databaseMaxConnections: 8, castEditingEnabled: true, castDiscoveryEnabled: true }, policy);
      expect(reloaded.config.workerGenerationConcurrency).toBe(2);
      children.forEach((child) => child.send("stop"));
      await delay(100);
      expect(children.every((child) => child.exitCode === null)).toBe(true);
      release = true; pending.splice(0).forEach((finish) => finish());
      expect(await Promise.all(exits)).toEqual([0, 0]);
      expect(errors).toBe("");
      expect(peak).toBe(1);
      expect(calls).toBe(4);
      expect((await pool.query("SELECT status,count(*)::int AS n FROM settings_performance_jobs GROUP BY status ORDER BY status")).rows).toEqual([{ status: "complete", n: 4 }, { status: "queued", n: 8 }]);
      expect((await pool.query("SELECT count(*)::int AS n FROM text_provider_capacity_leases")).rows[0].n).toBe(0);
      expect((await pool.query("SELECT count(*)::int AS n FROM instance_settings_runtime_reports")).rows[0].n).toBe(0);
    } finally {
      release = true; pending.splice(0).forEach((finish) => finish());
      children.forEach((child) => { if (child.exitCode === null) child.kill(); });
      server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done()));
    }
  }, 40000);
});
