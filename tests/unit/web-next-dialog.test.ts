import { parseHTML } from "linkedom";
import { describe, expect, it, vi } from "vitest";
import { mountDialog } from "../../apps/web-next/src/ui/dialog.js";

function fixture() {
  const { document, Event } = parseHTML("<html><body></body></html>").window;
  return { document, Event };
}

function installNativeDialogStubs(dialog: HTMLDialogElement, Event: typeof globalThis.Event) {
  const showModal = vi.fn(function (this: HTMLDialogElement) {
    this.setAttribute("open", "");
  });
  const close = vi.fn(function (this: HTMLDialogElement) {
    this.removeAttribute("open");
    this.dispatchEvent(new Event("close"));
  });
  Object.defineProperties(dialog, {
    showModal: { configurable: true, value: showModal },
    close: { configurable: true, value: close }
  });
  return { showModal, close };
}

describe("mountDialog", () => {
  it("mounts a labelled native dialog with caller-owned body and footer slots", () => {
    const { document } = fixture();
    const dialog = mountDialog(document, { label: "Campaign Settings" });

    document.body.append(dialog.element);
    dialog.body.append(document.createElement("p"));
    dialog.footer.append(document.createElement("button"));

    const labelledBy = dialog.element.getAttribute("aria-labelledby");
    expect(dialog.element.localName).toBe("dialog");
    expect(labelledBy).toMatch(/^infinite-quest-dialog-title-\d+$/);
    expect(document.getElementById(labelledBy ?? "")?.textContent).toBe("Campaign Settings");
    expect(dialog.body.classList.contains("app-dialog__body")).toBe(true);
    expect(dialog.footer.classList.contains("app-dialog__footer")).toBe(true);
    expect(dialog.element.getAttribute("aria-modal")).toBe("true");
    expect(dialog.element.querySelector("button")?.textContent).toBe("Close");
  });

  it("uses native modal methods and restores a connected opener after a native close event", () => {
    const { document, Event } = fixture();
    const opener = document.createElement("button");
    const focus = vi.fn();
    Object.defineProperty(opener, "focus", { configurable: true, value: focus });
    document.body.append(opener);
    const onClose = vi.fn();
    const dialog = mountDialog(document, { label: "Campaign Settings", onClose });
    document.body.append(dialog.element);
    const native = installNativeDialogStubs(dialog.element, Event);

    dialog.open(opener);
    dialog.open();
    expect(native.showModal).toHaveBeenCalledTimes(1);
    expect(dialog.element.hasAttribute("open")).toBe(true);

    dialog.close();
    expect(native.close).toHaveBeenCalledTimes(1);
    expect(dialog.element.hasAttribute("open")).toBe(false);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it("restores the opener before onClose can direct focus to a follow-up surface", () => {
    const { document, Event } = fixture();
    const opener = document.createElement("button");
    const followUp = document.createElement("button");
    const focusOrder: string[] = [];
    Object.defineProperty(opener, "focus", { configurable: true, value: () => focusOrder.push("opener") });
    Object.defineProperty(followUp, "focus", { configurable: true, value: () => focusOrder.push("follow-up") });
    document.body.append(opener, followUp);
    const dialog = mountDialog(document, {
      label: "Campaign Settings",
      onClose: () => followUp.focus()
    });
    document.body.append(dialog.element);
    installNativeDialogStubs(dialog.element, Event);

    dialog.open(opener);
    dialog.close();

    expect(focusOrder).toEqual(["opener", "follow-up"]);
  });

  it("closes through its explicit control and safely ignores repeated closure and disposal", () => {
    const { document, Event } = fixture();
    const dialog = mountDialog(document, { label: "Campaign Settings" });
    document.body.append(dialog.element);
    const native = installNativeDialogStubs(dialog.element, Event);

    dialog.open();
    const closeButton = dialog.element.querySelector<HTMLButtonElement>("button");
    closeButton?.dispatchEvent(new Event("click"));
    dialog.close();
    dialog.dispose();
    dialog.dispose();
    dialog.open();

    expect(native.close).toHaveBeenCalledTimes(1);
    expect(native.showModal).toHaveBeenCalledTimes(1);
    expect(dialog.element.isConnected).toBe(false);
  });
});
