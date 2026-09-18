# Phase 04: Explicit durable fact-format repair implementation plan

> **For agentic workers:** Use `superpowers:subagent-driven-development` when delegated. Complete each task's tests before the next. Treat this as the highest-risk patch and require independent specification and durability reviews.

**Goal:** Let the user apply a proven fact-format repair without replacing narration or issuing another primary-generation request.

**Architecture:** Add a versioned review capability backed by a frozen phase-03 plan, explicit decision receipt, and idempotent worker application. Re-enter normal validation, continuity review, and transactional commit. Existing Retry retains its original full-replacement meaning.

**Tech Stack:** TypeScript, Zod, PostgreSQL, Fastify, legacy JS and replacement TS Story clients, Vitest, Playwright.

**Spec:** [Index](2026-09-18-turn-validation-success.md), [pure planner contract](2026-09-18-turn-validation-success-03-repair-policy.md). Dependencies: phases 02 and 03. No migration should be necessary if the existing JSON checkpoint can carry a versioned addition; read the deployment runbook if a relational change proves necessary.

## Ownership map

- Contracts: `packages/contracts/src/generation-review.ts`, exports in the contracts package, and `packages/application/src/generation/review-checkpoint.ts` / `review-policy.ts`.
- Decisions/persistence: `packages/application/src/generation/ports.ts`, `types.ts`, `use-cases.ts`, `packages/database/src/generation-repository.ts`, `generation-execution-repository.ts`, and `generation-review-summary-projection.ts`.
- Runtime: `services/runtime/src/generation-executor-adapter.ts`, `generation-review-adapter.ts`; create `services/runtime/src/fact-format-repair-adapter.ts` to keep this logic out of the large executor.
- Safe API: `services/api/src/generation-review-projection.ts`, `generation-application-adapter.ts`, and route wiring only where types require it.
- UI: `packages/client-core/src/generation/workflow.ts`, its projections/types, `apps/web/src/story.js`, `apps/web-next/src/story-player-page.ts`, `apps/web-next/src/story-player-view.ts` and the existing client-web decision transport.
- Tests: extend existing generation-review unit suites; create `tests/integration/fact-format-repair.integration.test.ts` and extend `tests/e2e/generation-review.e2e.test.ts`. Reuse Story Direction and review integration harnesses.

## Task 1: Versioned offer and decision

Keep v1 decoding for existing checkpoints, summaries, and requests. Add a v2 review branch for offers with repair capability; unknown future versions continue to project an inert version marker. Do not silently reinterpret a v1 Retry receipt as format repair.

**New decision variant** (the current strict `{reviewId,revision,decision:"keep"|"retry"}` branch remains unchanged):

```ts
type RepairFormatDecision = Readonly<{
  reviewId: string;
  revision: number;
  decision: "repair_format";
  repairPlanHash: string;
}>;
```

**V2 public offer additions:** `canRepairFormat: boolean` and nullable `formatRepair: { planHash: string; changedFactCount: number; description: string }`. Only static description text is allowed. Use “Repair fact formatting and keep the narration unchanged.” No fact content, raw IDs, private state, or provider output is exposed by this capability.

**Private checkpoint addition:** `factFormatRepair` with the frozen phase-03 plan, `planHash`, `sourceResponseId`, `producingRequestHash`, `ownerUserId`, `campaignId`, `worldVersionId`, `baseIdentity`, `providerConfigurationHash`, `promptProtocolVersion`, `status: "offered"|"authorized"|"applied"|"failed"`, and nullable failure code. Bind all values using canonical hashing. The decision journal records the exact plan hash and source response identity as well as existing review/revision bindings.

- [ ] Add contract RED tests for valid v1 decisions, valid v2 repair decisions, missing/wrong plan hash, extra fields, future version, and mixed-version checkpoint history.
- [ ] Implement discriminated schemas and normalize internally only after decoding the actual version. Never cast v2 objects to v1 to bypass validation. Update each package export/caller with compile-time evidence.
- [ ] Add a DB transaction test: two clients submit the same repair decision concurrently. Exactly one receipt/state transition is created; stale/wrong-owner/wrong-plan submissions do not queue or modify anything.
- [ ] Existing Retry still records a replacement decision; Keep remains false for an invalid original candidate. If both repair and Retry are offered, their buttons and receipts must remain distinct.
- [ ] Verify old clients receiving a v2 offer take the existing unknown-version/refresh path and do not fall back to ordinary retry. New clients handle historical v1 offers unchanged.

## Task 2: Bind and apply without another generation

**New adapter contract:** `applyAuthorizedFactFormatRepair` consumes the current job, private v2 checkpoint, exact original response/request evidence, and validated repair receipt; returns a validated story/provenance checkpoint or a typed integrity failure. Use the repository's actual job types, not new look-alike scope interfaces.

