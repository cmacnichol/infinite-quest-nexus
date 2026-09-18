# Phase 05: Large-context diagnosis and bounded experiment implementation plan

> **For agentic workers:** Use `superpowers:subagent-driven-development` when delegated. Complete diagnosis before changing context policy. An inconclusive experiment is a valid outcome; silently reducing authority is not.

**Goal:** Determine whether optional context volume contributes to empty responses/timeouts, and provide a tested reduction only if evidence supports it.

**Architecture:** Measure the exact serialized request and per-layer composition with content-free diagnostics. Compare optional-context ceilings against the same mandatory authority and output reserve; preserve whole required records and stop if mandatory content cannot fit.

**Tech Stack:** TypeScript, existing context planner/token estimator, Vitest, isolated PostgreSQL, optional authorized live-provider evaluation.

**Spec:** [Index](2026-09-18-turn-validation-success.md). Requires phase 01 metrics; evaluate against the integrated phase-04 baseline.

## Ownership and files

Read `services/runtime/src/generation-context-planner.ts`, `packages/application/src/memory/generation-context.ts`, `packages/database/src/chronicle-generation-context.ts`, `packages/story-engine/src/provider-request.ts`, `context-budget.ts`, and `token-estimate.ts`. Read the scene/mechanics review note before changing assembly.

For transport diagnosis also read `packages/story-engine/src/provider-transport.ts`, `provider-response.ts`, `providers.ts`, and the actual timeout/abort caller. This patch may change transport only after a synthetic provider reproduces a concrete defect.

Create `scripts/evaluate-turn-context.ts`, `tests/unit/turn-context-evaluator.test.ts`, and, only for a demonstrated planner change, extend `tests/unit/generation-context-planner.test.ts`, `tests/unit/provider-request-budget.test.ts`, `tests/integration/generation-budget-growth.integration.test.ts`, and `tests/integration/story-context-payload.integration.test.ts`.

## Task 1: Reproduce the composition, not the guess

- [ ] Inspect the exact producing request for the empty-object failure read-only. Separate mandatory authority, current continuity, recent turns, selected world material, retrieved history, protocol overhead, and output reserve. Report sizes/hashes/record counts only.
- [ ] Compare application estimates with actual provider-reported input usage. Mark missing reported usage unknown. Examine repeated/largely duplicated layers and repeated current state, not merely total token count.
- [ ] Establish whether the 1,000,000 campaign budget admitted optional history up to the ceiling, whether required state alone dominates, or whether a serializer/continuation repeated data. If exact request evidence was not retained, state that limitation and use a synthetic reproduction; do not claim exact historical composition.
- [ ] Build a synthetic long-campaign fixture whose mandatory record fingerprints are stable across 32k, 64k, 128k, and baseline request budgets. These are experimental values, not proposed global defaults. Skip a cell with a typed required-context overflow when its mandatory content cannot fit.

## Task 2: Content-free evaluator

**Planned result per cell:** budget, mode, mandatory fingerprint, selected/omitted optional record counts, estimated full request tokens, output reserve, provider-reported input tokens when available, time to first output, total duration, finish reason, parser result, empty-response flag, and semantic-review outcome. Do not persist prompt text in reports.

- [ ] Add a RED evaluator test using injected planning and provider functions:

```ts
expect(report.cells.map(cell => cell.mandatoryFingerprint))
  .toEqual([mandatoryFingerprint, mandatoryFingerprint]);
expect(report.cells[0].estimatedRequestTokens)
  .toBeLessThan(report.cells[1].estimatedRequestTokens);
expect(report.cells[0].omittedRequiredRecords).toBe(0);
expect(report.cells[0].providerCalls).toBe(0); // dry-run is the default
```

Construct `report` through the new evaluator exported by `scripts/evaluate-turn-context.ts`; `mandatoryFingerprint` is the fixture's computed value. Add a `--dry-run` default and require explicit `--live` plus a bounded case count for provider dispatch. Live mode uses synthetic or explicitly authorized copied data only.

- [ ] Implement cells without changing production defaults. Keep model, prompt version, temperature, output budget, input direction, and review mode fixed; change only optional context allowance.
- [ ] Test required-record overflow, no optional records, lexical fallback, semantic-ready retrieval, duplicate evidence, mixed world versions, and foreign-campaign data. Optional selection changes must remain within existing ranking/whole-record rules.
- [ ] If a concrete planner defect is reproduced, add a regression at that seam and implement its narrow fix. Otherwise deliver the evaluator and a recommendation, not an arbitrary cap.

## Task 3: Experiment decision

- [ ] Produce a dry-run composition table. Decide whether a live test can distinguish the hypothesis; include model route, number of cells/repetitions, maximum requests, and cost bound for approval before paid execution.
- [ ] After authorization, use at least three repetitions per eligible cell for diagnosis; do not characterize that small sample as a reliable success-rate estimate. Record full-call latency and timeout, not only parse status.
- [ ] Recommend an optional-context ceiling only if it improves failures/latency without losing mandatory evidence or increasing continuity failures. Confirm under the phase-07 canary before changing defaults.
- [ ] If required authority dominates, stop the cap proposal. Report the source of growth and propose a separate explicit continuity-maintenance design; never truncate summaries/facts or delete history to meet this plan.
- [ ] Record a decision: demonstrated bug fixed, optional configuration recommended, or hypothesis unconfirmed. Commit only the tooling and verified scoped changes.

## Task 4: Timeout and empty-response differential diagnosis

The short-campaign timeout must not be attributed to the long-campaign context failure. Compare them as separate cases.

- [ ] Reconcile configured request timeout, elapsed time, lease lifetime, cancellation signal, response headers, first-byte timing, and the transport's actual timer start. Establish whether the approximately 545-second failure is an upstream timeout, connection/stream stall, or local deadline. Report unavailable telemetry instead of inferring its value.
- [ ] Add a deterministic fake-provider matrix: delayed headers, headers then idle stream, partial narration then idle stream, complete JSON just before deadline, empty JSON with `stop`, and connection close without a terminal frame. Use injected timers or bounded test deadlines rather than multi-minute sleeps.
- [ ] Assert a true timeout is categorized as transport failure; `{}` with a completed response is an empty-content/schema failure; complete validated output is preserved even if connection cleanup later errors. Only claim the latter as a bug fix if the actual code exhibits the fault.
- [ ] For every timed-out or interrupted request, preserve available provider response identity and captured bytes. Do not dispatch a replacement merely because a timeout is retryable; retain the existing explicit recovery and provider-retrieval behavior.
- [ ] If response IDs or complete bytes are lost, write the failing regression at that boundary before fixing it. Verify the fix cannot accept partial content or duplicate an already accepted response after reclaim.
- [ ] Separate any demonstrated transport fix into its own commit within this phase and report it independently from optional-context changes. If the provider itself times out with correct local handling, deliver diagnostics and an operational recommendation, not a blanket timeout increase.

## Exit gate

No claim that the model's real context capacity equals the profile's configured 1,048,576 tokens without provider evidence. No automatic model, timeout, output-limit, temperature, or production campaign-setting change. Required authority fingerprints and isolation tests pass for every supported experimental cell.
