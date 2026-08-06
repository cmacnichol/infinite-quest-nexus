# Task 14e2aR Completion Report

## Outcome

Task 14e2aR is implemented as an additive private capability checkpoint on base
`f5ab49bc2d86780ae1cac9c4039925b9f359d512`.

Implementation commit:
`113627751dc773b054341d5c2bed021ed162cd9d`
(`feat(api): persist filesystem capability handoff`).

The secure filesystem adapter no longer treats its staged-input or export maps
as authority. It requires an injected private persistence port, redeems an
owner-bound opaque handle on every operation, and reopens persisted archive or
asset bytes only when the stored lifecycle, byte length, SHA-256, relative
locator, and complete immutable filesystem identity agree. The test fake stores
only SHA-256 token hashes and survives adapter recreation.

Original and derivative publication now use the same durable reserve, candidate,
attach, finalize, recovery, and cleanup protocol. Publication results are opaque
candidates or safe lifecycle records; public results contain no path, private
descriptor, storage exception, or driver detail.

## Scope delivered

- Added the private `PrivateFilesystemCapabilityPersistencePort` without
  exporting it through an application barrel.
- Extended the test-only durable lifecycle fake with owner-bound, hashed staged,
  export, candidate, and locator tokens plus persistent lifecycle records.
- Required persistence injection for the secure archive/filesystem adapter;
  immediate upload stream capabilities remain intentionally process-local and
  one-shot because they precede durable staging.
- Added bounded, descriptor-anchored persisted archive rehydration. The legacy
  rehydration helper remains unchanged for its existing legacy caller; the new
  private helper is used only by the additive capability.
- Added strict original/derivative image publication with MIME/signature checks,
  full bounded Sharp decode, an exclusive temporary file, descriptor-relative
  adoption, read-only final permissions, final identity/hash measurement, and
  opaque candidate issuance.
- Added owner-scoped locator redemption for published asset delivery.
- Made staged, export, and publication cleanup retryable and idempotent while
  retaining the existing descriptor-pinned quarantine-and-recheck deletion.
- Kept all existing diagnostics in the allowlisted archive/asset code sets.

No migration, schema, route, worker, production composition, runtime
illustration binding, legacy-service cutover, cross-role allowlist, or `#0446`
live path changed.

## Threat model

The repository security guidance in `AGENTS.md` remains authoritative. This
section applies those repository-wide owner isolation, untrusted input,
independent provider, and path-free storage rules to the 14e2aR handoff.

### Protected assets and authorities

- Private world/campaign archive contents and export artifacts.
- Original and derivative image bytes and their immutable identity/hash.
- Owner scope, asset scope, and portable-operation scope.
- Durable operation state, recovery leases, work versions, and cleanup intent.
- Archive and asset storage roots; a hostile pathname must never redirect an
  operation outside the configured root or onto another file.

### Trust boundaries and attacker-controlled inputs

- Opaque staged, export, publication-candidate, and locator strings are
  untrusted when presented for redemption. Possession alone is insufficient;
  the persisted token hash, owner, purpose, and lifecycle must all match.
- Persisted relative locators and descriptors are private database outputs, but
  are still validated as potentially corrupt before filesystem use.
- Uploaded archive bytes, archive entry paths, image bytes, MIME declarations,
  and declared byte lengths are untrusted.
- Filesystem names and identities may change concurrently because of local
  compromise, symlink/junction installation, root replacement, or cleanup races.
- Recovery claims are untrusted after lease loss or work-version advancement.

### Security invariants and controls

| Threat | Control |
| --- | --- |
| Raw token theft from persistence | Persist only SHA-256 token hashes; compare the presented opaque token by hash. |
| Cross-owner handle replay | Bind staged/export/locator records to `ownerUserId` and exact resource scope; foreign redemption returns no descriptor. |
| Restart loses authority | Recreate the adapter over the durable port and redeem the database record; in-process caches contain inspection state only. |
| Stale or substituted file | Require exact device, inode, size, mtime, ctime, byte length, and SHA-256 before use. |
| Parent/root alias or link traversal | Linux-only `O_NOFOLLOW` segment traversal and retained `/proc/self/fd` directory anchors; unsupported platforms fail before mutation. |
| Same-inode growth or truncation | Positional bounded reads with a sentinel/final identity check; persisted archive hashing is capped by the configured compressed limit. |
| Truncated/header-only image | Validate signature, metadata, pixel/page limits, and complete bounded decode before publication or delivery. |
| Publication overwrite/replay | Create an exclusive temporary file, then adopt it with an exclusive hard link; an existing final candidate is never replaced. |
| Cleanup substitution | Rename the expected identity into a descriptor-relative quarantine name, recheck the renamed object, then unlink; restore or preserve on mismatch. |
| Crash or cleanup failure | Persist the candidate descriptor before attach; lifecycle records retain cleanup intent, retry returns the same descriptor, and completion is idempotent. |
| Stale recovery worker | Lease id, lease owner, work version, expiry, operation identity, and scope fence every terminal action. |
| Information disclosure | Capability failures are frozen `{ code }` objects; opaque result views contain no path, descriptor, raw exception, or storage detail. |

