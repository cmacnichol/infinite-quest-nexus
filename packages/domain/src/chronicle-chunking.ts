import { chronicleContentHash } from "./chronicle-memory-helpers.js";
import { estimateTokens, sha256 } from "./text.js";
import { normalizeStoryEvidenceSource, splitStorySourceSpans, STORY_EVIDENCE_NORMALIZATION_VERSION, type StorySourceSpan } from "./story-evidence-spans.js";

export const CHRONICLE_CHUNK_PROTOCOL_VERSION = "chronicle-chunk-v1" as const;

/**
 * The closed set of sanitized reasons a derived chunk may carry instead of a vector.
 * `chunk_embedding_skipped` is the generic bucket every unrecognized reason collapses
 * into, so provider text can never reach the column. Every member is a terminal state
 * for chunk-index readiness.
 */
export const CHRONICLE_CHUNK_SKIP_REASONS = Object.freeze([
  "semantic_retrieval_disabled",
  "chunk_exceeds_provider_capacity",
  "chunk_embedding_skipped"
] as const);

export type ChronicleChunkSkipReason = (typeof CHRONICLE_CHUNK_SKIP_REASONS)[number];

export const CHRONICLE_GENERIC_CHUNK_SKIP_REASON: ChronicleChunkSkipReason = "chunk_embedding_skipped";

/** Collapses any reason outside the closed set into the generic bucket; never returns provider text. */
export function sanitizeChronicleChunkSkipReason(
  reason: string | null | undefined,
): ChronicleChunkSkipReason | null {
  if (!reason) return null;
  return (CHRONICLE_CHUNK_SKIP_REASONS as readonly string[]).includes(reason)
    ? reason as ChronicleChunkSkipReason
    : CHRONICLE_GENERIC_CHUNK_SKIP_REASON;
}

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
  sourceEvidence?: StorySourceSpan;
}>;

type SourceText = Readonly<{ content: string; startOffset: number }>;

function validPolicy(policy: ChronicleChunkingPolicy): ChronicleChunkingPolicy {
  if (!Number.isSafeInteger(policy.targetTokens) || policy.targetTokens < 1) {
    throw new Error("Chronicle chunk target tokens must be a positive integer.");
  }
  if (!Number.isSafeInteger(policy.overlapTokens) || policy.overlapTokens < 0 || policy.overlapTokens >= policy.targetTokens) {
    throw new Error("Chronicle chunk overlap tokens must be smaller than the target.");
  }
  return policy;
}

function chunkDrafts(
  parent: ChronicleMemoryParent,
  kind: ChronicleChunkKind,
  source: SourceText,
  policy: ChronicleChunkingPolicy,
  pack: boolean,
  startingIndex: number,
): ChronicleChunkDraft[] {
  const spans = pack ? splitStorySourceSpans(source.content, policy.targetTokens, policy.overlapTokens)
    : source.content ? [{ start: 0, end: source.content.length }] : [];
  const sourceHash = sha256(parent.content);
  return spans.map((span, index) => {
    const content = source.content.slice(span.start, span.end);
    const start = source.startOffset + span.start;
    const end = source.startOffset + span.end;
    return Object.freeze({ protocolVersion: CHRONICLE_CHUNK_PROTOCOL_VERSION,
      parentMemoryId: parent.id, kind, chunkIndex: startingIndex + index, content,
      contentHash: chronicleContentHash(content), estimatedTokens: estimateTokens(content),
      sourceStartOffset: start, sourceEndOffset: end,
      sourceEvidence: { normalizationVersion: STORY_EVIDENCE_NORMALIZATION_VERSION, sourceHash, start, end }
    });
  });
}

function turnSources(content: string): readonly SourceText[] {
  const action = /^Turn\s+\d+\n(?:Player action|Story Direction \(intent\)):\s*(.*?)\nNarration:\s*/isu.exec(content);
  if (!action) return [];
  const actionContent = action[1]!.trim();
  const actionStart = /^Turn\s+\d+\n(?:Player action|Story Direction \(intent\)):[ \t]*/u.exec(content)![0].length;
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
  const normalizedContent = normalizeStoryEvidenceSource(parent.content);
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
