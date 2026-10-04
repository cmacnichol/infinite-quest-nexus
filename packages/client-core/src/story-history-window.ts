export const STORY_HISTORY_PAGE_LIMIT = 50;
export const STORY_HISTORY_RAW_CACHE_LIMIT = 100;

export type StoryHistoryTurn = { readonly id: string; readonly turnNumber: number };

export type StoryHistoryPage<TTurn extends StoryHistoryTurn = StoryHistoryTurn> = {
  readonly requestCursor: string | null;
  readonly nextCursor: string | null;
  readonly source?: "server" | "resident";
  readonly turns: readonly TTurn[];
};

type StoryHistoryPageBookmark = {
  readonly sourceKey: number;
  readonly requestCursor: string | null;
  readonly nextCursor: string | null;
  readonly source: "server" | "resident";
  readonly firstTurnNumber: number;
  readonly lastTurnNumber: number;
  readonly identities: readonly StoryHistoryTurn[];
};

type StoryHistoryDisplayWindow = {
  readonly turnNumbers: readonly number[];
  readonly firstTurnNumber: number;
  readonly lastTurnNumber: number;
  readonly sourceKeys: readonly number[];
};

type StoryHistoryPendingNavigation = {
  readonly direction: "older" | "newer";
  readonly targetWindowIndex: number;
  readonly turnNumbers: readonly number[];
  readonly sourceKeys: readonly number[];
  readonly attemptedSourceKeys: readonly number[];
  readonly fallbackCursor: string | null;
};

type StoryHistoryCachedPage<TTurn extends StoryHistoryTurn> = StoryHistoryPage<TTurn> & StoryHistoryPageBookmark;

type StoryHistoryWindowPosition = {
  readonly direction: "initial" | "older" | "newer";
  readonly anchorTurnNumber: number | null;
};

export type StoryHistoryPageRequest = {
  readonly direction: "older" | "newer";
  readonly source: "server" | "resident";
  readonly requestCursor: string | null;
  readonly anchorTurnNumber: number;
  readonly targetStartTurnNumber: number;
  readonly targetEndTurnNumber: number;
  /** Exact accepted ordinals required to complete the display window. */
  readonly targetWindowTurnNumbers: readonly number[];
  /** Exact accepted ordinals requested from this source page. */
  readonly targetTurnNumbers: readonly number[];
  readonly targetWindowFirstTurnNumber: number;
  readonly targetWindowLastTurnNumber: number;
  readonly targetWindowIndex: number;
  readonly sourceBookmarkKey?: number;
  readonly targetSourceKeys?: readonly number[];
  readonly requiresFetch: boolean;
};

export type StoryHistoryWindowState<TTurn extends StoryHistoryTurn = StoryHistoryTurn> = {
  /** Retained raw rows contributing to the committed window and pending target. */
  readonly cachedPages: readonly StoryHistoryCachedPage<TTurn>[];
  /** Opaque cursors and accepted identities retained for bounded replay after row eviction. */
  readonly pageStack: readonly StoryHistoryPageBookmark[];
  /** Metadata-only accepted-entry windows; ordinal gaps do not imply missing turns. */
  readonly windows: readonly StoryHistoryDisplayWindow[];
  readonly windowIndex: number;
  readonly pending: StoryHistoryPendingNavigation | null;
  readonly nextSourceKey: number;
  readonly selectedPreview: TTurn | null;
  readonly residentRange: { readonly firstTurnNumber: number; readonly lastTurnNumber: number } | null;
  /** Accepted ordinals from the already-loaded resident ledger, used only as row keys. */
  readonly residentTurnNumbers: readonly number[];
  readonly position: StoryHistoryWindowPosition;
  readonly historyToken: string | null;
};

export type StoryHistoryVisibleWindow<TTurn extends StoryHistoryTurn = StoryHistoryTurn> = {
  /** Accepted page turns, in chronological order; the pinned preview is separate. */
  readonly pageTurns: readonly TTurn[];
  /** Selected turn only when it is outside pageTurns. */
  readonly selectedPreview: TTurn | null;
  readonly firstTurnNumber: number | null;
  readonly lastTurnNumber: number | null;
};

function orderedTurns<TTurn extends StoryHistoryTurn>(turns: readonly TTurn[]): TTurn[] {
  return [...turns].sort((left, right) => left.turnNumber - right.turnNumber);
}

