import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ClaimedGeneration,
  GenerationWorkerApplication
} from "../../packages/application/src/index.js";
import type { RuntimeConfig } from "../../packages/database/src/config.js";
import type { DatabasePool } from "../../packages/database/src/pool.js";

const lane = vi.hoisted(() => ({
  asset: vi.fn(async () => false),
  chronicle: vi.fn(async () => false),
  illustrationPrompt: vi.fn(async () => false),
  illustrationResolution: vi.fn(async () => false),
  image: vi.fn(async () => false)
}));

const log = vi.hoisted(() => ({
  error: vi.fn(),
  info: vi.fn()
}));

vi.mock("../../services/api/src/asset-service.js", () => ({
  runAssetMetadataBackfill: lane.asset
}));
vi.mock("../../services/api/src/memory-service.js", () => ({
  runChronicleJob: lane.chronicle
}));
vi.mock("../../services/api/src/segmented-illustration-service.js", () => ({
  runIllustrationPromptJob: lane.illustrationPrompt
}));
vi.mock("../../services/api/src/illustration-resolution-service.js", () => ({
  runIllustrationResolutionJob: lane.illustrationResolution
}));
vi.mock("../../services/api/src/image-service.js", () => ({
  runImageJob: lane.image
}));
vi.mock("../../packages/logger/src/index.js", () => ({ logger: log }));

import { runWorker } from "../../services/worker/src/worker.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function claim(jobId: string): ClaimedGeneration {
  return {
    jobId,
    ownerUserId: "00000000-0000-4000-8000-000000000001",
    campaignId: "00000000-0000-4000-8000-000000000002",
    providerProfileId: "00000000-0000-4000-8000-000000000003",
    expectedTurnNumber: 0,
    operationKind: "append",
    replacementTurnId: null,
    attempts: 1
  };
}

const pool = {} as DatabasePool;
const config = {
  workerGenerationConcurrency: 1,
  workerLeaseSeconds: 45,
  workerPollIntervalMs: 100,
  credentialEncryptionKey: "test-secret",
  assetStorageRoot: "/tmp/infinite-quest-worker-test"
} as RuntimeConfig;

describe("worker generation application adapter", () => {
  beforeEach(() => {
    for (const operation of Object.values(lane)) {
      operation.mockReset();
      operation.mockResolvedValue(false);
    }
    log.error.mockReset();
    log.info.mockReset();
  });

  it("keeps one active generation, stops claiming on abort, and drains the active execution", async () => {
    const controller = new AbortController();
    const execution = deferred<boolean>();
    const generation: GenerationWorkerApplication = {
      claimNext: vi.fn(async () => claim("job-one")),
      executeClaimed: vi.fn(() => execution.promise)
    };

    let settled = false;
    const running = runWorker(pool, config, controller.signal, { generation })
      .finally(() => { settled = true; });

    await vi.waitFor(() => expect(generation.executeClaimed).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(lane.illustrationPrompt).toHaveBeenCalled());
    expect(generation.claimNext).toHaveBeenCalledOnce();
    expect(generation.claimNext).toHaveBeenCalledWith({
      workerId: expect.stringMatching(/^.+:\d+:[0-9a-f]{8}$/u),
      leaseSeconds: 45
    });

    controller.abort();
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(generation.claimNext).toHaveBeenCalledOnce();

    execution.resolve(true);
    await running;
    expect(generation.claimNext).toHaveBeenCalledOnce();
  });

  it("logs an execution rejection and remains available for the next generation", async () => {
    const controller = new AbortController();
    const secondExecution = deferred<boolean>();
    const generation: GenerationWorkerApplication = {
      claimNext: vi.fn()
        .mockResolvedValueOnce(claim("job-failed"))
        .mockResolvedValueOnce(claim("job-next")),
      executeClaimed: vi.fn()
        .mockRejectedValueOnce(new Error("synthetic execution failure"))
        .mockImplementationOnce(() => {
          controller.abort();
          return secondExecution.promise;
        })
    };

    const running = runWorker(pool, config, controller.signal, { generation });

    await vi.waitFor(() => expect(generation.executeClaimed).toHaveBeenCalledTimes(2));
    expect(generation.claimNext).toHaveBeenCalledTimes(2);
    expect(generation.executeClaimed).toHaveBeenNthCalledWith(1, expect.objectContaining({
      claim: expect.objectContaining({ jobId: "job-failed" })
    }));
    expect(generation.executeClaimed).toHaveBeenNthCalledWith(2, expect.objectContaining({
      claim: expect.objectContaining({ jobId: "job-next" })
    }));
    expect(log.error).toHaveBeenCalledWith(expect.objectContaining({
      event: "worker_generation_error",
      message: "synthetic execution failure"
    }));

    secondExecution.resolve(true);
    await running;
  });

  it("preserves prompt-resolution-image priority within the illustration lane", async () => {
    const controller = new AbortController();
    const execution = deferred<boolean>();
    const calls: string[] = [];
    let promptCalls = 0;
    let resolutionCalls = 0;
    let imageCalls = 0;

    lane.illustrationPrompt.mockImplementation(async () => {
      calls.push("prompt");
      promptCalls += 1;
      return promptCalls === 1;
    });
    lane.illustrationResolution.mockImplementation(async () => {
      calls.push("resolution");
      resolutionCalls += 1;
      return resolutionCalls === 1;
    });
    lane.image.mockImplementation(async () => {
      calls.push("image");
      imageCalls += 1;
      return imageCalls === 1;
    });
    lane.chronicle.mockResolvedValue(false);
    lane.asset.mockImplementation(async () => {
      return false;
    });
    const generation: GenerationWorkerApplication = {
      claimNext: vi.fn(async () => claim("job-active")),
      executeClaimed: vi.fn(() => execution.promise)
    };

    const running = runWorker(pool, config, controller.signal, { generation });
    await vi.waitFor(() => expect(lane.image).toHaveBeenCalled());

    expect(calls.slice(0, 6)).toEqual([
      "prompt",
      "prompt", "resolution",
      "prompt", "resolution", "image"
    ]);
    expect(generation.claimNext).toHaveBeenCalledOnce();

    controller.abort();
    execution.resolve(true);
    await running;
  });
});
