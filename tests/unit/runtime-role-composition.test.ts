import { describe, expect, it, vi } from "vitest";
import type {
  GenerationApplication,
  GenerationEventSource,
  GenerationWorkerApplication,
  IllustrationApplication,
  IllustrationWorkerApplication,
  MemoryApplication,
  MemoryWorkerApplication,
  WorldCampaignApplication
} from "../../packages/application/src/index.js";
import type { RuntimeConfig } from "../../packages/database/src/config.js";
import type { DatabasePool } from "../../packages/database/src/pool.js";
import type { ProviderTransport } from "../../packages/story-engine/src/provider-transport.js";
import type {
  ApiProviderApplicationComposition,
  WorkerProviderApplicationComposition
} from "../../services/runtime/src/provider-application-composition.js";
import type { ProviderApiTransportAdapter } from "../../services/api/src/provider-application-adapter.js";
import {
  dispatchRuntimeRole,
  type RuntimeRoleDependencies
} from "../../services/runtime/src/runtime-role.js";

const pool = {} as DatabasePool;
const apiGeneration = { kind: "api-generation" } as unknown as GenerationApplication;
const workerGeneration = { kind: "worker-generation" } as unknown as GenerationWorkerApplication;
const illustration = { kind: "illustration" } as unknown as IllustrationApplication;
const workerIllustration = { kind: "worker-illustration" } as unknown as IllustrationWorkerApplication;
const memory = { kind: "memory" } as unknown as MemoryApplication;
const workerMemory = { kind: "worker-memory" } as unknown as MemoryWorkerApplication;
const worldCampaign = { kind: "world-campaign" } as unknown as WorldCampaignApplication;
const generationEvents = { kind: "generation-events" } as unknown as GenerationEventSource;
const providerTransport = { kind: "provider-transport" } as unknown as ProviderTransport;
const apiGenerationProviders = { kind: "api-generation-providers" };
const apiIllustrationProviders = { kind: "api-illustration-providers" };
const apiChronicleProviders = { kind: "api-chronicle-providers" };
const apiInfiniteWorldsProviders = { kind: "api-infinite-worlds-providers" };
const apiProviders = {
  kind: "api-providers",
  generation: apiGenerationProviders,
  illustration: apiIllustrationProviders,
  chronicle: apiChronicleProviders,
  worldGeneration: { kind: "api-world-generation-providers" },
  characterOrganization: { kind: "api-character-organization-providers" },
  infiniteWorlds: apiInfiniteWorldsProviders,
} as unknown as ApiProviderApplicationComposition;
const workerGenerationProviders = { kind: "worker-generation-providers" };
const workerIllustrationProviders = { kind: "worker-illustration-providers" };
const workerChronicleProviders = { kind: "worker-chronicle-providers" };
const workerProviders = {
  kind: "worker-providers",
  generation: workerGenerationProviders,
  illustration: workerIllustrationProviders,
  chronicle: workerChronicleProviders,
} as unknown as WorkerProviderApplicationComposition;
const providerApiAdapter = { kind: "provider-api-adapter" } as unknown as ProviderApiTransportAdapter;

function config(role: RuntimeConfig["role"]): RuntimeConfig {
  return {
    role,
    migrationDirectory: "database/migrations",
    migrationWaitSeconds: 17,
    allowMaintenanceMigrations: false,
    host: "127.0.0.1",
    port: 8080,
    credentialEncryptionKey: "role-secret"
  } as RuntimeConfig;
}

function dependencies(controller: AbortController) {
  const server = {
    listen: vi.fn(async () => {
      setTimeout(() => controller.abort(), 0);
    }),
    close: vi.fn(async () => undefined)
  };
  return {
    server,
    values: {
      buildServer: vi.fn(async () => server),
      createApiGeneration: vi.fn(() => apiGeneration),
      createApiProviders: vi.fn(() => apiProviders),
      createWorkerProviders: vi.fn(() => workerProviders),
      createProviderApiAdapter: vi.fn(() => providerApiAdapter),
      createApiIllustration: vi.fn(() => illustration),
      createApiMemory: vi.fn(() => memory),
      createApiWorldCampaign: vi.fn(() => worldCampaign),
      createWorkerMemory: vi.fn(() => workerMemory),
      createWorkerIllustration: vi.fn(() => workerIllustration),
      createWorkerGeneration: vi.fn(() => workerGeneration),
      migrateDatabase: vi.fn(async () => []),
      runWorker: vi.fn(async () => undefined),
      waitForDatabaseMigrations: vi.fn(async () => undefined)
    } satisfies RuntimeRoleDependencies
  };
}

