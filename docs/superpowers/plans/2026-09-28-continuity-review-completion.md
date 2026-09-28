# Continuity Review Completion and Diagnostics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Execution method must be selected before implementation; this document does not dispatch agents.

**Goal:** Make continuity review reliably complete, explain incomplete reviews, and preserve trustworthy continuity enforcement without regenerating or silently accepting a story.

**Architecture:** Extend the existing reviewer route, attempt ledger, recovery checkpoint, and acceptance transaction. Introduce a versioned reviewer wire protocol with application-resolved citations, normalize it into the existing authoritative finding representation, and persist bounded diagnostic metadata. Evaluate frozen dedicated reviewer configurations before opting campaigns into enforcement or automatic fallback.

**Tech Stack:** TypeScript, Zod, PostgreSQL, Vitest, Playwright, existing text execution plans and provider transport.

**Spec:** The design and acceptance requirements below implement the September 28 review discussion. Read alongside the [earlier reliability plan](2026-09-26-continuity-review-reliability.md), [evaluation evidence](../../review/continuity-review-reliability-evaluation.md), [testing matrix](../../workflows/testing.md), [transport ADR](../../architecture/0012-provider-transport-deadlines.md), and [deployment runbook](../../runbooks/deployment.md). Earlier tasks already implemented are dependencies, not work to repeat.

## Evidence and scope

The read-only September 27/28 inspection found 27 saved review checkpoints in the preceding seven days: 15 pass, six uncertain, six unavailable, zero conflict. This is a retained-checkpoint distribution, not an attempt-level failure rate or proof of reviewer accuracy. All six uncertain records had empty findings; historical data cannot reliably distinguish explicit model uncertainty from invalid responses/citations.

The latest reviewed job used the shared story preset with temperature 0.8 and max_tokens 48000. Its dedicated reviewer snapshot was disabled with no fallback. The call failed after approximately 545 seconds; the transport log said transportTimedOut=false while the checkpoint said provider_timeout. Root cause of that disagreement is unresolved. The image had no usable source commit metadata. Do not turn these observations into a guessed timeout fix or an unmeasured token recommendation.

Already present: typed technical outcomes, independent reviewer policy/snapshots, optional single fallback, review-aware budgeting, recoverable candidates, and new-campaign review-off migration 0112. The old rollout runbook still describes Max/enforce as the default. Verify current code and migration behavior before correcting that documentation.

This plan covers implementation, deterministic verification, an isolated evaluation capability, and a staged operational rollout. Preparing this plan authorizes no implementation, paid calls, production setting changes, acceptance, retry, cancellation, migration execution, or deployment.

## Global constraints

- Use a suitable managed isolated worktree at implementation time. Preserve existing main-checkout edits, especially Story UI/workflow and related tests observed during planning. Record base SHA and dirty state; do not integrate into main implicitly.
- Keep owner, campaign, world-version, candidate, producing-request, evidence, policy, and route bindings intact. Accepted turns and authoritative campaign state change only through the normal validated transaction.
- Keep historical protocols and frozen jobs immutable. New readers support old records; old readers must not claim unsupported new jobs. Never relabel an old request with a new protocol.
- Keep structural, mechanics, fact-authority, and image-isolation safeguards. Review-off bypasses reviewer configuration/dispatch only. Observe is an explicit policy choice and does not claim enforced continuity.
- A technical failure never means narrative conflict. A semantic uncertain/conflict result never triggers automatic technical fallback. No retry-to-pass loops.
- Reuse the current one-primary/one-optional-fallback policy per authorized review cycle. Lease recovery, lost responses, and duplicate decisions must not reset consumed attempts.
- No raw prompts, story text, private reasoning, credentials, or provider bodies in public diagnostics or committed evaluation artifacts. Preserve existing private-artifact retention controls.
- Do not edit reference-only index.html. Verify both currently served Story surfaces where shared diagnostics change, unless an explicit cutover supersedes coexistence before execution.
- Use RED/GREEN evidence for behavioral changes, review associated tests for every changed file, and report unit, PostgreSQL, browser, and live-provider evidence separately.

