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

Runtime implementation reviewed through `26d5890` on branch
`wip/main-uncommitted`.

| Task | Package | Status | Evidence |
|---|---|---|---|
| Task 1 | C0 — baseline, ADR, boundary tests | **Complete** | `04ccb6c`, `d9474f0` |
| Task 2 | C1 — play-loop request/response contracts | **Complete** | `128cc53`, `ff9a420` |
| Task 2a | C1a — stream projection remediation | **Complete** | `ca255a7`, `1fb1b30`, `26d5890`; focused contract/route lifecycle tests; reproducible 2,000-turn validation benchmark |
| Task 3 onward | C2-C8, B1-B5, U1-U6 | Not started | — |

**Current Task 2a verification:** runtime implementation reviewed through
`26d5890`; `pnpm check` passes (468 candidate files), `pnpm build` passes,
`pnpm test:unit` passes 700/700 across 65 files, and
`pnpm check:web-bundle-budget` correctly reports as report-only because
`apps/web-next/dist` does not yet exist.

**Next step:** begin Task 3 (C2). Task 2a exists because
C1 changed the SSE frame shape, and Task 5 (C4) will model its event stream
directly on that projection — fixing it afterwards means rewriting the C4 event
model and its tests.

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

- Create: `docs/architecture/0026-modular-client-and-application-boundaries.md`
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
  adapters. — ADR 0026 §Decision.
- [x] Record current static asset sizes, current Story Player request cadence,
  generation fallback duration, and the existing SSE 350 ms database loop. —
  ADR 0026 §Context, with measured byte counts. The ADR also records that
  `POLL_INTERVAL_MS` is declared at 1,000 ms but unused; the fallback actually
  polls at 400 ms.
