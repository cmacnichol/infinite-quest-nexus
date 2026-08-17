# Chronicle retrieval audit and embedding controls future enhancement

## Status

Implementation in progress. The approved lifecycle and privacy design is
recorded in [ADR 0029](../architecture/0029-chronicle-turn-retrieval-audit.md)
and is being delivered through the
[implementation plan](../superpowers/plans/2026-08-16-chronicle-turn-retrieval-audit.md).
Task 8 changes this status to `Implemented` only after the backend, lifecycle,
both supported UI surfaces, and final verification pass.

Operational telemetry retention is not turn-history retention. Retrieval runs
remain optional, expiring diagnostics; accepted-turn provenance is retained only
when it was observed and validated at acceptance time.

## Goals

1. Make every generated turn able to answer which Chronicle retrieval path
   actually supplied its prompt context.
2. Distinguish a dedicated embedding provider from the explicit text-role
   embedding fallback.
3. Distinguish successful semantic use from a query-cache hit, a provider call,
   and a complete fallback to legacy semantic or lexical retrieval.
4. Preserve an immutable, privacy-safe audit summary with an accepted turn and
   expose it through a typed turn projection later.
5. Record user-adjustable embedding input and chunk controls as a separate,
   advanced, versioned future enhancement.

## Executive finding

The code already records part of the desired audit for accepted turns. Context
retrieval returns a `retrieval` object; the generation executor copies that object
into `contextDiagnostics`; and the accepted-turn transaction writes those
diagnostics into `turns.model_metadata`. The first generation attempt also stores
the same diagnostics in `generation_attempts.request_metadata`
(`services/runtime/src/generation-executor-adapter.ts:620-643,754-776,967-987`;
`packages/database/src/generation-execution-repository.ts:413-445,694-725`;
`database/migrations/0001_initial_nexus.sql:68-86`;
`database/migrations/0005_story_engine.sql:70-89`).

That existing record is not yet sufficient for a trustworthy audit:

- Its public/application type is opaque: `ChronicleContextPreview` is a generic
  record and the generation executor declares `retrieval: unknown`
  (`packages/application/src/memory/types.ts:61-65`;
  `services/runtime/src/generation-executor-adapter.ts:74-90`).
- The provider layer knows whether it resolved a dedicated embedding profile or
  a text-role fallback, but the Chronicle runtime binding reduces that result to
  a provider ID. The source is therefore unavailable to retrieval results and
  accepted-turn metadata (`packages/application/src/providers/types.ts:219-265`;
  `packages/database/src/provider-repository.ts:359-391`;
  `services/runtime/src/chronicle-platform-bindings.ts:19-50`;
  `packages/database/src/chronicle-repository.ts:112-124`).
- The field called `implementation` reports the configured implementation, not
  always the effective one. When chunked retrieval falls back, the code runs the
  legacy implementation and then deliberately reports `implementation:
  "chunked_hybrid"` with a fallback reason
  (`packages/database/src/chronicle-context-repository.ts:1497-1525,1533-1554`).
- Turn-history responses do not select or expose `model_metadata`; the immediate
  generation result exposes it only as an opaque object
  (`packages/database/src/play-loop-read-repository.ts:86-120`;
  `packages/contracts/src/client-api.ts:269-282,334-355`;
  `packages/database/src/generation-repository.ts:527-575`).

The recommended change is therefore an additive promotion of existing metadata,
not a new retrieval system: define a closed versioned audit contract, preserve
the provider-resolution source through the Chronicle port, derive an explicit
effective path, write that audit atomically with the accepted turn, and add a
safe typed turn projection. Operational shadow telemetry should remain separate
and best-effort.

## Current retrieval decisions and what can be inferred

### Retrieval result today

The legacy implementation reports lexical-only reasons for an empty query,
disabled semantics, and an unavailable provider. On success it reports hybrid
mode, model, query expansion, query-prefix, embedding-request count, and cache
hits/misses. On provider failure it reports `lexical_fallback` and
`semantic_retrieval_unavailable`
(`packages/database/src/chronicle-context-repository.ts:538-714`).

Chunked retrieval reports configured implementation, mode, semantic availability,
fallback reason, embedded/ranked candidate counts, query expansion, query prefix,
embedding-request count, cache hits/misses, and diversity diagnostics
(`packages/database/src/chronicle-context-repository.ts:1061-1098,1234-1261,1389-1412`).
The outer preview adds the number of scope-eligible candidates before returning
the result (`packages/database/src/chronicle-context-repository.ts:1780-1786,1962-1991`).

