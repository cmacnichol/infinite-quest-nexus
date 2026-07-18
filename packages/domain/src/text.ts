import { createHash } from "node:crypto";

const MECHANICS_SENTENCE_PATTERNS = [
  /\b(?:d100|d20|dice roll|percentile roll|stat check|skill check|difficulty modifier)\b/i,
  /\b(?:rolled|roll result)\s+(?:a\s+)?\d{1,3}\b/i,
  /\btarget\s+(?:number\s+)?\d{1,3}%/i,
  /\b(?:success|failure)\s+by\s+\d{1,3}\b/i,
  /\b(?:modifier|difficulty)\s*[:=]\s*[+-]?\d+/i
];

const ENTITY_STOP_WORDS = new Set([
  "After", "Before", "Behind", "Beyond", "Chapter", "Continue", "During", "Finally", "However",
  "Infinite", "Inside", "Meanwhile", "Outside", "Player", "Story", "Suddenly", "The", "Then", "There",
  "They", "This", "Through", "Turn", "When", "Where", "While", "With", "Without"
]);

export function estimateTokens(text: string): number {
  const normalized = text.trim();
  if (!normalized) return 0;
  const words = normalized.match(/[\p{L}\p{N}_'-]+|[^\s]/gu)?.length ?? 0;
  return Math.max(1, Math.ceil(Math.max(normalized.length / 4, words * 0.72)));
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(",")}}`;
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function stripMechanicsLeakage(text: string): { text: string; changed: boolean; removedSegments: number } {
  const original = String(text ?? "").trim();
  if (!original) return { text: "", changed: false, removedSegments: 0 };
  let removedSegments = 0;
  const paragraphs = original.split(/\n{2,}/).map((paragraph) => {
    const segments = paragraph.split(/(?<=[.!?])\s+|\n+/).map((segment) => segment.trim()).filter(Boolean);
    const kept = segments.filter((sentence) => {
      const leaked = MECHANICS_SENTENCE_PATTERNS.some((pattern) => pattern.test(sentence));
      if (leaked) removedSegments += 1;
      return !leaked;
    });
    return kept.join(" ").replace(/\s+/g, " ").trim();
  }).filter(Boolean);
  const sanitized = paragraphs.join("\n\n").trim();
  return { text: sanitized, changed: sanitized !== original, removedSegments };
}

export function extractEntities(text: string, limit = 32): string[] {
  const matches = text.match(/\b[\p{Lu}][\p{L}'-]{2,}(?:\s+[\p{Lu}][\p{L}'-]{2,}){0,2}\b/gu) ?? [];
  const unique = new Map<string, string>();
  for (const match of matches) {
    const value = match.trim();
    if (ENTITY_STOP_WORDS.has(value) || value.length > 100) continue;
    unique.set(value.toLocaleLowerCase(), value);
    if (unique.size >= limit) break;
  }
  return [...unique.values()];
}

export function truncateAtBoundary(text: string, maximumCharacters: number): string {
  const value = String(text ?? "").trim();
  if (value.length <= maximumCharacters) return value;
  const candidate = value.slice(0, Math.max(0, maximumCharacters - 1));
  const boundary = Math.max(candidate.lastIndexOf(". "), candidate.lastIndexOf("! "), candidate.lastIndexOf("? "), candidate.lastIndexOf("\n"));
  const cut = boundary >= maximumCharacters * 0.55 ? candidate.slice(0, boundary + 1) : candidate;
  return `${cut.trimEnd()}…`;
}

export function removeProviderSecrets(settings: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!settings) return {};
  const secretKeys = new Set(["apiKey", "customApiKey", "lmStudioApiKey", "imageApiKey", "token", "password"]);
  return Object.fromEntries(Object.entries(settings).map(([key, value]) => [key, secretKeys.has(key) ? "" : value]));
}
