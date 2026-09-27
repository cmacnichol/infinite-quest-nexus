# Continuity Review Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent an exhausted continuity reviewer from causing an unexplained generation failure, while preserving the exact generated candidate and all acceptance safeguards.

**Architecture:** Separate review execution configuration from writer configuration. Persist typed review failures and a bounded review-attempt ledger; allow one technical-failure fallback against unchanged candidate/evidence, then use the existing explicit review checkpoint. Project safe, specific diagnostics into both active Story players.

**Tech Stack:** TypeScript, Zod, PostgreSQL, Vitest, Playwright, existing provider execution and generation-job infrastructure.

**Spec:** This document records the design requested after the September 26 turn-68 diagnosis. Related requirements: [testing](../../workflows/testing.md), [repository architecture](../../architecture/repository-overview.md), and [deployment](../../runbooks/deployment.md).

## Evidence and limits

Job `250d57ec-7e00-4075-898d-3afa8904acec` passed story validation with zero errors. Its subsequent continuity request ran for 380,348 ms and returned `finishReason: length`, `outputLimited: true`, and 65,536 output tokens. The checkpoint recorded `uncertain` with no findings and paused for review. The saved candidate remains unaccepted; the review API offered Keep and Retry at diagnosis time.

The current adapter substitutes null for output-limited responses, which the domain validator converts into an uncertain verdict. The API then exposes a generic uncertainty message. `effectiveRequestOutputTokens` currently shares the configured allowance across writing, review, and repair. Both requests used the same remote preset.

These facts prove truncation, not why the provider consumed that many tokens. Reasoning usage, repetitive output, and prompt/preset interaction remain unverified. Do not pick a new production model or numeric cap on that assumption. Structured response contracts already exist; preserve and verify them rather than proposing JSON mode as a new cure.

## Global constraints

- Diagnosis and planning do not authorize deployment, modification of the affected job, acceptance, or regeneration.
- Preserve candidate text, structured state, evidence manifest, owner/campaign/world scope, and producing-request identity across review retries.
- Never treat technical failure as a pass or erase a genuine conflict by asking another model for a preferable verdict.
- Do not prune required review evidence to fit a reviewer. Fail before dispatch if the complete required request does not fit.
- Keep remote presets as `@preset/<slug>`; do not expand them into locally selected models or silently override their provider routing.
- Credentials remain server-side and scoped to the selected text provider. Illustration execution remains independent.
- Old jobs retain their frozen configuration and retry allowances. Do not silently upgrade pending jobs or reinterpret old uncertain results as known truncation.
- Use strict RED/GREEN evidence for implementation tasks. Review associated tests for every changed file.
- No production story text or raw private reasoning in committed fixtures, public diagnostics, screenshots, or reports.

## Review focus

1. Worker crash after dispatch must not cause unlimited or duplicate fallback calls (Task 4).
2. Reviewer or campaign setting changes must not change a running job's frozen route/evidence (Tasks 3–4).
3. Valid conflicts and genuine uncertainty must not trigger technical-failure fallback (Tasks 2–4).
4. Stale candidates and foreign-campaign evidence must remain ineligible for acceptance (Tasks 4–6).
5. Older snapshots and private provider errors must remain readable and safely projected (Tasks 2, 5–6).

## Task 1: Capture a reproducible baseline and select review settings

**Files:** create `tests/fixtures/continuity-review-output-limit.ts`; extend `tests/unit/story-continuity-review-adapter.test.ts`; record sanitized measurements in `docs/review/continuity-review-reliability-evaluation.md`.

**Deliverable:** A deterministic output-limit reproduction plus evidence supporting candidate reviewer settings.

- [ ] Read the affected saved provider attempt/usage, if retained. Measure visible-output length, finish reason, available reasoning-token counts, request parameters, and applied response contract. Record unavailable fields explicitly; do not infer a token breakdown from the total.
- [ ] Create a synthetic complete story and evidence fixture. Make the provider return `outputLimited: true`; assert a typed output-limit failure rather than a successful semantic uncertainty result. Run `corepack pnpm exec vitest run tests/unit/story-continuity-review-adapter.test.ts` and record RED before Task 2.
- [ ] Compare a dedicated review preset/configuration against the current shared configuration using authorized isolated evaluations and identical evidence. Include known pass, real conflict, uncertainty, malformed response, and large-evidence cases. Use existing `scripts/evaluate-story-continuity.ts` where practical.
- [ ] Record completion rate, conflict detection, truncation, usage, latency, supported structured-output/reasoning controls, and chosen output budget. Treat live-provider evaluation as a release gate; deterministic fixtures do not prove reviewer quality. If live evaluation is unavailable, implement configurable policy but leave automatic fallback disabled by default.

## Task 2: Preserve the actual review failure

