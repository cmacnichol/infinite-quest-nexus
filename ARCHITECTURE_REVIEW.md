# Architecture & Performance Review — infinite-quest-nexus

**Reviewed at:** commit `ad73dc1` (2026-08-01)
**Scope:** performance, scalability, modularity, coupling, testability, and whether the UI can be replaced without rewriting business logic.
**Method:** direct source inspection of `services/`, `packages/`, `apps/web/public/`, `database/migrations/`, `tests/`, plus repo health metrics.

---

## Verdict

The **backend domain modelling is better than it looks from the metrics.** Job claiming uses `FOR UPDATE SKIP LOCKED` with partial indexes (`generation-service.ts:1271`), leases are real, migrations are disciplined (50 ordered files, checked by `tests/integration/migrations.integration.test.ts`), archive ingestion has genuine zip-bomb defenses (`archive-io.ts`), and multi-tenant scoping (`owner_user_id` on every table) is applied consistently. Someone thought carefully about durability and security.

That competence makes the rest more frustrating, because two decisions have quietly capped this system:

1. **Throughput is architecturally capped at 2 concurrent story generations for the entire deployment**, regardless of hardware. This is not a tuning problem; it is written into the worker loop.
2. **The UI cannot currently be replaced without rewriting the business logic**, because the business logic lives *inside* the UI, and ~872 test assertions are string-matches against UI source text. A UI rewrite today means deleting most of the test suite that protects the app.

The codebase is roughly at the point where it stops being a prototype and starts charging interest. The bill is not yet large. It will be.

**Health snapshot (measured):** 50.1% of code lines sit in the "alert" band. The seven largest service files — 8,300 lines total — have **zero paired unit tests**. `generation-service.ts` has a max cyclomatic complexity of **122** in a single function.

---

## Severity legend

| | Meaning |
|---|---|
| **S1** | Caps scalability or blocks a stated goal (UI replaceability). Fix now. |
| **S2** | Real cost today, compounding. Fix this quarter. |
| **S3** | Debt worth scheduling. Defer with intent, not by accident. |

---

# Part A — Performance & Scalability

## A1. The worker can run exactly one generation at a time. `S1`

**Files:** `services/worker/src/worker.ts:28-60`, `deploy/swarm/stack.yaml:92`

```js
let activeGeneration: Promise<boolean> | null = null;
while (!signal.aborted) {
  if (!activeGeneration) {                                    // ← at most ONE, ever
    const claimed = await claimGeneration(pool, workerId, …);
    if (claimed) activeGeneration = executeGenerationJob(…)
      .finally(() => { activeGeneration = null; });
  }
  const refined     = await runIllustrationPromptJob(…);
  const resolved    = refined     || await runIllustrationResolutionJob(…);
  const illustrated = resolved    || await runImageJob(…);
  const chronicled  = illustrated || await runChronicleJob(…);
  const backfilled  = chronicled  || await runAssetMetadataBackfill(…);
```

**Why this is a problem.** Two independent ceilings, both invisible from the outside:

- The `if (!activeGeneration)` guard permits **one** in-flight generation per process. With `replicas: 2`, the entire production deployment supports **two concurrent story turns**. Player #3 waits in `generation_jobs` until a slot frees. Story generation is a multi-minute LLM call, so this is a minutes-long queue at trivial concurrency.
- The `a || await b()` chain is a **short-circuit, not a scheduler**. If `runIllustrationPromptJob` returns truthy, every other job type is skipped this tick. One busy illustration queue starves chronicle indexing and asset backfill indefinitely. These jobs are independent and I/O-bound — there is no reason they cannot overlap.

Both are pure waste: the work is almost entirely *waiting on remote LLM/image APIs*, not consuming local CPU. The process sits idle while holding the queue closed.

**Fix.** Replace the single-slot guard and the boolean chain with a bounded concurrency pool per job type:

```js
const limits = { generation: 4, illustration: 3, image: 3, chronicle: 2, backfill: 1 };
// Track in-flight counts per type; each tick, top every pool up to its limit.
// Claim N jobs where N = limit - inflight. SKIP LOCKED already makes this safe.
```
The claim SQL already uses `FOR UPDATE SKIP LOCKED` — **the database layer is already correct for this**. Only the loop needs to change. Make each limit an env var so it can be tuned per deployment without a rebuild.

