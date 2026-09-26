import { unescapeJsonString } from "./json-unescape.js";

const PARAGRAPHS_FIELD = /["']narration_paragraphs["']\s*:\s*\[/;

/** Converts story-native-v3 wire output to the local story-output-v2 shape. */
export function joinProviderNarration(value: unknown): { ok: true; value: unknown } | { ok: false; error: string } {
  if (!value || typeof value !== "object" || Array.isArray(value) || !("narration_paragraphs" in value)) return { ok: true, value };
  const { narration_paragraphs: paragraphs, ...rest } = value as Record<string, unknown>;
  if ("narration" in rest) return { ok: false, error: "narration: provide either narration or narration_paragraphs, not both." };
  if (!Array.isArray(paragraphs) || paragraphs.length === 0) return { ok: false, error: "narration_paragraphs: at least one paragraph is required." };
  const trimmed: string[] = [];
  for (const [index, paragraph] of paragraphs.entries()) {
    if (typeof paragraph !== "string") return { ok: false, error: `narration_paragraphs: paragraph ${index + 1} is not a string.` };
    const text = paragraph.trim();
    if (!text) return { ok: false, error: `narration_paragraphs: paragraph ${index + 1} is empty.` };
    trimmed.push(text);
  }
  return { ok: true, value: { ...rest, narration: trimmed.join("\n\n") } };
}

type ScannedItems = Readonly<{ items: string[]; closed: boolean }>;

// Tolerant of truncated streams; v3 output should contain no escapes, but
// legacy-shaped escapes (including \uXXXX, which many JSON encoders emit for
// curly quotes) are decoded rather than trusted blindly. Decoding is deferred
// to the end of each string so it can share unescapeJsonString's handling of
// a truncated trailing escape and of \uXXXX surrogate pairs.
function scanStringArray(raw: string, start: number): ScannedItems {
  const items: string[] = [];
  let index = start;
  while (index < raw.length) {
    const character = raw[index]!;
    if (character === "]") return { items, closed: true };
    if (character !== "\"") { index += 1; continue; }
    const contentStart = index + 1;
    let scan = contentStart;
    let escaped = false;
    let terminated = false;
    for (; scan < raw.length; scan += 1) {
      const current = raw[scan]!;
      if (escaped) { escaped = false; continue; }
      if (current === "\\") { escaped = true; continue; }
      if (current === "\"") { terminated = true; break; }
    }
    items.push(unescapeJsonString(raw.slice(contentStart, scan)));
    if (!terminated) return { items, closed: false };
    index = scan + 1;
  }
  return { items, closed: false };
}

/** Streaming-safe: complete items plus the in-progress item, or null when absent. */
export function extractPartialNarrationParagraphs(raw: string): string | null {
  const match = PARAGRAPHS_FIELD.exec(raw);
  if (!match) return null;
  return scanStringArray(raw, match.index + match[0].length).items.map((item) => item.trim()).filter(Boolean).join("\n\n");
}

export function isNarrationParagraphsComplete(raw: string): boolean {
  const match = PARAGRAPHS_FIELD.exec(raw);
  return match ? scanStringArray(raw, match.index + match[0].length).closed : false;
}
