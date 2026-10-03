import type { TurnSummary } from "@infinite-quest/contracts";

export type ReaderHistoryScope = Readonly<{
  ownerUserId: string;
  campaignId: string;
}>;

export interface ReaderHistoryRepositoryPort {
  getEffectiveTurn(scope: ReaderHistoryScope, turnNumber: number): Promise<TurnSummary | null>;
}

export interface ReaderHistoryApplication {
  getEffectiveTurn(scope: ReaderHistoryScope, turnNumber: number): Promise<TurnSummary | null>;
}

export type ReaderHistoryApplicationDependencies = Readonly<{
  turns: ReaderHistoryRepositoryPort;
}>;
