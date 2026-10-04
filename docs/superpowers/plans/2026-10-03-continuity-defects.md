# Continuity defects implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> This document is a plan, not authorization to implement, commit, or publish. Follow the execution method the user authorizes. Do not dispatch subagents merely to review this plan.

**Goal:** Fix loss of retrieved facts after protected-fact allocation and duplicate tracker state caused by name-only model updates.

**Architecture:** Keep the existing durable generation workflow and provider contracts. In the planner, suppress fact duplicates only after determining which facts are transmitted. In the domain layer, resolve tracker update identity deterministically, then apply the same projection at the guarded commit boundary without rewriting raw candidate evidence.

**Tech Stack:** TypeScript, PostgreSQL, Zod, Vitest, Playwright, Node.js, repository-pinned pnpm.

**Spec:** [Story generation and continuity audit, Actions A1 and A2](../../review/2026-10-03-story-continuity-audit.md). Audited revision: `94853d2d859f57b8a75bb69edd532c016570dffa`. Implementation baseline: `1374688c` (`origin/main` on 2026-10-03). Between those revisions, upstream changed `generation-execution-repository.ts`, `generation-executor-adapter.ts`, `chronicle-context-repository.ts`, `generation.integration.test.ts`, and `generation-integrity-diagnostics.e2e.test.ts` (provider-failure and Activity lifecycle diagnostics). The audited planner and tracker-merge code is unchanged; both defects still reproduce at the new baseline.

## Global constraints

- Scope is A1 and A2 only. Do not enable feature flags, redesign RPG mechanics, revise timelines, or change illustration timing.
- "A **turn** is append-only after acceptance." Do not alter historical accepted rows as part of either fix.
- "Only validated, accepted output may mutate campaign state."
- "Every campaign-owned row and memory record must be scoped by `campaign_id`; reusable canon must be scoped by `world_id` and `world_version_id`."
- "Rolls, dice, checks, stats, scores, targets, modifiers, difficulty labels, parser diagnostics, rejected output, and internal reasoning must never enter story narration, story memory, embeddings, or fiction-only prompt history."
- Preserve complete authority records separately from bounded prompt context.
- Preserve exact provider responses, candidate hashes, producing-request identities, review receipts, and raw tracker-update evidence.
- Keep current provider tracker objects open. Do not introduce a closed tracker schema or require new provider fields.
- No prompt wording, prompt-protocol version, database schema, deployment, dependency, or secret changes are planned. The one permitted contract change is adding `tracker_update_identity_invalid: "repair_authority"` to `diagnosticActionByCode` in `packages/contracts/src/story-prompt.ts` (Task 4). It adds a recovery-diagnostic code, not a provider-output or prompt-protocol field.
- Do not automatically merge or delete pre-existing duplicate trackers. Historical cleanup requires a separately reviewed operation. Campaigns that already contain legacy duplicates must keep generating (see the legacy tie-break in Task 3).
- Follow two-space indentation and existing TypeScript conventions.
- Read [domain guidance](../../agents/domain.md), [scene-context/mechanics note](../../architecture/scene-context-mechanics-review.md), and [testing matrix](../../workflows/testing.md) before implementation.
- Use the exact `packageManager` in the worktree's package.json. Do not weaken version checks to work around a local toolchain problem.
- Record unit, PostgreSQL, browser, and live-provider evidence separately.

## Review focus

