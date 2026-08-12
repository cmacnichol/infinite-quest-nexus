import { playableCharacterSchema, type PlayableCharacter } from "../../../packages/contracts/src/world-library.js";
import {
  characterWorkspacePath,
  type CharacterWorkspaceSession,
  type CharacterWorkspaceSessionStore
} from "./character-workspace-session.js";
import type { WorldCreationState } from "./world-creation-model.js";

export interface WorldCreationCharacterRosterInput {
  document: Document;
  state: WorldCreationState;
  sessionStore: CharacterWorkspaceSessionStore | null;
  workflowIdFactory: () => string;
  navigate: (path: string) => void;
  onSessionCreated: (session: CharacterWorkspaceSession) => void;
  onRemove: (characterId: string) => void;
  onRestore: (removalId: string) => void;
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
  section.append(add, status);

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
      input.onSessionCreated(session);
      input.navigate(characterWorkspacePath(session.key));
    } catch {
      status.textContent = "The character workspace could not be opened. Your world draft is unchanged; try again.";
    }
  }

  section.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof document.defaultView!.Element)) return;
    const button = target.closest<HTMLButtonElement>("button[data-action]");
    if (!button) return;
    if (button.dataset.action === "add-character") begin("create", null);
    else if (button.dataset.action === "edit-character" && button.dataset.characterId) {
      const candidate = roster.find(({ id }) => id === button.dataset.characterId);
      if (candidate) begin("edit", candidate);
    } else if (button.dataset.action === "remove-character" && button.dataset.characterId) {
      input.onRemove(button.dataset.characterId);
    } else if (button.dataset.action === "undo-character-removal" && button.dataset.removalId) {
      input.onRestore(button.dataset.removalId);
    }
  });

  return section;
}
