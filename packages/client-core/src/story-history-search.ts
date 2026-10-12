import { readerHistoryRequestSchema } from "@infinite-quest/contracts";
import type { ReaderHistoryItem, ReaderHistoryResponse } from "@infinite-quest/contracts";

export type StoryHistorySearchScope = {
  readonly campaignId: string;
  readonly loadEpoch: number;
};

export type StoryHistorySearchRequest = {
  readonly campaignId: string;
  readonly loadEpoch: number;
  readonly queryEpoch: number;
  readonly requestId: number;
  readonly query: string;
  readonly before: string | null;
};

export type StoryHistorySearchOutcome =
  | { readonly type: "success"; readonly response: ReaderHistoryResponse }
  | { readonly type: "request-error" }
  | { readonly type: "conflict" };

export type StoryHistorySearchState = {
  readonly scope: StoryHistorySearchScope | null;
  readonly query: string;
  readonly queryEpoch: number;
  readonly nextRequestId: number;
  readonly activeRequest: StoryHistorySearchRequest | null;
  readonly status: "idle" | "invalid" | "loading" | "results" | "empty" | "error";
  readonly errorKind: "request" | "conflict" | "scope" | "protocol" | null;
  readonly items: readonly ReaderHistoryItem[];
  readonly nextCursor: string | null;
  readonly retryBefore: string | null;
};

function sameScope(left: StoryHistorySearchScope | null, right: StoryHistorySearchScope): boolean {
  return left?.campaignId === right.campaignId && left.loadEpoch === right.loadEpoch;
}

function createRequest(
  state: StoryHistorySearchState,
  before: string | null
): { readonly state: StoryHistorySearchState; readonly request: StoryHistorySearchRequest } {
  if (!state.scope) throw new Error("A story history search needs a campaign scope.");
  const request: StoryHistorySearchRequest = {
    campaignId: state.scope.campaignId,
    loadEpoch: state.scope.loadEpoch,
    queryEpoch: state.queryEpoch,
    requestId: state.nextRequestId + 1,
    query: state.query,
    before
  };
  return {
    state: {
      ...state,
      nextRequestId: request.requestId,
      activeRequest: request,
      status: "loading",
      errorKind: null
    },
    request
  };
}

export function normalizeStoryHistorySearchQuery(value: string): { readonly query: string; readonly valid: boolean } {
  const parsed = readerHistoryRequestSchema.safeParse({ q: value });
  return parsed.success
    ? { query: parsed.data.q, valid: true }
    : { query: value.trim(), valid: false };
}

export function createStoryHistorySearchState(): StoryHistorySearchState {
  return {
    scope: null,
    query: "",
    queryEpoch: 0,
    nextRequestId: 0,
    activeRequest: null,
    status: "idle",
    errorKind: null,
    items: [],
    nextCursor: null,
    retryBefore: null
  };
}

export function beginStoryHistorySearch(
  state: StoryHistorySearchState,
  scope: StoryHistorySearchScope,
  rawQuery: string
): { readonly state: StoryHistorySearchState; readonly request: StoryHistorySearchRequest | null } {
  const normalized = normalizeStoryHistorySearchQuery(rawQuery);
  const scopeChanged = !sameScope(state.scope, scope);
  const queryChanged = normalized.query !== state.query;
  const identityChanged = scopeChanged || queryChanged;
  const next: StoryHistorySearchState = {
    ...state,
    scope: { campaignId: scope.campaignId, loadEpoch: scope.loadEpoch },
    query: normalized.query,
    queryEpoch: identityChanged ? state.queryEpoch + 1 : state.queryEpoch,
    activeRequest: null,
    status: normalized.valid ? "idle" : "invalid",
    errorKind: null,
    items: identityChanged || !normalized.valid || !normalized.query ? [] : state.items,
    nextCursor: identityChanged || !normalized.valid || !normalized.query ? null : state.nextCursor,
    retryBefore: null
  };

  if (!normalized.valid || !normalized.query) return { state: next, request: null };
  return createRequest(next, null);
}

export function beginStoryHistorySearchPage(
  state: StoryHistorySearchState,
  action: "more" | "retry"
): { readonly state: StoryHistorySearchState; readonly request: StoryHistorySearchRequest | null } {
  if (!state.scope || !state.query) return { state, request: null };
  if (action === "more") {
    if (state.status !== "results" || !state.nextCursor) return { state, request: null };
    return createRequest(state, state.nextCursor);
  }
  if (state.status !== "error") return { state, request: null };
  const before = state.errorKind === "conflict" || state.errorKind === "scope" || state.errorKind === "protocol"
    ? null
    : state.retryBefore;
  return createRequest(state, before);
}

export function settleStoryHistorySearch(
  state: StoryHistorySearchState,
  request: StoryHistorySearchRequest,
  outcome: StoryHistorySearchOutcome
): StoryHistorySearchState {
  if (state.activeRequest !== request
    || !state.scope
    || request.campaignId !== state.scope.campaignId
    || request.loadEpoch !== state.scope.loadEpoch
    || request.queryEpoch !== state.queryEpoch
    || request.query !== state.query) return state;

  if (outcome.type === "request-error") {
    return {
      ...state,
      activeRequest: null,
      status: "error",
      errorKind: "request",
      retryBefore: request.before
    };
  }
  if (outcome.type === "conflict") {
    return {
      ...state,
      activeRequest: null,
      status: "error",
      errorKind: "conflict",
      nextCursor: null,
      retryBefore: null
    };
  }

  if (outcome.response.campaignId !== request.campaignId) {
    return {
      ...state,
      activeRequest: null,
      status: "error",
      errorKind: "scope",
      nextCursor: null,
      retryBefore: null
    };
  }
  if (outcome.response.items.length > 50) {
    return {
      ...state,
      activeRequest: null,
      status: "error",
      errorKind: "protocol",
      nextCursor: null,
      retryBefore: null
    };
  }

  return {
    ...state,
    activeRequest: null,
    status: outcome.response.items.length ? "results" : "empty",
    errorKind: null,
    items: outcome.response.items,
    nextCursor: outcome.response.nextCursor,
    retryBefore: null
  };
}

export function validateStoryHistoryJumpTarget(
  rawValue: string,
  latestTurnNumber: number
): { readonly valid: true; readonly turnNumber: number } | { readonly valid: false; readonly reason: "invalid" | "out-of-range" } {
  const value = rawValue.trim();
  if (!/^\d+$/u.test(value)) return { valid: false, reason: "invalid" };
  const turnNumber = Number(value);
  if (!Number.isSafeInteger(turnNumber) || turnNumber < 1) return { valid: false, reason: "invalid" };
  if (!Number.isSafeInteger(latestTurnNumber) || latestTurnNumber < 1 || turnNumber > latestTurnNumber) {
    return { valid: false, reason: "out-of-range" };
  }
  return { valid: true, turnNumber };
}
