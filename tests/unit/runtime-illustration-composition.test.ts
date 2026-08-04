import { describe, expect, it, vi } from "vitest";
import type {
  IllustrationApplication,
  IllustrationApplicationDependencies,
  IllustrationWorkerApplication,
  IllustrationWorkerExecutor
} from "../../packages/application/src/index.js";
import type { DatabasePool } from "../../packages/database/src/pool.js";
import {
  createApiIllustrationApplication,
  createIllustrationWorkerExecutor,
  createWorkerIllustrationApplication,
  type ApiIllustrationCompositionFactories,
  type IllustrationWorkerLanes,
  type WorkerIllustrationCompositionFactories
} from "../../services/runtime/src/illustration-composition.js";

describe("createApiIllustrationApplication", () => {
  it("constructs the split repositories and application once without querying eagerly", () => {
    const query = vi.fn();
    const pool = { query } as unknown as DatabasePool;
    const repositories = {} as IllustrationApplicationDependencies;
    const application = {} as IllustrationApplication;
    const factories = {
      createRepositories: vi.fn(() => repositories),
      createApplication: vi.fn(() => application)
    } satisfies ApiIllustrationCompositionFactories;

    expect(createApiIllustrationApplication(pool, factories)).toBe(application);
    expect(factories.createRepositories).toHaveBeenCalledOnce();
    expect(factories.createRepositories).toHaveBeenCalledWith(pool);
    expect(factories.createApplication).toHaveBeenCalledOnce();
    expect(factories.createApplication).toHaveBeenCalledWith(repositories);
    expect(query).not.toHaveBeenCalled();
  });
});

describe("createIllustrationWorkerExecutor", () => {
  it("runs prompt, resolution, and image lanes in priority order and stops after one claim", async () => {
    const prompt = vi.fn(async () => false);
    const resolution = vi.fn(async () => true);
    const image = vi.fn(async () => true);
    const executor = createIllustrationWorkerExecutor({ prompt, resolution, image });
    const request = { workerId: "worker-a", leaseSeconds: 30 };

    await expect(executor.runNextIllustration(request)).resolves.toBe(true);
    expect(prompt).toHaveBeenCalledWith(request);
    expect(resolution).toHaveBeenCalledWith(request);
    expect(image).not.toHaveBeenCalled();
  });

  it("reaches the image lane only when prompt and resolution have no work", async () => {
    const order: string[] = [];
    const lanes: IllustrationWorkerLanes = {
      prompt: async () => { order.push("prompt"); return false; },
      resolution: async () => { order.push("resolution"); return false; },
      image: async () => { order.push("image"); return false; }
    };

    await expect(createIllustrationWorkerExecutor(lanes).runNextIllustration({
      workerId: "worker-b",
      leaseSeconds: 45
    })).resolves.toBe(false);
    expect(order).toEqual(["prompt", "resolution", "image"]);
  });
});

describe("createWorkerIllustrationApplication", () => {
  it("binds concrete provider, artifact, and asset ports into the separate worker application", () => {
    const pool = {} as DatabasePool;
    const store = { root: "/var/lib/infinitequest/assets" };
    const lanes = {} as IllustrationWorkerLanes;
    const executor = {} as IllustrationWorkerExecutor;
    const ports = {
      imageProvider: { executeImage: vi.fn() },
      promptRefinement: { refinePrompt: vi.fn() },
      artifactDownload: { downloadArtifact: vi.fn() },
      assets: {
        persistTurnIllustration: vi.fn(),
        persistWorldCover: vi.fn(),
        bindSegmentAsset: vi.fn()
      }
    };
    const application = {} as IllustrationWorkerApplication;
    const factories = {
      createLanes: vi.fn(() => lanes),
      createExecutor: vi.fn(() => executor),
      createApplication: vi.fn(() => application),
      createPorts: vi.fn(() => ports)
    } as unknown as WorkerIllustrationCompositionFactories;

    expect(createWorkerIllustrationApplication(
      pool,
      "credential-secret",
      store,
      factories
    )).toBe(application);
    expect((factories as unknown as { createPorts: ReturnType<typeof vi.fn> }).createPorts)
      .toHaveBeenCalledWith(pool, "credential-secret", store);
    expect(factories.createLanes).toHaveBeenCalledWith(pool, "credential-secret", store);
    expect(factories.createExecutor).toHaveBeenCalledWith(lanes);
    expect(factories.createApplication).toHaveBeenCalledWith({ executor, ports });
  });
});
