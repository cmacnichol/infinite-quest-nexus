import { readFileSync } from "node:fs";
import { parseHTML } from "linkedom";
import { createCampaignStore, type CampaignStoreController } from "../../packages/client-core/src/index.js";
import type { CampaignRuntimeStateResponse, CampaignSyncStatus } from "../../packages/contracts/src/index.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StoryPlayerComposition } from "../../apps/web-next/src/story-player-composition.js";
import { mountStoryPlayerPage, prepareTurnSubmission } from "../../apps/web-next/src/story-player-page.js";

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
    canonicalFacts: [{ id: null, content: "The observatory lens is cracked." }],
    scratchpad: "Private campaign scratchpad.",
    trackers: [{ id: "moon", name: "Moon phase", value: "Waxing", rules: "Advance after rest." }],
    rpgStats: [{ id: "courage", name: "Courage", value: 8, note: "Inspector-only mechanics." }],
    eventTriggers: [{
      id: "bell", label: "Midnight bell", timing: "after", condition: "After midnight", effect: "The bell rings.",
      addTextAfter: false, triggeredCount: 1, lastTriggeredTurn: 5, lastTriggeredAt: "2026-08-18T00:00:00.000Z"
    }],
    pendingEventTriggers: [{
      id: "echo", sourceTriggerId: "bell", name: "Bell echo", timing: "after", condition: "", effect: "",
      instructions: "Echo the bell once.", reason: "Queued by the bell.", sourceTurn: 5
    }],
    recordedResolution: {
      statName: "Courage",
      base: 8,
      modifier: 4,
      target: 12,
      roll: 9,
      success: true,
      margin: 3,
      difficultyLabel: "easy"
    }
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
  readonly readableExport?: ReturnType<typeof vi.fn>;
  readonly state?: ReturnType<typeof vi.fn>;
  readonly inspectState?: ReturnType<typeof vi.fn>;
  readonly session?: ReturnType<typeof vi.fn>;
  readonly meta?: ReturnType<typeof vi.fn>;
  readonly campaignStore?: CampaignStoreController;
} = {}): StoryPlayerComposition {
  const campaignStore = options.campaignStore ?? createCampaignStore();
  return {
    api: {
      campaigns: {
        list: options.list ?? vi.fn().mockResolvedValue({ campaigns: [campaignSummary()] }),
        readableExport: options.readableExport ?? vi.fn().mockResolvedValue(new Blob(["# Accepted story"])),
        turns: options.turns ?? vi.fn(),
        state: options.state ?? vi.fn(),
        inspectState: options.inspectState ?? options.state ?? vi.fn()
      },
      generation: { syncStatus: options.syncStatus ?? vi.fn().mockResolvedValue(sync()) },
      meta: { get: options.meta ?? vi.fn().mockResolvedValue({ application: "Infinite Quest Nexus", version: "development" }) }
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

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Story Player page shell", () => {
  it("enables Campaign Tools About and renders only shared meta data", async () => {
    const page = fixture();
    const meta = vi.fn().mockResolvedValue({ application: { name: "Infinite Quest Nexus", version: "2026.08", commit: null, builtAt: null } });
    const mounted = mountStoryPlayerPage(page.root, { campaignId, turnNumber: null }, composition({ meta }));
    await settle();

    const about = page.document.querySelector<HTMLButtonElement>("[data-tool-action='open-about']");
    expect(about?.disabled).toBe(false);
    about?.click();
    await settle();

    expect(meta).toHaveBeenCalledWith(undefined);
    expect(page.document.querySelector("[data-story-tool-dialog]")?.textContent).toContain("Infinite Quest Nexus");
    expect(page.document.querySelector("[data-story-tool-dialog]")?.textContent).toContain("2026.08");
    mounted.dispose();
  });

  it("requests the backend readable export only after complete Story history is available", async () => {
    const page = fixture();
    const readableExport = vi.fn().mockResolvedValue(new Blob(["# Accepted story"]));
    const createObjectUrl = vi.fn().mockReturnValue("blob:story-export");
    const revokeObjectUrl = vi.fn();
    vi.stubGlobal("URL", { createObjectURL: createObjectUrl, revokeObjectURL: revokeObjectUrl });
    const mounted = mountStoryPlayerPage(page.root, { campaignId, turnNumber: null }, composition({ readableExport }));
    await settle();

    page.document.querySelector<HTMLButtonElement>("[data-tool-action='export-markdown']")?.click();
    await vi.waitFor(() => expect(readableExport).toHaveBeenCalledWith(campaignId, "markdown"));
    expect(createObjectUrl).toHaveBeenCalledTimes(1);
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:story-export");
    mounted.dispose();
  });

  it("restores Campaign Tools focus immediately for every export action", async () => {
    const page = fixture();
    Object.defineProperty(page.window, "location", { configurable: true, value: { origin: "https://story.example.test" } });
    const printDocument = { open: vi.fn(), write: vi.fn(), close: vi.fn(), images: [] };
    Object.defineProperty(page.window, "open", {
      configurable: true,
      value: vi.fn().mockReturnValue({ document: printDocument, close: vi.fn(), print: vi.fn(), opener: {} })
    });
    vi.stubGlobal("URL", { createObjectURL: vi.fn().mockReturnValue("blob:story-export"), revokeObjectURL: vi.fn() });
    const mounted = mountStoryPlayerPage(page.root, { campaignId, turnNumber: null }, composition());
    await settle();
    const summary = page.document.querySelector<HTMLElement>("[data-campaign-tools] summary");
    if (!summary) throw new Error("Campaign Tools summary is missing.");
    const focus = vi.spyOn(summary, "focus");

    for (const action of ["export-markdown", "export-html", "export-pdf"] as const) {
      const button = page.document.querySelector<HTMLButtonElement>(`[data-tool-action='${action}']`);
      if (!button) throw new Error(`Missing ${action} control.`);
      button.focus();
      button.click();
      expect(focus).toHaveBeenCalledTimes(action === "export-markdown" ? 1 : action === "export-html" ? 2 : 3);
      await settle();
    }
    mounted.dispose();
  });

  it("prints the first stored variant from every illustration segment in complete accepted history", async () => {
    const page = fixture();
    Object.defineProperty(page.window, "location", { configurable: true, value: { origin: "https://story.example.test" } });
    const printDocument = { open: vi.fn(), write: vi.fn(), close: vi.fn(), images: [] };
    const printWindow = { document: printDocument, close: vi.fn(), print: vi.fn(), opener: {} };
    Object.defineProperty(page.window, "open", { configurable: true, value: vi.fn().mockReturnValue(printWindow) });
    const loaded = sync({
      campaign: { ...sync().campaign, activeTurnNumber: 2 }, activeTurnNumber: 2, turns: turnWindow([1, 2])
    });
    const segmentResponse = {
      segments: [
        {
          turnId: "00000000-0000-4000-8000-000000000001", id: "segment-one", ordinal: 0, text: "First segment.",
          variants: [
            { variantIndex: 1, url: "https://story.example.test/assets/one-second.png" },
            { variantIndex: 0, url: "https://story.example.test/assets/one-first.png" }
          ]
        },
        {
          turnId: "00000000-0000-4000-8000-000000000001", id: "segment-two", ordinal: 1, text: "Second segment.",
          variants: [{ variantIndex: 0, url: "https://story.example.test/assets/two-first.png" }]
        },
        {
          turnId: "00000000-0000-4000-8000-000000000002", id: "segment-three", ordinal: 0, text: "Third segment.",
          variants: [{ variantIndex: 0, url: "https://story.example.test/assets/three-first.png" }]
        }
      ]
    };
    const segments = vi.fn().mockResolvedValue(segmentResponse);
    const base = composition({ syncStatus: vi.fn().mockResolvedValue(loaded) });
    const mounted = mountStoryPlayerPage(page.root, { campaignId, turnNumber: 2 }, {
      ...base,
      illustrations: {
        ...base.illustrations,
        config: vi.fn().mockResolvedValue({ enabled: false, sourcePolicy: "off" }),
        segments
      }
    } as StoryPlayerComposition);
    await settle();

    page.document.querySelector<HTMLButtonElement>("[data-tool-action='export-pdf']")?.click();
    await vi.waitFor(() => expect(printWindow.print).toHaveBeenCalledTimes(1));

    expect(segments).toHaveBeenCalledWith(campaignId, expect.any(AbortSignal));
    const markup = String(printDocument.write.mock.calls[0]?.[0]);
    expect(markup).toContain("/assets/one-first.png");
    expect(markup).not.toContain("/assets/one-second.png");
    expect(markup).toContain("/assets/two-first.png");
    expect(markup).toContain("/assets/three-first.png");
    mounted.dispose();
  });

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
    expect(styles).toMatch(/\.story-foldout\s*\{[\s\S]*grid-template-areas: "spine reader illustration";/u);
    expect(styles).toMatch(/:focus-visible/u);
    expect(styles).toMatch(/var\(--accent\)/u);
    mounted.dispose();
  });

  it("enforces the Fold-out responsive design contract without horizontal overflow", () => {
    const styles = readFileSync(new URL("../../apps/web-next/src/story-player.css", import.meta.url), "utf8");

    expect(styles).toMatch(/grid-template-areas:\s*"spine reader illustration";/u);
    expect(styles).toMatch(/grid-template-columns:\s*clamp\(172px, 13vw, 220px\) minmax\(0, 1fr\) clamp\(196px, 15\.5vw, 280px\);/u);
    expect(styles).toMatch(/\.story-reader-column,?\s*\.story-reader\s*\{[\s\S]*?grid-area:\s*reader;[\s\S]*?min-width:\s*0;/u);
    expect(styles).toMatch(/\.story-campaign-spine\s*\{[\s\S]*?grid-area:\s*spine;[\s\S]*?position:\s*sticky;/u);
    expect(styles).toMatch(/\.story-illustration-wing\s*\{[\s\S]*?grid-area:\s*illustration;[\s\S]*?position:\s*sticky;/u);
    expect(styles).toMatch(/\[data-reading-width="narrow"\]\s*\{\s*--story-reader-max:\s*680px;/u);
    expect(styles).toMatch(/\[data-reading-width="standard"\]\s*\{\s*--story-reader-max:\s*1120px;/u);
    expect(styles).toMatch(/\[data-reading-width="wide"\]\s*\{\s*--story-reader-max:\s*none;/u);
    expect(styles).toMatch(/--story-reader-gutter:\s*32px;/u);
    expect(styles).toMatch(/@media \(max-width: 1180px\)[\s\S]*?--story-reader-gutter:\s*24px;/u);
    expect(styles).toMatch(/@media \(max-width: 1040px\)[\s\S]*?grid-template-areas:\s*"reader"\s*"spine"\s*"illustration";/u);
    expect(styles).toMatch(/@media \(max-width: 820px\)[\s\S]*?--story-reader-gutter:\s*18px;/u);
    expect(styles).toMatch(/@media \(max-width: 540px\)[\s\S]*?\.story-continue\s*\{\s*width:\s*100%;/u);
    expect(styles).toMatch(/@media \(min-width: 320px\)/u);
    expect(styles).toMatch(/@media \(prefers-reduced-motion:\s*reduce\)/u);
    expect(styles).toMatch(/overflow-x:\s*clip;/u);
    expect(styles).not.toMatch(/border-radius\s*:(?!\s*0(?:px)?\s*;)/u);
    expect(styles).toMatch(/\.story-foldout\s*\{[\s\S]*?column-gap:\s*0;/u);
    expect(styles).not.toMatch(/\.story-foldout\s*\{[\s\S]*?gap:\s*var\(--story-reader-gutter\);/u);
    expect(styles).toMatch(/\.story-leaf,[\s\S]*?\.story-composer\s*\{[\s\S]*?calc\(100% - \(2 \* var\(--story-reader-gutter\)\)\)/u);
  });

  it("scopes square responsive dialogs and 44px targets to the replacement Story page", () => {
    const styles = readFileSync(new URL("../../apps/web-next/src/story-player.css", import.meta.url), "utf8");

    expect(styles).toMatch(/\.story-history-dialog,\s*\.story-tool-dialog\s*\{[\s\S]*?width:\s*min\(860px, calc\(100vw - 32px\)\);[\s\S]*?max-height:\s*calc\(100dvh - 32px\);[\s\S]*?border-radius:\s*0;/u);
    expect(styles).toMatch(/\.story-history-dialog::backdrop,\s*\.story-tool-dialog::backdrop\s*\{[\s\S]*?background:\s*var\(--artwork-overlay\);/u);
    expect(styles).toMatch(/main\[data-page="story-player"\]\s*:is\(button, a, input, select, textarea, summary\)\s*\{[\s\S]*?min-inline-size:\s*44px;[\s\S]*?min-block-size:\s*44px;/u);
    expect(styles).toMatch(/\.story-clear-draft\s*\{[\s\S]*?width:\s*44px;[\s\S]*?height:\s*44px;/u);
  });

  it("restores Story navigation and keeps the compact Campaign Tools disclosure viewport-safe", () => {
    const styles = readFileSync(new URL("../../apps/web-next/src/story-player.css", import.meta.url), "utf8");

    expect(styles).toMatch(/@media \(max-width: 1080px\)[\s\S]*?\.site-nav\s*\{\s*grid-area:\s*nav;\s*display:\s*flex;\s*min-width:\s*0;\s*overflow-x:\s*auto;/u);
    expect(styles).toMatch(/@media \(max-width: 540px\)[\s\S]*?\.story-campaign-tools-menu\s*\{\s*position:\s*fixed;[\s\S]*?inset-inline:\s*var\(--edge\);[\s\S]*?width:\s*auto;/u);
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

  it("pauses streamed-preview following after manual scroll and resumes it explicitly", async () => {
    const page = fixture();
    const loaded = sync({
      campaign: { ...sync().campaign, activeTurnNumber: 1 },
      activeTurnNumber: 1,
      pendingGeneration: {
        id: "55555555-5555-4555-8555-555555555555", status: "generating", action: "Continue",
        expectedTurnNumber: 2, createdAt: "2026-08-18T00:00:00.000Z", updatedAt: "2026-08-18T00:00:00.000Z",
        operationKind: "append", replacementTurnId: null
      },
      turns: turnWindow([1])
    });
    const mounted = mountStoryPlayerPage(page.root, { campaignId, turnNumber: 1 }, composition({ syncStatus: vi.fn().mockResolvedValue(loaded) }));
    await settle();

    page.window.dispatchEvent(new page.window.Event("scroll"));
    await settle();
    expect(page.document.querySelector<HTMLButtonElement>("[data-action='resume-generation-following']")).toBeTruthy();

    page.document.querySelector<HTMLButtonElement>("[data-action='resume-generation-following']")?.click();
    await settle();
    expect(page.document.querySelector("[data-action='resume-generation-following']")).toBeNull();
    mounted.dispose();
  });

  it("disables history restart and branch controls while generation is active", async () => {
    const page = fixture();
    const loaded = sync({
      campaign: { ...sync().campaign, activeTurnNumber: 1 }, activeTurnNumber: 1,
      pendingGeneration: {
        id: "55555555-5555-4555-8555-555555555555", status: "generating", action: "Continue",
        expectedTurnNumber: 2, createdAt: "2026-08-18T00:00:00.000Z", updatedAt: "2026-08-18T00:00:00.000Z",
        operationKind: "append", replacementTurnId: null
      },
      turns: turnWindow([1])
    });
    const mounted = mountStoryPlayerPage(page.root, { campaignId, turnNumber: 1 }, composition({ syncStatus: vi.fn().mockResolvedValue(loaded) }));
    await settle();

    page.document.querySelector<HTMLButtonElement>("[data-action='open-complete-history']")?.click();
    await settle();
    expect(page.document.querySelector<HTMLButtonElement>("[data-action='restart-from-turn']")?.disabled).toBe(true);
    mounted.dispose();
  });

  it("disables Branch and Rewind if generation starts while their dialog is open", async () => {
    const page = fixture();
    const campaignStore = createCampaignStore();
    const loaded = sync({
      campaign: { ...sync().campaign, activeTurnNumber: 1 }, activeTurnNumber: 1, turns: turnWindow([1])
    });
    Object.defineProperty(page.window, "confirm", { configurable: true, value: vi.fn(() => true) });
    const mounted = mountStoryPlayerPage(page.root, { campaignId, turnNumber: 1 }, composition({
      campaignStore, syncStatus: vi.fn().mockResolvedValue(loaded)
    }));
    await settle();

    page.document.querySelector<HTMLButtonElement>("[data-action='open-complete-history']")?.click();
    await settle();
    page.document.querySelector<HTMLButtonElement>("[data-action='restart-from-turn']")?.click();
    await settle();
    campaignStore.load(sync({
      ...loaded,
      pendingGeneration: {
        id: "55555555-5555-4555-8555-555555555555", status: "generating", action: "Continue",
        expectedTurnNumber: 2, createdAt: "2026-08-18T00:00:00.000Z", updatedAt: "2026-08-18T00:00:00.000Z",
        operationKind: "append", replacementTurnId: null
      }
    }));
    await settle();

    expect(page.document.querySelector<HTMLButtonElement>("[data-action='branch-from-turn']")?.disabled).toBe(true);
    expect(page.document.querySelector<HTMLButtonElement>("[data-action='rewind-from-turn']")?.disabled).toBe(true);
    mounted.dispose();
  });

  it("keeps following when an auto-scroll delivers its viewport scroll after microtasks", async () => {
    const page = fixture();
    const loaded = sync({
      campaign: { ...sync().campaign, activeTurnNumber: 1 }, activeTurnNumber: 1,
      pendingGeneration: {
        id: "55555555-5555-4555-8555-555555555555", status: "generating", action: "Continue",
        expectedTurnNumber: 2, createdAt: "2026-08-18T00:00:00.000Z", updatedAt: "2026-08-18T00:00:00.000Z",
        operationKind: "append", replacementTurnId: null
      },
      turns: turnWindow([1])
    });
    const originalScrollIntoView = page.window.HTMLElement.prototype.scrollIntoView;
    const autoScroll = vi.fn(() => setTimeout(() => page.window.dispatchEvent(new page.window.Event("scroll")), 0));
    Object.defineProperty(page.window.HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: autoScroll
    });
    const mounted = mountStoryPlayerPage(page.root, { campaignId, turnNumber: 1 }, composition({ syncStatus: vi.fn().mockResolvedValue(loaded) }));
    await vi.waitFor(() => expect(autoScroll).toHaveBeenCalled());
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await settle();

    expect(page.document.querySelector("[data-action='resume-generation-following']")).toBeNull();
    Object.defineProperty(page.window.HTMLElement.prototype, "scrollIntoView", { configurable: true, value: originalScrollIntoView });
    mounted.dispose();
  });

  it("keeps following when auto-scroll arrives after a zero-delay task", async () => {
    vi.useFakeTimers();
    const page = fixture();
    const loaded = sync({
      campaign: { ...sync().campaign, activeTurnNumber: 1 }, activeTurnNumber: 1,
      pendingGeneration: {
        id: "55555555-5555-4555-8555-555555555555", status: "generating", action: "Continue",
        expectedTurnNumber: 2, createdAt: "2026-08-18T00:00:00.000Z", updatedAt: "2026-08-18T00:00:00.000Z",
        operationKind: "append", replacementTurnId: null
      },
      turns: turnWindow([1])
    });
    const originalScrollIntoView = page.window.HTMLElement.prototype.scrollIntoView;
    const originalScrollY = Object.getOwnPropertyDescriptor(page.window, "scrollY");
    Object.defineProperty(page.window, "scrollY", { configurable: true, value: 0 });
    const autoScroll = vi.fn(() => {
      Object.defineProperty(page.window, "scrollY", { configurable: true, value: 240 });
      setTimeout(() => page.window.dispatchEvent(new page.window.Event("scroll")), 1);
    });
    Object.defineProperty(page.window.HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: autoScroll
    });

    let mounted: ReturnType<typeof mountStoryPlayerPage> | null = null;
    try {
      mounted = mountStoryPlayerPage(page.root, { campaignId, turnNumber: 1 }, composition({ syncStatus: vi.fn().mockResolvedValue(loaded) }));
      await settle();
      expect(autoScroll).toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      await settle();

      expect(page.document.querySelector("[data-action='resume-generation-following']")).toBeNull();
    } finally {
      mounted?.dispose();
      Object.defineProperty(page.window.HTMLElement.prototype, "scrollIntoView", { configurable: true, value: originalScrollIntoView });
      if (originalScrollY) Object.defineProperty(page.window, "scrollY", originalScrollY);
      else delete (page.window as { scrollY?: number }).scrollY;
      vi.useRealTimers();
    }
  });

  it("pauses following when a manual scroll arrives while auto-follow is armed", async () => {
    vi.useFakeTimers();
    const page = fixture();
    const loaded = sync({
      campaign: { ...sync().campaign, activeTurnNumber: 1 }, activeTurnNumber: 1,
      pendingGeneration: {
        id: "55555555-5555-4555-8555-555555555555", status: "generating", action: "Continue",
        expectedTurnNumber: 2, createdAt: "2026-08-18T00:00:00.000Z", updatedAt: "2026-08-18T00:00:00.000Z",
        operationKind: "append", replacementTurnId: null
      },
      turns: turnWindow([1])
    });
    const originalScrollIntoView = page.window.HTMLElement.prototype.scrollIntoView;
    const originalScrollY = Object.getOwnPropertyDescriptor(page.window, "scrollY");
    const autoFollow = vi.fn();
    Object.defineProperty(page.window, "scrollY", { configurable: true, value: 0 });
    Object.defineProperty(page.window.HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: autoFollow
    });

    let mounted: ReturnType<typeof mountStoryPlayerPage> | null = null;
    try {
      mounted = mountStoryPlayerPage(page.root, { campaignId, turnNumber: 1 }, composition({ syncStatus: vi.fn().mockResolvedValue(loaded) }));
      await settle();
      expect(autoFollow).toHaveBeenCalled();

      Object.defineProperty(page.window, "scrollY", { configurable: true, value: 240 });
      page.window.dispatchEvent(new page.window.Event("scroll"));
      await settle();

      expect(page.document.querySelector<HTMLButtonElement>("[data-action='resume-generation-following']")).toBeTruthy();
    } finally {
      mounted?.dispose();
      Object.defineProperty(page.window.HTMLElement.prototype, "scrollIntoView", { configurable: true, value: originalScrollIntoView });
      if (originalScrollY) Object.defineProperty(page.window, "scrollY", originalScrollY);
      else delete (page.window as { scrollY?: number }).scrollY;
      vi.useRealTimers();
    }
  });

  it("removes the viewport scroll listener on disposal", async () => {
    const page = fixture();
    const loaded = sync({
      campaign: { ...sync().campaign, activeTurnNumber: 1 }, activeTurnNumber: 1,
      pendingGeneration: {
        id: "55555555-5555-4555-8555-555555555555", status: "generating", action: "Continue",
        expectedTurnNumber: 2, createdAt: "2026-08-18T00:00:00.000Z", updatedAt: "2026-08-18T00:00:00.000Z",
        operationKind: "append", replacementTurnId: null
      },
      turns: turnWindow([1])
    });
    const storyWindow = page.root.ownerDocument.defaultView;
    if (!storyWindow) throw new Error("Story fixture window is missing.");
    const activeScrollListeners = new Set<EventListenerOrEventListenerObject>();
    const originalAdd = storyWindow.addEventListener.bind(storyWindow);
    const originalRemove = storyWindow.removeEventListener.bind(storyWindow);
    storyWindow.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions) => {
        if (type === "scroll" && listener) activeScrollListeners.add(listener);
        return originalAdd(type, listener, options);
      }) as typeof storyWindow.addEventListener;
    storyWindow.removeEventListener = ((type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | EventListenerOptions) => {
        if (type === "scroll" && listener) activeScrollListeners.delete(listener);
        return originalRemove(type, listener, options);
      }) as typeof storyWindow.removeEventListener;
    const mounted = mountStoryPlayerPage(page.root, { campaignId, turnNumber: 1 }, composition({ syncStatus: vi.fn().mockResolvedValue(loaded) }));
    await settle();
    expect(activeScrollListeners.size).toBe(1);
    mounted.dispose();
    page.window.dispatchEvent(new page.window.Event("scroll"));
    await settle();

    expect(activeScrollListeners).toEqual(new Set());
    expect(page.document.querySelector("[data-action='resume-generation-following']")).toBeNull();
  });

  it("refreshes runtime state and illustration data independently after durable completion", async () => {
    const page = fixture();
    const completed = {
      id: "55555555-5555-4555-8555-555555555555", campaignId, expectedTurnNumber: 2, turnNumber: 2,
      resultTurnId: "66666666-6666-4666-8666-666666666666", action: "Continue.", inputMode: "action", inputModeSource: "explicit",
      narration: "The observatory opens.", choices: [], customActionSuggestion: "", imagePrompt: "", acceptedAt: "2026-08-18T00:01:00.000Z",
      stateSnapshot: {}, chronicleRetrieval: null, reportedCost: null
    };
    const genericRuntime = { ...historicalState(2, "The observatory is open."), recordedResolution: null };
    const runtime = vi.fn().mockResolvedValue(genericRuntime);
    const segments = vi.fn().mockResolvedValue({ campaignId, segments: [] });
    const campaignStore = createCampaignStore();
    const loadRuntimeState = vi.spyOn(campaignStore, "loadRuntimeState");
    const base = composition({
      campaignStore,
      syncStatus: vi.fn().mockResolvedValue(sync({
        campaign: { ...sync().campaign, activeTurnNumber: 1 }, activeTurnNumber: 1, turns: turnWindow([1])
      }))
    });
    const prepared = {
      ...base,
      api: { ...base.api, campaigns: { ...base.api.campaigns, state: runtime } },
      workflow: {
        submit: vi.fn(),
        resume: vi.fn(async () => ({
          campaignId, jobId: completed.id, operationKind: "append", replacementTurnId: null,
          async *watch() { yield { type: "settled" as const, outcome: "completed" as const, result: completed }; },
          async *retryGeneration() {}, cancelGeneration: vi.fn(), discardGeneration: vi.fn(), fetchResult: vi.fn()
        }))
      },
      illustrations: {
        ...base.illustrations,
        config: vi.fn().mockResolvedValue({ enabled: true, sourcePolicy: "library_then_generate" }),
        segments
      }
    } as StoryPlayerComposition;
    const mounted = mountStoryPlayerPage(page.root, { campaignId, turnNumber: 1 }, prepared);

    await vi.waitFor(() => expect(runtime).toHaveBeenCalledWith(campaignId, 2));
    await vi.waitFor(() => expect(loadRuntimeState).toHaveBeenCalledWith(genericRuntime));
    await vi.waitFor(() => expect(segments).toHaveBeenCalledWith(campaignId, expect.any(AbortSignal)));
    mounted.dispose();
  });

  it("returns focus to Campaign Tools after cancel and Close dismiss a tool dialog", async () => {
    const page = fixture();
    const loaded = sync({
      campaign: { ...sync().campaign, activeTurnNumber: 1 }, activeTurnNumber: 1, turns: turnWindow([1])
    });
    const base = composition({ syncStatus: vi.fn().mockResolvedValue(loaded) });
    const mounted = mountStoryPlayerPage(page.root, { campaignId, turnNumber: 1 }, {
      ...base,
      api: {
        ...base.api,
        campaigns: {
          ...base.api.campaigns,
          getTurnCorrection: vi.fn().mockResolvedValue({
            ownerUserId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", campaignId,
            turnId: "00000000-0000-4000-8000-000000000001", turnNumber: 1,
            correctionRevision: 0, originalNarration: "Narration 1.", effectiveNarration: "Narration 1.",
            correctedAt: null, illustrationsMayBeStale: false
          })
        }
      }
    } as StoryPlayerComposition);
    await settle();

    const summary = page.document.querySelector<HTMLElement>("[data-campaign-tools] summary");
    if (!summary) throw new Error("Campaign Tools summary is missing.");
    const focus = vi.spyOn(summary, "focus");
    page.document.querySelector<HTMLButtonElement>("[data-action='edit-response']")?.click();
    await vi.waitFor(() => expect(page.document.querySelector("[data-story-tool-dialog]")).toBeTruthy());
    page.document.querySelector<HTMLDialogElement>("[data-story-tool-dialog]")?.dispatchEvent(new page.window.Event("cancel", { cancelable: true }));
    expect(focus).toHaveBeenCalledTimes(1);

    page.document.querySelector<HTMLButtonElement>("[data-action='edit-response']")?.click();
    await vi.waitFor(() => expect(page.document.querySelector("[data-story-tool-dialog]")).toBeTruthy());
    page.document.querySelector<HTMLButtonElement>("[data-action='close-story-tool-dialog']")?.click();
    expect(focus).toHaveBeenCalledTimes(2);
    mounted.dispose();
  });

  it("restores the visible accepted action before Retry Latest focuses the composer", async () => {
    const page = fixture();
    const loaded = sync({
      campaign: { ...sync().campaign, activeTurnNumber: 1 }, activeTurnNumber: 1, turns: turnWindow([1])
    });
    const mounted = mountStoryPlayerPage(page.root, { campaignId, turnNumber: 1 }, composition({
      syncStatus: vi.fn().mockResolvedValue(loaded)
    }));
    await settle();
    const textarea = page.document.querySelector<HTMLTextAreaElement>("[data-story-draft]");
    if (!textarea) throw new Error("Story composer is missing.");
    textarea.value = "Unsaved stale text.";
    textarea.dispatchEvent(new page.window.Event("input", { bubbles: true }));

    page.document.querySelector<HTMLButtonElement>("[data-action='retry-latest-generation']")?.click();

    expect(page.document.querySelector<HTMLTextAreaElement>("[data-story-draft]")?.value).toBe("Action 1");
    mounted.dispose();
  });

  it("prepares an explicit composer submission with its selected turn length", async () => {
    await expect(prepareTurnSubmission("Try another path.", "action", "action", undefined, "brief")).resolves.toEqual({
      kind: "ready",
      submission: {
        action: "Try another path.",
        requestedInputMode: "action",
        resolvedInputMode: "action",
        inputModeSource: "explicit",
        storyLengthProfileOverride: "brief"
      }
    });
  });

  it("keeps accepted narration and Continue Story available when illustration loading fails", async () => {
    const page = fixture();
    const loaded = sync({
      campaign: { ...sync().campaign, activeTurnNumber: 1 }, activeTurnNumber: 1, turns: turnWindow([1])
    });
    const base = composition({ syncStatus: vi.fn().mockResolvedValue(loaded) });
    const config = vi.fn().mockRejectedValue(new Error("illustration endpoint unavailable"));
    const mounted = mountStoryPlayerPage(page.root, { campaignId, turnNumber: 1 }, {
      ...base,
      illustrations: { ...base.illustrations, config, segments: vi.fn() }
    } as StoryPlayerComposition);

    await settle();

    expect(config).toHaveBeenCalledWith(campaignId, expect.any(AbortSignal));
    expect(page.document.querySelector("[data-story-illustration-status]")?.textContent).toContain("unavailable");
    expect(page.document.querySelector("[data-story-reader]")?.textContent).toContain("Narration 1.");
    expect(page.document.querySelector<HTMLButtonElement>("[data-action='continue-story']")).toBeTruthy();
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

  it("pages the bounded persisted history before rendering an older deep-linked turn", async () => {
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
    const turns = vi.fn().mockResolvedValue({ campaignId, turns: turnWindow([1, 2]).turns, nextCursor: null });
    const mounted = mountStoryPlayerPage(page.root, { campaignId, turnNumber: 2 }, composition({
      list: vi.fn().mockResolvedValue({ campaigns: [campaignSummary({ activeTurnNumber: 9 })] }),
      syncStatus: vi.fn().mockResolvedValue(loaded),
      turns
    }));
    await vi.waitFor(() => expect(page.document.querySelector("[data-story-leaf] h1")?.textContent).toBe("Turn 2"));

    expect(turns).toHaveBeenCalledWith(campaignId, { before: "older-turns-available", limit: 200 }, undefined);
    expect(page.document.querySelector(".story-command-row")?.textContent).toContain("Viewing turn 2 of 9");
    mounted.dispose();
  });

  it("renders a not-found state instead of falling back to latest for an absent deep-linked turn", async () => {
    const page = fixture();
    const loaded = sync({
      campaign: { ...sync().campaign, activeTurnNumber: 9 },
      activeTurnNumber: 9,
      turns: { ...turnWindow([9]), nextCursor: "older-turns-available" }
    });
    const mounted = mountStoryPlayerPage(page.root, { campaignId, turnNumber: 2 }, composition({
      list: vi.fn().mockResolvedValue({ campaigns: [campaignSummary({ activeTurnNumber: 9 })] }),
      syncStatus: vi.fn().mockResolvedValue(loaded),
      turns: vi.fn().mockResolvedValue({ campaignId, turns: turnWindow([4, 5]).turns, nextCursor: null })
    }));

    await vi.waitFor(() => expect(page.document.querySelector("[data-story-error]")?.textContent).toContain("not found"));
    expect(page.document.querySelector("[data-story-leaf]")).toBeNull();
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
    expect(previous).toBeNull();
    expect(next).toBeNull();

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

  it("aligns the compact Campaign Spine by scrolling its actual overflow rail", async () => {
    const page = fixture();
    const scrollTo = vi.fn();
    page.window.HTMLElement.prototype.scrollTo = scrollTo;
    Object.defineProperty(page.window.HTMLElement.prototype, "scrollWidth", { configurable: true, get: () => 420 });
    const loaded = sync({
      campaign: { ...sync().campaign, activeTurnNumber: 5 }, activeTurnNumber: 5, turns: turnWindow([1, 2, 3, 4, 5])
    });
    const mounted = mountStoryPlayerPage(page.root, { campaignId, turnNumber: 5 }, composition({
      syncStatus: vi.fn().mockResolvedValue(loaded)
    }));
    await settle();

    expect(scrollTo).toHaveBeenCalledWith({ left: expect.any(Number) });
    expect((scrollTo.mock.instances[0] as HTMLElement).classList.contains("story-campaign-spine-content")).toBe(true);
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
    expect(page.document.querySelector("[data-story-state-inspector]")?.textContent).toContain("The observatory lens is cracked.");
    expect(page.document.querySelector("[data-story-state-inspector]")?.textContent).toContain("Private campaign scratchpad.");
    expect(page.document.querySelector("[data-story-state-inspector]")?.textContent).toContain("Moon phase");
    expect(page.document.querySelector("[data-story-state-inspector]")?.textContent).toContain("Midnight bell");
    expect(page.document.querySelector("[data-story-state-inspector]")?.textContent).toContain("Bell echo");
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
    expect(page.document.querySelector("[data-story-state-inspector]")?.textContent).toContain("Resolve Check");
    expect(page.document.querySelector("[data-story-state-inspector]")?.textContent).toContain("Courage: 9 / 12 (success)");
    expect(page.document.querySelector("[data-story-reader]")?.textContent).not.toContain("Reader inspection is dialog-only.");
    expect(page.document.querySelector("[data-story-reader]")?.textContent).not.toContain("Inspector-only mechanics.");
    expect(page.document.querySelector("[data-story-reader]")?.textContent).not.toContain("Resolve Check");
    expect(page.document.querySelector(".story-campaign-spine")?.textContent).not.toContain("Resolve Check");
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

  it("aborts work, unsubscribes, and removes listeners on disposal without page polling", async () => {
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
    expect(clearInterval).not.toHaveBeenCalled();
  });
});
