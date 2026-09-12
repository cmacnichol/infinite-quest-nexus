# Task 8 Linux portability verification

## Result

The current Story-only portability aggregate passed on Linux against the
dedicated PostgreSQL test container.

```text
Test Files  3 passed (3)
Tests       5 passed (5)
Duration    4.11s
```

The test image ran Node `26-bookworm-slim` with Vitest `4.1.11`. It connected
only to `infinitequest-story-only-test` over a temporary owned Docker network.
The runner translated the private dedicated-test URL to that container's
Docker hostname and port 5432 without writing or printing credentials. Its
per-file setup created and dropped `infinitequest_test_<uuid>` databases; it
did not reset the preserved base database at
`127.0.0.1:15439/infinitequest_storyonly_test`.

## Source boundary and commands

`e24554ba829a7d4f027e158fa8aa721801812e13` is the worktree's base `HEAD`,
not a clean source snapshot. Both Linux images were built from a dirty Task 8
worktree. The earlier PostgreSQL run's pre-build record captured that base
commit and the dirty status, but it did not capture a complete worktree hash;
this report does not infer one after the fact.

For the later unit run, the following boundary was captured before the build
and verified unchanged after it:

```text
branch: codex/story-only-campaigns
base HEAD: e24554ba829a7d4f027e158fa8aa721801812e13
tracked diff SHA-1: 0ba60129eeb190b50039f86cd099ca16a9257f6d
image ID: sha256:fdf7b58c1840c63013451dfa83f4d1476025435d69b2a432f209e4ff3a3bb3d0
```

The seven selected unit files had these SHA-256 values before and after the
image build:

| File | SHA-256 |
| --- | --- |
| `archive-io.test.ts` | `6ebf9000af3c39a622e99a4084658914d60bce154a8ffe1ad2386884ed49ebfd` |
| `asset-archive-service.test.ts` | `49f88322d458d1cc7382fcc41b50fbb33445ce9faa275600942c3978e733c5ce` |
| `ensure-local-credential-encryption-key.test.ts` | `177d2b2ad0c0ac5d2a3b9659288418d05a3cf426490d4875eb5d7bb107a0a2c9` |
| `portable-archive-filesystem-adapter.test.ts` | `9d07f94d74fab577bcb43aca2472d4963f36896ec26d4beebb6f29f771ec5f04` |
| `task-14e2ar-persisted-filesystem.test.ts` | `4938393022dcf0531c60a050d966f1c3050ca0f02d4f907ce97fb5b3fa04d028` |
| `task-14e3b4-secure-filesystem-adapter.test.ts` | `80ef4daaa5ce047df8f3a0a9249c5de56b2eae966ed531ab0c83f67568e41b73` |
| `task-14e3d-preview-session.test.ts` | `486977baea950dcf36f5388c68a320411cce77f3f8db54b955708faf2fa87953` |

The Linux image was built from this bounded worktree context:

```powershell
docker build --file tmp/story-only-test/task6-linux/Dockerfile --tag infinitequest-task8-linux:e24554ba .
docker build --file tmp/story-only-test/task6-linux/Dockerfile --tag infinitequest-task8-linux:unit-e24554ba .
```

The Docker ignore file admits only required manifests, database, packages,
services, application and script source required by the System Archive E2E
fixture, tests, and the specific ignored Linux runner configurations. It
excludes private test configuration, credentials, and other `tmp/` content. The
ignored runner configuration was expanded to select the portability suites.
The later campaign-archive regression correction changed one tracked integration
test only; it did not change production source.

The final container command was:

```text
node node_modules/vitest/vitest.mjs run --config tmp/story-only-test/task6-linux/vitest.config.ts
```

It selected and passed:

- `tests/integration/story-only-portability.integration.test.ts` — actual ZIP
  ingress, accepted provenance, dormant state, destination-owner isolation,
  and malformed-preview rejection.
- `tests/integration/story-only-system-portability.integration.test.ts` —
  System Archive owner remapping, canonical provenance, runtime-policy
  redaction, dormant state, rejection atomicity, and re-export.
- `tests/integration/story-only-campaign-copies.integration.test.ts` — branch
  and cross-world transfer preservation, provenance projection, and stale
  preview rejection.

This is current real Linux and PostgreSQL evidence for the listed portability
paths. This three-suite run did not itself verify browser behavior, a live
provider, deployment, or the full System Archive worker/API end-to-end
workflow; the later System Archive E2E counterpart below adds its bounded
built-client browser round trip.

## Linux-only filesystem unit coverage

The current Linux image ran these seven unit files with networking disabled,
no `TEST_DATABASE_URL`, no PostgreSQL attachment, and no integration setup or
migrations:

```text
node node_modules/vitest/vitest.mjs run --config tmp/story-only-test/task6-linux/unit-vitest.config.ts

Test Files  7 passed (7)
Tests       181 passed | 1 skipped (182)
Duration    3.33s
```

The tests cover archive I/O, asset archive staging, local credential-key
permissions, portable filesystem storage, persisted filesystem recovery,
secure filesystem adapter behavior, and preview sessions. This executes the
Linux secure-filesystem paths that were gated out in the Windows run. The sole
Linux skip is the inverse assertion that deliberately runs only on platforms
without secure Linux staging primitives; it is not a Windows compatibility
skip.