function assertUniqueTurnIdentities<TTurn extends StoryHistoryTurn>(turns: readonly TTurn[]): void {
  const byNumber = new Map<number, TTurn>();
  const byId = new Map<string, TTurn>();
  for (const turn of turns) {
    const existingNumber = byNumber.get(turn.turnNumber);
    const existingId = byId.get(turn.id);
    if ((existingNumber && existingNumber.id !== turn.id) || (existingId && existingId.turnNumber !== turn.turnNumber)) {
      throw new Error("Story history response contains conflicting turn identities.");
    }
    byNumber.set(turn.turnNumber, turn);
    byId.set(turn.id, turn);
  }
}

function bookmarkFor<TTurn extends StoryHistoryTurn>(page: StoryHistoryPage<TTurn>, sourceKey: number): StoryHistoryPageBookmark {
  const turns = orderedTurns(page.turns);
  return {
    sourceKey,
    requestCursor: page.requestCursor,
    nextCursor: page.nextCursor,
    source: page.source ?? "server",
    firstTurnNumber: turns[0]?.turnNumber ?? 0,
    lastTurnNumber: turns.at(-1)?.turnNumber ?? 0,
    identities: turns.map(({ id, turnNumber }) => ({ id, turnNumber }))
  };
}

function allCachedTurns<TTurn extends StoryHistoryTurn>(state: StoryHistoryWindowState<TTurn>): TTurn[] {
  const byNumber = new Map<number, TTurn>();
  const byId = new Map<string, TTurn>();
  for (const page of state.cachedPages) {
    for (const turn of page.turns) {
      const existingNumber = byNumber.get(turn.turnNumber);
      const existingId = byId.get(turn.id);
      if ((existingNumber && existingNumber.id !== turn.id) || (existingId && existingId.turnNumber !== turn.turnNumber)) {
        throw new Error("Story history contains conflicting turn identities.");
      }
      byNumber.set(turn.turnNumber, turn);
      byId.set(turn.id, turn);
    }
  }
  return orderedTurns([...byNumber.values()]);
}

function sourceByKey<TTurn extends StoryHistoryTurn>(state: StoryHistoryWindowState<TTurn>, sourceKey: number): StoryHistoryPageBookmark | null {
  return state.pageStack.find((page) => page.sourceKey === sourceKey) ?? null;
}

function allKnownTurnNumbers<TTurn extends StoryHistoryTurn>(state: StoryHistoryWindowState<TTurn>): number[] {
  return [...new Set([
    ...state.residentTurnNumbers,
    ...state.pageStack.flatMap((page) => page.identities.map((turn) => turn.turnNumber))
  ])].sort((left, right) => left - right);
}

function hasOlderSource<TTurn extends StoryHistoryTurn>(state: StoryHistoryWindowState<TTurn>): boolean {
  const oldest = state.pageStack.filter((page) => page.source === "server")
    .sort((left, right) => left.firstTurnNumber - right.firstTurnNumber)[0];
  return Boolean(oldest?.nextCursor);
}

function sourceKeysForNumbers<TTurn extends StoryHistoryTurn>(state: StoryHistoryWindowState<TTurn>, numbers: readonly number[]): number[] {
  const wanted = new Set(numbers);
  return state.pageStack.filter((page) => page.identities.some((identity) => wanted.has(identity.turnNumber)))
    .map((page) => page.sourceKey);
}

function makeWindow<TTurn extends StoryHistoryTurn>(state: StoryHistoryWindowState<TTurn>, turnNumbers: readonly number[]): StoryHistoryDisplayWindow {
  const ordered = [...turnNumbers].sort((left, right) => left - right);
  return {
    turnNumbers: ordered,
    firstTurnNumber: ordered[0] ?? 0,
    lastTurnNumber: ordered.at(-1) ?? 0,
    sourceKeys: sourceKeysForNumbers(state, ordered)
  };
}

function buildWindows<TTurn extends StoryHistoryTurn>(
  state: StoryHistoryWindowState<TTurn>,
  capacity: number,
  includePartialOldest: boolean
): StoryHistoryDisplayWindow[] {
  const numbers = allKnownTurnNumbers(state);
  const reversed: number[][] = [];
  let end = numbers.length;
  while (end > 0) {
    const selectedIndex = state.selectedPreview
      ? numbers.findIndex((turnNumber) => turnNumber === state.selectedPreview?.turnNumber)
      : -1;
    const expandedStart = Math.max(0, end - STORY_HISTORY_PAGE_LIMIT);
    const otherCapacity = state.selectedPreview ? STORY_HISTORY_PAGE_LIMIT - 1 : capacity;
    const start = selectedIndex >= expandedStart && selectedIndex < end
      ? expandedStart
      : Math.max(0, end - otherCapacity);
    reversed.push(numbers.slice(start, end));
    end = start;
  }
  let windows = reversed.reverse().map((turnNumbers) => makeWindow(state, turnNumbers));
  const firstWindow = windows[0];
  if (!includePartialOldest && windows.length > 1 && firstWindow && firstWindow.turnNumbers.length < capacity) {
    windows = windows.slice(1);
  }
  return windows;
}

