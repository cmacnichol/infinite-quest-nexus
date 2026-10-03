import type { ActivityEvent, ActivityPage, ActivityPageQuery, ActivityScope, BrowserActivityObservation } from "@infinite-quest/contracts";
import type { AbortSignalLike, Clock, DelayScheduler } from "../ports.js";
export type ActivityCacheScope = ActivityScope & { apiBase: string };
export type ActivityObservationInput = Omit<BrowserActivityObservation, "sequence">;
export type ActivityViewWatermark = { server: string; browser: string };
export interface ActivityClock extends Clock { isoAt(milliseconds: number): string }
export interface ActivityCacheSnapshot {
  version: 1;
  events: ActivityEvent[];
  observations: BrowserActivityObservation[];
  coverage: ActivityPage["coverage"] | null;
  nextAfter: string | null;
  nextBefore: string | null;
  anchorSequence: string;
  localSequence: string;
  hiddenThrough: ActivityViewWatermark | null;
  lastSuccessfulSync: number | null;
  hasOlder: boolean;
  lastUsed: number;
}
export interface ActivityCacheUpdate {
  events?: ActivityEvent[];
  observation?: ActivityObservationInput;
  page?: ActivityPage;
  direction?: "initial" | "after" | "before";
  expectedCursor?: string | null;
  syncedAt?: number;
  resetServer?: boolean;
}
export interface ActivityCache {
  read(scope: ActivityCacheScope): Promise<ActivityCacheSnapshot>;
  merge(scope: ActivityCacheScope, update: ActivityCacheUpdate): Promise<void>;
  clearScope(scope: ActivityCacheScope): Promise<void>;
  setHiddenThrough(scope: ActivityCacheScope, watermark: ActivityViewWatermark | null): Promise<void>;
  /** Adapter status is advisory; failures never become Story failures. */
  storageUnavailable?(): boolean;
  setActive?(scope: ActivityCacheScope, active: boolean): Promise<void>;
  dispose?(): void;
}
export interface ActivityBooleanSource { current(): boolean; subscribe(listener: () => void): () => void }
export interface ActivityInvalidations { publish(scopeKey: string): void; subscribe(listener: (scopeKey: string) => void): () => void }
export interface ActivityAbortController { signal: AbortSignalLike; abort(): void }
export interface ActivityControllerDependencies {
  api: { list(campaignId: string, query: ActivityPageQuery, signal?: AbortSignalLike): Promise<ActivityPage> };
  cache: ActivityCache;
  /** Verify current server session owner AND campaign access, not remembered identity. */
  verifyAccess(scope: ActivityCacheScope, signal: AbortSignalLike): Promise<boolean>;
  clock: ActivityClock;
  scheduler: DelayScheduler;
  createAbortController(): ActivityAbortController;
  visibility: ActivityBooleanSource;
  connectivity: ActivityBooleanSource;
  notifyTabs: ActivityInvalidations;
  random(): number;
}
export interface ActivityViewState {
  scope: ActivityCacheScope | null;
  snapshot: ActivityCacheSnapshot;
  events: ActivityEvent[];
  observations: BrowserActivityObservation[];
  syncing: boolean;
  cached: boolean;
  delayed: boolean;
  incomplete: boolean;
  storageUnavailable: boolean;
  unsupported: boolean;
  identityRequired: boolean;
  gap: "retention" | "restore" | null;
}
