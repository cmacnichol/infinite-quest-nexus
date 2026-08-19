import { readFileSync } from "node:fs";
import { parseHTML } from "linkedom";
import { createCampaignStore, type CampaignStoreController } from "../../packages/client-core/src/index.js";
import type { CampaignRuntimeStateResponse, CampaignSyncStatus } from "../../packages/contracts/src/index.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StoryPlayerComposition } from "../../apps/web-next/src/story-player-composition.js";
import { mountStoryPlayerPage } from "../../apps/web-next/src/story-player-page.js";

const campaignId = "11111111-1111-4111-8111-111111111111";
const worldVersionId = "22222222-2222-4222-8222-222222222222";

function campaignSummary(overrides: Record<string, unknown> = {}) {
  return {
    id: campaignId,
    title: "Campaign under test",
    status: "active",
    activeTurnNumber: 0,
    createdAt: "2026-08-18T00:00:00.000Z",
    updatedAt: "2026-08-18T00:00:00.000Z",
    storyLengthProfile: "standard",
    turnControlStyle: "action_only",
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
    costInformation: [],
    ...overrides
  };
}

function sync(overrides: Record<string, unknown> = {}): CampaignSyncStatus {
  const campaign = {
    id: campaignId,
    title: "Campaign under test",
    activeTurnNumber: 0,
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
      rpgStats: [],
      trackers: [],
      eventTriggers: [],
      useRpgStats: false,
      suppressEventTriggers: false
    },
    pendingGeneration: null,
    generationRecovery: null,
    syncToken: "sync-test",
    turnWindowMode: "replace",
    turns: { campaignId, turns: [], nextCursor: null },
    ...overrides
  } as CampaignSyncStatus;
}

function historicalState(turnNumber: number, continuitySummary: string): CampaignRuntimeStateResponse {
  return {
    campaignId,
    activeTurnNumber: 7,
    viewedTurnNumber: turnNumber,
    isCurrent: turnNumber === 7,
    revision: 4,
    updatedAt: "2026-08-18T00:00:00.000Z",
    continuitySummary,
    openThreads: ["Find the observatory."],
    canonicalFacts: [],
    scratchpad: "Private campaign scratchpad.",
    trackers: [],
    rpgStats: [{ id: "courage", name: "Courage", value: 8, note: "Inspector-only mechanics." }],
    eventTriggers: [],
    pendingEventTriggers: []
  };
}

