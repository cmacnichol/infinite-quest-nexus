# Nexus Prompt and Memory Subagent Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` to implement this plan task by task after the user authorizes execution. Dispatch a fresh implementer per task and an independent task reviewer afterward. Steps use checkboxes for tracking. This document is an implementation handoff, not an instruction to begin implementing when it is merely attached for review.

**Goal:** Fix original findings F1–F6, supporting issues A1/C1, and review findings R1–R7 without losing authoritative story state, shrinking configured context windows, or conflating text and image providers.

**Architecture:** Load complete generation authority separately from ranked optional history. A shared protocol, pure provider serializer, and one operation-aware budget planner produce the exact guarded request. Durable draft checkpoints, strict final-object validation, and guarded transactions bind accepted narration, continuity, events, and diagnostics to the same inputs.

**Tech Stack:** TypeScript, Node.js, pnpm, Vitest, PostgreSQL, existing LM Studio/OpenAI-compatible transports, existing browser test infrastructure.

**Spec:** [Nexus Prompt and Memory Remediation Specification](2026-09-05-nexus-prompt-memory-subagent-remediation-spec.md). This companion preserves the source plan's behavior, numeric limits, proposed planner, verification, deployment, rollback, and repair requirements, and incorporates R1–R7. Distribute both files together; the original Downloads file is provenance, not an execution dependency.

**Baseline:** Reviewed checkout `157c04dfd1e9a1290c5b9d30191bfdd7a55e75cc`, 2026-09-05. The original source used `3489aaaf1ed4fe1a9142f56ec03fdaa5cd7ce255`. Existing dirty `AGENTS.md` and `.claude/CLAUDE.md` belong to the user. Recheck the implementation checkout and applicable instructions before writing code.

## Global Constraints

- Keep `owner_user_id`, `campaign_id`, and `world_version_id` scope checks at every repository boundary. Identity comes from the server-resolved user, never browser fields.
- Accepted turns and explicit user corrections remain authoritative. Derived memory is rebuildable; absent facts cannot be invented during repair. Honor explicit empty corrections and turn-zero state.
- Replace-latest uses its historical base/cutoff. Capture complete resolved authority, including effective narration corrections, and reject stale state at commit.
- Rejected, cancelled, stale, incomplete, and incompatible jobs do not mutate accepted turns, campaign state, Chronicle memory, or trigger counters. Job-attempt diagnostics/checkpoints may be persisted privately under valid leases.
- Text and illustration providers remain independent. Preserve disabled/unavailable/incompatible image behavior and independent retries; illustration failures cannot fail accepted text.
- Preserve campaign presets **32,000 / 64,000 / 128,000 / 256,000 / 1,000,000**, provider maximum **4,000,000**, and memory maximum **1,000,000** tokens. **4,000** is a synthetic stress budget, not a new preset.
- Preserve configured output reserves, campaign settings, provider models, custom prompt text, and explicit corrections. Fail actionable oversized-state checks rather than silently trimming protected input or raising limits.
- Replacement bounds: scratchpad **100,000 characters**, summary **20,000 characters** with explicit empty allowed, open threads **500 entries / 4,000 characters each**, narration **200,000 characters**. Preserve other existing field bounds.
- Use exact compatible message/token framing when available with **256 tokens** transport headroom. Otherwise use the existing conservative estimator, **20% input-estimate allowance plus 1,024 tokens** overhead, and `countMode: estimated`. Calibration never licenses deleting protected state.
- Preserve lexical fallback, embedding compatibility, cutoff rules, retrieval comparison, and accepted-turn history. Keep private generation authority off public preview ports and serializers.
- Use existing package boundaries, two-space formatting, and shared typed validation. Contracts do not import runtime/story-engine implementations. Add no queue, vector store, agent framework, or generic workflow engine.
- Scope edits to this plan. Preserve unrelated user changes. Implementation uses one isolated checkout and one writer at a time. Checkpoint only assigned files; task acceptance requires independent review. Publication, merging, deployment, and live-data correction require the relevant user authorization.
- Keep model inputs, scratchpads, credentials, and rejected text out of normal logs/public diagnostics. Public diagnostics contain only whitelisted codes, safe numeric counts, and application-owned action/field keys.
- All tasks inherit the companion specification. A task is complete only after RED/GREEN evidence, associated-test review, and independent spec/quality approval; skipped integration/browser/provider tests are not passes.

## Controller runbook

1. **Start/resume:** Confirm explicit implementation authorization. Read current root/nested `AGENTS.md`, `docs/workflows/testing.md`, `docs/runbooks/deployment.md`, manifests, this plan, and its spec. Record SHA, branch, dirty paths, runtime versions, and the isolated checkout. Apply the worktree skill at execution time; do not change the user's main checkout to implement this plan.
2. **Ledger:** Use the SDD skill's workspace helper if available. Otherwise create a plan-specific git-ignored workspace at `.superpowers/sdd/2026-09-05-nexus-prompt-memory-subagent-remediation/` using native PowerShell; verify ignore behavior before storing private reports. Its `progress.md` starts with this plan's absolute path. Record task number, base/end SHA, agent ID, owned files, RED/GREEN commands, review verdicts, rulings, and remaining gates. Resume completed tasks from the ledger and Git rather than dispatching them again.
3. **Preflight:** Make a table of every pair of tasks sharing files/interfaces, plus one internal-consistency row per task. The serial order below resolves shared-writer conflicts. Resolve source drift and name/signature mismatches in the ledger before dispatch. Check the next available migration number rather than assuming 0083 is available.
4. **Dispatch:** Use a clean-context agent (`fork_turns: none`) and an available model/effort appropriate to the role. Give it the full task card, Global Constraints, the applicable Shared interface and fixture conventions entries, required spec excerpts, exact checkout, allowed files, prerequisite commit/interface report, and a task-specific report path. Do not send the entire conversation. Agents do not spawn other agents, change branches, publish, merge, deploy, or edit outside their assigned files.
5. **Ownership:** Run **one implementation agent at a time**. A read-only reviewer may run while the controller prepares a later brief against already accepted interfaces. Never review moving files: pin review BASE and HEAD, freeze the task diff, then dispatch review. The remaining concurrency slots are for independent read-only analysis, not concurrent executor/contract edits.
6. **RED → GREEN:** Implementer inspects the named source/tests, adds one focused failing regression, runs it, makes the smallest cohesive change, then runs associated coverage. Infrastructure failures do not count as RED. Newly proposed modules may initially fail to import; record that separately from a reproduced behavioral failure. Every changed file gets an associated-test review.
7. **Review/commit:** Implementer creates a scoped local checkpoint and reports its SHA and test evidence; it is unapproved until an independent reviewer checks spec compliance and task quality against the complete immutable BASE..HEAD diff. Both verdicts must be explicit. Controller returns actionable findings to the implementer, who checkpoints fixes for re-review. Accept the task only after review passes. Freeze task BASE before dispatch, not `HEAD~1` afterward.
8. **Progress:** Resolve routine reversible implementation choices from the spec and record a concise ruling. Continue through the dependency chain without repeated permission questions. Escalate only missing authority, destructive/external actions, or a material design conflict that cannot be resolved from the spec. Do not declare completion with unresolved integrity defects.
9. **Finish:** Run Tasks 11–12, obtain a whole-branch review, and produce a self-contained handoff. Preserve review evidence in the agreed durable record. Prepare PR text; pushing/creating an external PR is separate unless authorized. No partial task is a deployment milestone.

