# Characters Revamp Implementation Plan

**Implementation record:** Work is implemented on `codex/characters-revamp` in the dedicated worktree. See the [acceptance report](../../review/campaign-cast/revamp-acceptance.md) for final evidence, reviewed deviations and verification limits. The original task checklists below are retained as the planning specification; they are not a deployment approval.

> **For agentic workers:** Implement in the dedicated worktree using `gpt-6.1-terra` subagents where practical. Follow the execution and minimal-test policy in the overview; it overrides broader test-addition instructions in earlier plans. Steps use checkbox (`- [ ]`) syntax for tracking. This document plans the work; it does not authorize deployment.

**Goal:** Make campaign characters easy to browse and edit, track supported developments automatically, and reserve manual review for ambiguity and conflicts.

**Architecture:** Retain the existing world roster, campaign protagonist profile, and evidence-backed campaign cast as distinct authorities. Share presentation models and browser workflows across the legacy and replacement clients, keeping rendering in each application. Extend existing discovery, lifecycle, and context-selection services rather than introducing another character store or another narrator.

**Tech Stack:** TypeScript, existing DOM/Web Awesome application components, Zod, Fastify, PostgreSQL, existing durable workers, Vitest, Playwright, pnpm. No new frontend framework or provider dependency.

**Spec:** [Character revamp review](../../review/2026-11-06-character-revamp-review.md), [SillyTavern research](../../review/2026-11-06-sillytavern-characters.md), and [October auto-match plan](2026-10-04-campaign-cast-auto-match.md), reconciled below. Current inspected baseline: `6cd29919d419b02b846d1c53747262de1dd4c6ad`.

## Execution setup

- Use the new managed worktree at `C:/Users/chris/.codex/worktrees/characters-revamp/InfiniteQuest`, branch `codex/characters-revamp`. It starts from the inspected baseline and contains these plans and their two source reviews. The original checkout is not the implementation workspace.
- Run all implementation edits, commands, and checks with this worktree as the explicit working directory. Install dependencies only when implementation needs them, using the repository's pinned package manager. For this documentation update, no install or application baseline run is required.
- Delegate bounded implementation tasks to Terra subagents (`model: "gpt-6.1-terra"`, `fork_turns: "none"`). Supply the absolute worktree path, relevant instructions and plan sections, inputs/outputs, owned files, existing test coverage, and the minimum required verification in each task brief.
- The coordinating agent owns integration, shared-contract decisions, and the final review. Use Terra for scoped implementation/review where supported; perform a task directly if delegation is impractical or Terra is unavailable, and report a material model substitution.
- Parallelize only work with disjoint file ownership and settled interfaces. Serialize changes to shared contracts, repositories, migrations, and generation paths. All agents use this worktree; they must not edit the original checkout or create competing branches for the same task.
- Preserve the dependency order below. Reuse a task's verified test evidence when handing off to another agent instead of rerunning unchanged suites. Do not start product implementation merely to complete this plan revision.

## Minimal new-test policy

The goal is the smallest additional test set that proves changed behavior, not a test per function, file, field, or listed edge case. Review each changed file's associated tests as the repository requires; update existing expectations whenever behavior changes. Do not delete useful existing coverage to reduce the count.

1. Locate existing coverage first. Treat scenario lists in the child plans as coverage-review inventories, not instructions to add a new test for every item. Cite existing coverage and add only uncovered behavior affected by the change.
2. Prefer extending an existing fixture or parameterized case. Consolidate related state transitions into one coherent workflow, but keep assertions diagnostic. Do not move an existing test to a new file just to satisfy a planned filename.
3. Test a risk at its owning layer. Use domain tests for matching rules, PostgreSQL for atomicity/ownership/history, and a shared browser journey for UI integration. Do not repeat the same backend matrix in unit, API, integration, and browser suites.
4. Do not add tests for styling, labels, static field layouts, trivial forwarding, or implementation structure. Verify those through existing browser journeys and the required rendered checks/screenshots. Keep new UI regressions for draft preservation and stale campaign responses where existing tests cannot prove them.
5. Default to existing test files. Only two new files are provisionally justified: `tests/unit/characters-workspace-session.test.ts` for timer/cancellation races and `tests/unit/campaign-cast-mentions.test.ts` for the new lexical matcher. Even these may be avoided if an existing suite is a natural owner. Any additional new file/case must identify a concrete uncovered regression risk in the implementation report; no new approval round is required.
6. Where a new regression case is necessary, demonstrate it fails for the intended missing behavior before implementation, then passes. Existing passing coverage need not be rewritten or artificially made to fail. A test is not required solely to satisfy a red/green checklist step.
7. Run affected suites during implementation; run the required repository-wide checks once for the integrated release candidate. Repeat only after relevant changes, failures, or unresolved concerns. A6 and U6 share one acceptance report and one set of final run results.

