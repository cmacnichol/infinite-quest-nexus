import type { CampaignCharacterProfile, CastDetail, CastEvidence, CastObservation, CastOverride } from "@infinite-quest/contracts";
import { PROFILE_FIELDS, SUPPORTING_FIELDS, type CharacterSectionName } from "./profile-fields.js";

export type CharacterRecord = { kind: "protagonist"; profile: CampaignCharacterProfile; revision: number } | { kind: "supporting"; detail: CastDetail };
export type CharacterField = { path: string; label: string; value: string | string[] | null; origin: "unknown" | "observed" | "claim" | "user" | "conflicted"; observations: CastObservation[]; override?: CastOverride };
export type CharacterSheet = { name: string; kind: CharacterRecord["kind"]; sections: { name: CharacterSectionName; fields: CharacterField[] }[]; sources: CastEvidence[]; locks: string[]; attention: string[] };
export function buildCharacterSheet(record: CharacterRecord): CharacterSheet {
  const descriptors = record.kind === "protagonist" ? PROFILE_FIELDS : SUPPORTING_FIELDS;
  const sections: CharacterSheet["sections"] = [];
  const observations = record.kind === "supporting" ? record.detail.observations : [];
  const superseded = new Set(observations.filter((item) => !(item.evidence.kind === "turn" && item.evidence.invalidated)).map((item) => item.supersedesObservationId).filter((id): id is string => id !== null));
  for (const descriptor of descriptors) {
    const relevant = observations.filter((item) => item.field === descriptor.path && !(item.evidence.kind === "turn" && item.evidence.invalidated));
    let value: string | string[] | null = null;
    let origin: CharacterField["origin"] = "unknown";
    let override: CastOverride | undefined;
    if (record.kind === "protagonist") {
      const [part, key] = descriptor.path.split(".");
      const raw = key ? (record.profile.profile as unknown as Record<string, Record<string, unknown>>)[part!]?.[key] : part === "name" ? record.profile.name : (record.profile.profile as unknown as Record<string, unknown>)[part!];
      if (typeof raw === "string" || Array.isArray(raw)) { value = raw as string | string[]; if (raw.length) origin = "user"; }
    } else {
      override = record.detail.overrides.find((item) => item.field === descriptor.path);
      const projected = record.detail.character.profile[descriptor.path as keyof typeof record.detail.character.profile];
      const facts = relevant.filter((item) => item.mode === "fact" && !superseded.has(item.id));
      if (override) { value = override.value; origin = "user"; }
      else if (projected !== undefined) { value = projected; origin = "observed"; }
      else if (new Set(facts.map((item) => item.value)).size > 1) origin = "conflicted";
      else if (relevant.some((item) => item.mode === "claim")) origin = "claim";
    }
    let section = sections.find((item) => item.name === descriptor.section);
    if (!section) { section = { name: descriptor.section, fields: [] }; sections.push(section); }
    section.fields.push({ path: descriptor.path, label: descriptor.label, value, origin, observations: relevant, ...(override ? { override } : {}) });
  }
  return { name: record.kind === "protagonist" ? record.profile.name : record.detail.character.name, kind: record.kind, sections,
    sources: observations.map((item) => item.evidence), locks: [], attention: record.kind === "supporting" ? record.detail.unresolvedCandidateIds : [] };
}

