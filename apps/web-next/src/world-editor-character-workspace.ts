import {
  MAX_PLAYABLE_CHARACTERS,
  playableCharacterSchema,
  type PlayableCharacter
} from "../../../packages/contracts/src/world-library.js";
import {
  type CharacterWorkspaceResult,
  type CharacterWorkspaceSession,
  type CharacterWorkspaceSessionStore
} from "./character-workspace-session.js";
import { sanitizeCharacterWorkspaceValue } from "./character-workspace-sanitizer.js";
import {
  parseEditableWorldDraft,
  type EditableWorldDraft
} from "./world-editor-model.js";

export interface WorldEditorCharacterHandoffPointer {
  key: string;
  workflowId: string;
}

export interface WorldEditorCharacterHandoffPointerStore {
  read(worldId: string): WorldEditorCharacterHandoffPointer | null;
  write(worldId: string, pointer: WorldEditorCharacterHandoffPointer): boolean;
  clear(worldId: string, pointer?: WorldEditorCharacterHandoffPointer): boolean;
}

const POINTER_PREFIX = "iqn:world-editor:character-handoff";
const MAX_POINTER_IDENTITY_LENGTH = 512;

function pointerStorageKey(worldId: string): string {
  return `${POINTER_PREFIX}:${encodeURIComponent(worldId)}`;
}

function isPointer(value: unknown): value is WorldEditorCharacterHandoffPointer {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 2 &&
    typeof record.key === "string" && record.key.length > 0 && record.key.length <= MAX_POINTER_IDENTITY_LENGTH &&
    typeof record.workflowId === "string" && record.workflowId.length > 0 &&
    record.workflowId.length <= MAX_POINTER_IDENTITY_LENGTH;
}

export function createWorldEditorCharacterHandoffPointerStore(
  storage: Storage
): WorldEditorCharacterHandoffPointerStore {
  return {
    read(worldId) {
      const storageKey = pointerStorageKey(worldId);
      let raw: string | null;
      try {
        raw = storage.getItem(storageKey);
      } catch {
        return null;
      }
      if (raw === null) return null;
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (isPointer(parsed)) return { key: parsed.key, workflowId: parsed.workflowId };
      } catch {
        // Remove malformed local pointers below.
      }
      try { storage.removeItem(storageKey); } catch { /* Best-effort terminal cleanup. */ }
      return null;
    },
    write(worldId, pointer) {
      if (!isPointer(pointer)) return false;
      try {
        storage.setItem(pointerStorageKey(worldId), JSON.stringify(pointer));
        return true;
      } catch {
        return false;
      }
    },
    clear(worldId, pointer) {
      const storageKey = pointerStorageKey(worldId);
      if (pointer) {
        const current = this.read(worldId);
        if (current === null || current.key !== pointer.key || current.workflowId !== pointer.workflowId) return false;
      }
      try {
        storage.removeItem(storageKey);
        return storage.getItem(storageKey) === null;
      } catch {
        return false;
      }
    }
  };
}

function character(value: unknown): PlayableCharacter {
  return playableCharacterSchema.parse(sanitizeCharacterWorkspaceValue(value));
}

export function beginWorldEditorCharacterSession(input: {
  store: CharacterWorkspaceSessionStore;
  worldId: string;
  workflowId: string;
  revision: number;
  draft: EditableWorldDraft;
  characterId?: string;
}): CharacterWorkspaceSession {
  const snapshot = parseEditableWorldDraft(
    sanitizeCharacterWorkspaceValue(structuredClone(input.draft))
  );
  const roster = snapshot.playableCharacters.map(character);
  const candidate = input.characterId === undefined
    ? null
    : roster.find(({ id }) => id === input.characterId) ?? null;
  if (input.characterId !== undefined && candidate === null) {
    throw new RangeError(`No playable character exists with ID ${input.characterId}.`);
  }
  return input.store.create({
    origin: "world-editor",
    mode: candidate === null ? "create" : "edit",
    workflowId: input.workflowId,
    parentRoute: `/app/worlds/${encodeURIComponent(input.worldId)}`,
    expectedWorldRevision: input.revision,
    parentDraft: snapshot,
    worldContext: snapshot,
    rosterSummaries: roster.map(({ id, name }) => ({ id, name })),
    candidate
  });
}

export function applyWorldEditorCharacterResult(input: {
  draft: EditableWorldDraft;
  session: CharacterWorkspaceSession;
  result: CharacterWorkspaceResult;
}): EditableWorldDraft {
  const draft = structuredClone(input.draft);
  if (input.result.status === "cancelled") return draft;

  const candidate = character(input.result.candidate);
  if (input.session.mode === "create") {
    if (draft.playableCharacters.length >= MAX_PLAYABLE_CHARACTERS) {
      throw new RangeError(`A world cannot contain more than ${MAX_PLAYABLE_CHARACTERS} playable characters.`);
    }
    if (draft.playableCharacters.some((existing) =>
      typeof existing === "object" && existing !== null && (existing as { id?: unknown }).id === candidate.id
    )) {
      throw new Error(`A playable character with ID ${candidate.id} already exists.`);
    }
    draft.playableCharacters.push(candidate);
    return draft;
  }

  const characterId = input.session.candidate?.id;
  if (!characterId || candidate.id !== characterId) {
    throw new Error("A replacement character ID must match the reviewed character ID.");
  }
  const index = draft.playableCharacters.findIndex((existing) =>
    typeof existing === "object" && existing !== null && (existing as { id?: unknown }).id === characterId
  );
  if (index < 0) throw new RangeError(`No playable character exists with ID ${characterId}.`);
  draft.playableCharacters[index] = candidate;
  return draft;
}
