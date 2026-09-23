# Campaign cast phase 02: editing API and lifecycle implementation plan

> **For agentic workers:** Implement task-by-task with strict TDD. Use `superpowers:subagent-driven-development` when delegation is selected; otherwise execute natively. Do not start a later phase in this patch.

**Status:** Implemented 2026-09-23. See [verification and handoff](../../review/campaign-cast/phase-02.md). Discovery jobs do not exist yet; phase 04 must add their cancellation to the completed boundary-change seam.

**Goal:** Expose safe manual character creation and editing, with history, branching, and backup behavior complete before public use.

**Architecture:** A campaign-cast application module owns mutations and optimistic concurrency. Existing history and transfer operations invoke cast lifecycle operations in their transactions; portable formats preserve identities and evidence with explicit ID remapping.

**Tech Stack:** TypeScript, Zod, Fastify, PostgreSQL, Vitest.

**Spec:** [Shared specification](2026-09-22-campaign-cast.md). Dependency: phase 01 accepted.

## Global constraints

Shared constraints apply. `castEditing` stays off until lifecycle and archive tests pass. No automatic discovery, relationship API, destructive character deletion, or protagonist profile migration.

## Files and ownership

- Create `packages/application/src/campaign-cast/use-cases.ts`, `services/api/src/campaign-cast-routes.ts`, `services/runtime/src/campaign-cast-composition.ts`, `packages/database/src/campaign-cast-lifecycle.ts`.
- Extend phase 01 contracts/ports/repository, `services/runtime/src/main.ts`, `packages/database/src/config.ts`, `packages/database/src/campaign-state-repository.ts`, `packages/database/src/campaign-transfer-character-repository.ts`, and `packages/database/src/generation-execution-repository.ts` for turn replacement invalidation.
- Extend `packages/contracts/src/archives.ts`, `packages/contracts/src/system-archives.ts`, `packages/application/src/system-archives/portability-registry.ts`, `packages/database/src/system-archive-export-repository.ts`, `packages/database/src/system-archive-import-repository.ts`, `services/runtime/src/system-archive-preview-index.ts`, `services/runtime/src/campaign-archive-export-composition.ts`, and `services/runtime/src/portable-import-export-composition.ts` for their actual cast paths. Follow called adapters rather than duplicating import logic.
- Add `tests/unit/campaign-cast-application.test.ts`, `tests/integration/campaign-cast-api.integration.test.ts`, `tests/integration/campaign-cast-lifecycle.integration.test.ts`, `tests/integration/campaign-cast-portability.integration.test.ts`.
- Update `docs/player-guide/campaign-continuity.md` and create `docs/runbooks/campaign-cast.md` with gate/default/rollback behavior.

## Interfaces and route contract

```ts
type CastWriteBase = {
  expectedCastRevision: number; expectedBoundary: CastBoundary;
  idempotencyKey: string;
};
type CreateCastCharacter = CastWriteBase & {
  name: string; aliases: string[]; profile: CastProfile;
};
type EditCastCharacter = CastWriteBase & {
  expectedCharacterRevision: number; name?: string; aliases?: string[];
  setOverrides?: CastProfile; clearOverrides?: CastField[];
  pinned?: boolean; ignored?: boolean;
};
interface CampaignCastWritePort {
  create(scope: CastScope, request: CreateCastCharacter): Promise<CastCharacter>;
  edit(scope: CastScope, id: Id, request: EditCastCharacter): Promise<CastCharacter>;
}
```

Routes under `/api/v1/campaigns/:campaignId/cast`: GET list with cursor/limit/query; POST create; GET `/:characterId` detail/evidence; PATCH `/:characterId` edit. GET returns cast revision, boundary, and capability flags. POST/PATCH return the new character and enclosing cast revision. No owner ID is accepted in the body. A capability endpoint follows the existing server capability mechanism; do not infer support from client build version.

Errors: 404 for missing/foreign resource; 409 `cast_revision_conflict` for stale revision or boundary; 409 `cast_generation_active` while a queued/running/recoverable generation depends on current authority; 422 for invalid fields/evidence shape; 409 for a reused idempotency key with a different body. Repeated identical requests return the original receipt.

## Review focus

