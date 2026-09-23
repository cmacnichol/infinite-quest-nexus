# Campaign cast phase 04 progress

Updated 2026-09-23 on `codex/campaign-cast`, after phase 03 commit `da74d713`. Phase 04 is **in progress**, not released. The active goal still includes phases 04–06. Legacy `/story` remains the requested UI surface.

## Latest checkpoint: shared text provider capacity

When discovery is enabled, API and worker provider graphs now share PostgreSQL leases through migration `0109_text_provider_capacity`. `TEXT_PROVIDER_CONCURRENCY` defaults to two; every participating replica must use the same gate and limit. The guard acquires capacity before prepared physical-attempt reservation, shares that permit across sequential fallbacks, and prevents parallel nested dispatch from bypassing the limit. Ordinary text/intent calls use the same guard. Images and embeddings remain independent. Queue waiting consumes the request deadline, caller cancellation reaches transport, and no database connection is retained while a permit is used. Expiry recovers abandoned leases; it cannot guarantee cancellation of remote processing after process loss.

Independent review found that a failed lease-release query could replace successful paid output. A RED/GREEN regression reproduced the issue; cleanup now logs a sanitized event and preserves either valid output or the original provider error. The reviewer verified the correction and independently passed 13 affected unit tests.

Verification: **4,393 unit tests passed across 349 files, with 44 existing skips**. The ten-file PostgreSQL run passed 163 tests, skipped ten Windows secure-filesystem cases, and failed one migration-order test. That complete migration suite then passed all 28 tests in isolation; the initial failure remains recorded in the log. The new two-pool capacity tests passed, proving the shared limit, connection release, expiry recovery, and token-specific cleanup. Repository/TypeScript checks and whitespace checks passed. Logs: `.tmp/campaign-cast/capacity-{wiring-red,unit-final,check-final,integration,migrations-rerun}.log`. No visible UI changed, so browser verification was not repeated. No live provider, deployment, or production data changed.

The final phase-04 acceptance audit remains before phases 05–06. Discovery remains default off. Earlier checkpoints below describe their state at the time.

## Retry API and legacy recovery control

`POST /api/v1/campaigns/:campaignId/cast/discovery/:jobId/retry` now accepts the cast revision, current boundary, and idempotency key. The application validates the request and the runtime uses the guarded persistence operation. Existing frozen admissions are reused. An admission-unavailable job first passes a rolled-back validation transaction, then prepares the campaign's selected/default text provider outside the transaction and rechecks all guards before queuing. Provider preparation failures return a sanitized recovery error and retain the failed job. API and combined runtime roles receive these collaborators explicitly.

Legacy Characters now exposes **Retry character tracking** for eligible failed jobs. It retains the request key after uncertain/recovery failures, requires refresh after a conflict, disables writes during generation or capability loss, and never posts to story generation. Oversized sources show a history-scan explanation instead of an ineffective automatic retry. The button refreshes tracking status after acceptance; no automatic retry loop is introduced.

Verification: initial API and browser regressions failed before wiring. **4,384 unit tests passed (348 files; 44 existing skips), 79 PostgreSQL tests passed (five cast suites), and 10 legacy browser tests passed**. The PostgreSQL test uses a single-connection pool to prove provider preparation does not retain a transaction connection; provider failure and source races leave retry generation zero. Repository/TypeScript and whitespace checks passed after correcting an exact-optional-property composition error. Review found no actionable issue. Browser plugin was unavailable, so repository Playwright was used. Screenshots `.tmp/campaign-cast/retry-screenshots/retry-{recovery-390,conflict-desktop}.png` were inspected with no clipped controls. Logs: `.tmp/campaign-cast/retry-{api-red,api-green,api-integration,api-unit,api-check,browser-red,browser-green}.log`. No live provider, production data, or deployment changed.

At this checkpoint shared provider concurrency and the final phase-04 acceptance audit remained before phases 05–06.

## Explicit retry persistence

