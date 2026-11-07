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
import type { DeploymentSettingsPolicy } from "../../../packages/contracts/src/instance-settings.js";
import type { DatabasePool, RuntimeConfig } from "../../../packages/database/src/index.js";
import type { BuildServerOptions } from "../../api/src/server.js";
import type { ProviderApiTransportAdapter } from "../../api/src/provider-application-adapter.js";
import type { WorkerDependencies } from "../../worker/src/worker.js";
import type { ProviderTransport } from "../../../packages/story-engine/src/provider-transport.js";
import type {
  ApiProviderApplicationComposition,
  WorkerProviderApplicationComposition
} from "./provider-application-composition.js";
import { loadLocalSingleUserPolicy } from "./local-single-user-settings.js";
import { createLocalSettingsRestartStore } from "./local-settings-restart-store.js";
import { activateSettingsInTransaction } from "../../../packages/database/src/instance-settings-repository.js";
import { initialOwnerId } from "../../../packages/database/src/pool.js";
import { createSettingsActivationGuard } from "./settings-activation.js";
import { settingsDigest } from "./instance-settings.js";
import { logger } from "../../../packages/logger/src/index.js";

type RuntimeServer = {
  listen(options: { host: string; port: number }): Promise<unknown>;
  close(): Promise<void>;
  waitForLocalHttpDrain?(): Promise<void>;
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
  resolveSettings?(pool: DatabasePool, config: RuntimeConfig, signal: AbortSignal): Promise<{config:RuntimeConfig;bootstrap?:RuntimeConfig;localPolicy?:DeploymentSettingsPolicy | undefined;dispose():Promise<void>;markReady?():Promise<void>;isReady?():Promise<boolean>}>;
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
  const local = bootstrapConfig.instanceSettingsAccessMode === "local-single-user";
  if (local && bootstrapConfig.role !== "all") throw new Error("settings_local_combined_role_required");
  const lock = local ? await pool.connect() : undefined;
  let lockLost = false;
  let stopOnLockLoss: (() => void) | undefined;
  const onLockError = () => { lockLost = true; stopOnLockLoss?.(); };
  lock?.on("error", onLockError);
  try {
    if (lock) {
      const result = await lock.query("SELECT pg_try_advisory_lock(1936942452) AS acquired");
      if (!result.rows[0]?.acquired) throw new Error("settings_local_process_already_running");
    }
    const store = local ? createLocalSettingsRestartStore(pool) : undefined;
    let completing: string | undefined = await store?.recoverInterrupted();
    if (!signal.aborted) {
      const iteration = new AbortController();
      const stop = () => iteration.abort();
      stopOnLockLoss = stop;
      if (lockLost) throw new Error("settings_local_process_lock_lost");
      signal.addEventListener("abort", stop, { once: true });
      let requested: { operationId: string; revision: string; activeRevision: string | null; epoch: string } | undefined;
      let draining = false;
      const runtimeSignal = local ? iteration.signal : signal;
      const settings = await dependencies.resolveSettings?.(pool, bootstrapConfig, runtimeSignal);
      const config = settings?.config ?? bootstrapConfig;
      const restart = store && settings?.localPolicy ? {
        isDraining: () => draining,
        status: (id: string) => store.status(id),
        start: async (revision: string, operationId: string) => {
          const result = await store.start(revision, operationId);
          if (!requested && result.operation.status === "draining") {
            requested = { operationId: result.operation.operationId, revision, activeRevision: result.expectedActiveRevision, epoch: result.expectedEpoch };
            draining = true;
            setImmediate(stop);
          }
          return result.operation;
        }
      } : undefined;
      try {
        await dispatchResolvedRuntimeRole(config, pool, runtimeSignal, dependencies, providerTransport, generationEvents, settings, restart, signal,
          async () => { if (completing) { await store!.setStatus(completing, "ready"); completing = undefined; } });
      } finally {
        signal.removeEventListener("abort", stop);
        await settings?.dispose();
      }
      if (lockLost) throw new Error("settings_local_process_lock_lost");
      if (!requested || signal.aborted || !settings?.localPolicy || !store) return;
      try {
        const currentPolicy = await loadLocalSingleUserPolicy(pool, bootstrapConfig);
        if (settingsDigest(currentPolicy) !== settingsDigest(settings.localPolicy)) throw new Error("settings_policy_mismatch");
        if (lockLost) throw new Error("settings_local_process_lock_lost");
        await store.setStatus(requested.operationId, "restarting");
        // The activation transaction runs on the session holding the exclusive
        // process lock. Disconnecting that session rolls back the transaction.
        await lock!.query("BEGIN");
        try {
          await activateSettingsInTransaction(lock!, {
            expectedActiveRevision: requested.activeRevision, expectedRequestedRevision: requested.revision,
            policyDigest: settingsDigest(settings.localPolicy), expectedEpoch: requested.epoch,
            maintenanceReference: `local-restart/${requested.operationId}`,
            actor: { userId: await initialOwnerId(pool), localSingleUser: true }
          }, createSettingsActivationGuard(settings.localPolicy));
          await lock!.query("COMMIT");
        } catch (error) {
          await lock!.query("ROLLBACK").catch(() => undefined);
          throw error;
        }
        return;
      } catch (error) {
        // A lost database response may follow a committed activation. Reconcile
        // the audit record before deciding whether the old graph can resume.
        const committed = await store.recoverInterrupted();
        if (committed !== requested.operationId) {
          const message = error instanceof Error ? error.message : "";
          const allowed = ["settings_active_leases", "settings_active_invocations", "settings_runtime_not_drained", "settings_conflict", "settings_activation_epoch_mismatch", "settings_policy_mismatch"];
          await store.setFailure(requested.operationId, allowed.includes(message) ? message : "activation_blocked");
        }
        return;
      }
    }
  } finally {
    if (lock) {
      lock.removeListener("error", onLockError);
      if (!lockLost) await lock.query("SELECT pg_advisory_unlock(1936942452)").catch(() => { lockLost = true; });
      lock.release(lockLost);
    }
  }
}

