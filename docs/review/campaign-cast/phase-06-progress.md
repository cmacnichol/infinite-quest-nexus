# Campaign cast phase 06 progress

Phase 05 was accepted in `ba81924a`; its [acceptance record](phase-05-acceptance.md) includes the shared test-bootstrap limitation. Phase 06 is active and not accepted. The user scope remains legacy Story UI only; replacement UI work is deferred. Relationships remain out of scope.

## Initial range and progress contracts

Added `campaign-cast-backfill.ts` to the shared contracts barrel. Start requests require a positive inclusive ordered range, expected timeline boundary and idempotency key. The claimed range cannot exceed the supplied boundary; the repository must still compare that boundary with owned authoritative state and verify every accepted source exists. Progress distinguishes complete/failed turns from pending identity decisions, retains partial counts on cancellation, and rejects impossible totals or a falsely complete scan.

RED/GREEN: the initial shape accepted reversed ranges and impossible progress; two regressions failed before cross-field validation. Both backfill and existing cast contract suites then passed eight tests. The contracts TypeScript check passed. Logs: `.tmp/campaign-cast/phase6-contract-{red,green,check}.log`.

No database migration, scheduler, provider dispatch, API route or rendered UI is added by this foundation. Next implement preview plus frozen source/execution admission; one active contiguous scan per campaign; forward-work priority and checkpoint reuse; pause/resume/cancel/retry; lifecycle fencing and accurate coverage; legacy scan controls and browser evidence. Current `failedTurns` means currently failed range entries, not lifetime failed physical attempts; those attempts remain accounted separately by discovery infrastructure.

## Pure range admission policy

Added `validateCastBackfillRange` in the application package. It compares the expected turn/timeline boundary with the supplied current boundary, requires exactly one accepted source per selected turn, and allows only initial or contiguous coverage. It also handles an enrolled forward boundary with no completed turns. The caller must obtain those values from owned authoritative rows under the transaction lock; the helper is not authorization and does not itself publish or extend coverage.

RED/GREEN: four tests failed against the initial no-validation implementation, then all nine backfill tests passed after implementing stale-boundary, history-gap and disjoint-range checks. TypeScript and diff checks passed. No runtime caller is connected yet.

Full unit verification: 4,433 passed and 44 skipped across 352 files (`.tmp/campaign-cast/phase6-range-unit.log`). The existing Node local-storage warning remains. PostgreSQL, rendered browser and live-provider checks were not run for this pure contract/application slice; these remain required where applicable for scheduler and UI integration.