### Dispatch templates

**Implementer brief:** “Implement Task N in CHECKOUT. Read TASK_BRIEF first; it contains the exact requirements. Read SPEC_EXCERPTS and GLOBAL_CONSTRAINTS. Prerequisite code is pinned at BASE. You own OWNED_PATHS only. Use strict TDD and the specified tests; request a controller ruling before expanding ownership. Do not spawn agents or publish/merge/deploy. Write REPORT with status, changed files, signatures, RED failure, GREEN results, test skips, risks, and review notes. Return status and a short test summary.”

**Reviewer brief:** “Review the immutable BASE..HEAD diff/review package for Task N against TASK_BRIEF, SPEC_EXCERPTS, and GLOBAL_CONSTRAINTS. Remain read-only. Verify both spec compliance and task quality, including every named acceptance case and associated-test evidence. Report actionable findings with file/line and consequence; distinguish missing verification from demonstrated defects. Return separate spec and quality verdicts. Do not spawn agents.”

Uppercase dispatch fields are controller-substituted metadata, not unresolved product requirements. The controller writes real paths and immutable SHAs before dispatch.

## Coverage and task order

| Finding | Required result | Owning tasks |
| --- | --- | --- |
| F1 | Complete latest turn; truthful historical excerpts | 3, 5, 7, 11 |
| F2 | Complete scratchpad/base continuity; strict replacements | 1, 3, 6, 7, 11 |
| F3 | One final event-extended story and continuity object | 8, 9, 11 |
| F4 | Complete mandatory rules or explicit failure | 3, 5, 7, 11 |
| F5 | Every actual provider payload guarded | 4, 5, 7, 9, 11 |
| F6 | One shipped prompt definition and protocol identity | 1, 2, 12 |
| A1 | One selection/counting path; focused orchestration | 3–9, 12 |
| C1 / R1 | 500 threads through validation, correction, projection, reload, replay | 1, 6, 11 |
| R2 | Exact-draft resume/checkpoints and guarded commit | 2, 8, 9, 11 |
| R3 | Integrity errors escape fallbacks; safe public diagnostics | 1, 7, 10, 11 |
| R4 | Sent-and-authorized IDs; no text-supersession bypass | 6, 7, 9, 11 |
| R5 | All due event fiction verified before trigger hits | 9, 11 |
| R6 | Immutable snapshot identity across retry/reclaim | 1, 2, 8, 11, 12 |
| R7 | Extension input/output/narration feasibility | 5, 9, 11 |

Execute **1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10 → 11 → 12**. This order intentionally places serializer construction before budget integration and protocol/retry compatibility before runtime activation. Task cards are separate review units, not releases.

## Shared interface and fixture conventions

All new APIs below are proposed, not claims about existing exports. Final signatures go into each task's report and must match consuming tasks; controller-approved mechanical adaptations use existing repository types instead of duplicate schemas.

- **Contracts (Task 1):** shared `STORY_SYSTEM_PROMPT`, `STORY_PROMPT_PROTOCOL_VERSION`, `STORY_CONTEXT_POLICY_VERSION`, `MAX_CONTINUITY_OPEN_THREADS = 500`, strict new-protocol output validation, `safeGenerationDiagnosticSchema`, and its inferred `SafeGenerationDiagnostic` type. Preserve existing engine compatibility exports. `SafeGenerationDiagnostic` has allowlisted `code`, `operation`, `action`, optional safe `field`, and optional nonnegative integer `requiredTokens`, `availableTokens`, `requiredCharacters`, `availableCharacters`; no arbitrary strings/metadata. Code/action/field semantics are defined in spec R3.
- **Generation identity (Task 2):** private `GenerationBaseIdentity` includes owner/campaign/world-version, operation kind, base turn number/ID, correction revision, effective narration revision, and authoritative content fingerprint. Task 2 creates `packages/database/src/generation-authority.ts` with `resolveGenerationAuthoritySnapshot(client, scope)`; `client` is the caller-owned `DatabaseClient`, and `scope` carries owner/campaign/world-version, operation kind, and requested base cutoff. It returns typed complete authority plus `baseIdentity`, as defined by `ResolvedGenerationAuthority` in application memory types. This single resolver constructs the same authority/fingerprint for enqueue and execution; Task 3 reuses it rather than reconstructing or rehashing the fields independently. Protocol identity includes template hashes and explicit schema/policy versions. Use versioned existing private JSON storage when adequate; an additive migration is permitted if durable representation requires it.
- **Memory (Task 3):** `loadGenerationContext(database, scope)` returns private `{ authority, candidates, baseIdentity }` using existing memory port/composition conventions. `authority` contains complete safe rules, replacement state, selected character identity, latest accepted action/narration, correction, and referenced current facts. Candidate provenance carries source ID/revision, scope, ordinal, kind, ranking, and excerpt/summary truthfulness. History never substitutes for a missing authority field.
- **Transport (Task 4):** `serializeProviderRequest(profile, request)` returns a canonical JSON body for the existing LM Studio/OpenAI payload. `PreparedProviderRequest` contains the body, payload hash, operation, and checked budget audit. Adapt existing request/profile types. The sender sends this body verbatim and never adds history, truncates a draft, or rebuilds messages after checking.
- **Budget (Task 5):** implement `ContextBlock`, `ContextBudgetInput`, `ContextBudgetResult`, and `planContext` exactly as specified in companion section 5. Scope/chronology/provenance stay in renderer maps keyed by `(id, revision)`. The renderer uses Task 4 serialization; the selected output's serialized request is sent verbatim.
- **Parsing/facts (Task 6):** keep the parser's existing success/error union, add explicit protocol/visible-base-fact validation, and name historical normalization separately. `superseded_facts` must be empty in new output. Preserve existing addition semantics without double-applying structured and legacy additions.
- **Checkpoint (Task 8):** private versioned checkpoint contains `baseFingerprint`, `protocolVersion`, `executionInputHash`, `mainDraft`, `mainDraftHash`, bound after-events/extension/final-coverage results, repair-use state, and optional validated `finalStory`/`finalStoryHash`. Each draft/final object also stores or immutably references `producingAttemptId`, `producingOperation`, `payloadHash`, and `sentFactIds` from its actual producing request. Later coverage calls do not replace this provenance. Existing lease/attempt guards apply to every write. No checkpoint appears in public schemas.

