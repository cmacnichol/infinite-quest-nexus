# Task 14e3b2c implementation report

Status: implementation complete; independent review pending

Base commit: `03be0db8ddda2989b0f2caa17e0f0a3e83df3cb7` (`Persist private filesystem authority`)

## Scope delivered

- Corrected the adapter-private portable repository contract so staged-input and export cleanup preparation require a caller-owned `DurableFilesystemTransactionContext` just like acknowledgement.
- Added a bearer-free recovery-cleanup entry point that accepts an exact database-derived `DurableFilesystemRecoveryRecord`. Recovery reconstructs staged row identity or the complete immutable export scope through the bound filesystem operation and never recovers, stores, or returns the original bearer.
- Replaced cleanup preparations that inherited interactive bearer identities with durable cleanup identities: portable kind, staged/artifact row ID, owner, exact filesystem operation, complete export scope where applicable, current claim, and the immutable descriptor list.
- Added typed `cleanup_required`, `already_cleaned`, `stale`, and `lease_lost` outcomes for normal cleanup contention and fencing results.
- Implemented staged and export restart rehydration in the named PostgreSQL import repository. Bearers are hashed before lookup, only live `staged`/`ready` records can rehydrate, and a fresh lease ID and work version are issued with a nonblank worker and positive integral lease duration.
- Implemented caller-transaction cleanup preparation and acknowledgement. Each path locks the filesystem operation before the portable row, acquires sorted physical-path advisory locks using the established durable-filesystem namespace, observes advancing PostgreSQL wall-clock time after blocking locks, revalidates the complete authority tuple, and transitions the journal operation and portable row together.
- Implemented recovery preparation only for exact paired `cleanup_pending` records returned through the durable journal recovery path. Physical cleanup failure leaves the paired state unacknowledged; after lease expiry, journal recovery can issue a fresh claim and the import repository can reconstruct the exact cleanup preparation without a bearer.
- Kept delivery and cleanup descriptors as distinct ordered immutable identities even when they refer to the same relative path.
- Used direct adapter-private imports for binders and port types. No public import barrel or consumer was expanded.

No migration, route, service, worker, runtime composition, finalized-delivery resolver, storage adapter, public barrel, or test-helper composition was changed. Existing compatibility retrieval methods remain unchanged for Task 14e3b4.

## Tests and TDD evidence

- RED contract evidence: the initial b2c contract run failed two tests because the old cleanup binders still accepted bearer-bearing rehydration objects instead of durable cleanup identities.
- GREEN contract evidence: the corrected b2a/b2c private contract suites pass and prove that cleanup preparations do not carry staged or export bearer material.
- RED PostgreSQL evidence: the initial four b2c integration tests failed because the named repository did not implement portable rehydration, preparation, acknowledgement, or recovery methods.
- GREEN PostgreSQL coverage proves caller-transaction enforcement; staged/export restart rehydration with hash-only bearer persistence; owner, bearer, operation, descriptor, claim, and full export-scope substitution denial; prepare and acknowledgement commit/rollback behavior; one concurrent interactive preparation winner; stale work and wrong-lease outcomes; deterministic expiry after a row-lock wait; distinct same-path delivery/cleanup descriptors; exact staged and export dual-row acknowledgement; and input validation for worker and lease duration.
- The recovery fixture follows the authorized lifecycle: interactive preparation creates the paired `cleanup_pending` state, physical cleanup is left unacknowledged, the lease expires, the journal recovery method returns an exact fresh recovery record, and bearer-free recovery preparation reconstructs the cleanup authority.
- RED for review finding #0525: after both portable and filesystem-operation authority expired, the journal issued an exact fresh recovery lease but staged and export recovery preparation returned `lease_lost`; the shared claim fence incorrectly treated elapsed resource authority as elapsed cleanup work authority.
- GREEN for #0525: active rehydration/preparation retains resource and lease expiry fencing, while exact paired `cleanup_pending`/`cleaned` recovery and acknowledgement use the fresh database-derived recovery lease as their temporal fence. Only the operation-expiry predicates on paired cleanup acknowledgement were removed; exact work, lease, owner, purpose, scope, lifecycle, and descriptor predicates remain.
- RED for review finding #0526: recovery preparation accepted the original raw portable scope preimage when its hash matched the persisted opaque scope, and staged/export acknowledgement likewise returned `cleaned` for that substituted operation identity.
- GREEN for #0526: recovery preparation and both acknowledgement paths require exact equality with the persisted opaque operation-scope hash. Interactive matching retains its established raw-to-hash compatibility without weakening recovery identity.
- GREEN for #0527: explicit staged/export recovery type predicates narrow the private branded preparation union for the new corrective tests without changing production contracts.
- Corrective real-PostgreSQL tests prove staged and export restart recovery after resource and old-lease expiry, full export-scope reconstruction, exact dual-row acknowledgement, active expired-authority denial, and recovery-specific raw-scope, owner, operation, purpose, work-version, lease, descriptor, and export-scope substitution denial.
- The historical Task 14e2c adapter matrix and the existing Task 14e3b2a migration isolation remain unchanged and pass against the latest schema.

## Files

- `packages/application/src/imports/private-portable-repository.ts`
- `packages/database/src/import-repository.ts`
- `tests/unit/task-14e3b2a-contracts.test.ts`
- `tests/unit/task-14e3b2c-contracts.test.ts`
- `tests/integration/task-14e3b2c-portable-repository.integration.test.ts`
- `.superpowers/sdd/SLICE_0_1_IMPLEMENTATION_PLAN/task-14e3b2c-report.md`

## Verification

- Focused b1/b2a/b2c private contract matrix: 3 files, 12 tests passed.
- Focused b2a migration, b2b durable repository, b2c portable repository, existing import repository, and historical 14e2c adapter matrix: 5 files, 75 tests passed.
- Focused b2c PostgreSQL matrix: 1 file, 15 tests passed.
- Full `pnpm test`: 120 unit files / 1,405 tests and 38 integration files / 442 tests passed.
- `pnpm check`: passed, including repository boundary, data-safety, package, web, and root TypeScript checks.
- `pnpm build`: passed, including legacy and next web production builds.
- `git diff --check`: passed.
- Complete scoped diff reviewed; pre-existing user changes remain unstaged and untouched.

## Follow-up boundary

- Keep Task 14e3b2c pending until independent review confirms the private contract, PostgreSQL lock order, database-time fences, and paired-transition coverage.
- Task 14e3b3 is next after all b2a-b2c checkpoints receive independent review. It owns finalized original/derivative delivery resolution through the private database-backed grant/redemption authority.
- Task 14e3b4 later owns the secure staging/export storage adapter, bounded private streaming lifecycle, production consumer replacement, and the recovery producer for expired finalized portable rows. Task 14e3b2c deliberately consumes exact cleanup-pending recovery records only.
