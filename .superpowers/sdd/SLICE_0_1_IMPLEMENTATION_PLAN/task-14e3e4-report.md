# Task 14e3e4 implementation report

## Outcome

Implemented the additive private normalized portable import writer. The current
private portable composition now sends Campaign ZIP images and Legacy Story
inline/companion images through the Task e2 normalized batch publication seam.
The legacy 0060 `PrivateCallerTransactionAssetPublisher` path is no longer a
consumer of the private portable composition.

This remains a private checkpoint. No live route, default runtime entrypoint,
worker, public application barrel, API asset service, or legacy import service
was bound to the new coordinator. Production binding remains Task e3g.

## Durable authority and lifecycle

- Added migration `0066_portable_normalized_asset_publications.sql` with one
  operation/owner-scoped publication row per normalized asset plus immutable
  exact source, context, and reference-intent children.
- The e4 repository writes the complete 0066 child intent and reserves/binds
  the corresponding generic 0064 request in one PostgreSQL transaction. That
  transaction finishes before Task e2 may begin candidate-file work, so a
  request fingerprint is never the only crash-recovery authority.
- Persisted the closed success lifecycle `reservation_intent -> reserved ->
  committed_finalization_pending -> published` and the closed loser lifecycle
  `reservation_intent|reserved -> retirement_pending -> retired`.
- Bound each ordinal immutably to its operation, owner, import family,
  authority fingerprint, commit idempotency hash, normalized request
  fingerprint/idempotency hash, request ID, exact child snapshots, safe result,
  and finalization locator.
- Attachment validates exact source/context/reference cardinality and content
  against the 0064 request children in the same caller transaction as the
  domain writes; a mismatch rolls that complete transaction back. Retired rows
  cannot later acquire a request or success authority.
- Operation, work, and publication rows use one lock order. A filesystem
  lifecycle guard locks the normalized identity before permitting only the
  expected prepared/legacy asset and derivative transitions; terminal losers
  are durably reconciled after physical cleanup and after process restart.
- Accepted only `NULL` or `source-key-sha256:<64 lowercase hex>` source keys,
  and only `NULL` or `source-installation-sha256:<64 lowercase hex>` source
  installation identities. Raw paths, descriptors, URLs, credentials, and
  browser-supplied owner data do not enter retained authority.
- Added database validation for the closed safe-result shape, derivative kinds,
  exact five-key import provenance snapshot, exact child snapshots, operation
  state, owner scope, consuming commit identity, and immutable terminal state.

## Private composition and import cutover

- Added the private portable normalized contract, PostgreSQL repository, and
  runtime coordinator.
- Extended the Task e2 seam with an in-transaction request reservation entry
  point and one batch materialization/attachment callback. Exact portable
  intent is prewritten and bound before physical work; every normalized asset
  is then materialized before the caller atomically attaches request children
  and portable family mutations.
- Added neutral bounded image verification/normalization for PNG, JPEG, WebP,
  and GIF input, including signature/MIME/hash checks, metadata-first per-image
  and aggregate decoded-pixel limits, verified technical metadata, and
  deterministic 480-pixel WebP thumbnails.
- Campaign ZIP retains every grouped source asset ID, archive record, requested
  library snapshot, import provenance, context, and eligible reference.
- Legacy Story routes both decoded inline data images and injected companions
  through the same path. Companion names are retained only as opaque hashes;
  valid external URLs remain external, while unsafe absolute/traversal/URL/UNC
  aliases and malformed/count/size/hash optional image diagnostics are omitted
  without creating publication state. Non-Legacy artifacts remain strict.
- Filename and stem companion aliases are preserved only as independently
  hashed derived source records. Campaign archive paths are likewise retained
  only as hashes; non-UUID Legacy and Campaign source records use deterministic
  safe identities while original UUID source asset IDs retain their exact case.
- All seven image-free import families remain publication no-ops.
- Portable domain rows, normalized request children, and 0066 attachment state
  commit in one caller transaction. Rollback leaves only durable prewrite intent
  and prepared request authority, discards candidate files, and permits a fresh
  composition retry without partial import/domain state.
- Post-commit finalization is non-fatal for Legacy Story authority. Slow or
  failed finalization or duplicate-retirement cleanup retains recoverable 0066
  state and replays through a fresh composition without rerunning or revoking
  the committed domain mutation. Campaign ZIP remains strict.
- A fresh Legacy process that cannot reconstruct image requests can retire an
  earlier operation-scoped exact prewrite under the locked owner/import/
  fingerprint/commit scope. First-attempt requests still undergo the complete
  exact replay comparison; optional recovery cannot attach the frozen image
  authority or create partial requests/references.
- Same-owner canonical reuse continues to preserve the first library metadata;
  cross-owner identities remain distinct while sharing physical content safely.
  These invariants are exercised through the same e2 batch seam used by e4.

## Boundary enforcement

The executable storage inventory now requires:

- exactly one private e4 repository consumer: the e4 coordinator;
- exactly one e4 coordinator consumer: the current private portable
  composition;
- exactly two named e2 normalized seam consumers: illustration and portable
  normalized publication;
- zero production consumers of `createAssetPublicationComposition`;
- no e4 path to `transactionalPublisher`, `writeContentAddressed`,
  `persist*Image`, 0060 reserve/attach/finalize members, API asset service, or
  legacy portable import authority before the reviewed e2 seam;
