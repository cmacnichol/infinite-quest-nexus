import type { MountedAppShell } from "./app-shell-lifecycle";
import { mountMenu, type MenuHandle, type MenuItem } from "./ui/menu";

export interface ShellMenus {
  setCampaignCommands: MountedAppShell["setCampaignCommands"];
  setStoryContext: MountedAppShell["setStoryContext"];
  dispose(): void;
}

/** Core-only presentation for campaign commands. Story owns their meaning. */
export function mountShellMenus(
  root: HTMLElement,
  _shell: Pick<MountedAppShell, "theme" | "display">
): ShellMenus {
  const host = root.querySelector<HTMLElement>("[data-shell-campaign-menu]");
  const profileHost = root.querySelector<HTMLElement>("[data-shell-profile-menu]");
  const nativeProfile = root.querySelector<HTMLElement>(".user-profile-toggle");
  if (!host || !profileHost || !nativeProfile) throw new Error("The shell menu hosts are missing.");
  const document = root.ownerDocument;
  let menu: MenuHandle | null = null;
  const profileMenu = mountMenu(document, "Profile", [{ id: "preferences", label: "Preferences" }], () => {
    root.dispatchEvent(new Event("app-shell-open-preferences"));
  });
  let campaignId: string | null = null;
  let disposed = false;
  let selectCampaignCommand: (id: string) => void = () => undefined;
  const onProfileOpen = (): void => menu?.close();
  const onCampaignOpen = (): void => profileMenu.close();
  nativeProfile.hidden = true;
  profileHost.hidden = false;
  profileHost.append(profileMenu.element);
  profileMenu.element.addEventListener("wa-show", onProfileOpen);

  return {
    setCampaignCommands(items: readonly MenuItem[], onSelect: (id: string) => void): void {
      if (disposed) return;
      if (!menu) {
        menu = mountMenu(document, "Campaign settings", items, (id) => selectCampaignCommand(id));
        menu.element.addEventListener("wa-show", onCampaignOpen);
        host.replaceChildren(menu.element);
      } else {
        menu.update(items);
      }
      selectCampaignCommand = onSelect;
      host.hidden = campaignId === null || items.length === 0;
    },
    setStoryContext(nextCampaignId: string | null): void {
      if (disposed || campaignId === nextCampaignId) return;
      campaignId = nextCampaignId;
      menu?.close();
      host.hidden = campaignId === null || menu === null;
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      profileMenu.element.removeEventListener("wa-show", onProfileOpen);
      profileMenu.dispose();
      profileHost.replaceChildren();
      profileHost.hidden = true;
      nativeProfile.hidden = false;
      menu?.element.removeEventListener("wa-show", onCampaignOpen);
      menu?.dispose();
      host.replaceChildren();
    }
  };
}
