# Task 14e3c — private asset-publication composition

## Delivered scope

- Added migration `0060_asset_publication_identities` with stable asset IDs, owner-scoped idempotency/fingerprint records, legacy seeding, legacy-asset identity creation, durable-operation identity fencing, and reversible safe-down checks.
- Added private publication command/result contracts and a snapshot-before-I/O boundary.
- Added a PostgreSQL asset publisher that validates owner/world/campaign/turn scope, publishes metadata and derivatives in the caller transaction, attaches exact durable filesystem operations, and returns only safe asset metadata.
- Added content-hash advisory locking to the private filesystem repository and secure content-addressed artifact preparation/finalization with identity-safe cleanup.
- Added the unconsumed private composition that combines the existing library, selection, metadata, delivery, B5 storage graph, and publisher. No server, archive, import, worker, illustration, or allowlist binding was introduced.
- Extended the private-storage boundary guard and added AST, real-PostgreSQL, and temporary-filesystem coverage.

## TDD and corrections

The first focused boundary test failed because `createAssetPublicationComposition` did not exist. The implementation was then added until the unit and integration suites passed.

Real PostgreSQL testing exposed five integration corrections:

1. The existing prewrite-target check permitted only operation-specific pending paths; the new content-addressed asset path is now explicitly authorized by migration `0060`.
2. Existing asset insertion triggers create a default library entry; the publisher uses conflict-safe insertion and then applies the requested provenance metadata.
3. Legacy/B5 asset creation needed a corresponding identity before durable reservation; migration `0060` installs a conflict-safe legacy identity trigger.
4. Retargeting the durable-operation FK to publication identities inadvertently removed the existing-assets deletion-retention fence. A focused RED regression showed that `DELETE FROM assets` resolved despite an authoritative durable asset operation. Migration `0060` now locks the identity during asset deletion and rejects such deletion with PostgreSQL `23503`; down removal is safe because the original FK is restored first.
5. Historical rollback rehearsals now include migration `0060` in both their expected inventories and rollback counts, preserving their intended pre-0055 and pre-0052 schema states.

## Verification

- `pnpm test:unit -- --reporter=dot --silent` — 126 files, 1,436 tests passed.
- `pnpm exec vitest run --silent --reporter=dot --config vitest.integration.config.ts tests/integration/task-14e3b5-storage-composition.integration.test.ts tests/integration/task-14e3c-asset-publication-identity.integration.test.ts tests/integration/task-14e3c-asset-publication.integration.test.ts` — real PostgreSQL, 3 files, 13 tests passed.
- `pnpm check` — passed (including repository/data boundary checks).
- `pnpm build` — passed.
- `pnpm test:integration` — passed with the configured PostgreSQL harness, including the shared migration rollback rehearsals.
- `git diff --check` — passed.

The integration tests cover idempotent replay/mismatch rejection, original plus derivative publication, metadata provenance, restart delivery, cross-owner content reuse, invalid scope cleanup, an attachment-finalization recovery fault, migration legacy/cross-owner/nonexistent/rollback behavior, and safe migration downgrade behavior.

## Post-review integrity corrections

The correction pass added five focused regressions and made the corresponding
durable invariants explicit:

1. Migration `0060` now has a reciprocal `BEFORE INSERT` durable-operation
   guard. A real two-client test holds the asset DELETE identity lock, verifies
   the operation insert is blocked, then verifies that it fails with `23503`
   after DELETE commits rather than becoming an orphan.
2. Immutable original and derivative byte snapshots are SHA-256 checked before
   identity reservation or filesystem preparation. A mismatch leaves the
   isolated owner with no identity, operation, or content-addressed target.
3. Idempotency fingerprints use a stable serialization of a fixed, null-
   normalized provenance shape; property order and undefined optional fields
   no longer turn semantic replays into mismatches.
4. Publication identities persist an internal `attached` lifecycle and the
   exact operation/claim finalization fences. A finalization fault leaves the
   safe result private. The same-key retry replays those fences, marks the
   identity published only after every operation is finalized, and then serves
   both original and thumbnail delivery.
5. Target-only asset prewrites never call `completeCleanup`. EEXIST/shared
   content and corrupt-target verification failures stay cleanup-pending until
   the prewrite repository can quarantine them; asset recovery matching now
   accepts asset records for that fail-closed quarantine path.
6. Attached identities now reconcile their exact operation set under the
   identity lock. Recovery-rotated work that is already finalized publishes
   directly; incomplete work uses freshly read, unexpired claim fences or
   remains recoverable without a stale-claim finalization attempt.
7. O_EXCL/fstat inode identity is distinct from durable node authority. Both
   asset and portable rollback paths require `recordPrewriteNode` to finish
   before identity deletion or cleanup completion; a recording fault retains
   the physical target as target-only cleanup-pending work for quarantine.
8. Publication now locks every durable asset-original and asset-derivative
   operation for the identity's owner and asset before reconciliation or
   completion. The actual set must exactly match the persisted pending
   finalization set, including operation purposes; an unexpected pending or
   cleanup operation leaves the identity recoverable and blocks delivery until
   it is safely resolved.

## Correction verification

- `pnpm check` — passed.
- `pnpm test` — passed.
- `pnpm vitest run --config vitest.integration.config.ts tests/integration/task-14e3c-asset-publication.integration.test.ts` — real PostgreSQL, 1 file, 9 tests passed.
- `pnpm build` — passed.
- `git diff --check` — passed.
