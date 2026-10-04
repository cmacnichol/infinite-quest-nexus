import { describe, expect, it } from "vitest";
import {
  createStoryHistoryWindow,
  installStoryHistoryWindowPage,
  selectStoryHistoryPreview,
  storyHistoryPageRequest,
  storyHistoryVisibleTurns
} from "../../../packages/client-core/src/story-history-window.js";
import type {
  StoryHistoryPage,
  StoryHistoryWindowState
} from "../../../packages/client-core/src/story-history-window.js";

type Turn = { id: string; turnNumber: number; narration: string };

function turns(first: number, last: number): Turn[] {
  return Array.from({ length: Math.max(0, last - first + 1) }, (_, index) => {
    const turnNumber = first + index;
    return { id: `turn-${turnNumber}`, turnNumber, narration: `Narration ${turnNumber}` };
  });
}

function syntheticServer(total: number) {
  const cursorRows = new Map<string, number>();
  const cursorByTurn = new Map<number, string>();
  const cursorBefore = (turnNumber: number): string => {
    const existing = cursorByTurn.get(turnNumber);
    if (existing) return existing;
    const cursor = `opaque-cursor-${turnNumber}-${cursorByTurn.size + 1}`;
    cursorRows.set(cursor, turnNumber);
    cursorByTurn.set(turnNumber, cursor);
    return cursor;
  };
  const firstRecent = Math.max(1, total - 49);
  const initial: StoryHistoryPage<Turn> = {
    requestCursor: null,
    nextCursor: firstRecent > 1 ? cursorBefore(firstRecent) : null,
    turns: turns(firstRecent, total)
  };
  const requests: (string | null)[] = [];
  return {
    initial,
    requests,
    fetchPage(requestCursor: string | null): StoryHistoryPage<Turn> {
      requests.push(requestCursor);
      if (requestCursor === null) return initial;
      const beforeTurn = cursorRows.get(requestCursor);
      if (!beforeTurn) throw new Error("The policy invented an unknown opaque cursor.");
      const lastTurn = beforeTurn - 1;
      const firstTurn = Math.max(1, lastTurn - 49);
      return {
        requestCursor,
        nextCursor: firstTurn > 1 ? cursorBefore(firstTurn) : null,
        turns: turns(firstTurn, lastTurn)
      };
    }
  };
}

function createWindow(total: number, server = syntheticServer(total)) {
  return createStoryHistoryWindow<Turn>({
    page: server.initial,
    selectedPreview: turns(12, 12)[0] ?? null
  });
}

function navigateHistory(state: StoryHistoryWindowState<Turn>, direction: "older" | "newer", server: ReturnType<typeof syntheticServer>, rows: Turn[] = []): StoryHistoryWindowState<Turn> {
  const request = storyHistoryPageRequest(state, direction);
  if (!request) return state;
  if (!request.requiresFetch) return installStoryHistoryWindowPage(state, request, null);
  state = installStoryHistoryWindowPage(state, request, null);
  const captured = new Set<string>();
  for (let attempt = 0; state.pending && attempt < 4; attempt += 1) {
    const next = storyHistoryPageRequest(state, direction);
    if (!next) throw new Error("Pending Story history navigation lost its captured source.");
    if (next.source === "server") {
      const key = String(next.requestCursor);
      if (captured.has(key)) throw new Error("Story history replay repeated a captured cursor without progress.");
      captured.add(key);
    }
    const page = next.source === "resident"
      ? { source: "resident" as const, requestCursor: null, nextCursor: null, turns: (rows.length ? rows : turns(next.targetStartTurnNumber, next.targetEndTurnNumber)).filter((turn) => next.targetTurnNumbers.includes(turn.turnNumber)) }
      : server.fetchPage(next.requestCursor);
    state = installStoryHistoryWindowPage(state, next, page);
  }
  if (state.pending) throw new Error("Story history navigation exceeded its bounded source count.");
  return state;
}

