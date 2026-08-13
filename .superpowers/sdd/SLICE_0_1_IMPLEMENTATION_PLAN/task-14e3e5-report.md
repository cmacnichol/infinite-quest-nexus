# Task 14e3e5 implementation report

## Scope and binding

Implemented the private existing-asset metadata-backfill executor only. It is
not imported by a live worker, API route, default runtime composition, or
public application barrel. The existing 0060 whole-asset publisher is not
instantiated by the e5 storage-only composition.

## Delivered behavior

- `0067_asset_metadata_backfill_executor` adds a durable e5 publication row
  keyed by owner and asset. It records the expected original hash, thumbnail
  hash, exact durable derivative operation, and `attached`/`published` state.
- The database-derived claim projects only owner, asset, immutable original
  identity, and exact job lease. Claims use `FOR UPDATE SKIP LOCKED`, database
  time, finite three-attempt retry/backoff (2 s, 8 s, then terminal), and
  allowlisted diagnostics.
- The private composition reads only through `openAssetSession`, with bounded
  byte/chunk limits, then verifies MIME, byte length, SHA-256, signature, safe
  decode limits, technical facts, and deterministic WebP thumbnail output.
- A narrow adapter operation reserves and writes only `asset_derivative` data;
  it does not create or replace the existing original or invoke the legacy
  0060 writer.
- Attachment and derivative/domain updates occur in one transaction under the
  current job lease and immutable original fence. Filesystem finalization is
  after commit. An attached operation is recovered by a fresh composition
  without re-decoding or creating another derivative.
- A matching already-finalized deterministic thumbnail supports metadata-only
  repair without a duplicate derivative. The metadata and arbitration update
  is still exact-owner, exact-asset, exact-original, live-lease fenced.
- Heartbeats occur before work and periodically through bounded
  read/hash/decode/thumbnail generation; loss prevents later attachment.

## Verification performed

- `pnpm check` — passed.
- `pnpm build` — passed.
- `pnpm exec vitest run tests/unit/task-14e3b5-composition-boundaries.test.ts`
  — 8/8 passed.
- `node scripts/check-private-storage-boundaries.mjs` — passed.
- `pnpm exec vitest run --config vitest.integration.config.ts
  tests/integration/task-14e3e5-asset-metadata-backfill.integration.test.ts`
  — real PostgreSQL and temporary filesystem, 10/10 passed: initial backfill;
  already-current replay; metadata-only and thumbnail-only repair; two-worker
  `SKIP LOCKED`; poisoned source retry/terminal/no-mutation; post-commit
  attachment reconciliation from a fresh composition; foreign rotated
  pre-attach denial; large-image decode lease loss; cross-owner shared-byte
  retention; canonical-library immutability; and injected post-commit
  finalization failure followed by trigger removal and a fresh-composition
  reconciliation to published/finalized with exactly one derivative; and
  deterministic slow valid normalization with an audit-trigger-observed
  heartbeat renewal before both completion and a separately induced lease
  rotation.
- `git diff --check` and `pjm precheck` — passed.

## Correction review focus

The review correction explicitly separates pre-commit cleanup from post-commit
recovery: after attachment succeeds, finalization errors retain the durable
attached operation and publication row for a fresh executor. Candidate-complete
rollback uses the durable cleanup projection and global-reference retention,
never a direct prewrite unlink. e3e7 remains solely responsible for worker
maintenance-lane binding.

The slow-work proofs wrap the real image normalizer with a deterministic
one-second test delay. A PostgreSQL trigger records same-lease expiry
extensions, so the tests establish an actual scheduled renewal (not just the
initial pre-work heartbeat) before successful completion and before a
rotated-lease fence aborts without attachment.
