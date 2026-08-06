# Task 14e2b2 Completion Report

## Outcome

Task 14e2b2 is complete on base
`645fcbd7989d2ee4c4fcb9a4861c77265c0e8597`.

The new PostgreSQL asset repositories implement the frozen application asset
ports for library queries, metadata mutation, nullable selection mutation,
safe delivery, private storage-locator redemption, and fenced metadata
backfill work. The implementation is additive and is not composed into any
production API, worker, or runtime path.

## Scope delivered

- Added `createPostgresAssetRepositories(pool)`, which returns the complete
  `AssetApplicationDependencies` repository set without changing the public
  application contracts.
- Added full owner-scoped asset-library query parity for search, scope,
  creator, world/version/campaign, origin, tags, entities, locations,
  provider/model, review/reuse, eligibility, favorite/archive, MIME, aspect,
  date, sort, cursor, projection, context, and origin/review/reuse/tag facets.
- Bound cursor redemption to a canonical filter fingerprint so a cursor cannot
  be replayed against a different owner-visible query.
- Added optimistic metadata revision updates with durable SHA-256 idempotency
  keys and request fingerprints. Same-key/same-request calls replay the stored
  result; same-key/different-request calls fail safely.
- Added authorized turn and world selection set/clear operations. `null` is an
  explicit mutation, and the exact owner plus campaign/world/turn relationship
  is locked and validated before mutation.
- Added path-free original and thumbnail delivery descriptors. Thumbnail
  requests choose the newest stored thumbnail record and safely fall back to
  the original when no thumbnail exists.
- Added the adapter-private
  `createPostgresAssetStorageLocatorRedemptionRepository(pool)` for
  original/derivative locator redemption. Raw bearer tokens are hashed before
  lookup and must match owner, asset, resource kind, finalized lifecycle, and
  immutable descriptor evidence.
- Added durable backfill claim via `FOR UPDATE SKIP LOCKED`, database-derived
  owner identity, lease ID/owner/work-version/expiry fencing, heartbeat,
  safe-diagnostic requeue, expiry reclaim, and caller-transaction completion.
- Mapped unexpected PostgreSQL failures to a stable safe repository diagnostic;
  raw SQL, paths, driver messages, and caught exception text do not cross the
  adapter boundary.

## Ownership and durability invariants

Every asset read and mutation includes `owner_user_id`. Contextual selection
operations additionally validate the exact campaign/world/turn relationship;
asset choices are independently checked against the same owner. No caller can
provide an owner to a backfill claim: the claimed row is the sole source of
owner identity returned to worker code.

Metadata and selection idempotency records are written in the same transaction
as their domain mutation. Optimistic revision conflicts are reported without
overwriting the winning update. Backfill completion accepts a caller-owned
PostgreSQL client, preserves the surrounding transaction boundary, and rejects
expired, reclaimed, or stale lease fences.

The repositories do not create physical-retention or reaper authority. Global
cross-owner physical-content retention, physical-path locks, cleanup claims,
and crash recovery remain owned by 14e2b4.

## Test-driven evidence

RED was observed before implementation:

- `pnpm exec vitest run --config vitest.integration.config.ts tests/integration/asset-repository.integration.test.ts`
  - failed before test collection because
    `packages/database/src/asset-repository.js` did not exist.

Final focused verification:

- `pnpm exec vitest run --config vitest.integration.config.ts tests/integration/asset-repository.integration.test.ts`
  - 1 file passed, 9 tests passed.
- `pnpm exec vitest run tests/unit/assets-application.test.ts tests/unit/task-14e1r2-contracts.test.ts`
  - 2 files passed, 23 tests passed.

The real-PostgreSQL repository suite proves:

- complete list/filter/sort/cursor projection and facet parity;
- metadata same-key replay, mismatch rejection, and concurrent revision
  writers with exactly one winner;
- turn/world set, replay, mismatch, and explicit nullable clear behavior;
- cross-owner read, list, delivery, metadata, and selection denial;
- original and thumbnail descriptors plus derivative fallback;
- finalized original/derivative private locator redemption and foreign-owner
  or foreign-asset denial;
- two workers claiming distinct jobs through `SKIP LOCKED`, with owner identity
  taken from each claimed row;
- heartbeat, expiry, reclaim, new work-version fencing, stale old-lease denial,
  requeue behavior, and allowlisted diagnostic persistence;
- completion in a caller-owned transaction, idempotent already-current
  completion, and stale completion denial.

Full repository verification:

- `pnpm check`
  - repository checks and all TypeScript/web checks passed.
- `pnpm build`
  - TypeScript, legacy web, and Next web builds passed.
- `pnpm test:unit`
  - 116 files passed, 1,349 tests passed.
- `pnpm test:integration`
  - 33 files passed, 358 tests passed in 92.84 seconds.

## Files changed

- `packages/database/src/asset-repository.ts`
- `packages/database/src/index.ts`
- `tests/integration/asset-repository.integration.test.ts`
- `.superpowers/sdd/SLICE_0_1_IMPLEMENTATION_PLAN/task-14e2b2-report.md`

## Deferred work and remaining concerns

- 14e2b3 owns portable staged-input, preview, import, and export repositories.
- 14e2b4 owns global physical-content retention, reaper locking, cleanup claims,
  and crash-point recovery. This checkpoint deliberately preserves that scope.
- 14e2c owns additive test-only composition; 14e3 owns API/worker production
  cutover and legacy-service removal.
- No route, service, worker, runtime composition, cross-role allowlist,
  migration, or `#0446` state changed in this checkpoint.
