# Structured output 04: durable selection and recovery implementation plan

> **For agentic workers:** Use `superpowers:subagent-driven-development`; fresh gpt-5.6-terra implementer and fresh Terra reviewers.

**Goal:** Bind every new response contract to its job and producing attempt while preserving historical resume and explicit format repair.

**Architecture:** Enqueue freezes policy and route identity in server-owned metadata. A leased, idempotent preflight resolves and persists operation contracts before any provider attempt; restart reuses those contracts. Existing configuration drift checks remain active.

**Tech Stack:** TypeScript, Zod, PostgreSQL, deterministic streaming provider, Vitest.

**Spec:** [Index](2026-09-18-structured-output.md). Depends on patches 01–03; highest-risk patch, reviewed independently before UI work.

## Files and interfaces

- Modify `packages/contracts/src/generation.ts`, `story-memory-policy.ts`, `generation-review.ts` only where validated checkpoint metadata needs extension; `packages/application/src/generation/types.ts`, `ports.ts`; `packages/database/src/generation-repository.ts`, `generation-execution-repository.ts`.
- Modify `services/runtime/src/generation-api-composition.ts`, `generation-worker-composition.ts`, `provider-application-composition.ts`, `generation-executor-adapter.ts`, `story-continuity-review-adapter.ts`; read `fact-format-repair-adapter.ts` before touching its binding inputs.
- Create `services/runtime/src/generation-response-contract.ts`, `tests/unit/generation-response-contract.test.ts`, `tests/integration/generation-response-contract.integration.test.ts`.
- Extend `tests/unit/story-memory-policy.test.ts`, `generation-executor-adapter.test.ts`, `continuity-review-checkpoint.test.ts`, `story-continuity-review-adapter.test.ts`; integrations `generation-review.integration.test.ts`, `story-continuity-review.integration.test.ts`, `story-only-choice-repair.integration.test.ts`.

New validated server-owned envelope (never copied from browser `context_options`):

```ts
type QueuedResponsePolicy = Readonly<{
  version: 1; policy: "auto" | "required";
  providerProfileId: string; model: string; endpointIdentity: string;
  providerConfigurationHash: string;
  verificationRegistryHash: string;
  operationClosureVersion: 1;
  invocationKeys: readonly ResponseInvocationKey[];
}>;
type ResponseInvocationKey = `${ResponseSchemaOperation}:${"stream" | "nonstream"}`;
type FrozenResponseContracts = Readonly<{
  version: 1; queuedPolicy: QueuedResponsePolicy;
  selectedAt: string; capabilityEvidenceHash: string;
  contracts: Readonly<Partial<Record<ResponseInvocationKey, PreparedResponseContract>>>;
  selectionHash: string;
}>;
```

`resolveGenerationResponseContracts` consumes the queued policy, current profile identity, verified eligibility per operation and registry entries; returns a complete frozen envelope or a finite preflight failure. Required means all structured story-workflow operations this job can invoke have verified contracts. Auto resolves each operation independently; diagnostics disclose mixed schema/JSON-object selection. No envelope for legacy jobs. Schema bodies may be persisted in the envelope with digest checks; do not regenerate old bodies from a mutable registry.

Version-1 invocation closure is identical for append/replacement and enrolled/non-enrolled jobs after resolving frozen play/review policies: always include `story:nonstream` (Retry and full-story follow-up calls); additionally include `story:stream` when the frozen profile enables streaming for the first primary; include `choices:nonstream` only for `playMode=story_only`; include `continuity_review:nonstream` only when frozen review mode is observe/enforce. Local fact-format repair, RPG assessment and event-trigger assessment add no schema invocation. Optional continuity repair returns full story and is already covered by `story:nonstream`. Assert every runtime invocation belongs to the saved set; an unexpected key fails before dispatch. Each saved key requires one validated contract and matching streaming-mode verification; no unused key is required. A future new call path increments the closure version.

Persist this private attempt metadata through explicit repository/port types alongside existing request/response evidence:

```ts
type AttemptResponseContractAudit = Readonly<{
  version: 1; selectionHash: string; invocationKey: ResponseInvocationKey;
  mode: "json_object" | "json_schema";
  schemaVersion: string | null; schemaHash: string | null;
  requestedModel: string; providerRoutingSlugs: readonly string[];
  returnedModel: string | null; returnedProviderRoute: string | null;
  diagnosticCode: string | null;
}>;
```

Validate `diagnosticCode` against the finite error enum from patch 03, not arbitrary strings. Save immutable request-side fields at reservation; complete nullable response-side fields once with the response, using existing lease/idempotency guards. Missing response metadata stays null. Reporting reads the safe projection, never parses private prompt/response bodies. PostgreSQL tests assert all fields for success, rejection, refusal, partial stream and restart and prohibit changing request-side identity on finalization.

## Task 1: enqueue and preflight

