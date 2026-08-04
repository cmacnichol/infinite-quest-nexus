# Task 10 B1 generation boundary completion audit

**Audit date:** 2026-08-04

**Status:** implementation evidence passed; independent Task 10f review pending

**Frozen range:**
`885bcdeaa52a1c1286d044f34275c7cf40159bbb..4e3e701d2b1e1f5b2250c3d89875fd032b505966`

This report audits the complete Task 10a-10e range. It deliberately does not
use `HEAD~1` or the Task 10e base. The frozen base is the parent-side boundary
recorded in the SDD ledger, is an ancestor of the frozen head, and produced a
30-commit, 646,983-byte review package at:

`.superpowers/sdd/SLICE_0_1_IMPLEMENTATION_PLAN/review-885bcde..4e3e701.diff`

Task 10 is not marked complete in the implementation plan yet. The required
independent full-range review must approve this evidence first. Task 11 remains
unauthorized until that review has no blocking finding.

## Audit verdict by requirement

| Requirement | Current evidence | Verdict |
| --- | --- | --- |
| API routes depend on application use cases | `buildServer` receives one `GenerationApplication`; one HTTP adapter serves all seven non-streaming routes and SSE | Pass |
| Worker depends on application use cases | `runWorker` receives one `GenerationWorkerApplication`; it calls only `claimNext` and `executeClaimed` for generation | Pass |
| Application package is implementation-free | package dependency, compiler configuration, AST boundary scanner, focused tests, `pnpm check`, and build all pass | Pass |
| API authority is server-resolved | every generation route validates the path, resolves `initialOwnerId(pool)`, and constructs `OwnerScope` before calling the adapter | Pass |
| Worker authority comes from the durable claim | claim returns `owner_user_id`; payload load and every mutation/commit use that owner plus job and lease owner | Pass |
| Durable generation semantics are preserved | focused PostgreSQL suites cover command transactions, claims, leases, races, state trace, accepted-turn transaction, Chronicle, and independent images | Pass |
| Generation cross-role exception is removed | worker has no generation-service import; scanner rejects it and retains exactly five Task 14 exceptions | Pass |
| Independent final review | must inspect this report and the frozen review package | Pending |

## Public-function disposition

The pre-10a `generation-service.ts` public generation surface was reviewed
directly at the frozen base. Campaign configuration, rewind, and branch remain
in that service for Task 14c and are not part of this move.

| Pre-10a public function | Application port/use case after B1 | Concrete adapter | Production composition owner |
| --- | --- | --- | --- |
| `enqueueGeneration` | `GenerationApplication.enqueueAppend` via `createGenerationApplication` | `GenerationCommandRepository.enqueueAppend` in `createPostgresGenerationCommandRepository`; HTTP name remains `GenerationApplicationAdapter.enqueueGeneration` | `createApiGenerationApplication` constructs repository/application; `buildServer` constructs the HTTP adapter |
| `enqueueLatestReplacement` | `GenerationApplication.enqueueReplacement` | `GenerationCommandRepository.enqueueReplacement`; HTTP name remains `enqueueLatestReplacement` | API generation composition and `buildServer` |
| `getGenerationJob` | `GenerationApplication.getJob` | `GenerationCommandRepository.getJob`; HTTP name remains `getGenerationJob` | API generation composition and `buildServer` |
| `getGenerationResult` | `GenerationApplication.getResult` | `GenerationCommandRepository.getResult`; HTTP name remains `getGenerationResult` | API generation composition and `buildServer` |
| `retryGeneration` | `GenerationApplication.retry` | `GenerationCommandRepository.retry`; HTTP name remains `retryGeneration`; route lifecycle logging remains a transport concern | API generation composition and `buildServer` |
| `cancelGeneration` | `GenerationApplication.cancel` | `GenerationCommandRepository.cancel`; HTTP name remains `cancelGeneration`; route lifecycle logging remains a transport concern | API generation composition and `buildServer` |
| `discardGeneration` | `GenerationApplication.discard` | `GenerationCommandRepository.discard`; HTTP name remains `discardGeneration` | API generation composition and `buildServer` |
| `claimGeneration` | `GenerationWorkerApplication.claimNext` via `createGenerationWorkerApplication` | `GenerationClaimRepository.claimNext` in `createPostgresGenerationExecutionRepository` | `createWorkerGenerationApplication`; injected into `runWorker` by `dispatchRuntimeRole` |
| `executeGenerationJob` | `GenerationWorkerApplication.executeClaimed` | `GenerationExecutor.execute` from `createGenerationExecutor`, backed by the named execution repository | worker generation composition and `dispatchRuntimeRole` |
| `runGenerationJob` | eliminated as a combined claim-and-execute facade; scheduler calls the two worker-application methods | `startNextGeneration` owns claim logging and returns the active execution promise | `runWorker`, with its application built by worker runtime composition |
| `safeTurnInput` | not an application command; retained as shared API/execution input-safety policy | `services/api/src/turn-input-safety.ts`, called by both enqueue routes and executor defense-in-depth | API route composition and generation executor |

