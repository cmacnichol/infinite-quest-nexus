# Story-only Campaigns Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Use `gpt-5.6-terra` for every implementation subagent. This document is a plan, not a record of completed implementation.

**Goal:** Add an authoritative Story only campaign workflow that bypasses RPG/event checks, generates relevant narrative choices, and repairs only choices when possible.

**Architecture:** Derive execution policy from the existing campaign turn-control setting and freeze it in a versioned generation-policy snapshot. Reuse the current authority, retrieval, validation, and transaction boundaries; select a short story-only orchestration path while preserving Action mechanics and historical job execution. Keep UI, transfer, export, recovery, and provider identity consistent with that policy.

**Tech Stack:** TypeScript, Zod, PostgreSQL migrations, Vitest, Playwright, native DOM clients, pnpm, PowerShell; existing supported Node version from `package.json`.

**Spec:** [Story-only campaign design](../specs/2026-09-08-story-only-campaigns-design.md). Read it before implementing any task.

## Global constraints

- Both active interfaces are mandatory deliverables: legacy Nexus management `/nexus/` and Story `/story/:campaignId`, plus new management/player surfaces under `/app/`. Neither client may retain Auto or omit the revised campaign-setting behavior. `apps/web/public/index.html` and `apps/web/public/story.html` are active legacy markup in scope; root `index.html` remains reference-only.
- Worktree: `C:/Git/InfiniteQuest/.worktrees/story-only-campaigns`; branch: `codex/story-only-campaigns`; starting commit: `977d8a53`.
- Scope is Story only. Do not redesign RPG resolution, change existing legacy prompts, or remove active legacy routes. Do not edit root `index.html`.
- Reuse the existing campaign selector: `flexible_scene` (Story Direction) selects story-only; `action_only` and `flexible_action` retain Action mechanics. Remove Auto from all active selectors and defaults; normalize old `flexible_auto` preferences to `flexible_action`. Reuse the existing selector with Action and Story Direction. Do not add a campaign mode field, selector, toggle, or conversion button.
- Existing Story Direction campaigns use the new workflow for newly queued jobs after upgrade. Old queued/recoverable jobs retain historical behavior. Changes in either direction use the existing settings save, are owner/revision-fenced and blocked by unresolved generation. Preserve dormant mechanics and pending events.
- Read `AGENTS.md`, `docs/agents/domain.md`, relevant context docs, the spec, and the task brief in every fresh worker. Read deployment/ownership guidance before migration/import work.
- Strict RED/GREEN: show the behavior test failing before production edits, then show the same test passing. Review existing tests for every changed file. Use two-space indentation and existing package boundaries.
- Preserve authoritative context, complete continuity, protected token budgets, correction precedence, stable internal identity, append/replacement fencing, independent image failures, and portable ownership rules.
- Prompt changes are versioned. Do not relabel an incompatible saved job or mutate its original snapshot. Legacy prompt identities and required snapshot keys remain compatible.
- Unit tests do not establish PostgreSQL, browser, or live-provider correctness. Report passed/failed/skipped separately.
- Do not change production data, deploy, push, or merge into main. Commit focused implementation checkpoints in this worktree when implementation is authorized. Plan preparation creates documentation only.

## Execution controller and Terra dispatch

The user selected subagent implementation; do not ask them to choose inline execution. Implementation was authorized by the user on 2026-09-08. Execute all tasks and relevant gates without repeated continuation questions; correct gaps from current source evidence and record rulings.

Run fresh Terra implementers with no inherited transcript; provide absolute paths to this plan, spec, task brief, and handoff report. The controller retains cross-task context. Use a fresh Terra reviewer after each task for both spec compliance and code quality. Use a fresh Terra final reviewer over the whole branch. This explicit model choice overrides skill defaults that suggest escalating to another model. If Terra is unavailable, report that limitation instead of silently substituting a different model.

Example dispatch shape for this environment:

```json
{
  "task_name": "story_only_t01",
  "model": "gpt-5.6-terra",
  "fork_turns": "none",
  "message": "Implement Task 1 only in C:/Git/InfiniteQuest/.worktrees/story-only-campaigns. Read AGENTS.md, docs/superpowers/specs/2026-09-08-story-only-campaigns-design.md, the plan's Global constraints, and your task brief. Run the stated RED/GREEN checks, inspect all related tests, edit only owned files, commit the scoped result, and write the handoff report. Do not edit main, publish, deploy, or spawn agents."
}
```

Use `superpowers:subagent-driven-development` task-brief/review-package helpers where available. Keep plan-specific scratch at `.superpowers/sdd/2026-09-08-story-only-campaigns/`; verify it is ignored before writing there. Ledger first line: `# SDD ledger — plan: docs/superpowers/plans/2026-09-08-story-only-campaigns.md`. Durable verification summaries belong in `docs/review/story-only-campaigns/` at final handoff; do not place raw prompts or secrets there.

Each report records task number, base/head SHA, actual files, exported interfaces, RED and GREEN commands and summaries, PostgreSQL/browser/provider status, limitations, and reviewer findings. Reviewer checks the complete task diff, not only the report. Fix through the implementer, then obtain a scoped re-review. Follow the skill's bounded review loop; no load-bearing finding may disappear without a written ruling. Preserve this requested worktree and its plan at handoff.

### Dependency and ownership order

| Task | Terra role | Requires | Shared-file handoff |
| --- | --- | --- | --- |
| 1 | contracts and policy | baseline | Owns shared mode/policy definitions and public schema additions |
| 2 | settings authority and persistence | 1 | Owns policy migration and fencing of existing settings writes |
| 3 | durable generation admission | 2 | Owns enqueue, retry, policy hydration, prompt identity |
| 4 | story-only executor | 3 | Owns worker policy gates and authoritative acceptance |
| 5 | choice validation and repair | 4 | Takes executor ownership after Task 4; bounded repair |
| 6 | portability | 2, 3, 5 | Takes campaign/turn metadata ownership after backend tasks |
| 7 | legacy UI, then new UI | 1–6 | Two fresh Terra implementers with separate surface reports; shared edits serialized |
| 8 | composed verification and performance | 1–7 | Owns composed tests, benchmark, fixtures, evidence |
| 9 | docs, release, final review | 8 | Owns product docs and release report |

Default to sequential implementers because Tasks 2–6 share large repository and runtime files. Parallelism is allowed for read-only reviews or test analysis only; never dispatch two writers to the same file. A fresh agent per task provides isolation without requiring simultaneous implementation.

One explicit independent preparation exception is Task 7H below: after Task 1 review, a Terra worker may build the new disposable browser-harness files alongside Tasks 2–6. It owns only those new test/harness files and their focused tests, never shared production code or the other implementer's fixtures. The controller serializes commits, reviews its own diff separately, and hands the result to 7A. UI implementation still waits for Tasks 1–6.

## Baseline and preparation

At plan creation, main and the new worktree started clean at `977d8a53`. A same-revision run in the main checkout passed 119 tests in seven focused suites (output, mechanics, generation contracts/executor, choice selection, workflow, and replacement UI generation). This is orientation only, not a new-worktree setup or full integration baseline. Current Docker logs yielded no retained completed-generation timing records. No live provider calls were made.

- [ ] Verify `git status --short`, `git branch --show-current`, and `git rev-parse HEAD` in the worktree. Preserve changes made after this plan.
- [ ] Install dependencies with the repository's pinned pnpm: `pnpm install --frozen-lockfile`. Do not reuse another worktree's `node_modules` through a junction. Do not modify the lockfile for this feature unless a demonstrated dependency change is required; none is planned.
- [ ] Run focused baseline with `$env:LOG_LEVEL='silent'` and the command below. Record any pre-existing failure before Task 1.

```powershell
node node_modules/vitest/vitest.mjs run --exclude '**/.worktrees/**' --exclude '**/.codex/**' tests/unit/story-output.test.ts tests/unit/mechanics.test.ts tests/unit/generation.test.ts tests/unit/generation-executor-adapter.test.ts tests/unit/web-next-story-generation.test.ts tests/unit/story-choice-selection.test.ts tests/unit/client-core/generation-workflow.test.ts
```

