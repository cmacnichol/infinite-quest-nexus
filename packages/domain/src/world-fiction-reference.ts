import { stripCredentialLeakage, stripMechanicsLeakage } from "./text.js";
import { matchEntityReferences, normalizeEntityTerm, type EntityReference } from "./entity-references.js";

type JsonRecord = Record<string, unknown>;
const MAX_RECORD_CHARACTERS = 20_000;
const ENTITY_LIMIT = 24;
const RELATIONSHIP_LIMIT = 32;
const narrativeFields = ["description", "summary", "background", "lore", "details", "notes", "role"] as const;

export type WorldFictionReference = Readonly<{
  sourceId: string;
  sourcePath: string;
  kind: "entity" | "relationship";
  rank: number;
  content: string;
  document: Readonly<{ kind: "entity" | "relationship"; identity: string; name: string; fiction: Readonly<Record<string, string>>; endpoints?: readonly string[] }>;
}>;
export type WorldFictionSelection = Readonly<{
  entries: readonly WorldFictionReference[];
  omissions: Readonly<{ unrecognizedRecordCount: number; missingEndpointCount: number; ambiguousAliasCount: number; oversizedRecordCount: number; entityCapCount: number; relationshipCapCount: number }>;
}>;
export type WorldFictionSelectionInput = Readonly<{
  worldVersionId: string;
  worldContent: unknown;
  direction: string;
  currentScene: string;
  openThreads: readonly string[];
  selectedCharacterAliases: readonly string[];
}>;

