# Modular Client, Backend Boundary, and Slice 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use
> `superpowers:subagent-driven-development` (recommended) or
> `superpowers:executing-plans` to implement this plan task-by-task. Every work
> package is a separately reviewable change and must keep its tests green before
> the next package starts.

**Goal:** Make the UI replaceable without reimplementing application behavior,
move backend orchestration behind stable application ports, and improve browser,
API, database, and worker performance without weakening durable-generation
integrity.

**Architecture:** Pure workflow and state-transition logic lives in
`packages/client-core`; browser-specific HTTP, SSE, storage, clock, and timer
adapters live in `packages/client-web`; rendering lives in `apps/`. Shared Zod
schemas define both request and response contracts. Backend use cases move
incrementally behind `packages/application`, while Fastify, PostgreSQL, provider,
and worker code remain replaceable adapters around those use cases.

**Tech stack:** TypeScript 7, Node.js 22+, pnpm, Zod 4, Fastify, PostgreSQL,
Vitest, Vite, the selected component framework, Testing Library, happy-dom,
Playwright, and axe-core.

**Parent documents:** [`CLIENT_CORE_BOUNDARY.md`](./CLIENT_CORE_BOUNDARY.md),
[`FRONTEND_IMPLEMENTATION_PLAN.md`](./FRONTEND_IMPLEMENTATION_PLAN.md)

**Grounded at:** commit `ad73dc1`

### Authority and specification reconciliation

This is the controlling execution plan for Slice 0/1. The parent documents
remain the product and migration specification, but several implementation
details in them predate direct verification of the current repository. Where
they conflict, use these reviewed corrections and update the parent documents
in the owning task rather than reintroducing a known defect:

| Older statement | Controlling requirement in this plan |
|---|---|
| HTTP/API behavior lives in pure `client-core` | Pure policy stays in `client-core`; Fetch, EventSource, storage, timers, and runtime Zod response parsing live in framework-free `client-web` |
| Slice 0 adopts all routes and removes every app-level `fetch()` | Endpoint adoption is incremental and schema-first; C8 adopts the complete legacy play-loop and Slice 1 surface, while management routes move in their owning later slice |
| Build one generic watcher for generation, image, Chronicle, and world-cover jobs | C6 reduces the shipped `GenerationEvent` family only; a generic watcher waits until two families have shared schemas, typed clients, terminal predicates, and browser sources |
| Lift the legacy Story Player state object largely as-is | C6 stores only authoritative, contract-validated projections; DOM, view, timer, modal, and cancellation state remains app-owned |
| Rewrite both `story.js` and `nexus.js` before framework work | C8 proves the generation boundary against `story.js`; the management client remains on its named transitional allowlist until its replacement slices |
| Streaming narration is deferred | `OPEN_QUESTIONS.md` Q1 is resolved: `partialNarration` is rendered today and must remain progressively, safely rendered |
| Active generation cancellation is unimplemented | The current API and typed client expose explicit durable `/cancel`; local watcher detach remains a separate, non-cancelling action |
| Dark-only is the default design-system scope | `OPEN_QUESTIONS.md` Q8 requires dark and light color roles from the first replacement token layer; U1/U2 decide and test the user-facing selection behavior |
| Worker concurrency is merely a later optimization | The parent boundary document names it as a UI prerequisite, and the backend-first policy now makes B1/B2/B3/B4b/B5 plus the backend audit one hard gate before U1 |

The implementation task that resolves a stale statement must update every
affected UI document named under **Documentation alignment**, not only this
plan. A checked task may not leave its governing specification knowingly
contradictory.

---

## Completion status

Runtime implementation reviewed through `57147c7` and Task 12 operational
documentation aligned through `8593e3e` on branch `wip/main-uncommitted`.
None of Track C is merged to `main` yet; `main` is at `ad73dc1` and does not
contain this plan.

| Task | Package | Status | Evidence |
|---|---|---|---|
| Task 1 | C0 — baseline, ADR, boundary tests | **Complete** | `04ccb6c`, `d9474f0` |
| Task 2 | C1 — play-loop request/response contracts | **Complete** | `128cc53`, `ff9a420` |
| Task 2a | C1a — stream projection remediation | **Complete** | `ca255a7`, `1fb1b30`, `26d5890`, `fb4b5ad`; focused contract/route lifecycle tests; reproducible 2,000-turn validation benchmark; Task 6 clean-stream-closure fallback regression |
| Task 3 | C2 — pure and Web-platform client packages | **Complete** | `1e55517`, `f8dfe6e`; scoped implementation review and fix re-review clean |
| Task 3a | C2a — make the declared client boundary real | **Complete** | `f8c2b3d`, `cd43787`; scoped implementation review and fix re-review clean |
| Task 4 | C3 — validating HTTP transport and typed API client | **Complete** | `2bba1a3`, `15f6454`, `996a129`, `0ad6033`; scoped review plus three fix re-reviews clean |
| Task 4a | C3a — transport path boundary and dependency consistency | **Complete** | `7bf07fc`, `993b7b6`, `0fdcb9b`; scoped review and fix re-review clean |
| Task 5 | C4 — pure durable-generation workflow | **Complete** | `92aa9c4`; scoped review plus two fix re-reviews clean |
| Task 5a | C4a — discriminate and canonicalize pending submissions | **Complete** | `0904291`; scoped implementation review clean |
| Task 6 | C5 — browser transports, persistence, and adaptive polling | **Complete** | `89915f3`, `ba9ea90`; scoped review, final review, and focused fix re-review clean |
| Task 7P | C6 prerequisite — live replacement provenance and hydration contract | **Complete** | `20f13b9`, `cc79906`; discriminated stream/pending provenance carried through enqueue, retry, SSE, polling, and fallback |
| Task 7a | C6 stage 1 — store primitive | **Complete** | `cc79906`; `Object.is` identity, deep-readonly `Immutable<T>`, package-internal writable handle |
| Task 7b | C6 stage 2 — campaign/runtime projection and selectors | **Complete** | `9773cd5`, `3a6411d`; all six campaign protocol guards; 813-line campaign-store suite |
| Task 7c | C6 stage 3 — generation projection and event reduction | **Complete** | `aef77d9`, `b3b7844`, `9e8d5f1`; all five generation protocol guards; every `GenerationEvent` reduced |
| Task 7d | C6 stage 4 — Track C exit audit | **Complete** | `4206316`, `7c95432`; `docs/review/2026-08-03-task-7d-track-c-exit-audit.md` |
| Task 8 | C7 — static build and deployment contract | **Complete** | `175a854`, `d48e70a`, `3364bd0`, `05d89c3`, `afdc1c0`, `cb45bcc`; scoped reviews and final fix re-review clean |
| Task 9 | C8 — current Story Player boundary proof | **Complete** | Gate 1 `9cca4e7`, `cac241a`; Gate 2 `4bcd3de`; focused and full verification; clean Gate 2 revert rehearsal; detail in `docs/review/2026-08-02-task-9-c8-completion.md` |
| Task 13a | B4a — bounded history and authoritative resume contracts | **Complete** | `b70844c`, `26cd735`, `6e5753d`; two scoped fix re-reviews clean; real-PostgreSQL 55-turn, recovery, and snapshot-race coverage |
| Task 13a-R | B4a corrective gate — scoped pages and replacement recovery | **Complete** | `5f156ac`, `1ae0dd1`; migration 0051; full check/build/unit/integration; scoped review/re-review clean |
| Task 10 | B1 — generation application boundary | **Complete** | Final full-range approval of `885bcde..653c7c8`; completion audit `76c1a22`, correction `653c7c8`; Task 11 authorized 2026-08-04 |
| Task 11 | B2 — notification-backed SSE delivery | **Complete** | `d76beb8`; scoped implementation review approved; focused 65/65, full unit 1,127/1,127, relevant real-PostgreSQL 56/56; notification-to-frame p95 7.812 ms |
| Task 12 | B3 — worker concurrency and fair lanes | **Complete** | Implementation `312ebaa`, correction `57147c7`, docs `8593e3e`; scoped implementation review plus clean correction re-review; full unit 1,150/1,150, implementation full PostgreSQL 232/232, correction-relevant PostgreSQL 68/68; C0 concurrency 1/2/4 benchmark and duplicate-turn guard passed |
| Task 13b | B4b — play-loop read profiling/optimization | **Complete** | Implementation `1d6b766`, correction `ff7f56e`; scoped review and correction re-review approved; full unit 1,156/1,156, full PostgreSQL 234/234, C0 read benchmark passed |
| Task 14a | B5a — illustration and image jobs (removes 3 cross-role entries) | **Complete** | `e2a15e6` through `c7c8353`; contracts, cutover, durability, privacy, ownership, and all 18 Fastify route-parity gates independently approved |
| Task 14b | B5b — Chronicle memory and embeddings (removes 1) | **Complete** | `3e0dc8b` through `d32cefb`; 14b1–14b4 contracts, direct bindings, PostgreSQL matrix, atomic cutover, and completion audit independently approved; the current controller evidence is 1,228 unit/271 integration/check/build/diff/precheck passed |
| Task 14c | B5c — worlds, versions, campaign management (removes none) | **In progress** | 14c1 contracts (`dc1de51`–`99ef161`) and 14c2a world/campaign-lifecycle adapters (`7ccf786`, `dc73210`, `9a8387d`) are complete and independently reviewed; 14c2b campaign authority/state adapters are active |
| Task 14d | B5d — providers and prompt configuration (removes none) | Not started | — |
| Task 14e | B5e — imports, exports, archives, assets (removes 1) | Not started | — |
| Task 14f | Backend completion audit / UI authorization | Not started | — |
| Task 15–20 | U1-U6 — replacement UI | Blocked on Task 14f | — |

**Current Task 11 verification (2026-08-04, complete; scoped review
approved).** Commit `d76beb8395b2f437cd21bb9718922d41e654c091`
replaces the fixed 350 ms SSE database polling loop with transaction-coupled
PostgreSQL notification hints while preserving the existing SSE wire schema.
Migration 0052 installs the versioned
`infinitequest_generation_changed_v1` trigger path: notifications remain
invisible before commit, arrive after commit, do not survive rollback, cover
every SSE-visible `generation_jobs` transition, and remain silent for
lease-heartbeat-only updates. The notification carries only `jobId` and an
opaque version; every delivered frame still comes from a fresh authoritative,
owner/campaign/job-scoped database read.

Each `api` or `all` process owns one dedicated long-lived listener outside the
request pool, with validated bounded payloads, in-memory authorized fan-out,
bounded jittered reconnect, and re-`LISTEN`; `worker` and `migrate` construct no
listener. The SSE route performs the required first scoped read, registration,
and immediate second scoped read, then consumes wake-up hints plus one bounded
15-second reconciliation cadence. Idle streams perform no former 350 ms query
loop, and subscriptions close exactly once on terminal, client-close, error,
and API-shutdown paths.

Fresh verification passed: focused Task 11 units **65/65 across 5 files**,
the full unit suite **1,127/1,127 across 94 files**, and the relevant real-
PostgreSQL generation-event, migration, and generation suites **56/56 across 3
files with zero skips**. `pnpm check`, `pjm precheck`, and diff checks also
passed. A real Fastify/PostgreSQL SSE run measured **7.812 ms p95** across
**20 samples** with a **10.066 ms maximum** and 23 authoritative job reads; an
idle 500 ms interval added no reads. The fan-out test opened **8 simultaneous
streams** against a request pool with **max 3**, observed no waiting checkout,
and confirmed exactly **one dedicated listener**. Measurements used Node
24.18.0, pnpm 11.18.0, Docker Engine 29.7.0, and PostgreSQL 18.4 on Linux
6.8.0-136-generic. The independent scoped reviewer approved Task 11. This block
records Task 11 completion only; UI work remains blocked until Task 14f.

**Current Task 12 verification (2026-08-04, complete; correction re-review
approved).** Implementation commit `312ebaa` adds the frozen 1-4
`WORKER_GENERATION_CONCURRENCY` setting, role-safe connection budgets,
configurable story slots, and separately bounded illustration, Chronicle, and
asset lanes. Scheduler passes retain the required generation → illustration →
Chronicle → asset order, isolate lane failures, stop claims on shutdown, and
drain active work without passing the scheduler signal into story execution.
Compose and Swarm now provide a ten-minute worker stop grace. The existing
runtime lifecycle already kept provider and database resources open through
worker drain, so Task 12 characterized that ordering rather than changing it.

The scoped implementation review found one Important issue: a poll wait that
lost `Promise.race` to instant active work retained its timer and abort listener
until interval expiry. The RED correction regression measured **25 outstanding
listeners after 25 fast rotations**. Correction commit `57147c7` makes the race
wait explicitly disposable and cleans it in `finally`; the focused correction
re-review found no remaining Task 12 issue and the regression now passes without
cross-rotation accumulation. Commit `8593e3e` records the concurrency, pool,
shutdown, rolling-update, image-independence, benchmark, and C0 operating
guidance in the deployment and testing documentation.

Fresh post-correction verification passed `pnpm check`, `pnpm build`, the full
unit suite (**1,150/1,150 across 95 files**), and the correction-relevant real-
PostgreSQL generation/image suites (**68/68 across 2 files**). The implementation
checkpoint also passed the full real-PostgreSQL suite (**232/232 across 20
files**). `pjm precheck`, staged and unstaged diff checks, multi-replica slot
fill, lease-reclaim/stale-worker fencing, image attempt exhaustion, and the
duplicate-turn guard all passed.

The final deterministic benchmark ran in a reported `targetSatisfied` C0 worker
container (**2 vCPU / 4 GiB**), seed `task-12-c0-worker-v1`, with 5 warm-ups and
30 measured samples per batch, 12 story jobs and 3 jobs per optional lane per
sample. Selected mean/median throughput was **27.224131 / 27.315826 jobs/s** at
concurrency 1, **50.264285 / 50.297259** at 2, and **83.736372 / 85.421612** at
4. Database peak/active connections were **5/5, 6/6, and 8/8**; story peaks were
**1, 2, and 4**, while every optional lane stayed at **1**. Concurrency 4's
first-batch CV was **7.6185%**, so the required three-batch rerun executed and
selected batch 0 by median throughput; the selected CV remains reported rather
than concealed. Task 14a is the next backend checkpoint. UI work remains
blocked until Task 14f explicitly authorizes U1.

**Current Task 13b verification (2026-08-04, complete; scoped review and
correction re-review approved).** Implementation commit `1d6b766` adds the
repeatable play-loop benchmark, a pool/client-keyed `initialOwnerId` cache with
rejected-promise eviction and real two-database isolation coverage, a one-query
unchanged-sync fast path, and a bounded latest-turn lookup that removes the
history fingerprint's all-ID aggregate sort. Public request/response schemas,
cursor and sync-token formats, polling, and SSE behavior remain unchanged.
Measured plans did not justify migration 0053: the history fingerprint moved
from 1.028 ms / 330 shared-hit blocks to 0.584 ms / 251, while the sync query
completed in 0.356 ms with no physical or temporary I/O. Avoiding a new index
also avoids unmeasured write amplification on every accepted turn/job.

Fresh verification passed `pnpm check`, `pnpm build`, the full unit suite
(**1,156/1,156 across 96 files**), and the full real-PostgreSQL suite
(**234/234 across 21 files**), plus `git diff --check` and `pjm precheck`.
The final benchmark reported `targetSatisfied: true` in the C0 API profile
(**2 vCPU / 4 GiB**), PostgreSQL 18.4, seed `task-13b-c0-play-loop-v1`, 5
warm-ups, and 30 measured samples. Replacement sync p95 improved **31.1%**,
unchanged sync p95 improved **29.8%** while dropping from six queries to one,
and first/middle/last history p95 improved **20.9% / 18.1% / 17.6%**. The long
fixture proved exact 50-turn first/middle/last and initial-sync windows with the
expected first/last cursor boundaries; route query counts were stable at
**1 / 2 / 6 / 1 / 5 / 1 / 2 / 7** for campaign list, dashboard, replacement
sync, unchanged sync, each history page, polling, result, and initial hydration.
Correction commit `ff7f56e` pins those exact per-sample counts and bounded-read
facts rather than accepting only upper budgets. The independent scoped reviewer
approved the implementation, and the correction re-review found no remaining
Task 13b issue. Task 14a is next; no UI task is authorized before Task 14f.

**Current Task 2a verification** (re-measured during the Task 2a completion
review; the figures below replace an earlier stale count of 700 tests across 65
files and 468 candidate files):

- `pnpm check` passes — 470 candidate files for both the boundary and
  data-safety checks.
- `pnpm build` passes.
- `pnpm test:unit` passes **702/702 across 66 test files**.
- `pnpm test:integration` passes — **190 passed, 2 skipped across 17 files**.
  This run matters to Task 2a specifically: Task 2a changed
  `tests/integration/gameplay.integration.test.ts` to validate the polling route
  through `generationJobSnapshotSchema` instead of the now-narrowed stream
  schema, and that assertion was previously unverified. Confirmed passing
  individually as well (5/5 in `gameplay.integration.test.ts`).
- `pnpm check:web-bundle-budget` correctly reports as report-only because
  `apps/web-next/dist` does not yet exist.
- `pnpm exec tsx scripts/benchmark-client-contracts.ts` reproduces the figures
  recorded in ADR 0028 exactly: 229 / 492 / 326 payload bytes, 2 / 3 / 2 frames,
  `leaseOnlySnapshotChangesFrame: false`.

**Client compatibility check.** Narrowing the stream projection to eleven fields
does not regress the legacy Story Player: its SSE consumers
(`handleJobUpdate`, `updateGenerationProgress`, and the `onmessage` status
branches in `apps/web/src/story.js`) read only `status`, `partialNarration`,
`action`, `errorMessage`, and `resultTurnId`, all of which are in the allowlist.

**Known environment constraint.** The integration harness provisions
`infinitequest-integration-postgres` from a Compose file with a persistent named
volume, but `POSTGRES_PASSWORD` only takes effect when that volume is first
initialized. Regenerating `.env.test.local` afterwards — which happens
per-worktree, since the file is gitignored — permanently desynchronizes the
stored role password from the environment file, and
`pnpm test:integration` then fails at global setup with `password
authentication failed for user "infinitequest_test"`. Recovery without
destroying the volume:

```bash
PW=$(grep '^POSTGRES_PASSWORD=' .env.test.local | cut -d= -f2-)
printf "ALTER ROLE infinitequest_test PASSWORD :'pw';\n" \
  | docker exec -i -e PW="$PW" infinitequest-integration-postgres \
    bash -c 'psql -U infinitequest_test -d postgres -v pw="$PW" -f -'
```

Multiple worktrees sharing one container will keep re-triggering this. Task 20
(U6) should either pin the credentials to a committed non-secret test default or
detect and repair the mismatch inside `scripts/ensure-test-database.mjs`.

**Current Task 3 verification:**

- `pnpm check` passes and now includes both package-local type checks — 481
  candidate files for the repository boundary and data-safety checks.
- `pnpm build` passes and runs the pure-core and Web-package checks before the
  root build.
- `pnpm test:unit` passes **708/708 across 66 test files**.
- Real TypeScript fixture projects prove the pure-core compiler rejects Web,
  Node, and framework dependencies while the Web adapter compiler accepts
  framework-free implementations of core ports.
- The scoped Task 3 review found two issues; `f8dfe6e` addressed both, and the
  fix re-review found no new Critical or Important breakage.

**Current Task 3a verification:**

- `pnpm check` and `pnpm build` pass; the repository and data-safety checks
  cover 484 candidate files.
- `pnpm test:unit` passes **711/711 across 66 test files**.
- `pnpm test:integration` passes — **190 passed, 2 skipped across 17 test
  files**.
- A value-level compiler fixture proves pure `client-core` can import and use
  the public contracts barrel without DOM or Node ambient types. The boundary
  scanner separately rejects reachable Node and framework imports while
  allowing the explicitly non-exported Node-only archive helper.
- The scoped Task 3a review found two omissions; `cd43787` addressed both, and
  the fix re-review found no new Critical or Important breakage.

**Current Task 4 verification** (measured on `0ad6033` during the Task 4
completion review; this block was missing when Task 4 was first marked
complete):

- `pnpm check` and `pnpm build` pass; the repository and data-safety checks
  cover 492 candidate files.
- `pnpm test:unit` passes **748/748 across 69 test files**.
- `pnpm test:integration` passes — **190 passed, 2 skipped across 17 test
  files**.
- All eleven adopted endpoints match the scope table by method, path, and
  shared schema; every dynamic path segment is `encodeURIComponent`-escaped;
  request validation runs before the transport with zero fetches on failure.
- `it.each([408, 409, 425, 429, 500])` proves each performs exactly one fetch,
  and the authorization replay cannot exceed two.
- `expectTypeOf` proves `NexusApiClient` exposes only the three deliberate
  groups and that `GenerationApi` is assignable to Task 5's
  `GenerationApiPort`.
- The completion review found four gaps, tracked as **Task 4a**. None blocks
  Task 5; P1 should land before Task 6 builds paths against the transport.

**Current Task 4a verification** (measured on `0fdcb9b` during the Task 4a
completion review):

- `pnpm check` and `pnpm build` pass; the repository and data-safety checks
  cover 492 candidate files.
- `pnpm test:unit` passes **752/752 across 69 test files**.
- `pnpm test:integration` passes — **190 passed, 2 skipped across 17 test
  files**.
- `pnpm install --frozen-lockfile` passes, confirming `pnpm-lock.yaml` matches
  the client-core `package.json` after the inert `zod` dependency was removed.
  The lockfile now records `packages/client-core: {}`.
- P1 is verified against every dot-segment spelling the WHATWG URL parser
  normalizes, not only the literal one: `/../admin`, `/./worlds`,
  `/%2e%2e/admin`, `/%2E%2E/admin`, `/.%2e/admin`, `/%2e./admin`,
  `/%2e/worlds`, `/worlds/../../../admin`, `/..?x=1`, and `/..#f` are each
  rejected with **zero fetches and zero `SessionPort` calls**. Bad base paths
  (`/api/v1/..`, `/api/v1/%2e%2e`, `/api/./v1`) throw at client construction.
- The fix does not over-block. `/worlds` under both the root and nested base
  paths, the legitimate dotted segment `/worlds/v1.2.3`, and the double-encoded
  `/a/%252e%252e/b` all still resolve inside their base path. Double encoding is
  correctly allowed because it produces a literal segment that does not
  traverse.
- `decodeURIComponent`-based segment comparison covers all four double-dot
  spellings (`..`, `.%2e`, `%2e.`, `%2e%2e`), which is stricter than the
  `%2e`-replacement approach the Task 4a instructions suggested.
- Dot validation is confined to the request pathname (`0fdcb9b`), so
  `/worlds?cursor=/..` is preserved verbatim. This was not required by the
  Task 4a instructions and is a deliberate improvement: Task 13a (B4a) needs query
  strings for bounded reads, and the containment backstop still compares only
  `pathname`.
- P3 is proved with a non-POST method: the request-contract error regression
  asserts `PUT` against `/campaigns/example/player-config`, the Task 9 route
  that motivated the fix. `validatedRequest` is module-exported for that test
  but is **not** re-exported from the `client-web` public barrel.
- P2 was resolved by removing the dependency rather than widening the boundary
  scanner; the choice is recorded in `7bf07fc`. No package now declares a
  dependency its own boundary check rejects.

**Current Task 5 verification** (re-measured on `92aa9c4`, the Task 5 code
commit, during the Task 6 review; the figures below replace an earlier count of
783 unit tests and an unqualified integration note):

- `pnpm check` and `pnpm build` pass; repository boundary and data-safety
  checks cover 499 candidate files.
- `pnpm test:unit` passes **784/784 across 72 test files**, stable across
  repeated runs.
- `pnpm test:integration` passes — **190 passed, 2 skipped across 17 test
  files**, measured on this tree. The earlier note deferred to "the final
  pure-client test-only follow-up"; no such commit exists. `92aa9c4` is the last
  commit touching code, and `3f04efb` after it is documentation only.
- Focused client-core and boundary checks pass, including explicit coverage for
  failed same-attempt retries, source-session closure, command/frame races,
  retry transport failures, protocol mismatches, and duplicate replay.
- Cross-checked against Task 4 during the Task 6 review: `client.generation`
  satisfies the shipped `GenerationApiPort` with no adapter, assigning directly
  into `GenerationWorkflowDependencies`.

**Current Task 5a verification** (completed in `0904291`):

- `pnpm check` and `pnpm build` pass; repository boundary and data-safety
  checks covered 499 candidate files at the implementation commit.
- The focused client-core submission and boundary tests pass (58 tests), and
  `pnpm test:unit` passes **785/785 across 72 test files**.
- `pnpm test:integration` passes — **190 passed, 2 skipped across 17 test
  files**. The scoped implementation review found no remaining issue.

**Current Task 6 verification** (implemented in `89915f3` and finalized in
`ba9ea90`):

- `pnpm check` passes on the final tree; repository boundary and data-safety
  checks cover **515 candidate files**. `pnpm build` also passes.
- `pnpm test:unit` passes **875/875 across 77 test files**. The focused
  client-web/client-core/boundary gate passes (63 tests after the final fix).
- `pnpm test:integration` passes — **190 passed, 2 skipped across 17 test
  files** — and the frozen-lockfile installation check passes.
- A scoped review and independent final review identified three lifecycle
  follow-ups; `ba9ea90` captures the safe base path at source construction,
  cleans up a poll iterator returned before its first read, and adds the real
  retry-created second composed-session regression. The focused fix re-review
  confirmed all three findings addressed.

**Current Task 8 verification** (implemented across `175a854`, `d48e70a`,
`3364bd0`, `05d89c3`, `afdc1c0`, and finalized in `cb45bcc`):

- `pnpm install --frozen-lockfile`, `pnpm check`, and `pnpm build` pass on the
  final tree. The boundary and data-safety checks cover **524 candidate files**.
- `pnpm test:unit` passes **888/888 across 78 test files**;
  `pnpm test:integration` passes **190 passed, 2 skipped across 17 test files**.
- The rendered Compose and Swarm configurations validate. A production image
  built from the final tree and served `/nexus/`, `/story`, `/app/`, an
  extensionless `/app/` deep link, and a generated hashed asset successfully.
  The same smoke run verified HTML/stable-asset `no-cache`, hashed-asset
  immutable caching, CSP, and 404 separation for missing assets and API routes.
- Production and development remain same-origin from the browser's perspective:
  Fastify serves both production roots and Vite proxies backend paths in
  development. Task 8 therefore does **not** add
  `Access-Control-Expose-Headers` or widen CORS.
- C7a, C7b, and C7c each passed scoped review. The follow-up commits close the
  package-export bypass, TypeScript source-fixture invocation, Fastify static
  header API, hash-cache classification, unrelated-route 404, and extensionless
  `/app/assets/` fallback findings. The final focused fix re-review confirmed
  the asset-namespace finding addressed.

**Current Task 9 verification** (re-measured on `4bcd3de` during the Task 9
completion review; this block was missing when Task 9 was first marked
complete, which is the third recurrence of the Task 4a P4 defect):

- `pnpm check` and `pnpm build` pass; the boundary and data-safety checks cover
  **533 candidate files**. The build includes both Vite applications.
- `pnpm test:unit` passes **939/939 across 81 test files**.
- `pnpm test:integration` passes — **191 passed, 2 skipped across 17 test
  files**.
- Gate structure held. Gate 1 is `9cca4e7` (contracts, server projection, typed
  client) plus `cac241a` (the contract/route/client test gate and four of the
  five `docs/ui/*` reconciliations). Gate 2 is `4bcd3de`, the client rewire, and
  it contains **zero documentation files** — verified — so the revertible commit
  stays revertible.
- The four pre-implementation corrections were each confirmed against the
  shipped tree rather than the review document:
  - `story.html:522` loads `/nexus/legacy-client.js`, and the Story Player
    module graph moved out of `publicDir` into `apps/web/src/` — `story.js`,
    `story-routing.js`, `story-generation-cancellation.js`, and
    `story-state-editor.js`. `nexus.js` correctly stays raw; C8 covers the Story
    Player only.
  - `apps/web/dist/story.js` no longer exists after a real build, and
    `web-build-contract.test.ts` pins both halves — that `story.html` references
    the compiled entry and that `dist/story.js` is absent.
  - `apps/web/src/composition.ts` passes one `session` to `createApi`,
    `createSource`, and `createIllustrations`, and one `clock` to `createSource`
    and `createWorkflow`. `story-player-composition.test.ts` asserts those
    identities through `toHaveBeenCalledWith` and requires every factory to be
    called exactly once — a stronger check than the plan asked for.
- Note the completion review document records two figure sets: 935/935 before a
  correction round and 939/939 after. The later set is authoritative and matches
  this re-measurement.

**Loose end — one doc reconciliation is uncommitted.** `docs/ui/API_UI_CONTRACTS.md`
carries Task 9's Q2 resolution (the legacy single-image illustration endpoints
are a backend-only vestigial surface) but is still a working-tree modification.
Four of the five reconciliations landed in gate 1; this one did not. Commit it
to the gate-1 lane, not to gate 2 — a documentation change must not enter the
revertible rewire commit.

**Current Task 13a verification** (`b70844c`, `26cd735`, `6e5753d`): no figures
were recorded when this task was marked complete, and they are **not
reconstructed here** — the tree moved on immediately with the 13a-R corrective
gate, so any number measured now describes 13a-R's tree, not 13a's. What 13a is
evidenced by is its own commits, its two scoped fix re-reviews, and its
real-PostgreSQL 55-turn, recovery, and snapshot-race coverage, all of which the
13a-R work exercised again. Treat the 13a-R block below as the authoritative
measured state of the B4a lane.

**Current Task 13a-R verification** (measured on `1ae0dd1` during the Task 13a-R
completion review):

- `pnpm check` and `pnpm build` pass; the boundary and data-safety checks cover
  **539 candidate files**.
- `pnpm test:unit` passes **949/949 across 83 test files**.
- `pnpm test:integration` passes — **193 passed, 2 skipped across 17 test
  files** — and migration `0051_preserve_replacement_turn_provenance` applies
  cleanly on every test-database provision.
- Both contract corrections match the specification exactly.
  `turnListResponseSchema` carries `campaignId: z.uuid()`, supplied server-side
  from the campaign record (`campaignId: campaign.id`) rather than from a cursor
  or the request. `generationRecoverySchema` is a real
  `z.discriminatedUnion("operationKind", …)` with `append -> z.null()` and
  `replace_latest -> z.uuid()`, not the loose nullable the specification warned
  against.
- **Migration 0051 was checked for effectiveness, not just presence.**
  `DROP CONSTRAINT IF EXISTS` silently no-ops on a wrong name, which would leave
  the defect in place while every test still passed. The dropped name
  `generation_jobs_replacement_turn_owner_fk` matches exactly what migration
  0023 created with its `ON DELETE SET NULL (replacement_turn_id)` clause.
- **The provenance is proved to survive deletion, not merely projected.**
  `tests/integration/gameplay.integration.test.ts` creates a `replace_latest`
  job, explicitly runs `DELETE FROM turns` against the replacement target
  (`:341`), then asserts the recovery still carries `replacementTurnId`
  (`:395`). That mirrors production, where committing a replacement deletes the
  old turn at `generation-service.ts:1530`. Before 0051 the foreign key would
  have nulled the value and this assertion would fail.

**Convention note.** Task 13a-R records a "Completion evidence" paragraph inside
its own section. That is useful narrative, but the Completion-status table points
here, so measured figures belong in a `Current Task N verification` block. Keep
the in-section paragraph for the red-test narrative and do not duplicate numbers
between the two. This was the fourth recurrence of the missing-block defect; the
checklist half of the Task 4a P4 rule is now holding — 13a is 6/6 and 13a-R is
4/4 — while the block half is not.

**Current Task 7P / 7a / 7b / 7c / 7d verification** (all five stages
re-measured together on `9e8d5f1` during the Task 7 completion review, because
the plan status for the whole C6 package was reconciled in one pass — see the
reconciliation note below for why the stages could not record their own blocks
as they landed):

- `pnpm check` and `pnpm build` pass; the boundary and data-safety checks cover
  **548 candidate files**.
- `pnpm test:unit` passes **1010/1010 across 86 test files**.
- `pnpm test:integration` passes — **193 passed, 2 skipped across 17 test
  files**.
- **7P** (`20f13b9`, `cc79906`): `generationStreamSnapshotSchema` and
  `pendingGenerationSchema` are both `z.discriminatedUnion("operationKind", …)`
  with `append -> replacementTurnId: z.null()` and
  `replace_latest -> z.uuid()`. The pending status union is active-only via
  `activeGenerationStatusSchema`, leaving terminal jobs to `generationRecovery`.
  The sync query carries `pending.replacement_turn_id`
  (`server.ts:711`) and maps it at `:794` — never reconstructed from
  `expectedTurnNumber` or the latest turn. Snapshot equality includes the pair
  (`machine.ts:32-33`), so a target change is observable even when status and
  narration are unchanged. `GenerationRun` carries the immutable operation/target
  pair (`generation/types.ts:95-96`), available at `attachGeneration` before the
  first frame.
- **7a** (`cc79906`): `store.ts` commits with `Object.is` (`:91`), notifies from
  a copied listener set (`:94`), and returns an unsubscribe closure (`:101`).
  `Immutable<T>` was independently stress-tested: discriminated unions still
  narrow through it, arrays become deeply readonly with `push` rejected, and
  nullable branches and `Date` survive.
- **7b** (`9773cd5`, `3a6411d`): all six campaign protocol guards are
  implemented — `campaign_not_loaded`, `campaign_mismatch`,
  `page_campaign_mismatch`, `unchanged_window_without_baseline`,
  `duplicate_turn_id`, `duplicate_turn_number` — backed by an 813-line
  `campaign-store.test.ts`. The `page_campaign_mismatch` guard is what Task
  13a-R's `TurnListResponse.campaignId` exists to make possible.
- **7c** (`aef77d9`, `b3b7844`, `9e8d5f1`): all five generation protocol guards
  are implemented — `job_mismatch`, `result_turn_mismatch`,
  `replacement_target_missing`, `replacement_target_mismatch`,
  `result_retry_not_available`. Together with 7b that is the complete
  eleven-kind `CampaignProjectionProtocolError` union from S3, split exactly
  along the two lanes the stage decomposition defined.
- **7d** (`4206316`, `7c95432`): the four governing C6 documents are reconciled
  and `docs/review/2026-08-03-task-7d-track-c-exit-audit.md` records the exit
  audit. Its own report measured 959 tests across 83 files at `4206316`; three
  commits landed after it, so **1010 across 86** is the figure for HEAD. The
  earlier number is not wrong, only superseded.

**Plan reconciliation note (2026-08-03).** All five stages shipped green while
every table row still read "Not started" with 0 of 63 items ticked and no
verification blocks. **This was not the recurring bookkeeping defect.** The Task
7d report records the actual cause: this plan already carried inherited,
uncommitted Task 7 sequencing and decomposition edits, so a stage could not
commit its own status line without also staging changes it did not own. The
implementing agent correctly declined to do that and escalated instead. The
reconciliation performed here commits that inherited hunk, ticks all 74 items
(11 in 7P, 63 across 7a-7d) against the shipped code, and records the block
above. The lesson for future multi-stage packages: land the plan's structural
edits **before** starting the first stage, so each stage can own its own status
line. All three were marked complete with every
checkbox still unticked — the mirror of the Task 4a P4 problem, where the boxes
were ticked but the verification block was missing. Task 5's own 58 items were
in the same state and were discovered only while auditing 5a and 6. All **131**
items (58 + 17 + 56) were then individually verified against the shipped code
and ticked. Spot-verified for Task 5: the `(attempts, rank)` table with
`queued`/`replacement_queued` at rank 0, the `retryAcknowledged` gate that
admits the same-attempt queue frame only after a successful retry, narration
sourced solely from `partialNarration` with no `partialOutput` reference
anywhere, and `resume()`'s exact ordering — load, `syncStatus`, attach to
`pendingGeneration.id` while clearing the local record, else return a run for a
stored `jobId`, else replay.

The behaviors that had been the blocking spec defects were confirmed by
**running the shipped code**, not by reading it:

- A polling 404 rejects with `NexusApiError` after exactly one call and emits
  nothing, closing the degrade-forever hole that motivated S6's classification
  table.
- An SSE failure yields one `degraded: stream_lost` and then continues polling
  **inside the same iterable** through to a terminal snapshot, so S1's
  `source_ended_before_terminal` cannot fire on the fallback path.
- Legacy flat records in the exact shape `story.js:960-975` writes migrate for
  **both** operation kinds, preserving the idempotency key, with
  `expectedCurrentTurnNumber` derived from the flat `expectedTurnNumber` for
  replacements. No in-flight submission is lost at cutover.
- Task 5a's canonicalization was verified against a deliberately forged input
  carrying a mismatched `expectedTurnNumber`; the coordinator rewrites it from
  `request.expectedCurrentTurnNumber` rather than trusting the caller.

One item was checked specifically because it looked wrong and was not:
`storage.setItem` appears inside a `try`/`catch` in `pending-submissions.ts`,
but only via `writeBestEffort`, which serves the migration write inside
`load()`. `save()` calls `setItem` directly and propagates, exactly as S9
requires.

**Convention reminder for Task 7 onward:** tick the checklist in the same commit
that marks a task complete, alongside the verification block. A completed task
whose boxes are all unticked leaves no per-requirement record of what was
consciously satisfied, and a verification block alone cannot supply it.

**Next step — pick-up instructions.** **Track C is complete.** Tasks 1-6, 7P,
7a-7d, 8, 9, 13a, and 13a-R are done, and the ten Track C exit criteria were
audited and met on 2026-08-03. The client packages now own transport, workflow,
persistence, projection, and selectors, and the live Story Player runs on them.

**UI work is still blocked.** Track C being met authorizes the backend sequence
only. No `apps/web-next` framework, route, component, styling, or UI test
implementation begins until the backend completion gate at Task 14f.

Work the following order:

1. **Task 10 (B1)** — complete. The final independent reviewer approved the
   full `885bcde..653c7c8` range after the #0289 correction, so B1 now unblocks
   B2/B3/B4b/B5.
2. **Task 11 (B2)** — **complete.** Commit `d76beb8` replaced SSE database
   polling with the notification port while preserving the C1a error-frame
   behavior. B2 establishes the final event-delivery topology used by B3 load
   evidence.
3. **Task 12 (B3)** — configurable worker concurrency and fair job lanes.
   Follows B2 and must finish before U1.
4. **Task 13b (B4b)** — profiling, query/index optimization, and load evidence.
   Must finish before U5.
5. **Task 14a-14e (B5 by domain)**, then the **Task 14f** backend completion
   audit, which is the gate that authorizes Track U. Each domain now has its own
   completion row; see **Which cross-role exception each domain closes** in Task
   14, because 14a removes three allowlist entries while 14c and 14d remove none
   and therefore need a different completion signal.

**Reading file:line citations in this plan.** Citations inside a completed
task's evidence or rationale describe the tree **as of that task's commits** and
are deliberately not renumbered — several are already stale because
`server.ts` and `generation-service.ts` have moved substantially. Resolve them
by searching for the named symbol rather than jumping to the line. Citations in
**unstarted** task instructions are kept current; the only two remaining
(`packages/database/src/pool.ts:8` and `:35`) were re-verified on 2026-08-03.

Two documentation items remain carried and unowned; neither blocks B1:

- `docs/ui/API_UI_CONTRACTS.md` still holds Task 9's uncommitted Q2 hunk. Task
  7d deliberately left it unstaged for the same ownership reason that blocked
  the Task 7 status lines. Commit it as a focused documentation change.
- The remaining uncommitted working-tree docs (`AGENTS.md`,
  `docs/architecture/index.md`, `docs/reference/capabilities.md`,
  `docs/operations/deferred-improvements.md`,
  `docs/review/2026-07-30-implementation-plan.md`,
  `docs/ui/FRONTEND_IMPLEMENTATION_PLAN.md`, `docs/ui/OPEN_QUESTIONS.md`)
  predate this plan's Track C work and are not part of it. Triage them
  separately rather than folding them into a backend commit.

The 7P/7a/7b/7c/7d checkpoint model worked: each stage landed as its own commit
with its own scoped review, and the eleven-kind protocol-error union split
cleanly along the two lanes the decomposition predicted. Its one failure mode is
recorded in the **Plan reconciliation note** above — a stage cannot own its
status line while the plan still carries someone else's uncommitted structural
edits. Land structural plan changes before starting stage one.

Two Task 9 review follow-ups remain, but neither blocks B4a: commit the stranded
`docs/ui/API_UI_CONTRACTS.md` reconciliation as a focused documentation change
once its user-owned hunk can be isolated, and retain the C8 evidence in its
completion report. The final Track C exit audit belongs after C6, because C6 is
the last remaining Track C package; its C8-specific criteria (3, 6, 8, and 9)
are already evidenced by the Task 9 report and must be rechecked only as part of
that final audit.

Context carried forward: Task 5a established the replacement submission
invariant before storage validation; Task 6 supplied the browser-only SSE,
polling, persistence, clock, delay, and ID adapters without moving workflow
policy back into the UI; and Task 9 proved the whole vertical slice against the
live Story Player behind a rehearsed revert.

Two sequencing corrections, both from reviews against the shipped code rather
than the plan's own diagram:

- **Task 8 must land before Task 9.** Task 9 rewires `story.js` to import the
  client packages, and nothing in the repository can resolve those imports until
  Task 8 introduces the legacy client entry and its Vite build.
- **Task 7 does not gate Task 9** and is sequenced after it. Task 9 never
  consumes its stores or selectors, and no Track C exit criterion mentions them;
  they are Slice 1 groundwork for U2, U4, and U5. Task 7 keeps its number for
  cross-reference stability — roughly forty references across the document
  depend on the current numbering — so read the sequence from here and from the
  dependency graph, not from the section order.
- **Task 13a-R now gates Task 7.** Task 13's original cursor work changed turn
  history and incremental sync only after C6 had frozen its campaign projection,
  forcing C6 and U4/U5 to be rewritten. B4 is split: B4a lands the bounded
  browser/API contracts and compatibility implementation immediately after C8;
  B4b retains profiling, query/index optimization, and load evidence. C6 is
  implemented against B4a's final page/sync types once.
- **The entire remaining backend track gates U1.** The backend-first delivery
  policy is stricter than the minimum technical dependency graph: B1, B2, B3,
  B4b, every B5 domain extraction, and the backend completion audit all finish
  before any replacement-UI implementation. B2's transport abstraction and
  B5's domain independence no longer make either package parallel with UI work.

**Plan-wide validity review (2026-08-02): Complete.** The current worktree,
repository/deployment/testing architecture, all UI specifications named in the
traceability table, resolved Q1-Q8 decisions, and the unfinished Task 7-20
sequence were reviewed together. The review corrected the C7/C8/B4a/C6 order,
restored and expanded the backend-first U1 gate, split public read contracts from later optimization,
added missing build entries and Slice 1 endpoints, fixed retry-latest store
reconciliation, made pre-auth identity/provider separation explicit, and turned
U1-U6 into spec-verifiable work packages. This completion marks the **plan
review**, not any unchecked implementation task.

---

## Global constraints

- PostgreSQL remains authoritative for worlds, campaigns, accepted turns,
  campaign state, jobs, and Chronicle memory.
- Browser state and client stores are projections. They never become a second
  authoritative copy of campaign or world state.
- `packages/client-core` uses only ES language/runtime types. It has no DOM,
  Node, framework, network, storage, clock, timer, or random-ID dependency.
- `packages/client-web` may use standard Web APIs but may not import a component
  framework or manipulate rendered DOM.
- `apps/**` owns rendering, routing, focus, scrolling, notifications, and user
  interaction. It consumes client packages through public entry points.
- `services/api` and `services/worker` may depend on packages but may not import
  one another's implementation files.
- Every adopted API request and response is runtime-validated with a shared
  schema. Type-only assertions are not a boundary check.
- Mutating requests are never retried merely because an HTTP status is marked
  retryable. A retry requires an endpoint-specific idempotency contract.
- Client code renders only server-sanitized `partialNarration`; it never parses
  or displays raw `partialOutput`.
- Stopping a local watcher does not cancel a durable remote job. Remote
  cancellation is always an explicit operation.
- Text and illustration providers remain independent, and illustration failure
  never changes story-turn acceptance.
- Every behavior change includes corresponding unit, integration, contract, or
  E2E coverage before old coverage is removed.

---

## Specification traceability for remaining work

This table is the audit index for incomplete tasks. The implementation review
for each row must cite the named evidence; "covered elsewhere" is not a passing
answer.

| Requirement | Governing specification | Owning incomplete work |
|---|---|---|
| One same-image Compose/Swarm artifact, same-origin static UI, health/caching/CSP behavior | `repository-overview.md`, `runbooks/deployment.md`, frontend migration approach | C7 (Task 8) |
| Complete typed legacy play-loop seam, progressive narration, explicit cancel vs detach, retry-latest preservation, result-fetch recovery | `CLIENT_CORE_BOUNDARY.md`, Q1/Q4, Flows 2/6/8/9/11 | C8 (Task 9) |
| Slice 1 shell/world/campaign endpoints exist before feature code | `API_UI_CONTRACTS.md`, `SCREEN_INVENTORY.md` | C8 contract prerequisite, verified again by U3/U4 |
| Bounded turn history and incremental resume do not change underneath stores/components | performance budget, Flow 7/11, U4/U5 | B4a (Task 13a plus Task 13a-R) before C6; B4b before any UI implementation under the backend-first gate |
| Framework-neutral immutable campaign projection with no browser lifecycle ownership | client boundary and repository authority rules | C6 (Task 7) |
| API/worker generation behavior shares application ports without changing transaction or ownership boundaries | target architecture and generation-integrity rules | B1 (Task 10) |
| SSE notifications are hints, campaign/user scoped, and do not consume one pool connection per viewer | deployment replica rules and generation monitoring budget | B2 (Task 11) |
| Configurable fair worker lanes preserve campaign exclusivity and illustration independence | parent backend prerequisite, generation-integrity and provider-independence rules | B3 (Task 12), before U1 |
| WCAG 2.2 AA, one heading/landmarks, focus return, labels, throttled announcements, 320px reflow, 200% zoom, reduced motion | `ACCESSIBILITY_SPEC.md` | U1/U2/U5 implementation; U6 automated and manual gates |
| Dark and light token roles, status never color-only, narrative measure, common breakpoints/focus/motion tokens | `DESIGN_SYSTEM.md`, resolved Q8 | U1 tokens, U2 control/shell, U6 contrast/visual coverage |
| Minimal draft-world creation/published-version selection, campaign creation/resume, and Story Player including Auto resolution and replacement distinction | Slice 1, screens `NEX-WORLDS`, `NEX-CAMPAIGNS`, `STORY-PLAYER`; Flows 1/2/6/7/8/9/11 | C8 prerequisite contracts; U3, U4, U5 |
| No login or caller-authoritative UUID; correlation IDs remain visible | identity rules and `API_UI_CONTRACTS.md` | C8 typed session surface, U1/U2, U6 spoofing/error tests |
| Initial-user bootstrap/import ownership stay intact; future OIDC links to the existing internal UUID rather than claiming legacy data | identity rules; authentication explicitly deferred | Re-run existing migration/import/isolation suites in B1/U6; require a separate auth task and its mandated OIDC-link tests before any interactive login ships |
| Component, contract, real-database integration, Compose E2E, accessibility, visual, responsive, and performance evidence | `workflows/testing.md`, frontend testing strategy | every task's focused tests; U6 aggregate release gate |

Slice 1 intentionally excludes full world authoring, illustration controls,
Chronicle management, provider management, imports/exports, and campaign-detail
depth. Those requirements remain assigned to Slices 2–4 in
`FRONTEND_IMPLEMENTATION_PLAN.md`; they are not silently deleted by this plan.

---

## Why the plan is split into tracks

The replacement UI and backend modularization share contracts and job semantics,
but they do not have to land as one high-risk rewrite. Work proceeds through
three coordinated tracks:

1. **Track C — contracts and client modules:** build the stable UI-facing seam
   and prove it against the current Story Player.
2. **Track B — backend application boundary and performance:** remove API/worker
   cross-role coupling for the generation vertical slice, then improve event
   delivery and worker throughput behind unchanged HTTP contracts.
3. **Track U — replacement UI:** build the new framework application only after
   the client seam is proven and the static build/deployment contract exists.

Track C and the complete Track B both gate Slice 1. B4a's bounded read
contracts, including Task 13a-R, land before C6 because they define its public
shape. After the Track C exit audit, backend work proceeds in the deterministic
order B1, B2, B3, B4b, and B5a-B5e, followed by a backend completion audit.
Only that audit authorizes U1. This sequencing intentionally removes earlier
parallel/non-gating language even where HTTP/client abstractions would have
allowed implementation overlap.

---

## Target dependency direction

```text
apps/web/src legacy adapters          apps/web-next rendering
                \                         /
                 ---> packages/client-web
                          |
                          v
                  packages/client-core
                          |
                          v
                    packages/contracts

services/api HTTP/SSE adapter ---> packages/application <--- services/worker adapter
packages/database adapter -----------------^   ^---------------- provider adapters
                                             |
                          packages/domain / contracts / story-engine
```

Enforced rules:

- `client-core -> contracts` is allowed; `client-core -> client-web/apps/services`
  is prohibited.
- `client-web -> client-core/contracts` is allowed; `client-web -> framework` is
  prohibited.
- `apps -> client-web/client-core/contracts` is allowed; direct imports from
  `services`, `database`, or backend-only packages are prohibited.
- `services/api -> services/worker` and `services/worker -> services/api` are
  prohibited. Shared behavior moves to `packages/application`.
- `packages/application` contains use cases and ports, not Fastify request/reply,
  browser APIs, or concrete PostgreSQL queries.
- Database and provider packages implement application ports; the application
  package never imports their concrete adapters.

---

## Performance budgets and evidence

Performance work starts with repeatable measurements, not subjective impressions.
The first package records the baseline and installs the following budgets:

| Area | Budget / invariant | Verification |
|---|---|---|
| Initial replacement-app JavaScript | <= 200 KiB gzip for the Slice 1 entry route | Vite manifest/bundle report in CI |
| Lazy route chunks | <= 100 KiB gzip each | Bundle-budget script |
| Core Web Vitals | LCP <= 2.5 s, INP <= 200 ms, CLS <= 0.1 at p75 in the Playwright profile | Lighthouse/Playwright measurement artifact |
| Story render | 200-turn fixture becomes interactive without a main-thread task over 50 ms | Playwright performance assertion |
| Generation monitoring | At most one live SSE or polling watcher per job in one browser tab | Client-web unit test with fake transports |
| Poll fallback | Starts at 1500 ms, uses jittered transport backoff capped at 5000 ms, exposes `poll_failed` after two consecutive polling failures, and honors explicit server `Retry-After` up to 60 seconds | Fake-clock tests |
| Non-durable progress polling | No interval below 2000 ms; pauses while the document is hidden | Browser-adapter tests |
| SSE database activity | No fixed 350 ms query loop after B2; notification delivery p95 <= 500 ms with a bounded reconciliation read | Integration test and structured timing logs |
| Generation throughput | Scales with configured per-replica concurrency while preserving one active job per campaign | Real-PostgreSQL concurrency tests |
| Play-loop reads | No unbounded turn/job-history response; hot-route p95 and query counts do not regress more than 10% from the C0 baseline without an approved exception | Seeded-data load profile and query-count assertions |
| Static assets | Hashed assets use immutable caching; HTML and API responses remain non-cacheable | Server route tests |

If a budget cannot be met, the implementing change records the measurement,
cause, and an explicit approved exception. Budgets are not silently weakened.

---

# Track C — contracts and modular client

## Task 1 — C0: Baseline, architecture record, and boundary tests

**Files:**

- Create: `docs/architecture/0028-modular-client-and-application-boundaries.md`
- Create: `scripts/check-client-boundaries.mjs`
- Create: `scripts/check-web-bundle-budget.mjs`
- Create: `tests/unit/client-boundaries.test.ts`
- Modify: `scripts/check-repository-boundaries.mjs`
- Modify: `package.json`
- Modify: `.github/workflows/ci.yml`

**Produces:** An ADR, dependency checks, performance measurement commands, and CI
gates used by every later package.

**Status: Complete** (`04ccb6c`, `d9474f0`).

- [x] Record the dependency direction and the distinction between pure client
  workflows, Web-platform adapters, rendering, backend use cases, and backend
  adapters. — ADR 0028 §Decision.
- [x] Record current static asset sizes, current Story Player request cadence,
  generation fallback duration, and the existing SSE 350 ms database loop. —
  ADR 0028 §Context, with measured byte counts. The ADR also records that
  `POLL_INTERVAL_MS` is declared at 1,000 ms but unused; the fallback actually
  polls at 400 ms.
- [x] Define the deterministic machine/container profile, fixture sizes, warm-up,
  sample count, and variance policy used for repeatable performance comparisons.
  — ADR 0028 §Performance comparison profile (2 vCPU / 4 GiB, 10/200/2,000-turn
  fixtures, 5 warm-up + 30 measured, 5% variance re-run, median of three).
- [x] Add import-boundary tests using the TypeScript parser rather than only
  regex matching source text. — `scripts/check-client-boundaries.mjs` uses
  `typescript/unstable/ast`; `tests/unit/client-boundaries.test.ts` covers it.
- [x] Configure `packages/client-core` rules to reject Web/Node globals and
  imports; configure `packages/client-web` rules to reject DOM rendering and
  framework imports. — rules are in place and will bind when Task 3 creates the
  packages.
- [x] Reject cross-role imports between `services/api` and `services/worker`. —
  exact-keyed allowlist of the six existing worker imports, each naming its
  removal task.
- [x] Add the bundle-budget command to CI, initially reporting only until the
  Slice 1 Vite output exists. — `pnpm check:web-bundle-budget`, wired into
  `.github/workflows/ci.yml`.
- [x] Run `pnpm check`, `pnpm build`, and `pnpm test:unit`. — all pass.

**Definition of done:** The architecture is recorded, the current tree passes
the new checks with narrowly documented transitional allowlists, and every
allowlist entry names the work package that removes it. **Met.**

---

## Task 2 — C1: Complete request and response contracts for the play loop

The current contract package does not export the response types used by the
original plan (`CampaignSummary`, `SyncStatus`, `WorldSummary`, and
`GenerationResult`). Compile-time imports alone therefore cannot guarantee that
server and client agree.

**One generation schema already exists and is dead — narrow it, do not duplicate
it.** `packages/contracts/src/generation.ts:391` defines
`generationJobStatusSchema` (type alias at line 453) with the complete status
union already including `replacement_queued` and `cancelled` (line 403), plus
`partialOutput` and `partialNarration`. It is exported through
`packages/contracts/src/index.ts` and referenced **nowhere** in `services/`,
`apps/`, or `tests/`. Creating a second, parallel snapshot schema beside it
would reintroduce exactly the two-sources-of-truth drift this package exists to
eliminate.

Therefore `generationStreamSnapshotSchema` must be **derived** from the existing
schema rather than written fresh — for example a `.pick()`/`.omit()` narrowing
that drops `partialOutput` from the client-facing surface — and the server must
begin validating against the same base schema. If the existing shape turns out
to be wrong, fix it in place and update its consumers; do not leave two
generation schemas in the tree at the end of C1.

**Files:**

- Create: `packages/contracts/src/http.ts`
- Create: `packages/contracts/src/client-api.ts`
- Create: `tests/unit/client-api-contracts.test.ts`
- Modify: `packages/contracts/src/generation.ts`
- Modify: `packages/contracts/src/world-library.ts`
- Review: `packages/contracts/src/index.ts` (the existing public barrel already
  re-exports the complete client-contract module)
- Modify: `services/api/src/server.ts`
- Test: focused route tests under `tests/integration/`

**Interfaces produced:**

```ts
export const apiErrorEnvelopeSchema: z.ZodType<ApiErrorEnvelope>;
export const campaignSummarySchema: z.ZodType<CampaignSummary>;
export const campaignSyncStatusSchema: z.ZodType<CampaignSyncStatus>;
export const turnSummarySchema: z.ZodType<TurnSummary>;
export const generationEnqueueResponseSchema: z.ZodType<GenerationEnqueueResponse>;
export const generationStreamSnapshotSchema: z.ZodType<GenerationStreamSnapshot>;
export const generationResultSchema: z.ZodType<GenerationResult>;
export const generationActionResponseSchema: z.ZodType<GenerationActionResponse>;
export const worldSummarySchema: z.ZodType<WorldSummary>;
```

`GenerationStreamSnapshot` intentionally contains `partialNarration` but does
not expose `partialOutput` to client workflow code. It is a narrowing of the
existing `generationJobStatusSchema`, not a new declaration — see the note
above.

**Status: Complete** (`128cc53`, `ff9a420`), with follow-up tracked as Task 2a.

- [x] Inventory the exact Slice 0/1 request and response shapes from route tests
  and service return values.
- [x] Add response schemas without weakening existing request schemas. —
  `packages/contracts/src/client-api.ts`, `http.ts`, `world-library.ts`.
- [x] Derive `generationStreamSnapshotSchema` from the existing
  `generationJobStatusSchema` and wire that schema into the server. —
  implemented as `generationJobStatusSchema.omit({ partialOutput: true })`;
  `server.ts` now validates via `parseResponseProjection`. See Task 2a: `.omit()`
  should become an explicit `.pick()`.
- [x] Confirm no second generation status union exists anywhere in the tree
  after this package. — verified; the enum is declared once.
- [x] Keep transport error name (`payload.error`) separate from domain detail
  code (`payload.details.code`). — `apiErrorEnvelopeSchema`.
- [x] Parse adopted server responses before sending them in focused route tests.
  — `tests/unit/client-api-routes.test.ts`.
- [x] Add malformed-response tests so the client cannot accept drift as valid
  data. — `tests/unit/client-api-contracts.test.ts`.
- [x] Run contract unit tests and focused API integration tests. — pass.

**Beyond the original scope, and correct:** the package removed `z.coerce` and
`.default(...)` from `generationJobStatusSchema`. Both defeat drift detection in
a response schema — a default masks a missing field and coercion masks a type
change. Verified safe at runtime against real PostgreSQL rows.

**Also verified:** removing `partialOutput` from the wire does not regress the
legacy Story Player. `generation-service.ts:592` already derives
`partialNarration` server-side via `extractPartialNarration`
(`packages/story-engine/src/output.ts:58`), so the `story.js:1235` regex
fallback was redundant. It is now dead code — remove it in Task 9 (C8).

**Definition of done:** Every endpoint adopted by C3-C6 has one shared request
schema where applicable, one response schema, server-side verification, and a
client-side parser. A renamed field fails tests or type checking on both sides.
**Met.**

---

## Task 2a — C1a: Stream projection and validation-cost remediation

**Do this before Task 3.** Task 5 (C4) models `GenerationEvent` directly on the
stream projection, so correcting the projection afterwards means rewriting the
C4 event model and its tests. Everything here is a consequence of C1 and is
cheap now, expensive later.

**Files:**

- Modify: `packages/contracts/src/generation.ts`
- Modify: `services/api/src/server.ts`
- Modify: `apps/web/public/story.js`
- Test: `tests/unit/client-api-contracts.test.ts`
- Test: `tests/unit/client-api-routes.test.ts`

### P1 — `updatedAt` in the SSE frame defeats change detection

`generationStreamSnapshotSchema` is currently `generationJobStatusSchema.omit({
partialOutput: true })`, which retains ~24 fields including `createdAt`,
`updatedAt`, and `completedAt`. The previous hand-built frame carried seven
fields and no timestamps.

The SSE loop only writes when `JSON.stringify(job)` differs from the last frame
(`server.ts:782`). The worker's lease-renewal timer
(`generation-service.ts:1665-1669`) runs `UPDATE generation_jobs SET
lease_expires_at = ..., updated_at = now()` every `max(5000, leaseSeconds/3)` ms
for the whole generation. So `updatedAt` now changes the serialized frame on
every lease renewal and forces a write even when status and narration are
identical — more frames, each roughly three times larger, on the hottest path in
the product. This inflates the B2 baseline before B2 begins.

- [x] Replace `.omit()` with an explicit `.pick()` of the fields the client
  actually consumes. `.omit()` is a denylist: every field later added to the base
  schema silently joins the stream projection.
- [x] Include `id`, `campaignId`, `expectedTurnNumber`, `status`, `action`,
  `operationKind`, `attempts`, `partialNarration`, `errorMessage`, `errorCode`,
  and `resultTurnId`; `attempts` is the Task 5 retry-cycle marker.
- [x] Exclude `createdAt`, `updatedAt`, and `completedAt` from the **stream**
  projection. Keep the full shape on `GET /generation-jobs/:jobId`, where
  per-frame dedupe is not a factor.
- [x] Add a test asserting that a lease-renewal-only change produces **no** new
  SSE frame.
- [x] Record serialized JSON payload size and frames-per-generation against the
  C0 baseline in
  ADR 0028 with `pnpm exec tsx scripts/benchmark-client-contracts.ts`.

### P2 — the terminal error frame was removed without a decision record

The pre-C1 loop wrote `data: {"status":"failed","errorMessage":...}` on a
mid-stream read failure. That frame is gone; the loop now breaks and the client
falls back to polling through `EventSource.onerror`.

This is very likely the correct behavior — a transient database read failure is
not a failed generation, and the old synthetic frame could never satisfy the
schema. But it is a client-visible change made inside a contracts package, and
nothing tests it.

- [x] Confirm the new behavior is intended and record it in ADR 0028.
- [x] Add server/route proof that a mid-stream read failure closes the stream
  without emitting a synthetic terminal status.
- [x] **Completed by Task 6.** Fake-EventSource browser coverage proves
  `EventSource.onerror` falls back to polling after a clean non-terminal stream
  closure. Task 6's fallback-composition checkpoint records this inherited
  Task 2a P2 case explicitly.
- [x] Ensure Task 11 (B2) preserves this behavior rather than reinstating a
  fabricated terminal frame.

### P3 — smaller corrections

- [x] Restore the post-sleep close check in the SSE loop. `server.ts:791` sleeps
  and then queries at 793 with no `isClosed` check between, so a client that
  disconnects during the sleep still costs one database query. The pre-C1 loop
  caught this at the `while` condition.
- [x] Parse once in `generationSnapshot()` (`server.ts:219-224`) with the
  route-specific client-safe schema, avoiding the former two Zod passes per
  frame per client.
- [x] Remove the now-unreachable `partialOutput` branch at `story.js:1235-1243`
  so it does not mislead the Task 9 (C8) migration.

### P4 — measure response-validation cost before bounded reads

`turnListResponseSchema` validates every turn on every call, and the turns route
still has no `LIMIT` because Task 13a (B4a) has not landed. On the plan's own
2,000-turn fixture that is 2,000 object validations per request, on a route hit
at every campaign load.

- [x] Measure the 2,000-turn response validation now, before B4a, so B4a's
  comparison is not made against an already-degraded number.
- [x] Record the result as an explicit baseline amendment rather than silently
  absorbing it into the 10% regression budget.

**Complete:** The SSE projection is an explicit allowlist that does not
change on lease renewal, the error-frame behavior is intended and tested, and the
validation cost added by C1 is measured rather than assumed.

**Task 2a completion review.** Every checked item above was re-verified against
the tree at `fb4b5ad`, not just against the commit messages:

| Claim | Verified at |
|---|---|
| Eleven-field `.pick()` allowlist, no timestamps | `packages/contracts/src/generation.ts:424-437` |
| Full shape retained on the polling route | `generationJobSnapshotSchema`, `services/api/src/server.ts:219-221` |
| Lease-renewal-only change emits no frame | `tests/unit/client-api-routes.test.ts:298` — three snapshots differing only by `updatedAt` yield two frames; asserts no `updatedAt` on the frame |
| Allowlist is contract-tested | `tests/unit/client-api-contracts.test.ts:238` |
| Read failure closes without a synthetic terminal frame | same route test — 200, one valid frame, body never contains `"status":"failed"` |
| Post-sleep close check restored | `services/api/src/server.ts:793`, proved by a real-socket test asserting exactly one job read after disconnect during the sleep |
| Single Zod pass per frame | `services/api/src/server.ts:223-225` |
| `partialOutput` branch removed | `apps/web/public/story.js` — no remaining occurrences |
| Benchmark output shape is regression-tested | `tests/unit/benchmark-client-contracts.test.ts` |

Three defects found by that review and corrected in the same pass:

1. The verification figures above were stale (700/65/468 against an actual
   702/66/470). Corrected in **Completion status**.
2. `pnpm test:integration` had never been run against the Task 2a changes even
   though Task 2a modified an integration test. Now run and passing; the
   environment failure that had been silently blocking it is documented in
   **Completion status**.
3. This plan's ADR was filed as `0026`, colliding with the pre-existing
   `docs/architecture/0026-durable-world-generation-progress.md` on `main`. It is
   renumbered to **ADR 0028** and all references in this plan updated. The
   collision had already produced one misattribution:
   `docs/ui/FEATURE_IMPLEMENTATION_MATRIX.md` cited "ADR 0026" for campaign-state
   optimistic concurrency, which is actually
   `0011-editable-campaign-runtime-state.md`; that citation is corrected and now
   cites the filename rather than the number.

   Two duplicate ADR numbers remain and are **out of Task 2a's scope** because
   both predate this work on `main`: `0011` (`editable-campaign-runtime-state`
   vs `provider-reported-campaign-costs`) and `0024`
   (`central-prompt-library` vs `scoped-chronicle-entity-identity`). Until they
   are resolved, cite ADRs by filename, not number. Separately,
   `docs/architecture/index.md` does not list ADRs 0022, 0025, 0026, or 0027;
   only the 0028 entry added here was in scope to fix.

One unrelated defect surfaced and was fixed because it made the Task 2a
verification unreliable: `tests/unit/ensure-test-database.test.ts` failed once in
eight full-suite runs (passing in isolation and in pairs) because it waited a
fixed 10 ms of real time for filesystem work to complete before asserting on the
first connection attempt. Under parallel suite load that wait is not long enough.
It now polls the real clock for the condition instead. The file is not otherwise
touched by Task 2a; the flake predates it and was surfaced by the larger suite.

---

## Task 3 — C2: Scaffold pure and Web-platform client packages

**Files:**

- Create: `packages/client-core/package.json`
- Create: `packages/client-core/tsconfig.json`
- Create: `packages/client-core/src/index.ts`
- Create: `packages/client-core/src/ports.ts`
- Create: `packages/client-web/package.json`
- Create: `packages/client-web/tsconfig.json`
- Create: `packages/client-web/src/index.ts`
- Modify: `pnpm-lock.yaml`
- Modify: `tsconfig.json`
- Modify: `tsconfig.build.json`

`packages/client-core/tsconfig.json` sets `lib: ["ES2023"]` and `types: []`.
It does not inherit Node's Web-global shims. `packages/client-web` sets
`lib: ["ES2023", "DOM", "DOM.Iterable"]` and owns the concrete adapters.

**Core ports produced:**

```ts
export interface Clock {
  now(): number;
}

export interface IdFactory {
  create(): string;
}

export interface DelayScheduler {
  wait(milliseconds: number, signal: AbortSignalLike): Promise<void>;
}

export interface PendingSubmissionStore {
  load(campaignId: string): PendingGenerationSubmission | null;
  save(campaignId: string, submission: PendingGenerationSubmission): void;
  clear(campaignId: string): void;
}

export interface AbortSignalLike {
  readonly aborted: boolean;
  addEventListener(type: "abort", listener: () => void, options?: { once?: boolean }): void;
  removeEventListener(type: "abort", listener: () => void): void;
}

/**
 * Identity seam. The deployment is currently pre-authentication: the server
 * resolves every request to the database-backed `initial-owner` and
 * browser-supplied identity is not authorization (README.md:122).
 * OIDC is planned, so the seam is defined now and implemented as a no-op.
 */
export interface SessionPort {
  /** Headers to attach to outbound requests. Currently always empty. */
  authorization(): Promise<Record<string, string>>;
  /**
   * Invoked on 401/403. Returns true when the caller should retry once.
   * The current no-op implementation always returns false.
   */
  onUnauthorized(response: { statusCode: number }): Promise<boolean>;
}
```

`SessionPort` exists so that adding interactive authentication later is an
adapter change in `client-web` plus an error-taxonomy branch, rather than a
signature change rippling through every workflow, store, and API method in both
client packages. Implement it as a no-op in C2 and do not build refresh,
storage, or redirect behavior until authentication actually lands.

- [x] Export only deliberate public surfaces; do not create barrel exports of
  internal files.
- [x] Add compile-failure fixtures proving client-core cannot reference
  `fetch`, `EventSource`, `localStorage`, `document`, `window`, Node modules, or
  a framework.
- [x] Add positive fixtures proving client-web may implement core ports with
  Web APIs while remaining framework-free.
- [x] Provide the no-op `SessionPort` implementation in client-web.
- [x] Thread `SessionPort` through the HTTP client in C3, so no later package
  has to change call signatures to introduce authentication. — completed by
  Task 4's authorization seam and bounded refresh replay.
- [x] Run package type checks and boundary tests.

**Definition of done:** Core policy can be imported and tested in a pure Node
test without Web-global type shims. Browser implementations are isolated behind
ports and can be replaced without changing workflow code.

---

## Task 3a — C2a: Make the declared client package boundary real

**Do this before Task 4.** C2's own checklist is complete and its guards are
genuinely enforced — injecting `document`/`localStorage` into
`packages/client-core/src/ports.ts` or `node:fs/promises` into
`packages/client-web/src/index.ts` is rejected by both
`scripts/check-client-boundaries.mjs` and the package-local `tsc`. The problem is
narrower and more serious: **the one dependency edge the architecture depends on,
`client-core -> contracts`, is declared allowed in four places and does not
compile.** Task 4 (C3) is the first downstream work package that consumes the
platform-clean contracts barrel at runtime: `client-web` imports the shared Zod
schemas used by `RequestSpec.responseSchema`, while Task 5 imports their derived
types into pure `client-core` workflows.

Fixing this after C3/C4/C5 means unpicking whatever workaround those tasks adopt
in the meantime. C2 already adopted one — see P2.

**Files:**

- Modify: `packages/contracts/src/generation.ts`
- Modify: `packages/contracts/src/archives.ts`
- Create: `packages/contracts/src/archives-node.ts`
- Modify: `services/api/src/campaign-archive-service.ts`
- Modify: `packages/client-core/src/ports.ts`
- Modify: `packages/client-core/src/index.ts`
- Modify: `scripts/check-client-boundaries.mjs`
- Modify: `tests/unit/client-boundaries.test.ts`
- Modify: `tests/unit/archive-contracts.test.ts`
- Modify: `tests/unit/campaign-archive-service.test.ts`
- Modify: `tests/integration/campaign-archive.integration.test.ts`
- Create: `tests/fixtures/client-boundaries/core-contracts/src/fixture.ts`
- Create: `tests/fixtures/client-boundaries/core-contracts/tsconfig.json`

### Reproducing the failure before you start

Run this first so you can see the failure you are fixing. It must fail now and
pass when P1 is done:

```bash
cat > packages/client-core/src/__probe.ts <<'EOF'
export type { GenerationRequest } from "../../contracts/src/index.js";
EOF
pnpm --filter @infinite-quest/client-core check   # expect errors
rm -f packages/client-core/src/__probe.ts
```

Current output:

```text
../contracts/src/generation.ts(158,67): error TS2304: Cannot find name 'crypto'.
../contracts/src/archives.ts(1,28): error TS2591: Cannot find name 'node:crypto'.
```

### P1 — `client-core -> contracts` is declared allowed but does not compile

The plan's **Target dependency direction** diagram draws
`client-core -> contracts`; its enforced rules say "`client-core -> contracts` is
allowed"; `isClientCoreImportAllowed()` permits it; and
`tests/unit/client-boundaries.test.ts` has a test named *"allows client-core
imports from its own package and contracts"*. All four are wrong, because
`packages/client-core/tsconfig.json` sets `lib: ["ES2023"]` and `types: []` and
two contracts modules need platform globals:

| Module | Line | Problem |
|---|---|---|
| `generation.ts` | 158 | `idempotencyKey: ....default(() => crypto.randomUUID())` needs the `crypto` global |
| `archives.ts` | 1 | `import { createHash } from "node:crypto"` needs Node types |

The boundary test passes only because `collectClientBoundaryViolations()` scans
import *strings*. Nothing in the repository ever compiles client-core against
contracts, so the rule was never true.

`client-web` is affected too: it can deep-import `contracts/src/generation.js`
(DOM supplies `crypto`), but importing the contracts **index** fails on
`archives.ts`. C3 should not be forced into deep imports to work around this.

- [x] **`generation.ts:156-159` — delete the `idempotencyKey` field from
  `illustrationSegmentRequestSchema`.** It is dead. The route at
  `services/api/src/server.ts:889` parses the body and passes the result to
  `generateTurnIllustrationSegments`
  (`services/api/src/segmented-illustration-service.ts:545-552`), which forwards
  only `request.mode` to `createTurnSet`. The generated UUID is never read,
  never persisted, and never returned. Do not confuse this with
  `enqueueIllustrationBackfill`, which reads a real `request.idempotencyKey`
  at `segmented-illustration-service.ts:623` and `:652` from a *different*
  schema — leave that one alone. The schema is not `.strict()`, so a client that
  still sends `idempotencyKey` has it silently stripped, exactly as today.
- [x] Confirm no other contracts module calls a platform global:
  `grep -rn "default(() =>" packages/contracts/src/*.ts` must return nothing
  after the edit. It currently returns only line 158.
- [x] **Move `calculateContentFingerprint` out of `archives.ts` into a new
  `packages/contracts/src/archives-node.ts`**, which keeps the `node:crypto`
  import and imports `canonicalArchiveJson` and `archiveSha256Schema` from
  `./archives.js`. Leave everything else in `archives.ts`; it is schema-only
  after the move.
- [x] **Do not re-export `archives-node.js` from
  `packages/contracts/src/index.ts`.** The index must stay lib-clean. This is
  the whole point of the split — a Node-only helper may live in the contracts
  package but must not be reachable from its public barrel.
- [x] Update the four importer call sites (six invocations) to import from
  `archives-node.js`:
  `services/api/src/campaign-archive-service.ts:11` (used at `:320`, `:343`,
  `:838`), `tests/unit/archive-contracts.test.ts:6`,
  `tests/unit/campaign-archive-service.test.ts:11`, and
  `tests/integration/campaign-archive.integration.test.ts:13`. Split each
  existing import so the remaining schema imports still come from
  `archives.js`.
- [x] **Add a compile fixture that locks this in.** Create
  `tests/fixtures/client-boundaries/core-contracts/` extending
  `packages/client-core/tsconfig.json`, whose `src/fixture.ts` imports the
  contracts index and uses a schema at the value level, not just as a type:

  ```ts
  import { generationRequestSchema } from "../../../../../packages/contracts/src/index.js";
  export const parsed = generationRequestSchema.safeParse({});
  ```

  Add a test to `tests/unit/client-boundaries.test.ts` asserting
  `typecheckFixture(...)` **succeeds** with empty output. A type-only import is
  not sufficient — it would be erased and would not prove the module compiles.
- [x] Do **not** fix this by adding `"lib": ["DOM"]`, `"types": ["node"]`, or a
  local `declare const crypto` to `packages/client-core`. Any of those reopens
  the boundary C2 exists to close.

**If the archives split turns out to be larger than described**, the fallback is
to keep `calculateContentFingerprint` where it is and have client packages
deep-import the specific contracts modules they need. Record that as an explicit
decision in ADR 0028 and remove the `client-core -> contracts` claim from the
dependency-direction rules, because it would then be false. Do not leave the
claim standing unbacked.

### P2 — `PersistedGenerationRequest` duplicates a contract with no drift guard

Because P1 was blocked, C2 hand-wrote `PersistedGenerationRequest`
(`packages/client-core/src/ports.ts:26-41`) as a structural copy of
`generationRequestSchema`. Its own comment says this is to keep client-core "free
of the contracts module's runtime Web and Node globals" — i.e. it is a workaround
for P1, not a design choice.

There is no drift guard. Demonstrated: add a required field to
`generationRequestSchema`, and the build fails at
`tests/unit/client-boundaries.test.ts:108` — the *test's object literal*, not the
duplicated interface. Add the field to the literal, which is the obvious next
move, and `PersistedGenerationRequest` silently drifts with **zero** errors and
**zero** failing tests. It is a tripwire pointing at the wrong file.

This matters beyond tidiness: Task 5 (C4) and Task 6 (C5) persist and replay
these submissions. A contracts field added later is silently dropped from every
replayed request.

- [x] Once P1 lands, **delete `PersistedGenerationRequest` and derive the type
  from contracts**: `PendingGenerationSubmission.request` becomes
  `GenerationRequest` imported from `packages/contracts`. This removes the
  duplicate rather than testing it.
- [x] The type no longer remains duplicated, so the conditional bidirectional
  assignability guard is unnecessary.

  If the type must remain duplicated for a reason discovered during P1, add
  a real bidirectional assignability assertion instead of relying on a literal:

  ```ts
  type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
  const _drift: Exact<GenerationRequest, PersistedGenerationRequest> = true;
  ```

  Verify the guard actually works by adding a required field to
  `generationRequestSchema`, confirming `pnpm check` fails at the assertion,
  then reverting. A guard you have not seen fail is not a guard.
- [x] Keep `tests/unit/client-boundaries.test.ts:108` typed as
  `GenerationRequest`; it is still a useful tripwire, just not sufficient alone.

### P3 — the boundary scanner only validates the first hop

`collectClientBoundaryViolations()` checks client-core's own import specifiers
but never what an allowed target transitively pulls in. `client-core -> contracts
-> node:crypto` passes the scanner today; only `tsc` rejects it. After P1 makes
the contracts index lib-clean, that compiler backstop disappears for anything
newly added to contracts, and nothing replaces it.

- [x] Extend `scripts/check-client-boundaries.mjs` so that a module reachable
  from `packages/contracts/src/index.ts` may not import `node:*` or a framework.
  Scanning the contracts index's transitive import graph is sufficient; a full
  repository graph is not required.
- [x] Add a unit test proving the new rule fires — a synthetic contracts module
  importing `node:crypto` and re-exported from the index must produce a
  violation.
- [x] Keep `archives-node.ts` passing: it is a legitimate Node module inside
  contracts that is simply not reachable from the index. The rule is about
  reachability from the barrel, not about file location.

### P4 — smaller corrections

- [x] `tests/unit/client-boundaries.test.ts:196` uses
  `import type { Campaign } from "../../contracts/src/index.js"` as its canonical
  *allowed* example. The contracts index exports no `Campaign`. Replace it with a
  real export so the example is not misleading.
- [x] `tests/fixtures/client-boundaries/core-forbidden/src/fixture.ts` proves
  framework exclusion through `Cannot find module 'react-dom/client'` — that is
  react not being installed, not the boundary rejecting it. Note this in the test
  so a future workspace that adds react does not mistake the resulting failure
  for a boundary regression. The static scanner enforces the real rule, so no
  behavior change is needed.
- [x] Record in ADR 0028 that the contracts package is split into a lib-clean
  public barrel and explicitly non-exported Node-only helpers, and that
  `client-core -> contracts` is verified by a compile fixture rather than by
  string scanning.

**Complete:** `client-core` compiles against the contracts public barrel, proved
by a value-level compile fixture rather than an import-string scan; no client
package carries a hand-maintained copy of a contract type without a guard that
has been observed to fail; and the boundary scanner rejects Node and framework
dependencies reachable from the contracts index.

**Verification:** `pnpm check`, `pnpm build`, `pnpm test:unit`, and
`pnpm test:integration` all pass. If `pnpm test:integration` fails at global
setup with `password authentication failed for user "infinitequest_test"`, see
the recovery command under **Completion status** — that is a local environment
drift, not a code failure.

---

## Task 4 — C3: Runtime-validating HTTP client and error taxonomy

**Implementation status: Complete (2026-08-01), independently reviewed with
three security fix rounds.** The implementation is committed as `2bba1a3`,
`15f6454`, `996a129`, and `0ad6033`. Focused client coverage, package checks,
boundary checks, `pnpm check`, `pnpm build`, the 69-file/748-test unit suite,
and integration tests passed. The review found and closed off-origin credential
leaks through unsafe configured base paths and caller-supplied request paths.
The Task 8 contracts-package and CORS-exposure follow-ups remain intentionally
deferred.

**Pre-implementation correction status: Complete (2026-08-01), reviewed twice.**
The first review, against the current contracts, Fastify routes, legacy browser
helpers, package exports, and the Task 3 `SessionPort`, found that the original
`RequestSpec` could not represent its promised response modes, the API groups
had no method contracts, and the error and authentication behavior was
underspecified.

A second review verified the corrected scope against the running codebase rather
than reading it for plausibility. Confirmed sound: all eleven routes exist at the
stated methods and paths; every named schema and type is exported from the
platform-clean contracts barrel and compiles under `client-web`'s configuration;
the route-to-schema mapping is right, including `generationJobSnapshotSchema`
for the polling route and the 200/202 split across `discard` and
`retry`/`cancel`; bodyless action POSTs already work; `apiErrorEnvelopeSchema`
supports the specified `details.code` precedence and `error` → `errorName`
separation; `GenerationApi` is genuinely assignable to Task 5's
`GenerationApiPort`; and every declared interface typechecks as written.

That review corrected six things, all folded in below: the `x-correlation-id`
response header did not exist, the `zod` dependency fix was partial and its
rationale overstated, the `accept` rule contradicted itself, the `RequestSpec`
overload design needed a rationale, the `empty`/`blob` response modes needed
their speculation justified, and `cause` needed a note. Task 4 remained a single
reviewable work package; the implementation and its security fix rounds are now
complete.

### Scope boundary

Task 4 adopts only the HTTP endpoints whose request and response contracts were
made authoritative in Task 2/2a and that C4-C6 need directly. It does **not**
silently absorb the entire legacy Story Player or management API.

The initial typed client covers:

| API group | Method | Relative path | Request validation | Success validation |
|---|---|---|---|---|
| `worlds` | `GET` | `/worlds` | none | `worldListResponseSchema` |
| `campaigns` | `GET` | `/campaigns` | none | `campaignListResponseSchema` |
| `campaigns` | `GET` | `/campaigns/:campaignId/turns` | encoded path ID | `turnListResponseSchema` |
| `generation` | `GET` | `/campaigns/:campaignId/sync-status` | encoded path ID | `campaignSyncStatusSchema` |
| `generation` | `POST` | `/campaigns/:campaignId/generations` | `generationRequestSchema` | `generationEnqueueResponseSchema` |
| `generation` | `POST` | `/campaigns/:campaignId/generations/retry-latest` | `generationRetryLatestRequestSchema` | `generationEnqueueResponseSchema` |
| `generation` | `GET` | `/generation-jobs/:jobId` | encoded path ID | `generationJobSnapshotSchema` |
| `generation` | `GET` | `/generation-jobs/:jobId/result` | encoded path ID | `generationResultSchema` |
| `generation` | `POST` | `/generation-jobs/:jobId/retry` | encoded path ID; no body | `generationActionResponseSchema` |
| `generation` | `POST` | `/generation-jobs/:jobId/cancel` | encoded path ID; no body | `generationActionResponseSchema` |
| `generation` | `POST` | `/generation-jobs/:jobId/discard` | encoded path ID; no body | `generationActionResponseSchema` |

The generation stream is excluded because Task 6 owns EventSource plus polling
fallback. Session/meta, providers, turn-input classification, campaign state,
player configuration, rewind, illustration, import, and export methods remain
outside C3. Task 9 must add shared schemas, server response projection, typed
client methods, and tests before replacing any of those additional legacy calls.

**Files:**

- Create: `packages/client-web/src/http-client.ts`
- Create: `packages/client-web/src/api-client.ts`
- Create: `packages/client-core/src/errors.ts`
- Modify: `packages/client-core/src/index.ts`
- Modify: `packages/client-web/src/index.ts`
- Modify: `packages/client-core/package.json`
- Modify: `packages/client-web/package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `services/api/src/request-security.ts`
- Modify: `tests/unit/server-security.test.ts`
- Modify: `tests/unit/client-boundaries.test.ts`
- Create: `tests/unit/client-web/http-client.test.ts`
- Create: `tests/unit/client-web/api-client.test.ts`
- Create: `tests/unit/client-core/errors.test.ts`

`services/api/src/request-security.ts` and `tests/unit/server-security.test.ts`
are the only server-side files in this work package. They exist solely to emit
the `x-correlation-id` response header the client's correlation fallback
consumes — see **Structured HTTP errors**.

**Interfaces produced:**

```ts
export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export class NexusApiError extends Error {
  readonly statusCode: number;
  readonly correlationId: string | null;
  readonly errorName: string;
  readonly domainCode: string | null;
  readonly details: unknown;
  readonly issues: unknown;
  readonly retryAfter: string | null;

  constructor(message: string, options: {
    statusCode: number;
    correlationId?: string | null;
    errorName?: string;
    domainCode?: string | null;
    details?: unknown;
    issues?: unknown;
    retryAfter?: string | null;
  });
}

export type ApiContractErrorPhase = "request" | "response";
export type ApiContractErrorKind =
  | "request_schema_mismatch"
  | "malformed_json"
  | "response_schema_mismatch"
  | "unexpected_empty_response";

export class ApiContractError extends Error {
  readonly phase: ApiContractErrorPhase;
  readonly kind: ApiContractErrorKind;
  readonly method: HttpMethod;
  readonly path: string;
  readonly statusCode: number | null;
  readonly correlationId: string | null;
  readonly issues: unknown;

  constructor(message: string, options: {
    phase: ApiContractErrorPhase;
    kind: ApiContractErrorKind;
    method: HttpMethod;
    path: string;
    statusCode?: number | null;
    correlationId?: string | null;
    issues?: unknown;
    cause?: unknown;
  });
}
```

`cause` is deliberately absent from the readonly field list above. Pass it to
`super(message, { cause })` and read it through the inherited `Error.cause`,
which exists under both packages' `lib: ["ES2023"]`. Do not declare a redundant
`readonly cause` field.

```ts
export type RequestBody =
  | { kind: "json"; value: unknown }
  | { kind: "form-data"; value: FormData };

export interface BaseRequestSpec {
  method: HttpMethod;
  path: string;
  body?: RequestBody;
  accept?: string;
  signal?: AbortSignal;
}

export interface JsonRequestSpec<TResponse> extends BaseRequestSpec {
  responseKind?: "json";
  responseSchema: z.ZodType<TResponse>;
}

export interface EmptyRequestSpec extends BaseRequestSpec {
  responseKind: "empty";
  responseSchema?: never;
}

export interface BlobRequestSpec extends BaseRequestSpec {
  responseKind: "blob";
  responseSchema?: never;
}

export type RequestSpec<TResponse = unknown> =
  | JsonRequestSpec<TResponse>
  | EmptyRequestSpec
  | BlobRequestSpec;

export interface NexusHttpClient {
  request<TResponse>(spec: JsonRequestSpec<TResponse>): Promise<TResponse>;
  request(spec: EmptyRequestSpec): Promise<void>;
  request(spec: BlobRequestSpec): Promise<Blob>;
}

export interface NexusHttpClientOptions {
  /** Same-origin API prefix. C3 callers use `/api/v1`. */
  basePath: string;
  /** Required identity seam; pass createNoopSessionPort() before auth exists. */
  session: SessionPort;
  /** Test seam. Production defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
}

export function createNexusHttpClient(options: NexusHttpClientOptions): NexusHttpClient;

export interface WorldApi {
  list(signal?: AbortSignal): Promise<WorldListResponse>;
}

export interface CampaignApi {
  list(signal?: AbortSignal): Promise<CampaignListResponse>;
  turns(campaignId: string, signal?: AbortSignal): Promise<TurnListResponse>;
}

export interface GenerationApi {
  syncStatus(campaignId: string, signal?: AbortSignal): Promise<CampaignSyncStatus>;
  enqueue(campaignId: string, request: GenerationRequest, signal?: AbortSignal): Promise<GenerationEnqueueResponse>;
  enqueueReplacement(campaignId: string, request: GenerationRetryLatestRequest, signal?: AbortSignal): Promise<GenerationEnqueueResponse>;
  get(jobId: string, signal?: AbortSignal): Promise<GenerationJobSnapshot>;
  result(jobId: string, signal?: AbortSignal): Promise<GenerationResult>;
  retry(jobId: string, signal?: AbortSignal): Promise<GenerationActionResponse>;
  cancel(jobId: string, signal?: AbortSignal): Promise<GenerationActionResponse>;
  discard(jobId: string, signal?: AbortSignal): Promise<GenerationActionResponse>;
}

export interface NexusApiClient {
  campaigns: CampaignApi;
  generation: GenerationApi;
  worlds: WorldApi;
}

export function createNexusApiClient(options: NexusHttpClientOptions): NexusApiClient;
```

`GenerationApi` deliberately includes `syncStatus`, even though the URL is
campaign-scoped, so it is structurally assignable to the Task 5
`GenerationApiPort`. The optional Web `AbortSignal` parameters are trailing and
do not leak into client-core; Task 5 can consume the same object through its
narrower pure-core port. This assignability is verified: trailing optional
parameters do not break function assignability, and `get` being absent from
`GenerationApiPort` is fine because extra members are permitted.

`NexusHttpClient.request` intentionally declares three concrete overloads rather
than accepting `RequestSpec<TResponse>` directly, so that the response type
follows from `responseKind` without a cast. A caller holding the bare union must
narrow it before calling. Do not "simplify" this into a single union parameter:
that collapses the return type to `TResponse | void | Blob` and pushes casts
into every call site.

### Transport behavior

- [x] Normalize `basePath` once by removing trailing slashes. Require every
  request `path` to begin with one `/`, reject absolute URLs and protocol-relative
  paths, and join to `/api/v1/...` without double slashes. API methods must apply
  `encodeURIComponent` to every dynamic path segment.
- [x] Set `cache: "no-store"` on every request. `accept` is the **only**
  caller-settable header on `RequestSpec`; there is no general header map.
  Authorization comes solely from `SessionPort`, and `content-type` is chosen by
  the transport from the request body kind.
- [x] For `{ kind: "json" }`, serialize with `JSON.stringify` and set
  `content-type: application/json`. For `{ kind: "form-data" }`, pass the
  `FormData` unchanged and do **not** set `content-type`; the browser must create
  the multipart boundary. Default JSON responses to `accept: application/json`.
  Blob calls may provide a more specific `accept` value such as
  `application/json, application/zip`.
- [x] Support JSON, empty, and blob **response** modes and JSON plus FormData
  **request** modes. There is no current multipart response endpoint, so do not
  add a speculative `Response.formData()` branch. If a later route really
  returns multipart, extend the discriminated union and its tests instead of
  weakening the return type.

  Be aware that **all eleven adopted endpoints return JSON** — `discard` returns
  200 and `retry`/`cancel` return 202, and none returns 204. The `empty` and
  `blob` modes are therefore unexercised by C3's own endpoint table, and their
  tests are deliberately synthetic. They are specified now rather than later
  because Task 9 adopts export (blob) and deletion (204) routes, and because
  `unexpected_empty_response` is a real contract guard for the JSON endpoints
  that do exist. This is a narrower bet than a multipart response branch, which
  no planned route needs at all.
- [x] Treat `responseKind: "empty"` as `Promise<void>` and return `undefined`
  for a successful empty response. A 204/205 received for a JSON or blob spec is
  contract drift and raises `ApiContractError` with
  `kind: "unexpected_empty_response"`; it must not fabricate `null` as valid
  domain data.
- [x] Parse every successful JSON response exactly once. JSON decoding failure
  raises `ApiContractError(kind: "malformed_json")`; Zod failure raises
  `ApiContractError(kind: "response_schema_mismatch")`. Preserve method, relative
  path, status, correlation ID, and Zod issues, but never retain or echo the raw
  response body.
- [x] Validate every adopted JSON request through its shared contract schema in
  `api-client.ts` before calling the transport. A failure raises
  `ApiContractError(phase: "request", kind: "request_schema_mismatch")` and
  performs zero fetches. Do not add defaults, coercion, or a client-only copy of
  any request schema.

### Structured HTTP errors

- [x] For non-2xx responses, attempt `apiErrorEnvelopeSchema.safeParse` after
  decoding JSON. A valid envelope becomes `NexusApiError`; an empty, non-JSON,
  or schema-invalid error body still becomes `NexusApiError` with the generic
  message `Request failed with HTTP <status>.` and safe fallback fields. An HTTP
  error body is not an `ApiContractError`, because the HTTP status remains the
  primary failure.
- [x] Keep JavaScript `error.name` equal to `"NexusApiError"` for stable class
  identification and store the server's `payload.error` separately as
  `errorName`. Map `domainCode` from `payload.details.code` first, then
  `payload.code`, and preserve `details` and `issues` as separate untrusted
  values.
- [x] Use a valid envelope correlation ID first and the
  `x-correlation-id` response header as fallback. When the two disagree, retain
  the envelope value and do not concatenate them. Never synthesize an empty
  string; absent correlation data is `null`.

  **Before C3, the API did not emit that response header.**
  `requestIdHeader: "x-correlation-id"` (`services/api/src/server.ts:232`) only
  tells Fastify how to *read* a correlation ID from the request; the sole
  response-header hook (`services/api/src/request-security.ts:18-28`) sets
  security headers and nothing else. The header fallback covers error bodies this
  API never produced — a gateway or proxy 502, or a truncated response — and the
  server change below made it available on real adopted responses. Keep the
  fallback test synthetic; do not assert a proxy response against a real route.
- [x] **Make the fallback real.** Add `reply.header("x-correlation-id",
  request.id)` to the existing `onRequest` hook in
  `services/api/src/request-security.ts`, and add a unit assertion that an
  adopted route echoes it. This is the one deliberate server-side change in an
  otherwise client-only work package; it is one line, it makes the specified
  client behavior reachable, and it gives support a correlation ID for
  successful responses too, not only structured errors. Keep it in this commit
  so the header and its consumer land together.
- [x] Note for later, not for C3: `request-security.ts:47` allows
  `X-Correlation-Id` as a *request* header via `Access-Control-Allow-Headers`,
  but no `Access-Control-Expose-Headers` is set, so a cross-origin caller could
  not read the response header. C3 is same-origin (`basePath: "/api/v1"`), so
  this does not block Task 4. Task 8 (C7) owns the deployment contract and must
  add the expose header if `/app/` is ever served from another origin.
- [x] Trim and preserve a non-empty `Retry-After` header verbatim in
  `retryAfter`; a blank or missing value becomes `null`. The generic transport
  does not parse the value into a delay, sleep, or retry because retry timing
  belongs to the endpoint workflow.
- [x] Let fetch/network rejections propagate unchanged. In particular, rethrow
  the original `AbortError` object so callers can use its identity/name and do
  not wrap it in either custom error class. Errors from
  `session.authorization()` or `session.onUnauthorized()` likewise propagate
  unchanged and must not trigger another fetch.

### Session and retry semantics

- [x] Call `session.authorization()` immediately before each fetch attempt and
  merge its returned headers without permitting them to replace transport-owned
  `accept` or `content-type` values.
- [x] On the first 401 or 403 only, call `session.onUnauthorized({ statusCode })`.
  If it returns `true`, check the abort signal, reacquire authorization headers,
  and repeat the same request exactly once. If it returns `false`, or if the
  second attempt is also unauthorized, parse and throw that response as
  `NexusApiError` without another callback.
- [x] Treat this as an authorization refresh, not a generic status retry.
  `SessionPort` implementations may return `true` only when the 401/403 is known
  to reject the request before route mutation. The current no-op port always
  returns `false`. Never retry 408, 409, 425, 429, or 5xx automatically, and
  never use `Retry-After` as a transport retry trigger.
- [x] Check `signal.aborted` before authorization, before fetch, and before the
  one allowed authorization retry, using `signal.throwIfAborted()` so a caller's
  abort reason is preserved. An abort during any fetch must keep native
  `AbortError` semantics; no HTTP error should be manufactured from it.

### Typed API methods

- [x] Implement only the endpoint table above. Each method must build an
  API-relative path, use the exact shared request/response schema, pass its
  optional signal through, and return only parsed contract output.
- [x] Import contract values and types through the platform-clean
  `packages/contracts/src/index.ts` public barrel. Do not deep-import a contract
  module or duplicate a schema inside either client package.
- [x] Keep generation action requests bodyless. Do not preserve the legacy
  `body: "{}"` workaround where the Fastify route accepts no request body.
- [x] Prove at compile time in `api-client.test.ts` that `NexusApiClient` exposes
  only deliberate group methods and that `GenerationApi` satisfies Task 5's
  method/return contract, including `syncStatus` and the polling-only `get`
  method needed by Task 6.

### TDD and verification sequence

- [x] Add failing `errors.test.ts` coverage for class identity, immutable
  metadata, `cause`, `errorName` separation, null normalization, issues, and
  `Retry-After` storage. Run
  `pnpm exec vitest run tests/unit/client-core/errors.test.ts`; expect failure
  because the classes do not exist, then implement the minimal pure-core errors
  and rerun to green.
- [x] Add failing `http-client.test.ts` coverage for base-path normalization,
  absolute-path rejection, 200/201/202 JSON, explicit 204/205 empty handling,
  unexpected empty JSON/blob responses, blob output, malformed JSON, schema
  mismatch, request-schema-free transport behavior, JSON serialization,
  FormData boundary ownership, `no-store`, injected fetch, and abort identity.
  Run `pnpm exec vitest run tests/unit/client-web/http-client.test.ts` before and
  after the minimal transport implementation.
- [x] Extend the HTTP tests with empty and malformed 4xx bodies, valid structured
  4xx, correlation header fallback/conflict, top-level/detail code precedence,
  structured and unstructured 5xx, 429 `Retry-After`, and assertions that 408,
  409, 425, 429, and 5xx each perform exactly one fetch. All of these use the
  injected `fetchImpl`; the correlation-header cases are synthetic proxy
  responses by design, not reproductions of a real route.
- [x] Add the server-side assertion in `tests/unit/server-security.test.ts` that
  an adopted route returns an `x-correlation-id` response header, and that it
  echoes a caller-supplied `x-correlation-id` request header. This is the only
  test in Task 4 that exercises the real Fastify app.
- [x] Add session tests for authorization headers, no-op 401/403 behavior,
  `onUnauthorized(false)`, exactly one `onUnauthorized(true)` replay with fresh
  headers, a second unauthorized response, POST replay count, callback failure,
  and abort before the replay. Assert no path can execute more than two fetches.
- [x] Add failing `api-client.test.ts` table tests for every method/path/schema in
  the endpoint inventory, URL-encoded IDs, no-body action requests, request
  schema rejection before fetch, response schema rejection, and signal
  forwarding. Run
  `pnpm exec vitest run tests/unit/client-web/api-client.test.ts` before and after
  implementation.
- [x] Export `HttpMethod`, `NexusApiError`, `ApiContractError`, and their metadata
  types from the deliberate `client-core` public entry point. Export the client
  factories and public API/request types from the deliberate `client-web` entry
  point without exporting internal parsing helpers.
- [x] Declare `zod` with the repository's `^4.0.17` specifier as a direct
  dependency of **both** `client-web` and `client-core`, and update
  `pnpm-lock.yaml`. `client-web` needs it for `z.ZodType` in `RequestSpec`;
  `client-core` already type-depends on it today through
  `ports.ts -> contracts -> zod` while declaring nothing. Extend boundary
  coverage so public-package imports compile and `client-web -> contracts`
  remains platform-clean and framework-free.
- [x] **Do not claim this closes the resolution gap — it does not.** Both client
  packages reach contracts by relative path, and `packages/contracts` has no
  `package.json` at all, so it is not a workspace package and gets no
  `node_modules` of its own. Contracts' own `import { z } from "zod"` therefore
  still resolves by walking up to the root install, no matter what the client
  packages declare. Declaring `zod` locally only hardens each client package's
  *own* `zod` imports. The durable fix is to make `packages/contracts` a real
  workspace package with its own `zod` dependency; that is packaging work owned
  by **Task 8 (C7)**, not C3. Record it there rather than leaving the impression
  that C3 resolved it.
- [x] Run focused checks:
  `pnpm exec vitest run tests/unit/client-core/errors.test.ts tests/unit/client-web/http-client.test.ts tests/unit/client-web/api-client.test.ts tests/unit/client-boundaries.test.ts tests/unit/client-api-contracts.test.ts tests/unit/client-api-routes.test.ts`,
  `pnpm --filter @infinite-quest/client-core check`,
  `pnpm --filter @infinite-quest/client-web check`, and
  `pnpm check:client-boundaries`.
- [x] Run completion checks: `pnpm check`, `pnpm build`, `pnpm test:unit`,
  `pnpm test:integration`, `git diff --check`, review the complete diff for
  unrelated changes, and run `pjm precheck` before committing.
- [x] Commit the independently reviewed Task 4 implementation with an imperative,
  scoped summary such as `feat(client): add validating API transport`. Do not
  mix Story Player rewiring or additional route adoption into this commit.

**Definition of done:** All adopted HTTP calls use one runtime-validating client,
the public package roots expose the deliberate types and factories, every JSON
request and success response is checked by its shared contract, abort identity
is preserved, the API emits the `x-correlation-id` response header the client's
correlation fallback consumes, and the only transport replay is the bounded
`SessionPort` authorization refresh described above. Mutation retry remains an
explicit, endpoint-specific workflow decision rather than an HTTP status side
effect.

**Met**, with four gaps carried into Task 4a. The implementation’s final review
is clean after three narrowly scoped security fix rounds. Task 8 retains the
explicitly deferred contracts-workspace dependency and cross-origin
correlation-header exposure work.

---

## Task 4a — C3a: Close the transport path boundary and dependency inconsistencies

**Status: Complete (2026-08-02).** Implemented in `7bf07fc` and `993b7b6`, with
the query-path refinement in `0fdcb9b`. The scoped implementation review found
that dot scanning constrained query text; the fix re-review is clean. Focused
coverage, package and boundary checks, `pnpm check`, `pnpm build`, 752 unit
tests, and 190 integration tests passed.

**Do this before Task 5.** Task 4's checklist is complete and its behavior is
correct: all eleven endpoints match the table, request and response validation
work, the error taxonomy maps as specified, abort identity is preserved, and the
authorization replay is bounded to two fetches. The completion review found four
gaps, one of which is a security boundary that Task 6 will start depending on as
soon as it builds SSE and polling paths against the exported transport.

**Files:**

- Modify: `packages/client-web/src/http-client.ts`
- Modify: `packages/client-web/src/api-client.ts`
- Modify: `packages/client-core/package.json` **or**
  `scripts/check-client-boundaries.mjs` (see P2 — pick one)
- Modify: `tests/unit/client-web/http-client.test.ts`
- Modify: `tests/unit/client-web/api-client.test.ts`
- Modify: `tests/unit/client-boundaries.test.ts`

### P1 — dot-segment paths escape the API base path

`normalizeBasePath` and `apiPath` (`packages/client-web/src/http-client.ts:56-76`)
reject URL schemes, protocol-relative paths, slashless paths, backslashes, and
control characters across three hardening commits (`15f6454`, `996a129`,
`0ad6033`). They do not reject `.` or `..` segments, which is the most common
member of that same class.

Reproduce with an injected `fetchImpl` and `basePath: "/api/v1"`:

| `path` argument | URL sent to fetch | Browser resolves to |
|---|---|---|
| `/../admin` | `/api/v1/../admin` | `/api/admin` |
| `/worlds/../../../admin` | `/api/v1/worlds/../../../admin` | `/admin` |

`basePath: "/api/v1/.."` is accepted as well, silently re-rooting every request.

**Scope this correctly before you start.** The typed `NexusApiClient` methods are
**not** affected: `encodeURIComponent` leaves `.` unescaped but does escape `/`
as `%2F`, so `generation.get("../../campaigns")` produces the single inert
segment `..%2F..%2Fcampaigns`. This is a defense-in-depth gap in the exported
`createNexusHttpClient`, not a live traversal through today's API surface. It
matters because the transport is public and Tasks 6 and 9 will hand it
constructed paths. Do not describe it as an exploited vulnerability in the
commit message.

- [x] Add a `hasDotSegment(value)` helper that splits on `/` and rejects any
  segment equal to `.` or `..` **after** decoding `%2e`/`%2E`. Percent-encoded
  dots normalize to real dot segments during URL resolution, so a check that
  only looks at literal `.` is insufficient.
- [x] Reject dot segments in `normalizeBasePath` alongside the existing
  conditions, so a bad `basePath` fails at client construction rather than on
  first request.
- [x] Reject dot segments in `apiPath` after the existing leading-slash check,
  with a distinct message such as
  `Request path must not contain '.' or '..' segments.`
- [x] Add a containment backstop after the dot-segment check, so anything the
  segment scan misses still fails closed:

  ```ts
  const joined = `${basePath}${path}`;
  const prefix = basePath === "" ? "/" : `${basePath}/`;
  if (!new URL(joined, "https://boundary.invalid").pathname.startsWith(prefix)) {
    throw new TypeError("Request path must stay within the API base path.");
  }
  ```

  Compare only `pathname`, not the whole URL, so this does not constrain query
  strings that Task 13a (B4a) later adds for bounded reads. The synthetic origin
  is never fetched; it exists only to run the platform's own normalization.
- [x] Extend the existing
  `rejects non-relative, protocol-relative, and slashless request paths` test
  rather than adding a parallel one. Cover `/../admin`,
  `/worlds/../../../admin`, `/./worlds`, `/%2e%2e/admin`, and `/%2E%2E/admin`,
  asserting each rejects **and performs zero fetches**.
- [x] Add a construction-time test that `basePath: "/api/v1/.."` throws.
- [x] Add regression coverage that ordinary paths still work: `/worlds` under
  both `/api/v1` and the root `/` base path, and a dotted-but-legitimate segment
  such as `/worlds/v1.2.3`, which must **not** be rejected. A fix that blocks
  every `.` breaks real identifiers.

This fix has been validated in place: the full unit suite passes with it
applied, so no existing expectation depends on dot segments being accepted.

### P2 — `client-core` declares a `zod` dependency the boundary scanner forbids

Task 4 added `zod` to both client packages. `isClientWebImportAllowed`
(`scripts/check-client-boundaries.mjs:157`) was updated to allow the bare `zod`
specifier; `isClientCoreImportAllowed` was not. Adding
`import type { z } from "zod"` to any client-core module therefore fails
`pnpm check` with
`client-core import zod is outside client-core or contracts`.

So the client-core declaration is inert and unusable: client-core has no direct
`zod` import, and the `contracts -> zod` hop resolves from contracts' own
location regardless of what client-core declares. The original instruction to
declare it in both packages was wrong on that point — a package declaration
cannot fix a transitive resolution that happens in another package.

Pick one and record which in the commit message:

- [x] **Either** remove `zod` from `packages/client-core/package.json` and
  refresh `pnpm-lock.yaml`, on the grounds that client-core has no direct zod
  import and the boundary forbids adding one;
- **Rejected alternative:** allow the bare `zod` specifier in
  `isClientCoreImportAllowed` the same way `isClientWebImportAllowed` does,
  keep the declaration, and add a boundary test asserting client-core may
  import `zod` while still being rejected for Node, DOM, and framework
  specifiers. The completed checkpoint chose dependency removal instead.
- [x] Do not do both halves of one option and neither of the other. The failure
  state to avoid is a declared dependency the boundary check rejects.
- [x] Neither option changes the Task 8 item that makes `packages/contracts` a
  real workspace package. That remains the durable fix and is unaffected.

### P3 — `validatedRequest` hardcodes the request method

`validatedRequest` (`packages/client-web/src/api-client.ts:60-76`) always
constructs its `ApiContractError` with `method: "POST"`. Both current callers are
POSTs, so it is correct today, but the spec requires the error to preserve the
real method, and Task 9 adopts body-carrying routes that are not POST — for
example `PUT /api/v1/campaigns/:campaignId/player-config`. Those would report the
wrong method in their contract errors.

- [x] Add an `HttpMethod` parameter to `validatedRequest` and pass the caller's
  method through. Do not infer it from the path.
- [x] Assert the reported `method` in the existing
  `rejects invalid shared generation requests before the transport fetches`
  test.

### P4 — the Task 4 verification block was never recorded

Tasks 2a, 3, and 3a each record their measured verification figures under
**Completion status**; Task 4's row was marked complete without one. The figures
were measured on the tree at `0ad6033` and are recorded there now, so this
item needs no further work — it is listed only so the omission is not repeated.

It was repeated once: Task 4a's own row was first marked complete without a
verification block, and the Task 4a completion review added one measured on
`0fdcb9b`. **From Task 5 onward, marking a task Complete under Completion
status requires a `Current Task N verification` block in the same commit,
recording the commit it was measured on, the `pnpm check` candidate-file count,
and the unit and integration totals.** Tasks 1 and 2 predate this convention and
are not retroactively deficient; do not backfill them.

**Complete:** the exported transport cannot address anything outside its base
path by any spelling of a dot segment, no package declares a dependency its own
boundary check rejects, contract errors report the method that actually failed,
and each completed task carries a measured verification block.

**Verification:** `pnpm check`, `pnpm build`, `pnpm test:unit`, and
`pnpm test:integration` all pass, plus
`pnpm exec vitest run tests/unit/client-web/http-client.test.ts tests/unit/client-web/api-client.test.ts tests/unit/client-boundaries.test.ts`.

**Met.** P2 chose the removal option; the alternate boundary-relaxation item is
intentionally not selected. Task 8's contracts-workspace work remains deferred.

---

## Task 5 — C4: Pure durable-generation workflow

**Pre-implementation correction status: Revised (2026-08-01), reviewed three
times.** The original scope was reviewed against the current contracts, the
Task 2a stream projection, the Task 4 API client, and the Task 6 checklist. The
earlier C1–C7 corrections remain in force. A second review found that the
rank-only duplicate rule would discard both progressive narration and legitimate
post-retry snapshots, and that the workflow did not define its public handle,
watcher restart, or durable result-recovery lifecycle; C3, C6, and the new
C8–C10 sections resolve those.

A third review re-validated the revised text against the running codebase and
compiled the complete declared public surface — both unions, `GenerationRun`
including its `Extract<>` return type, the dependencies, and the extended
submission — clean under `lib: ["ES2023"]` with `types: []`. It confirmed the
load-bearing premises directly: `retryGeneration` resets status without
incrementing `attempts` (`generation-service.ts:634-638`) while only the worker
claim increments it (`:1279`), the SSE loop closes on `recoverable`
(`server.ts:788`), and `pendingGeneration` excludes completed and failed jobs
(`server.ts:641`) — which is exactly why C6 needs its own `jobId`. That review
made three corrections: `submit()` now stamps `createdAt` from the injected
clock instead of trusting the caller, `StoredGenerationSubmission` is named and
its `exactOptionalPropertyTypes` behavior documented, and C8's restart
requirement is attributed to the server rather than to Task 6 policy.

**Implementation status: Complete (2026-08-01).** The checked work is committed
as `92aa9c4`; focused tests, full build/check/unit verification, and a scoped
review plus two fix re-reviews are clean. The detailed checklist remains the
acceptance record for the completed implementation.

This work package extracts the complete generation behavior, not only the
terminal-status switch. It includes submission persistence, idempotent enqueue,
conflict reconciliation, resume, retry, result fetch, detach, and explicit
remote cancellation.

### Scope boundary

Task 5 is **pure policy**. It owns the state machine, the event sequence,
submission expiry policy, reconciliation strategy, and the single auto-retry
decision. It does **not** own EventSource, polling cadence, backoff, jitter,
visibility handling, or durable storage — Task 6 (C5) owns all of those behind
the ports below. Task 5 must compile and be fully tested under
`packages/client-core/tsconfig.json` with `lib: ["ES2023"]` and `types: []`.

**Files:**

- Create: `packages/client-core/src/generation/types.ts`
- Create: `packages/client-core/src/generation/machine.ts`
- Create: `packages/client-core/src/generation/workflow.ts`
- Create: `packages/client-core/src/generation/submission.ts`
- Modify: `packages/client-core/src/ports.ts`
- Modify: `packages/client-core/src/index.ts`
- Create: `tests/unit/client-core/generation-machine.test.ts`
- Create: `tests/unit/client-core/generation-workflow.test.ts`
- Create: `tests/unit/client-core/generation-submission.test.ts`

`packages/client-core/src/index.ts` was missing from the original file list.
Tasks 6 and 7 consume this workflow through the deliberate public entry point,
so the new types and factories must be exported there — and only the deliberate
ones, per the Task 3 rule against barrel-exporting internal modules.

**Ports consumed:**

```ts
export interface GenerationApiPort {
  enqueue(campaignId: string, request: GenerationRequest): Promise<GenerationEnqueueResponse>;
  enqueueReplacement(campaignId: string, request: GenerationRetryLatestRequest): Promise<GenerationEnqueueResponse>;
  syncStatus(campaignId: string): Promise<CampaignSyncStatus>;
  result(jobId: string): Promise<GenerationResult>;
  retry(jobId: string): Promise<GenerationActionResponse>;
  cancel(jobId: string): Promise<GenerationActionResponse>;
  discard(jobId: string): Promise<GenerationActionResponse>;
}

/**
 * The source yields a discriminated union, not bare snapshots. A transport is
 * the only layer that knows whether a failure was a lost stream or a failed
 * poll, and it is the layer that counts consecutive failures across reconnects.
 * Core forwards these; it never classifies or counts them itself.
 */
export type GenerationSourceEvent =
  | { kind: "snapshot"; snapshot: GenerationStreamSnapshot }
  | { kind: "degraded"; reason: "stream_lost" | "poll_failed"; consecutiveFailures: number };

export interface GenerationSnapshotSource {
  watch(jobId: string, signal: AbortSignalLike): AsyncIterable<GenerationSourceEvent>;
}
```

**Events produced:**

```ts
export type GenerationEvent =
  | { type: "status"; snapshot: GenerationStreamSnapshot }
  | { type: "narration"; text: string }
  | { type: "degraded"; reason: "stream_lost" | "poll_failed"; consecutiveFailures: number }
  | { type: "detached"; jobId: string }
  | { type: "result_unavailable"; jobId: string; error: Error }
  | { type: "settled"; outcome: "completed"; result: GenerationResult }
  | { type: "settled"; outcome: "failed" | "cancelled" | "discarded" | "unrecoverable"; error: Error };
```

**Public workflow surface and cancellation ownership:**

```ts
export interface GenerationRun {
  readonly campaignId: string;
  readonly jobId: string;
  watch(signal: AbortSignalLike): AsyncIterable<GenerationEvent>;
  retryGeneration(signal: AbortSignalLike): AsyncIterable<GenerationEvent>;
  cancelGeneration(): Promise<GenerationActionResponse>;
  discardGeneration(): Promise<GenerationActionResponse>;
  fetchResult(): Promise<
    | Extract<GenerationEvent, { type: "settled"; outcome: "completed" }>
    | Extract<GenerationEvent, { type: "result_unavailable" }>
  >;
}

/**
 * The stored envelope, extended by C6 with local durable-recovery metadata.
 */
export interface StoredGenerationSubmission extends PendingGenerationSubmission {
  jobId?: string;
}

/**
 * What a caller supplies. `createdAt` and `jobId` are stamped by the workflow,
 * never by the caller — see the clock-ownership rule below.
 */
export type GenerationSubmissionInput =
  Omit<StoredGenerationSubmission, "createdAt" | "jobId">;

export interface GenerationWorkflow {
  submit(campaignId: string, submission: GenerationSubmissionInput): Promise<GenerationRun>;
  resume(campaignId: string): Promise<GenerationRun | null>;
}

export interface GenerationWorkflowDependencies {
  api: GenerationApiPort;
  source: GenerationSnapshotSource;
  clock: Clock;
  pendingSubmissions: PendingSubmissionStore;
}

export function createGenerationWorkflow(
  dependencies: GenerationWorkflowDependencies
): GenerationWorkflow;
```

- [x] `submit()` persists the supplied exact envelope, enqueues it, records the
  returned durable `jobId`, and returns a run. It does not begin browser work.
  The UI owns the `AbortController`; client-core only receives its
  `AbortSignalLike` through `watch()` or `retryGeneration()`.
- [x] **One clock owns the expiry window.** `submit()` takes
  `GenerationSubmissionInput` and stamps `createdAt` itself from the injected
  `Clock`; the caller must not supply it. C6 enforces the 15-minute window by
  comparing `Clock.now()` against that same `createdAt`, so both ends of the
  comparison must come from the same clock. If the caller stamped it with
  `Date.now()` while core read an injected fake, the boundary test the TDD
  sequence requires would pass without measuring anything — production would
  agree by coincidence and tests would be meaningless.
- [x] `jobId` is likewise workflow-owned: written after enqueue resolves, never
  accepted from a caller. `Omit<..., "createdAt" | "jobId">` makes both rules
  compile-enforced rather than conventions.
- [x] A `GenerationRun` permits exactly one live source iterator. A second
  `watch()` or `retryGeneration()` while one is live throws a typed
  `GenerationWorkflowProtocolError("watch_already_active")`; a completed or
  detached iterator releases that slot. This prevents a retry or a UI rerender
  from creating overlapping watchers for one durable job.
- [x] `cancelGeneration()` and `discardGeneration()` issue only their matching
  remote command and **never** abort the consumer-owned signal. The active
  watcher observes the authoritative terminal snapshot and emits `settled`.
  `retryGeneration(signal)` issues `api.retry(jobId)` and then starts a fresh
  source session for that same job ID; it is available only after the prior
  iterator has ended.
- [x] `fetchResult()` returns either `settled/completed` or
  `result_unavailable`, never an untyped transport rejection. A successful
  later call therefore gives Task 7 the same event shape as an initially
  successful result fetch.
- [x] Export exactly `GenerationWorkflow`, `GenerationRun`,
  `GenerationWorkflowDependencies`, `GenerationSubmissionInput`,
  `StoredGenerationSubmission`, `GenerationEvent`, `GenerationSourceEvent`,
  `GenerationSnapshotSource`, `GenerationWorkflowProtocolError`, and
  `createGenerationWorkflow` from the client-core barrel. Keep machine and
  submission helpers internal. `GenerationSubmissionInput` must be exported
  because callers construct it; `StoredGenerationSubmission` must be exported
  because Task 6 serializes it.

### C1 — the snapshot source must carry degradation

The original port yielded `AsyncIterable<GenerationStreamSnapshot>` while the
event union required core to emit
`{ type: "degraded"; reason; consecutiveFailures }`. Core cannot produce either
field from a stream of snapshots: `reason` is transport identity, which the port
deliberately hides, and `consecutiveFailures` is counted across reconnects
inside the source. Task 6 separately claimed to "emit degraded state after two
consecutive failures", so the same event had two owners and no viable carrier.

- [x] Consume `AsyncIterable<GenerationSourceEvent>` as declared above.
- [x] On `{ kind: "degraded" }`, forward it as a `degraded` **without** altering
  the state machine's high-water mark, without resetting narration, and without
  counting anything. Degradation is transport health, not job progress.
- [x] Do not re-derive, re-count, or second-guess `consecutiveFailures`. Task 6
  owns the counter and the reset-on-success rule.
- [x] Task 6's matching checklist item has been updated to yield this union.

### C2 — parse every incoming snapshot with the contract schema

`GenerationJobSnapshot` (the polling response, ~24 fields including
`createdAt`, `updatedAt`, and `completedAt`) is **structurally assignable** to
`GenerationStreamSnapshot` (11 fields). Verified: assigning one to the other
compiles with no error. So a poll source that forwards `GenerationApi.get()`
output unprojected would silently reintroduce exactly the timestamps Task 2a
removed, and no type check would catch it. A changing `updatedAt` is what
defeated change detection in the first place.

- [x] Parse every inbound `{ kind: "snapshot" }` payload with
  `generationStreamSnapshotSchema` before it reaches the state machine. This is
  the load-bearing guard: it cannot be bypassed by a careless transport.
- [x] Rely on the parse to strip excess keys. Verified: parsing a full
  `GenerationJobSnapshot` through `generationStreamSnapshotSchema` yields
  exactly the eleven allowlisted keys, and `"updatedAt" in parsed` is `false`.
- [x] This same parse satisfies "reject malformed statuses" — a status outside
  the contract enum fails the parse. Reject the **snapshot**; do not reject a
  legitimate polling gap, which is an absent stage, not an invalid one.
- [x] Add a test feeding a full `GenerationJobSnapshot` through the source and
  asserting no timestamp key reaches any emitted `status` event.
- [x] Task 6's checklist has been updated to project the polling path through
  the same schema. Both layers do it; core's is the guarantee.

### C3 — define staleness before testing it

The original checklist required testing a "stale snapshot", but
`GenerationStreamSnapshot` carries **no timestamp** — Task 2a removed all three
deliberately, and a type-level check confirms `"updatedAt" extends keyof
GenerationStreamSnapshot` is `false`. There is no clock in the frame to compare.

Staleness is therefore an ordering over the two monotonic fields the projection
does carry. ADR 0028 names `attempts` "the monotonic retry-cycle marker used for
stream reconciliation"; this is what it is for.

- [x] Rank statuses within one attempt:
  `queued`/`replacement_queued` = 0, `assessing` = 1, `generating` = 2,
  `validating` = 3, `committing` = 4, and every attempt-terminal status
  (`completed`, `failed`, `discarded`, `cancelled`, `recoverable`) = 5.
- [x] Track a high-water mark of `(attempts, rank)` compared
  lexicographically. A snapshot strictly below the mark is stale and emits
  nothing, **except** for the acknowledged retry transition below. A tuple that
  skips ranks is a legitimate polling gap: accept it and advance.
- [x] An equal tuple is a duplicate only when all eleven allowlisted snapshot
  fields are unchanged. Equal `(attempts, rank)` snapshots with changed
  `partialNarration`, `errorCode`, `errorMessage`, `resultTurnId`, or terminal
  `status` are meaningful updates: emit the projected `status` event. Emit a
  `narration` event when `partialNarration` changes, with `text` equal to the
  full current sanitized narration; when it changes from a string to `null`,
  emit `{ type: "narration", text: "" }` once to clear the preview. Never
  concatenate or derive narration from any other field.
- [x] The server's retry endpoint changes `recoverable` or `failed` to
  `queued`/`replacement_queued` **without** incrementing `attempts`; the worker
  increments it only when it next claims the job. After this run has received a
  successful `api.retry(jobId)` response, allow exactly the matching
  same-attempt queue snapshot to begin a new observation cycle, then require
  normal monotonic ordering again. Do not generally allow rank regressions.
- [x] A same-rank terminal transition such as `failed -> discarded` is accepted
  only after the matching successful run command. It is not a duplicate merely
  because both statuses rank 5. An unsolicited conflicting terminal transition
  is a protocol error, not a reason to silently overwrite the prior terminal
  meaning.

### C4 — a completed generation whose result cannot be fetched

`{ outcome: "completed"; result: GenerationResult }` requires a successful
`result(jobId)` call, yet the test list demanded "result-fetch failure"
coverage. The only shape available was `settled/unrecoverable`, which would
report a **successful** generation as unrecoverable — and the same checklist
forbids mutating accepted campaign state on that path.

- [x] Emit the new non-terminal `{ type: "result_unavailable"; jobId; error }`
  when a job reaches `completed` but `result(jobId)` rejects. The generation
  succeeded durably; only the client's fetch failed.
- [x] Do **not** emit `settled` for this case, and do not treat it as
  `unrecoverable`. The workflow stays open so a consumer can request the result
  again.
- [x] Expose an explicit `fetchResult()` operation so a consumer can retry after
  `result_unavailable` without re-enqueueing anything.

### C5 — reconciliation: what `syncStatus` can and cannot decide

`pendingGenerationSchema` carries `id`, `status`, `action`, `operationKind`,
`expectedTurnNumber`, `createdAt`, and `updatedAt` — **no idempotency key**. So
`syncStatus` alone cannot prove an in-flight job is the one this client
submitted; the same action submitted twice, or a submission from another tab,
is indistinguishable. The original instruction implied `syncStatus` decides
whether to replay. It cannot.

- [x] Use `syncStatus` for one purpose: detecting that *a* generation is in
  flight, so the workflow attaches to `pendingGeneration.id` and watches it
  rather than enqueueing again. This is also the reload-resume path.
- [x] Resolve genuine ambiguity by replaying the enqueue with the **same
  idempotency key** and trusting the server. `generationEnqueueResponseSchema`
  returns `duplicate: boolean`; `duplicate: true` means the original submission
  was already accepted, and the returned `id` is the durable job to watch.
- [x] Never mint a new idempotency key during reconciliation. The key lives in
  the persisted submission precisely so a replay is provably the same request.
- [x] Do not match a pending job to a local submission by comparing `action`,
  `operationKind`, or `expectedTurnNumber`. Those collide legitimately.

### C6 — expiry policy is core's; storage is Task 6's

Task 5 said core expires submissions "using the injected clock" while Task 6
said it implements "the 15-minute pending-submission store". `PendingSubmission
Store` takes no TTL argument and `PendingGenerationSubmission.createdAt` is a
number, so core can and should own the decision.

- [x] Extend `PendingGenerationSubmission` with an optional `jobId?: string`,
  declared as `StoredGenerationSubmission` above. The request envelope remains
  exact and immutable; `jobId` is local durable recovery metadata written
  immediately after enqueue accepts or duplicates the request. Task 6 must
  round-trip both the new field and pre-existing records that do not contain it.
- [x] **`exactOptionalPropertyTypes: true` is set for client-core**, so
  `jobId?: string` permits *omitting* the key but forbids assigning `undefined`
  to it. Round-tripping through `JSON.parse` is fine because an absent key stays
  absent, but the natural `{ ...submission, jobId: undefined }` spread fails to
  compile with `TS2375`. Build the record without the key when there is no job
  ID; do not widen the field to `string | undefined` to dodge the error, because
  that would let "no job" and "job unknown" become indistinguishable in the
  stored record.
- [x] Core owns expiry policy: compare `Clock.now()` against
  `submission.createdAt` and treat anything older than 15 minutes as absent,
  clearing it through `PendingSubmissionStore.clear`.
- [x] Task 6 owns durable storage only: serialization, defensive JSON parsing,
  and campaign-scoped keys. It must not implement a second expiry rule.
- [x] Persist the exact submission **before** calling `enqueue`, so an
  interrupted enqueue is still replayable. Once enqueue resolves, save the same
  envelope with its returned `jobId` before beginning observation.
- [x] `resume()` first removes an expired record, then obtains `syncStatus`.
  If `pendingGeneration` exists, attach to that server-authoritative ID and
  clear any campaign-scoped local submission, because one local slot cannot
  safely distinguish an in-flight request from another tab. Never compare
  action, operation kind, or expected turn to claim identity.
- [x] If no pending job exists and the unexpired record has `jobId`, return a
  run for that ID. This preserves manual retry of a failed job and
  `result_unavailable` recovery after reload, even though `syncStatus` exposes
  neither completed nor failed jobs. If it has no `jobId`, replay exactly the
  original request and idempotency key.
- [x] Clear the saved record only after `settled/completed` with a retrieved
  result, or after authoritative `cancelled` or `discarded`. Retain it for
  `failed`, `recoverable`, `unrecoverable`, and `result_unavailable`, so the
  user can resume, retry, discard, or fetch the already accepted result.

### C7 — remaining behavior (unchanged in intent, retained here)

- [x] Derive the status union from `packages/contracts`; do not redeclare it.
  There is no exported named type for the union — `generationStatusSchema` is
  module-private in `client-api.ts` — so index the projection type:
  `type GenerationStatus = GenerationStreamSnapshot["status"]`. Verified to
  accept all eleven members. Use `generationStreamSnapshotSchema` for the
  runtime check, per C2.
- [x] Model retry loops `recoverable -> queued|replacement_queued -> ...` on the
  same durable job ID. The queue snapshot initially retains its former
  `attempts` value and the next `assessing` snapshot increments it; implement
  the C3 acknowledged-retry exception rather than assuming the queue transition
  itself increments attempts. `generationActionResponseSchema` constrains
  `retry`/`cancel`/`discard` to exactly
  `queued`/`replacement_queued`/`cancelled`/`discarded`, which matches.
- [x] Emit narration only from `partialNarration`. Ignore `partialOutput` even
  if a transport includes it; note that C2's parse already strips it, so this
  is defence in depth rather than the primary guard.
- [x] Treat watcher abort as detach and emit `detached`. Call the remote cancel
  endpoint only through an explicit `cancelGeneration()` operation.
- [x] Auto-retry at most once per durable job, not once per page load. The first
  recoverable snapshot after the job's first claimed attempt may auto-retry;
  a recoverable snapshot after a retried attempt must emit
  `settled/unrecoverable` without mutating accepted campaign state. Derive the
  decision from the server's monotonic `attempts` lifecycle and test a reload
  between the two recoverable snapshots.

### C8 — watcher sessions must restart deliberately and end unambiguously

This is forced by the API, not chosen by the client. The server's SSE loop
breaks on any of `completed`, `failed`, `recoverable`, `discarded`, or
`cancelled` (`services/api/src/server.ts:788`) and then ends the response, so
the stream is already closed by the time a retry is issued. Task 6 closes its
EventSource on the same set. A retry therefore cannot rely on the original
iterator to observe the next queue cycle — no Task 6 implementation choice can
change that, and a fresh source session is mandatory rather than preferable.

- [x] `watch(signal)` loops through sequential source sessions for one job. On
  the first recoverable status it waits for the successful retry action, closes
  the completed source session, and opens a fresh `source.watch(jobId, signal)`.
  There must never be two live iterators for that job.
- [x] A source may complete normally only after core has accepted an authoritative
  terminal snapshot or the supplied signal is aborted. If it completes while
  the latest accepted snapshot is non-terminal, throw
  `GenerationWorkflowProtocolError("source_ended_before_terminal")`; do not
  emit `settled`, do not clear persistence, and leave the durable job resumable.
- [x] If contract parsing of a source snapshot fails, throw
  `GenerationWorkflowProtocolError("invalid_snapshot", { cause })` with the
  same no-settlement and no-clear rule. A malformed source is not a durable job
  failure and must not be relabeled as `unrecoverable`.
- [x] If the signal is already aborted or becomes aborted while iterating, close
  the iterator, emit exactly one `detached` event, and retain the saved record.
  An abort must not call any remote action.

### C9 — action, stream, and terminal races have one owner

- [x] Route auto-retry through the same internal retry transition used by
  `GenerationRun.retryGeneration()`. Mark the transition acknowledged only
  after `api.retry(jobId)` resolves with the matching job ID and a queue status;
  a rejection leaves the durable job recoverable and emits the documented
  `settled/unrecoverable` error without clearing persistence.
- [x] For explicit cancel and discard, keep the watcher active until it observes
  the authoritative terminal snapshot. If the command resolves after an
  independently received terminal snapshot, emit settlement once only and make
  later duplicate source frames no-ops.
- [x] If a command response names a different job ID or an impossible status,
  throw `GenerationWorkflowProtocolError("action_response_mismatch")`, retain
  persistence, and do not synthesize a status frame from the partial action
  response.

### C10 — test the revised observable contract, not only status ranks

- [x] Add `GenerationWorkflowProtocolError` to `generation/types.ts` with
  `kind` limited to `"watch_already_active"`, `"invalid_snapshot"`,
  `"source_ended_before_terminal"`, and `"action_response_mismatch"`. Export
  the type and class through the deliberate client-core public surface.
- [x] Keep all parsing and protocol errors free of DOM, EventSource, fetch,
  database, and framework types. Test them with plain async-iterable fakes and
  the existing `AbortSignalLike` test double.

### TDD and verification sequence

- [x] Write `generation-machine.test.ts` first, covering the `(attempts, rank)`
  ordering from C3: an exact duplicate, two `generating` frames with different
  `partialNarration`, a `partialNarration` clear, skipped stages, a stale
  snapshot, `recoverable(1) -> queued(1) -> assessing(2)` after acknowledged
  retry, `failed -> discarded` after explicit discard, and every terminal
  status. Run
  `pnpm exec vitest run tests/unit/client-core/generation-machine.test.ts`,
  expect failure, then implement `machine.ts`.
- [x] Write `generation-submission.test.ts` for persist-before-enqueue, saving
  the returned `jobId` after enqueue, the 15-minute expiry boundary against a
  fake `Clock` (just inside and just outside — the fake clock must be the only
  source of both the stamped `createdAt` and the comparison, or the test proves
  nothing), key stability across a replay,
  resume from a saved failed/completed job ID, and the explicit clearing rules
  for completed, cancelled, discarded, and another-tab pending generation. Run
  it red, then implement `submission.ts`.
- [x] Write `generation-workflow.test.ts` for the exported workflow/handle
  surface, reload resume via `pendingGeneration.id`, ambiguous-enqueue replay
  with `duplicate: true`, one auto-retry across a fresh source session, reload
  after that retry without a second automatic retry, detach, explicit
  cancellation and discard races, `result_unavailable` followed after reload by
  a successful `fetchResult()`, degraded forwarding, timestamp stripping, a
  malformed snapshot, a non-terminal source completion, and no-duplicate-watch
  enforcement. Run it red, then implement `workflow.ts`.
- [x] Export the deliberate public surface from
  `packages/client-core/src/index.ts` and confirm no internal module is
  barrel-exported.
- [x] Run focused checks:
  `pnpm exec vitest run tests/unit/client-core/ tests/unit/client-boundaries.test.ts`,
  `pnpm --filter @infinite-quest/client-core check`, and
  `pnpm check:client-boundaries`.
- [x] Run completion checks: `pnpm check`, `pnpm build`, `pnpm test:unit`,
  `pnpm test:integration`, `git diff --check`, review the complete diff for
  unrelated changes, and run `pjm precheck` before committing.
- [x] Record a **Current Task 5 verification** block under **Completion status**
  in the same commit that marks Task 5 complete, per the rule in Task 4a P4.
- [x] Commit with an imperative scoped summary such as
  `feat(client): add pure generation workflow`. Do not mix Task 6 transports or
  Story Player rewiring into this commit.

**Definition of done:** The same event sequence is produced for identical job
snapshots regardless of transport, including progressive narration at an equal
status rank and the server's same-attempt queue frame after retry. No timestamp
from any transport can reach the state machine. A completed generation is never
reported as unrecoverable because its result fetch failed, and that result can
be recovered after reload. Exactly one watcher observes a durable job at a time;
all ambiguous source failures leave it resumable. No framework, browser,
network, or database type appears in the workflow.

---

## Task 5a — C4a: Discriminate and canonicalize pending submissions

**Do this before Task 6.** Task 6's S9 requires the storage layer to parse a
`replace_latest` record with `generationRetryLatestRequestSchema` and refine
`request.expectedCurrentTurnNumber === expectedTurnNumber`. Task 5's types
currently express neither the replacement request shape nor that cross-field
invariant, so as things stand Task 6 would be enforcing on read something the
write path never established.

**Files:**

- Modify: `packages/client-core/src/ports.ts`
- Modify: `packages/client-core/src/generation/types.ts`
- Modify: `packages/client-core/src/generation/submission.ts`
- Modify: `tests/unit/client-core/generation-submission.test.ts`

### This changes already-shipped work

Task 5a edits types that Task 5 shipped and marked complete in `92aa9c4`.

- [x] Land it as its **own reviewable commit**, not folded into Task 6. A change
  to completed work should be revertible on its own, and mixing it into the
  transport work would hide a client-core type change inside a client-web diff.
- [x] Expect the change to be source-compatible for `append` submissions. Every
  existing call site constructs one, so the union's `append` branch matches what
  is already written. There is no existing client-core replacement caller to
  preserve; Task 5a deliberately defines that public input shape before Task 9
  adopts it.
- [x] **No existing test needs repair, because no existing test exercises the
  replacement path at all.** Verified: nothing under `tests/unit/client-core/`
  constructs a submission with `operationKind: "replace_latest"`, and
  `enqueueReplacement` appears there only as an unexercised stub on the fake
  API port. `tests/unit/client-core/generation-submission.test.ts` is in the
  file list to **add** that coverage, not to fix fixtures.
- [x] Treat that coverage gap as part of the defect. The cast at
  `submission.ts:50` sits on a branch no test has ever run, which is why a
  type-level hole survived Task 5's review. Add a runtime test that a
  `replace_latest` submission reaches `enqueueReplacement` with its
  `expectedCurrentTurnNumber` intact, alongside the `@ts-expect-error`
  compile-level assertions below.

### The defect

`PendingGenerationSubmission.request` is typed `GenerationRequest`, which has no
`expectedCurrentTurnNumber`. A `replace_latest` submission therefore cannot be
represented correctly, and `submission.ts:50` papers over it with an unguarded
cast:

```ts
: await dependencies.api.enqueueReplacement(campaignId, submission.request as GenerationRetryLatestRequest);
```

The resulting write/read asymmetry is the real problem. `submit()` accepts a
replacement whose request lacks the field — it compiles, and `enqueue()` calls
`store.save()` **before** the API call, so the invalid record reaches disk. Task
4's client then rejects the request with `ApiContractError`. After a reload,
Task 6's strict `load()` would reject that same stored record and silently drop
a pending submission the user believes is queued.

Presence alone is not sufficient. A discriminated union can require both
numbers, but TypeScript cannot express that two arbitrary `number` properties
have the same runtime value. This object would still satisfy a union that merely
changes the replacement request type:

```ts
{
  operationKind: "replace_latest",
  expectedTurnNumber: 8,
  request: { ...replacementRequest, expectedCurrentTurnNumber: 7 }
}
```

Persisting that object would leave the same asymmetry: Task 6 must reject it on
load. The trusted submission input therefore must not expose two independently
settable replacement turn numbers.

### The fix

- [x] In `ports.ts`, import both `GenerationRequest` and
  `GenerationRetryLatestRequest`, then replace the interface with a
  discriminated persisted union:

  ```ts
  type PendingGenerationSubmissionBase = { expectedTurnNumber: number; createdAt: number };
  export type PendingGenerationSubmission =
    | (PendingGenerationSubmissionBase & { operationKind: "append"; request: GenerationRequest })
    | (PendingGenerationSubmissionBase & { operationKind: "replace_latest"; request: GenerationRetryLatestRequest });
  ```

- [x] `StoredGenerationSubmission` must become an intersection, not an
  `interface … extends`: an interface cannot extend a union type.

  ```ts
  export type StoredGenerationSubmission = PendingGenerationSubmission & { jobId?: string };
  ```

- [x] **`Omit` does not distribute over unions** — verified. A naive
  `Omit<StoredGenerationSubmission, "createdAt" | "jobId">` collapses both
  branches into one object type whose `request` widens back to
  `GenerationRequest`, silently undoing the whole change while still compiling.
  Apply `Omit` separately to each extracted branch. Keep
  `expectedTurnNumber` on append input, but omit it from replacement input so
  the nested request is the only caller-supplied replacement turn number:

  ```ts
  type AppendGenerationSubmissionInput = Omit<
    Extract<StoredGenerationSubmission, { operationKind: "append" }>,
    "createdAt" | "jobId"
  >;

  type ReplaceLatestGenerationSubmissionInput = Omit<
    Extract<StoredGenerationSubmission, { operationKind: "replace_latest" }>,
    "createdAt" | "jobId" | "expectedTurnNumber"
  >;

  export type GenerationSubmissionInput =
    | AppendGenerationSubmissionInput
    | ReplaceLatestGenerationSubmissionInput;
  ```

  Do not export the two branch helpers; callers consume the deliberate union.
- [x] In `submission.ts`, branch while constructing the stored record. Append
  retains the caller's `expectedTurnNumber`; replacement derives it from
  `request.expectedCurrentTurnNumber`. Construct the replacement record
  explicitly so an unexpected extra top-level property from an untyped caller
  cannot override the canonical value:

  ```ts
  const createdAt = dependencies.clock.now();
  const submission: StoredGenerationSubmission = input.operationKind === "append"
    ? { ...input, createdAt }
    : {
        operationKind: "replace_latest",
        request: input.request,
        expectedTurnNumber: input.request.expectedCurrentTurnNumber,
        createdAt
      };
  ```

  This is construction, not storage-boundary validation. Task 6 still owns
  runtime parsing and equality refinement for records read from untrusted Web
  Storage.
- [x] Delete the cast at `submission.ts:50`. Narrowing on
  `submission.operationKind === "replace_latest"` now gives
  `GenerationRetryLatestRequest` directly — verified. If the cast is still
  needed after the change, the union was not applied correctly. Remove the
  now-unused `GenerationRetryLatestRequest` import from `submission.ts`.
- [x] Add a compile-level test asserting that a `replace_latest` submission
  whose `request` lacks `expectedCurrentTurnNumber` is **rejected**, using
  `@ts-expect-error`. Add a second compile-level assertion that replacement
  `GenerationSubmissionInput` rejects a caller-supplied top-level
  `expectedTurnNumber`; this prevents the duplicate source of truth from
  returning later. Keep each deliberately invalid object on one line after its
  directive so the directive can suppress only the intended assignment error:

  ```ts
  // @ts-expect-error replace_latest requires the nested current turn number
  const missingReplacementTurn: GenerationSubmissionInput = { operationKind: "replace_latest", request: input().request };

  // @ts-expect-error replace_latest derives the stored turn number from request
  const duplicateReplacementTurn: GenerationSubmissionInput = { operationKind: "replace_latest", expectedTurnNumber: 4, request: replacementRequest() };
  ```

  Reference both constants in a no-op expression such as `void
  missingReplacementTurn; void duplicateReplacementTurn;` if the compiler's
  unused-local settings require it; do not weaken the type or cast the objects.
- [x] Add a runtime replacement test that verifies the complete durable order:
  the first saved record contains the request's exact idempotency key and a
  top-level `expectedTurnNumber` derived from
  `request.expectedCurrentTurnNumber`; `enqueueReplacement()` receives the
  intact request; and the second save adds only the returned `jobId`. Include a
  coerced untyped input carrying a conflicting extra `expectedTurnNumber` and
  prove it cannot override the derived stored value.
- [x] Do not add a second equality **parser** in client-core. Task 6 S9 owns that
  check when an untrusted stored record is loaded. Client-core establishes the
  invariant for its trusted write path by construction; Task 6 validates it at
  the persistence boundary.

### TDD and completion sequence

- [x] Add the two compile-level assertions and the runtime replacement case
  before changing production code. Run `pnpm --filter
  @infinite-quest/client-core check`; expect both `@ts-expect-error` directives
  to be reported as unused against the current broad input type. Run `pnpm exec vitest run
  tests/unit/client-core/generation-submission.test.ts`; expect the replacement
  case to fail because the current spread preserves the forged conflicting
  top-level turn number instead of deriving it from the replacement request.
- [x] Implement the persisted union, branch-specific input types, canonical
  replacement construction, import cleanup, and cast removal. Rerun both red
  commands and require them to pass.
- [x] Run `pnpm exec vitest run tests/unit/client-core/
  tests/unit/client-boundaries.test.ts` to prove append compatibility, workflow
  behavior, and the deliberate public barrel remain intact.
- [x] Run `pnpm check`, `pnpm build`, `pnpm test:unit`, and
  `pnpm test:integration`; then run `git diff --check`, review the complete diff
  for unrelated changes, and run `pjm precheck` for every changed path.
- [x] Update Task 5a's completion row and add the measured **Current Task 5a
  verification** block in the same commit, recording the implementation commit,
  the `pnpm check` candidate-file count, and unit/integration totals. Commit only
  Task 5a source, tests, and its plan status before beginning Task 6.

**Complete:** a `replace_latest` input cannot be constructed without its nested
`expectedCurrentTurnNumber` or with a second caller-controlled top-level turn
number; client-core derives and persists the top-level value before enqueue;
`submission.ts` contains no cast; and Task 6 S9 defensively validates the same
invariant when reading untrusted storage.

**Verification:** `pnpm check`, `pnpm build`, `pnpm test:unit`,
`pnpm test:integration`, plus
`pnpm exec vitest run tests/unit/client-core/ tests/unit/client-boundaries.test.ts`.
Record a **Current Task 5a verification** block in the same commit, per the rule
in Task 4a P4.

---

## Task 6 — C5: Browser transports, persistence, and adaptive polling

**Pre-implementation correction status: Complete (2026-08-02), reviewed twice.**
The first review checked the **shipped** Task 5 code in `92aa9c4` rather than its
design sketch and proved that Task 4's `client.generation` satisfies Task 5's
`GenerationApiPort` without an adapter. The second review checked the proposed
browser layer against the live HTTP path guard, native EventSource constraints,
the legacy pending-submission format, Task 5's protocol errors, and the public
compiler fixture. The eleven correction areas S1–S11 below are the complete
implementation contract; do not implement only the original transport bullets.

**Files:**

- Create: `packages/client-web/src/generation/event-source.ts`
- Create: `packages/client-web/src/generation/poll-source.ts`
- Create: `packages/client-web/src/generation/fallback-source.ts`
- Create: `packages/client-web/src/generation/abort-bridge.ts`
- Create: `packages/client-web/src/generation/types.ts`
- Create: `packages/client-web/src/api-url.ts`
- Create: `packages/client-web/src/storage/pending-submissions.ts`
- Create: `packages/client-web/src/platform/clock.ts`
- Create: `packages/client-web/src/platform/delay.ts`
- Create: `packages/client-web/src/platform/ids.ts`
- Create: `packages/client-web/src/platform/visibility.ts`
- Modify: `packages/client-web/src/http-client.ts`
- Modify: `packages/client-web/src/index.ts`
- Modify: `tests/unit/client-web/http-client.test.ts`
- Modify: `tests/unit/client-boundaries.test.ts`
- Modify: `tests/fixtures/client-boundaries/client-web-public/src/fixture.ts`
- Create: `tests/unit/client-web/generation-event-source.test.ts`
- Create: `tests/unit/client-web/generation-poll-source.test.ts`
- Create: `tests/unit/client-web/generation-fallback-source.test.ts`
- Create: `tests/unit/client-web/pending-submissions.test.ts`
- Create: `tests/unit/client-web/platform-adapters.test.ts`

`packages/client-web/src/index.ts` was missing from the original list — the same
omission Task 5 had. Export only the composed browser generation source, its
public option types, the pending-submission store, and the clock, delay, ID, and
visibility adapters. Keep raw EventSource/poll factories, the abort bridge, URL
resolver, storage schemas, error classifiers, and parsing helpers internal. A raw
SSE source cannot satisfy Task 5 by itself because a stream loss must switch to
polling without ending the iterable; exporting it as `GenerationSnapshotSource`
would create a public footgun.

### Public surface produced

Define these names before writing the transports so Task 9 does not invent a
second composition API:

```ts
export interface EventSourceLike {
  onmessage: ((event: MessageEvent<string>) => void) | null;
  onerror: ((event: Event) => void) | null;
  close(): void;
}

export type EventSourceFactory = (url: string) => EventSourceLike;

export interface VisibilitySource {
  isHidden(): boolean;
  waitUntilVisible(signal: AbortSignalLike): Promise<void>;
}

export interface BrowserGenerationSourceOptions {
  api: Pick<GenerationApi, "get">;
  basePath: string;
  session: Pick<SessionPort, "authorization">;
  clock: Clock;
  delay: DelayScheduler;
  visibility: VisibilitySource;
  eventSourceFactory: EventSourceFactory | null;
  random: () => number;
}

export function createBrowserGenerationSource(
  options: BrowserGenerationSourceOptions
): GenerationSnapshotSource;

export interface PendingSubmissionStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function createPendingSubmissionStore(
  storage: PendingSubmissionStorage
): PendingSubmissionStore;

export function createBrowserClock(): Clock;
export function createBrowserDelayScheduler(): DelayScheduler;
export function createBrowserIdFactory(): IdFactory;
export function createDocumentVisibilitySource(document: Document): VisibilitySource;
```

Task 9 constructs one `SessionPort`, `Clock`, delay scheduler, visibility source,
ID factory, `NexusApiClient`, pending store, and browser generation source. It
passes the same `SessionPort` to the API client and source and the same `Clock`
to the source and Task 5 workflow. Tests pass fakes explicitly; production code
passes `globalThis.EventSource` through a factory only when it exists.

The internal modules use these exact contracts; they are defined in
`generation/types.ts` but are not re-exported from the package barrel:

```ts
type SnapshotSourceEvent = Extract<GenerationSourceEvent, { kind: "snapshot" }>;
type EventSourceSessionExit = "terminal" | "stream_lost" | "aborted";

interface EventSourceSessionOptions {
  url: string;
  signal: AbortSignalLike;
  eventSourceFactory: EventSourceFactory;
}

function createEventSourceSession(
  options: EventSourceSessionOptions
): AsyncGenerator<SnapshotSourceEvent, EventSourceSessionExit, void>;

interface PollSessionOptions {
  api: Pick<GenerationApi, "get">;
  clock: Clock;
  delay: DelayScheduler;
  visibility: VisibilitySource;
  random: () => number;
}

function createPollSession(
  options: PollSessionOptions,
  jobId: string,
  signal: AbortSignalLike
): AsyncGenerator<GenerationSourceEvent, void, void>;
```

`fallback-source.ts` manually advances the EventSource generator so it can read
its final `EventSourceSessionExit`. It returns on `terminal`/`aborted`; on
`stream_lost` it emits the one degradation event and delegates to exactly one
poll session. Protocol errors are thrown by either session and are never turned
into an exit reason.

### S1 — the source must not end before a terminal snapshot

Task 5 enforces this at runtime. `workflow.ts:242` throws
`GenerationWorkflowProtocolError("source_ended_before_terminal")` when a source
iterable completes while the latest accepted snapshot is non-terminal. The
workflow re-enters `source.watch()` **only** on its own auto-retry restart
(`workflow.ts:193`), never because a source finished early.

The practical consequence is a design constraint on fallback, which the original
checklist did not state: **SSE-to-polling fallback must happen inside a single
`watch()` call.** If the SSE source ends its iterable so the workflow
re-subscribes, every fallback throws a protocol error and the run dies.
`fallback-source.ts` exists to compose `event-source.ts` and `poll-source.ts`
behind one iterable — that is its whole purpose.

- [x] `fallback-source.ts` owns one `AsyncIterable` per `watch()` call and
  switches its internal transport without completing. The public source starts
  polling directly, without a degradation event, when EventSource is unavailable
  by capability. After an EventSource was opened, its loss emits exactly one
  `{ kind: "degraded", reason: "stream_lost", consecutiveFailures: 1 }`
  before the source performs an immediate reconciliation poll.
- [x] A source iterable may complete normally **only** after yielding a snapshot
  whose status is terminal (`completed`, `failed`, `discarded`, `cancelled`, or
  `recoverable`), or after the supplied signal aborts. There is no third
  legitimate reason to finish.
- [x] Never end the iterable on transport failure. Emit `{ kind: "degraded" }`
  according to S7 and keep trying only for classified transient failures; ending
  is how a recoverable network blip becomes a thrown protocol error. Contract,
  authorization, and other non-retryable errors are thrown instead of being
  mislabeled as transport degradation.
- [x] Test it directly: a source that returns after a non-terminal snapshot must
  cause `source_ended_before_terminal`, and the fallback path must **not**
  trigger it. Assert both, so the constraint is pinned rather than assumed.
- [x] `recoverable` is terminal for a source session. The server closes its SSE
  loop on it (`services/api/src/server.ts:788`), and Task 5 opens a fresh
  session after a successful retry. Do not try to keep one stream alive across a
  retry cycle.

### S2 — bridge fetch cancellation; close EventSource directly

Task 5 forwards the consumer's `AbortSignalLike` straight into
`source.watch(jobId, signal)`. That type is the pure-core structural minimum and
is **not** an `AbortSignal`: passing it to `fetch` fails to compile with
`TS2739 — missing onabort, reason, throwIfAborted, dispatchEvent`. Native
EventSource does not accept any signal parameter at all. Use the bridge only for
`GenerationApi.get(jobId, signal)`; the EventSource adapter subscribes to the
original `AbortSignalLike` and calls `close()` itself.

Bridge it in `abort-bridge.ts`; this shape is verified to compile:

```ts
export function toAbortSignal(signal: AbortSignalLike): {
  signal: AbortSignal;
  dispose: () => void;
} {
  const controller = new AbortController();
  if (signal.aborted) controller.abort();
  const onAbort = () => controller.abort();
  signal.addEventListener("abort", onAbort, { once: true });
  return { signal: controller.signal, dispose: () => signal.removeEventListener("abort", onAbort) };
}
```

- [x] Check `signal.aborted` **before** subscribing. A signal aborted before
  `watch()` is called never fires `abort` again, and without this check the
  request proceeds against an already-cancelled operation.
- [x] Always `dispose()` in a `finally`. Task 5 restarts sources across retry
  cycles on the same consumer signal, so a bridge that forgets
  `removeEventListener` leaks a listener per session — directly contradicting
  this task's "no watcher leaks after navigation" definition of done.
- [x] In `event-source.ts`, install a separate listener that closes the native
  source and resolves any pending iterator read when the pure signal aborts.
  Remove that listener and null `onmessage`/`onerror` in the iterator's
  `finally`, including when client-core calls `iterator.return()`.
- [x] In `poll-source.ts`, check the original pure signal before classifying a
  rejected API call. If it is aborted, end normally so Task 5 emits `detached`;
  never increment failure counters or emit `poll_failed` for cancellation.
- [x] Do not widen `AbortSignalLike` in client-core to make this easier. The
  narrow port is what keeps client-core free of DOM types; the bridge belongs
  here.
- [x] Test already-aborted EventSource and polling starts, abort during a pending
  API request, abort during delay/visibility waits, `iterator.return()`, and the
  removal of every bridge/EventSource listener.

### S3 — name the consumers of the platform adapters

`GenerationWorkflowDependencies` is `{ api, source, clock, pendingSubmissions }`.
It consumes neither `DelayScheduler` nor `IdFactory`, so `platform/delay.ts` and
`platform/ids.ts` read as dead code unless their consumers are stated.

- [x] `platform/clock.ts` implements `Clock` and is injected into the Task 5
  workflow, where it stamps `createdAt` and enforces the 15-minute expiry.
- [x] `platform/delay.ts` implements `DelayScheduler` and is consumed **inside
  `poll-source.ts`** for its own cadence and backoff. It is not a workflow
  dependency.
- [x] `platform/ids.ts` implements `IdFactory` and is consumed by whoever
  constructs a `GenerationSubmissionInput` — Task 9's UI — to mint
  `request.idempotencyKey`. The workflow receives the key already embedded and
  never generates one.
- [x] `createBrowserIdFactory()` uses `globalThis.crypto.randomUUID()` and throws
  before submission construction if secure UUID generation is unavailable. Do
  not add a `Math.random()` identifier fallback.
- [x] Production adapters use `Date.now`, `setTimeout`, and `crypto.randomUUID`;
  consumers accept their `Clock`, `DelayScheduler`, and `IdFactory` interfaces so
  tests inject fakes and never touch real time or randomness. Poll jitter is a
  separate injected `random: () => number` dependency on
  `BrowserGenerationSourceOptions`; do not misuse `IdFactory` for jitter.
- [x] `DelayScheduler.wait()` settles promptly when its pure signal aborts and
  clears both the timeout and abort listener exactly once. Resolve on abort,
  then let the poll loop inspect `signal.aborted`; do not manufacture a DOM
  `AbortError` inside the generic scheduler.

### S4 — the store's element type changed

`PendingSubmissionStore` now loads and saves `StoredGenerationSubmission`, not
`PendingGenerationSubmission` (`packages/client-core/src/ports.ts`, changed in
`92aa9c4`). Implement against the current type.

### S5 — share the guarded API URL resolver and define SSE authentication

Task 4's `normalizeBasePath()` and `apiPath()` are private to
`http-client.ts`. Reimplementing their behavior in `event-source.ts` would create
a second path policy and could reintroduce the off-origin credential/path escapes
closed by Task 4a.

- [x] Move the two path functions and their private helpers to
  `packages/client-web/src/api-url.ts`. Keep them package-internal and have both
  `http-client.ts` and `event-source.ts` call the same implementation. This is a
  mechanical extraction: every existing Task 4/4a path test must remain green.
- [x] Construct exactly
  `/generation-jobs/${encodeURIComponent(jobId)}/stream` under the validated
  `basePath`. Reject absolute, protocol-relative, backslash/control-character,
  and dot-segment base paths before consulting `SessionPort` or constructing an
  EventSource. Never put credentials, tokens, or session identifiers in the URL
  or query string.
- [x] Native EventSource cannot attach the headers returned by
  `SessionPort.authorization()`. Before each source session, call
  `authorization()`: when it returns an empty record, SSE is allowed and uses
  the same-origin guarded URL; when it returns any header, skip EventSource and
  begin authenticated `GenerationApi.get()` polling. This preserves future
  header-based OIDC without leaking a bearer token or silently bypassing the
  session seam. Same-origin cookie authentication remains compatible because it
  requires no explicit header.
- [x] If `authorization()` rejects, surface that error. Do not classify it as a
  stream loss and do not start unauthenticated SSE. An EventSource that later
  receives an opaque HTTP/auth failure closes and falls back to the typed API,
  whose existing 401/403 refresh path owns reconciliation.
- [x] Add EventSource URL regressions matching Task 4a's unsafe base-path cases,
  an encoded job-ID assertion, an empty-authorization SSE case, and a non-empty
  authorization case proving zero EventSource constructions and one polling
  request.

### S6 — parsing and error classification must preserve the core contract

Both transport adapters validate data, and Task 5 validates again as the final
pure-core boundary. The first validation must not change which public error the
workflow exposes.

- [x] In the EventSource adapter, `JSON.parse(event.data)` and then parse with
  `generationStreamSnapshotSchema`. Map malformed JSON or a schema mismatch to
  `new GenerationWorkflowProtocolError("invalid_snapshot", { cause })` and
  reject the iterator. Do not fall back to polling after a protocol-invalid SSE
  frame; another transport cannot make an invalid server contract valid.
- [x] In the polling adapter, call `GenerationApi.get(jobId, bridgedSignal)` and
  parse the returned full `GenerationJobSnapshot` through
  `generationStreamSnapshotSchema` before yielding. This strips `createdAt`,
  `updatedAt`, and `completedAt`. Map `ApiContractError` and any projection
  failure to the same `GenerationWorkflowProtocolError("invalid_snapshot")`.
- [x] Treat only network `TypeError`, `NexusApiError` status 408, 425, 429, and
  500–599 as transient polling failures. Re-throw 400/401/403/404/409 and other
  non-retryable statuses immediately, after Task 4's one allowed authorization
  refresh. Unknown exceptions are programming errors and are re-thrown.
- [x] When a poll rejects, inspect the original `AbortSignalLike` first. An
  abort ends the adapter normally; it never becomes `poll_failed`. Re-throw an
  existing `GenerationWorkflowProtocolError` unchanged so it is not wrapped a
  second time.
- [x] Parse a valid terminal SSE frame before reacting to the server's normal
  EOF/error callback. Close and finish after yielding that terminal snapshot so
  the normal close cannot emit `stream_lost` or start polling. Make message,
  error, abort, and iterator-return settlement idempotent.

### S7 — define one deterministic fallback and backoff sequence

Use these exact observable rules so fake-clock tests and Task 7 stores do not
have to guess what `consecutiveFailures` means:

- [x] If EventSource capability is absent, start with an immediate poll and emit
  no `stream_lost`; missing capability is not a runtime failure. If SSE was
  constructed and then errors before a terminal frame, close it first, emit
  `{ kind: "degraded", reason: "stream_lost", consecutiveFailures: 1 }` once,
  and perform one immediate reconciliation poll. Never promote polling back to
  SSE during that `watch()` call.
- [x] A successful poll yields one projected snapshot, resets the poll-failure
  counter to zero, and schedules the next poll after exactly 1500 ms while the
  document is visible. Duplicate snapshots may be yielded; Task 5's high-water
  machine owns deduplication.
- [x] On transient poll failure `n`, do not yield anything for `n = 1`. For
  `n >= 2`, yield `{ kind: "degraded", reason: "poll_failed",
  consecutiveFailures: n }` for each failure until a success resets the counter.
  The immediate `stream_lost` event has its own fixed count and does not seed the
  poll-failure counter.
- [x] After transient poll failure `n`, calculate
  `base = min(5000, 1500 * 2 ** (n - 1))` and
  `delay = min(5000, base + floor(base * 0.2 * random()))`. Require every random
  result to be finite and in `[0, 1)`; otherwise throw `RangeError`. This gives
  deterministic 1500–1799 ms, 3000–3599 ms, then capped 5000 ms backoff.
- [x] For a valid `Retry-After` delta-seconds or HTTP-date on a retryable
  `NexusApiError`, use the greater of the calculated delay and Retry-After. An
  explicit server throttle may exceed the ordinary 5000 ms transport-backoff
  cap; clamp it to 60 seconds to keep the local scheduler bounded. Use the
  injected `Clock` for HTTP-date math and document this server-directed
  exception beside the 5000 ms performance budget. Ignore malformed or past
  values. Do not retry a mutating request; this policy applies only to
  `GenerationApi.get()`.
- [x] Poll sequentially. For one job there may be at most one in-flight
  `GenerationApi.get()` at a time, and at most one live transport — an
  EventSource or a poll loop, never both. Tests track maximum concurrent reads
  and prove the EventSource is closed before the first poll begins.

  This constrains **reads and transports**, not timers. S8 deliberately races a
  backoff delay against `waitUntilVisible(signal)`, so a delay and a visibility
  wait are pending together by design; that is not a violation. Do not serialize
  those two to satisfy this rule — doing so loses S8's immediate reconciliation
  poll when the document becomes visible again.

### S8 — detach and visibility own lifecycle; there is no local timeout

The earlier `900 attempts` loop timed out after roughly six minutes. That is
incompatible with S1: a browser source cannot end non-terminal without making
Task 5 throw `source_ended_before_terminal`, and it cannot abort the
consumer-owned signal to synthesize detach.

- [x] Do not implement a maximum poll count or elapsed-time cutoff. Monitoring
  continues until a terminal snapshot, a non-retryable/protocol error, or caller
  abort. Only caller abort produces Task 5's `detached` event, and it never calls
  a remote cancellation endpoint.
- [x] Generation monitoring is essential while hidden, so do not pause it
  indefinitely. While `VisibilitySource.isHidden()` is true, use 5000 ms as the
  minimum interval. Race that delay with `waitUntilVisible(signal)`; visibility
  restoration cancels the remaining hidden wait and triggers one immediate
  reconciliation poll. There must not be a second timer or overlapping fetch.
- [x] `createDocumentVisibilitySource(document)` reads `document.hidden`,
  subscribes only while waiting, resolves immediately when already visible or
  aborted, and removes `visibilitychange` and abort listeners in every exit
  path. It does not manipulate DOM or own presentation state.
- [x] Generator `finally` blocks close EventSource, abort/finish a bridged poll,
  clear timers, resolve pending iterator reads, and remove all abort/visibility
  listeners. Test natural terminal completion, protocol failure, consumer
  `return()`, abort during every stage, and Task 5's retry-created second source
  session on the same pure signal.

### S9 — version, validate, and migrate pending-submission storage

The current legacy Story Player writes a flat record under
`infiniteQuestPendingGeneration:${campaignId}`. The new
`StoredGenerationSubmission` nests the exact server request under `request`.
Accepting only a nested record with optional `jobId` would lose a saved request
created immediately before cutover.

- [x] Store the new format under
  `infiniteQuestPendingGeneration:v2:${encodeURIComponent(campaignId)}` as
  `{ version: 2, submission }`. Never include a user-supplied owner ID; the
  campaign UUID scopes this pre-auth projection and server authorization remains
  authoritative.
- [x] Build an internal strict Zod schema discriminated by `operationKind`.
  Both branches require `expectedTurnNumber` as an integer >= 1,
  `createdAt` as a finite non-negative number, and optional UUID `jobId`.
  `append` parses `request` with `generationRequestSchema`;
  `replace_latest` parses with `generationRetryLatestRequestSchema` and refines
  `request.expectedCurrentTurnNumber === expectedTurnNumber`. Preserve the
  exact parsed request and idempotency key; never mint a replacement key while
  loading or migrating.
- [x] `load(campaignId)` checks the v2 envelope first, then accepts an
  unversioned nested `StoredGenerationSubmission` made before `jobId` existed,
  and finally checks the actual flat legacy key. Convert legacy fields
  `action`, input modes, optional classification/provider/model fields,
  `idempotencyKey`, `context`, `operationKind`, `expectedTurnNumber`, and
  `createdAt` into the nested request; add `expectedCurrentTurnNumber` only for
  `replace_latest`. Validate the converted record, write v2, then best-effort
  remove the legacy key.
- [x] Invalid JSON, a wrong version, schema failure, or inconsistent replacement
  turn numbers returns `null` and best-effort removes the bad key so every load
  does not repeat the same failure. Storage parsing never implements expiry;
  Task 5 remains the only 15-minute policy owner.
- [x] Web Storage access can throw. `save()` propagates `setItem` failure, which
  makes Task 5 stop before enqueue; if the second save containing `jobId` fails,
  the first exact envelope remains replayable. `load()` treats inaccessible
  storage as absent so `resume()` can still call server `syncStatus()`. `clear()`
  and corrupt-record cleanup are best-effort and never throw, preventing a
  successful result/cancel/discard from being relabeled as a workflow failure.
- [x] Tests cover v2 with/without `jobId`, unversioned nested input, both legacy
  operation kinds, migration preserving the exact idempotency key, corrupt and
  inconsistent records, quota/security exceptions for each operation, campaign
  key isolation, and the exact 15-minute boundary through Task 5's injected
  clock rather than the storage adapter.

### S10 — lock down the deliberate package surface

- [x] Export `createBrowserGenerationSource`,
  `BrowserGenerationSourceOptions`, `EventSourceFactory`, `EventSourceLike`,
  `VisibilitySource`, `createPendingSubmissionStore`,
  `PendingSubmissionStorage`, and the four platform factories from
  `packages/client-web/src/index.ts`. Do not export raw source factories,
  `toAbortSignal`, URL helpers, storage schemas, or classifiers.
- [x] Extend the `client-web-public` compiler fixture to construct or type-check
  every new public factory using only `@infinite-quest/client-web` and
  `@infinite-quest/client-core`. Add `expectTypeOf` coverage proving the composed
  result is `GenerationSnapshotSource` and `GenerationApi` remains assignable to
  Task 5's `GenerationApiPort`.
- [x] Keep client-web framework-free and free of rendered-DOM writes. Web APIs
  (`EventSource`, `Storage`, `Document`, `AbortController`, timers, and crypto)
  remain allowed only in this package. No new runtime dependency or lockfile
  change is needed; use the existing `zod` and client-core dependencies.

### S11 — TDD, integration, and completion sequence

Keep Task 6 as one reviewable package, but build it in the following red/green
order. Each test names observable behavior rather than private implementation.

- [x] **API URL extraction first.** Extend `http-client.test.ts` with an import-
  invisible regression proving the HTTP client still rejects every Task 4a
  unsafe base/request path after its resolver is extracted. Add the corresponding
  EventSource URL tests in `generation-event-source.test.ts`; run both and expect
  the EventSource test to fail because the module does not exist. Implement
  `api-url.ts` and switch `http-client.ts` to it, then rerun:

  ```bash
  pnpm exec vitest run tests/unit/client-web/http-client.test.ts \
    tests/unit/client-web/generation-event-source.test.ts
  ```

- [x] **EventSource adapter second.** Before implementation, add cases for a
  valid progressive frame, every terminal status, malformed JSON, schema drift,
  clean non-terminal closure, abort before construction, abort after
  construction, `iterator.return()`, terminal-message/onerror ordering, encoded
  job ID, and exact listener/`close()` counts. Expect the missing factory red;
  implement the smallest internal adapter and rerun to green.

- [x] **Polling adapter third.** Add fake-clock/API tests for immediate first
  read, timestamp stripping, sequential reads, 1500 ms success cadence, exact
  jitter/backoff values at random `0` and just below `1`, 5000 ms cap,
  Retry-After parsing, reset after success, `poll_failed` beginning at failure
  two, abort during fetch and delay, visible/hidden cadence, immediate wake on
  visibility restore, and every retryable/non-retryable error class. Expect red,
  implement `abort-bridge.ts`, `poll-source.ts`, delay/visibility adapters and
  classifiers, then rerun:

  ```bash
  pnpm exec vitest run tests/unit/client-web/generation-poll-source.test.ts \
    tests/unit/client-web/platform-adapters.test.ts
  ```

- [x] **Fallback composition fourth.** Test EventSource unavailable, empty vs
  non-empty session authorization, one `stream_lost` event, clean-close fallback
  inherited from Task 2a P2, EventSource closed before the immediate poll, no
  SSE promotion, no overlapping transports, terminal completion, non-terminal
  source continuity, and a Task 5 workflow consuming the composed source without
  `source_ended_before_terminal`. Expect red, implement
  `fallback-source.ts`/the public factory, and rerun:

  ```bash
  pnpm exec vitest run tests/unit/client-web/generation-fallback-source.test.ts \
    tests/unit/client-core/generation-workflow.test.ts
  ```

- [x] **Persistence fifth.** Write all v2, unversioned, flat-legacy, cross-field,
  exception, isolation, and expiry-boundary cases from S9. Expect red, implement
  the store, and rerun:

  ```bash
  pnpm exec vitest run tests/unit/client-web/pending-submissions.test.ts \
    tests/unit/client-core/generation-submission.test.ts
  ```

- [x] **Public surface last.** Update the compiler fixture and boundary tests
  before exporting. The fixture must fail while the names are absent, then pass
  after `index.ts` exports exactly S10's surface. Add standalone clock/delay/ID/
  visibility cases, including unavailable secure UUID generation. Run:

  ```bash
  pnpm exec vitest run tests/unit/client-boundaries.test.ts \
    tests/unit/client-web/platform-adapters.test.ts
  pnpm --filter @infinite-quest/client-web check
  pnpm check:client-boundaries
  ```

- [x] Run the focused package gate:

  ```bash
  pnpm exec vitest run tests/unit/client-web/ tests/unit/client-core/ \
    tests/unit/client-boundaries.test.ts
  pnpm --filter @infinite-quest/client-core check
  pnpm --filter @infinite-quest/client-web check
  ```

- [x] Run completion checks: `pnpm check`, `pnpm build`, `pnpm test:unit`,
  `pnpm test:integration`, and `pnpm install --frozen-lockfile`; then run
  `git diff --check`, review the complete diff for unrelated files, and run
  `pjm precheck` for every changed path. No server behavior changes are expected,
  but the full integration suite protects the SSE endpoint contract consumed by
  this task.
- [x] Record a **Current Task 6 verification** block under **Completion status**
  and change Task 6's row to complete in the same implementation commit. Also
  remove Task 2a's “one item deferred to Task 6” qualifier and cite the clean-
  stream-closure fallback regression as its closing evidence; do not change any
  other task status.
- [x] Commit only Task 6 source, tests, and plan status with an imperative scoped
  summary such as `feat(client): add browser generation transports`. Do not mix
  Task 7 stores or Task 9 Story Player rewiring into this commit. Submit the
  result for the plan-required scoped review before starting the next task in
  the corrected sequence (Task 8).

**Definition of done:** The exported composed source produces the same typed
snapshot/degradation sequence regardless of SSE availability, never exposes an
off-origin or credential-bearing EventSource URL, never overlaps transports,
and remains alive until terminal state or caller detach. Polling is deterministic
under injected time/random/visibility, malformed data retains Task 5's typed
protocol error, legacy and v2 submissions resume with the exact idempotency key,
storage cleanup cannot relabel a completed job, and every Web listener, timer,
request bridge, iterator, and EventSource is released on all exit paths.

---

## Task 13a-R — B4a corrective gate: scope pages and recover replacements

**Runs after Task 13a and before Task 7.** Task 13a correctly made history
pages bounded, versioned, and snapshot-consistent, but its public projections
omit two identities that C6 must validate rather than infer. This is a narrow
contract correction, not B4b profiling work and not an implementation of the
campaign store.

**Issue being corrected:**

- A `TurnListResponse` has no `campaignId`. A store that receives a previously
  validated page cannot prove that it belongs to its loaded campaign before
  prepending it; page turn IDs and turn numbers alone are not campaign scope.
- `generationRecovery` has `operationKind` but omits `replacementTurnId`. A
  completed `replace_latest` recovery reloaded outside the current 50-turn
  window therefore cannot verify the intended old turn before atomically
  replacing it. `GenerationResult` does not supply that target either.

**Files:**

- Modify: `packages/contracts/src/client-api.ts`
- Modify: `services/api/src/server.ts`
- Modify: `tests/unit/client-api-contracts.test.ts`
- Modify: `tests/unit/client-api-routes.test.ts`
- Modify: `tests/unit/client-web/api-client.test.ts`
- Modify: `tests/integration/gameplay.integration.test.ts`
- Add: `database/migrations/0051_preserve_replacement_turn_provenance.sql`
- Modify: `docs/ui/SLICE_0_1_IMPLEMENTATION_PLAN.md` (Task 13a-R completion
  evidence and Task 7 prerequisite status only)

**Corrected contract:**

- `TurnListResponse` gains `campaignId: UUID`. The direct
  `GET /campaigns/:campaignId/turns` response and the nested `turns` value of a
  `sync-status` response must both return the route/canonical campaign ID. The
  server, not a cursor or the browser, supplies that value. A client may use it
  only to reject a mismatched page; it is never authorization.
- `generationRecovery` gains `replacementTurnId`, expressed as an
  `operationKind` discriminated union: `append` requires
  `replacementTurnId: null`; `replace_latest` requires a UUID. The recovery
  projection therefore carries the exact target needed by C6's completed-result
  reducer. Do not make this a loose nullable field that lets an invalid
  replacement recovery cross the API boundary.
- Migration 0051 removes the delete-time foreign key on
  `generation_jobs.replacement_turn_id`: replacement target IDs are durable
  provenance, while creation-time ownership and scope validation remains in the
  generation workflow. This is forward-only; existing completed replacements
  whose targets were already nulled cannot be reconstructed.
- Extend the existing sync query with
  `recovery.replacement_turn_id AS "recoveryReplacementTurnId"`, map that value
  into the sanitized recovery projection, and include it in the sync-token
  fingerprint. No raw provider/model payload, mechanics, stack, or rejected
  output may enter either new field.
- The existing `turnPageRequestSchema`, `syncStatusRequestSchema`, bounded page
  limits, opaque cursor validation, and read-only repeatable-read page snapshot
  remain unchanged. Do not widen page size, bypass runtime response parsing, or
  introduce a second read repository.

**TDD and verification sequence:**

- [x] Add contract red tests showing that a page without `campaignId`, an
  append recovery with a non-null target, and a replacement recovery with a
  null/malformed target are rejected. Add matching success cases for direct and
  sync-nested pages plus both recovery operation kinds. Implement the shared
  discriminated schemas only after the failures are observed.
- [x] Add route/client red tests proving that the direct page and replacement
  sync response include the canonical campaign ID and replacement target, and
  that the typed browser client still rejects malformed projections at runtime.
  Implement only the server-query, response-map, and fixture changes needed to
  make them pass.
- [x] Add a real-PostgreSQL regression that creates a `replace_latest` job whose
  accepted result is outside the latest bounded window, obtains `sync-status`,
  and asserts the recovery carries the exact replacement turn ID. Also assert an
  older-page response carries the queried campaign ID and cannot be confused
  with a second campaign's page. Preserve Task 13a's existing cursor snapshot
  race coverage.
- [x] Run focused contract/route/client tests and the gameplay integration test,
  then `pnpm check`, `pnpm build`, `pnpm test:unit`, `pnpm test:integration`,
  `git diff --check`, complete-diff review, and `pjm precheck`. Record the
  commands/results in the Task 13a-R completion note and submit this correction
  to its own scoped review before starting C6.

**Completion evidence (2026-08-02):** Contract tests were first observed red
(four failures), then passed after the discriminated schema and server response
projection changes. The PostgreSQL regression initially exposed that the old
delete-time foreign key erased `replacement_turn_id`; migration 0051 preserves
new durable replacement provenance after the target turn is removed. Focused
contract/route/client tests, focused gameplay integration, `pnpm check`,
`pnpm build`, `pnpm test:unit` (83 files, 949 tests), `pnpm test:integration`,
`git diff --check`, and `pjm precheck` all passed. The detailed command output
and self-review are recorded in
`.superpowers/sdd/SLICE_0_1_IMPLEMENTATION_PLAN/task-13a-r-report.md`.
Scoped source/test commits: `5f156ac` (`fix(api): scope turn pages and recovery`)
and `1ae0dd1` (`test(client): reject malformed sync recovery`).

**Definition of done:** Every bounded page is self-identifying and every
completed replacement recovery carries a validated replacement target. C6 can
reject cross-campaign pages and reconcile a recovered replacement without
guessing from a window index, response order, or browser storage.

---

## Task 7P — C6 prerequisite: live replacement provenance and hydration contract

**Runs after Task 13a-R and before Task 7a.** Task 13a-R made replacement
recovery authoritative after reload, but the live stream and pending-generation
summary still cannot identify the replaced turn. Freezing the C6 projection
before fixing those ingress contracts would force the reducer either to guess
from the bounded turn window or to maintain two incompatible replacement paths.

This prerequisite changes only contracts, API projections, workflow comparison,
tests, and their governing ADR. It does not create a store or UI behavior.

### 7P.1 — Make operation provenance discriminated and allowlisted

- [x] Change `generationStreamSnapshotSchema` into an operation-discriminated
  projection: `append` requires `replacementTurnId: null`, while
  `replace_latest` requires a UUID `replacementTurnId`. Keep the projection an
  explicit allowlist; do not expose `recoveryMetadata`, database rows, raw model
  data, or any other internal job field.
- [x] Change `pendingGenerationSchema` to the same operation/target invariant.
  Its status union is active-only: `queued`, `replacement_queued`, `assessing`,
  `generating`, `validating`, or `committing`. Terminal jobs belong exclusively
  to the discriminated `generationRecovery` contract.
- [x] Update the pending-generation database selection and API mapping to carry
  `replacement_turn_id`; never reconstruct it from `expectedTurnNumber`, the
  current latest turn, or client storage.
- [x] Include `operationKind` and `replacementTurnId` in generation snapshot
  equality. A target change is observable even when durable status and
  narration are unchanged.
- [x] Ensure every live `GenerationWorkflow` `status` event retains the exact
  replacement target through enqueue, retry, SSE, polling, and fallback. The
  event must not be cleared or narrowed before the completed result is reduced.
- [x] Add the same immutable operation/target pair to `GenerationRun`. The
  controller needs it immediately at `attachGeneration(run)`, before the first
  status frame arrives; do not make C6 infer it from a later event.

### 7P.2 — Files and tests

**Modify:**

- `packages/contracts/src/generation.ts`
- `packages/contracts/src/client-api.ts`
- `services/api/src/server.ts`
- `packages/client-core/src/generation/machine.ts`
- `packages/client-core/src/generation/types.ts` and
  `packages/client-core/src/generation/workflow.ts` if required to preserve the
  discriminant without widening the public event
- `scripts/benchmark-client-contracts.ts`
- `docs/architecture/0028-modular-client-and-application-boundaries.md`
- the affected contract, route, API-client, generation-machine, workflow,
  SSE/poll/fallback-source, and gameplay integration tests

- [x] Start with red contract tests proving valid append/null and
  replace/UUID pairs parse; malformed pairs and terminal pending statuses fail.
- [x] Prove the pending route, polling snapshot, SSE snapshot, and fallback path
  preserve the same target and do not leak non-allowlisted fields.
- [x] Prove a real replacement `GenerationWorkflow` emits a status with the old
  turn ID and carries that identity until its completed event.
- [x] Re-run `scripts/benchmark-client-contracts.ts`, update ADR 0028's exact
  stream allowlist and measured payload/frame evidence, and fail the benchmark
  if the contract drifts again.
- [x] Run focused tests, then `pnpm check`, `pnpm build`, `pnpm test:unit`,
  `pnpm test:integration`, `git diff --check`, complete-diff review, and
  `pjm precheck`. Record a `Current Task 7P verification` block and obtain a
  scoped review before Task 7a.

**Definition of done:** Pending sync, SSE, polling, fallback, and the live
workflow all carry one validated operation/target pair. C6 can reduce live and
hydrated replacements by identity without reading an internal job row or
guessing from a 50-turn window.

---

## Task 7 — C6: Focused stores and selectors

**Pre-implementation correction status: Applied (2026-08-02).** Reviewed
against the shipped Tasks 5/5a/6, the legacy `story.js` state object, the current
typed API surface, and Task 9's actual requirements. The review found that the
original generic source event could not carry Task 5's workflow outcomes, that
pure client-core had no writable cancellation primitive with which to own a
watcher's lifetime, and that image, Chronicle, and world-cover jobs have no
shared client contracts or browser sources. The corrected task therefore owns
only an immutable campaign projection and generation-event reducer. It does not
own transport iteration, cancellation, or speculative multi-family adapters.

**Prerequisite status:** Task 13a-R is review-clean; Task 7P remains open. C6
needs self-identifying turn pages to reject cross-campaign loads and prepends,
the discriminated recovery target to validate reload recovery, and Task 7P's
matching live/pending target to validate an in-flight `replace_latest`. None may
be guessed from a bounded window, cursor, response order, or browser state.

**Sequenced after Task 9 (C8), Task 13a (B4a), and Task 13a-R, despite its
number.** Nothing in Track C consumes this task: Task 9 never references these
stores — its only "store" mention is Task 6's pending-submission store — and
none of the ten Track C exit criteria mentions stores, selectors, or job
watching. The real consumers are U2, U4, and U5. The dependency graph previously
drew `C6 -> C8`; that edge was unverified and is corrected. Run this strictly
after C8, B4a, Task 13a-R, and Task 7P so its projection types are based on the
final bounded history/sync and replacement-provenance contracts; it is not a
C8 blocker.

Do not lift the current `story.js` state object as-is. It mixes authoritative
projections with presentation details such as toast timers, scroll-follow state,
modal selections, and DOM cancellation controls.

### Scope boundary

This task owns a **pure, generation-family** campaign projection: an internal
store primitive, a campaign controller that reduces already-validated Task 5
`GenerationEvent` values, and selectors over that projection. The caller owns
`GenerationRun.watch(signal)` iteration and the `AbortController`; the campaign
controller never opens a source, creates a timer, aborts a signal, or calls a
remote cancellation endpoint. It must compile and be fully tested under
`packages/client-core/tsconfig.json` with `lib: ["ES2023"]` and `types: []`,
with no DOM, Node, network, storage, clock, timer, random-ID, or framework type
reachable from any of its modules.

### Delivery stages and checkpoints

C6 is a multi-stage package across five specification sections, and unlike
Tasks 4-6 it has no application consumer in-tree yet. Its consumers are U2,
U4, and U5. It is therefore delivered as **three implementation checkpoints
plus one exit audit**, each landing as its own commit and scoped review.

S1-S5 below remain **one specification** and are not split. The controller
interface, the `CampaignProjectionProtocolError` kind union, and the hydration
rule genuinely span both the campaign and generation lanes; declaring them
across two documents would make the contract worse, not clearer. What splits is
the **work**, along the lanes the TDD sequence already stages.

| Stage | Implements | Approx. items | Unblocks |
|---|---|---|---|
| **7a — store primitive** | S1 | 5 | nothing directly; reviewed foundation |
| **7b — campaign/runtime projection** | S2, S3's campaign items (`load`, `loadRuntimeState`, `turnWindowMode`, turn normalization, `prependOlderTurns`, `setTurnInput`), and campaign selectors from S5 | review by behavior, not item count | **U4 resume foundation** |
| **7c — generation projection** | S3's generation items (`attachGeneration`, session identity, snapshot validation, watch-loop ownership, `retryResult`), all of S4, generation selectors, and the real workflow/store composition test | review by behavior, not item count | **U2**, **U4**, **U5** |
| **7d — Track C exit audit** | governing-document reconciliation, all ten exit criteria, final evidence and review | audit | authorizes the backend sequence; no UI work |

- [x] **7b declares the complete `CampaignProjection` type, including
  `generation: GenerationJobProjection | null`, and leaves that field
  permanently null.** 7c adds only behavior and never widens the shape. Do not
  ship 7b with the field omitted and add it in 7c: a projection type that
  changes between checkpoints is exactly the failure that forced Task 13a-R and
  the C6 resequencing.
- [x] **Do not split 7c further.** S4's reducers write the state S3's attach
  establishes; a checkpoint between them would leave a projection that is
  attached but that nothing ever updates. Treat it as one behavior unit.
- [x] Keep 7a separate from 7b. The public read-only type and internal writable
  primitive are foundational enough to require their own compile-time fixture,
  verification block, commit, and scoped review before projection work starts.
- [x] Each of 7a, 7b, 7c, and 7d is a checkpoint and must end green and
  coherent: its own items
  ticked, `pnpm check`, `pnpm build`, `pnpm test:unit`, and
  `pnpm test:integration` passing, a deliberate `index.ts` export surface with
  no partially-exported module, the `core-contracts` boundary fixture updated
  for the surface it adds, and a `Current Task 7a/7b/7c/7d verification` block
  recorded in the same commit per the Task 4a P4 rule.
- [x] Do not start any UI task after these checkpoints alone. The backend-first
  gate also requires Tasks 10, 11, 12, 13b, 14a-14e, and the backend completion
  audit. Within dependency analysis, 7b supplies U4's resume foundation; 7c
  supplies U2/U4/U5 generation behavior.

**Files by stage:**

*7a — store primitive*

- Create: `packages/client-core/src/store.ts`
- Create: `tests/unit/client-core/store.test.ts`
- Modify: `packages/client-core/src/index.ts`
- Modify: `tests/fixtures/client-boundaries/core-contracts/src/fixture.ts`
- Modify: `tests/unit/client-boundaries.test.ts`

*7b — campaign/runtime projection*

- Create: `packages/client-core/src/campaign-projection.ts` (public projection
  and sanitized hydration types; no controller implementation)
- Create: `packages/client-core/src/campaign-store.ts`
- Create: `packages/client-core/src/selectors.ts` (campaign selectors only)
- Create: `tests/unit/client-core/campaign-store.test.ts`
- Create: `tests/unit/client-core/selectors.test.ts`
- Modify: `packages/client-core/src/index.ts`
- Modify: `tests/fixtures/client-boundaries/core-contracts/src/fixture.ts`
- Modify: `tests/unit/client-boundaries.test.ts`

*7c — generation projection*

- Create: `packages/client-core/src/generation/projection.ts`
- Create: `tests/unit/client-core/generation-projection.test.ts`
- Create: `tests/unit/client-core/campaign-generation-composition.test.ts`
- Modify: `packages/client-core/src/campaign-store.ts` (attach/session wiring)
- Modify: `packages/client-core/src/selectors.ts` (generation selectors)
- Modify: `packages/client-core/src/index.ts`
- Modify: `tests/unit/client-core/selectors.test.ts`
- Modify: `tests/fixtures/client-boundaries/core-contracts/src/fixture.ts`
- Modify: `tests/unit/client-boundaries.test.ts`

*7d — Track C exit audit*

- Modify: `docs/ui/CLIENT_CORE_BOUNDARY.md`
- Modify: `docs/ui/API_UI_CONTRACTS.md`
- Modify: `docs/ui/INTERACTION_FLOWS.md`
- Modify: `docs/ui/FEATURE_IMPLEMENTATION_MATRIX.md`
- Modify: `docs/ui/SLICE_0_1_IMPLEMENTATION_PLAN.md`
- Review ADR 0028 and the architecture index for links or claims changed by 7P

`jobs.ts` and `tests/unit/client-core/jobs.test.ts` are deliberately removed
from this task — see **Deferred** below. Do not place their abandoned generic
source types in `store.ts`; Task 5 already owns the only implemented source
contract.

`packages/client-core/src/index.ts` was missing from the original list — the
third recurrence of an omission already corrected in Tasks 5 and 6. Slice 1
consumers import these stores through the deliberate barrel, so export the
read-only `Immutable`/`Store` types, campaign projection/controller types, the
campaign-store factory, and selectors. `WritableStore` and
`createWritableStore` are exported from `store.ts` so sibling modules can use
them, but are not re-exported from the package barrel; keep the live run
registry and event reducers module-private. Because Task 8 lands first, import all
shared contract types through `@infinite-quest/contracts`; do not reintroduce the
relative `../../../contracts/src` path that Task 8 removes.

### S1 — define the store primitive precisely

```ts
type DateMutator =
  | "setDate"
  | "setFullYear"
  | "setHours"
  | "setMilliseconds"
  | "setMinutes"
  | "setMonth"
  | "setSeconds"
  | "setTime"
  | "setUTCDate"
  | "setUTCFullYear"
  | "setUTCHours"
  | "setUTCMilliseconds"
  | "setUTCMinutes"
  | "setUTCMonth"
  | "setUTCSeconds"
  | "setYear";

export type Immutable<T> =
  T extends Date
    ? Omit<Date, DateMutator>
    : T extends (...args: never[]) => unknown
      ? T
      : T extends readonly (infer Item)[]
        ? readonly Immutable<Item>[]
        : T extends object
          ? { readonly [Key in keyof T]: Immutable<T[Key]> }
          : T;

export interface Store<T> {
  get(): Immutable<T>;
  subscribe(listener: (state: Immutable<T>) => void): () => void;
}

export interface WritableStore<T> extends Store<T> {
  set(next: T): void;
  update(reduce: (current: Immutable<T>) => T): void;
}

export function createWritableStore<T>(initial: T): WritableStore<T>;
```

- [x] `WritableStore` and `createWritableStore` are module exports for sibling
  implementation modules, but package-internal at the public boundary. Public
  consumers receive only `Store<T>` and domain-named controller methods; do not
  barrel-export a generic `set` or `update` escape hatch.
- [x] `set` compares with `Object.is`. Committing the identical reference is a
  no-op; committing a different reference replaces state before notifying each
  listener once.
- [x] Notify a snapshot of listeners synchronously in subscription order.
  Subscription or unsubscription during a callback affects the next update,
  not the current listener snapshot. The returned unsubscribe function is
  idempotent. `subscribe` does not invoke the listener immediately; framework
  adapters read the current value through `get()` and receive notifications only
  after a distinct reference is committed.
- [x] A listener exception does not roll back the already-committed state. It is
  a caller error and may propagate, ending that notification pass before later
  listeners run; do not catch it and synthesize domain state.
- [x] `Readonly<T>` is shallow and is insufficient here. Use the recursive
  compile-time `Immutable<T>` view for reads. Its `Date` branch must omit every
  mutator while retaining read/format methods; a mapped `Date` is not immutable.
  Clone dates, arrays, and records at every
  campaign-controller ingress, and use copy-on-write reducers. Tests must prove
  mutation of caller-owned campaign, turn, snapshot, and result inputs after a
  command cannot mutate stored state. `Immutable<T>` is a type guarantee, not a
  runtime freeze; do not claim generic `createWritableStore` clones or
  deep-freezes arbitrary values.

### S2 — scope the campaign projection to contracted data

Do not move the legacy fields from `apps/web/src/story.js` into a global
store. Task 7 has contracts today for campaign sync, accepted turns, generation
snapshots/results, turn-input choices, and editable campaign runtime state.
Provider inventory, user profile, and illustration configuration also have
typed contracts, but they are separate feature/shell domains; placing them in a
campaign store would create the wrong ownership boundary rather than improve
type safety.

Define the public projection from existing contract types:

```ts
export type GenerationTransportHealth =
  | { readonly state: "unobserved" }
  | { readonly state: "healthy" }
  | {
      readonly state: "degraded";
      readonly reason: "stream_lost" | "poll_failed";
      readonly consecutiveFailures: number;
    };

export type GenerationResultState =
  | { readonly state: "pending" }
  | { readonly state: "unavailable"; readonly message: string; readonly correlationId: string | null }
  | { readonly state: "failed"; readonly outcome: "failed" | "unrecoverable"; readonly message: string };

export type GenerationOperationProjection =
  | { readonly operationKind: "append"; readonly replacementTurnId: null }
  | { readonly operationKind: "replace_latest"; readonly replacementTurnId: string };

export interface HydratedGenerationProjection {
  readonly source: "pending" | "recovery";
  readonly id: string;
  readonly status: string;
  readonly action: string | null;
  readonly expectedTurnNumber: number;
  readonly attempts: number | null;
  readonly resultTurnId: string | null;
  readonly operation: GenerationOperationProjection;
}

export interface GenerationJobProjection {
  readonly campaignId: string;
  readonly jobId: string;
  readonly origin: "live" | "hydrated_pending" | "hydrated_recovery";
  readonly operation: GenerationOperationProjection;
  readonly monitoring: "attached" | "detached";
  readonly hydratedGeneration: Immutable<HydratedGenerationProjection> | null;
  readonly snapshot: Immutable<GenerationStreamSnapshot> | null;
  readonly narration: string;
  readonly transport: GenerationTransportHealth;
  readonly result: GenerationResultState;
}

export interface CampaignProjection {
  readonly campaign: Immutable<CampaignSyncStatus["campaign"]> | null;
  readonly world: Immutable<CampaignSyncStatus["world"]> | null;
  readonly playerConfig: Immutable<CampaignSyncStatus["playerConfig"]> | null;
  readonly turns: readonly Immutable<TurnSummary>[];
  readonly nextTurnsCursor: string | null;
  readonly syncToken: string | null;
  readonly historySyncRequired: boolean;
  readonly runtimeState: Immutable<CampaignRuntimeStateResponse> | null;
  readonly latestStateSnapshot: Immutable<Record<string, unknown>> | null;
  readonly requestedTurnInputMode: TurnInputSelection;
  readonly nextTurnInputModeSource: TurnInputModeSource | null;
  readonly generation: GenerationJobProjection | null;
}
```

- [x] The initial projection has null server projections, an empty readonly turn
  window, null `nextTurnsCursor`/`syncToken`, `historySyncRequired: false`, null
  runtime state and state snapshot, requested
  input selection `"action"` (the shared generation-request default), null
  next-mode source, and no generation. Use
  `TurnInputSelection`, not `TurnInputMode`: the former preserves the UI's
  `"auto" | "action" | "scene"` request while the latter is only the resolved
  `"action" | "scene"` result. Campaign control-style policy remains in the app
  until C8 adopts its typed campaign-config contract.
- [x] Browser identity values are never inputs to this store. When Slice 1 adds
  a user/profile store, its UUID and system key remain display projections and
  must never become authorization headers or request ownership fields.
- [x] Store only sanitized `partialNarration` from `GenerationEvent`; never add
  `partialOutput`, raw model output, parser diagnostics, mechanics scratchpads,
  or an `Error.cause`/stack to the projection.
- [x] Keep scrolling, focus, modal state, toast/activity timers, view/history
  selection, DOM nodes, edit sessions, and `AbortController` instances in
  `apps/`.

The legacy-field disposition is therefore:

| Field | Home | Why |
|---|---|---|
| `campaignId`, `campaign`, `world`, `playerConfig` | **store now** | fields validated by the current campaign-sync contract |
| `runtimeState` | **store now** | C8 adopted validated GET/PATCH campaign-state responses; load the GET response through a dedicated controller command and keep it distinct from generation `latestStateSnapshot` |
| `turns` | **store** | accepted-turn ledger |
| `historyNextCursor` | **store** | represented by `nextTurnsCursor`; local accepted-result projection also raises `historySyncRequired` so the next sync deliberately replaces the bounded window |
| `turnInputMode`, `nextTurnInputModeSource` | **store** | these become the `requestedInputMode` and `inputModeSource` fields of a generation request; they are contract inputs, not display state |
| `pendingGeneration`, `generationJobId` | **store projection** | represented by `GenerationJobProjection`; the live `GenerationRun` remains private controller state |
| `generationRun` | **private controller state** | command/watch handle; never serialized or exposed through selectors |
| `generationRecoveryKind` | **derived store projection** | represented by `origin`, sanitized hydration source/status, and result state; do not preserve the legacy display flag as a second authority |
| `providers`, `illustrationConfig`, `illustrationSegments`, `user` | **later typed feature/shell stores** | typed contracts exist, but their lifetimes and ownership are not campaign-ledger state |
| `viewIndex`, `historySelectedIndex`, `historyInspectionRequestId` | `apps/` | which turn is on screen |
| `busy`, `generationDisplayActive`, `generationDisplayAction` | `apps/` | in-flight rendering flags |
| `streamingAutoFollow`, `streamingExpectedScrollY` | `apps/` | scroll behavior |
| `toastTimer`, `imagePollTimer` | `apps/` | timers |
| `editStateSession` | `apps/` | modal editing session |
| `illustrationVariantIndexes`, `illustrationSegmentActivity`, `imageJobActivity`, `imageActivityInitialized` | `apps/` | per-view display bookkeeping |
| `activityLog` | `apps/` | rendered directly into the DOM; not a server projection |
| `pendingIntentDecision` | `apps/` | an `{ action, classification }` pair held awaiting a user modal decision |
| `cancellationConfirmed` | `apps/` | transient confirmation flag |
| `abortController` | **neither** | Task 5 requires the UI to own the `AbortController`; it must not enter client-core in any form |

- [x] Load `runtimeState` only from the validated
  `CampaignRuntimeStateResponse`; recursively copy it and reject a campaign-ID
  mismatch before mutation. Keep it separate from `latestStateSnapshot`, which
  is the narrower generation-result projection. A completed generation clears
  `runtimeState` to null because the result does not carry the full editable
  response/revision contract; the application must refetch runtime state before
  opening its editor. Never type-cast the legacy object into this model.
- [x] `hydratedGeneration` is an allowlisted public summary, not a defensive
  copy of the complete pending/recovery response. Never expose recovery
  `errorCode`, `errorMessage`, or an unreviewed future field through the store.
- [x] If implementation needs a field not listed above, update this table and
  name the shared schema that validates it in the same commit. Do not silently
  widen the projection.

### S3 — separate projection state from the live `GenerationRun`

`GenerationRun` is a live command handle with `watch`, `retryGeneration`,
`cancelGeneration`, `discardGeneration`, and `fetchResult`. It is not durable,
serializable state. `campaign-store.ts` keeps at most one live run in a private
slot while exposing only its IDs and reduced state as `GenerationJobProjection`.

```ts
export interface GenerationProjectionSession {
  readonly campaignId: string;
  readonly jobId: string;
  apply(event: GenerationEvent): void;
  retryResult(): Promise<void>;
}

export interface CampaignStoreController {
  readonly store: Store<CampaignProjection>;
  load(sync: CampaignSyncStatus): void;
  loadRuntimeState(runtime: CampaignRuntimeStateResponse): void;
  prependOlderTurns(page: TurnListResponse): void;
  setTurnInput(mode: TurnInputSelection, source: TurnInputModeSource | null): void;
  attachGeneration(run: GenerationRun): GenerationProjectionSession;
}

export function createCampaignStore(): CampaignStoreController;

export type CampaignProjectionProtocolErrorKind =
  | "campaign_not_loaded"
  | "campaign_mismatch"
  | "page_campaign_mismatch"
  | "runtime_state_campaign_mismatch"
  | "unchanged_window_without_baseline"
  | "job_mismatch"
  | "duplicate_turn_id"
  | "duplicate_turn_number"
  | "result_turn_mismatch"
  | "replacement_target_missing"
  | "replacement_target_mismatch"
  | "result_retry_not_available";

export class CampaignProjectionProtocolError extends Error {
  readonly kind: CampaignProjectionProtocolErrorKind;
  constructor(kind: CampaignProjectionProtocolErrorKind);
}
```

- [x] `load` treats nested `sync.campaign` as the canonical campaign projection
  and rejects a mismatch between its ID and the duplicated top-level sync ID
  before mutation. When `turnWindowMode` is `replace`, also require the nested
  turn page's `campaignId` to match both IDs; reject a cross-campaign page before
  sorting or copying. Recursively copy the adopted campaign/world/player-config
  records and their nested arrays/records without relying on DOM
  `structuredClone`; client-core must remain valid with `lib: ["ES2023"]`.
- [x] A `turnWindowMode: "unchanged"` sync is valid only for the currently
  loaded same campaign with a non-null existing `syncToken`. Otherwise throw
  `CampaignProjectionProtocolError("unchanged_window_without_baseline")` before
  mutation; a fresh, switched, or cleared store must request/receive a
  replacement window rather than treating null turn data as an empty ledger. For
  a valid unchanged sync, preserve the existing turns and cursor but refresh all
  copied campaign/world/player-config projections and assign the returned
  `syncToken`.
- [x] `loadRuntimeState` requires a loaded matching campaign, validates the
  response campaign ID, recursively copies all dates/arrays/records, and throws
  `runtime_state_campaign_mismatch` without partial mutation otherwise.
- [x] Normalize every incoming turn window/page to ascending `turnNumber` order and
  reject duplicate turn IDs or duplicate turn numbers atomically. `load` and
  `prependOlderTurns` share this path so a caller-owned array or nested `choices`
  array cannot mutate stored state after the command returns. A sync
  `turnWindowMode: "replace"` replaces the bounded window and cursor;
  `"unchanged"` preserves both. Older pages prepend without changing newer turn
  references and update `nextTurnsCursor`.
- [x] `prependOlderTurns` requires a loaded campaign and otherwise throws
  `CampaignProjectionProtocolError("campaign_not_loaded")`. Task 13a-R makes
  each page self-identifying: before sorting, copying, or merging it, require
  `page.campaignId === current.campaign.id` or throw
  `CampaignProjectionProtocolError("page_campaign_mismatch")` with no partial
  mutation. Never infer ownership from a turn number, opaque cursor, or caller
  argument.
- [x] Hydration is campaign- and job-aware. Loading a different campaign clears
  the private run, invalidates all sessions, and replaces the projection. For a
  same-campaign load, a non-null active `pendingGeneration` takes precedence;
  otherwise exhaustively reduce `generationRecovery`. A matching job may retain
  compatible richer narration/snapshot data and its live run, but the newly
  loaded authoritative status/result state always wins — especially terminal
  recovery. A different authoritative job invalidates the old session/run and
  creates a detached projection.
- [x] Build `hydratedGeneration` by copying only its declared allowlist. Preserve
  action, operation/target, expected turn, attempts, result ID, and status; never
  copy recovery `errorMessage`, `errorCode`, or arbitrary future response fields.
  Map active pending and recoverable recovery to `pending`. Map failed recovery
  to `failed` with the fixed message `"Generation could not complete."`. Map
  completed recovery whose accepted result is not already represented to
  `unavailable` with the fixed message `"Accepted result is ready to load."`
  and null correlation metadata.
- [x] If the completed recovery result ID already exists in the loaded turn
  window, do not create a generation projection. If both pending and recovery
  are null, clear a detached/stale hydration projection. Preserve only a
  matching private live run whose accepted result is not yet represented,
  because sync can race its iterator; once the result appears in the current or
  incoming window, clear the generation projection, run, and session.

- [x] `attachGeneration` requires a loaded campaign whose ID equals
  `run.campaignId`; otherwise throw a typed
  `CampaignProjectionProtocolError("campaign_mismatch")` before changing state.
  When the job ID matches a detached hydration projection, change monitoring to
  attached while preserving its snapshot/narration/result state. Otherwise
  create a fresh attached job projection and invalidate the previous projection
  session. Attaching never aborts the previous run; the app must abort its old
  caller-owned signal before attaching another run.
- [x] A session is the identity token for narration events, which carry no job
  or campaign ID. Once superseded, completed, cancelled, discarded, or
  invalidated by a campaign change, calls to that stale session's `apply` and
  `retryResult` are no-ops. Failed and unrecoverable sessions remain active so a
  later `retryGeneration()` status/event sequence can update the same job. This
  prevents a late iterator result from mutating a newly selected campaign
  without disabling explicit retry controls.
- [x] For the active session, validate every `status` snapshot's `id` and
  `campaignId`; each `detached`/`result_unavailable` event's `jobId`; and every
  completed result's generation `id` and `campaignId` against the session before
  mutation. Throw
  `CampaignProjectionProtocolError("job_mismatch" | "campaign_mismatch")` on a
  live-session mismatch and leave the prior projection unchanged.
- [x] The app owns the watch loop:

  ```ts
  const session = campaignStore.attachGeneration(run);
  for await (const event of run.watch(signal)) session.apply(event);
  ```

  Task 7 must not wrap that loop in a second scheduler or catch protocol errors
  as degraded transport state. Task 5/6 remain the sole owners of generation
  transitions, retry policy, SSE/poll fallback, and detach semantics.
- [x] `retryResult()` calls `run.fetchResult()` only and applies the returned
  event. It never calls enqueue, `retryGeneration`, or a transport source. It is
  valid only while the active result state is `unavailable`; other states are a
  typed `result_retry_not_available` protocol error.

### S4 — define every `GenerationEvent` reduction

- [x] `status` replaces the latest snapshot, sets transport health to healthy,
  resets result state to `pending` (so `retryGeneration()` leaves a retained
  failed/unrecoverable projection), and leaves narration unchanged unless a
  separate `narration` event follows. It clears `hydratedGeneration` because the
  allowlisted stream snapshot is now authoritative. Recursively copy only that
  snapshot's declared fields, including its discriminated operation/target;
  `recoveryMetadata` and raw internal job fields are never part of the stream or
  store contract.
- [x] `narration` replaces only the sanitized narration string.
- [x] `degraded` replaces only transport health. It never overwrites the latest
  snapshot, resets narration, changes durable job status, or settles the job.
- [x] `detached` sets `monitoring: "detached"` and retains the job projection and
  private run. Local detach never calls remote cancel or clears resumable state.
- [x] `result_unavailable` sets result state to `unavailable`, retains the job
  projection and private run, and stores only safe message/correlation metadata
  — never the raw `Error`, cause, or stack. For an existing `NexusApiError` or
  `ApiContractError`, copy its message and correlation ID; for every other
  `Error`, store the fixed message "Accepted result is temporarily unavailable.
  Try loading it again." and null correlation. Do not probe arbitrary
  `Error.cause` objects for
  look-alike fields. A later `retryResult()` can settle the same job without a
  new submission.
- [x] `settled/failed` and `settled/unrecoverable` retain the job/run so the UI
  can expose the existing explicit retry/discard controls. Record the outcome
  separately from transport health. Copy `error.message` only from a
  `NexusApiError` or `ApiContractError`; otherwise store the fixed message
  `"Generation could not complete."` so a transport/model error cannot enter the
  projection.
- [x] `settled/cancelled` and `settled/discarded` clear the matching projection
  and private run. These events carry no job ID, so only the active session token
  may apply them; a stale session cannot clear the active job.
- [x] `settled/completed` first validates the result atomically: require matching
  campaign/job IDs and `expectedTurnNumber === turnNumber`; obtain the
  authoritative operation/target from the run/status or sanitized hydration;
  convert `resultTurnId` into the accepted turn ID; and recursively copy arrays,
  nested cost data, and `stateSnapshot`. A turn-number mismatch,
  missing/mismatched replacement target, or append collision throws its typed
  protocol error with no partial mutation.
- [x] For a result inside the loaded bounded window, append or replace by exact
  identity. An append rejects a different turn at the number. A replacement
  requires the target ID at that number and atomically substitutes the result.
  If sync already loaded the same result ID/number, treat it as idempotent and
  preserve the richer authoritative `TurnSummary` (for example, a non-null
  image URL or cost metadata) instead of rejecting or downgrading it. A later
  page may similarly upgrade an exactly matching projected turn; only conflicting
  IDs or numbers are protocol errors.
- [x] A completed recovery may refer to a turn outside the latest 50-turn
  window. When its number is older than the earliest loaded turn and
  `nextTurnsCursor` is non-null, validate campaign/job/result and replacement
  provenance, update `latestStateSnapshot`, clear generation/run/session, and
  leave the non-contiguous turn window, cursor, and token unchanged. Do not
  insert a disconnected turn or require the deleted replacement target to be in
  memory. If the complete ledger is loaded (`nextTurnsCursor` is null) and the
  required target/result is absent, throw the appropriate protocol error.
- [x] When a live completed result is projected into the local ledger, set
  `historySyncRequired: true` and invalidate `syncToken` and
  `nextTurnsCursor` to null. The next application sync must omit `since` and
  request a replacement window; a successful replace/unchanged load resets the
  flag. If a racing sync already supplied the same result, preserve its richer
  representation and do not invalidate pagination. Update/retain
  `campaign.activeTurnNumber`, set `latestStateSnapshot`, clear `runtimeState`
  for an authoritative refetch, then clear the projection/private run.

This reduction order makes the database result authoritative and prevents a
duplicate accepted turn when a completion event races a campaign refresh.

### S5 — keep selectors pure and allocation-free

- [x] Export pure selectors that accept `Immutable<CampaignProjection>`:
  `selectLatestAcceptedTurn`, `selectLatestAcceptedTurnNumber`,
  `selectGeneration`, `selectIsGenerationInFlight`,
  `selectRequestedTurnInputMode`, `selectRuntimeState`, and
  `selectHistorySyncRequired`.
- [x] `selectLatestAcceptedTurn` returns the existing turn reference or null;
  `selectGeneration` returns the existing projection reference or null. Do not
  allocate wrapper objects or arrays inside selectors and do not add memoization
  for scalar/property reads.
- [x] `selectIsGenerationInFlight` is true only while a generation projection
  exists with `result.state === "pending"` and its latest snapshot is absent or
  nonterminal. It remains true when monitoring is detached and for the workflow's
  automatic `recoverable` cycle, but becomes false after a completed/failed/
  cancelled/discarded snapshot and for `unavailable`, `failed`, or
  `unrecoverable` result states. Those states require result recovery or an
  explicit job action, not an in-flight indicator.
- [x] There is no `selectCurrentTurn`: `viewIndex` remains app-owned. A view may
  combine its local index with the stored ledger without moving navigation state
  into client-core.
- [x] No selector may reach the network, clock, storage, live `GenerationRun`,
  or mutable controller. Selectors operate on plain projection values.

### Deferred — generic multi-family job watching

The original scope required typed adapters for image, Chronicle, and
world-cover job families. **None of the three has a shared client contract**, and
the routes return unprojected rows: `GET /campaigns/:id/image-jobs`
(`server.ts:864`), `GET /worlds/:worldId/cover-job` (`server.ts:846`), and
`GET /api/v1/jobs/:jobId` for Chronicle (`server.ts:1016`, which also returns a
`{ error, message }` 404 that does not satisfy `apiErrorEnvelopeSchema`). Task 9
contracts only the additional Story Player endpoints it actually adopts; it does
not implicitly adopt these three job families. A pure generic watcher would also
need per-family browser sources, which no task creates — Task 6 built only
`createBrowserGenerationSource`.

- [x] Do **not** build `jobs.ts` or the generic watcher in this task. Ship the
  generation family only.
- [x] Do not declare unused generic `JobSourceEvent` or `JobSnapshotSource`
  types. Task 5's shipped `GenerationSnapshotSource` remains the concrete source
  contract until a second contracted family proves the common shape.
- [x] Task 19 (U5) may extract a generic watcher only after at least two job
  families have shared response schemas, typed client methods, family-specific
  terminal predicates, and browser sources. Until then, keep image, Chronicle,
  and world-cover polling in their owning feature adapters.

### TDD and verification sequence

- [x] **Store primitive first.** Add red cases for `Object.is` no-op behavior,
  ordered single notification, idempotent unsubscribe, subscription mutation
  during notification, and committed state after a listener throws. Add
  compile-time fixture assertions that array mutation and every `Date` setter
  are rejected while date read/format methods remain usable. Do not claim the
  generic store clones values; caller-owned ingress isolation belongs to 7b's
  campaign controller. Implement the writable primitive and rerun:

  ```bash
  pnpm exec vitest run tests/unit/client-core/store.test.ts
  ```

- [x] **Campaign hydration second.** Add red cases for initial state, canonical
  nested-campaign loading, top-level/nested and nested-turn-page ID mismatch,
  validated runtime-state loading/mismatch, recursively copied
  ingress records and `choices`, sorted turn-window replacement, unchanged sync,
  valid same-campaign unchanged sync, and rejected fresh/switching unchanged
  sync with no baseline. Add an older-page prepend whose `campaignId` matches,
  then a mismatched page that throws `page_campaign_mismatch` and leaves the
  projection byte-for-byte unchanged. Cover cursor/token updates, duplicate turn
  ID/number rejection across page boundaries without partial mutation,
  turn-input `"auto"` retention, and rejection of a run for another campaign.
  Cover pending-over-recovery precedence; same-campaign refresh with matching,
  different, terminal, and null summaries; safe fixed failed/completed recovery
  copy; no raw recovery error fields; a result already in the window; completed
  append recovery; completed `replace_latest` recovery inside and outside the
  50-turn window; plus a campaign switch that invalidates the old session.
  Implement
  `campaign-store.ts` only far enough to make those cases pass.
- [x] **Generation projection third.** Add a table-driven test covering every
  `GenerationEvent` variant, plus active ID/campaign mismatch, superseded-session
  no-op, degraded preservation, local detach, failed/unrecoverable retention,
  retry status resetting the retained failure to pending without invalidating
  the session, cancelled/discarded
  clearing, and `result_unavailable -> retryResult -> completed`. Mutate
  caller-owned snapshots/results after `apply` and prove the projection is
  isolated. Make completion race a preloaded accepted turn and
  prove no duplicate or `imageUrl` regression; prove an exactly matching later
  page upgrades a locally projected turn; add mismatched expected/actual
  turn numbers, append same-number/different-ID conflicts, successful
  retry-latest replacement, missing/mismatched replacement targets, and prove
  atomic failure. Assert live local completion invalidates token/cursor, sets
  `historySyncRequired`, clears stale runtime state, and forces a replacement
  sync, while a sync-race result already present does not. Pass an arbitrary
  `Error` containing a distinctive secret-like
  message to each failed/unrecoverable/result-unavailable path and assert that
  none of that message reaches the projection; separately prove structured
  `NexusApiError` and `ApiContractError` retain only their message and
  correlation ID where the public projection supports it.
  Implement
  `generation/projection.ts` and its private integration with the controller.
- [x] **Real composition before selectors.** Drive a real
  `GenerationWorkflow` replacement run through `attachGeneration`, apply its
  emitted events, and prove the campaign store replaces the exact target. This
  test must exercise workflow-to-store composition rather than hand-constructing
  every event shape.
- [x] **Selectors fourth.** Write selector tests against plain projection
  objects, including null/empty state and reference identity. Run red, then
  implement allocation-free selectors.
- [x] **Public surface last.** Export only S1-S5's deliberate read/controller
  types, factory, error, and selectors from `packages/client-core/src/index.ts`.
  Extend the core compiler fixture to construct a store through the public
  barrel, and assert the boundary scanner still rejects Web/Node/framework
  imports. Do not export `WritableStore`, the live run slot, or reducer helpers.
The five TDD phases above map onto the delivery sub-tasks: *store primitive* is
**7a**; *campaign hydration* plus the campaign half of *selectors* is **7b**;
*generation projection*, the generation half of *selectors*, and *public
surface* complete in **7c**. Each of 7a and 7b still exports a coherent barrel
for the surface it adds — "public surface last" means the final shape is settled
in 7c, not that the earlier stages ship unexported modules.

- [x] Run focused checks **at every stage**, not only at the end:
  `pnpm exec vitest run tests/unit/client-core/ tests/unit/client-boundaries.test.ts`,
  `pnpm --filter @infinite-quest/client-core check`, and
  `pnpm check:client-boundaries`.
- [x] Run completion checks at every stage: `pnpm check`, `pnpm build`,
  `pnpm test:unit`, `pnpm test:integration`, review the complete diff, and run
  `pjm precheck`.
- [x] Tick that stage's items and record a **Current Task 7a / 7b / 7c
  verification** block under **Completion status** in the same commit that marks
  each stage complete, per the rule in Task 4a P4. Three stages means three
  blocks; do not defer them all to the end of 7c.

### 7d — Track C exit audit and documentation reconciliation

Task 7c completing is not, by itself, evidence that Track C is coherent. Before
starting B1, reconcile every governing document against the shipped C0-C8
surface and produce a named audit artifact.

- [x] Update `CLIENT_CORE_BOUNDARY.md` to the final C6 ownership split,
  operation provenance, runtime-state projection, session lifecycle, and bounded
  history rules. Remove the stale generic-watcher and older hydration language.
- [x] Update `API_UI_CONTRACTS.md` to the final page/sync/recovery schemas,
  active-only pending summary, and stream replacement target.
- [x] Update Interaction Flows 7 and 11 plus the feature matrix so reload/resume,
  completed recovery, retry, and out-of-window replacement behavior agree with
  Tasks 13a-R, 7P, and 7c.
- [x] Recheck all ten Track C exit criteria against actual package exports,
  boundary fixtures, the legacy Story Player proof, build/deployment behavior,
  benchmarks, and tests. Record an evidence link or exact command/result for
  every criterion; an unnamed final review is not an exit gate.
- [x] Run `pnpm check`, `pnpm build`, `pnpm test:unit`,
  `pnpm test:integration`, the client contract benchmark, `git diff --check`,
  complete-diff review, and `pjm precheck`. Record a `Current Task 7d
  verification` block and a scoped review report. Do not change
  `apps/web-next` UI implementation in this audit.

**7d exit condition:** All Track C implementation and governing documentation
describe the same public surface, every exit criterion has current evidence,
and the backend sequence is authorized. Track U remains blocked until the
separate backend completion audit after Task 14e.

**Definition of done:** Framework adapters can subscribe to a stable campaign
projection through a read-only `Store`; external arrays cannot mutate it;
selectors are pure and allocation-free; stale or cross-campaign events cannot
change the active projection; every Task 5 event has one tested reduction; and
the generation job survives degraded, detached, failed, unrecoverable, and
`result_unavailable` states until the authoritative completed/cancelled/
discarded outcome clears it. The bounded accepted-turn window can be replaced
or extended without duplicates while its cursor and sync token remain coherent.
No watcher, abort controller, generic job family, or uncontracted server record
enters client-core.

---

## Task 8 — C7: Static build and deployment contract

This package lands before Slice 1 so `/app/` does not require backend changes
during feature implementation.

**Files:**

- Create: `apps/web/package.json`
- Create: `apps/web/vite.config.ts`
- Create: `apps/web/src/legacy-client-entry.ts`
- Create: `apps/web-next/package.json`
- Create: `apps/web-next/vite.config.ts`
- Create: `apps/web-next/index.html`
- Create: `apps/web-next/src/bootstrap.ts`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `services/api/src/server.ts`
- Modify: `packages/database/src/config.ts`
- Modify: `Dockerfile`
- Modify: `compose.yaml`
- Modify: `deploy/swarm/stack.yaml`
- Modify: `.github/workflows/ci.yml`
- Test: `tests/unit/server-security.test.ts`
- Create: `tests/unit/web-build-contract.test.ts`

**Review gates and commit boundaries:**

1. **C7a — contracts workspace packaging.** Create the contracts package,
   convert imports, and pass client/compiler boundary tests. Commit and review it
   independently before adding Vite.
2. **C7b — reproducible browser builds.** Add the two Vite packages, the
   framework-free `/app/` bootstrap shell, root scripts, build contract tests,
   and lockfile changes. Commit and review it independently.
3. **C7c — static serving and deployment.** Add the two runtime roots, route and
   cache/CSP tests, image copies, Compose/Swarm configuration, CI, and a container
   smoke test. Do not mark Task 8 complete until all three gates pass together.

- [x] Define reproducible `build:web:legacy`, `build:web:next`, `dev:web`, and
  `check:web` scripts and make the root `build`, `check`, and CI paths call them.
  Declare Vite in the package(s) that execute it rather than relying on a root
  transitive install.
- [x] Build current public assets plus a compiled legacy client entry into a
  generated `apps/web/dist/` directory; do not commit generated bundles. Copy
  `public/` through Vite, emit the legacy Story Player entry at a stable
  no-cache filename (its imported chunks/assets remain content-hashed), and
  reserve Task 9's `story.html` change to point at that entry.
- [x] Make `apps/web-next` buildable **before** a framework is selected. Its
  `index.html` loads `src/bootstrap.ts`, which renders a CSP-safe internal-
  preview shell stating that Slice 1 is not installed yet. U1 replaces that
  bootstrap after recording the framework ADR. Task 8 may not claim `/app/`
  support with an empty package or a build that has no HTML entry.
- [x] Serve the replacement app at `/app/` with history fallback while `/nexus/`
  and `/story` remain unchanged and default.
- [x] Set Vite base paths explicitly so chunks and assets resolve behind the
  Fastify prefixes (`/nexus/` for the compiled legacy entry and `/app/` for the
  replacement shell). `dev:web` must proxy `/api`, `/health`, and required asset
  paths back to Fastify so the browser remains same-origin from the application's
  perspective; do not widen production CORS for Vite development.
- [x] Replace the single ambiguous runtime web root with explicit
  `legacyWebRoot`/`LEGACY_WEB_ROOT` and `nextWebRoot`/`NEXT_WEB_ROOT` settings,
  defaulting to the two generated dist directories. Keep path resolution in
  configuration, not route handlers. Update every runtime-config test fixture.
- [x] Register `/app/` without allowing SPA fallback to mask missing static
  assets or API paths: known asset/chunk requests return 404, while extensionless
  `/app/*` navigation returns the replacement `index.html`. `/api/*`, `/health/*`,
  `/nexus/*`, `/story*`, and `/vendor/*` never enter the fallback.
- [x] Give hashed assets immutable long-lived caching; keep HTML `no-cache` and
  preserve API `no-store`.
- [x] Keep CSP at `script-src 'self'`, `style-src 'self'`, and `connect-src
  'self'`; do not introduce inline-script exceptions.
- [x] Copy both built static roots into the runtime image and verify Compose and
  Swarm use the same artifact layout.
- [x] Add server tests for `/app/`, deep-link fallback, cache headers, CSP, old
  routes, traversal attempts, API/fallback separation, and missing-asset
  behavior. Add a build-contract test that checks both HTML entries and their
  referenced assets exist after `pnpm build` without snapshotting hash values.
- [x] **Inherited from the Task 4 review — make `packages/contracts` a real
  workspace package.** It currently has no `package.json`, so it is not a
  workspace member, gets no `node_modules`, and its own `import { z } from
  "zod"` resolves only by walking up to the root install. Every consumer reaches
  it by relative path. Give it a `package.json` with a name, `exports`, a
  `check` script, and its own `zod` dependency; then convert the client
  packages' relative contract imports to the package name and update
  `scripts/check-client-boundaries.mjs` to accept it.

  **`zod` is declared only in `client-web`, not in both client packages.** Task
  4 added it to both, and Task 4a P2 then removed it from `client-core` because
  the boundary scanner rejected a bare `zod` import there and the declaration
  was inert. Do not go looking for a client-core declaration; it is deliberately
  absent. Neither declaration fixes the contracts hop, which is what this item
  is for.

  This item touches files beyond the list above: create
  `packages/contracts/package.json`, modify `scripts/check-client-boundaries.mjs`
  and `tests/unit/client-boundaries.test.ts`, and rewrite the relative contract
  imports across `packages/client-core/src/**` and `packages/client-web/src/**`
  — `ports.ts`, `generation/types.ts`, `generation/workflow.ts`,
  `generation/submission.ts`, `api-client.ts`, `http-client.ts`, and the
  storage and generation modules all import contracts by relative path today.
  Land it as its own commit, separate from the build and deployment work.
- [x] **Close the inherited correlation-header question by decision, not a
  conditional implementation.** Production `/app/` and the API are same-origin,
  and the Vite dev server proxies the API, so do not add
  `Access-Control-Expose-Headers`. Record this in the Task 8 verification. If a
  future deployment deliberately separates origins, that deployment change must
  add and test the exposure then.
- [x] Run `pnpm check`, `pnpm build`, container build, and rendered Compose/Swarm
  configuration checks. Start the built container (or the existing Compose smoke
  harness), wait for readiness, and fetch `/nexus/`, `/story`, `/app/`, one
  `/app/` deep link, and one hashed asset from the runtime image.

**Definition of done:** A production image serves both UIs from deterministic
build output, local development has one documented command, and Slice 1 needs no
new server or deployment mechanism.

---

## Task 9 — C8: Prove the boundary against the current Story Player

Slice 0 proves the complete generation vertical slice. It does not migrate all
management routes or remove every current network call in one pass.

**Status: Complete (2026-08-02).** The focused contract/client prerequisite and
the single revertible Story Player rewire both landed with their intended gate
ownership. Verification and rollback evidence is recorded in
`docs/review/2026-08-02-task-9-c8-completion.md`.

**Pre-implementation correction status: Complete (2026-08-02, corrected again
before implementation).** Reviewed against
the shipped Tasks 4-6 and the now-complete Task 8. The endpoint inventory below
was checked route by route against `services/api/src/server.ts` and is accurate,
including its two subtle entries — `/meta` really is a raw
`fetch("/api/v1/meta")` at `story.js:2867`, and the branch call really is
helper-injected through `story-routing.js:10`. Four corrections were applied:
the C7 prerequisite note had gone stale, the composition root had no owning
item, the raw `story.js` copy keeps shipping after the entry switch, and the
rollback scope conflicted with the file list. The final implementation-readiness
pass also corrected the full Story module move graph, the ZIP-vs-JSON export
contract mismatch, the illustration adapter allowlist, the moved-module test
inventory, the explicit composition bootstrap seam, and root typecheck path.

**Task 8 (C7) is a satisfied prerequisite.** This task makes `story.js` import
`@infinite-quest/client-web` and `@infinite-quest/client-core`, which needs a
bundler. C7 has landed (`175a854`, `d48e70a`, `3364bd0`, `05d89c3`, `afdc1c0`,
`cb45bcc`) and supplies one: `apps/web/vite.config.ts` builds
`apps/web/src/legacy-client-entry.ts` to `dist/legacy-client.js`, and the API
serves the built root. An earlier revision of this paragraph said no bundler
existed and told the reader to wait for C7; that was true when written and is
not now.

What C7 did **not** do is switch the page over. `legacy-client-entry.ts` is a
single line — `import "../public/story.js"` — and no HTML references the bundle:
`story.html:522` still loads `/nexus/story.js` directly, so `legacy-client.js`
is built today and never executed. Wiring that switch is C8's job and has its
own item below.

**Files:**

- Move + modify: `apps/web/public/story.js` -> `apps/web/src/story.js`
- Move: `apps/web/public/story-routing.js` (and its `.d.ts`) -> `apps/web/src/`
- Move + modify: `apps/web/public/story-generation-cancellation.js` ->
  `apps/web/src/`
- Move: `apps/web/public/story-state-editor.js` -> `apps/web/src/` (there is no
  existing `.d.ts` for this module; do not claim or move a nonexistent one)
- Modify: `apps/web/public/story.html` — point the module script at the compiled
  entry instead of `/nexus/story.js`
- Modify: `apps/web/src/legacy-client-entry.ts` — it currently imports
  `../public/story.js`; update the path and host the composition root
- Create: `apps/web/src/composition.ts` — constructs the shared `SessionPort`,
  `Clock`, delay, visibility, ID factory, API client, pending store, source, and
  workflow, and is the only place those singletons are created
- Modify: `package.json` — move the root `node --check` target from the old
  public path to `apps/web/src/story.js`
- Modify: `tests/unit/web-build-contract.test.ts` — assert the compiled entry is
  referenced by `story.html` and that `dist/story.js` no longer exists
- Create: `apps/web/src/legacy-illustration-api.ts` — the only named C8
  transitional HTTP adapter for illustration routes not adopted in Slice 1.
- Modify: `packages/contracts/src/client-api.ts` — add schemas for every
  Story Player endpoint adopted beyond the Task 4 table.
- Modify: `packages/contracts/src/index.ts` — expose only those new public
  contracts.
- Modify: `packages/client-web/src/api-client.ts` — add the corresponding typed
  methods; keep the generic request function private to client-web.
- Modify: `packages/client-web/src/index.ts` — expose any added public client
  interface types used by composition, and no generic request escape hatch.
- Modify: `services/api/src/server.ts` — project the corresponding success
  responses through the shared schemas before sending them.
- Modify: `tests/unit/client-api-contracts.test.ts` — reject malformed request
  and response fixtures for every added contract.
- Modify: `tests/unit/client-api-routes.test.ts` — prove the real route/status
  shapes parse through those contracts.
- Modify: `tests/unit/client-web/api-client.test.ts` — prove method/path/schema
  mappings for the added client surface.
- Modify: `tests/unit/story-player-ui.test.ts`
- Modify: `tests/unit/story-state-editor.test.ts`
- Modify: `tests/unit/story-routing.test.ts`
- Modify: `tests/unit/story-settings.test.ts`
- Modify: `tests/unit/management-ui.test.ts`
- Create: `tests/unit/legacy-illustration-api.test.ts`
- Modify: `tests/unit/csp-ui.test.ts`
- Review/modify as needed: `tests/unit/server-security.test.ts` — static module
  fixture assumptions must still match the post-move asset surface
- Modify: `tests/integration/generation.integration.test.ts` — own the
  malformed-generation-snapshot route-to-workflow rejection regression
- Modify: `docs/ui/CLIENT_CORE_BOUNDARY.md`
- Modify: `docs/ui/API_UI_CONTRACTS.md`
- Modify: `docs/ui/FEATURE_IMPLEMENTATION_MATRIX.md`
- Modify: `docs/ui/INTERACTION_FLOWS.md`
- Modify: `docs/ui/OPEN_QUESTIONS.md`
- Test: new client-core/client-web tests from C3-C6

**Endpoint scope has two explicit inventories.** The C8 legacy-parity inventory
is every non-illustration call actually used by `story.js` and its imported
helpers:

| Concern | Methods and paths to contract/adopt |
|---|---|
| Shell/readiness | `GET /meta`, `GET /session`, `GET /providers`, `PATCH /users/me/profile` |
| Campaign projection | `GET /campaigns/:id/sync-status`, `GET /campaigns/:id/turns`, `GET /campaigns/:id/state` including historical `turnNumber` query, `PATCH /campaigns/:id/state` |
| Generation | `POST /campaigns/:id/turn-input/classify`, `POST /campaigns/:id/generations`, `POST /campaigns/:id/generations/retry-latest`, `GET /generation-jobs/:jobId`, `GET /generation-jobs/:jobId/stream`, `GET /generation-jobs/:jobId/result`, `POST /generation-jobs/:jobId/retry`, `POST /generation-jobs/:jobId/cancel`, `POST /generation-jobs/:jobId/discard` |
| Existing non-generation Story Player actions | `POST /campaigns/:id/rewind`, `POST /campaigns/:id/branch` |

`playerConfig` remains part of the validated sync projection rather than a
fictional extra HTTP call. Direct `/meta` `fetch()` and helper-injected state/
branch requests count as raw Story Player calls and must not escape the
inventory. `GET /campaigns/:id/export` is deliberately **not** in this JSON
adoption inventory: `archive-routes.ts` returns an `application/zip` stream,
whereas the legacy Markdown/PDF buttons need campaign/turn data. Generate those
formats from the already validated loaded projection and illustration data; do
not parse the archive response as JSON or introduce a false JSON projection.
If a later UI needs archive download, add an explicit typed blob/download method
and its own behavior rather than reusing the projection path. Illustration routes
may remain on the named legacy adapter because illustrations are a Slice 2
feature, but they may not leak into client-core or bypass CSP/error handling.
The adapter's complete allowlist is: `GET /campaigns/:id/illustration-config`,
`GET /campaigns/:id/illustration-segments`, `GET /campaigns/:id/image-jobs`,
`POST /image-jobs/:id/retry`, `POST /illustration-segments/:id/images`, `POST
/turns/:id/illustration-segments`, `GET /turns/:id/illustration-resolution`, and
`POST /turns/:id/illustration-match`. It validates each successful response with
a named schema as well as the standard error envelope, preserves correlation
IDs, sends no text-provider credential, and is covered by the transitional
boundary scanner; it is not a generic public `request(path)` escape hatch.
Remove the orphaned `regenerateIllustration`/`removeIllustration` legacy
single-image UI functions and their handlers; Q2 establishes their endpoints
are backend-only and they are explicitly excluded from the allowlist.

The C8 **Slice 1 prerequisite inventory** also adopts the methods U3/U4 need but
the Story Player does not call: minimal draft-world creation, campaign creation
(`campaignCreateSchema` plus a shared success projection), and listing playable
characters for a selected immutable world version. `GET /worlds` and
`GET /campaigns` already shipped in C3. U3 does not adopt full authoring or
publication here. If a create response is identical to an existing summary,
reuse that schema; otherwise name one new response schema rather than casting.
This inventory closes before U1 so Slice 1 feature commits do not need server
response changes.

Expand the table with the exact request schema, response schema, typed client
method, and consumer during the first C8 gate; add the three Slice 1 prerequisite
routes beside it. The shorter historical endpoint table is not complete enough
to guarantee behavior parity.

Task 4 initially adopts only its explicit C1 endpoint table. Before Task 9
replaces any additional raw Story Player call, Task 9 must add one shared request
schema where applicable, one shared response schema, server-side response
projection through that schema, one typed `NexusApiClient` method, and focused
contract/route/client tests. Do not expose the generic HTTP request method to the
Story Player as an escape hatch, and do not call an unvalidated route through a
cast. C8 therefore has two mandatory internal review gates: first land and
review the contract/server/client extensions as a focused prerequisite commit,
then land and review the Story Player rewire as the single revertible C8 commit
described below. Do not combine the two gates into one opaque diff, and do not
declare C8 complete until both have passed their focused and full verification.

- [x] Replace the Story Player's API helper for adopted endpoints with
  `NexusApiClient` methods.
- [x] **Build the composition root, and share the singletons.** This instruction
  previously lived only in Task 6's *Public surface produced* note, where an
  implementer working from this checklist would not see it. Construct one
  `SessionPort`, `Clock`, `DelayScheduler`, `VisibilitySource`, `IdFactory`,
  `NexusApiClient`, pending-submission store, and browser generation source, then
  pass them to `createGenerationWorkflow`. **The same `SessionPort` instance goes
  to the API client and the source, and the same `Clock` instance goes to the
  source and the Task 5 workflow.** A split clock is not cosmetic: Task 5 C6
  stamps `createdAt` for the 15-minute expiry window from its injected clock
  while Task 6 S7 does `Retry-After` HTTP-date math from its own, so two clocks
  desynchronise submission expiry from transport backoff. Assert the sharing in
  a test rather than relying on construction order.
- [x] **Make initialization explicit.** `composition.ts` exports a typed factory
  for those dependencies; `story.js` exports an explicit
  `startStoryPlayer(composition)` initializer and has no top-level boot side
  effect; `legacy-client-entry.ts` creates the composition once and invokes that
  initializer once. Do not use global dependency injection or import a hidden
  singleton into `story.js`; assert the bootstrap and singleton-sharing contract
  in a focused test.
- [x] Make `story.html` load Task 8's compiled legacy entry. Bare workspace
  package imports must be resolved by Vite and must not appear in a raw browser-
  served `story.js`; add a production-build smoke assertion for this wiring.
- [x] **Stop publishing the raw `story.js` once it carries bare imports.**
  `apps/web/vite.config.ts` sets `copyPublicDir: true`, so `dist/` currently
  ships both the verbatim `public/story.js` and the separate
  `legacy-client.js`. After this task adds workspace imports to `story.js`, that
  copied file becomes a reachable URL serving a script that throws on load at
  `/nexus/story.js`. Move `story.js` and its sibling module graph —
  `story-routing.js`, `story-generation-cancellation.js`, and
  `story-state-editor.js` — its complete sibling module graph — out of
  `publicDir` into `apps/web/src/`, leaving `publicDir` for genuine static
  assets. `story.html` and `index.html` stay in `publicDir`.
  Assert in the build-contract test that `dist/story.js` no longer exists.
- [x] Replace duplicated SSE/poll terminal branches with the shared workflow.
- [x] Replace local pending-submission functions with the injected browser store.
- [x] Generate Markdown/PDF exports from the current validated campaign, turn,
  and illustration projections. Remove the JSON `GET /campaigns/:id/export`
  request from those paths; the ZIP archive route remains a separate download
  concern.
- [x] Keep DOM rendering, scrolling, toasts, focus, modals, and illustration UI
  inside the legacy app.
- [x] Preserve exact user-visible behavior for submit, retry-latest, resume,
  streamed narration, recoverable, cancel, discard, and completed result.
- [x] Preserve **progressive narration as visible text**, not only staged status
  copy. Render only `GenerationEvent.narration`, keep its live badge/cursor and
  scroll-follow behavior app-owned, and replace it atomically with the validated
  accepted result. No raw `partialOutput` reaches the client packages or DOM.
- [x] Preserve the resolved-Q4 retry-latest treatment: while a replacement runs,
  state that the accepted turn remains until validation; on failure, state that
  the original was preserved. A replacement request cannot look like an append.
- [x] Preserve Auto classification behavior and display the resolved Action or
  Scene mode before/with submission. If the input changes while classification
  is pending, discard the stale classification and require review rather than
  submitting it.
- [x] Surface the unique active-generation conflict as "a turn is already
  generating" and attach/resume the authoritative job where possible; never
  reduce it to a generic toast or submit a second idempotency key.
- [x] **Render `result_unavailable` as a recoverable fetch problem, never as a
  failed generation.** The turn was accepted server-side; only the client's
  result fetch failed. This corrects a real current defect: at
  `story.js:1263-1269` a failed `/generation-jobs/:id/result` call rejects out of
  `pollGenerationJob`, and the caller at `story.js:998` toasts
  `Generation failed: <message>` for a turn that actually succeeded. The
  mismatch is then invisible until the user reloads — `sync-status` restricts
  `pendingGeneration` to non-terminal statuses (`server.ts:641`), so a completed
  job never reappears as pending, and the turn simply shows up in the accepted
  turns list as though nothing went wrong. The rewired client must keep the
  generation displayed as complete-but-loading, offer a retry that calls
  `fetchResult()` only, and must not re-enqueue, retry, or discard the durable
  job.
- [x] Do not let `degraded` surface as a generation failure either. It is
  transport health; the durable job is unaffected and remains resumable.
- [x] Remove only source-string assertions whose behavior is now covered by
  client-core/client-web tests. Keep presentation assertions until replacement
  components exist.
- [x] Add a route-level integration test proving malformed generation snapshots
  are rejected before reaching the workflow in
  `tests/integration/generation.integration.test.ts`.
- [x] Add contract/client tests proving the Slice 1 prerequisite methods exist,
  caller-supplied `user_id`/`X-User-Id` is never synthesized from session data,
  and correlation IDs survive every adopted error path.
- [x] Reconcile the stale UI documents in the file list: Q1 narration and Q4
  replacement are resolved; explicit cancel now exists and remains distinct from
  detach; HTTP/Web adapters live in client-web; endpoint adoption is incremental;
  and the generic non-generation watcher remains deferred. Close any projectmem
  issue whose only blocker was those now-recorded resolutions.
- [x] Run focused tests, all unit tests, integration tests, and the current Story
  Player behavior checklist. The completion report distinguishes the automated
  evidence from the manual source/behavior review; no browser E2E exists before
  U6.

**Rollback boundary (required before merge).** C8 rewires the *live* Story
Player — the highest-stakes path in the product — and this codebase has no
feature-flag mechanism (`REPOSITORY_UI_MAP.md` §11). Recovery must therefore be
planned rather than improvised:

- [x] Land C8 as a single revertible commit scoped to the **client rewire**:
  `story.js` and its sibling modules, `story.html`, `legacy-illustration-api.ts`,
  the composition root, and their tests. No unrelated refactors ride along;
  `git revert` must restore the previous working client without conflict
  resolution.
- [x] **Gate ownership, so "revertible" stays true.** Gate 1 takes the contract,
  server-projection, and typed-client extensions plus their contract/route/client
  tests. Gate 2 takes the client rewire above. The five `docs/ui/*`
  reconciliations belong to **gate 1**, not the revertible commit — reverting the
  rewire must not also revert documentation that describes contracts which remain
  in place. The earlier wording said "touching only the Story Player and its
  tests", which no achievable gate-2 diff satisfies once `story.html`, the
  illustration adapter, and the composition root are counted.
- [x] Verify the revert on a branch before merging C8 — actually run it, do not
  assume it applies cleanly.
- [x] Record the play-loop checklist result (submit, streamed narration,
  recoverable retry, cancel, discard, completed, reload-resume) in the PR, since
  no automated E2E covers the legacy client until U6.
- [x] Name the observable regression signals that should trigger the revert:
  `turn_generation_stream_connected` without a matching
  `turn_generation_stream_closed`, a rise in generation jobs settling as
  `failed`/`recoverable`, or duplicate submissions for one campaign.

A runtime escape hatch (for example `?client=legacy` selecting the pre-C8
bundle) is acceptable as an alternative, but only if it ships *with* C8 and is
covered by a server route test. Do not defer the decision to incident time.

**Definition of done:** The old Story Player completes and resumes the full
generation loop through client packages. Deleting or replacing its rendering
code does not remove generation policy, persistence, or transport behavior. A
verified rollback path exists.

---

## Track C exit criteria

**Status: audited and met (2026-08-03).** Task 7d reconciled all ten criteria
against the shipped tree and recorded the result in
`docs/review/2026-08-03-task-7d-track-c-exit-audit.md`. Re-measured during the
Task 7 completion review on `9e8d5f1`: `pnpm check` 548 candidate files,
`pnpm build` clean, `pnpm test:unit` 1010/1010 across 86 files,
`pnpm test:integration` 193 passed / 2 skipped across 17 files.

Track C being met authorizes the **backend sequence**, not UI work. The audit is
explicit that UI remains blocked until Task 14f; do not read "Track C complete"
as permission to begin the U-track.

1. `packages/client-core` compiles with `lib: ["ES2023"]`, `types: []`, and no
   transitional boundary allowlist.
2. Client-web transport, storage, clock, delay, and ID adapters are framework-free.
3. The existing Story Player uses shared generation workflow and transports with
   no behavior or visual regression.
4. Generation request and response data is runtime-validated on both sides of
   the HTTP boundary.
5. Raw `partialOutput` is never parsed or rendered by client-core or client-web.
6. One browser tab cannot create duplicate watchers for one job.
7. The dependency checker proves client packages do not import `apps/` or
   `services/`; this replaces the destructive “delete public JS files” command.
8. **Relocation is proven, not just direction.** A headless test drives the
   complete generation workflow — submit, stream, degrade to polling,
   `recoverable`, auto-retry, settle `completed`, then reload-resume via
   `syncStatus` — using only `client-core` plus fakes, with no module from
   `apps/` loaded in the test process. Criterion 7 alone is satisfied by an
   empty package; this one is not, and together they prove the logic actually
   moved rather than merely that imports point the right way.
9. Current management-client networking remains on a named transitional
   allowlist scheduled for removal by later UI slices.
10. `pnpm check`, build, unit, focused integration, and manual play-loop checks
    pass.

---

# Track B — modular backend and throughput

## Task 10 — B1: Extract the generation application boundary

The worker currently imports six implementations from `services/api`. B1 owns
only the `generation-service.js` exception; the remaining asset, illustration,
image, memory, and segmented-illustration exceptions stay explicit and are
removed domain-by-domain in Task 14. Do not claim that B1 removes every
cross-role exception, and do not hide an exception by moving the same import
unchanged into an unscanned helper.

The target direction for this vertical slice is:

```text
Fastify generation routes -> generation application use cases <- worker scheduler
                                  ^                    ^
                                  |                    |
                    PostgreSQL repository       execution adapter
```

`packages/application` owns backend policy and typed ports. It must not import
Fastify, `pg`, provider implementations, worker scheduling, runtime configuration,
or any file below `services/**`. PostgreSQL and generation execution remain
adapters. The migration is deliberately behavior-preserving: B1 changes module
ownership and composition, not the HTTP/SSE contracts, prompt protocol, SQL
semantics, durable job states, lease rules, logging fields, or shutdown policy.

### Task 10 checkpoint and review policy

Task 10 is split into six ordered substages. Each substage must land as its own
small commit, include its own checked requirements and verification evidence,
and receive a scoped review before the next substage starts. Do not fold setup
into a later checkpoint or combine the API and worker cutovers into one diff;
`generation-service.ts`, `server.ts`, and the generation integration suite are
current high-churn bug magnets and require smaller review surfaces.

1. **Task 10a — application package and contracts**
2. **Task 10b — PostgreSQL command/query repository**
3. **Task 10c — API use-case adapter**
4. **Task 10d — execution, claim, lease, and state-transition adapter**
5. **Task 10e — worker/runtime composition and boundary enforcement**
6. **Task 10f — behavior-parity audit and B1 completion gate**

For every checkpoint:

- [x] Start from the preceding reviewed checkpoint and record the base and head
  commit SHAs in the evidence block.
- [x] Use red/green tests for every changed behavior or contract; a pure file
  move still requires tests proving imports and public behavior at its new
  boundary.
- [x] Preserve unrelated dirty worktree files and stage only the checkpoint's
  named files.
- [x] Run `pnpm check`, `pnpm build`, `pnpm test:unit`,
  `pnpm test:integration`, `git diff --check`, and `pjm precheck` before review.
- [x] Have a fresh reviewer inspect `base..head` for spec compliance, ownership
  isolation, transaction parity, role dependency direction, and unintended
  public-contract changes. Resolve findings in a separate correction commit and
  repeat the scoped review.
- [x] Keep Task 10's top-level status `Not started` until 10f passes. During
  implementation, record only the completed substage and its evidence so a
  partially migrated boundary is never mistaken for B1 completion.

### Task 10a — B1a: Create the application package and freeze contracts

**Purpose:** establish a platform-implementation-free generation API before
moving SQL or production call sites. This checkpoint must compile and be unit
testable while production continues to use the existing generation service.

**Files:**

- Create: `packages/application/package.json`
- Create: `packages/application/tsconfig.json`
- Create: `packages/application/src/index.ts`
- Create: `packages/application/src/generation/index.ts`
- Create: `packages/application/src/generation/types.ts`
- Create: `packages/application/src/generation/errors.ts`
- Create: `packages/application/src/generation/ports.ts`
- Create: `packages/application/src/generation/use-cases.ts`
- Create: `tests/unit/application/generation-use-cases.test.ts`
- Modify: `packages/contracts/src/prompt-library.ts` — receives the moved
  `PromptSnapshot` type
- Modify: `services/api/src/prompt-library-service.ts` — re-import the moved type;
  `resolvePromptSnapshot` stays here
- Modify: `services/api/src/generation-service.ts` — re-import the moved type
- Modify: `services/api/src/turn-intent-service.ts` — import the moved type from
  contracts rather than the API adapter
- Modify: `services/api/src/infinite-worlds-import-service.ts` — import the moved
  type from contracts rather than the API adapter
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `scripts/check-client-boundaries.mjs`
- Modify: `tests/unit/client-boundaries.test.ts`
- Test: `tests/unit/prompt-library.test.ts`

The boundary-scanner change is larger than one line. `check-client-boundaries.mjs`
has no concept of `packages/application` today, so 10a must add an allowed-import
predicate for it alongside the existing client-core/client-web ones, plus the
matching rejection tests — the same shape of work Tasks 3a and 8 each required.
Name the functions `isApplicationImportAllowed` and `checkApplication`. Allow
only `@infinite-quest/contracts` and relative imports that resolve within
`packages/application`; reject deep relative access to contracts, every other
workspace package, `services/**`, `apps/**`, third-party packages, and `node:`
imports. Dispatch every `packages/application/src/**` source through this check
from `collectClientBoundaryViolations`.

**Package contract:**

- Name the package `@infinite-quest/application`, mark it private and ESM, and
  export only `./src/index.ts`. Add its explicit check to the root `check` and
  `build` chains; do not rely solely on the root TypeScript include to prove the
  package can compile as a workspace consumer.
- Depend only on shared packages required by public types, initially
  `@infinite-quest/contracts`. Do not add Fastify, `pg`, logger, story-engine,
  database, runtime, or worker dependencies.
- Keep the public barrel intentional. Export use-case factories, public
  application types, typed errors, and adapter ports; do not export concrete
  adapters or mutable implementation internals.

Use this exact package-local TypeScript boundary; do not extend the root config,
because its Node types would weaken the platform-free proof:

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2023"],
    "types": [],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*.ts"]
}
```

The package compiler is the primary guard against Node and DOM globals; the AST
scanner independently guards dependency direction, including type-only,
dynamic, CommonJS, import-type, and re-export forms. Add negative scanner tests
for each form and a positive test for local modules plus the contracts package.

**Required interfaces:**

```ts
import type {
  GenerationActionResponse,
  GenerationEnqueueResponse,
  GenerationJobStatus,
  GenerationRequest,
  GenerationResult,
  GenerationRetryLatestRequest,
} from "@infinite-quest/contracts";

export type EnqueueGenerationResult = GenerationEnqueueResponse;
export type GenerationJob = GenerationJobStatus;
export type GenerationMutationResult = GenerationActionResponse;

export type OwnerScope = Readonly<{ ownerUserId: string }>;

export type CampaignGenerationScope = OwnerScope & Readonly<{
  campaignId: string;
}>;

export type GenerationJobScope = OwnerScope & Readonly<{
  jobId: string;
}>;

export type GenerationClaimRequest = Readonly<{
  workerId: string;
  leaseSeconds: number;
}>;

export type GenerationExecutionRequest = Readonly<{
  workerId: string;
  leaseSeconds: number;
  claim: ClaimedGeneration;
}>;

export interface GenerationCommandRepository {
  enqueueAppend(
    scope: CampaignGenerationScope,
    request: GenerationRequest,
  ): Promise<EnqueueGenerationResult>;
  enqueueReplacement(
    scope: CampaignGenerationScope,
    request: GenerationRetryLatestRequest,
  ): Promise<EnqueueGenerationResult>;
  getJob(scope: GenerationJobScope): Promise<GenerationJob>;
  getResult(scope: GenerationJobScope): Promise<GenerationResult>;
  retry(scope: GenerationJobScope): Promise<GenerationMutationResult>;
  cancel(scope: GenerationJobScope): Promise<GenerationMutationResult>;
  discard(scope: GenerationJobScope): Promise<GenerationMutationResult>;
}

export interface GenerationClaimRepository {
  claimNext(request: GenerationClaimRequest): Promise<ClaimedGeneration | null>;
}

export interface GenerationExecutor {
  execute(request: GenerationExecutionRequest): Promise<boolean>;
}

export interface GenerationApplication {
  enqueueAppend(
    scope: CampaignGenerationScope,
    request: GenerationRequest,
  ): Promise<EnqueueGenerationResult>;
  enqueueReplacement(
    scope: CampaignGenerationScope,
    request: GenerationRetryLatestRequest,
  ): Promise<EnqueueGenerationResult>;
  getJob(scope: GenerationJobScope): Promise<GenerationJob>;
  getResult(scope: GenerationJobScope): Promise<GenerationResult>;
  retry(scope: GenerationJobScope): Promise<GenerationMutationResult>;
  cancel(scope: GenerationJobScope): Promise<GenerationMutationResult>;
  discard(scope: GenerationJobScope): Promise<GenerationMutationResult>;
}

export interface GenerationWorkerApplication {
  claimNext(request: GenerationClaimRequest): Promise<ClaimedGeneration | null>;
  executeClaimed(request: GenerationExecutionRequest): Promise<boolean>;
}

export function createGenerationApplication(
  repository: GenerationCommandRepository,
): GenerationApplication;

export function createGenerationWorkerApplication(
  dependencies: Readonly<{
    claims: GenerationClaimRepository;
    executor: GenerationExecutor;
  }>,
): GenerationWorkerApplication;
```

The split is a checkpoint boundary, not just naming. Task 10b implements one
complete PostgreSQL `GenerationCommandRepository` without claiming support.
Task 10d separately implements `GenerationClaimRepository`; neither adapter may
ship a throwing placeholder for methods owned by the other checkpoint. The two
factory signatures above are frozen in 10a and are the construction APIs that
Tasks 10c and 10e must consume.

Do not represent snake-case SQL rows as application types: the PostgreSQL
adapter performs that translation.

**`ClaimedGeneration` is a minimal application claim — decided 2026-08-03.**
An earlier revision described it only in prose as "every field currently
consumed by `executeGenerationJob`", which is not implementable under 10a's
contracts-only dependency rule. The existing `ClaimedJob`
(`services/api/src/generation-service.ts:143-170`) is 22 snake-case fields whose
nested types are unreachable from `packages/application`: `PromptSnapshot` lives
in `services/api`, `OrchestrationPrivate` is module-local to
`generation-service.ts:333` and depends on `PrivateRollResolution` and
`ActivatedEvent` from `packages/story-engine` — which is not a workspace package
and imports `node:crypto` and `node:net`. Only `MemoryContextQuery` is
barrel-reachable today.

The claim therefore carries only what application policy decides with:

```ts
type ClaimedGenerationBase = {
  jobId: string;
  ownerUserId: string;
  campaignId: string;
  providerProfileId: string;
  expectedTurnNumber: number;
  attempts: number;
};

export type ClaimedGeneration =
  | Readonly<ClaimedGenerationBase & {
      operationKind: "append";
      replacementTurnId: null;
    }>
  | Readonly<ClaimedGenerationBase & {
      operationKind: "replace_latest";
      replacementTurnId: string;
    }>;
```

This is the same durable provenance invariant already enforced on generation
requests, polling snapshots, SSE snapshots, recovery, and client runs. Add
compile-time assertions that accept append/null and replace-latest/UUID-shaped
values and reject append/UUID plus replace-latest/null. Do not weaken the union
with optional fields or casts in factories, fakes, or adapters.

- [x] Keep `promptSnapshot`, `contextOptions`, `orchestrationPrivate`,
  `baseStatePrivate`, `baseTurnNumber`, `requestedModel`, the input-mode trio,
  `promptProtocolVersion`, and `streamingSegmentsState` **out** of the
  application port. They are execution-internal payloads, not application
  decisions. `orchestration_private` in particular is checkpoint state the
  executor merges and writes back mid-run
  (`generation-service.ts:1393-1402`); it must stay on the side that mutates it.
- [x] Accept the tradeoff deliberately: the executor adapter performs **one
  additional guarded read** to load the execution payload after `claimNext`
  returns. It must match `jobId`, `ownerUserId`, `workerId` as the current lease
  owner, and status `assessing`. This is not a second claim and must not re-run
  `FOR UPDATE SKIP LOCKED`, increment attempts, or reassign the lease. A missing
  match is cancellation or lost lease and must stop before provider loading.
  Record the read in 10d's SQL inventory.
- [x] Do not "solve" this by making `packages/application` depend on
  `story-engine`, or by hand-copying its types into the application package.
  The first pulls Node modules into an implementation-free package; the second
  reintroduces the unguarded duplication that Task 5a existed to remove.

**Move the `PromptSnapshot` type to contracts** as part of 10a. It is a
one-line type whose only dependency, `PromptTemplateKey`, is already in
`packages/contracts/src/prompt-library.ts`, so the move adds no new dependency:

- [x] Move `export type PromptSnapshot` from
  `services/api/src/prompt-library-service.ts` into
  `packages/contracts/src/prompt-library.ts`. Leave `resolvePromptSnapshot` in
  `services/api` — it needs `pg` and stays an adapter. Do not re-export the type
  from `prompt-library-service.ts`; that would preserve the wrong ownership and
  permit future runtime code to import the API adapter for a shared type.
- [x] Update every current direct consumer:
  `prompt-library-service.ts`, `generation-service.ts`,
  `turn-intent-service.ts`, `infinite-worlds-import-service.ts`, and
  `tests/unit/prompt-library.test.ts`. Add a public-barrel type assertion so a
  future runtime adapter can import `PromptSnapshot` through
  `@infinite-quest/contracts` without a deep source path.
- [x] Run `tests/unit/prompt-library.test.ts` after the move. Its hash/version
  assertions must pass unchanged; this is a type-ownership move, not a prompt
  protocol or runtime behavior change.
- [x] The application never references this type. It is moved so that 10d's
  executor adapter, which lives in `services/runtime`, does not have to import a
  type back out of `services/api` after execution has been moved out of the API
  role. The boundary scanner would not catch that import — it only checks
  `services/api` against `services/worker` (`check-client-boundaries.mjs:211`) —
  so this is a design rule, not a checkable one.
- [x] `packages/contracts/src/story-settings.ts` is not re-exported from the
  contracts barrel, so `StoryLengthProfile` is only reachable by deep relative
  import. No 10a work depends on it under this decision; fix it in the
  checkpoint that first needs it through the package name, not speculatively.

`ClaimedGeneration.ownerUserId` is required. Worker execution authority comes
from the durable claimed row, not from `initial-owner` lookup and never from an
HTTP field. The pre-auth initial owner is an API request authority resolved by
server-side composition and passed in `OwnerScope`; it is not a worker-wide
identity shortcut.

Do not put `AbortSignal` on `GenerationExecutor` in B1. Existing shutdown stops
new scheduling and drains the active generation; it does not cancel a claimed
job. `runWorker` continues to own its scheduler signal. Task 12 may introduce a
separate bounded-drain policy only with explicit job-state and lease semantics.
The credential encryption secret is also adapter-bound runtime configuration,
not an application command field.

Define a `GenerationApplicationError` with a closed internal `kind` union for
not-found, conflict, invalid-state, stale-turn, provider-required, and active-job
conditions. It must contain safe structured data only and must not contain an
HTTP status or a raw provider/database error. Task 10c owns the exact mapping
back to the existing HTTP status, message, and safe `details` payload.

**Test-first requirements:**

- [x] Test `createGenerationApplication` with a fake
  `GenerationCommandRepository`; cover all seven command/query methods and
  prove arguments and return values are forwarded without mutation.
- [x] Test `createGenerationWorkerApplication` with separate fake
  `GenerationClaimRepository` and `GenerationExecutor` adapters; cover
  `claimNext` and `executeClaimed`, prove each call reaches only its owning
  adapter, and prove arguments and return values are forwarded without
  mutation. Do not use a combined fake that could conceal an accidental
  combined production port.
- [x] Prove owner and campaign/job scope cannot be omitted and that a claimed
  job's owner survives into `executeClaimed`.
- [x] Prove typed repository errors remain typed application errors and unknown
  adapter failures are not rewritten into a misleading domain condition.
- [x] Add a package-boundary fixture or scanner assertion that rejects imports
  from `services/**`, Fastify, `pg`, Node-only scheduling modules, and concrete
  provider adapters.
- [x] Run the application package check and focused unit test red before adding
  the minimal implementation, then run both green.

**10a review gate:** package direction and type completeness are approved; no
production route, SQL query, worker loop, or public payload has changed.

**Status: complete (2026-08-03).** This completes the 10a checkpoint only;
Task 10/B1 remains `Not started` until 10f passes, as required by the
checkpoint policy.

**10a evidence:** implementation landed in `390d7c2`, with boundary corrections
in `bdeca667`, `3bf04e1`, and `5289bf3` (base `885bcde`). The application
package has no runtime role dependencies, generation command and claim ports are
separate, and `PromptSnapshot` is now contracts-owned. The application unit test
was observed red before its package existed and the focused suite subsequently
passed; a separate pre-package `pnpm --filter @infinite-quest/application check`
red run was not meaningful because that workspace project did not yet exist.
Final verification passed: application package check, client-boundary check,
`pnpm check`, `pnpm build`, `pnpm test:unit`, `pnpm test:integration`,
`git diff --check`, and `pjm precheck`. One full scoped review plus three
correction re-reviews passed. The scanner coverage now includes direct,
type-only, re-export, CommonJS, dynamic/import-type, non-literal, and
triple-slash reference forms.

**10a checklist audit (2026-08-03).** The items were left unticked because the
commit titled "record Task 10a completion" expanded this substage's
specification — adding the three ripple-effect consumers, naming
`isApplicationImportAllowed`/`checkApplication`, and pinning the package
tsconfig — rather than marking what it satisfied. All fourteen were then
verified against the shipped code and ticked. Re-measured on `736e197`:
`pnpm check` 557 candidate files, `pnpm build` clean, `pnpm test:unit`
**1018/1018 across 87 files**, `pnpm test:integration` **193 passed, 2 skipped
across 17 files**.

Verified specifically:

- `ClaimedGeneration` implements the 10a decision and tightens it: rather than a
  flat `replacementTurnId: string | null`, it is an `operationKind`-discriminated
  union matching the 7P and 13a-R pattern.
- Every payload the decision excluded is absent from the application types —
  `promptSnapshot`, `contextOptions`, `orchestrationPrivate`, `baseStatePrivate`,
  `streamingSegmentsState`, `requestedModel`, and `promptProtocolVersion` each
  appear zero times — and no application module references `PromptSnapshot`.
- The boundary predicate was mutation-tested at correct relative depths:
  `story-engine`, `database`, `logger`, `services/**`, Fastify, `pg`, `node:*`,
  and **deep-relative access to contracts** are all rejected, while the package
  name and intra-package paths are allowed. The three correction commits close
  dynamic-import, `require`, `import type`, and `@ts-ignore` bypasses.
- Task 10's top-level status correctly remains `Not started`; the substage rule
  that prevents a half-migrated boundary reading as B1 complete was honored.

### Task 10b — B1b: Move PostgreSQL command and query behavior

**Purpose:** implement the API-facing `GenerationCommandRepository` without
changing the current Fastify call sites. This isolates the most
concurrency-sensitive SQL before route adaptation.

**Files:**

- Create: `packages/database/src/generation-repository.ts`
- Create: `services/api/src/generation-command-compatibility.ts`
- Create: `tests/integration/generation-repository.integration.test.ts`
- Create: `tests/unit/generation-command-compatibility.test.ts`
- Modify: `packages/application/src/generation/errors.ts` — narrowly extend the
  frozen 10a error detail contract only where the existing command behavior
  cannot otherwise retain its HTTP semantics; do not change the command port
  method signatures or add execution/claim methods
- Modify: `tests/unit/application/generation-use-cases.test.ts` — compile-time
  and forwarding coverage for the corrected typed-error details
- Modify: `packages/database/src/index.ts`
- Modify: `services/api/src/generation-service.ts`
- Test: `tests/unit/generation-input.test.ts`
- Test: `tests/integration/generation.integration.test.ts`
- Test: `tests/integration/gameplay.integration.test.ts`
- Test: `tests/integration/image-pipeline.integration.test.ts`

**Scope:** move or delegate only these current behaviors:

```text
enqueueGeneration          -> enqueueAppend
enqueueLatestReplacement   -> enqueueReplacement
getGenerationJob           -> getJob
getGenerationResult        -> getResult
retryGeneration            -> retry
cancelGeneration           -> cancel
discardGeneration          -> discard
```

`syncPlayerCampaignConfig`, `rewindCampaign`, `branchCampaign`, prompt/context
helpers, claim/execution, and other campaign operations are not silently pulled
into this checkpoint. They remain in place until their owning checkpoint or
Task 14 domain extraction.

**Required construction and compatibility design:**

`packages/database` is a source package rather than an independently installed
workspace package, and the repository root does not resolve
`@infinite-quest/application` at runtime. The PostgreSQL adapter therefore
imports the application public barrel by a relative `.js` specifier and uses a
type-only import wherever possible. It must not introduce a root dependency,
workspace package manifest, path alias, or runtime import that would make the
compiled `dist/` layout resolve TypeScript source through Node.

Export this exact construction API from
`packages/database/src/generation-repository.ts` and the database barrel:

```ts
export type PostgresGenerationCommandRepositoryDependencies = Readonly<{
  resolvePromptSnapshot: (
    client: DatabaseClient,
    ownerUserId: string,
    campaignId: string,
  ) => Promise<PromptSnapshot>;
  promptProtocolVersion: (snapshot: PromptSnapshot) => string;
  readTurnReportedCosts: (
    ownerUserId: string,
    turnIds: readonly string[],
  ) => Promise<ReadonlyMap<string, GenerationResult["reportedCost"]>>;
}>;

export function createPostgresGenerationCommandRepository(
  pool: DatabasePool,
  dependencies: PostgresGenerationCommandRepositoryDependencies,
): GenerationCommandRepository;
```

The dependency object is deliberate inversion of control, not a generic
service locator. `generation-repository.ts` may call only the three named
functions above. The temporary API compatibility module supplies
`resolvePromptSnapshot`, `promptProtocolVersion`, and `turnReportedCosts` from
the existing API helpers. The PostgreSQL module must never import
`services/api/**`, and the injected callbacks must never receive an HTTP
request, Fastify object, credential secret, or unscoped `user_id`.

The repository owns the text-provider selection query, turn-input
classification transaction, row mapping, SQLSTATE mapping, and every command
transaction. It may directly import pure domain/story-engine helpers needed for
request fingerprinting, narration formatting, or partial-narration extraction.
It must not duplicate the API helper SQL for prompt snapshots or reported costs,
and it must not call an API helper that performs an ownership lookup or starts
its own transaction.

`generation-command-compatibility.ts` is the only temporary bridge. Export a
factory that receives `{ pool, repository, initialOwnerId }`, resolves the
server-side initial owner for each legacy call, calls the repository with an
explicit `OwnerScope`, and exposes the seven legacy function shapes used by
`generation-service.ts`. `enqueueGeneration` and
`enqueueLatestReplacement` retain the existing `safeTurnInput` preflight in
this bridge; this lexical browser-input validation is intentionally not moved
into the database adapter during 10b. The bridge catches only
`GenerationApplicationError`, maps it to the current safe HTTP-facing
`Error` shape, and rethrows unknown errors unchanged. Do not instantiate a
repository in a route or inside an individual delegate. Task 10c reuses this
single mapping table while moving construction to the API composition root;
it must not create a second, divergent error mapper.

Before moving SQL, make the minimal 10a error-contract correction necessary to
represent the existing command outcomes without attaching HTTP fields to
`GenerationApplicationError`. Add a closed, safe `reason` discriminator to
`GenerationApplicationErrorDetails` for:

```text
idempotency_mismatch
explicit_input_mode_mismatch         classification_id_forbidden
classification_missing_or_expired    classification_mode_mismatch
selected_provider_unavailable        no_text_provider
stale_current_turn                   missing_latest_turn
active_generation                    active_illustration
result_not_completed                 retry_source_state
cancel_source_state                  discard_source_state
```

Also add only the safe payload fields needed by the existing response behavior:
`pendingGeneration`, `expectedTurnNumber`, `actualTurnNumber`, and
`generationStatus`. `pendingGeneration` is not an enqueue response; define it
as exactly `Readonly<{ id: string; status: GenerationJobStatus["status"]; action:
string; operationKind: "append" | "replace_latest"; expectedTurnNumber: number
}>`, matching the active-job lookup without exposing its replacement target,
provider, timestamps, recovery metadata, or error fields. Do not place an HTTP
status, raw `Error`, SQLSTATE, stored provider error text, prompt content, or
query row in the typed error. The application use-case tests must prove that the
additional fields remain readonly and that unknown adapter errors are still
re-thrown unchanged. This is a focused 10a contract correction committed as the
first 10b commit; record its base/head and review it before moving SQL.

The compatibility mapper must preserve these legacy outcomes until 10c adopts
the same table: unsafe input, action-only campaigns, an Auto classification ID
on an explicit request, explicit input-mode mismatch, a missing Auto
classification ID, and selected-provider validation return 400; missing
campaign/job/latest turn returns 404; missing/expired/consumed or input-hash
incompatible Auto classifications, Auto classification mode mismatch, stale
turn, idempotency mismatch, missing default provider, active generation, active
illustration, incomplete result, and invalid retry/cancel/discard source states
return 409. Preserve the existing `active_generation_exists` safe details with
the pending job projection. For a failed, recoverable, cancelled, or discarded
result, use the fixed public generation-failure message rather than forwarding
`generation_jobs.error_message`. The test fixture must assert the status,
message, and safe detail object for every reason above before and after
delegation.

**Repository requirements:**

- [x] Implement every `GenerationCommandRepository` method and no claim or
  execution method. The adapter must satisfy the frozen interface without a
  throwing placeholder for `claimNext`; Task 10d owns the separate
  `GenerationClaimRepository`.
- [x] Accept an explicit `ownerUserId` on every API-facing method. Remove
  `initialOwnerId(pool)` from repository code; the adapter never chooses an
  identity. The compatibility bridge—not the repository—performs the current
  initial-owner lookup until Task 10c injects server authority directly.
- [x] Preserve the append enqueue transaction, campaign `FOR UPDATE`, request
  fingerprint, savepoint/rollback around the unique insert, active-job lookup,
  and exact idempotency conflict behavior. Never query inside a transaction
  left aborted by SQLSTATE `23505`.
- [x] Preserve replacement enqueue's campaign and latest-turn locks, immutable
  `replacementTurnId`, current-turn guard, base state/edit selection, prompt
  snapshot, queued-image cleanup, active-image conflict, and
  `replacement_queued` state. Before its `INSERT INTO generation_jobs`, create
  `SAVEPOINT enqueue_replacement_insert`; on SQLSTATE `23505`, execute
  `ROLLBACK TO SAVEPOINT enqueue_replacement_insert` before reading the active
  job and raising the typed active-job conflict. Release the savepoint on the
  success path and after rollback. This fixes the existing replacement path's
  aborted-transaction (`25P02`) hazard without changing its observable conflict
  response.
- [x] Preserve job/result projections, partial narration derivation, formatted
  narration, reported-cost lookup, and completed-result guard. The repository
  continues to return the frozen internal `GenerationJobStatus`, including
  `partialOutput`, only to the server-side compatibility bridge. The existing
  `generationSnapshot` and `generationStreamSnapshot` projections remain the
  sole public boundary and must continue to omit raw `partialOutput` and raw
  stored errors; no new field is added to either wire response.
- [x] Preserve retry's prompt-protocol refresh and append/replacement requeue
  state exactly as the legacy method does: set `prompt_protocol_version` to
  `STORY_PROMPT_PROTOCOL_VERSION`, do not refresh `prompt_snapshot` in 10b, and
  do not change the requested model or idempotency data. Preserve cancellation
  idempotency and provisional illustration cleanup, plus discard's allowed
  source states.
- [x] Keep all joins and writes owner-scoped. A known job UUID owned by another
  user must behave as not found and must not reveal campaign, state, turn,
  provider, illustration, or error metadata.
- [x] Translate database rows and SQLSTATE values into application types/errors
  at this boundary. Do not leak `pg` result types, snake-case rows, SQLSTATE, or
  mutable query objects into `packages/application`.
- [x] Introduce no schema migration and no rewritten query solely for style.
  If an unavoidable query change is required, record the old/new statement,
  query plan, locking impact, and rollback in the checkpoint evidence.

**Required integration cases:**

- [x] Append and replacement happy paths, duplicate replay, mismatched
  idempotency fingerprint, and two concurrent append attempts for one campaign.
- [x] Two concurrent replacement attempts with different idempotency keys reach
  one durable replacement job and one typed active-job conflict, never SQLSTATE
  `25P02`. Repeat the test with the same idempotency key and prove its replay
  result remains deterministic. Assert that the failed contender leaves no
  queued-image cleanup or other partial mutation after its outer transaction
  rolls back.
- [x] Stale replacement turn, missing latest turn, active illustration, and
  queued-image cleanup.
- [x] Build two active user fixtures without swapping either user's
  `initial-owner` system key. Invoke the repository directly with explicit
  scopes and prove Owner A cannot read, retrieve a result for, retry, cancel,
  or discard Owner B's known job UUID; repeat for two campaigns owned by A. All
  foreign/mismatched-scope cases must return the typed not-found condition and
  leave the target row unchanged.
- [x] Retry, repeated cancellation, cancellation from `queued`,
  `replacement_queued`, `assessing`, `generating`, `validating`, and
  `committing`, discard, and invalid terminal-state mutations preserve accepted
  turns, campaign state, Chronicle memory, valid result data, and safe error
  projection. Include provisional image jobs, segment assets, prompt jobs,
  resolution jobs, and sets so the cancellation cleanup remains complete and
  idempotent.
- [x] Direct repository tests cover all seven methods; compatibility tests cover
  the legacy function signatures, initial-owner lookup, every typed-error
  reason, unknown-error pass-through, and unchanged HTTP-safe error shape.
  Re-run `generation-input.test.ts`, `generation.integration.test.ts`,
  `gameplay.integration.test.ts`, and `image-pipeline.integration.test.ts`;
  those suites currently import the temporary delegates and prove that 10b did
  not move claim/execution or illustration behavior by accident.
- [x] Each atomic command retains its original repository-owned transaction;
  read-only queries do not create unnecessary transactions, and no method
  commits or rolls back outside the unit of work it owns. Instrument the
  repository test pool or inspect recorded SQL to prove `getJob` and `getResult`
  do not issue `BEGIN`, append and replacement use one outer transaction plus
  their insert savepoint, cancellation uses one outer transaction, and retry /
  discard retain their single-statement behavior.

Keep temporary compatibility exports in `generation-service.ts` only as thin
delegates imported from `generation-command-compatibility.ts`; remove the seven
command/query SQL implementations from that file. `runGenerationJob`, claim,
execution, `syncPlayerCampaignConfig`, rewind, branch, and prompt/context
helpers remain in place. Mark command/query delegate removal owner as 10c and
the execution/claim removal owner as 10e; do not duplicate SQL or typed-error
mapping between the facade and repository.

**10b review gate:** SQL, locks, savepoints, ownership predicates, public
projections, error semantics, and safe error payloads match the pre-10b
generation integration baseline, except that replacement unique-conflict
recovery now deterministically returns its existing 409 rather than leaking
`25P02`. No route or worker import has changed yet. The reviewer must inspect
the full 10b range, confirm the PostgreSQL adapter has no `services/api/**`
import, and verify the compatibility mapper is the only temporary legacy-error
translation point.

**10b evidence (audited 2026-08-03, re-measured after correction round 2).**
Implementation landed in `3ee033d` with corrections in `93113bc`, `7933c3a`,
`2e6901e`, `bb29eeb`, `d778043`, and `29f0376` (base `e199f47`). The original
correction review found two Important defects, and a later stricter review
expanded the needed proof. The completed correction-round-2 coverage below
passed a fresh scoped review.

Final measurement on `29f0376`: `pnpm check` **561 candidate files**,
`pnpm build` clean, `pnpm test:unit` **1076/1076 across 88 test files**,
`pnpm test:integration` **214 passed, 2 skipped across 18 test files**. An
earlier audit of this substage recorded 1040/1040 and 211/2 at `bb29eeb`; those
figures are historical and were superseded by the correction rounds, which added
36 unit and 3 integration tests.

**The correction that mattered most.** Replacement enqueue originally performed
its unique-conflict replay read *inside* the still-open transaction, after
`ROLLBACK TO SAVEPOINT`. That transaction still held the campaign and
latest-turn `FOR UPDATE` locks, and the competing winner's committed row was not
reliably visible from inside it. `d778043` throws a `ReplacementInsertUniqueConflict`
sentinel instead, lets the transaction close, and replays against the pool.
`29f0376` then added the proof that a losing replacement's pre-insert
side effects — queued-image cleanup and Auto-classification consumption — roll
back rather than persisting. An earlier audit of this substage confirmed the
savepoint existed and that no query ran inside an *aborted* transaction, which
was true and insufficient: the transaction here was recovered, not aborted, and
the defect was lock-scope and visibility rather than abort state.

Verified against the shipped code rather than the commit messages:

- All seven behaviors are on `packages/database/src/generation-repository.ts`,
  and `initialOwnerId` appears **zero** times in it — the adapter never chooses
  an identity. The five remaining occurrences in `generation-service.ts` are on
  the facade path that 10c removes.
- Append and replacement both use `SAVEPOINT` with `ROLLBACK TO SAVEPOINT` on
  SQLSTATE `23505`, so no query runs inside an aborted transaction. Five
  `FOR UPDATE` locks are retained.
- No SQLSTATE, `pg` type, or snake-case row reaches `packages/application`.
- `services/api/src/server.ts`, `services/worker/**`, and
  `services/runtime/**` remain untouched in this range, and no migration was
  added.
- `partialOutput` remains an internal field of the pre-existing
  `GenerationJobStatus` projection with `partialNarration` derived from it; it
  is not a *new* public field, and the API-layer projections still strip it.
- The initial suite covers same-key replacement replay, repeated cancellation,
  and all six cancellable phases, but it did not yet prove every persistence
  invariant below.

**10b correction round 2 — required before Task 10c.** The fresh review of
`2e6901e..8677fb8` found that the existing assertions were insufficient even
though the initial implementation was behaviorally close. Do not advance the
checkpoint or treat the earlier evidence as completion until every item below is
checked and independently re-reviewed.

- [x] **Atomic lifecycle logging:** make retry and cancel obtain their
  owner-scoped logging context before the repository mutation (or return it from
  that mutation atomically). A context-read failure must leave the durable job
  unchanged and return the existing failure path; it must never turn a committed
  retry/cancel into a 5xx. Preserve the legacy `jobAttempt` value for retry and
  the established cancellation log shape. Add a unit regression that proves the
  context read happens before the mutation and that a failed read performs no
  repository mutation.
- [x] **Replacement idempotency and rollback proof:** add a direct repository
  case where a replacement reuses its idempotency key with a different request
  fingerprint and receives `idempotency_mismatch`. In the distinct-key concurrent
  replacement race, create a queued latest-turn image before both submissions and
  prove the losing transaction leaves that image and every other pre-savepoint
  durable row intact after its outer transaction rolls back; the winner alone may
  perform queued-image cleanup.
- [x] **Mutation preservation and child cleanup:** retry, discard, and every
  cancellation state must assert that accepted turns, campaign state, Chronicle
  memory, completed-result rows, and valid result data are unchanged. Extend the
  provisional-child fixture to include an actual segment asset plus its asset
  reference, then prove cancellation removes or cancels every target child while
  retaining the other campaign's equivalent records.
- [x] **Strict transaction instrumentation:** replace presence-only SQL checks
  with exact per-command boundary assertions. `getJob`/`getResult` issue no
  `BEGIN`, `COMMIT`, or `ROLLBACK`; append/replacement issue exactly one outer
  `BEGIN`/`COMMIT` and their named insert savepoint; cancellation issues exactly
  one outer transaction; retry and discard issue neither an outer transaction
  nor more than their single statement. Record the statements per operation so
  earlier fixture setup cannot satisfy the assertion.
- [x] Re-run the focused unit and real-PostgreSQL repository suites, then the
  full required Task 10b verification matrix. Have a fresh reviewer inspect the
  correction diff and approve the full `e199f47..HEAD` 10b range before marking
  this checkpoint complete.

**10b correction round 2 status — complete (2026-08-03).** `d778043` moved
retry/cancel lifecycle-context reads before their mutations and made replacement
unique-conflict recovery roll back the entire outer transaction before replay or
active-job lookup. The repository regression now creates an initially failed
competitor, pauses the loser after its queued-image cleanup and Auto
classification consumption, then transitions the competitor to `queued` before
releasing the barrier; this proves a late concurrent unique conflict restores
all pre-savepoint work through the full outer rollback. The compatibility table
now drives every applicable typed error through every applicable `withOwner`
delegate, preserving its production kind and legacy HTTP-safe status, message,
and details. Verification passed: `pnpm check`, `git diff --check`, focused
compatibility units (57 tests), real PostgreSQL repository coverage (21 tests),
`generation-input` (2 tests), and the required generation/gameplay/image
integration suites (67 passed, 2 skipped). A fresh scoped review found no
Critical, Important, or Minor findings and approved Task 10b. Task 10c remains
pending.

**Carried into 10c — the compatibility bridge has no removal owner.** 10b
introduced `services/api/src/generation-command-compatibility.ts` and its
224-line test as the temporary facade. The 10b specification requires marking
"their removal owner as 10c/10e", and that marking had not been made; 10c's file
list and requirements now name it. Left unowned, the bridge would survive as a
permanent shadow layer between routes and the repository, which is exactly what
10c's own "do not leave two callable implementations" rule forbids.

### Task 10c — B1c: Convert Fastify generation routes to application adapters

**Purpose:** make HTTP handlers validate requests, establish server authority,
call `GenerationApplication`, and project the existing response. Fastify must
not contain generation state-machine or SQL policy.

**Files:**

- Create: `services/api/src/generation-application-adapter.ts`
- Create: `tests/unit/generation-application-adapter.test.ts`
- Modify: `services/api/src/generation-diagnostics.ts` — 10c2 exports a
  read-only membership predicate over the private diagnostic error-code set;
  the mutable set itself remains private
- Test: `tests/unit/generation-diagnostics.test.ts` — 10c2 proves the new
  predicate accepts the adapter's safe code and rejects an arbitrary code
- Create: `services/runtime/src/generation-api-composition.ts` — constructs the
  API-role `GenerationApplication` from the PostgreSQL command repository and
  its three already-approved injected callbacks
- Create: `tests/unit/runtime-generation-composition.test.ts` — verifies that
  the real API composition creates the application without running a command
- Create: `tests/helpers/build-server-options.ts` — test-only `serverOptions()`
  factory so the 50 test `buildServer(` calls convert through one helper
- Create or relocate: `services/api/src/turn-input-safety.ts` — one shared
  mechanics-language guard used by both the new route adapter and the still-live
  execution path until Task 10d moves execution
- Create: `services/api/src/generation-route-lifecycle.ts` — transport-layer
  lifecycle context reader/logger used only by retry and cancel handlers; it
  keeps PostgreSQL and logging out of the pure 10c2 application adapter
- Create: `tests/unit/generation-route-lifecycle.test.ts` — proves the
  owner-scoped pre-mutation read and exact retry/cancel log fields
- Delete: `services/api/src/generation-command-compatibility.ts` — the temporary
  10b facade; 10c is its named removal owner
- Delete: `tests/unit/generation-command-compatibility.test.ts` — after
  re-homing its `safeTurnInput` and logging-context coverage
- Modify: `services/api/src/server.ts`
- Modify: `services/api/src/generation-service.ts`
- Modify: `services/runtime/src/main.ts`
- Test: `tests/unit/client-api-contracts.test.ts`
- Test: `tests/unit/client-api-routes.test.ts`
- Test: `tests/unit/server-security.test.ts`
- Test: `tests/unit/generation-input.test.ts`
- Test: `tests/unit/user-profile.test.ts`
- Test: `tests/integration/campaign-archive.integration.test.ts`
- Test: `tests/integration/dashboard-stats.integration.test.ts`
- Test: `tests/integration/generation.integration.test.ts`
- Test: `tests/integration/gameplay.integration.test.ts`
- Test: `tests/integration/image-pipeline.integration.test.ts`
- Test: `tests/integration/provider-routes.integration.test.ts`

### 10c delivery stages and checkpoints

10c is the largest checkpoint in Task 10: a required-field change across 52
invocations, a full route conversion, an error-mapping port, and the bridge removal
with two responsibilities to re-home. Its review gate is **contract parity**, so
composition churn must not dominate the diff a reviewer reads for parity.

It is delivered as **three ordered sub-checkpoints**, each its own commit and
scoped review. The requirements below remain one specification and are not
split; what splits is the work.

| Stage | Contains | Character | Ends with |
|---|---|---|---|
| **10c1 — plumbing** | required `generation` field, exported `BuildServerOptions`, API composition factory, `serverOptions()` helper, 50 test calls and 2 runtime calls converted | mechanical; **zero behaviour change** | routes still call the 10b facade; the injected application is constructed and unused |
| **10c2 — adapter** | `generation-application-adapter.ts` with the frozen seven-method route-facing contract, explicit owner scope, application calls, ported reason-level error mapping, and diagnostic-code predicate; directly unit-tested against a fake application | purely additive; no route or live-facade change | adapter exists and is fully tested; routes still on the facade; bridge and its tests remain unchanged and live |
| **10c3 — cutover** | routes switched to the adapter, bridge deleted, `safeTurnInput` and lifecycle logging re-homed, `image-pipeline` usage re-homed, compatibility-owned authority lookup removed | the parity-sensitive diff | the 10c review gate |

- [x] Land them in order. 10c1 must change no response and 10c2 must delete
  nothing, so that by the time a reviewer reads the parity-sensitive diff in
  10c3 it contains only the cutover.
- [x] **10c1 ends green with the injected application unused.** That is
  intentional, not an oversight: it proves the composition root can construct
  the application and that all 52 invocation sites are converted, at zero
  contract risk. Do not count `buildServer`'s declaration as a call site.
  Do not "improve" 10c1 by switching a route to it.
- [x] **Port the error mapping in 10c2; delete the bridge in 10c3.** The bridge
  is the only implementation of that mapping. Deleting it in the same commit
  that ports it would leave no reviewable moment where both exist and can be
  compared.
- [x] **Keep 10c2 additive and unreachable from HTTP.** It may create the
  adapter and its tests and add the diagnostic-code membership predicate, but
  it must not modify `server.ts`, `generation-service.ts`, the compatibility
  bridge, or the bridge's tests. `buildServer` must continue accepting the
  injected application without using it, and every production route must still
  call the 10b facade until 10c3 performs the atomic cutover.
- [x] Do not split 10c3 further. The route switch, the bridge deletion, and the
  re-homing are one atomic parity change; a checkpoint between them leaves
  either two callable implementations or a route whose validation guard has
  moved out from under it.

**10c3 frozen composition and lifecycle seam:** `buildServer` constructs one
`GenerationApplicationAdapter` from its injected `generation` application.
Each of the eight generation handlers (seven non-streaming plus SSE) resolves
`{ ownerUserId: await initialOwnerId(pool) }` inside the server, parses the UUID
and body with the existing schemas, and passes that scope to the adapter. The
adapter factory frozen in 10c2 remains exactly
`createGenerationApplicationAdapter(application)` and must remain free of pool,
logger, Fastify, and owner-resolution dependencies.

`generation-route-lifecycle.ts` owns the compatibility side effect that cannot
fit in that pure adapter. Export a `GenerationLifecycleLogContext` with the
existing job/campaign/provider/expected-turn/operation/attempt fields and a
factory whose dependencies are an owner-scoped context read plus `info`
logger. Retry and cancel handlers must read context **before** calling the
application adapter, call the application exactly once, and log only after the
mutation succeeds. Preserve `turn_generation_requeued` with the full context
and `turn_generation_cancelled` with generation job, campaign, and operation
kind. A context-read failure prevents the mutation; a mutation failure emits no
success log. This module is transport diagnostics, not a second command facade.

Move `safeTurnInput` and its existing `unsafe_turn_input` error shape into
`turn-input-safety.ts`. Both enqueue handlers call it before the application;
the still-live execution path imports the same function until 10d moves that
path. Update `generation-input.test.ts` to import the shared module directly so
deleting the bridge and its re-export cannot silently remove defense-in-depth
coverage.
- [x] Each stage records its own evidence with measured figures, per the Task 4a
  P4 rule. Keep Task 10's top-level status `Not started` throughout.

**10c1 evidence (2026-08-03): complete.** `c23be50` exports the required
`BuildServerOptions`, injects a deliberately unused real application through
both API-role runtime paths, and adds the isolated composition factory plus
its typed construction proof. Exactly 52 `buildServer` invocations are now
explicit: 50 test calls (29 + 12 + 5 + 1 + 1 + 1 + 1) use the test-only
`serverOptions({ config, pool })` helper and the two `api`/`all` runtime calls
receive the real application; `worker` and `migrate` construct none. The new
composition test passed (1 test), the converted focused suite passed (50 tests;
42 database integration cases correctly skipped without a database URL), and
`pnpm check`, full `pnpm test:unit`, full `pnpm test:integration`,
`git diff --check`, and `pjm precheck` passed. An independent Task 10c1 review
approved the full diff with no Critical, Important, or Minor findings. Task 10
remains `Not started`; 10c2 is complete and independently reviewed, while 10c3
is still pending.

**10c1 checklist audit (2026-08-03).** The six items were verified against the
shipped code and ticked. Re-measured independently: `pnpm check` **564 candidate
files**, `pnpm build` clean, `pnpm test:unit` **1077/1077 across 89 test files**,
`pnpm test:integration` **214 passed, 2 skipped across 18 test files**.

- The zero-behaviour-change property holds literally. The entire
  `services/api/src/server.ts` diff is three changes: the type import, the
  exported field, and destructuring `generation: _generation` so it is
  deliberately unused. No route logic moved.
- `serverOptions()` supplies an **inert** application whose every method throws.
  That is stronger than a silent stub: it turns "a route accidentally uses the
  application during 10c1" from an invisible regression into a loud failure.
- `createApiGenerationApplication(pool)` performs no query during construction,
  proved by `runtime-generation-composition.test.ts` asserting `query` is never
  called — so injecting it cannot have started database work at startup.
- Count correction carried from an earlier revision of this plan: there are
  **52 `buildServer` invocations across 8 files**, not 53 across 9. A naive
  `buildServer(` grep also matches the declaration in `server.ts`. The 10c1
  evidence figures were already correct; the staging table has been aligned.

**Composition and authority requirements:** *(10c1 unless marked otherwise)*

- [x] Call `createGenerationApplication(commandRepository)` once at the
  runtime/API composition boundary and inject the returned
  `GenerationApplication` into `buildServer`; tests may inject a fake. Do not
  instantiate repositories or factories inside individual route handlers.
- [x] **Make `generation` a required field and export the options type —
  decided 2026-08-03.** `BuildServerOptions` is currently unexported. There
  are **52 `buildServer(` invocations**: 50 test invocations across 7 files and
  2 API-role invocations in `services/runtime/src/main.ts`; the declaration in
  `server.ts` is not a call site. `tests/unit/server-security.test.ts` alone
  holds 29 and `tests/unit/client-api-routes.test.ts` 12. A required field is
  what lets 10f prove that no route path constructs a repository, so the churn
  is accepted rather than avoided.

  ```ts
  export type BuildServerOptions = {
    config: RuntimeConfig;
    pool: DatabasePool;
    generation: GenerationApplication;
  };
  ```

- [x] Add `tests/helpers/build-server-options.ts` exporting the following
  test-only helper. `config` and `pool` deliberately remain required: this
  repository has no safe universal test defaults for them. Only `generation`
  receives a default inert fake because 10c1 must not call it.

  ```ts
  export type ServerOptionsOverrides = Readonly<
    Pick<BuildServerOptions, "config" | "pool"> &
    Partial<Pick<BuildServerOptions, "generation">>
  >;

  export function serverOptions(overrides: ServerOptionsOverrides): BuildServerOptions;
  ```

  Convert the 50 test calls to `buildServer(serverOptions({ config, pool }))`.
  The 2 runtime calls must not import this test helper: they pass the real
  application constructed below. The helper must not be imported by
  `services/**`.
- [x] **Construct the real application once per API-role process.** Create
  `services/runtime/src/generation-api-composition.ts` with an exported
  `createApiGenerationApplication(pool: DatabasePool): GenerationApplication`.
  It must call `createGenerationApplication(createPostgresGenerationCommandRepository(pool, dependencies))`
  using exactly the existing callback wiring:

  ```ts
  {
    resolvePromptSnapshot,
    promptProtocolVersion,
    readTurnReportedCosts: (ownerUserId, turnIds) =>
      turnReportedCosts(pool, ownerUserId, [...turnIds])
  }
  ```

  `services/runtime/src/main.ts` imports this factory and calls it only on the
  `api` and `all` role paths, once before `buildServer`. Do not construct it for
  `migrate` or `worker`; do not move these callbacks into route handlers or
  duplicate the repository's SQL.
- [x] Add `tests/unit/runtime-generation-composition.test.ts` with a typed mock
  pool. Assert `createApiGenerationApplication(pool)` returns all seven command
  methods and makes no query during construction. This is the composition proof
  that the injected application is real while routes remain untouched in 10c1.
- [x] Do **not** make the field optional with an internal default. That keeps
  `buildServer` importing the repository constructor and weakens exactly the
  composition-ownership property 10f has to audit.
- [x] *(10c3)* Resolve the credential-free `initial-owner` server-side for the API role
  and supply its UUID as `OwnerScope`. Continue rejecting or ignoring any
  caller-supplied `user_id`, identity header, email, display name, OIDC subject,
  or provider identifier as authority.
- [x] *(10c3)* Keep request schema validation, campaign/job path parameters,
  idempotency/operation provenance, safe result projections, status codes,
  response headers, and response bodies byte-for-byte contract-compatible.
- [x] *(10c2)* **Freeze the route-facing adapter contract before implementing
  it.** Create `generation-application-adapter.ts` with these exact exported
  types and factory. The method names deliberately match the temporary facade
  so 10c3 changes route dependencies rather than inventing a second route API:

  ```ts
  export type GenerationHttpError = Error & {
    statusCode: number;
    details?: unknown;
  };

  export type GenerationApplicationAdapter = Readonly<{
    enqueueGeneration(
      ownerScope: OwnerScope,
      campaignId: string,
      request: GenerationRequest,
    ): Promise<EnqueueGenerationResult>;
    enqueueLatestReplacement(
      ownerScope: OwnerScope,
      campaignId: string,
      request: GenerationRetryLatestRequest,
    ): Promise<EnqueueGenerationResult>;
    getGenerationJob(
      ownerScope: OwnerScope,
      jobId: string,
    ): Promise<GenerationJob>;
    getGenerationResult(
      ownerScope: OwnerScope,
      jobId: string,
    ): Promise<GenerationResult>;
    retryGeneration(
      ownerScope: OwnerScope,
      jobId: string,
    ): Promise<GenerationMutationResult>;
    cancelGeneration(
      ownerScope: OwnerScope,
      jobId: string,
    ): Promise<GenerationMutationResult>;
    discardGeneration(
      ownerScope: OwnerScope,
      jobId: string,
    ): Promise<GenerationMutationResult>;
  }>;

  export function mapGenerationApplicationError(
    error: GenerationApplicationError,
  ): GenerationHttpError;

  export function createGenerationApplicationAdapter(
    application: GenerationApplication,
  ): GenerationApplicationAdapter;
  ```

  Import `GenerationRequest`, `GenerationResult`, and
  `GenerationRetryLatestRequest` from contracts. Import `OwnerScope`,
  `EnqueueGenerationResult`, `GenerationJob`, `GenerationMutationResult`,
  `GenerationApplication`, and `GenerationApplicationError` from the
  application package. The adapter constructs only
  `{ ownerUserId, campaignId }` or `{ ownerUserId, jobId }` scopes and delegates
  once to the corresponding application method. It returns successful values
  unchanged; Zod response projection remains an HTTP-handler responsibility in
  10c3. It catches only `GenerationApplicationError`, maps that error through
  the exported mapper, and rethrows every unknown error by object identity.
  It must not import Fastify, Zod, `DatabasePool`, `initialOwnerId`, a
  repository, logger, `safeTurnInput`, or generation execution code. Owner
  resolution, input safety, lifecycle logging, and route projection remain
  assigned to 10c3.
- [x] *(10c2)* **Port the error mapping at `details.reason` granularity, not by `kind`.**
  An earlier revision of this item said "map each kind", which understates the
  contract by a wide margin: there are **6 `kind` values and 16 `reason`
  values** (verified against `packages/application/src/generation/errors.ts` and
  the 16-case switch in the bridge), and the HTTP status is chosen by reason.
  Collapsing to six statuses would break the byte-for-byte compatibility this
  checkpoint exists to preserve.
  The authoritative mapping is the current `mapGenerationApplicationError`
  switch (which builds errors through its private `legacyError` helper) in
  `services/api/src/generation-command-compatibility.ts` — **the file this
  checkpoint deletes** — so port it into
  `generation-application-adapter.ts` *before* removing the bridge. Its only
  consumers are `generation-service.ts` and its own test, so nothing preserves
  it by accident.

  Four properties an implementer must not flatten:

  | Property | Example |
  |---|---|
  | Status varies by reason, not kind | `missing_latest_turn` → **404**; `selected_provider_unavailable` → **400**; `no_text_provider` → **409** |
  | One reason needs `kind` as a tiebreaker | `classification_missing_or_expired` → 409 when `kind` is `conflict`, 400 otherwise, **with different messages** |
  | Two messages are computed, not fixed | `stale_current_turn` interpolates `details.actualTurnNumber`/`expectedTurnNumber`; `result_not_completed` branches its text on `details.generationStatus` |
  | One carries structured details | `active_generation` → 409 with `code: "active_generation_exists"` plus a `pendingGeneration` payload |

  The `not_found` default also discriminates its message on whether
  `details.campaignId` is present ("Campaign not found." vs "Generation job not
  found."). Unknown failures follow the existing 5xx handler and internal
  structured logging; do not expose adapter/provider text.
- [x] *(10c2)* **Make mapping coverage exhaustive by type and by runtime
  branch.** In the adapter test import `GenerationApplicationErrorDetails`,
  `GenerationApplicationErrorKind`, and `GenerationApplicationErrorReason`
  from the application package and define the fixture type exactly as:

  ```ts
  type MappingFixture = Readonly<{
    kind: GenerationApplicationErrorKind;
    details: Omit<GenerationApplicationErrorDetails, "reason">;
    expectedStatusCode: number;
    expectedMessage: string;
    expectedDetails?: unknown;
  }>;
  ```

  Define the 16 base fixtures as a value satisfying
  `Record<GenerationApplicationErrorReason, MappingFixture>` so adding a new
  reason fails compilation until its HTTP contract is specified. Construct each
  typed error with `{ reason, ...fixture.details }`, deriving `reason` from the
  record key so a fixture cannot silently name a different reason. Use these
  exact base expectations:

  | Reason | Kind | Status | Exact message | Expected details |
  |---|---|---:|---|---|
  | `idempotency_mismatch` | `conflict` | 409 | `The idempotency key was already used for a different generation request.` | absent |
  | `action_only_mode` | `invalid_state` | 400 | `This campaign accepts player actions only.` | absent |
  | `explicit_input_mode_mismatch` | `invalid_state` | 400 | `Explicit turn input mode does not match the resolved mode.` | absent |
  | `classification_id_forbidden` | `invalid_state` | 400 | `Classification IDs are valid only for Auto input.` | absent |
  | `classification_missing_or_expired` | `conflict` | 409 | `The Auto classification is missing, expired, consumed, or does not match this input.` | absent |
  | `classification_mode_mismatch` | `conflict` | 409 | `The submitted turn mode does not match the Auto classification.` | absent |
  | `selected_provider_unavailable` | `provider_required` | 400 | `Enabled text provider profile not found.` | absent |
  | `no_text_provider` | `provider_required` | 409 | `Select a text provider for this campaign or mark a default text provider.` | absent |
  | `stale_current_turn` | `stale_turn` | 409 | `Campaign is at turn 5, not 3.` | absent |
  | `missing_latest_turn` | `not_found` | 404 | `The latest accepted turn was not found.` | absent |
  | `active_generation` | `active_job` | 409 | `This campaign already has an active story generation.` | `{ code: "active_generation_exists", pendingGeneration }` |
  | `active_illustration` | `active_job` | 409 | `Wait for the latest turn illustration to finish before retrying the turn.` | absent |
  | `result_not_completed` | `invalid_state` | 409 | `Generation could not be completed.` | absent |
  | `retry_source_state` | `invalid_state` | 409 | `Only recoverable or failed generation jobs can be retried.` | absent |
  | `cancel_source_state` | `invalid_state` | 409 | `Only active generation jobs can be cancelled.` | absent |
  | `discard_source_state` | `invalid_state` | 409 | `Only recoverable or failed generation jobs can be discarded.` | absent |

  Give the stale fixture `actualTurnNumber: 5` and `expectedTurnNumber: 3`,
  the result fixture `generationStatus: "failed"`, and the active fixture a
  complete typed `pendingGeneration` constant. For every fixture assert the
  complete normalized error snapshot:
  `{ name, message, statusCode, details, hasTopLevelCode }`. `name` must remain
  exactly `"Error"`; `active_generation_exists` belongs under `details.code`
  and must not appear as a top-level `error.code`. A status-only assertion is
  insufficient. Normalize both implementations with this shape so `Error`
  prototype differences cannot hide a contract mismatch:

  ```ts
  function errorSnapshot(error: GenerationHttpError) {
    return {
      name: error.name,
      message: error.message,
      statusCode: error.statusCode,
      details: error.details,
      hasTopLevelCode: Object.prototype.hasOwnProperty.call(error, "code"),
    };
  }
  ```

  Add explicit variant fixtures beyond the 16 reason keys for every branch the
  base record cannot represent:

  - `classification_missing_or_expired` with `kind: "conflict"` and with
    `kind: "invalid_state"`, including their different status/message pairs;
  - `result_not_completed` for each collapsed terminal status (`failed`,
    `recoverable`, `cancelled`, and `discarded`) and for one non-terminal
    status such as `generating` so both computed-message branches are proved;
  - `stale_current_turn` with unequal concrete actual/expected values so the
    interpolation is asserted rather than snapshotting `undefined`;
  - `active_generation` with a populated `pendingGeneration` and with no
    pending value, where the mapped payload must contain
    `pendingGeneration: null`;
  - a reasonless `not_found` error with `campaignId`, a reasonless `not_found`
    error with only `jobId`, and a reasonless non-`not_found` error for the
    generic 409 fallback.

  While both implementations coexist, import the old mapper under an explicit
  alias and run every base and variant fixture through both mappers. Compare the
  normalized snapshots for exact equality. Keep the existing bridge and its
  test unchanged in 10c2; this differential test is deleted or converted to a
  single-implementation contract test only when 10c3 removes the bridge.
- [x] *(10c2)* Keep the emitted `details.code` values inside the diagnostic
  allowlist without exporting a mutable `Set`. In
  `services/api/src/generation-diagnostics.ts`, leave `SAFE_ERROR_CODES`
  private and export exactly:

  ```ts
  export function isSafeGenerationDiagnosticErrorCode(value: string): boolean {
    return SAFE_ERROR_CODES.has(value);
  }
  ```

  Make the existing private `safeErrorCode` call this predicate after its
  existing trim/lowercase normalization; do not change its fallback,
  sanitization, or logging behavior. Add focused diagnostics tests proving
  `active_generation_exists` is accepted and an arbitrary private code is
  rejected. In the adapter mapping test, read the actual mapped
  `details.code`, prove it is a string, and pass that value to the predicate;
  do not duplicate the allowlist in the test. This preserves
  `generation-diagnostics.ts` as the second independent owner of the safe-code
  contract while preventing callers from mutating its set.
- [x] *(10c3)* Keep SSE behavior and its 350 ms polling topology unchanged in this
  checkpoint. Task 11 owns notification delivery. SSE and polling must continue
  using their distinct validated projections and safe error allowlists.
- [x] *(10c3)* Remove API-facing generation command/query logic from
  `generation-service.ts` after all route consumers use the application. Keep
  only explicitly out-of-scope campaign and execution code; do not leave two
  callable implementations.
- [x] *(10c3)* **Delete the 10b compatibility bridge.** `services/api/src/generation-command-compatibility.ts`
  and `tests/unit/generation-command-compatibility.test.ts` were introduced by
  10b as an explicitly temporary facade, and 10c is their named removal owner.
  Once routes call `GenerationApplication` directly, the bridge has no consumer;
  leaving it in place would be the "two callable implementations" the item above
  forbids, just relocated to its own file.
- [x] *(10c3)* Move what the bridge legitimately owns rather than deleting it wholesale.
  It currently holds an owner-scoped `generationLifecycleLogContext` read used
  for structured logging and the `safeTurnInput` mechanics-language guard.
  Re-home lifecycle logging to the API adapter. Move `safeTurnInput` into the
  shared `turn-input-safety.ts` module and use it both for route validation and
  from the existing execution path: Task 10d, not 10c, moves execution. Prove
  the existing 400 rejection message, the execution-time defense-in-depth guard,
  and log fields are unchanged. Do not drop any of these responsibilities along
  with the facade.
- [x] *(10c3)* Remove the compatibility bridge's single
  `initialOwnerId(pool)` command-authority lookup and prove every generation
  handler supplies the server-resolved `OwnerScope` explicitly. Current-state
  evidence at the 10c2 checkpoint is one such lookup in
  `generation-command-compatibility.ts`, not five in `generation-service.ts`.
  The three `generation-service.ts` lookups belong to player-config sync,
  rewind, and branch; they are not generation command/query authority and stay
  visible for Task 14c rather than being deleted accidentally. Record before
  and after counts by file and assert zero generation command/query paths can
  resolve or accept authority below the Fastify composition boundary.

**Required tests:**

- [x] *(10c2)* Table-test all seven **adapter methods**, not Fastify routes,
  against a fake `GenerationApplication`. For each method assert the exact
  application method invoked, one invocation only, the explicit owner plus
  campaign/job scope, request identity where applicable, and unchanged success
  result identity. For every method, separately prove one
  `GenerationApplicationError` is mapped and one arbitrary `Error` is rethrown
  by identity. Assert the fake has zero unexpected calls. Actual route tests do
  not belong to 10c2 because routes intentionally remain on the 10b facade.
- [x] *(10c3)* Table-test the seven non-streaming generation HTTP routes against
  the injected fake application for schema-validated input, server-resolved
  owner/campaign/job scope, success status and response projection, every
  applicable typed error, and an unknown error. Keep SSE/get-job coverage in
  the dedicated polling/SSE item below. This test moves with the route cutover;
  it must fail before 10c3 rather than forcing 10c2 to use the application
  prematurely.
- [x] *(10c3)* Prove a spoofed identity header/body/query value cannot alter the injected
  owner and Owner A cannot obtain Owner B's job through a known UUID.
- [x] *(10c3)* Re-run polling/SSE contract tests to prove no new fields, raw errors,
  `partialOutput`, lease timestamps, or replacement-provenance drift.
- [x] *(10c3)* Re-run append, replace-latest, retry, cancel, discard, result recovery,
  and sync integration flows through HTTP, not only through the repository.
- [x] *(10c3)* Before deleting the command delegates, re-home the direct command usage in
  `image-pipeline.integration.test.ts` to an explicit application/repository
  fixture (with the server-resolved owner scope). Keep `runGenerationJob` on its
  current execution path until Task 10d/10e. This proves the bridge deletion does
  not strand illustration-cancellation coverage while avoiding a second callable
  command facade.

**10c2 implementation sequence and handoff gate:**

1. Add the failing `generation-application-adapter.test.ts` imports and the
   seven-method delegation table. Run only that file and record the expected
   missing-module/export failure before creating production code.
2. Add the typed 16-reason mapping record, all branch-variant fixtures, and the
   legacy/new differential snapshot assertions. Keep the old mapper as the
   oracle for parity, but retain explicit expected snapshots so a shared bug
   cannot make both implementations pass incorrectly.
3. Implement the minimal adapter contract and mapper. Re-run the adapter unit
   file until the seven delegation/error cases and the complete mapping matrix
   pass. Do not edit a route or the live facade to make these tests green.
4. Add `isSafeGenerationDiagnosticErrorCode`, route the existing normalized
   diagnostic lookup through it, and add its focused positive/negative tests.
   Re-run the adapter and diagnostics unit files together.
5. Run the unchanged compatibility suite in the same focused command. The
   required focused gate is:

   ```sh
   pnpm vitest run tests/unit/generation-application-adapter.test.ts tests/unit/generation-command-compatibility.test.ts tests/unit/generation-diagnostics.test.ts
   ```

6. Confirm the 10c2 diff contains only the new adapter/test, the diagnostic
   predicate/test, and this substage's measured evidence. `server.ts`,
   `generation-service.ts`, `generation-command-compatibility.ts`, and
   `generation-command-compatibility.test.ts` must have zero diff.
7. Run `pnpm check`, `pnpm build`, `pnpm test:unit`,
   `pnpm test:integration`, `git diff --check`, and `pjm precheck`. Record exact
   test/file counts and the base/head range, commit 10c2 separately, and obtain
   a fresh scoped review before checking its items complete. Keep Task 10's
   top-level status `Not started` and do not begin 10c3 in the same checkpoint.

**10c review gate:** all generation HTTP routes depend on the application
interface, public contracts are unchanged, and the API owns request authority
without embedding SQL or worker concerns.

### Task 10d — B1d: Extract execution, claim, lease, and state transitions

**Purpose:** remove worker execution behavior from the API role, implement the
frozen `GenerationClaimRepository`, and supply the `GenerationExecutor` adapter
without changing the durable state machine. This is a relocation checkpoint,
not a generation rewrite.

**Files:**

- Create: `packages/database/src/generation-execution-repository.ts`
- Create: `services/runtime/src/generation-executor-adapter.ts`
- Create: `tests/unit/generation-executor-adapter.test.ts`
- Create: `tests/integration/generation-execution-repository.integration.test.ts`
- Modify: `packages/application/src/generation/ports.ts`
- Modify: `packages/application/src/generation/types.ts`
- Modify: `packages/database/src/index.ts`
- Modify: `services/api/src/generation-service.ts`
- Modify: `services/runtime/src/main.ts`
- Test: `tests/unit/application/generation-use-cases.test.ts`
- Test: `tests/integration/generation.integration.test.ts`
- Test: `tests/integration/gameplay.integration.test.ts`
- Test: `tests/integration/image-pipeline.integration.test.ts`

Before moving code, inventory every `generation_jobs` read/write performed from
claim through completion and record it in the checkpoint evidence. The inventory
must cover claim/reclaim, lease heartbeat, phase transitions, partial narration,
provider/response metadata, retry classification, failure/recoverable handling,
commit, result linkage, cancellation races, and provisional illustration
cleanup. A generic `query(sql)` escape hatch is not an application port.

**10d frozen execution-repository surface:** keep the application package's
already-frozen `GenerationClaimRepository` and `GenerationExecutor` unchanged.
In `generation-execution-repository.ts`, define a concrete
`GenerationExecutionRepository` with these named operations and no public SQL
escape hatch:

```ts
type GenerationLeaseScope = Readonly<{
  jobId: string;
  ownerUserId: string;
  workerId: string;
}>;

type GenerationExecutionRepository = Readonly<{
  loadExecutionPayload(request: GenerationExecutionRequest): Promise<GenerationExecutionPayload | null>;
  renewLease(scope: GenerationLeaseScope, leaseSeconds: number): Promise<boolean>;
  markGenerating(scope: GenerationLeaseScope): Promise<boolean>;
  saveOrchestration(scope: GenerationLeaseScope, value: GenerationOrchestrationState): Promise<boolean>;
  savePartialNarration(scope: GenerationLeaseScope, narration: string): Promise<boolean>;
  saveStreamingSegments(scope: GenerationLeaseScope, value: GenerationStreamingState): Promise<boolean>;
  recordAttempt(input: GenerationAttemptRecord): Promise<void>;
  markRecoverable(input: GenerationRecoverableUpdate): Promise<boolean>;
  markValidating(scope: GenerationLeaseScope): Promise<boolean>;
  markCommitting(scope: GenerationLeaseScope): Promise<boolean>;
  commitAcceptedTurn(input: AcceptedGenerationCommit): Promise<{ turnId: string }>;
  markFailed(input: GenerationFailedUpdate): Promise<boolean>;
}>;

export function createPostgresGenerationExecutionRepository(
  pool: DatabasePool,
): GenerationClaimRepository & GenerationExecutionRepository;
```

Define the referenced payload/update types in the same database module from the
existing snake-case row and orchestration fields; do not add them to the public
contracts barrel. Every boolean mutation means exactly one owner/lease/source-
state row changed; `false` is cancellation or lost lease. `recordAttempt` must
remain owner/job/attempt scoped. `commitAcceptedTurn` owns the existing single
transaction and returns only after the turn, campaign state, Chronicle writes,
derived jobs, generation result linkage, and completed status commit together.
Its optional illustration savepoint remains inside that transaction boundary.
The integration inventory must map every old SQL statement to exactly one of
these operations or to `commitAcceptedTurn`; unmapped SQL blocks completion.

**Execution repository requirements:**

- [x] Implement the complete `GenerationClaimRepository.claimNext` with the
  current global oldest-first candidate, `FOR UPDATE SKIP LOCKED`, expired-lease
  reclaim, attempt increment, lease assignment, and atomic transition to
  `assessing`. Do not add API command/query methods or a second combined
  repository interface.
- [x] Return `ClaimedGeneration.ownerUserId` from `owner_user_id`. Per the 10a
  decision, `claimNext` returns the **minimal** claim only; it does not carry the
  prompt, context, orchestration, or base-state payload. Never look up
  `initial-owner` in the claim or execution path.
- [x] Load the execution payload in the executor adapter with **one additional
  guarded read**, after the claim transaction commits. Filter on `id`,
  `owner_user_id`, `lease_owner = workerId`, and `status = 'assessing'`; do not
  take `FOR UPDATE`, increment `attempts`, renew/reassign the lease, or perform
  provider work before this guard passes. No row means cancellation or lost
  lease, not an empty payload. Add integration cases for a foreign owner, user
  cancellation between claim and load, and another worker reclaiming an expired
  lease; every case must stop before provider loading or durable mutation.
- [x] Provide named adapter operations for lease renewal and every durable
  transition used by the executor. Each mutation must require job ID, durable
  owner ID, lease owner where currently required, and allowed source state; zero
  updated rows remains a lost-lease/cancellation condition rather than success.
- [x] Preserve the heartbeat interval `max(5000, floor(leaseSeconds * 1000 / 3))`,
  lease duration, claim ordering, retry counts, recoverable/failed
  classification, and structured generation log context.
- [x] Preserve the single transaction that validates and accepts narration,
  appends/replaces the turn, updates campaign state, writes Chronicle memory,
  queues derived work, and marks the job completed. Optional illustration
  enqueue failure remains isolated and cannot roll back the accepted turn.

**Executor adapter requirements:**

- [x] Move the existing `executeGenerationJob` orchestration and its private
  generation-only helpers out of `services/api`. The adapter may depend on
  database, story-engine, logger, and provider ports; `packages/application`
  must remain implementation-free.
- [x] Bind credential decryption/configuration when constructing the executor.
  Do not place secrets on application commands, claim rows, logs, or public
  errors.
- [x] Inject Chronicle, illustration, asset, and provider collaborators through
  a typed runtime collaborator object while their final application adapters are
  pending Task 14. Do not import those API implementations from worker code or
  conceal new worker-to-API imports in a helper. Record each temporary runtime
  binding so Task 14 can remove it.

  Freeze that temporary object as `GenerationExecutionCollaborators` in
  `generation-executor-adapter.ts`. Its memory operations are
  `autoEnableCampaignEmbeddingIfAvailable`, `buildContextPreview`,
  `enqueueEmbeddingReindex`, `rebuildCampaignMemories`, and
  `storeDerivedTurnMemories` (removal owner: 14b); illustration operations are
  `loadStreamingIllustrationConfig`, `createProvisionalSet`,
  `createProvisionalSegment`, `promoteProvisionalSet`, `orphanProvisionalSet`,
  and `enqueueAcceptedTurnIllustrationSegments` (14a); provider/prompt/cost
  operations are `loadTextProvider`, `resolvePromptSnapshot`,
  `promptFromSnapshot`, `promptProtocolVersion`, `recordProfileCost`,
  `turnReportedCosts`, and `attributeGenerationCostsToTurn` (14d). Runtime
  composition may adapt the current implementations temporarily; neither the
  worker nor `packages/application` may import their API modules. The 10d report
  records this exact inventory and Tasks 14a/14b/14d must drive it to zero.
- [x] Preserve prompt protocol/version checks, mechanics/fiction separation,
  safe partial narration, context scoping, response-chain scope, provider retry
  metadata, cost recording, and all accepted-turn validation.
- [x] Keep shutdown semantics unchanged: an already claimed job drains. The
  worker's scheduler `AbortSignal` is not passed as story cancellation. User
  cancellation continues through the durable job-state operation.

**Required execution tests:**

- [x] Claim exclusivity across two workers, expired lease reclaim, heartbeat
  renewal, lost lease, cancellation during execution, and no double commit.
- [x] Rejected, malformed, timed-out, or incomplete output does not append a
  turn, mutate campaign state, or write Chronicle memory.
- [x] Prompt assembly cannot read another owner or campaign's world canon,
  turns, state, Chronicle rows, or response chain.
- [x] Append and replacement completion retain expected turn and immutable
  replacement provenance under cancellation/retry races.
- [x] Images disabled, endpoint unavailable, incompatible image model,
  illustration enqueue error, image failure, and independent image retry do not
  change whether validated narration commits.
- [x] Mechanics, rolls, private reasoning, parser diagnostics, rejected output,
  and scratchpads do not enter narration, fiction-only image prompts, story
  memory, or embeddings.

**10d review gate:** claim and execution behavior no longer live in the API
role; transaction, lease, prompt, ownership, and illustration-independence
invariants pass against real PostgreSQL.

### Task 10e — B1e: Inject the worker application and close the boundary exception

**Purpose:** make `runWorker` a scheduler around injected application ports and
remove only the generation cross-role allowlist entry.

**Files:**

- Create: `tests/unit/worker-generation-adapter.test.ts`
- Modify: `services/worker/src/worker.ts`
- Modify: `services/runtime/src/main.ts`
- Modify: `services/runtime/src/lifecycle.ts` only if constructed dependencies
  require lifecycle-owned cleanup
- Modify: `scripts/check-client-boundaries.mjs`
- Modify: `tests/unit/client-boundaries.test.ts`
- Test: `tests/unit/runtime-provider-lifecycle.test.ts`
- Test: `tests/integration/generation.integration.test.ts`
- Test: `tests/integration/gameplay.integration.test.ts`
- Test: `tests/integration/image-pipeline.integration.test.ts`

**Worker and runtime requirements:**

Use this exact role-construction matrix; lifecycle tests assert constructor
counts as well as absence:

| Role | Generation objects constructed |
|---|---|
| `api` | command repository, API application, and HTTP adapter exactly once; no claim repository, executor, or worker application |
| `worker` | claim/execution repository, executor adapter, and worker application exactly once; no command repository, API application, or Fastify server |
| `all` | both graphs exactly once over the shared pool; API and worker receive only their own application objects |
| `migrate` | none of the generation repositories, applications, adapters, or provider collaborators |

Construction belongs in small runtime composition factories rather than one
expanded `dispatchRuntimeRole` body. The worker composition consumes the exact
`GenerationExecutionCollaborators` inventory recorded by 10d; it must not add
anonymous callbacks that Tasks 14a/14b/14d cannot identify and remove.

- [x] Change the signature to
  `runWorker(pool, config, signal, { generation }: WorkerDependencies)`, where
  `WorkerDependencies.generation` is a `GenerationWorkerApplication`. It must
  not construct the repository, executor, or application internally.
- [x] Compose the PostgreSQL repository, execution repository, executor adapter,
  API application, and worker application once in
  `services/runtime/src/main.ts`, with role-appropriate dependencies. The API
  role does not start worker execution; the worker role does not construct
  Fastify; and the `all` role shares the pool while `services/api` and
  `services/worker` still never import each other's implementation files.
- [x] Construct the worker application exactly once with
  `createGenerationWorkerApplication({ claims: claimRepository, executor })`
  and pass that object through `WorkerDependencies.generation`. Do not bypass the
  factory by injecting the repository and executor separately into `runWorker`.
- [x] Preserve the current one-active-generation slot, worker ID format,
  concurrent illustration/Chronicle/asset lane, polling cadence, error logging,
  claim ordering, and shutdown drain. Task 12—not B1—owns configurable
  concurrency and fair lanes.
- [x] Do not broaden `RuntimeLifecycleDependencies` merely to pass ordinary
  composition values. Modify `lifecycle.ts` only if the new executor owns a
  closeable resource; if modified, prove cleanup occurs once and in the current
  provider-transport-before-pool order on success, startup failure, and abort.
- [x] Delete the worker import of `generation-service.js`. Remove exactly its
  Task 10 entry from the transitional cross-role allowlist and change the
  positive boundary fixture into a rejection. Keep the five Task 14 entries
  explicit and prove a new unlisted cross-role import still fails.
- [x] Update tests that import `runGenerationJob` from the API service to use a
  production-shaped application/executor harness. Do not preserve the wrong
  role boundary solely for test convenience.

**Required worker tests:**

- [x] Fake `claimNext` and `executeClaimed` prove no second generation starts
  while one is active, no new claim occurs after scheduler abort, and the active
  promise drains before `runWorker` resolves.
- [x] Execution rejection is logged and the scheduler remains available for a
  later job without duplicating the failed claim.
- [x] Optional lanes still run while generation is active and retain their
  existing priority order.
- [x] API-only, worker-only, all-in-one, and migrate runtime roles construct only
  their allowed dependencies and retain cleanup behavior.

**10e review gate:** worker source has no generation import from `services/api`,
the boundary checker owns no generation exception, and the other five Task 14
exceptions remain visible rather than being falsely declared complete.

### Task 10f — B1f: Audit parity and close the backend boundary milestone

**Purpose:** prove the whole `10a..10e` range satisfies B1 and leave durable
evidence for the next agent starting Task 11.

**Files:**

- Create: `docs/review/2026-08-03-task-10-b1-completion.md`
- Modify: `docs/architecture/0028-modular-client-and-application-boundaries.md`
- Modify: `docs/architecture/index.md`
- Modify: this Task 10 status/checklist/evidence block
- Test: `tests/unit/application/generation-use-cases.test.ts`
- Test: `tests/unit/generation-application-adapter.test.ts`
- Test: `tests/unit/generation-executor-adapter.test.ts`
- Test: `tests/unit/worker-generation-adapter.test.ts`
- Test: `tests/unit/client-boundaries.test.ts`
- Test: `tests/unit/runtime-provider-lifecycle.test.ts`
- Test: `tests/integration/generation-repository.integration.test.ts`
- Test: `tests/integration/generation-execution-repository.integration.test.ts`
- Test: `tests/integration/generation.integration.test.ts`
- Test: `tests/integration/gameplay.integration.test.ts`
- Test: `tests/integration/image-pipeline.integration.test.ts`

**Audit requirements:**

- [x] Review the complete `pre-10a..10e` diff, not only the last checkpoint.
  The frozen pre-10a base is `885bcdeaa52a1c1286d044f34275c7cf40159bbb`;
  verify that commit is still the parent-side boundary in the ledger and use it
  explicitly when generating the full review package. Do not substitute
  `HEAD~1`, the 10e base, or a merge-base that omits earlier checkpoints.
  List every moved public function and its new application port, adapter, and
  production composition owner.
- [x] Prove no SQL, Fastify, provider implementation, worker scheduler, runtime
  config, secret, or `services/**` import is reachable from
  `@infinite-quest/application`.
- [x] Prove all API command/query paths use server-resolved owner scope; all
  worker paths use the owner on the claimed durable job; and no caller-supplied
  identity can establish either authority.
- [x] Compare pre/post HTTP payload fixtures, SSE frames, job transition traces,
  structured log event names/fields, SQL transaction boundaries, lease timing,
  prompt protocol, and shutdown behavior. Explain any difference; unapproved
  behavioral drift blocks completion.
- [x] Record the remaining five Task 14 cross-role exceptions and temporary
  runtime collaborator bindings. B1 completion means the generation exception
  is gone, not that B5 is complete.
- [x] Record exact commands, pass/fail/skip counts, PostgreSQL version, Node/pnpm
  versions, base/head SHAs, correction commits, reviewer result, and any
  environment limitation in the completion report.
- [x] Run a fresh independent final review against ADR 0028, the generation
  integrity rules, identity rules, provider independence rules, and the testing
  matrix. Resolve every blocking finding before checking Task 10 complete.
- [x] Only after the final review passes, check 10a-10f, change the Task 10 status
  row to `Complete`, add the verification block, and authorize Task 11. Do not
  start Task 11 or Task 12 in the same checkpoint.

**Final B1 definition of done:** API generation routes and the worker scheduler
both depend on typed `packages/application` use cases; application tests run
without Fastify/PostgreSQL/provider/worker implementations; PostgreSQL tests
prove owner scope, locks, transactions, leases, job states, and generation
integrity are unchanged; worker no longer imports the API generation service;
and the only remaining cross-role exceptions are the five explicitly assigned
to Task 14.

**Current Task 10f verification (2026-08-04, complete; Task 11 authorized).**
The independently approved full range is
`885bcdeaa52a1c1286d044f34275c7cf40159bbb..653c7c867ca23c15aa482ced7601745972dfdd01`.
It includes the original 30-commit B1 implementation range, completion audit
`76c1a22473f8e9e0b963830e0f7614655e4d98c8`, and correction
`653c7c867ca23c15aa482ced7601745972dfdd01`. The completion report at
`docs/review/2026-08-03-task-10-b1-completion.md` inventories every moved public
function, proves server/durable-claim authority, compares HTTP, SSE, state, log,
transaction, lease, prompt, provider, and shutdown behavior, and records the
exact five Task 14 cross-role exceptions plus all 18 temporary
generation-execution collaborators. The independent final reviewer approved B1
after the #0289 correction; Task 11 is authorized, but this checkpoint does not
start Task 11 or Task 12.

Fix round 1 adds active real-PostgreSQL coverage for all three finding #0289
image-independence modes: disabled illustrations commit the accepted turn,
state, and Chronicle memory without image or resolution work; an incompatible
image model cannot change the accepted story snapshot; and `retryImageJob`
retries an unsuccessful image independently without changing the original
generation job, accepted story/state/Chronicle snapshot, or text-provider
request count. The targeted TDD run was red with 2 failures/1 pass before the
fixture and assertion corrections, then green at 3/3; the complete image suite
is 22/22. No production implementation changed. Finding #0288 is resolved by
the approved Task 11 pickup instruction above.

Fresh verification passed on Node 24.18.0, pnpm 11.18.0, and PostgreSQL 18.4:
focused Task 10 units **91/91 across 6 files**, focused real-PostgreSQL Task 10
integrations **99/99 across 5 files**, `pnpm check` (**577 candidate files**),
`pnpm build`, `pnpm test:unit` (**1,114/1,114 across 93 files**),
`pnpm test:integration` (**225/225 across 19 files, zero skips**), and
`git diff --check`. The Task 10a-10e checkpoint reviews and the independent
full-range Task 10f review are approved. Task 11 is authorized as the next
backend task. UI work remains blocked until Task 14f.

**Checklist audit (2026-08-04).** This block originally also claimed the
`10a-10f` checklist was complete. It was not: **45 items were still unticked** —
17 in 10c, 17 in 10d, 11 in 10e — while the Task 10 row read `Complete` and had
already authorized Task 11. The work was done; only the per-requirement record
was missing. All 45 were verified against the shipped code and ticked:

- **10c2/10c3** — `generation-application-adapter.ts` exists, `safeTurnInput`
  was re-homed into the new shared `turn-input-safety.ts`, and
  `generation-command-compatibility.ts` is deleted. The three surviving
  `initialOwnerId` call sites in `generation-service.ts` are
  `syncPlayerCampaignConfig`, `rewindCampaign`, and `branchCampaign` — the
  campaign operations 10b explicitly scoped out, now owned by Task 14c. Zero
  generation-command sites remain, which is exactly what 10c3 required.
- **10d** — `packages/database/src/generation-execution-repository.ts` and
  `services/runtime/src/generation-executor-adapter.ts` both exist, and the
  repository exposes `loadExecutionPayload`: the separate owner-scoped read the
  10a minimal-claim decision deliberately traded for.
- **10e** — `runWorker(pool, config, signal, { generation, optionalLanes })`
  takes injected dependencies, the worker no longer imports
  `generation-service`, and `CROSS_ROLE_IMPORT_ALLOWLIST` holds exactly the five
  Task 14 entries.

This is the fifth completed task to carry an unticked checklist. The pattern is
consistent enough to state plainly for whoever picks up Task 13b: the
implementation and review process is reliable, and the per-requirement record is
what repeatedly slips. Tick the checklist in the commit that flips the status
row.

---

## Task 11 — B2: Replace SSE database polling with a notification port

**Runs after B1 and gates all UI work under the backend-first policy.** The
wire contract remains unchanged, but B2 must be implemented and measured before
B3 so worker/load benchmarks use the final event-delivery topology.

**Files:**

- Create: `database/migrations/0052_generation_job_notifications.sql`
- Create: `packages/application/src/generation/events.ts`
- Create: `packages/database/src/postgres-generation-events.ts`
- Create: `services/runtime/src/generation-event-composition.ts`
- Create: `tests/unit/postgres-generation-events.test.ts`
- Create: `tests/integration/generation-events.integration.test.ts`
- Modify: `packages/application/src/index.ts`
- Modify: `packages/database/src/index.ts`
- Modify: `services/api/src/server.ts`
- Modify: `services/runtime/src/main.ts`
- Modify: `services/runtime/src/lifecycle.ts` — only to own listener cleanup
- Modify: `tests/helpers/build-server-options.ts`
- Test: `tests/unit/application/generation-use-cases.test.ts`
- Test: `tests/unit/client-api-routes.test.ts`
- Test: `tests/unit/runtime-provider-lifecycle.test.ts`
- Test: `tests/integration/migrations.integration.test.ts`
- Test: `tests/integration/generation.integration.test.ts`

```ts
export type GenerationChanged = Readonly<{
  jobId: string;
  version: string;
}>;

export interface GenerationEventSubscription extends AsyncIterable<GenerationChanged> {
  close(): Promise<void>;
}

export interface GenerationEventSource {
  subscribe(
    scope: { ownerUserId: string; campaignId: string; jobId: string },
  ): Promise<GenerationEventSubscription>;
}
```

`packages/application` remains platform-free: do not use `AbortSignal`, DOM
event types, `pg`, timers, or Node globals in this port. Fastify owns request
abort and calls `subscription.close()` exactly once. `version` is an opaque
wake-up/coalescing hint; neither field is authoritative state or authorization.

**Transaction-coupled publication decision:** use migration 0052 to install an
`AFTER INSERT OR UPDATE` trigger on `generation_jobs` and a versioned channel
name `infinitequest_generation_changed_v1`. PostgreSQL delivers trigger-issued
`pg_notify` only after commit, so every existing and future state writer is
covered without passing a database client through the application port. The
payload is bounded JSON containing only `jobId` and an opaque version derived
from the committed row. Fire for inserts and for changes to SSE-visible fields
(`status`, `partial_output`, `attempts`, and `result_turn_id`), not
lease-heartbeat-only timestamp changes. `partialNarration` is derived from
`partial_output`, and the public error fields are derived from terminal status;
there is no `partial_narration` database column and raw private error columns
must not enlarge the notification surface. The down migration removes the
trigger and function. Do not introduce an application-level publisher whose
call could occur on a different connection or before commit.

`createPostgresGenerationEventSource` owns exactly one dedicated `pg.Client`
per API process, created from the configured database URL outside the request
pool. It validates notification JSON/UUID/version length, reconnects with
bounded jittered backoff, re-issues `LISTEN`, and fans out only to subscriptions
whose owner/campaign/job tuple passed an ownership-scoped database read during
`subscribe`. Invalid or oversized notifications are logged safely and ignored.
The source has idempotent `start()` and `close()` methods; close stops reconnect,
closes every iterator, and ends the dedicated client once.

Task 11 adds a required `generationEvents: GenerationEventSource` field to
`BuildServerOptions`. The test `serverOptions()` helper supplies an inert source
by default, while `api` and `all` runtime roles construct/start one real source
and close it before the shared request pool; `worker` and `migrate` construct
none. No individual SSE request may create or check out a listener connection.

- [x] Prove migration-trigger notifications are invisible before commit,
  delivered after commit, absent after rollback, and emitted for every
  SSE-visible transition while lease-only heartbeats remain silent.
- [x] Use PostgreSQL `LISTEN/NOTIFY` as a wake-up hint, not authoritative state.
  Validate a small notification payload (`jobId` plus a transition/version
  hint), then read the job row after each notification through the full
  owner/campaign/job scope. A notification payload never establishes ownership
  and never becomes an SSE response directly.
- [x] **Use exactly one dedicated, long-lived listener connection per API
  process and fan out to subscribers in memory.** A `LISTEN` connection must be
  checked out and held for its lifetime; taking one per SSE subscriber from the
  shared pool exhausts it at `max` concurrent viewers
  (`packages/database/src/pool.ts:8`, default 12) and would make this package a
  regression rather than a fix — worse than the 350 ms loop it replaces. The
  listener connection is created outside the request pool, reconnects with
  backoff, and re-issues `LISTEN` on reconnect.
- [x] Add a test that opens more concurrent SSE subscribers than the configured
  pool `max` and asserts that pool checkouts do not scale with subscriber count.
- [x] Send an initial snapshot immediately and perform a bounded 15-second
  reconciliation read so dropped notifications cannot strand a client.
- [x] Close the subscribe race with this exact sequence: perform the first
  owner-scoped read, register the subscription, immediately perform a second
  owner-scoped read, then consume hints plus the 15-second reconciliation
  cadence. Project every read through the existing SSE schema; never serialize
  the notification payload itself.
- [x] Preserve SSE frame schema, terminal closure, cancellation, ownership, and
  structured logging.
- [x] Perform the initial ownership-scoped read before registering the in-memory
  subscriber; create no subscription when that read is unauthorized/not found.
  Once registered, close the subscription on every terminal, client-close, and
  error path, and ensure fan-out keys cannot deliver a same-ID event across
  campaign or owner scope.
- [x] Test notification-before-subscribe races, reconnect, dropped notification,
  duplicate notification, API restart, terminal transition, and client close.
- [x] Record query counts and verify the fixed 350 ms loop is gone.

**Definition of done:** Idle SSE connections do not continuously query
PostgreSQL, state delivery remains durable, and p95 notification-to-frame latency
meets the 500 ms budget.

---

## Task 12 — B3: Configurable worker concurrency and fair job lanes

**Runs after B2 and gates all UI work.** The replacement UI must not broaden access to a
single-slot worker whose queueing and optional-image work can starve the core
story path. The deterministic backend sequence keeps B2 before B3 so connection
and notification load are included in concurrency evidence.

**Files:**

- Modify: `packages/database/src/config.ts`
- Modify: `services/worker/src/worker.ts`
- Modify: `services/runtime/src/lifecycle.ts`
- Modify: `compose.yaml`
- Modify: `deploy/swarm/stack.yaml`
- Modify: `.env.example`
- Modify: `docs/runbooks/deployment.md`
- Modify: `docs/workflows/testing.md`
- Create: `scripts/benchmark-worker-concurrency.mjs`
- Create: `tests/unit/worker-concurrency.test.ts`
- Test: `tests/unit/security-config.test.ts`
- Test: `tests/unit/runtime-shutdown.test.ts`
- Test: `tests/unit/deployment-cors.test.ts`
- Test: `tests/integration/generation.integration.test.ts`

**Frozen scheduler/configuration contract:**

- `WORKER_GENERATION_CONCURRENCY` is an integer from **1 through 4**, default
  **1**, exposed as `RuntimeConfig.workerGenerationConcurrency`. Four is the
  approved maximum for this slice and the highest required benchmark point;
  raising it is a later measured configuration change, not an unbounded parse.
- Generation is one lane with that capacity. Illustration work (prompt,
  resolution, and image execution in its existing priority order), Chronicle
  work, and asset backfill are three separate lanes with capacity **1** each.
  Each lane owns its active-promise set and catches/logs its own rejection so a
  failure cannot stop slot refill in another lane.
- On every scheduler pass, visit generation, illustration, Chronicle, and asset
  once in round-robin order. On the generation visit, attempt at most one claim
  for each free generation slot; on each optional-lane visit, attempt at most
  one claim for its single free slot. Complete the full lane rotation before
  beginning another generation fill pass, and yield through the existing poll
  wait when no lane starts work. Do not drain one queue before offering the
  others a slot. PostgreSQL claim/active-job constraints remain the
  cross-replica and per-campaign correctness boundary.
- Validate database capacity after both settings are parsed. Worker-only roles
  require `DATABASE_MAX_CONNECTIONS >= workerGenerationConcurrency + 4` (three
  optional lanes plus one control/recovery connection). The `all` role requires
  `>= workerGenerationConcurrency + 8` to retain API headroom. Reject an
  explicitly smaller value at startup with both setting names in the error;
  defaults remain 8 for `worker` and 12 for `all`, which satisfy the 1-4 range.

- [x] Add the frozen 1-4 `WORKER_GENERATION_CONCURRENCY` setting, manifest/env
  documentation, and boundary-value/invalid-value/pool-capacity tests.
- [x] Size database pools and shutdown deadlines for configured concurrency.
- [x] Claim up to available generation slots without allowing two active jobs for
  one campaign.
- [x] Keep illustration, Chronicle, and asset work in independently bounded lanes
  so generation load cannot starve optional work and optional work cannot block
  story acceptance.
- [x] Keep story-text and illustration execution as separate provider concerns:
  separate endpoint/profile credentials, model compatibility checks, health,
  retry limits, and per-lane concurrency. Never fall back from a missing image
  profile to the text provider or expose either provider's credential to the
  other lane.
- [x] On shutdown, stop every lane from claiming new work and await all active
  promises; continue to withhold the scheduler `AbortSignal` from story
  execution. There is no pre-existing application-level hard deadline. Add a
  10-minute Compose/Swarm `stop_grace_period` and document that provider work
  exceeding the operator grace may be force-stopped and must recover through
  lease expiry/reclaim without double commit. Tests cover both graceful drain
  and simulated process loss followed by reclaim.
- [x] Add tests for slot refill, fair lanes, campaign exclusivity, abort, drain,
  lease expiry, and multiple worker replicas.
- [x] Add tests proving story completion with images disabled, image endpoint
  unavailable, incompatible image models, exhausted image retries, and image
  failure after story validation. Image retry must not re-enqueue narration.
- [x] Benchmark concurrency 1, 2, and 4 against the test database and record
  throughput, queue latency, database utilization, active/peak lane counts,
  provider limits, fixture seed, warm-ups, measured samples, and variance using
  the Task 1 C0 profile. The benchmark uses deterministic provider delays and
  fails if any campaign commits duplicate turn numbers.

**Definition of done:** Throughput scales with configured slots/replicas without
duplicate turns, cross-campaign leakage, unbounded shutdown, or illustration
coupling.

---

## Task 13a — B4a: Stabilize bounded history and authoritative resume contracts

**Runs after C8 and before C6.** This is the client-facing contract half of the
old B4 task. It does not wait for B1 because delaying these response shapes until
after C6 would force the campaign projection and U4/U5 to be rewritten.

**Files:**

- Modify: `packages/contracts/src/client-api.ts`
- Review: `packages/contracts/src/index.ts` (the existing public barrel already
  re-exports the complete client-contract module)
- Modify: `packages/client-web/src/api-client.ts`
- Modify: `packages/client-core/src/generation/workflow.ts`
- Modify: `services/api/src/server.ts`
- Create: `packages/database/src/play-loop-read-repository.ts`
- Modify: `apps/web/src/story.js`
- Review: `apps/web/src/story-generation-monitor.js` (the existing monitor
  already delegates recovery presentation to `GenerationWorkflow.resume()`)
- Modify: `tests/unit/client-api-contracts.test.ts`
- Modify: `tests/unit/client-api-routes.test.ts`
- Modify: `tests/unit/client-web/api-client.test.ts`
- Modify: `tests/unit/client-core/generation-workflow.test.ts`
- Modify: `tests/unit/story-player-ui.test.ts`
- Review: `tests/unit/story-generation-monitor.test.ts` (existing coverage
  already exercises the `GenerationWorkflow.resume()` presentation handoff)
- Test: `tests/integration/gameplay.integration.test.ts`

**Contract produced:**

- `GET /campaigns/:id/turns` accepts an optional opaque `before` cursor and a
  bounded `limit` (default 50, maximum 200). It returns the selected turns in
  ascending display order plus `nextCursor: string | null`; the cursor itself
  represents the earliest `(turn_number, id)` boundary in the page and is bound
  to the route campaign. The server parses it as untrusted input and never uses
  cursor-contained ownership as authorization.
- `GET /campaigns/:id/sync-status` accepts an optional opaque `since` token and
  returns a new `syncToken`, `turnWindowMode: "unchanged" | "replace"`, a
  bounded latest turn page when replacement is required, and null turn data when
  unchanged. The token is a server-computed fingerprint of the current
  owner/campaign projection, latest accepted-turn identity, and latest generation
  identity/status; it is an equality hint, not authorization or authoritative
  state.
- Sync status adds one sanitized `generationRecovery` summary for the latest
  actionable/result-recovery job (`recoverable | failed | completed`) when its
  outcome is not already represented by the returned accepted-turn window. It
  contains IDs, operation kind, expected turn, attempts, status, safe error
  metadata, and `resultTurnId`, never `partialOutput`, model response, mechanics,
  or provider credentials. A completed summary permits `fetchResult()` recovery;
  a recoverable/failed summary enters the existing workflow, which alone decides
  retry/discard versus the derived client-only `unrecoverable` outcome.

**Implementation status (2026-08-03):** Implemented bounded, history-versioned
cursor pages; discriminated sync windows; authoritative recovery precedence; and
C8 Story Player older-page loading with absolute turn-number commands. Real
PostgreSQL coverage records a 55-turn initial sync payload of 17,883 B and an
unchanged response of 3,042 B, alongside first/middle/last, exact-boundary,
empty-page, malformed, cross-campaign, replacement, rewind, and
completed-recovery checks.

- [x] Preserve the existing unparameterized route during this compatibility
  change, but make its response bounded to the latest page. Update the C8 Story
  Player adapter in `apps/web/src/story.js` in the same commit to request older
  pages on history demand; verify `story-generation-monitor.js` continues to
  delegate the authoritative recovery handoff to the workflow. Never ship a
  server response change that silently truncates the live client. Keep both
  modules inside the compiled Task 9 source graph; do not revive
  `apps/web/public/story.js`.
- [x] Cursor ordering is deterministic at duplicate timestamps and replacement
  boundaries. Add first/middle/last page, exact-boundary, empty-page, malformed,
  cross-campaign replay, rewind, and retry-latest replacement tests proving no
  duplicate or skipped turn.
- [x] `syncToken` changes for accepted completion, retry-latest replacement,
  rewind, campaign/world/config changes, and actionable generation transitions.
  An unchanged token suppresses turn transfer but never suppresses the current
  ownership-scoped campaign/world/player configuration.
- [x] Extend `GenerationWorkflow.resume()` to prefer current pending generation,
  then the sanitized authoritative recovery summary, then the validated local
  submission record. Ignore a completed recovery whose `resultTurnId` is already
  present in the returned turn window. Preserve the exact idempotency key and do
  not replay a submission merely because local storage expired.
- [x] Keep the complete accepted-turn ledger and generation rows authoritative in
  PostgreSQL. Cursors/tokens and client windows are rebuildable projections and
  never authorize a campaign, hide a server conflict, or become required to
  recover after browser data loss.
- [x] Run focused contract/client/workflow/Story Player tests, real-PostgreSQL
  boundary-page and recovery tests, then the full check/build/unit/integration
  gates. Record payload sizes for initial and unchanged resume responses.

**Definition of done:** C6 receives final bounded turn-window and sync/recovery
types; reload can recover actionable or completed work without depending on
unexpired browser storage; the live legacy client remains compatible; and every
cursor/token is validated and campaign-scoped.

---

## Task 13b — B4b: Profile and optimize play-loop read paths

**Runs after B3 and Task 13a-R (the corrected B4a surface) and gates all UI
work.** B4a
fixes public cursor/sync semantics; B4b measures and tunes their implementation
without changing those contracts.

**Files:**

- Create: `scripts/benchmark-play-loop.mjs`
- Create: `tests/integration/play-loop-read-performance.integration.test.ts`
- Create: `tests/unit/database-pool.test.ts`
- Modify: `packages/database/src/play-loop-read-repository.ts`
- Modify: `packages/database/src/pool.ts`
- Modify: `packages/database/src/index.ts` only if a new measured query helper
  requires export
- Modify: `services/api/src/server.ts`
- Create conditionally: `database/migrations/0053_play_loop_read_indexes.sql`
  only when recorded `EXPLAIN (ANALYZE, BUFFERS)` evidence justifies an index
- Review unchanged: `packages/contracts/src/client-api.ts` and
  `packages/contracts/src/generation.ts` — B4a/7P public cursor, sync, polling,
  and result contracts are frozen in B4b
- Test: `tests/unit/play-loop-read-repository.test.ts`
- Test: `tests/unit/client-api-routes.test.ts`
- Test: `tests/integration/gameplay.integration.test.ts`
- Test: `tests/integration/dashboard-stats.integration.test.ts`
- Test: `tests/integration/generation.integration.test.ts`
- Test conditionally: `tests/integration/migrations.integration.test.ts` when
  migration 0053 is created
- Modify: `docs/workflows/testing.md`

No request or response schema may change in B4b. A measured need to change a
page limit, token shape, response field, or SSE/polling projection is a public
contract finding that stops this task and returns to plan review; it is not an
optimization hidden inside `packages/contracts`.

- [x] Seed small, 200-turn, and long-running campaign fixtures with realistic
  world/version, job, image, and Chronicle cardinalities.
- [x] Measure campaign list, campaign sync, turn history, generation status,
  generation result, and initial Story Player hydration using the C0 profile.
- [x] Capture query counts and `EXPLAIN (ANALYZE, BUFFERS)` plans for slow reads;
  store summarized evidence, not environment-specific raw database dumps.
- [x] Add owner- and campaign-scoped indexes only where measured plans justify
  them. Verify write amplification and migration rollback implications.
- [x] Verify B4a's bounded turn/history and incremental-sync queries under the
  seeded long-campaign profile; tune their page/window defaults only with
  recorded payload, query-count, and render evidence. Do not change their public
  cursor semantics in this task.
- [x] Remove measured N+1 reads and avoid returning columns or nested records the
  play loop does not consume.
- [x] **Memoize the owner-identity lookup.** `initialOwnerId`
  (`packages/database/src/pool.ts`) issues
  `SELECT id FROM users WHERE system_key = 'initial-owner' AND status =
  'active'` on every call. At the 10c2 checkpoint there are **93** occurrences
  in `services/`; remeasure after Tasks 10-12 rather than treating that number
  as permanent. Cache the in-flight/resolved promise in a
  `WeakMap<DatabasePool | DatabaseClient, Promise<string>>` keyed by the actual
  pool/client object passed to the existing function, so concurrent calls on
  one pool coalesce while separate databases in the same test process can never
  share an owner UUID. Delete only a rejected promise from the map so a later
  successful bootstrap can be observed; a resolved UUID has no invalidation in
  the pre-auth process lifetime.
- [x] Add owner-cache tests proving one query for concurrent and sequential
  calls on one pool, different UUIDs for two pools/databases, no cross-pool
  reuse, preserved `Initial user is not bootstrapped.` failure, retry after a
  failed lookup, and separately cached/correct behavior when a transaction
  client is deliberately distinct. Do not export a reset hook used only by
  tests.
- [x] Keep this cache explicitly limited to lookup of the stable
  `initial-owner` bridge. When interactive authentication arrives, request
  handlers receive the session-resolved internal `user_id` and must stop calling
  `initialOwnerId()` for authority; do not turn this cache into a map of
  caller-supplied identities. Bootstrap/administrative code that genuinely still
  needs the initial owner may retain the stable cache.
- [x] Add query-count assertions for deterministic routes and a seeded-data load
  profile that reports p50, p95, payload bytes, error rate, PostgreSQL version,
  fixture cardinalities, warm-up/sample counts, and variance. Cover campaign
  list/dashboard, sync unchanged/replacement, first/middle/last history page,
  generation polling, result recovery, and initial Story Player hydration.
- [x] Treat the 10% regression budget as a guardrail, not proof of speed: record
  absolute baseline and post-change measurements and approve explicit targets
  after C0 evidence exists.

**Definition of done:** Long campaigns hydrate incrementally, list/history APIs
are bounded, hot-route query counts are protected, and measured p95 latency and
payload size improve without changing ownership or campaign isolation. U5's
200-turn rendering and payload budgets have recorded backend evidence rather
than an unverified assumption.

---

## Task 14 — B5: Continue backend modularization by domain

B1 establishes the pattern. Apply it after B4b, one independently deployable
domain at a time. These are named backend checkpoints, not optional follow-up
ideas, and all five gate the backend completion audit:

1. **Task 14a — B5a:** Illustration and image jobs.
2. **Task 14b — B5b:** Chronicle memory and embedding jobs.
3. **Task 14c — B5c:** Worlds, immutable versions, and campaign management.
4. **Task 14d — B5d:** Providers and prompt configuration.
5. **Task 14e — B5e:** Imports, exports, archives, and assets.

Each domain gets application ports, concrete database/provider adapters, API and
worker adapters, boundary checks, and existing integration coverage. Do not
create one generic repository or god service. Shared abstractions are promoted
only after two real domains prove the same shape.

### Which cross-role exception each domain closes

Verified against `CROSS_ROLE_IMPORT_ALLOWLIST` in
`scripts/check-client-boundaries.mjs` and the worker's imports. Task 10 removes
the `generation-service.js` entry; these five remain, and they are **not evenly
distributed across the domains**:

| Domain | Allowlist entries it removes | Worker symbol |
|---|---|---|
| **14a** Illustration and image jobs | **3** — `image-service.js`, `illustration-resolution-service.js`, `segmented-illustration-service.js` | `runImageJob`, `runIllustrationResolutionJob`, `runIllustrationPromptJob` |
| **14b** Chronicle memory and embeddings | **1** — `memory-service.js` | `runChronicleJob` |
| **14c** Worlds, versions, campaign management | **none** | — |
| **14d** Providers and prompt configuration | **none** | — |
| **14e** Imports, exports, archives, assets | **1** — `asset-service.js` | `runAssetMetadataBackfill` |

- [ ] **14a, 14b, and 14e prove completion by allowlist removal.** Each deletes
  exactly its own entries, converts the matching positive boundary fixture into
  a rejection, and leaves the other domains' entries explicit. A domain that
  removes an entry it does not own has overreached.
- [ ] **14c and 14d close no cross-role exception**, so they cannot use one as
  their completion signal and need a different one: their API routes must depend
  on application ports, with no SQL or domain state transition left in a Fastify
  handler, proved by the route-adapter tests Task 10c establishes. Say this in
  each brief so neither is declared complete by running a boundary check that
  was already green.
- [ ] **14a is the largest by a wide margin** — three exceptions and three worker
  entry points, against one each for 14b and 14e. Plan it as its own
  multi-commit series with per-service checkpoints, the way Task 10 was split,
  not as a single diff.

### Per-domain checkpoint structure

- [ ] Give each of 14a-14e its **own completion-table row** rather than the
  single shared `Task 14a-14e` row, so a partially migrated backend cannot read
  as complete. This mirrors the rule holding Task 10's top-level status at
  `Not started` until 10f.
- [ ] Each domain records its own `Current Task 14x verification` block with
  measured figures per the Task 4a P4 rule, and its own scoped review.
- [ ] Deliver every domain as four ordered, separately committed and reviewed
  checkpoints: **14x1 contracts/use cases**, **14x2 concrete adapters**, **14x3
  API/worker cutover and legacy removal**, and **14x4 full-domain parity audit**.
  Contracts and adapters are additive; only 14x3 may switch production callers
  and remove old callable implementations. Do not begin the next domain before
  14x4 passes.

### Frozen B5 dependency and temporary-binding policy

Early domains depend on capabilities whose final extraction occurs later. They
must express those dependencies as narrow application ports and bind the current
implementation only in `services/runtime` composition. They may not import a
later domain's `services/api/*-service.ts` implementation from application,
database, API adapter, or worker code. Every temporary binding is recorded with
one removal owner:

| Temporary capability introduced/consumed | First consumer | Removal owner |
|---|---|---|
| image provider, prompt snapshot, and cost recording | 14a illustration | 14d |
| asset persistence/read and filesystem storage | 14a illustration | 14e |
| embedding provider and memory cost recording | 14b Chronicle | 14d |
| text provider/prompt operations for world and character generation | 14c | 14d |
| archive/import asset storage and portable-file I/O | 14e | 14e (same checkpoint) |
| API-layer `loadOrNotFound` row helper in `service-helpers.ts` | 10d/14a/14c/14e | 14e, after its last asset consumer moves |

The runtime composition report maintains a machine-checkable inventory of these
bindings plus the Task 10d `GenerationExecutionCollaborators` inventory. A later
domain replaces the port adapter in place; it does not create a second port with
the same responsibility. Task 14f requires the temporary inventory to be empty.

### Task 14a — B5a: illustration and image jobs

**Current sources owned:** `services/api/src/image-service.ts`,
`services/api/src/illustration-resolution-service.ts`, and
`services/api/src/segmented-illustration-service.ts`; their routes in
`services/api/src/server.ts`; the three matching worker imports; and the
illustration callbacks in `GenerationExecutionCollaborators`.

**Create/modify:**

- Create `packages/application/src/illustration/{types,ports,use-cases}.ts` and
  export it from `packages/application/src/index.ts`.
- Create `packages/database/src/illustration-repository.ts` and export its
  factories from `packages/database/src/index.ts`.
- Create `services/api/src/illustration-application-adapter.ts` and
  `services/runtime/src/illustration-composition.ts`.
- Modify `services/api/src/server.ts`, `services/worker/src/worker.ts`,
  `services/runtime/src/main.ts`, the generation executor composition, and the
  boundary allowlist/tests.
- Test `tests/unit/image-library.test.ts`,
  `tests/unit/image-job-durability.test.ts`,
  `tests/unit/illustration-segmentation.test.ts`,
  `tests/unit/legacy-illustration-api.test.ts`,
  `tests/unit/image-artifact-download-security.test.ts`,
  `tests/integration/image-pipeline.integration.test.ts`,
  `tests/integration/generation.integration.test.ts`, and
  `tests/integration/world-library.integration.test.ts`; add pure application,
  repository integration, API-adapter, and worker-adapter suites under the same
  domain name.

14a1 freezes separate API and worker applications for illustration config,
world covers, accepted-turn/segment/backfill enqueue, job/result/retry reads,
library matching/rematch, and `runNextIllustration`. Every command/query carries
owner plus campaign/world/turn/job scope as applicable. 14a2 moves claim/lease,
prompt/refinement, resolution, image execution, retry, artifact download, and
asset binding behind concrete adapters while keeping text and image provider
profiles distinct. **14a2R is a mandatory corrective gate before cutover:** it
extends the worker application and ports with typed owner-scoped claim/load,
lease heartbeat, state transition, retry, prompt-resolution, and handler
operations for every illustration job family. It also adds an explicit
transaction-scoped generation collaborator that accepts the caller's database
client for accepted-turn segment enqueue and all five streaming callbacks. The
concrete PostgreSQL/runtime bindings must preserve one transaction for accepted
turn, state, Chronicle, and illustration enqueue. This additive checkpoint may
use a named, injected compatibility binding to the legacy state-machine bodies;
it must not import them directly from application code, and its tests must prove
the typed ports and transaction context—not an implicit service lookup—control
the call. The binding names, owners, and exact removal disposition are frozen
for 14a3, which owns moving the state-machine bodies and deleting the callable
legacy paths. The correction must not move live routes/worker lanes, remove
allowlist entries, or delete legacy code; it makes the later atomic cutover
possible. 14a3 follows
14a2R and switches routes and the worker, replaces the six Task
10d illustration callbacks, removes exactly the three 14a allowlist entries,
and deletes or reduces the three old services so no callable shadow remains.
14a4 proves images disabled/unavailable/incompatible/failed/retried never change
narration acceptance, fiction-only prompts exclude mechanics/private output,
artifact SSRF controls remain pinned, and owner/campaign isolation holds.

**Current Task 14a verification (2026-08-04, 14a1/14a2 complete):**
`e2a15e6` introduced the platform-neutral illustration applications and frozen
owner-scoped contracts. `ad039ccd` added the concrete PostgreSQL, provider,
artifact, asset, and runtime adapters; its initial review identified two
important architecture defects. Remediation `98a0b0f` moves the temporary
provider/asset bindings into `services/runtime/illustration-platform-bindings.ts`
and injects them into the adapter, then creates and delegates the typed image,
refinement, artifact-download, and asset ports through
`IllustrationWorkerApplication`. The re-review approved the cumulative range
`e2a15e6..98a0b0f`: no adapter imports `provider-service.ts` or
`asset-service.ts`, and no `server.ts`, `worker.ts`, runtime `main.ts`, route,
or boundary-allowlist change occurred. Focused illustration checks passed 13/13;
`pnpm check`, `pnpm build`, diff checks, and precheck passed. The real-PostgreSQL
repository tests are part of the checkpoint and passed when the test database
was available; a re-review environment without `TEST_DATABASE_URL` skipped
those two tests rather than treating them as evidence. **The initial 14a3
inventory found that 14a2's worker contract did not expose the legacy job state
machines and its application did not expose the transaction-scoped generation
callbacks. 14a2R therefore precedes cutover. Only after its scoped review may
14a3 perform the atomic live route/worker cutover and only then may the three illustration
allowlist entries, six temporary generation callbacks, and legacy callable
paths be removed.**

**Task 14a2R verification (2026-08-04, complete):** `6e8fe73` introduces the
owner/job/family/worker/lease-scoped worker-state port, three injected handler
bindings, and all six caller-owned transaction callbacks under
`IllustrationApplication.generation`. The exact corrective range
`98a0b0f..6e8fe73` was independently approved: the adapter uses the supplied
transaction client without opening a nested transaction; legacy job bodies are
runtime-only named compatibility bindings; and routes, worker loop, runtime
main, allowlist, and legacy deletions remain untouched. Targeted tests passed
15 with one intentional 14a3 skip, and `pnpm check` plus diff checks passed.

**Task 14a3 verification (2026-08-04, complete):** `71c7852` performs the
atomic live route, worker, and generation-callback cutover. It removes all
three 14a worker-to-API allowlist entries, moves the three retired API job
implementations to runtime-owned adapters with no forwarding paths, and routes
the six generation collaborators through the explicit transaction-scoped
illustration application port. The runtime state adapter is owner/job/family/
lease fenced and preserves each image, prompt, and resolution family’s claim,
recoverable, retry, and reclaim semantics. An independently reviewed production
API-wide import guard rejects real relative runtime imports without false
positives. Final verification passed: full unit **99 files / 1,179 tests**,
`pnpm check`, `pnpm build`, focused illustration boundary tests, the client
boundary scan, static retired-service search, diff checks, and precheck. The
next checkpoint, **14a4**, must prove behavioral parity under real PostgreSQL
and the defined image-independence/security/ownership cases before Task 14a can
be marked complete.

**Task 14a4 audit corrections (2026-08-04, required before completion):**

1. **Critical fiction-only correction.** Remove `scratchpad_private` and every
   mechanics/tracker/private-reasoning field from all illustration-context
   queries and refinement inputs. `scratchpad_safe_for_prompt` never authorizes
   private material for the illustration text or image paths. Add an adversarial
   real-PostgreSQL refined-segment test that captures both provider requests and
   proves those values are absent.
2. **Make ports live.** The default worker path created by runtime composition
   must use the typed image, refinement, artifact-download, and asset ports;
   their current test-only delegation is insufficient. Add a real-PostgreSQL
   worker-composition/default-lane test proving the port path handles prompt,
   resolution, image, artifact, and asset work without direct legacy-handler
   bypass.
3. **Route parity.** Add real Fastify + PostgreSQL coverage for config, jobs,
   segments, backfill, world-cover, turn/segment, resolution, and retry routes,
   including owner/campaign/world/turn/segment scope-derived `404`s and frozen
   response/status parity.
4. **Complete independence matrix.** Every disabled, unavailable,
   incompatible, failed, and retried image case must assert accepted narration,
   campaign state, and Chronicle snapshots are unchanged. The endpoint-
   unavailable and terminal-failure cases must no longer use turn count alone.
5. **Record runtime-to-API disposition.** Task 14a has no unowned coupling:
   move the illustration application adapter to runtime/platform code now, or
   name its exact 14d/14e replacement/removal owner and require Task 14f to
   verify it. Provider/asset service imports already belong to 14d/14e, but the
   illustration adapter itself cannot remain untracked.

**Task 14a completion audit (2026-08-05, complete):** the independently
reviewed cumulative range `e2a15e6..c7c8353` establishes platform-neutral
contracts, runtime-only adapters, atomic route/worker/six-callback cutover, and
deletion of all three former API job services and their three boundary
exceptions. The default worker lanes use typed provider, refinement, artifact,
asset, and cost ports; private scratchpads, mechanics, trackers, and private
reasoning are excluded from illustration prompt paths. Image artifact download
controls, owner/campaign/world/turn/lease fences, transactionally atomic asset
and cost writes, artifact variants, segment references, retries, and durable
ledger operation labels preserve the legacy behavior. Real PostgreSQL tests
prove disabled, unavailable, incompatible, failed, exhausted, and retried image
work never changes accepted narration, campaign state, or Chronicle memory.
The real Fastify/PostgreSQL matrix covers all 18 illustration routes, duplicate
branches, and missing/foreign/owned retry outcomes. Final evidence: full unit
**99 files / 1,180 tests**, full PostgreSQL integration **23 files / 241 tests**,
route/image matrix **28 tests** under the isolated sequential harness,
`pnpm check`, `pnpm build`, client-boundary scan, and diff/precheck all pass.
Task **14b** is now the next backend domain; UI remains blocked until Task 14f.

### Task 14b — B5b: Chronicle memory and embeddings

**Current sources owned:** `services/api/src/memory-service.ts`, its routes in
`server.ts`, the worker's `runChronicleJob` import, and the five Task 10d memory
callbacks. Contracts remain in `packages/contracts/src/memory.ts`; pure
Chronicle logic remains in `packages/story-engine/src/chronicle.ts`.

Create `packages/application/src/memory/{types,ports,use-cases}.ts`,
`packages/database/src/chronicle-repository.ts`,
`services/api/src/memory-application-adapter.ts`, and
`services/runtime/src/memory-composition.ts`. Modify server/worker/runtime and
the boundary allowlist. Cover `tests/unit/chronicle.test.ts`,
`tests/unit/semantic-memory-auto-enable.test.ts`,
`tests/integration/import-memory.integration.test.ts`, gameplay/generation
integration, plus new application/repository/adapter suites.

14b1 freezes applications for embedding configuration, context preview,
metrics, Chronicle/embedding reindex, derived-turn writes, state correction,
and `runNextChronicle`. 14b2 is a three-checkpoint adapter series: **14b2a**
extracts the private Chronicle helper behavior currently embedded in
`memory-service.ts` into testable platform-neutral/shared helper modules, with
behavioral parity for campaign scope, canonical facts, entity catalogues,
sanitization, embedding/provider fingerprinting, and safe error projection;
it does not move live consumers. **14b2b** binds every Chronicle repository and
runtime operation directly, including all five Task 10d transaction callbacks
and accepted-turn fiction writes, against the caller-owned client. It may not
inject a legacy service callback, open a nested transaction, or fall back to a
pool. **14b2c** proves the concrete PostgreSQL/runtime bindings with the full
Chronicle race, ownership, lease, work-version, rebuild, provider-selection,
and bounded-retrieval matrix. Only after all three checkpoints may **14b3**
switch API, worker, generation executor, campaign-transfer, world, import,
state-correction, rewind, and branch consumers; remove the memory allowlist
entry and all five Task 10d memory callbacks; and leave no worker import from
API. 14b4 proves accepted turns/state remain authoritative, summaries/embeddings
are rebuildable, rejected generations write no memory, and retrieval/reindex
cannot cross owner, campaign, world, or world-version scope.

**Task 14b readiness corrections (2026-08-05, required before implementation):**

1. **14b1 freezes the full persistence inventory and transaction port.** Assign
   every Chronicle/config/checkpoint/job/embedding table use in generation
   execution, generation, campaign-state, transfer, import, world, provider,
   and archive code a move-now, named-later-owner, or read-only disposition.
   Define caller-owned `MemoryGenerationTransactionPort` for all five Task10d
   callbacks and accepted-turn fiction writes; it accepts the outer client and
   never opens a nested transaction or pool fallback.
2. **All scopes are explicit.** API use cases accept resolved owner plus
   campaign/world-version scope; workers load owner/campaign/version from their
   claimed job and never re-resolve an initial user. Fastify remains the only
   pre-auth authority boundary.
3. **Public failures are safe projections.** Preview, metrics, and Chronicle
   job reads expose only a fixed safe code/message; raw provider errors remain
   diagnostics. Adversarial credential/endpoint-like errors must be absent from
   every public response.
4. **14b2 names runtime provider ports.** Embed profile selection/decrypted
   load, transport/fingerprint, health, cost, and safe logging are temporary
   14d-owned runtime bindings. A dedicated enabled embedding profile wins;
   text fallback applies only when none is enabled; image profiles/credentials
   never participate.
5. **14b2/14b4 preserve Chronicle mechanics.** Require oldest-first
   `SKIP LOCKED` claims, one live job per campaign, heartbeat/reclaim/fencing,
   work-version requeue, atomic batch progress/cost, hash/dimension/version
   guards, bounded owner/campaign/version retrieval, and no private, mechanic,
   rejected, or credential material in memory/embeddings.
6. **14b3 is one atomic consumer cutover.** Runtime composition injects API and
   worker applications; server, worker, generation, transfer, import, world,
   state correction, rewind, and branch consumers move together. Then remove
   the memory allowlist entry and all callable old paths.
7. **14b4 requires executable parity:** real Fastify/PostgreSQL coverage for
   all six memory routes (success, missing/foreign `404`, invalid `400`,
   disabled `409`, duplicate, safe failure); pure/repository/worker/lease/race
   tests; generation authority snapshots; import/transfer/rewind/branch
   rehome tests; and no-old-import/no-runtime-to-API static audits.

**Task 14b2 split (2026-08-05, required after implementation review):** The
initial staged adapter scaffold correctly demonstrates direct job
claim/lease/retrieval and runtime provider bindings, but it is not a valid
cutover foundation: rebuild, derived-memory, preview, embedding-reindex, and
accepted-fiction operations still delegate through injected compatibility
callbacks, and its PostgreSQL suite does not prove the complete ownership/race
contract. Do not commit that scaffold as a completed 14b2 checkpoint. Preserve
only its valid direct repository/binding work while completing these three
separately reviewed checkpoints:

1. **14b2a — extract behavioral helpers before adapter binding.** Identify the
   private helper logic used by `memory-service.ts` for campaign and world-version
   scope validation, accepted-fiction filtering, canonical facts/entity
   construction, memory sanitization, embedding eligibility, provider/model
   fingerprinting, and safe public errors. Extract only the reusable behavior
   into named testable modules under the application/domain boundary; retain API
   transport and live service ownership until 14b3. Write parity tests first,
   including private/mechanic/rejected-content exclusion and a future direct-port
   caller contract. No new compatibility delegate is allowed.
2. **14b2b — complete direct database and runtime bindings.** Implement each
   `MemoryGenerationTransactionPort` operation directly using the outer
   PostgreSQL client: `autoEnableCampaignEmbeddingIfAvailable`,
   `buildContextPreview`, `enqueueEmbeddingReindex`,
   `rebuildCampaignMemories`, `storeDerivedTurnMemories`, and the
   accepted-fiction write. Bind provider selection/load/transport/fingerprint,
   health, cost attribution, and safe diagnostics in runtime composition with
   the dedicated-enabled-embedding-then-text-only fallback rule. A direct port
   has no `MemoryService`/legacy callback parameter, no nested transaction, and
   no pool fallback. Fix `completeClaim` so a newer work version fences an old
   claim unconditionally, not only when a caller opts into requeue behavior.
3. **14b2c — prove the real PostgreSQL contract.** Add sequential, isolated
   integration coverage for oldest-first `SKIP LOCKED` claim exclusivity, one
   live job per campaign, owner/world-version/campaign isolation, lease
   heartbeat/reclaim/lost-lease fencing, unconditional work-version requeue,
   stale completion rejection, atomic batch progress/cost, hash/dimension/
   protocol guards, rebuild idempotence, bounded retrieval cursor/limit, safe
   provider failure projection, and image-profile exclusion. Exercise every
   direct transaction operation in a rollback/no-partial-write scenario so the
   later accepted-turn cutover can rely on atomicity.

**Corrected order:** **14b1** inventory, platform-free contracts/scopes,
transaction/worker ports, and safe errors; **14b2a** helper extraction and
parity; **14b2b** direct PostgreSQL/runtime bindings; **14b2c** real-PostgreSQL
contract matrix; **14b3** atomic cutover/removal; **14b4** route, worker/race,
authority/rebuild, safety, and static completion audit.

**Task 14b2a verification (2026-08-05, complete):** `5d0c3c2` extracts the
reusable Chronicle helper boundary without moving live service, route, worker,
repository, runtime-composition, allowlist, callback, or transaction ownership.
The retained service delegates campaign/world-version row validation,
accepted-turn fiction filtering, canonical fact and entity catalogue
construction, fiction sanitization, embedding eligibility, model-aware
fingerprinting, and the fixed public error projection to named application or
domain helpers. Focused parity tests prove rejected/private/mechanic content
cannot enter accepted fiction or memory values, direct callers reject mismatched
campaign/world-version rows, canonical facts preserve entity attribution and
deduplication, fingerprints normalize provider URLs, and public failures redact
provider-like diagnostics. Fresh controller verification passed **20/20 focused
tests across five files**, `pnpm check` (620 repository/data-safety candidates),
and `pnpm build`; diff and precheck passed. The independent scoped reviewer
approved the exact `fbed296..5d0c3c2` range. **14b2b** is next; the uncommitted
repository/runtime scaffold is not evidence of completion and must directly bind
all caller-owned transaction operations before it may be committed.

**Task 14b2b verification (2026-08-05, complete):** `dae333d` binds all six
`MemoryGenerationTransactionPort` operations directly to the exact
caller-owned PostgreSQL client; no operation uses a `MemoryService` callback,
compatibility factory, nested transaction, or pool fallback. The direct adapter
preserves explicit owner/campaign/world-version scope, accepted-fiction and
derived-memory sanitization, canonical facts/entity attribution, correction
provenance (`source_state_edit_id` with null Chronicle turn provenance), safe
preview diagnostics, and atomic stale-work-version requeue. Runtime bindings
load/fingerprint/health/cost against the caller context and enforce enabled
embedding profile priority, text fallback only without one, and image-profile
exclusion. The first scoped review found two important defects; correction
`261e224` moves post-claim retrieval/dispatch through the existing
lease-fenced `failClaim` policy and enforces the same owner-scoped provider
policy before configuration persistence and enqueue. The correction re-review
approved both fixes with no new breakage. Fresh controller verification passed
the **22/22** corrected adapter/repository tests, the full unit suite,
`pnpm check`, `pnpm build`, diff checks, and precheck. The two
`chronicle-repository` PostgreSQL cases are skipped without `TEST_DATABASE_URL`
and are deliberately not counted as completion evidence: **14b2c** now owns
the full real-PostgreSQL rollback, ownership, race, lease, and idempotence
matrix before live consumer cutover.

**Task 14b2c verification (2026-08-05, complete):** `aeeba49` adds the
isolated real-PostgreSQL Chronicle contract matrix and `92f03a7` corrects the
three defects found by its independent review. The matrix proves strict
oldest-first `SKIP LOCKED` claims, one live job per campaign under concurrent
queued and expired-sibling claims, expiry fencing for every claim operation,
unconditional stale-work requeue, owner/campaign/world-version isolation,
bounded cursor lookahead, deterministic null-snapshot correction IDs, and
rebuild idempotence. It also proves caller-owned outer transaction rollback for
direct operations plus atomic embedding-batch vector/cost/progress writes. The
first batch now requires exact progress continuity and locks the database
campaign config/provider before checking provider/model/prefix/protocol/
endpoint/fingerprint drift, so no caller-supplied first-batch configuration can
silently establish incompatible derived state. Fresh controller verification
passed **22 real-PostgreSQL tests with zero skips**, the related **34 unit
tests**, the full **1,213-test** unit suite, `pnpm check`, `pnpm build`, range
diff checks, and precheck; the scoped correction re-review approved the exact
`aeeba49..92f03a7` range without new findings. The new direct batch seam is
deliberately not live yet: **14b3** is the next atomic consumer cutover.

**Task 14b3 verification (2026-08-05, complete):** `21f0722` and `ad9dbc1`
began the consumer cutover; independent review rejected that range because it
relocated the legacy Chronicle body, bypassed the guarded batch repository,
reversed API/runtime composition, regressed metrics, retained optional
fallbacks, and left the full unit suite red. Correction `2e5daa7` completes the
atomic cutover: runtime now injects required API and worker memory applications;
every generation, transfer, world, import, correction, rewind, branch, archive,
and benchmark caller receives the exact transaction port; the worker executes
bounded pages through guarded `commitClaimBatch`; stale work versions requeue;
the full safe metrics/preview contract remains compatible with Nexus; and both
the original and renamed legacy memory-service files and symbols are absent.
The scoped correction re-review marked all five findings addressed with no new
findings. Fresh controller verification passed **1,220/1,220 unit tests**,
**264/264 real-PostgreSQL integration tests**, `pnpm check`, `pnpm build`,
legacy-file/symbol deletion scans, boundary scans, range diff checks, and
project-memory prechecks.

**Task 14b4 — Chronicle completion audit:** This separately briefed and
reviewed checkpoint verifies the final Chronicle cutover rather than inferring
coverage from 14b3. It required executable real-Fastify/PostgreSQL parity for
all six memory routes plus the
generic job read, covering success, invalid input, missing/foreign scope,
disabled conflicts, duplicate/retry behavior, resumable progress, and fixed
safe public failures. It exercised the composed production worker through claim,
bounded retrieval, heartbeat/reclaim, stale-work requeue, atomic vector/cost/
progress commit, rebuild, failure, and completion races. It proved accepted turns
and campaign state remain authoritative; rejected/incomplete generations write
no Chronicle state; summaries and embeddings rebuild from authoritative rows;
and retrieval/reindex cannot cross owner, campaign, world, or world-version
scope. It re-ran import, transfer, correction, rewind, branch, replacement,
and accepted-fiction rehome coverage using caller-owned transactions. It finished with
static audits proving no legacy memory symbol/file, cross-role memory allowlist
entry, API-to-runtime import, anonymous replacement callback, or optional
memory fallback remains. It recorded exact commands, pass/skip counts, base/head
SHAs, and independent review before Task 14b completion and the 14c handoff.

**Task 14b4 verification (2026-08-05, complete):** `56b35d2` adds the real
Fastify/PostgreSQL route, composed-worker, authority, rehome, and static
completion audit; `7003116` corrects the first review's heartbeat lifecycle,
composed durability/failure, authority-snapshot, and fixture-isolation
findings; and `ae92416` prevents late heartbeat lease loss from degrading a
healthy embedding provider. Reports were finalized in `c0437f4`, `680eb37`,
and `d32cefb`. The final audit exercises all six memory routes plus generic job
read; serialized/joined heartbeat, reclaim, lost-lease fencing, atomic vector/
provider/cost/progress completion, rebuild, and failure; owner/campaign/world/
world-version isolation; complete rejected/incomplete generation authority
snapshots; import, transfer, correction, rewind, branch, and replacement
rehome; and whole-tree legacy/import/fallback/callback removal. Both scoped
re-review rounds approved all findings with no residual blocker. Fresh
controller verification passed **1,228/1,228 unit tests**, **270/270
real-PostgreSQL integration tests**, `pnpm check`, `pnpm build`, range diff
checks, and project-memory prechecks. Task **14b is complete**; the Task 14c
identity/world/campaign extraction is the next backend domain.

**Pre-14c correction gate (2026-08-05, complete):** These small but
load-bearing verification corrections were required before beginning the
identity/world/campaign extraction.

1. **Initial-owner fixture isolation.** Replace the generation cancellation
   test's temporary reassignment of the global `initial-owner` system key with
   an explicit foreign-owner fixture. The test must create the foreign-owned
   campaign, provider, and job under that stable foreign UUID while the normal
   server-resolved initial owner remains unchanged. Prove the initial-owner
   cache cannot make the foreign job visible, and use `finally` cleanup that
   deletes only fixture-owned rows.
2. **PostgreSQL client concurrency warning.** Reproduce the full-suite `pg`
   warning that a client receives `query` while another query is executing;
   capture its call site, trace the shared-client data flow, and remove the
   overlap at the source. Add a focused regression that fails on the previous
   overlap and confirm the focused and full integration commands complete with
   no new warning. If the warning is emitted by external test infrastructure,
   retain the diagnostic evidence and record an explicit, bounded follow-up
   rather than silently accepting it.
3. Keep this gate separate from Task 14c: it may improve test/setup plumbing
   only and may not move world/campaign production ownership or defer the
   identity isolation proof into a later extraction checkpoint.

**Pre-14c correction verification (2026-08-05, complete):** `2cb2795`
replaces the global `initial-owner` system-key swap with an explicit foreign
owner/world/version/campaign/provider/job fixture; the stable server-resolved
initial owner receives a safe `not_found`, the foreign job remains queued, and
fixture cleanup deletes only its dependent rows. It also traces the `pg`
concurrent-query deprecation to `captureCampaignArchiveSnapshot` issuing
parallel reads on its one repeatable-read transaction client, and sequences
those reads (including the nested asset archive reads) through the same client.
A real-PostgreSQL regression observes the target warning rather than
suppressing it. The implementation was independently reviewed with no Critical
or Important findings. Fresh controller verification passed **271/271
integration tests with `--trace-deprecation` and no pg concurrent-query
warning**, `pnpm check`, `pnpm build`, diff checks, and project-memory
prechecks. Task **14c may now begin**.

### Task 14c — B5c: identity, worlds, versions, and campaigns

**Current sources owned:** `world-service.ts`, `campaign-state-service.ts`,
`character-profile-service.ts`, the remaining player-config/rewind/branch
portion of `generation-service.ts`, `campaign-transfer-service.ts`,
`world-generator-service.ts`, `world-generation-progress-service.ts`,
`dashboard-service.ts`, and `user-service.ts`, together with their server
routes. `play-loop-read-repository.ts` remains the B4a/B4b read adapter and is
consumed rather than duplicated.

**Ownership boundary (frozen before 14c1):** 14c owns reusable-world and
campaign semantics, including portable **world JSON** preview/import/export
(`previewWorldImport`, `importWorld`, and `exportWorld`) because they create or
read a world/version aggregate. Task 14e owns archive/asset/filesystem I/O,
legacy-story and Infinite Worlds imports, and campaign/archive export. Thus 14c
may depend on an opaque portable-world payload port but must not open archives,
stream multipart input, resolve filesystem paths, or take over 14e's import
records. Task 14e must consume the named 14c world-import/export application
port rather than reimplement world/version persistence.

**Complete current-state inventory (must be re-measured at every checkpoint):**

- `world-service.ts`: world list/get/create/draft-update/publish/status/fork;
  world JSON preview/import/export; campaign list/create/update/delete;
  playable-character reads; world/world-version deletion; and explicit campaign
  world-version migration. All become named 14c application methods or
  repository operations; no callable business export remains at 14c4.
- `campaign-state-service.ts`: effective-state edit, runtime-state read, and
  state correction. `generation-service.ts` contributes only player-config
  sync, rewind, and branch; all three become campaign application methods and
  its legacy callable exports are removed at 14c4.
- `character-profile-service.ts`: campaign profile get/update/organize and
  world-draft organizer. Its provider/prompt interaction is a 14c port only;
  credential loading, selected-model resolution, transport, and prompt snapshot
  implementation remain 14d-owned.
- `campaign-transfer-service.ts`: preview/commit transfer with idempotency,
  source/target ownership, migration history, and replacement/turn provenance.
- `world-generator-service.ts` and `world-generation-progress-service.ts`:
  preview and playable-character generation plus create/update/read/expired
  progress cleanup. Progress expiry is an application/repository operation,
  not a hidden Fastify request side effect. Generation uses a typed 14c
  collaborator port; no credential or text-profile object crosses the
  application boundary.
- `dashboard-service.ts` and `user-service.ts`: dashboard projection and
  server-resolved session-profile read/update. Initial-user bootstrap stays in
  database migrations/configuration, while session/profile use cases take an
  explicit `OwnerScope`.
- The direct `/api/v1/campaigns/:campaignId/sync-status` SQL assembly in
  `server.ts` is a required `getCampaignSyncStatus` 14c use case plus a
  repository read port. It composes the existing `play-loop-read-repository.ts`
  turn-page port; it must not duplicate cursor, snapshot, or bounded-read logic.

Every former `initialOwnerId` call in the inventory is replaced by an explicit
server-resolved `OwnerScope` at the Fastify composition boundary. This does not
authorize caller-supplied identity: the resolver remains server-only and the
worker gets only a claimed, database-derived owner scope. Each temporary 14c
provider/prompt/memory collaborator must be named in the runtime composition
with its producing task and deletion owner (normally 14d for provider/prompt
implementations); anonymous compatibility callbacks are prohibited.

Split this domain internally:

1. **14c1 — application contracts and pure use cases.** Create platform-free
   world/version, campaign lifecycle, campaign state, campaign sync, character
   profile, transfer, dashboard, session-profile, world-generation, and progress
   types/ports/use cases. Freeze command/read transaction ownership, `OwnerScope`,
   error/result mapping, and collaborator interfaces. Add pure tests for
   immutable publication, explicit migration/promotion, append-only/replacement
   facts, owner isolation, and transition errors. Do not route-cut over or leave
   fallback callbacks in this checkpoint.
2. **14c2 — PostgreSQL and collaborator adapters.** Create focused
   `world-repository.ts`, `campaign-repository.ts`,
   `campaign-state-repository.ts`, `world-generation-repository.ts`, and the
   sync/session/dashboard/character/transfer adapters as needed. Use one
   caller-owned transaction client for each atomic command; preserve advisory
   locking/idempotency and use read-only/repeatable snapshots where the current
   contract requires them. Add real-PostgreSQL adapter tests for foreign-owner
   invisibility, published-version immutability, deletion blockers, transfer
   provenance, rewind/branch authority, and progress expiry.

   **14c2 execution split (required):** 14c2a adds caller-owned transaction,
   world, and campaign-lifecycle adapters plus owner/locking/publication/
   blocker/migration coverage. 14c2b adds campaign authority and state adapters
   (sync, state, player config, rewind, branch) with fences, rollback, bounded
   reader reuse, and provenance coverage. 14c2c adds transfer and character
   adapters; organizer/provider work stays behind a named 14d-owned typed port.
   14c2d adds dashboard, session, progress expiry, and the typed world-generation
   collaborator seam, then runs the combined real-PostgreSQL adapter matrix and
   full parity verification. Each is additive, independently committed and
   reviewed; none edits routes/runtime/worker/legacy services or uses throwing
   placeholders, anonymous callbacks, nested transaction wrappers, credentials,
   or provider transport. 14c3 may consume only the final combined factories.

   **14c2a completion (2026-08-05):** `7ccf786`, `dc73210`, and `9a8387d`
   add caller-owned PostgreSQL transaction/world/campaign-lifecycle adapters;
   the accompanying recovery evidence is in `4ddf393`, `1e52ca2`, and
   `26df559`. Two correction rounds restored the complete lifecycle surface,
   serialized world deletion and target-version migration against concurrent
   writes, and preserved transaction-coupled Chronicle embedding bootstrap.
   Final scoped review approved with zero findings. Focused real-PostgreSQL
   coverage passed 10/10; the final implementation verification passed 1,238
   unit tests, 281 integration tests, `pnpm check`, build, diff, and precheck.
   14c2b is next; no route/runtime/worker/legacy-service cutover occurred.

   **14c2b sync subcheckpoint completion (2026-08-05):** `c3023b5`,
   `505023d`, and `e82f6b1` add the additive owner-scoped campaign-sync
   repository and its bounded turn-page adapter. The sync snapshot stays inside
   the caller-owned read transaction while changed windows delegate to the
   established B4 reader; it does not recreate cursor or snapshot logic. The
   correction rounds retain owner-scoped turn costs, validate the complete
   database-derived projection, translate malformed persisted data safely, and
   preserve numeric zero semantics. The final independent review found zero
   findings; focused real-PostgreSQL coverage passed 7/7 with `pnpm check` and
   diff checks. **14c2b remains active** for runtime-state, player-config,
   rewind, and branch adapters; no route/runtime/worker/legacy-service cutover
   occurred.

   **Remaining 14c2b delivery order (frozen):** 14c2b-state adds effective
   state-edit/runtime-state reads and state correction plus player-config sync,
   all owner-scoped and protected by the required expected-turn and
   state-revision fences. Its PostgreSQL matrix must prove foreign-owner
   invisibility, unchanged versus stale fences, rollback on invalid nested state,
   and that configuration writes cannot bypass the campaign-state revision.
   14c2b-history then adds rewind and branch operations, preserving append-only
   and replacement provenance, deleting only the permitted post-target derived
   state, and atomically rebuilding the authoritative state/history boundary.
   Its matrix must prove target/fence conflicts, branch lineage, rejected
   deletion, rollback, and cross-owner isolation. Each remains additive and
   independently committed/reviewed; 14c3 may consume them only after both are
   green.

   **14c2b-state completion (2026-08-05):** `83d75e3` adds owner-scoped
   effective/runtime-state reads, revision-fenced corrections, and
   revision-fenced player-config synchronization. Correction `d4dae94`
   preserves snapshot-only canonical facts when no active fact rows exist and
   makes all fixture cleanup exact-ID, transactional, FK-ordered, and
   repeatable. The final re-review approved with zero findings. Evidence: the
   focused real-PostgreSQL matrix passed 14/14 twice consecutively, full unit
   and integration suites passed 1,238/1,238 and 294/294, and `pnpm check`,
   diff, and precheck passed. **14c2b-history (rewind and branch) is next**;
   no route/runtime/worker/legacy-service cutover occurred.

   **14c2b-rewind completion (2026-08-05):** `d211364` adds the additive,
   caller-owned, owner-scoped rewind repository operation with exact active-turn
   and state-revision fences. Test correction `825cf4a` proves invalid-target
   no-mutation behavior, every active-work no-delete guard, deterministic
   post-delete rollback, and target-bounded cleanup while retaining durable
   replacement provenance. The correction re-review approved with zero
   findings; focused real-PostgreSQL coverage passed 21/21 with `pnpm check`
   and diff checks. **14c2b-branch is next**; no route/runtime/worker/legacy
   service cutover occurred.

   **14c2b-branch completion (2026-08-05):** `caa6dd1` adds the additive,
   caller-owned campaign-branch repository operation. It copies accepted
   history/state with merged durable branch and append/replacement provenance,
   keeps source campaign state/history immutable, and deliberately does not
   clone operational jobs, costs, or recovery records. The final independent
   review approved with zero findings; real-PostgreSQL coverage passed 26/26
   twice with `pnpm check` and diff checks. **14c2b is complete; 14c2c
   (transfer and characters) is next.** No route/runtime/worker/legacy-service
   cutover occurred.

   **14c2c completion (2026-08-05):** `908760c` adds additive PostgreSQL
   campaign-transfer and character-profile adapters; correction `10f66dc`
   preserves AI organizer protocol provenance and blocks transfers while every
   live/recoverable image-job state is active. The final re-review approved with
   zero findings. Focused real-PostgreSQL coverage passed 11/11 with `pnpm
   check` and diff checks. **14c2d (dashboard, session, progress, and
   world-generation collaborator seam) is next.** No route/runtime/worker/
   legacy-service/provider cutover occurred.

3. **14c3 — atomic composition and transport cutover.** Create named API
   adapters plus `services/runtime/src/world-campaign-composition.ts`, bind every
   `OwnerScope` at Fastify composition, and cut over all listed routes and any
   worker/world-generation caller in one reviewed checkpoint. Fastify retains
   validation, status/response projection, and transport-only archive handling;
   it contains no business SQL or state assembly. Move `/sync-status` to the
   application, preserve the B4 read-repository contract, and prove real Fastify
   route parity for every inventory item.
4. **14c4 — legacy removal and parity audit.** Delete/reduce old callable
   implementations only after 14c3 is green. Search all API/runtime/worker
   imports and exports, record a disposition for every inventory function, and
   prove no legacy world/campaign/profile/state/generation service remains
   reachable. Run the named world-library, world-generation/progress, gameplay,
   campaign-transfer, state-correction, dashboard, user-profile, client-route,
   pure-use-case, adapter-contract, and real-PostgreSQL suites.

**14c1 completion (2026-08-05):** Commits `dc1de51`, `80a0941`, `2a7748f`,
and `99ef161` establish the additive `packages/application/src/world-campaign`
boundary. It has explicit owner-scoped ports/use cases, transaction ownership,
closed transition errors, concrete immutable views, raw Date-bearing source
contracts, and application-owned ISO timestamp canonicalization. Campaign sync
delegates its changed 50-turn window to the existing bounded reader and does not
implement cursor or snapshot logic. Three independent correction reviews closed
the projection, Date-immutability, and raw-source/view consistency findings;
the final review approved with zero findings. Verification: focused 10/10,
1,238 unit tests, 271 integration tests, `pnpm check`, build, boundary, diff,
and project-memory prechecks passed. 14c2 is now next; no route, repository,
runtime composition, worker, or legacy-service cutover occurred in 14c1.

The initial-user resolver is injected at the Fastify boundary; no request field,
header, email, display name, or provider identity is accepted as authority.
Initial-user bootstrap remains idempotent and credential-free. Preserve non-null
ownership, immutable published versions, explicit campaign migration/promotion,
append-only accepted turns, durable replacement provenance, and deletion
blockers. On completion, the three campaign-operation `initialOwnerId` lookups
recorded by 10c3 and every 14c-inventory ownership lookup have moved to explicit
composition-scoped authority, and `generation-service.ts` has no remaining
callable responsibility.

### Task 14d — B5d: providers, prompts, intent, and cost

**Current sources owned:** `provider-service.ts`,
`prompt-library-service.ts`, `turn-intent-service.ts`, and `cost-service.ts`,
their routes/consumers, and every temporary provider/prompt/cost binding recorded
by 10d and Tasks 14a-14c.

Create `packages/application/src/providers/{types,ports,use-cases}.ts`,
`packages/database/src/provider-repository.ts`,
`packages/database/src/prompt-repository.ts`,
`packages/database/src/cost-repository.ts`,
`services/api/src/provider-application-adapter.ts`, and
`services/runtime/src/provider-application-composition.ts`. Cover provider,
prompt-library, turn-intent, cost-attribution, network-policy, lifecycle,
generation, image, memory, and world-generation tests plus new pure
application/repository/adapter suites.

14d1 freezes role-discriminated text/image/embedding/intent profiles and prompt
snapshot/version use cases. 14d2 binds encrypted credentials and the pinned
provider transport without putting secrets in application commands, logs, or
public errors. 14d3 switches routes and every temporary consumer, then removes
all provider/prompt/cost temporary bindings and old callable services. 14d4
proves text and image base URLs, tokens, inventories, selected models, health,
timeouts, and retry policies remain independent; no missing image profile falls
back to text; prompt-protocol changes invalidate chains explicitly; and provider
queries are owner-isolated.

### Task 14e — B5e: imports, exports, archives, and assets

**Current sources owned:** `asset-service.ts`, `asset-archive-service.ts`,
`campaign-archive-service.ts`, `import-service.ts`,
`infinite-worlds-import-service.ts`, business operations used by
`archive-routes.ts`, the worker asset-backfill import, and remaining temporary
asset/filesystem bindings. This is also the final removal owner for
`service-helpers.ts`: Tasks 10d, 14a, and 14c remove its generation, image, and
campaign-state consumers, and 14e deletes the helper after moving its last
asset consumer into a database adapter. `archive-routes.ts` and bounded
multipart parsing remain API transport; `archive-io.ts` becomes a
filesystem/archive adapter.

Create `packages/application/src/assets/{types,ports,use-cases}.ts`,
`packages/application/src/imports/{types,ports,use-cases}.ts`,
`packages/database/src/asset-repository.ts`,
`packages/database/src/import-repository.ts`,
`services/api/src/archive-application-adapter.ts`, and
`services/runtime/src/asset-import-composition.ts`. Cover archive contracts/I/O/
routes, asset archive/service/security, legacy/CYOA/Infinite Worlds import,
campaign archive/transfer, migrations, and image-pipeline suites plus new pure
application/repository/API-worker adapter tests.

14e1 freezes asset library/selection/backfill and preview/commit/export use
cases with explicit owner scope and opaque portable provenance. 14e2 implements
PostgreSQL plus filesystem/archive adapters with bounded streaming, path
containment, symlink/reparse rejection, hash/MIME verification, cleanup, and
transactional ownership. 14e3 switches archive routes, imports, exports, image/
world consumers, and worker backfill; removes the final asset allowlist entry
and all temporary asset bindings; and removes old callable business services.
14e4 proves aggregate archive caps, rollback/cleanup, owner assignment,
cross-install source IDs never authorizing records, complete portable JSON/ZIP
round trips, and no private campaign/export fixture enters source control.

- [ ] Treat each numbered domain and its four frozen checkpoints as a
  separately briefed/reviewed commit series. Re-measure route/function/import
  counts at checkpoint start and record drift, but do not defer architecture or
  file ownership to a future planning task.
- [x] Illustration extraction preserves the independent image provider profile,
  credential/model/health/retry lane and the rule that image failure cannot
  affect accepted narration.
- [x] Chronicle extraction keeps accepted turns/campaign state authoritative,
  keeps summaries/embeddings rebuildable and campaign-scoped, and prevents any
  prompt/retrieval cross-campaign access.
- [ ] World/campaign extraction preserves immutable world-version pins, explicit
  migration/promotion, non-null owner scope, and append-only accepted turns.
- [ ] Provider extraction never shares text/image secrets or silently falls back
  between roles. Import/export extraction assigns imports to the server-resolved
  user and treats portable source IDs as provenance only, never authorization.
- [ ] Every domain adds pure use-case tests, adapter contract tests, real-
  PostgreSQL transaction/isolation tests where applicable, and no-cross-role
  import assertions before the previous service implementation is removed.

**Backend modularity completion criteria:**

- API and worker roles import no implementation from one another.
- Fastify handlers contain transport parsing and response mapping, not business
  state transitions.
- Worker loops contain scheduling and lifecycle control, not domain rules.
- Application packages depend on ports, contracts, and pure domain rules.
- PostgreSQL and provider clients are replaceable adapters tested against port
  contracts.
- Every use case requires explicit owner/campaign/world scope.

---

## Task 14f — Backend completion audit and UI authorization gate

**Runs after Task 14e.** This is the only task that may authorize Task 15/U1.
It audits the complete backend result; it does not implement framework routes,
components, styles, browser visual tests, or any other `apps/web-next` UI work.

- [ ] Verify API and worker roles have no implementation imports from one
  another across every extracted domain; record the exact boundary command and
  reviewed exceptions (normally none).
- [ ] Prove both cleanup inventories reach zero: the five Task 14 cross-role
  allowlist entries and every temporary runtime collaborator recorded by 10d or
  Tasks 14a-14c. Run the boundary scanner, search runtime composition for each
  recorded legacy symbol, and fail the audit on any anonymous replacement
  callback or unowned exception.
- [ ] For every current business source named in the 14a-14e inventories, record
  one disposition: deleted, reduced to a transport adapter, or replaced by a
  named application/database/runtime module. Verify no old and new callable
  implementations remain reachable. Infrastructure-only `request-security.ts`,
  `archive-routes.ts`, `archive-io.ts`, `admission-service.ts`, and
  `app-metadata.ts` may remain only within their documented transport/runtime
  responsibilities.
- [ ] **Assert `CROSS_ROLE_IMPORT_ALLOWLIST` is empty.** This is the crisp,
  machine-checkable form of the criterion above. The list holds six entries
  today: Task 10e removes `generation-service.js`, 14a removes three, 14b one,
  and 14e one. If it is non-empty at this gate, some domain is incomplete
  regardless of what its report claims. Add a test asserting emptiness so the
  condition cannot regress after the audit.
- [ ] Re-run all pure application, adapter contract, real-PostgreSQL,
  ownership/isolation, generation-integrity, image-independence, import
  ownership, migration, and deployment smoke suites required by the repository
  specification.
- [ ] Re-run and record B2 notification query/latency evidence, B3 concurrency
  1/2/4 throughput and fairness evidence, and B4b query-plan/payload/p95 evidence
  on the documented test profile. Do not authorize UI work from unit tests alone.
- [ ] Review each B5a-B5e completion report for exact route/worker/transaction/
  ownership coverage and confirm old cross-role implementations were removed
  only after replacements passed.
- [ ] Reconcile architecture, deployment, operations, configuration/secrets,
  migration/rollback, and testing documentation with the shipped backend. Keep
  text/image provider secrets and runtime settings independent in all manifests.
- [ ] Render Compose and Swarm manifests, run the same-image API/worker/all-role
  smoke, rehearse rollback across any new online migration, and verify listener
  reconnect, worker drain/forced-stop lease recovery, initial-owner bootstrap,
  and separate text/image secret wiring. No UI route, component, style, or
  browser visual artifact may change in this backend audit range.
- [ ] Run `pnpm check`, `pnpm build`, `pnpm test:unit`,
  `pnpm test:integration`, `git diff --check`, complete-diff review, and
  `pjm precheck`; record a named backend audit report with command results,
  exact pass/fail/skip counts, benchmark links, Node/pnpm/PostgreSQL versions,
  base/head SHAs, known limitations, and scoped review approval. Compare skipped
  tests to the pre-Task10 baseline; any new skip needs a named blocking issue
  and cannot be used to authorize UI work.

- [ ] **Record the authorization in this plan, not only in the audit report.**
  Flip the Task 14f completion row, add its `Current Task 14f verification`
  block, and state in **Completion status** that Task 15/U1 is authorized. Task
  7d already demonstrated the failure mode: it produced a correct Track C exit
  audit artifact while the plan still showed every stage `Not started`, so the
  next agent could not tell from the plan that the gate had passed. A gate whose
  result lives only in a review document does not function as a gate.

**Definition of done:** Tasks 10, 11, 12, 13b, and 14a-14e are complete and
reviewed; `CROSS_ROLE_IMPORT_ALLOWLIST` is empty and asserted so by a test; all
backend architecture, correctness, isolation, performance, deployment, and
rollback gates have current evidence; and both the audit report **and this
plan's Completion status** explicitly mark Task 15/U1 authorized. Until then,
every Track U task remains blocked.

---

# Track U — Slice 1 replacement UI

**Depends on:** Track C complete through Task 7d and Track B complete through
Task 14f. The backend-first policy is a hard delivery gate: no Task 15-20
implementation begins while Task 10, 11, 12, 13b, 14a-14e, or the backend
completion audit remains open. This is intentionally stricter than the minimum
runtime dependency graph and prevents UI work from hiding unfinished backend
modularity, delivery, throughput, or long-campaign risks.

**Screens:** `NEX-WORLDS` (minimal), `NEX-CAMPAIGNS` (minimal), and
`STORY-PLAYER`, plus the shell-level `SYS-ERROR` state.

**Flows:** The minimal create/select branch of Flow 1 and Flows 2, 6, 7, 8, 9,
and 11 from `INTERACTION_FLOWS.md`. Recovery, retry-latest, and authoritative
resume are included here even though the older frontend roadmap grouped some of
them under Slice 2: exposing generation without those already-shipped safety
paths would regress the current Story Player and violate the generation
integrity requirements.

**Non-goals:** Full world authoring and publication, campaign configuration depth,
illustrations, providers, prompt library, imports, and global removal of the
legacy management client. Those land in later slices through the same client
and application boundaries. U3 may create a minimal draft, but editing and
publishing that draft remain in the legacy `/nexus/` UI until the world-
management slice. A pre-published world fixture is used for Slice 1 E2E.

## Task 15 — U1: Framework app scaffold

**Files:**

- Modify: `apps/web-next/package.json`
- Replace: `apps/web-next/src/bootstrap.ts` with the selected framework entry
- Create: router, route-error boundary, root component, and route placeholders
  for `/worlds`, `/campaigns`, and `/play/:campaignId` under
  `apps/web-next/src/`
- Create: `apps/web-next/src/client.ts`
- Create: `apps/web-next/src/styles/tokens.css`
- Create: `apps/web-next/src/styles/base.css`
- Create: `tests/unit/web-next/app-scaffold.test.tsx` (or the selected
  framework's equivalent DOM test extension)
- Create: `tests/unit/web-next/tokens.test.ts`
- Create: `docs/architecture/adr-00xx-replacement-ui-framework.md`
- Modify: `.github/workflows/ci.yml`
- Modify: root scripts and `pnpm-lock.yaml`

- [ ] Select the framework and record it in an ADR with bundle, accessibility,
  SSR/static-SPA fit, routing, test tooling, team-familiarity, dependency health,
  and long-term maintenance trade-offs. Record the exact production and test
  entry files selected by the framework.
- [ ] **Mandatory plan-refinement gate:** after the ADR and before U2 code,
  replace Tasks 16-20's framework-neutral file descriptions with exact component,
  route, test, and fixture paths and confirm that no chosen library changes the
  client-core/client-web boundary. Review that plan-only diff before continuing.
- [ ] Import client behavior only through public `client-core`/`client-web`
  surfaces.
- [ ] Create real `/worlds`, `/campaigns`, and `/play/:campaignId` routes with a
  direct-load/deep-link test; lazy-load management routes while keeping the core
  play-loop bundle within the approved budget.
- [ ] Install error boundaries and a global unavailable state without hiding
  correlation IDs or swallowing schema failures.
- [ ] Define one token contract for typography (including narrative measure),
  spacing, shared breakpoints, surface/elevation, focus, status, motion, and
  **both dark and light color roles**. Ship `dark | light | system` preference in
  Slice 1, default to system when no local preference exists, apply it before
  first paint without inline script/CSP exceptions, and store only the theme
  preference—not identity or authoritative data—in browser storage.
- [ ] Add global `prefers-reduced-motion` handling and token-level contrast tests
  for both themes, including status text/fill and focus-ring/surface pairs.
- [ ] Run type checks, production build/deep-link smoke, bundle budgets, token
  tests, and an empty-shell axe/keyboard test in CI.

**Definition of done:** The Task 8 preview is replaced by a routed, CSP-safe,
framework app; the framework decision and exact remaining file plan are
reviewed; both themes and accessibility primitives exist before feature styling;
and the shell cannot import backend/service implementation modules.

## Task 16 — U2: App shell

**Framework-neutral file scope (made exact by U1's refinement gate):** root
layout, primary navigation, breadcrumb, user-context/profile control, theme
control, toast region, active-generation indicator, error/unavailable view,
dialog/drawer primitives, shell styles, and their component/accessibility tests.

- [ ] Build persistent navigation with a real `<nav>`, a
  `<nav aria-label="Breadcrumb">`, one `<main>`/one page `<h1>`, and a first-
  focusable skip link. Show the current world version/campaign context in
  programmatically available page structure, not only visual chrome.
- [ ] Preserve a shell-level profile/settings entry and display the server-
  resolved user projection without turning its UUID/system key into an auth
  header, request field, or browser authority.
- [ ] Add one `aria-live="polite"` toast/status region, an assertive alert path
  for failures needing immediate attention, and a persistent active-generation
  indicator that survives route navigation through the campaign store.
- [ ] On SPA navigation move focus to the new page heading/skip target. Dialogs
  and drawers have accessible names, trap/contain focus, close with Escape where
  appropriate, and return focus to their opener.
- [ ] Use native controls wherever possible; every custom control supports Tab,
  Shift+Tab, Enter, and Space as applicable and has a visible token-driven
  `:focus-visible` ring.
- [ ] Implement responsive shell reflow with no page-level horizontal scroll at
  320 CSS px and no clipping at 200% zoom. Honor reduced motion globally.
- [ ] Render `SYS-ERROR` only for shell-wide health/unavailable failures; retain
  safe correlation IDs and a retry action, while route-local errors stay local.
- [ ] Component tests cover keyboard navigation, route focus, dialog focus
  return, live-region behavior, active-job persistence, error boundaries, theme
  persistence/system changes, 320 px reflow, and 200% zoom assertions.

Presentation code may branch on `GenerationEvent.type`; it may not interpret raw
job statuses or implement retry/cancellation policy.

**Definition of done:** All Slice 1 routes share one accessible, responsive
shell and notification/error model, and navigation cannot lose or duplicate an
active generation projection.

## Task 17 — U3: World selection

**Framework-neutral file scope (made exact by U1):** worlds route, world list and
card components, search/status filter, minimal-create form/dialog, loading/empty/
error states, route/component tests, and typed fixture builders.

- [ ] Load worlds through the typed client, distinguish draft/published/archived
  state in text and icon as well as color, and select an immutable published
  version for campaign creation. Keep filtering client-side for current list
  sizes; debounce only expensive filtering/render work, never the input's visible
  value, and use stable keys/selectors so unrelated store updates do not rerender
  every card.
- [ ] Implement the Slice 1 **minimal world-create branch** with the C8-adopted
  `POST /worlds` contract and field-associated validation errors. It creates a
  draft only. After creation, explain that publishing/full authoring remains in
  legacy Nexus and provide an explicit same-origin `/nexus/` continuation link;
  do not pretend a draft can start a campaign.
- [ ] Distinguish loading, fetch error with retry, no worlds, no published worlds,
  no search matches, and populated results. A zero-world user gets a create
  action; a draft-only user gets precise publication guidance rather than an
  empty campaign form.
- [ ] Give search and create fields real labels, associate validation issues via
  `aria-describedby`, and support complete keyboard selection at 320 px/200%.
- [ ] Tests cover each state, draft creation, published-version selection,
  archived exclusion/filtering, stale selection after refetch, malformed server
  payload, no identity spoof fields/headers, and the legacy-authoring handoff.

**Definition of done:** A user can create a minimal draft or select a published
world version through validated contracts; the UI never confuses mutable draft
content with campaign-pinned immutable canon.

## Task 18 — U4: Campaign creation and resume

**Framework-neutral file scope (made exact by U1):** campaigns route, list/card,
create form, playable-character picker, resume controller/view, empty/error
states, component tests, and test fixtures.

- [ ] List and search campaigns through the typed client and show campaign,
  world, immutable world-version, status, and last-played context. Distinguish
  loading, error, no published worlds, no campaigns, and no search matches.
- [ ] Create a campaign only from the selected published world version through
  C8's shared create schema. Load playable characters through its shared schema,
  preserve the selected character snapshot contract, map validation issues to
  fields, and never send caller-supplied `user_id` or identity headers.
- [ ] On resume, call `syncStatus` before opening a watcher. Reconcile in this
  order: authoritative pending job, authoritative recovery summary, validated
  local pending-submission hint. Attach the matching job; never submit a second
  generation merely because local storage is missing or expired.
- [ ] If the sync token is unchanged retain the current window; if replacement
  is required atomically replace it; expose older-history loading via the opaque
  cursor without treating cursor contents as authority.
- [ ] Surface an active-generation conflict as a campaign-specific attach/resume
  path. A completed recovery not represented in the window fetches its accepted
  result; a failed/recoverable summary exposes existing retry/discard actions.
- [ ] Tests cover create success/validation/conflict, character selection,
  immutable-version display, all three empty states, pending/recovery/completed
  resume, expired/malformed local hints, unchanged/replaced windows, campaign
  switch cancellation, reload without duplicate submission, and cross-campaign/
  cross-user isolation.

**Definition of done:** Campaign creation is schema-validated and owner-scoped;
reload/resume always converges on authoritative server state before any watch or
submission begins.

## Task 19 — U5: Story Player

**Hard prerequisites:** B4b performance evidence and U4 authoritative resume.

**Framework-neutral file scope (made exact by U1):** player route, narrative
reader, generation progress/recovery panel, Action/Scene/Auto composer,
replacement banner, choices, paged history drawer, route controller, styles,
component tests, visual fixtures, and performance harness.

Consumes `GenerationEvent` and store selectors:

| Event | UI response |
|---|---|
| `status` | Stage copy and progress affordance |
| `narration` | Incremental, safely rendered narration |
| `degraded` | Visible reconnect/polling state |
| `detached` | Explain that the durable job continues and can be resumed |
| `result_unavailable` | Keep the completed job visible and retry `fetchResult()` only; never resubmit generation |
| `settled/completed` | Append authoritative result and reconcile campaign |
| Other settled outcomes | Error/recovery/cancel/discard affordance |

Includes Action/Scene/Auto input, submit, explicit cancel, turn history, and
unrecoverable recovery. Load history through the stable cursor contract and keep
the latest accepted window immediately available. Rendering must stay responsive
with the 200-turn fixture; defer offscreen turn rendering or virtualize only if
the measured 50 ms task budget is exceeded.

- [ ] Render progressive **sanitized narration** from `narration` events as
  selectable text, with app-owned cursor/live badge and scroll-follow behavior;
  never render `partialOutput`, mechanics, parser diagnostics, rejected text, or
  HTML from the model. Atomically replace the preview with the validated accepted
  result.
- [ ] Show meaningful stage transitions through one throttled polite live region,
  not one announcement per SSE frame. Announce failed/action-required states
  assertively, while degraded transport remains distinct from generation failure.
- [ ] Keep Action, Scene direction, and Auto explicit. For Auto, display the
  resolved Action/Scene mode before submission; discard a classification result
  if the input/mode changed while classification was pending.
- [ ] Visually and textually distinguish retry-latest from append: state that the
  accepted turn remains until replacement validation, keep it visible while the
  replacement runs, and confirm preservation after replacement failure.
- [ ] Expose explicit remote cancel separately from local detach/navigation.
  Preserve retry/discard for recoverable/failed/unrecoverable outcomes. Treat
  `result_unavailable` as accepted-but-not-yet-fetched and retry `fetchResult()`
  only; never re-enqueue narration.
- [ ] Handle the unique active-generation conflict by attaching/resuming the
  authoritative job. Render generated choices as native buttons that populate
  or submit through the same validated path, and cover the brand-new campaign/
  first-turn state.
- [ ] Prepend older history pages without duplicates, preserve current reading
  position/focus, and provide an accessible history drawer with focus return.
- [ ] Narrative content meets the narrative measure/line-height tokens, remains
  fully usable at 390×844, reflows at 320 CSS px, and has no clipping/content loss
  at 200% zoom. All fields have real labels and all status/control meaning is
  text/icon plus color.
- [ ] Component/visual tests cover every event row above, progressive-to-final
  replacement, Auto stale-result rejection, retry-latest success/failure,
  conflict attach, cancel versus detach, result fetch retry, first turn, choices,
  multi-page history, route leave/return, both themes, reduced motion, keyboard,
  live-region throttling, 320/390 px layouts, and 200% zoom.

Do not generalize image, Chronicle, and world-cover monitoring merely because
they all have a status field. A generic watcher may be extracted into
client-core/client-web during U5 only after at least two families have shared
runtime response schemas, typed API methods, explicit terminal predicates, and
browser sources. Until those prerequisites exist, use family-specific adapters
and keep their payloads distinct.

## Task 20 — U6: Slice 1 testing

**Files:** exact Playwright/axe/visual harness, Compose fixtures, framework test
setup, CI jobs, and screenshot locations are named by U1's refinement gate;
modify `docs/workflows/testing.md` with commands, environment requirements,
budgets, and failure triage before this task closes.

- [ ] Keep workflow policy in client-core tests and rendering behavior in
  component tests. Cover idle, enqueue, classification, streaming, degraded,
  detached, recoverable, failed, unrecoverable, result-unavailable, completed,
  cancelled, discarded, conflict, and malformed-contract states with synthetic
  typed events.
- [ ] Run contract tests against real Fastify route projections and integration
  tests against PostgreSQL plus deterministic text/image provider fakes. Prove
  rejected/incomplete generation does not mutate state/memory, prompts never
  cross campaign/owner scope, and story completion survives disabled,
  unavailable, incompatible, retried, or failed illustration work.
- [ ] Re-run initial-owner bootstrap idempotency, pre-auth automatic ownership,
  import ownership, caller-identity spoof rejection, and cross-user isolation
  suites. Interactive OIDC remains out of Slice 1; do not add a first-login
  ownership shortcut. Its future implementation must test explicit
  `(issuer, subject)` linking to the existing initial user's unchanged UUID.
- [ ] Playwright against the test Compose stack covers: create a minimal draft;
  select a seeded published world; create a campaign and choose a playable
  character; submit Action and Auto turns; observe progressive narration and
  completion; page older history; and reload/resume without duplicate
  submission.
- [ ] Add E2E variants for retry-latest preserving the accepted turn until
  validation, active-job conflict attach, degraded SSE-to-poll fallback,
  recoverable retry/discard, result-unavailable fetch retry, terminal failure,
  cancellation, browser-storage expiry, and API restart during an active job.
- [ ] Axe runs against every route and material state in both themes. Complete
  keyboard-only and NVDA or VoiceOver passes for the vertical slice, including
  dialog/drawer focus containment and return, route focus, form errors, and
  throttled progress announcements.
- [ ] Visual regression covers loading/empty/error/populated lists plus idle,
  generating, degraded, recoverable, replacement, completed, and `SYS-ERROR`
  at desktop, 390×844, and 320 px in dark/light themes and reduced motion.
- [ ] Verify 200% zoom/reflow, token contrast, focus visibility, bundle budgets,
  route chunking, 200-turn long-task/render budgets, initial and unchanged sync
  payload budgets, and container deep-link/static-cache behavior.
- [ ] Run `pnpm check`, `pnpm build`, unit, integration, E2E, visual,
  accessibility, container/Compose smoke, `git diff --check`, complete-diff
  review, and `pjm precheck`; record commands/results in the completion block.

**Definition of done:** Slice 1 has automated and manual evidence for the
specified happy, recovery, accessibility, responsive, identity-isolation, and
generation-integrity paths; no waived gate is hidden as a generic follow-up.

## Slice 1 exit criteria

1. The full play loop works at `/app/`; `/nexus/` and `/story` remain functional
   and default.
2. No replacement-UI code imports backend services, database code, or provider
   implementations.
3. The replacement UI contains no generation status transition, idempotency,
   resume, polling, or retry policy.
4. All adopted API responses are runtime-validated.
5. Streaming degradation and local detach are visible and distinct from remote
   cancellation.
6. Retry-latest, authoritative resume, active-job conflict, recovery, and
   result-fetch failure preserve accepted turns and never duplicate submission.
7. WCAG 2.2 AA, keyboard/screen-reader, dark/light, 320 px/200% reflow,
   reduced-motion, visual, contract, E2E, bundle, and runtime performance gates
   pass.
8. Slice 1 feature code is confined to `apps/web-next` and public client-package
   extensions. Root lockfile/build metadata changes are allowed and reviewed;
   backend behavior changes are not.

---

## Test migration and legacy retirement sequence

The current source-string tests are removed only when equivalent behavior has a
real replacement:

| Existing coverage | Replacement point |
|---|---|
| Generation submission, resume, retry, cancel, and SSE/poll assertions | C4-C8 client tests and legacy integration |
| Story Player rendering assertions | U5 component, accessibility, visual, and E2E tests |
| Dashboard/world/campaign management assertions | Their later replacement UI slices |
| Prompt and CYOA pure helper assertions | Direct helper extraction in the owning later slice |
| CSP and required static document structure | Keep as structural tests |

There is no Slice 0 requirement to eliminate every source-text assertion. The
final requirement is that no test uses source spelling as a substitute for
behavior once the corresponding replacement behavior exists.

---

## Documentation alignment required during implementation

- Update `CLIENT_CORE_BOUNDARY.md` to distinguish pure client-core from
  Web-platform adapters and to replace “all routes in Slice 0” with incremental
  endpoint adoption.
- Update `API_UI_CONTRACTS.md` to state that progressive `partialNarration` is
  currently rendered, client code must not parse `partialOutput`, cancellation
  is an active endpoint, and B4a's cursor/sync/recovery shapes supersede the
  unbounded response descriptions.
- Update `FEATURE_IMPLEMENTATION_MATRIX.md` and `INTERACTION_FLOWS.md` so active
  cancellation, progressive narration, Auto resolution, retry-latest
  replacement, and completed-result recovery match the implemented contracts.
- Keep `OPEN_QUESTIONS.md` Q1-Q8 resolutions authoritative; remove work items
  that imply Q1/Q2 remain open and carry Q8's dark/light decision into
  `DESIGN_SYSTEM.md` and the U1 tokens.
- Update `FRONTEND_IMPLEMENTATION_PLAN.md` so source-string tests retire by
  replacement slice, `/app/` build/serve plumbing lands before Slice 1, and the
  safety-critical recovery/resume behaviors absorbed by this Slice 1 plan are no
  longer described as absent until Slice 2.
- Update `PRODUCT_UX.md` and `SCREEN_INVENTORY.md` only where the minimal Slice 1
  draft-create/published-world selection boundary or shell `SYS-ERROR` scope
  would otherwise imply full world authoring in U3.
- Record backend application boundaries and notification/concurrency choices in
  ADRs before their implementation merges.
- Document performance commands, budgets, and exceptions in the contributor and
  deployment documentation.

---

## Dependency graph

```text
[C0-C5 done] -> C7 -> C8 -> B4a -> B4a-R -> 7P -> 7a -> 7b -> 7c -> 7d
                                                                         |
                                                                         v
                      B1 -> B2 -> B3 -> B4b -> B5a -> B5b -> B5c -> B5d -> B5e
                                                                                 |
                                                                                 v
                                                               backend audit (14f)
                                                                                 |
                                                                                 v
                                                       UI authorized -> U1 -> U2 -> U3 -> U4 -> U5 -> U6
```

**C0 through C8 are complete** (Tasks 1-9, including C1a, C2a, C3a, C4a, 7P,
and C6 stages 7a-7d); B1 through B5b are also complete. **Task 14c (B5c) is
active:** 14c1 and 14c2a are complete, and 14c2b is the current implementation
checkpoint. The backend-first sequence continues 14c2b → 14c2c → 14c2d → 14c3
→ 14c4 → B5d → B5e → 14f. Task 14f remains the explicit UI authorization gate.
No backend package or UI task runs in parallel with that declared sequence unless
this plan is deliberately revised and re-reviewed.

**C6 does not gate C8 — this was previously drawn as `C6 -> C8` and is
corrected.** Task 9 never consumes the C6 stores or selectors. C6's consumers
are U2-U5, and it is sequenced after C8 and Task 13a-R so it is built once against the
rewired Story Player and final bounded history/sync contracts.

**C7 gated C8 — this was previously drawn as parallel and is corrected here.**
C7 supplied `apps/web/src/legacy-client-entry.ts` and the Vite build; completed
C8 now compiles the Story Player's client-package imports through that entry and
no longer publishes the raw imported module graph from `publicDir`.

C1a gated C2 because C4 models its event stream on the C1 stream projection;
correcting that projection after C4 exists would have meant rewriting the event
model and its tests. B4 was split because its public cursor/sync shapes had to
land before C6, while measured query/index optimization follows the core backend
extraction. The user-selected backend-first policy now serializes all remaining
backend work and its audit before U1, even where a narrower technical dependency
would permit overlap.

---

## Principal risks and mitigations

| Risk | Mitigation |
|---|---|
| Client packages become a new monolith | Separate pure policy from Web adapters; deliberate public entry points; split files by workflow responsibility |
| Backend application package becomes a god service | Extract one vertical domain at a time; promote abstractions only after two concrete uses |
| Contract schemas increase browser bundle size | Import endpoint-specific schemas, preserve tree-shaking, and enforce bundle budgets |
| Old UI migration causes behavior drift | Migrate the complete generation workflow with parity tests before touching presentation |
| Generic retries duplicate mutations | Generic HTTP client never retries writes; workflows require explicit idempotency contracts |
| SSE notifications are lost | Treat notifications as hints, read authoritative rows, and retain bounded reconciliation |
| `LISTEN/NOTIFY` exhausts the connection pool and regresses B2 | One dedicated long-lived listener per API process with in-memory fan-out; a test asserting pool checkouts do not scale with subscriber count |
| C1 adds a second generation schema beside the existing unused one | Derive the client snapshot from `generationJobStatusSchema` and verify no duplicate status union survives the package |
| C8 regresses the live Story Player with no flag to disable it | Single revertible commit, revert rehearsed on a branch before merge, named regression signals, optional `?client=legacy` escape hatch shipped with C8 |
| Boundary checks pass while logic never actually moves | Track C exit criterion 8: headless workflow test with no `apps/` module loaded |
| Worker concurrency overloads providers or PostgreSQL | Bounded configuration, pool sizing, per-lane limits, benchmarks, and conservative defaults |
| Pagination or incremental sync drops/duplicates turns | Stable compound cursors, authoritative versions, deterministic ordering, and boundary-page integration tests |
| Test replacement loses coverage | Remove assertions only after mapped behavioral/component/E2E coverage is green |
| Framework details leak downward | Pure-core compiler config plus import/global boundary checks in CI |
| Performance work changes semantics | Preserve durable state transitions and verify integrity/isolation suites at every optimization |

---

## Definition of done — modular foundation and Slice 1

- [ ] Track C and Slice 1 exit criteria pass.
- [ ] Generation API and worker roles share `packages/application` and have no
  cross-role implementation imports.
- [ ] Client-core is pure; client-web is framework-free; apps own rendering only.
- [ ] Request and response contracts are runtime-validated at both boundaries.
- [ ] Durable submission persistence, reconciliation, resume, retry, detach, and
  explicit cancellation are owned below the UI.
- [ ] Client code never parses raw partial model output.
- [ ] Exactly one generation status/snapshot schema exists in the tree, it has
  real consumers on both sides of the HTTP boundary, and no dead contract
  remains from before C1.
- [ ] Generation workflow behavior is proven relocated by a headless test that
  loads no `apps/` module, not only by import-direction checks.
- [ ] C8 shipped with a rehearsed rollback path.
- [ ] `SessionPort` exists as a no-op seam so authentication does not later
  change signatures across both client packages.
- [ ] Owner-identity resolution is memoized and no longer queried per request.
- [ ] `/app/` is built, served, secured, cached, and deployed through the same
  artifact contract as existing services.
- [ ] B4a's opaque campaign-bound cursor, sync token, bounded turn window, and
  sanitized pending/recovery projection are the only Slice 1 history/resume
  contracts; browser storage remains a non-authoritative optimization.
- [ ] The replacement core play loop passes unit, contract, integration, E2E,
  accessibility, visual, and performance gates.
- [ ] B2 SSE database polling removal, B3 configurable/fair worker lanes, B4b
  measured play-loop read optimization, and all B5a-B5e domain extractions are
  implemented and verified before U1. Task 14f records the backend completion
  evidence and explicitly authorizes UI implementation; none may be waived as
  merely tracked.
- [ ] Rejected/incomplete story jobs never mutate authoritative campaign or
  Chronicle state; owner/campaign prompt isolation holds; and illustration
  failure never changes story acceptance or reuses text-provider credentials.
- [ ] Dark, light, and system theme behavior, WCAG 2.2 AA, 320 px/200% reflow,
  reduced motion, keyboard, and screen-reader requirements pass for Slice 1.
- [ ] Legacy tests remain only where replacement behavior does not yet exist.
- [ ] All documentation contradictions identified above are resolved.
- [ ] `pnpm check`, `pnpm build`, `pnpm test:unit`, `pnpm test:integration`,
  `git diff --check`, and `pjm precheck` pass before merge.
