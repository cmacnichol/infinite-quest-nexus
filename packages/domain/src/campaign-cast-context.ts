import { castContextFictionFieldSchema, castGenerationSnapshotSchema, type CastGenerationSnapshot } from "../../contracts/src/campaign-cast-context.js";
import { castFieldSchema, type CastEvidence, type CastField } from "../../contracts/src/campaign-cast.js";
import { castEvidenceOrder, projectCastProfile, validateCastFiction } from "./campaign-cast.js";
import { buildScopedEntityCatalog, findEntityReferences } from "./entity-references.js";
import { estimateTokens } from "./text.js";

export type CastContextField = { field: CastField; value: string; authority: "user" | "observation";
  evidenceId: string; evidence: CastEvidence };
export type CastV2ContextField = { field: string; value: string; authority: "user" | "authored" | "observation"; evidenceId: string;
  source: { kind: string; effectiveTurnNumber?: number; turnNumber?: number } };
export type CastContextRecord = { characterId: string; revision: number; content: string; fields: (CastContextField | CastV2ContextField)[] };
export type CastContextReason = "direct_reference" | "open_thread" | "pinned" | "recent_observation" | "recent_mention";
export type CastContextExplanation = { selected: { characterId: string; name: string; reason: CastContextReason }[]; omitted: { characterId: string; reason: "budget" | "ignored" | "ambiguous" | "not_relevant" }[]; omittedFields?: { characterId: string; field: string; reason: "budget" }[] };
export function castContextTokenBudget(contextHeadroom: number, requestHeadroom = contextHeadroom): number {
  return Math.min(3000, Math.floor(0.10 * Math.max(0, Math.min(contextHeadroom, requestHeadroom))));
}
export type CastContextSelection = { records: CastContextRecord[]; content: string; estimatedTokens: number;
  omittedCharacterIds: string[]; omittedFieldCount: number; explanation: CastContextExplanation;
  coverage: { fromTurn: number | null; throughTurn: number | null; baseTurn: number; current: boolean } };
type CapturedReadonly<T> = T extends readonly (infer U)[] ? readonly CapturedReadonly<U>[]
  : T extends object ? { readonly [K in keyof T]: CapturedReadonly<T[K]> } : T;

function usable(evidence: CastEvidence, baseTurn: number) {
  return !(evidence.kind === "turn" && evidence.invalidated) && castEvidenceOrder(evidence)[0] <= baseTurn;
}

