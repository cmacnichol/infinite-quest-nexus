import { readFileSync } from "node:fs";
import { parseHTML } from "linkedom";
import { createCampaignStore, type CampaignStoreController } from "../../packages/client-core/src/index.js";
import type { CampaignSyncStatus } from "../../packages/contracts/src/index.js";
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
  readonly campaignStore?: CampaignStoreController;
} = {}): StoryPlayerComposition {
  const campaignStore = options.campaignStore ?? createCampaignStore();
  return {
    api: {
      campaigns: { list: options.list ?? vi.fn().mockResolvedValue({ campaigns: [campaignSummary()] }) },
      generation: { syncStatus: options.syncStatus ?? vi.fn().mockResolvedValue(sync()) }
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
