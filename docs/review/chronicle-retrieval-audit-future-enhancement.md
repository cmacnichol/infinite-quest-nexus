# Chronicle retrieval audit and embedding controls future enhancement

## Status

Implementation in progress. The accepted-turn retrieval audit is governed by
[ADR 0029](../architecture/0029-chronicle-turn-retrieval-audit.md) and the
[implementation plan](../superpowers/plans/2026-08-16-chronicle-turn-retrieval-audit.md).
Tasks 1 through 6 implement the contract, provider provenance, production-path
audit, persistence, API projection, lifecycle semantics, portability boundary,
and operator documentation. Task 7 is the final UI work; Task 8 performs the
complete verification before this status becomes `Implemented`.

Operational telemetry retention is not turn-history retention. Retrieval runs
remain optional, expiring diagnostics. An accepted-turn audit is retained only
when the production path was observed and validated as part of that turn's
atomic acceptance.

## Approved implementation

The accepted-turn audit is an additive, versioned value at
`turns.model_metadata.chronicleRetrieval`. It records the configured and actual
retrieval implementations, semantic or lexical mode, safe fallback code,
provider-resolution source and safe labels, query-vector path, call outcome,
and request/cache counters.

```ts
type ChronicleRetrievalAuditV1 = Readonly<{
  auditVersion: "chronicle-retrieval-audit-v1";
  configuredImplementation: "legacy_hybrid" | "chunked_hybrid";
  effectiveImplementation: "legacy_hybrid" | "chunked_hybrid";
  effectiveMode: "semantic_hybrid" | "lexical_only";
  fallbackCode: string | null;
  provider: Readonly<{
    resolutionSource: "dedicated_embedding" | "text_fallback" | "none";
    resolvedRole: "embedding" | "text" | null;
    providerType: string | null;
    model: string | null;
  }>;
  queryVectorPath: "none" | "cache_only" | "provider_only" | "cache_and_provider";
  providerCallOutcome: "not_attempted" | "succeeded" | "failed" | "mixed";
  queryEmbeddingRequests: number;
  queryCacheHits: number;
  queryCacheMisses: number;
}>;
```

The accepted-turn audit contains only the approved safe provider labels and
never a provider account identifier, endpoint, credential, or raw retrieval
content. It also contains no raw action, query, narration, memory content,
provider response, candidate identifier, or unfiltered error.

The audit describes only the production execution. Optional shadow comparisons
are neither an accepted-turn source nor a substitute for it. A cache hit can
support semantic ranking without a live embedding call, and the explicit
text-role fallback remains distinct from the narration provider call.

## Lifecycle and compatibility rules

- Existing, imported, and malformed stored audit data projects as
  `chronicleRetrieval: null`. This means Unknown; never infer or backfill it.
- A known lexical-only execution stores a complete audit. It is never represented
  as Unknown.
- Corrections and rewinds do not rewrite a retained turn's audit. A branch or
  same-owner transfer preserves an existing audit exactly and preserves absence
  as `null` in the public projection.
- A replacement creates a new accepted turn and records its newly observed
  production path.
- Portable campaign payloads omit the audit. A turn imported from that portable
  payload projects as `null` even if the source installation had recorded an
  audit.
- No schema migration, accepted-turn update, or backfill is part of this work.

## Historical research context

Historical research below is superseded where it conflicts with ADR 0029. The
initial investigation correctly identified that existing diagnostics could not
prove the effective retrieval path, provider-resolution source, cache use, or
safe fallback state for an accepted turn. The approved implementation now closes
those gaps through a strict contract and atomic accepted-turn persistence.

The initial comparison of durable storage alternatives is no longer an open
design choice for accepted turns: `turns.model_metadata.chronicleRetrieval` is
the approved source for accepted-turn provenance. A future failed-generation
audit would be a separate product decision with its own lifecycle and retention
requirements; it must not weaken accepted-turn immutability or reuse optional
telemetry as authority.

## Future advanced embedding input and chunk controls

The embedding HTTP request sends model and input; it does not accept a generic
context-window setting. The surrounding Chronicle pipeline instead applies
provider capability limits, chunk target and overlap, document/query prefixes,
and campaign batch size.

| Control | Current behavior |
| --- | --- |
| Chunk target | 384 estimated tokens |
| Chunk overlap | 32 estimated tokens |
| Unknown maximum input | Half the provider context window, capped at 8,192 |
| Safety margin | 8 percent of effective maximum input |
| Unknown batch item capacity | 16 items |
| Capability overrides | Bounded maximum input, batch, dimensions, and retry values |
| Document/query prefixes | Model-aware defaults or campaign overrides |

Do not add one unrestricted embedding-context value. Increasing a capacity
limit does not itself enlarge the normal chunk, and a bad value can exceed a
real provider limit. A future enhancement should instead:

1. Expose bounded provider capability overrides in an Advanced provider
   capabilities section.
2. Keep chunk target and overlap separate from provider capacity, using named,
   versioned presets rather than arbitrary values by default.
3. Version a changed chunk policy and rebuild the affected derived chunk index.
4. Explain before save that retrieval uses the complete legacy path until the
   rebuilt index becomes ready.
5. Keep this future UI work after its contract, invalidation, worker, readiness,
   fallback, and evaluation coverage.

The benefit is compatibility and controlled retrieval-quality tuning. The cost
is a larger support surface, derived reindexing, calibration work, and the risk
that large chunks reduce precision while small overlapping chunks increase
storage and request volume.
