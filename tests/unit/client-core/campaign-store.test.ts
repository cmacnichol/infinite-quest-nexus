import { describe, expect, it, vi } from "vitest";
import type { CampaignRuntimeStateResponse, CampaignSyncStatus, GenerationResult, GenerationStreamSnapshot, TurnListResponse, TurnSummary } from "../../../packages/contracts/src/index.js";
import {
  CampaignProjectionProtocolError,
  createGenerationWorkflow,
  createCampaignStore,
  selectIsGenerationInFlight,
  selectHistorySyncRequired,
  selectLatestAcceptedTurn,
  selectLatestAcceptedTurnNumber,
  selectRequestedTurnInputMode,
  selectRuntimeState
} from "../../../packages/client-core/src/index.js";
import type { GenerationProjectionSession, GenerationRun } from "../../../packages/client-core/src/index.js";
import type { GenerationApiPort, GenerationSnapshotSource } from "../../../packages/client-core/src/generation/types.js";
import type { AbortSignalLike, PendingSubmissionStore } from "../../../packages/client-core/src/ports.js";
import { ApiContractError, NexusApiError } from "../../../packages/client-core/src/index.js";

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

function replacementRun(target = turnTwoId): GenerationRun {
  return {
    ...run(),
    operationKind: "replace_latest",
    replacementTurnId: target
  };
}

function snapshot(overrides: Partial<GenerationStreamSnapshot> = {}): GenerationStreamSnapshot {
  return {
    id: jobId,
    campaignId,
    expectedTurnNumber: 3,
    status: "generating",
    action: "continue",
    operationKind: "append",
    replacementTurnId: null,
    attempts: 1,
    partialNarration: "partial narration",
    resultTurnId: null,
    errorCode: null,
    errorMessage: null,
    ...overrides
  } as GenerationStreamSnapshot;
}

