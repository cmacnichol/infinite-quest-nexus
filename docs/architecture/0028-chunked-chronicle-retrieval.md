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
    Skip reasons are the closed set `semantic_retrieval_disabled`,
    `chunk_exceeds_provider_capacity`, and the generic `chunk_embedding_skipped`
    bucket, enforced by `0076_chronicle_chunk_skip_reasons.sql`. Every member is
    terminal, so adding a reason can never silently make a campaign ineligible,
    and any unrecognized reason collapses into the generic bucket rather than
    persisting provider text. A chunk that cannot fit one provider request is
    skipped individually while its siblings continue indexing.
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

The deterministic `chronicle-retrieval-evaluation.v3` corpus (SHA-256
`5f9d9a27ab5b8b532e8a051928f051b89b910b836a068ca0bc47d93581af32a1`)
establishes the following label-only baseline for `legacy_hybrid` (generated
locally at `tmp/chronicle-evaluation/legacy-baseline.json`, which is not
committed):

- recall@5/10/20: 0.6428571428571429 / 0.6428571428571429 / 0.6428571428571429;
  MRR: 0.6368289280858802; NDCG: 0.6298235421681389.
- duplicate rate: 0; relevant memories per prompt token: 0.0033738191632928477.
- cross-campaign, future-turn, and superseded-fact leakage: 0 / 0 / 0.
- p50/p95 evaluator latency: 7 ms / 17 ms; embedding requests/cost: 7 / 0;
  semantic-only hits: 8; promotions/demotions: 196 / 194. A promotion or
  demotion is an entry whose selected rank improves or worsens, respectively,
  against the deterministic lexical-only ordering for that same preview.

Each ordinary ranking case declares `distractorCount` in-scope authorized
memories that compete for the same prompt slots and requests a 4,096-token
budget so more candidates are eligible than the diversity policy can select.
The three long-parent cases retain their exact 1,024, 2,048, and 4,096-token
budgets, each with 24 distractors, so tight-budget selection is measured without
changing its production ranking labels. Without this discrimination, every grid
candidate scored a perfect recall, the quality keys tied, and profile selection
collapsed onto tie-breakers instead of retrieval quality.

The report contains fixture labels, hashes, ranks, and aggregates only; it
does not persist prompt or Chronicle content.

## Calibrated production profile

The evaluator selected the checked-in `chronicle-retrieval-profile-v2` profile
from the exhaustive 567-profile bounded-coordinate grid: RRF `k=20`; query
variant weights entity-expanded/scene/open-thread `1 / 0.75 / 1`; lexical/entity
signal weights `0.75`; recency/chronology signal weights `0.75`; and a
per-signal candidate limit of `16`. Its diversity policy selects at most 16
parents and two parents per turn, includes adjacent narration, and uses
semantic/kind/entity values `4 / 1 / 0.5`.

Against the same corpus, the selected profile produced recall@5/10/20 of
`0.7142857142857143 / 0.7142857142857143 / 1`, MRR
`0.6537698412698413`, NDCG `0.7615948030961166`, duplicate rate `0`, and
`0.005273566249176005` relevant memories per prompt token. Calibration recorded
p50/p95 evaluator latency of `6 / 28 ms`, zero embedding requests/cost from a
warm cache, and leakage `0 / 0 / 0`. A separate selected-profile evaluator pass
recorded `6 / 42 ms` and seven requests/cost `0`; both latency readings satisfy
the v3 legacy-derived p95 gate. The profile values are evaluator-generated rather
than hand-selected.

Query planning keeps the deterministic action, entity-expanded, scene, and
open-thread order and all existing per-variant limits. The action is always
retained. Later variants are omitted only when NFKC-normalized substantive terms
and entity IDs are both already covered; the fixed connective set prevents
formatting words from manufacturing novelty. The v3 `repeated-hint` case records
safe cache-derived `queryVariants` metadata and reduced cold-cache variants from
three to two without a ranking, leakage, or tight-budget regression.

Selection is reproducible from the corpus alone. Wall-clock latency and
embedding request counts are recorded as diagnostics but are excluded from the
selection keys: p95 is measurement noise and the request count depends on how
warm the query cache happened to be when a candidate ran, so including either
made calibration choose a different profile on every run. Latency remains a
pass/fail gate. Because those diagnostics are not reproducible, the staleness
check in `pnpm evaluate:chronicle -- --implementation chunked_hybrid` compares
only the deterministic metrics and fails when retrieval changes land after
calibration without the profile being regenerated.