function rowsOnSide(numbers: readonly number[], current: StoryHistoryDisplayWindow, side: "older" | "newer"): number[] {
  return numbers.filter((turnNumber) => side === "older"
    ? turnNumber < current.firstTurnNumber
    : turnNumber > current.lastTurnNumber);
}

function windowsOnSide<TTurn extends StoryHistoryTurn>(state: StoryHistoryWindowState<TTurn>, numbers: readonly number[], capacity: number, side: "older" | "newer"): StoryHistoryDisplayWindow[] {
  const result: StoryHistoryDisplayWindow[] = [];
  if (side === "older") {
    let end = numbers.length;
    while (end > 0) {
      const start = Math.max(0, end - capacity);
      result.unshift(makeWindow(state, numbers.slice(start, end)));
      end = start;
    }
  } else {
    for (let start = 0; start < numbers.length; start += capacity) {
      result.push(makeWindow(state, numbers.slice(start, start + capacity)));
    }
  }
  return result;
}

function trimHistoryCache<TTurn extends StoryHistoryTurn>(state: StoryHistoryWindowState<TTurn>): StoryHistoryWindowState<TTurn> {
  const current = state.windows[state.windowIndex];
  const preferredAdjacentIndex = state.position.direction === "newer" ? state.windowIndex + 1 : state.windowIndex - 1;
  const oppositeAdjacentIndex = state.position.direction === "newer" ? state.windowIndex - 1 : state.windowIndex + 1;
  const adjacent = state.windows[preferredAdjacentIndex] ?? state.windows[oppositeAdjacentIndex];
  const keepNumbers = new Set<number>();
  const addUntilBounded = (numbers: readonly number[]): void => {
    for (const number of numbers) {
      if (keepNumbers.size >= STORY_HISTORY_RAW_CACHE_LIMIT) break;
      keepNumbers.add(number);
    }
  };
  addUntilBounded(current?.turnNumbers ?? []);
  addUntilBounded(state.pending?.turnNumbers ?? []);
  const cachedPageByKey = new Map<number, StoryHistoryCachedPage<TTurn>[]>();
  for (const page of state.cachedPages) {
    const pages = cachedPageByKey.get(page.sourceKey) ?? [];
    pages.push(page);
    cachedPageByKey.set(page.sourceKey, pages);
  }
  const addSourceRows = (sourceKeys: readonly number[]): void => {
    for (const sourceKey of sourceKeys) {
      const rows = new Map<number, TTurn>();
      for (const page of cachedPageByKey.get(sourceKey) ?? []) {
        for (const turn of page.turns) rows.set(turn.turnNumber, turn);
      }
      const additions = [...rows.keys()].filter((turnNumber) => !keepNumbers.has(turnNumber));
      if (keepNumbers.size + additions.length <= STORY_HISTORY_RAW_CACHE_LIMIT) {
        addUntilBounded([...rows.keys()]);
      }
    }
  };
  addSourceRows(current?.sourceKeys ?? []);
  addSourceRows(state.pending?.sourceKeys ?? []);
  if (adjacent) {
    const currentSources = new Set([...(current?.sourceKeys ?? []), ...(state.pending?.sourceKeys ?? [])]);
    const adjacentSource = adjacent.sourceKeys.find((sourceKey) => !currentSources.has(sourceKey));
    if (adjacentSource !== undefined) addSourceRows([adjacentSource]);
  }
  const seen = new Set<number>();
  const cachedPages = state.cachedPages.map((page) => ({
    ...page,
    turns: page.turns.filter((turn) => {
      if (!keepNumbers.has(turn.turnNumber) || seen.has(turn.turnNumber)) return false;
      seen.add(turn.turnNumber);
      return true;
    })
  })).filter((page) => page.turns.length > 0);
  if (cachedPages.reduce((count, page) => count + page.turns.length, 0) > STORY_HISTORY_RAW_CACHE_LIMIT) {
    throw new Error("Story history raw cache exceeds " + STORY_HISTORY_RAW_CACHE_LIMIT + " turns.");
  }
  return { ...state, cachedPages };
}

