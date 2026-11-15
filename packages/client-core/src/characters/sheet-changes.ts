import { castEvidenceOrder, castFieldSchema, observationDecisionRequestSchema, stateEditReplacement,
  type CampaignCharacterProfile, type CampaignCharacterProfileUpdate, type CastBoundary, type CastDetail, type CastField,
  type EditAuthoredCastProfile, type EditCastCharacter, type ObservationDecisionRequest } from "@infinite-quest/contracts";
import { changeCastEditor, createCastEditor, prepareCastSubmission, setCastEditorField } from "../campaign-cast-editor.js";
import { buildPresetRequest, changePresetField, createPresetDraft, presetField } from "./preset-editor.js";
import { CHARACTER_FIELD_DESCRIPTORS, buildProfileUpdate, createProfileDraft, seededCharacterFieldPolicy, setProfileDraftField } from "./profile-fields.js";
import { activeRetractedIds, type CharacterField } from "./sheet.js";

export type SheetChange = { kind: "field"; path: string; value: string | string[] | null } | { kind: "toggle"; key: "pinned" | "ignored"; value: boolean };
export type SheetRequest = { endpoint: "edit"; body: EditCastCharacter } | { endpoint: "editAuthoredProfile"; body: EditAuthoredCastProfile } | { endpoint: "profile"; body: CampaignCharacterProfileUpdate };
export type SheetTarget = { kind: "cast"; detail: CastDetail } | { kind: "main"; profile: CampaignCharacterProfile & { revision: number } };
export type SheetWriteFence = { kind: "cast"; revision: number; characterRevision: number; boundary: CastBoundary } | { kind: "main"; revision: number };
export type SheetUndo = { kind: "restoreValue"; path: string; value: string | string[] } | { kind: "restoreOverride"; path: CastField; value: string | null } | { kind: "restoreAuthored"; path: string; value: string | string[] | null } | { kind: "toggle"; key: "pinned" | "ignored"; value: boolean };

