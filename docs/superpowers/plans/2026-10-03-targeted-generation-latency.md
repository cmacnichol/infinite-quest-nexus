# Targeted Generation Latency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Reduce generation-status read cost and eliminate diagnostic retrieval comparisons from the ordinary turn-generation path without changing accepted story behavior.

**Architecture:** Materialize one expanded private JSON value per selected, authorized generation job before applying the existing bounded public SQL projections. Use the existing internal `generationCandidates` distinction to run only production retrieval during generation, while preserving configured shadow comparisons for explicit Chronicle context previews. No new service, queue, public setting, schema migration, or provider configuration is required.

**Tech Stack:** TypeScript, PostgreSQL JSONB/CTEs, existing Vitest unit and isolated PostgreSQL integration infrastructure.

**Spec:** The user's request in this chat and the decisions and acceptance criteria below. This document is the complete implementation specification; no separate spec file is required.

## Workspace and scope

- Prepared on 2026-10-03 from `main` commit `94853d2d859f57b8a75bb69edd532c016570dffa`.
- Native managed worktree: `C:/Users/chris/.codex/worktrees/generation-latency-plan/InfiniteQuest`.
- The native worktree starts detached. At implementation start, create `codex/generation-latency` in this worktree after checking the name is available. Never reset or modify the primary checkout.
- This turn prepares the plan only. No implementation, provider calls, live settings changes, commits, or deployment are authorized by this planning request.
- The two changes are status/sync query optimization and skipping shadow comparisons during generation. Provider routing/caching, output verbosity, streaming persistence, and automatic choice repair are outside scope.

## Evidence and expected impact

The September 30 read-only review found a job with approximately 10.8 MB of private orchestration evidence. The existing public projection query took 2,551 ms; an equivalent query that materialized `orchestration_private || '{}'::jsonb` once took 39 ms. Public projection hashes matched. The latter used about 10 MB of temporary disk storage, so this technique requires memory/concurrency verification before adoption. These are historical measurements, not promised production response times.

Retrieval shadow comparisons were enabled on all three sampled campaigns. Candidate retrieval took 0.12-6.69 seconds, nested inside prompt preparation. Shadow overhead was not separately measured. Skipping the comparisons reduces pre-provider work; it does not remove production semantic retrieval. Faster status reads improve monitoring and reduce database contention; they do not shorten model inference directly.

## Global constraints

- Keep complete private request, candidate, decision, and recovery evidence unchanged in storage.
- Preserve public response schemas, field values, malformed-value handling, compatibility markers, pagination/sync tokens, SQL query counts, and SSE/poll schedules.
- Apply owner/campaign/status/order/limit filters before expanding private JSON; never expand every historical job to select one result.
- Keep production retrieval implementation, readiness gate, complete legacy fallback, ranking, exclusions, provenance, source validation, and all owner/campaign/world-version/cutoff boundaries unchanged.
- Do not change saved `retrieval_shadow_enabled`, new-campaign defaults, imports, embedding configuration, or existing jobs' frozen prompt/provider policies.
- Keep explicit previews able to run configured comparisons and safe telemetry. Do not introduce background work or fire-and-forget tasks.
- Use existing test files and fixtures. Add at most three focused cases (one per existing integration file), preferably extend existing cases. Do not add timing-sensitive unit tests or new test suites.
- Update older SQL/fixture expectations only where the implementation changes them. Never weaken isolation, public redaction, or existing query-count assertions to obtain a pass.
- No new dependency, migration, stored public projection, deployment manifest, UI layout, prompt protocol, or provider change.

## Review focus

1. A large recovery checkpoint must retain identical public review/response-format fields and never expose private canaries. Covered by Task 1's large-evidence fixture and existing projection tests.
2. Wrong-owner requests and foreign-campaign rows must be rejected before JSON expansion. Covered by existing owner isolation tests and Task 1's extended repository fixture.
3. Campaign sync must pick the same latest pending/recovery job, including ties and completed jobs, while expanding at most one row per lane. Covered by existing play-loop checks and Task 1's paired sync assertions.
4. Generation with shadow configured must retain production candidates and fallback semantics but perform no comparison-only work. Covered by Task 2's generation/preview comparison fixture.
5. A diagnostic preview must still compare implementations, retain safe telemetry, and isolate shadow failures. Covered by the existing observability case extended in Task 2.

## Task 1: Expand selected job evidence once for status and sync reads

**Production files:**
- Modify `packages/database/src/generation-repository.ts`, `getJob`.
- Modify `packages/database/src/campaign-state-repository.ts`, `createPostgresCampaignSyncRepository().readCampaignSyncSnapshot`, pending/recovery lateral reads.
- Keep `generation-review-summary-projection.ts` and `generation-response-format-projection.ts` behavior unchanged.

