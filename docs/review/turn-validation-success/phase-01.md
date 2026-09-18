# Phase 01 handoff: validation metrics and safe failure diagnostics

Base: `238d4ef2` (plan baseline `2ce55088`). Scope is Phase 01 only; the immutable final SHA is supplied with this handoff.

## Delivered interfaces

- `summarizeValidationOutcomes` derives first-pass metrics from the earliest `initial` attempt number for each job. Repairs remain separate; duplicate observations must agree.
- `scripts/report-turn-validation.ts` accepts `--limit 1..1000`, optional UTC `--since`, and `--format json|markdown`. It uses parameterized, bounded metadata queries inside `BEGIN READ ONLY`, then rolls back. The report separates configured and returned model labels, job disposition, first validation, repairs, and unknown cohorts.
- `orchestration_private.lastFailureDiagnostic` stores a strict, versioned, allowlisted last failure category. The job query projects it through fixed public timeout/transport/empty-output messages. Raw provider errors, URLs, credentials, and response text are never selected or returned.

Cancellation and discard preserve the private diagnostic because their updates do not replace `orchestration_private`; the normal job projection exposes only the fixed safe result. Historical rows with no field decode as `null`.

## Evidence

- RED: `corepack pnpm exec vitest run tests/unit/generation-outcome-metrics.test.ts` failed because the metric module did not exist.
- GREEN: focused metrics, report, safe-diagnostic, phase diagnostics, and review-contract units passed: 5 files, 39 tests.
- Type checks passed: contracts, application, and repository TypeScript (`npx tsc --noEmit`).
- PostgreSQL: isolated `generation-execution-repository.integration.test.ts` passed 35/35 after migrations. The new assertion records the timeout classification in private orchestration state without changing accepted state.
- Provider/browser: not run; no provider calls or UI behavior are part of this phase.

## Limitations and next patch

The failure diagnostic is a last-known reporting signal, not an attempt ledger; `generation_attempts` remains the immutable historical source. The report intentionally does not infer a configured model or prompt identity when historical metadata lacks it. No claim of live success-rate improvement is made.

Phase 02 may rely on the report's frozen prompt/model/cohort labels and the preserved safe failure category. It must not change the metric denominator rules.
