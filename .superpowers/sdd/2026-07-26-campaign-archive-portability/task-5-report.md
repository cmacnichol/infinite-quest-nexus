# Task 5 report: staged Campaign Archive preview and transactional import

## Changed files

- `database/migrations/0043_archive_previews.sql`: adds owner-scoped preview rows, token/fingerprint/destination bindings, status/expiry constraints, and cleanup/idempotency indexes.
- `services/api/src/campaign-archive-service.ts`: adds strict Campaign Archive decoding, preview generation/storage, destination analysis, source/world fingerprint validation, and manifest-less legacy ZIP adaptation with compatibility warnings.
- `services/api/src/import-service.ts`: adds destination-aware idempotent import, locked preview revalidation, namespaced identity remapping, foreign-key-ordered campaign/Chronicle/illustration/provenance inserts, asset persistence/binding restoration, pointer rewriting, and rollback cleanup.
- `tests/integration/campaign-archive.integration.test.ts`: adds preview no-write, preview summary, world reuse, identity remap, asset, and import assertions.
- `tests/integration/migrations.integration.test.ts`: adds the `archive_previews` schema, constraint, index, relative-path, and token-hash assertions.

## RED/GREEN evidence

- RED: migration and Campaign Archive import assertions were added before the Task 5 implementation. The required PostgreSQL RED command was then attempted, but the explicit database guard stopped it because `TEST_DATABASE_URL` is unset; therefore no database failure is claimed.
- GREEN: `pnpm test:unit` — passed, 43 files / 495 tests passed / 2 existing skips.
- GREEN: focused archive suites — passed, 3 files / 115 tests passed / 2 existing skips.
- GREEN: `pnpm build` — passed.
- GREEN: `pnpm check` — passed, including repository boundary and data-safety checks.
- GREEN: `git diff --check` — passed.

## PostgreSQL status

The required command was not runnable because `TEST_DATABASE_URL` is absent. The command was guarded with:

```powershell
if (-not $env:TEST_DATABASE_URL) { throw "TEST_DATABASE_URL is required; a skipped suite is not verification" }
```

No PostgreSQL migration or Campaign Archive integration result is being represented as passed. Run the focused migration, campaign-archive, and import-memory suites against a real PostgreSQL database before merge.

## Commit

`486de80` — `Add transactional campaign archive import`

## Self-review concerns

- PostgreSQL behavior remains unverified in this environment, including migration SQL, transactional rollback, destination idempotency, and the visible integration fixture.
- Legacy ZIP adaptation is implemented and routed through the same decoded/import path, but requires real PostgreSQL coverage before completion can be considered production-verified.
- Task 6 route registration and Task 7 UI work remain intentionally out of scope.
- The requested plan and SDD ledger were not modified.

## Fix round 1 of 5: review findings

### Changed files

- `services/api/src/archive-io.ts`: adds manifest-less ZIP container inspection and bounded verified entry reads that reuse the shared central-directory, local-header, identity, path, duplicate, encryption, compression, size, and expansion-ratio validation.
- `services/api/src/campaign-archive-service.ts`: routes legacy ZIP adaptation through the shared strict container, makes manifest-less ZIP fallback reachable, requires declared compatible bindings for world and turn asset pointers, and verifies an explicit destination's canonical world hash at preview.
- `services/api/src/import-service.ts`: replaces the Windows-only staged-path prefix guard with `relative`/`isAbsolute` containment before file access, fails closed for unmapped portable pointers, and repeats the canonical-world compatibility check under the commit transaction.
- `tests/unit/campaign-archive-service.test.ts`: adds direct legacy duplicate-entry, manifest-less-warning, and missing turn/world asset-pointer regression coverage.
- `tests/integration/campaign-archive.integration.test.ts`: adds coverage for destination mismatch/exact attachment, destination-aware idempotency, expired/consumed/stale preview tokens, manifest-less warnings, and forced transactional/asset cleanup rollback.

### RED/GREEN evidence

- RED: `C:\Git\InfiniteQuest\node_modules\.bin\vitest.cmd run tests/unit/campaign-archive-service.test.ts` initially failed: a duplicate `campaign.json` legacy ZIP was accepted until later image validation (`archive-asset-invalid`) rather than rejected as `archive-entry-duplicate`.
- RED: the same focused command then failed for a valid manifest-less ZIP (`archive-entry-missing`) and for an undeclared turn image pointer (resolved rather than rejected).
- RED: after adding nested world-pointer coverage, the focused command failed because the pointer walker only examined top-level strings.
- GREEN: `C:\Git\InfiniteQuest\node_modules\.bin\vitest.cmd run tests/unit/campaign-archive-service.test.ts tests/unit/archive-io.test.ts tests/unit/asset-archive-service.test.ts tests/unit/archive-contracts.test.ts` — 4 files passed; 119 tests passed, 2 existing skips.
- GREEN: `pnpm check` — passed, including repository-boundary and data-safety checks plus TypeScript/no-emit and browser syntax checks.
- GREEN: `pnpm build` — passed.
- GREEN: `git diff --check` — passed.

