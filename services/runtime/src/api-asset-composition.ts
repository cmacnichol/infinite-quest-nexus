import {
  createAssetApplication,
  type AssetApplication,
  type AssetApplicationDependencies,
} from "../../../packages/application/src/assets/index.js";
import type { PrivateAssetPublicationIdentityPort } from "../../../packages/application/src/assets/private-asset-publication.js";
import { createPostgresAssetRepositories } from "../../../packages/database/src/asset-repository.js";
import type { DatabasePool } from "../../../packages/database/src/pool.js";
import {
  createAssetImportStorageComposition,
  type AssetImportStorageComposition,
} from "./asset-import-composition.js";

export type ApiAssetComposition = Readonly<{
  assets: AssetApplication;
  storage: AssetImportStorageComposition;
  close(): Promise<void>;
}>;

export type ApiAssetCompositionFactories = Readonly<{
  createRepositories(pool: DatabasePool): AssetApplicationDependencies;
  createApplication(dependencies: AssetApplicationDependencies): AssetApplication;
  createStorage(
    pool: DatabasePool,
    roots: Readonly<{ archiveRoot: string; assetRoot: string }>,
    capturePublicationIdentity?: (publication: PrivateAssetPublicationIdentityPort) => void,
  ): Promise<AssetImportStorageComposition>;
}>;

const defaultFactories: ApiAssetCompositionFactories = Object.freeze({
  createRepositories: createPostgresAssetRepositories,
  createApplication: createAssetApplication,
  createStorage: createAssetImportStorageComposition,
});

/**
 * The e3g API binding combines owner-scoped PostgreSQL asset ports with the
 * descriptor-anchored storage adapter. Fastify owns HTTP parsing, response
 * streaming, and server-side identity resolution; this composition owns the
 * closeable runtime resources only.
 */
export async function createApiAssetComposition(
  pool: DatabasePool,
  roots: Readonly<{ archiveRoot: string; assetRoot: string }>,
  factories: ApiAssetCompositionFactories = defaultFactories,
): Promise<ApiAssetComposition> {
  const storage = await factories.createStorage(pool, roots);
  try {
    const assets = factories.createApplication(factories.createRepositories(pool));
    let closed: Promise<void> | undefined;
    return Object.freeze({
      assets,
      storage,
      close() {
        closed ??= storage.close();
        return closed;
      },
    });
  } catch (error) {
    await storage.close().catch(() => undefined);
    throw error;
  }
}

export type SystemArchiveAssetStorageComposition = Readonly<{
  storage: AssetImportStorageComposition;
  assetPublications: PrivateAssetPublicationIdentityPort;
  close(): Promise<void>;
}>;

/**
 * System Import needs both descriptor-anchored storage and the transactional
 * Original Asset publication authority. Keep their concrete construction at
 * the existing canonical storage checkpoint instead of exposing factories to
 * worker code.
 */
export async function createSystemArchiveAssetStorageComposition(
  pool: DatabasePool,
  roots: Readonly<{ archiveRoot: string; assetRoot: string }>,
  factories: Pick<ApiAssetCompositionFactories, "createStorage"> = defaultFactories,
): Promise<SystemArchiveAssetStorageComposition> {
  let assetPublications: PrivateAssetPublicationIdentityPort | undefined;
  const storage = await factories.createStorage(
    pool,
    roots,
    (captured) => { assetPublications = captured; },
  );
  if (!assetPublications) {
    await storage.close();
    throw new Error("system_archive_asset_publication_unavailable");
  }
  let closed: Promise<void> | undefined;
  return Object.freeze({
    storage,
    assetPublications,
    close() {
      closed ??= storage.close();
      return closed;
    },
  });
}