Generation uses this profile only when a campaign is explicitly configured
for `chunked_hybrid`. Calibration does not update campaign configuration, so
existing and newly defaulted campaigns remain on `legacy_hybrid` until an
operator or future explicit product action opts them in.

## Long-campaign behaviour

A scaling review of 100-plus-turn campaigns measured retrieval against a real
database and found the retrieval path healthy but the indexing path unable to
keep up. Chunked previews cost roughly 115 ms at 100 turns (303 chunks) and
253 ms at 200 turns (603 chunks), which is immaterial next to story
generation, and chunked selection stayed at exactly 16 parents at every
campaign length. Growth itself is bounded by design: the living campaign
summary and open-thread records are singletons updated in place, because
`chronicle_memories` is unique on `(campaign_id, turn_id, memory_kind)` with
`NULLS NOT DISTINCT`, so a campaign accumulates roughly one derived parent per
accepted turn.

Five changes came out of that review.

1. **Incremental parent selection.** `loadForClaim` previously returned every
   parent in scope and the worker re-embedded all of them, while the job's work
   signature changes on every accepted turn. A single turn therefore triggered a
   complete re-embed of the campaign, making per-turn indexing cost grow with
   campaign length and total cost grow quadratically. Parents that already hold
   terminal chunks at their current content hash and protocol version are now
   filtered out in SQL, so a turn costs work proportional to what actually
   changed. `totalParents` still counts every parent in scope so the worker's
   mid-run parent-total invariant is unaffected. Because skipped parents mean the
   committed parent is no longer the cursor's immediate successor,
   `commitParentBatch` now fences on the parent's own identity while still
   requiring it to be strictly ahead of the durable cursor.
2. **Resumable progress across appended parents.** Any signature change used to
   clear the durable cursor, so a turn accepted during a long initial backfill
   restarted it from zero and the readiness gate could never be reached on an
   actively played campaign. `chronicle_chunk_jobs.processed_signature`
   (migration `0077`) records the signature of the parents at or before the
   cursor. When it still matches, the cursor is preserved and the job resumes;
   when an already-processed parent changed, the cursor is cleared and the job
   restarts, so a stale prefix can never be skipped.
3. **Batched embedding by default.** Unknown provider batch capacity resolved to
   one document per request, making a reindex cost one HTTP round trip per chunk
   and dominating indexing time. The unknown default is now 16, still lowered by
   the campaign batch size and still overridable with `embeddingMaxBatchItems`.
   Safety is unchanged: `assertCompleteEmbeddingBatch` rejects any response that
   does not return one vector per requested document.
4. **Vectors loaded once per preview.** The authorized-chunk projection rendered
   `embedding::text` for every candidate, and a chunked preview issues up to 17
   rank queries, so the campaign's vectors were serialised once per signal per
   variant. Vectors are needed only for the maximal-marginal-relevance penalty,
   so they are now fetched in a single query for the fused candidate set.
5. **Bounded legacy chronological coverage.** Legacy retrieval added every turn
   memory for chronological coverage and relied on the token budget to trim,
   so a 100-turn campaign put 100 Chronicle entries into the prompt and crowded
   out relevance-selected entries. Coverage is retained as a deterministic
   evenly-spaced sample of at most 32 entries, so early, middle, and late
   history all survive within a bounded size.

Together these keep per-turn indexing proportional to changed content rather
than campaign length, which is what allows the readiness gate to be reached and
held on a campaign that is being actively played.

## Future enhancements

Future work may expose bounded provider capability controls and versioned chunk
policy presets, but must not present one unrestricted embedding-context value.
Provider limits and chunk granularity are different concerns: changing provider
limits affects request validation and batching, while changing chunk target or
overlap changes derived content identity and requires a complete compatible
rebuild plus retrieval recalibration.

Chronicle retrieval should also gain a typed, privacy-safe per-turn audit that
separately records the configured and effective retrieval implementations,
semantic versus lexical use, dedicated-embedding versus text-role-provider
resolution, provider call versus query-cache use, and any sanitized fallback
reason. Operational shadow telemetry remains best-effort and retention-bound;
the accepted-turn audit must be written atomically with the turn and must not
rewrite existing accepted turns.

The source investigation, proposed contract, implementation sequence, test
matrix, privacy boundary, and effort assessment are recorded in
[Chronicle retrieval audit and embedding controls future enhancement](../review/chronicle-retrieval-audit-future-enhancement.md).