Unit snippets below are assertion cores to insert into the named suites, using imports from the task's declared module. Integration SQL snippets use the suite's existing isolated `pool` and fixture campaign/owner IDs; agents must bind those names to real seeded fixture values. They are not new production helper APIs.

### Task 1: Establish shared protocol, replacement bounds, and diagnostic contracts

**Depends on:** controller preflight. **Addresses:** F6, C1, R1/R3/R6 foundations.

**Files:** create `packages/contracts/src/story-prompt.ts`; modify `packages/contracts/src/prompt-library.ts`, `generation.ts`, `memory.ts`, `index.ts`, `packages/story-engine/src/prompt.ts`, and `packages/database/src/prompt-repository.ts`. Read `services/runtime/src/provider-application-composition.ts` for protocol consumers. Tests: `tests/unit/prompt.test.ts`, `prompt-library.test.ts`, `generation.test.ts`, and `tests/integration/prompt-library.integration.test.ts`.

**Consumes:** shipped templates, catalog resolution, editable-state bounds. **Produces:** shared templates/constants and typed strict-new versus historical validation boundaries; safe diagnostic schema; protocol identity shared by snapshots and engine exports.

- [ ] Reproduce catalog/engine drift before consolidation. Add this assertion with real exported imports:
  ```ts
  expect(PROMPT_TEMPLATE_CATALOG.story_system.defaultContent).toBe(STORY_SYSTEM_PROMPT);
  expect(STORY_SYSTEM_PROMPT).toContain("currentContinuity");
  ```
- [ ] Add schema cases for explicitly empty summary/scratchpad/threads, missing required replacement fields, 150/500 valid threads, and 501 rejected threads. Keep a fixture for old stored/import output that only the named compatibility parser accepts.
- [ ] Move shipped system/recovery literals into the contracts module; preserve rendering/substitution and engine re-exports. Introduce shared thread bounds without changing unrelated fact limits. New schema includes all replacement fields; legacy compatibility remains an explicit separate entry point.
- [ ] Compose protocol identity from shared protocol/schema/policy versions and resolved template hashes. Preserve application/campaign precedence and byte-for-byte override content. Define the immutable wire envelope and required-shape preview; compatibility acknowledgement/resolution is completed in Task 10.
- [ ] Define a strict allowlisted safe diagnostic schema; preserve generic public error fields. Test unknown codes, negative counts, arbitrary message fields, and a scratchpad canary cannot enter this schema.
- [ ] Run `pnpm exec vitest run tests/unit/prompt.test.ts tests/unit/prompt-library.test.ts tests/unit/generation.test.ts`. Run prompt-library integration with the isolated harness before approving snapshot changes. Report exact exports and protocol version selection to Task 2.
- [ ] Independent spec/quality review; checkpoint summary: `Unify story prompt and continuity contracts`.

**Done:** one shipped definition, required replacement fields, shared finite limits, unchanged override storage, and explicit protocol/diagnostic contracts. Existing runtime callers still compile through a deliberately named compatibility boundary until Task 7 switches new execution.

### Task 2: Snapshot authority identity and enforce retry/protocol compatibility

**Depends on:** 1. **Addresses:** R2/R6 and stale-base safety.

**Files:** create `packages/database/src/generation-authority.ts`; modify `packages/database/src/generation-repository.ts`, `generation-execution-repository.ts`, `packages/application/src/generation/{ports,types,use-cases}.ts`, `packages/application/src/memory/types.ts`, `services/runtime/src/generation-api-composition.ts`, and an additive `database/migrations/` file only if required. Read existing `campaign-continuity-repository.ts` reconstruction helpers and reuse/extract the relevant authority reads instead of duplicating them. Tests: `tests/integration/generation-repository.integration.test.ts`, `generation-execution-repository.integration.test.ts`, `tests/unit/application/generation-use-cases.test.ts`; create `tests/unit/generation-authority.test.ts`.

**Consumes:** Task 1 protocol identity. **Produces:** shared `resolveGenerationAuthoritySnapshot`/`ResolvedGenerationAuthority`, durable `GenerationBaseIdentity`, unchanged compatible-retry snapshots, incompatible-job rejection, lease/commit guards for later checkpoints.