function record(value: unknown): JsonRecord | null { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : null; }
function strings(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim()) : typeof value === "string" && Boolean(value.trim()) ? [value.trim()] : []; }
function text(value: unknown): string | null { return typeof value === "string" && value.trim() ? value.trim() : null; }
function arrayAt(world: JsonRecord, key: string): unknown[] { const value = world[key]; return Array.isArray(value) ? value : []; }
function escapePointer(value: string): string { return value.replace(/~/gu, "~0").replace(/\//gu, "~1"); }
function terms(textValue: string): Set<string> { return new Set(textValue.split(/[^\p{L}\p{N}]+/u).map(normalizeEntityTerm).filter((value) => value.length > 1)); }

type Entity = { sourceId: string; sourcePath: string; identity: string; name: string; aliases: string[]; fiction: Record<string, string>; rank: number; };
function adaptEntity(value: unknown, index: number): Entity | null {
  const source = record(value); if (!source) return null;
  const name = text(source.name) ?? text(source.title) ?? text(source.label); if (!name) return null;
  const declared = text(source.id) ?? text(source.key);
  const fiction = Object.fromEntries(narrativeFields.flatMap((key) => { const value = text(source[key]); return value ? [[key, value]] : []; }));
  if (!Object.keys(fiction).length) return null;
  const identity = declared ?? `path:entities:${index}`;
  return { sourceId: `world:${identity}`, sourcePath: `/entities/${index}`, identity, name, aliases: [name, ...strings(source.aliases), ...strings(source.alias)], fiction, rank: 2 };
}
function adaptRelationship(value: unknown, index: number, byTerm: Map<string, Entity[]>): { value: WorldFictionReference; endpoints: Entity[] } | "missing" | null {
  const source = record(value); if (!source) return null;
  const from = text(source.from) ?? text(source.source) ?? text(source.fromId) ?? text(source.sourceId);
  const to = text(source.to) ?? text(source.target) ?? text(source.toId) ?? text(source.targetId);
  const description = narrativeFields.map((key) => text(source[key])).find((item): item is string => Boolean(item));
  if (!from || !to || !description) return null;
  const endpoints = [from, to].map((endpoint) => byTerm.get(normalizeEntityTerm(endpoint)) ?? []).flat();
  if (endpoints.length !== 2 || new Set(endpoints.map((item) => item.identity)).size !== 2) return "missing";
  const identity = text(source.id) ?? text(source.key) ?? `path:relationships:${index}`;
  const name = text(source.name) ?? text(source.title) ?? text(source.label) ?? `${endpoints[0]!.name} / ${endpoints[1]!.name}`;
  const fiction = { description };
  const document = { kind: "relationship" as const, identity, name, fiction, endpoints: endpoints.map((item) => item.identity) };
  const content = JSON.stringify(document);
  if (content.length > MAX_RECORD_CHARACTERS) return null;
  return { endpoints, value: { sourceId: `world:${identity}`, sourcePath: `/relationships/${index}`, kind: "relationship", rank: 1, content, document } };
}

/** Adapts only named legacy fiction fields; unknown stored JSON is never serialized as canon. */
export function selectWorldFictionReferences(input: WorldFictionSelectionInput): WorldFictionSelection {
  const world = record(input.worldContent); if (!world) return { entries: [], omissions: { unrecognizedRecordCount: 0, missingEndpointCount: 0, ambiguousAliasCount: 0, oversizedRecordCount: 0, entityCapCount: 0, relationshipCapCount: 0 } };
  const omissions = { unrecognizedRecordCount: 0, missingEndpointCount: 0, ambiguousAliasCount: 0, oversizedRecordCount: 0, entityCapCount: 0, relationshipCapCount: 0 };
  const entities: Entity[] = [];
  for (const [index, item] of arrayAt(world, "entities").entries()) { const entity = adaptEntity(item, index); if (!entity) { omissions.unrecognizedRecordCount++; continue; } const content = JSON.stringify({ kind: "entity", identity: entity.identity, name: entity.name, fiction: entity.fiction }); if (content.length > MAX_RECORD_CHARACTERS) { omissions.oversizedRecordCount++; continue; } entities.push(entity); }
  const byTerm = new Map<string, Entity[]>(); for (const entity of entities) for (const alias of new Set([...entity.aliases, entity.identity])) { const key = normalizeEntityTerm(alias); if (key && !(byTerm.get(key) ?? []).some((existing) => existing.identity === entity.identity)) byTerm.set(key, [...(byTerm.get(key) ?? []), entity]); }
  const seed = `${input.direction}\n${input.currentScene}\n${input.openThreads.join("\n")}\n${input.selectedCharacterAliases.join("\n")}`;
  const normalizedSeed = normalizeEntityTerm(seed); const seedTerms = terms(seed);
  const directlyMentioned = new Set<string>();
  const catalog: EntityReference[] = entities.map((entity) => ({ id: entity.sourceId, displayName: entity.name, aliases: [...entity.aliases, entity.identity], kind: "entity", source: "world" }));
  for (const match of matchEntityReferences(seed, catalog)) directlyMentioned.add(match.entity.id.slice("world:".length));
  for (const [alias, matches] of byTerm) {
    if (matches.length > 1 && new RegExp(`(?<![\\p{L}\\p{N}_])${alias.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}(?![\\p{L}\\p{N}_])`, "u").test(normalizedSeed)) omissions.ambiguousAliasCount++;
  }
  const entityReferences = entities.map((entity) => ({ entity, value: { sourceId: entity.sourceId, sourcePath: entity.sourcePath, kind: "entity" as const, rank: directlyMentioned.has(entity.identity) ? 0 : 2, content: JSON.stringify({ kind: "entity", identity: entity.identity, name: entity.name, fiction: entity.fiction }), document: { kind: "entity" as const, identity: entity.identity, name: entity.name, fiction: entity.fiction } } }));
  const relationships: WorldFictionReference[] = [];
  for (const [index, item] of arrayAt(world, "relationships").entries()) { const adapted = adaptRelationship(item, index, byTerm); if (adapted === "missing") { omissions.missingEndpointCount++; continue; } if (!adapted) { omissions.unrecognizedRecordCount++; continue; } if (adapted.endpoints.some((endpoint) => directlyMentioned.has(endpoint.identity))) relationships.push(adapted.value); }
  const relevantEntities = entityReferences.filter(({ entity }) => directlyMentioned.has(entity.identity) || (
    !entity.aliases.some((alias) => (byTerm.get(normalizeEntityTerm(alias))?.length ?? 0) > 1 && new RegExp(`(?<![\\p{L}\\p{N}_])${normalizeEntityTerm(alias).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}(?![\\p{L}\\p{N}_])`, "u").test(normalizedSeed))
    && [...terms(`${entity.name} ${Object.values(entity.fiction).join(" ")}`)].some((term) => seedTerms.has(term))
  ));
  const selectedEntities = relevantEntities.sort((left, right) => left.value.rank - right.value.rank || left.value.sourcePath.localeCompare(right.value.sourcePath)).slice(0, ENTITY_LIMIT).map((item) => item.value);
  omissions.entityCapCount = Math.max(0, relevantEntities.length - selectedEntities.length);
  const selectedRelationships = relationships.sort((left, right) => left.sourcePath.localeCompare(right.sourcePath)).slice(0, RELATIONSHIP_LIMIT);
  omissions.relationshipCapCount = Math.max(0, relationships.length - selectedRelationships.length);
  return { entries: [...selectedEntities, ...selectedRelationships], omissions };
}

/** Fixture-backed adapter table: id/key; name/title/label; aliases/alias; fiction description, summary, background, lore, details, notes, role; endpoints from/to, source/target, fromId/toId, sourceId/targetId. */
export const WORLD_FICTION_REFERENCE_SHAPE_TABLE = Object.freeze({ stableIdentity: ["id", "key"], displayIdentity: ["name", "title", "label"], aliases: ["aliases", "alias"], fiction: narrativeFields, endpoints: ["from/to", "source/target", "fromId/toId", "sourceId/targetId"] });

/** Explicit immutable overview fields; unknown authoring/provider extensions stay stored only. */
export function worldFictionOverview(value: unknown): Readonly<Record<string, string>> {
  const overview = record(value) ?? {};
  return Object.fromEntries(["title", "genre", "tone", "premise", "backgroundStory", "firstAction"].flatMap((key) => {
    const value = overview[key];
    return typeof value === "string" ? [[key, stripMechanicsLeakage(stripCredentialLeakage(value)).text]] : [];
  }));
}
