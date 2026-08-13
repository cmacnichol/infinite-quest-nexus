# Task 14e3b2b implementation report

Status: implementation complete; fresh correction review pending

Base commit: `067df155ef041faaa8e82bd225c24bb3df1b273d` (`Add private portable repository guards`)

## Scope delivered

- Replaced the durable filesystem repository's process-local candidate-authority map with persisted `0054` candidate rows. Only SHA-256 bearer digests are stored; a new repository instance can rehydrate the exact immutable descriptor from the raw bearer.
- Implemented the adapter-private candidate persistence, redemption, and attachment port. Attachment locks the operation and candidate, revalidates the exact owner/resource/purpose/operation/descriptor tuple, checks the full work-version/lease-id/lease-owner/lease-expiry claim against PostgreSQL time, requires the exact asset or derivative `filesystem_operation_id`, and advances the operation and candidate to attached in one caller transaction.
- Implemented adapter-private delivery-grant issue and one-time redemption against an attached candidate and finalized operation. Grants persist only bearer hashes and exact scope bindings, reject substituted scope or descriptor data, enforce database expiry, and cannot be replayed after redemption.
- Added forward migration `0056_private_filesystem_current_clock`, which replaces the `0054` candidate and delivery-grant trigger functions so every expiry transition uses advancing database wall-clock time. Its down migration restores the exact transaction-time behavior from `0054`.
- Changed restart recovery classification for asset originals and derivatives to use only their exact `0054` operation binding. Same-owner/source/path similarity no longer authorizes finalization.
- Preserved the existing legacy journal surface as a compatibility seam backed by persisted candidate rows; no route, worker, runtime composition, public barrel, import repository, or legacy helper was promoted to the private ports.

No `0053`, `0054`, or `0055` migration was changed. No b2c staged/export repository cleanup behavior was implemented.

## Tests and TDD evidence

- RED: four initial PostgreSQL candidate/grant tests failed because `persistCandidate` did not exist on the durable repository.
- GREEN: restart rehydration verifies hash-only candidate persistence and rejects wrong owner, resource, purpose, asset, and descriptor substitutions.
- Attachment tests cover missing versus exact original and derivative bindings, caller-transaction rollback, candidate lifecycle rollback, restart retry, stale work version, wrong lease ID/owner/expiry, database-time expiry, and attach-versus-reaper locking.
- Delivery tests cover hash-only grant persistence, restart redemption, exact scope/descriptor checks, one-time replay denial, and expired grants.
- Recovery tests prove exact original/derivative operation bindings finalize and same-path heuristics clean up instead.
- RED for projectmem issue #0523: a valid PostgreSQL-generated lease retained sub-millisecond precision that the JavaScript ISO claim cannot represent, so exact raw `timestamptz` equality returned `stale`.
- GREEN for #0523: the SQL fence compares the stored timestamp at the claim's canonical millisecond precision while retaining work version, lease ID, lease owner, and database-time freshness predicates. The focused regression passed.
- RED for review finding #0524: deterministic PostgreSQL lock-wait tests showed a candidate attachment returning `attached` and a delivery-grant redemption returning its descriptor after their authority expired while blocked. PostgreSQL `now()` remained fixed at transaction start.
- GREEN for #0524: repository eligibility helpers and terminal update fences use `clock_timestamp()` while preserving the canonical millisecond lease-identity comparison and all owner/resource/purpose/operation/descriptor bindings. Direct trigger coverage also proves an expired grant is rejected inside a transaction that began while the grant was fresh.
- The historical 14e2c post-commit image fixture was aligned with `0054` by setting and asserting its exact `filesystem_operation_id`; production recovery was not relaxed back to a path heuristic.

## Files

- `packages/database/src/durable-filesystem-repository.ts`
- `database/migrations/0056_private_filesystem_current_clock.sql`
- `tests/integration/durable-filesystem-repository.integration.test.ts`
- `tests/integration/generation-events.integration.test.ts`
- `tests/integration/migrations.integration.test.ts`
- `tests/integration/task-14e2c-adapter-matrix.integration.test.ts`
- `.superpowers/sdd/SLICE_0_1_IMPLEMENTATION_PLAN/task-14e3b2b-report.md`

## Verification

- Private b1/b2a contract matrices: 2 files, 9 tests passed.
- b2a migration plus b2b durable repository matrices: 2 files, 32 tests passed.
- Full durable filesystem repository matrix: 1 file, 30 tests passed.
- Full historical 14e2c adapter matrix: 1 file, 7 tests passed.
- Corrective repository and migration/down-up matrices: 4 files, 55 tests passed.
- Full `pnpm test`: 119 unit files / 1,402 tests and 37 integration files / 427 tests passed.
- `pnpm check`: passed, including repository boundary, data-safety, and TypeScript checks.
- `pnpm build`: passed, including legacy and next web production builds.
- `git diff --check`: passed.
- Complete scoped diff reviewed; pre-existing user changes remain unstaged and untouched.

## Follow-up boundary

- Task 14e3b2c owns private staged-input/export rehydration and atomic portable cleanup composition.
- Later tasks own finalized delivery resolution, secure filesystem/stream lifecycle integration, and production composition. This task does not switch consumers.
