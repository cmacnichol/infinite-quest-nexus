# Cleanup execution ledger

Implemented the safe cleanup in branch `codex/dead-code-cleanup` at `C:\Users\chris\.codex\worktrees\dead-code-cleanup\InfiniteQuest`, based on `b982a0a5f2dbad8f0c18741fcf3522446929859f`.

[Implementation plan](../superpowers/plans/2026-09-30-dead-code-cleanup.md) · [Source audit](dead-code-audit-2026-09-30.md)

The initial implementation used a new worktree and Luna subagents, with changes left uncommitted for review. On 2026-10-03, the user invoked commit-push-pr to authorize committing, pushing, and opening a pull request. Deployment remains outside this request.

## Task and interaction review

| Task pair or boundary | Finding |
| --- | --- |
| Task 1 / Task 2 shared imports | Sequential implementation and independent task review avoided overlapping edits. |
| Private deletion / live behavior | Only audited private declarations deleted; neighboring live helpers retained. |
| Manifest / lockfile / browser | Versions unchanged; npm JSZip remains available to tests, separate vendored browser JSZip remains shipped. |

Task 1 is complete and independently approved by Luna: [implementation evidence](dead-code-cleanup-task1.md), [review](dead-code-cleanup-task1-review.md). Its 13-file source diff deleted 93 lines, including whitespace. The initial baseline replay attempt failed; it is not counted as baseline proof.

Task 2 is complete and independently approved by Luna: [implementation evidence](dead-code-cleanup-task2.md), [review](dead-code-cleanup-task2-review.md). The fresh [whole-change Luna review](dead-code-cleanup-final-review.md) approved the complete patch with no material findings.

## Verification

| Check | Result and scope |
| --- | --- |
| Task 1 focused units | Passed: 12 files, 214 tests. |
| Task 2 focused units | Passed: 14 files, 243 tests. |
| Compiler and repository checks | Task 1 and Task 2 `pnpm check` passed. |
| Frozen install | Passed with repository pnpm 12.4.1, offline frozen lockfile. |
| Full unit run | 365 files passed, 4,722 tests passed, 49 skipped; one build-contract suite failed because nested global pnpm 11.15.1 conflicted with required 12.4.1. |
| Failed-suite rerun | Passed: web-build-contract, one file and five tests, after PATH selected an ignored temporary shim invoking `C:\Program Files\nodejs\corepack.cmd pnpm`. Source was unchanged. Combined pass results across these runs: all 366 files and 4,727 tests. The initial 49 skips included the five build-contract tests subsequently rerun; they must not be added to the combined pass count. Original failure remains recorded. |
| PostgreSQL integration | Passed: six files, 144 tests; 14 skipped because secure generated asset staging requires Linux and the test process ran on Windows. |
| Production image | `docker build --tag infinitequest-cleanup:validation .` passed, including frozen installation, build, and production pruning. |
| Pruned-runtime archive smoke | Passed: imported compiled archive-io, archiver, unzipper; created and read a ZIP; npm jszip and @types/archiver absent; `/app/apps/web/dist/jszip.min.js` retained. |
| Browser / live providers / deployment | Skipped: no rendered interaction or generation behavior changed; no live-provider call or deployment requested. |
| Main checkout | Unchanged apart from its existing untracked audit. Audit SHA256 matches the worktree copy. |
| Diff and document checks | Passed: tracked diff whitespace, all new reports and plan whitespace, local Markdown links. |

The PostgreSQL command used a dedicated disposable `pgvector/pgvector:0.8.6-pg18-trixie` container, `infinitequest-cleanup-postgres`, on localhost port 55439. The container was removed after verification of its unique ID and cleanup label. An ignored temporary Vitest config retained `tests/integration/setup-isolated-database.ts`, with separate per-file databases, and bypassed shared Compose provisioning. It ran exactly authoring-job-repository, chronicle-chunk-repository, durable-filesystem-repository, import-repository, generation-response-contract, and image-pipeline integration files. This does not certify every suite mapped in the task reports.

Execution logs and the patch snapshot are retained under ignored `tmp/cleanup-validation/` for local inspection. The 49 unit skips are existing test-declared skips; they were not counted as passes. The 14 PostgreSQL skips use the platform predicate `supportsSecureGeneratedArchiveStaging` in `services/api/src/archive-io.ts`.

## Deferred scope

Uncertain exported declarations and config members, client/route retirement, historical protocol readers, test-oracle retirement, and the audit's consolidation groups remain deferred. Both active clients, provider separation, ownership, frozen protocols, prompts in use, migrations, and public interfaces were preserved.

## Publication verification — 2026-10-03

The tracked source patch still matches the independent whole-change review snapshot. Only publication authorization and verification notes were updated.

- Fresh `corepack pnpm check` passed with the ignored pinned-pnpm PATH shim. The first attempt without that shim failed when a nested command selected global pnpm 11.15.1 instead of required 12.4.1.
- Fresh full units at default parallelism produced three 5-second timeouts in story-only-runtime-cli-shutdown and task-14e3e8-composition-parity-boundaries: 364 files passed, 4,724 tests passed, three failed, 44 skipped. Separate rerun of those two suites passed all 11 tests without a timeout change.
- Fresh full `corepack pnpm test:unit --exclude '**/.worktrees/**' --exclude '**/.codex/**' --maxWorkers=2` passed all 366 files: 4,727 passed, 44 skipped, 105.93 seconds. This is the authoritative single-run unit result for publication.
- Staged diff whitespace and all 12 local Markdown links passed. Earlier build, frozen install, PostgreSQL and production-image evidence above was retained; those checks were not rerun for publication.