Minimum incremental coverage by change (extend existing cases wherever possible):

| Change | Smallest useful addition or extension |
| --- | --- |
| U1 profile forms | One lossless-edit fixture covering unknown fields and intentional blank/clear semantics. |
| U2 refresh/filtering | A compact fake-timer race case for dirty drafts/campaign switching, plus the existing API pagination fixture extended with filters. |
| U3/U4 rendering/review | Extend the existing cast browser journey, parameterized over the two Story surfaces; reuse it for normal editing, review, undo, and screenshots. Do not create duplicate renderer suites. |
| U5 context explanation | Extend existing selector expectations and one existing generation integration fixture with preview equality and a private-data canary. |
| A1 matching policy | Extend the discovery table with strict versus relaxed, ambiguous/declined, and hidden-collision cases; reuse existing source-validation cases unchanged. |
| A2 undo/portability | Extend existing lifecycle and archive fixtures with attachment/detach metadata, retained overrides, cleanup, and round-trip assertions. |
| A3 frozen jobs | Extend a checkpoint/retry fixture with a gate change, captured policy, and duplicate-publication assertions. |
| A4 lexical mentions | One compact matcher table, plus the existing accepted-turn workflow extended with mention failure and detach-range effects. |
| A5 detail decisions | Extend existing candidate-resolution coverage with confirm/dismiss, one-field-only application, and stale-source rejection. |
| A6/U6 acceptance | Reuse the above composed workflows; no additional 100-turn benchmark or parallel acceptance harness. |

Required integrity, isolation, real-PostgreSQL, and rendered-browser evidence remains in place. Minimizing newly authored tests does not mean calling skipped checks passed or removing checks required by repository instructions.

## Global constraints

- Preserve owner/campaign/world-version boundaries, the server-resolved initial owner, immutable world versions, and append-only accepted turns. Browser IDs and imported ownership are not authorization.
- Keep protagonist edits on `/character-profile` with its existing revision/audit contract. Supporting-character edits remain on `/cast`. Unified presentation does not merge these stores or make protagonist switching implicit.
- Model output is a proposal until application validation accepts it. Creative generation and evidence extraction remain separate operations. Manual overrides take precedence, including intentionally blank values.
- No automatic world-draft edits, publication, historical scans, relationship inference, or adoption of imported prompt instructions.
- Story acceptance must survive optional tracking failures. Rejected narration never becomes cast evidence. No provider calls inside database transactions.
- Mechanics, private reasoning, raw provider output, and credentials remain outside character fiction, public explanations, and image prompts.
- `client-core` is pure; timers, HTTP, and cancellation belong in `client-web`; rendered DOM belongs in `apps/**`. Follow ADR 0028; do not put a shared DOM renderer in `client-web`.
- Preserve both `/story` and `/app/story`; no route redirects or migration of the reference-only root `index.html`.
- Existing cast gates remain default-off. New matching defaults off. A deployment and paid-provider validation are separate operator actions.
- Read the repository overview, identity guidance, scene-context review note, deployment runbook, and testing matrix before the corresponding implementation tasks. Review associated tests for every changed source file.

## Review focus