For each task, use the same unit command form with that task's named tests. For real database tests use `node node_modules/vitest/vitest.mjs run --config vitest.integration.config.ts <named files>` or the documented isolated runner. Never run a database suite without that configuration and claim skipped cases passed. Provision a disposable database; do not point tests at production. Resolve migration-number drift before creating a new file; at this base the latest migration is `0093_portable_source_material_authority_paths.sql`.

## Verified local test environment override

The canonical global setup forcibly provisions the shared named integration container on port 55432. For this worktree, use the verified dedicated container on localhost15439 through `tmp/story-only-test/vitest.config.ts`. It imports `vitest.integration.config.ts` unchanged except for global setup; per-file random-database isolation remains active. Use `node node_modules/vitest/vitest.mjs run --config tmp/story-only-test/vitest.config.ts <files>` for focused tests and `node tmp/story-only-test/run-all.mjs` for the full canonical file-by-file discovery sequence. These replace shared-container commands locally; do not touch another worktree's test credentials. Store only summarized results in committed evidence, never the ignored credential files.

## Task 1: Map the existing campaign setting to frozen generation policy

**Owner:** Terra contracts implementer. **Depends on:** baseline.

**Files**
- Create `packages/contracts/src/campaign-generation-policy.ts`, `packages/domain/src/campaign-generation-policy.ts`, `tests/unit/campaign-generation-policy.test.ts`.
- Modify `packages/contracts/src/index.ts`, `packages/domain/src/index.ts`, `packages/contracts/src/world-library.ts`, `packages/contracts/src/client-api.ts`, `packages/contracts/src/generation.ts`.
- Modify `packages/contracts/src/users.ts` for active profile defaults and retain historical preference decoding. Review `packages/application/src/world-campaign/{types,ports,use-cases}.ts` for inferred contract propagation and associated `tests/unit/application/world-campaign-use-cases.test.ts`.
- Tests: new policy suite, `tests/unit/generation.test.ts`, `tests/unit/campaign-state-contract.test.ts`, `tests/unit/story-settings.test.ts`.

**Interfaces**

Export the matching closed schemas as `campaignTurnControlStyleSchema`, `historicalCampaignTurnControlStyleSchema`, `storyOnlyPromptSnapshotSchema`, and `generationPolicySnapshotSchema`. The legacy policy branch permits only Action styles, not flexible_scene; historical null jobs bypass the new-policy parser and use their stored resolved mode. Do not manufacture a new policy for them.

```ts
export type CampaignPlayMode = "legacy" | "story_only"; // execution discriminator only
export type CampaignTurnControlStyle = "action_only" | "flexible_action" | "flexible_scene";
export type HistoricalCampaignTurnControlStyle = CampaignTurnControlStyle | "flexible_auto";
export function normalizeHistoricalTurnControlStyle(style: HistoricalCampaignTurnControlStyle): CampaignTurnControlStyle;
export function campaignPlayModeForControlStyle(style: CampaignTurnControlStyle): CampaignPlayMode;
export type StoryOnlyPromptSnapshot = Readonly<{
  systemSupplement: string;
  systemSupplementHash: string;
  choiceRepairSystem: string;
  choiceRepairSystemHash: string;
}>;
export type GenerationPolicySnapshot =
  | Readonly<{ version: 1; playMode: "legacy"; turnControlStyle: Exclude<CampaignTurnControlStyle, "flexible_scene"> }>
  | Readonly<{
      version: 1;
      playMode: "story_only";
      turnControlStyle: "flexible_scene";
      protocolVersion: "story-only-v1";
      prompts: StoryOnlyPromptSnapshot;
    }>;
// Contracts exports Zod schemas matching these types.
export function generationStagePolicy(mode: CampaignPlayMode): Readonly<{
  allowRpgAssessment: boolean;
  allowEventEvaluation: boolean;
  allowSceneCoverage: boolean;
}>;
```

Legacy flags are permissions, not instructions to run stages unconditionally: retain existing mode/stats/trigger guards. The existing `turnControlStyle` remains the campaign create/update/projection field. New-write schemas exclude `flexible_auto`; historical schemas retain it only for normalization. Do not introduce campaign-level `playMode`. Derive the internal discriminator using the shared pure mapping. Validate supported styles; historical absent defaults formerly selecting Auto normalize to Action. Historical jobs with null policy take the historical legacy path independently of current campaign style.

- [ ] Write RED tests for schema enum rejection, the three supported setting mappings and historical Auto normalization and historical null-policy compatibility, malformed policy rejection, and all three story-only stage permissions false; no classification stage in either active policy.

```ts
expect(generationStagePolicy("story_only")).toEqual({
  allowRpgAssessment: false,
  allowEventEvaluation: false, allowSceneCoverage: false
});
expect(campaignPlayModeForControlStyle("flexible_scene")).toBe("story_only");
expect(campaignPlayModeForControlStyle("flexible_action")).toBe("legacy");
expect(normalizeHistoricalTurnControlStyle("flexible_auto")).toBe("flexible_action");
expect(campaignTurnControlStyleSchema.safeParse("flexible_auto").success).toBe(false);
expect(campaignPlayModeForControlStyle("action_only")).toBe("legacy");
expect(generationPolicySnapshotSchema.safeParse({version: 2, playMode: "story_only"}).success).toBe(false);
```

- [ ] Run the named tests and capture the behavior/import failure.
- [ ] Implement the strict discriminated policy schema and pure stage permission function. Reuse the existing `turnControlStyle` in summary/detail/config/create contracts; export its shared schema/type where needed without adding a second authority field. New explicit policy objects must have a consistent source-style/discriminator pair.
- [ ] Extend the existing campaign settings update contract with an optional transition fence: `expectedTurnControlStyle`, `expectedActiveTurnNumber`, and `expectedStateRevision`. Require all three server-side only when `turnControlStyle` actually changes; preserve compatible unchanged-style saves. Use the existing campaign settings response and route.
- [ ] Run GREEN tests and contract/domain checks. Review all public projection fixture defaults for silent stripping. Commit `Define story-only campaign policy contracts` and report exact exports.

## Task 2: Fence the existing setting and persist job policy

**Owner:** Terra persistence implementer. **Depends on:** Task 1.

**Files**
- Create `database/migrations/0094_story_generation_policy.sql` (renumber only if occupied), `tests/integration/story-only-campaign-policy.integration.test.ts`.
- Modify `packages/database/src/world-repository.ts`, `packages/database/src/campaign-state-repository.ts`, `packages/application/src/world-campaign/{types,ports,use-cases}.ts`, `services/api/src/world-campaign-application-adapter.ts`, and `services/runtime/src/world-campaign-composition.ts` for existing settings-save fencing.
- Reserve policy-column selection in `packages/database/src/generation-execution-repository.ts` for Task 3; no worker behavior change yet.
- Tests: `tests/unit/migration-order.test.ts`, `tests/unit/world-campaign-application-adapter.test.ts`, `tests/integration/world-campaign-repository.integration.test.ts`, new integration suite.

**Interfaces:** keep `campaigns.turn_control_style` as sole campaign authority. Add nullable `generation_jobs.generation_policy` and `turns.generation_policy`; null means historical provenance, not a lookup against current campaign settings. New writes use validated snapshots. No `play_mode` column or dedicated conversion endpoint.

```sql
ALTER TABLE generation_jobs ADD COLUMN generation_policy jsonb;
ALTER TABLE turns ADD COLUMN generation_policy jsonb;
```

Add constraints for non-null policy objects with version 1 and supported source style/discriminator pairs. Story-only policies require protocol and prompt fields. Use `COALESCE(predicate, false)` so missing JSON keys cannot pass a CHECK through SQL NULL. Do not backfill historical jobs or accepted turns from today's campaign style. Normalize only campaign `flexible_auto` settings and profile `defaultTurnControlStyle` Auto values to `flexible_action`; preserve every other setting. Update creation/profile schema defaults formerly set to Auto. Retain old job/turn modes, classification audit rows, and frozen prompt snapshots unchanged.