- [ ] Add RED cases for append and replace-latest enqueue capturing the correct base, including narration/state corrections and turn zero. Add old-protocol manual retry and expired-lease reclaim cases. Compare stored content before/after the rejection:
  ```ts
  expect(after.prompt_snapshot).toEqual(before.prompt_snapshot);
  expect(after.prompt_protocol_version).toBe(before.prompt_protocol_version);
  expect(providerCalls).toHaveLength(0);
  ```
  Here `before`/`after` are actual job-query rows and `providerCalls` is the existing mock transport's captured request list.
- [ ] Implement the shared transaction-owned authority resolver and persist the snapshotted campaign context setting and complete authority identity when enqueueing, without repurposing replace-latest-only fields for append. Reuse existing reconstruction/locking rules; the content fingerprint excludes derived-index timestamps. Add repeated-resolution equality tests across turn zero, cleared corrections, effective narration edits, and replacement cutoff; report its exact shared return type to Task 3.
- [ ] Replace `retry()`'s unconditional protocol rewrite with compatibility validation. Preserve compatible template-hash identity; incompatible retries/reclaims retain snapshots and return the upgrade diagnostic. Explicit discard/re-enqueue uses normal idempotency with a new key.
- [ ] Guard payload load, private checkpoint writes, and commit against wrong scope, expired/stale lease, and changed authoritative base. Establish consistent lock order with existing campaign-state edits. Test a correction and narration edit racing generation; exactly one compatible state wins.
- [ ] Test current protocol, older protocol, malformed snapshot, repeated idempotency key, cancellation, and two claimant leases. Record whether existing JSON storage suffices; if a migration is needed, add next-number migration and migration-order/idempotency coverage.
- [ ] Run the named unit suite and isolated generation repository/execution suites. Review and checkpoint: `Guard generation snapshots across retries`.

**Done:** no old job receives a current label without a current snapshot; later tasks can persist/check the same base identity durably.

### Task 3: Load complete private generation authority independently of retrieval

**Depends on:** 1–2. **Addresses:** F1/F2/F4, historical isolation.

**Files:** create `packages/database/src/chronicle-generation-context.ts`; modify `packages/database/src/chronicle-context-repository.ts`, `campaign-continuity-repository.ts`, `packages/application/src/memory/{ports,types,index}.ts`, `services/runtime/src/memory-composition.ts`, and necessary memory application adapters/barrels. Tests: `tests/unit/chronicle-transaction-repository.test.ts`, `campaign-continuity-repository.test.ts`, `chronicle-runtime-adapter.test.ts`, `tests/integration/chronicle-contract-matrix.integration.test.ts`.

**Consumes:** scoped base identity and existing correction reconstruction. **Produces:** private `loadGenerationContext` authority/candidates result and unchanged sanitized preview contract.

- [ ] Seed a final-sentence death, a late password in 100K scratchpad text, a final mandatory rule, empty correction, absent derived rows, and replace-latest cutoff. Assert equality to complete authoritative fixtures:
  ```ts
  expect(actual.authority.latestTurn?.narration).toBe(expectedNarration);
  expect(actual.authority.scratchpad).toBe(expectedScratchpad);
  expect(actual.authority.rules).toEqual(expectedRules);
  expect(actual.authority.openThreads).toEqual([]);
  ```
  Bind `actual` to the new private port result; expected values are fixture source bytes, not values obtained from retrieval.
- [ ] Call Task 2's `resolveGenerationAuthoritySnapshot` in a short consistent snapshot transaction to obtain state, correction, rules, selected identity, latest accepted effective action/narration, and referenced facts. Validate against the enqueued identity; do not create a second reconstruction or fingerprint implementation. Assert enqueue-versus-private-load fingerprint equality for unchanged turn-zero/corrected/replacement fixtures, then assert deliberate authority changes reject. Complete the transaction before network embedding work.
- [ ] Fetch optional ranked candidates separately while honoring the same historical cutoff and scope. Do not use `costAttribution.operation` to choose privacy semantics. Turn zero has no latest turn and is valid.
- [ ] Reject unsafe mandatory legacy rules with `authoritative_context_invalid` and a safe field key. Validate complete fiction-safe authority rather than sanitizing away a rule or replacing an explicitly empty correction with older generated text.
- [ ] Test embeddings disabled/missing/rebuilding, cross-owner/campaign/world canaries, future facts/aliases, and public preview attempts to request private data. Keep retrieval comparison and lexical fallback intact.
- [ ] Run named unit suites and isolated contract matrix. Review and checkpoint: `Load complete generation authority`.

**Done:** completeness derives from accepted authority, not embedding readiness or an optional-memory budget.

### Task 4: Extract canonical provider serialization before budget integration

**Depends on:** 1. **Execute after:** 3, to keep the writer sequence simple. **Addresses:** F5/A1 foundation.

**Files:** create `packages/story-engine/src/provider-request.ts`; modify `providers.ts` and engine barrel exports. Create `tests/unit/provider-request-budget.test.ts`; extend `tests/unit/providers.test.ts`.

**Consumes:** existing provider profiles/request shapes and operation identity. **Produces:** pure `serializeProviderRequest`, typed prepared payloads, and transport support for sending an already prepared body.

- [ ] Capture current LM Studio and OpenAI-compatible bodies, including streaming, recovery, output reserve, temperature, model, and message framing. Assert exact transport equality:
  ```ts
  expect(capturedBody).toBe(prepared.body);
  expect(JSON.parse(capturedBody)).toEqual(expectedPayload);
  ```
  `capturedBody` is the raw body recorded by the mock transport; `expectedPayload` is an explicit provider-specific object in the test.
- [ ] Extract serialization without changing unrelated authoring/image/import callers. New story requests use self-contained recovery, no `previous_response_id`, and complete or entirely omitted rejected drafts. Keep old caller compatibility named until Task 7 migration.
- [ ] Ensure the sender cannot add history, slice rejected text, or reconstruct messages after preparation. Hash the exact body sent; exclude credentials/headers from persisted payload metadata.
- [ ] Test newline/quote/backslash/unicode escaping, callbacks that do not serialize, and provider-specific output-reserve fields. Exact tokenizer integration counts actual messages and framing; label HTTP-JSON estimation as conservative estimation.
- [ ] Run `pnpm exec vitest run tests/unit/provider-request-budget.test.ts tests/unit/providers.test.ts`. Review all existing provider callers for accidental shape changes. Review and checkpoint: `Centralize provider request serialization`.