1. A user edits character A while refresh completes for campaign B: no cross-campaign display/save or lost draft. Interface U2/U3.
2. Two people share a name, or the model declines a plausible match: preserve uncertainty; no forced join. Automation A1/A3.
3. A wrong automatic match is undone after cheap mention tracking: no detached appearance remains in recency, profile, or context. Automation A2/A4/A5.
4. A source is corrected, rewound, branched, transferred, or exported: stale evidence stays invalid and identifiers are remapped consistently. Automation A2/A3/A5/A6.
5. Tracking is disabled, behind, or unavailable while the cast is readable: communicate separate capabilities; story generation and manual drafts remain usable. Interface U2/U4/U6.

## Scope and completion criteria

The first complete revamp includes:

- Searchable cast workspace on both Story surfaces, with a readable sheet and normal field editing for protagonists and supporting characters.
- Main character, Recent, Pinned, Needs review, and Ignored filters over the full server-side result set, not just the loaded page.
- Source-linked facts, claims, manual corrections, unknowns, conflicts, and automatic attachments; an explicit correction/undo path.
- Quiet progress refresh that preserves selection, scroll, focus, and drafts; accessible history-scan controls.
- Graduated auto-match policy, durable detach, provider-free lexical mentions, and an identity/details review inbox.
- Explanations of selected or omitted cast context using the same selector and budget policy as generation.
- Verification on both UI surfaces and PostgreSQL, with archival/lifecycle and optional-failure coverage.

**Deliberately later:** relationship graphs and automatic relationship extraction; NPC portrait generation and multi-character illustration references; SillyTavern card import/export; a global reusable character library; implicit protagonist switching; narrator-side cast tagging; batch matching and learned aliases. These expand contracts or authority and are not required to deliver the unified interface and improved automation. Existing protagonist illustration behavior remains intact. The final section gives bounded follow-up briefs.

World character creation remains the existing reviewed authoring workspace. U1 supplies reusable field definitions for it, and U3 removes raw JSON from campaign editors. This release does not redesign the entire World Library or relax campaign-readiness requirements.

## Plan organization and dependencies

| Track | Implementation plan | Deliverables |
| --- | --- | --- |
| Interface | [Unified Characters interface](2026-11-06-characters-interface.md) | U1–U6: models, refresh, renderers, review, context explanation, acceptance |
| Automation | [Character automation](2026-11-06-characters-automation.md) | A1–A6: policy, durable undo, publication, mentions, detail decisions, rollout evidence |

Recommended sequence:

1. U1 → U2 → U3: usable read/edit workspace on existing behavior.
2. A1 → A2 → A3 → A4: matching and mention tracking with tested undo, still disabled.
3. A5 → U4: complete identity/details inbox and automatic-match correction UI.
4. U5: context explanations using current authority.
5. A6 + U6: composed acceptance, documentation, and release-readiness report.

U1–U3 can ship before automatic matching. A3 may be implemented before the new workspace, but enabling the new policy requires U4's working undo flow. Do not enable a backend-only matching release that leaves users unable to correct it.

## How this incorporates the October plan

The October document remains historical design/input, not a second checklist to execute independently. For this revamp, this plan and its children govern conflicts.

| October task | New owner | Treatment |
| --- | --- | --- |
| 1: decision record | A1/A2 | Preserve graduated policy; document authority, portability, and lexical-mention distinctions. |
| 2: matching policy | A1 | Reuse `strict`, `unique_name`, and identity-basis vocabulary; retain all ambiguity/evidence guards. |
| 3: prompt v2/v1 trust | A1/A3 | Freeze both prompt and identity policy with each admitted job; old jobs stay strict. |
| 4: detach command | A2 | Preserve append-only undo; make the undo descriptor durable authority rather than depending on disposable candidates. |
| 5: publication/migration | A3 | Make publication atomic/idempotent. `0116` is occupied; allocate the next migration after inspecting the execution checkout. |
| 6: detach API | A2/A3 | Provide event-addressed undo, with a candidate-addressed compatibility adapter where a candidate still exists. |
| 7: deterministic mentions | A4 | Distinguish textual mention from confirmed appearance/presence; handle undo overlap and source correction. |
| 8: flag plumbing | A3/A6 | Keep default-off and dependencies; no flag change can reinterpret a frozen result. |
| 9: legacy UI | U3/U4 | Replace with equivalent controls in both clients using shared workflow policy. |
| 10: verification | A6/U6 | Add both-client browser evidence and v1/v2 portability tests. |
| Deferred Step 2 | A5/U4 partly | Bring single-item withheld-detail resolution into scope. Batch operations and remembered aliases remain deferred. |
| Deferred Step 3 | Follow-up only | Keep narrator-side tagging deferred pending a separate ADR and quality/cost evaluation. |