function windowTurns<TTurn extends StoryHistoryTurn>(state: StoryHistoryWindowState<TTurn>, numbers: readonly number[]): TTurn[] | null {
  const byNumber = new Map(allCachedTurns(state).map((turn) => [turn.turnNumber, turn]));
  const turns = numbers.map((turnNumber) => byNumber.get(turnNumber));
  return turns.every((turn): turn is TTurn => Boolean(turn)) ? turns : null;
}

function turnNumbersIn(state: StoryHistoryWindowState, candidates: readonly number[]): number[] {
  const present = new Set(allKnownTurnNumbers(state));
  return candidates.filter((number) => present.has(number));
}

function newPageRequest(
  direction: "older" | "newer",
  source: "server" | "resident",
  requestCursor: string | null,
  anchorTurnNumber: number,
  targetTurnNumbers: readonly number[],
  targetWindowIndex: number,
  requiresFetch: boolean,
  options: {
    sourceBookmarkKey?: number;
    targetSourceKeys?: readonly number[];
    targetWindowTurnNumbers?: readonly number[];
  } = {}
): StoryHistoryPageRequest {
  const sorted = [...targetTurnNumbers].sort((left, right) => left - right);
  const windowNumbers = [...(options.targetWindowTurnNumbers ?? sorted)].sort((left, right) => left - right);
  return {
    direction,
    source,
    requestCursor,
    anchorTurnNumber,
    targetStartTurnNumber: windowNumbers[0] ?? anchorTurnNumber,
    targetEndTurnNumber: windowNumbers.at(-1) ?? anchorTurnNumber,
    targetWindowTurnNumbers: windowNumbers,
    targetTurnNumbers: sorted,
    targetWindowFirstTurnNumber: windowNumbers[0] ?? anchorTurnNumber,
    targetWindowLastTurnNumber: windowNumbers.at(-1) ?? anchorTurnNumber,
    targetWindowIndex,
    ...(options.sourceBookmarkKey !== undefined ? { sourceBookmarkKey: options.sourceBookmarkKey } : {}),
    ...(options.targetSourceKeys ? { targetSourceKeys: options.targetSourceKeys } : {}),
    requiresFetch
  };
}

function requestForPending<TTurn extends StoryHistoryTurn>(
  state: StoryHistoryWindowState<TTurn>,
  pending: StoryHistoryPendingNavigation
): StoryHistoryPageRequest | null {
  if (pending.turnNumbers.length === 0) {
    if (!pending.fallbackCursor) return null;
    const current = state.windows[state.windowIndex];
    const anchor = current?.firstTurnNumber ?? 1;
    return newPageRequest(pending.direction, "server", pending.fallbackCursor, anchor, [], pending.targetWindowIndex, true);
  }
  const retained = new Set(allCachedTurns(state).map((turn) => turn.turnNumber));
  const missing = pending.turnNumbers.filter((turnNumber) => !retained.has(turnNumber));
  if (missing.length === 0) return null;
  const residentNumbers = new Set(state.residentTurnNumbers);
  const residentMissing = missing.filter((turnNumber) => residentNumbers.has(turnNumber));
  if (residentMissing.length === missing.length && residentMissing.length > 0) {
    return newPageRequest(pending.direction, "resident", null, pending.turnNumbers[0] ?? 1, residentMissing,
      pending.targetWindowIndex, true, { targetSourceKeys: pending.sourceKeys, targetWindowTurnNumbers: pending.turnNumbers });
  }
  const tried = new Set(pending.attemptedSourceKeys);
  const candidate = pending.sourceKeys.map((key) => sourceByKey(state, key))
    .filter((source): source is StoryHistoryPageBookmark => Boolean(source && !tried.has(source.sourceKey)
      && source.identities.some((identity) => missing.includes(identity.turnNumber))))
    .concat(state.pageStack.filter((source) => !tried.has(source.sourceKey)
      && source.identities.some((identity) => missing.includes(identity.turnNumber))))
    .sort((left, right) => left.firstTurnNumber - right.firstTurnNumber)[0];
  if (candidate) {
    const targetTurnNumbers = missing.filter((turnNumber) => candidate.identities.some((identity) => identity.turnNumber === turnNumber));
    return newPageRequest(pending.direction, candidate.source, candidate.requestCursor,
      pending.turnNumbers[0] ?? 1, targetTurnNumbers, pending.targetWindowIndex, true,
      { sourceBookmarkKey: candidate.sourceKey, targetSourceKeys: pending.sourceKeys, targetWindowTurnNumbers: pending.turnNumbers });
  }
  return null;
}

