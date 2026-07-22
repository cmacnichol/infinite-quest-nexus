import { createHash } from "node:crypto";

export type CanonicalFactSeed = {
  campaignId: string;
  sourceTurnId: string;
  factIndex: number;
  content: string;
};

export type CanonicalFactProjection = CanonicalFactSeed & {
  id: string;
  normalizedContent: string;
  deduplicationKey: string;
};

/**
 * Normalizes presentation-only differences without changing fact semantics.
 * Content must already have passed the fiction/mechanics sanitization boundary.
 */
export function normalizeCanonicalFactContent(value: string): string {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/[\s\u00a0]+/gu, " ")
    .trim();
}

export function canonicalFactDeduplicationKey(value: string): string {
  return normalizeCanonicalFactContent(value).toLocaleLowerCase("en-US");
}

function lengthPrefixed(value: string): string {
  return `${Buffer.byteLength(value, "utf8")}:${value}`;
}

/**
 * Produces a deterministic RFC-compatible UUID from authoritative source
 * identity and sanitized fact content. This is a content-derived identifier,
 * not a random or database-generated UUID.
 */
export function createCanonicalFactId(seed: CanonicalFactSeed): string {
  const content = normalizeCanonicalFactContent(seed.content);
  const identity = [
    normalizeCanonicalFactContent(seed.campaignId),
    normalizeCanonicalFactContent(seed.sourceTurnId),
    String(seed.factIndex),
    content
  ].map(lengthPrefixed).join("|");
  const digest = createHash("sha256").update(identity, "utf8").digest();

  // Version 8 is reserved for application-defined UUIDs. SHA-256 supplies the
  // custom bits while preserving the interoperable UUID shape PostgreSQL uses.
  digest[6] = (digest[6]! & 0x0f) | 0x80;
  digest[8] = (digest[8]! & 0x3f) | 0x80;
  const hex = digest.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function buildCanonicalFactProjection(seeds: readonly CanonicalFactSeed[]): CanonicalFactProjection[] {
  const seen = new Set<string>();
  const projections: CanonicalFactProjection[] = [];

  for (const seed of seeds) {
    const content = normalizeCanonicalFactContent(seed.content);
    if (!content) continue;
    const deduplicationKey = canonicalFactDeduplicationKey(content);
    if (seen.has(deduplicationKey)) continue;
    seen.add(deduplicationKey);
    const normalizedSeed = { ...seed, content };
    projections.push({
      ...normalizedSeed,
      id: createCanonicalFactId(normalizedSeed),
      normalizedContent: content,
      deduplicationKey
    });
  }

  return projections;
}
