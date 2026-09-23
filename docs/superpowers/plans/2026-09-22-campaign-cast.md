# Campaign cast: phased implementation specification

**Status:** Phases 01–02 implemented; phases 03–06 remain planned. Updated 2026-09-23. See the [phase 01 handoff](../../review/campaign-cast/phase-01.md) and [phase 02 handoff](../../review/campaign-cast/phase-02.md) for interfaces, verification, and remaining gates.

**Goal:** Give campaigns a persistent, editable cast and automatically discover characters from accepted story turns. Preserve enough identity, provenance, and temporal structure to add relationships later without replacing the character model.

**Source baseline:** `d6d40496dfc4e9c41a829fa5562794a5485cfe7d` plus existing working-tree changes. Reinspect the execution checkout before implementing. The planning session changed no application code. Do not copy or overwrite unrelated local provider/prompt changes.

## Delivery order

| Phase | Separate implementation plan | Usable result | Dependency |
| --- | --- | --- | --- |
| 01 | [Identity and persistence](2026-09-22-campaign-cast-01-foundation.md) | Internal campaign cast storage, provenance, and deterministic projection | None |
| 02 | [Editing API and lifecycle](2026-09-22-campaign-cast-02-editing-lifecycle.md) | Manual creation/editing through an owner-scoped API, safe history and portability | 01 |
| 03 | [Cast editor](2026-09-22-campaign-cast-03-editor.md) | Users can create, find, edit, pin, and ignore cast members | 02 |
| 04 | [Automatic discovery](2026-09-22-campaign-cast-04-discovery.md) | New accepted turns populate the editable cast automatically | 03 |
| 05 | [Generation context](2026-09-22-campaign-cast-05-generation.md) | Relevant cast records and edits reach the actual text-provider request | 04 |
| 06 | [Optional history backfill](2026-09-22-campaign-cast-06-backfill.md) | Existing campaigns can scan selected accepted history on request | 05 |

Phases 01–05 are the basic feature. Phase 06 is separately selectable and is not required for forward discovery. Each phase is one reviewable patch/PR; do not combine all phases into one implementation. Each phase can land behind its gate without changing active generation prematurely. Implement phases sequentially; each handoff records the actual interfaces, migration number, tests, commit, and remaining limitations.

## Scope and deliberate deferrals

Included: campaign-local supporting characters; manual creation; editing sparse profiles; aliases; provenance links; current versus historical facts; pin/ignore controls; correction-safe discovery; discovery health; scene-relevant context; ownership, history, and portable backup semantics.

Deferred: relationship graph extraction/editing, affinity scores, graph visualization, automatic identity merging, merge/split UI, illustration changes, world-canon promotion, protagonist migration, and automatic full-history scanning. Ordinary relationship sentences remain recoverable in accepted narration and existing canonical facts; do not discard them or convert them to unsupported graph edges.

The protagonist remains in the existing `campaigns.character_profile` / `character_snapshot` system. The cast lists it as a linked identity with its existing editor. Do not duplicate its editable profile. Supporting characters reuse the useful profile vocabulary, with narrower field limits and strict validation.

## Current source seams

- `packages/contracts/src/world-library.ts`: existing character identity, story, and appearance fields. `keyRelationships` is prose, not a relationship graph.
- `packages/domain/src/entity-references.ts`: stable catalog currently comes from world entities and the selected character; heuristic discoveries have no stable cast ID.
- `packages/database/src/generation-execution-repository.ts`: accepted-turn transaction and Chronicle writes.
- `packages/database/src/generation-authority.ts` and `packages/application/src/memory/generation-context.ts`: versioned generation base and stale-authority checks.
- `services/runtime/src/generation-context-planner.ts`: protected context, optional selection, token budgeting, and source manifests.
- `packages/database/src/campaign-state-repository.ts`: branch/rewind state operations.
- `packages/database/src/campaign-transfer-character-repository.ts`: protagonist edits and cross-world transfer.
- `packages/application/src/system-archives/portability-registry.ts`: every new table requires deliberate export classification.
- `apps/web-next/src/story-player-tools.ts` and `apps/web/src/story.js`: replacement and legacy Story entry points.

## Global constraints

