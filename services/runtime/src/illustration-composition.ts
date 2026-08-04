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
  createIllustrationPromptRefinementAdapter,
  createIllustrationRepositoryFactories
} from "../../api/src/illustration-application-adapter.js";
import { runImageJob } from "../../api/src/image-service.js";
import { runIllustrationResolutionJob } from "../../api/src/illustration-resolution-service.js";
import { runIllustrationPromptJob } from "../../api/src/segmented-illustration-service.js";
import { createIllustrationPlatformBindings } from "./illustration-platform-bindings.js";

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
  ): IllustrationWorkerLanes;
  createState(lanes: IllustrationWorkerLanes): IllustrationWorkerStateMachinePort;
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
    assets: createIllustrationAssetAdapter(pool, store, bindings.assets)
  };
}

function deferredStateMachine(lanes: IllustrationWorkerLanes): IllustrationWorkerStateMachinePort {
  const deferred = async (): Promise<never> => {
    throw new Error("Illustration worker state operations are not live until the Task 14a3 cutover.");
  };
  return {
    claimNextPromptJob: deferred,
    claimNextResolutionJob: deferred,
    claimNextImageJob: deferred,
    loadClaimedJob: deferred,
    heartbeatClaim: deferred,
    transitionClaim: deferred,
    scheduleRetry: deferred,
    resolvePrompt: deferred,
    runPromptHandler: lanes.prompt,
    runResolutionHandler: lanes.resolution,
    runImageHandler: lanes.image
  };
}

const workerFactories: WorkerIllustrationCompositionFactories = {
  createPorts: createIllustrationWorkerPorts,
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
  createState: deferredStateMachine,
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
  const lanes = factories.createLanes(pool, credentialSecret, store);
  const state = factories.createState(lanes);
  const executor = factories.createExecutor(state);
  return factories.createApplication({ executor, ports, state });
}
