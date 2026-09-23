# Campaign cast phase 05 progress

Phase 04 was accepted in `ace89560` for the user-requested legacy UI scope. Phase 05 is in progress; phase 06 remains pending. Nothing in this checkpoint enables cast context in production prompts.

## Identity catalog groundwork

`EntityCatalogInput` accepts optional schema-validated campaign characters and the pinned world version ID. Supporting characters resolve to `campaign:<uuid>`; name and accepted aliases share that ID. Ambiguous aliases remain unresolved. The linked protagonist does not create a duplicate catalog entry, preserving historical protagonist IDs.

A world-origin occurrence replaces its equivalent catalog entry only when its origin matches the supplied pinned world version and it is the unique occurrence. It retains the historical world ID as an equivalent retrieval ID and combines reference aliases without changing world data. A different world version remains separate and ambiguous where names overlap. Historical calls without campaign input retain their prior shape.

RED/GREEN: two new identity tests failed before implementation; all 13 entity tests now pass. Entity, Chronicle helper and discovery selection: 39 tests passed. Repository and TypeScript checks passed. Logs: `.tmp/campaign-cast/phase5-identity-{red,green,regression,check}.log`.

## Remaining phase-05 work

Follow [the implementation plan](../../superpowers/plans/2026-09-22-campaign-cast-05-generation.md): captured evidence/coverage schema; bounded field-level fiction selection and override precedence; derived Chronicle metadata refresh with scoped fallback; versioned generation base and commit fingerprint; exact serialized source manifest and continuity-review support; both Story input modes; composed returning-character, lag, correction, historical retry and isolation tests. The catalog input is not wired to runtime callers yet. Do not enable `castContext` before those gates pass.

## Captured evidence and selector checkpoint

`castGenerationSnapshotSchema` is a separate versioned private contract carrying scope, pinned world, cast revision/boundary, coverage, character identities and their current evidence/overrides. It rejects duplicate/foreign bindings and future character chronology. The read-only transaction helper captures the existing retained projection under the campaign lock, creates no identities or state rows, and hashes the complete snapshot. It shares the existing correction/supersession rules; historical base boundaries and coverage are explicit. Earlier-world evidence is labeled historical.

`selectCastContext` selects direct/current-scene references, active threads, pins and recent characters in deterministic order. It excludes ignored/protagonist cards and unresolved shared-alias-only matches, reprojects fields from captured evidence, preserves overrides (including explicit state corrections during lag), and omits claims, invalid/future evidence, invalidated supersession chains and stale dynamic fields. Historical-world state is never asserted as current. Whole fields/records are omitted when necessary; token accounting includes the complete serialized envelope and coverage/precedence notice. A zero budget produces no block. Runtime total-budget allocation remains unwired.

Verification: RED/GREEN covered initial selector/capture, invalid supersession dependencies, future chronology and historical-world state. All five cast PostgreSQL suites passed (83 tests), including no read-side creation, foreign-owner exclusion, corrected evidence/fingerprint changes and historical coverage. Focused context/projection/contract/entity selection passed 37 tests. Repository/TypeScript checks passed. Independent review found no issue and independently passed 21 context/entity tests before the final priority test was added. Logs: `.tmp/campaign-cast/phase5-{context-red,context-green,supersession-red,boundary-red,capture-red,capture-green,capture-regression,context-regression,context-check}.log`.

Still required: production capture wiring, a new generation-base/prompt version and historical readers, commit freshness checks, context planner allocation, exact request manifest/reviewer binding, Chronicle metadata refresh/fallback, composed payload/replay proof and phase 06. This checkpoint does not make cast information influence narration yet.

## V4 authority reader and freshness checkpoint

Added an explicit `generation-base-v4` reader binding cast revision, timeline, coverage bounds and the complete captured snapshot fingerprint. Authority capture uses the existing campaign transaction locks and the appropriate append/replacement base. Context loading preserves modern character/recent-history behavior, requires matching captured cast for v4, and rejects cast attached to older bases. Execution loading and commit re-resolve the stored version and reject changed cast authority. Legacy/v3 remain unchanged; production enqueue still creates their existing versions.

