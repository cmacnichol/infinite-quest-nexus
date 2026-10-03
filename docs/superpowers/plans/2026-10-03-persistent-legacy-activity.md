# Persistent Legacy Story Activity Feed Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. The current request is planning only; this document does not authorize product implementation.

**Goal:** Deliver durable campaign activity with a bounded browser cache, useful safe errors, and reliable reload/reconnect behavior in the legacy Story player.

**Architecture:** Capture safe transitions in a transactional outbox, publish immutable history through a serialized worker publisher, and expose owner-scoped cursor reads. A typed controller merges server history and separately labeled browser observations in IndexedDB. Existing generation/recovery APIs remain authoritative.

**Tech Stack:** TypeScript, Zod, PostgreSQL/pg, Fastify, native IndexedDB/BroadcastChannel, existing legacy JavaScript/HTML/CSS, Vitest, Playwright. Use repository-pinned Corepack pnpm 12.4.1 and Node >=22.13.0. No new dependency is required.

**Spec:** [Persistent Legacy Story Activity Feed Design](../specs/2026-10-03-persistent-legacy-activity.md). Read it before execution; its catalogs, contracts, limits and behavior are normative.

## Global Constraints

- Scope is `apps/web` Story UI, not archived root `index.html`, dashboard authoring, or replacement-UI redesign.
- Server identity is the stable internal UUID; browser IDs and imported provenance never authorize reads.
- Activity is operational history, separate from accepted narration, campaign state, Chronicle and portable authority.
- Never persist/export raw action text, narration, mechanics, reasoning, credentials, error bodies or arbitrary exception objects.
- Preserve generation lease guards, transactional acceptance, recovery decisions and independent image failure behavior.
- Capture shares the domain transaction. Publication/cache/display failure cannot change accepted Story outcomes.
- Public event maximum 4 KiB; API default 100/max 200; server retention 30 days; published outbox receipts 7 days; pending/quarantined outbox retained.
- Cache maximum 1,000 server events and 200 observations per campaign; observations 7 days; at most 10 campaign scopes.
- Publication batch 100 every 1 second; cleanup batch 1,000 every 60 seconds; one maintenance lane per worker plus cross-worker database lock.
- Poll 5 seconds open/active, 30 seconds visible-idle, pause hidden/offline; yield incremental catch-up after 10 pages.
- No new SSE service, browser event-write endpoint, destructive feed clear or fabricated historical backfill.
- This planning task does not include implementation, unrelated PR conflict resolution, commits or deployment.

## Review Focus

1. Lower sequence commits late: Task 3 proves serialized publication prevents cursor skips across concurrent connections.
2. Retry resets an image attempt counter: Tasks 2/5 use activity revision, not status/attempt, as identity.
3. User/campaign switches during cache/API work: Tasks 6/7 discard stale responses and clear inaccessible scope.
4. Restore/retention invalidates cursors: Tasks 2/7 reset cache coverage without claiming complete history.
5. Publisher unavailable while Story completes: Tasks 3/8 preserve accepted results and show history delay.

## Baseline and file map

Baseline `30a884a1230b80cf844879c027a380a374b849ac`, branch `codex/legacy-activity-plan`.

Inspected existing boundaries:

- `apps/web/src/story.js`: in-memory activity, message-only errors, generation snapshot/recovery handling, initial image activity suppression.
- `apps/web/public/story.html`, `story.css`: Activity Log dialog and controls.
- `packages/client-core/src/errors.ts`: HTTP/contract error fields.
- `packages/contracts/src/generation-review.ts`: safe failure-code mapper; private phase/attempt data must not be exposed wholesale.
- `packages/database/src/generation-repository.ts`: enqueue/retry/review/cancel/discard; `generation-execution-repository.ts`: claim/phase/failure/commit.
- `services/runtime/src/illustration-image-job-adapter.ts`, `illustration-resolution-job-adapter.ts`; `packages/database/src/illustration-asset-publication-repository.ts`: image/segment transitions.
- `packages/database/src/postgres-generation-events.ts`: live notification wakeups, not durable history.
- `services/worker/src/worker.ts`, `services/runtime/src/runtime-role.ts`: optional lanes and runtime composition.
- `apps/web/src/composition.ts`, `packages/client-web/src/api-client.ts`: injectable typed browser composition.
- `packages/contracts/src/client-api.ts`: strict meta capability object; unknown additions break old clients.
- `packages/application/src/system-archives/portability-registry.ts`: new-table operational classification.
- `tests/unit/story-player-ui.test.ts`: existing activity assertions mostly check source presence.

