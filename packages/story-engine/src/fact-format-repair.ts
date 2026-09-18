import { canonicalFactUpdateSchema, type StoryTurnOutput } from "../../contracts/src/generation.js";
import { sha256, stableStringify } from "../../domain/src/text.js";
import { containsMechanicsLanguage, extractJsonObject, parseStoryOutput } from "./output.js";

export type VisibleRepairFact = Readonly<{ id: string; content: string }>;

export type FactFormatChange = Readonly<{
  sourceIndex: number;
  kind: "id_label_to_addition" | "visible_reference_removed" | "metadata_to_addition" | "misplaced_update_moved";
}>;

export type FactFormatRepairPlan = Readonly<{
  version: 1;
  rawOutputHash: string;
  visibleFactsHash: string;
  protectedFieldsHash: string;
  resultHash: string;
  story: StoryTurnOutput;
  changes: readonly FactFormatChange[];
}>;

export type FactFormatRepairResult =
  | Readonly<{ eligible: true; plan: FactFormatRepairPlan }>
  | Readonly<{ eligible: false; reason: "not_needed" | "incomplete" | "invalid_protected_fields" | "unsupported_fact_shape" | "ambiguous_authority" | "invalid_result" }>;

type FactFormatRepairReason = Extract<FactFormatRepairResult, { eligible: false }>["reason"];

const ID_LABEL = /^[A-Za-z0-9_.:-]{0,200}$/u;
const UUID_SHAPED = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/u;

