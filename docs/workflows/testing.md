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
