import {
  createChoiceDraftSelection,
  turnInputModeForControlStyle,
  type ChoiceDraftSelection,
  type StoryTurnInputMode
} from "@infinite-quest/client-core";

export type ReadingWidth = "narrow" | "standard" | "wide";

export const STORY_READING_WIDTH_STORAGE_KEY = "infinite-quest.story.reading-width";

export type StoryUiPhase = "chooser" | "loading" | "loaded" | "error" | "not_found";

export interface StoryIntentConfirmation {
  readonly action: string;
  readonly classificationId: string;
  readonly requestedInputMode: "auto";
}

export interface StoryUiState {
  readonly phase: StoryUiPhase;
  readonly viewTurnNumber: number | null;
  readonly readingWidth: ReadingWidth;
  readonly draft: string;
  readonly choiceSelection: readonly number[];
  readonly choiceBaseText: string;
  readonly draftOwnerKey: string | null;
  readonly draftOwnerTurnNumber: number | null;
  readonly requestedInputMode: StoryTurnInputMode;
  readonly intentConfirmation: StoryIntentConfirmation | null;
  readonly activeDialog: string | null;
  readonly continuousReading: boolean;
  readonly generationFollowing: boolean;
  readonly history: "idle" | "loading" | "error";
  readonly illustration: "idle" | "loading" | "disabled" | "ready" | "unavailable";
  readonly activity: "idle" | "generating" | "recoverable";
  readonly message: string | null;
}

export interface StoryUiModel {
  get(): Readonly<StoryUiState>;
  subscribe(listener: (state: Readonly<StoryUiState>) => void): () => void;
  setReadingWidth(width: ReadingWidth): void;
  setViewTurnNumber(turnNumber: number | null): void;
  setHistory(status: StoryUiState["history"]): void;
  setActiveDialog(dialog: string | null): void;
  setContinuousReading(enabled: boolean): void;
  setGenerationFollowing(enabled: boolean): void;
  setDraft(draft: string): void;
  syncComposer(campaignId: string, acceptedTurnNumber: number, turnControlStyle: unknown): void;
  setComposerDraft(draft: string): void;
  restoreComposerDraft(draft: string): void;
  setChoiceDraft(selection: ChoiceDraftSelection, draft: string): void;
  setRequestedInputMode(mode: StoryTurnInputMode): void;
  setIntentConfirmation(intent: StoryIntentConfirmation | null): void;
  clearComposerDraft(): void;
  clearSubmittedComposerDraft(submittedDraft: string): void;
  setPhase(phase: StoryUiPhase): void;
  setMessage(message: string | null): void;
  dispose(): void;
}

const DEFAULT_STATE: StoryUiState = {
  phase: "loading",
  viewTurnNumber: null,
  readingWidth: "standard",
  draft: "",
  choiceSelection: [],
  choiceBaseText: "",
  draftOwnerKey: null,
  draftOwnerTurnNumber: null,
  requestedInputMode: "action",
  intentConfirmation: null,
  activeDialog: null,
  continuousReading: false,
  generationFollowing: true,
  history: "idle",
  illustration: "idle",
  activity: "idle",
  message: null
};

function readingWidthFromStorage(storage: Pick<Storage, "getItem"> | null | undefined): ReadingWidth {
  try {
    const stored = storage?.getItem(STORY_READING_WIDTH_STORAGE_KEY);
    return isReadingWidth(stored) ? stored : "standard";
  } catch {
    return "standard";
  }
}

function isReadingWidth(value: unknown): value is ReadingWidth {
  return value === "narrow" || value === "wide" || value === "standard";
}

