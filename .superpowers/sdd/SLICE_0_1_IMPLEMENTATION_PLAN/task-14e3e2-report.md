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
