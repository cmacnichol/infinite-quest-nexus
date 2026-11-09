import { characterProfileSchema, editAuthoredCastProfileSchema, type CastDetail, type CastField, type EditAuthoredCastProfile } from "@infinite-quest/contracts";
import { createEditorDraft, setEditorDraftField } from "./editor-model.js";
import { CHARACTER_FIELD_DESCRIPTORS, seededCharacterFieldPolicy } from "./profile-fields.js";

export function castNarratorNotice(state: import("@infinite-quest/contracts").CastNarratorState | undefined, campaign: string) {
  const settings = "/app/settings?section=";
  if (state === "installation_disabled") return { text: "These characters will be tracked, but won't reach the narrator until character context is enabled. An instance administrator can enable this.", href: settings + "characters", label: "Character settings" };
  if (state === "enrollment_missing") return { text: "Enable Story Memory for this campaign to include these characters in narrator context.", href: settings + "campaign&campaignId=" + encodeURIComponent(campaign), label: "Story Memory settings" };
  if (state === "capability_insufficient") return { text: "The installed Story Memory capability is below this campaign’s enrolled level. An instance administrator can enable this.", href: settings + "characters", label: "Character settings" };
  if (state === "discovery_off") return { text: "Character discovery is off. The narrator receives authored fields and last-known story details.", href: "", label: "" };
  return null;
}

export const presetFields = CHARACTER_FIELD_DESCRIPTORS.map(field =>
  field.path === "appearance.description" ? { ...field, label: "Observed in story" } : field);
type Value = string | string[];
type Action = "reset" | "discover" | "restore" | "hide";
function read(profile: object | undefined, path: string): Value {
  const value = path.split(".").reduce<unknown>((part, key) => part && typeof part === "object" ? (part as Record<string, unknown>)[key] : undefined, profile);
  return typeof value === "string" || Array.isArray(value) ? value : "";
}
export function presetField(detail: CastDetail, path: string) {
  const person = detail.character, seed = person.originProfile!;
  const policy = seededCharacterFieldPolicy(path);
  const original = path === "name" ? seed.rosterName : path === "identity.aliases" ? seed.rosterAliases : read(seed.profile, path);
  const source = person.fieldSources?.[path as keyof typeof person.fieldSources];
  const effective = path === "name" ? person.name : path === "identity.aliases" ? person.aliases :
    person.profile[path as CastField] ?? read(person.campaignProfile, path);
  const changed = JSON.stringify(original) !== JSON.stringify(effective);
  const facts = detail.observations.filter(item => item.field === path && !(item.evidence.kind === "turn" && item.evidence.invalidated));
  const active = facts.filter(item => !facts.some(newer => newer.supersedesObservationId === item.id));
  const attention = !effective.length && active.length > 0 && (active.every(item => item.mode === "claim") || new Set(active.filter(item => item.mode === "fact").map(item => item.value)).size > 1);
  let badge: string;
  if (policy === "identity") badge = changed ? "Edited for this campaign" : "World canon";
  else if (policy === "updating" || policy === "observed") badge = source === "override" ? "Your edit" : policy === "observed" ? "Observed in story" : "Updates with story";
  else badge = source === "campaign_edit" ? original.length ? "Edited for this campaign" : "Added for this campaign"
    : source === "authored" ? "World canon" : source === "observation" ? "From story" : attention ? "Needs attention" : "";
  return { original, effective, policy, badge, differs: policy === "fixed" && Boolean(original.length) && active.some(item => item.value !== effective) };
}

export function createPresetDraft(detail: CastDetail) {
  const person = detail.character;
  const profile = characterProfileSchema.parse(person.campaignProfile);
  profile.identity.aliases = [...person.aliases];
  const record = { name: person.name, profile, state: {} };
  for (const field of presetFields) {
    const [section, key] = field.path.split(".");
    if (!key) continue;
    const target = section === "state" ? record.state : profile[section!];
    if (target && typeof target === "object") (target as Record<string, unknown>)[key] = presetField(detail, field.path).effective;
  }
  const draft = createEditorDraft("campaign-preset", record);
  return { detail, draft, actions: new Map<string, Action>(), changes: new Set<string>(), pinned: detail.character.pinned, ignored: detail.character.ignored };
}
export type PresetDraft = ReturnType<typeof createPresetDraft>;
export function changePresetField(state: PresetDraft, path: string, value: Value, action?: Action) {
  state.draft = setEditorDraftField(state.draft, path, value);
  if (action) state.actions.set(path, action); else state.actions.delete(path);
  if (action || JSON.stringify(value) !== JSON.stringify(presetField(state.detail, path).effective)) state.changes.add(path);
  else state.changes.delete(path);
}
export function buildPresetRequest(state: PresetDraft, key: string): EditAuthoredCastProfile {
  const detail = state.detail;
  const request: EditAuthoredCastProfile = { idempotencyKey: key, expectedCastRevision: detail.revision,
    expectedCharacterRevision: detail.character.revision, expectedBoundary: detail.boundary };
  for (const path of state.changes) {
    const action = state.actions.get(path), value = state.draft.values[path]!, policy = seededCharacterFieldPolicy(path);
    if (policy === "identity" && action === "reset") request.resetIdentity = true;
    else if (path === "name") request.name = value as string;
    else if (path === "identity.aliases") request.aliases = value as string[];
    else if (action === "restore") request.restoreAuthoredGoals = true;
    else if (policy === "fixed") {
      const field = path as keyof NonNullable<typeof request.set>;
      if (action === "reset" || !value.length) (request.reset ??= []).push(field);
      else (request.set ??= {})[field] = value;
    } else if (action === "discover" || (!value.length && action !== "hide")) (request.clearOverrides ??= []).push(path as CastField);
    else (request.setOverrides ??= {})[path as CastField] = value as string;
  }
  if (request.resetIdentity) { delete request.name; delete request.aliases; }
  if (detail.character.pinned !== state.pinned) request.pinned = state.pinned;
  if (detail.character.ignored !== state.ignored) request.ignored = state.ignored;
  return editAuthoredCastProfileSchema.parse(request);
}
