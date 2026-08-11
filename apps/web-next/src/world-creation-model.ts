import {
  createEmptyWorldDraft,
  parseEditableWorldDraft,
  type EditableWorldDraft
} from "./world-editor-model";

export const WORLD_CREATION_PATH = "/app/worlds/new";

export type CreationMethod = "manual" | "ai";
export type CreationStage = "method" | "foundation" | "canon" | "mechanics" | "cover" | "review";
export type CreationStatus = "pristine" | "unsaved" | "creating" | "created" | "error";
export type CreationCollectionName =
  | "entities"
  | "relationships"
  | "rpgStats"
  | "defaultTriggers"
  | "eventTriggers"
  | "assets";

export interface CreationValidationIssue {
  path: string;
  message: string;
}

export interface CreationValidation {
  issues: CreationValidationIssue[];
}

export interface CreationPendingRemoval {
  id: string;
  collection: CreationCollectionName;
  originalIndex: number;
  value: unknown;
}

export interface GenerationReplacement {
  replacedLocalDraft: boolean;
  previousTitle: string;
  generatedTitle: string;
}

export interface CreationError {
  kind: string;
  message: string;
}

export interface WorldCreationState {
  stage: CreationStage;
  method: CreationMethod | null;
  draft: EditableWorldDraft;
  provenance: CreationMethod | null;
  status: CreationStatus;
  navigationDirty: boolean;
  pendingRemovals: CreationPendingRemoval[];
  nextRemovalSequence: number;
  generationReplacement: GenerationReplacement | null;
  creationError: CreationError | null;
}

export interface GeneratedWorldPreview {
  title: string;
  content: unknown;
}

export interface CreationReadiness {
  stages: Array<{
    stage: CreationStage;
    ready: boolean;
    issueCount: number;
  }>;
}

const CREATION_STAGES: readonly CreationStage[] = [
  "method",
  "foundation",
  "canon",
  "mechanics",
  "cover",
  "review"
];

function clone<T>(value: T): T {
  return typeof structuredClone === "function"
    ? structuredClone(value)
    : JSON.parse(JSON.stringify(value)) as T;
}

export function canonicalizeWorldCreationDraft(draft: EditableWorldDraft): EditableWorldDraft {
  const result = clone(draft);
  result.schemaVersion = 5;
  result.playableCharacters = [];
  return result;
}

const canonicalDraft = canonicalizeWorldCreationDraft;

function setAtPath(target: Record<string, unknown>, path: readonly string[], value: unknown): void {
  if (path.length === 0) throw new Error("A creation draft field path is required.");
  let parent = target;
  for (const segment of path.slice(0, -1)) {
    const child = parent[segment];
    if (typeof child !== "object" || child === null || Array.isArray(child)) {
      throw new Error(`Creation draft field path ${path.join(".")} is invalid.`);
    }
    parent = child as Record<string, unknown>;
  }
  parent[path[path.length - 1]!] = clone(value);
}

function hasLocalDraftContent(state: WorldCreationState): boolean {
  const empty = createEmptyWorldDraft();
  return JSON.stringify(canonicalDraft(state.draft)) !== JSON.stringify(empty);
}

function structuralIssues(draft: EditableWorldDraft): CreationValidationIssue[] {
  const issues: CreationValidationIssue[] = [];
  if (typeof draft.world !== "object" || draft.world === null || Array.isArray(draft.world)) {
    issues.push({ path: "world", message: "World details must be an object." });
  }
  for (const field of ["entities", "relationships", "rpgStats", "defaultTriggers", "eventTriggers", "assets"] as const) {
    if (!Array.isArray(draft[field])) issues.push({ path: field, message: `${field} must be an array.` });
  }
  if (typeof draft.defaults !== "object" || draft.defaults === null || Array.isArray(draft.defaults)) {
    issues.push({ path: "defaults", message: "defaults must be an object." });
  }
  return issues;
}

function originalCollectionIndex(
  removals: readonly CreationPendingRemoval[],
  collection: CreationCollectionName,
  currentIndex: number
): number {
  return removals
    .filter((removal) => removal.collection === collection)
    .map((removal) => removal.originalIndex)
    .sort((left, right) => left - right)
    .reduce((index, removedIndex) => removedIndex <= index ? index + 1 : index, currentIndex);
}

export function worldCreationPath(): string {
  return WORLD_CREATION_PATH;
}

export function isWorldCreationPath(pathname: string): boolean {
  return pathname === WORLD_CREATION_PATH;
}

export function createWorldCreationState(): WorldCreationState {
  return {
    stage: "method",
    method: null,
    draft: createEmptyWorldDraft(),
    provenance: null,
    status: "pristine",
    navigationDirty: false,
    pendingRemovals: [],
    nextRemovalSequence: 1,
    generationReplacement: null,
    creationError: null
  };
}

export function selectCreationMethod(
  state: WorldCreationState,
  method: CreationMethod
): WorldCreationState {
  return {
    ...state,
    method,
    provenance: method,
    draft: canonicalDraft(state.draft),
    status: "unsaved",
    navigationDirty: true,
    creationError: null
  };
}

export function editCreationDraft(
  state: WorldCreationState,
  path: readonly string[],
  value: unknown
): WorldCreationState {
  let draft = canonicalDraft(state.draft);
  if (path[0] !== "playableCharacters") setAtPath(draft, path, value);
  draft = canonicalDraft(draft);
  return {
    ...state,
    draft,
    status: "unsaved",
    navigationDirty: true,
    creationError: null
  };
}

