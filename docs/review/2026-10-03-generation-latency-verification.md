# Targeted generation latency verification — 2026-10-03

The local implementation preserves bounded public generation status/sync results
and private recovery evidence while reducing repeated large-JSON expansion.
Ordinary generation now skips diagnostic shadow retrieval; explicit Chronicle
previews still honor the saved shadow flag. No migration, stored public
projection, dependency, prompt protocol, provider setting, UI layout, polling
schedule, or SSE schedule changes.

Baseline: `94853d2d859f57b8a75bb69edd532c016570dffa`. Implementation:
`codex/generation-latency`, initially verified as uncommitted worktree changes. See the
[implementation plan](../superpowers/plans/2026-10-03-targeted-generation-latency.md),
[Chronicle explanation](../concepts/chronicle-memory.md), and
[ADR clarification](../architecture/0028-chunked-chronicle-retrieval.md).

## Status and sync performance

The benchmark compares the actual baseline and changed repository SQL on one
disposable PostgreSQL 18.6 instance, with unchanged 4 MB `work_mem`, five
warmups, 30 alternating measured batches, concurrency 1/4, and bounded pools
5/8. Synthetic incompressible private JSON is 11,185,907 bytes, with 400
historical jobs per sync lane. Authorized status/order/limit selection precedes
expansion. Each read remains one statement.

| Selected large read | Concurrency | Baseline p95 ms | Changed p95 ms | Reduction |
| --- | ---: | ---: | ---: | ---: |
| Poll recovery | 1 | 656.494 | 16.314 | 97.5% |
| Poll recovery | 4 | 966.468 | 25.423 | 97.4% |
| Sync recovery | 1 | 554.729 | 19.424 | 96.5% |
| Sync recovery | 4 | 765.251 | 26.215 | 96.6% |
| Sync pending | 1 | 350.549 | 18.550 | 94.7% |
| Sync pending | 4 | 501.034 | 32.821 | 93.4% |

These fixture results exceed the planned 50% large-row p95 improvement.
Every timed public result matched; private evidence hashes remained unchanged,
private canaries were absent, and errors were zero. Actual repository integration
checks also retain owner isolation, response/review compatibility, latest-job
selection, sync tokens, bounded payloads, and query budgets.

One measured adjustment refines the plan: polling skips the empty-object JSON
copy when `pg_column_size(orchestration_private) <= 2048`. Larger stored values
expand once in the filtered materialized CTE. This avoids reproducible small-row
overhead from unconditional materialization/copy variants without rewriting
projection rules. Stored size is a heuristic: compressed TOAST can have a small
physical size despite large logical JSON. Sync retains the planned selected-row
expansion. Lateral/record alternatives were measured and discarded.

All three final conditional polling small/legacy runs are disclosed below.
Positive deltas mean slower changed reads.

| Concurrency / shape | Run 1 baseline/changed p95 ms (delta) | Run 2 | Confirmation |
| --- | --- | --- | --- |
| 1 / legacy | 2.783 / 2.819 (+1.3%) | 2.484 / 2.799 (+12.7%) | 2.962 / 2.637 (-10.9%) |
| 1 / small | 2.763 / 2.980 (+7.9%) | 2.853 / 2.823 (-1.0%) | 3.333 / 3.915 (+17.5%) |
| 4 / legacy | 3.325 / 4.002 (+20.4%) | 3.547 / 3.756 (+5.9%) | 3.343 / 3.675 (+9.9%) |
| 4 / small | 2.756 / 3.007 (+9.1%) | 2.896 / 3.025 (+4.5%) | 3.012 / 3.462 (+15.0%) |

No same polling lane exceeded 10% in two of these three runs. Small-row
variability remains material; these results do not promise a deployment latency.
Sync small/legacy repeats likewise found no reproducible greater-than-10%
regression: a later concurrency-1 pending-small +13.0% outlier followed
-12.4%, -3.6%, and -5.9% earlier results, then -18.7% in the conditional run.

Large changed plans write 1,365 temporary 8 KiB blocks, approximately 10.66 MiB
per selected read, with no temporary reads. Small/legacy plans write none.
Large shared buffer hits drop from roughly 120,000–173,000 to 1,422–1,459.
Temporary writes remain a concurrency cost; no global memory setting was raised.

Across 480 additional concurrency-4 changed polling reads, the benchmark Node
process RSS stayed about 206.6–206.8 MiB and heap used about 102.1–102.2 MiB,
without sustained growth. This is benchmark-process evidence only. Deployed
API/worker memory, production concurrency, and live latency remain unmeasured.

## Generation versus explicit preview

Deterministic fixture assertions establish execution placement rather than a
fixed latency target:

| Path | Before / after embedding-profile resolutions | Before / after shadow savepoints | Before / after embedding calls |
| --- | --- | --- | --- |
| Generation, shadow enabled | 2 / 1 | 2 / 0 | 1 / 1 |
| Generation, shadow disabled | 1 / 1 | 0 / 0 | 1 / 1 |
| Explicit preview, shadow enabled | 2 / 2 | comparisons retained | 1 / 1 |

Generation shadow-off/on candidates and production audit are equal, and generation
does not record diagnostic comparisons. Preview coverage retains lexical,
legacy, and chunked comparisons and isolates a failing shadow implementation.
Production selection, ranking, authorization/cutoffs, readiness, full legacy
fallback, indexing jobs, and saved/default configuration remain unchanged.

