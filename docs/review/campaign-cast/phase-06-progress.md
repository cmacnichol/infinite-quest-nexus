# Campaign cast phase 06 progress

Phase 05 was accepted in `ba81924a`; its [acceptance record](phase-05-acceptance.md) includes the shared test-bootstrap limitation. Phase 06 is accepted at the legacy-only scope; see the [final acceptance record](phase-06-acceptance.md). The chronological entries below retain their original checkpoint status. Replacement UI and relationships remain deferred.

## Initial range and progress contracts

Added `campaign-cast-backfill.ts` to the shared contracts barrel. Start requests require a positive inclusive ordered range, expected timeline boundary and idempotency key. The claimed range cannot exceed the supplied boundary; the repository must still compare that boundary with owned authoritative state and verify every accepted source exists. Progress distinguishes complete/failed turns from pending identity decisions, retains partial counts on cancellation, and rejects impossible totals or a falsely complete scan.

RED/GREEN: the initial shape accepted reversed ranges and impossible progress; two regressions failed before cross-field validation. Both backfill and existing cast contract suites then passed eight tests. The contracts TypeScript check passed. Logs: `.tmp/campaign-cast/phase6-contract-{red,green,check}.log`.

No database migration, scheduler, provider dispatch, API route or rendered UI is added by this foundation. Next implement preview plus frozen source/execution admission; one active contiguous scan per campaign; forward-work priority and checkpoint reuse; pause/resume/cancel/retry; lifecycle fencing and accurate coverage; legacy scan controls and browser evidence. Current `failedTurns` means currently failed range entries, not lifetime failed physical attempts; those attempts remain accounted separately by discovery infrastructure.

## Pure range admission policy

Added `validateCastBackfillRange` in the application package. It compares the expected turn/timeline boundary with the supplied current boundary, requires exactly one accepted source per selected turn, and allows only initial or contiguous coverage. It also handles an enrolled forward boundary with no completed turns. The caller must obtain those values from owned authoritative rows under the transaction lock; the helper is not authorization and does not itself publish or extend coverage.

RED/GREEN: four tests failed against the initial no-validation implementation, then all nine backfill tests passed after implementing stale-boundary, history-gap and disjoint-range checks. TypeScript and diff checks passed. No runtime caller is connected yet.

Full unit verification: 4,433 passed and 44 skipped across 352 files (`.tmp/campaign-cast/phase6-range-unit.log`). The existing Node local-storage warning remains. PostgreSQL, rendered browser and live-provider checks were not run for this pure contract/application slice; these remain required where applicable for scheduler and UI integration.

## PostgreSQL preview and receipt reuse

Added an owner-scoped, transactionally consistent `createCastBackfillRepository().preview` using the pure range admission policy. Preview reads effective accepted narration, estimates chunks with the same phase-04 segmentation, and counts only receipts matching the current source hash, revision, timeline and protocol. Durable parsed checkpoints reduce estimated requests but do not count as completed turns or published evidence. Preview neither enrolls cast nor creates jobs. It exposes only provider profile ID and model/preset selection, not execution admission or provider configuration. Estimates exclude possible retries and do not promise price or total physical calls.

The strict shared preview schema rejects inconsistent range counts, out-of-range or duplicate manual-scan turns, and unknown fields. Three PostgreSQL tests failed against a no-op repository before implementation; the output count regression also failed before cross-field validation. After implementation, all 49 tests in the backfill/discovery PostgreSQL suites passed, including checkpoint reuse. Logs: `.tmp/campaign-cast/phase6-preview-{red,green,pg}.log`. TypeScript and diff checks passed.

This slice has no API/runtime caller yet. It does not freeze a durable scan at Start; that is the next implementation step. The scheduler must revalidate under the campaign lock, persist source identities and execution, enforce one active scan and idempotent Start, then integrate forward priority, pause/cancel and lifecycle fences before exposure. No migration or archive classification has changed yet.

Full unit verification after preview: 4,434 passed and 44 skipped across 352 files (`.tmp/campaign-cast/phase6-preview-unit.log`). No browser interaction or live provider was exercised; preview currently has no rendered surface and invokes no provider.

## Durable Start and persisted controls

Migration `0110_campaign_cast_backfill.sql` adds owner/campaign-scoped scans and frozen per-turn sources. A partial unique index permits one nonterminal scan per campaign; campaign locking serializes Start. Idempotency binds the user request, so a repeated key returns the original scan and frozen execution even if current provider selection changes. A conflicting payload under that key is rejected. Initial completed sources reuse matching phase-04 receipts; pending identity decisions are counted separately from scan failures.

The repository now implements Start, get, pause, resume and cancel. New Start and resume default to disabled; read, pause and cancel remain available. Cancellation preserves completed/failed counts and applied evidence. A cancelled scan cannot resume, but a new explicit Start may reuse its existing discovery receipts. Scan operational rows are excluded from portable archives. The down migration refuses to discard retained scans; disable admission for rollback.

