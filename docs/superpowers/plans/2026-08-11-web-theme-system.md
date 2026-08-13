# Web Theme System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a reusable, persisted light/dark theme system and accessible header toggle to `apps/web-next`, while replacing the bright cobalt with a darker editorial indigo.

**Architecture:** A focused `theme.ts` module owns theme validation, preference resolution, persistence, DOM application, system-change synchronization, and cleanup. `bootstrap.ts` consumes that module and renders the shared header control. `styles.css` uses semantic theme tokens, while a minimal synchronous same-origin script from `public/theme-bootstrap.js` applies the initial theme before the application module loads without requiring a CSP exception.

**Tech Stack:** TypeScript, Vite, CSS custom properties, DOM `matchMedia`, `localStorage`, Vitest, LinkeDOM, Playwright/Chrome for bounded visual verification.

## Global Constraints

- First visit follows `prefers-color-scheme`; a valid stored manual choice overrides it.
- The only explicit themes are `light` and `dark`.
- The toggle is an icon-only, keyboard-accessible square control with a changing accessible label.
- Manual choice persists under one stable storage key and stops system-change synchronization.
- Storage and `matchMedia` failures must not block rendering or toggling.
- Theme state is represented on `<html>` with `data-theme="light|dark"` and `color-scheme`.
- Theme-dependent styling uses semantic tokens reusable by future pages; artwork is unchanged.
- Replace bright electric cobalt with a darker editorial indigo that passes contrast in both themes.
- Preserve the Constructed Atlas Grid structure, literary typography, reduced-motion behavior, and two-space indentation.

---

### Task 1: Theme Policy and Controller

**Files:**
- Create: `apps/web-next/src/theme.ts`
- Modify: `tests/unit/web-next-theme.test.ts`

**Interfaces:**
- Produces: `type Theme = "light" | "dark"`
- Produces: `const THEME_STORAGE_KEY = "infinite-quest.theme"`
- Produces: `parseStoredTheme(value: unknown): Theme | null`
- Produces: `resolveTheme(stored: unknown, systemPrefersDark: boolean): Theme`
- Produces: `nextTheme(theme: Theme): Theme`
- Produces: `applyTheme(root: HTMLElement, theme: Theme): void`
- Produces: `createThemeController(environment: ThemeEnvironment, onChange?: (theme: Theme) => void): ThemeController`
- `ThemeEnvironment` contains `root`, nullable storage, and nullable media query. `ThemeController` exposes `current()`, `toggle()`, and `dispose()`.

- [ ] **Step 1: Write failing policy tests**

Create `tests/unit/web-next-theme.test.ts`:

```ts
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
});
```

- [ ] **Step 2: Run the policy tests and verify RED**

Run:

```bash
pnpm vitest run tests/unit/web-next-theme.test.ts
```

Expected: FAIL because `apps/web-next/src/theme.ts` does not exist.

- [ ] **Step 3: Implement the minimal policy API**

Create `apps/web-next/src/theme.ts` with these public contracts and defensive storage helpers:

```ts
export type Theme = "light" | "dark";

export const THEME_STORAGE_KEY = "infinite-quest.theme";

export interface ThemeMediaQuery {
  matches: boolean;
  addEventListener(type: "change", listener: (event: { matches: boolean }) => void): void;
  removeEventListener(type: "change", listener: (event: { matches: boolean }) => void): void;
}

export interface ThemeEnvironment {
  root: HTMLElement;
  storage: Pick<Storage, "getItem" | "setItem"> | null;
  mediaQuery: ThemeMediaQuery | null;
}

export interface ThemeController {
  current(): Theme;
  toggle(): Theme;
  dispose(): void;
}

export function parseStoredTheme(value: unknown): Theme | null {
  return value === "light" || value === "dark" ? value : null;
}

export function resolveTheme(stored: unknown, systemPrefersDark: boolean): Theme {
  return parseStoredTheme(stored) ?? (systemPrefersDark ? "dark" : "light");
}

export function nextTheme(theme: Theme): Theme {
  return theme === "light" ? "dark" : "light";
}

export function applyTheme(root: HTMLElement, theme: Theme): void {
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
}

function readStoredTheme(storage: ThemeEnvironment["storage"]): Theme | null {
  try {
    return parseStoredTheme(storage?.getItem(THEME_STORAGE_KEY));
  } catch {
    return null;
  }
}

function writeStoredTheme(storage: ThemeEnvironment["storage"], theme: Theme): void {
  try {
    storage?.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Theme switching remains available when storage is blocked.
  }
}

export function createThemeController(
  environment: ThemeEnvironment,
  onChange: (theme: Theme) => void = () => undefined
): ThemeController {
  let hasManualPreference = readStoredTheme(environment.storage) !== null;
  let theme = resolveTheme(readStoredTheme(environment.storage), environment.mediaQuery?.matches ?? false);

  const commit = (next: Theme) => {
    theme = next;
    applyTheme(environment.root, theme);
    onChange(theme);
  };
  const onSystemChange = (event: { matches: boolean }) => {
    if (!hasManualPreference) commit(event.matches ? "dark" : "light");
  };

  commit(theme);
  environment.mediaQuery?.addEventListener("change", onSystemChange);

  return {
    current: () => theme,
    toggle: () => {
      hasManualPreference = true;
      const selected = nextTheme(theme);
      writeStoredTheme(environment.storage, selected);
      commit(selected);
      return selected;
    },
    dispose: () => environment.mediaQuery?.removeEventListener("change", onSystemChange)
  };
}
```

- [ ] **Step 4: Run policy tests and verify GREEN**

Run:

```bash
pnpm vitest run tests/unit/web-next-theme.test.ts
```

Expected: all policy tests PASS.

- [ ] **Step 5: Commit the theme policy**

```bash
git add apps/web-next/src/theme.ts tests/unit/web-next-theme.test.ts
git commit -m "Add reusable web theme policy"
```

---

### Task 2: Initial Theme Bootstrap and Shared Header Toggle

**Files:**
- Create: `apps/web-next/public/theme-bootstrap.js`
- Modify: `apps/web-next/index.html`
- Modify: `apps/web-next/src/bootstrap.ts`
- Modify: `tests/unit/web-next-theme.test.ts`

**Interfaces:**
- Consumes: `THEME_STORAGE_KEY`, `createThemeController`, and `Theme` from Task 1.
- Produces: header button `.theme-toggle` with `aria-label`, `title`, and two authored SVG states.
- Produces: early synchronous same-origin `<head>` script that applies `data-theme` before `/src/bootstrap.ts` executes under `script-src 'self'`.

- [ ] **Step 1: Write failing initial-bootstrap and label tests**

Add source-contract tests to `tests/unit/web-next-theme.test.ts`:

```ts
import fs from "node:fs";
import path from "node:path";

const webNextRoot = path.resolve(import.meta.dirname, "../../apps/web-next");

it("loads a CSP-compatible pre-render theme bootstrap before the application module", () => {
  const html = fs.readFileSync(path.join(webNextRoot, "index.html"), "utf8");
  const bootstrapIndex = html.indexOf('src="/app/theme-bootstrap.js"');
  const moduleIndex = html.indexOf('src="/src/bootstrap.ts"');
  expect(html).not.toMatch(/<script(?![^>]*\bsrc=)/i);
  expect(bootstrapIndex).toBeGreaterThan(-1);
  expect(moduleIndex).toBeGreaterThan(bootstrapIndex);
});

it("renders an accessible reusable theme toggle contract", () => {
  const source = fs.readFileSync(path.join(webNextRoot, "src/bootstrap.ts"), "utf8");
  expect(source).toContain('class="theme-toggle"');
  expect(source).toContain("Use dark theme");
  expect(source).toContain("Use light theme");
  expect(source).toContain("createThemeController");
});
```

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
pnpm vitest run tests/unit/web-next-theme.test.ts
```

Expected: FAIL because the early script, toggle markup, and controller wiring are absent.

- [ ] **Step 3: Add the pre-render theme bootstrap**

Create the focused classic script at `apps/web-next/public/theme-bootstrap.js`, and load it synchronously from `<head>` before the application module:

```html
<script vite-ignore src="/app/theme-bootstrap.js"></script>
```

The external script resolves stored, system, and light-fallback behavior and applies `data-theme` plus `color-scheme`. Keep `index.html` free of inline executable scripts so production `script-src 'self'` permits the bootstrap without `unsafe-inline`. Do not add application content or user data to the HTML.

- [ ] **Step 4: Add the shared header toggle markup**

In `bootstrap.ts`, import the theme module and place this button after the Story link inside `.site-header`:

```html
<button class="theme-toggle" type="button" aria-label="Use dark theme" title="Use dark theme">
  <svg class="theme-icon theme-icon-sun" viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="12" cy="12" r="3.5" />
    <path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M19.1 4.9l-1.8 1.8M6.7 17.3l-1.8 1.8" />
  </svg>
  <svg class="theme-icon theme-icon-moon" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M20 15.5A8.5 8.5 0 0 1 8.5 4 8.5 8.5 0 1 0 20 15.5Z" />
  </svg>
</button>
```

The sun indicates the current light theme; the moon indicates the current dark theme. The accessible label always names the action, not the current state.

- [ ] **Step 5: Wire the controller once**

After validating the page elements, locate `.theme-toggle`, create the controller, and update its label when theme changes:

```ts
const themeToggle = root.querySelector(".theme-toggle");
if (!(themeToggle instanceof HTMLButtonElement)) {
  throw new Error("The theme control could not be initialized.");
}

const updateThemeControl = (theme: Theme) => {
  const label = theme === "light" ? "Use dark theme" : "Use light theme";
  themeToggle.setAttribute("aria-label", label);
  themeToggle.title = label;
};

const themeController = createThemeController({
  root: document.documentElement,
  storage: window.localStorage,
  mediaQuery: window.matchMedia?.("(prefers-color-scheme: dark)") ?? null
}, updateThemeControl);

updateThemeControl(themeController.current());
themeToggle.addEventListener("click", () => themeController.toggle());
```

Keep this one controller at the app-shell boundary so future routes and pages share the same state.

- [ ] **Step 6: Run tests and verify GREEN**

```bash
pnpm vitest run tests/unit/web-next-theme.test.ts
```

Expected: all theme tests PASS.

- [ ] **Step 7: Run TypeScript check**

```bash
pnpm --filter @infinite-quest/web-next check
```

Expected: PASS with no TypeScript errors.

- [ ] **Step 8: Commit the integration**

```bash
git add apps/web-next/public/theme-bootstrap.js apps/web-next/index.html apps/web-next/src/bootstrap.ts tests/unit/web-next-theme.test.ts
git commit -m "Add web theme toggle"
```

---

### Task 3: Semantic Color Tokens and Dark Theme

**Files:**
- Modify: `apps/web-next/src/styles.css`
- Modify: `apps/web-next/DESIGN.md`
- Modify: `apps/web-next/.impeccable/design.json`
- Modify: `apps/web-next/.impeccable/surfaces/src-bootstrap-ts.md`
- Test: `tests/unit/web-next-theme.test.ts`

**Interfaces:**
- Consumes: `<html data-theme="light|dark">` from Tasks 1–2.
- Produces: semantic CSS token contract shared by all future web-next pages.
- Produces: responsive `.theme-toggle` styling and theme-specific icon visibility.

- [ ] **Step 1: Write a failing semantic-token contract test**

Append:

```ts
it("defines reusable light and dark semantic theme tokens", () => {
  const css = fs.readFileSync(path.join(webNextRoot, "src/styles.css"), "utf8");
  for (const token of [
    "--surface-page", "--surface-entry", "--surface-inverse",
    "--text-primary", "--text-secondary", "--text-inverse",
    "--rule", "--rule-strong", "--accent", "--accent-hover", "--accent-soft"
  ]) expect(css).toContain(token);
  expect(css).toContain(':root[data-theme="dark"]');
  expect(css).toContain(".theme-toggle");
  expect(css).toContain(".theme-icon-moon");
  expect(css).toContain(".theme-icon-sun");
});
```

- [ ] **Step 2: Run the test and verify RED**

```bash
pnpm vitest run tests/unit/web-next-theme.test.ts
```

Expected: FAIL because semantic tokens and dark overrides are absent.

- [ ] **Step 3: Define the semantic light and dark palettes**

Replace page-specific color usage with semantic values. Use this starting contract, adjusting only when rendered contrast measurements require it:

```css
:root {
  color-scheme: light;
  --surface-page: #dfe7ee;
  --surface-paper: rgba(248, 250, 251, 0.84);
  --surface-entry: rgba(248, 250, 251, 0.96);
  --surface-entry-hover: #ffffff;
  --surface-muted: #e6ebf0;
  --surface-inverse: #101418;
  --surface-atmosphere: #bdcbea;
  --text-primary: #101418;
  --text-secondary: #46515c;
  --text-inverse: #f5f7fb;
  --rule: #b8c5d0;
  --rule-strong: #8798a8;
  --accent: #2346a8;
  --accent-hover: #17327f;
  --accent-soft: #c8d5f2;
  --focus-shadow: rgba(35, 70, 168, 0.2);
  --artwork-fallback: #e1e7ec;
}

