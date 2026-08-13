# Task 14e3b4 implementation report

## Outcome

Task 14e3b4 is implemented as a backend-only storage checkpoint. It introduces
explicit secure storage authority and bounded filesystem sessions without
composing routes, runtime consumers, workers, public barrels, or the Task
14e3b5 production composition.

The implementation is delivered across focused commits. The first checkpoint,
`8a5f8cd` (`feat(storage): add secure portable authority`), adds the additive
0058 schema, atomic portable issuance, secure storage contracts, and the
PostgreSQL repository. Later checkpoints contain the filesystem adapter,
additive 0059 target-intent hardening, reaper behavior, compatibility
retirement, boundary guard, and regression coverage described below.

## Implemented behavior

- Atomic portable staging/export issuance consumes the exact owner-scoped
  candidate attachment in the caller transaction. Portable row insertion and
  durable candidate attachment commit or roll back together, and replay or
  substituted scope/candidate/descriptor inputs fail closed.
- Migrations 0058 and 0059 persist an immutable operation-derived prewrite
  target before exclusive creation, then permit one exact target-only to
  identity-bound transition after fstat and before the first content byte.
  Recovery can clean an identity-bound partial write without guessing from
  ambient paths; a crash before identity persistence is quarantined without a
  path-only delete.
- The bearer-free expiry producer claims only exact expired portable rows using
  current database time, ordered locking, `SKIP LOCKED`, and rotated recovery
  claims. It transitions both the portable row and durable journal to cleanup
  pending and cannot select assets.
- Portable export sessions rehydrate exact persisted owner/full export scope
  and content type, prepare paired cleanup before delivery, anchored-open and
  verify the file, and enforce byte limit, deadline, positional exact-length
  reads, growth sentinel, incremental digest, and final identity.
- Export terminal paths share one memoized finalizer with the required order:
  close the file handle, identity-safe delete, then acknowledge database
  cleanup. A creation-time deadline timer invokes that finalizer even if the
  consumer never pulls or stalls between chunks. EOF, explicit close, abort,
  timeout, pre-send failure, and read failure converge on the same operation.
- Asset sessions redeem finalized or isolated legacy anchored authority,
  anchored-open and verify the descriptor, and enforce the same bounded read
  rules without deleting asset files.
- Adapter shutdown tracks and closes portable, asset, and legacy-preview stream
  handles. A synchronous closing fence rejects opens that begin after shutdown,
  and shutdown drains opens already in flight before closing root handles or
  resolving. Portable handles remain indexed by operation so a reaper closes
  them before physical cleanup.
- Identity-safe cleanup treats `ENOENT` as idempotent only after an exact
  prepared descriptor and fresh claim have already established the deletion
  target. A substituted node or identity mismatch remains a failure and cannot
  be acknowledged.
- The old owner-plus-descriptor, raw delivery-grant, and storage-locator
  production interfaces and repository methods are retired. Historical
  behavior is isolated under `tests/helpers`; the production lifecycle wrapper
  reconstructs attached results so a structurally wider adapter cannot leak an
  ambient locator at runtime.
- The private-storage AST guard rejects forbidden imports, re-exports, dynamic
  imports, `require` calls, and forbidden member access in production source.
  Static computed members remain detectable through nested TypeScript `as`,
  angle-bracket assertion, `satisfies`, non-null, and parenthesized wrappers;
  dynamic computed members remain allowed. It is included in the repository
  check command.
- The named non-reaped `legacy_path_v1` preview reader remains available only
  for server-derived legacy preview descriptors.

Historical 0053/0054 columns and tables remain in immutable migrations. The
durable repository still writes an unreturned random locator hash solely to
satisfy the existing 0053 non-null schema contract; no production TypeScript
API emits or redeems that value.

## Review findings fixed during implementation

1. Persisted export rehydration initially omitted `contentType`; exact export
   sessions now retain and validate it across restart.
2. Atomic issuance rollback coverage initially stopped at the returned
   preparation boundary; injected post-preparation failures now prove the
   entire caller transaction rolls back without split state.
3. A physical delete followed by an acknowledgement crash could strand cleanup
   because retry saw `ENOENT`; exact prepared-target absence is now an
   idempotent delete result, while substitution remains fail-closed.
4. Adapter shutdown initially closed only portable sessions; all active secure
   asset and legacy-preview handles are now tracked and closed.
5. The first AST guard covered only static imports; it now covers export-from,
   dynamic import, `require`, and forbidden member calls.
6. Removing the raw compatibility authority exposed test fixtures typed as
   production journals. Explicit test-only legacy journal contracts now carry
   historical locator behavior without widening or casting the production
   journal.
7. The production lifecycle wrapper returned an attached journal result
   verbatim, allowing ambient extra properties to cross the narrowed contract.
   It now returns exactly `{ outcome, operation, claim }` for an attached
   result and preserves stale/candidate-mismatch results.
8. A cooperative-only stream deadline allowed idle or between-chunk consumers
   to retain descriptors and export cleanup authority indefinitely. A
   creation-time, memoized deadline finalizer now closes sessions autonomously,
   clears its timer on every terminal path, performs export delete/ack only
   after close, preserves assets, and rejects late pulls.
9. A crash between `O_EXCL` creation and 0058 identity persistence left an
   untracked `.pending` node. Additive migration 0059 records target intent
   before creation, permits one database-clock-guarded identity CAS after
   fstat, and quarantines target-only recovery without deleting by path or
   completing cleanup. Target collisions likewise remain pending rather than
   deleting an unknown node.
