import { parseHTML } from "linkedom";
import { createCampaignStore } from "../../packages/client-core/src/index.js";
import type { CampaignSyncStatus } from "../../packages/contracts/src/index.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StoryPlayerComposition } from "../../apps/web-next/src/story-player-composition.js";
import { mountStoryPlayerPage } from "../../apps/web-next/src/story-player-page.js";
import * as storyPlayerPage from "../../apps/web-next/src/story-player-page.js";

const campaignId = "11111111-1111-4111-8111-111111111111";
const worldVersionId = "22222222-2222-4222-8222-222222222222";

function fixture() {
  const { document, window } = parseHTML("<body><div id=app></div></body>");
  const root = document.querySelector<HTMLElement>("#app");
  if (!root) throw new Error("Story composer fixture root is missing.");
  return { document, window, root };
}

function campaignSummary(turnControlStyle = "action_only") {
  return {
    id: campaignId,
    title: "Campaign under test",
    status: "active",
    activeTurnNumber: 1,
    createdAt: "2026-08-18T00:00:00.000Z",
    updatedAt: "2026-08-18T00:00:00.000Z",
    storyLengthProfile: "standard",
    turnControlStyle,
    selectedCharacterId: null,
    selectedCharacterName: null,
    worldId: "33333333-3333-4333-8333-333333333333",
    worldTitle: "World under test",
    worldVersionId,
    textProviderProfileId: "44444444-4444-4444-8444-444444444444",
    imageProviderProfileId: null,
    worldVersionNumber: 1,
    latestWorldVersionNumber: 1,
    worldUpdateAvailable: false,
    costInformation: []
  };
}

function sync(choices: readonly string[] = ["Open the door", "Open the door"]): CampaignSyncStatus {
  const campaign = {
    id: campaignId,
    title: "Campaign under test",
    activeTurnNumber: 1,
    worldVersionId,
    storyLengthProfile: "standard",
    updatedAt: "2026-08-18T00:00:00.000Z",
    selectedCharacterId: null,
    selectedCharacterName: "",
    characterSnapshot: null,
    characterProfile: null,
    characterProfileRevision: 0,
    status: "active"
  };
  return {
    ...campaign,
    campaign,
    world: {
      id: "33333333-3333-4333-8333-333333333333",
      title: "World under test",
      versionNumber: 1,
      genre: "",
      tone: "",
      premise: "A real world premise.",
      backgroundStory: "A real world background.",
      character: "",
      firstAction: "Take the real first action.",
      rules: "",
      playableCharacters: []
    },
    playerConfig: {
      selectedCharacterId: null,
      selectedCharacterName: "",
      characterSnapshot: null,
      characterProfile: null,
      characterProfileRevision: 0,
      rpgStats: [], trackers: [], eventTriggers: [], useRpgStats: false, suppressEventTriggers: false
    },
    pendingGeneration: null,
    generationRecovery: null,
    syncToken: "sync-test",
    turnWindowMode: "replace",
    turns: {
      campaignId,
      nextCursor: null,
      turns: [{
        id: "66666666-6666-4666-8666-666666666666",
        turnNumber: 1,
        action: "Proceed.", inputMode: "action", inputModeSource: "explicit",
        narration: "The story continues.", choices, customActionSuggestion: "", imagePrompt: "", imageUrl: null,
        acceptedAt: "2026-08-18T00:00:00.000Z", chronicleRetrieval: null, reportedCost: null
      }]
    }
  } as CampaignSyncStatus;
}

