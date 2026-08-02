# Client Core Boundary — Infinite Quest Nexus

**Status:** Implemented incrementally through Slice 0, Track C8 (2026-08-02).
**Originally grounded at:** commit `ad73dc1`
**Related:** `/ARCHITECTURE_REVIEW.md` (findings B1, B2, B3), `SCREEN_INVENTORY.md`, `API_UI_CONTRACTS.md`, `INTERACTION_FLOWS.md`

---

## Why this document exists

The original amendment proposed a framework-agnostic package that owns the
business logic so the UI above it is genuinely disposable. Track C implemented
that boundary with one important refinement: browser HTTP, SSE, storage, clock,
delay, visibility, and ID adapters live in `packages/client-web`, while the
transport-neutral generation workflow lives in `packages/client-core`.

The stated product goal is that **the UI can be substantially redesigned or
replaced later without rewriting the business logic.** `FRONTEND_IMPLEMENTATION_PLAN.md`
does not currently satisfy that goal, for a specific and fixable reason.

Its "Components and foundations to build first" places the two most
important pieces of business logic *inside* the new frontend package:

> 2. **One shared API client** — typed against `packages/contracts` …
> 3. **Job-status state machine component/hook** — one implementation of the
>    shared state diagram …

A "component/hook" is framework-coupled by construction. The completed
extraction therefore moved the turn-generation lifecycle out of the legacy
Story Player and into a headless workflow, while leaving presentation in the
app.

**This is an addition, not a correction.** Everything else in
`FRONTEND_IMPLEMENTATION_PLAN.md` — the Vite/TypeScript recommendation, the
slice ordering, the ADR 0020 parallel-route migration pattern, the cutover
criteria — stands unchanged and is adopted here by reference.

---

## The boundary

```
┌─────────────────────────────────────────────────────────┐
│  apps/web-next/          ← replaceable, framework-bound │
│  Components, routing, styling, DOM.                     │
│  MUST NOT contain: API paths, job-status transitions,   │
│  retry policy, error taxonomy, validation rules.        │
└────────────────────────┬────────────────────────────────┘
                         │ imports (one direction only)
┌────────────────────────▼────────────────────────────────┐
│  packages/client-core/   ← durable, framework-agnostic  │
│  Plain TypeScript. Zero DOM. Zero framework imports.    │
│  Owns: generation workflow and machine, ports,          │
│  submission coordination, error taxonomy.               │
└────────────────────────┬────────────────────────────────┘
                         │ ports implemented by
┌────────────────────────▼────────────────────────────────┐
│  packages/client-web/   ← browser adapters              │
│  Typed HTTP client, SSE/poll source, storage, clock,     │
│  delay, visibility, abort, and ID adapters.              │
└────────────────────────┬────────────────────────────────┘
                         │ validates with
┌────────────────────────▼────────────────────────────────┐
│  packages/contracts/     ← already exists, unchanged    │
└─────────────────────────────────────────────────────────┘
```

**The rule, stated so it can be enforced by lint:** `packages/client-core`
may not import from `apps/`, may not reference `window`, `document`,
`HTMLElement`, or any framework package. Add this to
`scripts/check-repository-boundaries.mjs`, which already exists for exactly
this class of rule.

**The corollary for the UI layer:** a conditional in the UI layer may only
be about presentation. Any conditional about *what is true of the domain*
belongs below the line.

---

## Implemented package structure

```
packages/client-core/src/
  errors.ts              Error taxonomy + classification
  generation/            Turn-generation machine, workflow, submission
  ports.ts               Transport- and platform-neutral ports
  index.ts               Public surface

packages/client-web/src/
  api-client.ts          Incrementally adopted, contract-validated routes
  http-client.ts         Standard error envelope + correlation IDs
  generation/            SSE/poll source and fallback policy
  platform/              Clock, delay, visibility, abort, and ID adapters
  storage/               Pending-submission browser storage
```

### `packages/client-web/api-client.ts`

Replaces the two duplicated hand-rolled clients (`nexus.js:269-285` and its
`story.js` twin — `CURRENT_UI_AUDIT.md` UI-005).

- One method per **adopted** endpoint, with request and response types imported
  from `packages/contracts`. Adoption is intentionally incremental; C8 adopts
  the complete Story Player prerequisite/generation set, not all server routes.
- Adopts the better of the two current error shapes: `nexus.js`'s
  correlation-ID-aware object (`nexus.js:276-282`), which already captures
  `statusCode`, `correlationId`, and `details`.
- Owns retry/backoff policy. Fixes the silent-swallow pattern at
  `story.js:1628` and `nexus.js:1460` (`CURRENT_UI_AUDIT.md` UI-003) — a
  failed poll must surface a degraded state, never disappear.
