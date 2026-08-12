import {
  playableCharacterSchema,
  type PlayableCharacter
} from "../../../packages/contracts/src/world-library.js";
import {
  parseEditableWorldDraft,
  type EditableWorldDraft
} from "./world-editor-model.js";
import { sanitizeCharacterWorkspaceValue } from "./character-workspace-sanitizer.js";

export type CharacterWorkspaceOrigin = "world-creation" | "world-editor";
export type CharacterWorkspaceMode = "create" | "edit";

export interface CharacterSummary {
  id: string;
  name: string;
}

export interface CharacterWorkspaceSession {
  version: 1;
  key: string;
  origin: CharacterWorkspaceOrigin;
  mode: CharacterWorkspaceMode;
  workflowId: string;
  parentRoute: string;
  expectedWorldRevision: number | null;
  parentDraft: EditableWorldDraft;
  worldContext: EditableWorldDraft;
  rosterSummaries: readonly CharacterSummary[];
  candidate: PlayableCharacter | null;
  expiresAt: number;
}

export type CharacterWorkspaceResult =
  | { status: "accepted"; candidate: PlayableCharacter }
  | { status: "cancelled" };

export type CreateCharacterWorkspaceSession = Omit<CharacterWorkspaceSession, "version" | "key" | "expiresAt">;

export interface SessionStoreOptions {
  now?: () => number;
  keyFactory?: () => string;
}

export interface ConsumedCharacterWorkspaceSession {
  session: CharacterWorkspaceSession;
  result: CharacterWorkspaceResult;
}

export type CharacterWorkspaceResultInspection =
  | ({ status: "ready" } & ConsumedCharacterWorkspaceSession)
  | { status: "invalid"; session: CharacterWorkspaceSession };

export interface CharacterWorkspaceSessionStore {
  create(input: CreateCharacterWorkspaceSession): CharacterWorkspaceSession;
  load(key: string): CharacterWorkspaceSession | null;
  returnPath(key: string): string | null;
  complete(key: string, workflowId: string, result: CharacterWorkspaceResult): boolean;
  peek(
    key: string,
    origin: CharacterWorkspaceOrigin,
    workflowId: string
  ): CharacterWorkspaceResultInspection | null;
  consume(
    key: string,
    origin: CharacterWorkspaceOrigin,
    workflowId: string
  ): ConsumedCharacterWorkspaceSession | null;
}

interface ReturnTombstone {
  version: 1;
  key: string;
  parentRoute: string;
  expiresAt: number;
}

interface StoredResult {
  version: 1;
  key: string;
  workflowId: string;
  expiresAt: number;
  result: CharacterWorkspaceResult;
}

const STORAGE_PREFIX = "iqn:character-workspace";
const SESSION_LIFETIME_MS = 30 * 60 * 1000;
const MAX_HANDOFF_BYTES = 512 * 1024;
const MAX_KEY_ATTEMPTS = 10;
const MAX_IDENTITY_LENGTH = 512;
const RESULT_FIELDS = new Set(["version", "key", "workflowId", "expiresAt", "result"]);
const SESSION_FIELDS = new Set([
  "version",
  "key",
  "origin",
  "mode",
  "workflowId",
  "parentRoute",
  "expectedWorldRevision",
  "parentDraft",
  "worldContext",
  "rosterSummaries",
  "candidate",
  "expiresAt"
]);

function sessionStorageKey(key: string): string {
  return `${STORAGE_PREFIX}:session:${key}`;
}

function returnStorageKey(key: string): string {
  return `${STORAGE_PREFIX}:return:${key}`;
}

