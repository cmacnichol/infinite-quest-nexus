export type ReadingWidth = "narrow" | "standard" | "wide";

export const STORY_READING_WIDTH_STORAGE_KEY = "infinite-quest.story.reading-width";

export type StoryUiPhase = "chooser" | "loading" | "loaded" | "error" | "not_found";

export interface StoryUiState {
  readonly phase: StoryUiPhase;
  readonly viewTurnNumber: number | null;
  readonly readingWidth: ReadingWidth;
  readonly draft: string;
  readonly choiceSelection: readonly string[];
  readonly activeDialog: string | null;
  readonly history: "idle" | "loading" | "error";
  readonly illustration: "idle" | "loading" | "unavailable";
  readonly activity: "idle" | "generating" | "recoverable";
  readonly message: string | null;
}

export interface StoryUiModel {
  get(): Readonly<StoryUiState>;
  subscribe(listener: (state: Readonly<StoryUiState>) => void): () => void;
  setReadingWidth(width: ReadingWidth): void;
  setViewTurnNumber(turnNumber: number | null): void;
  setDraft(draft: string): void;
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
  activeDialog: null,
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
      ? value.choiceSelection.filter((choice): choice is string => typeof choice === "string")
      : DEFAULT_STATE.choiceSelection,
    activeDialog: typeof value.activeDialog === "string" || value.activeDialog === null
      ? value.activeDialog : DEFAULT_STATE.activeDialog,
    history: value.history === "idle" || value.history === "loading" || value.history === "error"
      ? value.history : DEFAULT_STATE.history,
    illustration: value.illustration === "idle" || value.illustration === "loading" || value.illustration === "unavailable"
      ? value.illustration : DEFAULT_STATE.illustration,
    activity: value.activity === "idle" || value.activity === "generating" || value.activity === "recoverable"
      ? value.activity : DEFAULT_STATE.activity,
    message: typeof value.message === "string" || value.message === null ? value.message : DEFAULT_STATE.message
  };
}

function snapshot(state: StoryUiState): StoryUiState {
  return { ...state, choiceSelection: [...state.choiceSelection] };
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
    setDraft(draft) {
      if (state.draft !== draft) publish({ ...state, draft });
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
