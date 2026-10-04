export interface LegacyTabItem {
  readonly key: string;
  readonly tab: HTMLButtonElement;
  readonly panel: HTMLElement;
}

export interface LegacyTabGroupOptions {
  readonly root: HTMLElement;
  readonly tabs: readonly LegacyTabItem[];
  readonly getSelectedKey: () => string;
  readonly onActivate: (key: string) => void;
}

export interface LegacyTabGroupBinding {
  sync(): void;
  dispose(): void;
}

function isUnavailable(item: LegacyTabItem): boolean {
  if (item.tab.disabled || item.tab.getAttribute("aria-disabled") === "true") return true;
  return Boolean(item.tab.closest('[aria-busy="true"], [inert]'));
}

export function bindLegacyTabGroup(options: LegacyTabGroupOptions): LegacyTabGroupBinding {
  const { root, tabs, getSelectedKey, onActivate } = options;
  const mappedTabs = new Map(tabs.map(item => [item.tab, item] as const));
  let disposed = false;

  const sync = () => {
    if (disposed) return;
    root.setAttribute("role", "tablist");
    root.setAttribute("aria-orientation", "horizontal");
    const selectedKey = getSelectedKey();
    for (const item of tabs) {
      const selected = item.key === selectedKey;
      item.tab.setAttribute("role", "tab");
      item.tab.setAttribute("aria-controls", item.panel.id);
      item.tab.setAttribute("aria-selected", String(selected));
      item.tab.setAttribute("tabindex", selected && !isUnavailable(item) ? "0" : "-1");
      item.panel.setAttribute("role", "tabpanel");
      item.panel.setAttribute("aria-labelledby", item.tab.id);
      item.panel.hidden = !selected;
      item.panel.classList.toggle("active", selected);
      item.panel.classList.toggle("hidden", !selected);
    }
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (disposed || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const target = event.target;
    if (!target || typeof (target as Element).closest !== "function") return;
    const targetElement = target as Element;
    const currentTab = targetElement.closest("[role='tab']");
    if (!currentTab || currentTab !== targetElement) return;
    const currentItem = mappedTabs.get(currentTab as HTMLButtonElement);
    if (!currentItem || !root.contains(currentTab) || isUnavailable(currentItem)) return;

    const enabledTabs = tabs.filter(item => !isUnavailable(item));
    if (enabledTabs.length < 2) return;
    const currentIndex = enabledTabs.findIndex(item => item === currentItem);
    if (currentIndex < 0) return;

    let nextIndex: number;
    if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = enabledTabs.length - 1;
    else {
      const delta = event.key === "ArrowRight" ? 1 : -1;
      nextIndex = (currentIndex + delta + enabledTabs.length) % enabledTabs.length;
    }

    const nextItem = enabledTabs[nextIndex];
    if (!nextItem) return;
    event.preventDefault();
    onActivate(nextItem.key);
    sync();
    if (getSelectedKey() === nextItem.key && !disposed) nextItem.tab.focus();
  };

  root.addEventListener("keydown", onKeyDown);
  sync();

  return {
    sync,
    dispose() {
      if (disposed) return;
      disposed = true;
      root.removeEventListener("keydown", onKeyDown);
    }
  };
}