function localInitialState(
  initial: Partial<StoryUiState>,
  storage: Pick<Storage, "getItem"> | null
): StoryUiState {
  const value = initial !== null && typeof initial === "object" && !Array.isArray(initial) ? initial : {};
  return {
    phase: value.phase === "chooser" || value.phase === "loading" || value.phase === "loaded"
      || value.phase === "error" || value.phase === "not_found" ? value.phase : DEFAULT_STATE.phase,
    viewTurnNumber: typeof value.viewTurnNumber === "number" && Number.isSafeInteger(value.viewTurnNumber)
      ? value.viewTurnNumber : value.viewTurnNumber === null ? null : DEFAULT_STATE.viewTurnNumber,
    readingWidth: isReadingWidth(value.readingWidth) ? value.readingWidth : readingWidthFromStorage(storage),
    draft: typeof value.draft === "string" ? value.draft : DEFAULT_STATE.draft,
    choiceSelection: Array.isArray(value.choiceSelection)
      ? value.choiceSelection.filter((choice): choice is number => typeof choice === "number" && Number.isSafeInteger(choice) && choice >= 0)
      : DEFAULT_STATE.choiceSelection,
    choiceBaseText: typeof value.choiceBaseText === "string" ? value.choiceBaseText : DEFAULT_STATE.choiceBaseText,
    draftOwnerKey: typeof value.draftOwnerKey === "string" || value.draftOwnerKey === null
      ? value.draftOwnerKey : DEFAULT_STATE.draftOwnerKey,
    draftOwnerTurnNumber: typeof value.draftOwnerTurnNumber === "number" && Number.isSafeInteger(value.draftOwnerTurnNumber)
      ? value.draftOwnerTurnNumber : value.draftOwnerTurnNumber === null ? null : DEFAULT_STATE.draftOwnerTurnNumber,
    requestedInputMode: value.requestedInputMode === "auto" || value.requestedInputMode === "scene" || value.requestedInputMode === "action"
      ? value.requestedInputMode : DEFAULT_STATE.requestedInputMode,
    intentConfirmation: isIntentConfirmation(value.intentConfirmation) ? value.intentConfirmation : DEFAULT_STATE.intentConfirmation,
    activeDialog: typeof value.activeDialog === "string" || value.activeDialog === null
      ? value.activeDialog : DEFAULT_STATE.activeDialog,
    continuousReading: value.continuousReading === true,
    generationFollowing: value.generationFollowing !== false,
    history: value.history === "idle" || value.history === "loading" || value.history === "error"
      ? value.history : DEFAULT_STATE.history,
    illustration: value.illustration === "idle" || value.illustration === "loading" || value.illustration === "disabled"
      || value.illustration === "ready" || value.illustration === "unavailable"
      ? value.illustration : DEFAULT_STATE.illustration,
    activity: value.activity === "idle" || value.activity === "generating" || value.activity === "recoverable"
      ? value.activity : DEFAULT_STATE.activity,
    message: typeof value.message === "string" || value.message === null ? value.message : DEFAULT_STATE.message
  };
}

function snapshot(state: StoryUiState): StoryUiState {
  return { ...state, choiceSelection: [...state.choiceSelection] };
}

function isIntentConfirmation(value: unknown): value is StoryIntentConfirmation {
  return typeof value === "object" && value !== null
    && typeof (value as { action?: unknown }).action === "string"
    && typeof (value as { classificationId?: unknown }).classificationId === "string"
    && (value as { requestedInputMode?: unknown }).requestedInputMode === "auto";
}