- [ ] Add RED migration tests showing only existing campaign/profile Auto defaults normalized to Action, all other settings/state/turns unchanged, and old policy null. Add malformed non-null policy rejection.
- [ ] Add settings-update tests for owner isolation, stale expected style/turn/revision, and blocking unresolved queued/running/recoverable jobs. Cover Story Direction -> Action and Action -> Story Direction, plus unchanged-style saves while other compatible settings change.
- [ ] Run RED under the isolated integration configuration.
- [ ] Implement the additive migration and shared style mapping. Existing creation requests continue sending only `turnControlStyle`; omitted setting uses Action where the previous default was Auto; existing explicit Action/Story Direction defaults remain unchanged. A new campaign explicitly using `flexible_scene` gets story-only policy when its opening job is queued.
- [ ] Update the existing settings transaction: lock campaign/current state in enqueue-compatible order; if style differs, require the expected fences and no unresolved generation; update the existing style, invalidate only this campaign's active model chains, and record the setting change. Preserve stats, triggers, pending events, history, and unrelated settings. Do not add a separate conversion operation.
- [ ] Test switching back makes preserved pending events eligible only under normal existing rules on a subsequent legacy-policy job; the settings save itself must not fire or consume them.
- [ ] Race-test settings changes versus enqueue from separate transactions. Exactly one ordering wins; no job receives a partially changed policy. Returning an original job for an idempotency replay remains valid.
- [ ] Run GREEN PostgreSQL, migration-order, application and type checks. Commit `Fence campaign turn-control changes and persist job policy`.

## Task 3: Freeze policy at enqueue and preserve protocol identity

**Owner:** Terra generation-admission implementer. **Depends on:** Task 2. Own the complete backend classifier retirement here; Task 7 removes client consumers and verifies closure, not a second backend implementation.

**Files**
- Create `packages/story-engine/src/story-only-prompt.ts`, `tests/unit/story-only-prompt.test.ts`.
- Modify `packages/database/src/generation-repository.ts`, `packages/database/src/generation-execution-repository.ts`, `packages/database/src/prompt-repository.ts`, `packages/domain/src/campaign-generation-policy.ts`, `packages/story-engine/src/index.ts`.
- Modify `services/api/src/server.ts` for the retired route and its owner-scoped 410 tests. Remove active `packages/story-engine/src/turn-intent.ts` exports/callers and classifier request/application/provider dispatch in this task; keep historical schema data only.
- Modify `services/runtime/src/provider-turn-intent-adapter.ts` and `packages/application/src/providers/{ports,types,use-cases}.ts` to retire active classification dispatch. Cover it with `tests/unit/provider-intent.test.ts` and the provider/route integration harness.
- Trace/update application generation collaborator contracts through `packages/application/src` and `services/runtime/src/generation-api-composition.ts`/`generation-worker-composition.ts` when signatures change.
- Tests: `tests/integration/generation-repository.integration.test.ts`, `tests/unit/generation-authority.test.ts`, `tests/unit/prompt-library.test.ts`, `tests/unit/provider-request-budget.test.ts`, new prompt suite.

**Produces**

```ts
export function storyOnlyPromptSnapshot(): StoryOnlyPromptSnapshot;
export function generationPolicyIdentity(policy: GenerationPolicySnapshot): string;
export function generationExecutionProtocolIdentity(
  legacyIdentity: string, policy: GenerationPolicySnapshot
): string; // legacy returns legacyIdentity unchanged
export function composeStoryOnlySystemPrompt(
  baseSystemPrompt: string, policy: Extract<GenerationPolicySnapshot, {playMode: "story_only"}>
): string;
```

Use existing SHA-256/stable-stringify utilities; verify frozen text against stored hashes. `generationPolicyIdentity` includes policy version and both exact template hashes. The policy supplement contains the spec's input/choice requirements and an explicit reminder that trigger rules and hidden mechanics are inactive. Keep `PromptSnapshot` required keys and legacy RUNTIME_KEYS hashing unchanged. No new required prompt-catalog keys in this phase. Retain the frozen `turn_intent` snapshot field/hash solely as compatibility data, including inert snapshot construction if necessary to preserve the legacy hash algorithm. Filter it out of active prompt listing/edit/preview APIs and reject new overrides; preserve stored historical overrides without evaluating them. Do not introduce a live classifier to produce that inert field. Tests must distinguish frozen snapshot compatibility from active catalog visibility.

- [ ] Write RED tests proving legacy execution identity remains byte-for-byte equal, story-only differs, supplement changes invalidate story-only identity, and malformed hash fails before provider dispatch.

```ts
expect(generationExecutionProtocolIdentity("legacy-fixture", {version: 1, playMode: "legacy", turnControlStyle: "flexible_action"}))
  .toBe("legacy-fixture");
expect(generationExecutionProtocolIdentity("legacy-fixture", policy)).not.toBe("legacy-fixture");
```

- [ ] Add RED real enqueue/replacement/retry tests: new policy derives from the locked campaign style and is captured with prompt/context snapshot; already-existing flexible_scene campaigns enter the new path on new enqueue; missing historical policy stays legacy; later turn-control setting edits do not alter job policy; arbitrary client mode fields cannot enable mechanics; new Auto/classification-bearing requests reject before dispatch; historical classification provenance remains readable; original idempotency replay returns the original job without a second insert.
- [ ] Preserve owner-scoped idempotency lookup and original request-fingerprint checks before rejecting deprecated Auto/classification fields for a new job. Do not narrow the HTTP compatibility envelope so early that a matching replay of an old queued Auto request cannot reach that lookup. Such a replay returns only its original job without provider/classifier work; the same key with changed request content still conflicts, and a fresh key with deprecated input is rejected. Compute the original request fingerprint before campaign-policy normalization. Cover append and replacement through the actual API boundary as well as repository tests.
- [ ] Run RED; implement enqueue policy under the existing campaign lock for both append and replacement. After rejecting deprecated Auto/classification input on new requests, normalize story-only valid explicit input-mode fields to `requested=scene`, `resolved=scene`, `source=explicit`, classification null. The campaign policy is the provenance explaining this normalization. Preserve legacy validation exactly.
- [ ] Preserve the original request fingerprint for idempotency collision detection, and use the persisted normalized request and immutable policy for execution. Do not replace a saved fingerprint when the campaign turn-control setting changes.
- [ ] Retire `/api/v1/campaigns/:campaignId/turn-input/classify` for every campaign: remove its application/provider dispatch and replace it with an owner-scoped safe 410 `turn_input_classification_removed` response for stale clients (or remove the route if compatibility tests establish a clear refresh error). It must not resolve a provider, generate text, or write a classification record. New generation requests containing `requestedInputMode: auto`, classified/fallback sources, or classification IDs fail with actionable refresh/use-campaign-setting guidance; preserve historical job decoding.
- [ ] Add policy to execution payload types, SQL projections, row parsing, persisted draft/recovery compatibility, and model-chain scope. Historical null maps legacy; malformed new values stop with a safe actionable policy/protocol error. Retry checks composed protocol identity and must not regenerate or overwrite policy/supplement text from current source.
- [ ] Compose the exact story-only system prompt before estimating protected envelopes and final request budgets. Test a supplement-induced overflow fails before dispatch without truncating authority. Keep legacy prompt override acknowledgement semantics; incompatible overrides still fail explicitly.
- [ ] Add policy-null historical Action/Scene/Auto job resume fixtures and a newly queued Action-policy retry/reclaim case. Historical protocol/hash identity stays unchanged; new Action jobs may retain the legacy protocol string only because exact policy identity is additionally included in chain/context and saved-draft compatibility. Compare frozen policy, never current campaign style.
- [ ] Run GREEN and existing recovery/identity tests. Commit `Snapshot story-only execution policy at enqueue`.

## Task 4: Route story-only jobs through the short worker path

**Owner:** Terra execution implementer. **Depends on:** Task 3.

**Files**
- Modify `services/runtime/src/generation-executor-adapter.ts`, `packages/database/src/generation-execution-repository.ts`, `packages/domain/src/campaign-generation-policy.ts`.
- Create `tests/integration/story-only-generation.integration.test.ts`; extend `tests/unit/generation-executor-adapter.test.ts`, `tests/integration/generation-execution-repository.integration.test.ts`.

**Consumes:** validated `job.generationPolicy`, stage policy, composed prompt and existing context/commit contracts. **Produces:** story-only execution with zero RPG/trigger/coverage calls and immutable mechanics fields in accepted state.

- [ ] Add RED mock-provider tests with stats, before/after triggers, pending events, and scene input all configured. Reject every operation other than `story_generation`; return a valid four-choice fixture. Assert one provider call and accepted narration/state.