| Failure mode | Expected behavior | Owning task |
| --- | --- | --- |
| A fact is captured but omitted from protected allocation, including a fact from the latest turn | It remains eligible for optional transmission when verified and budgeted | Tasks 1 and 2 |
| Reviewer limit is smaller than writer limit; excerpt retry repacks candidates | Both limits hold; deduplication follows actual final evidence | Tasks 1 and 2 |
| Corrections explicitly remove facts, or fact text no longer matches its source | The selection fix does not resurrect or authorize invalid facts | Task 2 |
| Trackers share a display name, or one tracker's ID equals another's display name | Exact IDs remain authoritative; name-only updates use the defined legacy tie-break among display-name matches or fail without accepted writes when still ambiguous | Tasks 3 and 4 |
| A campaign already holds a legacy duplicate pair created by this defect (`location`/`Location`, both named "Location") | Name-only updates resolve to the duplicate whose ID equals the name, matching pre-fix routing; generation does not start failing | Tasks 3 and 4 |
| An update uses only legacy aliases (`label`/`title`, `currentValue`, `updateRules`) | The aliased field is applied, not shadowed by the existing tracker's canonical field | Task 3 |
| A saved candidate has nested tracker fields, an explicit Keep receipt, or is reclaimed after interruption | Raw evidence remains byte/content-equivalent and only one accepted state transition occurs | Task 5 |

## Worktree and execution preparation

The documents were prepared in the managed worktree:
`C:/Users/chris/.codex/worktrees/story-continuity-audit/InfiniteQuest`.

It was created at the audited revision with a detached HEAD and then moved, still detached, onto `origin/main` at `1374688c`. If implementation is authorized, create or select an appropriate `codex/` branch in this worktree before committing. Do not reset the main checkout. If `origin/main` moves again before implementation starts, rebase first and re-check the target files listed below.

- [x] Confirm revision, worktree status, applicable instructions, and whether another task has changed any target files.
- [x] Restore only the pinned locked dependencies if needed; use `--frozen-lockfile`.
- [x] Establish an executable baseline for affected suites. Do not relabel the prior audit's unit run as a new-worktree run.
- [x] Resolve the isolated PostgreSQL prerequisite without deleting shared volumes or changing production credentials. The audit's test setup failed with password authentication for `infinitequest_test`. Use a dedicated disposable test environment; never print its credentials.
- [x] Read the existing planner, history-protected-fact, tracker normalization, generation, and nested-tracker review tests before editing.

The initial two workstreams can be implemented independently. Land them as separate reviewed commits where practical. Commit instructions below apply only after implementation is authorized.

## Workstream A Fix final fact selection

### Task 1 Deduplicate facts against transmitted authority

**Files**
- Modify: `services/runtime/src/generation-context-planner.ts`.
- Test: `tests/unit/generation-context-planner.test.ts`.
- Review associated tests: `tests/unit/story-history-facts.test.ts`, `tests/unit/story-history-reservation.test.ts`, `tests/unit/story-evidence-spans.test.ts`.

**Interfaces**
- Preserve the public signature and return shape of `planGenerationPromptContext`.
- Inputs remain `MemoryGenerationAuthorityContext`, frozen context policy, writer/reviewer serializers, and existing limits.
- Outputs remain `promptContext`, `contextPlan`, `sourceManifest`, and `layerDiagnostics`.
- Keep candidate identity as canonical fact UUID plus verified source content. Never manufacture a new ID for a retrieved fact.

**Design decisions**

The current early candidate filter conflates captured fact IDs with sent fact IDs. Keep source validation and same-source candidate deduplication early, but move cross-layer canonical-fact suppression to the point where selected protected/current authority is known.

For history-coverage contexts:
1. Preserve eligible canonical-fact candidates until protected selection completes.
2. Derive sent fact IDs from the selected protected blocks and canonical facts actually present in the serialized mandatory/current authority. Do not use the full captured source arrays.
3. Exclude optional canonical-fact candidates only when the same verified fact is actually represented there.
4. Apply recent/latest-turn deduplication to duplicated narration evidence, not indiscriminately to canonical facts from those turns. A narrative record and an independently useful fact are not interchangeable.
5. Keep candidate-to-candidate deduplication deterministic.
6. Cover the reachable non-history excerpt-retry path with serializer capture: an initially retained whole parent is omitted on the retry pass, then its certified excerpt is packed while selected-authority fact deduplication remains intact. History-coverage v5 keeps its existing early certified-excerpt selection behavior; do not add a post-omission v5 retry, since that packing path does not produce retry omissions.

