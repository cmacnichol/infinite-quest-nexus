# Story generation and continuity audit

Date: 2026-10-03
Audited revision: `94853d2d859f57b8a75bb69edd532c016570dffa`
Scope: current source across world authoring, turn generation, RPG mechanics, campaign persistence, Chronicle retrieval, context assembly, player clients, illustration orchestration, and verification infrastructure.

## Assessment and evidence boundaries

Infinite Quest Nexus has a substantial foundation for persistent, turn-based storytelling. Durable generation and authoritative storage are its strongest areas. Effective recall, tracker consistency, and RPG depth need improvement before the project can claim reliable long-campaign continuity.

Preserving information in PostgreSQL does not guarantee that the next turn receives or respects it. This audit distinguishes storage integrity, context selection, and model adherence.

This document records the fresh source inspection and executions from the audit in the preceding chat turn. Earlier audit reports and historical benchmark results were not used as proof. Saving this document in a new worktree does not constitute a second test run. The audit was a broad architecture and critical-path assessment, not a proof of every possible execution path or a live deployment certification.

Evidence labels:

- **Reproduced:** executed against current production logic with synthetic inputs.
- **Source-confirmed:** established by tracing current code; the affected database or provider scenario was not executed in this audit.
- **Recommendation:** a proposed improvement, not an assertion that the missing feature is a defect.

The first two defects have a [detailed implementation plan](../superpowers/plans/2026-10-03-continuity-defects.md). Implementation is not part of this documentation task.

## Current status

| Capability | Assessment |
| --- | --- |
| Turn-based play | Actions, Story Direction, choices, streaming, retry, review decisions, replacement, branching, and rewind are implemented. |
| Authoritative persistence | PostgreSQL stores worlds, immutable world versions, campaigns, accepted turns, state, and durable generation jobs. |
| Generation integrity | Idempotency, worker leases, stale-authority checks, validation, durable candidates, and transactional acceptance exist. |
| Memory and context | Hybrid retrieval, current continuity, fact supersession, history selection, and bounded request planning exist. A reproduced selection defect prevents some relevant facts from reaching the model. |
| Character continuity | Profiles, cast observations, user overrides, and contextual selection exist. Important capabilities are disabled by default. |
| RPG mechanics | Configurable stats, private percentile resolution, narrative events, and free-form trackers support rules-light play. A structured combat, inventory, or progression engine was not found in the reviewed domain paths. |
| Illustrations | Independent provider configuration and failure handling exist; provisional streaming can start image work before complete story validation. |
| Player clients | Legacy and replacement Story interfaces coexist, sharing generation and input policies. Browser status streams can fall back to polling. |
| Portability and operations | World/campaign/system transfer workflows and Compose/Swarm deployment support exist. Live restore, deployment, and provider reliability were not established by this audit. |

## Safeguards to preserve

- Keep world versions distinct from mutable campaigns and require explicit campaign migration.
- Retain server-resolved ownership and owner/campaign/world-version boundaries in database reads.
- Preserve generation authority checks immediately before commit and database uniqueness/lease fencing.
- Allow fact supersession only for verified, active, in-scope IDs actually sent to the producing request.
- Preserve private mechanics isolation from narration, memory, and illustration prompts.
- Keep exact saved candidates, producing-request identities, and explicit review decisions bound together.
- Retain polling recovery when an SSE connection fails.
- Preserve independent illustration enqueue failure handling around accepted turns.

Source anchors: [commit and supersession safeguards](../../packages/database/src/generation-execution-repository.ts), [generation authority](../../packages/database/src/chronicle-generation-context.ts), [browser recovery](../../packages/client-web/src/generation/fallback-source.ts).

## Action A1 Restore retrieved facts omitted by protected allocation

**Priority:** first implementation workstream.
**Evidence:** reproduced with the actual `planGenerationPromptContext` function.

### Problem and impact

The planner constructs a duplicate-fact set from all captured protected facts before determining which protected facts fit. A fact dropped from that allocation can also be removed from Chronicle candidates as a duplicate. Retrieval can find the right fact while the final request still omits it.

### Reproduction

A synthetic campaign contained 41 facts, including an older fact that the northern gate requires the silver key. That same fact was returned as a high-ranked canonical-fact candidate.

| Observation | Actual result |
| --- | --- |
| Captured fact count | 41 |
| Selected protected facts | 11 |
| Older gate fact in protected output | No |
| Older gate fact in retrieved output | No |
| Omission reason | `duplicate_source` |
| Control with that fact removed only from captured protected source | Retrieved fact included |

This was a planner-level execution, not a PostgreSQL or live-model test.

### Required action

Deduplicate against facts actually transmitted in protected/current authority. Preserve source validation, supersession authority, evidence manifests, final request budgets, and historical protocol behavior. Test reservation, retrieval, final serialization, and next-turn replay together.