```ts
expect(operations).toEqual(["story_generation"]);
expect(commit.story.choices).toHaveLength(4);
```

Define `operations: string[]` in the test harness and populate it from the actual `storyOperation` at the collaborator/provider dispatch boundary. Do not assert a field that production never supplies. `commit` is the captured accepted-turn repository call from the existing executor harness.

- [ ] Add RED cases for opening turn, append, replace-latest, failed image provider, malformed narrative JSON, output limit, cancelled lease, duplicate workers, and old legacy jobs. Assert exact legacy operation sequences remain unchanged.
- [ ] Implement narrow policy branches around current assessment, before/after event evaluation, pending-event guidance, scene coverage, extension, and event-repair blocks. Do not fork the whole executor or change legacy mechanics formulas. Derive effective event inputs as empty only for prompt/orchestration; retain original stored settings for acceptance.

```ts
const stages = generationStagePolicy(job.generationPolicy.playMode);
const effectivePendingEvents = stages.allowEventEvaluation ? inputs.pendingEventTriggers : [];
const effectiveEventTriggers = stages.allowEventEvaluation ? inputs.eventTriggers : [];
```

- [ ] Audit commit state construction: story-only acceptance must preserve original RPG stats, trigger counters, pending events, and related private state, not replace them with empty effective arrays. Fictitious successful rolls and coverage results are forbidden. Save policy to `turns.generation_policy` and corresponding model metadata; saved narration/choices come from the final validated story.
- [ ] Inspect captured serialized story-only requests for leaked trigger conditions, pending-event instructions, private stats, or inactive mechanics guidance from context assembly. Remove those operational fields from the policy-specific fiction projection while preserving mandatory world rules, ordinary narrative goals, and existing diegetic tracker sanitization. Test the actual wire request, not just an intermediate empty event array.
- [ ] Add real database assertions comparing mechanics/pending JSON before and after a turn and replacement. Verify correct canonical updates, supersession IDs, open-thread replacement, scoped fiction-memory writes, and unchanged foreign campaign records.
- [ ] For story-only acceptance, preserve the raw `campaign_state` mechanics values read under the commit transaction's authority lock: `rpg_stats`, `event_triggers`, and `pending_event_triggers`. Use those same values in the accepted turn's private snapshot. Do not reconstruct them from `orchestrationInputs`, whose parsers normalize/drop fields and whose replacement path reads an older base snapshot. Cover Action turn -> switch to Story Direction -> replace latest, with distinct current versus base mechanics: current dormant mechanics stay unchanged, while fictional continuity still follows the existing replacement rules. Skipping these column updates in the story-only SQL branch is preferable to round-tripping them through active mechanics parsers.
- [ ] Add resume fixtures carrying unexpected old event orchestration under story-only policy: fail with incompatible provenance or clear only an uncommitted invalid checkpoint through explicit recovery; never execute the dormant event or promote its draft. Validate a normal story-only reclaimed job resumes its saved draft.
- [ ] Keep local narrative validation, current authority check before commit, streaming preview semantics, and independent illustration enqueue unchanged. No raw private data goes to progress logs.
- [ ] Run GREEN unit and real PostgreSQL suites; commit `Bypass mechanical orchestration for story-only turns`.

## Task 5: Validate story-only choices and repair only their fields

**Owner:** Terra choice-repair implementer. **Depends on:** Task 4. Exclusive executor ownership transfers from Task 4.

**Files**
- Create `packages/story-engine/src/story-only-output.ts`, `tests/unit/story-only-output.test.ts`, `tests/integration/story-only-choice-repair.integration.test.ts`.
- Modify `packages/story-engine/src/story-only-prompt.ts`, `packages/story-engine/src/index.ts`, `services/runtime/src/generation-executor-adapter.ts`, `packages/database/src/generation-execution-repository.ts`, `packages/contracts/src/generation.ts` for private checkpoint types.
- Review `packages/story-engine/src/output.ts`, `provider-request.ts`, `providers.ts`, and `services/runtime/src` text-provider operation mapping before adding the repair operation; preserve legacy parser behavior.
- Tests: new output/repair suites, `tests/unit/story-output.test.ts`, `tests/unit/generation-executor-adapter.test.ts`, `tests/unit/provider-request-budget.test.ts`.

**Produces**

```ts
export type ChoiceFields = Pick<StoryTurnOutput, "choices" | "custom_action_suggestion">;
export type StoryWithoutChoices = Omit<StoryTurnOutput, keyof ChoiceFields>;
export type StoryOnlyParseResult =
  | {ok: true; story: StoryTurnOutput}
  | {ok: false; kind: "choices"; base: StoryWithoutChoices;
      reasons: readonly ("missing" | "count" | "length" | "duplicate" | "mechanics")[]}
  | {ok: false; kind: "story"; failure: StoryParseResult & {ok: false}};
export function parseStoryOnlyOutput(content: string): StoryOnlyParseResult;
export function parseChoiceRepair(content: string): ChoiceFields;
export function mergeChoiceRepair(base: StoryWithoutChoices, fields: ChoiceFields): StoryTurnOutput;
```

Validate non-choice fields using the same underlying field constraints and mechanics checks as current full output. Refactor shared field definitions only if necessary; do not weaken required complete replacements. `parseChoiceRepair` is strict: extra fields such as narration or facts are rejected. `mergeChoiceRepair` constructs the complete object locally and runs full story-only validation, preserving all non-choice values. It never accepts a partial object as a complete turn.

- [ ] Write RED tests for duplicate choices, duplicates of custom suggestion, missing/count/length defects, mechanics-bearing choices, and mixed narrative-plus-choice errors. NFKC/case/whitespace duplicates fail; genuinely different options pass. Include punctuation/word-order variants as quality-corpus cases, not an invented semantic-equality guarantee.

```ts
const base = {
  narration: "The gate closes behind you.", scratchpad: "", tracker_updates: [],
  image_prompt: "", continuity_summary: "You are inside the courtyard.",
  canonical_facts: [], superseded_facts: [], canonical_fact_updates: [], open_threads: []
};
const parsed = parseStoryOnlyOutput(JSON.stringify({
  ...base, choices: ["Wait.", " WAIT. ", "Listen.", "Look around."],
  custom_action_suggestion: "Study the gate."
}));
expect(parsed).toMatchObject({ok: false, kind: "choices", reasons: ["duplicate"]});
const fields = parseChoiceRepair(JSON.stringify({
  choices: ["Wait.", "Listen.", "Look around.", "Study the gate."],
  custom_action_suggestion: "Describe the courtyard."
}));
const merged = mergeChoiceRepair(base, fields);
const {choices, custom_action_suggestion, ...preserved} = merged;
expect(preserved).toEqual(base);
expect(() => parseChoiceRepair(JSON.stringify({...fields, narration: "Changed"}))).toThrow();
```

- [ ] Run RED, implement local validators, and retain existing per-field length limits (2,000 characters) plus four-choice count. Use prompts for concise wording; do not shrink schema limits without measured justification.
- [ ] Build repair input from validated fiction-only authority and preserved final narration. Omit raw rejected response, choices containing mechanics, diagnostic strings, stats, and provider reasoning. Use closed reason codes to select trusted instructions. Return exactly `choices` and `custom_action_suggestion`. Validate the actual provider request budget; do not allow a huge copied context to defeat the intended small repair.
- [ ] Add private `choiceRepair` checkpoint with version, policy identity, base hash, protected-base fields, original producing request hash/response metadata, consumed attempt, repair request hash, result fields/hash, and status. Extend existing checkpoint validation and automatic-repair fence rather than creating an unbounded retry counter. Record fence before provider dispatch and persist valid result before commit.
- [ ] Use a distinct bounded `story_choice_repair` operation through existing text-provider dispatch/cost/diagnostic allowlists. It is stateless and its response ID must not replace the narrative chain. Preserve original sent canonical fact IDs for accepted non-choice fields; choice-repair context cannot authorize additional fact changes.
- [ ] Add RED composed tests: malformed choices lead to exactly one story call plus one repair call; all non-choice fields and original fact authority survive; hostile extra fields rejected; mechanics never enter repair prompt; quota survives lease reclaim; crash before/after repair persistence; output-limited repair remains recoverable; explicit retry can resume saved valid repair; failure commits no turn or Chronicle changes.
- [ ] Verify shared workflow's first recoverable auto-retry cannot silently bypass the consumed repair fence. Add a closed recovery reason/projection only if needed to stop automatic re-dispatch; expose a useful safe retry message without private diagnostics.
- [ ] Run GREEN unit/real PostgreSQL suites and legacy repair regressions. Commit `Repair story-only choices without rewriting narration`.

