import type {
  GenerationApplication,
  GenerationEventSource,
  GenerationWorkerApplication,
  IllustrationApplication,
  IllustrationWorkerApplication,
  MemoryApplication,
  MemoryWorkerApplication,
  WorldCampaignApplication
  , AuthoringWorkerApplication, AuthoringApplication
} from "../../../packages/application/src/index.js";
import type { DatabasePool, RuntimeConfig } from "../../../packages/database/src/index.js";
import type { BuildServerOptions } from "../../api/src/server.js";
import type { ProviderApiTransportAdapter } from "../../api/src/provider-application-adapter.js";
import type { WorkerDependencies } from "../../worker/src/worker.js";
import type { ProviderTransport } from "../../../packages/story-engine/src/provider-transport.js";
import type {
  ApiProviderApplicationComposition,
  WorkerProviderApplicationComposition
} from "./provider-application-composition.js";
import { logger } from "../../../packages/logger/src/index.js";

type RuntimeServer = {
  listen(options: { host: string; port: number }): Promise<unknown>;
  close(): Promise<void>;
};

export type RuntimeRoleDependencies = Readonly<{
  migrateDatabase(
    pool: DatabasePool,
    migrationDirectory: string,
    options?: { allowMaintenanceMigrations?: boolean }
  ): Promise<string[]>;
  waitForDatabaseMigrations(
    pool: DatabasePool,
    migrationDirectory: string,
    timeoutMs: number
  ): Promise<void>;
  createApiProviders(
    pool: DatabasePool,
    credentialSecret: string,
    transport: ProviderTransport,
    config: RuntimeConfig
  ): ApiProviderApplicationComposition;
  createWorkerProviders(
    pool: DatabasePool,
    credentialSecret: string,
    transport: ProviderTransport,
    config: RuntimeConfig
  ): WorkerProviderApplicationComposition;
  resolveSettings?(pool: DatabasePool, config: RuntimeConfig, signal: AbortSignal): Promise<{config:RuntimeConfig;dispose():Promise<void>;markReady?():Promise<void>;isReady?():Promise<boolean>}>;
  createProviderApiAdapter(composition: ApiProviderApplicationComposition): ProviderApiTransportAdapter;
  createApiGeneration(
    pool: DatabasePool,
    providers: ApiProviderApplicationComposition["generation"],
    operatorConfig: Readonly<{ installedCapability: "r1" | "r2" | "r3" | null; enforceEnabled: boolean }>
  ): GenerationApplication;
  createApiIllustration(
    pool: DatabasePool,
    providers: ApiProviderApplicationComposition["illustration"] | WorkerProviderApplicationComposition["illustration"],
  ): IllustrationApplication;
  createApiMemory(
    pool: DatabasePool,
    providers: ApiProviderApplicationComposition["chronicle"] | WorkerProviderApplicationComposition["chronicle"],
  ): MemoryApplication;
  createApiWorldCampaign(
    pool: DatabasePool,
    dependencies: Readonly<{
      worldGeneration: ApiProviderApplicationComposition["worldGeneration"];
      characterOrganization: ApiProviderApplicationComposition["characterOrganization"];
      chronicle: ApiProviderApplicationComposition["chronicle"];
      generation: Pick<ApiProviderApplicationComposition["generation"], "reads">;
    }>,
  ): WorldCampaignApplication;
  createWorkerIllustration(
    pool: DatabasePool,
    providers: WorkerProviderApplicationComposition["illustration"],
  ): IllustrationWorkerApplication;
  createWorkerMemory(
    pool: DatabasePool,
    providers: WorkerProviderApplicationComposition["chronicle"],
  ): MemoryWorkerApplication;
  createWorkerGeneration(
    pool: DatabasePool,
    illustration: IllustrationApplication,
    memory: MemoryApplication,
    providers: WorkerProviderApplicationComposition["generation"],
  ): GenerationWorkerApplication;
  createWorkerAuthoring(
    pool: DatabasePool,
    providers: WorkerProviderApplicationComposition["worldGeneration"],
    signal: AbortSignal,
  ): AuthoringWorkerApplication;
  createApiAuthoring(pool: DatabasePool): AuthoringApplication;
  createApiCast?(pool: DatabasePool, config: RuntimeConfig,
    providers: ApiProviderApplicationComposition["generation"]): NonNullable<BuildServerOptions["cast"]>;
  createWorkerCastDiscovery?(pool: DatabasePool, config: RuntimeConfig,
    providers: WorkerProviderApplicationComposition["generation"]): NonNullable<WorkerDependencies["castDiscovery"]>;
  buildServer(options: BuildServerOptions): Promise<RuntimeServer>;
  runWorker(
    pool: DatabasePool,
    config: RuntimeConfig,
    signal: AbortSignal,
    dependencies: WorkerDependencies
  ): Promise<void>;
}>;

