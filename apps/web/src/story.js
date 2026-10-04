/* ═══════════════════════════════════════════════════════════════
   Infinite Quest — Story Player
   ═══════════════════════════════════════════════════════════════ */
import { branchCampaignFromTurn } from "./story-routing.js";
import {
  appendExpectedTurnNumber,
  latestTurnNumber,
  turnIndexForNumber,
  undoTargetTurnNumber
} from "./story-turn-window.js";
import {
  loadCompleteStoryHistory,
  mergeStoryTurnPages
} from "./story-history-loader.js";
import {
  cancelGeneration,
  reconcileRemoteGenerationCancellation,
  syncCancelGenerationButton
} from "./story-generation-cancellation.js";
import {
  addEditableStateRow,
  captureCampaignStateEditSession,
  renderCampaignStateInspector,
  renderEditableStateCollection,
  saveCampaignStateFromEditor
} from "./story-state-editor.js";
import {
  fetchCompletedGenerationResult,
  generationSubmissionInput,
  observeGenerationRunEvents,
  presentGenerationEvents,
  resumeActiveGenerationConflict
} from "./story-generation-monitor.js";
import { handleStoryEscape } from "./story-keyboard.js";
import { createLegacyCastPanel } from "./campaign-cast-panel.js";
import {
  createChoiceDraftSelection,
  resetChoiceDraftSelection,
  turnInputModeForControlStyle,
  toggleChoiceDraftSelection
} from "./story-choice-selection.js";
import {
  createCampaignContinuityDraft,
  formatChronicleRetrievalAudit,
  STORY_HISTORY_PAGE_LIMIT,
  createStoryHistoryWindow,
  installStoryHistoryWindowPage,
  selectStoryHistoryPreview,
  storyHistoryPageRequest,
  storyHistoryVisibleTurns,
  generationDiagnosticPresentation,
  generationRecoveryGuidance,
  generationResponseFormatPresentation,
  generationReviewPresentation,
  generationReviewTechnicalDiagnosticMessage,
  beginStoryHistorySearch,
  beginStoryHistorySearchPage,
  createStoryHistorySearchState,
  settleStoryHistorySearch,
  validateStoryHistoryJumpTarget,
  STORY_CONTINUOUS_READER_WINDOW_LIMIT,
  createStoryContinuousReaderState,
  beginStoryContinuousReaderGroup,
  settleStoryContinuousReaderResponse,
  settleStoryContinuousReaderFailure,
  beginStoryContinuousReaderRetry,
  settleStoryContinuousReaderAnchorRefresh,
  settleStoryContinuousReaderAnchorRefreshFailure,
  reconcileStoryAcceptedSceneReplacement,
  DEFAULT_READER_PREFERENCES,
  normalizeReaderPreferences
} from "@infinite-quest/client-core";

"use strict";

function escapeChronicleRetrievalHtml(value) {
  return String(value)
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&#39;");
}

export function chronicleRetrievalHistoryMarkup(audit) {
  const presentation = formatChronicleRetrievalAudit(audit ?? null);
  const rows = [
    ["Search", presentation.searchPath],
    ["Provider", presentation.provider],
    ["Query vector", presentation.queryVector],
    ...(presentation.fallback ? [["Fallback", presentation.fallback]] : [])
  ];
  return `<dl class="turn-chronicle-audit" aria-label="Chronicle retrieval">${rows
    .map(([label, value]) => `<div><dt>${label}</dt><dd>${escapeChronicleRetrievalHtml(value)}</dd></div>`)
    .join("")}</dl>`;
}

export function startStoryPlayer(composition) {

let actionDraftLocalGeneration = 0;
let actionDraftPersistedGeneration = -1;
let actionDraftPersistedRevision = null;
let actionDraftCurrent = null;
let actionDraftSubmitted = null;
let actionDraftConflict = null;
let actionDraftSaving = false;
let actionDraftScheduled = false;
let actionDraftSaveFailed = false;
let actionDraftClearPending = false;
let actionDraftSaveTimer = null;
let actionDraftSaveQueue = Promise.resolve();
let actionDraftNavigationTarget = null;
let actionDraftCurrentScopeKey = null;
let actionDraftSessionEpoch = 0;
let actionDraftSubmissionNonce = 0;

let resolveInitialization;
let rejectInitialization;
let campaignLoadSequence = 0;
let campaignStartupReconciliation = null;
let storyLoadRetryPromise = null;
let readerPositionInteractionEpoch = 0;
let readerPositionLoadEpoch = 0;
let readerPositionChoicePending = false;
let readerPositionRestoreEpoch = 0;
let readerPositionWriteTimer = null;
let readerPositionWriteQueue = Promise.resolve();
let continuousReaderAbortController = null;
const continuousSceneSignatures = new WeakMap();
let activeImagePoll = null;
const illustrationRenderSignatures = new WeakMap();
const inlineIllustrationRenderSignatures = new WeakMap();
const imageJobRenderSignatures = new WeakMap();

const initialization = new Promise((resolve, reject) => {
  resolveInitialization = resolve;
  rejectInitialization = reject;
});

const apiClient = composition.api;
const illustrationApi = composition.illustrations;
const readerHistoryApi = composition.readerHistory;
const readerPositionStore = composition.readerPositions;
const castPanel = composition.cast ? createLegacyCastPanel({ api: composition.cast,
  campaignId: () => state.campaignId, generationActive: () => responseGenerationIsActive(),
  openProtagonist: () => { void openEditCharacterProfile(); },
  navigateToTurn: async (turn) => { await ensureCompleteTurnHistory(); navigateToTurn(turn); }
}) : null;
// ── DOM Helpers ────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const escapeHtml = (text) => {
  if (!text) return "";
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
};
const escapeAttribute = (text) => escapeHtml(text).replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const sanitizeNarration = (text) => {
  if (!text) return "";
  return text.split("\n")
    .filter(p => p.trim())
    .map(p => `<p>${escapeHtml(p)}</p>`)
    .join("");
};

function ensureContinuousReaderControls() {
  const toolbar = document.querySelector("[data-story-reader-toolbar]");
  if (!toolbar) return null;
  let controls = $("continuousReaderControls");
  if (!controls) {
    controls = document.createElement("div");
    controls.id = "continuousReaderControls";
    controls.className = "continuous-reader-controls";
    controls.hidden = true;
    const older = document.createElement("button");
    older.type = "button";
    older.className = "small ghost";
    older.dataset.continuousReaderDirection = "older";
    older.textContent = "Load older scenes";
    const newer = document.createElement("button");
    newer.type = "button";
    newer.className = "small ghost";
    newer.dataset.continuousReaderDirection = "newer";
    newer.textContent = "Load newer scenes";
    const status = document.createElement("span");
    status.id = "continuousReaderStatus";
    status.className = "continuous-reader-status";
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    status.hidden = true;
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "small ghost";
    retry.dataset.continuousReaderRetry = "true";
    retry.textContent = "Retry scene group";
    retry.hidden = true;
    controls.append(older, newer, status, retry);
    toolbar.appendChild(controls);
  }
  return controls;
}

function initializeContinuousReader(options = {}) {
  if (!state.campaignId) {
    state.continuousReader = null;
    return null;
  }
  const bootstrap = {
    scope: { campaignId: state.campaignId, loadEpoch: campaignLoadSequence },
    residentTurns: state.turns,
    ...(options.selectedReadIdentity !== undefined
      ? { selectedReadIdentity: options.selectedReadIdentity }
      : {}),
    ...(options.selectedTurn ? {
      selectedTurn: { campaignId: state.campaignId, turn: options.selectedTurn }
    } : {})
  };
  const initialized = createStoryContinuousReaderState(bootstrap);
  state.continuousReader = initialized.status === "ready" ? initialized.state : null;
  return state.continuousReader;
}

function continuousReaderStatusText(readerState = state.continuousReader) {
  if (!readerState) return "";
  if (readerState.status === "loading") return "Loading scene group…";
  if (readerState.status === "error") {
    return CONTINUOUS_READER_FAILURE_COPY[readerState.failureKind] || CONTINUOUS_READER_FAILURE_COPY.request;
  }
  return "";
}

function syncContinuousReaderControls() {
  const controls = ensureContinuousReaderControls();
  if (!controls) return;
  const readerState = state.continuousReader;
  const isVisible = Boolean(state.user?.settings?.continuousReading && state.campaignLoaded && state.turns.length);
  controls.hidden = !isVisible;
  controls.classList.toggle("hidden", !isVisible);
  const pending = readerState?.status === "loading";
  for (const button of controls.querySelectorAll("[data-continuous-reader-direction]")) {
    const direction = button.dataset.continuousReaderDirection;
    button.disabled = !isVisible || pending || readerState?.status === "error"
      || readerState?.edgeAvailability?.[direction] === false;
  }
  const status = $("continuousReaderStatus");
  const statusText = continuousReaderStatusText(readerState);
  if (status) {
    status.textContent = statusText;
    status.hidden = !statusText;
  }
  const retry = controls.querySelector("[data-continuous-reader-retry]");
  if (retry) retry.hidden = !isVisible || readerState?.status !== "error";
}

function continuousReaderFailureKind(error) {
  const statusCode = Number(error?.statusCode ?? error?.status);
  const domainCode = error?.domainCode ?? error?.code;
  if (statusCode === 409 && domainCode === "reader_history_changed") return "history-changed";
  if (statusCode === 409 && domainCode === "reader_anchor_changed") return "anchor-changed";
  if (error?.name === "ApiContractError" || error?.name === "ZodError") return "protocol";
  return "request";
}

function captureContinuousReaderAnchor(request) {
  const turnNumber = request.apiRequest.anchorTurnNumber;
  const turnId = request.apiRequest.anchorTurnId;
  const scene = $(`scene-${turnNumber}`);
  if (!scene || scene.dataset.turnId !== turnId) return null;
  return { turnNumber, turnId, top: scene.getBoundingClientRect().top };
}

function restoreContinuousReaderAnchor(anchor, expectedState, interactionEpoch) {
  if (!anchor) return;
  window.requestAnimationFrame(() => {
    if (state.continuousReader !== expectedState
      || state.campaignId !== expectedState.scope.campaignId
      || campaignLoadSequence !== expectedState.scope.loadEpoch
      || !state.user?.settings?.continuousReading
      || readerPositionInteractionEpoch !== interactionEpoch) return;
    const scene = $(`scene-${anchor.turnNumber}`);
    if (!scene || scene.dataset.turnId !== anchor.turnId) return;
    const difference = scene.getBoundingClientRect().top - anchor.top;
    if (Math.abs(difference) > 0.5) {
      window.scrollTo({ top: window.scrollY + difference, behavior: "auto" });
    }
  });
}

function continuousReaderRequestIsCurrent(request, interactionEpoch) {
  return state.continuousReader?.pendingRequest === request
    && state.continuousReader.scope.campaignId === request.campaignId
    && state.continuousReader.scope.loadEpoch === request.loadEpoch
    && state.campaignId === request.campaignId
    && campaignLoadSequence === request.loadEpoch
    && state.user?.settings?.continuousReading
    && readerPositionInteractionEpoch === interactionEpoch;
}

function continuousReaderKeyboardFocusWasActive() {
  const active = document.activeElement;
  if (!(active instanceof HTMLButtonElement)) return false;
  try {
    return active.matches(":focus-visible")
      && (active.hasAttribute("data-continuous-reader-direction")
        || active.hasAttribute("data-continuous-reader-retry"));
  } catch {
    return false;
  }
}

function restoreContinuousReaderKeyboardFocus(shouldRestore) {
  if (!shouldRestore) return;
  const controls = ensureContinuousReaderControls();
  if (!controls) return;
  const active = document.activeElement;
  if (active instanceof HTMLButtonElement && !active.disabled && controls.contains(active)) return;
  const retry = controls.querySelector('[data-continuous-reader-retry]:not([hidden])');
  const nextDirection = [...controls.querySelectorAll("[data-continuous-reader-direction]")]
    .find((button) => button instanceof HTMLButtonElement && !button.disabled);
  const target = state.continuousReader?.status === "error" ? retry : nextDirection || retry;
  if (target instanceof HTMLButtonElement) target.focus({ preventScroll: true });
}

async function executeContinuousReaderRequest(request, anchor, interactionEpoch, restoreKeyboardFocus) {
  const controller = new AbortController();
  continuousReaderAbortController?.abort();
  continuousReaderAbortController = controller;
  try {
    const response = await readerHistoryApi.getSceneWindow(request.campaignId, request.apiRequest, controller.signal);
    if (!continuousReaderRequestIsCurrent(request, interactionEpoch)) return false;
    state.continuousReader = settleStoryContinuousReaderResponse(state.continuousReader, request, response);
    if (state.continuousReader.status === "idle") {
      const installedState = state.continuousReader;
      renderAllScenes({ autoScroll: false });
      restoreContinuousReaderKeyboardFocus(restoreKeyboardFocus);
      restoreContinuousReaderAnchor(anchor, installedState, interactionEpoch);
      updateStatusBar();
      return true;
    }
    syncContinuousReaderControls();
    restoreContinuousReaderKeyboardFocus(restoreKeyboardFocus);
    return false;
  } catch (error) {
    if (!continuousReaderRequestIsCurrent(request, interactionEpoch)) return false;
    state.continuousReader = settleStoryContinuousReaderFailure(
      state.continuousReader,
      request,
      continuousReaderFailureKind(error)
    );
    syncContinuousReaderControls();
    restoreContinuousReaderKeyboardFocus(restoreKeyboardFocus);
    return false;
  } finally {
    if (continuousReaderAbortController === controller) continuousReaderAbortController = null;
  }
}

function retirePendingContinuousReaderRequest() {
  const readerState = state.continuousReader;
  if (!readerState?.pendingRequest) return;
  continuousReaderAbortController?.abort();
  continuousReaderAbortController = null;
  state.continuousReader = {
    ...readerState,
    requestEpoch: readerState.requestEpoch + 1,
    pendingRequest: null,
    status: "idle",
    failureKind: null,
    retryPlan: null
  };
  syncContinuousReaderControls();
}

async function loadContinuousReaderGroup(direction) {
  const readerState = state.continuousReader;
  if (!state.user?.settings?.continuousReading || !readerState) return false;
  const restoreKeyboardFocus = continuousReaderKeyboardFocusWasActive();
  const started = beginStoryContinuousReaderGroup(readerState, direction);
  if (!started.request) return false;
  const interactionEpoch = readerPositionInteractionEpoch;
  const anchor = captureContinuousReaderAnchor(started.request);
  state.continuousReader = started.state;
  syncContinuousReaderControls();
  return executeContinuousReaderRequest(started.request, anchor, interactionEpoch, restoreKeyboardFocus);
}

async function retryContinuousReaderGroup() {
  const readerState = state.continuousReader;
  if (!readerState) return false;
  const started = beginStoryContinuousReaderRetry(readerState);
  if (!started.request && !started.anchorRefreshRequest) return false;
  const failedRequest = started.request || started.anchorRefreshRequest.failedRequest;
  let anchor = captureContinuousReaderAnchor(failedRequest);
  const interactionEpoch = readerPositionInteractionEpoch;
  const restoreKeyboardFocus = continuousReaderKeyboardFocusWasActive();
  state.continuousReader = started.state;
  syncContinuousReaderControls();
  if (started.request) return executeContinuousReaderRequest(started.request, anchor, interactionEpoch, restoreKeyboardFocus);

  const refresh = started.anchorRefreshRequest;
  const controller = new AbortController();
  continuousReaderAbortController?.abort();
  continuousReaderAbortController = controller;
  try {
    const response = await readerHistoryApi.getTurn(refresh.campaignId, refresh.turnNumber, controller.signal);
    if (state.continuousReader?.pendingRequest !== refresh || state.campaignId !== refresh.campaignId
      || campaignLoadSequence !== refresh.loadEpoch || !state.user?.settings?.continuousReading
      || readerPositionInteractionEpoch !== interactionEpoch) return false;
    const refreshed = settleStoryContinuousReaderAnchorRefresh(state.continuousReader, refresh, response);
    state.continuousReader = refreshed.state;
    if (refreshed.request) {
      if (anchor) anchor = { ...anchor, turnId: refreshed.request.apiRequest.anchorTurnId };
      return executeContinuousReaderRequest(refreshed.request, anchor, interactionEpoch, restoreKeyboardFocus);
    }
    syncContinuousReaderControls();
    restoreContinuousReaderKeyboardFocus(restoreKeyboardFocus);
    return false;
  } catch {
    if (state.continuousReader?.pendingRequest !== refresh || readerPositionInteractionEpoch !== interactionEpoch
      || !state.user?.settings?.continuousReading) return false;
    state.continuousReader = settleStoryContinuousReaderAnchorRefreshFailure(state.continuousReader, refresh);
    syncContinuousReaderControls();
    restoreContinuousReaderKeyboardFocus(restoreKeyboardFocus);
    return false;
  } finally {
    if (continuousReaderAbortController === controller) continuousReaderAbortController = null;
  }
}

// ── Constants ──────────────────────────────────────────────────
const IMAGE_POLL_MS = 5000;
const TOAST_DURATION = 3500;
const STORY_HISTORY_SEARCH_DEBOUNCE_MS = 250;
const CONTINUOUS_READER_FAILURE_COPY = Object.freeze({
  request: "Couldn't load this scene group. Try again.",
  "history-changed": "Story history changed. Retry this scene group.",
  "anchor-changed": "This scene was replaced. Refresh the scene group to continue.",
  protocol: "Couldn't use this scene group. Try again."
});

// ── State ──────────────────────────────────────────────────────
const state = {
  campaignId: null,
  campaign: null,
  campaignLoaded: false,
  world: null,
  playerConfig: null,
  storyMemorySettings: null,
  storyMemoryRequestId: 0,
  runtimeState: null,
  editStateSession: null,
  characterProfileEditSession: null,
  responseEditSession: null,
  turns: [],
  historyNextCursor: null,
  viewTurnNumber: null,
  busy: false,
  providers: [],
  abortController: null,
  pendingGeneration: null,
  generationRecovery: null,
  generationRun: null,
  generationDisplayActive: false,
  generationDisplayAction: "",
  generationJobId: null,
  generationRecoveryKind: null,
  generationReview: null,
  generationReviewError: null,
  generationReviewSubmitting: false,
  cancellationConfirmed: false,
  illustrationConfig: null,
  illustrationSegments: [],
  illustrationError: null,
  illustrationLoading: false,
  readerPinnedTurn: null,
  continuousReader: null,
  readerResumePosition: null,
  imagePollEpoch: 0,
  illustrationVariantIndexes: new Map(),
  illustrationSegmentActivity: new Map(),
  imagePollTimer: null,
  imageJobActivity: new Map(),
  imageActivityInitialized: false,
  activityLog: [],
  toastTimer: null,
  streamingAutoFollow: true,
  streamingExpectedScrollY: null,
  turnInputMode: "action",
  nextTurnInputModeSource: null,
  retainedAppendDraft: null,
  choiceDraftOwnerKey: null,
  choiceDraftSelection: createChoiceDraftSelection(),
  historySelectedTurnNumber: null,
  historyWindow: null,
  historyWindowCampaignId: null,
  historyWindowEpoch: null,
  historySelectedPreview: null,
  historyResidentRows: null,
  historyLocalCompleteRows: null,
  historyLocalEnd: null,
  historyPageRequestId: 0,
  historyInspectionRequestId: 0,
  historySearch: createStoryHistorySearchState(),
  historySearchJumpRequestId: 0,
  user: {
    id: null,
    systemKey: null,
    displayName: "Initial Owner",
    settings: {
      autoSubmitTurnChoices: true,
      continuousReading: false,
      defaultTurnControlStyle: "flexible_action",
      readerPreferences: DEFAULT_READER_PREFERENCES
    }
  }
};

const modalBaselines = new WeakMap();
let discardModalTarget = null;
let discardModalAction = null;
let completeHistoryLoad = null;
let historyPageLoad = null;
let historySearchDebounceTimer = null;
let historySearchAbortController = null;
let historySearchJumpAbortController = null;
let historySearchJumpSearchIdentity = null;
let storyTurnWindowEpoch = 0;
let nextEditStateSessionId = 0;
let nextCharacterProfileEditSessionId = 0;
let characterProfileEditRequestToken = 0;
let nextResponseEditSessionId = 0;
let userProfileSaving = false;
let userProfilePersistedTurnControlStyle = null;
let userProfileTurnControlStyleChanged = false;
let generationReviewLoadEpoch = 0;
let generationReviewLoadedKey = null;
const COMPLETE_HISTORY_SUPERSEDED = "complete_history_superseded";

function completeHistorySupersededError() {
  const error = new Error("Story history load was superseded.");
  error.code = COMPLETE_HISTORY_SUPERSEDED;
  return error;
}

function isCompleteHistorySuperseded(error) {
  return error?.code === COMPLETE_HISTORY_SUPERSEDED;
}

function publishStoryTurnWindow(turns, nextCursor, options = {}) {
  state.turns = turns;
  state.historyNextCursor = nextCursor || null;
  storyTurnWindowEpoch += 1;
  resetStoryHistorySearchForCurrentScope();
  if (completeHistoryLoad !== options.completeHistoryRequest) {
    completeHistoryLoad = null;
    setTurnHistoryLoadStatus("");
  }
}

function storyTurnWindowIsCurrent(campaignId, epoch, cursor) {
  return state.campaignId === campaignId
    && storyTurnWindowEpoch === epoch
    && state.historyNextCursor === cursor;
}

function readerPositionScope() {
  const userId = state.user?.id;
  const campaignId = state.campaignId;
  if (typeof userId !== "string" || typeof campaignId !== "string") return null;
  return { userId, campaignId };
}

function showReaderResumePrompt(position) {
  const prompt = $("readerResumePrompt");
  const message = $("readerResumeMessage");
  if (!prompt || !message) return;
  message.textContent = `Resume at Turn ${position.turnNumber}.`;
  prompt.hidden = false;
  prompt.classList.remove("hidden");
}

function hideReaderResumePrompt() {
  const prompt = $("readerResumePrompt");
  if (!prompt) return;
  prompt.hidden = true;
  prompt.classList.add("hidden");
}

function readerPositionWorkflowOwnsScene() {
  const recoveryPanel = $("generationRecoveryPanel");
  return Boolean(state.pendingGeneration)
    || Boolean(state.generationRecovery)
    || Boolean(state.generationReview?.summary)
    || Boolean(state.generationRecoveryKind)
    || state.generationDisplayActive
    || Boolean(recoveryPanel && !recoveryPanel.classList.contains("hidden"));
}

function syncReaderResumePrompt() {
  const position = state.readerResumePosition;
  if (!readerPositionWorkflowOwnsScene()
    && position && Number(position.turnNumber) !== currentViewTurnNumber()) showReaderResumePrompt(position);
  else hideReaderResumePrompt();
}

function showReaderPositionNotice(text) {
  const notice = $("readerPositionNotice");
  if (!notice) return;
  notice.textContent = text;
  notice.hidden = !text;
}

function readerLoadIsCurrent(campaignId, userId, loadSequence, positionLoadEpoch, interactionEpoch) {
  return readerScopeIsCurrent(campaignId, userId, loadSequence, positionLoadEpoch)
    && readerPositionInteractionEpoch === interactionEpoch;
}

function readerScopeIsCurrent(campaignId, userId, loadSequence, positionLoadEpoch) {
  return state.campaignId === campaignId
    && state.user?.id === userId
    && campaignLoadSequence === loadSequence
    && readerPositionLoadEpoch === positionLoadEpoch;
}

async function offerSavedReaderPosition(campaignId, loadSequence, interactionEpoch) {
  const scope = readerPositionScope();
  if (!scope || scope.campaignId !== campaignId) {
    readerPositionChoicePending = false;
    return;
  }
  const positionLoadEpoch = ++readerPositionLoadEpoch;
  readerPositionChoicePending = true;
  try {
    const position = await readerPositionStore.read(scope);
    if (!readerScopeIsCurrent(campaignId, scope.userId, loadSequence, positionLoadEpoch)) return;
    if (!position) {
      readerPositionChoicePending = false;
      return;
    }
    if (readerPositionInteractionEpoch !== interactionEpoch) {
      readerPositionChoicePending = false;
      syncReaderResumePrompt();
      return;
    }
    state.readerResumePosition = position;
    if (readerPositionWorkflowOwnsScene()) {
      readerPositionChoicePending = false;
      showReaderPositionNotice("Saved reading position is available after generation or recovery is resolved.");
      return;
    }
    const loadedTurn = state.turns.find((turn) => Number(turn.turnNumber) === position.turnNumber);
    if (loadedTurn && (loadedTurn.id || loadedTurn.turnId) !== position.turnId) {
      fallBackFromReaderPosition("That saved turn has been replaced. Showing the latest accepted turn.");
      return;
    }
    if (position.turnNumber > latestTurnNumber(state.turns)) {
      fallBackFromReaderPosition("That saved turn is no longer available. Showing the latest accepted turn.");
      return;
    }
    await restoreSavedReaderPosition(position, scope, loadSequence, positionLoadEpoch, interactionEpoch);
  } catch {
    // Reader-position storage is optional and must never block campaign loading.
    if (readerScopeIsCurrent(campaignId, scope.userId, loadSequence, positionLoadEpoch)) {
      readerPositionChoicePending = false;
    }
  }
}

function fallBackFromReaderPosition(message) {
  state.readerPinnedTurn = null;
  state.readerResumePosition = null;
  state.viewTurnNumber = null;
  readerPositionChoicePending = false;
  if (state.user?.settings?.continuousReading) initializeContinuousReader();
  hideReaderResumePrompt();
  showReaderPositionNotice(message);
  renderAllScenes();
  updateStatusBar();
  scheduleReaderPositionSave();
}

async function resumeSavedReaderPosition() {
  const position = state.readerResumePosition;
  const scope = readerPositionScope();
  if (!position || !scope) return;
  const loadSequence = campaignLoadSequence;
  const positionLoadEpoch = readerPositionLoadEpoch;
  const interactionEpoch = readerPositionInteractionEpoch;
  readerPositionChoicePending = true;
  await restoreSavedReaderPosition(position, scope, loadSequence, positionLoadEpoch, interactionEpoch);
}

async function restoreSavedReaderPosition(position, scope, loadSequence, positionLoadEpoch, interactionEpoch) {
  const restoreEpoch = ++readerPositionRestoreEpoch;
  const turnWindowEpoch = storyTurnWindowEpoch;
  const isCurrent = () => readerPositionRestoreEpoch === restoreEpoch
    && readerLoadIsCurrent(scope.campaignId, scope.userId, loadSequence, positionLoadEpoch, interactionEpoch)
    && storyTurnWindowEpoch === turnWindowEpoch
    && !readerPositionWorkflowOwnsScene();
  if (readerPositionWorkflowOwnsScene()) {
    readerPositionChoicePending = false;
    showReaderPositionNotice("Saved reading position is available after generation or recovery is resolved.");
    return;
  }
  showReaderPositionNotice("");
  const resumeButton = $("btnResumeReading");
  if (resumeButton) resumeButton.disabled = true;
  try {
    let turn = state.turns.find((item) => Number(item.turnNumber) === position.turnNumber) || null;
    if (turn && (turn.id || turn.turnId) !== position.turnId) {
      fallBackFromReaderPosition("That saved turn has been replaced. Showing the latest accepted turn.");
      return;
    }
    if (!turn) {
      const response = await readerHistoryApi.getTurn(scope.campaignId, position.turnNumber);
      if (!isCurrent()) {
        if (readerScopeIsCurrent(scope.campaignId, scope.userId, loadSequence, positionLoadEpoch)) {
          readerPositionChoicePending = false;
          syncReaderResumePrompt();
        }
        return;
      }
      if (response.campaignId !== scope.campaignId
        || Number(response.turn.turnNumber) !== position.turnNumber
        || response.turn.id !== position.turnId) {
        fallBackFromReaderPosition("That saved turn is no longer available. Showing the latest accepted turn.");
        return;
      }
      turn = response.turn;
    }
    if (!isCurrent()) {
      if (readerScopeIsCurrent(scope.campaignId, scope.userId, loadSequence, positionLoadEpoch)) {
        readerPositionChoicePending = false;
        syncReaderResumePrompt();
      }
      return;
    }
    const currentTurn = state.turns.find((item) => Number(item.turnNumber) === position.turnNumber);
    if (currentTurn && (currentTurn.id || currentTurn.turnId) !== position.turnId) {
      fallBackFromReaderPosition("That saved turn has been replaced. Showing the latest accepted turn.");
      return;
    }
    if (document.fonts?.ready) await document.fonts.ready;
    const acceptedTurnAfterLayout = state.turns.find((item) => Number(item.turnNumber) === position.turnNumber);
    if (acceptedTurnAfterLayout && (acceptedTurnAfterLayout.id || acceptedTurnAfterLayout.turnId) !== position.turnId) {
      readerPositionChoicePending = false;
      syncReaderResumePrompt();
      return;
    }
    if (!isCurrent()) {
      if (readerScopeIsCurrent(scope.campaignId, scope.userId, loadSequence, positionLoadEpoch)) {
        readerPositionChoicePending = false;
        syncReaderResumePrompt();
      }
      return;
    }
    state.readerPinnedTurn = currentTurn ? null : turn;
    state.viewTurnNumber = position.turnNumber === latestTurnNumber(state.turns) ? null : position.turnNumber;
    if (state.user?.settings?.continuousReading) {
      initializeContinuousReader({
        selectedReadIdentity: { turnNumber: position.turnNumber, id: position.turnId },
        selectedTurn: currentTurn || turn
      });
    }
    hideReaderResumePrompt();
    renderAllScenes({ autoScroll: false });
    updateStatusBar();
    readerPositionChoicePending = false;
    showReaderPositionNotice(`Resumed reading at Turn ${position.turnNumber}. Use Jump to latest to catch up.`);
    restoreReaderSceneOffset(position.turnNumber, position.offsetRatio);
    scheduleReaderPositionSave();
  } catch {
    if (isCurrent()) fallBackFromReaderPosition("That saved turn could not be opened. Showing the latest accepted turn.");
  } finally {
    if (resumeButton && readerPositionRestoreEpoch === restoreEpoch
      && readerScopeIsCurrent(scope.campaignId, scope.userId, loadSequence, positionLoadEpoch)) {
      resumeButton.disabled = false;
    }
  }
}

function readerStickyInset() {
  const headerHeight = document.querySelector(".universal-nav")?.getBoundingClientRect?.().height || 0;
  const toolbar = document.querySelector("[data-story-reader-toolbar]");
  const toolbarBottom = toolbar?.getBoundingClientRect?.().bottom || 0;
  return Math.max(headerHeight, toolbarBottom);
}

function readerPositionScene() {
  if (readerPositionWorkflowOwnsScene()) return null;
  if (!state.user?.settings?.continuousReading) {
    const number = currentViewTurnNumber();
    return document.getElementById(`scene-${number}`);
  }
  const readingLine = readerStickyInset() + 4;
  return [...document.querySelectorAll("[id^='scene-']")]
    .find((scene) => scene.getBoundingClientRect().bottom > readingLine) || null;
}

function captureReaderPosition() {
  const scope = readerPositionScope();
  const scene = readerPositionScene();
  if (!scope || !scene || readerPositionChoicePending) return null;
  const turnNumber = Number(scene.dataset.turnNumber);
  const turn = state.readerPinnedTurn && Number(state.readerPinnedTurn.turnNumber) === turnNumber
    ? state.readerPinnedTurn
    : state.turns.find((item) => Number(item.turnNumber) === turnNumber)
      || state.continuousReader?.turns.find((item) => Number(item.turnNumber) === turnNumber);
  const turnId = turn?.id || turn?.turnId;
  if (!turnId || !Number.isInteger(turnNumber) || turnNumber < 1) return null;
  const inset = readerStickyInset();
  const documentTop = scene.getBoundingClientRect().top + window.scrollY;
  const availableScroll = Math.max(0, scene.getBoundingClientRect().height - (window.innerHeight - inset));
  const offsetRatio = availableScroll === 0
    ? 0
    : Math.max(0, Math.min(1, (window.scrollY + inset - documentTop) / availableScroll));
  return {
    scope,
    interactionEpoch: readerPositionInteractionEpoch,
    turnWindowEpoch: storyTurnWindowEpoch,
    position: { turnId, turnNumber, offsetRatio }
  };
}

function persistReaderPosition() {
  const sample = captureReaderPosition();
  if (!sample) return;
  readerPositionWriteQueue = readerPositionWriteQueue
    .then(async () => {
      if (state.campaignId !== sample.scope.campaignId || state.user?.id !== sample.scope.userId
        || readerPositionInteractionEpoch !== sample.interactionEpoch
        || storyTurnWindowEpoch !== sample.turnWindowEpoch
        || readerPositionWorkflowOwnsScene()) return;
      const result = await readerPositionStore.write(sample.scope, sample.position);
      if (result === "saved" && state.campaignId === sample.scope.campaignId && state.user?.id === sample.scope.userId
        && readerPositionInteractionEpoch === sample.interactionEpoch
        && storyTurnWindowEpoch === sample.turnWindowEpoch
        && !readerPositionWorkflowOwnsScene()) {
        state.readerResumePosition = {
          schemaVersion: 1,
          ...sample.position,
          updatedAt: new Date().toISOString()
        };
        syncReaderResumePrompt();
      }
    })
    .then(() => undefined, () => undefined);
}

function scheduleReaderPositionSave() {
  if (readerPositionWriteTimer !== null) clearTimeout(readerPositionWriteTimer);
  readerPositionWriteTimer = setTimeout(() => {
    readerPositionWriteTimer = null;
    persistReaderPosition();
  }, 250);
}

function flushReaderPositionSave() {
  if (readerPositionWriteTimer !== null) {
    clearTimeout(readerPositionWriteTimer);
    readerPositionWriteTimer = null;
  }
  persistReaderPosition();
}

function noteReaderPositionIntent(event) {
  if (!event.isTrusted) return;
  if (event.target instanceof Element && event.target.closest("#btnResumeReading")) return;
  readerPositionInteractionEpoch += 1;
  retirePendingContinuousReaderRequest();
  if (readerPositionChoicePending) readerPositionChoicePending = false;

}