Migration `0108_campaign_cast_discovery_retry` adds a retry generation and scoped idempotency receipts. The internal `retryFailed` operation locks campaign then job, validates current source, expected cast/boundary, capability, and active-generation exclusion, and atomically queues one retry. Concurrent repeated clicks return the same generation. Completed chunks, receipts, parsed checkpoints, and prior physical accounting remain intact. Retries without a parsed checkpoint recapture current identities. A replacement frozen admission can be supplied by a runtime caller only after preparation outside the transaction; admission-unavailable jobs otherwise reject retry.

Physical reservations and dispatch counts now distinguish explicit retry generations while preserving the legacy generation-zero reservation key. Each new user-authorized generation allows two dispatches per chunk; old leases cannot use it. Operational retry receipts are excluded from portable archives. Down migration refuses to remove nonzero generations while retry jobs remain; operator rollback should disable discovery and retain accounting.

Verification: the initial explicit-retry regression failed before implementation. **4,382 unit tests passed (348 files; 44 existing skips)** and **159 PostgreSQL tests passed (nine files; 10 Windows secure-filesystem skips)**, covering cast, migrations, generation acceptance, adapter matrix, and System Archives. The tests include concurrent idempotency, fresh two-call limits with retained prior rows, checkpoint recovery without payment, stale/foreign/disabled/generation guards, prepared admission, and guarded down migration. Bounded review found no actionable issue. Logs: `.tmp/campaign-cast/retry-{red,green,integration,unit,check}.log`.

This is persistence groundwork, not a released Retry control. API/application orchestration, runtime admission recovery, distinct disabled/recovery diagnostics, and the legacy button still need wiring and browser verification. No live-provider, production-data, or deployment change occurred.

## Branch and transfer enrollment

Branches and world transfers of an enrolled campaign now inherit forward enrollment at `throughTurn + 1`. Copied character authority does not establish extraction coverage for earlier history. Discovery jobs, failures, leases, and pending proposals stay in the source campaign; a newly accepted destination turn uses its own normal admission. Unenrolled sources remain unenrolled until their first eligible accepted turn. This introduces no provider call or historical scan during copying and works within the existing branch/transfer transaction.

Verification: both production-path enrollment regressions failed before implementation and passed afterward. **73 PostgreSQL tests passed** across all five cast suites; the strengthened source-job isolation assertions then passed in the **9-test lifecycle suite**. Repository/TypeScript and whitespace checks passed. Bounded review found no actionable issue. Logs: `.tmp/campaign-cast/copy-enrollment-{red,green,lifecycle,check}.log`. No UI code changed, so no browser run was made for this backend checkpoint; no live-provider or production-data changes occurred.

## Pinned world identities and bounded hints

Captured world identities now include playable characters and explicit character/person/NPC entities (including legacy entity maps). Only allowlisted fiction fields supply identity hints; mechanics, credentials, extension fields, and oversized hint values are excluded. New occurrences retain the pinned world-version and source character ID. Conflicting declarations with the same ID remain visible to validation and require review, including when their names differ.

Provider input selects source-mentioned names/aliases plus the protagonist, with at most 24 identities and 2,000 estimated tokens for the identity section. Each entry carries at most four aliases and four short complete hints; it does not truncate a biography into apparent evidence. The full captured roster remains available for conservative collision validation, so omitted prompt entries do not authorize automatic duplicates. Source narration remains complete and the existing final request-budget check still applies.

RED/GREEN tests reproduced missing playable identities and unbounded input. Integration then exposed the entity-only origin persistence guard; it now accepts pinned playable origins. Review reproduced duplicate-ID conflation and unsafe identity aliases, both corrected with failing regressions. The reviewer independently passed 23 focused unit tests. Final verification: **4,381 unit tests passed (348 files; 44 existing skips), 71 PostgreSQL tests passed (all five cast suites), repository/TypeScript and whitespace checks passed**. The initial full-unit run hit the known nested pnpm-version mismatch; the Corepack wrapper on PATH fixed the harness and the full rerun passed. Logs: `.tmp/campaign-cast/identity-{all-unit,pg-green,check}.log`, with initial failures in `identity-{unit-red,pg-red,review-red}.log`. No UI surface or production data changed, and no live provider was called.

