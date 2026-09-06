export type UiImplementation = "native" | "web-awesome";

export function resolveUiImplementation(value: unknown): UiImplementation {
  return value === "web-awesome" ? "web-awesome" : "native";
}

export function uiImplementation(): UiImplementation {
  return resolveUiImplementation(import.meta.env.VITE_UI_COMPONENTS);
}
