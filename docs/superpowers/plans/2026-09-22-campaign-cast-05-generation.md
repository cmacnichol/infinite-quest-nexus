# Campaign cast phase 05: generation context implementation plan

> **For agentic workers:** Implement task-by-task with strict TDD. Use `superpowers:subagent-driven-development` when delegation is selected; otherwise execute natively. Do not start a later phase in this patch.

**Goal:** Make relevant discovered characters and user corrections influence story generation reliably within the existing context budget.

**Architecture:** Capture a versioned cast authority snapshot with the existing generation base. Resolve cast aliases into Chronicle identities, select compact scene-relevant profiles, and bind the exact serialized cast evidence to continuity review and commit checks.

**Tech Stack:** TypeScript, Zod, PostgreSQL, Story Engine context planner, Vitest.

**Spec:** [Shared specification](2026-09-22-campaign-cast.md). Dependency: phase 04 accepted.

## Global constraints

Shared constraints apply. Do not grow every prompt with every profile, change image generation, or reinterpret prose relationship guidance as structured relationships. Keep RPG mechanics separation. New jobs use a new explicit generation-base/prompt identity; historical jobs retain their saved protocol and request snapshot.

## Files and ownership

- Extend `packages/domain/src/entity-references.ts`, `packages/domain/src/chronicle-memory-helpers.ts`, `packages/application/src/memory/generation-context.ts`, `packages/database/src/generation-authority.ts`, `packages/database/src/chronicle-generation-context.ts`, `packages/database/src/chronicle-context-repository.ts`, `packages/database/src/generation-execution-repository.ts`, `services/runtime/src/generation-context-planner.ts`, `packages/contracts/src/story-prompt.ts`, `packages/story-engine/src/continuity-review.ts`.
- Create `packages/domain/src/campaign-cast-context.ts` for pure selection and fiction projection; extend cast repository/lifecycle to serve captured snapshots and retrieval metadata.
- Extend `tests/unit/entity-references.test.ts`, `tests/unit/generation-authority.test.ts`, `tests/unit/generation-context-contracts.test.ts`, `tests/unit/generation-context-planner.test.ts`, `tests/unit/story-continuity-review.test.ts`.
- Add `tests/unit/campaign-cast-context.test.ts`, `tests/integration/campaign-cast-generation.integration.test.ts`; extend cast UI status and runbook only where coverage state needs explanation.

## Interfaces

```ts
type CastContextInput = {
  snapshot: CastSnapshot; direction: string; currentScene: string;
  openThreads: string[]; budgetTokens: number;
};
type CastContextSelection = {
  records: { characterId: Id; revision: number; content: string }[];
  omittedCharacterIds: Id[]; estimatedTokens: number;
  coverage: { fromTurn: number; throughTurn: number; baseTurn: number };
};
function selectCastContext(input: CastContextInput): CastContextSelection;
```

The new generation base includes `castRevision`, `castTimelineRevision`, `castFingerprint`, and captured coverage bounds. Add a new discriminated base version rather than mutating persisted v3 expectations. Evidence references identify each cast record and its underlying observations/overrides; continuity review must distinguish user authority from accepted-story evidence.

## Review focus

Returning character after a long absence; alias shared by two characters; cast lag during generation; profile explosion beyond budget; edits racing a frozen generation or recovered historical job.

## Task 1: extend identity catalog and retrieval

- [ ] Extend `EntityCatalogInput` with `campaignCharacters?: readonly CastCharacter[]` and add source `campaign`; use IDs `campaign:<uuid>`. Keep world and protagonist IDs compatible with persisted historical metadata. Export the new selector from the domain barrel.
- [ ] Test that an unknown discovery remains heuristic until admitted to the cast, then both name and accepted alias resolve to the same stable campaign ID. Shared aliases remain ambiguous; do not select both characters as if identity were certain.

```ts
expect(selectCastContext({
  snapshot: { revision: 0, boundary: { turnNumber: 4, timelineRevision: 0 },
    characters: [], trackedThroughTurn: 4, coverageStartTurn: 1,
    discoveryStatus: "current" },
  direction: "Visit Mara", currentScene: "", openThreads: [], budgetTokens: 0
}).records).toEqual([]);
```

