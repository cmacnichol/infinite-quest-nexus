import { createHash } from "node:crypto";
import type {
  PrivateFilesystemCandidatePersistencePort,
  PrivateFilesystemPublicationLockPort
} from "../../../packages/application/src/assets/private-filesystem-repository.js";
import type { FinalizedAssetDeliveryResolverPort } from "../../../packages/application/src/assets/private-finalized-delivery.js";
import type {
  PrivateAssetPublicationCommand,
  PrivateAssetPublicationIdentity,
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
import type { ImportOwnerScope } from "../../../packages/application/src/imports/types.js";
import type {
  PrivateCallerTransactionAssetPublisher,
  PrivateImportedAssetAttachment,
  PrivateReservedImportedAsset
} from "../../../packages/application/src/imports/private-portable-composition.js";
import type { AssetApplication } from "../../../packages/application/src/assets/ports.js";
import { createPostgresAssetPublicationRepository } from "../../../packages/database/src/asset-publication-repository.js";
import { createPostgresAssetRepositories } from "../../../packages/database/src/asset-repository.js";
import { createPostgresDurableFilesystemRepository } from "../../../packages/database/src/durable-filesystem-repository.js";
import { createPostgresFinalizedAssetDeliveryRepository } from "../../../packages/database/src/finalized-asset-delivery-repository.js";
import {
  createPostgresImportRepository,
  type PostgresPortableImportRepository
} from "../../../packages/database/src/import-repository.js";
import { withTransaction, type DatabaseClient, type DatabasePool } from "../../../packages/database/src/pool.js";
import { createPostgresSecureStorageRepository } from "../../../packages/database/src/secure-storage-repository.js";
import {
  createSecureFilesystemAdapter,
  type SecureFilesystemAdapter
} from "./secure-filesystem-adapter.js";

export type AssetImportStorageComposition = Readonly<{
  adapter: SecureFilesystemAdapter;
  journal: DurableFilesystemLifecycle;
  candidate: PrivateFilesystemCandidatePersistencePort & PrivateFilesystemPublicationLockPort;
  atomicPortable: PrivateAtomicPortableIssuancePort;
  portable: PostgresPortableImportRepository;
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
  transactionalPublisher: PrivateCallerTransactionAssetPublisher;
  storage: AssetImportStorageComposition;
  close(): Promise<void>;
}>;

export async function createAssetImportStorageComposition(
  pool: DatabasePool,
  roots: Readonly<{ archiveRoot: string; assetRoot: string }>,
  capturePublicationIdentity?: (publication: PrivateAssetPublicationIdentityPort) => void,
): Promise<AssetImportStorageComposition> {
  const durableRepository = createPostgresDurableFilesystemRepository(pool);
  const journal = createDurableFilesystemLifecycle(durableRepository.journal);
  const secureStorageRepository = createPostgresSecureStorageRepository(pool, durableRepository);
  const importRepository = createPostgresImportRepository(pool);
  const finalizedDeliveryRepository = createPostgresFinalizedAssetDeliveryRepository(pool);
  // Consumers that only need secure storage (for example e5's existing-asset
  // derivative backfill) must not instantiate the legacy 0060 publisher.
  const publicationIdentity = capturePublicationIdentity
    ? createPostgresAssetPublicationRepository(pool, durableRepository)
    : undefined;
  let adapter: SecureFilesystemAdapter | undefined;
  try {
    adapter = await createSecureFilesystemAdapter({
      archiveRoot: roots.archiveRoot,
      assetRoot: roots.assetRoot,
      journal,
      candidates: durableRepository,
      publicationCleanup: durableRepository,
      atomicPortable: secureStorageRepository,
      portable: importRepository,
      portablePreview: importRepository,
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
    if (publicationIdentity) capturePublicationIdentity?.(publicationIdentity);
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
  let capturedPublication: PrivateAssetPublicationIdentityPort | undefined;
  const storage = await createAssetImportStorageComposition(
    pool,
    roots,
    (captured) => { capturedPublication = captured; },
  );
  if (!capturedPublication) {
    await storage.close();
    throw new Error("asset_publication_composition_unavailable");
  }
  const publication = capturedPublication;
  const dependencies = createPostgresAssetRepositories(pool);
  const assets: AssetApplication = Object.freeze({
    ...dependencies.library,
    ...dependencies.selection,
    ...dependencies.metadata,
    ...dependencies.delivery
  });
  const existingAttachment = async (
    identity: PrivateAssetPublicationIdentity,
  ): Promise<PrivateImportedAssetAttachment> => {
    if (identity.lifecycle === "published") {
      if (!identity.result) throw new Error("asset_publication_result_invalid");
      return Object.freeze({
        identity,
        result: identity.result,
        finalization: Object.freeze([]),
        async rollback() {}
      });
    }
    if (identity.lifecycle !== "attached" || !identity.result || !identity.finalization) {
      throw new Error("asset_publication_identity_unavailable");
    }
    const reconciliation = await publication.reconcileAttachedPublication(identity);
    if (reconciliation.outcome === "published") {
      return Object.freeze({
        identity,
        result: reconciliation.result,
        finalization: Object.freeze([]),
        async rollback() {}
      });
    }
    if (reconciliation.outcome === "recoverable"
      || !reconciliation.identity.result
      || !reconciliation.identity.finalization) {
      throw new Error("asset_publication_finalization_recoverable");
    }
    return Object.freeze({
      identity: reconciliation.identity,
      result: reconciliation.identity.result,
      finalization: reconciliation.identity.finalization,
      async rollback() {}
    });
  };
  const snapshotCommands = (
    commands: readonly PrivateAssetPublicationCommand[],
  ): readonly PrivateAssetPublicationCommand[] => commands.map((command) => {
    const snapshot = snapshotPrivateAssetPublicationCommand(command);
    verifyPrivateAssetPublicationContentHashes(
      snapshot,
      (bytes) => createHash("sha256").update(bytes).digest("hex"),
    );
    return snapshot;
  });
  const discardPreparedReservations = async (
    database: DatabaseClient,
    reservations: readonly PrivateReservedImportedAsset[],
  ): Promise<void> => {
    for (const reservation of reservations) {
      if (reservation.identity.lifecycle === "prepared") {
        await publication.discardPreparedIdentityInTransaction(
          database,
          reservation.identity,
          reservation.command,
        );
      }
    }
  };
  const transactionalPublisher: PrivateCallerTransactionAssetPublisher = Object.freeze({
    async reserveImportedAssets(
      commands: readonly PrivateAssetPublicationCommand[],
    ) {
      const reservations: PrivateReservedImportedAsset[] = [];
      try {
        for (const snapshot of snapshotCommands(commands)) {
          reservations.push(Object.freeze({
            command: snapshot,
            identity: await publication.prepareIdentity(snapshot)
          }));
        }
      } catch (error) {
        try {
          await withTransaction(pool, (database) => discardPreparedReservations(database, reservations));
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            `${error instanceof Error ? error.message : "asset_publication_reservation_failed"}; asset reservation cleanup failed`,
          );
        }
        throw error;
      }
      return Object.freeze(reservations);
    },
    async reserveImportedAssetsInTransaction(
      database: DatabaseClient,
      commands: readonly PrivateAssetPublicationCommand[],
    ) {
      const reservations: PrivateReservedImportedAsset[] = [];
      for (const snapshot of snapshotCommands(commands)) {
        reservations.push(Object.freeze({
          command: snapshot,
          identity: await publication.prepareIdentityInTransaction(database, snapshot)
        }));
      }
      return Object.freeze(reservations);
    },
    async attachImportedAssets(
      database: DatabaseClient,
      reservations: readonly PrivateReservedImportedAsset[],
    ) {
      if (reservations.length === 0) return Object.freeze([]);
      await storage.candidate.lockPublicationContent(
        database,
        reservations.flatMap(({ command }) => [
          command.original.contentHash,
          ...command.derivatives.map((derivative) => derivative.contentHash)
        ]),
      );
      const attachments: PrivateImportedAssetAttachment[] = [];
      try {
        for (const reservation of reservations) {
          const snapshot = reservation.command;
          const identity = await publication.prepareIdentityInTransaction(database, snapshot);
          if (identity.assetId !== reservation.identity.assetId
            || identity.ownerUserId !== reservation.identity.ownerUserId) {
            throw new Error("asset_publication_identity_mismatch");
          }
          if (identity.lifecycle !== "prepared") {
            attachments.push(await existingAttachment(identity));
            continue;
          }
          const prepared = await storage.adapter.prepareAssetPublication(snapshot, identity);
          const rollback = async (): Promise<void> => {
            await Promise.allSettled([
              prepared.original.rollback(),
              ...prepared.derivatives.map((derivative) => derivative.rollback())
            ]);
          };
          try {
            const attached = await publication.attachPublication(database, identity, snapshot, prepared);
            attachments.push(Object.freeze({
              identity: attached.identity,
              result: attached.result,
              finalization: attached.finalization,
              rollback
            }));
          } catch (error) {
            await rollback();
            throw error;
          }
        }
        return Object.freeze(attachments);
      } catch (error) {
        await Promise.allSettled(attachments.map((attachment) => attachment.rollback()));
        throw error;
      }
    },
    async discardPreparedImportedAssets(
      database: DatabaseClient,
      reservations: readonly PrivateReservedImportedAsset[],
    ) {
      await discardPreparedReservations(database, reservations);
    },
    async recoverImportedAssets(
      owner: ImportOwnerScope,
      assetIds: readonly string[],
      recovery: Readonly<{ leaseOwner: string; leaseSeconds: number }>,
    ) {
      const identities = await publication.readPublicationIdentities(
        owner.ownerUserId,
        assetIds,
      );
      for (const identity of identities) {
        if (identity.lifecycle === "published") continue;
        const reconciliation = await publication.reconcileAttachedPublication(identity, recovery);
        if (reconciliation.outcome === "published") continue;
        if (reconciliation.outcome === "recoverable") {
          throw new Error("asset_publication_finalization_recoverable");
        }
        await storage.adapter.finalizeAssetPublication(reconciliation.identity.finalization!);
        await publication.completePublication(reconciliation.identity);
      }
    },
    async finalizeImportedAssets(attachments: readonly PrivateImportedAssetAttachment[]) {
      for (const attachment of attachments) {
        if (attachment.finalization.length === 0) continue;
        await storage.adapter.finalizeAssetPublication(attachment.finalization);
        const result = await publication.completePublication(attachment.identity);
        if (result.assetId !== attachment.result.assetId
          || result.contentHash !== attachment.result.contentHash) {
          throw new Error("asset_publication_result_mismatch");
        }
      }
    }
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
    transactionalPublisher,
    storage,
    close() {
      closed ??= storage.close();
      return closed;
    }
  });
}
