# Campaign cast phase 01: identity and persistence implementation plan

> **For agentic workers:** Implement task-by-task with strict TDD. Use `superpowers:subagent-driven-development` when delegation is selected; otherwise execute natively. Do not start a later phase in this patch.

**Goal:** Persist stable campaign character identities and evidence-backed observations with deterministic projections.

**Architecture:** Add an owner-scoped cast repository and pure profile projection. Keep user overrides separate from automatic observations, and give the existing protagonist a linked identity without copying its profile.

**Tech Stack:** TypeScript, Zod, PostgreSQL, Vitest.

**Spec:** [Shared specification](2026-09-22-campaign-cast.md). Dependency: none.

## Global constraints

All shared-spec constraints apply. This phase is internal and has no public mutation route, provider call, or generation behavior change. New tables are additive; no applied migration is edited. Allocate the next migration number at execution time (the inspected baseline ends at 0101).

## Files and ownership

- Create `packages/contracts/src/campaign-cast.ts`, `packages/domain/src/campaign-cast.ts`, `packages/application/src/campaign-cast/types.ts`, `packages/application/src/campaign-cast/ports.ts`, `packages/application/src/campaign-cast/index.ts`, `packages/database/src/campaign-cast-repository.ts`.
- Create the next ordered SQL migration in `database/migrations/`, named with suffix `_campaign_cast.sql`.
- Modify relevant package barrel exports and `packages/application/src/system-archives/portability-registry.ts`.
- Create `tests/unit/campaign-cast-contract.test.ts`, `tests/unit/campaign-cast-projection.test.ts`, and `tests/integration/campaign-cast-repository.integration.test.ts`; extend `tests/unit/migration-order.test.ts` as needed.

## Shared interfaces

Import the shared types from the specification. Introduce:

```ts
type CastOverride = { field: CastField; value: string; evidence: CastEvidence };
type ProjectCastProfileInput = {
  observations: CastObservation[]; overrides: CastOverride[];
};
function projectCastProfile(input: ProjectCastProfileInput): CastProfile;
interface CampaignCastReadPort {
  loadSnapshot(scope: CastScope, boundary: CastBoundary): Promise<CastSnapshot>;
}
```

An empty override value means deliberately blank, not "use the automatic value." Removing an override is a separate later editing operation. Claims are displayed as evidence but excluded from the factual profile.

## Review focus

Two characters with the same name must retain distinct IDs; explicit blank overrides must survive; foreign campaign source turns must fail database constraints; the protagonist must not acquire a second profile; derived projection rebuild must reproduce the same effective state.

## Task 1: strict contracts and pure projection

- [x] Add schemas for the shared types and bounded profile fields. Reject extra mutation keys, invalid UUIDs, unsupported fields, and mechanically contaminated fiction fields; do not silently strip meaningful invalid user input.
- [x] Write projection tests before implementation. Representative behavior:

```ts
expect(projectCastProfile({ observations: [], overrides: [
  { field: "appearance.description", value: "", evidence: {
    kind: "user", editId: "11111111-1111-4111-8111-111111111111",
    effectiveTurnNumber: 4
  } }
] })).toEqual({ "appearance.description": "" });
```

- [x] Add source-ordered observations for the same field, a claim, and an explicit supersession. Assert claims never become facts and invalid supersession references fail before projection.
- [x] Run the two new unit suites; capture failure from missing behavior, then implement projection and validation and rerun to green.
- [x] Use deterministic ordering by effective source turn/revision, then recorded sequence; reject competing unsuperseded static attributes as unresolved rather than arbitrarily overwriting. Dynamic `state.*` and goals can advance from later supported observations. User overrides always win.
- [x] Commit the contract/domain slice after focused tests pass.

## Task 2: relational storage and protagonist identity

- [x] Add `campaign_cast_state` (one row per owner/campaign, cast revision, timeline revision), `campaign_cast_characters` (UUID identity, origin, first effective boundary), `campaign_cast_events` (identity/profile/override/pin/ignore events), `campaign_cast_observations` (field values and evidence), and `campaign_cast_profiles` (rebuildable current projection).
- [x] Store user edits as events, not destructive updates to prior evidence. Store accepted-source hashes and narration correction revisions. A source change invalidates the corresponding observation revision.
- [x] Enforce composite foreign keys through `(owner_user_id, campaign_id)` for all children and through the same campaign for source turns and superseded observations. Add unique protagonist-per-campaign and world-origin-per-campaign constraints. Do not make names or aliases unique.
- [x] Index campaign + effective turn + event sequence, campaign + character ID, and source turn + narration revision. Add an idempotency key unique within campaign for event batches.
- [x] Build the protagonist identity lazily inside the first cast write/initialization transaction; link to the campaign, tolerate a null selected-character ID, and read effective profile from the existing protagonist path.
- [x] Write real-PostgreSQL cases for identical names, concurrent initialization, foreign source rejection, event-batch replay, and projection rebuild. A second initialization must return the same protagonist cast ID.
- [x] Run `corepack pnpm exec vitest run --config vitest.integration.config.ts tests/integration/campaign-cast-repository.integration.test.ts`; capture RED, implement repository, rerun GREEN.
- [x] Classify identities/events/observations/state as `portable_authority`, profiles as `rebuildable`. Phase 02 must complete archive handlers before public writes are enabled.
- [x] Commit migration/repository changes separately from unrelated prompt or provider work.

## Exit gate and rollback

All focused suites and migration ordering pass. Projection rebuild preserves evidence-backed state and user blanks. No public UI or generation behavior changes. Rollback disables the unreleased feature and leaves additive tables; no down migration or live-data deletion. Handoff must record the allocated migration filename and exact exported types for phase 02.
