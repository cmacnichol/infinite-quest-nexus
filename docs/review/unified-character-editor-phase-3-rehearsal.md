# Phase 3 reader and archive rehearsal

Date: 2026-11-08. Baseline reader source: commit `7563876c76037899eb6d247fd5be118199d7d284`. All data was synthetic. PostgreSQL tests used the repository's isolated test container and per-file databases; the Linux test runner was an ephemeral container. No production data or services were used.

## Reader boundaries

`tests/integration/phase3-reader-rehearsal.integration.test.ts` built a pre-0129 database using the baseline migrations, seeded a world and campaign, closed it, and cloned that template separately for the settings, roster and cast cases. Each clone migrated through 0130. It loaded the baseline TypeScript contracts and roster resolver from the named commit and observed:

- The baseline settings parser accepts the restored, persisted old snapshot and rejects a subsequently persisted new snapshot containing the added keys. The separate `instance-settings-character-upgrade.integration.test.ts` upgraded a persisted local policy and seed, activated both keys, reloaded runtime settings, and preserved them through an unrelated edit.
- A newly inserted published-version record with one Playable and one Supporting entry is read by the baseline resolver as two selectable characters. This confirms the reader rollout boundary; the test inserted the version record directly and did not exercise the publishing UI.
- A real cast edit with a 2,001-character goal exported as v3, which the baseline portable-cast parser rejected. The cloned pre-feature campaign retained `firstAppearanceEligible: false` after migration.

`tests/integration/phase3-runtime-rehearsal.sh` additionally booted actual repository runtime processes inside an ephemeral Linux container. It applied baseline migrations through 0128 to a synthetic database, inserted a complete old-format world, and cloned that database before migration. On the first clone, the current migration role applied 0129–0131, then separate current API and worker processes started with both new gates explicitly false. `/health/ready` returned ready, `/api/v1/meta` reported `castPresets: false`, `/api/v1/worlds` returned the old world, and the worker logged both active settings and startup. The processes were stopped. On the second pre-boundary clone, baseline API and worker processes then started, the API returned ready and the same old world, and the worker logged active settings and startup. Both metadata responses identified version `0.1.0` with null build commit and date because these were source-mode processes. The script installed each source tree's locked dependencies and dropped its disposable databases on exit.

These are database-copy, source-reader and runtime boot checks, not an operator backup/restore drill or a production rollback. The cloned PostgreSQL database is not a complete recovery set with assets and secrets; no Compose or Swarm deployment was restarted. Reader deployment on every role, a full recovery-set restore and production activation remain separate release work.

## Archive portability

`campaign-cast-portability.integration.test.ts` exported and restored empty-cast campaigns through the real Campaign and System Archive repository import paths. Both families preserved `true` and `false`; a historical record without the marker restored `false`. Each destination had zero cast events. It also verified selected-character source-world provenance in both families, including historical records without it. The same suite exercised actual v3 cast portability and rejection of incompatible format declarations before mutation.

The final Linux run after migration 0131 and the selected-world archive changes passed **159 tests across 8 files, with no skips**, covering the reader rehearsal, settings upgrade, cast portability, Campaign Archive, System Archive, durable portable composition, campaign transfer and world library. A separate pre-0131 migration test passed: both legacy rows and rows whose old audit resembles native creation retained an unknown source world, preventing provenance inference from imported evidence. These runs included Linux secure-generated-staging cases unavailable in the Windows sandbox. A preceding combined run encountered `asset_publication_finalization_recoverable` in the concurrent same-command portable-import test; that case passed on an isolated repeat and in subsequent full runs. The intermittent initial failure is retained here as a verification limitation.

## Reproduction

Archive the baseline commit with `git archive 7563876c76037899eb6d247fd5be118199d7d284`, extract it into a Linux container with the project's dependencies, and set `IQ_PHASE3_BASELINE` to the extracted directory. Point `INFINITEQUEST_TEST_DATABASE_URL` at the isolated loopback test database and run:

```text
vitest run --config vitest.integration.config.ts tests/integration/phase3-reader-rehearsal.integration.test.ts tests/integration/instance-settings-character-upgrade.integration.test.ts tests/integration/selected-character-world-upgrade.integration.test.ts tests/integration/campaign-cast-portability.integration.test.ts tests/integration/campaign-archive.integration.test.ts tests/integration/system-archive.integration.test.ts tests/integration/task-14e3d-portable-composition.integration.test.ts tests/integration/campaign-transfer.integration.test.ts tests/integration/world-library.integration.test.ts
```

The rehearsal test skips when `IQ_PHASE3_BASELINE` is absent. It creates and drops its own template and three cloned databases; the baseline must be the pre-feature commit rather than a copy of the current worktree.

For the process check, mount that commit's `git archive` as `/baseline.tar`, mount the current worktree read-only as `/host`, and run `sh /host/tests/integration/phase3-runtime-rehearsal.sh` in a disposable Linux container with Linux dependencies and access to a disposable PostgreSQL instance. Supply its test password as `POSTGRES_PASSWORD`. The script shares neither application storage nor databases with production.