**Files:** `services/runtime/src/story-continuity-review-adapter.ts`, `packages/application/src/memory/continuity-review-checkpoint.ts`, `packages/contracts/src/generation-review.ts`; associated adapter, checkpoint, and contract unit suites.

**Interface:** Introduce a discriminated review-attempt outcome: either a validated semantic verdict (`pass`, `conflict`, `uncertain`) or a technical failure (`output_limit`, `invalid_output`, `provider_timeout`, `provider_failed`, `context_budget_exceeded`, `evidence_unavailable`). Technical failure contains no semantic verdict. Preserve safe usage/finish metadata separately from private raw response references.

- [ ] Add RED tests for truncated output even when its JSON looks complete; malformed JSON; schema-invalid JSON; valid uncertainty; and historical checkpoint parsing.
- [ ] Classify transport failures at the runtime boundary and malformed/truncated output before semantic validation. Keep unsupported findings and evidence-verification failures distinct from transport failure.
- [ ] Version the persisted outcome/checkpoint schema and add explicit backward readers. Existing v1 `uncertain` remains uncertainty without an invented cause.
- [ ] Run `corepack pnpm exec vitest run tests/unit/story-continuity-review-adapter.test.ts tests/unit/continuity-review-checkpoint.test.ts tests/unit/generation-review-contracts.test.ts`; record GREEN and commit this scoped change.

## Task 3: Freeze a separate reviewer policy

**Files:** create `packages/contracts/src/continuity-review-execution.ts` and `services/runtime/src/continuity-review-execution.ts`; integrate with `packages/contracts/src/text-execution-plan.ts`, `packages/application/src/providers/text-execution-plan.ts`, `services/runtime/src/generation-executor-adapter.ts`, `services/runtime/src/story-continuity-review-adapter.ts`, and `packages/database/src/generation-execution-repository.ts`.

**Interface:** `ContinuityReviewExecutionPolicy` version 1 contains a primary review selection and execution overrides, optional fallback selection/overrides, and `maximumAutomaticFallbacks: 0 | 1`. Resolve through the existing provider configuration infrastructure, then freeze complete route bases, prepared response contracts, and effective limits in the job before dispatch. Never persist credentials inside the policy. Add `tests/unit/continuity-review-execution.test.ts`.

- [ ] Add RED tests proving writer configuration is unaffected, review uses its selected policy, remote preset identity survives serialization, unsupported parameters fail preparation, and setting changes cannot modify frozen jobs.
- [ ] Expose the policy through existing server provider configuration/API validation and document its supported configuration procedure. Keep the initial rollout opt-in; absence preserves historical routing with new diagnostics.
- [ ] Reuse existing route/contract preparation for both reviewers. Budget the exact serialized review request with its own effective output limit and complete evidence. Include reviewer identity in review bindings while retaining the original writer request identity.
- [ ] Run `corepack pnpm exec vitest run tests/unit/continuity-review-execution.test.ts tests/unit/provider-request-budget.test.ts tests/unit/text-execution-overrides.test.ts tests/unit/story-continuity-review-adapter.test.ts`; record GREEN and commit.

## Task 4: Add one durable technical-failure fallback

**Files:** create `packages/application/src/memory/continuity-review-attempt-policy.ts`; modify the checkpoint, executor, and generation execution repository from Task 3. Add `tests/unit/continuity-review-attempt-policy.test.ts`; extend `tests/integration/story-continuity-review.integration.test.ts` and `tests/integration/generation-review.integration.test.ts`.

**Interface:** A pure next-action policy consumes frozen policy, classified outcomes, and persisted reservations; it returns dispatch-primary, dispatch-fallback, accept-review-result, or pause-for-decision. Persist attempt ordinal, route identity, request hash, response reference, outcome, and reservation status using the existing fenced job/attempt transaction infrastructure.

- [ ] Add RED cases: primary truncation → fallback pass; both truncated → pause; timeout/malformed output → one fallback; semantic conflict/uncertainty → no fallback; missing evidence/context overflow → no automatic dispatch.
- [ ] Reserve the fallback atomically before calling the provider. Reconcile a recoverable saved response on reclaim; when completion cannot be established, pause instead of silently reissuing a reserved call. Coordinate with the existing logical review allowance so retries cannot reset counters or consume a semantic-repair allowance accidentally.
- [ ] Keep the identical candidate and evidence for fallback. Successful review resumes the normal validation/commit path; exhausted fallback preserves the candidate and presents existing eligible Keep/Retry decisions. Explicit Retry starts only the review stage for technical review failure and receives a separately journaled, bounded decision budget.
- [ ] Test duplicate workers, restart before/after dispatch and response persistence, cancellation, stale authority, append/replacement, and cross-campaign isolation with real PostgreSQL and a deterministic provider. Assert no extra primary story request and at most one automatic fallback per review cycle.
- [ ] Run `corepack pnpm exec vitest run tests/unit/continuity-review-attempt-policy.test.ts` and `corepack pnpm exec vitest run --config vitest.integration.config.ts tests/integration/story-continuity-review.integration.test.ts tests/integration/generation-review.integration.test.ts`; record GREEN and commit.