function requestForWindow<TTurn extends StoryHistoryTurn>(
  state: StoryHistoryWindowState<TTurn>,
  direction: "older" | "newer", target: StoryHistoryDisplayWindow, targetIndex: number
): StoryHistoryPageRequest {
  const cachedNumbers = new Set(allCachedTurns(state).map((turn) => turn.turnNumber));
  const missing = target.turnNumbers.filter((turnNumber) => !cachedNumbers.has(turnNumber));
  if (missing.length === 0) {
    return newPageRequest(direction, "resident", null, target.firstTurnNumber, [], targetIndex, false,
      { targetSourceKeys: target.sourceKeys, targetWindowTurnNumbers: target.turnNumbers });
  }
  const allResident = missing.every((turnNumber) => state.residentTurnNumbers.includes(turnNumber));
  if (allResident) {
    return newPageRequest(direction, "resident", null, target.firstTurnNumber, target.turnNumbers, targetIndex, true,
      { targetSourceKeys: target.sourceKeys, targetWindowTurnNumbers: target.turnNumbers });
  }
  const bookmark = target.sourceKeys.map((key) => sourceByKey(state, key))
    .find((page): page is StoryHistoryPageBookmark => Boolean(page && page.identities.some((identity) => missing.includes(identity.turnNumber))));
  if (!bookmark) {
    const known = state.pageStack.find((page) => page.identities.some((identity) => missing.includes(identity.turnNumber)));
    if (!known) throw new Error("Story history target has no captured source page.");
    return newPageRequest(direction, known.source, known.requestCursor, target.firstTurnNumber, missing, targetIndex, true,
      { sourceBookmarkKey: known.sourceKey, targetSourceKeys: target.sourceKeys, targetWindowTurnNumbers: target.turnNumbers });
  }
  const sourceNumbers = missing.filter((turnNumber) => bookmark.identities.some((identity) => identity.turnNumber === turnNumber));
  return newPageRequest(direction, bookmark.source, bookmark.requestCursor, target.firstTurnNumber, sourceNumbers, targetIndex, true,
    { sourceBookmarkKey: bookmark.sourceKey, targetSourceKeys: target.sourceKeys, targetWindowTurnNumbers: target.turnNumbers });
}

export function createStoryHistoryWindow<TTurn extends StoryHistoryTurn>(options: {
  readonly page: StoryHistoryPage<TTurn>;
  readonly selectedPreview?: TTurn | null;
  readonly residentRange?: { readonly firstTurnNumber: number; readonly lastTurnNumber: number } | null;
  readonly residentTurnNumbers?: readonly number[];
}): StoryHistoryWindowState<TTurn> {
  const turns = orderedTurns(options.page.turns);
  if (turns.length > STORY_HISTORY_PAGE_LIMIT) {
    throw new Error("Story history page exceeds " + STORY_HISTORY_PAGE_LIMIT + " turns.");
  }
  assertUniqueTurnIdentities(turns);
  const page = { ...options.page, turns };
  const selectedPreview = options.selectedPreview ?? null;
  const bookmark = bookmarkFor(page, 1);
  const residentTurnNumbers = [...new Set(options.residentTurnNumbers ?? [])].sort((left, right) => left - right);
  const provisional: StoryHistoryWindowState<TTurn> = {
    cachedPages: [Object.assign({}, page, bookmark)],
    pageStack: [bookmark],
    windows: [],
    windowIndex: 0,
    pending: null,
    nextSourceKey: 2,
    selectedPreview,
    residentRange: options.residentRange ?? null,
    residentTurnNumbers,
    position: { direction: "initial", anchorTurnNumber: turns.at(-1)?.turnNumber ?? null },
    historyToken: null
  };
  const initialNumbers = allKnownTurnNumbers(provisional);
  const selectedIsInInitialPage = Boolean(selectedPreview && turns.some((turn) => turn.id === selectedPreview.id
    && turn.turnNumber === selectedPreview.turnNumber));
  const capacity = selectedPreview && !selectedIsInInitialPage
    ? STORY_HISTORY_PAGE_LIMIT - 1
    : STORY_HISTORY_PAGE_LIMIT;
  const windows = buildWindows(provisional, capacity, !hasOlderSource(provisional));
  const state = { ...provisional, windows, windowIndex: windows.length - 1 };
  // An externally pinned preview reserves one card while preserving the newest accepted row order.
  if (initialNumbers.length === 0) return state;
  return trimHistoryCache(state);
}

