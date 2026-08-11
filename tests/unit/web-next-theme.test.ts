import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import {
  THEME_STORAGE_KEY,
  applyTheme,
  createThemeController,
  nextTheme,
  parseStoredTheme,
  resolveTheme
} from "../../apps/web-next/src/theme.js";

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
