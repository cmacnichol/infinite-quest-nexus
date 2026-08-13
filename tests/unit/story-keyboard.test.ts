import { parseHTML } from "linkedom";
import { describe, expect, it, vi } from "vitest";
import { handleStoryEscape } from "../../apps/web/src/story-keyboard.js";

function keyboardFixture(markup = '<dialog id="first" open></dialog><dialog id="topmost" open></dialog>') {
  const { document, window } = parseHTML(`<body>${markup}</body>`);
  const requestModalDismissal = vi.fn();
  const closeNavigationMenus = vi.fn();
  document.addEventListener("keydown", (event) => {
    handleStoryEscape(event, { document, requestModalDismissal, closeNavigationMenus });
  });
  const dispatchKey = (key: string) => {
    const event = new window.Event("keydown", { bubbles: true });
    Object.defineProperty(event, "key", { value: key });
    document.dispatchEvent(event);
    return event;
  };
  return { closeNavigationMenus, dispatchKey, document, requestModalDismissal };
}

describe("Story Player keyboard dismissal", () => {
  it("leaves non-Escape keys to their local controls", () => {
    const { closeNavigationMenus, dispatchKey, requestModalDismissal } = keyboardFixture();

    dispatchKey("Enter");

    expect(requestModalDismissal).not.toHaveBeenCalled();
    expect(closeNavigationMenus).not.toHaveBeenCalled();
  });

  it("asks the managed dismissal path to close only the topmost dialog", () => {
    const { closeNavigationMenus, dispatchKey, document, requestModalDismissal } = keyboardFixture();

    const event = dispatchKey("Escape");

    expect(requestModalDismissal).toHaveBeenCalledTimes(1);
    expect(requestModalDismissal).toHaveBeenCalledWith(document.getElementById("topmost"));
    expect(closeNavigationMenus).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it("closes navigation menus when no dialog is open", () => {
    const { closeNavigationMenus, dispatchKey, requestModalDismissal } = keyboardFixture("");

    dispatchKey("Escape");

    expect(requestModalDismissal).not.toHaveBeenCalled();
    expect(closeNavigationMenus).toHaveBeenCalledTimes(1);
  });
});
