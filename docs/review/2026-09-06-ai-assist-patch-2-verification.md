# AI Assist Patch 2 verification record

P2.1–P2.9 have passed their scoped reviews. P2.10 fix round 1 addresses the task review checkpoint-boundary finding and awaits independent scoped re-review; the separate whole-branch review is still pending. This record does not accept or publish Patch 2 and does not authorize Patch 3.

## Scope and migration

The additive migrations are [0089_authoring_jobs.sql](https://github.com/cmacnichol/infinite-quest-nexus/blob/e7b4c064cb7eeff6043288f19d354159a9a88d1e/database/migrations/0089_authoring_jobs.sql) and [0090_authoring_apply_review_selection.sql](https://github.com/cmacnichol/infinite-quest-nexus/blob/e7b4c064cb7eeff6043288f19d354159a9a88d1e/database/migrations/0090_authoring_apply_review_selection.sql). Deploy compatible API and worker roles with `AI_AUTHORING_JOBS_ENABLED=false`, then enable both roles after verification. Rollback disables admission and generation while preserving schema and unexpired proposals. Ordinary bounded retention continues: seven days for inactive proposals and thirty days for applied receipts. Disabling is not a retention pause. See [operations](../runbooks/ai-authoring.md) and [deployment](../runbooks/deployment.md).

P2.10 changes test infrastructure, benchmark fixtures, two historical organizer assertions, and this record. The organizer assertions now check the existing safe 503 envelope; missing-default world and character generation retain 409. No production authoring code or Patch 3 behavior changed in P2.10.

## Exact failure boundaries

Each row names committed tests and the actual boundary asserted. The plan phrase "after checkpoint and before the HTTP response" spans two operations in this asynchronous architecture: the private worker checkpoint commit before completion returns to `runNext`, and the client polling response after a stored checkpoint. There is no HTTP checkpoint endpoint. Fix round 1 proves the first operation with an OS exit inside the checkpoint wrapper after its real transaction commits; the separate dropped-poll test proves the HTTP operation. Neither test substitutes for the other.

| Boundary | Direct evidence |
| --- | --- |
| Worker replacement after successful child checkpoint | [Process suite](../../tests/integration/authoring-jobs.integration.test.ts), `replaces a stopped worker process after a child checkpoint without replaying persisted stages`: actual Node process A exits after world plus first child; process B executes only the remaining two children. PostgreSQL `output::text` byte lengths and SHA-256 hashes are compared before/after and emitted as safe evidence. |
| Successful provider result before checkpoint | Same suite, `recovers an OS worker exit after successful HTTP provider validation but before checkpoint`: real HTTP response is validated, then the child exits with code 86 at the checkpoint seam before SQL runs. The row remains running with null output. After lease expiry a replacement repeats only that uncheckpointed world request, then completes all three children once. |
| Checkpoint commit before worker completion returns | Process suite, `retains a committed child checkpoint after OS exit before checkpoint returns to the worker`: the wrapper awaits the actual repository checkpoint transaction, then exits with code 87 before returning to `runNext`. The parent requires no completion output, reads the committed child and prior world `output::text`, and starts a replacement process. Their bytes and SHA-256 hashes remain equal; only the two unfinished children call the real HTTP provider. No lease-expiry manipulation or HTTP checkpoint endpoint is introduced. |
| Client polling response loss after a stored checkpoint | [Route suite](../../tests/integration/authoring-routes.integration.test.ts), `recovers a checkpointed proposal after its polling HTTP response is dropped before delivery`: real repository checkpoint, real listening Fastify server, socket destroyed in `onSend`, then a replacement API server returns the retained proposal. Persisted bytes match and no stage is claimable. The worker has no HTTP completion response; this is loss of the client's post-checkpoint polling response. |
| Apply transaction before HTTP response delivery | Same route suite, `replays an apply whose actual HTTP socket closes after the transaction commits`: real POST socket closes after commit, then a replacement API replays the same body/key and returns the stored receipt. Exactly one draft exists. This is additional evidence, separate from the checkpoint/poll boundary above. |
| Cancellation during repair | [Stage suite](../../tests/integration/authoring-stage-execution.integration.test.ts), `cancels while the repair provider request is in flight and rejects its late valid result`: initial invalid output starts a second repair request; cancellation commits while that request is pending. Its late valid result rejects, output stays null, and no further claim is available. This uses a deterministic provider collaborator and real PostgreSQL. The same file also covers cancellation before initial, transport retry, repair, and acceptance boundaries. |
| Pinned provider deletion | Process suite, `keeps checkpoints and fails safely when the pinned provider is deleted between worker processes`: delete the actual profile after world checkpoint. Replacement worker stores `authoring_provider_unavailable` on the first child without another HTTP call. The job becomes recoverable; two queued siblings wait for explicit recovery. World bytes remain unchanged. |
| Target world deletion | [Apply suite](../../tests/integration/authoring-apply.integration.test.ts), `rejects apply after its target world is deleted and preserves the unapplied review`: delete the real target after review; apply returns `authoring_not_found`, creates no replacement world or receipt, and retains reviewed content. |
| Stale review/apply revisions and generations | [Repository suite](../../tests/integration/authoring-job-repository.integration.test.ts), `allows exactly one competing review CAS and retains that winner` and `rejects unknown and superseded review selections and refuses expired commands`; apply suite, `rejects a stale target revision and stale selected generation before any authoritative mutation`. |
| Duplicate submission/apply and owner isolation | Repository suite, `makes simultaneous identical submissions one durable owner-scoped job` and `does not expose or mutate a job through a foreign owner claim`; apply suite, `atomically creates one draft and replays a lost same-key apply response`, including nonempty owned/foreign campaign, version, turn and memory row snapshots. Route suite also denies foreign-owner detail/commands. |
| Retry preserves completed work | Stage suite, `checkpoints outline and first character, fails the second twice, and retries only missing work with successful bytes unchanged`: one failed child is retried; successful sibling hashes/bytes and provider call counts are asserted. |

The new direct cases required no production fix. Initial failures were harness expectations: deleted targets return the existing `authoring_not_found`, and failed worker execution returns false and pauses the recoverable job. Those attempts remain recorded; they are not presented as product-defect RED evidence. Earlier accepted tasks contain their own behavioral RED/GREEN evidence. P2.9's initial RED record was reconstructed observations, while its cleanup-cadence fix has retained raw RED/GREEN output.

## Final verification results

Working directory was `C:\Git\InfiniteQuest\.worktrees\ai-assist-patch-2`, based on accepted P2.9 `e7b4c064cb7eeff6043288f19d354159a9a88d1e`. The evidence directory `D` below is ignored local audit material, not a required package or a public link. Its private integration configuration replaces only global provisioning with the dedicated loopback PostgreSQL instance at port 15440 and retains the repository's per-file isolation. Credentials are intentionally omitted.

| Check | Result | Retained local evidence |
| --- | --- | --- |
| Pre-review combined PostgreSQL files: process, routes, apply, stage execution | **35 passed**, four files; unchanged non-process cases retained after fix round 1 | `task-10-completion-pg-final.log` |
| Fix round 1 process suite | **4 passed**, including the new post-commit OS exit, on the first run; no production fix or behavioral RED claimed | `task-10-fix-1-process.log` |
| Earlier broader repository/stage/routes/apply/process matrix | **68 passed**, five files before the six added direct cases; not a new final combined run | `task-10-real-pg-scenario-matrix.log` |
| Plan-listed authoring units and worker regressions | **132 passed**, eleven files | `task-10-authoring-units.log` |
| Plan-listed authoring/retention/world-generation PostgreSQL tests | **66 passed**, six files before direct-case additions | `task-10-authoring-real-pg.log` |
| Patch 1 focused regression units | **426 passed**, sixteen files | `task-10-patch1-units.log` |
| Historical organizer compatibility suite | **7 passed, 1 skipped**; existing Linux-only secure staging case skipped on Windows | `task-10-legacy-unavailable-green.log` |
| Rendered browser regression suite with mocked HTTP | **26 passed** | `task-10-browser-final.log` |
| Actual Compose UI save/refresh/retry/apply | **Passed**, real API, PostgreSQL and deterministic HTTP provider; zero browser page errors | `task-10-compose-browser-final.log` |
| Actual both-role disabled rollback and restoration | **Passed** | `task-10-compose-rollback-final-2.log` |
| Final repository/data boundaries and TypeScript/client/syntax checks | **Passed** | `task-10-fix-1-check.log` |
| Application build | **Passed** earlier in P2.10, retained because subsequent changes affect tests/fixtures/docs only; existing font/chunk warnings | `task-10-build.log` |
| P2.9 archive/retention verification | **52 passed, 4 skipped** Linux secure-staging cases on Windows; retained accepted evidence | `task-9-green-integration.log` |
| Swarm configuration | **Rendered successfully**, configuration-only evidence; no live Swarm deployment | `task-9-stack-config.log` |

The pre-review combined PostgreSQL command and fix round 1 focused rerun were:

```powershell
$D = '.superpowers/sdd/2026-09-06-ai-assist-patch-2-durable-authoring'
node node_modules/vitest/vitest.mjs run --config "$D/vitest.integration.config.ts" tests/integration/authoring-jobs.integration.test.ts tests/integration/authoring-routes.integration.test.ts tests/integration/authoring-apply.integration.test.ts tests/integration/authoring-stage-execution.integration.test.ts
node node_modules/vitest/vitest.mjs run --config "$D/vitest.integration.config.ts" tests/integration/authoring-jobs.integration.test.ts
pnpm check
git diff --check
```

For a clean checkout, the committed [integration configuration](../../vitest.integration.config.ts) and [test workflow](../workflows/testing.md) provide the normal disposable database provisioner. This run instead used the already provisioned isolated instance; it did not invoke or reset the shared default database. The private override can be reproduced by inheriting the committed configuration and replacing `test.globalSetup` with a setup that validates and sets `TEST_DATABASE_URL` for a dedicated test database, leaving `test.setupFiles` and per-file isolation unchanged.

Earlier required commands retained in P2.10 were:

```powershell
node node_modules/vitest/vitest.mjs run tests/unit/authoring-jobs.test.ts tests/unit/application/authoring-use-cases.test.ts tests/unit/authoring-stage-adapter.test.ts tests/unit/authoring-worker.test.ts tests/unit/runtime-authoring-composition.test.ts tests/unit/authoring-routes.test.ts tests/unit/web-next-authoring-jobs-api.test.ts tests/unit/web-next-authoring-job-session.test.ts tests/unit/worker-concurrency.test.ts tests/unit/runtime-shutdown.test.ts tests/unit/system-archive-portability.test.ts --exclude '**/.worktrees/**' --exclude '**/.codex/**'
node node_modules/vitest/vitest.mjs run --config "$D/vitest.integration.config.ts" tests/integration/authoring-job-repository.integration.test.ts tests/integration/authoring-routes.integration.test.ts tests/integration/authoring-apply.integration.test.ts tests/integration/authoring-retention.integration.test.ts tests/integration/authoring-jobs.integration.test.ts tests/integration/world-generation.integration.test.ts
node node_modules/vitest/vitest.mjs run --config "$D/vitest.integration.config.ts" tests/integration/authoring-job-repository.integration.test.ts tests/integration/authoring-stage-execution.integration.test.ts tests/integration/authoring-routes.integration.test.ts tests/integration/authoring-apply.integration.test.ts tests/integration/authoring-jobs.integration.test.ts
node node_modules/vitest/vitest.mjs run --config "$D/vitest.integration.config.ts" tests/integration/world-campaign-route-application.integration.test.ts
node node_modules/vitest/vitest.mjs run tests/unit/authoring-output.test.ts tests/unit/authoring-prompts.test.ts tests/unit/authoring-response-adapter.test.ts tests/unit/character-generator-service.test.ts tests/unit/world-generator-service.test.ts tests/unit/generated-world.test.ts tests/unit/world-library.test.ts tests/unit/character-profiles.test.ts tests/unit/prompt-library.test.ts tests/unit/web-next-authoring-errors.test.ts tests/unit/web-next-world-creation-api.test.ts tests/unit/web-next-world-creation-page.test.ts tests/unit/web-next-character-workspace-api.test.ts tests/unit/web-next-character-workspace-page.test.ts tests/unit/server-security.test.ts tests/unit/providers.test.ts --exclude '**/.worktrees/**' --exclude '**/.codex/**'
node node_modules/@playwright/test/cli.js test tests/e2e/ai-assist-errors.e2e.test.ts tests/e2e/ai-assist-resume.e2e.test.ts --output C:/Users/chris/.codex/visualizations/2026/09/06/01a077cb-4d3b-7f31-95ee-a4d810fe53de/p2-10-browser-final
pnpm build
```

## Disposable Compose proof

[Compose fixture](../../tests/fixtures/authoring/compose-p2-10.yaml), [deterministic provider](../../tests/fixtures/authoring/compose-provider.mjs), [browser proof](../../tests/fixtures/authoring/compose-browser-proof.mjs), and [rollback proof](../../tests/fixtures/authoring/compose-rollback-proof.mjs) are committed reproducible sources. The project is `infinitequest-ai-assist-p2-10-proof`; its database uses tmpfs, the API binds only loopback port 45680, and API/worker/provider run separately. Existing deployments and persistent volumes were untouched. The running private manifest uses the same topology and provider response logic; its credentials stay local.

Build a runtime image, set `P2_PROOF_IMAGE`, a URL-safe disposable `P2_PROOF_DATABASE_PASSWORD`, and `P2_PROOF_CREDENTIAL_KEY` privately, and choose `P2_PROOF_SCREENSHOTS`. Then:

```powershell
docker build --tag infinitequest-ai-assist-p2-runtime:e7b4c064 .
$env:P2_PROOF_IMAGE = 'infinitequest-ai-assist-p2-runtime:e7b4c064'
docker compose -f tests/fixtures/authoring/compose-p2-10.yaml up -d
node tests/fixtures/authoring/compose-browser-proof.mjs
node tests/fixtures/authoring/compose-rollback-proof.mjs
```

For the actual existing private project the rollback invocation additionally set `P2_PROOF_COMPOSE_FILE` to `$D/compose-p2-10.yaml`. Browser capture used the approved artifact root below. Both scripts restart only the named disposable roles; rollback removes only its two temporary disabled-role containers and restores the ordinary API and worker in `finally`.

The final browser run used UI Generate, forced a failed first child, used UI Retry, saved human title **Human reviewed Compose 2a2f432a** at review revision 2, restarted the API, reloaded the browser before apply, and retained the title. UI **Create world** then returned 200 and opened draft `d514c561-45c4-44db-9819-34c9bd69eee1`, revision 1. The actual database receipt and API draft title matched. No route mocking was used. Initial harness response-body reads raced navigation; final proof captures HTTP status and reads the durable receipt after navigation instead.

The final rollback run disabled both roles. Capabilities returned false, new submission returned 503, and queued job `e07b4095-0cb6-44a1-814f-961838248038` stayed at zero attempts while provider calls remained 26 across 3.5 seconds. Restoring both roles completed all four stages and increased calls to 30. This short observation proves the disabled execution gate; ordinary retention cadence is established by the separate accepted P2.9 tests, not inferred from this observation.

Four final screenshots were inspected in `C:/Users/chris/.codex/visualizations/2026/09/06/01a077cb-4d3b-7f31-95ee-a4d810fe53de/p2-10-compose-live-final`: `compose-human-review-saved.png`, `compose-human-review-after-refresh.png`, `compose-human-review-after-refresh-narrow.png`, and `compose-human-review-applied.png`. The title survives refresh; the final draft shows revision 1, no published versions and no campaigns. The 390px page has no horizontal overflow. Existing sticky stage/save bars overlap part of long full-page captures. A historical failed-child Retry control remains visible after its replacement succeeds; the proof used the intended failed-child retry before success. These visual observations are disclosed for final review.

## Comparable C0 measurements

Both measured runs used the same build-stage image, Linux Node 26.8.1, 2 vCPU and 4 GiB (`targetSatisfied: true`), seed `task-12-c0-worker-v1`, five warmups and thirty samples per C1/C2/C4. The [benchmark](../../scripts/benchmark-worker-concurrency.mjs) uses production worker scheduling with deterministic PostgreSQL jobs. The enabled fixture includes authoring and due cleanup lanes; it is not a live model workload.

| Story concurrency | Baseline / enabled throughput (jobs/s) | Baseline / enabled queue p95 (ms) | Baseline / enabled CV |
| ---: | ---: | ---: | ---: |
| 1 | 36.104 / 36.171 | 297.901 / 298.462 | 0.980% / 1.060% |
| 2 | 70.978 / 70.747 | 143.470 / 144.712 | 1.147% / 1.326% |
| 4 | 135.949 / 136.804 | 62.966 / 63.266 | 1.712% / 1.833% |

Throughput changes were +0.185%, -0.325% and +0.629%. These are one comparable batch each, not a general performance guarantee. Story peaks respected 1/2/4; optional lane peaks were one. At every concurrency point each authoring and cleanup lane completed 90 jobs and duplicate guards passed. Older Node 24 results were not used for comparison.

```powershell
docker build --target build --tag infinitequest-ai-assist-p2-benchmark:e7b4c064 .
docker run --rm --cpus 2 --memory 4g --memory-swap 4g --network host --env-file "$D/database.env" -e LOG_LEVEL=silent infinitequest-ai-assist-p2-benchmark:e7b4c064 node --import tsx scripts/benchmark-worker-concurrency.mjs --summary
docker run --rm --cpus 2 --memory 4g --memory-swap 4g --network host --env-file "$D/database.env" -e LOG_LEVEL=silent -e WORKER_BENCHMARK_INCLUDE_AUTHORING=true infinitequest-ai-assist-p2-benchmark:e7b4c064 node --import tsx scripts/benchmark-worker-concurrency.mjs --summary
```

Image manifest: `sha256:39d7198a6ed2d2a49a6a13e81c3492325fed9f1ba455c6aafc872b79637f1d0c`; logs `task-10-benchmark-baseline-c0.log`, `task-10-benchmark-authoring-c0.log`, and `task-10-benchmark-image-build-final.log`. Later test/document additions and comma formatting did not change measured runtime or benchmark behavior.

## Pending review and limits

The deferred P2.8 recovery edge remains open for whole-branch assessment: explicit review during an API-requested pending replacement can persist an empty selected subset. A later **Review available results** cannot restore the former key because selection remapping uses only retained IDs. The API supports validated regeneration, but this UI offers failed/recoverable retries and no stage picker. This is not claimed resolved by another click.

P2.10 fix round 1 scoped re-review and the whole-branch review remain pending. No production deployment, live external model validation, or live Swarm test is claimed. Windows secure-staging skips remain skips. Git global-ignore access and line-ending advisories did not fail the final checks. Patch 3 was not started.