## Design decisions

### Outcome and protocol model

Retain the normalized story-continuity-review-v1 finding representation internally so repair/acceptance still consume verified evidence hashes and exact offsets. Add story-continuity-review-v2 as a distinct provider wire protocol. Protocol selection comes from the frozen prompt/response contract, never response guessing.

V2 uses request-local IDs e1, e2, ... assigned in frozen manifest order. Persist/hash the alias map with the prepared request. It cannot be reused across requests. Candidate references use a literal candidate namespace bound by the application to the current draft hash; the model does not generate hashes.

A v2 citation contains path and exact quote, optionally exact prefix/suffix context to disambiguate duplicates. It contains no numeric offsets. Use JavaScript string indexing to compute UTF-16 offsets after matching the unchanged field. Enumerate all exact occurrences, including overlapping ones; accept only one match after optional immediately adjacent context filtering. Never trim, normalize Unicode, case-fold, fuzzy-match, or pick the first duplicate. Allowlist the projected fiction fields and array elements; reject scratchpad/prototype/unknown paths.

V2 responses retain pass/conflict/uncertain and bounded findings. Require at least one structured uncertainty reason for explicit uncertain. Reason codes are conflicting_authority, unsupported_assertion, insufficient_evidence, and other_uncertainty; other_uncertainty requires a bounded explanation. Bound explanations/quotes to 1000 characters, findings/reasons to 20 each, and the entire visible JSON response to 20000 characters before parsing.

Diagnostic codes: invalid_json, invalid_schema, response_too_large, invalid_quote, ambiguous_quote, invalid_offset (v1), invalid_output_path, unknown_evidence_id, invalid_candidate_binding, missing_required_evidence, evidence_binding_mismatch, and conflict_without_contradiction. An absent required source or broken binding is evidence_unavailable and is not fallback eligible. Malformed/citation-invalid output is invalid_output with a precise diagnostic code; no semantic verdict is accepted. Preserve the schema-valid reported verdict separately from the validated verdict. Mixed valid/invalid findings do not partially pass a response.

Add version 3 durable attempt outcomes and checkpoints rather than adding new fields to strict v2 shapes. V3 preserves existing cycle/attempt bookkeeping and stores bounded reason codes, reportedVerdict (nullable), validated result (semantic only), existing safe provider metadata, and an optional response hash. It does not persist raw output in this metadata. Read v1/v2 unchanged and display unknown historical reason when detail is absent; do not backfill guesses.

### Execution and policy

Keep shared-writer compatibility for profiles without dedicated reviewer settings, but expose that source accurately. Dedicated selection controls its own route, output allowance, temperature, and overall deadline within supported provider capabilities. Preserve named-preset on-wire identity and strict operation-specific schema. Never silently inherit writer reasoning/sampling overrides into a dedicated reviewer.

Normalize structured timeout/cancellation/transport evidence at the provider boundary under ADR 0012. Cancellation and lease loss propagate as control flow. An explicit non-timeout transport code overrides message-text heuristics. Unknown transport errors remain provider_failed. Preserve original safe code, timeout flag, configured deadline, elapsed duration, and diagnostic provenance; use a shared classifier so logs and checkpoints agree.

Automatic fallback remains opt-in and at most one. It may handle output_limit, invalid_output, provider_timeout, or provider_failed after a completed failed attempt. It cannot handle semantic uncertainty/conflict, missing evidence, over-budget requests, ambiguous in-flight reservations, or cancellation. Review-cycle identity, normalized candidate, source evidence and alias-map identity remain unchanged across fallback; route/request hashes may differ legitimately. Never truncate required evidence to make fallback fit.

## Review focus

1. Unicode, overlapping/repeated quotations, escaped JSON and array paths resolve identically and never point to another passage (Task 2).
2. Old frozen prompts, custom overrides, and queued/recoverable jobs retain their protocol and remain actionable after upgrade (Tasks 1, 3, 8).
3. Cancellation, a worker restart between dispatch and persistence, and duplicate retry decisions cannot create paid duplicate requests (Tasks 4, 6).
4. Plausible new fictional facts, lies, dreams, flashbacks, and explicit corrections are not rejected merely for being absent from source authority (Task 7).
5. Provider settings changes mid-flight, smaller fallback contexts, and preset response-format differences cannot change bound authority or leak another campaign (Tasks 3, 4, 6).

