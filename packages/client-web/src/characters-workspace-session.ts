import { NexusApiError, DEFAULT_RECENT_WINDOW_TURNS, matchesLocalCharacterFilter } from "@infinite-quest/client-core";
import type { CharacterFilter, CastDetail, CastCharacter, CharactersWorkspaceStatus } from "@infinite-quest/contracts";

type WorkspaceDetail = import("zod").infer<typeof import("./campaign-cast-api.js").castDetailResponseSchema>;

export interface CharactersWorkspaceState<Draft = unknown> {
  campaignId: string | null;
  status: CharactersWorkspaceStatus | null;
  characters: CastCharacter[];
  listCapabilities: { castPresets?: boolean | undefined; castLifecycle?: boolean | undefined } | null;
  /** Accepted-turn window the server used for the Recent filter. */
  recentWindow: number;
  /** Server-reported review/conflict markers by character ID; absent on older servers. */
  attention: Record<string, { review: boolean; conflict: boolean; reviewCount?: number | undefined; conflictCount?: number | undefined }>;
  selectedId: string | null;
  detail: WorkspaceDetail | null;
  draft: Draft | null;
  draftBaseDetail: CastDetail | null;
  changedWhileEditing: boolean;
  error: unknown;
}

export interface CharactersWorkspaceSessionOptions<Draft> {
  api: {
    workspaceStatus(campaignId: string, signal?: AbortSignal): Promise<CharactersWorkspaceStatus>;
    list(campaignId: string, input: { query: string; filter: CharacterFilter; cursor?: string; expectedRevision?: number; expectedTurnNumber?: number; expectedTimelineRevision?: number }, signal?: AbortSignal): Promise<{ revision: number; boundary: { turnNumber: number; timelineRevision: number }; characters: CastCharacter[]; nextCursor: string | null; capabilities?: { castPresets?: boolean | undefined; castLifecycle?: boolean | undefined }; recentWindow?: number | undefined; attention?: { characterId: string; review: boolean; conflict: boolean; reviewCount?: number | undefined; conflictCount?: number | undefined }[] | undefined }>;
    detail(campaignId: string, id: string, signal?: AbortSignal): Promise<WorkspaceDetail>;
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
  let state: CharactersWorkspaceState<Draft> = { campaignId: null, status: null, characters: [], listCapabilities: null, recentWindow: DEFAULT_RECENT_WINDOW_TURNS, attention: {}, selectedId: null, detail: null, draft: null, draftBaseDetail: null, changedWhileEditing: false, error: null };
  let epoch = 0, timer: unknown, controller: AbortController | undefined, running = false, failures = 0;
  let activeRefresh: Promise<void> | undefined;
  let query = "", filter: CharacterFilter = "all";
  const emit = () => onChange({ ...state });
  const stop = () => { if (timer !== undefined) clock.clear(timer); timer = undefined; controller?.abort(); controller = undefined; };
  const arm = () => { if (timer !== undefined) clock.clear(timer); timer = undefined; if (state.campaignId && clock.visible()) timer = clock.set(() => { timer = undefined; void refresh(); }, failures ? Math.min(30, 5 * 2 ** failures) * 1000 : 5000); };
  async function refresh(force = false) {
    if (!state.campaignId || running || !clock.visible()) return false;
    const campaignId = state.campaignId, currentEpoch = epoch, abort = new AbortController(); controller = abort; running = true;
    let complete!: () => void; const pending = new Promise<void>(resolve => { complete = resolve; }); activeRefresh = pending;
    try {
      let status = await api.workspaceStatus(campaignId, abort.signal);
      const recovering = state.error !== null;
      if (epoch !== currentEpoch || !clock.visible()) return false;
      if (force || !state.status || state.status.revision !== status.revision || state.status.changeToken !== status.changeToken || JSON.stringify(state.status.boundary) !== JSON.stringify(status.boundary) || JSON.stringify(state.status.counts) !== JSON.stringify(status.counts)) {
        const sameBoundary = (page: { revision: number; boundary: { turnNumber: number; timelineRevision: number } }) =>
          page.revision === status.revision && page.boundary.turnNumber === status.boundary.turnNumber && page.boundary.timelineRevision === status.boundary.timelineRevision;
        let listCapabilities: CharactersWorkspaceState["listCapabilities"] = null;
        let characters: CastCharacter[] = [], recentWindow = DEFAULT_RECENT_WINDOW_TURNS, attention: CharactersWorkspaceState["attention"] = {};
        // A revision change mid-pagination restarts once with fresh status rather than mixing pages.
        for (let attempt = 0; ; attempt++) {
          let cursor: string | undefined, consistent = true; characters = []; attention = {};
          do {
            let page: Awaited<ReturnType<typeof api.list>>;
            try {
              page = await api.list(campaignId, { query, filter: status.legacyServer ? "all" : filter, ...(cursor ? status.legacyServer ? { cursor } : { cursor, expectedRevision: status.revision, expectedTurnNumber: status.boundary.turnNumber, expectedTimelineRevision: status.boundary.timelineRevision } : {}) }, abort.signal);
            } catch (error) {
              if (!(error instanceof NexusApiError) || error.domainCode !== "cast_revision_conflict") throw error;
              consistent = false; break;
            }
            if (!sameBoundary(page)) { consistent = false; break; }
            listCapabilities = page.capabilities ?? null;
            recentWindow = page.recentWindow ?? DEFAULT_RECENT_WINDOW_TURNS;
            for (const item of page.attention ?? []) attention[item.characterId] = { review: item.review, conflict: item.conflict, reviewCount: item.reviewCount, conflictCount: item.conflictCount };
            characters.push(...page.characters); cursor = page.nextCursor ?? undefined;
          } while (cursor);
          if (consistent) break;
          if (attempt >= 1) throw new Error("Character list changed; refresh to retry.");
          status = await api.workspaceStatus(campaignId, abort.signal);
          if (epoch !== currentEpoch || !clock.visible()) return false;
        }
        const detail = state.selectedId ? await api.detail(campaignId, state.selectedId, abort.signal) : null;
        if (epoch !== currentEpoch || !clock.visible()) return false;
        if (detail && state.draft !== null && state.detail && (detail.character.revision !== state.detail.character.revision || detail.revision !== state.detail.revision)) state.changedWhileEditing = true;
        state.characters = status.legacyServer ? characters.filter(person => matchesLocalCharacterFilter(person, filter, status.boundary.turnNumber, recentWindow)) : characters;
        state.listCapabilities = listCapabilities; state.recentWindow = recentWindow; state.attention = attention; state.detail = detail;
      }
      const statusChanged = JSON.stringify(state.status) !== JSON.stringify(status);
      state.status = status; state.error = null; failures = 0;
      if (force || statusChanged || recovering) emit();
      return true;
    } catch (error) { if (epoch === currentEpoch && !abort.signal.aborted) { state.error = error; failures++; emit(); } return false; }
    finally { if (epoch === currentEpoch) { running = false; controller = undefined; arm(); } if (activeRefresh === pending) activeRefresh = undefined; complete(); }
  }
  const visibilityOff = clock.onVisibilityChange(() => { if (!clock.visible()) { stop(); epoch++; running = false; } else void refresh(true); });
  return {
    open(campaignId: string) { stop(); epoch++; running = false; failures = 0; state = { campaignId, status: null, characters: [], listCapabilities: null, recentWindow: DEFAULT_RECENT_WINDOW_TURNS, attention: {}, selectedId: null, detail: null, draft: null, draftBaseDetail: null, changedWhileEditing: false, error: null }; emit(); void refresh(true); },
    select(characterId: string | null) { stop(); epoch++; running = false; state.selectedId = characterId; state.detail = null; state.draft = null; state.draftBaseDetail = null; state.changedWhileEditing = false; emit(); void refresh(true); },
    setQuery(value: string, nextFilter: CharacterFilter) { stop(); epoch++; running = false; query = value; filter = nextFilter; void refresh(true); },
    async refresh() { const requestedEpoch = epoch; while (running && activeRefresh && epoch === requestedEpoch) await activeRefresh; return epoch === requestedEpoch ? await refresh(true) : false; },
    setDraft(draft: Draft | null) { if (draft !== null && state.draft === null) state.draftBaseDetail = state.detail; state.draft = draft; if (draft === null) { state.changedWhileEditing = false; state.draftBaseDetail = null; } emit(); },
    close() { stop(); epoch++; running = false; state.campaignId = null; emit(); },
    dispose() { stop(); epoch++; running = false; state.campaignId = null; visibilityOff(); }
  };
}