**Done:** counting and sending can consume the same immutable payload; no budget policy has to guess a different serialization.

### Task 5: Implement one deterministic planner and output-feasibility policy

**Depends on:** 3–4. **Addresses:** F1/F4/F5, R7 foundation.

**Files:** create `packages/story-engine/src/context-budget.ts`; modify `chronicle.ts` and engine exports. Create `tests/unit/context-budget.test.ts`; extend `tests/unit/chronicle.test.ts`, `provider-request-budget.test.ts`.

**Consumes:** companion section 5 interface, private block provenance, Task 4 serializer. **Produces:** `planContext`, safe typed budget errors, output skeleton counting usable by story/extension operations.

- [ ] Write deterministic RED boundary tests with an injected character counter before implementation:
  ```ts
  expect(() => planContext({
    blocks: [{ id: "latest", revision: "1", content: "x".repeat(100), protected: true, priority: 0, ordinal: 1 }],
    contextLimit: 50, inputLimit: 1000, count: value => value.length,
    serializeContext: value => JSON.stringify(value),
    serializeRequest: value => JSON.stringify({ context: value })
  })).toThrowError(/context_budget_exceeded/);
  ```
- [ ] Validate limits, deduplicate identical ID/revision records, reject conflicting content, measure protected blocks first, and pack whole optional records by priority/ordinal/stable ID. Skip an oversized candidate and continue. Render chosen records chronologically within each scope.
- [ ] Enforce separate campaign context and final request ceilings; include immutable envelope/action/instructions/draft outside context in request accounting. Apply exact/estimated safety allowances once. Never lower output reserve to make input fit.
- [ ] Preserve latest turn once and in full. Replace historical `Outcome:` prefix labeling with verified summary/checkpoint or clearly labeled excerpt with source/omission metadata. Test empty history, tie order, escaping, and omitted recent-turn diagnostics.
- [ ] Add output feasibility tests for unchanged replacement fields and minimal JSON. Add extension skeleton cases including full preserved narration and at least one appended character. Distinguish token overflow from narration-character overflow; every failure occurs before transport.
- [ ] Run `pnpm exec vitest run tests/unit/context-budget.test.ts tests/unit/chronicle.test.ts tests/unit/provider-request-budget.test.ts`. Review and checkpoint: `Plan protected context and output budgets`.

**Done:** both ceilings are enforced by one policy and protected bytes survive unchanged; a configured 1M ceiling does not pad a small request.

### Task 6: Preserve complete continuity projections and restrict fact mutations

**Depends on:** 1–3, 5. **Addresses:** F2/C1/R1/R4.

**Files:** `packages/story-engine/src/output.ts`, `packages/domain/src/chronicle-memory-helpers.ts`, `packages/database/src/chronicle-repository.ts`, `chronicle-state-correction-repository.ts`, `generation-execution-repository.ts`, and necessary contract refinements. Tests: `tests/unit/generation.test.ts`, `chronicle-helpers.test.ts`, `campaign-continuity-repository.test.ts`, `tests/integration/chronicle-repository.integration.test.ts`, `generation-execution-repository.integration.test.ts`.

**Consumes:** complete base values, strict contract, per-attempt sent-fact IDs. **Produces:** strict new parser/commit validation, complete thread projections, explicit clearing, isolated historical supersession behavior.

- [ ] Reproduce the downstream cap using distinct safe threads, then require the explicit shared bound:
  ```ts
  const threads = Array.from({ length: 500 }, (_, index) => `Find the lost letter ${index + 1}.`);
  expect(sanitizeChronicleMemoryLines(threads, MAX_CONTINUITY_OPEN_THREADS)).toEqual(threads);
  ```
  Also assert all 500 survive real accepted-turn projection and direct correction; the helper assertion alone cannot complete this task.
- [ ] Pass the shared thread limit in both generation and correction projection paths. Keep generic fact limits unchanged. Ensure explicit empty summary clears the current projection without deleting historical accepted snapshots; absent historical fields retain compatibility semantics. Replay must reproduce both clearing and all distinct threads.
- [ ] Require summary/scratchpad/threads from new output and remove default recap/history substitution. Keep historical/import normalization explicitly selected; do not use it on a new-protocol provider response.
- [ ] Require `superseded_facts` empty for new output. Validate structured supersession IDs against actual sent IDs intersected with active authorized base facts, then repeat authorization under the commit lock. Invalid IDs roll back the transaction instead of being recorded as an unmatched-success metadata field.
- [ ] Test guessed text for an omitted same-campaign fact, cross-scope IDs, future/expired IDs, duplicate text/different IDs, valid supersession, and historic import/replay. Preserve established additions without concatenating duplicate sources.
- [ ] Run named unit suites and isolated Chronicle/execution suites. Review and checkpoint: `Preserve continuity projections and fact authority`.

**Done:** editor-valid 500-thread state survives every named path; only authorized, actually visible facts can be superseded by new generations.

### Task 7: Wire private authority, guarded requests, and integrity-error propagation

**Depends on:** 1–6. **Addresses:** F1/F2/F4/F5, A1/R3/R4.

**Files:** `services/runtime/src/generation-executor-adapter.ts`, `packages/story-engine/src/providers.ts`, `services/api/src/generation-diagnostics.ts`, memory composition/adapters, and application generation error/result types. Tests: `tests/unit/generation-executor-adapter.test.ts`, `providers.test.ts`, `generation-diagnostics.test.ts`; create `tests/unit/generation-integrity-errors.test.ts`; extend `tests/integration/generation.integration.test.ts`.

**Consumes:** complete authority, immutable serialized requests, planner, strict parser, diagnostics. **Produces:** one active selection/sending path and common recoverable integrity-error handling.

