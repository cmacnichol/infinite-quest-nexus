export type StructuredRecordKind = "character" | "entity" | "relationship" | "stat" | "trigger" | "asset";
export type AdvancedJsonShape = "object" | "array";

export interface AdvancedJsonResult<T = unknown> {
  value: T | null;
  error: string | null;
}

type AliasDefinitions = Record<string, readonly string[]>;

const FIELD_ALIASES: Record<Exclude<StructuredRecordKind, "asset">, AliasDefinitions> = {
  character: {
    name: ["name"],
    characterText: ["characterText"],
    profile: ["profile"],
    rpgStats: ["rpgStats"],
    defaultTriggers: ["defaultTriggers"]
  },
  entity: {
    name: ["name", "title"],
    type: ["type", "kind"],
    description: ["description", "notes"]
  },
  relationship: {
    source: ["source", "from", "sourceId"],
    target: ["target", "to", "targetId"],
    type: ["type", "kind"],
    description: ["description", "notes"]
  },
  stat: {
    name: ["name", "skill", "stat"],
    value: ["value", "score", "rating"],
    note: ["note", "covers"]
  },
  trigger: {
    name: ["name", "title", "label"],
    condition: ["condition", "when"],
    effect: ["effect", "then", "rules"]
  }
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clone<T>(value: T): T {
  return typeof structuredClone === "function"
    ? structuredClone(value)
    : JSON.parse(JSON.stringify(value)) as T;
}

function displayed(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

export function structuredFieldsFor(
  kind: Exclude<StructuredRecordKind, "asset">,
  value: unknown
): Record<string, unknown> {
  const record = isRecord(value) ? value : {};
  return Object.fromEntries(Object.entries(FIELD_ALIASES[kind]).map(([field, aliases]) => {
    const alias = aliases.find((candidate) => Object.hasOwn(record, candidate));
    return [field, alias === undefined ? undefined : clone(record[alias])];
  }));
}

export function mergeStructuredFields(
  kind: Exclude<StructuredRecordKind, "asset">,
  original: unknown,
  changes: Record<string, unknown>
): Record<string, unknown> {
  const merged = clone(isRecord(original) ? original : {});
  for (const [field, aliases] of Object.entries(FIELD_ALIASES[kind])) {
    if (!Object.hasOwn(changes, field)) continue;
    const key = aliases.find((candidate) => Object.hasOwn(merged, candidate)) ?? aliases[0]!;
    const nextValue = changes[field];
    if (kind === "character" && field === "profile" && isRecord(merged[key]) && isRecord(nextValue)) {
      merged[key] = { ...clone(merged[key]), ...clone(nextValue) };
    } else {
      merged[key] = clone(nextValue);
    }
  }
  return merged;
}

export function parseAdvancedJson<T = unknown>(
  source: string,
  expectedShape: AdvancedJsonShape
): AdvancedJsonResult<T> {
  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch {
    return { value: null, error: "Enter valid JSON." };
  }
  if (expectedShape === "array" && !Array.isArray(value)) {
    return { value: null, error: "Expected a JSON array." };
  }
  if (expectedShape === "object" && !isRecord(value)) {
    return { value: null, error: "Expected a JSON object." };
  }
  return { value: value as T, error: null };
}

export function serializeAdvancedJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function collectionItemSummary(kind: StructuredRecordKind, value: unknown, index = 0): string {
  if (!isRecord(value)) {
    const scalar = displayed(value);
    return `${scalar || `Untitled ${kind}`} · ${kind === "asset" ? "Asset" : "Item"} ${index + 1}`;
  }
  const fields = kind === "asset" ? value : structuredFieldsFor(kind, value);
  if (kind === "relationship") {
    const source = displayed(fields.source);
    const target = displayed(fields.target);
    const connection = source || target ? `${source || "?"} → ${target || "?"}` : "Untitled relationship";
    return `${connection} · ${displayed(fields.type) || "relationship"}`;
  }
  const title = displayed(fields.name) || displayed(value.filename) || displayed(value.id) || `Untitled ${kind}`;
  const detail = displayed(fields.type) || displayed(value.mimeType) || `${kind === "asset" ? "Asset" : "Item"} ${index + 1}`;
  return `${title} · ${detail}`;
}
