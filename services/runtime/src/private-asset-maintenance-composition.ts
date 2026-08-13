import {
  createPrivateAssetMaintenanceScheduler,
  type PrivateAssetMaintenanceProbeResult,
  type PrivateAssetMaintenanceScheduler,
} from "../../../packages/application/src/assets/private-asset-maintenance-scheduler.js";
import type { PrivateAssetMetadataBackfillOutcome } from "../../../packages/application/src/assets/private-metadata-backfill.js";
import type { DatabasePool } from "../../../packages/database/src/pool.js";
import {
  createPrivateAssetMetadataBackfillComposition,
  type PrivateAssetMetadataBackfillComposition,
} from "./private-asset-metadata-backfill-composition.js";
import {
  createPrivateFilesystemRecoveryComposition,
  type PrivateFilesystemRecoveryComposition,
  type PrivateFilesystemRecoveryProgress,
} from "./private-filesystem-recovery-composition.js";

export type PrivateAssetMaintenanceComposition = Readonly<{
  scheduler: PrivateAssetMaintenanceScheduler;
  close(): Promise<void>;
}>;

function metadataResult(result: PrivateAssetMetadataBackfillOutcome): PrivateAssetMaintenanceProbeResult {
  switch (result.outcome) {
    case "idle":
      return Object.freeze({ outcome: "idle" });
    case "completed":
      return Object.freeze({ outcome: "completed" });
    case "recoverable":
    case "failed":
      return Object.freeze({ outcome: result.outcome, diagnosticCodes: Object.freeze([result.diagnosticCode]) });
    case "stale":
    case "lease_lost":
      return Object.freeze({ outcome: "lease_lost" });
  }
}

function recoveryResult(
  progress: PrivateFilesystemRecoveryProgress,
  kind: "asset" | "portable",
): PrivateAssetMaintenanceProbeResult {
  const claimed = kind === "asset" ? progress.claimed : progress.portableClaimed;
  const pending = kind === "asset"
    ? progress.recoverable + progress.quarantined
    : progress.portablePending;
  if (progress.leaseLost > 0) return Object.freeze({ outcome: "lease_lost" });
  if (pending > 0) return Object.freeze({ outcome: "recoverable" });
  if (claimed === 0) return Object.freeze({ outcome: "idle" });
  return Object.freeze({ outcome: "completed" });
}

/**
 * Additive e7 graph: the scheduler has one maintenance unit and composes only
 * the private e5/e6 executors. It remains unbound from the live worker until
 * the later e3g atomic production switch.
 */
export async function createPrivateAssetMaintenanceComposition(
  pool: DatabasePool,
  roots: Readonly<{ archiveRoot: string; assetRoot: string }>,
): Promise<PrivateAssetMaintenanceComposition> {
  let metadata: PrivateAssetMetadataBackfillComposition | undefined;
  let recovery: PrivateFilesystemRecoveryComposition | undefined;
  try {
    metadata = await createPrivateAssetMetadataBackfillComposition(pool, roots);
    recovery = await createPrivateFilesystemRecoveryComposition(pool, roots);
  } catch (error) {
    await Promise.allSettled([metadata?.close(), recovery?.close()]);
    throw error;
  }
  const metadataExecutor = metadata;
  const recoveryExecutor = recovery;
  const scheduler = createPrivateAssetMaintenanceScheduler({
    metadataBackfill: async ({ workerId, leaseSeconds }) => metadataResult(
      await metadataExecutor.executor.processOne({ workerId, leaseSeconds }),
    ),
    assetFilesystemRecovery: async ({ workerId, leaseSeconds }) => recoveryResult(
      await recoveryExecutor.executor.processAssetOne({ workerId, leaseSeconds, limit: 1 }),
      "asset",
    ),
    portableExpiryRecovery: async ({ workerId, leaseSeconds }) => recoveryResult(
      await recoveryExecutor.executor.processPortableOne({ workerId, leaseSeconds, limit: 1 }),
      "portable",
    ),
  });
  return Object.freeze({
    scheduler,
    async close(): Promise<void> {
      scheduler.abort();
      await scheduler.drain();
      await Promise.all([metadataExecutor.close(), recoveryExecutor.close()]);
    },
  });
}
