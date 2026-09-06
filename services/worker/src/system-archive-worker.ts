import type { ClaimedSystemArchiveJob, SystemArchiveJobRepository } from "../../../packages/database/src/system-archive-job-repository.js";
import { createPostgresSystemArchiveJobRepository } from "../../../packages/database/src/system-archive-job-repository.js";
import type { DatabasePool } from "../../../packages/database/src/pool.js";
import type { RuntimeConfig } from "../../../packages/database/src/config.js";
import { archiveErrorCodeSchema } from "../../../packages/contracts/src/archives.js";
import { createSystemArchiveAssetStorageComposition } from "../../runtime/src/api-asset-composition.js";
import {
  createFilesystemSystemArchiveCapacity,
  createSystemArchiveArtifactPublisher,
  createSystemArchiveComposition,
  createSystemArchiveImportComposition,
  createSystemArchiveOriginalAssetReader,
} from "../../runtime/src/system-archive-composition.js";

export type SystemArchiveWorkerLaneOptions = Readonly<{
  workerId: string;
  leaseSeconds: number;
  jobs: Pick<
    SystemArchiveJobRepository,
    "claimNext" | "heartbeat" | "getJob" | "markCancelled" | "markFailed"
  >;
  exports: Readonly<{
    runSystemExport(job: ClaimedSystemArchiveJob): Promise<unknown>;
  }>;
  imports: Readonly<{
    runSystemImport(job: ClaimedSystemArchiveJob): Promise<void>;
  }>;
}>;

export function safeSystemArchiveWorkerFailureCode(error: unknown): string {
  const value = typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : "";
  const parsed = archiveErrorCodeSchema.safeParse(value);
  return parsed.success ? parsed.data : "archive-operation-failed";
}

export function safeSystemArchiveWorkerDiagnostic(error: unknown): string | undefined {
  return error instanceof Error
    && /^System Archive [A-Za-z .-]{1,160}$/u.test(error.message)
    ? error.message
    : undefined;
}

function safeWorkerError(error: unknown): Error & { code: string; diagnostic?: string } {
  const diagnostic = safeSystemArchiveWorkerDiagnostic(error);
  const sanitized = Object.assign(new Error("System Archive worker operation failed."), {
    code: safeSystemArchiveWorkerFailureCode(error),
    ...(diagnostic === undefined ? {} : { diagnostic }),
  });
  sanitized.name = "SystemArchiveWorkerError";
  return sanitized;
}

function requireOptions(options: SystemArchiveWorkerLaneOptions): void {
  if (!options.workerId.trim()
    || !Number.isSafeInteger(options.leaseSeconds)
    || options.leaseSeconds < 1
    || options.leaseSeconds > 3_600) {
    throw new Error("system_archive_worker_lease_invalid");
  }
}

export function createSystemArchiveWorkerLane(
  options: SystemArchiveWorkerLaneOptions,
): Readonly<{ runNext(): Promise<boolean> }> {
  requireOptions(options);
  return Object.freeze({
    async runNext() {
      const job = await options.jobs.claimNext(options.workerId, options.leaseSeconds);
      if (!job) return false;

      if (job.kind === "import" && job.status === "cancelling") {
        await options.jobs.markCancelled(job.id, options.workerId);
        return true;
      }

      let leaseCurrent = true;
      let stopped = false;
      let heartbeatWork = Promise.resolve();
      const heartbeat = async () => {
        if (stopped || !leaseCurrent) return;
        try {
          leaseCurrent = await options.jobs.heartbeat(
            job.id,
            options.workerId,
            options.leaseSeconds,
          );
        } catch {
          leaseCurrent = false;
        }
      };
      const heartbeatMilliseconds = Math.max(50, Math.floor(options.leaseSeconds * 1_000 / 3));
      const timer = setInterval(() => {
        heartbeatWork = heartbeatWork.then(heartbeat, heartbeat);
      }, heartbeatMilliseconds);
      timer.unref?.();

      try {
        if (job.kind === "export") {
          await options.exports.runSystemExport(job);
        } else {
          await options.imports.runSystemImport(job);
          const visible = await options.jobs.getJob(
            { ownerUserId: job.ownerUserId },
            job.id,
          );
          if (visible.status === "waiting_for_gate") return false;
        }
        return true;
      } catch (error) {
        if (job.kind === "import" && leaseCurrent) {
          try {
            await options.jobs.markCancelled(job.id, options.workerId);
            return true;
          } catch {
            // Cancellation is a durable state transition, not an exception
            // flag. If the row is not cancelling, retain the original failure
            // and let the guarded pre-commit failure transition classify it.
          }
          await options.jobs.markFailed(
            job.id,
            options.workerId,
            safeSystemArchiveWorkerFailureCode(error),
          ).catch(() => undefined);
        }
        throw safeWorkerError(error);
      } finally {
        stopped = true;
        clearInterval(timer);
        await heartbeatWork;
      }
    },
  });
}