Concurrent edits; explicit blank versus reset-to-discovered; branch before a character exists; imports with forged owner IDs or cross-campaign evidence; rewinds and replacements while discovery work is outstanding.

## Task 1: manual application and routes

- [x] Add a failing API case that creates a sparse character, reads it, saves an empty appearance override, then retries the identical mutation and receives the same ID/revision.
- [x] Assert the write contract preserves an intentional blank:

```ts
expect(editCastCharacterSchema.parse({
  expectedCastRevision: 2, expectedCharacterRevision: 1,
  expectedBoundary: { turnNumber: 4, timelineRevision: 0 },
  idempotencyKey: "cast-edit-0001",
  setOverrides: { "appearance.description": "" }
}).setOverrides).toEqual({ "appearance.description": "" });
```

- [x] Under campaign/state locks, check gate, server owner, boundary, revisions, active generation, and idempotency; append the edit event and update projection/revision atomically.
- [x] Reject editing linked protagonist fields through this route and return its existing editor destination; pin/ignore rules must not hide the protagonist authority. Return a specific validation error rather than silently ignoring the write.
- [x] Cover stale revisions, simultaneous writes, unsafe markup rendered as data, request size limits, and same-name characters. `ignored` excludes a supporting character from automatic prompt selection but retains evidence; `pinned` increases relevance priority without guaranteeing unlimited prompt space.
- [x] Run application and API suites RED/GREEN; commit only after those behaviors pass.

## Task 2: temporal lifecycle and correction

- [x] Define `applyCastBoundaryChange(client, scope, boundary)` in `campaign-cast-lifecycle.ts`: increment timeline revision, invalidate source revisions no longer effective, cancel stale operational jobs, and rebuild the projection from retained effective events. The caller supplies its transaction client.
- [x] Invoke it from rewind/undo, replacement, and narration correction. Preserve user edits at retained boundaries; exclude edits effective after the new boundary. Source-dependent automatic observations from corrected narration become inactive.
- [x] For branching, copy retained identities/events/evidence through the selected boundary using an explicit cast-ID and turn-ID mapping. Characters first introduced afterward must not be copied. Initialize the destination protagonist link against its own campaign.
- [x] For cross-world transfer, preserve campaign-local characters and historical origin provenance; do not reinterpret old world IDs as destination world entities. Copy only data permitted by the existing transfer boundary, and maintain an explicit source-to-destination mapping.
- [x] Test lifecycle using real PostgreSQL: character at turn 8 absent from branch at 7; edit at 9 absent after rewind to 8; corrected source facts inactive; repeated rewind idempotent; no in-flight stale batch can recreate removed state.
- [x] Run the new lifecycle suite plus affected existing campaign-state and transfer integration tests; capture RED/GREEN and commit.

## Task 3: portability and controlled exposure

- [x] Version portable cast payloads; exports include identities, retained observation/event evidence, overrides, and origin provenance. Exclude job leases, provider credentials, model payloads, and rebuildable profiles.
- [x] Import old archives without cast as an empty supporting cast. For cast-aware archives, validate sizes/references before writes, remap campaign/turn/character IDs, assign server-resolved ownership, and rebuild projections. Preserve source owner information only as non-authoritative provenance if the existing format supports it.
- [x] Complete System Archive classifications, row selection, preview accounting, relationship validation of cast-to-turn references, and restoration ordering. Unknown newer cast formats must produce a clear unsupported-version error rather than silently dropping records.
- [x] Test campaign JSON and System Archive round trips, user blanks, repeated names, foreign source references, and old-format import. Verify existing campaign export paths cannot silently omit enabled cast data.
- [x] Wire `castEditing` default-off capability and deployment configuration using the existing settings conventions; update config examples and manifests only where required to carry that setting consistently.
- [x] Run the new portability suite and affected archive tests, type checks, and `git diff --check`; commit and produce phase handoff.

## Exit gate and rollback

Manual CRUD-without-delete is owner-scoped, revision-safe, history-safe, and portable. Existing protagonist editing remains unchanged. Disable `castEditing` to stop new mutations; keep stored data and archive support. Read-only exports must continue preserving cast data after the gate is disabled. This phase is ready for UI consumption, not discovery.