## Task 6: Preserve mode through portable archives and campaign copies

**Owner:** Terra portability implementer. **Depends on:** Tasks 2, 3, 5.

**Files**
- Modify `packages/contracts/src/archives.ts`, `packages/contracts/src/system-archives.ts`, `packages/domain/src/legacy-campaign-normalization.ts`, `packages/database/src/campaign-archive-export-repository.ts`, `services/runtime/src/campaign-archive-export-composition.ts`, `packages/database/src/portable-import-family-repository.ts`, `packages/database/src/system-archive-export-repository.ts`, `packages/database/src/system-archive-import-repository.ts`, `packages/application/src/system-archives/portability-registry.ts`, `packages/database/src/campaign-transfer-character-repository.ts`, `packages/database/src/campaign-state-repository.ts`.
- Update consumers of manifest schemas through `services/api/src/archive-io.ts`, archive previews, and application portable import adapters; do not assume `safeExtend` still applies after introducing a versioned union.
- Tests: `tests/unit/archive-contracts.test.ts`, `tests/unit/system-archive-contracts.test.ts`, `tests/unit/system-archive-portability.test.ts`, `tests/integration/campaign-archive.integration.test.ts`, `tests/integration/system-archive.integration.test.ts`, `tests/integration/campaign-transfer.integration.test.ts`.

**Version contract:** current campaign export is manifest v1 with campaign payload v3. New campaign exports use manifest v2 with payload v4 retaining the existing `settings.turnControlStyle`, adding a format semantics marker `generationPolicyVersion: 1`, and carrying portable per-turn policy provenance. No independent campaign playMode is exported. New readers retain v1/v3 support and retain their saved turn-control style using existing historical defaults when absent. Future jobs use the shared setting mapping; imported historical turns are never retroactively relabeled. Require the setting and semantics marker in the new format; unknown values are errors. Unchanged world payloads/assets retain their content schema versions.

Current System Archive has record/data versions v1 and v2 while its shared manifest base is v1. Introduce manifest v2 plus System data/record envelope v3 for new exports; reuse unchanged domain record shapes under the new envelope. Campaign v3 records retain the existing turnControlStyle and add the generationPolicyVersion marker; turn records carry source-setting/execution provenance. Keep v1/v2 readers unchanged and normalize historical missing policy to legacy only inside compatibility adapters. Old strict manifest readers must reject the new artifact before applying records. Do not silently redefine v2 by adding a field that may be stripped or misread.

Define a strict `portableAcceptedGenerationPolicyProvenanceSchema` in contracts: null denotes historical unknown/unrecorded execution policy (required field, not an absent property in new exports); otherwise a closed version-1 union requires a consistent Action/legacy pair or flexible_scene/story_only pair and an exact known protocol identifier. Never invent a policy for historical turns based on current settings. Reject unknown versions/protocols, contradictory pairs and extra fields. Keep this schema distinct from runtime policy snapshots. Add tamper, missing-field, and fingerprint regressions. Store only portable accepted provenance such as `{version: 1, playMode, turnControlStyle, protocolVersion: string | null}` in archive turns. Do not export raw job policy prompt texts, repair checkpoints, response chains, credentials, or operational jobs. Reconstruct runtime policy for newly generated turns from the retained campaign turn-control style and destination snapshots, not source job data.

For imported historical turns, leave the full runtime `turns.generation_policy` column null and preserve the validated portable provenance in the existing portable turn/model-metadata mapping. Do not manufacture missing prompt snapshots to satisfy the runtime policy schema. Public/export projections distinguish this imported provenance from a locally executed full policy; a new generation job always receives a new complete snapshot. Include provenance in fingerprints so import cannot silently erase it.

- [ ] Add RED compatibility fixtures: historical campaign/System fixtures retain style and historical turn provenance; their future jobs use the same setting mapping; new story-only fixtures retain the setting, dormant events/stats, accepted history, and portable provenance; omitted/unknown new style or semantics marker rejects; simulated old manifest schema rejects a new export.

```ts
expect(oldManifestV1Schema.safeParse(newManifestV2Fixture).success).toBe(false);
expect(importedCampaign.turnControlStyle).toBe("flexible_scene");
expect(campaignPlayModeForControlStyle(importedCampaign.turnControlStyle)).toBe("story_only");
expect(importedPendingEvents).toEqual(exportedPendingEvents);
```

Use an immutable historical schema fixture copied from the current manifest contract for the first assertion; do not call the upgraded parser and label it an old reader.

- [ ] Run RED; implement versioned decoding before DB insert; update manifest writers, declared payload versions, reader dispatch, validation errors, canonicalization/hash inputs, allowlists, and portability registry. Keep `campaigns.turn_control_style` as portable authority and include the new format semantics marker; classify runtime `generation_policy` fields separately from accepted portable provenance.
- [ ] Preserve the setting through all campaign clone/fork and world-transfer paths, including retained-source defaults and cross-world transfer fingerprints. The new world cannot change source turn-control style. Old raw JSON uses its saved style or the existing import default, and new jobs use the shared mapping. New payload v4 must not pass through a converter that drops the setting or accepted provenance.
- [ ] Verify owner remapping, foreign owner rejection, atomic import rollback, repeat import/fingerprint behavior, and no secret or operational policy text in archives. Preserve existing archive naming and System Archive/Disaster-Recovery terminology.
- [ ] Add old archive/profile fixtures containing Auto; normalize campaign and default-setting Auto to Action on import while retaining accepted turn/job historical requested/resolved modes and classification provenance. New exports contain no active Auto campaign/default setting. Retain historical intent-role profile/audit data without enabling new classification work.
- [ ] Run GREEN portability/transfer suites on isolated source and empty destination databases. Commit `Preserve story-only policy in portable campaigns`.

## Task 7: Update both legacy and new campaign/player interfaces

**Required scope:** update both clients in this feature. The instruction to leave the reference-only root `index.html` untouched does not exempt the served legacy UI. Terra 7A owns the legacy changes; Terra 7B owns the new UI changes and verifies that its shared-code edits preserve the legacy behavior. Neither task may defer its client to the later RPG revamp.

### Task 7H: Independent disposable runtime harness preparation

**Owner:** fresh Terra harness implementer; requires Task 1 contracts. Own only `tests/helpers/story-only-runtime-fixture.ts`, `tests/helpers/story-only-synthetic-provider.ts`, `scripts/story-only-ui-runtime.ts`, `playwright.story-only-runtime.config.ts`, and new focused tests under `tests/unit/story-only-runtime-harness.test.ts`. Do not edit shared production code, existing fixtures, or implement either UI in this preparation task.

Windows execution requires a Linux runtime: the production secure filesystem adapter deliberately rejects Windows. Add a test-only `tests/helpers/story-only-runtime.Dockerfile`, its matching `.dockerignore`, and a narrowly scoped bootstrap helper if needed. Run the actual API/worker in an owned disposable Linux container with Linux dependencies; never bypass the platform guard. Keep provider traffic inside that runtime/network. Explicitly validate the dedicated PostgreSQL target before translating its transport address for the container, and never restart/recreate the dedicated PostgreSQL container used by other tests. Own and clean up the runtime container, unique database and temporary network connections. A TS/tsx test image may run before the final production type-check gate is green; this does not satisfy or weaken that final build gate.

- [ ] Write failing tests for target validation (dedicated localhost test DB only), synthetic response sequencing and safe operation summaries, readiness/terminal-state polling, and cleanup restricted to resources created by this harness. Reuse existing test/application factory interfaces; inspect their actual signatures before writing adapters.
- [ ] Capture RED, implement the harness lifecycle described below, and capture GREEN. Configure ports and credential paths explicitly; never provision the shared integration container or call a live model. Teardown must stop owned child processes and drop only the uniquely named database created by this run; failure before startup must still clean up safely.
- [ ] Verify one isolated startup/readiness/shutdown smoke check against the current implementation. Label this as infrastructure evidence only, not story-only or cross-interface acceptance. Report commands and exact created/disposed resources without secrets or raw prompts. Changes needed later for final generation contracts belong to 7A.
- [ ] Have a fresh Terra reviewer check the bounded task diff, then hand off interfaces and commands to 7A. Keep all full UI/screenshot gates below pending until both implementations run against this harness.

