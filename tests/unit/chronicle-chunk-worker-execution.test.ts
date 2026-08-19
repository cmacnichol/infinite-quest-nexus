import { describe, expect, it, vi } from "vitest";
import type {
  ClaimedChronicleChunkJob,
  ChronicleChunkBatchPort,
  ChronicleChunkParentPort
} from "../../packages/application/src/memory/index.js";
import {
  createChronicleChunkWorkerExecution,
  partitionEmbeddableChunks
} from "../../services/runtime/src/chronicle-chunk-worker-execution.js";
import { createChronicleWorkerExecutor } from "../../services/runtime/src/chronicle-platform-adapter.js";
import { estimateTokens } from "../../packages/domain/src/text.js";

const claim: ClaimedChronicleChunkJob = {
  jobId: "chunk-job-1",
  ownerUserId: "11111111-1111-4111-8111-111111111111",
  campaignId: "22222222-2222-4222-8222-222222222222",
  worldVersionId: "33333333-3333-4333-8333-333333333333",
  jobType: "index_memory_chunks_v2",
  workVersion: 4,
  workerId: "chunk-worker-1",
  leaseToken: "77777777-7777-4777-8777-777777777777",
  leaseSeconds: 30,
  progress: {
    parentCursor: "6:44444444-4444-4444-8444-444444444444",
    processedParents: 1,
    embeddedChunks: 2,
    skippedChunks: 0,
    totalParents: 2,
    capabilityFingerprint: null
  }
};

function parentPage() {
  return {
    config: {
      enabled: true,
      providerProfileId: "55555555-5555-4555-8555-555555555555",
      model: "embed-v1",
      batchSize: 16,
      retrievalImplementation: "legacy_hybrid" as const,
      retrievalShadowEnabled: false
    },
    providerCapability: {
      model: "embed-v1",
      contextWindowTokens: 1_024,
      requestTimeoutMs: 10_000,
      configuration: {
        embeddingMaxInputTokens: 128,
        embeddingMaxBatchItems: 2,
        embeddingMaxBatchTokens: 70,
        embeddingDimensions: 2,
        embeddingMaxRetries: 5
      }
    },
    parents: [{
      id: "66666666-6666-4666-8666-666666666666",
      ordinal: 7,
      memoryKind: "campaign_summary" as const,
      content: Array.from({ length: 100 }, (_, index) => `memory-${index}`).join(" "),
      contentHash: "a".repeat(64),
      entities: ["Gate"],
      entityIds: ["gate"],
      metadata: { safe: true }
    }],
    totalParents: 2,
    batchLimit: 1,
    nextCursor: null
  };
}

function dependencies(overrides: Readonly<Record<string, unknown>> = {}) {
  const parents = {
    loadForClaim: vi.fn().mockResolvedValue(parentPage())
  } satisfies ChronicleChunkParentPort;
  const batches = {
    prepareClaim: vi.fn().mockResolvedValue("ready"),
    commitParentBatch: vi.fn().mockResolvedValue(true)
  } satisfies ChronicleChunkBatchPort;
  const provider = {
    id: "55555555-5555-4555-8555-555555555555",
    model: "embed-v1",
    providerType: "openai_compatible",
    contextWindowTokens: 1_024,
    requestTimeoutMs: 10_000,
    configuration: {
        embeddingMaxInputTokens: 256,
        embeddingMaxBatchItems: 2,
        embeddingMaxBatchTokens: 128,
      embeddingDimensions: 2,
      embeddingMaxRetries: 5
    },
    embed: vi.fn().mockImplementation(async (documents: readonly string[]) => ({
      embeddings: documents.map(() => [0.1, 0.2]),
      responseId: "embedding-response",
      usage: { inputTokens: 20 },
      reportedCost: null
    }))
  };
  const embeddings = {
    resolve: vi.fn(),
    load: vi.fn().mockResolvedValue(provider),
    embed: vi.fn((loaded, documents: readonly string[]) => loaded.embed(documents)),
    fingerprint: vi.fn().mockResolvedValue("provider-fingerprint"),
    recordHealth: vi.fn().mockResolvedValue(undefined),
    recordCost: vi.fn().mockResolvedValue(null),
    logDiagnostic: vi.fn()
  };
  return {
    parents,
    batches,
    embeddings,
    sleep: vi.fn().mockResolvedValue(undefined),
    ...overrides,
    provider
  };
}

