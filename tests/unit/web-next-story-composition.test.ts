import { describe, expect, it } from "vitest";
import { createStoryPlayerComposition } from "../../apps/web-next/src/story-player-composition.js";

describe("replacement Story composition", () => {
  it("wires shared browser adapters without a browser-owned identity", () => {
    const composition = createStoryPlayerComposition({
      document: { hidden: false } as Document,
      storage: {
        getItem: () => null,
        setItem: () => undefined,
        removeItem: () => undefined
      } as Storage,
      eventSourceFactory: null,
      random: () => 0.5
    });

    expect(composition.api.illustrations).toBe(composition.illustrations);
    expect(composition.campaignStore.store.get().campaign).toBeNull();
    expect(composition.idFactory.create()).toMatch(/^[0-9a-f-]{36}$/i);
    expect(composition.clock.now()).toEqual(expect.any(Number));
  });
});
