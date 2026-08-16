# ADR 0028: Chunked Chronicle retrieval remains derived and rollback-safe

## Status

Accepted

## Context

Chronicle's existing memory-level embeddings can return a useful whole turn or
fact, but long memories dilute retrieval precision and make it difficult to
measure the value of semantic retrieval. The platform needs deterministic,
campaign-scoped chunk embeddings and calibrated hybrid retrieval without
making a derived index authoritative or weakening correction, historical-cutoff,
ownership, world-version, or prompt-safety guarantees.

Accepted turns are the recovery ledger. Narration corrections are append-only
records whose effective narration is exposed through `effective_turn_narrations`.
Indexing, configuration changes, retrieval, and branching must therefore never
rewrite a source campaign's accepted `turns` rows. Integration coverage captures
each row's complete ordinary-column JSON plus PostgreSQL `xmin` before derived
Chronicle work and requires exact equality afterwards.

## Decision

`MemoryGenerationTransactionPort.buildContextPreview(database, scope)` remains
the sole generation-facing retrieval seam. The Chronicle implementation behind
that method may select the existing legacy path or chunked retrieval, but its
internal chunking, query planning, rank-fusion, diversity, cache, telemetry,
and evaluation modules are not added to `MemoryGenerationTransactionPort`.

The following decisions govern the implementation.

1. Migrations are named `0072_chronicle_memory_chunks.sql`,
   `0073_chronicle_chunk_job_fencing.sql`,
   `0074_chronicle_retrieval_observability.sql`, and
   `0075_chronicle_query_embedding_cache.sql`. Fencing is an additive migration
   because `0072` may already be recorded on a deployed database. It adds token
   storage, backfills deterministic work signatures, and requeues tokenless
   running claims with a new work version and cleared cursor so no pre-upgrade
   executor retains authority. A unique token is generated when the job is next
   claimed. Editing `0072` in place would upgrade only fresh databases and leave
   previously migrated installations incompatible with the token-fenced worker.
2. `chronicle_memory_chunks` owns a chunk's text metadata and nullable vector
   together so content/vector eligibility is atomic. Retrieval continues to use
   exact campaign-scoped pgvector scans; no ANN index is added.
3. `chronicle_memories` gains only generated SHA-256 `content_hash` metadata.
   `turns` receives no embedding column, trigger, or index write.
4. Protocol `chronicle-chunk-v1` normalizes text with NFKC and LF line endings,
   then orders deterministic chunks: turn actions are one chunk; narration is
   paragraph/sentence-packed; canonical facts and open threads are one chunk
   each; living and legacy summaries are heading/paragraph/sentence-packed.
5. Provider capabilities come from the runtime descriptor with safe optional
   configuration overrides. Unknown batch support is one item per request,
   unknown token capacity is half the configured context window capped at
   8,192 tokens, and dimensions are learned from the first complete batch then
   pinned.
6. Chunk work uses `chronicle_chunk_jobs` with fixed kind
   `index_memory_chunks_v2`; older workers cannot claim or misinterpret it. The
   worker retains lease, heartbeat, work-version, content-aware commit, and
   durable-cursor semantics.
7. `campaign_memory_configs` gains `retrieval_implementation`, constrained to
   `legacy_hybrid` or `chunked_hybrid`, plus `retrieval_shadow_enabled`. Their
   defaults are `legacy_hybrid` and `false`.
8. Chunked ranking uses weighted reciprocal-rank fusion. The production profile
   is generated deterministically from the evaluation corpus; hand-tuned
   weights are not production configuration.
9. Diversity initially selects at most one chunk per parent and at most two
   parents from one turn, collapses canonical-fact lineage, removes normalized
   duplicates, and applies maximal-marginal-relevance only as a deterministic
   post-fusion penalty.
10. Chunked production is eligible only when every current parent hash has
    current-protocol chunks in terminal `embedded` or sanitized `skipped`
    status, every current chunk is terminal, at least one current chunk is
    embedded, and the latest current chunk job is completed or absent. A
    fully sanitized-skipped index uses the complete legacy path with the
    existing `chunk_index_not_ready` fallback. Any other state also uses the
    complete legacy path; there is no partially trusted mixed production mode.
11. Safe shadow metadata is retained for 30 days and capped at 5,000 runs per
    campaign. Query embeddings are retained for 7 days and capped at 256
    entries per campaign.
12. Rollback changes configuration to legacy retrieval and disables shadowing;
    it never changes accepted turns, parent Chronicle memories, or legacy
    vectors.
13. Rollout deploys compatible code and the derived schema before any shadow
    work, leaves all campaigns on legacy production while chunk jobs reach 100%
    terminal coverage, calibrates the generated profile, then enables shadow
    and production for explicitly selected campaigns only.

