import type { DurableFilesystemRecoveryRecord } from "../../../packages/application/src/assets/private-storage-lifecycle.js";
import type {
  PrivateFilesystemRecoveryExecutionRequest,
  PrivateFilesystemRecoveryOutcome
} from "../../../packages/application/src/assets/private-filesystem-recovery.js";
import type { DatabasePool } from "../../../packages/database/src/pool.js";
import { createPostgresAssetMetadataBackfillExecutorRepository } from "../../../packages/database/src/asset-metadata-backfill-executor-repository.js";
import { createPostgresFilesystemRecoveryReconciliationRepository } from "../../../packages/database/src/filesystem-recovery-reconciliation-repository.js";
import { createAssetImportStorageComposition } from "./asset-import-composition.js";
import { createPrivateNormalizedAssetPublicationComposition } from "./normalized-asset-publication-composition.js";
import { createPrivatePortableNormalizedAssetPublicationComposition } from "./portable-normalized-asset-publication-composition.js";

function requireRequest(request: PrivateFilesystemRecoveryExecutionRequest): void {
  if (!request.workerId.trim() || request.workerId.length > 512
    || !Number.isInteger(request.leaseSeconds) || request.leaseSeconds < 1 || request.leaseSeconds > 300
    || !Number.isInteger(request.limit) || request.limit < 1 || request.limit > 256) {
    throw new Error("filesystem_recovery_execution_request_invalid");
  }
}

function withClaim(
  recovery: DurableFilesystemRecoveryRecord,
  claim: DurableFilesystemRecoveryRecord["claim"],
): DurableFilesystemRecoveryRecord {
  return Object.freeze({ ...recovery, claim }) as DurableFilesystemRecoveryRecord;
}

export type PrivateFilesystemRecoveryComposition = Readonly<{
  executor: Readonly<{
    processOne(request: PrivateFilesystemRecoveryExecutionRequest): Promise<PrivateFilesystemRecoveryProgress>;
    processAssetOne(request: PrivateFilesystemRecoveryExecutionRequest): Promise<PrivateFilesystemRecoveryProgress>;
    processPortableOne(request: PrivateFilesystemRecoveryExecutionRequest): Promise<PrivateFilesystemRecoveryProgress>;
  }>;
  close(): Promise<void>;
}>;

export type PrivateFilesystemRecoveryProgress = Readonly<{
  claimed: number;
  finalized: number;
  cleaned: number;
  quarantined: number;
  recoverable: number;
  leaseLost: number;
  portableClaimed: number;
  portablePending: number;
}>;

/**
 * Additive e6 runtime graph. It accepts only a worker lease identifier and
 * obtains every operation owner, scope, descriptor, and claim from durable
 * storage. Worker scheduling remains deliberately deferred to e3e7.
 */
