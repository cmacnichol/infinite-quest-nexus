# Chronicle retrieval audit and embedding controls future enhancement

## Status

Implemented and verified on 2026-08-17. The accepted-turn retrieval audit is governed by
[ADR 0029](../architecture/0029-chronicle-turn-retrieval-audit.md) and the
[implementation plan](../superpowers/plans/2026-08-16-chronicle-turn-retrieval-audit.md).
All eight plan tasks are complete. The delivered work covers the contract,
provider provenance, production-path audit, persistence, API projection,
lifecycle semantics, portability boundary, operator documentation, both user
interfaces, and final regression/privacy verification.

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

## Final verification evidence (2026-08-17)

### Repository and database gates

The following final commands exited zero:

```powershell
pnpm check
pnpm test:unit
pnpm build
node scripts/run-isolated-integration.mjs
pnpm evaluate:chronicle -- --implementation legacy_hybrid --output tmp/chronicle-evaluation/final-audit-legacy.json
pnpm evaluate:chronicle -- --implementation chunked_hybrid --output tmp/chronicle-evaluation/final-audit-chunked.json
git diff --check
```

- `pnpm check` validated the repository boundary/data checks across 1,022 files
  and all TypeScript/web checks.
- The unit suite completed 185 files with 2,076 passed and 44 explicitly skipped
  tests (2,120 total). The skipped cases were existing platform-capability cases,
  not Chronicle retrieval/audit cases.
- Both Legacy and replacement production web bundles built successfully.
- The isolated integration runner completed all 65 discovered files with exit
  zero against real PostgreSQL. The runner reports per-file test totals rather
  than one aggregate test count; every discovered file completed, and no
  Chronicle retrieval or audit test skipped. Explicit skips were limited to
  unrelated platform/archive/image/secure-filesystem capability cases.
- Database identity was container `infinitequest-integration-postgres`, database
  and role `infinitequest_test`, PostgreSQL 18.4 (Debian, x86_64). Credentials
  are intentionally omitted.

The complete repository, unit, build, and PostgreSQL commands above were rerun
after the final production repair at commit `527c3fb` and the owning
observability-fixture correction at commit `192a3ae`. The first evaluator
attempt from the restricted sandbox could not read Docker configuration; the
same two commands were rerun with approved Docker access and both exited zero.

### Evaluator results

Both evaluators used corpus version `v2`, 17 cases, and corpus hash
`1cd534c1585a81865572beb4fd7748e7ac817d248269a3c0c7ebcb93d415951f`.

| Metric | Legacy hybrid | Chunked hybrid |
| --- | ---: | ---: |
| Recall at 5 | 0.7352941176470589 | 0.8235294117647058 |
| Recall at 10 | 0.7352941176470589 | 0.8235294117647058 |
| Recall at 20 | 0.7352941176470589 | 1 |
| MRR | 0.7706558485463151 | 0.7757352941176471 |
| nDCG | 0.7552612693115515 | 0.8667030368443928 |
| Duplicate rate | 0 | 0 |
| Relevant memories per prompt token | 0.0054557124518613605 | 0.007233273056057866 |
| Cross-campaign/future-turn/superseded-fact leakage | 0 / 0 / 0 | 0 / 0 / 0 |
| Latency p50 / p95 (ms) | 6 / 23 | 6 / 43 |
| Embedding requests / cost | 3 / 0 | 3 / 0 |
| Semantic-only hits | 3 | 3 |
| Promotions / demotions | 164 / 164 | 138 / 141 |

### Long-campaign and provider-failure proof

The real-PostgreSQL long-campaign fixture contains 120 accepted turns and now
proves all required audit paths. Compatible ready chunks remain chunked semantic
and identify dedicated or text-role provider resolution accurately. Query-cache
reuse is reported as cache-only with no provider call. Timeout, empty/malformed
vectors, and incompatible dimensions all produce complete effective legacy
retrieval with a sanitized `semantic_retrieval_unavailable` fallback. When the
legacy parent vector cannot be used either, lexical/entity/recency/chronology
retrieval still fills the prompt and reports lexical-only.

The assertions also prove identical selected scopes and token budget across the
provider-failure cases, preserve campaign/world-version isolation, and prove
that chunk ranking SQL is not used after fallback. Verification REDs found and
the owning repairs fixed five edge cases without changing valid-vector
selection or token-budget semantics:

- `fb177c1` rejects malformed vectors and vectors that contradict an explicitly
  configured dimension before caching or success attribution.
