import { describe, expect, it, vi } from "vitest";
import { createLegacySectionLoader } from "../../apps/web/src/legacy-section-loader.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createLoader(loadSection: (request: { campaignId: string; selectionEpoch: number; section: string; signal: AbortSignal }) => Promise<string>) {
  const loader = createLegacySectionLoader({ loadSection });
  loader.setSelection("campaign-a", 1);
  return loader;
}

describe("legacy section loader", () => {
  it("coalesces concurrent reads and caches successful values", async () => {
    const response = deferred<string>();
    const loadSection = vi.fn(() => response.promise);
    const loader = createLoader(loadSection);

    const first = loader.loadSection("chronicle");
    const second = loader.loadSection("chronicle");
    expect(loadSection).toHaveBeenCalledTimes(1);
    response.resolve("chronicle data");

    await expect(Promise.all([first, second])).resolves.toEqual(["chronicle data", "chronicle data"]);
    await expect(loader.loadSection("chronicle")).resolves.toBe("chronicle data");
    expect(loadSection).toHaveBeenCalledTimes(1);
  });

  it("evicts a rejected read so the section can be retried", async () => {
    const loadSection = vi.fn()
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockResolvedValueOnce("recovered");
    const loader = createLoader(loadSection);

    await expect(loader.loadSection("story")).rejects.toThrow("temporary failure");
    await expect(loader.loadSection("story")).resolves.toBe("recovered");
    expect(loadSection).toHaveBeenCalledTimes(2);
  });

  it("invalidates only the requested section", async () => {
    const loadSection = vi.fn(({ section }: { section: string }) => Promise.resolve(`${section} data`));
    const loader = createLoader(loadSection);

    await expect(loader.loadSection("story")).resolves.toBe("story data");
    await expect(loader.loadSection("chronicle")).resolves.toBe("chronicle data");
    loader.invalidate("chronicle");

    await expect(loader.loadSection("story")).resolves.toBe("story data");
    await expect(loader.loadSection("chronicle")).resolves.toBe("chronicle data");
    expect(loadSection).toHaveBeenCalledTimes(3);
  });

  it("isolates cache entries by campaign and selection epoch", async () => {
    const loadSection = vi.fn(({ campaignId, selectionEpoch }: { campaignId: string; selectionEpoch: number }) => Promise.resolve(`${campaignId}:${selectionEpoch}`));
    const loader = createLegacySectionLoader({ loadSection });

    loader.setSelection("campaign-a", 1);
    await expect(loader.loadSection("story")).resolves.toBe("campaign-a:1");
    loader.setSelection("campaign-b", 1);
    await expect(loader.loadSection("story")).resolves.toBe("campaign-b:1");
    loader.setSelection("campaign-a", 2);
    await expect(loader.loadSection("story")).resolves.toBe("campaign-a:2");

    expect(loadSection).toHaveBeenCalledTimes(3);
    expect(loadSection.mock.calls.map(([request]) => [request.campaignId, request.selectionEpoch])).toEqual([
      ["campaign-a", 1],
      ["campaign-b", 1],
      ["campaign-a", 2]
    ]);
  });

  it("treats reselection of the same campaign as a new selection epoch", async () => {
    const loadSection = vi.fn(({ selectionEpoch }: { selectionEpoch: number }) => Promise.resolve(`epoch:${selectionEpoch}`));
    const loader = createLegacySectionLoader({ loadSection });

    loader.setSelection("campaign-a", 1);
    await expect(loader.loadSection("story")).resolves.toBe("epoch:1");
    loader.setSelection("campaign-a", 2);
    await expect(loader.loadSection("story")).resolves.toBe("epoch:2");

    expect(loadSection).toHaveBeenCalledTimes(2);
  });

  it("does not cache a late completion after section invalidation", async () => {
    const oldResponse = deferred<string>();
    const freshResponse = deferred<string>();
    const loadSection = vi.fn()
      .mockImplementationOnce(() => oldResponse.promise)
      .mockImplementationOnce(() => freshResponse.promise);
    const loader = createLoader(loadSection);

    const oldRead = loader.loadSection("illustrations");
    loader.invalidate("illustrations");
    const newRead = loader.loadSection("illustrations");
    expect(loadSection).toHaveBeenCalledTimes(2);
    oldResponse.resolve("stale");
    await expect(oldRead).rejects.toMatchObject({ name: "AbortError" });
    freshResponse.resolve("fresh");
    await expect(newRead).resolves.toBe("fresh");
    await expect(loader.loadSection("illustrations")).resolves.toBe("fresh");
    expect(loadSection).toHaveBeenCalledTimes(2);
  });

  it("retires pending work when the selection changes, even if it ignores abort", async () => {
    const oldResponse = deferred<string>();
    const newResponse = deferred<string>();
    const loadSection = vi.fn()
      .mockImplementationOnce(() => oldResponse.promise)
      .mockImplementationOnce(() => newResponse.promise);
    const loader = createLegacySectionLoader({ loadSection });
    loader.setSelection("campaign-a", 1);

    const oldRead = loader.loadSection("chronicle");
    loader.setSelection("campaign-b", 1);
    const newRead = loader.loadSection("chronicle");
    oldResponse.resolve("campaign a");
    await expect(oldRead).rejects.toMatchObject({ name: "AbortError" });
    newResponse.resolve("campaign b");
    await expect(newRead).resolves.toBe("campaign b");
    await expect(loader.loadSection("chronicle")).resolves.toBe("campaign b");
    expect(loadSection).toHaveBeenCalledTimes(2);
  });

  it("rejects a caller whose signal was already aborted without using the cache", async () => {
    const loadSection = vi.fn().mockResolvedValue("cached");
    const loader = createLoader(loadSection);
    await expect(loader.loadSection("usage")).resolves.toBe("cached");
    const controller = new AbortController();
    controller.abort();

    await expect(loader.loadSection("usage", controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(loadSection).toHaveBeenCalledTimes(1);
  });

  it("lets one caller abort without cancelling another coalesced caller", async () => {
    const response = deferred<string>();
    let operationSignal!: AbortSignal;
    const loadSection = vi.fn((request: { signal: AbortSignal }) => {
      operationSignal = request.signal;
      return response.promise;
    });
    const loader = createLoader(loadSection);
    const firstController = new AbortController();
    const first = loader.loadSection("story", firstController.signal);
    const second = loader.loadSection("story");
    firstController.abort();

    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    expect(operationSignal.aborted).toBe(false);
    response.resolve("still needed");
    await expect(second).resolves.toBe("still needed");
    expect(loadSection).toHaveBeenCalledTimes(1);
  });

  it("evicts and aborts a shared operation when all consumers cancel", async () => {
    const oldResponse = deferred<string>();
    const freshResponse = deferred<string>();
    const loadSection = vi.fn()
      .mockImplementationOnce((request: { signal: AbortSignal }) => {
        expect(request.signal.aborted).toBe(false);
        return oldResponse.promise;
      })
      .mockImplementationOnce(() => freshResponse.promise);
    const loader = createLoader(loadSection);
    const firstController = new AbortController();
    const secondController = new AbortController();
    const first = loader.loadSection("chronicle", firstController.signal);
    const second = loader.loadSection("chronicle", secondController.signal);

    firstController.abort();
    secondController.abort();
    await expect(Promise.all([first, second])).rejects.toMatchObject({ name: "AbortError" });
    const freshRead = loader.loadSection("chronicle");
    expect(loadSection).toHaveBeenCalledTimes(2);
    oldResponse.resolve("late old value");
    freshResponse.resolve("new value");
    await expect(freshRead).resolves.toBe("new value");
    await expect(loader.loadSection("chronicle")).resolves.toBe("new value");
    expect(loadSection).toHaveBeenCalledTimes(2);
  });
});
