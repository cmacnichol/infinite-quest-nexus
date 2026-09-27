# Task 3 report: deferred Chronicle exclusions

## Changed files

- `packages/application/src/memory/types.ts`, `ports.ts`, and `use-cases.ts`: add the private capture/deferred-candidate port and typed actual-ID reservation.
- `packages/database/src/chronicle-repository.ts` and `chronicle-generation-context.ts`: capture authority in its short transaction, then load candidates only from that captured context.
- `packages/database/src/chronicle-context-repository.ts`: remove reserved turn/fact parents before local rank/diversity selection and admit v5 canonical-fact parents only from a source-verified ID set.
- `services/runtime/src/generation-executor-adapter.ts`: for v5, capture authority, run assessments and sanitize guidance, measure the exact writer/reviewer reservation with no candidates, defer retrieval with actual selected IDs, then run final planning.
- Associated transaction/application/runtime test fixtures were extended for the split port.

## Behavioral proof

The v5 branch calls `captureGenerationAuthority` before mechanics work. After safe guidance and frozen writer/reviewer serializers are available, it plans with no optional candidates, carries selected `recentTurns.sourceId` and `protectedFacts.id` to `loadGenerationCandidates`, and finally plans from that same authority plus the filtered candidates. Legacy protocols retain `loadGenerationContext` and its existing wrapper ordering.

Optional Chronicle canonical-fact IDs are loaded through Task 6's bounded `loadVerifiedProtectedFacts` verifier before retrieval. Its accepted/correction-source materialization and latest complete correction frontier therefore determine the only optional fact IDs that can enter candidate selection; stale projections cannot enter prompts, manifests, or supersession IDs.

## RED / GREEN

- RED command: `. .\\.superpowers\\sdd\\2026-09-26-turn-context-history-coverage\\test-env.ps1; corepack pnpm vitest run tests/unit/chronicle-transaction-repository.test.ts`
  - Exit `1`; the new test observed that `captureGenerationAuthority` was absent. Full log: `task-3-red.log`.
- GREEN command: `. .\\.superpowers\\sdd\\2026-09-26-turn-context-history-coverage\\test-env.ps1; corepack pnpm vitest run tests/unit/chronicle-transaction-repository.test.ts tests/unit/generation-context-planner.test.ts tests/unit/generation-executor-adapter.test.ts tests/unit/memory-application.test.ts tests/unit/chronicle-runtime-adapter.test.ts`
  - Exit `0`; 5 files / 177 tests. Full log: `task-3-green.log`.
- Type check: `. .\\.superpowers\\sdd\\2026-09-26-turn-context-history-coverage\\test-env.ps1; corepack pnpm exec tsc -p tsconfig.json --noEmit`
  - Exit `0`. Full log: `task-3-typecheck.log`.

## PostgreSQL and old goldens

- PostgreSQL targeted command was attempted with the task container environment and both integration config variants. Vitest/esbuild failed before test discovery because the sandbox denied an ancestor directory while resolving `vitest.integration*.config.ts`; no PostgreSQL assertions ran. Full output is retained in `task-3-pg-green.log`.
- No old-protocol golden suite was run. The focused executor tests preserve existing legacy-path behavior, but this is not byte-golden evidence.

## Residual guards and concerns

- Exclusions are applied before local rank fusion, MMR, and the 2,000-parent in-process guard. The current repository's SQL candidate pools are already rank-limited before the in-memory filter; a follow-up should push the exact exclusion predicates into each SQL pool to satisfy the stronger upstream replenishment requirement under adversarial rank-family saturation.
- Task 6's verifier bounds optional canonical facts at its existing candidate/content limits. This run did not add PostgreSQL stale-projection, sibling, lexical-only, semantic-unavailable, or index-unready regression cases; they remain required before treating the integration as fully complete.

## Commit

- `26d7b681 Defer v5 Chronicle candidate retrieval`
