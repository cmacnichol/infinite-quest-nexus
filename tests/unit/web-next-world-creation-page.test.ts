import { parseHTML } from "linkedom";
import { describe, expect, it, vi } from "vitest";
import { WorldCreationApiError } from "../../apps/web-next/src/world-creation-api.js";
import { mountWorldCreationPage } from "../../apps/web-next/src/world-creation-page.js";

const generatedPreview = {
  title: "Glass Atlas",
  content: {
    schemaVersion: 5,
    world: {
      title: "Glass Atlas",
      genre: "Science fantasy",
      tone: "Numinous",
      premise: "A glass city follows a migrating star.",
      backgroundStory: "The city remembers every prior orbit.",
      firstAction: "Open the observatory.",
      rules: "Reflections retain promises."
    },
    playableCharacters: [],
    entities: [],
    relationships: [],
    rpgStats: [],
    defaultTriggers: [],
    eventTriggers: [],
    assets: [],
    defaults: {}
  }
};

function creationFixture() {
  const { document, window } = parseHTML('<html><body><div id="app"></div></body></html>');
  const root = document.querySelector<HTMLElement>("#app");
  if (!root) throw new Error("Creation fixture is missing.");
  window.HTMLElement.prototype.focus = function focus() {
    Object.defineProperty(document, "activeElement", { configurable: true, value: this });
  };
  return { document, root, window };
}