:root[data-theme="dark"] {
  color-scheme: dark;
  --surface-page: #111821;
  --surface-paper: rgba(17, 24, 33, 0.9);
  --surface-entry: rgba(24, 33, 44, 0.96);
  --surface-entry-hover: #202c3a;
  --surface-muted: #263342;
  --surface-inverse: #080d13;
  --surface-atmosphere: #1b2b4f;
  --text-primary: #edf2f7;
  --text-secondary: #b7c2cd;
  --text-inverse: #edf2f7;
  --rule: #39495a;
  --rule-strong: #5b6c7e;
  --accent: #8eabff;
  --accent-hover: #b5c7ff;
  --accent-soft: #243760;
  --focus-shadow: rgba(142, 171, 255, 0.24);
  --artwork-fallback: #25313d;
}
```

Map every UI color in `styles.css` to these semantic tokens. Keep user artwork URLs and image rendering unchanged. Remove obsolete `--cobalt`, `--paper`, `--canvas`, and similar visual-role aliases once no selectors consume them.

- [ ] **Step 4: Style the modular toggle**

Add a square 44px minimum target aligned with the header construction grid:

```css
.theme-toggle {
  width: 48px;
  min-width: 44px;
  min-height: 44px;
  align-self: stretch;
  display: grid;
  place-items: center;
  color: var(--accent);
  background: transparent;
  border: 0;
  border-left: 1px solid var(--rule-strong);
  cursor: pointer;
}

.theme-toggle:hover {
  color: var(--accent-hover);
  background: var(--accent-soft);
}

.theme-toggle:focus-visible {
  outline: 3px solid var(--accent);
  outline-offset: -3px;
}

.theme-icon {
  width: 20px;
  height: 20px;
}

.theme-icon-moon,
:root[data-theme="dark"] .theme-icon-sun {
  display: none;
}

