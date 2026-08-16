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
    maxBatchItems: safeOverride(provider, "embeddingMaxBatchItems") ?? 1,
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
  if (estimateTokens(content) <= maximumTokens) {
    return [{ startOffset: 0, endOffset: content.length }];
  }
  const spans: ContentSpan[] = [];
  let currentStart: number | null = null;
  let currentEnd = 0;
  for (const match of content.matchAll(/\S+/gu)) {
    const word = match[0];
    const wordStart = match.index!;
    const wordEnd = wordStart + word.length;
    if (currentStart !== null && estimateTokens(content.slice(currentStart, wordEnd)) > maximumTokens) {
      spans.push({ startOffset: currentStart, endOffset: currentEnd });
      currentStart = null;
    }
    if (currentStart === null && estimateTokens(word) > maximumTokens) {
      const characters = Math.max(1, maximumTokens * 4);
      for (let offset = 0; offset < word.length; offset += characters) {
        spans.push({
          startOffset: wordStart + offset,
          endOffset: Math.min(wordEnd, wordStart + offset + characters)
        });
      }
      continue;
    }
    if (currentStart === null) currentStart = wordStart;
    currentEnd = wordEnd;
  }
  if (currentStart !== null) spans.push({ startOffset: currentStart, endOffset: currentEnd });
  return spans;
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
      sourceEndOffset: chunk.sourceStartOffset + span.endOffset
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
