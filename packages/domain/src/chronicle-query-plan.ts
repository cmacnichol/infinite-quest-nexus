import { sanitizeChronicleFictionString } from "./chronicle-memory-helpers.js";

export type ChronicleQueryKind = "action" | "entity_expanded" | "scene" | "open_thread";

export type ChronicleQueryVariant = Readonly<{
  kind: ChronicleQueryKind;
  query: string;
  entityIds: readonly string[];
}>;

export type ChronicleQueryHint = Readonly<{
  ordinal: number;
  content: string;
}>;

export type ChronicleEntityQueryHint = Readonly<{
  ordinal: number;
  entityId: string;
  terms: readonly string[];
}>;

export type ChronicleQueryLimits = Readonly<Record<ChronicleQueryKind, number>>;

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

function normalized(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/\s+/gu, " ").trim();
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
export function planChronicleQueries(input: ChronicleQueryPlanInput): readonly ChronicleQueryVariant[] {
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
    .sort((left, right) => left.ordinal - right.ordinal || left.entityId.localeCompare(right.entityId));
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
    .sort((left, right) => right.ordinal - left.ordinal || left.content.localeCompare(right.content))
    .map((hint) => hint.content);
  const openThreadParts = [...(input.openThreadHints ?? [])]
    .filter((hint) => eligible(hint.ordinal, input.throughTurnNumber))
    .sort((left, right) => right.ordinal - left.ordinal || left.content.localeCompare(right.content))
    .map((hint) => hint.content);

  const planned: ChronicleQueryVariant[] = [
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
  const seenQueries = new Set<string>();
  return Object.freeze(planned.flatMap((variant) => {
    const key = normalized(variant.query);
    if (!key || seenQueries.has(key)) return [];
    seenQueries.add(key);
    return [Object.freeze({ ...variant, entityIds: Object.freeze([...variant.entityIds]) })];
  }));
}
