# Character Automation Implementation Plan

**Implementation record:** Work is implemented on `codex/characters-revamp` in the dedicated worktree. See the [acceptance report](../../review/campaign-cast/revamp-acceptance.md) for final evidence, reviewed deviations and verification limits. The original task checklists below are retained as the planning specification; they are not a deployment approval.

> **For agentic workers:** Implement in the dedicated worktree using `gpt-6.1-terra` subagents where practical. Follow the execution and minimal-test policy in the overview; it overrides broader test-addition instructions in earlier plans. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce repeated identity review while keeping every automated attachment evidence-linked, correctable, and safe across story lifecycle operations.

**Architecture:** Extend the current discovery validator and durable jobs with a frozen identity policy. Record portable automatic-attachment metadata alongside cast events; derive profiles and recency from retained, non-detached evidence. Keep inexpensive text mentions separate from confirmed character observations.

**Tech Stack:** Existing TypeScript/Zod contracts, pure domain functions, PostgreSQL adapters, Fastify routes, and Vitest integration harness.

**Spec:** [Revamp overview](2026-11-06-characters-revamp.md). Its constraints, scope, dependency order, and release gates apply to every task. Incorporates [October Tasks 1–8 and 10](2026-10-04-campaign-cast-auto-match.md); execute the amended requirements here instead of copying the old implementation verbatim.

## Global constraints

- No relaxation of exact-source, source-revision/hash, hypothetical/instruction, attribute, speaker-claim, owner, or campaign validation.
- An identity match does not approve unsupported attributes or change aliases. A lexical mention does not establish presence or a new fact.
- All authority mutations use expected cast revision, timeline boundary, idempotency, and current generation-lock checks; detach additionally identifies the affected character revision.
- Existing snapshots and old frozen discovery plans remain readable. A live environment flag is not a stored job policy.
- Default `CAST_AUTO_MATCH_ENABLED=false`; effective only with editing and discovery enabled. Disabling it prevents new relaxed admissions and lexical mention work, but does not remove authority or disable undo.
- Preserve current discovery limits: 120-second new-plan timeout and 4,096 output tokens, bounded further by provider limits; retain old admitted timeout compatibility. Do not introduce extra provider calls for matching or mentions.

## Test scope

Follow the overview's minimal new-test policy. The scenarios below are a checklist against existing coverage, not a mandatory new-case list. Extend the owning existing suite only for a demonstrated gap; do not duplicate checks across tasks or layers. Red/green steps apply only to new or changed regression cases.

## Review focus

False joins despite unique names (A1); policy changing between dispatch and publication (A3); undo leaving lexical recency behind (A2/A4); exported authority losing undo capability (A2); approving a stale or non-fiction withheld value (A5). Each has an explicit test below.

## File ownership

| Area | Existing files | New files |
| --- | --- | --- |
| Policy/protocol | `packages/domain/src/campaign-cast-discovery.ts`, `packages/contracts/src/campaign-cast-discovery.ts`, `packages/contracts/src/prompt-library.ts` | Decision record selected in A1 |
| Authority/portability | `packages/contracts/src/campaign-cast.ts`, `packages/database/src/campaign-cast-repository.ts`, `packages/database/src/campaign-cast-portability.ts`, `packages/database/src/campaign-cast-lifecycle.ts` | `packages/domain/src/campaign-cast-attachments.ts` |
| Publication/jobs | `packages/database/src/campaign-cast-discovery-publication.ts`, `packages/database/src/campaign-cast-job-repository.ts`, `services/runtime/src/campaign-cast-discovery-adapter.ts` | Additive migration selected in A2/A3 |
| Mentions | `packages/database/src/generation-execution-repository.ts` | `packages/domain/src/campaign-cast-mentions.ts`, `packages/database/src/campaign-cast-mentions.ts` |
| API/use cases | `packages/application/src/campaign-cast/{ports,types,use-cases}.ts`, `services/api/src/campaign-cast-routes.ts`, `packages/client-web/src/campaign-cast-api.ts` | `packages/contracts/src/campaign-cast-review.ts`, `packages/database/src/campaign-cast-review-repository.ts` |
| Configuration | `packages/database/src/config.ts`, `services/runtime/src/{main,provider-application-composition,campaign-cast-composition,generation-executor-adapter}.ts`, `compose.yaml`, `deploy/swarm/stack.yaml`, `.env.example` | None |

