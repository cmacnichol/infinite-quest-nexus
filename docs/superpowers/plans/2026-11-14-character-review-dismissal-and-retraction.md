# Character Review Dismissal and Retraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users dismiss unwanted discoveries/details, retract incorrect recorded facts, and find existing cast removal without losing history or safeguards.

**Architecture:** Stage A adds operational, source-scoped dismissal/restore decisions and shared review UI. Stage B adds authoritative observation correction commands, integrates replay and portability, then exposes fact correction in character evidence history. Reuse existing campaign locks, boundaries, controllers and typed reference translation.

**Tech Stack:** TypeScript, Zod, PostgreSQL, existing DOM clients, Vitest and Playwright Chromium. No new dependency or provider call.

**Spec:** [Character review dismissal and fact retraction](../specs/2026-11-14-character-review-dismissal-and-retraction-design.md).

Status: proposed plan; not implemented. Existing editor work is committed as `8eeecef3`. Complete Stage A before Stage B; each is independently releasable after its verification gate. No deployment or capability activation is authorized by this plan.

## Global Constraints

- Preserve server-resolved identity, campaign/world isolation, generation locks, idempotency, revision and source fences.
- No provider call, prompt-protocol change, world mutation, accepted-turn rewrite or capability activation.
- Do not physically delete observations, source narration, turns, identities or receipts.
- Dismiss is not a global ban on a name or alias. New evidence at another turn or a corrected source can appear again.
- Original proposal indexes and hashes remain stable; never address a detail by its filtered display index.
- Operational dismissal records are excluded from portable archives and branches, consistent with current inbox policy; imported or branched history may be reviewed again.
- Fact retractions are authoritative campaign edits and must survive supported archive, branch and transfer workflows.
- Preserve all explicit supersession edges: retracting a superseding fact does not silently unsupersede its predecessor.
- Both UI clients share review rendering; verify both. Keep existing Story/Nexus presentation boundaries.

## Review Focus

1. A rescan recreates a candidate with a different UUID: semantic source decisions still suppress only the same proposal (Task 2).
2. A stale tab restores a dismissal after another tab accepted the detail: no silent reversal or duplicate acceptance (Tasks 2–3).
3. Filtered observation indexes change after a dismissal: attach/create never applies the dismissed original detail (Tasks 2–3).
4. An observation moves through merge/unmerge or an archive ID remap: correction targets the original fact, not the wrong character (Tasks 5–6).
5. Removing one fact exposes an older value/conflict beneath an override: preview and every context consumer agree with the committed projection (Tasks 5, 7).

## File boundaries and implementation interfaces

New focused modules:

- `packages/domain/src/campaign-cast-review-decisions.ts`: pure identity/detail fingerprinting and decision folding; no SQL or UI.
- `packages/contracts/src/campaign-cast-review-decisions.ts`: new pending-review write/list schemas and types; export through the package's existing barrel.
- `packages/database/src/campaign-cast-review-decision-repository.ts`: scoped operational journal writes/listing and legacy-dismissal compatibility.
- `packages/domain/src/campaign-cast-observation-decisions.ts`: pure active retraction folding and eligible-contribution selection.
- `packages/contracts/src/campaign-cast-observation-decisions.ts`: public preview/apply payloads and results.
- `packages/database/src/campaign-cast-observation-decision-repository.ts`: transactional preview/apply around existing journal machinery.

Use `ReviewDecisionRequest`, `ReviewDecisionResult`, `DismissedReviewPage`, `ObservationDecisionRequest`, `ObservationDecisionPreview`, and `ObservationDecisionResult` as Zod-inferred exported types. Reuse `CastScope`, `CastBoundary`, `CastObservation` and existing write bases. New request actions and field names are exactly those in the spec. A candidate's `reviewRevision` is a monotonically increasing operational revision guarded under the campaign lock, not a fabricated character revision; same-source decisions on duplicate candidates must invalidate the corresponding review token. Use a campaign-scoped review sequence for this token so duplicate candidates and counts cannot disagree.

Repository methods:

```ts
reviewDecision(scope: CastScope, candidateId: string, request: ReviewDecisionRequest): Promise<ReviewDecisionResult>
dismissedReview(scope: CastScope, query: { cursor?: string; limit?: number }): Promise<DismissedReviewPage>
previewObservationDecision(scope: CastScope, characterId: string, observationId: string, request: ObservationDecisionRequest): Promise<ObservationDecisionPreview>
applyObservationDecision(scope: CastScope, characterId: string, observationId: string, request: ObservationDecisionRequest): Promise<ObservationDecisionResult>
```

Client `CampaignCastApi` exposes the same methods without the scope argument, using campaignId instead; adapters provide the server-resolved scope. Preview does not persist or consume the idempotency key. Add public capability fields for review decisions and observation decisions so a new browser on an old API hides unsupported controls without probing writes; effective permission is derived from editing and reader support, not a new operator flag.