**Owners:** fresh Terra legacy-UI implementer (7A), then fresh Terra new-UI implementer (7B). **Depends on:** Tasks 1–6. The controller supplies the shared behavior contract to both. Assign shared helper edits to 7A first and review its handoff before 7B starts. 7B completes the cross-client cleanup gate after both surface changes are present.

**Files**
- Modify `apps/web-next/src/campaign-editor-api.ts`, `campaign-editor-model.ts`, `campaign-editor-page.ts`, `story-player-model.ts`, `story-player-page.ts`, `story-player-view.ts`, `story-player-generation.ts`, `story/quiet-leaf-presenter.ts`, `story/ui/input-mode.ts`, `story/ui/composer.ts`.
- Modify shared `packages/client-core/src/story-input.ts`, `packages/client-core/src/generation/projection.ts` and campaign projection types only where policy must be propagated; use the existing client-web campaign settings API with transition fences.
- Legacy UI required modifications: `apps/web/src/story.js`, `apps/web/public/nexus.js`, `apps/web/public/index.html`, and `apps/web/public/story.html`. Update campaign creation/edit selectors, both legacy profile dialogs, player controls/help/confirmation markup, and obsolete intent-provider setup wording/controls. Include `apps/web/public/story.css` and `apps/web/public/nexus.css` only for affected or orphaned styles. This is full behavior parity, not merely an older-client fallback. Leave root `index.html` alone.
- New UI additional required files: `apps/web-next/src/app-shell.ts`, `apps/web-next/src/user-profile-menu.ts`, `apps/web-next/src/preferences/profile-editor.ts`, and `apps/web-next/src/world-editor-model.ts`. Cover both profile render paths and persisted settings validation, in addition to the campaign/player files above.
- Surface-specific tests: `tests/unit/story-player-ui.test.ts`, `tests/unit/story-player-composition.test.ts`, `tests/unit/legacy-provider-modal.test.ts`, `tests/unit/user-profile.test.ts`, `tests/unit/web-next-user-profile-menu.test.ts`, and `tests/unit/web-next-input-mode.test.ts`. Review tests associated with both served legacy markup files and their scripts.
- Tests: `tests/unit/web-next-campaign-editor.test.ts`, `tests/unit/web-next-story-generation.test.ts`, `tests/unit/web-next-choices.test.ts`, `tests/unit/story-choice-selection.test.ts`, `tests/unit/client-core/generation-workflow.test.ts`. Create `tests/unit/story-only-player.test.ts` and `tests/e2e/story-only-campaigns.e2e.test.ts`.
- 7A owns the shared disposable browser harness: create `tests/helpers/story-only-runtime-fixture.ts`, `tests/helpers/story-only-synthetic-provider.ts`, `scripts/story-only-ui-runtime.ts`, and `playwright.story-only-runtime.config.ts`; hand them off to 7B and Task 8. Reuse `playwright.quiet-leaf-runtime.config.ts` and `tests/e2e/quiet-leaf-runtime.e2e.test.ts` for existing same-campaign route checks. The ordinary Vite/mock Playwright setup is insufficient for this gate.

**Produces:** the same existing campaign input-style selector in creation/management, with Story Direction selecting the short workflow; one narrative composer for those campaigns. No new setting, toggle, or conversion button. Action mechanics remain unchanged; remove Auto from every active selector and default.

### Required behavior in both interfaces

| Surface | Legacy (7A) | New UI (7B) | Acceptance |
| --- | --- | --- | --- |
| Campaign selector | Nexus creation and campaign settings | Campaign overview/editor and existing creation entry points | Reuse existing control; Story Direction selects story-only; Action preserved; Auto absent |
| Profile default | Nexus and Story profile dialogs | App-shell profile and preferences editor | Auto absent; historical Auto loads as Action; save/reload consistent |
| Input and choices | Served Story markup and story.js | Story-player view and quiet-leaf presenter/composer | Story-only shows Continue story without turn-type override; Auto absent for every campaign; choices follow campaign setting |
| Removed classifier UI | Auto help, decision region, intent-provider setup | Auto help, confidence/fallback state, classification calls, setup link copy | No classifier request or selectable intent-classifier setup remains |
| Settings transitions | Existing Save campaign flow | Existing Save campaign flow | Same revision fences, conflict feedback, refreshed setting, preserved draft |
| Recovery and history | Existing legacy controls | New controls and both renderer variants | Old jobs resume with saved semantics; accepted content remains intact |

### Shared UI acceptance checklist

Before browser checks, build both served web roots. The harness must create a uniquely named disposable database through the dedicated PostgreSQL test instance, migrate and seed it through existing application/test helpers, start a localhost synthetic compatible text provider, and run the actual API plus worker on a dedicated available port (proposed 18081). Set explicit database, web roots, asset/archive directories, test credential key and network allowlist; never inherit production defaults or use port 8080/shared database port 55432. Do not reset the dedicated base database. Poll readiness and accepted-job state; no fixed sleeps as correctness evidence. Pass the same fixture campaign id to both browser pages through ignored runtime state. Capture only safe provider operation/count summaries. The harness owns child processes and teardown of its own database and files. Run desktop/mobile Playwright projects with `reuseExistingServer: false`; preserve sanitized screenshots before teardown. 7B reuses this harness, and Task 8 extends its scenarios instead of creating a second runtime.

Run this checklist independently for 7A and 7B; include a result for every row in each surface's handoff report. Both clients ship in the same feature release, with the existing campaign setting as their common authority.

- [ ] Creation and settings retain the existing Action / Story Direction selection and explain Story Direction as story-only, without RPG or automated goal/event checks. No Auto option, second mode setting, or conversion control appears.
- [ ] Existing Story Direction campaigns load the story-only composer immediately after refresh. Typed input, generated choices, custom suggestions, keyboard submission, and automatic choice submission all honor the campaign setting; a saved per-turn preference cannot override it.
- [ ] Historical Auto campaign/profile preferences display Action after normalization in every relevant dialog. Removing Auto does not remove the separate automatic choice-submission preference.
- [ ] Switching between Action and Story Direction through the existing save flow refreshes the displayed controls in either UI. Unresolved-job and stale-revision errors preserve draft text and explain why the setting was not saved.
- [ ] Story-only hides inactive mechanics controls while preserving stored mechanics and historical results. Action campaigns retain their current mechanics behavior; RPG redesign remains deferred.
- [ ] Verify the same campaign in both interfaces against the same server, including changes saved from either interface, desktop/mobile layouts, both new Story renderers, and zero classification requests after actual submission. Record separate screenshots and outcomes; an unverified UI blocks feature acceptance.

- [ ] **7A RED/GREEN:** implement all legacy cells, add focused DOM/API tests, verify `/nexus/` and `/story/:campaignId` in a disposable browser, and capture legacy screenshots. Hand off shared helper changes, actual files, and test evidence. A pass in the new UI cannot close this gate.
- [ ] **7B RED/GREEN:** implement all new-UI cells, including both profile render paths and both Story presenters. Verify `/app/` management and `/app/story/:campaignId`, capture new-UI screenshots, and rerun shared helper plus legacy surface regressions after edits. Where the new UI links to existing management, verify that destination instead of building an unrelated duplicate creation/provider page.
- [ ] **Cross-interface gate:** save Story Direction in legacy management, open the same disposable campaign in the new player and verify policy; then save Action in the new editor and verify the legacy player after refresh. Repeat with profile defaults, removed Auto preferences, multi-choice drafts, and setting-save conflicts. Use the same server/fixture campaign; isolated frontend mocks do not establish parity.
- [ ] Report legacy management/player, new management/player, profile paths, and new renderer variants separately as passed/failed/skipped. Capture desktop/mobile screenshots under `docs/review/story-only-campaigns/screenshots/legacy/` and `docs/review/story-only-campaigns/screenshots/new/`, identifying route, renderer, viewport, and fixture. Task 7 is incomplete if either active UI is unverified.
- [ ] Include a per-client cleanup inventory in the 7A and 7B handoffs: removed Auto options/defaults, automatic turn-type selection handlers, classifier requests, confirmation/help markup, and now-unused styles/tests. Identify historical compatibility references separately so retained provenance readers are not mistaken for active selection logic. The final Terra reviewer must reconcile both inventories with the cross-interface browser evidence before accepting Task 7.

