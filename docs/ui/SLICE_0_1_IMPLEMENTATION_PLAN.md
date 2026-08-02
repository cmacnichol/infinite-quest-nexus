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

---

## Completion status

Runtime implementation reviewed through `92aa9c4` on branch
`wip/main-uncommitted`. None of Track C is merged to `main` yet; `main` is at
`ad73dc1` and does not contain this plan.

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
| Task 7 | C6 — framework-ready campaign store | Not started | — |
| Task 8 | C7 — static build and deployment contract | **Complete** | `175a854`, `d48e70a`, `3364bd0`, `05d89c3`, `afdc1c0`, `cb45bcc`; scoped reviews and final fix re-review clean |
| Task 9 | C8 — current Story Player boundary proof | **Complete** | `docs/review/2026-08-02-task-9-c8-completion.md`; focused and full verification; clean Gate 2 revert rehearsal |
| Task 10 onward | B1-B5, U1-U6 | Not started | — |

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
branches in `apps/web/public/story.js`) read only `status`, `partialNarration`,
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
  Task 4a instructions and is a deliberate improvement: Task 13 (B4) needs query
  strings for bounded reads, and the containment backstop still compares only
  `pathname`.
- P3 is proved with a non-POST method: the request-contract error regression
  asserts `PUT` against `/campaigns/example/player-config`, the Task 9 route
  that motivated the fix. `validatedRequest` is module-exported for that test
  but is **not** re-exported from the `client-web` public barrel.
- P2 was resolved by removing the dependency rather than widening the boundary
  scanner; the choice is recorded in `7bf07fc`. No package now declares a
  dependency its own boundary check rejects.

**Current Task 5 verification** (measured on the Task 5 completion commit):

- `pnpm check` and `pnpm build` pass; repository boundary and data-safety
  checks cover 499 candidate files.
- `pnpm test:unit` passes **783/783 across 72 test files**.
- `pnpm test:integration` passes — the database integration suite completed
  successfully before the final pure-client test-only follow-up.
- Focused client-core and boundary checks pass, including explicit coverage for
  failed same-attempt retries, source-session closure, command/frame races,
  retry transport failures, protocol mismatches, and duplicate replay.

**Next step:** **Task 13a (B4a)** for the client-facing cursor contracts, then
Task 7 (C6). Task 10 (B1) may proceed in parallel with that client lane; Task 12
(B3) follows B1 and must finish before U1.

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

Track C gates Slice 1. Track B1 gates the claim that the generation backend is
modular. B2 and B3 may land before or after the new UI because the contract and
client watcher hide their implementation. B4's bounded read contracts must land
before U5 adopts long campaign histories.

---

## Target dependency direction

