import { describe, expect, it, vi } from "vitest";
import { createActivityMaintenance } from "../../packages/application/src/activity.js";

describe("activity maintenance", () => {
  it("bounds batches and cadence, including productive cleanup", async () => {
    let clock = 0;
    const repository = { publishBatch: vi.fn(async () => ({ published: 100, quarantined: 0 })), pruneBatch: vi.fn(async () => 1000) };
    const application = createActivityMaintenance(repository, { now: () => clock });
    expect(await application.tick()).toBe(true);
    expect(await application.tick()).toBe(false);
    clock = 1000;
    await application.tick();
    expect(repository.publishBatch.mock.calls).toEqual([[100], [100]]);
    expect(repository.pruneBatch.mock.calls).toEqual([[1000]]);
    clock = 60_000;
    await application.tick();
    expect(repository.pruneBatch).toHaveBeenCalledTimes(2);
  });
  it("isolates rejection and backs off without exposing exceptions", async () => {
    let clock = 0;
    const repository = { publishBatch: vi.fn(async () => { throw new Error("PRIVATE"); }), pruneBatch: vi.fn(async () => 0) };
    const application = createActivityMaintenance(repository, { now: () => clock });
    expect(await application.tick()).toBe(false);
    clock = 4999;
    await application.tick();
    expect(repository.publishBatch).toHaveBeenCalledTimes(1);
    clock = 5000;
    await application.tick();
    expect(repository.publishBatch).toHaveBeenCalledTimes(2);
  });
  it("admits only one in-flight batch", async () => {
    let release!: () => void;
    const repository = { publishBatch: vi.fn(async () => { await new Promise<void>(resolve => { release = resolve; }); return { published: 1, quarantined: 0 }; }), pruneBatch: vi.fn(async () => 0) };
    const application = createActivityMaintenance(repository);
    const pending = application.tick();
    expect(await application.tick()).toBe(false);
    release();
    expect(await pending).toBe(true);
  });
});
