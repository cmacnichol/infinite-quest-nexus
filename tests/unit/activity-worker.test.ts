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
    const observe = vi.fn();
    const application = createActivityMaintenance(repository, { now: () => clock, observe });
    expect(await application.tick()).toBe(false);
    expect(observe).toHaveBeenCalledWith({ event: "activity_maintenance_error", errorCode: "activity-maintenance-failed" });
    expect(JSON.stringify(observe.mock.calls)).not.toContain("PRIVATE");
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
  it("reports only fixed quarantine counts and isolates an observer failure", async () => {
    const repository = { publishBatch: vi.fn(async () => ({ published: 2, quarantined: 1 })), pruneBatch: vi.fn(async () => 0) };
    const observe = vi.fn(() => { throw new Error("observer unavailable"); });
    expect(await createActivityMaintenance(repository, { observe }).tick()).toBe(true);
    expect(observe).toHaveBeenCalledWith({ event: "activity_publication_quarantined", errorCode: "invalid_snapshot", published: 2, quarantined: 1 });
    expect(repository.pruneBatch).toHaveBeenCalledOnce();
  });});
