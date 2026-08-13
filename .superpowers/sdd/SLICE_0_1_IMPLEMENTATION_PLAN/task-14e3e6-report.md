# Task 14e3e6 — private durable filesystem recovery

## Delivered

- Added exact PostgreSQL recovery-claim heartbeats and propagated them through
  every private lifecycle fake and legacy test adapter.
- Added an unbound private recovery composition that claims database-derived
  asset and portable-expiry work, renews the current fenced claim before every
  terminal database action, and never accepts owner, path, descriptor, or
  bearer input from a caller.
- Portable recovery now verifies that every current claim remains in the
  original claimant lineage, checks it before every physical deletion, and
  re-prepares the cleanup acknowledgement with the latest heartbeat claim.
  A stale worker therefore cannot borrow a foreign rotated claim to unlink or
  acknowledge a portable artifact.
- Added identity-safe physical finalization, cleanup-pending persistence,
  enum-safe diagnostics, target-only quarantining, and global reference-aware
  deletion retention.
- Reconciles exact e4 normalized portable finalization and retirement work and
  e5 metadata publication only after the corresponding durable operation is
  terminal. Portable retirement is evaluated after cleanup, so a paired
  original/derivative set cannot be retired ahead of its second cleanup.
- Kept the graph private and unbound: no API route, worker scheduler, or live
  runtime binding was added.

## Verification

- `pnpm vitest run tests/unit/task-14e3e6-recovery-claim.test.ts tests/unit/task-14e3b4-secure-filesystem-adapter.test.ts tests/unit/task-14e3b5-composition-boundaries.test.ts` — 22 tests passed.
- Controlled single-worker e6 PostgreSQL/temp-filesystem suite — 11 tests
  passed on each of three consecutive runs. This includes a one-second
  portable lease blocked past expiry: heartbeat renewal permits completion and
  a rotated foreign claim prevents the stale worker from deleting or
  acknowledging.
- Focused real PostgreSQL/temp-filesystem e6 matrix — 11 tests passed:
  rotated/foreign claim fence, slow renewable heartbeat, target quarantine,
  attached finalization/restart, e5 reconciliation, cross-owner retention,
  paired original/derivative expiry, concurrent duplicate prevention, and
  cleanup fault/retry/restart with safe diagnostics.
- e4 real PostgreSQL bridge proves fresh e6 cleanup retires a 0066 mapping
  only after both exact paired filesystem operations are cleaned.
- The clean serial b5/e4/e5/e6 integration matrix passed 67 tests across four
  files. The prior 66/67 result was test-state leakage: two heartbeat-only
  cases left cleanup-pending records with short leases that became eligible for
  later `limit: 1` cases. Their leases are now 30 seconds, preserving the same
  heartbeat assertions while preventing aggregate contamination.
- `pnpm check`, `pnpm build`, `git diff --check`, and the private-storage
  boundary checker passed.

## Scope boundary

Task 14e3e7 remains responsible for scheduling/binding recovery in the worker.
