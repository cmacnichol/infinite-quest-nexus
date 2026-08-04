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
  optionalLanes?: WorkerOptionalLanes;
}>;

export type WorkerOptionalLanes = Readonly<{
  illustration(): Promise<boolean>;
  chronicle(): Promise<boolean>;
  asset(): Promise<boolean>;
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

type DisposableWait = Readonly<{
  promise: Promise<void>;
  dispose(): void;
}>;

function createDisposableWait(milliseconds: number, signal: AbortSignal): DisposableWait {
  let dispose: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    let settled = false;
    let timeout!: ReturnType<typeof setTimeout>;
    const settle = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal.removeEventListener("abort", settle);
      resolve();
    };
    timeout = setTimeout(settle, milliseconds);
    signal.addEventListener("abort", settle, { once: true });
    dispose = settle;
  });
  return { promise, dispose: () => dispose() };
}

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  return createDisposableWait(milliseconds, signal).promise;
}

type ActiveLane = {
  name: "illustration" | "chronicle" | "asset";
  active: Set<Promise<boolean>>;
  nextEligibleAt: number;
  run(): Promise<boolean>;
};

function defaultOptionalLanes(
  pool: DatabasePool,
  config: RuntimeConfig,
  workerId: string
): WorkerOptionalLanes {
  return {
    async illustration() {
      if (await runIllustrationPromptJob(
        pool,
        workerId,
        config.workerLeaseSeconds,
        config.credentialEncryptionKey
      )) return true;
      if (await runIllustrationResolutionJob(pool, workerId, config.workerLeaseSeconds)) return true;
      return runImageJob(
        pool,
        workerId,
        config.workerLeaseSeconds,
        config.credentialEncryptionKey,
        { root: config.assetStorageRoot }
      );
    },
    chronicle: () => runChronicleJob(
      pool,
      workerId,
      config.workerLeaseSeconds,
      config.credentialEncryptionKey
    ),
    asset: () => runAssetMetadataBackfill(pool, { root: config.assetStorageRoot })
  };
}

function lanePromises(
  activeGeneration: ReadonlySet<Promise<boolean>>,
  lanes: readonly ActiveLane[]
): Promise<boolean>[] {
  return [
    ...activeGeneration,
    ...lanes.flatMap((lane) => [...lane.active])
  ];
}

function laneWaitMilliseconds(
  pollIntervalMs: number,
  generationNextEligibleAt: number,
  lanes: readonly ActiveLane[]
): number {
  const now = Date.now();
  const eligibleTimes = [generationNextEligibleAt, ...lanes.map((lane) => lane.nextEligibleAt)]
    .filter((eligibleAt) => eligibleAt > now);
  if (eligibleTimes.length === 0) return pollIntervalMs;
  return Math.max(1, Math.min(pollIntervalMs, Math.min(...eligibleTimes) - now));
}

export async function runWorker(
  pool: DatabasePool,
  config: RuntimeConfig,
  signal: AbortSignal,
  { generation, optionalLanes: injectedOptionalLanes }: WorkerDependencies
): Promise<void> {
  const workerId = `${hostname()}:${process.pid}:${crypto.randomUUID().slice(0, 8)}`;
  logger.info({ event: "worker_started", workerId });

  const activeGeneration = new Set<Promise<boolean>>();
  let generationNextEligibleAt = 0;
  const optionalLanes = injectedOptionalLanes ?? defaultOptionalLanes(pool, config, workerId);
  const lanes: ActiveLane[] = [
    { name: "illustration", active: new Set(), nextEligibleAt: 0, run: optionalLanes.illustration },
    { name: "chronicle", active: new Set(), nextEligibleAt: 0, run: optionalLanes.chronicle },
    { name: "asset", active: new Set(), nextEligibleAt: 0, run: optionalLanes.asset }
  ];

  while (!signal.aborted) {
    const now = Date.now();

    // Generation is visited once per rotation and receives at most one claim
    // attempt for each slot that was free at the start of this visit.
    if (now >= generationNextEligibleAt) {
      const freeGenerationSlots = Math.max(
        0,
        config.workerGenerationConcurrency - activeGeneration.size
      );
      for (let slot = 0; slot < freeGenerationSlots && !signal.aborted; slot += 1) {
        try {
          const started = await startNextGeneration(
            generation,
            workerId,
            config.workerLeaseSeconds
          );
          if (!started) {
            generationNextEligibleAt = Date.now() + config.workerPollIntervalMs;
            break;
          }
          generationNextEligibleAt = 0;
          let tracked!: Promise<boolean>;
          tracked = started.execution
            .catch((error) => {
              logger.error({
                event: "worker_generation_error",
                workerId,
                generationJobId: started.jobId,
                message: error instanceof Error ? error.message : String(error)
              });
              return false;
            })
            .finally(() => {
              activeGeneration.delete(tracked);
              generationNextEligibleAt = 0;
            });
          activeGeneration.add(tracked);
        } catch (error) {
          generationNextEligibleAt = Date.now() + config.workerPollIntervalMs;
          logger.error({
            event: "worker_generation_claim_error",
            workerId,
            message: error instanceof Error ? error.message : String(error)
          });
          break;
        }
      }
    }

    // Each optional lane is independently bounded at one active promise. A
    // lane that finds no work waits for the poll interval, while completed
    // work is eligible for immediate refill on the next full rotation.
    for (const lane of lanes) {
      if (signal.aborted || lane.active.size > 0 || Date.now() < lane.nextEligibleAt) continue;
      let tracked!: Promise<boolean>;
      tracked = Promise.resolve()
        .then(() => lane.run())
        .then((worked) => {
          lane.nextEligibleAt = worked ? 0 : Date.now() + config.workerPollIntervalMs;
          return worked;
        })
        .catch((error) => {
          lane.nextEligibleAt = Date.now() + config.workerPollIntervalMs;
          logger.error({
            event: `worker_${lane.name}_error`,
            workerId,
            message: error instanceof Error ? error.message : String(error)
          });
          return false;
        })
        .finally(() => { lane.active.delete(tracked); });
      lane.active.add(tracked);
    }

    if (signal.aborted) break;
    const active = lanePromises(activeGeneration, lanes);
    const waitMilliseconds = laneWaitMilliseconds(
      config.workerPollIntervalMs,
      generationNextEligibleAt,
      lanes
    );
    if (active.length === 0) {
      await wait(waitMilliseconds, signal);
    } else {
      const pollWait = createDisposableWait(waitMilliseconds, signal);
      try {
        await Promise.race([
          ...active,
          pollWait.promise.then(() => false)
        ]);
      } finally {
        pollWait.dispose();
      }
      // A lane may complete synchronously (for example, a local queue scan or
      // deterministic provider double). Yield one macrotask so timers, abort,
      // and other replicas are not starved by an all-microtask refill loop.
      if (!signal.aborted) await wait(0, signal);
    }
  }

  const draining = lanePromises(activeGeneration, lanes);
  if (draining.length > 0) {
    logger.info({
      event: "worker_draining_jobs",
      workerId,
      generationJobs: activeGeneration.size,
      illustrationJobs: lanes[0]!.active.size,
      chronicleJobs: lanes[1]!.active.size,
      assetJobs: lanes[2]!.active.size
    });
    await Promise.allSettled(draining);
  }
  logger.info({ event: "worker_stopped", workerId });
}
