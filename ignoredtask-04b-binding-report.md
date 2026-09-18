# 04B request binding report

## Exports and operation mapping

- `bindCampaignResponseContract` attaches the frozen contract before request serialization, reservation, or transport. It fails closed for `story_generation`, `story_recovery`, `story_choice_repair`, `event_extension`, `scene_coverage_rewrite`, `story_continuity_review`, and `story_continuity_repair`; RPG and event assessments plus scene-coverage validation remain exempt.
- `preparePrimaryReservation` retains the legacy callback-free reservation body and reserves the complete contract-bound body for new jobs.
- Primary generation uses `story:stream` only for the original durable logical attempt. Lease reclaims retain that selection; a new logical attempt uses `story:nonstream`.
- Choice repair, full-story rewrites and extensions use `story:nonstream` or `choices:nonstream` before their checkpoint serializers. Continuity review and repair receive the selected contract before their helper serialization. Review requests carry the dedicated `continuity_review` output budget.

## RED and GREEN evidence

The regression added to `tests/unit/generation-executor-adapter.test.ts` covers the prior failure shape: a streamed primary reservation lacked the response contract and stream fields even though dispatch added them later. It also verifies the historical reservation body stays callback-free, an unexpected choice operation fails before dispatch, and RPG assessment remains exempt.

GREEN:

`corepack pnpm exec vitest run tests/unit/generation-executor-adapter.test.ts tests/unit/story-continuity-review-adapter.test.ts tests/unit/provider-request-budget.test.ts` — 3 files, 102 tests passed.

`corepack pnpm check` — passed.

`git diff --check` — passed before commit.
