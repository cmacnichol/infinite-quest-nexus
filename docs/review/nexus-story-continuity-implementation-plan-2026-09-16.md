# Nexus Story Continuity: Investigation and Implementation Handoff

> **Default-policy follow-up:** The user subsequently requested Max memory for all existing and new campaigns, with enforced conflict repair and blocking. The [campaign memory defaults plan](../superpowers/plans/2026-09-16-campaign-memory-defaults.md) supersedes this document's opt-in/default-off rollout choices. The original integrity, isolation and frozen-job requirements remain in force.

> **For agentic workers:** Use `superpowers:executing-plans` to implement this plan task by task. Use `superpowers:subagent-driven-development` only when the execution session authorizes delegation. Each task below is a bounded handoff; do not implement the entire program in one unreviewed change. Follow the repository's current `AGENTS.md` and relevant skills before implementation.

**Goal:** Stop preventable loss of story history by repairing what Nexus sends to the model, preserving relevant history under real request budgets, and detecting evidence-backed continuity failures before acceptance.

**Architecture:** Retain immutable accepted turns, explicit user corrections, the private authority loader, full-replacement continuity, bounded hybrid retrieval, exact serialized-request budgeting, and durable guarded commits. Add typed authority and evidence contracts, repair retrieval omissions, reserve immediate history, and introduce an optional, durable continuity-review stage. Advanced memory techniques remain measured experiments rather than prerequisites.

**Tech stack:** Existing TypeScript/Node, pnpm, Zod, PostgreSQL and existing vector retrieval, Vitest, current text-provider adapters, both active Story UIs. No graph database, new hosted memory service, new model vendor, or fine-tuning is required for the core repair.

**Spec:** Sections 1–8 of this document. Task contracts and acceptance criteria are in sections 9–12.

**Investigated baseline:** `cmacnichol/infinite-quest-nexus`, `main` at `60a4aabe4adc2759f14fd53370e31465daabb783`, checked September 16, 2026. All existing-file paths are repository-relative. Files explicitly marked **new** are proposed, not present at this baseline.

**Implementation status (September 16, 2026):** Core releases T01–T20 and the T21 read-only repair proposal tool are implemented in the isolated worktree. T22–T26 are excluded by user decision. Local verification and release-promotion decisions are tracked in [the release-readiness report](story-memory-release-readiness-2026-09-16.md). Production data and deployment settings have not been changed. Live-provider and human quality gates remain unmeasured; numerical release thresholds below remain acceptance targets rather than observed results.

**Plan review revision:** Incorporated the review findings into contracts, task ownership, regression scenarios and release gates. Implementation must update both the active legacy Story Player (`/story`, `apps/web`) and the new Story interface (`/app/story`, `apps/web-next`), including recovery interactions and illustration state. This paragraph records the pre-implementation review; the dated implementation status and readiness report above supersede its historical execution status.

**Repository cross-check revision:** Addresses all six follow-up findings against baseline `60a4aabe`: event-stage restart and attempt budgets (T18), end-to-end diagnostic contracts (T14), preserved profile-edit exclusion (T03/T14), pre-dispatch illustration gating owned by T17, query-family rank aggregation (T02/T08), and explicit prompt-snapshot evolution (T02/T16/T19). The implementation contracts below supersede the earlier ambiguous wording; the dated implementation status and readiness report record subsequent implementation and verification.

## Execution record

The task-card checkboxes below preserve the reviewed acceptance checklist, including gates that require later live evaluation. They are not the current implementation tracker. Use this execution record and the dated readiness report for completion and verification status.

| Tasks | Worktree status |
| --- | --- |
| T01–T09 | Implemented and reviewed: baseline fixtures, contracts, authority fencing, complete fiction projection, canonical facts, bounded world references, balanced queries and historical fact retrieval. |
| T10–T13 | Implemented and reviewed: recent accepted history, exact serialized packing and verified narrative excerpts. |
| T14 | Diagnostics, inline revision-checked profile editing and recovery are implemented in both interfaces. Final browser verification passed 39/39 cases plus a five-run concurrent recovery repeat; desktop/mobile screenshots are in the readiness report. |
| T15 | Implemented with a real PostgreSQL 120-execution matrix and explicit live copied-request tooling. Human/live quality gates remain pending. |
| T16–T18 | Implemented and reviewed: frozen review/repair prompts, evidence-bound review, durable dispatch and bounded semantic/event repair. |
| T19 | Archive/branch/replay compatibility implemented, including canonical fact reference remapping and non-portable operational state. Focused real PostgreSQL verification passed; environment-limited broader checks are documented. |
| T20 | Operational runbooks and separate release decisions recorded. R1/R2/R3 promotion remains blocked on the applicable live evidence. |
| T21 | Read-only revision-bound repair proposal tool implemented and verified. No production campaign repair performed. |
| T22–T26 | Excluded from this implementation by user choice. |

## Contents

1. Executive decision and scope
2. Confirmed source findings
3. Research comparison and decisions
4. Target authority and memory architecture
5. Shared interfaces and policies
6. Budget, retrieval, and evidence algorithms
7. Continuity checking and durable recovery
8. Compatibility, privacy, and operational constraints
9. Work breakdown and dependency schedule
10. Implementation task cards T01–T21
11. Optional experiment task cards T22–T26
12. Verification, release gates, and implementation handoff
13. Sources and source map

## 1. Executive decision and scope

The highest-value fix is **not a larger context window or a more elaborate prompt**. Several useful facts never reach the writer, and some retrieval queries lose the material that would locate older history. Fix those deterministic defects before evaluating a more expensive memory architecture.

Deliver the program in three core releases:

| Release | What it fixes | Included work | What it deliberately does not do |
| --- | --- | --- | --- |
| R1: Authority and retrieval correctness | Missing character/world context; structured fact omission; long-direction query collapse; old facts excluded before ranking | T01–T09, minimum T14 diagnostics, T15 harness, T19 compatibility, T20 release gate | No extra model calls; no full-history pinning; no automatic campaign repair |
| R2: History packing and provenance | Recent scene context losing to retrieval; useful passages lost when whole parents do not fit; misleading action labels and source offsets | T10–T13, full T14, expanded T15/T19, repeat T20 | No partial replacement state; no invented excerpts; no silent truncation of protected records |
| R3: Continuity review and bounded repair | Structurally valid but contradictory/dropping drafts accepted without semantic review | T16–T18, T14/T15/T19 integration, repeat T20 | No unlimited rewrite loops; no automatic acceptance of unverified repairs; no restoration of intentional empty state |

T21 is a separate, approval-based repair workflow for already damaged campaigns. T22–T26 are optional experiments. R1 should not wait for a graph, reranker, hierarchical summarizer, or thread-schema redesign.

Success means: required information is in the actual request; selected optional evidence is useful and traceable; invalid authority fails safely; current corrections win; accepted story state survives retries, replacement, branches and archives; and measured continuity improves without unacceptable cost or false rejection.

### Revisions to the earlier recommendations

- **Do not pin every active historical fact.** That is unbounded. Protect complete current replacement state and current-source fact additions/updates; retrieve older active facts with relevance, identity and temporal validity.
- **Do not switch summary, scratchpad and threads to patches in R1–R3.** The repository explicitly selected full replacement. Patches require deletion, conflict, migration, replay and portability semantics that do not repair today's missing inputs.
- **Do not copy the public character helper into private authority unchanged.** It bounds total text and fields. Private authority needs an explicitly complete fiction projection or an explicit shortfall, not an unnoticed 1,600-character field truncation.
- **Do not treat existing chunk offsets as quotation proof.** Chunk text is normalized, sanitized and packed; the code falls back to a computed offset when a substring cannot be found. Verify exact source spans before using excerpts as evidence.
- **Do not call the public preview the generation prompt.** It intentionally differs and cannot expose private authority. Evaluate the real executor-to-provider boundary.

## 2. Confirmed source findings

“Confirmed” below means the behavior is visible in the inspected code, not that a live campaign failure was reproduced during this turn.

| ID | Finding and evidence | Consequence | Repair |
| --- | --- | --- | --- |
| F1 | `chronicle-generation-context.ts` selects `world_content.world` as `worldCanon`; sibling `entities`, `relationships` and `playableCharacters` are not placed in that object. | Overview/rules arrive, but relevant world records may not. Mentioning an entity by name is not equivalent to supplying its attributes and relations. | T05, with T02/T11 contracts |
| F2 | The private campaign query selects `selected_character_id`, not `character_profile` or `character_snapshot`. Public preview uses `characterNarrativeContext`. | Selected character ID alone cannot convey biography, motivations, voice, relationships or an edited campaign profile. Preview can look healthier than generation. | T03–T04 |
| F3 | Commit stores plain `canonicalFacts` and structured `canonicalFactUpdates`. `materializeGenerationContinuity` reads only `canonicalFacts`; strings become `{id:null,content}`. The Chronicle projector separately combines both using deterministic identities. | A structured-only update can be absent from the protected next-turn state even though it was retained and projected. Plain facts lack actionable IDs there. This is a prompt-materialization defect, not proof of database loss. | T06 |
| F4 | `planChronicleQueries` prepends the full action to variants, then bounds action/entity/scene/thread queries to 1,000/1,400/1,600/1,400 characters. | Long Story Directions can remove appended hints and later beats. Term-based deduplication can collapse variants. | T08 |
| F5 | Cutoff-aware fact SQL computes lexical relevance but first limits rows ordered by `source_turn_number DESC, source_fact_index`. Default historical pool is 256, scaled with generation budget. | A much older exact match can be absent from the candidate pool, so later rank fusion cannot rescue it. | T09 |
| F6 | Private generation filters by selected parent IDs, then passes `memory.content` rather than `selectedParentContent`. Final planner accepts/omits complete records. | A useful passage in a long parent can disappear at final budget selection. This is the current intentional whole-record contract, so excerpts require an explicit amendment. | T12–T13 |
| F7 | Latest effective turn is protected; `recentTurns:8` affects retrieval pooling, not a guaranteed contiguous recent window in the final request. | Nearby dialogue, unfinished actions and local scene transitions can lose to other candidates. | T10–T11 |
| F8 | Story-only policy disables legacy scene coverage. Shape/mechanics/choice checks do not establish semantic consistency or justify omitted threads. | Valid JSON can still contradict history or replace useful continuity with an incomplete summary. Empty summary/thread list are valid, so nonempty checks are not a fix. | T16–T18 |
| F9 | Current retrieval evaluator uses `buildContextPreview` and synthetic embeddings. | It does not prove private authority coverage, final serialized inclusion, or long-run live-model consistency. | T01/T15 |
| F10 | `characterNarrativeContext` defaults to 12,000 total characters, 1,600 per field, smaller array items; `chunkDrafts` can use fallback offsets after transformations. | Straight reuse for complete authority or exact evidence would introduce hidden truncation or false provenance. | T04/T12 |
| F11 | Accepted-turn memory uses `Player action:` regardless of mode; chunk parsing recognizes that exact label. | Story Direction intent can be mislabeled. Merely renaming the label breaks the parser's split behavior. | T12 |
| F12 | `GenerationBaseIdentity` has campaign/state/narration identity but no explicit character-profile revision/hash. | Adding profile authority requires testing edits during queued/in-flight generation. An existing edit may already increment other revision fields; absence of an explicit field alone does not prove a race. | T03 regression and identity contract |

Additional constraints discovered:

- World arrays can contain 20,000 entities and 50,000 relationships, and their elements are `unknown`. Passing all records as protected context is unsafe and often impossible; shape adaptation and selective access are necessary.
- Character schemas are extensible (`passthrough`). A generic recursive serializer can carry private/mechanical extension fields unless the fiction boundary is deliberate.
- Corrections can deliberately set empty values. Corrections are complete authority at their effective base, not hints to merge with old generated state.
- Historical fact validity is half-open: `valid_from_turn <= cutoff` and `valid_until_turn IS NULL OR valid_until_turn > cutoff`.
- Facts visible only in a rejected draft, an omitted candidate, or arbitrary UUID-looking prose cannot authorize supersession.
- Provider request serialization, output feasibility, checkpoint binding and exactly-once commit are already substantial safeguards. Preserve them rather than replace the executor wholesale.
- Numeric trackers are filtered from fiction today. The repository requires a separate fiction/mechanics review before widening this boundary. A diegetic quantity should not be “fixed” by exposing all numeric mechanics.
- The architecture document's budget-growth section mentions a 1,000,000 maximum while current code supports a larger campaign maximum. Documentation must reference the exported constant instead of repeating a stale cap.

## 3. Research comparison and decisions

Research informs design choices; it does not establish Nexus-specific improvements. The adaptations below are engineering recommendations to test.

