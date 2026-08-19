export type StoryTurn = {
  turnNumber: number;
};

export type StoryCampaignWindow = {
  activeTurnNumber?: number;
};

function positiveInteger(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

export function activeTurnNumber(campaign: StoryCampaignWindow | null | undefined): number {
  return positiveInteger(campaign?.activeTurnNumber) || 0;
}

export function appendExpectedTurnNumber(campaign: StoryCampaignWindow | null | undefined): number {
  return activeTurnNumber(campaign) + 1;
}

export function undoTargetTurnNumber(campaign: StoryCampaignWindow | null | undefined): number {
  return Math.max(0, activeTurnNumber(campaign) - 1);
}

export function latestTurnNumber(turns: readonly StoryTurn[]): number | null {
  return positiveInteger(turns.at(-1)?.turnNumber);
}

export function selectedTurnNumber(turns: readonly StoryTurn[], index: number | null | undefined): number | null {
  return typeof index === "number" && Number.isInteger(index)
    ? positiveInteger(turns[index]?.turnNumber)
    : null;
}

export function turnIndexForNumber(turns: readonly StoryTurn[], turnNumber: number | null): number {
  const target = positiveInteger(turnNumber);
  return target ? turns.findIndex((turn) => positiveInteger(turn?.turnNumber) === target) : -1;
}

export function recentTurnSpine<T extends { turnNumber: number }>(turns: readonly T[], count = 5): readonly T[] {
  const ordered = [...turns].sort((left, right) => left.turnNumber - right.turnNumber);
  return ordered.slice(Math.max(0, ordered.length - count));
}