Scope note: the early filter (`generation-context-planner.ts`, the `candidates` `.filter` after excerpt selection) runs whenever `layered` is true, not only for history coverage. In layered contexts without history coverage, `protectedFactRecords` is empty, but the `baseTurnId` exclusion and `currentContinuity.canonicalFacts` dedupe still apply. Gate changes from steps 1–4 on `historyCoverage`, or cover the layered non-history case with its own test proving the same defect.

Preserve non-history protocol behavior except where a new test proves the same selection/identity defect. Do not change quotas, rank fusion, canonical fact source loading, or supersession rules.

- [x] Add `retains a retrieved fact omitted from protected allocation`: construct the synthetic 41-fact case, an 8,000-token campaign limit, a 7,900-token writer input limit, and a high-ranked older gate/key fact. Assert the fact is not selected as protected, is selected as Chronicle, and appears once in the final provider user payload.
- [x] Add a control with that older fact absent only from the protected source pool. Assert both final payloads retain its retrieved evidence.
- [x] Add `deduplicates a fact actually sent as protected authority`: sufficient budget, same fact in both sources, exactly one final representation.
- [x] Add `does not discard an omitted canonical fact solely because its turn is recent`: cover latest-turn and selected-predecessor sources, keeping real narration duplicates suppressed.
- [x] Add cases for empty selected fact set, all facts fitting, no Chronicle candidates, stable ordering, and a non-history frozen policy.
- [x] Run the focused planner test and confirm the new recall assertion fails on the baseline because the older candidate disappears. A fixture setup failure is not the expected red result.
- [x] Implement selection-aware filtering in the planner. Verify the reachable non-history excerpt retry with captured serialized requests; separately label history-coverage v5 coverage as early excerpt selection, without introducing a new v5 retry behavior.
- [x] Assert `duplicate_source` applies only to a fact represented elsewhere; budget omissions retain `context_limit` or `request_limit`. Final manifest and sent-ID extraction must agree with the wire payload.
- [x] Run the focused tests and existing planner boundary suites. Confirm no quota or unrelated serialization changes.
- [x] Review the scoped diff and commit as `Fix Chronicle fact deduplication after context selection`.

**Commands**
```sh
corepack pnpm exec vitest run tests/unit/generation-context-planner.test.ts tests/unit/story-history-facts.test.ts tests/unit/story-history-reservation.test.ts tests/unit/story-evidence-spans.test.ts --exclude '**/.worktrees/**' --exclude '**/.codex/**'
git diff --check
```

Expected: all executed cases pass, including previously failing recall cases; existing protocol fixtures remain unchanged unless the corrected evidence selection necessarily changes them.

### Task 2 Verify retrieval through final requests and accepted replay

**Files**
- Modify tests: `tests/integration/history-coverage-context.integration.test.ts`.
- Modify tests: `tests/integration/history-protected-facts.integration.test.ts`.
- Modify tests: `tests/integration/chronicle-historical-fact-pool.integration.test.ts`.
- Extend a composed generation case in `tests/integration/story-continuity-remediation.integration.test.ts`.
- Inspect, but change only if the new composed case proves an additional defect: `services/runtime/src/generation-executor-adapter.ts`, `packages/database/src/chronicle-context-repository.ts`, `packages/database/src/chronicle-generation-context.ts`.

**Interfaces**
- Consume the unchanged planner from Task 1.
- Exercise the existing production reservation → `loadGenerationCandidates` → final planning flow.
- Capture the actual provider request and use existing sent-fact-ID/evidence-manifest assertions.
- No new retrieval API or database schema.