**Existing test files to review/update:**
- `tests/integration/generation-response-contract-projection.integration.test.ts`.
- `tests/integration/play-loop-read-performance.integration.test.ts`.
- Run existing `tests/integration/generation-review.integration.test.ts` and `tests/integration/generation-events.integration.test.ts`.
- Review/run `tests/unit/generation-review-summary-projection.test.ts`, `tests/unit/generation-response-format-sql-projection.test.ts`, `tests/unit/generation-response-format-projection.test.ts`, and `tests/unit/play-loop-read-repository.test.ts`; update only SQL-shape expectations affected by these reads.

**Interfaces:** Preserve the current `getJob(scope)` and `readCampaignSyncSnapshot(transaction, scope)` signatures and result shapes. Continue using existing projection functions with the expanded SQL alias instead of the original toasted column.

- [x] Record the baseline of the focused suites using the commands below before executable changes. Resolve missing dependencies with `corepack pnpm install --frozen-lockfile` inside this worktree. Do not use the main checkout's test discovery as a substitute.
- [x] Extend one existing PostgreSQL projection fixture with synthetic, non-user evidence large enough to exercise TOAST (target about 10 MiB). Preserve representative pending/decided review fields and response-format metadata; include a private canary in the oversized evidence. Assert identical projections for absent/legacy, v1/v2, malformed, and future-version inputs using the existing table of cases rather than separate new tests for each.
- [x] Exercise actual repository reads, not only `SELECT` over an inline parameter. Use the existing generation-review fixture helpers if convenient. Assert public result equality, no private canary, and unchanged stored private evidence after reads. Confirm wrong-owner rejection remains covered.
- [x] Extend the existing play-loop fixture to include a large pending/recovery job; assert the selected job, review metadata, sync tokens, payload projection, bounded result, and query budgets remain unchanged. Update SQL capture matching if its current detector relies on a leading `SELECT` rather than `WITH`; retain all existing budgets.
- [x] Implement an owner-filtered materialized CTE in `getJob`. Its private expression is `orchestration_private || '{}'::jsonb`; reuse that single expanded datum for failure diagnostic, continuity diagnostic, review summary, and response-format projections. Explicitly select public columns; do not return the expanded private value to Node or the browser.
- [x] In each sync lateral lane, first select the same owner/campaign/status-filtered latest row with the existing ordering and `LIMIT 1`, then materialize that row's expanded JSON and apply the existing projections. Use separate selection and expansion stages so expansion cannot be performed across the campaign's history. Keep the outer sync query and one-statement behavior.
- [x] Keep the SQL expressions local to the two repositories; no new shared helper is needed for this small change. Do not duplicate or rewrite the public projection rules.
- [x] Run related unit/integration suites. Old projections must remain the semantic reference. A pure performance change may leave old behavioral tests green; do not manufacture a failure or assert an arbitrary wall-clock threshold in CI.
- [x] Measure baseline and changed actual polling and sync statements against the same synthetic fixture on the same PostgreSQL instance: 5 warmups and 30 samples, alternating variants. Compare complete public JSON, query count, `EXPLAIN (ANALYZE, BUFFERS)` execution time, buffer activity, and temporary writes. Also measure small/legacy rows to guard against regression.
- [ ] Repeat large-job reads at concurrency 1 and 4, with a small bounded pool matching the documented minimum. Record p50/p95, temporary storage, worker/API memory, and errors. Do not change global `work_mem`. Accept only if large-row p95 improves by at least 50%, small-row p95 has no reproducible regression greater than 10%, outputs match, and there are no failures or sustained memory growth. If the materialized approach fails these criteria, keep this task incomplete and investigate a smaller one-time bounded projection; do not add a schema migration as an unreviewed fallback.

## Task 2: Skip shadow comparisons only for generation candidates

**Production file:**
- Modify `packages/database/src/chronicle-context-repository.ts`, `loadChronicleRetrievalStage`.

**Existing tests:**
- Extend `tests/integration/chronicle-retrieval-observability.integration.test.ts`, the existing case named `runs lexical, legacy, and chunked comparisons while preserving the configured production selection`.
- Review/run `tests/unit/chronicle-transaction-repository.test.ts` and `tests/unit/chronicle-generation-budget.test.ts`.
- Run existing `tests/integration/chronicle-chunk-retrieval.integration.test.ts`, `tests/integration/generation-budget-growth.integration.test.ts`, and `tests/integration/story-continuity-remediation.integration.test.ts` for readiness/fallback, generation integrity, and isolation coverage. No new fixture suites.