- [ ] Capture a request that fits initially but exceeds capacity after recovery text. Verify the checked body is the sent body and invalid protected input sends zero requests. Test complete rejected-draft inclusion versus total omission for clean regeneration; never prefix-truncate.
- [ ] Replace the `buildContextPreview` private accounting switch with `loadGenerationContext`; remove `removalPriority`/`splice` trimming. Prepare each request using the common serializer/planner. Record actual selected IDs/revisions and per-operation omission causes after planning.
- [ ] Guard story, schema/mechanics repair, scene checking/rewrite, RPG assessment, before/after triggers, and extension/event-coverage operations. Deliberately omit unneeded history for an operation before planning; keep needed draft-referenced fact records protected.
- [ ] Classify typed integrity errors before broad stage catches and rethrow them to the common recoverable handler. Known provider-context overflow is recoverable; unknown provider text stays private/generic. Cancellation/lease loss cannot overwrite the current claimant's status. Preserve existing fallback only for explicitly eligible non-integrity assessment/trigger failures.
- [ ] Add a parameterized stage/error matrix. For every integrity error, assert `markRecoverable` receives only safe diagnostics, `commitAcceptedTurn` is never called, and no fallback call/scene rewrite hides the error. Assert the existing database state/counters are unchanged in the composed integration fixture.
- [ ] Persist per-attempt protocol/policy/base identity, provider/model identity, budgets, reserve, count mode, safety, payload hash, sent sources, omissions, and actual usage privately. Do not call retrieval candidates “sent context.” Allocate operation/stage/attempt identities so additional coverage/extension attempts cannot collide with the old two-attempt numbering scheme.
- [ ] Run named unit suites and isolated generation integration. Review and checkpoint: `Guard every generation operation and failure path`.

**Done:** every touched story-workflow provider call uses the common guard, and an integrity error cannot be silently converted into accepted state.

### Task 8: Persist exact-draft checkpoints and resume stages safely

**Depends on:** 2, 6–7. **Addresses:** R2/R6.

**Files:** `services/runtime/src/generation-executor-adapter.ts`, `packages/database/src/generation-execution-repository.ts`, `generation-repository.ts`, private generation types. Create `tests/unit/generation-checkpoint.test.ts`; extend `tests/integration/generation-execution-repository.integration.test.ts` and `generation.integration.test.ts`.

**Consumes:** base/protocol/execution-input identity and validated story. **Produces:** versioned private checkpoints, durable repair-use state, exact-draft resume path.

- [ ] Add a retry fixture whose second model narration would differ from the first. Interrupt after validated-main-draft checkpointing and after after-event persistence. Assert retry reuses the first validated draft, or explicitly invalidates all draft-dependent stages before choosing a new one.
- [ ] Persist main draft/hash and immutable producing-request attempt/payload/sent-fact provenance before after-event evaluation. Bind after-events, extension, final checks, final story, and provisional illustration references to the same identity. A stored extension error is a retryable stage outcome, not a skip-forever boolean. Resume/commit validates against the draft/final object's producing request, not the latest audit row or newly packed candidates.
- [ ] On compatible reclaim, resume the exact checkpoint with no duplicated main-generation call. On changed base/protocol/provider-effective-input identity, reject or require explicit supported restart/re-enqueue; never silently combine checkpoints. Preserve base-dependent roll/before-events only when their own identity matches.
- [ ] Persist automatic content-repair consumption across crashes. One automatic repair per stage/draft is the limit; explicit user retry creates a distinct bounded attempt. Guard all writes with current lease and attempt.
- [ ] Interrupt after extension persistence and before commit; take over the lease and attempt a stale write/commit. Include a latest coverage attempt with different fact visibility and prove resumed commit uses the final-story producer's allowlist. Assert one final accepted object and no duplicate fact/tracker application. Example database cardinality gate in the seeded fixture:
  ```ts
  const accepted = await pool.query(
    "SELECT count(*)::int AS n FROM turns WHERE campaign_id=$1 AND owner_user_id=$2 AND turn_number=$3",
    [campaignId, ownerUserId, expectedTurnNumber]
  );
  expect(accepted.rows[0]?.n).toBe(1);
  ```
- [ ] Run `pnpm exec vitest run tests/unit/generation-checkpoint.test.ts tests/unit/generation-executor-adapter.test.ts` and the isolated execution/generation suites. Review and checkpoint: `Resume generation from exact validated drafts`.

**Done:** retries/reclaims cannot apply stale draft-dependent events or reset repair limits invisibly.

### Task 9: Finalize event fiction, continuity, feasibility, and trigger lifecycle together

**Depends on:** 5–8. **Addresses:** F3/R2/R4/R5/R7.

**Files:** `packages/story-engine/src/mechanics.ts`, `scene-coverage.ts`, `packages/contracts/src/prompt-library.ts`, `services/runtime/src/generation-executor-adapter.ts`, `packages/database/src/generation-execution-repository.ts`; necessary existing illustration reconciliation adapters. Tests: `tests/unit/mechanics.test.ts`, `generation-executor-adapter.test.ts`; create `tests/unit/event-finalization.test.ts`; extend `tests/integration/generation.integration.test.ts`, `image-pipeline.integration.test.ts`.

**Consumes:** complete protected context, action, validated main draft, due-event fiction requirements, original-base facts/trackers, checkpoint identity. **Produces:** one validated final `StoryTurnOutput` and exactly-once event accounting.