- [ ] Consume campaign occurrences linked to world entities by phase 04; context reads must not create new identities. Keep world immutable defaults and campaign observations distinct in the fiction projection and deduplicate equivalent world/campaign references without losing provenance.
- [ ] Resolve conflicting user override versus an older canonical prose fact explicitly: the current field override is portrayal authority from its effective boundary; preserve the older fact as dated historical evidence. Include this precedence in the prompt and reviewer contracts, and test that an override does not trigger a false continuity rejection. Do not rewrite unrelated historical facts.
- [ ] Enrich Chronicle metadata for accepted source turns already carrying the discovered character. Reindex derived entity IDs for affected evidence and aliases; do not require an embedding regeneration to make lexical/ID retrieval useful.
- [ ] Preserve scoped fallback retrieval when derived metadata is behind. Indexing state cannot grant source authority or mutate the accepted ledger.
- [ ] Run entity/catalog/context unit tests RED/GREEN and commit.

## Task 2: bounded character context and freshness semantics

- [ ] Select directly named and present characters first, then characters tied to active threads, then pinned/recent relevant characters. Ignore supporting characters marked ignored. Do not include unresolved identity candidates as factual profiles.
- [ ] Begin with a cast budget of `min(3000, floor(0.10 * availableContextTokens))` inside the existing total budget, not in addition to it. Treat this as a tunable initial policy, not a proven optimum. Preserve the protagonist's existing protected authority and do not include a duplicate protagonist card.
- [ ] Serialize compact identity, relevant overrides, stable established traits, and last-known dynamic facts with their source turns. Drop whole optional fields/records deterministically when over budget; never cut a field mid-value or silently omit a user correction while including a conflicting automatic value. Surface omitted record/field counts in diagnostics.
- [ ] If tracking is behind the generation base, include current user overrides and clearly dated stable observations; omit stale dynamic `state.*` values from asserted current state. Include a coverage notice in private context and rely on the existing accepted recent-turn/Chronicle paths for intervening story events. Do not wait indefinitely, rerun narration, or claim all characters are current.
- [ ] For edits while generation is active, preserve phase 02's 409 rule. For background discovery, preserve phase 04's publication deferral. Capture the cast snapshot under existing campaign locks and verify its fingerprint at commit as defense in depth.
- [ ] Add snapshot tests for budget overflow, complete field omission, zero available cast budget, ignored characters, shared aliases, and stale dynamic location. Verify final serialized request estimates, not only the character block's estimate.
- [ ] Run focused planner/authority suites RED/GREEN; commit selection and snapshot changes.

## Task 3: exact provider payload, review, and next-turn proof

- [ ] Add a new explicit prompt/base protocol for cast-enabled jobs and backward-compatible readers. Frozen older jobs never acquire new cast context mid-retry. Include cast operation capability in the execution policy snapshot.
- [ ] Bind selected cast documents into the producing-request source manifest. Review can cite only records actually serialized; a rejected/unresolved candidate cannot supply a contradiction finding. Add cast source support to the corresponding strict schemas and review adapter tests.
- [ ] Write a composed real-PostgreSQL test with deterministic narration and extraction providers: discover Mara, accept alias evidence, apply a user correction, advance several turns, reference the alias, capture the actual outgoing request, commit, and inspect the next generation's snapshot. Assert stable ID, correct override, source turn, and no foreign campaign content.
- [ ] Add lag, failed extraction, concurrent publication deferral, historical retry, corrected narration, branch-before-introduction, oversized cast, and disabled-capability cases. Assert legacy Action and Story Direction paths either consume the new versioned cast authority correctly or remain on the explicitly disabled compatible path; do not silently claim both are supported.
- [ ] Run `corepack pnpm exec vitest run --config vitest.integration.config.ts tests/integration/campaign-cast-generation.integration.test.ts` plus affected story-continuity/generation tests and type checks. Document which play modes are enabled; basic release requires both active Story input modes to preserve their existing mechanics semantics.
- [ ] Enable `castContext` only after payload/commit/replay tests pass. Preserve existing total context ceilings; no provider configuration or campaign-budget increase is part of this phase.

## Exit gate and rollback

Basic feature complete: manual edits and automatically discovered characters reach the actual next-generation context with correct scope, evidence, budgeting, and freshness. A many-turn fixture proves returning-character retrieval but is not live prose-quality proof. Disable `castContext` for new jobs to revert to existing context selection; retain stored cast and frozen in-flight job behavior. No relationships are implemented.
