import { activityScopeKey, emptyActivitySnapshot, mergeActivitySnapshot, sanitizeActivitySnapshot, validateActivityWatermark } from "@infinite-quest/client-core";
import type { ActivityCache, ActivityCacheScope, ActivityCacheSnapshot, ActivityCacheUpdate, ActivityClock, ActivityViewWatermark } from "@infinite-quest/client-core";

type StoredEntry = { scopeKey: string; id: string; value: unknown };
type StoredScope = { scopeKey: string; value: ActivityCacheSnapshot; leases?: Record<string, number> };
export interface IndexedDbActivityCacheOptions {
  indexedDB?: IDBFactory | null;
  databaseName?: string;
  clock?: ActivityClock;
}
/** Native v1 stores. Every read/merge/prune runs in one transaction across all stores. */
export function createIndexedDbActivityCache(options: IndexedDbActivityCacheOptions = {}): ActivityCache {
  let factory: IDBFactory | null;
  try { factory = options.indexedDB === undefined ? globalThis.indexedDB : options.indexedDB; } catch { factory = null; }
  const clock = options.clock ?? { now: () => Date.now(), isoAt: (value: number) => new Date(value).toISOString() };
  const name = options.databaseName ?? "infinite-quest-activity-v1";
  let database: Promise<IDBDatabase> | null = null;
  let unavailable = false;
  let closed = false;
  const memory = new Map<string, ActivityCacheSnapshot>();
  // A lease token is local bookkeeping, not a user identity or authorization token.
  const instanceId = `${Date.now()}:${Math.random()}`;
  const active = new Set<string>();
  const remember = (key: string, snapshot: ActivityCacheSnapshot) => {
    memory.delete(key); memory.set(key, snapshot);
    while (memory.size > 10) memory.delete(memory.keys().next().value!);
  };
  function open(): Promise<IDBDatabase> {
    if (database) return database;
    database = new Promise((resolve, reject) => {
      if (!factory || closed) { reject(new Error("Activity storage unavailable")); return; }
      const request = factory.open(name, 1);
      let rejected = false;
      const fail = () => { rejected = true; reject(new Error("Activity storage unavailable")); };
      request.onerror = fail;
      request.onblocked = fail;
      request.onupgradeneeded = () => {
        const db = request.result;
        for (const storeName of ["events", "observations"]) {
          const store = db.createObjectStore(storeName, { keyPath: ["scopeKey", "id"] });
          store.createIndex("scope", "scopeKey");
        }
        db.createObjectStore("scopes", { keyPath: "scopeKey" });
      };
      request.onsuccess = () => {
        const db = request.result;
        if (rejected || closed) { db.close(); return; }
        db.onversionchange = () => { db.close(); unavailable = true; database = null; };
        db.onclose = () => { unavailable = true; database = null; };
        resolve(db);
      };
    });
    return database;
  }
  type Mutation = { update: ActivityCacheUpdate } | { watermark: ActivityViewWatermark | null } | { clear: true } | null;
  async function transact(scope: ActivityCacheScope, mutation: Mutation): Promise<ActivityCacheSnapshot> {
    const key = activityScopeKey(scope);
    const transform = (raw: unknown) => {
      const snapshot = sanitizeActivitySnapshot(raw, scope, clock);
      if (mutation && "clear" in mutation) return emptyActivitySnapshot(clock.now());
      if (mutation && "update" in mutation) return mergeActivitySnapshot(snapshot, scope, mutation.update, clock);
      if (mutation && "watermark" in mutation) snapshot.hiddenThrough = validateActivityWatermark(mutation.watermark);
      return snapshot;
    };
    // Validate input before catching storage errors: malformed payloads are not storage failures.
    if (mutation && "update" in mutation) { const { expectedCursor: _cursor, ...update } = mutation.update; mergeActivitySnapshot(emptyActivitySnapshot(), scope, update, clock); }
    if (mutation && "watermark" in mutation) validateActivityWatermark(mutation.watermark);
    if (!unavailable) {
      try {
        const db = await open();
        const snapshot = await new Promise<ActivityCacheSnapshot>((resolve, reject) => {
          const tx = db.transaction(["events", "observations", "scopes"], "readwrite");
          const eventStore = tx.objectStore("events"); const observationStore = tx.objectStore("observations"); const scopeStore = tx.objectStore("scopes");
          const eventRead = eventStore.index("scope").getAll(key);
          const observationRead = observationStore.index("scope").getAll(key);
          const scopeRead = scopeStore.getAll();
          let pending = 3; let result: ActivityCacheSnapshot;
          tx.onabort = () => reject(new Error("Activity cache transaction aborted"));
          tx.onerror = () => { /* onabort reports failure; no cursor is acknowledged early. */ };
          tx.oncomplete = () => resolve(result!);
          const ready = () => {
            if (--pending) return;
            try {
              const scopes = scopeRead.result as StoredScope[];
              const events = eventRead.result as StoredEntry[];
              const observations = observationRead.result as StoredEntry[];
              const storedScope = scopes.find(entry => entry.scopeKey === key);
              const metadata = storedScope?.value;
              const leases = Object.fromEntries(Object.entries(storedScope?.leases ?? {}).filter(([id, until]) => id !== instanceId && Number.isFinite(until) && until > clock.now()));
              if (active.has(key)) leases[instanceId] = clock.now() + 65000;
              result = transform(metadata && { ...metadata, events: events.map(entry => entry.value), observations: observations.map(entry => entry.value) });
              const syncEntries = (store: IDBObjectStore, previous: StoredEntry[], next: {id: string; value: unknown}[]) => {
                const old = new Map(previous.map(entry => [entry.id, entry.value]));
                const keep = new Set(next.map(entry => entry.id));
                for (const entry of previous) if (!keep.has(entry.id)) store.delete([key, entry.id]);
                for (const entry of next) if (!old.has(entry.id) || JSON.stringify(old.get(entry.id)) !== JSON.stringify(entry.value)) store.put({ scopeKey: key, ...entry });
              };
              syncEntries(eventStore, events, result.events.map(value => ({ id: value.eventId, value })));
              syncEntries(observationStore, observations, result.observations.map(value => ({ id: value.observationId, value })));
              if (mutation && "clear" in mutation) scopeStore.delete(key);
              else {
                scopeStore.put({ scopeKey: key, leases, value: { ...result, events: [], observations: [] } });
              }
              const others = scopes.filter(entry => entry.scopeKey !== key).sort((a,b) => (b.value?.lastUsed ?? 0) - (a.value?.lastUsed ?? 0));
              const excess = Math.max(0, others.length - (mutation && "clear" in mutation ? 10 : 9));
              const inactive = others.filter(entry => !Object.values(entry.leases ?? {}).some(until => Number.isFinite(until) && until > clock.now())).reverse();
              // All ten scopes active: keep their persisted data and use memory for this tab.
              if (inactive.length < excess) { tx.abort(); return; }
              for (const old of inactive.slice(0, excess)) {
                scopeStore.delete(old.scopeKey);
                for (const store of [eventStore, observationStore]) {
                  const cursor = store.index("scope").openKeyCursor(IDBKeyRange.only(old.scopeKey));
                  cursor.onsuccess = () => { if (cursor.result) { store.delete(cursor.result.primaryKey); cursor.result.continue(); } };
                }
              }
            } catch { tx.abort(); }
          };
          eventRead.onsuccess = ready; observationRead.onsuccess = ready; scopeRead.onsuccess = ready;
        });
        remember(key, snapshot); return snapshot;
      } catch { unavailable = true; }
    }
    const snapshot = transform(memory.get(key)); remember(key, snapshot); return snapshot;
  }
  return {
    async setActive(scope, value) { const key = activityScopeKey(scope); if (value) active.add(key); else active.delete(key); await transact(scope, null); },
    read: scope => transact(scope, null),
    async merge(scope, update) { await transact(scope, { update }); },
    async clearScope(scope) { await transact(scope, { clear: true }); memory.delete(activityScopeKey(scope)); },
    async setHiddenThrough(scope, watermark) { await transact(scope, { watermark }); },
    storageUnavailable: () => unavailable,
    dispose() { closed = true; if (database) void database.then(db => db.close()).catch(() => {}); }
  };
}