- [x] Seed an owned campaign with an older verified fact and enough newer facts to omit it from protected allocation.
- [x] Enqueue a direction that retrieves the older fact. Assert that reservation excludes only actually selected facts and that the final writer request contains the older fact once.
- [x] Exercise chunked retrieval when ready and lexical fallback when embeddings/indexing are unavailable. Use existing deterministic provider fixtures; do not contact a live endpoint.
- [x] Repeat with a tighter reviewer window than writer window and review enabled. Assert both serialized request estimates plus safety allowances stay within their independent limits; no truncation of fact text.
- [x] Add a successful structured supersession of the transmitted older fact. Assert its ID was sent, the accepted fact lifecycle changes once, and the next request sees the new current fact. Reject a control supersession ID that was not sent.
- [x] Include a foreign-campaign canary, a future fact, an inactive fact, a source-invalid fact, and an explicit empty correction. Assert none can be revived by the relaxed candidate filter.
- [x] Verify the source arrays, accepted snapshots, and stored fact text were not mutated by planning.
- [x] Run each affected integration file in a fresh Vitest process using the dedicated integration configuration.
- [x] Review test realism and commit as `Cover retrieved fact recall through generation and replay`.

**Command pattern**
```sh
corepack pnpm exec vitest run --config vitest.integration.config.ts tests/integration/history-coverage-context.integration.test.ts
```

Repeat separately for each integration file listed above. Success requires cases to execute against real PostgreSQL; absent database configuration or a successful process containing skipped database cases is not a pass.

## Workstream B Fix tracker identity at acceptance

### Task 3 Add a pure identity-aware tracker projection

**Files**
- Modify: `packages/domain/src/campaign-trackers.ts`.
- Modify: `packages/domain/src/index.ts` only if needed to expose the new symbols through its existing export convention.
- Test: `tests/unit/campaign-trackers.test.ts`.

**Interfaces**
```ts
export class CampaignTrackerUpdateError extends Error {
  readonly code = "tracker_update_identity_invalid";
  readonly reason: "ambiguous_name" | "conflicting_identity";
}

export function applyCampaignTrackerUpdates(
  current: unknown,
  updates: readonly Record<string, unknown>[]
): CampaignTracker[];
```

The error must contain no tracker values or raw model output. Its constructor accepts only the finite reason. The helper returns a new materialized array, never mutates `current` or `updates`, and does not rewrite historical snapshots.

**Resolution policy**

| Update | Required behavior |
| --- | --- |
| Explicit ID matches an existing tracker | Update that exact tracker. Preserve missing name/value/rules fields; permit an explicit name change under that ID. |
| No explicit ID, one exact trimmed name match | Update that tracker while preserving its ID and omitted fields. |
| No explicit ID, multiple exact trimmed name matches, exactly one of which has ID equal to the trimmed update name | Update that tracker (legacy tie-break). This matches pre-fix routing, which keyed name-only updates by ID, so campaigns holding a duplicate pair created by this defect keep updating the same tracker they did before. |
| No explicit ID, multiple exact trimmed name matches, none or more than one with ID equal to the name | Throw `CampaignTrackerUpdateError("ambiguous_name")`. |
| No explicit ID, no tracker has that display name, but one tracker's ID equals the name | Do not route to it by ID. Name-only updates resolve by display name only; the ID tie-break applies only among display-name matches. Create a new tracker per the "No ID, new nonempty name" row. |
| Unknown explicit ID, supplied name matches an existing tracker | Throw `CampaignTrackerUpdateError("conflicting_identity")`; do not split one named state across IDs. |
| Unknown explicit ID, new nonempty name | Preserve existing support for creating a new tracker with that ID. |
| No ID, new nonempty name | Create a tracker with the existing deterministic normalization conventions; avoid collisions with all existing IDs. |
| ID resolves to one tracker but name is another tracker's name | Exact ID remains the target. If the explicit rename introduces a duplicate display name, preserve the repository's existing ability to store duplicate names. Subsequent name-only updates use the legacy tie-break when exactly one matching tracker's ID equals that name; otherwise throw ambiguous_name. |
| Empty strings explicitly supplied for value/rules | Apply the explicit clearing; do not mistake it for an omitted field. `undefined` and `null` mean omitted. |
| Repeated updates to the same resolved tracker | Apply in array order; later explicit fields win. |
| Legacy aliases: name ← `name`/`label`/`title`; value ← `value`/`currentValue`; rules ← `rules`/`updateRules` | Resolve each update's aliases to canonical `name`/`value`/`rules` *before* identity resolution and merging, with the normalizer's precedence (first non-empty trimmed name; `value ?? currentValue`; `rules ?? updateRules`). The pre-fix spread merge let an existing tracker's `value`/`rules` shadow an update supplying only `currentValue`/`updateRules`; that silent drop is part of this defect and must not be retained. |
| Unrecognized/nested fields | Retain in raw candidate evidence; materialized state keeps the existing tracker projection only. |
| Nameless metadata-only record | Keep existing normalization behavior; do not turn unrelated raw metadata into a new tracker. |

