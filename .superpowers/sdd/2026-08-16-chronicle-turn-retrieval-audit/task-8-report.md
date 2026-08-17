# Task 8 report — final Chronicle retrieval audit verification

## Status

Complete. All Task 8 executable, database, evaluator, privacy, long-campaign,
and rendered UI gates passed on 2026-08-17. A real provider-vector validation
defect was found through the required RED/GREEN work, repaired in owning code,
and reverified without changing valid-vector selection or token-budget behavior.

## Commands and results

| Command | Result |
| --- | --- |
| `pnpm check` | Exit 0; repository boundary/data checks across 1,187 files and all TypeScript/web checks passed. |
| `pnpm test:unit` | Exit 0; 185 files, 2,072 passed, 44 skipped, 2,116 total. |
| `pnpm build` | Exit 0; TypeScript plus Legacy and replacement Vite bundles passed. Existing unresolved-at-build font notices remain runtime-resolved warnings. |
| `node scripts/run-isolated-integration.mjs` | Exit 0; 65/65 discovered files, 519 passed, 177 skipped, 696 total. |
| Legacy evaluator | Exit 0; `tmp/chronicle-evaluation/final-audit-legacy.json`. |
| Chunked evaluator | Exit 0; `tmp/chronicle-evaluation/final-audit-chunked.json`. |
| Required privacy `rg` scan | Reviewed; no forbidden value enters the audit contract/object. |
| `git diff --check` / `git diff --cached --check` | Exit 0. |

The integration database was the local Docker container
`infinitequest-integration-postgres`, database and role `infinitequest_test`,
PostgreSQL 18.4 on Debian x86_64. No credential is recorded here. All 65 files
ran individually against the real database. The 177 skips were explicit,
pre-existing capability cases for unrelated platform/archive/image/secure-
filesystem paths; no Chronicle retrieval/audit test skipped.

## Evaluator evidence

Both final outputs contain 17 cases from corpus `v2`, hash
`1cd534c1585a81865572beb4fd7748e7ac817d248269a3c0c7ebcb93d415951f`.

- Legacy: recall@5/10/20 `0.7352941176470589`; MRR
  `0.7706558485463151`; nDCG `0.7552612693115515`; duplicate rate `0`;
  relevant memories/token `0.0054557124518613605`; leakage `0/0/0`; latency
  p50/p95 `6/22 ms`; embedding requests/cost `3/0`; semantic-only hits `3`;
  promotions/demotions `164/164`.
- Chunked: recall@5/10 `0.8235294117647058`, recall@20 `1`; MRR
  `0.7757352941176471`; nDCG `0.8667030368443928`; duplicate rate `0`;
  relevant memories/token `0.007233273056057866`; leakage `0/0/0`; latency
  p50/p95 `6/40 ms`; embedding requests/cost `3/0`; semantic-only hits `3`;
  promotions/demotions `138/141`.

## RED/GREEN repair

The long-campaign provider-failure matrix was expanded to cover timeout,
empty/malformed vectors, and incompatible dimensions under a text-role
embedding fallback. The first focused PostgreSQL run was RED: 10 tests passed,
1 failed. The incompatible vector was cached before compatibility was proven,
so legacy fallback reused it and falsely reported semantic success.

Commit `fb177c1` (`Reject unusable Chronicle query vectors`) validates that a
provider vector is non-empty, finite, and dimension-compatible before caching
or success attribution in either retrieval path. Focused GREEN was 11/11 tests.
The assertions prove the same scopes and token budget as baseline legacy,
lexical-only continuation when both semantic paths are unusable, no chunk-rank
query after fallback, and preserved campaign/world-version isolation. Valid
vectors and their selection/budget semantics are untouched.

Task 8 also repaired stale verification fixtures and evaluator provider
resolution in commits `c313fea`, `66344de`, `a27f4a6`, `9616289`, `18dc606`,
and `cbefa9b`. These repairs were required before the final clean gates.