The former exported `OrchestrationInputs` type is now the database-adapter-local
`GenerationOrchestrationInputs`; it is not exposed from the application or
contracts public barrels.

## Application dependency proof

`@infinite-quest/application` has one declared dependency:
`@infinite-quest/contracts`. Its TypeScript project uses `lib: ["ES2023"]` and
`types: []`. Current application sources import only the contracts package or
local application modules.

The AST boundary scanner checks normal imports, type imports, re-exports,
dynamic imports, CommonJS `require`, import types, non-literal loaders, and
triple-slash directives. Its negative fixtures reject:

- `services/**` and runtime/worker modules;
- Fastify, `pg`, `pino`, and concrete provider/network libraries;
- `node:*`, timers, worker scheduling, runtime configuration, and secret paths;
- story-engine, database, logger, and deep-relative contract bypasses.

The scanner and compiler therefore prove that SQL, Fastify, provider
implementations, worker scheduling, runtime configuration, credentials, and
service implementations are not reachable from the application package. The
application commands and claims carry scopes and opaque identifiers, never a
database pool, HTTP request, credential, or `AbortSignal`.

## Authority and isolation proof

### API path

Every generation handler parses its campaign/job UUID before any owner read.
The server then resolves the stable initial owner and constructs
`{ ownerUserId }`; the HTTP adapter forwards that explicit owner with campaign
or job scope. Neither the application nor the PostgreSQL command repository
calls `initialOwnerId`. No generation schema contains `userId`/`user_id`, and
headers, body fields, or query fields are not consulted for authority.

The route matrix proves the same server owner reaches all seven non-streaming
operations even when spoofed identity inputs are supplied. Real PostgreSQL
coverage proves a known foreign job UUID returns not found and that none of the
seven repository operations reveals or mutates the foreign record.

### Worker path

`claimNext` reads `owner_user_id` from the selected durable job and returns it
on the minimal `ClaimedGeneration`. The executor creates its lease scope from
that claim. The post-claim payload read requires job ID, claimed owner, lease
owner, and `assessing`; every transition requires the durable owner and worker
lease. Accepted-turn commit continues to scope campaign, world-version, turn,
state, memory, cost, and derived-job work with `job.owner_user_id`.

Tests cover a foreign claimed owner, cancellation between claim and payload
load, expired-lease reclaim, stale attempt recording after cancel/reclaim, lost
lease, and no provider work after a failed guard. There is no initial-owner
lookup or caller-supplied identity in claim/execution code.

## Pre/post behavior comparison

### HTTP payloads and errors

There is no frozen-range diff in either
`packages/contracts/src/generation.ts` or
`packages/contracts/src/client-api.ts`. Routes still parse and project through
the same generation request, retry-latest, enqueue, job snapshot, action, and
result schemas. Duplicate enqueue remains 200, new enqueue/retry/cancel remains
202, and result/query payloads retain their prior projections. The adapter's
16 reason-level mappings retain the established status, safe message, and
details variants; arbitrary errors preserve identity for the Fastify handler.

One intentional validation-order correction landed in `0b58a3d`: malformed
path UUIDs are rejected before input-safety or owner lookup. That restores the
pre-cutover public precedence and is covered by no-owner-read regressions.

### SSE frames

The route still sends `data: ${JSON.stringify(snapshot)}\n\n`, polls at 350 ms,
deduplicates identical JSON, terminates on the same five durable statuses, and
closes without fabricating a failed frame when a later read errors. The stream
projection schema is unchanged, so raw provider errors, `partialOutput`, and
lease timestamps remain absent while replacement provenance and attempt count
remain present. Only the read implementation changed from the generation
service function to the injected application adapter.

### Durable job trace and lease behavior

The active success trace remains:

```text
queued -> assessing -> generating -> validating -> committing -> completed
```

Replacement begins at `replacement_queued`; retry returns recoverable/failed
jobs to their established queued state. Claim remains global oldest-first with
`FOR UPDATE SKIP LOCKED`, increments attempts once, reclaims expired active
leases, and atomically assigns `assessing` plus the new lease. Heartbeat timing
is unchanged at:

```text
max(5000, floor(leaseSeconds * 1000 / 3))
```

Every mutation is owner/job/lease/source-state guarded. The correction in
`9eb98bc` makes attempt recording serialize with cancel/reclaim on the same job
row; it closes a stale-worker race without changing an admitted attempt's
public state-machine behavior.

