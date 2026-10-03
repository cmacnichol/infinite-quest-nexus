import type { ReaderHistoryItem, TurnSummary } from "@infinite-quest/contracts";

export type ReaderHistoryScope = Readonly<{
  ownerUserId: string;
  campaignId: string;
}>;

export type ReaderHistorySearchOptions = Readonly<{
  q: string;
  before?: string | undefined;
  limit: number;
}>;

export type ReaderHistoryPage = Readonly<{
  items: ReaderHistoryItem[];
  nextCursor: string | null;
}>;

export interface ReaderHistoryRepositoryPort {
  getEffectiveTurn(scope: ReaderHistoryScope, turnNumber: number): Promise<TurnSummary | null>;
  searchHistory(scope: ReaderHistoryScope, options: ReaderHistorySearchOptions): Promise<ReaderHistoryPage>;
}

export interface ReaderHistoryApplication {
  getEffectiveTurn(scope: ReaderHistoryScope, turnNumber: number): Promise<TurnSummary | null>;
  searchHistory(scope: ReaderHistoryScope, options: ReaderHistorySearchOptions): Promise<ReaderHistoryPage>;
}

export type ReaderHistoryApplicationDependencies = Readonly<{
  turns: ReaderHistoryRepositoryPort;
}>;
