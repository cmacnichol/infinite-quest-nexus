import { parseHTML } from "linkedom";
import { createCampaignStore } from "../../packages/client-core/src/index.js";
import type { CampaignSyncStatus } from "../../packages/contracts/src/index.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StoryPlayerComposition } from "../../apps/web-next/src/story-player-composition.js";
import { mountStoryPlayerPage } from "../../apps/web-next/src/story-player-page.js";

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
    campaignStore: createCampaignStore(), workflow: {}, illustrations: {}, idFactory: {}, clock: {}, delay: {}
  } as unknown as StoryPlayerComposition;
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function enter(page: ReturnType<typeof fixture>, text: string): HTMLTextAreaElement {
  const textarea = page.document.querySelector<HTMLTextAreaElement>("[data-story-draft]");
  if (!textarea) throw new Error("Story composer textarea is missing.");
  textarea.value = text;
  textarea.dispatchEvent(new page.window.Event("input", { bubbles: true }));
  return textarea;
}

afterEach(() => vi.restoreAllMocks());

describe("Story continuation composer", () => {
  it("uses the campaign control style to render an action-only or flexible compact interpretation bar", async () => {
    const actionPage = fixture();
    const actionMounted = mountStoryPlayerPage(actionPage.root, { campaignId, turnNumber: 1 }, composition());
    await settle();
    expect([...actionPage.document.querySelectorAll<HTMLButtonElement>("[data-input-mode]")].map((button) => button.textContent))
      .toEqual(["Action"]);
    actionMounted.dispose();

    const flexiblePage = fixture();
    const flexibleMounted = mountStoryPlayerPage(flexiblePage.root, { campaignId, turnNumber: 1 }, composition({ turnControlStyle: "flexible_scene" }));
    await settle();
    expect([...flexiblePage.document.querySelectorAll<HTMLButtonElement>("[data-input-mode]")].map((button) => [button.textContent, button.getAttribute("aria-checked")]))
      .toEqual([["Auto", "false"], ["Action", "false"], ["Scene Direction", "true"]]);
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

  it("clears text, choices, and an intent decision before restoring textarea focus", async () => {
    const page = fixture();
    const focus = vi.spyOn(page.window.HTMLElement.prototype, "focus");
    const mounted = mountStoryPlayerPage(page.root, { campaignId, turnNumber: 1 }, composition({ turnControlStyle: "flexible_auto" }));
    await settle();
    enter(page, "A cautiously ambiguous prompt.");
    page.document.querySelector<HTMLButtonElement>("[data-input-mode='auto']")?.click();
    page.document.querySelector<HTMLButtonElement>("[data-action='continue-story']")?.click();
    await settle();
    page.document.querySelector<HTMLButtonElement>("[data-action='clear-story-draft']")?.click();
    expect(page.document.querySelector<HTMLTextAreaElement>("[data-story-draft]")?.value).toBe("");
    expect(page.document.querySelector("[data-story-character-count]")?.textContent).toContain("0 / 12,000");
    expect(page.document.querySelector("[data-story-intent-confirmation]")).toBeNull();
    expect(focus.mock.instances).toContain(page.document.querySelector("[data-story-draft]"));
    mounted.dispose();
  });

  it("focuses empty drafts without classifying or invoking the injected test submission", async () => {
    const page = fixture();
    const focus = vi.spyOn(page.window.HTMLElement.prototype, "focus");
    const classifyTurnInput = vi.fn();
    const submit = vi.fn();
    const mounted = mountStoryPlayerPage(page.root, { campaignId, turnNumber: 1 }, composition({ turnControlStyle: "flexible_auto", classifyTurnInput }), { onSubmit: submit });
    await settle();
    page.document.querySelector<HTMLButtonElement>("[data-action='continue-story']")?.click();
    expect(classifyTurnInput).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    expect(focus.mock.instances).toContain(page.document.querySelector("[data-story-draft]"));
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

  it("submits clear Auto results directly and keeps ambiguous classifications for explicit confirmation", async () => {
    const page = fixture();
    const classifyTurnInput = vi.fn()
      .mockResolvedValueOnce({ classificationId: "77777777-7777-4777-8777-777777777777", classification: "action", resolvedMode: "action", confidenceBand: "clear", providerSource: "story_text", expiresAt: "2026-08-18T00:01:00.000Z" })
      .mockResolvedValueOnce({ classificationId: "88888888-8888-4888-8888-888888888888", classification: "mixed", resolvedMode: "scene", confidenceBand: "ambiguous", providerSource: "story_text", expiresAt: "2026-08-18T00:01:00.000Z" });
    const submit = vi.fn();
    const mounted = mountStoryPlayerPage(page.root, { campaignId, turnNumber: 1 }, composition({ turnControlStyle: "flexible_auto", classifyTurnInput }), { onSubmit: submit });
    await settle();

    enter(page, "Open the observatory.");
    page.document.querySelector<HTMLButtonElement>("[data-action='continue-story']")?.click();
    await settle();
    expect(submit).toHaveBeenLastCalledWith(expect.objectContaining({ action: "Open the observatory.", requestedInputMode: "auto", resolvedInputMode: "action", classificationId: "77777777-7777-4777-8777-777777777777" }));

    enter(page, "Perhaps describe what changes.");
    page.document.querySelector<HTMLButtonElement>("[data-action='continue-story']")?.click();
    await settle();
    expect(page.document.querySelector("[data-story-intent-confirmation]")?.textContent).toContain("Perhaps describe what changes.");
    page.document.querySelector<HTMLButtonElement>("[data-action='confirm-intent-scene']")?.click();
    expect(submit).toHaveBeenLastCalledWith(expect.objectContaining({ action: "Perhaps describe what changes.", requestedInputMode: "auto", resolvedInputMode: "scene", classificationId: "88888888-8888-4888-8888-888888888888" }));
    expect(classifyTurnInput).toHaveBeenCalledTimes(2);
    mounted.dispose();
  });
});