## Physical dispatch budget

Discovery now permits at most two physical provider dispatches per job/source chunk, shared across fallback candidates and reclaimed logical attempts. The existing job lock serializes reservation and dispatch checks. Unsent reservations do not consume this budget; dispatched calls with unknown outcomes do. Publication of an obtained checkpoint remains recoverable without another paid call, and the next chunk has an independent allowance. Other prepared execution kinds retain their existing behavior.

Verification: the original concurrent regression failed with three dispatches before the limit and passed afterward. All **35 discovery PostgreSQL tests**, **75 other provider/accounting PostgreSQL tests**, and **28 route executor unit tests** passed; the other integration suites retained **14 platform-gated skips**. Repository/TypeScript checks passed. A bounded independent review found no actionable issue. Logs: `.tmp/campaign-cast/dispatch-{green,accounting,unit,check}.log`. An initial unit command named a nonexistent config and failed at startup; the corrected default-config run passed. No browser surface changed, and no live-provider or production verification occurred.

Shared provider concurrency remains an open release gate: current lane limits do not coordinate API, worker, and replicas. Explicit Retry also remains pending and must define a durable authorized budget generation rather than silently resetting paid-call accounting. Budget exhaustion currently uses the existing sanitized provider-failure path; no dedicated user diagnostic is exposed yet.

## Reviewed identity resolution

The owner-scoped candidate API now lists pending source-current proposals with bounded pagination and accepts revision-checked attach/create decisions. Resolution locks the campaign before the candidate, rejects stale source/timeline and active generation, preserves manual names/aliases/overrides, applies only evidence that passes existing quote/attribution/fiction guards, and stores an idempotent resolution receipt in the same transaction as authority. Explicit identity decisions bypass automatic identity corroboration only; they cannot authorize invented or unsupported profile facts. Manual resolution uses the editing gate and remains available with discovery disabled.

A durable `mention` command records source-backed identity decisions even when no profile facts change. It updates last-seen/revision without editing profile values, supports protagonist evidence, appears in character source history, survives branch/rewind/import mapping, and invalidates with its narration. Automatic publication also records confirmed mentions with no observations. Missing-turn mention evidence exports explicitly invalidated, preserving historical decisions without requiring deleted source IDs during import. Operational candidate receipts remain excluded from archives; applied mentions are portable cast events.

The legacy Characters panel provides Review character matches, source quotes and turn links, bounded existing-character search, profile previews, and explicit attach or separate-character creation. Identical labels receive a stable ID fallback. Unsaved editor flows remain unchanged; candidate resolution uses its own replay key and shows stale-write failures with Reload matches. Candidate reason codes remain operational rather than prose inserted into Story.

RED/GREEN evidence covered explicit identity validation, durable mention portability, attach/create resolution, HTTP owner binding, no-profile-change last-seen updates, missing-turn import recovery, and ambiguous same-name browser selectors. Final verification: **4,375 unit tests passed (347 files; 44 existing skips), 117 PostgreSQL tests passed (6 files; 4 secure-filesystem platform-gated skips), and 8 legacy browser tests passed**. Repository/type checks and diff checks passed. Independent review identified the missing-turn archive edge case and ambiguous target labels; both received failing regressions before their fixes, and final review found no remaining actionable issue. The reviewer did not independently rerun PostgreSQL/browser checks.

Screenshots inspected: `.tmp/campaign-cast/candidate-screenshots/review-create.png` (desktop) and `review-attach.png` (390px). Controls fit both viewports. Logs: `.tmp/campaign-cast/candidates-{unit,integration,browser,check}.log`; RED browser logs are `candidates-browser-red.log` and `candidates-target-red.log`. Browser plugin was unavailable; repository Playwright ran the rendered tests. No live provider, production-data mutation, or deployment occurred. Discovery Retry, provider-wide capacity, aggregate physical-attempt limits, bounded world/playable identities, and branch/transfer enrollment remain release gates; phases 05–06 remain pending.