export async function createPrivateFilesystemRecoveryComposition(
  pool: DatabasePool,
  roots: Readonly<{ archiveRoot: string; assetRoot: string }>,
  options: Readonly<{
    recoveryHooks?: Parameters<typeof createAssetImportStorageComposition>[3];
  }> = {},
): Promise<PrivateFilesystemRecoveryComposition> {
  const storage = await createAssetImportStorageComposition(pool, roots, undefined, options.recoveryHooks);
  let normalized: Awaited<ReturnType<typeof createPrivateNormalizedAssetPublicationComposition>> | undefined;
  let portable: Awaited<ReturnType<typeof createPrivatePortableNormalizedAssetPublicationComposition>> | undefined;
  try {
    normalized = await createPrivateNormalizedAssetPublicationComposition(pool, roots);
    portable = await createPrivatePortableNormalizedAssetPublicationComposition(pool, roots);
  } catch (error) {
    await normalized?.close().catch(() => undefined);
    await storage.close().catch(() => undefined);
    throw error;
  }
  const reconciliation = createPostgresFilesystemRecoveryReconciliationRepository(pool);
  const metadataBackfill = createPostgresAssetMetadataBackfillExecutorRepository(pool, storage.journal);
  const processOne = async (
    request: PrivateFilesystemRecoveryExecutionRequest,
    scope: "asset" | "portable" | "all" = "all",
  ): Promise<PrivateFilesystemRecoveryProgress> => {
    requireRequest(request);
    const portableRecoveries = scope === "asset" ? [] : await storage.adapter.claimExpiredPortableRecoveries({
      leaseOwner: request.workerId,
      leaseSeconds: request.leaseSeconds,
      limit: request.limit,
    });
    const assetRecoveries = scope === "portable" ? [] : await storage.journal.recover({
      leaseOwner: request.workerId,
      leaseSeconds: request.leaseSeconds,
      limit: request.limit,
      resourceKinds: ["asset"],
    });
    const recoveries = [...portableRecoveries, ...assetRecoveries];
    let finalized = 0;
    let cleaned = 0;
    let quarantined = 0;
    let recoverable = 0;
    let leaseLost = 0;
    let portablePending = 0;
    for (const initialRecovery of recoveries) {
      const isPortable = initialRecovery.operation.resourceKind === "portable";
      const renewed = await storage.journal.heartbeatRecoveryClaim(initialRecovery.claim, request.leaseSeconds);
      if (!renewed) {
        leaseLost += 1;
        continue;
      }
      let recovery = withClaim(initialRecovery, renewed);
      let activeHeartbeat: Promise<void> | undefined;
      let heartbeatLost = false;
      let terminal = false;
      const pulse = (): Promise<void> => {
        activeHeartbeat ??= storage.journal.heartbeatRecoveryClaim(recovery.claim, request.leaseSeconds)
          .then((next) => {
            // The physical adapter may commit its fenced terminal transition
            // while a pulse is in flight. A null renewal after that terminal
            // transition is expected and must not misreport the completed
            // recovery as a lease loss.
            if (!next) {
              if (!terminal) heartbeatLost = true;
              return;
            }
            recovery = withClaim(recovery, next);
          })
          .catch(() => { if (!terminal) heartbeatLost = true; })
          .finally(() => { activeHeartbeat = undefined; });
        return activeHeartbeat;
      };
      const interval = setInterval(() => { void pulse(); }, Math.max(50, Math.floor(request.leaseSeconds * 333)));
      let outcome: PrivateFilesystemRecoveryOutcome;
      try {
        outcome = await storage.adapter.recoverFilesystemOperation(
          recovery,
          () => heartbeatLost ? null : recovery,
        );
        terminal = ["finalized", "cleaned", "quarantined"].includes(outcome.outcome);
      } catch {
        recoverable += 1;
        continue;
      } finally {
        clearInterval(interval);
        await activeHeartbeat;
      }
      if (heartbeatLost || outcome.outcome === "lease_lost") {
        leaseLost += 1;
        if (isPortable) portablePending += 1;
      }
      else if (outcome.outcome === "finalized" || outcome.outcome === "cleaned") {
        if (!isPortable) {
          if (outcome.outcome === "finalized") finalized += 1;
          else cleaned += 1;
        }
        if (isPortable) continue;
        const targets = await reconciliation.targets({
          operationId: recovery.operation.operationId,
          ownerUserId: recovery.operation.ownerUserId,
        });
        for (const operationId of targets.portableFinalizationOperations) {
          const result = await portable!.coordinator.finalizeOperation({
            ownerUserId: recovery.operation.ownerUserId,
            operationId,
            leaseOwner: recovery.claim.leaseOwner,
            leaseSeconds: request.leaseSeconds,
          });
          if (result.outcome === "committed_finalization_pending") recoverable += 1;
        }
        for (const operationId of targets.portableRetirementOperations) {
          const result = await portable!.coordinator.reconcileRetirements({
            ownerUserId: recovery.operation.ownerUserId,
            operationId,
          });
          if (result.pending !== 0) recoverable += 1;
        }
        for (const finalization of targets.normalizedFinalizations) {
          const result = await normalized!.publication.finalize(finalization, {
            leaseOwner: recovery.claim.leaseOwner,
            leaseSeconds: request.leaseSeconds,
          });
          if (result.outcome === "recoverable") recoverable += 1;
        }
        if (outcome.outcome === "finalized" && await metadataBackfill.reconcileFinalizedOperation({
          operationId: recovery.operation.operationId,
          ownerUserId: recovery.operation.ownerUserId,
        }) === "pending") recoverable += 1;
      }
      else if (outcome.outcome === "quarantined") {
        if (isPortable) portablePending += 1;
        else quarantined += 1;
      }
      else if (outcome.outcome === "recoverable") {
        if (isPortable) portablePending += 1;
        else recoverable += 1;
      }
    }
    return Object.freeze({
      claimed: assetRecoveries.length,
      finalized,
      cleaned,
      quarantined,
      recoverable,
      leaseLost,
      portableClaimed: portableRecoveries.length,
      portablePending,
    });
  };
  return Object.freeze({
    executor: Object.freeze({
      processOne,
      processAssetOne: (request: PrivateFilesystemRecoveryExecutionRequest) => processOne(request, "asset"),
      processPortableOne: (request: PrivateFilesystemRecoveryExecutionRequest) => processOne(request, "portable"),
    }),
    close: async () => {
      await Promise.allSettled([storage.close(), normalized!.close(), portable!.close()]);
    },
  });
}
