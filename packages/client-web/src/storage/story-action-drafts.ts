import { z } from "zod";

const DATABASE_NAME = "infiniteQuest-reader-local-v1";
const DATABASE_VERSION = 1;
const STORE_NAME = "actionDrafts";
const DRAFT_LIMIT = 50;
const NOTICE_LIMIT = 50;
const MAX_TEXT_LENGTH = 12_000;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const DRAFT_PREFIX = "draft:";
const NOTICE_PREFIX = "notice:";

export interface DraftScope {
  readonly userId: string;
  readonly campaignId: string;
}

export interface Draft {
  readonly schemaVersion: 1;
  readonly draftRevision: string;
  readonly text: string;
  readonly inputMode: "action" | "scene";
  readonly baseTurnId: string | null;
  readonly baseTurnNumber: number;
  readonly updatedAt: string;
}

export type WriteResult =
  | { readonly outcome: "saved"; readonly currentRevision: string }
  | { readonly outcome: "conflict"; readonly currentRevision?: string }
  | { readonly outcome: "unavailable" | "quota" | "capacity" | "invalid" };

export type ClearResult =
  | { readonly outcome: "removed" | "absent" | "conflict" | "unavailable" };

export interface DraftDatabaseTransaction {
  entries(): readonly (readonly [string, unknown])[];
  get(key: string): unknown;
  put(key: string, value: unknown): void;
  delete(key: string): void;
}

/** A transaction callback reads and stages all changes atomically. */
export interface DraftDatabasePort {
  transaction<T>(operation: (transaction: DraftDatabaseTransaction) => T): Promise<T>;
}

export interface StoryActionDraftStore {
  read(scope: DraftScope): Promise<Draft | null>;
  write(
    scope: DraftScope,
    draft: Draft,
    options: { readonly expectedRevision: string | null }
  ): Promise<WriteResult>;
  removeIfRevision(scope: DraftScope, expectedRevision: string): Promise<ClearResult>;
  readExpiryNotice(scope: DraftScope): Promise<boolean>;
}

const uuidSchema = z.uuid();
const scopeSchema = z.object({ userId: z.uuid(), campaignId: z.uuid() }).strict();
const draftSchema = z.object({
  schemaVersion: z.literal(1),
  draftRevision: z.uuid(),
  text: z.string().max(MAX_TEXT_LENGTH),
  inputMode: z.enum(["action", "scene"]),
  baseTurnId: z.uuid().nullable(),
  baseTurnNumber: z.number().int().nonnegative(),
  updatedAt: z.iso.datetime()
}).strict();

interface StoredDraft {
  readonly schemaVersion: 1;
  readonly userId: string;
  readonly campaignId: string;
  readonly draft: Draft;
}

interface ExpiryNotice {
  readonly schemaVersion: 1;
  readonly kind: "expiry-notice";
  readonly userId: string;
  readonly campaignId: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}

function draftKey(scope: DraftScope): string {
  return `${DRAFT_PREFIX}${scope.userId}:${scope.campaignId}`;
}

function noticeKey(scope: DraftScope): string {
  return `${NOTICE_PREFIX}${scope.userId}:${scope.campaignId}`;
}

function parseJson(raw: unknown): { kind: "parsed"; value: unknown } | { kind: "corrupt" } {
  if (typeof raw !== "string") return { kind: "corrupt" };
  try {
    return { kind: "parsed", value: JSON.parse(raw) as unknown };
  } catch {
    return { kind: "corrupt" };
  }
}

function isUnknownVersion(value: unknown): boolean {
  return typeof value === "object" && value !== null
    && Number.isSafeInteger((value as { schemaVersion?: unknown }).schemaVersion)
    && (value as { schemaVersion: number }).schemaVersion > 1;
}

function decodeDraft(raw: unknown): { kind: "valid"; record: StoredDraft } | { kind: "unknown" } | { kind: "corrupt" } {
  const json = parseJson(raw);
  if (json.kind === "corrupt") return json;
  if (isUnknownVersion(json.value)) return { kind: "unknown" };
  const value = z.object({
    schemaVersion: z.literal(1),
    userId: z.uuid(),
    campaignId: z.uuid(),
    draft: draftSchema
  }).strict().safeParse(json.value);
  return value.success ? { kind: "valid", record: value.data } : { kind: "corrupt" };
}