---

## Stage A — Dismiss discoveries and pending details

### Task 1: Decision contracts, fingerprint policy and schema

**Files:** Create the three pending-review modules above and `tests/unit/campaign-cast-review-decisions.test.ts`; modify `packages/contracts/src/campaign-cast-discovery.ts`; add the next migration (currently `database/migrations/0134_cast_review_decisions.sql`) and the next architecture ADR, following `docs/agents/domain.md`. Read identity/ownership and deployment guidance first.

**Interfaces:** Produces pending-review types plus `reviewTargetFingerprint(source: CastDiscoverySource, target: ReviewTarget): string`; `ReviewTarget` is exported as `{ kind: "identity"; proposal: CastDiscoveryCandidate } | { kind: "detail"; observation: CastDiscoveryCandidate["observations"][number] }`, using the existing inferred candidate type from the discovery contract (export its schema-inferred alias if absent). Repository interface from the block above is implemented in Task 2.

- [ ] Write failing schema/fingerprint tests: rejects unknown fields and bad indexes; same source/payload with different candidate/job UUID yields equal fingerprint; changed source/value/speaker differs; equivalent alias ordering is stable; meaningful whitespace in values stays distinct.
- [ ] Run `node node_modules/vitest/vitest.mjs run tests/unit/campaign-cast-review-decisions.test.ts` and confirm intended failures.
- [ ] Implement strict request/result schemas, campaign review sequence, scoped append-only decision table, unique idempotency constraint, indexes and typed fingerprint helper. Include old detail-dismissal compatibility policy in the ADR; do not migrate accepted/confirmed decisions into new meaning.
- [ ] Add migration integration assertions for scoped FKs, duplicate keys, fresh baseline and upgrade from baseline; execute using `vitest.integration.config.ts`. Confirm PASS and safe rollback refusal with retained data.
- [ ] Run unit/type checks, review the task diff and commit `Add source-scoped cast review decision contracts`.

### Task 2: Transactional dismissal, Undo and resolution fencing

**Files:** New decision repository; modify `packages/database/src/campaign-cast-candidate-repository.ts`, `campaign-cast-review-sql.ts`, `campaign-cast-current-review.ts`, `campaign-cast-repository.ts` (review counts/reconciliation), and `campaign-cast-discovery-publication.ts`; add `tests/integration/campaign-cast-review-decisions.integration.test.ts`.

**Interfaces:** Implements `reviewDecision` and `dismissedReview`; adds shared active-decision lookup to candidate/list/count/resolve paths. Existing resolveDetail dismiss result remains backward compatible.

- [ ] Add failing PostgreSQL cases `dismiss_identity_without_creating_cast`, `dismiss_original_detail_before_attach_and_world_seed`, `same_source_rescan_keeps_dismissal`, `restore_preserves_other_decisions`, and `changed_source_is_reviewable_again`.
- [ ] Add races/isolation assertions: two tabs compete with the same review revision; replay identical key returns one receipt; changed-key payload conflicts; other-owner/campaign IDs fail; generation/capability/boundary/source locks block all new writes. Count/list pagination agree after suppression and restore.
- [ ] Run the new file with `node node_modules/vitest/vitest.mjs run --config vitest.integration.config.ts tests/integration/campaign-cast-review-decisions.integration.test.ts`; confirm failures before implementation.
- [ ] Implement one transaction/lock order for journal decisions and candidate attach/create. Exclude dismissed original observations before all evidence-command construction, including world seeding; preserve stored proposal and original pending indexes. Consult both legacy and new active dismissals. Reconcile unchanged sources through timeline movement; invalidate changed/discarded evidence without resurrecting stale decisions.
- [ ] Implement restore checks: only active eligible dismissals, current source and review token; no restoring a now-accepted detail into pending review. Keep independent child dismissals when restoring identity. Read-only Dismissed view remains available when editing is disabled.
- [ ] Run new suite plus `campaign-cast-discovery.integration.test.ts`, `campaign-cast-backfill.integration.test.ts`, and existing API suites under the integration config. Confirm PASS, review and commit `Persist cast discovery dismissal and recovery`.

### Task 3: Public endpoints, shared review controls and removal explanation

**Files:** Modify `packages/application/src/campaign-cast/{ports,use-cases,types}.ts`, `services/api/src/campaign-cast-routes.ts`, `services/runtime/src/campaign-cast-composition.ts`, `packages/client-web/src/campaign-cast-api.ts`, `packages/client-web/src/cast-review-queue.ts`, `apps/web/src/cast-review-queue.ts`, `apps/web/src/campaign-cast-panel.ts`, and `apps/web-next/src/characters-workspace.ts`. Extend `tests/unit/campaign-cast-api.test.ts`, `tests/unit/cast-review-queue.test.ts`, `tests/integration/campaign-cast-api.integration.test.ts`, and `tests/e2e/campaign-cast.e2e.test.ts`.

