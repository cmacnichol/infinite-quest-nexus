import { sanitizeChronicleFictionString } from "./chronicle-memory-helpers.js";
import { sha256, estimateTokens } from "./text.js";

export const STORY_EVIDENCE_NORMALIZATION_VERSION = "story-fiction-source-v1" as const;
export type StorySourceSpan = Readonly<{ normalizationVersion: typeof STORY_EVIDENCE_NORMALIZATION_VERSION;
  sourceHash: string; start: number; end: number }>;

/** UTF-16 offsets address this complete, versioned fiction-only representation. */
export function normalizeStoryEvidenceSource(value: string): string {
  const normalized = value.normalize("NFKC").replace(/\r\n?|\u2028|\u2029/gu, "\n").trim();
  const turn = /^(Turn\s+\d+)\n(Player action|Story Direction \(intent\)):\s*([\s\S]*?)\nNarration:\s*([\s\S]*)$/u.exec(normalized);
  const safe = (text: string) => sanitizeChronicleFictionString(text, Number.MAX_SAFE_INTEGER).trim();
  if (turn) return `${turn[1]}\n${turn[2]}: ${safe(turn[3]!)}\nNarration: ${safe(turn[4]!)}`;
  return normalized.split("\n").map(safe).join("\n").trim();
}
export function isSourceBoundary(value: string, offset: number): boolean {
  return Number.isSafeInteger(offset) && offset >= 0 && offset <= value.length
    && !(offset > 0 && offset < value.length && /[\uD800-\uDBFF]/u.test(value[offset - 1]!) && /[\uDC00-\uDFFF]/u.test(value[offset]!));
}
export function verifyStoryEvidenceSpan(source: string, span: StorySourceSpan, content: string): boolean {
  return span.normalizationVersion === STORY_EVIDENCE_NORMALIZATION_VERSION && span.sourceHash === sha256(source)
    && isSourceBoundary(source, span.start) && isSourceBoundary(source, span.end) && span.end > span.start
    && source.slice(span.start, span.end) === content;
}
/** Contiguous source slices: no synthetic separators or guessed fallback offsets. */
export function splitStorySourceSpans(source: string, targetTokens: number, overlapTokens = 0): readonly { start: number; end: number }[] {
  if (!Number.isSafeInteger(targetTokens) || targetTokens < 1 || overlapTokens < 0 || overlapTokens >= targetTokens) throw new Error("Invalid source span budget.");
  const spans: { start: number; end: number }[] = [];
  let start = 0;
  while (start < source.length) {
    while (/\s/u.test(source[start] ?? "") && start < source.length) start++;
    if (start >= source.length) break;
    let low = start + 1;
    let high = Math.min(source.length, start + targetTokens * 4);
    let end = low;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      if (estimateTokens(source.slice(start, middle)) <= targetTokens) { end = middle; low = middle + 1; }
      else high = middle - 1;
    }
    if (!isSourceBoundary(source, end)) end--;
    if (end <= start) end = start + (isSourceBoundary(source, start + 1) ? 1 : 2);
    if (end < source.length) {
      const text = source.slice(start, end);
      const boundaries = [...text.matchAll(/\s+/gu)];
      const boundary = boundaries.at(-1)?.index;
      if (boundary !== undefined && boundary > 0) end = start + boundary;
    }
    while (end > start && /\s/u.test(source[end - 1]!)) end--;
    spans.push({ start, end });
    if (end >= source.length) break;
    let next = end;
    if (overlapTokens) {
      next = Math.max(start + 1, end - overlapTokens * 4);
      while (next < end && (!isSourceBoundary(source, next) || !/\s/u.test(source[next - 1]!))) next++;
      while (next < end && estimateTokens(source.slice(next, end)) > overlapTokens) next++;
      if (!isSourceBoundary(source, next)) next++;
    }
    start = next > start ? next : end;
  }
  return spans;
}

/** Expands certified hits to complete sentences plus adjacent context, never synthetic prose. */
export function selectVerifiedNarrativeExcerpt(source: string, hits: readonly StorySourceSpan[]): Readonly<{
  normalizationVersion: typeof STORY_EVIDENCE_NORMALIZATION_VERSION; sourceHash: string;
  spans: readonly Readonly<{ start: number; end: number }>[]; content: string;
}> | null {
  if (!hits.length || hits.some((span) => !verifyStoryEvidenceSpan(source, span, source.slice(span.start, span.end)))) return null;
  const sentences = [...new Intl.Segmenter("en", { granularity: "sentence" }).segment(source)]
    .map((sentence) => ({ start: sentence.index, end: sentence.index + sentence.segment.length }));
  const expanded = hits.map((hit) => {
    const first = sentences.findIndex((sentence) => sentence.end > hit.start);
    const last = sentences.findLastIndex((sentence) => sentence.start < hit.end);
    return { start: sentences[Math.max(0, first - 1)]!.start, end: sentences[Math.min(sentences.length - 1, last + 1)]!.end };
  }).sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: { start: number; end: number }[] = [];
  for (const span of expanded) {
    const prior = merged.at(-1);
    if (prior && span.start <= prior.end) prior.end = Math.max(prior.end, span.end);
    else merged.push({ ...span });
  }
  return { normalizationVersion: STORY_EVIDENCE_NORMALIZATION_VERSION, sourceHash: sha256(source), spans: merged,
    content: merged.map((span) => source.slice(span.start, span.end)).join("\n[…]\n") };
}