/** Pure selection over captured authority; this function performs no discovery or mutable reads. */
export function selectCastContext(input: {
  snapshot: CapturedReadonly<CastGenerationSnapshot>; direction: string; currentScene: string; openThreads: readonly string[]; budgetTokens: number;
}): CastContextSelection {
  const snapshot = castGenerationSnapshotSchema.parse(input.snapshot);
  if (snapshot.version === "cast-context-v2") return selectCastContextV2(snapshot, input);
  const budget = Number.isFinite(input.budgetTokens) ? Math.max(0, Math.floor(input.budgetTokens)) : 0;
  const baseTurn = snapshot.boundary.turnNumber;
  const current = snapshot.discoveryStatus === "current" && snapshot.trackedThroughTurn === baseTurn;
  const coverage = { fromTurn: snapshot.coverageStartTurn, throughTurn: snapshot.trackedThroughTurn, baseTurn, current };
  const protagonist = snapshot.characters.find((person) => person.origin.kind === "protagonist");
  const catalog = buildScopedEntityCatalog({ campaignCharacters: snapshot.characters,
    ...(protagonist ? { characterSnapshot: { id: protagonist.id, name: protagonist.name, aliases: protagonist.aliases } } : {}) });
  const direct = `${input.direction}\n${input.currentScene}`;
  const threads = input.openThreads.join("\n");
  const matched = (text: string) => new Set(findEntityReferences(text, catalog).map((entry) => entry.id));
  const directIds = matched(direct), threadIds = matched(threads);
  const omitted: CastContextExplanation["omitted"] = snapshot.characters.filter((person) => person.ignored && person.origin.kind !== "protagonist").map((person) => ({ characterId: person.id, reason: "ignored" }));
  const ranked = snapshot.characters.filter((person) => person.origin.kind !== "protagonist" && !person.ignored && !person.removed && !person.mergedIntoCharacterId).map((person) => {
    const key = `campaign:${person.id}`;
    const reference = catalog.find((entry) => entry.id === key)!;
    const ambiguousOnly = !directIds.has(key) && !threadIds.has(key)
      && findEntityReferences(`${direct}\n${threads}`, [reference]).length > 0;
    const rank = directIds.has(key) ? 0 : threadIds.has(key) ? 1 : person.pinned ? 2
      : !ambiguousOnly && Math.max(person.lastObservedTurn, person.lastMentionedTurn ?? 0) > 0 && Math.max(person.lastObservedTurn, person.lastMentionedTurn ?? 0) >= baseTurn - 2 ? 3 : 4;
    if (rank === 4) omitted.push({ characterId: person.id, reason: ambiguousOnly ? "ambiguous" : "not_relevant" });
    return { person, rank };
  }).filter(({ rank }) => rank < 4).sort((a, b) => a.rank - b.rank
    || Math.max(b.person.lastObservedTurn, b.person.lastMentionedTurn ?? 0) - Math.max(a.person.lastObservedTurn, a.person.lastMentionedTurn ?? 0) || a.person.id.localeCompare(b.person.id, "en"));
  const records: CastContextRecord[] = [];
  let omittedFieldCount = 0;
  const notice = current
    ? "User field overrides are current portrayal authority from their effective turn. Older conflicting facts remain historical evidence."
    : "Tracking is incomplete. User field overrides remain portrayal authority; stable observations are dated historical evidence. Dynamic observations are omitted. Use accepted history for intervening events.";
  const envelope = () => JSON.stringify({ coverage, notice, characters: records.map((record) => JSON.parse(record.content) as unknown) });
  for (const { person } of ranked) {
    validateCastFiction(person.name); person.aliases.forEach(validateCastFiction);
    const detail = snapshot.details.find((entry) => entry.characterId === person.id)!;
    const overrides = detail.overrides.filter((entry) => usable(entry.evidence, baseTurn));
    const observations = detail.observations.filter((entry) => usable(entry.evidence, baseTurn));
    const ids = new Set(observations.map((entry) => entry.id));
    for (let changed = true; changed;) {
      changed = false;
      for (const entry of observations) if (ids.has(entry.id) && entry.supersedesObservationId && !ids.has(entry.supersedesObservationId)) {
        ids.delete(entry.id); changed = true;
      }
    }
    const supported = observations.filter((entry) => ids.has(entry.id));
    const superseded = new Set(supported.flatMap((entry) => entry.supersedesObservationId ? [entry.supersedesObservationId] : []));
    const profile = projectCastProfile({ observations: supported, overrides });
    const fields: CastContextField[] = [];
    for (const field of castFieldSchema.options) {
      const value = profile[field];
      if (value === undefined) continue;
      const override = overrides.find((entry) => entry.field === field);
      const observation = supported.filter((entry) => !superseded.has(entry.id) && entry.field === field && entry.mode === "fact" && entry.value === value)
        .sort((a, b) => castEvidenceOrder(b.evidence)[0] - castEvidenceOrder(a.evidence)[0]
          || castEvidenceOrder(b.evidence)[1] - castEvidenceOrder(a.evidence)[1]).at(0);
      if (!override && (!current || observation?.evidence.kind === "historical_world")
        && (field.startsWith("state.") || field === "story.goals")) { omittedFieldCount++; continue; }
      if (override?.evidence.kind === "user") fields.push({ field, value, authority: "user", evidenceId: override.evidence.editId, evidence: override.evidence });
      else if (observation) fields.push({ field, value, authority: "observation", evidenceId: observation.id, evidence: observation.evidence });
    }
    fields.sort((a, b) => Number(b.authority === "user") - Number(a.authority === "user"));
    const record: CastContextRecord = { characterId: person.id, revision: person.revision, content: "", fields: [] };
    const serialize = () => JSON.stringify({ characterId: person.id, revision: person.revision, name: person.name, aliases: person.aliases,
      origin: person.origin, firstObservedTurn: person.firstObservedTurn, lastObservedTurn: person.lastObservedTurn,
      fields: record.fields.map((item) => {
        if (!("evidence" in item)) return item;
        const { evidence, ...field } = item; return ({ ...field,
        source: evidence.kind === "turn" ? { kind: "turn", turnId: evidence.turnId, turnNumber: evidence.turnNumber, narrationRevision: evidence.narrationRevision }
          : evidence }); }) });
    record.content = serialize(); records.push(record);
    if (estimateTokens(envelope()) > budget) { records.pop(); omittedFieldCount += fields.length; continue; }
    for (const field of fields) {
      record.fields.push(field); record.content = serialize();
      if (estimateTokens(envelope()) > budget) { record.fields.pop(); record.content = serialize(); omittedFieldCount++; }
    }
  }
  const content = records.length ? envelope() : "";
  const selected = new Set(records.map((record) => record.characterId));
  const reasons: CastContextReason[] = ["direct_reference", "open_thread", "pinned", "recent_observation"];
  const explanation: CastContextExplanation = { selected: ranked.filter(({ person }) => selected.has(person.id)).map(({ person, rank }) => ({ characterId: person.id, name: person.name, reason: reasons[rank]! })),
    omitted: [...omitted, ...ranked.filter(({ person }) => !selected.has(person.id)).map(({ person }) => ({ characterId: person.id, reason: "budget" as const }))] };
  return { records, content, estimatedTokens: estimateTokens(content), coverage, omittedFieldCount, explanation,
    omittedCharacterIds: ranked.filter(({ person }) => !selected.has(person.id)).map(({ person }) => person.id) };
}

