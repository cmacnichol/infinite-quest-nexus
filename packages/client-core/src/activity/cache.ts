import { activityCoverageSchema, activityEventSchema, activityPageSchema, activityScopeSchema, activitySequenceSchema, browserActivityObservationSchema } from "@infinite-quest/contracts";
import type { ActivityCache, ActivityCacheScope, ActivityCacheSnapshot, ActivityCacheUpdate, ActivityClock, ActivityViewWatermark } from "./types.js";
export function activityScopeKey(scope: ActivityCacheScope): string {
  activityScopeSchema.parse({ ownerUserId: scope.ownerUserId, campaignId: scope.campaignId });
  if (!/^https?:\/\/[^/?#]+(?:\/[^?#]*)?$/u.test(scope.apiBase) || scope.apiBase.includes("@")) throw new Error("Invalid activity API namespace");
  return JSON.stringify([scope.apiBase.replace(/\/+$/u, ""), scope.ownerUserId, scope.campaignId]);
}
export function emptyActivitySnapshot(now = 0): ActivityCacheSnapshot {
  return { version: 1, events: [], observations: [], coverage: null, nextAfter: null, nextBefore: null, anchorSequence: "0", localSequence: "0", hiddenThrough: null, lastSuccessfulSync: null, hasOlder: false, lastUsed: now };
}
function afterIso(value: string, cutoff: string): boolean {
  const seconds = value.slice(0, 19); const cutoffSeconds = cutoff.slice(0, 19);
  if (seconds !== cutoffSeconds) return seconds > cutoffSeconds;
  return Number(`0.${value.split(".")[1]?.replace("Z", "") ?? "0"}`) > Number(`0.${cutoff.split(".")[1]?.replace("Z", "") ?? "0"}`);
}
const compare = (a: { sequence: string }, b: { sequence: string }) => BigInt(a.sequence) > BigInt(b.sequence) ? -1 : BigInt(a.sequence) < BigInt(b.sequence) ? 1 : 0;
export function validateActivityWatermark(value: ActivityViewWatermark | null): ActivityViewWatermark | null {
  if (value === null) return null;
  if (Object.keys(value).sort().join(",") !== "browser,server") throw new Error("Invalid activity watermark");
  return { server: activitySequenceSchema.parse(value.server), browser: activitySequenceSchema.parse(value.browser) };
}
/** Invalid entries are discarded; invalid metadata drops server coverage rather than inventing continuity. */
export function sanitizeActivitySnapshot(raw: unknown, scope: ActivityCacheScope, clock: ActivityClock): ActivityCacheSnapshot {
  const now = clock.now();
  if (!raw || typeof raw !== "object") return emptyActivitySnapshot(now);
  const value = raw as ActivityCacheSnapshot;
  const cursor = (v: unknown) => v === null || typeof v === "string" && v.length > 0 && v.length <= 512;
  try {
    if (value.version !== 1 || !cursor(value.nextAfter) || !cursor(value.nextBefore) || typeof value.hasOlder !== "boolean" || !Number.isFinite(value.lastUsed) || !(value.lastSuccessfulSync === null || Number.isFinite(value.lastSuccessfulSync))) throw new Error("Invalid metadata");
    const snapshot: ActivityCacheSnapshot = {
      version: 1, events: [], observations: [], coverage: value.coverage === null ? null : activityCoverageSchema.parse(value.coverage), nextAfter: value.nextAfter, nextBefore: value.nextBefore,
      anchorSequence: activitySequenceSchema.parse(value.anchorSequence), localSequence: activitySequenceSchema.parse(value.localSequence), hiddenThrough: validateActivityWatermark(value.hiddenThrough), lastSuccessfulSync: value.lastSuccessfulSync, hasOlder: value.hasOlder, lastUsed: now
    };
    const cutoff = clock.isoAt(now - 7 * 86400000);
    snapshot.events = (Array.isArray(value.events) ? value.events : []).flatMap(entry => { const parsed = activityEventSchema.safeParse(entry); return parsed.success && parsed.data.campaignId === scope.campaignId ? [parsed.data] : []; }).sort(compare).slice(0, 1000);
    snapshot.observations = (Array.isArray(value.observations) ? value.observations : []).flatMap(entry => { const parsed = browserActivityObservationSchema.safeParse(entry); return parsed.success && parsed.data.campaignId === scope.campaignId && afterIso(parsed.data.observedAt, cutoff) ? [parsed.data] : []; }).sort(compare).slice(0, 200);
    // A corrupt event means saved cursor coverage is no longer trustworthy.
    if (snapshot.events.length < Math.min(1000, Array.isArray(value.events) ? value.events.length : 0)) {
      snapshot.nextAfter = null; snapshot.nextBefore = null; snapshot.coverage = null; snapshot.anchorSequence = "0";
    }
    for (const entry of snapshot.observations) if (BigInt(entry.sequence) > BigInt(snapshot.localSequence)) snapshot.localSequence = entry.sequence;
    return snapshot;
  } catch { return emptyActivitySnapshot(now); }
}
export function mergeActivitySnapshot(current: ActivityCacheSnapshot, scope: ActivityCacheScope, update: ActivityCacheUpdate, clock: ActivityClock): ActivityCacheSnapshot {
  const snapshot = sanitizeActivitySnapshot(current, scope, clock);
  if (update.resetServer) Object.assign(snapshot, { events: [], coverage: null, nextAfter: null, nextBefore: null, anchorSequence: "0", hasOlder: false, hiddenThrough: snapshot.hiddenThrough && { ...snapshot.hiddenThrough, server: "0" } });
  const page = update.page ? activityPageSchema.parse(update.page) : undefined;
  const entries = [...(update.events ?? []), ...(page?.events ?? [])].map(entry => activityEventSchema.parse(entry));
  if (entries.some(entry => entry.campaignId !== scope.campaignId)) throw new Error("Activity scope mismatch");
  if (page && update.expectedCursor !== undefined && update.expectedCursor !== (update.direction === "before" ? snapshot.nextBefore : snapshot.nextAfter)) return snapshot;
  const events = new Map(snapshot.events.map(entry => [entry.eventId, entry]));
  for (const entry of entries) if (!events.has(entry.eventId)) events.set(entry.eventId, entry);
  const ordered = [...events.values()].sort(compare);
  snapshot.events = update.direction === "before" ? ordered.slice(-1000) : ordered.slice(0, 1000);
  if (update.observation && !snapshot.observations.some(entry => entry.observationId === update.observation!.observationId)) {
    const sequence = (BigInt(snapshot.localSequence) + 1n).toString();
    const observation = browserActivityObservationSchema.parse({ ...update.observation, sequence });
    if (observation.campaignId !== scope.campaignId) throw new Error("Activity scope mismatch");
    snapshot.localSequence = sequence;
    if (afterIso(observation.observedAt, clock.isoAt(clock.now() - 7 * 86400000))) snapshot.observations = [observation, ...snapshot.observations].slice(0, 200);
  }
  if (page) {
    snapshot.coverage = snapshot.coverage && BigInt(snapshot.coverage.latestPublishedSequence) > BigInt(page.coverage.latestPublishedSequence) ? snapshot.coverage : page.coverage; snapshot.lastSuccessfulSync = update.syncedAt ?? clock.now();
    if (update.direction !== "before") {
      snapshot.nextAfter = page.nextAfter;
      snapshot.anchorSequence = page.events.length ? page.events.reduce((high, entry) => BigInt(entry.sequence) > BigInt(high) ? entry.sequence : high, snapshot.anchorSequence) : snapshot.nextAfter === current.nextAfter ? snapshot.anchorSequence : page.coverage.latestPublishedSequence;
    }
    if (update.direction !== "after") { snapshot.nextBefore = page.nextBefore; snapshot.hasOlder = page.hasMore; }
    if (ordered.length > 1000 && update.direction !== "before" && page.nextBefore) {
      // Reuse a server-issued anchor; rereading overlapping pages is safe, skipping evicted history is not.
      snapshot.nextBefore = page.nextBefore; snapshot.hasOlder = true;
    }
  }
  return snapshot;
}
export function createMemoryActivityCache(clock: ActivityClock, seed?: { scope: ActivityCacheScope; snapshot: ActivityCacheSnapshot }): ActivityCache {
  const scopes = new Map<string, ActivityCacheSnapshot>();
  if (seed) scopes.set(activityScopeKey(seed.scope), sanitizeActivitySnapshot(seed.snapshot, seed.scope, clock));
  const active = new Set<string>();
  const read = (scope: ActivityCacheScope) => sanitizeActivitySnapshot(scopes.get(activityScopeKey(scope)), scope, clock);
  const save = (scope: ActivityCacheScope, snapshot: ActivityCacheSnapshot) => {
    const key = activityScopeKey(scope); scopes.delete(key); scopes.set(key, snapshot);
    while (scopes.size > 10) { const victim = [...scopes.keys()].find(candidate => !active.has(candidate)); if (!victim) { scopes.delete(key); break; } scopes.delete(victim); }
  };
  return {
    async setActive(scope, value) { const key = activityScopeKey(scope); if (value) active.add(key); else active.delete(key); },
    async read(scope) { const snapshot = read(scope); save(scope, snapshot); return snapshot; },
    async merge(scope, update) { save(scope, mergeActivitySnapshot(read(scope), scope, update, clock)); },
    async clearScope(scope) { scopes.delete(activityScopeKey(scope)); },
    async setHiddenThrough(scope, watermark) { save(scope, { ...read(scope), hiddenThrough: validateActivityWatermark(watermark) }); }
  };
}
