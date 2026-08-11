import {
  createThemeController,
  type Theme,
  type ThemeController,
  type ThemeEnvironment,
  type ThemeMediaQuery
} from "./theme";

const THEME_MEDIA_QUERY = "(prefers-color-scheme: dark)";

interface ThemeMediaSource {
  matchMedia?: ((query: string) => ThemeMediaQuery | null) | null;
}

interface ThemeControl {
  title: string;
  setAttribute(name: string, value: string): void;
  addEventListener(type: "click", listener: () => void): void;
  removeEventListener(type: "click", listener: () => void): void;
}

export function resolveThemeMediaQuery(source: ThemeMediaSource): ThemeMediaQuery | null {
  let matchMedia: ThemeMediaSource["matchMedia"] = null;
  try {
    matchMedia = source.matchMedia;
  } catch {
    return null;
  }

  if (typeof matchMedia !== "function") return null;
  try {
    return matchMedia.call(source, THEME_MEDIA_QUERY);
  } catch {
    return null;
  }
}

export function themeActionLabel(theme: Theme): string {
  return theme === "light" ? "Use dark theme" : "Use light theme";
}

export function initializeThemeControl(
  control: ThemeControl,
  environment: ThemeEnvironment
): ThemeController {
  const updateControl = (theme: Theme) => {
    const label = themeActionLabel(theme);
    control.setAttribute("aria-label", label);
    control.title = label;
  };
  const controller = createThemeController(environment, updateControl);
  const onClick = () => controller.toggle();
  let disposed = false;
  control.addEventListener("click", onClick);

  return {
    current: () => controller.current(),
    toggle: () => controller.toggle(),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      control.removeEventListener("click", onClick);
      controller.dispose();
    }
  };
}
