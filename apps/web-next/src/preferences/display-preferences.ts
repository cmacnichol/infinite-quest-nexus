export type StoryWidth = "auto" | "comfortable" | "wide" | "full";

export interface DisplayPreferences {
  readonly version: 1;
  readonly storyWidth: StoryWidth;
  readonly artworkByCampaign: Readonly<Record<string, boolean>>;
  readonly artworkByTurn: Readonly<Record<string, boolean>>;
}

export interface DisplayPreferencesStore {
  get(): DisplayPreferences;
  setStoryWidth(width: StoryWidth): void;
  setCampaignArtwork(campaignId: string, visible: boolean): void;
  setTurnArtwork(campaignId: string, turnId: string, visible: boolean | null): void;
  artworkVisible(campaignId: string, turnId: string): boolean;
  subscribe(listener: (state: DisplayPreferences) => void): () => void;
  reload(): void;
  dispose(): void;
}

const DISPLAY_PREFERENCES_KEY = "infinite-quest.display-preferences.v1";
const LEGACY_READING_WIDTH_KEY = "infinite-quest.story.reading-width";
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

const DEFAULT_PREFERENCES: DisplayPreferences = {
  version: 1,
  storyWidth: "auto",
  artworkByCampaign: {},
  artworkByTurn: {}
};

function isStoryWidth(value: unknown): value is StoryWidth {
  return value === "auto" || value === "comfortable" || value === "wide" || value === "full";
}

function isSafeIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !UNSAFE_KEYS.has(value);
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function copyBooleanMap(value: unknown, turnKeys = false): Record<string, boolean> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const map: Record<string, boolean> = {};
  for (const key of Object.keys(value)) {
    if (UNSAFE_KEYS.has(key) || typeof (value as Record<string, unknown>)[key] !== "boolean") return null;
    if (turnKeys && !isTurnKey(key)) return null;
    map[key] = (value as Record<string, boolean>)[key];
  }
  return map;
}

function isTurnKey(key: string): boolean {
  try {
    const value: unknown = JSON.parse(key);
    return Array.isArray(value) && value.length === 2 && isSafeIdentifier(value[0]) && isSafeIdentifier(value[1]);
  } catch {
    return false;
  }
}

function turnKey(campaignId: string, turnId: string): string {
  return JSON.stringify([campaignId, turnId]);
}

function snapshot(state: DisplayPreferences): DisplayPreferences {
  return {
    version: 1,
    storyWidth: state.storyWidth,
    artworkByCampaign: { ...state.artworkByCampaign },
    artworkByTurn: { ...state.artworkByTurn }
  };
}

function parsePreferences(value: string | null): DisplayPreferences | null {
  if (value === null) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const candidate = parsed as Record<string, unknown>;
    if (candidate.version !== 1 || !isStoryWidth(candidate.storyWidth)) return null;
    const artworkByCampaign = copyBooleanMap(candidate.artworkByCampaign);
    const artworkByTurn = copyBooleanMap(candidate.artworkByTurn, true);
    if (artworkByCampaign === null || artworkByTurn === null) return null;
    return { version: 1, storyWidth: candidate.storyWidth, artworkByCampaign, artworkByTurn };
  } catch {
    return null;
  }
}

function legacyPreferences(value: string | null): DisplayPreferences {
  const storyWidth = value === "narrow" ? "comfortable"
    : value === "standard" ? "wide"
      : value === "wide" ? "full"
        : DEFAULT_PREFERENCES.storyWidth;
  return { ...DEFAULT_PREFERENCES, storyWidth };
}

function readPreferences(storage: Pick<Storage, "getItem"> | null): DisplayPreferences {
  try {
    const current = parsePreferences(storage?.getItem(DISPLAY_PREFERENCES_KEY) ?? null);
    return current ?? legacyPreferences(storage?.getItem(LEGACY_READING_WIDTH_KEY) ?? null);
  } catch {
    return snapshot(DEFAULT_PREFERENCES);
  }
}

function equalPreferences(left: DisplayPreferences, right: DisplayPreferences): boolean {
  return left.storyWidth === right.storyWidth
    && JSON.stringify(left.artworkByCampaign) === JSON.stringify(right.artworkByCampaign)
    && JSON.stringify(left.artworkByTurn) === JSON.stringify(right.artworkByTurn);
}

export function createDisplayPreferences(
  storage: Pick<Storage, "getItem" | "setItem"> | null
): DisplayPreferencesStore {
  let state = readPreferences(storage);
  let disposed = false;
  const listeners = new Set<(state: DisplayPreferences) => void>();

  const publish = (next: DisplayPreferences): void => {
    if (disposed || equalPreferences(state, next)) return;
    state = next;
    for (const listener of [...listeners]) listener(snapshot(state));
  };

  const persist = (): void => {
    try {
      storage?.setItem(DISPLAY_PREFERENCES_KEY, JSON.stringify(state));
    } catch {
      // Display preferences remain usable when browser storage is unavailable.
    }
  };

  const update = (next: DisplayPreferences): void => {
    if (disposed || equalPreferences(state, next)) return;
    state = next;
    persist();
    for (const listener of [...listeners]) listener(snapshot(state));
  };

  return {
    get: () => snapshot(state),
    setStoryWidth(width) {
      if (!isStoryWidth(width)) return;
      update({ ...state, storyWidth: width });
    },
    setCampaignArtwork(campaignId, visible) {
      if (!isSafeIdentifier(campaignId) || typeof visible !== "boolean") return;
      update({ ...state, artworkByCampaign: { ...state.artworkByCampaign, [campaignId]: visible } });
    },
    setTurnArtwork(campaignId, turnId, visible) {
      if (!isSafeIdentifier(campaignId) || !isSafeIdentifier(turnId) || (visible !== null && typeof visible !== "boolean")) return;
      const key = turnKey(campaignId, turnId);
      const artworkByTurn = { ...state.artworkByTurn };
      if (visible === null) delete artworkByTurn[key];
      else artworkByTurn[key] = visible;
      update({ ...state, artworkByTurn });
    },
    artworkVisible(campaignId, turnId) {
      if (!isSafeIdentifier(campaignId) || !isSafeIdentifier(turnId)) return true;
      const key = turnKey(campaignId, turnId);
      if (hasOwn(state.artworkByTurn, key)) return state.artworkByTurn[key];
      if (hasOwn(state.artworkByCampaign, campaignId)) return state.artworkByCampaign[campaignId];
      return true;
    },
    subscribe(listener) {
      if (disposed) return () => undefined;
      listeners.add(listener);
      listener(snapshot(state));
      return () => listeners.delete(listener);
    },
    reload() {
      if (disposed) return;
      publish(readPreferences(storage));
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      listeners.clear();
    }
  };
}
