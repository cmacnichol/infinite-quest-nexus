# Context Token Accounting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Correct character-as-token accounting so usable story context is admitted while campaign and provider token ceilings remain enforced.

**Architecture:** Introduce one dependency-free, explicitly estimated token counter for canonical story budgeting. Use it in context selection, fixed-envelope estimation, and the final serialized provider-request guard. Retain the existing provider-request safety allowance, protected-authority behavior, and output reservation.

**Tech Stack:** TypeScript, existing domain text utilities, Vitest, PostgreSQL integration fixtures, deterministic mock text providers.

**Spec:** The user-approved scope is captured in “Requirements and evidence” below; this is a standalone plan, not authorization to implement or deploy.

## Workspace and global constraints

- Worktree: `C:\Git\InfiniteQuest\.worktrees\context-token-accounting`.
- Branch: `codex/context-token-accounting`.
- Base: `6ab873c873a631603209bd870bc7fc8c9f940f12` (current main at plan creation).
- Read `AGENTS.md`, `docs/agents/domain.md`, `docs/workflows/testing.md`, and `docs/architecture/scene-context-mechanics-review.md` before implementation. Follow any narrower instructions discovered in affected directories.
- Keep two-space indentation and existing typed boundaries. Review associated tests for every changed code file.
- No migrations, new dependencies, provider network calls for counting, concurrency changes, cancellation repairs, global domain-estimator changes, UI redesign, or production data changes.
- Do not increase campaign budgets, truncate mandatory authority, change retrieval ranking, or alter accepted turns as a workaround.
- Do not import private campaign text into fixtures, logs, or this repository.
- Exact model tokenizer integration is a separate follow-up. This bounded correction must not claim model-exact counts or guaranteed fit for every tokenizer.
- Do not modify main or publish/deploy from this plan. Leave unrelated untracked plans in main untouched.

## Requirements and evidence

Production read-only replay reproduced `context_budget_exceeded` with required=150771 and available=128000. The required value equalled the serialized protected context's JavaScript string length exactly. Canonical facts accounted for 112745 characters. The failed job made no story-provider request, so no exact provider usage exists for it.

Recent successful requests had application counts of 71409 and 137918 versus provider input usage of 16645 and 32056. These observations demonstrate the discrepancy; they are not a universal conversion ratio or tokenization oracle.

Current source has two faulty production counters:

- `services/runtime/src/generation-executor-adapter.ts`, `planGenerationPromptContext`: `count: (value) => value.length`.
- `packages/story-engine/src/providers.ts`, `checkedStoryRequest`: `count: (body) => body.length`.

The executor also has `budgetTokenEstimate`, used for the fixed prompt envelope. It combines the existing domain estimate with a characters/3 floor. `tests/integration/generation-budget-growth.integration.test.ts` currently asserts character lengths against token limits, locking in the defect.

Required behavior:

1. Context whose character length exceeds the campaign token budget can proceed when its token estimate fits.
2. Context whose estimate actually exceeds the campaign ceiling still fails before provider dispatch. Protected records stay complete.
3. Full serialized request estimate + existing safety allowance + output reservation must fit the effective provider/job window.
4. Larger budgets can admit more relevant whole records when candidates exist, without padding sparse prompts.
5. Diagnostics identify estimates and distinguish campaign-context failures from full-provider-request failures.
6. Rejected jobs do not mutate accepted campaign state or Chronicle; owner/campaign/world boundaries remain enforced.

## Task 1: Shared estimator and both production gates

**Files:**
- Create `packages/story-engine/src/token-estimate.ts`.
- Export through `packages/story-engine/src/index.ts`.
- Modify `packages/story-engine/src/providers.ts` and `services/runtime/src/generation-executor-adapter.ts`.
- Create `tests/unit/story-token-estimate.test.ts`.
- Update `tests/unit/provider-request-budget.test.ts`; review `tests/unit/context-budget.test.ts` and `tests/unit/main-rewrite-output-budget.test.ts`.

