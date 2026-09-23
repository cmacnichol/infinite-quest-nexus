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