These fields support several useful inferences but not the full requested audit:

| Current fields | Safe inference | Missing distinction |
| --- | --- | --- |
| `implementation=chunked_hybrid`, `semanticAvailable=true` | Chunk semantic ranking contributed | Dedicated embedding profile versus text-role fallback |
| `implementation=legacy_hybrid`, `semanticAvailable=true` | Legacy parent-memory semantic ranking contributed | Dedicated embedding profile versus text-role fallback |
| `fallbackReason=chunk_index_not_ready`, `semanticAvailable=true` | Configured chunk retrieval executed complete legacy semantic retrieval | Effective implementation is not explicit |
| `semanticAvailable=false`, `mode=lexical` or `lexical_fallback` | Final selection did not use semantic ranking | Whether a provider was unconfigured, resolved but failed, or was never called must be pieced together from reason/counts |
| `embeddingRequests=0`, cache hits greater than zero | Semantic query vectors came from cache | Provider identity/source still matters even though there was no live call |
| `embeddingRequests=1` | A live embedding request was attempted | Success versus failure and provider source are not represented as one closed state |

The real PostgreSQL coverage already proves that a failed text-role embedding
endpoint executes the complete legacy path, makes one embedding attempt, and
runs no chunk-rank SQL
(`tests/integration/chronicle-chunk-retrieval.integration.test.ts:785-880`).
Provider integration tests separately prove the source distinction
`dedicated_embedding` versus `text_fallback`
(`tests/integration/provider-postgres-adapters.integration.test.ts:146-186`).
The missing step is carrying those two independently proven facts into one
generation-time audit record.

### Existing operational telemetry is not a permanent turn audit

`chronicle_retrieval_runs` and `chronicle_retrieval_candidates` store safe,
owner/campaign/world-version-scoped comparison metadata. The schema stores a
query hash rather than query text, a provider fingerprint, per-implementation
latency/fallback codes, and candidate IDs/ranks rather than prompt content. Its
comments expressly forbid raw queries, actions, narration, prompts, responses,
endpoints, and credentials
(`database/migrations/0074_chronicle_retrieval_observability.sql:1-79`).

The repository validates the strict contract, writes inside a savepoint when a
caller owns the transaction, and enforces 30-day/5,000-run-per-campaign
retention (`packages/contracts/src/memory.ts:14-78`;
`packages/database/src/chronicle-retrieval-observability-repository.ts:17-125`).
The context repository currently writes these rows only when shadow comparison
is enabled, and treats all telemetry failures as non-blocking
(`packages/database/src/chronicle-context-repository.ts:1918-1960`). Integration
tests confirm telemetry failure cannot change the selected prompt and that raw
query/endpoint data does not escape
(`tests/integration/chronicle-retrieval-observability.integration.test.ts:601-643`).

This is the right behavior for diagnostic telemetry, but its optional writes,
retention policy, lack of generation-job/turn linkage, and provider-source gap
make it the wrong authority for a permanent turn audit.

Provider cost events also cannot fill the gap. They can link a provider call to
a generation job and later to its turn, but a row exists only when the provider
reports cost. They also cannot prove semantic use after a cache hit
(`database/migrations/0015_campaign_cost_events.sql:4-49`;
`packages/database/src/cost-repository.ts:44-90`).

## Recommended audit contract

Add a strict contract in `packages/contracts/src/memory.ts` and use it in both
the application preview and the generation/turn projections. Suggested shape:

```ts
type ChronicleRetrievalAuditV1 = Readonly<{
  auditVersion: "chronicle-retrieval-audit-v1";
  configuredImplementation: "legacy_hybrid" | "chunked_hybrid";
  effectiveImplementation: "legacy_hybrid" | "chunked_hybrid";
  effectiveMode: "semantic_hybrid" | "lexical_only";
  fallbackCode: string | null;
  semanticProvider: Readonly<{
    resolutionSource: "dedicated_embedding" | "text_fallback" | "none";
    resolvedRole: "embedding" | "text" | null;
    providerProfileId: string | null;
    providerType: string | null;
    model: string | null;
    fingerprint: string | null;
  }>;
  queryVectorSource: "provider_call" | "query_cache" | "none";
  providerCallOutcome: "succeeded" | "failed" | "not_attempted";
  queryEmbeddingRequests: number;
  queryCacheHits: number;
  queryCacheMisses: number;
}>;
```

