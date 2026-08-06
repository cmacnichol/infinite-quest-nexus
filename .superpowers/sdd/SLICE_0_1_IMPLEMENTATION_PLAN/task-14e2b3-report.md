# Task 14e2b3 Completion Report

## Outcome

Task 14e2b3 is complete on the requested base
`8e2a53ac6b23277bff0c4de70458daa4ce2b8c4e`.

The new additive PostgreSQL repository persists owner-scoped portable staged
inputs, destination-bound previews, exactly-once import commits, durable result
retrieval, and path-free export retrieval using the existing `0053` schema.
It is not composed into a production API, worker, service, route, or runtime
path.

## Scope delivered

- Added `createPostgresImportRepository(pool)` with staged registration and
  private payload redemption, preview creation and payload redemption,
  caller-transaction import begin/completion, result retrieval, and export
  artifact registration/redemption.
- Registered staged inputs only from an existing owner-bound
  `portable_staging` durable operation whose scope hash, finalized or attached
  lifecycle, immutable descriptor hash, and byte length match exactly.
- Issued cryptographically random staged, preview, result, and export bearer
  capabilities. PostgreSQL stores only SHA-256 hashes; raw tokens and private
  paths never enter public views.
- Bound previews to owner, import kind, content fingerprint, exact destination
  fingerprint, staged input, expiry, safe projection, and allowlisted
  diagnostics. Campaign projection destinations are checked against the
  repository-bound destination on both write and read.
- Superseded only a live preview with the same owner, kind, content
  fingerprint, and destination fingerprint.
- Implemented exactly-once staged-input consumption within the caller's
  PostgreSQL transaction. A rollback restores both preview and staged-input
  authority.
- Implemented import idempotency with hashed caller keys and a canonical
  request fingerprint. Exact committed retries replay; same-key requests for a
  different preview fail with `import_idempotency_mismatch`.
- Recovered safely from concurrent unique-key conflicts using a savepoint, so
  PostgreSQL's aborted-transaction state cannot leak as an unrelated storage
  failure.
- Required completed result projections to match the exact owner-scoped
  `imports` row's import, world, world-version, and campaign identity before
  commit.
- Validated all persisted preview and result projection variants before
  returning them. Malformed database JSON fails with the stable
  `archive_unavailable` diagnostic and never exposes SQL, paths, or driver
  details.
- Preserved `imports.source_hash` and treated source installation/record IDs as
  opaque informational provenance only. Neither value participates in local
  authorization or foreign-key selection.
- Registered exports only from matching owner-bound `portable_export` durable
  operations and returned path-free public views. Private descriptor redemption
  requires the exact owner, export kind, campaign/world/version scope, token,
  lifecycle, and unexpired artifact.

No migration was required: the additive `0053` staged/import/export tables and
constraints fully support this checkpoint. No database index barrel change was
needed because the adapter is intentionally imported by its direct module until
later composition work.

## Transaction and concurrency invariants

`beginImport` and `completeImport` reject use outside a caller-owned
transaction. Preview rows are locked with `FOR UPDATE`; preview consumption,
staged-input consumption, completed-import validation, result persistence, and
the caller's domain work therefore share one transaction boundary.

Two concurrent callers redeeming the same preview and key produce one commit
and one exact replay. Two concurrent previews using the same owner/kind/key
produce one ready claim and one safe idempotency mismatch. A rolled-back ready
claim leaves the preview and staged input redeemable.

Deterministic advisory locks, durable-operation finalization/cleanup coupling,
physical-content retention, and reaper crash recovery remain explicitly owned
by 14e2b4.

## Test-driven evidence

RED was observed before implementation and for each discovered integrity gap:

- the focused test initially failed module resolution because
  `packages/database/src/import-repository.ts` did not exist;
- caller-owned transaction enforcement initially allowed repository work
  outside an explicit transaction;
- concurrent different-preview same-key redemption initially surfaced
  `archive_unavailable` after PostgreSQL's unique violation;
- malformed stored campaign projections initially passed through unchecked;
- a structurally valid campaign projection could initially disagree with its
  bound preview destination;
- malformed live preview data was initially detected only after in-transaction
  consumption, allowing a caller that caught the error to commit the partial
  state;
- an expired staged input was initially detected after its preview had moved
  to `consuming`, and result-wrapper/result duplicate flags could disagree;
- a result projection could initially name a different import/world/campaign.

Final focused verification:

- `pnpm exec vitest run --config vitest.integration.config.ts tests/integration/import-repository.integration.test.ts --reporter=dot`
  - 1 file passed, 12 tests passed.

The real-PostgreSQL suite proves:

- staged capability hashing, owner denial, descriptor matching, and expiry;
- all seven kinds and eight preview/commit destination variants;
- owner, kind, and exact destination binding;
- exact fingerprint/destination supersession;
- same-preview concurrent exactly-once commit and replay;
- different-preview concurrent same-key mismatch;
- explicit transaction requirement and rollback restoration;
- staged-input expiry rejection without partial preview consumption;
- sequential exact replay and mismatched-preview rejection;
- result owner/kind/expiry checks;
- malformed persisted projection denial, result/import scope matching, and
  duplicate-flag consistency;
- malformed live preview denial before either preview or staged-input
  consumption;
- legacy source-hash preservation and provenance non-authority;
- path-free, owner/scope-bound, expiry-aware export retrieval.

Full repository verification:

- `pnpm check`
  - repository boundary/data checks and all TypeScript/web checks passed.
- `pnpm build`
  - TypeScript, legacy web, and Next web builds passed.
- `pnpm test:unit -- --reporter=dot`
  - 116 files passed, 1,349 tests passed.
- `pnpm exec vitest run --config vitest.integration.config.ts --reporter=dot`
  - 34 files passed, 373 tests passed in 88.12 seconds.
- `git diff --check`
  - passed.

An initial unit baseline launched concurrently with check, build, and
integration was resource-contended and inconclusive. The isolated final unit
run above is authoritative and passed completely.

## Files changed

- `packages/database/src/import-repository.ts`
- `tests/integration/import-repository.integration.test.ts`
- `.superpowers/sdd/SLICE_0_1_IMPLEMENTATION_PLAN/task-14e2b3-report.md`

## Deferred work and unchanged scope

- 14e2b4 owns advisory-lock ordering, durable operation/reaper coupling,
  cross-owner physical-content retention, cleanup leases, and crash-point
  recovery.
- 14e2c owns additive test-only filesystem/database adapter composition.
- 14e3 owns production route, service, worker, and runtime cutover plus legacy
  authority removal.
- No migration, route, service, worker, runtime composition, cross-role
  allowlist, physical cleanup, or `#0446` state changed in this checkpoint.
- Existing unrelated working-tree changes were preserved and are not part of
  this task.
