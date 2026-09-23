# Campaign cast phase 04: automatic discovery implementation plan

> **For agentic workers:** Implement task-by-task with strict TDD. Use `superpowers:subagent-driven-development` when delegation is selected; otherwise execute natively. Do not start a later phase in this patch.

**Goal:** Discover sparse supporting-character records from newly accepted narration without delaying or endangering story acceptance.

**Architecture:** Enqueue a durable per-turn job in the existing accepted-turn transaction. A bounded worker extracts evidence-linked proposals, resolves only unambiguous identities, and applies a validated batch atomically with idempotent receipts. Existing manual overrides always survive.

**Tech Stack:** TypeScript, Zod, PostgreSQL jobs/leases, existing text execution routing and cost accounting, Vitest, Playwright.

**Spec:** [Shared specification](2026-09-22-campaign-cast.md). Dependency: phase 03 accepted.

**Progress (2026-09-23):** Contracts, evidence validation, source segmentation, queue/checkpoints, validated publication, physical accounting, recoverable application flow, frozen direct/preset execution, default-off worker composition, and atomic acceptance enqueue are verified. Lifecycle wiring, coverage, candidate resolution, shared provider/attempt limits, and UI remain pending; see [checkpoint and remaining work](../../review/campaign-cast/phase-04-progress.md). No exit gate is complete.

## Global constraints

Shared constraints apply. Discovery is a separate operation, not an addition to the story model's output schema. Never send source content to the image endpoint. Retain successful accepted stories on all extraction failures. No relationships, automatic merge, or historical backfill in this phase.

## Files and ownership

- Create `packages/contracts/src/campaign-cast-discovery.ts`, `packages/domain/src/campaign-cast-discovery.ts`, `packages/application/src/campaign-cast/discovery.ts`, `packages/database/src/campaign-cast-job-repository.ts`, `services/runtime/src/campaign-cast-discovery-adapter.ts`.
- Add the next ordered migration with suffix `_campaign_cast_discovery.sql`.
- Modify phase 01/02 cast repository/lifecycle/composition, `packages/database/src/generation-execution-repository.ts`, `services/worker/src/worker.ts`, `services/runtime/src/main.ts`, `packages/contracts/src/prompt-library.ts`, `packages/contracts/src/text-execution-plan.ts`, `services/runtime/src/provider-application-composition.ts`, and existing operation/cost registries reached by those modules. Add a distinct `cast_discovery` operation through the current routing contracts; do not bypass their prepared-request or cost ledgers.
- Extend portable classifications for job/receipt tables and durable source observations.
- Add `tests/unit/campaign-cast-discovery.test.ts`, `tests/unit/campaign-cast-discovery-adapter.test.ts`, `tests/integration/campaign-cast-discovery.integration.test.ts`; extend `tests/e2e/campaign-cast.e2e.test.ts` and the cast runbook.

## Wire and application contracts

```ts
type CastDiscoverySource = {
  scope: CastScope; turnId: Id; turnNumber: number;
  narrationRevision: number; sourceHash: string; timelineRevision: number;
  paragraphs: { id: string; text: string }[];
};
type CastDiscoveryCandidate = {
  localKey: string; name: string; aliases: string[];
  existingCharacterId: Id | null;
  identityEvidence: { paragraphId: string; quote: string }[];
  observations: {
    field: CastField; value: string; mode: "fact" | "claim";
    speakerCharacterId: Id | null; paragraphId: string; quote: string;
  }[];
};
type CastDiscoveryOutput = { version: 1; characters: CastDiscoveryCandidate[] };
type CastDiscoveryValidation = {
  accepted: CastDiscoveryCandidate[];
  rejected: { localKey: string; code: string }[];
};
function validateCastDiscovery(input: {
  source: CastDiscoverySource; output: CastDiscoveryOutput;
  knownCharacters: CastCharacter[];
}): CastDiscoveryValidation;
```

