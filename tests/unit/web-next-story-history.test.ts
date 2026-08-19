import { describe, expect, it, vi } from "vitest";
import { createCampaignStore } from "../../packages/client-core/src/index.js";
import type { CampaignSyncStatus, TurnListResponse, TurnSummary } from "../../packages/contracts/src/index.js";
import { createStoryUiModel } from "../../apps/web-next/src/story-player-model.js";
import {
  alignLatestSpine,
  createStoryHistoryController,
  latestCampaignSpine
} from "../../apps/web-next/src/story-player-history.js";

const campaignId = "11111111-1111-4111-8111-111111111111";
const otherCampaignId = "22222222-2222-4222-8222-222222222222";

function turn(turnNumber: number): TurnSummary {
  return {
    id: `00000000-0000-4000-8000-${String(turnNumber).padStart(12, "0")}`,
    turnNumber,
    action: `Action ${turnNumber}`,
    inputMode: "action",
    inputModeSource: "explicit",
    narration: `Narration ${turnNumber}.`,
    choices: [],
    customActionSuggestion: "",
    imagePrompt: "",
    imageUrl: null,
    acceptedAt: "2026-08-18T00:00:00.000Z",
    chronicleRetrieval: null,
    reportedCost: null
  };
}

function sync(turns: readonly TurnSummary[], nextCursor: string | null = null, syncToken = "sync-1"): CampaignSyncStatus {
  const campaign = {
    id: campaignId, title: "History campaign", activeTurnNumber: turns.at(-1)?.turnNumber ?? 0,
    worldVersionId: "33333333-3333-4333-8333-333333333333", storyLengthProfile: "standard" as const,
    turnControlStyle: "action_only" as const, updatedAt: "2026-08-18T00:00:00.000Z",
    selectedCharacterId: null, selectedCharacterName: "", characterSnapshot: null, characterProfile: null,
    characterProfileRevision: 0, status: "active" as const
  };
  return {
    ...campaign, campaign, syncToken, turnWindowMode: "replace", turns: { campaignId, turns, nextCursor },
    world: { id: "44444444-4444-4444-8444-444444444444", title: "World", versionNumber: 1, genre: "", tone: "", premise: "", backgroundStory: "", character: "", firstAction: "", rules: "", playableCharacters: [] },
    playerConfig: { selectedCharacterId: null, selectedCharacterName: "", characterSnapshot: null, characterProfile: null, characterProfileRevision: 0, rpgStats: [], trackers: [], eventTriggers: [], useRpgStats: false, suppressEventTriggers: false },
    pendingGeneration: null, generationRecovery: null
  } as CampaignSyncStatus;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => { resolve = nextResolve; reject = nextReject; });
  return { promise, resolve, reject };
}

function setup(initialTurns = [turn(6), turn(7), turn(8), turn(9), turn(10)], nextCursor: string | null = null) {
  const campaignStore = createCampaignStore();
  campaignStore.load(sync(initialTurns, nextCursor));
  const ui = createStoryUiModel({ viewTurnNumber: initialTurns.at(-1)?.turnNumber ?? null });
  const turns = vi.fn<() => Promise<TurnListResponse>>();
  const state = vi.fn();
  const controller = createStoryHistoryController({
    campaigns: { turns, state } as never,
    campaignStore,
    model: ui
  });
  controller.sync(campaignStore.store.get());
  return { campaignStore, controller, state, turns, ui };
}

