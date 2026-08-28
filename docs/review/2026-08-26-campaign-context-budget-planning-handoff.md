# Campaign-Owned Story Context Budget: Planning Handoff

**Status:** Ready for implementation planning; no campaign-owned implementation has begun.
**Prepared:** 2026-08-26
**Working tree:** C:\Users\chris\.codex\worktrees\7a24\InfiniteQuest
**Decision:** Refactor the browser-scoped prototype in this worktree. Do not abandon it or create a replacement worktree merely to plan this change.

## Purpose

This handoff gives the next agent the confirmed starting state and required decisions for a test-first implementation plan. It is not the implementation plan itself.

The product direction changed after the initial Story UI work: the selected Story context budget must be a durable campaign configuration, configured outside the Story page, rather than a browser-local preference.

## Desired outcome

Each campaign owns one desired Story context-budget target. Campaign configuration is the only place that changes it. Future generation requests for that campaign use it; the runtime still reserves output/protocol space and clamps to the active provider/model window.

The Story page must no longer be the authority for this setting. The final UX may show the effective campaign value read-only, or omit it from the composer entirely, but must not offer a competing editable preference.

## Confirmed current behavior

The uncommitted prototype added browser-local presets: 32K, 64K, 128K, 256K, and up to 1M. It stores the choice under infinite-quest.story.context-budget-tokens, then sends it in request.context.budgetTokens for append and retry requests.

The existing API contract accepts context.budgetTokens from 512 through 1,000,000 and snapshots request context into durable generation jobs. The runtime later clamps that snapshot to the provider/model envelope. This was a pure UI change only while the setting remained browser-scoped.

Moving ownership to campaigns is therefore not a pure UI change: it needs an additive database field, contract/API projection changes, and server-side generation enforcement.

## Starting worktree and preservation rule

The worktree contains only this focused Story-context feature work plus its planning/spec documents. Do not use git reset, git checkout --, or otherwise discard it. Reuse its tests and preset/normalization logic while changing the persistence boundary.

Current modified files:

- apps/web-next/src/campaign-editor-page.ts
- apps/web-next/src/story-player-generation.ts
- apps/web-next/src/story-player-model.ts
- apps/web-next/src/story-player-page.ts
- apps/web-next/src/story-player-view.ts
- apps/web-next/src/story-player.css
- apps/web/public/story.css
- apps/web/public/story.html
- apps/web/src/story.js
- docs/concepts/context-construction.md
- docs/player-guide/turn-input-modes.md
- packages/client-core/src/index.ts
- tests/unit/story-player-ui.test.ts
- tests/unit/web-next-campaign-editor.test.ts
- tests/unit/web-next-story-composer.test.ts
- tests/unit/web-next-story-generation.test.ts
- tests/unit/web-next-story-model.test.ts

Current untracked files:

- docs/superpowers/plans/2026-08-26-story-context-budget-control.md
- docs/superpowers/specs/2026-08-26-story-context-budget-control-design.md
- packages/client-core/src/story-context-budget.ts
- tests/unit/client-core/story-context-budget.test.ts
- this handoff document

The temporary Docker review environment, its containers, network, volumes, dedicated image, and ignored Compose/environment files were removed. Production was verified healthy on port 8080 and must remain out of scope.

## What to retain from the prototype

Keep, subject to adapting tests:

- STORY_CONTEXT_BUDGET_PRESETS, DEFAULT_STORY_CONTEXT_BUDGET_TOKENS, and the preset normalization logic in packages/client-core/src/story-context-budget.ts.
- The request-propagation seam in apps/web-next/src/story-player-generation.ts and apps/web/src/story.js.
- Append/retry behavior tests; they establish that the value must be captured before asynchronous Auto intent classification and reused by retry flows.
- The documentation distinction between a requested target and a provider's actual usable window.

Replace or remove:

- localStorage load/save helpers and the browser-global storage key.
- StoryUiState.contextBudgetTokens as the durable source of truth.
- Editable Story-page controls in both Story UIs, including the legacy retry-dialog duplicate control.
- Documentation that describes the preference as browser-scoped.

## Recommended persistence design

Add an authoritative campaigns.story_context_budget_tokens integer column with a non-null default of 32000 and an appropriate 512–1,000,000 check. It belongs beside story_length_profile and turn_control_style, not in:

- campaign_memory_configs, which is semantic-retrieval/embedding configuration;
- legacy_settings, which is compatibility data rather than an authoritative current setting; or
- generation_jobs, which is the immutable per-job snapshot rather than the campaign default.

Use the existing PATCH /api/v1/campaigns/:campaignId route and campaign-summary/sync projections. Add the field to campaign create defaults as well.

At enqueue time, the API/repository must derive context_options.budgetTokens from the campaign row and overwrite or reject a client-provided budget. Merely treating the campaign value as a fallback is insufficient: an older client could continue overriding configuration. Existing job snapshots remain unchanged; only future append/retry submissions use the new campaign setting.

## Required behavior and invariants

- Existing campaigns migrate to 32K without rewriting accepted turns, campaign state, Chronicle memory, or existing generation jobs.
- A saved campaign setting applies to later append and retry-latest generations, regardless of browser, UI surface, or stale client local storage.
- Provider/model context-window discovery and runtime clamping remain unchanged.
- Updating this setting must not queue Chronicle reindexing or mutate accepted turns; it changes retrieval composition only for future jobs.
- Branch, cross-world transfer, portable import/export, and legacy import preserve or correctly default the setting.
- A generation job retains its enqueued context snapshot even if campaign configuration later changes.
- All data remains owner- and campaign-scoped.
- Root historical index.html is out of scope. Active legacy surfaces are under apps/web/public; the replacement UI is apps/web-next.

## Implementation seams the plan must cover

### Contracts, migration, and campaign projections

- Add migration database/migrations/0078_*.sql. The current latest migration is 0077_chronicle_chunk_processed_signature.sql.
- Extend campaignCreateSchema and campaignUpdateSchema in packages/contracts/src/world-library.ts.
- Extend campaignSummarySchema and campaignSyncCampaignSchema in packages/contracts/src/client-api.ts.
- Extend application views/types in packages/application/src/world-campaign/types.ts.
- Update campaign create, list, update, and sync queries in packages/database/src/world-repository.ts and packages/database/src/campaign-state-repository.ts.
- The existing campaign PATCH route in services/api/src/server.ts remains the configuration write path.

### Generation enforcement

- Update packages/database/src/generation-repository.ts. Its enqueue lock currently loads provider, story length, and input style, then copies request.context into context_options.
- Load the durable campaign budget in that same locked query and use it to construct the job snapshot.
- Confirm every append and retry-latest route reaches this shared enqueue boundary. Do not rely on either UI to enforce ownership.

### Campaign lifecycle preservation

- Branch cloning in packages/database/src/campaign-state-repository.ts.
- Cross-world transfer in packages/database/src/campaign-transfer-character-repository.ts.
- Campaign creation in packages/database/src/world-repository.ts.
- Legacy and portable imports in packages/database/src/portable-import-family-repository.ts.
- Archive export composition in services/runtime/src/campaign-archive-export-composition.ts.

The plan must decide the portable field name and import fallback. Exported settings already carry storyLength and turnControlStyle; use a similarly explicit portable value rather than raw database-column coupling.

### UI changes

- Replacement campaign overview: apps/web-next/src/campaign-editor-page.ts and apps/web-next/src/campaign-editor-api.ts.
- Legacy Setup Campaign editor: apps/web/public/index.html, apps/web/public/nexus.js, and apps/web/public/nexus.css.
- Replacement Story Player: apps/web-next/src/story-player-model.ts, story-player-page.ts, story-player-view.ts, story-player-generation.ts, and story-player.css.
- Legacy Story Player: apps/web/public/story.html, story.css, and apps/web/src/story.js.

