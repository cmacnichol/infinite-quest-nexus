import { splitStorySourceSpans } from "./story-evidence-spans.js";
import { chronicleContentHash, modelAwareEmbeddingPrefixes } from "./chronicle-memory-helpers.js";
import { estimateTokens } from "./text.js";
import { CHRONICLE_CHUNK_PROTOCOL_VERSION, type ChronicleChunkDraft } from "./chronicle-chunking.js";

export type EmbeddingCapability = Readonly<{
  maxInputTokens: number;
  maxBatchItems: number;
  maxBatchTokens: number;
  expectedDimensions: number | null;
  documentPrefix: string;
  queryPrefix: string;
  documentPrefixTokens: number;
  queryPrefixTokens: number;
  safetyMarginTokens: number;
  requestTimeoutMs: number;
  maxRetries: number;
}>;

export type EmbeddingCapabilityProvider = Readonly<{
  model: string;
  contextWindowTokens: number;
  requestTimeoutMs: number;
  configuration?: Readonly<Record<string, unknown>>;
}>;

type SafeOverrideKey =
  | "embeddingMaxInputTokens"
  | "embeddingMaxBatchItems"
  | "embeddingMaxBatchTokens"
  | "embeddingDimensions"
  | "embeddingMaxRetries";

const SAFE_OVERRIDE_RANGES: Readonly<Record<SafeOverrideKey, readonly [number, number]>> = Object.freeze({
  embeddingMaxInputTokens: [128, 1_000_000],
  embeddingMaxBatchItems: [1, 128],
  embeddingMaxBatchTokens: [128, 4_000_000],
  embeddingDimensions: [1, 16_000],
  embeddingMaxRetries: [0, 5]
});

function safeOverride(provider: EmbeddingCapabilityProvider, key: SafeOverrideKey): number | null {
  const value = provider.configuration?.[key];
  const [minimum, maximum] = SAFE_OVERRIDE_RANGES[key];
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum ? value : null;
}

/**
 * Unknown batch capacity used to mean one document per request, which made a full campaign
 * reindex cost one HTTP round trip per chunk and dominated indexing time on long campaigns.
 * OpenAI-compatible embedding endpoints accept a document array, and `assertCompleteEmbeddingBatch`
 * rejects any response that does not return one vector per requested document, so an under-
 * delivering provider fails loudly instead of being silently trusted. Campaign batch size still
 * lowers this, and `embeddingMaxBatchItems: 1` restores per-document requests.
 */
const UNKNOWN_MAX_BATCH_ITEMS = 16;

function unknownInputCapacity(contextWindowTokens: number): number {
  if (!Number.isSafeInteger(contextWindowTokens) || contextWindowTokens <= 0) {
    throw new Error("Embedding provider context window cannot provide a positive input capacity.");
  }
  const capacity = Math.min(8_192, Math.floor(contextWindowTokens / 2));
  if (capacity <= 0) {
    throw new Error("Embedding provider context window cannot provide a positive input capacity.");
  }
  return capacity;
}

/** Resolves only declared safe capability controls; credentials are not representable by this projection. */
export function resolveEmbeddingCapability(provider: EmbeddingCapabilityProvider): EmbeddingCapability {
  const prefixes = modelAwareEmbeddingPrefixes(provider.model, null, null);
  const unknownCapacity = unknownInputCapacity(provider.contextWindowTokens);
  const maxInputTokens = safeOverride(provider, "embeddingMaxInputTokens")
    ?? unknownCapacity;
  const documentPrefixTokens = estimateTokens(prefixes.documentPrefix);
  const queryPrefixTokens = estimateTokens(prefixes.queryPrefix);
  return Object.freeze({
    maxInputTokens,
    maxBatchItems: safeOverride(provider, "embeddingMaxBatchItems") ?? UNKNOWN_MAX_BATCH_ITEMS,
    maxBatchTokens: safeOverride(provider, "embeddingMaxBatchTokens") ?? maxInputTokens,
    expectedDimensions: safeOverride(provider, "embeddingDimensions"),
    documentPrefix: prefixes.documentPrefix,
    queryPrefix: prefixes.queryPrefix,
    documentPrefixTokens,
    queryPrefixTokens,
    safetyMarginTokens: Math.ceil(maxInputTokens * 0.08),
    requestTimeoutMs: provider.requestTimeoutMs,
    maxRetries: safeOverride(provider, "embeddingMaxRetries") ?? 2
  });
}

function contentBudget(capability: EmbeddingCapability): number {
  return Math.max(1, capability.maxInputTokens - capability.documentPrefixTokens - capability.safetyMarginTokens);
}

type ContentSpan = Readonly<{ startOffset: number; endOffset: number }>;

function splitContent(content: string, maximumTokens: number): readonly ContentSpan[] {
  return splitStorySourceSpans(content, maximumTokens).map((span) => ({ startOffset: span.start, endOffset: span.end }));
}

/** Replaces one draft with input-safe deterministic subchunks for a provider capability. */
export function splitChunkForCapability(
  chunk: ChronicleChunkDraft,
  capability: EmbeddingCapability,
): readonly ChronicleChunkDraft[] {
  const spans = splitContent(chunk.content, contentBudget(capability));
  return Object.freeze(spans.map((span, splitIndex) => {
    const content = chunk.content.slice(span.startOffset, span.endOffset);
    return Object.freeze({
      ...chunk,
      protocolVersion: CHRONICLE_CHUNK_PROTOCOL_VERSION,
      chunkIndex: chunk.chunkIndex + splitIndex,
      content,
      contentHash: chronicleContentHash(content),
      estimatedTokens: estimateTokens(content),
      sourceStartOffset: chunk.sourceStartOffset + span.startOffset,
      sourceEndOffset: chunk.sourceStartOffset + span.endOffset,
      ...(chunk.sourceEvidence ? { sourceEvidence: { ...chunk.sourceEvidence, start: chunk.sourceStartOffset + span.startOffset, end: chunk.sourceStartOffset + span.endOffset } } : {})
    });
  }));
}

/** Validates provider output before a complete batch can be committed or dimensions become pinned. */
export function assertCompleteEmbeddingBatch(
  embeddings: readonly (readonly number[])[],
  requestedItems: number,
  capability: EmbeddingCapability,
): number {
  if (!Number.isSafeInteger(requestedItems) || requestedItems < 1 || embeddings.length !== requestedItems) {
    throw new Error("Embedding response did not include every requested document.");
  }
  const dimensions = embeddings[0]?.length ?? 0;
  if (!dimensions || embeddings.some((vector) => vector.length !== dimensions || vector.some((value) => !Number.isFinite(value)))) {
    throw new Error("Embedding response dimensions are inconsistent.");
  }
  if (capability.expectedDimensions !== null && dimensions !== capability.expectedDimensions) {
    throw new Error("Embedding response dimensions do not match the configured capability.");
  }
  return dimensions;
}
