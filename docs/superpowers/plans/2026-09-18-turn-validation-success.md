# Turn validation success implementation plan and specification

> **For agentic workers:** Use `superpowers:subagent-driven-development` when this plan is authorized for delegated execution. Implement one patch at a time with a fresh implementer, then independent specification and code reviews. This document authorizes planning only; it does not authorize deployment, paid provider experiments, or mutation of existing campaigns.

**Goal:** Improve first-pass format compliance and successful recovery while preserving narration, campaign authority, explicit review decisions, and durable attempts.

**Architecture:** Keep the strict accepted-turn contract and transactional commit boundary. Improve measurement and prompt compliance first, then add a separately authorized, deterministic fact-format repair for precisely classified shapes. Investigate context size and provider-enforced schemas as independently gated experiments.

**Tech Stack:** TypeScript, Zod, PostgreSQL, Fastify, Vitest, Playwright, the two active Story clients, existing text-provider adapters.

**Spec:** This document is the authoritative scope and acceptance specification for the linked phase plans.

## Evidence and baseline

Investigation baseline: checkout `2ce55088`, September 18, 2026. Recheck HEAD and deployed image before execution; this is a dated observation, not a live health assertion.

- Latest 50 jobs were created between September 16 01:21 UTC and September 18 05:05 UTC. Forty ultimately completed; this includes repaired generations.
- Of 49 jobs with a saved provider response, 15 passed their first recorded validation and 34 failed. First-pass success was 30.6%, not 80%.
- Latest 12 jobs: four completed, six discarded after review, one cancelled after invalid output, one provider timeout. These are job outcomes, not eight independent semantic rejections.
- Across those 50 jobs, 28 `schema_repair` attempts existed and 27 passed parsing. This is historical repair evidence, not a forecast for a new repair design.
- Thirty first responses had `canonical_facts` errors, including one response that was only `{}`. Six had `superseded_facts` errors; categories overlap.
- The deployed parser replayed 38 historically invalid responses: three now passed, 35 still failed. Dominant fact object keys were `content,id`; other shapes were `content,supersedes_fact_ids` and `content,estimatedTokens`.
- Job `03e53060-fcdc-4c2e-976b-aa6acf2adf5a` returned `{}` with reported input usage 496,754 tokens. Context pressure is a hypothesis, not a proven cause.
- Job `81778211-4ff4-4089-ac84-acefd195ead7` timed out in story generation. The logs retained `provider_request_timeout`; the public/final representation was generic. Determine which persistence/projection boundary loses specificity before changing it.
- New frozen prompts contain the explicit string-fact rule; older failed prompts do not. Two new responses passed with semantic review enforced. Do not disable semantic review to address schema errors.
- The current `if (firstReason) return pauseRejectedMain(...)` precedes an old `if (firstReason && !result.outputLimited)` repair branch. This is intentional review-first behavior with apparently unreachable legacy code, not authorization to restore silent full-turn rewriting.

The previous [generation format recovery plan](2026-09-18-generation-format-recovery.md) is implemented. Preserve its no-op-array normalization, content-only wrapper normalization, safe field diagnostics, and review-aware Retry behavior. This plan extends those changes; it does not redo them.

## Global constraints

1. Accepted turns remain immutable. Rejected candidates do not mutate accepted turns, campaign state, authoritative facts, or accepted Chronicle memory.
2. Strict parsing, mechanics separation, visible-fact supersession checks, campaign/owner/world scoping, stale-authority checks, and normal continuity review remain active.
3. Preserve original raw responses and producing request identity. Never relabel a historical snapshot with a new prompt or provider configuration.
4. A pending review causes no provider call or metadata transformation until its explicit, revision-bound decision. Ordinary retry does not imply review consent.
5. An explicit format repair preserves narration and every non-fact field. It does not generate new fiction, infer a replacement fact ID, or fill missing replacement state from history.
6. Complete JSON with a provider length finish is judged by actual completeness. `{}`, missing narration, truncated JSON, and mechanics contamination are not eligible for fact-format repair.
7. Changes target both `/story` and `/app/story` where UI behavior changes. The root archival `index.html` is outside scope.
8. Synthetic fixtures only in version control. Raw production response replay is local, read-only, and receives JSON as data; never interpolate model output into executable source. No secrets or private story data in reports.
9. Use isolated worktrees for implementation, `corepack pnpm` with the repository pin, and preserve unrelated changes. Do not integrate into the main checkout or deploy without the corresponding instruction.
10. No automatic relaxation of validation, context enlargement, model switch, concurrency increase, live job retry/discard, or accepted-data cleanup.

## Ordered patches and ownership

