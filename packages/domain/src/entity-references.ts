import { extractEntities } from "./text.js";

export type EntityReferenceSource = "world" | "character";

export type EntityReference = {
  id: string;
  displayName: string;
  aliases: string[];
  kind: string;
  source: EntityReferenceSource;
};

export type EntityReferenceMatch = {
  entity: EntityReference;
  matchedAlias: string;
};

export type EntityCatalogInput = {
  worldContent?: unknown;
  characterSnapshot?: unknown;
  characterProfile?: unknown;
};

type UnknownRecord = Record<string, unknown>;

const asRecord = (value: unknown): UnknownRecord | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : undefined;

const firstText = (record: UnknownRecord, keys: string[]): string => {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
};

const textValues = (value: unknown): string[] => {
  if (typeof value === "string") return value.trim() ? [value.trim()] : [];
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => typeof entry === "string" && entry.trim() ? [entry.trim()] : []);
};

/** Normalization used only for comparison; display spelling remains untouched. */
export function normalizeEntityTerm(value: string): string {
  return String(value ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/\s+/gu, " ")
    .trim();
}

function fallbackId(source: EntityReferenceSource, kind: string, displayName: string): string {
  const slug = normalizeEntityTerm(displayName)
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/gu, "") || "unnamed";
  return `${source}:${normalizeEntityTerm(kind).replace(/\s+/gu, "-") || "entity"}:${slug}`;
}

