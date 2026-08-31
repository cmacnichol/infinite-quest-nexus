import { parseHTML } from "linkedom";
import { describe, expect, it, vi } from "vitest";
import { mountTurnLength, parseTurnLength } from "../../apps/web-next/src/story/ui/turn-length.js";

function fixture() {
  const { document, window } = parseHTML("<body></body>");
  const onChange = vi.fn();
  const control = mountTurnLength(document, onChange);
  document.body.append(control.element);
  control.update({ campaignDefault: "standard", override: null, disabled: false });
  return { document, window, onChange, control };
}

function installNativeDialogStubs(dialog: HTMLDialogElement, Event: typeof globalThis.Event) {
  Object.defineProperties(dialog, {
    showModal: { configurable: true, value: function (this: HTMLDialogElement) { this.setAttribute("open", ""); } },
    close: { configurable: true, value: function (this: HTMLDialogElement) { this.removeAttribute("open"); this.dispatchEvent(new Event("close")); } }
  });
}

function setValue(element: HTMLElement, value: string, Event: typeof globalThis.Event) {
  (element as unknown as { value: string }).value = value;
  element.dispatchEvent(new Event("change", { bubbles: true }));
}

describe("Story turn-length control", () => {
  it("accepts only the existing length profiles", () => {
    expect(parseTurnLength("")).toBeNull();
    expect(parseTurnLength("brief")).toBe("brief");
    expect(parseTurnLength("standard")).toBe("standard");
    expect(parseTurnLength("long")).toBe("long");
    expect(parseTurnLength("extended")).toBe("extended");
    expect(parseTurnLength("1 turn")).toBeUndefined();
    expect(parseTurnLength({ value: "brief" })).toBeUndefined();
  });

  it("labels the campaign default and emits validated inline selections, including its null reset", () => {
    const { document, window, onChange, control } = fixture();
    const select = document.querySelector<HTMLElement>("[data-turn-length-select]");
    if (!select) throw new Error("Turn length selector is missing.");

    expect([...select.querySelectorAll("wa-option")].map((option) => [option.getAttribute("value"), option.textContent]))
      .toEqual([["", "Campaign default — Standard"], ["brief", "Brief"], ["standard", "Standard"], ["long", "Long"], ["extended", "Extended"]]);

    setValue(select, "extended", window.Event);
    setValue(select, "", window.Event);
    setValue(select, "invalid", window.Event);

    expect(onChange).toHaveBeenNthCalledWith(1, "extended");
    expect(onChange).toHaveBeenNthCalledWith(2, null);
    expect(onChange).toHaveBeenCalledTimes(2);
    control.dispose();
  });

  it("stages detail changes until Apply, leaves Cancel silent, and returns focus to its opener", () => {
    const { document, window, onChange, control } = fixture();
    const details = document.querySelector<HTMLElement>("[data-turn-length-details]");
    const dialog = document.querySelector<HTMLDialogElement>("dialog");
    const staged = document.querySelector<HTMLElement>("[data-turn-length-staged]");
    const cancel = document.querySelector<HTMLElement>("[data-turn-length-cancel]");
    const apply = document.querySelector<HTMLElement>("[data-turn-length-apply]");
    if (!details || !dialog || !staged || !cancel || !apply) throw new Error("Turn length detail controls are missing.");
    installNativeDialogStubs(dialog, window.Event);
    const focus = vi.spyOn(details, "focus");

    details.dispatchEvent(new window.Event("click", { bubbles: true }));
    setValue(staged, "long", window.Event);
    cancel.dispatchEvent(new window.Event("click", { bubbles: true }));
    expect(onChange).not.toHaveBeenCalled();

    details.dispatchEvent(new window.Event("click", { bubbles: true }));
    setValue(staged, "extended", window.Event);
    apply.dispatchEvent(new window.Event("click", { bubbles: true }));

    expect(onChange).toHaveBeenCalledExactlyOnceWith("extended");
    expect(dialog.hasAttribute("open")).toBe(false);
    expect(focus).toHaveBeenCalledTimes(2);
    control.dispose();
  });

  it("keeps an open dialog's staged value through a routine parent update until Apply", () => {
    const { document, window, onChange, control } = fixture();
    const details = document.querySelector<HTMLElement>("[data-turn-length-details]");
    const dialog = document.querySelector<HTMLDialogElement>("dialog");
    const staged = document.querySelector<HTMLElement>("[data-turn-length-staged]");
    const apply = document.querySelector<HTMLElement>("[data-turn-length-apply]");
    if (!details || !dialog || !staged || !apply) throw new Error("Turn length detail controls are missing.");
    installNativeDialogStubs(dialog, window.Event);

    details.dispatchEvent(new window.Event("click", { bubbles: true }));
    setValue(staged, "long", window.Event);
    control.update({ campaignDefault: "standard", override: null, disabled: false });
    apply.dispatchEvent(new window.Event("click", { bubbles: true }));

    expect(onChange).toHaveBeenCalledExactlyOnceWith("long");
    control.dispose();
  });

  it("honors disabled state and parent-controlled resets after attachment", () => {
    const { document, window, onChange, control } = fixture();
    const select = document.querySelector<HTMLElement>("[data-turn-length-select]");
    const details = document.querySelector<HTMLElement>("[data-turn-length-details]");
    if (!select || !details) throw new Error("Turn length controls are missing.");

    control.update({ campaignDefault: "long", override: "brief", disabled: false });
    expect((select as unknown as { value: string }).value).toBe("brief");
    control.update({ campaignDefault: "long", override: null, disabled: false });
    expect((select as unknown as { value: string }).value).toBe("");

    control.update({ campaignDefault: "long", override: null, disabled: true });
    setValue(select, "extended", window.Event);
    details.dispatchEvent(new window.Event("click", { bubbles: true }));
    expect(onChange).not.toHaveBeenCalled();
    expect(details.hasAttribute("disabled")).toBe(true);
    control.dispose();
  });
});
