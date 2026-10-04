import { describe, expect, it, vi } from "vitest";
import { createStoryStreamRenderer } from "../../apps/web/src/story-stream-renderer.js";

function makeHarness() {
  let nextFrameId = 0;
  const callbacks = new Map<number, () => void>();
  const pendingFrames = new Set<number>();
  const scheduleFrame = vi.fn((callback: () => void) => {
    nextFrameId += 1;
    callbacks.set(nextFrameId, callback);
    pendingFrames.add(nextFrameId);
    return nextFrameId;
  });
  const cancelFrame = vi.fn((frameId: number) => {
    pendingFrames.delete(frameId);
  });
  const renderSafe = vi.fn<(text: string) => void>();
  const onFollow = vi.fn<() => void>();
  const renderer = createStoryStreamRenderer({ scheduleFrame, cancelFrame, renderSafe, onFollow });

  return {
    cancelFrame,
    pendingFrames,
    onFollow,
    renderSafe,
    renderer,
    scheduleFrame,
    runFrame(frameId: number) {
      pendingFrames.delete(frameId);
      callbacks.get(frameId)?.();
    }
  };
}

describe("createStoryStreamRenderer", () => {
  it("renders only the latest complete snapshot once per scheduled frame", () => {
    const { pendingFrames, onFollow, renderSafe, renderer, scheduleFrame, runFrame } = makeHarness();

    renderer.push("The", 1);
    renderer.push("The lantern", 1);
    renderer.push("The lantern glows.", 1);

    expect(scheduleFrame).toHaveBeenCalledTimes(1);
    expect(renderSafe).not.toHaveBeenCalled();
    runFrame(1);
    expect(renderSafe).toHaveBeenCalledExactlyOnceWith("The lantern glows.");
    expect(onFollow).toHaveBeenCalledTimes(1);
    expect(pendingFrames.size).toBe(0);
  });

  it("flushes the exact latest snapshot synchronously and makes the cancelled callback inert", () => {
    const { cancelFrame, onFollow, renderSafe, renderer, runFrame } = makeHarness();

    renderer.push("A partial", 4);
    renderer.push("A partial ending.", 4);
    renderer.flush();

    expect(cancelFrame).toHaveBeenCalledExactlyOnceWith(1);
    expect(renderSafe).toHaveBeenCalledExactlyOnceWith("A partial ending.");
    expect(onFollow).toHaveBeenCalledTimes(1);
    runFrame(1);
    expect(renderSafe).toHaveBeenCalledTimes(1);
    expect(onFollow).toHaveBeenCalledTimes(1);
  });

  it("drops buffered and late callbacks when reset establishes a new epoch", () => {
    const { onFollow, renderSafe, renderer, runFrame } = makeHarness();

    renderer.push("Old campaign", 10);
    renderer.reset(11);
    runFrame(1);
    renderer.push("Still old campaign", 10);
    renderer.push("New campaign", 11);
    runFrame(2);

    expect(renderSafe).toHaveBeenCalledExactlyOnceWith("New campaign");
    expect(onFollow).toHaveBeenCalledTimes(1);
  });

  it("keeps a cancelled callback inert after reset reuses the same epoch number", () => {
    const { onFollow, pendingFrames, renderSafe, renderer, runFrame } = makeHarness();

    renderer.push("Before same-epoch reset", 12);
    renderer.reset(12);
    renderer.push("After same-epoch reset", 12);
    runFrame(1);

    expect(renderSafe).not.toHaveBeenCalled();
    expect(onFollow).not.toHaveBeenCalled();
    expect(pendingFrames).toEqual(new Set([2]));

    runFrame(2);
    expect(renderSafe).toHaveBeenCalledExactlyOnceWith("After same-epoch reset");
    expect(onFollow).toHaveBeenCalledTimes(1);
  });

  it("keeps the cancelled pre-flush callback from consuming a later snapshot", () => {
    const { onFollow, pendingFrames, renderSafe, renderer, runFrame } = makeHarness();

    renderer.push("Snapshot before flush", 13);
    renderer.flush();
    renderer.push("Snapshot after flush", 13);
    runFrame(1);

    expect(renderSafe).toHaveBeenCalledExactlyOnceWith("Snapshot before flush");
    expect(onFollow).toHaveBeenCalledTimes(1);
    expect(pendingFrames).toEqual(new Set([2]));

    runFrame(2);
    expect(renderSafe.mock.calls).toEqual([["Snapshot before flush"], ["Snapshot after flush"]]);
    expect(onFollow).toHaveBeenCalledTimes(2);
  });

  it("ignores queued renders and pushes after disposal", () => {
    const { onFollow, renderSafe, renderer, runFrame } = makeHarness();

    renderer.push("Before disposal", 2);
    renderer.dispose();
    renderer.push("After disposal", 2);
    runFrame(1);

    expect(renderSafe).not.toHaveBeenCalled();
    expect(onFollow).not.toHaveBeenCalled();
  });

  it("does not follow after renderSafe reentrantly resets to another epoch", () => {
    const { onFollow, renderSafe, renderer, runFrame } = makeHarness();
    renderSafe.mockImplementation(() => renderer.reset(8));

    renderer.push("Old epoch snapshot", 7);
    runFrame(1);

    expect(renderSafe).toHaveBeenCalledExactlyOnceWith("Old epoch snapshot");
    expect(onFollow).not.toHaveBeenCalled();
  });

  it("does not follow or accept future work after renderSafe reentrantly disposes", () => {
    const { onFollow, renderSafe, renderer, runFrame, scheduleFrame } = makeHarness();
    renderSafe.mockImplementation(() => renderer.dispose());

    renderer.push("Final snapshot", 14);
    runFrame(1);
    renderer.push("After reentrant disposal", 14);
    renderer.flush();

    expect(renderSafe).toHaveBeenCalledExactlyOnceWith("Final snapshot");
    expect(onFollow).not.toHaveBeenCalled();
    expect(scheduleFrame).toHaveBeenCalledTimes(1);
  });
});