**Interfaces:** Keep the existing internal options shape `Readonly<{ useSavepoints?: boolean; generationCandidates?: boolean }>` and all public/application interfaces unchanged. The private candidate loader already passes `generationCandidates: true`; explicit `buildContextPreview` does not.

- [x] Extend the observability fixture to call the private generation-candidate loader under the same owner/campaign/world/cutoff and configured production implementation, first with shadow disabled and then enabled. Compare complete production candidates and `chronicleRetrieval` audit, not compressed public-preview output. Reset/cache-control deterministic embedding counters between the paired calls.
- [x] Assert enabling shadow does not cause comparison-only resolution/embedding calls, shadow savepoints, or diagnostic comparison rows on the generation path. Retain the existing explicit-preview assertions proving three implementations still run and a failing shadow path does not replace production context.
- [x] Run the extended test before the change: the assertion about skipped generation shadow work should fail, proving it exercises the current behavior.
- [x] In `loadChronicleRetrievalStage`, calculate one internal boolean equivalent to `Boolean(config?.retrieval_shadow_enabled && !options.generationCandidates)` and use it for the comparison-execution branch currently guarded by `config?.retrieval_shadow_enabled`. Leave production execution and audit construction untouched.
- [x] Keep preview comparison recording in `buildPostgresChronicleContextPreview` unchanged. Do not mutate `stage.config` to hide the persisted setting. Generation's existing production-only audit must remain available.
- [x] Confirm both `loadGenerationContext` and `loadGenerationCandidates` reach the private candidate seam with `generationCandidates: true`. The caller-owned transaction path already returns authority without provider retrieval; preserve that behavior.
- [x] Run the extended integration and existing budget/isolation suites. Do not assert fewer total provider calls where caching or production embeddings legitimately vary; assert the absence of identified comparison-only work.
- [x] Measure generation candidate preparation with the setting off/on using the deterministic fixture, and separately measure the explicitly requested preview. Both generation variants must select identical candidates and perform only production work; previews must retain comparisons. Report measured savings without attributing the entire historical retrieval phase to shadow work.

## Task 3: Update operational explanation and perform final verification

**Documentation files:**
- Modify `docs/concepts/chronicle-memory.md` and `docs/nexus-guide/chronicle/embeddings.md`.
- Add a short dated clarification in `docs/architecture/0028-chunked-chronicle-retrieval.md` documenting that saved defaults are unchanged, previews honor shadow configuration, and ordinary generation now runs only production retrieval. This refines execution placement rather than changes index authority or readiness policy.

- [x] Clarify that Shadow comparison controls explicit Chronicle context-preview diagnostics; it no longer adds comparison work to ordinary turn generation. Keep indexing implications, default configuration, production implementation, and fallback instructions accurate. Do not redesign settings or change UI labels in this patch.
- [x] Review tests for every changed file. Update older expectations only for actual SQL shape or execution-placement changes. No new test files are expected; maximum three focused additions across existing integration files.
- [x] Complete the focused commands below, then `corepack pnpm check`, `corepack pnpm build`, and `git diff --check`. Review the complete diff for unrelated changes.
- [x] Before publication, complete full unit/integration verification. Full units and applicable PostgreSQL cases passed; existing platform/opt-in skips are recorded below.
- [x] Run the existing rendered `tests/e2e/generation-review.e2e.test.ts` during implementation verification if its configured browser infrastructure is available. Verify status, review controls, and completion behavior; record existing captures or screenshots. There is no intended visible UI change. Report unavailable browser evidence as skipped, separately from PostgreSQL and unit evidence.
- [x] Capture a scoped performance report with synthetic data only: baseline/changed outputs and timings, concurrency/memory evidence, generation versus preview comparison call counts, and passed/failed/skipped checks. Do not save private campaign narration, prompts, or credentials in tracked artifacts.
- [x] Review the two changes independently. Suggested eventual commits: `Optimize generation status evidence reads` and `Skip shadow retrieval during turn generation`. The original planning request did not authorize committing, pushing, or deployment; the subsequent publication authorization is recorded below.

## Verification commands (run from this worktree during implementation)