## Task 1: Versioned diagnostics and historical readers

**Files:** Modify packages/contracts/src/generation-review.ts, packages/application/src/memory/continuity-review-checkpoint.ts, services/runtime/src/story-continuity-review-adapter.ts; tests/unit/generation-review-contracts.test.ts, tests/unit/continuity-review-checkpoint.test.ts, tests/unit/story-continuity-review-adapter.test.ts.

**Interfaces:** Export ContinuityReviewDiagnosticCode, ContinuityReviewValidationIssue { code, findingIndex?: number }, and ContinuityReviewValidationResult as a union of semantic_verdict { reportedVerdict, review, uncertaintyReasons } and technical_failure { reportedVerdict, failure, issues }. Add strict v3 schemas while retaining v1/v2 readers. Version-3 outcomes carry this validation detail plus safe provider metadata.

- [ ] Add failing tests named retains_reported_verdict_when_citation_invalid, rejects_unbounded_diagnostics, reads_v1_v2_without_invented_reasons, and rejects_unknown_v3_fields. Assert invalid citation yields technical_failure/invalid_output, not semantic uncertain; old records retain their saved verdict.
- [ ] Run `corepack pnpm exec vitest run tests/unit/generation-review-contracts.test.ts tests/unit/continuity-review-checkpoint.test.ts tests/unit/story-continuity-review-adapter.test.ts`; record the intended RED assertions.
- [ ] Implement contracts/readers and v1 detailed validation diagnostics without rewriting frozen old outcomes. New attempts may emit v3 outcomes even when executing the frozen v1 wire protocol.
- [ ] Repeat the command for GREEN; review diff and commit `Add versioned continuity review diagnostics`.

## Task 2: Deterministic citation resolution

**Files:** Create packages/story-engine/src/continuity-review-citations.ts and tests/unit/continuity-review-citations.test.ts. Modify packages/story-engine/src/continuity-review.ts, packages/contracts/src/story-continuity-review.ts, tests/unit/story-continuity-review.test.ts, tests/unit/story-continuity-review-contracts.test.ts.

**Interfaces:** Export resolveContinuityQuote(text: string, citation: { quote: string; prefix?: string; suffix?: string }): { kind: 'resolved'; start: number; end: number } | { kind: 'invalid'; code: 'invalid_quote' | 'ambiguous_quote' }. Export validateContinuityReviewDetailed(input: ContinuityReviewInput, response: unknown, protocol: 'story-continuity-review-v1' | 'story-continuity-review-v2', aliases: Readonly<Record<string, string>>): ContinuityReviewValidationResult. Keep the existing validator wrapper for historical callers while runtime adopts the detailed result.

- [ ] Write RED cases: exact emoji quotation computes UTF-16 offsets; repeated/overlapping text is ambiguous; exact adjacent context uniquely disambiguates; invented context fails; escaped JSON is matched after decoding; forbidden path fails; unknown alias cannot resolve against another manifest; one invalid finding invalidates the whole response; v1 bad offsets produce invalid_offset. Include pass-with-contradiction as invalid schema/semantic consistency, and conflict-with-only-warnings as conflict_without_contradiction.
- [ ] Run `corepack pnpm exec vitest run tests/unit/continuity-review-citations.test.ts tests/unit/story-continuity-review.test.ts tests/unit/story-continuity-review-contracts.test.ts` and record RED.
- [ ] Implement exact occurrence matching, bounded v2 wire schema, alias normalization, and detailed validation. Normalized findings contain original evidence hashes and application-computed offsets; source authority cannot be manufactured by candidate references.
- [ ] Run the same suite for GREEN and commit `Resolve continuity citations deterministically`.

## Task 3: Freeze and dispatch the new review protocol

