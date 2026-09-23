# Campaign cast phase 04 progress

Updated 2026-09-23 on `codex/campaign-cast`, after phase 03 commit `da74d713`. Phase 04 is **in progress**, not released. The active goal still includes phases 04–06. Legacy `/story` remains the requested UI surface.

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

1. Connect the durable queue below to unresolved candidates, contiguous coverage, and runtime capability handling. Migration 0104 now exists; use the next ordered migration for further additive schema changes.
2. Freeze routing at admission without a provider call inside acceptance. Use the existing prepared-request executor and physical-attempt cost ledger with a new lease-bound discovery reservation; do not disguise discovery as a direct authoring request.
3. Wire atomic accepted-turn enqueue to the validated publication seam below. Complete pinned-world playable-character selection and bounded identity hints before provider dispatch.
4. Lifecycle cancellation/re-enqueue for corrections, replacement, rewind, branches, and transfer. Existing phase-02 approvals cover these source integrations.
5. Status/retry/candidate-resolution API and legacy UI, then actual PostgreSQL and browser acceptance gates.
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