TDD evidence: three Start tests failed before persistence; the partial-progress control test failed before transitions; the unresolved-decision test failed against the initial zero count. All nine new PostgreSQL tests then passed. The combined backfill, discovery and cast-portability run passed 62 tests (`.tmp/campaign-cast/phase6-start-pg.log`). TypeScript and diff checks passed.

This is still an internal repository slice, not a usable scan feature. No worker schedules these rows, no API exposes them, and no capability was enabled. Next connect per-turn scheduling to existing discovery checkpoints with forward priority; stop new dispatch on pause and fence cancellation/in-flight publication; revalidate frozen sources and lifecycle changes; update coverage without claiming gaps; then expose legacy UI controls and verify them in a browser. Controls currently cover persisted scan state only and must gain those worker/lifecycle effects before phase acceptance.

Full unit verification after durable Start: 4,434 passed and 44 skipped across 352 files (`.tmp/campaign-cast/phase6-start-unit.log`), including migration ordering and table-classification inventory. Only the isolated PostgreSQL test database received migration 0110. No deployment, production data, rendered UI or live-provider calls were involved.

## Scheduler, job priority and lifecycle fencing

Migration 0111 adds scoped scan provenance to discovery jobs. The repository scheduler validates every frozen source against current accepted narration, schedules one pending turn through the existing discovery queue, and reuses durable completion/checkpoints. Coverage starts at the selected range; the existing discovery status still identifies incomplete gaps. Active generation defers scheduling/coverage changes. Paused scans do not schedule or claim new work; existing in-flight work may checkpoint/publish. Cancellation revokes scan-owned leases and retains receipt-backed completion, including publication since the previous scheduling tick.

Discovery claims now prioritize forward jobs both within and across campaigns. An expired paused lease releases the unique running slot when other work is claimable. The lifecycle boundary cancels active scans before discovery reconciliation, including scans that have not enrolled cast yet; discarded pending scan work cannot be converted into forward jobs by reconciliation. Applied cast history still uses the existing lifecycle and portability path.

RED/GREEN captured ordered scheduling/source-change failures, forward-priority failure, two lifecycle cancellation failures, and the cancellation-progress/global-priority races. Final verification: 78 PostgreSQL tests across backfill, discovery, lifecycle and portability passed; 4,434 unit tests passed and 44 skipped; TypeScript and diff checks passed. Logs: `.tmp/campaign-cast/phase6-scheduler-final-pg.log` and `phase6-scheduler-unit.log`.

Still required before acceptance: runtime worker composition and a default-off backfill capability; API preview/start/progress/control/retry; failed-source retry that preserves physical accounting; rendered legacy controls; full coverage/correction/old-fact/manual-override and runtime-composition audit. The scheduler is currently invoked by integration tests, not the runtime worker. Audit fairness when an earlier campaign is deferred by active generation, and disabled-mode treatment of already queued scan jobs while wiring the worker. No new scan feature is exposed or enabled by this checkpoint.

## Runtime capability and worker composition

The runtime worker now invokes the scheduler before claiming discovery work. `CAST_BACKFILL_ENABLED` defaults to false and requires editing plus discovery; Compose and both Swarm roles receive the same explicit default. Queued scan jobs require this capability to claim, retry or publish. Checkpoints remain durable when disabled, and forward discovery can claim after an expired scan lease releases its running slot. The scheduler skips campaigns with active generation or already scheduled scan work so they cannot starve another ready campaign.

RED/GREEN: the configuration expectation failed before the flag existed; two composed runtime cases dispatched no provider work before scheduler wiring; the disabled-publication and cross-campaign generation-starvation regressions failed before fixes. Final PostgreSQL verification passed 82 tests across backfill, discovery, lifecycle and portability. Runtime scan success and timeout use the real prepared-text executor and physical accounting with synthetic provider responses, preserving accepted narration; this is not live-provider evidence. TypeScript, 36 configuration tests, Compose rendering and Swarm rendering passed. No service was deployed. Logs: `.tmp/campaign-cast/phase6-runtime-{red,green,pg}.log`.

API, scan retry, legacy UI and the complete phase-06 acceptance audit remain outstanding. No runtime Start endpoint is exposed yet.

Full unit verification after runtime wiring: 4,434 passed and 44 skipped across 352 files (`.tmp/campaign-cast/phase6-runtime-unit.log`). Diff checks passed. Browser and live-provider verification remain unperformed for this backend/runtime slice.

## Scan HTTP application

Added owner-scoped preview/Start/latest/get/pause/resume/cancel under `/cast/scans`. The latest response includes the independent backfill capability. The application validates request contracts before preparing the server-selected provider, verifies campaign ownership before metadata access, and performs provider preparation outside database transactions. Start revalidates accepted history and boundary after preparation. Idempotent replays read the original scan before provider preparation, so retries do not depend on current provider availability. Read/cancel are available with both editing and backfill disabled. Provider failures return a sanitized recovery code without leaking private details.

