import "./menu.css";

export interface MenuItem {
  readonly id: string;
  readonly label: string;
  readonly disabled?: boolean;
}

export interface MenuHandle {
  readonly element: HTMLElement;
  close(): void;
  update(items: readonly MenuItem[]): void;
  dispose(): void;
}

type DropdownElement = HTMLElement & { open: boolean };

function activeElement(document: Document): HTMLElement | null {
  const candidate = document.activeElement;
  return candidate?.nodeType === 1 && typeof (candidate as HTMLElement).focus === "function"
    ? candidate as HTMLElement
    : null;
}

function selectedValue(event: Event): string | null {
  const detail = (event as CustomEvent<unknown>).detail;
  if (!detail || typeof detail !== "object") return null;
  const item = (detail as { item?: unknown }).item;
  if (!item || typeof item !== "object") return null;
  const value = (item as { value?: unknown }).value;
  return typeof value === "string" ? value : null;
}

export function mountMenu(document: Document, label: string, items: readonly MenuItem[], onSelect: (id: string) => void): MenuHandle {
  const dropdown = document.createElement("wa-dropdown") as DropdownElement;
  dropdown.className = "command-menu";

  const trigger = document.createElement("wa-button");
  trigger.className = "command-menu__trigger";
  trigger.setAttribute("slot", "trigger");
  trigger.setAttribute("with-caret", "");
  trigger.textContent = label;
  dropdown.append(trigger);

  let currentItems = items;
  let disposed = false;
  let returnFocus = false;
  const itemElements = new Map<string, HTMLElement>();

  const renderItems = (): void => {
    const focusedItem = activeElement(document);
    const focusedId = focusedItem?.matches("wa-dropdown-item") && dropdown.contains(focusedItem)
      ? focusedItem.getAttribute("value")
      : null;
    const nextIds = new Set(currentItems.map((item) => item.id));
    for (const item of currentItems) {
      let element = itemElements.get(item.id);
      if (!element) {
        element = document.createElement("wa-dropdown-item");
        element.className = "command-menu__item";
        element.setAttribute("value", item.id);
        itemElements.set(item.id, element);
      }
      if (element.getAttribute("value") !== item.id) element.setAttribute("value", item.id);
      if (element.hasAttribute("disabled") !== (item.disabled === true)) element.toggleAttribute("disabled", item.disabled === true);
      if (element.textContent !== item.label) element.textContent = item.label;
    }
    for (const [id, element] of itemElements) {
      if (nextIds.has(id)) continue;
      element.remove();
      itemElements.delete(id);
    }
    const existingOrder = [...dropdown.querySelectorAll("wa-dropdown-item")].map((element) => element.getAttribute("value"));
    const nextOrder = currentItems.map((item) => item.id);
    if (existingOrder.length !== nextOrder.length || existingOrder.some((id, index) => id !== nextOrder[index])) {
      let insertionPoint = trigger.nextSibling;
      for (const item of currentItems) {
        const element = itemElements.get(item.id);
        if (!element) continue;
        if (element !== insertionPoint) dropdown.insertBefore(element, insertionPoint);
        insertionPoint = element.nextSibling;
      }
    }
    const focusedNext = focusedId === null ? undefined : currentItems.find((item) => item.id === focusedId);
    if (focusedId !== null && (focusedNext === undefined || focusedNext.disabled)) {
      trigger.focus();
      returnFocus = false;
    }
  };

  const trackFocus = (event: FocusEvent): void => {
    returnFocus = event.target !== null && dropdown.contains(event.target as Node);
  };

  const select = (event: Event): void => {
    if (disposed) return;
    const value = selectedValue(event);
    if (!value) return;
    const accepted = currentItems.find((item) => item.id === value && !item.disabled);
    if (accepted) onSelect(accepted.id);
  };

  dropdown.addEventListener("focusin", trackFocus);
  dropdown.addEventListener("wa-select", select);
  renderItems();

  return {
    element: dropdown,
    close(): void {
      dropdown.open = false;
      const activeElement = document.activeElement;
      if (returnFocus && activeElement !== null && dropdown.contains(activeElement)) trigger.focus();
      returnFocus = false;
    },
    update(nextItems: readonly MenuItem[]): void {
      if (disposed) return;
      currentItems = nextItems;
      renderItems();
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      dropdown.removeEventListener("focusin", trackFocus);
      dropdown.removeEventListener("wa-select", select);
    }
  };
}