function restoreReaderSceneOffset(turnNumber, offsetRatio) {
  const scene = document.getElementById(`scene-${turnNumber}`);
  if (!scene) return;
  const ratio = Math.max(0, Math.min(1, offsetRatio));
  // Scrolling can move the toolbar from its normal position to its sticky inset.
  // Recalculate synchronously so later reader intent cannot be overwritten.
  for (let pass = 0; pass < 2; pass += 1) {
    const inset = readerStickyInset();
    const rect = scene.getBoundingClientRect();
    const availableScroll = Math.max(0, rect.height - (window.innerHeight - inset));
    const top = rect.top + window.scrollY + ratio * availableScroll - inset;
    window.scrollTo({ top: Math.max(0, top), behavior: "auto" });
  }
}

function modalFormSnapshot(dialog) {
  return [...dialog.querySelectorAll("input, select, textarea")]
    .filter((control) => !control.closest(".turn-history-tools"))
    .map((control) => {
      if (control instanceof HTMLInputElement && ["checkbox", "radio"].includes(control.type)) {
        return `${control.id}:${control.checked}`;
      }
      return `${control.id}:${control.value}`;
    }).join("\u001f");
}

function openManagedModal(dialog) {
  if (!dialog || dialog.open || typeof dialog.showModal !== "function") return;
  modalBaselines.set(dialog, modalFormSnapshot(dialog));
  dialog.showModal();
}

function clickedDialogBackdrop(dialog, event) {
  if (event.target !== dialog) return false;
  const bounds = dialog.getBoundingClientRect();
  return event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom;
}

function requestModalDismissal(dialog) {
  if (dialog.id === "campaignCastDialog") { castPanel?.requestClose(); return; }
  if (dialog.id === "userProfileDialog") {
    if (!userProfileSaving) dialog.close();
    return;
  }
  requestDiscardChanges(dialog, () => dialog.close());
}

function requestDiscardChanges(dialog, onDiscard) {
  if (modalBaselines.get(dialog) !== modalFormSnapshot(dialog)) {
    discardModalTarget = dialog;
    discardModalAction = onDiscard;
    openManagedModal($("discardChangesDialog"));
    return;
  }
  onDiscard();
}

function installClickAwayModalDismissal() {
  document.querySelectorAll("dialog").forEach((dialog) => {
    dialog.addEventListener("click", (event) => {
      if (dialog.open && clickedDialogBackdrop(dialog, event)) requestModalDismissal(dialog);
    });
    dialog.addEventListener("close", () => modalBaselines.delete(dialog));
  });
  const discardDialog = $("discardChangesDialog");
  discardDialog.addEventListener("close", () => {
    if (discardDialog.returnValue === "discard" && discardModalTarget?.open) discardModalAction?.();
    discardModalTarget = null;
    discardModalAction = null;
  });
}

installClickAwayModalDismissal();

// ── Toast & Notifications ─────────────────────────────────────
function toast(msg, duration) {
  const el = $("toast");
  if (!el) return;
  el.textContent = msg;
  el.classList.add("show");
  if (state.toastTimer) clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => el.classList.remove("show"), duration || TOAST_DURATION);
}

function setTurnHistoryLoadStatus(message, kind = "") {
  const status = $("turnHistoryLoadStatus");
  if (!status) return;
  status.textContent = message;
  status.classList.toggle("hidden", !message);
  status.classList.toggle("loading", kind === "loading");
  status.classList.toggle("error", kind === "error");
}

function showStoryLoadRecovery(error) {
  const panel = $("storyLoadRecovery");
  const title = $("storyLoadRecoveryTitle");
  const message = $("storyLoadRecoveryMessage");
  const retry = $("storyLoadRetry");
  if (!panel || !title || !message || !retry) return;
  const statusCode = Number.isInteger(error?.statusCode) ? error.statusCode : null;
  if (statusCode === 404) {
    title.textContent = "Campaign not found";
    message.textContent = "This campaign could not be found. Return to Campaigns to choose an available story.";
    retry.hidden = true;
    retry.classList.add("hidden");
  } else if (statusCode === 403) {
    title.textContent = "Campaign access unavailable";
    message.textContent = "You don't have access to this campaign. Return to Campaigns to choose a story available to you.";
    retry.hidden = true;
    retry.classList.add("hidden");
  } else {
    title.textContent = "Story unavailable";
    message.textContent = "The story could not be loaded. Check your connection and try again.";
    const retryable = statusCode === null || statusCode === 408 || statusCode === 425 || statusCode === 429 || statusCode >= 500;
    retry.hidden = !retryable;
    retry.classList.toggle("hidden", !retryable);
  }
  panel.classList.remove("hidden");
}

function clearStoryLoadRecovery() {
  $("storyLoadRecovery")?.classList.add("hidden");
}

function ensureCompleteTurnHistory() {
  if (!state.historyNextCursor) return Promise.resolve(state.turns);
  if (completeHistoryLoad?.campaignId === state.campaignId
    && completeHistoryLoad.epoch === storyTurnWindowEpoch) return completeHistoryLoad.promise;

  const campaignId = state.campaignId;
  const epoch = storyTurnWindowEpoch;
  const request = { campaignId, epoch, promise: null };
  const requestIsCurrent = () => state.campaignId === campaignId
    && storyTurnWindowEpoch === epoch
    && completeHistoryLoad === request;
  request.promise = loadCompleteStoryHistory({
    campaignId,
    turns: state.turns,
    nextCursor: state.historyNextCursor,
    fetchPage: ({ before, limit }) => apiClient.campaigns.turns(campaignId, { before, limit }),
    onProgress: ({ loadedTurnCount }) => {
      if (requestIsCurrent()) {
        setTurnHistoryLoadStatus(`Loading earlier turns… ${loadedTurnCount} loaded`, "loading");
      }
    }
  }).then(
    (result) => {
      if (!requestIsCurrent()) throw completeHistorySupersededError();
      publishStoryTurnWindow(result.turns, null, { completeHistoryRequest: request });
      setTurnHistoryLoadStatus(`All ${result.turns.length} turns loaded.`);
      if (state.user?.settings?.continuousReading) renderAllScenes({ autoScroll: false });
      return state.turns;
    },
    (error) => {
      if (!requestIsCurrent()) throw completeHistorySupersededError();
      throw error;
    }
  ).finally(() => {
    if (completeHistoryLoad === request) completeHistoryLoad = null;
  });
  completeHistoryLoad = request;
  return request.promise;
}

function showBusy(msg) {
  state.busy = true;
  const el = $("llmWaitIndicator");
  const text = $("llmWaitIndicatorText");
  if (text) text.textContent = msg || "Working…";
  if (el) el.classList.add("show");
  const pill = $("busyPill");
  if (pill) { pill.textContent = "Busy"; pill.classList.add("busy"); }
  syncInputState();
}

function hideBusy() {
  state.busy = false;
  const el = $("llmWaitIndicator");
  if (el) el.classList.remove("show");
  const pill = $("busyPill");
  if (pill) { pill.textContent = "Ready"; pill.classList.remove("busy"); }
  syncInputState();
}

function syncInputState() {
  const btnAction = $("btnTakeAction");
  const freeAction = $("freeAction");
  // A generic recoverable job may retain a draft while its explicit retry or
  // discard action is pending. A typed saved review is different: its choices
  // must block every competing generation path until it is resolved.
  const generationLocked = state.busy || !state.campaignLoaded || Boolean(state.pendingGeneration) || Boolean(state.generationReview?.summary);
  const recoveryPanel = $("generationRecoveryPanel");
  const recoveryVisible = Boolean(recoveryPanel && !recoveryPanel.classList.contains("hidden"));
  const editStateLocked = generationLocked || recoveryVisible || Boolean(state.editStateSession?.saving);
  const editStateButton = $("btnOpenEditState");
  if (editStateButton) editStateButton.disabled = editStateLocked;
  const editCharacterProfileLocked = generationLocked || recoveryVisible || Boolean(state.characterProfileEditSession?.saving);
  const editCharacterProfileButton = $("btnOpenEditCharacterProfile");
  if (editCharacterProfileButton) editCharacterProfileButton.disabled = editCharacterProfileLocked;
  const editResponseButton = $("btnOpenEditResponse");
  if (editResponseButton) {
    editResponseButton.disabled = !canEditCurrentResponse()
      || Boolean(state.responseEditSession?.loading)
      || Boolean(state.responseEditSession?.saving);
  }
  if (state.editStateSession) {
    document.querySelectorAll("#editStateDialog textarea, #editStateDialog button").forEach(control => {
      control.disabled = editStateLocked;
    });
  }
  if (state.characterProfileEditSession) {
    document.querySelectorAll("#editCharacterProfileDialog input, #editCharacterProfileDialog textarea, #editCharacterProfileDialog button").forEach(control => {
      control.disabled = editCharacterProfileLocked;
    });
  }
  const turnCount = state.turns ? state.turns.length : 0;
  const curr = viewedTurnIndex();
  const isLatest = isViewingLatestTurn();
  const storyInputLocked = generationLocked || !isLatest;
  if (btnAction) btnAction.disabled = storyInputLocked;
  if (freeAction) freeAction.disabled = storyInputLocked;
  const storyLengthOverride = $("turnStoryLengthProfileOverride");
  if (storyLengthOverride) storyLengthOverride.disabled = storyInputLocked;
  const canChooseTurnMode = campaignTurnControlStyle() === "flexible_action" && !storyInputLocked;
  document.querySelectorAll("[data-turn-input-mode]").forEach((input) => { input.disabled = !canChooseTurnMode; });
  document.querySelectorAll("#choiceArea .choice").forEach(b => { b.disabled = storyInputLocked; });
  syncClearTurnInputButton();

  const btnPrev = $("btnPrev");
  const btnNext = $("btnNext");
  const btnReaderJumpLatest = $("btnReaderJumpLatest");
  const btnUndo = $("btnUndo");
  const btnRetry = $("btnRetry");

  const lastTurnHasAction = turnCount > 0 && Boolean(state.turns[turnCount - 1] && state.turns[turnCount - 1].action);

  const previousDisabled = generationLocked || turnCount === 0 || Boolean(state.readerPinnedTurn) || (curr <= 0 && !state.historyNextCursor);
  const nextDisabled = generationLocked || turnCount === 0 || isLatest;
  if (btnPrev) {
    btnPrev.disabled = previousDisabled;
    btnPrev.title = generationLocked ? "Turn navigation is unavailable while generation is active."
      : turnCount === 0 ? "There are no accepted turns yet."
        : previousDisabled ? "You are at the earliest available turn." : "Previous turn";
  }
  if (btnNext) {
    btnNext.disabled = nextDisabled;
    btnNext.title = generationLocked ? "Turn navigation is unavailable while generation is active."
      : turnCount === 0 ? "There are no accepted turns yet."
        : isLatest ? "You are already at the latest turn." : "Next turn";
  }
  if (btnReaderJumpLatest) {
    btnReaderJumpLatest.disabled = generationLocked || turnCount === 0 || isLatest;
    btnReaderJumpLatest.title = generationLocked ? "Turn navigation is unavailable while generation is active."
      : turnCount === 0 ? "There are no accepted turns yet."
        : isLatest ? "You are already at the latest turn." : "Jump to the latest turn";
  }
  if (btnUndo) btnUndo.disabled = generationLocked || turnCount === 0 || !isLatest;
  if (btnRetry) btnRetry.disabled = generationLocked || turnCount === 0 || !isLatest || !lastTurnHasAction;
  syncResponseEditorControls();
}

// ── Activity Log ──────────────────────────────────────────────
function recordActivity(category, title, detail) {
  state.activityLog.push({
    ts: new Date().toISOString(),
    category: category || "system",
    title: title || "",
    detail: detail || ""
  });
}

function renderActivityLog() {
  const list = $("activityLogList");
  if (!list) return;
  if (state.activityLog.length === 0) {
    list.innerHTML = `<div class="activity-log-empty">No activity recorded this session.</div>`;
    return;
  }
  list.innerHTML = state.activityLog.map((entry, i) => {
    const cls = entry.category === "error" ? "error" : entry.category === "success" ? "success" : "";
    return `<details class="activity-log-entry ${cls}">
      <summary>
        <span class="activity-log-time">${entry.ts.slice(11, 19)}</span>
        <span class="activity-log-category">${escapeHtml(entry.category)}</span>
        <span class="activity-log-title">${escapeHtml(entry.title)}</span>
        <span class="activity-log-operation">#${i + 1}</span>
      </summary>
      <div class="activity-log-details"><pre>${escapeHtml(entry.detail)}</pre></div>
    </details>`;
  }).reverse().join("");
}

function copyActivityDiagnostics() {
  const text = state.activityLog.map(e => `[${e.ts}] [${e.category}] ${e.title}\n${e.detail}`).join("\n\n");
  navigator.clipboard.writeText(text).then(() => toast("Diagnostics copied to clipboard."));
}

// ── Onboarding ────────────────────────────────────────────────
async function checkOnboarding() {
  try {
    const data = await apiClient.providers.list();
    state.providers = data.providers || [];
    const hasText = state.providers.some(p => p.providerRole === "text" || !p.providerRole);
    if (!hasText) {
      const dlg = $("gettingStartedDialog");
      openManagedModal(dlg);
    }
  } catch (err) {
    recordActivity("error", "Failed to load providers", err.message);
  }
}

// ── Campaign Loading ──────────────────────────────────────────
let readerIllustrationRequestSequence = 0;

async function loadReaderIllustrations(campaignId, loadEpoch) {
  const windowEpoch = storyTurnWindowEpoch;
  const requestSequence = ++readerIllustrationRequestSequence;
  const current = () => state.campaignId === campaignId
    && campaignLoadSequence === loadEpoch
    && storyTurnWindowEpoch === windowEpoch
    && readerIllustrationRequestSequence === requestSequence;
  if (!current()) return false;
  state.illustrationLoading = true;
  renderStoryIllustration();
  let loaded = false;
  try {
    const [config, segmentData] = await Promise.all([
      illustrationApi.config(campaignId), illustrationApi.segments(campaignId)
    ]);
    if (!current()) return false;
    state.illustrationConfig = config;
    state.illustrationSegments = segmentData.segments || [];
    state.illustrationError = null;
    loaded = true;
  } catch (error) {
    if (!current()) return false;
    state.illustrationError = illustrationLoadError(error);
  } finally {
    if (current()) {
      state.illustrationLoading = false;
      renderStoryIllustration();
    }
  }
  if (loaded && current() && illustrationsEnabled()) void pollImageJobs({ initialSegments: state.illustrationSegments });
  return loaded;
}

async function loadCampaign(campaignId, options = {}) {
  const loadSequence = ++campaignLoadSequence;
  const loadEpoch = ++storyTurnWindowEpoch;
  const positionInteractionEpoch = readerPositionInteractionEpoch;
  readerIllustrationRequestSequence += 1;
  state.illustrationLoading = false;
  state.imagePollEpoch += 1;
  if (activeImagePoll) activeImagePoll.stopped = true;
  activeImagePoll = null;
  if (state.imagePollTimer) clearTimeout(state.imagePollTimer);
  state.imagePollTimer = null;

  continuousReaderAbortController?.abort();
  continuousReaderAbortController = null;
  state.continuousReader = null;

  readerPositionLoadEpoch += 1;
  readerPositionChoicePending = true;
  state.readerPinnedTurn = null;
  state.readerResumePosition = null;
  hideReaderResumePrompt();
  showReaderPositionNotice("");
  if (state.campaignId !== campaignId) {
    state.retainedAppendDraft = null;
    state.illustrationConfig = null;
    state.illustrationSegments = [];
    state.illustrationError = null;
    state.campaign = null;
    state.world = null;
    state.playerConfig = null;
    state.runtimeState = null;
    state.campaignLoaded = false;
    state.turns = [];
    const storyArea = $("storyArea");
    if (storyArea) storyArea.replaceChildren();
  }
  clearResponseEditSession();
  resetGenerationStateForCampaignLoad();
  state.campaignId = campaignId;
  resetStoryHistorySearchForCurrentScope();
  state.campaignLoaded = false;
  clearStoryLoadRecovery();
  setStorySyncStatus("Story loading");
  state.storyMemorySettings = null;
  renderStoryMemorySettings(null, "Loading the saved Story Memory level for this campaign.");
  completeHistoryLoad = null;
  setTurnHistoryLoadStatus("");
  showBusy("Loading campaign…");
  try {
    const syncData = await apiClient.generation.syncStatus(campaignId);
    const turnData = syncData.turns || await apiClient.campaigns.turns(campaignId);
    if (campaignLoadSequence !== loadSequence || state.campaignId !== campaignId || storyTurnWindowEpoch !== loadEpoch) return;

    setTurnHistoryLoadStatus("");
    state.campaign = syncData.campaign || syncData;
    state.world = syncData.world || state.campaign.world || null;
    state.playerConfig = syncData.playerConfig || state.campaign.playerConfig || null;
    state.pendingGeneration = syncData.pendingGeneration || null;
    state.generationRecovery = syncData.generationRecovery || null;
    captureHydratedAppendDraft(syncData);
    syncTurnInputModeFromCampaign();

    publishStoryTurnWindow(turnData.turns || [], turnData.nextCursor || null);
    void loadStoryMemorySettings(campaignId, storyTurnWindowEpoch);
    const coreWindowEpoch = storyTurnWindowEpoch;
    const current = () => campaignLoadSequence === loadSequence && state.campaignId === campaignId
      && storyTurnWindowEpoch === coreWindowEpoch;
    const runtimeState = await apiClient.campaigns.state(campaignId);
    if (!current()) return false;
    state.runtimeState = runtimeState;
    markEditStateStaleForCurrentRuntimeState(runtimeState);

    // Set title
    const titleEl = $("storyTitle");
    const name = state.campaign.title || state.world?.title || "Untitled Campaign";
    if (titleEl) titleEl.textContent = name;
    document.title = `${name} — Infinite Quest`;

    state.viewTurnNumber = null;
    if (state.user?.settings?.continuousReading) initializeContinuousReader();
    renderAllScenes({ autoScroll: options.autoScroll });
    updateStatusBar();

    renderTurnInput();

    recordActivity("system", "Campaign loaded", `${state.turns.length} turns loaded for "${name}".`);
    state.campaignLoaded = true;
    setStorySyncStatus("Story synced");
    syncContinuousReaderControls();
    void offerSavedReaderPosition(campaignId, loadSequence, positionInteractionEpoch);
    if (!state.pendingGeneration && (state.generationRecovery?.status === "recoverable" || state.generationRecovery?.status === "failed")) {
      const guidance = generationRecoveryGuidance(state.generationRecovery.diagnostic);
      const presentation = generationDiagnosticPresentation(state.generationRecovery.diagnostic);
      showGenerationRecovery(
        state.generationRecovery.id,
        guidance?.message || "This durable generation needs your direction.",
        "generation",
        guidance,
        presentation
      );
      await loadGenerationReview();
      if (!current()) return false;
      showGenerationRecovery(
        state.generationRecovery.id,
        state.generationReview?.summary ? "This turn needs your review" : (guidance?.message || "This durable generation needs your direction."),
        "generation",
        guidance,
        presentation
      );
      if (state.generationRecovery.status === "failed") restoreRetainedAppendDraft();
    }
    await restoreActionDraftForCampaign(campaignId, loadSequence);
    if (!current()) return false;
    void loadReaderIllustrations(campaignId, loadSequence);
    try {
      localStorage.setItem("infiniteQuestLastCampaignId", campaignId);
    } catch {
      // The campaign remains usable when browser preference storage is unavailable.
    }
    return true;
  } catch (err) {
    if (campaignLoadSequence !== loadSequence || state.campaignId !== campaignId) return false;
    state.campaign = null;
    state.world = null;
    state.playerConfig = null;
    state.runtimeState = null;
    state.campaignLoaded = false;
    state.turns = [];
    state.continuousReader = null;
    state.pendingGeneration = null;
    state.generationRecovery = null;
    state.generationReview = null;
    state.illustrationConfig = null;
    state.illustrationSegments = [];
    state.illustrationError = null;
    setStorySyncStatus("Story sync unavailable");
    const title = $("storyTitle");
    if (title) title.textContent = "Story unavailable";
    document.title = "Story unavailable — Infinite Quest";
    renderAllScenes({ autoScroll: false });
    showStoryLoadRecovery(err);
    recordActivity("error", "Campaign load failed", err.message);
    return false;
  } finally {
    if (campaignLoadSequence === loadSequence && state.campaignId === campaignId) hideBusy();
  }
}

function firstActionForNewAdventure() {
  return String(state.world?.firstAction || "").trim() || "Begin the adventure.";
}

async function showBackgroundStoryBeforeStart() {
  const background = String(state.world?.backgroundStory || "").trim();
  if (!background) return false;
  const dialog = $("messagePopupDialog");
  const titleEl = $("messagePopupTitle");
  const bodyEl = $("messagePopupBody");
  if (!dialog || !titleEl || !bodyEl || typeof dialog.showModal !== "function") {
    return false;
  }
  try {
    if (dialog.open) dialog.close();
  } catch (_) {}
  return new Promise((resolve) => {
    const done = () => {
      dialog.removeEventListener("close", done);
      resolve(true);
    };
    titleEl.textContent = "Background Story";
    bodyEl.textContent = background;
    dialog.addEventListener("close", done, { once: true });
    try {
      openManagedModal(dialog);
    } catch (err) {
      dialog.removeEventListener("close", done);
      resolve(false);
    }
  });
}

async function startAdventure(options = {}) {
  if (state.busy || !state.campaignLoaded) return;
  await showBackgroundStoryBeforeStart();
  const inputMode = defaultTurnInputMode();
  await runGeneration(firstActionForNewAdventure(), {
    requestedInputMode: inputMode,
    resolvedInputMode: inputMode,
    inputModeSource: "opening_action"
  });
}


// ── Cost Formatting ───────────────────────────────────────────
function formatReportedCost(cost) {
  if (!cost || typeof cost !== "object") return "";
  const amount = Number(cost.amount);
  const currency = String(cost.currency || "").toUpperCase();
  if (!Number.isFinite(amount) || amount < 0 || !/^[A-Z]{3}$/.test(currency)) return "";
  if (amount > 0 && amount < 0.0001) return `<${new Intl.NumberFormat(undefined, { style: "currency", currency, minimumFractionDigits: 4, maximumFractionDigits: 4 }).format(0.0001)}`;
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency,
    minimumFractionDigits: 4,
    maximumFractionDigits: 4
  }).format(amount);
}

function reportedCostTooltip(cost) {
  const labels = { story: "Story", image: "Images", memory: "Semantic retrieval" };
  const details = Object.entries(cost?.byCategory || {})
    .filter(([, amount]) => Number(amount) > 0)
    .map(([category, amount]) => `${labels[category] || category}: ${formatReportedCost({ amount, currency: cost.currency })}`);
  return [`Provider-reported generation cost: ${formatReportedCost(cost)}`, ...details].join(" · ");
}

// ── Scene Rendering ───────────────────────────────────────────
function renderScene(turn, index) {
  const sceneDiv = document.createElement("div");
  sceneDiv.className = "scene";
  sceneDiv.id = `scene-${turn.turnNumber}`;
  sceneDiv.dataset.turnNumber = turn.turnNumber;
  sceneDiv.dataset.turnId = turn.id || turn.turnId || "";

  // Narration column
  let narrationHtml = "";

  // Action tag (what the player did)
  const isPendingReplacement = index === state.turns.length - 1
    && state.pendingGeneration?.operationKind === "replace_latest";
  if (isPendingReplacement) {
    narrationHtml += `<div class="replacement-pending-banner" role="status">
      <strong>Replacement in progress</strong>
      <span>The accepted turn is preserved until its replacement is validated.</span>
    </div>`;
  }

  if (turn.action) {
    const reportedCost = formatReportedCost(turn.reportedCost);
    const reportedCostHtml = reportedCost
      ? `<span class="pill turn-cost-pill" title="${escapeHtml(reportedCostTooltip(turn.reportedCost))}">${escapeHtml(reportedCost)}</span>`
      : "";

    narrationHtml += `<div class="turn-meta">
      <details class="previous-action-disclosure">
        <summary>Previous action · Turn ${escapeHtml(turn.turnNumber)}</summary>
        <div class="action-tag">➜ ${escapeHtml(turn.action)}</div>
      </details>
      <span class="pill">Turn ${turn.turnNumber}</span>
      ${reportedCostHtml}
    </div>`;
  }

  // RPG roll results
  if (turn.roll || turn.mechanics?.roll) {
    const roll = turn.roll || turn.mechanics.roll;
    const passed = roll.passed !== undefined ? roll.passed : (roll.roll <= roll.target);
    narrationHtml += `<details class="roll-disclosure">
      <summary>🎲 ${escapeHtml(roll.statName || roll.stat_id || "Check")} — d100: ${roll.roll} vs ${roll.target} — ${passed ? "✓ Success" : "✗ Setback"}</summary>
      <div class="roll-disclosure-body">
        <div class="roll-card ${passed ? "success" : "failure"}">
          <strong class="${passed ? "success-text" : "failure-text"}">${passed ? "Favorable Outcome" : "Setback"}</strong>
          <p>${escapeHtml(passed ? (roll.favorableOutcome || roll.favorable_outcome || "") : (roll.setbackOutcome || roll.setback_outcome || ""))}</p>
          ${roll.rationale ? `<p class="mini dim">${escapeHtml(roll.rationale)}</p>` : ""}
        </div>
      </div>
    </details>`;
  }

  // Before-event trigger text
  if (turn.mechanics?.beforeEvents?.length) {
    turn.mechanics.beforeEvents.forEach(evt => {
      narrationHtml += `<div class="action-tag action-tag-event">⚡ ${escapeHtml(evt.name || evt.label || "Event")} — ${escapeHtml(evt.text || evt.effect || "")}</div>`;
    });
  }

  // Narration text
  if (turn.narration) {
    const turnId = turn.id || turn.turnId || "";
    const segments = state.illustrationSegments
      .filter((segment) => segment.turnId === turnId)
      .sort((left, right) => left.ordinal - right.ordinal);
    const segmentsMatchNarration = segmentProseMatchesNarration(segments, turn.narration);
    narrationHtml += segments.length && illustrationsEnabled() && segmentsMatchNarration
      ? `<div class="narration segmented-narration">${segments.map((segment) => `
          <section class="narration-segment" data-illustration-segment-id="${escapeHtml(segment.id)}"
            data-turn-id="${escapeHtml(turnId)}" aria-label="Illustration segment ${segment.ordinal + 1}">
            <div class="narration-segment-copy">${sanitizeNarration(segment.text)}</div>
            <aside class="segment-illustration-slot" aria-label="Illustration for segment ${segment.ordinal + 1}">
              <div class="segment-illustration-sticky">
                <div class="story-illustration-heading">
                  <span>Illustration</span>
                  <span class="pill">Turn ${turn.turnNumber}</span>
                </div>
                <div class="segment-illustration-content" data-segment-id="${escapeHtml(segment.id)}">
                  ${segmentIllustrationMarkup(turn, index, segment, segments.length)}
                </div>
              </div>
            </aside>
          </section>`).join("")}</div>`
      : `<div class="narration">${sanitizeNarration(turn.narration)}</div>`;
  }

  // After-event trigger text
  if (turn.mechanics?.afterEvents?.length) {
    turn.mechanics.afterEvents.forEach(evt => {
      narrationHtml += `<div class="action-tag action-tag-event">⚡ ${escapeHtml(evt.name || evt.label || "Event")} — ${escapeHtml(evt.text || evt.effect || "")}</div>`;
    });
  }

  sceneDiv.innerHTML = `<div class="scene-narration">${narrationHtml}</div>`;
  continuousSceneSignatures.set(sceneDiv, JSON.stringify(turn));
  return sceneDiv;
}

function currentViewTurnNumber() {
  return state.viewTurnNumber || latestTurnNumber(state.turns);
}

function viewedTurnIndex() {
  if (state.viewTurnNumber) return turnIndexForNumber(state.turns, state.viewTurnNumber);
  return turnIndexForNumber(state.turns, currentViewTurnNumber());
}

function isViewingLatestTurn() {
  return currentViewTurnNumber() === latestTurnNumber(state.turns);
}

function normalizeNarrationWhitespace(text) {
  return String(text || "").replace(/\s+/gu, " ").trim();
}

function segmentProseMatchesNarration(segments, narration) {
  return segments.length > 0
    && normalizeNarrationWhitespace(segments.map((segment) => segment.text).join(" "))
      === normalizeNarrationWhitespace(narration);
}

function latestCompletedResponseTurn() {
  const turnNumber = latestTurnNumber(state.turns);
  const turnIndex = turnIndexForNumber(state.turns, turnNumber);
  const turn = state.turns[turnIndex];
  if (!turn?.id || !Number.isInteger(Number(turn.turnNumber))) return null;
  if (Number(turn.turnNumber) !== Number(state.campaign?.activeTurnNumber)) return null;
  return turn;
}

function responseGenerationIsActive() {
  const recoveryPanel = $("generationRecoveryPanel");
  return state.busy
    || Boolean(state.pendingGeneration)
    || state.generationDisplayActive
    || Boolean(state.generationRecoveryKind)
    || Boolean(recoveryPanel && !recoveryPanel.classList.contains("hidden"));
}

function canEditCurrentResponse() {
  return Boolean(state.campaignId)
    && isViewingLatestTurn()
    && Boolean(latestCompletedResponseTurn())
    && !responseGenerationIsActive();
}

function responseEditSessionIsCurrent(session) {
  const turn = latestCompletedResponseTurn();
  return state.responseEditSession === session
    && state.campaignId === session.campaignId
    && currentViewTurnNumber() === session.viewTurnNumber
    && Number(state.campaign?.activeTurnNumber) === session.expectedActiveTurnNumber
    && turn?.id === session.turnId
    && Number(turn?.turnNumber) === session.turnNumber;
}

function clearResponseEditSession(session = null) {
  if (session && state.responseEditSession !== session) return;
  state.responseEditSession = null;
  syncInputState();
}

function syncResponseEditorControls() {
  const session = state.responseEditSession;
  const editor = $("responseEditor");
  const saveButton = $("btnEditResponseSave");
  if (!saveButton) return;
  const draft = String(editor?.value || "").trim();
  const original = String(session?.effectiveNarration || "").trim();
  saveButton.disabled = !session
    || Boolean(session.loading)
    || Boolean(session.saving)
    || !draft
    || draft === original;
}

async function openCurrentResponseEditor() {
  const dialog = $("editResponseDialog");
  const editor = $("responseEditor");
  const turn = latestCompletedResponseTurn();
  if (!dialog || !editor || !canEditCurrentResponse() || !turn) return;

  const session = {
    id: ++nextResponseEditSessionId,
    campaignId: state.campaignId,
    turnId: turn.id,
    turnNumber: Number(turn.turnNumber),
    viewTurnNumber: currentViewTurnNumber(),
    expectedActiveTurnNumber: Number(state.campaign?.activeTurnNumber),
    correctionRevision: null,
    effectiveNarration: "",
    loading: true,
    saving: false
  };
  state.responseEditSession = session;
  syncInputState();
  try {
    const correction = await apiClient.campaigns.getTurnCorrection(session.campaignId, session.turnId);
    if (!responseEditSessionIsCurrent(session) || responseGenerationIsActive()) {
      clearResponseEditSession(session);
      return;
    }
    session.correctionRevision = Number(correction.correctionRevision || 0);
    session.effectiveNarration = String(correction.effectiveNarration || "");
    session.loading = false;
    editor.value = session.effectiveNarration;
    openManagedModal(dialog);
  } catch (error) {
    if (state.responseEditSession === session) {
      toast(`Response could not be loaded: ${error.message}`);
      clearResponseEditSession();
    }
    return;
  }
  syncInputState();
}

async function saveCurrentResponseCorrection() {
  const dialog = $("editResponseDialog");
  const editor = $("responseEditor");
  const session = state.responseEditSession;
  if (!dialog || !editor || !session || session.loading || session.saving) return;
  const narration = editor.value.trim();
  if (!narration) {
    toast("Enter narration before saving a correction.");
    syncResponseEditorControls();
    return;
  }
  if (narration === session.effectiveNarration.trim()) {
    toast("Change the narration before saving a correction.");
    syncResponseEditorControls();
    return;
  }
  if (!responseEditSessionIsCurrent(session) || responseGenerationIsActive()) {
    toast("The current response changed. Reopen the editor before saving.");
    return;
  }

  session.saving = true;
  syncInputState();
  showBusy("Saving corrected narration…");
  try {
    const correction = await apiClient.campaigns.correctTurnNarration(session.campaignId, session.turnId, {
      narration,
      expectedCorrectionRevision: session.correctionRevision,
      expectedActiveTurnNumber: session.expectedActiveTurnNumber,
      source: "user_edit"
    });
    if (!responseEditSessionIsCurrent(session)) return;
    const turn = latestCompletedResponseTurn();
    if (!turn) return;
    turn.narration = correction.effectiveNarration;
    if (state.continuousReader) {
      state.continuousReader = reconcileStoryAcceptedSceneReplacement(state.continuousReader, turn);
    }
    renderAllScenes();
    if (dialog.close) dialog.close();
    clearResponseEditSession();
    toast(correction.illustrationsMayBeStale
      ? "Narration corrected. Existing illustrations may no longer match."
      : "Narration corrected and Chronicle memory rebuilt.");
  } catch (error) {
    if (state.responseEditSession === session) {
      toast(`Correction failed: ${error.message}`);
    }
  } finally {
    session.saving = false;
    hideBusy();
    if (state.responseEditSession === session) syncInputState();
  }
}

function illustrationsEnabled() {
  return Boolean(state.illustrationConfig?.enabled)
    && state.illustrationConfig?.sourcePolicy !== "off";
}

function illustrationSegmentsForTurn(turnId) {
  return state.illustrationSegments
    .filter((segment) => segment.turnId === turnId)
    .sort((left, right) => left.ordinal - right.ordinal);
}