The shared fingerprint sorts keys and omits undefined optional object fields, matching JSON persistence. A regression first reproduced an unequal fingerprint after JSON round-trip and then passed after normalization. Focused generation/selector units: 44 passed. PostgreSQL execution, recent-window and cast repository suites: 62 passed, including v4 load/commit drift rejection without advancing accepted history. Repository/TypeScript checks passed before the final serialization test; final check recorded in `phase5-v4-check.log`. Independent review found no actionable defects and separately ran 26 unit tests before the final serialization regression.

Logs: `.tmp/campaign-cast/phase5-v4-{unit,pg,execution,json-red,check}.log`. These tests exercise saved v4 readers explicitly; they do not claim a production v4 queue path or actual cast prompt inclusion. Still required: frozen queue capability/prompt protocol, bounded planner allocation and evidence manifest/reviewer support, derived metadata refresh/fallback, composed payload/replay verification, and phase 06.

## Bounded cast prompt and source manifest

The planner now consumes captured cast only for v4. It allocates at most 3,000 tokens and 10% of residual available context, within existing context/request ceilings. The pure selector drops whole fields/records; a second check measures actual provider serialization and safety allowance before reserving the selected block. Legacy/v3 retain their existing wire shape. Diagnostics expose allocation, omitted fields/characters and coverage.

Selected cast identities, individual fields, coverage and precedence notice are bound to the exact producing request. User overrides are corrected-state evidence; accepted-turn observations and world references retain separate semantic roles. Every selected cast entry is required in review; omitted fields cannot supply manifest evidence. Both Action and Story Direction tests prove a user correction reaches serialized output, altered payloads fail rebinding, over-budget corrections are omitted whole, and historical v3 remains unaffected.

RED/GREEN logs: `phase5-planner-cast-red.log`, `phase5-planner-world-red.log`, `phase5-planner-regression.log` under `.tmp/campaign-cast/`. Focused suites passed 55 tests; the complete unit suite passed 4,413 tests with 44 existing skips in 350 files (`phase5-planner-fullunit.log`). Independent review found no actionable defects and separately ran 43 tests. Type/repository checks: `phase5-planner-check.log`. No browser, PostgreSQL or live-provider behavior is claimed by these planner tests.

Remaining release gates: versioned prompt/reviewer semantics and frozen queue capability, derived Chronicle metadata refresh/fallback, composed PostgreSQL payload/commit/replay tests, enablement configuration and documentation, then phase 06. New jobs still do not enqueue v4, so this checkpoint does not enable cast context in production.

## Frozen queue and prompt capability

Added opt-in `story-v17-campaign-cast` / `current-continuity-v4` with `castContext: true` in the frozen Story Memory snapshot. Strict validation rejects mixed capability/protocol combinations; older snapshots and constants remain unchanged. V17 appends application-owned cast precedence rules without rewriting creative template bytes. Its prompt proof and execution identity are distinct, including for replacements. Review and repair append the same precedence contract only under the frozen v17 proof and reject cast evidence under older proofs.

The internal operator setting `castContextEnabled` now reaches policy capture, prompt resolution and enqueue. Enabled append/replacement jobs capture v4; the executor agrees with their execution identity and refuses a cast/base mismatch before loading providers. No environment/deployment flag is enabled in this checkpoint; that release gate still depends on retrieval and composed verification. Disabling the internal setting changes only subsequently captured jobs.

RED/GREEN: protocol tuple and prompt reader (3 tests), PostgreSQL enqueue for append/replacement, PostgreSQL on/off capability snapshots, executor base/capability rejection in both directions, and review/repair contract selection. Queue/enrollment PostgreSQL suites passed 62 tests. Complete unit suite passed 4,419 tests with 44 skips in 351 files. Repository/TypeScript checks passed; independent review found no actionable defects and separately ran 14 policy/review adapter tests. Logs under `.tmp/campaign-cast/`: `phase5-{protocol-red,protocol-green,queue-red,queue-green,capability-red,queue-regression,worker-cast-red,worker-protocol-green,review-cast-red,review-cast-green,protocol-fullunit,protocol-check}.log`.

Remaining: derived Chronicle metadata refresh/fallback and runtime catalog wiring, full PostgreSQL discovery/edit/returning-alias/actual-provider-payload/commit/replay proof, any resulting runtime compatibility fixes, default-off configuration/deployment documentation, phase-05 acceptance audit, then phase 06. No live-provider or browser validation is claimed for this backend slice.
