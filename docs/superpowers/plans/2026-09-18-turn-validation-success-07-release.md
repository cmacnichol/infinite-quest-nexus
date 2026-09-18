# Phase 07: Integrated verification and rollout implementation plan

> **For agentic workers:** Use `superpowers:subagent-driven-development` when delegated. This is a verification and operations handoff, not permission to deploy or change production jobs.

**Goal:** Prove the combined corrections preserve integrity and measure whether user-visible generation success improves.

**Architecture:** Validate one immutable integrated SHA with synthetic providers and real PostgreSQL, then run a separately authorized staged canary. Roll back new request behavior without erasing durable job evidence or misreading newer checkpoints.

**Tech Stack:** Vitest, PostgreSQL integration harness, Playwright, Docker/Swarm runbooks, phase-01 metrics.

**Spec:** [Index](2026-09-18-turn-validation-success.md). Requires completed 01–04 and documented implement/defer decisions from 05–06.

## Task 1: Immutable integration review

- [ ] Gather every phase handoff and verify the actual implementation SHA matches reviewed evidence. Identify all changed prompts, wire schemas, provider modes, checkpoint versions, public contracts, and optional configuration values.
- [ ] Review the entire integrated diff for unrelated changes and accidental inclusion of production fixtures or secrets. Validate all plan/runbook links.
- [ ] Execute the documented combined checks from the isolated implementation worktree:

```powershell
corepack pnpm test:unit --exclude '**/.worktrees/**' --exclude '**/.codex/**'
corepack pnpm test:integration
corepack pnpm check
corepack pnpm build
corepack pnpm exec playwright test tests/e2e/generation-review.e2e.test.ts tests/e2e/generation-integrity-diagnostics.e2e.test.ts
git diff --check
```

- [ ] Confirm DB tests actually ran against the provisioned isolated database. Capture counts and failures, including known baseline failures with reproduction evidence. A baseline failure is not a pass and must be dispositioned before release.
- [ ] Complete both active Story client browser checks on desktop and 390×844. Store synthetic screenshots under `docs/review/assets/turn-validation-success/`.

## Required integration matrix

| Axis | Cases and assertions |
|---|---|
| Input format | strings; omitted no-op arrays; content-only wrapper; supported explicit repair; unknown metadata; empty/truncated output |
| Mode and operation | Story Direction and Action; append and replace-latest |
| Review policy | off, observe, enforce; semantic conflict after repaired formatting must still stop under enforce |
| Consent | no decision means no repair; correct revision/hash applies once; ordinary Retry unchanged; stale/foreign decision does nothing |
| Authority | visible active supersession succeeds; unseen/inactive/foreign ID fails; state/narration correction invalidates stale candidate |
| Durability | every phase-04 crash boundary, duplicate decision, lease loss, DB commit acknowledgment loss |
| Preservation | original response retained; protected story fields unchanged; canonical additions/updates follow approved repair table |
| Provider | no primary call for deterministic repair; timeout/refusal classified; optional strict schema has no hidden fallback call |
| Optional work | illustration unavailable/retry does not change accepted story; Chronicle failure follows existing durable contract |
| Compatibility | pre-change jobs, v1 review receipts, unknown future versions, old client refresh behavior, frozen model/prompt settings |

Use real state queries to assert rejected cases leave turns, campaign state, canonical facts, and accepted Chronicle rows unchanged. Use distinct owner/campaign fixtures, not merely mock scope IDs.

## Task 2: Canary preparation

- [ ] Produce a concrete rollout sheet: immutable image/SHA, compatible database/checkpoint versions, new-job prompt identity, optional settings, backup/restore prerequisites from the deployment runbook, in-flight-job policy, and rollback image compatibility.
- [ ] Prepare synthetic or explicitly authorized disposable campaign copies spanning short context, medium context, and the problematic long-context shape. Preserve the original campaigns.
- [ ] Fix the actual model/provider route, prompt cohort, temperature, output reserve, and review policy for comparisons. Separate prompt-only, explicit-repair, optional-context, and strict-schema cohorts; change one variable at a time.
- [ ] Present exact call count, maximum input/output tokens per request, price-based cost cap from current provider pricing, and stop conditions before requesting live-provider/deployment authorization. This plan itself supplies none of those authorizations.

## Task 3: Measure actual outcomes

- [ ] Use phase-01 reports with frozen UTC windows. Start with 20 completed-or-terminal jobs in the core new-prompt cohort as a smoke sample; continue to at least 50 eligible primary responses before reporting a stable directional first-pass comparison. Label small samples and report confidence intervals for proportions.
- [ ] Track first-pass schema/mechanics success, first-pass semantic success, no-user-intervention completion, completion after explicit repair, total accepted jobs, review interruptions, provider timeouts, latency, calls per accepted turn, and provider-reported cost. Never present deterministic repair as improved first-pass generation.
- [ ] Proposed targets for evaluation, not guarantees: at least 90% first-pass structural validity and at least 95% parser success for explicitly supported fact-format cases. Safety targets are absolute: zero unauthorized writes, duplicate accepted turns, cross-campaign access, hidden rewrites, or silent loss of supersession information.
- [ ] Count user cancellations/discards separately. An accepted-turn rate excludes active jobs from the terminal denominator and shows the excluded count. Also show outcomes for all started jobs so exclusions cannot hide failure.
- [ ] Review a bounded synthetic/copy narrative sample for factual/continuity degradation; do not improve the acceptance metric by disabling review or deleting failures.
- [ ] Stop immediately for any integrity violation, misleading repair disclosure, compatibility dead end, or unexpected provider redispatch. Pause optional experiments for sustained latency/cost regression or an increase in empty/timeout outcomes; report the measured comparison.

## Task 4: Rollback and final handoff

- [ ] Verify rollback with pending v1 and v2 reviews, authorized repair, applied repair awaiting semantic review, and committed job. Do not start an older worker against pending v2 jobs unless an independently tested claim fence prevents it from claiming them. The default rollback keeps a v2-capable worker and disables new repair offers; otherwise stop worker dispatch until compatible code is restored. Do not assume an unimplemented hold command exists.
- [ ] Disable optional strict output/context policy only for newly queued jobs. Existing jobs keep frozen settings and must be completed by compatible code or stopped for explicit operator/user action. Never rewrite their identities to make rollback appear compatible.
- [ ] Roll back application/request behavior without restoring the whole database over newly accepted turns. Preserve decisions, raw attempts, transformation journals, and cost records.
- [ ] Write `docs/review/turn-validation-success/final.md`: implemented/deferred phases, immutable SHAs, checks, screenshots, measured numerators/denominators, uncertainty, unresolved risks, and operational rollback steps.

## Exit gate

The deterministic matrix passes, live claims are supported by authorized evidence, and rollback respects durable jobs. If live execution is not authorized, finish with “implementation verified; live success-rate improvement unmeasured” and the prepared rollout sheet. Do not leave ordinary implementation verification incomplete merely because the canary is gated.
