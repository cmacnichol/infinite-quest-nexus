import { castEvidenceOrder, isCastStateField, stateEditReplacement, type CampaignCharacterProfile, type CastDetail, type CastEvidence, type CastObservation, type CastOverride } from "@infinite-quest/contracts";
import { PROFILE_FIELDS, SUPPORTING_FIELDS, seededCharacterFieldPolicy, type CharacterSectionName } from "./profile-fields.js";
import { presetField, presetFields } from "./preset-editor.js";

export type CharacterRecord = { kind: "protagonist"; profile: CampaignCharacterProfile; revision: number } | { kind: "supporting"; detail: CastDetail };
export type CharacterField = { path: string; label: string; value: string | string[] | null; origin: "unknown" | "observed" | "claim" | "user" | "conflicted"; observations: CastObservation[]; override?: CastOverride;
  editTurn: number | null; observedTurn: number | null; replacedEditTurn: number | null; storyDiffers: { value: string; turn: number } | null; retractable: CastObservation | null; retractableObservationIds: string[] };
/** `locks` lists field paths held by a manual correction; automatic evidence cannot replace them. */
export type CharacterSheet = { name: string; kind: CharacterRecord["kind"]; sections: { name: CharacterSectionName; fields: CharacterField[] }[]; sources: CastEvidence[]; locks: string[]; attention: string[] };
export function activeRetractedIds(detail: CastDetail): ReadonlySet<string> {
  return new Set((detail.observationDecisionStatus ?? []).filter(item => item.state === "retracted").map(item => item.observationId));
}
const valid = (item: CastObservation) => !(item.evidence.kind === "turn" && item.evidence.invalidated);
const compare = (a: CastObservation, b: CastObservation) => {
  const x = castEvidenceOrder(a.evidence), y = castEvidenceOrder(b.evidence);
  return x[0] - y[0] || x[1] - y[1];
};
export function buildCharacterSheet(record: CharacterRecord): CharacterSheet {
  const detail = record.kind === "supporting" ? record.detail : null;
  const seeded = Boolean(detail?.character.originProfile);
  const descriptors = record.kind === "protagonist" ? PROFILE_FIELDS : seeded ? presetFields : SUPPORTING_FIELDS;
  const sections: CharacterSheet["sections"] = [];
  const observations = detail?.observations ?? [];
  const history = [...new Map([...observations, ...(detail?.retractedObservationHistory ?? [])].filter(valid).map(item => [item.id, item])).values()];
  const retracted = detail ? activeRetractedIds(detail) : new Set<string>();
  const superseded = new Set(history.map(item => item.supersedesObservationId).filter((id): id is string => id !== null));
  const eligible = new Set((detail?.observationDecisionStatus ?? []).filter(item => item.state === "eligible").map(item => item.observationId));
  for (const descriptor of descriptors) {
    const relevant = history.filter(item => item.field === descriptor.path && !retracted.has(item.id) && !superseded.has(item.id));
    const facts = relevant.filter(item => item.mode === "fact").sort(compare);
    let value: string | string[] | null = null;
    let origin: CharacterField["origin"] = "unknown";
    let override: CastOverride | undefined;
    let editTurn: number | null = null, observedTurn: number | null = null, replacedEditTurn: number | null = null;
    let storyDiffers: CharacterField["storyDiffers"] = null, retractable: CastObservation | null = null;
    let retractableObservationIds: string[] = [];
    if (record.kind === "protagonist") {
      const [part, key] = descriptor.path.split(".");
      const raw = key ? (record.profile.profile as unknown as Record<string, Record<string, unknown>>)[part!]?.[key] : part === "name" ? record.profile.name : (record.profile.profile as unknown as Record<string, unknown>)[part!];
      if (typeof raw === "string" || Array.isArray(raw)) { value = raw as string | string[]; if (raw.length) origin = "user"; }
    } else {
      const d = record.detail;
      override = d.overrides.find(item => item.field === descriptor.path);
      const replacement = override ? stateEditReplacement(override, history, retracted) : null;
      const editInForce = Boolean(override && !replacement);
      const preset = seeded ? presetField(d, descriptor.path) : null;
      const projected = d.character.profile[descriptor.path as keyof typeof d.character.profile];
      const source = d.character.fieldSources?.[descriptor.path as keyof typeof d.character.fieldSources];
      if (editInForce) { value = override!.value; origin = "user"; editTurn = override!.evidence.kind === "user" ? override!.evidence.effectiveTurnNumber : null; }
      else if (preset) {
        value = preset.effective;
        if (source === "campaign_edit" || preset.policy === "identity" && preset.badge === "Edited for this campaign") {
          origin = "user";
          editTurn = preset.policy === "identity" ? Math.max(-1, ...d.identityEvents.map(event => event.effectiveTurnNumber)) === -1 ? null : Math.max(...d.identityEvents.map(event => event.effectiveTurnNumber)) : (d.authoredHistory ?? []).filter(event => descriptor.path in event.set || event.reset.includes(descriptor.path as never)).at(-1)?.effectiveTurnNumber ?? null;
        } else if (source === "observation") origin = "observed";
        else if (value?.length) origin = "user";
        else if (new Set(facts.map(item => item.value)).size > 1) origin = "conflicted";
        else if (relevant.some(item => item.mode === "claim")) origin = "claim";
      } else if (projected !== undefined) { value = projected; origin = "observed"; }
      else if (new Set(facts.map(item => item.value)).size > 1) origin = "conflicted";
      else if (relevant.some(item => item.mode === "claim")) origin = "claim";
      if (replacement && override?.evidence.kind === "user") replacedEditTurn = override.evidence.effectiveTurnNumber;
      const supplying = origin === "observed" ? facts.filter(item => item.value === value).at(-1) : undefined;
      observedTurn = supplying?.evidence.kind === "turn" ? supplying.evidence.turnNumber : null;
      retractableObservationIds = facts.filter(item => eligible.has(item.id)).map(item => item.id);
      if (supplying && eligible.has(supplying.id)) retractable = supplying;
      if (editInForce && override && !isCastStateField(descriptor.path) && (!seeded || seededCharacterFieldPolicy(descriptor.path) !== "fixed") && editTurn !== null) {
        const differing = facts.filter(item => item.value !== value && item.evidence.kind === "turn" && item.evidence.turnNumber > editTurn!).at(-1);
        if (differing?.evidence.kind === "turn") storyDiffers = { value: differing.value, turn: differing.evidence.turnNumber };
      }
    }
    let section = sections.find(item => item.name === descriptor.section);
    if (!section) { section = { name: descriptor.section, fields: [] }; sections.push(section); }
    section.fields.push({ path: descriptor.path, label: descriptor.label, value, origin, observations: relevant, ...(override ? { override } : {}), editTurn, observedTurn, replacedEditTurn, storyDiffers, retractable, retractableObservationIds });
  }
  return { name: record.kind === "protagonist" ? record.profile.name : record.detail.character.name, kind: record.kind, sections,
    sources: observations.map(item => item.evidence),
    locks: detail ? sections.flatMap(section => section.fields.filter(item => item.override && item.origin === "user").map(item => item.path)) : [], attention: detail?.unresolvedCandidateIds ?? [] };
}
