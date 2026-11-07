import { expect, it } from "vitest";
import { createDeviceStorage } from "../../apps/web-next/src/preferences/device-storage.js";
import { createDisplayPreferences, DISPLAY_PREFERENCES_STORAGE_KEY } from "../../apps/web-next/src/preferences/display-preferences.js";

const a = { id: "5931cedc-7f39-4926-8373-8ca6c74068bb", systemKey: "initial-owner" };
const b = { id: "304df4fe-a21a-4c6c-90b1-42a33a78ca51", systemKey: null };
it("imports legacy device settings once for the server-resolved initial owner and isolates artwork and events", () => {
  const values = new Map([["infinite-quest.story.reading-width", "wide"], ["infinite-quest.theme", "dark"]]);
  const device = createDeviceStorage({ getItem: key => values.get(key) ?? null, setItem: (key, val) => { values.set(key, val); } });
  const display = createDisplayPreferences(device);
  expect(device.getItem("infinite-quest.theme")).toBeNull();
  device.activate(a); display.reload();
  expect(display.get().storyWidth).toBe("full");
  display.setCampaignArtwork("camp", false); display.setTurnArtwork("camp", "turn", false);
  const firstKey = device.key(DISPLAY_PREFERENCES_STORAGE_KEY);
  device.activate(b); display.reload();
  expect(display.get().storyWidth).toBe("auto");
  expect(display.artworkVisible("camp", "turn")).toBe(true);
  expect(device.key(DISPLAY_PREFERENCES_STORAGE_KEY)).not.toBe(firstKey);
  expect(device.getItem("infinite-quest.theme")).toBeNull();
  values.set("infinite-quest.theme", "light");
  device.activate(a); display.reload();
  expect(display.artworkVisible("camp", "turn")).toBe(false);
  expect(device.getItem("infinite-quest.theme")).toBe("dark");
  expect(values.get("infinite-quest.story.reading-width")).toBe("wide");
});
it("keeps blocked-storage edits in memory only for their active owner", () => {
  const blocked = () => { throw new Error("blocked"); };
  const device = createDeviceStorage({getItem: blocked, setItem: blocked});
  device.activate(a); device.setItem("infinite-quest.theme", "dark");
  expect(device.getItem("infinite-quest.theme")).toBe("dark");
  device.activate(null); expect(device.getItem("infinite-quest.theme")).toBeNull();
  device.activate(b); expect(device.getItem("infinite-quest.theme")).toBeNull();
});