The campaign editors should use the shared preset list. Do not repurpose the Chronicle context-preview budget input: it is intentionally preview-only and may remain independent.

## Test-first expectations

Start each layer with RED tests before production edits. At minimum cover:

1. Migration default and check constraint for existing campaigns.
2. Campaign create/update/list/sync response includes the setting and validates it.
3. Generation append and retry use the campaign budget even when the caller sends a different value.
4. Existing generation-job context snapshots do not change after a campaign configuration update.
5. Branch and cross-world transfer preserve the setting.
6. Import/export round-trip preserves it; missing historic field defaults to 32K.
7. Both campaign editors save and reload the selected option.
8. Both Story Players use the campaign-projected setting and have no editable browser-local setting.
9. Provider-window clamping remains a runtime behavior and is unaffected by campaign configuration.

Existing tests to adapt or extend:

- tests/unit/client-core/story-context-budget.test.ts
- tests/unit/web-next-story-model.test.ts
- tests/unit/web-next-story-generation.test.ts
- tests/unit/web-next-story-composer.test.ts
- tests/unit/story-player-ui.test.ts
- tests/unit/web-next-campaign-editor.test.ts
- tests/unit/management-ui.test.ts
- tests/unit/generation.test.ts
- tests/integration/generation.integration.test.ts
- tests/integration/campaign-authority-repository.integration.test.ts
- tests/integration/campaign-archive.integration.test.ts
- tests/integration/migrations.integration.test.ts

## Verified baseline before the ownership decision

The browser-scoped prototype passed this focused suite:

~~~powershell
.\node_modules\.bin\vitest.cmd run tests/unit/client-core/story-context-budget.test.ts tests/unit/web-next-story-model.test.ts tests/unit/web-next-story-composer.test.ts tests/unit/web-next-story-generation.test.ts tests/unit/web-next-campaign-editor.test.ts tests/unit/story-player-ui.test.ts tests/unit/client-web/pending-submissions.test.ts tests/unit/generation.test.ts
~~~

Result: 8 files, 179 tests passed.

Also passed:

~~~powershell
pnpm check
pnpm build:web:legacy
pnpm build:web:next
git diff --check
~~~

The prior Docker review stack was deliberately destroyed after review. Do not claim it is still available or runtime-verified for the campaign-owned design.

## Planning questions to resolve explicitly

1. Is the persisted value constrained to the five UI presets, or may API clients use any contract-valid integer? The prototype uses five UI presets while the current generation contract permits any 512–1,000,000 integer.
2. Should Story pages show a read-only Story context value or omit it entirely?
3. Does retry-latest use the campaign's current setting, or reproduce the original job snapshot? Recommended default: the current campaign setting, because retry creates a new generation job.
4. What portable export field and versioning behavior preserve the setting without breaking older imports?
5. Which integration suite is the best PostgreSQL proof for branch/transfer/archive propagation?
6. Does changing active campaign configuration need an optimistic updated-at/revision guard, or is the existing campaign PATCH behavior sufficient?

## Suggested planning order

1. Confirm the semantic decisions above and write the updated specification.
2. Map migration and contract propagation before any Story UI removal.
3. Plan server-side enqueue enforcement and generation-snapshot proof.
4. Plan lifecycle propagation: branch, transfer, import, and export.
5. Plan both campaign editors, then simplify both Story UIs.
6. End with focused tests, PostgreSQL integration tests, both UI builds, and a fresh isolated Docker/browser review.

## Explicit non-goals

- Changing provider discovery or provider request payloads.
- Raising the existing API maximum above 1M.
- Reindexing Chronicle automatically after a budget change.
- Rewriting accepted turns, campaign state, or historic generation jobs.
- Restoring or using removed Docker review data.
- Touching the running production Compose project.