```powershell
corepack pnpm exec vitest run --exclude '**/.worktrees/**' --exclude '**/.codex/**' tests/unit/generation-review-summary-projection.test.ts tests/unit/generation-response-format-sql-projection.test.ts tests/unit/generation-response-format-projection.test.ts tests/unit/play-loop-read-repository.test.ts tests/unit/chronicle-transaction-repository.test.ts tests/unit/chronicle-generation-budget.test.ts
corepack pnpm exec vitest run --config vitest.integration.config.ts tests/integration/generation-response-contract-projection.integration.test.ts tests/integration/play-loop-read-performance.integration.test.ts tests/integration/generation-review.integration.test.ts tests/integration/generation-events.integration.test.ts tests/integration/chronicle-retrieval-observability.integration.test.ts tests/integration/chronicle-chunk-retrieval.integration.test.ts tests/integration/generation-budget-growth.integration.test.ts tests/integration/story-continuity-remediation.integration.test.ts
corepack pnpm check
corepack pnpm build
git diff --check
```

Use the integration configuration: a green run with skipped database cases is not PostgreSQL verification. Never point fixture setup or benchmark seeding at the production database. For publishing, additionally run the applicable full unit/integration scripts specified by [Testing Requirements](../../workflows/testing.md). Check the existing e2e harness/configuration before invoking the browser test; do not assume its filename determines the runner.

## Release and rollback

No migration, config backfill, reindex, or provider change is needed. Deploy compatible API/worker code through the existing release process only when separately authorized. Smoke-check generation monitoring, a reviewable result, and an explicit comparison preview. Reverting these two code changes restores the old SQL and generation shadow behavior; saved settings and private recovery evidence require no rollback transformation. Provider inference remains the dominant normal-turn cost and is outside this plan.

## Implementation record (2026-10-03)

The later implementation authorization supersedes the historical planning-only
scope and deferrals above. Tasks 1 and 2 are implemented locally on
`codex/generation-latency`; Task 3 documentation and focused verification are
complete. Commit, push, and publication were outside the initial implementation authorization; the later publication authorization is recorded below.

The [scoped verification report](../../review/2026-10-03-generation-latency-verification.md)
records the actual results and limitations. Final evidence: 53 focused unit
tests, 74 PostgreSQL tests across eight files, root check/build, eight rendered
mocked-browser cases, and independent reviews passed. Documentation local links
and diff whitespace were checked.

The large-read compound checklist item remains partially verified: the measurement completed
concurrency, p50/p95, equality, temporary storage, errors, and Node benchmark
memory checks, but deployed worker/API memory was not measured; focused commands
and root check/build passed. Subsequent full publication suites completed with
the explicit skip caveats below. Standard integration bootstrap failed on stale shared credentials;
an ignored temporary configuration retained per-file isolation against a
dedicated synthetic PostgreSQL instance.

Polling conditionally avoids copying private JSON with stored size at most
2,048 bytes after unconditional variants caused reproducible small-row overhead.
This measured adjustment preserves public projections and is explained in the
report. Large fixture p95 improved 97.4–97.5% for polling and 93.4–96.6% for sync.
Three small-row polling runs show variability, including isolated deltas above
10%; no same lane reproduced that excess. These are local synthetic results,
not production latency or memory promises. Generation removes comparison work;
previews retain it. Live providers and deployment remain outside authorization.
CI and publication status are recorded below.

## Publication verification record (2026-10-03)

The user subsequently authorized committing, pushing, and creating a PR.
Full units passed: 366 files, 4,727 tests, with 44 existing Windows
platform-gated skips. Four existing route/security SQL matchers were updated
to recognize the public job SELECT inside a CTE after the initial full run
exposed 12 stale-mock failures. The targeted rerun passed 97 tests, followed by
the green full-unit rerun. No assertions, test cases, or production code changed
during that correction.

The full isolated PostgreSQL process loop completed with exit 0: 121 selected
files, 112 passed, nine fully skipped; 1,468 tests passed, 199 skipped, zero failed.
Existing skips include Windows secure-filesystem platform gates and opt-in
`RUN_HISTORICAL_FACT_BENCHMARK` (one case) and
`RUN_KNOWN_FAILURE_BASELINES` (six cases); these behaviors remain unverified. The ignored runner preserves tracked discovery,
one-file-per-process execution, and per-file database isolation, omitting only
the stale shared bootstrap against a dedicated synthetic instance.
Evidence is retained in `tmp/generation-latency/publication-integration-summary.json`
and `publication-integration.log`. Final root `publication-check.log` passed
after the mock updates; the earlier build remains applicable because production
code is unchanged. The dedicated publication database instance was removed.
Local verification is complete; commit, push, and PR creation are pending.
Deployment, live-provider checks, and deployed API/worker memory remain unverified.

## Planning verification (historical)

The worktree was created and current source/test seams were reviewed. Application tests, dependency installation, benchmark reruns, browser checks, and implementation are deferred to execution because this request is planning-only. Check this document's local links and `git diff --check` before handing it off.