- `616803c` infers dimensions from current compatible embeddings when the
  provider omits them, rejects all-zero or inferred-wrong-dimension vectors,
  and treats stale incompatible cached vectors as misses that a valid live
  vector can replace while retaining truthful counters.
- `43fb6d4` ignores stale chunk embeddings when inferring the current compatible
  dimension.
- `55fede7` records the campaign's actual configured embedding model and reports
  semantic use only when fresh semantic candidates contribute to selection.
- `527c3fb` accepts valid model identifiers while rejecting URI, scheme-relative,
  hostname, IPv4, and bracketed-IPv6 endpoint values from audit labels.

The final focused real-PostgreSQL suites were green: query cache 8/8, chunk
retrieval 14/14, provider adapters 8/8, and observability 4/4. The last suite
first reproduced a stale expectation after the semantic-contribution repair
(1/4 failed), then moved to 4/4 after the test-only correction in `192a3ae`.

### Privacy review

The required staged search covered `baseUrl`, `endpoint`, `credential`,
`apiKey`, `rawQuery`, `rawAction`, `narration`, `providerProfileId`, and
`fingerprint` in the contract, audit builder, repository, runtime adapter, and
both UI renderers. Matches were manually classified as existing provider
execution/cache configuration, ordinary narration display, or negative
assertions. None is part of the persisted/public audit object.

The accepted audit remains limited to the versioned closed vocabulary, safe
provider type/model labels, and bounded counters. It contains no endpoint,
credential, raw action/query/narration/memory/provider response, profile ID,
fingerprint, candidate ID, or raw error. `git diff --cached --check` and
`git diff --check` passed, and unrelated dirty work was preserved unstaged.

### Rendered UI evidence

The real built bundles were served over same-origin HTTP with API fixtures for
one recorded text-role fallback and one historical `null` audit. The replacement
history route `/app/campaigns/:campaignId/history` rendered two
`Chronicle retrieval` definition lists. The Legacy `/story/:campaignId` route
opened its turn-history dialog from the real `#turnPill` control and rendered
the same two states. Both surfaces displayed the recorded execution as Legacy
semantic retrieval, text-role embedding provider, live provider call, and
chunk-index fallback; both displayed the historical record as Unknown with the
same explanation. Browser console/error capture was empty for both routes.

This closes the historical Task 7 gap where an API-backed Legacy browser smoke
was unavailable: Task 7 had DOM/modal and bundle proof, and Task 8 adds live
same-origin HTTP/browser proof for both surfaces. Root `index.html` remains
unchanged.

### Delivery commits and deferred cleanup

The implementation range after merge base `7902877` is:

```text
d4ea52c Define Chronicle turn retrieval audit
86e6971 Reject endpoint URIs in Chronicle audit
5e65254 Preserve Chronicle embedding provider provenance
9cd9886 Harden Chronicle chunk readiness
656749d Audit effective Chronicle retrieval
37ede51 Preserve Chronicle fallback audit trace
483a68e Store Chronicle retrieval audit on turns
27677a0 Cover Chronicle audit on replacement turns
133c7b8 Expose Chronicle retrieval audit on turn APIs
00adb1a Document Chronicle retrieval audit lifecycle
3df3865 Harden Chronicle audit lifecycle coverage
f437db3 Show Chronicle retrieval audit on turns
beb0634 Correct Chronicle retrieval history labels
c313fea Repair Chronicle audit verification fixtures
66344de Align Chronicle skip reason fixtures
a27f4a6 Align Chronicle fallback audit expectation
9616289 Verify gameplay Chronicle audit projections
18dc606 Refresh Chronicle migration test contracts
cbefa9b Repair Chronicle evaluator provider resolution
fb177c1 Reject unusable Chronicle query vectors
868f0a2 Record Chronicle audit verification
de3502f Align Chronicle audit inventory status
616803c Recover Chronicle query vector cache
43fb6d4 Align Chronicle chunk dimension inference
55fede7 Repair Chronicle retrieval audit provenance
527c3fb Harden Chronicle audit endpoint labels
192a3ae Align Chronicle observability fallback test
```

Two Task 5 test-only cleanups remain intentionally deferred and do not weaken
the verified runtime contract: add an explicit immediate-client null/copy-
independence assertion, and replace the remaining completed-result fixture type
assertions with explicit `chronicleRetrieval: null`. They are minor maintainability
improvements, not implementation or release blockers.
