import { hostname } from "node:os";
import type { GenerationWorkerApplication } from "../../../packages/application/src/index.js";
import type { RuntimeConfig } from "../../../packages/database/src/config.js";
import type { DatabasePool } from "../../../packages/database/src/pool.js";
import { runChronicleJob } from "../../api/src/memory-service.js";
import { runImageJob } from "../../api/src/image-service.js";
import { runIllustrationResolutionJob } from "../../api/src/illustration-resolution-service.js";
import { logger } from "../../../packages/logger/src/index.js";
import { runAssetMetadataBackfill } from "../../api/src/asset-service.js";
import { runIllustrationPromptJob } from "../../api/src/segmented-illustration-service.js";

export type WorkerDependencies = Readonly<{
  generation: GenerationWorkerApplication;
}>;

export type StartedGeneration = Readonly<{
  jobId: string;
  execution: Promise<boolean>;
}>;

export async function startNextGeneration(
  generation: GenerationWorkerApplication,
  workerId: string,
  leaseSeconds: number
): Promise<StartedGeneration | null> {
  const claimed = await generation.claimNext({ workerId, leaseSeconds });
  if (!claimed) return null;

  logger.info({
    event: "turn_generation_claimed",
    generationJobId: claimed.jobId,
    campaignId: claimed.campaignId,
    providerProfileId: claimed.providerProfileId,
    expectedTurnNumber: claimed.expectedTurnNumber,
    operationKind: claimed.operationKind,
    jobAttempt: claimed.attempts,
    workerId,
    leaseSeconds
  });
  return {
    jobId: claimed.jobId,
    execution: generation.executeClaimed({ workerId, leaseSeconds, claim: claimed })
  };
}

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

export async function runWorker(
  pool: DatabasePool,
  config: RuntimeConfig,
  signal: AbortSignal,
  { generation }: WorkerDependencies
): Promise<void> {
  const workerId = `${hostname()}:${process.pid}:${crypto.randomUUID().slice(0, 8)}`;
  logger.info({ event: "worker_started", workerId });

  let activeGeneration: Promise<boolean> | null = null;

  while (!signal.aborted) {
    try {
      // Start a generation job if none is active (runs concurrently)
      if (!activeGeneration) {
        const started = await startNextGeneration(
          generation,
          workerId,
          config.workerLeaseSeconds
        );
        if (started) {
          activeGeneration = started.execution
            .catch((error) => {
              logger.error({
                event: "worker_generation_error",
                workerId,
                generationJobId: started.jobId,
                message: error instanceof Error ? error.message : String(error)
              });
              return false;
            })
            .finally(() => { activeGeneration = null; });
        }
      }

      // Process illustration and image jobs (runs in main loop, concurrent with generation)
      const refined = await runIllustrationPromptJob(pool, workerId, config.workerLeaseSeconds, config.credentialEncryptionKey);
      const resolved = refined || await runIllustrationResolutionJob(pool, workerId, config.workerLeaseSeconds);
      const illustrated = resolved || await runImageJob(
        pool, workerId, config.workerLeaseSeconds, config.credentialEncryptionKey,
        { root: config.assetStorageRoot }
      );
      const chronicled = illustrated || await runChronicleJob(pool, workerId, config.workerLeaseSeconds, config.credentialEncryptionKey);
      const backfilled = chronicled || await runAssetMetadataBackfill(pool, { root: config.assetStorageRoot });

      const worked = refined || resolved || illustrated || chronicled || backfilled;
      if (!worked && !activeGeneration) {
        await wait(config.workerPollIntervalMs, signal);
      } else if (!worked && activeGeneration) {
        // Generation is running but no other work — short wait before checking again
        await wait(Math.min(1000, config.workerPollIntervalMs), signal);
      }
    } catch (error) {
      logger.error({
        event: "worker_loop_error", workerId,
        message: error instanceof Error ? error.message : String(error)
      });
      await wait(config.workerPollIntervalMs, signal);
    }
  }

  // On shutdown, wait for active generation to complete
  if (activeGeneration) {
    logger.info({ event: "worker_draining_generation", workerId });
    await activeGeneration.catch(() => undefined);
  }
  logger.info({ event: "worker_stopped", workerId });
}