Proposed new files (these do not exist yet):

| Responsibility | Files |
|---|---|
| Contract/catalog | `packages/contracts/src/activity.ts`; `packages/domain/src/activity.ts` |
| Storage | `database/migrations/0114_campaign_activity.sql`; `packages/database/src/activity-repository.ts` |
| Application ports/use cases | `packages/application/src/activity/types.ts`, `ports.ts`, `use-cases.ts`, `index.ts` |
| API/composition | `services/api/src/activity-routes.ts`; `services/runtime/src/activity-composition.ts` |
| Client model | `packages/client-core/src/activity/types.ts`, `controller.ts`, `projection.ts`, `index.ts` |
| Browser adapters | `packages/client-web/src/activity-api.ts`, `activity-cache.ts`, `activity-sync.ts` |
| Legacy view | `apps/web/src/story-activity.ts` |
| Operations | `docs/runbooks/activity-history.md`; `docs/architecture/persistent-activity-history.md` |

Each package exports new public interfaces through its existing `src/index.ts`. Recheck the next free migration number before implementation; 0114 follows this baseline's 0113, but is not reserved by this document.

## Task 1: Versioned contracts and safe diagnostics

**Files:** Create contract/domain files above and `tests/unit/activity-contracts.test.ts`, `activity-projection.test.ts`; modify package exports.

**Interfaces:** Export `ActivityEvent`, `ActivityEventDraft` (before publication), `BrowserActivityObservation`, `ActivityPage`, `ActivityPageQuery`, `ActivityScope` and strict schemas from the contract. Domain functions: `projectActivityDiagnostic(input: unknown): ActivityDiagnostic | null`, `projectBrowserActivityError(input: unknown): ActivityDiagnostic | null`, `activityPresentation(event: ActivityEvent | BrowserActivityObservation): ActivityPresentation`. Presentation is fixed title/message plus safe labeled fields, never HTML. Define every source-specific status/kind from the spec; no arbitrary payload bag.

- [ ] Write `acceptsSafeProviderFailure`: assert timeout code/message and nullable context; sequence `9007199254740993` stays a string.
- [ ] Write `rejectsPrivatePayloads`: unknown fields fail validation; canaries in details/cause/stack/prompt/action/provider URL never enter projection/export; unknown codes map to fixed generic copy. Assert 4 KiB size and 128/200-character correlation/model bounds.
- [ ] Write `separatesMonitoringFromFailure`: disconnect is a browser warning, not generation failure; review-required offers review guidance, not automatic retry.
- [ ] Run `corepack pnpm exec vitest run tests/unit/activity-contracts.test.ts tests/unit/activity-projection.test.ts`; require red evidence for missing behavior.
- [ ] Implement schemas/catalog and total safe projectors; reuse the existing generation failure mapper/recovery vocabulary. Do not widen raw public generation errors.
- [ ] Rerun focused tests green; check contracts/domain exports through `corepack pnpm check` once wired.
- [ ] Review and commit `feat(activity): define safe event contracts` during authorized execution.

## Task 2: Transactional capture and scoped storage

**Files:** Create migration/activity repository and `tests/integration/activity-repository.integration.test.ts`; modify portability registry; review/update `tests/integration/migrations.integration.test.ts`, `tests/unit/migration-order.test.ts`, `system-archive-portability.test.ts`.