function decodeNotice(raw: unknown): { kind: "valid"; notice: ExpiryNotice } | { kind: "unknown" } | { kind: "corrupt" } {
  const json = parseJson(raw);
  if (json.kind === "corrupt") return json;
  if (isUnknownVersion(json.value)) return { kind: "unknown" };
  const value = z.object({
    schemaVersion: z.literal(1),
    kind: z.literal("expiry-notice"),
    userId: z.uuid(),
    campaignId: z.uuid(),
    createdAt: z.iso.datetime(),
    expiresAt: z.iso.datetime()
  }).strict().safeParse(json.value);
  return value.success ? { kind: "valid", notice: value.data } : { kind: "corrupt" };
}

function isExpired(updatedAt: string, nowMs: number): boolean {
  const timestamp = Date.parse(updatedAt);
  return !Number.isFinite(timestamp) || nowMs - timestamp >= RETENTION_MS;
}

function isNoticeExpired(notice: ExpiryNotice, nowMs: number): boolean {
  return Date.parse(notice.expiresAt) <= nowMs;
}

function isQuotaError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "QuotaExceededError"
    || typeof error === "object" && error !== null && (error as { name?: unknown }).name === "QuotaExceededError";
}

function expiryNotice(userId: string, campaignId: string, now: Date): ExpiryNotice {
  return {
    schemaVersion: 1,
    kind: "expiry-notice",
    userId,
    campaignId,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + RETENTION_MS).toISOString()
  };
}

function storeJson(transaction: DraftDatabaseTransaction, key: string, value: unknown): void {
  transaction.put(key, JSON.stringify(value));
}

function pruneExpired(
  transaction: DraftDatabaseTransaction,
  now: Date,
  protectedKey?: string
): void {
  const nowMs = now.getTime();
  const expiredScopes = new Map<string, DraftScope>();
  const notices: Array<{ key: string; notice: ExpiryNotice }> = [];

  for (const [key, raw] of transaction.entries()) {
    if (key.startsWith(DRAFT_PREFIX)) {
      const decoded = decodeDraft(raw);
      if (decoded.kind === "corrupt") {
        transaction.delete(key);
        continue;
      }
      if (decoded.kind === "unknown") continue;
      const record = decoded.record;
      const recordScope = { userId: record.userId, campaignId: record.campaignId };
      if (key !== draftKey(recordScope)) {
        transaction.delete(key);
        continue;
      }
      if (key === protectedKey) continue;
      if (isExpired(record.draft.updatedAt, nowMs)) {
        expiredScopes.set(noticeKey(recordScope), recordScope);
        transaction.delete(key);
      }
      continue;
    }

    if (!key.startsWith(NOTICE_PREFIX)) continue;
    const decoded = decodeNotice(raw);
    if (decoded.kind === "corrupt") {
      transaction.delete(key);
      continue;
    }
    if (decoded.kind === "unknown") continue;
    const notice = decoded.notice;
    const noticeScope = { userId: notice.userId, campaignId: notice.campaignId };
    if (key !== noticeKey(noticeScope) || isNoticeExpired(notice, nowMs)) {
      transaction.delete(key);
      continue;
    }
    notices.push({ key, notice });
  }

  for (const [key, scope] of expiredScopes) {
    const existing = decodeNotice(transaction.get(key));
    if (existing.kind === "valid" && !isNoticeExpired(existing.notice, nowMs)) continue;
    const notice = expiryNotice(scope.userId, scope.campaignId, now);
    transaction.put(key, JSON.stringify(notice));
    notices.push({ key, notice });
  }

  const validNotices = new Map<string, ExpiryNotice>();
  for (const { key, notice } of notices) validNotices.set(key, notice);
  const overflow = [...validNotices.entries()]
    .sort((left, right) => Date.parse(left[1].createdAt) - Date.parse(right[1].createdAt) || left[0].localeCompare(right[0]))
    .slice(0, Math.max(0, validNotices.size - NOTICE_LIMIT));
  for (const [key] of overflow) transaction.delete(key);
}
function validClockDate(now: () => Date): Date | null {
  try {
    const value = now();
    return value instanceof Date && Number.isFinite(value.getTime()) ? value : null;
  } catch {
    return null;
  }
}

