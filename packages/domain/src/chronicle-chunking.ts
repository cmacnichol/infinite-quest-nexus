import { chronicleContentHash, sanitizeChronicleFictionString } from "./chronicle-memory-helpers.js";
import { estimateTokens } from "./text.js";

export const CHRONICLE_CHUNK_PROTOCOL_VERSION = "chronicle-chunk-v1" as const;

export type ChronicleMemoryKind =
  | "turn_fiction"
  | "canonical_fact"
  | "open_thread"
  | "campaign_summary"
  | "legacy_summary";

export type ChronicleChunkKind = Exclude<ChronicleMemoryKind, "turn_fiction"> | "turn_action" | "turn_narration";

/** An authoritative Chronicle memory projected without operational/private metadata. */
export type ChronicleMemoryParent = Readonly<{
  id: string;
  memoryKind: ChronicleMemoryKind;
  content: string;
}>;

export type ChronicleChunkingPolicy = Readonly<{
  protocolVersion: typeof CHRONICLE_CHUNK_PROTOCOL_VERSION;
  targetTokens: number;
  overlapTokens: number;
}>;

export const DEFAULT_CHRONICLE_CHUNKING_POLICY: ChronicleChunkingPolicy = Object.freeze({
  protocolVersion: CHRONICLE_CHUNK_PROTOCOL_VERSION,
  targetTokens: 384,
  overlapTokens: 32
});

export type ChronicleChunkDraft = Readonly<{
  protocolVersion: typeof CHRONICLE_CHUNK_PROTOCOL_VERSION;
  parentMemoryId: string;
  kind: ChronicleChunkKind;
  chunkIndex: number;
  content: string;
  contentHash: string;
  estimatedTokens: number;
  sourceStartOffset: number;
  sourceEndOffset: number;
}>;

type SourceText = Readonly<{ content: string; startOffset: number }>;

function normalizeChronicleText(value: string): string {
  return value.normalize("NFKC").replace(/\r\n?|\u2028|\u2029/gu, "\n").trim();
}

function validPolicy(policy: ChronicleChunkingPolicy): ChronicleChunkingPolicy {
  if (!Number.isSafeInteger(policy.targetTokens) || policy.targetTokens < 1) {
    throw new Error("Chronicle chunk target tokens must be a positive integer.");
  }
  if (!Number.isSafeInteger(policy.overlapTokens) || policy.overlapTokens < 0 || policy.overlapTokens >= policy.targetTokens) {
    throw new Error("Chronicle chunk overlap tokens must be smaller than the target.");
  }
  return policy;
}