**Interfaces:** `captureActivity(client: DatabaseClient, input: ActivityCapture): Promise<string>` returns stable UUID. `ActivityCapture` holds scope, sourceId, revision as decimal string, ordinal, and validated draft. `createPostgresActivityRepository(pool)` implements `ActivityReadRepository.list(scope, query): Promise<ActivityPage>` and Task 3 maintenance ports. Reads use a read-only repeatable-read transaction.

- [ ] Write `captureRollsBackWithMutation`, `captureReplayReturnsSameId`, `ownerCampaignConstraintRejectsMismatch`, `deletedSourceKeepsHistory`, `deletedCampaignCascadesHistory`. Require real PostgreSQL.
- [ ] Write `pagesHaveStableBoundaries`: 205 events, page 100/max 200, exclusive before/after boundaries, equal timestamps, no duplicates/omissions, bigint cursor safety, foreign-owner/campaign rejection.
- [ ] Run `corepack pnpm exec vitest run --config vitest.integration.config.ts tests/integration/activity-repository.integration.test.ts`; require executed red database cases, not skipped tests.
- [ ] Implement three spec tables, indexes and composite scope constraints; add required parent unique constraint if absent. Add job/segment activity revisions. Classify all three tables as operational exclusions; update actual migration watermark fixtures only.
- [ ] Implement capture/list, strict stored-data projection, query/cursor validation, snapshot-consistent coverage, stale/future-cursor resets. Corrupt data yields a controlled error/incomplete coverage without raw content leakage.
- [ ] Rerun integration plus `corepack pnpm exec vitest run tests/unit/migration-order.test.ts tests/unit/system-archive-portability.test.ts` green.
- [ ] Commit `feat(activity): persist scoped event capture`.

## Task 3: Publication, retention and bounded worker lane

**Files:** Create application activity files/runtime composition and `tests/integration/activity-publication.integration.test.ts`, `tests/unit/activity-worker.test.ts`; extend repository/worker/runtime-role. Review `worker-concurrency.test.ts`, `runtime-role-composition.test.ts`.

**Interfaces:** `ActivityMaintenanceRepository.publishBatch(limit: number): Promise<{published:number; quarantined:number}>`, `pruneBatch(limit: number): Promise<number>`. `createActivityMaintenance(repository)` exposes `tick(): Promise<boolean>` with injected clock/cadence. `createActivityComposition(pool)` returns `{reader, maintenance}`. Add optional worker lane `activityMaintenance(): Promise<boolean>` with capacity 1 in worker/combined roles only.

- [ ] Write two-connection `lateCommitCannotBeSkipped`: pause publisher A after lock; B cannot allocate/commit later cursor; release A and incrementally read both. Also reverse source-transaction commit order.
- [ ] Write `publisherCrashDoesNotLoseOrDuplicate`: abort publication before commit, retry, assert one event UUID and atomic outbox acknowledgment. Test corrupt row quarantine followed by valid row publication.
- [ ] Write `retentionHonorsPublicationDate`, `pendingOutboxNeverExpires`, `receiptExpiresAfterSevenDays`, `emptyHistoryRetainsWatermark`, `staleCursorResets`; test exact 30-day boundary using database time, batches <=1,000.
- [ ] Run new integration with integration config and new worker unit file; require red evidence.
- [ ] Implement advisory try-lock BEFORE sequence allocation, publication batch 100 and quarantine. Emit fixed health/error codes, counts and oldest-pending age; never raw payloads. Expose pending/incomplete coverage.
- [ ] Wire 1-second lane and 60-second cleanup. Isolate exceptions and back off; preserve existing worker fairness, capacities and shutdown behavior. Do not flush unbounded history at shutdown.
- [ ] Rerun focused tests plus worker/runtime-role units green. Assert generation still runs when publication rejects. Check indexed first/incremental-page query plans with representative PostgreSQL data; do not infer performance from unit timing.
- [ ] Commit `feat(activity): publish and retain durable history`.

## Task 4: Capture generation and review transitions

