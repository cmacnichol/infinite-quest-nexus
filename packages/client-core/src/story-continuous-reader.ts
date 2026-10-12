import {
  readerSceneWindowRequestSchema,
  readerSceneWindowResponseSchema,
  readerTurnResponseSchema,
  turnSummarySchema
} from "@infinite-quest/contracts";
import type {
  ReaderSceneWindowRequest,
  ReaderSceneWindowResponse,
  ReaderTurnResponse,
  TurnSummary
} from "@infinite-quest/contracts";

export const STORY_CONTINUOUS_READER_WINDOW_LIMIT = 10;
export const STORY_CONTINUOUS_READER_NEIGHBOR_LIMIT = STORY_CONTINUOUS_READER_WINDOW_LIMIT - 1;

export type StoryReadIdentity = Readonly<{ turnNumber: number; id: string }>;
export type StoryContinuousReaderScope = Readonly<{ campaignId: string; loadEpoch: number }>;
export type StoryContinuousReaderFailureKind = "request" | "history-changed" | "anchor-changed" | "protocol";

export type StoryContinuousReaderRequest = Readonly<{
  requestId: number;
  campaignId: string;
  loadEpoch: number;
  windowEpoch: number;
  apiRequest: ReaderSceneWindowRequest;
  replacesAnchorIdentity?: StoryReadIdentity;
}>;

export type StoryContinuousReaderAnchorRefreshRequest = Readonly<{
  requestId: number;
  campaignId: string;
  loadEpoch: number;
  windowEpoch: number;
  failedRequest: StoryContinuousReaderRequest;
  turnNumber: number;
}>;

type StoryContinuousReaderRetryPlan =
  | Readonly<{ kind: "window"; request: StoryContinuousReaderRequest; omitHistoryToken: boolean }>
  | Readonly<{ kind: "anchor-refresh"; failedRequest: StoryContinuousReaderRequest }>;

export type StoryContinuousReaderState = Readonly<{
  scope: StoryContinuousReaderScope;
  presentation: "window" | "exact-pin";
  turns: readonly TurnSummary[];
  selectedReadIdentity: StoryReadIdentity | null;
  historyToken: string | null;
  historyTokenStale: boolean;
  edgeAvailability: Readonly<{ older: boolean | null; newer: boolean | null }>;
  windowEpoch: number;
  requestEpoch: number;
  pendingRequest: StoryContinuousReaderRequest | StoryContinuousReaderAnchorRefreshRequest | null;
  status: "idle" | "loading" | "error";
  failureKind: StoryContinuousReaderFailureKind | null;
  retryPlan: StoryContinuousReaderRetryPlan | null;
}>;

export type StoryContinuousReaderBootstrap = Readonly<{
  scope: StoryContinuousReaderScope;
  residentTurns: readonly TurnSummary[];
  selectedReadIdentity?: StoryReadIdentity | null;
  selectedTurn?: ReaderTurnResponse;
}>;

export type StoryContinuousReaderInitialization =
  | Readonly<{ status: "ready"; state: StoryContinuousReaderState }>
  | Readonly<{ status: "selected-turn-required"; identity: StoryReadIdentity }>;

export type StoryContinuousReaderRetry = Readonly<{
  state: StoryContinuousReaderState;
  request: StoryContinuousReaderRequest | null;
  anchorRefreshRequest: StoryContinuousReaderAnchorRefreshRequest | null;
}>;

export type StoryContinuousReaderAnchorRefreshResult = Readonly<{
  state: StoryContinuousReaderState;
  request: StoryContinuousReaderRequest | null;
}>;

function sameIdentity(left: StoryReadIdentity | null, right: StoryReadIdentity): boolean {
  return left?.turnNumber === right.turnNumber && left.id === right.id;
}

function identityFor(turn: TurnSummary): StoryReadIdentity {
  return { turnNumber: turn.turnNumber, id: turn.id };
}

