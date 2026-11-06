import { DEFAULT_RECENT_WINDOW_TURNS, matchesLocalCharacterFilter } from "@infinite-quest/client-core";
import type { CharacterFilter, CastDetail, CastCharacter, CharactersWorkspaceStatus } from "@infinite-quest/contracts";

export interface CharactersWorkspaceState<Draft = unknown> {
  campaignId: string | null;
  status: CharactersWorkspaceStatus | null;
  characters: CastCharacter[];
  /** Accepted-turn window the server used for the Recent filter. */
  recentWindow: number;
  /** Server-reported review/conflict markers by character ID; absent on older servers. */
  attention: Record<string, { review: boolean; conflict: boolean }>;
  selectedId: string | null;
  detail: CastDetail | null;
  draft: Draft | null;
  draftBaseDetail: CastDetail | null;
  changedWhileEditing: boolean;
  error: unknown;
}

export interface CharactersWorkspaceSessionOptions<Draft> {
  api: {
    workspaceStatus(campaignId: string, signal?: AbortSignal): Promise<CharactersWorkspaceStatus>;
    list(campaignId: string, input: { query: string; filter: CharacterFilter; cursor?: string; expectedRevision?: number; expectedTurnNumber?: number; expectedTimelineRevision?: number }, signal?: AbortSignal): Promise<{ revision: number; boundary: { turnNumber: number; timelineRevision: number }; characters: CastCharacter[]; nextCursor: string | null; recentWindow?: number | undefined; attention?: { characterId: string; review: boolean; conflict: boolean }[] | undefined }>;
    detail(campaignId: string, id: string, signal?: AbortSignal): Promise<CastDetail>;
  };
  schedule?: { set(callback: () => void, delay: number): unknown; clear(handle: unknown): void; visible(): boolean; onVisibilityChange(callback: () => void): () => void };
  onChange(state: CharactersWorkspaceState<Draft>): void;
}

