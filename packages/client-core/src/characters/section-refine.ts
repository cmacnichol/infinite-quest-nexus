import { characterProfileSchema, playableCharacterGenerationPreviewRequestSchema, playableCharacterSchema, worldContentSchema, type PlayableCharacter, type PlayableCharacterGenerationPreviewRequest, type WorldContent } from "@infinite-quest/contracts";
import { WORLD_EDITOR_FIELDS } from "./profile-fields.js";

declare function structuredClone<T>(value: T): T;

export type RefineSection = "identity" | "story" | "appearance";

type FieldValue = string | string[];
function fields(section: RefineSection) {
  return WORLD_EDITOR_FIELDS.filter(field => section === "identity" ? field.world?.group === "identity" : section === "appearance" ? field.world?.group === "appearance" : ["core", "story", "notes"].includes(field.world?.group ?? ""));
}
export function refineSectionPaths(section: RefineSection): string[] {
  return fields(section).map(field => `profile.${field.path}`);
}
function valueAt(character: PlayableCharacter, path: string): FieldValue {
  const profile = characterProfileSchema.parse(character.profile ?? {});
  let value: unknown = profile;
  for (const part of path.split(".")) value = (value as Record<string, unknown>)[part];
  return value as FieldValue;
}
export function applyRefinedSection(current: PlayableCharacter, generated: PlayableCharacter, section: RefineSection): PlayableCharacter {
  const result = structuredClone(current);
  result.profile ??= characterProfileSchema.parse({});
  for (const field of fields(section)) {
    const parts = field.path.split(".");
    let target = result.profile as Record<string, unknown>;
    for (const part of parts.slice(0, -1)) target = target[part] as Record<string, unknown>;
    target[parts[parts.length - 1]!] = structuredClone(valueAt(generated, field.path));
  }
  return result;
}
export function refinedSectionDiff(current: PlayableCharacter, generated: PlayableCharacter, section: RefineSection): Array<{ path: string; label: string; current: FieldValue; proposed: FieldValue }> {
  return fields(section).flatMap(field => {
    const before = valueAt(current, field.path); const after = valueAt(generated, field.path);
    return JSON.stringify(before) === JSON.stringify(after) ? [] : [{ path: `profile.${field.path}`, label: field.label, current: structuredClone(before), proposed: structuredClone(after) }];
  });
}
export function sectionRefineRequest(content: WorldContent, current: PlayableCharacter, section: RefineSection, instruction: string, progressKey: string): PlayableCharacterGenerationPreviewRequest {
  const candidate = playableCharacterSchema.parse(structuredClone(current));
  const world = structuredClone(content);
  const ids = new Set<string>();
  for (const character of world.playableCharacters) {
    if (ids.has(character.id)) throw new Error(`Duplicate character ID: ${character.id}. Resolve duplicate roster entries before refining.`);
    ids.add(character.id);
  }
  const index = world.playableCharacters.findIndex(character => character.id === candidate.id);
  if (index < 0) world.playableCharacters.push(candidate); else world.playableCharacters[index] = candidate;
  return playableCharacterGenerationPreviewRequestSchema.parse({ content: worldContentSchema.parse(world), prompt: `Refine the character's ${section} section. ${instruction}`, characterId: candidate.id, progressKey, ...(candidate.campaignUse === "supporting" ? { campaignUse: "supporting" } : {}) });
}
