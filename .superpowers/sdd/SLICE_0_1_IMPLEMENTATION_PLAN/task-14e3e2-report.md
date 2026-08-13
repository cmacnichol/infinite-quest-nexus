## Task 14e3e2 report — neutral secure publication seam

### Outcome

- Moved the descriptor-anchored secure filesystem adapter to
  `services/runtime/src/secure-filesystem-adapter.ts`. The API compatibility
  module is now an exact re-export, runtime storage composition imports the
  neutral implementation directly, and `archive-io.ts` remains API-owned.
- Added a private normalized publication port with opaque reservation and
  finalization handles. It reserves 0064 authority before the caller's parent
  transaction, attaches canonical rows and only caller-supplied children in
  that transaction, discards the exact prepared filesystem work after
  rollback, and reports post-commit finalization faults as durable recoverable
  work.
- Added a normalized-only materialization repository that attaches the
  canonical identity reserved by 0064. It does not invoke legacy 0060 identity
  preparation; it stores 0060-compatible finalization evidence only so the
  existing hardened reconciliation/finalization path can be reused.
- Added static, re-export, CommonJS, dynamic-import, public-barrel, and sole-
  consumer guards. No production route, worker, importer, illustration writer,
  scheduler, public barrel, or cross-role allowlist was bound to the seam.

### Verification

- `pnpm check` — passed.
- `pnpm build` — passed.
- `pnpm test:unit` — 131 files, 1,480 tests passed.
- Focused e2 unit matrix — 7 files, 56 tests passed.
- Focused e1/b4/b5/e2 PostgreSQL and temporary-filesystem matrix — 6 files,
  41 tests passed.
- `git diff --check` and `pjm precheck` — required before the task commit and
  recorded in the handoff after completion.

### Notes

The known-unreliable full integration harness was not used as a passing gate.
The focused real-PostgreSQL matrix covers rollback/discard, commit then
composition recreation and finalization, same-owner reuse, cross-owner shared
physical retention, exact caller-created children, and post-commit fault
recovery through the opaque handle.

## Round 1 review corrections

### Corrected behavior

- Held process-spanning content locks from the post-reservation refresh through
  physical preparation and caller-transaction attachment. Rollback cleanup now
  reacquires the same content locks when necessary and asks the durable
  repository for a global-reference-aware exact cleanup projection before any
  physical deletion.
- Added a durable prepared-only request lifecycle fence for rollback discard.
  A discard waits for the caller transaction and is rejected once attachment
  commits, preserving the canonical rows and bytes.
- Replaced the module-local finalization `WeakMap` with a branded opaque string
  containing only request/idempotency hashes. A fresh module instance resolves
  those hashes to the exact durable request in PostgreSQL, without exposing a
  raw request, owner, asset, path, or storage-bearer identifier.
- Extended the replacement boundary inventory into a module-graph traversal
  rooted at the normalized publication composition. Any reachable
  `services/api/src` implementation is rejected across static imports, named
  and export-all re-exports, CommonJS `require`, and dynamic `import()`,
  including extensionless TypeScript helper and index-module edges.

### Correction files

- `packages/application/src/assets/private-filesystem-repository.ts`
- `packages/application/src/assets/private-normalized-asset-publication.ts`
- `packages/database/src/durable-filesystem-repository.ts`
- `packages/database/src/normalized-asset-publication-repository.ts`
- `scripts/check-private-storage-boundaries.mjs`
- `services/runtime/src/asset-import-composition.ts`
- `services/runtime/src/normalized-asset-publication-composition.ts`
- `services/runtime/src/secure-filesystem-adapter.ts`
- `tests/integration/task-14e3e2-normalized-publication-composition.integration.test.ts`
- `tests/unit/task-14e3e2-boundaries.test.ts`

### Correction verification

- `pnpm check` — passed.
- `pnpm build` — passed.
- `pnpm test:unit` — 131 files, 1,481 tests passed.
- Focused adjacent unit matrix — 8 files, 60 tests passed.
- Focused e1/b4/b5/e2 PostgreSQL and temporary-filesystem matrix — 6 files,
  43 tests passed.
- Full e2 composition integration file — 8 tests passed, including concurrent
  cross-owner shared-path retention, committed-discard rejection, and
  finalization after `vi.resetModules()` invalidated process-local module state.