- [ ] Write RED model/DOM tests for story-only selection, no intent call on typed text or choice click, no mode buttons/confirmation, `Continue story` button, retained draft and multi-selection, preserved auto-submit preference, and campaign-switch isolation. Test both replacement presenters, not only the visible default renderer.

```ts
expect(root.querySelectorAll("[data-input-mode]")).toHaveLength(0);
expect(root.textContent).toContain("Continue story");
expect(requestedUrls.some(url => url.endsWith("/turn-input/classify"))).toBe(false);
```

Use an HTTP transport spy for the retired classification URL and the mounted player harness, rather than retaining a production classifier dependency only for the test. These assertions follow submitting a nonempty action and selecting a generated choice, not an idle render.

- [ ] Run RED and add a shared pure composer policy derived from the campaign `turnControlStyle` using Task 1 mapping. Story only submits explicit scene fields compatible with Task 3; stale stored UI mode cannot override it. New settings projections must reach the presenter after the existing setting is saved; clear only obsolete intent confirmation, never the user's draft.
- [ ] Reuse the existing campaign overview turn-control selector and Save campaign action. Add concise help explaining that Story Direction disables RPG and automated event checks; Action retain current behavior. Submit the existing turnControlStyle plus transition fences when changed. Preserve drafts on conflict, refresh the campaign projection, and never add a second selector or conversion action.
- [ ] Reuse the existing campaign creation selector and values. Selecting its Story Direction option sends `turnControlStyle: "flexible_scene"`; no playMode request field. Retain profile preference seeding but normalize stored Auto to Action; remove the Auto option from creation, settings, profile and player controls. Keep explicit Action/Story Direction choices. Do not build an unrelated creation wizard.
- [ ] Hide misleading mechanics/trigger editing controls while story-only; retain read-only historical/private inspection where already appropriate. Do not delete saved configuration. Keep response length, context, artwork and cancellation/retry behavior.
- [ ] Update both active `/story/:campaignId` and `/app/story/:campaignId` behavior. An older external client receives a clear rejection for removed Auto/classification requests; explicit requests remain constrained by server normalization. Preserve current-behavior UI and explicit mode selection for legacy campaigns.
- [ ] Run GREEN DOM/workflow tests. Run browser checks against a disposable runtime: select Story Direction in the existing selector -> generate -> choice -> refresh/resume -> settings conflict -> switch to Action -> switch back, desktop and mobile, keyboard/Enter/multiselect, auto-submit on/off, history and replacement, both active routes and both replacement renderer build variants. Capture screenshots under `docs/review/story-only-campaigns/screenshots/` using sanitized fixtures.
### Required cleanup gate: remove automatic turn-type selection

This is client cleanup and cross-layer verification within Task 7, completed by Terra implementer 7B after 7A and Task 3 finish. All backend classifier removal listed below is owned and completed by Task 3; 7B verifies it and reports any residual dependency rather than duplicating the work. Both workers remove their surface-specific classifier code; 7B verifies the shared dependency cleanup. Do not leave the feature hidden behind a flag or mark this cleanup complete with comments alone.

**Cleanup targets**
- `packages/story-engine/src/turn-intent.ts` and its active exports: remove classifier prompt construction/parsing once callers are removed.
- `services/runtime/src/provider-turn-intent-adapter.ts`: remove active adapter and composition wiring. Task 3's route tombstone remains provider-free.
- `packages/application/src/providers/{ports,types,use-cases}.ts`: remove live classification command/view/port/use-case and required intent dependency; preserve historical portable role types only where needed.
- `packages/client-web/src/api-client.ts`, shared client ports, `apps/web-next/src/story-player-page.ts`, `story-player-model.ts`, and `apps/web/src/story.js`: remove classifier calls, Auto fallback/confirmation branches, confidence displays, and obsolete state/events. Preserve drafts and explicit mode behavior.
- Profile/settings UI and provider configuration: remove Auto defaults and dedicated intent-classifier assignment/health/test controls. Remove live intent-specific resolver branches when unused; do not delete stored provider profiles, credentials, or historical cost entries.
- `packages/contracts/src/generation.ts`, `prompt-library.ts`, `packages/database/src/prompt-repository.ts`: remove active classification request APIs and prompt editing/preview entry points; isolate historical schemas and frozen `turn_intent` snapshot/hash entries required for old-job compatibility. Never remove a frozen key in a way that invalidates old recoverable jobs.
- `tests/unit/turn-intent.test.ts`, `tests/unit/provider-intent.test.ts`, related route/client/provider tests: replace obsolete live-classifier expectations with retirement, stale-client rejection, historical-resume, profile migration and no-classification-provider-call tests. Keep historical fixtures needed to prove compatibility.

- [ ] Write RED tests for absence of Auto in all active controls, persisted Auto preference -> Action, zero classifier calls for both Action and Story Direction, retired endpoint behavior, no classification DB writes, and resume of a previously queued Auto job using its stored resolved mode.
- [ ] Run RED; remove the dead active code/dependencies above. Keep automatic choice submission and response repair unchanged.
- [ ] Search `rg -n 'classifyTurnIntent|TurnIntentClassification|turn-input/classify|flexible_auto|turn_intent' apps packages services tests`. Classify every remaining match in the handoff as required historical decoding/hash/retirement test or remove it. There must be no live classifier dispatch or selectable Auto value.
- [ ] Run GREEN server/client tests, profile/creation migration and archive regressions, and Action RPG regression tests. Verify no extra provider requests were introduced by retirement error handling.
- [ ] Record retained compatibility-only code and why it remains. Classification tables/audit retention and eventual frozen-format removal are a separate schema-retirement concern; do not drop them here.

- [ ] Run affected client checks/build and browser suite. Commit `Simplify controls for story-only campaigns`.

## Task 8: Prove end-to-end integrity, call counts, and latency boundaries

**Owner:** Terra verification implementer. **Depends on:** Tasks 1–7.

**Files**
- Create `tests/helpers/story-only-generation-fixtures.ts`, `tests/fixtures/story-only/quality-cases.json`, `scripts/benchmark-story-only.ts`, `tests/unit/story-only-benchmark.test.ts`, `docs/review/story-only-campaigns/verification.md`.
- Extend new story-only PostgreSQL/browser suites and existing `tests/integration/generation-budget-growth.integration.test.ts` where policy adds prompt tokens.
- Update `services/runtime/src/generation-executor-adapter.ts` only for bounded safe stage telemetry needed by the benchmark; retain current phase logs and operation names.

**Benchmark interface**

```text
pnpm exec tsx scripts/benchmark-story-only.ts --warmups 3 --samples 20 --seed story-only-v1 --output tmp/story-only-benchmark
```

The script creates and disposes its own dedicated test database through the existing isolated test provisioning pattern. Refuse production/shared database targets. Use a deterministic mock text provider, fixed context fixtures, zero-delay and fixed-delay (100 ms/request) scenarios. Do not invent a provider tokenizer or interpret wall time from mocks as actual model speed. Record Node/PostgreSQL versions, seed, call counts by operation, failures, p50/p95, and request/output token estimates. Label estimated and provider-reported tokens separately.

The fixture helper exports `createStoryOnlyFixture({playMode, scenario})` and `runStoryOnlyFixture(fixture)` for benchmark and integration use. Scenarios: `clean`, `events_configured`, `choice_repair`, `invalid_narration`, `output_limited`, `lease_reclaim`; results contain `{operations: string[], committed: boolean, timingsMs: Record<string, number>, beforeState, afterState}`. Capture actual operation dispatch via collaborator instrumentation. Use neutral fictional test data only.

- [ ] Write RED composed cases asserting clean Story only has exactly one narrative call; events_configured also has one; choice_repair has exactly two; legacy mode retains the corresponding existing call sequence. Do not assert elapsed time alone.

```ts
const result = await runStoryOnlyFixture(createStoryOnlyFixture({playMode: "story_only", scenario: "events_configured"}));
expect(result.operations).toEqual(["story_generation"]);
expect(result.afterState.pendingEventTriggers).toEqual(result.beforeState.pendingEventTriggers);
expect(result.committed).toBe(true);
```

