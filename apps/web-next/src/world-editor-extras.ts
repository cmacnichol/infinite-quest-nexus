import type { EditableWorldDraft, WorldOverview } from "./world-editor-model";

const ROOT_DRAFT_FIELDS = new Set([
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

const WORLD_FIELDS = new Set([
  "title",
  "genre",
  "tone",
  "premise",
  "backgroundStory",
  "firstAction",
  "rules"
]);

function clone<T>(value: T): T {
  return typeof structuredClone === "function"
    ? structuredClone(value)
    : JSON.parse(JSON.stringify(value)) as T;
}

function propertiesExcept(value: Record<string, unknown>, excluded: ReadonlySet<string>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !excluded.has(key))
    .map(([key, property]) => [key, clone(property)]));
}

export function rootDraftExtras(draft: EditableWorldDraft): Record<string, unknown> {
  return propertiesExcept(draft, ROOT_DRAFT_FIELDS);
}

export function worldExtras(draft: EditableWorldDraft): Record<string, unknown> {
  return propertiesExcept(draft.world, WORLD_FIELDS);
}

export function mergeRootDraftExtras(
  draft: EditableWorldDraft,
  extras: Record<string, unknown>
): EditableWorldDraft {
  const known = Object.fromEntries(Object.entries(draft).filter(([key]) => ROOT_DRAFT_FIELDS.has(key)));
  return clone({ ...propertiesExcept(extras, ROOT_DRAFT_FIELDS), ...known }) as EditableWorldDraft;
}

export function mergeWorldExtras(
  draft: EditableWorldDraft,
  extras: Record<string, unknown>
): EditableWorldDraft {
  const known = Object.fromEntries(Object.entries(draft.world).filter(([key]) => WORLD_FIELDS.has(key)));
  return {
    ...clone(draft),
    world: clone({ ...propertiesExcept(extras, WORLD_FIELDS), ...known }) as WorldOverview
  };
}
