import type {
  ChronicleChunkBatchPort,
  ChronicleChunkJobProgress,
  ChronicleChunkLeaseScope,
  ChronicleChunkParent,
  ChronicleChunkParentPort,
  ChronicleClaimExecutionLifecycle
} from "../../../packages/application/src/memory/index.js";
import {
  assertCompleteEmbeddingBatch,
  resolveEmbeddingCapability,
  splitChunkForCapability,
  type EmbeddingCapability
} from "../../../packages/domain/src/chronicle-embedding-capabilities.js";
import {
  CHRONICLE_CHUNK_PROTOCOL_VERSION,
  chunkChronicleMemory,
  type ChronicleChunkDraft,
  type ChronicleChunkSkipReason
} from "../../../packages/domain/src/chronicle-chunking.js";
import {
  CHRONICLE_EMBEDDING_PROTOCOL_VERSION,
  chronicleContentHash,
  modelAwareEmbeddingPrefixes
} from "../../../packages/domain/src/chronicle-memory-helpers.js";
import { estimateTokens, stableStringify } from "../../../packages/domain/src/text.js";
import type {
  ChronicleTransactionEmbeddingExecution,
  ChronicleTransactionEmbeddingProvider,
  ChronicleTransactionEmbeddingResult
} from "../../../packages/database/src/chronicle-repository.js";

export type ChronicleChunkEmbeddingWorkerPort = Readonly<{
  load(scope: Readonly<{
    ownerUserId: string;
    providerProfileId: string;
    model: string;
  }>): Promise<ChronicleTransactionEmbeddingExecution>;
  embed(
    provider: ChronicleTransactionEmbeddingExecution,
    documents: readonly string[],
  ): Promise<ChronicleTransactionEmbeddingResult>;
  fingerprint(
    provider: ChronicleTransactionEmbeddingProvider,
    prefixes: Readonly<{ documentPrefix: string; queryPrefix: string; automatic: boolean }>,
  ): Promise<string>;
  recordHealth(
    scope: Readonly<{ ownerUserId: string; providerProfileId: string; model: string }>,
    healthy: boolean,
    diagnostic?: string,
  ): Promise<void>;
}>;

export type ChronicleChunkWorkerExecutionDependencies = Readonly<{
  parents: ChronicleChunkParentPort;
  batches: ChronicleChunkBatchPort;
  embeddings: ChronicleChunkEmbeddingWorkerPort;
  sleep?: (milliseconds: number) => Promise<void>;
}>;

export type ChronicleChunkWorkerExecution = Readonly<{
  execute(
    claim: ChronicleChunkLeaseScope,
    lifecycle?: ChronicleClaimExecutionLifecycle,
  ): Promise<ChronicleChunkJobProgress>;
}>;

function throwIfLeaseLost(lifecycle?: ChronicleClaimExecutionLifecycle): void {
  lifecycle?.throwIfLeaseLost();
}

function withCampaignPrefixes(
  capability: EmbeddingCapability,
  model: string,
  documentPrefix: string | null | undefined,
  queryPrefix: string | null | undefined,
  campaignBatchSize: number | undefined,
): EmbeddingCapability {
  const prefixes = modelAwareEmbeddingPrefixes(model, documentPrefix ?? null, queryPrefix ?? null);
  return Object.freeze({
    ...capability,
    maxBatchItems: Math.min(capability.maxBatchItems, campaignBatchSize ?? capability.maxBatchItems),
    documentPrefix: prefixes.documentPrefix,
    queryPrefix: prefixes.queryPrefix,
    documentPrefixTokens: estimateTokens(prefixes.documentPrefix),
    queryPrefixTokens: estimateTokens(prefixes.queryPrefix)
  });
}

function finalChunks(parent: ChronicleChunkParent, capability?: EmbeddingCapability): readonly ChronicleChunkDraft[] {
  const drafted = chunkChronicleMemory({
    id: parent.id,
    memoryKind: parent.memoryKind,
    content: parent.content
  });
  const singleItemLimit = capability
    ? Math.min(capability.maxInputTokens, capability.maxBatchTokens)
    : null;
  const splitCapability = capability && singleItemLimit !== capability.maxInputTokens
    ? {
      ...capability,
      maxInputTokens: singleItemLimit!,
      safetyMarginTokens: Math.ceil(singleItemLimit! * 0.08)
    }
    : capability;
  const split = splitCapability
    ? drafted.flatMap((chunk) => splitChunkForCapability(chunk, splitCapability))
    : drafted;
  return Object.freeze(split.map((chunk, chunkIndex) => Object.freeze({ ...chunk, chunkIndex })));
}