:root[data-theme="dark"] .theme-icon-moon {
  display: block;
}
```

Update the desktop header grid to reserve the toggle column. On mobile, keep the toggle in the top header row and the four navigation destinations in the second row without horizontal clipping.

- [ ] **Step 5: Update durable design records**

In `DESIGN.md`:

- replace the bright Signal Cobalt values with the new deep editorial indigo light-theme role;
- document the dark palette and semantic token architecture;
- add a Theme Toggle component section;
- add a named rule requiring future pages to consume semantic tokens rather than literal theme colors.

In `.impeccable/design.json`:

- update canonical color metadata and tonal ramps;
- add both theme palettes under extensions without duplicating the frontmatter light primitives;
- add a self-contained theme-toggle component snippet;
- update the generated timestamp.

In the World Library surface brief, state that both themes preserve artwork priority, grid structure, and compact browsing density.

- [ ] **Step 6: Run tests and verify GREEN**

```bash
pnpm vitest run tests/unit/web-next-theme.test.ts tests/unit/web-next-world-library.test.ts
```

Expected: all tests PASS.

- [ ] **Step 7: Run static verification**

```bash
pnpm --filter @infinite-quest/web-next check
pnpm --filter @infinite-quest/web-next build
git diff --check -- apps/web-next tests/unit/web-next-theme.test.ts
node -e "JSON.parse(require('fs').readFileSync('apps/web-next/.impeccable/design.json','utf8'))"
```

Expected: all commands exit 0. Vite may report its existing public-font runtime-resolution notices; confirm `dist/fonts/` contains all four self-hosted font files.

- [ ] **Step 8: Perform bounded visual verification**

Start the API and Vite app, then capture desktop (`1440×1000`) and mobile (`400×844`) screenshots in both light and dark themes. Inspect all four together for:

- darker light-theme accent;
- readable title, description, labels, placeholders, and counts;
- visible card boundaries and grid rules;
- correct icon state and 44px target;
- no mobile navigation clipping;
- unchanged artwork;
- no incorrect-theme flash on reload.

Fix all material findings in one batch, then capture the same four views once more at most.

- [ ] **Step 9: Run the Impeccable detector once**

```bash
node .agents/skills/impeccable/scripts/detect.mjs --json apps/web-next/index.html apps/web-next/src/bootstrap.ts apps/web-next/src/styles.css
```

Resolve mechanical contrast or theme findings. Record intentional atlas-grid advisories rather than deleting approved construction material.

- [ ] **Step 10: Commit the theme system**

```bash
git add apps/web-next/src/styles.css apps/web-next/DESIGN.md apps/web-next/.impeccable/design.json apps/web-next/.impeccable/surfaces/src-bootstrap-ts.md tests/unit/web-next-theme.test.ts
git commit -m "Theme web application shell"
```

---

### Task 4: Final Cross-Page Contract Verification

**Files:**
- Modify only if verification finds a defect: `apps/web-next/src/theme.ts`, `apps/web-next/src/bootstrap.ts`, `apps/web-next/src/styles.css`, or their tests.

**Interfaces:**
- Consumes the complete shared theme contract.
- Produces evidence that future pages can reuse the module and semantic tokens without World Library dependencies.

- [ ] **Step 1: Verify module independence**

Confirm `theme.ts` imports no World Library modules and references no World Library selectors or copy:

```bash
rg -n "world|library|campaign" apps/web-next/src/theme.ts
```

Expected: no matches.

- [ ] **Step 2: Run complete targeted verification**

```bash
pnpm vitest run tests/unit/web-next-theme.test.ts tests/unit/web-next-world-library.test.ts
pnpm --filter @infinite-quest/web-next check
pnpm --filter @infinite-quest/web-next build
git diff --check -- apps/web-next tests/unit/web-next-theme.test.ts
```

Expected: all commands exit 0 and all tests pass.

- [ ] **Step 3: Review the complete diff**

```bash
git diff -- apps/web-next tests/unit/web-next-theme.test.ts
```

Confirm no user content, credentials, unrelated refactors, generated screenshots, Live wrappers, or provider assumptions entered the change.

- [ ] **Step 4: Commit any verification fix**

If Step 1–3 required code changes:

```bash
git add apps/web-next tests/unit/web-next-theme.test.ts
git commit -m "Harden web theme contract"
```

If no changes were required, do not create an empty commit.
