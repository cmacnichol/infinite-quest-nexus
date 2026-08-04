import {
  createIllustrationApplication,
  createIllustrationWorkerApplication as createIllustrationWorkerUseCases,
  type IllustrationApplication,
  type IllustrationApplicationDependencies,
  type IllustrationWorkerApplication,
  type IllustrationWorkerApplicationDependencies,
  type IllustrationWorkerExecutor,
  type IllustrationWorkerStateMachinePort,
  type IllustrationWorkerPorts,
  type IllustrationWorkerRequest
} from "../../../packages/application/src/index.js";
import {
  createPostgresIllustrationRepositories
} from "../../../packages/database/src/illustration-repository.js";
import type { DatabasePool } from "../../../packages/database/src/pool.js";
import type { FilesystemAssetStore } from "../../api/src/asset-service.js";
import {
  createIllustrationArtifactDownloadAdapter,
  createIllustrationAssetAdapter,
  createIllustrationImageProviderAdapter,
  createIllustrationPromptRefinementAdapter
} from "../../api/src/illustration-application-adapter.js";
import { runImageJob } from "./illustration-image-job-adapter.js";
import { runIllustrationResolutionJob } from "./illustration-resolution-job-adapter.js";
import { runIllustrationPromptJob } from "./illustration-segment-job-adapter.js";
import { createIllustrationPlatformBindings } from "./illustration-platform-bindings.js";
import { createIllustrationRepositoryFactories } from "./illustration-repository-bindings.js";
import { createIllustrationWorkerStateMachine } from "./illustration-worker-state-adapter.js";

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
  state: IllustrationWorkerStateMachinePort,
): IllustrationWorkerExecutor {
  return {
    async runNextIllustration(request) {
      if (await state.runPromptHandler(request)) return true;
      if (await state.runResolutionHandler(request)) return true;
      return state.runImageHandler(request);
    }
  };
}

export type WorkerIllustrationCompositionFactories = Readonly<{
  createPorts(
    pool: DatabasePool,
    credentialSecret: string,
    store: FilesystemAssetStore,
  ): IllustrationWorkerPorts;
  createLanes(
    pool: DatabasePool,
    credentialSecret: string,
    store: FilesystemAssetStore,
    ports: IllustrationWorkerPorts,
  ): IllustrationWorkerLanes;
  createState(pool: DatabasePool, lanes: IllustrationWorkerLanes): IllustrationWorkerStateMachinePort;
  createExecutor(state: IllustrationWorkerStateMachinePort): IllustrationWorkerExecutor;
  createApplication(dependencies: IllustrationWorkerApplicationDependencies): IllustrationWorkerApplication;
}>;

export function createIllustrationWorkerPorts(
  pool: DatabasePool,
  credentialSecret: string,
  store: FilesystemAssetStore,
): IllustrationWorkerPorts {
  const bindings = createIllustrationPlatformBindings(pool, credentialSecret, store);
  return {
    imageProvider: createIllustrationImageProviderAdapter(
      pool,
      credentialSecret,
      bindings.imageProvider,
    ),
    promptRefinement: createIllustrationPromptRefinementAdapter(
      pool,
      credentialSecret,
      bindings.promptRefinement,
    ),
    artifactDownload: createIllustrationArtifactDownloadAdapter(bindings.artifactDownload),
    assets: createIllustrationAssetAdapter(pool, store, bindings.assets),
    costs: bindings.costs
  };
}

const workerFactories: WorkerIllustrationCompositionFactories = {
  createPorts: createIllustrationWorkerPorts,
  createLanes: (pool, credentialSecret, store, ports) => ({
    prompt: (request) => runIllustrationPromptJob(
      pool,
      request.workerId,
      request.leaseSeconds,
      credentialSecret,
      ports.promptRefinement,
      ports.costs,
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
      ports,
    )
  }),
  createState: createIllustrationWorkerStateMachine,
  createExecutor: createIllustrationWorkerExecutor,
  createApplication: createIllustrationWorkerUseCases
};

export function createWorkerIllustrationApplication(
  pool: DatabasePool,
  credentialSecret: string,
  store: FilesystemAssetStore,
  factories: WorkerIllustrationCompositionFactories = workerFactories,
): IllustrationWorkerApplication {
  const ports = factories.createPorts(pool, credentialSecret, store);
  const lanes = factories.createLanes(pool, credentialSecret, store, ports);
  const state = factories.createState(pool, lanes);
  const executor = factories.createExecutor(state);
  return factories.createApplication({ executor, ports, state });
}
