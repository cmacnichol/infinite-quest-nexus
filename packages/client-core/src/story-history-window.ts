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
};

type StoryHistoryDisplayWindow = {
  readonly firstTurnNumber: number;
  readonly lastTurnNumber: number;
  readonly sourceKeys: readonly number[];
};

type StoryHistoryPendingNavigation = {
  readonly direction: "older" | "newer";
  readonly targetWindowIndex: number;
  readonly firstTurnNumber: number;
  readonly lastTurnNumber: number;
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
  readonly targetWindowFirstTurnNumber: number;
  readonly targetWindowLastTurnNumber: number;
  readonly targetWindowIndex: number;
  readonly sourceBookmarkKey?: number;
  readonly targetSourceKeys?: readonly number[];
  readonly requiresFetch: boolean;
};

export type StoryHistoryWindowState<TTurn extends StoryHistoryTurn = StoryHistoryTurn> = {
  /** Retained row fragments contributing to the committed window and pending target. */
  readonly cachedPages: readonly StoryHistoryCachedPage<TTurn>[];
  /** Opaque cursors and numeric page bounds retained for replay after row eviction. */
  readonly pageStack: readonly StoryHistoryPageBookmark[];
  /** Metadata-only display history; raw source pages can contribute to several windows. */
  readonly windows: readonly StoryHistoryDisplayWindow[];
  readonly windowIndex: number;
  readonly pending: StoryHistoryPendingNavigation | null;
  readonly nextSourceKey: number;
  readonly selectedPreview: TTurn | null;
  readonly residentRange: { readonly firstTurnNumber: number; readonly lastTurnNumber: number } | null;
  readonly position: StoryHistoryWindowPosition;
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
    lastTurnNumber: turns.at(-1)?.turnNumber ?? 0
  };
}

function pageContains(bookmark: StoryHistoryPageBookmark, first: number, last: number): boolean {
  return bookmark.firstTurnNumber <= last && bookmark.lastTurnNumber >= first;
}

