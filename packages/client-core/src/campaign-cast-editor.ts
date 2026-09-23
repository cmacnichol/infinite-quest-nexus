import { createCastCharacterSchema, editCastCharacterSchema, type CastBoundary, type CastDetail,
  type CastField, type CastProfile, type CreateCastCharacter, type EditCastCharacter } from "@infinite-quest/contracts";

export type CastEditorDraft = { name: string; aliases: string[]; profile: CastProfile; pinned: boolean; ignored: boolean };
export type CastEditorState = {
  characterId: string | null; draft: CastEditorDraft; dirty: boolean; saving: boolean; conflict: boolean; error: string | null;
  authority: { revision: number; boundary: CastBoundary }; loaded: CastDetail | null;
  changes: Partial<CastEditorDraft>; setOverrides: CastProfile; clearOverrides: CastField[];
  submission: CreateCastCharacter | EditCastCharacter | null;
};
export function createCastEditor(authority: CastEditorState["authority"], detail: CastDetail | null = null): CastEditorState {
  return { characterId: detail?.character.id ?? null, authority, loaded: detail,
    draft: detail ? { name: detail.character.name, aliases: [...detail.character.aliases], profile: { ...detail.character.profile },
      pinned: detail.character.pinned, ignored: detail.character.ignored } : { name: "", aliases: [], profile: {}, pinned: false, ignored: false },
    dirty: false, saving: false, conflict: false, error: null, changes: {}, setOverrides: {}, clearOverrides: [], submission: null };
}
export function canSaveCastEditor(state: Pick<CastEditorState, "draft" | "dirty" | "saving" | "conflict">): boolean {
  return Boolean(state.draft.name.trim()) && state.dirty && !state.saving && !state.conflict;
}
export function changeCastEditor(state: CastEditorState, changes: Partial<Omit<CastEditorDraft, "profile">>): CastEditorState {
  return { ...state, draft: { ...state.draft, ...changes }, changes: { ...state.changes, ...changes }, dirty: true, submission: null, error: null };
}
export function setCastEditorField(state: CastEditorState, field: CastField, value: string | null): CastEditorState {
  const setOverrides = { ...state.setOverrides }, profile = { ...state.draft.profile };
  const clearOverrides = state.clearOverrides.filter((item) => item !== field);
  if (value === null) { delete setOverrides[field]; delete profile[field]; clearOverrides.push(field); }
  else { setOverrides[field] = value; profile[field] = value; }
  return { ...state, setOverrides, clearOverrides, draft: { ...state.draft, profile }, dirty: true, submission: null, error: null };
}
export function prepareCastSubmission(state: CastEditorState, idempotencyKey: string): CastEditorState {
  if (!canSaveCastEditor(state)) throw new Error("This character draft cannot be saved yet.");
  const base = { expectedCastRevision: state.authority.revision, expectedBoundary: state.authority.boundary, idempotencyKey };
  const submission = state.submission ?? (state.characterId ? editCastCharacterSchema.parse({ ...base,
    expectedCharacterRevision: state.loaded!.character.revision, ...state.changes,
    ...(Object.keys(state.setOverrides).length ? { setOverrides: state.setOverrides } : {}),
    ...(state.clearOverrides.length ? { clearOverrides: state.clearOverrides } : {}) })
    : createCastCharacterSchema.parse({ ...base, name: state.draft.name, aliases: state.draft.aliases, profile: state.draft.profile }));
  return { ...state, submission, saving: true, error: null };
}
export function failCastSubmission(state: CastEditorState, error: string, conflict: boolean): CastEditorState {
  return { ...state, saving: false, error, conflict };
}
export function reapplyNewCastDraft(state: CastEditorState, authority: CastEditorState["authority"]): CastEditorState {
  if (state.characterId) throw new Error("An existing character requires its latest detail before reapplication.");
  return { ...state, authority, conflict: false, error: null, saving: false, submission: null };
}
/** Explicit user action: keep only the touched values, using freshly compared server authority. */
export function reapplyCastDraft(state: CastEditorState, latest: CastDetail): CastEditorState {
  let next = changeCastEditor(createCastEditor(latest, latest), state.changes);
  for (const [field, value] of Object.entries(state.setOverrides)) next = setCastEditorField(next, field as CastField, value);
  for (const field of state.clearOverrides) next = setCastEditorField(next, field, null);
  return next;
}