/**
 * Splits drafts into the items that provably fit one provider request and the items that
 * do not. Deterministic chunk splitting normally leaves this empty; keeping the guard means
 * an unrepresentable chunk is skipped with a sanitized reason and its siblings still index,
 * rather than being submitted over the limit and silently truncated by the provider.
 */
export function partitionEmbeddableChunks(
  chunks: readonly ChronicleChunkDraft[],
  capability: EmbeddingCapability,
): Readonly<{ embeddable: readonly ChronicleChunkDraft[]; oversizedIndexes: ReadonlySet<number> }> {
  const embeddable: ChronicleChunkDraft[] = [];
  const oversizedIndexes = new Set<number>();
  const singleItemLimit = Math.min(capability.maxInputTokens, capability.maxBatchTokens);
  for (const [index, chunk] of chunks.entries()) {
    if (chunk.estimatedTokens + capability.documentPrefixTokens > singleItemLimit) {
      oversizedIndexes.add(index);
      continue;
    }
    embeddable.push(chunk);
  }
  return Object.freeze({ embeddable: Object.freeze(embeddable), oversizedIndexes });
}

function boundedBatches(
  chunks: readonly ChronicleChunkDraft[],
  capability: EmbeddingCapability,
): readonly (readonly ChronicleChunkDraft[])[] {
  const batches: ChronicleChunkDraft[][] = [];
  let current: ChronicleChunkDraft[] = [];
  let tokens = 0;
  for (const chunk of chunks) {
    const itemTokens = chunk.estimatedTokens + capability.documentPrefixTokens;
    if (current.length && (current.length >= capability.maxBatchItems
      || tokens + itemTokens > capability.maxBatchTokens)) {
      batches.push(current);
      current = [];
      tokens = 0;
    }
    current.push(chunk);
    tokens += itemTokens;
  }
  if (current.length) batches.push(current);
  return Object.freeze(batches.map((batch) => Object.freeze(batch)));
}

async function embedWithRetry(
  dependencies: ChronicleChunkWorkerExecutionDependencies,
  provider: ChronicleTransactionEmbeddingExecution,
  documents: readonly string[],
  capability: EmbeddingCapability,
) {
  const sleep = dependencies.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref();
  }));
  for (let attempt = 0; ; attempt += 1) {
    try {
      const result = await dependencies.embeddings.embed(provider, documents);
      assertCompleteEmbeddingBatch(result.embeddings, documents.length, capability);
      return result;
    } catch (error) {
      if (attempt >= Math.min(2, capability.maxRetries)) throw error;
      await sleep(250 * 2 ** attempt);
    }
  }
}

function capabilityFingerprint(
  providerFingerprint: string | null,
  capability: EmbeddingCapability | null,
): string {
  return chronicleContentHash(stableStringify({
    chunkProtocolVersion: CHRONICLE_CHUNK_PROTOCOL_VERSION,
    embeddingProtocolVersion: CHRONICLE_EMBEDDING_PROTOCOL_VERSION,
    providerFingerprint,
    capability
  }));
}

function baseProgress(claim: ChronicleChunkLeaseScope, totalParents: number, fingerprint: string): ChronicleChunkJobProgress {
  return {
    parentCursor: claim.progress.parentCursor,
    processedParents: claim.progress.processedParents,
    embeddedChunks: claim.progress.embeddedChunks,
    skippedChunks: claim.progress.skippedChunks,
    totalParents: claim.progress.totalParents || totalParents,
    capabilityFingerprint: fingerprint
  };
}