## Forward coverage and legacy status

Migration `0107_campaign_cast_coverage` persists forward enrollment at the first eligible accepted source and backfills existing active discovery jobs. Enrollment clears when rewind removes its entire range. The scoped, single-statement status read checks current effective narration and timeline, stops coverage at missing/failed revisions, and counts pending identity reviews separately. Correcting a completed turn withdraws its coverage until its new source completes. Coverage is operational and excluded from portable archives.

The application, GET `/cast/discovery` route, and validated browser adapter expose capability, enrollment, contiguous watermark, first gap, and unresolved count. Legacy `/story` Characters displays that status and refreshes it with the roster. A status outage does not prevent reading or editing saved characters. The old constant-zero/off fields were removed from the cast snapshot contract so they cannot contradict the dedicated status read. Candidate resolution and retry controls are still pending.

Verification: **4,374 unit tests passed (347 files; 44 existing skips); 145 PostgreSQL tests passed (9 files; 10 secure-filesystem platform-gated skips on Windows); 5 legacy Playwright tests passed**. Repository/type checks and diff whitespace checks passed. PostgreSQL selection covered all cast integration suites plus migration, generation events, adapter matrix, and System Archive suites. The additive upgrade test exercised existing-job enrollment, and archive checks verify exhaustive source-column classification. Browser checks covered 1440px and 390px viewports, refresh from pending to complete, unavailable status with an accessible roster, and existing editing/conflict flows. Screenshots were inspected at `.tmp/campaign-cast/coverage-screenshots/tracking-{1440,390}.png`; no clipped controls were found. Browser plugin was unavailable, so repository Playwright was used. No live provider or production/deployment change occurred.

The initial coverage/API/UI tests failed before their implementations. Review also identified roster/status query coupling; its regression failed before the isolation fix and passed afterward. The reviewer independently reran the seven application/API/panel tests. Initial archive verification caught the omitted enrollment-column classification; it was corrected and the full affected PostgreSQL selection passed. Final logs: `.tmp/campaign-cast/coverage-{unit,integration,browser,check}.log`.

## Discovery history reconciliation

The existing correction, rewind, and accepted-turn replacement transaction now reconciles already-enrolled discovery jobs after rebuilding cast authority. Changed/discarded sources are cancelled along with pending identity candidates; changed retained narration receives a fresh source using the saved admission. Unchanged sources retain their job ID, published chunk receipts, checkpoint, attempts, and failures while advancing to the current timeline. All active leases are revoked, preventing an older worker from publishing or checkpointing against the changed history. Repeated lifecycle notification remains idempotent. This does not enroll branch/transfer destinations or report contiguous coverage yet.

RED: the new regressions reproduced missing lease revocation and missing corrected-source requeue (2 failures, 21 existing discovery tests passed). GREEN: 68 PostgreSQL tests across discovery, cast lifecycle, and generation acceptance passed. Another 121 focused unit tests across discovery, projection, and generation execution passed. Repository/TypeScript checks and `git diff --check` passed. Independent bounded review found no actionable issues; the reviewer did not independently rerun tests. No rendered UI changed, so browser checks were not run for this checkpoint. No live provider, deployment, or production-data verification was performed. Evidence logs: `.tmp/campaign-cast/lifecycle-{red,green,unit,check}.log` in the worktree.

## Evidence and provider-contract checkpoint

The discovery contract bounds candidates, observations, quotes, IDs, and allowed fields. Source preparation preserves accepted narration, assigns stable paragraph/subparagraph IDs, and reports source overflow rather than returning a partial completed source. Duplicate paragraph IDs and provider-local keys fail validation.

The domain validator rejects unknown character IDs and fabricated quotations. Ambiguous identities, unsupported fields, instructions, prospective identities, and uncertain subject attribution remain unresolved. It requires corroboration beyond a shared name; alias linkage, corroborating traits, and claims must describe the relevant subject or speaker. World identity hints can preserve world provenance. Consequential unnamed labels remain sparse records with no invented aliases. These conservative English lexical guards establish provenance and reject tested misattributions; they are not proof of arbitrary narrative meaning or a live-model quality evaluation.

