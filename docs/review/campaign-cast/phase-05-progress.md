# Campaign cast phase 05 progress

Phase 04 was accepted in `ace89560` for the user-requested legacy UI scope. Phase 05 is in progress; phase 06 remains pending. Nothing in this checkpoint enables cast context in production prompts.

## Identity catalog groundwork

`EntityCatalogInput` accepts optional schema-validated campaign characters and the pinned world version ID. Supporting characters resolve to `campaign:<uuid>`; name and accepted aliases share that ID. Ambiguous aliases remain unresolved. The linked protagonist does not create a duplicate catalog entry, preserving historical protagonist IDs.

A world-origin occurrence replaces its equivalent catalog entry only when its origin matches the supplied pinned world version and it is the unique occurrence. It retains the historical world ID as an equivalent retrieval ID and combines reference aliases without changing world data. A different world version remains separate and ambiguous where names overlap. Historical calls without campaign input retain their prior shape.

RED/GREEN: two new identity tests failed before implementation; all 13 entity tests now pass. Entity, Chronicle helper and discovery selection: 39 tests passed. Repository and TypeScript checks passed. Logs: `.tmp/campaign-cast/phase5-identity-{red,green,regression,check}.log`.

## Remaining phase-05 work

Follow [the implementation plan](../../superpowers/plans/2026-09-22-campaign-cast-05-generation.md): captured evidence/coverage schema; bounded field-level fiction selection and override precedence; derived Chronicle metadata refresh with scoped fallback; versioned generation base and commit fingerprint; exact serialized source manifest and continuity-review support; both Story input modes; composed returning-character, lag, correction, historical retry and isolation tests. The catalog input is not wired to runtime callers yet. Do not enable `castContext` before those gates pass.
