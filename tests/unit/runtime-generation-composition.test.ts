import { describe, expect, it, vi } from "vitest";
import type {
  GenerationApplication,
  GenerationClaimRepository,
  GenerationCommandRepository,
  GenerationExecutor,
  GenerationWorkerApplication,
  IllustrationApplication,
  MemoryApplication
} from "../../packages/application/src/index.js";
import type { GenerationExecutionRepository } from "../../packages/database/src/generation-execution-repository.js";
import type { DatabasePool } from "../../packages/database/src/pool.js";
import { createApiGenerationApplication } from "../../services/runtime/src/generation-api-composition.js";
import {
  createWorkerGenerationApplication,
  type WorkerGenerationCompositionFactories
} from "../../services/runtime/src/generation-worker-composition.js";

describe("createApiGenerationApplication", () => {
  it("provides every command without querying during construction", () => {
    const query = vi.fn();
    const pool = { query } as unknown as DatabasePool;

    const application = createApiGenerationApplication(pool);

    expect(application).toMatchObject({
      enqueueAppend: expect.any(Function),
      enqueueReplacement: expect.any(Function),
      getJob: expect.any(Function),
      getResult: expect.any(Function),
      retry: expect.any(Function),
      cancel: expect.any(Function),
      discard: expect.any(Function)
    });
    expect(query).not.toHaveBeenCalled();
  });

  it("constructs the command repository and API application exactly once", () => {
    const pool = {} as DatabasePool;
    const repository = {} as GenerationCommandRepository;
    const application = {} as GenerationApplication;
    const createCommandRepository = vi.fn(() => repository);
    const createApplication = vi.fn(() => application);

    const result = createApiGenerationApplication(pool, {
      createApplication,
      createCommandRepository
    });

    expect(result).toBe(application);
    expect(createCommandRepository).toHaveBeenCalledOnce();
    expect(createCommandRepository).toHaveBeenCalledWith(pool);
    expect(createApplication).toHaveBeenCalledOnce();
    expect(createApplication).toHaveBeenCalledWith(repository);
  });
});

describe("createWorkerGenerationApplication", () => {
  it("constructs the execution repository, executor, collaborators, and worker application exactly once", () => {
    const pool = {} as DatabasePool;
    const repository = {} as GenerationClaimRepository & GenerationExecutionRepository;
    const executor = {} as GenerationExecutor;
    const application = {} as GenerationWorkerApplication;
    const illustration = {} as IllustrationApplication;
    const memory = { generation: {} } as MemoryApplication;
    const collaborators = {} as never;
    const factories = {
      createApplication: vi.fn(() => application),
      createCollaborators: vi.fn(() => collaborators),
      createExecutor: vi.fn(() => executor),
      createRepository: vi.fn(() => repository)
    } satisfies WorkerGenerationCompositionFactories;

    const result = createWorkerGenerationApplication(pool, "credential-secret", illustration, memory, factories);

    expect(result).toBe(application);
    expect(factories.createCollaborators).toHaveBeenCalledOnce();
    expect(factories.createCollaborators).toHaveBeenCalledWith(illustration, memory);
    expect(factories.createRepository).toHaveBeenCalledOnce();
    expect(factories.createRepository).toHaveBeenCalledWith(pool);
    expect(factories.createExecutor).toHaveBeenCalledOnce();
    expect(factories.createExecutor).toHaveBeenCalledWith({
      pool,
      repository,
      collaborators,
      credentialSecret: "credential-secret"
    });
    expect(factories.createApplication).toHaveBeenCalledOnce();
    expect(factories.createApplication).toHaveBeenCalledWith({
      claims: repository,
      executor
    });
  });
});
