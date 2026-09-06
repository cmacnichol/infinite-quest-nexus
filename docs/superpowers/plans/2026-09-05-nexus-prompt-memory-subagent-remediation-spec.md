# Nexus Prompt and Memory Remediation Specification

**Status:** Planning only. Read with [the subagent implementation plan](2026-09-05-nexus-prompt-memory-subagent-remediation.md). Neither document authorizes implementation, deployment, publication, or campaign repair by itself.

**Provenance:** The behavior, planner, and release sections below are retained from `C:\Users\chris\Downloads\2026-09-05-nexus-prompt-memory-remediation.md` (SHA-256 `EB7D218CF54B1906DA5D95A05B2B2E4DD84ED092450E3D3CFDF44983512D3C60`). The original source file remains unchanged. Its baseline is `3489aaaf1ed4fe1a9142f56ec03fdaa5cd7ce255`; the project review used `157c04dfd1e9a1290c5b9d30191bfdd7a55e75cc` on 2026-09-05. Source instructions directed at workers were reviewed as document content, not executed.

**Authority:** This specification combines the original behavior with review amendments R1-R7 below. Amendments resolve the explicitly named ambiguities in the retained source sections. Task numbers and execution order are defined only in the companion plan. Numbering in retained sections identifies the source specification, not implementation tasks.

**Limits and evidence:** Campaign context presets remain 32,000, 64,000, 128,000, 256,000, and 1,000,000 tokens. Provider windows permit up to 4,000,000; memory budgets stop at 1,000,000. The 4,000-token test is a stress probe, not a product preset. The original probes established truncation and prompt drift, not corruption of a deployed campaign. The review's 66 passing unit tests across 9 matched suites were baseline evidence, not remediation acceptance.

## Global Constraints

- Keep `owner_user_id`, `campaign_id`, and `world_version_id` scope checks at every repository boundary.
- Accepted turns and explicit user corrections remain authoritative. Embeddings and summaries remain rebuildable projections; a rebuild cannot recover facts absent from all authoritative sources.
- A replace-latest operation uses its historical base state and cutoff, not the state produced by the turn being replaced.
- Rejected, cancelled, stale, or incomplete jobs must not mutate campaign state, accepted turns, Chronicle memory, or trigger counters.
- Preserve independence of text and illustration providers. Image failures must not fail an accepted text turn.
- Do not automatically change existing campaign context settings, provider models, output reserves, prompt overrides, or user corrections.
- Do not add a new queue, vector store, agent framework, general-purpose workflow engine, or separate summary-generation service.
- Use existing repository package boundaries. Contracts must not import runtime or story-engine implementation modules.
- Do not remove lexical fallback, embedding compatibility checks, historical cutoff rules, or retrieval comparison support as part of simplification.
- Keep scratchpad text and full private prompt payloads out of public previews and normal logs.

## 2. Chosen approach and alternatives

**Chosen: protect complete current state, retain replacement-style continuity, and consolidate prompt construction.** This fixes the defects with the fewest changes to the existing accepted-turn schema. It may reject a job whose protected context genuinely cannot fit; the error must explain the shortfall rather than quietly discarding state.

**Alternative: change all continuity to model-generated patches.** This could reduce context and output costs but requires reliable deletion semantics, conflict handling, identifiers, migrations, and replay rules. Do not introduce that additional protocol in this remediation. Canonical facts and trackers already have update semantics; retain them.

**Alternative: raise every budget or use a larger model.** This postpones some failures but does not repair whole-state replacement from partial input, extension inconsistency, or duplicate prompts. Retain explicit large-model settings without making larger budgets the correctness mechanism.

## 3. Required behavior

### 3.1 Load authority independently of historical retrieval

Introduce an internal generation-only result with:

- Exact campaign/world scope and base turn number.
- A state revision or equivalent immutable snapshot fingerprint.
- Complete fiction-safe scratchpad, current continuity summary, unresolved threads, and trackers used by replacement/update semantics.
- Complete mandatory narrative rules from the immutable world version.
- Complete latest accepted action and narration from the accepted-turn source, honoring explicit narration corrections and replacement cutoff.
- Complete applicable user continuity correction, including deliberately empty values.
- Scoped canonical facts with their actual IDs; facts remain changes, not a whole-list replacement. Select ordinary historical facts as complete records under the remaining budget. A full explicit correction retains its established authority and must not be silently truncated.
- Ranked optional historical candidates and their provenance, kept distinct from authority.