export function createCharactersWorkspaceSession<Draft = unknown>({ api, schedule, onChange }: CharactersWorkspaceSessionOptions<Draft>) {
  const clock = schedule ?? {
    set: (callback: () => void, delay: number) => setTimeout(callback, delay),
    clear: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    visible: () => typeof document === "undefined" || !document.hidden,
    onVisibilityChange: (callback: () => void) => { if (typeof document === "undefined") return () => {}; document.addEventListener("visibilitychange", callback); return () => document.removeEventListener("visibilitychange", callback); }
  };
  let state: CharactersWorkspaceState<Draft> = { campaignId: null, status: null, characters: [], recentWindow: DEFAULT_RECENT_WINDOW_TURNS, attention: {}, selectedId: null, detail: null, draft: null, draftBaseDetail: null, changedWhileEditing: false, error: null };
  let epoch = 0, timer: unknown, controller: AbortController | undefined, running = false, failures = 0;
  let query = "", filter: CharacterFilter = "all";
  const emit = () => onChange({ ...state });
  const stop = () => { if (timer !== undefined) clock.clear(timer); timer = undefined; controller?.abort(); controller = undefined; };
  const arm = () => { if (timer !== undefined) clock.clear(timer); timer = undefined; if (state.campaignId && clock.visible()) timer = clock.set(() => { timer = undefined; void refresh(); }, failures ? Math.min(30, 5 * 2 ** failures) * 1000 : 5000); };
  async function refresh(force = false) {
    if (!state.campaignId || running || !clock.visible()) return;
    const campaignId = state.campaignId, currentEpoch = epoch, abort = new AbortController(); controller = abort; running = true;
    try {
      let status = await api.workspaceStatus(campaignId, abort.signal);
      const recovering = state.error !== null;
      if (epoch !== currentEpoch) return;
      if (force || !state.status || state.status.revision !== status.revision || state.status.changeToken !== status.changeToken || JSON.stringify(state.status.boundary) !== JSON.stringify(status.boundary) || JSON.stringify(state.status.counts) !== JSON.stringify(status.counts)) {
        const sameBoundary = (page: { revision: number; boundary: { turnNumber: number; timelineRevision: number } }) =>
          page.revision === status.revision && page.boundary.turnNumber === status.boundary.turnNumber && page.boundary.timelineRevision === status.boundary.timelineRevision;
        let characters: CastCharacter[] = [], recentWindow = DEFAULT_RECENT_WINDOW_TURNS, attention: CharactersWorkspaceState["attention"] = {};
        // A revision change mid-pagination restarts once with fresh status rather than mixing pages.
        for (let attempt = 0; ; attempt++) {
          let cursor: string | undefined, consistent = true; characters = []; attention = {};
          do {
            const page = await api.list(campaignId, { query, filter: status.legacyServer ? "all" : filter, ...(cursor ? status.legacyServer ? { cursor } : { cursor, expectedRevision: status.revision, expectedTurnNumber: status.boundary.turnNumber, expectedTimelineRevision: status.boundary.timelineRevision } : {}) }, abort.signal);
            if (!sameBoundary(page)) { consistent = false; break; }
            recentWindow = page.recentWindow ?? DEFAULT_RECENT_WINDOW_TURNS;
            for (const item of page.attention ?? []) attention[item.characterId] = { review: item.review, conflict: item.conflict };
            characters.push(...page.characters); cursor = page.nextCursor ?? undefined;
          } while (cursor);
          if (consistent) break;
          if (attempt >= 1) throw new Error("Character list changed; refresh to retry.");
          status = await api.workspaceStatus(campaignId, abort.signal);
          if (epoch !== currentEpoch) return;
        }
        const detail = state.selectedId ? await api.detail(campaignId, state.selectedId, abort.signal) : null;
        if (epoch !== currentEpoch) return;
        if (detail && state.draft !== null && state.detail && (detail.character.revision !== state.detail.character.revision || detail.revision !== state.detail.revision)) state.changedWhileEditing = true;
        state.characters = status.legacyServer ? characters.filter(person => matchesLocalCharacterFilter(person, filter, status.boundary.turnNumber, recentWindow)) : characters;
        state.recentWindow = recentWindow; state.attention = attention; state.detail = detail;
      }
      const statusChanged = JSON.stringify(state.status) !== JSON.stringify(status);
      state.status = status; state.error = null; failures = 0;
      if (force || statusChanged || recovering) emit();
    } catch (error) { if (epoch === currentEpoch && !abort.signal.aborted) { state.error = error; failures++; emit(); } }
    finally { if (epoch === currentEpoch) { running = false; controller = undefined; arm(); } }
  }
  const visibilityOff = clock.onVisibilityChange(() => { if (!clock.visible()) { stop(); epoch++; running = false; } else void refresh(true); });
  return {
    open(campaignId: string) { stop(); epoch++; running = false; failures = 0; state = { campaignId, status: null, characters: [], recentWindow: DEFAULT_RECENT_WINDOW_TURNS, attention: {}, selectedId: null, detail: null, draft: null, draftBaseDetail: null, changedWhileEditing: false, error: null }; emit(); void refresh(true); },
    select(characterId: string | null) { stop(); epoch++; running = false; state.selectedId = characterId; state.detail = null; state.draft = null; state.draftBaseDetail = null; state.changedWhileEditing = false; emit(); void refresh(true); },
    setQuery(value: string, nextFilter: CharacterFilter) { stop(); epoch++; running = false; query = value; filter = nextFilter; void refresh(true); },
    refresh: () => refresh(true),
    setDraft(draft: Draft | null) { if (draft !== null && state.draft === null) state.draftBaseDetail = state.detail; state.draft = draft; if (draft === null) { state.changedWhileEditing = false; state.draftBaseDetail = null; } emit(); },
    close() { stop(); epoch++; running = false; state.campaignId = null; emit(); },
    dispose() { stop(); epoch++; running = false; state.campaignId = null; visibilityOff(); }
  };
}
