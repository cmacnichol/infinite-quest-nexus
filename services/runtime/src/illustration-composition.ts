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
} from "./illustration-platform-adapter.js";
import { runImageJob } from "./illustration-image-job-adapter.js";
import { runIllustrationResolutionJob } from "./illustration-resolution-job-adapter.js";
import { runIllustrationPromptJob } from "./illustration-segment-job-adapter.js";
import { createIllustrationPlatformBindings } from "./illustration-platform-bindings.js";
import { createIllustrationRepositoryFactories } from "./illustration-repository-bindings.js";
import { createIllustrationWorkerStateMachine } from "./illustration-worker-state-adapter.js";
import type { IllustrationProviderCollaborators } from "./provider-application-composition.js";

export type ApiIllustrationCompositionFactories = Readonly<{
  createRepositories(pool: DatabasePool): IllustrationApplicationDependencies;
  createApplication(dependencies: IllustrationApplicationDependencies): IllustrationApplication;
}>;

const apiFactories: ApiIllustrationCompositionFactories = {
  createRepositories: () => {
    throw new Error("Provider collaborators are required.");
  },
  createApplication: createIllustrationApplication
};

export function createApiIllustrationApplication(
  pool: DatabasePool,
  providers: IllustrationProviderCollaborators,
  factories: ApiIllustrationCompositionFactories = apiFactories,
): IllustrationApplication {
  const repositories = factories === apiFactories
    ? createPostgresIllustrationRepositories(pool, createIllustrationRepositoryFactories(providers))
    : factories.createRepositories(pool);
  return factories.createApplication(repositories);
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
    store: FilesystemAssetStore,
    providers: IllustrationProviderCollaborators,
  ): IllustrationWorkerPorts;
  createLanes(
    pool: DatabasePool,
    ports: IllustrationWorkerPorts,
    providers: IllustrationProviderCollaborators,
  ): IllustrationWorkerLanes;
  createState(pool: DatabasePool, lanes: IllustrationWorkerLanes): IllustrationWorkerStateMachinePort;
  createExecutor(state: IllustrationWorkerStateMachinePort): IllustrationWorkerExecutor;
  createApplication(dependencies: IllustrationWorkerApplicationDependencies): IllustrationWorkerApplication;
}>;

export function createIllustrationWorkerPorts(
  pool: DatabasePool,
  store: FilesystemAssetStore,
  providers: IllustrationProviderCollaborators,
): IllustrationWorkerPorts {
  const bindings = createIllustrationPlatformBindings(pool, store, providers);
  return {
    imageProvider: createIllustrationImageProviderAdapter(
      pool,
      bindings.imageProvider,
    ),
    promptRefinement: createIllustrationPromptRefinementAdapter(
      pool,
      bindings.promptRefinement,
    ),
    artifactDownload: createIllustrationArtifactDownloadAdapter(bindings.artifactDownload),
    assets: createIllustrationAssetAdapter(pool, store, bindings.assets),
    costs: bindings.costs
  };
}

const workerFactories: WorkerIllustrationCompositionFactories = {
  createPorts: createIllustrationWorkerPorts,
  createLanes: (pool, ports, providers) => ({
    prompt: (request) => runIllustrationPromptJob(
      pool,
      request.workerId,
      request.leaseSeconds,
      ports.promptRefinement,
      ports.costs,
      providers,
    ),
    resolution: (request) => runIllustrationResolutionJob(
      pool,
      request.workerId,
      request.leaseSeconds,
      providers,
    ),
    image: (request) => runImageJob(
      pool,
      request.workerId,
      request.leaseSeconds,
      ports,
    )
  }),
  createState: createIllustrationWorkerStateMachine,
  createExecutor: createIllustrationWorkerExecutor,
  createApplication: createIllustrationWorkerUseCases
};

export function createWorkerIllustrationApplication(
  pool: DatabasePool,
  store: FilesystemAssetStore,
  providers: IllustrationProviderCollaborators,
  factories: WorkerIllustrationCompositionFactories = workerFactories,
): IllustrationWorkerApplication {
  const ports = factories === workerFactories
    ? createIllustrationWorkerPorts(pool, store, providers)
    : factories.createPorts(pool, store, providers);
  const lanes = factories.createLanes(pool, ports, providers);
  const state = factories.createState(pool, lanes);
  const executor = factories.createExecutor(state);
  return factories.createApplication({ executor, ports, state });
}
