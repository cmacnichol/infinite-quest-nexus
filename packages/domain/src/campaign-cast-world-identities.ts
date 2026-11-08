import type { CastDiscoveryWorldIdentity } from "./campaign-cast-discovery.js";
import { buildScopedEntityCatalog } from "./entity-references.js";
import { characterFictionAuthority, projectCastFictionText } from "./character-fiction-authority.js";
import { validateCastFiction } from "./campaign-cast.js";
import { stripCredentialLeakage } from "./text.js";
import type { CastCharacter } from "../../contracts/src/campaign-cast.js";
import { characterProfileSchema } from "../../contracts/src/world-library.js";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function fiction(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim() || value.length > 2000
    || /\b(?:score|modifier|difficulty|target)\s*:?\s*[+-]?\d/iu.test(value)) return false;
  try { return validateCastFiction(value) === value && stripCredentialLeakage(value) === value; } catch { return false; }
}

function hints(values: unknown[]): string[] {
  return [...new Set(values.flat().map((value) => projectCastFictionText(value, 2001))
    .filter((value) => value.length > 0 && value.length <= 600 && !/\b(?:score|modifier|difficulty|target)\s*:?\s*[+-]?\d/iu.test(value)))].slice(0, 20);
}

export function castDiscoveryCharacterHints(characters: CastCharacter[]) {
  return characters.map((person) => {
    const profile = person.campaignProfile;
    const appearance = profile?.appearance;
    return { characterId: person.id, hints: hints(profile
      ? [profile.story?.role, profile.identity?.pronouns, appearance?.ancestryOrSpecies, appearance?.apparentAge,
        appearance?.genderPresentation, appearance?.build, appearance?.skinOrComplexion, appearance?.face,
        appearance?.eyes, appearance?.hair, appearance?.distinguishingFeatures, appearance?.clothing,
        appearance?.equipmentAndAccessories, appearance?.otherVisualDetails]
      : [person.profile["story.role"], person.profile["identity.pronouns"], person.profile["appearance.description"]]) };
  });
}

/** Only explicit fiction fields from the supplied immutable world; no mechanics or extensions. */
export function castDiscoveryWorldIdentities(content: unknown): CastDiscoveryWorldIdentity[] {
  const world = record(content);
  const entities = Array.isArray(world.entities) ? world.entities
    : Object.entries(record(world.entities)).map(([key, value]) => ({ key, ...record(value) }));
  const result: CastDiscoveryWorldIdentity[] = [];
  for (const value of entities) {
    const row = record(value);
    const ref = buildScopedEntityCatalog({ worldContent: { entities: [row] } })[0];
    if (!ref || !/^(?:character|person|npc)$/iu.test(ref.kind) || !fiction(ref.displayName)) continue;
    result.push({ entityId: ref.id.slice("world:".length), name: ref.displayName,
      aliases: ref.aliases.filter((alias) => alias !== ref.displayName && fiction(alias)).slice(0, 20),
      identityHints: hints([row.description, row.summary, row.background, row.lore, row.details, row.role]) });
  }
  for (const value of Array.isArray(world.playableCharacters) ? world.playableCharacters : []) {
    const row = record(value);
    if (typeof row.id !== "string" || !row.id.trim() || !fiction(row.name)) continue;
    const authority = characterFictionAuthority(null, row);
    const parsedProfile = characterProfileSchema.safeParse(row.profile);
    const rawProfile = parsedProfile.success ? parsedProfile.data : null;
    if (!fiction(authority.name)) continue;
    result.push({ entityId: row.id, name: authority.name,
      aliases: (rawProfile?.identity.aliases ?? []).filter(fiction), identityHints: hints(rawProfile
        ? [rawProfile.appearance.ancestryOrSpecies, rawProfile.appearance.apparentAge,
          rawProfile.appearance.genderPresentation, rawProfile.appearance.build, rawProfile.appearance.skinOrComplexion,
          rawProfile.appearance.face, rawProfile.appearance.eyes, rawProfile.appearance.hair,
          rawProfile.appearance.distinguishingFeatures, rawProfile.appearance.clothing,
          rawProfile.appearance.equipmentAndAccessories, rawProfile.appearance.otherVisualDetails,
          rawProfile.story.role, rawProfile.identity.pronouns]
        : [row.characterText]) });
  }
  // Keep colliding declarations visible to the validator instead of selecting an arbitrary winner.
  return result.filter((person) => person.entityId.length <= 200 && person.name.length <= 200
    && person.aliases.every((alias) => alias.length <= 200));
}
