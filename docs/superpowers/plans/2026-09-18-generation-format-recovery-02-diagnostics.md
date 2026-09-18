# Safe generation validation explanations implementation plan

> **For agentic workers:** Implement task-by-task with RED/GREEN evidence and review between patches. Use superpowers:subagent-driven-development only when delegation is selected for execution.

**Goal:** Explain structural rejection with safe field-level messages rather than context-budget advice or a generic failure.

**Architecture:** Project persisted private attempt validation errors into a small allowlisted detail field. Keep polling/SSE review summaries bounded and unchanged; both clients render the same validated detail. Never publish raw error strings.

**Tech Stack:** TypeScript, Zod, PostgreSQL, Vitest, Playwright.

**Spec:** [Scope and gates](2026-09-18-generation-format-recovery.md).

## Constraints and files

Independently implementable; integrate with patch 1 afterward. No new provider call, mutation of old checkpoints, or migration. Preserve existing generic fallback and private diagnostics.

Modify `packages/contracts/src/generation-review.ts` and its package export barrel; `packages/database/src/generation-repository.ts` (`getReview`); `services/api/src/generation-review-projection.ts`; `apps/web/src/story.js`; `apps/web-next/src/story-player-view.ts`.

Tests: `tests/unit/generation-review-contracts.test.ts`, `tests/unit/generation-review-projection.test.ts`, `tests/integration/generation-review.integration.test.ts`, `tests/e2e/generation-review.e2e.test.ts`.

## Task 1 — Safe diagnostic contract and projection

**Proposed interface:** optional `validationIssues` on `GenerationReviewDetail`, at most eight entries. Each entry is a strict object with `field` in `superseded_facts | canonical_fact_updates | canonical_facts`, and `code` in `missing_array | expected_string_item | invalid_field_shape`. No arbitrary path, value, or message. Existing details without the field remain valid.

Define exported pure function `projectGenerationValidationIssues(errors: readonly string[]): GenerationValidationIssue[]` in `generation-review.ts`. Match only anchored known validator messages. Collapse numeric indexes into the finite parent field, deduplicate, and cap results. Unknown messages contribute no details; existing `invalid_structure` remains the fallback.

- [x] Add these exact representative assertions:

```ts
expect(projectGenerationValidationIssues([
  "superseded_facts: Invalid input: expected array, received undefined",
  "canonical_fact_updates: Invalid input: expected array, received undefined"
])).toEqual([
  { field: "superseded_facts", code: "missing_array" },
  { field: "canonical_fact_updates", code: "missing_array" }
]);
expect(projectGenerationValidationIssues([
  "canonical_facts.0: Invalid input: expected string, received object",
  "canonical_facts.1: Invalid input: expected string, received object"
])).toEqual([{ field: "canonical_facts", code: "expected_string_item" }]);
expect(projectGenerationValidationIssues([
  "PRIVATE_CANARY: provider response and prompt contents"
])).toEqual([]);
```

- [x] Add malformed-path, overlong input, repeated-error, unknown-field, unsupported-code, and private-canary tests. For `invalid_field_shape`, recognize only the three allowed fields and exact known type-error forms; no substring extraction or arbitrary text passthrough.
- [x] Run `corepack pnpm exec vitest run tests/unit/generation-review-contracts.test.ts tests/unit/generation-review-projection.test.ts`; record RED.
- [x] Implement the strict schema and projection. Revalidate entries at the API response boundary. Do not add them to `GenerationReviewSummary` or relax that schema.
- [x] Run the same command; record GREEN.

## Task 2 — Bind detail to the rejected attempt and render it

- [x] In the existing integration fixture, persist the two missing-array errors on the rejected attempt. Fetch owner-scoped review detail and assert exact safe codes; fetch as another owner and assert no access.
- [x] Add a later-attempt fixture and a decided/discarded checkpoint. Prevent old attempt diagnostics being presented as a new candidate's failure. Match the rejected candidate's producing response identity to its job-owned attempt; when no unique matching attempt exists, omit `validationIssues` and use the generic reason. Do not choose an unrelated “latest attempt.”
- [x] Implement a bounded lookup for matching `generation_attempts.validation_errors` inside `getReview`, scoped through the already owner-validated job. Exclude `raw_output`, prompts, request bodies, and credentials from this lookup. Feed only projected codes into the public detail.
- [x] Add browser fixtures in both surfaces. Render static copy from validated codes: “The response omitted canonical_fact_updates; an array is required.” and “canonical_facts must contain text entries.” Context omissions may appear as secondary information but must not replace the rejection reason. Unknown or absent codes use the existing structure message.
- [x] Verify the public API projector preserves only the new strict field and regenerates any display copy from fixed mappings. Test an injected raw message cannot reach the DOM, polling/SSE, or API detail.
- [x] Run:

```powershell
corepack pnpm exec vitest run tests/unit/generation-review-contracts.test.ts tests/unit/generation-review-projection.test.ts
corepack pnpm test:integration
corepack pnpm exec playwright test tests/e2e/generation-review.e2e.test.ts tests/e2e/generation-integrity-diagnostics.e2e.test.ts
corepack pnpm check
git diff --check
```

- [x] Capture paired-surface desktop/mobile screenshots and commit `Explain generation structure review failures`. Release gate: recognized errors are actionable, unrecognized errors remain safely generic, and no private canary appears in any public response or DOM.
