import { initializeThemeControl, resolveThemeMediaQuery } from "./theme-control";
import type { ThemeController } from "./theme";

export type AppNavigation = "world-library" | "world-editor" | "campaigns" | "story" | "setup";

function currentAttribute(current: AppNavigation, item: AppNavigation): string {
  return current === item ? ' aria-current="page"' : "";
}

export function renderAppShell(root: HTMLElement, pageMarkup: string, currentNavigation: AppNavigation): void {
  root.innerHTML = `
    <div class="app-shell">
      <header class="site-header">
        <a class="brand" href="/app/" aria-label="Infinite Quest Nexus home">
          <span class="visually-hidden">World Library — </span>
          <span class="brand-mark" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span>
          <span>Infinite Quest <b>Nexus</b></span>
        </a>
        <nav class="site-nav" aria-label="Primary navigation">
          <a href="/app/"${currentAttribute(currentNavigation, "world-library")}>World Library</a>
          <a href="/nexus/#campaigns"${currentAttribute(currentNavigation, "campaigns")}>Campaigns</a>
          <a href="/story"${currentAttribute(currentNavigation, "story")}>Story</a>
          <a href="/nexus/#providers"${currentAttribute(currentNavigation, "setup")}>Setup</a>
        </nav>
        <a class="story-link" href="/story">
          Enter story
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 17 17 7M8 7h9v9" /></svg>
        </a>
        <button class="theme-toggle" type="button" aria-label="Use dark theme" title="Use dark theme">
          <svg class="theme-icon theme-icon-sun" viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="12" cy="12" r="3.5" />
            <path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M19.1 4.9l-1.8 1.8M6.7 17.3l-1.8 1.8" />
          </svg>
          <svg class="theme-icon theme-icon-moon" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M20 15.5A8.5 8.5 0 0 1 8.5 4 8.5 8.5 0 1 0 20 15.5Z" />
          </svg>
        </button>
      </header>
      ${pageMarkup}
      <footer>
        <p>Infinite Quest Nexus</p>
        <p>Worlds remain separate from the campaigns they inspire.</p>
      </footer>
    </div>
  `;
}

export function initializeAppTheme(root: HTMLElement): ThemeController {
  const document = root.ownerDocument;
  const view = document.defaultView;
  const themeToggle = root.querySelector<HTMLButtonElement>(".theme-toggle");
  if (!themeToggle || !view) throw new Error("The theme control could not be initialized.");

  let storage: Storage | null = null;
  if (view.location) {
    try {
      storage = view.localStorage;
    } catch {
      // Theme switching remains available when storage access is blocked.
    }
  }

  const controller = initializeThemeControl(themeToggle, {
    root: document.documentElement,
    storage,
    mediaQuery: resolveThemeMediaQuery(view)
  });
  return controller;
}