Use exact trimmed names, case-sensitive. Do not introduce fuzzy matching, locale-dependent matching, or a historical ID migration. Maintain the existing 200-tracker bound; retain existing cap behavior in this scoped repair and document it in a regression rather than silently adding an unrelated capacity policy.

Resolve against the evolving materialized array, so a second name-only update can find a tracker created earlier in the same batch.

- [x] Add the exact Location regression from audit A2. Expected result: one tracker, ID `location`, value `Northern gate`, original rules preserved.
- [x] Add each resolution-policy row as an explicit unit case, including an existing ID equal to a different tracker's display name. After an explicit rename creates duplicate names, test a subsequent name-only update both with a qualifying ID/name tie-break and without one; only the latter throws ambiguous_name.
- [x] Add the legacy duplicate regression: current `[{id:"location",name:"Location",value:"Harbor",rules:"Track the current place."},{id:"Location",name:"Location",value:"Northern gate",rules:""}]` plus update `{name:"Location",value:"Lighthouse"}`. Expected: still two trackers; `Location` now has value `Lighthouse`; `location` is unchanged; no error. Add a control where neither duplicate's ID equals the name; expect `ambiguous_name`.
- [x] Add alias-only updates against an existing tracker (`{name:"Location",currentValue:"Gate"}`, `{label:"Location",updateRules:"New rule"}`, `{title:"Location",value:"Pier"}`). Each must apply. Also add `{id:"location",currentValue:"Gate"}`. This isolates the alias defect: on the baseline merge, the existing `value` shadows `currentValue`, leaving `Harbor`.
- [x] Assert deterministic output, unchanged inputs, aliases, explicit clearing, and cap behavior.
- [x] Run tests and confirm the baseline lacks the safe merge behavior.
- [x] Implement the helper using the existing normalizer for materialized shape and deterministic IDs.
- [x] Keep identity resolution separate from fiction/mechanics sanitization; this function does not authorize exposing private tracker content.
- [x] Run all tracker normalization and state-editor unit coverage.
- [x] Review and commit as `Resolve campaign tracker updates by stable identity`.

**Commands**
```sh
corepack pnpm exec vitest run tests/unit/campaign-trackers.test.ts tests/unit/story-state-editor.test.ts tests/unit/client-core/campaign-state-editor.test.ts tests/unit/campaign-state-contract.test.ts --exclude '**/.worktrees/**' --exclude '**/.codex/**'
```

Expected: tracker normalization, state contracts, and both state-editor suites pass without changing their existing public interfaces.

### Task 4 Apply tracker resolution inside the guarded commit

**Files**
- Modify: `packages/database/src/generation-execution-repository.ts`.
- Modify: `services/runtime/src/generation-executor-adapter.ts`.
- Modify: `packages/contracts/src/story-prompt.ts` (one `diagnosticActionByCode` entry only).
- Test: `tests/integration/generation.integration.test.ts` and `tests/integration/activity-generation.integration.test.ts` (recoverable Activity fallback and privacy).
- Test: `tests/unit/safe-generation-diagnostics.test.ts` (schema accepts the new code/action pair and rejects a mismatched action), `tests/unit/generation-executor-adapter.test.ts` (typed catch produces the `repair_authority` recovery), and `tests/unit/client-core/generation-workflow.test.ts` (projection shows a non-retryable discard).
- Review related coverage: `tests/integration/story-only-generation.integration.test.ts`, `tests/integration/campaign-state-replay.integration.test.ts`.
- Test safe status projection using existing generation adapter/diagnostic unit suites.

