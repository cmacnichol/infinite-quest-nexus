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
import { mountWorldLibraryPage } from "../../apps/web-next/src/world-library-page.js";

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

  it("preserves search, retry, and theme controls after extracting the library page", async () => {
    const { document, Event } = parseHTML('<html><body><div id="app"></div></body></html>').window;
    const root = document.querySelector<HTMLElement>("#app");
    if (!root) throw new Error("Library fixture missing.");
    const fetchWorlds = vi.fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ worlds }), { status: 200 }));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    mountWorldLibraryPage(root, { fetchWorlds });
    await Promise.resolve();
    await Promise.resolve();
    expect(document.querySelector(".theme-toggle")).not.toBeNull();
    expect(document.querySelector('[data-action="retry-worlds"]')).not.toBeNull();

    document.querySelector<HTMLButtonElement>('[data-action="retry-worlds"]')?.click();
    await vi.waitFor(() => expect(document.querySelectorAll(".world-entry")).toHaveLength(2));
    const search = document.querySelector<HTMLInputElement>("#world-search");
    if (!search) throw new Error("Search fixture missing.");
    search.value = "mirrored";
    search.dispatchEvent(new Event("input", { bubbles: true }));

    expect(fetchWorlds).toHaveBeenCalledTimes(2);
    expect(document.querySelectorAll('a[href="/app/worlds/new"]')).toHaveLength(1);
    expect(document.querySelector('a[href="/app/worlds/new"]')?.textContent).toContain("Create world");
    expect(document.querySelectorAll(".world-entry")).toHaveLength(1);
    expect(document.querySelector(".world-entry")?.textContent).toContain("Glass Harbor");
    expect(document.querySelector(".world-entry a")?.getAttribute("href")).toBe("/app/worlds/world-1");
    consoleError.mockRestore();
  });

  it("routes the reserved new path to the creation shell without loading a world", async () => {
    const { window } = parseHTML('<html><body><div id="app"></div></body></html>');
    window.location = { pathname: "/app/worlds/new" } as Location;
    Object.defineProperty(window, "localStorage", { configurable: true, value: null });
    const fetch = vi.fn();
    const previousGlobals = new Map<PropertyKey, PropertyDescriptor | undefined>();
    for (const [name, value] of [["window", window], ["document", window.document], ["fetch", fetch]] as const) {
      previousGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
      Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    }

    try {
      vi.resetModules();
      await import("../../apps/web-next/src/bootstrap.js");
      expect(window.document.querySelectorAll('[data-page="world-creation"]')).toHaveLength(1);
      expect(window.document.querySelector('[data-page="world-editor"]')).toBeNull();
      expect(window.document.querySelector('[data-page="world-creation"] button:disabled')).not.toBeNull();
      expect(window.document.querySelector(".theme-toggle")).not.toBeNull();
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      for (const [name, descriptor] of previousGlobals) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
      vi.resetModules();
    }
  });

  it("gives the character workspace route precedence over library and world routes", async () => {
    const { window } = parseHTML('<html><body><div id="app"></div></body></html>');
    window.location = { pathname: "/app/characters/opaque-key" } as Location;
    Object.defineProperty(window, "localStorage", { configurable: true, value: null });
    Object.defineProperty(window, "sessionStorage", { configurable: true, value: null });
    const fetch = vi.fn();
    const previousGlobals = new Map<PropertyKey, PropertyDescriptor | undefined>();
    for (const [name, value] of [["window", window], ["document", window.document], ["fetch", fetch]] as const) {
      previousGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
      Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    }

    try {
      vi.resetModules();
      await import("../../apps/web-next/src/bootstrap.js");
      expect(window.document.querySelectorAll('[data-page="character-workspace-unavailable"]')).toHaveLength(1);
      expect(window.document.querySelector('[data-page="world-library"], [data-page="world-editor"]')).toBeNull();
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      for (const [name, descriptor] of previousGlobals) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
      vi.resetModules();
    }
  });

  it("keeps the mounted editor and theme control through BFCache transitions, then disposes on non-persisted pagehide", async () => {
    const { window } = parseHTML('<html><body><div id="app"></div></body></html>');
    window.location = { pathname: "/app/worlds/22222222-2222-4222-8222-222222222222" } as Location;
    Object.defineProperty(window, "localStorage", { configurable: true, value: null });
    let requestSignal: AbortSignal | undefined;
    const fetch = vi.fn((_url: string, init?: RequestInit) => {
      requestSignal = init?.signal ?? undefined;
      return new Promise<Response>(() => undefined);
    });
    const previousGlobals = new Map<PropertyKey, PropertyDescriptor | undefined>();
    for (const [name, value] of [["window", window], ["document", window.document], ["fetch", fetch]] as const) {
      previousGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
      Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    }

    try {
      vi.resetModules();
      await import("../../apps/web-next/src/bootstrap.js");
      expect(window.document.querySelectorAll('[data-page="world-editor"]')).toHaveLength(1);
      expect(window.document.querySelector('[data-page="world-library"]')).toBeNull();

      const persistedHide = new window.Event("pagehide");
      Object.defineProperty(persistedHide, "persisted", { value: true });
      window.dispatchEvent(persistedHide);
      const persistedShow = new window.Event("pageshow");
      Object.defineProperty(persistedShow, "persisted", { value: true });
      window.dispatchEvent(persistedShow);

      expect(requestSignal?.aborted).toBe(false);
      expect(window.document.querySelectorAll('[data-page="world-editor"]')).toHaveLength(1);
      window.document.querySelector<HTMLButtonElement>(".theme-toggle")?.click();
      expect(window.document.documentElement.dataset.theme).toBe("dark");

      const finalPageHide = new window.Event("pagehide");
      Object.defineProperty(finalPageHide, "persisted", { value: false });
      window.dispatchEvent(finalPageHide);
      expect(requestSignal?.aborted).toBe(true);
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
