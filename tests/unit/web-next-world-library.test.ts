import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import {
  filterWorlds,
  installArtworkFallback,
  parseWorldListResponse,
  safeArtworkUrl,
  worldDescription,
  type WorldSummary
} from "../../apps/web-next/src/world-library.js";

const worlds: WorldSummary[] = [
  {
    id: "world-1",
    title: "Glass Harbor",
    status: "active",
    imageUrl: "/assets/glass-harbor.webp",
    campaignCount: 2,
    latestPreview: { premise: "A tidebound city of mirrored canals." },
    draftPreview: null
  },
  {
    id: "world-2",
    title: "Ash Archive",
    status: "draft",
    imageUrl: "",
    campaignCount: 0,
    latestPreview: null,
    draftPreview: { backgroundStory: "Keepers recover stories from volcanic ruins." }
  },
  {
    id: "world-3",
    title: "Hidden World",
    status: "archived",
    imageUrl: "",
    campaignCount: 1,
    latestPreview: { premise: "Archived content." },
    draftPreview: null
  }
];

describe("World Library overview", () => {
  it("parses the API response at the browser boundary", () => {
    expect(parseWorldListResponse({ worlds }).worlds).toHaveLength(3);
    expect(() => parseWorldListResponse({ worlds: [{ title: "Missing fields" }] })).toThrow(
      "missing required information"
    );
  });

  it("searches titles and descriptions while excluding archived worlds", () => {
    expect(filterWorlds(worlds, "").map((world) => world.id)).toEqual(["world-1", "world-2"]);
    expect(filterWorlds(worlds, "mirrored").map((world) => world.id)).toEqual(["world-1"]);
    expect(filterWorlds(worlds, "ASH").map((world) => world.id)).toEqual(["world-2"]);
    expect(filterWorlds(worlds, "archived")).toEqual([]);
  });

  it("uses published copy before draft copy and provides a neutral fallback", () => {
    expect(worldDescription(worlds[0])).toBe("A tidebound city of mirrored canals.");
    expect(worldDescription(worlds[1])).toBe("Keepers recover stories from volcanic ruins.");
    expect(worldDescription({ ...worlds[0], latestPreview: null })).toBe("Description not available.");
  });

  it("accepts same-origin and HTTP artwork while rejecting unsafe schemes", () => {
    expect(safeArtworkUrl("/assets/cover.webp", "https://nexus.example")).toBe(
      "https://nexus.example/assets/cover.webp"
    );
    expect(safeArtworkUrl("javascript:alert(1)", "https://nexus.example")).toBe("");
  });

  it("replaces artwork that fails to load with a generated fallback", () => {
    const { document, Event } = parseHTML("<div><img></div>").window;
    const image = document.querySelector("img");
    if (!(image instanceof document.defaultView!.HTMLElement)) throw new Error("Image fixture missing");
    installArtworkFallback(image, () => {
      const fallback = document.createElement("span");
      fallback.className = "cover-fallback";
      return fallback;
    });

    image.dispatchEvent(new Event("error"));

    expect(document.querySelector("img")).toBeNull();
    expect(document.querySelector(".cover-fallback")).not.toBeNull();
  });
});