### Transactions and accepted-turn integrity

No migration changed in the frozen range. Command/query transaction ownership
is preserved and now asserted exactly:

- `getJob` and `getResult`: no explicit transaction;
- append/replacement: one outer transaction plus their named insert savepoint;
- cancel: one outer transaction;
- retry/discard: one guarded statement and no outer transaction.

Accepted narration is still committed in one transaction containing campaign
and replacement locks, turn append/swap, campaign state, authoritative and
derived Chronicle writes, cost/result linkage, derived work, and the terminal
`completed` update. Optional accepted-turn illustration enqueue remains behind
a savepoint inside that transaction; its failure cannot roll back narration.
Cancelled, rejected, malformed, timed-out, incomplete, or lost-lease output
does not mutate accepted turns, campaign state, or Chronicle memory.

### Prompt protocol and provider independence

Prompt snapshot resolution and `promptProtocolVersion` remain runtime-bound
collaborators. The durable job snapshot/version comparison, response-chain
scope, mechanics/fiction separation, retry metadata, cost attribution, output
validation, and fiction-only illustration prompt all remain in the extracted
executor. The application package receives none of those implementations.

PostgreSQL integrations prove story generation continues when a separate
embedding provider is unavailable, and that image-provider failure leaves the
accepted story completed. Active image tests prove the provider receives only
the fiction prompt and never the accepted turn's private scratchpad/mechanics.

### Structured logs

The established generation lifecycle events and their correlation fields are
preserved, including claim, start, provider start/complete/fail, validation,
recovery, recoverable/fail/cancel/requeue, stream progress/persist warning,
scene coverage, illustration enqueue warning, and completion. Claim logging is
shared by production worker scheduling and the integration harness through
`startNextGeneration`, retaining job, campaign, provider, expected turn,
operation, attempt, worker, and lease fields.

`worker_generation_error` is the only intentional scheduler-level addition. It
records an unexpected rejected execution promise with worker and job IDs, then
keeps the scheduler available for later durable work. It contains no provider
response, prompt, narration, secret, or private state.

### Runtime roles and shutdown

The runtime role matrix is explicit and unit-tested: `api` builds only the API
generation graph, `worker` only the worker graph, `all` builds each once over
the shared pool, and `migrate` builds neither. Provider transport lifecycle and
pool cleanup order are unchanged.

The worker retains one active generation slot and continues optional lanes in
their established priority order while generation runs. Scheduler abort stops
new claims but is not passed to the story executor; an already claimed job
drains before `runWorker` resolves. Durable user cancellation still fences
execution through the job state and lease. No new closeable runtime resource
was introduced.

## Remaining transitional bindings

### Exactly five cross-role exceptions

The generation exception is gone. These are the complete remaining
`CROSS_ROLE_IMPORT_ALLOWLIST` entries, all owned by Task 14:

1. `services/worker/src/worker.ts -> services/api/src/asset-service.js`
2. `services/worker/src/worker.ts -> services/api/src/illustration-resolution-service.js`
3. `services/worker/src/worker.ts -> services/api/src/image-service.js`
4. `services/worker/src/worker.ts -> services/api/src/memory-service.js`
5. `services/worker/src/worker.ts -> services/api/src/segmented-illustration-service.js`

### Named `GenerationExecutionCollaborators`

These 18 temporary runtime bindings are explicit rather than anonymous:

- Task 14a illustration removal owner: `loadStreamingIllustrationConfig`,
  `createProvisionalSet`, `createProvisionalSegment`,
  `promoteProvisionalSet`, `orphanProvisionalSet`, and
  `enqueueAcceptedTurnIllustrationSegments`.
- Task 14b memory removal owner:
  `autoEnableCampaignEmbeddingIfAvailable`, `buildContextPreview`,
  `enqueueEmbeddingReindex`, `rebuildCampaignMemories`, and
  `storeDerivedTurnMemories`.
- Task 14d provider/prompt/cost removal owner: `loadTextProvider`,
  `resolvePromptSnapshot`, `promptFromSnapshot`, `promptProtocolVersion`,
  `recordProfileCost`, `turnReportedCosts`, and
  `attributeGenerationCostsToTurn`.

B1 removes the generation API/worker exception; it does not claim B5 or drive
either inventory to zero.

## Commit and correction record

The full 30-commit list is reproducible with:

```sh
git log --reverse --format='%H %s' \
  885bcdeaa52a1c1286d044f34275c7cf40159bbb..4e3e701d2b1e1f5b2250c3d89875fd032b505966
```

The implementation/correction chain is:

- 10a: `390d7c2d27e9843475aaf48c5bf0561a4cd71a6b`, corrected by
  `bdeca6670b33bc6daaee10e63206182ceff667a7`,
  `3bf04e17ceefbeee12b5d5015c82f8082502aadd`, and
  `5289bf3f99e9cda273d1c807793efb4ee4607c1f`.
- 10b: `93113bcebb67da77ce1284e5bfabb3ab7ddac1c7` and
  `3ee033d8d3924f6e212483fb3ac3003488f2cee6`, with parity/test corrections
  `7933c3af9138bf0c5ae8a063fbe069f47e1af1f7`,
  `2e6901e89c53cb606cc9d9acec47ff6fcbb7e4f8`,
  `bb29eeb8298b314e8f8d8f4a33ea9a288a190545`,
  `d778043646f76fd3af2b3bb073054300e4ca4cd4`, and
  `29f0376a7eda89d9d9a280b197f0ae2cbce17b98`.
- 10c: composition `c23be50c2864f795b370da20c05c3590fda4d0cf`, adapter
  `bc742c6c969c2a64d85e09970ce0445c34ca26b7`, cutover
  `15993f2446914db31f81be937a7f6738824559c2`, and validation-order
  correction `0b58a3d5159ba11121b246345e955ad021c1c956`.
- 10d: `618457fade27ad085eed38a8503a1289cec07ef4`, corrected by
  `9eb98bc7ec7d788560ce68f99ce70bfe61d66ddb`.
- 10e: `4e3e701d2b1e1f5b2250c3d89875fd032b505966`.

Checkpoint reviews for 10a, 10b, 10c1, 10c2, 10c3, 10d, and 10e are recorded
as approved in the SDD ledger after their correction rounds. The Task 10f
independent full-range reviewer result is intentionally pending in this draft.

## Fresh verification

Environment:

- Node `v24.18.0`
- pnpm `11.18.0`
- PostgreSQL `18.4 (Debian 18.4-1.pgdg13+1)` in the
  `infinitequest-integration-postgres` container
- Vitest `4.1.10`

Commands executed on 2026-08-04:

| Command | Result |
| --- | --- |
| focused six-file Task 10 unit command | 6 files, 91 passed, 0 failed, 0 skipped |
| focused five-file Task 10 PostgreSQL integration command | 5 files, 96 passed, 0 failed, 0 skipped |
| `pnpm check` | passed; repository boundary/data checks inspected 577 candidate files; all package, web, root TypeScript, and JavaScript checks passed |
| `pnpm build` | passed; TypeScript and both Vite builds passed; legacy bundle 245.83 kB (67.60 kB gzip), next entry 1.12 kB (0.59 kB gzip) |
| `pnpm test:unit` | 93 files, 1,114 passed, 0 failed, 0 skipped |
| `pnpm test:integration` | 19 files, 222 passed, 0 failed, 0 skipped |
| `git diff --check` | passed |
| per-file `pjm precheck` | passed before every Task 10f document edit |

Focused commands:

```sh
pnpm vitest run \
  tests/unit/application/generation-use-cases.test.ts \
  tests/unit/generation-application-adapter.test.ts \
  tests/unit/generation-executor-adapter.test.ts \
  tests/unit/worker-generation-adapter.test.ts \
  tests/unit/client-boundaries.test.ts \
  tests/unit/runtime-provider-lifecycle.test.ts

pnpm vitest run --config vitest.integration.config.ts \
  tests/integration/generation-repository.integration.test.ts \
  tests/integration/generation-execution-repository.integration.test.ts \
  tests/integration/generation.integration.test.ts \
  tests/integration/gameplay.integration.test.ts \
  tests/integration/image-pipeline.integration.test.ts
```

The full integration run emitted the existing `pg` deprecation warning for a
test path that overlaps `client.query()` calls; it did not fail a test. No live
external text, image, embedding, or Sogni endpoint was contacted: provider
behavior is covered with deterministic compatible test transports. The local
PostgreSQL suites are real, isolated database executions. No Compose/Swarm
deployment or rolling-update rehearsal is claimed by this B1 audit; those
system-level gates remain assigned to the final backend audit in Task 14f.

## Independent-review gate

The fresh reviewer must evaluate the frozen package and this report against:

- ADR 0028 dependency direction;
- generation integrity and accepted-turn atomicity;
- server and durable-job identity authority;
- text/image/embedding provider independence;
- the repository testing matrix and zero newly skipped Task 10 tests.

If that review is clean, the correction checkpoint may mark Tasks 10a-10f and
the Task 10 status row complete, record the reviewer result and Task 10f commit
SHA here, and authorize Task 11. Until then, this report is evidence for review,
not authorization to advance.