function allCachedTurns<TTurn extends StoryHistoryTurn>(state: StoryHistoryWindowState<TTurn>): TTurn[] {
  const byId = new Map<string, TTurn>();
  const byNumber = new Map<number, TTurn>();
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

function selectedIsInRange<TTurn extends StoryHistoryTurn>(
  state: StoryHistoryWindowState<TTurn>,
  turns: readonly TTurn[],
  first: number,
  last: number
): boolean {
  const selected = state.selectedPreview;
  return Boolean(selected
    && selected.turnNumber >= first
    && selected.turnNumber <= last
    && turns.some((turn) => turn.id === selected.id && turn.turnNumber === selected.turnNumber));
}

function sourceByKey<TTurn extends StoryHistoryTurn>(state: StoryHistoryWindowState<TTurn>, sourceKey: number): StoryHistoryPageBookmark | null {
  return state.pageStack.find((page) => page.sourceKey === sourceKey) ?? null;
}

function trimHistoryCache<TTurn extends StoryHistoryTurn>(state: StoryHistoryWindowState<TTurn>): StoryHistoryWindowState<TTurn> {
  const current = state.windows[state.windowIndex];
  const keepNumbers = new Set<number>();
  const ranges: { first: number; last: number }[] = [];
  if (current) ranges.push({ first: current.firstTurnNumber, last: current.lastTurnNumber });
  if (current && !state.pending && current.firstTurnNumber > 1) {
    const targetFirst = Math.max(1, current.firstTurnNumber - STORY_HISTORY_PAGE_LIMIT);
    const targetLast = current.firstTurnNumber - 1;
    const carrySource = current.sourceKeys.map((key) => sourceByKey(state, key))
      .filter((source): source is StoryHistoryPageBookmark => Boolean(source && pageContains(source, targetFirst, targetLast)))
      .sort((left, right) => {
        const overlapLeft = Math.max(0, Math.min(targetLast, left.lastTurnNumber) - Math.max(targetFirst, left.firstTurnNumber) + 1);
        const overlapRight = Math.max(0, Math.min(targetLast, right.lastTurnNumber) - Math.max(targetFirst, right.firstTurnNumber) + 1);
        return overlapRight - overlapLeft;
      })[0];
    if (carrySource) ranges.push({ first: carrySource.firstTurnNumber, last: carrySource.lastTurnNumber });
  }
  if (state.pending) ranges.push({ first: state.pending.firstTurnNumber, last: state.pending.lastTurnNumber });
  for (const range of ranges) {
    for (let turnNumber = range.first; turnNumber <= range.last; turnNumber += 1) keepNumbers.add(turnNumber);
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

function completeWindow<TTurn extends StoryHistoryTurn>(
  state: StoryHistoryWindowState<TTurn>,
  first: number,
  last: number
): TTurn[] | null {
  const turns = allCachedTurns(state).filter((turn) => turn.turnNumber >= first && turn.turnNumber <= last);
  if (turns.length !== last - first + 1) return null;
  for (let offset = 0; offset < turns.length; offset += 1) {
    if (turns[offset]?.turnNumber !== first + offset) return null;
  }
  return turns;
}

function sourcesForWindow<TTurn extends StoryHistoryTurn>(
  state: StoryHistoryWindowState<TTurn>,
  first: number,
  last: number
): number[] {
  return state.pageStack.filter((page) => pageContains(page, first, last)).map((page) => page.sourceKey);
}

export function createStoryHistoryWindow<TTurn extends StoryHistoryTurn>(options: {
  readonly page: StoryHistoryPage<TTurn>;
  readonly selectedPreview?: TTurn | null;
  readonly residentRange?: { readonly firstTurnNumber: number; readonly lastTurnNumber: number } | null;
}): StoryHistoryWindowState<TTurn> {
  const turns = orderedTurns(options.page.turns);
  if (turns.length > STORY_HISTORY_PAGE_LIMIT) {
    throw new Error("Story history page exceeds " + STORY_HISTORY_PAGE_LIMIT + " turns.");
  }
  const page = { ...options.page, turns };
  const selectedPreview = options.selectedPreview ?? null;
  const selectedInPage = Boolean(selectedPreview && turns.some((turn) => turn.id === selectedPreview.id
    && turn.turnNumber === selectedPreview.turnNumber));
  const visibleCapacity = selectedPreview && !selectedInPage ? STORY_HISTORY_PAGE_LIMIT - 1 : STORY_HISTORY_PAGE_LIMIT;
  const initialLast = turns.at(-1)?.turnNumber ?? 0;
  const initialFirst = Math.max(turns[0]?.turnNumber ?? 0, initialLast - visibleCapacity + 1);
  const bookmark = bookmarkFor(page, 1);
  const initialWindow = {
    firstTurnNumber: initialFirst,
    lastTurnNumber: initialLast,
    sourceKeys: [bookmark.sourceKey]
  };
  return {
    cachedPages: [Object.assign({}, page, bookmark)],
    pageStack: [bookmark],
    windows: [initialWindow],
    windowIndex: 0,
    pending: null,
    nextSourceKey: 2,
    selectedPreview,
    residentRange: options.residentRange ?? null,
    position: { direction: "initial", anchorTurnNumber: turns.at(-1)?.turnNumber ?? null }
  };
}

export function selectStoryHistoryPreview<TTurn extends StoryHistoryTurn>(
  state: StoryHistoryWindowState<TTurn>,
  selectedPreview: TTurn | null
): StoryHistoryWindowState<TTurn> {
  const current = state.windows[state.windowIndex];
  const firstWindow = state.windows[0];
  const lastWindow = state.windows.at(-1);
  if (!current || !firstWindow || !lastWindow) {
    return trimHistoryCache({ ...state, selectedPreview, pending: null });
  }

  const currentRows = allCachedTurns(state).filter((turn) => turn.turnNumber >= current.firstTurnNumber
    && turn.turnNumber <= current.lastTurnNumber);
  if (currentRows.length === 0) return trimHistoryCache({ ...state, selectedPreview, pending: null });

  const selectedInCurrent = Boolean(selectedPreview && currentRows.some((turn) => turn.id === selectedPreview.id
    && turn.turnNumber === selectedPreview.turnNumber));
  const currentCapacity = selectedPreview && !selectedInCurrent
    ? STORY_HISTORY_PAGE_LIMIT - 1
    : STORY_HISTORY_PAGE_LIMIT;
  let visibleRows = currentRows;
  if (currentRows.length > currentCapacity) {
    visibleRows = state.windowIndex > 0
      ? currentRows.slice(currentRows.length - currentCapacity)
      : currentRows.slice(0, currentCapacity);
  }
  let currentFirst = visibleRows[0]!.turnNumber;
  let currentLast = visibleRows.at(-1)!.turnNumber;
  const selectedNumber = selectedPreview?.turnNumber;

  const rangeFirst = Math.min(firstWindow.firstTurnNumber, currentFirst);
  const rangeLast = Math.max(lastWindow.lastTurnNumber, currentLast);
  const makeWindow = (windowFirst: number, windowLast: number): StoryHistoryDisplayWindow => ({
    firstTurnNumber: windowFirst,
    lastTurnNumber: windowLast,
    sourceKeys: state.pageStack.filter((page) => pageContains(page, windowFirst, windowLast)).map((page) => page.sourceKey)
  });
  const preceding: StoryHistoryDisplayWindow[] = [];
  for (let windowLast = currentFirst - 1; windowLast >= rangeFirst;) {
    const selectedFits = Boolean(selectedPreview
      && selectedNumber! <= windowLast
      && selectedNumber! >= windowLast - STORY_HISTORY_PAGE_LIMIT + 1);
    const capacity = selectedPreview
      ? (selectedFits ? STORY_HISTORY_PAGE_LIMIT : STORY_HISTORY_PAGE_LIMIT - 1)
      : STORY_HISTORY_PAGE_LIMIT;
    const windowFirst = Math.max(rangeFirst, windowLast - capacity + 1);
    preceding.unshift(makeWindow(windowFirst, windowLast));
    windowLast = windowFirst - 1;
  }

  const following: StoryHistoryDisplayWindow[] = [];
  for (let windowFirst = currentLast + 1; windowFirst <= rangeLast;) {
    const selectedFits = Boolean(selectedPreview
      && selectedNumber! >= windowFirst
      && selectedNumber! <= windowFirst + STORY_HISTORY_PAGE_LIMIT - 1);
    const capacity = selectedPreview
      ? (selectedFits ? STORY_HISTORY_PAGE_LIMIT : STORY_HISTORY_PAGE_LIMIT - 1)
      : STORY_HISTORY_PAGE_LIMIT;
    const windowLast = Math.min(rangeLast, windowFirst + capacity - 1);
    following.push(makeWindow(windowFirst, windowLast));
    windowFirst = windowLast + 1;
  }

  const windows = [...preceding, makeWindow(currentFirst, currentLast), ...following];
  return trimHistoryCache({
    ...state,
    selectedPreview,
    pending: null,
    windows,
    windowIndex: preceding.length
  });
}

export function storyHistoryVisibleTurns<TTurn extends StoryHistoryTurn>(
  state: StoryHistoryWindowState<TTurn>
): StoryHistoryVisibleWindow<TTurn> {
  const descriptor = state.windows[state.windowIndex];
  if (!descriptor) return { pageTurns: [], selectedPreview: state.selectedPreview, firstTurnNumber: null, lastTurnNumber: null };
  const cachedTurns = allCachedTurns(state);
  const selected = state.selectedPreview;
  const cachedPageRows = cachedTurns.filter((turn) => turn.turnNumber >= descriptor.firstTurnNumber
    && turn.turnNumber <= descriptor.lastTurnNumber);
  const selectedInCandidate = selectedIsInRange(state, cachedPageRows, descriptor.firstTurnNumber, descriptor.lastTurnNumber);
  const pinnedOffPage = Boolean(selected) && !selectedInCandidate;
  const capacity = pinnedOffPage ? STORY_HISTORY_PAGE_LIMIT - 1 : STORY_HISTORY_PAGE_LIMIT;
  let pageTurns = cachedPageRows;
  if (pageTurns.length > capacity) {
    pageTurns = state.windowIndex > 0 ? pageTurns.slice(pageTurns.length - capacity) : pageTurns.slice(0, capacity);
  }
  const firstTurnNumber = pageTurns[0]?.turnNumber ?? null;
  const lastTurnNumber = pageTurns.at(-1)?.turnNumber ?? null;
  const selectedPreview = state.selectedPreview
    && !pageTurns.some((turn) => turn.id === state.selectedPreview?.id && turn.turnNumber === state.selectedPreview?.turnNumber)
      ? state.selectedPreview
    : null;
  return { pageTurns, selectedPreview, firstTurnNumber, lastTurnNumber };
}

function missingNumbers<TTurn extends StoryHistoryTurn>(state: StoryHistoryWindowState<TTurn>, first: number, last: number): number[] {
  const retained = new Set(allCachedTurns(state).map((turn) => turn.turnNumber));
  const missing: number[] = [];
  for (let turnNumber = first; turnNumber <= last; turnNumber += 1) {
    if (!retained.has(turnNumber)) missing.push(turnNumber);
  }
  return missing;
}

function requestForPending<TTurn extends StoryHistoryTurn>(
  state: StoryHistoryWindowState<TTurn>,
  pending: StoryHistoryPendingNavigation
): StoryHistoryPageRequest | null {
  const missing = missingNumbers(state, pending.firstTurnNumber, pending.lastTurnNumber);
  const firstMissing = missing[0];
  if (firstMissing === undefined) return null;
  const residentFirst = state.residentRange?.firstTurnNumber ?? Number.POSITIVE_INFINITY;
  const residentLast = state.residentRange?.lastTurnNumber ?? Number.NEGATIVE_INFINITY;
  if (firstMissing >= residentFirst && firstMissing <= residentLast) {
    let targetEnd = firstMissing;
    while (targetEnd + 1 <= residentLast && targetEnd + 1 <= pending.lastTurnNumber && missing.includes(targetEnd + 1)) targetEnd += 1;
    return {
      direction: pending.direction,
      source: "resident",
      requestCursor: null,
      anchorTurnNumber: pending.lastTurnNumber,
      targetStartTurnNumber: firstMissing,
      targetEndTurnNumber: targetEnd,
      targetWindowFirstTurnNumber: pending.firstTurnNumber,
      targetWindowLastTurnNumber: pending.lastTurnNumber,
      targetWindowIndex: pending.targetWindowIndex,
      requiresFetch: true
    };
  }
  const tried = new Set(pending.attemptedSourceKeys);
  const candidate = pending.sourceKeys.map((key) => sourceByKey(state, key))
    .filter((source): source is StoryHistoryPageBookmark => Boolean(source && !tried.has(source.sourceKey)
      && source.firstTurnNumber <= firstMissing && source.lastTurnNumber >= firstMissing))
    .concat(state.pageStack.filter((source) => !tried.has(source.sourceKey)
      && source.firstTurnNumber <= firstMissing && source.lastTurnNumber >= firstMissing))
    .sort((left, right) => left.firstTurnNumber - right.firstTurnNumber)[0];
  if (candidate) {
    let targetEnd = Math.min(pending.lastTurnNumber, candidate.lastTurnNumber);
    while (targetEnd > firstMissing && !missing.includes(targetEnd)) targetEnd -= 1;
    return {
      direction: pending.direction,
      source: candidate.source,
      requestCursor: candidate.requestCursor,
      anchorTurnNumber: pending.firstTurnNumber,
      targetStartTurnNumber: firstMissing,
      targetEndTurnNumber: targetEnd,
      targetWindowFirstTurnNumber: pending.firstTurnNumber,
      targetWindowLastTurnNumber: pending.lastTurnNumber,
      targetWindowIndex: pending.targetWindowIndex,
      sourceBookmarkKey: candidate.sourceKey,
      requiresFetch: true
    };
  }
  if (pending.fallbackCursor) {
    return {
      direction: pending.direction,
      source: "server",
      requestCursor: pending.fallbackCursor,
      anchorTurnNumber: pending.firstTurnNumber,
      targetStartTurnNumber: firstMissing,
      targetEndTurnNumber: pending.lastTurnNumber,
      targetWindowFirstTurnNumber: pending.firstTurnNumber,
      targetWindowLastTurnNumber: pending.lastTurnNumber,
      targetWindowIndex: pending.targetWindowIndex,
      requiresFetch: true
    };
  }
  return null;
}

function requestForWindow<TTurn extends StoryHistoryTurn>(
  state: StoryHistoryWindowState<TTurn>,
  direction: "older" | "newer",
  target: StoryHistoryDisplayWindow,
  targetIndex: number
): StoryHistoryPageRequest {
  const resident = state.residentRange;
  const residentCovers = Boolean(resident && resident.firstTurnNumber <= target.firstTurnNumber
    && resident.lastTurnNumber >= target.lastTurnNumber);
  const source = residentCovers ? "resident" : (sourceByKey(state, target.sourceKeys[0] ?? -1)?.source ?? "server");
  const sourceBookmark = target.sourceKeys.map((key) => sourceByKey(state, key))
    .find((candidate): candidate is StoryHistoryPageBookmark => Boolean(candidate));
  const missing = missingNumbers(state, target.firstTurnNumber, target.lastTurnNumber);
  const requestStart = missing[0] ?? target.firstTurnNumber;
  const requestEnd = missing.at(-1) ?? target.lastTurnNumber;
  return {
    direction,
    source: residentCovers ? "resident" : source,
    requestCursor: residentCovers ? null : (sourceBookmark?.requestCursor ?? null),
    anchorTurnNumber: target.firstTurnNumber,
    targetStartTurnNumber: requestStart,
    targetEndTurnNumber: requestEnd,
    targetWindowFirstTurnNumber: target.firstTurnNumber,
    targetWindowLastTurnNumber: target.lastTurnNumber,
    targetWindowIndex: targetIndex,
    ...(sourceBookmark ? { sourceBookmarkKey: sourceBookmark.sourceKey } : {}),
    targetSourceKeys: target.sourceKeys,
    requiresFetch: missing.length > 0
  };
}

export function storyHistoryPageRequest<TTurn extends StoryHistoryTurn>(
  state: StoryHistoryWindowState<TTurn>,
  direction: "older" | "newer"
): StoryHistoryPageRequest | null {
  if (state.pending) return requestForPending(state, state.pending);
  const adjacentIndex = direction === "older" ? state.windowIndex - 1 : state.windowIndex + 1;
  const adjacent = state.windows[adjacentIndex];
  if (adjacent) return requestForWindow(state, direction, adjacent, adjacentIndex);
  if (direction !== "older") return null;

  const visible = storyHistoryVisibleTurns(state);
  if (visible.pageTurns.length === 0 || visible.firstTurnNumber === null) return null;
  const last = visible.firstTurnNumber - 1;
  if (last < 1) return null;
  const rawFirst = Math.max(1, last - (STORY_HISTORY_PAGE_LIMIT - 1));
  const resident = state.residentRange;
  const residentFirst = Math.max(rawFirst, resident?.firstTurnNumber ?? Number.POSITIVE_INFINITY);
  const residentLast = Math.min(last, resident?.lastTurnNumber ?? Number.NEGATIVE_INFINITY);
  const residentCoversTarget = residentFirst <= rawFirst && residentLast >= last;
  const residentTouchesAnchor = residentFirst <= residentLast && residentLast === last;
  const selectedInside = selectedIsInRange(state, allCachedTurns(state), rawFirst, last);
  const capacity = state.selectedPreview && !selectedInside ? STORY_HISTORY_PAGE_LIMIT - 1 : STORY_HISTORY_PAGE_LIMIT;
  const windowFirst = residentTouchesAnchor && !residentCoversTarget
    ? residentFirst
    : Math.max(rawFirst, last - capacity + 1);
  const windowLast = residentTouchesAnchor && !residentCoversTarget ? residentLast : last;
  const targetIndex = state.windowIndex - 1;
  if (completeWindow(state, windowFirst, windowLast)) {
    return {
      direction,
      source: "resident",
      requestCursor: null,
      anchorTurnNumber: last,
      targetStartTurnNumber: windowFirst,
      targetEndTurnNumber: windowLast,
      targetWindowFirstTurnNumber: windowFirst,
      targetWindowLastTurnNumber: windowLast,
      targetWindowIndex: targetIndex,
      targetSourceKeys: sourcesForWindow(state, windowFirst, windowLast),
      requiresFetch: false
    };
  }
  if (residentFirst <= residentLast) {
    const sourceRequest: StoryHistoryPageRequest = {
      direction,
      source: "resident",
      requestCursor: null,
      anchorTurnNumber: last,
      targetStartTurnNumber: residentCoversTarget ? rawFirst : residentFirst,
      targetEndTurnNumber: residentCoversTarget ? last : residentLast,
      targetWindowFirstTurnNumber: windowFirst,
      targetWindowLastTurnNumber: windowLast,
      targetWindowIndex: targetIndex,
      requiresFetch: true
    };
    return sourceRequest;
  }
  const oldest = state.pageStack.filter((page) => page.source === "server")
    .sort((left, right) => left.firstTurnNumber - right.firstTurnNumber)[0];
  if (!oldest?.nextCursor) return null;
  return {
    direction,
    source: "server",
    requestCursor: oldest.nextCursor,
    anchorTurnNumber: last,
    targetStartTurnNumber: rawFirst,
    targetEndTurnNumber: last,
    targetWindowFirstTurnNumber: windowFirst,
    targetWindowLastTurnNumber: windowLast,
    targetWindowIndex: targetIndex,
    requiresFetch: true
  };
}

export function installStoryHistoryWindowPage<TTurn extends StoryHistoryTurn>(
  state: StoryHistoryWindowState<TTurn>,
  request: StoryHistoryPageRequest,
  page: StoryHistoryPage<TTurn> | null
): StoryHistoryWindowState<TTurn> {
  if (!request.requiresFetch) {
    if (page) throw new Error("A cached Story history navigation cannot install a fetched page.");
    const descriptor: StoryHistoryDisplayWindow = {
      firstTurnNumber: request.targetWindowFirstTurnNumber,
      lastTurnNumber: request.targetWindowLastTurnNumber,
      sourceKeys: request.targetSourceKeys ?? sourcesForWindow(state, request.targetWindowFirstTurnNumber, request.targetWindowLastTurnNumber)
    };
    let windows = [...state.windows];
    let windowIndex = request.targetWindowIndex;
    if (request.direction === "older" && windowIndex < 0) {
      windows = [descriptor, ...windows];
      windowIndex = 0;
    } else if (windowIndex >= 0 && windowIndex < windows.length) {
      windows[windowIndex] = descriptor;
    }
    return trimHistoryCache({
      ...state,
      windows,
      windowIndex,
      pending: null,
      position: { direction: request.direction, anchorTurnNumber: request.anchorTurnNumber }
    });
  }

  let pending = state.pending;
  if (!pending) {
    const fallbackCursor = request.direction === "older" && request.targetWindowIndex < 0 && request.source === "server"
      ? request.requestCursor
      : null;
    pending = {
      direction: request.direction,
      targetWindowIndex: request.targetWindowIndex,
      firstTurnNumber: request.targetWindowFirstTurnNumber,
      lastTurnNumber: request.targetWindowLastTurnNumber,
      sourceKeys: [...(request.targetSourceKeys ?? (request.sourceBookmarkKey ? [request.sourceBookmarkKey] : []))],
      attemptedSourceKeys: [],
      fallbackCursor
    };
  }
  const preparedState = trimHistoryCache({ ...state, pending });
  let candidateState: StoryHistoryWindowState<TTurn> = preparedState;
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
  if (pageSource === "server" && pending?.direction === "older" && page.nextCursor === page.requestCursor) {
    throw new Error("Older Story history cursor repeated instead of advancing.");
  }
  const pageBounds = bookmarkFor({ ...page, turns }, preparedState.nextSourceKey);
  if (pageSource === "resident" && (pageBounds.firstTurnNumber < (state.residentRange?.firstTurnNumber ?? 1)
    || pageBounds.lastTurnNumber > (state.residentRange?.lastTurnNumber ?? 0))) {
    throw new Error("Resident Story history page is outside the captured loaded range.");
  }
  let pageStack = [...preparedState.pageStack];
  let source = pageStack.find((candidate) => candidate.source === pageSource
    && candidate.requestCursor === page.requestCursor
    && (pageSource === "server" || (candidate.firstTurnNumber === pageBounds.firstTurnNumber
      && candidate.lastTurnNumber === pageBounds.lastTurnNumber)));
  if (source && (source.firstTurnNumber !== pageBounds.firstTurnNumber || source.lastTurnNumber !== pageBounds.lastTurnNumber)) {
    throw new Error("Replayed Story history page no longer matches its captured source bounds.");
  }
  if (!source) {
    if (pageSource === "server" && pending.direction === "older") {
      const oldest = pageStack.filter((candidate) => candidate.source === "server")
        .sort((left, right) => left.firstTurnNumber - right.firstTurnNumber)[0];
      if (!oldest || oldest.nextCursor !== page.requestCursor || pageBounds.lastTurnNumber >= oldest.firstTurnNumber) {
        throw new Error("Older Story history page does not continue the captured cursor stack.");
      }
    }
    source = { ...pageBounds, sourceKey: state.nextSourceKey };
    pageStack.push(source);
  }
  const before = allCachedTurns(preparedState);
  const rowsByNumber = new Map(before.map((turn) => [turn.turnNumber, turn]));
  for (const turn of turns) {
    const existing = rowsByNumber.get(turn.turnNumber);
    if (existing && existing.id !== turn.id) throw new Error("Story history turn identity changed during paging.");
    const sameId = before.find((candidate) => candidate.id === turn.id);
    if (sameId && sameId.turnNumber !== turn.turnNumber) throw new Error("Story history turn identity changed during paging.");
  }
  const relevant = turns.filter((turn) => turn.turnNumber >= pending!.firstTurnNumber && turn.turnNumber <= pending!.lastTurnNumber);
  const newRows = relevant.filter((turn) => !rowsByNumber.has(turn.turnNumber));
  if (newRows.length === 0) throw new Error("Captured Story history source made no progress toward the target window.");
  const cachedPages = [...preparedState.cachedPages];
  cachedPages.push(Object.assign({}, page, source, { source: pageSource, turns: newRows }));
  const attemptedSourceKeys = source.sourceKey === preparedState.nextSourceKey
    ? [...pending.attemptedSourceKeys, source.sourceKey]
    : pending.attemptedSourceKeys.includes(source.sourceKey)
      ? [...pending.attemptedSourceKeys]
      : [...pending.attemptedSourceKeys, source.sourceKey];
  pending = {
    ...pending,
    sourceKeys: [...new Set([...pending.sourceKeys, source.sourceKey])],
    attemptedSourceKeys,
    fallbackCursor: pending.direction === "older" && pageSource === "server" ? page.nextCursor : pending.fallbackCursor
  };
  candidateState = { ...preparedState, cachedPages, pageStack, pending, nextSourceKey: source.sourceKey === preparedState.nextSourceKey ? preparedState.nextSourceKey + 1 : preparedState.nextSourceKey };
  const nextPosition: StoryHistoryWindowPosition = {
    direction: pending.direction,
    anchorTurnNumber: request.anchorTurnNumber
  };
  candidateState = { ...candidateState, position: nextPosition };
  candidateState = trimHistoryCache(candidateState);
  if (!completeWindow(candidateState, pending.firstTurnNumber, pending.lastTurnNumber)) return candidateState;

  const sourceKeys = sourcesForWindow(candidateState, pending.firstTurnNumber, pending.lastTurnNumber);
  const descriptor: StoryHistoryDisplayWindow = {
    firstTurnNumber: pending.firstTurnNumber,
    lastTurnNumber: pending.lastTurnNumber,
    sourceKeys: [...new Set([...sourceKeys, ...pending.sourceKeys])]
  };
  let windows = [...candidateState.windows];
  let windowIndex = pending.targetWindowIndex;
  if (pending.direction === "older" && windowIndex < 0) {
    windows = [descriptor, ...windows];
    windowIndex = 0;
  } else if (windowIndex >= 0 && windowIndex < windows.length) {
    windows[windowIndex] = descriptor;
  } else {
    return { ...candidateState, pending: null };
  }
  const completed = {
    ...candidateState,
    windows,
    windowIndex,
    pending: null,
    position: nextPosition
  };
  const olderCarryFirst = Math.max(1, descriptor.firstTurnNumber - STORY_HISTORY_PAGE_LIMIT);
  const olderCarryLast = descriptor.firstTurnNumber - 1;
  if (olderCarryFirst <= olderCarryLast) {
    const retainedNumbers = new Set(allCachedTurns(completed).map((turn) => turn.turnNumber));
    const carryRows = turns.filter((turn) => turn.turnNumber >= olderCarryFirst && turn.turnNumber <= olderCarryLast
      && !retainedNumbers.has(turn.turnNumber));
    if (carryRows.length > 0) {
      const carryPage = Object.assign({}, page, source, { source: pageSource, turns: carryRows });
      return trimHistoryCache({ ...completed, cachedPages: [...completed.cachedPages, carryPage] });
    }
  }
  return trimHistoryCache(completed);
}