export function validateCreationStage(
  state: WorldCreationState,
  stage: CreationStage = state.stage
): CreationValidation {
  const issues: CreationValidationIssue[] = [];
  if (stage === "method" || stage === "review") {
    if (state.method === null) issues.push({ path: "method", message: "Choose a creation method." });
  }
  if (stage === "foundation" || stage === "review") {
    const world = state.draft.world as unknown;
    if (typeof world !== "object" || world === null || Array.isArray(world)) {
      if (stage === "foundation") {
        issues.push({ path: "world", message: "World details must be an object." });
      }
    } else {
      const title = (world as Record<string, unknown>).title;
      if (typeof title !== "string" || !title.trim()) {
        issues.push({ path: "world.title", message: "World title is required." });
      }
    }
  }
  if (["canon", "mechanics", "cover", "review"].includes(stage)) {
    const relevantRoots: Record<CreationStage, readonly string[]> = {
      method: [],
      foundation: [],
      canon: ["entities", "relationships"],
      mechanics: ["rpgStats", "defaultTriggers", "eventTriggers", "defaults"],
      cover: ["assets"],
      review: ["world", "entities", "relationships", "rpgStats", "defaultTriggers", "eventTriggers", "assets", "defaults"]
    };
    issues.push(...structuralIssues(state.draft).filter((issue) => relevantRoots[stage].includes(issue.path)));
  }
  return { issues };
}

export function setCreationStage(
  state: WorldCreationState,
  stage: CreationStage
): WorldCreationState {
  const currentIndex = CREATION_STAGES.indexOf(state.stage);
  const nextIndex = CREATION_STAGES.indexOf(stage);
  if (nextIndex < 0 || nextIndex === currentIndex || nextIndex > currentIndex + 1) return state;
  if (nextIndex > currentIndex && validateCreationStage(state, state.stage).issues.length > 0) return state;
  return { ...state, stage, draft: canonicalDraft(state.draft) };
}

export function creationReadiness(state: WorldCreationState): CreationReadiness {
  return {
    stages: CREATION_STAGES.map((stage) => {
      const issues = validateCreationStage(state, stage).issues;
      return { stage, ready: issues.length === 0, issueCount: issues.length };
    })
  };
}

export function removeCreationCollectionItem(
  state: WorldCreationState,
  collection: CreationCollectionName,
  index: number
): WorldCreationState {
  const current = state.draft[collection];
  if (!Number.isInteger(index) || index < 0 || index >= current.length) {
    throw new RangeError(`No ${collection} item exists at index ${index}.`);
  }
  const draft = canonicalDraft(state.draft);
  const [value] = draft[collection].splice(index, 1);
  const removal: CreationPendingRemoval = {
    id: `creation-removal-${state.nextRemovalSequence}`,
    collection,
    originalIndex: originalCollectionIndex(state.pendingRemovals, collection, index),
    value: clone(value)
  };
  return {
    ...state,
    draft,
    status: "unsaved",
    navigationDirty: true,
    pendingRemovals: [...state.pendingRemovals, removal],
    nextRemovalSequence: state.nextRemovalSequence + 1,
    creationError: null
  };
}

export function restoreCreationCollectionItem(
  state: WorldCreationState,
  removalId: string
): WorldCreationState {
  const removal = state.pendingRemovals.find((candidate) => candidate.id === removalId);
  if (!removal) return state;
  const draft = canonicalDraft(state.draft);
  const earlierPendingCount = state.pendingRemovals.filter((candidate) =>
    candidate.collection === removal.collection && candidate.originalIndex < removal.originalIndex
  ).length;
  draft[removal.collection].splice(removal.originalIndex - earlierPendingCount, 0, clone(removal.value));
  return {
    ...state,
    draft,
    status: "unsaved",
    navigationDirty: true,
    pendingRemovals: state.pendingRemovals.filter((candidate) => candidate.id !== removalId),
    creationError: null
  };
}

export function applyGeneratedPreview(
  state: WorldCreationState,
  preview: GeneratedWorldPreview
): WorldCreationState {
  const previousTitle = typeof state.draft.world?.title === "string" ? state.draft.world.title : "";
  const parsed = parseEditableWorldDraft(preview.content);
  const draft = canonicalDraft(parsed);
  draft.world.title = preview.title;
  return {
    ...state,
    method: "ai",
    draft,
    provenance: "ai",
    status: "unsaved",
    navigationDirty: true,
    pendingRemovals: [],
    generationReplacement: {
      replacedLocalDraft: hasLocalDraftContent(state),
      previousTitle,
      generatedTitle: preview.title
    },
    creationError: null
  };
}

export function beginCreation(state: WorldCreationState): WorldCreationState {
  return {
    ...state,
    draft: canonicalDraft(state.draft),
    status: "creating",
    navigationDirty: true,
    creationError: null
  };
}

export function completeCreation(state: WorldCreationState): WorldCreationState {
  return {
    ...state,
    draft: canonicalDraft(state.draft),
    status: "created",
    navigationDirty: false,
    pendingRemovals: [],
    creationError: null
  };
}

export function failCreation(
  state: WorldCreationState,
  kind: string,
  message: string
): WorldCreationState {
  return {
    ...state,
    draft: canonicalDraft(state.draft),
    status: "error",
    navigationDirty: true,
    creationError: { kind, message }
  };
}