describe("Story History controller", () => {
  it("keeps the newest five persisted turns ascending while an older turn is selected", () => {
    const turns = Array.from({ length: 9 }, (_, index) => turn(index + 1));
    const { controller, ui } = setup(turns);

    expect(latestCampaignSpine(turns).map((item) => item.turnNumber)).toEqual([5, 6, 7, 8, 9]);
    controller.jump(2);
    expect(ui.get().viewTurnNumber).toBe(2);
    expect(latestCampaignSpine(turns).map((item) => item.turnNumber)).toEqual([5, 6, 7, 8, 9]);
  });

  it("loads an older cursor page before selecting Previous across the window boundary", async () => {
    const { campaignStore, controller, turns, ui } = setup([turn(6), turn(7)], "before-6");
    ui.setViewTurnNumber(6);
    turns.mockResolvedValue({ campaignId, turns: [turn(4), turn(5)], nextCursor: null });

    await controller.previous();

    expect(turns).toHaveBeenCalledWith(campaignId, { before: "before-6", limit: 200 }, undefined);
    expect(campaignStore.store.get().turns.map((item) => item.turnNumber)).toEqual([4, 5, 6, 7]);
    expect(ui.get().viewTurnNumber).toBe(5);
  });

  it("does not navigate Next beyond the authoritative active turn", async () => {
    const { controller, ui } = setup([turn(6), turn(7), turn(8)]);
    ui.setViewTurnNumber(8);

    await controller.next();

    expect(ui.get().viewTurnNumber).toBe(8);
  });

  it("ignores a slow page when a later sync replaces the campaign window", async () => {
    const { campaignStore, controller, turns, ui } = setup([turn(6), turn(7)], "before-6");
    ui.setViewTurnNumber(6);
    const delayed = deferred<TurnListResponse>();
    turns.mockReturnValue(delayed.promise);
    const loading = controller.previous();

    campaignStore.load(sync([turn(8), turn(9), turn(10)], "before-8", "sync-2"));
    controller.sync(campaignStore.store.get());
    delayed.resolve({ campaignId, turns: [turn(4), turn(5)], nextCursor: null });
    await loading;

    expect(campaignStore.store.get().turns.map((item) => item.turnNumber)).toEqual([8, 9, 10]);
    expect(ui.get().viewTurnNumber).toBe(6);
  });

  it("walks complete history once, preserves the bounded window on failure, then retries from current authority", async () => {
    const { campaignStore, controller, turns, ui } = setup([turn(6), turn(7)], "before-6");
    turns.mockResolvedValueOnce({ campaignId, turns: [turn(4), turn(5)], nextCursor: "before-4" })
      .mockRejectedValueOnce(new Error("provider unavailable"));

    const first = controller.openCompleteHistory();
    expect(controller.openCompleteHistory()).toBe(first);
    await expect(first).rejects.toThrow("provider unavailable");
    expect(ui.get().history).toBe("error");
    expect(campaignStore.store.get().turns.map((item) => item.turnNumber)).toEqual([6, 7]);

    turns.mockResolvedValueOnce({ campaignId, turns: [turn(4), turn(5)], nextCursor: "before-4" })
      .mockResolvedValueOnce({ campaignId, turns: [turn(1), turn(2), turn(3)], nextCursor: null });
    await controller.retryCompleteHistory();

    expect(campaignStore.store.get().turns.map((item) => item.turnNumber)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(ui.get().history).toBe("idle");
  });

  it("does not publish complete history after a campaign epoch changes", async () => {
    const { campaignStore, controller, turns } = setup([turn(6), turn(7)], "before-6");
    const delayed = deferred<TurnListResponse>();
    turns.mockReturnValue(delayed.promise);
    const loading = controller.openCompleteHistory();

    campaignStore.load(sync([turn(8), turn(9)], "before-8", "sync-2"));
    controller.sync(campaignStore.store.get());
    delayed.resolve({ campaignId, turns: [turn(1)], nextCursor: null });
    await expect(loading).resolves.toEqual({ campaignId, turns: [turn(8), turn(9)], nextCursor: "before-8" });
    expect(campaignStore.store.get().turns.map((item) => item.turnNumber)).toEqual([8, 9]);
  });

  it("guards historical state reads by campaign and request epoch", async () => {
    const { campaignStore, controller, state } = setup([turn(6), turn(7)]);
    const delayed = deferred<unknown>();
    state.mockReturnValue(delayed.promise);
    const inspection = controller.inspect(6);
    const switched = sync([turn(1)]);
    campaignStore.load({
      ...switched,
      id: otherCampaignId,
      campaign: { ...switched.campaign, id: otherCampaignId },
      turns: { ...switched.turns!, campaignId: otherCampaignId }
    } as CampaignSyncStatus);
    controller.sync(campaignStore.store.get());
    delayed.resolve({ campaignId, turnNumber: 6 });

    await expect(inspection).resolves.toBeNull();
  });

  it("latest-aligns the compact spine safely when test DOMs do not implement scrollTo", () => {
    const scrollTo = vi.fn();
    alignLatestSpine({ scrollWidth: 420, scrollTo } as unknown as HTMLElement, (callback) => callback());
    expect(scrollTo).toHaveBeenCalledWith({ left: 420 });
    expect(() => alignLatestSpine({ scrollWidth: 420 } as HTMLElement, (callback) => callback())).not.toThrow();
  });
});
