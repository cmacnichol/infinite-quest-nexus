# Campaign cast phase 02 handoff

Completed 2026-09-23 in `codex/campaign-cast`, based on `f12be97e`. Phase 02 is ready for the phase 03 editor. No production deployment, migration, provider call, or user-data change was performed.

## Delivered interfaces

- Contracts: `createCastCharacterSchema`, `editCastCharacterSchema`, `castWriteResultSchema`, `castListQuerySchema`, `castDetailSchema`, `castStoredCommandSchema`, `portableCampaignCastSchema`, and corresponding inferred types; `portableCastReferences` and `validateCampaignArchiveCast` support archive boundaries.
- Application: `createCampaignCastApplication`, `CampaignCastApplication`, `CampaignCastWritePort`, and typed `CampaignCastError` codes.
- Database: `createPostgresCampaignCastRepository(pool, { editingEnabled })` supplies current/detail/create/edit in addition to the phase 01 internal port. `applyCastBoundaryChange`, `copyCampaignCast`, `exportCampaignCast`, and `importCampaignCast` use the caller's transaction.
- Runtime/API: `createApiCampaignCastApplication` and `registerCampaignCastRoutes`; GET list/detail, POST create, PATCH edit under `/api/v1/campaigns/:campaignId/cast`. `/api/v1/meta` exposes `capabilities.castEditing`.

Lists are bounded to 50 characters per page. Detail exposes observations, overrides, identity-event evidence, and an empty `unresolvedCandidateIds` collection reserved for discovery. Writes return the character, enclosing cast revision, and timeline boundary. The original idempotent response is stored and replayed exactly. Blank override and clearing an override have distinct meanings. Protagonist edits continue through the existing editor destination.

## Persistence, history, and archives

Migration `0103_campaign_cast_lifecycle.sql` adds the operational boundary-change key and historical-world provenance constraints. `historical_world` retains source world IDs without establishing a destination-world foreign key. New internal observations cannot invent historical provenance; it is an import representation. The portability registry excludes the boundary-change key.

Rewind/undo, branching, narration correction, accepted-turn replacement, and cross-world transfer now invoke cast lifecycle work inside their existing transactions. Rewind removes discarded future edits and identities; retained evidence is projected again. Timeline revisions reject stale work. Branch/transfer remap retained IDs, preserve claim speakers, and copy effective narration corrections so invalidated facts cannot become current again.

Campaign archive payloads and System Archive campaign records include versioned cast authority. Imports validate IDs, limits, source ownership, chronology, and references; allocate destination cast IDs; bind the server owner; and rebuild profiles after restoring turns and corrections. Projection caches, operational receipts, and provider payloads are excluded. Old archives without cast remain valid; unsupported newer formats fail. Gate-off export still preserves existing cast data.

Changed production areas are the cast contracts/application/repository and new lifecycle/portability modules; the existing campaign-state, transfer, correction, generation replacement, Campaign/System Archive adapters; and runtime/API/configuration wiring. Deployment edits only carry the default-off setting. Existing migration-watermark fixtures advance to 0103.

## Verification

Strict TDD captured missing API/application behavior, lifecycle and archive failures, then passing focused tests. Review regressions reproduced corrected narration becoming current again after transfer, hidden historical speaker references breaking branch copy, and forged introduction chronology breaking rewind after import. Each has a passing regression test. Independent re-review reported no remaining concrete blockers.

- Full unit suite: **340 files passed; 4,326 tests passed, 44 skipped**.
- Affected PostgreSQL regression selection: **16 files passed; 196 tests passed, 53 skipped**. Includes cast API/repository/lifecycle/portability, state replay/corrections, transfers, narration correction, Campaign/System Archives, resumable imports, migrations, generation events, adapter matrix, portable composition, and canonical reference compatibility.
- Final cast-only PostgreSQL rerun after the last chronology fix and reset-to-discovered API test: **4 files passed; all 33 tests passed, no skips**.
- `corepack pnpm check`: passed repository/data boundaries, TypeScript, both web checks, and JavaScript syntax checks.
- `corepack pnpm build`: passed runtime and both web builds; existing Vite large-chunk warning remains.
- Compose and Swarm configuration parsing passed with a disposable placeholder for the required Compose password; nothing was deployed.
- Markdown relative-link checks and `git diff --check`: passed.

The broader PostgreSQL run occurred before the final chronology tightening and added reset test; all cast suites were rerun afterward. Existing skips are platform/security-capability gated. Browser/screenshots and live-provider checks were not run because this phase adds no UI or provider behavior. The complete unrelated integration inventory was not run.

Verification used a separate disposable PostgreSQL container and standard per-file isolation, with a temporary config omitting shared bootstrap because shared credentials were unavailable. Shared credentials and volumes were not changed. Ignored local tooling routed nested pnpm calls through Corepack. Temporary logs under `.tmp/campaign-cast/` are not deliverables.

## Gates, next phase, and rollback

`CAST_EDITING_ENABLED=false` remains the default. All phase 02 gates pass; an operator may explicitly enable the API after migration. This task did not enable it in a running deployment. See [operations](../../runbooks/campaign-cast.md) and the [phase 03 plan](../../superpowers/plans/2026-09-22-campaign-cast-03-editor.md).

No discovery worker/jobs, relationship API, cast UI, context injection, or backfill is included. Phase 04 must add discovery-job cancellation at the existing timeline-change transaction seam. Pin/ignore are persisted here; their prompt-selection effect belongs to phase 05. The protagonist retains its existing profile authority.

Rollback disables editing while retaining schema, reads, and archive preservation. Do not delete cast authority or narrow historical provenance constraints. Identify the local checkpoint with `git log --oneline -- docs/review/campaign-cast/phase-02.md`.
