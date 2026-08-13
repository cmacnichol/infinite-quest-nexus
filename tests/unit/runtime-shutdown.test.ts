import { afterEach, describe, expect, it, vi } from "vitest";
import { closeDatabasePool } from "../../services/runtime/src/shutdown.js";
import {
  runRuntimeLifecycle,
  type RuntimeLifecycleDependencies
} from "../../services/runtime/src/lifecycle.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("runtime shutdown", () => {
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
