import { initializeAppTheme, renderAppShell, type AppNavigation, type AppShellOptions } from "./app-shell";
import { createDisplayPreferences, DISPLAY_PREFERENCES_STORAGE_KEY, type DisplayPreferencesStore } from "./preferences/display-preferences";
import type { ThemeController } from "./theme";
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
  const theme = initializeAppTheme(root);
  const borrowedDisplay = options.displayPreferences !== undefined;
  const display = options.displayPreferences ?? createDisplayPreferences(browserStorage(root));
  const disposeProfile = implementation === "native" ? initializeUserProfileMenu(root) : () => undefined;
  const coreMenus = implementation === "web-awesome" ? mountShellMenus(root, { theme, display }) : null;
  const profileToggle = root.querySelector<HTMLButtonElement>(".user-profile-toggle");
  let preferences: PreferencesDialog | null = null;
  let preferenceCampaignId: string | null = null;
  const openPreferences = (): void => {
    if (disposed) return;
    if (!preferences) {
      preferences = mountPreferencesDialog(root, {
        theme,
        display,
        profile: { load: loadUserProfile, save: updateUserProfile },
        campaignId: preferenceCampaignId
      });
    }
    void preferences.open();
  };
  const onOpenPreferences = () => openPreferences();
  if (implementation === "web-awesome") root.addEventListener("app-shell-open-preferences", onOpenPreferences);
  const view = root.ownerDocument.defaultView;
  let disposed = false;
  let storyCampaignId: string | null = null;

  const onStorage = (event: StorageEvent): void => {
    if (!disposed && event.key === DISPLAY_PREFERENCES_STORAGE_KEY) display.reload();
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
      view?.removeEventListener("storage", onStorage);
      root.removeEventListener("app-shell-open-preferences", onOpenPreferences);
      preferences?.dispose();
      coreMenus?.dispose();
      disposeProfile();
      theme.dispose();
      if (!borrowedDisplay) display.dispose();
    }
  };
}
