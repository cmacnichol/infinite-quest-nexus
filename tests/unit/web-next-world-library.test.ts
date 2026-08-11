import { parseHTML } from "linkedom";
import { describe, expect, it, vi } from "vitest";
import {
  filterWorlds,
  installArtworkFallback,
  parseWorldListResponse,
  safeArtworkUrl,
  worldDescription,
  worldEditorPath,
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
  it("routes world cards into the replacement World Editor", () => {
    expect(worldEditorPath("world / 1")).toBe("/app/worlds/world%20%2F%201");
  });

  it("bootstraps the routed World Editor loading state", async () => {
    const { window } = parseHTML('<div id="app"></div>');
    window.location = { pathname: "/app/worlds/22222222-2222-4222-8222-222222222222" } as Location;
    const previousGlobals = new Map<PropertyKey, PropertyDescriptor | undefined>();
    for (const [name, value] of [
      ["window", window],
      ["document", window.document],
      ["HTMLElement", window.HTMLElement]
    ] as const) {
      previousGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
      Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    }

    try {
      vi.resetModules();
      await import("../../apps/web-next/src/bootstrap.js");

      const loadingRegion = window.document.querySelector('[data-page="world-editor"]');
      expect(loadingRegion?.getAttribute("aria-busy")).toBe("true");
      expect(loadingRegion?.textContent).toContain("Loading world editor");
    } finally {
      for (const [name, descriptor] of previousGlobals) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
      vi.resetModules();
    }
  });

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
    expect(worldDescription(worlds[0]!)).toBe("A tidebound city of mirrored canals.");
    expect(worldDescription(worlds[1]!)).toBe("Keepers recover stories from volcanic ruins.");
    expect(worldDescription({ ...worlds[0]!, latestPreview: null })).toBe("Description not available.");
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
