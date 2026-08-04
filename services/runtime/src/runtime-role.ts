import type {
  GenerationApplication,
  GenerationEventSource,
  GenerationWorkerApplication
} from "../../../packages/application/src/index.js";
import type { DatabasePool, RuntimeConfig } from "../../../packages/database/src/index.js";
import type { BuildServerOptions } from "../../api/src/server.js";
import type { WorkerDependencies } from "../../worker/src/worker.js";
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
  createApiGeneration(pool: DatabasePool): GenerationApplication;
  createWorkerGeneration(pool: DatabasePool, credentialSecret: string): GenerationWorkerApplication;
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
  generationEvents: GenerationEventSource | undefined
): Promise<void> {
  await prepareDatabase(config, pool, dependencies);

  if (config.role === "migrate") return;

  if (config.role === "api") {
    if (!generationEvents) throw new Error("The API role requires a generation event source.");
    const generation = dependencies.createApiGeneration(pool);
    const server = await dependencies.buildServer({ config, pool, generation, generationEvents });
    await server.listen({ host: config.host, port: config.port });
    await waitForAbort(signal);
    await server.close();
    return;
  }

  if (config.role === "worker") {
    const generation = dependencies.createWorkerGeneration(pool, config.credentialEncryptionKey);
    await dependencies.runWorker(pool, config, signal, { generation });
    return;
  }

  const apiGeneration = dependencies.createApiGeneration(pool);
  if (!generationEvents) throw new Error("The all role requires a generation event source.");
  const workerGeneration = dependencies.createWorkerGeneration(pool, config.credentialEncryptionKey);
  const server = await dependencies.buildServer({
    config,
    pool,
    generation: apiGeneration,
    generationEvents
  });
  await server.listen({ host: config.host, port: config.port });
  await dependencies.runWorker(pool, config, signal, { generation: workerGeneration });
  await server.close();
}