function uniqueAliases(values: unknown[]): string[] {
  const seen = new Set<string>();
  return values.flatMap(textValues).filter((candidate) => {
    const normalized = normalizeEntityTerm(candidate);
    if (!normalized || seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}

function toReference(
  value: unknown,
  source: EntityReferenceSource,
  defaultKind: string,
  additionalAliases: unknown[] = []
): EntityReference | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const displayName = firstText(record, ["name", "title", "label"]);
  if (!displayName) return undefined;
  const kind = firstText(record, ["kind", "type", "category"]) || defaultKind;
  const declaredId = firstText(record, ["id", "key"]);
  const id = declaredId ? `${source}:${declaredId}` : fallbackId(source, kind, displayName);
  const aliases = uniqueAliases([displayName, record.aliases, record.alias, ...additionalAliases]);
  return { id, displayName, aliases, kind, source };
}

function worldEntityValues(worldContent: unknown): unknown[] {
  const entities = asRecord(worldContent)?.entities;
  if (Array.isArray(entities)) return entities;
  const entityMap = asRecord(entities);
  if (!entityMap) return [];
  return Object.entries(entityMap).map(([key, value]) => {
    const record = asRecord(value);
    return record ? { key, ...record } : value;
  });
}

function profileAliases(characterProfile: unknown): string[] {
  const profile = asRecord(asRecord(characterProfile)?.profile);
  const identity = asRecord(profile?.identity);
  return textValues(identity?.aliases);
}

/**
 * Builds references only from the supplied pinned world version and campaign
 * character data. It deliberately performs no global lookup.
 */
export function buildScopedEntityCatalog(input: EntityCatalogInput): EntityReference[];
export function buildScopedEntityCatalog(worldContent: unknown, characterSnapshot?: unknown): EntityReference[];
export function buildScopedEntityCatalog(
  inputOrWorldContent: EntityCatalogInput | unknown,
  suppliedCharacterSnapshot?: unknown
): EntityReference[] {
  const possibleInput = asRecord(inputOrWorldContent);
  const isInput = suppliedCharacterSnapshot === undefined
    && Boolean(possibleInput)
    && (
      Object.hasOwn(possibleInput!, "worldContent")
      || Object.hasOwn(possibleInput!, "characterSnapshot")
      || Object.hasOwn(possibleInput!, "characterProfile")
    );
  const worldContent = isInput ? possibleInput?.worldContent : inputOrWorldContent;
  const characterSnapshot = isInput ? possibleInput?.characterSnapshot : suppliedCharacterSnapshot;
  const characterProfile = isInput ? possibleInput?.characterProfile : undefined;

  const candidates = worldEntityValues(worldContent)
    .map((value) => toReference(value, "world", "entity"))
    .filter((value): value is EntityReference => Boolean(value));
  const characterSource = characterSnapshot ?? characterProfile;
  const character = toReference(
    characterSource,
    "character",
    "character",
    profileAliases(characterProfile)
  );
  if (character) candidates.push(character);

  const byScopedId = new Map<string, EntityReference>();
  for (const candidate of candidates) {
    if (!byScopedId.has(candidate.id)) byScopedId.set(candidate.id, candidate);
  }
  return [...byScopedId.values()];
}

type AliasCandidate = {
  alias: string;
  normalized: string;
  entity: EntityReference;
};

function unambiguousAliases(catalog: readonly EntityReference[]): AliasCandidate[] {
  const aliases = new Map<string, AliasCandidate[]>();
  for (const entity of catalog) {
    for (const alias of entity.aliases) {
      const normalized = normalizeEntityTerm(alias);
      if (!normalized) continue;
      const entries = aliases.get(normalized) ?? [];
      if (!entries.some((entry) => entry.entity.id === entity.id)) {
        entries.push({ alias, normalized, entity });
      }
      aliases.set(normalized, entries);
    }
  }
  return [...aliases.values()]
    .filter((entries) => entries.length === 1)
    .map(([entry]) => entry!)
    .sort((left, right) => (
      right.normalized.length - left.normalized.length
      || left.normalized.localeCompare(right.normalized)
    ));
}

function phrasePattern(normalizedAlias: string): RegExp {
  const escaped = normalizedAlias
    .split(" ")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("\\s+");
  return new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, "gu");
}

/** Finds unambiguous, whole-phrase references, preferring the longest overlap. */
export function matchEntityReferences(
  text: string,
  catalog: readonly EntityReference[]
): EntityReferenceMatch[] {
  const normalizedText = normalizeEntityTerm(text);
  if (!normalizedText) return [];
  const occupied: Array<[number, number]> = [];
  const matchedEntities = new Set<string>();
  const matches: EntityReferenceMatch[] = [];
  for (const candidate of unambiguousAliases(catalog)) {
    for (const match of normalizedText.matchAll(phrasePattern(candidate.normalized))) {
      const start = match.index ?? 0;
      const end = start + match[0].length;
      if (occupied.some(([left, right]) => start < right && end > left)) continue;
      if (!matchedEntities.has(candidate.entity.id)) {
        matches.push({ entity: candidate.entity, matchedAlias: candidate.alias });
        matchedEntities.add(candidate.entity.id);
      }
      occupied.push([start, end]);
    }
  }
  return matches;
}

export function findEntityReferences(
  text: string,
  catalog: readonly EntityReference[]
): EntityReference[] {
  return matchEntityReferences(text, catalog).map((match) => match.entity);
}

/** Adds canonical names and aliases for entities already mentioned in the query. */
export function entityQueryTerms(
  query: string,
  catalog: readonly EntityReference[]
): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const { entity } of matchEntityReferences(query, catalog)) {
    for (const value of [entity.displayName, ...entity.aliases]) {
      const normalized = normalizeEntityTerm(value);
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      terms.push(value);
    }
  }
  return terms;
}

export function expandEntityQuery(
  query: string,
  catalog: readonly EntityReference[]
): string {
  const value = String(query ?? "").trim();
  const original = normalizeEntityTerm(value);
  const additions = entityQueryTerms(value, catalog)
    .filter((term) => normalizeEntityTerm(term) !== original);
  return [value, ...additions].filter(Boolean).join(" ");
}

/** Heuristic discoveries remain separate from stable, scoped identities. */
export function extractCapitalizationFallback(
  text: string,
  catalog: readonly EntityReference[] = [],
  limit = 32
): string[] {
  const known = new Set(catalog.flatMap((entity) => entity.aliases.map(normalizeEntityTerm)));
  return extractEntities(text, limit)
    .filter((value) => !known.has(normalizeEntityTerm(value)));
}

export function resolveEntityMetadata(
  text: string,
  catalog: readonly EntityReference[]
): { entityIds: string[]; entities: string[] } {
  const references = findEntityReferences(text, catalog);
  const displayNames = references.map((entity) => entity.displayName);
  return {
    entityIds: references.map((entity) => entity.id),
    entities: [...new Set([
      ...displayNames,
      ...extractCapitalizationFallback(text, catalog)
    ])].slice(0, 32)
  };
}
