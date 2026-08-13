import { parseHTML } from "linkedom";
import { describe, expect, it, vi } from "vitest";
import type { PlayableCharacter } from "../../packages/contracts/src/world-library.js";
import type {
  CharacterWorkspaceSession,
  CharacterWorkspaceSessionStore
} from "../../apps/web-next/src/character-workspace-session.js";
import { mountCharacterWorkspacePage } from "../../apps/web-next/src/character-workspace-page.js";

const draft = () => ({
  schemaVersion: 5,
  world: { title: "Glass Atlas", genre: "", tone: "", premise: "", backgroundStory: "", firstAction: "", rules: "" },
  playableCharacters: [], entities: [], relationships: [], rpgStats: [], defaultTriggers: [], eventTriggers: [], assets: [], defaults: {},
  preservedLore: { cartographer: "Ilyra" }
});

const generatedCharacter: PlayableCharacter = {
  id: "provider-id",
  name: "Ilyra Venn",
  characterText: "A patient cartographer who reads promises in reflected starlight.",
  profile: {
    identity: { aliases: ["The Glass Reader"], pronouns: "she/her" },
    story: { role: "Guide", background: "", personality: "Patient", motivations: "", goals: "", fearsAndConflicts: "", keyRelationships: "", narrativeHooks: "", voiceAndMannerisms: "", otherGuidance: "" },
    appearance: { ancestryOrSpecies: "Human", apparentAge: "34", genderPresentation: "", build: "", skinOrComplexion: "", face: "", eyes: "Silver", hair: "", distinguishingFeatures: [], clothing: "", equipmentAndAccessories: "", otherVisualDetails: "" },
    unclassifiedNotes: "",
    preservedProfileLore: "safe"
  },
  rpgStats: [{ name: "Navigation", value: 4, preserved: true }],
  defaultTriggers: [{ name: "Reflections", condition: "At mirrors", effect: "Recall a promise" }],
  source: { provider: "preview" },
  preservedCharacterLore: { oath: "North" }
};

function session(candidate: PlayableCharacter | null = null): CharacterWorkspaceSession {
  return {
    version: 1,
    key: "opaque-key",
    origin: "world-editor",
    mode: candidate ? "edit" : "create",
    workflowId: "workflow-1",
    parentRoute: "/app/worlds/world-1?tab=characters",
    expectedWorldRevision: 4,
    parentDraft: draft(),
    worldContext: draft(),
    rosterSummaries: [{ id: "existing", name: "Existing Hero" }],
    candidate,
    expiresAt: Date.now() + 60_000
  };
}

function store(loaded: CharacterWorkspaceSession | null = session()) {
  return {
    load: vi.fn(() => loaded),
    returnPath: vi.fn(() => "/app/worlds/world-1?tab=characters"),
    complete: vi.fn(() => true),
    create: vi.fn(),
    consume: vi.fn()
  } as unknown as CharacterWorkspaceSessionStore & { load: ReturnType<typeof vi.fn>; complete: ReturnType<typeof vi.fn> };
}

function fixture() {
  const { document, window } = parseHTML('<html><body><div id="app"></div></body></html>');
  const root = document.querySelector<HTMLElement>("#app")!;
  window.HTMLElement.prototype.focus = function focus() {
    Object.defineProperty(document, "activeElement", { configurable: true, value: this });
  };
  window.HTMLTextAreaElement.prototype.setSelectionRange = function setSelectionRange(start: number, end: number) {
    Object.defineProperties(this, {
      selectionStart: { configurable: true, writable: true, value: start },
      selectionEnd: { configurable: true, writable: true, value: end }
    });
  };
  return { document, window, root };
}

function input(document: Document, window: Window, selector: string, value: string): void {
  const field = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)!;
  field.value = value;
  field.dispatchEvent(new window.Event("input", { bubbles: true }));
}