Export new public types/functions through the corresponding existing `src/index.ts` barrels. Do not restructure the large generation adapter beyond the required hook.

### A1: Define and test graduated matching and frozen protocol compatibility

**Files:** Policy/protocol rows above; `tests/unit/campaign-cast-discovery.test.ts`, `tests/unit/campaign-cast-provider-contract.test.ts`, `tests/unit/campaign-cast-discovery-adapter.test.ts`; new `docs/architecture/0041-campaign-cast-unique-name-matching.md` if still unallocated, plus architecture index.

**Interfaces:**

- `CastIdentityPolicy = "strict" | "unique_name"`.
- `CastIdentityBasis = "new_identity" | "corroborated" | "unique_name" | "unique_world_name" | "user_confirmed"`.
- Extend `validateCastDiscovery` input with optional `identityPolicy`, default `strict`; accepted results include `identityBasis`.
- Extend the saved discovery admission/plan contract with `identityPolicy` and a prompt identifier. Decode omitted policy as `strict`; never infer it from current configuration.
- Preserve trusted v1 prompt content exactly. Add v2 matching guidance. The extraction output remains `cast-discovery-v1`; the prompt/plan identity changes independently.

- [ ] Extend existing cases only where missing to the existing fixture helpers. Assert `run(uniqueName, selectedKnownId, "unique_name").accepted[0].identityBasis === "unique_name"`; the same input with omitted policy remains unresolved. Assert a null model ID with a matching campaign person remains unresolved, duplicate aliases remain unresolved, and an ID belonging to another campaign is rejected.
- [ ] Run `pnpm exec vitest run tests/unit/campaign-cast-discovery.test.ts tests/unit/campaign-cast-provider-contract.test.ts` and record intended failures only for the necessary new cases.
- [ ] Implement policy branching only at the current corroboration decision. Match against the complete scoped identity snapshot, including ignored characters and identities omitted from the provider's bounded hint list. Hidden UI rows must not manufacture uniqueness. Existing guards and strict behavior remain unchanged. A unique world-only match can establish world provenance when there is no competing campaign identity; conflicting world IDs remain unresolved.
- [ ] Check existing cases for same-name new arrivals, a model-declined match, generic titles, same-name protagonist/supporting character, unsupported aliases, prospective narration, dialogue claims, source instructions, case changes, and omitted-hint collisions. Change both prompt and validator; do not ask the provider to follow the old corroboration rule while validating with the new one.
- [ ] Verify frozen v1 admission parses and stays strict, v2 plus `unique_name` parses, and unknown prompt hashes/policy combinations reject before dispatch. Run the three named unit suites.
- [ ] Record the decision and commit as `Define graduated cast identity matching`. The ADR must explicitly distinguish mention, established identity, and physical presence and reference the amended October policy.

### A2: Make automatic attachments and detach portable authority

**Files:** Authority/portability row, application/API/client rows, `packages/contracts/src/campaign-cast-discovery.ts`; extend existing `tests/unit/campaign-cast-projection.test.ts`, `tests/integration/campaign-cast-lifecycle.integration.test.ts`, and existing contract/portability/API fixtures only where needed.

**Interfaces:**

- `CastSourceRange = { turnId, narrationRevision, sourceHash, paragraphId, start, end }`: offsets are zero-based UTF-16 into the exact source paragraph, end-exclusive. Validate `paragraph.slice(start,end) === quote` and unique location when converting legacy quote-only evidence. Repeated ambiguous quotes require review, not guessed offsets.
- `CastAttachment = { eventId, characterId, basis, sourceRanges, observationIds }`; `basis` is `unique_name | unique_world_name`. Store this validated descriptor in the cast event's durable metadata. One automatic candidate publication owns one attachment event; do not detach unrelated candidates in a shared event.
- Extend the internal command union with `{ kind: "detach", characterId, eventId }`. The target must be a preceding automatic-attachment event for that character in the same campaign. Reject protagonist, foreign, future, arbitrary manual, and already-detached targets except identical receipt replay.
- Detail returns `autoMatches: Array<CastAttachment & { turnNumber, quote }>`; UI never requires a retained discovery candidate to undo.
- `POST /cast/:characterId/attachments/:eventId/detach` accepts `castWriteBase` plus `expectedCharacterRevision`; returns the updated cast result and `detachedEventId`. Add `CampaignCastApi.detachAttachment(campaignId, characterId, eventId, input)` and matching application port.
- Retain a candidate-addressed `/cast/candidates/:candidateId/detach` adapter for the October interface only when the candidate resolves to a current attachment. Both paths use the same application operation and receipt semantics.

