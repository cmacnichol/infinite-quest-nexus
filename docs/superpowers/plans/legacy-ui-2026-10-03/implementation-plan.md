# Legacy UI implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task after the independent plan audit and explicit implementation authorization. Steps use checkbox syntax for tracking. This document does not authorize execution.

**Goal:** Make the active legacy UI safer and easier for desktop story reading and world/campaign setup, preserving authoritative persistence and current generation contracts.

**Architecture:** Keep the existing vanilla legacy interface and shared client/application boundaries. Introduce focused TypeScript policy/adapters through existing Vite entries, remove unnecessary requests, and add only scoped, validated read routes needed for bounded history. Do not rewrite the UI, shrink frozen contracts or change canonical state.

**Tech Stack:** Existing JavaScript/TypeScript, Vite, DOM/native dialogs, Zod, Fastify, PostgreSQL, Vitest, Playwright; Node>=22.13.0 and Corepack pnpm@12.4.1.

**Spec:** [Design specification](./design-spec.md). Executors and reviewers must read both documents.

**Baseline:**94853d2d859f57b8a75bb69edd532c016570dffa. Worktree:C:/Users/chris/.codex/worktrees/legacy-ui-implementation-plan/InfiniteQuest. Branch:codex/legacy-ui-implementation-plan.

**Status:** Independently reviewed, ready with explicit execution conditions; application implementation has not started. Independent audit outcome is recorded in [audit packet](./audit-packet.md).

## Global constraints

The design specification's Constraints section applies to every task, including:
- Desktop first; default reading one turn at a time; advanced settings tucked away.
- Preserve explicit existing continuous-reading and choice-auto-submit preferences.
- Preserve server-resolved identity, immutable world versions, append-only accepted turns, ownership scoping and generation idempotency.
- Browser drafts/preferences are presentation state, never canonical campaign/world state.
- Preserve /nexus, /story and replacement /app coexistence; root index.html is reference-only.
- Preserve existing public /turns,/state,sync-status/SSE contracts. New reader/history routes are additive.
- No prompt/worker/generation protocol changes, private content fixtures, automatic publish/migration, or credential role reuse.
- New pure policy in client-core; storage/network in client-web; DOM/focus/rendering in apps/web; backend use cases/ports in application.
- Use existing dependencies and two-space indentation; prefer TypeScript for new modules. No React migration or new framework.
- Tests associated with each changed file must be reviewed and updated. Visible changes require rendered browser evidence and screenshots.
- Skips are not passes. Documentation planning does not establish a passing runtime baseline.
- Production deployment and live-provider/billable tests are outside this planning authorization.

## Review focus

Each failure mode has concrete task coverage:
1. A late generation acceptance must not delete a newer unsent action; T08 tests acceptance_clears_matching_not_newer_draft.
2. Old campaign/world/search responses must not replace newer selection; T05,T11,T15,T26,T27 tests reverse completion.
3. Successful creation followed by refresh failure must not create twice; T20 tests refresh_failure_no_duplicate_retry.
4. Replaced/corrected turns and changed history must not restore the wrong identity or mix cursors; T10,T11,T13,T14.
5. Optional image failure/delay and optimized bootstrap must not unlock invalid generation or block accepted reading; T27,T28,T29.

## Reading order and repository references

Read AGENTS.md, docs/agents/domain.md, docs/architecture/repository-overview.md, docs/architecture/0028-modular-client-and-application-boundaries.md and docs/workflows/testing.md. Read identity-and-ownership guidance before any scope/identity change and deployment.md before static serving/cache rollout.

Current source map:
- apps/web/public/index.html: Nexus markup/dialogs.
- apps/web/public/nexus.js: management controller; T31 may move it atomically to apps/web/src/nexus.js.
- apps/web/public/nexus.css,story.css,navigation.css,tokens.css: current visual system.
- apps/web/public/story.html: Story markup; apps/web/src/story.js: orchestration/rendering.
- apps/web/src/composition.ts: Story composition/dependency injection.
- apps/web/src/story-history-loader.js: existing complete-history/export policy; preserve it for full exports.
- apps/web/src/story-keyboard.js: existing keyboard/recovery handling; avoid replacing it broadly.
- apps/web/src/legacy-management-entry.ts and legacy-client-entry.ts; apps/web/vite.config.ts: bundling.
- packages/contracts/src/users.ts,client-api.ts,world-library.ts: validated public schemas.
- packages/client-web/src/api-client.ts and storage/pending-submissions.ts,failed-turn-prompts.ts: current browser adapters.
- packages/database/src/play-loop-read-repository.ts: bounded pages/history-version semantics.
- services/api/src/server.ts: current scoped read routes/static registration.
- playwright.config.ts: dual legacy/replacement Vite web servers.

Paths under Create are proposed. Paths under Modify/Review existed at planning. If T31 moves the management source, update remaining task manifests/tests to its new authoritative path; never copy changes into two source implementations.

## Agent execution contract

This is a plan for small subagent chunks, not permission to run every task concurrently.
- Assign one task to one implementer with spec, current approved plan, dependency commits and exact file allowlist.
- A fresh reviewer receives task rationale, acceptance tests, complete diff and evidence; the implementing agent cannot approve its own task.
- Reject scope expansion, modified protocol/ownership, unexplained private fields, test-only mock passes presented as PostgreSQL proof, and stale race results.
- Shared files are exclusive locks: nexus.js,index.html,story.js,story.html,main CSS,server.ts,contracts barrels and package manifests. No two agents edit the same locked file concurrently.
- Parallel work is allowed only for disjoint pure adapters/tests; integrations are serialized by the coordinator. Avoid cherry-picking overlapping legacy-controller patches.
- Run at most two implementers plus one reviewer/coordinator where the harness has four slots. Separate managed worktrees for active implementers; the plan worktree remains the integration/review branch.
- Every task reports changed files, interface deviations, exact checks/results and commit hash. Unexpected evidence returns to plan audit rather than inventing a new architecture.
- Do not mark T28complete by implementing it without its separate approval; a documented evidence-backed deferral is an acceptable outcome.
- T32requires an operational review, but preparation/configuration tests can be completed without deployment.
- Update task checkboxes only after reviewer acceptance; commits are narrow and imperative. Commit/push/PR publication requires its own user-authorized workflow.

## Dependency and scheduling guide

IDs are stable, not a forced numeric execution order. T10 precedes T11; T14 precedes T15. Dependencies list the accepted outputs required.

| Batch | Tasks | Parallelism and gate |
| --- | --- | --- |
| Foundation | T01,T02 | T01 baseline first; T02 follows. Independent plan audit must already be accepted. |
| Loss/context fixes | T03,T04,T05,T06 | Serialize Nexus edits. T06Story-only part may run disjointly. |
| Drafts/read navigation | T07,T08,T09 | Adapter then integration then controls; T07 can run with Nexus fixes. |
| History backend | T10,T14 | Serialized backend vertical slices; independent of Nexus visual tasks. |
| Reading experience | T11,T12,T13,T15,T16 | Story files locked; integrate serially after their dependencies. |
| Authoring/create | T17,T18,T19,T20 | T19pure policy may run alongside Story work; Nexus integrations serial. |
| Management guidance | T21,T22,T23,T24 | Serialize Nexus changes; T24Story portion depends on completed Story branch integration. |
| Client performance | T25,T26,T27,T29,T30 | Nexus and Story lanes can run independently; image/stream changes after T27. |
| Optional bootstrap | T28 | Separate evidence review after baseline and early reader optimization. |
| Assets/static | T31,T32 | Management move after earlier Nexus integrations; static serving follows built output review. |
| Accessibility | T33,T34 | Integrate late with new markup, but every earlier task must already preserve accessibility. |
| Whole-branch acceptance | T35 | No overlapping implementation; fresh full review and all required gates. |

## Task-by-task packets

For every behavioral task:
- Add the specified regression case, run it and confirm it fails for the intended behavioral reason before implementing. A missing dependency/tool is not a useful failing regression.
- Keep tests behavioral; source-string assertions may support route/asset contracts but cannot prove UI behavior.
- Run unit commands from this worktree using Corepack/pnpm. Full database checks use vitest.integration.config.ts. Browser commands use Playwright fixtures and both configured builds.
- Every existing test in Files/Tests must be read before modification.
- Proposed test names below specify required assertions; implement them with deterministic time/delay/storage where relevant.
- Commit only after relevant checks and task review. If a purely visual change cannot use a meaningful failing unit test, establish its failing browser/layout/contrast observation and validate the corrected rendered result instead.

### T01: Establish deterministic fixtures and an executable baseline

**Dependencies:** None

**Why / evidence:** The audit has real request/DOM evidence but no reproducible browser timing baseline. This task makes later claims comparable and establishes the previously unavailable test environment.

**Files / exclusive ownership:**
- Create tests/e2e/helpers/legacy-ui-fixtures.ts
- Create tests/e2e/legacy-ui-baseline.e2e.test.ts
- Create scripts/benchmark-legacy-ui.mjs
- Create docs/review/legacy-ui-2026-10-03/baseline.md
- Create tests/e2e/helpers/legacy-ui-fixtures.types.ts

**Interfaces and decisions:** Fixture builder legacyUiFixture({turnCount,worldCount,campaignCount}): fixture; use turn counts0,1,50,317,2000. Route helper installLegacyUiFixture(page,fixture): Promise<{requests,writes,releaseDelayedRoute}>. Fixtures use synthetic UUIDs and sanitized prose only; do not change existing database benchmark fixture cardinalities.

**Required regression cases and assertions:**
- Existing tests/unit/story-player-ui.test.ts
- Existing tests/unit/legacy-campaign-creation-ui.test.ts
- Existing tests/unit/story-history-loader.test.ts
- Existing tests/unit/story-keyboard.test.ts
- Existing tests/unit/legacy-story-memory-ui.test.ts
- Existing tests/unit/legacy-provider-modal.test.ts
- New baseline browser: fixtures expose no private canaries; requests counted; mock writes initially zero

**Execution steps:**
- [ ] Read dependency outputs and associated tests; confirm file ownership with coordinator.
- [ ] Verify Node/Corepack/pnpm first; after implementation authorization use corepack pnpm install --frozen-lockfile only if needed. Do not change lockfile for local repair.
- [ ] Run the explicit six-suite baseline command below before instrumentation; distinguish infrastructure errors from pre-existing assertion failures.
- [ ] Add fixture/instrumentation reproducibility tests; these need not start from a product-defect failure.
- [ ] Implement deterministic mocked routes with configurable failures/delays, including startup sync, state, image and context preview; record method/path/bytes and expose writes for zero-write assertions.
- [ ] Capture route requests, DOM counts, history-open/navigation durations, browser long tasks and cold/warm asset bytes; repeat5warmups/30samples when making timing claims. Benchmark results record commit, dirty flag, build mode and fixture.
- [ ] Run the six audit suites and relevant browser baseline; record each unavailable check with its exact error. Do not start implementation against unexplained behavioral baseline failures.
- [ ] Run focused checks again; expected all selected assertions pass, no newly skipped cases. Include build/type/boundary checks when affected.
- [ ] Browser/manual proof: Capture dashboard, reader, history, world author, character editor and campaign creation at1280x800 and390x844; screenshots use synthetic content.
- [ ] Review complete scoped diff and git diff --check; obtain fresh task review; record evidence before marking accepted.
- [ ] Commit the task alone with an imperative summary, then hand dependency interface and commit hash to coordinator.

**Focused commands:**
```sh
corepack pnpm exec vitest run tests/unit/story-player-ui.test.ts tests/unit/legacy-campaign-creation-ui.test.ts tests/unit/story-history-loader.test.ts tests/unit/story-keyboard.test.ts tests/unit/legacy-story-memory-ui.test.ts tests/unit/legacy-provider-modal.test.ts --exclude '**/.worktrees/**' --exclude '**/.codex/**'
corepack pnpm exec playwright test tests/e2e/legacy-ui-baseline.e2e.test.ts
git diff --check
```

**Risk / rollback:** Environment repair must not silently update dependencies. Benchmark startup controls caches; timing from mocked requests is distinct from real PostgreSQL. Roll back this task's code commit if its acceptance fails; preserve canonical records and version-compatible draft/preferences. No automatic cleanup of user data.

**Agent handoff:** Deliver T01 only. State deviations from the approved Interfaces block explicitly; do not silently rename cross-task APIs or remove an acceptance case.

### T02: Add reusable edit-session and dismissal policy

**Dependencies:** T01

**Why / evidence:** Separate dirty-state policy from native dialog events so Escape, Cancel, backdrop and navigation cannot each invent different loss behavior.

**Files / exclusive ownership:**
- Create packages/client-core/src/edit-session.ts
- Modify packages/client-core/src/index.ts
- Create apps/web/src/legacy-edit-session.ts
- Modify apps/web/src/legacy-management-entry.ts
- Create tests/unit/legacy-edit-session.test.ts

**Interfaces and decisions:** createEditSession<T>(initial:T,equal:(a:T,b:T)=>boolean): {isDirty(current:T):boolean;markSaved(value:T):void}; apps adapter requestEditDismissal({dialog,isDirty,isBusy,save?,discard,confirm}):Promise<'dismissed'|'stayed'>. confirm returns 'save'|'discard'|'stay'; unavailable Save is not offered.

**Required regression cases and assertions:**
- dirty_after_edit_reverts_to_clean
- failed_save_keeps_dirty_baseline
- escape_cancel_backdrop_share_one_decision
- busy_dialog_stays_open
- stay_and_cancel_have_zero_writes

**Execution steps:**
- [ ] Read dependency outputs and associated tests; confirm file ownership with coordinator.
- [ ] Add the regression cases above using T01 synthetic fixtures or pure adapter tests; record expected assertions and the current failing behavior.
- [ ] Run the focused command below and record the intentional failing assertions; stop to repair infrastructure if assertions cannot execute.
- [ ] Implement pure baseline comparison using normalized form values; opening and successfully saving replace the baseline; failed save does not.
- [ ] Implement one DOM dismissal adapter that prevents native cancel, blocks dismissal while busy, obtains a decision and closes once. Confirmation must not recursively dirty the underlying dialog.
- [ ] Expose only the adapter through the existing management entry; keep DOM APIs out of client-core and browser storage out of this module.
- [ ] Run focused checks again; expected all selected assertions pass, no newly skipped cases. Include build/type/boundary checks when affected.
- [ ] Browser/manual proof: Exercise native Escape and nested dialogs with keyboard; focus returns to the initiating control after dismissal.
- [ ] Review complete scoped diff and git diff --check; obtain fresh task review; record evidence before marking accepted.
- [ ] Commit the task alone with an imperative summary, then hand dependency interface and commit hash to coordinator.

**Focused commands:**
```sh
corepack pnpm exec vitest run tests/unit/legacy-edit-session.test.ts --exclude '**/.worktrees/**' --exclude '**/.codex/**'
git diff --check
```

