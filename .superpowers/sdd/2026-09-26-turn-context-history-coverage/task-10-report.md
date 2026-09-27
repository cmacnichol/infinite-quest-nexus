# Task 10 report — strict v5 history coverage diagnostics

## Result

V5 now writes a closed, content-free `history-coverage-diagnostics-v1` at
`contextDiagnostics.layers.history`. It is assembled only after the final
planner selection and transport serialization. Legacy and pre-v5 contexts do
not receive this field.

The private schema permits only bounded counters, fixed enums, limits, source
guard counts, and token estimates. It rejects unknown keys, identifiers,
content, and arbitrary error strings. Unavailable ledger, protected-fact, and
recent stages are `null`, rather than synthetic zero-valued objects.

## Final-evidence accounting

- Chronicle counts and `selectedEstimateTokens` come from the final selected
  Chronicle records. Final `writerRequest` and `reviewerRequest` token totals
  remain separate transport measurements.
- Ledger `capturedCount`, `sentCount`, and `omittedCount` use the final sent
  ledger projection. `coveredByRecentCount` records records deliberately
  removed because the corresponding recent-turn evidence survived. The
  explicitly projected ledger measurement is count-only; elapsed time is not
  persisted.
- Protected facts distinguish final sent/omitted records from source omissions.
  The retained source coverage records the bounded-source conditions, while
  `measurementLimitHit` and `unexaminedCount` identify the separate exact
  measurement guard.
- Recent counts distinguish captured and final sent records. Candidate pool
  limits, removed candidates, selector stop reason, and Chronicle fallback
  reason retain their fixed Task 4/Chronicle enum vocabularies.

The executor stores the diagnostic both in its primary-result checkpoint and,
on acceptance, in `turns.model_metadata.contextDiagnostics.layers.history`.
The repository validates that nested value before orchestration persistence and
again before an accepted-turn write. The public safe diagnostic projection does
not add history fields to its allowlist.

## Read-only operator query

The PostgreSQL regression verified the accepted-turn metadata path below. This
query returns only the content-free diagnostic object and routing fields; it
does not read request bodies, provider responses, story text, or state
snapshots.

```sql
SELECT campaign_id,
       turn_number,
       model_metadata #> '{contextDiagnostics,layers,history}' AS history_coverage
FROM turns
WHERE model_metadata #> '{contextDiagnostics,layers,history}' IS NOT NULL
ORDER BY campaign_id, turn_number DESC;
```

## RED / GREEN evidence

- RED: `corepack pnpm vitest run tests/unit/generation-context-contracts.test.ts --reporter=dot` failed before the schema was introduced: `historyCoverageDiagnosticsSchema` was undefined.
- GREEN: task environment plus `corepack pnpm vitest run tests/unit/generation-context-contracts.test.ts tests/unit/generation-context-planner.test.ts tests/unit/generation-executor-adapter.test.ts tests/unit/safe-generation-diagnostics.test.ts tests/unit/generation-context-history-coverage-baseline.test.ts --reporter=dot` passed 5 files and 192 tests.
- GREEN: `corepack pnpm exec tsc -p tsconfig.json --noEmit` passed.
- GREEN: `git diff --check` passed before the implementation commit.
- GREEN, elevated disposable PostgreSQL task environment: `corepack pnpm vitest run --config vitest.integration.task.config.ts tests/integration/generation-execution-repository.integration.test.ts -t "persists only strict content-free history coverage diagnostics" --reporter=dot` passed 1 test, with 46 filtered. It persisted the exact valid object and rejected an unknown private-ID canary without adding a turn.

No browser or live-provider check applies to this private diagnostics change.

## Commit

- `4bb69b76 Add strict history coverage diagnostics`