function segmentStatusLabel(segment) {
  if (!segment) return "";
  if (segment.promptJobStatus === "refining") return "Refining illustration prompt…";
  if (segment.promptSource === "ai_fallback" && !segment.variants?.length) return "Prompt refinement fell back to accepted segment text.";
  if (segment.imageJobStatus === "recoverable" || segment.imageJobStatus === "failed") {
    return segment.errorMessage || "Illustration generation needs attention.";
  }
  if (["queued", "generating", "provider_pending", "downloading"].includes(segment.imageJobStatus)) {
    const progress = Number(segment.providerProgress);
    return `Creating illustration${Number.isFinite(progress) ? ` · ${Math.round(progress)}%` : ""}`;
  }
  if (segment.status === "refining") return "Waiting for prompt refinement…";
  if (!segment.variants?.length) return "Illustration is queued for this segment.";
  return "";
}

function segmentIllustrationMarkup(turn, turnIndex, segment, segmentCount) {
  const turnId = turn.id || turn.turnId || "";
  const variants = Array.isArray(segment.variants) ? segment.variants : [];
  const selectedIndex = Math.min(state.illustrationVariantIndexes.get(segment.id) || 0, Math.max(variants.length - 1, 0));
  const selected = variants[selectedIndex];
  const selectedVariantIndex = selected?.variantIndex ?? selectedIndex;
  const status = segmentStatusLabel(segment);
  const isCurrentTurn = Number(turn.turnNumber) === Number(state.campaign?.activeTurnNumber);
  return `<div class="segment-illustration-card">
    <div class="image-wrap${selected ? "" : " image-job-placeholder"}">
    ${selected
      ? `<img src="${escapeHtml(selected.url)}" alt="Illustration ${selectedIndex + 1} for turn ${turn.turnNumber}, segment ${segment.ordinal + 1}" loading="lazy" />`
      : `<div class="image-placeholder">${escapeHtml(status || "No illustration is available for this segment yet.")}</div>`}
    ${variants.length > 1 ? `<div class="illustration-carousel" aria-label="Illustration variants">
      <button class="small ghost" type="button" data-action="previous-segment-image" data-segment-id="${escapeHtml(segment.id)}" aria-label="Previous illustration">←</button>
      <span>${selectedIndex + 1} / ${variants.length}</span>
      <button class="small ghost" type="button" data-action="next-segment-image" data-segment-id="${escapeHtml(segment.id)}" aria-label="Next illustration">→</button>
    </div>` : ""}
    ${status && selected ? `<div class="image-job-status image-job-overlay"><p>${escapeHtml(status)}</p></div>` : ""}
    <div class="segment-illustration-meta">
      <span>Segment ${segment.ordinal + 1} of ${segmentCount}</span>
      <span>${segment.endWord - segment.startWord} words</span>
      ${segment.promptSource === "ai_fallback" ? "<span>Direct fallback</span>" : ""}
    </div>
    </div>
    ${isCurrentTurn ? `<div class="segment-image-controls" aria-label="Controls for this current-turn illustration">
      <button class="small ghost segment-image-icon" type="button" data-action="edit-segment-image-prompt"
        data-segment-id="${escapeHtml(segment.id)}" data-variant-index="${selectedVariantIndex}"
        title="Preview or edit this image prompt" aria-label="Preview or edit this image prompt">✏️</button>
      <button class="small ghost segment-image-icon" type="button" data-action="regenerate-segment-image"
        data-segment-id="${escapeHtml(segment.id)}" data-variant-index="${selectedVariantIndex}"
        title="Regenerate only this image" aria-label="Regenerate only this image">🖼️</button>
      <button class="small ghost segment-image-icon" type="button" data-action="why-segment-image"
        data-segment-id="${escapeHtml(segment.id)}" data-variant-index="${selectedVariantIndex}"
        title="Why this image?" aria-label="Why this image?">?</button>
    </div>` : `<div class="segment-history-image-controls">
      <button class="small ghost" type="button" data-turn-id="${escapeHtml(turnId)}"
        data-action="rebuild-turn-segments">Rebuild this past turn</button>
    </div>`}
  </div>`;
}

function renderStoryIllustration({ skipIfUnchanged = false } = {}) {
  const layout = $("appLayout");
  const panel = $("storyIllustrationPanel");
  const content = $("storyIllustrationContent");
  const turnLabel = $("storyIllustrationTurn");
  const turnIndex = viewedTurnIndex();
  const turn = state.turns[turnIndex];
  const visible = (illustrationsEnabled() || state.illustrationError) && !state.generationDisplayActive && Boolean(turn);
  if (!layout || !panel || !content) return;
  panel.setAttribute("aria-busy", String(state.illustrationLoading));

  const inlineContents = [...document.querySelectorAll(".segment-illustration-content[data-segment-id]")];
  inlineContents.forEach((segmentContent) => {
    const segment = state.illustrationSegments.find((item) => item.id === segmentContent.dataset.segmentId);
    if (!segment) return;
    const segmentTurnIndex = state.turns.findIndex((item) => (item.id || item.turnId) === segment.turnId);
    const segmentTurn = state.turns[segmentTurnIndex];
    if (!segmentTurn) return;
    const signature = JSON.stringify([
      segmentTurn,
      segment,
      illustrationSegmentsForTurn(segment.turnId).length,
      state.illustrationVariantIndexes.get(segment.id) || 0
    ]);
    if (skipIfUnchanged && inlineIllustrationRenderSignatures.get(segmentContent) === signature) return;
    segmentContent.innerHTML = segmentIllustrationMarkup(
      segmentTurn,
      segmentTurnIndex,
      segment,
      illustrationSegmentsForTurn(segment.turnId).length
    );
    inlineIllustrationRenderSignatures.set(segmentContent, signature);
  });

  const inlineVisible = visible && inlineContents.length > 0 && !state.illustrationError;
  const panelVisible = visible && !inlineVisible;
  const signature = JSON.stringify([
    state.campaignId,
    turn?.id || turn?.turnId || null,
    turn?.turnNumber ?? null,
    turn?.narration ?? null,
    state.illustrationConfig,
    state.illustrationSegments,
    [...state.illustrationVariantIndexes],
    state.illustrationLoading,
    state.illustrationError,
    state.generationDisplayActive
  ]);
  layout.classList.toggle("has-illustration", panelVisible);
  layout.classList.toggle("has-segmented-illustrations", inlineVisible);
  panel.classList.toggle("hidden", !panelVisible);
  if (skipIfUnchanged && illustrationRenderSignatures.get(content) === signature) return;
  if (!visible) {
    content.replaceChildren();
    illustrationRenderSignatures.set(content, signature);
    return;
  }
  if (inlineVisible) {
    content.replaceChildren();
    illustrationRenderSignatures.set(content, signature);
    return;
  }

  if (turnLabel) turnLabel.textContent = `Turn ${turn.turnNumber}`;
  const turnId = turn.id || turn.turnId || "";
  const segments = illustrationSegmentsForTurn(turnId);
  const statusMarkup = `${state.illustrationLoading ? `<p role="status">Loading optional illustrations…</p>` : state.illustrationError ? `<p role="status">${escapeHtml(state.illustrationError)}</p>` : ""}
    <button class="small ghost" type="button" data-action="refresh-illustrations"${state.illustrationLoading ? " disabled" : ""}>Refresh illustrations</button>`;
  if (segments.length) {
    const narrationIsStale = !segmentProseMatchesNarration(segments, turn.narration);
    content.innerHTML = `${statusMarkup}${narrationIsStale
      ? `<p class="mini dim">The narration was corrected; existing illustrations may no longer match.</p>`
      : ""}${segments.map((segment) => segmentIllustrationMarkup(turn, turnIndex, segment, segments.length)).join("")}`;
    illustrationRenderSignatures.set(content, signature);
    return;
  }
  content.innerHTML = `${statusMarkup}<div class="image-wrap image-job-placeholder">
    <div class="image-placeholder">This accepted turn has no illustration segments yet.</div>
    <button class="small primary" type="button" data-turn-id="${escapeHtml(turnId)}" data-action="generate-turn-segments">Generate illustrations for this turn</button>
  </div>`;
  illustrationRenderSignatures.set(content, signature);
}

function renderContinuousSceneWindow(container, turns) {
  for (const child of [...container.children]) {
    if (!child.classList.contains("scene")) child.remove();
  }
  const existing = new Map([...container.querySelectorAll(":scope > .scene")].map((scene) => [
    `${scene.dataset.turnNumber}:${scene.dataset.turnId}`,
    scene
  ]));
  const focusedElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const focusedScene = focusedElement?.closest(".scene") || null;
  let focusMustMove = false;
  const retained = new Set();
  for (let index = 0; index < turns.length; index += 1) {
    const turn = turns[index];
    const turnId = turn.id || turn.turnId || "";
    const key = `${turn.turnNumber}:${turnId}`;
    let scene = existing.get(key);
    const nextScene = renderScene(turn, index);
    if (scene) {
      retained.add(scene);
      if (continuousSceneSignatures.get(scene) !== continuousSceneSignatures.get(nextScene)) {
        if (focusedScene === scene) focusMustMove = true;
        for (const attribute of [...scene.attributes]) scene.removeAttribute(attribute.name);
        for (const attribute of [...nextScene.attributes]) scene.setAttribute(attribute.name, attribute.value);
        scene.replaceChildren(...nextScene.childNodes);
        continuousSceneSignatures.set(scene, JSON.stringify(turn));
      }
    } else {
      scene = nextScene;
      retained.add(scene);
    }
    container.appendChild(scene);
  }
  for (const scene of existing.values()) {
    if (!retained.has(scene)) {
      if (focusedScene === scene) focusMustMove = true;
      scene.remove();
    }
  }
  if (focusMustMove) {
    const older = document.querySelector('[data-continuous-reader-direction="older"]');
    if (older instanceof HTMLButtonElement) older.focus({ preventScroll: true });
  }
}

function renderAllScenes(options = {}) {
  const container = $("storyArea");
  if (!container) return;

  if (state.generationDisplayActive) {
    container.replaceChildren();
    renderStreamingPreview("", state.pendingGeneration?.action || state.generationDisplayAction);
    renderStoryIllustration();
    return;
  }

  if (state.turns.length === 0) {
    container.replaceChildren();
    const worldName = state.world?.title || state.campaign?.title || "";
    const character = state.world?.character || state.campaign?.character || "";
    const premise = state.world?.premise || state.campaign?.premise || "";
    container.innerHTML = `<div class="empty">
      <div>
        <div class="story-empty-icon">🗝️</div>
        <h2 class="story-empty-title">${worldName ? escapeHtml(worldName) : "Create a world, then begin."}</h2>
        ${character ? `<p class="story-empty-character"><strong>Character:</strong> ${escapeHtml(character)}</p>` : ""}
        ${premise ? `<p class="story-empty-character">${escapeHtml(premise)}</p>` : ""}
        <p class="story-empty-guidance">Type an action or choose from generated options to begin your adventure.</p>
      </div>
    </div>`;
    renderStoryIllustration();
    return;
  }

  const isContinuous = Boolean(state.user?.settings?.continuousReading);
  if (isContinuous) {
    if (!state.continuousReader) initializeContinuousReader();
    const visibleTurns = state.continuousReader?.turns?.length
      ? state.continuousReader.turns
      : state.readerPinnedTurn
        ? [state.readerPinnedTurn]
        : state.turns.slice(-STORY_CONTINUOUS_READER_WINDOW_LIMIT);
    renderContinuousSceneWindow(container, visibleTurns);
  } else {
    container.replaceChildren();
    const targetIndex = viewedTurnIndex();
    if (state.turns[targetIndex]) {
      container.appendChild(renderScene(state.turns[targetIndex], targetIndex));
    } else if (state.readerPinnedTurn
      && Number(state.readerPinnedTurn.turnNumber) === currentViewTurnNumber()) {
      container.appendChild(renderScene(state.readerPinnedTurn, -1));
    }
  }

  renderStoryIllustration();
  syncContinuousReaderControls();
  if (options.autoScroll !== false) scrollToView();
}

function scrollToView() {
  const container = $("storyArea");
  if (!container) return;
  const isLatest = isViewingLatestTurn();
  const isContinuous = Boolean(state.user?.settings?.continuousReading);
  if (isContinuous) {
    const target = $(`scene-${currentViewTurnNumber()}`);
    if (target) scrollSceneIntoView(target);
    return;
  }
  if (isLatest) {
    const last = container.lastElementChild;
    if (last) scrollSceneIntoView(last);
  } else {
    const target = $(`scene-${currentViewTurnNumber()}`);
    if (target) {
      scrollSceneIntoView(target);
    } else if (!isContinuous) {
      const first = container.firstElementChild;
      if (first) scrollSceneIntoView(first);
    }
  }
}

function scrollSceneIntoView(scene) {

  const header = document.querySelector(".universal-nav");
  const toolbar = document.querySelector("[data-story-reader-toolbar]");
  const headerHeight = header?.getBoundingClientRect?.().height;
  const toolbarHeight = toolbar?.getBoundingClientRect?.().height;
  const stickyTop = toolbar && typeof document.defaultView?.getComputedStyle === "function"
    ? Number.parseFloat(document.defaultView.getComputedStyle(toolbar).top)
    : Number.NaN;

  if (Number.isFinite(headerHeight) && headerHeight > 0
    && Number.isFinite(toolbarHeight) && toolbarHeight > 0
    && Number.isFinite(stickyTop) && stickyTop >= 0
    && scene?.style) {
    scene.style.scrollMarginTop = `${Math.ceil(Math.max(headerHeight, stickyTop) + toolbarHeight + 12)}px`;
  }
  scene.scrollIntoView({ behavior: "smooth", block: "start" });
}

// ── Player Input ──────────────────────────────────────────────
function campaignTurnControlStyle() {
  if (state.campaign?.turnControlStyle === "flexible_scene") return "flexible_scene";
  if (state.campaign?.turnControlStyle === "action_only") return "action_only";
  return "flexible_action";
}

function campaignStoryLengthProfile() {
  const profile = state.campaign?.storyLengthProfile;
  return ["brief", "standard", "long", "extended"].includes(profile) ? profile : "standard";
}

function storyLengthProfileLabel(profile) {
  return ({ brief: "Brief", standard: "Standard", long: "Long", extended: "Extended" })[profile] || "Standard";
}

function selectedStoryLengthOverride(controlId) {
  const value = String($(controlId)?.value || "");
  return ["brief", "standard", "long", "extended"].includes(value) ? value : null;
}

function syncStoryLengthOverrideControls() {
  const defaultLabel = `Campaign default — ${storyLengthProfileLabel(campaignStoryLengthProfile())}`;
  ["turnStoryLengthProfileOverride", "retryStoryLengthProfileOverride"].forEach((controlId) => {
    const control = $(controlId);
    const defaultOption = control?.querySelector('option[value=""]');
    if (defaultOption) defaultOption.textContent = defaultLabel;
  });
}

function setStoryLengthOverride(controlId, value) {
  const control = $(controlId);
  control?.querySelectorAll("option").forEach((option) => { option.selected = false; });
  const option = control?.querySelector(`option[value="${value}"]`);
  if (option) option.selected = true;
}

function resetStoryLengthOverrideControls() {
  ["turnStoryLengthProfileOverride", "retryStoryLengthProfileOverride"].forEach((controlId) => {
    setStoryLengthOverride(controlId, "");
  });
  syncStoryLengthOverrideControls();
}

function actionDraftScope(campaignId = state.campaignId) {
  const userId = state.user?.id;
  if (typeof userId !== "string" || !campaignId) return null;
  return { userId, campaignId };
}

function actionDraftScopeKey(scope) {
  return scope ? `${scope.userId}:${scope.campaignId}` : null;
}

function actionDraftStatusText() {
  if (actionDraftSaving || actionDraftScheduled) return "Draft saving";
  if (actionDraftSaveFailed) return "Draft not saved";
  if (actionDraftConflict) return "Draft not saved";
  if (actionDraftCurrent && actionDraftPersistedRevision
    && actionDraftPersistedGeneration === actionDraftLocalGeneration) return "Draft saved";
  return "No draft";
}

function updateActionDraftStatus() {
  const status = $("autosaveStatus");
  if (status) status.textContent = actionDraftStatusText();
}

function setStorySyncStatus(value) {
  const status = $("storySyncStatus");
  if (status) status.textContent = value;
}

function actionDraftBase() {
  const baseTurnNumber = Number(state.campaign?.activeTurnNumber || 0);
  const baseTurn = state.turns.find((turn) => Number(turn.turnNumber) === baseTurnNumber);
  return { baseTurnId: baseTurn?.id || null, baseTurnNumber };
}

function setActionDraftValue(text, options = {}) {
  actionDraftLocalGeneration += 1;
  actionDraftCurrent = {
    text: String(text ?? ""),
    inputMode: options.inputMode || state.turnInputMode,
    ...actionDraftBase()
  };
  actionDraftClearPending = Boolean(options.clear);
  actionDraftSaveFailed = false;
  if (actionDraftConflict && !options.preserveConflict) actionDraftConflict = null;
  if (actionDraftSaveTimer !== null) clearTimeout(actionDraftSaveTimer);
  if (options.clear) {
    actionDraftSaveTimer = null;
    actionDraftScheduled = false;
    updateActionDraftConflict();
    updateActionDraftStatus();
    void flushActionDraftWrites();
    return;
  }
  actionDraftScheduled = true;
  actionDraftSaveTimer = setTimeout(() => {
    actionDraftSaveTimer = null;
    actionDraftScheduled = false;
    void flushActionDraftWrites();
  }, 250);
  updateActionDraftStatus();
}

function actionDraftRecord(snapshot, editGeneration, scope = actionDraftScope()) {
  if (!scope) return null;
  return {
    scope,
    editGeneration,
    draft: {
      schemaVersion: 1,
      draftRevision: composition.idFactory.create(),
      text: snapshot.text,
      inputMode: snapshot.inputMode,
      baseTurnId: snapshot.baseTurnId,
      baseTurnNumber: snapshot.baseTurnNumber,
      updatedAt: new Date(composition.clock.now()).toISOString()
    }
  };
}

function updateActionDraftConflict() {
  const panel = $("actionDraftConflict");
  const message = $("actionDraftConflictMessage");
  const restore = $("restoreActionDraft");
  const keep = $("keepActionDraft");
  const discard = $("discardActionDraft");
  if (!panel) return;
  panel.classList.toggle("hidden", !actionDraftConflict);
  if (!actionDraftConflict) return;
  if (message) message.textContent = actionDraftConflict.message;
  if (restore) restore.classList.toggle("hidden", !actionDraftConflict.draft);
  if (keep) keep.classList.toggle("hidden", actionDraftConflict.kind !== "revision");
  if (discard) discard.classList.toggle("hidden", actionDraftConflict.kind !== "base");
}

function presentActionDraftConflict(draft, kind, message) {
  actionDraftConflict = { draft: draft || null, kind, message };
  updateActionDraftConflict();
  updateActionDraftStatus();
}

async function writeActionDraftGeneration(snapshot, editGeneration, expectedRevision = actionDraftPersistedRevision, scopeOverride = actionDraftScope()) {
  const record = actionDraftRecord(snapshot, editGeneration, scopeOverride);
  if (!record) return { outcome: "unavailable" };
  const scopeKey = actionDraftScopeKey(record.scope);
  const sessionEpoch = actionDraftSessionEpoch;
  const result = await composition.actionDrafts.write(record.scope, record.draft, { expectedRevision });
  if (sessionEpoch !== actionDraftSessionEpoch || scopeKey !== actionDraftCurrentScopeKey) return { outcome: "superseded" };
  if (result.outcome === "saved") {
    actionDraftPersistedRevision = result.currentRevision;
    actionDraftPersistedGeneration = editGeneration;
    actionDraftSaveFailed = false;
    if (actionDraftLocalGeneration === editGeneration) actionDraftClearPending = false;
    actionDraftCurrentScopeKey = actionDraftScopeKey(record.scope);
    if (actionDraftCurrent && actionDraftLocalGeneration === editGeneration) {
      actionDraftCurrent = { ...snapshot };
    }
  } else if (result.outcome === "conflict") {
    const currentDraft = await composition.actionDrafts.read(record.scope);
    if (sessionEpoch !== actionDraftSessionEpoch || scopeKey !== actionDraftCurrentScopeKey) return { outcome: "superseded" };
    if (currentDraft) {
      presentActionDraftConflict(currentDraft, "revision", "This action draft changed in another tab. Choose which version to keep.");
    } else {
      presentActionDraftConflict(null, "revision", "This action draft changed in another tab. Keep editing and retry your save.");
    }
  } else {
    actionDraftSaveFailed = true;
  }
  updateActionDraftStatus();
  return result;
}

async function drainActionDraftWrites() {
  let allSaved = true;
  while (actionDraftPersistedGeneration < actionDraftLocalGeneration || actionDraftClearPending) {
    const editGeneration = actionDraftLocalGeneration;
    const scope = actionDraftScope();
    const scopeKey = actionDraftScopeKey(scope);
    const sessionEpoch = actionDraftSessionEpoch;
    if (!scope) {
      actionDraftSaveFailed = true;
      updateActionDraftStatus();
      return false;
    }
    if (actionDraftClearPending) {
      const expectedRevision = actionDraftPersistedRevision;
      if (!expectedRevision) {
        actionDraftPersistedGeneration = editGeneration;
        actionDraftClearPending = false;
        actionDraftCurrent = null;
        updateActionDraftStatus();
        continue;
      }
      const removal = await composition.actionDrafts.removeIfRevision(scope, expectedRevision);
      if (sessionEpoch !== actionDraftSessionEpoch || scopeKey !== actionDraftCurrentScopeKey) return false;
      if (removal.outcome === "removed" || removal.outcome === "absent") {
        const stillOwnsAcknowledgedRevision = actionDraftPersistedRevision === expectedRevision;
        if (stillOwnsAcknowledgedRevision) actionDraftPersistedRevision = null;
        actionDraftClearPending = false;
        if (stillOwnsAcknowledgedRevision && actionDraftLocalGeneration === editGeneration) {
          actionDraftPersistedGeneration = editGeneration;
          actionDraftCurrent = null;
          actionDraftConflict = null;
        } else {
          actionDraftPersistedGeneration = -1;
        }
      } else if (removal.outcome === "conflict") {
        const currentDraft = await composition.actionDrafts.read(scope);
        if (sessionEpoch !== actionDraftSessionEpoch || scopeKey !== actionDraftCurrentScopeKey) return false;
        presentActionDraftConflict(currentDraft, "revision", "This action draft changed in another tab. Choose which version to keep.");
        allSaved = false;
        break;
      } else {
        actionDraftSaveFailed = true;
        allSaved = false;
        break;
      }
      updateActionDraftStatus();
      continue;
    }
    const snapshot = actionDraftCurrent;
    if (!snapshot) {
      actionDraftPersistedGeneration = editGeneration;
      continue;
    }
    const result = await writeActionDraftGeneration(snapshot, editGeneration, actionDraftPersistedRevision, scope);
    if (result.outcome !== "saved") {
      allSaved = false;
      break;
    }
  }
  return allSaved && !actionDraftSaveFailed && !actionDraftConflict;
}

function flushActionDraftWrites() {
  if (actionDraftSaveTimer !== null) clearTimeout(actionDraftSaveTimer);
  actionDraftSaveTimer = null;
  actionDraftScheduled = false;
  actionDraftSaving = true;
  updateActionDraftStatus();
  const write = actionDraftSaveQueue.then(() => drainActionDraftWrites(), () => drainActionDraftWrites());
  actionDraftSaveQueue = write.catch(() => false);
  return write.finally(() => {
    actionDraftSaving = false;
    updateActionDraftStatus();
  });
}

function isActionDraftBaseCurrent(draft) {
  const base = actionDraftBase();
  return draft.baseTurnNumber === base.baseTurnNumber && draft.baseTurnId === base.baseTurnId;
}

async function restoreActionDraftForCampaign(campaignId, loadSequence) {
  const scope = actionDraftScope(campaignId);
  if (!scope) {
    updateActionDraftStatus();
    return;
  }
  const scopeKey = actionDraftScopeKey(scope);
  if (actionDraftCurrentScopeKey !== scopeKey) {
    actionDraftSessionEpoch += 1;
    actionDraftLocalGeneration = 0;
    actionDraftPersistedGeneration = -1;
    actionDraftPersistedRevision = null;
    actionDraftCurrent = null;
    actionDraftSubmitted = null;
    actionDraftConflict = null;
    actionDraftSaveFailed = false;
    actionDraftClearPending = false;
    actionDraftCurrentScopeKey = scopeKey;
  }
  const startingGeneration = actionDraftLocalGeneration;
  const sessionEpoch = actionDraftSessionEpoch;
  const draft = await composition.actionDrafts.read(scope);
  if (campaignLoadSequence !== loadSequence || state.campaignId !== campaignId
    || sessionEpoch !== actionDraftSessionEpoch || scopeKey !== actionDraftCurrentScopeKey) return;
  if (!draft) {
    const hasExpiryNotice = await composition.actionDrafts.readExpiryNotice(scope);
    if (campaignLoadSequence !== loadSequence || state.campaignId !== campaignId
      || sessionEpoch !== actionDraftSessionEpoch || scopeKey !== actionDraftCurrentScopeKey) return;
    if (hasExpiryNotice) {
      recordActivity("system", "An older action draft expired", "It was removed after the local retention period.");
    }
    if (actionDraftLocalGeneration === startingGeneration) updateActionDraftStatus();
    return;
  }
  if (actionDraftLocalGeneration !== startingGeneration) {
    updateActionDraftStatus();
    return;
  }
  actionDraftPersistedRevision = draft.draftRevision;
  if (state.pendingGeneration || state.generationRecovery) {
    actionDraftCurrent = { text: draft.text, inputMode: draft.inputMode, baseTurnId: draft.baseTurnId, baseTurnNumber: draft.baseTurnNumber };
    actionDraftPersistedGeneration = actionDraftLocalGeneration;
    updateActionDraftStatus();
    return;
  }
  if (actionDraftLocalGeneration !== startingGeneration) {
    updateActionDraftStatus();
    return;
  }
  actionDraftCurrent = { text: draft.text, inputMode: draft.inputMode, baseTurnId: draft.baseTurnId, baseTurnNumber: draft.baseTurnNumber };
  actionDraftPersistedGeneration = actionDraftLocalGeneration;
  const input = $("freeAction");
  if (input?.value.trim() && input.value.trim() !== draft.text.trim()) {
    presentActionDraftConflict(draft, "base", "Another action is in the input. Restore this saved draft or discard it.");
    return;
  }
  if (!isActionDraftBaseCurrent(draft)) {
    presentActionDraftConflict(draft, "base", "The story has moved on since this action draft was saved. Restore it or discard it.");
    return;
  }
  if (input && !input.value) input.value = draft.text;
  setTurnInputMode(draft.inputMode, { refreshPlaceholder: true });
  resetChoiceSelectionFromDraft(draft.text);
  updateTurnInputCharacterCount();
  updateActionDraftStatus();
}

async function captureSubmittedActionDraft(action, details) {
  const input = $("freeAction");
  if (!details.actionDraftEligible || details.operationKind === "replace_latest" || !input || input.value.trim() !== action) return null;
  const campaignId = state.campaignId;
  const editGeneration = actionDraftLocalGeneration;
  const sessionEpoch = actionDraftSessionEpoch;
  const scopeKey = actionDraftCurrentScopeKey;
  const intentNonce = ++actionDraftSubmissionNonce;
  const operationKind = details.operationKind || "append";
  const expectedTurnNumber = appendExpectedTurnNumber(state.campaign);
  const saved = await flushActionDraftWrites();
  if (!saved || intentNonce !== actionDraftSubmissionNonce || campaignId !== state.campaignId || sessionEpoch !== actionDraftSessionEpoch
    || scopeKey !== actionDraftCurrentScopeKey || editGeneration !== actionDraftLocalGeneration
    || actionDraftPersistedGeneration !== editGeneration || !actionDraftPersistedRevision
    || actionDraftCurrent?.text.trim() !== action) return null;
  return { intentNonce, campaignId, editGeneration, persistedRevision: actionDraftPersistedRevision, scopeKey, sessionEpoch, action, operationKind, expectedTurnNumber };
}

async function clearAcceptedActionDraft(result) {
  const submitted = actionDraftSubmitted;
  if (!submitted || submitted.jobId !== result.id || submitted.action !== result.action
    || submitted.operationKind !== "append"
    || (result.operationKind && submitted.operationKind !== result.operationKind)
    || submitted.expectedTurnNumber !== Number(result.expectedTurnNumber)
    || submitted.campaignId !== result.campaignId
    || submitted.sessionEpoch !== actionDraftSessionEpoch
    || submitted.scopeKey !== actionDraftCurrentScopeKey
    || submitted.editGeneration !== actionDraftLocalGeneration
    || submitted.editGeneration !== actionDraftPersistedGeneration
    || submitted.persistedRevision !== actionDraftPersistedRevision) return;
  const scope = actionDraftScope(result.campaignId);
  if (!scope) return;
  const removal = await composition.actionDrafts.removeIfRevision(scope, submitted.persistedRevision);
  if (submitted.sessionEpoch !== actionDraftSessionEpoch || submitted.scopeKey !== actionDraftCurrentScopeKey) return;
  if (removal.outcome === "removed" || removal.outcome === "absent") {
    const stillOwnsAcknowledgedRevision = submitted.persistedRevision === actionDraftPersistedRevision;
    if (!stillOwnsAcknowledgedRevision) {
      updateActionDraftStatus();
      return;
    }
    actionDraftPersistedRevision = null;
    if (submitted.editGeneration !== actionDraftLocalGeneration) {
      actionDraftPersistedGeneration = -1;
      updateActionDraftStatus();
      return;
    }
    actionDraftPersistedGeneration = actionDraftLocalGeneration;
    actionDraftCurrent = null;
    actionDraftSubmitted = null;
    updateActionDraftStatus();
  } else if (removal.outcome === "conflict") {
    const currentDraft = await composition.actionDrafts.read(scope);
    if (submitted.sessionEpoch !== actionDraftSessionEpoch || submitted.scopeKey !== actionDraftCurrentScopeKey) return;
    presentActionDraftConflict(currentDraft, "revision", "This action draft changed in another tab. Choose which version to keep.");
  } else {
    actionDraftSaveFailed = true;
    updateActionDraftStatus();
  }
}

async function reconcileActionDraftConflict(choice) {
  const conflict = actionDraftConflict;
  if (!conflict) return false;
  const scope = actionDraftScope();
  if (!scope) return false;
  const scopeKey = actionDraftScopeKey(scope);
  const sessionEpoch = actionDraftSessionEpoch;
  const editGeneration = actionDraftLocalGeneration;
  if (choice === "restore" && conflict.draft) {
    const draft = await composition.actionDrafts.read(scope);
    if (sessionEpoch !== actionDraftSessionEpoch || scopeKey !== actionDraftCurrentScopeKey) return false;
    if (actionDraftConflict !== conflict || actionDraftLocalGeneration !== editGeneration) {
      if (actionDraftConflict === null && actionDraftLocalGeneration !== editGeneration) {
        presentActionDraftConflict(draft, "revision", "A newer local edit was made while restoring. Choose which version to keep.");
      }
      return false;
    }
    if (!draft || draft.draftRevision !== conflict.draft.draftRevision) {
      presentActionDraftConflict(draft, "revision", "This action draft changed in another tab. Choose which version to keep.");
      return false;
    }
    actionDraftLocalGeneration += 1;
    actionDraftCurrent = { text: draft.text, inputMode: draft.inputMode, baseTurnId: draft.baseTurnId, baseTurnNumber: draft.baseTurnNumber };
    actionDraftPersistedGeneration = actionDraftLocalGeneration;
    actionDraftPersistedRevision = draft.draftRevision;
    actionDraftConflict = null;
    setTurnInputMode(draft.inputMode, { refreshPlaceholder: true });
    const input = $("freeAction");
    if (input) input.value = draft.text;
    resetChoiceSelectionFromDraft(draft.text);
    updateTurnInputCharacterCount();
    updateActionDraftConflict();
    updateActionDraftStatus();
    return true;
  }
  if (choice === "keep") {
    const remote = await composition.actionDrafts.read(scope);
    if (sessionEpoch !== actionDraftSessionEpoch || scopeKey !== actionDraftCurrentScopeKey
      || actionDraftConflict !== conflict || actionDraftLocalGeneration !== editGeneration) return false;
    const snapshot = actionDraftCurrent;
    if (!snapshot) return false;
    actionDraftConflict = null;
    actionDraftPersistedRevision = remote?.draftRevision ?? null;
    actionDraftPersistedGeneration = -1;
    const result = await flushActionDraftWrites();
    if (result) {
      updateActionDraftConflict();
      return true;
    }
    return false;
  }
  if (choice === "discard" && conflict.kind === "base" && conflict.draft) {
    const result = await composition.actionDrafts.removeIfRevision(scope, conflict.draft.draftRevision);
    if (sessionEpoch !== actionDraftSessionEpoch || scopeKey !== actionDraftCurrentScopeKey) return false;
    if (result.outcome === "removed" || result.outcome === "absent") {
      actionDraftConflict = null;
      actionDraftCurrent = null;
      actionDraftPersistedRevision = null;
      actionDraftPersistedGeneration = actionDraftLocalGeneration;
      updateActionDraftConflict();
      updateActionDraftStatus();
      return true;
    }
    if (result.outcome === "conflict") {
      const latest = await composition.actionDrafts.read(scope);
      if (sessionEpoch !== actionDraftSessionEpoch || scopeKey !== actionDraftCurrentScopeKey) return false;
      presentActionDraftConflict(latest, "revision", "This action draft changed in another tab. Choose which version to keep.");
    }
  }
  return false;
}

function actionDraftNeedsNavigationGuard() {
  return Boolean(actionDraftCurrent && (
    actionDraftSaving
    || actionDraftSaveFailed
    || actionDraftConflict
    || actionDraftPersistedGeneration !== actionDraftLocalGeneration
  ));
}

function openActionDraftNavigationDialog(target) {
  actionDraftNavigationTarget = target;
  const dialog = $("actionDraftNavigationDialog");
  if (dialog && !dialog.open && typeof dialog.showModal === "function") dialog.showModal();
}