**Risk / rollback:** Do not replace the already-correct Story keyboard/recovery behavior. Equal comparison must not treat harmless formatting normalization as content loss. Roll back this task's code commit if its acceptance fails; preserve canonical records and version-compatible draft/preferences. No automatic cleanup of user data.

**Agent handoff:** Deliver T02 only. State deviations from the approved Interfaces block explicitly; do not silently rename cross-task APIs or remove an acceptance case.

### T03: Protect campaign settings and explain section save behavior

**Dependencies:** T02

**Why / evidence:** Campaign title edits were lost on selection. Mixed save semantics make users unsure which values are committed.

**Files / exclusive ownership:**
- Modify apps/web/public/nexus.js
- Modify apps/web/public/index.html
- Create tests/unit/legacy-campaign-edit-session.test.ts
- Create tests/e2e/legacy-ui-campaign-edits.e2e.test.ts
- Review tests/unit/legacy-story-memory-ui.test.ts

**Interfaces and decisions:** Use T02 edit session around the explicit Save campaign form. canLeaveCampaignEditor(nextCampaignId):Promise<boolean>; section feedback states 'saved'|'unsaved'|'saving'|'error'. Immediately saved memory/image sections keep their actual API semantics and independent status.

**Required regression cases and assertions:**
- switch_stay_preserves_title_and_selection
- switch_discard_does_not_write
- switch_save_waits_for_success
- save_failure_preserves_fields
- late_save_does_not_update_other_campaign
- auto_memory_save_does_not_mark_metadata_saved

**Execution steps:**
- [ ] Read dependency outputs and associated tests; confirm file ownership with coordinator.
- [ ] Add the regression cases above using T01 synthetic fixtures or pure adapter tests; record expected assertions and the current failing behavior.
- [ ] Run the focused command below and record the intentional failing assertions; stop to repair infrastructure if assertions cannot execute.
- [ ] Define exactly which controls belong to the explicit campaign-save payload; baseline them after successful selection/save, not after unrelated auto-save.
- [ ] Guard campaign selection, workspace changes and link navigation with Save/Discard/Stay; during failed Save remain on current campaign with fields intact. Use beforeunload only when unsaved data cannot be safely retained.
- [ ] Add visible section feedback distinguishing Save campaign from automatically saved memory and separately saved illustration/embedding settings. Capture selected campaign/load epoch for save completions.
- [ ] Run focused checks again; expected all selected assertions pass, no newly skipped cases. Include build/type/boundary checks when affected.
- [ ] Browser/manual proof: Edit title, switch campaign and navigate away under all three decisions; refresh and confirm failed requests remain local.
- [ ] Review complete scoped diff and git diff --check; obtain fresh task review; record evidence before marking accepted.
- [ ] Commit the task alone with an imperative summary, then hand dependency interface and commit hash to coordinator.

**Focused commands:**
```sh
corepack pnpm exec vitest run tests/unit/legacy-campaign-edit-session.test.ts tests/unit/legacy-story-memory-ui.test.ts --exclude '**/.worktrees/**' --exclude '**/.codex/**'
corepack pnpm exec playwright test tests/e2e/legacy-ui-campaign-edits.e2e.test.ts
git diff --check
```

**Risk / rollback:** Do not send auto-saved settings again through a broad save payload. Preserve existing campaign request fencing. Roll back this task's code commit if its acceptance fails; preserve canonical records and version-compatible draft/preferences. No automatic cleanup of user data.

**Agent handoff:** Deliver T03 only. State deviations from the approved Interfaces block explicitly; do not silently rename cross-task APIs or remove an acceptance case.

### T04: Apply guarded dismissal to provider and nested authoring dialogs

**Dependencies:** T02

**Why / evidence:** Provider Escape discarded edits, and nested character changes can be confused with saved world state.

**Files / exclusive ownership:**
- Modify apps/web/public/nexus.js
- Modify apps/web/public/index.html
- Modify tests/unit/legacy-provider-modal.test.ts
- Create tests/e2e/legacy-ui-dialog-dismissal.e2e.test.ts

**Interfaces and decisions:** Register provider, character and world-author dialogs with T02. Character application returns control to a dirty world-author session; label world-scoped action 'Apply to world draft'. Campaign-scoped character saves retain their authoritative meaning.

**Required regression cases and assertions:**
- edited_provider_escape_requires_decision
- cancel_and_backdrop_match_escape
- discard_provider_makes_no_api_write
- nested_character_apply_marks_world_dirty
- cancel_nested_character_keeps_parent_values
- busy_authoring_cannot_dismiss

**Execution steps:**
- [ ] Read dependency outputs and associated tests; confirm file ownership with coordinator.
- [ ] Add the regression cases above using T01 synthetic fixtures or pure adapter tests; record expected assertions and the current failing behavior.
- [ ] Run the focused command below and record the intentional failing assertions; stop to repair infrastructure if assertions cannot execute.
- [ ] Inventory every managed dialog's explicit Cancel/X, native cancel, backdrop and navigation path; classify informational, immediate-save and staged-edit dialogs.
- [ ] Attach shared policy only to actual staged-edit dialogs. Preserve world-author dirty protection and AI-authoring busy restrictions; keep parent session open when cancelling a child.
- [ ] Change nested world-character copy and parent dirty feedback; do not change underlying character persistence or generation payloads.
- [ ] Run focused checks again; expected all selected assertions pass, no newly skipped cases. Include build/type/boundary checks when affected.
- [ ] Browser/manual proof: Provider Escape, world->character->Apply->world Save, and child Cancel paths with focus restoration.
- [ ] Review complete scoped diff and git diff --check; obtain fresh task review; record evidence before marking accepted.
- [ ] Commit the task alone with an imperative summary, then hand dependency interface and commit hash to coordinator.

**Focused commands:**
```sh
corepack pnpm exec vitest run tests/unit/legacy-provider-modal.test.ts --exclude '**/.worktrees/**' --exclude '**/.codex/**'
corepack pnpm exec playwright test tests/e2e/legacy-ui-dialog-dismissal.e2e.test.ts
git diff --check
```

**Risk / rollback:** Credential inputs must never be serialized to persistent drafts, logs or screenshot fixtures. Compare masked credentials without exposing existing secrets. Roll back this task's code commit if its acceptance fails; preserve canonical records and version-compatible draft/preferences. No automatic cleanup of user data.

**Agent handoff:** Deliver T04 only. State deviations from the approved Interfaces block explicitly; do not silently rename cross-task APIs or remove an acceptance case.

### T05: Navigate to the correct world and fence selection responses

**Dependencies:** T02

**Why / evidence:** Edit in World Management left the wrong world selected; unguarded requests can overwrite newer selections.

**Files / exclusive ownership:**
- Modify apps/web/public/nexus.js
- Create tests/unit/legacy-world-navigation.test.ts
- Create tests/e2e/legacy-ui-world-navigation.e2e.test.ts

**Interfaces and decisions:** openWorldManagement(worldId:string):Promise<void>; selectWorld(worldId) uses monotonically increasing worldSelectionEpoch and optional AbortController. Every details/editor result matches id+epoch before rendering.

**Required regression cases and assertions:**
- edit_details_selects_clicked_world
- delayed_A_never_overwrites_B
- stale_error_does_not_replace_B
- dirty_stay_prevents_selection
- changed_world_invalidates_its_cache_only

**Execution steps:**
- [ ] Read dependency outputs and associated tests; confirm file ownership with coordinator.
- [ ] Add the regression cases above using T01 synthetic fixtures or pure adapter tests; record expected assertions and the current failing behavior.
- [ ] Run the focused command below and record the intentional failing assertions; stop to repair infrastructure if assertions cannot execute.
- [ ] Carry the clicked worldId through details navigation; run dirty dismissal before selecting another world.
- [ ] Keep editor disabled/loading until the target arrives; fence success and error results, and cancel superseded optional requests.
- [ ] Invalidate only affected world detail-cache entries after successful draft, cover, publish, archive, delete and import operations; no invalidation on failed writes.
- [ ] Run focused checks again; expected all selected assertions pass, no newly skipped cases. Include build/type/boundary checks when affected.
- [ ] Browser/manual proof: Use two synthetic worlds with reversed response completion; assert title/id/form match the clicked world before editing.
- [ ] Review complete scoped diff and git diff --check; obtain fresh task review; record evidence before marking accepted.
- [ ] Commit the task alone with an imperative summary, then hand dependency interface and commit hash to coordinator.

**Focused commands:**
```sh
corepack pnpm exec vitest run tests/unit/legacy-world-navigation.test.ts --exclude '**/.worktrees/**' --exclude '**/.codex/**'
corepack pnpm exec playwright test tests/e2e/legacy-ui-world-navigation.e2e.test.ts
git diff --check
```

**Risk / rollback:** Do not infer success from an aborted fetch. Deletion invalidation must not perform additional deletion or import-history mutation. Roll back this task's code commit if its acceptance fails; preserve canonical records and version-compatible draft/preferences. No automatic cleanup of user data.

**Agent handoff:** Deliver T05 only. State deviations from the approved Interfaces block explicitly; do not silently rename cross-task APIs or remove an acceptance case.

### T06: Validate remembered campaign and provide resume recovery

**Dependencies:** T01

**Why / evidence:** The reviewed remembered resume target did not exist, leaving the reader without a useful next step.

**Files / exclusive ownership:**
- Modify apps/web/public/nexus.js
- Modify apps/web/src/story.js
- Modify apps/web/public/story.html
- Create tests/unit/legacy-resume-target.test.ts
- Create tests/e2e/legacy-ui-resume-target.e2e.test.ts

**Interfaces and decisions:** resolveResumeCampaign(campaigns,rememberedId,selectedId):campaign|null; precedence valid explicit selection, valid remembered active campaign, most-recent active campaign. Archived records are available through explicit archived navigation.

**Required regression cases and assertions:**
- unknown_remembered_id_falls_back
- no_campaign_disables_resume
- failed_story_load_does_not_save_bad_id
- archived_campaign_requires_explicit_selection
- network_error_is_retryable
- not_found_has_recovery_link

**Execution steps:**
- [ ] Read dependency outputs and associated tests; confirm file ownership with coordinator.
- [ ] Add the regression cases above using T01 synthetic fixtures or pure adapter tests; record expected assertions and the current failing behavior.
- [ ] Run the focused command below and record the intentional failing assertions; stop to repair infrastructure if assertions cannot execute.
- [ ] Resolve dashboard resume only after campaigns load; show loading or empty state rather than an unvalidated URL.
- [ ] Remember a campaign only after a successful scoped load; remove an invalid remembered target without clearing other draft/reading records.
- [ ] Render persistent Story not-found/access/unavailable states with Back to campaigns and Retry where appropriate. Do not relabel403 as deleted.
- [ ] Run focused checks again; expected all selected assertions pass, no newly skipped cases. Include build/type/boundary checks when affected.
- [ ] Browser/manual proof: Open dashboard with stale ID, no campaigns and a failed network request; assert no inaccessible campaign content is shown.
- [ ] Review complete scoped diff and git diff --check; obtain fresh task review; record evidence before marking accepted.
- [ ] Commit the task alone with an imperative summary, then hand dependency interface and commit hash to coordinator.

**Focused commands:**
```sh
corepack pnpm exec vitest run tests/unit/legacy-resume-target.test.ts --exclude '**/.worktrees/**' --exclude '**/.codex/**'
corepack pnpm exec playwright test tests/e2e/legacy-ui-resume-target.e2e.test.ts
git diff --check
```

**Risk / rollback:** Browser identifiers are preferences, not authorization. Do not expose whether another user's campaign exists. Roll back this task's code commit if its acceptance fails; preserve canonical records and version-compatible draft/preferences. No automatic cleanup of user data.

**Agent handoff:** Deliver T06 only. State deviations from the approved Interfaces block explicitly; do not silently rename cross-task APIs or remove an acceptance case.

### T07: Build scoped local action-draft storage

**Dependencies:** T01

**Why / evidence:** Ordinary unsent text needs persistence independent of generation submission storage; merging the two would blur workflow authority.

**Files / exclusive ownership:**
- Create packages/client-web/src/storage/story-action-drafts.ts
- Modify packages/client-web/src/index.ts
- Create tests/unit/story-action-drafts.test.ts
- Create tests/e2e/legacy-ui-draft-storage.e2e.test.ts

**Interfaces and decisions:** createStoryActionDraftStore(database:DraftDatabasePort,now:()=>Date,idFactory:()=>string): {read(scope):Promise<Draft|null>;write(scope,draft,{expectedRevision:string|null}):Promise<WriteResult>;removeIfRevision(scope,expectedRevision:string):Promise<ClearResult>}; WriteResult={outcome:'saved'|'conflict'|'unavailable'|'quota'|'capacity'|'invalid',currentRevision?:string}; ClearResult={outcome:'removed'|'absent'|'conflict'|'unavailable'}; compare and write/delete occur in one IndexedDB readwrite transaction; Scope={userId:string,campaignId:string}; Draft={schemaVersion:1,draftRevision:string,text:string,inputMode:'action'|'scene',baseTurnId:string|null,baseTurnNumber:number,updatedAt:string}; immutable draftRevision changes on each meaningful edit, including retyped identical text. IndexedDB database infiniteQuest-reader-local-v1, object store actionDrafts, key userId+campaignId. DraftDatabasePort is an injected transactional adapter; all operations return Promises.

**Required regression cases and assertions:**
- scope_isolates_user_and_campaign
- transactional_write_conflict_preserves_other_tab
- conditional_clear_preserves_same_text_new_revision
- corrupt_json_does_not_throw
- unknown_version_is_ignored
- quota_returns_failure_without_erasing_current
- expired_records_pruned_with_notice
- current_record_protected_and_unexpired_capacity_not_evicted
- max_length_and50record_bounds

**Execution steps:**
- [ ] Read dependency outputs and associated tests; confirm file ownership with coordinator.
- [ ] Add the regression cases above using T01 synthetic fixtures or pure adapter tests; record expected assertions and the current failing behavior.
- [ ] Run the focused command below and record the intentional failing assertions; stop to repair infrastructure if assertions cannot execute.
- [ ] Validate decoded records and scope UUIDs; enforce12,000characters,50records and30day retention. Inject a clock for deterministic pruning; do not use this store for credentials/state/world content.
- [ ] Treat corrupt/version-unknown storage as unavailable record, never executable HTML. Disclose30day retention in draft help; prune expired entries and retain a bounded expiry notice without expired prose. Protect the current record. If50unexpired entries fill capacity, preserve unsent data and report capacity instead of silent eviction.
- [ ] Expose Web adapter only; add no DOM dependency, network request or canonical persistence.
- [ ] Run focused checks again; expected all selected assertions pass, no newly skipped cases. Include build/type/boundary checks when affected.
- [ ] Browser/manual proof: No rendered product UI yet; inject transactional fake port/clock for unit tests and add a two-page browser smoke using real IndexedDB transactions.
- [ ] Review complete scoped diff and git diff --check; obtain fresh task review; record evidence before marking accepted.
- [ ] Commit the task alone with an imperative summary, then hand dependency interface and commit hash to coordinator.

