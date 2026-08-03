import { describe, expect, it } from "vitest";
import type { CampaignRuntimeStateResponse, CampaignSyncStatus, TurnListResponse, TurnSummary } from "../../../packages/contracts/src/index.js";
import {
  CampaignProjectionProtocolError,
  createCampaignStore,
  selectHistorySyncRequired,
  selectLatestAcceptedTurn,
  selectLatestAcceptedTurnNumber,
  selectRequestedTurnInputMode,
  selectRuntimeState
} from "../../../packages/client-core/src/index.js";
import type { GenerationRun } from "../../../packages/client-core/src/index.js";

const campaignId = "11111111-1111-4111-8111-111111111111";
const otherCampaignId = "22222222-2222-4222-8222-222222222222";
const worldVersionId = "33333333-3333-4333-8333-333333333333";
const turnOneId = "44444444-4444-4444-8444-444444444444";
const turnTwoId = "55555555-5555-4555-8555-555555555555";
const turnThreeId = "66666666-6666-4666-8666-666666666666";
const jobId = "77777777-7777-4777-8777-777777777777";

function turn(turnNumber: number, id = turnNumber === 1 ? turnOneId : turnTwoId): TurnSummary {
  return {
    id,
    turnNumber,
    action: `action ${turnNumber}`,
    inputMode: "action",
    inputModeSource: "explicit",
    narration: `narration ${turnNumber}`,
    choices: [`choice ${turnNumber}`],
    customActionSuggestion: "",
    imagePrompt: "",
    imageUrl: null,
    acceptedAt: "2026-08-03T12:00:00.000Z",
    reportedCost: null
  };
}

function sync(overrides: Partial<CampaignSyncStatus> = {}): CampaignSyncStatus {
  const campaign = {
    id: campaignId,
    title: "Campaign",
    activeTurnNumber: 2,
    worldVersionId,
    storyLengthProfile: "standard" as const,
    updatedAt: "2026-08-03T12:00:00.000Z",
    selectedCharacterId: null,
    selectedCharacterName: "",
    characterSnapshot: { nested: { value: "original" } },
    characterProfile: null,
    characterProfileRevision: 0,
    status: "active" as const
  };
  return {
    ...campaign,
    campaign,
    world: {
      id: "88888888-8888-4888-8888-888888888888",
      title: "World",
      versionNumber: 1,
      genre: "fantasy",
      tone: "hopeful",
      premise: "A test world.",
      backgroundStory: "",
      character: "",
      firstAction: "Begin.",
      rules: "",
      playableCharacters: []
    },
    playerConfig: {
      selectedCharacterId: null,
      selectedCharacterName: "",
      characterSnapshot: { nested: { choices: ["original"] } },
      characterProfile: null,
      characterProfileRevision: 0,
      rpgStats: [],
      trackers: [],
      eventTriggers: [],
      useRpgStats: false,
      suppressEventTriggers: false
    },
    pendingGeneration: null,
    syncToken: "sync-1",
    generationRecovery: null,
    turnWindowMode: "replace",
    turns: { campaignId, turns: [turn(2), turn(1)], nextCursor: "older-1" },
    ...overrides
  } as CampaignSyncStatus;
}

function syncForCampaign(id: string): CampaignSyncStatus {
  const value = sync();
  return {
    ...value,
    id,
    campaign: { ...value.campaign, id },
    turns: value.turns === null ? null : { ...value.turns, campaignId: id }
  } as CampaignSyncStatus;
}

function runtime(id = campaignId): CampaignRuntimeStateResponse {
  return {
    campaignId: id,
    activeTurnNumber: 2,
    viewedTurnNumber: 2,
    isCurrent: true,
    revision: 3,
    updatedAt: "2026-08-03T12:00:00.000Z",
    continuitySummary: "summary",
    openThreads: ["thread"],
    canonicalFacts: [{ id: null, content: "fact" }],
    scratchpad: "notes",
    trackers: [{ id: "tracker", name: "Tracker", value: "1", rules: "" }],
    rpgStats: [],
    eventTriggers: [],
    pendingEventTriggers: []
  };
}

function page(turns: TurnSummary[], id = campaignId, nextCursor: string | null = null): TurnListResponse {
  return { campaignId: id, turns, nextCursor };
}

function run(id = campaignId): GenerationRun {
  return {
    campaignId: id,
    jobId,
    operationKind: "append",
    replacementTurnId: null,
    watch: async function* () {},
    retryGeneration: async function* () {},
    cancelGeneration: async () => ({ id: jobId, status: "cancelled", operationKind: "append", replacementTurnId: null }),
    discardGeneration: async () => ({ id: jobId, status: "discarded", operationKind: "append", replacementTurnId: null }),
    fetchResult: async () => ({ type: "result_unavailable", jobId, error: new Error("not available") })
  };
}