Use the existing campaign-state/correction materialization rules to resolve current state. A corrected field must not fall back to older generated content because it is empty. At turn zero, load initialized campaign state and any applicable correction; absence of a previous turn is normal.

Do not depend on embedding completion to obtain the latest accepted turn or current state. Derived memory may lag or be absent without making these authoritative inputs disappear.

Replace the internal behavior switch based on `costAttribution.operation === "retrieval_embedding"` with an explicit private generation method. Cost attribution describes accounting, not authorization or context semantics. Public previews continue to use a sanitized projection and cannot opt into private data by changing request fields.

### 3.2 One budget policy, with two distinct ceilings

Define:

```text
W = minimum of the resolved provider window and a valid requested window, if supplied
O = configured output reserve for this provider operation
S = token-count safety allowance
I = W - O - S                         # usable input allowance
C = snapshotted campaign context budget

cost(serialized context blocks) <= C
cost(final serialized provider request) <= I
```

Both constraints apply. Prompt instructions, current input, repair text, validated draft, and rejected draft all count toward the final request, even when they are not part of campaign context. Fail immediately if the protected request cannot fit either applicable ceiling. Do not reduce the configured output reserve to conceal overflow.

Counting uses the provider/model tokenizer when available. Otherwise use the existing conservative text estimator, add a documented 20% input-estimate allowance plus 1,024 tokens for uncertain message/template overhead, and record `countMode: estimated`. With an exact compatible tokenizer, count message framing and retain 256 tokens of transport headroom. These are initial policy values, not claims of a mathematical token guarantee for unknown model tokenizers. Provider-reported overflow remains a recoverable error; adjust future estimates through measured calibration, never by deleting protected state.

Allocation order:

1. Protect complete rules, complete replacement fields, selected character identity, current input, applicable corrections, and the full latest turn.
2. Add the remaining requested recent turns, newest first, as complete records while they fit; report any omitted recent turn. Render selected records chronologically afterward.
3. Add selected current canonical fact records and relevant older history using deterministic rank order and whole-record inclusion.
4. Use accurate accepted-turn summary/checkpoint data when available. When it is absent, use a clearly labeled historical excerpt or omit the record. Never label a narration prefix as an outcome.

If a candidate does not fit, continue considering smaller lower-ranked candidates rather than stopping at the first large one. Deduplicate by source identity and revision before measuring. The latest turn appears exactly once and is never shortened to a fixed percentage.

Before generation, estimate whether the complete unchanged replacement fields plus the minimal required JSON shape can fit the configured output reserve. If even that conservative lower-bound case cannot fit, return `continuity_output_budget_exceeded` with required and configured counts; never silently reduce field contents or raise output limits. This is a necessary feasibility check, not a guarantee that the model will finish within its reserve. A provider-limited incomplete output remains recoverable.

No component may apply another `splice`, truncation, or implicit field cap after the plan is finalized. Each provider call uses the same planner against its actual payload.

### 3.3 Replacement continuity semantics

Retain whole replacement for scratchpad, summary, and open threads, but give the model their complete base values. Remove the misleading promise that a model can preserve notes it did not see.

- The new protocol requires all replacement continuity fields explicitly. Missing fields cause schema recovery, not fallback to a narration recap or whatever history survived retrieval.
- Explicit empty scratchpad and empty open-thread list are valid. An empty continuity summary is valid for the replacement contract when intentionally returned or inherited from a correction; remove the mismatch with editable current-state semantics.
- Align open-thread replacement capacity with the existing state schema: 500 entries. Keep per-item bounds consistent.
- Validate facts and tracker changes using existing typed rules and scope checks. A supplied fact ID must be both visible in the sent context and authorized for the base state.
- Keep compatibility parsing only for historical stored records/imports that require it. Do not silently apply legacy defaulting to new-protocol generations.

Supplying full state does not guarantee that an LLM will never forget a fact. Deterministic tests must prove input completeness and safe persistence; narrative-quality evaluations separately measure whether the model retains relevant notes.