- [ ] At the structure-review preparation point, reconstruct visible fact content and IDs from the exact producing request. Use the recorded fact manifest/request, not a newly retrieved context or the whole database. If content inventory or request binding cannot be proven, do not offer repair.
- [ ] Run phase-03 eligibility and mode-specific choice validation. Freeze the plan as part of the offer. Preparing the offer does not mutate accepted state or call a provider.
- [ ] On a `repair_format` receipt, validate review revision, source hash, plan hash, original request, provider/protocol, owner/campaign/world, and base identity before applying. Recompute the plan from original evidence and compare hashes; do not trust a browser-submitted story.
- [ ] Persist the applied repair checkpoint before continuing. Keep original primary result/raw attempt and receipt permanently available. Record this as a deterministic repair event, not a fabricated provider attempt or token charge.
- [ ] Feed the repaired story into ordinary strict parsing, mechanics validation, Story Direction choice checks, frozen continuity policy, and commit. Preserve the original producing request's `sentFactIds`; moved updates must pass the existing active/in-scope supersession transaction.
- [ ] Bind downstream continuity review to both original producing-request evidence and transformed story hash. Store the transformation provenance; do not claim the provider returned the transformed JSON. Update resume compatibility checks to recognize this checkpoint explicitly.
- [ ] Failure of semantic review after repair creates the normal next review offer. It does not automatically waive findings or trigger a primary rewrite. A failed integrity check leaves original evidence intact and offers only actions valid under current authority.

Required composed regression sequence:

```text
primary provider returns complete narration plus supported malformed facts
worker pauses -> no accepted writes; primary call count = 1
user sends repair_format with matching review/revision/plan hash
worker applies deterministic repair -> primary call count remains 1
configured semantic review runs normally (count it separately)
commit -> one turn, correct state/facts, unchanged narration
repeat decision and resume worker -> no additional turn or provider request
```

- [ ] Capture RED for that sequence in the real-PostgreSQL harness, implement the minimal runtime branch, and capture GREEN.
- [ ] Add crash/reclaim boundaries: before decision, after receipt, after repair checkpoint, after semantic-review checkpoint, before commit, and after commit acknowledgment loss. Assert no lost original, duplicate deterministic event, repeated semantic call beyond existing durable allowances, or second accepted turn.
- [ ] Add stale campaign, world mismatch, tampered raw response, altered plan, foreign owner, unseen/inactive supersession, current narration correction, and changed provider fingerprint tests. Each must reject before canonical mutation.
- [ ] Cover Story Direction and Action, append and replace-latest; preserved main narration plus existing extension checkpoints must either bind exactly or stop as incompatible. Do not graft the repaired main story onto an unrelated extension.
- [ ] Verify optional illustration failure does not fail story acceptance; repaired metadata must not independently dispatch duplicate illustrations.

## Task 3: Both Story clients and safe disclosure

- [ ] Add unit RED tests for a repairable v2 review displaying “Repair fact formatting”, existing Retry displaying replacement guidance, no Keep on malformed output, and disabled pending actions.
- [ ] Render the new action through shared workflow state and existing review decision transport. Fetch current detail before action, submit exactly one matching receipt, and refresh on conflict without automatically resubmitting.
- [ ] Preserve the displayed narration through repair. If existing policy hides malformed candidates, retain that policy; do not expose raw metadata simply to supply a preview.
- [ ] Browser-test both `/story` and `/app/story`, desktop and 390×844: repair success, stale revision, network uncertainty/reload, unsupported version, ineligible `{}`, full Retry, and review after repaired-candidate continuity rejection. Capture screenshots with synthetic fiction.

## Task 4: Remove misleading unreachable recovery code

- [ ] Add route-level regression assertions proving pending structure review makes zero automatic schema-repair calls and historical valid checkpoint resumes remain supported.
- [ ] Trace references to `automaticRepair`, `schema_repair`, and `mechanics_cleanup` before deleting anything. Remove only the provably unreachable current-dispatch branch. Preserve historical decoding, audit records, and any reachable recovery path.
- [ ] Do not delete fixtures merely because their data is old; update the expected route or retain them as compatibility tests. Document historical automatic repairs versus current explicit repairs in the runbook.
- [ ] Run focused review/repair suites, full type checks, and diff review. Commit related contract, runtime, and UI steps separately if needed, but release them together as this one capability patch.

## Exit gate

Real PostgreSQL proves exactly-once acceptance and no rejected writes. Browsers prove truthful action semantics on both active surfaces. A fresh reviewer checks every transition and every source/request/plan hash. No existing v1 receipt changes meaning; no full-story provider call occurs for successful format repair. This patch is incomplete if only pure planner tests pass.