async function discardActionDraftBeforeNavigation() {
  const scope = actionDraftScope();
  if (scope && actionDraftPersistedRevision && !actionDraftConflict) {
    await composition.actionDrafts.removeIfRevision(scope, actionDraftPersistedRevision);
  }
  actionDraftLocalGeneration += 1;
  actionDraftPersistedGeneration = actionDraftLocalGeneration;
  actionDraftPersistedRevision = null;
  actionDraftCurrent = null;
  actionDraftSubmitted = null;
  actionDraftSaveFailed = false;
  actionDraftClearPending = false;
  updateActionDraftStatus();
  const target = actionDraftNavigationTarget;
  actionDraftNavigationTarget = null;
  if (target) window.location.assign(target);
}

function defaultTurnInputMode() {
  return turnInputModeForControlStyle(campaignTurnControlStyle());
}

function turnInputCopy(mode) {
  if (mode === "scene") {
    return {
      label: "Describe what happens next",
      help: "Continue the story with dialogue, events, or a direction for the next scene.",
      button: "➜ Continue story",
      placeholder: "Describe the events, dialogue, atmosphere, and details that must appear in the next scene..."
    };
  }
  if (mode === "action") {
    return {
      label: "Describe what your character tries to do",
      help: "Action expresses an attempt or intention. The Story Engine decides uncertain outcomes and writes what follows.",
      button: "➜ Take action",
      placeholder: "Describe an action, decision, or dialogue for your character..."
    };
  }
}

function updateTurnInputCharacterCount() {
  const freeAction = $("freeAction");
  const counter = $("turnInputCount");
  if (freeAction && counter) counter.textContent = `${freeAction.value.length.toLocaleString()} / 12,000`;
  syncClearTurnInputButton();
}

function syncClearTurnInputButton() {
  const button = $("btnClearTurnInput");
  const freeAction = $("freeAction");
  if (button) button.disabled = !freeAction || freeAction.disabled || !freeAction.value;
}

function setTurnInputMode(mode, options = {}) {
  const controlStyle = campaignTurnControlStyle();
  state.turnInputMode = controlStyle === "flexible_action" && mode === "scene" ? "scene" : defaultTurnInputMode();
  const copy = turnInputCopy(state.turnInputMode);
  const label = $("turnInputLabel");
  const help = $("turnInputHelp");
  const button = $("btnTakeAction");
  const freeAction = $("freeAction");
  if (label) label.textContent = copy.label;
  if (help) help.textContent = copy.help;
  if (button) button.textContent = copy.button;
  if (freeAction && (options.refreshPlaceholder || !freeAction.placeholder)) freeAction.placeholder = copy.placeholder;
  const field = $("turnInputModeField");
  const lock = $("turnInputModeLock");
  const canChoose = controlStyle === "flexible_action";
  if (field) field.classList.toggle("hidden", controlStyle === "flexible_scene");
  for (const input of document.querySelectorAll("[data-turn-input-mode]")) {
    input.checked = input.value === state.turnInputMode;
    input.disabled = !canChoose;
  }
  if (lock) {
    lock.classList.toggle("hidden", canChoose || controlStyle === "flexible_scene");
    lock.textContent = controlStyle === "action_only" ? "This campaign accepts player actions." : "";
  }
  if (options.persistDraft) setActionDraftValue(freeAction?.value || "", { inputMode: state.turnInputMode });
}

function syncTurnInputModeFromCampaign() {
  setTurnInputMode(defaultTurnInputMode(), { refreshPlaceholder: true });
  updateTurnInputCharacterCount();
}

function syncChoiceSelectionButtons(container) {
  const selectedIndexes = new Set(state.choiceDraftSelection.selectedIndexes);
  container.querySelectorAll(".choice").forEach((button) => {
    button.setAttribute("aria-pressed", String(selectedIndexes.has(Number(button.dataset.choiceIndex))));
  });
}

function resetChoiceSelectionFromDraft(text = "") {
  state.choiceDraftSelection = resetChoiceDraftSelection(text);
  state.nextTurnInputModeSource = null;
  const container = $("choiceArea");
  if (container) syncChoiceSelectionButtons(container);
}

function renderChoices(choices, customSuggestion, ownerKey) {
  const container = $("choiceArea");
  if (!container) return;
  const freeAction = $("freeAction");
  if (state.choiceDraftOwnerKey !== ownerKey) {
    state.choiceDraftOwnerKey = ownerKey;
    resetChoiceSelectionFromDraft(freeAction?.value || "");
  }
  container.innerHTML = "";
  if (choices && choices.length) {
    choices.forEach((text, choiceIndex) => {
      const btn = document.createElement("button");
      btn.className = "choice";
      btn.type = "button";
      const choiceModeLabel = state.user?.settings?.autoSubmitTurnChoices === false ? "Add to draft" : "Choose and continue";
      const choiceCopy = document.createElement("span");
      choiceCopy.className = "choice-copy";
      choiceCopy.textContent = text;
      const choiceModeHint = document.createElement("span");
      choiceModeHint.className = "choice-mode-hint";
      choiceModeHint.textContent = choiceModeLabel;
      btn.append(choiceCopy, choiceModeHint);
      btn.setAttribute("aria-label", `${text}. ${choiceModeLabel}`);
      btn.dataset.choiceIndex = String(choiceIndex);
      btn.setAttribute("aria-pressed", "false");
      btn.addEventListener("click", () => {
        const autoSubmit = state.user?.settings?.autoSubmitTurnChoices !== false;
        setTurnInputMode(state.turnInputMode, { refreshPlaceholder: true });
        if (autoSubmit) {
          if (freeAction) {
            const maxLength = freeAction.maxLength > 0 ? freeAction.maxLength : 12_000;
            if (text.length > maxLength) {
              toast("This generated choice exceeds the 12,000 character limit.", 3200);
              return;
            }
            resetChoiceSelectionFromDraft(text);
            freeAction.value = text;
            setActionDraftValue(text, { inputMode: state.turnInputMode });
            updateTurnInputCharacterCount();
          }
          state.nextTurnInputModeSource = "generated_choice";
          submitAction(text);
        } else {
          if (freeAction) {
            const result = toggleChoiceDraftSelection(
              state.choiceDraftSelection,
              choices,
              choiceIndex,
              freeAction.value,
              freeAction.maxLength > 0 ? freeAction.maxLength : 12_000
            );
            if (result.overLimit) {
              toast("Selected choices would exceed the 12,000 character limit.", 3200);
              return;
            }
            state.choiceDraftSelection = result.selection;
            state.nextTurnInputModeSource = result.selection.selectedIndexes.length ? "generated_choice" : null;
            freeAction.value = result.text;
            setActionDraftValue(result.text, { inputMode: state.turnInputMode });
            freeAction.focus();
            updateTurnInputCharacterCount();
            syncChoiceSelectionButtons(container);
          }
        }
      });
      container.appendChild(btn);
    });
  }
  syncChoiceSelectionButtons(container);
  if (freeAction && customSuggestion) {
    freeAction.placeholder = state.turnInputMode === "action" ? customSuggestion : turnInputCopy(state.turnInputMode).placeholder;
  }
}

function renderTurnInput() {
  const inputPanel = document.querySelector(".input-action");
  if (!inputPanel) return;
  const isLatest = isViewingLatestTurn();
  // A live saved review is rendered with the input controls. Keep the region
  // visible for its explicit decisions while syncInputState keeps all ordinary
  // generation paths disabled.
  const recoveryVisible = Boolean($("generationRecoveryPanel") && !$("generationRecoveryPanel").classList.contains("hidden"));
  const shouldShowInput = (!state.generationDisplayActive || recoveryVisible) && isLatest;
  inputPanel.classList.toggle("hidden", !shouldShowInput);
  syncStoryLengthOverrideControls();
  if (!shouldShowInput) {
    return;
  }
  const latestTurn = state.turns[state.turns.length - 1];
  if (latestTurn) {
    const choices = latestTurn.choices || [];
    renderChoices(choices, latestTurn.customActionSuggestion || "", `${state.campaignId}:${latestTurn.id || latestTurn.turnNumber}:${JSON.stringify(choices)}`);
  } else {
    const openingAction = firstActionForNewAdventure();
    renderChoices([openingAction], openingAction, `${state.campaignId}:opening:${openingAction}`);
  }
}

async function submitResolvedTurn(action, details) {
  if (details.operationKind !== "replace_latest") {
    // Keep this in-memory only until enqueue returns an authoritative job ID.
    // An enqueue failure must not erase what the player just typed.
    state.retainedAppendDraft = { campaignId: state.campaignId, expectedTurnNumber: appendExpectedTurnNumber(state.campaign), action, requestedInputMode: details.requestedInputMode };
  }
  const freeAction = $("freeAction");
  const submittedDraft = await captureSubmittedActionDraft(action, details);
  const canClearSubmittedInput = submittedDraft
    && freeAction?.value.trim() === action
    && submittedDraft.editGeneration === actionDraftLocalGeneration
    && submittedDraft.sessionEpoch === actionDraftSessionEpoch
    && submittedDraft.scopeKey === actionDraftCurrentScopeKey;
  if (freeAction && canClearSubmittedInput) freeAction.value = "";
  if (canClearSubmittedInput) resetChoiceSelectionFromDraft("");
  updateTurnInputCharacterCount();
  await runGeneration(action, { ...details, actionDraftSubmissionCandidate: canClearSubmittedInput ? submittedDraft : null });
}

async function submitAction(actionText, options = {}) {
  if (state.busy || !state.campaignLoaded) return;
  let action = (actionText || "").trim();
  if (!action && state.turns.length === 0) {
    action = firstActionForNewAdventure();
  }
  if (!action) { toast("Enter an action first."); return; }
  const storyLengthProfileOverride = selectedStoryLengthOverride("turnStoryLengthProfileOverride");
  const requestedInputMode = campaignTurnControlStyle() === "flexible_action" ? state.turnInputMode : defaultTurnInputMode();
  const inputModeSource = options.inputModeSource || state.nextTurnInputModeSource || "explicit";
  state.nextTurnInputModeSource = null;
  await submitResolvedTurn(action, { requestedInputMode, resolvedInputMode: requestedInputMode, inputModeSource, storyLengthProfileOverride, actionDraftEligible: true });
}

// ── Generation Pipeline ───────────────────────────────────────
function clearPendingSubmission() {
  if (state.campaignId) composition.pendingSubmissions.clear(state.campaignId);
}

function retainAppendDraft(campaignId, expectedTurnNumber, generationId, action, requestedInputMode) {
  if (!campaignId || !generationId || !action || !["action", "scene"].includes(requestedInputMode) || !Number.isSafeInteger(expectedTurnNumber) || expectedTurnNumber < 1) return;
  state.retainedAppendDraft = { campaignId, expectedTurnNumber, generationId, action, requestedInputMode };
  composition.failedTurnPrompts?.save(state.retainedAppendDraft);
}

function restoreRetainedAppendDraft() {
  const retained = state.retainedAppendDraft;
  const freeAction = $("freeAction");
  if (!retained || !freeAction
    || retained.campaignId !== state.campaignId
    || Number(state.campaign?.activeTurnNumber || 0) + 1 !== retained.expectedTurnNumber
    || freeAction.value.trim()) return;
  state.retainedAppendDraft = null;
  setTurnInputMode(retained.requestedInputMode, { refreshPlaceholder: true });
  freeAction.value = retained.action;
  resetChoiceSelectionFromDraft(retained.action);
  updateTurnInputCharacterCount();
}

function forgetRetainedAppendDraft() {
  const campaignId = state.retainedAppendDraft?.campaignId || state.campaignId;
  state.retainedAppendDraft = null;
  if (campaignId) composition.failedTurnPrompts?.clear(campaignId);
}

function captureHydratedAppendDraft(syncData) {
  const generation = syncData.pendingGeneration || syncData.generationRecovery;
  if (generation?.operationKind !== "append") return;
  const retained = composition.failedTurnPrompts?.load?.(syncData.campaign.id);
  if (retained?.expectedTurnNumber === generation.expectedTurnNumber && retained.generationId === generation.id) {
    state.retainedAppendDraft = retained;
    return;
  }
  let stored = null;
  try {
    stored = composition.pendingSubmissions.load?.(syncData.campaign.id);
  } catch (_) {
    stored = null;
  }
  if (syncData.pendingGeneration?.operationKind === "append" && stored?.operationKind === "append" && stored.jobId === syncData.pendingGeneration.id && stored.expectedTurnNumber === generation.expectedTurnNumber) {
    retainAppendDraft(syncData.campaign.id, generation.expectedTurnNumber, stored.jobId, stored.request.action, stored.request.requestedInputMode);
  }
}

async function runGeneration(action, options = {}) {
  if (!state.campaignLoaded) return;
  const submissionCampaignId = state.campaignId;
  showBusy("Queueing turn with the Story Engine…");
  state.abortController = new AbortController();
  const progressEl = $("generationProgress");
  if (progressEl) progressEl.classList.remove("hidden");
  let completeButLoading = false;

  try {
    const operationKind = options.operationKind || "append";
    const expectedTurnNumber = operationKind === "replace_latest"
      ? Number(options.expectedCurrentTurnNumber)
      : appendExpectedTurnNumber(state.campaign);
    const submission = {
      action,
      requestedInputMode: options.requestedInputMode || "action",
      resolvedInputMode: options.resolvedInputMode || "action",
      inputModeSource: options.inputModeSource || "explicit",
      ...(options.storyLengthProfileOverride ? { storyLengthProfileOverride: options.storyLengthProfileOverride } : {}),
      operationKind,
      expectedTurnNumber,
      idempotencyKey: options.idempotencyKey || composition.idFactory.create(),
      createdAt: Number(options.createdAt) || composition.clock.now(),
      context: {
        budgetTokens: 32_000,
        compression: "auto",
        recentTurns: 8
      }
    };
    recordActivity("generation", "Generation queued", `Action: "${action}"`);
    beginGenerationDisplay(action);
    const request = {
      action: submission.action,
      requestedInputMode: submission.requestedInputMode,
      resolvedInputMode: submission.resolvedInputMode,
      inputModeSource: submission.inputModeSource,
      ...(submission.storyLengthProfileOverride ? { storyLengthProfileOverride: submission.storyLengthProfileOverride } : {}),
      idempotencyKey: submission.idempotencyKey,
      context: submission.context,
      ...(operationKind === "replace_latest" ? { expectedCurrentTurnNumber: expectedTurnNumber } : {})
    };
    let run;
    let attachedConflict = false;
    let conflictPendingGeneration = null;
    try {
      run = await composition.workflow.submit(
        submissionCampaignId,
        generationSubmissionInput(submission, request)
      );
    } catch (error) {
      const conflict = await resumeActiveGenerationConflict(error, submissionCampaignId, composition.workflow);
      if (!conflict) throw error;
      toast(conflict.message);
      recordActivity("system", "Attached to active generation", `jobId=${conflict.pendingGeneration.id || "unknown"}`);
      run = conflict.run;
      attachedConflict = true;
      conflictPendingGeneration = conflict.pendingGeneration;
    }
    if (state.campaignId !== submissionCampaignId
      || (operationKind === "append" && appendExpectedTurnNumber(state.campaign) !== expectedTurnNumber)) return;
    const actionDraftCandidate = options.actionDraftSubmissionCandidate;
    if (actionDraftCandidate && !attachedConflict
      && actionDraftCandidate.intentNonce === actionDraftSubmissionNonce
      && actionDraftCandidate.campaignId === submissionCampaignId
      && actionDraftCandidate.sessionEpoch === actionDraftSessionEpoch
      && actionDraftCandidate.scopeKey === actionDraftCurrentScopeKey
      && actionDraftCandidate.action === submission.action
      && actionDraftCandidate.operationKind === operationKind
      && actionDraftCandidate.expectedTurnNumber === expectedTurnNumber) {
      actionDraftSubmitted = {
        ...actionDraftCandidate,
        jobId: run.jobId,
        action: submission.action,
        operationKind,
        expectedTurnNumber
      };
    }
    resetStoryLengthOverrideControls();
    options.onAttached?.();
    state.generationRun = run;
    if (operationKind === "append" && !attachedConflict) {
      retainAppendDraft(submissionCampaignId, expectedTurnNumber, run.jobId, action, submission.requestedInputMode);
    } else if (operationKind === "append") {
      // The conflicting job belongs to another local submission. Keep this
      // draft local, but never associate it with that authoritative job.
      restoreRetainedAppendDraft();
    }
    state.pendingGeneration = attachedConflict
      ? conflictPendingGeneration
      : state.pendingGeneration?.id === run.jobId
      ? state.pendingGeneration
      : { id: run.jobId, action, operationKind, expectedTurnNumber };
    completeButLoading = await observeGenerationRun(run, attachedConflict ? (conflictPendingGeneration?.action || "") : action) === "result_unavailable";
  } catch (err) {
    if (err.pendingGeneration) state.pendingGeneration = err.pendingGeneration;
    restoreGenerationDisplay();
    if (options.operationKind !== "replace_latest") restoreRetainedAppendDraft();
    if (err.name === "AbortError") {
      if (!state.cancellationConfirmed) {
        toast("Generation cancelled.");
        recordActivity("system", "Generation cancelled");
      }
      state.cancellationConfirmed = false;
    } else {
      const preserved = options.operationKind === "replace_latest" ? " The original turn was preserved." : "";
      toast(`Generation failed: ${err.message}${preserved}`);
      recordActivity("error", "Generation failed", err.message);
    }
  } finally {
    if (!completeButLoading) clearStreamingPreview();
    if (progressEl) progressEl.classList.add("hidden");
    hideBusy();
    state.abortController = null;
  }
}

function renderStreamingPreview(narrationText, action) {
  const container = $("storyArea");
  if (!container) return;

  const emptyEl = container.querySelector(".empty");
  if (emptyEl) emptyEl.remove();

  let card = $("streamingPreviewCard");
  const isNewPreview = !card;
  if (!card) {
    card = document.createElement("div");
    card.id = "streamingPreviewCard";
    card.className = "scene no-image turn-streaming-preview";
    container.appendChild(card);
    const actionText = action || "Generating turn...";
    card.innerHTML = `
      <div class="scene-narration">
        <div class="turn-streaming-header">
          <span class="turn-streaming-badge"><span class="turn-streaming-pulse"></span> Streaming Live</span>
          <button type="button" class="streaming-follow-button hidden" data-action="follow-stream" aria-label="Resume following live narration">Follow live</button>
        </div>
        <div class="turn-meta">
          <div class="action-tag">➜ ${escapeHtml(actionText)}</div>
        </div>
        <div class="narration streaming-narration"></div>
        <div class="streaming-illustrations"></div>
      </div>
    `;
  }

  const header = card.querySelector(".turn-streaming-header");
  if (header) syncCancelGenerationButton(header, state);

  const narration = card.querySelector(".streaming-narration");
  if (narration) {
    narration.innerHTML = `${sanitizeNarration(narrationText)}<span class="streaming-cursor" title="Receiving live tokens..."></span>`;
  }

  if (isNewPreview) {
    state.streamingAutoFollow = true;
    card.scrollIntoView({ behavior: "auto", block: "start" });
    state.streamingExpectedScrollY = window.scrollY;
  } else if (state.streamingAutoFollow) {
    followStreamingPreview();
  }
}

function followStreamingPreview() {
  const card = $("streamingPreviewCard");
  if (!card) return;
  state.streamingAutoFollow = true;
  const button = card.querySelector('[data-action="follow-stream"]');
  if (button) button.classList.add("hidden");
  const cursor = card.querySelector(".streaming-cursor");
  if (cursor) {
    cursor.scrollIntoView({ behavior: "auto", block: "end" });
    state.streamingExpectedScrollY = window.scrollY;
  }
}

function pauseStreamingAutoFollow() {
  if (!state.streamingAutoFollow) return;
  const card = $("streamingPreviewCard");
  if (!card) return;
  state.streamingAutoFollow = false;
  state.streamingExpectedScrollY = null;
  const button = card.querySelector('[data-action="follow-stream"]');
  if (button) button.classList.remove("hidden");
}

function clearStreamingPreview() {
  const card = $("streamingPreviewCard");
  if (card) card.remove();
  state.streamingAutoFollow = true;
  state.streamingExpectedScrollY = null;
}

function beginGenerationDisplay(action, { preserveAcceptedScene = false } = {}) {
  clearResponseEditSession();
  state.cancellationConfirmed = false;
  state.generationDisplayActive = true;
  state.generationDisplayAction = action || "";
  renderTurnInput();
  const container = $("storyArea");
  if (container && !preserveAcceptedScene) container.replaceChildren();
  renderStoryIllustration();
  renderStreamingPreview("", state.generationDisplayAction);
}

function restoreGenerationDisplay() {
  state.generationDisplayActive = false;
  state.generationDisplayAction = "";
  state.generationJobId = null;
  clearStreamingPreview();
  renderAllScenes({ autoScroll: false });
  renderTurnInput();
}

function commitGenerationDisplay(removeStreamingPreview = true) {
  state.generationDisplayActive = false;
  state.generationDisplayAction = "";
  state.generationJobId = null;
  if (removeStreamingPreview) $("streamingPreviewCard")?.remove();
}

async function cancelActiveGeneration() {
  await cancelGeneration({
    state,
    getCancelButton: () => $("streamingPreviewCard")?.querySelector('[data-action="cancel-generation"]'),
    requestCancellation: () => {
      if (!state.generationRun) throw new Error("No active generation run is available to cancel.");
      return state.generationRun.cancelGeneration();
    },
    clearPendingSubmission,
    restoreGenerationDisplay,
    abortLocalMonitoring: () => state.abortController?.abort(),
    reloadCampaign: (campaignId) => loadCampaign(campaignId, { autoScroll: false }),
    recordActivity,
    toast,
    showBusy
  });
}

function showGenerationRecovery(jobId, message, kind = "generation", guidance = null, presentation = null) {
  const panel = $("generationRecoveryPanel");
  const messageEl = $("generationRecoveryMessage");
  const continueButton = $("btnContinueGeneration");
  const retryButton = $("btnRetryGeneration");
  const discardButton = $("btnDiscardGenerationRecovery");
  const details = $("generationRecoveryDetails");
  const reviewPanel = $("generationReviewPanel");
  const responseFormatPanel = $("generationResponseFormatPanel");
  const responseFormatHeading = $("generationResponseFormatHeading");
  const responseFormatDetails = $("generationResponseFormatDetails");
  const review = state.generationReview;
  const reviewView = review?.summary ? generationReviewPresentation(review.summary, null, review.detail) : null;
  const responseFormat = generationResponseFormatPresentation(
    state.generationRecovery?.responseFormat ?? state.pendingGeneration?.responseFormat
  );
  state.generationRecoveryKind = kind;
  if (panel) {
    panel.dataset.jobId = jobId;
    panel.classList.remove("hidden");
  }
  if (messageEl) {
    messageEl.textContent = message || "The durable generation needs attention.";
    messageEl.classList.toggle("hidden", reviewView !== null);
  }
  if (details) {
    details.replaceChildren();
    for (const detail of reviewView ? [] : presentation?.details || []) {
      const item = document.createElement("li");
      item.textContent = detail;
      details.append(item);
    }
    details.classList.toggle("hidden", reviewView !== null || !details.childElementCount);
  }
  if (responseFormatPanel) responseFormatPanel.classList.toggle("hidden", responseFormat === null);
  if (responseFormatHeading) responseFormatHeading.textContent = responseFormat?.heading || "";
  if (responseFormatDetails) {
    responseFormatDetails.replaceChildren();
    for (const detail of responseFormat?.details || []) {
      const item = document.createElement("li");
      item.textContent = detail;
      responseFormatDetails.append(item);
    }
  }
  if (continueButton) continueButton.classList.toggle("hidden", reviewView !== null || kind === "result");
  if (retryButton) {
    retryButton.classList.toggle("hidden", reviewView !== null || (kind !== "result" && guidance?.retryable === false));
    retryButton.textContent = kind === "result" ? "Retry loading result" : "Retry generation job";
  }
  if (discardButton) discardButton.classList.toggle("hidden", kind === "result");
  if (reviewPanel) {
    reviewPanel.classList.toggle("hidden", !reviewView);
    if (reviewView) {
      $("generationReviewHeading").textContent = reviewView.state === "review" ? "This turn needs your review" : "Generation review unavailable";
      const validationMessages = review?.detail?.validationIssues?.map(issue => {
        if (issue.field === "canonical_fact_updates" && issue.code === "missing_array") return "The response omitted canonical_fact_updates; an array is required.";
        if (issue.field === "canonical_facts" && issue.code === "expected_string_item") return "canonical_facts must contain text entries.";
        if (issue.code === "missing_array") return `The response omitted ${issue.field}; an array is required.`;
        return issue.code === "expected_string_item" ? `${issue.field} must contain text entries.` : `The response has an invalid ${issue.field} shape.`;
      }) || [];
      $("generationReviewReason").textContent = [reviewView.message, ...validationMessages, ...(review?.detail?.findings?.map(finding => finding.message) || [])].join(" ");
      const preview = $("generationReviewPreview");
      preview.replaceChildren();
      if (review?.detail?.narration) preview.append(...review.detail.narration.split(/\r?\n/).filter(Boolean).map(text => { const p = document.createElement("p"); p.textContent = text; return p; }));
      const choices = $("generationReviewChoices");
      choices.replaceChildren();
      for (const choice of review?.detail?.choices || []) { const button = document.createElement("button"); button.type = "button"; button.disabled = true; button.textContent = choice; choices.append(button); }
      const keep = $("btnKeepGenerationReview"); const retry = $("btnRetryGenerationReview"); const repair = $("btnRepairFormatGenerationReview");
      if (retry) retry.textContent = review?.summary.technicalDiagnostic ? "Retry continuity review" : "Continue with retry";
      if (keep) { keep.classList.toggle("hidden", !reviewView.canKeep); keep.disabled = state.generationReviewSubmitting; }
      if (retry) { retry.classList.toggle("hidden", !reviewView.canRetry); retry.disabled = state.generationReviewSubmitting; }
      if (repair) { repair.classList.toggle("hidden", !reviewView.canRepairFormat); repair.disabled = state.generationReviewSubmitting; repair.title = reviewView.repairDescription || ""; }
      $("generationReviewStatus").textContent = state.generationReviewSubmitting
        ? "Saving your decision…"
        : state.generationReviewError || reviewView.retryFailure
          || (reviewView.canRepairFormat ? `${reviewView.repairDescription} ${reviewView.retryDescription}` : "");
    }
  }
}

function hideGenerationRecovery() {
  const panel = $("generationRecoveryPanel");
  if (panel) {
    panel.dataset.jobId = "";
    panel.classList.add("hidden");
  }
  const details = $("generationRecoveryDetails");
  if (details) {
    details.replaceChildren();
    details.classList.add("hidden");
  }
  const responseFormatPanel = $("generationResponseFormatPanel");
  if (responseFormatPanel) responseFormatPanel.classList.add("hidden");
  const responseFormatDetails = $("generationResponseFormatDetails");
  if (responseFormatDetails) responseFormatDetails.replaceChildren();
  state.generationRecoveryKind = null;
  state.generationReview = null;
  state.generationReviewError = null;
  state.generationReviewSubmitting = false;
  generationReviewLoadEpoch += 1;
  generationReviewLoadedKey = null;
}

async function loadGenerationReview() {
  const recovery = state.generationRecovery;
  const summary = recovery?.review;
  if (!summary || !state.campaignId) return;
  const campaignId = state.campaignId;
  const jobId = recovery.id;
  const reviewKey = `${jobId}:${summary.version}:${summary.reviewId}:${summary.revision}:${summary.state}`;
  if (generationReviewLoadedKey === reviewKey) return;
  const loadEpoch = ++generationReviewLoadEpoch;
  const stillCurrent = () => state.campaignId === campaignId
    && state.generationRecovery?.id === jobId
    && state.generationRecovery.review?.version === summary.version
    && state.generationRecovery.review?.reviewId === summary.reviewId
    && state.generationRecovery.review?.revision === summary.revision
    && state.generationRecovery.review?.state === summary.state
    && generationReviewLoadEpoch === loadEpoch;
  try {
    const run = state.generationRun || await composition.workflow.resume(campaignId);
    if (!run || !stillCurrent()) return;
    state.generationRun = run;
    const detail = await run.getReview();
    if (!stillCurrent()) return;
    state.generationReview = { summary, detail };
    generationReviewLoadedKey = reviewKey;
  } catch {
    if (!stillCurrent()) return;
    state.generationReview = { summary, detail: null };
    generationReviewLoadedKey = reviewKey;
  }
}

async function decideGenerationReview(decision) {
  const summary = state.generationReview?.summary;
  if (!summary || state.generationReviewSubmitting) return;
  state.generationReviewSubmitting = true; state.generationReviewError = null;
  showGenerationRecovery(state.generationRecovery?.id || state.pendingGeneration?.id, "This turn needs your review");
  try {
    const run = state.generationRun || await composition.workflow.resume(state.campaignId);
    if (!run) throw new Error("The saved review is unavailable.");
    state.generationRun = run;
    const current = await run.getReview();
    const stillCurrent = current.reviewId === summary.reviewId
      && current.revision === summary.revision
      && current.state === "pending";
    if (!stillCurrent) {
      state.generationReview = {
        summary: current.version === 2
          ? { version: 2, reviewId: current.reviewId, revision: current.revision, state: current.state, stage: current.stage, candidateScope: current.candidateScope, reasons: current.reasons, canKeep: current.canKeep, canRetry: current.canRetry, canRepairFormat: current.canRepairFormat, formatRepair: current.formatRepair }
          : { version: 1, reviewId: current.reviewId, revision: current.revision, state: current.state, stage: current.stage, candidateScope: current.candidateScope, reasons: current.reasons, canKeep: current.canKeep, canRetry: current.canRetry },
        detail: current
      };
      state.generationReviewError = "The review changed. Reloaded status before sending a decision.";
      return;
    }
    const request = decision === "repair_format"
      ? (current.version === 2 && current.canRepairFormat && current.formatRepair
        ? { reviewId: current.reviewId, revision: current.revision, decision, repairPlanHash: current.formatRepair.planHash }
        : null)
      : decision === "keep" && current.canKeep
        ? { reviewId: current.reviewId, revision: current.revision, decision }
        : decision === "retry" && current.canRetry
          ? { reviewId: current.reviewId, revision: current.revision, decision }
          : null;
    if (!request) {
      state.generationReviewError = "This review no longer offers that decision.";
      return;
    }
    await run.decideReview(request);
    // A live review remains on the existing stream. A rehydrated review has no
    // watcher, so reload only in that case to read its later durable state.
    if (!state.abortController) await loadCampaign(state.campaignId, { autoScroll: false });
  } catch (error) {
    state.generationReviewError = "Your decision could not be saved. The turn remains unchanged.";
    // A stale review decision is commonly caused by another open tab resolving
    // the same durable job. Re-read the authoritative campaign before showing
    // the local failure so an accepted or replacement turn wins immediately.
    if (error && typeof error === "object" && error.statusCode === 409 && state.campaignId) {
      await loadCampaign(state.campaignId, { autoScroll: false }).catch(() => undefined);
    }
  } finally {
    state.generationReviewSubmitting = false;
    if (state.generationRecovery) showGenerationRecovery(state.generationRecovery.id, "This turn needs your review");
  }
}

function resetGenerationStateForCampaignLoad() {
  state.abortController?.abort();
  state.abortController = null;
  state.pendingGeneration = null;
  state.generationRecovery = null;
  state.generationRun = null;
  state.generationDisplayActive = false;
  state.generationDisplayAction = "";
  state.generationJobId = null;
  state.cancellationConfirmed = false;
  state.characterProfileEditSession = null;
  characterProfileEditRequestToken += 1;
  clearStreamingPreview();
  hideGenerationRecovery();
}

async function monitorRecoveryJob(retryFirst) {
  const panel = $("generationRecoveryPanel");
  const jobId = panel?.dataset.jobId || state.pendingGeneration?.id;
  if (!jobId || state.busy) return;
  hideGenerationRecovery();
  showBusy(retryFirst ? "Retrying durable generation…" : "Resuming generation monitoring…");
  try {
    const run = state.generationRun || await composition.workflow.resume(state.campaignId);
    if (!run) throw new Error("No durable generation is available to resume.");
    state.generationRun = run;
    beginGenerationDisplay(state.pendingGeneration?.action || "");
    await observeGenerationRun(run, state.pendingGeneration?.action || "", retryFirst);
  } catch (error) {
    restoreGenerationDisplay();
    if (error.name === "AbortError") {
      toast("Generation cancelled.");
      recordActivity("system", "Generation cancelled");
    } else {
      toast(`Generation recovery failed: ${error.message}`);
    }
  } finally {
    hideBusy();
  }
}

async function discardRecoveryJob() {
  const panel = $("generationRecoveryPanel");
  const jobId = panel?.dataset.jobId || state.pendingGeneration?.id;
  if (!jobId || state.busy) return;
  showBusy("Discarding generation job…");
  try {
    const run = state.generationRun || await composition.workflow.resume(state.campaignId);
    if (!run) throw new Error("No active generation run is available to discard.");
    state.generationRun = run;
    await run.discardGeneration();
    clearPendingSubmission();
    state.pendingGeneration = null;
    hideGenerationRecovery();
    restoreGenerationDisplay();
    restoreRetainedAppendDraft();
    toast("Generation job discarded. The accepted turn was preserved.");
  } catch (error) {
    toast(`Could not discard generation: ${error.message}`);
  } finally {
    hideBusy();
  }
}

async function retryCompletedGenerationResult() {
  if (!state.generationRun || state.busy) return;
  showBusy("Loading the accepted turn…");
  try {
    await fetchCompletedGenerationResult(state.generationRun, {
      onCompleted: async (result) => {
        hideGenerationRecovery();
        await finalizeCompletedGeneration(result);
      },
      onResultUnavailable: (jobId) => {
        showGenerationRecovery(
          jobId,
          "The turn completed, but its result is still temporarily unavailable. Retry loading it.",
          "result"
        );
      }
    });
  } catch (error) {
    showGenerationRecovery(
      state.generationRun.jobId,
      `The accepted turn could not be loaded: ${error.message}`,
      "result"
    );
  } finally {
    hideBusy();
  }
}