### 3.4 Event extensions produce a complete final story

Replace the special `additional_text` plus optional scratchpad result with the existing complete `StoryTurnOutput` shape for new-protocol event extensions.

The extension request contains the protected context, original action, the complete validated main draft including continuity, and fiction-only instructions for the activated event. The extension must preserve the existing narration and append the event passage, then return replacement continuity for the complete story. Validate that normalized narration starts with the validated original narration and has a nonempty appended passage.

Facts and tracker updates in the final object describe the complete turn relative to its original base state. Do not concatenate base and final update arrays; that would apply changes twice. The final summary, threads, choices, image prompt, and scratchpad must reflect the extended story.

Run normal schema, fact-ID, mechanics-boundary, and required scene checks against the final object. Only that object is committed. The common non-extension path remains one generation call; this design uses the existing extension call rather than adding a separate continuity-finalizer call to every turn.

If an activated immediate event cannot be safely extended after the bounded repair policy, mark the job recoverable and leave all state unchanged. This is deliberately stricter than silently swallowing the extension error. Do not mark an event triggered if its fiction was never committed. Optional illustration errors remain independent.

### 3.5 Prompt definitions, overrides, retries, and diagnostics

Move shipped story system and recovery text to a contract-layer definition imported by both the catalog and engine compatibility exports. Keep user-prompt construction in the story engine. Protocol identity must include the shared protocol constant, output schema/policy version, and resolved template hashes; a user-prompt or budgeting change must invalidate compatibility even if the system template did not change.

Preserve stored custom prompt overrides. Separate non-overridable wire-format/authority requirements from editable creative instructions. Add a prompt-library compatibility notice for overrides written against the old extension or continuity shape. For incompatible overrides, return a specific validation error with a preview of the required shape; do not rewrite user text automatically.

Use self-contained recovery requests for the new protocol. Do not set `previous_response_id` for repair calls: the cost and contents of remote history are not reliably inspectable. Retain response IDs for diagnostics. Include repair instructions and a bounded, explicitly untrusted rejected-draft block, then rerun the common planner. If the complete draft cannot fit, omit the rejected draft and request a clean regeneration from protected context; do not silently prefix-truncate a draft that the repair prompt promises to preserve. A scene rewrite requires the complete current input and explicit missing beats.

All provider operations touched by this generation workflow must pass through the final payload guard: story generation, schema/mechanics recovery, scene checking and rewrite, RPG assessment, before/after trigger evaluation, and event extension. Operations that do not need history should omit it deliberately before planning.

Record, privately, per attempt: operation, provider/model identity, protocol and policy version, snapshot fingerprint, configured and effective budgets, output reserve, count mode, safety allowance, final payload hash, selected source IDs/revisions, omission reasons, and actual usage when supplied. Do not call pre-budget retrieval candidates “sent context.” Public diagnostics expose safe counts and actionable errors, not scratchpad text or private provider data.

## 5. Proposed planner interface

This interface is a proposed implementation contract, not an assertion that these exports already exist. Tokens and text are counted after serialization, never by adding only raw block lengths.

```ts
export type ContextBlock = Readonly<{
  id: string;
  revision: string;
  content: string;
  protected: boolean;
  priority: number;
  ordinal: number;
}>;

export type ContextBudgetInput = Readonly<{
  blocks: readonly ContextBlock[];
  contextLimit: number;
  inputLimit: number; // already subtracts output reserve and safety allowance
  count: (serialized: string) => number;
  serializeContext: (blocks: readonly ContextBlock[]) => string;
  serializeRequest: (blocks: readonly ContextBlock[]) => string;
}>;

export type ContextBudgetResult = Readonly<{
  selected: readonly ContextBlock[];
  omitted: readonly Readonly<{
    id: string;
    reason: "duplicate" | "context_budget" | "provider_budget";
  }>[];
  contextTokens: number;
  requestTokens: number;
  request: string;
}>;

export function planContext(input: ContextBudgetInput): ContextBudgetResult;
```