- Authoritative data is owner- and campaign-scoped; world origin references include the immutable world version. The server resolves ownership.
- The accepted turn ledger and explicit user corrections are authoritative. Cast observations preserve source evidence; current profile cards are rebuildable projections.
- Character IDs are server-created UUIDs, independent of names and aliases. Neither matching names nor a provider-supplied ID grants identity authority.
- Unknown fields stay unknown. Do not invent background, personality, appearance, or relationships to fill a profile.
- Discovery reads accepted effective narration only, not Story Direction, scratchpads, rejected drafts, mechanics, or provider reasoning.
- User overrides, including explicit empty values, survive later extraction. An edit applies at its current accepted-turn boundary; it does not rewrite past narration.
- Turn acceptance must not depend on a discovery provider call. Insert a durable discovery receipt/job in the accepted-turn transaction; perform extraction afterward.
- Discovery never changes narration or triggers a replacement story generation. Retries reuse a frozen execution snapshot and source identity.
- During tracking lag, generation uses a consistent snapshot, explicit tracking coverage, and existing accepted-history fallback. It must not present stale observations as complete current state.
- No relationship endpoints or relationship UI ship in phases 01–05. Their future prerequisites ship in phases 01–02.
- Use existing provider routing, secret isolation, request accounting, cancellation, and lease conventions. No new provider backend or external dependency is required.
- Use strict TDD for executable changes, followed by focused real-PostgreSQL and browser checks where applicable. Unit/fixture success is not live narrative-quality proof.
- Both `/story` and `/app/story` remain usable. Visible cast workflows require rendered-browser screenshots on both.
- Work in an isolated checkout at implementation time. Read `AGENTS.md`, `docs/agents/domain.md`, applicable context docs, `docs/concepts/identity-and-ownership.md`, `docs/runbooks/deployment.md`, and `docs/workflows/testing.md`.

## Shared data contract

Introduce these types in `packages/contracts/src/campaign-cast.ts`; following phases import them rather than redeclare alternatives. `Id` is a validated UUID string; revisions and turn numbers are nonnegative integers.

```ts
type Id = string;
type CastScope = { ownerUserId: Id; campaignId: Id };
type CastBoundary = { turnNumber: number; timelineRevision: number };
type CastOrigin =
  | { kind: "manual" }
  | { kind: "discovered" }
  | { kind: "world"; worldVersionId: Id; entityId: string }
  | { kind: "protagonist"; selectedCharacterId: string | null };
type CastField = "identity.pronouns" | "story.role" | "story.background"
  | "story.personality" | "story.motivations" | "story.goals"
  | "story.voiceAndMannerisms" | "appearance.description"
  | "state.location" | "state.condition" | "state.clothing";
type CastEvidence =
  | { kind: "turn"; turnId: Id; turnNumber: number;
      narrationRevision: number; sourceHash: string;
      paragraphId: string; quote: string }
  | { kind: "user"; editId: Id; effectiveTurnNumber: number }
  | { kind: "world"; worldVersionId: Id; sourcePath: string };
type CastObservation = {
  id: Id; characterId: Id; field: CastField; value: string;
  mode: "fact" | "claim"; speakerCharacterId: Id | null;
  evidence: CastEvidence; supersedesObservationId: Id | null;
};
type CastProfile = Partial<Record<CastField, string>>;
type CastCharacter = {
  id: Id; name: string; aliases: string[]; origin: CastOrigin;
  profile: CastProfile; pinned: boolean; ignored: boolean;
  revision: number; firstObservedTurn: number; lastObservedTurn: number;
};
type CastSnapshot = {
  revision: number; boundary: CastBoundary; characters: CastCharacter[];
  trackedThroughTurn: number; coverageStartTurn: number;
  discoveryStatus: "off" | "current" | "pending" | "failed";
};
```

`appearance.description` is an intentionally sparse first-release field; reuse the existing character-fiction sanitizer and display vocabulary, not the permissive authoring schema's arbitrary extensions. `state.*` fields are explicitly dynamic. `story.goals` can evolve; their source order remains visible. Names and aliases also require evidence in identity events, even though the read model exposes plain strings.

Bounds: names/aliases 200 characters; at most 20 aliases; field value 2,000 characters; evidence quote 1,000 characters; at most 50 characters per list page. Count these as validation limits, not prompt-token estimates. Provider extraction limits belong to phase 04 and must not truncate accepted narration silently.

