# Final Fix Round 2 Report

## Scope

Addressed the two remaining final-review findings for durable generation cancellation:

1. Provisional illustration set, segment, prompt/resolution job, direct image job, and delivery writes now serialize with generation cancellation through an active-parent `FOR UPDATE` lock held in the same transaction as the dependent write sequence.
2. Claimed library resolution attachment now uses the same active provisional-parent fence, and cancellation removes any provisional segment attachment/reference that committed before cancellation acquired the parent lock.

Accepted-turn artwork remains outside cancellation cleanup (`segments.turn_id IS NULL` is required), with regression coverage proving an accepted-turn asset reference survives the provisional cancellation race.

## Implementation

### Atomic provisional creation and delivery

- Replaced `FOR KEY SHARE` with `FOR UPDATE` for active provisional generation fencing.
- Added pool-aware transaction wrappers around `createProvisionalSet` and `createProvisionalSegment`, so pool-backed active-parent checks and all dependent inserts/updates are one transaction.
- The segment transaction covers segment creation plus direct image-job or refinement prompt-job creation.
- Existing transactional delivery paths (`queueSegmentDelivery` and `enqueueSegmentProviderImage`) now hold the conflicting parent lock across segment/set mutation and resolution/image enqueueing.
- Cancellation therefore either updates the generation first and causes the child path to return without writing, or waits for the child transaction and terminalizes its committed provisional work before returning.

### Claimed library resolution

- Added `lockActiveProvisionalParent` to resolve a segment's provisional parent and lock the active generation `FOR UPDATE`.
- `runIllustrationResolutionJob`, `attachMatch`, and resolution failure segment/set mutation use this fence in their write transaction.
- Provisional resolution context can now use the durable sanitized `query_context_snapshot.imagePrompt` when no accepted turn exists.
- Cancellation deletes provisional library asset references and segment-asset rows before orphaning the set. Cleanup is restricted to generation-owned segments with `turn_id IS NULL`.

## TDD Evidence

### RED (before production edits)

Command:

`pnpm vitest run --config vitest.integration.config.ts tests/integration/image-pipeline.integration.test.ts -t "atomically fences provisional|fences claimed library|prevents AI-refinement"`

Result: exit 1, three deterministic PostgreSQL advisory-lock regressions failed:

- provisional set remained live after cancellation;
- claimed library asset remained attached after cancellation;
- AI-refinement delivery left a live image job after cancellation.

The barriers were implemented with PostgreSQL trigger functions and advisory locks; no timing sleeps were used.

### GREEN (after production edits)

Focused command:

`pnpm vitest run --config vitest.integration.config.ts tests/integration/image-pipeline.integration.test.ts -t "atomically fences provisional|fences claimed library|prevents AI-refinement"`

Result: exit 0, 3 passed.

Full generation + image integration suites:

`repowise distill pnpm vitest run --config vitest.integration.config.ts tests/integration/generation.integration.test.ts tests/integration/image-pipeline.integration.test.ts`

Result: exit 0, 55 passed, 2 skipped.

Build:

`pnpm build`

Result: exit 0.

Diff validation:

`git diff --check`

Result: exit 0.

## Files Changed

- `services/api/src/segmented-illustration-service.ts` — conflicting active-parent locking and pool-backed transactional creation.
- `services/api/src/illustration-resolution-service.ts` — provisional parent fence for claimed matching and segment/set delivery; provisional snapshot context.
- `services/api/src/generation-service.ts` — cancellation cleanup for provisional library attachments/references.
- `tests/integration/image-pipeline.integration.test.ts` — deterministic set/direct-image, library attachment, and AI-refinement races, including accepted-artwork preservation.

## Notes

- No migration or API contract change was required.
- Expected synthetic LM Studio embedding transport errors remain in the integration logs and do not fail the suites.
- Existing skipped image tests remain skipped (2); this round did not change their status.
