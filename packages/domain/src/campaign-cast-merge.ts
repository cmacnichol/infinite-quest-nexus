import { castFieldSchema, castAuthoredPathSchema, type CastCharacter, type CastObservation } from "../../contracts/src/campaign-cast.js";
import { characterProfileSchema } from "../../contracts/src/world-library.js";
import { castEvidenceOrder, resolveSeededCastProfile } from "./campaign-cast.js";
import { normalizeEntityTerm } from "./entity-references.js";

/** Build the review from full current identities; no truncation occurs before review. */
export function previewCastMerge(target: CastCharacter, source: CastCharacter, targetObservations: readonly CastObservation[] = [], sourceObservations: readonly CastObservation[] = [], observationOrder: ReadonlyMap<string, number> = new Map(), targetGoalCutoff?: number) {
  const seen = new Set([normalizeEntityTerm(target.name)]);
  const aliasCandidates = [ ...target.aliases, source.name, ...source.aliases ].filter(value => {
    const key = normalizeEntityTerm(value);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const fields = [...new Set([...castFieldSchema.options, ...castAuthoredPathSchema.options])].map(path => {
    const read = (person: CastCharacter, observations: readonly CastObservation[]): string | string[] | null => {
      const visible = (person.profile as Record<string, string | undefined>)[path];
      if (visible !== undefined) return visible;
      if (path === "appearance.description") {
        const superseded = new Set(observations.map(item => item.supersedesObservationId).filter(Boolean));
        const latest = observations.filter(item => item.field === path && item.mode === "fact" && !superseded.has(item.id)).sort((a, b) => {
          const left = castEvidenceOrder(a.evidence), right = castEvidenceOrder(b.evidence);
          return left[0] - right[0] || left[1] - right[1] || (observationOrder.get(a.id) ?? 0) - (observationOrder.get(b.id) ?? 0);
        }).at(-1);
        if (latest) return latest.value;
      }
      const [section, key] = path.split(".");
      const profile = person.campaignProfile as Record<string, any> | undefined;
      const value = key ? profile?.[section!]?.[key] : profile?.[section!];
      return typeof value === "string" ? value || null : Array.isArray(value) && value.length ? value : null;
    };
    const targetValue = read(target, targetObservations), sourceValue = read(source, sourceObservations);
    const targetAuthority = target.fieldSources?.[path], sourceAuthority = source.fieldSources?.[path];
    const targetManual = targetAuthority === "override" || targetAuthority === "campaign_edit";
    const sourceManual = sourceAuthority === "override" || sourceAuthority === "campaign_edit";
    const different = JSON.stringify(targetValue) !== JSON.stringify(sourceValue);
    const stable = !["story.goals", "state.location", "state.condition", "state.clothing", "appearance.description"].includes(path);
    const choiceRequired = different && ((targetManual && sourceManual) || (stable && !targetManual && !sourceManual && targetValue !== null && sourceValue !== null && targetAuthority !== "authored"));
    let defaultChoice: "source" | "target" | null = null;
    let automaticValue: string | null | undefined;
    if (!choiceRequired) {
      if (targetManual) defaultChoice = "target";
      else if (sourceManual && !(stable && targetAuthority === "authored" && targetValue)) defaultChoice = "source";
      else if (path === "story.goals" && target.campaignProfile) {
        // Replay the combined history in journal order against the surviving seed.
        const observations = [...targetObservations, ...sourceObservations]
          .filter(item => item.field === path)
          .sort((a, b) => (observationOrder.get(a.id) ?? 0) - (observationOrder.get(b.id) ?? 0))
          .map(item => ({ ...item, characterId: target.id }));
        const resolved = resolveSeededCastProfile({
          profile: characterProfileSchema.parse(target.campaignProfile), observations, overrides: [],
          ...(targetGoalCutoff === undefined ? {} : { restoreGoalsAfterTurn: targetGoalCutoff })
        });
        automaticValue = resolved.profile[path] ?? null;
        if (automaticValue !== null) {
          if (automaticValue === targetValue) defaultChoice = "target";
          else if (automaticValue === sourceValue) defaultChoice = "source";
        }
      }
      else if (!stable && !targetManual && !sourceManual) {
        const facts = [...targetObservations.map(item => ({ item, side: "target" as const })), ...sourceObservations.map(item => ({ item, side: "source" as const }))].filter(({ item }) => item.field === path && item.mode === "fact");
        const superseded = new Set(facts.map(({ item }) => item.supersedesObservationId).filter(Boolean));
        const latest = facts.filter(({ item }) => !superseded.has(item.id)).sort((a, b) => {
          const left = castEvidenceOrder(a.item.evidence), right = castEvidenceOrder(b.item.evidence);
          return left[0] - right[0] || left[1] - right[1] || (observationOrder.get(a.item.id) ?? 0) - (observationOrder.get(b.item.id) ?? 0);
        }).at(-1);
        defaultChoice = latest?.side ?? (targetValue !== null ? "target" : sourceValue !== null ? "source" : null);
      }
      else if (targetValue !== null) defaultChoice = "target";
      else if (sourceValue !== null) defaultChoice = "source";
    }
    // Dynamic facts follow observation chronology or manual precedence. Only
    // conflicts and replacement of an authored fixed value offer a decision.
    const allowedChoices: ("source" | "target")[] = choiceRequired
      || (stable && targetAuthority === "authored" && targetValue !== null && sourceValue !== null && different)
      ? ["target", "source"] : [];
    return { path, target: targetValue, source: sourceValue, choiceRequired, defaultChoice, allowedChoices, ...(automaticValue === undefined ? {} : { automaticValue }) };
  });
  return { aliasCandidates, fields };
}
