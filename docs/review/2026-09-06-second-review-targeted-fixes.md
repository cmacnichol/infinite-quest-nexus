# Targeted fixes from the second completion review

Scope: four confirmed findings from the September 6 review. Work only in the existing remediation worktree; preserve earlier edits. No commit, publication, deployment, or main integration.

Binding requirements: the September 5 nexus prompt-memory remediation specification, particularly R5, R7, R8, and the effective provider budget contract.

## Tasks and acceptance

1. Terra repair_limits: enforce a durable single before/pending-event repair allowance across changed drafts and restart; exhaustion is recoverable event_coverage_failed without authoritative mutation. Use replacement output budgeting for whole-main rewrites. Regressions: repeated coverage rejection and feasible near-limit replacement.
2. Terra authority_transaction: capture consistent generation authority in a short transaction, release its locks before embedding network work, and preserve campaign/world/base-turn isolation and full hybrid ranking. Regressions: blocked embeddings do not hold authority locks; existing retrieval and integrity cases remain green.
3. Terra operation_budgets: propagate the job effective context cap and documented safety allowance through every generation operation and actual serialized request, including recovery/fallback. Preserve output reserve and provenance. Regressions: downstream smaller job cap and safety boundary.
4. Controller: inspect task diffs and RED/GREEN evidence, arrange independent final review, run combined unit/integration/type/build checks, and record actual results and remaining release limitations.

## Coordination

Tasks 1 and 3 share runtime adapter and its unit test: Task 1 edits first; Task 3 waits for explicit release of those files. Database task owns its repository files and tests independently. All agents preserve prior edits and add failing tests before production changes.

## Preflight

| Tasks | Shared surface | Ruling |
| --- | --- | --- |
| 1 / 3 | Runtime provider requests and executor tests | Sequence shared-file edits; replacement budgeting must use the new effective request budget. |
| 2 / 3 | Authority returned to planner | Preserve authority shape; transaction phase split must not change budget semantics. |
| 1 / 2 | No shared edit surface | Independent. |
| 1 | One repair and replacement semantics | Tests and implementation requirements agree. |
| 2 | Snapshot consistency and released locks | Both required; do not remove locking without preserving a consistent snapshot. |
| 3 | Effective cap and allowance | Apply once per request with unchanged output reserve; do not silently expand the configured cap. |

## Verification status

Completed. Fresh verification and review results are recorded below.

## Implemented changes

| Finding | Targeted correction |
| --- | --- |
| Unbounded before/pending coverage repairs | Persist main-stage consumption before provider work and retain it across rewritten drafts, later immediate repairs, and older compatible null-extension repair fences. Exhaustion remains recoverable without an accepted-turn commit. |
| Replacement treated as extension | Whole-main repair uses replacement output feasibility. A real serializer regression covers a 200,000-character rejected narration that need not be preserved in the replacement. |
| Authority locks across embedding calls | Commit/release the authority transaction before autocommit retrieval. Caller-owned transaction clients receive authority only. Preserve cache atomicity with a short transaction after provider work. |
| Effective context and safety omitted downstream | Thread the job cap through every canonical operation, reserve the shared estimated input allowance during selection and final serialization, remeasure recovery fallback, and bind the effective policy in checkpoint provenance. Input safety does not consume output reserve. |

Independent task and combined reviews checked specification compliance and code
quality. Follow-up review caught and corrected the legacy repair-fence overwrite;
invalid supplied job-cap rejection also passed regression tests and scoped re-review.

The unchanged release limitations remain: no live-provider canary or rendered
browser rerun in this backend-only task, and no deployment or main integration.
Earlier checkpoint-version migration guidance still applies. The modified code
and reports remain uncommitted in this isolated worktree.


## Final verification

- **Passed:** full unit suite, 238 files / 2,825 tests. **Skipped:** 44 existing Windows platform-gated filesystem/POSIX cases.
- **Passed:** 120 real PostgreSQL tests across six suites: generation (50), generation execution repository (20), Chronicle query cache (8), Chronicle chunk retrieval (17), Chronicle contract matrix (24), and composed continuity (1). The blocked-embedding test acquired campaign/state locks through a second connection before releasing the embedding gate. Each integration file used the configured isolated database setup.
- **Passed:** `pnpm check`, `pnpm build`, and `git diff --check`. Final unit/type/build checks and generation integration ran after the last production correction; unaffected database suites passed earlier in this same execution.
- **Review passed:** independent spec/quality reviews for repair, transaction, and budget tasks; combined integration review; scoped re-review of the final invalid-cap correction. No reported actionable findings remain in this targeted scope.
- **Warnings:** existing Git configuration/line-ending warnings in test fixtures and the existing Vite bundle-size warning. These did not fail the checks.
- **Not run:** live-provider canaries and rendered browser verification. Deterministic provider fixtures supplied the automated evidence; this patch makes no visible UI changes. These results do not establish production rollout readiness or resolve unrelated release gates.

The final successful checks supersede intermediate agent reports of TypeScript
errors observed while another agent was editing shared interfaces.

### Regression evidence

Tests failed before the corresponding fixes for changed-draft repair exhaustion,
incorrect replacement budget type, missing commit before blocked embeddings,
smaller job context limits, missing safety headroom, estimated audit labeling,
optional-history selection without safety, legacy repair-fence loss, and invalid
zero/infinite limits. The final focused budget/executor run passed 48 tests;
the transaction unit suite passed 30. The additional real serializer case proves
that a feasible replacement can pass where preserving the old narration plus a
suffix fails. The legacy checkpoint regression exercises restart into immediate
repair and verifies that overwriting the repair record retains the main allowance.

### Commands

```powershell
node node_modules/vitest/vitest.mjs run tests/unit --exclude '**/.worktrees/**' --exclude '**/.codex/**'
node node_modules/vitest/vitest.mjs run --config vitest.integration.config.ts tests/integration/chronicle-query-cache.integration.test.ts tests/integration/generation-execution-repository.integration.test.ts
node node_modules/vitest/vitest.mjs run --config vitest.integration.config.ts tests/integration/chronicle-chunk-retrieval.integration.test.ts tests/integration/chronicle-contract-matrix.integration.test.ts tests/integration/story-continuity-remediation.integration.test.ts
node node_modules/vitest/vitest.mjs run --config vitest.integration.config.ts tests/integration/generation.integration.test.ts
pnpm check
pnpm build
git diff --check
```
