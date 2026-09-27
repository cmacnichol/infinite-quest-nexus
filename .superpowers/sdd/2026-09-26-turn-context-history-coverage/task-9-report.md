# Task 9 report: captured v5 scene query tail

## Changes

- Added `sceneHintTail(content, maximumCharacters)` to build a whitespace-normalized, fiction-safe ending capped at 1,000 UTF-16 characters. It returns empty for zero or invalid limits, respects grapheme boundaries, and drops a partial leading word when a word boundary is available.
- Passed the captured authority’s effective, corrected, mechanics-sanitized `latestTurn.narration` into deferred candidate retrieval only for the exact history-coverage context protocol. The balanced v5 scene query uses that captured base turn and ignores Chronicle rows as a source of current-scene text. Replacement requests continue to use the already captured N−1 base.
- Preserved v4 memory-prefix planning. The captured tail joins the existing planned query text, query cache identity, embedding batch, chunk-index fallback, and legacy retrieval path; selecting it makes no separate provider call.

## RED / GREEN and verification

- RED helper test: task test environment plus `corepack pnpm vitest run tests/unit/chronicle-query-plan.test.ts`; exit 1 because `sceneHintTail` was not yet exported (`task-9-red-unit.log`).
- RED PostgreSQL regression: focused `chronicle-chunk-retrieval.integration.test.ts` run; exit 1 because the embedded scene query did not retain the corrected ending (`task-9-red-pg2.log`).
- GREEN unit and frozen legacy fixtures: `tests/unit/chronicle-query-plan.test.ts`, `tests/unit/generation-context-planner.test.ts`, and `tests/unit/generation-context-history-coverage-baseline.test.ts`; exit 0, 3 files / 74 tests (`task-9-green-final-unit.log`). This includes 28 unchanged legacy history-context baselines.
- GREEN PostgreSQL regressions: focused chunk retrieval tests for a corrected v5 append with stale Chronicle, a corrected v5 append with no Chronicle row, corrected replacement base N−1 excluding turn N, and unchanged v4 prefix; exit 0, 4 passed / 26 skipped by the test filter. The stale-row case also asserts `chunk_index_not_ready` fallback and at most one normal embedding batch (`task-9-final-pg.log`).
- Query-cache PostgreSQL suite: exit 0, 8 tests (`task-9-cache-pg.log`).
- TypeScript check: `corepack pnpm exec tsc -p tsconfig.json --noEmit`; exit 0 (`task-9-final-tsc.log`). `git diff --check`; exit 0 (`task-9-diff-check.log`).

No live provider or A/B generation was run. The integration tests use deterministic synthetic embeddings.

## Commits

- `88f529e0 Use captured v5 scene query tails`
- The report is recorded separately after that implementation commit.
