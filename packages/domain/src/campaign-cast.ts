import {
  castObservationSchema, castOverrideSchema,
  type CastEvidence, type CastObservation, type CastOverride, type CastProfile
} from "../../contracts/src/campaign-cast.js";
import { containsMechanicsLanguage } from "./text.js";

export type ProjectCastProfileInput = {
  /** Repository callers supply persisted sequence order for source-time ties. */
  observations: readonly CastObservation[];
  overrides: readonly CastOverride[];
};

export function validateCastFiction(value: string): string {
  if (containsMechanicsLanguage(value) || /\b\d+d\d+\b|\bDC\s*\d+\b|<\/?(?:think|analysis|scratchpad)\b/iu.test(value)) {
    throw new Error("Cast fiction contains mechanics or private reasoning.");
  }
  return value;
}

export function castEvidenceOrder(evidence: CastEvidence): readonly [number, number] {
  switch (evidence.kind) {
    case "turn": return [evidence.turnNumber, evidence.narrationRevision];
    case "user": return [evidence.effectiveTurnNumber, 0];
    case "world": return [0, 0];
    case "historical_world": return [0, 0];
  }
}

function compareEvidence(left: CastEvidence, right: CastEvidence): number {
  const a = castEvidenceOrder(left);
  const b = castEvidenceOrder(right);
  return a[0] - b[0] || a[1] - b[1];
}

/** Unresolved static conflicts are omitted; no guessed winner becomes canon. */
export function projectCastProfile(input: ProjectCastProfileInput): CastProfile {
  const observations = input.observations.map((value) => castObservationSchema.parse(value));
  const byId = new Map(observations.map((value) => [value.id, value]));
  if (byId.size !== observations.length) throw new Error("Duplicate cast observation ID.");
  if (new Set(observations.map((value) => value.characterId)).size > 1) throw new Error("Invalid cast character scope or supersession.");
  const sequences = new Map(observations.map((value, index) => [value.id, index]));
  const superseded = new Set<string>();
  for (const observation of observations) {
    validateCastFiction(observation.value);
    if (!observation.supersedesObservationId) continue;
    const prior = byId.get(observation.supersedesObservationId);
    if (!prior || prior.id === observation.id || prior.characterId !== observation.characterId
      || prior.field !== observation.field || prior.mode !== "fact" || observation.mode !== "fact"
      || (compareEvidence(prior.evidence, observation.evidence) || sequences.get(prior.id)! - sequences.get(observation.id)!) >= 0) {
      throw new Error("Invalid cast observation supersession.");
    }
    superseded.add(prior.id);
  }
  const profile: CastProfile = {};
  const values = new Map<CastObservation["field"], Set<string>>();
  for (const observation of observations.sort((a, b) => compareEvidence(a.evidence, b.evidence))) {
    if (observation.mode !== "fact" || superseded.has(observation.id)) continue;
    const fieldValues = values.get(observation.field) ?? new Set<string>();
    fieldValues.add(observation.value);
    values.set(observation.field, fieldValues);
    if (observation.field.startsWith("state.") || observation.field === "story.goals" || fieldValues.size === 1) {
      profile[observation.field] = observation.value;
    } else {
      delete profile[observation.field];
    }
  }
  const overrides = input.overrides.map((value) => castOverrideSchema.parse(value))
    .sort((a, b) => compareEvidence(a.evidence, b.evidence));
  for (const override of overrides) profile[override.field] = validateCastFiction(override.value);
  return profile;
}

/** Resolve the effective cast fields of a seeded profile without changing its authored source. */
export function resolveSeededCastProfile(input: ProjectCastProfileInput & {
  profile: import("../../contracts/src/world-library.js").CharacterProfile;
  restoreGoalsAfterTurn?: number;
}): { profile: CastProfile; sources: Partial<Record<keyof CastProfile, "authored" | "observation" | "override">> } {
  const projected = projectCastProfile({ observations: input.observations, overrides: [] });
  const superseded = new Set(input.observations.map((item) => item.supersedesObservationId).filter(Boolean));
  const latest = (field: CastObservation["field"], after = -1) => input.observations
    .filter((item) => item.field === field && item.mode === "fact" && !superseded.has(item.id) && castEvidenceOrder(item.evidence)[0] > after)
    .sort((a, b) => compareEvidence(a.evidence, b.evidence)).at(-1)?.value;
  const profile: CastProfile = {};
  const sources: Partial<Record<keyof CastProfile, "authored" | "observation" | "override">> = {};
  const stable = ["identity.pronouns", "story.role", "story.background", "story.personality", "story.motivations", "story.voiceAndMannerisms"] as const;
  for (const field of stable) {
    const [section, key] = field.split(".") as ["identity" | "story", string];
    const value = (input.profile[section] as Record<string, unknown>)[key];
    if (typeof value === "string" && value.trim()) { profile[field] = value; sources[field] = "authored"; }
    else if (projected[field] !== undefined) { profile[field] = projected[field]; sources[field] = "observation"; }
  }
  for (const field of ["story.goals", "state.location", "state.condition", "state.clothing", "appearance.description"] as const) {
    const value = latest(field, field === "story.goals" ? input.restoreGoalsAfterTurn ?? -1 : -1);
    if (value !== undefined) { profile[field] = value; sources[field] = "observation"; }
    else if (field === "story.goals" && input.profile.story.goals.trim()) { profile[field] = input.profile.story.goals; sources[field] = "authored"; }
  }
  for (const override of input.overrides) {
    if (!(override.field in profile) && !["story.goals", "state.location", "state.condition", "state.clothing", "appearance.description"].includes(override.field)) continue;
    if (["story.goals", "state.location", "state.condition", "state.clothing", "appearance.description"].includes(override.field)) {
      profile[override.field] = validateCastFiction(override.value); sources[override.field] = "override";
    }
  }
  return { profile, sources };
}

/** Authority class for the shared editor and server write guards. */
export function seededCastFieldPolicy(path: string): "identity" | "fixed" | "updating" | "observed" | "unknown" {
  if (path === "name" || path === "identity.aliases") return "identity";
  if (path === "appearance.description") return "observed";
  if (["story.goals", "state.location", "state.condition", "state.clothing"].includes(path)) return "updating";
  if (path === "unclassifiedNotes" || path.startsWith("identity.") || path.startsWith("story.") || path.startsWith("appearance.")) return "fixed";
  return "unknown";
}

/** Whether a pending observation is hidden because a seeded fixed field is already authored. */
export function isSeededFixedCandidateHidden(profile: import("../../contracts/src/world-library.js").CharacterProfile | undefined, field: string): boolean {
  if (!profile || seededCastFieldPolicy(field) !== "fixed") return false;
  const [section, key] = field.split(".");
  const value = key ? (profile as Record<string, any>)[section!]?.[key] : (profile as Record<string, any>)[section!];
  return typeof value === "string" ? value.trim().length > 0 : Array.isArray(value) && value.length > 0;
}