async function finalizeCompletedGeneration(result) {
  await clearAcceptedActionDraft(result);
  if (state.campaignId === result.campaignId) setStorySyncStatus("Story syncing");
  const preserveViewport = Boolean($("streamingPreviewCard")) && !state.streamingAutoFollow;
  const viewport = preserveViewport
    ? { left: window.scrollX, top: window.scrollY }
    : null;

  clearPendingSubmission();
  state.retainedAppendDraft = null;
  composition.failedTurnPrompts?.clear(result.campaignId);
  state.pendingGeneration = null;
  // A completed result is authoritative even when its saved review was shown
  // from the same live monitor. Remove that now-resolved review before the
  // accepted turn replaces the streamed preview.
  hideGenerationRecovery();
  commitGenerationDisplay(false);
  recordActivity("success", "Turn generated", `Turn ${result.turnNumber || ""} completed.`);
  if (!replaceStreamingPreviewWithAcceptedTurn(result, preserveViewport)) {
    clearStreamingPreview();
    await loadCampaign(state.campaignId, { autoScroll: !preserveViewport });
    restoreViewportAfterRender(viewport);
    return;
  }
  await reconcileCompletedGeneration(result);
  await restoreActionDraftForCampaign(result.campaignId, campaignLoadSequence);

  restoreViewportAfterRender(viewport);

  pollImageJobs();
  if (result.resultTurnId) void pollIllustrationResolution(result.resultTurnId).catch(() => undefined);
}

function restoreViewportAfterRender(viewport) {
  if (!viewport) return;
  window.requestAnimationFrame(() => {
    window.scrollTo({ ...viewport, behavior: "auto" });
  });
}

function replaceStreamingPreviewWithAcceptedTurn(result, preserveViewport) {
  const preview = $("streamingPreviewCard");
  if (!preview || !result.resultTurnId) return false;

  const completedTurn = { ...result, id: result.resultTurnId, imageUrl: result.imageUrl ?? null };
  const wasContinuous = Boolean(state.user?.settings?.continuousReading);
  const acceptedTurns = state.turns
    .filter((turn) => turn.id !== result.resultTurnId && Number(turn.turnNumber) !== Number(result.turnNumber))
    .concat(completedTurn)
    .sort((left, right) => Number(left.turnNumber) - Number(right.turnNumber));
  publishStoryTurnWindow(acceptedTurns, state.historyNextCursor);
  const completedTurnIndex = state.turns.findIndex((turn) => turn.id === result.resultTurnId);
  if (completedTurnIndex < 0) return false;

  if (!preserveViewport) state.viewTurnNumber = null;
  if (wasContinuous) {
    if (state.continuousReader) {
      state.continuousReader = reconcileStoryAcceptedSceneReplacement(state.continuousReader, completedTurn);
    }
    if (!preserveViewport) {
      initializeContinuousReader({
        selectedReadIdentity: { turnNumber: Number(completedTurn.turnNumber), id: completedTurn.id },
        selectedTurn: completedTurn
      });
    }
    preview.remove();
    renderAllScenes({ autoScroll: false });
  } else {
    for (const scene of $("storyArea")?.querySelectorAll(".scene[data-turn-number]") || []) scene.remove();
    preview.replaceWith(renderScene(completedTurn, completedTurnIndex));
  }
  state.streamingAutoFollow = true;
  state.streamingExpectedScrollY = null;
  renderStoryIllustration();
  renderTurnInput();
  updateStatusBar();
  if (!preserveViewport) {
    const acceptedScene = $("scene-" + completedTurn.turnNumber);
    if (acceptedScene) scrollSceneIntoView(acceptedScene);
  }
  return true;
}

async function reconcileCompletedGeneration(result) {
  const campaignId = result.campaignId;
  const loadSequence = campaignLoadSequence;
  const sessionEpoch = actionDraftSessionEpoch;
  const windowEpoch = storyTurnWindowEpoch;
  const userId = state.user?.id;
  const isCurrent = () => state.campaignId === campaignId
    && campaignLoadSequence === loadSequence
    && actionDraftSessionEpoch === sessionEpoch
    && storyTurnWindowEpoch === windowEpoch
    && state.user?.id === userId;
  if (!isCurrent()) return;
  try {
    const syncData = await apiClient.generation.syncStatus(campaignId);
    if (!isCurrent()) return;
    state.campaign = syncData.campaign || syncData;
    state.world = syncData.world || state.campaign.world || null;
    state.playerConfig = syncData.playerConfig || state.campaign.playerConfig || null;
    state.pendingGeneration = syncData.pendingGeneration || null;
    state.generationRecovery = syncData.generationRecovery || null;
    syncTurnInputModeFromCampaign();
    const runtimeState = await apiClient.campaigns.state(campaignId);
    if (!isCurrent()) return;
    state.runtimeState = runtimeState;
    markEditStateStaleForCurrentRuntimeState(runtimeState);

    const titleEl = $("storyTitle");
    const name = state.campaign.title || state.world?.title || "Untitled Campaign";
    if (titleEl) titleEl.textContent = name;
    document.title = `${name} — Infinite Quest`;
    renderStoryIllustration();
    updateStatusBar();
    renderTurnInput();
    setStorySyncStatus("Story synced");
    void loadReaderIllustrations(campaignId, loadSequence);
  } catch (error) {
    if (!isCurrent()) return;
    setStorySyncStatus("Story sync delayed");
    recordActivity("error", "Completed turn reconciliation failed", error.message);
  }
}

async function observeGenerationRun(run, action, retryFirst = false) {
  state.generationJobId = run.jobId;
  if (!state.generationDisplayActive) beginGenerationDisplay(action);
  else renderStreamingPreview("", action || state.generationDisplayAction);
  pollImageJobs();
  let terminalError = null;
  let resultUnavailable = false;
  let lastSnapshot = null;
  await observeGenerationRunEvents(run, retryFirst, state, (events) => presentGenerationEvents(events, {
    onStatus: (snapshot) => {
      lastSnapshot = snapshot;
      updateGenerationProgress(snapshot);
      if (snapshot.review?.state === "decided" || snapshot.status === "completed") {
        state.generationReview = null;
      }
      if (snapshot.status === "recoverable" && snapshot.review) {
        const guidance = generationRecoveryGuidance(snapshot.diagnostic);
        const presentation = generationDiagnosticPresentation(snapshot.diagnostic);
        state.generationRecovery = snapshot;
        showGenerationRecovery(run.jobId, "This turn needs your review", "generation", guidance, presentation);
        renderTurnInput();
        void loadGenerationReview().finally(() => {
          if (state.generationRecovery?.id === run.jobId) {
            showGenerationRecovery(run.jobId, "This turn needs your review", "generation", guidance, presentation);
            renderTurnInput();
          }
        });
      }
    },
    onNarration: (text) => renderStreamingPreview(text, action || state.generationDisplayAction),
    onDegraded: (reason, failures) => recordActivity("system", "Generation monitoring degraded", `${reason} (${failures})`),
    onDetached: () => recordActivity("system", "Generation monitoring detached", `jobId=${run.jobId}`),
    onResultUnavailable: (jobId, error) => {
      showGenerationRecovery(
        jobId,
        "The turn completed, but its result is temporarily unavailable. Retry loading it.",
        "result"
      );
      renderTurnInput();
      recordActivity("system", "Completed turn result unavailable", error.message);
      resultUnavailable = true;
    },
    onCompleted: finalizeCompletedGeneration,
    onCancelled: async () => {
      terminalError = await reconcileRemoteGenerationCancellation({
        state,
        clearPendingSubmission,
        restoreGenerationDisplay,
        reloadCampaign: (campaignId) => loadCampaign(campaignId, { autoScroll: false }),
        toast
      });
    },
    onTerminalFailure: (error, outcome) => {
      clearPendingSubmission();
      state.pendingGeneration = null;
      if (lastSnapshot) state.generationRecovery = lastSnapshot;
      if (outcome === "unrecoverable") {
        const guidance = generationRecoveryGuidance(lastSnapshot?.diagnostic);
        const presentation = generationDiagnosticPresentation(lastSnapshot?.diagnostic);
        if (lastSnapshot?.review) {
          // A live review follows a terminal stream frame, so hydrate the saved
          // detail before presenting its explicit choices.
          state.generationRecovery = lastSnapshot;
          showGenerationRecovery(run.jobId, "This turn needs your review", "generation", guidance, presentation);
          void loadGenerationReview().finally(() => {
            if (state.generationRecovery?.id === run.jobId) {
              showGenerationRecovery(run.jobId, "This turn needs your review", "generation", guidance, presentation);
            }
          });
        } else {
          showGenerationRecovery(run.jobId, guidance?.message || "Generation is recoverable but needs your direction.", "generation", guidance, presentation);
        }
      }
      if (outcome === "failed" || (outcome === "unrecoverable" && lastSnapshot?.status === "failed")) {
        restoreRetainedAppendDraft();
      }
      terminalError = error;
    }
  }));
  if (terminalError) throw terminalError;
  return resultUnavailable ? "result_unavailable" : "settled";
}

function updateGenerationProgress(job) {
  const continuityReviewMessage = generationReviewTechnicalDiagnosticMessage(job.continuityReviewDiagnostic);
  if (continuityReviewMessage === "Retrying continuity review") {
    showBusy("Retrying continuity review…");
  }
  const stage = job.stage || job.status || "generating";
  if (continuityReviewMessage !== "Retrying continuity review") showBusy(`Story Engine: ${stage}…`);
  const progressEl = $("generationProgress");
  if (progressEl) {
    progressEl.classList.add("turn-progress");
    progressEl.classList.remove("generation-progress");

    const steps = [
      { id: "queued", label: "Queued" },
      { id: "prepare", label: "Reading state" },
      { id: "mechanics", label: "Resolving action" },
      { id: "scene", label: "Writing scene" },
      { id: "finalize", label: "Saving turn" }
    ];

    let currentIndex = 0;
    if (stage === "prepare" || stage === "assessing") currentIndex = 1;
    if (stage === "mechanics" || stage === "resolving") currentIndex = 2;
    if (stage === "generating" || stage === "scene") currentIndex = 3;
    if (stage === "completed" || stage === "finalize") currentIndex = 4;

    const currentStep = steps[currentIndex];
    const percent = Math.round(((currentIndex + 1) / steps.length) * 100);
    const detailText = continuityReviewMessage || `Story Engine: ${stage}`;

    progressEl.innerHTML = `
      <div class="turn-progress-head">
        <strong>${escapeHtml(currentStep.label)}</strong>
        <span class="turn-progress-step">Step ${currentIndex + 1} of ${steps.length}</span>
      </div>
      <progress class="turn-progress-meter" max="100" value="${percent}" aria-label="${escapeHtml(currentStep.label)}">${percent}%</progress>
      <div class="turn-progress-detail">${escapeHtml(detailText)}</div>
    `;
  }
}

async function resumePendingGeneration() {
  // Check sync-status for any in-flight generation jobs
  // A recoverable job is already rendered as an explicit recovery choice by
  // loadCampaign. Do not reattach to it during boot: doing so briefly marks
  // it as pending and prevents the player from retaining a new draft.
  if (!state.campaignId || !state.campaign || !state.pendingGeneration) return false;
  let completeButLoading = false;
  try {
    const run = await composition.workflow.resume(state.campaignId);
    if (run) {
      state.generationRun = run;
      state.pendingGeneration = { ...state.pendingGeneration, id: run.jobId };
      showBusy("Resuming pending generation…");
      recordActivity("system", "Resuming pending generation", `jobId=${run.jobId}`);
      beginGenerationDisplay(state.pendingGeneration.action || "", { preserveAcceptedScene: true });
      const progressEl = $("generationProgress");
      if (progressEl) progressEl.classList.remove("hidden");
      try {
        completeButLoading = await observeGenerationRun(run, state.pendingGeneration.action || "") === "result_unavailable";
        return true;
      } catch (error) {
        restoreGenerationDisplay();
        throw error;
      } finally {
        if (!completeButLoading) clearStreamingPreview();
        if (progressEl) progressEl.classList.add("hidden");
        hideBusy();
      }
    }
    clearPendingSubmission();
  } catch (_) { /* ignore — no pending job */ }
  return false;
}

// ── Status Bar ────────────────────────────────────────────────
function updateStatusBar() {
  const turnPill = $("turnPill");
  const viewPill = $("viewPill");
  if (turnPill) turnPill.textContent = `Turn ${state.campaign?.activeTurnNumber || 0}`;
  const isLatest = isViewingLatestTurn();
  if (viewPill) {
    viewPill.textContent = isLatest
      ? "Viewing Latest Turn"
      : `Viewing turn ${currentViewTurnNumber()}`;
  }
  const readerTurnCount = $("readerTurnCount");
  if (readerTurnCount) {
    const total = Math.max(Number(state.campaign?.activeTurnNumber || 0), latestTurnNumber(state.turns));
    readerTurnCount.textContent = total > 0 ? `Turn ${currentViewTurnNumber()} of ${total}` : "No turns yet";
  }
  syncContinuousReaderControls();
  syncInputState();
  syncReaderResumePrompt();
}

// ── History Navigation ────────────────────────────────────────
function navigateToTurn(turnNumber) {
  const latest = latestTurnNumber(state.turns);
  const target = turnNumber === null ? latest : Number(turnNumber);
  if (!target || turnIndexForNumber(state.turns, target) < 0) return;
  readerPositionInteractionEpoch += 1;
  retirePendingContinuousReaderRequest();
  readerPositionChoicePending = false;
  state.readerPinnedTurn = null;
  hideReaderResumePrompt();
  clearResponseEditSession();
  state.viewTurnNumber = target === latest ? null : target;
  syncReaderResumePrompt();
  const isContinuous = Boolean(state.user?.settings?.continuousReading);
  if (!isContinuous) {
    renderAllScenes();
  } else {
    const targetTurn = state.turns.find((turn) => Number(turn.turnNumber) === target) || null;
    const turnId = targetTurn?.id || targetTurn?.turnId;
    const resident = turnId && state.continuousReader?.turns?.some((turn) => turn.turnNumber === target && turn.id === turnId);
    if (target === latest || !resident) {
      initializeContinuousReader(targetTurn ? {
        selectedReadIdentity: { turnNumber: Number(targetTurn.turnNumber), id: turnId },
        selectedTurn: targetTurn
      } : {});
      renderAllScenes({ autoScroll: false });
    } else if (state.continuousReader) {
      initializeContinuousReader({
        selectedReadIdentity: { turnNumber: target, id: turnId },
        selectedTurn: targetTurn
      });
      renderAllScenes({ autoScroll: false });
    }
  }
  updateStatusBar();
  scrollToView();
  scheduleReaderPositionSave();
}

async function loadOlderTurnPage() {
  if (!state.historyNextCursor || state.busy) return false;
  const campaignId = state.campaignId;
  const epoch = storyTurnWindowEpoch;
  const requestedCursor = state.historyNextCursor;
  const turns = state.turns;
  showBusy("Loading older turns…");
  try {
    const page = await apiClient.campaigns.turns(campaignId, { before: requestedCursor });
    if (!storyTurnWindowIsCurrent(campaignId, epoch, requestedCursor)) return false;
    if (page.campaignId !== campaignId) {
      throw new Error(`Story history page belongs to ${page.campaignId}.`);
    }
    const mergedTurns = mergeStoryTurnPages(turns, page.turns || []);
    publishStoryTurnWindow(mergedTurns, page.nextCursor || null);
    if (mergedTurns.length === turns.length) return false;
    renderAllScenes();
    updateStatusBar();
    return true;
  } catch (error) {
    if (!storyTurnWindowIsCurrent(campaignId, epoch, requestedCursor)) return false;
    toast(`Unable to load older turns: ${error.message}`);
    recordActivity("error", "Older turn page failed", error.message);
    return false;
  } finally {
    hideBusy();
  }
}

async function goToPrevious() {
  const curr = viewedTurnIndex();
  if (state.busy || state.turns.length === 0) return;
  if (state.readerPinnedTurn) return;
  if (curr <= 0) {
    if (!await loadOlderTurnPage()) return;
    const viewedIndex = viewedTurnIndex();
    if (viewedIndex > 0) navigateToTurn(state.turns[viewedIndex - 1]?.turnNumber ?? null);
    return;
  }
  navigateToTurn(state.turns[curr - 1]?.turnNumber ?? null);
}

function goToNext() {
  const curr = viewedTurnIndex();
  const isLatest = isViewingLatestTurn();
  if (state.busy || state.turns.length === 0 || isLatest) return;
  if (state.readerPinnedTurn) return navigateToTurn(null);
  if (curr < state.turns.length - 1) navigateToTurn(state.turns[curr + 1]?.turnNumber ?? null);
  else navigateToTurn(null);
}

async function undoLatest() {
  const isLatest = isViewingLatestTurn();
  if (state.busy || state.turns.length === 0 || !isLatest) return;
  if (!confirm("Undo the last turn? This rewinds the campaign and cannot be reversed.")) return;
  showBusy("Rewinding…");
  try {
    const targetTurnNumber = undoTargetTurnNumber(state.campaign);
    await apiClient.campaigns.rewind(state.campaignId, { targetTurnNumber });
    recordActivity("system", "Turn undone", `Rewound to turn ${targetTurnNumber}.`);
    await loadCampaign(state.campaignId);
    toast("Last turn removed.");
  } catch (err) {
    toast(`Undo failed: ${err.message}`);
    recordActivity("error", "Undo failed", err.message);
  } finally {
    hideBusy();
  }
}

async function retryLatest() {
  const isLatest = isViewingLatestTurn();
  const lastTurnHasAction = state.turns.length > 0 && Boolean(state.turns[state.turns.length - 1] && state.turns[state.turns.length - 1].action);
  if (state.busy || state.turns.length === 0 || !isLatest || !lastTurnHasAction) return;
  const lastAction = state.turns[state.turns.length - 1].action;
  openRetryPromptDialog(lastAction);
}

function openRetryPromptDialog(originalPrompt) {
  const dialog = $("retryPromptDialog");
  const editor = $("retryPromptEditor");
  if (!dialog || !editor || typeof dialog.showModal !== "function") {
    const editedPrompt = prompt("Edit the prompt text before retrying:", originalPrompt || "");
    if (editedPrompt !== null) executeRetryWithPrompt(editedPrompt);
    return;
  }
  editor.value = originalPrompt || "";
  syncStoryLengthOverrideControls();
  setStoryLengthOverride("retryStoryLengthProfileOverride", "");
  openManagedModal(dialog);
  setTimeout(() => {
    editor.focus();
    editor.select();
  }, 40);
}

function closeRetryPromptDialog() {
  const dialog = $("retryPromptDialog");
  if (dialog?.hasAttribute("open")) dialog.close();
}

async function executeRetryWithPrompt(submittedPromptText) {
  const isLatest = isViewingLatestTurn();
  if (state.busy || state.turns.length === 0 || !isLatest) return;
  const action = String(submittedPromptText || "").trim();
  if (!action) {
    toast("Turn prompt cannot be empty.");
    const editor = $("retryPromptEditor");
    if (editor) editor.focus();
    return;
  }

  const currentTurnNumber = latestTurnNumber(state.turns);
  if (!currentTurnNumber) return;
  const originalTurn = state.turns.at(-1) || {};
  const resolvedInputMode = originalTurn.resolvedInputMode || originalTurn.inputMode || "action";
  const storyLengthProfileOverride = selectedStoryLengthOverride("retryStoryLengthProfileOverride");
  await runGeneration(action, {
    operationKind: "replace_latest",
    expectedCurrentTurnNumber: currentTurnNumber,
    requestedInputMode: originalTurn.requestedInputMode || resolvedInputMode,
    resolvedInputMode,
    inputModeSource: originalTurn.inputModeSource || "explicit",
    storyLengthProfileOverride,
    onAttached: closeRetryPromptDialog
  });
}

function promptBranchOrReset(turnNumber) {
  const dlg = $("branchStoryDialog");
  if (!dlg) return;
  const targetTurnNumber = Number(turnNumber);
  const isSelectedPreview = Number(state.historyWindow?.selectedPreview?.turnNumber) === targetTurnNumber;
  if (!targetTurnNumber || (turnIndexForNumber(state.turns, targetTurnNumber) < 0 && !isSelectedPreview)) return;
  const msg = $("branchStoryMessage");
  if (msg) msg.textContent = `You selected Turn ${targetTurnNumber} (of ${state.campaign?.activeTurnNumber || 0}). Choose what should happen to later turns before continuing.`;
  dlg._targetTurnNumber = targetTurnNumber;
  openManagedModal(dlg);
}

// ── Illustration Management ───────────────────────────────────
function illustrationLoadError(error) {
  return error?.name === "ApiContractError"
    ? "The server returned invalid illustration data. Refresh to try again."
    : "Illustration status could not be loaded. Refresh to try again.";
}

async function refreshIllustrations() {
  if (!state.campaignId) return;
  await loadReaderIllustrations(state.campaignId, campaignLoadSequence);
}

function pollImageJobs({ initialSegments = null } = {}) {
  if (!state.campaignId) return;
  const campaignId = state.campaignId;
  const loadSequence = campaignLoadSequence;
  let poll = activeImagePoll;
  if (!poll || poll.stopped || poll.campaignId !== campaignId || poll.loadSequence !== loadSequence) {
    if (poll?.timer) {
      clearTimeout(poll.timer);
      if (state.imagePollTimer === poll.timer) state.imagePollTimer = null;
    }
    if (poll) poll.stopped = true;
    poll = {
      campaignId,
      loadSequence,
      epoch: ++state.imagePollEpoch,
      failures: 0,
      initialSegments,
      seedRevision: initialSegments === null ? 0 : 1,
      timer: null,
      inFlight: null,
      stopped: false
    };
    activeImagePoll = poll;
  } else if (initialSegments !== null) {
    poll.initialSegments = initialSegments;
    poll.seedRevision += 1;
  }

  const current = () => activeImagePoll === poll && !poll.stopped
    && state.campaignId === poll.campaignId && state.imagePollEpoch === poll.epoch
    && campaignLoadSequence === poll.loadSequence;
  const schedule = (delay) => {
    if (!current() || poll.timer) return;
    const timer = setTimeout(() => {
      if (poll.timer === timer) poll.timer = null;
      if (state.imagePollTimer === timer) state.imagePollTimer = null;
      if (current()) void runPoll();
    }, delay);
    poll.timer = timer;
    state.imagePollTimer = timer;
  };
  const runPoll = () => {
    if (!current()) return Promise.resolve();
    if (poll.inFlight) return poll.inFlight;
    if (poll.timer) {
      clearTimeout(poll.timer);
      if (state.imagePollTimer === poll.timer) state.imagePollTimer = null;
      poll.timer = null;
    }
    const seedRevisionAtStart = poll.seedRevision;
    const work = (async () => {
      try {
        if (!state.illustrationConfig) {
          const config = await illustrationApi.config(poll.campaignId);
          if (!current()) return;
          state.illustrationConfig = config;
        }
        const data = await illustrationApi.imageJobs(poll.campaignId);
        if (!current()) return;
        const jobs = data.jobs || data || [];
        let segments;
        if (poll.initialSegments !== null) {
          segments = poll.initialSegments;
          poll.initialSegments = null;
        } else {
          const segmentData = await illustrationApi.segments(poll.campaignId);
          if (!current()) return;
          if (poll.seedRevision !== seedRevisionAtStart && poll.initialSegments !== null) {
            segments = poll.initialSegments;
            poll.initialSegments = null;
          } else {
            segments = segmentData.segments || [];
          }
        }
        if (!current()) return;
        poll.failures = 0;
        state.illustrationError = null;
        let anyPending = false;
        state.illustrationSegments = segments;
        renderStoryIllustration({ skipIfUnchanged: true });
        for (const job of jobs) {
          recordImageJobActivity(job, { suppress: !state.imageActivityInitialized });
          renderSceneImageJob(job);
          if (["queued", "generating", "provider_pending", "downloading"].includes(job.status)) anyPending = true;
        }
        for (const segment of segments) {
          recordIllustrationSegmentActivity(segment, { suppress: !state.imageActivityInitialized });
          if (["queued", "refining", "generating"].includes(segment.status)
            || ["queued", "refining", "recoverable"].includes(segment.promptJobStatus)) anyPending = true;
        }
        state.imageActivityInitialized = true;
        if (anyPending) {
          schedule(IMAGE_POLL_MS);
        } else {
          poll.stopped = true;
        }
      } catch (error) {
        if (!current()) return;
        state.illustrationError = illustrationLoadError(error);
        renderStoryIllustration({ skipIfUnchanged: true });
        if (error?.name !== "ApiContractError" && ++poll.failures < 3) {
          schedule(IMAGE_POLL_MS * poll.failures);
        } else {
          poll.stopped = true;
        }
      } finally {
        poll.inFlight = null;
      }
    })();
    poll.inFlight = work;
    return work;
  };
  return runPoll();
}

function recordIllustrationSegmentActivity(segment, options = {}) {
  if (!segment?.id) return;
  const signature = [
    segment.status || "",
    segment.promptJobStatus || "",
    segment.promptSource || "",
    segment.imageJobStatus || "",
    segment.variants?.length || 0
  ].join(":");
  if (state.illustrationSegmentActivity.get(segment.id) === signature) return;
  state.illustrationSegmentActivity.set(segment.id, signature);
  if (options.suppress) return;
  const turnIndex = state.turns.findIndex((turn) => (turn.id || turn.turnId) === segment.turnId);
  const turn = state.turns[turnIndex];
  const detail = turn
    ? `turn=${turn.turnNumber} · segment=${segment.ordinal + 1} · prompt=${segment.promptSource || "direct"} · status=${segment.status}`
    : `turnId=${segment.turnId || "unknown"} · segment=${segment.ordinal + 1} · prompt=${segment.promptSource || "direct"} · status=${segment.status}`;
  if (segment.promptJobStatus === "refining") {
    recordActivity("image", "Refining segment illustration prompt", detail);
  } else if (segment.promptSource === "ai_fallback") {
    recordActivity("image", "Segment prompt used direct fallback", detail);
  } else if (segment.status === "completed") {
    recordActivity("success", "Illustration segment completed", `${detail} · variants=${segment.variants?.length || 0}`);
  } else if (segment.status === "failed" || segment.status === "recoverable") {
    recordActivity("error", "Illustration segment failed", `${detail} · ${segment.errorMessage || ""}`);
  }
}

function recordImageJobActivity(job, options = {}) {
  if (!job?.id) return;
  const progress = Number(job.providerProgress);
  const progressBucket = Number.isFinite(progress) ? Math.floor(Math.max(0, Math.min(100, progress)) / 10) * 10 : null;
  const signature = [
    job.status || "",
    job.providerStatus || "",
    progressBucket ?? "",
    job.providerQueuePosition ?? "",
    job.errorCode || "",
    job.assetId || job.assetUrl || ""
  ].join(":");
  if (state.imageJobActivity.get(job.id) === signature) return;
  state.imageJobActivity.set(job.id, signature);
  if (options.suppress) return;

  const turnIndex = state.turns.findIndex((turn) => (turn.id || turn.turnId) === job.turnId);
  const turn = state.turns[turnIndex];
  const turnDetail = turn ? `turn=${turn.turnNumber}` : `turnId=${job.turnId || "unknown"}`;
  const detail = [
    turnDetail,
    `jobId=${job.id}`,
    `status=${job.status || "queued"}`,
    job.providerStatus ? `providerStatus=${job.providerStatus}` : "",
    Number.isFinite(progress) ? `progress=${Math.round(progress)}%` : "",
    Number.isInteger(job.providerQueuePosition) ? `queue=${job.providerQueuePosition}` : "",
    job.requestedModel ? `model=${job.requestedModel}` : "",
    job.errorMessage ? `error=${job.errorMessage}` : ""
  ].filter(Boolean).join(" · ");

  if (job.status === "completed") {
    recordActivity("success", "Illustration generated", detail);
  } else if (["recoverable", "failed", "cancelled", "expired"].includes(job.status)) {
    recordActivity("error", "Illustration generation failed", detail);
  } else if (job.status === "queued") {
    recordActivity("image", "Illustration generation queued", detail);
  } else {
    recordActivity("image", "Illustration generation progress", detail);
  }
}

function imageJobStatusText(job) {
  const stage = String(job.providerStatus || job.status || "queued").replaceAll("_", " ");
  const progress = Number(job.providerProgress);
  const percentage = Number.isFinite(progress) ? ` · ${Math.round(progress)}%` : "";
  const queue = Number.isInteger(job.providerQueuePosition) ? ` · queue ${job.providerQueuePosition}` : "";
  const etaAt = job.providerEtaAt ? new Date(job.providerEtaAt).getTime() : Number.NaN;
  const etaSeconds = Number.isFinite(etaAt) ? Math.max(0, Math.ceil((etaAt - Date.now()) / 1000)) : null;
  const eta = etaSeconds === null ? "" : ` · about ${etaSeconds}s remaining`;
  return `${stage}${percentage}${queue}${eta}`;
}

function renderSceneImageJob(job) {
  const isStreaming = job.targetType === "streaming_illustration";
  if (!job.turnId && !isStreaming) return;
  if (isStreaming && job.generationJobId !== state.generationJobId) return;
  if (job.status === "completed" && job.assetUrl) {
    if (job.segmentId) return;
    if (isStreaming) return;
    updateSceneImage(job.turnId, job.assetUrl, true);
    return;
  }
  const turnIdx = job.turnId ? state.turns.findIndex((turn) => (turn.id || turn.turnId) === job.turnId) : -1;
  const turn = state.turns[turnIdx];
  
  let segmentContent = null;
  if (isStreaming) {
    if (!state.generationDisplayActive) return;
    const container = $("streamingPreviewCard")?.querySelector(".streaming-illustrations");
    if (container && job.segmentId) {
      segmentContent = container.querySelector(`.segment-illustration-content[data-segment-id="${escapeHtml(job.segmentId)}"]`);
      if (!segmentContent) {
        segmentContent = document.createElement("div");
        segmentContent.className = "segment-illustration-content streaming-segment";
        segmentContent.dataset.segmentId = job.segmentId;
        container.appendChild(segmentContent);
      }
    }
  } else if (job.segmentId) {
    segmentContent = [...document.querySelectorAll(".segment-illustration-content[data-segment-id]")]
      .find((element) => element.dataset.segmentId === job.segmentId);
  }

  if (turnIdx < 0 && !isStreaming) return;
  if (!illustrationsEnabled()) return;
  if (state.generationDisplayActive && !isStreaming) return;
  if (job.segmentId && !segmentContent) return;
  if (!job.segmentId && turnIdx !== viewedTurnIndex()) return;
  const terminalFailure = ["recoverable", "failed", "cancelled", "expired"].includes(job.status);
  const active = ["queued", "generating", "provider_pending", "downloading"].includes(job.status);
  if (!terminalFailure && !active) return;
  const content = segmentContent || $("storyIllustrationContent");
  let imageWrap = content?.querySelector(".image-wrap");
  if (!imageWrap) {
    imageWrap = document.createElement("div");
    imageWrap.className = "image-wrap image-job-placeholder";
    content?.appendChild(imageWrap);
  }
  let status = imageWrap.querySelector(".image-job-status");
  if (!status) {
    status = document.createElement("div");
    status.className = imageWrap.querySelector("img") ? "image-job-status image-job-overlay" : "image-job-status";
    imageWrap.appendChild(status);
  }
  const labelText = terminalFailure
    ? (job.errorMessage || "Illustration generation did not complete.")
    : `Creating illustration · ${imageJobStatusText(job)}`;
  const progressValue = Number(job.providerProgress);
  const renderedProgress = Number.isFinite(progressValue) ? Math.max(0, Math.min(100, progressValue)) : null;
  const signature = JSON.stringify({
    jobId: job.id,
    status: job.status,
    providerStatus: job.providerStatus || null,
    providerProgress: renderedProgress,
    providerQueuePosition: Number.isInteger(job.providerQueuePosition) ? job.providerQueuePosition : null,
    errorMessage: terminalFailure ? job.errorMessage || "Illustration generation did not complete." : null,
    turnNumber: active ? turn?.turnNumber ?? null : null,
    terminalFailure,
    active
  });
  const existingLabel = status.querySelector("p");
  const existingProgress = status.querySelector("progress");
  const existingRetry = status.querySelector('[type="button"]');
  if (imageJobRenderSignatures.get(status) === signature
    && existingLabel
    && (active ? Boolean(existingProgress) : terminalFailure ? Boolean(existingRetry) : !existingProgress && !existingRetry)) {
    if (existingLabel.textContent !== labelText) existingLabel.textContent = labelText;
    if (active && existingProgress) {
      const nextProgressValue = renderedProgress ?? 0;
      if (existingProgress.value !== nextProgressValue) existingProgress.value = nextProgressValue;
    }
    return;
  }
  status.replaceChildren();
  const label = document.createElement("p");
  label.textContent = labelText;
  status.append(label);
  if (active) {
    const progress = document.createElement("progress");
    progress.max = 100;
    if (renderedProgress !== null) progress.value = renderedProgress;
    progress.setAttribute("aria-label", `Illustration generation progress for turn ${turn?.turnNumber ?? "unknown"}`);
    status.append(progress);
  } else if (terminalFailure) {
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "small ghost";
    retry.textContent = "Retry illustration";
    retry.addEventListener("click", async () => {
      retry.disabled = true;
      try {
        const queued = await illustrationApi.retryImageJob(job.id);
        recordImageJobActivity(queued);
        renderSceneImageJob(queued);
        pollImageJobs();
      } catch (error) {
        toast(`Illustration retry failed: ${error.message}`);
        retry.disabled = false;
      }
    });
    status.append(retry);
  }
  imageJobRenderSignatures.set(status, signature);
}

function updateSceneImage(turnId, assetUrl, replace = false) {
  if (!turnId || !assetUrl) return;
  // Find the turn index
  const turnIdx = state.turns.findIndex(t => (t.id || t.turnId) === turnId);
  if (turnIdx < 0) return;
  const previousAssetUrl = state.turns[turnIdx].imageAssetUrl || state.turns[turnIdx].imageUrl;
  state.turns[turnIdx].imageAssetUrl = assetUrl;
  if (turnIdx === viewedTurnIndex() && previousAssetUrl !== assetUrl) renderStoryIllustration();
}

function openImagePromptEditor(turnId) {
  const turnIdx = state.turns.findIndex(t => (t.id || t.turnId) === turnId);
  if (turnIdx < 0) return;
  const turn = state.turns[turnIdx];
  const dlg = $("imagePromptDialog");
  const editor = $("imagePromptEditor");
  if (!dlg || !editor) return;
  editor.value = turn.imagePrompt || "";
  dlg._turnId = turnId;
  openManagedModal(dlg);
}

