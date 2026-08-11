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