The exact names are less important than these semantics:

- Keep **configured** and **effective** implementation separate. A chunked
  configuration can execute legacy semantic retrieval while the chunk index is
  unavailable, or legacy lexical retrieval after provider failure.
- Keep provider **resolution source** separate from provider-call outcome. A
  text-role endpoint may have been selected and then failed; the audit should
  say both things.
- Keep `semanticProvider` even on a cache hit. No live request occurred, but the
  cached query vector and indexed document vectors still belong to a specific
  provider/model/fingerprint identity.
- Treat `text_fallback` as “a text-role provider used through the embedding
  interface,” not as proof that the story-generation request and the embedding
  request were the same model call. Story text provider metadata is already a
  separate part of `turns.model_metadata`
  (`packages/database/src/generation-execution-repository.ts:435-445`).
- Use only closed enums and bounded safe strings. Never include base URLs,
  credentials, raw query/action/narration, provider response bodies, or raw
  errors. This matches the existing telemetry boundary
  (`database/migrations/0074_chronicle_retrieval_observability.sql:76-79`;
  `docs/architecture/0028-chunked-chronicle-retrieval.md:96-111`).

## Recommended data flow

```text
ProviderResolutionPort.resolveEmbedding
  -> Chronicle resolution identity (source, resolved role, profile, type, model)
  -> legacy or chunked retrieval execution
  -> typed ChronicleRetrievalAuditV1
  -> context preview
  -> generation contextDiagnostics
  -> accepted turn model_metadata.chronicleRetrieval (atomic turn insert)
  -> typed turn API projection
  -> UI audit display (last)

The same execution may also emit retained, best-effort comparison telemetry.
That telemetry is not the accepted-turn audit authority.
```

### Provider boundary

Change `ChronicleTransactionEmbeddingPort.resolve` from `Promise<string | null>`
to a safe resolved identity that preserves `source`, `resolvedRole`, profile ID,
provider type, and resolved model. The application provider contract already
defines this information; the loss occurs in the runtime adapter
(`packages/application/src/providers/types.ts:240-265`;
`services/runtime/src/chronicle-platform-bindings.ts:19-50`;
`services/runtime/src/chronicle-platform-adapter.ts:42-53,78-112`;
`packages/database/src/chronicle-repository.ts:112-151`).

Both `applyContextSemanticRelevance` and `resolveChunkEmbeddingIdentity` should
carry that identity into `RetrievalExecution`, including failed attempts. The
effective implementation should be set at the point that `executeChunked`
chooses either chunked results or `executeLegacyFallback`, rather than inferred
later from `implementation` and `fallbackReason`
(`packages/database/src/chronicle-context-repository.ts:143-167,538-714,760-788,1497-1653`).

### Persistence options and accepted-turn authority

There are two viable durable placements:

1. **Promote the audit inside `turns.model_metadata`.** This is the smallest
   accepted-turn-only change because the same transaction already writes the
   partial retrieval object there. It keeps the historical audit co-located with
   text-model provenance and requires no backfill or new turn column. Its
   disadvantages are JSONB query ergonomics and no record for a generation that
   fails before accepting a turn.
2. **Add a scoped `generation_chronicle_retrieval_audits` table.** Key it by
   owner, campaign, world version, and generation job; snapshot safe provider
   source/type/model; allow `turn_id` to remain null until acceptance; and link
   the row during the accepted-turn transaction. This is preferable if failed
   generations, administrator filtering, or long-term audit queries are product
   requirements. It adds a migration, lifecycle rules, and a decision about
   whether replacement/rewind deletes an audit with its removed turn or retains
   operational history.

For the stated goal of eventually showing the audit in accepted-turn
information, option 1 is sufficient and lowest effort. If failed-generation
auditing is in scope, choose option 2 instead of making
`generation_attempts.request_metadata` the authority. In either design, the
typed audit written or linked during accepted-turn commit is authoritative;
retained comparison telemetry remains diagnostic.

