import { describe, expect, it } from "vitest";
import {
  createStoryHistoryWindow,
  installStoryHistoryWindowPage,
  storyHistoryPageRequest,
  storyHistoryVisibleTurns
} from "../../../packages/client-core/src/story-history-window.js";

type Turn = { id: string; turnNumber: number };
const rows = (ordinals: readonly number[]): Turn[] => ordinals.map(turnNumber => ({
  id: "accepted-" + turnNumber,
  turnNumber
}));
const retainedRowCount = (state: ReturnType<typeof createStoryHistoryWindow<Turn>>): number =>
  state.cachedPages.reduce((count, page) => count + page.turns.length, 0);

describe("History windows over sparse accepted ledgers", () => {
  it("shows all accepted resident entries without inventing an older integer range", () => {
    const turns = rows([1, 2, 100, 105, 200]);
    const state = createStoryHistoryWindow({
      page: { requestCursor: null, nextCursor: null, turns },
      selectedPreview: turns.at(-1) ?? null,
      residentRange: { firstTurnNumber: 1, lastTurnNumber: 200 }
    });
    expect(storyHistoryVisibleTurns(state).pageTurns.map(turn => turn.turnNumber)).toEqual([1, 2, 100, 105, 200]);
    expect(storyHistoryPageRequest(state, "older")).toBeNull();
  });

  it("counts accepted entries rather than ordinal gaps when reserving the pinned preview", () => {
    const turns = rows(Array.from({ length: 50 }, (_, index) => (index + 1) * 10));
    const state = createStoryHistoryWindow({
      page: { requestCursor: null, nextCursor: "server-issued-older-cursor", turns },
      selectedPreview: { id: "accepted-1", turnNumber: 1 }
    });
    const visible = storyHistoryVisibleTurns(state);
    expect(visible.pageTurns.map(turn => turn.turnNumber)).toEqual(turns.slice(1).map(turn => turn.turnNumber));
    expect(visible.selectedPreview?.turnNumber).toBe(1);
    expect(visible.pageTurns.length + Number(visible.selectedPreview !== null)).toBe(50);
  });

  it("installs a valid older opaque-cursor page even when ordinals are not consecutive", () => {
    const recent = rows(Array.from({ length: 50 }, (_, index) => 500 + index * 10));
    let state = createStoryHistoryWindow({
      page: { requestCursor: null, nextCursor: "opaque-older-accepted-page", turns: recent },
      selectedPreview: recent.at(-1) ?? null
    });
    const request = storyHistoryPageRequest(state, "older");
    expect(request?.requestCursor).toBe("opaque-older-accepted-page");
    if (!request) throw new Error("The server advertised an older accepted page.");

    const captured = storyHistoryPageRequest(state, "older");
    if (!captured) throw new Error("The pending page lost its captured cursor.");
    state = installStoryHistoryWindowPage(state, captured, {
      requestCursor: "opaque-older-accepted-page",
      nextCursor: null,
      turns: rows([1, 2, 100, 105, 200])
    });
    expect(state.pending).toBeNull();
    expect(storyHistoryVisibleTurns(state).pageTurns.map(turn => turn.turnNumber)).toEqual([1, 2, 100, 105, 200]);
    expect(retainedRowCount(state)).toBeLessThanOrEqual(100);
  });

  it("carries a displaced boundary row across an Older window and replays both source pages with an external pin", () => {
    const recent = rows(Array.from({ length: 50 }, (_, index) => 500 + index * 10));
    const externalPin = { id: "accepted-1", turnNumber: 1 };
    const olderPageRows = rows(Array.from({ length: 50 }, (_, index) => 100 + index * 5));
    let state = createStoryHistoryWindow({
      page: { requestCursor: null, nextCursor: "opaque-before-recent", turns: recent },
      selectedPreview: externalPin
    });

    const initial = storyHistoryVisibleTurns(state);
    expect(initial.pageTurns).toEqual(recent.slice(1));
    expect(initial.selectedPreview).toEqual(externalPin);
    expect(initial.pageTurns.length + Number(initial.selectedPreview !== null)).toBe(50);
    expect(retainedRowCount(state)).toBe(50);

    const olderRequest = storyHistoryPageRequest(state, "older");
    expect(olderRequest).toMatchObject({ source: "server", requestCursor: "opaque-before-recent" });
    if (!olderRequest) throw new Error("Expected an opaque Older request.");
    state = installStoryHistoryWindowPage(state, olderRequest, {
      requestCursor: "opaque-before-recent",
      nextCursor: "opaque-before-earlier",
      turns: olderPageRows
    });

    const older = storyHistoryVisibleTurns(state);
    expect(older.pageTurns).toEqual([...olderPageRows.slice(-48), recent[0]]);
    expect(older.selectedPreview).toEqual(externalPin);
    expect(older.pageTurns.length + Number(older.selectedPreview !== null)).toBe(50);
    expect(state.cachedPages.flatMap(page => page.turns).some(turn => turn.id === recent[0]!.id)).toBe(true);
    expect(retainedRowCount(state)).toBeLessThanOrEqual(100);

    const newerRequest = storyHistoryPageRequest(state, "newer");
    expect(newerRequest?.requiresFetch).toBe(false);
    if (!newerRequest) throw new Error("Expected the captured recent window.");
    state = installStoryHistoryWindowPage(state, newerRequest, null);
    expect(storyHistoryVisibleTurns(state).pageTurns).toEqual(recent.slice(1));
    expect(storyHistoryVisibleTurns(state).selectedPreview).toEqual(externalPin);

    const replayOlderRequest = storyHistoryPageRequest(state, "older");
    expect(replayOlderRequest?.requiresFetch).toBe(false);
    if (!replayOlderRequest) throw new Error("Expected the captured Older display window.");
    state = installStoryHistoryWindowPage(state, replayOlderRequest, null);
    expect(storyHistoryVisibleTurns(state).pageTurns).toEqual([...olderPageRows.slice(-48), recent[0]]);
    expect(retainedRowCount(state)).toBeLessThanOrEqual(100);
  });

  it("evicts raw rows beyond two source pages and replays an evicted page by its captured opaque cursor", () => {
    const recent = rows(Array.from({ length: 50 }, (_, index) => 151 + index));
    const olderA = rows(Array.from({ length: 50 }, (_, index) => 101 + index));
    const olderB = rows(Array.from({ length: 50 }, (_, index) => 51 + index));
    const olderC = rows(Array.from({ length: 50 }, (_, index) => 1 + index));
    const pagesByCursor = new Map([
      ["opaque-older-a", { requestCursor: "opaque-older-a", nextCursor: "opaque-older-b", turns: olderA }],
      ["opaque-older-b", { requestCursor: "opaque-older-b", nextCursor: "opaque-older-c", turns: olderB }],
      ["opaque-older-c", { requestCursor: "opaque-older-c", nextCursor: null, turns: olderC }]
    ]);
    let networkRowsReceived = recent.length;
    let state = createStoryHistoryWindow({
      page: { requestCursor: null, nextCursor: "opaque-older-a", turns: recent },

    });

    for (const cursor of ["opaque-older-a", "opaque-older-b", "opaque-older-c"]) {
      const request = storyHistoryPageRequest(state, "older");
      expect(request?.requestCursor).toBe(cursor);
      if (!request) throw new Error("Expected the captured server cursor " + cursor + ".");
      const response = pagesByCursor.get(cursor);
      if (!response) throw new Error("The synthetic server did not define cursor " + cursor + ".");
      networkRowsReceived += response.turns.length;
      state = installStoryHistoryWindowPage(state, request, response);
      expect(retainedRowCount(state)).toBeLessThanOrEqual(100);
    }

    const olderAIds = new Set(olderA.map(turn => turn.id));
    expect(state.cachedPages.flatMap(page => page.turns).some(turn => olderAIds.has(turn.id))).toBe(false);
    expect(networkRowsReceived).toBe(200);

    const newerToB = storyHistoryPageRequest(state, "newer");
    if (!newerToB) throw new Error("Expected a previously visited newer window.");
    if (newerToB.requiresFetch) {
      expect(newerToB.requestCursor).toBe("opaque-older-b");
      const replayB = pagesByCursor.get("opaque-older-b");
      if (!replayB) throw new Error("The synthetic server has no B page.");
      networkRowsReceived += replayB.turns.length;
      state = installStoryHistoryWindowPage(state, newerToB, replayB);
    } else {
      state = installStoryHistoryWindowPage(state, newerToB, null);
    }
    expect(retainedRowCount(state)).toBeLessThanOrEqual(100);
    expect(state.cachedPages.flatMap(page => page.turns).some(turn => olderAIds.has(turn.id))).toBe(false);

    const newerToA = storyHistoryPageRequest(state, "newer");
    expect(newerToA).toMatchObject({
      source: "server",
      requestCursor: "opaque-older-a",
      requiresFetch: true
    });
    if (!newerToA) throw new Error("Expected the evicted page to replay through its original cursor.");
    const replayA = pagesByCursor.get("opaque-older-a");
    if (!replayA) throw new Error("The synthetic server has no A page.");
    networkRowsReceived += replayA.turns.length;
    state = installStoryHistoryWindowPage(state, newerToA, replayA);

    expect(storyHistoryVisibleTurns(state).pageTurns).toEqual(olderA);
    expect(networkRowsReceived).toBeGreaterThan(200);
    expect(retainedRowCount(state)).toBeLessThanOrEqual(100);
  });

  it("bounds sparse raw pages with an external pin and replays evicted source rows by opaque cursor", () => {
    const pageRows = (first: number): Turn[] => rows(Array.from({ length: 50 }, (_, index) => first + index * 4));
    const recent = pageRows(1000);
    const olderA = pageRows(800);
    const olderB = pageRows(600);
    const olderC = pageRows(400);
    const olderD = pageRows(200);
    const pin = { id: "accepted-1", turnNumber: 1 };
    const cursors = ["opaque-sparse-a", "opaque-sparse-b", "opaque-sparse-c", "opaque-sparse-d"] as const;
    const sourcePages = new Map<string | null, { requestCursor: string | null; nextCursor: string | null; turns: Turn[] }>([
      [null, { requestCursor: null, nextCursor: cursors[0], turns: recent }],
      [cursors[0], { requestCursor: cursors[0], nextCursor: cursors[1], turns: olderA }],
      [cursors[1], { requestCursor: cursors[1], nextCursor: cursors[2], turns: olderB }],
      [cursors[2], { requestCursor: cursors[2], nextCursor: cursors[3], turns: olderC }],
      [cursors[3], { requestCursor: cursors[3], nextCursor: null, turns: olderD }]
    ]);
    let state = createStoryHistoryWindow({
      page: { requestCursor: null, nextCursor: cursors[0], turns: recent },
      selectedPreview: pin
    });
    const requestedCursors: (string | null)[] = [];
    let networkRowsReceived = recent.length;

    const navigate = (direction: "older" | "newer"): void => {
      let request = storyHistoryPageRequest(state, direction);
      if (!request) throw new Error("Expected a captured " + direction + " window.");
      for (let step = 0; step < 8; step += 1) {
        if (!request.requiresFetch) {
          state = installStoryHistoryWindowPage(state, request, null);
          return;
        }
        if (request.source !== "server") {
          throw new Error("Sparse source replay must use its captured opaque server cursor.");
        }
        const cursor = request.requestCursor;
        requestedCursors.push(cursor);
        const response = sourcePages.get(cursor);
        if (!response || response.requestCursor !== cursor) {
          throw new Error("The synthetic server rejected a missing or mismatched continuation cursor.");
        }
        networkRowsReceived += response.turns.length;
        state = installStoryHistoryWindowPage(state, request, response);
        if (!state.pending) return;
        request = storyHistoryPageRequest(state, direction);
        if (!request) throw new Error("A sparse window stopped before its accepted rows were complete.");
      }
      throw new Error("The sparse source required too many pages to finish one display window.");
    };

    expect(storyHistoryVisibleTurns(state).pageTurns).toEqual(recent.slice(1));
    expect(storyHistoryVisibleTurns(state).selectedPreview).toEqual(pin);
    for (let pageIndex = 0; pageIndex < 4; pageIndex += 1) {
      navigate("older");
      expect(retainedRowCount(state)).toBeLessThanOrEqual(100);
      expect(storyHistoryVisibleTurns(state).pageTurns.length + 1).toBeLessThanOrEqual(50);
    }

    expect(requestedCursors.slice(0, 4)).toEqual(cursors);
    expect(storyHistoryVisibleTurns(state).pageTurns).toEqual([...olderD.slice(5), ...olderC.slice(0, 4)]);
    const recentIds = new Set(recent.map(turn => turn.id));
    expect(state.cachedPages.flatMap(page => page.turns).some(turn => recentIds.has(turn.id))).toBe(false);
    expect(networkRowsReceived).toBe(250);

    for (const expected of [
      [...olderC.slice(4), ...olderB.slice(0, 3)],
      [...olderB.slice(3), ...olderA.slice(0, 2)],
      [...olderA.slice(2), recent[0]],
      [...recent.slice(1)]
    ]) {
      navigate("newer");
      expect(storyHistoryVisibleTurns(state).pageTurns).toEqual(expected);
      expect(storyHistoryVisibleTurns(state).selectedPreview).toEqual(pin);
      expect(storyHistoryVisibleTurns(state).pageTurns.length + 1).toBeLessThanOrEqual(50);
      expect(retainedRowCount(state)).toBeLessThanOrEqual(100);
    }

    expect(requestedCursors.slice(0, 4)).toEqual(cursors);
    expect(requestedCursors.slice(4)).toContain(cursors[0]);
    expect(networkRowsReceived).toBeGreaterThan(250);
  });
});
