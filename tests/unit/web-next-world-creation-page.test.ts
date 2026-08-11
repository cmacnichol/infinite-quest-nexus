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

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function chooseMethod(document: Document, window: Window, method: "manual" | "ai"): void {
  const control = document.querySelector<HTMLInputElement>(`[name="creationMethod"][value="${method}"]`);
  if (!control) throw new Error(`The ${method} creation method is missing.`);
  control.checked = true;
  control.dispatchEvent(new window.Event("change", { bubbles: true }));
}

function enterConcept(document: Document, window: Window, concept: string): void {
  const prompt = document.querySelector<HTMLTextAreaElement>('[data-concept-prompt="compact"]');
  if (!prompt) throw new Error("The concept prompt is missing.");
  prompt.value = concept;
  prompt.dispatchEvent(new window.Event("input", { bubbles: true }));
}

function inputValue(document: Document, window: Window, selector: string, value: string): void {
  const control = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector);
  if (!control) throw new Error(`The input ${selector} is missing.`);
  control.value = value;
  control.dispatchEvent(new window.Event("input", { bubbles: true }));
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
    expect(methods.every((method) => !method.hasAttribute("data-control-size"))).toBe(true);
  });

  it("shows AI prompt authoring only for AI and lets Manual continue to Foundation without generation", () => {
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
    const continueManual = document.querySelector<HTMLButtonElement>('[data-action="continue-manual"]');
    expect(continueManual?.disabled).toBe(false);

    continueManual?.click();

    expect(document.querySelector('[data-creation-stage="foundation"]')).not.toBeNull();
    expect(document.querySelector<HTMLElement>('[data-foundation-stage]')?.hidden).toBe(false);
    expect(document.querySelector('[data-foundation-stage] h2')?.textContent).toBe("Foundation");
    expect(document.querySelector('[data-stage="foundation"]')?.getAttribute("aria-current")).toBe("step");
    expect(document.querySelector('[data-stage="foundation"]')?.hasAttribute("aria-disabled")).toBe(false);
    expect(document.querySelector('[data-stage="method"]')?.hasAttribute("aria-current")).toBe(false);
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
    const backgroundControl = document.querySelector<HTMLButtonElement>(".theme-toggle");
    if (!lastDialogControl || !backgroundControl) throw new Error("Dialog focus fixture incomplete.");
    backgroundControl.focus();
    backgroundControl.dispatchEvent(keyboardEvent(window as unknown as Window, "Tab"));
    expect(document.activeElement).toBe(close);
    backgroundControl.focus();
    backgroundControl.dispatchEvent(keyboardEvent(window as unknown as Window, "Tab", true));
    expect(document.activeElement).toBe(lastDialogControl);

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

  it("does not steal focus after delayed successful clipboard work when focus moved elsewhere", async () => {
    const { document, root, window } = creationFixture();
    const pendingCopy = deferred<void>();
    const pendingPaste = deferred<string>();
    mountWorldCreationPage(root, {
      generateWorldPreview: vi.fn().mockResolvedValue(generatedPreview),
      writeClipboardText: () => pendingCopy.promise,
      readClipboardText: () => pendingPaste.promise
    });
    const compact = document.querySelector<HTMLTextAreaElement>('[data-concept-prompt="compact"]');
    const backgroundControl = document.querySelector<HTMLButtonElement>(".theme-toggle");
    if (!compact || !backgroundControl) throw new Error("Clipboard focus fixture incomplete.");
    compact.value = "A glass city";
    compact.dispatchEvent(new window.Event("input", { bubbles: true }));
    compact.focus();

    document.querySelector<HTMLButtonElement>('[data-action="copy-prompt"]')?.click();
    backgroundControl.focus();
    pendingCopy.resolve();
    await settle();
    expect(document.activeElement).toBe(backgroundControl);

    compact.focus();
    compact.selectionStart = 2;
    compact.selectionEnd = 7;
    document.querySelector<HTMLButtonElement>('[data-action="paste-prompt"]')?.click();
    backgroundControl.focus();
    pendingPaste.resolve("bright");
    await settle();
    expect(compact.value).toBe("A bright city");
    expect(document.activeElement).toBe(backgroundControl);
  });

  it("does not steal focus after delayed failed clipboard work when focus moved elsewhere", async () => {
    const { document, root } = creationFixture();
    const pendingCopy = deferred<void>();
    const pendingPaste = deferred<string>();
    mountWorldCreationPage(root, {
      generateWorldPreview: vi.fn().mockResolvedValue(generatedPreview),
      writeClipboardText: () => pendingCopy.promise,
      readClipboardText: () => pendingPaste.promise
    });
    const compact = document.querySelector<HTMLTextAreaElement>('[data-concept-prompt="compact"]');
    const backgroundControl = document.querySelector<HTMLButtonElement>(".theme-toggle");
    if (!compact || !backgroundControl) throw new Error("Clipboard focus fixture incomplete.");
    compact.focus();

    document.querySelector<HTMLButtonElement>('[data-action="copy-prompt"]')?.click();
    backgroundControl.focus();
    pendingCopy.reject(new Error("denied"));
    await settle();
    expect(document.activeElement).toBe(backgroundControl);

    compact.focus();
    document.querySelector<HTMLButtonElement>('[data-action="paste-prompt"]')?.click();
    backgroundControl.focus();
    pendingPaste.reject(new Error("denied"));
    await settle();
    expect(document.activeElement).toBe(backgroundControl);
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

describe("World Creation generation and convergent editing", () => {
  it("polls semantic progress with unique keys, cancels, and ignores stale completion", async () => {
    vi.useFakeTimers();
    try {
      const { document, root, window } = creationFixture();
      const first = deferred<typeof generatedPreview>();
      const second = deferred<typeof generatedPreview>();
      const generateWorldPreview = vi.fn().mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);
      const loadWorldGenerationProgress = vi.fn().mockResolvedValue({
        status: "processing", phase: "world_structure", progressPercent: 42, message: "Organizing canon"
      });
      mountWorldCreationPage(root, { generateWorldPreview, loadWorldGenerationProgress, generationPollIntervalMs: 100 });
      chooseMethod(document, window as unknown as Window, "ai");
      enterConcept(document, window as unknown as Window, "A glass city");

      document.querySelector<HTMLButtonElement>('[data-action="generate-world"]')?.click();
      await vi.advanceTimersByTimeAsync(100);
      const firstKey = generateWorldPreview.mock.calls[0]?.[0].progressKey;
      expect(loadWorldGenerationProgress).toHaveBeenCalledWith(firstKey, expect.any(AbortSignal));
      expect(document.querySelector<HTMLProgressElement>("[data-generation-progress]")?.value).toBe(42);
      expect(document.querySelector("[data-generation-status]")?.textContent).toContain("Organizing canon");

      document.querySelector<HTMLButtonElement>('[data-action="cancel-generation"]')?.click();
      expect((generateWorldPreview.mock.calls[0]?.[1] as AbortSignal).aborted).toBe(true);
      document.querySelector<HTMLButtonElement>('[data-action="generate-world"]')?.click();
      expect(generateWorldPreview.mock.calls[1]?.[0].progressKey).not.toBe(firstKey);
      first.resolve({ ...generatedPreview, title: "Stale Atlas" });
      await Promise.resolve();
      expect(document.querySelector('[data-creation-stage="method"]')).not.toBeNull();

      second.resolve({
        ...generatedPreview,
        content: { ...generatedPreview.content, playableCharacters: [{ name: "Generated Character" }] }
      });
      await Promise.resolve();
      await Promise.resolve();
      expect(document.querySelector('[data-creation-stage="foundation"]')).not.toBeNull();
      expect(document.querySelector<HTMLInputElement>('[name="world.title"]')?.value).toBe("Glass Atlas");
      expect(document.body.textContent).not.toContain("Generated Character");
      expect(document.querySelector("[data-generation-status]")?.textContent).toContain("review every field");
    } finally {
      vi.useRealTimers();
    }
  });

  it("recovers from malformed output and provider failure while preserving concept and local fields", async () => {
    const { document, root, window } = creationFixture();
    const confirmGeneratedReplacement = vi.fn().mockReturnValueOnce(false).mockReturnValue(true);
    const generateWorldPreview = vi.fn()
      .mockResolvedValueOnce({ title: "Broken", content: { schemaVersion: 5 } })
      .mockRejectedValueOnce(new WorldCreationApiError("unavailable", "offline", 503))
      .mockResolvedValueOnce(generatedPreview);
    mountWorldCreationPage(root, {
      generateWorldPreview: generateWorldPreview as never,
      loadWorldGenerationProgress: vi.fn(),
      confirmGeneratedReplacement
    });
    chooseMethod(document, window as unknown as Window, "ai");
    enterConcept(document, window as unknown as Window, "A glass city");
    document.querySelector<HTMLButtonElement>('[data-action="generate-world"]')?.click();
    await settle();
    expect(document.querySelector("[data-generation-status]")?.textContent).toContain("could not be generated");
    expect(document.querySelector<HTMLTextAreaElement>('[data-concept-prompt="compact"]')?.value).toBe("A glass city");
    document.querySelector<HTMLButtonElement>('[data-action="generate-world"]')?.click();
    await settle();
    expect(document.querySelector("[data-generation-status]")?.textContent).toContain("unavailable");

    chooseMethod(document, window as unknown as Window, "manual");
    document.querySelector<HTMLButtonElement>('[data-action="continue-manual"]')?.click();
    inputValue(document, window as unknown as Window, '[name="world.title"]', "Local Atlas");
    document.querySelector<HTMLButtonElement>('[data-action="back-stage"]')?.click();
    chooseMethod(document, window as unknown as Window, "ai");
    enterConcept(document, window as unknown as Window, "Replace it");
    document.querySelector<HTMLButtonElement>('[data-action="generate-world"]')?.click();
    expect(generateWorldPreview).toHaveBeenCalledTimes(2);
    expect(confirmGeneratedReplacement).toHaveBeenCalledTimes(1);
    document.querySelector<HTMLButtonElement>('[data-action="generate-world"]')?.click();
    await settle();
    expect(document.querySelector<HTMLInputElement>('[name="world.title"]')?.value).toBe("Glass Atlas");
  });

  it("validates and preserves the shared Foundation path without authoritative requests", () => {
    const { document, root, window } = creationFixture();
    const generateWorldPreview = vi.fn();
    const loadWorldGenerationProgress = vi.fn();
    mountWorldCreationPage(root, { generateWorldPreview, loadWorldGenerationProgress });
    chooseMethod(document, window as unknown as Window, "manual");
    document.querySelector<HTMLButtonElement>('[data-action="continue-manual"]')?.click();
    document.querySelector<HTMLButtonElement>('[data-action="continue-stage"]')?.click();
    const title = document.querySelector<HTMLInputElement>('[name="world.title"]');
    expect(title?.getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(title);
    expect(document.querySelector('[data-field-error="world.title"]')?.textContent).toContain("required");

    inputValue(document, window as unknown as Window, '[name="world.title"]', "Local Atlas");
    inputValue(document, window as unknown as Window, '[name="world.genre"]', "Solar fantasy");
    document.querySelector<HTMLButtonElement>('[data-action="continue-stage"]')?.click();
    expect(document.querySelector('[data-stage="foundation"]')?.dataset.stageState).toBe("completed");
    expect(document.querySelector('[data-stage="canon"]')?.dataset.stageState).toBe("current");
    document.querySelector<HTMLButtonElement>('[data-action="back-stage"]')?.click();
    expect(document.querySelector<HTMLInputElement>('[name="world.title"]')?.value).toBe("Local Atlas");
    expect(document.querySelector<HTMLInputElement>('[name="world.genre"]')?.value).toBe("Solar fantasy");
    expect(generateWorldPreview).not.toHaveBeenCalled();
    expect(loadWorldGenerationProgress).not.toHaveBeenCalled();
  });

  it("keeps Canon detail mounted while filtering, caps rows, edits aliases, and undoes removal", () => {
    const { document, root, window } = creationFixture();
    mountWorldCreationPage(root, { generateWorldPreview: vi.fn() });
    chooseMethod(document, window as unknown as Window, "manual");
    document.querySelector<HTMLButtonElement>('[data-action="continue-manual"]')?.click();
    inputValue(document, window as unknown as Window, '[name="world.title"]', "Atlas");
    document.querySelector<HTMLButtonElement>('[data-action="continue-stage"]')?.click();
    for (let index = 0; index < 105; index += 1) {
      document.querySelector<HTMLButtonElement>('[data-action="add-item"]')?.click();
      inputValue(document, window as unknown as Window, '[data-structured-field="name"]', `Entity ${index}`);
    }
    expect(document.querySelectorAll("[data-collection-row]")).toHaveLength(100);
    const detail = document.querySelector("[data-record-detail]");
    inputValue(document, window as unknown as Window, "[data-collection-search]", "no match");
    expect(document.querySelector("[data-record-detail]")).toBe(detail);
    inputValue(document, window as unknown as Window, "[data-collection-search]", "Entity 104");
    document.querySelector<HTMLButtonElement>("[data-collection-row] button")?.click();
    document.querySelector<HTMLButtonElement>('[data-action="remove-item"]')?.click();
    expect(document.querySelector("[data-pending-removals]")?.textContent).toContain("Entity 104");
    document.querySelector<HTMLButtonElement>('[data-action="undo-removal"]')?.click();
    expect(document.querySelector("[data-pending-removals]")?.textContent).not.toContain("Entity 104");
    document.querySelector<HTMLButtonElement>('[data-collection-target="relationships"]')?.click();
    expect(document.querySelector('[data-collection-editor]')?.getAttribute("data-active-collection")).toBe("relationships");
  });

  it("edits all Mechanics collections, defaults, and advanced unknown properties without characters", () => {
    const { document, root, window } = creationFixture();
    const generateWorldPreview = vi.fn();
    mountWorldCreationPage(root, { generateWorldPreview });
    chooseMethod(document, window as unknown as Window, "manual");
    document.querySelector<HTMLButtonElement>('[data-action="continue-manual"]')?.click();
    inputValue(document, window as unknown as Window, '[name="world.title"]', "Atlas");
    document.querySelector<HTMLButtonElement>('[data-action="continue-stage"]')?.click();
    document.querySelector<HTMLButtonElement>('[data-action="continue-stage"]')?.click();
    document.querySelector<HTMLButtonElement>('[data-action="add-item"]')?.click();
    inputValue(document, window as unknown as Window, '[data-structured-field="name"]', "Resolve");
    const advanced = document.querySelector<HTMLTextAreaElement>("[data-advanced-json]");
    if (!advanced) throw new Error("Advanced JSON editor missing.");
    advanced.value = '{"name":"Resolve","value":3,"unknownRule":"keep"}';
    advanced.dispatchEvent(new window.Event("input", { bubbles: true }));
    document.querySelector<HTMLButtonElement>('[data-action="apply-advanced-json"]')?.click();
    expect(document.querySelector<HTMLTextAreaElement>("[data-advanced-json]")?.value).toContain("unknownRule");
    for (const collection of ["defaultTriggers", "eventTriggers"]) {
      document.querySelector<HTMLButtonElement>(`[data-collection-target="${collection}"]`)?.click();
      document.querySelector<HTMLButtonElement>('[data-action="add-item"]')?.click();
    }
    const defaults = document.querySelector<HTMLTextAreaElement>("[data-defaults-json]");
    if (!defaults) throw new Error("Defaults JSON editor missing.");
    defaults.value = '{"difficulty":"heroic"}';
    defaults.dispatchEvent(new window.Event("input", { bubbles: true }));
    document.querySelector<HTMLButtonElement>('[data-action="apply-defaults-json"]')?.click();
    expect(document.querySelector<HTMLTextAreaElement>("[data-defaults-json]")?.value).toContain("heroic");
    expect(document.querySelector('[data-stage="characters"], [data-collection-target="playableCharacters"]')).toBeNull();
    expect(generateWorldPreview).not.toHaveBeenCalled();
  });
});