```text
apps/web/public legacy adapters       apps/web-next rendering
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
| Poll fallback | Starts at 1500 ms, uses jittered backoff capped at 5000 ms, and exposes degraded state after two consecutive failures | Fake-clock tests |
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
- Modify: `packages/contracts/src/index.ts`
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
- [ ] **Deferred to Task 6 — the only Task 2a item still open.** Add
  fake-EventSource browser coverage proving `EventSource.onerror` falls back to
  polling after the clean stream closure. This cannot be closed inside Task 2a:
  it needs the Task 6 browser transport, which does not exist yet. It is
  restated as an explicit checklist item in Task 6 (C5) so it cannot be absorbed
  by the generic SSE-fallback item there.
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

### P4 — measure response-validation cost on unbounded reads

`turnListResponseSchema` validates every turn on every call, and the turns route
still has no `LIMIT` because Task 13 (B4) has not landed. On the plan's own
2,000-turn fixture that is 2,000 object validations per request, on a route hit
at every campaign load.

- [x] Measure the 2,000-turn response validation now, before B4, so B4's
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
  strings that Task 13 (B4) may later add for bounded reads. The synthetic origin
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
- [ ] **or** allow the bare `zod` specifier in `isClientCoreImportAllowed` the
  same way `isClientWebImportAllowed` does, keep the declaration, and add a
  boundary test asserting client-core may import `zod` while still being
  rejected for Node, DOM, and framework specifiers.
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

- [ ] `submit()` persists the supplied exact envelope, enqueues it, records the
  returned durable `jobId`, and returns a run. It does not begin browser work.
  The UI owns the `AbortController`; client-core only receives its
  `AbortSignalLike` through `watch()` or `retryGeneration()`.
- [ ] **One clock owns the expiry window.** `submit()` takes
  `GenerationSubmissionInput` and stamps `createdAt` itself from the injected
  `Clock`; the caller must not supply it. C6 enforces the 15-minute window by
  comparing `Clock.now()` against that same `createdAt`, so both ends of the
  comparison must come from the same clock. If the caller stamped it with
  `Date.now()` while core read an injected fake, the boundary test the TDD
  sequence requires would pass without measuring anything — production would
  agree by coincidence and tests would be meaningless.
- [ ] `jobId` is likewise workflow-owned: written after enqueue resolves, never
  accepted from a caller. `Omit<..., "createdAt" | "jobId">` makes both rules
  compile-enforced rather than conventions.
- [ ] A `GenerationRun` permits exactly one live source iterator. A second
  `watch()` or `retryGeneration()` while one is live throws a typed
  `GenerationWorkflowProtocolError("watch_already_active")`; a completed or
  detached iterator releases that slot. This prevents a retry or a UI rerender
  from creating overlapping watchers for one durable job.
- [ ] `cancelGeneration()` and `discardGeneration()` issue only their matching
  remote command and **never** abort the consumer-owned signal. The active
  watcher observes the authoritative terminal snapshot and emits `settled`.
  `retryGeneration(signal)` issues `api.retry(jobId)` and then starts a fresh
  source session for that same job ID; it is available only after the prior
  iterator has ended.
- [ ] `fetchResult()` returns either `settled/completed` or
  `result_unavailable`, never an untyped transport rejection. A successful
  later call therefore gives Task 7 the same event shape as an initially
  successful result fetch.
- [ ] Export exactly `GenerationWorkflow`, `GenerationRun`,
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

- [ ] Consume `AsyncIterable<GenerationSourceEvent>` as declared above.
- [ ] On `{ kind: "degraded" }`, forward it as a `degraded` **without** altering
  the state machine's high-water mark, without resetting narration, and without
  counting anything. Degradation is transport health, not job progress.
- [ ] Do not re-derive, re-count, or second-guess `consecutiveFailures`. Task 6
  owns the counter and the reset-on-success rule.
- [ ] Task 6's matching checklist item has been updated to yield this union.

### C2 — parse every incoming snapshot with the contract schema

`GenerationJobSnapshot` (the polling response, ~24 fields including
`createdAt`, `updatedAt`, and `completedAt`) is **structurally assignable** to
`GenerationStreamSnapshot` (11 fields). Verified: assigning one to the other
compiles with no error. So a poll source that forwards `GenerationApi.get()`
output unprojected would silently reintroduce exactly the timestamps Task 2a
removed, and no type check would catch it. A changing `updatedAt` is what
defeated change detection in the first place.

- [ ] Parse every inbound `{ kind: "snapshot" }` payload with
  `generationStreamSnapshotSchema` before it reaches the state machine. This is
  the load-bearing guard: it cannot be bypassed by a careless transport.
- [ ] Rely on the parse to strip excess keys. Verified: parsing a full
  `GenerationJobSnapshot` through `generationStreamSnapshotSchema` yields
  exactly the eleven allowlisted keys, and `"updatedAt" in parsed` is `false`.
- [ ] This same parse satisfies "reject malformed statuses" — a status outside
  the contract enum fails the parse. Reject the **snapshot**; do not reject a
  legitimate polling gap, which is an absent stage, not an invalid one.
- [ ] Add a test feeding a full `GenerationJobSnapshot` through the source and
  asserting no timestamp key reaches any emitted `status` event.
- [ ] Task 6's checklist has been updated to project the polling path through
  the same schema. Both layers do it; core's is the guarantee.

### C3 — define staleness before testing it

The original checklist required testing a "stale snapshot", but
`GenerationStreamSnapshot` carries **no timestamp** — Task 2a removed all three
deliberately, and a type-level check confirms `"updatedAt" extends keyof
GenerationStreamSnapshot` is `false`. There is no clock in the frame to compare.

Staleness is therefore an ordering over the two monotonic fields the projection
does carry. ADR 0028 names `attempts` "the monotonic retry-cycle marker used for
stream reconciliation"; this is what it is for.

- [ ] Rank statuses within one attempt:
  `queued`/`replacement_queued` = 0, `assessing` = 1, `generating` = 2,
  `validating` = 3, `committing` = 4, and every attempt-terminal status
  (`completed`, `failed`, `discarded`, `cancelled`, `recoverable`) = 5.
- [ ] Track a high-water mark of `(attempts, rank)` compared
  lexicographically. A snapshot strictly below the mark is stale and emits
  nothing, **except** for the acknowledged retry transition below. A tuple that
  skips ranks is a legitimate polling gap: accept it and advance.
- [ ] An equal tuple is a duplicate only when all eleven allowlisted snapshot
  fields are unchanged. Equal `(attempts, rank)` snapshots with changed
  `partialNarration`, `errorCode`, `errorMessage`, `resultTurnId`, or terminal
  `status` are meaningful updates: emit the projected `status` event. Emit a
  `narration` event when `partialNarration` changes, with `text` equal to the
  full current sanitized narration; when it changes from a string to `null`,
  emit `{ type: "narration", text: "" }` once to clear the preview. Never
  concatenate or derive narration from any other field.
- [ ] The server's retry endpoint changes `recoverable` or `failed` to
  `queued`/`replacement_queued` **without** incrementing `attempts`; the worker
  increments it only when it next claims the job. After this run has received a
  successful `api.retry(jobId)` response, allow exactly the matching
  same-attempt queue snapshot to begin a new observation cycle, then require
  normal monotonic ordering again. Do not generally allow rank regressions.
- [ ] A same-rank terminal transition such as `failed -> discarded` is accepted
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

- [ ] Emit the new non-terminal `{ type: "result_unavailable"; jobId; error }`
  when a job reaches `completed` but `result(jobId)` rejects. The generation
  succeeded durably; only the client's fetch failed.
- [ ] Do **not** emit `settled` for this case, and do not treat it as
  `unrecoverable`. The workflow stays open so a consumer can request the result
  again.
- [ ] Expose an explicit `fetchResult()` operation so a consumer can retry after
  `result_unavailable` without re-enqueueing anything.

### C5 — reconciliation: what `syncStatus` can and cannot decide

`pendingGenerationSchema` carries `id`, `status`, `action`, `operationKind`,
`expectedTurnNumber`, `createdAt`, and `updatedAt` — **no idempotency key**. So
`syncStatus` alone cannot prove an in-flight job is the one this client
submitted; the same action submitted twice, or a submission from another tab,
is indistinguishable. The original instruction implied `syncStatus` decides
whether to replay. It cannot.

- [ ] Use `syncStatus` for one purpose: detecting that *a* generation is in
  flight, so the workflow attaches to `pendingGeneration.id` and watches it
  rather than enqueueing again. This is also the reload-resume path.
- [ ] Resolve genuine ambiguity by replaying the enqueue with the **same
  idempotency key** and trusting the server. `generationEnqueueResponseSchema`
  returns `duplicate: boolean`; `duplicate: true` means the original submission
  was already accepted, and the returned `id` is the durable job to watch.
- [ ] Never mint a new idempotency key during reconciliation. The key lives in
  the persisted submission precisely so a replay is provably the same request.
- [ ] Do not match a pending job to a local submission by comparing `action`,
  `operationKind`, or `expectedTurnNumber`. Those collide legitimately.

### C6 — expiry policy is core's; storage is Task 6's

Task 5 said core expires submissions "using the injected clock" while Task 6
said it implements "the 15-minute pending-submission store". `PendingSubmission
Store` takes no TTL argument and `PendingGenerationSubmission.createdAt` is a
number, so core can and should own the decision.

- [ ] Extend `PendingGenerationSubmission` with an optional `jobId?: string`,
  declared as `StoredGenerationSubmission` above. The request envelope remains
  exact and immutable; `jobId` is local durable recovery metadata written
  immediately after enqueue accepts or duplicates the request. Task 6 must
  round-trip both the new field and pre-existing records that do not contain it.
- [ ] **`exactOptionalPropertyTypes: true` is set for client-core**, so
  `jobId?: string` permits *omitting* the key but forbids assigning `undefined`
  to it. Round-tripping through `JSON.parse` is fine because an absent key stays
  absent, but the natural `{ ...submission, jobId: undefined }` spread fails to
  compile with `TS2375`. Build the record without the key when there is no job
  ID; do not widen the field to `string | undefined` to dodge the error, because
  that would let "no job" and "job unknown" become indistinguishable in the
  stored record.
- [ ] Core owns expiry policy: compare `Clock.now()` against
  `submission.createdAt` and treat anything older than 15 minutes as absent,
  clearing it through `PendingSubmissionStore.clear`.
- [ ] Task 6 owns durable storage only: serialization, defensive JSON parsing,
  and campaign-scoped keys. It must not implement a second expiry rule.
- [ ] Persist the exact submission **before** calling `enqueue`, so an
  interrupted enqueue is still replayable. Once enqueue resolves, save the same
  envelope with its returned `jobId` before beginning observation.
- [ ] `resume()` first removes an expired record, then obtains `syncStatus`.
  If `pendingGeneration` exists, attach to that server-authoritative ID and
  clear any campaign-scoped local submission, because one local slot cannot
  safely distinguish an in-flight request from another tab. Never compare
  action, operation kind, or expected turn to claim identity.
- [ ] If no pending job exists and the unexpired record has `jobId`, return a
  run for that ID. This preserves manual retry of a failed job and
  `result_unavailable` recovery after reload, even though `syncStatus` exposes
  neither completed nor failed jobs. If it has no `jobId`, replay exactly the
  original request and idempotency key.
- [ ] Clear the saved record only after `settled/completed` with a retrieved
  result, or after authoritative `cancelled` or `discarded`. Retain it for
  `failed`, `recoverable`, `unrecoverable`, and `result_unavailable`, so the
  user can resume, retry, discard, or fetch the already accepted result.

### C7 — remaining behavior (unchanged in intent, retained here)

- [ ] Derive the status union from `packages/contracts`; do not redeclare it.
  There is no exported named type for the union — `generationStatusSchema` is
  module-private in `client-api.ts` — so index the projection type:
  `type GenerationStatus = GenerationStreamSnapshot["status"]`. Verified to
  accept all eleven members. Use `generationStreamSnapshotSchema` for the
  runtime check, per C2.
- [ ] Model retry loops `recoverable -> queued|replacement_queued -> ...` on the
  same durable job ID. The queue snapshot initially retains its former
  `attempts` value and the next `assessing` snapshot increments it; implement
  the C3 acknowledged-retry exception rather than assuming the queue transition
  itself increments attempts. `generationActionResponseSchema` constrains
  `retry`/`cancel`/`discard` to exactly
  `queued`/`replacement_queued`/`cancelled`/`discarded`, which matches.
- [ ] Emit narration only from `partialNarration`. Ignore `partialOutput` even
  if a transport includes it; note that C2's parse already strips it, so this
  is defence in depth rather than the primary guard.
- [ ] Treat watcher abort as detach and emit `detached`. Call the remote cancel
  endpoint only through an explicit `cancelGeneration()` operation.
- [ ] Auto-retry at most once per durable job, not once per page load. The first
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

- [ ] `watch(signal)` loops through sequential source sessions for one job. On
  the first recoverable status it waits for the successful retry action, closes
  the completed source session, and opens a fresh `source.watch(jobId, signal)`.
  There must never be two live iterators for that job.
- [ ] A source may complete normally only after core has accepted an authoritative
  terminal snapshot or the supplied signal is aborted. If it completes while
  the latest accepted snapshot is non-terminal, throw
  `GenerationWorkflowProtocolError("source_ended_before_terminal")`; do not
  emit `settled`, do not clear persistence, and leave the durable job resumable.
- [ ] If contract parsing of a source snapshot fails, throw
  `GenerationWorkflowProtocolError("invalid_snapshot", { cause })` with the
  same no-settlement and no-clear rule. A malformed source is not a durable job
  failure and must not be relabeled as `unrecoverable`.
- [ ] If the signal is already aborted or becomes aborted while iterating, close
  the iterator, emit exactly one `detached` event, and retain the saved record.
  An abort must not call any remote action.

### C9 — action, stream, and terminal races have one owner

- [ ] Route auto-retry through the same internal retry transition used by
  `GenerationRun.retryGeneration()`. Mark the transition acknowledged only
  after `api.retry(jobId)` resolves with the matching job ID and a queue status;
  a rejection leaves the durable job recoverable and emits the documented
  `settled/unrecoverable` error without clearing persistence.
- [ ] For explicit cancel and discard, keep the watcher active until it observes
  the authoritative terminal snapshot. If the command resolves after an
  independently received terminal snapshot, emit settlement once only and make
  later duplicate source frames no-ops.
- [ ] If a command response names a different job ID or an impossible status,
  throw `GenerationWorkflowProtocolError("action_response_mismatch")`, retain
  persistence, and do not synthesize a status frame from the partial action
  response.

### C10 — test the revised observable contract, not only status ranks

- [ ] Add `GenerationWorkflowProtocolError` to `generation/types.ts` with
  `kind` limited to `"watch_already_active"`, `"invalid_snapshot"`,
  `"source_ended_before_terminal"`, and `"action_response_mismatch"`. Export
  the type and class through the deliberate client-core public surface.
- [ ] Keep all parsing and protocol errors free of DOM, EventSource, fetch,
  database, and framework types. Test them with plain async-iterable fakes and
  the existing `AbortSignalLike` test double.

### TDD and verification sequence

- [ ] Write `generation-machine.test.ts` first, covering the `(attempts, rank)`
  ordering from C3: an exact duplicate, two `generating` frames with different
  `partialNarration`, a `partialNarration` clear, skipped stages, a stale
  snapshot, `recoverable(1) -> queued(1) -> assessing(2)` after acknowledged
  retry, `failed -> discarded` after explicit discard, and every terminal
  status. Run
  `pnpm exec vitest run tests/unit/client-core/generation-machine.test.ts`,
  expect failure, then implement `machine.ts`.
- [ ] Write `generation-submission.test.ts` for persist-before-enqueue, saving
  the returned `jobId` after enqueue, the 15-minute expiry boundary against a
  fake `Clock` (just inside and just outside — the fake clock must be the only
  source of both the stamped `createdAt` and the comparison, or the test proves
  nothing), key stability across a replay,
  resume from a saved failed/completed job ID, and the explicit clearing rules
  for completed, cancelled, discarded, and another-tab pending generation. Run
  it red, then implement `submission.ts`.
- [ ] Write `generation-workflow.test.ts` for the exported workflow/handle
  surface, reload resume via `pendingGeneration.id`, ambiguous-enqueue replay
  with `duplicate: true`, one auto-retry across a fresh source session, reload
  after that retry without a second automatic retry, detach, explicit
  cancellation and discard races, `result_unavailable` followed after reload by
  a successful `fetchResult()`, degraded forwarding, timestamp stripping, a
  malformed snapshot, a non-terminal source completion, and no-duplicate-watch
  enforcement. Run it red, then implement `workflow.ts`.
- [ ] Export the deliberate public surface from
  `packages/client-core/src/index.ts` and confirm no internal module is
  barrel-exported.
- [ ] Run focused checks:
  `pnpm exec vitest run tests/unit/client-core/ tests/unit/client-boundaries.test.ts`,
  `pnpm --filter @infinite-quest/client-core check`, and
  `pnpm check:client-boundaries`.
- [ ] Run completion checks: `pnpm check`, `pnpm build`, `pnpm test:unit`,
  `pnpm test:integration`, `git diff --check`, review the complete diff for
  unrelated changes, and run `pjm precheck` before committing.
- [ ] Record a **Current Task 5 verification** block under **Completion status**
  in the same commit that marks Task 5 complete, per the rule in Task 4a P4.
- [ ] Commit with an imperative scoped summary such as
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

## Task 6 — C5: Browser transports, persistence, and adaptive polling

**Files:**

- Create: `packages/client-web/src/generation/event-source.ts`
- Create: `packages/client-web/src/generation/poll-source.ts`
- Create: `packages/client-web/src/generation/fallback-source.ts`
- Create: `packages/client-web/src/storage/pending-submissions.ts`
- Create: `packages/client-web/src/platform/clock.ts`
- Create: `packages/client-web/src/platform/delay.ts`
- Create: `packages/client-web/src/platform/ids.ts`
- Create: `tests/unit/client-web/generation-sources.test.ts`
- Create: `tests/unit/client-web/pending-submissions.test.ts`

- [ ] Parse **every** inbound payload with `generationStreamSnapshotSchema`
  before yielding it to client-core — the SSE frame path **and the polling
  path**. `GenerationApi.get()` returns `GenerationJobSnapshot`, which carries
  `createdAt`, `updatedAt`, and `completedAt` and is structurally assignable to
  `GenerationStreamSnapshot`, so an unprojected poll result compiles cleanly and
  silently reintroduces the timestamps Task 2a removed. Task 5 C2 parses
  defensively as well; do not treat that as licence to skip it here.
- [ ] **Yield `GenerationSourceEvent`, not bare snapshots.** Task 5 declares
  `AsyncIterable<{ kind: "snapshot"; snapshot } | { kind: "degraded"; reason;
  consecutiveFailures }>`. The transport is the only layer that knows whether a
  failure was `stream_lost` or `poll_failed` and the only layer that can count
  consecutive failures across reconnects, so this task owns both fields. Core
  forwards them without re-counting.
- [ ] Close EventSource deterministically on terminal state, fallback, detach,
  or consumer failure.
- [ ] Fall back from SSE to polling once without creating overlapping watchers.
- [ ] **Inherited from Task 2a P2.** Prove with a fake EventSource that a *clean*
  stream closure — the server closing after a mid-stream read failure without
  emitting a synthetic terminal `failed` frame — still reaches `onerror` and
  falls back to polling. This is the one Task 2a acceptance item Task 2a could
  not close, because it needs the Task 6 browser transport. Do not treat the
  generic fallback item above as covering it: the distinguishing case is a
  closure carrying no terminal status. See ADR 0028 §Task 2a stream and
  validation baseline amendment.
- [ ] Poll at 1500 ms initially, back off with jitter to 5000 ms after transport
  failures, emit a `{ kind: "degraded" }` source event after two consecutive
  failures, and reset the counter after a successful snapshot. This counter is
  owned here and nowhere else — Task 5 C1 forwards it verbatim.
- [ ] Use elapsed time and explicit detach rather than a `900 attempts` timeout.
  The durable job remains resumable after local monitoring stops.
- [ ] Pause non-essential polling while the document is hidden; generation
  monitoring may reduce cadence but must preserve resume/reconciliation.
- [ ] Implement the pending-submission **storage** with defensive JSON parsing
  and campaign-scoped keys. Do **not** implement an expiry rule here: Task 5 C6
  owns the 15-minute policy, comparing `Clock.now()` against
  `submission.createdAt`. Two expiry implementations would drift. Preserve the
  optional Task 5 `submission.jobId` when serializing and loading; records made
  before this field existed remain valid with `jobId` absent.
- [ ] Test fake EventSource, fake fetch, fake clock, visibility changes, abort at
  each stage, stream loss, malformed frames, no-duplicate-watcher behavior, and
  pending-submission round trips both with and without `jobId`.

**Definition of done:** Browser transport failures are visible and recoverable,
no watcher leaks after navigation, and core tests remain independent of Web APIs.

---

## Task 7 — C6: Focused stores, selectors, and generic job watching

Do not lift the current `story.js` state object as-is. It mixes authoritative
projections with presentation details such as toast timers, scroll-follow state,
modal selections, and DOM cancellation controls.

**Files:**

- Create: `packages/client-core/src/store.ts`
- Create: `packages/client-core/src/campaign-store.ts`
- Create: `packages/client-core/src/selectors.ts`
- Create: `packages/client-core/src/jobs.ts`
- Create: `tests/unit/client-core/campaign-store.test.ts`
- Create: `tests/unit/client-core/jobs.test.ts`

```ts
export interface Store<T> {
  get(): Readonly<T>;
  subscribe(listener: (state: Readonly<T>) => void): () => void;
}