function orderedResidentTurns(turns: readonly TurnSummary[]): TurnSummary[] {
  const byNumber = new Map<number, TurnSummary>();
  const byId = new Map<string, TurnSummary>();
  for (const rawTurn of turns) {
    const parsed = turnSummarySchema.safeParse(rawTurn);
    if (!parsed.success) throw new Error("Continuous reader resident turn is invalid.");
    const existingNumber = byNumber.get(parsed.data.turnNumber);
    const existingId = byId.get(parsed.data.id);
    if ((existingNumber && existingNumber.id !== parsed.data.id)
      || (existingId && existingId.turnNumber !== parsed.data.turnNumber)) {
      throw new Error("Continuous reader resident turns contain conflicting identities.");
    }
    byNumber.set(parsed.data.turnNumber, parsed.data);
    byId.set(parsed.data.id, parsed.data);
  }
  return [...byNumber.values()].sort((left, right) => left.turnNumber - right.turnNumber);
}

function emptyState(scope: StoryContinuousReaderScope): StoryContinuousReaderState {
  return {
    scope: { campaignId: scope.campaignId, loadEpoch: scope.loadEpoch },
    presentation: "window",
    turns: [],
    selectedReadIdentity: null,
    historyToken: null,
    historyTokenStale: false,
    edgeAvailability: { older: false, newer: false },
    windowEpoch: 0,
    requestEpoch: 0,
    pendingRequest: null,
    status: "idle",
    failureKind: null,
    retryPlan: null
  };
}

function currentWindowRequest(
  state: StoryContinuousReaderState,
  request: StoryContinuousReaderRequest
): boolean {
  return state.pendingRequest === request
    && state.scope.campaignId === request.campaignId
    && state.scope.loadEpoch === request.loadEpoch
    && state.windowEpoch === request.windowEpoch
    && state.requestEpoch === request.requestId;
}

function currentAnchorRefreshRequest(
  state: StoryContinuousReaderState,
  request: StoryContinuousReaderAnchorRefreshRequest
): boolean {
  return state.pendingRequest === request
    && state.scope.campaignId === request.campaignId
    && state.scope.loadEpoch === request.loadEpoch
    && state.windowEpoch === request.windowEpoch
    && state.requestEpoch === request.requestId;
}

function createWindowRequest(
  state: StoryContinuousReaderState,
  apiRequest: ReaderSceneWindowRequest,
  replacesAnchorIdentity?: StoryReadIdentity
): { readonly state: StoryContinuousReaderState; readonly request: StoryContinuousReaderRequest } {
  const request: StoryContinuousReaderRequest = {
    requestId: state.requestEpoch + 1,
    campaignId: state.scope.campaignId,
    loadEpoch: state.scope.loadEpoch,
    windowEpoch: state.windowEpoch,
    apiRequest,
    ...(replacesAnchorIdentity ? { replacesAnchorIdentity } : {})
  };
  return {
    state: {
      ...state,
      requestEpoch: request.requestId,
      pendingRequest: request,
      status: "loading",
      failureKind: null,
      retryPlan: null
    },
    request
  };
}

function createAnchorRefreshRequest(
  state: StoryContinuousReaderState,
  failedRequest: StoryContinuousReaderRequest
): { readonly state: StoryContinuousReaderState; readonly request: StoryContinuousReaderAnchorRefreshRequest } {
  const request: StoryContinuousReaderAnchorRefreshRequest = {
    requestId: state.requestEpoch + 1,
    campaignId: state.scope.campaignId,
    loadEpoch: state.scope.loadEpoch,
    windowEpoch: state.windowEpoch,
    failedRequest,
    turnNumber: failedRequest.apiRequest.anchorTurnNumber
  };
  return {
    state: {
      ...state,
      requestEpoch: request.requestId,
      pendingRequest: request,
      status: "loading",
      failureKind: null,
      retryPlan: null
    },
    request
  };
}

