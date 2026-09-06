# Campaign Startup Fix Implementation Plan

**Goal:** Load a new campaign before generating its authored opening action and preserve its event rules and full prompt history.

**Architecture:** Normalize legacy string event rules at campaign creation and shared runtime read boundaries. Treat a failed Story Player load as a failed prerequisite, and show full action text in history independently of its short heading.

**Tech stack:** TypeScript, PostgreSQL, legacy browser JavaScript, Vitest/linkedom.

**Scope:** The first-turn diagnosis in this task: string event rules cause an initial sync 503; startup continues with the fallback action; generation filters the rules away; history truncates action text.

## Constraints

- Work only in the isolated `codex/campaign-startup-fix` worktree.
- No live campaign edits, accepted-turn rewrites, provider calls, schema migration, deployment, or main-checkout integration.
- Preserve structured trigger identifiers and counters. For a plain-text conditional rule, retain the whole text as both condition and effect, assessed before narration; do not attempt to infer or split its condition.
- Unsupported values must not create a partially initialized campaign. Existing unrelated invalid worker inputs retain their existing behavior.

## 1. Reproduce and implement trigger compatibility

- [x] Add `tests/unit/campaign-event-triggers.test.ts` for full-text preservation, stable IDs, collisions with structured IDs, unchanged structured metadata, empty arrays, and unsupported entries.
- [x] Add PostgreSQL coverage to `tests/integration/world-campaign-repository.integration.test.ts`: create a world with mixed string/structured triggers, create a campaign, then read sync/current/initial state and worker inputs. Assert the world version is unchanged, no turns exist, and another owner cannot load the campaign.
- [x] Run those tests RED before implementing.
- [x] Create `packages/domain/src/campaign-event-triggers.ts` with `normalizeCampaignEventTriggers(value: readonly unknown[]): unknown[]` that converts strings without dropping unsupported entries. Derive collision-free IDs from positions while reserving structured IDs.
- [x] Validate normalized triggers before insertion in `packages/database/src/world-repository.ts`; store the same validated rules in current and initial state.
- [x] Use the helper in `packages/database/src/campaign-state-repository.ts` for runtime-state and sync projections and in `packages/database/src/generation-execution-repository.ts` before the existing per-trigger validation.
- [x] Run unit and PostgreSQL tests GREEN.

## 2. Gate startup and show full history prompts

- [x] Extend `tests/unit/story-player-ui.test.ts` with a rejected sync, rejected state read, successful opening action, and full multiline escaped prompt assertions.
- [x] Run the tests RED. A rejected load must not call the generation workflow; a successful empty load must submit the authored action exactly once.
- [x] In `apps/web/src/story.js`, return a success flag from `loadCampaign`, stop `init` and manual submission when campaign data is unavailable, and retain existing failure diagnostics. Failed initial load keeps input unavailable until a successful reload.
- [x] Keep short history headings; render an independent full prompt block with preserved line breaks and escaped text. Add only the necessary style to `apps/web/public/story.css`.
- [x] Run Story Player tests GREEN, including existing completed-generation and history navigation coverage.

## 3. Verification and handoff

- [x] Run focused unit suites, isolated PostgreSQL suites, type checks, build, and `git diff --check`.
- [x] Verify the rendered history and failed-startup UI using synthetic data without creating live campaigns or calling a provider; save screenshots.
- [x] Request an independent code review of the uncommitted patch and address actionable findings.
- [x] Report actual verification, remaining limitations, and the isolated worktree path. Do not merge or deploy.

## Completed verification

- Baseline: `35fd626dded57176b12a3b11bb8b7ccc25b94c08`; branch: `codex/campaign-startup-fix`; worktree: `C:/Git/InfiniteQuest/.worktrees/campaign-startup-fix`.
- RED: trigger conversion and Story Player assertions failed before implementation. Real PostgreSQL reproductions showed initial sync rejection, invalid campaign creation succeeding, and worker input dropping string rules.
- GREEN: all 216 unit test files passed: 2,616 tests passed, 44 skipped. The 100 focused unit tests also passed independently.
- PostgreSQL: all 22 tests in the world-campaign and generation-execution repository suites passed against disposable databases on the test server. Tests cover new and existing zero-turn campaigns, current/initial state, immutable world data, worker inputs, ownership, and rejection before campaign insertion.
- Broader PostgreSQL verification: 51 passed, one failed when including campaign-authority coverage. The unrelated test `retains snapshot-only canonical facts across current and historical reads and later corrections` also failed with the unchanged baseline campaign-state repository; this patch does not address it.
- `pnpm check`, `pnpm build`, and `git diff --check` passed. Build retained existing font/chunk warnings.
- Rendered browser verification used the actual Story Player with synthetic API/workflow data, without provider calls. Successful startup submitted the exact multiline authored action once; history displayed it fully with escaped angle brackets and preserved line breaks. Failed sync submitted zero actions and disabled generation controls. The successful browser console had no errors or warnings.
- Synthetic screenshot evidence: [complete prompt history](../../review/assets/campaign-startup-fix/turn-history-desktop.jpg) and [failed startup](../../review/assets/campaign-startup-fix/failed-startup.jpg).
- Independent review found no actionable findings; the reviewer independently reran 87 trigger/Story Player tests and the whitespace check.

## Publication verification

- Rebased the unpublished fix onto `origin/main` at `ffd2e0d3c7e8bf05549d167082b84fb08a08b168` without conflicts. The upstream Story Player fixture correction is retained; the PR does not duplicate it.
- Re-ran all unit tests: 2,616 passed, 44 skipped, across 216 files.
- Re-ran the two targeted PostgreSQL suites: 23 passed, including the new upstream campaign-creation test.
- Re-ran the broader three-suite PostgreSQL selection: 52 passed, one failed with the same baseline snapshot-only canonical-facts assertion documented above.
- Re-ran `pnpm check`, `pnpm build`, and the complete PR whitespace check successfully. The rebase did not alter the Story Player runtime or CSS checked in the synthetic browser screenshots.

## Delivery boundaries

The fix is prepared in the isolated worktree for pull-request review; publication does not merge or deploy it. No live campaigns were changed, no migration is required, and accepted turns are not rewritten. Existing accepted fallback prompts and rules already lost by prior generation are not retroactively repaired; the fix preserves rules still present at read boundaries and prevents this startup failure for future turns.
