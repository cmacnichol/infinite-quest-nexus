# Task 14c2a recovery report

## Status

Implemented and verified the first coherent additive Task 14c2a portion in
commit `7ccf786` (`Add world repository adapters`). No legacy service, route,
runtime, worker, portable archive, multipart, filesystem, or provider code was
changed.

## Implemented scope

- Added `createPostgresWorldCampaignTransactionPort`:
  - command work receives one caller-owned PostgreSQL transaction client;
  - read work receives one `REPEATABLE READ READ ONLY` transaction client;
  - callback failure rolls command work back;
  - repositories reject contexts that do not carry the adapter-owned client.
- Added `createPostgresWorldRepositoryAdapters`, with no injected callbacks,
  pool fallbacks, nested transactions, placeholders, or legacy delegation.
- Added explicit-owner PostgreSQL operations for:
  - world list and aggregate get;
  - world create and revision-fenced draft update;
  - immutable version publication and status update;
  - published-version fork;
  - world deletion and world-version deletion, including dependency blockers;
  - explicit campaign migration to a newer published version of the same world.
- Adapter source timestamps remain raw `Date` values. ISO canonicalization stays
  in the completed application layer.
- Added the factory to the database package barrel.

## RED / GREEN evidence

### Initial RED

The first test was written before the production module. The initial command:

```text
pnpm vitest run tests/integration/world-campaign-repository.integration.test.ts
```

failed because `packages/database/src/world-repository.js` and
`createPostgresWorldRepositoryAdapters` did not exist. That default Vitest
command does not install the integration database, so it proved the missing
factory but did not execute PostgreSQL setup.

The command was corrected to the repository's real-PostgreSQL integration
configuration. After the minimal create/list seam existed, the expanded
behavior matrix produced the required database-backed RED:

```text
pnpm vitest run --config vitest.integration.config.ts \
  tests/integration/world-campaign-repository.integration.test.ts
```

Result: 1 passed and 3 failed. The failures were the expected missing adapter
methods: `updateWorldDraft` and `publishWorld` were not functions.

### GREEN

The same real-PostgreSQL command passed 5/5 after the minimal implementation.
It covers:

- explicit-owner create/list and foreign-owner invisibility;
- raw `Date` sources;
- caller-owned command rollback;
- draft revision locking, publication immutability, status, fork, and get;
- referenced world/version deletion blockers and successful deletion;
- cross-world migration rejection plus same-world newer-version migration,
  persistence, audit row, and raw migration timestamp.

`pnpm check` initially found a local type-only helper error: a class constructor
was passed to `Parameters<>`, causing 23 derivative `TS2345` errors. Typing the
helper with the existing `WorldCampaignErrorDetails` contract fixed the issue;
no SQL or runtime behavior changed.

## Verification

- Focused real-PostgreSQL adapter suite: 1 file, 5/5 passed.
- `pnpm check`: passed; 639 repository/data-safety candidates checked.
- `pnpm build`: passed, including both web builds.
- `pnpm test:unit`: 107 files, 1,238/1,238 passed.
- `pnpm test:integration`: 27 files, 276/276 passed.
- `git diff --check`: passed.
- Projectmem prechecks for all changed files and the report: passed; no
  projectmem write tool was used.

## Commits

- `7ccf786` — `Add world repository adapters`

## Exact deferred scope

The following remains Task 14c2a work; this recovery checkpoint does not claim
14c2a complete:

- campaign lifecycle adapter operations: list, create, update, delete;
- world-version playable-character reads;
- the persistence side of portable world JSON preview/import/export, while all
  archive, multipart, streaming, and filesystem I/O remains Task 14e-owned;
- campaign-discovery promotion into a world draft;
- broader owner/locking parity cases for those deferred operations.

All Task 14c2b work remains deferred: campaign sync/state, player configuration,
rewind, branch, fences, rollback, provenance, and bounded reader reuse.
Task 14c2c transfer/character adapters and Task 14c2d dashboard/session/progress/
world-generation collaborator composition and combined audit also remain
deferred. Task 14c3 route/runtime composition and Task 14c4 legacy removal were
not started.