- [ ] Extend existing contract/projection coverage only where missing: detach suppresses only the target attachment's observations/mentions, preserves user overrides, and keeps other characters and other source ranges untouched. Test a detach earlier/later than a requested history boundary.
- [ ] Run `pnpm exec vitest run tests/unit/campaign-cast-contract.test.ts tests/unit/campaign-cast-projection.test.ts` and verify intended failures only for necessary new shape regressions.
- [ ] Implement `projectCastAttachments(events, boundary)` in the new domain module and reuse it for roster/detail/generation projections. Retained detach excludes its attachment's evidence. Source correction invalidates both the evidence and descriptor. Detach is a new event, never a destructive rewrite of accepted history.
- [ ] Introduce cast archive payload v2 with optional event attachment metadata and source-range metadata; retain a strict v1 reader that normalizes to the internal representation. Export v2 consistently after this change. Unknown newer versions fail explicitly. Update all aggregate Campaign/System Archive contracts and references found by searching `portableCampaignCastSchema` and `formatVersion`, not just the local importer.
- [ ] Add the required additive migration after checking the current migration inventory (`0116` is already used). Preserve applied migrations. Remap attachment event IDs, character IDs, turn IDs, observation IDs, and detach targets in branch/transfer/import. Exclude operational candidates and receipts, but retain attachment metadata needed for undo. Validate all mapped references before writes. A detached event no longer in retained history cannot leave a dangling command.
- [ ] Extend existing PostgreSQL lifecycle/portability fixtures only for uncovered behavior involving detach after candidate cleanup, archive round trip, System Archive round trip, branch, cross-world transfer, rewind before detach, source correction, same-key replay, conflicting key reuse, active generation, stale character/cast revisions, and foreign owner. Assert the protagonist profile never changes.
- [ ] Run `pnpm exec vitest run --config vitest.integration.config.ts tests/integration/campaign-cast-lifecycle.integration.test.ts tests/integration/campaign-cast-portability.integration.test.ts tests/integration/campaign-cast-api.integration.test.ts`; require executed cases, not skips. Commit as `Preserve undoable cast attachments across history and archives`.

### A3: Publish under captured policy with recoverable undo metadata

**Files:** Publication/jobs and configuration rows; `packages/database/src/campaign-cast-candidate-repository.ts`; existing `tests/integration/campaign-cast-discovery.integration.test.ts`; existing discovery worker/adapter/config tests.

**Interfaces:** `applyValidatedCastDiscovery` consumes the claim's stored policy; no callback to current runtime configuration selects the validation policy. The runtime flag determines policy only when preparing a new admitted plan. Job publication returns the existing durable receipt plus attachment IDs where created. Gate/capability responses expose whether new auto-matching is available.

- [ ] Extend existing integration coverage only where missing for a worker restart after checkpoint, duplicate publication, gate changes between dispatch and publication, and reusing a strict historical scan plan after auto-match enablement. Assert one authority event per candidate and zero additional provider requests on checkpoint recovery.
- [ ] Run `pnpm exec vitest run --config vitest.integration.config.ts tests/integration/campaign-cast-discovery.integration.test.ts` and verify a necessary new regression fails for the intended missing behavior.
- [ ] Freeze v2 plus `unique_name` only for new eligible admissions. Existing plans without policy remain strict. Disabling discovery still prevents claims/publication under its existing gate. Disabling only auto-match stops new relaxed plans but allows already admitted relaxed jobs to publish with their captured semantics; disclose this drain behavior in the runbook.
- [ ] Publish accepted observations, identity mentions, attachment metadata, coverage, and candidate disposition atomically. Candidate state may project `auto_applied`, but authority and undo do not depend on that row. An automatic world-origin creation that is detached keeps the identity record with no unsupported portrayal; return its source to review when available. Do not silently delete it.
- [ ] On detach, reopen a retained candidate for identity review. If it was cleaned up or not imported, reconstruct an identity-only review item from current accepted source plus the durable descriptor; no paid re-extraction, and no reconstruction from invalidated source. A new manual attach/create decision uses the existing validated identity path. Store a fresh attribution event so a prior detach never suppresses the new decision.
- [ ] Plumb `CAST_AUTO_MATCH_ENABLED=false` through configuration, all runtime roles, Compose, both Swarm services, and `.env.example`. Extend the existing configuration table only for the new flag dependency. Keep detach available with editing enabled even if auto-match/discovery is disabled.
- [ ] Run config, worker, adapter, API, and discovery unit suites and existing PostgreSQL discovery/backfill tests with the new matching assertions. Update the operations guide with gate drain semantics and commit as `Publish cast matches with frozen policy and durable undo`.

