import {
  MAX_PLAYABLE_CHARACTERS,
  playableCharacterSchema,
  type PlayableCharacter
} from "../../../packages/contracts/src/world-library.js";
import {
  characterWorkspacePath,
  type CharacterWorkspaceSession,
  type CharacterWorkspaceSessionStore
} from "./character-workspace-session.js";
import type { WorldCreationState } from "./world-creation-model.js";

export interface WorldCreationCharacterHandoffPointer {
  key: string;
  workflowId: string;
}

export interface WorldCreationCharacterHandoffPointerStore {
  read(): WorldCreationCharacterHandoffPointer | null;
  write(pointer: WorldCreationCharacterHandoffPointer): boolean;
  clear(pointer?: WorldCreationCharacterHandoffPointer): boolean;
}

const CREATION_POINTER_KEY = "iqn:world-creation:character-handoff";
const MAX_POINTER_IDENTITY_LENGTH = 512;

function isPointer(value: unknown): value is WorldCreationCharacterHandoffPointer {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 2 &&
    typeof record.key === "string" && record.key.length > 0 && record.key.length <= MAX_POINTER_IDENTITY_LENGTH &&
    typeof record.workflowId === "string" && record.workflowId.length > 0 && record.workflowId.length <= MAX_POINTER_IDENTITY_LENGTH;
}

export function createWorldCreationCharacterHandoffPointerStore(
  storage: Storage
): WorldCreationCharacterHandoffPointerStore {
  return {
    read() {
      let raw: string | null;
      try { raw = storage.getItem(CREATION_POINTER_KEY); } catch { return null; }
      if (raw === null) return null;
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (isPointer(parsed)) return { key: parsed.key, workflowId: parsed.workflowId };
      } catch { /* Remove malformed pointers below. */ }
      try { storage.removeItem(CREATION_POINTER_KEY); } catch { /* Best-effort terminal cleanup. */ }
      return null;
    },
    write(pointer) {
      if (!isPointer(pointer)) return false;
      try {
        storage.setItem(CREATION_POINTER_KEY, JSON.stringify(pointer));
        return true;
      } catch { return false; }
    },
    clear(pointer) {
      if (pointer) {
        const current = this.read();
        if (!current || current.key !== pointer.key || current.workflowId !== pointer.workflowId) return false;
      }
      try {
        storage.removeItem(CREATION_POINTER_KEY);
        return storage.getItem(CREATION_POINTER_KEY) === null;
      } catch { return false; }
    }
  };
}

export interface WorldCreationCharacterRosterInput {
  document: Document;
  state: WorldCreationState;
  sessionStore: CharacterWorkspaceSessionStore | null;
  workflowIdFactory: () => string;
  navigate: (path: string) => void;
  onSessionCreated: (session: CharacterWorkspaceSession) => void | boolean;
  onRemove: (characterId: string) => void;
  onRestore: (removalId: string) => void;
  handoffRecovery?: {
    message: string;
    returnPath: string;
    onRetry: () => void;
    onReturn?: () => void;
  };
}

function reviewedRoster(state: WorldCreationState): PlayableCharacter[] {
  return state.draft.playableCharacters.map((candidate) => playableCharacterSchema.parse(candidate));
}

function action(document: Document, name: string, label: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.dataset.action = name;
  button.textContent = label;
  return button;
}