| Method and primary source | What the research supports | Nexus adaptation | Decision |
| --- | --- | --- | --- |
| Dynamic outline + temporal memory, [DOME](https://aclanthology.org/2025.naacl-long.63/) | Coupling evolving plans with memory and temporal conflict checking for long-form stories | Preserve validity and source time; consider a short, revisable scene plan and longer-range summary hierarchy | Temporal semantics now; outline/hierarchy experiments T24/T25. No required graph database |
| Plan/write/refine, [SuperWriter](https://aclanthology.org/2026.findings-acl.428/) | Structured planning and refinement can improve long-form generation in its evaluated setting | One evidence-grounded review, at most one semantic repair, strict cost and latency accounting | T16–T18; do not reproduce a many-call research pipeline |
| Consistency taxonomy, [ConStory-Bench / Lost in Stories](https://aclanthology.org/2026.findings-acl.410/) | Long stories need explicit consistency evaluation rather than general quality scores alone | Fixtures for entity attributes, relations, chronology, world rules and unresolved events; evidence-pair review | T15–T16; include false-positive cases |
| Contextual indexing + lexical/semantic retrieval + reranking, [Anthropic Contextual Retrieval](https://www.anthropic.com/engineering/contextual-retrieval) | Adding local context to indexed chunks and combining retrieval signals can improve retrieval on its datasets | Keep original source text; experiment with versioned context keys and reranking after fixing pool omissions | T22/T23. Existing PostgreSQL FTS is not BM25; no blanket performance claim |
| Indexing/retrieval/reading separation, [LongMemEval](https://arxiv.org/html/2410.10813v2) | Memory can fail at distinct stages; temporal updates and granularity matter; overcompression can lose useful information | Score evidence available, retrieved, sent and correctly used separately; retain original narrative alongside facts | T01/T15; motivates layered memory, not fact-only history |
| Context-position sensitivity, [Lost in the Middle](https://aclanthology.org/2024.tacl-1.9/) | Larger available windows do not guarantee reliable use of all positions | Test prompt ordering and salient authority placement, but maintain one measured serialization path | T11/T15 ablation; no universal “best” ordering claim |
| Temporal graph memory, [Zep](https://arxiv.org/html/2501.13956v1) | Separating temporal facts and provenance is a useful memory design | Reuse current scoped PostgreSQL validity/provenance before considering a new graph service | Defer infrastructure change; T09 and T24 cover needed near-term behavior |

Do not choose fine-tuning first. Training cannot recover facts that the request never supplies; it also introduces dataset ownership, evaluation, provider and lifecycle work beyond these fixes. Do not replace accepted narrative with progressively compressed summaries. Summaries are useful navigation aids but cannot be the only retained source of truth.

## 4. Target authority and memory architecture

### 4.1 Four distinct layers

| Layer | Contents | Authority and budget behavior |
| --- | --- | --- |
| Protected current authority | Pinned rules and world overview; effective selected character fiction profile; complete corrected/generated continuity; latest accepted effective narration; current-source canonical additions/updates with verified IDs | Complete within the existing accepted schema. If impossible to fit, recoverable shortfall. Never silently cut fields or fill with stale values |
| Selected authoritative reference records | Relevant world entities/relationships from the pinned world version; older active canonical facts from scoped projection | Selection is bounded and disclosed. Each selected fact/reference is complete within its defined fiction projection. No claim that unselected world/history was sent |
| Recent and retrieved evidence | Contiguous accepted recent turns; relevant older passages/whole records; optional summaries | Optional and budgeted. Narration is an outcome; action/direction is intent. Exact source identities and excerpt status required |
| Noncanonical proposals | Optional scene plan, review findings, rejected draft | Never accepted fact authority; never embedded as accepted history; never expands a supersession allowlist |

“Authoritative” describes the source, not an obligation to include its entire database. A selected world record can be authoritative while the selection of world records is optional. A historical event remains true as an event even when the current-state fact has changed.

### 4.2 Precedence

1. Enforced application protocol, owner/campaign/world scope and privacy boundaries.
2. Pinned world rules plus explicit approved current-state corrections. If a correction and immutable rule conflict, surface ambiguity; do not silently choose a retcon.
3. Effective campaign-owned character profile, then structured origin snapshot, then legacy guidance; preserve the existing resolver's precedence.
4. Accepted effective narration and accepted state at the generation base; newer valid updates supersede older current-state assertions.
5. Source-linked optional history, explicitly time-labeled. Old narration can describe a state that is no longer current.
6. Derived summaries and plans are navigation/proposals only, not overrides.

The current direction asks for a future outcome; it does not itself establish that the outcome already happened. Flashbacks, dreams, hypotheses, dialogue, deliberate deception and unreliable narration must be distinguished from narrator-level assertions. Do not add a policy that forbids normal fictional change.

This is not a universal last-writer-wins order for every field. A character's original clothing or equipment in their profile must not undo a later accepted change; personality guidance is not a claim that every later action conforms to it. Resolve dynamic attributes by their applicable source time and explicit correction semantics. An explicit profile edit that conflicts with accepted events needs a documented field-specific interpretation or an uncertainty notice, not an invented retcon. Add this distinction to both writer and reviewer fixtures.

### 4.2a Field-specific precedence decisions

T04 owns the projection/resolution tests; T07 owns matching writer instructions; T16 owns matching reviewer fixtures. The following defaults are part of the contract, not independent choices for each implementation:

| Field class | Resolution | Required example |
| --- | --- | --- |
| Stable identity and background | Use the effective campaign profile; preserve accepted historical references with their source time. An explicit edit conflicting with established history is flagged as ambiguous unless an approved correction resolves it | Renamed character retains correctly labeled earlier-name dialogue; conflicting origin is not silently retconned |
| Dynamic location, possessions, clothing and relationship status | Latest applicable accepted change or explicit state correction governs current state; an origin profile is not a reset | A lost sword is not restored by starting equipment; an accepted relocation beats an origin location |
| Personality, motivations, voice and preferences | Current profile guides portrayal; inconsistent behavior alone is not a factual contradiction | A normally cautious character can take a risk without automatic rejection |
| Explicit correction, including empty fields | Apply the exact correction at its effective base; never infer deletion reversal from older profile/history | Empty corrected threads stay empty |
| Immutable world rule versus approved correction/profile | Surface the conflict as uncertainty requiring an explicit user decision; do not invent a retcon | A changed biography cannot silently override a pinned world rule |

Field edits without explicit effective-time/retcon semantics do not rewrite accepted history. Both interfaces must explain recoverable ambiguity using safe categories and route users to existing intentional recovery actions, using discard -> edit -> new enqueue where the profile-save guard applies; they must not automatically choose an interpretation.

### 4.3 Capture and transaction boundary

- Resolve base identity and load complete protected authority in a short scoped transaction under existing campaign/state locks.
- Capture recent source records/revisions needed by the attempt without provider I/O. Use immutable source IDs plus effective-narration revisions/hashes.
- Release locks before embeddings, optional retrieval or generation.
- Optional retrieval stays at `throughTurnNumber=baseTurnNumber`; revalidate selected correction-sensitive evidence identities before binding the attempt. If source revisions changed, reload/replan under a bounded retry or mark stale safely.
- At commit, recheck authority dependency identity, including effective character authority. Reuse repository guarded-commit logic; do not commit using a context fingerprint alone.
- `replace_latest` uses `expectedTurnNumber - 1`; neither replaced narration nor its derived facts may leak into the new attempt.

## 5. Shared interfaces and policies

These are proposed contracts. T02 owns their definition and exports before consumers merge. Do not copy these as a second set of competing types in each package.

### 5.1 Typed private context

Create **new** `packages/application/src/memory/generation-context.ts`; export through the existing memory barrel. Replace open-ended `Record<string,unknown>` at the private generation seam incrementally, not across unrelated public APIs.

```ts
type SourceRef = Readonly<{
  kind: "world" | "character" | "state_edit" | "turn" | "canonical_fact" | "direction";
  id: string;
  revision: string;
  turnNumber: number | null;
  contentHash: string;
}>;

type StoryEvidence = Readonly<{
  id: string;                    // candidate identity, not necessarily a fact UUID
  source: SourceRef;
  semanticRole: "accepted_narration" | "player_intent" | "world_reference"
    | "world_rule" | "character_authority" | "corrected_state"
    | "current_continuity" | "canonical_fact" | "derived_summary";
  form: "complete" | "excerpt";
  content: string;
  spans: readonly Readonly<{ start: number; end: number }>[];
  canonicalFactId: string | null; // set only for a complete, validated fact
  rank: number;
  selectionGroup: "protected" | "direction" | "recent" | "world" | "historical_fact" | "retrieved";
  sourcePath: string;              // validated JSON Pointer into the scoped source
  normalizationVersion: string;
}>;
```

`SourceRef` is internal. Scope is enforced by a typed enclosing `GenerationContextSnapshot` containing `ownerUserId`, `campaignId`, `worldVersionId`, versioned base identity, protected authority and candidates. Source IDs alone do not grant authorization. Do not expose this private snapshot in public preview/polling.

Offsets use JavaScript UTF-16 indices into an explicitly normalized, fiction-safe source representation, identified by `contentHash` and normalization version. For `complete`, `spans=[]` is allowed. For `excerpt`, every span must be verified against that representation; multiple spans are rendered with explicit separators. No arbitrary computed fallback offsets.

Protected `currentContinuity` retains the existing `CampaignRuntimeStateContent` contract. Its canonical facts are the full explicit correction if one applies; otherwise the accepted base turn's combined plain/structured additions, with IDs resolved using the existing projection algorithm. Older active facts belong in optional evidence. This is not a new full-history canonical-fact list.

### 5.1a Complete evidence manifest

T02 defines one `GenerationEvidenceManifest` containing `version`, `attemptId`, `producingRequestHash`, `entries: readonly StoryEvidence[]`, `requiredReviewEvidenceIds`, and a canonical `manifestHash`. Every reviewable protected field and selected optional item has an entry; optional candidate IDs alone are insufficient. The current direction is attempt-local player intent, never historical authority. `sourcePath` uses validated JSON Pointer syntax and must resolve within its scoped source; it is not a filesystem path or authorization token.

Evidence IDs derive deterministically from source kind/ID/revision, source path, semantic role, normalization version and verified spans. Reordering entries cannot change identity. A source edit changes the revision/hash and therefore the affected evidence identity. Hash the canonical serialized manifest excluding its own hash. Exact quote checks operate on the entry's normalized content; field-level entries retain their enclosing source identity.

| Manifest entry | Example source path | Role and handling |
| --- | --- | --- |
| Pinned rule | `/world/rules` | `world_rule`, protected; complete fiction projection |
| Effective character relationship field | `/story/relationships` | `character_authority`, protected; T04 binds actual schema paths |
| Explicit corrected thread list | `/openThreads` | `corrected_state`, protected; empty list is represented explicitly, not omitted |
| Accepted current canonical fact | `/canonicalFactUpdates/0` | `canonical_fact`, protected; complete validated fact UUID when eligible |
| Direction segment | `/segments/2` | `player_intent`, attempt-local; exact full-direction offsets, no supersession authority |
| Retrieved narration excerpt | `/narration` | `accepted_narration`, optional; certified spans and normalization version |

These paths illustrate manifest shape; T02/T04 must provide executable serialized fixtures using the actual source schemas. Manifest entries include all safe authority that can support findings, including intentional empty values; empties support omission/context interpretation but cannot fabricate quotations. Private scratchpad handling follows section 7.1a. Candidate selection diagnostics and the manifest remain distinct: unsent candidates cannot be cited as supplied evidence.

### 5.2 Attempt-frozen policy

Define **new** `packages/contracts/src/story-memory-policy.ts` and its schema/tests. Add a snapshot inside generation job context options, not a runtime-only switch that changes in-flight work:

```ts
type StoryMemoryPolicy = Readonly<{
  version: "story-memory-v1";
  capability: "r1" | "r2" | "r3";
  queryPlanner: "balanced-v1";
  rankAggregation: "query_family_max_v1";
  recentTurnTarget: 1 | 3;           // includes existing protected latest turn
  recentResidualShare: 0 | 0.30;
  worldResidualShare: 0.15;
  excerptPolicy: "whole_only" | "verified_spans_v1";
  continuityReview: "off" | "observe" | "enforce";
  maximumSemanticRepairs: 1;
}>;
```

The constants are initial testable defaults, not tuned optima. R1 uses `whole_only` and review `off`; R2 enables verified spans only after tests/canaries; R3 starts `observe`. Keep configuration narrow initially: operator-controlled capability and explicit campaign enrollment through existing configuration patterns, not a large new user tuning UI. Missing policy on old jobs is **legacy behavior**, never implicit enrollment.

Freeze policy hash, protocol identities and effective provider configuration with the attempt. Existing campaign generation policy remains separate: story-only must still skip RPG/event stages. Review of story consistency is not an alias for legacy mechanics/scene coverage.

### 5.2a Capability, enrollment and rollback ownership

T02 owns server-side capability configuration, validation, the authorized campaign-enrollment operation, persistence classification and enqueue snapshotting. T14 owns both clients' display of effective status and recovery, not a client-controlled policy override. T20 owns operator commands/examples and downgrade checks. Reuse existing authenticated/server-resolved-owner configuration patterns; reject browser-supplied owner IDs and unsupported combinations.

| Capability | Recent target/share | World share | Excerpts | Review |
| --- | --- | --- | --- | --- |
| Legacy (missing snapshot) | Existing named legacy behavior | Existing behavior | Existing whole-record behavior | Off |
| R1 | 1 / 0 | 0.15 optional reference ceiling; no recent reservation | `whole_only` | `off` |
| R2 | 3 / 0.30 | 0.15 | `whole_only` or explicitly enabled `verified_spans_v1` | `off` |
| R3 | 3 / 0.30 | 0.15 | Same R2 choices | `off`, enrolled `observe`, or gate-approved `enforce` |

Validate this as a discriminated schema; do not merely allow each field independently. R1's existing planner must enforce its world-reference ceiling (T05 integration) without waiting for T11's extraction. Allocate unused optional capacity as described in section 6. New jobs resolve installed capability intersected with operator enablement and explicit campaign enrollment, then freeze the complete resolved policy and hash. Unenrolled campaigns use the named legacy path until explicitly enabled; installing code does not enroll them. Configuration/enrollment changes affect new jobs only. Queued/in-flight jobs retain their frozen policy; incompatible workers refuse them with a discard-and-reenqueue action rather than silently downgrade. Disabling enrollment does not change accepted state.

T02 must deliver tests for unauthorized enrollment, invalid combinations, concurrent enrollment/enqueue, unchanged queued jobs, safe disable/re-enable, older workers and old jobs. Document the exact configuration/API entry points selected during implementation in its handoff. Operational capability/enrollment is not implicitly portable campaign authority: T19 must verify destination defaults and explicit reenrollment after import.

### 5.3 Versions

- Proposed story prompt protocol: `story-v14-continuity-context`; context protocol: `current-continuity-v3`.
- Preserve `story-output-v2` unless T16's implementation actually changes writer output. The recommended checker is separate and does not require adding fields to accepted output.
- Proposed private checkpoint version: 3, with explicit memory-policy identity, source-manifest hash and optional review state.
- New jobs require compatible readers. Old v13/v2 jobs/checkpoints must keep a named legacy reader or be safely marked for discard-and-reenqueue; never silently reinterpret.
- Prompt override compatibility must be acknowledged under the new protocol. Preserve editable creative text; do not automatically rewrite user overrides.
- Allocate any new migration number at implementation time from the current migration sequence. Do not assume a number after 0094 is still available.

### 5.3a Prompt snapshot compatibility and ownership

The current `promptSnapshotSchema` derives required fields from all `promptTemplateKeySchema.options` and is strict. Adding review keys to that enum without changing snapshot readers invalidates old snapshots even when their checkpoint version is supported. T02 must separate the frozen legacy snapshot key set from the growing template catalog before T16 adds keys. Do not backfill old snapshots with current prompt text.

T02 defines an explicit reader union: existing unversioned legacy snapshots retain their exact historical key set; new snapshots use `{ version: 2, templates, continuityReview: null | { review, repair } }`. Each template entry retains exact `content`, `hash` and `source`; each new review/repair entry also records its protocol identity. `templates` preserves the existing story/other template set. Unknown fields, mismatched hashes and missing required enabled-mode entries fail explicitly. Export a single accessor/reader so runtime, retry, overrides and archive readers do not access the envelope inconsistently.

T16 owns the new template definitions, snapshot resolution in `packages/database/src/prompt-repository.ts`, enqueue integration in `generation-repository.ts`, and executor/accessor integration. Review `off` stores `continuityReview: null`; `observe` freezes both entries but dispatches only review; `enforce` freezes both and may dispatch the bounded repair. Snapshot both entries together whenever `continuityReview` is non-null so the schema has no partially present pair. Freeze their combined identity in the job policy/checkpoint. Template edits after enqueue affect only new jobs, including creative overrides; never resolve fresh template text during reclaim. T02's envelope reader lands before T16's keys/templates; R1/R2 new snapshots can use version 2 with `continuityReview: null` without depending on a reviewer implementation.

| Snapshot/job | Required reader behavior |
| --- | --- |
| Historical unversioned snapshot | Named legacy reader preserves original bytes/identity; normal protocol compatibility still decides resume versus explicit discard-and-reenqueue |
| Version 2, review off | Existing generation path, no reviewer requirements/calls |
| Version 2, observe/enforce, valid frozen pair | Use the captured content/hashes only; mode controls dispatch |
| Missing review pair for enabled mode, wrong hash or unknown version | Recoverable incompatibility; no implicit defaults or migration during reads |
| Template edited after enqueue | Queued/reclaimed job uses old captured pair; a new job uses the new pair |

T19 tests snapshot compatibility independently of checkpoint compatibility, including legacy retry, new off/observe/enforce jobs, malformed pairs, changed overrides and any System Archive paths that parse prompt snapshots/templates. Operational review snapshots remain excluded from portable campaign authority. Both interfaces show the same explicit discard-and-reenqueue action when a reader cannot safely resume.

### 5.4 Review result

Create **new** `packages/contracts/src/story-continuity-review.ts`:

```ts
type ContinuityCategory = "world_rule" | "character_attribute" | "relationship"
  | "chronology" | "location" | "object_state" | "thread_loss"
  | "direction_coverage" | "replacement_state";
type OutputLocation = Readonly<{
  path: string;                    // validated JSON Pointer into reviewable output
  start: number;                   // UTF-16 indices into normalized field text
  end: number;
  quote: string;
}>;
type ContinuityFinding = Readonly<{
  kind: "contradiction";
  category: ContinuityCategory;
  severity: "contradiction";
  basis: Readonly<{ kind: "source"; evidenceId: string; quote: string }>
    | Readonly<{ kind: "candidate"; draftHash: string; location: OutputLocation }>;
  output: OutputLocation;
  explanation: string;
}> | Readonly<{
  kind: "omission";
  category: "thread_loss" | "direction_coverage" | "replacement_state";
  severity: "warning";
  expectedEvidenceIds: readonly string[]; // nonempty bound-manifest references
  outputPath: string;              // field examined; no invented absent passage
  explanation: string;
}>;
type ContinuityReview = Readonly<{
  version: "story-continuity-review-v1";
  verdict: "pass" | "conflict" | "uncertain";
  findings: readonly ContinuityFinding[];
}>;
```

Initial limits: 20 findings, 1,000 characters per quote, 1,000 per explanation, at most 20 expected evidence IDs per omission, 20,000 total serialized characters. Runtime verifies references and quotes. A missing thread is not generally representable as a contradictory quote: report it as `warning` unless a positive contradictory draft passage exists. A checker must not invent an empty quotation as proof of an omission. A finding is evidence, not truth merely because a model emits it.

Contradiction quotes must be nonempty exact substrings. Omission warnings contain no draft offsets or quote and cannot alone produce a conflict verdict. For example, a contradiction cites a supplied fact and `/narration` passage that states the opposite; an omission cites an unresolved source thread and `/open_threads` without pretending that an absent thread has a quotation. Validate output paths against the actual review projection, not arbitrary JSON fields. T16 must test both examples, intentional empty corrections, malformed union combinations and a contradictory summary at `/continuity_summary` with otherwise correct narration. A claimed conflict with no valid contradiction becomes uncertain, never pass.

## 6. Budget, retrieval, and evidence algorithms

### 6.1 Protected context

Retain the existing exact-request budgeting discipline. Compute effective provider window from supported/requested configuration, reserve configured output, apply the same safety allowance once, and measure the final serialized provider body. The campaign context limit remains a separate ceiling. No post-measurement splice, field cap, or prompt rebuild.

Character fiction projection should include all known schema fields in `identity`, `story`, `appearance`, and `unclassifiedNotes`, after the reviewed fiction/mechanics boundary. Do not let `characterNarrativeContext`'s character caps silently become authority caps. Unknown extension keys require explicit fiction-key classification; initially omit unclassified extension keys with safe counts, not raw text. Legacy free text is sanitized but not prefix-clipped. If complete known narrative profile cannot fit, report component size and recovery action. Do not “fix” overflow by reducing output reserve.

Keep the latest accepted action/direction and narration distinguishable. Protect the latest narration as current scene; label direction/action as intent. Avoid duplicating latest text in the recent window or optional Chronicle.

### 6.2 World-reference selection

Build a pinned-world adapter over existing entity references and source JSON. Accept known object shapes (`id`/`key`, `name`/`title`/`label`, recognized narrative fields); do not stringify arbitrary unknown objects and call them canon. Relationships require resolvable endpoints or known textual identity fields. Unsupported entries remain retained in world storage and yield safe “unrecognized record” counts.

Seed selection from full sanitized direction, selected character IDs/aliases, latest scene and current open threads. Resolve ambiguous aliases without arbitrary identity assignment. Rank direct mentions first, then one-hop explicit relationships, then remaining relevant records. Default cap: 24 entity records plus 32 relationships before packing. Each selected record is complete within the adapter's defined fiction projection; an oversized record is omitted with a reason rather than cut mid-fact. Immutable overview/rules stay protected. Do not bring in every roster character; selected character authority is separate.

Selection is deterministic for identical pinned input and policy. The world quota is a ceiling/reservation for optional reference evidence, not permission to exceed provider limits. Semantic world-lore indexing is not required for R1; lexical/entity selection plus regression fixtures is the first baseline.

#### World adapter acceptance contract (T05)

T05 must commit a fixture-backed shape table before selector integration: supported stable identity (`id` or `key`), display identity (`name`, `title` or `label`), explicitly classified fiction fields and explicit relationship endpoints. Reuse existing world/entity schemas where they define a shape. Unknown fields and object shapes remain stored but are not generically serialized. Missing IDs may use a version-bound source-array path as source identity; this is not a new persistent entity UUID. Duplicate aliases produce a candidate set or an ambiguity reason, never an arbitrary identity choice. Tests must show each supported legacy shape, each rejected shape, normalization collisions and alias ambiguity. The T05 handoff names exact fields, not just “recognized narrative fields.”

### 6.3 Balanced queries

Preserve the full sanitized user direction in the writer request. Only retrieval queries are reduced.

Use deterministic segmentation first; the existing repository has sentence-splitting support, so no LLM query planner is required. Split paragraphs/sentences, keep offsets, resolve entity mentions over the **whole** direction, and choose up to four direction segments covering beginning, middle and end, favoring distinct named entities and explicit unresolved-thread matches. A 12,000-character direction cannot be guaranteed complete in four small queries; record uncovered-segment counts, and test salient late beats explicitly.

Create at most eight variants total: up to four action segments, one entity variant, one scene variant, one open-thread variant, and one explicit temporal variant if applicable. Initial per-variant cap remains 1,000–1,600 characters; total query text cap 8,000 characters. Reserve at least half each hint variant for that hint class; never prepend an unbounded direction. Deduplicate after construction while retaining distinct semantic coverage and entity IDs. Cache identity includes planner version, query kind, normalized text, provider/model and existing scope dimensions.

Temporal hints only constrain when explicit and unambiguous. Never reinterpret a fictional date as a database turn number. Always retain the generation cutoff independently of narrative time. Do not retrieve from future accepted turns even if a query requests them during replacement.

#### Query-family rank aggregation (T02/T08)

Balanced query expansion must not multiply a query family's voting weight. Under the new `query_family_max_v1` policy, compute ordinary weighted reciprocal-rank contributions, then for each candidate keep only the maximum contribution within each `(signal, queryKind)` family before summing across families. Four action segments therefore share one action-family contribution per signal; scene and thread families retain their own contributions. Distinct late-segment candidates still receive their full best action-family contribution. A missing candidate contributes zero. Stable ties use variant identity and candidate ID. Preserve per-variant provenance for diagnostics even when only one contribution wins.

T02 adds stable variant IDs (kind plus segment identity/query hash) to new contracts and versioned diagnostics. T08 implements the new aggregation in `packages/domain/src/chronicle-rank-fusion.ts` and its generation call sites; public preview and legacy policies retain the named legacy sum algorithm. Include aggregation policy in retrieval fingerprints/calibration identity, without unnecessarily invalidating reusable embedding vectors. Tests must compare one versus four identical action rank lists (same resulting family score), different late-beat candidates (still eligible), unrelated thread evidence (not demoted merely by query count), stable ties and unchanged legacy/public-preview results. T15 reports held-out evidence recall and final payload selection under this explicit policy.

### 6.4 Historical fact candidate pool

Replace recency-only prelimit with a scoped eligible set and union of bounded candidate lanes. Initial lane allowances divide the existing historical pool: 40% lexical, 25% entity, 15% explicit temporal/source targeting, 20% recent. Round deterministically and give unused lane capacity to relevance then recency. If temporal targeting is absent, redistribute its allowance rather than manufacturing a date filter.

Each lane applies owner/campaign/world and validity predicates **before** ranking. Lexical and entity lanes require a positive match. Use stable ties (`id`, source ordinal/index); deduplicate the union; retain lane ranks for existing rank fusion. Do not invent vectors for historical fact rows. Ensure named matched facts have a path into the pool even when more than 256 newer facts exist.

Use `EXPLAIN (ANALYZE, BUFFERS)` only on an isolated test dataset. First implement correct bounded SQL; add an additive index only if measured plans justify it. Avoid a new generated tsvector/index until write cost, language behavior and maintenance compatibility are tested. Existing English FTS remains a limitation to measure with multilingual fixtures, not an excuse to promise multilingual recall.

#### Historical entity-lane contract (T09)

Use existing explicit entity links when available and scope-valid. For facts without links, use deterministic whole-token/phrase matching against unambiguous normalized names/aliases; substring coincidence is insufficient. Ambiguous aliases may contribute lexical candidates but must not acquire an invented entity ID or entity-lane boost. Facts with no usable entity representation remain eligible for lexical/temporal/recent lanes. T09 records the actual schema/join paths and alias normalization rules; test explicit links, alias-only facts, duplicate names, Unicode boundaries, no links and lane deduplication. No inferred identity is written back during retrieval.

### 6.5 Recent-window packing

Target three contiguous accepted effective turns including the protected latest turn. Fetch the preceding two directly, rather than depending on retrieval ranking. After protected authority fits, allocate up to 30% of residual context to these preceding turns, newest first. Include whole sanitized turn records only in the initial recent lane. If the immediate predecessor cannot fit, stop expanding the contiguous lane; do not skip it and describe older selections as contiguous. Older records may still qualify as optional retrieved evidence.

World references receive up to 15% of residual context. Remaining residual goes to relevant history/facts. Unused reservations are borrowed by other optional groups. These are initial fairness rules; the exact serializer is the final authority, not arithmetic estimates of independently serialized blocks. The planner can remove optional blocks but never protected state. Record target count, included count and the first gap reason. At tiny budgets the valid outcome may be only the latest protected turn.

### 6.6 Excerpts

R2 permits excerpts only from optional narrative evidence, not current replacement fields, canonical facts, immutable rules or selected complete character authority. Excerpts must be exact sentence/paragraph spans of a versioned normalized fiction-safe source. Prefer a selected span plus one adjacent sentence on each side within quota; merge overlapping spans. Preserve negation, quoted speech context and speaker labels. If the source hash or substring validation fails, fall back to the complete parent if it fits; otherwise omit and report the reason.

Do not repurpose the existing potentially approximate chunk offsets as verified spans. Build a segment map from source to rendered evidence. Store normalized-source hash/version and spans in derived metadata or recreate deterministically from the parent; whichever is chosen, test round trips and source correction invalidation. Candidate source revisions and spans are private, while public diagnostics expose safe counts/IDs under existing policy.

### 6.7 Fact identities

Reuse `buildCanonicalChronicleFacts` for the accepted base's combined additions. Its structured-first ordering, deduplication and supersession union are part of persisted identity. Do not independently sort or renumber facts. Use scope/turn identity to derive the same IDs as commit/replay and check corresponding active projection rows when granting supersession authority.

For explicit corrections, preserve supplied IDs and intentional empties. Correction-created null IDs use the same correction projector identity, not the accepted-turn formula. Factor that identity function into a shared tested helper if needed. Never fabricate an ID for text that cannot be tied to retained source authority. Missing derived rows are a consistency/rebuild problem: carry source text without supersession authority or fail safely with a rebuild action according to the existing contract; do not write a replacement fact row during a read.

`sentCanonicalFactIds` must derive IDs from the actual producing request's typed complete fact entries, including supported recovery/provider wrappers. A candidate ID, source quotation or arbitrary UUID is insufficient. Recheck active/base validity at acceptance as today.

## 7. Continuity checking and durable recovery

### 7.1 Separate structural validity from semantic review

Always retain deterministic schema, mechanics, choices, event and supersession checks. Add the new review after a structurally valid draft and before acceptance. For legacy paths with event extension, review only the final assembled story after existing event/coverage stages; no unchecked appended passage may bypass an enforcing final gate. The new semantic reviewer has at most one initial review and one post-semantic-repair review per attempt; existing event coverage checks are separate operations with their existing durable allowances. Story-only still does not run RPG/event operations.

The reviewer receives fiction-safe authority, exact selected evidence, direction and the complete permitted candidate-output projection defined in section 7.1a. It does not receive arbitrary private mechanics, hidden reasoning, credentials or an entire unbounded campaign. Evidence quotes must be exact; source IDs must be from the bound evidence manifest. Missing required review input returns `uncertain`, not `pass`; deliberate optional-history omission is governed by section 7.1a.

Review modes:

| Mode | Provider failure/uncertainty | Conflict | Commit behavior |
| --- | --- | --- | --- |
| off | No call | Not evaluated | Existing safeguards only |
| observe | Record safe status; do not block or repair | Record evidence-validated findings | Existing safeguards decide acceptance; never claim review passed |
| enforce | Recoverable `continuity_review_unavailable` or `continuity_review_uncertain` | One bounded repair when eligible | Commit only a pass plus all existing guards |

Warnings alone do not fail a turn. A vanished thread is a warning unless evidence establishes an unresolved obligation and the draft contradicts it. Empty lists/summaries remain schema-valid and explicit saved corrections remain authoritative. Do not silently repopulate them.

### 7.1a Review scope, replacement state and pass semantics

A pass means no evidence-supported contradiction was established within the exact bound review scope; it is not a certificate about the entire campaign history. Required review input consists of all reviewable protected authority, the full allowed direction, the complete reviewable candidate output and the evidence selected into its producing request. Intentionally unselected historical candidates do not make an otherwise complete review uncertain. Missing/corrupt required entries, unresolved authority conflicts or unverifiable claimed contradictions do. Both interfaces must use wording such as “Passed checks against supplied context,” not “All history verified.”

T16 defines a typed `ReviewableStoryOutput` projection using the actual `StoryTurnOutput` field names: narration, continuity summary, open threads, canonical additions/updates and other accepted fiction-bearing fields. Findings address a field via `OutputLocation.path`, not offsets into arbitrary JSON serialization. Check that proposed replacement facts and summaries are supported by accepted authority plus the candidate narration; validate proposed supersessions through existing deterministic guards. A candidate's new narration can support its proposed state, but remains provisional and cannot grant source authority or new supersession IDs. Represent such internal consistency comparisons in a separately tagged candidate-output namespace bound to `draftHash`; never merge it into the source manifest/allowlist. T02 defines that reference union and T16 verifies both source and candidate references.

For each replacement field, test correct narration with an incorrect summary, invented canonical update, contradicted retained thread and unexplained thread omission. Positive contradictions may block; an unsupported new factual assertion without verifiable support yields uncertainty, while an omission without a positive contradictory passage yields a warning. Intentional saved empty corrections are not omissions to restore. Neither case authorizes automatic restoration. T15 must report these cases separately from narration errors and demonstrate next-turn replay consequences.

Private scratchpad is not sent wholesale to the reviewer. T16 defines an allowlisted fiction-only projection using the existing mechanics/privacy boundary; opaque internal reasoning and mechanics are excluded. Deterministic schema/privacy checks still cover the original field. Record excluded categories as safe counts and do not claim semantic verification of excluded content. The full original output remains checkpoint-bound by hash and goes through existing acceptance guards; review only sees the explicitly permitted projection. The same projection applies to semantic repair: retain every required reviewable field in full, while never copying hidden mechanics/reasoning into a fiction request. T18 must reject an unrepresentable required repair input rather than silently truncate it.

### 7.2 Repair state machine

Persist a new optional checkpoint stage with `policyHash`, `draftHash`, `evidenceManifestHash`, review protocol/provider identity, outcome and consumed-repair count. Bind review to the final story hash, not just main narration.

1. Draft passes existing shape/mechanics validation.
2. If enabled, review the bound draft and evidence.
3. On evidence-verified conflict in enforce mode, atomically reserve the single semantic repair before dispatch. Crashes cannot reset this allowance. Existing schema-repair allowances remain separately bounded and must not create a combined unbounded loop.
4. Build a self-contained repair request with unchanged protected authority and conflict-supporting evidence, complete permitted repair projection of rejected output marked untrusted (section 7.1a), and verified findings. Do not chain through `previous_response_id`.
5. Require a complete replacement `StoryTurnOutput` for the repair scope selected in section 7.2b. Persist the replacement and invalidate only its dependent checkpoints, preserving attempt-wide consumed allowances. Resume the exact event/coverage sequence in section 7.2b, then review the resulting final object once.
6. If still conflicting, invalid, over budget, timed out or uncertain: recoverable failure; no accepted turn or trigger increment.
7. Lease reclaim resumes compatible review/repair state; a changed draft or source manifest invalidates dependent review. Explicit user retry is a new bounded attempt, not hidden repeated automatic repair. Persist a logical attempt identity/reset boundary distinct from worker claim count: lease reclaim may increment the existing job attempts counter but must not replenish allowances.

Additional review/repair operations must be included in cost-operation enums, pricing/usage recording, exact serialized budget guards, safe public diagnostic allowlists, cancellation and checkpoint compatibility tests. Private findings follow private checkpoint retention and are excluded from portable campaign authority.

### 7.2a Repair evidence and illustration boundaries

T18 pins protected authority, the original direction and every evidence entry required to substantiate the triggering conflict. Replanning may remove only other optional entries. Recompute `sentCanonicalFactIds` from complete fact entries actually sent in the repair-producing request; removed facts lose permission even if they appeared in the original request. Bind the repaired output and final review to the new request hash/manifest, retaining the original attempt/conflict linkage privately. A conflict cannot disappear by dropping its source. If essential evidence and permitted rejected-output projection do not fit together, return recoverable overflow. Test both a removable historical fact and a conflict-supporting fact under tight budgets.

T17 owns the illustration dispatch restriction, before T18 begins. For frozen `observe` and `enforce` jobs, disable provisional image dispatch during text streaming and defer image-provider work until guarded story acceptance plus fiction-only prompt validation. Enqueuing the independent child job transactionally with acceptance is permitted; the image worker must observe committed accepted-turn identity before transport. In observe mode, a semantic conflict may still be accepted by existing safeguards and then illustrated; “rejected” means not accepted, not merely flagged by observation. T18 extends this already-working gate to bind repaired final narration/prompt identity; it does not introduce the initial gate. T19 owns cross-version/reclaim compatibility evidence.

| Frozen mode | Streaming/provisional behavior | Accepted artwork behavior |
| --- | --- | --- |
| Missing policy or review `off` | Preserve named existing behavior; no new claim that the old provisional path prevents all rejected-draft dispatch | Existing promotion/reconciliation and independent retry remain compatible |
| `observe` | No image-provider dispatch from unaccepted streamed text | Accepted result may enqueue artwork regardless of observed semantic verdict; review failure does not block story acceptance |
| `enforce` | No image-provider dispatch from unaccepted streamed or repaired text | Only the final accepted, passing result may enqueue artwork |

A frozen reviewed job containing an unexpected old provisional-set checkpoint is incompatible: prevent further image dispatch and require explicit discard-and-reenqueue; never relabel/adopt the set as reviewed output. Existing off/legacy jobs resume only under their original policy and existing promotion/orphan rules. Do not imply already dispatched provider work can be undone. T17 tests these cases and both interfaces hide invalid/rejected provisional artwork while showing actionable recovery.

Preserve separately configured image credentials, model and retry policy. Missing/unavailable image service or failed/retried illustration does not undo story acceptance or rerun text generation. Lease reclaim/repeated callbacks create at most one logical child dispatch; where an external response is ambiguous, report bounded retry behavior without claiming exactly-once external execution. Both interfaces must show accepted final narration and independent image pending/failed/retry states without resurrecting rejected text.

### 7.2b Event-aware semantic repair restart (T18)

Persist `semanticRepairScope`, original main/final draft hashes, logical attempt identity, and consumed allowance before dispatch. Choose `extension_only` only when every enforcing conflict can be isolated to the appended passage or extension-owned state and the validated main remains sound; otherwise choose `main`. Story-only always chooses `main` and never executes event/RPG stages. The repair input labels original main, final assembled output and findings separately; an old appended passage is rejected material, not an instruction to append it again.

| Repair scope | Durable replacement and invalidation | Required restart |
| --- | --- | --- |
| `main` | Store a new validated-main checkpoint with actual repair request/body/hash, provider response, source manifest and sent-fact allowlist. In the same guarded persistence step clear old `afterEvents`, extension/result/error state and all main-dependent coverage/review results. Preserve the original base-scoped RPG outcome and before/pending-event decisions only while their authority/input identity matches | Check before/pending event coverage against repaired main; rerun after-event evaluation against that main; build a fresh extension for newly due immediate events; verify whole-final and appended coverage; run the one post-repair semantic review; guarded commit |
| `extension_only` | Preserve validated main and matching before/after decisions. Replace the complete final object and extension checkpoint with the new producing request/body/hash, main hash and allowlist; invalidate extension-dependent coverage/review results | Require exact existing normalized-main prefix, nonempty appended passage and valid complete replacement state; rerun whole-final and appended event coverage; run the one post-repair semantic review; guarded commit |

For a main repair, ask for the replacement **main** output, not an already-extended final object. Discard the old appended fiction; recompute whether its events remain due. Do not append the previous extension blindly. The main draft becomes immutable at the subsequent extension boundary. If authority/base inputs changed, fail stale rather than rerolling or reevaluating against a different base within the same attempt.

Separate checkpoint-result invalidation from allowance consumption. T18 must retain a durable attempt-wide ledger for semantic, schema/mechanics, choice and existing before/final-event coverage repair allowances, including consumed counts whose old result hashes are invalidated. Define compatibility import from existing `automaticRepair`, `choiceRepair` and `eventCoverageRepair` fields without resetting any consumed allowance. The restart may use only unconsumed existing stage allowances; exhausting a stage causes recoverable failure. Exactly one semantic repair and at most two semantic review calls are permitted per logical attempt; malformed/uncertain review fails under enforce rather than opening another review-repair loop. Transport ambiguity may cause bounded duplicate dispatch as documented in section 12.2a, never fresh semantic allowance.

Commit must receive a mutually consistent validated-main checkpoint, final extension checkpoint (if present), event decisions, actual final-producing-request fact allowlist and matching final review. Reuse/extend the existing hash and exactly-once event guards; clearing an extension must never silently mark old after-events fulfilled or drop newly pending events. T18 owns executor orchestration, repository checkpoint validators, explicit-retry reset logic in `generation-repository.ts`, and commit guard changes together.

Required integration trajectory: initial main plus immediate extension -> final semantic conflict -> reserve repair -> persist repaired main and invalidate dependents -> reevaluate events -> fresh extension -> final coverage/review -> commit. Inject lease loss after each persistence boundary; assert no old extension reuse, no doubled event fiction, no lost pending events, one fulfillment per occurrence, no rerolled mechanics and no replenished allowance. Also test extension-only repair preserving the main prefix and failure before commit producing no accepted state changes.

## 8. Compatibility, privacy, and operational constraints

### Global constraints

- No production writes, campaign migrations, reindex runs or paid provider calls are authorized by this planning document alone. Implementation can create code/tests; execution against live data requires separate approval.
- Existing corrections, accepted turns, world versions and branch history remain authoritative. Never bulk-rewrite accepted narration to accommodate a new reader.
- Enforce owner, campaign, pinned world version, base turn and operation kind at every repository boundary. Test hostile IDs, wrong ownership, branches and future turns.
- Preserve intentional empty correction values. No truthy fallback or merge resurrecting stale summary, threads, facts or scratchpad.
- Scratchpad remains private. It may be in the permitted private generation flow; it must not enter embeddings, public preview, logs, SSE or archives as derived retrieval text.
- Keep raw query/action/narration/prompt/rejected output out of safe telemetry. IDs, hashes, versions, counts, ranks and fixed reason codes are sufficient.
- New persistence domains require `packages/application/src/system-archives/portability-registry.ts` classification. Checkpoints/reviews are operational; derived indexes are rebuildable; new accepted thread authority would be portable.
- Both `/story` and `/app/story` are active. Any new visible recovery action must work in both. Do not modify retired root `index.html` as a substitute.
- Retrieval outages degrade to existing scoped fallback without losing protected authority. Authority corruption or protected overflow does not degrade into partial generation.
- Do not widen numeric tracker exposure. If a later task needs diegetic quantities, first implement a separately reviewed typed fiction/mechanics contract.
- Do not change provider defaults, introduce a new hosted service, or re-embed all campaigns as an incidental effect.

### Evaluation artifact lifecycle (T15/T20)

Synthetic fixture artifacts may be retained in the repository only when sanitized and reviewed. Copied-campaign data, raw canary outputs, review quotes and repair proposals remain in a private operator-selected directory outside source control and public serving roots, with access restricted to the operator/current-owner review team. T15 requires a run manifest listing source authorization, copied destination, artifact paths, access policy and expiry. Default retention is 30 days after the report, adjustable only by an explicit operator choice; retain sanitized aggregate metrics longer. Do not write credentials/endpoints into artifacts.

T20 includes a cleanup inventory and dry-run command covering disposable databases/assets and private outputs, with exact target validation and operator authorization before deletion. Cleanup must never target authoritative source campaigns. Record completion or an explicit retained-until date in the release report. Operational checkpoint retention continues under its documented policy; copied evaluation artifacts do not inherit indefinite retention by accident.

### Required repository reading for implementers

Read current `AGENTS.md`, `CONTEXT.md`, `docs/architecture/repository-overview.md`, `docs/workflows/testing.md`, `docs/architecture/story-context-integrity.md`, `docs/architecture/story-only-campaign-policy.md`, ADRs 0018/0023/0037, `docs/architecture/scene-context-mechanics-review.md`, and `docs/runbooks/deployment.md`. Read any newer subtree instructions. Baseline assumptions must be rechecked against the actual branch before edits.

## 9. Work breakdown and dependency schedule

S = one small concern; M = one subsystem-sized review unit. These are scope indicators, not time promises. If a task needs two unrelated migrations or broad unrelated refactoring, split it before coding.

| Task | Size | Deliverable | Depends on |
| --- | --- | --- | --- |
| T01 | M | Baseline and real-wire regression fixture harness | None |
| T02 | M | Shared contracts, ADR amendment and compatibility readers | T01 |
| T03 | M | Character/source identity fencing | T02 |
| T04 | M | Complete selected-character fiction authority | T02, T03 |
| T05 | M | Pinned world-reference adapter and selection | T02 |
| T06 | M | Combined current facts with stable IDs/correction semantics | T02 |
| T07 | S | Prompt semantics and override compatibility | T04, T05, T06 |
| T08 | M | Balanced, versioned retrieval queries | T01, T02 |
| T09 | M | Multi-lane historical fact candidate SQL | T06, T08 |
| T10 | M | Direct recent effective-turn capture | T02, T03 |
| T11 | M | Single budgeted layered prompt planner | T04, T05, T06, T10 |
| T12 | M | Exact evidence spans and mode-aware source text | T02 |
| T13 | M | Verified optional excerpts in real generation | T11, T12 |
| T14 | M | Safe diagnostics and both-UI recovery support | T02; integrate each enabled feature |
| T15 | M | Private-payload and long-run continuity evaluator | T01; consume features as they land |
| T16 | M | Evidence-grounded continuity review contract/adapter | T07, T13, T15 |
| T17 | M | Durable observe/enforce review and pre-dispatch illustration gate | T03, T14, T16 |
| T18 | M | One durable semantic repair, event-stage restart and final artwork binding | T17 |
| T19 | M | Replay, copy, archive and upgrade compatibility matrix | T02; rerun for each release |
| T20 | S | Release report, copied-campaign canary and rollback runbook | Release-specific dependencies below |
| T21 | M | Read-only existing-campaign repair proposal tooling | T06, T15 |
| T22 | M | Contextual index experiment, no production enablement | R2 accepted |
| T23 | M | Bounded reranking experiment, no new vendor default | R2 accepted, T15 |
| T24 | M | Source-linked hierarchical memory prototype | R2 accepted, T15 |
| T25 | M | Optional scene-planning experiment | R3 accepted, T15 |
| T26 | M | Structured thread lifecycle compatibility prototype | R3 accepted, T19 |

T11 is required for R2, not a reason to delay R1. R1 may extend the existing planner with new protected fields and world candidates without recent reservations/excerpts. T14, T15, T19 and T20 are cross-release integration tasks: deliver their minimum R1 version, then update them, rather than waiting for all future tasks.

Suggested merge waves:

- Foundation: T01 → T02.
- Independent source work after contracts: T03/T04, T05, T06, T08. Coordinate overlapping authority/types files; no simultaneous uncoordinated edits.
- R1 integration: T07/T09 plus R1 T14/T15/T19 → T20.
- R2: T10/T12 → T11 → T13 → updated T14/T15/T19 → T20.
- R3: T16 → T17 → T18 → updated T14/T15/T19 → T20.
- Optional: T21 separately approved; T22–T26 are independent experiments with explicit promote/reject decisions.

The agent owning T02 is the interface coordinator. The agent owning T11 is the only owner of planner extraction. The agent owning T17/T18 controls executor orchestration changes. A future orchestrator may delegate non-overlapping tasks, but this document does not itself authorize concurrent agents or production operations.

## 10. Implementation task cards

### Shared completion checklist for every task

- [ ] Read dependencies and relevant repository instructions; verify the baseline and dirty worktree.
- [ ] Add the specified failing regression(s) first. Run them and record the expected failure; a skipped integration test is not a passing regression.
- [ ] Implement only the task's contract. Preserve legacy readers and unrelated changes.
- [ ] Run focused tests, then relevant dependent tests. Record command, exit status and test counts.
- [ ] Review privacy, scope, temporal cutoff, intentional empties and budget implications.
- [ ] Update affected architecture/runbook documentation and provide a concise handoff with changed files, tests, limitations and next dependency.
- [ ] Commit only when the implementation session authorizes commits; never deploy or rebuild production as part of task completion.

### T01 — Establish a reproducible baseline at the actual provider boundary

**Fixes:** F9 and the inability to distinguish missing storage, missing retrieval, missing final context and model disregard.

**Files:** Extend `tests/unit/generation-executor-adapter.test.ts`, existing provider-request tests and `tests/integration/story-continuity-remediation.integration.test.ts`. Add **new** `tests/fixtures/story-continuity/scenarios.ts` and **new** `tests/integration/story-context-payload.integration.test.ts`.

**Work:**

- [ ] Build fixtures for a structured-only base fact, edited character, sibling world entity/relationship, late direction beat, an old exact fact after 300 newer facts, corrected narration and an intentionally empty correction.
- [ ] Capture the prepared serialized request from the fake provider boundary used by the real executor; do not reconstruct a prompt with the preview API.
- [ ] Store fixture oracle IDs/expected source snippets separately from candidate output. No production campaign data.
- [ ] Add negative cases for wrong owner/world, future turn, rejected draft UUID and omitted fact UUID.
- [ ] Produce a baseline report of which assertions fail on the pinned commit. Keep known-failure probes separate from the normal passing suite until the owning fix lands; do not commit a permanently red CI suite.

**Acceptance:** Each F1–F5 fixture demonstrates the missing input or candidate independently. A passing public preview cannot satisfy a final-payload assertion. Exact body hash is observable without publishing raw real story text.

**Run:** `pnpm exec vitest run tests/unit/generation-executor-adapter.test.ts`; focused integration command in section 12 with the new payload test. **Handoff:** fixtures, boundary hook and measured baseline—not claimed live-model quality.

### T02 — Freeze shared contracts and amend the architecture intentionally

**Fixes:** Untyped private context, accidental protocol drift and unsafe reinterpretation of old work.

**Files:** New `packages/application/src/memory/generation-context.ts`; modify `packages/application/src/memory/types.ts`, `ports.ts` and barrel; new `packages/contracts/src/story-memory-policy.ts`; relevant contract barrel; `packages/contracts/src/generation.ts`, `packages/contracts/src/prompt-library.ts`, `packages/database/src/prompt-repository.ts` and current snapshot-reader consumers; `docs/architecture/story-context-integrity.md`; new `tests/unit/story-memory-policy.test.ts`.

**Work:**

- [ ] Define section 5 contracts with Zod for persisted/untrusted boundaries and readonly TypeScript types internally.
- [ ] Version query-variant contracts for repeated action segments and optional temporal hints; update finite kind enums, cache serialization and diagnostic readers together. Retain the legacy four-kind reader for historical records.
- [ ] Add explicit context/protocol identity readers; old jobs remain named legacy rather than defaulting to new behavior.
- [ ] Define selection reason enums: selected, context_limit, request_limit, recent_gap, unsupported_world_shape, source_revision_changed, unverifiable_excerpt, duplicate_source. Add only relevant values to public allowlists later.
- [ ] Amend whole-record architecture: protected state remains complete; optional verified narrative excerpts become allowed only under the versioned policy. Document bounded world selection and current-source versus historical facts.
- [ ] Keep output shape v2 and full-replacement semantics. Define checkpoint v3 envelope with optional review fields, but do not enable review yet.
- [ ] Tests reject invalid quotas, unknown review modes, malformed source manifests, inconsistent hashes and unrecognized new protocol without a recovery action.

- [ ] Implement sections 5.1a/5.2a and 7.1a contracts: complete protected/optional evidence manifest, source-versus-candidate reference union, field-addressed findings, omission variant, capability schema and authorized enrollment/snapshotting. Publish serialized positive/negative fixtures before dependent tasks merge.
- [ ] Inventory affected configuration/API/persistence files using current enrollment/settings patterns; list exact paths and exported contracts in the handoff, including server authorization and operational portability classification. Test the capability table rather than enabling unsupported R2 settings in R1.

- [ ] Define stable query-variant identity and the `query_family_max_v1` aggregation policy contract for T08; preserve named legacy sum behavior.
- [ ] Implement section 5.3a's frozen legacy-key snapshot reader and version-2 envelope/accessor in `packages/contracts/src/prompt-library.ts`; wire existing snapshot consumers through the reader. Add old-snapshot compatibility fixtures before T16 extends the template catalog. Do not derive historical required keys from a mutable enum.

**Acceptance:** A downstream agent can import one canonical interface; no duplicate per-layer authority type. Reading a v2 checkpoint either works in its legacy path or gives a safe explicit incompatibility—never silent migration.

**Run:** new unit test plus `tests/unit/generation-authority.test.ts`, `tests/unit/provider-request-budget.test.ts`, `pnpm check`. **Handoff:** exported names, serialized examples and version compatibility table.

### T03 — Fence newly included character and source dependencies

**Fixes:** F12 and potential stale context when new authority dependencies are introduced.

**Files:** `packages/database/src/generation-authority.ts`, `generation-repository.ts`, `generation-execution-repository.ts`, `campaign-transfer-character-repository.ts` guard regressions, private memory scope types; `tests/unit/generation-authority.test.ts`; existing generation repository/execution integration tests.

**Work:**

- [ ] Locate the current character-profile save path with `rg -n "character_profile_revision" packages services`; prove whether it increments campaign state identity. Do not assume either outcome.
- [ ] Preserve the existing `campaign-transfer-character-repository.ts` profile-save guard: normal API edits during queued, active or recoverable generation return `invalid_transition` and do not change profile/revision. Add API/repository regressions for each state; do not relax the guard to manufacture a race.
- [ ] Separately test defensive identity fencing with a deliberately injected profile/revision change after enqueue or capture in an isolated DB fixture (or a fake authority reader for the unit case). Loading/committing stale authority must fail recoverably. Label this an out-of-band stale-data fixture, not a supported concurrent profile-edit workflow.
- [ ] Extend versioned base identity with effective character profile revision and content fingerprint (including legacy snapshot fallback). Freeze at enqueue, compare at authority load and commit.
- [ ] Add source-manifest validation for newly used recent effective narrations. Reuse existing revision fences where sufficient; no redundant table if current revisions cover the dependency.
- [ ] Exercise append, replace_latest, base zero, profile edit/revert, narration correction, lease reclaim and world version migration.
- [ ] Preserve short transactions and no provider calls while locks are held.

- [ ] Verify recovery through the supported sequence: discard incompatible/recoverable generation, save the profile with its expected revision, then enqueue new work from current authority. T14 implements this sequence in both interfaces; neither an active job edit nor retry of an obsolete authority snapshot is the recovery path.

**Acceptance:** Stale attempts fail recoverably; unchanged retries reuse matching identity. An edit unrelated to used authority does not cause uncontrolled re-generation loops. Tests show exactly which revision guards each dependency.

**Run:** authority unit test; focused `generation-repository.integration.test.ts` and `generation-execution-repository.integration.test.ts`. **Handoff:** identity field map, compatibility reader and concurrency test results.

### T04 — Supply the complete effective selected-character fiction profile

**Fixes:** F2 and the character truncation portion of F10.

**Files:** `packages/database/src/chronicle-generation-context.ts`; `packages/domain/src/world-characters.ts`; new `packages/domain/src/character-fiction-authority.ts`; `services/runtime/src/generation-executor-adapter.ts`; `tests/unit/character-profiles.test.ts`; payload integration tests.

**Work:**

- [ ] Select campaign `character_profile`, `character_snapshot` and revision under the scoped authority query.
- [ ] Reuse `effectiveCampaignCharacter` precedence, but implement a separate complete fiction projection rather than changing the bounded public helper's existing behavior.
- [ ] Classify known profile fields; strip mechanics through the existing safety boundary without truncating accepted fiction. Unknown passthrough keys are not automatically safe.
- [ ] Include profile authority in the protected serialized block and component diagnostics. Null/no-profile legacy cases remain supported.
- [ ] Test a key relationship beyond character 1,600 and a known field beyond total 12,000: it is present in a fitting private request or the request fails explicitly for protected overflow.
- [ ] Verify profile-only edits appear next turn even with Chronicle disabled/stale. Public preview stays sanitized and does not expose scratchpad.

- [ ] Implement section 4.2a field-specific precedence fixtures and export the same interpretation to writer/reviewer consumers; a profile edit is not automatic historical retcon.

**Acceptance:** Name, identity, narrative guidance and relevant appearance fields from effective profile are present once, not overridden by roster origin. No embedded character mechanics or credentials. Overflow never becomes an apparently complete partial profile.

**Run:** character unit test, authority unit test, real-wire payload integration test. **Handoff:** fiction field allowlist and overflow examples.

### T05 — Retrieve relevant records from the pinned world bible

**Fixes:** F1 without trying to pin tens of thousands of records.

**Files:** New `packages/domain/src/world-fiction-reference.ts`; existing `entity-references.ts`; `packages/database/src/chronicle-generation-context.ts`; private context types; new `tests/unit/world-fiction-reference.test.ts`; payload integration tests.

**Work:**

- [ ] Adapt supported entity/relationship shapes from pinned world JSON; map stable source identity without rewriting world data.
- [ ] Use full direction, current scene, selected character aliases and open-thread mentions as deterministic selection seeds.
- [ ] Implement direct mention → one-hop explicit relationships → other relevance ranking with section 6 caps and stable ties.
- [ ] Keep immutable world overview/rules protected. Supply selected complete fiction records as typed optional reference evidence with source hash/version.
- [ ] Test same-name ambiguity, alias matching, unsupported relationship shape, missing endpoints, unrelated NPC exclusion, oversized record and maximum-sized world arrays.
- [ ] Prevent current mutable draft world or another campaign/world version from contributing references.

- [ ] Deliver the section 6.2 fixture-backed supported-shape/alias table and R1 world-budget ceiling integration in the existing planner. Add selected world entries to the complete source manifest, not only optional selection counts.

**Acceptance:** A relationship defined only in a sibling world array reaches the actual fitting request when directly relevant; unrelated roster does not flood it. Selection omissions are visible as safe counts. No new model call or DB schema needed.

**Run:** new world-reference unit test and payload integration test. **Handoff:** supported legacy shapes, deliberately unsupported fields, complexity/bounds and fixtures.

### T06 — Materialize current canonical additions and updates with stable identity

**Fixes:** F3 while retaining the existing correction/replay contracts.

**Files:** `packages/database/src/campaign-continuity-repository.ts`, `chronicle-generation-context.ts`, `chronicle-state-correction-repository.ts`; `packages/domain/src/chronicle-memory-helpers.ts`, `canonical-facts.ts`; existing continuity, canonical-facts, mixed-canonical-facts and remediation tests.

**Work:**

- [ ] Separate accepted-turn materialization (requires campaign/turn identity) from correction materialization (exact full snapshot). Do not make a generic snapshot parser guess its origin.
- [ ] Combine plain additions and structured updates through `buildCanonicalChronicleFacts`, preserving structured-first indexes and duplicate supersession union.
- [ ] Resolve IDs consistently with commit/replay. Factor correction-null-ID derivation into a shared helper if necessary; do not substitute the accepted-turn ID scheme.
- [ ] Validate source/projection agreement and active validity at the cutoff. Source text may remain available when a derived index is missing, but unsupported supersession IDs must not be granted.
- [ ] Verify the final request's allowlist includes sent complete current facts, excludes omitted/inactive/unrelated facts and cannot be expanded by a rejected draft.
- [ ] Test structured-only, plain-only, duplicate normalized text, multiple superseded IDs, initial import, empty correction, correction removal, branch ID remap and replay determinism.

**Acceptance:** An accepted structured update is visible with the same valid UUID on the next turn; earlier active history is not all added to protected state. Explicit empty correction wins over accepted facts. Reads do not mutate/rebuild derived tables.

**Run:** `tests/unit/campaign-continuity-repository.test.ts`, `tests/unit/canonical-facts.test.ts`; `tests/integration/mixed-canonical-facts.integration.test.ts`, `story-continuity-remediation.integration.test.ts`.

### T07 — Make prompt semantics agree with persistence

**Fixes:** Ambiguous full-replacement versus new-fact instructions and failure to distinguish directions from outcomes.

**Files:** `packages/contracts/src/story-prompt.ts`, `prompt-library.ts`; `packages/story-engine/src/prompt.ts`, `story-only-prompt.ts`, `provider-request.ts`; prompt-library/story-only tests.

**Work:**

- [ ] Clearly state that continuity summary, scratchpad and open threads are complete replacements; canonical fact fields describe the current turn's additions/structured updates, not an instruction to repeat all historical facts.
- [ ] Explain source precedence, time-labeled history, explicit correction empties and source-limited supersession.
- [ ] Label player intent, accepted narration, selected world records and optional excerpts distinctly. Explicitly mark omitted history as unknown, not nonexistent.
- [ ] Increment proposed protocol versions through shared constants. Update built-in prompts and compatibility notices; preserve user creative overrides and require acknowledgement where needed.
- [ ] Test all supported provider wrappers/recovery paths use the same mandatory contract, including story-only choice repair.

- [ ] Apply section 4.2a precedence and section 7.1a scoped-pass semantics consistently; mandatory protocol text must not promise exhaustive historical verification or allow candidate facts to grant their own authority.

**Acceptance:** No built-in instruction contradicts the persisted semantics. Empty full replacement is permitted, not silently defaulted. The model is never told that a plan or requested action already happened.

**Run:** prompt-library, story-only-prompt, story-only-output and provider-request-budget unit tests; story-only generation/choice-repair integration tests.

### T08 — Preserve late beats and retrieval hints in query planning

**Fixes:** F4.

**Files:** `packages/domain/src/chronicle-query-plan.ts`, `chronicle-rank-fusion.ts`; `tests/unit/chronicle-rank-fusion.test.ts`; retrieval/cache call sites in `packages/database/src/chronicle-context-repository.ts`, `chronicle-query-cache-repository.ts`; query planner and query-cache tests.

**Work:**

- [ ] Add regressions with a distinctive named entity and unresolved event only after character 4,000 and near the end of a maximum-length direction.
- [ ] Implement section 6 balanced segments and hint quotas. Entity matching scans full sanitized direction before per-query truncation.
- [ ] Keep query count/text/provider requests bounded; batch embedding variants through current capabilities where supported.
- [ ] Add planner version to cache identity and safe diagnostics. Distinct suffix segments must not hit an old prefix-only cache entry.
- [ ] Preserve deterministic deduplication without discarding distinct hint coverage; test multilingual text, long single sentence, repetitive direction, prompt-like malicious history and no hints.
- [ ] Route the new policy explicitly for generation. Keep existing public-preview calibration on its named policy until separately recalibrated; a shared function change must not silently change both contracts.
- [ ] Ensure writer request still contains the full allowed direction; this task changes retrieval, not user intent.

- [ ] Implement section 6.3 query-family maximum aggregation behind `rankAggregation: query_family_max_v1`, stable per-variant IDs and retrieval fingerprint versioning. Run one-versus-four action-list regressions, late-only candidate and thread-balance tests, then unchanged legacy/public-preview fixtures; do not inherit four votes for the action family.

**Acceptance:** Long-direction fixture emits at least one query containing the late entity/beat and distinct scene/thread hints where present. No unbounded provider fan-out; zero cross-scope cache reuse.

**Run:** `tests/unit/chronicle-query-plan.test.ts`; `tests/integration/chronicle-query-cache.integration.test.ts`; existing chunk-retrieval suite.

### T09 — Let older relevant facts reach the ranker

**Fixes:** F5.

**Files:** `packages/database/src/chronicle-context-repository.ts`; new `tests/integration/chronicle-historical-fact-pool.integration.test.ts`; existing chunk-retrieval/budget-growth tests; additive migration only if justified by measured query plans.

**Work:**

- [ ] Seed at least 300 newer distractor facts plus an old exact-match fact and an entity-linked fact at the 32k baseline; prove old recency-only limiting excludes them.
- [ ] Implement eligible CTE and bounded lane union from section 6; retain fixed limits and stable order.
- [ ] Test active validity at before/after supersession cutoffs, correction-created facts, future replacement leakage, empty query and lane exhaustion.
- [ ] Feed individual canonical UUIDs into rank fusion; never grouped memory IDs or synthetic vector IDs.
- [ ] Compare query plans and p95 retrieval time on fixed isolated 1k/10k/100k-fact datasets; record environment and indexes. Add an index only on demonstrated need.
- [ ] Preserve public-preview calibration unless intentionally versioned; document generation-specific behavior.

- [ ] Implement the section 6.4 explicit-link/alias/no-link entity-lane contract and record exact joins, normalization rules and ambiguity behavior; test absence of entity metadata without losing lexical recall.

**Acceptance:** Old relevant facts are candidates before fusion, not merely theoretically rankable. Candidate bound holds at large budgets; cross-owner/world and inactive-at-cutoff facts are absent. Existing historical ID allowlist tests still pass.

**Run:** new PG test, chunk-retrieval and generation-budget-growth integration tests; unit retrieval-profile/diversity tests. **Handoff:** SQL rationale, EXPLAIN evidence and migration decision.

### T10 — Capture a real recent effective-turn window

**Fixes:** F7.

**Files:** `packages/database/src/chronicle-generation-context.ts`, `generation-authority.ts`; private memory ports/types; new `tests/integration/generation-recent-window.integration.test.ts`.

**Work:**

- [ ] Load the preceding two accepted effective turns directly with source IDs, turn numbers, correction revisions and input mode; latest remains in protected current scene.
- [ ] Use append/replacement base, not campaign latest indiscriminately. Never include the turn being replaced.
- [ ] Bind revisions/hashes through T03; fetch under short snapshot transaction and release before providers.
- [ ] Label action/direction as intent; apply the fiction boundary without arbitrary clipping.
- [ ] Test no history, one/two/many turns, corrected predecessor, missing ordinal, branch, unavailable Chronicle and huge predecessor.

**Acceptance:** Recent-window candidates exist independently of embeddings/index readiness. They are not yet an unlimited protected block; T11 controls fit. Source revision changes invalidate unsafe reuse.

**Run:** new recent-window PG test plus authority and turn-immutability tests.

### T11 — Introduce layered packing without weakening exact budgets

**Fixes:** Recent evidence crowding, duplicate context and inability to account for each layer.

**Files:** Extract existing planner into **new** `services/runtime/src/generation-context-planner.ts`; update `generation-executor-adapter.ts`; extend `packages/story-engine/src/context-budget.ts` only where necessary; new `tests/unit/generation-context-planner.test.ts`; existing budget tests.

**Work:**

- [ ] Preserve the current serialization-and-send path in an extraction regression before changing policy. Do not refactor unrelated executor stages.
- [ ] Implement protected-first planning, recent/world reservations, borrowing and optional relevance selection from section 6.
- [ ] Deduplicate same turn/fact/source across protected, recent and retrieved lanes. Preserve chronological rendering within narrative evidence and explicit source labels.
- [ ] Measure each candidate addition using the actual complete serialized body; keep output reserve and safety allowance applied once.
- [ ] Record estimated component costs and selected/omitted source manifests. Protected overflow names safe component categories, not story text.
- [ ] Exercise 8k/32k/128k and configured maximum limits with synthetic bodies, non-ASCII text, large summaries, 500 threads and long profiles. A synthetic maximum-window test is not a claim the configured live provider supports it.

**Acceptance:** Identical input produces identical selection and wire bytes; no post-budget splice. Most-recent optional turns get their bounded opportunity before distant history. Tiny budgets fail safely or omit optional layers; protected authority is never truncated.

**Run:** new planner unit test, context-budget, provider-request-budget, story-token-estimate, executor tests and generation-budget-growth integration.

### T12 — Make source segments exact and preserve input mode

**Fixes:** F10 provenance and F11 labeling.

**Files:** `packages/domain/src/chronicle-memory-helpers.ts`, `chronicle-chunking.ts`; new `packages/domain/src/story-evidence-spans.ts`; `packages/database/src/chronicle-repository.ts`, `chronicle-chunk-repository.ts`; `services/runtime/src/chronicle-chunk-worker-execution.ts`; chunking/worker tests.

**Work:**

- [ ] Define normalized fiction-source representation and segment mapping with exact hash/version. Verify every emitted span by substring reconstruction.
- [ ] Remove reliance on fallback computed offsets for evidence proof. Existing chunks can remain retrievable but are not automatically certified as exact spans.
- [ ] Make turn-memory rendering input-mode aware. Update chunk parsing for old `Player action:` and new Story Direction labels; keep historical reader.
- [ ] Version parent/source normalization and processed signatures so derived refresh can be scoped and resumed. Do not synchronously re-embed all campaigns during deployment.
- [ ] Test repeated sentences, NFKC expansion, CRLF, emoji/surrogates, sanitization removals, overlap, long unbroken tokens and old memory labels.
- [ ] Classify any added derived columns/metadata in portability registry; retained source turns remain unchanged.

**Acceptance:** Every certified excerpt reconstructs exactly from its hashed source representation; otherwise it is not certified. Changing only labels does not silently change chunk kind or lose narration. Existing indexes fall back safely while rebuilt by approved jobs.

**Run:** chronicle-helpers, chunking and chunk-worker unit tests; chunk-repository and turn-immutability integration tests.

### T13 — Use verified narrative excerpts in private generation

**Fixes:** F6.

**Files:** `packages/database/src/chronicle-context-repository.ts`; `services/runtime/src/generation-context-planner.ts`; `generation-executor-adapter.ts` fact allowlist handling; chunk-retrieval and payload integration tests.

**Work:**

- [ ] Carry selected chunk/parent provenance across retrieval instead of reducing selection to a parent-ID filter.
- [ ] Reconstruct exact bounded source spans with adjacent context and merge overlaps. Do not trust preview's compressed text as private evidence.
- [ ] Prefer complete parents when economical; use certified excerpts when whole parent cannot fit or is materially wasteful under the enabled policy.
- [ ] Prohibit excerpts of current state, rules, protected profile and canonical facts. A fact candidate grants supersession only when complete and sent.
- [ ] Test useful middle-of-long-parent evidence, negation at boundary, quoted misleading dialogue, corrected source, stale chunk hash and no certified span fallback.
- [ ] Ensure repair/review receive the same bound evidence set and exact measured request behavior.

**Acceptance:** The long-parent fixture now sends the relevant passage with exact provenance inside budget. A stale or unverifiable excerpt is never mislabeled as complete authority. Public preview remains separate and safe.

**Run:** chunk-retrieval, payload and provider-request-budget tests; supersession allowlist negatives.

### T14 — Explain context omissions and recovery safely in both UIs

**Fixes:** Invisible context loss and unsafe debugging temptation.

**Files:** `packages/contracts/src/story-prompt.ts` (strict public diagnostic code/operation/field schema and code-to-action mapping), `packages/contracts/src/generation.ts`, `packages/contracts/src/client-api.ts`; `services/api/src/generation-diagnostics.ts` (logging only), `services/api/src/server.ts` (public polling/SSE projection); `packages/database/src/campaign-state-repository.ts` (reload/sync projection); `packages/client-core/src/generation/projection.ts` (shared action guidance); runtime context diagnostic projection; `apps/web/src/story.js`, `apps/web/src/story-generation-monitor.js`, `apps/web/src/story-state-editor.js`, `apps/web/public/story.html`, `apps/web/public/story.css`; `apps/web-next/src/story-player-generation.ts`, `apps/web-next/src/story-player-view.ts`, `apps/web-next/src/story-player-tools.ts`, `apps/web-next/src/story-player-illustrations.ts`, `apps/web-next/src/story-player.css`; shared client contracts/adapters as required; `tests/unit/generation-diagnostics.test.ts`; `tests/e2e/generation-integrity-diagnostics.e2e.test.ts`.

**Work:**

- [ ] R1: expose safe component counts, protocol/policy identity, query variant count and fixed reason codes; distinguish “missing authority” from “optional evidence omitted”.
- [ ] R2: add recent target/included counts, optional world/reference counts, complete/excerpt counts and source-validation failures.
- [ ] R3: show review off/observed/passed/conflict/uncertain/unavailable and whether automatic repair was consumed. Do not imply a pass when review was skipped or failed.
- [ ] Offer only valid existing actions: adjust budget/provider/output configuration, retry compatible work, or discard-and-reenqueue incompatible work. For blocked profile edits, explicitly sequence discard -> intentional revision-checked edit -> enqueue anew; never imply the profile can be edited while a queued/active/recoverable job remains. Preserve the unsent direction through this flow in both clients. No button silently restores old facts.
- [ ] Keep raw findings/quotes/private prompt out of public polling and SSE. Authorized source inspection, if desired later, is a separate reviewed API.
- [ ] Verify desktop and 390×844 rendering in `/story` and `/app/story`, loading states, old diagnostic records, unknown code fallback and accessibility.

- [ ] Implement every applicable row below in both active interfaces, reusing shared typed diagnostics/action eligibility through client-core/client-web while retaining each UI's presentation. A shared server change or one updated client does not complete T14.

| Release/flow | Legacy `/story` implementation | New `/app/story` implementation | Paired browser assertion |
| --- | --- | --- | --- |
| R1 authority/overflow/ambiguity | Monitor/status and valid recovery navigation | Generation status and valid tools/recovery navigation | Same safe reason/action; blocked profile recovery discards, edits, then enqueues; private content absent |
| R1 capability/protocol incompatibility | Effective status and discard/reenqueue or override acknowledgement | Equivalent status and recovery controls | Old records/unknown codes safe; no silent enrollment or downgrade |
| R2 history omission/excerpts | Safe counts and first recent gap explanation | Equivalent counts and explanation | No claim all history was included; no private excerpts displayed |
| R3 review and repair | Off/observed/scoped-pass/conflict/uncertain/unavailable, consumed-repair state | Equivalent review and repair state | No pass label after skipped/failed review; omission warning alone does not block |
| R3 independent artwork | Accepted final text with image pending/failure/retry; no provisional artwork for reviewed jobs | Equivalent accepted text/image behavior | Observe/enforce dispatch gate is already implemented in T17; image retry makes no text job; rejected text/artwork never reappears |
| All releases recovery/reconnect | Existing reload/cancel/retry/edit flow and draft preservation | Equivalent flow and draft preservation | Server-authoritative status after reload, SSE reconnect and switching interfaces |

- [ ] Parameterize/extend `tests/e2e/generation-integrity-diagnostics.e2e.test.ts` for both routes and add mode-specific cases to `tests/e2e/story-only-campaigns.e2e.test.ts` and `tests/e2e/story-only-new-ui.e2e.test.ts`. Use the same disposable campaign/job fixtures and test append plus latest-turn replacement where applicable.
- [ ] Capture desktop and 390×844 screenshots for both interfaces for each changed visible state, with keyboard focus, accessible status announcements, enabled/disabled recovery actions and post-action result assertions. Record route, viewport, scenario and screenshot path in the release report. Neither UI may redirect to the other as a substitute for implementation; retired root `index.html` is out of scope.

- [ ] Update `generationDiagnosticOperationSchema`, `diagnosticActionByCode`, `safeGenerationDiagnosticSchema` and `projectSafeGenerationDiagnostic` together in `story-prompt.ts`; define validated safe fields for the new counts/statuses. Unknown/malformed values continue to fail closed; do not bypass the schema to expose review internals.
- [ ] Add contract/projection regressions demonstrating each new reason survives runtime recovery metadata -> API polling -> SSE -> campaign sync/reload -> client-core -> both interfaces with the same code, action and safe counts. Assert private canary text is absent, unknown-code fallback remains usable, and retry eligibility matches the server.
- [ ] Extend `tests/unit/generation.test.ts`, `tests/unit/generation-diagnostics.test.ts`, `tests/unit/client-core/generation-workflow.test.ts` and relevant polling/SSE tests; run paired browser cases for profile discard/edit/reenqueue and prompt incompatibility, not merely message rendering.

**Acceptance:** A user can tell why generation stopped or history was omitted without exposing hidden state. Old clients/readers degrade safely. No endpoint or raw provider error leaks.

**Run:** diagnostics unit tests and both-UI e2e test with recorded screenshots. Apply frontend-testing skill during execution if required by available environment.

### T15 — Evaluate the complete memory-to-generation pipeline

**Fixes:** F9 and misleading retrieval-only success metrics.

**Files:** Keep `scripts/lib/chronicle-retrieval-evaluator.ts` for retrieval calibration; add **new** `scripts/evaluate-story-continuity.ts`, **new** `scripts/lib/story-continuity-evaluator.ts`, **new** `tests/unit/story-continuity-evaluator.test.ts`; T01 fixtures; package script `evaluate:story-continuity`.

**Work:**

- [ ] Build four independent scores: source available, candidate retrieved, evidence actually sent, and accepted output consistent. Track source identity, not keyword coincidence alone.
- [ ] Drive the real executor with a capturing fake provider for deterministic tests; integrate real PostgreSQL fixture reads separately from live-model runs.
- [ ] Add the section 12 scenario matrix, including accepted chains where earlier model mistakes could propagate. Run both teacher-forced fixed histories and rollout histories; do not conflate them.
- [ ] Live mode requires explicit `--live`, provider/campaign-copy selection, maximum calls and token/cost ceiling. Default mode must not call a paid provider or touch production.
- [ ] Pin model/provider settings and scenario version; run repeated samples and paired ablations. Keep blinded human adjudication for conflicts and writing quality.
- [ ] Report missing-evidence errors separately from evidence-present-but-ignored errors, contradiction precision/recall, false blocks, thread continuity, latency, usage and repair rate.

- [ ] Add field-level replacement-state scoring and next-turn replay cases; separate narration contradictions, unsupported proposed state, omission warnings and excluded private fields.
- [ ] Implement the private-artifact manifest/retention controls in section 8 and the preregistered denominators/interval rules in section 12.3a. Do not pool observe-only, repaired and baseline outputs into a single quality rate.

**Acceptance:** Improving public preview alone cannot improve the private-payload score. A bogus LLM judge finding with a fabricated quote is rejected. Failed/skipped/uncertain runs do not count as passes. Full raw fixture outputs stay in non-production artifacts, not ordinary telemetry.

**Run:** new unit test; real-wire integration fixture; `pnpm evaluate:story-continuity -- --mode deterministic` after adding the script. Live execution remains separately approved.

### T16 — Implement an evidence-grounded continuity reviewer, initially disconnected

**Fixes:** F8 detection, without prematurely changing acceptance.

**Files:** New contracts file from section 5; **new** `packages/story-engine/src/continuity-review.ts`; **new** `services/runtime/src/story-continuity-review-adapter.ts`; `packages/contracts/src/prompt-library.ts`, `packages/database/src/prompt-repository.ts`, `packages/database/src/generation-repository.ts` and executor snapshot accessors; **new** `tests/unit/story-continuity-review.test.ts`.

**Work:**

- [ ] Implement strict result schema, finding limits and exact source/draft quote validation. Unknown IDs, out-of-range offsets and mismatched quotations invalidate the finding.
- [ ] If a claimed conflict loses its evidence during validation, classify the review as uncertain; do not drop invalid findings and convert the remaining empty list into a pass. A declared pass with contradictory findings is invalid.
- [ ] Build fiction-safe review input from the exact final evidence manifest; no fresh unconstrained retrieval or hidden private state.
- [ ] Prompt for short observable conflict explanations, not chain-of-thought. Separate direct contradictions from ambiguity and possible omissions.
- [ ] Test genuine wrong-name/relationship/time/object-state contradictions, legitimate evolution, flashback, dream, quoted lie, requested retcon conflict, unresolved thread omission and intentional empty correction.
- [ ] Add exact serialized budget guard for reviewer request; if full required evidence cannot fit, return uncertain/unavailable rather than silently reviewing a smaller world and calling it pass.
- [ ] Keep provider adapter selectable through existing text-provider configuration; no new mandatory vendor. Offline fake responses cover parser behavior.

- [ ] Verify all protected evidence classes, direction segments and optional entries are addressable under section 5.1a; test omission warnings without fake quotes and candidate-output references without source-authority escalation.
- [ ] Implement section 7.1a projection and field-level consistency checks. Test ordinary omitted optional history can still yield a scoped pass, while missing required evidence or contradictory proposed state cannot.
- [ ] Share section 4.2a precedence fixtures with T04/T07, including dynamic equipment/location, renamed identity, personality exceptions and explicit correction conflicts.

- [ ] Add review/repair catalog entries only through section 5.3a's versioned snapshot path. Freeze exact pair content, hashes and protocol identities at enqueue; test queued/reclaimed work remains unchanged after template/override edits.
- [ ] Extend `tests/unit/prompt-library.test.ts` and `tests/integration/prompt-library.integration.test.ts` for legacy, version-2 off, valid observe/enforce pairs, missing pair, tampered hash and unknown version. Hand off frozen snapshot examples to T17/T19; live review dispatch remains disconnected until T17.

**Acceptance:** Only evidence-validated findings survive. The reviewer cannot establish facts or supersession authority and is not wired into commits yet. Validation precision is measured by T15 before enforcing use.

**Run:** new review unit tests, `tests/unit/prompt-library.test.ts`, focused `tests/integration/prompt-library.integration.test.ts` with the integration configuration, provider budget tests. **Handoff:** positive/negative labeled corpus and observed reviewer limitations.

### T17 — Wire review into durable jobs with observe/enforce modes

**Fixes:** F8 runtime path, retries and crashes.

**Files:** `services/runtime/src/generation-executor-adapter.ts`, new review adapter; `packages/database/src/generation-execution-repository.ts`, `generation-repository.ts`; generation contracts and cost-operation enums; new `tests/integration/story-continuity-review.integration.test.ts`.

**Work:**

- [ ] Freeze review mode in enqueued policy; persisted jobs never change mode after a deployment/config edit.
- [ ] Add checkpoint review state bound to draft, evidence, protocol and provider identities. Persist compatible results; invalidate when any dependency changes.
- [ ] Observe mode records safe outcome without changing acceptance. Enforce mode requires pass and fails recoverably on unavailable/uncertain/conflict until T18 repair is installed.
- [ ] Place the final gate after any event extension/whole-main rewrite. Story-only remains separate from legacy event/scene stages.
- [ ] Add cost operations, call counts, timeouts, cancellation and lease handling. No open DB transaction during review.
- [ ] Test crash before/after review persistence, reclaim, stale lease, changed profile/correction, duplicate callback and commit exactly once.

- [ ] Implement section 7.2a dispatch gating now: frozen observe/enforce jobs must not create provider-dispatchable provisional image work during streaming. Add red/green tests for unaccepted drafts, accepted observe conflicts, enforce failures, mode-off compatibility and unexpected old provisional checkpoints. T17 must pass independently before T18 starts; update both T14 clients for the changed pending-artwork/recovery behavior.

- [ ] Bind review input/checkpoints to the frozen review prompt identity from T16; never fetch a newer prompt during execution. Complete initial review and illustration-gate recovery tests without depending on semantic repair.

**Acceptance:** Reclaim does not accidentally skip an enforcing review or reuse one for a different final story. Observe mode failure never claims semantic success. Enforcement is disabled by default pending release gate.

**Run:** new review PG test, story-only generation integration, existing execution-repository and event integrity suites.

### T18 — Add one self-contained semantic repair with durable consumption

**Fixes:** Recoverable contradictions without unbounded calls or partial-state acceptance.

**Files:** Executor/review adapter, provider-request support, checkpoint contracts; `packages/database/src/generation-execution-repository.ts` (checkpoint validators and commit guards), `packages/database/src/generation-repository.ts` (explicit retry/reset); new `tests/integration/story-continuity-repair.integration.test.ts`; provider budget tests.

**Work:**

- [ ] Persist repair allowance consumption before provider dispatch using the existing lease/attempt guard.
- [ ] Send original protected authority and the complete permitted repair projection of rejected output marked untrusted (section 7.1a), plus validated findings. Never use rejected draft facts to broaden visible IDs.
- [ ] Implement section 7.2b scope-specific restart. Persist the new validated main or extension plus its producing request; invalidate dependent results atomically while preserving attempt-wide allowances; rerun the required event/coverage stages before the single post-repair final review.
- [ ] Bound all automatic interactions: one semantic repair; existing schema-repair bounds remain persisted; semantic repair cannot recursively reopen itself.
- [ ] Handle repair request overflow through section 7.2a: retain required conflict evidence and the complete permitted repair projection; replan only dispensable optional evidence with a fresh manifest and supersession allowlist, otherwise return recoverable overflow.
- [ ] Test repaired pass, repeated conflict, invalid output, timeout, crash before dispatch/after response, lease reclaim, explicit retry and event extension that introduces a new contradiction.

- [ ] Implement section 7.2a evidence retention and actual repair-request supersession allowlist tests; dropping the conflict source must fail safely, not manufacture a passing re-review.
- [ ] Bind illustration dispatch to the accepted repaired output and validate the image prompt independently. Test reclaim, duplicate callbacks, unavailable image provider and image-only retry without another text generation.

- [ ] Add the durable logical-attempt allowance ledger and versioned old-checkpoint reader/reset rules described in section 7.2b. Lease reclaim must not reset counts merely because `job.attempts` increments; explicit user retry alone starts a fresh logical attempt.
- [ ] Test the complete repaired-main -> after-event reevaluation -> new extension -> final review -> reclaim -> commit trajectory and extension-only prefix preservation. Assert exact pending/fulfilled events and retained counters, not only narration validity. Keep the T17 image gate intact and bind its accepted artwork to the repaired final hash.

**Acceptance:** No turn/state/event changes on failed repair. One accepted final object has matching producing request, evidence, review and commit hash. Additional calls and usage are accurately attributed.

**Run:** new repair PG test, review PG test, provider-request-budget and executor unit tests.

### T19 — Prove replay, portability and old/new compatibility

**Fixes:** Regressions that would only appear after branching, restore or deployment.

**Files:** `packages/application/src/system-archives/portability-registry.ts`; affected campaign/system archive adapters only as needed; existing `canonical-fact-reference-remapping.ts`; tests for mixed facts, source-campaign portability, story-only portability/system portability, generation execution and imports.

**Work:**

- [ ] Inventory changed persisted domains for each release. Avoid archive format changes if only operational/derived metadata changed; if authoritative shape changes later, version archives and readers explicitly.
- [ ] Round-trip campaign archive and system archive into isolated empty destinations; verify next-generation profile/correction/fact authority matches source semantics after ID remapping.
- [ ] Test branch before/after fact supersession, transfer, latest-turn replacement and world version migration. No origin campaign IDs in destination supersession references.
- [ ] Rebuild derived facts/chunks from retained accepted snapshots/corrections in chronological order; compare identities and validity intervals, not just counts.
- [ ] Test legacy checkpoint reader or incompatibility action, new checkpoint read, old diagnostics, prompt overrides and missing policy snapshots.
- [ ] Assert operational review payloads, raw prompts, endpoints and credentials are excluded from portable authority and public exports.

- [ ] Verify accepted repaired narration/image identity after retry, branch and archive round-trip; no rejected draft image/text may reappear in either interface.
- [ ] Verify operator capability/enrollment does not silently transfer on import and queued jobs retain frozen policies across configuration changes. Include the paired legacy/new interface matrix from T14 in each release's compatibility report.

- [ ] Run the section 5.3a prompt-snapshot compatibility matrix separately from checkpoint-version cases: historical key set, version-2 off, enabled frozen pair, catalog growth, edited overrides, tampering and explicit safe recovery. Inspect archive consumers of prompt templates/snapshots as well as queued/reclaimed jobs.
- [ ] Verify old off-mode provisional jobs retain named legacy behavior while reviewed jobs never adopt old provisional sets; both interfaces show the same incompatibility and discard/reenqueue flow.

**Acceptance:** Imported/branched campaigns can generate the next turn with correct current authority. Rebuild does not resurrect explicitly deleted facts/threads. New data domains cannot evade schema-inventory classification tests.

**Run:** focused portability/import/copy tests, then full `pnpm test:integration` and `pnpm check`. **Handoff:** compatibility matrix with actual passes/failures and unresolved release blockers.

### T20 — Release in controlled stages and retain a safe rollback

**Fixes:** Operational risk and unsupported claims of quality improvement.

**Files:** `docs/runbooks/deployment.md`, `docs/architecture/story-context-integrity.md`, new versioned release report under `docs/review/`; configuration examples only if new capability settings exist.

**Prerequisites:** R1 requires T01–T09 plus R1 T14/T15/T19. R2 requires T10–T13 plus updated T14/T15/T19. R3 requires T16–T18 plus updated T14/T15/T19. A release report must enumerate exactly which tasks are included.

**Work:**

- [ ] Correct stale budget documentation using current exported constants; document new fixed reason codes and policy defaults.
- [ ] Produce dry-run migration/protocol compatibility assessment; classify whether mixed workers are safe. New checkpoint/policy consumers require stopped intake and zero incompatible worker leases.
- [ ] Prepare copied-campaign canaries: short, long, corrected, character-edited, event-heavy, imported, branched and multilingual. Use 32k and a genuinely supported larger window.
- [ ] Record deterministic suite, PG suite, both-UI evidence, actual provider usage, latency and human-adjudicated continuity results.
- [ ] R3: observe first; enforce only after false-positive gate. Do not enable across all campaigns by default.
- [ ] Rollback: stop intake, drain/cancel incompatible jobs deliberately, preserve additive schema/accepted history, disable new optional policy for new jobs, retain compatible reader. No down migration or state deletion to start an old worker.

- [ ] Apply section 12.3a's release-specific gate matrix; produce separate readiness decisions for R1, R2, R3 observe and R3 enforce. Missing browser proof for either active interface blocks that release's compatibility gate.
- [ ] Publish exact capability/enrollment/rollback commands from T02 and verify the queued/new-job distinction. Include the private artifact inventory, retention deadline and authorized cleanup procedure from section 8.

**Acceptance:** Section 12 gates pass or release is explicitly blocked. Deployment and paid canaries require separate operator approval. This task can be completed as a release-ready packet without deploying.

### T21 — Prepare source-linked repair proposals for damaged existing campaigns

**Fixes:** Prior omissions that prevention cannot undo.

**Files:** New `scripts/propose-continuity-repair.ts`; source readers from campaign state/effective narration; new fixture/unit tests; documentation under the existing continuity repair runbook section.

**Work:**

- [ ] Default to read-only, explicitly scoped campaign and base revision; require authorized access. Do not add an automatic apply mode in this task.
- [ ] Compare current state with retained accepted snapshots, effective narration and explicit corrections. Identify candidate omissions with source turn/revision, current value, proposed value, confidence/ambiguity and later overrides.
- [ ] Treat latest explicit correction as intentional even when empty. Do not propose restoring a fact that was subsequently superseded/deleted.
- [ ] Use deterministic source extraction first. If optional model-assisted summarization is later authorized, every proposed statement still needs verified retained evidence.
- [ ] Output a private review artifact with revision guard and exact existing API action for approved application; do not embed it or change state.
- [ ] Test lost source, ambiguous conflict, intentional deletion, source correction and stale approval. Missing evidence is marked unrecoverable, never invented.

**Acceptance:** Reviewer can approve or reject each proposal independently. Actual repair uses existing revision-checked state edit API under separate authorization, then a separately approved derived rebuild. The proposal tool itself performs zero writes.

## 11. Optional experiment task cards

These tasks have bounded prototype deliverables and explicit decisions. They do not authorize production architecture changes merely because a paper used a technique. Keep them behind disabled experiment code paths or an isolated evaluator; do not delay confirmed defect repairs.

### T22 — Contextual indexing experiment

**Question:** Does adding source-grounded context to index keys improve recall beyond corrected queries and candidate pools?

**Files:** New evaluator-only `scripts/lib/experiments/contextual-story-index.ts`; T15 fixtures; use existing chunking/embedding ports. Production worker changes are outside this prototype.

- [ ] Build deterministic prefix keys containing turn ordinal, known entity IDs/names and source type; keep original narrative value unchanged.
- [ ] Optionally test model-generated contextual prefixes only with explicitly approved live evaluation. Prefixes are derived, source-bound, and never rendered as canonical facts.
- [ ] Include prefix policy, source hash, model and normalization version in experimental index identity.
- [ ] Compare corrected baseline, deterministic context keys and model-generated keys on the same held-out fixtures; report indexing calls/cost, recall and final evidence inclusion.
- [ ] Simulate source edits and prove stale context keys become ineligible.

**Acceptance:** A reproducible experiment report recommends reject, retain experimental, or promote with a separately scoped worker/migration plan. Promotion requires meaningful held-out recall improvement with no leakage and acceptable reindex cost. No production vectors are rewritten.

### T23 — Bounded reranking experiment

**Question:** Does a reranker improve useful evidence per prompt token after pool correctness is fixed?

**Files:** New evaluator-only `scripts/lib/experiments/story-evidence-reranker.ts`; new unit tests; T15 evaluator. No new default provider dependency.

- [ ] Define port `rerank(query, candidates, limit, signal)` returning existing candidate IDs and finite scores only; it cannot create facts/text.
- [ ] Rerank at most 32 optional candidates after fusion, never protected/recent guarantees. Use existing configured text provider only in explicitly approved live mode, or a deterministic fake for mechanics tests.
- [ ] Enforce deadline, one call, input budget and cancellation; timeout/invalid IDs/duplicate scores fall back deterministically to existing ranking.
- [ ] Compare baseline and reranked final payload, not just reranker scores. Measure evidence recall, contradiction rate, latency and token cost on held-out scenarios.

**Acceptance:** Zero scope changes or fact-ID invention; fallback identical to baseline. Promotion requires measured quality gain beyond T09/T13 and a separate configuration/privacy review if a new provider would receive story text.

### T24 — Hierarchical, source-linked memory prototype

**Question:** Can scene/arc summaries help far-history recall without recursive summary drift?

**Files:** New evaluator-only `scripts/lib/experiments/story-memory-hierarchy.ts`; T15 scenario corpus. Do not add production tables in the prototype.

- [ ] Group accepted turns deterministically into windows for evaluation, retaining source IDs/ranges and correction hashes. Test both fixed windows and explicit scene boundaries if available.
- [ ] Produce summaries only from retained accepted source, never summaries-of-summaries without source links. Preserve unresolved references and temporal state explicitly.
- [ ] Retrieve a summary to select source turns, then send verified source evidence where possible. Label any sent summary as derived.
- [ ] Invalidate affected summaries when source narration/correction changes; never use future turns for replacement/branch history.
- [ ] Compare raw/chunk baseline, one-level summaries and two-level hierarchy across 50/100/200-turn fixtures.

**Acceptance:** Report fact omission/hallucination, retrieval and final-output quality; summary-only access cannot count as source-grounded success. No graph service or authoritative schema change is needed to evaluate this idea.

### T25 — One optional scene-plan experiment

**Question:** Does a small provisional plan improve long Story Direction coverage after context is correct?

**Files:** New evaluator-only `scripts/lib/experiments/story-scene-plan.ts`; T15 runner; use existing text-provider interface.

- [ ] Schema: at most six beat proposals, each referencing supplied evidence IDs and relevant direction segment IDs; bounded 4,000 characters total.
- [ ] Mark all beats as proposed future events, not accepted history. No generated plan enters canonical facts, scratchpad authority or embeddings automatically.
- [ ] Run one planning call and one writer call; compare with no-plan baseline using identical source context and token/call accounting.
- [ ] Include directions that change course, resolve a thread, introduce a surprise and leave an outcome open. A rigid plan must not override user control.
- [ ] Feed final output through the R3 review and measure both coverage and creativity/quality via blinded review.

**Acceptance:** Promotion requires improved direction coverage without increased unsupported outcomes or excessive latency. Planning remains optional and attempt-bound; production integration would need its own durable stage task rather than a process-local pre-call.

### T26 — Structured thread lifecycle compatibility prototype

**Question:** Do stable thread IDs and explicit resolution transitions justify a future accepted-state protocol change?

**Files:** New ADR under `docs/architecture/` with next available number; evaluator-only `scripts/lib/experiments/story-thread-lifecycle.ts`; migration/portability contract fixtures, not live migration.

- [ ] Prototype `{id, text, status:open|resolved|abandoned, introducedAt, changedAt, sourceRefs}` alongside the existing string list; do not infer historical resolution merely from omission.
- [ ] Define exact semantics for user deletion, generated resolution, rewording, duplicate threads, merge/split and intentional empty replacement.
- [ ] Provide conversion fixtures from legacy strings, including deterministic source-bound IDs and unresolved ambiguity; no arbitrary backfilled narrative claims.
- [ ] Specify archive versioning, branches/transfers/ID remapping, replay, correction precedence and UI editing requirements. Compare full structured replacement with patch-based alternatives explicitly.
- [ ] Evaluate whether IDs reduce false thread-loss warnings and improve long-run retention in the offline harness.

**Acceptance:** Deliver a tested compatibility prototype and accept/reject ADR recommendation. Do not change accepted output or deploy a patch protocol from this task. If approved, a separate implementation plan must split schema/migration, writer protocol, correction UI, commit/replay and portability work into bounded tasks.

## 12. Verification, release gates, and implementation handoff

### 12.1 Required scenario matrix

| Scenario | Required assertion |
| --- | --- |
| Structured-only base fact | Actual next request includes combined fact and valid identity |
| Character edit with long relationship field | New effective character is sent whole or explicit overflow; stale draft cannot commit |
| World sibling lore | Relevant entity and relationship are selected from pinned world, not mutable draft |
| Late multi-beat direction | Late beat is represented in retrieval query coverage and full writer direction |
| 300+ newer distractor facts | Old exact/entity match enters candidate pool at 32k |
| Supersession before/after cutoff | Correct half-open validity; no inactive current fact or future replacement leakage |
| Explicit empty correction | Empty values remain empty; no merge restores old state |
| Chronicle offline/stale | Protected profile/state/latest turn and direct recent candidates still load |
| Very long parent | Relevant exact excerpt fits or safe omission; no fabricated offsets |
| Recent oversized predecessor | No false claim of contiguous history; protected state not clipped |
| Quoted lie, dream, flashback | Reviewer does not equate dialogue/hypothesis with narrator assertion |
| Legitimate change/resolved thread | No blanket rejection for changed attributes or empty thread list |
| Lost unresolved thread | Warning/source evidence captured; no silent restoration |
| Malicious retrieved instructions | History remains data; cannot alter protocol, scope, tools or allowlist |
| Rejected draft with valid-looking UUID | Does not grant supersession authority |
| Review/repair crash and reclaim | Persisted bounded allowance; review bound to exact final draft |
| Immediate event extension | Final appended story cannot bypass review/enforcement |
| Branch/transfer/archive/import | Equivalent current authority, remapped fact IDs and no future history |
| Multilingual/unusual Unicode | Stable segmentation/spans and conservative budgeting; limitations reported |
| 50/100/200-turn trajectories | Separate source/retrieval/payload/use failure rates, including accumulating errors |

Additional mandatory scenarios from this plan review:

| Scenario | Required assertion | Owner |
| --- | --- | --- |
| Protected rule/profile/correction and direction evidence | Stable addressable manifest entries; unknown/unsent IDs rejected | T02/T16 |
| Missing thread with no contradictory passage | Valid omission warning without fabricated draft quote; intentional empty correction respected | T16 |
| Correct narration, wrong proposed summary/fact/thread | Field-addressed finding; next-turn replay cannot hide the error | T15/T16/T18 |
| Optional history excluded versus required evidence missing | First can receive scoped pass; second becomes uncertain | T16/T17 |
| Repair budget removes a fact | Conflict source retained; removable fact loses supersession permission in actual repair request | T18 |
| Rejected draft, repaired draft and independent artwork | Observe/enforce gate works before semantic repair; accepted final binding, legacy-mode compatibility and image-only retry | T17/T18/T19 |
| Capability toggle during enqueue and active work | Authorized new jobs snapshot valid combinations; queued work unchanged | T02/T19 |
| Both interfaces on the same campaign | Equivalent diagnostics/actions after reload/reconnect, with desktop/mobile screenshots | T14/T20 |
| Evaluation expiry and cleanup dry run | Private inventory complete; no source campaign or unrelated asset targeted | T15/T20 |
| Dynamic profile fields and ambiguous aliases | No origin-state restoration, historical retcon or invented entity identity | T04/T05/T09 |


Follow-up repository-conflict regression matrix:

| Scenario | Required assertion | Owner |
| --- | --- | --- |
| Normal profile edit with queued/active/recoverable job | Existing invalid-transition guard holds; no profile/revision mutation | T03 |
| Injected out-of-band profile change | Stale authority cannot load/commit; clearly separate from normal API workflow | T03 |
| Profile recovery in both interfaces | Discard -> revision-checked edit -> new enqueue, preserving unsent direction | T14 |
| New diagnostic through polling/SSE/sync | Strict schema preserves approved code/action/counts; both clients agree and private text remains absent | T14 |
| Four action query variants | Best-per-family contribution prevents fourfold voting; late-only evidence remains eligible and legacy scores unchanged | T08/T15 |
| Template catalog grows after legacy jobs exist | Historical snapshot reads without new required keys; incompatibility is explicit where protocol prevents resume | T02/T16/T19 |
| Review template edited after enqueue | Reclaim uses captured bytes/hashes; new jobs use edited pair | T16/T17 |
| Observe/enforce streaming before repair exists | No unaccepted image-provider dispatch; off/legacy path remains separately tested | T17 |
| Semantic main repair with immediate/deferred events | Fresh event decisions/extension and matching commit hashes; no duplicate/lost fulfillment or reset allowance on reclaim | T18 |
| Semantic extension-only repair | Main prefix immutable; final coverage and review bind the replacement extension | T18 |

### 12.2 Commands and test safety

Use repository-pinned Node/pnpm versions. Do not run integration/evaluation migrations against production or a shared authoritative database. Follow `docs/workflows/testing.md` for the isolated test database.

```bash
pnpm exec vitest run tests/unit/chronicle-query-plan.test.ts
pnpm exec vitest run tests/unit/campaign-continuity-repository.test.ts
pnpm exec vitest run --config vitest.integration.config.ts tests/integration/story-continuity-remediation.integration.test.ts
pnpm test:unit
pnpm test:integration
pnpm check
pnpm build
git diff --check
```

New test names in the cards become runnable only when their owning task creates them. The focused integration configuration is mandatory: ordinary Vitest invocation can skip DB tests when `TEST_DATABASE_URL` is absent. Record skipped tests explicitly. Browser tests follow the repository's configured e2e runner and both-UI requirements; do not substitute static component snapshots for user-visible recovery flows.

`pnpm evaluate:chronicle` remains the retrieval-only comparison. The proposed `pnpm evaluate:story-continuity -- --mode deterministic` adds private-path coverage. Neither synthetic embeddings nor fake provider output establishes live narrative quality.

### 12.2a Starter regression examples

The following is a concrete T08 red-test seed using the existing exported query planner. Extend the current unit test file and adapt imports only if the execution branch moved them. It is intentionally expected to fail on the investigated prefix-only planner and pass after balanced query coverage is implemented.

```ts
import { expect, it } from "vitest";
import { planChronicleQueries } from "../../packages/domain/src/chronicle-query-plan.js";

it("retains a distinct late beat from a long Story Direction", () => {
  const direction = "Fog gathers around the silent harbor. ".repeat(120)
    + "Return to Saltvault and confront Vesper about the stolen charter.";
  const planned = planChronicleQueries({ action: direction, throughTurnNumber: 80 });
  expect(planned.length).toBeLessThanOrEqual(8);
  expect(planned.some((q) => q.query.includes("Saltvault"))).toBe(true);
  expect(planned.reduce((n, q) => n + q.query.length, 0)).toBeLessThanOrEqual(8000);
});
```

T06 must include separate accepted-source and correction-source cases, not a single parser test: (a) accept a turn with only a structured update, capture the next producing request and compare its UUID to the scoped canonical projection; (b) apply a full empty correction at that same base and prove the next request remains empty; (c) replay derived projection and prove the ID/validity interval is unchanged. The same fixture must then be exercised with `replace_latest` using the preceding base, so the replacement cannot inherit its own discarded output.

For T17/T18, inject failures at each persisted boundary rather than only testing a happy-path retry: after draft checkpoint, after repair allowance reservation, after provider response but before persistence, after review persistence and immediately before guarded commit. Reload through the repository lease-reclaim path and assert both provider call counts and accepted turn/event counts. Exactly-once acceptance does not imply exactly-once provider dispatch across an ambiguous network failure; bound and report possible duplicate calls without allowing duplicate commits or resetting repair allowance.

### 12.3 Proposed release gates

Mandatory correctness gates are absolute; quality/performance targets are proposed initial gates to ratify before expensive live runs, not claims of measured success.

| Gate | Requirement |
| --- | --- |
| Authority correctness | 100% deterministic required-field/identity fixtures pass; no hidden protected truncation |
| Isolation/privacy | Zero observed owner/world/future leakage, scratchpad embedding/public leak, or rejected-draft authority grant across the defined suite |
| Durability | Exactly one commit under tested reclaim/race cases; zero state/event mutation on failed review/repair |
| Budget | All tested operations use measured final body and retain output reserve; overflow recoverable |
| Retrieval regressions | All F4/F5 cases pass; held-out source-evidence recall noninferior to corrected baseline |
| R1/R2 overhead | No new foreground text-model calls; investigate >20% p95 retrieval/planning regression on fixed isolated workload before release |
| R3 reviewer precision | Proposed ≥95% precision for enforcing contradiction findings on human-adjudicated corpus, with uncertainty interval reported; uncertainty too wide blocks enforcement |
| R3 false blocks | Proposed ≤2% on labeled legitimate-change/flashback/empty-correction cases; report denominator and confidence interval |
| R3 quality | Proposed ≥25% relative reduction in evidence-supported contradictions against R2, without meaningful writing-quality or direction-coverage regression |
| R3 cost | At most one semantic repair per attempt; report p50/p95 latency, extra calls, input/output usage and actual cost. No universal acceptable dollar ceiling is invented here; owner approves budget before live enrollment |
| Compatibility | Archive/copy/replay/old-job matrix passes; both Story UIs show safe recovery |

Use at least 30 distinct long-run scenarios with repeated samples for initial live comparison if approved; expand until intervals are informative rather than declaring success from one run. Split fixture calibration and held-out evaluation. Stratify by campaign length, corrected-state cases, provider/model and input mode. Do not tune a rank profile on the same held-out cases used to claim success.

### 12.3a Gate applicability and measurement definitions

| Gate | R1 | R2 | R3 observe | R3 enforce |
| --- | --- | --- | --- | --- |
| Authority, isolation/privacy, exact budgets, release-specific durability and portability | Required | Required, including spans/recent window | Required, including review failure/reclaim | Required, including repair and final-review acceptance |
| Retrieval noninferiority and no new foreground text-model calls | Required against named baseline | Required against R1 | Retrieval noninferiority still required; new review calls explicitly measured | Same; bounded review/repair calls explicitly measured |
| Both-interface implementation, recovery and browser screenshots | Required for R1 rows | Required for R1/R2 rows | Required including observe states | Required including conflict/repair/artwork states |
| Reviewer precision, false-block and semantic quality targets | Not applicable | Not applicable | Measure in shadow evaluation; not an enforcement promotion pass | Required with informative intervals |
| Cost/latency | R1 workload/performance gate | R2 workload/performance gate | Explicit approved live-call ceiling and measured review cost | Same plus repair budget and accepted operating ceiling |

Observe readiness proves operational safety and honest diagnostics, not reviewer quality sufficient for enforcement. Deterministic fake-provider review runs can establish code readiness; live observe enrollment still requires approved canaries and cost limits. T20 must mark absent live evidence as skipped, never substitute it for enforcement gates.

Before held-out live runs, T15 records scenario/sample sizes, seeds, model/settings, paired comparison method and these denominators:

- Contradiction precision: human-confirmed enforcing contradiction findings divided by all proposed enforcing contradiction findings; report invalid evidence findings separately. Use a 95% Wilson interval; the lower bound must be at least 95% for enforcement.
- False blocks: legitimate-change/flashback/intentional-empty attempts blocked by the proposed enforcing policy divided by all human-labeled legitimate attempts in that stratum. Report semantic false blocks separately from provider-unavailable/operational failures and also report total user-visible block rate. The semantic false-block 95% Wilson upper bound must be at most 2%.
- Quality improvement: contradiction-bearing evaluated outputs divided by all evaluated outputs, with no failed generation counted as contradiction-free success. Report completion rate separately. Compare paired R2/R3 scenarios with a 95% interval clustered by scenario; the lower bound of relative reduction must reach the proposed 25% target. Zero baseline contradictions makes relative reduction undefined and cannot establish this gate.
- Writing quality and direction coverage: blinded human scoring using a frozen 1–5 rubric for coherence, prose quality, character portrayal and requested-beat coverage. Proposed noninferiority margin is 0.25 points per dimension; the paired 95% interval's lower bound for R3 minus R2 must exceed -0.25 for each. Ratify rubric/margins before held-out runs, not after inspecting results.

Repeated samples from one scenario are correlated, not independent new scenarios. Report denominators and per-provider/input-mode strata; use scenario-clustered intervals for paired quality comparisons and sensitivity analysis for correlated finding rates. If uncertainty remains too wide, collect additional independent scenarios or keep observe mode; 30 scenarios alone is not evidence that a 2% false-block bound was met. Freeze labels/adjudication rules before scoring, resolve disagreements with a separate adjudicator, and keep calibration cases out of held-out results.

### 12.4 Decision tree when a continuity failure is reported

1. Was the fact retained in a source turn/correction/profile/world version? If not, source-linked repair may be impossible.
2. Was the correct source eligible at this branch/base/world? If not, inspect temporal/scope/correction logic.
3. Was it a candidate? If not, inspect query coverage, index freshness and prelimit selection.
4. Was it in the exact producing request? If not, inspect planner omissions and budget pressure.
5. Was it present but ignored or contradicted? Evaluate prompt use, model behavior and semantic review.
6. Did it pass review but commit/retry alter state? Inspect producing-request hashes, checkpoint invalidation and guarded commit.

This classification prevents spending effort on a reranker when the actual problem is profile omission, or on prompt wording when a stale checkpoint is being reused.

### 12.5 Copy-ready assignment template

```text
Implement task T__ from nexus-story-continuity-implementation-plan-2026-09-16.md.
Repository: cmacnichol/infinite-quest-nexus.
Investigation baseline: 60a4aabe4adc2759f14fd53370e31465daabb783.

First read current AGENTS.md and the task's required architecture documents.
Revalidate changed source since the baseline. Read sections 4–8 and the task card.
Dependencies must be merged or their agreed exported contracts available.
Implement only this task; preserve unrelated edits and named legacy readers.
Add failing regressions first, then implement and run the required tests.
No deployment, paid provider calls, production writes or bulk reindex without approval.

Return:
1. Exact files changed and contract decisions.
2. Regression demonstrated before fix and verification commands/results afterward.
3. Scope/privacy/budget/empty-correction/retry checks performed.
4. Compatibility and migration implications.
5. Remaining limitations and handoff to dependent tasks.
Do not claim skipped tests passed or synthetic results prove live story quality.
```

### 12.6 Definition of program completion

The core program is complete when R1–R3 are implemented, verified and accepted through their applicable gates, including implementation and rendered recovery verification in both `/story` and `/app/story`, not when all optional experiments are built. R3 observe-only readiness is a separately reportable milestone and does not satisfy the R3 enforcement gate. A safe earlier milestone is R1 shipped with proof of corrected inputs and no new model calls. Existing-campaign repair is separately approved per campaign. Optional experiments may correctly conclude “do not adopt.”

## 13. Sources and source map

### Pinned repository evidence

- [Private authority loader](https://github.com/cmacnichol/infinite-quest-nexus/blob/60a4aabe4adc2759f14fd53370e31465daabb783/packages/database/src/chronicle-generation-context.ts): F1/F2, base-turn capture and latest effective narration.
- [Continuity materializer](https://github.com/cmacnichol/infinite-quest-nexus/blob/60a4aabe4adc2759f14fd53370e31465daabb783/packages/database/src/campaign-continuity-repository.ts): F3 and exact-correction distinction.
- [Generation base identity](https://github.com/cmacnichol/infinite-quest-nexus/blob/60a4aabe4adc2759f14fd53370e31465daabb783/packages/database/src/generation-authority.ts): enqueue/commit authority dependencies.
- [Retrieval and candidate loader](https://github.com/cmacnichol/infinite-quest-nexus/blob/60a4aabe4adc2759f14fd53370e31465daabb783/packages/database/src/chronicle-context-repository.ts): `loadContextMemories`, `loadPostgresChronicleGenerationCandidates`, preview behavior and cutoff fact SQL.
- [Query planner](https://github.com/cmacnichol/infinite-quest-nexus/blob/60a4aabe4adc2759f14fd53370e31465daabb783/packages/domain/src/chronicle-query-plan.ts): query caps, prepend and deduplication.
- [Runtime executor](https://github.com/cmacnichol/infinite-quest-nexus/blob/60a4aabe4adc2759f14fd53370e31465daabb783/services/runtime/src/generation-executor-adapter.ts): actual private prompt planning, `sentCanonicalFactIds`, fiction filtering and scene coverage conditions.
- [Accepted-state commit](https://github.com/cmacnichol/infinite-quest-nexus/blob/60a4aabe4adc2759f14fd53370e31465daabb783/packages/database/src/generation-execution-repository.ts): plain/structured fact storage and durable checkpoint context.
- [Chronicle projection/replay](https://github.com/cmacnichol/infinite-quest-nexus/blob/60a4aabe4adc2759f14fd53370e31465daabb783/packages/database/src/chronicle-repository.ts) and [correction projection](https://github.com/cmacnichol/infinite-quest-nexus/blob/60a4aabe4adc2759f14fd53370e31465daabb783/packages/database/src/chronicle-state-correction-repository.ts): fact identity, temporal validity and correction replacement.
- [Fact/memory helpers](https://github.com/cmacnichol/infinite-quest-nexus/blob/60a4aabe4adc2759f14fd53370e31465daabb783/packages/domain/src/chronicle-memory-helpers.ts): combined fact ordering, source labeling and sanitization.
- [Character resolver](https://github.com/cmacnichol/infinite-quest-nexus/blob/60a4aabe4adc2759f14fd53370e31465daabb783/packages/domain/src/world-characters.ts) and [world schema](https://github.com/cmacnichol/infinite-quest-nexus/blob/60a4aabe4adc2759f14fd53370e31465daabb783/packages/contracts/src/world-library.ts): profile precedence, helper caps and large/untyped sibling arrays.
- [Chunk source offsets](https://github.com/cmacnichol/infinite-quest-nexus/blob/60a4aabe4adc2759f14fd53370e31465daabb783/packages/domain/src/chronicle-chunking.ts): normalization, packing and offset fallback.
- [Current evaluator](https://github.com/cmacnichol/infinite-quest-nexus/blob/60a4aabe4adc2759f14fd53370e31465daabb783/scripts/lib/chronicle-retrieval-evaluator.ts): retrieval/public-preview evaluation boundary.
- [Story context integrity](https://github.com/cmacnichol/infinite-quest-nexus/blob/60a4aabe4adc2759f14fd53370e31465daabb783/docs/architecture/story-context-integrity.md), [story-only policy](https://github.com/cmacnichol/infinite-quest-nexus/blob/60a4aabe4adc2759f14fd53370e31465daabb783/docs/architecture/story-only-campaign-policy.md), [deployment runbook](https://github.com/cmacnichol/infinite-quest-nexus/blob/60a4aabe4adc2759f14fd53370e31465daabb783/docs/runbooks/deployment.md): existing authority, replacement, budget, privacy and rollout decisions this plan preserves/amends.

Research links appear beside their specific interpretations in section 3. Proposed defaults, algorithms, task boundaries and release gates are recommendations derived from the combined investigation, not quotations or proven performance claims from those papers.