### Assumptions and residual risk

- The secure implementation deliberately supports Linux only and depends on
  `/proc/self/fd`, `O_NOFOLLOW`, stable inode identity, and same-filesystem hard
  links. Other platforms fail closed.
- Operators must keep archive/asset roots on trusted local filesystems whose
  identity and hard-link semantics match Linux expectations and must prevent
  untrusted users from modifying the roots directly.
- The persistence implementation in this checkpoint is a test fake. PostgreSQL
  token generation, constraints, transactions, locks, leases, and recovery
  queries remain 14e2b work.
- A process crash during the small pre-candidate temporary-write window may
  leave an unreachable exclusive `.tmp` file. It cannot be delivered or
  authorized; durable orphan enumeration/drain belongs to the 14e2b4 reaper
  matrix.
- Existing legacy `rehydratePersistedStagedArchive` callers are intentionally
  not cut over here. Production adoption remains prohibited until 14e2c/14e3.

## Lifecycle state machines

### Staged input and export retrieval

```text
bytes verified
    |
    v
ready (opaque handle hash + owner + immutable descriptor)
    | begin cleanup
    v
cleanup_pending -- identity-safe delete fails --> cleanup_pending
    | retry succeeds
    v
cleaned -- repeated cleanup --> already_cleaned
```

Only `ready` records can be inspected, extracted, or downloaded. Foreign-owner,
unknown, cleanup-pending, and cleaned handles do not redeem for use. Cleanup
begin returns the same persisted descriptor on every retry; cleanup completion
is acknowledged only after identity-safe deletion/no-op succeeds.

### Asset publication operation

```text
reserve + fenced claim
    |
    v
reserved -- verified filesystem write --> persisted opaque candidate
    | caller transaction attaches candidate
    v
attached + database locator
    | domain commit                    | rollback/recovery
    v                                  v
finalized                         cleanup_pending
    | repeated finalize                 | identity-safe delete + acknowledgement
    v                                  v
already_finalized                  cleaned
                                       |
                                       v
                                 already_cleaned
```

Recovery advances the work version and lease, invalidating the old claim. An
attached operation is recovered for finalization; a reserved or cleanup-pending
operation is recovered for cleanup. Finalization and cleanup completion both
reject stale or lease-lost claims.

## Test-driven evidence

RED was observed before implementation:

- New Task 14e2aR suite: 7 intended failures and 1 pre-existing projection
  assertion. Restarted staged/export handles returned `archive_unavailable`,
  publication lifecycle methods were absent, and stale persisted identity was
  not rehydrated.
- The projection-only assertion was removed during test review because it did
  not prove a new behavior.

GREEN and regression evidence:

- `pnpm exec vitest run tests/unit/task-14e2ar-persisted-filesystem.test.ts tests/unit/portable-archive-filesystem-adapter.test.ts tests/unit/archive-io.test.ts tests/unit/task-14e1r2-contracts.test.ts`
  - 4 files passed, 111 tests passed.
- `pnpm test:unit`
  - 116 files passed, 1,334 tests passed.
- `pnpm check`
  - repository boundary/data checks and all TypeScript/web checks passed.
- `pnpm build`
  - TypeScript build plus legacy and next web builds passed.
- `git diff --cached --check`
  - passed before the implementation commit.
- `pjm precheck`
  - passed for the exact staged implementation/test set.

Behavior coverage includes:

- staged handle restart and SHA-256-only fake persistence;
- export retrieval restart and idempotent cleanup;
- foreign-owner denial;
- same-length stale identity substitution;
- cleanup-pending retry after adapter recreation;
- original and derivative reserve/publish/attach/deliver/finalize;
- publication cleanup substitution and retry;
- recovery claim fencing and stale-claim rejection;
- existing traversal, real ZIP symlink, root alias, aggregate cap, concurrent
  growth, truncated image, pixel/page, quarantine, and descriptor-release
  regressions.

## Deferred work

- 14e2b1: PostgreSQL migration, random token creation, hashes/constraints,
  historical diagnostic scrubbing, and safe legacy drain policy.
- 14e2b2: owner-scoped asset list/facet/selection/metadata/backfill repositories.
- 14e2b3: persisted portable preview/import/export repositories and exactly-once
  consumption.
- 14e2b4: advisory/physical-path locks, `SKIP LOCKED` reapers, cross-owner
  physical retention, every crash point, and orphan temporary-file drain.
- 14e2c: test-only PostgreSQL/application adapter contract matrix.
- 14e3: atomic API/worker/runtime cutover and legacy removal.
- `#0446`: remains open; this checkpoint does not wire the unsafe live backfill
  consumer.