Additional corrections: do not copy stale line numbers or an unrelated model's co-author trailer into new commits. Use short domain-specific commit subjects and actual attribution. Do not retain archive version 1 while introducing command shapes its readers cannot interpret; A2 introduces a v2 cast payload with a v1 reader.

## Release gates

| Gate | Required evidence |
| --- | --- |
| Interface usable | Desktop 1440px and mobile 390px screenshots for both Story surfaces; keyboard/focus/200% zoom, empty/large roster, offline/retry, dirty draft, generation lock, and campaign switch tests. |
| Identity safe | Strict-mode parity; declined, ambiguous, hidden/ignored collisions, quoted/hypothetical and same-name fixtures; no cross-owner/campaign/world match. |
| Undo durable | Detach survives refresh, branch, transfer, Campaign/System Archive round trip, and candidate cleanup; rewind before detach restores only retained authority. |
| Optional work isolated | Provider failure, duplicate job, checkpoint reclaim, disabled discovery, stale publication, and mention-hook failure cannot duplicate or reject a story turn. |
| Explainable context | Preview matches the shared selection on the same captured inputs; omissions, budget, freshness, and disabled reasons are accurate. No private prompt or mechanics leakage. |
| Rollout ready | Compatible readers deployed before writers; all gates disabled initially; retained data and frozen jobs remain readable on rollback. |

Reuse existing focused suites within each task. Run the following final checks once for the integrated release candidate, sharing results between A6 and U6: `pnpm check`, `pnpm test:unit --exclude '**/.worktrees/**' --exclude '**/.codex/**'`, `pnpm test:integration`, `pnpm build`, the named Playwright suites, and `git diff --check`. Focused PostgreSQL runs must use `--config vitest.integration.config.ts`; skipped database cases are not passes.

Record passed, failed, and skipped results separately in `docs/review/campaign-cast/revamp-acceptance.md`. Unit/deterministic-provider results do not establish live narrative quality. No production flag or deployment is changed by completing this plan.

## Follow-up briefs after the core release

- **Relationships:** campaign-scoped directed edges with source evidence, effective turn, fact/claim distinction, manual correction, and lifecycle/archive support. Start with reviewed proposals; never infer affection or allegiance as established fact. Requires a new decision and executable plan.
- **Supporting-character illustrations:** snapshot bounded fiction-only appearance references for explicitly depicted people, using the independent image endpoint. Test wrong-person exclusion, reference stability, retries, disabled images, and successful narration despite image failure.
- **Card interoperability:** explicit world-draft import preview; map identity/personality/appearance/voice fields, show unsupported fields, preserve provenance, and quarantine prompt overrides/scripts/remote asset URLs. Never write directly into active campaign canon.
- **Batch review and aliases:** evaluate real remaining review burden first. An alias is an explicit identity edit; generic titles must not silently become globally unique names. Any batch endpoint must specify transaction and partial-result semantics before implementation.
- **Narrator tagging:** only after an ADR, output-contract revision, and quality/cost comparison; preserve the independent discovery fallback and accepted-output validation.

## Planning verification

This plan is based on source inspection and the earlier review, not a deployed-state audit. Implementation scenarios listed here are future coverage requirements, satisfied by existing evidence where it already exercises the changed behavior; they are not a quota of new tests. The planning change must pass local-link checks, scoped document review, and whitespace/diff checks; application tests need not be rerun for these documents alone.
