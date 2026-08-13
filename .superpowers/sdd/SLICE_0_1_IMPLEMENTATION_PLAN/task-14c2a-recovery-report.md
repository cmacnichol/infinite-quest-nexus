# Task 14c2a recovery report

## Status

Implemented and verified the requested additive Task 14c2a transaction, world,
and campaign-lifecycle adapter portion in commits `7ccf786`, `dc73210`, and
`9a8387d`. No legacy service, route, runtime, worker, portable archive,
multipart, filesystem, or provider transport code was changed.

## Implemented scope

- Added `createPostgresWorldCampaignTransactionPort`:
  - command work receives one caller-owned PostgreSQL transaction client;
  - read work receives one `REPEATABLE READ READ ONLY` transaction client;
  - callback failure rolls command work back;
  - repositories reject contexts that do not carry the adapter-owned client.
- Added `createPostgresWorldRepositoryAdapters`, with a required named and typed
  `CampaignCreationMemoryCollaborator`, and no anonymous callbacks, pool
  fallbacks, nested transactions, placeholders, or legacy delegation.
- Added explicit-owner PostgreSQL operations for:
  - world list and aggregate get;
  - world create and revision-fenced draft update;
  - immutable version publication and status update;
  - published-version fork;
  - world deletion and world-version deletion, including dependency blockers;
  - campaign list, create, update, delete, and playable-character reads;
  - explicit campaign migration to a newer published version of the same world.
- Campaign creation validates readiness and character selection, takes a key-
  share lock on the published version, snapshots the selected character, and
  initializes campaign state in the caller-owned transaction. It then invokes
  the 14b-owned Chronicle embedding bootstrap on that same transaction client,
  so eligible memory configuration and the initial embedding job commit or roll
  back atomically with campaign creation.
- Campaign migration takes a key-share lock on its target version before
  writing migration history or updating the campaign, serializing it with
  target-version deletion.
- World deletion locks every owned published version before counting blockers
  and deleting, closing the concurrent campaign-insert check/delete race.
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

### Round-one correction RED

The review-driven expansion produced a real-PostgreSQL RED with 5 passing and
3 failing tests. Two failures showed the absent campaign lifecycle methods. The
coordinated race test held an uncommitted campaign FK/key-share lock, proved the
delete transaction was waiting through `pg_blocking_pids`, committed the writer,
and observed raw PostgreSQL FK error `23503` from `deleteWorld`.

A later response-parity RED proved that campaign creation omitted the selected
`turnControlStyle`; the correction includes that field.

### GREEN

The same real-PostgreSQL command passed 10/10 after the second correction.
It covers:

- explicit-owner create/list and foreign-owner invisibility;
- raw `Date` sources;
- caller-owned command rollback;
- draft revision locking, publication immutability, status, fork, and get;
- referenced world/version deletion blockers and successful deletion;
- cross-world migration rejection plus same-world newer-version migration,
  persistence, audit row, raw migration timestamp, and migration/transfer
  deletion blockers;
- owner-scoped campaign create/list/update/delete and playable-character reads;
- campaign state initialization, active Chronicle-work deletion blocking, and
  raw campaign list/update dates;
- foreign-owner invisibility for world get/mutate/delete and campaign create,
  list, update, delete, character reads, and migration;
- deterministic world deletion/campaign creation serialization returning typed
  `deletion_blocked` rather than a raw FK error;
- eligible embedding-profile campaign bootstrap, persisted Chronicle memory
  configuration/job outcome, and caller-owned rollback of the campaign,
  configuration, and job;
- deterministic target-version deletion/campaign migration serialization,
  proving deletion waits for the migration and then returns typed
  `deletion_blocked` rather than leaking PostgreSQL `23503`.

### Round-two correction RED

The two real-PostgreSQL tests were added before the production correction. The
focused matrix produced 8 passing and 2 failing tests:

- campaign creation persisted no memory configuration or Chronicle job despite
  an eligible default embedding profile;
- coordinated target-version deletion did not wait on the migration after its
  target read, exposing the unprotected interval that can end in raw FK error
  `23503`.

After injecting the named `CampaignCreationMemoryCollaborator`, invoking it on
the caller-owned client, and locking migration targets with `FOR KEY SHARE`, the
same focused matrix passed 10/10.

`pnpm check` initially found a local type-only helper error: a class constructor
was passed to `Parameters<>`, causing 23 derivative `TS2345` errors. Typing the
helper with the existing `WorldCampaignErrorDetails` contract fixed the issue;
no SQL or runtime behavior changed.

## Verification

- Focused real-PostgreSQL adapter suite: 1 file, 10/10 passed.
- `pnpm check`: passed; 640 repository/data-safety candidates checked.
- `pnpm build`: passed, including both web builds.
- `pnpm test:unit`: 107 files, 1,238/1,238 passed.
- `pnpm test:integration`: 27 files, 281/281 passed.
- `git diff --check`: passed.
- Projectmem prechecks for all changed files and the report: passed; no
  projectmem write tool was used.

## Commits

- `7ccf786` — `Add world repository adapters`
- `dc73210` — `Complete campaign lifecycle adapters`
- `9a8387d` — `Preserve campaign memory lifecycle`

## Exact deferred scope

The following remains outside this requested Task 14c2a recovery portion:

- the persistence side of portable world JSON preview/import/export, while all
  archive, multipart, streaming, and filesystem I/O remains Task 14e-owned;
- campaign-discovery promotion into a world draft;
- broader parity cases for those deferred operations and blocker categories not
  explicitly exercised by this focused matrix.

All Task 14c2b work remains deferred: campaign sync/state, player configuration,
rewind, branch, fences, rollback, provenance, and bounded reader reuse.
Task 14c2c transfer/character adapters and Task 14c2d dashboard/session/progress/
world-generation collaborator composition and combined audit also remain
deferred. Task 14c3 route/runtime composition and Task 14c4 legacy removal were
not started.