One exploratory local timing run reused the deterministic integration fixture,
cleared query caches, and used two warmups plus seven measured calls per mode.
Median milliseconds were:

| Path | Before | After |
| --- | ---: | ---: |
| Generation, shadow disabled | 26.366 | 26.448 |
| Generation, shadow enabled | 31.875 | 26.051 |
| Explicit preview, shadow enabled | 36.151 | 37.493 |

The enabled-generation difference is 5.824 ms (18.27%) in this one run.
It is not a general savings estimate or an attribution of the historical
0.12–6.69-second retrieval phase to shadow work. No live embedding/text endpoint
was called.

## Checks and limitations

| Check | Result | Scope / evidence |
| --- | --- | --- |
| Focused units | Passed | 53 tests: Task 1, four files/21 tests; Task 2, two files/32 tests. |
| Focused PostgreSQL | Passed | 74 tests in eight files: Task 1, 28; Task 2, 46. Actual PostgreSQL, deterministic providers, per-file isolated databases. |
| Root `corepack pnpm check` | Passed | Initial `final-check.log` and final `publication-check.log` under `tmp/generation-latency/`; final check includes the mock updates. |
| Root `corepack pnpm build` | Passed | `tmp/generation-latency/final-build.log`; existing bundle-size warning remains. |
| Rendered generation review | Passed | Eight existing baseline browser cases passed before backend changes (11.3 seconds): legacy/web-next, Keep/retry, desktop/mobile; mocked API/provider fixtures. No visible UI change. |
| Independent reviews | Passed | Both production changes reviewed independently; no actionable defects reported. |
| Documentation links / diff whitespace | Passed | Local targets and scoped documentation diff checked; no executable behavior introduced by documentation. |
| Standard shared integration bootstrap | Failed before tests | Stale shared-database password authentication; not an application failure. |
| Full units | Passed | 366 files, 4,727 tests; 44 existing Windows platform-gated skips. `tmp/generation-latency/publication-unit-final.log`. |
| Full PostgreSQL publication suite | Passed with skips | 121 selected files: 112 passed, nine fully skipped; 1,468 tests passed, 199 existing tests skipped, zero failed; process loop exit 0. |
| CI | Pending | Commit, push, and PR publication are now authorized; no CI result claimed yet. |
| Deployment / live providers | Skipped | No deployment or live-provider work authorized. |
| Deployed API/worker memory | Skipped | No deployment/live runtime access in this scope; Node benchmark memory is not a substitute. |

The focused database runs use an ignored temporary configuration preserving
the tracked integration setupFiles, sequencing, timeouts, and per-file isolation,
while omitting the stale shared global bootstrap. A dedicated synthetic instance
supplied the base connection. This verifies the focused database behavior, not
the standard shared bootstrap. The separate full publication run is recorded below. Root checks/build
used a local ignored pinned pnpm shim after nested scripts initially resolved an
incompatible global version; tracked package-manager configuration is unchanged.

Browser captures remain under ignored `tmp/generation-latency/browser/`: `legacy-accepted-1440.png`, `legacy-eligible-1440.png`, `legacy-eligible-390.png`, `web-next-eligible-1440.png`, and `web-next-eligible-390.png`.

Detailed synthetic statements, timing JSON, explanations, review notes, and logs
remain under ignored `tmp/generation-latency/`; no credentials, private campaign
content, or raw provider evidence are included here. Browser fixtures establish
player controls, not a live-provider or composed PostgreSQL browser proof.
The initial dedicated synthetic database instance was removed after focused verification;
logs retain the evidence. The separate dedicated synthetic publication instance was
also removed after verification. Deployment and live-provider checks remain outside scope.

## Publication verification update (2026-10-03)

The user subsequently authorized commit, push, and PR creation. Full-suite
verification completed before publication; commit and PR creation are pending. The initial full-unit run exposed
12 failures in route/security mocks that recognized only a leading
`SELECT`. Four existing matchers in `client-api-routes.test.ts` and
`server-security.test.ts` now accept the public job SELECT inside `WITH`.
Assertions, cases, and production code did not change. The targeted rerun passed
97 tests; the full rerun passed 366 files and 4,727 tests in 35.89 seconds.
The 44 skipped cases retain existing Windows gates for POSIX/secure-filesystem
behavior; they do not verify those platform capabilities.

The full PostgreSQL process loop completed with exit 0: 121 selected files,
112 passed, nine fully skipped, 1,468 tests passed, 199 skipped, and zero failed.
Existing skips include Windows secure-filesystem platform gates and opt-in
`RUN_HISTORICAL_FACT_BENCHMARK` (one case) and
`RUN_KNOWN_FAILURE_BASELINES` (six cases). Skipped behavior is not verified.
Evidence: `tmp/generation-latency/publication-integration-summary.json` and
`publication-integration.log`. The run uses ignored
`tmp/generation-latency/run-publication-integration.mjs`, preserving tracked
file discovery, one-file-per-process execution, and per-file database isolation,
while omitting only the stale shared bootstrap. This is a dedicated synthetic
database run, not a verification of the shared bootstrap.

Reverting the two production changes restores previous SQL/shadow execution.
Saved settings and private evidence need no rollback transformation. Provider
inference duration is outside this change.
