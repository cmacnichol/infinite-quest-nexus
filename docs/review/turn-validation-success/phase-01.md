# Phase 01 handoff: validation metrics and safe failure diagnostics

Base: `238d4ef2` (plan baseline `2ce55088`). Scope is Phase 01 only; the immutable final SHA is supplied with this handoff.

## Delivered interfaces

- `summarizeValidationOutcomes` derives first-pass metrics from the earliest `initial` attempt number for each job. Repairs remain separate; duplicate observations must agree.
- `scripts/report-turn-validation.ts` accepts `--limit 1..1000`, optional UTC `--since`, and `--format json|markdown`. It uses parameterized, bounded metadata queries inside `BEGIN READ ONLY`, then rolls back. A primary result is classifiable only when its attempt has a persisted completion timestamp, nonempty output, and recorded validation array. A missing response ID and a length finish do not make an otherwise completed output unknown. The report returns per-job disposition, initial outcome, safe final cause, configured/returned model, and grouped cohort metrics. When a job did not explicitly request a model, its earliest frozen initial-attempt request metadata supplies the configured model without consulting the mutable provider default; malformed labels and persisted error strings reduce to fixed safe labels.
- `orchestration_private.lastFailureDiagnostic` stores a strict, versioned, allowlisted last failure category. Normal validation rejections now persist their actual format, mechanics, or incomplete-output cause before pausing; fatal failures record the phase that failed. The database job query projects it once through fixed public timeout/transport/empty-output messages, and GET plus SSE transport that already-public projection unchanged. Raw provider errors, URLs, credentials, and response text are never selected or returned.

Cancellation and discard preserve the private diagnostic because their updates do not replace `orchestration_private`; the normal job projection exposes only the fixed safe result. Historical rows with no field decode as `null`.

## Evidence

- RED: `corepack pnpm exec vitest run tests/unit/generation-outcome-metrics.test.ts` failed because the metric module did not exist.
- GREEN: focused metrics, report, safe-diagnostic, phase diagnostics, review-contract, executor, and API/SSE units passed: 7 files, 135 tests. The API test injects a private timeout record through the repository seam and verifies GET and SSE each expose only the fixed public message. The report fixture covers earliest primary vs repair, response-ID absence, length finish, incomplete output, model/cause injection, dispositions, and cohorts.
- Type checks passed: repository TypeScript (`npx tsc --noEmit`).
- PostgreSQL: isolated `generation-execution-repository.integration.test.ts` and `generation-repository.integration.test.ts` passed 69/69 after migrations. The latter proves cancellation and discard retain the persisted safe failure record; the former proves failed execution persistence.
- CLI: `scripts/report-turn-validation.ts --limit 1 --format json` executed against the isolated database after a launch regression proved and fixed that `--limit` could otherwise be misread as `APP_ROLE`. Its output contained bounded metadata only.
- Provider/browser: not run; no provider calls or UI behavior are part of this phase.

## Limitations and next patch

The failure diagnostic is a last-known reporting signal, not an attempt ledger; `generation_attempts` remains the immutable historical source. The report intentionally reduces absent or malformed historical metadata to `unknown` and does not infer it. No claim of live success-rate improvement is made.

Phase 02 may rely on the report's frozen prompt/model/cohort labels and the preserved safe failure category. It must not change the metric denominator rules.