**Interface:** `estimateStoryTokens(text: string): number`; a finite nonnegative integer, explicitly heuristic. Keep `planContext` and `serializeCheckedProviderRequest` counter injection intact.

- [ ] Write failing unit tests for ASCII prose, punctuation-heavy JSON, whitespace, CJK, emoji, and mixed content. Assert integer/nonnegative results and deterministic values. Use synthetic content only.
- [ ] Define the fallback concretely: for each ASCII run, use the greater of the existing `estimateTokens(run)` and `ceil(run.length / 3)`; for non-ASCII runs use UTF-8 byte length as a conservative fallback. Sum the runs. This avoids applying an English characters/3 assumption to CJK/emoji. Document that even this is an estimate, not a tokenizer guarantee.

```ts
export function estimateStoryTokens(text: string): number {
  return (text.match(/[\x00-\x7f]+|[^\x00-\x7f]+/gu) ?? []).reduce((total, run) => {
    const tokens = /^[\x00-\x7f]+$/u.test(run)
      ? Math.max(estimateTokens(run), Math.ceil(run.length / 3))
      : new TextEncoder().encode(run).length;
    return total + tokens;
  }, 0);
}
```

- [ ] Add a provider transport regression with canonical budgeting enabled and synthetic prose longer than 128000 characters but comfortably below 128000 estimated tokens. Assert transport is reached. Add the inverse case with an estimate above the effective input limit and assert transport is never called.
- [ ] Run the new tests before production edits and record the actual failing assertion. Ensure the transport regression fails due to the existing character guard, not invalid fixture shape.
- [ ] Implement/export the helper. Replace both production `count` callbacks with `estimateStoryTokens`. Replace the executor's private envelope estimator with the shared helper and remove only imports made unused by that change.

```ts
// Context planner and checked provider request:
count: estimateStoryTokens,
// Final provider guard retains:
countMode: "estimated",
safetyAllowanceTokens: estimatedInputSafetyAllowanceTokens,
```

- [ ] Keep counting the complete serialized body as a conservative transport-envelope approximation; do not strip JSON syntax in one path but not another. Preserve existing output feasibility and self-contained repair/retry behavior.
- [ ] Run `pnpm exec vitest run tests/unit/story-token-estimate.test.ts tests/unit/provider-request-budget.test.ts tests/unit/context-budget.test.ts tests/unit/main-rewrite-output-budget.test.ts` and record GREEN.

## Task 2: Composed PostgreSQL regression and truthful diagnostics

**Files:**
- Modify `tests/integration/generation-budget-growth.integration.test.ts`.
- Modify `services/runtime/src/generation-executor-adapter.ts` (private diagnostics).
- Modify `packages/contracts/src/story-prompt.ts` and the diagnostic projection tests associated with it if needed for optional estimate metadata.
- Review `tests/integration/story-continuity-remediation.integration.test.ts`, `tests/unit/generation-diagnostics.test.ts`, and `tests/unit/chronicle-generation-budget.test.ts`.

- [ ] Extend the existing `seedEquivalentCampaign`/`capturePrompt` fixture seam with a synthetic authority-size option. Seed schema-valid canonical facts whose complete protected serialization exceeds 128000 characters and whose estimate fits 128000. Use realistic bounded individual records, not an invalid oversized field. Add unique tail markers to prove records remain complete.
- [ ] Run this composed regression against the uncorrected base first (before Task 1 production edits, or in an independent temporary test checkout). Record `recoverable/context_budget_exceeded` as RED. Do not revert other developers' work to obtain RED.
- [ ] With the correction, assert the provider receives the request, authority tails remain present, the turn commits once, and its context estimate is below the campaign budget despite character length above it. Assert absence of another campaign's marker.
- [ ] Add an estimated-overflow fixture. Assert zero story calls, recoverable budget diagnostics, and unchanged accepted turns, campaign state, and Chronicle records. Add a provider-window-limited fixture where campaign context fits but full request plus output does not; verify `provider_request` scope.
- [ ] Replace the existing character-based growth assertions with token estimates:

```ts
expect(estimateStoryTokens(snapshot.serializedContext)).toBeLessThanOrEqual(snapshot.budget);
const requestTokens = estimateStoryTokens(snapshot.body);
expect(requestTokens + estimatedInputSafetyAllowanceTokens(requestTokens))
  .toBeLessThanOrEqual(providerContextWindowTokens - providerMaxOutputTokens);
```

- [ ] Preserve complete-record, foreign-campaign, semantic-ready, fallback, and sparse-context assertions. Expand synthetic candidate supply if corrected estimates cause two budgets to saturate the existing fixture; do not weaken growth assertions just to pass.
- [ ] Add `countMode: "estimated"` and `estimatorVersion: "story-token-estimate-v1"` to private context diagnostics. For public budget diagnostics add optional `countMode`/`estimatorVersion` fields through the strict schema and explicit safe projection; old diagnostics without them must remain readable. Preserve code/action/scope meanings and expose no prompt text. Locate/update all schema/projection tests with `rg -n 'projectSafeGenerationDiagnostic|storyGenerationDiagnostic' packages tests`.
- [ ] Verify required/available values use the same estimated units as the actual gates. Cover provider safety allowance once, not twice, and no double subtraction of output reserve.
- [ ] Run `pnpm exec vitest run --config vitest.integration.config.ts tests/integration/generation-budget-growth.integration.test.ts tests/integration/story-continuity-remediation.integration.test.ts` against dedicated test PostgreSQL only. Record actual execution; skips are not passes.

## Task 3: Review, verification, and release handoff

**Files:** Update `docs/workflows/testing.md` with the focused accounting regression and `docs/runbooks/deployment.md` with estimate semantics and the read-only verification gate. No manifest changes.

- [ ] Document that the campaign budget limits context, whereas the provider window covers the whole request and reserved output. State that character totals and provider-reported usage are distinct measurements. Describe the estimator's limitations without presenting the observed 4.3 ratio as universal.
- [ ] Run `pnpm test:unit --exclude '**/.worktrees/**' --exclude '**/.codex/**'`, `pnpm test:integration`, `pnpm check`, `pnpm build`, and `git diff --check` from the implementation worktree. Use the pinned package manager. Record passed/failed/skipped separately, including real PostgreSQL versus mocked provider evidence.
- [ ] Review the complete scoped diff. Verify both former `length` callbacks are gone, fixed-envelope measurement uses the same helper, output/repair guards remain active, and fixtures contain no production story text. Review diagnostic compatibility tests for optional fields.
- [ ] Before any approved deployment, repeat the existing read-only campaign-authority replay using the corrected estimator. Output only component character lengths, estimates, limits, and estimate mode. Do not claim the failed request's exact token usage or initiate a paid generation for verification.
- [ ] Report whether the actual affected context now fits. If it does not, report the measured components and stop; do not silently raise budgets or remove facts.
- [ ] Keep release separate: no production restart, retry, discard, configuration change, or provider call is authorized by this planning task. After an approved release, compare application estimates with newly observed provider usage. Roll back the application image if provider overflow or integrity regressions appear; rollback requires no schema/data changes.

## Plan-only verification

At plan creation this worktree contained documentation only; no application checks were claimed then. The user subsequently authorized implementation. The implementation record below supersedes that initial status.

## Acceptance checklist

- [x] A character-heavy, estimated-in-budget context reaches the provider and commits without losing authoritative records.
- [x] Both local planner and final transport guard use one estimated unit policy.
- [x] Campaign overflow, provider overflow, output reservation, repair requests, isolation, and no-mutation failures have regression evidence.
- [x] Old diagnostics remain readable; new counts are explicitly estimates.
- [x] The handoff records focused RED/GREEN, final checks, remaining estimation limits, and production replay results separately.

## Implementation record — 2026-09-08

