# Story-only campaigns: implementation design

Status: implementation in progress under the user's subsequent explicit authorization to implement the plan and correct gaps. Both active interfaces remain required deliverables.

## Objective

Make Story only an authoritative campaign policy with a short narrative generation path. Improve the relevance and repair behavior of its generated choices. Use the existing campaign turn-control selection as authority; preserve Action mechanics while Story Direction selects the short path for newly queued turns. RPG redesign is outside this phase.

## Product contract

1. Reuse the existing campaign **Turn input style / Turn control style** setting. Its Story Direction choice (stored as `flexible_scene`) selects story-only execution. `action_only` and `flexible_action` retain Action mechanics. Remove Auto from campaign creation/settings, profile defaults, and all per-turn controls. Normalize historical `flexible_auto` settings to `flexible_action` (Action) and make Action the default where Auto was the default; do not add another selector, toggle, or campaign mode field.
2. Internally derive `playMode: "legacy" | "story_only"` from that setting when enqueueing: `flexible_scene -> story_only`; the supported Action values map to `legacy`. `flexible_auto` is accepted only by historical compatibility readers and normalizes to `flexible_action`; it is not a new-write option. This discriminator exists only in the execution policy, not as a separately editable campaign property. Never infer it from stats. Existing campaigns already set to Story Direction use story-only execution for new jobs after upgrade; previously queued jobs and accepted turns retain their historical semantics. Document this intentional change; no conversion button or extra opt-in is required.
3. Story-only players see one editor and `Continue story`. Hide Action, Scene direction, Auto, intent confirmation, and mechanics controls. Preserve response length, context budget, drafts, multi-choice composition, auto-submit preference, history, and illustration controls.
4. Story-only input is narrative direction. Explicit events and dialogue should happen subject to authoritative world rules and corrected continuity. Unspecified outcomes follow plausible fiction; no statistical assessment, roll, difficulty, reward, or goal-completion classifier determines them. An action verb does not switch the workflow.
5. Generate narration and four concise, distinct, immediately relevant story directions in one response. Each direction must follow the final scene, avoid repeating completed developments, inventing hidden knowledge or prerequisites, or asserting an unsupported achievement. A deliberate requested reveal is allowed only where authority supports it. The custom suggestion must differ from the four choices.
6. Goals, relationships, mysteries, and open threads remain narrative continuity. Do not delete them to remove automated goal checks. This checkout's extra condition checks are event-trigger evaluations; there is no separately established universal goal-check subsystem in this design.

## Both active interfaces are required

Apply every user-facing change to legacy Nexus management (`/nexus/`) and Story (`/story/:campaignId`), and the new management/player UI under `/app/`. Cover existing campaign creation/edit controls, both legacy profile dialogs, new app-shell/preferences profiles, turn controls and help, choice submission, and obsolete classifier/provider setup controls. Auto must disappear from both clients. Reuse the same campaign setting and API; no separate toggle or mode UI.

The legacy files `apps/web/public/index.html` and `apps/web/public/story.html` are active application markup and are in scope; root `index.html` remains untouched. Both new Story presenters/renderers must reflect the changes. Where a new-UI entry links to an existing management page, update and verify that destination instead of building an unrelated replacement page.

Require separate legacy and new UI test/browser reports and desktop/mobile screenshots, plus a same-campaign cross-interface check: change the setting in one UI and verify it in the other after refresh. Preserve drafts, auto-submit preference, historical jobs, and settings-conflict behavior on both sides. One interface passing is insufficient for completion.

Both clients are part of the same feature release. Apply the plan's shared UI acceptance checklist separately to each client, including existing Story Direction campaigns on first load, all submission paths, historical Auto preference normalization, and settings changes saved from either interface. Neither UI may retain the previous per-turn behavior as a temporary exception.

## Execution contract

Successful ordinary path:

```text
owner-scoped enqueue and policy snapshot
  -> authoritative context and bounded Chronicle retrieval
  -> one story request containing narration, continuity, and choices
  -> local typed parsing, fiction-boundary and choice validation
  -> fenced transactional acceptance and asynchronous derived-work enqueue
  -> committed result projected into the player
```