**Files:** Modify packages/contracts/src/prompt-library.ts, packages/contracts/src/text-response-format.ts, packages/contracts/src/generation-response-contract.ts, services/runtime/src/generation-response-contract.ts, services/runtime/src/story-continuity-review-adapter.ts, services/runtime/src/continuity-review-execution.ts, services/runtime/src/generation-context-planner.ts as required by exact-payload budgeting. Tests: tests/unit/prompt-library.test.ts, tests/unit/continuity-review-execution.test.ts, tests/unit/story-continuity-review-adapter.test.ts, tests/integration/generation-response-contract-operations.integration.test.ts, tests/integration/story-memory-compatibility.integration.test.ts.

**Interfaces:** PreparedContinuityReview gains frozen reviewProtocol and evidenceAliases; its requestHash covers the actual serialized v2 prompt, schema, projection and aliases. validatePreparedContinuityReviewResult returns Task 1's v3 outcome. Preserve existing review/repair interfaces by normalizing v2 findings before repair.

- [ ] Add RED assertions for v1 golden request unchanged, v2 alias/schema binding, protocol/schema mismatch rejected before dispatch, prompt override retaining its frozen identity, named preset preserved on wire, and reviewer budget including complete alias/prompt/schema/candidate overhead. Cover review-off without reviewer preparation and a mismatched response/request hash.
- [ ] Run `corepack pnpm exec vitest run tests/unit/prompt-library.test.ts tests/unit/continuity-review-execution.test.ts tests/unit/story-continuity-review-adapter.test.ts` and record RED.
- [ ] Add explicit supported v2 prompt identity and operation schema selection. New requests use v2 only after compatible-reader rollout; old custom overrides are not silently rewritten. Regenerate/verify schema and prompt-preview expectations using existing repository tooling.
- [ ] Run unit command for GREEN and `corepack pnpm exec vitest run --config vitest.integration.config.ts tests/integration/generation-response-contract-operations.integration.test.ts tests/integration/story-memory-compatibility.integration.test.ts`; require executed PostgreSQL cases. Commit `Freeze versioned continuity reviewer requests`.

## Task 4: Consistent transport classification and bounded execution

**Files:** Modify packages/story-engine/src/provider-transport.ts, services/runtime/src/prepared-text-executor.ts, services/runtime/src/story-continuity-review-adapter.ts, services/runtime/src/generation-executor-adapter.ts, packages/application/src/memory/continuity-review-attempt-policy.ts, services/runtime/src/continuity-review-execution.ts. Tests: tests/unit/prepared-text-executor.test.ts, tests/unit/story-continuity-review-adapter.test.ts, tests/unit/continuity-review-attempt-policy.test.ts, tests/unit/continuity-review-execution.test.ts.

**Interfaces:** Reuse normalized transport diagnostics; add classifyContinuityTransportFailure(error: unknown) returning control-flow cancellation/lease loss or the existing technical category plus allowlisted transport metadata. Both adapter paths consume it. nextContinuityReviewAction retains its current signature and accepts v3 outcome semantics.

- [ ] Write RED tests: explicit transportTimedOut=false with timeout-like message remains provider_failed; explicit request deadline becomes provider_timeout; cancellation/lease loss propagates; configured dedicated deadline and sampling do not inherit writer overrides; one eligible failure selects fallback; uncertain/conflict selects no fallback; incomplete reservation pauses; evidence/context failure selects no fallback; a smaller fallback refuses before dispatch without dropping evidence.
- [ ] Run `corepack pnpm exec vitest run tests/unit/prepared-text-executor.test.ts tests/unit/story-continuity-review-adapter.test.ts tests/unit/continuity-review-attempt-policy.test.ts tests/unit/continuity-review-execution.test.ts` and record RED.
- [ ] Trace the observed timeout mismatch through existing wrappers and implement the narrow typed classification correction. Apply v3 persistence and existing fallback ledger to both shared and dedicated routes; shared mode still has no implicit fallback. Preserve request-scoped deadlines and failure reservations.
- [ ] Repeat for GREEN; commit `Unify continuity transport and fallback outcomes`.

## Task 5: Safe diagnostics and configuration visibility

