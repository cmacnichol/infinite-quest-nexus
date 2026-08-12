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
  });

  it("renders six semantic stages and exactly two compact method radios", () => {
    const { document, root } = fixture();
    mountCharacterWorkspacePage(root, "opaque-key", { sessionStore: store() });
    expect([...document.querySelectorAll("[data-character-stage]")].map((item) => item.getAttribute("data-character-stage")))
      .toEqual(["method", "identity", "story", "appearance", "mechanics", "review"]);
    expect(document.querySelectorAll('.character-method-control input[type="radio"][name="characterMethod"]')).toHaveLength(2);
    expect(document.querySelector('[data-character-stage="method"]')?.getAttribute("aria-current")).toBe("step");
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

  it("supports progress cancellation, retry, terminal failure, and stale-result isolation", async () => {
    const { document, window, root } = fixture();
    let resolveFirst!: (value: { character: PlayableCharacter }) => void;
    const first = new Promise<{ character: PlayableCharacter }>((done) => { resolveFirst = done; });
    const generate = vi.fn()
      .mockImplementationOnce((_request, signal: AbortSignal) => first.then((value) => signal.aborted ? Promise.reject(new DOMException("Aborted", "AbortError")) : value))
      .mockResolvedValueOnce({ character: { ...generatedCharacter, name: "Second Hero" } });
    const progress = vi.fn().mockResolvedValue({ status: "failed", phase: "failed", progressPercent: 100, message: "Generation failed", errorMessage: "Try again." });
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

  it("renders mechanics master-detail and review facts with a safe return link", () => {
    const { document, root } = fixture();
    mountCharacterWorkspacePage(root, "opaque-key", { sessionStore: store(session(generatedCharacter)) });
    for (const stage of ["identity", "story", "appearance", "mechanics"] as const) click(document, '[data-action="continue-character"]');
    expect(document.querySelector(".character-mechanics-master")).not.toBeNull();
    expect(document.querySelector(".character-mechanics-detail")).not.toBeNull();
    click(document, '[data-action="continue-character"]');
    expect(document.querySelector("[data-character-review]")?.textContent).toContain("AI-assisted");
    expect(document.querySelector("[data-character-review]")?.textContent).toContain("1 stat");
    expect(document.querySelector('a[href="/app/worlds/world-1?tab=characters"]')).not.toBeNull();
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
