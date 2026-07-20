import { split } from "sentence-splitter";

const MINIMUM_UNBROKEN_LENGTH = 320;
const MINIMUM_PARAGRAPH_LENGTH = 180;
const TARGET_PARAGRAPH_LENGTH = 520;
const MAXIMUM_SENTENCES_PER_PARAGRAPH = 3;

function withoutWhitespace(value: string): string {
  return value.replace(/\s/gu, "");
}

function normalizeExistingParagraphs(value: string): string {
  return value
    .split(/\n\s*\n/u)
    .map((paragraph) => paragraph.trim().replace(/[ \t]+/gu, " "))
    .filter(Boolean)
    .join("\n\n");
}

function sentenceStrings(value: string): string[] {
  return split(value)
    .filter((node) => node.type === "Sentence")
    .map((node) => node.raw.trim())
    .filter(Boolean);
}

function beginsWithDialogue(sentence: string): boolean {
  return /^["'“‘«‹]/u.test(sentence);
}

/**
 * Add presentation-only paragraph whitespace without changing narration content.
 * Existing blank-line paragraphs are retained; otherwise long prose is grouped
 * using sentence boundaries, paragraph length, and dialogue transitions.
 */
export function formatNarrationParagraphs(content: string): string {
  const original = String(content ?? "");
  const trimmed = original.trim();
  if (!trimmed) return trimmed;

  if (/\n\s*\n/u.test(trimmed)) {
    const normalized = normalizeExistingParagraphs(trimmed);
    return withoutWhitespace(normalized) === withoutWhitespace(trimmed) ? normalized : trimmed;
  }

  const flattened = trimmed.replace(/\s+/gu, " ");
  if (flattened.length < MINIMUM_UNBROKEN_LENGTH) return flattened;

  const sentences = sentenceStrings(flattened);
  if (sentences.length < 2) return flattened;

  const paragraphs: string[] = [];
  let current: string[] = [];
  let currentLength = 0;
  let currentBeginsWithDialogue = false;

  for (const sentence of sentences) {
    const dialogue = beginsWithDialogue(sentence);
    const projectedLength = currentLength + (current.length ? 1 : 0) + sentence.length;
    const shouldBreak = current.length > 0 && (
      current.length >= MAXIMUM_SENTENCES_PER_PARAGRAPH
      || (projectedLength > TARGET_PARAGRAPH_LENGTH && currentLength >= MINIMUM_PARAGRAPH_LENGTH)
      || (dialogue !== currentBeginsWithDialogue && currentLength >= MINIMUM_PARAGRAPH_LENGTH)
    );
    if (shouldBreak) {
      paragraphs.push(current.join(" "));
      current = [];
      currentLength = 0;
    }
    if (!current.length) currentBeginsWithDialogue = dialogue;
    current.push(sentence);
    currentLength += (current.length > 1 ? 1 : 0) + sentence.length;
  }
  if (current.length) paragraphs.push(current.join(" "));

  if (paragraphs.length > 1 && paragraphs.at(-1)!.length < MINIMUM_PARAGRAPH_LENGTH / 2) {
    const last = paragraphs.pop()!;
    paragraphs[paragraphs.length - 1] = `${paragraphs.at(-1)} ${last}`;
  }

  const formatted = paragraphs.join("\n\n");
  return withoutWhitespace(formatted) === withoutWhitespace(trimmed) ? formatted : trimmed;
}