**Focused commands:**
```sh
corepack pnpm exec vitest run tests/unit/story-action-drafts.test.ts --exclude '**/.worktrees/**' --exclude '**/.codex/**'
corepack pnpm exec playwright test tests/e2e/legacy-ui-draft-storage.e2e.test.ts
git diff --check
```

**Risk / rollback:** Drafts are user text in IndexedDB. Origin access is the privacy boundary; no secure-encryption/cross-device promise. Plain localStorage is not an atomic fallback; unavailable IndexedDB leaves explicit unsaved input. Roll back this task's code commit if its acceptance fails; preserve canonical records and version-compatible draft/preferences. No automatic cleanup of user data.

**Agent handoff:** Deliver T07 only. State deviations from the approved Interfaces block explicitly; do not silently rename cross-task APIs or remove an acceptance case.

### T08: Integrate truthful draft saving with generation recovery

**Dependencies:** T07,T06

**Why / evidence:** The input must survive reload, but ordinary draft restoration must not override pending/failed durable job provenance.

**Files / exclusive ownership:**
- Modify apps/web/src/composition.ts
- Modify apps/web/src/story.js
- Modify apps/web/public/story.html
- Modify tests/unit/story-player-composition.test.ts
- Create tests/e2e/legacy-ui-action-drafts.e2e.test.ts
- Review tests/e2e/failed-turn-prompt-retention.e2e.test.ts

**Interfaces and decisions:** Composition adds actionDrafts store, injectable IndexedDB database port and id factory; update environment/factories/tests without repurposing pendingSubmission or failedTurnPrompt storage. UI tracks 'Draft saving'|'Draft saved'|'Draft not saved'|'No draft'; accepted-story status is separate. Persist after250ms idle through a serialized/coalesced transactional queue; saving lasts through transaction commit. pagehide flush is best effort; app-controlled navigation awaits transaction commit or explicit discard. Browser reload/close uses native unsaved warning and best-effort flush only; asynchronous completion cannot be guaranteed in beforeunload. Restoration requires resolved user/campaign. Capture submittedDraftRevision separately from generation idempotency; conditional deletion checks submitted, persisted and current in-memory revision.

**Required regression cases and assertions:**
- reload_restores_unsent_text_without_submit
- failed_storage_never_reports_saved
- campaign_and_user_switch_do_not_leak
- pending_recovery_wins_over_old_local_draft
- acceptance_clears_matching_not_newer_draft
- retyped_same_text_new_revision_survives_acceptance
- second_tab_edits_survive_first_tab_acceptance
- newer_draft_survives_recovery_reconciliation
- app_navigation_awaits_transaction_commit
- browser_close_warns_without_claiming_async_completion
- changed_base_requires_restore_choice
- explicit_clear_removes_local_draft

**Execution steps:**
- [ ] Read dependency outputs and associated tests; confirm file ownership with coordinator.
- [ ] Add the regression cases above using T01 synthetic fixtures or pure adapter tests; record expected assertions and the current failing behavior.
- [ ] Run the focused command below and record the intentional failing assertions; stop to repair infrastructure if assertions cannot execute.
- [ ] Persist typing, programmatic choice insertion, clear and input-mode changes through one setter; never claim saved before successful write.
- [ ] Restore ordinary draft only after authoritative pending/failed recovery has been reconciled and only when it does not overwrite fresh typing. If base turn changed, offer explicit Restore draft/Discard rather than auto-applying old action.
- [ ] Keep submitted draft while queued/failed/recoverable; remove only via removeIfRevision on accepted matching submission or explicit clear of displayed revision. Retyped same text with a new revision survives late acceptance. Cross-tab write conflict preserves persisted text and local in-memory edits; show Restore saved draft/Keep this draft, with explicit transactional retry against newly observed revision. Never auto-overwrite.
- [ ] Replace hardcoded Autosaved. If persistence fails, keep editing available and guard reload/navigation for unsaved local text.
- [ ] Run focused checks again; expected all selected assertions pass, no newly skipped cases. Include build/type/boundary checks when affected.
- [ ] Browser/manual proof: Reload unsent action; simulate quota failure, durable pending job and failed-turn retry. Assert writes to generation routes occur only on explicit submission.
- [ ] Review complete scoped diff and git diff --check; obtain fresh task review; record evidence before marking accepted.
- [ ] Commit the task alone with an imperative summary, then hand dependency interface and commit hash to coordinator.

**Focused commands:**
```sh
corepack pnpm exec vitest run tests/unit/story-player-composition.test.ts --exclude '**/.worktrees/**' --exclude '**/.codex/**'
corepack pnpm exec playwright test tests/e2e/legacy-ui-action-drafts.e2e.test.ts tests/e2e/failed-turn-prompt-retention.e2e.test.ts
git diff --check
```

**Risk / rollback:** Do not alter idempotency keys, pendingSubmission store or failedTurnPrompt authority. Do not store rejected raw narration. Roll back this task's code commit if its acceptance fails; preserve canonical records and version-compatible draft/preferences. No automatic cleanup of user data.

**Agent handoff:** Deliver T08 only. State deviations from the approved Interfaces block explicitly; do not silently rename cross-task APIs or remove an acceptance case.

### T09: Add sticky single-turn navigation and explicit choice-mode copy

**Dependencies:** T08

**Why / evidence:** Controls below long prose impede reading, and hidden auto-submit mode makes choice clicks unpredictable.

**Files / exclusive ownership:**
- Modify apps/web/public/story.html
- Modify apps/web/public/story.css
- Modify apps/web/src/story.js
- Review tests/unit/story-keyboard.test.ts
- Create tests/e2e/legacy-ui-reader-navigation.e2e.test.ts

**Interfaces and decisions:** reader toolbar actions call existing select/previous/next/history logic, not new generation handlers. Choice label derives from user.settings.autoSubmitTurnChoices; existing explicit preference stays unchanged.

**Required regression cases and assertions:**
- previous_next_do_not_submit
- boundary_buttons_are_disabled
- jump_latest_preserves_draft
- more_retains_replacement_guards
- choice_mode_label_matches_preference
- keyboard_focus_not_obscured

**Execution steps:**
- [ ] Read dependency outputs and associated tests; confirm file ownership with coordinator.
- [ ] Add the regression cases above using T01 synthetic fixtures or pure adapter tests; record expected assertions and the current failing behavior.
- [ ] Run the focused command below and record the intentional failing assertions; stop to repair infrastructure if assertions cannot execute.
- [ ] Add sticky Previous, turn/count, Next, History and Jump to latest; retain accessible names and disabled-state reasons at endpoints/loading.
- [ ] Move Undo/Retry/replacement actions to a secondary More disclosure with existing confirmation and workflow gating; keep recovery actions visible when needed.
- [ ] Collapse previous-action text with an accessible disclosure; show 'Choose and continue' or 'Add to draft' beside choices and route programmatic drafts through T08.
- [ ] Run focused checks again; expected all selected assertions pass, no newly skipped cases. Include build/type/boundary checks when affected.
- [ ] Browser/manual proof: Read a long scene at desktop and200%zoom; navigate without scrolling to composer; exercise both choice modes with deterministic mocked generation.
- [ ] Review complete scoped diff and git diff --check; obtain fresh task review; record evidence before marking accepted.
- [ ] Commit the task alone with an imperative summary, then hand dependency interface and commit hash to coordinator.

**Focused commands:**
```sh
corepack pnpm exec vitest run tests/unit/story-keyboard.test.ts --exclude '**/.worktrees/**' --exclude '**/.codex/**'
corepack pnpm exec playwright test tests/e2e/legacy-ui-reader-navigation.e2e.test.ts
git diff --check
```

**Risk / rollback:** Sticky navigation must not cover notifications, prose anchors or focused controls. No changes to mechanics/Story Direction semantics. Roll back this task's code commit if its acceptance fails; preserve canonical records and version-compatible draft/preferences. No automatic cleanup of user data.

**Agent handoff:** Deliver T09 only. State deviations from the approved Interfaces block explicitly; do not silently rename cross-task APIs or remove an acceptance case.

### T10: Add exact accepted-turn lookup without changing existing read routes

**Dependencies:** T01

**Why / evidence:** Resume and jump-to-turn must not download every earlier page. Current turns API supports only backwards cursor pages.

**Files / exclusive ownership:**
- Create packages/contracts/src/reader-history.ts
- Modify packages/contracts/src/index.ts
- Create packages/database/src/reader-history-repository.ts
- Create packages/application/src/reader-history/ports.ts
- Create packages/application/src/reader-history/use-cases.ts
- Create packages/application/src/reader-history/index.ts
- Create services/api/src/reader-history-routes.ts
- Modify services/api/src/server.ts
- Create packages/client-web/src/reader-history-api.ts
- Modify packages/client-web/src/index.ts
- Create tests/unit/reader-history.test.ts
- Create tests/integration/reader-history.integration.test.ts

**Interfaces and decisions:** GET /api/v1/campaigns/:campaignId/reader/turns/:turnNumber -> {campaignId,turn:turnSummarySchema}; positive integer turnNumber;404 if owned campaign/turn unavailable. ReaderHistoryApi.getTurn(campaignId,turnNumber,signal?):Promise<ReaderTurnResponse>. Read port getEffectiveTurn(ownerScope,turnNumber). Compose backend adapters through direct packages/application/src/reader-history/index.ts context import, matching existing patterns; no application root barrel export.

**Required regression cases and assertions:**
- turn_number_must_be_positive_integer
- effective_correction_is_returned
- missing_turn_returns404
- cross_owner_campaign_not_visible
- foreign_turn_identity_never_returned
- existing_read_contracts_unchanged

**Execution steps:**
- [ ] Read dependency outputs and associated tests; confirm file ownership with coordinator.
- [ ] Add the regression cases above using T01 synthetic fixtures or pure adapter tests; record expected assertions and the current failing behavior.
- [ ] Run the focused command below and record the intentional failing assertions; stop to repair infrastructure if assertions cannot execute.
- [ ] Add validated contract and minimal read use case/port; repository joins owner+campaign effective_turn_narrations, preserving correction overlays and accepted-turn identity.
- [ ] Register an additive route and browser adapter. Use server-resolved owner; sanitize/format narration through existing code; reuse public reported-cost projection if required by turnSummarySchema.
- [ ] Do not change /turns, /state, sync-status, their cursors or worker code. Return no scratchpad/raw-output/internal diagnostics.
- [ ] Run focused checks again; expected all selected assertions pass, no newly skipped cases. Include build/type/boundary checks when affected.
- [ ] Browser/manual proof: Integration uses real PostgreSQL; browser consumer comes in T11. No provider invocation.
- [ ] Review complete scoped diff and git diff --check; obtain fresh task review; record evidence before marking accepted.
- [ ] Commit the task alone with an imperative summary, then hand dependency interface and commit hash to coordinator.

**Focused commands:**
```sh
corepack pnpm exec vitest run tests/unit/reader-history.test.ts --exclude '**/.worktrees/**' --exclude '**/.codex/**'
corepack pnpm exec vitest run --config vitest.integration.config.ts tests/integration/reader-history.integration.test.ts
git diff --check
```

**Risk / rollback:** No migration/index by default. Missing owner/campaign must not be revealed by different error messages. Existing contract-frozen benchmark remains unchanged. Roll back this task's code commit if its acceptance fails; preserve canonical records and version-compatible draft/preferences. No automatic cleanup of user data.

**Agent handoff:** Deliver T10 only. State deviations from the approved Interfaces block explicitly; do not silently rename cross-task APIs or remove an acceptance case.

### T11: Persist and restore reading position

**Dependencies:** T10,T09

**Why / evidence:** Remembering only a campaign sends a returning reader to the latest turn, rather than where they stopped.

**Files / exclusive ownership:**
- Create packages/client-web/src/storage/reader-positions.ts
- Modify packages/client-web/src/index.ts
- Modify apps/web/src/composition.ts
- Modify apps/web/src/story.js
- Create tests/unit/reader-positions.test.ts
- Create tests/e2e/legacy-ui-reader-resume.e2e.test.ts

**Interfaces and decisions:** ReaderPosition={schemaVersion:1,turnId:string,turnNumber:number,offsetRatio:number,updatedAt:string}; store scope matches T07. Save offsetRatio clamped0..1 after250ms idle/pagehide. Use T10 getTurn when target is outside loaded recent window.

**Required regression cases and assertions:**
- old_turn_restored_with_one_lookup
- new_reader_defaults_latest
- replaced_turn_does_not_restore_wrong_identity
- user_scroll_cancels_late_restore
- offset_clamped
- campaign_isolated
- jump_latest_does_not_submit

**Execution steps:**
- [ ] Read dependency outputs and associated tests; confirm file ownership with coordinator.
- [ ] Add the regression cases above using T01 synthetic fixtures or pure adapter tests; record expected assertions and the current failing behavior.
- [ ] Run the focused command below and record the intentional failing assertions; stop to repair infrastructure if assertions cannot execute.
- [ ] Persist viewed accepted-turn identity and normalized in-scene scroll position; do not persist streamed candidate position as accepted reading state.
- [ ] Restore after prose/fonts are laid out and only if user has not scrolled/navigated meanwhile. Missing/replaced identity uses latest with a visible explanation, not the unrelated old scroll offset.
- [ ] Provide Resume reading vs Jump to latest. Guard response epoch and reconcile changed latest turn without overwriting action drafts.
- [ ] Run focused checks again; expected all selected assertions pass, no newly skipped cases. Include build/type/boundary checks when affected.
- [ ] Browser/manual proof: Resume Turn12 of317 after reload, change viewport size, then simulate turn replacement. Ensure no complete-history drain.
- [ ] Review complete scoped diff and git diff --check; obtain fresh task review; record evidence before marking accepted.
- [ ] Commit the task alone with an imperative summary, then hand dependency interface and commit hash to coordinator.

**Focused commands:**
```sh
corepack pnpm exec vitest run tests/unit/reader-positions.test.ts --exclude '**/.worktrees/**' --exclude '**/.codex/**'
corepack pnpm exec playwright test tests/e2e/legacy-ui-reader-resume.e2e.test.ts
git diff --check
```

**Risk / rollback:** Record identity as well as number because replacement can retain a turn number. Storage loss must not block story loading. Roll back this task's code commit if its acceptance fails; preserve canonical records and version-compatible draft/preferences. No automatic cleanup of user data.

**Agent handoff:** Deliver T11 only. State deviations from the approved Interfaces block explicitly; do not silently rename cross-task APIs or remove an acceptance case.

### T12: Add validated reader preferences and scoped themes

**Dependencies:** T09

**Why / evidence:** Very wide prose and fixed presentation limit comfort; controls should be optional preferences rather than a rebrand.

**Files / exclusive ownership:**
- Modify packages/contracts/src/users.ts
- Modify apps/web/src/story.js
- Modify apps/web/public/story.html
- Modify apps/web/public/story.css
- Modify apps/web/public/tokens.css
- Modify tests/unit/user-profile.test.ts
- Create tests/e2e/legacy-ui-reader-preferences.e2e.test.ts