Use `turns.model_metadata.chronicleRetrieval` as the permanent accepted-turn
summary. This is additive, requires no rewrite of existing accepted turns, and
is inserted in the same transaction as narration/state/model metadata. Old turns
simply have no audit field. Do not backfill an “observed” value from current
campaign configuration because it would not prove what happened at historical
generation time (`database/migrations/0001_initial_nexus.sql:68-86`;
`packages/database/src/generation-execution-repository.ts:294-445`;
`docs/architecture/0028-chunked-chronicle-retrieval.md:9-21,43-47,142-151`).

Promote the audit out of the loosely typed nested `contextDiagnostics.retrieval`
shape while retaining the old field temporarily for compatibility. Validate the
audit before `commitAcceptedTurn`; the accepted-turn insert should fail if the
generation executor supplies malformed audit metadata. A validated audit must be
part of the authoritative accepted-turn commit, not a best-effort post-commit
write.

If auditing failed/recoverable jobs is also required, persist the dedicated audit
row immediately after context retrieval. A validated JSONB column on
`generation_jobs` is a smaller alternative, but it is less queryable and still
needs explicit projection/linkage at turn acceptance. `generation_attempts`
currently records context diagnostics only after the initial story response
reaches validation, so it cannot cover every pre-response failure
(`services/runtime/src/generation-executor-adapter.ts:946-987`;
`database/migrations/0005_story_engine.sql:29-59,70-89`).

### Operational telemetry

Continue to keep comparison telemetry optional and retention-bound. It may be
useful to add nullable `generation_job_id`, `effective_implementation`, provider
resolution source, resolved role, and provider-call outcome to retrieval runs,
but that should support analysis rather than turn authority. If a job link is
added, enforce the same owner/campaign composite scope used elsewhere; never
derive ownership from caller-supplied IDs
(`database/migrations/0074_chronicle_retrieval_observability.sql:36-74`;
`database/migrations/0015_campaign_cost_events.sql:25-30`).

### API and UI

Add `chronicleRetrieval` as a typed nullable field to `turnSummarySchema` and
`generationResultSchema`, select only the safe audit projection in
`readTurnPage`, and keep raw `modelMetadata` for compatibility until callers no
longer need it (`packages/contracts/src/client-api.ts:269-282,334-355`;
`packages/database/src/play-loop-read-repository.ts:86-120`;
`services/api/src/server.ts:1017-1034`).

UI work should be last. The replacement Campaign History currently renders turn
summary data, and the story client loads the same bounded turn endpoint
(`apps/web-next/src/campaign-editor-page.ts:115-118,338-338`;
`apps/web/src/story.js:266-302`). Use one shared formatter that renders labels
such as:

- `Chunked semantic - dedicated embedding provider`
- `Chunked semantic - text-role provider fallback`
- `Legacy semantic - chunk index not ready`
- `Legacy lexical - embedding provider unavailable`
- `Legacy lexical - semantic retrieval disabled`

Do not expose provider fingerprints or internal profile IDs in ordinary player
UI. An administrator-only diagnostic detail can show the safe provider name,
type, and model by resolving the owner-scoped profile. The repository guidance
marks `apps/web/public/index.html` as reference-only, so implementation must
confirm which legacy turn surface is still supported rather than editing that
file for parity (`AGENTS.md:104`).

## Test work required

### Contract and unit tests

- Parse every closed audit state and reject contradictory combinations, such as
  `effectiveMode=semantic_hybrid` with `resolutionSource=none`.
- Prove provider resolution preserves `dedicated_embedding`, `text_fallback`,
  and `none` through the Chronicle runtime port.
- Prove effective implementation differs from configured implementation on
  complete legacy fallback.
- Prove a cache hit reports semantic use with `queryVectorSource=query_cache`
  and no provider call.
- Prove a failed text-role embedding request records an attempted
  `text_fallback` provider plus effective legacy lexical retrieval.
- Prove raw errors, endpoints, credentials, queries, actions, and narration fail
  audit validation or are absent from serialization.

### PostgreSQL and generation tests

- Dedicated embedding provider plus ready chunks -> chunked semantic audit.
- Text-role fallback plus ready chunks -> chunked semantic audit with
  `resolvedRole=text`.
- Chunk index not ready -> complete legacy path, recording whether legacy
  parent-memory semantics succeeded.
- Provider unavailable, timeout, malformed vector, incompatible dimensions, and
  SQL failure -> legacy lexical audit with the sanitized fallback code.