export function selectStoryHistoryPreview<TTurn extends StoryHistoryTurn>(
  state: StoryHistoryWindowState<TTurn>, selectedPreview: TTurn | null
): StoryHistoryWindowState<TTurn> {
  const current = state.windows[state.windowIndex];
  const updated = { ...state, selectedPreview, pending: null };
  if (!current) return trimHistoryCache(updated);
  let currentNumbers = [...current.turnNumbers];
  if (selectedPreview && !currentNumbers.includes(selectedPreview.turnNumber)
    && currentNumbers.length > STORY_HISTORY_PAGE_LIMIT - 1) {
    currentNumbers = currentNumbers.slice(1);
  }
  const committed = makeWindow(updated, currentNumbers);
  const known = allKnownTurnNumbers(updated);
  const sideCapacity = selectedPreview ? STORY_HISTORY_PAGE_LIMIT - 1 : STORY_HISTORY_PAGE_LIMIT;
  let older = windowsOnSide(updated, rowsOnSide(known, committed, "older"), sideCapacity, "older");
  const oldestWindow = older[0];
  if (hasOlderSource(updated) && oldestWindow && oldestWindow.turnNumbers.length < sideCapacity) older = older.slice(1);
  const newer = windowsOnSide(updated, rowsOnSide(known, committed, "newer"), sideCapacity, "newer");
  const windows = [...older, committed, ...newer];
  const windowIndex = older.length;
  return trimHistoryCache({ ...updated, windows, windowIndex });
}

export function storyHistoryVisibleTurns<TTurn extends StoryHistoryTurn>(
  state: StoryHistoryWindowState<TTurn>
): StoryHistoryVisibleWindow<TTurn> {
  const descriptor = state.windows[state.windowIndex];
  if (!descriptor) return { pageTurns: [], selectedPreview: state.selectedPreview, firstTurnNumber: null, lastTurnNumber: null };
  const cached = new Map(allCachedTurns(state).map((turn) => [turn.turnNumber, turn]));
  const selected = state.selectedPreview;
  const pageTurns = descriptor.turnNumbers.map((turnNumber) => cached.get(turnNumber)).filter((turn): turn is TTurn => Boolean(turn));
  const selectedIsVisible = Boolean(selected && pageTurns.some((turn) => turn.id === selected.id && turn.turnNumber === selected.turnNumber));
  const selectedPreview = selected && !selectedIsVisible ? selected : null;
  const capacity = selectedPreview ? STORY_HISTORY_PAGE_LIMIT - 1 : STORY_HISTORY_PAGE_LIMIT;
  const visibleTurns = pageTurns.length > capacity ? pageTurns.slice(pageTurns.length - capacity) : pageTurns;
  return {
    pageTurns: visibleTurns,
    selectedPreview,
    firstTurnNumber: visibleTurns[0]?.turnNumber ?? null,
    lastTurnNumber: visibleTurns.at(-1)?.turnNumber ?? null
  };
}

export function storyHistoryPageRequest<TTurn extends StoryHistoryTurn>(
  state: StoryHistoryWindowState<TTurn>, direction: "older" | "newer"
): StoryHistoryPageRequest | null {
  if (state.pending) return requestForPending(state, state.pending);
  const adjacentIndex = direction === "older" ? state.windowIndex - 1 : state.windowIndex + 1;
  const adjacent = state.windows[adjacentIndex];
  if (adjacent) return requestForWindow(state, direction, adjacent, adjacentIndex);
  if (direction !== "older") return null;
  const current = state.windows[state.windowIndex];
  if (!current) return null;
  const knownOlder = rowsOnSide(allKnownTurnNumbers(state), current, "older");
  const oldest = state.pageStack.filter((page) => page.source === "server")
    .sort((left, right) => left.firstTurnNumber - right.firstTurnNumber)[0];
  const capacity = state.selectedPreview ? STORY_HISTORY_PAGE_LIMIT - 1 : STORY_HISTORY_PAGE_LIMIT;
  if (knownOlder.length > 0 && (knownOlder.length >= capacity || !oldest?.nextCursor)) {
    const target = makeWindow(state, knownOlder.slice(-capacity));
    return requestForWindow(state, direction, target, -1);
  }
  if (!oldest?.nextCursor) return null;
  return newPageRequest("older", "server", oldest.nextCursor, current.firstTurnNumber, [], state.windowIndex - 1, true);
}

function sameIdentities(left: readonly StoryHistoryTurn[], right: readonly StoryHistoryTurn[]): boolean {
  return left.length === right.length && left.every((turn, index) => turn.id === right[index]?.id
    && turn.turnNumber === right[index]?.turnNumber);
}

function findWindowIndex(windows: readonly StoryHistoryDisplayWindow[], numbers: readonly number[]): number {
  return windows.findIndex((acceptedWindow) => acceptedWindow.turnNumbers.length === numbers.length
    && acceptedWindow.turnNumbers.every((turnNumber, index) => turnNumber === numbers[index]));
}