Provider-local keys identify candidates only within one output. Server IDs are allocated in the apply transaction and recorded in the idempotent receipt. Supplied `existingCharacterId` must be in the job's captured, campaign-scoped known-character set and must have supporting identity evidence; it is not accepted on provider assertion alone.

## Review focus

Worker death after response or after commit; ambiguous same-name characters; dialogue and instructions inside narration; corrected/rewound source while extraction is running; concurrent manual edits and active generation.

## Task 1: evidence extraction contract and deterministic validator

- [ ] Create strict response schemas: at most 20 candidates per chunk, 20 observations per candidate, shared field limits, and at least one exact source quote per identity. Reject arbitrary fields and oversized output.
- [ ] Build stable paragraph IDs over the effective accepted narration, with source hash/revision. Validate each quote against the supplied paragraph; attach server-owned turn references afterward. Do not let the model calculate source offsets or owner/campaign IDs.
- [ ] Test evidence containment directly before provider integration:

```ts
expect(castDiscoveryOutputSchema.safeParse({ version: 1, characters: [{
  localKey: "new-1", name: "Mara", aliases: [], existingCharacterId: null,
  identityEvidence: [], observations: []
}] }).success).toBe(false);
```

- [ ] Add tests where a real quote does not support a proposed field, a speaker makes a claim, a person is named in an unfulfilled intention, and narrative text contains instructions to edit another campaign. Require the extractor prompt to report stated evidence only, with no invented profile completion. Exact quote validation establishes provenance, not semantic truth; suspicious/contradictory assertions remain unapplied candidates and visible diagnostics.
- [ ] Known aliases resolve only when unique and evidence-consistent. Never merge by name alone. If a candidate might be a known character but identity is uncertain, retain it as an unresolved candidate with source evidence, not a confirmed duplicate identity. The user may explicitly create a distinct character or attach it to an existing one using revision-checked resolution in the cast detail; no bulk merge functionality.
- [ ] Supply relevant pinned-world identities and the protagonist link alongside existing campaign characters, using existing world reference selection. If accepted evidence unambiguously identifies a world character, create or reuse its unique campaign occurrence with world-version provenance; do not copy or mutate its world record. Discovering the protagonist adds admissible observations to its linked identity but never silently edits `campaigns.character_profile`. Ambiguous world matches remain unresolved. Phase 05 consumes these established identities rather than creating them as a prompt side effect.
- [ ] Retain consequential unnamed people using an evidence-based display label such as “the injured courier”; do not assign that label as a universal alias. Track named identifiable people; skip crowds and incidental roles without enough identity evidence.
- [ ] Run the discovery unit suite RED/GREEN and commit the contract/validator.

## Task 2: durable queue, extraction, and transactional apply

