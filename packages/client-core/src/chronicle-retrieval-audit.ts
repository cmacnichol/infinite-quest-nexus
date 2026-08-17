import type { ChronicleRetrievalAudit } from "@infinite-quest/contracts";

export type ChronicleRetrievalAuditPresentation = Readonly<{
  status: "recorded" | "unknown";
  searchPath: string;
  provider: string;
  queryVector: string;
  fallback: string | null;
}>;

const fallbackCopy: Readonly<Record<NonNullable<ChronicleRetrievalAudit["fallbackCode"]>, string>> = {
  empty_query: "empty query",
  semantic_not_configured: "semantic retrieval not configured",
  provider_unavailable: "embedding provider unavailable during retrieval",
  semantic_retrieval_unavailable: "semantic retrieval unavailable during retrieval",
  chunk_index_not_ready: "chunk index not ready",
  incompatible_chunk_embeddings: "chunk embeddings are incompatible"
};

const unknownPresentation: ChronicleRetrievalAuditPresentation = {
  status: "unknown",
  searchPath: "Unknown — this turn predates retrieval auditing or came from an import without audit metadata.",
  provider: "Unknown",
  queryVector: "Unknown",
  fallback: null
};

function searchPath(audit: ChronicleRetrievalAudit): string {
  if (audit.effectiveImplementation === "chunked_hybrid") return "Chunked semantic retrieval";
  return audit.effectiveMode === "lexical_only" ? "Legacy lexical retrieval" : "Legacy semantic retrieval";
}

function provider(audit: ChronicleRetrievalAudit): string {
  if (audit.provider.resolutionSource === "dedicated_embedding") {
    return `Dedicated embedding provider: ${audit.provider.providerType} · ${audit.provider.model}`;
  }
  if (audit.provider.resolutionSource === "text_fallback") {
    return `Text-role provider used for embeddings: ${audit.provider.providerType} · ${audit.provider.model}`;
  }
  return "No embedding provider was used.";
}

function queryVector(path: ChronicleRetrievalAudit["queryVectorPath"]): string {
  const labels: Readonly<Record<ChronicleRetrievalAudit["queryVectorPath"], string>> = {
    none: "No query vector was used.",
    cache_only: "Query vector: cache (no live provider call)",
    provider_only: "Query vector: live provider call",
    cache_and_provider: "Query vectors: cache and live provider call"
  };
  return labels[path];
}

export function formatChronicleRetrievalAudit(
  audit: ChronicleRetrievalAudit | null
): ChronicleRetrievalAuditPresentation {
  if (!audit) return unknownPresentation;
  return {
    status: "recorded",
    searchPath: searchPath(audit),
    provider: provider(audit),
    queryVector: queryVector(audit.queryVectorPath),
    fallback: audit.fallbackCode ? fallbackCopy[audit.fallbackCode] : null
  };
}
