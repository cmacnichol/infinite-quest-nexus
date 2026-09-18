# Patch 1 report: review retry recovery

## Scope

- Added the typed `review_decision_required` application conflict for ordinary retries against a pending generation review.
- Mapped it to HTTP 409 with `details.code = generation_review_required` and actionable review-panel guidance.
- Reconciled a recoverable stream observation without review metadata through one authoritative campaign status read. A matching pending review blocks generic retry; a matching review-free recovery retains the legacy retry path. Read failures, mismatched jobs, and changed state fail closed.
- A typed 409 race refreshes review authority and does not retry again.

## RED/GREEN evidence

- RED: `corepack pnpm exec vitest run tests/unit/generation-application-adapter.test.ts` failed because the pending-review conflict mapped to generic 409 text with no details code.
- GREEN: the same test passed, 63 tests.
- RED: `corepack pnpm exec vitest run tests/unit/client-core/generation-workflow.test.ts` failed because a recoverable observation without review did not perform an authoritative status read (expected 1, received 0).
- GREEN: focused workflow and adapter tests passed, 101 tests.

## Verification

- Passed: focused units: 5 files, 197 tests (before final race additions); final workflow plus adapter run: 101 tests.
- Passed: isolated PostgreSQL `generation-review.integration.test.ts`: 7 tests. The pending-review ordinary retry preserves status, review revision/journal, attempts, and `generation_attempts` count; discarded retry keeps its existing state error.
- Browser attempted with `PLAYWRIGHT_LEGACY_PORT=43273` and `PLAYWRIGHT_WEB_NEXT_PORT=43274`. All 25 browser cases were blocked before execution by `browserType.launch: spawn EPERM`; no UI behavior or screenshots were validated. The configured web servers started on the unique ports.
- `corepack pnpm check` was run before the final exhaustive test fixture mapping was added and correctly found the missing mapping fixture. It must be rerun after this patch before integration.

## Limits

- No live provider calls, production data changes, deployment, schema migration, or parser/prompt changes were made.