function composition(options: {
  turnControlStyle?: string;
  autoSubmitTurnChoices?: boolean;
  classifyTurnInput?: ReturnType<typeof vi.fn>;
} = {}): StoryPlayerComposition {
  return {
    api: {
      campaigns: {
        list: vi.fn().mockResolvedValue({ campaigns: [campaignSummary(options.turnControlStyle)] }),
        classifyTurnInput: options.classifyTurnInput ?? vi.fn(),
        turns: vi.fn(), state: vi.fn()
      },
      generation: { syncStatus: vi.fn().mockResolvedValue(sync()) },
      session: { get: vi.fn().mockResolvedValue({ user: { settings: { autoSubmitTurnChoices: options.autoSubmitTurnChoices === true } } }) }
    },
    campaignStore: createCampaignStore(),
    workflow: {
      submit: vi.fn(async () => ({
        campaignId,
        jobId: "55555555-5555-4555-8555-555555555555",
        operationKind: "append" as const,
        replacementTurnId: null,
        async *watch() { yield { type: "settled" as const, outcome: "discarded" as const, error: new Error("test discard") }; },
        async *retryGeneration() {},
        cancelGeneration: vi.fn(), discardGeneration: vi.fn(), fetchResult: vi.fn()
      })),
      resume: vi.fn(async () => null)
    },
    illustrations: {}, idFactory: { create: () => "composer-idempotency-key" }, clock: {}, delay: {}
  } as unknown as StoryPlayerComposition;
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function enter(page: ReturnType<typeof fixture>, text: string): HTMLTextAreaElement {
  const textarea = page.document.querySelector<HTMLTextAreaElement>("[data-story-draft]");
  if (!textarea) throw new Error("Story composer textarea is missing.");
  textarea.value = text;
  textarea.dispatchEvent(new page.window.Event("input", { bubbles: true }));
  return textarea;
}

function selectTurnLength(page: ReturnType<typeof fixture>, value: string): HTMLSelectElement {
  const select = page.document.querySelector<HTMLSelectElement>("[data-story-length-profile]");
  if (!select) throw new Error("Story length profile control is missing.");
  for (const option of select.querySelectorAll<HTMLOptionElement>("option")) option.selected = option.value === value;
  select.dispatchEvent(new page.window.Event("change", { bubbles: true }));
  return select;
}

function keydown(page: ReturnType<typeof fixture>, target: HTMLElement, key: string): void {
  const event = new page.window.Event("keydown", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "key", { value: key });
  target.dispatchEvent(event);
}

type SubmissionPreparer = (
  draft: string,
  requestedInputMode: "auto" | "action" | "scene",
  campaignFallback: "action" | "scene",
  classify: (request: { text: string; preferredFallback: "action" | "scene" }) => Promise<unknown>
) => Promise<unknown>;

function submissionPreparer(): SubmissionPreparer | undefined {
  return (storyPlayerPage as unknown as { prepareTurnSubmission?: SubmissionPreparer }).prepareTurnSubmission;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => { resolve = nextResolve; });
  return { promise, resolve };
}

afterEach(() => vi.restoreAllMocks());