function failedWindowRequest(
  state: StoryContinuousReaderState,
  request: StoryContinuousReaderRequest,
  failureKind: StoryContinuousReaderFailureKind
): StoryContinuousReaderState {
  const tokenIsStale = state.historyTokenStale || failureKind === "history-changed" || failureKind === "anchor-changed";
  return {
    ...state,
    pendingRequest: null,
    status: "error",
    failureKind,
    historyTokenStale: tokenIsStale,
    retryPlan: failureKind === "anchor-changed"
      ? { kind: "anchor-refresh", failedRequest: request }
      : { kind: "window", request, omitHistoryToken: tokenIsStale }
  };
}

function failedAnchorRefresh(
  state: StoryContinuousReaderState,
  request: StoryContinuousReaderAnchorRefreshRequest
): StoryContinuousReaderState {
  return {
    ...state,
    pendingRequest: null,
    status: "error",
    failureKind: "protocol",
    retryPlan: { kind: "anchor-refresh", failedRequest: request.failedRequest }
  };
}

export function createStoryContinuousReaderState(
  input: StoryContinuousReaderBootstrap
): StoryContinuousReaderInitialization {
  const turns = orderedResidentTurns(input.residentTurns);
  const recentTurns = turns.slice(-STORY_CONTINUOUS_READER_WINDOW_LIMIT);
  const selectedFromInput = input.selectedReadIdentity;
  const parsedSelectedResponse = input.selectedTurn === undefined
    ? null
    : readerTurnResponseSchema.safeParse(input.selectedTurn);
  const selectedTurn = parsedSelectedResponse?.success
    && parsedSelectedResponse.data.campaignId === input.scope.campaignId
    ? parsedSelectedResponse.data.turn
    : null;
  const selectedIdentity = selectedFromInput !== undefined
    ? selectedFromInput
    : selectedTurn
      ? identityFor(selectedTurn)
      : recentTurns.at(-1)
        ? identityFor(recentTurns.at(-1)!)
        : null;

  if (selectedIdentity) {
    const residentSelectedTurn = turns.find((turn) => sameIdentity(identityFor(turn), selectedIdentity));
    const exactSelectedTurn = selectedTurn && sameIdentity(identityFor(selectedTurn), selectedIdentity)
      ? selectedTurn
      : null;
    const selectedTurnData = exactSelectedTurn ?? residentSelectedTurn;
    if (!selectedTurnData) return { status: "selected-turn-required", identity: selectedIdentity };
    const inRecentWindow = recentTurns.some((turn) => sameIdentity(identityFor(turn), selectedIdentity));
    if (!inRecentWindow) {
      const state: StoryContinuousReaderState = {
        ...emptyState(input.scope),
        presentation: "exact-pin",
        turns: [selectedTurnData],
        selectedReadIdentity: selectedIdentity,
        edgeAvailability: { older: null, newer: null }
      };
      return { status: "ready", state };
    }
    const visibleTurns = recentTurns.map((turn) => sameIdentity(identityFor(turn), selectedIdentity)
      ? selectedTurnData
      : turn);
    return {
      status: "ready",
      state: {
        ...emptyState(input.scope),
        turns: visibleTurns,
        selectedReadIdentity: selectedIdentity,
        edgeAvailability: { older: null, newer: null }
      }
    };
  }

  return {
    status: "ready",
    state: {
      ...emptyState(input.scope),
      turns: recentTurns,
      edgeAvailability: recentTurns.length ? { older: null, newer: null } : { older: false, newer: false }
    }
  };
}

export function selectStoryReadIdentity(
  state: StoryContinuousReaderState,
  identity: StoryReadIdentity | null
): StoryContinuousReaderState {
  return { ...state, selectedReadIdentity: identity };
}

