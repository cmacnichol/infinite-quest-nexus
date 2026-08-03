# ADR 0028: Modular client and application boundaries

**Status:** Accepted

> Renumbered from 0026 during the Task 2a review. The original number collided
> with `0026-durable-world-generation-progress.md`, which predates this record
> on `main`.

## Context

Infinite Quest Nexus keeps PostgreSQL authoritative. Browser state, client
stores, generated summaries, and provider context are projections; none may
become a second source of truth for worlds, campaigns, accepted turns, or
Chronicle memory.

The current active browser assets are the legacy static clients. At the C0
baseline, `apps/web/public/` is 808,784 bytes: `nexus.js` is 266,758 bytes,
`story.js` is 123,780 bytes, `nexus.css` is 47,156 bytes, and `story.css` is
31,021 bytes. These uncompressed sizes are a baseline only; Slice 1 applies
the gzip budgets below to Vite output.

The Story Player prefers an SSE generation stream. Its current fallback polls
the generation job every 400 ms for at most 900 attempts (a six-minute maximum
fallback window). `POLL_INTERVAL_MS` remains declared at 1,000 ms but is not
used by that fallback. Illustration job polling is every 5,000 ms and
illustration-resolution polling is every 1,000 ms. The API SSE route currently
performs a database read followed by a fixed 350 ms wait. B2 replaces that loop
with notifications plus bounded reconciliation.

## Decision

The dependency direction is:

```text
apps rendering -> client-web adapters -> client-core workflows -> contracts

API HTTP/SSE adapter -> application use cases <- worker adapter
database and provider adapters -> application ports
```

- `packages/client-core` contains pure workflow and state-transition policy.
  It may use its own modules and contracts, but must not depend on DOM, Node,
  frameworks, network, storage, clocks, timers, or random-ID sources.
- `packages/client-web` contains HTTP, SSE, storage, timer, and clock adapters.
  It may use standard Web APIs, but may not import a UI framework or manipulate
  rendered DOM. Rendering, focus, scrolling, and user interaction belong in
  `apps/**`.
- `packages/application` contains backend use cases and ports. Fastify,
  PostgreSQL, providers, and worker scheduling are adapters around those use
  cases.
- `services/api` and `services/worker` may depend on shared packages but never
  import each other's implementation files after the transition completes.

`scripts/check-client-boundaries.mjs` uses TypeScript's AST parser, not source
text regular expressions, to enforce client and cross-role import boundaries.
It is run by the repository boundary check and has parser-focused unit tests.
The contracts package keeps a lib-clean public barrel at
`packages/contracts/src/index.ts`; Node-only helpers such as
`archives-node.ts` remain explicit imports and are not re-exported from that
barrel. The scanner follows the barrel's transitive import graph and rejects
reachable Node or framework dependencies while allowing unexported platform
helpers to remain package-local.

The `client-core -> contracts` edge is verified by a package-local compiler
fixture that imports the contracts barrel and uses a schema at runtime. Import
specifier scanning remains an architectural guard, but is not treated as proof
that the dependency compiles under client-core's platform-free TypeScript
configuration.

The following temporary worker-to-API imports are the complete transitional
allowlist. New cross-role imports fail the check.

| Import target | Removal work package |
| --- | --- |
| `generation-service.js` | Task 10 (B1) |
| `asset-service.js` | Task 14 (B5) |
| `illustration-resolution-service.js` | Task 14 (B5) |
| `image-service.js` | Task 14 (B5) |
| `memory-service.js` | Task 14 (B5) |
| `segmented-illustration-service.js` | Task 14 (B5) |

## Performance comparison profile

Performance claims use the same Docker Compose application image and pinned
PostgreSQL 18 service as deployment verification. The measurement container is
limited to two vCPUs and 4 GiB memory; it uses Node 24.18.0 and no host network
or browser caches. Record the image digest, CPU architecture, and database
image digest with every result.

The fixture set is deterministic: a 10-turn campaign, a 200-turn campaign, and
a 2,000-turn long-running campaign, each with representative world-version,
generation-job, illustration, and Chronicle relationships. Run five warm-up
requests, then 30 measured requests per route and fixture. Report p50, p95,
payload bytes, query count, and error rate. Re-run a series when its p95 varies
by more than 5%; retain the median of three valid series. A change may not
regress the C0 p95 or query-count baseline by more than 10% without a recorded
measurement, cause, and approved exception.

`pnpm check:web-bundle-budget` reports Vite manifest gzip sizes in CI. It is
intentionally report-only until Slice 1 produces `apps/web-next/dist`; then it
reports a 200 KiB gzip entry budget and a 100 KiB gzip lazy-chunk budget before
the enforcement milestone makes those budgets blocking.

## Task 2a stream and validation baseline amendment

The client has two derived, client-safe generation responses. The polling
response omits raw `partialOutput` but retains durable metadata, including
timestamps. The SSE response is an explicit allowlist of `id`, `campaignId`,
`expectedTurnNumber`, `status`, `action`, `operationKind`, `replacementTurnId`,
`attempts`, `partialNarration`, `errorMessage`, `errorCode`, and `resultTurnId`.
Both projections discriminate operation provenance: `append` always has
`replacementTurnId: null`, while `replace_latest` always has the immutable UUID
of the replaced turn. `attempts` is the monotonic retry-cycle marker for future
stream reconciliation; timestamps are deliberately absent because worker lease
renewal changes `updatedAt` without changing client-visible progress. Recovery
metadata and recovery-only raw errors are not stream fields.

`pnpm exec tsx scripts/benchmark-client-contracts.ts` uses a deterministic
2,000-turn response, five warm-up parses, and 30 measured parses. The Task 2a
run on Node 24.18.0 retained the median of three Task 7P series:
`turnListResponseSchema` p50 1.480 ms and p95 2.281 ms. It measures validation cost only, not
database-query or full-route latency; B4 must compare its bounded route against
this explicit pre-pagination amendment rather than charge it to the 10% C0
budget.

With the same fixture, the pre-C1 seven-field JSON payload is 229 bytes, the C1
full client-safe polling JSON payload is 517 bytes, and the Task 7P SSE stream JSON
payload is 351 bytes. These are serialized JSON payload bytes, not complete SSE
wire frames. The benchmark's deterministic `initial -> lease renewal only -> completed`
sequence emits two frames for the pre-C1 hand-built projection, three frames for
the C1 full client-safe projection, and two frames for the Task 2a stream
projection. `scripts/benchmark-client-contracts.ts` validates its exact SSE
allowlist at runtime and its unit test fails if that contract drifts. For a generating row, a lease-only `updatedAt` renewal produces the
same Task 2a JSON and therefore no extra SSE frame; a status transition to
completed produces the second frame. B2 must preserve that dedupe behavior.

After an initial valid SSE frame, a later job read error closes the stream
without fabricating a `failed` frame. This distinguishes stream transport
failure from durable generation failure. The legacy Story Player continues to
fall back from `EventSource.onerror` to polling; Task 6 owns its executable fake
EventSource coverage.

## Consequences

The client replacement can change rendering frameworks without reimplementing
workflow policy. Backend modularization can move API/worker behavior behind
ports without changing HTTP contracts. The temporary allowlist makes the
existing cross-role coupling visible and gives every exception an owning removal
task rather than silently normalizing it.
