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

const CHRONICLE_CHUNK_PARENT_PAGE_SIZE = 8;

type PreparedParent = Readonly<{
  parent: ChronicleChunkParent;
  drafts: readonly ChronicleChunkDraft[];
  oversizedIndexes: ReadonlySet<number>;
}>;

type PendingEmbedding = Readonly<{
  parentIndex: number;
  draftIndex: number;
  chunk: ChronicleChunkDraft;
}>;

type ChronicleChunkExecutionStage =
  | "parent_load"
  | "provider_capability"
  | "provider_load"
  | "provider_fingerprint"
  | "claim_prepare"
  | "chunk_prepare"
  | "embedding_batch"
  | "parent_commit"
  | "next_parent_load"
  | "provider_health_record";

type ChronicleChunkExecutionContext = Readonly<{
  executionStage: ChronicleChunkExecutionStage;
  parentMemoryId?: string;
  parentOrdinal?: number;
  attemptedBatchSize?: number;
  chunkCount?: number;
  embeddedChunkCount?: number;
  processedParents: number;
}>;

function annotateChunkExecutionError(
  error: unknown,
  context: ChronicleChunkExecutionContext,
): Error {
  const target = error instanceof Error
    ? error
    : new Error("Chronicle chunk execution failed with a non-Error value.", { cause: error });
  const inherited = (target as Error & { providerExecutionContext?: unknown }).providerExecutionContext;
  const inheritedContext = typeof inherited === "object" && inherited !== null ? inherited : {};
  const merged = Object.freeze({ ...inheritedContext, ...context });
  try {
    Object.defineProperty(target, "providerExecutionContext", {
      value: merged,
      configurable: true
    });
    return target;
  } catch {
    const wrapper = new Error("Chronicle chunk execution failed.", { cause: target });
    Object.defineProperty(wrapper, "providerExecutionContext", {
      value: merged,
      configurable: true
    });
    return wrapper;
  }
}

async function atChunkExecutionStage<T>(
  context: ChronicleChunkExecutionContext,
  operation: () => T | Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw annotateChunkExecutionError(error, context);
  }
}

