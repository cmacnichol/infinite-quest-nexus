import { describe, expect, it } from "vitest";
import type { ChronicleRetrievalAudit } from "../../../packages/contracts/src/index.js";
import { formatChronicleRetrievalAudit } from "../../../packages/client-core/src/index.js";
import {
  DEDICATED_CHUNKED_AUDIT,
  TEXT_FALLBACK_LEGACY_AUDIT
} from "../../fixtures/chronicle-retrieval-audits.js";

describe("Chronicle retrieval audit presentation", () => {
  it("explains the absence of trustworthy historical audit metadata without inference", () => {
    expect(formatChronicleRetrievalAudit(null)).toEqual({
      status: "unknown",
      searchPath: "Unknown — this turn predates retrieval auditing or came from an import without audit metadata.",
      provider: "Unknown",
      queryVector: "Unknown",
      fallback: null
    });
  });

  it("presents chunked semantic retrieval from a dedicated embedding provider", () => {
    expect(formatChronicleRetrievalAudit(DEDICATED_CHUNKED_AUDIT)).toEqual({
      status: "recorded",
      searchPath: "Chunked semantic retrieval",
      provider: "Dedicated embedding provider: openrouter · openai/text-embedding-3-large",
      queryVector: "Query vectors: cache and live provider call",
      fallback: null
    });
  });

  it("distinguishes text-role provider fallback and a ready-index fallback", () => {
    expect(formatChronicleRetrievalAudit(TEXT_FALLBACK_LEGACY_AUDIT)).toEqual({
      status: "recorded",
      searchPath: "Legacy semantic retrieval",
      provider: "Text-role provider used for embeddings: openrouter · text-embedding-nomic-embed-text-v1.5",
      queryVector: "Query vector: live provider call",
      fallback: "chunk index not ready"
    });
  });

  it("records lexical fallback after a resolved embedding provider is unavailable", () => {
    const audit: ChronicleRetrievalAudit = {
      ...DEDICATED_CHUNKED_AUDIT,
      configuredImplementation: "legacy_hybrid",
      effectiveImplementation: "legacy_hybrid",
      effectiveMode: "lexical_only",
      fallbackCode: "provider_unavailable",
      queryVectorPath: "provider_only",
      providerCallOutcome: "failed",
      queryEmbeddingRequests: 1,
      queryCacheHits: 0,
      queryCacheMisses: 1
    };

    expect(formatChronicleRetrievalAudit(audit)).toEqual({
      status: "recorded",
      searchPath: "Legacy lexical retrieval",
      provider: "Dedicated embedding provider: openrouter · openai/text-embedding-3-large",
      queryVector: "Query vector: live provider call",
      fallback: "embedding provider unavailable during retrieval"
    });
  });

  it("does not call a valid chunked lexical fallback semantic retrieval", () => {
    const audit: ChronicleRetrievalAudit = {
      ...DEDICATED_CHUNKED_AUDIT,
      effectiveMode: "lexical_only",
      fallbackCode: "semantic_retrieval_unavailable",
      queryVectorPath: "provider_only",
      providerCallOutcome: "failed",
      queryEmbeddingRequests: 1,
      queryCacheHits: 0,
      queryCacheMisses: 1
    };

    expect(formatChronicleRetrievalAudit(audit).searchPath).toBe("Chunked lexical retrieval");
  });

  it("distinguishes cache-only query reuse from a mixed cache and provider path", () => {
    const cacheOnly: ChronicleRetrievalAudit = {
      ...DEDICATED_CHUNKED_AUDIT,
      queryVectorPath: "cache_only",
      providerCallOutcome: "not_attempted",
      queryEmbeddingRequests: 0,
      queryCacheHits: 1,
      queryCacheMisses: 0
    };

    expect(formatChronicleRetrievalAudit(cacheOnly).queryVector).toBe("Query vector: cache (no live provider call)");
    expect(formatChronicleRetrievalAudit(DEDICATED_CHUNKED_AUDIT).queryVector).toBe("Query vectors: cache and live provider call");
  });
});
