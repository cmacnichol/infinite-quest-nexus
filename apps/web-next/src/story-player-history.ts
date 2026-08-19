import { recentTurnSpine, type CampaignStoreController, type CampaignProjection } from "@infinite-quest/client-core";
import type { CampaignApi } from "@infinite-quest/client-web";
import type { CampaignRuntimeStateResponse, TurnListResponse } from "@infinite-quest/contracts";
import type { StoryUiModel } from "./story-player-model";

const HISTORY_PAGE_LIMIT = 200;

export interface StoryHistoryController {
  sync(projection: Readonly<CampaignProjection>): void;
  previous(): Promise<void>;
  next(): Promise<void>;
  jump(turnNumber: number): void;
  loadTurn(turnNumber: number): Promise<boolean>;
  openCompleteHistory(): Promise<StoryHistoryResult>;
  retryCompleteHistory(): Promise<StoryHistoryResult>;
  inspect(turnNumber: number): Promise<CampaignRuntimeStateResponse | null>;
  dispose(): void;
}

export type StoryHistoryResult = Readonly<{
  campaignId: string;
  turns: readonly CampaignProjection["turns"][number][];
  nextCursor: string | null;
}>;

export interface StoryHistoryControllerOptions {
  readonly campaigns: Pick<CampaignApi, "turns" | "state">;
  readonly campaignStore: Pick<CampaignStoreController, "store" | "prependOlderTurns">;
  readonly model: Pick<StoryUiModel, "get" | "setViewTurnNumber" | "setHistory" | "setMessage">;
}

type RequestGuard = Readonly<{
  id: number;
  campaignId: string;
  epoch: number;
  cursor: string | null;
  authority: HistoryEpoch;
}>;

type HistoryEpoch = Readonly<{
  campaignId: string | null;
  syncToken: string | null;
  activeTurnNumber: number;
  latestTurnId: string | null;
  oldestTurnId: string | null;
  nextTurnsCursor: string | null;
}>;

function positiveTurnNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function sortedTurns<T extends { turnNumber: number }>(turns: readonly T[]): readonly T[] {
  return [...turns].sort((left, right) => left.turnNumber - right.turnNumber);
}

export const latestCampaignSpine = recentTurnSpine;

function currentEpoch(projection: Readonly<CampaignProjection>): HistoryEpoch {
  const turns = sortedTurns(projection.turns);
  return {
    campaignId: projection.campaign?.id ?? null,
    syncToken: projection.syncToken,
    activeTurnNumber: projection.campaign?.activeTurnNumber ?? 0,
    latestTurnId: turns.at(-1)?.id ?? null,
    oldestTurnId: turns[0]?.id ?? null,
    nextTurnsCursor: projection.nextTurnsCursor
  };
}

function sameEpoch(left: HistoryEpoch, right: HistoryEpoch): boolean {
  return left.campaignId === right.campaignId
    && left.syncToken === right.syncToken
    && left.activeTurnNumber === right.activeTurnNumber
    && left.latestTurnId === right.latestTurnId
    && left.oldestTurnId === right.oldestTurnId
    && left.nextTurnsCursor === right.nextTurnsCursor;
}

function mergeTurns<T extends { id: string; turnNumber: number }>(existing: readonly T[], incoming: readonly T[]): readonly T[] {
  const byNumber = new Map<number, T>();
  const byId = new Map<string, T>();
  for (const candidate of [...existing, ...incoming]) {
    const existingByNumber = byNumber.get(candidate.turnNumber);
    const existingById = byId.get(candidate.id);
    if (existingByNumber && existingByNumber.id !== candidate.id) {
      throw new Error(`Story history turn number ${candidate.turnNumber} has conflicting identities.`);
    }
    if (existingById && existingById.turnNumber !== candidate.turnNumber) {
      throw new Error(`Story history turn ${candidate.id} has conflicting numbers.`);
    }
    if (!existingByNumber && !existingById) {
      byNumber.set(candidate.turnNumber, candidate);
      byId.set(candidate.id, candidate);
    }
  }
  return sortedTurns([...byNumber.values()]);
}