`planContext` rejects invalid limits. It deduplicates identical `(id, revision)` records, rejects conflicting content for the same identity, measures all protected blocks first, and throws `context_budget_exceeded` with safe counts when they cannot fit. Optional blocks sort by ascending priority, descending ordinal, and stable ID. Request rendering receives selected blocks ordered chronologically within their scope. Return the actual serialized request used by the transport; the sender must not reconstruct a different payload.

## Review amendments R1-R7

These requirements are part of the binding specification, not optional follow-up work.

### R1 — Preserve 500 threads through every projection

Share the 500-entry and 4,000-character item bounds between editor and generated replacement validation. The existing `sanitizeChronicleMemoryLines(values, limit = 100)` is a generic helper whose default also serves facts. Pass the shared thread bound explicitly in both `chronicle-repository.ts` and `chronicle-state-correction-repository.ts`; preserve unrelated fact limits. Check all thread-specific callers. Keep accepted-state order and contents; any existing projection normalization must be documented and must not silently drop distinct valid threads. Prove 0/100/150/500 unique safe threads survive commit, direct correction, next-turn authority loading, and replay. The 501st entry must fail validation, not disappear.

### R2 — Bind resumed stages to the exact validated draft

A base revision alone cannot identify a model draft. Persist a versioned private checkpoint in existing orchestration/metadata storage, with a schema validated on load. Its identity includes owner/campaign/world-version, base fingerprint, protocol/policy, effective provider/model configuration, normalized original input, and validated-main-draft hash. Persist the complete validated main draft before evaluating after-events. Each cached draft/final object also carries its producing operation/attempt ID, payload hash, and immutable sent-fact allowlist, or an immutable foreign reference to that exact private attempt record. Bind after-event decisions, extension repair state, event-coverage results, final story, and provisional illustration reconciliation to that draft hash. Final validation and commit use the same final-story hash and its producing request's provenance, never whichever coverage audit happens to be latest.

For an ordinary retry or expired-lease reclaim with compatible inputs, resume the stored validated main draft; do not regenerate it and reuse downstream results. If resuming from an incomplete pre-validation stage requires a new draft, invalidate every draft-dependent checkpoint before accepting its results. Keep base-dependent rolls/before-events only when their own input identity matches. Recheck current scope/base revision under the commit transaction's established lock order. Guard checkpoint writes and commits with the current lease/attempt; a stale claimant cannot overwrite a current checkpoint.

Persist content-repair consumption per stage and draft; reclaiming a lease does not replenish the one automatic repair allowance. An explicit user retry may start a new bounded stage attempt, recorded distinctly; it cannot silently reinterpret protocol or base changes. An extension failure records stage failure rather than a permanent flag that skips extension on retry. Tests interrupt after main validation, after event decisions, after extension persistence, and before commit, with and without lease takeover. Include a coverage call whose fact visibility differs from the story-producing call, then reclaim: commit must still use the producing call's allowlist. Require one accepted turn, one application of trackers/facts, and matching draft/final hashes throughout.

### R3 — Propagate safe actionable diagnostics end to end

Keep the existing generic public `errorCode` and `errorMessage` fields for compatibility. Add a separate nullable, strictly validated `diagnostic` object to job polling, SSE snapshots, and campaign recovery projections. Whitelist its code, operation, fixed action key, safe field identifier, and nonnegative numeric counts only. Never copy arbitrary `recoveryMetadata`, error messages, request bodies, provider URLs/credentials, scratchpad, or rejected narration into it. The client renders application-owned copy from the code/action key. Prompt compatibility previews show only the shipped required shape, not private snapshots.

The following codes terminate the affected generation attempt as recoverable without accepting any turn or changing campaign/Chronicle/trigger state: `context_budget_invalid`, `context_budget_exceeded`, `continuity_output_budget_exceeded`, `provider_context_overflow`, `authoritative_context_invalid`, `prompt_override_incompatible`, `prompt_protocol_upgrade_required`, `event_coverage_failed`, and `extension_narration_limit_exceeded`. Lease loss/cancellation stop the stale executor without replacing the current claimant's status; stale base state requires explicit re-enqueue from current authority. Unexpected failures retain existing generic failure behavior. Schema/mechanics/content failures use only their bounded content-repair stage before recoverable status.

