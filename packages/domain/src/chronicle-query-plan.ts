import { sanitizeChronicleFictionString } from "./chronicle-memory-helpers.js";
import type { LegacyStoryMemoryQueryVariant, StoryMemoryQueryVariant } from "../../contracts/src/story-memory-policy.js";
import { createStoryMemoryQueryVariant } from "../../contracts/src/story-memory-policy.js";

export type ChronicleQueryKind = StoryMemoryQueryVariant["kind"];
export type LegacyChronicleQueryVariant = LegacyStoryMemoryQueryVariant;
export type ChronicleQueryVariant = LegacyChronicleQueryVariant | StoryMemoryQueryVariant;

export type ChronicleQueryHint = Readonly<{
  ordinal: number;
  content: string;
}>;

export type ChronicleEntityQueryHint = Readonly<{
  ordinal: number;
  entityId: string;
  terms: readonly string[];
}>;

export type ChronicleQueryLimits = Readonly<Record<LegacyStoryMemoryQueryVariant["kind"], number>>;

export type ChronicleQueryPlanInput = Readonly<{
  action: string;
  throughTurnNumber?: number;
  entityHints?: readonly ChronicleEntityQueryHint[];
  sceneHints?: readonly ChronicleQueryHint[];
  openThreadHints?: readonly ChronicleQueryHint[];
  limits?: Partial<ChronicleQueryLimits>;
}>;

const DEFAULT_LIMITS: ChronicleQueryLimits = Object.freeze({
  action: 1_000,
  entity_expanded: 1_400,
  scene: 1_600,
  open_thread: 1_400
});

const QUERY_CONNECTIVES = new Set([
  "and", "again", "about", "from", "into", "that", "the", "their", "this", "with"
]);

function normalized(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();
}

function substantiveTerms(value: string): ReadonlySet<string> {
  return new Set(value.normalize("NFKC").toLocaleLowerCase("en-US")
    .match(/[\p{L}\p{N}]+/gu)
    ?.filter((term) => term.length >= 3 && !QUERY_CONNECTIVES.has(term)) ?? []);
}

