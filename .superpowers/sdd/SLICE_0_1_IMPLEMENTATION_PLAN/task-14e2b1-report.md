# Task 14e2b1 Completion Report

## Outcome

Task 14e2b1 is complete on base
`4d5eaa19258d27bd36c00381f609f57974599193`.

Implementation commit:

- `7dc7db4c44a7ca74941cf5e481ada23ccae3f027`
  (`feat(database): persist asset portable operations`).

Migration `0053_durable_asset_portable_operations` adds the durable,
owner-scoped persistence substrate required by the already-frozen 14e1R2 and
14e2aR contracts. It does not add repositories, adapters, routes, worker
behavior, runtime composition, or a production cutover.

## Scope delivered

- Added owner-scoped, lease-fenced `asset_metadata_backfill_jobs` with an
  indexed claim/recovery path and allowlisted asset/filesystem diagnostics.
- Added discriminated metadata and nullable asset-selection mutation
  idempotency records. SHA-256 idempotency hashes and request fingerprints are
  constrained and unique within owner and operation kind.
- Added durable filesystem operation journals for asset original/derivative,
  portable staging, and portable export purposes. Operation, candidate, and
  locator capabilities are represented only by constrained SHA-256 hashes.
- Added immutable filesystem descriptors with relative-path, identity, content
  hash, and length checks plus a trigger that rejects descriptor updates.
- Added owner-scoped staged inputs, all seven portable import families, exact
  destination discrimination, safe diagnostic arrays, commit idempotency,
  result retrieval, and expiry/supersession indexes.
- Added owner-scoped campaign-ZIP/world-JSON export artifacts with hashed
  retrieval capabilities, exact world/version/campaign references, and an
  indexed expiry/cleanup path.
- Added an owner-scoped composite reference from a committed portable operation
  to the existing `imports` row. Existing `(owner_user_id, source_hash)`
  semantics and import IDs are unchanged.
- Added reversible schema teardown for migration regression coverage. The
  intentional historical-error sanitization is not reversed by the down path.

## Legacy-data and rollout policy

The up migration executes through the existing advisory-locked,
single-transaction runner. New durable tables and indexes are additive.
Compatibility columns on `archive_previews` use constant defaults; their
constraints are installed `NOT VALID`, which enforces new writes without a
validation scan of legacy rows.

Legacy archive previews remain redeemable by the current service until their
existing `expires_at`. They are marked `legacy_path_v1` with the explicit
`serve_until_expiry_then_identity_cleanup` policy. The migration neither
invalidates them nor silently promotes their path-only authority. A future
secure consumer may bind a preview to an explicit owner-scoped staged input;
otherwise the existing supersede/expiry cleanup lifecycle drains it.

Every incomplete asset receives at most one durable backfill job. Historical
raw `technical_metadata.backfillError` values are replaced with the generic
`asset_metadata_unavailable` code, and their seeded jobs are recoverable with
the same allowlisted code. The legacy key remains present so the currently
composed unsafe backfill loop does not begin an unjournaled retry before the
later cutover. Existing assets do not receive filesystem operation rows and
therefore cannot become unjournaled reaper candidates.

The migration does not modify asset IDs, import IDs or source hashes, asset
derivatives, world cover references, image-job asset references, or segmented
turn illustration asset references.

## Test-driven evidence

RED was observed before the migration existed:

- The migration integration suite had three expected failures: the durable
  tables were absent, legacy archive security-state columns were absent, and
  the `0053` migration file did not exist.
- The first GREEN attempt reached 10/11 migration tests. Its remaining failure
  exposed an over-broad token-column assertion that treated a filesystem
  identity change token as a bearer capability.
- The first broad integration run exposed that the existing notification
  down/up test assumed `0052` would forever remain the newest migration. Adding
  an explicit `0053` down section and moving that destructive regression into
  its own temporary database removed the ordering assumption and cross-file
  schema race.
- A subsequent test run proved that SQL files with a down section require the
  explicit `-- Up Migration` marker; adding the marker restored application of
  the new schema.

Final verification:

- `pnpm exec vitest run --config vitest.integration.config.ts tests/integration/migrations.integration.test.ts`
  - 1 file passed, 11 tests passed.
- `pnpm exec vitest run --config vitest.integration.config.ts tests/integration/migrations.integration.test.ts tests/integration/generation-events.integration.test.ts`
  - 2 files passed, 15 tests passed.
- `pnpm test`
  - 116 unit files passed, 1,349 unit tests passed.
  - 32 integration files passed, 347 integration tests passed.
- `pnpm check`
  - repository boundary/data checks and all TypeScript/web checks passed.
- `pnpm build`
  - TypeScript, legacy web, and next web builds passed.
- `git diff --cached --check`
  - passed for the exact implementation commit.
