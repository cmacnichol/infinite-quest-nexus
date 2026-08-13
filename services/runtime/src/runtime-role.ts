import type {
  GenerationApplication,
  GenerationEventSource,
  GenerationWorkerApplication,
  IllustrationApplication,
  IllustrationWorkerApplication,
  MemoryApplication,
  MemoryWorkerApplication,
  WorldCampaignApplication
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
    transport: ProviderTransport
  ): ApiProviderApplicationComposition;
  createWorkerProviders(
    pool: DatabasePool,
    credentialSecret: string,
    transport: ProviderTransport
  ): WorkerProviderApplicationComposition;
  createProviderApiAdapter(composition: ApiProviderApplicationComposition): ProviderApiTransportAdapter;
  createApiGeneration(pool: DatabasePool, providers: ApiProviderApplicationComposition["generation"]): GenerationApplication;
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
  config: RuntimeConfig,
  pool: DatabasePool,
  signal: AbortSignal,
  dependencies: RuntimeRoleDependencies,
  providerTransport: ProviderTransport,
  generationEvents: GenerationEventSource | undefined
): Promise<void> {
  await prepareDatabase(config, pool, dependencies);

  if (config.role === "migrate") return;

  if (config.role === "api") {
    if (!generationEvents) throw new Error("The API role requires a generation event source.");
    const providerGraph = dependencies.createApiProviders(
      pool,
      config.credentialEncryptionKey,
      providerTransport
    );
    const generation = dependencies.createApiGeneration(pool, providerGraph.generation);
    const illustration = dependencies.createApiIllustration(pool, providerGraph.illustration);
    const memory = dependencies.createApiMemory(pool, providerGraph.chronicle);
    const worldCampaign = dependencies.createApiWorldCampaign(pool, providerGraph);
    const providers = dependencies.createProviderApiAdapter(providerGraph);
    const server = await dependencies.buildServer({
      config, pool, generation, illustration, memory, providers, generationEvents, worldCampaign,
      infiniteWorldsProviders: providerGraph.infiniteWorlds,
    });
    await server.listen({ host: config.host, port: config.port });
    await waitForAbort(signal);
    await server.close();
    return;
  }

  if (config.role === "worker") {
    const providerGraph = dependencies.createWorkerProviders(pool, config.credentialEncryptionKey, providerTransport);
    const illustration = dependencies.createApiIllustration(pool, providerGraph.illustration);
    const memory = dependencies.createApiMemory(pool, providerGraph.chronicle);
    const generation = dependencies.createWorkerGeneration(pool, illustration, memory, providerGraph.generation);
    const workerIllustration = dependencies.createWorkerIllustration(
      pool,
      providerGraph.illustration,
    );
    await dependencies.runWorker(pool, config, signal, {
      generation,
      illustration: workerIllustration,
      memory: dependencies.createWorkerMemory(pool, providerGraph.chronicle)
    });
    return;
  }

  const apiProviderGraph = dependencies.createApiProviders(
    pool,
    config.credentialEncryptionKey,
    providerTransport
  );
  const workerProviderGraph = dependencies.createWorkerProviders(pool, config.credentialEncryptionKey, providerTransport);
  const apiGeneration = dependencies.createApiGeneration(pool, apiProviderGraph.generation);
  const illustration = dependencies.createApiIllustration(pool, apiProviderGraph.illustration);
  const memory = dependencies.createApiMemory(pool, apiProviderGraph.chronicle);
  const workerIllustrationTransactions = dependencies.createApiIllustration(pool, workerProviderGraph.illustration);
  const workerMemoryTransactions = dependencies.createApiMemory(pool, workerProviderGraph.chronicle);
  const worldCampaign = dependencies.createApiWorldCampaign(pool, apiProviderGraph);
  const providers = dependencies.createProviderApiAdapter(apiProviderGraph);
  if (!generationEvents) throw new Error("The all role requires a generation event source.");
  const workerGeneration = dependencies.createWorkerGeneration(
    pool, workerIllustrationTransactions, workerMemoryTransactions, workerProviderGraph.generation,
  );
  const workerIllustration = dependencies.createWorkerIllustration(
    pool,
    workerProviderGraph.illustration,
  );
  const server = await dependencies.buildServer({
    config, pool, generation: apiGeneration, illustration, memory, providers, generationEvents, worldCampaign,
    infiniteWorldsProviders: apiProviderGraph.infiniteWorlds,
  });
  await server.listen({ host: config.host, port: config.port });
  await dependencies.runWorker(pool, config, signal, {
    generation: workerGeneration,
    illustration: workerIllustration,
    memory: dependencies.createWorkerMemory(pool, workerProviderGraph.chronicle)
  });
  await server.close();
}