- Injectable `fetch` so tests need no network and no DOM.

### `packages/client-core/generation/` — the highest-value extraction

This lifecycle is now implemented as `GenerationWorkflow` and `GenerationRun`.
The legacy Story Player composes those interfaces and owns only DOM rendering,
scrolling, focus, modals, and toasts. The former app-owned EventSource/poll
loop and timeout policy were deleted rather than retained as a fallback.

Modelled as an explicit machine over the statuses the server actually emits
(`server.ts:762`):

```
queued → assessing → generating → validating → committing → completed
                                             ↘ recoverable → (auto-retry ×1) → …
                                             ↘ failed | cancelled | discarded
```

Requirements:
- **Transport-agnostic.** SSE-primary with poll fallback is an
  implementation detail *inside* this module. When A2.2 of the architecture
  review replaces the server's 350 ms DB poll with `LISTEN/NOTIFY`, nothing
  above this line changes.
- Emits typed `GenerationEvent` values (`status`, `narration`, `degraded`,
  `detached`, `result_unavailable`, and `settled`). No callbacks touch the DOM.
- Owns the auto-retry-once policy for `recoverable`, currently an
  undocumented behaviour buried in a loop body.
- Resolves Q1 by exposing progressive text only as
  `GenerationEvent.narration`; the app no longer reads raw
  `partialNarration` or `partialOutput`.
- Treats a completed job whose result fetch fails as complete-but-loading.
  The only retry for that state is `GenerationRun.fetchResult()`; it does not
  restart the watcher or generation.
- Keeps explicit server cancellation (`cancelGeneration`) distinct from local
  watcher detachment (abort/navigation), and routes discard through the active
  run as well.

### Generic non-generation jobs

A generic watcher for image, Chronicle, world-cover, and import jobs remains
deferred. C8 does not claim that extraction. Illustration calls use the named,
contract-validating `legacy-illustration-api.ts` transition adapter until the
Slice 2 illustration migration.

### `campaign-store.ts` / `world-store.ts` (not implemented in C8)

Plain observable state — a subscribe/notify object, not a framework store.
`story.js`'s existing `state = { … }` object is already close to correct and
should be lifted largely as-is; it is the better of the two current
patterns.

`nexus.js`'s **58 module-level mutable globals** (`nexus.js:12-71`) are the
opposite pattern and must not survive the migration in any form.

### `errors.ts` / `formatting.ts`

Business logic currently stranded in view code:

| Currently at | Moves to | What it is |
|---|---|---|
| `nexus.js:287-304` `worldGenerationFailureMessage` | `errors.ts` | Error taxonomy for `incomplete_generated_world` |
| `nexus.js:314-316` `promptLibraryIsDirty` | `formatting.ts` | Dirty-tracking semantics |
| `story.js:1371-1377` auto-retry decision | `generation.ts` | Retry policy |
| `nexus.js:276-282` error classification | `errors.ts` | HTTP → domain error mapping |

---

## Test strategy: retiring the 872 string assertions

`ARCHITECTURE_REVIEW.md` B3 documents the core problem: roughly **872
`toContain` assertions** across `tests/unit/*ui*.test.ts` match literal text
in HTML and JS source, and `management-ui.test.ts:12-16` locates functions
by `indexOf`-slicing the source file and `eval`s them via `new Function()`.

These tests assert on *spelling*, not behaviour. They break on a rename, a
reformat, or any framework adoption — which makes them the single largest
obstacle to UI replacement.

`FRONTEND_IMPLEMENTATION_PLAN.md` §Testing requirements already gets the
sequencing right and that guidance is adopted unchanged:

> Retire the three string-matching `*-ui.test.ts` files only once their real
> behavior is covered by the new component/integration tests covering the
> same surface — don't delete coverage before its replacement exists.

This amendment adds **where** that replacement coverage lives:

| Tier | Location | Replaces |
|---|---|---|
| 1. Logic | `packages/client-core/**/*.test.ts` — pure, no DOM | The `managementFunction()` eval-slicing pattern entirely. This is what those tests were *trying* to do. |
| 2. Rendering | `apps/web-next` component tests (vitest + `happy-dom`) | Assertions about markup structure and interaction |
| 3. Structural | Keep a **small deliberate set** | Genuine cross-boundary contracts only: CSP (`csp-ui.test.ts`), required meta tags. These are legitimately about markup. |

Delete `managementFunction()` (`management-ui.test.ts:12-16`) and the
`new Function()` call at line 721 once tier 1 exists. They have no
equivalent in the new structure and should not be ported.

---

