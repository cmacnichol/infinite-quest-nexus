import { createHash } from "node:crypto";
import type {
  PrivateFilesystemCandidatePersistencePort,
  PrivateFilesystemPublicationLockPort
} from "../../../packages/application/src/assets/private-filesystem-repository.js";
import type { FinalizedAssetDeliveryResolverPort } from "../../../packages/application/src/assets/private-finalized-delivery.js";
import type {
  PrivateAssetPublicationCommand,
  PrivateAssetPublicationIdentityPort,
  PrivateAssetPublicationResult
} from "../../../packages/application/src/assets/private-asset-publication.js";
import {
  snapshotPrivateAssetPublicationCommand,
  verifyPrivateAssetPublicationContentHashes
} from "../../../packages/application/src/assets/private-asset-publication.js";
import type {
  PrivatePortableExpiryRecoveryPort,
  PrivatePrewriteNodeRepositoryPort
} from "../../../packages/application/src/assets/private-secure-storage.js";
import {
  createDurableFilesystemLifecycle,
  type DurableFilesystemLifecycle
} from "../../../packages/application/src/assets/private-storage-lifecycle.js";
import type { PrivateAtomicPortableIssuancePort } from "../../../packages/application/src/imports/private-portable-authority.js";
import type { PrivatePortableRepositoryPort } from "../../../packages/application/src/imports/private-portable-repository.js";
import type { AssetApplication } from "../../../packages/application/src/assets/ports.js";
import { createPostgresAssetPublicationRepository } from "../../../packages/database/src/asset-publication-repository.js";
import { createPostgresAssetRepositories } from "../../../packages/database/src/asset-repository.js";
import { createPostgresDurableFilesystemRepository } from "../../../packages/database/src/durable-filesystem-repository.js";
import { createPostgresFinalizedAssetDeliveryRepository } from "../../../packages/database/src/finalized-asset-delivery-repository.js";
import { createPostgresImportRepository } from "../../../packages/database/src/import-repository.js";
import { withTransaction, type DatabasePool } from "../../../packages/database/src/pool.js";
import { createPostgresSecureStorageRepository } from "../../../packages/database/src/secure-storage-repository.js";
import {
  createSecureFilesystemAdapter,
  type SecureFilesystemAdapter
} from "../../api/src/portable-archive-filesystem-adapter.js";

export type AssetImportStorageComposition = Readonly<{
  adapter: SecureFilesystemAdapter;
  journal: DurableFilesystemLifecycle;
  candidate: PrivateFilesystemCandidatePersistencePort & PrivateFilesystemPublicationLockPort;
  atomicPortable: PrivateAtomicPortableIssuancePort;
  portable: PrivatePortableRepositoryPort;
  prewrite: PrivatePrewriteNodeRepositoryPort;
  expiryRecovery: PrivatePortableExpiryRecoveryPort;
  finalizedDelivery: FinalizedAssetDeliveryResolverPort;
  close(): Promise<void>;
}>;

/**
 * Additive private graph for 14e3c. It is intentionally unconsumed by API,
 * worker, archive, and illustration code until the later binding checkpoint.
 */
export type AssetPublicationComposition = Readonly<{
  assets: AssetApplication;
  publisher: Readonly<{
    publishAsset(command: PrivateAssetPublicationCommand): Promise<PrivateAssetPublicationResult>;
  }>;
  storage: AssetImportStorageComposition;
  close(): Promise<void>;
}>;

export async function createAssetImportStorageComposition(
  pool: DatabasePool,
  roots: Readonly<{ archiveRoot: string; assetRoot: string }>,
): Promise<AssetImportStorageComposition> {
  const durableRepository = createPostgresDurableFilesystemRepository(pool);
  const journal = createDurableFilesystemLifecycle(durableRepository.journal);
  const secureStorageRepository = createPostgresSecureStorageRepository(pool, durableRepository);
  const importRepository = createPostgresImportRepository(pool);
  const finalizedDeliveryRepository = createPostgresFinalizedAssetDeliveryRepository(pool);
  let adapter: SecureFilesystemAdapter | undefined;
  try {
    adapter = await createSecureFilesystemAdapter({
      archiveRoot: roots.archiveRoot,
      assetRoot: roots.assetRoot,
      journal,
      candidates: durableRepository,
      atomicPortable: secureStorageRepository,
      portable: importRepository,
      prewrite: secureStorageRepository,
      expiry: secureStorageRepository,
      delivery: finalizedDeliveryRepository,
      transactions: Object.freeze({
        run<Result>(work: (database: object) => Promise<Result>): Promise<Result> {
          return withTransaction(pool, (client) => work(client));
        }
      })
    });
    let closed: Promise<void> | undefined;
    const composition: AssetImportStorageComposition = Object.freeze({
      adapter,
      journal,
      candidate: durableRepository,
      atomicPortable: secureStorageRepository,
      portable: importRepository,
      prewrite: secureStorageRepository,
      expiryRecovery: secureStorageRepository,
      finalizedDelivery: finalizedDeliveryRepository,
      close() {
        closed ??= adapter!.close();
        return closed;
      }
    });
    return composition;
  } catch (error) {
    await adapter?.close().catch(() => undefined);
    throw error;
  }
}