/**
 * The generic form of Task 5's `GenerationSourceEvent`. A source that yields
 * bare snapshots cannot express degradation, which is why Task 5 C1 corrected
 * its own port; the generic watcher inherits that correction rather than
 * reintroducing the defect.
 */
export type JobSourceEvent<TSnapshot, TReason extends string = string> =
  | { kind: "snapshot"; snapshot: TSnapshot }
  | { kind: "degraded"; reason: TReason; consecutiveFailures: number };

export interface JobSnapshotSource<TSnapshot, TReason extends string = string> {
  watch(jobId: string, signal: AbortSignalLike): AsyncIterable<JobSourceEvent<TSnapshot, TReason>>;
}
```

`GenerationSnapshotSource` from Task 5 must remain assignable to
`JobSnapshotSource<GenerationStreamSnapshot, "stream_lost" | "poll_failed">`.
Generalizing here must not widen or re-declare Task 5's narrower `reason` union;
each job family keeps its own typed reasons.

- [ ] Store only campaign/world projections, accepted turns, selected domain
  options, and durable-job references.
- [ ] Keep scrolling, focus, modals, toast timers, DOM nodes, and rendering flags
  in `apps/`.
- [ ] Define job-family adapters for image, Chronicle, and world-cover statuses;
  do not force unlike payloads into one underspecified status-only type.
- [ ] Make the generic watcher responsible only for scheduling, error/degraded
  events, detach, and terminal detection supplied by the family adapter.
- [ ] **Handle the full Task 5 `GenerationEvent` union — including
  `result_unavailable` — without collapsing it.** That event means the
  generation succeeded durably but the client could not fetch its result. The
  store must not record it as a failure, must not clear the durable-job
  reference, and must not mark the job settled; the workflow is still open and a
  consumer may call `fetchResult()` again. A store that treats any non-`status`
  event as terminal will silently lose a completed turn.
- [ ] Model `degraded` as transport health on the job reference, separate from
  job status. It must not overwrite the last known snapshot or reset narration.
- [ ] Add family-specific tests for `expired`, `partial`, `recoverable`, and
  provider-progress behavior, plus a generation-family test asserting that
  `result_unavailable` leaves the job watchable and a later successful
  `fetchResult()` settles it as completed.

**Definition of done:** Framework adapters can subscribe to stable domain
projections, while family-specific job semantics remain typed and testable.

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
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `services/api/src/server.ts`
- Modify: `packages/database/src/config.ts`
- Modify: `Dockerfile`
- Modify: `compose.yaml`
- Modify: `deploy/swarm/stack.yaml`
- Modify: `.github/workflows/ci.yml`
- Test: `tests/unit/server-security.test.ts`

- [ ] Define reproducible `build:web:legacy`, `build:web:next`, `dev:web`, and
  `check:web` scripts.
- [ ] Build current public assets plus a compiled legacy client entry into a
  generated directory; do not commit generated bundles.
- [ ] Serve the replacement app at `/app/` with history fallback while `/nexus/`
  and `/story` remain unchanged and default.
- [ ] Set Vite base paths explicitly so chunks and assets resolve behind the
  Fastify prefix.
- [ ] Give hashed assets immutable long-lived caching; keep HTML `no-cache` and
  preserve API `no-store`.
- [ ] Keep CSP at `script-src 'self'`, `style-src 'self'`, and `connect-src
  'self'`; do not introduce inline-script exceptions.
- [ ] Copy both built static roots into the runtime image and verify Compose and
  Swarm use the same artifact layout.
- [ ] Add server tests for `/app/`, deep-link fallback, cache headers, CSP, old
  routes, and missing-asset behavior.
- [ ] **Inherited from the Task 4 review — make `packages/contracts` a real
  workspace package.** It currently has no `package.json`, so it is not a
  workspace member, gets no `node_modules`, and its own `import { z } from
  "zod"` resolves only by walking up to the root install. Every consumer reaches
  it by relative path. Give it a `package.json` with a name, `exports`, a
  `check` script, and its own `zod` dependency; then convert the client packages'
  relative contract imports to the package name and update
  `scripts/check-client-boundaries.mjs` to accept it. Task 4 declares `zod`
  locally in both client packages, which hardens their own imports but cannot
  fix the contracts hop — do not treat that as having resolved this.
- [ ] **Inherited from the Task 4 review — CORS exposure for the correlation
  header.** Task 4 makes the API emit `x-correlation-id` on responses, and
  `services/api/src/request-security.ts:47` already allows it as a *request*
  header. No `Access-Control-Expose-Headers` is set, so a cross-origin caller
  cannot read it back. Add that header if, and only if, `/app/` is served from
  an origin other than the API's. Same-origin deployments need no change.
- [ ] Run `pnpm check`, `pnpm build`, container build, and rendered Compose/Swarm
  configuration checks.

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

The worker currently imports generation, image, Chronicle, and other service
implementations from `services/api`. The first backend modularity milestone is
that API and worker roles depend on a shared application package, never on each
other.

**Files:**

- Create: `packages/application/package.json`
- Create: `packages/application/tsconfig.json`
- Create: `packages/application/src/generation/index.ts`
- Create: `packages/application/src/generation/ports.ts`
- Create: `packages/application/src/generation/use-cases.ts`
- Create: `packages/database/src/generation-repository.ts`
- Create: `tests/unit/application/generation-use-cases.test.ts`
- Modify: `services/api/src/generation-service.ts`
- Modify: `services/api/src/server.ts`
- Modify: `services/worker/src/worker.ts`
- Modify: `services/runtime/src/lifecycle.ts`
- Test: `tests/integration/generation.integration.test.ts`

**Application ports:**

```ts
export interface GenerationRepository {
  enqueue(command: EnqueueGenerationCommand): Promise<EnqueueGenerationResult>;
  get(jobId: string, ownerUserId: string): Promise<GenerationJob>;
  retry(jobId: string, ownerUserId: string): Promise<GenerationJob>;
  cancel(jobId: string, ownerUserId: string): Promise<GenerationJob>;
  discard(jobId: string, ownerUserId: string): Promise<void>;
}

