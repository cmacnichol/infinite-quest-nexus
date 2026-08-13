# Task 14b3 — Atomic Chronicle consumer cutover

## Status

DONE_WITH_CONCERNS. Live API routes, worker entry, generation executor and
accepted-turn transaction path, campaign transfer, world creation, import,
state correction, rewind, and branch consumers now use the Chronicle
application transaction port rather than importing the legacy API memory
callbacks. The worker-to-API allowlist entry is removed.

The remaining concern is explicit: `services/runtime/src/memory-composition.ts`
still encapsulates the existing `runChronicleJob` body from
`services/api/src/memory-service.ts` to preserve full job execution behavior.
The worker itself does not import API code, but the legacy body is not yet
physically removed, so the strict “no callable legacy memory path” completion
criterion is not met by this commit.

## Touched files

- `services/api/src/memory-application-adapter.ts` — owner-scoped route adapter
  and transition binding for caller-owned transaction consumers.
- `services/api/src/server.ts` — six Chronicle routes and job read use the
  injected `MemoryApplication`.
- `services/worker/src/worker.ts` — optional Chronicle lane uses an injected
  `MemoryWorkerApplication`; no API import remains.
- `services/runtime/src/{main,runtime-role,memory-composition,generation-worker-composition,generation-executor-adapter}.ts`
  — runtime composition and generation now pass the typed Chronicle application
  and transaction port.
- `packages/database/src/generation-execution-repository.ts` — accepted-turn
  rebuild, derived memory, accepted-fiction write, and embedding enqueue use
  the caller-owned memory transaction port.
- `services/api/src/{world-service,import-service,campaign-state-service,campaign-transfer-service,generation-service}.ts`
  — corresponding explicit owner/campaign/world-version transaction scopes.
- `scripts/check-client-boundaries.mjs` — removes the Chronicle exception.
- `tests/unit/{memory-cutover,generation-executor-adapter,runtime-generation-composition}.test.ts`
  — cutover and changed collaborator contracts.

## Consumer inventory

| Consumer | Cutover destination |
| --- | --- |
| Memory routes and Chronicle job read | `MemoryApplication` via API adapter |
| Worker Chronicle lane | `MemoryWorkerApplication.runNextChronicle` |
| Generation context and accepted-turn writes | `MemoryGenerationTransactionPort` |
| World, import, state correction, transfer, rewind, branch | Explicit caller-owned `MemoryGenerationTransactionPort` scopes |
| Worker/API boundary exception | Removed from `CROSS_ROLE_IMPORT_ALLOWLIST` |

## Legacy paths removed

- Removed the direct `services/worker -> services/api/memory-service` import.
- Removed all five named Task 10d generation memory callback properties from
  `GenerationExecutionCollaborators`.
- Replaced the accepted-fiction direct Chronicle insert with
  `writeAcceptedTurnFiction` on the typed transaction port.

## Verification

- `pnpm check` — passed.
- `pnpm build` — passed.
- `pnpm vitest run tests/unit/memory-cutover.test.ts tests/unit/chronicle-runtime-adapter.test.ts tests/unit/generation-executor-adapter.test.ts tests/unit/runtime-generation-composition.test.ts tests/unit/worker-generation-adapter.test.ts` — passed: 5 files, 19 tests.
- `node scripts/check-client-boundaries.mjs` — passed.
- `git diff --check` — passed.

## Commit

`21f0722` — `refactor(memory): cut over Chronicle consumers`

## Correction round 1 — issue #0366

The API-owned `memory-service.ts` source was relocated to the runtime-owned
`services/runtime/src/chronicle-platform-service.ts`. Its full Chronicle job
body is split into `runClaimedChronicleJob`, which receives the already claimed
runtime job, and a compatibility direct-runtime entry retained only for tests.
`createLiveWorkerMemoryApplication` now constructs the direct worker
application and invokes that runtime-owned claimed-job body after the direct
state/retrieval ports have established the claim.

Regression coverage extends `tests/unit/memory-cutover.test.ts` to reject an
API memory-service import from all live runtime composition and to require the
direct worker application plus `runClaimedChronicleJob` dispatch seam.

Commands run during this correction:

- `pnpm vitest run tests/unit/memory-cutover.test.ts` — red before the move:
  runtime composition imported `../../api/src/memory-service.js`.
- `pnpm exec tsc -p tsconfig.json --noEmit && pnpm vitest run tests/unit/memory-cutover.test.ts tests/unit/chronicle-runtime-adapter.test.ts tests/unit/worker-generation-adapter.test.ts` — passed: 3 files, 15 tests.
- `pnpm vitest run tests/unit/memory-cutover.test.ts tests/unit/chronicle-runtime-adapter.test.ts tests/unit/generation-executor-adapter.test.ts tests/unit/runtime-generation-composition.test.ts tests/unit/worker-generation-adapter.test.ts` — passed: 5 files, 19 tests.
- `pnpm check` — passed.
- `pnpm build` — passed.
- `git diff --check` and `node scripts/check-client-boundaries.mjs` — passed.

## Resolution

