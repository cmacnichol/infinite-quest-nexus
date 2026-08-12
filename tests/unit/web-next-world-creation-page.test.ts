import { parseHTML } from "linkedom";
import { describe, expect, it, vi } from "vitest";
import { WorldCreationApiError } from "../../apps/web-next/src/world-creation-api.js";
import {
  createWorldCreationState,
  editCreationDraft,
  selectCreationMethod,
  setCreationCoverIntent,
  setCreationStage,
  type WorldCreationState
} from "../../apps/web-next/src/world-creation-model.js";
import { mountWorldCreationPage } from "../../apps/web-next/src/world-creation-page.js";

const createdWorld = {
  id: "22222222-2222-4222-8222-222222222222",
  title: "Glass Atlas",
  status: "draft" as const,
  imageUrl: "",
  draftRevision: 1,
  draftContent: {
    schemaVersion: 5,
    world: {
      title: "Glass Atlas",
      genre: "",
      tone: "",
      premise: "",
      backgroundStory: "",
      firstAction: "",
      rules: ""
    },
    playableCharacters: [],
    entities: [],
    relationships: [],
    rpgStats: [],
    defaultTriggers: [],
    eventTriggers: [],
    assets: [],
    defaults: {}
  },
  draftBasedOnWorldVersionId: null,
  createdAt: "2026-08-11T12:00:00.000Z",
  updatedAt: "2026-08-11T12:00:00.000Z"
};

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

function advanceManualWizardToCover(document: Document, window: Window): void {
  chooseMethod(document, window, "manual");
  document.querySelector<HTMLButtonElement>('[data-action="continue-manual"]')?.click();
  inputValue(document, window, '[name="world.title"]', "Glass Atlas");
  document.querySelector<HTMLButtonElement>('[data-action="continue-stage"]')?.click();
  document.querySelector<HTMLButtonElement>('[data-action="continue-stage"]')?.click();
  document.querySelector<HTMLButtonElement>('[data-action="continue-stage"]')?.click();
  expect(document.querySelector('[data-creation-stage="cover"]')).not.toBeNull();
}

function createdDestination(cover: "none" | "pending" | "completed" | "recovery"): string {
  return `/app/worlds/${encodeURIComponent(createdWorld.id)}?creation=created&cover=${cover}`;
}

