# Task 1 report: Story-only campaign policy contracts

Base: `eac2ce16` (`2efb4a3c` plus the controller's plan/spec checkpoint)
Commit: `9f892c4f` (amended below to include this recorded SHA)

## Delivered interfaces

- `campaignTurnControlStyleSchema` accepts only `action_only`, `flexible_action`, and `flexible_scene` for active writes and projections.
- `historicalCampaignTurnControlStyleSchema` retains `flexible_auto` only for historical decoding.
- `storyOnlyPromptSnapshotSchema` and strict `generationPolicySnapshotSchema` require a consistent style/play-mode pair. The story-only branch also requires its frozen protocol and prompt fields.
- `CampaignPlayMode`, `CampaignTurnControlStyle`, `HistoricalCampaignTurnControlStyle`, `StoryOnlyPromptSnapshot`, and `GenerationPolicySnapshot` are exported from the contracts barrel.
- `normalizeHistoricalTurnControlStyle`, `campaignPlayModeForControlStyle`, and `generationStagePolicy` are exported from the domain barrel. Story-only disables RPG assessment, event evaluation, and scene coverage; there is no classification policy stage.
- Campaign creates now default to `flexible_action`. Campaign updates expose optional `expectedTurnControlStyle`, `expectedActiveTurnNumber`, and `expectedStateRevision` transition-fence fields without treating fences alone as an update. Server-side changed-style enforcement is owned by Task 2.
- Historical jobs may omit `generationPolicy`; their stored resolved input mode remains readable without fabricating a new policy. `historicalUserSettingsSchema` provides the matching profile-preference decode, but the database profile read/write boundary has not adopted it yet.

## RED/GREEN evidence

- RED: `node node_modules/vitest/vitest.mjs run tests/unit/campaign-generation-policy.test.ts`
  - Failed before production code as intended: module `../../packages/contracts/src/campaign-generation-policy.js` did not exist.
- GREEN: `node node_modules/vitest/vitest.mjs run tests/unit/campaign-generation-policy.test.ts tests/unit/generation.test.ts tests/unit/campaign-state-contract.test.ts tests/unit/story-settings.test.ts tests/unit/application/world-campaign-use-cases.test.ts tests/unit/client-web/api-client.test.ts`
  - Passed: 6 files, 70 tests.
- Application type check: `pnpm --filter @infinite-quest/application check`
  - Passed.
- Diff hygiene: `git diff --check`
  - Passed.

## Deferred and skipped checks

- `pnpm --filter @infinite-quest/contracts check` remains blocked by `tests/e2e/quiet-leaf-story.e2e.test.ts:38`: its existing Task 7-owned Auto UI scenario supplies `flexible_auto`, which the closed active request type now rejects. The planned UI implementation must replace that scenario with the revised Action/Story Direction behavior. This task did not alter the executable UI early merely to make the aggregate typecheck pass.
- PostgreSQL/integration behavior was not run: Task 1 changes contracts only. Task 2 owns the migration, persisted policy, server-side transition fencing, and adoption of `historicalUserSettingsSchema` at `packages/database/src/world-generation-repository.ts` profile reads/writes.
- Browser and live-provider checks were not run: no UI or provider behavior is owned by this task.

## Scope notes

Active request and public projection fixtures that directly used the removed Auto value were normalized to `flexible_action`. Historical direct database fixtures remain untouched where they exercise legacy data compatibility. The controller-owned plan and specification edits are intentionally not included in this task commit.