**Interfaces and decisions:** settings.readerPreferences={widthCh:60|72|84,fontSizePx:16|18|20|22,lineHeight:1.5|1.7|1.9,theme:'dark'|'light'|'sepia'} with defaults72/18/1.7/dark; validate supplied values. Preserve unknown existing settings and explicit continuousReading/autoSubmit values.

**Required regression cases and assertions:**
- old_profile_receives_defaults
- invalid_preference_rejected
- other_settings_preserved
- explicit_continuous_and_choice_preferences_preserved
- reader_theme_does_not_restyle_nexus

**Execution steps:**
- [ ] Read dependency outputs and associated tests; confirm file ownership with coordinator.
- [ ] Add the regression cases above using T01 synthetic fixtures or pure adapter tests; record expected assertions and the current failing behavior.
- [ ] Run the focused command below and record the intentional failing assertions; stop to repair infrastructure if assertions cannot execute.
- [ ] Add schema defaults compatible with historical profiles; confirm existing JSON settings persistence needs no migration. Profile writes merge current settings instead of dropping unrelated values.
- [ ] Add Reading appearance controls with preview and explicit save behavior; apply CSS custom properties only within reader scope.
- [ ] Verify prose, links, controls, disabled state and focus contrast in all themes; use min(availableWidth,chosenCh) for narrow viewports.
- [ ] Run focused checks again; expected all selected assertions pass, no newly skipped cases. Include build/type/boundary checks when affected.
- [ ] Browser/manual proof: Capture each theme desktop/narrow, keyboard focus and200%zoom; record computed contrast values and no horizontal overflow.
- [ ] Review complete scoped diff and git diff --check; obtain fresh task review; record evidence before marking accepted.
- [ ] Commit the task alone with an imperative summary, then hand dependency interface and commit hash to coordinator.

**Focused commands:**
```sh
corepack pnpm exec vitest run tests/unit/user-profile.test.ts --exclude '**/.worktrees/**' --exclude '**/.codex/**'
corepack pnpm exec playwright test tests/e2e/legacy-ui-reader-preferences.e2e.test.ts
git diff --check
```

**Risk / rollback:** Existing profile contract consumers must remain compatible. Avoid global token overrides affecting management dialogs. Roll back this task's code commit if its acceptance fails; preserve canonical records and version-compatible draft/preferences. No automatic cleanup of user data.

**Agent handoff:** Deliver T12 only. State deviations from the approved Interfaces block explicitly; do not silently rename cross-task APIs or remove an acceptance case.

### T13: Open and page history without full-ledger loading

**Dependencies:** T09,T10,T11

**Why / evidence:** The history dialog rendered all317 turns and opened at the beginning. Most users need a nearby turn, not the entire ledger.

**Files / exclusive ownership:**
- Modify apps/web/src/story.js
- Modify apps/web/src/story-history-loader.js
- Modify apps/web/public/story.html
- Modify apps/web/public/story.css
- Modify tests/unit/story-history-loader.test.ts
- Create tests/e2e/legacy-ui-history-pagination.e2e.test.ts

**Interfaces and decisions:** History controller holds displayed page<=50 cards, older cursor and page stack; reuse existing mergeStoryTurnPages identity safeguards. Opening uses loaded recent data; fetch older page only on request with limit50. Older resumed selection is a pinned Selected turn preview from T11lookup plus at most49recent cards(50total); missing selected data permits one T10lookup shown as loading. Export/complete-history consumers keep loadCompleteStoryHistory.

**Required regression cases and assertions:**
- opening_does_not_fetch_all_pages
- cards_never_exceed50
- selected_turn_visible
- resumed_turn12_of317_pinned_without_ledger_drain
- adjacent_selected_turn_one_lookup_per_click
- preview_and_page_at_most50cards
- older_page_explicit_only
- cursor409_resets_safely
- duplicate_number_rejected
- preview_does_not_inspect_state
- existing_complete_export_still_reads_all

**Execution steps:**
- [ ] Read dependency outputs and associated tests; confirm file ownership with coordinator.
- [ ] Add the regression cases above using T01 synthetic fixtures or pure adapter tests; record expected assertions and the current failing behavior.
- [ ] Run the focused command below and record the intentional failing assertions; stop to repair infrastructure if assertions cannot execute.
- [ ] Remove ensureCompleteTurnHistory from dialog opening; show current/recent page immediately and selected card in view.
- [ ] Render compact safe-text excerpts<=240characters and turn/date; show diagnostics only in explicit advanced details. Provide Older/Newer for cursor-page navigation. On the pinned older selection, explicit Previous/Next turn uses T10one adjacent lookup per click and replaces only the preview; labels distinguish these from history pages. Reconcile replacement identity before navigation.
- [ ] Keep history state per campaign+epoch; changing ledger/cursor409 resets history with explanation, dedupes identities and prevents cursor loops. Selecting a preview must not silently call state inspection.
- [ ] Run focused checks again; expected all selected assertions pass, no newly skipped cases. Include build/type/boundary checks when affected.
- [ ] Browser/manual proof: 317/2000turns: assert request count and card bound; inspect advanced detail separately.
- [ ] Review complete scoped diff and git diff --check; obtain fresh task review; record evidence before marking accepted.
- [ ] Commit the task alone with an imperative summary, then hand dependency interface and commit hash to coordinator.

**Focused commands:**
```sh
corepack pnpm exec vitest run tests/unit/story-history-loader.test.ts --exclude '**/.worktrees/**' --exclude '**/.codex/**'
corepack pnpm exec playwright test tests/e2e/legacy-ui-history-pagination.e2e.test.ts
git diff --check
```

**Risk / rollback:** Use pagination rather than accessibility-fragile custom virtualization initially. Do not trim authoritative or exported history. Roll back this task's code commit if its acceptance fails; preserve canonical records and version-compatible draft/preferences. No automatic cleanup of user data.

**Agent handoff:** Deliver T13 only. State deviations from the approved Interfaces block explicitly; do not silently rename cross-task APIs or remove an acceptance case.

### T14: Add bounded campaign-scoped history search index API

**Dependencies:** T10

**Why / evidence:** Search over only loaded turns would falsely report no results for older story content. Summary pages can search the complete accepted ledger without transferring full narration.

**Files / exclusive ownership:**
- Modify packages/contracts/src/reader-history.ts
- Modify packages/database/src/reader-history-repository.ts
- Modify packages/application/src/reader-history/ports.ts
- Modify packages/application/src/reader-history/use-cases.ts
- Modify services/api/src/reader-history-routes.ts
- Modify packages/client-web/src/reader-history-api.ts
- Modify tests/unit/reader-history.test.ts
- Modify tests/integration/reader-history.integration.test.ts

**Interfaces and decisions:** GET /api/v1/campaigns/:campaignId/reader/history?q=&before=&limit=50 -> {campaignId,items:[{id,turnNumber,acceptedAt,excerpt}],nextCursor}; q trimmed<=200chars;limit1..50;excerpt<=240chars;descending turn order. Cursor opaque, schemaVersion1, campaignId, query fingerprint,historyVersion,turnNumber,id; validate owner at every request. searchHistory(campaignId,{q?,before?,limit?},signal?).

**Required regression cases and assertions:**
- old_turn_matches_full_campaign_search
- corrected_text_searches_effective_narration
- wildcards_and_quotes_are_literal
- query_cursor_cannot_cross_campaign_or_query
- changed_history409
- excerpt_max240
- no_private_canary_in_result
- limit_bounds

**Execution steps:**
- [ ] Read dependency outputs and associated tests; confirm file ownership with coordinator.
- [ ] Add the regression cases above using T01 synthetic fixtures or pure adapter tests; record expected assertions and the current failing behavior.
- [ ] Run the focused command below and record the intentional failing assertions; stop to repair infrastructure if assertions cannot execute.
- [ ] Implement parameterized literal case-insensitive substring search over effective narration and action, escaping SQL LIKE wildcards so %/_ are literal; blank q lists summaries. No semantic/provider call.
- [ ] Use consistent read snapshot and existing history-version semantics for invalidation. Bind cursor to campaign and normalized query; return409 on changed ledger,400 on malformed/wrong-query cursor.
- [ ] Project only safe accepted text and metadata. Measure scoped query plans on2000turn fixture; use existing indexes first, and require a separate audited migration if new index is justified.
- [ ] Run focused checks again; expected all selected assertions pass, no newly skipped cases. Include build/type/boundary checks when affected.
- [ ] Browser/manual proof: Real PostgreSQL tests plus EXPLAIN evidence. No client integration yet.
- [ ] Review complete scoped diff and git diff --check; obtain fresh task review; record evidence before marking accepted.
- [ ] Commit the task alone with an imperative summary, then hand dependency interface and commit hash to coordinator.

**Focused commands:**
```sh
corepack pnpm exec vitest run tests/unit/reader-history.test.ts --exclude '**/.worktrees/**' --exclude '**/.codex/**'
corepack pnpm exec vitest run --config vitest.integration.config.ts tests/integration/reader-history.integration.test.ts
git diff --check
```

**Risk / rollback:** Substring scanning may be acceptable for scoped2000turns but is not assumed cheap at arbitrary scale. Preserve response bounds and ownership without inventing global search. Roll back this task's code commit if its acceptance fails; preserve canonical records and version-compatible draft/preferences. No automatic cleanup of user data.

**Agent handoff:** Deliver T14 only. State deviations from the approved Interfaces block explicitly; do not silently rename cross-task APIs or remove an acceptance case.

### T15: Add history search, exact jump and advanced inspection

**Dependencies:** T14,T13,T11

**Why / evidence:** Users need fast access to a known turn or remembered phrase without inspecting every card.

**Files / exclusive ownership:**
- Modify apps/web/src/story.js
- Modify apps/web/public/story.html
- Modify apps/web/public/story.css
- Create tests/e2e/legacy-ui-history-search.e2e.test.ts
- Modify tests/unit/story-player-ui.test.ts

**Interfaces and decisions:** Search input debounced250ms; active query results<=50; AbortController and query epoch. Exact jump accepts positive integer<=known latest; fetch selected full turn through T10. Explicit Inspect state keeps existing scoped inspection route.

**Required regression cases and assertions:**
- search_finds_unloaded_old_turn
- late_search_does_not_overwrite_new_query
- jump_one_request_no_history_drain
- invalid_jump_no_request
- search_result_selection_preserves_draft
- inspection_explicit_only
- no_html_execution

**Execution steps:**
- [ ] Read dependency outputs and associated tests; confirm file ownership with coordinator.
- [ ] Add the regression cases above using T01 synthetic fixtures or pure adapter tests; record expected assertions and the current failing behavior.
- [ ] Run the focused command below and record the intentional failing assertions; stop to repair infrastructure if assertions cannot execute.
- [ ] Add search, jump-number, clear and result count/empty/loading states. Search is clearly campaign-wide; keep all result text safely rendered.
- [ ] Reset cursors on query change and cancel outdated searches. Selecting a result loads that turn only, validates identity and closes history after success.
- [ ] Handle absent targets,409and failed requests locally; preserve previous reading position and composer on failure. Advanced inspection displays separately from narrative.
- [ ] Run focused checks again; expected all selected assertions pass, no newly skipped cases. Include build/type/boundary checks when affected.
- [ ] Browser/manual proof: Search317/2000turn fixture, rapidly change query and inspect state; keyboard focus result traversal and return.
- [ ] Review complete scoped diff and git diff --check; obtain fresh task review; record evidence before marking accepted.
- [ ] Commit the task alone with an imperative summary, then hand dependency interface and commit hash to coordinator.

**Focused commands:**
```sh
corepack pnpm exec vitest run tests/unit/story-player-ui.test.ts --exclude '**/.worktrees/**' --exclude '**/.codex/**'
corepack pnpm exec playwright test tests/e2e/legacy-ui-history-search.e2e.test.ts
git diff --check
```

**Risk / rollback:** Do not expose scratchpad in compact history/search or narrate inspection metadata. Don't mistake partial failed search for zero results. Roll back this task's code commit if its acceptance fails; preserve canonical records and version-compatible draft/preferences. No automatic cleanup of user data.

**Agent handoff:** Deliver T15 only. State deviations from the approved Interfaces block explicitly; do not silently rename cross-task APIs or remove an acceptance case.

### T16: Bound optional continuous reading

**Dependencies:** T13,T11

**Why / evidence:** Optional continuous reading currently drains all history and rebuilds scenes; preserving the preference need not require unbounded startup/rendering.

**Files / exclusive ownership:**
- Modify apps/web/src/story.js
- Modify apps/web/public/story.css
- Create tests/e2e/legacy-ui-continuous-reading.e2e.test.ts

**Interfaces and decisions:** Continuous reader presents a window of at most10full scenes, with explicit Load older/Newer groups; keep current-turn anchor. Existing all-history exports remain separate.

**Required regression cases and assertions:**
- continuous_startup_bounded
- scene_count_at_most10
- older_page_retains_visible_anchor
- mode_switch_preserves_turn
- exports_complete
- replacement_updates_correct_scene

**Execution steps:**
- [ ] Read dependency outputs and associated tests; confirm file ownership with coordinator.
- [ ] Add the regression cases above using T01 synthetic fixtures or pure adapter tests; record expected assertions and the current failing behavior.
- [ ] Run the focused command below and record the intentional failing assertions; stop to repair infrastructure if assertions cannot execute.
- [ ] Remove complete-history load from continuous startup; show available recent scenes immediately and load older pages on explicit action.
- [ ] Reuse keyed scene nodes within the10scene window; retain anchor before removing/replacing nodes and lazy-load illustrations.
- [ ] Keep switch between single/continuous modes predictable, preserving selected turn, drafts and stored position.
- [ ] Run focused checks again; expected all selected assertions pass, no newly skipped cases. Include build/type/boundary checks when affected.
- [ ] Browser/manual proof: Long narrative2000turn fixture, keyboard and scrollbar navigation, mode switching while images delayed.
- [ ] Review complete scoped diff and git diff --check; obtain fresh task review; record evidence before marking accepted.
- [ ] Commit the task alone with an imperative summary, then hand dependency interface and commit hash to coordinator.

**Focused commands:**
```sh
corepack pnpm exec playwright test tests/e2e/legacy-ui-continuous-reading.e2e.test.ts
git diff --check
```

**Risk / rollback:** Do not virtualize away focused elements.10scene budget is a proposal to audit for usability, not an existing requirement. Roll back this task's code commit if its acceptance fails; preserve canonical records and version-compatible draft/preferences. No automatic cleanup of user data.

**Agent handoff:** Deliver T16 only. State deviations from the approved Interfaces block explicitly; do not silently rename cross-task APIs or remove an acceptance case.

### T17: Guide world readiness without duplicating server validation

**Dependencies:** T04

**Why / evidence:** New authors can save a draft but lack a persistent guide to becoming campaign-ready.

**Files / exclusive ownership:**
- Modify apps/web/public/index.html
- Modify apps/web/public/nexus.js
- Modify apps/web/public/nexus.css
- Create tests/e2e/legacy-ui-world-readiness.e2e.test.ts
- Review tests/unit/world-library.test.ts