### PostgreSQL status

`TEST_DATABASE_URL` is not set in this worktree. The focused integration command loaded successfully but skipped honestly:

```powershell
C:\Git\InfiniteQuest\node_modules\.bin\vitest.cmd run --config vitest.integration.config.ts tests/integration/campaign-archive.integration.test.ts
```

Result: 1 file skipped / 11 tests skipped. This is not completion of the PostgreSQL verification. A real PostgreSQL run is still required for exact destination attachment, token lifecycle, idempotency, and forced transaction/filesystem rollback.

### Commit

`c76e336` — `Harden campaign archive import validation`

This report is force-staged in the following documentation commit because the SDD directory is ignored.

### Self-review

- The Linux path correction is platform-safe by construction and is exercised by the PostgreSQL commit path when that suite is run on Linux; this environment cannot execute that DB-backed path because `TEST_DATABASE_URL` is absent.
- Legacy compatibility remains intentionally restrictive: only the legacy campaign JSON and supported UUID-named image assets are accepted, after shared ZIP validation.
- The report, plan, and ledger scope were preserved; only this report was appended.

## Fix round 2 of 5: scoped re-review findings

### Changed files

- `services/api/src/campaign-archive-service.ts`: centralizes the Campaign Archive world projection/hash as `portableWorldContentHash`, which applies the same portable sanitization and canonicalization used by export; export, decode, preview attachment/reuse checks, and legacy adaptation use that path.
- `services/api/src/import-service.ts`: uses `portableWorldContentHash` again while the commit transaction revalidates an explicit destination version.
- `tests/unit/campaign-archive-service.test.ts`: directly proves a destination-only provider `apiKey` does not change the export-compatible world hash.
- `tests/integration/campaign-archive.integration.test.ts`: adds explicit-secret preview/commit coverage (including a post-preview secret change), repeat preview/import idempotency returning `duplicate: true`, and rollback count checks for worlds, campaigns, and imports as well as assets/files.

### RED/GREEN evidence

- RED: `C:\Git\InfiniteQuest\node_modules\.bin\vitest.cmd run tests/unit/campaign-archive-service.test.ts` failed as expected with `TypeError: portableWorldContentHash is not a function` before the shared export-compatible hash function existed.
- GREEN: `C:\Git\InfiniteQuest\node_modules\.bin\vitest.cmd run tests/unit/campaign-archive-service.test.ts` — 1 file / 5 tests passed after the implementation.
- GREEN: `C:\Git\InfiniteQuest\node_modules\.bin\vitest.cmd run tests/unit/campaign-archive-service.test.ts tests/unit/archive-io.test.ts tests/unit/asset-archive-service.test.ts tests/unit/archive-contracts.test.ts` — 4 files / 120 tests passed, 2 existing skips.
- GREEN: `pnpm check` — passed, including repository-boundary, data-safety, TypeScript/no-emit, and browser syntax checks.
- GREEN: `pnpm build` — passed.
- GREEN: `git diff --check` — passed.

### PostgreSQL status

`TEST_DATABASE_URL` remains unset. The focused Campaign Archive integration command loaded but skipped honestly:

```powershell
C:\Git\InfiniteQuest\node_modules\.bin\vitest.cmd run --config vitest.integration.config.ts tests/integration/campaign-archive.integration.test.ts
```

Result: 1 file skipped / 13 tests skipped. The added real-database cases are not represented as passed: explicit destination compatibility before and after preview, repeat destination-aware idempotency, and forced rollback with relational-row/file cleanup still require a PostgreSQL run.

### Commit

`a7e31e1` — `Align campaign archive world compatibility`

This ignored report is force-staged in the following documentation commit.

### Self-review

- The hash helper deliberately accepts `unknown` because database content and decoded portable payloads cross the same boundary; it delegates to the existing sanitizer/canonicalizer rather than duplicating removal rules.
- The repeat-import assertion proves the completed `imports` result is returned only after a new preview for the same destination; reusing an already consumed token remains correctly stale.
- The forced rollback test establishes no new `worlds`, `campaigns`, or `imports` rows relative to the pre-import baseline, but needs PostgreSQL execution before its trigger/filesystem behavior is considered verified.
- The plan and ledger were not modified.