- Semantic disabled/unconfigured -> legacy lexical with provider source `none`.
- Accepted commit stores the exact validated audit in `model_metadata` without
  changing any earlier turn row; rejected/incomplete generation creates no turn.
- Owner/campaign/world-version isolation applies to audit reads and any optional
  telemetry/job links.
- Branch, rewind, replacement, correction, archive, and import behavior is
  explicit. Corrections must not rewrite the original generation audit.

Existing coverage provides useful starting points:

- Fallback and provider/readiness matrices:
  `tests/integration/chronicle-chunk-retrieval.integration.test.ts:785-1090`.
- Privacy, telemetry retention, and non-blocking telemetry failure:
  `tests/integration/chronicle-retrieval-observability.integration.test.ts:181-225,601-695`.
- Atomic accepted-turn commit and immutable turn inspection:
  `tests/integration/generation-execution-repository.integration.test.ts:270-350`.
- Portable archives exclude derived Chronicle telemetry and provider IDs:
  `tests/integration/campaign-archive.integration.test.ts:370-393,395-495`.

## Portable export and privacy decision

Current portable campaign export deliberately whitelists only `providerType`,
`model`, and `promptProtocolVersion` from turn model metadata, so the nested
retrieval diagnostics do not leave the installation. Derived chunk/cache/
telemetry records are separately excluded
(`services/runtime/src/campaign-archive-export-composition.ts:59-76,91-126`;
`tests/integration/campaign-archive.integration.test.ts:370-393,451-489`).

Recommended default: keep the full audit local and owner-scoped. If portable
provenance is later desired, export only `auditVersion`, configured/effective
implementation, effective mode, provider source/role/type, model, and fallback
code. Exclude profile IDs, fingerprints, cost IDs, candidate IDs, endpoints, and
all raw content. This is a product decision and should not be changed implicitly
while adding the local turn projection.

## Future advanced embedding input and chunk controls

### Current hard-coded/defaulted behavior

The embedding HTTP request itself sends only `model` and `input`; it does not
send an embedding context-window parameter
(`packages/story-engine/src/providers.ts:684-717`). The surrounding Chronicle
pipeline currently controls:

| Control | Current source | Current value or behavior |
| --- | --- | --- |
| Chunk target | `packages/domain/src/chronicle-chunking.ts:48-58` | 384 estimated tokens |
| Chunk overlap | `packages/domain/src/chronicle-chunking.ts:48-58` | 32 estimated tokens |
| Unknown maximum input | `packages/domain/src/chronicle-embedding-capabilities.ts:57-73` | Half the provider context window, capped at 8,192 |
| Safety margin | `packages/domain/src/chronicle-embedding-capabilities.ts:76-87` | 8 percent of effective maximum input |
| Unknown batch item capacity | `packages/domain/src/chronicle-embedding-capabilities.ts:47-55,76-87` | 16 items |
| Input, batch, dimensions, retry overrides | `packages/domain/src/chronicle-embedding-capabilities.ts:26-45,68-88` | Bounded provider-profile configuration |
| Document/query prefixes | `packages/domain/src/chronicle-memory-helpers.ts:53-63` | Nomic defaults or campaign overrides |
| Campaign batch size | `services/runtime/src/chronicle-chunk-worker-execution.ts:72-87` | Lowers provider batch capacity |
| Oversized content | `packages/domain/src/chronicle-embedding-capabilities.ts:91-147`; `services/runtime/src/chronicle-chunk-worker-execution.ts:90-109` | Deterministically split to provider capacity |

The campaign UI already exposes provider, model, batch size, and document/query
prefixes, but not maximum input tokens, batch token capacity, dimensions,
retries, chunk target, or overlap
(`packages/contracts/src/memory.ts:143-163`;
`apps/web-next/src/campaign-editor-page.ts:197-220`).

### Recommendation

Do not add one unrestricted “embedding context window” field. Increasing it does
not by itself enlarge a normal 384-token chunk, and an incorrect value can make
requests exceed a real provider limit. Instead:

1. Put provider capability overrides (`embeddingMaxInputTokens`, batch item/token
   limits, dimensions, retries) in an **Advanced provider capabilities** section.
   Keep the current server-side bounds and label dimensions as validation unless
   the transport later supports requesting a reduced vector size.
2. Keep chunk target/overlap separate from provider capacity. If exposed, use
   named presets such as `compact`, `balanced`, and `broad`, with bounded values
   and a stable policy ID rather than arbitrary numbers by default.