export function createStoryUiModel(
  initial: Partial<StoryUiState> = {},
  storage: Pick<Storage, "getItem" | "setItem"> | null = null
): StoryUiModel {
  const listeners = new Set<(state: Readonly<StoryUiState>) => void>();
  let state = localInitialState(initial, storage);
  let disposed = false;

  const publish = (next: StoryUiState) => {
    if (disposed || Object.is(state, next)) return;
    state = next;
    for (const listener of [...listeners]) listener(snapshot(state));
  };

  return {
    get: () => snapshot(state),
    subscribe(listener) {
      if (disposed) return () => undefined;
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setReadingWidth(readingWidth) {
      if (disposed || !isReadingWidth(readingWidth) || state.readingWidth === readingWidth) return;
      try {
        storage?.setItem(STORY_READING_WIDTH_STORAGE_KEY, readingWidth);
      } catch {
        // Reader controls continue to work when browser storage is blocked.
      }
      publish({ ...state, readingWidth });
    },
    setViewTurnNumber(viewTurnNumber) {
      if (state.viewTurnNumber !== viewTurnNumber) publish({ ...state, viewTurnNumber });
    },
    setHistory(history) {
      if (state.history !== history) publish({ ...state, history });
    },
    setActiveDialog(activeDialog) {
      if (state.activeDialog !== activeDialog) publish({ ...state, activeDialog });
    },
    setContinuousReading(continuousReading) {
      if (typeof continuousReading === "boolean" && state.continuousReading !== continuousReading) {
        publish({ ...state, continuousReading });
      }
    },
    setGenerationFollowing(generationFollowing) {
      if (typeof generationFollowing === "boolean" && state.generationFollowing !== generationFollowing) {
        publish({ ...state, generationFollowing });
      }
    },
    setDraft(draft) {
      if (state.draft !== draft) publish({ ...state, draft });
    },
    syncComposer(campaignId, acceptedTurnNumber, turnControlStyle) {
      if (!campaignId || !Number.isSafeInteger(acceptedTurnNumber) || acceptedTurnNumber < 0) return;
      const ownerKey = `${campaignId}:${acceptedTurnNumber}`;
      if (state.draftOwnerKey === ownerKey) return;
      const selection = createChoiceDraftSelection();
      publish({
        ...state,
        draft: "",
        choiceSelection: selection.selectedIndexes,
        choiceBaseText: selection.baseText,
        draftOwnerKey: ownerKey,
        draftOwnerTurnNumber: acceptedTurnNumber,
        requestedInputMode: turnInputModeForControlStyle(turnControlStyle),
        intentConfirmation: null,
        message: null
      });
    },
    setComposerDraft(draft) {
      const selection = createChoiceDraftSelection(draft);
      if (state.draft === draft && !state.choiceSelection.length && state.choiceBaseText === selection.baseText && state.intentConfirmation === null) return;
      state = { ...state, draft, choiceSelection: selection.selectedIndexes, choiceBaseText: selection.baseText, intentConfirmation: null };
    },
    restoreComposerDraft(draft) {
      const selection = createChoiceDraftSelection(draft);
      if (state.draft === draft && !state.choiceSelection.length && state.choiceBaseText === selection.baseText && state.intentConfirmation === null) return;
      publish({ ...state, draft, choiceSelection: selection.selectedIndexes, choiceBaseText: selection.baseText, intentConfirmation: null });
    },
    setChoiceDraft(selection, draft) {
      const selectedIndexes = selection.selectedIndexes.filter((index) => Number.isSafeInteger(index) && index >= 0);
      if (state.draft === draft && state.choiceBaseText === selection.baseText && state.choiceSelection.join(",") === selectedIndexes.join(",")) return;
      publish({ ...state, draft, choiceBaseText: selection.baseText, choiceSelection: selectedIndexes, intentConfirmation: null });
    },
    setRequestedInputMode(requestedInputMode) {
      if (requestedInputMode !== "auto" && requestedInputMode !== "action" && requestedInputMode !== "scene") return;
      if (state.requestedInputMode !== requestedInputMode || state.intentConfirmation !== null) {
        publish({ ...state, requestedInputMode, intentConfirmation: null });
      }
    },
    setIntentConfirmation(intentConfirmation) {
      if (state.intentConfirmation !== intentConfirmation) publish({ ...state, intentConfirmation });
    },
    clearComposerDraft() {
      const selection = createChoiceDraftSelection();
      if (!state.draft && !state.choiceSelection.length && state.intentConfirmation === null) return;
      publish({ ...state, draft: "", choiceSelection: selection.selectedIndexes, choiceBaseText: selection.baseText, intentConfirmation: null, message: null });
    },
    clearSubmittedComposerDraft(submittedDraft) {
      if (state.draft !== submittedDraft) return;
      const selection = createChoiceDraftSelection();
      publish({ ...state, draft: "", choiceSelection: selection.selectedIndexes, choiceBaseText: selection.baseText, intentConfirmation: null, message: null });
    },
    setPhase(phase) {
      if (state.phase !== phase) publish({ ...state, phase });
    },
    setMessage(message) {
      if (state.message !== message) publish({ ...state, message });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      listeners.clear();
    }
  };
}
