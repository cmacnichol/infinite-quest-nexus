import {
  cloneWorldDraft,
  type EditableWorldDraft,
  type WorldAggregate
} from "./world-editor-model";

export type WorldEditorStatus = "saved" | "unsaved" | "saving" | "error";
export type DraftCollectionName =
  | "playableCharacters"
  | "entities"
  | "relationships"
  | "rpgStats"
  | "defaultTriggers"
  | "eventTriggers"
  | "assets";

export interface PendingRemoval {
  id: string;
  collection: DraftCollectionName;
  originalIndex: number;
  value: unknown;
}

export interface DraftSaveError {
  kind: string;
  message: string;
}

export interface WorldEditorState {
  authoritativeWorld: WorldAggregate;
  draft: EditableWorldDraft;
  revision: number | null;
  status: WorldEditorStatus;
  pendingRemovals: PendingRemoval[];
  saveError: DraftSaveError | null;
}

export interface DraftValidationIssue {
  path: string;
  severity: "error" | "warning";
  message: string;
}

export interface DraftValidation {
  issues: DraftValidationIssue[];
}

export interface PreservedDataNotice {
  path: string;
  message: string;
}

export interface DraftReadiness {
  sections: Array<{
    section: "Overview" | "Characters" | "Canon" | "Mechanics" | "Assets";
    ready: boolean;
    issueCount: number;
  }>;
  warningCount: number;
  notices: PreservedDataNotice[];
}

export interface CompletedDraftSave {
  revision: number;
  content: EditableWorldDraft;
}

const DRAFT_KEYS = new Set([
  "schemaVersion",
  "world",
  "playableCharacters",
  "entities",
  "relationships",
  "rpgStats",
  "defaultTriggers",
  "eventTriggers",
  "assets",
  "defaults"
]);
const WORLD_KEYS = new Set([
  "title",
  "genre",
  "tone",
  "premise",
  "backgroundStory",
  "firstAction",
  "rules"
]);
const ADVANCED_JSON_ROOTS = new Set([
  "playableCharacters",
  "entities",
  "relationships",
  "rpgStats",
  "defaultTriggers",
  "eventTriggers",
  "assets",
  "defaults"
]);

function nextRemovalId(pendingRemovals: readonly PendingRemoval[]): string {
  const nextSequence = pendingRemovals.reduce((highest, removal) => {
    const match = /^draft-removal-(\d+)$/.exec(removal.id);
    return Math.max(highest, match ? Number(match[1]) : 0);
  }, 0) + 1;
  return `draft-removal-${nextSequence}`;
}

function originalCollectionIndex(
  pendingRemovals: readonly PendingRemoval[],
  collection: DraftCollectionName,
  currentIndex: number
): number {
  return pendingRemovals
    .filter((removal) => removal.collection === collection)
    .map((removal) => removal.originalIndex)
    .sort((left, right) => left - right)
    .reduce((originalIndex, removedIndex) => removedIndex <= originalIndex ? originalIndex + 1 : originalIndex, currentIndex);
}

function clone<T>(value: T): T {
  return typeof structuredClone === "function"
    ? structuredClone(value)
    : JSON.parse(JSON.stringify(value)) as T;
}

function advancedJsonValue(path: readonly string[], value: unknown): unknown {
  if (path.length !== 1 || typeof value !== "string" || !ADVANCED_JSON_ROOTS.has(path[0]!)) {
    return value;
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error(`${path[0]} must contain valid JSON.`);
  }
}

function setAtPath(target: Record<string, unknown>, path: readonly string[], value: unknown): void {
  if (path.length === 0) throw new Error("A draft field path is required.");
  let parent = target;
  for (const segment of path.slice(0, -1)) {
    const child = parent[segment];
    if (typeof child !== "object" || child === null || Array.isArray(child)) {
      throw new Error(`Draft field path ${path.join(".")} is invalid.`);
    }
    parent = child as Record<string, unknown>;
  }
  parent[path[path.length - 1]!] = value;
}