function resultStorageKey(key: string): string {
  return `${STORAGE_PREFIX}:result:${key}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoundedString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_IDENTITY_LENGTH;
}

function isOrigin(value: unknown): value is CharacterWorkspaceOrigin {
  return value === "world-creation" || value === "world-editor";
}

function isMode(value: unknown): value is CharacterWorkspaceMode {
  return value === "create" || value === "edit";
}

function isRevision(value: unknown): value is number | null {
  return value === null || (Number.isInteger(value) && Number(value) >= 0);
}

function isExpiry(value: unknown, now: number): value is number {
  return Number.isInteger(value) && Number(value) > now && Number(value) <= now + SESSION_LIFETIME_MS;
}

function isSafeParentRoute(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2_048 ||
      !value.startsWith("/app") || value.startsWith("//") || /[\\\u0000-\u001f]/u.test(value)) {
    return false;
  }
  try {
    const route = new URL(value, "https://character-workspace.invalid");
    return route.origin === "https://character-workspace.invalid" &&
      `${route.pathname}${route.search}${route.hash}` === value &&
      (route.pathname === "/app" || route.pathname.startsWith("/app/"));
  } catch {
    return false;
  }
}


function parseDraft(value: unknown): EditableWorldDraft | null {
  try {
    return parseEditableWorldDraft(value);
  } catch {
    return null;
  }
}

function parseCandidate(value: unknown): PlayableCharacter | null {
  const parsed = playableCharacterSchema.safeParse(sanitizeCharacterWorkspaceValue(value));
  return parsed.success ? parsed.data : null;
}

function parseSummary(value: unknown): CharacterSummary | null {
  if (!isRecord(value)) return null;
  const id = playableCharacterSchema.shape.id.safeParse(value.id);
  const name = playableCharacterSchema.shape.name.safeParse(value.name);
  return id.success && name.success ? { id: id.data, name: name.data } : null;
}

function parseSession(value: unknown, expectedKey: string, now: number): CharacterWorkspaceSession | null {
  if (!isRecord(value) || Object.keys(value).some((key) => !SESSION_FIELDS.has(key)) ||
      value.version !== 1 || value.key !== expectedKey || !isBoundedString(value.key) ||
      !isOrigin(value.origin) || !isMode(value.mode) ||
      !isBoundedString(value.workflowId) || !isSafeParentRoute(value.parentRoute) ||
      !isRevision(value.expectedWorldRevision) || !Array.isArray(value.rosterSummaries) ||
      !isExpiry(value.expiresAt, now)) {
    return null;
  }
  const parentDraft = parseDraft(sanitizeCharacterWorkspaceValue(value.parentDraft));
  const worldContext = parseDraft(sanitizeCharacterWorkspaceValue(value.worldContext));
  const summaries = value.rosterSummaries.map(parseSummary);
  const candidate = value.candidate === null ? null : parseCandidate(value.candidate);
  if (parentDraft === null || worldContext === null || summaries.some((summary) => summary === null) ||
      (value.candidate !== null && candidate === null)) {
    return null;
  }
  return {
    version: 1,
    key: value.key,
    origin: value.origin,
    mode: value.mode,
    workflowId: value.workflowId,
    parentRoute: value.parentRoute,
    expectedWorldRevision: value.expectedWorldRevision,
    parentDraft,
    worldContext,
    rosterSummaries: summaries as CharacterSummary[],
    candidate,
    expiresAt: value.expiresAt
  };
}

function parseResult(value: unknown): CharacterWorkspaceResult | null {
  if (!isRecord(value)) return null;
  if (value.status === "cancelled" && Object.keys(value).length === 1) return { status: "cancelled" };
  if (value.status !== "accepted" || Object.keys(value).some((key) => key !== "status" && key !== "candidate")) {
    return null;
  }
  const candidate = parseCandidate(value.candidate);
  return candidate === null ? null : { status: "accepted", candidate };
}

function parseStoredResult(value: unknown, session: CharacterWorkspaceSession, now: number): StoredResult | null {
  if (!isRecord(value) || Object.keys(value).some((key) => !RESULT_FIELDS.has(key)) ||
      value.version !== 1 || value.key !== session.key || value.workflowId !== session.workflowId ||
      value.expiresAt !== session.expiresAt ||
      !isExpiry(value.expiresAt, now)) {
    return null;
  }
  const result = parseResult(value.result);
  return result === null ? null : {
    version: 1,
    key: session.key,
    workflowId: session.workflowId,
    expiresAt: session.expiresAt,
    result
  };
}

function parseTombstone(value: unknown, expectedKey: string, now: number): ReturnTombstone | null {
  if (!isRecord(value) || Object.keys(value).some((key) =>
    key !== "version" && key !== "key" && key !== "parentRoute" && key !== "expiresAt"
  ) || value.version !== 1 || value.key !== expectedKey || !isBoundedString(value.key) ||
      !isSafeParentRoute(value.parentRoute) || !isExpiry(value.expiresAt, now)) {
    return null;
  }
  return {
    version: 1,
    key: value.key,
    parentRoute: value.parentRoute,
    expiresAt: value.expiresAt
  };
}

function serializeBounded(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (new TextEncoder().encode(serialized).byteLength > MAX_HANDOFF_BYTES) {
    throw new Error("Character workspace handoffs cannot exceed 512 KiB.");
  }
  return serialized;
}

function safeRead(storage: Storage, key: string): string | null {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function safeRemove(storage: Storage, key: string): boolean {
  try {
    storage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

function isAbsent(storage: Storage, key: string): boolean {
  try {
    return storage.getItem(key) === null;
  } catch {
    return false;
  }
}

function decode(raw: string | null): unknown {
  if (raw === null || new TextEncoder().encode(raw).byteLength > MAX_HANDOFF_BYTES) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

export function characterWorkspacePath(key: string): string {
  return `/app/characters/${encodeURIComponent(key)}`;
}

export function characterSessionKeyFromPath(pathname: string): string | null {
  const match = /^\/app\/characters\/([^/]+)$/u.exec(pathname);
  if (match?.[1] === undefined) return null;
  try {
    const key = decodeURIComponent(match[1]);
    return isBoundedString(key) ? key : null;
  } catch {
    return null;
  }
}

export function createCharacterWorkspaceSessionStore(
  storage: Storage,
  options: SessionStoreOptions = {}
): CharacterWorkspaceSessionStore {
  const now = options.now ?? Date.now;
  const keyFactory = options.keyFactory ?? (() => crypto.randomUUID());

  function removeAll(key: string): void {
    safeRemove(storage, sessionStorageKey(key));
    safeRemove(storage, returnStorageKey(key));
    safeRemove(storage, resultStorageKey(key));
  }

  function load(key: string): CharacterWorkspaceSession | null {
    if (!isBoundedString(key)) return null;
    const parsed = parseSession(decode(safeRead(storage, sessionStorageKey(key))), key, now());
    if (parsed !== null) return parsed;
    safeRemove(storage, sessionStorageKey(key));
    safeRemove(storage, resultStorageKey(key));
    return null;
  }

  function peek(
    key: string,
    origin: CharacterWorkspaceOrigin,
    workflowId: string
  ): CharacterWorkspaceResultInspection | null {
    const session = load(key);
    if (session === null || session.origin !== origin || session.workflowId !== workflowId) return null;
    const rawResult = safeRead(storage, resultStorageKey(key));
    if (rawResult === null) return null;
    const stored = parseStoredResult(decode(rawResult), session, now());
    return stored === null
      ? { status: "invalid", session }
      : { status: "ready", session, result: stored.result };
  }

  return {
    create(input) {
      let key = "";
      for (let attempt = 0; attempt < MAX_KEY_ATTEMPTS; attempt += 1) {
        const generated = keyFactory();
        if (!isBoundedString(generated)) continue;
        if (safeRead(storage, sessionStorageKey(generated)) === null &&
            safeRead(storage, returnStorageKey(generated)) === null &&
            safeRead(storage, resultStorageKey(generated)) === null) {
          key = generated;
          break;
        }
      }
      if (key === "") throw new Error("Unable to create an opaque character workspace key.");

      const currentTime = now();
      const sanitized = sanitizeCharacterWorkspaceValue(input);
      const session = parseSession({
        ...sanitized as CreateCharacterWorkspaceSession,
        version: 1,
        key,
        expiresAt: currentTime + SESSION_LIFETIME_MS
      }, key, currentTime);
      if (session === null) throw new Error("Character workspace session input is invalid.");
      const tombstone: ReturnTombstone = {
        version: 1,
        key,
        parentRoute: session.parentRoute,
        expiresAt: session.expiresAt
      };
      const serializedSession = serializeBounded(session);
      const serializedTombstone = serializeBounded(tombstone);
      try {
        storage.setItem(returnStorageKey(key), serializedTombstone);
        storage.setItem(sessionStorageKey(key), serializedSession);
      } catch (error) {
        removeAll(key);
        throw error;
      }
      return session;
    },

    load,

    returnPath(key) {
      if (!isBoundedString(key)) return null;
      const tombstone = parseTombstone(decode(safeRead(storage, returnStorageKey(key))), key, now());
      if (tombstone !== null) return tombstone.parentRoute;
      safeRemove(storage, returnStorageKey(key));
      return null;
    },

    complete(key, workflowId, result) {
      const session = load(key);
      if (session === null || session.workflowId !== workflowId ||
          safeRead(storage, resultStorageKey(key)) !== null) {
        return false;
      }
      const sanitizedResult = parseResult(sanitizeCharacterWorkspaceValue(result));
      if (sanitizedResult === null) return false;
      const stored: StoredResult = {
        version: 1,
        key,
        workflowId,
        expiresAt: session.expiresAt,
        result: sanitizedResult
      };
      try {
        storage.setItem(resultStorageKey(key), serializeBounded(stored));
        return true;
      } catch {
        return false;
      }
    },

    peek,

    consume(key, origin, workflowId) {
      const pending = peek(key, origin, workflowId);
      if (pending === null || pending.status !== "ready") return null;
      const { session } = pending;

      const sessionKey = sessionStorageKey(key);
      const returnKey = returnStorageKey(key);
      const resultKey = resultStorageKey(key);
      const consumedMarker = serializeBounded({
        version: 1,
        key,
        workflowId,
        expiresAt: session.expiresAt,
        consumed: true
      });
      try {
        storage.setItem(resultKey, consumedMarker);
      } catch {
        return null;
      }
      if (safeRead(storage, resultKey) !== consumedMarker) return null;

      const removalsSucceeded = [sessionKey, returnKey, resultKey]
        .map((storageKey) => safeRemove(storage, storageKey))
        .every(Boolean);
      const recordsAreAbsent = [sessionKey, returnKey, resultKey]
        .every((storageKey) => isAbsent(storage, storageKey));
      if (!removalsSucceeded || !recordsAreAbsent) return null;
      return { session, result: pending.result };
    }
  };
}