function keyboardEvent(window: Window, key: string, shiftKey = false): Event {
  const event = new window.Event("keydown", { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    key: { value: key },
    shiftKey: { value: shiftKey }
  });
  return event;
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("World Creation Method stage", () => {
  it("renders the shared shell, theme control, stage context, and two compact radio controls", () => {
    const { document, root } = creationFixture();

    mountWorldCreationPage(root, { generateWorldPreview: vi.fn().mockResolvedValue(generatedPreview) });

    expect(document.querySelector('[data-page="world-creation"]')).not.toBeNull();
    expect(document.querySelector('a[href="/app/"]')?.textContent).toContain("World Library");
    expect(document.querySelector(".theme-toggle")).not.toBeNull();
    expect(document.querySelector('[data-creation-stage="method"]')).not.toBeNull();
    const methods = [...document.querySelectorAll<HTMLElement>(".creation-method-control")];
    expect(methods).toHaveLength(2);
    expect(methods.every((method) => method.querySelector('input[type="radio"][name="creationMethod"]'))).toBe(true);
    expect(methods.every((method) => !method.matches("article, .card") && !method.querySelector("p"))).toBe(true);
    expect(methods.map((method) => method.getAttribute("data-control-size"))).toEqual(["48", "48"]);
  });

  it("shows AI prompt authoring only for AI and lets Manual continue without generation", () => {
    const { document, root, window } = creationFixture();
    const generateWorldPreview = vi.fn().mockResolvedValue(generatedPreview);
    mountWorldCreationPage(root, { generateWorldPreview });

    const ai = document.querySelector<HTMLInputElement>('[name="creationMethod"][value="ai"]');
    const manual = document.querySelector<HTMLInputElement>('[name="creationMethod"][value="manual"]');
    if (!ai || !manual) throw new Error("Method controls missing.");
    expect(document.querySelector('[data-ai-prompt]')?.hasAttribute("hidden")).toBe(true);

    ai.checked = true;
    ai.dispatchEvent(new window.Event("change", { bubbles: true }));
    expect(document.querySelector('[data-ai-prompt]')?.hasAttribute("hidden")).toBe(false);
    expect(document.querySelector<HTMLButtonElement>('[data-action="generate-world"]')?.disabled).toBe(true);

    manual.checked = true;
    manual.dispatchEvent(new window.Event("change", { bubbles: true }));
    expect(document.querySelector('[data-ai-prompt]')?.hasAttribute("hidden")).toBe(true);
    expect(document.querySelector<HTMLButtonElement>('[data-action="continue-manual"]')?.disabled).toBe(false);
    expect(generateWorldPreview).not.toHaveBeenCalled();
  });

  it("keeps compact and expanded prompt editors synchronized without network calls from typing", () => {
    const { document, root, window } = creationFixture();
    const generateWorldPreview = vi.fn().mockResolvedValue(generatedPreview);
    mountWorldCreationPage(root, { generateWorldPreview });
    const ai = document.querySelector<HTMLInputElement>('[name="creationMethod"][value="ai"]');
    ai!.checked = true;
    ai!.dispatchEvent(new window.Event("change", { bubbles: true }));
    const compact = document.querySelector<HTMLTextAreaElement>('[data-concept-prompt="compact"]');
    if (!compact) throw new Error("Compact prompt missing.");

    compact.value = "A glass city follows a migrating star.";
    compact.dispatchEvent(new window.Event("input", { bubbles: true }));
    document.querySelector<HTMLButtonElement>('[data-action="expand-prompt"]')?.click();
    const expanded = document.querySelector<HTMLTextAreaElement>('[data-concept-prompt="expanded"]');
    if (!expanded) throw new Error("Expanded prompt missing.");
    expect(expanded.value).toBe(compact.value);

    expanded.value = "A glass city orbits a sleeping star.";
    expanded.dispatchEvent(new window.Event("input", { bubbles: true }));
    expect(compact.value).toBe(expanded.value);
    expect(document.querySelector<HTMLButtonElement>('[data-action="generate-world"]')?.disabled).toBe(false);
    expect(generateWorldPreview).not.toHaveBeenCalled();
  });

  it("uses authored SVG prompt controls with accessible names", () => {
    const { document, root } = creationFixture();
    mountWorldCreationPage(root, { generateWorldPreview: vi.fn().mockResolvedValue(generatedPreview) });

    for (const action of ["copy-prompt", "paste-prompt", "expand-prompt", "close-prompt-dialog"]) {
      const control = document.querySelector<HTMLButtonElement>(`[data-action="${action}"]`);
      expect(control, action).not.toBeNull();
      expect(control?.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
      expect(control?.getAttribute("aria-label") || control?.textContent?.trim()).toBeTruthy();
      expect(control?.textContent).not.toMatch(/[📋📄⛶✕]/u);
    }
  });

  it("traps dialog focus and closes on Escape while restoring focus to Expand", () => {
    const { document, root, window } = creationFixture();
    mountWorldCreationPage(root, { generateWorldPreview: vi.fn().mockResolvedValue(generatedPreview) });
    const expand = document.querySelector<HTMLButtonElement>('[data-action="expand-prompt"]');
    if (!expand) throw new Error("Expand action missing.");
    expand.focus();
    expand.click();
    const dialog = document.querySelector<HTMLElement>('[data-prompt-dialog]');
    const close = document.querySelector<HTMLButtonElement>('[data-action="close-prompt-dialog"]');
    const expanded = document.querySelector<HTMLTextAreaElement>('[data-concept-prompt="expanded"]');
    if (!dialog || !close || !expanded) throw new Error("Dialog fixture incomplete.");

    expect(dialog.getAttribute("role")).toBe("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.hasAttribute("open")).toBe(true);
    expect(dialog.contains(document.activeElement)).toBe(true);

    const lastDialogControl = dialog.querySelectorAll<HTMLButtonElement>("button").item(2);
    if (!lastDialogControl) throw new Error("Dialog paste action missing.");
    lastDialogControl.focus();
    lastDialogControl.dispatchEvent(keyboardEvent(window as unknown as Window, "Tab"));
    expect(document.activeElement).toBe(close);
    close.focus();
    close.dispatchEvent(keyboardEvent(window as unknown as Window, "Tab", true));
    expect(document.activeElement).toBe(lastDialogControl);

    dialog.dispatchEvent(keyboardEvent(window as unknown as Window, "Escape"));
    expect(dialog.hasAttribute("open")).toBe(false);
    expect(document.activeElement).toBe(expand);
  });

  it("copies the single prompt value, reports success or failure, and preserves typing focus", async () => {
    const { document, root, window } = creationFixture();
    const writeClipboardText = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("denied"));
    mountWorldCreationPage(root, {
      generateWorldPreview: vi.fn().mockResolvedValue(generatedPreview),
      writeClipboardText
    });
    const compact = document.querySelector<HTMLTextAreaElement>('[data-concept-prompt="compact"]');
    if (!compact) throw new Error("Compact prompt missing.");
    compact.value = "A city of glass.";
    compact.dispatchEvent(new window.Event("input", { bubbles: true }));
    compact.focus();

    document.querySelector<HTMLButtonElement>('[data-action="copy-prompt"]')?.click();
    await settle();
    expect(writeClipboardText).toHaveBeenLastCalledWith("A city of glass.");
    expect(document.querySelector('[data-clipboard-status]')?.textContent).toContain("Copied");
    expect(document.activeElement).toBe(compact);

    document.querySelector<HTMLButtonElement>('[data-action="copy-prompt"]')?.click();
    await settle();
    expect(document.querySelector('[data-clipboard-status]')?.textContent).toContain("could not copy");
    expect(document.activeElement).toBe(compact);
  });

  it("pastes at the current selection and recovers when clipboard permission is denied", async () => {
    const { document, root, window } = creationFixture();
    const readClipboardText = vi.fn().mockResolvedValueOnce("bright ").mockRejectedValueOnce(new Error("denied"));
    mountWorldCreationPage(root, {
      generateWorldPreview: vi.fn().mockResolvedValue(generatedPreview),
      readClipboardText
    });
    const compact = document.querySelector<HTMLTextAreaElement>('[data-concept-prompt="compact"]');
    if (!compact) throw new Error("Compact prompt missing.");
    compact.value = "A glass city";
    compact.selectionStart = 2;
    compact.selectionEnd = 8;
    compact.focus();

    document.querySelector<HTMLButtonElement>('[data-action="paste-prompt"]')?.click();
    await settle();
    expect(compact.value).toBe("A bright city");
    expect(compact.selectionStart).toBe(9);
    expect(document.activeElement).toBe(compact);
    expect(document.querySelector('[data-clipboard-status]')?.textContent).toContain("Pasted");

    document.querySelector<HTMLButtonElement>('[data-action="paste-prompt"]')?.click();
    await settle();
    expect(compact.value).toBe("A bright city");
    expect(document.querySelector('[data-clipboard-status]')?.textContent).toContain("permission");
    expect(document.activeElement).toBe(compact);
  });

  it("generates only on explicit action and offers Provider Setup recovery when unavailable", async () => {
    const { document, root, window } = creationFixture();
    const generateWorldPreview = vi.fn().mockRejectedValue(
      new WorldCreationApiError("unavailable", "Text provider unavailable.", 503)
    );
    mountWorldCreationPage(root, { generateWorldPreview });
    const ai = document.querySelector<HTMLInputElement>('[name="creationMethod"][value="ai"]');
    const compact = document.querySelector<HTMLTextAreaElement>('[data-concept-prompt="compact"]');
    if (!ai || !compact) throw new Error("AI authoring fixture incomplete.");
    ai.checked = true;
    ai.dispatchEvent(new window.Event("change", { bubbles: true }));
    compact.value = "A glass city";
    compact.dispatchEvent(new window.Event("input", { bubbles: true }));
    expect(generateWorldPreview).not.toHaveBeenCalled();

    document.querySelector<HTMLButtonElement>('[data-action="generate-world"]')?.click();
    await settle();

    expect(generateWorldPreview).toHaveBeenCalledTimes(1);
    expect(generateWorldPreview).toHaveBeenCalledWith(expect.objectContaining({
      title: "",
      prompt: "A glass city",
      progressKey: expect.stringMatching(/^world-gen:/)
    }), expect.any(AbortSignal));
    expect(document.querySelector('[data-generation-status]')?.textContent).toContain("unavailable");
    expect(document.querySelector<HTMLAnchorElement>('[data-generation-status] a[href="/nexus/?view=setup"]')?.textContent)
      .toContain("Provider Setup");
  });
});