export async function createAssetPublicationComposition(
  pool: DatabasePool,
  roots: Readonly<{ archiveRoot: string; assetRoot: string }>,
): Promise<AssetPublicationComposition> {
  const storage = await createAssetImportStorageComposition(pool, roots);
  const dependencies = createPostgresAssetRepositories(pool);
  const publication: PrivateAssetPublicationIdentityPort = createPostgresAssetPublicationRepository(
    pool,
    storage.candidate,
  );
  const assets: AssetApplication = Object.freeze({
    ...dependencies.library,
    ...dependencies.selection,
    ...dependencies.metadata,
    ...dependencies.delivery
  });
  const publisher = Object.freeze({
    async publishAsset(command: PrivateAssetPublicationCommand): Promise<PrivateAssetPublicationResult> {
      const snapshot = snapshotPrivateAssetPublicationCommand(command);
      verifyPrivateAssetPublicationContentHashes(
        snapshot,
        (bytes) => createHash("sha256").update(bytes).digest("hex"),
      );
      const finalizeAttachedPublication = async (
        identity: Awaited<ReturnType<PrivateAssetPublicationIdentityPort["prepareIdentity"]>>,
      ): Promise<PrivateAssetPublicationResult> => {
        if (identity.lifecycle !== "attached" || !identity.result || !identity.finalization) {
          throw new Error("asset_publication_identity_unavailable");
        }
        // Recovery can rotate a claim before finalizing it. Reconcile under
        // the identity lock before using any claim: already-finalized work is
        // published directly, and incomplete work is retried only with its
        // current lease fence.
        const reconciliation = await publication.reconcileAttachedPublication(identity);
        if (reconciliation.outcome === "published") return reconciliation.result;
        if (reconciliation.outcome === "recoverable") {
          throw new Error("asset_publication_finalization_recoverable");
        }
        await storage.adapter.finalizeAssetPublication(reconciliation.identity.finalization!);
        return publication.completePublication(reconciliation.identity);
      };
      const identity = await publication.prepareIdentity(snapshot);
      if (identity.lifecycle === "published") {
        if (!identity.result) throw new Error("asset_publication_result_invalid");
        return identity.result;
      }
      if (identity.lifecycle === "attached") return finalizeAttachedPublication(identity);
      return storage.candidate.withPublicationContentLocks(
        [snapshot.original.contentHash, ...snapshot.derivatives.map((derivative) => derivative.contentHash)],
        async () => {
          // A concurrent same-key publication may have committed while this
          // caller waited for the shared physical-content locks.
          const lockedIdentity = await publication.prepareIdentity(snapshot);
          if (lockedIdentity.lifecycle === "published") {
            if (!lockedIdentity.result) throw new Error("asset_publication_result_invalid");
            return lockedIdentity.result;
          }
          if (lockedIdentity.lifecycle === "attached") return finalizeAttachedPublication(lockedIdentity);
          const prepared = await storage.adapter.prepareAssetPublication(snapshot, lockedIdentity);
          let attached: Awaited<ReturnType<PrivateAssetPublicationIdentityPort["attachPublication"]>>;
          try {
            attached = await withTransaction(pool, (database) => publication.attachPublication(
              database,
              lockedIdentity,
              snapshot,
              prepared,
            ));
          } catch (error) {
            await Promise.allSettled([
              prepared.original.rollback(),
              ...prepared.derivatives.map((derivative) => derivative.rollback())
            ]);
            throw error;
          }
          // Once attachment commits, a finalization fault is durable recovery work;
          // no legacy writer or path fallback may replace this call. The result
          // remains attached-private until this fence pass completes.
          await storage.adapter.finalizeAssetPublication(attached.finalization);
          return publication.completePublication(attached.identity);
        },
      );
    }
  });
  let closed: Promise<void> | undefined;
  return Object.freeze({
    assets,
    publisher,
    storage,
    close() {
      closed ??= storage.close();
      return closed;
    }
  });
}