Implemented in this worktree on `codex/context-token-accounting`, without a production deployment, retry, configuration change, or main-checkout integration. All implementing and reviewing subagents used Terra. Publication was subsequently authorized; Git and the pull request record delivery status.

The shared `estimateStoryTokens` now measures the planner, fixed envelope, and final canonical transport guard. New private/public budget diagnostics include optional estimate mode/version metadata; historical diagnostics remain valid. Provider safety/output reservations remain active.

### RED/GREEN evidence

- Transport RED: a synthetic 150,000-character request failed the old guard with required 181195 / available 126976. The same regression passes after the estimator change; estimated overflow still prevents transport. Focused estimator/provider/context/output tests: 39 passed.
- Composed PostgreSQL RED: 140 schema-valid protected canonical facts in an accepted-turn state snapshot caused `recoverable/context_budget_exceeded/campaign_context` instead of completion. GREEN verifies all 140 authority tails, full record count, a single committed turn, and estimated context below the budget despite character length above it.
- Diagnostic RED/GREEN: the schema initially rejected the new metadata and executor projections omitted it. Contract/executor tests passed after implementation, including independent private-field rejection and valid-metadata projection. The reviewer's initial test-isolation finding was corrected and re-reviewed cleanly.
- Provider-scope RED: a configured campaign allowance larger than a small provider window was incorrectly labeled `campaign_context`. The final planner uses the configured campaign allowance independently from the provider request limit. The stricter 20,000-token provider integration case now returns `provider_request` before dispatch.

### Verified checks

| Check | Result |
| --- | --- |
| Final pinned `pnpm test:unit` with nested-worktree exclusions | 240 files; 2,839 passed, 44 skipped |
| Broad PostgreSQL integration run, excluding the agent-owned budget file | 66 files passed, 7 skipped; 671 tests passed, 188 skipped |
| Final generation/continuity integration rerun after scope separation | 5 files, 100 tests passed, no skips |
| Final budget-growth integration file | 5 tests passed, no skips; 81.78 seconds |
| Final pinned `pnpm check` | Passed |
| Final pinned `pnpm build` | Passed; existing large-web-chunk warning remains |
| `git diff --check` | Passed |
| Independent Terra task and whole-worktree reviews | Clean after the diagnostic test correction |

The 100 final generation/continuity tests are a subset of the broad run, not additional distinct coverage. The five budget tests complete the 74-file integration inventory. Windows/platform-gated secure filesystem, archive, and release cases remain skipped and are not claimed as verified. No browser or live-model generation was performed; no visible UI code changed.

The shared default test PostgreSQL instance had an authentication mismatch. Tests instead used a new worktree-owned PostgreSQL container at loopback port 15442. An ignored temporary Vitest configuration preserved the normal per-file database isolation and replaced only fixed-port Docker provisioning with a connectivity check. Thus the unchanged `pnpm test:integration` bootstrap was not used; the integration inventory was exercised with this documented provisioning substitution. Production and shared test credentials were not changed.

### Read-only production measurement

The original job identity replay correctly refused to run after the campaign advanced. A separately labeled historical base-turn-87 reconstruction reproduced the original **150,771 characters** and measured **51,032 estimated tokens**, below the original **128,000-token** allowance. This is a heuristic context measurement, not an exact provider token count or a complete provider-request replay.

The current base-turn-89 authority separately measured 34,668 characters / 11,850 estimated tokens. At measurement time its campaign/job allowance had already become 256,000; this task did not change it. No story content was printed or saved in fixtures, and no provider request was submitted.

### Implementation decision and remaining limit

Kept the provider-clamped retrieval budget but separated the planner's campaign ceiling from its provider input ceiling. The stricter provider-window regression required this distinction for truthful error attribution. If that separation admitted oversized input, it would risk provider rejection; the independent serialized-request guard, output reservation, and explicit pre-dispatch overflow regressions cover that risk.

Counts remain heuristic and can differ from a model tokenizer, especially for multilingual or unusual input. Model-specific tokenizers remain outside this focused change. Deployment and any retry/discard of production jobs still require a separate instruction.
