import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import {
  initializeThemeControl,
  resolveThemeMediaQuery
} from "../../apps/web-next/src/theme-control.js";
import {
  THEME_STORAGE_KEY,
  applyTheme,
  createThemeController,
  nextTheme,
  parseStoredTheme,
  resolveTheme
} from "../../apps/web-next/src/theme.js";

const webNextRoot = path.resolve(import.meta.dirname, "../../apps/web-next");

function runInlineThemeBootstrap(options: {
  stored?: string | null;
  matchMedia?: PropertyDescriptor;
}) {
  const html = fs.readFileSync(path.join(webNextRoot, "index.html"), "utf8");
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  if (!script) throw new Error("The inline theme bootstrap is missing.");

  const root = { dataset: {} as Record<string, string>, style: {} as Record<string, string> };
  const sandbox = {
    document: { documentElement: root },
    localStorage: { getItem: () => options.stored ?? null }
  };
  if (options.matchMedia) Object.defineProperty(sandbox, "matchMedia", options.matchMedia);

  vm.runInContext(script, vm.createContext(sandbox));
  return root;
}

function visibleThemeIcons(css: string, theme: "light" | "dark"): string[] {
  const displays = new Map([
    ["theme-icon-sun", "inline"],
    ["theme-icon-moon", "inline"]
  ]);

  for (const match of css.matchAll(/([^{}]+)\{([^{}]+)\}/g)) {
    const display = match[2].match(/display:\s*(\w+)/)?.[1];
    if (!display) continue;
    for (const selector of match[1].split(",").map((value) => value.trim())) {
      const requiredTheme = selector.match(/:root\[data-theme="(light|dark)"\]/)?.[1];
      if (requiredTheme && requiredTheme !== theme) continue;
      for (const icon of displays.keys()) {
        if (selector === ".theme-icon" || selector.endsWith(`.${icon}`)) displays.set(icon, display);
      }
    }
  }

  return [...displays].filter(([, display]) => display !== "none").map(([icon]) => icon);
}

function mediaQuery(matches: boolean) {
  const listeners = new Set<(event: { matches: boolean }) => void>();
  return {
    matches,
    addEventListener: (_type: "change", listener: (event: { matches: boolean }) => void) => listeners.add(listener),
    removeEventListener: (_type: "change", listener: (event: { matches: boolean }) => void) => listeners.delete(listener),
    emit(nextMatches: boolean) {
      this.matches = nextMatches;
      listeners.forEach((listener) => listener({ matches: nextMatches }));
    }
  };
}

