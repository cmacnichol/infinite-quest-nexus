# Task 8 report — durable story generation

## Delivered scope

- Added `StoryGenerationController`, the single web-next coordinator for the shared `GenerationWorkflow` and `CampaignStoreController` projection session.
- Submission derives the append expected turn number from authoritative campaign state, creates one idempotency key per new request, and leaves replay ownership to the shared workflow.
- Turn-zero opening submits the persisted `world.firstAction` with `inputModeSource: "opening_action"`; no opening text is invented in the client.
- Streaming narration remains a store projection preview. Accepted turns change only when the shared campaign store receives a completed durable result.
- Page-level generation polling was removed. Monitoring is one abortable watcher per attached run; stale campaign/disposed completions are ignored.
- Added distinct durable Resume monitoring, Retry generation/result, Cancel, and Discard actions. Failed cancellation keeps the attached run monitored.
- Completion selects the persisted turn and clears only the submitted composer draft/provenance. It preserves the reader width and does not couple text completion to illustration success or provider state.
- The reader shows a non-authoritative full-width preview while generation is active and hides previous/next navigation. Degraded transport is presented without changing authoritative turns.

## TDD evidence

1. RED: `tests/unit/web-next-story-generation.test.ts` initially failed because `story-player-generation` did not exist.
2. GREEN: the new controller tests pass after implementation, including opening provenance, non-authoritative streaming/completion hand-off, failed cancel behavior, and disposal.

## Verification

- `./node_modules/.bin/vitest.CMD run tests/unit/web-next-story-generation.test.ts tests/unit/web-next-story-page.test.ts tests/unit/client-core/generation-workflow.test.ts tests/unit/client-core/campaign-store.test.ts tests/unit/story-generation-monitor.test.ts tests/unit/story-player-ui.test.ts`
  - PASS: 6 files, 152 tests.
- `pnpm --filter @infinite-quest/web-next check`
  - PASS.
- `pnpm --filter @infinite-quest/web-next build`
  - PASS when run outside the filesystem sandbox; Vite needs to resolve workspace paths above the linked worktree. It emitted only the pre-existing runtime-font resolution notices.
- `git diff --check`
  - PASS.

## Boundaries retained

Authoritative accepted turns and campaign state remain owned by the shared campaign store and server workflow. No client identity is submitted or inferred. Illustration fetching/generation remains independent and is not retried or blocked by this text-generation controller.
