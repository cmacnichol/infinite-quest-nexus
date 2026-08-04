import {
  createIllustrationApplication,
  createIllustrationWorkerApplication as createIllustrationWorkerUseCases,
  type IllustrationApplication,
  type IllustrationApplicationDependencies,
  type IllustrationWorkerApplication,
  type IllustrationWorkerExecutor,
  type IllustrationWorkerRequest
} from "../../../packages/application/src/index.js";
import {
  createPostgresIllustrationRepositories
} from "../../../packages/database/src/illustration-repository.js";
import type { DatabasePool } from "../../../packages/database/src/pool.js";
import type { FilesystemAssetStore } from "../../api/src/asset-service.js";
import {
  createIllustrationRepositoryFactories
} from "../../api/src/illustration-application-adapter.js";
import { runImageJob } from "../../api/src/image-service.js";
import { runIllustrationResolutionJob } from "../../api/src/illustration-resolution-service.js";
import { runIllustrationPromptJob } from "../../api/src/segmented-illustration-service.js";

export type ApiIllustrationCompositionFactories = Readonly<{
  createRepositories(pool: DatabasePool): IllustrationApplicationDependencies;
  createApplication(dependencies: IllustrationApplicationDependencies): IllustrationApplication;
}>;

const apiFactories: ApiIllustrationCompositionFactories = {
  createRepositories: (pool) => createPostgresIllustrationRepositories(
    pool,
    createIllustrationRepositoryFactories(),
  ),
  createApplication: createIllustrationApplication
};

export function createApiIllustrationApplication(
  pool: DatabasePool,
  factories: ApiIllustrationCompositionFactories = apiFactories,
): IllustrationApplication {
  return factories.createApplication(factories.createRepositories(pool));
}

export type IllustrationWorkerLanes = Readonly<{
  prompt(request: IllustrationWorkerRequest): Promise<boolean>;
  resolution(request: IllustrationWorkerRequest): Promise<boolean>;
  image(request: IllustrationWorkerRequest): Promise<boolean>;
}>;

export function createIllustrationWorkerExecutor(
  lanes: IllustrationWorkerLanes,
): IllustrationWorkerExecutor {
  return {
    async runNextIllustration(request) {
      if (await lanes.prompt(request)) return true;
      if (await lanes.resolution(request)) return true;
      return lanes.image(request);
    }
  };
}

export type WorkerIllustrationCompositionFactories = Readonly<{
  createLanes(
    pool: DatabasePool,
    credentialSecret: string,
    store: FilesystemAssetStore,
  ): IllustrationWorkerLanes;
  createExecutor(lanes: IllustrationWorkerLanes): IllustrationWorkerExecutor;
  createApplication(executor: IllustrationWorkerExecutor): IllustrationWorkerApplication;
}>;

const workerFactories: WorkerIllustrationCompositionFactories = {
  createLanes: (pool, credentialSecret, store) => ({
    prompt: (request) => runIllustrationPromptJob(
      pool,
      request.workerId,
      request.leaseSeconds,
      credentialSecret,
    ),
    resolution: (request) => runIllustrationResolutionJob(
      pool,
      request.workerId,
      request.leaseSeconds,
    ),
    image: (request) => runImageJob(
      pool,
      request.workerId,
      request.leaseSeconds,
      credentialSecret,
      store,
    )
  }),
  createExecutor: createIllustrationWorkerExecutor,
  createApplication: createIllustrationWorkerUseCases
};

export function createWorkerIllustrationApplication(
  pool: DatabasePool,
  credentialSecret: string,
  store: FilesystemAssetStore,
  factories: WorkerIllustrationCompositionFactories = workerFactories,
): IllustrationWorkerApplication {
  const lanes = factories.createLanes(pool, credentialSecret, store);
  const executor = factories.createExecutor(lanes);
  return factories.createApplication(executor);
}
