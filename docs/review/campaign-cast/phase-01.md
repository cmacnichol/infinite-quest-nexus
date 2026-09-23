# Campaign cast phase 01 handoff

Phase 01 is implemented on `codex/campaign-cast` in `C:\Users\chris\.codex\worktrees\campaign-cast\InfiniteQuest`, based on `d6d40496dfc4e9c41a829fa5562794a5485cfe7d`. The main checkout is outside this implementation. See the [phased specification](../../superpowers/plans/2026-09-22-campaign-cast.md).

## Delivered boundary

This is an internal persistence foundation. No public routes, editor, discovery provider calls, generation wiring, or deployment changes are included. Relationships remain deferred; stable campaign-scoped UUIDs, evidence, origin pointers, and temporal boundaries provide their groundwork.

The existing protagonist remains authoritative in its existing profile system. Lazy initialization creates one linked cast identity, including when no selected-character ID exists. Reads project the existing fiction profile without persisting a second editable profile.

## Interfaces for phase 02

- `packages/contracts/src/campaign-cast.ts` exports strict schemas and types: `CastScope`, `CastBoundary`, `CastOrigin`, `CastField`, `CastEvidence`, `CastObservation`, `CastOverride`, `CastProfile`, `CastCharacter`, `CastSnapshot`, `CastCommand`, `CastBatch`, and `CastBatchReceipt`. Schema names use the corresponding camel-case name plus `Schema`.
- `packages/domain/src/campaign-cast.ts` exports `ProjectCastProfileInput`, `projectCastProfile`, `validateCastFiction`, and `castEvidenceOrder`.
- `packages/application/src/campaign-cast/ports.ts` exports `CampaignCastReadPort.loadSnapshot(scope, boundary)` and `CampaignCastRepositoryPort.initialize(scope)`, `applyBatch(scope, batch)`, and `rebuild(scope)`.
- `packages/database/src/campaign-cast-repository.ts` exports `createPostgresCampaignCastRepository(pool)` implementing the internal port. Production services do not call it yet.

Internal batches support create, observe, override, clear_override, identity, pin, and ignore commands. These are persistence operations, not a public editing API. Server allocation of character IDs and campaign-local idempotency receipts prevent names or provider-supplied identifiers from establishing identity.

## Persistence and invariants

Migration: `database/migrations/0102_campaign_cast.sql`.

| Table | Responsibility | Archive classification |
| --- | --- | --- |
| `campaign_cast_state` | Campaign cast/timeline revisions | portable_authority |
| `campaign_cast_characters` | Stable identity and first effective boundary | portable_authority |
| `campaign_cast_events` | Ordered atomic batches, edit history, idempotent receipts | portable_authority |
| `campaign_cast_observations` | Field evidence and source revisions | portable_authority |
| `campaign_cast_profiles` | Rebuildable projection cache | rebuildable |

Composite constraints preserve owner/campaign/source isolation. Protagonist and world-origin identities are unique within the campaign; names and aliases are not. Batches lock the campaign and roll back atomically.

Claims never become factual profile values. Explicit blank user overrides win. Competing unsuperseded static attributes remain unresolved; dynamic state and goals advance by supported source order. Explicit supersession validates character, field, mode, and ordering, including persisted sequence when the source is identical.

Snapshots revalidate effective narration hashes, correction revisions, and quote containment instead of trusting cached profiles. Corrected sources invalidate observations and dependent supersessions. A discovered identity whose introduction is corrected remains available under the same ID when a later explicit edit or fresh valid observation independently supports it, starting at that later boundary. World-origin occurrence visibility starts at its campaign introduction rather than the world evidence's turn zero.

## Verification

Strict TDD captured initial missing-contract/repository failures, then green focused suites. Additional assertion-level RED cases covered mixed-character projection, same-source supersession, invalid discovered-origin evidence, premature world-origin visibility, and corrected introductions losing later user edits. Each was fixed and rerun.

Final evidence:

- Full unit suite: **339 files passed; 4,323 tests passed, 44 skipped**.
- Consolidated real-PostgreSQL integration selection: **7 files passed; 141 tests passed, 11 skipped**. Includes cast persistence, protagonist transfer, migration upgrades, generation events, adapter matrix, System Archive, and resumable archive coverage. All **11 new cast integration tests passed without skips**.
- `corepack pnpm check`: passed repository boundaries, data safety, configured TypeScript and web checks, and JavaScript syntax checks.
- Independent review identified three issues; regression tests and fixes addressed all three. Re-review found no remaining phase-1 blockers and independently reran the 15 cast unit tests successfully.
- Existing skips are platform/security-capability gated checks. No browser or live-provider checks were run because this phase changes neither UI nor provider behavior. The full unrelated integration inventory was not run.

The shared integration database rejected its configured credentials. Verification used a separate disposable PostgreSQL container with the standard per-file isolation setup and a temporary config omitting shared bootstrap; shared credentials and volumes were not modified. Local ignored tooling routed nested pnpm calls through Corepack because the environment's bare pnpm differed from the repository version. Logs/configuration are under ignored `.tmp/campaign-cast/` and are not deliverables.

Earlier runs exposed migration-version fixture expectations, which were updated for 0102. One earlier broad run had a transient Chronicle fixture foreign-key failure during campaign deletion; a baseline probe and the subsequent complete selection passed. No unrelated production change was made for that failure.

## Next phase and rollback

Phase 02 must add the owner-scoped editing API, optimistic concurrency and active-generation gates, history lifecycle integration, ID remapping, and portable archive handlers before public cast writes are enabled. Registry classification alone does not provide archive export/import support. Keep the new repository unwired until those gates are complete.

Rollback leaves unused additive tables in place and disables the unreleased feature; no production down migration or data deletion is needed. No production migration was executed for this work.

Local checkpoints: `1d651649` contains the plans; `fc94d015` contains the initial contract/domain slice. The subsequent persistence checkpoint includes this handoff and can be identified with `git log --oneline -- docs/review/campaign-cast/phase-01.md`.