export function createChronicleChunkWorkerExecution(
  dependencies: ChronicleChunkWorkerExecutionDependencies,
): ChronicleChunkWorkerExecution {
  return {
    async execute(claim, lifecycle) {
      throwIfLeaseLost(lifecycle);
      let page = await dependencies.parents.loadForClaim(claim, {
        batchLimit: 1,
        cursor: claim.progress.parentCursor
      });
      if (claim.progress.totalParents && claim.progress.totalParents !== page.totalParents) {
        throw new Error("Chronicle chunk parent total changed during resumed work.");
      }

      const semanticEnabled = Boolean(page.config.enabled
        && page.config.providerProfileId
        && page.config.model);
      if (!semanticEnabled && !page.config.retrievalShadowEnabled) {
        throw new Error("Chronicle chunk indexing is no longer enabled for this campaign.");
      }

      let provider: ChronicleTransactionEmbeddingExecution | null = null;
      let capability: EmbeddingCapability | null = null;
      let providerFingerprint: string | null = null;
      if (semanticEnabled) {
        if (!page.providerCapability) {
          throw new Error("Chronicle chunk embedding provider capability is unavailable.");
        }
        provider = await dependencies.embeddings.load({
          ownerUserId: claim.ownerUserId,
          providerProfileId: page.config.providerProfileId!,
          model: page.config.model!
        });
        capability = withCampaignPrefixes(
          resolveEmbeddingCapability({
            model: page.providerCapability.model,
            contextWindowTokens: page.providerCapability.contextWindowTokens,
            requestTimeoutMs: page.providerCapability.requestTimeoutMs,
            configuration: page.providerCapability.configuration
          }),
          provider.model,
          page.config.documentPrefix,
          page.config.queryPrefix,
          page.config.batchSize
        );
        providerFingerprint = await dependencies.embeddings.fingerprint(provider, {
          documentPrefix: capability.documentPrefix,
          queryPrefix: capability.queryPrefix,
          automatic: page.config.documentPrefix == null && page.config.queryPrefix == null
        });
      }
      throwIfLeaseLost(lifecycle);
      const fingerprint = capabilityFingerprint(providerFingerprint, capability);
      const preparation = await dependencies.batches.prepareClaim(claim, {
        capabilityFingerprint: fingerprint
      });
      if (preparation === "requeued") {
        throw new Error("Chronicle chunk work version changed before execution.");
      }

      let progress = baseProgress(claim, page.totalParents, fingerprint);
      while (page.parents.length) {
        throwIfLeaseLost(lifecycle);
        const parent = page.parents[0]!;
        const drafts = finalChunks(parent, capability ?? undefined);
        const partition = capability
          ? partitionEmbeddableChunks(drafts, capability)
          : { embeddable: [] as readonly ChronicleChunkDraft[], oversizedIndexes: new Set<number>() };
        const results = [];
        const vectors: (readonly number[])[] = [];
        if (provider && capability) {
          for (const batch of boundedBatches(partition.embeddable, capability)) {
            throwIfLeaseLost(lifecycle);
            try {
              const result = await embedWithRetry(
                dependencies,
                provider,
                batch.map((chunk) => `${capability!.documentPrefix}${chunk.content}`),
                capability
              );
              results.push(result);
              vectors.push(...result.embeddings);
            } catch (error) {
              await dependencies.embeddings.recordHealth({
                ownerUserId: claim.ownerUserId,
                providerProfileId: provider.id,
                model: provider.model
              }, false, "chronicle_chunk_embedding_failed").catch(() => undefined);
              throw error;
            }
          }
        }
        let vectorIndex = 0;
        const chunks = drafts.map((chunk, index) => {
          const skipReason: ChronicleChunkSkipReason | null = !provider
            ? "semantic_retrieval_disabled"
            : partition.oversizedIndexes.has(index)
              ? "chunk_exceeds_provider_capacity"
              : null;
          return {
            ...chunk,
            embedding: skipReason === null ? vectors[vectorIndex++]! : null,
            skipReason
          };
        });
        const embeddedCount = chunks.filter((chunk) => chunk.skipReason === null).length;
        const nextProgress: ChronicleChunkJobProgress = {
          parentCursor: `${parent.ordinal}:${parent.id}`,
          processedParents: progress.processedParents + 1,
          embeddedChunks: progress.embeddedChunks + embeddedCount,
          skippedChunks: progress.skippedChunks + (chunks.length - embeddedCount),
          totalParents: progress.totalParents,
          capabilityFingerprint: fingerprint
        };
        throwIfLeaseLost(lifecycle);
        const committed = await dependencies.batches.commitParentBatch(claim, {
          parent,
          previousParentCursor: progress.parentCursor,
          provider,
          providerFingerprint,
          capabilityFingerprint: fingerprint,
          embeddingProtocolVersion: CHRONICLE_EMBEDDING_PROTOCOL_VERSION,
          chunks,
          results,
          progress: nextProgress
        });
        if (!committed) throw new Error("Chronicle chunk job lease was lost during parent commit.");
        progress = nextProgress;
        if (!page.nextCursor) break;
        page = await dependencies.parents.loadForClaim(claim, {
          batchLimit: 1,
          cursor: progress.parentCursor
        });
        if (page.totalParents !== progress.totalParents) {
          throw new Error("Chronicle chunk parent total changed during work.");
        }
      }
      if (provider) {
        await dependencies.embeddings.recordHealth({
          ownerUserId: claim.ownerUserId,
          providerProfileId: provider.id,
          model: provider.model
        }, true);
      }
      throwIfLeaseLost(lifecycle);
      return progress;
    }
  };
}