export function createStoryActionDraftStore(
  database: DraftDatabasePort,
  now: () => Date,
  idFactory: () => string
): StoryActionDraftStore {
  return {
    async read(scope) {
      const parsedScope = scopeSchema.safeParse(scope);
      const currentTime = validClockDate(now);
      if (!parsedScope.success || currentTime === null) return null;
      const parsed = parsedScope.data;
      try {
        return await database.transaction((transaction) => {
          pruneExpired(transaction, currentTime);
          const key = draftKey(parsed);
          const raw = transaction.get(key);
          const decoded = decodeDraft(raw);
          if (decoded.kind === "corrupt") {
            if (raw !== undefined) transaction.delete(key);
            return null;
          }
          if (decoded.kind === "unknown") return null;
          if (decoded.record.userId !== parsed.userId || decoded.record.campaignId !== parsed.campaignId) return null;
          return decoded.record.draft;
        });
      } catch {
        return null;
      }
    },
    async write(scope, draft, options) {
      const parsedScope = scopeSchema.safeParse(scope);
      const parsedDraft = draftSchema.safeParse(draft);
      const expectedRevision = options?.expectedRevision;
      if (!parsedScope.success || !parsedDraft.success || !(expectedRevision === null || uuidSchema.safeParse(expectedRevision).success)) {
        return { outcome: "invalid" };
      }
      const currentTime = validClockDate(now);
      if (currentTime === null) return { outcome: "invalid" };
      let revision: string;
      try {
        revision = idFactory();
      } catch {
        return { outcome: "invalid" };
      }
      if (!uuidSchema.safeParse(revision).success) return { outcome: "invalid" };
      const parsed = parsedScope.data;
      const targetKey = draftKey(parsed);
      const nextDraft: Draft = {
        ...parsedDraft.data,
        draftRevision: revision,
        updatedAt: currentTime.toISOString()
      };
      const nextRecord: StoredDraft = {
        schemaVersion: 1,
        userId: parsed.userId,
        campaignId: parsed.campaignId,
        draft: nextDraft
      };
      try {
        return await database.transaction((transaction): WriteResult => {
          pruneExpired(transaction, currentTime, targetKey);
          const existingRaw = transaction.get(targetKey);
          const existing = decodeDraft(existingRaw);
          if (existing.kind === "unknown") return { outcome: "conflict" };
          if (existing.kind === "corrupt" && existingRaw !== undefined) transaction.delete(targetKey);
          const current = existing.kind === "valid" ? existing.record.draft : null;
          if ((current?.draftRevision ?? null) !== expectedRevision) {
            return current === null
              ? { outcome: "conflict" }
              : { outcome: "conflict", currentRevision: current.draftRevision };
          }
          if (current !== null && current.draftRevision === revision) {
            return { outcome: "conflict", currentRevision: current.draftRevision };
          }
          if (current === null) {
            const currentDraftCount = transaction.entries().reduce((count, [key, raw]) => {
              if (!key.startsWith(DRAFT_PREFIX)) return count;
              const decoded = decodeDraft(raw);
              return decoded.kind === "unknown" || decoded.kind === "valid" ? count + 1 : count;
            }, 0);
            if (currentDraftCount >= DRAFT_LIMIT) return { outcome: "capacity" };
          }
          storeJson(transaction, targetKey, { ...nextRecord, draft: { ...nextRecord.draft } });
          return { outcome: "saved", currentRevision: revision };
        });
      } catch (error) {
        return { outcome: isQuotaError(error) ? "quota" : "unavailable" };
      }
    },
    async removeIfRevision(scope, expectedRevision) {
      const parsedScope = scopeSchema.safeParse(scope);
      if (!parsedScope.success || !uuidSchema.safeParse(expectedRevision).success) return { outcome: "unavailable" };
      const currentTime = validClockDate(now);
      if (currentTime === null) return { outcome: "unavailable" };
      const parsed = parsedScope.data;
      const key = draftKey(parsed);
      try {
        return await database.transaction((transaction): ClearResult => {
          pruneExpired(transaction, currentTime, key);
          const raw = transaction.get(key);
          if (raw === undefined) return { outcome: "absent" };
          const decoded = decodeDraft(raw);
          if (decoded.kind === "corrupt") {
            transaction.delete(key);
            return { outcome: "absent" };
          }
          if (decoded.kind === "unknown") return { outcome: "conflict" };
          if (decoded.record.userId !== parsed.userId || decoded.record.campaignId !== parsed.campaignId) return { outcome: "conflict" };
          if (decoded.record.draft.draftRevision !== expectedRevision) return { outcome: "conflict" };
          transaction.delete(key);
          return { outcome: "removed" };
        });
      } catch {
        return { outcome: "unavailable" };
      }
    },
    async readExpiryNotice(scope) {
      const parsedScope = scopeSchema.safeParse(scope);
      const currentTime = validClockDate(now);
      if (!parsedScope.success || currentTime === null) return false;
      const parsed = parsedScope.data;
      try {
        return await database.transaction((transaction) => {
          pruneExpired(transaction, currentTime);
          const decoded = decodeNotice(transaction.get(noticeKey(parsed)));
          return decoded.kind === "valid" && decoded.notice.userId === parsed.userId
            && decoded.notice.campaignId === parsed.campaignId && !isNoticeExpired(decoded.notice, currentTime.getTime());
        });
      } catch {
        return false;
      }
    }
  };
}