function click(document: Document, selector: string): void {
  document.querySelector<HTMLButtonElement>(selector)?.click();
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function key(window: Window, value: string, shiftKey = false): Event {
  const event = new window.Event("keydown", { bubbles: true, cancelable: true });
  Object.defineProperties(event, { key: { value }, shiftKey: { value: shiftKey } });
  return event;
}

describe("Character Workspace page", () => {
  it("renders a recoverable unavailable state for missing or expired sessions", () => {
    const { document, root } = fixture();
    mountCharacterWorkspacePage(root, "expired", { sessionStore: store(null) });
    expect(document.querySelector('[data-page="character-workspace-unavailable"]')).not.toBeNull();
    expect(document.querySelector('a[href="/app/worlds/world-1?tab=characters"]')).not.toBeNull();
    expect(root.textContent).toContain("unavailable or expired");
    expect(root.textContent).toContain("No world data was changed");
  });

  it("renders six semantic stages, completed stage text, and exactly two compact method radios", () => {
    const { document, window, root } = fixture();
    mountCharacterWorkspacePage(root, "opaque-key", { sessionStore: store() });
    expect([...document.querySelectorAll("[data-character-stage]")].map((item) => item.getAttribute("data-character-stage")))
      .toEqual(["method", "identity", "story", "appearance", "mechanics", "review"]);
    expect(document.querySelectorAll('.character-method-control input[type="radio"][name="characterMethod"]')).toHaveLength(2);
    expect(document.querySelector('[data-character-stage="method"]')?.getAttribute("aria-current")).toBe("step");
    const manual = document.querySelector<HTMLInputElement>('[value="manual"]')!;
    manual.checked = true;
    manual.dispatchEvent(new window.Event("change", { bubbles: true }));
    click(document, '[data-action="continue-character"]');
    expect(document.querySelector('[data-character-stage="method"] [data-stage-completion]')?.textContent).toBe("Completed: ");
  });

  it("synchronizes prompt editors, makes typing local, and generates only explicitly", async () => {
    const { document, window, root } = fixture();
    const generate = vi.fn().mockResolvedValue({ character: generatedCharacter });
    mountCharacterWorkspacePage(root, "opaque-key", {
      sessionStore: store(), generateCharacterPreview: generate,
      loadGenerationProgress: vi.fn().mockResolvedValue({ status: "completed", phase: "completed", progressPercent: 100, message: "Ready" }),
      confirmGeneratedReplacement: () => true, generationPollIntervalMs: 1
    });
    const ai = document.querySelector<HTMLInputElement>('[value="ai"]')!;
    ai.checked = true;
    ai.dispatchEvent(new window.Event("change", { bubbles: true }));
    input(document, window, '[data-character-prompt="compact"]', "Create a reflective cartographer.");
    expect(generate).not.toHaveBeenCalled();
    click(document, '[data-action="expand-character-prompt"]');
    expect(document.querySelector<HTMLTextAreaElement>('[data-character-prompt="expanded"]')?.value).toContain("cartographer");
    input(document, window, '[data-character-prompt="expanded"]', "Create a patient cartographer.");
    expect(document.querySelector<HTMLTextAreaElement>('[data-character-prompt="compact"]')?.value).toContain("patient");
    click(document, '[data-action="close-character-prompt"]');
    click(document, '[data-action="generate-character"]');
    await settle();
    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate.mock.calls[0]?.[0]).toMatchObject({ prompt: "Create a patient cartographer.", content: expect.objectContaining({ preservedLore: { cartographer: "Ilyra" } }) });
    expect(document.querySelector<HTMLInputElement>('[name="candidate.name"]')?.value).toBe("Ilyra Venn");
    input(document, window, '[name="candidate.name"]', "Ilyra Edited");
    expect(document.querySelector<HTMLInputElement>('[name="candidate.name"]')?.value).toBe("Ilyra Edited");
  });

  it("asks to replace local edits only when generated output is ready to apply", async () => {
    const { document, window, root } = fixture();
    let resolve!: (value: { character: PlayableCharacter }) => void;
    const generated = new Promise<{ character: PlayableCharacter }>((done) => { resolve = done; });
    const confirm = vi.fn(() => false);
    mountCharacterWorkspacePage(root, "opaque-key", {
      sessionStore: store(session(generatedCharacter)), generateCharacterPreview: vi.fn(() => generated), confirmGeneratedReplacement: confirm,
      loadGenerationProgress: vi.fn().mockResolvedValue({ status: "processing", phase: "generating", progressPercent: 35, message: "Generating" }),
      generationPollIntervalMs: 1
    });
    const ai = document.querySelector<HTMLInputElement>('[value="ai"]')!;
    ai.checked = true;
    ai.dispatchEvent(new window.Event("change", { bubbles: true }));
    input(document, window, '[data-character-prompt="compact"]', "Create a guide");
    click(document, '[data-action="generate-character"]');
    expect(confirm).not.toHaveBeenCalled();
    resolve({ character: { ...generatedCharacter, name: "Replacement Hero" } });
    await settle();
    expect(confirm).toHaveBeenCalledTimes(1);
    click(document, '[data-action="continue-character"]');
    expect(document.querySelector<HTMLInputElement>('[name="candidate.name"]')?.value ?? "").toBe("Ilyra Venn");
  });

  it("focuses the exact invalid field and keeps the generated ID read-only", () => {
    const { document, window, root } = fixture();
    mountCharacterWorkspacePage(root, "opaque-key", { sessionStore: store() });
    const manual = document.querySelector<HTMLInputElement>('[value="manual"]')!;
    manual.checked = true;
    manual.dispatchEvent(new window.Event("change", { bubbles: true }));
    click(document, '[data-action="continue-character"]');
    expect(document.querySelector<HTMLInputElement>('[name="candidate.id"]')?.readOnly).toBe(true);
    click(document, '[data-action="continue-character"]');
    const name = document.querySelector<HTMLInputElement>('[name="candidate.name"]');
    expect(document.activeElement).toBe(name);
    expect(name?.getAttribute("aria-invalid")).toBe("true");
  });

  it("invalidates generation when the method changes or the author leaves Method", async () => {
    const { document, window, root } = fixture();
    const pending = deferred<{ character: PlayableCharacter }>();
    const generate = vi.fn((_request, signal: AbortSignal) => pending.promise.then((value) => signal.aborted
      ? Promise.reject(new DOMException("Aborted", "AbortError"))
      : value));
    mountCharacterWorkspacePage(root, "opaque-key", {
      sessionStore: store(), generateCharacterPreview: generate,
      loadGenerationProgress: vi.fn().mockResolvedValue({ status: "processing", phase: "generating", progressPercent: 35, message: "Generating" })
    });
    const ai = document.querySelector<HTMLInputElement>('[value="ai"]')!;
    ai.checked = true;
    ai.dispatchEvent(new window.Event("change", { bubbles: true }));
    input(document, window, '[data-character-prompt="compact"]', "Create one");
    click(document, '[data-action="generate-character"]');
    const manual = document.querySelector<HTMLInputElement>('[value="manual"]')!;
    manual.checked = true;
    manual.dispatchEvent(new window.Event("change", { bubbles: true }));
    pending.resolve({ character: generatedCharacter });
    await settle();
    expect(root.textContent).not.toContain("Ilyra Venn");
    manual.checked = false;
    ai.checked = true;
    ai.dispatchEvent(new window.Event("change", { bubbles: true }));
    expect(document.querySelector<HTMLButtonElement>('[data-action="cancel-character-generation"]')?.hidden).toBe(true);
    expect(document.querySelector<HTMLButtonElement>('[data-action="generate-character"]')?.disabled).toBe(false);

    const leaving = fixture();
    const leavingPreview = deferred<{ character: PlayableCharacter }>();
    mountCharacterWorkspacePage(leaving.root, "opaque-key", {
      sessionStore: store(), generateCharacterPreview: vi.fn(() => leavingPreview.promise),
      loadGenerationProgress: vi.fn().mockResolvedValue({ status: "processing", phase: "generating", progressPercent: 35, message: "Generating" })
    });
    const leavingAi = leaving.document.querySelector<HTMLInputElement>('[value="ai"]')!;
    leavingAi.checked = true;
    leavingAi.dispatchEvent(new leaving.window.Event("change", { bubbles: true }));
    input(leaving.document, leaving.window as unknown as Window, '[data-character-prompt="compact"]', "Create two");
    click(leaving.document, '[data-action="generate-character"]');
    click(leaving.document, '[data-action="continue-character"]');
    leavingPreview.resolve({ character: generatedCharacter });
    await settle();
    expect(leaving.document.querySelector('[data-character-canvas="identity"]')).not.toBeNull();
    expect(leaving.root.textContent).not.toContain("Ilyra Venn");
  });

  it("supports progress cancellation, retry, terminal failure, and stale-result isolation", async () => {
    const { document, window, root } = fixture();
    let resolveFirst!: (value: { character: PlayableCharacter }) => void;
    const first = new Promise<{ character: PlayableCharacter }>((done) => { resolveFirst = done; });
    const generate = vi.fn()
      .mockImplementationOnce((_request, signal: AbortSignal) => first.then((value) => signal.aborted ? Promise.reject(new DOMException("Aborted", "AbortError")) : value))
      .mockResolvedValueOnce({ character: { ...generatedCharacter, name: "Second Hero" } });
    const progress = vi.fn().mockResolvedValue({ status: "completed", phase: "completed", progressPercent: 100, message: "Ready" });
    mountCharacterWorkspacePage(root, "opaque-key", { sessionStore: store(), generateCharacterPreview: generate, loadGenerationProgress: progress, confirmGeneratedReplacement: () => true, generationPollIntervalMs: 1 });
    const ai = document.querySelector<HTMLInputElement>('[value="ai"]')!;
    ai.checked = true;
    ai.dispatchEvent(new window.Event("change", { bubbles: true }));
    input(document, window, '[data-character-prompt="compact"]', "Create one");
    click(document, '[data-action="generate-character"]');
    click(document, '[data-action="cancel-character-generation"]');
    input(document, window, '[data-character-prompt="compact"]', "Create two");
    click(document, '[data-action="generate-character"]');
    await settle();
    resolveFirst({ character: generatedCharacter });
    await settle();
    expect(generate).toHaveBeenCalledTimes(2);
    expect(document.querySelector<HTMLInputElement>('[name="candidate.name"]')?.value).toBe("Second Hero");
    expect(root.textContent).not.toContain("Ilyra Venn");
  });

  it("preserves clipboard focus/selection and traps dialog focus through Escape", async () => {
    const { document, window, root } = fixture();
    const write = vi.fn().mockResolvedValue(undefined);
    mountCharacterWorkspacePage(root, "opaque-key", { sessionStore: store(), writeClipboardText: write, readClipboardText: vi.fn().mockResolvedValue("Pasted idea") });
    const ai = document.querySelector<HTMLInputElement>('[value="ai"]')!;
    ai.checked = true;
    ai.dispatchEvent(new window.Event("change", { bubbles: true }));
    const compact = document.querySelector<HTMLTextAreaElement>('[data-character-prompt="compact"]')!;
    input(document, window, '[data-character-prompt="compact"]', "Copy this idea");
    compact.focus(); compact.setSelectionRange(2, 7);
    click(document, '[data-action="copy-character-prompt"]');
    await settle();
    expect(document.activeElement).toBe(compact);
    expect([compact.selectionStart, compact.selectionEnd]).toEqual([2, 7]);
    const expand = document.querySelector<HTMLButtonElement>('[data-action="expand-character-prompt"]')!;
    expand.focus(); expand.click();
    const dialog = document.querySelector<HTMLElement>(".character-prompt-dialog")!;
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    dialog.dispatchEvent(key(window, "Escape"));
    expect(dialog.hasAttribute("open")).toBe(false);
    expect(document.activeElement).toBe(expand);
  });

  it("renders untrusted review values as text without creating hostile DOM", () => {
    const { document, root } = fixture();
    const hostile = { ...generatedCharacter, name: '<img src=x onerror="alert(1)"><script>bad()</script>' };
    mountCharacterWorkspacePage(root, "opaque-key", { sessionStore: store(session(hostile)) });
    for (let index = 0; index < 5; index += 1) click(document, '[data-action="continue-character"]');
    const review = document.querySelector("[data-character-review]");
    expect(review?.textContent).toContain(hostile.name);
    expect(review?.querySelector("img, script")).toBeNull();
  });

  it("settles completed progress when preview transport remains pending", async () => {
    vi.useFakeTimers();
    const { document, window, root } = fixture();
    const preview = deferred<{ character: PlayableCharacter }>();
    let signal: AbortSignal | undefined;
    const progress = vi.fn().mockResolvedValue({
      status: "completed", phase: "completed", progressPercent: 37, message: "Character prepared"
    });
    mountCharacterWorkspacePage(root, "opaque-key", {
      sessionStore: store(),
      generateCharacterPreview: vi.fn((_request, requestSignal) => { signal = requestSignal; return preview.promise; }),
      loadGenerationProgress: progress,
      generationPollIntervalMs: 1,
      generationCompletionTimeoutMs: 5
    });
    const ai = document.querySelector<HTMLInputElement>('[value="ai"]')!;
    ai.checked = true;
    ai.dispatchEvent(new window.Event("change", { bubbles: true }));
    input(document, window, '[data-character-prompt="compact"]', "Create one");
    click(document, '[data-action="generate-character"]');
    await vi.advanceTimersByTimeAsync(1);
    await settle();
    expect(document.querySelector<HTMLProgressElement>("[data-character-generation-progress]")?.value).toBe(100);
    expect(document.querySelector('[data-character-generation-status]')?.getAttribute("role")).toBe("status");
    expect(root.textContent).toContain("Finalizing generated character · 100%");
    await vi.advanceTimersByTimeAsync(5);
    expect(signal?.aborted).toBe(true);
    expect(progress).toHaveBeenCalledTimes(1);
    expect(root.textContent).toContain("completed, but its preview did not arrive");
    expect(document.querySelector<HTMLButtonElement>('[data-action="generate-character"]')?.disabled).toBe(false);
    expect(document.querySelector<HTMLButtonElement>('[data-action="cancel-character-generation"]')?.hidden).toBe(true);
    preview.resolve({ character: { ...generatedCharacter, name: "Too late" } });
    await settle();
    expect(root.textContent).not.toContain("Too late");
    vi.useRealTimers();
  });

  it("treats terminal failed progress as authoritative and ignores a late preview", async () => {
    vi.useFakeTimers();
    const { document, window, root } = fixture();
    let resolvePreview!: (value: { character: PlayableCharacter }) => void;
    const preview = new Promise<{ character: PlayableCharacter }>((resolve) => { resolvePreview = resolve; });
    let previewSignal: AbortSignal | undefined;
    const generate = vi.fn((_request, signal: AbortSignal) => { previewSignal = signal; return preview; });
    const progress = vi.fn().mockResolvedValue({
      status: "failed", phase: "failed", progressPercent: 100,
      message: '<img src=x onerror="alert(1)">', errorMessage: "Provider secret detail"
    });
    mountCharacterWorkspacePage(root, "opaque-key", {
      sessionStore: store(), generateCharacterPreview: generate, loadGenerationProgress: progress,
      confirmGeneratedReplacement: () => true, generationPollIntervalMs: 1
    });
    const ai = document.querySelector<HTMLInputElement>('[value="ai"]')!;
    ai.checked = true;
    ai.dispatchEvent(new window.Event("change", { bubbles: true }));
    input(document, window, '[data-character-prompt="compact"]', "Keep this prompt");
    click(document, '[data-action="generate-character"]');
    await settle();
    expect(previewSignal?.aborted).toBe(true);
    expect(progress).toHaveBeenCalledTimes(1);
    expect(root.textContent).toContain("Character generation failed. Review the prompt and retry.");
    expect(root.textContent).not.toContain("Provider secret detail");
    expect(root.querySelector("img")).toBeNull();
    expect(document.querySelector<HTMLTextAreaElement>('[data-character-prompt="compact"]')?.value).toBe("Keep this prompt");
    expect(document.querySelector<HTMLButtonElement>('[data-action="generate-character"]')?.disabled).toBe(false);
    expect(document.querySelector<HTMLButtonElement>('[data-action="cancel-character-generation"]')?.hidden).toBe(true);
    await vi.advanceTimersByTimeAsync(10);
    expect(progress).toHaveBeenCalledTimes(1);
    resolvePreview({ character: { ...generatedCharacter, name: "Too Late" } });
    await settle();
    expect(root.textContent).not.toContain("Too Late");
    vi.useRealTimers();
  });

  it("uses native dialog methods and keeps the fallback dialog outside inert background subtrees", () => {
    const nativeFixture = fixture();
    const showModal = vi.fn(function (this: HTMLDialogElement) { this.setAttribute("open", ""); });
    const close = vi.fn(function (this: HTMLDialogElement) { this.removeAttribute("open"); });
    mountCharacterWorkspacePage(nativeFixture.root, "opaque-key", { sessionStore: store() });
    const nativeDialog = nativeFixture.document.querySelector<HTMLDialogElement>("dialog")!;
    nativeDialog.showModal = showModal;
    nativeDialog.close = close;
    const nativeAi = nativeFixture.document.querySelector<HTMLInputElement>('[value="ai"]')!;
    nativeAi.checked = true;
    nativeAi.dispatchEvent(new nativeFixture.window.Event("change", { bubbles: true }));
    click(nativeFixture.document, '[data-action="expand-character-prompt"]');
    expect(showModal).toHaveBeenCalledTimes(1);
    click(nativeFixture.document, '[data-action="close-character-prompt"]');
    expect(close).toHaveBeenCalledTimes(1);

    const fallback = fixture();
    const mounted = mountCharacterWorkspacePage(fallback.root, "opaque-key", { sessionStore: store() });
    const fallbackDialog = fallback.document.querySelector<HTMLDialogElement>("dialog")!;
    Object.defineProperties(fallbackDialog, {
      showModal: { configurable: true, value: undefined },
      close: { configurable: true, value: undefined }
    });
    const fallbackAi = fallback.document.querySelector<HTMLInputElement>('[value="ai"]')!;
    fallbackAi.checked = true;
    fallbackAi.dispatchEvent(new fallback.window.Event("change", { bubbles: true }));
    const workspace = fallback.document.querySelector<HTMLElement>(".character-workspace")!;
    workspace.setAttribute("inert", "preserved");
    click(fallback.document, '[data-action="expand-character-prompt"]');
    const expanded = fallback.document.querySelector<HTMLTextAreaElement>('[data-character-prompt="expanded"]')!;
    const background = fallback.document.querySelector<HTMLButtonElement>('[data-action="cancel-character"]')!;
    expect([...function * ancestors(element: Element) {
      for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) yield ancestor;
    }(fallbackDialog)].some((ancestor) => ancestor.hasAttribute("inert"))).toBe(false);
    expect(background.closest<HTMLElement>("[inert]")).not.toBeNull();
    expect(workspace.hasAttribute("inert")).toBe(true);
    expect(fallback.document.activeElement).toBe(expanded);
    background.focus();
    background.dispatchEvent(new fallback.window.Event("focusin", { bubbles: true }));
    expect(fallback.document.activeElement).toBe(expanded);
    background.dispatchEvent(new fallback.window.Event("click", { bubbles: true, cancelable: true }));
    expect(fallbackDialog.hasAttribute("open")).toBe(true);
    click(fallback.document, '[data-action="close-character-prompt"]');
    expect(background.closest<HTMLElement>("[inert]")).toBeNull();
    expect(workspace.getAttribute("inert")).toBe("preserved");
    click(fallback.document, '[data-action="expand-character-prompt"]');
    mounted.dispose();
    expect(background.closest<HTMLElement>("[inert]")).toBeNull();
    expect(workspace.getAttribute("inert")).toBe("preserved");
  });

  it("excludes the edited candidate from duplicate roster validation", () => {
    const { document, root } = fixture();
    const edited = session(generatedCharacter);
    edited.worldContext.playableCharacters = [generatedCharacter];
    mountCharacterWorkspacePage(root, "opaque-key", { sessionStore: store(edited) });
    click(document, '[data-action="continue-character"]');
    expect(document.querySelector('[name="candidate.id"]')?.getAttribute("aria-invalid")).toBeNull();
    click(document, '[data-action="continue-character"]');
    expect(document.querySelector('[name="candidate.characterText"]')).not.toBeNull();
  });

  it("maps mechanics collection errors to the exact visible target and focuses it", () => {
    const { document, root } = fixture();
    const overfull = session({
      ...generatedCharacter,
      rpgStats: Array.from({ length: 10_001 }, (_, index) => ({ name: `Stat ${index}`, value: index }))
    });
    mountCharacterWorkspacePage(root, "opaque-key", { sessionStore: store(overfull) });
    for (let index = 0; index < 4; index += 1) click(document, '[data-action="continue-character"]');
    click(document, '[data-action="continue-character"]');
    const target = document.querySelector<HTMLButtonElement>('[data-mechanics-collection="rpgStats"]');
    const error = document.querySelector<HTMLElement>('[data-field-error="candidate.rpgStats"]');
    expect(document.activeElement).toBe(target);
    expect(target?.getAttribute("aria-invalid")).toBe("true");
    expect(target?.getAttribute("aria-describedby")).toBe(error?.id);
    expect(error?.textContent).toContain("cannot contain more than");
  });

  it("renders complete review facts, exact final labels, and linked validation recovery", () => {
    const { document, window, root } = fixture();
    const edited = { ...generatedCharacter, source: {} };
    mountCharacterWorkspacePage(root, "opaque-key", { sessionStore: store(session(edited)) });
    for (const stage of ["identity", "story", "appearance", "mechanics"] as const) click(document, '[data-action="continue-character"]');
    expect(document.querySelector(".character-mechanics-master")).not.toBeNull();
    expect(document.querySelector(".character-mechanics-detail")).not.toBeNull();
    click(document, '[data-action="continue-character"]');
    const review = document.querySelector("[data-character-review]");
    expect(review?.textContent).toContain("Manual");
    expect(review?.textContent).toContain("provider-id");
    expect(review?.textContent).toContain("Glass Atlas");
    expect(review?.textContent).toContain("unsaved world-draft content");
    expect(review?.textContent).toContain("Warnings");
    expect(review?.textContent).toContain("Aliases");
    expect(review?.textContent).toContain("Story fields");
    expect(document.querySelectorAll("[data-character-review-readiness] li")).toHaveLength(6);
    expect(document.querySelector<HTMLButtonElement>('[data-action="accept-character"]')?.textContent).toBe("Update world draft");

    click(document, '[data-character-stage="story"]');
    input(document, window, '[name="candidate.characterText"]', "");
    click(document, '[data-character-stage="review"]');
    const errorLink = document.querySelector<HTMLAnchorElement>('[data-character-review-error-path="candidate.characterText"]');
    expect(errorLink?.textContent).toContain("Narrative guidance is required");
    errorLink?.click();
    expect(document.activeElement).toBe(document.querySelector('[name="candidate.characterText"]'));
    expect(document.querySelector('[name="candidate.characterText"]')?.getAttribute("aria-invalid")).toBe("true");

    click(document, '[data-character-stage="review"]');
    click(document, '[data-action="accept-character"]');
    expect(document.activeElement).toBe(document.querySelector('[name="candidate.characterText"]'));

    const createFixture = fixture();
    const createSession = session(generatedCharacter);
    createSession.mode = "create";
    mountCharacterWorkspacePage(createFixture.root, "opaque-key", { sessionStore: store(createSession) });
    for (let index = 0; index < 5; index += 1) click(createFixture.document, '[data-action="continue-character"]');
    expect(createFixture.document.querySelector<HTMLButtonElement>('[data-action="accept-character"]')?.textContent).toBe("Add to world draft");
  });

  it("completes acceptance once, supports cancellation, guards dirty navigation, and disposes", () => {
    const { document, window, root } = fixture();
    const sessionStore = store(session(generatedCharacter));
    const navigate = vi.fn();
    const mounted = mountCharacterWorkspacePage(root, "opaque-key", { sessionStore, navigate });
    const ai = document.querySelector<HTMLInputElement>('[value="ai"]')!;
    ai.checked = true;
    ai.dispatchEvent(new window.Event("change", { bubbles: true }));
    click(document, '[data-action="continue-character"]');
    input(document, window, '[name="candidate.name"]', "Changed");
    const detachedName = document.querySelector<HTMLInputElement>('[name="candidate.name"]')!;
    const beforeUnload = new window.Event("beforeunload", { cancelable: true });
    window.dispatchEvent(beforeUnload);
    expect(beforeUnload.defaultPrevented).toBe(true);
    for (let index = 0; index < 4; index += 1) click(document, '[data-action="continue-character"]');
    click(document, '[data-action="accept-character"]');
    click(document, '[data-action="accept-character"]');
    expect(sessionStore.complete).toHaveBeenCalledTimes(1);
    expect(sessionStore.complete).toHaveBeenCalledWith("opaque-key", "workflow-1", expect.objectContaining({ status: "accepted", candidate: expect.objectContaining({ preservedCharacterLore: { oath: "North" } }) }));
    expect(navigate).toHaveBeenCalledWith("/app/worlds/world-1?tab=characters");
    mounted.dispose();
    detachedName.value = "Cannot resurrect dirty state";
    detachedName.dispatchEvent(new window.Event("input", { bubbles: true }));
    const detachedPrompt = document.querySelector<HTMLTextAreaElement>('[data-character-prompt="expanded"]')!;
    detachedPrompt.value = "Cannot resurrect through root input";
    detachedPrompt.dispatchEvent(new window.Event("input", { bubbles: true }));
    const afterDispose = new window.Event("beforeunload", { cancelable: true });
    window.dispatchEvent(afterDispose);
    expect(afterDispose.defaultPrevented).toBe(false);
  });

  it("fails closed on duplicate-proof completion and records explicit cancellation", () => {
    const first = fixture();
    const rejecting = store(session(generatedCharacter));
    rejecting.complete.mockReturnValue(false);
    const navigate = vi.fn();
    mountCharacterWorkspacePage(first.root, "opaque-key", { sessionStore: rejecting, navigate });
    for (let index = 0; index < 5; index += 1) click(first.document, '[data-action="continue-character"]');
    click(first.document, '[data-action="accept-character"]');
    expect(navigate).not.toHaveBeenCalled();
    expect(first.root.textContent).toContain("could not be accepted");

    const second = fixture();
    const cancelling = store();
    mountCharacterWorkspacePage(second.root, "opaque-key", { sessionStore: cancelling, navigate });
    click(second.document, '[data-action="cancel-character"]');
    expect(cancelling.complete).toHaveBeenCalledWith("opaque-key", "workflow-1", { status: "cancelled" });
  });
});
