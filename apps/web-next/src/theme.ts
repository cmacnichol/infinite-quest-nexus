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
  set(theme: Theme): Theme;
  toggle(): Theme;
  subscribe(listener: (theme: Theme) => void): () => void;
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
  root.classList.toggle("wa-dark", theme === "dark");
  root.classList.toggle("wa-light", theme === "light");
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

function systemPrefersDark(mediaQuery: ThemeEnvironment["mediaQuery"]): boolean {
  try {
    return mediaQuery?.matches ?? false;
  } catch {
    return false;
  }
}

export function createThemeController(
  environment: ThemeEnvironment,
  onChange: (theme: Theme) => void = () => undefined
): ThemeController {
  const storedTheme = readStoredTheme(environment.storage);
  let hasManualPreference = storedTheme !== null;
  let theme = resolveTheme(storedTheme, systemPrefersDark(environment.mediaQuery));
  let listenerRegistered = false;
  const listeners = new Set<(theme: Theme) => void>();

  const commit = (next: Theme) => {
    if (next === theme) return;
    theme = next;
    applyTheme(environment.root, theme);
    onChange(theme);
    listeners.forEach((listener) => listener(theme));
  };
  const onSystemChange = (event: { matches: boolean }) => {
    if (!hasManualPreference) commit(event.matches ? "dark" : "light");
  };

  applyTheme(environment.root, theme);
  onChange(theme);
  try {
    environment.mediaQuery?.addEventListener("change", onSystemChange);
    listenerRegistered = environment.mediaQuery !== null;
  } catch {
    // Theme controls remain available when media query listeners are blocked.
  }

  const controller: ThemeController = {
    current: () => theme,
    set: (selected: Theme) => {
      hasManualPreference = true;
      writeStoredTheme(environment.storage, selected);
      commit(selected);
      return selected;
    },
    toggle: () => {
      const selected = nextTheme(theme);
      return controller.set(selected);
    },
    subscribe: (listener: (theme: Theme) => void) => {
      listeners.add(listener);
      listener(theme);
      return () => listeners.delete(listener);
    },
    dispose: () => {
      listeners.clear();
      if (listenerRegistered) {
        listenerRegistered = false;
        try {
          environment.mediaQuery?.removeEventListener("change", onSystemChange);
        } catch {
          // Disposal remains safe when media query listener removal is blocked.
        }
      }
    }
  };
  return controller;
}
