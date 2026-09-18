# Generation format and recovery correction plan

**Status:** Planning only; no product changes, production retries, deployment, or database edits authorized by this document.

**Goal:** Avoid rejecting unambiguous provider formatting variations, explain remaining validation failures, and make recovery use the correct explicit review decision.

## Incident evidence and scope

The September 17 investigation correlated Docker logs, PostgreSQL attempts, public API responses, and the open legacy Story page:

- Mindy Doll turn 38, job `5b43e5b3-48eb-4e68-a394-97740e91163e`, stopped at structure review because `superseded_facts` and `canonical_fact_updates` were missing. Provider finish reason was `stop`; output was not limited.
- Taylor turn 136, job `3ffc633c-5d8b-4756-bb9f-a4157fbdc817`, stopped because five `canonical_facts` entries were objects instead of strings. Their exact object shape was not established by the bounded diagnostic query. Do not assume they are safe to convert.
- The ordinary `/generation-jobs/:id/retry` endpoint rejected pending reviews with a reasonless conflict. The API returned “Generation command could not be completed.”
- The open `/story` page showed context-omission advice and an ordinary retry button while the job API exposed a pending structure review with `canRetry: true`.
- Stale browser code is a hypothesis, not a confirmed root cause. Current source already contains review-aware handling in both Story clients. Reproduce missing/delayed review metadata and an old-client request before changing that handling.
- Mindy's job was subsequently discarded during the investigation. A later detail response with `canRetry: false` coincided with this status change; it is not evidence of a summary/detail eligibility defect.

Use only synthetic fixtures. Incident IDs are references for this plan, not permission to retry, restore, or modify those jobs.

## Independent patch sequence

1. [Patch 1 — Review retry recovery](2026-09-18-generation-format-recovery-01-retry.md). Restore actionable recovery first. No parser or prompt changes.
2. [Patch 2 — Safe validation explanations](2026-09-18-generation-format-recovery-02-diagnostics.md). Show field-level reasons without exposing provider content. Independently implementable; verify together with patch 1.
3. [Patch 3 — Conservative normalization and prompt alignment](2026-09-18-generation-format-recovery-03-normalization.md). Prevent narrowly defined harmless format failures. Keep this separately reviewable because it changes accepted provider input.

Implement and review one patch at a time. Each patch must be useful independently and have its own commit. Patches 1 and 2 do not depend on parser relaxation. Patch 3 does not require a new recovery loop.

## Design decisions

- Preserve explicit review consent. The existing [generation rejection plan](2026-09-16-generation-rejection-review.md) forbids automatic retries while a review is pending. The earlier conversational suggestion of an automatic repair call is superseded by this repository-grounded decision. One explicit review retry continues to authorize the existing bounded stage retry.
- Normalize only provider input before strict domain validation. Do not make database, API, import, or accepted-turn schemas broadly permissive.
- Omitted top-level delta arrays may mean no updates; omitted full replacements must remain invalid. Never copy historical facts or threads into a current provider response to make it pass.
- Do not infer supersession, drop object metadata, alter narration, bypass mechanics checks, or bypass current-turn authority validation.
- Keep raw attempts and private review evidence private. Public explanations use finite field names and fixed messages, not raw validation/provider strings.
- Existing accepted turns remain immutable. Existing jobs retain frozen prompt/policy identity; do not relabel a saved request as a newer protocol.
- No changes to model selection, temperature, context limits, retrieval ranking, image jobs, concurrency, schema migrations, or production data.

## Execution and release gates

Read repository `AGENTS.md`, [testing requirements](../../workflows/testing.md), root `CONTEXT.md`, and [deployment runbook](../../runbooks/deployment.md) before implementation or rollout. Use an isolated worktree for implementation and preserve unrelated changes. Read the current architecture and relevant context ADRs before changing their behavior.

For every patch: capture a failing regression, make the minimal implementation, run focused tests, inspect the full diff, and run `git diff --check`. Use the package manager pinned in `package.json` through `corepack pnpm`; do not substitute a mismatched global pnpm.

Before release of the combined change:

```powershell
corepack pnpm test:unit
corepack pnpm test:integration
corepack pnpm check
corepack pnpm build
corepack pnpm exec playwright test tests/e2e/generation-review.e2e.test.ts tests/e2e/generation-integrity-diagnostics.e2e.test.ts
git diff --check
```

The integration runner uses an isolated test database. Never point fixtures at production. Real PostgreSQL must prove no accepted-turn/state/Chronicle writes for rejected output, exactly-once acceptance after authorized retry, lease recovery, and owner/campaign isolation. Browser gates cover `/story` and `/app/story`, desktop and 390x844, with screenshots under `docs/review/assets/generation-format-recovery/`.

Record each check as passed, failed, or skipped with its reason. Mock-provider checks do not establish live-model quality. A separate authorized rollout may test a copied campaign with the actual provider; do not replay private production content as part of implementation tests. Deployment and rollback must preserve frozen jobs and stop incompatible work rather than silently accepting it.

## Completion criteria

- Missing supported no-op arrays do not require another provider call.
- Only the documented lossless fact wrapper is accepted; ambiguous objects still require review.
- A remaining structure failure identifies the affected field and expected shape.
- Pending reviews never invoke ordinary retry from updated clients; old ordinary retry receives actionable guidance and makes no mutation.
- Retrying a review is explicit, revision-bound, owner-scoped, and bounded; Keep stays unavailable for structurally invalid output.
- No claim that every generation can succeed: incomplete, ambiguous, contaminated, or unauthorized output must still stop safely.