function turnWindow(turnNumbers: readonly number[]) {
  return {
    campaignId,
    nextCursor: null,
    turns: turnNumbers.map((turnNumber) => ({
      id: `00000000-0000-4000-8000-${String(turnNumber).padStart(12, "0")}`,
      turnNumber,
      action: `Action ${turnNumber}`,
      inputMode: "action" as const,
      inputModeSource: "explicit" as const,
      narration: `Narration ${turnNumber}.`,
      choices: [],
      customActionSuggestion: "",
      imagePrompt: "",
      imageUrl: null,
      acceptedAt: "2026-08-18T00:00:00.000Z",
      chronicleRetrieval: null,
      reportedCost: null
    }))
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => { resolve = nextResolve; reject = nextReject; });
  return { promise, resolve, reject };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function fixture() {
  const { document, window } = parseHTML("<body><div id=app></div></body>");
  const root = document.querySelector<HTMLElement>("#app");
  if (!root) throw new Error("Story fixture root is missing.");
  return { document, window, root };
}

function composition(options: {
  readonly list?: ReturnType<typeof vi.fn>;
  readonly syncStatus?: ReturnType<typeof vi.fn>;
  readonly turns?: ReturnType<typeof vi.fn>;
  readonly state?: ReturnType<typeof vi.fn>;
  readonly session?: ReturnType<typeof vi.fn>;
  readonly campaignStore?: CampaignStoreController;
} = {}): StoryPlayerComposition {
  const campaignStore = options.campaignStore ?? createCampaignStore();
  return {
    api: {
      campaigns: {
        list: options.list ?? vi.fn().mockResolvedValue({ campaigns: [campaignSummary()] }),
        turns: options.turns ?? vi.fn(),
        state: options.state ?? vi.fn()
      },
      generation: { syncStatus: options.syncStatus ?? vi.fn().mockResolvedValue(sync()) }
      ,session: { get: options.session }
    },
    campaignStore,
    workflow: {},
    illustrations: {},
    idFactory: {},
    clock: {},
    delay: {}
  } as unknown as StoryPlayerComposition;
}

afterEach(() => vi.restoreAllMocks());

describe("Story Player page shell", () => {
  it("loads the chooser through the campaign API and keeps reader-first source order", async () => {
    const page = fixture();
    const list = vi.fn().mockResolvedValue({ campaigns: [campaignSummary()] });
    const mounted = mountStoryPlayerPage(page.root, { campaignId: null, turnNumber: null }, composition({ list }));
    await settle();

    expect(list).toHaveBeenCalledTimes(1);
    const main = page.document.querySelector<HTMLElement>('main[data-page="story-player"]');
    expect(main?.getAttribute("aria-busy")).toBe("false");
    expect([...main?.querySelectorAll(":scope > *") ?? []].map((element) => element.className)).toEqual([
      "story-command-row",
      "story-foldout"
    ]);
    expect([...main?.querySelectorAll(":scope > .story-foldout > *") ?? []].map((element) => element.className)).toEqual([
      "story-reader",
      "story-campaign-spine",
      "story-illustration-wing"
    ]);
    expect(main?.querySelector("aside.story-campaign-spine")?.getAttribute("aria-label")).toBe("Campaign spine");
    expect(main?.querySelector("aside.story-illustration-wing")?.getAttribute("aria-label")).toBe("Current turn illustration");
    const styles = readFileSync(new URL("../../apps/web-next/src/story-player.css", import.meta.url), "utf8");
    expect(styles).toMatch(/@media \(min-width: 900px\) \{[\s\S]*grid-template-areas: "spine reader illustration";/u);
    expect(styles).toMatch(/:focus-visible/u);
    expect(styles).toMatch(/var\(--focus-ring/u);
    mounted.dispose();
  });

  it("announces loading and offers Retry for unavailable or missing campaigns", async () => {
    const page = fixture();
    const pending = deferred<CampaignSyncStatus>();
    const syncStatus = vi.fn(() => pending.promise);
    const mounted = mountStoryPlayerPage(page.root, { campaignId, turnNumber: null }, composition({ syncStatus }));

    const main = page.document.querySelector<HTMLElement>('main[data-page="story-player"]');
    expect(main?.getAttribute("aria-busy")).toBe("true");
    expect(page.document.querySelector('[data-story-status][role="status"]')?.textContent).toContain("Loading");

    pending.reject(Object.assign(new Error("missing"), { status: 404 }));
    await settle();
    expect(page.document.querySelector("[data-story-error]")?.textContent).toContain("not found");
    const retry = page.document.querySelector<HTMLButtonElement>('[data-action="retry-story"]');
    expect(retry?.textContent).toContain("Retry");
    retry?.click();
    expect(syncStatus).toHaveBeenCalledTimes(2);
    mounted.dispose();
  });

  it("uses zero-turn world data, blocks Begin Story while active, and bounds setup recovery", async () => {
    const page = fixture();
    const active = sync({
      pendingGeneration: {
        id: "55555555-5555-4555-8555-555555555555",
        status: "generating",
        action: "Continue",
        expectedTurnNumber: 1,
        createdAt: "2026-08-18T00:00:00.000Z",
        updatedAt: "2026-08-18T00:00:00.000Z",
        operationKind: "append",
        replacementTurnId: null
      }
    });
    const mounted = mountStoryPlayerPage(page.root, { campaignId, turnNumber: null }, composition({
      list: vi.fn().mockResolvedValue({ campaigns: [campaignSummary({ textProviderProfileId: null })] }),
      syncStatus: vi.fn().mockResolvedValue(active)
    }));
    await settle();

    expect(page.document.querySelector("[data-story-background]")?.textContent).toContain("A real world background.");
    expect(page.document.querySelector("[data-first-action]")?.textContent).toContain("Take the real first action.");
    expect(page.document.querySelector<HTMLButtonElement>('[data-action="begin-story"]')?.disabled).toBe(true);
    expect(page.document.querySelector<HTMLAnchorElement>('[data-story-setup]')?.getAttribute("href")).toBe("/nexus/#providers");
    mounted.dispose();
  });

  it("renders accepted narration without mechanics and exposes recovery as a bounded state", async () => {
    const page = fixture();
    const loaded = sync({
      campaign: { ...sync().campaign, activeTurnNumber: 1 },
      activeTurnNumber: 1,
      generationRecovery: {
        id: "55555555-5555-4555-8555-555555555555",
        status: "recoverable",
        expectedTurnNumber: 2,
        attempts: 1,
        errorCode: "generation_failed",
        errorMessage: "Story generation could not be completed.",
        resultTurnId: null,
        operationKind: "append",
        replacementTurnId: null
      },
      turns: {
        campaignId,
        nextCursor: null,
        turns: [{
          id: "66666666-6666-4666-8666-666666666666",
          turnNumber: 1,
          action: "Proceed.",
          inputMode: "action",
          inputModeSource: "explicit",
          narration: "The tested story continues.",
          choices: [],
          customActionSuggestion: "",
          imagePrompt: "",
          imageUrl: null,
          acceptedAt: "2026-08-18T00:00:00.000Z",
          chronicleRetrieval: null,
          reportedCost: null
        }]
      }
    });
    const mounted = mountStoryPlayerPage(page.root, { campaignId, turnNumber: 1 }, composition({
      syncStatus: vi.fn().mockResolvedValue(loaded)
    }));
    await settle();

    const reader = page.document.querySelector("[data-story-reader]");
    expect(reader?.textContent).toContain("The tested story continues.");
    expect(reader?.textContent).not.toMatch(/Resolve Check|mechanics|difficulty/i);
    expect(page.document.querySelector('[data-story-recovery]')?.textContent).toContain("Try again");
    mounted.dispose();
  });

  it("renders a text-safe foldout reader from the campaign projection without normal-leaf mechanics", async () => {
    const page = fixture();
    const loaded = sync({
      campaign: { ...sync().campaign, activeTurnNumber: 5 },
      activeTurnNumber: 5,
      turns: {
        campaignId,
        nextCursor: null,
        turns: [{
          id: "66666666-6666-4666-8666-666666666666",
          turnNumber: 5,
          action: "Cross the flooded bridge.",
          inputMode: "action",
          inputModeSource: "explicit",
          narration: "<script>window.alert('unsafe')</script>\n\nThe corrected current narration remains fiction.",
          choices: [],
          customActionSuggestion: "",
          imagePrompt: "",
          imageUrl: null,
          acceptedAt: "2026-08-18T00:00:00.000Z",
          chronicleRetrieval: null,
          reportedCost: { amount: "0.0123", currency: "USD", byCategory: { story: "0.0123", image: "0", memory: "0" } }
        }]
      }
    });
    const mounted = mountStoryPlayerPage(page.root, { campaignId, turnNumber: 5 }, composition({
      list: vi.fn().mockResolvedValue({ campaigns: [campaignSummary({ activeTurnNumber: 5 })] }),
      syncStatus: vi.fn().mockResolvedValue(loaded)
    }));
    await settle();

    const commandRow = page.document.querySelector(".story-command-row");
    expect(commandRow?.textContent).toContain("Campaign under test");
    expect(commandRow?.textContent).toContain("World under test · Version 1");
    expect(commandRow?.textContent).toContain("Active turn 5");
    expect(commandRow?.textContent).toContain("Viewing latest turn");
    expect(commandRow?.textContent).toContain("Story Engine ready");

    const leaf = page.document.querySelector("[data-story-leaf]");
    expect(leaf?.querySelector("h1")?.textContent).toBe("Turn 5");
    expect(leaf?.textContent).toContain("Cross the flooded bridge.");
    expect(leaf?.textContent).toContain("0.0123 USD");
    expect([...leaf?.querySelectorAll(".story-narration") ?? []].map((paragraph) => paragraph.textContent)).toEqual([
      "<script>window.alert('unsafe')</script>",
      "The corrected current narration remains fiction."
    ]);
    expect(leaf?.querySelector("script")).toBeNull();
    expect(leaf?.textContent).toContain("Edit Response");
    expect(leaf?.textContent).toContain("Inspect State");
    expect(leaf?.textContent).not.toMatch(/Resolve Check|mechanics|difficulty/i);
    mounted.dispose();
  });

  it("reports the resolved rendered turn when a deep-linked persisted turn is outside the loaded window", async () => {
    const page = fixture();
    const loaded = sync({
      campaign: { ...sync().campaign, activeTurnNumber: 9 },
      activeTurnNumber: 9,
      turns: {
        campaignId,
        nextCursor: "older-turns-available",
        turns: [{
          id: "88888888-8888-4888-8888-888888888888",
          turnNumber: 9,
          action: "Resume the latest scene.",
          inputMode: "action",
          inputModeSource: "explicit",
          narration: "The loaded latest turn remains readable.",
          choices: [],
          customActionSuggestion: "",
          imagePrompt: "",
          imageUrl: null,
          acceptedAt: "2026-08-18T00:00:00.000Z",
          chronicleRetrieval: null,
          reportedCost: null
        }]
      }
    });
    const mounted = mountStoryPlayerPage(page.root, { campaignId, turnNumber: 2 }, composition({
      list: vi.fn().mockResolvedValue({ campaigns: [campaignSummary({ activeTurnNumber: 9 })] }),
      syncStatus: vi.fn().mockResolvedValue(loaded)
    }));
    await settle();

    expect(page.document.querySelector("[data-story-leaf] h1")?.textContent).toBe("Turn 9");
    expect(page.document.querySelector(".story-command-row")?.textContent).toContain("Viewing latest turn");
    expect(page.document.querySelector(".story-command-row")?.textContent).not.toContain("Viewing turn 2 of 9");
    mounted.dispose();
  });

  it("renders labelled local width controls and persisted-number reader navigation", async () => {
    const page = fixture();
    const loaded = sync({
      campaign: { ...sync().campaign, activeTurnNumber: 9 },
      activeTurnNumber: 9,
      pendingGeneration: {
        id: "55555555-5555-4555-8555-555555555555",
        status: "generating",
        action: "Continue",
        expectedTurnNumber: 10,
        createdAt: "2026-08-18T00:00:00.000Z",
        updatedAt: "2026-08-18T00:00:00.000Z",
        operationKind: "append",
        replacementTurnId: null
      },
      turns: {
        campaignId,
        nextCursor: null,
        turns: [2, 4, 9].map((turnNumber) => ({
          id: turnNumber === 2
            ? "66666666-6666-4666-8666-666666666666"
            : turnNumber === 4 ? "77777777-7777-4777-8777-777777777777" : "88888888-8888-4888-8888-888888888888",
          turnNumber,
          action: `Action ${turnNumber}`,
          inputMode: "action" as const,
          inputModeSource: "explicit" as const,
          narration: `Narration ${turnNumber}.`,
          choices: [],
          customActionSuggestion: "",
          imagePrompt: "",
          imageUrl: null,
          acceptedAt: "2026-08-18T00:00:00.000Z",
          chronicleRetrieval: null,
          reportedCost: null
        }))
      }
    });
    const mounted = mountStoryPlayerPage(page.root, { campaignId, turnNumber: 4 }, composition({
      list: vi.fn().mockResolvedValue({ campaigns: [campaignSummary({ activeTurnNumber: 9 })] }),
      syncStatus: vi.fn().mockResolvedValue(loaded)
    }));
    await settle();

    const controls = page.document.querySelector("[aria-label=\"Reading width\"]");
    expect(controls?.getAttribute("role")).toBe("group");
    expect([...controls?.querySelectorAll<HTMLButtonElement>("button") ?? []].map((button) => [button.textContent, button.getAttribute("aria-pressed")]))
      .toEqual([["Narrow", "false"], ["Standard", "true"], ["Wide", "false"]]);
    expect(page.document.querySelector<HTMLElement>(".story-foldout")?.dataset.readingWidth).toBe("standard");

    const previous = page.document.querySelector<HTMLButtonElement>('[data-action="previous-turn"]');
    const next = page.document.querySelector<HTMLButtonElement>('[data-action="next-turn"]');
    expect(previous?.dataset.turnNumber).toBe("2");
    expect(next?.dataset.turnNumber).toBe("9");
    expect(previous?.disabled).toBe(true);
    expect(next?.disabled).toBe(true);

    const focus = vi.spyOn(page.window.HTMLElement.prototype, "focus");
    page.document.querySelector<HTMLButtonElement>('[data-reading-width="wide"]')?.click();
    expect(page.document.querySelector<HTMLElement>(".story-foldout")?.dataset.readingWidth).toBe("wide");
    expect(page.document.querySelector<HTMLButtonElement>('[data-reading-width="wide"]')?.getAttribute("aria-pressed")).toBe("true");
    expect(page.document.querySelector("[data-reading-width-status]")?.textContent).toBe("Reading width set to Wide.");
    expect(focus).toHaveBeenCalledTimes(1);
    mounted.dispose();
  });

  it("renders the latest five persisted spine turns without falsely marking an older view current", async () => {
    const page = fixture();
    const loaded = sync({
      campaign: { ...sync().campaign, activeTurnNumber: 9 },
      activeTurnNumber: 9,
      turns: {
        campaignId,
        nextCursor: null,
        turns: Array.from({ length: 9 }, (_, index) => ({
          id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
          turnNumber: index + 1,
          action: `Action ${index + 1}`,
          inputMode: "action" as const,
          inputModeSource: "explicit" as const,
          narration: `Narration ${index + 1}.`,
          choices: [], customActionSuggestion: "", imagePrompt: "", imageUrl: null,
          acceptedAt: "2026-08-18T00:00:00.000Z", chronicleRetrieval: null, reportedCost: null
        }))
      }
    });
    const mounted = mountStoryPlayerPage(page.root, { campaignId, turnNumber: 2 }, composition({
      list: vi.fn().mockResolvedValue({ campaigns: [campaignSummary({ activeTurnNumber: 9 })] }),
      syncStatus: vi.fn().mockResolvedValue(loaded)
    }));
    await settle();

    const spine = page.document.querySelector(".story-campaign-spine");
    expect([...spine?.querySelectorAll<HTMLButtonElement>("[data-turn-number]") ?? []].map((button) => button.dataset.turnNumber))
      .toEqual(["5", "6", "7", "8", "9"]);
    expect(spine?.querySelector("[aria-current='step']")).toBeNull();
    page.document.querySelector<HTMLButtonElement>("[data-turn-number='5']")?.click();
    expect(page.document.querySelector("[data-story-leaf] h1")?.textContent).toBe("Turn 5");
    expect(spine?.querySelector("[aria-current='step']")?.getAttribute("data-turn-number")).toBe("5");
    mounted.dispose();
  });

  it("loads a cursor page before reader Previous crosses the bounded window", async () => {
    const page = fixture();
    const loaded = sync({
      campaign: { ...sync().campaign, activeTurnNumber: 7 }, activeTurnNumber: 7,
      turns: {
        campaignId, nextCursor: "before-6",
        turns: [6, 7].map((turnNumber) => ({
          id: `00000000-0000-4000-8000-${String(turnNumber).padStart(12, "0")}`,
          turnNumber, action: `Action ${turnNumber}`, inputMode: "action" as const, inputModeSource: "explicit" as const,
          narration: `Narration ${turnNumber}.`, choices: [], customActionSuggestion: "", imagePrompt: "", imageUrl: null,
          acceptedAt: "2026-08-18T00:00:00.000Z", chronicleRetrieval: null, reportedCost: null
        }))
      }
    });
    const turns = vi.fn().mockResolvedValue({
      campaignId, nextCursor: null,
      turns: [4, 5].map((turnNumber) => ({
        id: `00000000-0000-4000-8000-${String(turnNumber).padStart(12, "0")}`,
        turnNumber, action: `Action ${turnNumber}`, inputMode: "action" as const, inputModeSource: "explicit" as const,
        narration: `Narration ${turnNumber}.`, choices: [], customActionSuggestion: "", imagePrompt: "", imageUrl: null,
        acceptedAt: "2026-08-18T00:00:00.000Z", chronicleRetrieval: null, reportedCost: null
      }))
    });
    const mounted = mountStoryPlayerPage(page.root, { campaignId, turnNumber: 6 }, composition({
      list: vi.fn().mockResolvedValue({ campaigns: [campaignSummary({ activeTurnNumber: 7 })] }), syncStatus: vi.fn().mockResolvedValue(loaded), turns
    }));
    await settle();
    page.document.querySelector<HTMLButtonElement>("[data-action='previous-turn']")?.click();
    await settle();

    expect(turns).toHaveBeenCalledWith(campaignId, { before: "before-6", limit: 200 }, undefined);
    expect(page.document.querySelector("[data-story-leaf] h1")?.textContent).toBe("Turn 5");
    mounted.dispose();
  });

  it("moves reader Previous exactly one loaded persisted turn", async () => {
    const page = fixture();
    const loaded = sync({
      campaign: { ...sync().campaign, activeTurnNumber: 8 },
      activeTurnNumber: 8,
      turns: turnWindow([6, 7, 8])
    });
    const mounted = mountStoryPlayerPage(page.root, { campaignId, turnNumber: 8 }, composition({
      list: vi.fn().mockResolvedValue({ campaigns: [campaignSummary({ activeTurnNumber: 8 })] }),
      syncStatus: vi.fn().mockResolvedValue(loaded)
    }));
    await settle();

    page.document.querySelector<HTMLButtonElement>("[data-story-reader] [data-action='previous-turn']")?.click();
    await settle();

    expect(page.document.querySelector("[data-story-leaf] h1")?.textContent).toBe("Turn 7");
    mounted.dispose();
  });

  it("moves reader Next exactly one loaded persisted turn", async () => {
    const page = fixture();
    const loaded = sync({
      campaign: { ...sync().campaign, activeTurnNumber: 8 },
      activeTurnNumber: 8,
      turns: turnWindow([6, 7, 8])
    });
    const mounted = mountStoryPlayerPage(page.root, { campaignId, turnNumber: 6 }, composition({
      list: vi.fn().mockResolvedValue({ campaigns: [campaignSummary({ activeTurnNumber: 8 })] }),
      syncStatus: vi.fn().mockResolvedValue(loaded)
    }));
    await settle();

    page.document.querySelector<HTMLButtonElement>("[data-story-reader] [data-action='next-turn']")?.click();
    await settle();

    expect(page.document.querySelector("[data-story-leaf] h1")?.textContent).toBe("Turn 7");
    mounted.dispose();
  });

  it("opens complete history as a retryable dialog without discarding the bounded reader on failure", async () => {
    const page = fixture();
    const loaded = sync({
      campaign: { ...sync().campaign, activeTurnNumber: 7 }, activeTurnNumber: 7,
      turns: { campaignId, nextCursor: "before-6", turns: [6, 7].map((turnNumber) => ({
        id: `00000000-0000-4000-8000-${String(turnNumber).padStart(12, "0")}`,
        turnNumber, action: `Action ${turnNumber}`, inputMode: "action" as const, inputModeSource: "explicit" as const,
        narration: `Narration ${turnNumber}.`, choices: [], customActionSuggestion: "", imagePrompt: "", imageUrl: null,
        acceptedAt: "2026-08-18T00:00:00.000Z", chronicleRetrieval: null, reportedCost: null
      })) }
    });
    const turns = vi.fn().mockRejectedValue(new Error("history unavailable"));
    const mounted = mountStoryPlayerPage(page.root, { campaignId, turnNumber: 7 }, composition({
      list: vi.fn().mockResolvedValue({ campaigns: [campaignSummary({ activeTurnNumber: 7 })] }), syncStatus: vi.fn().mockResolvedValue(loaded), turns
    }));
    await settle();
    page.document.querySelector<HTMLButtonElement>("[data-action='open-complete-history']")?.click();
    await settle();

    const dialog = page.document.querySelector<HTMLElement>("[data-story-history]");
    expect(dialog?.hasAttribute("open")).toBe(true);
    expect(dialog?.textContent).toContain("History unavailable");
    expect(page.document.querySelector("[data-story-leaf] h1")?.textContent).toBe("Turn 7");
    expect(page.document.querySelector<HTMLButtonElement>("[data-action='retry-complete-history']")).toBeTruthy();
    mounted.dispose();
  });

  it("runs selected History actions, isolates inspected state, and restores focus to the live opener", async () => {
    const page = fixture();
    const loaded = sync({
      campaign: { ...sync().campaign, activeTurnNumber: 7 }, activeTurnNumber: 7,
      turns: { campaignId, nextCursor: null, turns: [6, 7].map((turnNumber) => ({
        id: `00000000-0000-4000-8000-${String(turnNumber).padStart(12, "0")}`,
        turnNumber, action: `Action ${turnNumber}`, inputMode: "action" as const, inputModeSource: "explicit" as const,
        narration: `Narration ${turnNumber}.`, choices: [], customActionSuggestion: "", imagePrompt: "", imageUrl: null,
        acceptedAt: "2026-08-18T00:00:00.000Z", chronicleRetrieval: null, reportedCost: null
      })) }
    });
    const inspectedState = historicalState(6, "Archived continuity for turn six.");
    const state = vi.fn().mockResolvedValue(inspectedState);
    const confirm = vi.fn().mockReturnValue(false);
    Object.defineProperty(page.window, "confirm", { configurable: true, value: confirm });
    const focus = vi.spyOn(page.window.HTMLElement.prototype, "focus");
    const mounted = mountStoryPlayerPage(page.root, { campaignId, turnNumber: 7 }, composition({
      list: vi.fn().mockResolvedValue({ campaigns: [campaignSummary({ activeTurnNumber: 7 })] }), syncStatus: vi.fn().mockResolvedValue(loaded), state
    }));
    await settle();
    const opener = page.document.querySelector<HTMLButtonElement>("[data-action='open-complete-history']");
    opener?.click();
    await settle();

    let dialog = page.document.querySelector<HTMLDialogElement>("[data-story-history]");
    expect(dialog?.querySelector("[data-action='jump-to-scene']")?.textContent).toContain("Jump to Scene");
    expect(dialog?.querySelector("[data-action='restart-from-turn']")?.textContent).toContain("Restart / Branch from Here");
    const jump = dialog?.querySelector<HTMLButtonElement>("[data-action='jump-to-scene']");
    if (jump) jump.dataset.turnNumber = "6";
    jump?.click();
    await settle();
    expect(page.document.querySelector("[data-story-leaf] h1")?.textContent).toBe("Turn 6");
    expect(page.document.querySelector("[data-story-history]")).toBeNull();
    const liveOpener = page.document.querySelector<HTMLButtonElement>("[data-action='open-complete-history']");
    expect(liveOpener).not.toBe(opener);
    expect(focus.mock.instances).toContain(liveOpener);

    liveOpener?.click();
    await settle();
    dialog = page.document.querySelector<HTMLDialogElement>("[data-story-history]");
    const historyTitle = dialog?.querySelector<HTMLHeadingElement>("h2");
    expect(historyTitle?.id).toBeTruthy();
    expect(dialog?.getAttribute("aria-labelledby")).toBe(historyTitle?.id);
    expect(focus.mock.instances).toContain(dialog?.querySelector("button"));
    dialog?.querySelector<HTMLButtonElement>("[data-action='inspect-state']")?.click();
    await settle();
    expect(state).toHaveBeenCalledWith(campaignId, 6, undefined);
    expect(page.document.querySelector("[data-story-state-inspector]")?.textContent).toContain("Archived continuity for turn six.");
    expect(page.document.querySelector("[data-story-reader]")?.textContent).not.toContain("Archived continuity for turn six.");
    expect(page.document.querySelector(".story-campaign-spine")?.textContent).not.toContain("Archived continuity for turn six.");

    dialog = page.document.querySelector<HTMLDialogElement>("[data-story-history]");
    dialog?.querySelector<HTMLButtonElement>("[data-action='restart-from-turn']")?.click();
    expect(confirm).toHaveBeenCalledWith("Restart or branch from persisted Turn 6?");

    const controls = [...dialog?.querySelectorAll<HTMLButtonElement>("button") ?? []];
    const firstControl = controls[0];
    const lastControl = controls.at(-1);
    const firstFocus = firstControl && vi.spyOn(firstControl, "focus");
    lastControl?.focus();
    firstFocus?.mockClear();
    const tab = new page.window.Event("keydown", { bubbles: true, cancelable: true });
    Object.defineProperty(tab, "key", { value: "Tab" });
    Object.defineProperty(tab, "shiftKey", { value: false });
    lastControl?.dispatchEvent(tab);
    expect(firstFocus).toHaveBeenCalled();

    dialog?.dispatchEvent(new page.window.Event("cancel", { cancelable: true }));
    expect(page.document.querySelector("[data-story-history]")).toBeNull();
    expect(focus.mock.instances).toContain(page.document.querySelector("[data-action='open-complete-history']"));
    mounted.dispose();
  });

  it("opens the isolated History inspector from the normal reader without leaking mechanics into the leaf", async () => {
    const page = fixture();
    const loaded = sync({
      campaign: { ...sync().campaign, activeTurnNumber: 7 }, activeTurnNumber: 7,
      turns: { campaignId, nextCursor: null, turns: [6, 7].map((turnNumber) => ({
        id: `00000000-0000-4000-8000-${String(turnNumber).padStart(12, "0")}`,
        turnNumber, action: `Action ${turnNumber}`, inputMode: "action" as const, inputModeSource: "explicit" as const,
        narration: `Narration ${turnNumber}.`, choices: [], customActionSuggestion: "", imagePrompt: "", imageUrl: null,
        acceptedAt: "2026-08-18T00:00:00.000Z", chronicleRetrieval: null, reportedCost: null
      })) }
    });
    const state = vi.fn().mockResolvedValue(historicalState(6, "Reader inspection is dialog-only."));
    const mounted = mountStoryPlayerPage(page.root, { campaignId, turnNumber: 6 }, composition({
      list: vi.fn().mockResolvedValue({ campaigns: [campaignSummary({ activeTurnNumber: 7 })] }), syncStatus: vi.fn().mockResolvedValue(loaded), state
    }));
    await settle();

    page.document.querySelector<HTMLButtonElement>("[data-story-reader] [data-action='inspect-state']")?.click();
    await settle();

    expect(state).toHaveBeenCalledWith(campaignId, 6, undefined);
    expect(page.document.querySelector("[data-story-history]")).toBeTruthy();
    expect(page.document.querySelector("[data-story-state-inspector]")?.textContent).toContain("Reader inspection is dialog-only.");
    expect(page.document.querySelector("[data-story-reader]")?.textContent).not.toContain("Reader inspection is dialog-only.");
    expect(page.document.querySelector("[data-story-reader]")?.textContent).not.toContain("Inspector-only mechanics.");
    expect(page.document.querySelector(".story-campaign-spine")?.textContent).not.toContain("Inspector-only mechanics.");
    mounted.dispose();
  });

  it("keeps the newest selected inspection when an older response arrives last", async () => {
    const page = fixture();
    const loaded = sync({
      campaign: { ...sync().campaign, activeTurnNumber: 7 }, activeTurnNumber: 7,
      turns: { campaignId, nextCursor: null, turns: [6, 7].map((turnNumber) => ({
        id: `00000000-0000-4000-8000-${String(turnNumber).padStart(12, "0")}`,
        turnNumber, action: `Action ${turnNumber}`, inputMode: "action" as const, inputModeSource: "explicit" as const,
        narration: `Narration ${turnNumber}.`, choices: [], customActionSuggestion: "", imagePrompt: "", imageUrl: null,
        acceptedAt: "2026-08-18T00:00:00.000Z", chronicleRetrieval: null, reportedCost: null
      })) }
    });
    const older = deferred<CampaignRuntimeStateResponse | null>();
    const newer = deferred<CampaignRuntimeStateResponse | null>();
    const state = vi.fn().mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    const mounted = mountStoryPlayerPage(page.root, { campaignId, turnNumber: 6 }, composition({
      list: vi.fn().mockResolvedValue({ campaigns: [campaignSummary({ activeTurnNumber: 7 })] }), syncStatus: vi.fn().mockResolvedValue(loaded), state
    }));
    await settle();

    page.document.querySelector<HTMLButtonElement>("[data-action='open-complete-history']")?.click();
    await settle();
    page.document.querySelector<HTMLButtonElement>("[data-story-history] [data-action='inspect-state']")?.click();
    await settle();
    page.document.querySelector<HTMLButtonElement>("[data-story-history] [data-turn-number='7']")?.click();
    await settle();
    page.document.querySelector<HTMLButtonElement>("[data-story-history] [data-action='inspect-state']")?.click();
    await settle();

    newer.resolve(historicalState(7, "Newer inspection wins."));
    await settle();
    expect(page.document.querySelector("[data-story-state-inspector]")?.textContent).toContain("Newer inspection wins.");

    older.resolve(historicalState(6, "Older inspection must not overwrite."));
    await settle();
    expect(page.document.querySelector("[data-story-state-inspector]")?.textContent).toContain("Newer inspection wins.");
    expect(page.document.querySelector("[data-story-state-inspector]")?.textContent).not.toContain("Older inspection must not overwrite.");
    mounted.dispose();
  });

  it("waits for complete history before continuous reading renders every accepted turn", async () => {
    const page = fixture();
    const loaded = sync({
      campaign: { ...sync().campaign, activeTurnNumber: 7 }, activeTurnNumber: 7,
      turns: { campaignId, nextCursor: "before-6", turns: [6, 7].map((turnNumber) => ({
        id: `00000000-0000-4000-8000-${String(turnNumber).padStart(12, "0")}`,
        turnNumber, action: `Action ${turnNumber}`, inputMode: "action" as const, inputModeSource: "explicit" as const,
        narration: `Narration ${turnNumber}.`, choices: [], customActionSuggestion: "", imagePrompt: "", imageUrl: null,
        acceptedAt: "2026-08-18T00:00:00.000Z", chronicleRetrieval: null, reportedCost: null
      })) }
    });
    const turns = vi.fn().mockResolvedValue({
      campaignId, nextCursor: null, turns: [4, 5].map((turnNumber) => ({
        id: `00000000-0000-4000-8000-${String(turnNumber).padStart(12, "0")}`,
        turnNumber, action: `Action ${turnNumber}`, inputMode: "action" as const, inputModeSource: "explicit" as const,
        narration: `Narration ${turnNumber}.`, choices: [], customActionSuggestion: "", imagePrompt: "", imageUrl: null,
        acceptedAt: "2026-08-18T00:00:00.000Z", chronicleRetrieval: null, reportedCost: null
      }))
    });
    const mounted = mountStoryPlayerPage(page.root, { campaignId, turnNumber: 7 }, composition({
      list: vi.fn().mockResolvedValue({ campaigns: [campaignSummary({ activeTurnNumber: 7 })] }), syncStatus: vi.fn().mockResolvedValue(loaded), turns,
      session: vi.fn().mockResolvedValue({ user: { settings: { continuousReading: true } } })
    }));
    await settle();
    await settle();
    await settle();

    expect(turns).toHaveBeenCalledWith(campaignId, { before: "before-6", limit: 200 }, undefined);
    await vi.waitFor(() => expect(page.document.querySelectorAll("[data-story-leaf]")).toHaveLength(4));
    expect(page.document.querySelectorAll("[data-story-leaf] [data-action='inspect-state']")).toHaveLength(1);
    mounted.dispose();
  });

  it("aborts work, unsubscribes, removes listeners, and clears polling on disposal", async () => {
    const page = fixture();
    const baseStore = createCampaignStore();
    const unsubscribe = vi.fn();
    const campaignStore = {
      ...baseStore,
      store: {
        get: baseStore.store.get,
        subscribe: (listener: Parameters<typeof baseStore.store.subscribe>[0]) => {
          const stop = baseStore.store.subscribe(listener);
          return () => { unsubscribe(); stop(); };
        }
      }
    } as CampaignStoreController;
    const syncStatus = vi.fn((_: string, signal?: AbortSignal) => new Promise<CampaignSyncStatus>(() => {
      expect(signal).toBeDefined();
    }));
    const clearInterval = vi.spyOn(globalThis, "clearInterval");
    const mounted = mountStoryPlayerPage(page.root, { campaignId, turnNumber: null }, composition({ campaignStore, syncStatus }));

    mounted.dispose();

    expect(syncStatus.mock.calls[0]?.[1]?.aborted).toBe(true);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(clearInterval).toHaveBeenCalled();
  });
});
