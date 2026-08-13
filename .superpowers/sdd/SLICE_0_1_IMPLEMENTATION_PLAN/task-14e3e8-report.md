# Task 14e3e8 report — additive private composition parity and boundaries

## Scope and non-goals

This checkpoint adds test/guard evidence only. It does not bind a Fastify
route, a runtime default, a worker loop, a public barrel, deployment config, or
a legacy writer. The production binding switch remains Task 14e3g.

## Delivered

- Expanded the e8 plan into e8a–e8d with exact composition inventory,
  transitive-boundary, real-composition, and pool/budget acceptance criteria.
- Added `scripts/check-private-composition-parity-boundaries.mjs`, which freezes
  all nine e3e0–e3e7 private factories and their exact private importers. It
  parses static imports, re-exports, CommonJS `require`, and literal dynamic
  imports; rejects extra/live consumers; traverses replacement graphs; and
  rejects API, worker, runtime-main, retained legacy authority/writer, second
  pool, and application/contracts/domain/runtime private-barrel leakage.
- Added five executable e8 guard cases proving both the accepted inventory and
  rejection behavior for live/public consumers, transitive legacy/API reach,
  private-contract re-export, and a replacement-created pool. The guard now
  resolves extensionless relative static, re-export, CommonJS, and dynamic
  targets only through scanned exact `.ts` or directory-index candidates, and
  scans the secure-storage root itself for legacy writers and pool construction.
- Added an e8-owned real PostgreSQL pool/result matrix. It exercises the private
  scheduler through success, fault, abort, and drain, measures exactly three
  borrows and three releases with no retained client and capacity one, and
  injects hostile path, descriptor, bearer, credential, URL, raw-error, and
  private-handle-shaped values to prove only safe diagnostic projections leave
  the private boundary.
- Added `pnpm test:e8:integration`, a checked-in controlled serial runner that
  launches a separate config-driven Vitest process for each e1c/e2/e3/e4/e5/e6/
  e7/e8 focused matrix. Each child executes its own isolated-database lifecycle,
  so fixed initial-owner and durable-lease fixtures cannot collide across files.
- Added an adversarial capacity guard that parses the executable
  `requiredWorkerConnections` conditional for exact `generation + 4` worker and
  `generation + 8` all-process formulas. It strips YAML comments before checking
  each relevant Compose/Swarm role's connection/concurrency defaults, so comment
  spoofing cannot pass; a hostile `+4/+8` comment with executable `+5/+9`
  branches is rejected. It also excludes private maintenance from the live worker
  and manifests.
- Corrected `0064_normalized_asset_publication_requests.sql`. Existing legacy
  asset labels were not guaranteed to be SHA-256 digests, but 0064 created a
  strict 64-lowercase-hex arbitration table and therefore aborted before any
  later repair migration could execute. Only nonconforming legacy labels now
  receive a deterministic SHA-256 sentinel derived from owner UUID plus asset
  UUID, never from the raw label; both the 0064 backfill and retained legacy
  insert trigger force `verification_required`. Valid hashes retain the strict
  check and verified semantics. The test proves a normalized request cannot
  reuse the legacy sentinel.
- Updated the e3e1b downgrade helper to roll back 0067–0064, not only two
  migrations, before checking the pre-0064 schema.
- Strengthened the 0064 regression with the same invalid legacy label on two
  distinct owner/asset rows. The test checks exact owner+asset-derived SHA-256
  sentinels, non-raw values, distinctness, `verification_required`, and blocked
  normalized reuse for both rows.
- Added plan guidance requiring real-PG focused files to use isolated
  databases/schemas (or serial equivalent) because their shared initial-owner
  and lease fixtures collide under cross-file concurrency.

## Verification

- `pnpm exec vitest run tests/unit/task-14e3e*.test.ts` — 11 files, 50 tests
  passed.
- `pnpm exec vitest run tests/unit/task-14e3e8-composition-parity-boundaries.test.ts`
  — 7 tests passed, including extensionless static/re-export/CommonJS/dynamic,
  secure-storage hostile probes, and comment-spoofed capacity/manifests.
- `pnpm exec vitest run tests/integration/task-14e3e1b-publication-authority.integration.test.ts`
  — 2 tests passed; covers invalid legacy rows before and after 0064.
- `pnpm test:e8:integration` — passed. The checked-in isolated runner covers
  the selected e1c/e2/e3/e4/e5/e6/e7/e8 private-composition matrix in separate
  Vitest/config/database invocations.
- Each real-PG e3/e4/e5/e6/e7 focused file was run independently against a
  fresh temporary database. All commands passed; the e6 blocked-lease case
  passed 1/1 (10 deliberately skipped) and the e7 scheduler suite passed 4/4.
- `pnpm check` — passed.
- `pnpm build` — passed.

## Known harness condition

One combined five-file e3–e7 Vitest invocation against a single fresh database
failed in e6/e7. Re-running each file with its own database passed, establishing
test-fixture/lease interference rather than a private-composition regression.
This is logged as projectmem issue #0748 and is reflected in the e8d plan.

## Completion assessment

The additive e8 guards and focused composition evidence are complete and remain
private. The next authorized step is e3f production-composed parity; e3g is the
only live binding switch.