export function installStoryHistoryWindowPage<TTurn extends StoryHistoryTurn>(
  state: StoryHistoryWindowState<TTurn>, request: StoryHistoryPageRequest, page: StoryHistoryPage<TTurn> | null
): StoryHistoryWindowState<TTurn> {
  if (!request.requiresFetch) {
    if (page) throw new Error("A cached Story history navigation cannot install a fetched page.");
    const numbers = request.targetWindowTurnNumbers;
    const descriptor = makeWindow(state, numbers);
    const windows = [...state.windows];
    const windowIndex = request.targetWindowIndex;
    if (request.direction === "older" && windowIndex < 0) windows.unshift(descriptor);
    else if (windowIndex >= 0 && windowIndex < windows.length) windows[windowIndex] = descriptor;
    const resolvedIndex = request.direction === "older" && windowIndex < 0 ? 0 : windowIndex;
    return trimHistoryCache({
      ...state,
      windows,
      windowIndex: resolvedIndex,
      pending: null,
      position: { direction: request.direction, anchorTurnNumber: request.anchorTurnNumber }
    });
  }

  let pending = state.pending;
  if (!pending) {
    pending = {
      direction: request.direction,
      targetWindowIndex: request.targetWindowIndex,
      turnNumbers: request.targetWindowTurnNumbers,
      sourceKeys: [...(request.targetSourceKeys ?? (request.sourceBookmarkKey !== undefined ? [request.sourceBookmarkKey] : []))],
      attemptedSourceKeys: [],
      fallbackCursor: request.targetWindowTurnNumbers.length === 0 && request.direction === "older" && request.source === "server"
        ? request.requestCursor
        : null
    };
  }
  const preparedState = trimHistoryCache({ ...state, pending });
  if (!page) return preparedState;
  const pageSource = page.source ?? "server";
  if (page.requestCursor !== request.requestCursor || pageSource !== request.source) {
    throw new Error("Story history page source does not match the request.");
  }
  assertUniqueTurnIdentities(page.turns);
  const turns = orderedTurns(page.turns);
  if (turns.length === 0 || turns.length > STORY_HISTORY_PAGE_LIMIT) {
    throw new Error("Story history page must contain between 1 and " + STORY_HISTORY_PAGE_LIMIT + " turns.");
  }
  if (pageSource === "server" && pending.direction === "older" && page.nextCursor === page.requestCursor) {
    throw new Error("Older Story history cursor repeated instead of advancing.");
  }
  const pageBounds = bookmarkFor({ ...page, turns }, preparedState.nextSourceKey);
  if (pageSource === "resident" && (pageBounds.firstTurnNumber < (state.residentRange?.firstTurnNumber ?? 1)
    || pageBounds.lastTurnNumber > (state.residentRange?.lastTurnNumber ?? 0))) {
    throw new Error("Resident Story history page is outside the captured loaded range.");
  }
  const previous = allCachedTurns(preparedState);
  const rowsByNumber = new Map(previous.map((turn) => [turn.turnNumber, turn]));
  const idsByNumber = new Map<string, number>();
  for (const turn of previous) idsByNumber.set(turn.id, turn.turnNumber);
  for (const turn of turns) {
    const existing = rowsByNumber.get(turn.turnNumber);
    const existingNumber = idsByNumber.get(turn.id);
    const knownIdentity = preparedState.pageStack.flatMap((sourcePage) => sourcePage.identities)
      .find((identity) => identity.turnNumber === turn.turnNumber || identity.id === turn.id);
    if ((existing && existing.id !== turn.id) || (existingNumber !== undefined && existingNumber !== turn.turnNumber)
      || (knownIdentity && (knownIdentity.id !== turn.id || knownIdentity.turnNumber !== turn.turnNumber))) {
      throw new Error("Story history turn identity changed during paging.");
    }
  }
  const pageStack = [...preparedState.pageStack];
  let source = pageStack.find((candidate) => candidate.source === pageSource && candidate.requestCursor === page.requestCursor
    && (pageSource === "server" || candidate.sourceKey === request.sourceBookmarkKey));
  if (source && !sameIdentities(source.identities, pageBounds.identities)) {
    throw new Error("Replayed Story history page no longer matches its captured source bounds.");
  }
  if (!source) {
    if (pageSource === "server" && pending.direction === "older") {
      const oldest = pageStack.filter((candidate) => candidate.source === "server")
        .sort((left, right) => left.firstTurnNumber - right.firstTurnNumber)[0];
      if (oldest && (oldest.nextCursor !== page.requestCursor || pageBounds.lastTurnNumber >= oldest.firstTurnNumber)) {
        throw new Error("Older Story history page does not continue the captured cursor stack.");
      }
    }
    source = pageBounds;
    pageStack.push(source);
  } else if (source.nextCursor !== page.nextCursor) {
    throw new Error("Replayed Story history page changed its captured continuation cursor.");
  }

  const targetSet = new Set(pending.turnNumbers);
  const relevant = pending.turnNumbers.length === 0
    ? turns
    : turns.filter((turn) => targetSet.has(turn.turnNumber));
  const newRows = relevant.filter((turn) => !rowsByNumber.has(turn.turnNumber));
  if (newRows.length === 0) throw new Error("Captured Story history source made no progress toward the target window.");

  const cachedPages = [...preparedState.cachedPages, Object.assign({}, page, source, { source: pageSource, turns })];
  const attemptedSourceKeys = source.sourceKey === preparedState.nextSourceKey || !pending.attemptedSourceKeys.includes(source.sourceKey)
    ? [...pending.attemptedSourceKeys, source.sourceKey]
    : [...pending.attemptedSourceKeys];
  let nextPending: StoryHistoryPendingNavigation = {
    ...pending,
    sourceKeys: [...new Set([...pending.sourceKeys, source.sourceKey])],
    attemptedSourceKeys,
    fallbackCursor: pending.direction === "older" && pageSource === "server" ? page.nextCursor : pending.fallbackCursor
  };
  let candidateState: StoryHistoryWindowState<TTurn> = {
    ...preparedState,
    cachedPages,
    pageStack,
    pending: nextPending,
    nextSourceKey: source.sourceKey === preparedState.nextSourceKey ? preparedState.nextSourceKey + 1 : preparedState.nextSourceKey
  };

  if (nextPending.turnNumbers.length === 0) {
    const oldCurrent = state.windows[state.windowIndex];
    if (nextPending.direction !== "older" || !oldCurrent) {
      throw new Error("Captured Story history source made no progress toward an accepted-entry window.");
    }
    const eligible = allKnownTurnNumbers(candidateState)
      .filter((turnNumber) => turnNumber < oldCurrent.firstTurnNumber);
    const width = state.selectedPreview ? STORY_HISTORY_PAGE_LIMIT - 1 : STORY_HISTORY_PAGE_LIMIT;
    const targetNumbers = eligible.slice(-width);
    if (targetNumbers.length < width && page.nextCursor) {
      nextPending = { ...nextPending, turnNumbers: [], fallbackCursor: page.nextCursor };
      return trimHistoryCache({ ...candidateState, pending: nextPending });
    }
    if (targetNumbers.length > 0) {
      const descriptor = makeWindow(candidateState, targetNumbers);
      const windows = [...candidateState.windows];
      const targetIndex = state.windowIndex;
      windows.splice(targetIndex, 0, descriptor);
      nextPending = {
        ...nextPending,
        targetWindowIndex: targetIndex,
        turnNumbers: descriptor.turnNumbers,
        sourceKeys: descriptor.sourceKeys
      };
      candidateState = {
        ...candidateState,
        windows,
        windowIndex: state.windowIndex + 1,
        pending: nextPending
      };
    } else if (nextPending.fallbackCursor) {
      return trimHistoryCache(candidateState);
    } else {
      throw new Error("Captured Story history source made no progress toward an accepted-entry window.");
    }
  }

  const cachedNumbers = new Set(allCachedTurns(candidateState).map((turn) => turn.turnNumber));
  if (!nextPending.turnNumbers.every((turnNumber) => cachedNumbers.has(turnNumber))) {
    return trimHistoryCache(candidateState);
  }
  const descriptor = makeWindow(candidateState, nextPending.turnNumbers);
  let windows = [...candidateState.windows];
  const matchingIndex = findWindowIndex(windows, nextPending.turnNumbers);
  let windowIndex = matchingIndex >= 0 ? matchingIndex : nextPending.targetWindowIndex;
  if (matchingIndex < 0 && nextPending.direction === "older" && windowIndex < 0) {
    windows.unshift(descriptor);
    windowIndex = 0;
  } else if (matchingIndex < 0 && windowIndex >= 0 && windowIndex < windows.length) {
    windows[windowIndex] = descriptor;
  } else if (matchingIndex < 0) {
    return { ...candidateState, pending: null };
  }
  return trimHistoryCache({
    ...candidateState,
    windows,
    windowIndex,
    pending: null,
    position: { direction: nextPending.direction, anchorTurnNumber: request.anchorTurnNumber }
  });
}
