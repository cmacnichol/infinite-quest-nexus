import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it } from "vitest";
import { createDatabasePool, initialOwnerId } from "../../packages/database/src/pool.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { createInstanceSettingsRepository } from "../../packages/database/src/instance-settings-repository.js";
import { createSettingsActivationGuard } from "../../services/runtime/src/settings-activation.js";
import { createSeedPolicy, exportSettingsSeed } from "../../services/runtime/src/settings-operator.js";
import { settingsDigest } from "../../services/runtime/src/instance-settings.js";
import { bootstrap } from "../helpers/instance-settings-runtime.js";
// @ts-expect-error Repository tool launcher is JavaScript.
import { tsxCommand } from "../../scripts/node-tool-command.mjs";

async function unusedPort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  await new Promise<void>(done => server.close(() => done()));
  return port;
}

// Production transfer composition requires Linux descriptor-relative filesystem operations.
it.skipIf(process.platform !== "linux")("starts two complete APIs and two workers together and serves through one same-revision API replacement", async () => {
  const db = process.env.TEST_DATABASE_URL!, pool = createDatabasePool(db, 4);
  const directory = await mkdtemp(join(tmpdir(), "iq-settings-topology-"));
  const children: { child: ChildProcess; exit: Promise<number | null> }[] = [];
  let startupError = "";
  try {
    for (const name of ["archives", "assets"]) await mkdir(join(directory, name), { mode: 0o700 });
    await migrateDatabase(pool, resolve("database/migrations"));
    const api = exportSettingsSeed({ ...bootstrap(), role: "api", databaseMaxConnections: 8, systemArchiveEnabled: false });
    const worker = { ...api, role: { ...api.role, role: "worker" as const } };
    const policy = createSeedPolicy([api, api, worker, worker], "00000000-0000-4000-8000-000000000001");
    policy.expectedRoles.find(role => role.role === "api")!.maximumReplicas = 3;
    const file = join(directory, "policy.json");
    await writeFile(file, JSON.stringify(policy));
    const actor = { userId: await initialOwnerId(pool), cliReference: "topology-test" };
    const repo = createInstanceSettingsRepository(pool, { activationGuard: createSettingsActivationGuard(policy) });
    await repo.seed({ actor, installationId: policy.installationId, snapshot: api.snapshot, seedDigest: api.digest, policyDigest: settingsDigest(policy) });
    await repo.activate({ actor, expectedActiveRevision: null, expectedRequestedRevision: "1", maintenanceReference: "test/empty-cluster", policyDigest: settingsDigest(policy) });
    function start(role: "api" | "worker", port: number) {
      const tool = tsxCommand(["tests/helpers/settings-rollout-process.ts"]);
      const child = spawn(tool.executable, tool.arguments, { stdio: ["ignore", "ignore", "ignore", "ipc"], env: {
        ...process.env, APP_ROLE: role, APP_HOST: "127.0.0.1", APP_PORT: String(port), DATABASE_URL: db,
        DATABASE_MAX_CONNECTIONS: "8", INSTANCE_SETTINGS_POLICY_FILE: file, SYSTEM_ARCHIVE_ENABLED: "false",
        ASSET_STORAGE_ROOT: join(directory, "assets"), ARCHIVE_STORAGE_ROOT: join(directory, "archives"),
        CREDENTIAL_ENCRYPTION_KEY: "settings-test-only-key-with-32-bytes", LOG_LEVEL: "info"
      } });
      child.on("message", message => {
        if (typeof message === "object" && message && "startupError" in message) startupError = String(message.startupError);
      });
      const exit = new Promise<number | null>(done => child.once("exit", done));
      children.push({ child, exit });
      return { child, exit };
    }
    async function ready(ports: number[], count: number) {
      const until = Date.now() + 45000;
      while (Date.now() < until) {
        const { rows } = await pool.query("SELECT role,readiness_state,active_revision,activation_epoch FROM instance_settings_runtime_reports");
        if (rows.length === count && rows.every(r => r.readiness_state === "ready" && r.active_revision === "1" && r.activation_epoch === "1")) {
          const ok = await Promise.all(ports.map(port => fetch("http://127.0.0.1:" + port + "/health/ready").then(r => r.ok, () => false)));
          if (ok.every(Boolean)) return rows;
        }
        if (children.some(({ child }) => child.exitCode !== null && child.exitCode !== 0)) throw new Error("fixture runtime exited before readiness: " + startupError);
        await delay(100);
      }
      throw new Error("fixture runtime readiness timed out");
    }
    const ports = [await unusedPort(), await unusedPort(), await unusedPort()];
    const first = start("api", ports[0]!);
    start("api", ports[1]!); start("worker", 8080); start("worker", 8080);
    expect((await ready(ports.slice(0, 2), 4)).map(r => r.role).sort()).toEqual(["api", "api", "worker", "worker"]);
    start("api", ports[2]!);
    expect(await ready(ports, 5)).toHaveLength(5);
    first.child.send("stop");
    expect(await first.exit).toBe(0);
    expect(await ready(ports.slice(1), 4)).toHaveLength(4);
  } finally {
    for (const { child } of children) if (child.connected) child.send("stop");
    const force = setTimeout(() => children.forEach(({ child }) => { if (child.exitCode === null) child.kill(); }), 8000);
    try { await Promise.all(children.map(item => item.exit)); } finally { clearTimeout(force); }
    await pool.end();
    await rm(directory, { recursive: true, force: true });
  }
}, 120000);