**Files:** Modify packages/contracts/src/generation-review.ts, services/api/src/generation-review-projection.ts, packages/database/src/generation-review-summary-projection.ts, apps/web-next/src/story-player-generation.ts, apps/web-next/src/story-player-view.ts, apps/web/src/story.js and shared diagnostic consumers where traced. Tests: tests/unit/generation-review-projection.test.ts, tests/unit/generation-review-summary-projection.test.ts, tests/unit/web-next-story-generation.test.ts, tests/e2e/generation-review.e2e.test.ts, tests/e2e/generation-integrity-diagnostics.e2e.test.ts. Update docs/installation/provider-configuration.md with existing dedicated-policy configuration instructions.

**Interfaces:** Version the browser-safe diagnostic projection for v3 while keeping the existing v1 reader. Expose category, bounded reason codes, phase, attemptCount, maxAttempts, state, and configurationSource ('shared_writer' or 'dedicated'). Do not expose raw reported responses or private evidence aliases/content. UI decisions remain server-authorized.

- [ ] Write RED projection/UI tests for every diagnostic category, historical unknown detail, malicious extra fields, API/SSE/polling agreement, and shared versus dedicated configuration. Coordinate with pre-existing UI edits rather than replacing them.
- [ ] Run `corepack pnpm exec vitest run tests/unit/generation-review-projection.test.ts tests/unit/generation-review-summary-projection.test.ts tests/unit/web-next-story-generation.test.ts` and record RED.
- [ ] Implement concise status copy: 'Continuity review could not verify its citations. Your draft is saved.'; 'Continuity review could not reach a conclusion.'; and existing specific timeout/output-limit text. Show fallback progress without implying a new story is being written. Preserve Keep/Retry eligibility and historical unknown explanations.
- [ ] Run for GREEN, then `corepack pnpm exec playwright test tests/e2e/generation-review.e2e.test.ts tests/e2e/generation-integrity-diagnostics.e2e.test.ts` against a disposable runtime. Verify reload while fallback runs, paused-draft recovery, mobile/desktop, both served Story surfaces, and privacy canaries. Save sanitized screenshots; commit `Explain continuity review failures and configuration`.

## Task 6: Prove durable recovery and acceptance integrity

**Files:** Extend tests/integration/story-continuity-review.integration.test.ts, tests/integration/generation-review.integration.test.ts, tests/integration/story-continuity-remediation.integration.test.ts and tests/integration/generation-response-contract-workflow.integration.test.ts. Modify only the runtime/repository seams exposed by failing regressions; use existing generation job repository ownership/transaction rules.

**Interfaces:** Compose Tasks 1–5 through real PostgreSQL and the deterministic provider, using existing enqueue/review decision/commit APIs. No direct job-status mutation as a substitute for recovery.

- [ ] Add RED workflows for append and replacement with Action and scene input: valid story -> invalid citation -> preserved checkpoint -> explicit decision; eligible technical failure -> one fallback -> pass; fallback failure -> pause. Assert accepted-state/Chronicle/illustration state unchanged while paused, and Keep commits once with zero additional writer/reviewer calls.
- [ ] Add restart/crash cases before dispatch, after dispatch, after response before checkpoint, and after checkpoint; duplicate decision receipts; stale candidate; changed profile after enqueue; foreign campaign evidence; repair consuming normalized v2 findings; explicit new retry cycle does not reuse a prior candidate's findings. Count physical calls and durable reservations.
- [ ] Run `corepack pnpm exec vitest run --config vitest.integration.config.ts tests/integration/story-continuity-review.integration.test.ts tests/integration/generation-review.integration.test.ts tests/integration/story-continuity-remediation.integration.test.ts tests/integration/generation-response-contract-workflow.integration.test.ts`; record RED, make minimal fixes, rerun for GREEN with no silent DB skips.
- [ ] Commit `Verify durable continuity review recovery` after reviewing all affected tests and transaction boundaries.

## Task 7: Isolated reviewer evaluation and operating limits

