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
