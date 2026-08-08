# Task 14e2c implementation report

## Outcome

Task 14e2c composes the approved asset, portable-import, durable-filesystem,
and descriptor-anchored archive/filesystem adapters in test-only code. The
real-PostgreSQL matrix is GREEN. No route, worker, runtime illustration
binding, legacy authority, cross-role allowlist, or production consumer was
changed.

The #0503 correction keeps domain mutation and portable completion on the same
caller-owned PostgreSQL transaction. The legacy and Infinite Worlds import
services now expose additive `DatabaseClient`-bound cores while their existing
public wrappers preserve their prior pool-owned behavior. The adapter matrix
calls those cores only from `archive.commit(client)`, including a
transaction-bound world repository port for world imports. No route, worker,
runtime, or legacy consumer was cut over to the new cores.

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

The correction pass removed process-local staged/export cleanup authority.
Fresh adapter instances now hash the original opaque handle, resolve its
durable operation and immutable descriptor from PostgreSQL, and acquire a new
fenced cleanup claim before touching bytes. Publication errors are separated
at the domain-commit boundary: pre-commit failures clean provisional bytes,
while post-commit finalize/read/metadata failures preserve the attached
operation for restart recovery.

## Matrix evidence

The seven real-PostgreSQL adapter tests cover:

1. staging reservation before filesystem mutation, owner-isolated inspection,
   and cleanup;
2. nullable selection clear, metadata revision, original/derivative delivery,
   database-derived backfill owner, a two-worker claim race, heartbeat and
   expiry/requeue behavior, wrong/stale lease denial, and enum-only
   diagnostics;
3. all eight portable preview/commit variants: Campaign ZIP embedded and
   existing-world, Legacy Story, story text, Infinite Worlds, world JSON,
   CYOA, and world text. The matrix stages real bytes, invokes the compatible
   production parsers, calls the transaction-bound production import service
   cores inside portable commit, imports a real Campaign ZIP PNG, persists its
   assets, and verifies both turn bindings use remapped destination asset IDs.
   CYOA and world-text exercise their actual service branches with deterministic
   provider fakes rather than direct world conversion/import shortcuts. The
   matrix also covers foreign-handle denial, source provenance as non-authority,
   and idempotent replay;
4. supersede, expiry, abort, transaction rollback/retry, crash-reaper cleanup,
   and staged cleanup from a fresh adapter using the original opaque handle;
5. owner/scope-bound Campaign ZIP export, retrieval, and idempotent cleanup;
   cleanup is also proven after adapter restart with exact owner/resource
   scope fencing;
6. verified image metadata, owner-scoped locator redemption from a fresh
   adapter, rollback without reachable partial content, post-adoption crash
   recovery without an orphan, and post-domain-commit finalize failure that
   remains attached and becomes readable after a fresh reaper finalizes it;
7. #0503 transaction atomicity by injecting a failure after a real legacy
   import has inserted domain rows but before portable completion. The import,
   campaign, and portable completion roll back together, leaving the operation
   previewed; a retry then commits exactly once and exact replay performs no
   second domain mutation.

The durable repository regressions additionally prove the allowed change-token
transition, five denied non-token mismatches, immutable delivery persistence,
locator redemption after repository restart, and cleanup-path delivery
preference/deduplication.

## Files

- `packages/database/src/durable-filesystem-repository.ts`
- `packages/database/src/world-campaign-transaction.ts`
- `services/api/src/import-service.ts`
- `services/api/src/infinite-worlds-import-service.ts`
- `tests/integration/durable-filesystem-repository.integration.test.ts`
- `tests/helpers/memory-aware-services.ts`
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
- Correction RED: fresh staged/export cleanup initially failed with
  `archive_cleanup_required`, proving the old process-local authorization
  dependency.
- Correction RED: injected post-domain-commit finalize failure initially took
  the pre-commit cleanup path instead of preserving the attached operation.
- Correction GREEN: all six matrix tests exercise the actual parser/remapping,
  worker fencing, fresh-adapter reads, commit-point recovery, and restart
  cleanup requirements from #0497 through #0501.
- #0503 RED: a forced error after `importLegacyStory` domain mutation but
  before portable completion left one committed import row when zero was
  expected (focused matrix: 1 failed, 6 passed).
- #0503 GREEN: all eight variant domain imports now run under the portable
  commit client; the focused matrix passes 7/7, including rollback, successful
  retry, and exact replay proof. CYOA and world-text run the real
  `importInfiniteWorldsWithClient` service branches with deterministic provider
  responses.
- Affected import service unit suites: 4 files, 43/43 tests passed.
- Affected import and generation integration suites: 4 files, 38/38 tests
  passed.
- Focused durable repository plus adapter matrix: 2 files, 25/25 tests passed.
- Asset archive, asset repository, import repository, durable filesystem
  repository, and adapter matrix: 5 files, 64/64 tests passed.
- `pnpm check`: passed, including repository boundary and data-safety checks.
- `pnpm build`: passed.
- `pnpm test:unit`: passed (116 files, 1,349 tests).
- `pnpm test:integration`: passed (36 files, 409 tests).
- `git diff --check`: passed.

## Deliberately deferred

Task 14e3 still owns all production composition and consumer cutover, route and
worker changes, runtime illustration wiring, legacy-authority removal, and
cross-role allowlist changes. Issue #0446 remains open. This checkpoint adds no
new reaper policy beyond composing the approved durable lifecycle.