export function renderWorldCreationCharacterRoster(
  input: WorldCreationCharacterRosterInput
): HTMLElement {
  const { document, state } = input;
  const section = document.createElement("section");
  section.className = "creation-character-stage";
  section.dataset.characterRoster = "";

  const header = document.createElement("header");
  const heading = document.createElement("h2");
  heading.id = "characters-heading";
  heading.textContent = "Characters";
  const guidance = document.createElement("p");
  guidance.textContent = "Build an optional reviewed roster for this world draft before creation.";
  header.append(heading, guidance);
  section.append(header);

  const roster = reviewedRoster(state);
  if (roster.length === 0) {
    const empty = document.createElement("p");
    empty.dataset.characterRosterEmpty = "";
    empty.textContent = "Characters are optional. Add one now or continue with an empty roster.";
    section.append(empty);
  } else {
    const list = document.createElement("ol");
    list.className = "creation-character-roster";
    for (const character of roster) {
      const item = document.createElement("li");
      item.dataset.characterRosterItem = "";
      const name = document.createElement("h3");
      name.textContent = character.name;
      const edit = action(document, "edit-character", "Edit");
      edit.dataset.characterId = character.id;
      const remove = action(document, "remove-character", "Remove");
      remove.dataset.characterId = character.id;
      item.append(name, edit, remove);
      list.append(item);
    }
    section.append(list);
  }

  const status = document.createElement("p");
  status.dataset.characterRosterStatus = "";
  status.setAttribute("role", "status");
  const add = action(document, "add-character", roster.length === 0 ? "Add character" : "Add another");
  if (roster.length >= MAX_PLAYABLE_CHARACTERS) {
    add.disabled = true;
    add.setAttribute("aria-describedby", "character-roster-limit");
    const limit = document.createElement("p");
    limit.id = "character-roster-limit";
    limit.textContent = `This roster has the maximum ${MAX_PLAYABLE_CHARACTERS} characters. Remove one before adding another.`;
    section.append(add, limit, status);
  } else {
    section.append(add, status);
  }

  if (input.handoffRecovery) {
    const recovery = document.createElement("div");
    recovery.dataset.characterHandoffError = "";
    recovery.setAttribute("role", "alert");
    const message = document.createElement("p");
    message.textContent = input.handoffRecovery.message;
    const retry = action(document, "retry-character-result", "Retry result");
    const returnLink = document.createElement("a");
    returnLink.href = input.handoffRecovery.returnPath;
    returnLink.textContent = "Return to character workspace";
    recovery.append(message, retry, returnLink);
    section.append(recovery);
  }

  const removals = document.createElement("div");
  removals.dataset.characterRemovals = "";
  for (const removal of state.pendingRemovals.filter(({ collection }) => collection === "playableCharacters")) {
    const row = document.createElement("p");
    const parsed = playableCharacterSchema.safeParse(removal.value);
    row.append(document.createTextNode(`${parsed.success ? parsed.data.name : "Character"} removed. `));
    const undo = action(document, "undo-character-removal", "Undo removal");
    undo.dataset.removalId = removal.id;
    row.append(undo);
    removals.append(row);
  }
  section.append(removals);

  function begin(mode: "create" | "edit", candidate: PlayableCharacter | null): void {
    if (mode === "create" && roster.length >= MAX_PLAYABLE_CHARACTERS) {
      status.textContent = `Remove a character before adding another; this roster already has ${MAX_PLAYABLE_CHARACTERS}.`;
      return;
    }
    if (!input.sessionStore) {
      status.textContent = "Character editing is unavailable in this browser session. Your world draft is unchanged.";
      return;
    }
    try {
      const session = input.sessionStore.create({
        origin: "world-creation",
        mode,
        workflowId: input.workflowIdFactory(),
        parentRoute: "/app/worlds/new",
        expectedWorldRevision: null,
        parentDraft: state.draft,
        worldContext: state.draft,
        rosterSummaries: roster.map(({ id, name }) => ({ id, name })),
        candidate
      });
      if (input.onSessionCreated(session) === false) {
        status.textContent = "The character workspace could not preserve a safe return pointer. Your world draft is unchanged; try again.";
        return;
      }
      input.navigate(characterWorkspacePath(session.key));
    } catch {
      status.textContent = "The character workspace could not be opened. Your world draft is unchanged; try again.";
    }
  }

  section.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof document.defaultView!.Element)) return;
    const button = target.closest<HTMLButtonElement>("button[data-action]");
    if (button?.dataset.action === "add-character") begin("create", null);
    else if (button?.dataset.action === "edit-character" && button.dataset.characterId) {
      const candidate = roster.find(({ id }) => id === button.dataset.characterId);
      if (candidate) begin("edit", candidate);
    } else if (button?.dataset.action === "remove-character" && button.dataset.characterId) {
      input.onRemove(button.dataset.characterId);
    } else if (button?.dataset.action === "undo-character-removal" && button.dataset.removalId) {
      input.onRestore(button.dataset.removalId);
    } else if (button?.dataset.action === "retry-character-result") {
      input.handoffRecovery?.onRetry();
    } else {
      const returnLink = target.closest<HTMLAnchorElement>("[data-character-handoff-error] a");
      if (!returnLink || !input.handoffRecovery?.onReturn) return;
      event.preventDefault();
      input.handoffRecovery.onReturn();
    }
  });

  return section;
}
