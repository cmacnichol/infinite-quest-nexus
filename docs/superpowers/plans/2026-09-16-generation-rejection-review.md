# Generation Rejection Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development if the user chooses delegated execution; otherwise execute sequentially with superpowers:test-driven-development and superpowers:verification-before-completion. Steps use checkbox (`- [ ]`) syntax for tracking. This document authorizes no implementation or deployment by itself.

**Goal:** Preserve the first successfully streamed turn content and prevent validation-triggered replacement unless the user explicitly chooses retry; both Story interfaces must explain the finding and offer Keep for an eligible candidate.

**Architecture:** Reuse the existing `recoverable` job status with a versioned private review checkpoint. The worker owns candidate preservation and validation; an owner-scoped decision command resumes the same job. Both interfaces consume one safe public review projection and shared client decision workflow. Acceptance remains an ordinary transactional worker commit with a narrowly scoped, auditable review waiver.

**Tech Stack:** TypeScript, Zod, PostgreSQL, Fastify, client-core/client-web, legacy JavaScript Story Player, web-next, Vitest, Playwright. No new dependencies.

**Spec:** [Behavior and scope](#behavior-and-scope) in this document is the implementation specification, incorporating the user's request and preceding source evaluation.

## Global constraints

- Preserve the original generated candidate before any authorized repair can replace it.
- Checkpoint the completed first provider response before post-generation validators or repairs run; saving only the first draft offered for review is too late.
- Preserve existing generation-stage ordering and successful-turn behavior. This feature adds decision gates; it does not redesign event assembly, enable extra reviews, or change prompt/model settings.
- No automatic retry, rewrite, timeout decision, or acceptance while a review decision is pending.
- A keep decision applies only to the exact candidate, rejection findings, campaign base, and protocol identity the user reviewed.
- Never accept malformed output, mechanics contamination, unauthorized state references, stale campaign authority, or an invalid replacement target through this override.
- Accepted turns, campaign state, Chronicle, and accepted artwork remain unchanged until the normal commit succeeds.
- Retain separate `/story/:campaignId` and `/app/story/:campaignId` interfaces. Do not modify root `index.html`.
- Keep text and image provider concerns separate. Private raw responses and review reasoning never enter browser payloads, story memory, or image prompts.
- Preserve unrelated working-tree changes. No main-checkout integration, publishing, deployment, live campaign mutation, or provider calls are implied by this plan.
- Run a RED/GREEN cycle for every behavior change. Browser mocks, PostgreSQL tests, and live-provider evidence must be reported separately.

## Source baseline and preflight

Plan prepared against HEAD `27cc8ccbfce927850021832d0ea1333b3a97104e` plus the existing working tree. Line numbers will drift; use the named symbols below.

Existing uncommitted changes observed during evaluation:

```text
packages/client-core/src/campaign-projection.ts
packages/client-core/src/generation/types.ts
packages/client-web/src/generation/fallback-source.ts
tests/unit/client-web/generation-fallback-source.test.ts
tests/e2e/generation-snapshot-recovery.e2e.test.ts
```

Before implementation, inspect status and diffs again. Use an isolated worktree under the repository's permitted workspace via the worktree skill. Do not copy, commit, revert, or silently depend on those edits. If they have since merged, use the updated baseline and adapt the shared-client task accordingly.

Read `AGENTS.md`, `docs/agents/domain.md`, relevant context documents if present, `docs/workflows/testing.md`, `docs/runbooks/deployment.md`, and these architecture records:

- `docs/architecture/0003-worker-owned-story-engine.md`: currently specifies automatic recovery; update its recovery decision for this feature.
- `docs/architecture/0017-staged-latest-turn-replacement.md`: keep the accepted replacement target until atomic commit.
- `docs/architecture/story-only-campaign-policy.md`: Story-only skips independent scene coverage and RPG events; do not enable those stages to implement this gate.
- `docs/architecture/repository-overview.md`: two active player routes and shared server authority.

Current implementation seams verified during evaluation:

| Seam | Current behavior / consequence |
| --- | --- |
| `services/runtime/src/generation-executor-adapter.ts`, `createGenerationExecutor` | Contains schema recovery, choice repair, scene rewrite, event coverage repair, and enforced continuity repair. Notification must precede destructive replacement, not merely `markRecoverable` after repair fails. |
| `packages/database/src/generation-execution-repository.ts` | Owns private orchestration persistence and transactional commit; commit independently asserts continuity review and campaign authority. A worker-only bypass is insufficient. |
| `packages/database/src/generation-repository.ts`, `retry` | Resets several repair/review checkpoints. Existing retry cannot be reused blindly for review decisions. |
| `services/api/src/server.ts`, `generationSnapshot`, `generationStreamSnapshot` | Replaces errors with generic public messages and adds allowlisted diagnostics. Introduce a separate safe review projection. |
| `packages/database/src/campaign-state-repository.ts` | Hydrates recovery jobs and computes sync fingerprints. Review decisions must survive hydration and invalidate unchanged sync responses. |
| `packages/client-core/src/generation/machine.ts` | Reconciles statuses/attempts. Decisions may change while a job is still `recoverable`; account for review revisions. |
| `apps/web/src/story.js`, `showGenerationRecovery` | Existing legacy recovery panel and buttons. |
| `apps/web-next/src/story-player-view.ts`, `recovery` | Existing replacement recovery panel and buttons. |

## Behavior and scope

### User experience

A completed browser preview is not proof of a complete structured provider response: narration can finish before choices/state fields, and the browser SSE can disconnect independently of the provider. The primary supported case is a durably captured, complete provider response that passes mandatory output checks but fails a narrative-quality review. A normal passing turn still commits without asking for confirmation. Review mode `off` remains off and `observe` remains non-blocking.

Display a persistent review panel next to the unaccepted draft:

```text
This turn needs your review
The reviewer reported: [safe, specific finding]
Your generated turn has been saved. Choose what happens next.

[Keep this turn] [Continue with retry]
```

For review unavailability, say `The continuity review could not complete. No story conflict was confirmed.` Distinguish reviewer uncertainty from confirmed rejection. Never label an unavailable review a passed review.

For a non-overridable failure, explain the actual category and why Keep is unavailable. Example: `The response ended before a complete turn was received. It cannot be accepted yet.` Show only actions the server declares available. Preserve the existing explicit discard action; closing or navigating away is not discard. Continue with retry means authorize the applicable repair, not necessarily a fresh whole-turn generation. Show a short action detail such as `Retry will repair the choices and preserve the narration.`

Keep is acceptance of the saved candidate's normal structured turn payload, not a client-submitted narration edit. The public preview includes narration and safe choice text, with choices disabled until acceptance. Do not expose scratchpad, raw JSON, prompts, or private findings.

### Eligibility matrix

| Condition | Notify before replacing output? | Keep allowed? | Retry behavior |
| --- | --- | --- | --- |
| Complete, structurally valid main draft; scene-beat finding | Yes, at the existing scene gate | Yes, preserve main and finish normal stages | Existing bounded scene repair |
| Complete final draft; enforced semantic continuity conflict | Yes | Yes, waive that review finding only | Existing bounded semantic repair |
| Complete final draft; enforced review uncertain/unavailable | Yes | Yes, record unverified acceptance | Repeat review; repair only when explicitly authorized by a subsequent decision |
| Valid narration but invalid choices | Yes before choice repair | No until required choices are valid | Choice-only repair; narration unchanged |
| Malformed/truncated output or mechanics contamination | Yes before replacement recovery | No | Existing bounded structural recovery; display only safe preview text |
| Event coverage/accounting failure | Yes before replacement | No in this targeted version | Existing bounded event repair; never claim an unrealized event was fulfilled |
| Transport/context failure without usable candidate | Existing recovery notice with safe specific reason | No | Existing applicable recovery; no fabricated preview |
| Stale authority, bad checkpoint, ownership mismatch, invalid fact reference | Explain blocking failure within owner's authorized scope | No | Existing correction/discard guidance; no broad validation waiver |

The event restriction prevents a narrative override from consuming an event that the saved fiction did not realize. General overrides of event mechanics and canonical state validation are out of scope.

### Stage ordering and exact-candidate rule

Pause at the existing failing stage before dispatching replacement work. Do not move scene coverage after events or run additional validators merely to collect findings into one dialog. Early schema/choice/event failures remain non-overridable. A complete main response may be kept at the existing scene-coverage gate even when ordinary event assembly has not finished; this is a stage-local waiver, not permission to commit an unfinished turn.

Distinguish `candidateScope: "main" | "final"`. At a main-stage gate, Keep means retain that exact main story and continue the existing normal stages. The UI says `Keep this text and finish the turn; normal event content may still be added.` Any normal extension must preserve the kept narration as an exact prefix; it cannot rewrite it. Later event-integrity failures still block acceptance, and a later blocking continuity finding pauses again for that final candidate. A main-stage waiver cannot waive a final-stage finding.

At the final continuity gate, Keep accepts the exact complete final candidate with zero further text-provider calls, including additional reviews, summaries used to construct the candidate, or narrative repairs. Resume only deterministic validation and transactional acceptance using persisted inputs. Optional derived indexing after acceptance retains its existing behavior and is not a turn retry.

If a new mandatory validation fails, retain the candidate and show the blocked reason; never silently regenerate. Do not re-run an approved stage after lease reclaim. A changing draft hash, finding identity, scope, or campaign base invalidates the associated waiver rather than extending its authority.

### Capture and recovery boundary

Await durable storage of the full returned `ProviderResult`, original request identity, and required assembly/commit inputs immediately after the first story call completes, before any reviewer call. Flush the final narration checkpoint even if the 350 ms stream throttle skipped the last chunk. Keep this original separate from mutable `partial_output`, repair output, and the reviewer's response. A private raw record can be saved before parsing; only a parsed, fiction-safe projection is displayable/keepable.

On worker reclaim, a saved complete result resumes validation without another `story_generation` call. A checkpoint write failure must stop downstream replacement and report recovery; it cannot claim the draft is safely saved. If the process died before any complete result was persisted, show preserved partial text with an explicit recovery limitation and require consent before a new generation. Do not invent a complete candidate from a rendered prefix or add a provider-specific remote retrieval project to this change.

Keep does not require the text endpoint to be online. Restore frozen producing/commit metadata without provider discovery, fresh retrieval, prompt assembly, or output-feasibility work for another request. Preserve mandatory campaign/protocol checks; a retry-specific budget or provider failure must not make an otherwise eligible original unkeepable. Do not relax existing structural/output-completeness checks based solely on a `finish_reason`: test both complete parsed output with a length finish and actually incomplete output against the current generation policy.

### Retry preservation

Preserve the completed first response and the candidate offered at the current gate throughout a repair cycle. A retry decision authorizes one declared next repair/review stage, with existing attempt limits and pre-dispatch reservation. Ordinary validation of its result remains automatic; a later destructive repair needs another decision. A successful, fully valid retry can commit normally because the user authorized replacement. If retry fails, re-offer the preserved gate candidate when still eligible, carrying its original findings and a separate retry-failure notice. Do not apply a failed replacement's findings to the original candidate.

Use immutable references to the original response, gate candidate, and working attempt; avoid copying the same large payload into multiple fields. Do not build a general version browser. No post-discard restoration promise is added. Record review/repair consumption per logical attempt, not worker claim: a Keep decision consumes no provider allowance. Set `canRetry=false` with an accurate reason when the declared repair allowance is exhausted; do not offer a retry that can only redisplay the same exhausted error. Resetting allowances for a new attempt must be explicit and must preserve the original candidate.

## Contract and state design

New names below are proposed interfaces, not existing exports.

Create `packages/contracts/src/generation-review.ts` with schemas and inferred types:

```ts
type GenerationReviewStage =
  | "structure" | "choices" | "scene_coverage" | "event_coverage" | "continuity";

type GenerationReviewReasonCode =
  | "scene_beats_missing" | "narrative_conflict" | "review_uncertain"
  | "review_unavailable" | "invalid_choices" | "invalid_structure"
  | "output_incomplete" | "mechanics_contamination" | "event_coverage_failed"
  | "candidate_stale" | "candidate_invalid";

type GenerationReviewDecisionRequest = Readonly<{
  reviewId: string;        // UUID identifying this offered candidate/review
  revision: number;        // positive integer, incremented on every review transition
  decision: "keep" | "retry";
}>;

type GenerationReviewSummary = Readonly<{
  version: 1;
  reviewId: string;
  revision: number;
  state: "pending" | "decided";
  stage: GenerationReviewStage;
  candidateScope: "main" | "final";
  reasons: readonly GenerationReviewReasonCode[];
  canKeep: boolean;
  canRetry: boolean;
}>;

type GenerationReviewDetail = GenerationReviewSummary & Readonly<{
  narration: string | null;
  choices: readonly string[];
  findings: readonly { code: GenerationReviewReasonCode; message: string }[];
  retryDescription: string;
  retryFailure: string | null;
  omittedFindingCount: number;
}>;
```

Use a strict decision schema (`reviewId` UUID, `revision` positive safe integer, decision enum, no extra fields). Decision requests never contain story text, owner identity, eligibility, hashes, or a bypass flag. Limit public findings to 20 entries and 500 characters each; derive bounded messages from allowlisted reason codes and validated fiction-only findings, not arbitrary persisted error strings. Show an omitted-findings count/message when truncated rather than suggesting the list is exhaustive. Preview length follows the existing valid story contract; do not truncate the actual saved candidate for acceptance.

Add optional `review: GenerationReviewSummary` to polling, SSE, and campaign recovery schemas. Add `GET /api/v1/generation-jobs/:jobId/review` returning `GenerationReviewDetail`, and `POST /api/v1/generation-jobs/:jobId/review-decision` returning the existing `GenerationActionResponse`. Fetch the full preview only when needed; do not send a full candidate on every SSE heartbeat.

Create a private `GenerationReviewCheckpoint` schema in `packages/application/src/generation/review-checkpoint.ts`. It holds version 1, the public identity/revision/scope, immutable original and gate candidate references, current working candidate reference, original findings, current gate stage, optional retry failure, and an append-only decision journal. Candidate records contain the complete typed story when available, private raw-output reference for structural recovery, SHA-256 of stable serialized story, producing request/response provenance, sent fact IDs, world/campaign/owner/base identity, frozen policy/protocol/provider identity, and the exact private orchestration dependencies needed to resume. Reuse existing candidate/provenance types; do not duplicate source payloads that an immutable existing checkpoint already stores. Do not create a recursive checkpoint by embedding the enclosing orchestration object inside itself; enumerate the resume dependencies explicitly.

Each journal entry contains `reviewId`, request revision, actor internal UUID, decision, server timestamp, candidate scope/hash, finding identity/hash, next stage, and the successful action-response receipt. Retain prior entries when a retry fails or a later stage creates another gate, so a lost-response replay cannot execute twice. Candidate fields and decision evidence are server generated. Persist under `orchestration_private.generationReview`; keep audit evidence after successful commit. Never serialize this private object wholesale into `recoveryMetadata` or public results.

Reuse job states:

```text
generating/validating
  -> recoverable + pending review (lease released; no worker claim)
  -> decision recorded atomically + queued/replacement_queued
  -> worker claim validates decision and candidate binding
     keep(main)  -> existing remaining stages without rewriting main -> next gate OR commit
     keep(final) -> deterministic checks -> committing -> completed
     retry -> one authorized stage -> valid commit OR pending review/recoverable
```

Replaying a journaled reviewId/revision/decision returns its original queued action receipt even if the worker already claimed/completed/discarded the job or opened a later gate; this never requeues it. An unrecorded stale revision or a conflicting decision returns 409 and requires refresh. Missing/wrong-owner jobs return the repository's existing not-found behavior. Unknown/malformed private checkpoint versions cannot authorize Keep.

No SQL migration is expected because existing JSONB orchestration storage and `recoverable` exclusivity suffice. Add no status enum or index without a failing persistence test proving it necessary. Mixed old/new worker execution is prohibited during rollout because old workers would not honor these checkpoints.

## Task 1: Define review contracts and the private eligibility policy

**Files:** Create `packages/contracts/src/generation-review.ts`, `packages/application/src/generation/review-checkpoint.ts`, and `packages/application/src/generation/review-policy.ts`. Modify both package index exports and `packages/contracts/src/generation.ts`, `packages/contracts/src/client-api.ts` where recovery schemas are defined. Create `tests/unit/generation-review-contracts.test.ts` and `tests/unit/generation-review-policy.test.ts`.

**Interfaces:** Export schemas/types above, `generationReviewCheckpointSchema`, and `canKeepGenerationCandidate(input): boolean`. Define input as `{ complete: boolean; structurallyValid: boolean; mechanicsClean: boolean; authorityValid: boolean; candidateScope: "main" | "final"; stageComplete: boolean; reasons: readonly GenerationReviewReasonCode[] }`. True requires all five booleans plus a nonempty list consisting solely of the four soft reason codes. `stageComplete` means the scoped candidate is complete, not that later assembly has already run.

- [ ] Write contract rejection tests for extra payload fields, invalid UUID/revision, unknown reason, and private-field stripping from public projection. Add a table-driven eligibility test covering every matrix row.

```ts
expect(canKeepGenerationCandidate({
  complete: true, structurallyValid: true, mechanicsClean: true,
  authorityValid: true, candidateScope: "final", stageComplete: true,
  reasons: ["review_unavailable"]
})).toBe(true);
expect(generationReviewDecisionRequestSchema.safeParse({
  reviewId: "55555555-5555-4555-8555-555555555555",
  revision: 1, decision: "keep", bypassValidation: true
}).success).toBe(false);
```

- [ ] Run `corepack pnpm exec vitest run tests/unit/generation-review-contracts.test.ts tests/unit/generation-review-policy.test.ts`; capture the missing-contract/behavior RED result.
- [ ] Implement the schemas, version checks, and pure policy. Use `z.strictObject` for the decision request and explicit public projection field selection.
- [ ] Rerun the focused command and package checks. Commit only this task's files with `Define generation review contracts`.

**Gate:** Hard failures cannot become keepable by passing user-controlled eligibility fields; old snapshots without `review` still parse.

## Task 2: Persist pending reviews and resolve decisions atomically

**Files:** Modify `packages/database/src/generation-execution-repository.ts`, `packages/database/src/generation-repository.ts`, `packages/application/src/generation/{ports,types,use-cases,index}.ts`. Extend `tests/integration/generation-execution-repository.integration.test.ts`, `tests/integration/generation-repository.integration.test.ts`, and `tests/unit/application/generation-use-cases.test.ts`. Create `tests/integration/generation-review.integration.test.ts`.

**Interfaces:** Add `pauseForReview(scope: GenerationLeaseScope, checkpoint: GenerationReviewCheckpoint): Promise<boolean>` to the execution repository; add `decideReview(scope: GenerationJobScope, request: GenerationReviewDecisionRequest): Promise<GenerationMutationResult>` to command repository and application ports. Add `getReview(scope: GenerationJobScope): Promise<GenerationReviewDetail>` through an explicit safe projector.

- [ ] Write persistence tests: pause stores the whole checkpoint and releases the lease in one transaction; another worker cannot claim it; enqueue remains blocked; accepted state does not change. Use the real PostgreSQL fixtures already employed by the generation repository suites.
- [ ] Write a race test issuing keep and retry concurrently for the same pending revision. Assert exactly one decision wins; replay of the winner succeeds; loser gets conflict; wrong-owner access cannot inspect or resolve it.

```ts
// In generation-review.integration.test.ts, using its seeded scope/review fixtures:
const results = await Promise.allSettled([
  repository.decideReview(scope, { reviewId, revision: 1, decision: "keep" }),
  repository.decideReview(scope, { reviewId, revision: 1, decision: "retry" })
]);
expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
```

- [ ] Run the isolated integration command from the verification section with these test files; record RED before implementation.
- [ ] Implement `pauseForReview` as a lease-fenced update that stores checkpoint plus `status='recoverable'` and clears the lease atomically. Implement decision using the repository's existing transaction/lock ordering: lock scoped job, validate version/binding/state, recognize exact replay, reject conflicts, record the choice, increment revision, and queue the same operation kind.
- [ ] Block ordinary `/retry` for pending review jobs with a review-required conflict. Do not run its checkpoint-clearing SQL. Existing discard remains explicit and final; cancellation/review races must be serialized. Reject decisions after discard/cancel unless returning a previously recorded exact replay without mutation.
- [ ] Ensure checkpoint persistence updates merge with orchestration rather than overwriting review state during unrelated saves. Requeue and claim must not clear the original candidate or decision audit.
- [ ] Test atomic publication of summary and candidate reference, historical decision replay after a second gate, and lease heartbeat racing with pause. The executor must exit through its cleanup after pausing; queued lease renewals cannot resurrect the released lease or overwrite the decision.
- [ ] Run focused repository/application suites GREEN. Commit `Persist generation review decisions`.

**Gate:** A pause and decision are durable across new repository instances; no double dispatch, duplicate acceptance, cross-owner access, or loss of the original candidate.

## Task 3: Pause the worker before repair and resume the exact candidate

**Files:** Modify `services/runtime/src/generation-executor-adapter.ts` and `packages/database/src/generation-execution-repository.ts`; create `services/runtime/src/generation-review-adapter.ts` for checkpoint/gate coordination only. Extend `tests/unit/generation-executor-adapter.test.ts`, `tests/integration/generation-review.integration.test.ts`, `tests/integration/story-only-generation.integration.test.ts`, and `tests/integration/story-continuity-review.integration.test.ts`.

**Interfaces:** Export `prepareGenerationReview` from the new runtime module, taking a typed checkpoint candidate, reason list, and existing orchestration binding and producing `GenerationReviewCheckpoint`. The executor persists it with `pauseForReview`. Keep pure eligibility in Task 1's policy; no second validator implementation in runtime.

- [ ] Add synthetic-provider scenarios for schema recovery, choice repair, scene rewrite, before/final event coverage repair, and enforced continuity conflict/uncertain/unavailable. Assert a pending gate before the corresponding repair provider call. Existing provider fixtures and `runGenerationJob` in `tests/helpers/generation-worker-harness.ts` provide the real composed path.
- [ ] Add explicit assertions on provider operation counts, candidate hashes, accepted turn counts, and campaign state. Zero repair calls before a decision is the key RED assertion; a displayed warning alone is not sufficient.

```ts
// Assertions in the seeded integration scenario after the rejection is produced:
expect(job.status).toBe("recoverable");
expect(job.orchestration_private.generationReview.state).toBe("pending");
expect(providerOperations.filter((name) => name === "story_continuity_repair")).toHaveLength(0);
expect(acceptedTurnCountAfter).toBe(acceptedTurnCountBefore);
```

- [ ] Run those scenarios RED. Add awaited complete-response persistence immediately after the first provider call and before post-generation validation. Simulate a reviewer exception and a worker crash after this write; reclaim must recover the complete original without a new story call.
- [ ] Add early resume handling before provider loading, input preparation, fresh retrieval, and stage dispatch. Validate the saved candidate, decision identity, frozen protocol/policy, campaign base, and provenance before restoring stage-local variables. Final Keep must work when a mock text provider throws on every call.
- [ ] Replace automatic destructive repair dispatches with the gate at their existing positions. Apply the scope-specific stage rule above to scene findings. Keep Story-only choices and RPG events on their existing policy branches; do not add a scene-coverage call to Story-only jobs or change `off`/`observe` review behavior.
- [ ] On retry, reserve the authorized stage before dispatch, preserving the original. On lease reclaim after an uncertain dispatch, use existing recovery semantics; never make a second unreserved call. On repair failure, restore the original offer with incremented revision and a separate safe failure notice. If a different repair is needed, pause again.
- [ ] On keep, restore the exact gate candidate payload and matching provenance, not `partial_output`, failed repair output, or a reparsed UI preview. A main waiver retains exact main text through normal append-only assembly; a final waiver permits no further text calls.
- [ ] Keep existing successful-path streaming illustration behavior. At a pause, stop new optional work for that candidate and withhold accepted association; preserve/reuse already-created compatible provisional artifacts after Keep, and invalidate only artifacts belonging to replaced candidates after retry. Reviewed paths that already suppress provisional generation retain that behavior. Do not make artwork availability a condition of accepting text.
- [ ] Add no-rejection controls asserting the same provider operation order/count and successful acceptance as before, including first/opening turns, Story-only, Action, and scene. A complete valid length-finish result must not become newly rejected because of the review checkpoint.
- [ ] Run worker, Story-only, continuity, and relevant illustration regression suites GREEN. Commit `Pause rejected generation before repair`.

**Gate:** Keep dispatches zero replacement text calls; final Keep dispatches zero text calls at all; main Keep permits only the existing normal append-only stages; restarting cannot reset permission or duplicate a provider repair.

## Task 4: Enforce the waiver at transactional commit

**Files:** Modify `packages/application/src/memory/continuity-review-checkpoint.ts` and `packages/database/src/generation-execution-repository.ts`; extend `tests/unit/continuity-review-checkpoint.test.ts`, `tests/integration/generation-review.integration.test.ts`, and `tests/integration/story-continuity-review.integration.test.ts`.

**Interfaces:** Add `assertGenerationReviewAcceptance(checkpoint, expectedBinding): void` to Task 1's private checkpoint module. `expectedBinding` contains candidate scope/hash, gate stage, finding hash, owner/campaign/world identity, base identity, and frozen protocol/policy identity. At final commit, verify a main waiver against the immutable main checkpoint and prefix preservation, and a final waiver against the final payload. Only the verified final continuity waiver can replace semantic pass in the existing continuity commit assertion; a main scene waiver is not sufficient and no boolean from a request is accepted.

- [ ] Write RED tests showing that an enforced conflict can commit only with the matching stored keep decision. Mutate one binding field per case; assert rejection. Include stale base, new canonical correction, different final narration, different world, replay after replacement, and missing decision.
- [ ] Keep commit's schema parsing, mechanics checks, sent/active supersession checks, authority comparison, lease fencing, and replacement-target checks mandatory. Read the persisted decision inside the commit transaction; do not trust the executor's in-memory copy alone.
- [ ] Do not rewrite a review verdict to `pass`. Store/log `accepted_by_user` audit evidence separately with original reason codes. Preserve existing provenance binding; if a required producing checkpoint cannot be verified, Keep remains blocked even when the semantic reviewer was merely unavailable.
- [ ] For final Keep, assert accepted narration equals the selected saved candidate byte-for-byte and structured payload equals its canonical serialized hash. For main Keep, assert exact main prefix preservation, valid normal extension provenance, and no inherited waiver for final continuity. Assert exactly one accepted turn/state transition; failed commit preserves the old accepted replacement target.
- [ ] Verify Chronicle and image prompts contain fiction only, not review comments/waiver metadata.
- [ ] Verify provider response IDs, producing request hashes, continuity chains, and cost attribution belong to the accepted candidate, even after a failed retry. Record actual failed-retry usage once, but do not attribute a second generation cost to Keep or establish continuation from the rejected repair. Restore matching context/assembly inputs rather than reconstructing them from current provider settings.
- [ ] Rerun focused tests GREEN and commit `Validate explicit generation acceptance at commit`.

**Gate:** The database cannot accept a different candidate or bypass mandatory integrity checks using an otherwise valid keep decision.

## Task 5: Expose safe review details consistently through API and hydration

**Files:** Modify `services/api/src/server.ts`, `services/api/src/generation-application-adapter.ts`, `services/api/src/generation-route-lifecycle.ts`, `services/runtime/src/generation-api-composition.ts`, `packages/database/src/campaign-state-repository.ts`, and `packages/contracts/src/client-api.ts`. Create `services/api/src/generation-review-projection.ts` and `tests/unit/generation-review-projection.test.ts`; extend existing API adapter, generation lifecycle, and integration tests.

**Interfaces:** Wire Task 2's `getReview` and `decideReview` through owner-scoped application adapters. Return summary via existing polling/SSE/sync projections and detail through the GET route. Do not widen generic error serialization.

- [ ] Write RED tests for summary agreement across poll/SSE/sync, detail fetch, strict POST validation, 409 conflicts, exact replay, and wrong-owner not-found. Insert private canary text into raw errors, prompt bodies, scratchpad, and unknown findings; assert it never reaches any response.
- [ ] Generate user-readable findings through an allowlist: static labels for failure categories and bounded, fiction-only review details from validated findings. Treat model-supplied strings as untrusted. Unsafe details fall back to an accurate category message, not raw `error_message`.
- [ ] Include review ID/revision/state in campaign recovery sync fingerprints so a same-status decision transition cannot disappear behind an unchanged response. Keep private candidate storage out of polling hot paths; only detail GET loads preview content.
- [ ] Reuse generation lifecycle notification after decision queueing and pending review creation. Fetching status or detail must never retry a provider or resolve a decision.
- [ ] Run API projection, lifecycle, integration, and existing safe diagnostic tests GREEN. Commit `Expose safe generation review actions`.

**Gate:** Refresh/reconnect sees the same pending decision and reason. The browser cannot submit a fabricated candidate or inspect private provider context.

## Task 6: Add the shared client review workflow

**Files:** Modify `packages/client-web/src/api-client.ts`, `packages/client-core/src/generation/{types,workflow,machine,projection}.ts`, and `packages/client-core/src/campaign-projection.ts`. Extend `tests/unit/client-core/generation-workflow.test.ts`, `tests/unit/client-core/generation-machine.test.ts`, and `tests/unit/client-web/api-client.test.ts`. Review `packages/client-web/src/generation/fallback-source.ts` and its tests for compatibility without overwriting unrelated recovery work.

**Interfaces:** Add `GenerationApiPort.getReview(jobId)` and `GenerationApiPort.decideReview(jobId, request)` with the contract return types. Add `GenerationRun.getReview()` and `GenerationRun.decideReview(request): Promise<GenerationActionResponse>`. Watch resumes through the existing `watch(signal)` method after successful decision submission; do not invoke `retryGeneration` for these jobs.

- [ ] Add RED tests: hydration preserves review identity, detail fetching makes no generation request, same-status higher revision is observed, duplicate terminal snapshots settle watchers, ambiguous POST failure can be retried with the identical request, and 409 refreshes state rather than changing the decision.
- [ ] Extend the state projection with review summary and fetched detail keyed by reviewId/revision. Discard stale detail responses arriving after a decision or campaign switch. Cache no private candidate data and do not use local storage as review authority.
- [ ] Implement decision submission as `api.decideReview(jobId, request)` followed by `watch`; preserve preview while queued. Disable duplicate controls locally, but rely on server idempotency for correctness. A failed transport does not clear the preview or automatically submit the opposite choice.
- [ ] Give review revision its own reconciliation behavior without misusing `attempts`; worker claims still own attempt increments. Unknown review versions display safe recovery guidance with no Keep action.
- [ ] Add `acknowledgeReviewDecision(reviewId, revision)` to the generation machine and call it after a valid action receipt. Accept the resulting same-attempt transition from recoverable to queued without waiting for a claim; a higher server review revision also reconciles a decision made in another tab. Include review version/ID/revision/state in snapshot equality and ordering. Reject delayed older pending snapshots so they cannot reopen a resolved panel.
- [ ] Make review eligibility/presentation take precedence over generic diagnostics such as `discard_and_reenqueue`. A continuity failure with `review.canKeep=true` must not hide Keep because the older diagnostic says retry is unavailable. Preserve the streamed text while detail GET is pending or fails; do not replace it with an empty recovery view or reviewer output. Initial/opening recovery must not call `startAdventure()` again.
- [ ] Run client-core workflow/machine/projection and client-web source suites GREEN. Commit `Add shared generation review workflow`.

**Gate:** Both players can use the same decision path without browser-owned acceptance logic or reconnection-triggered regeneration.

## Task 7: Implement matching controls in both interfaces

**Files:** Modify `apps/web/src/story.js`, `apps/web/public/story.html`, `apps/web-next/src/story-player-generation.ts`, `apps/web-next/src/story-player-view.ts`, and `apps/web-next/src/story-player-page.ts`; adjust existing styles only as needed. Extend `tests/unit/story-generation-monitor.test.ts`, `tests/unit/web-next-story-generation.test.ts`, and create `tests/e2e/generation-review.e2e.test.ts`.

**Interfaces:** Use `getReview()` for the saved preview and `decideReview({ reviewId, revision, decision })` for both buttons. Use Task 6's shared presentation and state, not separate eligibility calculations.

- [ ] Write RED browser tests using the existing `generation-integrity-diagnostics.e2e.test.ts` API-fixture pattern, parameterized over both player routes. Verify a visible reason, full safe preview, two eligible actions, and zero automatic POST calls before clicking.

```ts
// For each route with an eligible pending-review API fixture:
await expect(page.getByRole("button", { name: "Keep this turn", exact: true })).toBeVisible();
await expect(page.getByRole("button", { name: "Continue with retry", exact: true })).toBeVisible();
expect(decisionRequests).toEqual([]);
await page.getByRole("button", { name: "Keep this turn", exact: true }).click();
expect(decisionRequests).toEqual([{ reviewId, revision: 1, decision: "keep" }]);
```

- [ ] Render the panel with semantic headings and polite live announcement. Retain keyboard focus across refresh; show pending submission and inline failure. Use safe text/normal fiction rendering, never `innerHTML` for a reason. Keep choice navigation disabled until accepted.
- [ ] Show non-eligible failures with a specific reason and no Keep control. Preserve the existing discard confirmation/action. Navigating away and back rehydrates the same review; do not force a modal to remain open.
- [ ] Verify keep, retry, failed retry with original restored, blocked candidate, reload, disconnected stream, two-tab conflict, cancel/discard race, and `replace_latest`. Assert an old accepted turn stays visible until replacement commit.
- [ ] Capture the first completed streamed narration before the rejection snapshot arrives. After final Keep and result loading, compare its text exactly with the accepted narration. Repeat with delayed/failed review-detail GET and a lost final-result response; the client must reload the accepted result rather than submit another generation.
- [ ] Run at 1440px and 390px widths in both interfaces. Save screenshots under `docs/review/assets/generation-rejection-review/` showing eligible, blocked, retry-failure, and accepted states. Check both supported web-next UI modes if the changed recovery control renders differently between them.
- [ ] Run focused unit/browser checks GREEN and commit `Add generation review controls to both players`.

**Gate:** Both interfaces expose the same durable decision; browser screenshots and interaction evidence exist for both, not only source or mocked DOM assertions.

## Task 8: Complete integrated verification and document release behavior

**Files:** Update `docs/architecture/0003-worker-owned-story-engine.md`, `docs/player-guide/recovering-a-generation.md`, and `docs/workflows/testing.md`. Create `docs/review/generation-rejection-review.md` with verification results and screenshots. Keep this plan's checkboxes current during implementation.

- [x] Run the composed PostgreSQL scenario from generation through rejection, user decision, transaction commit, and next-turn retrieval. Cover append, replacement, Story-only and Action/scene modes. Confirm isolation, no private review text in memory, and independent illustration failures.
- [x] Use a streaming synthetic provider to emit a complete first response, then a continuity conflict. Assert one `story_generation` call, zero `story_continuity_repair` calls before and after Keep, unchanged accepted candidate hash, and exactly one turn commit. Repeat with reviewer unavailability, worker restart after capture, worker restart after decision, and failed authorized retry followed by Keep. This is the primary release acceptance scenario.
- [x] Run repository checks and the relevant existing regression suites listed below. Review tests associated with every changed file, even when a new focused test exists.
- [x] Document the exception to ADR 0003's automatic-recovery rule and explain which findings are overridable. Describe exact retry semantics and what happens when keeping is impossible.
- [x] Document coordinated rollout: stop intake and old workers, finish or explicitly resolve old in-flight work, deploy the API, worker, and both players, then resume. Old recovery jobs lacking a review checkpoint retain existing recovery behavior; never fabricate a keepable draft from their partial preview.
- [x] Document rollback: stop intake/workers and resolve pending/queued review jobs using compatible code before old workers return. Keep accepted state and private audit records; no destructive down migration. Deployments remain a separate authorized action.
- [x] Review the complete diff for unrelated changes and private content. Record actual commands, RED/GREEN evidence, screenshots, and passed/failed/skipped outcomes. Commit `Document generation review recovery and verification`.

**Gate:** No claim of completion with skipped PostgreSQL or missing browser verification. Live-provider testing is optional and requires explicit authorization; deterministic providers establish workflow correctness, not narrative quality.

## Verification commands

Use PowerShell from the implementation worktree. Verify `corepack pnpm --version` matches the repository's `packageManager` first. The paths below include proposed test files created by the tasks.

```powershell
corepack pnpm exec vitest run tests/unit/generation-review-contracts.test.ts tests/unit/generation-review-policy.test.ts tests/unit/generation-review-projection.test.ts tests/unit/generation-executor-adapter.test.ts tests/unit/continuity-review-checkpoint.test.ts
corepack pnpm exec vitest run tests/unit/client-core/generation-workflow.test.ts tests/unit/client-core/generation-machine.test.ts tests/unit/client-web/generation-fallback-source.test.ts tests/unit/web-next-story-generation.test.ts tests/unit/story-generation-monitor.test.ts
corepack pnpm exec vitest run --config vitest.integration.config.ts tests/integration/generation-review.integration.test.ts
corepack pnpm test:integration
corepack pnpm exec playwright test tests/e2e/generation-review.e2e.test.ts tests/e2e/generation-integrity-diagnostics.e2e.test.ts
corepack pnpm check
corepack pnpm build
git diff --check
```

The integration config/harness must point at a disposable PostgreSQL database according to the testing runbook, never the user's active campaign database. Confirm tests ran and were not skipped for missing configuration. Use the repository's existing Playwright web servers; API-fixture browser tests do not replace the real PostgreSQL composed test.

## Final acceptance checklist

- [ ] The complete first provider response is durably captured before reviewers run, and final streamed text is flushed despite throttling.
- [ ] No rejected draft is automatically replaced before its decision gate.
- [ ] Both interfaces show an accurate reason, including a distinct review-unavailable reason.
- [ ] Keep accepts only the exact eligible candidate the user saw and records an override rather than a false validation pass.
- [ ] Retry requires explicit action and preserves the original on failure.
- [ ] Reload, worker restart, lost HTTP response, and SSE fallback preserve the pending decision.
- [ ] Concurrent decisions, double clicks, and repeated requests cannot produce two turns or two repairs.
- [ ] Hard checks, world/campaign ownership, fact references, and replacement-target integrity remain enforced.
- [ ] Both interfaces prevent unaccepted choices from advancing the story.
- [ ] Final continuity Keep makes zero further text-provider calls; normal passing/off/observe generation remains unchanged.
- [ ] Main-stage Keep preserves the exact first text while allowing only normal append-only assembly; no validation stages are reordered.
- [ ] A same-attempt queued decision, a decision from another tab, and delayed old SSE snapshots reconcile correctly.
- [ ] Keep remains available when only retry budget/provider availability has failed, subject to mandatory candidate integrity.
- [ ] Accepted state, memory, and artwork cannot include rejected draft artifacts or review reasoning.
- [ ] No unrelated working-tree changes are included.
- [ ] Documentation, focused tests, full required integration checks, and rendered screenshots are complete with honest evidence labels.

## Final plan review corrections

This source-based review tightened the plan around retaining the first correctly streamed content. These are implementation requirements, not claims that the feature has been built or tested.

| Gap found in the initial plan | Correction and required coverage |
| --- | --- |
| Preservation began at the first review offer, after a reviewer could fail or a worker could restart | Capture the complete first response before review; flush the throttled final chunk; reclaim without regeneration. Task 3 and the streaming release scenario. |
| Moving scene coverage after event assembly changed existing generation semantics | Keep gates at existing stages; distinguish main preservation from final acceptance. Tasks 1, 3, and 4. |
| Requeued Keep could traverse provider loading, fresh context assembly, and validators again | Restore persisted acceptance inputs; final Keep makes no text calls and does not require a live text endpoint. Tasks 3 and 4. |
| A single mutable decision record could lose replay identity after a second review | Retain a decision journal and original receipts; historical replay never requeues. Task 2. |
| Same-attempt recoverable-to-queued transition could be discarded by the client state machine | Acknowledge review decisions and reconcile monotonically by review revision, including other tabs. Task 6. |
| Older continuity diagnostics could still hide the new Keep action | Typed review actions take precedence; preserve preview while detail loading fails. Tasks 5 through 7. |
| Exhausted retry budgets or failed repair metadata could contaminate the original's acceptance | Separate retry allowance and provenance from the retained candidate; test retry failure then Keep, costs, and continuation identity. Tasks 2 through 4. |
| Blanket illustration deferral would change the normal successful streaming experience | Preserve existing successful behavior and gate only acceptance/continuation of candidate-specific work at review. Task 3. |
| Browser fixtures alone did not prove the first streamed text was actually retained | Compare streamed text and final accepted text, plus real PostgreSQL commit and provider-call counts. Tasks 7 and 8. |

Remaining deliberate limits: a rendered narration prefix alone cannot establish a complete typed turn; event-accounting and structural failures cannot be waived here; content never durably captured before a process crash cannot be guaranteed recoverable. None of these conditions authorizes a silent replacement generation.