All stage catches must distinguish these integrity errors from fallback-eligible assessment/trigger provider failures. Integrity errors propagate to the common recoverable handler before local fallback, scene rewriting, or trigger suppression can hide them. Classify known provider-context-overflow responses without echoing provider text; unknown responses stay generic. Image failures retain the independent illustration lifecycle.

The diagnostic action keys are `adjust_context` (invalid/exceeded input context), `adjust_output_or_state` (output reserve), `check_provider_window` (provider overflow), `repair_authority` (unsafe authority), `update_prompt` (incompatible override), `discard_and_reenqueue` (protocol upgrade), `retry_event` (exhausted event coverage), and `shorten_or_replace_turn` (narration character limit). Field keys are limited to `rules`, `scratchpad`, `continuity_summary`, `open_threads`, `canonical_facts`, `narration`, and `context_settings`. Operation keys are the existing generation workflow operations plus `event_coverage`; define one shared enum from those current operation names in Task 1 and report it to consumers. A diagnostic code selects its fixed action; mismatched code/action pairs are invalid. Hashes, source IDs, arbitrary messages, and raw provider identity remain private.

Test the full matrix across initial generation, assessment, before/after triggers, schema/mechanics repair, scene checking/rewrite, and extension/event checking. Polling, SSE, initial campaign recovery hydration, and client display must expose the same safe diagnostic. Test unknown codes, extra properties, malicious field values, and private canaries are rejected or reduced to the generic projection. Add all public serializers and schema consumers to the task file list.

### R4 — Close text-based fact supersession for new outputs

For the new protocol, `superseded_facts` is retained only as an explicitly empty compatibility-shaped array: nonempty text supersession is a schema/content error. Use `canonical_fact_updates[].supersedes_fact_ids` for supersession. Keep historical/import replay's named legacy text path so old accepted records remain meaningful. Existing pure additions through `canonical_facts` retain their established semantics; do not concatenate legacy additions and structured updates into duplicate facts.

Validate each supersession ID against the intersection of active authorized base facts and the fact IDs visible in the actual request that produced the accepted object. Capture a per-attempt sent-fact allowlist from the final selection, not pre-budget candidates. On an extension/repair that preserves a validated draft, protect complete base-fact records referenced by that draft's updates so subsequent validation has the evidence needed to preserve them. If those records cannot fit, fail explicitly. An untrusted rejected draft does not grant visibility or authority to an ID it invents.

Repeat authorization under the guarded commit and fail the transaction on invalid IDs; writing unmatched IDs into metadata is not successful validation. Test omitted same-campaign facts, other owners/campaigns/worlds, future/superseded facts, duplicate text with different IDs, and legacy text attempts. Imports/replay must still reproduce legitimate historic supersession.

### R5 — Validate every immediate event's fictional outcome

For both action and scene turns, final coverage must check the complete set of currently due event fiction beats: before-events and pending events consumed by this turn against the complete narration, and immediate after-events against the appended passage as well as the complete final narration. Prefix preservation plus a nonempty suffix is necessary but insufficient. Use the existing scene-coverage capability with an operation-specific input containing stable event IDs and fiction-only requirements; retain original scene-direction checks when applicable. Validate coverage for each required event, without revealing mechanics, rolls, trigger condition internals, or private evaluator reasoning to story narration.

After-events without immediate extension are deferred, not required in the current passage. Commit them as pending occurrences; distinguish a pending activation from a fulfilled hit. Increment fulfilled counters only when the due occurrence's fiction is accepted, and clear that occurrence then. Use the existing stable trigger ID plus source-turn/occurrence provenance to prevent duplicate fulfillment across retries; do not rely solely on `sourceTurn === expectedTurnNumber`, which would miss fulfillment of a deferred event on a later turn. Preserve existing cooldown/activation behavior deliberately by consulting pending occurrences during selection; a deferred event must neither retrigger every turn nor be silently counted as enacted. Document any affected hit/cooldown semantics and test before, pending, immediate-after, deferred-after, and same-ID repeated legitimate occurrences.