- [ ] RED: append/replacement, Action/Story Direction and enrolled/non-enrolled jobs capture exact selected/default provider policy and route; attempts to inject the envelope through a client request are rejected/ignored. Missing policy preserves old job shape/hash. Duplicate enqueue retains the original selection and creates no extra job.
- [ ] Store queued policy in private validated job metadata using existing JSON storage; carry through explicit repository types. No schema migration is expected. If a dedicated column proves necessary, use a separate additive migration after re-reading the deployment runbook; never overload user-authored context fields.
- [ ] RED: required unknown/incompatible support produces a safe recoverable capability failure and zero generation attempts. Auto unknown selects JSON-object once. Network discovery occurs outside campaign transactions. Compare route/config identity again before reserving work, preventing a profile-change race. Enqueue captures the API's operator-registry digest; a worker with another digest fails safely before selection and reports configuration mismatch. Record reloads require coordinated restart; new jobs then capture the new digest, while already selected jobs use their saved contracts.
- [ ] Implement preflight before primary reservation. Persist the full selection with an existing lease/compare-and-set guard; two workers may fetch metadata but only one selection wins, and only the valid lease can reserve/dispatch. Cache lookup is not a provider generation call.
- [ ] Expired evidence during first preflight is refreshed/rejected according to policy. Once selected, expiry never changes the saved mode on resume; provider rejection remains a bounded failure. Required preflight failure may be explicitly retried after verification is available because no primary was dispatched; do not invent a repair receipt for it.

## Task 2: operation binding and exact identity

- [ ] RED route table: primary, explicit Retry primary, extension and full-story continuity repair use story schema; choice-only repair uses choices; review uses continuity_review. Every canonical budget/hash prepared in a helper equals the eventual transport body. RPG assessments/event-trigger discovery retain their own original contract and never inherit story format.
- [ ] Replace the current `repairResponseFormat` two-value inference with version-aware selection. Historical body without schema keeps old reconstruction; a new body must match its exact saved mode/version/hash. No "any response_format means json_object" inference.
- [ ] Bind response-contract selection hash into new provider/checkpoint identity without changing `effectiveProviderConfigurationFingerprint` outputs for old callers. A versioned wrapper can hash `{ legacyProviderHash, responseContractSelectionHash }` only for new jobs. Schema/mode/operation/routing changes invalidate reuse.
- [ ] Preserve v16 prompt text. Add response-contract metadata to execution compatibility, not to historical prompt identifiers. Existing acknowledged overrides still apply; a later new wire shape would require its own prompt protocol.
- [ ] Reuse saved contracts when continuing/reviewing/retrying a new job. Provider endpoint/model/settings drift yields the existing incompatibility workflow, not automatic adoption. Do not claim this plan snapshots credentials or enables old jobs to run against arbitrarily changed profiles.

## Task 3: provenance, repair and restart matrix

- [ ] RED real-PostgreSQL cases: crash before selection, after selection/before dispatch, after response capture, after review pause, after repair authorization and after commit. Assert bounded dispatch and idempotent commit. Duplicate workers and stale receipts cannot select another contract or mutate accepted state.
- [ ] Feed a deliberately schema-violating deterministic provider response through normal validation. Existing eligible fact-format repair may still be offered with unchanged consent semantics; strict mode is not proof of validity. Keep original raw response/request/schema hash plus separate repair provenance.
- [ ] Add the missing nested tracker fixture through parse → eligible fact repair → restart → semantic review → commit. Assert the protected tracker data survives in the accepted private snapshot and that private fields do not enter illustration/semantic review projections improperly.
- [ ] Trace synthetic diegetic and mechanics-contaminated tracker values through mechanics assessment, narrative validation, Chronicle projection and fiction-only illustration prompts. Assert current rejection/sanitization behavior is preserved for each boundary; do not claim the separate tracker domain-design question is resolved by this feature.
- [ ] Verify unknown checkpoint/schema versions fail closed with refresh/incompatibility guidance. Historical v1/v2 reviews and v13/v15/v16 jobs retain original hashes and meanings. Profile policy changes cannot rewrite old receipts or authorize a new primary response.
- [ ] Enforce cross-owner/campaign/world isolation and unchanged acceptance on refusal, truncated output, invalid schema, unavailable route and semantic conflict. Snapshot and compare accepted ledger, campaign state, canonical facts, Chronicle rows and derived-memory/index enqueue records: every rejected/preflight path leaves them unchanged. Illustration failure remains independent. Local fact-format repair makes zero primary/repair provider calls until the ordinary downstream semantic review legitimately runs.

```ts
expect(mockProvider.primaryCalls).toBe(1);
expect(afterRestart.savedResponseContract).toEqual(beforeRestart.savedResponseContract);
expect(accepted.privateSnapshot.tracker_updates).toEqual(originalTrackerUpdates);
expect(rejectedCampaignState).toEqual(beforeCampaignState);
```

Implement assertions with the existing integration harness and repository reads, not executor stubs. Record exact RED and GREEN commands. Focused DB command:

```sh
corepack pnpm exec vitest run --config vitest.integration.config.ts tests/integration/generation-response-contract.integration.test.ts tests/integration/generation-review.integration.test.ts tests/integration/story-continuity-review.integration.test.ts tests/integration/story-only-choice-repair.integration.test.ts
```

Run named focused unit suites, `corepack pnpm check`, `git diff --check`, then scope the commit. A skipped DB selection is not a passing durability gate.

## Exit gate

All operation bindings, first-dispatch/resume identities and format-repair invariants hold under real PostgreSQL. No inherited receipt or historical request is reinterpreted. Handoff specifies the private JSON storage path, version/reader rules, and tests for each crash point.