**Interfaces:** Wires Task 2 methods to the exact spec routes. Add capability/read-version fields without changing existing successful attach/create/detail response requirements.

- [ ] Write failing API and browser cases for unresolved identity dismissal; original-index detail dismissal followed by create; reload → Dismissed → Undo; pending vs dismissed counts; duplicate clicks; stale source Reload behavior; old API capability absence. Assert zero provider calls and no cast write for Skip for now.
- [ ] Add keyboard/focus cases for Undo and the final empty card; safe HTML-as-text quote; disabled editing/generation states; lifecycle-off Remove explanation; lifecycle-on existing Remove/Restore path. Assert protagonist/merged restrictions unchanged.
- [ ] Run the targeted unit/API/browser tests and record intended failures.
- [ ] Implement indexed unresolved detail rows and separate Dismiss discovery / Dismiss detail controls. Keep Attach/Create explicit. Add Pending/Dismissed selection, receipt-targeted Undo, busy guards and source-specific explanations; announce confirmed changes only. Change Skip wording to Skip for now with temporary help text.
- [ ] Implement capability-aware removal explanation and retain the existing lifecycle dialog/controller. Do not add removal to unresolved candidates or auto-activate settings.
- [ ] Run affected suites for both clients, capture desktop/390px and native-zoom screenshots, review and commit `Add recoverable character review dismissal controls`.

### Task 4: Stage A acceptance and documentation

**Files:** Update `docs/player-guide/characters-and-stats.md`, `docs/runbooks/campaign-cast.md`, `docs/workflows/testing.md`; create `docs/review/character-review-dismissal-and-retraction-acceptance.md`.

- [ ] Extend the existing opt-in composed proof in `tests/integration/world-library.integration.test.ts`: source-backed pending discovery → detail dismissal → identity attach/create → reload → same-source rescan → dismissed view/restore, with actual database receipts, unchanged other campaign/world and no unintended fact. Do not build a second application harness.
- [ ] Run `pnpm check`, `pnpm check:client-boundaries`, both web builds, new/affected unit and PostgreSQL suites, and affected browser suites. Record commands and passed/failed/skipped counts; distinguish fixture browser evidence from real database persistence.
- [ ] Document dismissal scope, Undo, branch/archive exclusion, corrected-source reappearance and disabled removal controls. Verify relative links and `git diff --check`.
- [ ] Review D1–D3/D6/D7 evidence and commit `Document verified character review dismissal`. Stage A may release independently; deployment remains separate.

## Stage B — Retract and restore recorded facts

### Task 5: Correction commands and consistent profile projection

**Files:** Create observation-decision contracts/domain/repository modules above; modify `packages/contracts/src/campaign-cast.ts`, `packages/domain/src/campaign-cast.ts`, `packages/database/src/campaign-cast-repository.ts`, `packages/database/src/campaign-cast-discovery-publication.ts`, `packages/database/src/campaign-cast-candidate-repository.ts`, and `packages/domain/src/campaign-cast-context.ts`. Add `tests/unit/campaign-cast-observation-decisions.test.ts` and `tests/integration/campaign-cast-observation-decisions.integration.test.ts`; extend projection/context tests.

**Interfaces:** Produces `retract_observation` / `restore_observation` commands and `activeRetractedObservationIds(events): ReadonlySet<string>` from typed retained events. Extend `ProjectCastProfileInput` with optional `retractedObservationIds`; default empty preserves old callers. Validate the full graph, then exclude contributions consistently in normal and seeded projection. Repository methods are those in the interface block.

- [ ] Write failing projection tests for latest dynamic fact exposing older value, static conflict removal/restoration, superseding fact retraction not reviving its predecessor, unchanged override, authored fallback, and no observations left. Assert seeded and ordinary projection/context match.
- [ ] Write failing PostgreSQL tests for preview/apply equality, current revisions, idempotency, generation lock, non-fact/protagonist/removed target rejection, wrong owner/character/source, repeated restore against superseded retraction, and exact-source duplicate publication suppression. Include both worker publication and user-accepted candidate paths.
- [ ] Run new unit/integration files and confirm intended failures.
- [ ] Implement immutable commands, active correction projection, revision advancement, source/current-character validation and compare-before-apply preview. Preserve observations/quotes; do not repurpose source invalidation or overrides. Add any required additive schema support using the next free migration; do not edit 0133.
- [ ] Run projection/context/discovery/repository tests plus new suites, review and commit `Add auditable cast fact retraction and restoration`.