Use a single bounded batch extension and event-coverage stage for all immediate after-events; do not recursively evaluate new triggers caused by the appended passage in this remediation. Validate before/pending requirements with the main story; a main-story rewrite invalidates its downstream checkpoints before reevaluation. Event-extension repair must preserve the validated main narration and return a complete story relative to the original base. Repair at most once per affected stage, then revalidate schema, facts, mechanics, original scene coverage where applicable, and every due event. Coverage must refer to the final object's hash. A checker timeout, malformed/limited result, contradiction, or omitted event cannot be treated as covered. Budget errors propagate under R3. On exhausted validation, return `event_coverage_failed` with no authoritative updates or trigger hits.

Test an unrelated but valid suffix, one missing event among several, an event contradicted elsewhere, an event already claimed in the main draft but absent from the required appended enactment, and success in action/scene modes. Mocked coverage proves enforcement of the checker decision; it does not prove model judgment is infallible. Live event-heavy canaries assess that separate limitation.

### R6 — Preserve immutable protocol identity through retry and reclaim

Task order must establish durable protocol/base identity before enabling the new runtime path. Newly enqueued jobs snapshot shared protocol, schema/policy version, resolved-template hashes, desired context setting, and base identity. Validate both append and replace-latest enqueue, manual retry, claim/reclaim, execution payload load, and commit. Never promote a historical job by overwriting `prompt_protocol_version` while leaving its snapshot/orchestration untouched.

Keep old-protocol queued/recoverable jobs unchanged in content and classify them with `prompt_protocol_upgrade_required`; automatic reclaim cannot execute them. Administrators can explicitly discard and enqueue with a new idempotency key. Repeating an old idempotency key returns/rejects its original job according to existing semantics, rather than creating a hidden new job. Compatible retry retains the resolved snapshot protocol including template hashes. Changing a provider configuration is not silently treated as compatible with a cached draft; changed effective inputs require explicit new work or a recorded supported restart policy that invalidates dependent stages.

Old accepted turns and imports remain readable. No partial task commit is a deployable milestone for this plan; ship the complete compatible release, including readers and diagnostics. Keep additive schema changes on rollback and test old-reader compatibility before reverting binaries. Migration numbering is selected from the execution branch at implementation time, never copied from the reviewed baseline.

### R7 — Check extension output feasibility, not only input capacity

Before an extension call, measure a conservative output skeleton containing the complete preserved normalized narration, unchanged replacement continuity, required JSON fields, and a nonempty appended passage. Apply the configured operation output reserve without reducing continuity or increasing the reserve. Check the remaining capacity under the existing 200,000-character narration bound; if no valid appended passage can fit, return `extension_narration_limit_exceeded` before sending. Token-reserve failure returns `continuity_output_budget_exceeded`. This is a necessary feasibility screen, not a guarantee that every event passage the model chooses will fit.

Test the exact-fit and one-over boundaries for both limits, including long narration with tiny continuity, large continuity with short narration, escaped JSON, and multiple events. Oversized protected input and oversized required output are distinct diagnostic cases. A limited model response remains recoverable and never becomes an accepted prefix.

## Clarifications for implementation

- The planner interface above is the initial shared contract. Rendering callbacks retain scope/provenance from the private context result; chronology is within each scope. Exact token counting must account for the model's actual messages/template framing, not claim that tokenizing HTTP JSON keys equals provider input tokens. The transport still sends the exact serialized request that was guarded; fallback serialization estimates are explicitly conservative.
- The authority transaction uses a consistent database snapshot or equivalent established locking, not an assumption that several READ COMMITTED statements share one snapshot. Finish it before embedding/provider network calls. Fingerprints exclude rebuild timestamps and other purely derived changes so rebuilding memory does not make unchanged authoritative state stale.
- Preview and retrieval comparison stay sanitized and retain existing ranking/fallback capabilities. Private generation obtains its own explicit seam; accounting metadata cannot select private behavior.
- Stored overrides remain byte-for-byte intact. Recognize format compatibility through explicit schema/protocol metadata and controlled validation, not a claim that arbitrary natural-language compatibility can be decided by substring search. The non-overridable envelope supplies current wire requirements; ambiguous unversioned creative overrides need an explicit compatibility acknowledgement/new snapshot with a required-shape preview, not an automatic rewrite or blanket rejection. Known incompatible format instructions require a user-authored correction; acknowledgement does not override hard wire requirements. Acknowledgement metadata is scoped to the exact content hash and protocol/policy, and becomes stale when either changes.
- The optional-history selection cost must be measured at 1M budgets with realistic candidate counts. Avoid repeated full serialization/tokenization growing quadratically where cached block accounting can safely narrow work; validate the final serialization regardless. No unmeasured claim of large-window runtime performance follows from a synthetic counter test.

