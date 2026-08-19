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
    return stored === "narrow" || stored === "wide" || stored === "standard" ? stored : "standard";
  } catch {
    return "standard";
  }
}

export function createStoryUiModel(
  initial: Partial<StoryUiState> = {},
  storage: Pick<Storage, "getItem" | "setItem"> | null = null
): StoryUiModel {
  const listeners = new Set<(state: Readonly<StoryUiState>) => void>();
  let state: StoryUiState = {
    ...DEFAULT_STATE,
    ...initial,
    readingWidth: initial.readingWidth ?? readingWidthFromStorage(storage)
  };
  let disposed = false;

  const publish = (next: StoryUiState) => {
    if (disposed || Object.is(state, next)) return;
    state = next;
    for (const listener of [...listeners]) listener(state);
  };

  return {
    get: () => state,
    subscribe(listener) {
      if (disposed) return () => undefined;
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setReadingWidth(readingWidth) {
      if (disposed || state.readingWidth === readingWidth) return;
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
