# Persistent legacy Activity verification

Verified locally on 2026-10-03 in the isolated `codex/legacy-activity-plan` branch. No deployment or live-provider claim. The [runbook](../runbooks/activity-history.md) describes operations; the [architecture decision](../architecture/persistent-activity-history.md) records the transaction/publication/portability trade-offs. Later user instructions authorized implementation after the original planning handoff.

## Evidence and limits

| Check | Result | Scope and limitations |
| --- | --- | --- |
| Full unit matrix | Passed: 374 files, 4,821 cases; 44 skipped; zero failures | `corepack pnpm test:unit --exclude '**/.worktrees/**' --exclude '**/.codex/**'`. Platform/feature-dependent skips retained. Uses the task-local Windows pinned pnpm 12.4.1 shim for nested build commands; no global package manager change. |
| Original complete PostgreSQL matrix | 126 files: 1,525 passed, 199 skipped, 2 initial failures | Sequential one-process/file isolated databases on dedicated PostgreSQL 18 with pgvector. All files executed. Windows secure generated-archive/filesystem availability and declared feature gates account for skips; skipped cases are not passes. Both failures received separate full-file reruns below. This matrix predates the final numeric cursor correction. |
| Generation full-file rerun | Passed: 50/50; zero skips; 23.16 seconds | Related unmatched-failure fixture now intercepts the exact transaction-client failed UPDATE, preserves callback connect semantics, asserts one interception and no failed capture, terminal log or unsafe code. |
| Cast discovery unchanged full-file rerun | Passed: 57/57 | Initial checkpoint failure also passed its narrow rerun. Direct cast repository/lifecycle/test had no feature diff; intermittent root cause remains unconfirmed. No diagnosed cast fix is claimed. |
| Final affected PostgreSQL suites | Passed: 5 files, 39 cases; 23 skipped; zero failures | Activity workflow/repository/API/publication plus Campaign Archive. The 23 skips are the existing secure generated-archive staging cases unavailable on Windows. Uses equivalent standard integration configuration with only globalSetup disabled because the dedicated database is already provisioned; standard per-file isolation/migration remains intact. No shared development database reset. |
| Final composed workflow after maintenance-composition assertion | Passed: 6/6, zero skips; 7.40 seconds | Real API, runtime/application, deterministic TCP provider and PostgreSQL transactions; separate focused run after the five-file run above. |
| Full check and build | Passed | `corepack pnpm check` and `corepack pnpm build`, including TypeScript, repository/data/client boundaries and both web builds. Build emits the existing large-chunk advisory; it is not a failure. |
| Browser and native IndexedDB | Passed: 29/29 | Task 8 final production-module Chromium fixtures: 21 legacy Activity cases and 8 cache cases, 18.7 seconds. Earlier legacy/replacement generation-review smoke: 2/2. Typed API fixtures do not establish live SSE or provider behavior. No Task 9 UI change; evidence reused. |
| Live providers and deployed canaries | Skipped | Not required for operational semantics; no external provider, Swarm deployment, production restoration or sustained load was exercised. |

The initial full unit failures were corrected at their exact fixture boundaries: deliberate API groups now include `activity`; cancellation supplies precise guarded mutation/revision/outbox/coverage query responses and asserts owner/campaign scope with one COMMIT. The beforeAll build error was an environment pnpm mismatch corrected by a local executable shim. No expectations were silently skipped or broadened to make the matrix green.

## Composed acceptance coverage

`tests/integration/activity-workflow.integration.test.ts` drives the actual server routes and runtime worker against a deterministic local HTTP text provider. It enqueues/replays an idempotency key with no browser/subscriber attached, accepts through the normal generation transaction, then reads durable history. A publication INSERT trigger fails while accepted Story state remains completed; both repository rollback and runtime maintenance failure handling preserve pending snapshots. A new runtime maintenance composition publishes after the trigger is removed, and repeated publication creates no duplicates. This simulates publisher-component restart, not an operating-system/container kill.