- [ ] Write RED benchmark test with a synthetic timing source proving percentile calculation, failure counts, and distinct operation groups; do not write a test that merely snapshots a printed table.
- [ ] Implement fixtures/benchmark and run GREEN. Compare legacy Action/no-stats/no-events, legacy Scene, legacy event-heavy, and new Story only. Report when baseline already uses one call: do not claim a saved request there.
- [ ] Include integrity scenarios: cross-owner/campaign isolation; corrected continuity; canon IDs; limits without truncation; unchanged RPG/pending state; append/replacement; duplicate submissions; competing worker lease; cancellation; crash after main draft and after repair; retry under frozen mode; image failure; old/new export roundtrip; settings-change/enqueue race.
- [ ] Create 12 quality cases covering dialogue, explicit multi-beat direction, established mystery, absent character, completed goal, changed location, contradictory requested outcome versus world rule, ambiguous action, dormant event, custom suggestion duplication, Unicode duplicate, and choice-only repair. Each record has `id`, fiction authority, input, required/forbidden claims, and expected available next developments. Assertions on supplied/mock output are validator evidence only.
- [ ] Evaluate live output only in an explicitly selected disposable provider/campaign environment. Score each of 12 cases on direction fidelity, continuity, next-choice relevance, distinctness, and mechanics absence (0/1/2 rubric). Require no mechanics or authority violation, no score 0, and at least 90% of the maximum across dimensions before claiming live quality readiness. If live access/use is not authorized, record skipped and leave that release gate open; complete all other work.
- [ ] Run required aggregate checks once after changes stabilize:

```powershell
pnpm test:unit --exclude '**/.worktrees/**' --exclude '**/.codex/**'
pnpm test:integration
pnpm check
pnpm build
pnpm exec playwright test tests/e2e/story-only-campaigns.e2e.test.ts
git diff --check
```

Use configured browser project/base URL for the disposable instance, never the user's active campaign. If the broad integration runner includes unrelated pre-existing failures, report them separately with exact output; do not count skipped database checks as passes. Keep all fixture logs and generated benchmark output out of production and public artifacts.

- [ ] Save summarized verification and benchmark results, screenshots index, actual limitations, and comparison base/head. Commit `Verify story-only integrity and request reduction`.

## Task 9: Document behavior, rollout, and complete independent review

**Owner:** Terra documentation implementer, then fresh Terra final reviewer. **Depends on:** Task 8.

**Files**
- Modify `docs/player-guide/actions-and-choices.md`, `docs/player-guide/turn-input-modes.md`, `docs/concepts/generation-integrity.md`, `docs/workflows/testing.md`, `docs/runbooks/deployment.md`.
- Add `docs/architecture/story-only-campaign-policy.md` as a scoped ADR-style decision document and link it from appropriate architecture navigation; update `CONTEXT.md` only if the glossary needs to clarify existing Story Direction semantics.
- Complete `docs/review/story-only-campaigns/verification.md` with release limitations and operator checklist.

- [ ] Cross-check each product statement against final code and screenshot evidence. Correct old docs that claim every choice forcibly switches to Action; describe legacy/current behavior separately from Story only. Explain dormant pending events, the changed semantics of existing Story Direction selections for new jobs, setting changes in either direction, repair, and the removed independent scene-fidelity check.
- [ ] Document migrations and versioned archive readers/writers, immutable job policy, safe unknown-version failure, Auto-to-Action migration, the retired classification endpoint, and old-worker incompatibility. Deployment is coordinated: stop intake, drain/resolve old work, apply additive schema, deploy compatible API/workers, run disposable canaries, then resume intake. No mixed old-worker pool may claim story-only jobs. This is a hard deployment prerequisite: stop intake; drain/cancel unresolved jobs; stop old workers and verify zero old worker processes/leases; migrate and deploy compatible workers/API/UI; run one disposable canary and inspect its operation list; only then resume intake. A new-worker capability check cannot fence an old binary that ignores it. Before rollback, resolve all new-policy jobs and stop compatible workers before any old binary may start. Record evidence of the drained pool in the operator checklist; deployment itself is not part of this implementation.
- [ ] Document rollback: stop intake, resolve new-policy jobs, retain additive schema/accepted data, keep compatible readers, and restore legacy behavior only for legacy campaigns. No bulk mode reset, pending-event deletion, automatic down migration, or restoration over newly accepted history.
- [ ] Run `pnpm --filter @infinite-quest/docs build`, local link validation, and `git diff --check`. Resolve documentation build failures introduced by changed schemas/examples or navigation. Commit `Document story-only campaign workflow and rollout`.
- [ ] Controller packages whole-branch diff from `977d8a53`, spec, all task reports, verification evidence, and parked findings for a fresh Terra reviewer. Require review of authority boundaries, policy immutability, pending-state preservation, prompt/repair provenance, portability versions, legacy regression, and UI screenshots.
- [ ] Fix actionable findings through a Terra implementer and rerun affected checks before scoped re-review. Finish only when no unresolved load-bearing issue remains; explicitly report any release-only gate such as unrun live quality evaluation.
- [ ] Deliver branch/worktree, final commit SHA, exact tests, benchmark caveats, screenshots, design deviations, and remaining release steps. Preserve worktree; no push, PR, merge, or deployment unless separately requested.

## Final acceptance matrix

| Requirement | Owning tasks | Required evidence |
| --- | --- | --- |
| Server-owned Story only mode, legacy compatibility | 1–3 | schema tests, real existing-setting/enqueue races, legacy identity fixtures |
| Auto UI and active classifier code removed | 1–3, 6, 7 | all-surface absence, stale-client errors, zero dispatch, old-job resume, cleanup search ledger |
| No stats/intent/goal/event/coverage work | 3, 4, 7, 8 | captured provider operation list with all mechanics configured |
| Pending state preserved | 2, 4, 6, 8 | JSON equality across append/replacement/import |
| Four grounded distinct directions | 3, 5, 8 | parser regressions plus separately labeled quality rubric |
| Choice-only repair preserves narration and authority | 5, 8 | durable recovery tests and complete non-choice field equality |
| Job/chain/retry identity remains frozen | 3–5, 8 | altered-policy, crash/reclaim, stateless-repair tests |
| Normal authority/continuity/isolation intact | 4, 8 | real PostgreSQL failure/correction/cross-campaign cases |
| Both legacy and new management, profile and player interfaces | 7A, 7B, 8 | separate RED/GREEN and browser reports, desktop/mobile screenshots, cross-interface save/reload, both new renderer variants |
| Existing selector reuse with no new campaign UI setting | 2, 7 | management/API conflict tests and visible explanation |
| Portable policy and historical readers | 6, 8 | new roundtrip, old reader rejection, old format normalization |
| Speed claims measurable and bounded | 8 | operation counts, p50/p95, fixture/provider metadata |
| Safe coordinated release and rollback | 9 | source-checked runbook, version notes, final reviewer gate |

## Planning self-review record

- Contract producer/consumer order: Tasks 2–9 consume Task 1 setting-to-policy mapping and policy types; Task 3 owns exact prompt/identity names; Tasks 4–5 consume them without redefining legacy identity.
- Shared-file conflicts: Task 2 -> 3 -> 4 -> 5 serializes execution-repository ownership; Task 4 -> 5 serializes executor; Task 6 follows persistence changes; Task 7 follows schema finalization; Task 8 may add telemetry only after executor ownership is released.
- Mode wording: internal legacy does not imply RPG; flexible_scene selects story-only while Action values retain current mechanics; historical Auto normalizes to Action and active classification is removed. No new campaign setting or conversion control is included; both directions use the existing selector. Strict checking remains deferred.
- Repair safety: a partial repair response is merged locally into validated preserved fields and revalidated; it is never persisted as a complete replacement by itself.
- Historical prompt compatibility: no required new keys in old strict PromptSnapshot; no broad protocol bump for unchanged legacy jobs.
- Archive safety: explicit outer manifest and payload versions prevent silent downgrade; accepted provenance is portable, raw operational policy/checkpoints are not.
- Planning verification is document/link/path validation only. Task checkboxes remain unchecked until implementation evidence exists.
