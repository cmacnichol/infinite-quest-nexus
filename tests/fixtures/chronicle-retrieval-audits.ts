export const DEDICATED_CHUNKED_AUDIT = {
  auditVersion: "chronicle-retrieval-audit-v1",
  configuredImplementation: "chunked_hybrid",
  effectiveImplementation: "chunked_hybrid",
  effectiveMode: "semantic_hybrid",
  fallbackCode: null,
  provider: {
    resolutionSource: "dedicated_embedding",
    resolvedRole: "embedding",
    providerType: "openrouter",
    model: "openai/text-embedding-3-large"
  },
  queryVectorPath: "cache_and_provider",
  providerCallOutcome: "succeeded",
  queryEmbeddingRequests: 1,
  queryCacheHits: 1,
  queryCacheMisses: 1
} as const;

export const TEXT_FALLBACK_LEGACY_AUDIT = {
  auditVersion: "chronicle-retrieval-audit-v1",
  configuredImplementation: "chunked_hybrid",
  effectiveImplementation: "legacy_hybrid",
  effectiveMode: "semantic_hybrid",
  fallbackCode: "chunk_index_not_ready",
  provider: {
    resolutionSource: "text_fallback",
    resolvedRole: "text",
    providerType: "openrouter",
    model: "text-embedding-nomic-embed-text-v1.5"
  },
  queryVectorPath: "provider_only",
  providerCallOutcome: "succeeded",
  queryEmbeddingRequests: 1,
  queryCacheHits: 0,
  queryCacheMisses: 1
} as const;

export const LEXICAL_NO_PROVIDER_AUDIT = {
  auditVersion: "chronicle-retrieval-audit-v1",
  configuredImplementation: "legacy_hybrid",
  effectiveImplementation: "legacy_hybrid",
  effectiveMode: "lexical_only",
  fallbackCode: "semantic_not_configured",
  provider: {
    resolutionSource: "none",
    resolvedRole: null,
    providerType: null,
    model: null
  },
  queryVectorPath: "none",
  providerCallOutcome: "not_attempted",
  queryEmbeddingRequests: 0,
  queryCacheHits: 0,
  queryCacheMisses: 0
} as const;