`buildCastDiscoveryInput` explicitly projects source fiction and identity hints. It excludes owner/campaign IDs, source hashes, operational state, and raw generation context. The frozen discovery system prompt is separate from historical Story prompt snapshots and requires extractive, sparse, source-linked output.

`cast_discovery` has a distinct strict provider schema and nonstream invocation in the existing v2 contract registry. Story schemas and historical snapshot keys are unchanged. The structured-output qualification probe now includes a synthetic discovery fixture: 18 requests total, with a recomputed example ceiling and updated runbook. No live probe was executed.

## Verification

- RED/GREEN regressions cover fabricated evidence, unrelated character traits, clipped dialogue/intention/negation, unsupported aliases, ambiguous active-verb alias constructions, wrong speakers, duplicate references, and name-only matching.
- Focused discovery/contract/probe selection: **50 tests passed**.
- Full unit suite: **345 files passed; 4,351 tests passed; 44 existing skips**.
- `corepack pnpm check` passed, including repository boundaries, data safety, clients, and TypeScript. The unit suite also built both web surfaces through its build-contract test.
- First full run exposed missing probe coverage and the known nested pnpm shim mismatch. Probe coverage was fixed; the final run used `.tmp/campaign-cast/bin` on PATH to keep nested pnpm commands on Corepack's pinned version.
- Independent review produced concrete identity/attribution counterexamples; regressions reproduced them and fixes passed. The last reviewed issue, active `Mara called Iven` being mistaken for an alias, is now held for review.
- No PostgreSQL, browser, or live-provider verification applies to this unwired pure-contract checkpoint. Database jobs and runtime publication are not implemented yet. No deployment or production data changes occurred.

## Remaining implementation

1. Retry persistence, admission recovery, API, and legacy controls are implemented above. Candidate listing/resolution, forward enrollment, contiguous coverage, and runtime capability status are implemented. Use the next ordered migration after 0108 for further additive schema changes.
2. Frozen preparation, provider composition, and the worker lane are wired below. Implement shared provider concurrency; the two-dispatch ceiling across preset fallback and logical retries is verified.
3. Pinned-world playable-character selection and bounded identity hints are implemented above. Atomic accepted-turn enqueue, forward enrollment, and contiguous coverage are also implemented.
4. Same-campaign lifecycle reconciliation and branch/transfer forward enrollment are implemented. Copied authority does not claim historical extraction coverage.
5. Complete the phase-04 requirement-by-requirement PostgreSQL and browser acceptance audit. Retry, status, and candidate-resolution flows have passed the scoped checks above.
6. Phase 05 bounded generation-context integration and phase 06 explicit history scanning, as separate plan slices.

Do not mark phase 04 complete or claim pin/ignore already affects generation. Existing plans remain authoritative; this checkpoint only completes an initial part of task 1 and registers the future provider operation.

## Durable queue checkpoint

Migration `0104_campaign_cast_discovery.sql` adds scoped jobs and chunk receipts, classified as operational. Applied identity authority remains in cast events. Source identity includes timeline revision because accepted-turn replacement can reuse a narration correction ordinal. Job/chunk receipts make replay idempotent on that source identity. Down migration removes the new operational tables; ordinary rollback should disable discovery and retain recovery records.

`enqueueCastDiscoveryWithClient` uses the caller's transaction and freezes a validated execution plan, complete source, and all chunks. It does nothing while disabled. This seam is **not yet called by generation acceptance**. It performs no provider calls. The current execution snapshot contains provider profile ID and text plan; frozen response-contract/route-basis admission still needs completion before runtime dispatch.