function segmentVariant(segmentId, variantIndex) {
  const segment = state.illustrationSegments.find((item) => item.id === segmentId);
  if (!segment) return { segment: null, variant: null };
  const variant = (segment.variants || []).find((item) => item.variantIndex === variantIndex)
    || segment.variants?.[variantIndex]
    || null;
  return { segment, variant };
}

function openSegmentImagePromptEditor(segmentId, variantIndex) {
  const { segment, variant } = segmentVariant(segmentId, variantIndex);
  const dlg = $("imagePromptDialog");
  const editor = $("imagePromptEditor");
  if (!segment || !dlg || !editor) return;
  editor.value = variant?.prompt || segment.resolvedPrompt || segment.directPrompt || "";
  dlg._turnId = null;
  dlg._segmentId = segmentId;
  dlg._variantIndex = variantIndex;
  const title = $("imagePromptDialogTitle");
  if (title) title.textContent = `Segment ${segment.ordinal + 1} · Image ${variantIndex + 1} prompt`;
  openManagedModal(dlg);
}

async function regenerateSegmentImage(segmentId, variantIndex, prompt) {
  const { segment, variant } = segmentVariant(segmentId, variantIndex);
  const effectivePrompt = String(prompt || variant?.prompt || segment?.resolvedPrompt || segment?.directPrompt || "").trim();
  if (!segment || !effectivePrompt) return toast("This segment does not have a valid illustration prompt.");
  try {
    showBusy(`Queueing segment ${segment.ordinal + 1}, image ${variantIndex + 1}…`);
    const queued = await illustrationApi.regenerateSegmentImage(segmentId, { prompt: effectivePrompt, variantIndex });
    recordImageJobActivity(queued);
    pollImageJobs();
    toast(`Segment ${segment.ordinal + 1}, image ${variantIndex + 1} queued.`);
  } catch (error) {
    toast(`Could not regenerate this image: ${error.message}`);
    recordActivity("error", "Segment illustration regeneration failed", error.message);
  } finally {
    hideBusy();
  }
}

function whySegmentImage(segmentId, variantIndex) {
  const { segment, variant } = segmentVariant(segmentId, variantIndex);
  if (!segment) return;
  const promptLabels = {
    direct: "Direct prompt from the accepted segment",
    ai_refined: "AI-refined prompt from the accepted segment",
    ai_fallback: "Direct fallback after prompt refinement failed",
    legacy: "Legacy turn illustration prompt"
  };
  const details = [
    `Turn segment: ${segment.ordinal + 1}.`,
    `Image variant: ${variantIndex + 1}.`,
    `Prompt source: ${promptLabels[segment.promptSource] || segment.promptSource || "Unknown"}.`,
    variant?.selectionReason ? `Selection: ${variant.selectionReason}.` : (variant?.providerType ? "Selection: generated specifically for this segment." : ""),
    variant?.matchScore == null ? "" : `Library match score: ${Number(variant.matchScore).toFixed(3)}${variant.matchThreshold == null ? "" : ` against ${Number(variant.matchThreshold).toFixed(3)}`}.`,
    variant?.matchingAlgorithm ? `Matching method: ${variant.matchingAlgorithm}.` : "",
    variant?.providerType ? `Provider: ${variant.providerType}.` : "",
    variant?.model ? `Model: ${variant.model}.` : "",
    variant?.createdAt ? `Attached: ${new Date(variant.createdAt).toLocaleString()}.` : "",
    `Source range: words ${segment.startWord + 1}–${segment.endWord}.`,
    "Prompt used:",
    variant?.prompt || segment.resolvedPrompt || segment.directPrompt || "Prompt provenance is unavailable for this retained image."
  ].filter(Boolean).join("\n");
  showMessage("Why this image?", details);
}

async function generateTurnSegments(turnId, mode = "missing") {
  if (!turnId || state.busy) return;
  showBusy(mode === "rebuild" ? "Rebuilding illustration segments…" : "Creating illustration segments…");
  try {
    const result = await illustrationApi.generateTurnSegments(turnId, {
      mode,
      idempotencyKey: composition.idFactory.create()
    });
    const segmentData = await illustrationApi.segments(state.campaignId);
    state.illustrationSegments = segmentData.segments || [];
    renderAllScenes({ autoScroll: false });
    pollImageJobs();
    recordActivity("image", mode === "rebuild" ? "Turn illustration segments rebuilt" : "Turn illustration segments queued",
      `turnId=${turnId} · segments=${result.segmentCount || 0}`);
    toast(mode === "rebuild" ? "Turn illustration segments rebuilt." : "Turn illustrations queued.");
  } catch (error) {
    toast(`Could not queue turn illustrations: ${error.message}`);
    recordActivity("error", "Turn illustration segmentation failed", error.message);
  } finally {
    hideBusy();
  }
}

function showMessage(title, message) {
  const dialog = $("messagePopupDialog");
  if (!dialog) return toast(message);
  $("messagePopupTitle").textContent = title;
  $("messagePopupBody").textContent = message;
  if (dialog.open) dialog.close();
  openManagedModal(dialog);
}

async function whyIllustration(turnId) {
  try {
    const resolution = await illustrationApi.resolution(turnId);
    const candidate = resolution.candidates?.[0];
    const details = [
      `Outcome: ${resolution.reasonCode || resolution.status}.`,
      `Policy: ${resolution.sourcePolicy}; scope: ${resolution.matchingScope}; confidence: ${resolution.confidenceProfile}.`,
      resolution.selectedScore == null ? "" : `Selected score ${Number(resolution.selectedScore).toFixed(3)} against threshold ${Number(resolution.resolvedThreshold).toFixed(3)}.`,
      candidate?.scoreComponents ? `Evidence: ${Object.entries(candidate.scoreComponents).map(([key, value]) => `${key}=${typeof value === "number" ? value.toFixed(3) : value}`).join(", ")}.` : ""
    ].filter(Boolean).join("\n");
    showMessage("Why this image?", details);
  } catch (error) {
    toast(error.message || "No automatic match evidence is available for this image.");
  }
}

async function pollIllustrationResolution(turnId) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const resolution = await illustrationApi.resolution(turnId);
    if (resolution.status === "completed" && resolution.selectedAssetId) {
      updateSceneImage(turnId, `/api/v1/assets/${resolution.selectedAssetId}`, true);
      toast("Selected another library match.");
      return;
    }
    if (resolution.status === "no_match") return toast("No other library image met the confidence threshold.");
    if (resolution.status === "generation_queued") { pollImageJobs(); return; }
    if (resolution.status === "failed") return toast(`Image matching failed: ${resolution.reasonCode || "unknown error"}.`);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  toast("Image matching is still running.");
}

async function findAnotherLibraryMatch(turnId) {
  try {
    await illustrationApi.rematch(turnId);
    toast("Searching for another retained match.");
    void pollIllustrationResolution(turnId);
  } catch (error) {
    toast(error.message || "This image was not selected by automatic library matching.");
  }
}

// ── Edit State Dialog ─────────────────────────────────────────
async function openEditState() {
  const dlg = $("editStateDialog");
  if (!dlg || !state.campaignId) return;
  const recoveryPanel = $("generationRecoveryPanel");
  const recoveryVisible = Boolean(recoveryPanel && !recoveryPanel.classList.contains("hidden"));
  if (state.busy || state.pendingGeneration || recoveryVisible) {
    toast("Finish or resolve the active generation before editing current state.");
    return;
  }
  const campaignId = state.campaignId;
  try {
    showBusy("Loading current state…");
    const editableRuntimeState = await apiClient.campaigns.state(campaignId);
    if (state.campaignId !== campaignId) return;
    const base = captureCampaignStateEditSession(editableRuntimeState);
    if (!base.isCurrent || base.viewedTurnNumber !== base.activeTurnNumber) {
      throw new Error("The server did not return the current campaign state.");
    }
    state.runtimeState = editableRuntimeState;
    state.editStateSession = {
      id: `edit-state:${++nextEditStateSessionId}`,
      campaignId,
      base,
      draft: createCampaignContinuityDraft(base),
      trackers: (base.trackers || []).map(tracker => ({ ...tracker })),
      stale: false,
      saving: false
    };
    renderCurrentRuntimeState();
    switchEditStateTab("overview");
    openManagedModal(dlg);
    syncInputState();
  } catch (err) {
    toast(`State could not be loaded: ${err.message}`);
  } finally {
    hideBusy();
  }
}

function switchEditStateTab(tabName) {
  document.querySelectorAll("#editStateDialog .tab").forEach(t => {
    t.classList.toggle("active", t.dataset.tab === tabName);
  });
  ["overview", "scratch", "trackers", "mechanics"].forEach(sectionTab => {
    const el = $(`tab-${sectionTab}`);
    if (el) el.classList.toggle("hidden", sectionTab !== tabName);
  });
}

function renderTextCollection(containerId, values, emptyText) {
  const container = $(containerId);
  if (!container) return;
  container.innerHTML = values && values.length
    ? values.map(value => `<div>• ${escapeHtml(String(value))}</div>`).join("")
    : `<span class="dim">${escapeHtml(emptyText)}</span>`;
}

function renderCurrentRuntimeState() {
  const session = state.editStateSession;
  if (!session) return;
  const runtime = session.base;
  updateEditStateMetadata(session);
  const summary = $("editStateContinuitySummary");
  if (summary) summary.value = session.draft.continuitySummary;
  renderEditableStateCollection(document, $("editStateOpenThreads"), session.draft.openThreads, "thread");
  renderEditableStateCollection(document, $("editStateCanonicalFacts"), session.draft.canonicalFacts, "fact");

  const scratchpad = $("scratchpadEditor");
  if (scratchpad) scratchpad.value = session.draft.scratchpad;
  updateScratchpadCharacterCount();
  renderTrackerEditor();
  renderRpgStatsInEditState();
  renderTextCollection("editStateEventTriggers", (runtime.eventTriggers || []).map(trigger => trigger.label || trigger.name || trigger.id || "Unnamed trigger"), "No event triggers configured.");
  renderTextCollection("editStatePendingTriggers", (runtime.pendingEventTriggers || []).map(trigger => trigger.name || trigger.label || trigger.instructions || trigger.id || "Pending trigger"), "No pending triggers.");
}

function updateEditStateMetadata(session) {
  const meta = $("editStateMeta");
  if (!meta) return;
  const runtime = session.base;
  meta.textContent = session.stale
    ? `Current state changed after turn ${runtime.activeTurnNumber || 0} · revision ${runtime.revision || 0}. Reload before saving.`
    : `Current authoritative state after turn ${runtime.activeTurnNumber || 0} · revision ${runtime.revision || 0}`;
}

function markEditStateStaleForCurrentRuntimeState(runtimeState) {
  const session = state.editStateSession;
  if (!session || session.campaignId !== state.campaignId || !runtimeState) return;
  if (Number(runtimeState.activeTurnNumber) > Number(session.base.activeTurnNumber)
    || Number(runtimeState.revision) > Number(session.base.revision)) {
    session.stale = true;
    updateEditStateMetadata(session);
  }
}

function updateScratchpadCharacterCount() {
  const editor = $("scratchpadEditor");
  const count = $("scratchpadCharacterCount");
  if (count) count.textContent = `${editor ? editor.value.length : 0} characters`;
}

function renderTrackerEditor() {
  const container = $("trackerList");
  if (!container) return;
  const trackers = state.editStateSession?.trackers || [];
  container.innerHTML = trackers.length ? "" : `<p class="dim mini">No current trackers.</p>`;
  trackers.forEach(tracker => {
    const card = document.createElement("div");
    card.className = "track-card runtime-tracker-card";
    card.dataset.trackerId = tracker.id;
    card.innerHTML = `
      <label>Name<input data-field="name" value="${escapeAttribute(tracker.name || "")}" /></label>
      <label>Current value<textarea data-field="value">${escapeHtml(tracker.value || "")}</textarea></label>
      <label>Update rules<textarea data-field="rules">${escapeHtml(tracker.rules || "")}</textarea></label>
      <button type="button" class="small danger" data-action="remove-tracker">Remove tracker</button>
    `;
    const remove = card.querySelector('[data-action="remove-tracker"]');
    if (remove) remove.addEventListener("click", () => {
      if (!state.editStateSession) return;
      state.editStateSession.trackers = state.editStateSession.trackers.filter(item => item.id !== tracker.id);
      renderTrackerEditor();
    });
    container.appendChild(card);
  });
}

function collectTrackerEditorValues() {
  return [...document.querySelectorAll("#trackerList .runtime-tracker-card")].map(card => ({
    id: card.dataset.trackerId,
    name: card.querySelector('[data-field="name"]')?.value.trim() || "",
    value: card.querySelector('[data-field="value"]')?.value || "",
    rules: card.querySelector('[data-field="rules"]')?.value || ""
  })).filter(tracker => tracker.name);
}

function addTrackerFromEditor() {
  if (!state.editStateSession) return;
  const name = $("trackerName")?.value.trim() || "";
  if (!name) {
    toast("Tracker name is required.");
    return;
  }
  state.editStateSession.trackers = [
    ...collectTrackerEditorValues(),
    {
      id: composition.idFactory.create(),
      name,
      value: $("trackerValue")?.value || "",
      rules: $("trackerRules")?.value || ""
    }
  ];
  ["trackerName", "trackerValue", "trackerRules"].forEach(id => { const input = $(id); if (input) input.value = ""; });
  renderTrackerEditor();
}

function renderRpgStatsInEditState() {
  const container = $("editStateRpgStats");
  if (!container) return;
  const stats = state.editStateSession?.base.rpgStats || [];
  container.innerHTML = stats.length
    ? `<div class="stat-block">${stats.map(stat => `<span class="stat-pill"><strong>${escapeHtml(stat.name || stat.id || "Stat")}</strong> ${escapeHtml(String(stat.value ?? ""))}</span>`).join("")}</div>`
    : `<p class="dim mini">No RPG stats configured for this campaign.</p>`;
}

function openActivityLog() {
  renderActivityLog();
  const d = $("activityLogDialog");
  openManagedModal(d);
}

const STORY_MEMORY_LEVELS = new Set(["off", "standard", "enhanced", "max"]);

function storyMemoryDescription(settings) {
  if (settings.level === "max" && settings.reviewMode === "enforce") {
    return "Max reviews continuity before accepting each future turn, repairs eligible issues, and blocks unresolved conflicts. Story context budget remains separate.";
  }
  if (settings.level === "max") return `Max continuity review is currently in ${settings.reviewMode} mode. It applies to future turns; Story context budget remains separate.`;
  return `Saved level: ${settings.level}. It applies to future turns; Story context budget remains separate.`;
}

function renderStoryMemorySettings(settings, message = null, draftLevel = null, disabled = false) {
  const selector = $("storyMemoryLevel");
  const status = $("storyMemoryStatus");
  const checkbox = $("storyContinuityReviewEnabled");
  if (!selector || !status) return;
  if (!settings) {
    selector.disabled = true;
    if (checkbox) checkbox.disabled = true;
    status.textContent = message || "Story Memory controls are unavailable for this campaign.";
    return;
  }
  const available = new Set(settings.availableLevels);
  for (const option of selector.options) {
    option.disabled = !available.has(option.value);
    option.toggleAttribute("disabled", !available.has(option.value));
  }
  selector.value = draftLevel || settings.level;
  selector.disabled = disabled || !state.campaignId;
  if (checkbox) { checkbox.checked = selector.value === "max" && settings.reviewMode !== "off"; checkbox.disabled = selector.disabled || selector.value !== "max"; }
  status.textContent = message || storyMemoryDescription(settings);
}

async function loadStoryMemorySettings(campaignId, loadEpoch) {
  const requestId = ++state.storyMemoryRequestId;
  if (!composition.storyMemory) return;
  try {
    const settings = await composition.storyMemory.get(campaignId);
    if (state.campaignId !== campaignId || storyTurnWindowEpoch !== loadEpoch || requestId !== state.storyMemoryRequestId) return;
    state.storyMemorySettings = settings;
    renderStoryMemorySettings(settings);
  } catch (error) {
    if (state.campaignId !== campaignId || storyTurnWindowEpoch !== loadEpoch || requestId !== state.storyMemoryRequestId) return;
    renderStoryMemorySettings(null, `Story Memory settings are unavailable: ${error.message || String(error)}`);
  }
}

async function saveStoryMemorySettings() {
  const campaignId = state.campaignId;
  const selector = $("storyMemoryLevel");
  const settings = state.storyMemorySettings;
  const level = selector?.value;
  const requestId = state.storyMemoryRequestId;
  if (!campaignId || !selector || !settings || !level || !STORY_MEMORY_LEVELS.has(level) || !composition.storyMemory) return;
  const continuityReviewEnabled = level === "max" && $("storyContinuityReviewEnabled")?.checked === true;
  renderStoryMemorySettings({ ...settings, reviewMode: continuityReviewEnabled ? "enforce" : "off" }, "Saving Story Memory level…", level, true);
  try {
    const saved = await composition.storyMemory.update(campaignId, { level, continuityReviewEnabled });
    if (state.campaignId !== campaignId || requestId !== state.storyMemoryRequestId) return;
    state.storyMemorySettings = saved;
    renderStoryMemorySettings(saved);
    toast("Story Memory level saved for future turns. Existing and in-flight turns keep their frozen policy.", 3500);
  } catch (error) {
    if (state.campaignId !== campaignId || requestId !== state.storyMemoryRequestId) return;
    renderStoryMemorySettings(settings, `Story Memory level was not saved: ${error.message || String(error)}`, level);
  }
}

function openUserProfile() {
  const dlg = $("userProfileDialog");
  if (!dlg) return;
  const nameInput = $("userProfileDisplayName");
  const cbSubmit = $("userProfileAutoSubmitChoices");
  const cbContinuous = $("userProfileContinuousReading");
  const defaultTurnStyle = $("userProfileDefaultTurnControlStyle");
  userProfilePersistedTurnControlStyle = state.user?.settings?.defaultTurnControlStyle ?? null;
  userProfileTurnControlStyleChanged = false;
  if (nameInput) nameInput.value = state.user?.displayName || "Initial Owner";
  if (cbSubmit) cbSubmit.checked = state.user?.settings?.autoSubmitTurnChoices !== false;
  if (cbContinuous) cbContinuous.checked = Boolean(state.user?.settings?.continuousReading);
  if (defaultTurnStyle) defaultTurnStyle.value = state.user?.settings?.defaultTurnControlStyle === "flexible_scene" ? "flexible_scene" : "flexible_action";
  const readerPreferences = normalizeReaderPreferences(state.user?.settings?.readerPreferences);
  setReaderPreferenceControls(readerPreferences);
  applyReaderPreferences(readerPreferences);
  const profileStatus = document.querySelector("[data-profile-status]");
  if (profileStatus) profileStatus.textContent = "";
  setUserProfileSaving(false);
  renderStoryMemorySettings(state.storyMemorySettings);
  openManagedModal(dlg);
}

function setReaderPreferenceControls(preferences) {
  const controls = [
    ["[data-reader-width]", String(preferences.widthCh)],
    ["[data-reader-font-size]", String(preferences.fontSizePx)],
    ["[data-reader-line-height]", String(preferences.lineHeight)],
    ["select[data-reader-theme]", preferences.theme]
  ];
  for (const [selector, value] of controls) {
    const control = document.querySelector(selector);
    if (control) control.value = value;
  }
}

function readerPreferencesFromControls() {
  return normalizeReaderPreferences({
    widthCh: Number(document.querySelector("[data-reader-width]")?.value),
    fontSizePx: Number(document.querySelector("[data-reader-font-size]")?.value),
    lineHeight: Number(document.querySelector("[data-reader-line-height]")?.value),
    theme: document.querySelector("select[data-reader-theme]")?.value
  });
}

function applyReaderPreferences(preferences) {
  const storyContainer = $("storyContainer");
  if (!storyContainer) return;
  const normalized = normalizeReaderPreferences(preferences);
  storyContainer.dataset.readerTheme = normalized.theme;
  storyContainer.style.setProperty("--reader-width-ch", String(normalized.widthCh));
  storyContainer.style.setProperty("--reader-font-size", `${normalized.fontSizePx}px`);
  storyContainer.style.setProperty("--reader-line-height", String(normalized.lineHeight));
}

function setUserProfileSaving(saving) {
  userProfileSaving = saving;
  const dialog = $("userProfileDialog");
  const controls = dialog?.querySelectorAll("#userProfileDisplayName, #userProfileAutoSubmitChoices, #userProfileContinuousReading, #userProfileDefaultTurnControlStyle, [data-reader-width], [data-reader-font-size], [data-reader-line-height], [data-reader-theme], [data-reader-preview], #btnSaveUserProfile, #btnCancelUserProfile, #btnCloseUserProfile");
  controls?.forEach((control) => {
    if (control instanceof HTMLInputElement || control instanceof HTMLSelectElement || control instanceof HTMLButtonElement) {
      control.disabled = saving;
    }
  });
  const save = $("btnSaveUserProfile");
  if (save) save.textContent = saving ? "Saving…" : "Save Profile";
}

function previewReaderPreferences() {
  applyReaderPreferences(readerPreferencesFromControls());
}

async function saveUserProfile() {
  if (userProfileSaving) return;
  const nameInput = $("userProfileDisplayName");
  const cbSubmit = $("userProfileAutoSubmitChoices");
  const cbContinuous = $("userProfileContinuousReading");
  const defaultTurnStyle = $("userProfileDefaultTurnControlStyle");
  const displayName = nameInput ? nameInput.value.trim() : "";
  const autoSubmitTurnChoices = cbSubmit ? cbSubmit.checked : true;
  const continuousReading = cbContinuous ? cbContinuous.checked : false;
  const defaultTurnControlStyle = !userProfileTurnControlStyleChanged && userProfilePersistedTurnControlStyle === "action_only"
    ? "action_only"
    : defaultTurnStyle?.value === "flexible_scene" ? "flexible_scene" : "flexible_action";
  const readerPreferences = readerPreferencesFromControls();
  const wasContinuousReading = Boolean(state.user?.settings?.continuousReading);
  const readerPositionBeforeSave = wasContinuousReading !== continuousReading ? captureReaderPosition() : null;
  if (wasContinuousReading !== continuousReading) {
    readerPositionInteractionEpoch += 1;
    retirePendingContinuousReaderRequest();
  }

  if (!displayName) {
    toast("Display name is required.", 2600);
    return;
  }

  setUserProfileSaving(true);
  const profileStatus = document.querySelector("[data-profile-status]");
  if (profileStatus) profileStatus.textContent = "Saving profile…";
  try {
    const res = await apiClient.session.updateProfile({
      displayName,
      settings: {
        autoSubmitTurnChoices,
        continuousReading,
        defaultTurnControlStyle,
        readerPreferences
      }
    });
    if (res && res.user) {
      state.user = res.user;
    } else {
      if (state.user) {
        state.user.displayName = displayName;
        if (!state.user.settings) state.user.settings = {};
        state.user.settings.autoSubmitTurnChoices = autoSubmitTurnChoices;
        state.user.settings.continuousReading = continuousReading;
        state.user.settings.defaultTurnControlStyle = defaultTurnControlStyle;
        state.user.settings.readerPreferences = readerPreferences;
      }
    }
    applyReaderPreferences(state.user?.settings?.readerPreferences ?? readerPreferences);
    if (wasContinuousReading !== continuousReading) {
      const position = readerPositionBeforeSave?.position;
      const selectedTurnNumber = position?.turnNumber ?? currentViewTurnNumber();
      const selectedTurnId = position?.turnId;
      const selectedTurn = state.readerPinnedTurn
        && Number(state.readerPinnedTurn.turnNumber) === selectedTurnNumber
        && (!selectedTurnId || (state.readerPinnedTurn.id || state.readerPinnedTurn.turnId) === selectedTurnId)
        ? state.readerPinnedTurn
        : state.turns.find((turn) => Number(turn.turnNumber) === selectedTurnNumber
          && (!selectedTurnId || (turn.id || turn.turnId) === selectedTurnId))
          || state.continuousReader?.turns.find((turn) => Number(turn.turnNumber) === selectedTurnNumber
            && (!selectedTurnId || (turn.id || turn.turnId) === selectedTurnId))
          || null;
      state.viewTurnNumber = selectedTurnNumber === latestTurnNumber(state.turns) ? null : selectedTurnNumber;
      state.readerPinnedTurn = selectedTurn && !state.turns.some((turn) => (turn.id || turn.turnId) === (selectedTurn.id || selectedTurn.turnId))
        ? selectedTurn
        : null;
      if (continuousReading) {
        initializeContinuousReader(selectedTurn ? {
          selectedReadIdentity: { turnNumber: selectedTurnNumber, id: selectedTurn.id || selectedTurn.turnId },
          selectedTurn
        } : {});
      }
    }
    renderAllScenes({ autoScroll: wasContinuousReading !== continuousReading ? false : undefined });
    if (wasContinuousReading !== continuousReading && readerPositionBeforeSave?.position) {
      restoreReaderSceneOffset(readerPositionBeforeSave.position.turnNumber, readerPositionBeforeSave.position.offsetRatio);
      scheduleReaderPositionSave();
    }
    updateStatusBar();
    const dlg = $("userProfileDialog");
    if (dlg && dlg.close) dlg.close();
    toast("Profile saved.", 2600);
  } catch (err) {
    if (profileStatus) profileStatus.textContent = `Profile could not be saved: ${err.message || String(err)}`;
    toast("Failed to save profile: " + err.message, 3500);
  } finally {
    setUserProfileSaving(false);
  }
}

async function openTurnHistoryModal() {
  const dialog = $("turnHistoryDialog");
  openManagedModal(dialog);
  if (state.historyWindowCampaignId !== state.campaignId || state.historyWindowEpoch !== storyTurnWindowEpoch) {
    initializeStoryHistoryWindow();
  }
  renderStoryHistoryWindow();
  renderStoryHistorySearch();
  revealSelectedHistoryCard();
}

function storyHistorySearchScope() {
  return { campaignId: state.campaignId || "", loadEpoch: storyTurnWindowEpoch };
}

function cancelStoryHistorySearchWork() {
  if (historySearchDebounceTimer !== null) clearTimeout(historySearchDebounceTimer);
  historySearchDebounceTimer = null;
  if (historySearchAbortController) historySearchAbortController.abort();
  historySearchAbortController = null;
  if (historySearchJumpAbortController) historySearchJumpAbortController.abort();
  historySearchJumpAbortController = null;
  historySearchJumpSearchIdentity = null;
  state.historySearchJumpRequestId += 1;
}

function resetStoryHistorySearchForCurrentScope() {
  cancelStoryHistorySearchWork();
  state.historySearch = beginStoryHistorySearch(state.historySearch, storyHistorySearchScope(), "").state;
  const input = $("turnHistorySearch");
  if (input) input.value = "";
  const jumpStatus = $("turnHistoryJumpStatus");
  if (jumpStatus) {
    jumpStatus.dataset.state = "idle";
    jumpStatus.textContent = "";
  }
  renderStoryHistorySearch();
}

function storyHistorySearchRequestIsCurrent(request) {
  return state.historySearch.activeRequest === request
    && state.campaignId === request.campaignId
    && storyTurnWindowEpoch === request.loadEpoch;
}

function storyHistorySearchStatusText(searchState) {
  if (searchState.status === "invalid") return "Search text must be 200 characters or fewer.";
  if (searchState.status === "loading") return "Searching accepted history…";
  if (searchState.status === "empty") return "No matching turns.";
  if (searchState.status === "results") {
    const count = searchState.items.length;
    return `Showing ${count} matching ${count === 1 ? "turn" : "turns"}.`;
  }
  if (searchState.status === "error") {
    if (searchState.errorKind === "conflict") return "History changed while searching. Retry from the newest history.";
    if (searchState.errorKind === "scope" || searchState.errorKind === "protocol") {
      return "Search results could not be verified. Please retry.";
    }
    return "Search could not be completed. Please retry.";
  }
  return "Search accepted turns in this campaign.";
}

function renderStoryHistorySearch() {
  const searchState = state.historySearch;
  const searchInput = $("turnHistorySearch");
  const status = $("turnHistorySearchStatus");
  const results = $("turnHistorySearchResults");
  const moreButton = $("btnTurnHistorySearchMore");
  const retryButton = $("btnTurnHistorySearchRetry");
  const clearButton = $("btnTurnHistorySearchClear");
  const browsePanel = $("turnHistoryBrowsePanel");
  const selectionActions = document.querySelector(".history-selection-actions");
  const searching = Boolean(searchState.query);

  if (browsePanel) browsePanel.classList.toggle("hidden", searching);
  if (selectionActions) selectionActions.classList.toggle("hidden", searching);
  if (searchInput && searchInput.value.trim() !== searchState.query && searchState.status !== "loading") {
    searchInput.value = searchState.query;
  }
  if (status) {
    status.dataset.state = searchState.status;
    status.textContent = storyHistorySearchStatusText(searchState);
  }
  if (clearButton) clearButton.disabled = !searchInput?.value;
  if (results) {
    results.replaceChildren();
    results.hidden = searchState.items.length === 0;
    for (const item of searchState.items) {
      const row = document.createElement("div");
      row.setAttribute("role", "listitem");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "small history-search-result";
      button.dataset.historyTurnNumber = String(item.turnNumber);
      const title = document.createElement("span");
      title.className = "history-search-result-title";
      title.textContent = `Turn ${item.turnNumber}`;
      const excerpt = document.createElement("span");
      excerpt.className = "history-search-result-excerpt";
      excerpt.textContent = item.excerpt;
      button.append(title, excerpt);
      const acceptedAtTimestamp = Date.parse(item.acceptedAt);
      if (Number.isFinite(acceptedAtTimestamp)) {
        const date = document.createElement("time");
        date.className = "history-search-result-date";
        date.dateTime = item.acceptedAt;
        date.textContent = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" })
          .format(new Date(acceptedAtTimestamp));
        button.appendChild(date);
      }
      const resultQueryEpoch = searchState.queryEpoch;
      const resultRequestId = searchState.nextRequestId;
      button.addEventListener("click", () => {
        void loadSearchedHistoryTurn(item.turnNumber, item.id, resultQueryEpoch, resultRequestId);
      });
      row.appendChild(button);
      results.appendChild(row);
    }
  }
  if (moreButton) {
    moreButton.hidden = searchState.status !== "results" || !searchState.nextCursor;
    moreButton.disabled = searchState.status === "loading";
  }
  if (retryButton) retryButton.hidden = searchState.status !== "error";
}

async function loadStoryHistorySearchPage(request) {
  if (!storyHistorySearchRequestIsCurrent(request)) return;
  const controller = new AbortController();
  historySearchAbortController = controller;
  try {
    const response = await readerHistoryApi.searchHistory(request.campaignId, {
      q: request.query,
      limit: STORY_HISTORY_PAGE_LIMIT,
      ...(request.before === null ? {} : { before: request.before })
    }, controller.signal);
    if (!storyHistorySearchRequestIsCurrent(request)) return;
    state.historySearch = settleStoryHistorySearch(state.historySearch, request, { type: "success", response });
  } catch (error) {
    if (!storyHistorySearchRequestIsCurrent(request)) return;
    state.historySearch = settleStoryHistorySearch(state.historySearch, request, {
      type: historyPageConflict(error) ? "conflict" : "request-error"
    });
  } finally {
    if (historySearchAbortController === controller) historySearchAbortController = null;
  }
  renderStoryHistorySearch();
}

function handleStoryHistorySearchInput() {
  const searchInput = $("turnHistorySearch");
  if (!searchInput || !state.campaignId) return;
  if (historySearchDebounceTimer !== null) clearTimeout(historySearchDebounceTimer);
  historySearchDebounceTimer = null;
  if (historySearchAbortController) historySearchAbortController.abort();
  historySearchAbortController = null;
  const transition = beginStoryHistorySearch(state.historySearch, storyHistorySearchScope(), searchInput.value);
  state.historySearch = transition.state;
  invalidateStaleStoryHistorySearchSelection();
  renderStoryHistorySearch();
  if (!transition.request) return;
  const request = transition.request;
  historySearchDebounceTimer = setTimeout(() => {
    historySearchDebounceTimer = null;
    void loadStoryHistorySearchPage(request);
  }, STORY_HISTORY_SEARCH_DEBOUNCE_MS);
}

function requestStoryHistorySearchPage(action) {
  if (historySearchDebounceTimer !== null) clearTimeout(historySearchDebounceTimer);
  historySearchDebounceTimer = null;
  if (historySearchAbortController) historySearchAbortController.abort();
  historySearchAbortController = null;
  const transition = beginStoryHistorySearchPage(state.historySearch, action);
  state.historySearch = transition.state;
  invalidateStaleStoryHistorySearchSelection();
  renderStoryHistorySearch();
  if (transition.request) void loadStoryHistorySearchPage(transition.request);
}

function invalidateStaleStoryHistorySearchSelection() {
  const identity = historySearchJumpSearchIdentity;
  if (!identity || (identity.queryEpoch === state.historySearch.queryEpoch
    && identity.requestId === state.historySearch.nextRequestId)) return;
  state.historySearchJumpRequestId += 1;
  if (historySearchJumpAbortController) historySearchJumpAbortController.abort();
  historySearchJumpAbortController = null;
  historySearchJumpSearchIdentity = null;
  setStoryHistoryJumpStatus("idle", "");
}

function setStoryHistoryJumpStatus(stateName, message) {
  const status = $("turnHistoryJumpStatus");
  if (!status) return;
  status.dataset.state = stateName;
  status.textContent = message;
}

function knownStoryHistoryTurn(turnNumber) {
  const historyWindowIsCurrent = state.historyWindowCampaignId === state.campaignId
    && state.historyWindowEpoch === storyTurnWindowEpoch;
  const candidates = [...state.turns];
  if (historyWindowIsCurrent) {
    const cachedTurns = (state.historyWindow?.cachedPages || []).flatMap(page => page.turns);
    candidates.push(...(state.historyResidentRows || []), ...cachedTurns);
    if (state.historyWindow?.selectedPreview) candidates.push(state.historyWindow.selectedPreview);
  }
  return candidates.find(turn => Number(turn.turnNumber) === turnNumber) || null;
}

