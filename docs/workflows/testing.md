# Testing Requirements (detail)

Extracted from `AGENTS.md` during the 2026-08-01 instruction-file migration. The one generalizable rule ("every code change must include a review of the tests associated with each changed file...") stayed in `AGENTS.md`; this is the detailed test matrix.

Until automated infrastructure exists, manually exercise startup, world and character selection, story generation, choice handling, model switching, output-limit recovery, save/load, import/export, and responsive layout.

New services should introduce:

- Unit tests for domain transitions, prompt sanitization, parser recovery, retrieval ranking, and context budgeting.
- Contract tests for browser/API, worker/text endpoint, worker/image endpoint, and database boundaries.
- Integration tests using a real test database and a deterministic mock LM Studio server.
- End-to-end tests for world creation, version publication, campaign switching, turn generation, restart recovery, and export/import.
- Regression fixtures for truncated output, malformed JSON, reasoning-only output, missing stateful responses, model switching, duplicate submissions, and RPG-mechanic leakage.

Tests must verify that rejected or incomplete generations do not mutate campaign state or Chronicle memory and that one campaign's data cannot appear in another campaign's prompt.
Tests must also cover images disabled, image endpoint unavailable, incompatible image models, independent image retries, and successful story completion when illustration generation fails.
Identity tests must verify initial-user bootstrap idempotency, automatic ownership of pre-auth content, import ownership, rejection of caller-supplied identity spoofing, cross-user query isolation, and explicit OIDC linking to the existing initial user without changing its internal UUID.

## Generation Notification Verification

Run `tests/integration/generation-events.integration.test.ts` against real
PostgreSQL to verify commit visibility, notification-before-subscribe races,
deduplication, listener reconnect, reconciliation, bounded subscriber pool use,
and terminal SSE delivery. The Task 14f rerun on 2026-08-10 passed 4/4 cases.
Its 20-sample notification-to-frame evidence measured 3.930 ms minimum, 5.557
ms median, 7.680 ms p95, and 8.513 ms maximum, well inside the 500 ms budget;
23 authoritative job reads covered initial/reconciliation plus delivered
transitions without restoring the retired 350 ms polling loop.

## Worker-Concurrency Verification and Benchmark

Changes to worker scheduling or generation concurrency must retain automated coverage for all of these invariants:

- A configured story-generation capacity is filled and refilled without exceeding the per-process limit.
- Scheduler visits remain in the strict story → illustration → Chronicle → asset rotation; a busy story queue cannot starve optional work.
- Each optional lane has independent capacity `1`, and an error in one lane does not stop the others.
- Aborting the runtime prevents new claims, drains already active work, and does not pass the scheduler abort signal into an in-flight story request.
- Two worker replicas may claim different campaigns concurrently, but guarded commits and unique constraints still allow only one accepted next turn per campaign.
- An expired lease can be reclaimed and completed while the stale claimant is prevented from committing.
- Disabled, unavailable, incompatible, failed, retried, and attempt-exhausted image jobs never change story acceptance or rerun narration.

Run the focused unit and real-PostgreSQL coverage before the benchmark. The integration commands expect the repository's test database setup and `TEST_DATABASE_URL`:

```sh
pnpm vitest run tests/unit/worker-concurrency.test.ts tests/unit/security-config.test.ts tests/unit/worker-generation-adapter.test.ts tests/unit/runtime-shutdown.test.ts tests/unit/deployment-cors.test.ts
pnpm vitest run tests/integration/generation.integration.test.ts tests/integration/image-pipeline.integration.test.ts
```

The repeatable benchmark is `scripts/benchmark-worker-concurrency.mjs`. It uses production `runWorker` scheduling against deterministic PostgreSQL fixtures, covers concurrency `1`, `2`, and `4`, and checks queue latency, database use, active/peak lane counts, provider limits, and duplicate turn commits. The default fixture uses seed `task-12-c0-worker-v1`, 5 warmups, 30 measured samples, 12 generation jobs and 3 jobs per optional lane in every sample. If throughput coefficient of variation exceeds 5%, the script runs two additional batches and selects the median-throughput batch.

Run it in an actual C0 worker profile. On Linux with Docker and a host-accessible test database, the validated command is:

```sh
docker run --rm \
  --cpus 2 --memory 4g --memory-swap 4g --network host \
  --env-file .env.test.local -e LOG_LEVEL=silent \
  --user "$(id -u):$(id -g)" \
  -v "${PWD:?}:/workspace" -w /workspace \
  node:24-bookworm \
  ./node_modules/.bin/tsx scripts/benchmark-worker-concurrency.mjs --summary
```

The worker benchmark process must report `profile.targetSatisfied: true`, `availableCpuCount: 2`, and `effectiveMemoryLimitGiB: 4`. Docker's cgroup memory limit is intentional: a 4-GiB `prlimit --as` cap limits V8 virtual address reservation rather than physical memory and prevents `tsx` from starting. The PostgreSQL test service is an external deterministic dependency in this measurement; the C0 constraint applies to the worker process whose capacity is under test.