/** A v2 provider projection, already ranked by relevance and stripped of non-fiction. */
export type CastFictionCandidate = { characterId: string; name: string; revision?: number; fields: readonly { field: string; value: string; source: string; evidenceKind?: "turn" | "user" | "world" | "historical_world" | undefined; evidenceId?: string | undefined; effectiveTurn?: number | undefined }[] };
const CAST_FICTION_FIELD_ORDER = castContextFictionFieldSchema.options;
/** Admit the smallest identities first, then allocate one field per character per round. */
export function allocateCastFictionContext(candidates: readonly CastFictionCandidate[], headroom: number, notice = "", coverage: CastContextSelection["coverage"] = { fromTurn: null, throughTurn: null, baseTurn: 0, current: false }): {
  content: string; estimatedTokens: number; omittedCharacterIds: string[]; omittedFieldCount: number; omittedFields: { characterId: string; field: string; reason: "budget" }[];
} {
  const budget = Number.isFinite(headroom) ? Math.min(3000, Math.max(0, Math.floor(headroom))) : 0;
  type WireField = CastV2ContextField;
  const records: { characterId: string; name: string; revision: number; fields: WireField[] }[] = [];
  const omittedCharacterIds: string[] = [];
  let omittedFieldCount = 0;
  const omittedFields: { characterId: string; field: string; reason: "budget" }[] = [];
  const serialize = () => JSON.stringify({ coverage, notice, characters: records });
  for (const candidate of candidates) {
    const record = { characterId: candidate.characterId, name: candidate.name, revision: candidate.revision ?? 0, fields: [] as WireField[] };
    records.push(record);
    if (estimateTokens(serialize()) > budget) { records.pop(); omittedCharacterIds.push(candidate.characterId); omittedFieldCount += candidate.fields.length; }
  }
  for (const fieldName of CAST_FICTION_FIELD_ORDER) {
    for (const record of records) {
      const candidate = candidates.find(item => item.characterId === record.characterId)!;
      const field = candidate.fields.find(item => item.field === fieldName && item.value);
      if (!field) continue;
      const isObservation = field.source === "observation";
      const kind = field.evidenceKind ?? (isObservation ? "turn" : field.source === "authored" ? "world" : "user");
      record.fields.push({ field: field.field, value: field.value, authority: isObservation ? "observation" : field.source === "authored" ? "authored" : "user", evidenceId: field.evidenceId ?? record.characterId,
        source: { kind, ...(field.effectiveTurn !== undefined ? { [kind === "turn" ? "turnNumber" : "effectiveTurnNumber"]: field.effectiveTurn } : {}) } });
      if (estimateTokens(serialize()) > budget) { record.fields.pop(); omittedFieldCount++; omittedFields.push({ characterId: record.characterId, field: field.field, reason: "budget" }); }
    }
  }
  const content = records.length ? serialize() : "";
  return { content, estimatedTokens: estimateTokens(content), omittedCharacterIds, omittedFieldCount, omittedFields };
}

