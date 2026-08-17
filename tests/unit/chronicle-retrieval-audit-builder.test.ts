import { describe, expect, it } from "vitest";
import {
  buildChronicleRetrievalAudit,
  mergeChronicleRetrievalAuditTraces
} from "../../packages/database/src/chronicle-retrieval-audit.js";

describe("Chronicle retrieval audit builder", () => {
  const dedicated = {
    resolutionSource: "dedicated_embedding" as const,
    resolvedRole: "embedding" as const,
    providerType: "openrouter",
    model: "embed-model"
  };

  it("records a chunked-to-legacy semantic fallback from the live provider", () => {
    expect(buildChronicleRetrievalAudit({
      configuredImplementation: "chunked_hybrid",
      effectiveImplementation: "legacy_hybrid",
      semanticUsed: true,
      fallbackCode: "chunk_index_not_ready",
      trace: {
        provider: { ...dedicated, resolutionSource: "text_fallback", resolvedRole: "text" },
        providerCallOutcome: "succeeded",
        queryEmbeddingRequests: 1,
        queryCacheHits: 0,
        queryCacheMisses: 1
      }
    })).toMatchObject({
      effectiveImplementation: "legacy_hybrid",
      effectiveMode: "semantic_hybrid",
      queryVectorPath: "provider_only"
    });
  });

  it("records a cache-only semantic query without claiming a provider call", () => {
    expect(buildChronicleRetrievalAudit({
      configuredImplementation: "legacy_hybrid", effectiveImplementation: "legacy_hybrid", semanticUsed: true,
      fallbackCode: null,
      trace: { provider: dedicated, providerCallOutcome: "not_attempted", queryEmbeddingRequests: 0, queryCacheHits: 1, queryCacheMisses: 0 }
    })).toMatchObject({ queryVectorPath: "cache_only", providerCallOutcome: "not_attempted" });
  });

  it("records mixed cache and provider query vectors", () => {
    expect(buildChronicleRetrievalAudit({
      configuredImplementation: "chunked_hybrid", effectiveImplementation: "chunked_hybrid", semanticUsed: true,
      fallbackCode: null,
      trace: { provider: dedicated, providerCallOutcome: "succeeded", queryEmbeddingRequests: 1, queryCacheHits: 1, queryCacheMisses: 1 }
    })).toMatchObject({ queryVectorPath: "cache_and_provider" });
  });

  it("retains failed text fallback provenance while reporting lexical retrieval", () => {
    expect(buildChronicleRetrievalAudit({
      configuredImplementation: "legacy_hybrid", effectiveImplementation: "legacy_hybrid", semanticUsed: false,
      fallbackCode: "semantic_retrieval_unavailable",
      trace: {
        provider: { ...dedicated, resolutionSource: "text_fallback", resolvedRole: "text" },
        providerCallOutcome: "failed", queryEmbeddingRequests: 1, queryCacheHits: 0, queryCacheMisses: 1
      }
    })).toMatchObject({ effectiveMode: "lexical_only", provider: { resolutionSource: "text_fallback" } });
  });

  it("records unconfigured semantics as a provider-free lexical execution", () => {
    expect(buildChronicleRetrievalAudit({
      configuredImplementation: "legacy_hybrid", effectiveImplementation: "legacy_hybrid", semanticUsed: false,
      fallbackCode: "semantic_not_configured",
      trace: { provider: { resolutionSource: "none", resolvedRole: null, providerType: null, model: null }, providerCallOutcome: "not_attempted", queryEmbeddingRequests: 0, queryCacheHits: 0, queryCacheMisses: 0 }
    })).toMatchObject({ provider: { resolutionSource: "none" }, queryVectorPath: "none" });
  });

  it("marks a failed first attempt and successful fallback as mixed", () => {
    const trace = mergeChronicleRetrievalAuditTraces(
      { provider: dedicated, providerCallOutcome: "failed", queryEmbeddingRequests: 1, queryCacheHits: 0, queryCacheMisses: 1 },
      { provider: dedicated, providerCallOutcome: "succeeded", queryEmbeddingRequests: 1, queryCacheHits: 0, queryCacheMisses: 1 }
    );
    expect(trace).toMatchObject({ providerCallOutcome: "mixed", queryEmbeddingRequests: 2, queryCacheMisses: 2 });
  });

  it("rejects a fallback whose resolved provider provenance changes", () => {
    expect(() => mergeChronicleRetrievalAuditTraces(
      { provider: dedicated, providerCallOutcome: "failed", queryEmbeddingRequests: 1, queryCacheHits: 0, queryCacheMisses: 1 },
      { provider: { ...dedicated, resolutionSource: "text_fallback", resolvedRole: "text" }, providerCallOutcome: "succeeded", queryEmbeddingRequests: 1, queryCacheHits: 0, queryCacheMisses: 1 }
    )).toThrow("provider provenance changed");
  });
});