- [ ] Add `campaign_cast_discovery_jobs` with states `queued`, `running`, `retry_wait`, `complete`, `failed`, `cancelled`; persist source revision/hash, timeline revision, execution snapshot, lease, attempt count, chunk checkpoints, and sanitized diagnostics. Add `campaign_cast_discovery_receipts` for applied source/chunk/output identity and allocated IDs; classify jobs operational, applied evidence/receipts according to whether required to rebuild identity without duplication.
- [ ] Enforce uniqueness over campaign, source turn, narration revision, extractor protocol, and chunk ordinal. Enqueue from accepted append/replacement only when discovery capability is enabled. Enqueue failure rolls back the transaction; no provider call occurs inside it. Feature-disabled acceptance follows the original path.
- [ ] Initialize forward enrollment at the first eligible accepted turn, recording `coverageStartTurn`. Do not label all earlier history tracked. On narration correction enqueue the replacement source revision only for enrolled tracked turns; phase 02 invalidates the previous revision.
- [ ] Process per campaign in source order. Freeze text provider/model/routing/prompt protocol and source revision at enqueue. Set `cast-discovery-v1`; begin with a 30-second per-request timeout, at most two automatic attempts per chunk, exponential bounded retry delay, one active discovery job per campaign. Use the existing global provider concurrency controls as well.
- [ ] Split long narration at paragraph boundaries with a target 3,000 estimated source tokens per chunk and the provider's actual request/output budget as the hard ceiling. Split an oversized paragraph into stable subparagraph evidence segments. Record all chunks; never mark a turn complete when output limits or chunk limits omitted source text. Maximum 32 chunks per automatic job; larger turns report `source_requires_manual_scan` without blocking story acceptance.
- [ ] Use one bounded extraction call per chunk, no recursive repair loop. Retain valid parsed output before application so an apply retry makes no additional provider call. Record actual provider usage and failures through existing physical-attempt accounting.
- [ ] Apply under campaign/state/cast locks in a consistent order: verify lease, timeline, current source hash, owner, and captured character revisions. Reconcile against current manual overrides, append validated observations, create only resolved identities, refresh projection, advance cast revision, and persist receipt atomically.
- [ ] If a generation is queued/running/recoverable, defer cast-authority publication; do not repeatedly invalidate its snapshot. Provider work may finish and persist its proposal, but application waits. A manual edit made after extraction started must remain effective; revalidate identities before applying.
- [ ] Advance `trackedThroughTurn` only across contiguous successfully processed source revisions from coverage start. Unresolved candidates may remain pending review while extraction coverage is complete; represent unresolved-count separately from job health. Failed gaps block the completeness watermark, not story generation.
- [ ] Test real PostgreSQL + deterministic provider for restart after response, duplicate worker delivery, lost lease, source correction, rewind, manual edit race, active-generation deferral, provider timeout, malformed output, and multi-chunk completion. Verify one accepted story and no extra narration-provider call in every failure case.
- [ ] Run new discovery integration suite plus affected generation commit/worker tests RED/GREEN; commit durable execution.

## Task 3: discovery controls, correction, and release gate

- [ ] Extend cast API/read model with job status, coverage, unresolved candidates, and source links. Add revision-checked resolve-candidate and retry-failed-discovery actions; a resolution may attach evidence to an existing allowed ID or explicitly create a distinct identity. Reusing the resolution receipt is idempotent. No name-based bulk merge.
- [ ] Persist unresolved candidates in `campaign_cast_discovery_candidates` with campaign scope, source revision, bounded validated proposal, resolution state, and receipt key; classify unresolved proposals as operational and applied identity decisions as portable events. Add POST `/api/v1/campaigns/:campaignId/cast/candidates/:candidateId/resolve` accepting `CastWriteBase` plus `{ action: "attach", characterId: Id }` or `{ action: "create" }`. Add POST `/api/v1/campaigns/:campaignId/cast/discovery/:jobId/retry` accepting current boundary and idempotency key. Reuse phase 02's ownership, stale-write, and active-generation rules. Resolution of a stale/corrected source returns 409 and applies nothing.
- [ ] Add a compact status “Character tracking is catching up” or actionable failure with Retry in both cast panels. A failed extraction must not change the story generation button into “Retry story.”
- [ ] Add UI tests: new character appears after accepted turn; ignored character remains ignored; user edit persists through another extraction; unresolved candidate is visibly pending and can be resolved; retry targets only discovery; capability off makes no extraction calls.
- [ ] Wire `castDiscovery` default off and document required text routing, caps, recovery, and cost visibility. Disabling the gate stops new extraction/claims; already running calls may checkpoint but must not publish while disabled. Retain jobs for explicit resume and keep cast editing available.
- [ ] Run affected browser tests on both surfaces and save screenshots. Record deterministic extraction counts and latency separately from story latency. A live model evaluation is optional evidence, not a release gate disguised as a unit test.

## Exit gate and rollback

Automatically discovered records are sparse, editable, source-linked, idempotent, and campaign-isolated. Failure cannot erase or regenerate a story. All chunk coverage and unresolved identity states are honest. Rollback disables discovery and leaves manual editing, stored evidence, export support, and queued recovery records intact. Prompt-context integration belongs to phase 05.
