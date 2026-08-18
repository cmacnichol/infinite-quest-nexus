export const COMPLETE_HISTORY_PAGE_LIMIT = 200;

function turnIdentity(turn) {
  const id = String(turn?.id || "").trim();
  const turnNumber = Number(turn?.turnNumber);
  if (!id) throw new Error("Story history turn is missing an id.");
  if (!Number.isInteger(turnNumber) || turnNumber < 1) {
    throw new Error(`Story history turn ${id} has an invalid turn number.`);
  }
  return { id, turnNumber };
}

function validateHistoryPage(page) {
  if (!page || typeof page !== "object") {
    throw new Error("Story history page is invalid.");
  }
  if (!Array.isArray(page.turns)) {
    throw new Error("Story history page turns must be an array.");
  }
  if (page.nextCursor !== null && (typeof page.nextCursor !== "string" || page.nextCursor.trim().length === 0)) {
    throw new Error("Story history page cursor must be null or a non-empty string.");
  }
}

export function mergeStoryTurnPages(existingTurns, incomingTurns) {
  const byId = new Map();
  const byNumber = new Map();

  for (const turn of [...existingTurns, ...incomingTurns]) {
    const { id, turnNumber } = turnIdentity(turn);
    const existingById = byId.get(id);
    const existingByNumber = byNumber.get(turnNumber);
    if (existingById) {
      if (existingById.turnNumber !== turnNumber) {
        throw new Error(`Story history turn id ${id} maps to more than one turn number.`);
      }
      continue;
    }
    if (existingByNumber) {
      throw new Error(`Story history turn number ${turnNumber} maps to more than one turn id.`);
    }
    byId.set(id, turn);
    byNumber.set(turnNumber, turn);
  }

  return [...byNumber.values()].sort((left, right) => left.turnNumber - right.turnNumber);
}

export async function loadCompleteStoryHistory({
  campaignId,
  turns,
  nextCursor,
  fetchPage,
  pageLimit = COMPLETE_HISTORY_PAGE_LIMIT,
  onProgress = () => undefined
}) {
  if (pageLimit !== COMPLETE_HISTORY_PAGE_LIMIT) {
    throw new Error(`Story history page limit must be ${COMPLETE_HISTORY_PAGE_LIMIT}.`);
  }
  let loadedTurns = mergeStoryTurnPages([], turns);
  let cursor = nextCursor || null;
  const requestedCursors = new Set();

  while (cursor) {
    if (requestedCursors.has(cursor)) {
      throw new Error(`Story history cursor did not advance: ${cursor}`);
    }
    requestedCursors.add(cursor);
    const page = await fetchPage({ before: cursor, limit: pageLimit });
    validateHistoryPage(page);
    if (page.campaignId !== campaignId) {
      throw new Error(`Story history page belongs to ${page.campaignId}, expected ${campaignId}.`);
    }
    loadedTurns = mergeStoryTurnPages(loadedTurns, page.turns);
    cursor = page.nextCursor;
    onProgress({ loadedTurnCount: loadedTurns.length, nextCursor: cursor });
  }

  return { turns: loadedTurns, nextCursor: null };
}