### Task 6: Replay, merge and portable format 5

**Files:** Modify `packages/domain/src/campaign-cast-references.ts`, `packages/contracts/src/campaign-cast.ts`, `packages/database/src/campaign-cast-portability.ts`, `packages/database/src/campaign-cast-repository.ts`, `packages/database/src/campaign-cast-lifecycle.ts`; extend `tests/unit/campaign-cast-references.test.ts` and integration lifecycle, lifecycle-merge, portability and observation-decision suites. Follow ADR 0043; do not duplicate reference translation in adapters.

**Interfaces:** Translate correction character/observation/retraction-event IDs with existing translator maps. Readers accept cast format 1–5; export 5 only for journals with the new commands. Older payloads retain current semantics.

- [ ] Write failing tests for retract → merge → unmerge; merge → retract source observation → unmerge; rewind before correction versus before source; corrected narration after retraction; branch at both boundaries; world transfer and Campaign/System Archive restore; missing/foreign observation/event references; future unknown format rejection.
- [ ] Run reference units and integration suites; confirm failures.
- [ ] Implement typed references, journal validation, requested-boundary replay and format selection. Preserve source observation identity across merges and correction authority across ID remapping. Operational dismissal journals remain excluded.
- [ ] Verify archives 1–4 round-trip unchanged in behavior and older readers reject 5 rather than silently losing corrections. Document compatible-reader rollback floor and coordinated API/worker rollout before enabling new writes.
- [ ] Run all cast portability/lifecycle/replay tests and relevant archive integration coverage, review and commit `Preserve fact corrections through replay and portability`.

### Task 7: Fact correction preview and history UI

**Files:** Extend application ports/use cases, API routes/runtime composition, `packages/client-web/src/campaign-cast-api.ts`, `apps/web/src/campaign-cast-panel.ts`, `apps/web-next/src/characters-workspace.ts`; create `apps/web/src/character-editor/observation-review.ts` for shared safe-text preview/history controls; extend API and browser suites.

**Interfaces:** Wire preview/apply methods and capability fields from Task 5 after Task 6 readers are complete. Shared renderer consumes typed observation status, source and decision results; never calculates authoritative eligibility locally.

- [ ] Write failing browser/API tests for Retract fact confirmation showing before/after, cancel making no write, retracted-history Restore, unchanged override explanation, conflict restoration, stale preview rejection and retry receipt reuse. Distinguish authored fields, claims and mentions from eligible facts; both clients must preserve existing editor behavior.
- [ ] Run focused tests and confirm intended failures.
- [ ] Implement source-linked per-observation actions, confirmation/preview, history visibility, current capability/lock handling and focus recovery. Keep original evidence visible and show when a previously retracted source is no longer eligible for restoration.
- [ ] Run browser at desktop/390px/native 200% zoom, capture screenshots, verify keyboard focus and safe content, review and commit `Expose recorded fact retraction and restore controls`.

### Task 8: Composed acceptance, full verification and operator documentation

**Files:** Extend the existing world-library composed proof; update acceptance report, characters guide, runbooks, testing matrix and proposed design status.

- [ ] Add actual API/PostgreSQL flow: accept fact → confirm effective context → preview/retract → reload → confirm older fallback or absence → restore → archive round-trip, with another-campaign and pinned-world invariance. Verify exact-source rescan cannot reapply an active retraction.
- [ ] Run `node node_modules/vitest/vitest.mjs run tests/unit --exclude '**/.worktrees/**' --exclude '**/.codex/**' --exclude '**/.claude/**'`; run all affected cast integration files with `--config vitest.integration.config.ts`; run shared review/cast/editor/browser suites and the opt-in composed proof using the documented task-owned server.
- [ ] Run `pnpm check`, `pnpm check:client-boundaries`, `pnpm build:web:legacy`, `pnpm build:web:next`, documentation link checks and `git diff --check`. Do not count fixture saves as persistence evidence or emulation as physical keyboard verification.
- [ ] Record D1–D7 acceptance, screenshots, migration/rollback compatibility, unresolved findings and verification skips. Complete independent final review and fixes, then commit `Document verified cast fact correction workflow`.

## Plan self-review and handoff

D1–D3 map to Tasks 1–4; D4 to Tasks 5/7; D5 to Tasks 5/6/8; D6 to Task 3; D7 to Tasks 3/4/7/8. All five review-focus cases have explicit owning tests. Separate operational and authoritative records avoid making inbox cleanup rewrite story history. Stage B is intentionally larger because projection-only retraction would fail replay and portability. Implementation must finish each stage's real database and browser gate before claiming it works.

Recommendation: subagent-driven execution with one implementation task at a time and scoped review gates, because the authority/replay/portability seams merit independent review. This document is a plan, not a request to deploy or begin implementation.
