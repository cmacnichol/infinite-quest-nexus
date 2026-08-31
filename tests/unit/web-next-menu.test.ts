import { parseHTML } from "linkedom";
import { describe, expect, it, vi } from "vitest";
import { mountMenu } from "../../apps/web-next/src/ui/menu.js";

function selectEvent(window: Window, value: unknown): Event {
  const event = new window.Event("wa-select", { bubbles: true });
  Object.defineProperty(event, "detail", { value: { item: { value } } });
  return event;
}

function setActiveElement(document: Document, element: Element): void {
  Object.defineProperty(document, "activeElement", { configurable: true, value: element });
}

describe("web-next command menu", () => {
  it("accepts only enabled registered commands", () => {
    const { document, window } = parseHTML("<body></body>");
    const selected = vi.fn();
    const menu = mountMenu(document, "Campaign Settings", [{ id: "activity", label: "Activity Log" }], selected);
    document.body.append(menu.element);

    menu.element.dispatchEvent(selectEvent(window, "activity"));

    expect(selected).toHaveBeenCalledExactlyOnceWith("activity");
    menu.dispose();
    menu.element.dispatchEvent(selectEvent(window, "activity"));
    expect(selected).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed, unknown, and disabled command events", () => {
    const { document, window } = parseHTML("<body></body>");
    const selected = vi.fn();
    const menu = mountMenu(document, "Campaign Settings", [
      { id: "activity", label: "Activity Log" },
      { id: "archive", label: "Archive", disabled: true }
    ], selected);

    menu.element.dispatchEvent(new window.Event("wa-select", { bubbles: true }));
    menu.element.dispatchEvent(selectEvent(window, "unknown"));
    menu.element.dispatchEvent(selectEvent(window, "archive"));

    expect(selected).not.toHaveBeenCalled();
  });

  it("renders labels as text and applies repeated item updates without replacing the trigger", () => {
    const { document } = parseHTML("<body></body>");
    const menu = mountMenu(document, "Campaign <Settings>", [{ id: "activity", label: "<img src=x onerror=alert(1)>" }], vi.fn());
    const trigger = menu.element.querySelector("wa-button");

    expect(trigger?.getAttribute("slot")).toBe("trigger");
    expect(trigger?.hasAttribute("with-caret")).toBe(true);
    expect(menu.element.querySelector("img")).toBeNull();
    expect(menu.element.querySelector("wa-dropdown-item")?.textContent).toBe("<img src=x onerror=alert(1)>");

    menu.update([{ id: "history", label: "Turn History" }]);
    menu.update([{ id: "activity", label: "Activity Log", disabled: true }]);

    expect(menu.element.querySelector("wa-button")).toBe(trigger);
    expect(menu.element.querySelector("wa-dropdown-item")?.getAttribute("value")).toBe("activity");
    expect(menu.element.querySelector("wa-dropdown-item")?.hasAttribute("disabled")).toBe(true);
  });

  it("makes disposal idempotent", () => {
    const { document, window } = parseHTML("<body></body>");
    const selected = vi.fn();
    const menu = mountMenu(document, "Campaign Settings", [{ id: "activity", label: "Activity Log" }], selected);

    menu.dispose();
    menu.dispose();
    menu.element.dispatchEvent(selectEvent(window, "activity"));

    expect(selected).not.toHaveBeenCalled();
  });

  it("closes through the Core public open property and returns menu focus to its trigger", () => {
    const { document, window } = parseHTML("<body></body>");
    const menu = mountMenu(document, "Campaign Settings", [{ id: "activity", label: "Activity Log" }], vi.fn());
    const dropdown = menu.element as HTMLElement & { open: boolean };
    const trigger = menu.element.querySelector<HTMLElement>("wa-button");
    if (!trigger) throw new Error("Menu trigger is missing.");
    const focus = vi.spyOn(trigger, "focus");
    dropdown.open = true;
    trigger.dispatchEvent(new window.Event("focusin", { bubbles: true }));
    setActiveElement(document, trigger);

    menu.close();

    expect(dropdown.open).toBe(false);
    expect(focus).toHaveBeenCalledExactlyOnceWith();
  });

  it("does not steal focus back after it moves to another menu or shell control", () => {
    const { document, window } = parseHTML("<body></body>");
    const menu = mountMenu(document, "Campaign Settings", [{ id: "activity", label: "Activity Log" }], vi.fn());
    const trigger = menu.element.querySelector<HTMLElement>("wa-button");
    const nextTrigger = document.createElement("wa-button");
    if (!trigger) throw new Error("Menu trigger is missing.");
    const focus = vi.spyOn(trigger, "focus");
    document.body.append(menu.element, nextTrigger);
    trigger.dispatchEvent(new window.Event("focusin", { bubbles: true }));
    setActiveElement(document, nextTrigger);

    menu.close();

    expect(focus).not.toHaveBeenCalled();
  });
});