async function loadSearchedHistoryTurn(turnNumber, expectedTurnId, queryEpoch, requestId) {
  await loadExactHistoryTurn(turnNumber, { expectedTurnId, queryEpoch, expectedSearchRequestId: requestId });
}

async function jumpToExactHistoryTurn() {
  const input = $("turnHistoryJumpNumber");
  if (!input || !state.campaignId) return;
  const latestTurnNumber = latestTurnNumberFromStory();
  const target = validateStoryHistoryJumpTarget(input.value, latestTurnNumber);
  if (!target.valid) {
    setStoryHistoryJumpStatus("invalid", target.reason === "out-of-range"
      ? `Enter a turn from 1 to ${latestTurnNumber}.`
      : "Enter a positive whole turn number.");
    return;
  }
  await loadExactHistoryTurn(target.turnNumber, { queryEpoch: state.historySearch.queryEpoch });
}

function latestTurnNumberFromStory() {
  const historyWindowIsCurrent = state.historyWindowCampaignId === state.campaignId
    && state.historyWindowEpoch === storyTurnWindowEpoch;
  const localAcceptedTurns = [
    ...(state.turns || []),
    ...(historyWindowIsCurrent ? state.historyResidentRows || [] : []),
    ...(historyWindowIsCurrent ? state.historyWindow?.cachedPages || [] : []).flatMap(page => page.turns),
    ...(historyWindowIsCurrent ? [state.historyWindow?.selectedPreview, state.historySelectedPreview] : [])
  ].filter(Boolean);
  const knownTurnNumbers = localAcceptedTurns
    .map(turn => Number(turn.turnNumber))
    .filter(turnNumber => Number.isSafeInteger(turnNumber) && turnNumber > 0);
  const campaignLatest = Number(state.campaign?.activeTurnNumber);
  if (Number.isSafeInteger(campaignLatest) && campaignLatest > 0) knownTurnNumbers.push(campaignLatest);
  return Math.max(0, ...knownTurnNumbers);
}

async function loadExactHistoryTurn(turnNumber, {
  expectedTurnId = null,
  queryEpoch = state.historySearch.queryEpoch,
  expectedSearchRequestId = null
} = {}) {
  const campaignId = state.campaignId;
  if (!campaignId) return;
  if (historySearchJumpAbortController) historySearchJumpAbortController.abort();
  const controller = new AbortController();
  historySearchJumpAbortController = controller;
  historySearchJumpSearchIdentity = expectedSearchRequestId === null
    ? null
    : { queryEpoch, requestId: expectedSearchRequestId };
  const requestId = ++state.historySearchJumpRequestId;
  const loadEpoch = storyTurnWindowEpoch;
  setStoryHistoryJumpStatus("loading", `Loading Turn ${turnNumber}…`);
  const isCurrent = () => requestId === state.historySearchJumpRequestId
    && state.campaignId === campaignId
    && storyTurnWindowEpoch === loadEpoch
    && (expectedSearchRequestId === null || (state.historySearch.queryEpoch === queryEpoch
      && state.historySearch.nextRequestId === expectedSearchRequestId));
  try {
    const response = await readerHistoryApi.getTurn(campaignId, turnNumber, controller.signal);
    if (!isCurrent()) return;
    const turn = response?.turn;
    if (response?.campaignId !== campaignId || Number(turn?.turnNumber) !== turnNumber
      || typeof turn?.id !== "string" || (expectedTurnId && turn.id !== expectedTurnId)) {
      setStoryHistoryJumpStatus("error", "That turn changed or could not be verified. Your current scene is unchanged.");
      return;
    }
    const known = knownStoryHistoryTurn(turnNumber);
    if (known && (known.id || known.turnId) !== turn.id) {
      setStoryHistoryJumpStatus("error", "That turn changed or could not be verified. Your current scene is unchanged.");
      return;
    }
    if (!state.historyWindow || state.historyWindowCampaignId !== campaignId || state.historyWindowEpoch !== loadEpoch) {
      initializeStoryHistoryWindow();
    }
    state.historyWindow = selectStoryHistoryPreview(state.historyWindow, turn);
    state.historySelectedPreview = turn;
    state.historySelectedTurnNumber = turnNumber;
    renderStoryHistoryWindow();
    jumpToSelectedHistoryTurn();
    setStoryHistoryJumpStatus("success", `Opened Turn ${turnNumber}.`);
  } catch {
    if (!isCurrent()) return;
    setStoryHistoryJumpStatus("error", "Could not open that turn. Your current scene is unchanged. Please retry.");
  } finally {
    if (historySearchJumpAbortController === controller) {
      historySearchJumpAbortController = null;
      historySearchJumpSearchIdentity = null;
    }
  }
}

function initializeStoryHistoryWindow(options = {}) {
  const residentRows = options.residentRows || state.turns || [];
  const recentTurns = options.turns || residentRows.slice(-STORY_HISTORY_PAGE_LIMIT);
  const selectionNumber = currentViewTurnNumber();
  const sameCampaignWindow = state.historyWindowCampaignId === state.campaignId;
  const retainedSelection = sameCampaignWindow
    ? state.historySelectedPreview
      || residentRows.find((turn) => Number(turn.turnNumber) === state.historySelectedTurnNumber)
    : null;
  const selectedPreview = options.clearPreview ? null : (state.readerPinnedTurn
    || retainedSelection
    || residentRows.find((turn) => Number(turn.turnNumber) === selectionNumber)
    || null);
  state.historyResidentRows = residentRows;
  state.historyWindow = createStoryHistoryWindow({
    page: {
      source: "server",
      requestCursor: null,
      nextCursor: options.nextCursor === undefined ? state.historyNextCursor : options.nextCursor,
      turns: recentTurns
    },
    selectedPreview,
    residentRange: residentRows.length
      ? { firstTurnNumber: Number(residentRows[0]?.turnNumber), lastTurnNumber: Number(residentRows.at(-1)?.turnNumber) }
      : null
  });
  state.historyWindowCampaignId = state.campaignId;
  state.historyWindowEpoch = storyTurnWindowEpoch;
  state.historySelectedPreview = selectedPreview;
  const visible = storyHistoryVisibleTurns(state.historyWindow);
  const initialSelection = selectedPreview?.turnNumber
    ?? (visible.pageTurns.some((turn) => Number(turn.turnNumber) === currentViewTurnNumber())
      ? currentViewTurnNumber()
      : visible.pageTurns.at(-1)?.turnNumber);
  state.historySelectedTurnNumber = Number.isInteger(initialSelection) ? initialSelection : null;
}

function historyWindowContainsTurn(turnNumber) {
  if (!state.historyWindow) return false;
  const visible = storyHistoryVisibleTurns(state.historyWindow);
  return visible.pageTurns.some((turn) => Number(turn.turnNumber) === turnNumber)
    || Number(visible.selectedPreview?.turnNumber) === turnNumber;
}

function historyCard(turn, { selected = false, preview = false } = {}) {
  const entry = document.createElement("article");
  entry.className = "history-entry";
  const card = document.createElement("button");
  card.type = "button";
  card.className = `history-card${preview ? " history-preview-turn" : ""}`;
  card.dataset.turnNumber = String(turn.turnNumber);
  card.setAttribute("aria-pressed", String(selected));
  card.classList.toggle("selected", selected);
  const heading = document.createElement("span");
  heading.className = "history-card-heading";
  const title = document.createElement("span");
  title.className = "history-card-title";
  title.textContent = `${Number(turn.turnNumber) === currentViewTurnNumber() ? "◆ " : ""}Turn ${turn.turnNumber}`;
  heading.appendChild(title);
  const metadata = document.createElement("span");
  metadata.className = "history-card-meta";
  const inputMode = turn.inputMode === "scene" ? "scene" : "action";
  const inputModeLabel = inputMode === "scene" ? "Scene direction" : "Action";
  const pill = document.createElement("span");
  pill.className = `turn-input-mode-pill ${inputMode}`;
  pill.textContent = inputModeLabel;
  pill.setAttribute("aria-label", `Prompt interpretation: ${inputModeLabel}`);
  metadata.appendChild(pill);
  const acceptedAt = typeof turn.acceptedAt === "string" ? turn.acceptedAt : "";
  const acceptedAtTimestamp = acceptedAt ? Date.parse(acceptedAt) : Number.NaN;
  if (Number.isFinite(acceptedAtTimestamp)) {
    const date = document.createElement("time");
    date.className = "history-card-date";
    date.dateTime = acceptedAt;
    date.textContent = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" })
      .format(new Date(acceptedAtTimestamp));
    metadata.appendChild(date);
  }
  heading.appendChild(metadata);
  const excerpt = document.createElement("span");
  const excerptSource = String(turn.action || turn.narration || turn.effectiveNarration || "");
  excerpt.className = turn.action ? "turn-history-prompt" : "";
  excerpt.textContent = `${excerptSource.slice(0, 240)}${excerptSource.length > 240 ? "…" : ""}`;
  card.append(heading, excerpt);
  const details = document.createElement("details");
  const summary = document.createElement("summary");
  summary.textContent = "Retrieval details";
  details.append(summary);
  const audit = document.createElement("div");
  audit.innerHTML = chronicleRetrievalHistoryMarkup(turn.chronicleRetrieval);
  details.appendChild(audit);
  if (!preview) card.addEventListener("click", () => selectHistoryTurn(Number(turn.turnNumber)));
  entry.append(card, details);
  return entry;
}

function renderStoryHistoryWindow() {
  const container = $("turnHistoryModalList");
  if (!container) return;
  container.replaceChildren();
  const previewSection = $("turnHistorySelectedPreview");
  const previewContainer = $("turnHistoryPreviewCard");
  const statePanel = $("turnHistoryStatePanel");
  if (state.historyWindowCampaignId !== state.campaignId || state.historyWindowEpoch !== storyTurnWindowEpoch) {
    initializeStoryHistoryWindow();
  }
  if (!state.historyWindow || !state.historyWindowCampaignId) return;
  const visible = storyHistoryVisibleTurns(state.historyWindow);
  state.historySelectedPreview = visible.selectedPreview;
  if (previewSection) previewSection.classList.toggle("hidden", !visible.selectedPreview);
  if (previewContainer) {
    previewContainer.replaceChildren();
    if (visible.selectedPreview) {
      previewContainer.appendChild(historyCard(visible.selectedPreview, {
        selected: Number(visible.selectedPreview.turnNumber) === state.historySelectedTurnNumber,
        preview: true
      }));
    }
  }
  for (const turn of visible.pageTurns) {
    container.appendChild(historyCard(turn, { selected: Number(turn.turnNumber) === state.historySelectedTurnNumber }));
  }
  const older = $("btnTurnHistoryOlder");
  const newer = $("btnTurnHistoryNewer");
  if (older) older.disabled = !storyHistoryPageRequest(state.historyWindow, "older") || Boolean(historyPageLoad);
  if (newer) newer.disabled = !storyHistoryPageRequest(state.historyWindow, "newer") || Boolean(historyPageLoad);
  const previous = $("btnTurnHistoryPreviousTurn");
  const next = $("btnTurnHistoryNextTurn");
  if (previous) previous.disabled = !visible.selectedPreview || Number(visible.selectedPreview.turnNumber) <= 1 || Boolean(historyPageLoad);
  if (next) next.disabled = !visible.selectedPreview
    || Number(visible.selectedPreview.turnNumber) >= Number(state.campaign?.activeTurnNumber || latestTurnNumber(state.turns))
    || Boolean(historyPageLoad);
  if (visible.pageTurns.length + Number(Boolean(visible.selectedPreview)) > STORY_HISTORY_PAGE_LIMIT) {
    throw new Error("Story history rendered more than 50 cards.");
  }
  if (!visible.pageTurns.length && !visible.selectedPreview) {
    state.historySelectedTurnNumber = null;
    const empty = document.createElement("p");
    empty.className = "dim mini";
    empty.textContent = "No turns recorded yet.";
    container.appendChild(empty);
    if (statePanel) { statePanel.classList.add("hidden"); statePanel.replaceChildren(); }
    updateHistorySelectionActions();
    return;
  }
  if (!historyWindowContainsTurn(state.historySelectedTurnNumber)) {
    state.historySelectedTurnNumber = visible.selectedPreview?.turnNumber ?? visible.pageTurns.at(-1)?.turnNumber ?? null;
    if (state.historySelectedTurnNumber !== null) state.historyWindow = selectStoryHistoryPreview(state.historyWindow, visible.pageTurns.find((turn) => turn.turnNumber === state.historySelectedTurnNumber) ?? visible.selectedPreview);
  }
  updateHistorySelectionActions();
}

function revealSelectedHistoryCard() {
  const scroller = $("turnHistoryDialog")?.querySelector(".dialog-scroll");
  const selectedCard = scroller?.querySelector('.history-card[aria-pressed="true"]');
  const selected = selectedCard?.closest(".history-entry") || selectedCard;
  if (!scroller || !selected) return;
  const viewport = scroller.getBoundingClientRect();
  const card = selected.getBoundingClientRect();
  const viewportTop = viewport.top + scroller.clientTop;
  const viewportBottom = viewportTop + scroller.clientHeight;
  if (card.top < viewportTop) scroller.scrollTop = Math.floor(scroller.scrollTop + card.top - viewportTop);
  else if (card.bottom > viewportBottom) scroller.scrollTop = Math.ceil(scroller.scrollTop + card.bottom - viewportBottom);
}

function selectHistoryTurn(turnNumber) {
  if (!Number.isInteger(turnNumber) || !historyWindowContainsTurn(turnNumber)) return;
  state.historySelectedTurnNumber = turnNumber;
  const selectedTurn = [...(state.historyWindow?.cachedPages || []).flatMap((page) => page.turns), state.historyWindow?.selectedPreview]
    .find((turn) => Number(turn?.turnNumber) === turnNumber) || null;
  state.historyWindow = selectStoryHistoryPreview(state.historyWindow, selectedTurn);
  document.querySelectorAll("#turnHistoryModalList .history-card, #turnHistoryPreviewCard .history-card").forEach(card => {
    const selected = Number(card.dataset.turnNumber) === turnNumber;
    card.classList.toggle("selected", selected);
    card.setAttribute("aria-pressed", String(selected));
  });
  const panel = $("turnHistoryStatePanel");
  if (panel) { panel.classList.add("hidden"); panel.replaceChildren(); }
  state.historyInspectionRequestId += 1;
  renderStoryHistoryWindow();
  revealSelectedHistoryCard();
  updateHistorySelectionActions();
}

function jumpToSelectedHistoryTurn() {
  const turnNumber = state.historySelectedTurnNumber;
  if (!Number.isInteger(turnNumber) || !historyWindowContainsTurn(turnNumber)) return;
  if (turnIndexForNumber(state.turns, turnNumber) >= 0) {
    navigateToTurn(turnNumber);
  } else {
    const selectedTurn = state.historyWindow?.selectedPreview;
    if (!selectedTurn || Number(selectedTurn.turnNumber) !== turnNumber) return;
    readerPositionInteractionEpoch += 1;
    readerPositionChoicePending = false;
    state.readerPinnedTurn = selectedTurn;
    hideReaderResumePrompt();
    clearResponseEditSession();
    state.viewTurnNumber = turnNumber;
    if (state.user?.settings?.continuousReading) {
      initializeContinuousReader({
        selectedReadIdentity: { turnNumber, id: selectedTurn.id || selectedTurn.turnId },
        selectedTurn
      });
    }
    renderAllScenes({ autoScroll: false });
    updateStatusBar();
    scrollToView();
    scheduleReaderPositionSave();
  }
  const dialog = $("turnHistoryDialog");
  if (dialog?.close) dialog.close();
}

function updateHistorySelectionActions() {
  const hasSelection = Number.isInteger(state.historySelectedTurnNumber)
    && historyWindowContainsTurn(state.historySelectedTurnNumber);
  const inspectBtn = $("btnTurnHistoryInspect");
  const jumpBtn = $("btnTurnHistoryJump");
  const branchBtn = $("btnTurnHistoryBranch");
  if (inspectBtn) inspectBtn.disabled = !hasSelection;
  if (jumpBtn) jumpBtn.disabled = !hasSelection;
  if (branchBtn) {
    branchBtn.disabled = !hasSelection;
    branchBtn.classList.toggle("hidden", !hasSelection || state.historySelectedTurnNumber >= state.campaign?.activeTurnNumber);
  }
}

function historyPageConflict(error) {
  return Number(error?.statusCode ?? error?.status) === 409 || error?.code === "cursor_conflict";
}

async function refreshHistoryAfterCursorConflict(campaignId, epoch) {
  const page = await apiClient.campaigns.turns(campaignId, { limit: STORY_HISTORY_PAGE_LIMIT });
  if (state.campaignId !== campaignId || storyTurnWindowEpoch !== epoch) return false;
  if (page.campaignId !== campaignId) throw new Error(`Story history page belongs to ${page.campaignId}.`);
  const latestTurns = mergeStoryTurnPages([], page.turns || []);
  state.historySelectedTurnNumber = null;
  state.historySelectedPreview = null;
  initializeStoryHistoryWindow({
    turns: latestTurns,
    residentRows: latestTurns,
    nextCursor: page.nextCursor || null,
    clearPreview: true
  });
  setTurnHistoryLoadStatus("History changed. The latest accepted turns are shown; continue paging from this reset window.", "error");
  return true;
}

async function changeStoryHistoryPage(direction) {
  if (!state.historyWindow || historyPageLoad) return;
  if (state.historyWindowCampaignId !== state.campaignId || state.historyWindowEpoch !== storyTurnWindowEpoch) {
    initializeStoryHistoryWindow();
  }
  let workingWindow = state.historyWindow;
  const request = storyHistoryPageRequest(workingWindow, direction);
  if (!request) return;
  const campaignId = state.campaignId;
  const epoch = storyTurnWindowEpoch;
  const requestId = ++state.historyPageRequestId;
  const isCurrent = () => requestId === state.historyPageRequestId
    && state.campaignId === campaignId
    && storyTurnWindowEpoch === epoch
    && state.historyWindow === workingWindow;

  if (!request.requiresFetch) {
    state.historyWindow = installStoryHistoryWindowPage(workingWindow, request, null);
    const visible = storyHistoryVisibleTurns(state.historyWindow);
    setTurnHistoryLoadStatus(visible.pageTurns.length
      ? `Showing turns ${visible.firstTurnNumber}–${visible.lastTurnNumber}.`
      : "No turns are available in this history window.");
    renderStoryHistoryWindow();
    return;
  }

  if (!workingWindow.pending) {
    workingWindow = installStoryHistoryWindowPage(workingWindow, request, null);
    state.historyWindow = workingWindow;
  }
  setTurnHistoryLoadStatus(`Loading ${direction} history page…`, "loading");
  const operation = (async () => {
    try {
      const attemptedSources = new Set();
      const maximumSources = 4;
      let sourceCount = 0;
      while (workingWindow.pending && sourceCount < maximumSources) {
        const sourceRequest = storyHistoryPageRequest(workingWindow, direction);
        if (!sourceRequest?.requiresFetch) throw new Error("History reconstruction stopped before the requested window was complete.");
        const sourceKey = sourceRequest.source === "resident"
          ? `resident:${sourceRequest.targetStartTurnNumber}:${sourceRequest.targetEndTurnNumber}`
          : `server:${sourceRequest.requestCursor}`;
        if (attemptedSources.has(sourceKey)) throw new Error("History reconstruction repeated a source without progress.");
        attemptedSources.add(sourceKey);

        const knownTurns = [
          ...(state.historyResidentRows || []),
          ...workingWindow.cachedPages.flatMap((cached) => cached.turns)
        ];
        let page;
        if (sourceRequest.source === "resident") {
          const turns = (state.historyResidentRows || []).filter((turn) => Number(turn.turnNumber) >= sourceRequest.targetStartTurnNumber
            && Number(turn.turnNumber) <= sourceRequest.targetEndTurnNumber);
          const expected = sourceRequest.targetEndTurnNumber - sourceRequest.targetStartTurnNumber + 1;
          if (turns.length !== expected) throw new Error("Loaded history has a missing turn at the page boundary.");
          mergeStoryTurnPages(knownTurns, turns);
          page = { source: "resident", requestCursor: null, nextCursor: null, turns };
        } else {
          const response = await apiClient.campaigns.turns(campaignId, {
            before: sourceRequest.requestCursor,
            limit: STORY_HISTORY_PAGE_LIMIT
          });
          if (!isCurrent()) return;
          if (response.campaignId !== campaignId) throw new Error("Story history response belongs to a different campaign.");
          mergeStoryTurnPages(knownTurns, response.turns || []);
          page = {
            source: "server",
            requestCursor: sourceRequest.requestCursor,
            nextCursor: response.nextCursor || null,
            turns: response.turns || []
          };
        }
        if (!isCurrent()) return;
        workingWindow = installStoryHistoryWindowPage(workingWindow, sourceRequest, page);
        state.historyWindow = workingWindow;
        sourceCount += 1;
      }
      if (workingWindow.pending) throw new Error("History reconstruction exceeded its bounded source count.");
      if (!isCurrent()) return;
      const visible = storyHistoryVisibleTurns(state.historyWindow);
      setTurnHistoryLoadStatus(visible.pageTurns.length
        ? `Showing turns ${visible.firstTurnNumber}–${visible.lastTurnNumber}.`
        : "No turns are available in this history window.");
      renderStoryHistoryWindow();
    } catch (error) {
      if (!isCurrent()) return;
      if (historyPageConflict(error)) {
        try {
          await refreshHistoryAfterCursorConflict(campaignId, epoch);
        } catch {
          setTurnHistoryLoadStatus("History changed, but the latest page could not be loaded. Please retry.", "error");
        }
      } else {
        setTurnHistoryLoadStatus(`Could not load ${direction} history page. Please retry.`, "error");
      }
      renderStoryHistoryWindow();
    }
  })();
  historyPageLoad = operation;
  renderStoryHistoryWindow();
  try {
    await operation;
  } finally {
    if (historyPageLoad === operation) historyPageLoad = null;
    renderStoryHistoryWindow();
  }
}

async function moveSelectedHistoryPreview(offset) {
  const preview = state.historyWindow && storyHistoryVisibleTurns(state.historyWindow).selectedPreview;
  if (!preview || historyPageLoad) return;
  const turnNumber = Number(preview.turnNumber) + offset;
  const latest = Number(state.campaign?.activeTurnNumber || latestTurnNumber(state.turns));
  if (!Number.isInteger(turnNumber) || turnNumber < 1 || turnNumber > latest) return;
  const campaignId = state.campaignId;
  const epoch = storyTurnWindowEpoch;
  const capturedWindow = state.historyWindow;
  const requestId = ++state.historyPageRequestId;
  setTurnHistoryLoadStatus(`Loading Turn ${turnNumber}…`, "loading");
  const operation = (async () => {
    try {
      const response = await readerHistoryApi.getTurn(campaignId, turnNumber);
      if (requestId !== state.historyPageRequestId || state.campaignId !== campaignId
        || storyTurnWindowEpoch !== epoch || state.historyWindow !== capturedWindow) return;
      const turn = response?.turn;
      if (response?.campaignId !== campaignId || Number(turn?.turnNumber) !== turnNumber || !turn?.id) {
        throw new Error(`Turn ${turnNumber} is no longer available in this campaign.`);
      }
      const known = [
        ...(state.historyResidentRows || []),
        ...(capturedWindow.cachedPages || []).flatMap((cached) => cached.turns)
      ].find((candidate) => Number(candidate.turnNumber) === turnNumber);
      if (known && (known.id || known.turnId) !== turn.id) throw new Error(`Turn ${turnNumber} has changed since this history window was opened.`);
      state.historyWindow = selectStoryHistoryPreview(capturedWindow, turn);
      state.historySelectedTurnNumber = turnNumber;
      setTurnHistoryLoadStatus(`Selected Turn ${turnNumber}.`);
      renderStoryHistoryWindow();
      revealSelectedHistoryCard();
    } catch (error) {
      if (requestId !== state.historyPageRequestId || state.campaignId !== campaignId
        || storyTurnWindowEpoch !== epoch || state.historyWindow !== capturedWindow) return;
      setTurnHistoryLoadStatus("Could not load adjacent turn. Please retry.", "error");
    }
  })();
  historyPageLoad = operation;
  renderStoryHistoryWindow();
  try {
    await operation;
  } finally {
    if (historyPageLoad === operation) historyPageLoad = null;
    renderStoryHistoryWindow();
  }
}

async function inspectTurnState(turnNumber) {
  const panel = $("turnHistoryStatePanel");
  if (!panel || !state.campaignId) return;
  const requestId = ++state.historyInspectionRequestId;
  panel.classList.remove("hidden");
  panel.innerHTML = `<p class="mini">Loading state after turn ${turnNumber}…</p>`;
  try {
    const runtime = await apiClient.campaigns.state(state.campaignId, turnNumber);
    if (requestId !== state.historyInspectionRequestId) return;
    renderCampaignStateInspector(panel, runtime);
  } catch (err) {
    if (requestId !== state.historyInspectionRequestId) return;
    panel.innerHTML = `<p class="mini">State could not be loaded: ${escapeHtml(err.message)}</p>`;
  }
}

async function saveEditState() {
  const editSession = state.editStateSession;
  if (!editSession || editSession.saving) return;
  if (editSession.stale) {
    toast("Current state changed. Reload it before saving your draft.");
    return;
  }
  const scratchpadEl = $("scratchpadEditor");
  const continuitySummaryEl = $("editStateContinuitySummary");
  const openThreads = $("editStateOpenThreads");
  const canonicalFacts = $("editStateCanonicalFacts");
  const saveButton = $("btnSaveEditState") || $("btnSaveScratch");
  editSession.saving = true;
  if (saveButton) saveButton.disabled = true;
  try {
    showBusy("Saving state…");
    let accepted = false;
    await saveCampaignStateFromEditor(apiClient.campaigns.updateState, editSession.campaignId, editSession.base, {
      summary: continuitySummaryEl,
      threads: openThreads,
      facts: canonicalFacts,
      scratchpad: scratchpadEl,
      trackers: collectTrackerEditorValues()
    }, savedState => {
      if (state.campaignId !== editSession.campaignId || state.editStateSession?.id !== editSession.id) return;
      accepted = true;
      state.runtimeState = savedState;
      state.editStateSession = null;
      const dlg = $("editStateDialog");
      if (dlg && dlg.close) dlg.close();
    }, editSession.draft);
    if (accepted) toast("Current state saved. The next story turn will use these changes.");
  } catch (err) {
    if (state.campaignId === editSession.campaignId && state.editStateSession?.id === editSession.id
      && (err?.status === 409 || err?.statusCode === 409)) {
      editSession.stale = true;
      updateEditStateMetadata(editSession);
    }
    toast(`Save failed: ${err.message}`);
  } finally {
    if (state.editStateSession?.id === editSession.id) {
      editSession.saving = false;
      if (saveButton) saveButton.disabled = false;
    }
    hideBusy();
  }
}

// ── Character Profile Dialog ───────────────────────────────────
async function openEditCharacterProfile() {
  const dialog = $("editCharacterProfileDialog");
  if (!dialog || !state.campaignId) return;
  const recoveryPanel = $("generationRecoveryPanel");
  const recoveryVisible = Boolean(recoveryPanel && !recoveryPanel.classList.contains("hidden"));
  if (state.busy || state.pendingGeneration || recoveryVisible) {
    toast("Finish or resolve the active generation before editing the character profile.");
    return;
  }

  const campaignId = state.campaignId;
  const requestToken = ++characterProfileEditRequestToken;
  try {
    showBusy("Loading campaign character profile…");
    const profile = await apiClient.campaigns.getCharacterProfile(campaignId);
    if (requestToken !== characterProfileEditRequestToken || state.campaignId !== campaignId || dialog.open) return;
    const name = $("editCharacterProfileName");
    const editor = $("editCharacterProfileJson");
    const status = $("editCharacterProfileStatus");
    if (!name || !editor) return;
    state.characterProfileEditSession = {
      id: `edit-character-profile:${++nextCharacterProfileEditSessionId}`,
      campaignId,
      revision: profile.revision,
      saving: false
    };
    name.value = profile.name;
    editor.value = JSON.stringify(profile.profile, null, 2);
    if (status) status.textContent = `Editing character profile revision ${profile.revision}.`;
    openManagedModal(dialog);
    syncInputState();
  } catch (error) {
    if (requestToken === characterProfileEditRequestToken && state.campaignId === campaignId && !dialog.open) {
      toast(`Character profile could not be loaded: ${error.message}`);
    }
  } finally {
    if (requestToken === characterProfileEditRequestToken && state.campaignId === campaignId) hideBusy();
  }
}

async function saveEditCharacterProfile() {
  const session = state.characterProfileEditSession;
  const name = $("editCharacterProfileName");
  const editor = $("editCharacterProfileJson");
  const status = $("editCharacterProfileStatus");
  if (!session || session.saving || !name || !editor) return;

  let profile;
  try {
    profile = JSON.parse(editor.value);
  } catch (_) {
    if (status) status.textContent = "Profile JSON must be valid before it can be saved.";
    return;
  }
  if (!profile || Array.isArray(profile) || typeof profile !== "object") {
    if (status) status.textContent = "Profile JSON must be an object.";
    return;
  }

  session.saving = true;
  try {
    showBusy("Saving character profile…");
    const saved = await apiClient.campaigns.updateCharacterProfile(session.campaignId, {
      expectedRevision: session.revision,
      name: name.value,
      profile,
      editSource: "manual"
    });
    if (state.campaignId !== session.campaignId || state.characterProfileEditSession?.id !== session.id) return;
    state.playerConfig = {
      ...(state.playerConfig || {}),
      selectedCharacterName: saved.name,
      characterProfile: { name: saved.name, profile: saved.profile },
      characterProfileRevision: saved.revision
    };
    state.characterProfileEditSession = null;
    const dialog = $("editCharacterProfileDialog");
    if (dialog?.close) dialog.close();
    toast("Campaign character profile saved. The next story turn will use these changes.");
  } catch (error) {
    if (status) {
      status.textContent = (error?.status === 409 || error?.statusCode === 409)
        ? "The character profile changed. Reopen it to load the latest revision."
        : `Profile could not be saved: ${error.message}`;
    }
  } finally {
    if (state.characterProfileEditSession?.id === session.id) state.characterProfileEditSession.saving = false;
    hideBusy();
  }
}

// ── World Setup Dialog ────────────────────────────────────────
function openWorldSetup() {
  const dlg = $("worldSetupDialog");
  if (!dlg) return;
  const world = state.world || {};
  const camp = state.campaign || {};
  const pc = state.playerConfig || {};

  const titleEl = $("setupCampaignTitle");
  if (titleEl) titleEl.textContent = camp.title || world.title || "Untitled Campaign";

  const versionEl = $("setupWorldVersion");
  if (versionEl) {
    const vNum = world.versionNumber ? `v${world.versionNumber}` : "";
    const wTitle = world.title || "Unknown World";
    versionEl.textContent = `${wTitle} ${vNum}`.trim();
  }

  if ($("setupGenre")) $("setupGenre").textContent = world.genre || "None specified";
  if ($("setupTone")) $("setupTone").textContent = world.tone || "None specified";

  if ($("setupCharacter")) {
    const structured = pc.characterProfile;
    const profile = structured?.profile;
    const structuredText = profile ? [
      ...Object.values(profile.identity || {}).flatMap((value) => Array.isArray(value) ? value : [value]),
      ...Object.values(profile.story || {}),
      ...Object.values(profile.appearance || {}).flatMap((value) => Array.isArray(value) ? value : [value]),
      profile.unclassifiedNotes
    ].map((value) => String(value || "").trim()).filter(Boolean).join("\n\n") : "";
    const charName = pc.selectedCharacterName || structured?.name || pc.characterSnapshot?.name || world.character || "Player Character";
    const charDesc = structuredText || pc.characterSnapshot?.characterText || pc.characterSnapshot?.description || world.character || "No character details recorded.";
    $("setupCharacter").textContent = charName && charDesc && charName !== charDesc ? `${charName}\n\n${charDesc}` : (charDesc || charName);
  }

  if ($("setupPremise")) $("setupPremise").textContent = world.premise || "No starting premise specified.";
  if ($("setupBackgroundStory")) $("setupBackgroundStory").textContent = world.backgroundStory || "No background story provided.";
  if ($("setupRules")) $("setupRules").textContent = world.rules || "No story rules specified.";

  const statsContainer = $("setupRpgStats");
  if (statsContainer) {
    const stats = pc.rpgStats || [];
    if (!stats || stats.length === 0) {
      statsContainer.innerHTML = `<p class="dim mini">No RPG statistics defined.</p>`;
    } else {
      statsContainer.innerHTML = `<div class="stat-grid">` + stats.map(s => `
        <div class="stat-row">
          <span class="setup-stat-label">${escapeHtml(s.name)}:</span>
          <span>${s.value} d%</span>
          ${s.note ? `<span class="dim mini setup-stat-note">${escapeHtml(s.note)}</span>` : ""}
        </div>`).join("") + `</div>`;
    }
  }

  openManagedModal(dlg);
}

// ── Export Functions ──────────────────────────────────────────
async function exportMarkdown() {
  if (!state.campaignId) return;
  try {
    const response = await fetch(`/api/v1/campaigns/${encodeURIComponent(state.campaignId)}/readable-export?format=markdown`);
    if (!response.ok) throw new Error(`Export failed with HTTP ${response.status}.`);
    const disposition = response.headers.get("content-disposition") || "";
    const filename = disposition.match(/filename="([^"]+)"/i)?.[1] || "infinite-quest-story.md";
    downloadBlob(await response.blob(), filename);
    toast("Markdown export downloaded.");
  } catch (err) {
    toast(`Export failed: ${err.message}`);
  }
}

async function exportStandaloneHtml() {
  if (!state.campaignId) return;
  try {
    const response = await fetch(`/api/v1/campaigns/${encodeURIComponent(state.campaignId)}/readable-export?format=html`);
    if (!response.ok) throw new Error(`Export failed with HTTP ${response.status}.`);
    const disposition = response.headers.get("content-disposition") || "";
    const filename = disposition.match(/filename="([^"]+)"/i)?.[1] || "infinite-quest-story.html";
    downloadBlob(await response.blob(), filename);
    toast("Standalone HTML export downloaded.");
  } catch (err) {
    toast(`Export failed: ${err.message}`);
  }
}