**Files:** Modify `packages/database/src/generation-repository.ts`, `generation-execution-repository.ts`; inspect `services/runtime/src/generation-executor-adapter.ts` callers if safe typed metadata is missing. Create `tests/integration/activity-generation.integration.test.ts`; review generation repository/execution/review integration suites.

**Interfaces:** Use Task 2 capture after successful guarded mutation on the same transaction client. Increment activity revision inside the mutation. Preserve existing signatures where possible; any added optional diagnostic input is typed and tested through actual callers.

- [ ] Write a transition matrix for append/replacement enqueue, idempotent replay, lease claim/reclaim, phases, review required/decision, recoverable/failure, retry, cancel/discard and accepted completion. Assert distinct revisions through retry cycles.
- [ ] Write `staleWorkerCapturesNothing`, `rolledBackCommitCapturesNothing`, `completedEventMatchesAcceptedTurn`, `reviewDecisionNotAcceptance`, `rejectedOutputNeverChangesCanon`; assert private-canary and owner/campaign isolation.
- [ ] Run `corepack pnpm exec vitest run --config vitest.integration.config.ts tests/integration/activity-generation.integration.test.ts`; require red.
- [ ] Convert applicable single-statement transitions to `withTransaction` without weakening guards. Capture mutation and outbox atomically. Cover cancel's image/segment changes too. Do not capture partial narration, lease renewal, or duplicate replay as new transitions.
- [ ] Snapshot safe diagnostics/IDs before source cleanup. Capture accepted completion only inside accepted-turn commit. Preserve historical IDs without cascading source FKs. Do not create fake baseline history for pre-existing jobs.
- [ ] Run new test plus `generation-repository.integration.test.ts`, `generation-execution-repository.integration.test.ts`, `generation-review.integration.test.ts` with integration config. Use deterministic provider review/commit coverage and private-memory/isolation suites when those execution paths change.
- [ ] Commit `feat(activity): record Story generation lifecycle`.

## Task 5: Capture independent illustration outcomes

**Files:** Modify `services/runtime/src/illustration-image-job-adapter.ts`, `illustration-resolution-job-adapter.ts`, `packages/database/src/illustration-asset-publication-repository.ts`. Inspect mutation paths in `services/runtime/src/illustration-worker-state-adapter.ts`, `packages/database/src/illustration-recovery.ts` and generation cancellation. Create `tests/integration/activity-illustration.integration.test.ts`; review `image-pipeline.integration.test.ts`.

**Interfaces:** Same capture/revision contract. Image event `jobId` identifies image job; related generation/segment/turn IDs are present only when proven. A retry's reset attempt counter cannot determine identity.

- [ ] Test queue/generate/provider-pending/download/success, disabled/unavailable endpoint, recoverable/failure/cancel/expiry, explicit retry resetting attempts, segment refinement/fallback/failure and asset publication. Repeated progress/queue-position polls add no durable event.
- [ ] Write `imageFailurePreservesAcceptedStory`, `sourceCleanupPreservesEvent`, `streamingSegmentHasNullableTurnUntilBound`. Assert success at asset publication, not earlier provider completion; older immutable entries do not invent later turn association.
- [ ] Run new integration red. Map all image/segment status-writing paths with `rg` before editing, including paths outside normal worker execution.
- [ ] Implement transaction-bound capture/revision guards consistently. Do not share provider credentials, rerun narration or make image jobs prerequisites for Story acceptance.
- [ ] Run new file and `image-pipeline.integration.test.ts` with integration config green, plus relevant independent-failure generation coverage.
- [ ] Commit `feat(activity): record independent illustration outcomes`.

## Task 6: Read API and typed transport

**Files:** Create `services/api/src/activity-routes.ts`, `packages/client-web/src/activity-api.ts`; wire server/runtime composition and exports. Create `tests/unit/activity-routes.test.ts`, `activity-api.test.ts`, `tests/integration/activity-api.integration.test.ts`; review client API route/contract tests and route inventory helper.

