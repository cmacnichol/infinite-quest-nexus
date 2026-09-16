# Historical canonical-fact retrieval: R1 evidence

The enrolled generation path selects old relevant facts before rank fusion instead of limiting all history to the newest 256 facts. Unenrolled generation and public preview retain their existing policy.

## Selection and identity

`chronicle-historical-fact-pool.ts` materializes an eligible set after owner, campaign, pinned world version and historical validity predicates. It reserves 40% lexical, 25% entity, 15% explicit source-turn and 20% recent candidates. Floors and the recent remainder are deterministic. Unused or duplicate reservations go first to remaining positive lexical relevance, then recency. The final size is the existing budget-scaled historical allowance (256 at 32k, capped by the existing 4m retrieval budget). Every row retains its actual canonical UUID and lane-rank metadata. No vectors or inferred entity IDs are created.

Lexical ranking uses an OR of English lexemes from the bounded action fragments. It accepts positive partial matches rather than requiring every word in a natural-language direction. English stemming remains a limitation; this is not a promise of multilingual semantic recall.

The entity lane uses `campaign_canonical_facts.entity_ids` intersected with IDs matched in the scoped pinned entity catalog. For rows with an empty link array, it checks unambiguous catalog names/aliases after NFKC normalization, lowercase and whole-phrase Unicode-aware PostgreSQL boundaries. Aliases shared by multiple entity IDs never receive this boost. Up to 400 aliases are checked in stable normalized order. Unknown/nonempty links do not acquire invented replacements; those records retain other retrieval lanes. Tests cover explicit links, alias-only records, ambiguous names, Japanese boundaries, substring collisions and no inferred-ID writes.

Temporal targeting accepts only an explicit `accepted turn N` reference within the base cutoff. Fictional dates do not become turn ordinals. Correction-created facts, including turn-zero facts, use the same validity predicates. A closed validity interval suppresses later retrieval; it does not erase the fact from earlier cutoffs.

## Isolated PostgreSQL measurement

Measured September 16, 2026 with PostgreSQL 18.6/pgvector in the worktree's loopback Docker test instance. Each synthetic campaign has the stated number of unrelated distractors and one old relevant fact. Twenty warm executions per policy/size; p95 is the 19th sorted observation. The last run had no competing task test suite. Full `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` evidence is in [the benchmark artifact](assets/story-memory-continuity/historical-fact-pool-benchmark.json).

| Distractors + target | Legacy p95 ms | Enrolled p95 ms |
| --- | ---: | ---: |
| 1,001 | 3.74 | 6.10 |
| 10,001 | 15.15 | 41.25 |
| 100,001 | 44.21 | 339.12 |

This is a measured recall/latency tradeoff, not a latency improvement. The eligible set now materializes only identities and scores, then loads complete text for selected rows; an earlier full-row implementation incurred additional temporary-disk work. The current query still scans eligible fact text for lexical relevance, so cost grows with history. No new index is added: existing scope indexes constrain the set, and adding a generated-vector index without changing this scoring query would not remove the scan. A future indexed lexical-lane optimization needs separate write-cost and language-compatibility evidence.

## Verification

- Initial PostgreSQL RED: old exact/entity facts and old-at-cutoff facts were absent behind 320 newer distractors.
- Historical pool: six behavior tests pass, plus the explicit benchmark run.
- Combined historical/chunk/budget-growth PostgreSQL suite: 31 passed, one opt-in benchmark skipped; benchmark separately passed.
- Retrieval profile, diversity and fusion unit suites: 34 passed.
- No live provider was called and no production campaign was read or changed.

Reproduce with the normal integration harness and `tests/integration/chronicle-historical-fact-pool.integration.test.ts`. Set `RUN_HISTORICAL_FACT_BENCHMARK=1` and `HISTORICAL_FACT_BENCHMARK_OUTPUT` to an output path to capture the optional synthetic performance run. The benchmark executes `ANALYZE` only in its isolated disposable test database.