describe("web theme integration", () => {
  it("applies a validated initial theme before the application module", () => {
    const html = fs.readFileSync(path.join(webNextRoot, "index.html"), "utf8");
    const bootstrapIndex = html.indexOf("infinite-quest.theme");
    const moduleIndex = html.indexOf("/src/bootstrap.ts");
    expect(bootstrapIndex).toBeGreaterThan(-1);
    expect(moduleIndex).toBeGreaterThan(bootstrapIndex);
    expect(html).toContain("prefers-color-scheme: dark");
    expect(html).toContain("document.documentElement.dataset.theme");
  });

  it("renders the reusable theme toggle with authored icon states", () => {
    const source = fs.readFileSync(path.join(webNextRoot, "src/bootstrap.ts"), "utf8");
    expect(source).toContain('class="theme-toggle"');
    expect(source).toContain('class="theme-icon theme-icon-sun"');
    expect(source).toContain('class="theme-icon theme-icon-moon"');
    expect(source).toContain("initializeThemeControl");
  });

  it("keeps a valid stored choice authoritative when matchMedia access throws", () => {
    const root = runInlineThemeBootstrap({
      stored: "dark",
      matchMedia: { get: () => { throw new Error("blocked"); } }
    });

    expect(root.dataset.theme).toBe("dark");
    expect(root.style.colorScheme).toBe("dark");
  });

  it("falls back to light when matchMedia access throws", () => {
    const root = runInlineThemeBootstrap({
      matchMedia: { get: () => { throw new Error("blocked"); } }
    });

    expect(root.dataset.theme).toBe("light");
    expect(root.style.colorScheme).toBe("light");
  });

  it("falls back to light when calling matchMedia throws", () => {
    const root = runInlineThemeBootstrap({
      matchMedia: { value: () => { throw new Error("blocked"); } }
    });

    expect(root.dataset.theme).toBe("light");
    expect(root.style.colorScheme).toBe("light");
  });

  it("falls back to light when reading media matches throws", () => {
    const root = runInlineThemeBootstrap({
      matchMedia: {
        value: () => Object.defineProperty({}, "matches", {
          get: () => { throw new Error("blocked"); }
        })
      }
    });

    expect(root.dataset.theme).toBe("light");
    expect(root.style.colorScheme).toBe("light");
  });

  it("uses a valid stored choice instead of the opposite system choice", () => {
    const root = runInlineThemeBootstrap({
      stored: "light",
      matchMedia: { value: () => ({ matches: true }) }
    });

    expect(root.dataset.theme).toBe("light");
    expect(root.style.colorScheme).toBe("light");
  });

  it("gives the theme control a square touch target and one visible icon per theme", () => {
    const css = fs.readFileSync(path.join(webNextRoot, "src/styles.css"), "utf8");
    const toggleRule = css.match(/\.theme-toggle\s*\{([^}]*)\}/)?.[1] ?? "";
    const iconRule = css.match(/\.theme-icon\s*\{([^}]*)\}/)?.[1] ?? "";

    expect(toggleRule).toMatch(/min-width:\s*44px/);
    expect(toggleRule).toMatch(/min-height:\s*44px/);
    expect(toggleRule).toMatch(/border-radius:\s*0/);
    expect(css).toMatch(/\.theme-toggle:focus-visible\s*\{[^}]*outline:/);
    expect(iconRule).toMatch(/width:\s*24px/);
    expect(iconRule).toMatch(/height:\s*24px/);
    expect(visibleThemeIcons(css, "light")).toEqual(["theme-icon-sun"]);
    expect(visibleThemeIcons(css, "dark")).toEqual(["theme-icon-moon"]);
  });
});

describe("web theme control integration", () => {
  it.each([
    ["property access", () => Object.defineProperty({}, "matchMedia", {
      get: () => { throw new Error("blocked"); }
    })],
    ["method call", () => ({
      matchMedia: () => { throw new Error("blocked"); }
    })]
  ])("keeps controller initialization and click registration functional when matchMedia %s throws", (_case, createSource) => {
    const { document, Event } = parseHTML("<html><body><button type=\"button\"></button></body></html>").window;
    const button = document.querySelector("button");
    if (!button) throw new Error("Button fixture is missing.");

    const mediaQuery = resolveThemeMediaQuery(createSource());
    expect(mediaQuery).toBeNull();
    initializeThemeControl(button, {
      root: document.documentElement,
      storage: null,
      mediaQuery
    });

    expect(button.getAttribute("aria-label")).toBe("Use dark theme");
    expect(button.title).toBe("Use dark theme");
    button.dispatchEvent(new Event("click"));
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(button.getAttribute("aria-label")).toBe("Use light theme");
    expect(button.title).toBe("Use light theme");
  });
});