## CI failure correction — 2026-10-03

[CI run 37095730782](https://github.com/cmacnichol/infinite-quest-nexus/actions/runs/37095730782) passed type checking and units, then stopped at generation-events integration: the exact restored-migration list omitted already-shipped `0113_story_writer_prompt_limit`. The local isolated PostgreSQL reproduction produced the same one-failed/four-passed result. The stale expectation also exists on the cleanup's parent commit.

A follow-up run of migrations integration reproduced four additional stale list assertions: three omitted 0110–0113 and one omitted 0113. These were beyond the failed CI runner's stopping point. Luna review identified a third stale list in the adapter matrix cleanup hook; its missing 0110–0113 assertion was also reproduced. The fix updates only six literal expected migration lists across three test files; migration execution, rollback guards, notification behavior, prompt acknowledgement and authoritative-data assertions remain intact.

All three affected suites now pass against isolated PostgreSQL: three files, 34 tests passed, six Linux-only secure-filesystem tests skipped on Windows. Before the correction, the two original suites produced five reproduced test failures, and the adapter suite failed its cleanup-hook assertion. Final compiler/repository checks and diff whitespace passed. Luna re-review approved the test edits with no remaining stale applied-list expectations. No database migration or application behavior changed. The dedicated validation container is removed after verification. Logs remain in ignored `tmp/cleanup-validation/ci-*.log`.

[Replacement CI run 37096710531](https://github.com/cmacnichol/infinite-quest-nexus/actions/runs/37096710531) passed the previous migration failure point and exposed two response-contract failure assertions. Both failed because September 30 fixture verification expiry was compared with wall-clock October 3 in historical v1 preflight, despite an injected September 18 graph clock. The worker correctly failed closed before dispatch, leaving no provider failure evidence for those assertions. Local reproduction: two failed, 47 passed. A related operations suite reproduced four failures for the same expired fixture.

The two test fixtures now capture one current timestamp and derive verified-at/expiry one day before/after it, using the captured time for injected composition clocks. Production preflight and verification expiry validation are unchanged. Both affected PostgreSQL suites pass: 53 tests, no skips. Provider schema-verification and response-format units pass: 31 tests. Luna reviewed and approved both fixture diffs. Temporary database and test logs were isolated from shared application state.

[CI run 37097652708](https://github.com/cmacnichol/infinite-quest-nexus/actions/runs/37097652708) passed both earlier failure points, then exposed a stale continuity admission assumption. The shared historical v3/v4 fixture inherited the newer v5 default; its first v4 assertion failed and unconsumed jobs cascaded into later assertions. Local reproduction matched CI: 15 failed, 98 passed.

The shared fixture now explicitly sets `historyCoverageEnabled: false`, the existing v4 admission rollback option documented in ADR 0040. Dedicated v5 fixtures and frozen checkpoint replay assertions remain unchanged. The full affected PostgreSQL suite passes all 113 tests without skips. Compiler/repository checks and diff whitespace passed, and independent Luna review approved the correction. Application behavior and historical readers are unchanged.

[CI run 37099147487](https://github.com/cmacnichol/infinite-quest-nexus/actions/runs/37099147487) passed the continuity suite and stopped at choice-repair integration. The oversized-request fixture used a 9,000-token provider window, causing the current Story Writer prompt to fail during initial preparation before a choices review checkpoint existed. Local reproduction: one failed, 25 passed. The test now uses the normal 32,768-token window and a larger protected narration fixture, with explicit initial-dispatch assertions; only the repair request exceeds capacity. All 26 tests pass, compiler checks pass, and Luna approved the test-only correction. Protected repair transport and authoritative-write assertions remain intact.

A proactive run of the 37 integration files after choice-repair exposed 12 failures across three files: 11 archive watermark/binding assertions and one timing-sensitive staging lease assertion. Archive fixtures now independently read the current migration watermark for live exports/destinations and bind preview projections to it; historical source versions 0079 and 0095 remain intact. Focused archive verification: two files, 77 passed, five secure-filesystem cases skipped on Windows.

The staging lease fixture used a JavaScript-clock expiry two seconds ahead and a three-second renewed database lease, leaving a narrow timing margin. The untouched file passed on isolated rerun after failing in the broader run. Its expiry now comes from PostgreSQL five seconds ahead, with a 60-second renewed reader lease; write-once staging authority and both active-fence/expired-lease cleanup assertions remain unchanged. Focused verification: 10 passed. An attempted direct expiry update was rejected by the write-once guard and removed before final verification.

The final combined later-suite run passes: 29 files passed, eight skipped; 276 tests passed, 151 declared skips, including Linux-only secure-filesystem cases on Windows. Compiler/repository checks and diff whitespace passed. Independent Luna review approved archive, lease, and choice-repair fixture changes without findings. These local results do not replace the full Linux CI gates.
