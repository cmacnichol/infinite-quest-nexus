import { hostname } from "node:os";
import type {
  GenerationWorkerApplication,
  IllustrationWorkerApplication,
  MemoryWorkerApplication
} from "../../../packages/application/src/index.js";
import type { RuntimeConfig } from "../../../packages/database/src/config.js";
import type { DatabasePool } from "../../../packages/database/src/pool.js";
import { archiveErrorCodeSchema } from "../../../packages/contracts/src/archives.js";
import { logger } from "../../../packages/logger/src/index.js";
import {
  createPrivateAssetMaintenanceComposition,
  type PrivateAssetMaintenanceComposition
} from "../../runtime/src/private-asset-maintenance-composition.js";
import {
  createPrivateIllustrationAssetPublicationComposition,
  type PrivateIllustrationAssetPublicationComposition
} from "../../runtime/src/illustration-asset-publication-composition.js";
import { runImageJob } from "../../runtime/src/illustration-image-job-adapter.js";
import {
  createProductionSystemArchiveWorkerLane,
  type ProductionSystemArchiveWorkerLane,
} from "./system-archive-worker.js";

export type WorkerDependencies = Readonly<{
  generation: GenerationWorkerApplication;
  illustration: IllustrationWorkerApplication;
  memory: MemoryWorkerApplication;
  optionalLanes?: WorkerOptionalLanes;
}>;

export type WorkerOptionalLanes = Readonly<{
  illustration(): Promise<boolean>;
  chronicle(): Promise<boolean>;
  asset(): Promise<boolean>;
  systemArchive?(): Promise<boolean>;
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
  name: "illustration" | "chronicle" | "asset" | "system-archive";
  active: Set<Promise<boolean>>;
  nextEligibleAt: number;
  run(): Promise<boolean>;
};

function safeSystemArchiveErrorCode(error: unknown): string {
  const value = typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : "";
  const parsed = archiveErrorCodeSchema.safeParse(value);
  return parsed.success ? parsed.data : "archive-operation-failed";
}

function safeSystemArchiveDiagnostic(error: unknown): string | undefined {
  const value = typeof error === "object" && error !== null && "diagnostic" in error
    ? (error as { diagnostic?: unknown }).diagnostic
    : undefined;
  return typeof value === "string" && /^System Archive [A-Za-z .-]{1,160}$/u.test(value)
    ? value
    : undefined;
}

function defaultOptionalLanes(
  pool: DatabasePool,
  config: RuntimeConfig,
  workerId: string,
  illustration: IllustrationWorkerApplication,
  memory: MemoryWorkerApplication,
  maintenance: PrivateAssetMaintenanceComposition,
  illustrationPublication: PrivateIllustrationAssetPublicationComposition,
  systemArchive: ProductionSystemArchiveWorkerLane | undefined,
  signal: AbortSignal,
): WorkerOptionalLanes {
  return {
    illustration: async () => {
      const request = { workerId, leaseSeconds: config.workerLeaseSeconds };
      const recovered = await illustrationPublication.coordinator.recoverNextFinalization(request);
      if (recovered.outcome !== "noop") return true;
      if (await illustration.runPromptHandler(request)) return true;
      if (await illustration.runResolutionHandler(request)) return true;
      return runImageJob(pool, workerId, config.workerLeaseSeconds, {
        imageProvider: illustration,
        promptRefinement: illustration,
        artifactDownload: illustration,
        costs: { recordIllustrationCost: async () => null }
      }, illustrationPublication.coordinator);
    },
    chronicle: () => memory.runNextChronicle({
      workerId,
      leaseSeconds: config.workerLeaseSeconds,
      retrieval: { batchLimit: 100 }
    }),
    asset: async () => {
      const result = await maintenance.scheduler.tick({
        workerId,
        leaseSeconds: config.workerLeaseSeconds,
        signal
      });
      return result.completed > 0;
    },
    ...(systemArchive === undefined ? {} : { systemArchive: systemArchive.runNext }),
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
  { generation, illustration, memory, optionalLanes: injectedOptionalLanes }: WorkerDependencies
): Promise<void> {
  const workerId = `${hostname()}:${process.pid}:${crypto.randomUUID().slice(0, 8)}`;
  logger.info({ event: "worker_started", workerId });

  let maintenance: PrivateAssetMaintenanceComposition | undefined;
  let illustrationPublication: PrivateIllustrationAssetPublicationComposition | undefined;
  let systemArchive: ProductionSystemArchiveWorkerLane | undefined;
  try {
    maintenance = injectedOptionalLanes
      ? undefined
      : await createPrivateAssetMaintenanceComposition(pool, {
        archiveRoot: config.archiveStorageRoot,
        assetRoot: config.assetStorageRoot
      });
    illustrationPublication = injectedOptionalLanes
      ? undefined
      : await createPrivateIllustrationAssetPublicationComposition(
        pool,
        { archiveRoot: config.archiveStorageRoot, assetRoot: config.assetStorageRoot },
        { downloadArtifact: (input) => illustration.downloadArtifact(input) }
      );
    systemArchive = injectedOptionalLanes || config.systemArchiveEnabled !== true
      ? undefined
      : await createProductionSystemArchiveWorkerLane({ pool, config, workerId });
  } catch (error) {
    await Promise.allSettled([
      systemArchive?.close(),
      illustrationPublication?.close(),
      maintenance?.close()
    ]);
    throw error;
  }
  const activeGeneration = new Set<Promise<boolean>>();
  let generationNextEligibleAt = 0;
  const optionalLanes = injectedOptionalLanes ?? defaultOptionalLanes(
    pool,
    config,
    workerId,
    illustration,
    memory,
    maintenance!,
    illustrationPublication!,
    systemArchive,
    signal,
  );
  const lanes: ActiveLane[] = [
    { name: "illustration", active: new Set(), nextEligibleAt: 0, run: optionalLanes.illustration },
    { name: "chronicle", active: new Set(), nextEligibleAt: 0, run: optionalLanes.chronicle },
    { name: "asset", active: new Set(), nextEligibleAt: 0, run: optionalLanes.asset },
    ...(optionalLanes.systemArchive === undefined ? [] : [{
      name: "system-archive" as const,
      active: new Set<Promise<boolean>>(),
      nextEligibleAt: 0,
      run: optionalLanes.systemArchive,
    }]),
  ];

  try {
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
            ...(lane.name === "system-archive"
              ? (() => {
                const diagnostic = safeSystemArchiveDiagnostic(error);
                return {
                  errorCode: safeSystemArchiveErrorCode(error),
                  ...(diagnostic === undefined ? {} : { diagnostic }),
                };
              })()
              : { message: error instanceof Error ? error.message : String(error) })
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
        assetJobs: lanes[2]!.active.size,
        systemArchiveJobs: lanes.find((lane) => lane.name === "system-archive")?.active.size ?? 0,
      });
      await Promise.allSettled(draining);
    }
  } finally {
    const closeTasks = [
      () => illustrationPublication?.close(),
      () => maintenance?.close(),
      () => systemArchive?.close(),
    ];
    const closed = await Promise.allSettled(closeTasks.map(async (close) => close()));
    logger.info({ event: "worker_stopped", workerId });
    const failures = closed.flatMap((result, index) => result.status === "rejected"
      ? [index === 2
        ? Object.assign(new Error("System Archive worker shutdown failed."), {
          code: "archive-operation-failed",
        })
        : result.reason]
      : []);
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Worker resource shutdown failed.");
  }
}