function expectProtocol(action: () => void, kind: string): void {
  try {
    action();
    throw new Error("expected protocol error");
  } catch (error) {
    expect(error).toBeInstanceOf(CampaignProjectionProtocolError);
    expect(error).toMatchObject({ kind });
  }
}

describe("campaign store hydration", () => {
  it("starts with the complete empty campaign projection", () => {
    const state = createCampaignStore().store.get();

    expect(state).toMatchObject({
      campaign: null,
      turns: [],
      nextTurnsCursor: null,
      syncToken: null,
      historySyncRequired: false,
      runtimeState: null,
      latestStateSnapshot: null,
      requestedTurnInputMode: "action",
      nextTurnInputModeSource: null,
      generation: null
    });
  });

  it("uses nested campaign identity, recursively copies ingress, and normalizes replacement turns", () => {
    const controller = createCampaignStore();
    const incoming = sync();
    controller.load(incoming);
    incoming.campaign.title = "mutated";
    (incoming.campaign.characterSnapshot as { nested: { value: string } }).nested.value = "mutated";
    incoming.turns!.turns[0]!.choices.push("mutated");

    expect(controller.store.get().campaign).toMatchObject({ id: campaignId, title: "Campaign", characterSnapshot: { nested: { value: "original" } } });
    expect(controller.store.get().turns.map((item) => item.turnNumber)).toEqual([1, 2]);
    expect(controller.store.get().turns[1]?.choices).toEqual(["choice 2"]);
  });

  it("rejects malformed sync identity and duplicate turn windows without mutation", () => {
    const controller = createCampaignStore();
    controller.load(sync());
    const before = controller.store.get();

    expectProtocol(() => controller.load(sync({ id: otherCampaignId })), "campaign_mismatch");
    expectProtocol(() => controller.load(sync({ turns: page([turn(1), turn(1, turnThreeId)]) })), "duplicate_turn_number");
    expectProtocol(() => controller.load(sync({ turns: page([turn(1), turn(2, turnOneId)]) })), "duplicate_turn_id");
    expect(controller.store.get()).toBe(before);
  });

  it("keeps the bounded window only for a valid same-campaign unchanged sync", () => {
    const controller = createCampaignStore();
    controller.load(sync());
    const beforeTurns = controller.store.get().turns;
    controller.load(sync({ syncToken: "sync-2", turnWindowMode: "unchanged", turns: null }));

    expect(controller.store.get().turns).toBe(beforeTurns);
    expect(controller.store.get().nextTurnsCursor).toBe("older-1");
    expect(controller.store.get().syncToken).toBe("sync-2");

    const fresh = createCampaignStore();
    expectProtocol(() => fresh.load(sync({ turnWindowMode: "unchanged", turns: null })), "unchanged_window_without_baseline");
    expect(fresh.store.get().campaign).toBeNull();
  });

  it("prepends matching older pages and rejects a cross-campaign page atomically", () => {
    const controller = createCampaignStore();
    controller.load(sync());
    controller.prependOlderTurns(page([turn(0, turnThreeId)], campaignId, "older-2"));
    expect(controller.store.get().turns.map((item) => item.turnNumber)).toEqual([0, 1, 2]);
    expect(controller.store.get().nextTurnsCursor).toBe("older-2");
    const before = controller.store.get();

    expectProtocol(() => controller.prependOlderTurns(page([turn(0, turnThreeId)], otherCampaignId)), "page_campaign_mismatch");
    expect(controller.store.get()).toBe(before);
  });

  it("rejects duplicate IDs across page boundaries before it changes the bounded window", () => {
    const controller = createCampaignStore();
    controller.load(sync());
    const before = controller.store.get();

    expectProtocol(() => controller.prependOlderTurns(page([turn(0, turnOneId)])), "duplicate_turn_id");
    expect(controller.store.get()).toBe(before);
  });

  it("requires a loaded matching campaign for runtime state and generation attachment", () => {
    const controller = createCampaignStore();
    expectProtocol(() => controller.loadRuntimeState(runtime()), "campaign_not_loaded");
    controller.load(sync());
    controller.loadRuntimeState(runtime());
    const loaded = controller.store.get().runtimeState;
    expect(loaded).toMatchObject({ campaignId, revision: 3 });
    expectProtocol(() => controller.loadRuntimeState(runtime(otherCampaignId)), "runtime_state_campaign_mismatch");
    expect(controller.store.get().runtimeState).toBe(loaded);
    expectProtocol(() => controller.attachGeneration(run(otherCampaignId)), "campaign_mismatch");
  });

  it("copies runtime state and allows only the generation hydration allowlist", () => {
    const controller = createCampaignStore();
    controller.load(sync({
      generationRecovery: {
        id: jobId,
        status: "failed",
        expectedTurnNumber: 3,
        attempts: 2,
        operationKind: "append",
        replacementTurnId: null,
        resultTurnId: null,
        errorCode: "generation_failed",
        errorMessage: "Generation could not be completed."
      }
    }));
    const incoming = runtime();
    controller.loadRuntimeState(incoming);
    incoming.canonicalFacts[0]!.content = "mutated";
    incoming.openThreads.push("mutated");

    expect(controller.store.get().runtimeState).toMatchObject({ canonicalFacts: [{ content: "fact" }], openThreads: ["thread"] });
    expect(controller.store.get().generation).toMatchObject({
      origin: "hydrated_recovery",
      result: { state: "failed", message: "Generation could not complete." },
      hydratedGeneration: { action: null, attempts: 2, status: "failed" }
    });
    expect(JSON.stringify(controller.store.get().generation)).not.toContain("errorMessage");
    expect(JSON.stringify(controller.store.get().generation)).not.toContain("errorCode");
  });

  it("prioritizes pending generation and clears completed recovery already in the authoritative window", () => {
    const pending = {
      id: jobId,
      status: "queued" as const,
      action: "wait",
      expectedTurnNumber: 3,
      createdAt: "2026-08-03T12:00:00.000Z",
      updatedAt: "2026-08-03T12:00:00.000Z",
      operationKind: "append" as const,
      replacementTurnId: null
    };
    const recovery = {
      id: jobId,
      status: "completed" as const,
      expectedTurnNumber: 3,
      attempts: 1,
      operationKind: "append" as const,
      replacementTurnId: null,
      resultTurnId: turnThreeId,
      errorCode: null,
      errorMessage: null
    };
    const controller = createCampaignStore();
    controller.load(sync({ pendingGeneration: pending, generationRecovery: recovery }));
    expect(controller.store.get().generation).toMatchObject({ origin: "hydrated_pending", jobId, hydratedGeneration: { source: "pending", action: "wait" } });

    controller.load(sync({
      pendingGeneration: null,
      generationRecovery: recovery,
      turns: page([turn(3, turnThreeId)])
    }));
    expect(controller.store.get().generation).toBeNull();
  });

  it("hydrates completed append and replacement recovery without raw recovery fields", () => {
    const appendRecovery = {
      id: jobId,
      status: "completed" as const,
      expectedTurnNumber: 3,
      attempts: 1,
      operationKind: "append" as const,
      replacementTurnId: null,
      resultTurnId: turnThreeId,
      errorCode: null,
      errorMessage: null
    };
    const replacementRecovery = {
      ...appendRecovery,
      operationKind: "replace_latest" as const,
      replacementTurnId: turnOneId,
      resultTurnId: turnThreeId
    };
    const controller = createCampaignStore();
    controller.load(sync({ generationRecovery: appendRecovery }));
    expect(controller.store.get().generation).toMatchObject({
      operation: { operationKind: "append", replacementTurnId: null },
      result: { state: "unavailable", message: "Accepted result is ready to load.", correlationId: null }
    });

    controller.load(sync({
      generationRecovery: replacementRecovery,
      turns: page([turn(2), turn(1)])
    }));
    expect(controller.store.get().generation).toMatchObject({
      operation: { operationKind: "replace_latest", replacementTurnId: turnOneId },
      hydratedGeneration: { resultTurnId: turnThreeId, attempts: 1 }
    });
  });

  it("invalidates a live session and its projection when authoritative hydration switches campaigns", () => {
    const controller = createCampaignStore();
    controller.load(sync());
    const session = controller.attachGeneration(run());
    expect(controller.store.get().generation).toMatchObject({ jobId, monitoring: "attached" });

    controller.load(syncForCampaign(otherCampaignId));
    session.apply({ type: "narration", text: "late narration" });

    expect(controller.store.get()).toMatchObject({ campaign: { id: otherCampaignId }, generation: null });
  });

  it("keeps campaign-only selectors pure and allocation-free", () => {
    const controller = createCampaignStore();
    controller.load(sync());
    controller.setTurnInput("auto", "auto");
    const state = controller.store.get();

    expect(selectLatestAcceptedTurn(state)).toBe(state.turns[1]);
    expect(selectLatestAcceptedTurnNumber(state)).toBe(2);
    expect(selectRequestedTurnInputMode(state)).toBe("auto");
    expect(selectRuntimeState(state)).toBeNull();
    expect(selectHistorySyncRequired(state)).toBe(false);
  });
});

describe("campaign projection protocol errors", () => {
  it("retains the declared kind", () => {
    expect(new CampaignProjectionProtocolError("job_mismatch")).toMatchObject({ kind: "job_mismatch" });
  });
});