### A4: Record inexpensive mentions without inventing presence

**Files:** Mentions row; `packages/contracts/src/campaign-cast.ts`, `packages/domain/src/campaign-cast-context.ts`, lifecycle and attachment projection files; `services/runtime/src/generation-executor-adapter.ts`; provisionally new `tests/unit/campaign-cast-mentions.test.ts` for the lexical matcher; extend existing `tests/integration/campaign-cast-generation.integration.test.ts` for transaction effects.

**Interfaces:**

- `findCastMentions(source: CastDiscoverySource, characters: readonly CastCharacter[]): CastMention[]`, with `{ characterId, paragraphId, quote, start, end }` and exact source offsets.
- `recordAcceptedTurnCastMentions(client, scope, turnId, onError): Promise<void>` wraps optional work in a savepoint.
- Extend mention commands with optional `kindOfMention: "lexical"` and range metadata; absent means existing established observation semantics. Expose `lastMentionedTurn: number | null` separately from existing `lastObservedTurn`, defaulting absent values to null when reading older responses.
- Textual recency may influence context relevance, never `state.location`, identity aliases, or claimed presence. Discovery coverage watermarks advance only through discovery, not lexical mentions.

- [ ] Use one compact parameterized matcher regression table for uncovered cases: whole-name/alias match, duplicate aliases, common-word names (`Hope` versus `I hope so`), Unicode boundaries, repeated names, quote offsets, protagonist exclusion, ignored collisions, and overlap with detached attachment ranges. An unambiguous text reference may be recorded in dialogue/hypothetical text but must be labeled lexical and never establish an actual encounter.
- [ ] Run `pnpm exec vitest run tests/unit/campaign-cast-mentions.test.ts tests/unit/campaign-cast-context.test.ts`; verify intended failures for any necessary new matcher cases.
- [ ] Implement exact case-sensitive Unicode-aware name boundaries against the complete campaign identity set. Skip generic single-word title aliases and unresolved collisions rather than guessing. Deduplicate identical ranges; bound each quote to 1,000 characters at whole boundaries. Do not split a UTF-16 surrogate pair. Prefer missed enrichment to wrong identity evidence.
- [ ] Invoke the database hook after accepted narration is durable inside the acceptance transaction's savepoint, on append and latest-turn replacement. Reuse effective corrected narration. Apply equivalent reconciliation on correction and retained-history rebuild; add no provider call and no new failure dependency to story acceptance. Log only bounded diagnostic IDs/codes, never private fiction.
- [ ] Extend attachment projection: a detach excludes lexical associations for the same character whose ranges overlap that attachment's identity evidence on the same source revision/hash. Other ranges in the turn remain. A later explicit review decision can reattach that appearance through a fresh authority event. Rewind before detach restores only evidence valid at that boundary. Persist/export the range metadata so suppression survives rebuild and transfer.
- [ ] Extend existing PostgreSQL fixtures only where needed for append, replacement, correction, rewind, duplicate hook invocation, job retry, missing cast state, cast-hook database error, and import/branch remapping. Assert story commit survives injected mention failure, `lastObservedTurn` is unchanged by lexical work, detached ranges do not affect `lastMentionedTurn`, and unrelated same-turn references remain.
- [ ] Run the mention unit suite and `pnpm exec vitest run --config vitest.integration.config.ts tests/integration/campaign-cast-generation.integration.test.ts tests/integration/campaign-cast-lifecycle.integration.test.ts`. Commit as `Track source-linked character mentions independently of discovery`.

### A5: Resolve withheld details without laundering uncertain output into facts

**Files:** New review contract/repository in file map; candidate repository; application ports/use cases; cast routes/client adapter; existing `tests/unit/campaign-cast-application.test.ts` and `tests/integration/campaign-cast-api.integration.test.ts`.

**Interfaces:**