## Cleanup

The Linux integration runner container used `--rm` during the first run.
Afterward, the runner disconnected `infinitequest-story-only-test` and
removed the owned `infinitequest-task8-linux-e24554ba` network. The unit
container also used `--rm`, had networking disabled, and did not create a
network or database connection. The remaining aggregate image is removed in
the final cleanup recorded below. No shared runtime, base database, or
PostgreSQL container was reset, recreated, or removed.

## Isolated integration aggregate and secure-platform counterparts

The first Windows aggregate executed 92 integration files, continuing after
individual failures and retaining each raw stdout/stderr file only under the
ignored `tmp/story-only-test/task8-windows-integration-logs/` directory. Its
result checkpoint is likewise ignored. The aggregate intentionally excluded
`story-only-generation.integration.test.ts` while its author was editing it.

Its source boundary was base `HEAD`
`e24554ba829a7d4f027e158fa8aa721801812e13` with pre-run dirty tracked-diff
SHA-1 `8d2533d195aaaca1d01a75fff9965be09992e82d`. Concurrent Task 8 edits
continued during the aggregate, so this is not a clean immutable snapshot.

```text
Windows aggregate: 92 files executed; 86 exit 0; 6 exit 1; 1 authorized exclusion
```

The six original failures were retained as evidence rather than presented as a
passing aggregate:

| File | Original result | Classification and later evidence |
| --- | --- | --- |
| `campaign-archive.integration.test.ts` | 1 failed, 10 passed, 22 skipped | Obsolete test consumer passed a current v4 campaign archive payload to the legacy v1-v3 story import schema. The test now uses current ZIP preview/import. Windows focused rerun: 10 passed, 23 secure-platform skips; Linux current ZIP round-trip: 33 passed. |
| `migrations.integration.test.ts` | 3 failed, 24 passed | Expected migration snapshots omitted `0094_story_generation_policy`; the separate assigned test correction was reported green on Windows. |
| `play-loop-read-performance.integration.test.ts` | 1 failed, 1 passed | Benchmark sync-status returned non-200 with sanitized message `Could not establish the benchmark sync token.`; the separately assigned performance correction was reported green on Windows. |
| `source-campaign-portability.integration.test.ts` | 1 failed | Windows filesystem-platform guard; Linux direct rerun: 1 passed. |
| `story-only-portability.integration.test.ts` | 1 failed | Windows filesystem-platform guard; the earlier dedicated Linux PostgreSQL run above: 1 passed. |
| `task-14e2c-adapter-matrix.integration.test.ts` | Suite failed during migration setup; 1 passed, 6 skipped | Expected migration list omitted 0094. After the assigned correction, Windows was reported 1 passed, 6 skips; Linux direct rerun: 7 passed. |

The Windows platform skips were not treated as green evidence. A Linux Docker
counterpart ran the remaining 18 filesystem-required files on the dedicated
PostgreSQL container, with per-file isolated databases:

```text
Initial Linux counterpart: 18 files attempted, 17 passed and 1 failed;
303 tests passed and 2 failed (305 total). The failed System Archive E2E
file had 1 passed and 2 failures caused by missing image prerequisites.
Targeted System Archive E2E rerun after adding the ignored image prerequisite:
1 file, 3 tests passed, including the compiled-service/built-client browser round trip.
Combined selected counterpart total: 18 files, 305 tests passed.
```

Those 18 files were `gameplay`, `image-pipeline`, `import-memory`,
`system-archive-e2e`, `system-archive-resumable`, `system-archive`,
`task-14e3b5`, `task-14e3c`, `task-14e3d`, `task-14e3e2`,
`task-14e3e3-illustration-publication-matrix`,
`task-14e3e3-illustration-publication`, `task-14e3e4`, `task-14e3e5`,
`task-14e3e6`, `task-14e3e7`, `task-14e3f`, and
`world-campaign-route-application` integration suites. Together with the
Linux campaign archive (33), adapter matrix (7), source campaign portability
(1), and story-only portability (1) reruns, every Windows filesystem-platform
skip group or filesystem-guarded failure in this aggregate has actual Linux
coverage. These results span dirty concurrent Task 8 source boundaries and
targeted reruns; they are not a new single all-green aggregate claim.

The System Archive E2E prerequisite was added only to the ignored Linux image:
the Docker context now admits the required application and script sources and
installs Playwright Chromium. The successful run used a temporary owned Docker
network, attached only `infinitequest-story-only-test`, and removed that
network in `finally`.

## Final cleanup check

After the final Linux browser rerun, all temporary containers had `--rm` and
the final owned network was removed. The cleanup check below records removal
of only the owned Task 8 image tags and verifies no owned network remains;
`infinitequest-story-only-test` remains running. No base database or shared
runtime is reset or removed.

```text
removed owned images: infinitequest-task8-linux:campaignarchive-e24554ba,
                      infinitequest-task8-linux:platform-e24554ba
remaining owned Task 8 images: none
remaining owned Task 8 networks: none
dedicated PostgreSQL container running: true
```