**Impact:** ~4-8× throughput per worker replica, with no new infrastructure.
**Effort:** M (1-2 days including load verification).
**Verdict: Fix now.** This is the single highest-leverage change in the repository.

---

## A2. The SSE channel is a database poll in disguise, and covers only one job type. `S2`

**Files:** `services/api/src/server.ts:724-793`, `apps/web/public/story.js:1246-1250`, `apps/web/public/nexus.js:1449-1461`

> **Correction.** An earlier draft of this review stated no SSE endpoint existed. That was wrong — the grep pattern `sse` matched `a`**`sse`**`tStore` lines and truncated before the real hit. `GET /api/v1/generation-jobs/:jobId/stream` exists and `story.js:1246` consumes it via `EventSource`, with `pollGenerationJob` as fallback. `docs/ui/API_UI_CONTRACTS.md:52` already documented this correctly. The finding below is the corrected version; severity drops from S1 to S2.

Turn generation — the highest-stakes path — **does** have a push channel, and it only writes frames on change (`server.ts:757`). That is a good design. But look at how it is fed:

```js
while (!isClosed) {
  const job = await getGenerationJob(pool, jobId);   // ← a DB query…
  …
  if (currentJson !== lastSentJson) reply.raw.write(`data: ${currentJson}\n\n`);
  …
  await new Promise((resolve) => setTimeout(resolve, 350));   // ← …every 350 ms
}
```

**Why this is a problem.** The SSE handler is a **350 ms polling loop against Postgres**, one per connected client, holding an open HTTP connection for the entire multi-minute generation. The polling did not go away; it moved from the browser to the API process, where it now also consumes a connection from the 12-slot pool (`pool.ts:8`) for the duration. Ten concurrent players = ~29 queries/second of pure status-checking, contending with the workers that need that same pool to claim and commit jobs.

Coverage is also uneven — only generation has a push channel:

| Job type | Channel | Interval |
|---|---|---|
| Turn generation | SSE (server-side 350 ms DB poll) | 350 ms server-side |
| World-gen progress (`nexus.js:1449`) | Client poll | **300 ms** ← worst offender, verified |
| Image jobs (`story.js:1601`) | Client poll | 5 s |
| Chronicle / world-cover jobs | Client poll | unbounded |

The 300 ms world-generation poll is genuinely the worst: three requests per second, for minutes, to watch a progress bar — and it exists to mask the serial character generation in A6.

**Fix (staged):**
1. **Immediate:** raise the world-gen poll 300 ms → 2000 ms (`nexus.js:1449`). One line, ~85% fewer requests on that path.
2. **Proper:** replace the SSE handler's `setTimeout(350)` loop with Postgres `LISTEN/NOTIFY`. Have the worker `NOTIFY` on job-state transitions; the handler then blocks on the notification instead of spinning. Same client contract, no client change, and DB load drops from *N clients × 3/sec* to *one notification per actual state change*.
3. Extend the same push channel to image and world-cover jobs, retiring their client polls.

**Verdict: Step 1 now (one line). Steps 2-3 next quarter.** The client contract is already correct — this is a server-side implementation swap behind a stable interface, which is the cheap kind of fix.

---

## A3. No ANN index on the embedding column. `S2`

**Files:** `database/migrations/0007_semantic_chronicle.sql:41`, `services/api/src/memory-service.ts:741-756`

```sql
CREATE INDEX chronicle_memories_embedding_scope_idx
  ON chronicle_memories(owner_user_id, campaign_id, embedding_provider_profile_id, embedding_model)
  WHERE embedding IS NOT NULL;          -- ← B-tree on scope. The vector is NOT indexed.
```
```sql
ORDER BY embedding <=> $5::vector LIMIT 96    -- memory-service.ts:752
```

Confirmed by grep: **no `ivfflat`, no `hnsw`, no `vector_cosine_ops` anywhere in `database/migrations/`.**

**Why this is a problem — stated precisely.** This is *not* a full-table scan. The partial B-tree correctly narrows to one campaign's memories first, so cost is **O(memories in that campaign)**, not O(all memories in the system). That bounding is why this hasn't hurt yet, and it's why I'm rating this S2 rather than S1.