- Extend candidate query with `view: "details"`, filtering before pagination. Each item includes candidate ID, stable original observation index, resolved character ID, source revision/hash, field/value/quote, and withheld reason. Do not use an array index after filtering as identity.
- `ReviewCastDetail = castWriteBase & { expectedCharacterRevision, observationIndex, sourceHash, action: "confirm" | "dismiss", confirmedValue?: string }`.
- Validate that request as a discriminated union: confirm uses the proposed value when `confirmedValue` is absent and preserves an explicitly empty string; dismiss rejects `confirmedValue`. Confirmed text must satisfy the existing field bound and fiction validator.
- `POST /cast/candidates/:candidateId/details/resolve`; `CampaignCastApi.resolveDetail(campaignId, candidateId, input)` returns updated revisions and disposition. Confirmation is an explicit **user correction**, stored through the existing override command with user audit evidence; it is not relabeled as an automatically verified fact.
- A dismissal suppresses only that proposal/source revision/observation hash in the operational inbox. It does not delete accepted history or create a negative fact. Keep this disposition separate from portable authority; confirmed overrides are portable.

- [ ] Extend existing coverage only where missing: identity resolution leaves withheld fields visible under details; stable index survives filtering; blank confirmation remains an intentional override; dismiss leaves profile unchanged; retry uses one receipt; stale/foreign/invalidated source rejects; mechanics/private-reasoning content still rejects even after a user clicks confirm.
- [ ] Run the existing application and API integration suites to verify intended failures for necessary new cases; reuse existing passing coverage otherwise.
- [ ] Implement one transaction for revision/source validation, override application when confirming, disposition, and idempotent receipt. Resolve owner on the server. Reject unresolved identities and protagonist targets; link those to the existing protagonist editor instead. Cap one request to one field and preserve original evidence separately from edited text.
- [ ] Make dismissal idempotent by source/observation hash. A changed narration revision produces a new proposal; display it as new evidence. Rewind discards future review decisions consistently with cast overrides. After archive import, prior operational dismissals are absent; no queue is recreated until explicit discovery/scan supplies evidence. Explain this limit in the runbook.
- [ ] Add decision/field-resolution counters to existing bounded diagnostics, without names or quotations. Test conflict recovery and failure between override and disposition leaves neither half applied.
- [ ] Run review, API, contract, projection, and lifecycle tests; commit as `Add explicit review for withheld character details`.

### A6: Verify lifecycle compatibility and prepare gated rollout

**Files:** `docs/runbooks/campaign-cast.md`, `docs/workflows/testing.md`, new `docs/review/campaign-cast/revamp-acceptance.md`; configuration and archive documentation touched by A2/A3.

**Interfaces:** Release evidence names the application commit, migration inventory, prompt identities, v1/v2 archive compatibility, enabled gates, and exact test commands. U6 adds browser evidence to the same report.

- [ ] Use the integrated release-candidate run shared with U6 for affected unit tests, PostgreSQL evidence, and the full documented release checks in the overview. Do not add separate review/mention integration suites. Extend the existing composed deterministic-provider fixture only for missing steps: accepted turn → lexical mention → discovery publication → next-turn context → detach → corrected next-turn context, with zero cross-campaign evidence.
- [ ] Exercise all-off, editing-only, discovery-on/auto-off, auto-on/context-off, and all-on configurations. Verify Story Memory Off retains its existing generation policy. Confirm a provider outage leaves accepted story and manual editing intact.
- [ ] Test v1 archive import and v2 round trips, unknown newer versions, and a v2-aware application with automation gates off. Do not claim an old v1-only binary can roll back safely after v2 authority exists. Back up first; deploy compatible readers before enabling writers, and retain additive migrations.
- [ ] Use the existing discovery/generation fixtures for a small deterministic before/after comparison; do not create a 100-turn corpus, new benchmark harness, or a separate acceptance test suite. Require zero false joins in explicit ambiguity fixtures and fewer identity-review items in the ordinary-return fixture set. Report the fixture size, review-item counts, auto attachments, and provider-request counts available from those same runs; do not substitute a detach rate for measured identity correctness.
- [ ] Document live rollout as a separate copied-campaign canary: no automatic production enabling, historical scan, or paid request. Operator disablement retains undo, source history, and compatible frozen-plan readers. Record unperformed live validation as skipped, not passed.
- [ ] Commit as `Document and verify character automation rollout`. This track is implementation-complete only after U4 supplies working undo and A6 evidence is recorded; rollout readiness additionally requires U6.