- [ ] Add RED cases for the old partial extension shape, missing continuity, rewritten prefix, valid unrelated suffix, one omitted event among several, contradictory event, unauthorized fact ID, and token/character infeasibility before transport.
- [ ] Build the complete extension request and output skeleton, including full preserved narration. Apply input, configured output reserve, and 200K narration-bound checks before sending. Test exact-fit/one-over and escaped JSON boundaries without reducing protected fields.
- [ ] Require the complete output shape. Normalize paragraphs consistently, require unchanged main narration plus nonempty appended passage, and validate all output contracts/mechanics/fact IDs against the original base. Select the final object's update arrays once; never concatenate main/final updates.
- [ ] Validate original scene requirements where applicable and every currently due event's fiction requirements in action and scene modes. Use existing coverage capability with per-event IDs and safe fiction beats; malformed/limited/unavailable checks are not coverage success. Deferred after-events remain pending rather than being required in this suffix. Task implementation must follow the spec's due/deferred occurrence accounting.
- [ ] On failed event fulfillment, repair once within the persisted stage allowance, preserving the main prefix, then rerun every final validation. Exhaustion becomes recoverable with no turn/counter/continuity mutation. Persist coverage/final-object hashes into the checkpoint and guard commit against a different object.
- [ ] Reconcile provisional illustration segments with the final accepted narration; orphan stale material through existing lifecycle. Verify disabled/unavailable/incompatible images, independent retries, and image failure after successful text acceptance.
- [ ] Assert an event introduced by the extension resolves its thread and appears in next-turn continuity; an unrelated suffix does not increment hits. Verify tracker deltas apply once and all due event occurrences are fulfilled once across retry/reclaim. Do not recursively trigger new extensions in this change.
- [ ] Run named unit suites and isolated generation/image suites. Review and checkpoint: `Validate complete event stories before commit`.

**Done:** final narration, choices, image prompt, facts, summary, scratchpad, threads, and trigger accounting reflect the same accepted story.

### Task 10: Expose safe diagnostics and prompt compatibility in existing UI flows

**Depends on:** 1–2, 7–9. **Addresses:** R3/R6 and override compatibility.

**Files:** `packages/contracts/src/generation.ts`, `client-api.ts`, `packages/database/src/campaign-state-repository.ts`, `generation-repository.ts`, `prompt-repository.ts`, `services/api/src/server.ts`, `services/runtime/src/generation-api-composition.ts`, `packages/client-core/src/generation/projection.ts`, `apps/web-next/src/story-player-generation.ts`, `story-player-view.ts`, `apps/web/src/story-generation-monitor.js`, `story.js`, and `apps/web/public/nexus.js` for the existing Prompt Library. Extend the existing prompt application/API contract files identified by their current barrel exports when exposing acknowledgement metadata. Preserve original root `index.html`. Tests: `tests/unit/client-api-contracts.test.ts`, `client-api-routes.test.ts`, `generation-diagnostics.test.ts`, `prompt-library.test.ts`, `tests/unit/client-core/generation-workflow.test.ts`, `tests/integration/generation-events.integration.test.ts`, `prompt-library.integration.test.ts`; add `tests/e2e/generation-integrity-diagnostics.e2e.test.ts` beside the existing `quiet-leaf-story.e2e.test.ts` harness for changed browser flows. Reconfirm these paths at dispatch and record moved-file successors.

**Consumes:** safe diagnostic schema and protocol compatibility decisions. **Produces:** consistent additive `diagnostic` projection across polling/SSE/recovery UI and explicit override-compatibility workflow.

- [ ] Add contract RED tests proving the current API strips actionable information. Preserve existing generic error fields while projecting a nullable safe diagnostic. Test polling, SSE, and initial campaign recovery hydration with identical safe counts/action keys.
- [ ] Route every public serializer through the same allowlisted projector, including `generationPublicError` callers and campaign-state recovery projection. Unknown failures retain generic copy. Example rejection assertion with the actual Task 1 schema:
  ```ts
  expect(safeGenerationDiagnosticSchema.safeParse({
    code: "context_budget_exceeded", operation: "story_generation", action: "adjust_context",
    requiredTokens: 33000, availableTokens: 32000, scratchpad: "PRIVATE_CANARY"
  }).success).toBe(false);
  ```
  Task 1 must export `safeGenerationDiagnosticSchema` and include the fixed `adjust_context` action key used here.
- [ ] Display desired/effective context, output reserve, and protected shortfall with application-owned copy. Identify whether the user must adjust settings, deliberately edit oversized state, repair imported rules, update/acknowledge an override, or discard/re-enqueue incompatible work. Preserve presets and do not change settings automatically.
- [ ] Add an override compatibility notice and shipped required-shape preview for changed continuity/extension formats. Preserve text bytes and precedence. Persist explicit acknowledgement/version metadata through the existing prompt storage boundary; avoid inferring arbitrary natural-language compatibility by substring tests. Changed compatibility metadata must participate in future snapshot resolution/identity as appropriate.
- [ ] Test stored creative overrides, incompatible old extension instructions, compatible acknowledged overrides, resetting to shipped defaults, unchanged text hashes, and rejection without a provider call. Keep private snapshot/rejected text out of previews.
- [ ] Run named unit/integration tests, render changed browser surfaces, and capture screenshots for shortfall/upgrade/override flows. Review and checkpoint: `Expose safe generation recovery guidance`.

**Done:** the user can act on every defined recoverable condition without receiving private prompt/provider data; generic unexpected errors remain generic.

### Task 11: Verify the composed workflow, replay, isolation, and large-window scaling

**Depends on:** 1–10. **Addresses:** every finding and release acceptance.

**Files:** create `tests/integration/story-continuity-remediation.integration.test.ts`; add sanitized fixtures under `tests/fixtures/`; extend affected generation, Chronicle contract-matrix, prompt-library, public-event, and image tests only where composed cases need support. Use existing deterministic provider and isolated PostgreSQL helpers rather than a separate test engine.

**Consumes:** real enqueue → private context → captured provider → validation → checkpoint → commit → next-turn/replay path. **Produces:** a finding-to-test evidence matrix with actual execution results.

