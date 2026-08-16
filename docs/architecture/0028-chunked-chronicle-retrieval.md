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
   `0073_chronicle_retrieval_observability.sql`, and
   `0074_chronicle_query_embedding_cache.sql`.
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
    status, at least one chunk is embedded, and no current chunk job is
    queued, running, or failed. Any other state uses the complete legacy path;
    there is no partially trusted mixed production mode.
11. Safe shadow metadata is retained for 30 days and capped at 5,000 runs per
    campaign. Query embeddings are retained for 7 days and capped at 256
    entries per campaign.
12. Rollback changes configuration to legacy retrieval and disables shadowing;
    it never changes accepted turns, parent Chronicle memories, or legacy
    vectors.

Derived chunk rows, vectors, chunk jobs, cache entries, telemetry, and
evaluation data are owner-, campaign-, and world-version-scoped and excluded
from portable exports. `throughTurnNumber` applies before semantic scoring and
entity/scene expansion. Optional semantic, cache, telemetry, evaluation, and
reranking failures fail open to the existing lexical/entity/recency/chronology
path; they never mutate campaign state or block a validated story result.

Text and embedding providers remain independently configured. Retrieval
telemetry never stores credentials, raw prompts, actions, narration, provider
responses, or raw provider errors. The legacy `embed_campaign` path and its
vectors remain available until a separately approved removal plan exists.

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

The deterministic `chronicle-retrieval-evaluation.v1` corpus establishes the
following label-only baseline for `legacy_hybrid` (generated locally at
`tmp/chronicle-evaluation/legacy-baseline.json`, which is not committed):

- recall@5/10/20: 1 / 1 / 1; MRR: 0.8529411764705882;
  NDCG: 0.9348699565126102.
- duplicate rate: 0; relevant memories per prompt token: 0.0823045267489712.
- cross-campaign, future-turn, and superseded-fact leakage: 0 / 0 / 0.
- p50/p95 evaluator latency: 5 ms / 14 ms; embedding requests/cost: 3 / 0;
  semantic-only hits: 3; promotions/demotions: 6 / 6. A promotion or
  demotion is an entry whose selected rank improves or worsens, respectively,
  against the deterministic lexical-only ordering for that same preview.

The report contains fixture labels, hashes, ranks, and aggregates only; it
does not persist prompt or Chronicle content.
