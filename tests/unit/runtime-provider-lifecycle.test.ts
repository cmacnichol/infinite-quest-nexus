import { describe, expect, it, vi } from "vitest";
import {
  runRuntimeLifecycle,
  type RuntimeLifecycleDependencies
} from "../../services/runtime/src/lifecycle.js";

describe("runtime provider transport lifecycle", () => {
  it("starts API generation events and closes provider then listener before the pool", async () => {
    const events: string[] = [];
    const transport = {
      fetch: vi.fn(),
      validateSdkEndpoint: vi.fn(),
      close: vi.fn(async () => { events.push("transport:close"); })
    };
    const pool = {
      end: vi.fn(async () => { events.push("pool:end"); })
    };
    const generationEvents = {
      subscribe: vi.fn(),
      start: vi.fn(async () => { events.push("events:start"); }),
      close: vi.fn(async () => { events.push("events:close"); })
    };
    const dependencies = {
      createPool: vi.fn(() => pool),
      createTransport: vi.fn(() => transport),
      configureTransport: vi.fn(() => { events.push("transport:configure"); }),
      createGenerationEvents: vi.fn(() => generationEvents),
      dispatchRole: vi.fn(async () => { events.push("role:dispatch"); })
    } as unknown as RuntimeLifecycleDependencies;

    await runRuntimeLifecycle({ role: "api" } as never, new AbortController(), dependencies);

    expect(events).toEqual([
      "transport:configure",
      "events:start",
      "role:dispatch",
      "transport:close",
      "events:close",
      "pool:end"
    ]);
    expect(dependencies.dispatchRole).toHaveBeenCalledWith(
      expect.objectContaining({ role: "api" }),
      pool,
      expect.any(AbortSignal),
      transport,
      generationEvents
    );
  });

  it("still closes the pool when transport shutdown fails", async () => {
    const pool = { end: vi.fn(async () => undefined) };
    const transport = {
      fetch: vi.fn(),
      validateSdkEndpoint: vi.fn(),
      close: vi.fn(async () => { throw new Error("transport close failed"); })
    };
    const dependencies = {
      createPool: vi.fn(() => pool),
      createTransport: vi.fn(() => transport),
      configureTransport: vi.fn(),
      createGenerationEvents: vi.fn(),
      dispatchRole: vi.fn(async () => undefined)
    } as unknown as RuntimeLifecycleDependencies;

    await expect(runRuntimeLifecycle({} as never, new AbortController(), dependencies))
      .rejects.toThrow("transport close failed");
    expect(pool.end).toHaveBeenCalledOnce();
  });

  it.each(["worker", "migrate"] as const)("constructs no generation event listener for the %s role", async (role) => {
    const pool = { end: vi.fn(async () => undefined) };
    const transport = {
      fetch: vi.fn(),
      validateSdkEndpoint: vi.fn(),
      close: vi.fn(async () => undefined)
    };
    const dependencies = {
      createPool: vi.fn(() => pool),
      createTransport: vi.fn(() => transport),
      configureTransport: vi.fn(),
      createGenerationEvents: vi.fn(),
      dispatchRole: vi.fn(async () => undefined)
    } as unknown as RuntimeLifecycleDependencies;

    await runRuntimeLifecycle({ role } as never, new AbortController(), dependencies);

    expect(dependencies.createGenerationEvents).not.toHaveBeenCalled();
    expect(dependencies.dispatchRole).toHaveBeenCalledWith(
      expect.objectContaining({ role }),
      pool,
      expect.any(AbortSignal),
      transport,
      undefined
    );
  });

  it("closes a partially started generation listener when listener startup fails", async () => {
    const events: string[] = [];
    const pool = { end: vi.fn(async () => { events.push("pool:end"); }) };
    const transport = {
      fetch: vi.fn(),
      validateSdkEndpoint: vi.fn(),
      close: vi.fn(async () => { events.push("transport:close"); })
    };
    const generationEvents = {
      subscribe: vi.fn(),
      start: vi.fn(async () => { throw new Error("listener startup failed"); }),
      close: vi.fn(async () => { events.push("events:close"); })
    };
    const dependencies = {
      createPool: vi.fn(() => pool),
      createTransport: vi.fn(() => transport),
      configureTransport: vi.fn(),
      createGenerationEvents: vi.fn(() => generationEvents),
      dispatchRole: vi.fn()
    } as unknown as RuntimeLifecycleDependencies;

    await expect(runRuntimeLifecycle({ role: "all" } as never, new AbortController(), dependencies))
      .rejects.toThrow("listener startup failed");
    expect(events).toEqual(["transport:close", "events:close", "pool:end"]);
    expect(dependencies.dispatchRole).not.toHaveBeenCalled();
  });
});