**Interfaces**
- Replace the private `mergedTrackers` implementation with Task 3's helper.
- Keep `commitAcceptedTurn`'s external input/output contract unchanged.
- Apply against the existing transaction-locked tracker base for append and the saved pre-turn base for replacement.
- On `CampaignTrackerUpdateError`, let the transaction roll back. The executor then uses its existing lease-fenced `markRecoverable` port with stable error code `tracker_update_identity_invalid` and fixed message: "Tracker updates could not be matched safely. Discard this attempt and resolve the tracker identity before generating again."
- Handle this typed error before the executor's generic failure branch. Do not classify it as transport failure or automatically call a provider again.
- Set `recoveryMetadata` to `{ reason: "tracker_update_identity_invalid", diagnostic: { code: "tracker_update_identity_invalid", operation: "story_generation", action: "repair_authority" } }`. The diagnostic schema is closed (`safeGenerationDiagnosticSchema` enforces the code→action map), so add `tracker_update_identity_invalid: "repair_authority"` to `diagnosticActionByCode`. Use `repair_authority` because client-core already presents it as not retryable, with "Discard this attempt, correct the campaign state…, then generate a new turn" (`packages/client-core/src/generation/projection.ts`). Do not use `discard_and_reenqueue`: re-generating against the same tracker state fails the same way. Do not add `ambiguous_name`/`conflicting_identity` to `safeDiagnosticReasonCodeSchema`; the finite reason stays in the server-side error only.
- Keep diagnostics content-free: code/reason only. Reuse generic recoverable-state presentation; do not add a raw tracker dump to polling or SSE.
- Activity uses a separate closed diagnostic vocabulary and stores `diagnostic.code` plus a fixed `diagnostic.message`; it has no `failureReason` field. Preserve the current fallback for this unrecognized tracker error: a `generation.recoverable` event with status `recoverable` and `diagnostic: { code: "generation_failed", message: "The generation could not be completed." }`. The generation job's structured recovery diagnostic retains `tracker_update_identity_invalid` and `repair_authority`. Do not extend the Activity or generation-failure diagnostic contracts; this preserves the single permitted contracts change.

The repository owns the authoritative decision. An optional earlier pure check is not a substitute for repeating it against the commit transaction's base.

- [x] Add an append integration case that starts with an explicit tracker ID and accepts a name-only update. Assert one row in both current state and the accepted snapshot, with original rules preserved.
- [x] Add replacement coverage proving the update is applied to the saved pre-turn base and failure preserves the previously accepted turn.
- [x] Add an ambiguous-name case. Assert no new accepted turn, no changed campaign state/facts/memory, no image dispatch caused by acceptance, and a recoverable job with a safe message.
- [ ] In the Activity integration suite, exercise the same recoverable tracker failure through the production mutation path. Assert event kind `generation.recoverable`, status `recoverable`, and the exact generic diagnostic code/message above. Assert the job retains its specific recovery diagnostic, while the Activity payload contains no tracker names, values, nested private fields, or raw error text. **Deferred P3:** the existing assertion does not seed tracker-value canaries; final Sol review approved the implementation and left this test-strengthening advisory nonblocking.
- [x] Add explicit-ID success despite duplicate display names and conflicting unknown-ID rejection.
- [x] Add a legacy-duplicate append case: seed campaign state with the `location`/`Location` pair and accept a name-only update. Assert the turn is accepted, the `Location`-ID tracker changes, and the tracker count stays at two.
- [x] Assert the public generation job projection and SSE/polling schemas accept the new safe error and expose no private names, values, or nested fields. Only extend a finite diagnostic enum if the existing projection requires it; retain generic privacy guarantees.
- [x] Cover a stale/expired lease when attempting to mark recoverable; the stale worker must not overwrite the new claimant's state.
- [x] Wire Task 3's helper at the commit boundary and the typed catch in the executor.
- [x] Run affected PostgreSQL files independently and the diagnostic/adapter unit suites.
- [x] Review and commit as `Apply identity-safe tracker updates at turn acceptance`.

