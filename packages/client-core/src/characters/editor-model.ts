import { changeCastEditor, prepareCastSubmission, setCastEditorField, type CastEditorState } from "../campaign-cast-editor.js";
import type { CastField } from "@infinite-quest/contracts";
import { PROFILE_FIELDS, SUPPORTING_FIELDS, type ProfileFieldDescriptor } from "./profile-fields.js";

export type CharacterEditorContext = "world-draft" | "campaign-main" | "campaign-preset" | "campaign-supporting";
export type EditorValue = string | string[];
export type EditorRecord = Record<string, unknown>;
export type CharacterEditorDraft = {
  context: CharacterEditorContext;
  loaded: EditorRecord;
  values: Record<string, EditorValue>;
  changedPaths: string[];
  acceptedOrganize: { protocolVersion: string; paths: string[]; previousValues: Record<string, EditorValue> } | null;
  stagedOrganize: Record<string, { protocolVersion: string; previousValue: EditorValue; order: number }>;
  conflict: boolean;
};

const descriptors = (context: CharacterEditorContext): readonly ProfileFieldDescriptor[] => {
  if (context === "campaign-supporting") return [PROFILE_FIELDS[0]!, PROFILE_FIELDS[1]!, ...SUPPORTING_FIELDS];
  if (context === "campaign-preset") return [...PROFILE_FIELDS, ...SUPPORTING_FIELDS.filter((field) => field.path.startsWith("state.") || field.path === "appearance.description")];
  return PROFILE_FIELDS;
};
function copy<T>(value: T): T {
  if (Array.isArray(value)) return value.map(copy) as T;
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, copy(item)])) as T;
  return value;
}
function readPath(record: EditorRecord, path: string): unknown {
  return path.split(".").reduce<unknown>((value, key) => value && typeof value === "object" ? (value as EditorRecord)[key] : undefined, record);
}
function writePath(record: EditorRecord, path: string, value: unknown): void {
  const parts = path.split(".");
  let target = record;
  for (const part of parts.slice(0, -1)) {
    const current = target[part];
    target[part] = current && typeof current === "object" && !Array.isArray(current) ? { ...current } : {};
    target = target[part] as EditorRecord;
  }
  target[parts[parts.length - 1]!] = copy(value);
}
function storagePath(context: CharacterEditorContext, path: string): string {
  return path === "name" || path.startsWith("state.") || context === "campaign-supporting" ? path : `profile.${path}`;
}
function loadedValue(context: CharacterEditorContext, record: EditorRecord, field: ProfileFieldDescriptor): EditorValue {
  let value: unknown;
  if (context !== "campaign-supporting") value = readPath(record, storagePath(context, field.path));
  else if (field.path === "name") value = record.name;
  else if (field.path === "identity.aliases") value = record.aliases;
  else value = (record.profile as EditorRecord | undefined)?.[field.path];
  if (field.input === "list") return Array.isArray(value) ? [...value] : [];
  return typeof value === "string" ? value : "";
}
function summarizeOrganize(staged: CharacterEditorDraft["stagedOrganize"]): CharacterEditorDraft["acceptedOrganize"] {
  const entries = Object.entries(staged);
  if (!entries.length) return null;
  const newest = entries.reduce((a, b) => a[1].order > b[1].order ? a : b);
  return { protocolVersion: newest[1].protocolVersion, paths: entries.map(([path]) => path),
    previousValues: Object.fromEntries(entries.map(([path, entry]) => [path, copy(entry.previousValue)])) };
}
export function createEditorDraft(context: CharacterEditorContext, loaded: object): CharacterEditorDraft {
  const record = loaded as EditorRecord;
  const values = Object.fromEntries(descriptors(context).map((field) => [field.path, loadedValue(context, record, field)]));
  return { context, loaded: copy(record), values, changedPaths: [], acceptedOrganize: null, stagedOrganize: {}, conflict: false };
}
export function setEditorDraftField(draft: CharacterEditorDraft, path: string, value: EditorValue): CharacterEditorDraft {
  const descriptor = descriptors(draft.context).find((field) => field.path === path);
  if (!descriptor || (descriptor.input === "list") !== Array.isArray(value)) throw new Error("Invalid editor field or value.");
  if (JSON.stringify(value) === JSON.stringify(draft.values[path])) return draft;
  const values = { ...draft.values, [path]: copy(value) };
  const initial = loadedValue(draft.context, draft.loaded, descriptor);
  const changedPaths = JSON.stringify(value) === JSON.stringify(initial) ? draft.changedPaths.filter((item) => item !== path) : draft.changedPaths.includes(path) ? draft.changedPaths : [...draft.changedPaths, path];
  const stagedOrganize = { ...draft.stagedOrganize };
  delete stagedOrganize[path];
  return { ...draft, values, changedPaths, stagedOrganize, acceptedOrganize: summarizeOrganize(stagedOrganize) };
}
export function stageEditorOrganize(draft: CharacterEditorDraft, values: Record<string, EditorValue>, protocolVersion: string): CharacterEditorDraft {
  if (!protocolVersion.trim()) throw new Error("Organizer protocol version is required.");
  let next = draft;
  let order = Math.max(0, ...Object.values(draft.stagedOrganize).map((entry) => entry.order));
  for (const [path, value] of Object.entries(values)) {
    if (JSON.stringify(value) === JSON.stringify(next.values[path])) continue;
    const previousValue = copy(next.stagedOrganize[path]?.previousValue ?? next.values[path]!);
    next = setEditorDraftField(next, path, value);
    if (next.changedPaths.includes(path)) {
      const stagedOrganize = { ...next.stagedOrganize, [path]: { protocolVersion, previousValue, order: ++order } };
      next = { ...next, stagedOrganize, acceptedOrganize: summarizeOrganize(stagedOrganize) };
    }
  }
  if (draft.context === "campaign-main" && new Set(Object.values(next.stagedOrganize).map((entry) => entry.protocolVersion)).size > 1) {
    throw new Error("Save the earlier reviewed fields before applying a new organizer version.");
  }
  return next;
}
export function discardEditorOrganize(draft: CharacterEditorDraft): CharacterEditorDraft {
  if (!draft.acceptedOrganize) return draft;
  let next = draft;
  for (const path of draft.acceptedOrganize.paths) next = setEditorDraftField(next, path, draft.acceptedOrganize.previousValues[path]!);
  return { ...next, acceptedOrganize: null, stagedOrganize: {} };
}
export function markEditorConflict(draft: CharacterEditorDraft): CharacterEditorDraft {
  return { ...draft, conflict: true };
}
export function reapplyEditorDraft(draft: CharacterEditorDraft, latest: object): CharacterEditorDraft {
  let next = createEditorDraft(draft.context, latest);
  for (const path of draft.changedPaths) next = setEditorDraftField(next, path, draft.values[path]!);
  const latestValues = createEditorDraft(draft.context, latest).values;
  const stagedOrganize = Object.fromEntries(Object.entries(draft.stagedOrganize)
    .filter(([path]) => next.changedPaths.includes(path))
    .map(([path, entry]) => [path, { ...entry, previousValue: latestValues[path]! }]));
  return { ...next, stagedOrganize, acceptedOrganize: summarizeOrganize(stagedOrganize), conflict: false };
}
/** Project current profile fields without constructing an API request. */
export function projectEditorProfile(draft: CharacterEditorDraft): EditorRecord {
  if (draft.context === "campaign-supporting") throw new Error("Supporting characters use cast overrides.");
  const result = copy(draft.loaded);
  for (const path of draft.changedPaths) writePath(result, storagePath(draft.context, path), draft.values[path]);
  return (result.profile ?? {}) as EditorRecord;
}
/** Build the full profile required by the existing campaign API, preserving untouched extensions. */
/** Local draft delta only; phase 3 supplies the authority and command adapter. */
export type CampaignPresetEditorDelta = { changes: Record<string, EditorValue> };
export type EditorPayloadOptions = { expectedRevision?: number; idempotencyKey?: string; castEditor?: CastEditorState };
export function buildEditorPayload(draft: CharacterEditorDraft & { context: "campaign-preset" }, options?: EditorPayloadOptions): CampaignPresetEditorDelta;
export function buildEditorPayload(draft: CharacterEditorDraft, options?: EditorPayloadOptions): EditorRecord;
export function buildEditorPayload(draft: CharacterEditorDraft, options: EditorPayloadOptions = {}): EditorRecord {
  if (draft.context === "campaign-supporting") {
    if (!options.castEditor || !options.idempotencyKey) throw new Error("Cast authority and an idempotency key are required.");
    let state = options.castEditor;
    for (const path of draft.changedPaths) {
      const value = draft.values[path]!;
      if (path === "name") state = changeCastEditor(state, { name: value as string });
      else if (path === "identity.aliases") state = changeCastEditor(state, { aliases: value as string[] });
      else state = setCastEditorField(state, path as CastField, value as string);
    }
    return prepareCastSubmission(state, options.idempotencyKey).submission as EditorRecord;
  }
  if (draft.context === "campaign-preset") {
    const delta: CampaignPresetEditorDelta = { changes: Object.fromEntries(draft.changedPaths.map((path) => [path, copy(draft.values[path]!)])) };
    return delta;
  }
  const result = copy(draft.loaded);
  for (const path of draft.changedPaths) writePath(result, storagePath(draft.context, path), draft.values[path]);

  if (draft.context === "campaign-main") {
    if (!Number.isInteger(options.expectedRevision) || options.expectedRevision! < 0) throw new Error("A campaign revision is required.");
    return { name: result.name, profile: result.profile, expectedRevision: options.expectedRevision,
      editSource: draft.acceptedOrganize?.paths.some((path) => draft.changedPaths.includes(path)) ? "ai_organized" : "manual",
      ...(draft.acceptedOrganize?.paths.some((path) => draft.changedPaths.includes(path)) ? { organizerProtocolVersion: draft.acceptedOrganize.protocolVersion } : {}) };
  }

  return result;
}
