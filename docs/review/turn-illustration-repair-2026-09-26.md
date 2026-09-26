# Turn illustration repair verification

Branch: `codex/turn-illustration-repair`.

## Changes

- Normalize nested PostgreSQL asset timestamps to the shared API schema.
- Promote active streaming sets even when image generation has already completed, and exclude unattached sets from accepted-turn responses.
- Preserve loaded images on legacy polling failures, bound transient retries, distinguish invalid API data, and provide read-only Refresh controls on both Story surfaces.
- Add an owner/campaign-scoped historical recovery command with dry-run default, accepted-source checks, active-child/conflict guards, idempotence and audit events. It reuses existing assets and completed jobs without provider calls.

Use the [recovery runbook](../runbooks/illustration-recovery.md) after deployment. No production deployment or historical data mutation was performed during this implementation.

## Verification

| Check | Result |
| --- | --- |
| Client regression suites | Passed: 112 tests across both Story clients |
| PostgreSQL illustration repository, routes and image pipeline | Passed: 40; skipped: 14 native secure-storage cases unavailable on Windows |
| Rendered browser recovery | Passed: 2 Playwright tests; invalid response, Refresh, visible stored PNG, zero write requests, no page errors |
| Repository/type checks | Passed: `pnpm check` |
| Build | Passed: `pnpm build`; existing Vite large-chunk warning |
| Full unit suite | 4,557 passed, 44 skipped, 1 failed |
| Independent static review | No remaining actionable P1/P2 findings |

The full-unit failure is `prepared-text-executor.test.ts` / `keeps the frozen review body and effective output limit with a 48000 route reserve`: ContextBudgetError, required 21,138 versus available 17,536. The same test fails on unchanged main, so it is outside this repair.

PostgreSQL checks used a disposable pgvector database because the shared integration database credentials were stale. The local test configuration retained per-file database setup and disabled only the shared-service startup hook. Regression evidence includes real PostgreSQL JSON timestamps, completion-before-promotion, actual completed image/prompt job preservation, repeat recovery, wrong owner, source mismatch, rejected parent, inactive/competing sets, and active child jobs.

RED/GREEN checks demonstrated the timestamp, accepted-response, promotion and client-error regressions before their fixes. Browser tests use synthetic narration and an in-memory PNG; they prove fetching/rendering and read-only refresh, not live-provider generation. No live-provider calls were made.

## Browser evidence

[Legacy Story screenshot](assets/illustration-repair/legacy-recovered.png)

[Replacement Story screenshot](assets/illustration-repair/web-next-recovered.png)