**Interfaces and decisions:** Author checklist displays Basics/Lore/Playable character/Review using current form state and server readiness response. It never overrides the existing readiness/publish/create validators.

**Required regression cases and assertions:**
- title_only_draft_save_allowed
- no_character_explains_campaign_block
- playable_character_issue_links_to_editor
- publish_explicit
- existing_campaign_version_unchanged
- server_readiness_failure_not_success

**Execution steps:**
- [ ] Read dependency outputs and associated tests; confirm file ownership with coordinator.
- [ ] Add the regression cases above using T01 synthetic fixtures or pure adapter tests; record expected assertions and the current failing behavior.
- [ ] Run the focused command below and record the intentional failing assertions; stop to repair infrastructure if assertions cannot execute.
- [ ] Add persistent step navigation and contextual next action, preserving partially complete draft saving.
- [ ] Explain draft vs published immutable version; show readiness issues and links to fields/character work. Mark local checklist as guidance before server assessment.
- [ ] Keep Publish and Create campaign explicit and separate; no auto-publish, no update to existing campaigns. Failed readiness remains retryable.
- [ ] Run focused checks again; expected all selected assertions pass, no newly skipped cases. Include build/type/boundary checks when affected.
- [ ] Browser/manual proof: Create draft manually in mocked flow, apply character, save, publish and create; ensure each is a separate action.
- [ ] Review complete scoped diff and git diff --check; obtain fresh task review; record evidence before marking accepted.
- [ ] Commit the task alone with an imperative summary, then hand dependency interface and commit hash to coordinator.

**Focused commands:**
```sh
corepack pnpm exec vitest run tests/unit/world-library.test.ts --exclude '**/.worktrees/**' --exclude '**/.codex/**'
corepack pnpm exec playwright test tests/e2e/legacy-ui-world-readiness.e2e.test.ts
git diff --check
```

**Risk / rollback:** Do not elevate optional genre/tone/appearance to required domain fields. Server readiness is the final authority. Roll back this task's code commit if its acceptance fails; preserve canonical records and version-compatible draft/preferences. No automatic cleanup of user data.

**Agent handoff:** Deliver T17 only. State deviations from the approved Interfaces block explicitly; do not silently rename cross-task APIs or remove an acceptance case.

### T18: Disclose character and world advanced fields progressively

**Dependencies:** T17

**Why / evidence:** Large all-visible character forms overwhelm first-time authors while advanced authors still need full capabilities.

**Files / exclusive ownership:**
- Modify apps/web/public/index.html
- Modify apps/web/public/nexus.css
- Modify apps/web/public/nexus.js
- Create tests/e2e/legacy-ui-authoring-disclosures.e2e.test.ts

**Interfaces and decisions:** Basic character section exposes identity/playable flag and fiction profile. Advanced disclosures group Appearance, Mechanics, Imported/legacy guidance. Preserve all existing serializer fields; disclosure state is presentation only.

**Required regression cases and assertions:**
- closed_disclosure_preserves_advanced_values
- new_character_no_empty_legacy_prominence
- invalid_advanced_field_expands_and_focuses
- apply_then_cancel_parent_warns
- existing_character_roundtrip_unchanged

**Execution steps:**
- [ ] Read dependency outputs and associated tests; confirm file ownership with coordinator.
- [ ] Add the regression cases above using T01 synthetic fixtures or pure adapter tests; record expected assertions and the current failing behavior.
- [ ] Run the focused command below and record the intentional failing assertions; stop to repair infrastructure if assertions cannot execute.
- [ ] Group existing fields without changing schema or deleting hidden values; empty new-character legacy section stays collapsed.
- [ ] Make labels distinguish optional authoring/illustration/mechanics content; maintain fiction/mechanics separation in all existing generation paths.
- [ ] Ensure error summaries expand the disclosure containing an invalid field, focus it and retain entries after API errors.
- [ ] Run focused checks again; expected all selected assertions pass, no newly skipped cases. Include build/type/boundary checks when affected.
- [ ] Browser/manual proof: New and imported advanced characters, keyboard-only disclosure navigation and200%zoom.
- [ ] Review complete scoped diff and git diff --check; obtain fresh task review; record evidence before marking accepted.
- [ ] Commit the task alone with an imperative summary, then hand dependency interface and commit hash to coordinator.

**Focused commands:**
```sh
corepack pnpm exec playwright test tests/e2e/legacy-ui-authoring-disclosures.e2e.test.ts
git diff --check
```

**Risk / rollback:** Do not send mechanics to fiction/image prompts. This is presentation regrouping, not schema normalization. Roll back this task's code commit if its acceptance fails; preserve canonical records and version-compatible draft/preferences. No automatic cleanup of user data.

**Agent handoff:** Deliver T18 only. State deviations from the approved Interfaces block explicitly; do not silently rename cross-task APIs or remove an acceptance case.

### T19: Normalize campaign creation state and default resolution

**Dependencies:** T01

**Why / evidence:** Two creation paths currently apply different defaults; a shared pure policy prevents divergence without changing the creation API.

**Files / exclusive ownership:**
- Create packages/client-core/src/campaign-creation-draft.ts
- Modify packages/client-core/src/index.ts
- Modify apps/web/src/legacy-management-entry.ts
- Create tests/unit/campaign-creation-draft.test.ts

**Interfaces and decisions:** CampaignCreationDraft={worldId,worldVersionId,title,selectedCharacterId,turnControlStyle,startAfterCreate}; createCampaignCreationDraft({world,userSettings}):draft; buildCampaignCreateRequest(draft):CampaignCreateRequest. Default order explicit draft selection, normalized saved user preference, existing contract default.

**Required regression cases and assertions:**
- saved_flexible_scene_used_in_both_paths
- explicit_selection_overrides_default
- historical_preference_normalizes
- missing_character_rejected
- version_pinned
- advanced_toggle_preserves_draft

**Execution steps:**
- [ ] Read dependency outputs and associated tests; confirm file ownership with coordinator.
- [ ] Add the regression cases above using T01 synthetic fixtures or pure adapter tests; record expected assertions and the current failing behavior.
- [ ] Run the focused command below and record the intentional failing assertions; stop to repair infrastructure if assertions cannot execute.
- [ ] Use shared contracts and existing turn-control normalization; preserve action_only/flexible_action/flexible_scene values correctly.
- [ ] Validate immutable version and playable character availability through supplied server response; do not query or mutate from client-core.
- [ ] Retain draft values when advanced disclosure opens. Do not include unsupported fields or infer a new world version from current draft.
- [ ] Run focused checks again; expected all selected assertions pass, no newly skipped cases. Include build/type/boundary checks when affected.
- [ ] Browser/manual proof: No DOM yet; tests pure request payloads.
- [ ] Review complete scoped diff and git diff --check; obtain fresh task review; record evidence before marking accepted.
- [ ] Commit the task alone with an imperative summary, then hand dependency interface and commit hash to coordinator.

**Focused commands:**
```sh
corepack pnpm exec vitest run tests/unit/campaign-creation-draft.test.ts --exclude '**/.worktrees/**' --exclude '**/.codex/**'
git diff --check
```

**Risk / rollback:** Do not change existing global auto-submit preference or server campaign-create defaults for other clients. Roll back this task's code commit if its acceptance fails; preserve canonical records and version-compatible draft/preferences. No automatic cleanup of user data.

**Agent handoff:** Deliver T19 only. State deviations from the approved Interfaces block explicitly; do not silently rename cross-task APIs or remove an acceptance case.

### T20: Use one Basic/Advanced campaign creation dialog

**Dependencies:** T19,T04

**Why / evidence:** A unified dialog avoids losing quick-form entries, makes the selected world/version clear and gives a predictable finish.

**Files / exclusive ownership:**
- Modify apps/web/public/nexus.js
- Modify apps/web/public/index.html
- Modify apps/web/public/nexus.css
- Modify tests/unit/legacy-campaign-creation-ui.test.ts
- Create tests/e2e/legacy-ui-campaign-creation.e2e.test.ts

**Interfaces and decisions:** Both dashboard and management invoke openCampaignCreation({worldId,worldVersionId,initialDraft?}); one T19 controller. Submit intent startAfterCreate true/false. Persist committed campaign ID before refresh/navigation; retry after commit refresh failure never POSTs again.

**Required regression cases and assertions:**
- quick_and_management_payloads_identical
- advanced_expansion_loses_no_fields
- create_start_opens_committed_id
- create_only_stays_management
- double_click_one_post
- refresh_failure_no_duplicate_retry
- version_visible

**Execution steps:**
- [ ] Read dependency outputs and associated tests; confirm file ownership with coordinator.
- [ ] Add the regression cases above using T01 synthetic fixtures or pure adapter tests; record expected assertions and the current failing behavior.
- [ ] Run the focused command below and record the intentional failing assertions; stop to repair infrastructure if assertions cannot execute.
- [ ] Display world title/version, campaign title and playable character; advanced input style uses T19 defaults.
- [ ] Implement Create and start / Create only through one in-flight submit function; disable duplicate submission and preserve fields on validation/network failure.
- [ ] After commit, offer Open story even if list refresh fails. Reuse existing post-commit safeguards; guard dismissals and world/version changes.
- [ ] Run focused checks again; expected all selected assertions pass, no newly skipped cases. Include build/type/boundary checks when affected.
- [ ] Browser/manual proof: Both entry points with saved Story Direction preference; API failure, delayed double click and committed-refresh failure.
- [ ] Review complete scoped diff and git diff --check; obtain fresh task review; record evidence before marking accepted.
- [ ] Commit the task alone with an imperative summary, then hand dependency interface and commit hash to coordinator.

**Focused commands:**
```sh
corepack pnpm exec vitest run tests/unit/legacy-campaign-creation-ui.test.ts --exclude '**/.worktrees/**' --exclude '**/.codex/**'
corepack pnpm exec playwright test tests/e2e/legacy-ui-campaign-creation.e2e.test.ts
git diff --check
```

**Risk / rollback:** Navigation failure after creation is not creation failure. Do not duplicate a committed campaign. Roll back this task's code commit if its acceptance fails; preserve canonical records and version-compatible draft/preferences. No automatic cleanup of user data.

**Agent handoff:** Deliver T20 only. State deviations from the approved Interfaces block explicitly; do not silently rename cross-task APIs or remove an acceptance case.

### T21: Separate Worlds and Campaigns workspaces

**Dependencies:** T03,T04,T05

**Why / evidence:** Two large workspaces share one view and rely on hash scrolling, making context and errors hard to follow.

**Files / exclusive ownership:**
- Modify apps/web/public/nexus.js
- Modify apps/web/public/index.html
- Modify apps/web/public/nexus.css
- Create tests/e2e/legacy-ui-workspaces.e2e.test.ts
- Review tests/unit/dashboard-ui.test.ts

**Interfaces and decisions:** applyManagementView(hash) distinguishes dashboard/worlds/campaigns/providers/data-transfer. Retain selected world/campaign independently; cross-links carry IDs; use existing route/hash conventions.

**Required regression cases and assertions:**
- worlds_hides_campaign_workspace
- campaigns_retains_selection
- direct_hash_selects_correct_workspace
- dirty_back_navigation_stays
- crosslink_carries_id

**Execution steps:**
- [ ] Read dependency outputs and associated tests; confirm file ownership with coordinator.
- [ ] Add the regression cases above using T01 synthetic fixtures or pure adapter tests; record expected assertions and the current failing behavior.
- [ ] Run the focused command below and record the intentional failing assertions; stop to repair infrastructure if assertions cannot execute.
- [ ] Show only the active workspace, retaining explicit world->campaign and campaign->world links.
- [ ] Run T03/T04 guards before workspace transitions; handle direct hash/back/forward navigation with stable headings and focus.
- [ ] Preserve route coexistence and current deep links; no redirect to replacement client.
- [ ] Run focused checks again; expected all selected assertions pass, no newly skipped cases. Include build/type/boundary checks when affected.
- [ ] Browser/manual proof: Direct links, browser Back/Forward, world edit and campaign creation cross-links.
- [ ] Review complete scoped diff and git diff --check; obtain fresh task review; record evidence before marking accepted.
- [ ] Commit the task alone with an imperative summary, then hand dependency interface and commit hash to coordinator.

**Focused commands:**
```sh
corepack pnpm exec vitest run tests/unit/dashboard-ui.test.ts --exclude '**/.worktrees/**' --exclude '**/.codex/**'
corepack pnpm exec playwright test tests/e2e/legacy-ui-workspaces.e2e.test.ts
git diff --check
```

**Risk / rollback:** Changing hidden state must not unload a busy durable authoring UI or conceal its recovery entry point. Roll back this task's code commit if its acceptance fails; preserve canonical records and version-compatible draft/preferences. No automatic cleanup of user data.

**Agent handoff:** Deliver T21 only. State deviations from the approved Interfaces block explicitly; do not silently rename cross-task APIs or remove an acceptance case.

### T22: Prioritize resume and add searchable management collections

**Dependencies:** T21,T06

**Why / evidence:** 39worlds and59campaigns are difficult to navigate through long rails and unfiltered buttons; recent active campaigns are below the fold.

**Files / exclusive ownership:**
- Modify apps/web/public/nexus.js
- Modify apps/web/public/index.html
- Modify apps/web/public/nexus.css
- Modify tests/unit/dashboard-ui.test.ts
- Create tests/e2e/legacy-ui-collections.e2e.test.ts

**Interfaces and decisions:** Campaign filters active/archived/all; sort updated-desc/title; text search trims case-insensitively; deterministic ID tiebreak. Recent panel shows up to5active campaigns. World search/status uses existing domain status; all records remain discoverable.

**Required regression cases and assertions:**
- archived_excluded_from_default_resume
- same_titles_distinct_ids
- sort_stable
- search_and_status_combine
- no_results_has_clear_filters
- keyboard_selection_persists
- zero_extra_detail_requests_on_search

**Execution steps:**
- [ ] Read dependency outputs and associated tests; confirm file ownership with coordinator.
- [ ] Add the regression cases above using T01 synthetic fixtures or pure adapter tests; record expected assertions and the current failing behavior.
- [ ] Run the focused command below and record the intentional failing assertions; stop to repair infrastructure if assertions cannot execute.
- [ ] Move compact Resume/recent campaigns before world collection; reduce hero/stats vertical weight without rebranding.
- [ ] Provide searchable list/grid alternative, filters and sort for campaigns/worlds; preserve selected record and accessible result/empty counts.
- [ ] Debounce250ms; update matching collection nodes keyed by ID rather than rebuilding all unrelated sections. Retain filters per workspace/session, not canonical settings.
- [ ] Run focused checks again; expected all selected assertions pass, no newly skipped cases. Include build/type/boundary checks when affected.
- [ ] Browser/manual proof: 59campaign/39world fixture, repeated titles, archive toggle, desktop/narrow screenshots.
- [ ] Review complete scoped diff and git diff --check; obtain fresh task review; record evidence before marking accepted.
- [ ] Commit the task alone with an imperative summary, then hand dependency interface and commit hash to coordinator.