RED/GREEN: the route test returned 404 before registration; the complete request flow then passed against real PostgreSQL with a one-connection pool, including a preparation callback that needs that connection. Additional tests cover provider failure, history changing during preparation and disabled-mode controls. Final affected PostgreSQL run: 86 passed across backfill, discovery, lifecycle and portability. TypeScript passed after correcting an exact-optional-property error; diff checks passed. Logs: `.tmp/campaign-cast/phase6-api-{red,green,pg}.log`.

Still required: explicit failed-source retry API, shared client and rendered legacy scan controls, complete source/coverage/publication audit and phase acceptance. All feature flags remain unchanged/default-off; no live provider or deployment was used.

Full unit verification after API wiring: 4,434 passed and 44 skipped across 352 files (`.tmp/campaign-cast/phase6-api-unit.log`). Documentation link targets and diff checks passed. Rendered browser verification remains for the upcoming legacy UI slice.

## Explicit scan retry

Added POST `/cast/scans/:scanId/retry` with turn number, expected cast revision/boundary and idempotency key. The existing discovery retry implementation can participate in the caller's transaction, keeping scan progress and job retry generation atomic without a nested connection. Retry preserves completed chunks/checkpoints and prior accounting, validates frozen source identity, rejects cancelled scans, and keeps a paused scan paused. An admission-unavailable reused forward job receives the scan's already frozen execution snapshot. Progress now exposes an optional `firstFailedTurn`, with range/count consistency validation, for the upcoming retry UI.

RED/GREEN: the HTTP retry test failed before the route existed; admission recovery failed before supplying the frozen scan plan; the progress contract rejected the new failed-turn field before implementation. Final affected PostgreSQL verification passed 88 tests across backfill, discovery, lifecycle and portability. The retry flow runs on a one-connection pool, preserves the first completed chunk receipt, advances exactly one retry generation on repeated requests and rejects stale/cancelled requests. TypeScript and focused contract tests passed. Logs: `.tmp/campaign-cast/phase6-retry-{red,green,pg}.log`.

Remaining: shared client and legacy scan controls with browser evidence, then full phase-06 audit. During UI integration, keep failed scan recovery on the scan retry route so scan progress and discovery accounting remain atomic; audit interaction with the existing generic discovery Retry button. No feature flag was enabled and no live provider/deployment was used.

Full unit verification after retry: 4,435 passed and 44 skipped across 352 files (`.tmp/campaign-cast/phase6-retry-unit.log`). Diff checks passed. Browser verification remains outstanding until the legacy scan UI is implemented.

## Legacy scan controls

Added the shared scan client and legacy **Scan earlier story** panel with explicit range preview, model/request estimate, Start, progress, pause/resume/cancel and failed-turn retry. Start is unavailable before preview. Recovery preserves request keys; stale authority requires refresh. Read/cancel remain available after capability loss. Pending identity decisions are shown separately. Web-next remains deferred by user scope.

Verification: 14 legacy Playwright tests passed, including desktop/mobile scan controls and retry recovery; 4,436 unit tests passed and 44 skipped. Screenshots in `screenshots/phase-06/scan-*.png` were visually inspected at 1280px and 390px. Browser assertions verify route identity, no JavaScript errors and no Vite overlay. The fixture has a known optional PhotoSwipe stylesheet 404; only that exact resource/error is excluded from console assertions. Browser APIs are fixtures, not PostgreSQL or live-provider integration. Logs: `.tmp/campaign-cast/phase6-ui-{unit,final}.log`.

Backend review identified two outstanding regressions to reproduce and fix before acceptance: an expired active scan lease can retain the unique running slot when forward work wins priority; scan-authorized retry of a reused forward failure can bypass scan controls. Full historical publication/coverage acceptance remains outstanding.

## Final scheduler and dispatch corrections

Both review findings reproduced against PostgreSQL and were fixed: expired scan leases release the running slot before forward priority selection, and newly scan-authorized retries retain scan provenance/control. Follow-up review verified those paths. The physical reservation/dispatch boundary now checks scan status, while in-flight completion remains allowed. A composed executor/worker regression exposed pause being counted as provider failure; internal dispatch deferral now requeues unused claims without spending their allowance. Exhausted physical budgets still fail and require explicit retry. Regression evidence includes three successive zero-call pauses followed by exactly one successful dispatch.

Historical publication tests scan older location evidence after newer discovery, with and without a manual override. Both retain current authority, preserve observations at their original source turns, report coverage beginning at turn 2 rather than implying turn 1 was scanned, and leave accepted narration unchanged. Final PostgreSQL run passed 102 tests across five affected suites. Complete unit tests passed 4,436 with 44 pre-existing skips; repository checks passed. The final budget refinement is additionally covered by the final PostgreSQL run. Browser evidence remains 14 passing legacy tests with the known fixture stylesheet exclusion. Detailed requirement mapping and limitations are recorded in the acceptance document.