export function beginStoryContinuousReaderGroup(
  state: StoryContinuousReaderState,
  direction: "older" | "newer"
): Readonly<{ state: StoryContinuousReaderState; request: StoryContinuousReaderRequest | null }> {
  if (state.pendingRequest || state.status === "error" || state.edgeAvailability[direction] === false) {
    return { state, request: null };
  }
  const anchor = direction === "older" ? state.turns[0] : state.turns.at(-1);
  if (!anchor) return { state, request: null };
  const apiRequest = readerSceneWindowRequestSchema.parse({
    anchorTurnNumber: anchor.turnNumber,
    anchorTurnId: anchor.id,
    direction,
    neighborLimit: STORY_CONTINUOUS_READER_NEIGHBOR_LIMIT,
    ...(!state.historyTokenStale && state.historyToken !== null ? { historyToken: state.historyToken } : {})
  });
  const created = createWindowRequest(state, apiRequest);
  return { state: created.state, request: created.request };
}

export function settleStoryContinuousReaderResponse(
  state: StoryContinuousReaderState,
  request: StoryContinuousReaderRequest,
  rawResponse: unknown
): StoryContinuousReaderState {
  if (!currentWindowRequest(state, request)) return state;
  const parsedResponse = readerSceneWindowResponseSchema.safeParse(rawResponse);
  if (!parsedResponse.success) return failedWindowRequest(state, request, "protocol");
  const response: ReaderSceneWindowResponse = parsedResponse.data;
  if (response.campaignId !== request.campaignId
    || response.direction !== request.apiRequest.direction
    || response.anchor.turnNumber !== request.apiRequest.anchorTurnNumber
    || response.anchor.id !== request.apiRequest.anchorTurnId) {
    return failedWindowRequest(state, request, "protocol");
  }

  const requestedEdge = request.apiRequest.direction;
  const oppositeEdge = requestedEdge === "older" ? "newer" : "older";
  const hasPriorOppositeScenes = requestedEdge === "older"
    ? state.turns.some((turn) => turn.turnNumber > request.apiRequest.anchorTurnNumber)
    : state.turns.some((turn) => turn.turnNumber < request.apiRequest.anchorTurnNumber);
  const sameHistory = !state.historyTokenStale
    && state.historyToken !== null
    && response.historyToken === state.historyToken;
  const oppositeAvailability = sameHistory
    && (hasPriorOppositeScenes || state.edgeAvailability[oppositeEdge] === true)
    ? true
    : null;
  const selectedReadIdentity = request.replacesAnchorIdentity
    && sameIdentity(state.selectedReadIdentity, request.replacesAnchorIdentity)
    ? { turnNumber: response.anchor.turnNumber, id: response.anchor.id }
    : state.selectedReadIdentity;

  return {
    ...state,
    presentation: "window",
    turns: response.turns,
    selectedReadIdentity,
    historyToken: response.historyToken,
    historyTokenStale: false,
    edgeAvailability: requestedEdge === "older"
      ? { older: response.hasMore, newer: oppositeAvailability }
      : { older: oppositeAvailability, newer: response.hasMore },
    windowEpoch: state.windowEpoch + 1,
    pendingRequest: null,
    status: "idle",
    failureKind: null,
    retryPlan: null
  };
}

export function settleStoryContinuousReaderFailure(
  state: StoryContinuousReaderState,
  request: StoryContinuousReaderRequest,
  failureKind: StoryContinuousReaderFailureKind
): StoryContinuousReaderState {
  if (!currentWindowRequest(state, request)) return state;
  return failedWindowRequest(state, request, failureKind);
}

export function beginStoryContinuousReaderRetry(state: StoryContinuousReaderState): Readonly<{
  state: StoryContinuousReaderState;
  request: StoryContinuousReaderRequest | null;
  anchorRefreshRequest: StoryContinuousReaderAnchorRefreshRequest | null;
}> {
  if (state.status !== "error" || !state.retryPlan || state.pendingRequest) {
    return { state, request: null, anchorRefreshRequest: null };
  }
  if (state.retryPlan.kind === "anchor-refresh") {
    const created = createAnchorRefreshRequest(state, state.retryPlan.failedRequest);
    return { state: created.state, request: null, anchorRefreshRequest: created.request };
  }
  const { request: failedRequest, omitHistoryToken } = state.retryPlan;
  const { historyToken: _historyToken, ...withoutToken } = failedRequest.apiRequest;
  const apiRequest = readerSceneWindowRequestSchema.parse(omitHistoryToken
    ? withoutToken
    : failedRequest.apiRequest);
  const created = createWindowRequest(state, apiRequest, failedRequest.replacesAnchorIdentity);
  return { state: created.state, request: created.request, anchorRefreshRequest: null };
}

