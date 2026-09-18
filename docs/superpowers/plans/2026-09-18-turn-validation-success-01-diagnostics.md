# Phase 01: Validation measurement and diagnostic preservation implementation plan

> **For agentic workers:** Use `superpowers:subagent-driven-development` when delegated. Follow the index handoff and review gates; execute checkbox steps in order.

**Goal:** Make success rates reproducible and preserve actionable, safe failure categories through final job disposition.

**Architecture:** Reduce immutable attempt observations and job outcomes into separate metrics. Persist a small allowlisted diagnostic in the existing private orchestration JSON without replacing review state or raw attempts; expose only a safe projection.

**Tech Stack:** TypeScript, PostgreSQL, Zod, Vitest.

**Spec:** [Index and global constraints](2026-09-18-turn-validation-success.md). Dependency: none beyond the verified baseline.

## Ownership and files

Create `packages/application/src/generation/outcome-metrics.ts`, `scripts/report-turn-validation.ts`, `tests/unit/generation-outcome-metrics.test.ts`, and `tests/unit/report-turn-validation.test.ts`.

Modify only where a test demonstrates the loss: `packages/contracts/src/generation-review.ts`, `packages/contracts/src/generation.ts`, `services/runtime/src/generation-executor-adapter.ts`, `services/api/src/generation-diagnostics.ts`, `services/api/src/server.ts`, `packages/database/src/generation-repository.ts`, `packages/database/src/generation-execution-repository.ts`, and `packages/application/src/generation/types.ts`. Inspect the worker failure caller before deciding the persistence seam. Reuse existing diagnostics rather than introducing a parallel public error system.

Tests to extend: `tests/unit/generation-diagnostics.test.ts`, `tests/unit/safe-generation-diagnostics.test.ts`, `tests/unit/generation-review-contracts.test.ts`, `tests/integration/generation-repository.integration.test.ts`. Document the report command in `docs/runbooks/turn-validation.md` (new).

## Task 1: Deterministic metrics

**New interface**, in `outcome-metrics.ts`:

```ts
export type ValidationObservation = Readonly<{
  jobId: string; attemptNumber: number; operation: "initial" | "repair";
  outcome: "valid" | "invalid" | "unknown";
}>;
export type JobOutcome = Readonly<{
  jobId: string; status: "completed" | "discarded" | "cancelled" | "failed" | "active";
}>;
export type ValidationMetrics = Readonly<{
  jobs: number; completedJobs: number; jobsWithInitialResponse: number;
  initialValid: number; initialInvalid: number; initialUnknown: number;
  repairResponses: number; validRepairResponses: number;
}>;
export function summarizeValidationOutcomes(
  jobs: readonly JobOutcome[], observations: readonly ValidationObservation[]
): ValidationMetrics;
```

- [ ] Add the regression below and run `corepack pnpm exec vitest run tests/unit/generation-outcome-metrics.test.ts`; capture RED for the absent behavior.

```ts
const result = summarizeValidationOutcomes(
  [{ jobId: "a", status: "completed" }, { jobId: "b", status: "failed" }],
  [
    { jobId: "a", attemptNumber: 1, operation: "initial", outcome: "invalid" },
    { jobId: "a", attemptNumber: 2, operation: "repair", outcome: "valid" },
    { jobId: "a", attemptNumber: 3, operation: "initial", outcome: "valid" }
  ]
);
expect(result).toEqual({ jobs: 2, completedJobs: 1, jobsWithInitialResponse: 1,
  initialValid: 0, initialInvalid: 1, initialUnknown: 0,
  repairResponses: 1, validRepairResponses: 1 });
```

- [ ] Implement selection of the earliest recorded primary response per job. Reclaims and explicit replacement attempts are subsequent attempts, not new first-pass jobs. Reject duplicate `(jobId,attemptNumber)` observations with conflicting values; identical duplicates count once. Sort by attempt number, never array position.
- [ ] Test cancellation after validation failure, pending review, no response/timeout, null diagnostics, output-limit responses, and one failed then successful repair. Empty historical `validation_errors` is valid only when a completed response exists; incomplete attempt rows remain unknown.
- [ ] Build `scripts/report-turn-validation.ts` with `--limit` (default 50, range 1–1000), optional UTC `--since`, and `--format json|markdown`. Use the existing DB connection mechanism, a `BEGIN READ ONLY` transaction, parameterized queries, and guaranteed rollback/close on errors. Query only bounded job/attempt metadata; do not fetch raw narration for routine reporting.
- [ ] Report UTC window, deployed/build identity when available, frozen prompt identity, actual returned model when available, configured model separately, play mode, review mode, context size buckets, and unknown cohort labels. Provide numerator/denominator for every percentage. Separate final job outcome from initial validation and repair outcomes.
- [ ] Prove SQL limit validation, read-only transaction behavior, and redaction with a fake DB client; run focused tests and capture GREEN.

## Task 2: Durable classification without unsafe error exposure

**Planned private field:** `orchestration_private.lastFailureDiagnostic`, a versioned object with fixed `category`, `code`, `phase`, `attemptNumber`, and timestamp. Categories: `format`, `mechanics`, `continuity`, `provider_timeout`, `provider_transport`, `output_incomplete`, `authority`, `unknown`. Reuse existing finite error codes where possible. No raw error messages, story text, URLs, credentials, or provider response bodies.

- [ ] Trace the timeout path from provider error to worker persistence to API serialization. Add a regression at the actual loss boundary. Avoid treating intentionally generic public strings as corrupted database evidence.
- [ ] Test a timeout then cancellation/discard: final status changes, safe underlying cause remains available for reporting. Preserve older attempt history; a latest diagnostic is not the historical event ledger.
- [ ] Extend the safe projection with a fixed diagnostic code/message for timeout and empty-output failures. Keep HTTP/SSE projections consistent. Unknown provider codes map to `unknown`, never to their raw text.
- [ ] Add injection fixtures containing URLs, credential-like strings, and private narration in error messages. Assert none reaches public JSON or metric output.
- [ ] Add real-PostgreSQL coverage that records a failure, changes its authorized disposition, then reports both facts without altering accepted state. New optional JSON fields must decode absent values on historical jobs.
- [ ] Run focused suites, inspect diff, record evidence, and commit `Preserve generation failure diagnostics and outcome metrics`.

## Exit gate

The report reproduces the synthetic denominator cases exactly; failure category survives disposition; no private payload is emitted. Run the report against production only as a separately scoped read-only operation. No model settings, parser acceptance, review consent, or provider retries change in this patch.
