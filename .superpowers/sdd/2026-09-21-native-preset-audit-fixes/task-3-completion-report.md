# Task 3 completion report

## Delivered

- Added migration `0101_durable_campaign_physical_attempt_costs`. It widens event amounts to exact PostgreSQL `numeric`, backfills only owner-scoped live Story and illustration parents, and is idempotent.
- The migration accepts decimal costs with PostgreSQL-safe standard strings, preserves more than twelve fractional digits, excludes orphaned attempts, and only treats a legacy illustration prompt-job event as the final completed claim when the claim identity, price, currency, provider, and available response identity agree.
- Stable `provider_cost_events` are now the accounting authority. Legacy physical-attempt rows supply only unmatched compatibility fallback; response identity is scoped to provider type.
- Prepared completion locks profile, campaign, then parent job, avoiding the rewind/completion lock cycle while revalidating campaign and profile attribution under lock.
- Illustration refinement completion records one cost event per physical attempt and retains those events after prompt-job and provider-profile cleanup.
- Campaign and System Archive coverage retain stable cost events without their parent job and preserve fractional amounts beyond twelve digits.

## Verification

The private task-owned PostgreSQL harness was used exclusively:

`corepack pnpm exec vitest run --silent --config .superpowers/sdd/2026-09-18-native-openrouter-presets/vitest.integration.config.ts tests/integration/migrations.integration.test.ts tests/integration/provider-postgres-adapters.integration.test.ts tests/integration/image-pipeline.integration.test.ts tests/integration/campaign-archive.integration.test.ts tests/integration/system-archive.integration.test.ts`

Result: **125 passed, 41 skipped**. Raw RED/GREEN output is under `task-3-completion-logs/`; no shared reset, secrets, live provider request, deployment, or activation was used.

`node scripts/check-repository-boundaries.mjs`, `node scripts/check-repository-data.mjs`, `node_modules/.bin/tsc.cmd -p tsconfig.json --noEmit`, and both legacy JavaScript syntax checks passed. `corepack pnpm check` remains blocked by the local Corepack shim invoking pnpm 11.15.1 although this repository requires 12.4.1; the underlying checks were run directly.

## Rollout and limitation

The deployment runbook records that 0101 is additive and should be applied before lifecycle cleanup. Existing historical events retain whatever precision was persisted before the widening; missing fractional digits cannot be reconstructed without reconciliation, which is intentionally out of scope.