export function settleStoryContinuousReaderAnchorRefresh(
  state: StoryContinuousReaderState,
  request: StoryContinuousReaderAnchorRefreshRequest,
  rawResponse: unknown
): Readonly<{ state: StoryContinuousReaderState; request: StoryContinuousReaderRequest | null }> {
  if (!currentAnchorRefreshRequest(state, request)) return { state, request: null };
  const parsedResponse = readerTurnResponseSchema.safeParse(rawResponse);
  if (!parsedResponse.success
    || parsedResponse.data.campaignId !== request.campaignId
    || parsedResponse.data.turn.turnNumber !== request.turnNumber) {
    return { state: failedAnchorRefresh(state, request), request: null };
  }

  const refreshedTurn = parsedResponse.data.turn;
  const previousAnchorIdentity: StoryReadIdentity = {
    turnNumber: request.failedRequest.apiRequest.anchorTurnNumber,
    id: request.failedRequest.apiRequest.anchorTurnId
  };
  const apiRequest = readerSceneWindowRequestSchema.parse({
    anchorTurnNumber: refreshedTurn.turnNumber,
    anchorTurnId: refreshedTurn.id,
    direction: request.failedRequest.apiRequest.direction,
    neighborLimit: STORY_CONTINUOUS_READER_NEIGHBOR_LIMIT
  });
  const created = createWindowRequest(state, apiRequest, previousAnchorIdentity);
  return { state: { ...created.state, historyTokenStale: true }, request: created.request };
}

export function settleStoryContinuousReaderAnchorRefreshFailure(
  state: StoryContinuousReaderState,
  request: StoryContinuousReaderAnchorRefreshRequest
): StoryContinuousReaderState {
  if (!currentAnchorRefreshRequest(state, request)) return state;
  return {
    ...state,
    pendingRequest: null,
    status: "error",
    failureKind: "request",
    retryPlan: { kind: "anchor-refresh", failedRequest: request.failedRequest }
  };
}

export function reconcileStoryAcceptedSceneReplacement(
  state: StoryContinuousReaderState,
  rawReplacement: TurnSummary
): StoryContinuousReaderState {
  const parsedReplacement = turnSummarySchema.safeParse(rawReplacement);
  if (!parsedReplacement.success) throw new Error("Accepted replacement scene is invalid.");
  const replacement = parsedReplacement.data;
  const existingIndex = state.turns.findIndex((turn) => turn.turnNumber === replacement.turnNumber);
  const turns = existingIndex < 0
    ? state.turns
    : state.turns.map((turn, index) => index === existingIndex ? replacement : turn);
  const updatedTurns = orderedResidentTurns(turns);
  if (updatedTurns.length > STORY_CONTINUOUS_READER_WINDOW_LIMIT) {
    throw new Error("Continuous reader window exceeds the scene limit.");
  }
  const selectionMatchesOrdinal = state.selectedReadIdentity?.turnNumber === replacement.turnNumber;
  return {
    ...state,
    turns: existingIndex < 0 ? state.turns : updatedTurns,
    selectedReadIdentity: selectionMatchesOrdinal ? identityFor(replacement) : state.selectedReadIdentity,
    historyToken: null,
    historyTokenStale: false,
    edgeAvailability: state.turns.length ? { older: null, newer: null } : { older: false, newer: false },
    windowEpoch: state.windowEpoch + 1,
    requestEpoch: state.requestEpoch + 1,
    pendingRequest: null,
    status: "idle",
    failureKind: null,
    retryPlan: null
  };
}