function result(overrides: Partial<GenerationResult> = {}): GenerationResult {
  return {
    id: jobId,
    status: "completed",
    campaignId,
    expectedTurnNumber: 3,
    resultTurnId: turnThreeId,
    errorCode: null,
    errorMessage: null,
    turnNumber: 3,
    action: "continue",
    inputMode: "action",
    inputModeSource: "explicit",
    narration: "accepted narration",
    choices: ["accepted choice"],
    customActionSuggestion: "",
    imagePrompt: "",
    modelMetadata: null,
    mechanics: null,
    acceptedAt: "2026-08-03T12:00:00.000Z",
    stateSnapshot: { nested: { value: "state" } },
    reportedCost: null,
    ...overrides
  } as GenerationResult;
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

  it("keeps matching live generation attached when authoritative hydration refreshes it", () => {
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
    const controller = createCampaignStore();
    controller.load(sync({ pendingGeneration: pending }));
    controller.attachGeneration(run());

    controller.load(sync({ pendingGeneration: { ...pending, status: "generating" } }));

    expect(controller.store.get().generation).toMatchObject({
      jobId,
      monitoring: "attached",
      hydratedGeneration: { status: "generating" },
      result: { state: "pending" }
    });
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

describe("campaign store generation projection", () => {
  it("reduces stream status into an attached pending projection without exposing hydration", () => {
    const controller = createCampaignStore();
    controller.load(sync());
    const session = controller.attachGeneration(run());

    session.apply({ type: "status", snapshot: snapshot() });

    expect(controller.store.get().generation).toMatchObject({
      jobId,
      monitoring: "attached",
      hydratedGeneration: null,
      snapshot: { id: jobId, status: "generating", partialNarration: "partial narration" },
      transport: { state: "healthy" },
      result: { state: "pending" }
    });
    expect(selectIsGenerationInFlight(controller.store.get())).toBe(true);
  });

  it.each([
    ["narration", (session: GenerationProjectionSession) => session.apply({ type: "narration", text: "new narration" })],
    ["degraded", (session: GenerationProjectionSession) => session.apply({ type: "degraded", reason: "poll_failed", consecutiveFailures: 2 })],
    ["detached", (session: GenerationProjectionSession) => session.apply({ type: "detached", jobId })]
  ])("reduces the %s event without settling its run", (_name, apply) => {
    const controller = createCampaignStore();
    controller.load(sync());
    const session = controller.attachGeneration(run());
    session.apply({ type: "status", snapshot: snapshot() });

    apply(session);

    expect(controller.store.get().generation?.result).toEqual({ state: "pending" });
    expect(controller.store.get().generation?.jobId).toBe(jobId);
  });

  it("preserves untouched stream fields through narration and degraded events", () => {
    const controller = createCampaignStore();
    controller.load(sync());
    const session = controller.attachGeneration(run());
    const incoming = snapshot();
    session.apply({ type: "status", snapshot: incoming });
    session.apply({ type: "narration", text: "new narration" });
    session.apply({ type: "degraded", reason: "stream_lost", consecutiveFailures: 1 });
    incoming.action = "mutated";

    expect(controller.store.get().generation).toMatchObject({
      narration: "new narration",
      snapshot: { action: "continue" },
      transport: { state: "degraded", reason: "stream_lost", consecutiveFailures: 1 }
    });
  });

  it("rejects an active snapshot identity mismatch atomically", () => {
    const controller = createCampaignStore();
    controller.load(sync());
    const session = controller.attachGeneration(run());
    const before = controller.store.get();

    expectProtocol(() => session.apply({ type: "status", snapshot: snapshot({ id: turnOneId }) }), "job_mismatch");
    expect(controller.store.get()).toBe(before);
    expectProtocol(() => session.apply({ type: "status", snapshot: snapshot({ campaignId: otherCampaignId }) }), "campaign_mismatch");
    expect(controller.store.get()).toBe(before);
  });

  it("rejects status provenance that conflicts with the attached run", () => {
    const controller = createCampaignStore();
    controller.load(sync());
    const session = controller.attachGeneration(run());
    const before = controller.store.get();

    expectProtocol(() => session.apply({
      type: "status",
      snapshot: snapshot({ operationKind: "replace_latest", replacementTurnId: turnOneId })
    }), "job_mismatch");

    expect(controller.store.get()).toBe(before);
  });

  it("makes a superseded session a no-op", () => {
    const controller = createCampaignStore();
    controller.load(sync());
    const stale = controller.attachGeneration(run());
    const active = controller.attachGeneration(run());

    stale.apply({ type: "narration", text: "late" });
    active.apply({ type: "narration", text: "current" });

    expect(controller.store.get().generation?.narration).toBe("current");
  });

  it("retains failed and unavailable runs with only safe error details and lets a status reset failure", () => {
    const controller = createCampaignStore();
    controller.load(sync());
    const session = controller.attachGeneration(run());
    const secret = new Error("private-provider-secret");
    session.apply({ type: "settled", outcome: "failed", error: secret });
    expect(controller.store.get().generation).toMatchObject({ result: { state: "failed", message: "Generation could not complete." } });
    expect(JSON.stringify(controller.store.get())).not.toContain("private-provider-secret");
    session.apply({ type: "status", snapshot: snapshot({ status: "queued" }) });
    expect(controller.store.get().generation?.result).toEqual({ state: "pending" });

    session.apply({ type: "result_unavailable", jobId, error: new NexusApiError("result later", { statusCode: 503, correlationId: "correlation-1" }) });
    expect(controller.store.get().generation?.result).toEqual({ state: "unavailable", message: "result later", correlationId: "correlation-1" });
    session.apply({ type: "result_unavailable", jobId, error: secret });
    expect(controller.store.get().generation?.result).toEqual({
      state: "unavailable",
      message: "Accepted result is temporarily unavailable. Try loading it again.",
      correlationId: null
    });
    expect(selectIsGenerationInFlight(controller.store.get())).toBe(false);
  });

  it.each(["failed", "unrecoverable"] as const)("does not expose arbitrary %s error messages", (outcome) => {
    const controller = createCampaignStore();
    controller.load(sync());
    const session = controller.attachGeneration(run());
    session.apply({ type: "settled", outcome, error: new Error(`secret-${outcome}-detail`) });

    expect(controller.store.get().generation?.result).toEqual({
      state: "failed",
      outcome,
      message: "Generation could not complete."
    });
    expect(JSON.stringify(controller.store.get())).not.toContain(`secret-${outcome}-detail`);
  });

  it("uses fetchResult only for an unavailable active result", async () => {
    const completed = result();
    const fetchResult = vi.fn(async () => ({ type: "settled" as const, outcome: "completed" as const, result: completed }));
    const controller = createCampaignStore();
    controller.load(sync());
    const session = controller.attachGeneration({ ...run(), fetchResult });

    await expect(session.retryResult()).rejects.toMatchObject({ kind: "result_retry_not_available" });
    session.apply({ type: "result_unavailable", jobId, error: new Error("later") });
    await session.retryResult();

    expect(fetchResult).toHaveBeenCalledOnce();
    expect(controller.store.get()).toMatchObject({ generation: null, turns: [{ turnNumber: 1 }, { turnNumber: 2 }, { id: turnThreeId, turnNumber: 3 }] });
  });

  it("reconciles a local append completion, invalidates pagination, and copies accepted ingress", () => {
    const controller = createCampaignStore();
    controller.load(sync());
    controller.loadRuntimeState(runtime());
    const session = controller.attachGeneration(run());
    const completed = result();

    session.apply({ type: "settled", outcome: "completed", result: completed });
    (completed.choices as string[]).push("mutated");
    (completed.stateSnapshot.nested as { value: string }).value = "mutated";

    expect(controller.store.get()).toMatchObject({
      generation: null,
      turns: [{ turnNumber: 1 }, { turnNumber: 2 }, { id: turnThreeId, turnNumber: 3, choices: ["accepted choice"] }],
      historySyncRequired: true,
      syncToken: null,
      nextTurnsCursor: null,
      runtimeState: null,
      latestStateSnapshot: { nested: { value: "state" } },
      campaign: { activeTurnNumber: 3 }
    });
  });

  it("treats an already synced completion as a race without downgrading the authoritative turn", () => {
    const rich = { ...turn(3, turnThreeId), imageUrl: "/rich.png" };
    const controller = createCampaignStore();
    controller.load(sync({ turns: page([turn(1), turn(2), rich], campaignId, "older-2"), syncToken: "sync-race" }));
    const session = controller.attachGeneration(run());

    session.apply({ type: "settled", outcome: "completed", result: result() });

    expect(controller.store.get()).toMatchObject({
      turns: [{ turnNumber: 1 }, { turnNumber: 2 }, { id: turnThreeId, imageUrl: "/rich.png" }],
      historySyncRequired: false,
      syncToken: "sync-race",
      nextTurnsCursor: "older-2"
    });
  });

  it("upgrades an exactly matching locally projected turn from a later authoritative page", () => {
    const controller = createCampaignStore();
    controller.load(sync());
    const session = controller.attachGeneration(run());
    session.apply({ type: "settled", outcome: "completed", result: result() });
    const accepted = controller.store.get().turns[2]!;

    controller.prependOlderTurns(page([{ ...turn(3, turnThreeId), imageUrl: "/authoritative.png" }], campaignId, "older-final"));

    expect(controller.store.get().turns).toHaveLength(3);
    expect(controller.store.get().turns[2]).not.toBe(accepted);
    expect(controller.store.get().turns[2]).toMatchObject({ id: turnThreeId, imageUrl: "/authoritative.png" });
  });

  it("replaces the exact target atomically and rejects conflicting completion inputs", () => {
    const controller = createCampaignStore();
    controller.load(sync());
    const session = controller.attachGeneration(replacementRun(turnTwoId));
    session.apply({ type: "settled", outcome: "completed", result: result({ expectedTurnNumber: 2, turnNumber: 2 }) });
    expect(controller.store.get().turns[1]).toMatchObject({ id: turnThreeId, turnNumber: 2 });

    const failing = createCampaignStore();
    failing.load(sync());
    const failedSession = failing.attachGeneration(replacementRun(turnOneId));
    const before = failing.store.get();
    expectProtocol(() => failedSession.apply({ type: "settled", outcome: "completed", result: result({ expectedTurnNumber: 2, turnNumber: 2 }) }), "replacement_target_mismatch");
    expect(failing.store.get()).toBe(before);
  });

  it("rejects completed result IDs, campaigns, expected numbers, append collisions, and missing targets atomically", () => {
    const cases: Array<{
      kind: string;
      run: GenerationRun;
      completed: GenerationResult;
    }> = [
      { kind: "job_mismatch", run: run(), completed: result({ id: turnOneId }) },
      { kind: "campaign_mismatch", run: run(), completed: result({ campaignId: otherCampaignId }) },
      { kind: "result_turn_mismatch", run: run(), completed: result({ expectedTurnNumber: 2, turnNumber: 3 }) },
      { kind: "duplicate_turn_number", run: run(), completed: result({ expectedTurnNumber: 2, turnNumber: 2 }) },
      { kind: "replacement_target_missing", run: replacementRun(turnThreeId), completed: result({ expectedTurnNumber: 2, turnNumber: 2 }) }
    ];

    for (const entry of cases) {
      const controller = createCampaignStore();
      controller.load(sync());
      const session = controller.attachGeneration(entry.run);
      const before = controller.store.get();
      expectProtocol(() => session.apply({ type: "settled", outcome: "completed", result: entry.completed }), entry.kind);
      expect(controller.store.get()).toBe(before);
    }
  });

  it("accepts completed recovery outside a bounded historical window without inventing a disconnected turn", () => {
    const controller = createCampaignStore();
    controller.load(sync());
    const session = controller.attachGeneration(replacementRun(turnThreeId));

    session.apply({ type: "settled", outcome: "completed", result: result({ expectedTurnNumber: 0, turnNumber: 0, resultTurnId: turnThreeId }) });

    expect(controller.store.get()).toMatchObject({
      turns: [{ turnNumber: 1 }, { turnNumber: 2 }],
      nextTurnsCursor: "older-1",
      syncToken: "sync-1",
      historySyncRequired: false,
      generation: null,
      latestStateSnapshot: { nested: { value: "state" } }
    });
  });

  it("clears only the active projection for cancelled and discarded sessions", () => {
    for (const outcome of ["cancelled", "discarded"] as const) {
      const controller = createCampaignStore();
      controller.load(sync());
      const session = controller.attachGeneration(run());
      session.apply({ type: "settled", outcome, error: new Error(outcome) });
      expect(controller.store.get().generation).toBeNull();
      session.apply({ type: "narration", text: "late" });
      expect(controller.store.get().generation).toBeNull();
    }
  });

  it("keeps an ApiContractError message and correlation without probing arbitrary error causes", () => {
    const controller = createCampaignStore();
    controller.load(sync());
    const session = controller.attachGeneration(run());
    const error = new ApiContractError("contract result later", {
      phase: "response",
      kind: "response_schema_mismatch",
      method: "GET",
      path: "/generation",
      correlationId: "contract-correlation"
    });
    session.apply({ type: "result_unavailable", jobId, error });

    expect(controller.store.get().generation?.result).toEqual({
      state: "unavailable",
      message: "contract result later",
      correlationId: "contract-correlation"
    });
  });

  it("composes a real replacement GenerationWorkflow run into the campaign store", async () => {
    const controller = createCampaignStore();
    controller.load(sync());
    const replacementSnapshot = snapshot({
      expectedTurnNumber: 2,
      operationKind: "replace_latest",
      replacementTurnId: turnTwoId,
      status: "replacement_queued"
    });
    const api: GenerationApiPort = {
      enqueue: async () => ({ id: jobId, status: "queued", duplicate: false, operationKind: "append", replacementTurnId: null }),
      enqueueReplacement: async () => ({ id: jobId, status: "replacement_queued", duplicate: false, operationKind: "replace_latest", replacementTurnId: turnTwoId }),
      syncStatus: async () => sync(),
      result: async () => result({ expectedTurnNumber: 2, turnNumber: 2 }),
      retry: async () => ({ id: jobId, status: "replacement_queued", operationKind: "replace_latest", replacementTurnId: turnTwoId }),
      cancel: async () => ({ id: jobId, status: "cancelled", operationKind: "replace_latest", replacementTurnId: turnTwoId }),
      discard: async () => ({ id: jobId, status: "discarded", operationKind: "replace_latest", replacementTurnId: turnTwoId })
    };
    const source: GenerationSnapshotSource = {
      async *watch() {
        yield { kind: "snapshot", snapshot: replacementSnapshot };
        yield { kind: "snapshot", snapshot: { ...replacementSnapshot, status: "completed", resultTurnId: turnThreeId } };
      }
    };
    const pending: PendingSubmissionStore = {
      load: () => null,
      save: () => undefined,
      clear: () => undefined
    };
    const signal: AbortSignalLike = {
      aborted: false,
      addEventListener: () => undefined,
      removeEventListener: () => undefined
    };
    const workflow = createGenerationWorkflow({ api, source, clock: { now: () => 1_000 }, pendingSubmissions: pending });
    const run = await workflow.submit(campaignId, {
      operationKind: "replace_latest",
      request: {
        action: "continue",
        expectedCurrentTurnNumber: 2,
        requestedInputMode: "action",
        resolvedInputMode: "action",
        inputModeSource: "explicit",
        idempotencyKey: "replacement-composition-key",
        context: { budgetTokens: 3_200, compression: "auto", recentTurns: 8 }
      }
    });
    const session = controller.attachGeneration(run);

    for await (const event of run.watch(signal)) session.apply(event);

    expect(controller.store.get()).toMatchObject({
      generation: null,
      turns: [{ id: turnOneId, turnNumber: 1 }, { id: turnThreeId, turnNumber: 2 }],
      historySyncRequired: true,
      syncToken: null
    });
  });
});
