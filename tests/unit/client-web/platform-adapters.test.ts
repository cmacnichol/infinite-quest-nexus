import { afterEach, describe, expect, it, vi } from "vitest";
import type { AbortSignalLike } from "../../../packages/client-core/src/index.js";
import { toAbortSignal } from "../../../packages/client-web/src/generation/abort-bridge.js";
import { createBrowserClock } from "../../../packages/client-web/src/platform/clock.js";
import { createBrowserDelayScheduler } from "../../../packages/client-web/src/platform/delay.js";
import { createBrowserIdFactory } from "../../../packages/client-web/src/platform/ids.js";
import { createDocumentVisibilitySource } from "../../../packages/client-web/src/platform/visibility.js";

function signal(initiallyAborted = false): AbortSignalLike & {
  abort(): void;
  listenerCount(): number;
} {
  let aborted = initiallyAborted;
  const listeners = new Set<() => void>();
  return {
    get aborted() { return aborted; },
    addEventListener(_type, listener) { listeners.add(listener); },
    removeEventListener(_type, listener) { listeners.delete(listener); },
    abort() {
      aborted = true;
      for (const listener of [...listeners]) listener();
    },
    listenerCount() { return listeners.size; }
  };
}

function documentSource(initiallyHidden: boolean): Document & {
  setHidden(hidden: boolean): void;
  listenerCount(): number;
} {
  let hidden = initiallyHidden;
  const listeners = new Set<EventListenerOrEventListenerObject>();
  return {
    get hidden() { return hidden; },
    addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
      if (type === "visibilitychange") listeners.add(listener);
    },
    removeEventListener(type: string, listener: EventListenerOrEventListenerObject) {
      if (type === "visibilitychange") listeners.delete(listener);
    },
    setHidden(next) {
      hidden = next;
      for (const listener of [...listeners]) {
        if (typeof listener === "function") listener(new Event("visibilitychange"));
        else listener.handleEvent(new Event("visibilitychange"));
      }
    },
    listenerCount() { return listeners.size; }
  } as Document & { setHidden(hidden: boolean): void; listenerCount(): number };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("browser platform adapters", () => {
  it("reads wall-clock time only when requested", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(123_456);
    const clock = createBrowserClock();

    expect(clock.now()).toBe(123_456);
    expect(now).toHaveBeenCalledTimes(1);
  });

  it("bridges an already-aborted pure signal and removes its listener on dispose", () => {
    const pureSignal = signal(true);
    const bridge = toAbortSignal(pureSignal);

    expect(bridge.signal.aborted).toBe(true);
    expect(pureSignal.listenerCount()).toBe(1);
    bridge.dispose();
    expect(pureSignal.listenerCount()).toBe(0);
  });

  it("resolves delay on time or abort and clears its listener exactly once", async () => {
    vi.useFakeTimers();
    const scheduler = createBrowserDelayScheduler();
    const timedSignal = signal();
    const timed = scheduler.wait(1500, timedSignal);
    expect(timedSignal.listenerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1500);
    await expect(timed).resolves.toBeUndefined();
    expect(timedSignal.listenerCount()).toBe(0);

    const abortedSignal = signal();
    const aborted = scheduler.wait(5000, abortedSignal);
    abortedSignal.abort();
    await expect(aborted).resolves.toBeUndefined();
    expect(abortedSignal.listenerCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("uses secure random UUIDs and rejects unavailable secure generation", () => {
    const randomUUID = vi.fn(() => "11111111-1111-4111-8111-111111111111");
    vi.stubGlobal("crypto", { randomUUID });
    expect(createBrowserIdFactory().create()).toBe("11111111-1111-4111-8111-111111111111");
    expect(randomUUID).toHaveBeenCalledTimes(1);

    vi.stubGlobal("crypto", undefined);
    expect(() => createBrowserIdFactory().create()).toThrow("Secure UUID generation is unavailable");
  });

  it("waits only while hidden and removes document and abort listeners on every exit", async () => {
    const document = documentSource(false);
    const source = createDocumentVisibilitySource(document);
    const visibleSignal = signal();
    await expect(source.waitUntilVisible(visibleSignal)).resolves.toBeUndefined();
    expect(document.listenerCount()).toBe(0);
    expect(visibleSignal.listenerCount()).toBe(0);

    document.setHidden(true);
    const revealSignal = signal();
    const revealed = source.waitUntilVisible(revealSignal);
    expect(document.listenerCount()).toBe(1);
    expect(revealSignal.listenerCount()).toBe(1);
    document.setHidden(false);
    await expect(revealed).resolves.toBeUndefined();
    expect(document.listenerCount()).toBe(0);
    expect(revealSignal.listenerCount()).toBe(0);

    document.setHidden(true);
    const abortSignal = signal();
    const aborted = source.waitUntilVisible(abortSignal);
    abortSignal.abort();
    await expect(aborted).resolves.toBeUndefined();
    expect(document.listenerCount()).toBe(0);
    expect(abortSignal.listenerCount()).toBe(0);
  });
});
