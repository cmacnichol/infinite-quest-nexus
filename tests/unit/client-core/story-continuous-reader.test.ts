import type { ReaderSceneWindowResponse, ReaderTurnResponse, TurnSummary } from "@infinite-quest/contracts";
import { describe, expect, it } from "vitest";
import {
  beginStoryContinuousReaderGroup,
  beginStoryContinuousReaderRetry,
  createStoryContinuousReaderState,
  reconcileStoryAcceptedSceneReplacement,
  selectStoryReadIdentity,
  settleStoryContinuousReaderAnchorRefresh,
  settleStoryContinuousReaderAnchorRefreshFailure,
  settleStoryContinuousReaderFailure,
  settleStoryContinuousReaderResponse
} from "../../../packages/client-core/src/story-continuous-reader.js";

const campaignId = "11111111-1111-4111-8111-111111111111";
const otherCampaignId = "22222222-2222-4222-8222-222222222222";

function turnId(turnNumber: number, salt = 0): string {
  return `00000000-0000-4000-8000-${(turnNumber + salt * 10_000).toString(16).padStart(12, "0")}`;
}

function turn(turnNumber: number, id = turnId(turnNumber), narration = `Scene ${turnNumber}`): TurnSummary {
  return {
    id,
    turnNumber,
    action: `Action ${turnNumber}`,
    inputMode: "action",
    inputModeSource: "explicit",
    narration,
    choices: [],
    customActionSuggestion: "",
    imagePrompt: "",
    imageUrl: null,
    acceptedAt: "2026-10-03T12:00:00.000Z",
    chronicleRetrieval: null,
    reportedCost: null
  };
}

function response(
  turns: readonly TurnSummary[],
  direction: "older" | "newer",
  options: { readonly campaignId?: string; readonly hasMore?: boolean; readonly historyToken?: string } = {}
): ReaderSceneWindowResponse {
  const anchor = direction === "older" ? turns.at(-1)! : turns[0]!;
  return {
    campaignId: options.campaignId ?? campaignId,
    anchor: { turnNumber: anchor.turnNumber, id: anchor.id },
    direction,
    turns: [...turns],
    hasMore: options.hasMore ?? false,
    historyToken: options.historyToken ?? "scene-history-token"
  };
}

function startPinned(turnNumber = 50) {
  const pinnedTurn = turn(turnNumber);
  const initialized = createStoryContinuousReaderState({
    scope: { campaignId, loadEpoch: 3 },
    residentTurns: [],
    selectedReadIdentity: { turnNumber, id: pinnedTurn.id },
    selectedTurn: { campaignId, turn: pinnedTurn }
  });
  expect(initialized.status).toBe("ready");
  if (initialized.status !== "ready") throw new Error("Expected the exact selected row to be resident.");
  return { state: initialized.state, pinnedTurn };
}

