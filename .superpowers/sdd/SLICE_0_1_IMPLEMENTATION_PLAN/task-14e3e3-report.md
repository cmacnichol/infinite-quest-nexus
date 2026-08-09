## Task 14e3e3 report — private illustration publication coordinator

### Outcome

- Added an additive, private, currently unbound illustration publication
  coordinator. The live worker composition, API routes, provider bindings,
  legacy `completePortImageJob` adapter, public barrels, and production
  allowlists remain unchanged; production cutover remains Task 14e3g.
- Added migration 0065, which durably maps each image job and variant ordinal
  to its owner-scoped 0064 normalized request, opaque finalization locator, and
  safe result. Database constraints and triggers enforce provenance,
  uniqueness, immutability, non-deletion, and promotion only after the 0064
  request is published.
- Added private application contracts, a PostgreSQL repository, and a runtime
  composition that consumes only Task 14e3e2's normalized publication seam.
  Repository-wide graph guards reject API asset implementations, legacy image
  writers, `completePortImageJob`, and any unauthorized consumer of the new
  private repository.

### Publication behavior

- Image-job authority is loaded from database-derived owner, lease, status,
  generation revision, and active-parent scope. Caller-supplied identity is
  never used as ownership authority.
- Every artifact is downloaded and validated before reservation: bounded byte
  count, PNG/JPEG/WebP signature and declared MIME agreement, bounded Sharp
  decode, verified format/dimensions/pages/orientation, raw SHA-256, and a
  deterministic 480-pixel-edge WebP thumbnail.
- All variants are normalized and reserved before the caller-owned transaction.
  Batch reservation uses one deduplicated, ordered shared-content lock group so
  variants and concurrent owners cannot deadlock on a shared derivative.
- The caller transaction rechecks the parent and lease using current wall-clock
  time, attaches every exact reservation, records immutable mappings and
  generation contexts/references, completes the image job, and updates
  world/turn/segment/resolution state plus cost data atomically. A no-op or
  rollback discards only the exact prepared requests.
- Post-commit finalization uses only opaque e2 handles. A finalization fault is
  recorded as committed recovery work; restart recovery does not download or
  rerun the provider. Concurrent exact recovery is idempotent, while locator or
  result mismatches fail closed.
- Provider-status, identity, download, signature, decode, MIME, artifact-count,
  and reported-cost failures occur before authoritative narration or domain
  state can be changed.

### Files

- `database/migrations/0065_illustration_asset_publications.sql`
- `packages/application/src/illustration/private-illustration-asset-publication.ts`
- `packages/database/src/illustration-asset-publication-repository.ts`
- `services/runtime/src/illustration-asset-publication-composition.ts`
- `packages/application/src/assets/private-normalized-asset-publication.ts`
- `services/runtime/src/normalized-asset-publication-composition.ts`
- `scripts/check-private-storage-boundaries.mjs`
- Focused unit, migration, e1/e2 regression, and e3 PostgreSQL/temp-filesystem
  tests under `tests/unit` and `tests/integration`.

### TDD and review corrections

The red/green cycles covered invalid result-count prevalidation, shared-
thumbnail batch-lock deadlock, attached-request promotion, migration downgrade
assumptions, transaction-start lease time, concurrent finalization replay,
mapping deletion, the private repository's sole-consumer boundary, and
non-completed provider results. Final hardening added a two-variant rollback
that faults only after variant 0 attaches and a second lease regression that
expires during mapping attachment before the final completion fence.

An independent final reviewer verified the raw implementation diff and focused
tests. After the follow-up hardening, the reviewer reported no remaining
Critical or Important concerns.

### Verification

- `pnpm check` — passed; repository boundary and data-safety inventories each
  checked 773 candidate files.
- `pnpm build` — passed.
- `pnpm test:unit` — 134 files, 1,492 tests passed.
- Focused e3/adjacent unit matrix — 5 files, 23 tests passed.
- Focused e1/e2/e3 real-PostgreSQL and temporary-filesystem matrix — 4 files,
  23 tests passed.
- Full e3 publication matrix — 8 tests passed.
- Migration integration suite — 14 tests passed.
- `git diff --check` — passed.

The known-unreliable broad integration harness was not used or claimed as a
passing gate. Verification used only the focused real-PostgreSQL suites named
above.

## Correction round 1/5

- 0065 now treats illustration provenance as a closed typed JSON shape: missing,
  JSON-null, or mistyped `kind`, `imageJobId`, and `variantIndex` fail closed
  using explicit JSON type checks and `IS DISTINCT FROM` comparisons.
- Mapping `safe_result` is now a closed schema, including closed derivative
  objects. Generic 0064 JSONB cannot introduce a path, descriptor, bearer,
  URL, owner, or any other non-safe field into the image-job mapping.
- Finalization recovery returns `noop` when no durable mapping exists, while
  any post-commit read/mark/finalization repository fault returns only the
  existing recoverable pending outcome. Recovery remains download-free.
- Claimed-job ingress now uses PostgreSQL `clock_timestamp()` so a query that
  waits on a lock cannot begin download work after lease expiry.
- A released batch reservation no longer borrows its shared lock during
  rollback: it reacquires its own exact content-hash lock before projecting
  cleanup and deleting prepared artifacts.

### Correction verification

- Direct real-PostgreSQL red/green tests prove malformed provenance and each
  raw safe-result field are accepted pre-fix and rejected after the 0065
  hardening. Forbidden storage/bearer columns are now asserted individually.
- Real PostgreSQL matrix: 11 tests passed, including a post-commit mapping
  promotion fault with durable recovery, an uncommitted recovery no-op, and an
  ACCESS EXCLUSIVE lock-wait expiry that confirms zero downloader calls.
- `pnpm check` passed.
