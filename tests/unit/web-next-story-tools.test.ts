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
      activeTurnNumber: 7,
      generationActive: false,
      viewTurnNumber: 7,
      turns: [olderTurn, latestTurn]
    }),
    ...overrides
  });
  return { tools, campaigns, generation, reload, navigate, confirm };
}

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

    await expect(tools.saveCurrentState({ continuitySummary: "Keep this draft." } as never)).rejects.toThrow("State save failed");

    expect(campaigns.updateState).toHaveBeenCalledWith(campaignId, { continuitySummary: "Keep this draft." }, undefined);
    expect(reload).not.toHaveBeenCalled();
  });

  it("single-flights duplicate current-state saves", async () => {
    const first = deferred<{ campaignId: string; viewedTurnNumber: number }>();
    const { tools, campaigns } = controller();
    campaigns.updateState.mockReturnValueOnce(first.promise);
    const request = { continuitySummary: "Keep this draft." } as never;

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
});
