# Task 3 report: deferred Chronicle retrieval and reservation

## Changed files

- `packages/application/src/memory/types.ts` and `generation-context.ts`: exact source reservations and the private captured correction frontier.
- `packages/database/src/chronicle-repository.ts`, `chronicle-generation-context.ts`, and `chronicle-context-repository.ts`: split authority capture from deferred retrieval, retain the legacy wrapper, pass reservations to SQL, and verify optional facts against captured authority.
- `packages/database/src/campaign-continuity-repository.ts`: bounded candidate-ID verifier that uses the captured correction frontier for pre-frontier rows and immutable accepted-turn sources for later rows; it never rereads the frontier or repairs data.
- `services/runtime/src/generation-executor-adapter.ts`: v5 captures authority, runs assessments and sanitized guidance, makes an exact writer/reviewer reservation before retrieval, then performs final planning with that authority and candidates.
- Focused unit and PostgreSQL regressions listed below.

## Behavioral proof

V5 captures authority once and retains its effective latest narration. The no-candidate planning pass runs after mechanics/sanitized guidance with the final writer and reviewer serializers. Its actual serialized recent/fact IDs form the reservation passed into deferred retrieval. Legacy protocols remain on `loadGenerationContext` with their existing wrapper ordering.

Exact selected turn/fact IDs are applied in SQL before rank/lane limits for standard memories, historical facts, and all chunk rank families. Exclusions are per ID, so eligible fact siblings remain available. Optional facts are not allowlisted by the protected 512-row source window: a bounded verifier checks pre-frontier facts against the captured complete correction state (including intentional empties), and later facts against immutable accepted-turn snapshots.

The new PostgreSQL regression creates 513 newer facts so an old valid fact and sibling fall outside the protected 512-row source window. It proves that window omits the old fact while deferred candidate verification still admits both source-verified IDs. Another PostgreSQL regression fills a lexical historical lane with reserved IDs and proves the older eligible fact replenishes the lane.

When the latest complete correction precedes the generation base, authority capture now materializes that correction snapshot itself, rather than the later accepted base continuity. This preserves its verified correction facts through later accepted turns while withholding stale pre-correction facts.

## RED / GREEN evidence

- RED: `. .\.superpowers\sdd\2026-09-26-turn-context-history-coverage\test-env.ps1; corepack pnpm vitest run tests/unit/chronicle-transaction-repository.test.ts`
  - Exit `1`; new capture port missing. `task-3-red.log`.
- GREEN: `. .\.superpowers\sdd\2026-09-26-turn-context-history-coverage\test-env.ps1; corepack pnpm vitest run tests/unit/campaign-continuity-repository.test.ts tests/unit/generation-context-contracts.test.ts tests/unit/generation-context-planner.test.ts tests/unit/chronicle-transaction-repository.test.ts tests/unit/memory-application.test.ts tests/unit/chronicle-runtime-adapter.test.ts tests/unit/generation-executor-adapter.test.ts`
  - Exit `0`; 7 files, 214 tests. `task-3-fix1-unit-final.log`.
- Type check: `. .\.superpowers\sdd\2026-09-26-turn-context-history-coverage\test-env.ps1; corepack pnpm exec tsc -p tsconfig.json --noEmit`
  - Exit `0`. `task-3-fix1-tsc-final.log`.
- Legacy golden: `. .\.superpowers\sdd\2026-09-26-turn-context-history-coverage\test-env.ps1; corepack pnpm vitest run tests/unit/generation-context-history-coverage-baseline.test.ts`
  - Exit `0`; 28 tests. `task-3-fix1-goldens-final.log`.
- Rereview diagnostic: the first focused-unit rerun exited `1` because the exact-correction unit stub exposed changed default ordering. Restoring the unchanged exact query order made the targeted at-or-before ordering opt-in. `task-3-fix2-unit.log` contains that terminal failure; the final rerun below is green.
- Rereview GREEN: `. .\.superpowers\sdd\2026-09-26-turn-context-history-coverage\test-env.ps1; corepack pnpm vitest run tests/unit/campaign-continuity-repository.test.ts tests/unit/generation-context-contracts.test.ts tests/unit/generation-context-planner.test.ts tests/unit/chronicle-transaction-repository.test.ts`
  - Exit `0`; 4 files, 101 tests. `task-3-fix2-unit-final.log`.
- Rereview type check: `. .\.superpowers\sdd\2026-09-26-turn-context-history-coverage\test-env.ps1; corepack pnpm exec tsc -p tsconfig.json --noEmit`
  - Exit `0`. Fresh terminal log: `task-3-fix2-tsc-final.log`.
- Rereview legacy golden: same environment with `tests/unit/generation-context-history-coverage-baseline.test.ts`.
  - Exit `0`; 28 tests. `task-3-fix2-goldens.log`.

## PostgreSQL evidence

- Disposable task PostgreSQL: `. .\.superpowers\sdd\2026-09-26-turn-context-history-coverage\test-env.ps1; corepack pnpm vitest run --config vitest.integration.task.config.ts tests/integration/history-protected-facts.integration.test.ts tests/integration/chronicle-historical-fact-pool.integration.test.ts tests/integration/chronicle-chunk-retrieval.integration.test.ts`
  - Elevated, exit `0`; 3 files, 41 passed and 1 skipped benchmark. `task-3-fix1-pg-final-candidates.log`.
- Lexical replenishment: same environment/config with `tests/integration/chronicle-historical-fact-pool.integration.test.ts`.
  - Exit `0`; 8 passed and 1 skipped benchmark. `task-3-fix1-pg-replenishment.log`.
- Earlier diagnostic PG attempts ended with exit `1`; their terminal logs are retained as `task-3-fix1-pg.log` and `task-3-fix1-pg-chunk-rerun.log`.
- Rereview correction-frontier regression: same environment/config with `tests/integration/history-protected-facts.integration.test.ts`.
  - Elevated, exit `0`; 9 passed. It creates a nonempty correction at turn 2, follows it with an accepted turn 3, then proves authority retains the correction fact and deferred verification excludes the stale turn-1 fact. `task-3-fix2-pg-frontier.log`.

## Residual guards and concerns

Optional verification is bounded at 2,048 selected candidate IDs. Correction-origin facts without captured-frontier proof are withheld. Existing chunk integration covers lexical, semantic-unavailable, and index-unready modes; this fix round does not duplicate a nonempty reservation assertion for each chunk mode.

## Commits

- `40a8f409 Defer v5 Chronicle candidate retrieval`
- `3ac5fb69 Filter v5 Chronicle sources before rank limits`
- `6ae7d882 Verify deferred Chronicle fact candidates`
- `6416b1a6 Document Task 3 verification`
- `4add6eaa Capture prior correction frontier`
