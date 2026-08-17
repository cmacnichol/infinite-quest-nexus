import {
  chronicleRetrievalAuditSchema,
  type ChronicleRetrievalAudit,
  type RetrievalImplementation
} from "../../contracts/src/memory.js";

export type ChronicleRetrievalAuditProvider =
  | Readonly<{ resolutionSource: "none"; resolvedRole: null; providerType: null; model: null }>
  | Readonly<{
      resolutionSource: "dedicated_embedding" | "text_fallback";
      resolvedRole: "embedding" | "text";
      providerType: string;
      model: string;
    }>;

export type ChronicleRetrievalAuditTrace = Readonly<{
  provider: ChronicleRetrievalAuditProvider;
  providerCallOutcome: "not_attempted" | "succeeded" | "failed" | "mixed";
  queryEmbeddingRequests: number;
  queryCacheHits: number;
  queryCacheMisses: number;
}>;

export type ChronicleRetrievalAuditInput = Readonly<{
  configuredImplementation: RetrievalImplementation;
  effectiveImplementation: RetrievalImplementation;
  semanticUsed: boolean;
  fallbackCode: ChronicleRetrievalAudit["fallbackCode"];
  trace: ChronicleRetrievalAuditTrace;
}>;

const noProvider = (): ChronicleRetrievalAuditProvider => ({
  resolutionSource: "none", resolvedRole: null, providerType: null, model: null
});

export const emptyChronicleRetrievalAuditTrace = (): ChronicleRetrievalAuditTrace => ({
  provider: noProvider(),
  providerCallOutcome: "not_attempted",
  queryEmbeddingRequests: 0,
  queryCacheHits: 0,
  queryCacheMisses: 0
});

function queryVectorPath(requests: number, cacheHits: number) {
  if (requests > 0 && cacheHits > 0) return "cache_and_provider" as const;
  if (requests > 0) return "provider_only" as const;
  if (cacheHits > 0) return "cache_only" as const;
  return "none" as const;
}

function mergeOutcome(
  left: ChronicleRetrievalAuditTrace["providerCallOutcome"],
  right: ChronicleRetrievalAuditTrace["providerCallOutcome"],
): ChronicleRetrievalAuditTrace["providerCallOutcome"] {
  if (left === right) return left;
  if (left === "not_attempted") return right;
  if (right === "not_attempted") return left;
  return "mixed";
}

function mergedProvider(
  left: ChronicleRetrievalAuditProvider,
  right: ChronicleRetrievalAuditProvider,
): ChronicleRetrievalAuditProvider {
  if (left.resolutionSource === "none") return right;
  if (right.resolutionSource === "none") return left;
  if (left.resolutionSource !== right.resolutionSource
    || left.resolvedRole !== right.resolvedRole
    || left.providerType !== right.providerType
    || left.model !== right.model) {
    throw new Error("Chronicle retrieval audit provider provenance changed across fallback.");
  }
  return left;
}

export function mergeChronicleRetrievalAuditTraces(
  left: ChronicleRetrievalAuditTrace,
  right: ChronicleRetrievalAuditTrace,
): ChronicleRetrievalAuditTrace {
  return {
    provider: mergedProvider(left.provider, right.provider),
    providerCallOutcome: mergeOutcome(left.providerCallOutcome, right.providerCallOutcome),
    queryEmbeddingRequests: left.queryEmbeddingRequests + right.queryEmbeddingRequests,
    queryCacheHits: left.queryCacheHits + right.queryCacheHits,
    queryCacheMisses: left.queryCacheMisses + right.queryCacheMisses
  };
}

export function buildChronicleRetrievalAudit(input: ChronicleRetrievalAuditInput): ChronicleRetrievalAudit {
  return chronicleRetrievalAuditSchema.parse({
    auditVersion: "chronicle-retrieval-audit-v1",
    configuredImplementation: input.configuredImplementation,
    effectiveImplementation: input.effectiveImplementation,
    effectiveMode: input.semanticUsed ? "semantic_hybrid" : "lexical_only",
    fallbackCode: input.fallbackCode,
    provider: input.trace.provider,
    queryVectorPath: queryVectorPath(input.trace.queryEmbeddingRequests, input.trace.queryCacheHits),
    providerCallOutcome: input.trace.providerCallOutcome,
    queryEmbeddingRequests: input.trace.queryEmbeddingRequests,
    queryCacheHits: input.trace.queryCacheHits,
    queryCacheMisses: input.trace.queryCacheMisses
  });
}