`createCastDiscoveryJobRepository` supplies claim, checkpoint, fail, and transactional publish. It locks campaign before job, processes sources in order, allows one running job per campaign, issues at most two extraction attempts, and fences old workers with a random lease token. Parsed checkpoints survive a new worker lease without incrementing the extraction attempt. The one automatic retry waits five seconds. Failed gaps block subsequent sources. Publication checks current source hash/revision/timeline and defers during all queued, replacement, assessing, generating, validating, committing, and recoverable generation states. Gate-off publication retains its checkpoint.

`applyCastBatchWithClient` exposes the existing cast batch implementation without a nested transaction. Publication callbacks can use it to atomically commit cast authority and the discovery receipt. This is an internal database seam; it is not a public API, provider write capability, or replacement for the pending validator/application layer. Current tests use deterministic callback output, not a model or worker adapter. Protagonist observations remain pending.

Deserialization validates source and chunk headers against the scoped job row and checks complete text hashes. Invalid persisted source bindings fail closed and roll back the attempted claim. Lifecycle cancellation, explicit retry, failure diagnostics for corrupt rows, candidate resolution, and coverage still need application integration.

Verification:

- Discovery PostgreSQL suite: **11 passed**, including caller-transaction rollback, idempotent enqueue, checkpoint restart, stale lease rejection, two abandoned attempts, source ordering, generation deferral, publication rollback with actual cast authority, multi-chunk completion, and corrupted source binding.
- Existing cast persistence/lifecycle/portability selection: **33 passed** before the final additional discovery regressions. Cast repository/API plus discovery selection subsequently passed **26 tests** before those final regression additions.
- Broader migration/archive/generation/adapter selection: **110 passed, 11 skipped, one migration-runner failure**. The failing maintenance-migration test reported `0001_initial_nexus` preceding already-run `0078_system_archive_jobs`; an isolated rerun of the complete migration suite passed **28/28**. The ordering failure was not reproduced; its cause is unproven.
- Full unit rerun with four workers: **345 files, 4,351 passed, 44 existing skips**. The preceding unrestricted run timed out in the two existing repository-scanning tests `task-14e3e8-composition-parity-boundaries` and `task-14e3h-legacy-authority-removal`; both passed in the full rerun. Final source-binding changes were verified with all 11 discovery PostgreSQL tests and TypeScript.
- Repository checks and TypeScript passed. Independent bounded queue review found no concrete blocker; suggested stale-worker and lease-exhaustion tests were added and passed.

The task-owned disposable PostgreSQL container `infinitequest-cast-phase4` is available on localhost port 55439 for continued verification. Its URL is only in ignored `.tmp/campaign-cast/database-url.txt`; do not print or commit it. No production database was used. No new browser check applies to this backend-only checkpoint.

## Validated publication checkpoint

Migration `0105_campaign_cast_discovery_candidates.sql` adds captured identity snapshots, receipt validation summaries, and scoped unresolved candidates. Candidate proposals are operational; applied observations remain portable cast events. Resolution endpoints and UI are still pending.

Claims capture identities on the first attempt of each chunk and retain them across retries. Default publication now validates the checkpoint, reconciles current identities, holds ambiguous or changed identities, and appends source-bound observations transactionally. It refreshes the roster between candidates so two aliases in one output cannot silently create duplicate identities. Existing world occurrences are reused by immutable world-version/entity provenance, including after a manual rename. Names, aliases, field overrides, pins, and ignore flags survive publication. Current world hints cover the scoped entity catalog, including legacy entity maps; playable-character selection and bounded profile hints still need completion.

Protagonist observations can now be recorded and survive portable export/import with ID mapping. They do not change the authoritative campaign character profile. Supporting-character editing restrictions still apply to the protagonist.

Verification at this checkpoint:

- RED/GREEN PostgreSQL regressions cover duplicate aliases within one output and reuse of a renamed world occurrence.
- Ten affected PostgreSQL integration files: **162 passed, 11 skipped**. This includes all **17 discovery tests**, **12 cast repository tests**, lifecycle, portability, APIs, migrations, archives, generation events, and adapter contracts. The previously reported migration ordering failure did not recur in this selection.
- Full unit suite with four workers: **345 files passed; 4,351 passed, 44 skipped**.
- `corepack pnpm check` passed. Bounded independent source review found no remaining blocker in the alias-collision and world-reuse fixes; the reviewer did not independently rerun PostgreSQL.
- Browser and live-provider checks were not run for these unwired backend changes. No deployment or production data changes occurred.

