# Campaign cast phase 06 acceptance

Accepted for the user-requested legacy Story surface. Phases 03–06 now provide editable supporting characters, durable forward discovery, bounded generation context and explicit accepted-history scans in the isolated `codex/campaign-cast` worktree. Replacement UI and relationship extraction remain deferred. All gates remain default-off; no production campaign was scanned or deployment changed.

## Requirement evidence

| Requirement | Implementation and verification |
| --- | --- |
| Explicit preview and Start | Strict owner-scoped `/cast/scans` contracts; positive inclusive contiguous ranges, current boundary and complete accepted history. Preview has no enrollment/job writes and exposes model/request estimates without execution credentials. Start freezes sources and execution; replay precedes provider preparation. Concurrent starts admit one active scan. |
| Durable scheduling and recovery | Migrations 0110–0111 persist scans, sources and job provenance. Existing source/protocol receipts and parsed checkpoints are reused. PostgreSQL tests cover restart, same-key replay, changed source, pause/resume, cancellation, forward priority within/across campaigns, active-generation deferral and disabled capabilities. |
| Pause and call accounting | Physical reservation and dispatch recheck scan state. In-flight responses can complete accounting/checkpointing. Composed worker tests verify repeated pre-dispatch pauses spend zero calls and no attempt allowance; resume dispatches once. Exhausted physical allowance remains failed. Expired leases cannot block newer forward jobs. |
| Explicit retry | Scan retry shares the discovery transaction, frozen admission and idempotent retry generations. It retains completed chunks and accounting, rejects stale/cancelled work and remains under scan controls even when recovering a reused forward failure. One-connection-pool tests verify no nested connection dependency. |
| Temporal authority and coverage | Older location evidence cannot overwrite newer facts or manual overrides. Source observations remain retained; scanning turns 2–3 reports coverage starting at 2. Pure range tests reject disjoint coverage. Failure/correction withdraws coverage through the existing discovery status path. |
| Identity, lifecycle and portability | Historical publication uses the same evidence/ambiguity validator as forward discovery. Existing discovery tests cover aliases, duplicate names, renamed/edited identities and explicit resolution. Lifecycle tests cover branch before introduction, source correction and rewind; portability tests cover remapped identity/evidence ownership. Pending scans cancel at lifecycle boundaries before reconciliation. Applied authority uses phase-02 archive paths; scan/source operational tables are explicitly excluded by the portability registry. |
| Legacy UI | Characters → Scan earlier story supports preview, Start, refresh, progress, pause/resume/cancel and failed-turn retry. Pending identity decisions are distinct from failures. Cancellation explains preservation of applied characters. Capability loss retains read/cancel. Stable request keys survive recovery failures. |
| Story integrity | Tests compare accepted narration/IDs/timestamps before and after historical publication. No story-generation job is created by a history scan. Composed provider fixtures exercise discovery separately from Action/Story Direction generation. |

## Verification

- Passed: 102 real PostgreSQL tests across backfill, discovery, lifecycle, portability and composed cast generation, using the isolated per-file database harness.
- Passed: complete unit suite, 4,436 tests across 352 files; 44 existing conditional/opt-in tests skipped.
- Passed: `corepack pnpm check`, TypeScript and `git diff --check`. Compose/Swarm configuration rendering passed at the runtime checkpoint; no deployment was performed.
- Passed: 14 legacy Playwright tests using API fixtures. Desktop 1280px and mobile 390px scan screenshots were visually inspected. Route identity, JavaScript errors and Vite overlay assertions passed. The fixture's known `/vendor/photoswipe/photoswipe.css` 404 is narrowly excluded from console errors; all other console errors remain checked.
- Review: independent backend review identified expired-lease and retry-provenance defects; both received RED/GREEN regressions and follow-up review. The additional pause/worker and exhausted-budget cases received dedicated reproductions and fixes.
- Not run: live-provider narrative/identity quality evaluation, production deployment/backfill, and replacement-UI browser tests (explicitly deferred scope).
- Harness limitation: the standard integration bootstrap previously failed authentication before tests. Successful runs use the existing isolated PostgreSQL harness and per-file database setup, as documented in phase 05. No credentials or existing database data were changed to force the standard command through.

Evidence logs are ignored local artifacts in `.tmp/campaign-cast/`: `phase6-acceptance-{pg,unit,check}.log`, `phase6-ui-final.log`, `phase6-review-{red,green}.log`, `phase6-pause-{red,green}.log`, `phase6-pause-worker-{red,green}.log`, `phase6-budget-red.log` and `phase6-history.log`.

Screenshots: [desktop preview](screenshots/phase-06/scan-preview-1280.png), [mobile preview](screenshots/phase-06/scan-preview-390.png), [desktop cancellation](screenshots/phase-06/scan-cancelled-1280.png), [mobile cancellation](screenshots/phase-06/scan-cancelled-390.png).

## Operations and limitations

Enable `CAST_EDITING_ENABLED`, `CAST_DISCOVERY_ENABLED` and optional `CAST_BACKFILL_ENABLED` consistently across API/worker roles after applying migrations through 0111. `CAST_CONTEXT_ENABLED` separately controls new generation-context capture. Enabling any flag does not automatically scan earlier history. Each historical range requires preview and explicit Start. See the [runbook](../../runbooks/campaign-cast.md).

Rollback disables the relevant gates while retaining additive migrations, identities, observations, edits, receipts and checkpoints. Read/cancel remain available. Migration down guards prevent removing retained operational scan state. Source processing uses existing bounded chunks; oversized turns require manual character review. Preview estimates exclude retries and do not promise a price. Progress refresh is explicit. Large scans perform source validation under campaign locks; no production-scale latency claim is made. Synthetic providers prove deterministic state handling, not real-model extraction quality.