3. Add an explicit `chunkPolicyVersion` or policy fingerprint to configuration,
   job progress, chunk rows/readiness, and the retrieval audit. Changing target
   or overlap changes derived chunk boundaries and must invalidate/rebuild the
   chunk index before chunked production is eligible.
4. Show the operational consequence before save: the campaign will use complete
   legacy retrieval until the new derived index reaches readiness. Existing
   accepted turns and parent Chronicle memories remain unchanged.
5. Put UI changes last, after schema/contract, invalidation, worker, readiness,
   fallback, and test behavior are complete.

This follows the current rebuild pattern: changes to provider/model/prefix
identity clear only derived chunk-vector fields, bump work, and enqueue chunk
indexing; retrieval falls back until compatible chunks are ready
(`packages/database/src/chronicle-repository.ts:997-1055`;
`services/runtime/src/chronicle-chunk-worker-execution.ts:179-188,254-328`;
`docs/architecture/0028-chunked-chronicle-retrieval.md:71-101`). A chunk policy
change must be stronger than the existing vector-only invalidation because it
changes chunk text and offsets, not only vector identity.

### Benefits and costs

Benefits of advanced controls are compatibility with providers that report
incorrect limits, deliberate latency/cost tuning, and controlled experiments
with retrieval granularity. Costs are a larger support surface, full derived
reindexing after policy changes, new calibration work, and a real risk that large
chunks reduce precision while small overlapping chunks increase storage, request
volume, and duplicate evidence. Named, versioned presets make those tradeoffs
auditable and reproducible.

## Proposed implementation sequence

1. Define and test `ChronicleRetrievalAuditV1` and a typed context-preview result.
2. Preserve embedding resolution source/role/type/model through the Chronicle
   provider port.
3. Derive configured implementation, effective implementation, mode, provider
   source, vector source, call outcome, and sanitized fallback code in one pure
   audit builder.
4. Persist the validated audit atomically in accepted-turn model metadata; add
   optional generation-job persistence only if failed-job auditing is required.
5. Extend operational telemetry only if analysis needs a job link or provider
   source. Keep it best-effort and retention-bound.
6. Add the safe typed turn API projection and update clients.
7. Implement turn-information UI last, using a shared formatter across supported
   surfaces.
8. Separately implement advanced embedding capability controls, then versioned
   chunk-policy presets and rebuild/readiness behavior. Recalibrate retrieval
   before exposing those presets broadly.

## Effort estimate

- **Per-turn retrieval/provider audit without failed-job history:** medium. Most
  data already flows through `contextDiagnostics`; the work is contract closure,
  provider-source propagation, effective-path derivation, atomic validation,
  API projection, and tests.
- **Audit including every failed/recoverable generation:** medium-to-large. It
  adds durable pre-provider-call job persistence, migration/retention semantics,
  and recovery/retry tests.
- **Advanced provider capability UI only:** small-to-medium after contract and
  validation decisions, because bounded backend overrides already exist.
- **User-selectable chunk target/overlap:** large. It changes derived content
  identity, readiness and rebuild rules, evaluation/calibration, operations, and
  UI rather than merely forwarding a request parameter.

## Open decisions and uncertainties

1. Should the audit describe only accepted turns, or also failed/recoverable jobs?
   The latter requires earlier durable persistence than the current attempt row.
2. Should safe audit provenance be included in portable exports? Current export
   behavior excludes it.
3. Should ordinary players see provider name/model, or only the effective path
   and fallback reason? Provider profile IDs and fingerprints should remain
   administrative/private either way.
4. Which older web surface remains supported for turn-detail parity? Repository
   guidance explicitly makes `apps/web/public/index.html` reference-only.
5. Provider capability documentation says unknown batch capacity defaults to one
   item, while the current runtime and later ADR section use 16. Reconcile the
   documentation before exposing an advanced control
   (`docs/installation/provider-configuration.md:19-25`;
   `docs/architecture/0028-chunked-chronicle-retrieval.md:52-56,245-250`;
   `packages/domain/src/chronicle-embedding-capabilities.ts:47-55`).
6. Chunk-policy preset values require retrieval-quality calibration. The current
   production profile was selected from a deterministic corpus and treats
   profile changes as measured behavior, not arbitrary UI tuning
   (`docs/architecture/0028-chunked-chronicle-retrieval.md:180-208`).