async function prepareDatabase(
  config: RuntimeConfig,
  pool: DatabasePool,
  dependencies: RuntimeRoleDependencies
): Promise<void> {
  if (config.role === "migrate") {
    const applied = await dependencies.migrateDatabase(
      pool,
      config.migrationDirectory,
      { allowMaintenanceMigrations: true }
    );
    logger.info({ event: "migrations_complete", applied });
    return;
  }

  if (config.role === "worker") {
    await dependencies.waitForDatabaseMigrations(
      pool,
      config.migrationDirectory,
      config.migrationWaitSeconds * 1000
    );
    logger.info({ event: "migrations_verified", role: config.role });
    return;
  }

  const applied = await dependencies.migrateDatabase(
    pool,
    config.migrationDirectory,
    { allowMaintenanceMigrations: config.allowMaintenanceMigrations }
  );
  logger.info({ event: "migrations_complete", role: config.role, applied });
}

async function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

export async function dispatchRuntimeRole(
  bootstrapConfig: RuntimeConfig,
  pool: DatabasePool,
  signal: AbortSignal,
  dependencies: RuntimeRoleDependencies,
  providerTransport: ProviderTransport,
  generationEvents: GenerationEventSource | undefined
): Promise<void> {
  await prepareDatabase(bootstrapConfig, pool, dependencies);
  if (bootstrapConfig.role === "migrate") return;
  const settings = await dependencies.resolveSettings?.(pool, bootstrapConfig, signal);
  const config = settings?.config ?? bootstrapConfig;
  try {
    await dispatchResolvedRuntimeRole(config, pool, signal, dependencies, providerTransport, generationEvents, settings);
  } finally { await settings?.dispose(); }
}