**Interfaces:** `registerActivityRoutes(app, {resolveOwner, activityReader})` follows existing server identity/error conventions. `createActivityApi({http}): ActivityApi` exposes `list(campaignId: string, query: ActivityPageQuery, signal?: AbortSignal): Promise<ActivityPage>`. Use existing typed HTTP transport and validated IDs; no owner argument on the wire.

- [ ] Test initial/before/after reads, 400 malformed/oversized/wrong-direction/wrong-campaign cursor, conflicting cursors, missing/foreign campaign 404, owner spoofing and safe correlation errors. Assert max payload and no private data.
- [ ] Test unsupported route separately from access denial and malformed success. No fallback on 500/schema mismatch; GET never mutates; existing strict meta payload is unchanged.
- [ ] Run new unit files and integration file with integration config red; implement route/service/adapter against Task 2 reader and strict schemas.
- [ ] Rerun focused tests and `tests/unit/client-api-routes.test.ts`, `client-api-contracts.test.ts` green. Update route inventory for exactly the new GET. Abort cannot update a switched-away campaign.
- [ ] Commit `feat(activity): expose paginated campaign history`.

## Task 7: Cache, reconciliation and multi-tab controller

**Files:** Create client-core activity files and browser cache/sync adapters from map; update exports. Create `tests/unit/activity-controller.test.ts`, `activity-cache.test.ts`, `tests/e2e/activity-cache.e2e.test.ts`. Use injected memory fakes for pure tests and real IndexedDB in browser tests; no extra dependency.

**Interfaces:** `ActivityCache.read(scope): Promise<ActivityCacheSnapshot>`, `merge(scope, update: ActivityCacheUpdate): Promise<void>`, `clearScope(scope): Promise<void>`, `setHiddenThrough(scope, watermark: ActivityViewWatermark | null): Promise<void>`. Snapshot includes spec records, coverage, both pagination cursors and hide-watermarks. `createActivityController({api,cache,clock,scheduler,visibility,connectivity,notifyTabs})` exposes asynchronous `open(scope)`, `refresh()`, `loadOlder()`, `recordObservation(observation)`, `hidePrevious()`, `showPrevious()`, and synchronous `subscribe(listener)`, `dispose()`. View state distinguishes cached/syncing/delayed/incomplete/storageUnavailable from actual job status.

- [ ] Test cache/API merge, duplicate IDs, late publication, 205-event paging, 10-page yielding, last-delivered cursor advancement, independent live/older cursors, overlapping requests, owner/campaign switch, disposal, restore high-water reversal and retention reset.
- [ ] Test 1,001 events, 201 observations, 11 scopes, 7-day boundary, corrupt schema, blocked/version-changing IndexedDB, quota denial and failed merge transaction. Cursor must not commit without records; memory fallback remains usable.
- [ ] Run unit files red; implement version-1 IndexedDB stores, atomic merge/prune, owner/API/campaign namespace and scope epochs/abort. Channel messages only invalidate caches, never supply trusted events. Allocate observation sequence via per-scope transactional counter for two-tab safety.
- [ ] Implement exact polling/backoff from spec, one refresh chain per scope, visibility/online/manual/dialog/terminal hooks. History-fetch failures produce one bounded status per episode, not recursive feed events.
- [ ] Implement separate server/browser hide-watermarks. Hide only already observed entries; future and late-published events stay visible. Show previous restores view and may fetch older server history; no server deletion.
- [ ] Run unit files and `corepack pnpm exec playwright test tests/e2e/activity-cache.e2e.test.ts` green. Prove IndexedDB reload, two-tab writes, cross-campaign isolation and storage-denied fallback in a real rendered browser.
- [ ] Commit `feat(activity): cache and reconcile campaign history`.

## Task 8: Legacy UI and diagnostic integration