Task 12's reference C0 run on 2026-08-04 produced:

| Story concurrency | Throughput mean / median (jobs/s) | CV | Duration median (ms) | Queue median / p95 (ms) | DB peak / active | Story peak | Illustration / Chronicle / asset peak |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 27.224131 / 27.315826 | 2.6361% | 439.306 | 211.630 / 433.688 | 5 / 5 | 1 | 1 / 1 / 1 |
| 2 | 50.264285 / 50.297259 | 4.8323% | 238.582 | 111.903 / 226.472 | 6 / 6 | 2 | 1 / 1 / 1 |
| 4 | 83.736372 / 85.421612 | 7.6185% | 140.479 | 60.035 / 136.239 | 8 / 8 | 4 | 1 / 1 / 1 |

Concurrency `1` and `2` stayed below the 5% rerun threshold. Concurrency `4` measured 7.6185% in its first batch, so the benchmark ran three batches and selected batch `0` by median throughput; the selected batch's CV remaining above 5% is reported rather than concealed. Every selected batch completed 360 generation jobs and 90 jobs in each optional lane, respected the configured provider and lane limits, and passed the duplicate-turn guard. These numbers are a regression reference for the stated fixture, not a universal production capacity promise; repeat the benchmark against the intended deployment provider and database before raising concurrency there.

The Task 14f C0 rerun on 2026-08-10 used Node 24.19.0, PostgreSQL 18.4,
2 vCPU, 4 GiB, and the same 5/30 fixture. Throughput was
27.759385/51.782043/91.014247 jobs/s at concurrency 1/2/4; queue p95 was
417.061/227.380/112.584 ms; coefficient of variation was
2.8478%/4.6603%/4.2923%. Every point completed 360 story jobs and 90 jobs in
each optional lane, preserved lane peaks of 1, and passed the duplicate-turn
guard.

## Play-Loop Read Verification and Benchmark

Task 13b protects the bounded B4a/Task 13a-R read contracts without changing
their request schemas, response projections, cursor format, sync-token format,
polling behavior, or SSE behavior. Run the focused unit and real-PostgreSQL
coverage with:

```sh
pnpm vitest run tests/unit/database-pool.test.ts tests/unit/play-loop-read-repository.test.ts tests/unit/client-api-routes.test.ts
pnpm vitest run --config vitest.integration.config.ts tests/integration/play-loop-read-performance.integration.test.ts tests/integration/gameplay.integration.test.ts tests/integration/dashboard-stats.integration.test.ts tests/integration/generation.integration.test.ts
```

The repeatable benchmark is `scripts/benchmark-play-loop.mjs`. It creates and
drops an isolated PostgreSQL database, migrates it, and seeds three owned
campaigns from fixture seed `task-13b-c0-play-loop-v1`:

| Fixture | Accepted turns | Generation jobs | Image jobs | Chronicle memories |
| --- | ---: | ---: | ---: | ---: |
| Small | 12 | 4 | 3 | 12 |
| 200-turn | 200 | 40 | 20 | 200 |
| Long-running | 2,000 | 400 | 100 | 2,000 |

Each run uses 5 warmups and 30 measured samples by default. It records p50/p95
latency, coefficient of variation, p50/p95 response bytes, error rate, exact SQL
query counts, PostgreSQL version, fixture cardinalities, bounded-page evidence,
and summarized `EXPLAIN (ANALYZE, BUFFERS)` results. It walks the long campaign's
first, middle, and last cursor pages; measures both replacement and unchanged
sync; and covers campaign list, dashboard, generation polling/result, and the
initial list-plus-sync Story Player hydration path. Use lower sample counts only
for local harness debugging:

```sh
PLAY_LOOP_BENCHMARK_WARMUPS=1 PLAY_LOOP_BENCHMARK_SAMPLES=3 pnpm exec tsx scripts/benchmark-play-loop.mjs
```

Route query counts are steady-state counts after the benchmark resolves the
process-lifetime initial-owner bridge once. The first request made by a newly
started process can add that one owner query; subsequent requests on the same
pool use the cached UUID.

Run the reference measurement in the actual C0 process profile:

```sh
docker run --rm \
  --cpus 2 --memory 4g --memory-swap 4g --network host \
  --env-file .env.test.local -e LOG_LEVEL=silent \
  --user "$(id -u):$(id -g)" \
  -v "${PWD:?}:/workspace" -w /workspace \
  node:24-bookworm \
  ./node_modules/.bin/tsx scripts/benchmark-play-loop.mjs
```

The run is valid only when `profile.targetSatisfied` is `true`,
`availableCpuCount` is `2`, `cgroupMemoryLimitGiB` is `4`, every error rate is
zero, fixture cardinalities match the table above, and query counts are stable
across all samples. The PostgreSQL service is the deterministic external test
dependency; the C0 constraint applies to the API/benchmark process.

