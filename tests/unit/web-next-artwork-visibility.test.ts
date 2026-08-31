import { parseHTML } from "linkedom";
import { describe, expect, it, vi } from "vitest";
import { createDisplayPreferences } from "../../apps/web-next/src/preferences/display-preferences.js";
import { mountStoryArtwork } from "../../apps/web-next/src/story/ui/artwork.js";

function fixture() {
  const { document } = parseHTML("<body></body>");
  const display = createDisplayPreferences(null);
  const onLayoutChange = vi.fn();
  return { document, display, onLayoutChange, plate: mountStoryArtwork(document, display, onLayoutChange) };
}

describe("story artwork visibility", () => {
  it("scopes hidden artwork to an accepted turn identity", () => {
    const { document, plate } = fixture();
    plate.update({ campaignId: "a", turnId: "old" }, document.createElement("figure"));
    plate.setTurnVisible(false);

    expect(plate.element()).toBeNull();

    plate.update({ campaignId: "a", turnId: "replacement" }, document.createElement("figure"));
    expect(plate.element()).not.toBeNull();
  });

  it("honors campaign defaults, per-turn overrides, and reset without crossing campaign boundaries", () => {
    const { document, display, plate } = fixture();
    display.setCampaignArtwork("campaign-a", false);
    display.setCampaignArtwork("campaign-b", true);
    plate.update({ campaignId: "campaign-a", turnId: "same-turn" }, document.createElement("figure"));

    expect(plate.element()).toBeNull();

    plate.setTurnVisible(true);
    expect(plate.element()).not.toBeNull();
    plate.setTurnVisible(null);
    expect(plate.element()).toBeNull();

    plate.update({ campaignId: "campaign-b", turnId: "same-turn" }, document.createElement("figure"));
    expect(plate.element()).not.toBeNull();
  });

  it("preserves the rendered panel only while the current identity is visible", () => {
    const { document, plate } = fixture();
    const panel = document.createElement("figure");
    panel.tabIndex = 0;
    panel.textContent = "Existing illustration status.";

    expect(plate.element()).toBeNull();
    plate.update({ campaignId: "campaign-a", turnId: "turn-1" }, panel);
    expect(plate.element()?.firstElementChild).toBe(panel);
    expect(plate.element()?.textContent).toBe("Existing illustration status.");

    plate.setTurnVisible(false);
    expect(plate.element()).toBeNull();
    expect(panel.isConnected).toBe(false);
  });

  it("does not notify layout repeatedly for unchanged visibility", () => {
    const { document, display, onLayoutChange, plate } = fixture();
    const panel = document.createElement("figure");
    plate.update({ campaignId: "campaign-a", turnId: "turn-1" }, panel);
    const afterFirstUpdate = onLayoutChange.mock.calls.length;

    plate.update({ campaignId: "campaign-a", turnId: "turn-1" }, panel);
    display.setStoryWidth("comfortable");
    display.setCampaignArtwork("campaign-b", false);
    expect(onLayoutChange).toHaveBeenCalledTimes(afterFirstUpdate);

    display.setCampaignArtwork("campaign-a", false);
    expect(onLayoutChange).toHaveBeenCalledTimes(afterFirstUpdate + 1);
    display.setCampaignArtwork("campaign-a", false);
    expect(onLayoutChange).toHaveBeenCalledTimes(afterFirstUpdate + 1);
  });

  it("unsubscribes on disposal and never invokes network behavior", () => {
    const { document, display, onLayoutChange, plate } = fixture();
    const fetchSpy = vi.fn();
    const originalFetch = globalThis.fetch;
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: fetchSpy });
    try {
      plate.update({ campaignId: "campaign-a", turnId: "turn-1" }, document.createElement("figure"));
      plate.dispose();
      const callsBeforePreferenceChange = onLayoutChange.mock.calls.length;
      display.setCampaignArtwork("campaign-a", false);

      expect(plate.element()).toBeNull();
      expect(onLayoutChange).toHaveBeenCalledTimes(callsBeforePreferenceChange);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(globalThis, "fetch", { configurable: true, value: originalFetch });
    }
  });
});
