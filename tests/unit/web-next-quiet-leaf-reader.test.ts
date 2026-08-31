import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import { mountStoryReader } from "../../apps/web-next/src/story/ui/reader.js";

function fixture() {
  const { document } = parseHTML("<body><main></main></body>");
  const root = document.querySelector<HTMLElement>("main");
  if (!root) throw new Error("Quiet Leaf fixture root is missing.");
  return { document, root };
}

describe("Quiet Leaf reader", () => {
  it("renders title text safely and removes the inset track without artwork", () => {
    const { document, root } = fixture();
    const reader = mountStoryReader(root);
    const paragraph = document.createElement("p");
    paragraph.textContent = "Sanitized test narration.";

    reader.update({
      title: "<img src=x>", context: "Turn 1", width: "full", narration: [paragraph], history: null, artwork: null
    });

    const leaf = root.querySelector<HTMLElement>("[data-reading-leaf]");
    expect(root.querySelector("h1")?.textContent).toBe("<img src=x>");
    expect(root.querySelector("img")).toBeNull();
    expect(root.querySelector("[data-artwork-slot]")).toBeNull();
    expect(leaf?.dataset.storyWidth).toBe("full");
    expect(leaf?.dataset.hasArtwork).toBe("false");
    expect(leaf?.style.getPropertyValue("--story-leaf-max")).toBe("none");
    expect(leaf?.style.getPropertyValue("--story-prose-max")).toBe("none");
    expect(root.querySelector("[data-narration]")?.textContent).toContain("Sanitized test narration.");
  });

  it.each([
    ["auto", "1440px", "78ch"],
    ["comfortable", "800px", "65ch"],
    ["wide", "1440px", "100ch"]
  ] as const)("applies %s width limits to the leaf and stable composer mount", (width, leafLimit, proseLimit) => {
    const { root } = fixture();
    const reader = mountStoryReader(root);

    reader.update({ title: "Campaign", context: "Turn 2", width, narration: [], history: null, artwork: null });

    const leaf = root.querySelector<HTMLElement>("[data-reading-leaf]");
    const layout = root.querySelector<HTMLElement>("[data-reading-layout]");
    expect(leaf?.style.getPropertyValue("--story-leaf-max")).toBe(leafLimit);
    expect(leaf?.style.getPropertyValue("--story-prose-max")).toBe(proseLimit);
    expect(layout?.style.getPropertyValue("--story-layout-max")).toBe(leafLimit);
    expect(reader.composerRoot.style.getPropertyValue("--story-leaf-max")).toBe(leafLimit);
    expect(reader.composerRoot.style.getPropertyValue("--story-prose-max")).toBe(proseLimit);
  });

  it("collapses an empty history rail and restores the same rail for supplied history", () => {
    const { document, root } = fixture();
    const reader = mountStoryReader(root);
    const history = document.createElement("article");
    history.dataset.turnId = "turn-3";

    reader.update({ title: "Campaign", context: "Turn 4", width: "full", narration: [], history: null, artwork: null });

    const layout = root.querySelector<HTMLElement>("[data-reading-layout]");
    const historyRail = root.querySelector<HTMLElement>("[data-recent-history]");
    expect(layout?.dataset.hasHistory).toBe("false");
    expect(historyRail?.hidden).toBe(true);
    expect(historyRail?.tagName).toBe("DETAILS");
    expect(historyRail?.querySelector("summary")?.textContent).toBe("Recent turns");

    reader.update({ title: "Campaign", context: "Turn 4", width: "full", narration: [], history, artwork: null });

    expect(root.querySelector("[data-recent-history]")).toBe(historyRail);
    expect(layout?.dataset.hasHistory).toBe("true");
    expect(historyRail?.hidden).toBe(false);
    expect(historyRail?.hasAttribute("open")).toBe(false);
    expect(historyRail?.lastElementChild).toBe(history);
  });

  it("moves supplied artwork into an inset slot and preserves selected history nodes across updates", () => {
    const { document, root } = fixture();
    const reader = mountStoryReader(root);
    const artwork = document.createElement("figure");
    artwork.dataset.turnId = "turn-7";
    const history = document.createElement("article");
    history.dataset.turnId = "turn-6";
    history.dataset.selected = "true";

    reader.update({ title: "Campaign", context: "Turn 7", width: "wide", narration: [], history, artwork });

    const artSlot = root.querySelector<HTMLElement>("[data-artwork-slot]");
    const historySlot = root.querySelector<HTMLElement>("[data-recent-history]");
    expect(artSlot?.firstElementChild).toBe(artwork);
    expect(historySlot?.lastElementChild).toBe(history);
    expect(historySlot?.querySelector("summary")?.getAttribute("aria-label")).toBe("Show recent turns");
    expect(historySlot?.dataset.readingHistoryRail).toBe("");
    expect(historySlot?.parentElement?.dataset.readingLayout).toBe("");

    reader.update({ title: "Campaign", context: "Turn 8", width: "wide", narration: [], history, artwork: null });

    expect(root.querySelector("[data-artwork-slot]")).toBeNull();
    expect(root.querySelector("[data-recent-history]")?.lastElementChild).toBe(history);
    expect(history.dataset.selected).toBe("true");
  });

  it("keeps presenter mount slots and their children stable until disposal", () => {
    const { document, root } = fixture();
    const reader = mountStoryReader(root);
    const composerChild = document.createElement("form");
    const footerChild = document.createElement("button");
    reader.composerRoot.append(composerChild);
    reader.footerRoot.append(footerChild);

    reader.update({ title: "Campaign", context: "Turn 1", width: "comfortable", narration: [], history: null, artwork: null });
    reader.update({ title: "Campaign", context: "Turn 2", width: "full", narration: [], history: null, artwork: null });

    expect(reader.composerRoot.firstElementChild).toBe(composerChild);
    expect(reader.footerRoot.firstElementChild).toBe(footerChild);
    expect(root.querySelector("[data-composer-root]")).toBe(reader.composerRoot);
    expect(root.querySelector("[data-footer-root]")).toBe(reader.footerRoot);

    reader.dispose();
    expect(root.querySelector("[data-reading-leaf]")).toBeNull();
  });
});
