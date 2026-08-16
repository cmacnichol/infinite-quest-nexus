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
  const halfContext = Math.floor(contextWindowTokens / 2);
  return Math.min(8_192, Number.isSafeInteger(halfContext) && halfContext > 0 ? halfContext : 8_192);
}

/** Resolves only declared safe capability controls; credentials are not representable by this projection. */
export function resolveEmbeddingCapability(provider: EmbeddingCapabilityProvider): EmbeddingCapability {
  const prefixes = modelAwareEmbeddingPrefixes(provider.model, null, null);
  const maxInputTokens = safeOverride(provider, "embeddingMaxInputTokens")
    ?? unknownInputCapacity(provider.contextWindowTokens);
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

function splitContent(content: string, maximumTokens: number): string[] {
  if (estimateTokens(content) <= maximumTokens) return [content];
  const words = content.split(/\s+/u).filter(Boolean);
  const chunks: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (current && estimateTokens(candidate) > maximumTokens) {
      chunks.push(current);
      current = "";
    }
    if (!current && estimateTokens(word) > maximumTokens) {
      const characters = Math.max(1, maximumTokens * 4);
      for (let offset = 0; offset < word.length; offset += characters) chunks.push(word.slice(offset, offset + characters));
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

/** Replaces one draft with input-safe deterministic subchunks for a provider capability. */
export function splitChunkForCapability(
  chunk: ChronicleChunkDraft,
  capability: EmbeddingCapability,
): readonly ChronicleChunkDraft[] {
  const pieces = splitContent(chunk.content, contentBudget(capability));
  let cursor = 0;
  return Object.freeze(pieces.map((content, chunkIndex) => {
    const found = chunk.content.indexOf(content, cursor);
    const localStart = found < 0 ? cursor : found;
    cursor = localStart + content.length;
    return Object.freeze({
      ...chunk,
      protocolVersion: CHRONICLE_CHUNK_PROTOCOL_VERSION,
      chunkIndex,
      content,
      contentHash: chronicleContentHash(content),
      estimatedTokens: estimateTokens(content),
      sourceStartOffset: chunk.sourceStartOffset + localStart,
      sourceEndOffset: chunk.sourceStartOffset + localStart + content.length
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