- [ ] Run three accepted turns establishing a late password, final-sentence death, and extension-resolved thread. Compare complete next-prompt authority and committed state after each. Include character identity, final world rule, and a corrected narration.
- [ ] Exercise scratchpad around 1K/10K/100K characters, narration near 200K, threads 0/100/150/500 with 501 rejected, empty fields, and safe legacy/import compatibility. Assert exact authority equality and thread retention after direct correction and rebuild.
- [ ] Exercise 4K synthetic, 32K/64K/128K/256K/1M configured budgets with compatible windows, plus desired 1M against 128K provider. Test invalid requested limits/reserves, empty history, exactly-once latest turn, omitted recent counts, and larger-budget retention of additional whole records.
- [ ] Cover append/replace-latest/turn zero, empty corrections, cross-owner/campaign/world canaries, future/superseded aliases/facts, stale revisions, duplicate submissions, cancellation, two workers, lease takeover, all Task 8 interruption points, and old-protocol retry/reclaim. Check no rejected commit/trigger/canonical mutation.
- [ ] Disable embeddings, remove derived projections, and rebuild. Authority remains available and replay reconstructs current facts/summary/threads without inventing facts. Keep lexical and comparison behavior covered.
- [ ] Cover every operation's budget/error matrix and payload hash against persisted audit; sent-source IDs exclude omitted candidates. Test private canaries against logs, polling, SSE, recovery hydration, and previews. Include event omission/contradiction/timeout, text supersession bypass, and input-versus-output infeasibility.
- [ ] Record planner wall time/peak memory or equivalent existing measurement at realistic candidate counts and 1M budgets. Report measured values and compare repeated runs rather than claim constant-time behavior; investigate repeated whole-request serialization if it causes material regression.
- [ ] Run `pnpm test:unit`, `pnpm test:integration`, `pnpm check`, `pnpm build`, and `git diff --check` under the implementation checkout's pinned toolchain. Browser checks/screenshot review are required for Task 10. Record unexecuted/failed infrastructure gates separately and keep release blocked until required gates actually pass.
- [ ] Independent review checks the complete F1–F6/A1/C1/R1–R7 evidence matrix. Checkpoint: `Verify prompt integrity across turns and recovery`.

**Done:** each finding has composed regression evidence; mocked checks are explicitly distinguished from live model-quality canaries.

### Task 12: Consolidate, review the whole branch, and prepare safe delivery

**Depends on:** 11. **Addresses:** A1, compatibility, deployment/rollback and existing-campaign handling.

**Files:** affected package exports and superseded implementations; create `docs/architecture/story-context-integrity.md` as a short architecture decision with alternatives; update `docs/runbooks/deployment.md`, `docs/workflows/testing.md`. Update associated tests for any final code change.

**Consumes:** reviewed complete branch and test evidence. **Produces:** one active context/protocol/serialization path, whole-branch review, exact upgrade/rollback/repair handoff, draft PR text.

- [ ] Search for duplicate shipped prompt literals, `removalPriority`, prompt-time protected-field clipping, prefix-as-outcome, default-100 thread calls, new-protocol text supersession, unconditional retry protocol rewriting, cached extension skip flags, and repair `previous_response_id`. Classify every remaining match as removed, intentional historical/other-workflow compatibility, or a defect to fix.
- [ ] Remove superseded code only after caller searches and associated tests establish the boundary. Preserve unrelated provider operations, lexical fallback, comparison, import/history readers, and public privacy contracts. Refresh Repowise only when current indexed context is needed; do not treat stale synthesized data as evidence.
- [ ] Document source authority, budget equations/allowances, operation guard list, output feasibility, exact-draft checkpoint/resume behavior, due/deferred event accounting, safe errors/actions, override acknowledgement, old-job rejection, and known tokenizer/model-quality limits.
- [ ] Carry the companion spec's deployment sequence into the runbook: backups/settings inventory, stop intake, drain/cancel, inventory old jobs, additive migrations, synchronized compatible binaries, old-job classification, copied-campaign canaries, and re-enable only after checks. Implement no deployment actions in this task.
- [ ] Document rollback reader tests for empty summaries/500 threads and new snapshots; preserve accepted turns/additive schema. If old readers cannot represent new state, keep compatible readers while generation is disabled. Backup restoration remains an explicitly coordinated operation.
- [ ] Document existing-campaign repair as a separate source-linked proposal with current/proposed values, source revision, ambiguity, later-correction precedence, and approved revision-checked state edits. Lost facts with no retained source are unrecoverable; no automatic model reconstruction.
- [ ] Obtain an independent whole-branch spec/quality review against the immutable baseline and all task commits. Fix remaining findings and rerun affected gates; produce final exact-SHA test/skip evidence and UI screenshots. Review the complete diff for unrelated changes and run `git diff --check`.
- [ ] Checkpoint summary: `Document story integrity upgrade and rollback`. Prepare PR title/body covering user-visible changes, architecture, migration/rollback, protocol/schema/public API changes, tests, and limitations. Leave publish/merge/deploy to authorized follow-up.

**Done:** all requirements have accepted implementation and evidence; the final handoff distinguishes completed local verification from external deployment/canary gates.

## Commands, environment, and final handoff

- Task unit commands run from the implementation checkout. Verify the pinned package-manager version in `package.json` first. If `pnpm exec vitest` fails to resolve an existing Windows binary, `& .\node_modules\.bin\vitest.cmd run <named suites>` is a diagnostic fallback; report toolchain differences and do not silently install/repair unrelated dependencies.
- Full integration uses `pnpm test:integration` (`scripts/run-isolated-integration.mjs`, per-file process execution). A focused suite uses `pnpm exec vitest run --config vitest.integration.config.ts <named integration file>` only with a disposable, authorized `TEST_DATABASE_URL` prepared through the existing harness. Test files can skip when this variable is absent; skipped suites do not satisfy a gate. Never point them at the user's live campaign database.
- The controller keeps the source plan unchanged and records this plan's implementation rulings locally. After execution, report task commits, changed files, actual RED/GREEN and full-gate results, screenshots, migration decisions, compatibility behavior, and remaining external canaries. The plan authoring pass does not check implementation boxes or imply fixes are already present.

## Plan-authoring review record

- Source design and release requirements are preserved in the companion specification; original implementation instructions were replaced by the task/controller structure here.
- Findings F1–F6/A1/C1 and R1–R7 map to named tasks and verification cases above.
- Shared writers run serially, serializer precedes guard integration, and compatibility/base identity precede new runtime execution.
- An independent requirements audit confirmed both generated and corrected thread-projection call sites, public serialization dependencies, retry identity risks, and due-versus-deferred event distinctions.
- Implementation, publication, migration, deployment, and live-data repair have not been performed by creating these documents.