Automatic discovery is still not enabled or connected to generation acceptance. Frozen runtime execution, acceptance/lifecycle wiring, and the status/resolution UI remain required.

## Physical-attempt accounting checkpoint

Migration `0106_cast_discovery_physical_attempts.sql` adds the distinct `cast_discovery` reservation kind to the existing physical-attempt ledger. No request-scoped authoring bypass is used. Its down migration refuses to remove the kind while accounting rows exist; operational rollback should disable discovery and retain cost evidence.

The reservation binds the owner, discovery job, chunk ordinal, extraction attempt, and lease token. Repository operations lock campaign before job, reject expired/replaced leases, changed timeline or narration revisions, and already-checkpointed output. Reclaim gets a separate attempt identity while repeated reservation of the same request remains idempotent. Successful accounting completion writes actual usage and reported cost once, attributed to the accepted source turn with Story category and `cast_discovery` operation. Existing Story, authoring, illustration, and direct reservations retain their paths.

- RED: a live discovery reservation was rejected by the old repository. GREEN: the same regression now reserves, dispatches, completes, summarizes, and attributes cost once.
- PostgreSQL selection: **8 files, 152 passed, 11 skipped**. Includes discovery, existing provider/authoring accounting, migration upgrades, archives, generation events, and adapter contracts.
- Focused prepared executor, route execution, and migration-order unit tests: **29 passed**.
- Repository checks and TypeScript passed; `git diff --check` passed.
- Bounded independent source review found no concrete correctness, security, or deadlock flaw. Reviewer did not rerun PostgreSQL independently.
- No live provider call, browser change, deployment, or production database operation occurred. The reservation path is verified against disposable PostgreSQL; an actual discovery worker remains pending.

## Worker application-flow checkpoint

`runCastDiscoveryOnce` now owns one claimed chunk's extract/validate/checkpoint/publish sequence through application ports. Claim/execution types live in the application layer and remain re-exported by the database module for its existing consumers. New output is schema-validated before checkpointing. Reclaimed checkpointed output skips extraction. A lost lease prevents publication; malformed output or extraction failure enters the repository's durable retry policy with a sanitized diagnostic. Uncertain checkpoint commits and publication errors leave recovery state intact instead of triggering another provider call.

This is the application flow, not yet a registered runtime worker lane. Its extractor port must still be implemented using frozen admission, exact request budgeting, provider concurrency controls, and the lease-bound prepared executor. Acceptance, lifecycle, status, candidate resolution, and phases 05–06 remain pending.

- Worker and evidence unit selection: **24 passed**, including uncertain checkpoint commit recovery.
- Complete discovery PostgreSQL file: **19 passed**. The new application recovery regression interrupts publication after saving the response, reclaims the lease, confirms one extraction call total, and verifies both the created character and unchanged accepted narration.
- Repository checks and TypeScript passed after correcting application imports to use the contracts package entrypoint.
- Independent bounded review found no blocker and independently ran the initial seven worker unit tests. The eighth uncertain-commit regression was added afterward and passed locally.
- No live-provider or browser check was run; no production data or deployment was changed.

## Frozen runtime execution checkpoint

`prepareCastDiscoveryExecution` resolves one immutable text route and the exact nonstream `cast_discovery` response contract, with the discovery prompt protocol and a 30-second request deadline. Direct models require exact schema qualification; presets retain their resolved route authority. The queued snapshot now persists this admission, including its serialization configuration. Persistence validates provider binding, frozen route authority, and the plan derived from the trusted discovery prompt. Older development jobs without admission can still be read, but runtime dispatch fails closed.

