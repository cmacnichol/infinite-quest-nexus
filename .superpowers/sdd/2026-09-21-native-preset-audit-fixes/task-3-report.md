# Task 3 durable campaign costs

RED evidence is retained in `task-3-completion-logs/red-cost-precedence.log`; it records the pre-fix reader failure. GREEN evidence is retained in `green-migration-backfill.log`, `green-cost-precedence.log`, and `green-final-verification.log` under the same task-owned directory.

The final private PostgreSQL command was:

`corepack pnpm exec vitest run --silent --config .superpowers/sdd/2026-09-18-native-openrouter-presets/vitest.integration.config.ts tests/integration/migrations.integration.test.ts tests/integration/provider-postgres-adapters.integration.test.ts tests/integration/image-pipeline.integration.test.ts tests/integration/campaign-archive.integration.test.ts tests/integration/system-archive.integration.test.ts`

It ran complete affected files, including migration backfill/idempotence, stable-event precedence/provider-type identity, completion-vs-campaign-lock concurrency, illustration physical attempt accounting and cleanup, and Campaign/System Archive stable cost precision. Result: **125 passed, 41 skipped**. Skips are existing conditional secure-generated-staging or environment-gated tests, not filtered failures; no `--testNamePattern` was used in the final command. The earlier focused concurrency command used `--testNamePattern "locks the campaign before"` and passed one test with twelve intentionally skipped siblings.

Selected non-Vitest checks passed: repository boundaries, repository data safety, root TypeScript `--noEmit`, and both legacy JavaScript syntax checks. `corepack pnpm check` could not run its wrapper because the local Corepack shim invoked pnpm 11.15.1 while this repository requires 12.4.1; this is a tooling mismatch, not a passing wrapper check.

The migration backfills only attempts with live owner-scoped Story or illustration parents. Orphaned historical attempts remain physical-attempt evidence because they have no safe campaign attribution. Previously rounded historical event amounts cannot recover missing precision without reconciliation, which remains deliberately out of scope. No live provider request, browser test, deployment, activation, push, or pull request was performed.
