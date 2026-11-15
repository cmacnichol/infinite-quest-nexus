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
export function authoringJobLabel(job: { status: string; target: { kind: "new_world" } | { kind: "world_draft"; characterId?: string }; expiresAt: string }, locale?: string): string {
  const kind = job.target.kind === "world_draft" && job.target.characterId ? "Edit existing character" : "New character";
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/.exec(job.expiresAt);
  if (!match) throw new Error("Invalid proposal expiration timestamp.");
  let year = Number(match[1]); const month = Number(match[2]); const day = Number(match[3]);
  year -= month <= 2 ? 1 : 0;
  const era = Math.floor(year / 400); const yearOfEra = year - era * 400;
  const shiftedMonth = month + (month > 2 ? -3 : 9);
  const days = era * 146097 + yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + Math.floor((153 * shiftedMonth + 2) / 5) + day - 1 - 719468;
  const zone = match[7]!; const offset = zone === "Z" ? 0 : (zone[0] === "+" ? 1 : -1) * (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(4, 6)));
  const timestamp = ((days * 24 + Number(match[4])) * 60 + Number(match[5]) - offset) * 60000 + Number(match[6]) * 1000;
  const date = new Intl.DateTimeFormat(locale, { timeZone: "UTC" }).format(timestamp);
  return `${kind} · ${job.status.replaceAll("_", " ")} · expires ${date}`;
}
