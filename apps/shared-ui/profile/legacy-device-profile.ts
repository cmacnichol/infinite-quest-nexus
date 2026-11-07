import { browserDeviceStorage } from "@infinite-quest/client-web";
import { createDisplayPreferences, DISPLAY_PREFERENCES_STORAGE_KEY } from "@infinite-quest/client-web";
import { mountDevicePreferenceFields } from "./device-profile-controls.js";
import type { UserProfile } from "@infinite-quest/contracts";

/** Legacy profile windows edit the same replacement-client device preferences. */
export function mountLegacyDeviceProfile(root: HTMLElement, storage = browserDeviceStorage(root.ownerDocument.defaultView)) {
  const view = root.ownerDocument.defaultView!;
  const display = createDisplayPreferences(storage);
  const themeKey = "infinite-quest.theme";
  const themeListeners = new Set<(value: "light" | "dark") => void>();
  const themeValue = () => {
    const saved = storage.getItem(themeKey);
    return saved === "dark" || saved === "light" ? saved : view.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  };
  const refreshTheme = () => themeListeners.forEach(listener => listener(themeValue()));
  const fields = mountDevicePreferenceFields(root.ownerDocument, {
    set(value) { storage.setItem(themeKey, value); refreshTheme(); },
    subscribe(listener) { themeListeners.add(listener); listener(themeValue()); return () => { themeListeners.delete(listener); }; }
  }, display);
  root.append(fields.element);
  const onStorage = (event: StorageEvent) => {
    if (!event.key) return;
    if (event.key === storage.key(themeKey)) refreshTheme();
    if (event.key === storage.key(DISPLAY_PREFERENCES_STORAGE_KEY)) display.reload();
  };
  view.addEventListener("storage", onStorage);
  return {
    activate(user: Pick<UserProfile,"id" | "systemKey"> | null, campaignId: string | null) {
      storage.activate(user); refreshTheme(); display.reload(); fields.setCampaign(campaignId);
      fields.element.disabled = !user?.id;
    },
    dispose() { view.removeEventListener("storage", onStorage); fields.dispose(); display.dispose(); storage.activate(null); }
  };
}