describe("runtime role generation composition", () => {
  it("constructs only the API graph and HTTP server for the API role", async () => {
    const controller = new AbortController();
    const { server, values } = dependencies(controller);

    await dispatchRuntimeRole(config("api"), pool, controller.signal, values, providerTransport, generationEvents);

    expect(values.createApiGeneration).toHaveBeenCalledOnce();
    expect(values.createApiProviders).toHaveBeenCalledWith(pool, "role-secret", providerTransport);
    expect(values.createWorkerProviders).not.toHaveBeenCalled();
    expect(values.createApiGeneration).toHaveBeenCalledWith(pool, apiGenerationProviders);
    expect(values.createApiIllustration).toHaveBeenCalledWith(pool, apiIllustrationProviders);
    expect(values.createApiMemory).toHaveBeenCalledWith(pool, apiChronicleProviders);
    expect(values.createApiWorldCampaign).toHaveBeenCalledOnce();
    expect(values.createApiWorldCampaign).toHaveBeenCalledWith(pool, apiProviders);
    expect(values.createWorkerGeneration).not.toHaveBeenCalled();
    expect(values.buildServer).toHaveBeenCalledOnce();
    expect(values.buildServer).toHaveBeenCalledWith({
      config: expect.objectContaining({ role: "api" }),
      pool,
      generation: apiGeneration,
      illustration,
      memory,
      providers: providerApiAdapter,
      generationEvents,
      worldCampaign,
      infiniteWorldsProviders: apiInfiniteWorldsProviders,
    });
    expect(values.runWorker).not.toHaveBeenCalled();
    expect(server.close).toHaveBeenCalledOnce();
  });

  it("constructs only the worker graph for the worker role", async () => {
    const controller = new AbortController();
    const { values } = dependencies(controller);

    await dispatchRuntimeRole(config("worker"), pool, controller.signal, values, providerTransport, undefined);

    expect(values.waitForDatabaseMigrations).toHaveBeenCalledWith(
      pool,
      "database/migrations",
      17_000
    );
    expect(values.createWorkerGeneration).toHaveBeenCalledOnce();
    expect(values.createWorkerProviders).toHaveBeenCalledWith(pool, "role-secret", providerTransport);
    expect(values.createApiProviders).not.toHaveBeenCalled();
    expect(values.createApiIllustration).toHaveBeenCalledWith(pool, workerIllustrationProviders);
    expect(values.createApiMemory).toHaveBeenCalledWith(pool, workerChronicleProviders);
    expect(values.createWorkerGeneration).toHaveBeenCalledWith(
      pool, illustration, memory, workerGenerationProviders,
    );
    expect(values.runWorker).toHaveBeenCalledOnce();
    expect(values.runWorker).toHaveBeenCalledWith(
      pool,
      expect.objectContaining({ role: "worker" }),
      controller.signal,
      { generation: workerGeneration, illustration: workerIllustration, memory: workerMemory }
    );
    expect(values.createApiGeneration).not.toHaveBeenCalled();
    expect(values.createApiWorldCampaign).not.toHaveBeenCalled();
    expect(values.buildServer).not.toHaveBeenCalled();
    expect(values.migrateDatabase).not.toHaveBeenCalled();
  });

  it("constructs both isolated generation graphs once over the shared pool for the all role", async () => {
    const controller = new AbortController();
    const { server, values } = dependencies(controller);

    await dispatchRuntimeRole(config("all"), pool, controller.signal, values, providerTransport, generationEvents);

    expect(values.createApiGeneration).toHaveBeenCalledOnce();
    expect(values.createApiProviders).toHaveBeenCalledWith(pool, "role-secret", providerTransport);
    expect(values.createWorkerProviders).toHaveBeenCalledWith(pool, "role-secret", providerTransport);
    expect(values.createApiGeneration).toHaveBeenCalledWith(pool, apiGenerationProviders);
    expect(values.createApiWorldCampaign).toHaveBeenCalledOnce();
    expect(values.createApiWorldCampaign).toHaveBeenCalledWith(pool, apiProviders);
    expect(values.createWorkerGeneration).toHaveBeenCalledOnce();
    expect(values.createWorkerGeneration).toHaveBeenCalledWith(
      pool, illustration, memory, workerGenerationProviders,
    );
    expect(values.buildServer).toHaveBeenCalledWith({
      config: expect.objectContaining({ role: "all" }),
      pool,
      generation: apiGeneration,
      illustration,
      memory,
      providers: providerApiAdapter,
      generationEvents,
      worldCampaign,
      infiniteWorldsProviders: apiInfiniteWorldsProviders,
    });
    expect(values.runWorker).toHaveBeenCalledWith(
      pool,
      expect.objectContaining({ role: "all" }),
      controller.signal,
      { generation: workerGeneration, illustration: workerIllustration, memory: workerMemory }
    );
    expect(server.close).toHaveBeenCalledOnce();
  });

  it("constructs no generation graph, provider collaborator, or server for migrate", async () => {
    const controller = new AbortController();
    const { values } = dependencies(controller);

    await dispatchRuntimeRole(config("migrate"), pool, controller.signal, values, providerTransport, undefined);

    expect(values.migrateDatabase).toHaveBeenCalledWith(
      pool,
      "database/migrations",
      { allowMaintenanceMigrations: true }
    );
    expect(values.createApiGeneration).not.toHaveBeenCalled();
    expect(values.createApiWorldCampaign).not.toHaveBeenCalled();
    expect(values.createWorkerGeneration).not.toHaveBeenCalled();
    expect(values.buildServer).not.toHaveBeenCalled();
    expect(values.runWorker).not.toHaveBeenCalled();
    expect(values.waitForDatabaseMigrations).not.toHaveBeenCalled();
  });
});