Export strict schemas alongside these types: `castScopeSchema`, `castBoundarySchema`, `castOriginSchema`, `castFieldSchema`, `castEvidenceSchema`, `castObservationSchema`, `castProfileSchema`, `castCharacterSchema`, and `castSnapshotSchema`. Phase 02 adds `createCastCharacterSchema` and `editCastCharacterSchema`; phase 04 adds `castDiscoveryOutputSchema`; phase 06 adds `castBackfillRequestSchema`. These exact exports are used in the phase test excerpts.

The character detail response extends the read model with `observations: CastObservation[]`, `overrides: CastOverride[]`, identity-event evidence, and unresolved candidate references. List responses stay compact and paginated. `CastOverride` is exported from the phase 01 contract module. Current visibility and the field's origin must be distinguishable so the editor can offer **Use discovered value** accurately.

Profile projection is monotonic only with respect to retained evidence: a lack of mention does not delete a character, erase a field, or establish death/departure. Changing a display name keeps the UUID; automatically learned aliases require accepted identity evidence. Ignored identities remain in identity resolution so later mentions do not create replacement duplicates.

## Relationship groundwork now

1. A persistent cast identity exists for the protagonist too, but references the existing protagonist authority. Future edges can target that ID without migrating the profile.
2. Keep identity, observations, user overrides, and projected profile separate. Relationship assertions can later use the same source evidence, effective boundaries, and revision rules.
3. Persist world-origin identity separately from campaign identity. Meeting a world character creates a campaign occurrence; it never edits the published world.
4. Branch/import maintain an explicit old-to-new cast-ID mapping. Future edges can use the same remapping step for both endpoints.
5. Record field supersession and temporal scope; reserve no guessed trust numbers or relationship taxonomy. Do not create unused relationship tables now.
6. Preserve claims and their speaker separately from facts. Later relationship extraction must not turn dialogue, rumors, or intentions into facts automatically.

## Chosen discovery flow

```text
Accept story turn + enqueue discovery receipt atomically
  -> read immutable effective-narration revision and bounded evidence paragraphs
  -> extract sparse candidate records using a frozen text execution plan
  -> validate evidence, identity, ownership, bounds, and timeline
  -> atomically append observations and refresh cast projection
  -> next generation captures cast revision + coverage alongside existing authority
```

This refines the earlier evaluation's pre-commit extraction suggestion: post-commit extraction avoids extending story completion latency and eliminates candidate-versus-accepted narration ambiguity. It introduces eventual consistency, which phase 05 must expose and handle explicitly. A failed discovery is recoverable metadata work, never a failed accepted story.

## Release and acceptance

Feature capabilities are server-owned: `castEditing`, `castDiscovery`, and `castContext`. Default each off until its phase's gates pass. Discovery can be enabled only when editing is available; context only when discovery infrastructure is available. An existing campaign begins forward tracking at its enrollment boundary; `trackedThroughTurn` is relative to `coverageStartTurn`, not a false claim that all earlier history was scanned.

Core acceptance scenario: manually add Iven; accept a turn introducing Mara; discover her once; edit a wrong appearance detail and clear an unwanted inferred field; process another turn without overwriting the edit; keep two people named Mara distinct when identity is ambiguous; recall the correct character after many turns; fork before her introduction and prove she is absent; export/import and preserve identities, edits, and source links; prove a foreign campaign cannot read or refer to any record.

Additional delivery evidence: serialized-provider-payload tests, malformed/timeout extraction without story loss, retries without duplicate identities, correction invalidation, stale edit rejection, browser screenshots at desktop/mobile widths, and recorded provider-call/token counts in a separate optional live evaluation. Do not claim a live quality improvement from deterministic tests.

## Verification commands and handoff

Run focused suites named by each phase using `corepack pnpm exec vitest run ... --exclude '**/.worktrees/**' --exclude '**/.codex/**'`. Database suites must use `--config vitest.integration.config.ts`; use the isolated integration runner where required by the test matrix. Browser suites use `corepack pnpm exec playwright test <file>` with the repository's disposable-runtime setup. Run affected type/build scripts from the execution checkout's `package.json` and `git diff --check`.

Each phase ends with a short handoff under `docs/review/campaign-cast/phase-NN.md`: changed files, exact contract exports, migration numbers, gates/defaults, RED/GREEN evidence, PostgreSQL/browser results, screenshots, rollback behavior, and acceptance-gate status. Record skipped checks with reasons. Never stage unrelated work.

Implementation is a separate request. These documents do not authorize rollout, production backfill, or changes to live campaigns.