- `pjm precheck`
  - passed for the exact staged implementation/test set.

Migration coverage proves schema presence, non-null owner scope, hashed-only
capability persistence, lifecycle/diagnostic constraints, claim and expiry
indexes, owner-scoped import references, whole-migration rollback on an injected
failure, rerun idempotency, safe diagnostic scrubbing and job seeding, absence
of legacy filesystem journal rows, legacy preview continuity, and preservation
of import/source-hash and specialized asset-table semantics.

## Files changed

- `database/migrations/0053_durable_asset_portable_operations.sql`
- `tests/integration/migrations.integration.test.ts`
- `tests/integration/generation-events.integration.test.ts`
- `.superpowers/sdd/SLICE_0_1_IMPLEMENTATION_PLAN/task-14e2b1-report.md`

## Deferred work and remaining concerns

- Raw opaque token generation is deliberately not implemented here. The 14e2b
  repositories must generate cryptographically random tokens and persist only
  the SHA-256 fields this schema exposes.
- 14e2b2 owns asset library, selection, delivery, and fenced backfill
  repositories.
- 14e2b3 owns portable staged/preview/import/export repositories, exactly-once
  consumption, and provenance non-authority behavior.
- 14e2b4 owns advisory locks, physical-path locks, `SKIP LOCKED` reapers,
  cross-owner physical retention, and crash-point recovery.
- 14e2c owns additive test-only composition; 14e3 owns production API/worker
  cutover and legacy removal.
- Projectmem issue `#0446` remains open because this checkpoint intentionally
  does not wire the live worker or replace its current production code path.

## Correction round 1

Reviewer findings `#0475` through `#0480` were corrected without expanding
this checkpoint into repository implementation or production cutover work.

- Durable filesystem operations now reference assets through
  `(asset_id, owner_user_id)` with `ON DELETE RESTRICT`. PostgreSQL regressions
  reject both cross-owner and nonexistent asset authority and prove that an
  asset with a live operation cannot be deleted accidentally.
- Operation authority is write-once for owner, operation token, purpose,
  resource kind, asset, portable scope, and attached candidate/locator
  identities. Lifecycle, lease, work-version, diagnostic, and timestamp fields
  remain mutable. Descriptor evidence is append-only: both update and delete
  are rejected.
- Generated constant-purpose columns bind staged inputs to
  `portable_staging` operations and export artifacts to `portable_export`
  operations through owner-scoped composite foreign keys.
- Portable import destinations validate the exact owner/world/world-version
  tuple. Export artifacts validate either an exact owner/world/world-version
  tuple or the exact campaign-pinned version and its world. Validation locks
  referenced parents, and parent-update guards preserve those relationships
  under concurrent writes.
- The blocking `UNIQUE (id, owner_user_id)` alteration on the existing
  `imports` table was removed. Portable operations retain the normal foreign
  key to `imports(id)` and enforce owner equality with a locked trigger check;
  a parent-update guard prevents later owner drift. No concurrent index build
  is attempted inside the migration transaction.
- Pre-`0053` path-only archive previews are labeled
  `retain_until_secure_cleanup`. Live cleanup expires them and preserves the
  pending marker but refuses to unlink their path because it has no persisted
  filesystem identity. A PostgreSQL/filesystem regression replaces the
  original staged file before drain and proves repeated cleanup never deletes
  the replacement.

The compatibility default for archive previews created by the still-composed
legacy service remains `live_path_cleanup_compatibility`. That narrow bridge is
not described as identity-safe and remains deferred to the secure staging
cutover. Issue `#0446` therefore remains open.

Correction TDD evidence:

- Initial focused RED run: 2 files, 38 passed and 4 failed. The failures
  identified the blocking import constraint, thirteen missing PostgreSQL
  authority/relationship rejections, the unsafe legacy drain policy, and the
  absent replacement-file retention contract.
- `pnpm exec vitest run --config vitest.integration.config.ts tests/integration/migrations.integration.test.ts tests/integration/campaign-archive.integration.test.ts`
  - 2 files passed, 42 tests passed.
- `pnpm test`
  - 116 unit files passed, 1,349 unit tests passed.
  - 32 integration files passed, 349 integration tests passed.
- `pnpm check`
  - repository boundary/data checks and all TypeScript/web checks passed.
- `pnpm build`
  - TypeScript, legacy web, and next web builds passed.

Correction files:

- `database/migrations/0053_durable_asset_portable_operations.sql`
- `services/api/src/campaign-archive-service.ts`
- `tests/integration/migrations.integration.test.ts`
- `tests/integration/campaign-archive.integration.test.ts`
- `.superpowers/sdd/SLICE_0_1_IMPLEMENTATION_PLAN/task-14e2b1-report.md`
