import { z } from "zod";

export interface ReaderPositionScope {
  readonly userId: string;
  readonly campaignId: string;
}

export interface ReaderPosition {
  readonly schemaVersion: 1;
  readonly turnId: string;
  readonly turnNumber: number;
  readonly offsetRatio: number;
  readonly updatedAt: string;
}

export interface ReaderPositionInput {
  readonly turnId: string;
  readonly turnNumber: number;
  readonly offsetRatio: number;
}

export type ReaderPositionWriteResult = "saved" | "invalid" | "unavailable";

export interface ReaderPositionDatabasePort {
  read(key: string): Promise<unknown>;
  write(key: string, value: unknown): Promise<void>;
}

export interface ReaderPositionStore {
  read(scope: ReaderPositionScope): Promise<ReaderPosition | null>;
  write(scope: ReaderPositionScope, position: ReaderPositionInput): Promise<ReaderPositionWriteResult>;
}

const scopeSchema = z.object({ userId: z.uuid(), campaignId: z.uuid() }).strict();
const positionSchema = z.object({
  schemaVersion: z.literal(1),
  turnId: z.uuid(),
  turnNumber: z.number().int().positive(),
  offsetRatio: z.number().finite().min(0).max(1),
  updatedAt: z.iso.datetime()
}).strict();
const inputSchema = z.object({
  turnId: z.uuid(),
  turnNumber: z.number().int().positive(),
  offsetRatio: z.number().finite()
}).strict();
const envelopeSchema = z.object({
  schemaVersion: z.literal(1),
  userId: z.uuid(),
  campaignId: z.uuid(),
  position: positionSchema
}).strict();

function positionKey(scope: ReaderPositionScope): string {
  return `${scope.userId}:${scope.campaignId}`;
}

function validDate(now: () => Date): Date | null {
  try {
    const value = now();
    return value instanceof Date && Number.isFinite(value.getTime()) ? value : null;
  } catch {
    return null;
  }
}

export function createReaderPositionStore(
  database: ReaderPositionDatabasePort,
  now: () => Date = () => new Date()
): ReaderPositionStore {
  return {
    async read(scope) {
      const parsedScope = scopeSchema.safeParse(scope);
      if (!parsedScope.success) return null;
      try {
        const envelope = envelopeSchema.safeParse(await database.read(positionKey(parsedScope.data)));
        if (!envelope.success
          || envelope.data.userId !== parsedScope.data.userId
          || envelope.data.campaignId !== parsedScope.data.campaignId) return null;
        return envelope.data.position;
      } catch {
        return null;
      }
    },
    async write(scope, input) {
      const parsedScope = scopeSchema.safeParse(scope);
      const parsedInput = inputSchema.safeParse(input);
      const currentTime = validDate(now);
      if (!parsedScope.success || !parsedInput.success || currentTime === null) return "invalid";
      const position = positionSchema.parse({
        schemaVersion: 1,
        ...parsedInput.data,
        offsetRatio: Math.max(0, Math.min(1, parsedInput.data.offsetRatio)),
        updatedAt: currentTime.toISOString()
      });
      try {
        await database.write(positionKey(parsedScope.data), {
          schemaVersion: 1,
          ...parsedScope.data,
          position
        });
        return "saved";
      } catch {
        return "unavailable";
      }
    }
  };
}

/** Opens an isolated, scoped IndexedDB store for non-authoritative reader position. */
export function createIndexedDbReaderPositionDatabase(): ReaderPositionDatabasePort {
  let databasePromise: Promise<IDBDatabase> | null = null;
  const openDatabase = (): Promise<IDBDatabase> => {
    if (typeof indexedDB === "undefined") return Promise.reject(new Error("IndexedDB is unavailable."));
    if (databasePromise !== null) return databasePromise;
    databasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open("infiniteQuest-reader-positions-v1", 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains("positions")) {
          request.result.createObjectStore("positions");
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("Could not open reader position storage."));
      request.onblocked = () => reject(new Error("Reader position storage is blocked."));
    });
    return databasePromise;
  };

  return {
    async read(key) {
      const database = await openDatabase();
      return new Promise((resolve, reject) => {
        const transaction = database.transaction("positions", "readonly");
        const request = transaction.objectStore("positions").get(key);
        request.onsuccess = () => resolve(request.result as unknown);
        request.onerror = () => reject(request.error ?? new Error("Could not read reader position."));
        transaction.onabort = () => reject(transaction.error ?? new Error("Reader position read was aborted."));
      });
    },
    async write(key, value) {
      const database = await openDatabase();
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction("positions", "readwrite");
        transaction.objectStore("positions").put(value, key);
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error ?? new Error("Could not write reader position."));
        transaction.onabort = () => reject(transaction.error ?? new Error("Reader position write was aborted."));
      });
    }
  };
}