### Task 5 Preserve saved review evidence and next-turn continuity

**Files**
- Modify tests: `tests/integration/story-continuity-review.integration.test.ts`.
- Modify tests: `tests/integration/story-context-payload.integration.test.ts`.
- Extend Story Direction coverage in `tests/integration/story-only-generation.integration.test.ts`.
- Add browser recovery case to `tests/e2e/generation-integrity-diagnostics.e2e.test.ts`.
- No provider schema, prompt catalogue, or historical snapshot rewrite.

**Interfaces**
- Consume the unchanged `StoryTurnOutput.tracker_updates` representation.
- Preserve `acceptedTrackerUpdateEvidence`, retained primary output, review candidate identity, Keep receipt, and checkpoint bindings.
- Materialize only the accepted state's tracker projection through Task 3.

- [x] Extend the existing nested-tracker/format-repair/reclaimed-review case with an existing stable ID and a name-only value update.
- [x] Assert raw primary output, nested tracker fields, candidate hash, producing-request hash, and review receipt remain unchanged by projection.
- [x] Verify explicit Keep commits the retained candidate with no additional primary or continuity-repair request.
- [x] Reclaim after a saved candidate/Keep receipt and prove exactly one accepted turn and exactly one logical tracker update.
- [x] For an initially unique tracker, verify the next actual story request's fiction-safe current-tracker projection includes that tracker once under its stable ID with the updated value and no stale value. Assert private nested and foreign-campaign canaries are absent from the full request; historical narration need not lose older mentions.
- [x] Separately replay the legacy Location pair after the Lighthouse update from Task 3. Assert accepted state and the next request's fiction-safe current trackers retain exactly two entries: ID `location` with value `Harbor` and original rules, and ID `Location` with value `Lighthouse`. Assert the prior `Northern gate` value is absent from that current-tracker projection, no third tracker is created, and private nested/foreign-campaign canaries remain absent. Do not require historical mentions to disappear or suppress the retained sibling's older value. This verifies compatibility, not resolution of the pre-existing contradiction.
- [x] Exercise Action and Story Direction. Story Direction must preserve RPG/event state while applying valid fiction-tracker updates.
- [x] Render the new recoverable tracker-identity diagnostic in both Story surfaces, verify that the `repair_authority` recovery offers discard and never retry, and capture screenshots using the existing browser-test artifact convention.
- [x] Run focused PostgreSQL and browser cases. Mocked browser cases establish presentation only; record them separately from the real commit tests.
- [x] Review and commit as `Verify tracker identity across review recovery and replay`.

**Browser command**
```sh
corepack pnpm exec playwright test tests/e2e/generation-integrity-diagnostics.e2e.test.ts
```

Expected: both surfaces render the fixed safe message and recovery behavior without exposing raw tracker evidence. No screenshot can establish a live-model quality claim.

## Task 6 Complete combined verification and review

**Files**
- Update this plan's checkboxes only for work actually completed.
- Add fresh implementation verification notes under `docs/review/`; preserve the original audit record as historical evidence.
- If implementation changes documented behavior, update only the relevant current workflow documentation.

- [x] Review every changed file's associated tests and the complete diff for unrelated behavior.
- [x] Run the full unit suite with nested worktree exclusions.
- [x] Run the full isolated PostgreSQL integration runner after focused cases pass.
- [x] Run the repository check and build scripts using the pinned package manager.
- [x] Run the focused browser diagnostics on both supported clients and retain screenshots.
- [x] Check repository data-safety and `git diff --check`.
- [x] Verify no prompt/schema/protocol/dependency/migration change slipped into the repair. The only permitted contracts diff is the single `diagnosticActionByCode` entry.
- [x] Review privacy, scope isolation, stale-authority checks, candidate preservation, and request-budget behavior together.
- [x] Record exact passed/failed/skipped counts and reasons. A blocked PostgreSQL or browser gate remains blocked; it is not satisfied by unit tests.
- [ ] If publishing is subsequently authorized, describe the concrete before/after behaviors, independent commits, validation, and rollout limitations.