export type ProductionSystemArchiveWorkerLane = Readonly<{
  runNext(): Promise<boolean>;
  close(): Promise<void>;
}>;

export async function createProductionSystemArchiveWorkerLane(input: Readonly<{
  pool: DatabasePool;
  config: RuntimeConfig;
  workerId: string;
}>): Promise<ProductionSystemArchiveWorkerLane> {
  const uploadTtlSeconds = input.config.systemArchiveUploadTtlSeconds;
  const chunkBytes = input.config.systemArchiveChunkBytes;
  if (uploadTtlSeconds === undefined || chunkBytes === undefined) {
    throw new Error("system_archive_config_incomplete");
  }
  const resources = await createSystemArchiveAssetStorageComposition(
    input.pool,
    {
      archiveRoot: input.config.archiveStorageRoot,
      assetRoot: input.config.assetStorageRoot,
    },
  );
  const storage = resources.storage;
  try {
    const jobs = createPostgresSystemArchiveJobRepository(input.pool);
    const capacity = createFilesystemSystemArchiveCapacity(
      input.config.archiveStorageRoot,
      input.config.assetStorageRoot,
    );
    const applicationVersion = process.env.NEXUS_VERSION?.trim()
      || process.env.npm_package_version?.trim()
      || "0.1.0";
    const exports = createSystemArchiveComposition({
      pool: input.pool,
      applicationVersion,
      limits: input.config.systemArchiveLimits,
      artifactTtlSeconds: input.config.systemArchiveArtifactTtlSeconds,
      originals: createSystemArchiveOriginalAssetReader({ storage }),
      storage: storage.adapter,
      publisher: createSystemArchiveArtifactPublisher(storage, {
        leaseOwner: input.workerId,
        artifactTtlSeconds: input.config.systemArchiveArtifactTtlSeconds,
      }),
    });
    const imports = createSystemArchiveImportComposition({
      pool: input.pool,
      assetPublications: resources.assetPublications,
      storage: storage.adapter,
      archiveRoot: input.config.archiveStorageRoot,
      capacity,
      limits: input.config.systemArchiveLimits,
      destinationApplicationVersion: applicationVersion,
      uploadTtlSeconds,
      chunkBytes,
      maximumUploadBytes: input.config.systemArchiveLimits.maxCompressedBytes,
      leaseOwner: input.workerId,
      leaseSeconds: Math.min(input.config.workerLeaseSeconds, 300),
      allowUnknownFreeSpace: input.config.systemArchiveAllowUnknownFreeSpace ?? false,
    });
    const lane = createSystemArchiveWorkerLane({
      workerId: input.workerId,
      leaseSeconds: input.config.workerLeaseSeconds,
      jobs,
      exports,
      imports: imports.imports,
    });
    let closed: Promise<void> | undefined;
    return Object.freeze({
      runNext: lane.runNext,
      close() {
        closed ??= resources.close();
        return closed;
      },
    });
  } catch (error) {
    await resources.close().catch(() => undefined);
    throw error;
  }
}
