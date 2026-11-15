import type { CastCharacter, CastObservation, CastOverride } from "../../contracts/src/campaign-cast.js";

/** Conflict policy matches the standard workspace projection while preserving full supersession edges. */
export function observationFieldConflicts(person: CastCharacter, observations: readonly CastObservation[], overrides: readonly CastOverride[], retracted: ReadonlySet<string>, field: CastObservation["field"]): boolean {
  if (field.startsWith("state.") || field === "story.goals" || overrides.some(item => item.field === field)) return false;
  if (person.campaignProfile) {
    if (field === "appearance.description") return false;
    const [section, key] = field.split(".");
    const authored = (person.campaignProfile as Record<string, any>)[section!]?.[key!];
    if (typeof authored === "string" && authored.trim()) return false;
  }
  const superseded = new Set(observations.map(item => item.supersedesObservationId).filter(Boolean));
  return new Set(observations.filter(item => item.field === field && item.mode === "fact" && !superseded.has(item.id) && !retracted.has(item.id)).map(item => item.value)).size > 1;
}