- no private e4 contract exposure through public application barrels.

The real repository inventory passed for 782 candidate files.

No live route, default runtime composition, public application barrel, legacy
import service, or legacy storage authority was added or modified to adopt e4.

## Regression-test corrections

Several adversarial tests were tightened while resolving review findings. These
were test-harness corrections, not product-contract relaxations:

- the lifecycle race now places the competing abort after the filesystem
  lifecycle guard and uses a separate PostgreSQL pool, proving real lock
  serialization instead of pool starvation;
- the prewrite-order trigger now requires exact 0066 source, context, and
  reference rows before the first 0064 request insert;
- the late-duplicate fixture injects its duplicate only after the outer probe,
  then faults request reservation to prove the zero-handle optional path;
- the placeholder provenance fixture now has no source campaign, so a persisted
  `NULL` is distinguished from a real source campaign;
- the aggregate-pixel fixture asserts strict Campaign rejection at preview
  (before any operation or publication write) and optional Legacy completion;
- the shared-asset fixture covers archive-entry order independent mapping,
  duplicate source turn UUIDs by exact ordinal, and one source asset referenced
  from multiple turns;
- the committed Legacy late-duplicate fixture faults retirement after story
  authority commits, proves non-fatal completion with durable pending evidence,
  and proves fresh-composition reconciliation;
- the Legacy prewrite fixture starts with durable exact intent, then uses a
  fresh composition and an image whose metadata remains readable while
  normalization fails, proving image-free story completion with no request or
  reference residue;
- the retired-attachment test inserts a detached 0064 request directly, avoiding
  an unrelated generic-reservation precondition while still exercising the SQL
  terminal-state guard.

## Tests and verification

Task-focused boundary verification:

```text
node --check scripts/check-private-storage-boundaries.mjs && pnpm exec vitest run tests/unit/task-14e3b5-composition-boundaries.test.ts tests/unit/task-14e3e2-boundaries.test.ts tests/unit/task-14e3d-composition-boundaries.test.ts tests/unit/task-14e3e4-private-storage-boundaries.test.ts --maxWorkers=1 --reporter=dot
```

Result: 4 files passed, 27 tests passed in 1.07 seconds.

```text
node scripts/check-repository-boundaries.mjs
```

Result: repository boundary check passed for 782 candidate files.

Task e4 real PostgreSQL and temporary-filesystem suite:

```text
pnpm exec vitest run --config vitest.integration.config.ts tests/integration/task-14e3e4-portable-normalized-publication.integration.test.ts --maxWorkers=1
```

Result: 1 file passed, 38 tests passed in 33.24 seconds. Coverage includes exact
prewrite order; Campaign ZIP and Legacy Story inline/companion publication;
every image-free family; unsafe/malformed/external companion handling; exact
sources/contexts/references/provenance; aggregate pixel limits; rollback and
retry; archive-order-independent shared and duplicate-turn mappings; late
duplicate and terminal lifecycle races; strict Campaign cleanup failure;
non-fatal Legacy cleanup failure; prior-prewrite normalization failure; slow
Legacy finalization; fresh-composition recovery; same-owner metadata
immutability; cross-owner isolation; and shared-byte retention.

Adjacent e2 real PostgreSQL/temporary-filesystem verification:

```text
pnpm exec vitest run --config vitest.integration.config.ts tests/integration/task-14e3e2-normalized-publication-composition.integration.test.ts --maxWorkers=1 --reporter=dot
```

Result: 1 file passed, 11 tests passed in 9.87 seconds.

Focused normalizer and portable-adapter verification:

```text
pnpm exec vitest run tests/unit/task-14e3d-portable-composition.test.ts tests/unit/task-14e3e4-image-normalization.test.ts --maxWorkers=1 --reporter=dot
```

Result: 2 files passed, 17 tests passed in 1.79 seconds. This includes frozen
companion diagnostics, symlink rejection, strict/non-fatal family behavior,
format verification, and decoded-pixel limits.

Full unit verification under controlled concurrency:

```text
pnpm exec vitest run tests/unit --maxWorkers=1 --reporter=dot
```

Result: 136 files passed, 1,500 tests passed in 79.46 seconds.

Repository/type/data checks and production builds:

```text
pnpm check
pnpm build
```

Results: both passed. `pnpm check` included the 782-file repository-boundary and
data-safety inventories, package/web checks, and strict TypeScript. Both legacy
and replacement Vite production builds completed successfully.

## Baseline exclusions

The pre-task integration baseline had two existing failures in
`campaign-transfer-character-repository.integration.test.ts` and fourteen
existing failures in `task-14e3d-portable-composition.integration.test.ts`
(projectmem issues #0648 and #0649). The e3d cases encode the retired 0062
publisher behavior and include pre-normalization image fixtures. The full
repository integration suite is therefore not claimed green; Task-specific real
PostgreSQL coverage is green as recorded above.

## Files changed

- Added migration 0066, private e4 application contract, private e4 PostgreSQL
  repository, e4 coordinator, neutral image normalizer, focused unit/integration
  tests, and this report.
- Updated the e2 private contract/composition for batch attachment.
- Updated the private portable composition, private portable family contracts,
  and family mutation repository for normalized request-child/domain attachment.
- Updated executable storage boundaries and their existing regression fixtures
  to reflect the private e4 topology and retired 0060 consumer.
