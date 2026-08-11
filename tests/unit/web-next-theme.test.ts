import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import { initializeAppTheme, renderAppShell } from "../../apps/web-next/src/app-shell.js";
import {
  initializeThemeControl,
  installThemeControlLifecycle,
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

function runPreRenderThemeBootstrap(options: {
  stored?: string | null;
  matchMedia?: PropertyDescriptor;
}) {
  const script = fs.readFileSync(path.join(webNextRoot, "public/theme-bootstrap.js"), "utf8");
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

function cssDeclarations(css: string, selector: string): Map<string, string> {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const block = css.match(new RegExp(`${escapedSelector}\\s*\\{([^}]*)\\}`))?.[1];
  if (!block) throw new Error(`Missing CSS declaration block for ${selector}.`);

  return new Map([...block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((match) => [match[1], match[2].trim()]));
}

function cssRule(css: string, selector: string): string {
  const normalizedSelector = selector.replace(/\s+/g, " ").trim();
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (match[1].replace(/\s+/g, " ").trim() === normalizedSelector) return match[2];
  }
  return "";
}

function cssWithoutThemePalettes(css: string): string {
  return css
    .replace(/:root\[data-theme="dark"\]\s*\{[^}]*\}/, "")
    .replace(/:root\s*\{[^}]*\}/, "");
}

function contrastRatio(foreground: string, background: string): number {
  const luminance = (hex: string) => {
    const channels = hex.match(/[\da-f]{2}/gi);
    if (!channels || channels.length !== 3) throw new Error(`Expected a six-digit hex color, received ${hex}.`);
    const [red, green, blue] = channels.map((channel) => {
      const value = Number.parseInt(channel, 16) / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    return (0.2126 * red) + (0.7152 * green) + (0.0722 * blue);
  };
  const lighter = Math.max(luminance(foreground), luminance(background));
  const darker = Math.min(luminance(foreground), luminance(background));
  return (lighter + 0.05) / (darker + 0.05);
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
    },
    listenerCount: () => listeners.size
  };
}

function dispatchPageTransition(target: Window, EventConstructor: typeof Event, type: "pagehide" | "pageshow", persisted: boolean) {
  const event = new EventConstructor(type);
  Object.defineProperty(event, "persisted", { value: persisted });
  target.dispatchEvent(event);
}

