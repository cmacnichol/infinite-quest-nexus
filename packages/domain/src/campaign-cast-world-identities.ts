import type { CastDiscoveryWorldIdentity } from "./campaign-cast-discovery.js";
import { buildScopedEntityCatalog } from "./entity-references.js";
import { characterFictionAuthority } from "./character-fiction-authority.js";
import { validateCastFiction } from "./campaign-cast.js";
import { stripCredentialLeakage } from "./text.js";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function fiction(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim() || value.length > 2000
    || /\b(?:score|modifier|difficulty|target)\s*:?\s*[+-]?\d/iu.test(value)) return false;
  try { return validateCastFiction(value) === value && stripCredentialLeakage(value) === value; } catch { return false; }
}

function hints(values: unknown[]): string[] {
  return [...new Set(values.flat().filter(fiction))].slice(0, 20);
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
    if (!fiction(authority.name)) continue;
    result.push({ entityId: row.id, name: authority.name,
      aliases: (authority.profile?.identity.aliases ?? []).filter(fiction), identityHints: hints(authority.profile
        ? [...Object.values(authority.profile.appearance), authority.profile.story.role, authority.profile.identity.pronouns]
        : [authority.characterText]) });
  }
  // Keep colliding declarations visible to the validator instead of selecting an arbitrary winner.
  return result.filter((person) => person.entityId.length <= 200 && person.name.length <= 200
    && person.aliases.every((alias) => alias.length <= 200));
}
