import { describe, expect, it, vi } from "vitest";
import { createSharedTextProviderCapacity } from "../../services/runtime/src/text-provider-capacity.js";

function fixture() {
  const live = new Set<string>();
  let sequence = 0;
  const repository = {
    tryAcquire: vi.fn(async (limit: number) => {
      if (live.size >= limit) return null;
      const id = String(++sequence); live.add(id); return id;
    }),
    release: vi.fn(async (id: string) => { live.delete(id); })
  };
  return { live, repository, capacity: createSharedTextProviderCapacity(repository, 1, 1) };
}

describe("shared text provider capacity", () => {
  it("preserves successful output and original provider errors when release fails", async () => {
    const { capacity, repository } = fixture();
    repository.release.mockRejectedValue(new Error("release database failure"));
    await expect(capacity.execute({ timeoutMs: 1000 }, async () => "paid output")).resolves.toBe("paid output");
    const failed = fixture();
    failed.repository.release.mockRejectedValue(new Error("release database failure"));
    await expect(failed.capacity.execute({ timeoutMs: 1000 }, async () => { throw new Error("provider error"); }))
      .rejects.toThrow("provider error");
  });
  it("holds capacity through asynchronous output and releases after success or failure", async () => {
    const { live, capacity } = fixture();
    let finish!: () => void;
    const output = new Promise<void>((resolve) => { finish = resolve; });
    const first = capacity.execute({ timeoutMs: 1000 }, async () => {
      expect(live.size).toBe(1); await output; return "complete";
    });
    await vi.waitFor(() => expect(live.size).toBe(1));
    const secondWork = vi.fn(async () => "second");
    const second = capacity.execute({ timeoutMs: 1000 }, secondWork);
    expect(secondWork).not.toHaveBeenCalled();
    finish();
    expect(await first).toBe("complete"); expect(await second).toBe("second");
    expect(live.size).toBe(0);
    await expect(capacity.execute({ timeoutMs: 1000 }, async () => { throw new Error("provider failed"); })).rejects.toThrow("provider failed");
    expect(live.size).toBe(0);
  });
  it("times out waiting without invoking provider work and honors caller cancellation", async () => {
    const { capacity, live } = fixture(); live.add("busy");
    const work = vi.fn();
    await expect(capacity.withPermit({ timeoutMs: 10 }, work)).rejects.toThrow();
    expect(work).not.toHaveBeenCalled();
    const controller = new AbortController();
    const pending = capacity.withPermit({ timeoutMs: 1000, signal: controller.signal }, work);
    controller.abort(); await expect(pending).rejects.toThrow();
    expect(work).not.toHaveBeenCalled(); expect(live.size).toBe(1);
  });
  it("reuses a prepared permit for sequential dispatches but does not allow parallel dispatch to bypass capacity", async () => {
    const { capacity, repository } = fixture();
    await capacity.withPermit({ timeoutMs: 1000 }, async () => {
      await capacity.execute({ timeoutMs: 1000 }, async () => "first");
      await capacity.execute({ timeoutMs: 1000 }, async () => "fallback");
      expect(repository.tryAcquire).toHaveBeenCalledTimes(1);
      let finish!: () => void;
      const held = new Promise<void>((resolve) => { finish = resolve; });
      const first = capacity.execute({ timeoutMs: 1000 }, async () => held);
      const work = vi.fn();
      await expect(capacity.execute({ timeoutMs: 10 }, work)).rejects.toThrow();
      expect(work).not.toHaveBeenCalled(); finish(); await first;
    });
    expect(repository.release).toHaveBeenCalledTimes(1);
  });
  it("aborts running work at its deadline, retaining capacity until work settles", async () => {
    const { capacity, live } = fixture();
    await expect(capacity.execute({ timeoutMs: 10 }, async (signal) => {
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      expect(live.size).toBe(1);
      signal.throwIfAborted();
    })).rejects.toThrow();
    expect(live.size).toBe(0);
  });
});
