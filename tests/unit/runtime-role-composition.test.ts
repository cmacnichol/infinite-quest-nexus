import { describe, expect, it, vi } from "vitest";
import type {
  GenerationApplication,
  GenerationWorkerApplication
} from "../../packages/application/src/index.js";
import type { RuntimeConfig } from "../../packages/database/src/config.js";
import type { DatabasePool } from "../../packages/database/src/pool.js";
import {
  dispatchRuntimeRole,
  type RuntimeRoleDependencies
} from "../../services/runtime/src/runtime-role.js";

const pool = {} as DatabasePool;
const apiGeneration = { kind: "api-generation" } as unknown as GenerationApplication;
const workerGeneration = { kind: "worker-generation" } as unknown as GenerationWorkerApplication;

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

    await dispatchRuntimeRole(config("api"), pool, controller.signal, values);

    expect(values.createApiGeneration).toHaveBeenCalledOnce();
    expect(values.createApiGeneration).toHaveBeenCalledWith(pool);
    expect(values.createWorkerGeneration).not.toHaveBeenCalled();
    expect(values.buildServer).toHaveBeenCalledOnce();
    expect(values.buildServer).toHaveBeenCalledWith({
      config: expect.objectContaining({ role: "api" }),
      pool,
      generation: apiGeneration
    });
    expect(values.runWorker).not.toHaveBeenCalled();
    expect(server.close).toHaveBeenCalledOnce();
  });

  it("constructs only the worker graph for the worker role", async () => {
    const controller = new AbortController();
    const { values } = dependencies(controller);

    await dispatchRuntimeRole(config("worker"), pool, controller.signal, values);

    expect(values.waitForDatabaseMigrations).toHaveBeenCalledWith(
      pool,
      "database/migrations",
      17_000
    );
    expect(values.createWorkerGeneration).toHaveBeenCalledOnce();
    expect(values.createWorkerGeneration).toHaveBeenCalledWith(pool, "role-secret");
    expect(values.runWorker).toHaveBeenCalledOnce();
    expect(values.runWorker).toHaveBeenCalledWith(
      pool,
      expect.objectContaining({ role: "worker" }),
      controller.signal,
      { generation: workerGeneration }
    );
    expect(values.createApiGeneration).not.toHaveBeenCalled();
    expect(values.buildServer).not.toHaveBeenCalled();
    expect(values.migrateDatabase).not.toHaveBeenCalled();
  });

  it("constructs both isolated generation graphs once over the shared pool for the all role", async () => {
    const controller = new AbortController();
    const { server, values } = dependencies(controller);

    await dispatchRuntimeRole(config("all"), pool, controller.signal, values);

    expect(values.createApiGeneration).toHaveBeenCalledOnce();
    expect(values.createApiGeneration).toHaveBeenCalledWith(pool);
    expect(values.createWorkerGeneration).toHaveBeenCalledOnce();
    expect(values.createWorkerGeneration).toHaveBeenCalledWith(pool, "role-secret");
    expect(values.buildServer).toHaveBeenCalledWith({
      config: expect.objectContaining({ role: "all" }),
      pool,
      generation: apiGeneration
    });
    expect(values.runWorker).toHaveBeenCalledWith(
      pool,
      expect.objectContaining({ role: "all" }),
      controller.signal,
      { generation: workerGeneration }
    );
    expect(server.close).toHaveBeenCalledOnce();
  });

  it("constructs no generation graph, provider collaborator, or server for migrate", async () => {
    const controller = new AbortController();
    const { values } = dependencies(controller);

    await dispatchRuntimeRole(config("migrate"), pool, controller.signal, values);

    expect(values.migrateDatabase).toHaveBeenCalledWith(
      pool,
      "database/migrations",
      { allowMaintenanceMigrations: true }
    );
    expect(values.createApiGeneration).not.toHaveBeenCalled();
    expect(values.createWorkerGeneration).not.toHaveBeenCalled();
    expect(values.buildServer).not.toHaveBeenCalled();
    expect(values.runWorker).not.toHaveBeenCalled();
    expect(values.waitForDatabaseMigrations).not.toHaveBeenCalled();
  });
});