**Files:** Create scripts/evaluate-continuity-review.ts, scripts/lib/continuity-review-evaluator.ts, scripts/fixtures/continuity-review-evaluation.v1.json, tests/unit/continuity-review-evaluator.test.ts, tests/integration/continuity-review-evaluator.integration.test.ts. Reuse scripts/lib/private-continuity-artifact.ts and existing live-evaluation budgeting/authorization helpers. Modify package.json to expose evaluate:continuity-review and docs/runbooks/story-continuity-evaluation.md; create docs/review/continuity-review-completion-evaluation.md for sanitized evidence.

**Interfaces:** CLI supports --mode deterministic|live, --output, and in live mode requires --live, --source-campaign, --campaign-copy, --source-authorization, --provider, --max-calls, --max-input-tokens, --max-output-tokens, --max-cost-usd, declared price ceilings, --run-id, and --private-artifact-dir. Reviewer configurations are credential-free frozen input records. The existing story evaluator replays main requests; do not misrepresent it as reviewer evaluation.

- [ ] Write RED tests for missing authorization/budget refusal, reservation before dispatch, no retry after uncertain/conflict, immutable paired evidence, rejection of foreign/missing source bindings, private artifact path constraints, and no campaign/job/turn writes. Distinguish fixture-induced failures from natural provider failures in reports.
- [ ] Build 40 labeled synthetic cases: 10 consistent (including plausible new events), 10 real contradictions, 10 legitimate ambiguities, and 10 citation/transport/size adversarial cases. Include corrections, intentionally empty state, lies, dreams, flashbacks, repeated Unicode quotations, and small/large evidence. Freeze labels before comparing configurations; labels never enter model prompts. Give each semantic case three repeats per configuration, reported as clustered repeats rather than independent scenarios.
- [ ] Run `corepack pnpm exec vitest run tests/unit/continuity-review-evaluator.test.ts`, then the explicit integration configuration for tests/integration/continuity-review-evaluator.integration.test.ts. Capture RED, implement bounded reviewer-only replay and aggregate reporting, then capture GREEN. Run `corepack pnpm evaluate:continuity-review --mode deterministic --output docs/review/continuity-review-completion-evaluation.json` against isolated fixtures.
- [ ] Report raw and validated verdicts, citation rejection codes, explicit uncertainty, first-attempt completion, completion after fallback, false conflicts, missed conflicts, unresolved rate, latency percentiles, usage, cost, and physical call counts by protocol/route/evidence-size stratum. Include censored timeouts and failed calls in denominators. Zero confirmed conflicts in production is not an accuracy label.
- [ ] Prepare a concrete live manifest comparing the current shared configuration and at most two dedicated candidates, holding evidence/candidates fixed. Proposed experimental settings: temperature 0 where supported; output allowance 4096 first, 8192 only as a separately recorded arm if truncation occurs; 120000 ms request deadline. These are evaluation settings, not production recommendations. Account for hidden route attempts and provider-reported token overages; stop if ceilings are exceeded.
- [ ] Commit evaluator and deterministic evidence `Add isolated continuity reviewer evaluation`. Live calls require separately authorized configurations and total spend; absent authorization mark live evaluation pending without claiming rollout readiness.

## Task 8: Release, canary, rollback and documentation

**Files:** Update docs/runbooks/story-memory-rollout.md, docs/runbooks/story-continuity-evaluation.md, docs/installation/provider-configuration.md, docs/workflows/testing.md, docs/runbooks/deployment.md, and the Task 7 report. Add compatibility fixtures to tests/integration/story-memory-compatibility.integration.test.ts. No database migration is assumed: checkpoint versions fit existing JSONB; any needed schema constraint change requires a separate migration/rollback review.