/** Opens the browser's IndexedDB adapter. No storage fallback is used if it is unavailable. */
export function createIndexedDbDraftDatabase(): DraftDatabasePort {
  let databasePromise: Promise<IDBDatabase> | null = null;
  const openDatabase = (): Promise<IDBDatabase> => {
    if (typeof indexedDB === "undefined") return Promise.reject(new Error("IndexedDB is unavailable."));
    if (databasePromise !== null) return databasePromise;
    databasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME, { keyPath: "storageKey" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("Could not open IndexedDB."));
      request.onblocked = () => reject(new Error("IndexedDB open was blocked."));
    });
    return databasePromise;
  };

  return {
    async transaction<T>(operation: (transaction: DraftDatabaseTransaction) => T): Promise<T> {
      const db = await openDatabase();
      return new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readwrite");
        const objectStore = tx.objectStore(STORE_NAME);
        const getAllRequest = objectStore.getAll() as IDBRequest<Array<{ storageKey: string; value: unknown }>>;
        let result: T;
        let hasResult = false;
        let operationError: unknown;
        let requestHandled = false;

        getAllRequest.onsuccess = () => {
          if (requestHandled) return;
          requestHandled = true;
          const records = new Map<string, unknown>(getAllRequest.result.map((row) => [row.storageKey, row.value]));
          const adapter: DraftDatabaseTransaction = {
            entries: () => [...records.entries()],
            get: (key) => records.get(key),
            put: (key, value) => {
              records.set(key, value);
              objectStore.put({ storageKey: key, value });
            },
            delete: (key) => {
              records.delete(key);
              objectStore.delete(key);
            }
          };
          try {
            result = operation(adapter);
            hasResult = true;
          } catch (error) {
            operationError = error;
            tx.abort();
          }
        };
        getAllRequest.onerror = () => {
          operationError = getAllRequest.error ?? new Error("Could not read IndexedDB draft records.");
          try { tx.abort(); } catch { /* Transaction may already be aborting. */ }
        };
        tx.oncomplete = () => {
          if (hasResult) resolve(result);
          else reject(operationError ?? new Error("IndexedDB transaction completed without a result."));
        };
        tx.onabort = () => reject(operationError ?? tx.error ?? new Error("IndexedDB transaction aborted."));
        tx.onerror = () => { operationError ??= tx.error; };
      });
    }
  };
}