export interface GenerationExecutor {
  execute(claim: ClaimedGeneration, signal: AbortSignal): Promise<void>;
}
```

- [ ] First move behavior without changing SQL, HTTP payloads, job states, or
  prompt protocol.
- [ ] Separate use-case decisions from PostgreSQL query implementation.
- [ ] Keep transactions and ownership/campaign scoping explicit in repository
  adapters.
- [ ] Change Fastify handlers into request/response adapters around use cases.
- [ ] Change worker code into claim/execute adapters around the same package.
- [ ] Enforce no `services/** -> services/**` cross-role imports.
- [ ] Re-run generation integrity, cross-campaign isolation, cancellation,
  recovery, and idempotency integration suites.

**Definition of done:** API and worker generation code depend on
`packages/application`; shared application tests run without Fastify; PostgreSQL
integration tests prove no behavior or transaction boundary changed.

---

## Task 11 — B2: Replace SSE database polling with a notification port

**Files:**

- Create: `packages/application/src/generation/events.ts`
- Create: `packages/database/src/postgres-generation-events.ts`
- Create: `tests/integration/generation-events.integration.test.ts`
- Modify: `packages/database/src/pool.ts`
- Modify: `services/api/src/server.ts`
- Modify: generation state-transition write paths

```ts
export interface GenerationEventSource {
  subscribe(jobId: string, signal: AbortSignal): AsyncIterable<GenerationChanged>;
}

export interface GenerationEventPublisher {
  publish(event: GenerationChanged): Promise<void>;
}
```

- [ ] Emit a notification after committed job-state changes; never notify before
  the transaction commits. Prefer issuing `pg_notify` inside the state-change
  transaction so PostgreSQL delivers it only on commit and no post-commit crash
  can lose the wake-up.
- [ ] Use PostgreSQL `LISTEN/NOTIFY` as a wake-up hint, not authoritative state.
  Read the job row after each notification.
- [ ] **Use exactly one dedicated, long-lived listener connection per API
  process and fan out to subscribers in memory.** A `LISTEN` connection must be
  checked out and held for its lifetime; taking one per SSE subscriber from the
  shared pool exhausts it at `max` concurrent viewers
  (`packages/database/src/pool.ts:8`, default 12) and would make this package a
  regression rather than a fix — worse than the 350 ms loop it replaces. The
  listener connection is created outside the request pool, reconnects with
  backoff, and re-issues `LISTEN` on reconnect.
- [ ] Add a test that opens more concurrent SSE subscribers than the configured
  pool `max` and asserts that pool checkouts do not scale with subscriber count.
- [ ] Send an initial snapshot immediately and perform a bounded 15-second
  reconciliation read so dropped notifications cannot strand a client.
- [ ] Preserve SSE frame schema, terminal closure, cancellation, ownership, and
  structured logging.
- [ ] Test notification-before-subscribe races, reconnect, dropped notification,
  duplicate notification, API restart, terminal transition, and client close.
- [ ] Record query counts and verify the fixed 350 ms loop is gone.

**Definition of done:** Idle SSE connections do not continuously query
PostgreSQL, state delivery remains durable, and p95 notification-to-frame latency
meets the 500 ms budget.

---

## Task 12 — B3: Configurable worker concurrency and fair job lanes

**Files:**

- Modify: `packages/database/src/config.ts`
- Modify: `services/worker/src/worker.ts`
- Modify: `services/runtime/src/lifecycle.ts`
- Modify: `compose.yaml`
- Modify: `deploy/swarm/stack.yaml`
- Modify: `.env.example`
- Create: `tests/unit/worker-concurrency.test.ts`
- Test: `tests/integration/generation.integration.test.ts`

- [ ] Add bounded `WORKER_GENERATION_CONCURRENCY` configuration with default 1
  and an operationally safe documented maximum.
- [ ] Size database pools and shutdown deadlines for configured concurrency.
- [ ] Claim up to available generation slots without allowing two active jobs for
  one campaign.
- [ ] Keep illustration, Chronicle, and asset work in independently bounded lanes
  so generation load cannot starve optional work and optional work cannot block
  story acceptance.
- [ ] Drain all active work on shutdown within the existing bounded lifecycle.
- [ ] Add tests for slot refill, fair lanes, campaign exclusivity, abort, drain,
  lease expiry, and multiple worker replicas.
- [ ] Benchmark concurrency 1, 2, and 4 against the test database and record
  throughput, queue latency, database utilization, and provider limits.

**Definition of done:** Throughput scales with configured slots/replicas without
duplicate turns, cross-campaign leakage, unbounded shutdown, or illustration
coupling.

---

## Task 13 — B4: Bound and profile play-loop read paths

**Files:**

- Create: `scripts/benchmark-play-loop.mjs`
- Create: `tests/integration/play-loop-read-performance.integration.test.ts`
- Modify: request/response schemas under `packages/contracts/src/`
- Modify: applicable read repositories under `packages/database/src/`
- Modify: applicable route adapters under `services/api/src/`
- Modify: `docs/workflows/testing.md`

- [ ] Seed small, 200-turn, and long-running campaign fixtures with realistic
  world/version, job, image, and Chronicle cardinalities.
- [ ] Measure campaign list, campaign sync, turn history, generation status,
  generation result, and initial Story Player hydration using the C0 profile.
- [ ] Capture query counts and `EXPLAIN (ANALYZE, BUFFERS)` plans for slow reads;
  store summarized evidence, not environment-specific raw database dumps.
- [ ] Add owner- and campaign-scoped indexes only where measured plans justify
  them. Verify write amplification and migration rollback implications.
- [ ] Replace unbounded turn and job-history reads with stable cursor pagination.
  Preserve compatibility during migration and define ordering/tie-break rules in
  shared schemas.
- [ ] Add an incremental campaign-sync cursor so resume normally transfers only
  accepted turns and job changes after the client's last authoritative version.
- [ ] Remove measured N+1 reads and avoid returning columns or nested records the
  play loop does not consume.
- [ ] **Memoize the owner-identity lookup.** `initialOwnerId`
  (`packages/database/src/pool.ts:35`) issues
  `SELECT id FROM users WHERE system_key = 'initial-owner' AND status =
  'active'` on every call, uncached, from **99 call sites** across `services/` —
  several per request on play-loop paths — for a value that cannot change while
  the process runs. Cache it per process behind the existing function so no
  call site changes, keep the "not bootstrapped" error behavior on a cache miss,
  and invalidate on nothing (a restart is the only lifecycle event that matters
  pre-authentication). This is the cheapest measurable win in the track; do it
  before chasing index changes.
- [ ] Re-verify the memoization holds once `SessionPort`-backed authentication
  exists — a per-request identity makes a process-wide cache invalid, so the
  cache must be keyed by resolved identity at that point, not removed.
- [ ] Add query-count assertions for deterministic routes and a seeded-data load
  profile that reports p50, p95, payload bytes, and error rate.
- [ ] Treat the 10% regression budget as a guardrail, not proof of speed: record
  absolute baseline and post-change measurements and approve explicit targets
  after C0 evidence exists.

**Definition of done:** Long campaigns hydrate incrementally, list/history APIs
are bounded, hot-route query counts are protected, and measured p95 latency and
payload size improve without changing ownership or campaign isolation.

---

## Task 14 — B5: Continue backend modularization by domain

B1 establishes the pattern. Apply it incrementally after the generation vertical
slice, one independently deployable domain at a time:

1. Illustration and image jobs.
2. Chronicle memory and embedding jobs.
3. Worlds, immutable versions, and campaign management.
4. Providers and prompt configuration.
5. Imports, exports, archives, and assets.

Each domain gets application ports, concrete database/provider adapters, API and
worker adapters, boundary checks, and existing integration coverage. Do not
create one generic repository or god service. Shared abstractions are promoted
only after two real domains prove the same shape.

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

# Track U — Slice 1 replacement UI

**Depends on:** C0-C8 complete. B1 is required for the modular-backend claim.
B2 and B3 are recommended before broad user exposure but do not block UI
development. B4's cursor contracts must stabilize before U5 implements history
loading and incremental resume.

**Screens:** `NEX-WORLDS` (minimal), `NEX-CAMPAIGNS` (minimal), and
`STORY-PLAYER`.

**Flows:** 1, 2, 6, and 7 from `INTERACTION_FLOWS.md`.

**Non-goals:** Full world authoring, campaign configuration depth,
illustrations, providers, prompt library, imports, and global removal of the
legacy management client. Those land in later slices through the same client
and application boundaries.

## Task 15 — U1: Framework app scaffold

**Files:**

- Modify: `apps/web-next/package.json`
- Create: framework entry, router, and root component under `apps/web-next/src/`
- Create: `apps/web-next/src/client.ts`
- Create: `apps/web-next/src/styles/tokens.css`
- Modify: root scripts and `pnpm-lock.yaml`

- [ ] Select the framework and record it in an ADR with bundle, accessibility,
  team-familiarity, and long-term maintenance trade-offs.
- [ ] Import client behavior only through public `client-core`/`client-web`
  surfaces.
- [ ] Lazy-load routes outside the core play loop.
- [ ] Install error boundaries and a global unavailable state without hiding
  correlation IDs.
- [ ] Run type checks, bundle budgets, and an empty-shell accessibility test.

## Task 16 — U2: App shell

Persistent navigation, breadcrumb region, toast/notification system,
active-job indicator, skip links, focus restoration, and responsive layout per
`DESIGN_SYSTEM.md` and `ACCESSIBILITY_SPEC.md`.

Presentation code may branch on `GenerationEvent.type`; it may not interpret raw
job statuses or implement retry/cancellation policy.

## Task 17 — U3: World selection

Read-only published-world list and selection through the typed client. Keep
filtering client-side for current list sizes, debounce input rendering, and use
stable keys/selectors so a store update does not rerender every card.

## Task 18 — U4: Campaign creation and resume

List campaigns, create from a selected immutable world version, and resume.
Always call `syncStatus` before starting a watcher. If a durable pending job
exists, attach to it rather than submitting a second turn.

## Task 19 — U5: Story Player

Consumes `GenerationEvent` and store selectors:

| Event | UI response |
|---|---|
| `status` | Stage copy and progress affordance |
| `narration` | Incremental, safely rendered narration |
| `degraded` | Visible reconnect/polling state |
| `detached` | Explain that the durable job continues and can be resumed |
| `settled/completed` | Append authoritative result and reconcile campaign |
| Other settled outcomes | Error/recovery/cancel/discard affordance |

Includes Action/Scene/Auto input, submit, explicit cancel, turn history, and
unrecoverable recovery. Load history through the stable cursor contract and keep
the latest accepted window immediately available. Rendering must stay responsive
with the 200-turn fixture; defer offscreen turn rendering or virtualize only if
the measured 50 ms task budget is exceeded.

## Task 20 — U6: Slice 1 testing

- Client-core tests cover workflow policy and are not duplicated in components.
- Component tests cover idle, enqueue, streaming, degraded, detached,
  recoverable, completed, cancelled, and malformed-contract UI states using
  synthetic typed events.
- Contract tests verify the real Fastify API satisfies client schemas.
- Playwright covers world selection -> campaign creation -> submission ->
  streaming -> completed result against the test Compose stack.
- Reload E2E coverage verifies durable-job resume without duplicate submission.
- Axe-core runs in component tests; keyboard and screen-reader passes complete
  before Slice 2.
- Visual regression covers idle, generating, degraded, recoverable, and
  completed states.
- Performance tests enforce bundle and runtime budgets.

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
6. Accessibility, visual, contract, E2E, bundle, and runtime performance gates
   pass.
7. Slice 1 feature code is confined to `apps/web-next` and public client-package
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
  currently rendered and client code must not parse `partialOutput`.
- Keep `OPEN_QUESTIONS.md` Q1 resolved; remove work items that imply it remains
  open.
- Update `FRONTEND_IMPLEMENTATION_PLAN.md` so source-string tests retire by
  replacement slice and `/app/` build/serve plumbing lands before Slice 1.
- Record backend application boundaries and notification/concurrency choices in
  ADRs before their implementation merges.
- Document performance commands, budgets, and exceptions in the contributor and
  deployment documentation.

---

## Dependency graph

```text
[C0-C5 done] -> C7 -> C8 -> B4a -> C6 -> [Track C complete] ----+
                                                                |
[C0 done] -> B1 -> B3 ------------------------------------------+-> U1 -> U2 -> U3 -> U4 -> U5 -> U6
              |                                                                      ^
              +-> B2 (parallel; required for Track B, not Slice 1)                   |
              +-> B4b (after B4a) ---------------------------------------------------+
              +-> B5 (domain-by-domain; not a Slice 1 gate)
```

**C0 through C5 and C7 through C8 are complete** (Tasks 1-6, 8, and 9,
including C1a, C2a, C3a, and C4a). The client lane is **B4a (Task 13a) next**,
then C6 (Task 7). B1 (Task 10) may start in parallel now; B3 (Task 12) follows
B1 and both Track C plus B3 gate U1. B4b (Task 13b) follows B4a and B1 and must
finish before U5.

**C6 does not gate C8 — this was previously drawn as `C6 -> C8` and is
corrected.** Task 9 never consumes the C6 stores or selectors. C6's consumers
are U2-U5, and it is sequenced after C8 and B4a so it is built once against the
rewired Story Player and final bounded history/sync contracts.

**C7 gated C8 — this was previously drawn as parallel and is corrected here.**
C7 supplied `apps/web/src/legacy-client-entry.ts` and the Vite build; completed
C8 now compiles the Story Player's client-package imports through that entry and
no longer publishes the raw imported module graph from `publicDir`.

C1a gated C2 because C4 models its event stream on the C1 stream projection;
correcting that projection after C4 exists would have meant rewriting the event
model and its tests. B1 can proceed alongside C7-C8/B4a/C6 now that C1 contracts
have stabilized. B2 preserves C1a's error-frame behavior and can run after B1
without delaying the UI. B3 is different: it is the parent plan's pre-exposure
throughput gate and therefore finishes before U1. B4 was split because its public
cursor/sync shapes must land before C6, while measured query/index optimization
can follow B1 but must finish before the long-campaign U5 implementation.

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
- [ ] The replacement core play loop passes unit, contract, integration, E2E,
  accessibility, visual, and performance gates.
- [ ] SSE database polling removal, configurable worker concurrency, and bounded
  play-loop reads are implemented or explicitly tracked as pre-exposure blockers
  with owners.
- [ ] Legacy tests remain only where replacement behavior does not yet exist.
- [ ] All documentation contradictions identified above are resolved.
- [ ] `pnpm check`, `pnpm build`, `pnpm test:unit`, `pnpm test:integration`,
  `git diff --check`, and `pjm precheck` pass before merge.
