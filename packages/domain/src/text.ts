import { createHash } from "node:crypto";

export type MechanicsLanguageMatch = {
  category: "dice" | "check" | "difficulty" | "numeric_resolution" | "result_label" | "engine_metadata";
  text: string;
  index: number;
};

const MECHANICS_LANGUAGE_PATTERNS: Array<Pick<MechanicsLanguageMatch, "category"> & { pattern: RegExp }> = [
  { category: "dice", pattern: /\b(?:d4|d6|d8|d10|d12|d20|d100)\b|\bd%/i },
  { category: "dice", pattern: /\brpg\s+(?:roll|check|stat|score|mechanic|result)\b/i },
  { category: "dice", pattern: /\b(?:percentile|die|dice)\s+(?:roll|check|test|result|total|outcome|score)\b/i },
  { category: "dice", pattern: /\broll(?:s|ed|ing)?\s+(?:a\s+|the\s+)?(?:die|dice)\b/i },
  { category: "dice", pattern: /\b(?:the|a)\s+(?:die|dice)\s+(?:shows?|showed|lands?|landed|comes?\s+up|came\s+up|reads?|total(?:s|ed)?)\b/i },
  { category: "dice", pattern: /\b(?:roll\s+(?:result|total|outcome)|roll\s+of\s+\d{1,3}|roll(?:s|ed|ing)?\s+(?:a\s+)?\d{1,3})\b/i },
  { category: "dice", pattern: /\broll(?:s|ed|ing)?\s+(?:well|poorly|badly|successfully)\b/i },
  { category: "dice", pattern: /\b(?:make|attempt|resolve|perform)\s+(?:a\s+|the\s+)?roll\b/i },
  { category: "check", pattern: /\b(?:stat|skill|ability|attribute|saving\s+throw)\s+(?:roll|check|test)\b/i },
  { category: "check", pattern: /\b(?:succeed(?:ed)?|fail(?:ed|ure)?)\s+(?:your\s+|the\s+|a\s+)?(?:roll|check|test)\b/i },
  { category: "check", pattern: /\b(?:roll|check|test)\s+(?:succeed(?:s|ed)?|fail(?:s|ed)?|pass(?:es|ed)?)\b/i },
  { category: "difficulty", pattern: /\bdifficulty\s+(?:class|modifier|rating|label|level)\b/i },
  { category: "difficulty", pattern: /\bdifficulty\s*[:=]\s*(?:trivial|easy|normal|standard|hard|very\s+hard|extreme|impossible|[+-]?\d{1,3})\b/i },
  { category: "numeric_resolution", pattern: /\bmodifier\s*[:=]?\s*[+-]?\d{1,3}\b/i },
  { category: "numeric_resolution", pattern: /[+-]\d{1,3}\s+(?:modifier|bonus|penalty)\b/i },
  { category: "numeric_resolution", pattern: /\b(?:bonus|penalty)\s+(?:of\s+)?[+-]?\d{1,3}\b/i },
  { category: "numeric_resolution", pattern: /\btarget\s+(?:number|score)\b/i },
  { category: "numeric_resolution", pattern: /\btarget\s+(?:number\s+)?(?:of\s+|was\s+|is\s+|[:=]\s*)?\d{1,3}(?:%|\b)/i },
  { category: "numeric_resolution", pattern: /\b(?:stat|skill|ability|attribute)\s+(?:score|value)\b/i },
  { category: "numeric_resolution", pattern: /\b\d{1,3}\s*%\s+(?:chance|target|stat|score)\b/i },
  { category: "numeric_resolution", pattern: /\b(?:armor\s+class|ac|hit\s+points?|hp|initiative|character\s+level)\s*[:=]?\s*[+-]?\d{1,4}\b/i },
  { category: "result_label", pattern: /\b(?:success|failure)\s+by\s+\d{1,3}\b/i },
  { category: "result_label", pattern: /\b(?:critical|automatic)\s+(?:success|failure)\b/i },
  { category: "result_label", pattern: /\b(?:success|failure)\s+(?:result|outcome|label)\b/i },
  { category: "engine_metadata", pattern: /\b(?:parser|parsing)\s+(?:error|failure|diagnostics?|exception)\b/i },
  { category: "engine_metadata", pattern: /\b(?:json|schema|validation)\s+(?:error|failure|failed|diagnostic|mismatch)\b/i },
  { category: "engine_metadata", pattern: /\b(?:raw|rejected|invalid|malformed)\s+(?:model\s+)?(?:output|response|narration|json)\b/i },
  { category: "engine_metadata", pattern: /\b(?:internal|private|hidden)\s+(?:reasoning|analysis|chain[- ]of[- ]thought)\b/i },
  { category: "engine_metadata", pattern: /\bchain[- ]of[- ]thought\b/i },
  { category: "engine_metadata", pattern: /\b(?:system|developer)\s+(?:prompt|message|instruction)\b/i },
  { category: "engine_metadata", pattern: /\bhidden instructions?\b/i }
];

export function mechanicsLanguageMatches(value: string): MechanicsLanguageMatch[] {
  const text = String(value ?? "");
  const matches: MechanicsLanguageMatch[] = [];
  const seen = new Set<string>();
  for (const entry of MECHANICS_LANGUAGE_PATTERNS) {
    const pattern = new RegExp(entry.pattern.source, `${entry.pattern.flags.replace("g", "")}g`);
    for (const match of text.matchAll(pattern)) {
      const matchedText = String(match[0] || "");
      const index = Number(match.index || 0);
      const key = `${index}:${matchedText.toLocaleLowerCase()}`;
      if (!matchedText || seen.has(key)) continue;
      seen.add(key);
      matches.push({ category: entry.category, text: matchedText, index });
    }
  }
  return matches.sort((left, right) => left.index - right.index || left.text.length - right.text.length);
}

export function containsMechanicsLanguage(value: string): boolean {
  return mechanicsLanguageMatches(value).length > 0;
}

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
      const leaked = containsMechanicsLanguage(sentence);
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

  let boundary = -1;
  // We must scan down to lower bounds such that even boundary = i - 1 is >= maximumCharacters * 0.55
  // Actually, the original checked `boundary >= maximumCharacters * 0.55`.
  const minBoundary = Math.ceil(maximumCharacters * 0.55);
  for (let i = candidate.length - 1; i >= minBoundary; i--) {
    const code = candidate.charCodeAt(i);
    if (code === 10) { // \n
      boundary = i;
      break;
    }
    if (code === 32 && i > 0) { // space
      const prevCode = candidate.charCodeAt(i - 1);
      if (prevCode === 46 || prevCode === 33 || prevCode === 63) { // . ! ?
        if (i - 1 >= maximumCharacters * 0.55) {
          boundary = i - 1;
          break;
        }
      }
    }
  }

  const cut = boundary !== -1 ? candidate.slice(0, boundary + 1) : candidate;
  return `${cut.trimEnd()}…`;
}

export function removeProviderSecrets(settings: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!settings) return {};
  const secretKeys = new Set(["apiKey", "customApiKey", "lmStudioApiKey", "imageApiKey", "token", "password"]);
  return Object.fromEntries(Object.entries(settings).map(([key, value]) => [key, secretKeys.has(key) ? "" : value]));
}
