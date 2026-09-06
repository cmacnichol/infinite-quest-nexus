import { describe, expect, it } from "vitest";
import { createDisplayPreferences } from "../../apps/web-next/src/preferences/display-preferences.js";
import { storyWidthLimits } from "../../apps/web-next/src/preferences/story-width.js";

const DISPLAY_KEY = "infinite-quest.display-preferences.v1";
const LEGACY_WIDTH_KEY = "infinite-quest.story.reading-width";

class MemoryStorage {
  readonly values = new Map<string, string>();
  failReads = false;
  failWrites = false;
  writeCount = 0;

  getItem = (key: string): string | null => {
    if (this.failReads) throw new Error("storage denied");
    return this.values.get(key) ?? null;
  };

  setItem = (key: string, value: string): void => {
    if (this.failWrites) throw new Error("quota exceeded");
    this.writeCount += 1;
    this.values.set(key, value);
  };
}

function storedPreferences(storage: MemoryStorage): unknown {
  return JSON.parse(storage.values.get(DISPLAY_KEY) ?? "null");
}

describe("display preferences", () => {
  it.each([
    ["narrow", "comfortable"],
    ["standard", "wide"],
    ["wide", "full"]
  ] as const)("migrates legacy %s width to %s without overwriting rollback state", (legacy, expected) => {
    const storage = new MemoryStorage();
    storage.values.set(LEGACY_WIDTH_KEY, legacy);

    const store = createDisplayPreferences(storage);
    expect(store.get().storyWidth).toBe(expected);
    store.setStoryWidth("comfortable");

    expect(store.get().storyWidth).toBe("comfortable");
    expect(storage.values.get(LEGACY_WIDTH_KEY)).toBe(legacy);
  });

  it("uses the migrated unbounded width for the full-width reading limits", () => {
    const storage = new MemoryStorage();
    storage.values.set(LEGACY_WIDTH_KEY, "wide");

    expect(storyWidthLimits(createDisplayPreferences(storage).get().storyWidth)).toEqual({ leaf: "none", prose: "none" });
  });

  it("uses a valid versioned payload ahead of an older width preference", () => {
    const storage = new MemoryStorage();
    storage.values.set(LEGACY_WIDTH_KEY, "wide");
    storage.values.set(DISPLAY_KEY, JSON.stringify({
      version: 1,
      storyWidth: "comfortable",
      artworkByCampaign: { "campaign-a": false },
      artworkByTurn: {}
    }));

    const store = createDisplayPreferences(storage);

    expect(store.get()).toEqual({
      version: 1,
      storyWidth: "comfortable",
      artworkByCampaign: { "campaign-a": false },
      artworkByTurn: {}
    });
  });

  it.each([
    ["invalid JSON", "{"],
    ["wrong version", JSON.stringify({ version: 2, storyWidth: "full", artworkByCampaign: {}, artworkByTurn: {} })],
    ["partial payload", JSON.stringify({ version: 1, storyWidth: "full", artworkByCampaign: {} })],
    ["unsafe map key", JSON.stringify({ version: 1, storyWidth: "full", artworkByCampaign: { constructor: true }, artworkByTurn: {} })]
  ])("ignores %s versioned state and falls back safely", (_name, payload) => {
    const storage = new MemoryStorage();
    storage.values.set(DISPLAY_KEY, payload);
    storage.values.set(LEGACY_WIDTH_KEY, "standard");

    expect(createDisplayPreferences(storage).get()).toEqual({
      version: 1,
      storyWidth: "wide",
      artworkByCampaign: {},
      artworkByTurn: {}
    });
  });

  it("separates campaign defaults from collision-safe turn overrides and resets", () => {
    const storage = new MemoryStorage();
    const store = createDisplayPreferences(storage);

    store.setCampaignArtwork("campaign-a", false);
    store.setCampaignArtwork("campaign-b", true);
    store.setTurnArtwork("campaign-a", "turn-1", true);
    store.setTurnArtwork("campaign-a:turn", "1", false);

    expect(store.artworkVisible("campaign-a", "turn-1")).toBe(true);
    expect(store.artworkVisible("campaign-a", "turn-2")).toBe(false);
    expect(store.artworkVisible("campaign-b", "turn-1")).toBe(true);
    expect(store.artworkVisible("campaign-a:turn", "1")).toBe(false);

    store.setTurnArtwork("campaign-a", "turn-1", null);
    expect(store.artworkVisible("campaign-a", "turn-1")).toBe(false);
  });

  it("does not apply an old turn preference to a replacement turn id", () => {
    const store = createDisplayPreferences(null);
    store.setTurnArtwork("campaign-a", "turn-old", false);

    expect(store.artworkVisible("campaign-a", "turn-replacement")).toBe(true);
  });

  it("keeps valid in-memory changes when storage is denied and protects returned snapshots", () => {
    const storage = new MemoryStorage();
    storage.failWrites = true;
    const store = createDisplayPreferences(storage);
    store.setStoryWidth("full");
    store.setCampaignArtwork("campaign-a", false);
    const snapshot = store.get() as { artworkByCampaign: Record<string, boolean> };
    snapshot.artworkByCampaign["campaign-a"] = true;

    expect(store.get()).toEqual({
      version: 1,
      storyWidth: "full",
      artworkByCampaign: { "campaign-a": false },
      artworkByTurn: {}
    });
  });

  it("immediately publishes, honors unsubscribe and dispose, and reloads external changes without writing", () => {
    const storage = new MemoryStorage();
    const store = createDisplayPreferences(storage);
    const published: string[] = [];
    const unsubscribe = store.subscribe((state) => published.push(state.storyWidth));

    store.setStoryWidth("comfortable");
    unsubscribe();
    store.setStoryWidth("wide");
    storage.values.set(DISPLAY_KEY, JSON.stringify({ version: 1, storyWidth: "full", artworkByCampaign: {}, artworkByTurn: {} }));
    const writeCountBeforeReload = storage.writeCount;
    store.reload();

    expect(published).toEqual(["auto", "comfortable"]);
    expect(store.get().storyWidth).toBe("full");
    expect(storage.writeCount).toBe(writeCountBeforeReload);

    store.dispose();
    storage.values.set(DISPLAY_KEY, JSON.stringify({ version: 1, storyWidth: "auto", artworkByCampaign: {}, artworkByTurn: {} }));
    store.reload();
    expect(store.get().storyWidth).toBe("full");
  });

  it("persists only recognized preference fields", () => {
    const storage = new MemoryStorage();
    const store = createDisplayPreferences(storage);
    store.setStoryWidth("wide");

    expect(storedPreferences(storage)).toEqual({ version: 1, storyWidth: "wide", artworkByCampaign: {}, artworkByTurn: {} });
  });
});
