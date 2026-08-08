# Task 14e2b4 report — durable operation/reaper matrix

## Outcome

Implemented the PostgreSQL durable filesystem journal and recovery repository over migration 0053 without a schema change. The repository now owns reserve, publication preparation, caller-transaction attachment, post-commit finalization, rollback/recovery cleanup, locator redemption, lease-fenced reaper claims, and global physical-path retention.

Added deterministic transaction-scoped advisory locks to asset mutations and portable import preview/commit operations before their row-locking work. Physical cleanup paths are locked in sorted order before reference decisions.

No production route, runtime, worker, filesystem adapter, legacy client, cross-role composition, migration, 14e2c/14e3 work, or #0446 cutover was added.

## Implementation

- `packages/database/src/durable-filesystem-repository.ts`
  - Persists reservations and immutable cleanup/delivery descriptors before attachment.
  - Requires a caller-owned PostgreSQL transaction for `attach` and mints candidate/locator hashes only through the migration's allowed `reserved -> attached` transition.
  - Fences finalize and cleanup state changes by operation owner, work version, lease ID, lease owner, and live lease.
  - Claims expired nonterminal work with `FOR UPDATE SKIP LOCKED`, increments the work version, replaces the lease, and derives the recovered owner/scope from database state.
  - Classifies an attached operation as finalize work only when its delivery is globally referenced by an asset/derivative or its operation is referenced by staged/export state; otherwise it becomes cleanup work.
  - Acquires deterministic physical-path advisory locks in lexical order and filters cleanup descriptors against all owners' live `assets` and `asset_derivatives` paths.
  - Keeps cleanup retryable until the fenced database acknowledgement and returns idempotent terminal outcomes.
- `packages/database/src/asset-repository.ts`
  - Serializes each owner/mutation-kind/idempotency tuple with a deterministic advisory lock before asset, turn, world, or idempotency row locks.
  - Preserves existing owner/scope 404 behavior by validating domain rows after the advisory lock but before the idempotency insert.
- `packages/database/src/import-repository.ts`
  - Serializes live-preview supersession by owner/kind/content/destination.
  - Serializes commit idempotency by owner/kind/key and acquires all required advisory keys in sorted order before locking the preview/staged rows.
- `packages/database/src/index.ts`
  - Exports the new database repository.

## PostgreSQL behavior matrix

The new focused integration suite proves:

- reserve -> persisted publication preparation -> delivery completion -> caller-transaction attach -> domain commit -> finalize -> owner-scoped locator redemption;
- crash before publication, after publication, after rolled-back attach, after attach but before domain reference, and after attach plus domain commit;
- recovery drives cleanup candidates through `cleanup_pending -> cleaned` and committed references through `attached -> finalized`;
- a locked candidate is skipped while another eligible operation is claimed, and an old lease/work-version fence is rejected;
- recovery returns the database owner rather than caller-supplied ownership;
- foreign-owner original and derivative references retain shared physical paths while unreferenced temporary identities remain eligible for deletion;
- physical path advisory locks are acquired in lexical order, observed through a competing `pg_try_advisory_xact_lock` probe;
- cleanup remains retryable after the filesystem side effect but before database acknowledgement, and repeated acknowledgement returns `already_cleaned`.

Existing asset/import suites additionally prove that the exact deterministic advisory keys block concurrent mutation/preview work until released and that prior idempotency, ownership, and error contracts remain intact.

## TDD evidence

RED: the new durable integration suite initially failed because `packages/database/src/durable-filesystem-repository.ts` did not exist.

GREEN:

- Focused durable repository: 1 file, 6 tests passed.
- Focused asset repository: 1 file, 13 tests passed.
- Focused import repository: 1 file, 21 tests passed.
- Full unit suite: 116 files, 1,349 tests passed as part of isolated `pnpm test`.
- Full integration suite: 35 files, 389 tests passed.
- `pnpm check`: passed.
- `pnpm build`: passed.
- `git diff --check`: passed.

One earlier verification attempt ran unit, integration, check, and build concurrently; the unrelated Web compiler fixture exceeded its five-second unit timeout under contention. The required isolated `pnpm test` rerun passed completely, including both unit and integration phases.

## Review notes

- Migration 0053 deliberately persists only `operation_scope_hash` for portable work. Recovery uses that database value as the opaque recovered `operationScopeId`; it never needs or reconstructs the original caller token.
- Candidate plaintext is process-local authority until attachment; cleanup and delivery filesystem identity are persisted before publication/attachment so a restart can safely reap the operation without the candidate.
- Shared-path retention is global, while operation authorization and locator redemption remain owner-scoped.
