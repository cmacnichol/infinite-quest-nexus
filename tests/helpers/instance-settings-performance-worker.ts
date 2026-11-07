import { createDatabasePool } from "../../packages/database/src/pool.js";
import { loadActiveRuntimeSettings, registerSettingsRuntime } from "../../services/runtime/src/instance-settings.js";
import { runWorker } from "../../services/worker/src/worker.js";
import { createSharedTextProviderCapacity } from "../../services/runtime/src/text-provider-capacity.js";
import { createTextProviderCapacityRepository } from "../../packages/database/src/text-provider-capacity-repository.js";
import { bootstrap, runtimePolicy } from "./instance-settings-runtime.js";
import { inertWorkerIllustration, inertWorkerMemory } from "./memory-applications.js";
import { adoptRuntimeLoggerSettings, logger } from "../../packages/logger/src/index.js";
import type { GenerationWorkerApplication } from "../../packages/application/src/index.js";

const pool = createDatabasePool(process.env.TEST_DATABASE_URL!, 8);
const config = { ...bootstrap(), databaseMaxConnections: 8, castEditingEnabled: true, castDiscoveryEnabled: true };
const policy = { ...runtimePolicy(), expectedRoles: [{ role: "worker" as const, replicas: 2, databaseMaxConnections: 8 }] };
const resolved = await loadActiveRuntimeSettings(pool, config, policy);
adoptRuntimeLoggerSettings(resolved.config);
const controller = new AbortController();
const snapshot = () => ({ digest: resolved.effectiveDigest, level: logger.level, slots: resolved.config.workerGenerationConcurrency, poll: resolved.config.workerPollIntervalMs, sharedCapacity: resolved.config.textProviderConcurrency });
process.on("message", (message) => {
  if (message === "stop") controller.abort();
  if (message === "inspect") process.send?.({ event: "active", ...snapshot() });
});
const registration = await registerSettingsRuntime(pool, resolved, controller.signal, () => controller.abort(), policy);
const capacity = createSharedTextProviderCapacity(createTextProviderCapacityRepository(pool), resolved.config.textProviderConcurrency!);
const generation = {
  async claimNext() {
    const result = await pool.query("UPDATE settings_performance_jobs SET status='claimed' WHERE id=(SELECT id FROM settings_performance_jobs WHERE status='queued' ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING id");
    if (!result.rows.length) return null;
    process.send?.({ event: "claim" });
    return { jobId: String(result.rows[0].id) };
  },
  async executeClaimed({ claim }: { claim: { jobId: string } }) {
    await capacity.execute({ timeoutMs: 15000 }, async () => {
      const response = await fetch(process.env.PERFORMANCE_PROVIDER_URL!);
      if (await response.text() !== "accepted fiction") throw new Error("provider_fixture_failure");
    });
    await pool.query("UPDATE settings_performance_jobs SET status='complete' WHERE id=$1", [claim.jobId]);
    return true;
  }
} as unknown as GenerationWorkerApplication;
try {
  await registration.waitUntilCompatible();
  await registration.markReady();
  process.send?.({ event: "ready", ...snapshot() });
  await runWorker(pool, resolved.config, controller.signal, { generation, illustration: inertWorkerIllustration, memory: inertWorkerMemory,
    optionalLanes: Object.fromEntries(["illustration", "chronicle", "asset"].map((lane) => [lane, async () => { process.send?.({ event: "lane", lane }); return false; }])) as never });
} finally {
  await registration.dispose();
  await pool.end();
  process.disconnect?.();
}
