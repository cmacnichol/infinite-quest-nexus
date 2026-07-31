import { afterEach, describe, expect, it, vi } from "vitest";
import { closeDatabasePool } from "../../services/runtime/src/shutdown.js";

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
});