| Patch | Deliverable | Depends on | Owner scope |
|---|---|---|---|
| [01](2026-09-18-turn-validation-success-01-diagnostics.md) | Reproducible outcome report and safe durable failure classification | Baseline | Diagnostics/contracts/repository projections |
| [02](2026-09-18-turn-validation-success-02-prompts.md) | Unambiguous fact wire instructions for newly queued jobs | 01 | Prompt contract and frozen snapshots |
| [03](2026-09-18-turn-validation-success-03-repair-policy.md) | Pure fact-format repair planner with strict eligibility | 01; rebase after 02 | Story engine pure functions and synthetic fixtures |
| [04](2026-09-18-turn-validation-success-04-repair-workflow.md) | Explicit durable repair, UI disclosure, composed acceptance | 02, 03 | Review contracts, worker, DB, both clients |
| [05](2026-09-18-turn-validation-success-05-context.md) | Context composition diagnosis and gated bounded-context experiment | 01; use integrated 04 baseline | Context planner and evaluation tooling |
| [06](2026-09-18-turn-validation-success-06-structured-output.md) | Capability-gated strict-output experiment and optional adapter | 01, 02, 04 | Provider request contract and transport tests |
| [07](2026-09-18-turn-validation-success-07-release.md) | Combined verification, canary scorecard, rollback handoff | 01–04; dispositions from 05–06 | Release evidence and operations documentation |

Execute sequentially by default. Investigation for 05 or capability research for 06 can run alongside an implementation only if explicitly delegated; they must not edit shared files. Patches 05 and 06 may finish with an evidence-backed decision to retain current behavior. The core fixes do not depend on a successful experiment.

## Repair design decision

Choose an **explicit deterministic fact-format repair**, rather than another unconstrained full-story model call. The dominant observed variations contain their fiction text already. An agent can prove preservation and authority handling for a finite set of shapes without asking a model to rewrite them. This is a proposed new repair capability; current parser permissiveness remains unchanged.

Offer it only when all non-fact fields already validate and every malformed fact can be handled by patch 03's complete decision table. Keep the existing full-generation Retry path for ineligible responses. Public copy must distinguish the two operations before consent. Existing saved reviews retain their original retry meaning; do not reinterpret an already-issued decision.

Do not normalize `{id,content}` automatically in `parseStoryOutput`. The explicit operation records the original object, the chosen disposition, and a binding to the exact source response. IDs in additions never become database IDs or implicit supersession references. An object that appears to edit an existing visible fact without explicit replacement references is ineligible.

## Subagent dispatch and handoff protocol

Dispatch a fresh implementer with the full text of this index, the selected patch, `AGENTS.md`, current worktree path/branch/HEAD, and the preceding patch's handoff. The implementer reads referenced files before editing. The implementer owns only the selected patch; later requirements are acceptance constraints, not permission to implement later patches.

Use this dispatch message, replacing the bracketed values with actual values before sending:

```text
Implement patch [number] from docs/superpowers/plans/2026-09-18-turn-validation-success-[filename].md.
Read the index specification and AGENTS.md first. Work only in [absolute worktree path] on [branch] at [HEAD].
Previous handoff: [absolute handoff path]. Capture RED before production edits, then GREEN.
Preserve original candidates, explicit review consent, immutable prompt identities, and campaign isolation.
Complete only this patch; no production data changes, deployment, paid provider calls, or next-patch work.
Return changed files, immutable commit SHA, exact checks and results, remaining risks, and handoff location.
```

After implementation, send a fresh specification reviewer the selected plan, full diff, and evidence. Then send a fresh code reviewer the same immutable SHA plus relevant caller/callee context. The coordinator independently verifies every actionable finding, requests scoped corrections, and reruns affected checks. Reviewers do not alter the implementation branch. Merge/integration is a separate authorized action.

Each patch writes `docs/review/turn-validation-success/phase-NN.md` with:

- Base and final commit/image identity, scope, and changed files.
- Interfaces actually delivered and compatibility treatment for old jobs/clients.
- RED command, failure assertion, GREEN command and counts; passed/failed/skipped categories.
- PostgreSQL/provider/browser evidence clearly separated; screenshots for UI changes.
- Invariants checked, unresolved findings, experiment decision if applicable, rollback implications.
- Next patch readiness and exact files/contracts it can rely on.

## Shared verification procedure

Read [domain guide](../../agents/domain.md), [testing matrix](../../workflows/testing.md), [Story Engine](../../concepts/story-engine.md), [repository overview](../../architecture/repository-overview.md), and [deployment runbook](../../runbooks/deployment.md) at execution. Read relevant context docs and ADRs if present. Before context work also read [scene/mechanics review note](../../architecture/scene-context-mechanics-review.md).

Focused unit examples in each patch use synthetic data. After a code patch run its focused tests, affected contract/type checks, and `git diff --check`. Before combined release run the full documented checks in patch 07. Integration tests use `vitest.integration.config.ts` and the repository's isolated database provisioning, never the production database. A direct command with skipped DB cases is not a pass.

## Program completion criteria

- Existing conservative normalization remains correct with zero extra provider calls.
- Every supported fact-format transformation is exact, explicit, auditable, resumable, and validated through the normal commit boundary.
- Unsupported, stale, truncated, contaminated, or ambiguous responses stop safely with a useful reason.
- Reports distinguish first-pass compliance, authorized repair, final acceptance, review interruption, user disposition, provider timeout, and missing evidence.
- Prompt/protocol/model cohorts and actual provider attempts are counted separately; retries do not inflate the first-pass denominator.
- Deterministic adversarial tests pass; real-provider improvement is claimed only from the separately authorized canary.
- No numerical success promise is made from the historical 27/28 repair observation or a single large-context failure.