**Focused commands:**
```sh
corepack pnpm exec vitest run tests/unit/dashboard-ui.test.ts --exclude '**/.worktrees/**' --exclude '**/.codex/**'
corepack pnpm exec playwright test tests/e2e/legacy-ui-collections.e2e.test.ts
git diff --check
```

**Risk / rollback:** Do not introduce canonical pinned/favorite state without separate contract task; recent is based on existing timestamps, not undocumented telemetry. Roll back this task's code commit if its acceptance fails; preserve canonical records and version-compatible draft/preferences. No automatic cleanup of user data.

**Agent handoff:** Deliver T22 only. State deviations from the approved Interfaces block explicitly; do not silently rename cross-task APIs or remove an acceptance case.

### T23: Guide provider connection and isolate advanced tuning

**Dependencies:** T04

**Why / evidence:** Provider setup mixes connection requirements and tuning before users can establish a working model.

**Files / exclusive ownership:**
- Modify apps/web/public/index.html
- Modify apps/web/public/nexus.js
- Modify apps/web/public/nexus.css
- Modify tests/unit/legacy-provider-modal.test.ts
- Create tests/e2e/legacy-ui-provider-onboarding.e2e.test.ts

**Interfaces and decisions:** Provider readiness presentation uses existing inventory/health/capability responses, independently for text/image/embedding. States not-configured/checking/ready/unavailable; 'ready' means observed supported check, not successful narrative quality.

**Required regression cases and assertions:**
- roles_do_not_share_credentials
- inventory_failure_keeps_draft
- advanced_values_roundtrip
- no_generation_request_on_open
- missing_image_does_not_block_text
- capability_unknown_not_ready

**Execution steps:**
- [ ] Read dependency outputs and associated tests; confirm file ownership with coordinator.
- [ ] Add the regression cases above using T01 synthetic fixtures or pure adapter tests; record expected assertions and the current failing behavior.
- [ ] Run the focused command below and record the intentional failing assertions; stop to repair infrastructure if assertions cannot execute.
- [ ] Present role, endpoint and credentials first, then explicit model discovery/selection. Group context/output/temperature/structured-format tuning as Advanced.
- [ ] Show local inventory errors and recoverable retry without clearing fields. Do not reuse provider credentials across roles.
- [ ] Keep inventory refresh explicit and avoid generation probe/billable calls merely to open/save profile.
- [ ] Run focused checks again; expected all selected assertions pass, no newly skipped cases. Include build/type/boundary checks when affected.
- [ ] Browser/manual proof: Text-only setup, unavailable image provider and model inventory failure; mocked credentials only.
- [ ] Review complete scoped diff and git diff --check; obtain fresh task review; record evidence before marking accepted.
- [ ] Commit the task alone with an imperative summary, then hand dependency interface and commit hash to coordinator.

**Focused commands:**
```sh
corepack pnpm exec vitest run tests/unit/legacy-provider-modal.test.ts --exclude '**/.worktrees/**' --exclude '**/.codex/**'
corepack pnpm exec playwright test tests/e2e/legacy-ui-provider-onboarding.e2e.test.ts
git diff --check
```

**Risk / rollback:** Structured-output compatibility is existing policy; this task explains it rather than relaxing it. Roll back this task's code commit if its acceptance fails; preserve canonical records and version-compatible draft/preferences. No automatic cleanup of user data.

**Agent handoff:** Deliver T23 only. State deviations from the approved Interfaces block explicitly; do not silently rename cross-task APIs or remove an acceptance case.

### T24: Put errors and export destinations in the active workflow

**Dependencies:** T21

**Why / evidence:** Some errors are rendered into hidden panels, and reading-export instructions send users to archive export.

**Files / exclusive ownership:**
- Modify apps/web/public/nexus.js
- Modify apps/web/public/index.html
- Modify apps/web/src/story.js
- Modify apps/web/public/story.html
- Create tests/e2e/legacy-ui-errors-exports.e2e.test.ts
- Review tests/e2e/data-transfer.e2e.test.ts

**Interfaces and decisions:** Route-local status host per active workspace; error presentation uses textContent, safe correlation details and explicit retry. Link 'Reading copy' to the valid selected Story export menu; 'Backup archive' remains archive ZIP.

**Required regression cases and assertions:**
- startup_error_visible_on_dashboard
- retry_does_not_duplicate_writes
- html_error_rendered_as_text
- export_reading_goes_story
- archive_export_stays_zip
- missing_campaign_not_empty_adventure

**Execution steps:**
- [ ] Read dependency outputs and associated tests; confirm file ownership with coordinator.
- [ ] Add the regression cases above using T01 synthetic fixtures or pure adapter tests; record expected assertions and the current failing behavior.
- [ ] Run the focused command below and record the intentional failing assertions; stop to repair infrastructure if assertions cannot execute.
- [ ] Route startup worlds/campaigns/provider errors to visible active hosts; keep retry state independent so one failed list doesn't blank successful content.
- [ ] Distinguish missing campaign, permission/unavailable errors and empty campaign; persistent recovery actions supplement toasts.
- [ ] Correct Data Transfer copy and links, explaining reading formats versus restoration archives without automatically downloading anything.
- [ ] Run focused checks again; expected all selected assertions pass, no newly skipped cases. Include build/type/boundary checks when affected.
- [ ] Browser/manual proof: Fail each initial route independently; verify safe rendering and actionable export navigation.
- [ ] Review complete scoped diff and git diff --check; obtain fresh task review; record evidence before marking accepted.
- [ ] Commit the task alone with an imperative summary, then hand dependency interface and commit hash to coordinator.

**Focused commands:**
```sh
corepack pnpm exec playwright test tests/e2e/legacy-ui-errors-exports.e2e.test.ts tests/e2e/data-transfer.e2e.test.ts
git diff --check
```

**Risk / rollback:** Do not leak private server diagnostics or make exports at navigation time. Existing import/archive behavior stays intact. Roll back this task's code commit if its acceptance fails; preserve canonical records and version-compatible draft/preferences. No automatic cleanup of user data.

**Agent handoff:** Deliver T24 only. State deviations from the approved Interfaces block explicitly; do not silently rename cross-task APIs or remove an acceptance case.

### T25: Eliminate eager dashboard hydration and duplicate statistics

**Dependencies:** T05,T22

**Why / evidence:** Eager published-world detail requests added about798KB beyond the list and run even when their dashboard data is not needed.

**Files / exclusive ownership:**
- Modify apps/web/public/nexus.js
- Modify tests/unit/dashboard-ui.test.ts
- Create tests/e2e/legacy-ui-dashboard-loading.e2e.test.ts

**Interfaces and decisions:** Dashboard cards consume existing world.latestPreview summaries. getWorldDetails(worldId) fetches on explicit details/edit/create selection with scoped in-flight cache. One loadDashboardStats promise per initial load; failed promise evicted.

**Required regression cases and assertions:**
- dashboard_zero_eager_world_details
- providers_route_no_world_hydration
- one_initial_stats_get
- opening_detail_one_scoped_get
- failed_cache_can_retry
- edit_invalidates_cached_detail

**Execution steps:**
- [ ] Read dependency outputs and associated tests; confirm file ownership with coordinator.
- [ ] Add the regression cases above using T01 synthetic fixtures or pure adapter tests; record expected assertions and the current failing behavior.
- [ ] Run the focused command below and record the intentional failing assertions; stop to repair infrastructure if assertions cannot execute.
- [ ] Remove all-world Promise.all hydration at startup; use summary fallback placeholders where optional cover/detail is absent.
- [ ] Load full detail only for opened world; preserve T05 invalidation and response epochs. Defer route-specific initialization when no visible consumer requires it.
- [ ] Coalesce statistics requests and handle errors locally. Search/filter must not trigger per-world requests.
- [ ] Run focused checks again; expected all selected assertions pass, no newly skipped cases. Include build/type/boundary checks when affected.
- [ ] Browser/manual proof: Count requests/bytes on39world fixture and actual built assets; compare baseline with same fixture.
- [ ] Review complete scoped diff and git diff --check; obtain fresh task review; record evidence before marking accepted.
- [ ] Commit the task alone with an imperative summary, then hand dependency interface and commit hash to coordinator.

**Focused commands:**
```sh
corepack pnpm exec vitest run tests/unit/dashboard-ui.test.ts --exclude '**/.worktrees/**' --exclude '**/.codex/**'
corepack pnpm exec playwright test tests/e2e/legacy-ui-dashboard-loading.e2e.test.ts
git diff --check
```

**Risk / rollback:** No new world-summary API unless existing list demonstrably lacks a required basic card field; record that gap for audit instead of restoring N+1. Roll back this task's code commit if its acceptance fails; preserve canonical records and version-compatible draft/preferences. No automatic cleanup of user data.

**Agent handoff:** Deliver T25 only. State deviations from the approved Interfaces block explicitly; do not silently rename cross-task APIs or remove an acceptance case.

### T26: Load campaign Overview first and advanced tabs on demand

**Dependencies:** T03,T21

**Why / evidence:** Campaign selection serially waits for advanced requests; context preview alone took0.74–1.15seconds in the observed samples.

**Files / exclusive ownership:**
- Modify apps/web/public/nexus.js
- Create apps/web/src/legacy-section-loader.ts
- Modify apps/web/src/legacy-management-entry.ts
- Create tests/unit/legacy-section-loader.test.ts
- Create tests/e2e/legacy-ui-management-loading.e2e.test.ts

**Interfaces and decisions:** Section loader keyed by campaignId+selectionEpoch+section caches successful reads and coalesces in-flight requests; loadSection(section,signal). Overview requires only visible core fields. Context Preview builds only on explicit Preview or its required explicit action.

**Required regression cases and assertions:**
- overview_renders_while_preview_blocked
- advanced_requests_absent_before_open
- tab_open_coalesces_reads
- old_selection_never_overwrites_new
- save_invalidates_owned_section
- preview_explicit_only

**Execution steps:**
- [ ] Read dependency outputs and associated tests; confirm file ownership with coordinator.
- [ ] Add the regression cases above using T01 synthetic fixtures or pure adapter tests; record expected assertions and the current failing behavior.
- [ ] Run the focused command below and record the intentional failing assertions; stop to repair infrastructure if assertions cannot execute.
- [ ] Map each campaign tab to its true request dependencies; mark loading/error per tab. Render Overview as soon as required data arrives.
- [ ] Defer memory metrics,cost,embedding,illustration,imagejobs and context preview until their consumer tab/action; parallelize independent dependencies within opened section.
- [ ] Discard stale results, evict failed loads and invalidate affected sections after their save. Do not claim disabled/error sections are empty.
- [ ] Run focused checks again; expected all selected assertions pass, no newly skipped cases. Include build/type/boundary checks when affected.
- [ ] Browser/manual proof: Block context/memory metrics and verify title/editing available; switch campaigns rapidly and retry failed tab.
- [ ] Review complete scoped diff and git diff --check; obtain fresh task review; record evidence before marking accepted.
- [ ] Commit the task alone with an imperative summary, then hand dependency interface and commit hash to coordinator.

**Focused commands:**
```sh
corepack pnpm exec vitest run tests/unit/legacy-section-loader.test.ts --exclude '**/.worktrees/**' --exclude '**/.codex/**'
corepack pnpm exec playwright test tests/e2e/legacy-ui-management-loading.e2e.test.ts
git diff --check
```

**Risk / rollback:** Maintain StoryMemory preference's existing auto-save semantics. Do not reuse authority snapshots from another campaign. Roll back this task's code commit if its acceptance fails; preserve canonical records and version-compatible draft/preferences. No automatic cleanup of user data.

**Agent handoff:** Deliver T26 only. State deviations from the approved Interfaces block explicitly; do not silently rename cross-task APIs or remove an acceptance case.

### T27: Render accepted narration before optional illustration data

**Dependencies:** T08,T11

**Why / evidence:** Optional illustrations currently delay accepted narration; unavailable image configuration should not delay reading.

**Files / exclusive ownership:**
- Modify apps/web/src/story.js
- Modify tests/unit/story-player-ui.test.ts
- Create tests/e2e/legacy-ui-reader-loading.e2e.test.ts

**Interfaces and decisions:** Split core campaign hydration from loadReaderIllustrations(campaignId,loadEpoch). Required generation/runtime reconciliation remains authoritative; image success/failure applies only when scope/epoch match.

**Required regression cases and assertions:**
- blocked_image_does_not_block_narration
- image_failure_keeps_story
- stale_image_response_discarded
- pending_generation_remains_locked
- late_runtime_cannot_corrupt_selection

**Execution steps:**
- [ ] Read dependency outputs and associated tests; confirm file ownership with coordinator.
- [ ] Add the regression cases above using T01 synthetic fixtures or pure adapter tests; record expected assertions and the current failing behavior.
- [ ] Run the focused command below and record the intentional failing assertions; stop to repair infrastructure if assertions cannot execute.
- [ ] Render accepted turn/title/navigation after required core hydration and draft/recovery reconciliation, before waiting for image config/segments.
- [ ] Fetch optional image config and segments concurrently where dependencies permit; show nonblocking image loading/retry without blanking narration.
- [ ] Fence runtime/image/reader-position completions and preserve image-independent story generation; do not unlock generation before required state is ready.
- [ ] Run focused checks again; expected all selected assertions pass, no newly skipped cases. Include build/type/boundary checks when affected.
- [ ] Browser/manual proof: Delay image routes indefinitely; verify scene text and navigation, then release successful/failed images.
- [ ] Review complete scoped diff and git diff --check; obtain fresh task review; record evidence before marking accepted.
- [ ] Commit the task alone with an imperative summary, then hand dependency interface and commit hash to coordinator.

**Focused commands:**
```sh
corepack pnpm exec vitest run tests/unit/story-player-ui.test.ts --exclude '**/.worktrees/**' --exclude '**/.codex/**'
corepack pnpm exec playwright test tests/e2e/legacy-ui-reader-loading.e2e.test.ts
git diff --check
```

**Risk / rollback:** Reading readiness and generation readiness are different. Do not remove runtime data required by current-state editing or recovery. Roll back this task's code commit if its acceptance fails; preserve canonical records and version-compatible draft/preferences. No automatic cleanup of user data.

**Agent handoff:** Deliver T27 only. State deviations from the approved Interfaces block explicitly; do not silently rename cross-task APIs or remove an acceptance case.

### T28: Add a lightweight reader bootstrap only if the new baseline justifies it

**Dependencies:** T01,T27,T10; separate audit gate

**Why / evidence:** Initial sync/state payloads were large, but eliminating fields from frozen projections is unacceptable. This optional additive path needs a demonstrated post-client-optimization benefit.

