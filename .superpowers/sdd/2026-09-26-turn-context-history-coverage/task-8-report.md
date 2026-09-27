# Task 8 report: stable v5 context layer order

## Changes

- Added one v5 projection for selected context. Measurement calls it through the planner context, transport uses that same selected context when building the Story Memory body, and the source manifest is generated from the projected context and exact serialized request.
- Preserved the legacy prompt path and its insertion order by applying the projection only when the frozen history-coverage context protocol matches v5.
- Added provider-body tests for empty and populated layers, chronological order within history arrays, final current scene/current input placement, manifest hash and current-scene evidence pointer. Extended the PostgreSQL payload integration to inspect the serialized provider envelope.

## RED / GREEN and checks

- RED: `corepack pnpm vitest run tests/unit/generation-context-planner.test.ts`; exit 1. The actual provider JSON body exposed the prior key order: `currentScene` preceded world references, recent turns and the v5 history layers. Full output: `task-8-red.log`.
- GREEN: Task test environment plus `corepack pnpm vitest run tests/unit/generation-context-planner.test.ts tests/unit/generation-context-history-coverage-baseline.test.ts tests/unit/story-output.test.ts`; exit 0, 3 files / 97 tests. This includes all 28 legacy frozen goldens. Full output: `task-8-green-unit.log`.
- Type check: Task test environment plus `corepack pnpm exec tsc -p tsconfig.json --noEmit`; exit 0. Full output: `task-8-tsc.log`.
- PostgreSQL payload integration: Task test environment plus `corepack pnpm vitest run --config vitest.integration.task.config.ts tests/integration/story-context-payload.integration.test.ts -t "serializes v5 selected sibling world lore and input"`; exit 0, 1 passed / 28 skipped by test filter. The selected test read PostgreSQL authority, built the provider envelope, and checked actual user JSON order, current input, producing-request hash, and current-scene manifest pointer. Full terminal output: `task-8-pg-targeted.log`.
- Broader payload integration attempt: same command without `-t`; exit 1, 21 passed / 6 skipped / 2 failed. The failures are two existing Story Direction choice-repair assertions that expect the full narration contract on a choice-only repair request. They are outside the v5 layer projection. Full output: `task-8-pg.log`.
- `git diff --check`; exit 0. Full output: `task-8-diff-check.log`.

No live-provider or browser checks were run. No live quality claim is made.

## Commit and remaining notes

Commit: this report and implementation are committed together as `Order v5 story context layers`.

The v5 protocol remains gated by the existing `isHistoryCoverageContextProtocol` check. This task does not enable v5 for new jobs. No prompt protocol version or production default was changed.