function visiblePage(state: StoryHistoryWindowState<Turn>): Turn[] {
  const visible = storyHistoryVisibleTurns(state);
  expect(visible.pageTurns.length + Number(visible.selectedPreview !== null)).toBeLessThanOrEqual(50);
  expect(state.cachedPages.reduce((count, page) => count + page.turns.length, 0)).toBeLessThanOrEqual(100);
  return [...visible.pageTurns];
}

function assertBoundedHistoryState(state: StoryHistoryWindowState<Turn>): void {
  expect(state.cachedPages.reduce((count, page) => count + page.turns.length, 0)).toBeLessThanOrEqual(100);
  const visible = storyHistoryVisibleTurns(state);
  expect(visible.pageTurns.length + Number(visible.selectedPreview !== null)).toBeLessThanOrEqual(50);
}

describe("bounded Story history window policy", () => {
  it("keeps an adjacent selected preview separate from the committed page within the 50-card cap", () => {
    const server = syntheticServer(317);
    let state = createWindow(317, server);

    let visible = storyHistoryVisibleTurns(state);
    expect(visible.pageTurns.map((turn) => turn.turnNumber)).toEqual(Array.from({ length: 49 }, (_, index) => index + 269));
    expect(visible.selectedPreview?.turnNumber).toBe(12);

    state = selectStoryHistoryPreview(state, turns(268, 268)[0] ?? null);
    visible = storyHistoryVisibleTurns(state);
    expect(visible.pageTurns.map((turn) => turn.turnNumber)).toEqual(Array.from({ length: 49 }, (_, index) => index + 269));
    expect(visible.selectedPreview?.turnNumber).toBe(268);
    expect(visible.pageTurns.length + 1).toBeLessThanOrEqual(50);

    state = selectStoryHistoryPreview(state, turns(12, 12)[0] ?? null);
    for (let attempt = 0; attempt < 8 && storyHistoryVisibleTurns(state).pageTurns[0]!.turnNumber > 12; attempt += 1) {
      const request = storyHistoryPageRequest(state, "older");
      expect(request, "history must retain an Older path until turn 12 enters the window").not.toBeNull();
      state = navigateHistory(state, "older", server);
    }
    visible = storyHistoryVisibleTurns(state);
    expect(visible.pageTurns.some((turn) => turn.id === "turn-12")).toBe(true);
    expect(visible.selectedPreview).toBeNull();
    expect(visible.pageTurns.length).toBeLessThanOrEqual(50);
  });

  it.each([317, 2000])("traverses all %i accepted turns once and replays released pages with captured cursors", (total) => {
    const server = syntheticServer(total);
    let state = createWindow(total, server);
    const olderPages: number[][] = [];

    for (let attempt = 0; attempt < Math.ceil(total / 49) + 3; attempt += 1) {
      olderPages.push(visiblePage(state).map((turn) => turn.turnNumber));
      const request = storyHistoryPageRequest(state, "older");
      if (!request) break;
      state = navigateHistory(state, "older", server);
    }

    const traversed = olderPages.flat();
    expect(traversed).toHaveLength(total);
    expect([...traversed].sort((left, right) => left - right)).toEqual(
      Array.from({ length: total }, (_, index) => index + 1)
    );
    if (total === 317) {
      expect(olderPages[0]).toEqual(Array.from({ length: 49 }, (_, index) => index + 269));
      expect(olderPages[1]).toContain(268);
      expect(traversed.filter((turnNumber) => turnNumber === 268)).toHaveLength(1);
    }

    const newerPages: number[][] = [];
    for (let attempt = 0; attempt < Math.ceil(total / 49) + 3; attempt += 1) {
      const request = storyHistoryPageRequest(state, "newer");
      if (!request) break;
      state = navigateHistory(state, "newer", server);
      newerPages.push(visiblePage(state).map((turn) => turn.turnNumber));
    }

    expect(newerPages).toEqual(olderPages.slice(0, -1).reverse());
    expect(server.requests).toContain(null);
    expect(server.requests.some((cursor) => cursor !== null)).toBe(true);
  });

  it("replaces a selected preview without changing page identity or exceeding the card limit", () => {
    const server = syntheticServer(317);
    let state = createWindow(317, server);
    state = selectStoryHistoryPreview(state, turns(12, 12)[0] ?? null);
    const before = storyHistoryVisibleTurns(state).pageTurns.map((turn) => turn.id);

    state = selectStoryHistoryPreview(state, turns(17, 17)[0] ?? null);
    const after = storyHistoryVisibleTurns(state);

    expect(after.pageTurns.map((turn) => turn.id)).toEqual(before);
    expect(after.selectedPreview?.id).toBe("turn-17");
    expect(after.pageTurns.length + 1).toBeLessThanOrEqual(50);
  });

  it.each([317, 2000])("pages a complete resident %i-turn ledger locally without inventing cursors", (total) => {
    const server = syntheticServer(total);
    const rows = turns(1, total);
    const recent = rows.slice(-50);
    let state = createStoryHistoryWindow<Turn>({
      page: { source: "server", requestCursor: null, nextCursor: null, turns: recent },
      selectedPreview: rows[11] ?? null,
      residentRange: { firstTurnNumber: 1, lastTurnNumber: total },
      residentTurnNumbers: rows.map((turn) => turn.turnNumber)
    });
    const olderPages: number[][] = [];

    for (let attempt = 0; attempt < Math.ceil(total / 48) + 4; attempt += 1) {
      olderPages.push(visiblePage(state).map((turn) => turn.turnNumber));
      const request = storyHistoryPageRequest(state, "older");
      if (!request) break;
      expect(request.source).toBe("resident");
      expect(request.requestCursor).toBeNull();
      state = navigateHistory(state, "older", server, rows);
    }

    const traversed = olderPages.flat();
    expect(traversed).toHaveLength(total);
    expect([...traversed].sort((left, right) => left - right)).toEqual(
      Array.from({ length: total }, (_, index) => index + 1)
    );

    const newerPages: number[][] = [];
    for (let attempt = 0; attempt < Math.ceil(total / 48) + 4; attempt += 1) {
      const request = storyHistoryPageRequest(state, "newer");
      if (!request) break;
      expect(request.source).toBe("resident");
      expect(request.requestCursor).toBeNull();
      state = navigateHistory(state, "newer", server, rows);
      newerPages.push(visiblePage(state).map((turn) => turn.turnNumber));
    }
    expect(newerPages).toEqual(olderPages.slice(0, -1).reverse());
    expect(server.requests).toEqual([]);
  });

  it.each([317, 2000])("traverses all %i server turns in exact 50-card windows when nothing is pinned", (total) => {
    const server = syntheticServer(total);
    let state = createStoryHistoryWindow<Turn>({ page: server.initial });
    const olderPages: number[][] = [];
    for (let attempt = 0; attempt < Math.ceil(total / 50) + 3; attempt += 1) {
      const page = visiblePage(state);
      expect(page.length).toBeLessThanOrEqual(50);
      olderPages.push(page.map((turn) => turn.turnNumber));
      const request = storyHistoryPageRequest(state, "older");
      if (!request) break;
      state = navigateHistory(state, "older", server);
    }
    const traversed = olderPages.flat();
    expect(traversed).toHaveLength(total);
    expect([...traversed].sort((left, right) => left - right)).toEqual(
      Array.from({ length: total }, (_, index) => index + 1)
    );
    expect(olderPages[0]).toHaveLength(50);

    const newerPages: number[][] = [];
    for (let attempt = 0; attempt < Math.ceil(total / 50) + 3; attempt += 1) {
      const request = storyHistoryPageRequest(state, "newer");
      if (!request) break;
      state = navigateHistory(state, "newer", server);
      newerPages.push(visiblePage(state).map((turn) => turn.turnNumber));
    }
    expect(newerPages).toEqual(olderPages.slice(0, -1).reverse());
  });

  it("carries the displaced row across a partial resident boundary before following the captured cursor", () => {
    const server = syntheticServer(318);
    const residentRows = turns(268, 317);
    let state = createStoryHistoryWindow<Turn>({
      page: server.initial,
      selectedPreview: turns(12, 12)[0] ?? null,
      residentRange: { firstTurnNumber: 268, lastTurnNumber: 317 },
      residentTurnNumbers: residentRows.map((turn) => turn.turnNumber)
    });
    const olderPages: number[][] = [];
    for (let attempt = 0; attempt < Math.ceil(318 / 49) + 10; attempt += 1) {
      olderPages.push(visiblePage(state).map((turn) => turn.turnNumber));
      const request = storyHistoryPageRequest(state, "older");
      if (!request) break;
      state = navigateHistory(state, "older", server, residentRows);
    }

    const traversed = olderPages.flat();
    expect(traversed).toHaveLength(318);
    expect([...traversed].sort((left, right) => left - right)).toEqual(
      Array.from({ length: 318 }, (_, index) => index + 1)
    );
    expect(traversed.filter((turnNumber) => turnNumber === 268)).toHaveLength(1);
    expect(server.requests).toContain("opaque-cursor-269-1");
    expect(olderPages[1]).toEqual(turns(221, 269).map((turn) => turn.turnNumber));
    expect(olderPages.flat().filter((turnNumber) => turnNumber === 269)).toHaveLength(1);

    const newerPages: number[][] = [];
    for (let attempt = 0; attempt < Math.ceil(318 / 49) + 10; attempt += 1) {
      const request = storyHistoryPageRequest(state, "newer");
      if (!request) break;
      state = navigateHistory(state, "newer", server, residentRows);
      newerPages.push(visiblePage(state).map((turn) => turn.turnNumber));
    }
    expect(newerPages).toEqual(olderPages.slice(0, -1).reverse());
  });

  it("rebases visited 50-turn windows when selecting an off-page preview without losing rows", () => {
    const total = 317;
    const rows = turns(1, total);
    let state = createStoryHistoryWindow<Turn>({
      page: { source: "resident", requestCursor: null, nextCursor: null, turns: rows.slice(-50) },
      residentRange: { firstTurnNumber: 1, lastTurnNumber: total },
      residentTurnNumbers: rows.map((turn) => turn.turnNumber)
    });

    for (let attempt = 0; attempt < Math.ceil(total / 50) + 4; attempt += 1) {
      const request = storyHistoryPageRequest(state, "older");
      if (!request) break;
      state = navigateHistory(state, "older", syntheticServer(total), rows);
    }
    expect(storyHistoryVisibleTurns(state).pageTurns.map((turn) => turn.turnNumber)).toEqual(turns(1, 17).map((turn) => turn.turnNumber));

    state = selectStoryHistoryPreview(state, rows.at(-1) ?? null);
    const newerPages: number[][] = [storyHistoryVisibleTurns(state).pageTurns.map((turn) => turn.turnNumber)];
    for (let attempt = 0; attempt < Math.ceil(total / 49) + 4; attempt += 1) {
      const request = storyHistoryPageRequest(state, "newer");
      if (!request) break;
      state = navigateHistory(state, "newer", syntheticServer(total), rows);
      newerPages.push(storyHistoryVisibleTurns(state).pageTurns.map((turn) => turn.turnNumber));
    }

    const traversed = newerPages.flat();
    expect(traversed, JSON.stringify(newerPages.map((page) => [page[0], page.at(-1)]))).toHaveLength(total);
    expect([...traversed].sort((left, right) => left - right)).toEqual(
      Array.from({ length: total }, (_, index) => index + 1)
    );
    expect(new Set(traversed).size).toBe(total);
    for (const page of newerPages) expect(page.length + Number(!page.includes(total))).toBeLessThanOrEqual(50);
  });

  it("keeps a stable Turn 268 pin from duplicating the Older boundary in reverse traversal", () => {
    const total = 317;
    const rows = turns(1, total);
    const server = syntheticServer(total);
    let state = createStoryHistoryWindow<Turn>({
      page: { source: "resident", requestCursor: null, nextCursor: null, turns: rows.slice(-50) },
      selectedPreview: rows[267] ?? null,
      residentRange: { firstTurnNumber: 1, lastTurnNumber: total },
      residentTurnNumbers: rows.map((turn) => turn.turnNumber)
    });
    const olderPages: number[][] = [];
    for (let attempt = 0; attempt < Math.ceil(total / 49) + 8; attempt += 1) {
      olderPages.push(visiblePage(state).map((turn) => turn.turnNumber));
      const request = storyHistoryPageRequest(state, "older");
      if (!request) break;
      state = navigateHistory(state, "older", server, rows);
    }
    const traversed = olderPages.flat();
    expect(traversed).toHaveLength(total);
    expect([...traversed].sort((left, right) => left - right)).toEqual(
      Array.from({ length: total }, (_, index) => index + 1)
    );
    expect(new Set(traversed).size).toBe(total);

    const newerPages: number[][] = [];
    for (let attempt = 0; attempt < Math.ceil(total / 49) + 8; attempt += 1) {
      const request = storyHistoryPageRequest(state, "newer");
      if (!request) break;
      state = navigateHistory(state, "newer", server, rows);
      newerPages.push(visiblePage(state).map((turn) => turn.turnNumber));
    }
    expect(newerPages).toEqual(olderPages.slice(0, -1).reverse());
  });

  it("keeps adjacent exact previews separate and the next Older boundary contiguous after clear", () => {
    const total = 317;
    const rows = turns(1, total);
    const server = syntheticServer(total);
    let state = createStoryHistoryWindow<Turn>({
      page: { source: "resident", requestCursor: null, nextCursor: null, turns: rows.slice(-50) },
      selectedPreview: turns(12, 12)[0] ?? null,
      residentRange: { firstTurnNumber: 1, lastTurnNumber: total },
      residentTurnNumbers: rows.map((turn) => turn.turnNumber)
    });
    state = navigateHistory(state, "older", server, rows);
    const before = storyHistoryVisibleTurns(state);
    expect(before.firstTurnNumber).not.toBeNull();
    const adjacent = rows.find((turn) => turn.turnNumber === Number(before.firstTurnNumber) - 1);
    expect(adjacent).toBeDefined();

    state = selectStoryHistoryPreview(state, adjacent ?? null);
    const pinned = storyHistoryVisibleTurns(state);
    expect(pinned.selectedPreview?.id).toBe(adjacent?.id);
    expect(pinned.pageTurns.some((turn) => turn.id === adjacent?.id)).toBe(false);
    expect(pinned.pageTurns.length + 1).toBeLessThanOrEqual(50);

    state = selectStoryHistoryPreview(state, null);
    const cleared = storyHistoryVisibleTurns(state);
    expect(cleared.firstTurnNumber).toBe(cleared.pageTurns[0]?.turnNumber ?? null);
    expect(cleared.lastTurnNumber).toBe(cleared.pageTurns.at(-1)?.turnNumber ?? null);
    const clearedNumbers = cleared.pageTurns.map((turn) => turn.turnNumber);

    const older = storyHistoryPageRequest(state, "older");
    expect(older).not.toBeNull();
    state = navigateHistory(state, "older", server, rows);
    const olderNumbers = visiblePage(state).map((turn) => turn.turnNumber);
    expect(olderNumbers.at(-1)).toBe(clearedNumbers[0]! - 1);
    expect(olderNumbers.some((turnNumber) => clearedNumbers.includes(turnNumber))).toBe(false);
    state = navigateHistory(state, "newer", server, rows);
    expect(visiblePage(state).map((turn) => turn.turnNumber)).toEqual(clearedNumbers);
  });

  it.each(["duplicate number", "duplicate identity"] as const)("rejects a conflicting %s inside one fetched source page", (conflict) => {
    const server = syntheticServer(317);
    const initial = createStoryHistoryWindow<Turn>({
      page: { requestCursor: null, nextCursor: "opaque-before-268", turns: turns(268, 317) },
      selectedPreview: turns(12, 12)[0] ?? null
    });
    const prepareRequest = storyHistoryPageRequest(initial, "older");
    expect(prepareRequest?.requiresFetch).toBe(true);
    const prepared = installStoryHistoryWindowPage(initial, prepareRequest!, null);
    const sourceRequest = storyHistoryPageRequest(prepared, "older");
    expect(sourceRequest?.requestCursor).toBe("opaque-before-268");
    const incoming = turns(218, 267);
    if (conflict === "duplicate number") incoming[0] = { id: "conflicting-id-for-turn-220", turnNumber: 220, narration: "conflict" };
    else incoming[3] = { id: "turn-220", turnNumber: 221, narration: "conflict" };

    expect(() => installStoryHistoryWindowPage(prepared, sourceRequest!, {
      requestCursor: sourceRequest!.requestCursor,
      nextCursor: "opaque-before-218",
      turns: incoming
    })).toThrow(/identit/i);
    expect(prepared.pending).not.toBeNull();
    expect(storyHistoryVisibleTurns(prepared).pageTurns.map((turn) => turn.turnNumber)).toEqual(turns(269, 317).map((turn) => turn.turnNumber));
    expect(server.requests).toEqual([]);
  });

  it("cancels a prepared navigation when the selected preview changes", () => {
    const initial = createStoryHistoryWindow<Turn>({
      page: { requestCursor: null, nextCursor: "opaque-before-268", turns: turns(268, 317) },
      selectedPreview: turns(12, 12)[0] ?? null
    });
    const request = storyHistoryPageRequest(initial, "older");
    expect(request?.requiresFetch).toBe(true);
    const prepared = installStoryHistoryWindowPage(initial, request!, null);
    expect(prepared.pending).not.toBeNull();

    const changed = selectStoryHistoryPreview(prepared, turns(13, 13)[0] ?? null);

    expect(changed.pending).toBeNull();
    expect(storyHistoryVisibleTurns(changed).selectedPreview?.turnNumber).toBe(13);
    expect(storyHistoryVisibleTurns(changed).pageTurns.map((turn) => turn.turnNumber)).toEqual(
      storyHistoryVisibleTurns(prepared).pageTurns.map((turn) => turn.turnNumber)
    );
    assertBoundedHistoryState(changed);
  });

  it("rejects a replay whose captured source bounds changed", () => {
    const initial = createStoryHistoryWindow<Turn>({
      page: { requestCursor: null, nextCursor: "opaque-before-268", turns: turns(268, 317) },
      selectedPreview: turns(12, 12)[0] ?? null
    });
    const older = storyHistoryPageRequest(initial, "older");
    const prepared = installStoryHistoryWindowPage(initial, older!, null);
    const sourceRequest = storyHistoryPageRequest(prepared, "older");
    const partial = installStoryHistoryWindowPage(prepared, sourceRequest!, {
      requestCursor: sourceRequest!.requestCursor,
      nextCursor: "opaque-before-218",
      turns: turns(218, 240)
    });
    expect(partial.pending).not.toBeNull();

    expect(() => installStoryHistoryWindowPage(partial, sourceRequest!, {
      requestCursor: sourceRequest!.requestCursor,
      nextCursor: "opaque-before-168",
      turns: turns(168, 217)
    })).toThrow(/captured source bounds/i);
    expect(partial.pending).not.toBeNull();
    assertBoundedHistoryState(partial);
  });

  it("rejects a repeated accepted source page that makes no progress toward its target", () => {
    const initial = createStoryHistoryWindow<Turn>({
      page: { requestCursor: null, nextCursor: "opaque-before-268", turns: turns(268, 317) },
      selectedPreview: turns(12, 12)[0] ?? null
    });
    const older = storyHistoryPageRequest(initial, "older");
    const prepared = installStoryHistoryWindowPage(initial, older!, null);
    const sourceRequest = storyHistoryPageRequest(prepared, "older");

    const response = {
      requestCursor: sourceRequest!.requestCursor,
      nextCursor: "opaque-before-218",
      turns: turns(218, 267)
    };
    const completed = installStoryHistoryWindowPage(prepared, sourceRequest!, response);
    expect(completed.pending).toBeNull();
    expect(() => installStoryHistoryWindowPage(completed, sourceRequest!, response)).toThrow(/no progress/i);
    expect(prepared.pending).not.toBeNull();
    assertBoundedHistoryState(prepared);
  });

  it("rejects an opaque server cursor that repeats instead of advancing", () => {
    const initial = createStoryHistoryWindow<Turn>({
      page: { requestCursor: null, nextCursor: "opaque-before-268", turns: turns(268, 317) },
      selectedPreview: turns(12, 12)[0] ?? null
    });
    const older = storyHistoryPageRequest(initial, "older");
    const prepared = installStoryHistoryWindowPage(initial, older!, null);
    const sourceRequest = storyHistoryPageRequest(prepared, "older");

    expect(() => installStoryHistoryWindowPage(prepared, sourceRequest!, {
      requestCursor: sourceRequest!.requestCursor,
      nextCursor: sourceRequest!.requestCursor,
      turns: turns(218, 240)
    })).toThrow(/cursor.*repeat|repeat.*cursor/i);
    expect(prepared.pending).not.toBeNull();
    assertBoundedHistoryState(prepared);
  });

  it("replays a source-straddling Newer window atomically and retries only its missing captured source", () => {
    const server = syntheticServer(317);
    let state = createWindow(317, server);
    for (let attempt = 0; attempt < Math.ceil(317 / 49) + 4; attempt += 1) {
      if (!storyHistoryPageRequest(state, "older")) break;
      state = navigateHistory(state, "older", server);
    }
    expect(storyHistoryVisibleTurns(state).pageTurns.map((turn) => turn.turnNumber)).toEqual(turns(1, 23).map((turn) => turn.turnNumber));
    const committedBefore = storyHistoryVisibleTurns(state).pageTurns.map((turn) => turn.id);

    const start = storyHistoryPageRequest(state, "newer");
    expect(start).not.toBeNull();
    expect(start?.targetWindowFirstTurnNumber).toBe(24);
    expect(start?.targetWindowLastTurnNumber).toBe(72);
    state = installStoryHistoryWindowPage(state, start!, null);
    assertBoundedHistoryState(state);
    expect(storyHistoryVisibleTurns(state).pageTurns.map((turn) => turn.id)).toEqual(committedBefore);
    expect(state.pending).not.toBeNull();

    const firstSource = storyHistoryPageRequest(state, "newer");
    expect(firstSource?.source).toBe("server");
    expect(firstSource?.requestCursor).toBeTruthy();
    expect(storyHistoryVisibleTurns(state).pageTurns.map((turn) => turn.id)).toEqual(committedBefore);
    const stagedNumbers = new Set(state.cachedPages.flatMap((page) => page.turns.map((turn) => turn.turnNumber)));
    expect(Array.from({ length: 44 }, (_, index) => index + 24).every((turnNumber) => stagedNumbers.has(turnNumber))).toBe(true);
    expect(Array.from({ length: 5 }, (_, index) => index + 68).some((turnNumber) => stagedNumbers.has(turnNumber))).toBe(false);

    let sourceAttempts = 0;
    try {
      sourceAttempts += 1;
      throw new Error("private backend diagnostic must not replace the committed window");
    } catch {
      // A failed transport leaves the immutable policy state pending for retry.
    }
    expect(storyHistoryVisibleTurns(state).pageTurns.map((turn) => turn.id)).toEqual(committedBefore);
    assertBoundedHistoryState(state);
    const retry = storyHistoryPageRequest(state, "newer");
    expect(sourceAttempts).toBe(1);
    expect(retry?.requestCursor).toBe(firstSource?.requestCursor);
    expect(retry?.requestCursor).toBeTruthy();
    const retryCursor = retry?.requestCursor ?? null;

    const retryPage = server.fetchPage(retryCursor);
    expect(retryPage.turns.map((turn) => turn.turnNumber)).toEqual(turns(68, 117).map((turn) => turn.turnNumber));
    state = installStoryHistoryWindowPage(state, retry!, retryPage);
    expect(state.pending).toBeNull();
    expect(storyHistoryVisibleTurns(state).pageTurns.map((turn) => turn.turnNumber)).toEqual(turns(24, 72).map((turn) => turn.turnNumber));
    expect(storyHistoryVisibleTurns(state).selectedPreview?.turnNumber).toBe(12);
    expect(server.requests).toContain(retryCursor);
    assertBoundedHistoryState(state);
  });
});