## Task 5: Show actionable diagnostics in both players

**Files:** `packages/contracts/src/generation-review.ts`, `services/api/src/generation-review-projection.ts`, `packages/database/src/generation-review-summary-projection.ts`, shared generation presentation under `packages/client-core/src/generation/`, `apps/web-next/src/story-player-view.ts`, and `apps/web/src/story.js`. Extend projection/contract tests and `tests/e2e/generation-review.e2e.test.ts`.

**Interface:** Add a versioned, allowlisted technical review diagnostic to review detail and polling/SSE projections; retain semantic reason codes separately. Counts and phase may be public; provider bodies, prompts, credentials, and private reasoning must not be.

- [ ] Add RED projection tests for each technical category, absent historical diagnostics, malformed diagnostics, and private-data canaries.
- [ ] For output exhaustion display: “Continuity review reached its output limit. Your story is saved.” During fallback show “Retrying continuity review”; after exhaustion explain that review remains incomplete and show only server-authorized decisions. Avoid claiming the story itself failed validation.
- [ ] Verify Keep uses the existing integrity checks and sends no additional generation/review request; Retry clearly identifies the review stage. Test both `/story` and `/app/story`, including reload during fallback and restoration of a paused candidate.
- [ ] Run the focused projection unit suites and `corepack pnpm exec playwright test tests/e2e/generation-review.e2e.test.ts tests/e2e/generation-integrity-diagnostics.e2e.test.ts`; save sanitized desktop/mobile screenshots and commit after GREEN.

## Task 6: Release verification and compatibility

**Files:** update `docs/workflows/testing.md`, `docs/runbooks/deployment.md`, and the sanitized evaluation report from Task 1 with actual results.

- [ ] Complete the documented generation-review matrix: append/replacement, Action/scene, Story Direction, private-memory and foreign-campaign isolation, and independent illustration failure. Validate actual commit and next-turn replay, not only provider response parsing.
- [ ] Run `corepack pnpm test:unit --exclude '**/.worktrees/**' --exclude '**/.codex/**'`, `corepack pnpm test:integration`, `corepack pnpm check`, `corepack pnpm build`, and `git diff --check`. Report passed, failed, and skipped separately.
- [ ] Prove old jobs remain readable and unmodified. Test new versioned checkpoints with the selected rollback reader; if incompatible, prohibit rollback while those jobs are active and document safe drain/pause procedures. Do not deploy schema changes before this is resolved.
- [ ] Enable the evaluated policy on isolated copied-campaign canaries first. Verify actual request model/preset, response contract, budget, evidence identity, verdict correctness, cost, latency, candidate preservation, and accepted-state integrity. Do not run paid live calls without execution authorization.
- [ ] Release only after deterministic workflow, real PostgreSQL, browser, and live-review evidence are separately recorded. Monitor technical failure rate, fallback success, review latency, and usage by operation. Roll back policy for new jobs without rewriting already frozen jobs.

## Completion criteria

- A truncated review is durably and visibly identified as an output-limit failure.
- Review settings are independent of writing and frozen per job.
- A technical failure can consume at most one automatic fallback; genuine conflicts cannot be bypassed by it.
- The exact candidate survives all failed attempts and restarts; no implicit acceptance or replacement occurs.
- Both players explain the problem and offer only valid recovery actions.
- Reviewer quality and completion improvements are supported by evaluation, not inferred from unit tests or a smaller cap.

## Plan status

Implementation tasks 1–5 completed in scoped commits. Task 6 executed the deterministic unit, real-PostgreSQL, browser, typecheck, build, and diff checks; the full release suites contain failures and remain a release gate. Live-review evaluation, copied-campaign canaries, production policy enablement, and deployment were not authorized and remain skipped. The v1 rollback reader rejects v2 checkpoints, so rollback requires compatible-worker drain or an explicit pause before old workers return.

## Execution appendix

Tasks 1–5 are implemented and their focused RED/GREEN evidence is recorded in the task ledger. Task 6 completed the documented commands, but the full integration sweep failed in 10 of 118 files and the full unit command failed in two cases; release-only canary and live-review checks remain unchecked. The task database used the ignored dedicated `localhost:49186` URL, not the shared default authentication path. Rulings preserved from the execution ledger: retain the existing exception boundary for typed technical review outcomes; configure and freeze reviewer policy at the provider-profile route; reserve at most one fallback before dispatch and pause when a response cannot be reconciled; safe public diagnostics are allowlisted; and do not enable fallback without evaluated live evidence. Static baseline-reader inspection, rather than an executed old binary, established the v1/v2 rollback incompatibility.