## 7. Verification commands and release acceptance

Before implementation, read the repository's current `AGENTS.md`, nested instructions, package manifests, and `docs/workflows/testing.md`. Use the pinned package-manager version from the implementation checkout. Record the checked-out SHA and dirty state; do not overwrite existing work.

Run task-specific unit commands during development. Before release, run the existing documented isolated database harness rather than pointing Vitest at a real deployment database:

```bash
pnpm test:unit
pnpm test:integration
pnpm check
pnpm build
git diff --check
```

Public diagnostics and prompt-override notices are changed surfaces in this plan. Run their browser coverage and capture screenshots. Existing dependency/network/fixture failures must be recorded separately from remediation regressions; do not report a gate as passing when it did not run.

Release requires:

| Criterion | Evidence |
| --- | --- |
| Complete current state and latest turn | Exact input equality and captured payload assertions |
| Complete mandatory rules or explicit failure | Final-rule fixture and overflow test |
| Consistent extension result | Final object, trigger state, and next-turn prompt comparison |
| Every provider payload budgeted | Captured transport bodies and operation audit assertions |
| One shipped prompt definition | Production snapshot parity and protocol invalidation tests |
| Large-window settings retained | 32K through 1M scaling matrix and provider-cap test |
| No rejected generation commits | Database assertions for recovery, cancellation, and stale jobs |
| Correct replacement and corrections | Historical cutoff, empty state, and replay tests |
| Privacy boundaries retained | Public preview/log canary tests and ownership fixtures |
| Complexity actually reduced | One selection policy, one serialization/counting path, no duplicate active prompt source |

## 8. Deployment, rollback, and existing campaign repair

### Deployment sequence

1. Export representative test campaigns and take the deployment's normal PostgreSQL backup. Record prompt overrides, provider settings, and current campaign budgets without exposing credentials.
2. Disable new job intake temporarily and let running jobs complete or explicitly cancel them. Inventory queued/recoverable jobs and their protocol versions.
3. Apply only required additive migrations. Deploy API/runtime/worker binaries with the same protocol support; avoid a mixed-version worker pool consuming new jobs.
4. Mark incompatible old jobs recoverable with the upgrade code. Preserve their snapshots and rejected outputs under existing retention; do not reinterpret them under the new contract.
5. Canary using copies of one short campaign, one long campaign, one corrected-state campaign, and one event-heavy campaign. Exercise 32K and a genuinely supported larger provider window. Verify actual provider usage and latency; model-advertised capacity alone is not sufficient evidence that the endpoint is configured for it.
6. Re-enable intake after payload, commit, and next-turn checks pass. Watch overflow/recovery rates, extension failures, omitted recent-turn counts, token usage, and latency through existing telemetry.

### Rollback

- Stop new intake and drain/cancel new-protocol jobs before reverting binaries. Do not let an old worker consume new snapshot or extension semantics.
- Preserve additive schema changes and accepted turns. Roll back application code only where the old reader can represent accepted output; the increased thread bound and empty-summary semantics require an explicit compatibility test.
- If older binaries cannot read new accepted state, keep the compatible reader running while disabling generation. Do not truncate new state to force rollback compatibility.
- Restore a backup only as an explicitly coordinated recovery operation, accounting for turns accepted since that backup. No routine rollback deletes accepted turns.

### Existing campaigns

The code fixes prevent future loss; they do not prove previous memory is complete. Do not run automatic reconstruction that invents missing facts.

For a campaign with reported continuity loss, create a separate reviewable repair proposal using accepted narration, stored turn snapshots, and explicit state edits. Show current value, proposed value, source turn/revision, and ambiguity. Preserve later explicit user corrections over older generated snapshots. Apply an approved correction through the existing state-edit API with revision checks, then rebuild derived memory. If the password/fact exists nowhere in retained authority, label it unrecoverable rather than asking a model to guess.