describe("Story continuation composer", () => {
  it("renders the compact turn length profile selector and resets it after a durable attachment", async () => {
    const page = fixture();
    const observer = vi.fn();
    const mounted = mountStoryPlayerPage(page.root, { campaignId, turnNumber: 1 }, composition(), { onSubmit: observer });
    await settle();

    const select = page.document.querySelector<HTMLSelectElement>("[data-story-length-profile]");
    expect([...select?.querySelectorAll("option") ?? []].map((option) => [option.getAttribute("value"), option.textContent]))
      .toEqual([["", "Campaign default — Standard"], ["brief", "Brief"], ["standard", "Standard"], ["long", "Long"], ["extended", "Extended"]]);
    selectTurnLength(page, "extended");
    enter(page, "Open the observatory.");
    page.document.querySelector<HTMLButtonElement>("[data-action='continue-story']")?.click();
    await settle();

    expect(observer).toHaveBeenCalledWith(expect.objectContaining({ storyLengthProfileOverride: "extended" }));
    expect(page.document.querySelector<HTMLSelectElement>("[data-story-length-profile]")?.value).toBe("");
    mounted.dispose();
  });

  it("captures the turn length for a direct submission and retains it after a rejected submission", async () => {
    const page = fixture();
    const observer = vi.fn();
    const mounted = mountStoryPlayerPage(page.root, { campaignId, turnNumber: 1 }, composition(), { onSubmit: observer });
    await settle();

    selectTurnLength(page, "extended");
    enter(page, "Describe the moment.");
    page.document.querySelector<HTMLButtonElement>("[data-action='continue-story']")?.click();
    await settle();
    expect(observer).toHaveBeenCalledWith(expect.objectContaining({ storyLengthProfileOverride: "extended", resolvedInputMode: "action" }));
    mounted.dispose();

    const rejectedPage = fixture();
    const base = composition();
    const rejected = {
      ...base,
      workflow: { submit: vi.fn(async () => { throw new Error("workflow unavailable"); }), resume: vi.fn(async () => null) }
    } as StoryPlayerComposition;
    const rejectedMounted = mountStoryPlayerPage(rejectedPage.root, { campaignId, turnNumber: 1 }, rejected);
    await settle();
    selectTurnLength(rejectedPage, "extended");
    enter(rejectedPage, "Try the observatory.");
    rejectedPage.document.querySelector<HTMLButtonElement>("[data-action='continue-story']")?.click();
    await settle();

    expect(rejectedPage.document.querySelector<HTMLSelectElement>("[data-story-length-profile]")?.value).toBe("extended");
    rejectedMounted.dispose();
  });

  it("keeps Retry Latest targeted at replacement after a rejected enqueue", async () => {
    const page = fixture();
    const confirm = vi.fn(() => true);
    Object.defineProperty(page.window, "confirm", { configurable: true, value: confirm });
    const base = composition();
    const mounted = mountStoryPlayerPage(page.root, { campaignId, turnNumber: 1 }, base);
    await settle();

    const replacementTurnId = "66666666-6666-4666-8666-666666666666";
    const submit = vi.fn()
      .mockRejectedValueOnce(new Error("temporary enqueue failure"))
      .mockResolvedValueOnce({
        campaignId,
        jobId: "55555555-5555-4555-8555-555555555555",
        operationKind: "replace_latest" as const,
        replacementTurnId,
        async *watch() {}, async *retryGeneration() {},
        cancelGeneration: vi.fn(), discardGeneration: vi.fn(), fetchResult: vi.fn()
      });
    Object.assign(base.workflow as object, { submit, resume: vi.fn(async () => null) });

    page.document.querySelector<HTMLButtonElement>("[data-action='retry-latest-generation']")?.click();
    await settle();
    selectTurnLength(page, "extended");
    page.document.querySelector<HTMLButtonElement>("[data-action='continue-story']")?.click();
    await settle();

    expect(submit).toHaveBeenCalledWith(campaignId, expect.objectContaining({
      operationKind: "replace_latest",
      request: expect.objectContaining({ storyLengthProfileOverride: "extended", expectedCurrentTurnNumber: 1 })
    }));
    expect(page.document.querySelector<HTMLSelectElement>("[data-story-length-profile]")?.value).toBe("extended");
    page.document.querySelector<HTMLButtonElement>("[data-action='continue-story']")?.click();
    await settle();

    expect(submit.mock.calls.map(([, request]) => (request as { operationKind: string }).operationKind))
      .toEqual(["replace_latest", "replace_latest"]);
    expect(submit.mock.calls[1]?.[1]).toEqual(expect.objectContaining({
      request: expect.objectContaining({ storyLengthProfileOverride: "extended", expectedCurrentTurnNumber: 1 })
    }));
    expect(confirm).toHaveBeenCalledTimes(2);
    mounted.dispose();
  });
  it("keeps interpretation controls for Action styles and hides them for Story Direction", async () => {
    const actionPage = fixture();
    const actionMounted = mountStoryPlayerPage(actionPage.root, { campaignId, turnNumber: 1 }, composition());
    await settle();
    expect([...actionPage.document.querySelectorAll<HTMLButtonElement>("[data-input-mode]")].map((button) => button.textContent))
      .toEqual(["Action"]);
    actionMounted.dispose();

    const flexiblePage = fixture();
    const flexibleMounted = mountStoryPlayerPage(flexiblePage.root, { campaignId, turnNumber: 1 }, composition({ turnControlStyle: "flexible_scene" }));
    await settle();
    expect(flexiblePage.document.querySelector("[data-story-input-modes]")).toBeNull();
    expect(flexiblePage.document.querySelector("[data-input-mode]")).toBeNull();
    flexibleMounted.dispose();
  });

  it("keeps duplicate generated choices independent and resets their provenance only on manual editing", async () => {
    const page = fixture();
    const mounted = mountStoryPlayerPage(page.root, { campaignId, turnNumber: 1 }, composition());
    await settle();
    const choices = [...page.document.querySelectorAll<HTMLButtonElement>("[data-story-choice]")];
    expect(choices).toHaveLength(2);
    choices[0]?.click();
    page.document.querySelectorAll<HTMLButtonElement>("[data-story-choice]")[1]?.click();
    expect([...page.document.querySelectorAll<HTMLButtonElement>("[data-story-choice]")].map((choice) => choice.getAttribute("aria-pressed"))).toEqual(["true", "true"]);
    expect(page.document.querySelector<HTMLTextAreaElement>("[data-story-draft]")?.value).toBe("Open the door\nOpen the door");

    enter(page, "Write something else.");
    expect([...page.document.querySelectorAll<HTMLButtonElement>("[data-story-choice]")].map((choice) => choice.getAttribute("aria-pressed")))
      .toEqual(["false", "false"]);
    expect(page.document.querySelector<HTMLTextAreaElement>("[data-story-draft]")?.value).toBe("Write something else.");
    mounted.dispose();
  });

  it("keeps the textarea mounted for consecutive input and updates the live character count", async () => {
    const page = fixture();
    const mounted = mountStoryPlayerPage(page.root, { campaignId, turnNumber: 1 }, composition());
    await settle();
    const textarea = page.document.querySelector<HTMLTextAreaElement>("[data-story-draft]");
    if (!textarea) throw new Error("Story composer textarea is missing.");

    textarea.value = "A";
    textarea.dispatchEvent(new page.window.Event("input", { bubbles: true }));
    expect(page.document.querySelector("[data-story-draft]")).toBe(textarea);
    textarea.value = "AB";
    textarea.dispatchEvent(new page.window.Event("input", { bubbles: true }));
    expect(page.document.querySelector("[data-story-draft]")).toBe(textarea);
    const count = page.document.querySelector<HTMLElement>("[data-story-character-count]");
    expect(count?.textContent).toBe("2 / 12,000");
    expect(count?.getAttribute("role")).toBe("status");
    expect(count?.getAttribute("aria-live")).toBe("polite");
    mounted.dispose();
  });

  it("moves the compact interpretation radio selection with Arrow, Home, and End keys", async () => {
    const page = fixture();
    const focus = vi.spyOn(page.window.HTMLElement.prototype, "focus");
    const mounted = mountStoryPlayerPage(page.root, { campaignId, turnNumber: 1 }, composition({ turnControlStyle: "flexible_action" }));
    await settle();
    const action = page.document.querySelector<HTMLButtonElement>("[data-input-mode='action']");
    if (!action) throw new Error("Action interpretation control is missing.");

    keydown(page, action, "End");
    const scene = page.document.querySelector<HTMLButtonElement>("[data-input-mode='scene']");
    expect(scene?.getAttribute("aria-checked")).toBe("true");
    if (!scene) throw new Error("Scene interpretation control is missing.");
    keydown(page, scene, "Home");
    expect(page.document.querySelector<HTMLButtonElement>("[data-input-mode='action']")?.getAttribute("aria-checked")).toBe("true");
    mounted.dispose();
  });

  it("rejects an over-limit choice atomically and announces the error", async () => {
    const page = fixture();
    const mounted = mountStoryPlayerPage(page.root, { campaignId, turnNumber: 1 }, composition());
    await settle();
    enter(page, "x".repeat(11_999));
    page.document.querySelector<HTMLButtonElement>("[data-story-choice]")?.click();
    expect(page.document.querySelector<HTMLTextAreaElement>("[data-story-draft]")?.value).toBe("x".repeat(11_999));
    expect(page.document.querySelector<HTMLButtonElement>("[data-story-choice]")?.getAttribute("aria-pressed")).toBe("false");
    expect(page.document.querySelector("[data-story-composer-status]")?.textContent).toContain("12,000");
    mounted.dispose();
  });

  it("clears text and choices before restoring textarea focus", async () => {
    const page = fixture();
    const focus = vi.spyOn(page.window.HTMLElement.prototype, "focus");
    const mounted = mountStoryPlayerPage(page.root, { campaignId, turnNumber: 1 }, composition());
    await settle();
    enter(page, "A cautiously ambiguous prompt.");
    page.document.querySelector<HTMLButtonElement>("[data-story-choice]")?.click();
    expect(page.document.querySelector<HTMLTextAreaElement>("[data-story-draft]")?.value).toBe("A cautiously ambiguous prompt.\nOpen the door");
    expect(page.document.querySelector<HTMLButtonElement>("[data-story-choice]")?.getAttribute("aria-pressed")).toBe("true");
    page.document.querySelector<HTMLButtonElement>("[data-action='clear-story-draft']")?.click();
    expect(page.document.querySelector<HTMLTextAreaElement>("[data-story-draft]")?.value).toBe("");
    expect(page.document.querySelector("[data-story-character-count]")?.textContent).toContain("0 / 12,000");
    expect(page.document.querySelector("[data-story-intent-confirmation]")).toBeNull();
    expect([...page.document.querySelectorAll<HTMLButtonElement>("[data-story-choice]")].map((choice) => choice.getAttribute("aria-pressed"))).toEqual(["false", "false"]);
    expect(focus.mock.instances).toContain(page.document.querySelector("[data-story-draft]"));
    mounted.dispose();
  });

  it("focuses empty drafts without classifying or invoking the injected test submission", async () => {
    const page = fixture();
    const focus = vi.spyOn(page.window.HTMLElement.prototype, "focus");
    const classifyTurnInput = vi.fn();
    const submit = vi.fn();
    const mounted = mountStoryPlayerPage(page.root, { campaignId, turnNumber: 1 }, composition({ turnControlStyle: "flexible_action", classifyTurnInput }), { onSubmit: submit });
    await settle();
    page.document.querySelector<HTMLButtonElement>("[data-action='continue-story']")?.click();
    expect(classifyTurnInput).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    expect(focus.mock.instances).toContain(page.document.querySelector("[data-story-draft]"));
    mounted.dispose();
  });

  it("treats onSubmit as a post-attachment observer, never as a durable-generation bypass", async () => {
    const page = fixture();
    const observer = vi.fn();
    const durableRun = deferred<unknown>();
    const base = composition();
    const prepared = {
      ...base,
      workflow: { submit: vi.fn(() => durableRun.promise), resume: vi.fn(async () => null) },
      idFactory: { create: () => "observer-idempotency-key" }
    } as StoryPlayerComposition;
    const mounted = mountStoryPlayerPage(page.root, { campaignId, turnNumber: 1 }, prepared, { onSubmit: observer });
    await settle();

    enter(page, "Open the observatory.");
    page.document.querySelector<HTMLButtonElement>("[data-action='continue-story']")?.click();
    await settle();
    expect(observer).not.toHaveBeenCalled();

    durableRun.resolve({
      campaignId,
      jobId: "55555555-5555-4555-8555-555555555555",
      operationKind: "append",
      replacementTurnId: null,
      async *watch() {}, async *retryGeneration() {},
      cancelGeneration: vi.fn(), discardGeneration: vi.fn(), fetchResult: vi.fn()
    });
    await settle();
    expect(observer).toHaveBeenCalledWith(expect.objectContaining({ action: "Open the observatory." }));
    mounted.dispose();
  });

  it("auto-submits a generated choice only when the user profile enables it", async () => {
    const disabledPage = fixture();
    const disabledSubmit = vi.fn();
    const disabledMounted = mountStoryPlayerPage(disabledPage.root, { campaignId, turnNumber: 1 }, composition(), { onSubmit: disabledSubmit });
    await settle();
    disabledPage.document.querySelector<HTMLButtonElement>("[data-story-choice]")?.click();
    expect(disabledSubmit).not.toHaveBeenCalled();
    disabledMounted.dispose();

    const enabledPage = fixture();
    const enabledSubmit = vi.fn();
    const enabledMounted = mountStoryPlayerPage(enabledPage.root, { campaignId, turnNumber: 1 }, composition({ autoSubmitTurnChoices: true }), { onSubmit: enabledSubmit });
    await settle();
    enabledPage.document.querySelector<HTMLButtonElement>("[data-story-choice]")?.click();
    await settle();
    expect(enabledSubmit).toHaveBeenCalledWith(expect.objectContaining({
      action: "Open the door", requestedInputMode: "action", resolvedInputMode: "action", inputModeSource: "explicit"
    }));
    enabledMounted.dispose();
  });

  it("submits direct actions without invoking a classifier", async () => {
    const page = fixture();
    const classifyTurnInput = vi.fn();
    const submit = vi.fn();
    const mounted = mountStoryPlayerPage(page.root, { campaignId, turnNumber: 1 }, composition({ turnControlStyle: "flexible_action", classifyTurnInput }), { onSubmit: submit });
    await settle();

    enter(page, "Open the observatory.");
    page.document.querySelector<HTMLButtonElement>("[data-action='continue-story']")?.click();
    await settle();

    expect(submit).toHaveBeenLastCalledWith(expect.objectContaining({
      action: "Open the observatory.", requestedInputMode: "action", resolvedInputMode: "action", inputModeSource: "explicit"
    }));
    expect(classifyTurnInput).not.toHaveBeenCalled();
    expect(page.document.querySelector("[data-story-intent-confirmation]")).toBeNull();
    mounted.dispose();
  });

  it("prepares an explicit Story Direction draft without provider interpretation", async () => {
    const prepare = submissionPreparer();
    expect(prepare).toEqual(expect.any(Function));
    if (!prepare) return;

    await expect(prepare("  Preserve my spacing.  ", "scene")).resolves.toEqual({
      kind: "ready",
      submission: {
        action: "  Preserve my spacing.  ",
        requestedInputMode: "scene",
        resolvedInputMode: "scene",
        inputModeSource: "explicit"
      }
    });
  });


});