## Privacy evidence

The required scan searched the six specified contract/database/runtime/UI files
for endpoint, credential, raw content, provider-profile, and fingerprint terms.
Every match was classified as an existing non-audit provider/cache execution
path, normal narration rendering, or exclusion assertion. The strict accepted-
turn audit contains only safe type/model labels, closed enum values, and bounded
counters. It excludes endpoints, credentials, prompts/queries/actions,
narration/memory/provider content, profile IDs, fingerprints, candidate IDs,
and raw errors.

Only Task 8-owned documentation/report changes are to be staged for the final
evidence commit. Existing `.claude/CLAUDE.md`, `AGENTS.md`, cleanup-report
deletions, and the untracked source plan belong to other work and remain
untouched.

## UI evidence

A temporary ignored same-origin HTTP harness served the real built Legacy and
replacement bundles and mock API responses containing a recorded audit plus a
historical null audit.

- Replacement `/app/campaigns/:campaignId/history`: rendered two audit blocks,
  the recorded text-role/live-provider/fallback state and the Unknown state;
  no browser console errors.
- Legacy `/story/:campaignId`: the real `#turnPill` opened the history dialog,
  which rendered the same recorded and Unknown meanings; no browser console
  errors.

This supplies live API-backed browser proof for both surfaces. It closes Task
7's historical Legacy API-browser gap, which previously had real DOM/modal and
bundle evidence only. Root `index.html` was not changed.

## Deferred minor items and blockers

Task 5 retains two minor test-maintainability follow-ups: add an explicit
immediate-client null/copy-independence assertion, and explicitly provide
`chronicleRetrieval: null` in remaining completed-result fixtures instead of
using type assertions. The complete PostgreSQL gameplay/correction proof now
passes, so these are not runtime, contract, or release blockers.

There are no remaining Task 8 blockers. The final documentation/evidence commit
SHA is reported by the executing agent after this report is committed.

## Review fix round 1 — cache and vector compatibility

Review found that `fb177c1` bounded provider vectors only when provider
configuration declared dimensions. With no declared value, a vector incompatible
with current parent/chunk embeddings could enter the query cache. A stale cached
vector also threw during compatibility validation, forcing fallback instead of
being counted as a miss and replaced by a valid live vector. Correctly sized
all-zero vectors were finite and therefore incorrectly accepted.

Strict PostgreSQL RED evidence:

- Chunk retrieval: 10 passed / 3 failed. The failures independently caught a
  wrong-dimension live vector, an all-zero live vector, and stale incompatible
  cache reuse.
- Legacy query cache: 6 passed / 1 failed. The stale three-dimensional entry
  changed retrieval instead of becoming a miss followed by a live two-
  dimensional replacement.

The owning repair now infers the single compatible dimension from current,
content-hash-valid legacy parent embeddings or current-protocol/content-hash-
valid chunk embeddings whenever provider configuration omits dimensions. Query
vectors must have finite entries and a finite, non-zero norm. Incompatible or
zero live vectors fail before cache insertion or success attribution. An
incompatible cached vector is treated as a logical miss and is overwritten by
the valid provider response; audit counters therefore report provider-only,
one request, zero hits, one miss, and succeeded.

GREEN evidence:

- Chunk retrieval: 13/13 against real PostgreSQL.
- Legacy query cache: 7/7 against real PostgreSQL.
- Transaction repository unit tests: 18/18.
- `pnpm check`: exit 0.
- `git diff --check`: exit 0.

Both stale-cache recovery tests assert unchanged selected scopes and token
budget, a valid live provider retry, truthful audit fields, and a rewritten
two-dimensional cache entry. The failure matrix asserts timeout, empty,
wrong-dimension, and all-zero vectors never leave cache entries and preserve the
complete lexical Legacy fallback.

Round-one commits are `de3502f` (`Align Chronicle audit inventory status`) for
the stale completion-document expectation found by the full unit suite, and
`616803c` (`Recover Chronicle query vector cache`) for the exact production and
RED/GREEN regression repair.