**Acceptance:** a verified relevant fact excluded from protected allocation remains eligible for optional retrieval; a fact actually sent elsewhere appears once; omission diagnostics describe the real reason.

Source: [context planner](../../services/runtime/src/generation-context-planner.ts), especially protected-fact duplicate filtering and final historical-block assembly.

## Action A2 Make tracker updates resolve stable identities

**Priority:** second implementation workstream.
**Evidence:** reproduced by executing the current private merge function extracted unchanged from source, using the production tracker normalizer.

### Problem and impact

Existing trackers are indexed by ID, but a model update may identify a tracker by name. The documented model-output example uses name/value. When ID and name differ, the merge can create a second tracker with a conflicting value and missing update rules.

Input:
```json
{
  "current": [{"id":"location","name":"Location","value":"Harbor","rules":"Track the current place."}],
  "update": {"name":"Location","value":"Northern gate"}
}
```

Actual result:
```json
[
  {"id":"location","name":"Location","value":"Harbor","rules":"Track the current place."},
  {"id":"Location","name":"Location","value":"Northern gate","rules":""}
]
```

This confirms the merge defect, not a full accepted-turn database workflow.

### Required action

Resolve explicit IDs first, then unambiguous names for existing compatible output. Preserve stable identity and existing fields absent from the update. Reject ambiguous identity without mutating accepted state. Preserve original provider payloads and review hashes; normalize only the materialized state projection.

The initial fix need not make IDs mandatory in the provider schema. Mandatory IDs and any prompt-protocol migration are a separate enhancement.

**Acceptance:** the example yields exactly one tracker with ID `location`, new value, and original rules. Append, replacement, Keep, retry/reclaim, and next-turn context behave consistently.

Sources: [current merge](../../packages/database/src/generation-execution-repository.ts), [tracker normalization](../../packages/domain/src/campaign-trackers.ts), [story output contract](../../packages/contracts/src/story-prompt.ts).

## Action A3 Make effective memory capabilities explicit

**Priority:** after A1 and A2.
**Evidence:** source-confirmed configuration behavior.

`HISTORY_COVERAGE_ENABLED` defaults to true, but selection of the newer history-context protocol depends on cast context. Cast context depends on cast discovery, which depends on cast editing. All three cast settings default to false. New campaigns receive Max memory with continuity review off.

This is a configuration/design gap, not a claim that every deployment currently has those defaults. It also does not mean default campaigns have no memory.

**Action:** decouple history coverage from cast rollout flags where compatible; expose effective history, cast, semantic retrieval, and review status. Keep review opt-in explicit. Do not blindly enable experimental features to make the labels match.

**Acceptance:** configuration tests cover the complete flag dependency matrix; the player can tell which mechanisms are active for newly queued turns; already-frozen jobs retain their captured policy.

Sources: [runtime configuration](../../packages/database/src/config.ts), [policy snapshot selection](../../packages/database/src/story-memory-policy-repository.ts), [new-campaign review default](../../database/migrations/0112_continuity_review_opt_in.sql).

## Action A4 Preserve accepted history across replacement and rewind

**Priority:** architectural follow-up.
**Evidence:** source-confirmed mismatch with the append-only ledger goal.

Latest-turn replacement deletes the previously accepted row inside its commit transaction. Rewind deletes later accepted turns and related records. These are intentional, guarded operations, but previous accepted versions cease to exist in the authoritative ledger.

**Action:** retain accepted revisions and represent active history through a timeline/revision pointer. Preserve useful replacement and rewind operations. Plan migration, portable export, fact provenance, cast invalidation, asset references, and recovery before implementation.

**Acceptance:** previous accepted versions remain recoverable and auditable; only active-timeline content enters current context; existing isolation, stale-state, and idempotency guarantees remain intact.

Sources: [replacement transaction](../../packages/database/src/generation-execution-repository.ts), [rewind](../../packages/database/src/campaign-state-repository.ts).

## Action A5 Gate image dispatch on validated story authority

**Priority:** integrity follow-up.
**Evidence:** source-confirmed dispatch path; not exercised against a live image provider.

With continuity review off, streaming narration can create provisional segments and queue image work before the complete story passes validation. The image worker can claim these jobs during active story generation. Fiction sanitization exists, but it does not establish complete-turn acceptance.

**Action:** allow provisional segmentation while requiring a durable validation/acceptance receipt before external image dispatch. Do not rely on later cancellation to undo a request already sent.

**Acceptance:** rejected/incomplete narration causes no external image request; accepted narration can enqueue independently; image failure does not change story acceptance or rerun narration.

Sources: [streaming illustration setup](../../services/runtime/src/generation-executor-adapter.ts), [provisional enqueue](../../services/runtime/src/illustration-segment-job-adapter.ts), [image claim and dispatch](../../services/runtime/src/illustration-image-job-adapter.ts).