Task 13b's paired C0 reference runs on 2026-08-04 used Node 24.19.0 and
PostgreSQL 18.4. The baseline retained the original sync and history-fingerprint
queries; the post-change run used the one-query unchanged-sync fast path and the
bounded latest-ID fingerprint lookup. Both used the same migrated fixture and
5/30 warmup/sample configuration:

| Route | Baseline p50 / p95 (ms) | Post p50 / p95 (ms) | Post CV | Response p50 / p95 (bytes) | Post SQL queries |
| --- | ---: | ---: | ---: | ---: | ---: |
| Campaign list | 2.649 / 4.119 | 2.905 / 3.818 | 13.7793% | 2,625 / 2,625 | 1 |
| Dashboard | 2.757 / 3.510 | 3.012 / 5.099 | 31.9089% | 1,007 / 1,007 | 2 |
| Sync — replacement | 10.017 / 13.466 | 6.652 / 9.272 | 19.6069% | 33,912 / 33,912 | 6 |
| Sync — unchanged | 7.568 / 9.556 | 3.861 / 6.710 | 28.1190% | 2,947 / 2,947 | 1 (baseline: 6) |
| History — first | 5.866 / 7.409 | 3.313 / 5.863 | 35.1030% | 30,971 / 30,971 | 5 |
| History — middle | 3.859 / 6.666 | 3.468 / 5.459 | 22.1075% | 30,971 / 30,971 | 5 |
| History — last | 5.745 / 7.288 | 5.256 / 6.008 | 18.4909% | 30,186 / 30,186 | 5 |
| Generation poll | 0.944 / 1.501 | 1.245 / 1.611 | 16.6915% | 760 / 760 | 1 |
| Generation result | 2.101 / 2.609 | 2.590 / 3.049 | 10.2181% | 961 / 961 | 2 |
| Initial hydration | 11.013 / 13.197 | 10.375 / 13.897 | 18.5190% | 36,537 / 36,537 | 7 |

The changed hot paths clear the 10% regression guardrail: replacement sync p95
improved 31.1%, unchanged sync p95 improved 29.8% while eliminating five SQL
statements, and first/middle/last history p95 improved 20.9%/18.1%/17.6%.
Unchanged route payloads remain byte-for-byte stable because B4b freezes the
public projections. Dashboard and generation-result p95 moved by more than 10%
in this paired run even though neither query changed; their reported CV and a
second post-change run (3.896 ms and 3.630 ms p95 respectively) show host-level
variance rather than a hidden query-count or payload regression. Treat those
absolute numbers as evidence to repeat, not as proof that an unrelated route
became slower. The approved deterministic targets are the query counts in the
table, zero errors, the recorded response bounds, and no greater than 10%
regression for a route whose implementation changes in a future patch.

The long fixture returned exactly 50 turns for first, middle, last, and initial
sync windows; the first page had a cursor and the last did not. No hot route had
a network-level N+1 query count. The generation result intentionally performs a
second, batched reported-cost query. The measured service tree contains 100
`initialOwnerId(` call sites; the lookup now coalesces in-flight and sequential
reads per actual pool/client object, while rejected lookups are evicted and
separate pools/databases remain isolated.

The summarized plans did not justify migration 0053. The history fingerprint
removed the all-ID aggregate sort: execution moved from 1.028 ms and 330 shared
hit blocks to 0.584 ms and 251 shared hit blocks, with zero shared reads/writes
and zero temporary blocks. The post-change sync-status statement completed in
0.356 ms with 164 shared hit blocks and no physical or temporary I/O; its added
bounded latest-turn/recovery checks use the existing turn ordering index. The
campaign-list and history-page plans completed in 1.728 ms and 0.320 ms. Adding
another turn or generation-job index at these cardinalities would impose write
amplification on every accepted turn/job without removing a demonstrated slow
scan. Consequently no index or rollback migration was added; rerun this profile
against production-scale cardinalities before revisiting that decision.

The Task 14f C0 rerun on 2026-08-10 used Node 24.19.0 and PostgreSQL 18.4
with the same 5/30 small/200/2,000-turn fixtures. All routes had zero errors;
first, middle, last, and initial-sync windows remained bounded at 50 turns.
Current post-B5 application-composition query counts are 3 campaign-list, 4
dashboard, 8 replacement-sync, 3 unchanged-sync, 5 per history page, 1
generation poll, 2 generation result, and 11 initial hydration; the executable
performance regression asserts these counts. Corresponding p95 values were
3.542, 4.898, 13.864, 5.364, 3.738/4.933/3.631, 0.585, 1.160, and 10.786 ms.
The four summarized plans reported zero shared reads/writes and zero temporary
blocks; execution times were 0.870 ms campaign-list, 0.273 ms sync-status,
0.765 ms history fingerprint, and 0.123 ms history page. These figures replace
the pre-B5 route-composition counts as the current regression reference without
changing the frozen public payload contracts.