- [ ] Add RED compatibility tests for historical v1/v2 paused jobs, new v3 jobs, frozen custom v1 prompts, and unsupported-reader behavior. Implement only missing readers/claim fencing, then rerun those tests for GREEN. Deploy compatible readers before enabling v2 writers, with intake paused and old worker leases drained under the deployment runbook.
- [ ] Reconcile runbook defaults with migration 0112 and current enrollment code. Explain that a disabled dedicated reviewer snapshot means shared-writer review, whereas campaign reviewMode=off means no review. Document observe as an explicit future-job policy and record its reduced enforcement. Do not change production defaults or existing enrollments as part of documentation repair.
- [ ] Run `corepack pnpm test:unit --exclude '**/.worktrees/**' --exclude '**/.codex/**'`, `corepack pnpm test:integration`, `corepack pnpm check`, `corepack pnpm build`, the Task 5 browser suites, and `git diff --check`. Record actual pass/fail/skip counts and causes. Reproduce suspected baseline failures before attributing them; failed gates remain failed.
- [ ] Require accurate image commit/date/dirty provenance and exact wire-contract verification for any canary. Missing provenance blocks rollout sign-off; it does not block completing local implementation.
- [ ] Proposed live promotion gate, fixed before live runs: at least 95% first-attempt technically valid reviews; at least 99% after one configured fallback; no false conflicts on labeled consistent cases; at least 90% conflict detection on labeled contradictions with uncertainty counted as a miss; no failures of expected semantic labels in uncertainty cases; primary p95 latency <=120 seconds, combined p95 <=240 seconds. Publish sample counts and uncertainty intervals; these small-corpus gates are engineering acceptance criteria, not population accuracy guarantees. Cost must stay within the approved manifest. Do not loosen thresholds after observing results without recording a new experiment.
- [ ] After live gates, enable the selected policy only on authorized copied-campaign canaries for at least 50 reviews over at least 48 hours. Start observe with zero automatic fallback to measure primary behavior, then evaluate the bounded fallback explicitly; enforce only after human adjudication and integrity checks pass. No unattended changes to real campaigns. Report every reviewed job, not only successful jobs.
- [ ] Stop expansion on any authoritative-state/isolation/duplicate-dispatch defect, or a rolling 50-review technical noncompletion rate over 5%, or p95 exceeding the approved latency limit. Observe unknown outcomes separately. Produce operation-scoped aggregate counters from durable attempts, including provider failures absent from billing rows; avoid raw content and high-cardinality IDs in metric labels.
- [ ] Roll back policy for newly enqueued jobs using the normal API; leave existing jobs on their frozen route/protocol. Drain or preserve new-version jobs before binary rollback. Prove the selected rollback binary reads v3, otherwise document that policy rollback is supported but binary rollback requires a compatible reader. Never delete checkpoints or force-accept to facilitate rollback.
- [ ] Review the complete branch diff and commit `Document continuity reviewer rollout evidence`. Deliver a PR-ready summary with compatibility, prompts/contracts, configuration, tests, screenshots, and pending operational gates. Publishing/merging/deployment follow the execution authorization actually provided.

## Dependency and completion checklist

Tasks 1 -> 2 -> 3 -> 4 -> 5 -> 6 -> 7 -> 8 are the default sequence. The evaluation corpus may be authored after Task 2 while implementation proceeds, but live replay requires the final frozen contracts. No parallel edits to the same contracts/runtime files.

- [ ] Invalid citations have deterministic diagnostics; semantic uncertainty includes a reason on v2 wire responses.
- [ ] Exact quotation resolution eliminates model offset counting without relaxing evidence validation.
- [ ] Shared/dedicated settings, frozen schema identity, transport classification and bounded fallback are verified.
- [ ] Existing jobs remain recoverable; acceptance, retry, repair, cancellation and reclaim remain idempotent and scoped.
- [ ] Both active Story interfaces show safe actionable results; existing unrelated work is preserved.
- [ ] Local engineering completion and operational rollout readiness are reported separately. Live/configuration/deployment gates may remain pending; they must never be described as completed based on mock tests.
- [ ] No production policy change, user-story content commit, or accidental provider call occurs during implementation/testing.

## Plan self-review

Coverage: diagnostics and timeout disagreement (Tasks 1/4/5); offset removal and short IDs (Tasks 2/3); dedicated configuration and fallback reuse (Tasks 3/4/7); recovery/integrity (Task 6); accuracy and new-fiction semantics (Task 7); observe, deployment, monitoring and rollback (Task 8). Versioned wire output and normalized internal findings are deliberately separate. New tests/files/CLI options named above are implementation deliverables, not claims of current availability.
