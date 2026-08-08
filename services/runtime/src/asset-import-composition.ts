import type { PrivateFilesystemCandidatePersistencePort } from "../../../packages/application/src/assets/private-filesystem-repository.js";
import type { FinalizedAssetDeliveryResolverPort } from "../../../packages/application/src/assets/private-finalized-delivery.js";
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
  candidate: PrivateFilesystemCandidatePersistencePort;
  atomicPortable: PrivateAtomicPortableIssuancePort;
  portable: PrivatePortableRepositoryPort;
  prewrite: PrivatePrewriteNodeRepositoryPort;
  expiryRecovery: PrivatePortableExpiryRecoveryPort;
  finalizedDelivery: FinalizedAssetDeliveryResolverPort;
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