async function dispatchResolvedRuntimeRole(
  config: RuntimeConfig,
  pool: DatabasePool,
  signal: AbortSignal,
  dependencies: RuntimeRoleDependencies,
  providerTransport: ProviderTransport,
  generationEvents: GenerationEventSource | undefined,
  settings: Awaited<ReturnType<NonNullable<RuntimeRoleDependencies["resolveSettings"]>>> | undefined
): Promise<void> {

  if (config.role === "api") {
    if (!generationEvents) throw new Error("The API role requires a generation event source.");
    const providerGraph = dependencies.createApiProviders(
      pool,
      config.credentialEncryptionKey,
      providerTransport, config
    );
    const generation = dependencies.createApiGeneration(pool, providerGraph.generation, {
      installedCapability: config.storyMemoryCapability ?? null,
      enforceEnabled: config.storyMemoryEnforceEnabled === true,
      ...(config.castContextEnabled === true ? { castContextEnabled: true, historyCoverageEnabled: config.historyCoverageEnabled !== false } : {})
    });
    const illustration = dependencies.createApiIllustration(pool, providerGraph.illustration);
    const memory = dependencies.createApiMemory(pool, providerGraph.chronicle);
    const worldCampaign = dependencies.createApiWorldCampaign(pool, providerGraph);
    const authoring = dependencies.createApiAuthoring(pool);
    const providers = dependencies.createProviderApiAdapter(providerGraph);
    const server = await dependencies.buildServer({
      ...(settings?.isReady ? { settingsReadiness: settings.isReady } : {}),
      config, pool, generation, illustration, memory, providers, generationEvents, worldCampaign, authoring,
      infiniteWorldsProviders: providerGraph.infiniteWorlds,
      ...(dependencies.createApiCast ? { cast: dependencies.createApiCast(pool, config, providerGraph.generation) } : {}),
    });
    try {
      await server.listen({ host: config.host, port: config.port });
      await settings?.markReady?.();
      await waitForAbort(signal);
    } finally { await server.close(); }
    return;
  }

  if (config.role === "worker") {
    const providerGraph = dependencies.createWorkerProviders(pool, config.credentialEncryptionKey, providerTransport, config);
    const illustration = dependencies.createApiIllustration(pool, providerGraph.illustration);
    const memory = dependencies.createApiMemory(pool, providerGraph.chronicle);
    const generation = dependencies.createWorkerGeneration(pool, illustration, memory, providerGraph.generation);
    const authoring = dependencies.createWorkerAuthoring(pool, providerGraph.worldGeneration, signal);
    const workerIllustration = dependencies.createWorkerIllustration(
      pool,
      providerGraph.illustration,
    );
    await settings?.markReady?.();
    await dependencies.runWorker(pool, config, signal, {
      generation,
      illustration: workerIllustration,
      generationIllustration: illustration,
      ...(config.castDiscoveryEnabled === true && dependencies.createWorkerCastDiscovery
        ? { castDiscovery: dependencies.createWorkerCastDiscovery(pool, config, providerGraph.generation) } : {}),
      memory: dependencies.createWorkerMemory(pool, providerGraph.chronicle),
      authoring
    });
    return;
  }

  const apiProviderGraph = dependencies.createApiProviders(
    pool,
    config.credentialEncryptionKey,
    providerTransport, config
  );
  const workerProviderGraph = dependencies.createWorkerProviders(pool, config.credentialEncryptionKey, providerTransport, config);
  const apiGeneration = dependencies.createApiGeneration(pool, apiProviderGraph.generation, {
    installedCapability: config.storyMemoryCapability ?? null,
    enforceEnabled: config.storyMemoryEnforceEnabled === true,
    ...(config.castContextEnabled === true ? { castContextEnabled: true, historyCoverageEnabled: config.historyCoverageEnabled !== false } : {})
  });
  const illustration = dependencies.createApiIllustration(pool, apiProviderGraph.illustration);
  const memory = dependencies.createApiMemory(pool, apiProviderGraph.chronicle);
  const workerIllustrationTransactions = dependencies.createApiIllustration(pool, workerProviderGraph.illustration);
  const workerMemoryTransactions = dependencies.createApiMemory(pool, workerProviderGraph.chronicle);
  const worldCampaign = dependencies.createApiWorldCampaign(pool, apiProviderGraph);
  const providers = dependencies.createProviderApiAdapter(apiProviderGraph);
  const apiAuthoring = dependencies.createApiAuthoring(pool);
  if (!generationEvents) throw new Error("The all role requires a generation event source.");
  const workerGeneration = dependencies.createWorkerGeneration(
    pool, workerIllustrationTransactions, workerMemoryTransactions, workerProviderGraph.generation,
  );
  const authoring = dependencies.createWorkerAuthoring(pool, workerProviderGraph.worldGeneration, signal);
  const workerIllustration = dependencies.createWorkerIllustration(
    pool,
    workerProviderGraph.illustration,
  );
  const server = await dependencies.buildServer({
    ...(settings?.isReady ? { settingsReadiness: settings.isReady } : {}),
    config, pool, generation: apiGeneration, illustration, memory, providers, generationEvents, worldCampaign, authoring: apiAuthoring,
    infiniteWorldsProviders: apiProviderGraph.infiniteWorlds,
    ...(dependencies.createApiCast ? { cast: dependencies.createApiCast(pool, config, apiProviderGraph.generation) } : {}),
  });
  try {
    await server.listen({ host: config.host, port: config.port });
    await settings?.markReady?.();
    await dependencies.runWorker(pool, config, signal, {
      generation: workerGeneration,
      illustration: workerIllustration,
      generationIllustration: workerIllustrationTransactions,
      ...(config.castDiscoveryEnabled === true && dependencies.createWorkerCastDiscovery
        ? { castDiscovery: dependencies.createWorkerCastDiscovery(pool, config, workerProviderGraph.generation) } : {}),
      memory: dependencies.createWorkerMemory(pool, workerProviderGraph.chronicle),
      authoring
    });
  } finally { await server.close(); }
}
