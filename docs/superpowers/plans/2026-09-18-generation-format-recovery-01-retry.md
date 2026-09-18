# Review retry recovery implementation plan

> **For agentic workers:** Implement task-by-task with RED/GREEN evidence and review between patches. Use superpowers:subagent-driven-development only when delegation is selected for execution.

**Goal:** Make a pending generation review recoverable through its explicit decision action and explain an ordinary retry conflict.

**Architecture:** Keep the existing job and review decision transaction. Add a typed conflict reason and reconcile current review authority before choosing recovery actions; do not translate a legacy retry into consent automatically.

**Tech Stack:** TypeScript, Zod, Fastify, PostgreSQL, Vitest, Playwright, legacy JavaScript client.

**Spec:** [Scope and gates](2026-09-18-generation-format-recovery.md).

## Constraints and ownership

No parser, prompt, provider, or schema migration changes. Preserve explicit review consent, frozen job identity, owner/campaign fences, and transaction idempotency. Existing review support must be repaired only where a regression demonstrates a gap. This patch has no dependency on patches 2 or 3.

Modify:

- `packages/application/src/generation/errors.ts`: add `review_decision_required` to the reason union.
- `packages/database/src/generation-repository.ts`: identify the ordinary retry conflict without changing the guard.
- `services/api/src/generation-application-adapter.ts`: map the reason to safe actionable HTTP 409 guidance.
- `packages/client-core/src/generation/workflow.ts`: reconcile recovery with a fresh job snapshot when a recoverable frame lacks review authority; handle this typed conflict by refreshing state and stopping automatic ordinary retry.
- `packages/client-core/src/generation/projection.ts`, `apps/web/src/story.js`, `apps/web-next/src/story-player-page.ts`, `apps/web-next/src/story-player-view.ts`: only as the new regressions require. Prioritize pending review over context diagnostics; refresh authority after stale decisions without replaying the decision.

Tests: `tests/unit/generation-application-adapter.test.ts`, `tests/unit/client-core/generation-workflow.test.ts`, `tests/unit/generation-review-projection.test.ts`, `tests/unit/story-player-ui.test.ts`, `tests/unit/web-next-story-generation.test.ts`, `tests/integration/generation-review.integration.test.ts`, `tests/e2e/generation-review.e2e.test.ts`.

## Task 1 — Typed ordinary-retry conflict

**Interface:** `GenerationApplicationError` gains reason `review_decision_required`; HTTP response remains 409 with `details.code = "generation_review_required"`. The message is “This generation is waiting for a review decision. Refresh the story page and use Retry in the review panel.”

- [ ] Add this unit regression with the file's existing imports:

```ts
const error = mapGenerationApplicationError(new GenerationApplicationError(
  "conflict", { reason: "review_decision_required" }
));
expect(error).toMatchObject({
  statusCode: 409,
  details: { code: "generation_review_required" }
});
expect(error.message).toContain("review decision");
```

- [ ] Run `corepack pnpm exec vitest run tests/unit/generation-application-adapter.test.ts`; capture RED.
- [ ] Change only the pending-review ordinary retry branch to throw the new reason and add its mapper case. Do not enqueue, clear checkpoints, or call `decideReview` there.
- [ ] Add a real-PostgreSQL regression using the existing pending-review fixture: ordinary retry returns 409, job/revision/journal/attempts stay unchanged, and provider call count stays zero. A discarded job must retain its existing state error.
- [ ] Run the unit command again and the isolated integration suite; capture GREEN. Review and commit as part of this patch.

## Task 2 — Reconcile and render review authority

**Interfaces:** Reuse `getGenerationJob`, snapshot `review`, and `decideReview({ reviewId, revision, decision: "retry" })`; no new automatic decision API. A missing review summary triggers one authoritative status read for the recoverable observation, not an unbounded polling/retry loop.

- [ ] Extend workflow tests with this deterministic sequence:

```text
SSE: recoverable, attempts=1, no review
GET job: recoverable, review={pending, canKeep:false, canRetry:true}
EXPECT: ordinary retry calls=0; review decision calls=0; review snapshot presented
USER selects review Retry
EXPECT: exactly one decision with the current reviewId/revision; no ordinary retry
```

- [ ] Add variants: current frame already includes review; status read fails; genuinely legacy recoverable job has no review; ordinary retry returns the typed 409 after a race; another tab decides/discards before submission; duplicate click; unknown future review version. Fail closed on missing authority, preserve legacy recovery when a fresh snapshot confirms it, and never replay a stale user decision automatically.
- [ ] Run the focused workflow/UI suites and capture RED only for uncovered behavior. If an expected case already passes, record that and do not rewrite the working path.
- [ ] Implement the smallest shared workflow correction. Render review reason/actions ahead of context-omission advice in both clients. On the typed conflict, stop ordinary retries and refresh the saved review; do not accept the draft or silently resubmit consent.
- [ ] Extend the paired browser fixture with structure review, no narration preview, optional-context warnings, reload, delayed review detail, and stale-tab decision conflict. Assert the review Retry issues the decision request, ordinary retry is absent, Keep is unavailable, and accepted turn number remains unchanged until worker completion.
- [ ] Test a legacy-client ordinary retry directly against the server to verify actionable copy; an already loaded old bundle cannot gain new controls until reloaded. Do not add service-worker/cache or asset-versioning changes without a reproduced cache defect.
- [ ] Run:

```powershell
corepack pnpm exec vitest run tests/unit/generation-application-adapter.test.ts tests/unit/client-core/generation-workflow.test.ts tests/unit/generation-review-projection.test.ts tests/unit/story-player-ui.test.ts tests/unit/web-next-story-generation.test.ts
corepack pnpm test:integration
corepack pnpm exec playwright test tests/e2e/generation-review.e2e.test.ts
corepack pnpm check
git diff --check
```

- [ ] Capture paired-surface screenshots, review unrelated changes, and commit `Fix generation review retry recovery`. Report browser and PostgreSQL results separately. Release gate: explicit retry survives reload and concurrent tabs without duplicate dispatch or authority mutation on conflict.