function reviewedState(method: "manual" | "ai" = "manual"): WorldCreationState {
  let state = selectCreationMethod(createWorldCreationState(), method);
  state = editCreationDraft(state, ["world", "title"], "Glass Atlas");
  for (const stage of ["foundation", "canon", "mechanics", "cover", "review"] as const) {
    state = setCreationStage(state, stage);
  }
  return state;
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

  it("uses neutral prompt instruction without runtime illustrative world content", () => {
    const { document, root } = creationFixture();
    mountWorldCreationPage(root);

    const prompt = document.querySelector<HTMLTextAreaElement>('[data-concept-prompt="compact"]');
    expect(prompt?.placeholder).toBe("Describe your world concept");
    expect(root.textContent).not.toContain("A glass city follows a migrating star");
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

  it.each([
    ["pointer", "success"],
    ["pointer", "failure"],
    ["keyboard", "success"],
    ["keyboard", "failure"]
  ] as const)("never moves focus from the Copy button after %s %s", async (activation, outcome) => {
    const { document, root, window } = creationFixture();
    const pendingCopy = deferred<void>();
    mountWorldCreationPage(root, {
      writeClipboardText: () => pendingCopy.promise
    });
    chooseMethod(document, window as unknown as Window, "ai");
    enterConcept(document, window as unknown as Window, "Authored concept");
    const copy = document.querySelector<HTMLButtonElement>('[data-action="copy-prompt"]');
    if (!copy) throw new Error("Copy action missing.");
    copy.focus();
    if (activation === "keyboard") {
      copy.dispatchEvent(keyboardEvent(window as unknown as Window, "Enter"));
    }
    copy.click();

    if (outcome === "success") pendingCopy.resolve();
    else pendingCopy.reject(new Error("denied"));
    await settle();

    expect(document.activeElement).toBe(copy);
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

describe("World Creation Cover and Review stages", () => {
  it("defaults to no cover and validates only the selected retained or generated input", () => {
    const { document, root, window } = creationFixture();
    mountWorldCreationPage(root);
    advanceManualWizardToCover(document, window as unknown as Window);

    const none = document.querySelector<HTMLInputElement>('[name="coverMode"][value="none"]');
    expect(none?.checked).toBe(true);
    expect(document.querySelector('[data-cover-guidance]')?.textContent).toContain("optional");

    const retained = document.querySelector<HTMLInputElement>('[name="coverMode"][value="retained_asset"]');
    retained!.checked = true;
    retained!.dispatchEvent(new window.Event("change", { bubbles: true }));
    document.querySelector<HTMLButtonElement>('[data-action="continue-stage"]')?.click();
    const assetId = document.querySelector<HTMLInputElement>('[name="cover.assetId"]');
    expect(assetId?.getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(assetId);
    inputValue(document, window as unknown as Window, '[name="cover.assetId"]', "asset-1");

    const generated = document.querySelector<HTMLInputElement>('[name="coverMode"][value="generated"]');
    generated!.checked = true;
    generated!.dispatchEvent(new window.Event("change", { bubbles: true }));
    document.querySelector<HTMLButtonElement>('[data-action="continue-stage"]')?.click();
    const prompt = document.querySelector<HTMLTextAreaElement>('[name="cover.prompt"]');
    expect(prompt?.getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(prompt);
    expect(document.querySelector('[data-cover-provider-guidance]')?.textContent).toContain("world can still be created");
  });

  it.each(["manual", "ai"] as const)("edits %s assets in Cover while preserving generated and unknown properties", (method) => {
    const { document, root, window } = creationFixture();
    let state = reviewedState(method);
    state = setCreationStage(state, "cover");
    state = editCreationDraft(state, ["assets"], [{
      id: "generated-cover",
      filename: "cover.webp",
      generated: true,
      providerMetadata: { keep: "unknown" }
    }]);
    mountWorldCreationPage(root, { initialState: state });

    const assets = document.querySelector<HTMLTextAreaElement>("[data-assets-json]");
    if (!assets) throw new Error("Cover assets editor missing.");
    assets.value = JSON.stringify([
      {
        id: "generated-cover",
        filename: "renamed.webp",
        generated: true,
        providerMetadata: { keep: "unknown" }
      },
      { id: "authored-map", custom: "preserved" }
    ]);
    document.querySelector<HTMLButtonElement>('[data-action="apply-assets-json"]')?.click();
    document.querySelector<HTMLButtonElement>('[data-action="continue-stage"]')?.click();

    const serialized = JSON.parse(document.querySelector('[data-review-serialized]')?.textContent ?? "null");
    expect(serialized.assets).toEqual([
      {
        id: "generated-cover",
        filename: "renamed.webp",
        generated: true,
        providerMetadata: { keep: "unknown" }
      },
      { id: "authored-map", custom: "preserved" }
    ]);
    expect(document.querySelector('[data-review-count="assets"]')?.textContent).toBe("2");
    expect(window).toBeTruthy();
  });

  it.each(["pointer", "Enter", " "] as const)(
    "keeps pending invalid Cover assets JSON intact when %s activates the forward Review stage",
    (activation) => {
      const { document, root, window } = creationFixture();
      mountWorldCreationPage(root, { initialState: reviewedState() });
      document.querySelector<HTMLButtonElement>('[data-stage="cover"]')?.click();
      const assets = document.querySelector<HTMLTextAreaElement>("[data-assets-json]");
      const reviewStage = document.querySelector<HTMLButtonElement>('[data-stage="review"]');
      if (!assets || !reviewStage) throw new Error("Cover forward-navigation fixture incomplete.");
      const pendingText = '{\n  "unfinished": true';
      assets.value = pendingText;
      assets.dispatchEvent(new window.Event("input", { bubbles: true }));

      if (activation === "pointer") reviewStage.click();
      else reviewStage.dispatchEvent(keyboardEvent(window as unknown as Window, activation));

      const retainedAssets = document.querySelector<HTMLTextAreaElement>("[data-assets-json]");
      const error = document.querySelector<HTMLElement>("[data-assets-error]");
      expect(document.querySelector('[data-creation-stage="cover"]')).not.toBeNull();
      expect(retainedAssets?.value).toBe(pendingText);
      expect(retainedAssets?.getAttribute("aria-invalid")).toBe("true");
      expect(error?.textContent).toContain("valid JSON");
      expect(retainedAssets?.getAttribute("aria-describedby")?.split(/\s+/)).toContain(error?.id);
      expect(document.activeElement).toBe(retainedAssets);
    }
  );

  it("associates invalid Cover assets JSON with recovery copy without changing assets", () => {
    const { document, root } = creationFixture();
    let state = reviewedState();
    state = setCreationStage(state, "cover");
    state = editCreationDraft(state, ["assets"], [{ id: "keep" }]);
    mountWorldCreationPage(root, { initialState: state });
    const assets = document.querySelector<HTMLTextAreaElement>("[data-assets-json]");
    if (!assets) throw new Error("Cover assets editor missing.");
    assets.value = "{}";

    document.querySelector<HTMLButtonElement>('[data-action="apply-assets-json"]')?.click();

    expect(assets.getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(assets);
    expect(document.querySelector("[data-assets-error]")?.textContent).toContain("JSON array");
    document.querySelector<HTMLButtonElement>('[data-action="continue-stage"]')?.click();
    expect(document.querySelector('[data-creation-stage="cover"]')).not.toBeNull();
    expect(document.activeElement).toBe(assets);
  });

  it("reviews every stage readiness, total warnings, exact cover intent, factual counts, and provenance", () => {
    const { document, root, window } = creationFixture();
    mountWorldCreationPage(root);
    advanceManualWizardToCover(document, window as unknown as Window);
    document.querySelector<HTMLButtonElement>('[data-action="continue-stage"]')?.click();

    expect(document.querySelector('[data-creation-stage="review"]')).not.toBeNull();
    expect(document.querySelector('[data-review-provenance]')?.textContent).toContain("Manual");
    expect(document.querySelector('[data-review-readiness]')?.textContent).toContain("Ready");
    expect(document.querySelectorAll('[data-review-stage]')).toHaveLength(6);
    expect(document.querySelector('[data-review-stage="method"]')?.textContent).toContain("ready");
    expect(document.querySelector('[data-review-stage="review"]')?.textContent).toContain("ready");
    expect(document.querySelector('[data-review-warning-count]')?.textContent).toBe("Warnings 1");
    expect(document.querySelector('[data-review-cover-intent]')?.textContent).toBe("Cover intent: No cover");
    expect(document.querySelector('[data-review-warning]')?.textContent).toContain("No cover");
    expect(document.querySelector('[data-review-count="entities"]')?.textContent).toContain("0");
    expect(document.querySelector('[data-review-count="relationships"]')?.textContent).toContain("0");
    expect(document.querySelector('[data-review-count="stats"]')?.textContent).toContain("0");
    expect(document.querySelector('[data-review-count="triggers"]')?.textContent).toContain("0");
    expect(document.querySelector('[data-review-count="assets"]')?.textContent).toContain("0");
    expect(document.querySelector('[data-review-count="characters"]')?.textContent).toContain("0");
    const serialized = document.querySelector<HTMLElement>('[data-review-serialized]')?.textContent ?? "";
    expect(JSON.parse(serialized).playableCharacters).toEqual([]);
  });

  it("preserves every cover field when moving back from Review", () => {
    const { document, root, window } = creationFixture();
    mountWorldCreationPage(root);
    advanceManualWizardToCover(document, window as unknown as Window);
    const generated = document.querySelector<HTMLInputElement>('[name="coverMode"][value="generated"]');
    generated!.checked = true;
    generated!.dispatchEvent(new window.Event("change", { bubbles: true }));
    inputValue(document, window as unknown as Window, '[name="cover.prompt"]', "Moonlit glass towers");
    document.querySelector<HTMLButtonElement>('[data-action="continue-stage"]')?.click();
    expect(document.querySelector('[data-review-cover-intent]')?.textContent)
      .toBe("Cover intent: Generate cover — Moonlit glass towers");
    document.querySelector<HTMLButtonElement>('[data-action="back-stage"]')?.click();

    expect(document.querySelector<HTMLInputElement>('[name="coverMode"][value="generated"]')?.checked).toBe(true);
    expect(document.querySelector<HTMLTextAreaElement>('[name="cover.prompt"]')?.value).toBe("Moonlit glass towers");
  });

  it("keeps invalid Review creation actionable, makes no request, and focuses the complete error summary", () => {
    const { document, root } = creationFixture();
    let state = setCreationCoverIntent(reviewedState(), { mode: "generated", prompt: "" });
    state = editCreationDraft(state, ["world", "title"], "");
    const createWorld = vi.fn();
    mountWorldCreationPage(root, { initialState: state, createWorld });

    const create = document.querySelector<HTMLButtonElement>('[data-action="create-world"]');
    expect(create?.disabled).toBe(false);
    create?.click();

    const summary = document.querySelector<HTMLElement>("[data-review-errors]");
    expect(createWorld).not.toHaveBeenCalled();
    expect(summary?.querySelectorAll("a")).toHaveLength(2);
    expect(summary?.textContent).toContain("World title is required");
    expect(summary?.textContent).toContain("Describe the cover to generate");
    expect(document.activeElement).toBe(summary);
  });

  it.each([
    ["world.title", "foundation", '[name="world.title"]'],
    ["cover.prompt", "cover", '[name="cover.prompt"]']
  ])("moves Review issue %s to its exact %s control", (path, stage, selector) => {
    const { document, root } = creationFixture();
    let state = setCreationCoverIntent(reviewedState(), { mode: "generated", prompt: "" });
    state = editCreationDraft(state, ["world", "title"], "");
    mountWorldCreationPage(root, { initialState: state, createWorld: vi.fn() });

    document.querySelector<HTMLAnchorElement>(`[data-review-issue-path="${path}"]`)?.click();

    const control = document.querySelector<HTMLElement>(selector);
    expect(document.querySelector(`[data-creation-stage="${stage}"]`)).not.toBeNull();
    expect(document.activeElement).toBe(control);
  });
});

describe("World Creation authoritative creation", () => {
  it("always encodes the created world route segment", async () => {
    const { document, root } = creationFixture();
    const navigate = vi.fn();
    mountWorldCreationPage(root, {
      initialState: reviewedState(),
      createWorld: vi.fn().mockResolvedValue({ ...createdWorld, id: "world / injected" }),
      navigate
    });

    document.querySelector<HTMLButtonElement>('[data-action="create-world"]')?.click();
    await settle();

    expect(navigate).toHaveBeenCalledWith("/app/worlds/world%20%2F%20injected?creation=created&cover=none");
  });

  it("creates from one snapshot exactly once, disables duplicate activation, and navigates only after success", async () => {
    const { document, root, window } = creationFixture();
    const pending = deferred<typeof createdWorld>();
    const createWorld = vi.fn(() => pending.promise);
    const navigate = vi.fn();
    mountWorldCreationPage(root, { createWorld, navigate });
    advanceManualWizardToCover(document, window as unknown as Window);
    document.querySelector<HTMLButtonElement>('[data-action="continue-stage"]')?.click();
    const create = document.querySelector<HTMLButtonElement>('[data-action="create-world"]');

    create?.click();
    create?.click();

    expect(createWorld).toHaveBeenCalledTimes(1);
    expect(createWorld).toHaveBeenCalledWith(expect.objectContaining({
      world: expect.objectContaining({ title: "Glass Atlas" }),
      playableCharacters: []
    }), expect.any(AbortSignal));
    expect(document.querySelector<HTMLButtonElement>('[data-action="create-world"]')?.disabled).toBe(true);
    expect(navigate).not.toHaveBeenCalled();

    pending.resolve(createdWorld);
    await settle();
    expect(navigate).toHaveBeenCalledWith(createdDestination("none"));
  });

  it("preserves provenance, cover intent, collections, defaults, and overview when creation fails", async () => {
    const { document, root } = creationFixture();
    let state = reviewedState("ai");
    state = setCreationCoverIntent(state, { mode: "generated", prompt: "Moonlit glass towers" });
    state = editCreationDraft(state, ["world", "genre"], "Science fantasy");
    state = editCreationDraft(state, ["world", "premise"], "A city follows a migrating star.");
    state = editCreationDraft(state, ["entities"], [{ id: "city", name: "Glass City" }]);
    state = editCreationDraft(state, ["relationships"], [{ source: "city", target: "star" }]);
    state = editCreationDraft(state, ["rpgStats"], [{ name: "Resolve", value: 3 }]);
    state = editCreationDraft(state, ["defaultTriggers"], [{ name: "Dusk" }]);
    state = editCreationDraft(state, ["eventTriggers"], [{ name: "Alarm" }]);
    state = editCreationDraft(state, ["assets"], [{ id: "atlas-map" }]);
    state = editCreationDraft(state, ["defaults"], { difficulty: "heroic" });
    const expectedDraft = structuredClone(state.draft);
    const createWorld = vi.fn().mockRejectedValue(new WorldCreationApiError("network", "offline", null));
    const navigate = vi.fn();
    mountWorldCreationPage(root, { initialState: state, createWorld, navigate });

    document.querySelector<HTMLButtonElement>('[data-action="create-world"]')?.click();
    await settle();

    expect(createWorld).toHaveBeenCalledWith(expectedDraft, expect.any(AbortSignal));
    expect(navigate).not.toHaveBeenCalled();
    const error = document.querySelector<HTMLElement>('[data-creation-error]');
    expect(error?.textContent).toContain("not created");
    expect(document.activeElement).toBe(error);
    expect(document.querySelector('[data-review-provenance]')?.textContent).toContain("AI-assisted");
    expect(JSON.parse(document.querySelector('[data-review-serialized]')?.textContent ?? "null")).toEqual(expectedDraft);
    expect(document.querySelector<HTMLButtonElement>('[data-action="create-world"]')?.disabled).toBe(false);

    document.querySelector<HTMLButtonElement>('[data-action="back-stage"]')?.click();
    expect(document.querySelector<HTMLInputElement>('[name="coverMode"][value="generated"]')?.checked).toBe(true);
    expect(document.querySelector<HTMLTextAreaElement>('[name="cover.prompt"]')?.value).toBe("Moonlit glass towers");
  });

  it("creates once before attaching a retained cover and navigates after both succeed", async () => {
    const { document, root, window } = creationFixture();
    const createWorld = vi.fn().mockResolvedValue(createdWorld);
    const attachCreatedWorldCover = vi.fn().mockResolvedValue({ assetUrl: "/covers/asset-1" });
    const navigate = vi.fn();
    mountWorldCreationPage(root, { createWorld, attachCreatedWorldCover, navigate });
    advanceManualWizardToCover(document, window as unknown as Window);
    const retained = document.querySelector<HTMLInputElement>('[name="coverMode"][value="retained_asset"]');
    retained!.checked = true;
    retained!.dispatchEvent(new window.Event("change", { bubbles: true }));
    inputValue(document, window as unknown as Window, '[name="cover.assetId"]', "asset-1");
    document.querySelector<HTMLButtonElement>('[data-action="continue-stage"]')?.click();

    document.querySelector<HTMLButtonElement>('[data-action="create-world"]')?.click();
    await settle();

    expect(createWorld).toHaveBeenCalledTimes(1);
    expect(attachCreatedWorldCover).toHaveBeenCalledWith(createdWorld.id, "asset-1", expect.any(AbortSignal));
    expect(attachCreatedWorldCover.mock.invocationCallOrder[0]).toBeGreaterThan(createWorld.mock.invocationCallOrder[0]!);
    expect(navigate).toHaveBeenCalledWith(createdDestination("completed"));
  });

  it.each([
    ["queued", true, "queued"],
    ["generating", true, "in progress"],
    ["provider_pending", true, "in progress"],
    ["downloading", true, "in progress"],
    ["completed", true, "completed"],
    ["recoverable", false, "could not be completed"],
    ["failed", false, "could not be completed"],
    ["cancelled", false, "could not be completed"],
    ["expired", false, "could not be completed"]
  ] as const)("classifies resolved generated-cover status %s", async (status, navigates, message) => {
    const { document, root, window } = creationFixture();
    const createWorld = vi.fn().mockResolvedValue(createdWorld);
    const generateCreatedWorldCover = vi.fn().mockResolvedValue({
      id: "cover-job", worldId: createdWorld.id, targetType: "world_cover", status, duplicate: false
    });
    const navigate = vi.fn();
    mountWorldCreationPage(root, { createWorld, generateCreatedWorldCover, navigate });
    advanceManualWizardToCover(document, window as unknown as Window);
    const generated = document.querySelector<HTMLInputElement>('[name="coverMode"][value="generated"]');
    generated!.checked = true;
    generated!.dispatchEvent(new window.Event("change", { bubbles: true }));
    inputValue(document, window as unknown as Window, '[name="cover.prompt"]', "Moonlit glass towers");
    document.querySelector<HTMLButtonElement>('[data-action="continue-stage"]')?.click();

    document.querySelector<HTMLButtonElement>('[data-action="create-world"]')?.click();
    await settle();

    expect(createWorld).toHaveBeenCalledTimes(1);
    expect(generateCreatedWorldCover).toHaveBeenCalledTimes(1);
    expect(document.querySelector("[data-cover-status], [data-cover-error]")?.textContent).toContain(message);
    if (navigates) {
      expect(navigate).toHaveBeenCalledWith(createdDestination(status === "completed" ? "completed" : "pending"));
    } else {
      expect(navigate).not.toHaveBeenCalled();
      expect(document.querySelector<HTMLButtonElement>('[data-action="open-created-world"]')).not.toBeNull();
      expect(document.querySelector<HTMLButtonElement>('[data-action="retry-cover"]')).not.toBeNull();
    }
  });

  it("does not repeat or roll back creation when cover fails, and retry calls only the cover endpoint", async () => {
    const { document, root, window } = creationFixture();
    const createWorld = vi.fn().mockResolvedValue(createdWorld);
    const generateCreatedWorldCover = vi.fn()
      .mockRejectedValueOnce(new WorldCreationApiError("unavailable", "Image provider unavailable", 503))
      .mockResolvedValueOnce({
        id: "cover-job", worldId: createdWorld.id, targetType: "world_cover", status: "queued", duplicate: false
      });
    const navigate = vi.fn();
    mountWorldCreationPage(root, { createWorld, generateCreatedWorldCover, navigate });
    advanceManualWizardToCover(document, window as unknown as Window);
    const generated = document.querySelector<HTMLInputElement>('[name="coverMode"][value="generated"]');
    generated!.checked = true;
    generated!.dispatchEvent(new window.Event("change", { bubbles: true }));
    inputValue(document, window as unknown as Window, '[name="cover.prompt"]', "Moonlit glass towers");
    document.querySelector<HTMLButtonElement>('[data-action="continue-stage"]')?.click();

    document.querySelector<HTMLButtonElement>('[data-action="create-world"]')?.click();
    await settle();

    expect(createWorld).toHaveBeenCalledTimes(1);
    expect(generateCreatedWorldCover).toHaveBeenCalledTimes(1);
    expect(generateCreatedWorldCover.mock.invocationCallOrder[0]).toBeGreaterThan(createWorld.mock.invocationCallOrder[0]!);
    expect(navigate).not.toHaveBeenCalled();
    expect(document.querySelector('[data-cover-error]')?.textContent).toContain("Provider Setup");
    const openWorld = document.querySelector<HTMLButtonElement>('[data-action="open-created-world"]');
    expect(openWorld?.textContent).toBe("Open world");
    openWorld?.click();
    expect(navigate).toHaveBeenCalledWith(createdDestination("recovery"));
    navigate.mockClear();

    document.querySelector<HTMLButtonElement>('[data-action="retry-cover"]')?.click();
    await settle();

    expect(createWorld).toHaveBeenCalledTimes(1);
    expect(generateCreatedWorldCover).toHaveBeenCalledTimes(2);
    expect(generateCreatedWorldCover).toHaveBeenLastCalledWith(
      createdWorld.id, "Moonlit glass towers", expect.any(AbortSignal)
    );
  });

  it("guards navigation only while local work exists and keeps listeners across persisted pagehide", () => {
    const { document, root, window } = creationFixture();
    const mounted = mountWorldCreationPage(root);
    const clean = new window.Event("beforeunload", { cancelable: true });
    window.dispatchEvent(clean);
    expect(clean.defaultPrevented).toBe(false);

    chooseMethod(document, window as unknown as Window, "manual");
    const dirty = new window.Event("beforeunload", { cancelable: true });
    window.dispatchEvent(dirty);
    expect(dirty.defaultPrevented).toBe(true);

    const persistedHide = new window.Event("pagehide");
    Object.defineProperty(persistedHide, "persisted", { value: true });
    window.dispatchEvent(persistedHide);
    const stillDirty = new window.Event("beforeunload", { cancelable: true });
    window.dispatchEvent(stillDirty);
    expect(stillDirty.defaultPrevented).toBe(true);
    mounted.dispose();
  });

  it("aborts creation on disposal and ignores stale completion without navigating", async () => {
    const { document, root, window } = creationFixture();
    const pending = deferred<typeof createdWorld>();
    const createWorld = vi.fn(() => pending.promise);
    const navigate = vi.fn();
    const mounted = mountWorldCreationPage(root, { createWorld, navigate });
    advanceManualWizardToCover(document, window as unknown as Window);
    document.querySelector<HTMLButtonElement>('[data-action="continue-stage"]')?.click();
    document.querySelector<HTMLButtonElement>('[data-action="create-world"]')?.click();
    const signal = createWorld.mock.calls[0]?.[1] as AbortSignal;

    mounted.dispose();
    expect(signal.aborted).toBe(true);
    pending.resolve(createdWorld);
    await settle();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("ignores stale initial-cover completion after disposal without navigation or cover messaging", async () => {
    const { document, root, window } = creationFixture();
    const pendingCover = deferred<{ id: string; worldId: string; targetType: "world_cover"; status: "completed"; duplicate: false }>();
    const generateCreatedWorldCover = vi.fn(() => pendingCover.promise);
    const navigate = vi.fn();
    const mounted = mountWorldCreationPage(root, {
      createWorld: vi.fn().mockResolvedValue(createdWorld),
      generateCreatedWorldCover,
      navigate
    });
    advanceManualWizardToCover(document, window as unknown as Window);
    const generated = document.querySelector<HTMLInputElement>('[name="coverMode"][value="generated"]');
    generated!.checked = true;
    generated!.dispatchEvent(new window.Event("change", { bubbles: true }));
    inputValue(document, window as unknown as Window, '[name="cover.prompt"]', "Moonlit glass towers");
    document.querySelector<HTMLButtonElement>('[data-action="continue-stage"]')?.click();
    document.querySelector<HTMLButtonElement>('[data-action="create-world"]')?.click();
    await settle();
    const signal = generateCreatedWorldCover.mock.calls[0]?.[2] as AbortSignal;

    mounted.dispose();
    expect(signal.aborted).toBe(true);
    pendingCover.resolve({
      id: "cover-job", worldId: createdWorld.id, targetType: "world_cover", status: "completed", duplicate: false
    });
    await settle();

    expect(navigate).not.toHaveBeenCalled();
    expect(document.querySelector("[data-cover-status], [data-cover-error]")).toBeNull();
  });

  it("ignores stale cover-only retry completion after disposal without navigation or cover messaging", async () => {
    const { document, root, window } = creationFixture();
    const pendingRetry = deferred<{ id: string; worldId: string; targetType: "world_cover"; status: "completed"; duplicate: false }>();
    const generateCreatedWorldCover = vi.fn()
      .mockRejectedValueOnce(new Error("cover failed"))
      .mockImplementationOnce(() => pendingRetry.promise);
    const navigate = vi.fn();
    const mounted = mountWorldCreationPage(root, {
      createWorld: vi.fn().mockResolvedValue(createdWorld),
      generateCreatedWorldCover,
      navigate
    });
    advanceManualWizardToCover(document, window as unknown as Window);
    const generated = document.querySelector<HTMLInputElement>('[name="coverMode"][value="generated"]');
    generated!.checked = true;
    generated!.dispatchEvent(new window.Event("change", { bubbles: true }));
    inputValue(document, window as unknown as Window, '[name="cover.prompt"]', "Moonlit glass towers");
    document.querySelector<HTMLButtonElement>('[data-action="continue-stage"]')?.click();
    document.querySelector<HTMLButtonElement>('[data-action="create-world"]')?.click();
    await settle();
    document.querySelector<HTMLButtonElement>('[data-action="retry-cover"]')?.click();
    const signal = generateCreatedWorldCover.mock.calls[1]?.[2] as AbortSignal;

    mounted.dispose();
    expect(signal.aborted).toBe(true);
    pendingRetry.resolve({
      id: "cover-job", worldId: createdWorld.id, targetType: "world_cover", status: "completed", duplicate: false
    });
    await settle();

    expect(navigate).not.toHaveBeenCalled();
    expect(document.querySelector("[data-cover-status], [data-cover-error]")).toBeNull();
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

  it("stops progress polling after success, terminal progress, cancellation, and disposal", async () => {
    vi.useFakeTimers();
    try {
      const successFixture = creationFixture();
      const successProgress = vi.fn().mockResolvedValue({
        status: "processing", phase: "world_structure", progressPercent: 20, message: "Working"
      });
      mountWorldCreationPage(successFixture.root, {
        generateWorldPreview: vi.fn().mockResolvedValue(generatedPreview),
        loadWorldGenerationProgress: successProgress,
        generationPollIntervalMs: 100
      });
      chooseMethod(successFixture.document, successFixture.window as unknown as Window, "ai");
      enterConcept(successFixture.document, successFixture.window as unknown as Window, "Success");
      successFixture.document.querySelector<HTMLButtonElement>('[data-action="generate-world"]')?.click();
      await settle();
      await vi.advanceTimersByTimeAsync(500);
      expect(successProgress).not.toHaveBeenCalled();

      const terminalFixture = creationFixture();
      const terminalGeneration = deferred<typeof generatedPreview>();
      const terminalProgress = vi.fn().mockResolvedValue({
        status: "completed", phase: "complete", progressPercent: 100, message: "Complete"
      });
      mountWorldCreationPage(terminalFixture.root, {
        generateWorldPreview: () => terminalGeneration.promise,
        loadWorldGenerationProgress: terminalProgress,
        generationPollIntervalMs: 100
      });
      chooseMethod(terminalFixture.document, terminalFixture.window as unknown as Window, "ai");
      enterConcept(terminalFixture.document, terminalFixture.window as unknown as Window, "Terminal");
      terminalFixture.document.querySelector<HTMLButtonElement>('[data-action="generate-world"]')?.click();
      await vi.advanceTimersByTimeAsync(500);
      expect(terminalProgress).toHaveBeenCalledTimes(1);
      expect(terminalFixture.document.querySelector<HTMLProgressElement>("[data-generation-progress]")?.value).toBe(100);

      const cancelFixture = creationFixture();
      const cancelProgress = vi.fn().mockResolvedValue({
        status: "processing", phase: "world_structure", progressPercent: 20, message: "Working"
      });
      mountWorldCreationPage(cancelFixture.root, {
        generateWorldPreview: () => deferred<typeof generatedPreview>().promise,
        loadWorldGenerationProgress: cancelProgress,
        generationPollIntervalMs: 100
      });
      chooseMethod(cancelFixture.document, cancelFixture.window as unknown as Window, "ai");
      enterConcept(cancelFixture.document, cancelFixture.window as unknown as Window, "Cancel");
      cancelFixture.document.querySelector<HTMLButtonElement>('[data-action="generate-world"]')?.click();
      await vi.advanceTimersByTimeAsync(100);
      cancelFixture.document.querySelector<HTMLButtonElement>('[data-action="cancel-generation"]')?.click();
      const cancelCalls = cancelProgress.mock.calls.length;
      await vi.advanceTimersByTimeAsync(500);
      expect(cancelProgress).toHaveBeenCalledTimes(cancelCalls);

      const disposeFixture = creationFixture();
      const disposeProgress = vi.fn().mockResolvedValue({
        status: "processing", phase: "world_structure", progressPercent: 20, message: "Working"
      });
      const mounted = mountWorldCreationPage(disposeFixture.root, {
        generateWorldPreview: () => deferred<typeof generatedPreview>().promise,
        loadWorldGenerationProgress: disposeProgress,
        generationPollIntervalMs: 100
      });
      chooseMethod(disposeFixture.document, disposeFixture.window as unknown as Window, "ai");
      enterConcept(disposeFixture.document, disposeFixture.window as unknown as Window, "Dispose");
      disposeFixture.document.querySelector<HTMLButtonElement>('[data-action="generate-world"]')?.click();
      await vi.advanceTimersByTimeAsync(100);
      mounted.dispose();
      const disposeCalls = disposeProgress.mock.calls.length;
      await vi.advanceTimersByTimeAsync(500);
      expect(disposeProgress).toHaveBeenCalledTimes(disposeCalls);
    } finally {
      vi.useRealTimers();
    }
  });

  it("settles a failed terminal progress event, announces its error, and restores retry while preview remains pending", async () => {
    vi.useFakeTimers();
    try {
      const { document, root, window } = creationFixture();
      const pendingPreview = deferred<typeof generatedPreview>();
      const generateWorldPreview = vi.fn(() => pendingPreview.promise);
      const loadWorldGenerationProgress = vi.fn().mockResolvedValue({
        status: "failed",
        phase: "failed",
        progressPercent: 35,
        message: "Generation stopped",
        errorMessage: "The provider rejected this concept."
      });
      mountWorldCreationPage(root, {
        generateWorldPreview,
        loadWorldGenerationProgress,
        generationPollIntervalMs: 100
      });
      chooseMethod(document, window as unknown as Window, "ai");
      enterConcept(document, window as unknown as Window, "Keep this local concept");

      document.querySelector<HTMLButtonElement>('[data-action="generate-world"]')?.click();
      await vi.advanceTimersByTimeAsync(100);

      expect((generateWorldPreview.mock.calls[0]?.[1] as AbortSignal).aborted).toBe(true);
      expect(loadWorldGenerationProgress).toHaveBeenCalledTimes(1);
      expect(document.querySelector('[data-generation-status]')?.textContent).toContain("The provider rejected this concept.");
      expect(document.querySelector<HTMLTextAreaElement>('[data-concept-prompt="compact"]')?.value).toBe("Keep this local concept");
      expect(document.querySelector<HTMLButtonElement>('[data-action="generate-world"]')?.disabled).toBe(false);
      expect(document.querySelector<HTMLButtonElement>('[data-action="cancel-generation"]')?.hidden).toBe(true);
      await vi.advanceTimersByTimeAsync(500);
      expect(loadWorldGenerationProgress).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("invalidates a pending AI result when switching to Manual and preserves later Foundation edits", async () => {
    const { document, root, window } = creationFixture();
    const pending = deferred<typeof generatedPreview>();
    const generateWorldPreview = vi.fn(() => pending.promise);
    mountWorldCreationPage(root, { generateWorldPreview, loadWorldGenerationProgress: vi.fn() });
    chooseMethod(document, window as unknown as Window, "ai");
    enterConcept(document, window as unknown as Window, "Generate this");
    document.querySelector<HTMLButtonElement>('[data-action="generate-world"]')?.click();

    chooseMethod(document, window as unknown as Window, "manual");
    expect((generateWorldPreview.mock.calls[0]?.[1] as AbortSignal).aborted).toBe(true);
    document.querySelector<HTMLButtonElement>('[data-action="continue-manual"]')?.click();
    inputValue(document, window as unknown as Window, '[name="world.title"]', "Manual Atlas");
    inputValue(document, window as unknown as Window, '[name="world.genre"]', "Hand-authored fantasy");
    pending.resolve(generatedPreview);
    await settle();

    expect(document.querySelector<HTMLInputElement>('[name="world.title"]')?.value).toBe("Manual Atlas");
    expect(document.querySelector<HTMLInputElement>('[name="world.genre"]')?.value).toBe("Hand-authored fantasy");
    expect(document.querySelector('[data-creation-stage="foundation"]')).not.toBeNull();
  });

  it("preserves existing Foundation fields and concept after generation failures", async () => {
    const { document, root, window } = creationFixture();
    const generateWorldPreview = vi.fn()
      .mockResolvedValueOnce({ title: "Broken", content: { schemaVersion: 5 } })
      .mockRejectedValueOnce(new WorldCreationApiError("unavailable", "offline", 503));
    mountWorldCreationPage(root, {
      generateWorldPreview: generateWorldPreview as never,
      loadWorldGenerationProgress: vi.fn(),
      confirmGeneratedReplacement: () => true
    });
    chooseMethod(document, window as unknown as Window, "manual");
    document.querySelector<HTMLButtonElement>('[data-action="continue-manual"]')?.click();
    inputValue(document, window as unknown as Window, '[name="world.title"]', "Existing Atlas");
    inputValue(document, window as unknown as Window, '[name="world.genre"]', "Existing genre");
    document.querySelector<HTMLButtonElement>('[data-action="back-stage"]')?.click();
    chooseMethod(document, window as unknown as Window, "ai");
    enterConcept(document, window as unknown as Window, "Preserve this concept");

    for (const expected of ["could not be generated", "unavailable"]) {
      document.querySelector<HTMLButtonElement>('[data-action="generate-world"]')?.click();
      await settle();
      expect(document.querySelector("[data-generation-status]")?.textContent).toContain(expected);
    }
    chooseMethod(document, window as unknown as Window, "manual");
    document.querySelector<HTMLButtonElement>('[data-action="continue-manual"]')?.click();
    expect(document.querySelector<HTMLInputElement>('[name="world.title"]')?.value).toBe("Existing Atlas");
    expect(document.querySelector<HTMLInputElement>('[name="world.genre"]')?.value).toBe("Existing genre");
    document.querySelector<HTMLButtonElement>('[data-action="back-stage"]')?.click();
    chooseMethod(document, window as unknown as Window, "ai");
    expect(document.querySelector<HTMLTextAreaElement>('[data-concept-prompt="compact"]')?.value).toBe("Preserve this concept");
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
    const completedFoundation = document.querySelector<HTMLElement>('[data-stage="foundation"]');
    expect(completedFoundation?.dataset.stageState).toBe("completed");
    expect(completedFoundation?.querySelector(".visually-hidden")?.textContent?.trim()).toBe("Completed:");
    expect(completedFoundation?.textContent).toMatch(/Completed:\s*Foundation/);
    expect(completedFoundation?.hasAttribute("aria-label")).toBe(false);
    const currentCanon = document.querySelector<HTMLElement>('[data-stage="canon"]');
    const upcomingMechanics = document.querySelector<HTMLElement>('[data-stage="mechanics"]');
    expect(currentCanon?.dataset.stageState).toBe("current");
    expect(currentCanon?.getAttribute("aria-current")).toBe("step");
    expect(currentCanon?.querySelector(".visually-hidden")).toBeNull();
    expect(upcomingMechanics?.getAttribute("aria-disabled")).toBe("true");
    expect(upcomingMechanics?.querySelector(".visually-hidden")).toBeNull();
    document.querySelector<HTMLButtonElement>('[data-action="back-stage"]')?.click();
    expect(document.querySelector<HTMLInputElement>('[name="world.title"]')?.value).toBe("Local Atlas");
    expect(document.querySelector<HTMLInputElement>('[name="world.genre"]')?.value).toBe("Solar fantasy");
    expect(generateWorldPreview).not.toHaveBeenCalled();
    expect(loadWorldGenerationProgress).not.toHaveBeenCalled();
  });

  it("uses enabled stage buttons for completed and revisitable navigation while keeping unavailable stages disabled", () => {
    const { document, root, window } = creationFixture();
    mountWorldCreationPage(root, { initialState: reviewedState() });
    const foundation = document.querySelector<HTMLButtonElement>('[data-stage="foundation"]');
    const review = document.querySelector<HTMLButtonElement>('[data-stage="review"]');
    expect(foundation?.disabled).toBe(false);
    expect(review?.getAttribute("aria-current")).toBe("step");

    foundation?.click();
    expect(document.querySelector('[data-creation-stage="foundation"]')).not.toBeNull();
    const revisitableReview = document.querySelector<HTMLButtonElement>('[data-stage="review"]');
    expect(revisitableReview?.disabled).toBe(false);
    expect(revisitableReview?.dataset.stageState).toBe("revisitable");

    inputValue(document, window as unknown as Window, '[name="world.title"]', "");
    revisitableReview?.focus();
    revisitableReview?.dispatchEvent(keyboardEvent(window as unknown as Window, "Enter"));
    expect(document.querySelector('[data-creation-stage="foundation"]')).not.toBeNull();
    expect(document.querySelector('[name="world.title"]')?.getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(document.querySelector('[name="world.title"]'));

    inputValue(document, window as unknown as Window, '[name="world.title"]', "Glass Atlas");
    document.querySelector<HTMLButtonElement>('[data-stage="review"]')?.dispatchEvent(
      keyboardEvent(window as unknown as Window, "Enter")
    );
    expect(document.querySelector('[data-creation-stage="review"]')).not.toBeNull();

    const fresh = creationFixture();
    mountWorldCreationPage(fresh.root);
    expect(fresh.document.querySelector<HTMLButtonElement>('[data-stage="foundation"]')?.disabled).toBe(true);
    expect(fresh.document.querySelector<HTMLButtonElement>('[data-stage="foundation"]')?.getAttribute("aria-disabled")).toBe("true");
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
    inputValue(document, window as unknown as Window, '[data-structured-field="value"]', "3");
    inputValue(document, window as unknown as Window, '[data-structured-field="note"]', "Resist fear");
    let advanced = document.querySelector<HTMLTextAreaElement>("[data-advanced-json]");
    if (!advanced) throw new Error("Advanced JSON editor missing.");
    advanced.value = '{"name":"Resolve","value":3,"unknownRule":"keep"}';
    advanced.dispatchEvent(new window.Event("input", { bubbles: true }));
    document.querySelector<HTMLButtonElement>('[data-action="apply-advanced-json"]')?.click();
    inputValue(document, window as unknown as Window, '[data-structured-field="name"]', "Composure");
    advanced = document.querySelector<HTMLTextAreaElement>("[data-advanced-json]");
    expect(advanced?.value).toContain('"unknownRule": "keep"');
    expect(advanced?.value).toContain('"name": "Composure"');
    for (const [collection, values] of [
      ["defaultTriggers", ["Torch", "At dusk", "Light the torch"]],
      ["eventTriggers", ["Bell", "When danger nears", "Sound the alarm"]]
    ] as const) {
      document.querySelector<HTMLButtonElement>(`[data-collection-target="${collection}"]`)?.click();
      document.querySelector<HTMLButtonElement>('[data-action="add-item"]')?.click();
      inputValue(document, window as unknown as Window, '[data-structured-field="name"]', values[0]);
      inputValue(document, window as unknown as Window, '[data-structured-field="condition"]', values[1]);
      inputValue(document, window as unknown as Window, '[data-structured-field="effect"]', values[2]);
      const triggerJson = document.querySelector<HTMLTextAreaElement>("[data-advanced-json]")?.value ?? "";
      expect(triggerJson).toContain(values[0]);
      expect(triggerJson).toContain(values[1]);
      expect(triggerJson).toContain(values[2]);
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