Issue #0366 is resolved in `ad9dbc1` — `refactor(memory): move Chronicle
worker body to runtime`. The former API module no longer exists. The live
worker claims, retrieves, heartbeats, completes, and fails through the direct
Chronicle application ports, then runs the runtime-owned Chronicle body.

Final verification after the correction:

- `pnpm check` — passed.
- `pnpm build` — passed.
- `pjm precheck` — passed.
- `git diff --cached --check` and `node scripts/check-client-boundaries.mjs` — passed.

## Recovery completion — 2026-08-05

### Final status

DONE. The recovery work completes the atomic Chronicle cutover that the
earlier report left unfinished. There is now one runtime-composed API memory
application, one runtime-composed worker memory application, and one direct
generation transaction port. No credentialless, optional, pool-created,
throwing, compatibility, forwarding, or callable legacy Chronicle fallback
remains.

The final commit subject is `refactor(memory): complete Chronicle cutover`.
The final SHA is returned in the implementation handoff because a commit
cannot contain its own content-derived SHA.

### Architecture completed

- API server routes receive a required `MemoryApplication`; transaction-owning
  world, campaign, transfer, import, archive, rewind, branch, state-correction,
  and generation services receive the exact caller-owned
  `MemoryGenerationTransactionPort`.
- The live worker retrieves bounded pages and commits each embedding batch
  through `commitClaimBatch` in a lease-fenced transaction. Stable totals and
  monotonic progress are retained across pages. A lost or superseded lease
  stops before the next page, and newer work is requeued only through the
  guarded completion transition.
- Full metrics and preview behavior are implemented on PostgreSQL ports,
  including exact history/compression counts, owner/campaign/world scope,
  fresh-vector coverage, safe job failure projections, context-preview parity,
  prompt-safe sanitized continuity scratchpads, and replacement-turn cutoffs.
- `services/api/src/memory-service.ts` and
  `services/runtime/src/chronicle-platform-service.ts` are absent. Static
  inventory rejects their paths and every retired callable symbol.
- The play-loop benchmark and all test-only service callers use the same
  composed application/transaction seams as production.

### TDD evidence

- Baseline full unit run was red: 7 failed, 1,210 passed. The first focused
  recovery run was red with 8 failures.
- Guarded-worker contracts went green at 3 files / 11 tests; the initial
  cutover focus went green at 7 files / 41 tests.
- Compiler and negative-inventory failures were driven to green before legacy
  deletion. The exact forbidden-symbol `rg` audit now returns no matches.
- The metrics route integration started red with 5 failures; fixture metadata,
  route parity, exact nonzero metrics, 1/3 fresh-vector coverage, running job
  progress, safe failure projection, and missing/foreign 404 behavior are now
  green.
- Concurrent enqueue recovery first reproduced a running job that failed to
  requeue. A unit regression was red because `completeClaim` was never called;
  the guarded stale-claim transition is now green, while ordinary provider
  errors still call `failClaim`. The isolated PostgreSQL race and the combined
  import/contract matrix are green (40/40).
- The seven-file generation matrix then exposed three real contract
  regressions: prompt-safe scratchpad omission, a misplaced replacement cutoff,
  and the resulting missing edited-state wording. An explicit repository unit
  assertion was red before sanitized scratchpad projection was restored; the
  three focused generation regressions are green (3/3), followed by the full
  prescribed matrix (121/121).
- Full integration exposed the benchmark's stale required-argument caller.
  After composing the same API memory application for benchmark seed and route
  paths, its focused suite is green (2/2).

### Final verification

- Guarded worker/cutover unit matrix: 6 files, 36 tests passed.
- Legacy deletion gate: both files absent; forbidden-symbol scan clean;
  cutover/illustration tests 16/16 passed; client boundary check passed.
- Prescribed integration matrix: 7 files, 121 tests passed.
- `pnpm test:unit`: 106 files, 1,220 tests passed.
- `pnpm test:integration`: 25 files, 264 tests passed.
- `pnpm check`: passed.
- `pnpm build`: passed.
- `git diff --check`: passed.
- `pjm precheck`: passed.

### Commit scope

The atomic commit contains only these Task 14b3 paths:

- `.superpowers/sdd/SLICE_0_1_IMPLEMENTATION_PLAN/task-14b3-report.md`
- `packages/application/src/memory/{ports,types}.ts`
- `packages/database/src/chronicle-repository.ts`
- `scripts/benchmark-play-loop.mjs`
- `services/api/src/{archive-routes,campaign-state-service,campaign-transfer-service,generation-service,import-service,infinite-worlds-import-service,memory-application-adapter,server,world-service}.ts`
- `services/runtime/src/{chronicle-platform-adapter,chronicle-worker-execution,generation-executor-adapter,generation-worker-composition,main,memory-composition,runtime-role}.ts`
- deleted `services/runtime/src/chronicle-platform-service.ts`
- `services/worker/src/worker.ts`
- `tests/helpers/{build-server-options,generation-worker-harness,memory-applications,memory-aware-services}.ts`
- `tests/integration/{campaign-state-corrections,campaign-transfer,cyoa-import,generation-events,generation-execution-repository,generation-repository,generation,illustration-repository,illustration-routes,image-pipeline,import-memory,prompt-library,world-generation,world-library}.integration.test.ts`
- `tests/unit/{asset-archive-service,chronicle-runtime-adapter,chronicle-transaction-repository,chronicle-worker-execution,client-api-routes,client-boundaries,memory-cutover,runtime-generation-composition,runtime-role-composition,semantic-memory-auto-enable,worker-concurrency,worker-generation-adapter}.test.ts`

Unrelated shared-worktree configuration, agent guidance, architecture/review,
and UI documentation changes were preserved and excluded from staging.

### Residual concern

Metrics correctness requires hashing campaign memory content to distinguish
fresh vectors from stale vectors. This is validated and bounded by campaign
scope, but may deserve a future stored-hash/index optimization for exceptionally
large campaigns; it does not leave a compatibility or correctness gap.