`createCastDiscoveryExtractor` serializes the complete fiction-and-identity request against the frozen route's context/output allowance before calling the existing prepared executor with a discovery lease reservation. Oversized requests fail without a paid dispatch. Malformed or output-limited responses cannot become completed coverage. The extractor never re-resolves a mutable preset or invokes the provider directly. This adapter remains unwired to the production worker lane and acceptance path.

Independent review found a direct-model binding defect: the shared binding helper checked preset plans more strictly than direct plans. A regression reproduced dispatch with a changed prompt and recomputed hash. Both persistence and dispatch now explicitly validate direct route authority and compare the trusted derived plan; the regression passes. The reviewer reran all six adapter tests and found no remaining blocker in that bounded fix.

- Discovery PostgreSQL file: **21 passed**, including both direct and preset paths through persisted admission, the real prepared executor, physical accounting, checkpointing, and validated publication. These tests use a deterministic provider and assert the actual serialized request, timeout, cast authority, and attributed cost. Changed provider binding and rehashed altered prompts are rejected before enqueue.
- Discovery/worker/authoring/prepared-executor selection: **78 passed** before the final direct-binding regression; all six adapter tests passed again afterward.
- Full unit suite with four workers: **347 files passed; 4,365 passed, 44 skipped**. Repository checks, TypeScript, and `git diff --check` passed.
- No live model call, browser change, deployment, or production database operation occurred.

## Production worker registration checkpoint

The worker and combined runtime roles now compose the discovery application with the existing prepared executor and durable repository. `CAST_DISCOVERY_ENABLED` defaults off independently of editing. The scheduler registers a capacity-one optional discovery lane only when enabled, including when optional lanes are injected. Errors use sanitized diagnostics; ordinary empty/deferred work observes the existing poll delay. This does not yet establish an aggregate provider-call cap across lanes or the total physical-call ceiling across preset fallbacks and logical retries; both remain release gates.

- RED/GREEN captured the missing default-off config and missing scheduler registration.
- Config, scheduler, and runtime-role unit selection: **61 passed**. Both worker and combined roles construct discovery only when enabled. A pending discovery call does not stop ordinary story polling.
- Discovery PostgreSQL suite: **21 passed**, now using the production discovery composition for both direct and preset frozen execution. Disabled composition performs no provider call; enabled composition publishes validated authority and attributed accounting.
- Repository checks and TypeScript passed after fixing a test spy signature. `git diff --check` passed.
- Independent review identified shutdown counts indexed by lane position. RED/GREEN reproduced discovery being labeled as illustration; counters now look up lane names and include discovery explicitly. Discovery participates in the existing shutdown drain.
- Generation acceptance still does not enqueue discovery. No browser or live-provider verification applies to this backend registration, and no production runtime was started or changed.

## Accepted-turn integration checkpoint

Generation prepares discovery metadata outside the accepted-turn transaction, saves ready/unavailable admission in private orchestration, and reuses it on resume. The provider composition exposes preparation only when discovery is enabled. The accepted append/replacement transaction enqueues from the persisted effective narration and current cast timeline. Invalid enqueue state rolls back both writes. A metadata/preparation outage instead saves a failed discovery job with `admission_unavailable` while accepting the story; later discovery work cannot claim through that failed gap until recovery is implemented.

Tests cover ready, unavailable, saved, and disabled preparation, including one narration call despite an admission outage. PostgreSQL tests cover atomic rollback/retry, the accepted source, failed admission without story rejection, and replacement source/timeline binding. Independent bounded review found no blocker and ran all 80 generation-executor unit tests.

Verification: **58 PostgreSQL tests passed** across generation acceptance and discovery; **347 unit files passed, 4,372 tests passed, 44 skipped**. Repository checks, TypeScript, and `git diff --check` passed. The first PostgreSQL run exposed a test expectation using `complete` instead of the existing generation status `completed`; correcting that expectation produced the passing rerun. No live provider or browser verification was performed, and no production runtime or data was changed. Lifecycle recovery, enrollment/coverage, candidate controls, provider/attempt limits, and phases 05–06 are still required.
