export interface StoryTurn {
  turnNumber: number;
}

export interface StoryCampaignWindow {
  activeTurnNumber: number;
}

export function activeTurnNumber(campaign: Partial<StoryCampaignWindow> | null | undefined): number;
export function appendExpectedTurnNumber(campaign: Partial<StoryCampaignWindow> | null | undefined): number;
export function undoTargetTurnNumber(campaign: Partial<StoryCampaignWindow> | null | undefined): number;
export function latestTurnNumber(turns: readonly StoryTurn[]): number | null;
export function selectedTurnNumber(turns: readonly StoryTurn[], index: number | null | undefined): number | null;
export function turnIndexForNumber(turns: readonly StoryTurn[], turnNumber: number | null): number;