The same workflow exercises truncated structured output, an explicit retry review decision, a deterministic provider 401 failure, retry and exactly one eventual accepted completion; replacement enqueue/cancel; capture failure at API enqueue with no job/coverage partial mutation and safe same-key retry; independent image failure after Story completion; ordered unique pages and incremental cursors; source-job cleanup; missing/foreign owner scope; campaign deletion and the existing owned-root deletion sequence before user deletion. The owned-world constraint correctly blocks direct user deletion until the graph is removed. No bootstrap or identity transfer behavior changed.

Privacy canaries in actions, partial responses, provider bodies and image errors are absent from public history. The actual Campaign Archive snapshot/payload projection excludes operational event UUIDs; the System Archive registry classifies all three tables as operational. Legacy-story reimport begins with empty operational history. Secure filesystem ZIP export/import round trips remain unavailable on Windows; the projection/registry checks are narrower evidence, not a replacement claim for skipped ZIP cases.

Task 1-8 focused/full-matrix coverage additionally exercises explicit final Keep/repair/discard and accepted-turn commit guards, alternate recovery paths, stale leases, cancellation of provisional images, generic/refiner/direct image paths and retry resets, publication contention/reverse source commits/quarantine/retention, legacy/replacement compatibility, browser reload/two tabs/cache identity gating/storage failures/stale scope and loaded-only diagnostics. The new composed workflow does not individually repeat every earlier fixture. Same-origin future-cursor reset is tested by a cursor beyond the actual high-water mark; browser reset application and retention gaps have separate coverage. A production backup restore was not performed.

## Numeric cursor correction and measurement

The composed history crossed sequence 9 to 10 and failed: PostgreSQL `ORDER BY sequence` selected the `sequence::text` output alias, sorting lexically and returning an incorrect next cursor. Commit `3d416f36` qualifies `story_activity_events.sequence`, preserving bigint numeric ordering for initial, before and after reads. Dedicated regressions cross digit widths both at ordinary values and beyond JavaScript's safe integer range, compare exact decimal strings and prove the final incremental cursor yields no duplicate. Focused activity repository/API/publication/workflow runs passed after the correction; the unchanged full 126-file matrix was not repeated.

Bounded local measurement: 20 sequential empty transactions took 21.71 ms; 20 safe capture transactions took 72.99 ms, approximately 2.56 ms additional per sample. This compares BEGIN/COMMIT with the outbox/coverage capture writes on a migrated local fixture database. It excludes the producer revision UPDATE, provider work, network deployment latency, concurrency, sustained backlog and capacity; do not use it as a production latency or throughput promise. Publication batch 100 and cleanup batch 1,000 remain design defaults.

The original portable private `activity_events` ledger is preserved. `story_activity_events`, `activity_event_outbox` and `campaign_activity_history` are separate operational tables. Fixed public diagnostics include Activity-specific history/cache/monitoring failures plus generic generation/image failure fallbacks; unknown raw codes become fixed catalog messages, and current typed provider cause is projected without reusing stale failure evidence. No arbitrary payload or private error bag is added.

## Rendered evidence

Task 8 viewed all six sanitized screenshots at their stated viewport sizes. Task 9 reuses them without a visual change:

| Scenario | Desktop 1440 x 844 | Mobile 390 x 844 |
| --- | --- | --- |
| Error details | [desktop](assets/legacy-activity/error-details-1440.png) | [mobile](assets/legacy-activity/error-details-390.png) |
| Independent image failure | [desktop](assets/legacy-activity/image-failure-1440.png) | [mobile](assets/legacy-activity/image-failure-390.png) |
| Cache reconnect | [desktop](assets/legacy-activity/cache-reconnect-1440.png) | [mobile](assets/legacy-activity/cache-reconnect-390.png) |

Local Markdown links and the complete scoped diff were checked; `git diff --check` passed. No secrets or private campaign records were included in these artifacts.