function splitOversizedPiece(value: string, maximumTokens: number): string[] {
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (!normalized || estimateTokens(normalized) <= maximumTokens) return normalized ? [normalized] : [];
  const words = normalized.split(" ");
  const parts: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (current && estimateTokens(candidate) > maximumTokens) {
      parts.push(current);
      current = "";
    }
    if (!current && estimateTokens(word) > maximumTokens) {
      const characters = Math.max(1, maximumTokens * 4);
      for (let offset = 0; offset < word.length; offset += characters) parts.push(word.slice(offset, offset + characters));
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  if (current) parts.push(current);
  return parts;
}

function sentenceParts(value: string, maximumTokens: number): string[] {
  const parts = value.split(/(?<=[.!?])(?:[ \t]+|\n+)/gu).map((part) => part.trim()).filter(Boolean);
  return parts.flatMap((part) => splitOversizedPiece(part, maximumTokens));
}

function tailForOverlap(value: string, overlapTokens: number): string {
  if (!overlapTokens) return "";
  const words = value.trim().split(/\s+/u).filter(Boolean);
  const kept: string[] = [];
  for (let index = words.length - 1; index >= 0; index -= 1) {
    const candidate = [words[index]!, ...kept].join(" ");
    if (kept.length && estimateTokens(candidate) > overlapTokens) break;
    kept.unshift(words[index]!);
  }
  return kept.join(" ");
}

function overlapThatFits(previous: string, next: string, policy: ChronicleChunkingPolicy): string {
  const words = tailForOverlap(previous, policy.overlapTokens).split(/\s+/u).filter(Boolean);
  while (words.length) {
    const candidate = `${words.join(" ")}\n\n${next}`;
    if (estimateTokens(candidate) <= policy.targetTokens) return words.join(" ");
    words.shift();
  }
  return "";
}

function packNarrative(value: string, policy: ChronicleChunkingPolicy): string[] {
  const pieces = value.split(/\n{2,}/u).flatMap((paragraph) => sentenceParts(paragraph, policy.targetTokens));
  const chunks: string[] = [];
  let current = "";
  for (const piece of pieces) {
    const candidate = current ? `${current}\n\n${piece}` : piece;
    if (current && estimateTokens(candidate) > policy.targetTokens) {
      chunks.push(current);
      const overlap = overlapThatFits(current, piece, policy);
      current = overlap ? `${overlap}\n\n${piece}` : piece;
      continue;
    }
    current = candidate;
  }
  if (current) chunks.push(current);
  return chunks;
}

function chunkDrafts(
  parent: ChronicleMemoryParent,
  kind: ChronicleChunkKind,
  source: SourceText,
  policy: ChronicleChunkingPolicy,
  pack: boolean,
  startingIndex: number,
): ChronicleChunkDraft[] {
  const content = sanitizeChronicleFictionString(source.content, 1_000_000);
  if (!content) return [];
  const chunks = pack ? packNarrative(content, policy) : [content];
  let searchOffset = source.startOffset;
  return chunks.map((chunk, index) => {
    const found = source.content.indexOf(chunk, Math.max(0, searchOffset - source.startOffset));
    const sourceStartOffset = found < 0 ? searchOffset : source.startOffset + found;
    searchOffset = sourceStartOffset + Math.max(1, chunk.length);
    return Object.freeze({
      protocolVersion: CHRONICLE_CHUNK_PROTOCOL_VERSION,
      parentMemoryId: parent.id,
      kind,
      chunkIndex: startingIndex + index,
      content: chunk,
      contentHash: chronicleContentHash(chunk),
      estimatedTokens: estimateTokens(chunk),
      sourceStartOffset,
      sourceEndOffset: sourceStartOffset + chunk.length
    });
  });
}

function turnSources(content: string): readonly SourceText[] {
  const action = /^Turn\s+\d+\nPlayer action:\s*(.*?)\nNarration:\s*/isu.exec(content);
  if (!action) return [];
  const actionContent = action[1]!.trim();
  const actionStart = action.index + action[0].indexOf(action[1]!);
  const narrationStart = action.index + action[0].length;
  return [
    { content: actionContent, startOffset: actionStart },
    { content: content.slice(narrationStart).trim(), startOffset: narrationStart }
  ];
}

/**
 * Creates stable, fiction-only chunk drafts without observing credentials,
 * provider state, or mechanics/private Chronicle metadata.
 */
export function chunkChronicleMemory(
  parent: ChronicleMemoryParent,
  policy: ChronicleChunkingPolicy = DEFAULT_CHRONICLE_CHUNKING_POLICY,
): readonly ChronicleChunkDraft[] {
  const normalizedContent = normalizeChronicleText(parent.content);
  const normalizedParent = { ...parent, content: normalizedContent } as ChronicleMemoryParent;
  const safePolicy = validPolicy(policy);
  if (!normalizedContent) return [];
  if (parent.memoryKind === "turn_fiction") {
    const [action, narration] = turnSources(normalizedContent);
    if (!action || !narration) {
      return chunkDrafts(normalizedParent, "turn_narration", { content: normalizedContent, startOffset: 0 }, safePolicy, true, 0);
    }
    const actionChunks = chunkDrafts(normalizedParent, "turn_action", action, safePolicy, false, 0);
    const narrationChunks = chunkDrafts(normalizedParent, "turn_narration", narration, safePolicy, true, actionChunks.length);
    return Object.freeze([...actionChunks, ...narrationChunks]);
  }
  const pack = parent.memoryKind === "campaign_summary" || parent.memoryKind === "legacy_summary";
  return Object.freeze(chunkDrafts(normalizedParent, parent.memoryKind, {
    content: normalizedContent,
    startOffset: 0
  }, safePolicy, pack, 0));
}