async function dispatchResolvedRuntimeRole(
  config: RuntimeConfig,
  pool: DatabasePool,
  signal: AbortSignal,
  dependencies: RuntimeRoleDependencies,
  providerTransport: ProviderTransport,
  generationEvents: GenerationEventSource | undefined,
  settings: Awaited<ReturnType<NonNullable<RuntimeRoleDependencies["resolveSettings"]>>> | undefined,
  restart: BuildServerOptions["localSettingsRestart"] | undefined,
  shutdownSignal: AbortSignal,
  onReady: () => Promise<void>
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
      ...(settings?.bootstrap ? { settingsBootstrap: settings.bootstrap } : {}),
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
    const authoring = dependencies.createWorkerAuthoring(pool, providerGraph.worldGeneration, shutdownSignal);
    const workerIllustration = dependencies.createWorkerIllustration(
      pool,
      providerGraph.illustration,
    );
    await settings?.markReady?.();
    await onReady();
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
  const authoring = dependencies.createWorkerAuthoring(pool, workerProviderGraph.worldGeneration, shutdownSignal);
  const workerIllustration = dependencies.createWorkerIllustration(
    pool,
    workerProviderGraph.illustration,
  );
  const server = await dependencies.buildServer({
    ...(settings?.bootstrap ? { settingsBootstrap: settings.bootstrap } : {}),
    ...(restart ? { localSettingsRestart: restart } : {}),
    ...(settings?.localPolicy ? { settingsLocalPolicy: settings.localPolicy } : {}),
    ...(settings?.isReady ? { settingsReadiness: settings.isReady } : {}),
    config, pool, generation: apiGeneration, illustration, memory, providers, generationEvents, worldCampaign, authoring: apiAuthoring,
    infiniteWorldsProviders: apiProviderGraph.infiniteWorlds,
    ...(dependencies.createApiCast ? { cast: dependencies.createApiCast(pool, config, apiProviderGraph.generation) } : {}),
  });
  try {
    await server.listen({ host: config.host, port: config.port });
    await settings?.markReady?.();
    await onReady();
    await dependencies.runWorker(pool, config, signal, {
      ...(restart ? { cancellationSignal: shutdownSignal } : {}),
      generation: workerGeneration,
      illustration: workerIllustration,
      generationIllustration: workerIllustrationTransactions,
      ...(config.castDiscoveryEnabled === true && dependencies.createWorkerCastDiscovery
        ? { castDiscovery: dependencies.createWorkerCastDiscovery(pool, config, workerProviderGraph.generation) } : {}),
      memory: dependencies.createWorkerMemory(pool, workerProviderGraph.chronicle),
      authoring
    });
  } finally {
    if (restart?.isDraining()) await server.waitForLocalHttpDrain?.();
    await server.close();
  }
}