## Review fix round 2 — current chunk dimension inference

Review found that the configured-dimension fallback query in
`resolveChunkEmbeddingIdentity` did not require
`chunk.embedding_content_hash = chunk.content_hash`. A stale embedded chunk
with a different dimension could therefore make inference ambiguous even though
the Chronicle readiness identity deliberately ignores that stale embedding. In
the chunk-not-ready path, Legacy fallback then lacked the current chunk identity
dimension and could accept and cache a wrong-dimension provider vector.

The focused real-PostgreSQL regression creates one current, content-hash-valid
two-dimensional chunk and one stale three-dimensional chunk whose embedding
content hash is null. Before the repair it was RED: 12/13 tests passed. The
stale chunk suppressed dimension inference, and a three-dimensional live vector
was recorded as successful and inserted into the query cache.

The owning repair reuses the exact
`CHRONICLE_READINESS_EMBEDDING_IDENTITY_SQL` predicate for inferred chunk
dimensions, so only current-protocol, current-content embeddings contribute.
It also forwards that inferred current dimension into the complete Legacy
fallback attempt. Provider-configured dimensions retain precedence; otherwise
the current chunk dimension is checked before any provider vector is cached or
attributed as successful. Existing valid-vector selection and token-budget
behavior are unchanged.

GREEN evidence:

- `tests/integration/chronicle-chunk-retrieval.integration.test.ts`: 14/14
  against the isolated real PostgreSQL database.
- `tests/unit/chronicle-transaction-repository.test.ts`: 18/18.
- `pnpm check`: exit 0, including repository-boundary and data-safety checks
  across 1,022 candidate files.
- `git diff --check`: exit 0.

The regression additionally proves unchanged selected scopes and budget versus
the semantic-disabled Legacy baseline; truthful `chunk_index_not_ready`,
`lexical_only`, text-fallback, provider-only audit attribution; one provider
request, zero cache hits, one cache miss; no chunk rank query; and no cache row
after the incompatible live vector is rejected.

The round-two repair commit is `43fb6d4` (`Align Chronicle chunk dimension
inference`).

## Final-review repair wave — model provenance, semantic contribution, and labels

Final review found that the configured campaign embedding model was not carried
through Chronicle provider resolution into the audit, and that successful
Legacy query embedding could be reported as semantic when no current compatible
candidate embedding contributed to selection. It also found that the safe audit
label schema rejected common provider/model naming forms.

The repair threads `embedding_model` through the Chronicle transaction port,
runtime binding, and adapter; records that selected execution model in the
safe audit provenance; and preserves the existing provider/cache trace. A
successful query with zero fresh Legacy candidates now returns the complete
`lexical_only` fallback (`semantic_retrieval_unavailable`) with unchanged
selection and budget, while retaining successful health attribution. Labels are
trimmed non-empty strings up to 500 characters, allow ordinary `@`, `+`, `/`,
and spaces, and reject controls and URI/endpoint-like values.

Strict TDD captured audit-label and model-threading unit REDs, then two isolated
real-PostgreSQL REDs: first missing audit model (7/8), then a semantic-
contribution mismatch versus semantic-disabled Legacy (7/8). GREEN evidence:

- audit-contract, runtime-adapter, and documentation-link units: 27/27;
- real PostgreSQL Legacy/query-cache regression: 8/8;
- real PostgreSQL chunk retrieval: 14/14;
- real PostgreSQL provider adapters: 8/8;
- `pnpm check`: exit 0 before final report-only edits.

The linked plan now records Tasks 1–7 as complete and explicitly leaves the
controller-owned Task 8 full matrix unchecked. The documentation link target
already existed as task-owned untracked content, so its green link-resolution
test was characterized without manufacturing a destructive RED. The detailed
record is `final-review-fix-report.md`; final diff/whitespace evidence is
captured with its scoped repair commit.