**Files:** Create `apps/web/src/story-activity.ts`; modify `story.js`, `composition.ts`, `apps/web/public/story.html`, `story.css`. Create `tests/unit/story-activity.test.ts`, `tests/e2e/legacy-activity.e2e.test.ts`; update related `story-player-ui.test.ts`, `story-player-composition.test.ts`.

**Interfaces:** `createStoryActivityView({controller,document,copyText,download,openRecovery})` exposes `open()`, `render(viewState)`, `dispose()`. Use text-safe DOM rendering. Composition gains injectable activity dependencies/IndexedDB/channel hooks; `story.js` orchestrates rather than owning a second log.

- [ ] Test filters, loaded-only search, grouping/attempts, local date/time, unavailable values, expanded/focus/scroll retention, selected-group copy, JSON export, clipboard failure and hide/show. Assert canaries absent in DOM and exports.
- [ ] Inventory every `recordActivity` caller and toast-only recovery catch; map to spec observation catalog. Remove duplicate synthetic server lifecycle events where durable history is available. Older-server snapshot observations are labeled `This browser`, deduplicated locally, and never presented as durable history. Pre-session errors remain memory-only.
- [ ] Run units red; wire current verified owner/campaign before cache display. Normalize safe diagnostics instead of storing `error.message`. Discard stale async completion using scope epoch. A monitoring disconnection cannot override authoritative success.
- [ ] Replace memory-only copy, add filters/search/load-older/status, Copy/Download and Hide/Show controls. Link to current recovery panel and re-read server state before actions; activity never auto-submits retry.
- [ ] Add browser scenarios: specific terminal failure, review checkpoint, completed-result unavailable, monitor disconnect with server success, image failure after accepted story, background completion, reload, two tabs, campaign switch during delayed request, unsupported API, storage denial and stale cursor. Mocked browser history alone does not prove server capture; Task 9 supplies database evidence.
- [ ] Run `corepack pnpm exec vitest run tests/unit/story-activity.test.ts tests/unit/story-player-ui.test.ts tests/unit/story-player-composition.test.ts` and `corepack pnpm exec playwright test tests/e2e/legacy-activity.e2e.test.ts tests/e2e/activity-cache.e2e.test.ts` green.
- [ ] Capture desktop and 390x844 screenshots for error details, cache/reconnect and independent image failure under `docs/review/assets/legacy-activity/`. Verify keyboard focus/dismissal, scroll, polite announcements and no console errors. Smoke both Story route surfaces for coexistence without redesigning replacement UI.
- [ ] Commit `feat(activity): present persistent legacy Story diagnostics`.

## Task 9: Composed acceptance, operations and rollout

**Files:** Create `tests/integration/activity-workflow.integration.test.ts`, runbook and ADR from map; modify `docs/runbooks/deployment.md`, `docs/workflows/testing.md`. Update archive exclusion assertions and screenshot assets.

**Interfaces:** No new runtime contract; prove Tasks 1-8 compose and document their limits.

- [ ] Add real PostgreSQL/deterministic-provider workflow: API enqueue, browser closed, generate/fail/review/retry/accept, publish, restart publisher and reopen history. Verify ordered unique events and accepted state. Cover replacement, canaries, images, ownership, source cleanup and campaign/user deletion.
- [ ] Inject publisher outage while Story completes: outbox survives/catches up. Inject capture transaction failure: no partial domain mutation and existing idempotency retry remains safe. Verify mixed old/new API/client compatibility without strict meta additions; document coverage gaps from old producers.
- [ ] Verify System/Campaign Archives exclude all activity tables; imported campaigns start empty. Same-origin database rollback must reset future cursors. Do not rewrite identity/bootstrap behavior.
- [ ] Run `corepack pnpm exec vitest run --config vitest.integration.config.ts tests/integration/activity-workflow.integration.test.ts` and each new integration file individually or via the full isolated runner. Confirm nonzero executed database cases and no silent skips.
- [ ] Document coverage start, 30-day history, worker/index expectations, pending-age/count/fixed-code diagnostics, quarantine investigation, cache notices, no historical backfill, rollout and additive rollback. Link runbook from deployment/testing docs and record architecture/operational portability decisions.
- [ ] If needed, install dependencies in the implementation checkout with `corepack pnpm install --frozen-lockfile`. Run `corepack pnpm test:unit --exclude '**/.worktrees/**' --exclude '**/.codex/**'`, `corepack pnpm test:integration`, `corepack pnpm check`, `corepack pnpm build`, Task 8 Playwright checks and `git diff --check`.
- [ ] Review complete diff; report passed/failed/skipped counts and reasons separately for unit, PostgreSQL, browser and live-provider checks. Live providers are not required for activity semantics; if not exercised, mark skipped. No deployment claim without separate evidence.
- [ ] Commit `docs(activity): document retention and rollout verification`; split composed tests/docs if review size warrants.