**Files / exclusive ownership:**
- Modify packages/contracts/src/reader-history.ts
- Modify packages/application/src/reader-history/ports.ts
- Modify packages/application/src/reader-history/use-cases.ts
- Modify packages/database/src/reader-history-repository.ts
- Modify services/api/src/reader-history-routes.ts
- Modify packages/client-web/src/reader-history-api.ts
- Modify apps/web/src/story.js
- Modify tests/integration/reader-history.integration.test.ts
- Create tests/e2e/legacy-ui-reader-bootstrap.e2e.test.ts

**Interfaces and decisions:** Proposed GET /api/v1/campaigns/:campaignId/reader -> {campaign:publicReaderCampaignSchema,world:publicReaderWorldSchema,latestTurn:turnSummarySchema|null,activeTurnNumber:number,historyVersion:string}; readerSafe projections explicit allowlists. Does not replace generation sync/recovery; client generation controls stay locked until required sync/state is loaded.

**Required regression cases and assertions:**
- bootstrap_projection_no_private_canaries
- same_snapshot_latest_turn_and_count
- cross_owner_not_found
- generation_locked_until_sync
- late_bootstrap_not_overwrite_committed_turn
- old_server404_fallback
- old_contracts_identical

**Execution steps:**
- [ ] EVIDENCE GATE FIRST: review post-T27measurements before any tests/contracts/code. Record approval/deferral; deferred means stop, with no nonexistent bootstrap tests.
- [ ] If approved, enumerate exact projection fields and final allowlist in an audited contract addendum before implementation assignment.
- [ ] Read dependency outputs and associated tests; confirm file ownership with coordinator.
- [ ] Add the regression cases above using T01 synthetic fixtures or pure adapter tests; record expected assertions and the current failing behavior.
- [ ] Run the focused command below and record the intentional failing assertions; stop to repair infrastructure if assertions cannot execute.
- [ ] If approved, enumerate every displayed campaign/world field from current renderer into typed allowlists; perform one consistent scoped read snapshot and exclude lore/private state not needed for reading.
- [ ] Use additive route for first accepted-scene render only; reconcile existing sync/status/state workflow before enabling generation, and prevent late bootstrap from rolling back a newer accepted turn.404capability absence can fall back to existing loading;403never falls back to unscoped reads.
- [ ] Run focused checks again; expected all selected assertions pass, no newly skipped cases. Include build/type/boundary checks when affected.
- [ ] Browser/manual proof: Real PostgreSQL projection/isolation plus delayed sync browser fixture; compare actual bytes/request totals before accepting optimization.
- [ ] Review complete scoped diff and git diff --check; obtain fresh task review; record evidence before marking accepted.
- [ ] Commit the task alone with an imperative summary, then hand dependency interface and commit hash to coordinator.

**Focused commands:**
```sh
corepack pnpm exec vitest run --config vitest.integration.config.ts tests/integration/reader-history.integration.test.ts
corepack pnpm exec playwright test tests/e2e/legacy-ui-reader-bootstrap.e2e.test.ts
git diff --check
```

**Risk / rollback:** May increase total requests and introduce inconsistent intermediate state; reject unless measured benefit exceeds complexity. No database canonical change or global protocol replacement. Roll back this task's code commit if its acceptance fails; preserve canonical records and version-compatible draft/preferences. No automatic cleanup of user data.

**Agent handoff:** Deliver T28 only. State deviations from the approved Interfaces block explicitly; do not silently rename cross-task APIs or remove an acceptance case.

### T29: Remove duplicate image polling and redundant illustration renders

**Dependencies:** T27

**Why / evidence:** Initialization invokes polling twice, and pending polling fetches/renders unchanged full image collections.

**Files / exclusive ownership:**
- Modify apps/web/src/story.js
- Review apps/web/src/legacy-illustration-api.ts
- Review tests/unit/legacy-illustration-api.test.ts
- Create tests/e2e/legacy-ui-image-polling.e2e.test.ts

**Interfaces and decisions:** One poll loop per campaign+epoch;5000ms existing pending cadence retained. Compare job/segment version or stable public fields before rerender; stop when no pending jobs. No new image endpoint unless existing adapter can express requested projection.

**Required regression cases and assertions:**
- single_initial_poll
- no_idle_polling
- switch_cancels_old_loop
- unchanged_segments_do_not_rebuild
- image_failure_does_not_block_acceptance
- retry_only_image_job

**Execution steps:**
- [ ] Read dependency outputs and associated tests; confirm file ownership with coordinator.
- [ ] Add the regression cases above using T01 synthetic fixtures or pure adapter tests; record expected assertions and the current failing behavior.
- [ ] Run the focused command below and record the intentional failing assertions; stop to repair infrastructure if assertions cannot execute.
- [ ] Remove second initialization start and cancel timers on campaign switch/disposal.
- [ ] Coalesce pending polls and reuse unchanged segment data; lazy-load selected-turn segments if supported, otherwise avoid inventing an undocumented API.
- [ ] Keep explicit retry and optional image failure independent from story acceptance; do not lengthen durable image-recovery reconciliation without proof.
- [ ] Run focused checks again; expected all selected assertions pass, no newly skipped cases. Include build/type/boundary checks when affected.
- [ ] Browser/manual proof: Fake timers plus browser delayed image routes; count calls over two pending intervals and after completion.
- [ ] Review complete scoped diff and git diff --check; obtain fresh task review; record evidence before marking accepted.
- [ ] Commit the task alone with an imperative summary, then hand dependency interface and commit hash to coordinator.

**Focused commands:**
```sh
corepack pnpm exec vitest run tests/unit/legacy-illustration-api.test.ts --exclude '**/.worktrees/**' --exclude '**/.codex/**'
corepack pnpm exec playwright test tests/e2e/legacy-ui-image-polling.e2e.test.ts
git diff --check
```

**Risk / rollback:** Do not suppress provider job state transitions or change retry policy. Roll back this task's code commit if its acceptance fails; preserve canonical records and version-compatible draft/preferences. No automatic cleanup of user data.

**Agent handoff:** Deliver T29 only. State deviations from the approved Interfaces block explicitly; do not silently rename cross-task APIs or remove an acceptance case.

### T30: Batch streaming narration updates safely

**Dependencies:** T01,T27

**Why / evidence:** Streaming reparses growing narration each event. This is an unprofiled candidate, so batching must show benefit without changing validation/display safety.

**Files / exclusive ownership:**
- Modify apps/web/src/story.js
- Create apps/web/src/story-stream-renderer.ts
- Create tests/unit/story-stream-renderer.test.ts
- Create tests/e2e/legacy-ui-stream-rendering.e2e.test.ts

**Interfaces and decisions:** createStoryStreamRenderer({scheduleFrame,cancelFrame,renderSafe,onFollow}):{push(text,epoch):void;flush():void;reset(epoch):void;dispose():void}; one scheduled render/frame, last complete text wins. Existing sanitization is retained.

**Required regression cases and assertions:**
- many_chunks_one_render_per_frame
- final_flush_exact_text
- campaign_switch_drops_stale_buffer
- unsafe_markup_never_executes
- manual_scroll_stays_paused
- terminal_error_keeps_recoverable_ui

**Execution steps:**
- [ ] Read dependency outputs and associated tests; confirm file ownership with coordinator.
- [ ] Add the regression cases above using T01 synthetic fixtures or pure adapter tests; record expected assertions and the current failing behavior.
- [ ] Run the focused command below and record the intentional failing assertions; stop to repair infrastructure if assertions cannot execute.
- [ ] Profile deterministic rapid-chunk stream against T01baseline; capture parses/DOM replacements/long tasks, not assumed dropped-frame claims.
- [ ] Coalesce updates with requestAnimationFrame; keep final flush synchronous before accepted-render transition and reset stale epoch buffers.
- [ ] Preserve manual scroll pause, auto-follow, reduced-motion behavior, paragraph formatting and safe rendering for incomplete Markdown/HTML. No raw provider output displayed.
- [ ] Run focused checks again; expected all selected assertions pass, no newly skipped cases. Include build/type/boundary checks when affected.
- [ ] Browser/manual proof: Mock deterministic streaming, interrupted/failed output, manual scroll and final commit; screenshot partial/final states.
- [ ] Review complete scoped diff and git diff --check; obtain fresh task review; record evidence before marking accepted.
- [ ] Commit the task alone with an imperative summary, then hand dependency interface and commit hash to coordinator.

**Focused commands:**
```sh
corepack pnpm exec vitest run tests/unit/story-stream-renderer.test.ts --exclude '**/.worktrees/**' --exclude '**/.codex/**'
corepack pnpm exec playwright test tests/e2e/legacy-ui-stream-rendering.e2e.test.ts
git diff --check
```

**Risk / rollback:** Do not incrementally append unsanitized HTML. If batching shows no benefit or causes accessibility regression, retain the simpler safe renderer. Roll back this task's code commit if its acceptance fails; preserve canonical records and version-compatible draft/preferences. No automatic cleanup of user data.

**Agent handoff:** Deliver T30 only. State deviations from the approved Interfaces block explicitly; do not silently rename cross-task APIs or remove an acceptance case.

### T31: Bundle and minify legacy management without a route migration

**Dependencies:** Nexus integration barrier: T03,T04,T05,T06,T17,T18,T20,T21,T22,T23,T24,T25,T26 accepted; all Nexus shared-file writers stopped.

**Why / evidence:** nexus.js remains a363KBunminified public copy despite an existing Vite management entry.

**Files / exclusive ownership:**
- Modify apps/web/src/legacy-management-entry.ts
- Create apps/web/src/nexus.js (authoritative move)
- Remove apps/web/public/nexus.js after atomic cutover
- Modify package.json
- Modify scripts/check-repository-boundaries.mjs
- Modify scripts/legacy-migration-boundary.mjs
- Modify tests/unit/csp-ui.test.ts
- Modify tests/unit/web-build-contract.test.ts
- Modify tests/unit/management-ui.test.ts
- Modify tests/unit/dashboard-ui.test.ts
- Modify tests/unit/legacy-campaign-creation-ui.test.ts
- Modify tests/unit/legacy-story-memory-ui.test.ts
- Modify tests/unit/legacy-provider-modal.test.ts
- Modify apps/web/public/index.html
- Modify apps/web/vite.config.ts
- Review scripts/check-web-bundle-budget.mjs
- Create tests/unit/legacy-management-build.test.ts

**Interfaces and decisions:** Management entry owns startup and necessary exports; legacy HTML loads built /nexus/legacy-management.js with preserved route/global compatibility. Migrate public script to a Vite-owned source module only after inventory of window callbacks; optional heavy modules dynamic import.

**Required regression cases and assertions:**
- management_bootstraps_once
- public_globals_preserved_or_explicitly_replaced
- nexus_and_story_routes_resolve
- lazy_modules_absent_until_needed
- built_html_references_existing_asset
- no_duplicate_script_execution

**Execution steps:**
- [ ] Read dependency outputs and associated tests; confirm file ownership with coordinator.
- [ ] Add the regression cases above using T01 synthetic fixtures or pure adapter tests; record expected assertions and the current failing behavior.
- [ ] Run the focused command below and record the intentional failing assertions; stop to repair infrastructure if assertions cannot execute.
- [ ] Inventory HTML inline handlers/window globals and source-boundary tests. Plan a narrow move of nexus.js into apps/web/src/nexus.js if required; update all consumers atomically rather than maintaining two implementations.
- [ ] Update root syntax-check command to node --check apps/web/src/nexus.js and preserve boundary/migration/CSP protections at the new path. Inventory old-path references via rg; newly found consumers require approved allowlist additions.
- [ ] Approve regenerated T33/T34 manifests against the moved source before assignment.
- [ ] Make Vite minify management graph; retain stable entry revalidation and hashed lazy chunks. Avoid loading PhotoSwipe/advanced editors until needed.
- [ ] Update dev middleware/static HTML and tests to use the authoritative source path; build both clients and test real dist through runtime static serving.
- [ ] Run focused checks again; expected all selected assertions pass, no newly skipped cases. Include build/type/boundary checks when affected.
- [ ] Browser/manual proof: Built-runtime smoke for dashboard/world/campaign/provider/data-transfer and Story route coexistence; compare raw/gzip bytes.
- [ ] Review complete scoped diff and git diff --check; obtain fresh task review; record evidence before marking accepted.
- [ ] Commit the task alone with an imperative summary, then hand dependency interface and commit hash to coordinator.

**Focused commands:**
```sh
corepack pnpm exec vitest run tests/unit/legacy-management-build.test.ts tests/unit/csp-ui.test.ts tests/unit/web-build-contract.test.ts tests/unit/management-ui.test.ts tests/unit/dashboard-ui.test.ts tests/unit/legacy-campaign-creation-ui.test.ts tests/unit/legacy-story-memory-ui.test.ts tests/unit/legacy-provider-modal.test.ts --exclude '**/.worktrees/**' --exclude '**/.codex/**'
corepack pnpm check
corepack pnpm build
corepack pnpm check:web-bundle-budget
git diff --check
```

**Risk / rollback:** Large shared-file task runs alone. Existing source-extraction tests are consumers to update, not justification to keep duplicate source. Roll back this task's code commit if its acceptance fails; preserve canonical records and version-compatible draft/preferences. No automatic cleanup of user data.

**Agent handoff:** Deliver T31 only. State deviations from the approved Interfaces block explicitly; do not silently rename cross-task APIs or remove an acceptance case.

### T32: Compress static text with safe cache and streaming behavior

**Dependencies:** T31; separate operational review

**Why / evidence:** Observed static JS/HTML responses lacked compression; bytes can be reduced without altering application behavior.

**Files / exclusive ownership:**
- Modify services/api/src/server.ts
- Modify package.json only if supported compression dependency required
- Modify pnpm-lock.yaml only with approved dependency change
- Create tests/integration/legacy-static-assets.integration.test.ts
- Modify docs/runbooks/deployment.md

**Interfaces and decisions:** Enable appropriate static textual asset gzip/br negotiation with Vary:Accept-Encoding. Hashed assets immutable; HTML and stable legacy-client/management entries revalidate. SSE, range downloads, archives and generated streams stay on existing policies.

**Required regression cases and assertions:**
- gzip_and_identity_return_same_decoded_bytes
- br_supported_when_enabled
- vary_accept_encoding
- etag304_works
- stable_entry_not_immutable
- hashed_chunk_immutable
- sse_not_buffered
- archive_range_unchanged

**Execution steps:**
- [ ] Read dependency outputs and associated tests; confirm file ownership with coordinator.
- [ ] Add the regression cases above using T01 synthetic fixtures or pure adapter tests; record expected assertions and the current failing behavior.
- [ ] Run the focused command below and record the intentional failing assertions; stop to repair infrastructure if assertions cannot execute.
- [ ] Inspect current static/proxy topology and supported Fastify compression option; choose precompressed build assets or scoped server plugin based on actual deployment. Record dependency justification before adding one.
- [ ] Configure only static text compression/cache semantics; preserve ETag/304, HEAD, Content-Type and range behavior. Do not compress SSE automatically.
- [ ] Document built-image smoke and rollback. No production deployment is part of execution authorization.
- [ ] Run focused checks again; expected all selected assertions pass, no newly skipped cases. Include build/type/boundary checks when affected.
- [ ] Browser/manual proof: Real built runtime response headers plus browser network panel; deterministic SSE first-event delivery check.
- [ ] Review complete scoped diff and git diff --check; obtain fresh task review; record evidence before marking accepted.
- [ ] Commit the task alone with an imperative summary, then hand dependency interface and commit hash to coordinator.

