import { createHash } from "node:crypto";
import { buildCanonicalFactProjection } from "./canonical-facts.js";
import {
  buildScopedEntityCatalog,
  resolveEntityMetadata,
  type EntityCatalogInput,
  type EntityReference
} from "./entity-references.js";
import { estimateTokens, extractEntities, stableStringify, stripMechanicsLeakage, truncateAtBoundary } from "./text.js";

export type EmbeddingProviderFingerprintInput = Readonly<{
  providerType: string;
  baseUrl: string;
  model: string;
  configuration?: unknown;
}>;

export type EmbeddingPrefixes = Readonly<{
  documentPrefix: string;
  queryPrefix: string;
  automatic: boolean;
}>;

export type ChronicleCanonicalFactInput = Readonly<{
  campaignId: string;
  turnId: string;
  canonicalFacts?: readonly string[];
  canonicalFactUpdates?: readonly Readonly<{
    content: string;
    supersedesFactIds?: readonly string[];
  }>[];
  entityCatalog: readonly EntityReference[];
}>;

export type ChronicleCanonicalFact = Readonly<{
  id: string;
  factIndex: number;
  content: string;
  normalizedContent: string;
  deduplicationKey: string;
  supersedesFactIds: readonly string[];
  entities: readonly string[];
  entityIds: readonly string[];
}>;

export function chronicleContentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function modelAwareEmbeddingPrefixes(
  model: string,
  documentPrefix: string | null,
  queryPrefix: string | null
): EmbeddingPrefixes {
  const nomic = /(?:^|[\/_-])nomic(?:[\/_-]|$)/i.test(model);
  return {
    documentPrefix: documentPrefix ?? (nomic ? "search_document: " : ""),
    queryPrefix: queryPrefix ?? (nomic ? "search_query: " : ""),
    automatic: documentPrefix === null && queryPrefix === null
  };
}

export function providerModelFingerprint(
  provider: EmbeddingProviderFingerprintInput,
  prefixes: EmbeddingPrefixes
): string {
  return chronicleContentHash(stableStringify({
    providerType: provider.providerType,
    baseUrl: provider.baseUrl.replace(/\/+$/, ""),
    model: provider.model,
    configuration: provider.configuration ?? {},
    documentPrefix: prefixes.documentPrefix,
    queryPrefix: prefixes.queryPrefix
  }));
}

export function embeddingEligibility(config: Readonly<{
  enabled: boolean;
  providerProfileId: string | null;
  model: string | null;
}>): Readonly<{ eligible: true }> | Readonly<{
  eligible: false;
  reason: "disabled" | "provider_not_configured" | "model_not_configured";
}> {
  if (!config.enabled) return { eligible: false, reason: "disabled" };
  if (!config.providerProfileId) return { eligible: false, reason: "provider_not_configured" };
  if (!config.model) return { eligible: false, reason: "model_not_configured" };
  return { eligible: true };
}

export function sanitizeChronicleFictionString(value: unknown, maximumCharacters = 4000): string {
  if (typeof value !== "string") return "";
  return truncateAtBoundary(stripMechanicsLeakage(value).text, maximumCharacters);
}

export function sanitizeChronicleFictionValue(value: unknown, depth = 0): unknown {
  if (depth > 5) return undefined;
  if (typeof value === "string") return sanitizeChronicleFictionString(value, 2000);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, 200).map((entry) => sanitizeChronicleFictionValue(entry, depth + 1));
  if (!value || typeof value !== "object") return undefined;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).flatMap(([key, entry]) => {
    const normalizedKey = key.replaceAll(/[^a-z]/gi, "").toLocaleLowerCase();
    if (["stat", "stats", "statistic", "statistics"].includes(normalizedKey)
      || ["roll", "dice", "check", "score", "target", "modifier", "difficulty", "reasoning", "diagnostic", "private", "scratchpad"]
        .some((prefix) => normalizedKey.startsWith(prefix))) return [];
    const sanitized = sanitizeChronicleFictionValue(entry, depth + 1);
    return sanitized === undefined || sanitized === "" ? [] : [[key, sanitized]];
  }));
}

export function sanitizeChronicleMemoryLines(values: readonly string[] | undefined, limit = 100): string[] {
  return [...new Set((values ?? []).flatMap((value) => {
    const sanitized = sanitizeChronicleFictionString(value, 4000);
    return sanitized ? [sanitized] : [];
  }))].slice(0, limit);
}

export function buildChronicleEntityCatalog(input: EntityCatalogInput): EntityReference[] {
  return buildScopedEntityCatalog(input);
}

export function buildAcceptedTurnFictionMemory(
  turn: Readonly<{ accepted: boolean; action: unknown; narration: unknown }> & Record<string, unknown>,
  ordinal: number
): Readonly<{
  content: string;
  tokenEstimate: number;
  entities: readonly string[];
  sanitized: boolean;
  removedMechanicsSegments: number;
}> | null {
  if (!turn.accepted) return null;
  const action = stripMechanicsLeakage(typeof turn.action === "string" ? turn.action.trim() : "");
  const narration = stripMechanicsLeakage(typeof turn.narration === "string" ? turn.narration.trim() : "");
  const content = [
    `Turn ${ordinal}`,
    action.text ? `Player action: ${action.text}` : "",
    narration.text ? `Narration: ${narration.text}` : ""
  ].filter(Boolean).join("\n");
  return {
    content,
    tokenEstimate: estimateTokens(content),
    entities: extractEntities(`${action.text}\n${narration.text}`),
    sanitized: action.changed || narration.changed,
    removedMechanicsSegments: action.removedSegments + narration.removedSegments
  };
}

export function buildCanonicalChronicleFacts(input: ChronicleCanonicalFactInput): ChronicleCanonicalFact[] {
  const structured = (input.canonicalFactUpdates ?? []).flatMap((update) => {
    const content = sanitizeChronicleFictionString(update.content, 4000);
    return content ? [{ content, supersedesFactIds: [...new Set(update.supersedesFactIds ?? [])].slice(0, 100) }] : [];
  });
  const source = structured.length
    ? structured
    : sanitizeChronicleMemoryLines(input.canonicalFacts).map((content) => ({ content, supersedesFactIds: [] as string[] }));
  const updates = new Map<string, { content: string; supersedesFactIds: string[] }>();
  for (const update of source) {
    const key = update.content.normalize("NFKC").replace(/[\s\u00a0]+/gu, " ").trim().toLocaleLowerCase("en-US");
    if (!updates.has(key)) updates.set(key, update);
  }
  const ordered = [...updates.values()];
  return buildCanonicalFactProjection(ordered.map((update, factIndex) => ({
    campaignId: input.campaignId,
    sourceTurnId: input.turnId,
    factIndex,
    content: update.content
  }))).map((projection, index) => {
    const metadata = resolveEntityMetadata(projection.content, input.entityCatalog);
    return {
      ...projection,
      supersedesFactIds: ordered[index]?.supersedesFactIds ?? [],
      entities: metadata.entities,
      entityIds: metadata.entityIds
    };
  });
}
