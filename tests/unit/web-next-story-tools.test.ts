import { describe, expect, it, vi } from "vitest";
import { createStoryToolsController, installStoryToolsDisclosure, storyCampaignToolsMarkup } from "../../apps/web-next/src/story-player-tools.js";
import { renderAppShell } from "../../apps/web-next/src/app-shell.js";
import { parseHTML } from "linkedom";
import { mountStoryPlayerPage } from "../../apps/web-next/src/story-player-page.js";
import { createCampaignStore } from "../../packages/client-core/src/index.js";

const campaignId = "11111111-1111-4111-8111-111111111111";
const latestTurn = {
  id: "22222222-2222-4222-8222-222222222222",
  turnNumber: 7,
  action: "Open the observatory door."
};
const olderTurn = {
  id: "33333333-3333-4333-8333-333333333333",
  turnNumber: 6,
  action: "Cross the moor."
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function controller(overrides: Record<string, unknown> = {}) {
  const campaigns = {
    state: vi.fn().mockResolvedValue({ campaignId, viewedTurnNumber: 7, rpgStats: [{ name: "Courage", value: 8 }] }),
    inspectState: vi.fn().mockResolvedValue({ campaignId, viewedTurnNumber: 7, rpgStats: [{ name: "Courage", value: 8 }], recordedResolution: { statName: "Courage", base: 8, modifier: 0, target: 8, roll: 4, success: true, margin: 4, difficultyLabel: "standard" } }),
    updateState: vi.fn().mockResolvedValue({ campaignId, viewedTurnNumber: 7 }),
    getTurnCorrection: vi.fn().mockResolvedValue({ turnId: latestTurn.id, narration: "Corrected narration." }),
    correctTurnNarration: vi.fn().mockResolvedValue({ turnId: latestTurn.id, narration: "Corrected narration." }),
    rewind: vi.fn().mockResolvedValue({ campaignId, activeTurnNumber: 6 }),
    branch: vi.fn().mockResolvedValue({ id: "44444444-4444-4444-8444-444444444444" })
  };
  const generation = { submitReplacement: vi.fn().mockResolvedValue(true) };
  const reload = vi.fn().mockResolvedValue(undefined);
  const navigate = vi.fn();
  const confirm = vi.fn().mockResolvedValue(true);
  const tools = createStoryToolsController({
    campaigns,
    generation,
    reload,
    navigate,
    confirm,
    current: () => ({
      campaignId,
      syncToken: "story-tools",
      activeTurnNumber: 7,
      generationActive: false,
      viewTurnNumber: 7,
      turns: [olderTurn, latestTurn]
    }),
    ...overrides
  });
  return { tools, campaigns, generation, reload, navigate, confirm };
}

type StoryExportTools = {
  exportMarkdown(): Promise<boolean>;
  exportStandaloneHtml(): Promise<boolean>;
};

type StoryActivityTools = {
  recordActivity(operation: string, detail?: Record<string, unknown>): Readonly<{ category: string; title: string; detail: string }> | null;
  copyActivityDiagnostics(): Promise<boolean>;
  activity(): readonly Readonly<{ title: string; detail: string }>[];
  clearActivity(): void;
};

type StoryPrintTools = {
  printStory(): Promise<boolean>;
};

type StoryAboutTools = {
  openAbout(): Promise<unknown>;
};

function storyComposition() {
  return {
    api: {
      campaigns: {
        list: vi.fn().mockResolvedValue({ campaigns: [{ id: campaignId, title: "Campaign", activeTurnNumber: 0, turnControlStyle: "action_only", textProviderProfileId: null }] }),
        state: vi.fn(), inspectState: vi.fn(), updateState: vi.fn(), getTurnCorrection: vi.fn(), correctTurnNarration: vi.fn(), rewind: vi.fn(), branch: vi.fn()
      },
      generation: {
        syncStatus: vi.fn().mockResolvedValue({
          campaignId, activeTurnNumber: 0, syncToken: "story-tools", turnWindowMode: "replace", pendingGeneration: null, generationRecovery: null,
          campaign: { id: campaignId, title: "Campaign", activeTurnNumber: 0, worldVersionId: "22222222-2222-4222-8222-222222222222", storyLengthProfile: "standard", updatedAt: "2026-08-18T00:00:00.000Z", selectedCharacterId: null, selectedCharacterName: "", characterSnapshot: null, characterProfile: null, characterProfileRevision: 0, status: "active" },
          world: { id: "33333333-3333-4333-8333-333333333333", title: "World", versionNumber: 1, genre: "", tone: "", premise: "", backgroundStory: "", character: "", firstAction: "Start", rules: "", playableCharacters: [] },
          playerConfig: { selectedCharacterId: null, selectedCharacterName: "", characterSnapshot: null, characterProfile: null, characterProfileRevision: 0, rpgStats: [], trackers: [], eventTriggers: [], useRpgStats: false, suppressEventTriggers: false },
          turns: { campaignId, turns: [], nextCursor: null }
        })
      },
      session: { get: vi.fn().mockResolvedValue(null) }
    },
    campaignStore: createCampaignStore(), workflow: {}, illustrations: {}, idFactory: {}, clock: {}, delay: {}
  } as never;
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("Story campaign tools", () => {
  it("renders Campaign Tools only through the optional Story header slot", () => {
    const { document } = parseHTML("<body><div id=app></div></body>").window;
    const root = document.querySelector<HTMLElement>("#app");
    if (!root) throw new Error("Shell fixture is missing.");

    renderAppShell(root, "<main>Story</main>", "story", {
      headerToolsMarkup: '<details data-campaign-tools><summary>Campaign Tools</summary><button type="button">Current World Setup</button></details>'
    });

    expect(root.querySelector(".site-header [data-campaign-tools] summary")?.textContent).toBe("Campaign Tools");
    expect(root.querySelector("[data-campaign-tools]")?.textContent).toContain("Current World Setup");
    expect(root.querySelector("[data-story-tools-rail]")).toBeNull();
  });

  it("closes the native Campaign Tools disclosure on Escape and restores its trigger focus", () => {
    const { document, Event } = parseHTML(`<body>${storyCampaignToolsMarkup()}</body>`).window;
    const tools = document.querySelector<HTMLDetailsElement>("[data-campaign-tools]");
    const summary = tools?.querySelector<HTMLElement>("summary");
    if (!tools || !summary) throw new Error("Campaign tools fixture is missing.");
    const focus = vi.spyOn(summary, "focus");
    tools.open = true;
    const dispose = installStoryToolsDisclosure(tools);

    const escape = new Event("keydown", { bubbles: true, cancelable: true });
    Object.defineProperty(escape, "key", { value: "Escape" });
    tools.dispatchEvent(escape);

    expect(tools.open).toBe(false);
    expect(focus).toHaveBeenCalledTimes(1);
    dispose();
  });

  it("closes the native Campaign Tools disclosure when focus leaves or a pointer lands outside", async () => {
    const { document, Event } = parseHTML(`<body>${storyCampaignToolsMarkup()}<button id=outside>Outside</button></body>`).window;
    const tools = document.querySelector<HTMLDetailsElement>("[data-campaign-tools]");
    const outside = document.querySelector<HTMLElement>("#outside");
    if (!tools || !outside) throw new Error("Campaign tools fixture is missing.");
    const dispose = installStoryToolsDisclosure(tools);

    tools.open = true;
    document.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(tools.open).toBe(false);

    tools.open = true;
    Object.defineProperty(document, "activeElement", { configurable: true, value: outside });
    tools.dispatchEvent(new Event("focusout", { bubbles: true }));
    await settle();
    expect(tools.open).toBe(false);
    dispose();
  });

  it("mounts every approved Campaign Tools command in the Story header only", async () => {
    const { document } = parseHTML("<body><div id=app></div></body>").window;
    const root = document.querySelector<HTMLElement>("#app");
    if (!root) throw new Error("Story fixture is missing.");
    const mounted = mountStoryPlayerPage(root, { campaignId, turnNumber: null }, storyComposition());
    await settle();

    const tools = root.querySelector<HTMLElement>(".site-header [data-campaign-tools]");
    expect(tools?.textContent).toContain("Current World Setup");
    expect(tools?.textContent).toContain("Edit Campaign State");
    expect(tools?.textContent).toContain("Turn History & State");
    expect(tools?.textContent).toContain("Activity Log");
    expect(tools?.textContent).toContain("PDF + images");
    expect(root.querySelector("[data-story-tools-rail]")).toBeNull();
    mounted.dispose();
  });

  it("keeps generic state reads separate from the explicit persisted-turn inspection path", async () => {
    const { tools, campaigns } = controller();

    await tools.openCurrentState();
    const state = await tools.openTurnState(olderTurn.turnNumber);

    expect(campaigns.state).toHaveBeenCalledWith(campaignId, undefined, undefined);
    expect(campaigns.inspectState).toHaveBeenCalledWith(campaignId, olderTurn.turnNumber, undefined);
    expect(state).toEqual(expect.objectContaining({ recordedResolution: expect.any(Object) }));
  });

  it("writes only current campaign state and keeps the caller draft when the save fails", async () => {
    const error = new Error("State save failed");
    const { tools, campaigns, reload } = controller();
    campaigns.updateState.mockRejectedValueOnce(error);

    await expect(tools.saveCurrentState({ continuitySummary: "Keep this draft.", expectedTurnNumber: 7 } as never)).rejects.toThrow("State save failed");

    expect(campaigns.updateState).toHaveBeenCalledWith(campaignId, { continuitySummary: "Keep this draft.", expectedTurnNumber: 7 }, undefined);
    expect(reload).not.toHaveBeenCalled();
  });

  it("single-flights duplicate current-state saves", async () => {
    const first = deferred<{ campaignId: string; viewedTurnNumber: number }>();
    const { tools, campaigns } = controller();
    campaigns.updateState.mockReturnValueOnce(first.promise);
    const request = { continuitySummary: "Keep this draft.", expectedTurnNumber: 7 } as never;

    const saving = tools.saveCurrentState(request);
    expect(await tools.saveCurrentState(request)).toBeNull();
    expect(campaigns.updateState).toHaveBeenCalledTimes(1);

    first.resolve({ campaignId, viewedTurnNumber: 7 });
    await expect(saving).resolves.toEqual({ campaignId, viewedTurnNumber: 7 });
  });

  it("uses the persisted latest turn ID for append-only narration correction", async () => {
    const { tools, campaigns, reload, confirm } = controller();

    await tools.saveNarrationCorrection(latestTurn.id, { narration: "A corrected sentence." } as never);

    expect(confirm).toHaveBeenCalledWith("correct-narration", expect.objectContaining({ turnId: latestTurn.id, turnNumber: 7 }));
    expect(campaigns.correctTurnNarration).toHaveBeenCalledWith(campaignId, latestTurn.id, { narration: "A corrected sentence." }, undefined);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("single-flights duplicate narration corrections", async () => {
    const first = deferred<{ turnId: string; narration: string }>();
    const { tools, campaigns } = controller();
    campaigns.correctTurnNarration.mockReturnValueOnce(first.promise);
    const request = { narration: "A corrected sentence." } as never;

    const saving = tools.saveNarrationCorrection(latestTurn.id, request);
    await settle();
    expect(await tools.saveNarrationCorrection(latestTurn.id, request)).toBeNull();
    expect(campaigns.correctTurnNarration).toHaveBeenCalledTimes(1);

    first.resolve({ turnId: latestTurn.id, narration: "A corrected sentence." });
    await expect(saving).resolves.toEqual({ turnId: latestTurn.id, narration: "A corrected sentence." });
  });

  it("rewinds only the confirmed current persisted turn", async () => {
    const { tools, campaigns, reload, confirm } = controller();

    await tools.undoLatest();

    expect(confirm).toHaveBeenCalledWith("undo-latest", { activeTurnNumber: 7 });
    expect(campaigns.rewind).toHaveBeenCalledWith(campaignId, {
      targetTurnNumber: 6,
      expectedCurrentTurnNumber: 7
    }, undefined);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("does not mutate current state while an older turn is selected or generation is active", async () => {
    const current = {
      campaignId,
      syncToken: "story-tools",
      activeTurnNumber: 7,
      generationActive: false,
      viewTurnNumber: 6,
      turns: [olderTurn, latestTurn]
    };
    const { tools, campaigns, confirm } = controller({ current: () => current });

    expect(await tools.undoLatest()).toBe(false);
    expect(confirm).not.toHaveBeenCalled();
    expect(campaigns.rewind).not.toHaveBeenCalled();
  });

  it("retries only the persisted latest turn through replacement generation", async () => {
    const { tools, generation, confirm } = controller();
    const submission = {
      action: latestTurn.action,
      requestedInputMode: "action" as const,
      resolvedInputMode: "action" as const,
      inputModeSource: "explicit" as const
    };

    await tools.retryLatest(latestTurn.id, submission);

    expect(confirm).toHaveBeenCalledWith("retry-latest", expect.objectContaining({ turnId: latestTurn.id, turnNumber: 7 }));
    expect(generation.submitReplacement).toHaveBeenCalledWith(latestTurn.id, submission);
  });

  it("refuses a Retry Latest submission when the pinned persisted turn is no longer latest", async () => {
    let current = {
      campaignId,
      syncToken: "story-tools",
      activeTurnNumber: 7,
      generationActive: false,
      viewTurnNumber: 7,
      turns: [olderTurn, latestTurn]
    };
    const { tools, generation } = controller({ current: () => current });
    current = {
      ...current,
      activeTurnNumber: 8,
      viewTurnNumber: 8,
      turns: [...current.turns, { id: "55555555-5555-4555-8555-555555555555", turnNumber: 8, action: "A newer prompt." }]
    };

    expect(await tools.retryLatest(latestTurn.id, {
      action: latestTurn.action,
      requestedInputMode: "action",
      resolvedInputMode: "action",
      inputModeSource: "explicit"
    })).toBe(false);
    expect(generation.submitReplacement).not.toHaveBeenCalled();
  });

  it("keeps branch navigation separate from authoritative rewind", async () => {
    const { tools, campaigns, navigate, reload } = controller();

    await tools.restartFromTurn(olderTurn.turnNumber, "branch");

    expect(campaigns.branch).toHaveBeenCalledWith(campaignId, {
      targetTurnNumber: 6,
      expectedCurrentTurnNumber: 7
    }, undefined);
    expect(campaigns.rewind).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith("44444444-4444-4444-8444-444444444444");
    expect(reload).not.toHaveBeenCalled();
  });

  it("downloads the backend Markdown export only after complete history and revokes its object URL", async () => {
    const history = vi.fn().mockResolvedValue(undefined);
    const readableExport = vi.fn().mockResolvedValue({ body: "# Accepted story" });
    const createObjectUrl = vi.fn().mockReturnValue("blob:story-export");
    const revokeObjectUrl = vi.fn();
    const { document } = parseHTML("<body></body>").window;
    const append = vi.spyOn(document.body, "append");
    const { tools } = controller({
      current: () => ({
        campaignId,
        campaignTitle: "The Astral Expedition",
        syncToken: "story-tools",
        activeTurnNumber: 7,
        generationActive: false,
        viewTurnNumber: 7,
        turns: [olderTurn, latestTurn]
      }),
      completeHistory: history,
      readableExport,
      browser: { document, createObjectUrl, revokeObjectUrl }
    });

    await expect((tools as unknown as StoryExportTools).exportMarkdown()).resolves.toBe(true);

    expect(history).toHaveBeenCalledTimes(1);
    expect(readableExport).toHaveBeenCalledWith(campaignId, "markdown");
    expect(createObjectUrl).toHaveBeenCalledTimes(1);
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:story-export");
    expect((append.mock.calls[0]?.[0] as HTMLAnchorElement).download).toBe("the-astral-expedition.md");
  });

  it("records and copies only closed operational activity diagnostics", async () => {
    const copyText = vi.fn().mockResolvedValue(undefined);
    const { tools } = controller({ copyText });
    const activity = tools as unknown as StoryActivityTools;

    const record = activity.recordActivity("generation_queued", {
      campaignId,
      turnNumber: 7,
      jobId: "44444444-4444-4444-8444-444444444444",
      narration: "This accepted narration must never enter diagnostics.",
      prompt: "Nor can this prompt.",
      providerResponse: "Or raw provider output."
    });

    expect(record).toEqual(expect.objectContaining({ category: "generation", title: "Generation queued", detail: `campaignId=${campaignId} turnNumber=7 jobId=44444444-4444-4444-8444-444444444444` }));
    await expect(activity.copyActivityDiagnostics()).resolves.toBe(true);
    expect(copyText).toHaveBeenCalledWith(expect.stringContaining("campaignId="));
    expect(copyText).not.toHaveBeenCalledWith(expect.stringContaining("accepted narration"));
    expect(activity.activity()).toHaveLength(1);
    activity.clearActivity();
    expect(activity.activity()).toEqual([]);
  });

  it("rejects caller-controlled narration and prompt text from activity diagnostics", async () => {
    const copyText = vi.fn().mockResolvedValue(undefined);
    const { tools } = controller({ copyText });
    const activity = tools as unknown as StoryActivityTools;

    expect(activity.recordActivity("The private narration must not be copied.", { prompt: "The secret prompt must not be copied." })).toBeNull();
    await expect(activity.copyActivityDiagnostics()).resolves.toBe(true);

    expect(copyText).toHaveBeenCalledWith("");
  });

  it("does not copy private values passed under allowlisted activity detail keys", async () => {
    const copyText = vi.fn().mockResolvedValue(undefined);
    const { tools } = controller({ copyText });
    const activity = tools as unknown as StoryActivityTools;
    const privateNarration = "The hidden narration must not enter copied diagnostics.";
    const privatePrompt = "The private prompt must not enter copied diagnostics.";

    const record = activity.recordActivity("generation_queued", {
      campaignId,
      turnNumber: 7,
      jobId: "44444444-4444-4444-8444-444444444444",
      status: privateNarration,
      correlationId: privatePrompt
    });
    await expect(activity.copyActivityDiagnostics()).resolves.toBe(true);

    expect(record?.detail).toBe(`campaignId=${campaignId} turnNumber=7 jobId=44444444-4444-4444-8444-444444444444`);
    expect(copyText).not.toHaveBeenCalledWith(expect.stringContaining(privateNarration));
    expect(copyText).not.toHaveBeenCalledWith(expect.stringContaining(privatePrompt));
  });

  it("downloads the backend standalone HTML export with a safely derived filename", async () => {
    const history = vi.fn().mockResolvedValue(undefined);
    const readableExport = vi.fn().mockResolvedValue({ body: "<!doctype html><title>Accepted story</title>" });
    const createObjectUrl = vi.fn().mockReturnValue("blob:story-export-html");
    const revokeObjectUrl = vi.fn();
    const { document } = parseHTML("<body></body>").window;
    const append = vi.spyOn(document.body, "append");
    const { tools } = controller({
      current: () => ({ campaignId, campaignTitle: "The Astral Expedition", syncToken: "story-tools", activeTurnNumber: 7, generationActive: false, viewTurnNumber: 7, turns: [olderTurn, latestTurn] }),
      completeHistory: history,
      readableExport,
      browser: { document, createObjectUrl, revokeObjectUrl }
    });

    await expect((tools as unknown as StoryExportTools).exportStandaloneHtml()).resolves.toBe(true);

    expect(readableExport).toHaveBeenCalledWith(campaignId, "html");
    expect(createObjectUrl).toHaveBeenCalledTimes(1);
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:story-export-html");
    expect((append.mock.calls[0]?.[0] as HTMLAnchorElement).download).toBe("the-astral-expedition.html");
  });

  it("writes no export when complete history fails or is superseded", async () => {
    const history = vi.fn().mockRejectedValue(new Error("history unavailable"));
    const readableExport = vi.fn();
    const createObjectUrl = vi.fn();
    const { document } = parseHTML("<body></body>").window;
    const { tools } = controller({
      completeHistory: history,
      readableExport,
      browser: { document, createObjectUrl, revokeObjectUrl: vi.fn() }
    });

    await expect((tools as unknown as StoryExportTools).exportMarkdown()).resolves.toBe(false);

    expect(readableExport).not.toHaveBeenCalled();
    expect(createObjectUrl).not.toHaveBeenCalled();
  });

  it("allows complete history to prepend older turns without treating it as export supersession", async () => {
    let current = {
      campaignId,
      campaignTitle: "The Astral Expedition",
      syncToken: "story-tools",
      activeTurnNumber: 7,
      generationActive: false,
      viewTurnNumber: 7,
      turns: [latestTurn]
    };
    const readableExport = vi.fn().mockResolvedValue({ body: "# Accepted story" });
    const createObjectUrl = vi.fn().mockReturnValue("blob:full-history-export");
    const { document } = parseHTML("<body></body>").window;
    const { tools } = controller({
      current: () => current,
      completeHistory: async () => { current = { ...current, turns: [olderTurn, latestTurn] }; },
      readableExport,
      browser: { document, createObjectUrl, revokeObjectUrl: vi.fn() }
    });

    await expect((tools as unknown as StoryExportTools).exportMarkdown()).resolves.toBe(true);

    expect(readableExport).toHaveBeenCalledWith(campaignId, "markdown");
  });

  it("does not download a readable export after a same-campaign sync-token refresh", async () => {
    let current = {
      campaignId,
      campaignTitle: "The Astral Expedition",
      syncToken: "before-refresh",
      activeTurnNumber: 7,
      generationActive: false,
      viewTurnNumber: 7,
      turns: [olderTurn, latestTurn]
    };
    const readable = deferred<{ body: string }>();
    const readableExport = vi.fn().mockReturnValue(readable.promise);
    const createObjectUrl = vi.fn();
    const { document } = parseHTML("<body></body>").window;
    const { tools } = controller({
      current: () => current,
      completeHistory: vi.fn().mockResolvedValue(undefined),
      readableExport,
      browser: { document, createObjectUrl, revokeObjectUrl: vi.fn() }
    });

    const exporting = (tools as unknown as StoryExportTools).exportMarkdown();
    await settle();
    current = { ...current, syncToken: "after-correction" };
    readable.resolve({ body: "# stale export" });

    await expect(exporting).resolves.toBe(false);
    expect(createObjectUrl).not.toHaveBeenCalled();
  });

  it("opens a print window synchronously and writes only complete, sanitized story content", async () => {
    const history = deferred<void>();
    const document = {
      open: vi.fn(),
      write: vi.fn(),
      close: vi.fn(),
      images: []
    };
    const printWindow = { document, close: vi.fn(), print: vi.fn(), opener: {} };
    const openPrintWindow = vi.fn().mockReturnValue(printWindow);
    const printSnapshot = vi.fn().mockResolvedValue({
      title: "The <Astral> Expedition",
      turns: [{
        turnNumber: 7,
        action: "Open <the> observatory.",
        narration: "The <script> stars answer.",
        imageUrls: ["https://story.example.test/assets/accepted.png", "https://external.example.test/not-allowed.png"]
      }]
    });
    const { tools } = controller({
      completeHistory: () => history.promise,
      printSnapshot,
      browser: { document: parseHTML("<body></body>").window.document, createObjectUrl: vi.fn(), revokeObjectUrl: vi.fn(), openPrintWindow, printOrigin: "https://story.example.test", printStyles: "@page { margin: 18mm; }" }
    });

    const printing = (tools as unknown as StoryPrintTools).printStory();

    expect(openPrintWindow).toHaveBeenCalledWith("", "_blank");
    expect(document.write).not.toHaveBeenCalled();
    history.resolve();
    await expect(printing).resolves.toBe(true);
    expect(document.write).toHaveBeenCalledWith(expect.stringContaining("The &lt;Astral&gt; Expedition"));
    expect(document.write).toHaveBeenCalledWith(expect.stringContaining("@page { margin: 18mm; }"));
    expect(document.write).toHaveBeenCalledWith(expect.stringContaining("/assets/accepted.png"));
    expect(document.write).not.toHaveBeenCalledWith(expect.stringContaining("external.example.test"));
    expect(printWindow.print).toHaveBeenCalledTimes(1);
  });

  it("closes a print window without writing or printing after a same-campaign sync-token refresh", async () => {
    let current = {
      campaignId,
      campaignTitle: "The Astral Expedition",
      syncToken: "before-refresh",
      activeTurnNumber: 7,
      generationActive: false,
      viewTurnNumber: 7,
      turns: [olderTurn, latestTurn]
    };
    const snapshot = deferred<{ title: string; turns: [] }>();
    const document = { open: vi.fn(), write: vi.fn(), close: vi.fn(), images: [] };
    const printWindow = { document, close: vi.fn(), print: vi.fn(), opener: {} };
    const { tools } = controller({
      current: () => current,
      completeHistory: vi.fn().mockResolvedValue(undefined),
      printSnapshot: vi.fn().mockReturnValue(snapshot.promise),
      browser: {
        document: parseHTML("<body></body>").window.document,
        createObjectUrl: vi.fn(),
        revokeObjectUrl: vi.fn(),
        openPrintWindow: vi.fn().mockReturnValue(printWindow),
        printOrigin: "https://story.example.test"
      }
    });

    const printing = (tools as unknown as StoryPrintTools).printStory();
    await settle();
    current = { ...current, syncToken: "after-correction" };
    snapshot.resolve({ title: "The Astral Expedition", turns: [] });

    await expect(printing).resolves.toBe(false);
    expect(document.write).not.toHaveBeenCalled();
    expect(printWindow.print).not.toHaveBeenCalled();
    expect(printWindow.close).toHaveBeenCalledTimes(1);
  });

  it("closes a print window without printing when the sync token changes during image settlement", async () => {
    let current = {
      campaignId,
      campaignTitle: "The Astral Expedition",
      syncToken: "before-images",
      activeTurnNumber: 7,
      generationActive: false,
      viewTurnNumber: 7,
      turns: [olderTurn, latestTurn]
    };
    const listeners = new Map<string, () => void>();
    const image = {
      complete: false,
      addEventListener: vi.fn((event: string, listener: () => void) => listeners.set(event, listener))
    };
    const document = { open: vi.fn(), write: vi.fn(), close: vi.fn(), images: [image] };
    const printWindow = { document, close: vi.fn(), print: vi.fn(), opener: {} };
    const { tools } = controller({
      current: () => current,
      completeHistory: vi.fn().mockResolvedValue(undefined),
      printSnapshot: vi.fn().mockResolvedValue({ title: "The Astral Expedition", turns: [] }),
      browser: {
        document: parseHTML("<body></body>").window.document,
        createObjectUrl: vi.fn(),
        revokeObjectUrl: vi.fn(),
        openPrintWindow: vi.fn().mockReturnValue(printWindow),
        printOrigin: "https://story.example.test"
      }
    });

    const printing = (tools as unknown as StoryPrintTools).printStory();
    await settle();
    current = { ...current, syncToken: "after-correction" };
    listeners.get("load")?.();

    await expect(printing).resolves.toBe(false);
    expect(document.write).toHaveBeenCalledTimes(1);
    expect(printWindow.print).not.toHaveBeenCalled();
    expect(printWindow.close).toHaveBeenCalledTimes(1);
  });

  it("loads About through the shared meta API", async () => {
    const expected = { application: { name: "Infinite Quest Nexus", version: "2026.08", commit: null, builtAt: null } };
    const meta = { get: vi.fn().mockResolvedValue(expected) };
    const { tools } = controller({ meta });

    await expect((tools as unknown as StoryAboutTools).openAbout()).resolves.toEqual(expected);

    expect(meta.get).toHaveBeenCalledWith(undefined);
  });
});