## Action A6 Measure end-to-end continuity

**Evidence:** recommendation.

Extend the existing evaluator to measure whether important facts reach the final serialized prompt and influence accepted output. Retrieval recall alone is insufficient.

Include old promises, NPC relationships, changed possessions, location transitions, resolved threads, corrections, model changes, and restart recovery. Separate contradiction rate, lost-thread rate, review false alarms, latency, and cost. Include small context windows, lexical fallback, and incomplete indexes.

**Acceptance:** repeatable synthetic PostgreSQL runs establish workflow correctness; separately authorized held-out live-provider runs establish narrative quality. Reports never substitute one evidence class for another.

Source: [continuity evaluator](../../scripts/evaluate-story-continuity.ts).

## Action A7 Define the intended RPG depth

**Evidence:** recommendation based on the current mechanics implementation.

Current mechanics select a stat, apply a private percentile roll, and supply fictional outcome guidance. Eligible Action-mode turns use this path; Story Direction intentionally bypasses RPG assessment and event evaluation. Assessment failures can fall back to local keyword matching.

**Action:** retain rules-light play, but define explicit inventory, resources, conditions, quests, and action costs if deeper RPG play is desired. Resolve consequential state transitions deterministically before narration. Add an explicit no-roll-needed outcome and a safe indication of degraded referee operation.

**Acceptance:** narration cannot invent mechanical resource changes; state transitions have replayable outcomes; provider failure does not silently change the selected ruleset.

Sources: [mechanics](../../packages/story-engine/src/mechanics.ts), [generation mode policy](../../packages/domain/src/campaign-generation-policy.ts).

## Action A8 Improve long-campaign memory organization

**Evidence:** recommendation.

The compact story ledger records player intent, not a complete outcome history. Context remains bounded; token estimates are approximate, and a larger configured context does not prove better recall.

**Action:** explore source-linked episode summaries of accepted outcomes, durable thread identities, temporal state, and relevance-aware fact selection. Retain accepted turns as the recovery source. Keep historical evidence distinct from present authority and summaries rebuildable.

**Acceptance:** older plot obligations can be recovered under constrained context; summaries link to accepted sources; explicitly cleared state does not reappear from older derived memory.

Sources: [ledger projection](../../packages/domain/src/story-history-projection.ts), [context budgeting](../../packages/story-engine/src/context-budget.ts), [token estimate](../../packages/contracts/src/token-estimate.ts).

## Action A9 Reduce change risk and strengthen release checks

**Evidence:** source-confirmed structure plus recommendation.

The audited generation executor is approximately 4,990 lines. Assessment, streaming, recovery, review, and acceptance orchestration are concentrated there. Current CI installs Chromium but does not execute the Playwright suite.

**Action:** extract independently testable stages gradually while retaining durable checkpoint contracts. Add browser play-loop execution to CI for both supported Story surfaces. Fix the dedicated integration-database setup before treating local release verification as complete.

**Acceptance:** focused changes no longer require broad orchestration edits; composed tests preserve crash/reclaim/Keep semantics; CI exercises browser actions rather than only compiling browser code.

Sources: [executor](../../services/runtime/src/generation-executor-adapter.ts), [CI workflow](../../.github/workflows/ci.yml).

## Verification record from the audit

| Check | Result | Limits |
| --- | --- | --- |
| Unit suite | 366 files passed; 4,727 tests passed; 44 skipped | Includes platform-gated filesystem/permission cases; skips are not passes. |
| Root, application, client-core, client-web TypeScript | Passed via direct compiler invocations | The original package-manager wrapper invocation failed; this is not a claim that that invocation passed. |
| Both web-client TypeScript checks | Passed | Not rendered-browser evidence. |
| Repository boundary and data-safety checks | Passed | Static repository checks. |
| `git diff --check` | Passed | Application source and lockfile stayed unchanged. |
| Selected PostgreSQL integration tests | Setup failed: configured test-database password rejected | No integration cases ran. |
| Full build, browser, live provider, deployment and restore | Not run | No readiness claim for those gates. |
| A1 synthetic planner reproduction | Confirmed defect | No PostgreSQL or live model involved. |
| A2 extracted merge-function reproduction | Confirmed defect | No commit transaction exercised. |

The existing locked dependencies were restored from local cache to allow fresh unit verification. No dependency versions or tracked code were changed.

## Recommended delivery order

1. Implement and verify A1 and A2 independently using the linked plan.
2. Resolve A3 effective-capability configuration and player visibility.
3. Design A4 retained timeline history and implement A5 validated image dispatch.
4. Establish A6 long-campaign quality measurements.
5. Use those measurements and product priorities to sequence A7 through A9.

This ordering is a recommendation. Only the documentation and implementation plan have been requested in the current task.