Story only skips intent classification, RPG assessment/rolls, before/after trigger evaluation, pending-event instructions, event extensions, model scene/event coverage, and their rewrites. Do not persist fabricated successful coverage results. Ordinary story-only text generation needs exactly one narrative provider request, excluding retrieval embeddings, illustration work, and exceptional bounded repairs.

Keep ownership and campaign/world-version isolation, protected authority and context budgets, model-chain compatibility, complete replacement continuity semantics, output-limit recovery, cancellation/lease fencing, append/replacement uniqueness, and atomic accepted-turn/state/Chronicle writes. Keep choices unavailable for submission until commitment. Do not truncate history or continuity to meet a speed target.

Mechanical stats and configured trigger definitions remain stored but inert. Existing pending events stay dormant without being inserted into the fiction prompt, acknowledged, incremented, erased, or converted into narration. Ordinary story-only acceptance must preserve those fields byte-for-byte. The same rule applies to replacement and recovery. Current diegetic trackers still follow existing sanitization; this work does not resolve the wider tracker-routing review.

Separate scene-coverage verification is deliberately absent. Clearer instructions and quality evaluation mitigate omissions but do not prove semantic compliance. Strict direction checking is deferred, not a hidden setting to implement now.

## Existing setting, authority, and recovery

- Keep `campaigns.turn_control_style` as the sole campaign authority. No `campaigns.play_mode` column, new campaign mode API field, conversion endpoint, or conversion UI.
- Store a versioned immutable policy on each newly enqueued generation. Include the source `turnControlStyle` and derived execution discriminator; store actual policy provenance with accepted turns. Never derive an old job's behavior from today's campaign setting.
- Story-only enqueue normalizes valid legacy input-mode fields to Scene direction semantics on the server and bypasses classification consumption. Replayed idempotency keys return their original job; they do not reinterpret it. Client-supplied policy is not authority.
- Save changes through the existing campaign settings endpoint. Retain the selector with Action and Story Direction options, including switching back to Action. Switching away from Story Direction restores the existing workflow for future jobs; dormant mechanics and pending events become eligible under the existing rules. Do not redesign those rules or delete dormant data.
- A turn-control-style change shares campaign/state lock ordering with enqueue, checks expected style/turn/state revision, and refuses while queued/running/recoverable generation requires resolution. Preserve history and state, invalidate only this campaign's active model chains, and record the setting change in an owner-scoped activity event. An unchanged style submitted with other settings is not a mode transition.
- In-flight and recoverable jobs keep their snapshot. Historical missing policy is legacy only; malformed or unknown new policy fails closed with an actionable error. Unknown policy never defaults to story only or legacy.
- Recovery preserves policy, main draft, repair quota, and producing-request provenance. Mode changes cannot make a consumed repair free again.

## Remove automatic turn-type selection

Remove Auto as an active feature, not just a hidden option. Retire classification UI, confirmation/fallback state, client API calls, server provider dispatch, classifier prompts/helpers, dedicated intent-provider assignment controls, and classification writes. Remove the active classification endpoint; an owner-scoped 410 tombstone may remain for old clients and must never call a provider. New requests with Auto/classified input are rejected with an actionable refresh/use-campaign-setting error; valid explicit input still follows campaign authority.

Normalize existing campaign and profile Auto preferences to Action in the migration, and old imports/browser preferences through compatibility adapters. Preserve accepted turns, existing job requested/resolved modes and classification provenance, provider credentials/profiles, and historical audit rows. Already queued Auto jobs have a resolved mode and resume without reclassification. Keep only the historical schemas, frozen prompt keys/hashes, and archive/provider-role readers needed to read or recover those records. Do not drop classification tables or rewrite saved prompt snapshots in this phase. Mark retained compatibility code clearly and test that it is unreachable from new classification dispatch.

Automatic choice submission and bounded automatic response repair are unrelated features and remain intact. Action mechanics are preserved; removal of Auto does not authorize an RPG redesign.

## Choice-only repair

Use a local story-only parser that distinguishes choice errors from errors in narration or continuity. Exactly four choices and one nonempty custom suggestion are required. Reject normalized duplicates (NFKC, trim, whitespace folding, case folding) including the custom suggestion. Do not invent deterministic semantic checks for arbitrary prose.