10. The private-storage AST guard missed computed string and static-template
    member access. It now rejects those exact retired members, including
    optional computed access, while allowing dynamic templates and computed
    identifiers.
11. Shutdown could race an anchored open after the active-handle snapshot. A
    synchronous closing fence at registration closes and rejects unpublished
    handles deterministically.
12. The closing fence alone still allowed `close()` to resolve while an open
    that began before shutdown held a descriptor but had not registered it.
    Every open is now synchronously registered in an in-flight barrier set;
    shutdown closes published sessions, drains those barriers, and resolves
    only after any unpublished descriptor has been closed.
13. The AST guard still missed static retired member names nested inside
    TypeScript expression wrappers. Static-member inspection now recursively
    unwraps assertions, `satisfies`, non-null expressions, and explicit
    parentheses, and selects TypeScript/JSX parser plugins by source extension
    so angle-bracket assertions in `.ts` are inspectable without weakening JSX
    support.
14. Earlier deadline tests called manual finalizers before inspecting cleanup,
    so they did not prove autonomous expiration. Idle export, between-chunk
    export, and asset tests now wait for observable close/delete/ack behavior
    before any manual finalization; late finalization remains an idempotency
    assertion only.
15. Earlier current-clock coverage did not force identity binding to wait past
    expiry. A dedicated binder connection now starts while authority is live,
    is observed waiting on the operation row lock by exact backend PID, crosses
    expiry behind that lock, then rejects with SQLSTATE `55000` while the
    durable row remains `target_only` with no persisted identity.
16. Independent review found the row-lock fixture still inferred its pre-expiry
    start from a two-second process clock window. The fixture now gives the
    binder its own transaction, sets expiry from PostgreSQL immediately before
    that transaction, asserts both its transaction timestamp and current
    database timestamp precede expiry, and then starts the blocked update. A
    regression to transaction-start `now()` would therefore accept and fail the
    test, while `clock_timestamp()` rejects after the lock wait.
17. Independent review also found that the source-extension parser branches
    were exercised only as `.ts`. Valid JSX-containing `.tsx` and `.js`
    fixtures now cover both wrapped static retired members and dynamic computed
    members, proving JSX parsing remains enabled without masking TypeScript
    angle-bracket assertions in `.ts`.

## Verification

- `pnpm check`: passed, including repository/data boundary checks and all
  TypeScript/web checks.
- Focused correction matrix: 3 unit files, 17 tests passed; 0059 migration
  and secure repository matrix: 2 integration files, 11 tests passed.
- Second correction matrix: private-boundary and secure-adapter unit files,
  16 tests passed; secure-storage PostgreSQL integration file, 8 tests passed.
  The matrix includes wrapped static-member positives/dynamic negatives,
  autonomous idle/stalled export cleanup before manual finalization,
  autonomous asset descriptor close, close-versus-in-flight-open draining, and
  the exact-backend row-lock expiry race.
- Affected PostgreSQL/filesystem matrix: passed for durable filesystem,
  Task 14e2c adapters, portable repository, finalized delivery, 0058 migration,
  additive 0059 target-intent migration, and secure storage repository.
- Full `pnpm test`:
  - unit: 124 files, 1,425 tests passed;
  - integration: 42 files, 465 tests passed.
- `git diff --check`: passed.
- Production raw-authority scan: no forbidden production references; remaining
  matches are negative assertions, the AST guard itself, and isolated
  `tests/helpers` compatibility fixtures.

The historical archive fixture still emits a non-failing Node `FileHandle`
garbage-collection warning in focused and full runs. It does not originate from
the new production adapter composition (there is none in b4), and all tests
pass; track it as test-harness hygiene rather than a Task 14e3b4 blocker.

One post-review full integration attempt exposed a pre-existing randomized
world-cover fixture: the prompt-facing title included a UUID whose substrings
can match mechanics tokens such as `ac01`. The fixture now uses stable fiction-
only title text. The image-pipeline file passed 26/26 in isolation and the full
integration suite passed 42 files/465 tests after that test-only correction.

## Scope deliberately deferred

- No production repository/adapter composition was added.
- No route, API runtime consumer, worker, or public barrel was changed to use
  the new authority.
- No asset writer or import/export route was switched from legacy bindings.
- No historical migration was rewritten or destructively dropped.

## Next ordered work

1. Task 14e3b5: add the named production composition in
   `services/runtime/src/asset-import-composition.ts`, inject only explicit b1
   through b4 ports, add an AST/import inventory, and run a real
   PostgreSQL/filesystem adapter contract matrix. Do not bind routes or workers.
2. Task 14e3c: compose asset library/facet/metadata/selection/delivery/backfill
   ports and implement three-phase publication for originals, thumbnails, and
   every generated/imported artifact.
3. Task 14e3d: compose all portable import/export families, transactionally
   couple domain mutation with portable consume/complete, and replace the
   process-local progress map.
4. Task 14e3e: move illustration/import writers and durable recovery scheduling
   behind the named compositions.
5. Task 14e3f: prove production-composed parity while legacy bindings remain
   active.
6. Task 14e3g: perform the single reviewed production binding switch.
7. Task 14e3h and 14e4: remove legacy callable authority, inventory the final
   seams, and run the complete parity/security audit.