describe("web theme integration", () => {
  it("loads a CSP-compatible pre-render theme bootstrap before the application module", () => {
    const html = fs.readFileSync(path.join(webNextRoot, "index.html"), "utf8");
    const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
    const bootstrapIndex = html.indexOf('src="/app/theme-bootstrap.js"');
    const moduleIndex = html.indexOf('src="/src/bootstrap.ts"');

    expect(scripts).toHaveLength(2);
    for (const [, attributes, body] of scripts) {
      expect(attributes).toMatch(/\bsrc="[^"]+"/);
      expect(body.trim()).toBe("");
    }
    expect(bootstrapIndex).toBeGreaterThan(-1);
    expect(moduleIndex).toBeGreaterThan(bootstrapIndex);
  });

  it("renders and initializes the shared theme control on every app page", () => {
    const { document, Event } = parseHTML('<html><body><div id="app"></div></body></html>').window;
    const root = document.querySelector<HTMLElement>("#app");
    if (!root) throw new Error("Shell fixture is missing.");

    renderAppShell(root, '<main id="main-content">Page</main>', "world-library");
    const theme = initializeAppTheme(root);
    const toggle = document.querySelector<HTMLButtonElement>(".theme-toggle");

    expect(toggle?.querySelector(".theme-icon-sun")).not.toBeNull();
    expect(toggle?.querySelector(".theme-icon-moon")).not.toBeNull();
    expect(toggle?.getAttribute("aria-label")).toBe("Use dark theme");
    toggle?.dispatchEvent(new Event("click"));
    expect(document.documentElement.dataset.theme).toBe("dark");
    theme.dispose();
  });

  it("keeps a valid stored choice authoritative when matchMedia access throws", () => {
    const root = runPreRenderThemeBootstrap({
      stored: "dark",
      matchMedia: { get: () => { throw new Error("blocked"); } }
    });

    expect(root.dataset.theme).toBe("dark");
    expect(root.style.colorScheme).toBe("dark");
  });

  it("falls back to light when matchMedia access throws", () => {
    const root = runPreRenderThemeBootstrap({
      matchMedia: { get: () => { throw new Error("blocked"); } }
    });

    expect(root.dataset.theme).toBe("light");
    expect(root.style.colorScheme).toBe("light");
  });

  it("falls back to light when calling matchMedia throws", () => {
    const root = runPreRenderThemeBootstrap({
      matchMedia: { value: () => { throw new Error("blocked"); } }
    });

    expect(root.dataset.theme).toBe("light");
    expect(root.style.colorScheme).toBe("light");
  });

  it("falls back to light when reading media matches throws", () => {
    const root = runPreRenderThemeBootstrap({
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
    const root = runPreRenderThemeBootstrap({
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
    expect(iconRule).toMatch(/width:\s*20px/);
    expect(iconRule).toMatch(/height:\s*20px/);
    expect(visibleThemeIcons(css, "light")).toEqual(["theme-icon-sun"]);
    expect(visibleThemeIcons(css, "dark")).toEqual(["theme-icon-moon"]);
  });

  it("defines the complete semantic contract independently in both theme blocks", () => {
    const css = fs.readFileSync(path.join(webNextRoot, "src/styles.css"), "utf8");
    const light = cssDeclarations(css, ":root");
    const dark = cssDeclarations(css, ':root[data-theme="dark"]');
    const requiredTokens = [
      "--surface-page", "--surface-paper", "--surface-entry", "--surface-entry-hover",
      "--surface-muted", "--surface-inverse", "--surface-atmosphere",
      "--text-primary", "--text-secondary", "--text-inverse", "--text-on-accent",
      "--rule", "--rule-strong", "--rule-grid", "--accent", "--accent-hover", "--accent-soft",
      "--accent-grid", "--focus-shadow", "--artwork-fallback", "--artwork-overlay"
    ];

    expect([...light.keys()].filter((token) => requiredTokens.includes(token))).toEqual(requiredTokens);
    expect([...dark.keys()]).toEqual(requiredTokens);
    for (const obsoleteToken of ["--ink", "--muted", "--paper", "--canvas", "--grid", "--grid-strong", "--cobalt"]) {
      expect(light.has(obsoleteToken)).toBe(false);
      expect(dark.has(obsoleteToken)).toBe(false);
      expect(css).not.toMatch(new RegExp(`${obsoleteToken}(?![\\w-])`));
    }
  });

  it("keeps literal theme colors inside the light and dark palette declarations", () => {
    const css = fs.readFileSync(path.join(webNextRoot, "src/styles.css"), "utf8");
    const selectors = cssWithoutThemePalettes(css);
    const themeInvariantMediaAllowlist = new Set<string>([]);
    const prohibitedColorLiteral = /#[\da-f]{3,8}\b|\brgba?\s*\(|\bcolor-mix\s*\(/i;
    const leaks = [...selectors.matchAll(/([^{}]+)\{([^{}]*)\}/g)].flatMap((rule) => {
      const selector = rule[1].replace(/\s+/g, " ").trim();
      return rule[2]
        .split(";")
        .map((declaration) => declaration.trim())
        .filter((declaration) => prohibitedColorLiteral.test(declaration))
        .map((declaration) => `${selector} { ${declaration} }`)
        .filter((leak) => !themeInvariantMediaAllowlist.has(leak));
    });

    expect(leaks).toEqual([]);
  });

  it("uses the shared semantic theme contract for the editor command and conflict surfaces", () => {
    const css = fs.readFileSync(path.join(webNextRoot, "src/styles.css"), "utf8");

    expect(cssRule(css, ".editor-command-row")).toMatch(/display:\s*grid/);
    expect(cssRule(css, ".editor-save-cell button")).toMatch(/background:\s*var\(--accent\)/);
    expect(cssRule(css, ".editor-save-cell button:disabled")).toMatch(/background:\s*var\(--surface-muted\)/);
    expect(cssRule(css, ".editor-field input:focus, .editor-field textarea:focus")).toMatch(/border-color:\s*var\(--accent\)/);
    expect(cssRule(css, ".save-conflict")).toMatch(/background:\s*var\(--surface-entry\)/);
  });

  it("keeps the footer identity readable on the inverse surface in every theme", () => {
    const css = fs.readFileSync(path.join(webNextRoot, "src/styles.css"), "utf8");
    const themes = [
      cssDeclarations(css, ":root"),
      cssDeclarations(css, ':root[data-theme="dark"]')
    ];

    for (const theme of themes) {
      expect(contrastRatio(
        theme.get("--text-inverse") ?? "",
        theme.get("--surface-inverse") ?? ""
      )).toBeGreaterThanOrEqual(4.5);
    }
    expect(cssRule(css, "footer p:first-child")).toMatch(/color:\s*var\(--text-inverse\)/);
  });

  it("keeps filled accent text readable in every theme and interaction state", () => {
    const css = fs.readFileSync(path.join(webNextRoot, "src/styles.css"), "utf8");
    const themes = [
      cssDeclarations(css, ":root"),
      cssDeclarations(css, ':root[data-theme="dark"]')
    ];

    for (const theme of themes) {
      const foreground = theme.get("--text-on-accent") ?? "";
      expect(contrastRatio(foreground, theme.get("--accent") ?? "")).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(foreground, theme.get("--accent-hover") ?? "")).toBeGreaterThanOrEqual(4.5);
    }

    expect(cssRule(css, ".coordinate")).toMatch(/color:\s*var\(--text-on-accent\)/);
    expect(cssRule(css, ".coordinate")).toMatch(/background:\s*var\(--accent\)/);
    expect(cssRule(css, ".library-message button")).toMatch(/color:\s*var\(--text-on-accent\)/);
    expect(cssRule(css, ".library-message button")).toMatch(/background:\s*var\(--accent\)/);
    const filledButtonState = cssRule(css, ".library-message button:hover, .library-message button:focus-visible");
    expect(filledButtonState).toMatch(/color:\s*var\(--text-on-accent\)/);
    expect(filledButtonState).toMatch(/background:\s*var\(--accent-hover\)/);
  });

  it("keeps the design sidecar synchronized with filled-accent and artwork roles", () => {
    const design = JSON.parse(fs.readFileSync(path.join(webNextRoot, ".impeccable/design.json"), "utf8"));
    const { light, dark } = design.extensions.themePalettes as Record<string, Record<string, string>>;
    const requiredTokens = ["--text-on-accent", "--focus-shadow", "--artwork-fallback", "--artwork-overlay"];

    for (const token of requiredTokens) {
      expect(light).toHaveProperty(token);
      expect(dark).toHaveProperty(token);
    }
    expect(dark["--artwork-overlay"]).toBe(light["--artwork-overlay"]);

    for (const componentName of ["Primary Button", "Indexed Content Entry", "Coordinate Chip"]) {
      const component = design.components.find((entry: { name: string }) => entry.name === componentName);
      expect(component?.css).toMatch(/var\(--text-on-accent/);
      expect(component?.css).not.toMatch(/var\(--text-inverse/);
    }
  });

  it("keeps artwork interaction treatment theme-invariant while preserving keyboard focus", () => {
    const css = fs.readFileSync(path.join(webNextRoot, "src/styles.css"), "utf8");
    const light = cssDeclarations(css, ":root");
    const dark = cssDeclarations(css, ':root[data-theme="dark"]');
    const overlayRule = cssRule(css, ".world-cover::after");

    expect(dark.get("--artwork-overlay")).toBe(light.get("--artwork-overlay"));
    expect(overlayRule).toMatch(/var\(--artwork-overlay\)/);
    expect(overlayRule).not.toMatch(/var\(--focus-shadow\)/);
    expect(cssRule(css, ".world-cover")).toMatch(/background:\s*var\(--artwork-fallback\)/);
    expect(cssRule(css, ".cover-fallback")).toMatch(/background-color:\s*var\(--artwork-fallback\)/);
    expect(cssRule(css, ".search-control:focus-within")).toMatch(/box-shadow:[^;]*var\(--focus-shadow\)/);
    expect(cssRule(css, ".world-link:focus-visible")).toMatch(/box-shadow:\s*inset[^;]*var\(--accent\)/);
  });
});

describe("web theme control integration", () => {
  it("preserves one working control across repeated persisted page-cache cycles", () => {
    const { document, Event, window } = parseHTML("<html><body><button type=\"button\"></button></body></html>").window;
    const button = document.querySelector("button");
    if (!button) throw new Error("Button fixture is missing.");
    const media = mediaQuery(false);
    let writes = 0;
    const control = initializeThemeControl(button, {
      root: document.documentElement,
      storage: {
        getItem: () => null,
        setItem: () => { writes += 1; }
      },
      mediaQuery: media
    });
    installThemeControlLifecycle(window, control);

    for (let cycle = 0; cycle < 3; cycle += 1) {
      dispatchPageTransition(window, Event, "pagehide", true);
      dispatchPageTransition(window, Event, "pageshow", true);
    }

    expect(media.listenerCount()).toBe(1);
    media.emit(true);
    expect(document.documentElement.dataset.theme).toBe("dark");
    media.emit(false);
    expect(document.documentElement.dataset.theme).toBe("light");
    button.dispatchEvent(new Event("click"));
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(writes).toBe(1);
  });

  it("disposes control listeners on non-persisted pagehide", () => {
    const { document, Event, window } = parseHTML("<html><body><button type=\"button\"></button></body></html>").window;
    const button = document.querySelector("button");
    if (!button) throw new Error("Button fixture is missing.");
    const media = mediaQuery(false);
    let writes = 0;
    const control = initializeThemeControl(button, {
      root: document.documentElement,
      storage: {
        getItem: () => null,
        setItem: () => { writes += 1; }
      },
      mediaQuery: media
    });
    installThemeControlLifecycle(window, control);

    dispatchPageTransition(window, Event, "pagehide", false);

    expect(media.listenerCount()).toBe(0);
    media.emit(true);
    button.dispatchEvent(new Event("click"));
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(writes).toBe(0);
  });

  it("removes click and system listeners on disposal before safe reinitialization", () => {
    const { document, Event } = parseHTML("<html><body><button type=\"button\"></button></body></html>").window;
    const button = document.querySelector("button");
    if (!button) throw new Error("Button fixture is missing.");
    const media = mediaQuery(false);
    let writes = 0;
    const storage = {
      getItem: () => null,
      setItem: () => { writes += 1; }
    };

    const disposedControl = initializeThemeControl(button, {
      root: document.documentElement,
      storage,
      mediaQuery: media
    });
    disposedControl.dispose();
    button.dispatchEvent(new Event("click"));
    media.emit(true);
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(writes).toBe(0);

    media.emit(false);
    const activeControl = initializeThemeControl(button, {
      root: document.documentElement,
      storage,
      mediaQuery: media
    });
    button.dispatchEvent(new Event("click"));
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(writes).toBe(1);
    activeControl.dispose();
  });

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