**Final commands**
```sh
corepack pnpm test:unit --exclude '**/.worktrees/**' --exclude '**/.codex/**'
corepack pnpm test:integration
corepack pnpm check
corepack pnpm build
corepack pnpm exec playwright test tests/e2e/generation-integrity-diagnostics.e2e.test.ts
git diff --check
```

Do not rerun broad suites repeatedly without new changes or an unresolved failure. A toolchain or dedicated test-database failure should be diagnosed separately from application behavior.

## Completion criteria

| Defect | Required proof |
| --- | --- |
| A1 | A verified older fact excluded from protected allocation survives retrieval into the final writer/reviewer evidence when it fits; true duplicates appear once; inactive, corrected-away, future, and foreign facts remain excluded. |
| A1 authority | Structured supersession can reference the actually transmitted fact; accepted state and next-turn replay agree; budgets and raw sources remain intact. |
| A2 | Name-only update of a uniquely named existing tracker preserves its ID and rules; alias-only fields apply; ambiguity cannot commit contradictory state. |
| A2 legacy | Campaigns holding a defect-created duplicate pair keep generating; name-only updates land on the duplicate whose ID equals the name. Accepted state and the next fiction-safe tracker projection retain both stable IDs and the untouched sibling's older value, without creating a third entry. Historical duplicate cleanup remains outside this repair. |
| A2 recovery | Append, replacement, Keep, reclaim, and Story Direction preserve raw evidence and commit once. Initially unique trackers appear once with their updated value; legacy pairs follow the separate A2 legacy criterion. Unresolved identity failures expose the specific repair_authority job diagnostic and the existing generic generation_failed Activity diagnostic, without private tracker data. |
| Cross-cutting | Relevant unit, PostgreSQL, browser, type, build, and repository checks pass, with skips explicitly reported. |

## Rollout and rollback

These are code-only repairs with no planned data migration. Keep unrelated feature flags unchanged. Existing duplicate trackers are not repaired automatically. The legacy tie-break keeps them updating as before, so the fix prevents duplicate creation by name-only updates to uniquely named trackers without breaking affected campaigns. For preserved legacy pairs, both fiction-safe entries and their conflicting values can still reach the next prompt; this repair does not claim to restore their semantic consistency. Users can still consolidate a pair in the state editor.

Deploy compatible API and worker versions together under the existing runbook. Old workers still exhibit the defects; mixed-version operation is not evidence of complete remediation. Preserve queued jobs and saved candidates rather than rewriting them to match the new projection.

Rollback restores previous code behavior but does not reverse already accepted tracker updates or fact supersessions. Do not rewrite accepted history to simulate rollback. Preserve evidence and use explicit state correction or a separately authorized repair if a data issue is discovered.

## Plan self-review

- Coverage maps audit A1 to Tasks 1–2 and audit A2 to Tasks 3–5; Task 6 supplies combined gates.
- The workstreams are independently implementable and share no new runtime API.
- Stable tracker IDs are already supported by the open model output; mandatory-ID prompting is intentionally deferred.
- The plan preserves current source-verification and privacy controls while narrowing only selection/identity behavior.
- Existing evidence remains immutable; new implementation runs must supply new verification results.
- Revised 2026-10-03 after validation: rebased onto `1374688c`; added the legacy-duplicate tie-break (owner decision: prefer the duplicate whose ID matches the name), alias normalization before merge, the explicit `repair_authority` diagnostic mapping, Activity-record privacy, and the `layered` vs `historyCoverage` scope note.
- Follow-up validation corrections: specified Activity's existing generic code/message fallback without expanding its contract; separated unique-tracker recall from preserved legacy-pair compatibility; and aligned post-rename handling with the legacy tie-break. Each correction has an explicit regression requirement above.
- Scope exclusions include historical duplicate cleanup, deeper RPG mechanics, flag defaults, append-only timeline redesign, and illustration gating.

