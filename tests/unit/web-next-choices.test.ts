import { parseHTML } from "linkedom";
import { describe, expect, it, vi } from "vitest";
import { mountChoices } from "../../apps/web-next/src/story/ui/choices.js";

function fixture() {
  const { document, window } = parseHTML("<body></body>");
  const choose = vi.fn();
  const control = mountChoices(document, choose);
  document.body.append(control.element);
  return { document, window, choose, control };
}

function installNativeDialogStubs(dialog: HTMLDialogElement, Event: typeof globalThis.Event) {
  Object.defineProperties(dialog, {
    showModal: { configurable: true, value: function (this: HTMLDialogElement) { this.setAttribute("open", ""); } },
    close: { configurable: true, value: function (this: HTMLDialogElement) { this.removeAttribute("open"); this.dispatchEvent(new Event("close")); } }
  });
}

describe("indexed Story choices", () => {
  it("does not collapse choices with duplicate text", () => {
    const { document, window, choose, control } = fixture();
    control.update({ choices: ["Open the door", "Open the door"], selected: [0], disabled: false });

    const buttons = control.element.querySelectorAll<HTMLElement>("[data-inline-choice]");
    expect(buttons).toHaveLength(2);
    buttons[1]!.dispatchEvent(new window.Event("click", { bubbles: true }));
    expect(choose).toHaveBeenCalledExactlyOnceWith(1);
    control.dispose();
  });

  it("hides both choice presentations for an empty collection", () => {
    const { document, control } = fixture();
    control.update({ choices: [], selected: [], disabled: false });

    expect(control.element.querySelector("[data-inline-choice]")).toBeNull();
    expect(control.element.hidden).toBe(true);
    expect(document.querySelector<HTMLElement>("[data-expand-choices]")?.hasAttribute("disabled")).toBe(true);
    control.dispose();
  });

  it("closes expanded actions before hiding an empty collection", () => {
    const { window, control } = fixture();
    control.update({ choices: ["Scout ahead"], selected: [], disabled: false });
    const expand = control.element.querySelector<HTMLElement>("[data-expand-choices]");
    const dialog = control.element.querySelector<HTMLDialogElement>("dialog");
    if (!expand || !dialog) throw new Error("Expanded choices controls are missing.");
    installNativeDialogStubs(dialog, window.Event);

    expand.dispatchEvent(new window.Event("click", { bubbles: true }));
    control.update({ choices: [], selected: [], disabled: false });

    expect(dialog.hasAttribute("open")).toBe(false);
    expect(control.element.hidden).toBe(true);
    control.dispose();
  });

  it("retains indexed buttons while projection state changes for the same collection", () => {
    const { control } = fixture();
    control.update({ choices: ["Scout ahead", "Hold position"], selected: [], disabled: false });
    const inline = control.element.querySelectorAll<HTMLElement>("[data-inline-choice]");
    const expanded = control.element.querySelectorAll<HTMLElement>("[data-dialog-choice]");

    control.update({ choices: ["Scout ahead", "Hold position"], selected: [1], disabled: true });

    const nextInline = control.element.querySelectorAll<HTMLElement>("[data-inline-choice]");
    const nextExpanded = control.element.querySelectorAll<HTMLElement>("[data-dialog-choice]");
    expect(nextInline[0]).toBe(inline[0]);
    expect(nextExpanded[1]).toBe(expanded[1]);
    expect(nextInline[1]?.getAttribute("aria-pressed")).toBe("true");
    expect((nextExpanded[0] as unknown as { disabled: boolean }).disabled).toBe(true);
    control.dispose();
  });

  it("keeps long unsafe choices as text and suppresses disabled selection", () => {
    const { document, window, choose, control } = fixture();
    const unsafe = '<img src=x onerror="alert(1)"> ' + "A long direction ".repeat(30);
    control.update({ choices: [unsafe, "Wait"], selected: [1], disabled: true });

    const buttons = control.element.querySelectorAll<HTMLElement>("[data-inline-choice]");
    expect(buttons).toHaveLength(2);
    expect(buttons[0]?.textContent).toBe(unsafe);
    expect(buttons[0]?.querySelector("img")).toBeNull();
    expect(buttons[1]?.getAttribute("aria-pressed")).toBe("true");
    expect((buttons[0] as unknown as { disabled: boolean }).disabled).toBe(true);
    expect(document.querySelector("[data-expand-choices]")?.hasAttribute("disabled")).toBe(true);
    buttons[0]?.dispatchEvent(new window.Event("click", { bubbles: true }));
    expect(choose).not.toHaveBeenCalled();
    control.dispose();
  });

  it("uses the same indexed callback from expanded actions, closes, and restores focus", () => {
    const { document, window, choose, control } = fixture();
    control.update({ choices: ["Scout ahead", "Hold position", "Return to camp"], selected: [2], disabled: false });
    const expand = control.element.querySelector<HTMLElement>("[data-expand-choices]");
    const dialog = control.element.querySelector<HTMLDialogElement>("dialog");
    if (!expand || !dialog) throw new Error("Expanded choices controls are missing.");
    installNativeDialogStubs(dialog, window.Event);
    const focus = vi.spyOn(expand, "focus");

    expand.dispatchEvent(new window.Event("click", { bubbles: true }));
    const expanded = dialog.querySelectorAll<HTMLElement>("[data-dialog-choice]");
    expect(expanded).toHaveLength(3);
    expect(expanded[2]?.getAttribute("aria-pressed")).toBe("true");
    expanded[1]!.dispatchEvent(new window.Event("click", { bubbles: true }));

    expect(choose).toHaveBeenCalledExactlyOnceWith(1);
    expect(dialog.hasAttribute("open")).toBe(false);
    expect(focus).toHaveBeenCalledOnce();
    control.dispose();
  });

  it("leaves callback-only selection untouched when expanded actions are closed", () => {
    const { window, choose, control } = fixture();
    control.update({ choices: ["Scout ahead"], selected: [], disabled: false });
    const expand = control.element.querySelector<HTMLElement>("[data-expand-choices]");
    const dialog = control.element.querySelector<HTMLDialogElement>("dialog");
    if (!expand || !dialog) throw new Error("Expanded choices controls are missing.");
    installNativeDialogStubs(dialog, window.Event);

    expand.dispatchEvent(new window.Event("click", { bubbles: true }));
    dialog.querySelector<HTMLButtonElement>(".app-dialog__close")?.dispatchEvent(new window.Event("click", { bubbles: true }));

    expect(dialog.hasAttribute("open")).toBe(false);
    expect(choose).not.toHaveBeenCalled();
    control.dispose();
  });

  it("does not retain stale buttons, duplicate listeners, or a dialog after disposal", () => {
    const { document, window, choose, control } = fixture();
    control.update({ choices: ["First", "Second", "Third"], selected: [], disabled: false });
    const first = control.element.querySelectorAll<HTMLElement>("[data-inline-choice]")[1]!;
    control.update({ choices: ["Replacement"], selected: [], disabled: false });
    const current = control.element.querySelector<HTMLElement>("[data-inline-choice]");
    expect(control.element.querySelectorAll("[data-inline-choice]")).toHaveLength(1);

    first.dispatchEvent(new window.Event("click", { bubbles: true }));
    current?.dispatchEvent(new window.Event("click", { bubbles: true }));
    expect(choose).toHaveBeenCalledExactlyOnceWith(0);
    control.dispose();
    expect(document.querySelector("dialog")).toBeNull();
    current?.dispatchEvent(new window.Event("click", { bubbles: true }));
    expect(choose).toHaveBeenCalledExactlyOnceWith(0);
  });
});
