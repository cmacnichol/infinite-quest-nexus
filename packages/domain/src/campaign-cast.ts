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