**Focused commands:**
```sh
corepack pnpm exec vitest run --config vitest.integration.config.ts tests/integration/legacy-static-assets.integration.test.ts
corepack pnpm check
corepack pnpm build
corepack pnpm check:web-bundle-budget
git diff --check
```

**Risk / rollback:** Compression can buffer streaming and destabilize cache negotiation. Operational review required before rollout; do not claim topology changes authorized. Roll back this task's code commit if its acceptance fails; preserve canonical records and version-compatible draft/preferences. No automatic cleanup of user data.

**Agent handoff:** Deliver T32 only. State deviations from the approved Interfaces block explicitly; do not silently rename cross-task APIs or remove an acceptance case.

### T33: Name dialogs and complete tab keyboard semantics

**Dependencies:** T04,T15,T18,T21

**Why / evidence:** Unnamed Story dialogs and incomplete tabs make keyboard/screen-reader navigation less reliable.

**Files / exclusive ownership:**
- Modify apps/web/public/story.html
- Modify apps/web/public/index.html
- Modify apps/web/src/story.js
- Modify apps/web/public/nexus.js
- Review apps/web/src/story-keyboard.js
- Create tests/e2e/legacy-ui-accessibility.e2e.test.ts

**Interfaces and decisions:** Every dialog uses aria-labelledby on a visible unique heading; every tablist has role/tab/tabpanel,aria-controls,aria-selected and roving tabindex. Horizontal arrows/Home/End activate/focus consistently with existing campaign-tabs pattern.

**Required regression cases and assertions:**
- every_open_dialog_has_accessible_name
- tab_selected_and_panel_consistent
- arrows_home_end_scoped
- escape_top_dialog_only
- focus_returns_to_trigger
- status_not_announced_each_chunk

**Execution steps:**
- [ ] Read dependency outputs and associated tests; confirm file ownership with coordinator.
- [ ] Add the regression cases above using T01 synthetic fixtures or pure adapter tests; record expected assertions and the current failing behavior.
- [ ] Run the focused command below and record the intentional failing assertions; stop to repair infrastructure if assertions cannot execute.
- [ ] Inventory actual dialog headings including message/history/activity/character/state/retry/profile; add stable IDs and correct focus entry/return without altering recovery Escape rules.
- [ ] Implement world-author/edit-state tabs with one scoped helper; keep campaign tabs existing correct behavior and no global key interception in text fields.
- [ ] Announce loading/save/error status politely or assertively based on urgency, avoiding repeated streaming announcements per chunk.
- [ ] Run focused checks again; expected all selected assertions pass, no newly skipped cases. Include build/type/boundary checks when affected.
- [ ] Browser/manual proof: Keyboard-only full reading/setup paths and screen-reader manual smoke; record tool/browser/version and untested platforms.
- [ ] Review complete scoped diff and git diff --check; obtain fresh task review; record evidence before marking accepted.
- [ ] Commit the task alone with an imperative summary, then hand dependency interface and commit hash to coordinator.

**Focused commands:**
```sh
corepack pnpm exec playwright test tests/e2e/legacy-ui-accessibility.e2e.test.ts
git diff --check
```

**Risk / rollback:** Do not conflate automated accessible-name checks with full screen-reader certification. Roll back this task's code commit if its acceptance fails; preserve canonical records and version-compatible draft/preferences. No automatic cleanup of user data.

**Agent handoff:** Deliver T33 only. State deviations from the approved Interfaces block explicitly; do not silently rename cross-task APIs or remove an acceptance case.

### T34: Honor reduced motion, comfortable targets and zoom layout

**Dependencies:** T12,T33

**Why / evidence:** Small controls and unconditional smooth motion reduce comfort. Narrow layout was broadly functional but needs focused interaction checks.

**Files / exclusive ownership:**
- Modify apps/web/public/story.css
- Modify apps/web/public/nexus.css
- Modify apps/web/public/navigation.css
- Modify apps/web/src/story.js
- Modify apps/web/public/nexus.js
- Modify tests/e2e/legacy-ui-accessibility.e2e.test.ts

**Interfaces and decisions:** prefers-reduced-motion:reduce disables nonessential animation and uses instant scroll; hit-area target44x44px where layout permits. Desktop first with390x844secondary and200%zoom.

**Required regression cases and assertions:**
- reduced_motion_no_smooth_scroll
- focus_not_hidden_by_sticky_toolbar
- controls_no_overlap_at_zoom
- narrow_page_no_horizontal_overflow
- dialog_actions_reachable

**Execution steps:**
- [ ] Read dependency outputs and associated tests; confirm file ownership with coordinator.
- [ ] Add the regression cases above using T01 synthetic fixtures or pure adapter tests; record expected assertions and the current failing behavior.
- [ ] Run the focused command below and record the intentional failing assertions; stop to repair infrastructure if assertions cannot execute.
- [ ] Apply reduced-motion CSS and scroll-behavior policy to programmatic reader/world navigation; leave essential progress feedback understandable.
- [ ] Increase clear/refresh/profile/image/navigation targets through padding or hit areas, preserving density and preventing overlap.
- [ ] Verify sticky toolbar/dialogs/tablists/collections at zoom and narrow width; prevent page overflow while explicitly scrollable rails remain identifiable.
- [ ] Run focused checks again; expected all selected assertions pass, no newly skipped cases. Include build/type/boundary checks when affected.
- [ ] Browser/manual proof: Capture desktop/narrow/200%zoom and reduced-motion preference; measure target rectangles and contrast.
- [ ] Review complete scoped diff and git diff --check; obtain fresh task review; record evidence before marking accepted.
- [ ] Commit the task alone with an imperative summary, then hand dependency interface and commit hash to coordinator.

**Focused commands:**
```sh
corepack pnpm exec playwright test tests/e2e/legacy-ui-accessibility.e2e.test.ts
git diff --check
```

**Risk / rollback:** 44pxis a comfort goal; report WCAG24px/spacing compliance separately rather than asserting every smaller control is a failure. Roll back this task's code commit if its acceptance fails; preserve canonical records and version-compatible draft/preferences. No automatic cleanup of user data.

**Agent handoff:** Deliver T34 only. State deviations from the approved Interfaces block explicitly; do not silently rename cross-task APIs or remove an acceptance case.

### T35: Run end-to-end integration and performance acceptance

**Dependencies:** All implemented T01-T34; T28 may be explicitly deferred

**Why / evidence:** Individually passing chunks can still conflict in shared legacy startup and persistence. The release needs whole-flow evidence, not scattered unit claims.

**Files / exclusive ownership:**
- Create tests/e2e/legacy-ui-journeys.e2e.test.ts
- Create docs/review/legacy-ui-2026-10-03/verification.md
- Create docs/review/legacy-ui-2026-10-03/performance.md
- Create docs/review/legacy-ui-2026-10-03/rollout.md

**Interfaces and decisions:** Release record maps taskID -> commit -> tests -> screenshots -> pass/fail/skip. Report browser mocked, real PostgreSQL deterministic, built runtime and live-provider evidence separately.

**Required regression cases and assertions:**
- whole_journey_no_lost_draft
- existing_campaign_version_unchanged
- duplicate_create_and_generation_guard
- cross_campaign_private_canaries_absent
- image_failure_independent
- existing_routes_and_contracts_compatible
- performance_budgets_met_or_audited_exception

**Execution steps:**
- [ ] Read dependency outputs and associated tests; confirm file ownership with coordinator.
- [ ] Add the regression cases above using T01 synthetic fixtures or pure adapter tests; record expected assertions and the current failing behavior.
- [ ] Run the focused command below and record the intentional failing assertions; stop to repair infrastructure if assertions cannot execute.
- [ ] Run new-user world->character->draft save->publish->campaign create->first accepted mocked turn->reload draft->history->resume, plus experienced-user advanced-edit/save paths.
- [ ] Run focused and applicable full suites, check/build/boundary/bundle checks and documented read-contract integrations; compare baseline fixture metrics and preserve old/replacement client compatibility.
- [ ] Capture every changed visible flow, archive sanitized reports and audit complete diff. Separate code rollback from local draft/preference compatibility; no database down migration or content purge.
- [ ] Prepare rollout sequence and smoke checklist with explicit deployment authorization gate. A failed/skipped required gate blocks a completion claim; live model quality remains outside deterministic tests.
- [ ] Run focused checks again; expected all selected assertions pass, no newly skipped cases. Include build/type/boundary checks when affected.
- [ ] Browser/manual proof: Desktop/narrow, keyboard, zoom, themes, restart/reload and delayed/failing dependencies. Store screenshots under docs/review/assets/legacy-ui-2026-10-03/.
- [ ] Review complete scoped diff and git diff --check; obtain fresh task review; record evidence before marking accepted.
- [ ] Commit the task alone with an imperative summary, then hand dependency interface and commit hash to coordinator.

**Focused commands:**
```sh
corepack pnpm exec playwright test tests/e2e/legacy-ui-journeys.e2e.test.ts
corepack pnpm check
corepack pnpm build
corepack pnpm check:web-bundle-budget
git diff --check
```

**Risk / rollback:** Do not deploy, make billable provider calls or mutate live user campaigns from synthetic verification. Whole-branch reviewer must audit exceptions. Roll back this task's code commit if its acceptance fails; preserve canonical records and version-compatible draft/preferences. No automatic cleanup of user data.

**Agent handoff:** Deliver T35 only. State deviations from the approved Interfaces block explicitly; do not silently rename cross-task APIs or remove an acceptance case.

## Whole-program verification commands

Run applicable focused checks per task, then T35:
```sh
corepack pnpm test:unit --exclude '**/.worktrees/**' --exclude '**/.codex/**'
corepack pnpm test:integration
corepack pnpm check
corepack pnpm build
corepack pnpm check:web-bundle-budget
corepack pnpm exec playwright test tests/e2e/legacy-ui-*.e2e.test.ts
git diff --check
```

Playwright wildcard behavior depends on shell; if no specs are selected, pass the explicit new file list from task manifests. Zero selected tests is not a pass. Database suites must run with real PostgreSQL; the isolated root integration runner provisions its own dedicated database.

Inspect existing generation/illustration/recovery integrations when UI wiring changes, but do not expand scope to provider runtime fixes. Run existing legacy/replacement route coexistence checks after T31/T32. Full suite failures remain failures even if baseline-related; record baseline comparison and cause.

Before T32/T35 release preparation, verify identity/ownership and current API/application composition guidelines again. API search/lookups must prove corrected narration, cross-owner/campaign isolation and safe public projections. No task may move raw provider output or private mechanics into story history.

## Proposed performance proof

Use deterministic synthetic campaigns0/1/50/317/2000turns and39published worlds/59campaigns for browser request/card checks. Real database benchmarks use the existing documented fixture sets unchanged; do not overwrite historical evidence.

Record before/after:
- Startup request list, bytes, number of eager detail requests and duplicate stats.
- Time accepted narration becomes visible when image/config/advanced routes are artificially blocked.
- Overview availability before advanced routes settle.
- History-open requests, rendered card count,total DOM nodes and full-ledger loads.
- Search old-turn correctness, query p50/p95, query count and EXPLAIN results.
- Streaming renders/frames,long tasks,exact final narration and manual scroll behavior.
- Raw/gzip/br static sizes,ETag/cache headers and real SSE first-event behavior.
- Browser/OS/device,CPU/cache/build mode,commit,fixture seed and sample count.

Budget failures require a specific reviewed exception, not hiding a benchmark or deleting an assertion. Favor deterministic request/DOM/delay checks over flaky absolute browser milliseconds.

## Coverage mapping: audit finding -> work package

| Finding | Implementation tasks |
| --- | --- |
| E01 ordinary input lost/Autosaved misleading | T07,T08 |
| E02 campaign edits lost | T02,T03 |
| E03 inconsistent dismissal | T02,T04 |
| E04 wrong world navigation | T05,T21 |
| E05 invalid remembered resume | T06 |
| E06 unbounded/mispositioned history | T10,T13,T14,T15 |
| E07 broad prose/remote navigation | T09,T12,T34 |
| E08 dense authoring/nested save confusion | T04,T17,T18 |
| E09 reading position/hidden choice mode | T09,T11,T16 |
| E10 creation preference divergence | T19,T20 |
| E11 workspace/collection navigation | T21,T22 |
| E12 mixed save/errors/export destination | T03,T24 |
| E13 hydration/search/cache waste | T05,T22,T25 |
| E14 advanced-request waterfall | T26 |
| E15 optional images/stream/polling | T27,T29,T30; conditional T28 |
| E16 accessibility/motion gaps | T33,T34; themed contrast T12 |
| E17 management build/compression | T31,T32 |
| E18 asynchronous world race | T05; other async consumers T11,T15,T26,T27 |
| Evidence and integrated release uncertainty | T01,T35 |

## Preimplementation decision checklist

The independent auditor must review proposals, not assume everything in this plan is approved product policy:
- [ ] Draft retention30days/50entries and stale-base restoration choices are proportionate.
- [ ] Reader appearance defaults72ch/18px/1.7/dark preserve user intent and advanced settings.
- [ ]50cardhistory pages and10scenecontinuous windows retain usable access to all history.
- [ ] Full-campaign literal text search is valuable enough for additive API scope; effective corrections and ownership are correct.
- [ ] T28bootstrap is optional and cannot weaken generation readiness; require its own post-baseline go/no-go.
- [ ] Management bundling move is narrower than a rewrite and all known consumers are preserved.
- [ ] Compression/cache choice fits current static/deployment topology without buffering SSE.
- [ ] Test infrastructure can actually execute, including new route adapters/contract exports and browser builds.
- [ ] Each task's integration dependencies and shared-file locks are workable.
- [ ] No source finding is represented as measured production performance.

## Planning self-review

- Coverage: all18evidence groups mapped above, plus measurable baseline/release gates.
- Interfaces: storage clock,id factory and transaction port injected; immutable draft revisions and cross-tab conflict policy explicit; read adapters behind shared contracts; renamed source path handled after T31.
- Architecture: added history routes use application ports/database adapters; no backend reads directly in DOM modules; existing frozen read contracts preserved.
- Scope:35work packages; no implementation, production deployment or live-provider test performed during planning.
- Proportion: this plan is intentionally detailed at user request; it specifies decisions and checks without prescribing entire implementation bodies.
- Independent audit: fresh reviewer found A01–A07; all were revised and confirmed resolved. Final capacity/browser-close clarifications are recorded. See audit-packet.md; execution conditions remain explicit.

## Execution authorization boundary

After the independent plan audit is accepted, present the plan and audit findings to the user for implementation authorization. The current request is to prepare a plan in a new worktree. Do not start T01environment installation or application changes merely because the plan contains executable commands.