Derived chunk rows, vectors, chunk jobs, cache entries, telemetry, and
evaluation data are owner-, campaign-, and world-version-scoped and excluded
from portable exports. `throughTurnNumber` applies before semantic scoring and
entity/scene expansion. Optional semantic, cache, telemetry, and evaluation
failures fail open to the existing lexical/entity/recency/chronology path; they
never mutate campaign state or block a validated story result.

There is no reranking stage and no reranker-provider request. Weighted
reciprocal-rank fusion combines the independent signals, and deterministic
duplicate/diversity rules apply a post-fusion penalty without invoking another
model.

Text and embedding providers remain independently configured. Retrieval
telemetry never stores credentials, raw prompts, actions, narration, provider
responses, or raw provider errors. The legacy `embed_campaign` path and its
vectors remain available until a separately approved removal plan exists.

## Rollout

The migration sequence is expand-only and creates derived schema and job kinds;
it does not alter production retrieval selection. Operators first deploy
compatible API and worker code, apply migrations, leave all campaigns on
`legacy_hybrid`, and build chunks through `index_memory_chunks_v2`. A campaign
must reach the complete readiness gate in decision 10 before shadow is enabled.

Release engineers then run the deterministic legacy evaluation, calibrate and
review the generated profile, and exercise shadow comparison on selected ready
campaigns. Shadow metadata is diagnostic only and its `selectedForProduction`
flags prove that it did not affect production context. Only after the release
criteria pass does an operator explicitly configure a selected campaign for
`chunked_hybrid`; no migration, evaluator, worker, or startup path converts a
campaign automatically.

## Rollback

Use the following configuration rollback. It leaves accepted turns, Chronicle
parents, and legacy vectors in place, so a later rebuild remains possible.

```sql
UPDATE campaign_memory_configs
   SET retrieval_implementation = 'legacy_hybrid',
       retrieval_shadow_enabled = false,
       updated_at = now()
 WHERE retrieval_implementation <> 'legacy_hybrid' OR retrieval_shadow_enabled;
```

## Consequences

- Accepted turns retain their full row identity and physical-row version while
  derived Chronicle data is rebuilt, embedded, retrieved, or branched.
- Corrections rebuild from effective narration without rewriting
  `turns.narration`.
- Chunked retrieval can be evaluated and shadowed safely before it is selected
  for production context construction.
- Disabling chunked retrieval is a bounded configuration operation rather than
  a destructive database migration or historical-state recovery procedure.

## Legacy baseline

The deterministic `chronicle-retrieval-evaluation.v1` corpus (SHA-256
`f1942b9d57c5d45aadc02922c80aa5c7915071d75945c9d63bb2c170917631ed`)
establishes the following label-only baseline for `legacy_hybrid` (generated
locally at `tmp/chronicle-evaluation/legacy-baseline.json`, which is not
committed):

- recall@5/10/20: 0.9117647058823529 / 0.9117647058823529 /
  0.9117647058823529; MRR: 0.9411764705882353;
  NDCG: 0.9317318575468456.
- duplicate rate: 0; relevant memories per prompt token: 0.11258278145695365.
- cross-campaign, future-turn, and superseded-fact leakage: 0 / 0 / 0.
- p50/p95 evaluator latency: 6 ms / 19 ms; embedding requests/cost: 3 / 0;
  semantic-only hits: 3; promotions/demotions: 1 / 1. A promotion or
  demotion is an entry whose selected rank improves or worsens, respectively,
  against the deterministic lexical-only ordering for that same preview.

The report contains fixture labels, hashes, ranks, and aggregates only; it
does not persist prompt or Chronicle content.

## Calibrated production profile

The exhaustive 243-profile grid selected the checked-in
`chronicle-retrieval-profile-v2` profile: RRF `k=20`; semantic query-variant
weight `0.75`; lexical/entity signal weights `0.75`; recency/chronology signal
weights `0.75`; and a per-signal candidate limit of `32`. Its diversity policy
selects at most 16 parents and two parents per turn, includes adjacent
narration, and uses semantic/kind/entity values `4 / 1 / 0.5`.

Against the same corpus, the selected profile produced recall@5/10/20 of
`0.9705882352941176 / 0.9705882352941176 / 0.9705882352941176`, MRR
`0.9411764705882353`, NDCG `0.9772439525156154`, duplicate rate `0`, and
`0.11377245508982035` relevant memories per prompt token. Leakage remained
`0 / 0 / 0`; p50/p95 evaluator latency was `12 ms / 15 ms`, below the
`44 ms` legacy-derived gate; embedding requests/cost were `3 / 0`; and
semantic-only hits and promotions/demotions were `3` and `0 / 0`.

Generation uses this profile only when a campaign is explicitly configured
for `chunked_hybrid`. Calibration does not update campaign configuration, so
existing and newly defaulted campaigns remain on `legacy_hybrid` until an
operator or future explicit product action opts them in.
