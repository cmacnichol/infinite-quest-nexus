import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("../../packages/logger/src/index.js", () => ({ logger: { info: vi.fn(), error: vi.fn() } }));
import { closeDatabasePool } from "../../services/runtime/src/shutdown.js";
import { createRuntimeAuthoringWorkerApplication } from "../../services/runtime/src/authoring-composition.js";
import { runWorker } from "../../services/worker/src/worker.js";
import { authoringHash, authoringResult, authoringRuntimeFixture, deferred } from "../helpers/authoring-runtime.js";
import { inertWorkerIllustration, inertWorkerMemory } from "../helpers/memory-applications.js";
import { ProviderHttpError } from "../../packages/story-engine/src/providers.js";
import {
  runRuntimeLifecycle,
  type RuntimeLifecycleDependencies
} from "../../services/runtime/src/lifecycle.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("runtime shutdown", () => {
  it.each(["response", "timeout"])("drains the actual authoring dispatcher until the bounded provider %s before closing resources", async (outcome) => {
    vi.useFakeTimers();
    const started = deferred<void>();
    const events: string[] = [];
    const execute = vi.fn(async () => {
      events.push("provider:start");
      started.resolve();
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
      events.push("provider:end");
      if (outcome === "timeout") throw new ProviderHttpError(504, 0, "synthetic timeout");
      return authoringResult("malformed response requiring repair");
    });
    const runtime = authoringRuntimeFixture(execute);
    const repository = {
      claim: vi.fn(async () => ({ jobId: "job", stageId: "stage", ownerUserId: "owner" })),
      loadClaim: vi.fn(async () => ({ input: runtime.input, snapshot: runtime.snapshot, stageKey: "character:hero", parentOutputs: [] })),
      heartbeat: vi.fn(async () => true), checkpoint: vi.fn(async () => true), fail: vi.fn(async () => true)
    };
    const controller = new AbortController();
    const removed = vi.spyOn(controller.signal, "removeEventListener");
    const authoring = createRuntimeAuthoringWorkerApplication({ repository: repository as never, providers: runtime.providers, sha256: authoringHash, signal: controller.signal });
    const config = { role: "worker", workerGenerationConcurrency: 1, workerLeaseSeconds: 3, workerPollIntervalMs: 5, aiAuthoringJobsEnabled: true } as never;
    const pool = { end: vi.fn(async () => { events.push("pool:close"); }) };
    const transport = { close: vi.fn(async () => { events.push("transport:close"); }) };
    const generation = { claimNext: vi.fn(async () => null), executeClaimed: vi.fn(async () => false) };
    const running = runRuntimeLifecycle(config, controller, {
      createPool: () => pool as never, createTransport: () => transport as never,
      configureTransport: () => undefined, createGenerationEvents: () => { throw new Error("unused"); },
      dispatchRole: async () => runWorker(pool as never, config, controller.signal, {
        generation, illustration: inertWorkerIllustration, memory: inertWorkerMemory,
        optionalLanes: { illustration: async () => false, chronicle: async () => false, asset: async () => false, authoring: () => authoring.runNext({ workerId: "worker", leaseSeconds: 3 }) }
      })
    });
    await started.promise;
    controller.abort();
    await vi.advanceTimersByTimeAsync(24);
    expect(events).toEqual(["provider:start"]);
    expect(pool.end).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    await running;
    expect(events).toEqual(["provider:start", "provider:end", "transport:close", "pool:close"]);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(repository.claim).toHaveBeenCalledTimes(1);
    expect(repository.checkpoint).not.toHaveBeenCalled();
    expect(repository.fail).not.toHaveBeenCalled();
    expect(removed).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });
  it("forces process termination when the database pool does not close by the deadline", async () => {
    vi.useFakeTimers();
    const forceExit = vi.fn();
    const closing = closeDatabasePool(
      { end: vi.fn(() => new Promise<void>(() => undefined)) },
      25,
      forceExit
    );

    await vi.advanceTimersByTimeAsync(24);
    expect(forceExit).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await expect(closing).resolves.toBe(false);
    expect(forceExit).toHaveBeenCalledWith(1);
  });

  it("preserves a clean pool close that finishes before the deadline", async () => {
    vi.useFakeTimers();
    const forceExit = vi.fn();
    const end = vi.fn().mockResolvedValue(undefined);

    await expect(closeDatabasePool({ end }, 25, forceExit)).resolves.toBe(true);
    await vi.advanceTimersByTimeAsync(25);

    expect(end).toHaveBeenCalledOnce();
    expect(forceExit).not.toHaveBeenCalled();
  });

  it("keeps provider transport and database resources open until worker drain completes", async () => {
    const controller = new AbortController();
    let finishDrain!: () => void;
    const drain = new Promise<void>((resolveDrain) => { finishDrain = resolveDrain; });
    const events: string[] = [];
    const pool = { end: vi.fn(async () => { events.push("pool:end"); }) };
    const transport = {
      fetch: vi.fn(),
      validateSdkEndpoint: vi.fn(),
      close: vi.fn(async () => { events.push("transport:close"); })
    };
    const dependencies = {
      createPool: vi.fn(() => pool),
      createTransport: vi.fn(() => transport),
      configureTransport: vi.fn(),
      createGenerationEvents: vi.fn(),
      dispatchRole: vi.fn(async () => {
        events.push("worker:draining");
        await drain;
        events.push("worker:drained");
      })
    } as unknown as RuntimeLifecycleDependencies;

    const running = runRuntimeLifecycle(
      { role: "worker" } as never,
      controller,
      dependencies
    );
    await vi.waitFor(() => expect(dependencies.dispatchRole).toHaveBeenCalledOnce());
    controller.abort();
    await Promise.resolve();

    expect(events).toEqual(["worker:draining"]);
    expect(transport.close).not.toHaveBeenCalled();
    expect(pool.end).not.toHaveBeenCalled();

    finishDrain();
    await running;
    expect(events).toEqual([
      "worker:draining",
      "worker:drained",
      "transport:close",
      "pool:end"
    ]);
  });
});
