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