/** New captures use their frozen, fiction-only values. Legacy captures continue through v1 above. */
function selectCastContextV2(snapshot: CastGenerationSnapshot, input: { direction: string; currentScene: string; openThreads: readonly string[]; budgetTokens: number }): CastContextSelection {
  const baseTurn = snapshot.boundary.turnNumber;
  const current = snapshot.discoveryStatus === "current" && snapshot.trackedThroughTurn === baseTurn;
  const coverage = { fromTurn: snapshot.coverageStartTurn, throughTurn: snapshot.trackedThroughTurn, baseTurn, current };
  const protagonist = snapshot.characters.find(person => person.origin.kind === "protagonist");
  const catalog = buildScopedEntityCatalog({ campaignCharacters: snapshot.characters,
    ...(protagonist ? { characterSnapshot: { id: protagonist.id, name: protagonist.name, aliases: protagonist.aliases } } : {}) });
  const directText = `${input.direction}\n${input.currentScene}`;
  const threadText = input.openThreads.join("\n");
  const matches = (text: string) => new Set(findEntityReferences(text, catalog).map(item => item.id));
  const direct = matches(directText), threads = matches(threadText);
  const omitted: CastContextExplanation["omitted"] = [];
  const ranked = snapshot.characters.filter(person => {
    if (person.origin.kind === "protagonist" || person.removed || person.mergedIntoCharacterId) return false;
    if (person.ignored) { omitted.push({ characterId: person.id, reason: "ignored" }); return false; }
    return true;
  }).map(person => {
    const key = `campaign:${person.id}`;
    const reference = catalog.find(item => item.id === key)!;
    const ambiguous = !direct.has(key) && !threads.has(key) && findEntityReferences(`${directText}\n${threadText}`, [reference]).length > 0;
    const recent = Math.max(person.lastObservedTurn, person.lastMentionedTurn ?? 0);
    const rank = direct.has(key) ? 0 : threads.has(key) ? 1 : !ambiguous && recent > 0 && recent >= baseTurn - 2 ? 2 : person.pinned ? 3 : 4;
    if (rank === 4) omitted.push({ characterId: person.id, reason: ambiguous ? "ambiguous" : "not_relevant" });
    return { person, rank, recent };
  }).filter(item => item.rank < 4).sort((a, b) => a.rank - b.rank || b.recent - a.recent || a.person.id.localeCompare(b.person.id, "en"));
  const notice = current ? "Authored and user-edited fields guide portrayal. Observations are lower-authority evidence."
    : snapshot.discoveryStatus === "off" ? "Character discovery is off. Observations are dated, lower-authority last-known state; use accepted history for later events."
      : "Character tracking is incomplete. Observations are dated, lower-authority last-known state; use accepted history for later events.";
  const candidates = ranked.map(({ person }) => ({ characterId: person.id, revision: person.revision, name: person.name,
    fields: snapshot.fiction!.find(item => item.characterId === person.id)!.fields }));
  const allocated = allocateCastFictionContext(candidates, input.budgetTokens, notice, coverage);
  const wire = allocated.content ? JSON.parse(allocated.content) as { characters: { characterId: string; revision: number; fields: CastV2ContextField[] }[] } : { characters: [] };
  const admitted = new Set(wire.characters.map(item => item.characterId));
  const reasons: CastContextReason[] = ["direct_reference", "open_thread", "recent_observation", "pinned"];
  return { content: allocated.content, estimatedTokens: allocated.estimatedTokens, coverage, omittedFieldCount: allocated.omittedFieldCount,
    omittedCharacterIds: allocated.omittedCharacterIds,
    records: wire.characters.map(character => ({ characterId: character.characterId, revision: character.revision, content: JSON.stringify(character), fields: character.fields })),
    explanation: { selected: ranked.filter(item => admitted.has(item.person.id)).map(item => ({ characterId: item.person.id, name: item.person.name, reason: reasons[item.rank]! })),
      omitted: [...omitted, ...allocated.omittedCharacterIds.map(characterId => ({ characterId, reason: "budget" as const }))], omittedFields: allocated.omittedFields } };
}

/** Gap handling only substitutes authored goals for an observed value; manual overrides always win. */
export function resolveCastContextGoal(input: { value: string; source: string; authored: string; discoveryEnabled: boolean; coverageCurrent: boolean }): { value: string; source: string } {
  if (input.discoveryEnabled && !input.coverageCurrent && input.source === "observation" && input.authored.trim())
    return { value: input.authored, source: "authored" };
  return { value: input.value, source: input.source };
}