async function printStory() {
  if (!state.campaignId) return;
  const printWindow = window.open("", "_blank");
  if (!printWindow) {
    toast("Allow pop-ups to print this story.");
    return;
  }
  printWindow.opener = null;
  printWindow.document.write("<!doctype html><title>Preparing story…</title><p>Preparing your story for PDF export…</p>");

  try {
    await ensureCompleteTurnHistory();
    const titleText = state.campaign?.title || "Infinite Quest Story";
    const title = escapeHtml(titleText);
    const turns = state.turns.map((turn) => {
      const action = turn.action ? `: ${escapeHtml(turn.action)}` : "";
      const turnId = turn.id || turn.turnId || "";
      const segments = illustrationSegmentsForTurn(turnId);
      const content = segments.length
        ? segments.map((segment) => {
            const narration = sanitizeNarration(segment.text);
            const imageUrl = String(segment.variants?.[0]?.url || "").trim();
            return `${narration}${imageUrl
              ? `<figure><img src="${escapeHtml(imageUrl)}" alt="Illustration for turn ${turn.turnNumber}, segment ${segment.ordinal + 1}"><figcaption>Turn ${turn.turnNumber} · Segment ${segment.ordinal + 1}</figcaption></figure>`
              : ""}`;
          }).join("")
        : `${sanitizeNarration(turn.narration || "")}${turn.imageAssetUrl || turn.imageUrl
          ? `<figure><img src="${escapeHtml(turn.imageAssetUrl || turn.imageUrl)}" alt="Illustration for turn ${turn.turnNumber}"><figcaption>Turn ${turn.turnNumber} illustration</figcaption></figure>`
          : ""}`;
      return `<section class="turn"><h2>Turn ${turn.turnNumber}${action}</h2>${content}</section>`;
    }).join("");
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><link rel="stylesheet" href="/nexus/story-print.css"></head><body><h1>${title}</h1>${turns || "<p>No accepted story turns are available yet.</p>"}</body></html>`;

    printWindow.document.open();
    printWindow.document.write(html);
    printWindow.document.close();
    const waitForImages = () => Promise.all([...printWindow.document.images].map((image) => (
      image.complete
        ? Promise.resolve()
        : new Promise((resolve) => {
            image.addEventListener("load", resolve, { once: true });
            image.addEventListener("error", resolve, { once: true });
          })
    )));
    await Promise.race([waitForImages(), new Promise((resolve) => setTimeout(resolve, 4000))]);
    printWindow.focus();
    printWindow.print();
    toast("Print dialog opened. Choose Save as PDF.");
  } catch (err) {
    printWindow.close();
    if (!isCompleteHistorySuperseded(err)) toast(`Export failed: ${err.message}`);
  }
}

function downloadBlob(blob, filename) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 100);
}

// ── Navigation & Dialog Management ────────────────────────────
function closeNavigationMenus(except = null) {
  document.querySelectorAll(".nav-menu.open").forEach((menu) => {
    if (menu !== except) setNavigationMenuState(menu, false);
  });
}

function setNavigationMenuState(menu, open) {
  const trigger = menu.querySelector(".nav-menu-trigger");
  const panel = menu.querySelector(".nav-menu-panel");
  menu.classList.toggle("open", open);
  if (trigger) trigger.setAttribute("aria-expanded", String(open));
  if (panel) panel.hidden = !open;
}

function initializeNavigationMenus() {
  document.querySelectorAll(".nav-menu-trigger").forEach((trigger) => {
    trigger.addEventListener("click", () => {
      const menu = trigger.closest(".nav-menu");
      if (!menu) return;
      const open = !menu.classList.contains("open");
      closeNavigationMenus(menu);
      setNavigationMenuState(menu, open);
    });
  });
  document.querySelectorAll(".nav-menu-panel a").forEach((link) => {
    link.addEventListener("click", () => closeNavigationMenus());
  });
  document.addEventListener("pointerdown", (event) => {
    if (!(event.target instanceof Element) || !event.target.closest(".nav-menu")) closeNavigationMenus();
  });
}

// ── Initialization ────────────────────────────────────────────
function reconcileCampaignStartup(campaignId) {
  const loadSequence = campaignLoadSequence;
  const current = () => campaignLoadSequence === loadSequence && state.campaignId === campaignId;
  if (campaignStartupReconciliation?.campaignId === campaignId
    && campaignStartupReconciliation.loadSequence === loadSequence) {
    return campaignStartupReconciliation.promise;
  }

  const reconciliation = { campaignId, loadSequence, promise: null };
  campaignStartupReconciliation = reconciliation;
  reconciliation.promise = (async () => {
    if (!current()) return false;
    const resumed = await resumePendingGeneration();
    if (!current()) return false;
    const needsExplicitRecoveryDecision = state.generationRecovery?.status === "recoverable"
      || state.generationRecovery?.status === "failed";
    if (!resumed && !needsExplicitRecoveryDecision && state.turns.length === 0 && !state.busy) {
      await startAdventure();
    }
    return current();
  })();
  return reconciliation.promise;
}

async function retryStoryCampaignLoad() {
  if (storyLoadRetryPromise) return storyLoadRetryPromise;
  const campaignId = state.campaignId;
  if (!campaignId) return false;
  const retryButton = $("storyLoadRetry");
  if (retryButton) retryButton.disabled = true;
  const retryPromise = (async () => {
    const loaded = await loadCampaign(campaignId);
    if (!loaded) return false;
    await reconcileCampaignStartup(campaignId);
    return true;
  })();
  storyLoadRetryPromise = retryPromise;
  try {
    return await retryPromise;
  } finally {
    if (storyLoadRetryPromise === retryPromise) storyLoadRetryPromise = null;
    if (retryButton) retryButton.disabled = false;
  }
}

async function init() {
  try {
    const sessionRes = await apiClient.session.get();
    if (sessionRes && sessionRes.user) {
      state.user = sessionRes.user;
    }
  } catch (err) {
    recordActivity("error", "Session profile unavailable", err.message);
  }
  const match = window.location.pathname.match(/\/story\/([^/]+)/);
  if (match) {
    const campaignId = decodeURIComponent(match[1]);
    const navStoryLink = $("navStoryLink");
    if (navStoryLink) navStoryLink.href = `/story/${encodeURIComponent(campaignId)}`;
    await checkOnboarding();
    if (!await loadCampaign(campaignId)) return;
    await reconcileCampaignStartup(campaignId);
  } else {
    await checkOnboarding();
    updateStatusBar();
    recordActivity("system", "Empty Story page opened", "Choose a world from the Nexus dashboard to begin a campaign.");
    return;
  }
}

// ── Boot Sequence ─────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  window.addEventListener("beforeunload", (event) => {
    flushReaderPositionSave();
    if (!actionDraftNeedsNavigationGuard()) return;
    event.preventDefault();
    event.returnValue = "";
    void flushActionDraftWrites();
  });
  window.addEventListener("pagehide", () => {
    void flushActionDraftWrites();
    flushReaderPositionSave();
  });
  document.addEventListener("click", (event) => {
    if (!(event.target instanceof Element)) return;
    const anchor = event.target.closest("a[href]");
    if (!anchor || anchor.hasAttribute("download") || anchor.target === "_blank") return;
    const target = new URL(anchor.href, window.location.href);
    if (target.origin !== window.location.origin || !actionDraftNeedsNavigationGuard()) return;
    event.preventDefault();
    void flushActionDraftWrites().then((saved) => {
      if (saved) {
        window.location.assign(target.href);
      } else {
        openActionDraftNavigationDialog(target.href);
      }
    });
  }, true);

  // Core action buttons
  const btnTakeAction = $("btnTakeAction");
  if (btnTakeAction) btnTakeAction.addEventListener("click", () => {
    const freeAction = $("freeAction");
    submitAction(freeAction ? freeAction.value : "");
  });

  const freeAction = $("freeAction");
  document.querySelectorAll("[data-turn-input-mode]").forEach((input) => {
    input.addEventListener("change", () => {
      if (input.checked) setTurnInputMode(input.value, { refreshPlaceholder: true, persistDraft: true });
    });
  });
  if (freeAction) {
    freeAction.addEventListener("input", () => {
      forgetRetainedAppendDraft();
      resetChoiceSelectionFromDraft(freeAction.value);
      setActionDraftValue(freeAction.value, { inputMode: state.turnInputMode });
      updateTurnInputCharacterCount();
    });
    freeAction.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submitAction(freeAction.value); }
    });
  }
  const btnClearTurnInput = $("btnClearTurnInput");
  if (btnClearTurnInput) btnClearTurnInput.addEventListener("click", () => {
    if (!freeAction || freeAction.disabled) return;
    forgetRetainedAppendDraft();
    freeAction.value = "";
    setActionDraftValue("", { inputMode: state.turnInputMode, clear: true });
    resetChoiceSelectionFromDraft("");
    updateTurnInputCharacterCount();
    freeAction.focus();
  });
  $("restoreActionDraft")?.addEventListener("click", () => { void reconcileActionDraftConflict("restore"); });
  $("keepActionDraft")?.addEventListener("click", () => { void reconcileActionDraftConflict("keep"); });
  $("discardActionDraft")?.addEventListener("click", () => { void reconcileActionDraftConflict("discard"); });
  const actionDraftNavigationDialog = $("actionDraftNavigationDialog");
  actionDraftNavigationDialog?.addEventListener("close", () => {
    if (actionDraftNavigationDialog.returnValue === "discard") void discardActionDraftBeforeNavigation();
    else actionDraftNavigationTarget = null;
  });

  // History navigation
  const btnPrev = $("btnPrev");
  if (btnPrev) btnPrev.addEventListener("click", goToPrevious);
  const btnNext = $("btnNext");
  if (btnNext) btnNext.addEventListener("click", goToNext);
  const btnReaderHistory = $("btnReaderHistory");
  if (btnReaderHistory) btnReaderHistory.addEventListener("click", openTurnHistoryModal);
  const btnReaderJumpLatest = $("btnReaderJumpLatest");
  if (btnReaderJumpLatest) btnReaderJumpLatest.addEventListener("click", () => navigateToTurn(null));
  const continuousReaderControls = ensureContinuousReaderControls();
  continuousReaderControls?.addEventListener("click", (event) => {
    const button = event.target instanceof Element ? event.target.closest("button") : null;
    if (!button) return;
    const direction = button.dataset.continuousReaderDirection;
    if (direction === "older" || direction === "newer") void loadContinuousReaderGroup(direction);
    else if (button.hasAttribute("data-continuous-reader-retry")) void retryContinuousReaderGroup();
  });
  syncContinuousReaderControls();
  const btnResumeReading = $("btnResumeReading");
  if (btnResumeReading) btnResumeReading.addEventListener("click", () => { void resumeSavedReaderPosition(); });
  const btnUndo = $("btnUndo");
  if (btnUndo) btnUndo.addEventListener("click", undoLatest);
  const btnRetry = $("btnRetry");
  if (btnRetry) btnRetry.addEventListener("click", retryLatest);
  const btnRetryPromptClose = $("btnRetryPromptClose");
  if (btnRetryPromptClose) btnRetryPromptClose.addEventListener("click", closeRetryPromptDialog);
  const btnRetryPromptCancel = $("btnRetryPromptCancel");
  if (btnRetryPromptCancel) btnRetryPromptCancel.addEventListener("click", closeRetryPromptDialog);
  const btnRetryPromptSubmit = $("btnRetryPromptSubmit");
  if (btnRetryPromptSubmit) btnRetryPromptSubmit.addEventListener("click", () => {
    const editor = $("retryPromptEditor");
    executeRetryWithPrompt(editor ? editor.value : "");
  });
  const retryPromptEditor = $("retryPromptEditor");
  if (retryPromptEditor) retryPromptEditor.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      executeRetryWithPrompt(retryPromptEditor.value);
    }
  });

  initializeNavigationMenus();
  const castButton = $("btnOpenCast");
  if (castButton && castPanel) castButton.addEventListener("click", () => {
    closeNavigationMenus(); void castPanel.open(document.querySelector('[aria-controls="storySetupMenu"]'));
  });

  // Navigation menu items
  const btnOpenWorldSetup = $("btnOpenWorldSetup");
  if (btnOpenWorldSetup) btnOpenWorldSetup.addEventListener("click", () => { closeNavigationMenus(); openWorldSetup(); });
  const btnExportMarkdown = $("btnExportMarkdown");
  if (btnExportMarkdown) btnExportMarkdown.addEventListener("click", () => { closeNavigationMenus(); exportMarkdown(); });
  const btnExportHtml = $("btnExportHtml");
  if (btnExportHtml) btnExportHtml.addEventListener("click", () => { closeNavigationMenus(); exportStandaloneHtml(); });
  const btnExportPdf = $("btnExportPdf");
  if (btnExportPdf) btnExportPdf.addEventListener("click", () => { closeNavigationMenus(); printStory(); });
  const btnOpenEditState = $("btnOpenEditState");
  if (btnOpenEditState) btnOpenEditState.addEventListener("click", () => { closeNavigationMenus(); openEditState(); });
  const btnOpenEditCharacterProfile = $("btnOpenEditCharacterProfile");
  if (btnOpenEditCharacterProfile) btnOpenEditCharacterProfile.addEventListener("click", () => { closeNavigationMenus(); void openEditCharacterProfile(); });
  const btnOpenEditResponse = $("btnOpenEditResponse");
  if (btnOpenEditResponse) btnOpenEditResponse.addEventListener("click", () => {
    closeNavigationMenus();
    void openCurrentResponseEditor();
  });
  const btnOpenActivityLog = $("btnOpenActivityLog");
  if (btnOpenActivityLog) btnOpenActivityLog.addEventListener("click", () => { closeNavigationMenus(); openActivityLog(); });
  const btnAboutNexus = $("btnAboutNexus");
  if (btnAboutNexus) btnAboutNexus.addEventListener("click", () => {
    closeNavigationMenus();
    const dialog = $("aboutNexusDialog");
    openManagedModal(dialog);
  });

  const btnOpenUserProfile = $("btnOpenUserProfile");
  if (btnOpenUserProfile) btnOpenUserProfile.addEventListener("click", () => { closeNavigationMenus(); openUserProfile(); });
  const userProfileDialog = $("userProfileDialog");
  if (userProfileDialog) {
    userProfileDialog.addEventListener("close", () => {
      applyReaderPreferences(state.user?.settings?.readerPreferences);
    });
    userProfileDialog.addEventListener("cancel", (event) => {
      if (userProfileSaving) event.preventDefault();
    });
  }
  const readerPreview = document.querySelector("[data-reader-preview]");
  if (readerPreview) readerPreview.addEventListener("click", previewReaderPreferences);
  const btnCloseUserProfile = $("btnCloseUserProfile");
  if (btnCloseUserProfile) btnCloseUserProfile.addEventListener("click", () => { const d = $("userProfileDialog"); if (d && d.close) d.close(); });
  const btnCancelUserProfile = $("btnCancelUserProfile");
  if (btnCancelUserProfile) btnCancelUserProfile.addEventListener("click", () => { const d = $("userProfileDialog"); if (d && d.close) d.close(); });
  const btnSaveUserProfile = $("btnSaveUserProfile");
  if (btnSaveUserProfile) btnSaveUserProfile.addEventListener("click", saveUserProfile);
  const defaultTurnControlStyle = $("userProfileDefaultTurnControlStyle");
  if (defaultTurnControlStyle) defaultTurnControlStyle.addEventListener("change", () => { userProfileTurnControlStyleChanged = true; });
  const storyMemoryLevel = $("storyMemoryLevel");
  $("storyContinuityReviewEnabled")?.addEventListener("change", () => { void saveStoryMemorySettings(); });
  if (storyMemoryLevel) storyMemoryLevel.addEventListener("change", () => { void saveStoryMemorySettings(); });

  // Edit State dialog
  const btnSaveEditState = $("btnSaveEditState") || $("btnSaveScratch");
  if (btnSaveEditState) btnSaveEditState.addEventListener("click", saveEditState);
  const btnCancelEditState = $("btnCancelEditState");
  if (btnCancelEditState) btnCancelEditState.addEventListener("click", () => {
    const d = $("editStateDialog");
    if (d) requestModalDismissal(d);
  });
  const btnEditStateViewHistory = $("btnEditStateViewHistory");
  if (btnEditStateViewHistory) btnEditStateViewHistory.addEventListener("click", () => {
    const d = $("editStateDialog");
    if (!d) return;
    requestDiscardChanges(d, () => {
      d.close();
      state.editStateSession = null;
      openTurnHistoryModal();
    });
  });
  const btnReloadEditState = $("btnReloadEditState");
  if (btnReloadEditState) btnReloadEditState.addEventListener("click", () => {
    const d = $("editStateDialog");
    if (!d) return;
    requestDiscardChanges(d, () => {
      d.close();
      state.editStateSession = null;
      void openEditState();
    });
  });
  const scratchpadEditor = $("scratchpadEditor");
  if (scratchpadEditor) scratchpadEditor.addEventListener("input", updateScratchpadCharacterCount);
  const btnAddTracker = $("btnAddTracker");
  if (btnAddTracker) btnAddTracker.addEventListener("click", addTrackerFromEditor);
  const btnAddOpenThread = $("btnAddOpenThread");
  if (btnAddOpenThread) btnAddOpenThread.addEventListener("click", () => {
    addEditableStateRow(document, $("editStateOpenThreads"), "thread");
  });
  const btnAddCanonicalFact = $("btnAddCanonicalFact");
  if (btnAddCanonicalFact) btnAddCanonicalFact.addEventListener("click", () => {
    addEditableStateRow(document, $("editStateCanonicalFacts"), "fact");
  });
  const btnCloseEditState = $("btnCloseEditState");
  if (btnCloseEditState) btnCloseEditState.addEventListener("click", () => {
    const d = $("editStateDialog");
    if (d) requestModalDismissal(d);
  });
  const editStateDialog = $("editStateDialog");
  if (editStateDialog) editStateDialog.addEventListener("close", () => {
    if (!state.editStateSession?.saving) state.editStateSession = null;
  });
  document.querySelectorAll("#editStateDialog .tab").forEach(tab => {
    tab.addEventListener("click", () => switchEditStateTab(tab.dataset.tab));
  });

  // Character profile dialog
  const btnSaveEditCharacterProfile = $("btnSaveEditCharacterProfile");
  if (btnSaveEditCharacterProfile) btnSaveEditCharacterProfile.addEventListener("click", () => { void saveEditCharacterProfile(); });
  ["btnCloseEditCharacterProfile", "btnCancelEditCharacterProfile"].forEach((id) => {
    const button = $(id);
    if (button) button.addEventListener("click", () => {
      const dialog = $("editCharacterProfileDialog");
      if (dialog) requestModalDismissal(dialog);
    });
  });
  const editCharacterProfileDialog = $("editCharacterProfileDialog");
  if (editCharacterProfileDialog) editCharacterProfileDialog.addEventListener("close", () => {
    characterProfileEditRequestToken += 1;
    if (!state.characterProfileEditSession?.saving) state.characterProfileEditSession = null;
  });

  // Turn History / Navigation dialog and pills
  ["turnPill", "viewPill"].forEach(id => {
    const el = $(id);
    if (el) {
      el.addEventListener("click", openTurnHistoryModal);
      el.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          openTurnHistoryModal();
        }
      });
    }
  });
  const btnCloseTurnHistory = $("btnCloseTurnHistory");
  if (btnCloseTurnHistory) btnCloseTurnHistory.addEventListener("click", () => { const d = $("turnHistoryDialog"); if (d && d.close) d.close(); });
  const btnTurnHistoryDone = $("btnTurnHistoryDone");
  if (btnTurnHistoryDone) btnTurnHistoryDone.addEventListener("click", () => { const d = $("turnHistoryDialog"); if (d && d.close) d.close(); });
  const turnHistoryDialog = $("turnHistoryDialog");
  if (turnHistoryDialog) turnHistoryDialog.addEventListener("close", () => {
    cancelStoryHistorySearchWork();
    state.historySearch = beginStoryHistorySearch(state.historySearch, storyHistorySearchScope(), "").state;
    const searchInput = $("turnHistorySearch");
    if (searchInput) searchInput.value = "";
    setStoryHistoryJumpStatus("idle", "");
    renderStoryHistorySearch();
  });
  $("turnHistorySearch")?.addEventListener("input", handleStoryHistorySearchInput);
  $("btnTurnHistorySearchClear")?.addEventListener("click", () => {
    const input = $("turnHistorySearch");
    if (!input) return;
    input.value = "";
    handleStoryHistorySearchInput();
    input.focus();
  });
  $("btnTurnHistorySearchMore")?.addEventListener("click", () => requestStoryHistorySearchPage("more"));
  $("btnTurnHistorySearchRetry")?.addEventListener("click", () => requestStoryHistorySearchPage("retry"));
  $("btnTurnHistoryJumpExact")?.addEventListener("click", () => { void jumpToExactHistoryTurn(); });
  $("turnHistoryJumpNumber")?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void jumpToExactHistoryTurn();
    }
  });
  const btnTurnHistoryInspect = $("btnTurnHistoryInspect");
  if (btnTurnHistoryInspect) btnTurnHistoryInspect.addEventListener("click", () => {
    if (state.historySelectedTurnNumber) inspectTurnState(state.historySelectedTurnNumber);
  });
  $("btnTurnHistoryOlder")?.addEventListener("click", () => { void changeStoryHistoryPage("older"); });
  $("btnTurnHistoryNewer")?.addEventListener("click", () => { void changeStoryHistoryPage("newer"); });
  $("btnTurnHistoryPreviousTurn")?.addEventListener("click", () => { void moveSelectedHistoryPreview(-1); });
  $("btnTurnHistoryNextTurn")?.addEventListener("click", () => { void moveSelectedHistoryPreview(1); });
  const btnTurnHistoryJump = $("btnTurnHistoryJump");
  if (btnTurnHistoryJump) btnTurnHistoryJump.addEventListener("click", () => {
    jumpToSelectedHistoryTurn();
  });
  const btnTurnHistoryBranch = $("btnTurnHistoryBranch");
  if (btnTurnHistoryBranch) btnTurnHistoryBranch.addEventListener("click", () => {
    if (!Number.isInteger(state.historySelectedTurnNumber)
      || !historyWindowContainsTurn(state.historySelectedTurnNumber)
      || state.historySelectedTurnNumber >= state.campaign?.activeTurnNumber) return;
    const d = $("turnHistoryDialog");
    if (d && d.close) d.close();
    promptBranchOrReset(state.historySelectedTurnNumber);
  });
  const btnTurnHistoryJumpLatest = $("btnTurnHistoryJumpLatest");
  if (btnTurnHistoryJumpLatest) btnTurnHistoryJumpLatest.addEventListener("click", () => {
    navigateToTurn(null);
    const d = $("turnHistoryDialog");
    if (d && d.close) d.close();
  });

  // World Setup dialog
  const btnCloseWorldSetup = $("btnCloseWorldSetup");
  if (btnCloseWorldSetup) btnCloseWorldSetup.addEventListener("click", () => { const d = $("worldSetupDialog"); if (d && d.close) d.close(); });
  const btnDoneWorldSetup = $("btnDoneWorldSetup");
  if (btnDoneWorldSetup) btnDoneWorldSetup.addEventListener("click", () => { const d = $("worldSetupDialog"); if (d && d.close) d.close(); });
  // Image prompt dialog
  const btnRegenerateImageConfirm = $("btnRegenerateImageConfirm");
  if (btnRegenerateImageConfirm) btnRegenerateImageConfirm.addEventListener("click", () => {
    const dlg = $("imagePromptDialog");
    const editor = $("imagePromptEditor");
    if (dlg && dlg._segmentId && editor) {
      regenerateSegmentImage(dlg._segmentId, dlg._variantIndex || 0, editor.value);
      if (dlg.close) dlg.close();
    }
  });
  const btnImagePromptCancel = $("btnImagePromptCancel");
  if (btnImagePromptCancel) btnImagePromptCancel.addEventListener("click", () => { const d = $("imagePromptDialog"); if (d && d.close) d.close(); });
  // Branch dialog
  const branchDlg = $("branchStoryDialog");
  if (branchDlg) branchDlg.addEventListener("close", async () => {
    const result = branchDlg.returnValue;
    if (result === "reset" && branchDlg._targetTurnNumber !== undefined) {
      showBusy("Rewinding campaign…");
      try {
        await apiClient.campaigns.rewind(state.campaignId, { targetTurnNumber: branchDlg._targetTurnNumber });
        await loadCampaign(state.campaignId);
        navigateToTurn(null);
        toast("Campaign rewound.");
      } catch (err) {
        toast(`Rewind failed: ${err.message}`);
      } finally {
        hideBusy();
      }
    }
    if (result === "copy" && branchDlg._targetTurnNumber !== undefined) {
      showBusy("Creating campaign branch…");
      try {
        await branchCampaignFromTurn(state.campaignId, branchDlg._targetTurnNumber, apiClient.campaigns.branch);
      } catch (err) {
        toast(`Branch failed: ${err.message}`);
      } finally {
        hideBusy();
      }
    }
  });

  // Story and illustration rail delegated click handler.
  const handleStoryAction = (e) => {
    if (e.target.closest('[data-action="refresh-illustrations"]')) {
      void refreshIllustrations();
      return;
    }
    const btn = e.target.closest("[data-action]");
    if (!btn) return;
    if (btn.dataset.action === "follow-stream") {
      followStreamingPreview();
      return;
    }
    if (btn.dataset.action === "cancel-generation") {
      void cancelActiveGeneration();
      return;
    }
    if (btn.dataset.action === "previous-segment-image" || btn.dataset.action === "next-segment-image") {
      const segment = state.illustrationSegments.find((item) => item.id === btn.dataset.segmentId);
      const count = segment?.variants?.length || 0;
      if (!segment || count < 2) return;
      const current = state.illustrationVariantIndexes.get(segment.id) || 0;
      const offset = btn.dataset.action === "next-segment-image" ? 1 : -1;
      state.illustrationVariantIndexes.set(segment.id, (current + offset + count) % count);
      renderStoryIllustration();
      return;
    }
    const segmentId = btn.dataset.segmentId;
    const variantIndex = Number(btn.dataset.variantIndex || 0);
    if (btn.dataset.action === "edit-segment-image-prompt") {
      openSegmentImagePromptEditor(segmentId, variantIndex);
      return;
    }
    if (btn.dataset.action === "regenerate-segment-image") {
      regenerateSegmentImage(segmentId, variantIndex);
      return;
    }
    if (btn.dataset.action === "why-segment-image") {
      whySegmentImage(segmentId, variantIndex);
      return;
    }
    const turnId = btn.dataset.turnId;
    if (btn.dataset.action === "generate-turn-segments") generateTurnSegments(turnId, "missing");
    if (btn.dataset.action === "rebuild-turn-segments") generateTurnSegments(turnId, "rebuild");
    if (btn.dataset.action === "edit-image-prompt") openImagePromptEditor(turnId);
    if (btn.dataset.action === "find-library-match") findAnotherLibraryMatch(turnId);
    if (btn.dataset.action === "why-image") whyIllustration(turnId);
  };
  const storyArea = $("storyArea");
  if (storyArea) storyArea.addEventListener("click", handleStoryAction);
  const storyIllustrationPanel = $("storyIllustrationPanel");
  if (storyIllustrationPanel) storyIllustrationPanel.addEventListener("click", handleStoryAction);

  // A manual scroll means the reader has chosen their own position. Streaming
  // updates must not recapture the viewport until they explicitly resume.
  document.addEventListener("wheel", noteReaderPositionIntent, { capture: true, passive: true });
  document.addEventListener("touchmove", noteReaderPositionIntent, { capture: true, passive: true });
  document.addEventListener("pointerdown", (event) => {
    if (!event.isTrusted || event.button !== 0) return;
    const root = document.documentElement;
    if (window.innerWidth <= root.clientWidth) return;
    const rootBounds = root.getBoundingClientRect();
    const pointerOutsideRootGutter = event.clientX < rootBounds.left || event.clientX >= rootBounds.right;
    if (pointerOutsideRootGutter) noteReaderPositionIntent(event);
  }, { capture: true });

  window.addEventListener("wheel", pauseStreamingAutoFollow, { passive: true });
  window.addEventListener("touchmove", pauseStreamingAutoFollow, { passive: true });
  window.addEventListener("scroll", () => {

    scheduleReaderPositionSave();
    if (!state.streamingAutoFollow || !$("streamingPreviewCard")) return;
    if (state.streamingExpectedScrollY === null || Math.abs(window.scrollY - state.streamingExpectedScrollY) > 1) {
      pauseStreamingAutoFollow();
    }
  }, { passive: true });
  document.addEventListener("keydown", (e) => {
    const target = e.target;
    if (target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))) return;
    if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(e.key)) {
      noteReaderPositionIntent(e);
      pauseStreamingAutoFollow();
    }
  });

  // Activity log
  function openActivityLog() {
    const dlg = $("activityLogDialog");
    if (!dlg) return;
    renderActivityLog();
    openManagedModal(dlg);
  }
  const btnCloseActivityLog = $("btnCloseActivityLog");
  if (btnCloseActivityLog) btnCloseActivityLog.addEventListener("click", () => { const d = $("activityLogDialog"); if (d && d.close) d.close(); });
  const btnCopyDiagnostics = $("btnCopyDiagnostics") || $("btnCopyActivityLog");
  if (btnCopyDiagnostics) btnCopyDiagnostics.addEventListener("click", copyActivityDiagnostics);
  const btnClearActivityLog = $("btnClearActivityLog");
  if (btnClearActivityLog) btnClearActivityLog.addEventListener("click", () => { state.activityLog = []; renderActivityLog(); toast("Activity log cleared."); });
  const btnActivityLogDone = $("btnActivityLogDone");
  if (btnActivityLogDone) btnActivityLogDone.addEventListener("click", () => { const d = $("activityLogDialog"); if (d && d.close) d.close(); });

  // Message Popup / Getting Started / Recovery
  const btnMessagePopupClose = $("btnMessagePopupClose");
  if (btnMessagePopupClose) btnMessagePopupClose.addEventListener("click", () => { const d = $("messagePopupDialog"); if (d && d.close) d.close(); });
  const btnSkipGettingStartedToStory = $("btnSkipGettingStartedToStory");
  if (btnSkipGettingStartedToStory) btnSkipGettingStartedToStory.addEventListener("click", () => { const d = $("gettingStartedDialog"); if (d && d.close) d.close(); });
  const btnDiscardGenerationRecovery = $("btnDiscardGenerationRecovery");
  if (btnDiscardGenerationRecovery) btnDiscardGenerationRecovery.addEventListener("click", discardRecoveryJob);
  const btnRetryStoryLoad = $("storyLoadRetry");
  if (btnRetryStoryLoad) btnRetryStoryLoad.addEventListener("click", () => {
    void retryStoryCampaignLoad();
  });
  const btnContinueGeneration = $("btnContinueGeneration");
  if (btnContinueGeneration) btnContinueGeneration.addEventListener("click", () => monitorRecoveryJob(false));
  const btnRetryGeneration = $("btnRetryGeneration");
  if (btnRetryGeneration) btnRetryGeneration.addEventListener("click", () => {
    if (state.generationRecoveryKind === "result") void retryCompletedGenerationResult();
    else void monitorRecoveryJob(true);
  });
  const btnKeepGenerationReview = $("btnKeepGenerationReview");
  if (btnKeepGenerationReview) btnKeepGenerationReview.addEventListener("click", () => { void decideGenerationReview("keep"); });
  const btnRetryGenerationReview = $("btnRetryGenerationReview");
  if (btnRetryGenerationReview) btnRetryGenerationReview.addEventListener("click", () => { void decideGenerationReview("retry"); });
  const btnRepairFormatGenerationReview = $("btnRepairFormatGenerationReview");
  if (btnRepairFormatGenerationReview) btnRepairFormatGenerationReview.addEventListener("click", () => { void decideGenerationReview("repair_format"); });

  // Edit Response dialog
  const btnEditResponseSave = $("btnEditResponseSave");
  if (btnEditResponseSave) btnEditResponseSave.addEventListener("click", () => { void saveCurrentResponseCorrection(); });
  const responseEditor = $("responseEditor");
  if (responseEditor) responseEditor.addEventListener("input", syncResponseEditorControls);
  const btnEditResponseCancel = $("btnEditResponseCancel");
  if (btnEditResponseCancel) btnEditResponseCancel.addEventListener("click", () => { const d = $("editResponseDialog"); if (d && d.close) d.close(); });
  const btnEditResponseClose = $("btnEditResponseClose");
  if (btnEditResponseClose) btnEditResponseClose.addEventListener("click", () => { const d = $("editResponseDialog"); if (d && d.close) d.close(); });

  // Keyboard: Escape respects unsaved changes and only dismisses the topmost dialog.
  document.addEventListener("keydown", (event) => {
    handleStoryEscape(event, { document, requestModalDismissal, closeNavigationMenus });
  });

  // Start
  apiClient.meta.get()
    .then(metadata => {
      const application = metadata?.application;
      if (!application?.version) return;
      const versionLabel = `Nexus v${application.version}`;
      const storyVersion = $("storyNexusVersion");
      if (storyVersion) {
        storyVersion.textContent = versionLabel;
        storyVersion.classList.remove("hidden");
      }
      const aboutVersion = $("aboutNexusVersion");
      if (aboutVersion) aboutVersion.textContent = `v${application.version}`;
      if (application.commit) {
        $("aboutNexusCommit").textContent = application.commit;
        $("aboutNexusCommitRow").classList.remove("hidden");
      }
      if (application.builtAt) {
        const builtAt = new Date(application.builtAt);
        $("aboutNexusBuiltAt").textContent = Number.isNaN(builtAt.valueOf()) ? application.builtAt : builtAt.toLocaleString();
        $("aboutNexusBuiltAtRow").classList.remove("hidden");
      }
    })
    .catch(() => {});
  const initPromise = init();
  initPromise.then(resolveInitialization, rejectInitialization);
  // The production entry point does not consume the readiness promise. Keep
  // initialization failures observable to callers without creating an
  // unhandled rejection when the return value is intentionally ignored.
  initPromise.catch(() => {});
});

return initialization;
}