/** Align the compact horizontal rail after it has been rendered. */
export function alignLatestSpine(
  spine: HTMLElement,
  schedule: (callback: () => void) => void = (callback) => {
    if (typeof globalThis.requestAnimationFrame === "function") globalThis.requestAnimationFrame(callback);
    else callback();
  }
): void {
  schedule(() => {
    if (typeof spine.scrollTo !== "function") return;
    spine.scrollTo({ left: spine.scrollWidth });
  });
}

export function createStoryHistoryController(options: StoryHistoryControllerOptions): StoryHistoryController {
  let projection = options.campaignStore.store.get();
  let epochState = currentEpoch(projection);
  let epoch = 0;
  let operationId = 0;
  let completeHistory: Readonly<{ guard: RequestGuard; promise: Promise<StoryHistoryResult> }> | null = null;
  let disposed = false;

  const startRequest = (cursor: string | null): RequestGuard | null => {
    const current = options.campaignStore.store.get();
    const campaignId = current.campaign?.id;
    if (disposed || campaignId === undefined) return null;
    const authority = currentEpoch(current);
    return { id: ++operationId, campaignId, epoch, cursor, authority };
  };

  const isCurrent = (guard: RequestGuard): boolean => {
    if (disposed || guard.epoch !== epoch) return false;
    const current = options.campaignStore.store.get();
    return current.campaign?.id === guard.campaignId && sameEpoch(currentEpoch(current), guard.authority);
  };

  const olderPage = async (guard: RequestGuard): Promise<TurnListResponse | null> => {
    if (guard.cursor === null) return null;
    const page = await options.campaigns.turns(guard.campaignId, { before: guard.cursor, limit: HISTORY_PAGE_LIMIT }, undefined);
    if (!isCurrent(guard) || page.campaignId !== guard.campaignId) return null;
    return page;
  };

  const selectPrevious = (): void => {
    const turns = sortedTurns(options.campaignStore.store.get().turns);
    const selected = options.model.get().viewTurnNumber ?? projection.campaign?.activeTurnNumber ?? null;
    const index = turns.findIndex((turn) => turn.turnNumber === selected);
    if (index > 0) options.model.setViewTurnNumber(turns[index - 1]!.turnNumber);
  };

  const loadTurn = async (turnNumber: number): Promise<boolean> => {
    const target = positiveTurnNumber(turnNumber);
    const initial = options.campaignStore.store.get();
    const latest = initial.campaign?.activeTurnNumber ?? 0;
    if (target === null || target > latest) return false;
    if (initial.turns.some((turn) => turn.turnNumber === target)) {
      options.model.setViewTurnNumber(target);
      return true;
    }
    const guard = startRequest(initial.nextTurnsCursor);
    if (guard === null) return false;
    let cursor = guard.cursor;
    const pages: TurnListResponse[] = [];
    const seen = new Set<string>();
    let found = false;
    while (cursor !== null && !found) {
      if (seen.has(cursor)) throw new Error(`Story history cursor did not advance: ${cursor}`);
      seen.add(cursor);
      const page = await olderPage({ ...guard, cursor });
      if (page === null) return false;
      pages.push(page);
      found = page.turns.some((turn) => turn.turnNumber === target);
      cursor = page.nextCursor;
    }
    if (!found || !isCurrent(guard)) return false;
    options.campaignStore.prependOlderTurns({
      campaignId: guard.campaignId,
      turns: pages.flatMap((page) => page.turns),
      nextCursor: cursor
    });
    projection = options.campaignStore.store.get();
    options.model.setViewTurnNumber(target);
    return true;
  };

  const complete = (): Promise<StoryHistoryResult> => {
    if (completeHistory !== null && isCurrent(completeHistory.guard)) return completeHistory.promise;
    const initial = options.campaignStore.store.get();
    projection = initial;
    const guard = startRequest(initial.nextTurnsCursor);
    if (guard === null) return Promise.resolve({ campaignId: "", turns: [], nextCursor: null });
    options.model.setMessage(null);
    options.model.setHistory("loading");
    const promise = (async () => {
      let cursor = guard.cursor;
      let turns = sortedTurns(initial.turns);
      const pages: TurnListResponse[] = [];
      const seen = new Set<string>();
      while (cursor !== null) {
        if (seen.has(cursor)) throw new Error(`Story history cursor did not advance: ${cursor}`);
        seen.add(cursor);
        const page = await olderPage({ ...guard, cursor });
        if (page === null) {
          const current = options.campaignStore.store.get();
          return { campaignId: current.campaign?.id ?? guard.campaignId, turns: sortedTurns(current.turns), nextCursor: current.nextTurnsCursor };
        }
        turns = mergeTurns<CampaignProjection["turns"][number]>(turns, page.turns);
        pages.push(page);
        cursor = page.nextCursor;
      }
      if (!isCurrent(guard)) return { campaignId: guard.campaignId, turns: sortedTurns(options.campaignStore.store.get().turns), nextCursor: options.campaignStore.store.get().nextTurnsCursor };
      if (pages.length > 0) {
        const mergedPage: TurnListResponse = {
          campaignId: guard.campaignId,
          turns: pages.flatMap((page) => page.turns),
          nextCursor: null
        };
        options.campaignStore.prependOlderTurns(mergedPage);
      }
      options.model.setHistory("idle");
      return { campaignId: guard.campaignId, turns, nextCursor: null };
    })().catch((error: unknown) => {
      if (isCurrent(guard)) {
        options.model.setHistory("error");
        options.model.setMessage("History unavailable. Retry complete history.");
      }
      throw error;
    }).finally(() => {
      if (completeHistory?.guard === guard) completeHistory = null;
    });
    completeHistory = { guard, promise };
    return promise;
  };

  return {
    sync(next) {
      projection = next;
      const nextEpoch = currentEpoch(next);
      if (!sameEpoch(epochState, nextEpoch)) {
        epochState = nextEpoch;
        epoch += 1;
        completeHistory = null;
        if (options.model.get().history === "loading") options.model.setHistory("idle");
      }
    },
    async previous() {
      const turns = sortedTurns(options.campaignStore.store.get().turns);
      const selected = options.model.get().viewTurnNumber ?? projection.campaign?.activeTurnNumber ?? null;
      const index = turns.findIndex((turn) => turn.turnNumber === selected);
      if (index > 0) {
        options.model.setViewTurnNumber(turns[index - 1]!.turnNumber);
        return;
      }
      const guard = startRequest(options.campaignStore.store.get().nextTurnsCursor);
      if (guard === null || guard.cursor === null) return;
      const page = await olderPage(guard);
      if (page === null || !isCurrent(guard)) return;
      options.campaignStore.prependOlderTurns(page);
      projection = options.campaignStore.store.get();
      selectPrevious();
    },
    async next() {
      const latest = projection.campaign?.activeTurnNumber ?? 0;
      const selected = options.model.get().viewTurnNumber ?? latest;
      if (selected >= latest) return;
      const turns = sortedTurns(options.campaignStore.store.get().turns);
      const next = turns.find((turn) => turn.turnNumber > selected && turn.turnNumber <= latest);
      if (next) options.model.setViewTurnNumber(next.turnNumber);
    },
    loadTurn,
    jump(turnNumber) {
      const target = positiveTurnNumber(turnNumber);
      const latest = projection.campaign?.activeTurnNumber ?? 0;
      if (target === null || target > latest) return;
      if (options.campaignStore.store.get().turns.some((turn) => turn.turnNumber === target)) {
        options.model.setViewTurnNumber(target);
      }
    },
    openCompleteHistory: complete,
    retryCompleteHistory() {
      if (options.model.get().history !== "error") return complete();
      return complete();
    },
    async inspect(turnNumber) {
      const target = positiveTurnNumber(turnNumber);
      const guard = target === null ? null : startRequest(null);
      if (guard === null || target === null) return null;
      const state = await options.campaigns.state(guard.campaignId, target, undefined);
      return isCurrent(guard) ? state : null;
    },
    dispose() {
      disposed = true;
      completeHistory = null;
    }
  };
}
