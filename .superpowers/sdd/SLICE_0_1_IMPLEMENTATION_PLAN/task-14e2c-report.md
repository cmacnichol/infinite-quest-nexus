# Task 14e2c implementation report

## Outcome

Task 14e2c composes the approved asset, portable-import, durable-filesystem,
and descriptor-anchored archive/filesystem adapters in test-only code. The
real-PostgreSQL matrix is GREEN. No route, worker, runtime illustration
binding, legacy authority, cross-role allowlist, or production consumer was
changed.

The matrix exposed #0496: Linux link/unlink adoption legitimately changes the
filesystem change token after provisional cleanup evidence is persisted. The
approved narrow repository correction now:

- permits only that provisional-to-delivery change-token transition while
  retaining exact operation, candidate, path, device, inode, hash, and length
  checks;
- persists the immutable actual delivery descriptor; and
- prefers the actual delivery descriptor during cleanup, uses provisional
  cleanup evidence only for paths without delivery evidence, and deduplicates
  paths before cleanup.

## Composition graph

`createTask14e2cAdapters` composes:

- `createAssetApplication(createPostgresAssetRepositories(pool))`;
- `createPostgresImportRepository(pool)`;
- `createPostgresDurableFilesystemRepository(pool)`; and
- `createPortableArchiveFilesystemAdapter(...)` with persistence callbacks
  backed by the two PostgreSQL repositories.

The helper is test-only. It reserves durable operations before mutation,
attaches candidates in caller transactions, registers staged/export/domain
records, finalizes after commit, and drives fenced cleanup/recovery after
rollback or simulated process loss.

## Matrix evidence

The six real-PostgreSQL adapter tests cover:

1. staging reservation before filesystem mutation, owner-isolated inspection,
   and cleanup;
2. nullable selection clear, metadata revision, original/derivative delivery,
   database-derived backfill owner, lease fencing, and enum-only diagnostics;
3. all eight portable preview/commit variants: Campaign ZIP embedded and
   existing-world, Legacy Story, story text, Infinite Worlds, world JSON,
   CYOA, and world text, including foreign-handle denial, source provenance as
   non-authority, and idempotent replay;
4. supersede, expiry, abort, transaction rollback/retry, and crash-reaper
   cleanup;
5. owner/scope-bound Campaign ZIP export, retrieval, and idempotent cleanup;
6. verified image metadata, owner-scoped locator redemption, rollback without
   reachable partial content, and post-adoption crash recovery without an
   orphan.

The durable repository regressions additionally prove the allowed change-token
transition, five denied non-token mismatches, immutable delivery persistence,
locator redemption after repository restart, and cleanup-path delivery
preference/deduplication.

## Files

- `packages/database/src/durable-filesystem-repository.ts`
- `tests/integration/durable-filesystem-repository.integration.test.ts`
- `tests/helpers/task-14e2c-adapters.ts`
- `tests/integration/task-14e2c-adapter-matrix.integration.test.ts`
- `.superpowers/sdd/SLICE_0_1_IMPLEMENTATION_PLAN/task-14e2c-report.md`

## Verification

- Baseline approved repository suites before implementation: 3 files, 46/46
  tests passed.
- Initial RED: the new matrix failed because the test-only composition module
  did not exist.
- #0496 RED: the real image composition failed with
  `durable_filesystem_candidate_mismatch` after link/unlink changed ctime.
- Focused durable repository plus adapter matrix: 2 files, 25/25 tests passed.
- Asset/import/durable repository plus adapter matrix: 4 files, 59/59 tests
  passed.
- `pnpm check`: passed, including repository boundary and data-safety checks.
- `pnpm build`: passed.
- `pnpm test:unit`: passed (1,349 tests, 2 expected skips).
- `pnpm test:integration`: passed (408 tests).
- `git diff --check`: passed.

## Deliberately deferred

Task 14e3 still owns all production composition and consumer cutover, route and
worker changes, runtime illustration wiring, legacy-authority removal, and
cross-role allowlist changes. Issue #0446 remains open. This checkpoint adds no
new reaper policy beyond composing the approved durable lifecycle.
