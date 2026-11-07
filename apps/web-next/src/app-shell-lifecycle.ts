import type { UserProfile } from "@infinite-quest/contracts";
import type { ProfilePort } from "./preferences/profile-editor";
import { mountDevicePreferenceFields } from "@infinite-quest/client-web";
import { initializeAppTheme, renderAppShell, type AppNavigation, type AppShellOptions } from "./app-shell";
import { createDisplayPreferences, DISPLAY_PREFERENCES_STORAGE_KEY, type DisplayPreferencesStore } from "./preferences/display-preferences";
import { createDeviceStorage } from "./preferences/device-storage";
import { THEME_STORAGE_KEY, type ThemeController } from "./theme";
import { initializeUserProfileMenu } from "./user-profile-menu";
import { loadUserProfile, updateUserProfile } from "./user-profile-menu";
import type { MenuItem } from "./ui/menu";
import { mountShellMenus } from "./app-shell-menus";
import { mountPreferencesDialog, type PreferencesDialog } from "./preferences/preferences-dialog";
import { uiImplementation } from "./ui/feature-policy";
import "./app-shell.css";

export interface MountedAppShell {
  readonly theme: ThemeController;
  readonly display: DisplayPreferencesStore;
  setCampaignCommands(items: readonly MenuItem[], onSelect: (id: string) => void): void;
  setStoryContext(campaignId: string | null): void;
  dispose(): void;
}

function browserStorage(root: HTMLElement): Pick<Storage, "getItem" | "setItem"> | null {
  try {
    return root.ownerDocument.defaultView?.localStorage ?? null;
  } catch {
    return null;
  }
}

/** Mounts the static shell and owns only resources it creates itself. */
export function mountAppShell(
  root: HTMLElement,
  pageMarkup: string,
  navigation: AppNavigation,
  options: AppShellOptions = {}
): MountedAppShell {
  const implementation = options.uiImplementation ?? uiImplementation();
  renderAppShell(root, pageMarkup, navigation, options);
  root.querySelector<HTMLElement>(".app-shell")?.setAttribute("data-ui-implementation", implementation);
  const storage = createDeviceStorage(browserStorage(root));
  const identity = new AbortController();
  const theme = initializeAppTheme(root, storage);
  const borrowedDisplay = options.displayPreferences !== undefined;
  const display = options.displayPreferences ?? createDisplayPreferences(storage);
  if (borrowedDisplay) display.bindStorage?.(storage);
  let currentOwner: string | null = null;
  const acceptProfile = (user: UserProfile): UserProfile => {
    if (identity.signal.aborted) throw new DOMException("Profile session closed", "AbortError");
    if (currentOwner !== null && currentOwner !== user.id) {
      root.ownerDocument.defaultView?.dispatchEvent(new Event("app-identity-changed"));
      throw new DOMException("Profile session changed", "AbortError");
    }
    if (currentOwner !== user.id) {
      currentOwner = user.id;
      storage.activate(user);
      theme.reload?.();
      display.reload();
      if (deviceFields) deviceFields.element.disabled = false;
    }
    return user;
  };
  const profile: ProfilePort = {
    load: signal => loadUserProfile(signal).then(acceptProfile),
    save: (request, signal) => updateUserProfile(request, signal).then(acceptProfile)
  };
  const disposeProfile = implementation === "native" ? initializeUserProfileMenu(root, profile) : () => undefined;
  const coreMenus = implementation === "web-awesome" ? mountShellMenus(root, { theme, display }) : null;
  let preferences: PreferencesDialog | null = null;
  let preferenceCampaignId: string | null = null;
  const openPreferences = (): void => {
    if (disposed) return;
    if (!preferences) {
      preferences = mountPreferencesDialog(root, {
        theme,
        display,
        profile,
        campaignId: preferenceCampaignId
      });
    }
    void preferences.open();
  };
  const deviceFields = implementation === "native" ? mountDevicePreferenceFields(root.ownerDocument, theme, display) : null;
  if (deviceFields) {
    deviceFields.element.disabled = true;
    root.querySelector(".user-profile-dialog form")?.append(deviceFields.element);
  }
  const onOpenPreferences = () => openPreferences();
  if (implementation === "web-awesome") root.addEventListener("app-shell-open-preferences", onOpenPreferences);
  const view = root.ownerDocument.defaultView;
  let disposed = false;
  let storyCampaignId: string | null = null;

  void profile.load(identity.signal).catch(() => undefined);
  const onIdentityChange = () => {
    identity.abort();
    storage.activate(null);
    theme.reload?.();
    display.reload();
    disposeProfile();
    preferences?.dispose();
    preferences = null;
    coreMenus?.dispose();
    if (navigation !== "settings") {
      root.replaceChildren();
      view?.location?.reload();
    }
  };
  view?.addEventListener("app-identity-changed", onIdentityChange);
  const onStorage = (event: StorageEvent): void => {
    if (disposed || !event.key) return;
    if (event.key === storage.key(DISPLAY_PREFERENCES_STORAGE_KEY)) display.reload();
    if (event.key === storage.key(THEME_STORAGE_KEY)) theme.reload?.();
  };
  view?.addEventListener("storage", onStorage);

  return {
    theme,
    display,
    setCampaignCommands(items, onSelect): void {
      if (disposed) return;
      coreMenus?.setCampaignCommands(items, onSelect);
    },
    setStoryContext(campaignId): void {
      if (disposed || storyCampaignId === campaignId) return;
      storyCampaignId = campaignId;
      root.dataset.storyCampaignId = campaignId ?? "";
      const preferenceContextChanged = preferenceCampaignId !== campaignId;
      preferenceCampaignId = campaignId;
      deviceFields?.setCampaign(campaignId);
      coreMenus?.setStoryContext(campaignId);
      if (implementation === "web-awesome" && preferences && preferenceContextChanged) {
        preferences.close();
        preferences.dispose();
        preferences = null;
        preferenceCampaignId = campaignId;
      }
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      identity.abort();
      view?.removeEventListener("app-identity-changed", onIdentityChange);
      view?.removeEventListener("storage", onStorage);
      root.removeEventListener("app-shell-open-preferences", onOpenPreferences);
      preferences?.dispose();
      deviceFields?.dispose();
      coreMenus?.dispose();
      disposeProfile();
      theme.dispose();
      if (!borrowedDisplay) display.dispose();
    }
  };
}