When valid JSON has valid non-choice fields and only choice defects, save a durable repair checkpoint, request only replacement choices and custom suggestion, merge those fields into the preserved draft, and revalidate the entire object. The model may not replace narration, facts, trackers, or continuity through this repair. Send only fiction-safe context, not parser diagnostics, rejected mechanics-bearing choices, private assessments, or raw rejected JSON. Use a fixed safe reason code to select repair instructions.

Allow one automatic choice repair per draft under the existing overall automatic-repair discipline. Persist the consumed fence before dispatch. Failure is recoverable; a reclaimed lease does not repeat the provider call. An explicit retry follows the repository's bounded retry policy without rerolling or regenerating an already valid saved draft. General narrative/schema failure retains established bounded recovery; choice repair must not compound into multiple automatic full-story repairs.

## Prompt and compatibility policy

Use a separate versioned story-only protocol supplement over the existing frozen story template snapshot. Do not add required keys to historical `PromptSnapshot` records or change the legacy runtime-template hash algorithm. Snapshot the exact supplement and repair text, their hashes, and protocol identifier in the new generation policy. Account for the composed prompts in both campaign preparation and final serialized provider-request budgeting.

Legacy requests and template identities remain unchanged. Include story-only policy identity in stateful continuation compatibility, saved-draft compatibility, repair provenance, and accepted metadata. The repair request is stateless and cannot become the narrative continuation chain.

Portable exports must retain mode and dormant state, and must not be silently interpreted by old readers as legacy behavior. Use explicit compatible reader versioning; retain readers for older formats. Source provenance never establishes ownership. Campaign transfer and fork retain the existing turn-control style and accepted policy provenance; they do not inherit the setting from the destination world. Older archive settings follow the same mapping for future jobs, while imported historical turns remain historical.

## Release and validation

Use additive migrations and a coordinated compatible API/worker deployment; old workers must not claim story-only jobs. Before downgrade, stop intake and drain/cancel new-policy work, retain the additive schema and accepted turns, and retain a compatible reader. No automatic down migration or rewriting of saved campaign turn-control settings is permitted.

Required evidence: unit tests, real isolated PostgreSQL tests, both active Story routes, replacement renderer variants, desktop/mobile screenshots, synthetic call-count/latency benchmark, and a documented quality rubric. Live-provider evaluation is separate and uses only explicitly selected disposable fixtures; no live test is implied by unit success. No production deployment, main merge, or publication is part of plan preparation.

## Success criteria

- One narrative call on clean story-only output; zero intent/RPG/trigger/coverage/extension calls even with configured stats, triggers, and pending events.
- One extra choices-only call on a repairable choice failure, with identical accepted non-choice fields.
- Action mechanics and historical jobs remain unchanged; newly queued Story Direction jobs deliberately use the new path.
- Existing setting changes, retries, replacement, restart, import/export, and campaign transfer preserve setting and policy authority.
- Story-only controls appear correctly and cannot be bypassed by an older or malicious client to re-enable mechanics.
- Measured latency and quality results are reported with fixture/provider boundaries; no universal speed percentage is promised.

## Source anchors and required reading

- [Repository instructions](../../../AGENTS.md)
- [Domain documentation](../../agents/domain.md)
- [Repository overview](../../architecture/repository-overview.md)
- [Identity and ownership](../../concepts/identity-and-ownership.md)
- [Deployment runbook](../../runbooks/deployment.md)
- [Testing matrix](../../workflows/testing.md)
- [Open tracker-routing review](../../architecture/scene-context-mechanics-review.md)
- `services/runtime/src/generation-executor-adapter.ts`: orchestration, prompt budgeting, repair, and commit dispatch.
- `packages/database/src/generation-repository.ts`: enqueue/replacement validation and retry.
- `packages/database/src/generation-execution-repository.ts`: execution payload and acceptance.
- `packages/contracts/src/story-prompt.ts`: narrative wire schema.
- `packages/contracts/src/prompt-library.ts` and `packages/database/src/prompt-repository.ts`: strict snapshots and legacy identity.
- `apps/web-next/src/story-player-page.ts`, `packages/client-core/src/campaign-store.ts`: choice submission and committed-result projection.