- [x] Define the deterministic machine/container profile, fixture sizes, warm-up,
  sample count, and variance policy used for repeatable performance comparisons.
  — ADR 0026 §Performance comparison profile (2 vCPU / 4 GiB, 10/200/2,000-turn
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
  ADR 0026 with `pnpm exec tsx scripts/benchmark-client-contracts.ts`.

### P2 — the terminal error frame was removed without a decision record

The pre-C1 loop wrote `data: {"status":"failed","errorMessage":...}` on a
mid-stream read failure. That frame is gone; the loop now breaks and the client
falls back to polling through `EventSource.onerror`.

This is very likely the correct behavior — a transient database read failure is
not a failed generation, and the old synthetic frame could never satisfy the
schema. But it is a client-visible change made inside a contracts package, and
nothing tests it.

- [x] Confirm the new behavior is intended and record it in ADR 0026.
- [x] Add server/route proof that a mid-stream read failure closes the stream
  without emitting a synthetic terminal status.
- [ ] Add Task 6 fake-EventSource browser coverage proving `EventSource.onerror`
  falls back to polling after the clean stream closure.
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

- [ ] Export only deliberate public surfaces; do not create barrel exports of
  internal files.
- [ ] Add compile-failure fixtures proving client-core cannot reference
  `fetch`, `EventSource`, `localStorage`, `document`, `window`, Node modules, or
  a framework.
- [ ] Add positive fixtures proving client-web may implement core ports with
  Web APIs while remaining framework-free.
- [ ] Provide the no-op `SessionPort` implementation in client-web and thread it
  through the HTTP client in C3, so no later package has to change call
  signatures to introduce authentication.
- [ ] Run package type checks and boundary tests.

**Definition of done:** Core policy can be imported and tested in a pure Node
test without Web-global type shims. Browser implementations are isolated behind
ports and can be replaced without changing workflow code.

---

## Task 4 — C3: Runtime-validating HTTP client and error taxonomy

**Files:**

- Create: `packages/client-web/src/http-client.ts`
- Create: `packages/client-web/src/api-client.ts`
- Create: `packages/client-core/src/errors.ts`
- Create: `tests/unit/client-web/http-client.test.ts`
- Create: `tests/unit/client-web/api-client.test.ts`
- Create: `tests/unit/client-core/errors.test.ts`

**Interfaces produced:**

```ts
export class NexusApiError extends Error {
  readonly statusCode: number;
  readonly correlationId: string | null;
  readonly errorName: string;
  readonly domainCode: string | null;
  readonly details: unknown;
}

export interface RequestSpec<TResponse> {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  responseSchema: z.ZodType<TResponse>;
  body?: unknown;
  responseKind?: "json" | "empty" | "blob";
  signal?: AbortSignal;
}

export interface NexusApiClient {
  campaigns: CampaignApi;
  generation: GenerationApi;
  worlds: WorldApi;
}
```

- [ ] Merge base-path, `no-store`, 204, correlation-ID, and structured-error
  behavior from the existing helpers.
- [ ] Parse every JSON response with the supplied schema and raise a distinct
  `ApiContractError` on malformed success responses.
- [ ] Support JSON, empty, blob, and multipart request/response modes so later
  slices do not create parallel clients for imports and exports.
- [ ] Do not put retry loops in the generic request function.
- [ ] Honor abort signals and preserve AbortError semantics.
- [ ] Test 2xx JSON, 204, blob, malformed JSON, schema mismatch, 4xx without a
  body, structured 4xx, 429 with `Retry-After`, and 5xx.

**Definition of done:** All adopted HTTP calls use one runtime-validating client,
and mutation retry remains an explicit workflow decision rather than an HTTP
status side effect.

---

## Task 5 — C4: Pure durable-generation workflow

This work package extracts the complete generation behavior, not only the
terminal-status switch. It includes submission persistence, idempotent enqueue,
conflict reconciliation, resume, retry, result fetch, detach, and explicit
remote cancellation.

**Files:**

- Create: `packages/client-core/src/generation/types.ts`
- Create: `packages/client-core/src/generation/machine.ts`
- Create: `packages/client-core/src/generation/workflow.ts`
- Create: `packages/client-core/src/generation/submission.ts`
- Create: `tests/unit/client-core/generation-machine.test.ts`
- Create: `tests/unit/client-core/generation-workflow.test.ts`
- Create: `tests/unit/client-core/generation-submission.test.ts`

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

export interface GenerationSnapshotSource {
  watch(jobId: string, signal: AbortSignalLike): AsyncIterable<GenerationStreamSnapshot>;
}
```

**Events produced:**

```ts
export type GenerationEvent =
  | { type: "status"; snapshot: GenerationStreamSnapshot }
  | { type: "narration"; text: string }
  | { type: "degraded"; reason: "stream_lost" | "poll_failed"; consecutiveFailures: number }
  | { type: "detached"; jobId: string }
  | { type: "settled"; outcome: "completed"; result: GenerationResult }
  | { type: "settled"; outcome: "failed" | "cancelled" | "discarded" | "unrecoverable"; error: Error };
```

- [ ] Derive status types from `packages/contracts`; do not redeclare the union.
- [ ] Accept repeated snapshots and skipped observable stages. Reject malformed
  statuses, not legitimate polling gaps.
- [ ] Model retry loops `recoverable -> queued|replacement_queued -> ...` on the
  same durable job ID.
- [ ] Persist the exact idempotent submission before enqueue and expire it after
  the existing 15-minute window using the injected clock.
- [ ] On ambiguous enqueue failure, reconcile through `syncStatus`; replay only
  the exact request with the same idempotency key.
- [ ] Emit narration only from `partialNarration`. Ignore `partialOutput` even if
  a transport includes it.
- [ ] Treat watcher abort as detach. Call the remote cancel endpoint only through
  an explicit `cancelGeneration()` operation.
- [ ] Auto-retry one recoverable job, then emit `unrecoverable` without mutating
  accepted campaign state.
- [ ] Test every terminal state, retry loop, reload resume, conflict, replay,
  expiry, detach, cancellation, duplicate snapshot, skipped stage, stale
  snapshot, and result-fetch failure.

**Definition of done:** The same event sequence is produced for identical job
snapshots regardless of transport. No framework, browser, network, or database
type appears in the workflow.

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

- [ ] Parse every SSE frame with `generationStreamSnapshotSchema` before yielding
  it to client-core.
- [ ] Close EventSource deterministically on terminal state, fallback, detach,
  or consumer failure.
- [ ] Fall back from SSE to polling once without creating overlapping watchers.
- [ ] Poll at 1500 ms initially, back off with jitter to 5000 ms after transport
  failures, emit degraded state after two consecutive failures, and reset after
  a successful snapshot.
- [ ] Use elapsed time and explicit detach rather than a `900 attempts` timeout.
  The durable job remains resumable after local monitoring stops.
- [ ] Pause non-essential polling while the document is hidden; generation
  monitoring may reduce cadence but must preserve resume/reconciliation.
- [ ] Implement the 15-minute pending-submission store with defensive JSON
  parsing and campaign-scoped keys.
- [ ] Test fake EventSource, fake fetch, fake clock, visibility changes, abort at
  each stage, stream loss, malformed frames, and no-duplicate-watcher behavior.

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

export interface JobSnapshotSource<TSnapshot> {
  watch(jobId: string, signal: AbortSignalLike): AsyncIterable<TSnapshot>;
}
```

- [ ] Store only campaign/world projections, accepted turns, selected domain
  options, and durable-job references.
- [ ] Keep scrolling, focus, modals, toast timers, DOM nodes, and rendering flags
  in `apps/`.
- [ ] Define job-family adapters for image, Chronicle, and world-cover statuses;
  do not force unlike payloads into one underspecified status-only type.
- [ ] Make the generic watcher responsible only for scheduling, error/degraded
  events, detach, and terminal detection supplied by the family adapter.
- [ ] Add family-specific tests for `expired`, `partial`, `recoverable`, and
  provider-progress behavior.

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
- [ ] Run `pnpm check`, `pnpm build`, container build, and rendered Compose/Swarm
  configuration checks.

**Definition of done:** A production image serves both UIs from deterministic
build output, local development has one documented command, and Slice 1 needs no
new server or deployment mechanism.

---

## Task 9 — C8: Prove the boundary against the current Story Player

Slice 0 proves the complete generation vertical slice. It does not migrate all
management routes or remove every current network call in one pass.

**Files:**

- Modify: `apps/web/public/story.js`
- Modify: `apps/web/public/story-generation-cancellation.js`
- Modify: `apps/web/public/story.html`
- Modify: `tests/unit/story-player-ui.test.ts`
- Modify: `tests/unit/csp-ui.test.ts`
- Test: new client-core/client-web tests from C3-C6

**Endpoint scope:** session/meta needed by the shell, campaign sync and turns,
turn-input classification, generation enqueue/retry-latest, generation
get/stream/result/retry/cancel/discard, and the campaign state/config calls
needed to preserve the existing play loop. The implementation must inventory the
actual calls in `story.js`; the shorter historical endpoint table is not complete
enough to guarantee behavior parity.

- [ ] Replace the Story Player's API helper for adopted endpoints with
  `NexusApiClient` methods.
- [ ] Replace duplicated SSE/poll terminal branches with the shared workflow.
- [ ] Replace local pending-submission functions with the injected browser store.
- [ ] Keep DOM rendering, scrolling, toasts, focus, modals, and illustration UI
  inside the legacy app.
- [ ] Preserve exact user-visible behavior for submit, retry-latest, resume,
  streamed narration, recoverable, cancel, discard, and completed result.
- [ ] Remove only source-string assertions whose behavior is now covered by
  client-core/client-web tests. Keep presentation assertions until replacement
  components exist.
- [ ] Add a route-level integration test proving malformed generation snapshots
  are rejected before reaching the workflow.
- [ ] Run focused tests, all unit tests, integration tests, and the manual current
  Story Player checklist.

**Rollback boundary (required before merge).** C8 rewires the *live* Story
Player — the highest-stakes path in the product — and this codebase has no
feature-flag mechanism (`REPOSITORY_UI_MAP.md` §11). Recovery must therefore be
planned rather than improvised:

- [ ] Land C8 as a single revertible commit touching only the Story Player and
  its tests. No unrelated refactors ride along; `git revert` must restore the
  previous working client without conflict resolution.
- [ ] Verify the revert on a branch before merging C8 — actually run it, do not
  assume it applies cleanly.
- [ ] Record the manual play-loop checklist result (submit, streamed narration,
  recoverable retry, cancel, discard, completed, reload-resume) in the PR, since
  no automated E2E covers the legacy client until U6.
- [ ] Name the observable regression signals that should trigger the revert:
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
[C0 done] -> [C1 done] -> C1a -> C2 -> C3 -> C4 -> C5 -> C8 -> [Track C complete] -> U1 -> U2
                            \                    -> C6 -/                            |      \
                             \-> C7 -------------------------------------------------/       -> U3/U4 -> U5 -> U6

[C0 done] -> B1 -> B2
              |
              +-> B3
              +-> B4 -----------------------------------------> U5
              +-> B5 (domain-by-domain after generation)
```

C1a is complete and C2 is next. C1a gates C2 because C4 models its event stream on the C1 stream projection;
correcting that projection after C4 exists means rewriting the event model and
its tests. C7 can proceed in parallel from C1a onward. B1 can proceed alongside
C2-C6 now that C1 contracts have stabilized. B2, B3, and B4 are independent
after B1, except that B4 must coordinate its cursor schemas with C1 and land
before U5. B2 must preserve the error-frame behavior confirmed in C1a.

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
