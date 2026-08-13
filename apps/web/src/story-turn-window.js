function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

export function activeTurnNumber(campaign) {
  return positiveInteger(campaign?.activeTurnNumber) || 0;
}

export function appendExpectedTurnNumber(campaign) {
  return activeTurnNumber(campaign) + 1;
}

export function undoTargetTurnNumber(campaign) {
  return Math.max(0, activeTurnNumber(campaign) - 1);
}

export function latestTurnNumber(turns) {
  return positiveInteger(turns.at(-1)?.turnNumber);
}

export function selectedTurnNumber(turns, index) {
  return Number.isInteger(index) ? positiveInteger(turns[index]?.turnNumber) : null;
}