But within that bound it is an exact KNN: every qualifying row's vector is fetched and a full distance computation runs against it. Cost grows linearly with campaign length, and it runs **on every single turn** as part of context assembly — directly on the critical path of the thing users wait for. A 200-turn campaign is fine. A 5,000-memory campaign is a multi-hundred-millisecond tax on every turn, forever, and long campaigns are precisely this product's success case.

**Fix.** Add an HNSW index (better recall/latency than IVFFlat and needs no training step):

```sql
CREATE INDEX chronicle_memories_embedding_hnsw_idx
  ON chronicle_memories USING hnsw (embedding vector_cosine_ops)
  WHERE embedding IS NOT NULL;
```
Caveat worth knowing before you ship it: pgvector's HNSW index does not support multiple embedding dimensions in one index. The query filters on `embedding_dimensions = $6` (`memory-service.ts:750`), implying mixed-dimension rows across provider profiles. Either partition the index per dimension, or enforce a single dimension per campaign at write time. **Measure first** — `EXPLAIN ANALYZE` the query against your largest real campaign — so you size the fix to the actual curve.

**Verdict: Defer to next quarter, but instrument now.** Add timing on this query today so you see the curve before users do.

---

## A4. `APP_ROLE=all` puts CPU-bound image work on the API event loop. `S2`

**Files:** `compose.yaml:27`, `services/runtime/src/main.ts:52-56`, `services/api/src/asset-service.ts:131-141`

```js
} else if (roleConfig.role === "all") {
  const server = await buildServer({ config: roleConfig, pool });
  await server.listen(…);
  await runWorker(pool, roleConfig, signal);     // same process, same event loop
}
```

`compose.yaml` — the default developer and small-deployment path — uses `APP_ROLE: all`. In that mode, `sharp` thumbnailing (`asset-service.ts:136-140`), zip construction (`archive-io.ts`), and `Buffer.concat` of full image payloads (`image-service.ts:632`) all execute in the same process serving HTTP.

`sharp` does most work on libuv's threadpool, which softens this — but `.toBuffer()` resolution, metadata parsing, and the surrounding zip/hash work land on the main thread. The default threadpool is **4 threads**, shared with all `fs` operations. Under concurrent asset ingestion, API p99 latency degrades noticeably. Grep confirms **no `sharp.concurrency()` cap and no `worker_threads` anywhere** — nothing bounds this.

**Fix.**
- Document `APP_ROLE=all` as development-only; production (`deploy/swarm/stack.yaml`) already separates roles correctly — mirror that guidance in `README.md` and `compose.yaml` comments.
- Set `sharp.concurrency(2)` and raise `UV_THREADPOOL_SIZE` to 8 in the container.
- Long-term: move thumbnailing to a `worker_threads` pool (or Piscina) so it can never touch the request path.

**Verdict: Config changes now (hours). Thread pool deferred.**

---

## A5. Import performs one round trip per row inside a single transaction. `S2`

**File:** `services/api/src/import-service.ts:1035-1147`

Eight sequential loops, each issuing one `INSERT` per element and awaiting it:

| Loop | Line | Table |
|---|---|---|
| turns | 1035 | `turns` |
| profile edits | 1046 | `campaign_character_profile_edits` |
| state edits | 1054 | `campaign_state_edits` |
| migrations | 1063 | `campaign_world_migrations` |
| memories | 1079 | `chronicle_memories` |
| summaries | 1087 | `summary_checkpoints` |
| illustration sets | 1120 | `turn_illustration_sets` |
| illustration segments | 1128 | `turn_illustration_segments` |

**Why this is a problem.** A 500-turn campaign with illustrations issues **2,000+ sequential round trips**, each paying full network latency, inside one long-lived transaction. That transaction holds a pool connection (1 of 12) for its entire duration and pins the oldest transaction ID, blocking vacuum on hot tables. On managed Postgres with ~1 ms RTT that is 2+ seconds of pure latency; on a cross-AZ connection it is far worse. Import is also user-facing and synchronous, so this is felt directly.

**Fix.** Batch with `UNNEST`, which keeps parameterization and is a mechanical transformation:

```sql
INSERT INTO turns (id, owner_user_id, campaign_id, turn_number, …)
SELECT * FROM UNNEST($1::uuid[], $2::uuid[], $3::uuid[], $4::int[], …)
```
Chunk at ~1,000 rows to stay under the 65,535 bind-parameter ceiling. Expect **10-50× faster imports** and a dramatically shorter transaction. Do the `turns`, `chronicle_memories`, and `turn_illustration_segments` loops first — they carry the row volume.

**Verdict: Fix now for the three high-volume loops.** They are independent, individually testable, and `tests/integration/import-memory.integration.test.ts` already covers the behaviour.

---

## A6. World generation makes N serial LLM calls with no concurrency. `S2`

**File:** `services/api/src/world-generator-service.ts:636-700`

```js
for (const [characterIndex, seed] of converted.character_seeds.entries()) {
  …
  const characterResult = await callGeneratedWorldProvider(() =>
    dependencies.callTextProvider(profile, characterRequest));   // serial, N times
```

Each character is a full LLM round trip (5-20 s), plus a possible *second* recovery call on parse failure (line 683). Eight character seeds = 1-3 minutes of wall-clock, all serial. This is what the 300 ms progress poll (A2) exists to paper over.

**A genuine constraint, stated fairly:** these calls are *not* fully independent. Line 660 passes `acceptedCharacterNames: rawCharacters.map(c => c.name)` — each generation sees previously accepted names to avoid duplicates. Naive `Promise.all` would break that de-duplication. This is a real design decision, not an oversight.

**Fix.** Two options, in order of preference:

1. **Batch the constraint out.** Pre-assign all character names in the *initial* world call (the seeds already carry `name` at line 637), then generate the full profiles concurrently with `Promise.all` and a concurrency cap of 3-4. Names are already known, so the cross-call dependency disappears entirely. This is the right fix.
2. **Windowed concurrency.** If names must stay emergent, run in waves of 3, passing accumulated names between waves. Simpler, ~3× speedup instead of ~8×.

**Verdict: Defer, but schedule.** Meaningful UX win (minutes → seconds), and A2's polling cost shrinks with it. Take option 1 when world-generation is next touched.

---

## A7. Connection pool is undersized for the polling load. `S3`

**File:** `packages/database/src/pool.ts:8`

`max: 12` default, shared between API request handling *and* worker job claiming when `APP_ROLE=all`. Given A2's polling volume and A5's long transactions, 12 is thin. Raise to 25-30 for the API role, and set `statement_timeout` on the pool so a pathological query cannot hold a connection indefinitely. Cheap, low-risk.

**Verdict: Fix now** — it is a one-line change plus a load test, and it partially mitigates A2 and A5 while those are in flight.

---

## A8. Dependency and artifact bloat. `S3`

- **`/index.html` — 537 KB, 10,838 lines, committed at the repo root, and dead.** `server.ts:259` redirects `/index.html` → `/nexus/` (308), and `tests/unit/server-security.test.ts:116` explicitly asserts it is *never served*. Last touched in `de58b7e`. It is a superseded prototype inflating every clone and every `git` operation. **Delete it.**
- **Three zip libraries.** `archiver` (write) + `unzipper` (read) in `archive-io.ts:1,20`, plus a bundled `jszip.min.js` (98 KB) served to the browser. `archiver`/`unzipper` splitting read/write is defensible. The browser-side `jszip` should be checked — if client-side zipping is vestigial, drop it and save 98 KB on every page load.
- **`photoswipe`** is a runtime dependency in `package.json` but is vendored under `/vendor/photoswipe/`. Pick one delivery mechanism.

**Verdict: Delete `/index.html` now** (30 seconds, pure win). Audit the rest opportunistically.

---

# Part B — Modularity, Coupling & UI Replaceability

> This is the section that matters most for the stated goal. **The honest answer to "can the UI be replaced without rewriting business logic?" is: not today.** Here is exactly what stands in the way, and what to do about it.

## B1. Business logic lives inside the UI, not behind it. `S1`

**Files:** `apps/web/public/nexus.js` (5,077 lines), `apps/web/public/story.js` (2,902 lines)

`nexus.js` declares **58 module-level mutable globals**:

```js
let selectedFile = null;            let worlds = [];
let selectedCampaign = null;        let campaigns = [];
let worldAuthorWorkingContent = null;
let campaignCharacterProfileRevision = 0;
let transferPreview = null;         let promptLibrary = null;
… 50 more
```

There is no state container, no store, no observable — just file-scope variables mutated from anywhere in 5,000 lines. Every function both computes and touches the DOM. The file makes **104 `createElement` calls** and 28 `getElementById`/`querySelector` calls, interleaved with validation rules, state transitions, and error-classification logic.

Concrete examples of business logic stranded in the view layer:
- `worldGenerationFailureMessage` (`nexus.js:287-304`) — error taxonomy and message synthesis
- `promptLibraryIsDirty` (`nexus.js:314`) — dirty-tracking semantics
- Retry, recovery, and cancellation orchestration (`story.js:1335-1382`) — the entire durable-job state machine, including the auto-retry policy for `recoverable` jobs, exists **only** in the browser

That last one is the sharpest: if you rewrite the UI, you must re-derive the generation lifecycle state machine from scratch by reading 2,900 lines of vanilla JS, because it is written down nowhere else.

**Credit where due:** `story.js` is meaningfully better than `nexus.js` — it has a single coherent `state = { … }` object. The pattern to standardise on already exists in the repo; it just wasn't applied to `nexus.js`.

**Fix.** Extract a framework-agnostic client core, shipped as `packages/client-core` (plain TypeScript, zero DOM):
```
packages/client-core/src/
  api-client.ts        ← typed wrappers over all 106 routes
  generation-machine.ts ← the durable-job lifecycle, lifted from story.js:1335-1382
  campaign-store.ts     ← state + transitions, no DOM
  formatting.ts         ← error taxonomy, dirty-tracking, display helpers
```
Rule going forward: **the UI layer may not contain a conditional that isn't about presentation.** Any new UI can then bind to `client-core` and be genuinely disposable.

**Verdict: Fix now — this is the enabling change for the entire goal.** Nothing else in Part B is achievable until this exists.

---

## B2. The typed contracts stop at the network boundary. `S1`

**Files:** `packages/contracts/src/*` (10 files, 102 public symbols), `apps/web/public/*.js`

Grep result: **`apps/web/public/` references `packages/contracts` zero times.**

There is a well-built Zod contracts package — `generation.ts` (453 lines), `archives.ts`, `world-library.ts`, `imports.ts` — and the browser cannot use a single symbol from it, because the frontend is unbundled vanilla JS loaded via `<script type="module">` (`index.html:1012`) with no build step.

The frontend's entire API layer is this (`nexus.js:269-285`):
```js
async function api(path, options = {}) {
  const response = await fetch(path, {…});
  const payload = await response.json().catch(() => ({}));
  …
  return payload;                              // `any`, forever
}
```

**Why this is a problem.** Every one of the 106 endpoints is consumed as untyped JSON. A renamed backend field produces no compile error, no test failure, and no runtime error — just a silently `undefined` value rendering as blank in the UI. This is the mechanism behind `nexus.js` ranking in the **top 0% for change entropy** ("changes scattered across noisy commits") — the repo's own strongest historical fault predictor. The file churns because nothing catches breakage early.

It also means the contracts package's value is currently ~50% realised: it validates the server side of the boundary and nothing else.

**Fix.** Introduce a minimal build step — `esbuild` is already an allowed build dependency in `pnpm-workspace.yaml`. This is not a framework migration; it is a bundler, and it unlocks:
- importing `@nexus/contracts` types directly in client code,
- type-checking `client-core` against the same schemas the server validates with,
- tree-shaking (the 98 KB `jszip.min.js` and vendored PhotoSwipe stop being separate `<script>` tags).

Then generate the API client from contracts so a route signature change is a **compile error**, not a production blank field.

**Verdict: Fix now, together with B1.** They are the same piece of work and cheap to do together, expensive to retrofit separately.

---

## B3. The UI test suite is welded to UI source text. `S1`

**Files:** `tests/unit/management-ui.test.ts` (479 assertions), `tests/unit/story-player-ui.test.ts` (334), `tests/unit/dashboard-ui.test.ts` (60), `tests/unit/prompt-library.test.ts` (16), `tests/unit/cyoa-template.test.ts` (7)