function identityValue(path: string, value: string | string[] | null): string | string[] {
  if (value === null || (path === "name" ? typeof value !== "string" : !Array.isArray(value))) throw new Error("Invalid identity value.");
  return value;
}
function readValue(profile: CampaignCharacterProfile, path: string): string | string[] {
  const [part, key] = path.split(".");
  const value = key ? (profile.profile as unknown as Record<string, Record<string, unknown>>)[part!]?.[key] : part === "name" ? profile.name : (profile.profile as unknown as Record<string, unknown>)[part!];
  if (typeof value !== "string" && !Array.isArray(value)) throw new Error("Invalid profile field.");
  return Array.isArray(value) ? [...value] : value;
}
export function sheetRequest(target: SheetTarget, change: SheetChange, idempotencyKey: string): SheetRequest {
  if (target.kind === "main") {
    if (change.kind !== "field" || change.value === null) throw new Error("Invalid Main Character change.");
    const { revision, name, profile } = target.profile;
    return { endpoint: "profile", body: buildProfileUpdate(setProfileDraftField(createProfileDraft({ name, profile }), change.path, change.value), revision) };
  }
  const detail = target.detail;
  if (detail.character.originProfile) {
    const draft = createPresetDraft(detail);
    if (change.kind === "toggle") draft[change.key] = change.value;
    else {
      const policy = seededCharacterFieldPolicy(change.path);
      if (policy === "unknown") throw new Error("Invalid field.");
      if (policy === "identity") changePresetField(draft, change.path, identityValue(change.path, change.value));
      else if (change.value === null) changePresetField(draft, change.path, presetField(detail, change.path).effective, policy === "fixed" ? "reset" : "discover");
      else changePresetField(draft, change.path, change.value, policy === "observed" && change.value === "" ? "hide" : undefined);
    }
    return { endpoint: "editAuthoredProfile", body: buildPresetRequest(draft, idempotencyKey) };
  }
  let draft = createCastEditor({ revision: detail.revision, boundary: detail.boundary }, detail);
  if (change.kind === "toggle") draft = changeCastEditor(draft, { [change.key]: change.value });
  else if (change.path === "name" || change.path === "identity.aliases") {
    const value = identityValue(change.path, change.value);
    draft = changeCastEditor(draft, change.path === "name" ? { name: value as string } : { aliases: value as string[] });
  } else {
    const field = castFieldSchema.parse(change.path);
    if (Array.isArray(change.value)) throw new Error("Invalid field value.");
    draft = setCastEditorField(draft, field, change.value);
  }
  return { endpoint: "edit", body: prepareCastSubmission(draft, idempotencyKey).submission as EditCastCharacter };
}
export function sheetUndoOperation(before: SheetTarget, change: SheetChange): SheetUndo {
  if (change.kind === "toggle") {
    if (before.kind !== "cast") throw new Error("Invalid Main Character change.");
    return { kind: "toggle", key: change.key, value: before.detail.character[change.key] };
  }
  if (before.kind === "main") return { kind: "restoreValue", path: change.path, value: readValue(before.profile, change.path) };
  const d = before.detail;
  if (change.path === "name" || change.path === "identity.aliases") return { kind: "restoreValue", path: change.path, value: change.path === "name" ? d.character.name : [...d.character.aliases] };
  if (d.character.originProfile && seededCharacterFieldPolicy(change.path) === "fixed") {
    const source = d.character.fieldSources?.[change.path as keyof NonNullable<typeof d.character.fieldSources>];
    let value: string | string[] | null;
    if (source !== undefined) value = source === "campaign_edit" ? presetField(d, change.path).effective : null;
    else {
      if (!d.authoredHistory) throw new Error("The prior authored field source is unavailable.");
      const event = [...d.authoredHistory].reverse().find(item => item.seedEventId === d.character.originProfile!.seedEventId &&
        (Object.hasOwn(item.set, change.path) || item.reset.some(path => path === change.path)));
      value = event ? (event.set as Record<string, string | string[]>)[change.path] ?? null : null;
    }
    return { kind: "restoreAuthored", path: change.path, value: Array.isArray(value) ? [...value] : value };
  }
  const path = castFieldSchema.parse(change.path), edit = d.overrides.find(item => item.field === path);
  const history = [...d.observations, ...(d.retractedObservationHistory ?? [])];
  return { kind: "restoreOverride", path, value: edit && !stateEditReplacement(edit, history, activeRetractedIds(d)) ? edit.value : null };
}
export function sheetMatchesFence(target: SheetTarget, fence: SheetWriteFence): boolean {
  if (target.kind === "main" && fence.kind === "main") return target.profile.revision === fence.revision;
  if (target.kind !== "cast" || fence.kind !== "cast") return false;
  return target.detail.revision === fence.revision && target.detail.character.revision === fence.characterRevision && target.detail.boundary.turnNumber === fence.boundary.turnNumber && target.detail.boundary.timelineRevision === fence.boundary.timelineRevision;
}
export function sheetUndoRequest(target: SheetTarget, undo: SheetUndo, fence: SheetWriteFence, idempotencyKey: string): SheetRequest {
  if (!sheetMatchesFence(target, fence)) throw new Error("The character changed since this write.");
  return sheetRequest(target, undo.kind === "toggle" ? undo : { kind: "field", path: undo.path, value: undo.value }, idempotencyKey);
}
export type ConflictChoice = { value: string; observationIds: string[]; latestTurn: number | null; quote: string | null; retractableObservationId: string | null };
export function conflictChoices(field: CharacterField): ConflictChoice[] {
  const facts = field.observations.filter(item => item.mode === "fact" && !(item.evidence.kind === "turn" && item.evidence.invalidated));
  const superseded = new Set(field.observations.map(item => item.supersedesObservationId).filter(Boolean));
  const groups = new Map<string, typeof facts>();
  for (const fact of facts) if (!superseded.has(fact.id)) groups.set(fact.value, [...(groups.get(fact.value) ?? []), fact]);
  return [...groups.entries()].map(([value, items]) => {
    const ordered = [...items].sort((a, b) => { const x = castEvidenceOrder(a.evidence), y = castEvidenceOrder(b.evidence); return y[0] - x[0] || y[1] - x[1]; });
    const latest = ordered[0]!;
    return { value, observationIds: items.map(item => item.id), latestTurn: latest.evidence.kind === "turn" ? latest.evidence.turnNumber : null, quote: latest.evidence.kind === "turn" ? latest.evidence.quote : null, retractableObservationId: ordered.find(item => field.retractableObservationIds.includes(item.id))?.id ?? null };
  }).sort((a, b) => (b.latestTurn ?? 0) - (a.latestTurn ?? 0));
}
export function retractionRequest(detail: CastDetail, observationId: string, idempotencyKey: string): ObservationDecisionRequest {
  void observationId; // The observation ID identifies the endpoint, not the request body.
  return observationDecisionRequestSchema.parse({ action: "retract", expectedCastRevision: detail.revision, expectedCharacterRevision: detail.character.revision, expectedBoundary: detail.boundary, idempotencyKey });
}
export function clearEditLabel(field: CharacterField, kind: "plain" | "startingCast"): "Use story value" | "Use discovered value" | "Reset to world" | "Clear my edit" {
  if (kind === "startingCast" && seededCharacterFieldPolicy(field.path) === "fixed") return "Reset to world";
  // Without a fact to fall back to, clearing only empties the field; say so.
  if (!field.observations.some(item => item.mode === "fact")) return "Clear my edit";
  return seededCharacterFieldPolicy(field.path) === "updating" ? "Use story value" : "Use discovered value";
}
/** Feedback for a saved field or toggle. Toggles read as their new state, not their storage key. */
export function sheetSavedMessage(change: SheetChange, fieldLabel: string): string {
  if (change.kind === "field") return `Saved ${fieldLabel}.`;
  if (change.key === "pinned") return change.value ? "Pinned." : "Unpinned.";
  return change.value ? "Ignored." : "No longer ignored.";
}
/** Character limit the server accepts for a campaign edit (override) of a cast field. */
export function castOverrideLimit(path: string): number {
  const descriptor = CHARACTER_FIELD_DESCRIPTORS.find(item => item.path === path);
  return path === "story.goals" ? descriptor?.maxLength ?? 20_000 : Math.min(descriptor?.maxLength ?? 2_000, 2_000);
}
/** Limits for a sheet field on its write path. List limits apply per entry. */
export function sheetFieldLimit(target: SheetTarget | null, path: string): { maxLength: number; maxItems?: number } {
  const descriptor = CHARACTER_FIELD_DESCRIPTORS.find(item => item.path === path);
  const base = { maxLength: descriptor?.maxLength ?? 2_000, ...(descriptor?.maxItems ? { maxItems: descriptor.maxItems } : {}) };
  if (!target || target.kind === "main" || path === "name" || path === "identity.aliases") return base;
  if (target.detail.character.originProfile && seededCharacterFieldPolicy(path) === "fixed") return base;
  return { ...base, maxLength: castOverrideLimit(path) };
}