describe("Chronicle chunk worker execution", () => {
  it("batches embeddings across a parent page while committing each parent sequentially", async () => {
    const values = dependencies();
    const parents = [
      { id: "parent-1", ordinal: 1, content: "First parent." },
      { id: "parent-2", ordinal: 2, content: "Second parent." },
      { id: "parent-3", ordinal: 3, content: "Third parent." }
    ].map((parent, index) => ({
      ...parent,
      memoryKind: "canonical_fact" as const,
      contentHash: String(index + 1).repeat(64),
      entities: [],
      entityIds: [],
      metadata: {}
    }));
    values.parents.loadForClaim = vi.fn().mockResolvedValue({
      ...parentPage(),
      config: { ...parentPage().config, batchSize: 8 },
      providerCapability: {
        ...parentPage().providerCapability,
        configuration: {
          embeddingMaxInputTokens: 128,
          embeddingMaxBatchItems: 8,
          embeddingMaxBatchTokens: 512,
          embeddingDimensions: 2,
          embeddingMaxRetries: 2
        }
      },
      parents,
      totalParents: 3,
      batchLimit: 8,
      nextCursor: null
    });
    values.provider.embed.mockResolvedValue({
      embeddings: [[0.1, 0.2], [0.3, 0.4], [0.5, 0.6]],
      responseId: "page-response",
      usage: { inputTokens: 12 },
      reportedCost: { amount: "0.01", currency: "USD" }
    });
    const pageClaim = {
      ...claim,
      progress: {
        ...claim.progress,
        parentCursor: null,
        processedParents: 0,
        embeddedChunks: 0,
        totalParents: 3
      }
    };
    const execution = createChronicleChunkWorkerExecution(values);

    await execution.execute(pageClaim);

    expect(values.parents.loadForClaim).toHaveBeenCalledWith(pageClaim, {
      batchLimit: 8,
      cursor: null
    });
    expect(values.embeddings.embed).toHaveBeenCalledOnce();
    expect(values.batches.commitParentBatch).toHaveBeenCalledTimes(3);
    const commits = values.batches.commitParentBatch.mock.calls.map(([, input]) => input as unknown as {
      parent: { id: string };
      previousParentCursor: string | null;
      embeddingEvidence: readonly (readonly number[])[];
      costResults: readonly unknown[];
    });
    expect(commits.map((input) => input.parent.id)).toEqual(["parent-1", "parent-2", "parent-3"]);
    expect(commits.map((input) => input.previousParentCursor)).toEqual([
      null,
      "1:parent-1",
      "2:parent-2"
    ]);
    expect(commits.map((input) => input.embeddingEvidence)).toEqual([
      [[0.1, 0.2]],
      [[0.3, 0.4]],
      [[0.5, 0.6]]
    ]);
    expect(commits.map((input) => input.costResults.length)).toEqual([1, 0, 0]);
  });

  it("resumes at the durable parent cursor and commits capability-bounded batches", async () => {
    const values = dependencies();
    const execution = createChronicleChunkWorkerExecution(values);

    const progress = await execution.execute(claim);

    expect(values.parents.loadForClaim).toHaveBeenCalledWith(claim, {
      batchLimit: 8,
      cursor: claim.progress.parentCursor
    });
    expect(values.embeddings.embed.mock.calls.every(([, documents]) => documents.length <= 2)).toBe(true);
    expect(values.embeddings.embed.mock.calls.every(([, documents]) =>
      documents.reduce((tokens, document) => tokens + estimateTokens(document), 0) <= 128
    )).toBe(true);
    expect(values.batches.prepareClaim).toHaveBeenCalledWith(
      claim,
      expect.objectContaining({ capabilityFingerprint: expect.any(String) })
    );
    expect(values.batches.commitParentBatch).toHaveBeenCalledWith(
      claim,
      expect.objectContaining({
        parent: expect.objectContaining({ id: "66666666-6666-4666-8666-666666666666" }),
        previousParentCursor: claim.progress.parentCursor,
        progress: expect.objectContaining({
          parentCursor: "7:66666666-6666-4666-8666-666666666666",
          processedParents: 2,
          totalParents: 2
        })
      })
    );
    expect(progress).toEqual(expect.objectContaining({ processedParents: 2, totalParents: 2 }));
  });

  it("retries only after 250ms and 500ms, then exposes failure to the lane owner", async () => {
    const values = dependencies();
    values.provider.embed.mockRejectedValue(new Error("https://provider.invalid?token=secret"));
    const execution = createChronicleChunkWorkerExecution(values);

    await expect(execution.execute({ ...claim, progress: { ...claim.progress, parentCursor: null, processedParents: 0 } }))
      .rejects.toThrow("token=secret");

    expect(values.provider.embed).toHaveBeenCalledTimes(3);
    expect(values.sleep.mock.calls.map(([milliseconds]) => milliseconds)).toEqual([250, 500]);
    expect(values.batches.commitParentBatch).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "provider loading",
      configure: (values: ReturnType<typeof dependencies>) => {
        values.embeddings.load.mockRejectedValue(new Error("private provider-load failure"));
      },
      expectedStage: "provider_load"
    },
    {
      name: "embedding",
      configure: (values: ReturnType<typeof dependencies>) => {
        values.provider.embed.mockRejectedValue(new Error("private embedding failure"));
      },
      expectedStage: "embedding_batch"
    },
    {
      name: "parent commit",
      configure: (values: ReturnType<typeof dependencies>) => {
        values.batches.commitParentBatch.mockRejectedValue(Object.assign(new Error("private commit failure"), {
          providerExecutionContext: {
            commitStage: "cost_recording",
            reportedCostPresent: true,
            reportedCostCount: 1,
            reportedCostNotation: "scientific",
            reportedCostCurrencyValid: true
          }
        }));
      },
      expectedStage: "parent_commit"
    }
  ])("annotates $name failures before the lane owner logs them", async ({ configure, expectedStage }) => {
    const values = dependencies();
    configure(values);
    const execution = createChronicleChunkWorkerExecution(values);
    let thrown: unknown;

    try {
      await execution.execute({
        ...claim,
        progress: { ...claim.progress, parentCursor: null, processedParents: 0 }
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).toHaveProperty("providerExecutionContext.executionStage", expectedStage);
    expect(thrown).toHaveProperty("providerExecutionContext.processedParents", 0);
    if (expectedStage === "embedding_batch") {
      expect(thrown).toHaveProperty("providerExecutionContext.attemptedBatchSize", expect.any(Number));
    }
    if (expectedStage === "parent_commit") {
      expect(thrown).toHaveProperty("providerExecutionContext.parentOrdinal", 7);
      expect(thrown).toHaveProperty("providerExecutionContext.chunkCount", expect.any(Number));
      expect(thrown).toHaveProperty("providerExecutionContext.commitStage", "cost_recording");
      expect(thrown).toHaveProperty("providerExecutionContext.reportedCostNotation", "scientific");
    }
  });

  it("rejects an incomplete provider response before any durable write", async () => {
    const values = dependencies();
    values.provider.embed.mockResolvedValue({
      embeddings: [], responseId: "incomplete", usage: {}, reportedCost: null
    });
    const execution = createChronicleChunkWorkerExecution(values);

    await expect(execution.execute({ ...claim, progress: { ...claim.progress, parentCursor: null, processedParents: 0 } }))
      .rejects.toThrow("Embedding response did not include every requested document.");
    expect(values.batches.commitParentBatch).not.toHaveBeenCalled();
  });

  it("skips only the chunks that cannot fit one provider request and keeps their siblings embeddable", () => {
    const capability = {
      maxInputTokens: 60,
      maxBatchItems: 4,
      maxBatchTokens: 60,
      expectedDimensions: 2,
      documentPrefix: "search_document: ",
      queryPrefix: "search_query: ",
      documentPrefixTokens: 5,
      queryPrefixTokens: 5,
      safetyMarginTokens: 5,
      requestTimeoutMs: 10_000,
      maxRetries: 2
    };
    const draft = (chunkIndex: number, estimatedTokens: number) => ({
      protocolVersion: "chronicle-chunk-v1" as const,
      parentMemoryId: "66666666-6666-4666-8666-666666666666",
      kind: "campaign_summary" as const,
      chunkIndex,
      content: `chunk-${chunkIndex}`,
      contentHash: "b".repeat(64),
      estimatedTokens,
      sourceStartOffset: 0,
      sourceEndOffset: 1,
      entities: [],
      entityIds: []
    });

    const partition = partitionEmbeddableChunks([draft(0, 10), draft(1, 400), draft(2, 20)], capability);

    expect(partition.embeddable.map((chunk) => chunk.chunkIndex)).toEqual([0, 2]);
    expect([...partition.oversizedIndexes]).toEqual([1]);
    expect(partition.embeddable.every((chunk) =>
      chunk.estimatedTokens + capability.documentPrefixTokens
        <= Math.min(capability.maxInputTokens, capability.maxBatchTokens)
    )).toBe(true);
  });

  it("does not misfire the capacity guard on deterministically split production chunks", async () => {
    const values = dependencies();
    const execution = createChronicleChunkWorkerExecution(values);

    await execution.execute({ ...claim, progress: { ...claim.progress, parentCursor: null, processedParents: 0 } });

    const committed = values.batches.commitParentBatch.mock.calls.flatMap(([, input]) => input.chunks);
    expect(committed.length).toBeGreaterThan(1);
    expect(committed.every((chunk: { skipReason: string | null }) => chunk.skipReason === null)).toBe(true);
    expect(values.batches.commitParentBatch).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ progress: expect.objectContaining({ skippedChunks: 0 }) })
    );
  });

  it("records a fixed per-chunk skip reason when shadow indexing has no semantic provider", async () => {
    const values = dependencies();
    values.parents.loadForClaim = vi.fn().mockResolvedValue({
      ...parentPage(),
      config: {
        enabled: false,
        providerProfileId: null,
        model: "",
        retrievalImplementation: "legacy_hybrid",
        retrievalShadowEnabled: true
      }
    });
    const execution = createChronicleChunkWorkerExecution(values);

    await execution.execute({ ...claim, progress: { ...claim.progress, parentCursor: null, processedParents: 0 } });

    expect(values.embeddings.load).not.toHaveBeenCalled();
    expect(values.batches.commitParentBatch).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        chunks: expect.arrayContaining([
          expect.objectContaining({ embedding: null, skipReason: "semantic_retrieval_disabled" })
        ])
      })
    );
    expect(JSON.stringify(values.batches.commitParentBatch.mock.calls)).not.toContain("secret");
  });

  it("stops without committing when capability preparation requeues newer work", async () => {
    const values = dependencies();
    values.batches.prepareClaim = vi.fn().mockResolvedValue("requeued");
    const execution = createChronicleChunkWorkerExecution(values);

    await expect(execution.execute(claim)).rejects.toThrow("Chronicle chunk work version changed before execution.");
    expect(values.embeddings.embed).not.toHaveBeenCalled();
    expect(values.batches.commitParentBatch).not.toHaveBeenCalled();
  });

  it("fails provider errors privately through the separate chunk lane", async () => {
    const failClaim = vi.fn().mockResolvedValue(true);
    const chunkState = {
      claimNext: vi.fn().mockResolvedValue(claim),
      loadClaimedJob: vi.fn().mockResolvedValue(claim),
      heartbeatClaim: vi.fn().mockResolvedValue(true),
      completeClaim: vi.fn(),
      failClaim
    };
    const logProviderTransportError = vi.fn();
    const executor = createChronicleWorkerExecutor({
      state: { claimNext: vi.fn().mockResolvedValue(null) } as never,
      retrieval: {} as never,
      execution: {} as never,
      chunks: {
        state: chunkState,
        execution: { execute: vi.fn().mockRejectedValue(new Error("token=private")) }
      },
      logProviderTransportError
    });

    await expect(executor.runNextChronicle({
      workerId: claim.workerId,
      leaseSeconds: claim.leaseSeconds,
      retrieval: { batchLimit: 1 }
    })).resolves.toBe(true);

    expect(failClaim).toHaveBeenCalledWith(claim, { diagnosticCode: "chronicle_execution_failed" });
    expect(JSON.stringify(failClaim.mock.calls)).not.toContain("private");
    expect(logProviderTransportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "token=private" }),
      expect.objectContaining({ jobType: "index_memory_chunks_v2" })
    );
  });

  it("requeues a stale chunk claim through the guarded newer-work transition", async () => {
    const completeClaim = vi.fn().mockResolvedValue(true);
    const failClaim = vi.fn();
    const executor = createChronicleWorkerExecutor({
      state: { claimNext: vi.fn().mockResolvedValue(null) } as never,
      retrieval: {} as never,
      execution: {} as never,
      chunks: {
        state: {
          claimNext: vi.fn().mockResolvedValue(claim),
          loadClaimedJob: vi.fn().mockResolvedValue(null),
          heartbeatClaim: vi.fn().mockResolvedValue(true),
          completeClaim,
          failClaim
        },
        execution: { execute: vi.fn().mockRejectedValue(new Error("work version changed")) }
      },
      logProviderTransportError: vi.fn()
    });

    await executor.runNextChronicle({
      workerId: claim.workerId,
      leaseSeconds: claim.leaseSeconds,
      retrieval: { batchLimit: 1 }
    });

    expect(completeClaim).toHaveBeenCalledWith(claim, { progress: claim.progress });
    expect(failClaim).not.toHaveBeenCalled();
  });
});