describe("story continuous reader policy", () => {
  it("bootstraps a zero-turn campaign without inventing an anchor or requesting a lookup", () => {
    const initialized = createStoryContinuousReaderState({
      scope: { campaignId, loadEpoch: 0 },
      residentTurns: [],
      selectedReadIdentity: null
    });

    expect(initialized.status).toBe("ready");
    if (initialized.status !== "ready") throw new Error("Expected an empty reader state.");
    expect(initialized.state.turns).toEqual([]);
    expect(initialized.state.selectedReadIdentity).toBeNull();
    expect(initialized.state.pendingRequest).toBeNull();
    expect(beginStoryContinuousReaderGroup(initialized.state, "older")).toEqual({ state: initialized.state, request: null });
    expect(beginStoryContinuousReaderGroup(initialized.state, "newer")).toEqual({ state: initialized.state, request: null });
  });

  it("keeps the selected accepted row visible as a single pin when it falls outside the latest ten", () => {
    const residentTurns = Array.from({ length: 317 }, (_, index) => turn(index + 1));
    const selected = turn(12);
    const initialized = createStoryContinuousReaderState({
      scope: { campaignId, loadEpoch: 7 },
      residentTurns,
      selectedReadIdentity: { turnNumber: 12, id: selected.id },
      selectedTurn: { campaignId, turn: selected }
    });

    expect(initialized.status).toBe("ready");
    if (initialized.status !== "ready") throw new Error("Expected the provided selected row to be usable.");
    expect(initialized.state.presentation).toBe("exact-pin");
    expect(initialized.state.turns.map(({ turnNumber }) => turnNumber)).toEqual([12]);
    expect(initialized.state.selectedReadIdentity).toEqual({ turnNumber: 12, id: selected.id });
    expect(initialized.state.historyToken).toBeNull();
    expect(initialized.state.pendingRequest).toBeNull();
    expect(initialized.state.edgeAvailability).toEqual({ older: null, newer: null });
  });

  it("uses at most ten latest resident scenes only when the selected identity is in that group", () => {
    const initialized = createStoryContinuousReaderState({
      scope: { campaignId, loadEpoch: 8 },
      residentTurns: Array.from({ length: 2_000 }, (_, index) => turn(index + 1)),
      selectedReadIdentity: { turnNumber: 2_000, id: turnId(2_000) }
    });

    expect(initialized.status).toBe("ready");
    if (initialized.status !== "ready") throw new Error("Expected a bounded recent window.");
    expect(initialized.state.presentation).toBe("window");
    expect(initialized.state.turns.map(({ turnNumber }) => turnNumber)).toEqual([1991, 1992, 1993, 1994, 1995, 1996, 1997, 1998, 1999, 2000]);
    expect(initialized.state.selectedReadIdentity).toEqual({ turnNumber: 2_000, id: turnId(2_000) });
    expect(initialized.state.turns).toHaveLength(10);
  });

  it("pins an available resident selected scene when it falls outside the latest ten", () => {
    const initialized = createStoryContinuousReaderState({
      scope: { campaignId, loadEpoch: 9 },
      residentTurns: Array.from({ length: 20 }, (_, index) => turn(index + 1)),
      selectedReadIdentity: { turnNumber: 3, id: turnId(3) }
    });

    expect(initialized.status).toBe("ready");
    if (initialized.status !== "ready") throw new Error("Expected the selected resident scene to be available.");
    expect(initialized.state.presentation).toBe("exact-pin");
    expect(initialized.state.turns.map(({ turnNumber }) => turnNumber)).toEqual([3]);
  });

  it("requires a supplied exact selected row instead of silently showing latest scenes", () => {
    const selectedReadIdentity = { turnNumber: 12, id: turnId(12) };
    const initialized = createStoryContinuousReaderState({
      scope: { campaignId, loadEpoch: 1 },
      residentTurns: Array.from({ length: 305 }, (_, index) => turn(index + 13)),
      selectedReadIdentity
    });

    expect(initialized).toEqual({ status: "selected-turn-required", identity: selectedReadIdentity });
  });

  it("anchors explicit older and newer groups at actual edges and preserves read selection separately", () => {
    const { state: pinnedState } = startPinned();
    const selectedIdentity = { turnNumber: 12, id: turnId(12) };
    const state = selectStoryReadIdentity(pinnedState, selectedIdentity);
    const older = beginStoryContinuousReaderGroup(state, "older");
    expect(older.request?.apiRequest).toEqual({
      anchorTurnNumber: 50,
      anchorTurnId: turnId(50),
      direction: "older",
      neighborLimit: 9
    });

    const olderResponse = response([turn(10), turn(50)], "older", { hasMore: true, historyToken: "token-older" });
    const olderLoaded = settleStoryContinuousReaderResponse(older.state, older.request!, olderResponse);
    expect(olderLoaded.turns.map(({ turnNumber }) => turnNumber)).toEqual([10, 50]);
    expect(olderLoaded.selectedReadIdentity).toEqual(selectedIdentity);
    expect(olderLoaded.historyToken).toBe("token-older");
    expect(olderLoaded.edgeAvailability).toEqual({ older: true, newer: null });

    const newer = beginStoryContinuousReaderGroup(olderLoaded, "newer");
    expect(newer.request?.apiRequest).toEqual({
      anchorTurnNumber: 50,
      anchorTurnId: turnId(50),
      direction: "newer",
      neighborLimit: 9,
      historyToken: "token-older"
    });
    const newerLoaded = settleStoryContinuousReaderResponse(
      newer.state,
      newer.request!,
      response([turn(50), turn(900)], "newer", { hasMore: true, historyToken: "token-older" })
    );
    expect(newerLoaded.turns.map(({ turnNumber }) => turnNumber)).toEqual([50, 900]);
    expect(newerLoaded.edgeAvailability).toEqual({ older: true, newer: true });
  });

  it("does not carry a false edge boundary to the opposite edge of a shifted group", () => {
    const { state } = startPinned();
    const older = beginStoryContinuousReaderGroup(state, "older");
    const atOldest = settleStoryContinuousReaderResponse(
      older.state,
      older.request!,
      response([turn(50)], "older", { hasMore: false, historyToken: "stable-token" })
    );
    expect(atOldest.edgeAvailability).toEqual({ older: false, newer: null });

    const newer = beginStoryContinuousReaderGroup(atOldest, "newer");
    const atNewest = settleStoryContinuousReaderResponse(
      newer.state,
      newer.request!,
      response([turn(50), turn(900)], "newer", { hasMore: false, historyToken: "stable-token" })
    );
    expect(atNewest.edgeAvailability).toEqual({ older: null, newer: false });
  });

  it("installs only a fully valid, current response and leaves the old group on protocol errors", () => {
    const { state } = startPinned();
    const started = beginStoryContinuousReaderGroup(state, "older");
    const malformed = {
      ...response([turn(50), turn(70)], "older"),
      turns: [turn(50), turn(70)]
    };
    const failed = settleStoryContinuousReaderResponse(started.state, started.request!, malformed);

    expect(failed.turns).toEqual(state.turns);
    expect(failed.selectedReadIdentity).toEqual(state.selectedReadIdentity);
    expect(failed.pendingRequest).toBeNull();
    expect(failed.status).toBe("error");
    expect(failed.failureKind).toBe("protocol");
    expect(failed.historyToken).toBeNull();
  });

  it("runtime-validates duplicate, unordered, and oversized responses before any installation", () => {
    const { state } = startPinned();
    const started = beginStoryContinuousReaderGroup(state, "older");
    const duplicateIds = response([turn(10), turn(40, turnId(10))], "older");
    const duplicateFailed = settleStoryContinuousReaderResponse(started.state, started.request!, duplicateIds);
    expect(duplicateFailed.turns).toBe(state.turns);
    expect(duplicateFailed.pendingRequest).toBeNull();
    expect(duplicateFailed.failureKind).toBe("protocol");

    const restarted = beginStoryContinuousReaderRetry(duplicateFailed);
    expect(restarted.request).not.toBeNull();
    const badRows = Array.from({ length: 11 }, (_, index) => turn(index + 1));
    const oversized = {
      ...response(badRows, "older"),
      anchor: { turnNumber: 50, id: turnId(50) },
      turns: badRows
    };
    const oversizedFailed = settleStoryContinuousReaderResponse(restarted.state, restarted.request!, oversized);
    expect(oversizedFailed.turns).toBe(state.turns);
    expect(oversizedFailed.pendingRequest).toBeNull();
    expect(oversizedFailed.failureKind).toBe("protocol");

    const afterOversized = beginStoryContinuousReaderRetry(oversizedFailed);
    expect(afterOversized.request).not.toBeNull();
    const unordered = response([turn(51), turn(50)], "older");
    const unorderedFailed = settleStoryContinuousReaderResponse(afterOversized.state, afterOversized.request!, unordered);
    expect(unorderedFailed.turns).toBe(state.turns);
    expect(unorderedFailed.pendingRequest).toBeNull();
    expect(unorderedFailed.failureKind).toBe("protocol");
  });

  it("rejects wrong campaign, direction, and oversized token stamps without partial installation", () => {
    const { state } = startPinned();
    const validRows = [turn(10), turn(50)];
    const malformedResponses = [
      response(validRows, "older", { campaignId: otherCampaignId }),
      response([turn(50), turn(60)], "newer"),
      { ...response(validRows, "older"), historyToken: "x".repeat(4097) }
    ];

    for (const malformed of malformedResponses) {
      const started = beginStoryContinuousReaderGroup(state, "older");
      const failed = settleStoryContinuousReaderResponse(started.state, started.request!, malformed);
      expect(failed.turns).toBe(state.turns);
      expect(failed.pendingRequest).toBeNull();
      expect(failed.status).toBe("error");
      expect(failed.failureKind).toBe("protocol");
    }
  });

  it("ignores stale replies after a newer explicit request supersedes them", () => {
    const { state, pinnedTurn } = startPinned();
    const older = beginStoryContinuousReaderGroup(state, "older");
    const replacement = reconcileStoryAcceptedSceneReplacement(older.state, turn(50, turnId(50, 1), "replacement"));
    const lateResponse = settleStoryContinuousReaderResponse(
      replacement,
      older.request!,
      response([turn(10), pinnedTurn], "older", { historyToken: "late-token" })
    );

    expect(lateResponse).toBe(replacement);
    expect(lateResponse.turns).toEqual([turn(50, turnId(50, 1), "replacement")]);
    expect(lateResponse.historyToken).toBeNull();
    expect(lateResponse.pendingRequest).toBeNull();
  });

  it("retries a stale history token without changing the committed group or selection", () => {
    const { state } = startPinned();
    const first = beginStoryContinuousReaderGroup(state, "older");
    const loaded = settleStoryContinuousReaderResponse(
      first.state,
      first.request!,
      response([turn(10), turn(50)], "older", { hasMore: true, historyToken: "old-token" })
    );
    const next = beginStoryContinuousReaderGroup(loaded, "older");
    const failed = settleStoryContinuousReaderFailure(next.state, next.request!, "history-changed");
    expect(failed.turns).toBe(loaded.turns);
    expect(failed.selectedReadIdentity).toEqual(loaded.selectedReadIdentity);
    expect(failed.historyToken).toBe("old-token");
    expect(failed.historyTokenStale).toBe(true);

    const retry = beginStoryContinuousReaderRetry(failed);
    expect(retry.request?.apiRequest).toEqual({
      anchorTurnNumber: 10,
      anchorTurnId: turnId(10),
      direction: "older",
      neighborLimit: 9
    });
  });

  it("refreshes an anchor-changed exact identity before retrying and keeps the old group until install", () => {
    const { state } = startPinned();
    const older = beginStoryContinuousReaderGroup(state, "older");
    const failed = settleStoryContinuousReaderFailure(older.state, older.request!, "anchor-changed");
    const retry = beginStoryContinuousReaderRetry(failed);
    expect(retry.anchorRefreshRequest).toMatchObject({
      campaignId,
      turnNumber: 50,
      loadEpoch: 3
    });

    const refreshedTurn = turn(50, turnId(50, 2), "authoritative replacement");
    const rebased = settleStoryContinuousReaderAnchorRefresh(
      retry.state,
      retry.anchorRefreshRequest!,
      { campaignId, turn: refreshedTurn } satisfies ReaderTurnResponse
    );
    expect(rebased.state.turns).toEqual(state.turns);
    expect(rebased.request?.apiRequest).toEqual({
      anchorTurnNumber: 50,
      anchorTurnId: refreshedTurn.id,
      direction: "older",
      neighborLimit: 9
    });

    const installed = settleStoryContinuousReaderResponse(
      rebased.state,
      rebased.request!,
      response([turn(10), refreshedTurn], "older", { historyToken: "fresh-token" })
    );
    expect(installed.turns.map(({ id }) => id)).toEqual([turnId(10), refreshedTurn.id]);
    expect(installed.selectedReadIdentity).toEqual({ turnNumber: 50, id: refreshedTurn.id });
  });

  it("rejects stale or cross-campaign anchor refreshes without changing the committed window", () => {
    const { state } = startPinned();
    const older = beginStoryContinuousReaderGroup(state, "older");
    const failed = settleStoryContinuousReaderFailure(older.state, older.request!, "anchor-changed");
    const retry = beginStoryContinuousReaderRetry(failed);
    const wrongCampaign = settleStoryContinuousReaderAnchorRefresh(
      retry.state,
      retry.anchorRefreshRequest!,
      { campaignId: otherCampaignId, turn: turn(50, turnId(50, 9)) }
    );
    expect(wrongCampaign.request).toBeNull();
    expect(wrongCampaign.state.turns).toEqual(state.turns);
    expect(wrongCampaign.state.pendingRequest).toBeNull();
    expect(wrongCampaign.state.failureKind).toBe("protocol");

    const current = beginStoryContinuousReaderRetry(failed);
    const wrongOrdinal = settleStoryContinuousReaderAnchorRefresh(
      current.state,
      current.anchorRefreshRequest!,
      { campaignId, turn: turn(49, turnId(49, 9)) }
    );
    expect(wrongOrdinal.request).toBeNull();
    expect(wrongOrdinal.state.turns).toEqual(state.turns);
    expect(wrongOrdinal.state.failureKind).toBe("protocol");

    const invalidated = reconcileStoryAcceptedSceneReplacement(current.state, turn(12, turnId(12, 9)));
    const lateRefresh = settleStoryContinuousReaderAnchorRefresh(
      invalidated,
      current.anchorRefreshRequest!,
      { campaignId, turn: turn(50, turnId(50, 9)) }
    );
    expect(lateRefresh.state).toBe(invalidated);
    expect(lateRefresh.request).toBeNull();
  });

  it("settles anchor-refresh network failures without dropping the window and retries by ordinal", () => {
    const { state } = startPinned();
    const older = beginStoryContinuousReaderGroup(state, "older");
    const failedWindow = settleStoryContinuousReaderFailure(older.state, older.request!, "anchor-changed");
    const refresh = beginStoryContinuousReaderRetry(failedWindow);
    const anchorRequest = refresh.anchorRefreshRequest!;
    const networkFailed = settleStoryContinuousReaderAnchorRefreshFailure(refresh.state, anchorRequest);

    expect(networkFailed.turns).toBe(state.turns);
    expect(networkFailed.selectedReadIdentity).toEqual(state.selectedReadIdentity);
    expect(networkFailed.pendingRequest).toBeNull();
    expect(networkFailed.status).toBe("error");
    expect(networkFailed.failureKind).toBe("request");

    const retry = beginStoryContinuousReaderRetry(networkFailed);
    expect(retry.anchorRefreshRequest).toMatchObject({
      campaignId,
      turnNumber: 50,
      loadEpoch: 3,
      failedRequest: older.request
    });
    expect(retry.anchorRefreshRequest?.requestId).toBeGreaterThan(anchorRequest.requestId);

    const lateFailure = settleStoryContinuousReaderAnchorRefreshFailure(retry.state, anchorRequest);
    expect(lateFailure).toBe(retry.state);
  });

  it("ignores anchor-refresh failures fenced by request, campaign, load, or window identity", () => {
    const { state } = startPinned();
    const older = beginStoryContinuousReaderGroup(state, "older");
    const failedWindow = settleStoryContinuousReaderFailure(older.state, older.request!, "anchor-changed");
    const refresh = beginStoryContinuousReaderRetry(failedWindow);
    const request = refresh.anchorRefreshRequest!;
    const staleRequests = [
      { ...request, campaignId: otherCampaignId },
      { ...request, loadEpoch: request.loadEpoch + 1 },
      { ...request, windowEpoch: request.windowEpoch + 1 }
    ];
    const staleStates = [
      refresh.state,
      { ...refresh.state, scope: { ...refresh.state.scope, campaignId: otherCampaignId } },
      { ...refresh.state, scope: { ...refresh.state.scope, loadEpoch: refresh.state.scope.loadEpoch + 1 } },
      { ...refresh.state, windowEpoch: refresh.state.windowEpoch + 1 }
    ];

    expect(settleStoryContinuousReaderAnchorRefreshFailure(refresh.state, { ...request, requestId: request.requestId + 1 })).toBe(refresh.state);
    expect(settleStoryContinuousReaderAnchorRefreshFailure(staleStates[1]!, request)).toBe(staleStates[1]);
    expect(settleStoryContinuousReaderAnchorRefreshFailure(staleStates[2]!, request)).toBe(staleStates[2]);
    expect(settleStoryContinuousReaderAnchorRefreshFailure(staleStates[3]!, request)).toBe(staleStates[3]);
    for (const staleRequest of staleRequests) {
      expect(settleStoryContinuousReaderAnchorRefreshFailure(refresh.state, staleRequest)).toBe(refresh.state);
    }
    expect(staleStates[0]).toBe(refresh.state);
  });

  it("invalidates pending reads and tokens on accepted replacement without inserting out-of-window rows", () => {
    const recent = createStoryContinuousReaderState({
      scope: { campaignId, loadEpoch: 12 },
      residentTurns: [turn(100), turn(101), turn(102)],
      selectedReadIdentity: { turnNumber: 100, id: turnId(100) }
    });
    expect(recent.status).toBe("ready");
    if (recent.status !== "ready") throw new Error("Expected resident window.");
    const first = beginStoryContinuousReaderGroup(recent.state, "older");
    const loaded = settleStoryContinuousReaderResponse(
      first.state,
      first.request!,
      response([turn(90), turn(100)], "older", { historyToken: "token" })
    );
    const pending = beginStoryContinuousReaderGroup(loaded, "older");
    const inWindow = reconcileStoryAcceptedSceneReplacement(pending.state, turn(100, turnId(100, 4), "replacement"));
    expect(inWindow.turns.map(({ id }) => id)).toEqual([turnId(90), turnId(100, 4)]);
    expect(inWindow.historyToken).toBeNull();
    expect(inWindow.pendingRequest).toBeNull();
    expect(inWindow.selectedReadIdentity).toEqual({ turnNumber: 100, id: turnId(100, 4) });

    const olderAgain = beginStoryContinuousReaderGroup(inWindow, "older");
    const refilled = settleStoryContinuousReaderResponse(
      olderAgain.state,
      olderAgain.request!,
      response([turn(80), turn(90)], "older", { historyToken: "out-window-token" })
    );
    const outOfWindow = reconcileStoryAcceptedSceneReplacement(refilled, turn(12, turnId(12, 5), "far replacement"));
    expect(outOfWindow.turns).toBe(refilled.turns);
    expect(outOfWindow.turns).toHaveLength(2);
    expect(outOfWindow.historyToken).toBeNull();
  });
});
