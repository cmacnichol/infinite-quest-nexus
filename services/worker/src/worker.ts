import { hostname } from "node:os";
import type { RuntimeConfig } from "../../../packages/database/src/config.js";
import type { DatabasePool } from "../../../packages/database/src/pool.js";
import { runChronicleJob } from "../../api/src/memory-service.js";
import { runGenerationJob } from "../../api/src/generation-service.js";
import { runImageJob } from "../../api/src/image-service.js";

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timeout = setTimeout(resolve, milliseconds);
    signal.addEventListener("abort", () => {
      clearTimeout(timeout);
      resolve();
    }, { once: true });
  });
}

export async function runWorker(pool: DatabasePool, config: RuntimeConfig, signal: AbortSignal): Promise<void> {
  const workerId = `${hostname()}:${process.pid}:${crypto.randomUUID().slice(0, 8)}`;
  console.log(JSON.stringify({ event: "worker_started", workerId }));
  while (!signal.aborted) {
    try {
      const generated = await runGenerationJob(pool, workerId, config.workerLeaseSeconds, config.credentialEncryptionKey);
      const illustrated = generated || await runImageJob(
        pool,
        workerId,
        config.workerLeaseSeconds,
        config.credentialEncryptionKey,
        { root: config.assetStorageRoot }
      );
      const worked = generated || illustrated || await runChronicleJob(pool, workerId, config.workerLeaseSeconds, config.credentialEncryptionKey);
      if (!worked) await wait(config.workerPollIntervalMs, signal);
    } catch (error) {
      console.error(JSON.stringify({
        event: "worker_loop_error",
        workerId,
        message: error instanceof Error ? error.message : String(error)
      }));
      await wait(config.workerPollIntervalMs, signal);
    }
  }
  console.log(JSON.stringify({ event: "worker_stopped", workerId }));
}
