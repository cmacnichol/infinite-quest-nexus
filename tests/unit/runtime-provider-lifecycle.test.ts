import { describe, expect, it, vi } from "vitest";
import {
  runRuntimeLifecycle,
  type RuntimeLifecycleDependencies
} from "../../services/runtime/src/lifecycle.js";

describe("runtime provider transport lifecycle", () => {
  it("configures transport before role dispatch and closes it before the pool", async () => {
    const events: string[] = [];
    const transport = {
      fetch: vi.fn(),
      validateSdkEndpoint: vi.fn(),
      close: vi.fn(async () => { events.push("transport:close"); })
    };
    const pool = {
      end: vi.fn(async () => { events.push("pool:end"); })
    };
    const dependencies = {
      createPool: vi.fn(() => pool),
      createTransport: vi.fn(() => transport),
      configureTransport: vi.fn(() => { events.push("transport:configure"); }),
      dispatchRole: vi.fn(async () => { events.push("role:dispatch"); })
    } as unknown as RuntimeLifecycleDependencies;

    await runRuntimeLifecycle({} as never, new AbortController(), dependencies);

    expect(events).toEqual([
      "transport:configure",
      "role:dispatch",
      "transport:close",
      "pool:end"
    ]);
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
      dispatchRole: vi.fn(async () => undefined)
    } as unknown as RuntimeLifecycleDependencies;

    await expect(runRuntimeLifecycle({} as never, new AbortController(), dependencies))
      .rejects.toThrow("transport close failed");
    expect(pool.end).toHaveBeenCalledOnce();
  });
});