describe("web theme policy", () => {
  it("accepts only explicit light and dark stored values", () => {
    expect(parseStoredTheme("light")).toBe("light");
    expect(parseStoredTheme("dark")).toBe("dark");
    expect(parseStoredTheme("system")).toBeNull();
    expect(parseStoredTheme(null)).toBeNull();
  });

  it("prefers a valid stored theme over the system preference", () => {
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });

  it("uses the system preference when no valid stored theme exists", () => {
    expect(resolveTheme(null, true)).toBe("dark");
    expect(resolveTheme("invalid", false)).toBe("light");
  });

  it("returns the opposite explicit theme", () => {
    expect(nextTheme("light")).toBe("dark");
    expect(nextTheme("dark")).toBe("light");
  });

  it("applies theme state to the document contract", () => {
    const { document } = parseHTML("<html><body></body></html>").window;
    applyTheme(document.documentElement, "dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.documentElement.style.colorScheme).toBe("dark");
  });

  it("tracks system changes until the user chooses a theme", () => {
    const { document } = parseHTML("<html><body></body></html>").window;
    const media = mediaQuery(false);
    const stored = new Map<string, string>();
    const storage = {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => void stored.set(key, value)
    };
    const controller = createThemeController({ root: document.documentElement, storage, mediaQuery: media });

    media.emit(true);
    expect(controller.current()).toBe("dark");
    expect(controller.toggle()).toBe("light");
    expect(stored.get(THEME_STORAGE_KEY)).toBe("light");
    media.emit(true);
    expect(controller.current()).toBe("light");
  });

  it("continues toggling when storage throws", () => {
    const { document } = parseHTML("<html><body></body></html>").window;
    const storage = {
      getItem: () => { throw new Error("blocked"); },
      setItem: () => { throw new Error("blocked"); }
    };
    const controller = createThemeController({ root: document.documentElement, storage, mediaQuery: mediaQuery(false) });
    expect(controller.toggle()).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("reads storage once during initialization", () => {
    const { document } = parseHTML("<html><body></body></html>").window;
    let reads = 0;
    const storage = {
      getItem: () => {
        reads += 1;
        return "dark";
      },
      setItem: () => undefined
    };

    const controller = createThemeController({ root: document.documentElement, storage, mediaQuery: mediaQuery(false) });

    expect(reads).toBe(1);
    expect(controller.current()).toBe("dark");
  });

  it("falls back to light and remains usable when reading media matches throws", () => {
    const { document } = parseHTML("<html><body></body></html>").window;
    const media = mediaQuery(false);
    Object.defineProperty(media, "matches", {
      get: () => { throw new Error("blocked"); }
    });

    const controller = createThemeController({ root: document.documentElement, storage: null, mediaQuery: media });

    expect(controller.current()).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(controller.toggle()).toBe("dark");
  });

  it("remains usable when media listener registration throws", () => {
    const { document } = parseHTML("<html><body></body></html>").window;
    const media = mediaQuery(false);
    media.addEventListener = () => { throw new Error("blocked"); };

    const controller = createThemeController({ root: document.documentElement, storage: null, mediaQuery: media });

    expect(controller.current()).toBe("light");
    expect(controller.toggle()).toBe("dark");
    expect(() => controller.dispose()).not.toThrow();
  });

  it("contains media listener disposal failures", () => {
    const { document } = parseHTML("<html><body></body></html>").window;
    const media = mediaQuery(false);
    media.removeEventListener = () => { throw new Error("blocked"); };
    const controller = createThemeController({ root: document.documentElement, storage: null, mediaQuery: media });

    expect(() => controller.dispose()).not.toThrow();
    expect(controller.toggle()).toBe("dark");
  });

  it("does not follow system changes when a stored preference exists", () => {
    const { document } = parseHTML("<html><body></body></html>").window;
    const media = mediaQuery(false);
    const storage = {
      getItem: () => "light",
      setItem: () => undefined
    };
    const controller = createThemeController({ root: document.documentElement, storage, mediaQuery: media });

    media.emit(true);

    expect(controller.current()).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("unregisters a successfully registered listener on disposal", () => {
    const { document } = parseHTML("<html><body></body></html>").window;
    const media = mediaQuery(false);
    const controller = createThemeController({ root: document.documentElement, storage: null, mediaQuery: media });

    controller.dispose();
    media.emit(true);

    expect(controller.current()).toBe("light");
  });
});