function chunkExecutionError(
  message: string,
  context: ChronicleChunkExecutionContext,
): Error {
  return annotateChunkExecutionError(new Error(message), context);
}

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
  pendingEmbeddings: readonly PendingEmbedding[],
  capability: EmbeddingCapability,
): readonly (readonly PendingEmbedding[])[] {
  const batches: PendingEmbedding[][] = [];
  let current: PendingEmbedding[] = [];
  let tokens = 0;
  for (const pending of pendingEmbeddings) {
    const itemTokens = pending.chunk.estimatedTokens + capability.documentPrefixTokens;
    if (current.length && (current.length >= capability.maxBatchItems
      || tokens + itemTokens > capability.maxBatchTokens)) {
      batches.push(current);
      current = [];
      tokens = 0;
    }
    current.push(pending);
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
  lifecycle?: ChronicleClaimExecutionLifecycle,
) {
  const sleep = dependencies.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref();
  }));
  for (let attempt = 0; ; attempt += 1) {
    throwIfLeaseLost(lifecycle);
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
      let page = await atChunkExecutionStage({
        executionStage: "parent_load",
        processedParents: claim.progress.processedParents
      }, () => dependencies.parents.loadForClaim(claim, {
          batchLimit: CHRONICLE_CHUNK_PARENT_PAGE_SIZE,
          cursor: claim.progress.parentCursor
        }));
      if (claim.progress.totalParents && claim.progress.totalParents !== page.totalParents) {
        throw chunkExecutionError("Chronicle chunk parent total changed during resumed work.", {
          executionStage: "parent_load",
          processedParents: claim.progress.processedParents
        });
      }

      const semanticEnabled = Boolean(page.config.enabled
        && page.config.providerProfileId
        && page.config.model);
      if (!semanticEnabled && !page.config.retrievalShadowEnabled) {
        throw chunkExecutionError("Chronicle chunk indexing is no longer enabled for this campaign.", {
          executionStage: "provider_capability",
          processedParents: claim.progress.processedParents
        });
      }

      let provider: ChronicleTransactionEmbeddingExecution | null = null;
      let capability: EmbeddingCapability | null = null;
      let providerFingerprint: string | null = null;
      if (semanticEnabled) {
        if (!page.providerCapability) {
          throw chunkExecutionError("Chronicle chunk embedding provider capability is unavailable.", {
            executionStage: "provider_capability",
            processedParents: claim.progress.processedParents
          });
        }
        provider = await atChunkExecutionStage({
          executionStage: "provider_load",
          processedParents: claim.progress.processedParents
        }, () => dependencies.embeddings.load({
            ownerUserId: claim.ownerUserId,
            providerProfileId: page.config.providerProfileId!,
            model: page.config.model!
          }));
        capability = await atChunkExecutionStage({
          executionStage: "provider_capability",
          processedParents: claim.progress.processedParents
        }, () => withCampaignPrefixes(
            resolveEmbeddingCapability({
              model: page.providerCapability!.model,
              contextWindowTokens: page.providerCapability!.contextWindowTokens,
              requestTimeoutMs: page.providerCapability!.requestTimeoutMs,
              configuration: page.providerCapability!.configuration
            }),
            provider!.model,
            page.config.documentPrefix,
            page.config.queryPrefix,
            page.config.batchSize
          ));
        providerFingerprint = await atChunkExecutionStage({
          executionStage: "provider_fingerprint",
          processedParents: claim.progress.processedParents
        }, () => dependencies.embeddings.fingerprint(provider!, {
            documentPrefix: capability!.documentPrefix,
            queryPrefix: capability!.queryPrefix,
            automatic: page.config.documentPrefix == null && page.config.queryPrefix == null
          }));
      }
      throwIfLeaseLost(lifecycle);
      const fingerprint = capabilityFingerprint(providerFingerprint, capability);
      const preparation = await atChunkExecutionStage({
        executionStage: "claim_prepare",
        processedParents: claim.progress.processedParents
      }, () => dependencies.batches.prepareClaim(claim, {
          capabilityFingerprint: fingerprint
        }));
      if (preparation === "requeued") {
        throw chunkExecutionError("Chronicle chunk work version changed before execution.", {
          executionStage: "claim_prepare",
          processedParents: claim.progress.processedParents
        });
      }

      let progress = baseProgress(claim, page.totalParents, fingerprint);
      while (page.parents.length) {
        throwIfLeaseLost(lifecycle);
        const preparedParents: PreparedParent[] = [];
        for (const parent of page.parents) {
          preparedParents.push(await atChunkExecutionStage({
            executionStage: "chunk_prepare",
            parentMemoryId: parent.id,
            parentOrdinal: parent.ordinal,
            processedParents: progress.processedParents
          }, () => {
            const drafts = finalChunks(parent, capability ?? undefined);
            const oversizedIndexes = capability
              ? partitionEmbeddableChunks(drafts, capability).oversizedIndexes
              : new Set<number>();
            return { parent, drafts, oversizedIndexes };
          }));
        }
        const pendingEmbeddings: readonly PendingEmbedding[] = capability
          ? preparedParents.flatMap((prepared, parentIndex) => prepared.drafts.flatMap(
            (chunk, draftIndex) => prepared.oversizedIndexes.has(draftIndex)
              ? []
              : [{ parentIndex, draftIndex, chunk }]
          ))
          : [];
        const pageCostResults: ChronicleTransactionEmbeddingResult[] = [];
        const vectorsByParent: ((readonly number[] | undefined)[])[] = preparedParents.map(
          (prepared) => Array.from({ length: prepared.drafts.length })
        );
        if (provider && capability) {
          for (const batch of boundedBatches(pendingEmbeddings, capability)) {
            const firstPending = batch[0]!;
            const batchParent = preparedParents[firstPending.parentIndex]!.parent;
            try {
              const result = await atChunkExecutionStage({
                executionStage: "embedding_batch",
                parentMemoryId: batchParent.id,
                parentOrdinal: batchParent.ordinal,
                attemptedBatchSize: batch.length,
                processedParents: progress.processedParents
              }, () => embedWithRetry(
                  dependencies,
                  provider!,
                  batch.map((pending) => `${capability!.documentPrefix}${pending.chunk.content}`),
                  capability!,
                  lifecycle
                ));
              pageCostResults.push(result);
              for (const [resultIndex, vector] of result.embeddings.entries()) {
                const pending = batch[resultIndex]!;
                vectorsByParent[pending.parentIndex]![pending.draftIndex] = vector;
              }
            } catch (error) {
              throwIfLeaseLost(lifecycle);
              await dependencies.embeddings.recordHealth({
                ownerUserId: claim.ownerUserId,
                providerProfileId: provider.id,
                model: provider.model
              }, false, "chronicle_chunk_embedding_failed").catch(() => undefined);
              throw error;
            }
          }
        }
        for (const [parentIndex, prepared] of preparedParents.entries()) {
          const { parent, drafts, oversizedIndexes } = prepared;
          const chunks = drafts.map((chunk, draftIndex) => {
            const skipReason: ChronicleChunkSkipReason | null = !provider
              ? "semantic_retrieval_disabled"
              : oversizedIndexes.has(draftIndex)
                ? "chunk_exceeds_provider_capacity"
                : null;
            return {
              ...chunk,
              embedding: skipReason === null ? vectorsByParent[parentIndex]![draftIndex]! : null,
              skipReason
            };
          });
          const embeddingEvidence = chunks.flatMap((chunk) => chunk.embedding ? [chunk.embedding] : []);
          const embeddedCount = embeddingEvidence.length;
          const nextProgress: ChronicleChunkJobProgress = {
            parentCursor: `${parent.ordinal}:${parent.id}`,
            processedParents: progress.processedParents + 1,
            embeddedChunks: progress.embeddedChunks + embeddedCount,
            skippedChunks: progress.skippedChunks + (chunks.length - embeddedCount),
            totalParents: progress.totalParents,
            capabilityFingerprint: fingerprint
          };
          throwIfLeaseLost(lifecycle);
          const committed = await atChunkExecutionStage({
            executionStage: "parent_commit",
            parentMemoryId: parent.id,
            parentOrdinal: parent.ordinal,
            chunkCount: chunks.length,
            embeddedChunkCount: embeddedCount,
            processedParents: progress.processedParents
          }, () => dependencies.batches.commitParentBatch(claim, {
              parent,
              previousParentCursor: progress.parentCursor,
              provider,
              providerFingerprint,
              capabilityFingerprint: fingerprint,
              embeddingProtocolVersion: CHRONICLE_EMBEDDING_PROTOCOL_VERSION,
              chunks,
              embeddingEvidence,
              costResults: parentIndex === 0 ? pageCostResults : [],
              progress: nextProgress
            }));
          if (!committed) throw chunkExecutionError(
            "Chronicle chunk job lease was lost during parent commit.",
            {
              executionStage: "parent_commit",
              parentMemoryId: parent.id,
              parentOrdinal: parent.ordinal,
              chunkCount: chunks.length,
              embeddedChunkCount: embeddedCount,
              processedParents: progress.processedParents
            }
          );
          progress = nextProgress;
        }
        if (!page.nextCursor) break;
        page = await atChunkExecutionStage({
          executionStage: "next_parent_load",
          processedParents: progress.processedParents
        }, () => dependencies.parents.loadForClaim(claim, {
            batchLimit: CHRONICLE_CHUNK_PARENT_PAGE_SIZE,
            cursor: progress.parentCursor
          }));
        if (page.totalParents !== progress.totalParents) {
          throw chunkExecutionError("Chronicle chunk parent total changed during work.", {
            executionStage: "next_parent_load",
            processedParents: progress.processedParents
          });
        }
      }
      if (provider) {
        await atChunkExecutionStage({
          executionStage: "provider_health_record",
          processedParents: progress.processedParents
        }, () => dependencies.embeddings.recordHealth({
            ownerUserId: claim.ownerUserId,
            providerProfileId: provider!.id,
            model: provider!.model
          }, true));
      }
      throwIfLeaseLost(lifecycle);
      return progress;
    }
  };
}