type VisibleFactIndex = Readonly<{
  exact: ReadonlyMap<string, VisibleRepairFact>;
  foldedUuid: ReadonlyMap<string, VisibleRepairFact>;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function isExactFactContent(value: unknown): value is string {
  return typeof value === "string" && value === value.trim() && value.length > 0 && value.length <= 4000;
}

function isContractUuid(value: unknown): value is string {
  return canonicalFactUpdateSchema.shape.supersedes_fact_ids.element.safeParse(value).success;
}

function isUuidShaped(value: string): boolean {
  return UUID_SHAPED.test(value);
}

function indexVisibleFacts(visibleFacts: readonly VisibleRepairFact[]): VisibleFactIndex | null {
  const exact = new Map<string, VisibleRepairFact>();
  const foldedUuid = new Map<string, VisibleRepairFact>();
  for (const visible of visibleFacts) {
    if (!isRecord(visible) || !isContractUuid(visible.id) || typeof visible.content !== "string") return null;
    const folded = visible.id.toLowerCase();
    if (exact.has(visible.id) || foldedUuid.has(folded)) return null;
    exact.set(visible.id, visible);
    foldedUuid.set(folded, visible);
  }
  return { exact, foldedUuid };
}

function hasExactVisibleTarget(id: string, visible: VisibleFactIndex): boolean {
  return visible.exact.has(id);
}

function hasConflictingUpdateTargets(story: StoryTurnOutput, visible: VisibleFactIndex): boolean {
  const targets = new Set<string>();
  for (const update of story.canonical_fact_updates) {
    for (const id of update.supersedes_fact_ids) {
      if (!hasExactVisibleTarget(id, visible) || targets.has(id)) return true;
      targets.add(id);
    }
  }
  return false;
}

function protectedCandidate(source: Record<string, unknown>): Record<string, unknown> {
  return { ...source, canonical_facts: [] };
}

const PROTECTED_STORY_FIELDS = [
  "choices", "custom_action_suggestion", "scratchpad", "tracker_updates", "image_prompt",
  "continuity_summary", "superseded_facts", "canonical_fact_updates", "open_threads"
] as const;

function preservesProtectedFields(source: Record<string, unknown>, story: StoryTurnOutput): boolean {
  return PROTECTED_STORY_FIELDS.every((field) => source[field] === undefined
    || stableStringify(source[field]) === stableStringify(story[field]));
}

function result(reason: FactFormatRepairReason): FactFormatRepairResult {
  return { eligible: false, reason };
}

/**
 * Proposes only representation-safe canonical-fact repairs. It never grants
 * authority, mutates a candidate, or changes normal parser acceptance.
 */
export function planFactFormatRepair(input: Readonly<{
  rawOutput: string;
  visibleFacts: readonly VisibleRepairFact[];
}>): FactFormatRepairResult {
  const normallyParsed = parseStoryOutput(input.rawOutput);
  if (normallyParsed.ok) return result("not_needed");

  let extracted: unknown;
  try {
    extracted = extractJsonObject(input.rawOutput);
  } catch {
    return result("incomplete");
  }
  if (!isRecord(extracted)) return result("invalid_protected_fields");

  const protectedSource = protectedCandidate(extracted);
  const protectedParsed = parseStoryOutput(JSON.stringify(protectedSource));
  if (!protectedParsed.ok || !preservesProtectedFields(protectedSource, protectedParsed.story)) return result("invalid_protected_fields");

  const facts = extracted.canonical_facts;
  if (!Array.isArray(facts) || facts.length > 100) return result("unsupported_fact_shape");

  const visible = indexVisibleFacts(input.visibleFacts);
  if (!visible || hasConflictingUpdateTargets(protectedParsed.story, visible)) return result("ambiguous_authority");

  const additions: string[] = [];
  const movedUpdates: StoryTurnOutput["canonical_fact_updates"] = [];
  const targetIds = new Set<string>(protectedParsed.story.canonical_fact_updates.flatMap((update) => update.supersedes_fact_ids));
  const changes: FactFormatChange[] = [];

  for (const [sourceIndex, fact] of facts.entries()) {
    if (typeof fact === "string") {
      if (!isExactFactContent(fact)) return result("unsupported_fact_shape");
      if (containsMechanicsLanguage(fact)) return result("invalid_protected_fields");
      additions.push(fact);
      continue;
    }
    if (!isRecord(fact)) return result("unsupported_fact_shape");

    if (hasExactKeys(fact, ["content"])) {
      if (!isExactFactContent(fact.content)) return result("unsupported_fact_shape");
      if (containsMechanicsLanguage(fact.content)) return result("invalid_protected_fields");
      additions.push(fact.content);
      continue;
    }

    if (hasExactKeys(fact, ["content", "id"])) {
      const { content, id } = fact;
      if (!isExactFactContent(content)) return result("unsupported_fact_shape");
      if (containsMechanicsLanguage(content)) return result("invalid_protected_fields");
      if (id !== null && typeof id !== "string") return result("unsupported_fact_shape");

      const visibleFact = typeof id === "string"
        ? visible.exact.get(id) ?? (isUuidShaped(id) ? visible.foldedUuid.get(id.toLowerCase()) : undefined)
        : undefined;
      if (visibleFact) {
        if (content !== visibleFact.content) return result("ambiguous_authority");
        changes.push({ sourceIndex, kind: "visible_reference_removed" });
        continue;
      }
      if (id === null || (typeof id === "string" && ID_LABEL.test(id))) {
        additions.push(content);
        changes.push({ sourceIndex, kind: "id_label_to_addition" });
        continue;
      }
      return result("unsupported_fact_shape");
    }

    if (hasExactKeys(fact, ["content", "estimatedTokens"])) {
      if (!isExactFactContent(fact.content)
        || typeof fact.estimatedTokens !== "number"
        || !Number.isFinite(fact.estimatedTokens)
        || !Number.isInteger(fact.estimatedTokens)
        || fact.estimatedTokens < 0) return result("unsupported_fact_shape");
      if (containsMechanicsLanguage(fact.content)) return result("invalid_protected_fields");
      additions.push(fact.content);
      changes.push({ sourceIndex, kind: "metadata_to_addition" });
      continue;
    }

    if (hasExactKeys(fact, ["content", "supersedes_fact_ids"])) {
      if (!isExactFactContent(fact.content) || !Array.isArray(fact.supersedes_fact_ids)) return result("unsupported_fact_shape");
      if (containsMechanicsLanguage(fact.content)) return result("invalid_protected_fields");
      const ids = fact.supersedes_fact_ids;
      if (!ids.every(isContractUuid)) return result("ambiguous_authority");
      if (!ids.length) {
        additions.push(fact.content);
        changes.push({ sourceIndex, kind: "metadata_to_addition" });
        continue;
      }
      if (new Set(ids).size !== ids.length || ids.some((id) => !hasExactVisibleTarget(id, visible) || targetIds.has(id))) return result("ambiguous_authority");
      ids.forEach((id) => targetIds.add(id));
      movedUpdates.push({ content: fact.content, supersedes_fact_ids: ids });
      changes.push({ sourceIndex, kind: "misplaced_update_moved" });
      continue;
    }

    return result("unsupported_fact_shape");
  }

  if (!changes.length) return result("not_needed");

  const proposed = {
    ...protectedParsed.story,
    canonical_facts: additions,
    canonical_fact_updates: [...protectedParsed.story.canonical_fact_updates, ...movedUpdates]
  };
  const finalParsed = parseStoryOutput(JSON.stringify(proposed));
  if (!finalParsed.ok) return result("invalid_result");

  const story = finalParsed.story;
  return {
    eligible: true,
    plan: {
      version: 1,
      rawOutputHash: sha256(input.rawOutput),
      visibleFactsHash: sha256(stableStringify(input.visibleFacts)),
      protectedFieldsHash: sha256(stableStringify(protectedSource)),
      resultHash: sha256(stableStringify(story)),
      story,
      changes
    }
  };
}
