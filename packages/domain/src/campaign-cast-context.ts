import { castGenerationSnapshotSchema, type CastGenerationSnapshot } from "../../contracts/src/campaign-cast-context.js";
import { castFieldSchema, type CastEvidence, type CastField } from "../../contracts/src/campaign-cast.js";
import { castEvidenceOrder, projectCastProfile, validateCastFiction } from "./campaign-cast.js";
import { buildScopedEntityCatalog, findEntityReferences } from "./entity-references.js";
import { estimateTokens } from "./text.js";

export type CastContextField = { field: CastField; value: string; authority: "user" | "observation";
  evidenceId: string; evidence: CastEvidence };
export type CastContextRecord = { characterId: string; revision: number; content: string; fields: CastContextField[] };
export type CastContextSelection = { records: CastContextRecord[]; content: string; estimatedTokens: number;
  omittedCharacterIds: string[]; omittedFieldCount: number;
  coverage: { fromTurn: number | null; throughTurn: number | null; baseTurn: number; current: boolean } };

function usable(evidence: CastEvidence, baseTurn: number) {
  return !(evidence.kind === "turn" && evidence.invalidated) && castEvidenceOrder(evidence)[0] <= baseTurn;
}

/** Pure selection over captured authority; this function performs no discovery or mutable reads. */
export function selectCastContext(input: {
  snapshot: CastGenerationSnapshot; direction: string; currentScene: string; openThreads: readonly string[]; budgetTokens: number;
}): CastContextSelection {
  const snapshot = castGenerationSnapshotSchema.parse(input.snapshot);
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
  const ranked = snapshot.characters.filter((person) => person.origin.kind !== "protagonist" && !person.ignored).map((person) => {
    const key = `campaign:${person.id}`;
    const reference = catalog.find((entry) => entry.id === key)!;
    const ambiguousOnly = !directIds.has(key) && !threadIds.has(key)
      && findEntityReferences(`${direct}\n${threads}`, [reference]).length > 0;
    const rank = directIds.has(key) ? 0 : threadIds.has(key) ? 1 : person.pinned ? 2
      : !ambiguousOnly && person.lastObservedTurn > 0 && person.lastObservedTurn >= baseTurn - 2 ? 3 : 4;
    return { person, rank };
  }).filter(({ rank }) => rank < 4).sort((a, b) => a.rank - b.rank
    || b.person.lastObservedTurn - a.person.lastObservedTurn || a.person.id.localeCompare(b.person.id, "en"));
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
      fields: record.fields.map(({ evidence, ...field }) => ({ ...field,
        source: evidence.kind === "turn" ? { kind: "turn", turnId: evidence.turnId, turnNumber: evidence.turnNumber, narrationRevision: evidence.narrationRevision }
          : evidence })) });
    record.content = serialize(); records.push(record);
    if (estimateTokens(envelope()) > budget) { records.pop(); omittedFieldCount += fields.length; continue; }
    for (const field of fields) {
      record.fields.push(field); record.content = serialize();
      if (estimateTokens(envelope()) > budget) { record.fields.pop(); record.content = serialize(); omittedFieldCount++; }
    }
  }
  const content = records.length ? envelope() : "";
  const selected = new Set(records.map((record) => record.characterId));
  return { records, content, estimatedTokens: estimateTokens(content), coverage, omittedFieldCount,
    omittedCharacterIds: ranked.filter(({ person }) => !selected.has(person.id)).map(({ person }) => person.id) };
}
