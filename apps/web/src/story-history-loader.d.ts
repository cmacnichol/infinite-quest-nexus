export interface StoryHistoryTurn {
  id: string;
  turnNumber: number;
  readonly [key: string]: unknown;
}

export interface StoryHistoryPage<TTurn extends StoryHistoryTurn = StoryHistoryTurn> {
  campaignId: string;
  turns: readonly TTurn[];
  nextCursor: string | null;
}

export interface StoryHistoryProgress {
  loadedTurnCount: number;
  nextCursor: string | null;
}

export const COMPLETE_HISTORY_PAGE_LIMIT: 200;
export function mergeStoryTurnPages<TTurn extends StoryHistoryTurn>(
  existingTurns: readonly TTurn[],
  incomingTurns: readonly TTurn[]
): TTurn[];
export function loadCompleteStoryHistory<TTurn extends StoryHistoryTurn>(options: {
  campaignId: string;
  turns: readonly TTurn[];
  nextCursor: string | null;
  fetchPage: (request: { before: string; limit: number }) => Promise<StoryHistoryPage<TTurn>>;
  pageLimit?: number;
  onProgress?: (progress: StoryHistoryProgress) => void;
}): Promise<{ turns: TTurn[]; nextCursor: null }>;