function compareDeterministically(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function safeLimit(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Math.min(Number(value), 4_000) : fallback;
}

function eligible(ordinal: number, throughTurnNumber: number | undefined): boolean {
  return Number.isSafeInteger(ordinal) && ordinal >= 0
    && (throughTurnNumber === undefined || ordinal <= throughTurnNumber);
}

function queryFrom(parts: readonly string[], maximumCharacters: number): string {
  const seen = new Set<string>();
  const sanitized = parts.flatMap((part) => {
    const value = sanitizeChronicleFictionString(part, maximumCharacters);
    const key = normalized(value);
    if (!key || seen.has(key)) return [];
    seen.add(key);
    return [value];
  });
  return sanitizeChronicleFictionString(sanitized.join("\n"), maximumCharacters);
}

/**
 * Plans only bounded, fiction-safe queries from already scoped hints. Fields
 * outside this explicit input interface are deliberately unobservable.
 */
export function planChronicleQueries(input: ChronicleQueryPlanInput): readonly LegacyChronicleQueryVariant[] {
  const limits: ChronicleQueryLimits = {
    action: safeLimit(input.limits?.action, DEFAULT_LIMITS.action),
    entity_expanded: safeLimit(input.limits?.entity_expanded, DEFAULT_LIMITS.entity_expanded),
    scene: safeLimit(input.limits?.scene, DEFAULT_LIMITS.scene),
    open_thread: safeLimit(input.limits?.open_thread, DEFAULT_LIMITS.open_thread)
  };
  const action = queryFrom([input.action], limits.action);
  if (!action) return Object.freeze([]);

  const entityHints = [...(input.entityHints ?? [])]
    .filter((hint) => eligible(hint.ordinal, input.throughTurnNumber))
    .sort((left, right) => left.ordinal - right.ordinal
      || compareDeterministically(left.entityId, right.entityId));
  const actionTerms = normalized(action);
  const entityTerms: string[] = [];
  const entityIds: string[] = [];
  const seenTerms = new Set<string>();
  const seenEntityIds = new Set<string>();
  for (const hint of entityHints) {
    let hasSafeTerm = false;
    for (const term of hint.terms) {
      const safe = sanitizeChronicleFictionString(term, 200);
      const key = normalized(safe);
      if (!key) continue;
      hasSafeTerm = true;
      if (actionTerms.includes(key) || seenTerms.has(key)) continue;
      seenTerms.add(key);
      entityTerms.push(safe);
    }
    if (hasSafeTerm && !seenEntityIds.has(hint.entityId)) {
      seenEntityIds.add(hint.entityId);
      entityIds.push(hint.entityId);
    }
  }

  const sceneParts = [...(input.sceneHints ?? [])]
    .filter((hint) => eligible(hint.ordinal, input.throughTurnNumber))
    .sort((left, right) => right.ordinal - left.ordinal
      || compareDeterministically(normalized(left.content), normalized(right.content)))
    .map((hint) => hint.content);
  const openThreadParts = [...(input.openThreadHints ?? [])]
    .filter((hint) => eligible(hint.ordinal, input.throughTurnNumber))
    .sort((left, right) => right.ordinal - left.ordinal
      || compareDeterministically(normalized(left.content), normalized(right.content)))
    .map((hint) => hint.content);

  const planned: LegacyChronicleQueryVariant[] = [
    { kind: "action", query: action, entityIds: entityTerms.length ? [] : entityIds },
    ...(entityTerms.length ? [{
      kind: "entity_expanded" as const,
      query: queryFrom([input.action, ...entityTerms], limits.entity_expanded),
      entityIds
    }] : []),
    ...(sceneParts.length ? [{
      kind: "scene" as const,
      query: queryFrom([input.action, ...sceneParts], limits.scene),
      entityIds: []
    }] : []),
    ...(openThreadParts.length ? [{
      kind: "open_thread" as const,
      query: queryFrom([input.action, ...openThreadParts], limits.open_thread),
      entityIds: []
    }] : [])
  ];
  const coveredTerms = new Set<string>();
  const coveredEntityIds = new Set<string>();
  return Object.freeze(planned.flatMap((variant, index) => {
    const terms = substantiveTerms(variant.query);
    const addsTerms = [...terms].some((term) => !coveredTerms.has(term));
    const addsEntityIds = variant.entityIds.some((entityId) => !coveredEntityIds.has(entityId));
    if (index > 0 && !addsTerms && !addsEntityIds) return [];
    for (const term of terms) coveredTerms.add(term);
    for (const entityId of variant.entityIds) coveredEntityIds.add(entityId);
    return [Object.freeze({ ...variant, entityIds: Object.freeze([...variant.entityIds]) })];
  }));
}

/** Private generation planner. Offsets address the complete sanitized direction in UTF-16 units. */
export function planBalancedChronicleQueries(input: ChronicleQueryPlanInput & Readonly<{
  temporalHint?: Readonly<{ throughTurnNumber: number; label: string }>;
}>): Readonly<{
  version: "balanced-v1";
  variants: readonly StoryMemoryQueryVariant[];
  segmentCount: number;
  uncoveredSegmentCount: number;
  totalCharacters: number;
}> {
  const fiction = (value: string, limit: number) => sanitizeChronicleFictionString(
    value.replace(/\[\[?DC\s*[:=]?\s*\d+[^\]\r\n]*\]\]?/giu, ""), limit);
  const action = fiction(input.action, 12_000);
  const cap = 1_000;
  const entities = [...(input.entityHints ?? [])].filter((hint) => eligible(hint.ordinal, input.throughTurnNumber))
    .sort((a, b) => compareDeterministically(a.entityId, b.entityId));
  const hints = (values: readonly ChronicleQueryHint[] | undefined) => [...(values ?? [])]
    .filter((hint) => eligible(hint.ordinal, input.throughTurnNumber))
    .sort((a, b) => b.ordinal - a.ordinal || compareDeterministically(a.content, b.content));
  const threads = hints(input.openThreadHints);
  const sentenceEnds = [...new Intl.Segmenter("en", { granularity: "sentence" }).segment(action)]
    .map((part) => part.index + part.segment.length);
  const segments: { index: number; start: number; end: number }[] = [];
  let start = 0;
  while (start < action.length) {
    while (/\s/u.test(action[start] ?? "") && start < action.length) start += 1;
    if (start === action.length) break;
    const maximum = Math.min(start + cap, action.length);
    let end = sentenceEnds.filter((offset) => offset > start && offset <= maximum).at(-1) ?? maximum;
    if (end < action.length && !sentenceEnds.includes(end)) {
      const whitespace = action.slice(start, end).search(/\s+\S*$/u);
      if (whitespace > cap / 2) end = start + whitespace;
      if (/[\uD800-\uDBFF]/u.test(action[end - 1] ?? "")) end -= 1;
    }
    while (end > start && /\s/u.test(action[end - 1] ?? "")) end -= 1;
    segments.push({ index: segments.length, start, end });
    start = end;
  }
  const entityIdsFor = (text: string) => entities.filter((hint) => hint.terms.some((term) => {
    const safe = normalized(fiction(term, 200));
    return safe.length > 0 && normalized(text).includes(safe);
  })).map((hint) => hint.entityId).slice(0, 200);
  const chosen = new Set<number>();
  if (segments.length) {
    chosen.add(0);
    chosen.add(segments.length - 1);
    chosen.add(Math.floor((segments.length - 1) / 2));
  }
  const threadTerms = substantiveTerms(threads.map((hint) => hint.content).join(" "));
  const salient = segments.map((segment) => {
    const text = action.slice(segment.start, segment.end);
    return { index: segment.index, score: entityIdsFor(text).length * 100
      + [...substantiveTerms(text)].filter((term) => threadTerms.has(term)).length };
  }).sort((a, b) => b.score - a.score || a.index - b.index);
  for (const segment of salient) {
    if (chosen.size >= 4) break;
    chosen.add(segment.index);
  }
  const variants: StoryMemoryQueryVariant[] = [];
  const seen = new Set<string>();
  const covered = new Set<number>();
  for (const index of [...chosen].sort((a, b) => a - b)) {
    const segment = segments[index]!;
    const query = action.slice(segment.start, segment.end);
    const entityIds = entityIdsFor(query);
    const key = JSON.stringify([normalized(query), entityIds]);
    if (!seen.has(key)) {
      seen.add(key);
      variants.push(createStoryMemoryQueryVariant({ kind: "action", query, entityIds, actionSegment: segment, temporalHint: null }));
    }
    // Identical fragments have the same retrieval coverage even if only one is sent.
    for (const other of segments) if (normalized(action.slice(other.start, other.end)) === normalized(query)) covered.add(other.index);
  }
  const addHint = (kind: "entity_expanded" | "scene" | "open_thread" | "temporal_hint", parts: readonly string[],
    entityIds: readonly string[] = [], temporalHint: Readonly<{ throughTurnNumber: number; label: string }> | null = null) => {
    const hint = queryFrom(parts.map((part) => fiction(part, cap)), cap);
    if (!hint) return;
    // Hint first: even a maximum-length direction cannot crowd out its class.
    const remaining = cap - hint.length - 1;
    const prefix = remaining > 0 ? queryFrom([action], Math.min(500, remaining)) : "";
    const query = prefix ? `${hint}\n${prefix}` : hint;
    variants.push(createStoryMemoryQueryVariant({ kind, query, entityIds, actionSegment: null, temporalHint }));
  };
  if (action) {
    addHint("entity_expanded", entities.flatMap((hint) => hint.terms), entityIdsFor(action));
    addHint("scene", hints(input.sceneHints).map((hint) => hint.content));
    addHint("open_thread", threads.map((hint) => hint.content));
    if (input.temporalHint && eligible(input.temporalHint.throughTurnNumber, input.throughTurnNumber)) {
      const label = fiction(input.temporalHint.label, 200);
      if (label) addHint("temporal_hint", [label], [], { ...input.temporalHint, label });
    }
  }
  return Object.freeze({ version: "balanced-v1", variants: Object.freeze(variants), segmentCount: segments.length,
    uncoveredSegmentCount: segments.length - covered.size, totalCharacters: variants.reduce((sum, variant) => sum + variant.query.length, 0) });
}