function preservedDataNotices(draft: EditableWorldDraft): PreservedDataNotice[] {
  const message = "Preserved unknown data will be saved unchanged.";
  const worldNotices = Object.keys(draft.world)
    .filter((key) => !WORLD_KEYS.has(key))
    .map((key) => ({ path: `world.${key}`, message }));
  const rootNotices = Object.keys(draft)
    .filter((key) => !DRAFT_KEYS.has(key))
    .map((key) => ({ path: key, message }));
  return [...worldNotices, ...rootNotices];
}

function sectionForPath(path: string): DraftReadiness["sections"][number]["section"] {
  if (path.startsWith("playableCharacters")) return "Characters";
  if (path.startsWith("entities") || path.startsWith("relationships")) return "Canon";
  if (["rpgStats", "defaultTriggers", "eventTriggers", "defaults"].some((root) => path.startsWith(root))) {
    return "Mechanics";
  }
  if (path.startsWith("assets")) return "Assets";
  return "Overview";
}

export function createWorldEditorState(world: WorldAggregate): WorldEditorState {
  return {
    authoritativeWorld: world,
    draft: cloneWorldDraft(world),
    revision: world.draftRevision,
    status: "saved",
    pendingRemovals: [],
    saveError: null
  };
}

export function editWorldDraft(
  state: WorldEditorState,
  path: readonly string[],
  value: unknown
): WorldEditorState {
  const draft = clone(state.draft);
  setAtPath(draft, path, advancedJsonValue(path, value));
  return { ...state, draft, status: "unsaved", saveError: null };
}

export function removeCollectionItem(
  state: WorldEditorState,
  collection: DraftCollectionName,
  index: number
): WorldEditorState {
  const current = state.draft[collection];
  if (!Number.isInteger(index) || index < 0 || index >= current.length) {
    throw new RangeError(`No ${collection} item exists at index ${index}.`);
  }
  const draft = clone(state.draft);
  const [value] = draft[collection].splice(index, 1);
  const removal: PendingRemoval = {
    id: nextRemovalId(state.pendingRemovals),
    collection,
    originalIndex: originalCollectionIndex(state.pendingRemovals, collection, index),
    value: clone(value)
  };
  return {
    ...state,
    draft,
    status: "unsaved",
    pendingRemovals: [...state.pendingRemovals, removal],
    saveError: null
  };
}

export function restoreCollectionItem(state: WorldEditorState, removalId: string): WorldEditorState {
  const removal = state.pendingRemovals.find((candidate) => candidate.id === removalId);
  if (!removal) return state;
  const draft = clone(state.draft);
  draft[removal.collection].splice(removal.originalIndex, 0, clone(removal.value));
  return {
    ...state,
    draft,
    status: "unsaved",
    pendingRemovals: state.pendingRemovals.filter((candidate) => candidate.id !== removalId),
    saveError: null
  };
}

export function validateWorldDraft(state: WorldEditorState): DraftValidation {
  const issues: DraftValidationIssue[] = [];
  if (!state.draft.world.title.trim()) {
    issues.push({ path: "world.title", severity: "error", message: "World title is required." });
  }
  return { issues };
}

export function draftReadiness(state: WorldEditorState): DraftReadiness {
  const issues = validateWorldDraft(state).issues;
  const sectionNames: DraftReadiness["sections"][number]["section"][] = [
    "Overview",
    "Characters",
    "Canon",
    "Mechanics",
    "Assets"
  ];
  const sections = sectionNames.map((section) => {
    const issueCount = issues.filter((issue) => sectionForPath(issue.path) === section).length;
    return { section, ready: issueCount === 0, issueCount };
  });
  const notices = preservedDataNotices(state.draft);
  return { sections, warningCount: issues.filter((issue) => issue.severity === "warning").length + notices.length, notices };
}

export function beginDraftSave(state: WorldEditorState): WorldEditorState {
  return { ...state, status: "saving", saveError: null };
}

export function completeDraftSave(state: WorldEditorState, result: CompletedDraftSave): WorldEditorState {
  return {
    ...state,
    draft: clone(result.content),
    revision: result.revision,
    status: "saved",
    pendingRemovals: [],
    saveError: null
  };
}

export function failDraftSave(
  state: WorldEditorState,
  kind: string,
  message: string
): WorldEditorState {
  return { ...state, status: "error", saveError: { kind, message } };
}