## Amendment to the slice sequence

`FRONTEND_IMPLEMENTATION_PLAN.md` §Vertical implementation slices is adopted
unchanged. This inserts one slice before it and adds two backend
prerequisites.

### Slice 0 — Client core (new; precedes Slice 1)

Build `packages/client-core` and **point the existing vanilla-JS UI at it**,
before any new-framework work begins.

Order:
1. `packages/client-web/api-client.ts` plus client-core errors, validated
   against `packages/contracts`.
2. `generation/`, lifted from the legacy Story Player.
3. Browser transport/platform adapters in `packages/client-web`.
4. Rewrite `story.js` and `nexus.js` to consume `client-core` — deliberately
   **not** a visual rewrite.
5. Port UI-test coverage to tier 1 as each module lands.

Why against the *old* UI first: it proves the boundary is real while the
system is still fully working, and it de-risks every later slice. If the
existing UI can be driven entirely through `client-core`, a new one
certainly can. If it cannot, the boundary is wrong — and that is far cheaper
to discover here than in Slice 3.

This step also requires the esbuild/Vite build step
(`FRONTEND_IMPLEMENTATION_PLAN.md` §Recommended frontend architecture),
since the current unbundled `<script type="module">` loading
(`index.html:1012`) cannot import a workspace package.

### Backend prerequisites

Two items from `/ARCHITECTURE_REVIEW.md` should land alongside, because the
frontend cannot compensate for either:

| Item | Why it gates UI work |
|---|---|
| **A1** — worker concurrency (`worker.ts:28-60`) | Throughput is capped at 2 concurrent generations deployment-wide. No amount of progress-UI polish fixes a minutes-long queue at trivial concurrency. |
| **A2.1** — world-gen poll 300 ms → 2000 ms (`nexus.js:1449`) | One line. Do it during Slice 0 while that file is already open. |

A2.2 (`LISTEN/NOTIFY` behind the SSE handler) is explicitly **not** a
prerequisite — `generation.ts` hides the transport, so it can land before or
after Slice 0 with no coordination.

---

## Exit criteria

The goal is only met when these are demonstrably true:

1. **`packages/client-core` has zero DOM and zero framework imports**,
   enforced by `scripts/check-repository-boundaries.mjs` in CI — not by
   convention.
2. **Deleting `apps/web/public/*.js` leaves the `client-core` test suite
   green.** This is the falsifiable form of "the UI is replaceable."
3. **A new UI can be built against `client-core` with zero changes to
   `services/` or `packages/`.** Verified by Slice 1 producing no commits
   outside `apps/` and `packages/client-core`.
4. **No remaining test asserts on UI source text**, except the deliberate
   structural set named above.
5. **Every adopted Story Player route is reachable only through a named typed
   client method.** Endpoint adoption outside this slice remains incremental;
   the illustration allowlist is isolated behind its named transition adapter.

Criterion 2 is the one to hold the line on. The others can be argued about;
that one is a command you can run.

---

## What this does not change

- **The backend.** No API redesign. `services/` and `database/` are fixed
  inputs, consistent with the audit's core constraints.
- **`packages/contracts`, `packages/domain`.** Already clean, typed, and
  well-tested. `client-core` consumes them; it does not duplicate them.
- **The framework decision.** Deliberately still open, per the
  framework-neutral direction. `client-core` exists precisely so that
  decision stays cheap and reversible.
- **The remaining UI product specification.** `SCREEN_INVENTORY.md`,
  `DESIGN_SYSTEM.md`, `ACCESSIBILITY_SPEC.md`, `INTERACTION_FLOWS.md`,
  `PRODUCT_UX.md`, `API_UI_CONTRACTS.md`,
  `CURRENT_UI_AUDIT.md`, and `REPOSITORY_UI_MAP.md` remain applicable.
  `API_UI_CONTRACTS.md`, `FEATURE_IMPLEMENTATION_MATRIX.md`,
  `INTERACTION_FLOWS.md`, and `OPEN_QUESTIONS.md` were reconciled with C8.

---

## Open question this raises

**Q-CC1 — Should `client-core` also be consumed by non-browser clients?**

*Why it matters:* If a CLI, a Discord bot, or an MCP server is ever wanted
for Infinite Quest, `client-core` is already the right seam and should be
published as a proper workspace package with a stable public surface. If
not, it can stay internal with a looser API.

*What was searched:* No non-browser client exists or is specified anywhere
in `docs/` or `services/`.

*Recommended default:* Build it internal-only, but keep `index.ts` a
deliberate public surface rather than a barrel re-export of everything, so
promoting it later costs nothing.

*Who should answer:* Product owner.