## Dependencies, tradeoffs and execution

Default order: Tasks 1 -> 2 -> 3 -> 4 -> 5 -> 6 -> 7 -> 8 -> 9. API work can begin after Task 2 and browser controller work after Tasks 1/6, but sequential work reduces shared-contract drift. Each task owns a red/green cycle and reviewable commit. Intermediate commits are not production-ready durable history.

At execution start inspect current instructions/branch state, update migration number if needed, install pinned dependencies and establish relevant baseline checks. Distinguish pre-existing failures. Do not silently resolve unrelated PR conflicts as part of this feature.

Transactional capture adds a bounded write per meaningful transition. This is intentional; measure its database overhead with representative load. Serialized publication makes cursor ordering reliable and establishes a throughput bound; batch 100 is a design default, not a measured capacity claim. Do not add topology without measurements.

Browser errors survive reload only in that browser within retention. Cross-device client-error telemetry is a separate design; no upload is included. Cold offline reload requires server identity validation before revealing a cache; a previously verified open page can display cached events during an outage.

Deployment sequence: additive migration, compatible API/workers, then client; history completeness begins only when all producers are upgraded. Existing APIs/meta are unchanged, and unsupported activity GET uses explicit local-only fallback. Rollback retains additive tables/rows, stops new capture where old producers run, and makes no destructive down migration. Production deployment is outside this request.

## Requirement-to-task coverage

| Requirement | Owning tasks |
|---|---|
| Strict safe fields, diagnostic catalog, no raw content | 1, 4, 5, 6, 8 |
| Capture atomicity, revision identity, scope constraints | 2, 4, 5 |
| Ordered durable cursors, restart, quarantine | 2, 3, 6, 9 |
| Background work while browser closed | 3, 4, 5, 9 |
| Reload, two tabs, scope switch, cache limits | 7, 8 |
| Retention/restore reset, honest coverage | 2, 3, 7, 8, 9 |
| Filters, copy/export, reversible hide, accessibility | 8 |
| Image independence and accepted-state integrity | 4, 5, 9 |
| Mixed versions, portable exclusions, rollout/rollback | 2, 6, 9 |
| Application tests and rendered screenshots | 1-9, particularly 8/9 |

## Planning verification and handoff

This deliverable contains only two Markdown documents. No product implementation, dependency installation, migration, application test or deployment was performed for planning. Validate links, existing-file references, changed-file scope and whitespace before delivery. Proposed files are explicitly marked in this plan.

Self-review:

- [x] Spec requirements map to tasks and concrete tests, including coverage start, quarantine, fallback and exports.
- [x] Interfaces/types agree across tasks; no public owner selector or arbitrary error bag appears.
- [x] Late commits, retry reset, scope switch, restore/retention reset and publisher failure have owning tests.
- [x] No extra dependency/service, archived-client edits or replacement-UI redesign is included.
- [x] Local links and existing-file references resolve; only plan/spec files changed.

After plan review, select an execution method before product changes. Task-by-task implementation with independent reviews is recommended because transaction boundaries, cursor ordering and safe-data contracts cross packages. A single implementing agent can follow the same sequence if preferred. The user has requested a plan and worktree, not execution.
