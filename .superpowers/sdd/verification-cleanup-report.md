# Verification Cleanup Implementation Report

Date: 2026-08-16
Workspace: `C:\Users\chris\.codex\worktrees\2c9d\InfiniteQuest`

## Outcome

The cleanup restores cross-platform verification without weakening the
production secure-filesystem contract. Repository boundaries now use the
documented seams, Windows child runners execute the repository-local JavaScript
CLIs through `process.execPath`, platform-neutral API/database tests inject
explicit inert storage, and Linux descriptor-backed success paths skip by
capability on unsupported Windows. Production storage still fails closed with
`filesystem_platform_unsupported` outside Linux.

The broad repository check, production build, 182-file unit suite, canonical
65-file isolated PostgreSQL wrapper, and both final Chronicle evaluators are
green. Task 13 Step 6 is marked complete in the implementation plan.

## Strict RED/GREEN evidence

### Repository boundaries

RED:

```text
packages/domain/src/legacy-campaign-normalization.ts: legacy client compatibility must remain inside the reviewed migration boundary
packages/application/src/turn-corrections/types.ts: application import ../../../contracts/src/turn-corrections.js is outside packages/application or contracts
packages/application/src/turn-corrections/use-cases.ts: application import ../../../contracts/src/turn-corrections.js is outside packages/application or contracts
```

GREEN:

- `scripts/legacy-migration-boundary.mjs` owns the exact frozen allowlist.
- The new guard test proves the approved normalizer is accepted and an
  unreviewed marker-bearing path is rejected.
- Turn corrections import the public `@infinite-quest/contracts` package seam.
- `pnpm check` passes; the repository boundary/data checks each inspect 1,174
  candidate files.

### Windows child runners

RED:

```text
spawnSync pnpm ENOENT
spawn pnpm.cmd EINVAL
```

GREEN:

- TypeScript, TSX, and Vitest CLI paths are resolved from their installed
  packages and invoked with `process.execPath`.
- The isolated integration runner still starts one real Vitest process per
  file; the e8/e3f runner family uses the same shell-free seam.
- Focused runner/client-boundary tests: 33/33 passed.
- Benchmark/worker runner tests: 8/8 passed.

### Secure filesystem and unrelated API tests

RED:

- Positive descriptor-backed tests failed at the intentional non-Linux guard.
- Unrelated API tests failed during server construction before reaching their
  route assertions.

GREEN:

- Production defaults are unchanged and continue to fail closed outside Linux.
- Explicit inert asset/portable factories exist only as test/benchmark seams.
- Focused unrelated API unit tests: 84/84 passed.
- Focused native platform unit slice: 84 passed, 42 capability-skipped; the
  Windows fail-closed assertion remains active.
- Mixed integration files retain platform-neutral assertions while skipping
  only descriptor-dependent cases, including:
  - 14e2c adapter: 1 passed, 6 skipped;
  - 14e3d portable composition: 4 passed, 19 skipped;
  - 14e3e3 illustration publication: 1 passed, 3 skipped;
  - 14e3e4 portable normalized publication: 10 passed, 29 skipped;
  - 14e3e6 recovery: 2 passed, 9 skipped;
  - world-campaign routes: 7 passed, 1 secure-portable skip.

### Residual correctness and fixture repairs

RED/GREEN evidence gathered by the newly executable PostgreSQL wrapper:

- Generation output-limit handling progressed from 40/46, then 41/46 and
  45/46, to 46/46. Truncated length-finished JSON is now recoverable as
  `output_limit`, does not consume an internal compact-recovery request, and
  leaves accepted-turn authority unchanged.
- Image pipeline progressed from 11 passed/15 failed to 12 passed/14 explicit
  secure-filesystem skips.
- Import memory progressed from 23/25 to 24 passed/1 explicit secure export
  skip; current configuration mismatch correctly reports rebuild-required.
- Import repository progressed through reproduced cross-clock expiry failures
  to 21/21 passed by polling both application and PostgreSQL clocks.
- Play-loop performance RED was `filesystem_platform_unsupported`; GREEN is
  2/2 with the real tracked database/API read graph and inert unused storage.
- Historical 14e2c migration fixture GREEN is 1 passed/6 platform skips and
  restores all current migrations through 0075.
- Historical normalized-publication downgrade fixture GREEN is 2/2 and is
  deliberately bounded at 0069 before exercising the 0064 down guard.
- Credential bootstrap GREEN is 3 passed/1 POSIX-mode skip.
- Character Workspace dialog GREEN is 17/17.

## Broad verification

| Command | Result |
| --- | --- |
| `pnpm check` | PASS; boundary and data-safety checks each covered 1,174 candidates; all TypeScript/web checks passed |
| `pnpm test:unit` | PASS; 182 files, 2,035 passed, 44 explicit platform skips |
| `pnpm build` | PASS; contracts/application/client checks, server TypeScript build, and both legacy/replacement Vite builds |
| `node scripts/run-isolated-integration.mjs` with real `TEST_DATABASE_URL` | PASS; all 65 integration files completed in separate Vitest processes |
| `pnpm evaluate:chronicle -- --implementation legacy_hybrid ...` | PASS; recall@10 0.9117647058823529, NDCG 0.9317318575468456, p95 19 ms, zero leakage/duplicates |
| `pnpm evaluate:chronicle -- --implementation chunked_hybrid ...` | PASS; recall@10 1, NDCG 1, p95 35 ms, zero leakage/duplicates |
| `git diff --check` | PASS |

Evaluator artifacts were written to ignored temporary paths:

- `tmp/chronicle-evaluation/final-legacy.json`
- `tmp/chronicle-evaluation/final-chunked.json`

## Scope and safety

- No production path-only filesystem fallback was added.
- No secure-filesystem success assertion was converted into a fake-storage
  assertion; those cases remain mandatory when the Linux capability is present.
- Inert storage is explicit and fail-fast for unexpected storage calls.
- Historical migration tests are bounded only inside isolated test databases;
  current migration coverage still applies through 0075.
- Accepted turn authority remains unchanged; the generation regression compares
  authority snapshots around output-limit recovery.
- Unrelated `.claude/CLAUDE.md`, `AGENTS.md`, and inaccessible Repowise seed
  directories were not staged.

## Residual concern

This host is Windows, so positive `/proc/self/fd` and descriptor-anchor success
paths are reported as explicit capability skips rather than falsely claimed as
runtime-verified here. Their production fail-closed boundary is executed on
Windows; their positive-path proof remains required in Linux Docker/CI.

## Commits

- Implementation: `b6dba8869dae73bd35e50d75d4135a85cba2aab4`
- Independent review: no Critical or Important findings; ready to commit.