**~872 `toContain` assertions matching literal strings in HTML and JS source.**

```js
const managementHtml   = readFileSync("apps/web/public/index.html", "utf8");
const managementScript = readFileSync("apps/web/public/nexus.js", "utf8");

expect(managementHtml).toContain('id="promptLibraryScope"');
expect(managementScript).toContain('function loadPromptLibrary()');
expect(managementScript).toContain("promptLibraryEditorBaseline");
```

And, worse, `management-ui.test.ts:12-16`:
```js
function managementFunction<T>(name: string): T {
  const start = managementScript.indexOf(`function ${name}(`);
  const end   = managementScript.indexOf("\nfunction ", start + 1);
  return Function(`${managementScript.slice(start, end)}; return ${name};`)() as T;
}
```

This locates a function by **string-slicing the source file** and `eval`s it.

**Why this is the single biggest obstacle to the stated goal.** These tests assert on *implementation text*, not behaviour. They break if you:
rename a DOM id · reformat a function · convert a `function` declaration to `const` · adopt any framework · change indentation.

`index.html` contains **448 element ids**, a large share of which are load-bearing for tests. So the current position is:

> Replacing the UI requires deleting ~872 assertions — and those assertions are, for several of these behaviours, **the only test coverage that exists**, because the seven largest service files have no unit tests at all (Part C).

The test suite is not protecting the application. It is protecting the *current spelling* of the application, while charging the full maintenance cost of real tests. `management-ui.test.ts` has 7 recorded bug-fixes and 35 commits in 90 days — it is one of the highest-churn files in the repo, which is exactly what a brittle test file looks like.

**Fix.** Re-point these tests at behaviour, in three tiers:
1. **Contract tests** against `packages/client-core` (B1) — pure functions, no DOM, no source-slicing. This is where `managementFunction()`'s intent belongs, done properly.
2. **DOM tests** via `linkedom` (already a dev dependency, already used elsewhere) — render, interact, assert on *output*, never on source text.
3. **Keep a small, deliberate set** of structural assertions for genuine cross-boundary contracts — CSP headers (`csp-ui.test.ts`), required meta tags. These are legitimately about markup and should stay.

Delete `managementFunction()` and its `new Function()` sibling at line 721 outright once tier 1 exists.

**Verdict: Fix now, in lockstep with B1.** Every week this persists, more assertions accrete and the eventual UI replacement gets more expensive. This is the debt with the steepest interest rate in the repository.

---

## B4. `server.ts` is 106 routes in one 1,009-line file. `S2`

**File:** `services/api/src/server.ts` (max CCN **79**)

All 106 route registrations live in one function — health checks, static serving, users, providers, imports, worlds, campaigns, turns, archives, assets. Routing, validation wiring, and error mapping are interleaved.

**Why this is a problem.** It is a permanent merge-conflict surface (git health flags `services/api` as the top-churn module), it prevents per-domain middleware, and it makes the API's actual shape unreadable — you cannot answer "what does the campaign API expose?" without reading 1,000 lines.

Note the codebase **already knows the better pattern**: `archive-routes.ts` is a proper Fastify plugin registered at `server.ts:243`. The fix is to apply the existing convention consistently.

**Fix.** Split into plugins mirroring the domains — `routes/worlds.ts`, `routes/campaigns.ts`, `routes/providers.ts`, `routes/imports.ts`, `routes/assets.ts`, `routes/generation.ts`. `server.ts` becomes ~80 lines of registration. Mechanical, low-risk, and integration tests already cover the routes.

**Verdict: Defer to next quarter** — but do it *before* the SSE work in A2, so the new endpoint lands in a sane structure rather than growing the file to 1,100 lines.

---

## B5. No data-access layer; SQL is inlined throughout the services. `S2`

**Files:** `generation-service.ts` (64 inline queries), `world-service.ts` (40), `import-service.ts` (40), `memory-service.ts` (30), `asset-service.ts` (25)

Raw SQL string literals sit directly inside orchestration functions. There is no repository or query-module layer.

**Why this is a problem.**
- **Untestable without a live database.** This is precisely why the seven largest service files have zero unit tests — you *cannot* unit test them as written. The 21 integration tests are doing work that unit tests should do, which is why they are slow and why they show `co_change_scatter` with 25-34 files each.
- **Schema changes require grepping** for column names across thousands of lines.
- **Multi-tenant safety is manual.** Every query must remember `AND owner_user_id = $n`. It is applied correctly today — I checked several — but it is enforced by discipline, not structure. One omission is a cross-tenant data leak.

**Fix.** Extract `packages/repositories` with typed, focused query modules (`campaigns.ts`, `turns.ts`, `memories.ts`, `assets.ts`). Have each repository take `ownerUserId` as a **mandatory first parameter** so tenant scoping is structurally enforced rather than remembered. Services then take repository interfaces and become unit-testable with plain fakes.

**Verdict: Defer, but start opportunistically.** Do not attempt a big-bang extraction. Extract the repository for whichever service you are already modifying — starting with `generation-service.ts`, which has 9 recorded bug fixes and the worst maintainability score in the repo (1.9/10).

---

## B6. `executeGenerationJob` is a 630-line function with cyclomatic complexity 122. `S2`

**File:** `services/api/src/generation-service.ts:1641-2272`

Repo-wide maximum complexity. For scale: 122 independent paths means exhaustive branch coverage is not achievable by any realistic test suite. Maintainability score **1.9/10** — the lowest in the codebase. Nine recorded bug fixes, most recent today. This is the definition of a bug magnet, and the metrics agree.

It handles: provider dispatch, streaming, JSON parse/recovery, schema validation, mechanics-leak detection, retry policy, lease renewal, cost recording, and commit — in one scope, nested up to 7 levels deep.

**Fix.** Extract the pipeline stages into named, individually testable functions:
```
assessTurnIntent → buildPromptContext → callProvider
  → parseAndRecover → validateSchema → detectMechanicsLeak → commitTurn
```
Each becomes independently unit-testable; `executeGenerationJob` becomes a ~60-line orchestrator. The seams already exist conceptually — `commitStory` (line 1425) and `loadOrchestrationInputs` (line 1314) are already extracted, proving the pattern works here.

**Verdict: Defer, but treat as a boundary.** Do not add another branch to this function. Extract one stage each time it is touched. If it grows before it shrinks, escalate to S1.

---

## B7. Duplication between the two frontend files. `S3`

Navigation menu handling is copy-pasted verbatim — `nexus.js:4474-4488` and `story.js:2397-2414` (18 identical lines, confirmed via duplication analysis). They also independently reimplement toast notifications, delay helpers (`nexus.js:1491` and `nexus.js:3661` — duplicated *within the same file*), and job-status rendering.

Real but minor, and B1 dissolves it as a side effect. **Verdict: Defer** — folds into the `client-core` extraction at no extra cost.

---

# Part C — Testability

**Test suite (48 files) is inverted.** Counting what exists against what it protects:

| Layer | Coverage |
|---|---|
| `packages/domain`, `packages/contracts` | Genuinely good — pure functions, properly tested |
| Integration (21 files) | Broad and real, but slow; carrying load that belongs in unit tests |
| **The 7 largest service files (8,300 lines)** | **`has_test_file: false` — zero paired unit tests** |
| UI (872 assertions) | Tests source text, not behaviour (B3) |

The seven untested files are `generation-service.ts`, `memory-service.ts`, `world-service.ts`, `image-service.ts`, `import-service.ts`, `asset-service.ts`, `server.ts`. These are simultaneously the largest, the most complex, the most-changed, and the least tested files in the repository — and by the repo's own git history, the ones with the most bug fixes.

This is not carelessness; it is a **direct consequence of B5**. They cannot be unit tested while SQL is inlined. Fixing the data-access layer is what makes them testable — which is why B5 unblocks Part C and should be sequenced accordingly.

---

# Prioritized Refactoring Plan

Sequenced so each phase unblocks the next. Effort is engineer-days for one person familiar with the code.

## Phase 0 — Immediate (≈1 day, ship this week)

| # | Action | File | Effort |
|---|---|---|---|
| A2.1 | World-gen poll 300 ms → 2000 ms; generation *fallback* poll 400 ms → 1500 ms + backoff | `nexus.js:1449`, `story.js:1382` | 1 h |
| A8 | Delete dead 537 KB `/index.html` | repo root | 5 min |
| A7 | Pool `max` 12 → 25; add `statement_timeout` | `pool.ts:8` | 1 h |
| A4 | `sharp.concurrency(2)`; `UV_THREADPOOL_SIZE=8`; document `APP_ROLE=all` as dev-only | `Dockerfile`, `compose.yaml` | 2 h |
| A3.1 | Add timing instrumentation to the KNN query | `memory-service.ts:741` | 1 h |

*Highest ratio of benefit to risk in the entire plan. No architectural commitment.*

## Phase 1 — Throughput (≈1 week)

| # | Action | Effort |
|---|---|---|
| **A1** | **Replace single-slot worker guard with per-type bounded concurrency pools** | 2 d |
| A5 | Batch the three high-volume import loops via `UNNEST` | 2 d |
| — | Load-test: 20 concurrent generations, verify pool and queue behaviour | 1 d |

*A1 is the single highest-leverage change in the repository — a ~4-8× throughput increase touching one file.*

## Phase 2 — UI independence (≈3 weeks) — **the stated goal**

This is the sequence that makes the UI genuinely replaceable. Order matters.

1. **Add `esbuild` build step** for `apps/web` (B2) — 2 d.
   Unlocks everything below. No framework decision required yet.
2. **Create `packages/client-core`** (B1) — 5 d.
   Extract in this order: `api-client.ts` (typed, generated from `packages/contracts`) → `generation-machine.ts` (lift the lifecycle out of `story.js:1335-1382`) → `campaign-store.ts` → `formatting.ts`. Zero DOM imports; enforce with a lint rule.
3. **Rewrite UI tests against `client-core`** (B3) — 5 d.
   Delete `managementFunction()` and the `new Function()` call at line 721. Convert the ~872 source-text assertions to behavioural tests. Keep only genuine markup contracts (CSP, meta tags).
4. **Point existing vanilla-JS UI at `client-core`** — 3 d.
   Deliberately *not* a rewrite. Proving the existing UI works as a pure consumer is what demonstrates the boundary is real.

**Exit criterion — the goal, made falsifiable:** a new UI can be built against `packages/client-core` with **zero changes to `services/` or `packages/`**, and the `client-core` test suite passes untouched when `apps/web/public/*.js` is deleted.

## Phase 3 — Structural debt (ongoing, opportunistic)

| # | Action | Trigger |
|---|---|---|
| B4 | Split `server.ts` into route plugins | Before the A2.2 SSE work |
| B5 | Extract `packages/repositories`, `ownerUserId` mandatory | Per-service, when next modifying it |
| B6 | Decompose `executeGenerationJob` into pipeline stages | One stage per touch; **do not add branches** |
| A2.2 | Replace SSE handler's 350 ms DB poll with `LISTEN/NOTIFY`; extend push to image/cover jobs | After B4 |
| A6 | Concurrent character generation (pre-assign names) | When world-gen is next touched |
| A3.2 | HNSW index, after measuring Phase 0 instrumentation | When p95 exceeds ~50 ms |

---

## What this codebase gets right

Stated plainly, because it should inform what you *don't* touch:

- **Job durability is genuinely well engineered.** `FOR UPDATE SKIP LOCKED` + leases + attempt counting + partial indexes on all five queues. Do not rewrite this — A1 only needs the *loop* changed, not the claiming.
- **Multi-tenant isolation is consistently applied.** `owner_user_id` on every table and every query. B5's mandatory-parameter design makes it structural rather than remembered.
- **Archive ingestion is defensively written.** Expansion-ratio caps, entry limits, path traversal checks, content verification (`archive-io.ts`). This is security-conscious code.
- **Migrations are disciplined.** 50 ordered files, order enforced by test, maintenance migrations gated behind a flag.
- **`packages/domain` and `packages/contracts` are clean.** Pure, well-tested, dependency-light. They are the model the rest should follow — and the reason Phase 2 is a 3-week job rather than a 3-month one.

The foundation is sound. The problem is a capped worker loop and a UI layer that absorbed the business logic. Both are fixable, and neither requires a rewrite.
