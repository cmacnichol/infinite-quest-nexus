import { activityPageSchema } from "@infinite-quest/contracts";
import { activityScopeKey, createMemoryActivityCache, emptyActivitySnapshot } from "./cache.js";
import type { ActivityCacheScope, ActivityControllerDependencies, ActivityObservationInput, ActivityViewState } from "./types.js";

export function createActivityController(deps: ActivityControllerDependencies) {
  let epoch = 0;
  let disposed = false;
  let abort = deps.createAbortController();
  let timer = deps.createAbortController();
  let queue = Promise.resolve();
  let refreshPromise: Promise<void> | null = null;
  let failures = 0;
  let dialogOpen = false;
  let jobActive = false;
  let fallback = false;
  let memory = createMemoryActivityCache(deps.clock);
  const listeners = new Set<(state: ActivityViewState) => void>();
  const initial = (): ActivityViewState => ({ scope: null, snapshot: emptyActivitySnapshot(), events: [], observations: [], syncing: false, cached: false, delayed: false, incomplete: false, storageUnavailable: false, unsupported: false, identityRequired: true, gap: null });
  let state = initial();
  const current = (token: number) => !disposed && token === epoch && !abort.signal.aborted;
  const available = () => deps.visibility.current() && deps.connectivity.current();
  const emit = () => {
    const watermark = state.snapshot.hiddenThrough;
    state = { ...state, events: state.snapshot.events.filter(entry => !watermark || BigInt(entry.sequence) > BigInt(watermark.server)), observations: state.snapshot.observations.filter(entry => !watermark || BigInt(entry.sequence) > BigInt(watermark.browser)), incomplete: Boolean(state.snapshot.coverage?.incomplete), storageUnavailable: fallback || Boolean(deps.cache.storageUnavailable?.()) };
    for (const listener of listeners) listener(state);
  };
  const serialize = (token: number, operation: () => Promise<void>) => {
    const run = queue.then(async () => { if (current(token)) await operation(); });
    queue = run.catch(() => {}); return run;
  };
  async function cacheOperation<T>(operation: (cache: typeof deps.cache) => Promise<T>): Promise<T> {
    if (fallback) return operation(memory);
    try { return await operation(deps.cache); }
    catch {
      fallback = true;
      if (state.scope) {
        memory = createMemoryActivityCache(deps.clock, { scope: state.scope, snapshot: state.snapshot });
      }
      return operation(memory);
    }
  }
  async function reread(scope: ActivityCacheScope, token: number) {
    const snapshot = await cacheOperation(cache => cache.read(scope));
    if (!current(token)) return;
    state = { ...state, snapshot, cached: snapshot.lastSuccessfulSync !== null }; emit();
  }
  function invalidate(scope: ActivityCacheScope) {
    try { deps.notifyTabs.publish(activityScopeKey(scope)); } catch { /* Invalidation is optional; polling still reconciles. */ }
  }
  function close() {
    const previousScope = state.scope;
    epoch++; abort.abort(); timer.abort(); abort = deps.createAbortController();
    queue = Promise.resolve(); refreshPromise = null; failures = 0;
    state = initial(); emit();
    if (previousScope) void (fallback ? memory : deps.cache).setActive?.(previousScope, false).catch(() => {});
  }
  async function failure(error: unknown, scope: ActivityCacheScope, token: number) {
    if (!current(token)) return;
    const status = error && typeof error === "object" && "statusCode" in error ? error.statusCode : undefined;
    if (status === 401 || status === 403) { close(); return; }
    if (status === 404) {
      let verified = false;
      try { verified = await deps.verifyAccess(scope, abort.signal); } catch { /* No access proof means no cached display. */ }
      if (!current(token)) return;
      if (!verified) { close(); return; }
      state = { ...state, unsupported: true, delayed: false }; emit(); return;
    }
    failures = Math.min(4, failures + 1);
    state = { ...state, delayed: true }; emit();
  }
  function schedule(immediate = false) {
    timer.abort(); timer = deps.createAbortController();
    if (disposed || !state.scope || state.unsupported || !available()) return;
    const token = epoch; const signal = timer.signal;
    const retry = [5000, 10000, 20000, 30000][Math.max(0, failures - 1)]!;
    const jitter = Math.max(0, Math.min(1, deps.random()));
    const delay = immediate ? 0 : failures ? Math.min(30000, Math.round(retry * (0.9 + jitter * 0.2))) : dialogOpen || jobActive ? 5000 : 30000;
    void deps.scheduler.wait(delay, signal).then(() => {
      if (!signal.aborted && current(token) && available()) void refresh();
    }).catch(() => {});
  }
  async function fetchPages(scope: ActivityCacheScope, token: number, older: boolean) {
    let drainMore = false;
    let readOlder = older;
    state = { ...state, syncing: true, unsupported: false }; emit();
    try {
      // Read within the same serialized lane as local writes and cross-tab invalidations.
      await reread(scope, token);
      for (let count = 0; count < 10 && current(token) && available(); count++) {
        const snapshot = state.snapshot;
        const direction = readOlder ? "before" : snapshot.nextAfter ? "after" : "initial";
        const cursor = readOlder ? snapshot.nextBefore : snapshot.nextAfter;
        if (readOlder && (!snapshot.hasOlder || !cursor)) break;
        const query = { limit: 100, ...(cursor ? direction === "before" ? { before: cursor } : { after: cursor } : {}) };
        const response = await deps.api.list(scope.campaignId, query, abort.signal);
        if (!current(token)) return;
        const page = activityPageSchema.parse(response);
        if (page.events.some(entry => entry.campaignId !== scope.campaignId)) throw new Error("Activity scope mismatch");
        const rollback = BigInt(snapshot.anchorSequence) > BigInt(page.coverage.latestPublishedSequence);
        if (page.coverage.resetRequired || rollback) {
          await cacheOperation(cache => cache.merge(scope, { resetServer: true }));
          if (!current(token)) return;
          state = { ...state, gap: rollback ? "restore" : "retention" };
          await reread(scope, token); invalidate(scope);
          // A bounded restart also covers a reset encountered during an older-page read.
          drainMore = true; readOlder = false; continue;
        }
        await cacheOperation(cache => cache.merge(scope, { page, direction, expectedCursor: cursor, syncedAt: deps.clock.now() }));
        if (!current(token)) return;
        await reread(scope, token); invalidate(scope);
        failures = 0; state = { ...state, delayed: page.coverage.pendingPublication, cached: false, unsupported: false };
        // Initial hasMore describes older history, never an incremental drain.
        drainMore = direction === "after" && page.hasMore;
        if (!drainMore || readOlder) break;
        if (page.nextAfter === cursor) throw new Error("Activity cursor did not advance");
      }
    } catch (error) { await failure(error, scope, token); }
    finally {
      if (current(token)) { state = { ...state, syncing: false }; emit(); schedule(drainMore && failures === 0); }
    }
  }
  function refresh(): Promise<void> {
    if (refreshPromise) return refreshPromise;
    if (!state.scope || !available() || disposed) return Promise.resolve();
    timer.abort();
    const scope = state.scope; const token = epoch;
    const run = serialize(token, () => fetchPages(scope, token, false));
    refreshPromise = run;
    void run.finally(() => { if (refreshPromise === run) refreshPromise = null; });
    return run;
  }
  async function open(scope: ActivityCacheScope) {
    close(); if (disposed) return;
    activityScopeKey(scope);
    const token = epoch;
    if (!deps.connectivity.current()) return;
    let verified = false;
    try { verified = await deps.verifyAccess(scope, abort.signal); } catch { /* Cold offline or unknown identity does not unlock a cache. */ }
    if (!current(token) || !verified) return;
    state = { ...state, scope: { ...scope }, identityRequired: false };
    await serialize(token, async () => { await cacheOperation(async cache => { await cache.setActive?.(scope, true); }); if (current(token)) await reread(scope, token); });
    if (current(token)) await refresh();
  }
  async function write(operation: (scope: ActivityCacheScope) => Promise<void>) {
    if (!state.scope || disposed) return;
    const scope = state.scope; const token = epoch;
    await serialize(token, async () => { await operation(scope); if (current(token)) { await reread(scope, token); invalidate(scope); } });
  }
  const changed = () => { timer.abort(); if (available()) void refresh(); };
  const unsubscribe = [deps.visibility.subscribe(changed), deps.connectivity.subscribe(changed), deps.notifyTabs.subscribe(key => {
    const scope = state.scope; const token = epoch;
    if (scope && activityScopeKey(scope) === key) void serialize(token, () => reread(scope, token)).catch(() => {});
  })];
  return {
    open, close, refresh,
    loadOlder: () => { const scope = state.scope; return scope && available() && !state.unsupported ? serialize(epoch, () => fetchPages(scope, epoch, true)) : Promise.resolve(); },
    recordObservation: (observation: ActivityObservationInput) => write(scope => cacheOperation(cache => cache.merge(scope, { observation }))),
    hidePrevious: () => write(scope => cacheOperation(cache => cache.setHiddenThrough(scope, { server: state.snapshot.events.reduce((high, entry) => BigInt(entry.sequence) > BigInt(high) ? entry.sequence : high, state.snapshot.anchorSequence), browser: state.snapshot.localSequence }))),
    showPrevious: () => write(scope => cacheOperation(cache => cache.setHiddenThrough(scope, null))),
    setDialogOpen(value: boolean) { dialogOpen = value; if (value) void refresh(); else schedule(); },
    setJobActive(value: boolean) { const terminal = jobActive && !value; jobActive = value; if (terminal || value) void refresh(); else schedule(); },
    getState: () => state,
    subscribe(listener: (value: ActivityViewState) => void) { listeners.add(listener); listener(state); return () => listeners.delete(listener); },
    dispose() { if (disposed) return; close(); disposed = true; abort.abort(); for (const remove of unsubscribe) remove(); listeners.clear(); }
  };
}
