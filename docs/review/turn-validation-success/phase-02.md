# Phase 02 handoff: fact wire prompt alignment

Base: requested implementation baseline `9f5986ca`; the branch also contains the coordinator's unrelated documentation checkpoint `10076dd5`. Head: the immutable Phase 02 commit supplied with this handoff.

## Delivered behavior

Newly queued Story Memory work freezes `story-v16-fact-wire-distinction` together with a mandatory five-line fact wire contract. The contract says that supplied canonical fact objects are references, while `canonical_facts` contains only new string additions; updates go in `canonical_fact_updates` with visible replacement UUIDs; no-op delta arrays are emitted; and continuity fields are complete replacements. The default system prompt uses the same shared contract.

The mandatory contract is appended after acknowledged creative overrides, so an override cannot displace the output rule. The production Story-only composition and its choice-repair path select the mandatory contract from the frozen Story Memory policy, and the executor passes that frozen version through every applicable composition path.

`story-v15-canonical-fact-format` is now an explicit previous protocol. Its exact prior Story Memory appendage is kept in `PREVIOUS_STORY_MEMORY_MANDATORY_CONTRACT`; retries and resumptions select those v15 bytes rather than the v16 bytes. Snapshot compatibility and policy decoding accept v14, v15, and v16 identities. The existing v14 incompatible-worker recovery path remains unchanged. Unknown or mismatched identities remain invalid/incompatible.

No database migration or rollout rewrite occurs. Existing campaigns, accepted turns, and queued/recoverable jobs retain their persisted snapshots, policy version, and prompt protocol; only newly enqueued jobs receive v16.

## Changed files

- `packages/contracts/src/story-prompt.ts` adds v16, preserves v15 wire bytes, and centralizes version-selected mandatory contracts.
- `packages/contracts/src/story-memory-policy.ts` and `packages/contracts/src/prompt-library.ts` retain explicit v15 frozen-policy and compatibility decoding.
- `packages/story-engine/src/story-only-prompt.ts` and `services/runtime/src/generation-executor-adapter.ts` compose using the frozen prompt version in default, Action, Story Direction, and choice-repair request paths.
- Unit and isolated PostgreSQL integration tests cover identity, shared composition, real provider request serialization, creative overrides, Story Direction choice repair, enqueue, retry, and v15 frozen serialization.

## RED and GREEN evidence

- **RED:** `corepack pnpm exec vitest run tests/unit/story-output.test.ts tests/unit/story-only-prompt.test.ts` failed before the implementation: 4 failed / 36 passed. Failures showed the still-v15 identity and absent field-distinction text from default and composed prompts.
- **GREEN:** `corepack pnpm exec vitest run tests/unit/story-output.test.ts tests/unit/story-only-prompt.test.ts tests/unit/prompt-library.test.ts tests/unit/generation-executor-adapter.test.ts tests/unit/generation.test.ts` passed: 5 files, 168 tests.
- **GREEN:** `corepack pnpm check` passed: repository and data boundaries, TypeScript, and web checks. The only output was the existing Windows global Git-ignore accessibility warning.
- **GREEN, real PostgreSQL:** `corepack pnpm exec vitest run --config vitest.integration.config.ts tests/integration/story-memory-enrollment.integration.test.ts tests/integration/story-context-payload.integration.test.ts` passed: 2 files, 32 passed, 6 skipped existing known-failure probes. It uses the configured isolated Docker PostgreSQL service and local deterministic provider transport; it asserts actual serialized system messages for default, acknowledged creative override, Action, Story Direction choice repair, and a frozen v15 override. It also proves new v16 enqueue freezing and v15 retry snapshot/context/protocol preservation.
- **Platform limit, kept honest:** the wider compatibility command with `tests/integration/story-memory-compatibility.integration.test.ts` had one unrelated Windows failure in the `campaign_zip` case: `filesystem_platform_unsupported` from the Linux-only secure-filesystem adapter. The two Phase 02 integration suites above passed independently. The coordinator is separately running that compatibility suite in a disposable Linux environment; its outcome is not included here.

No browser verification was needed because this changes no visible UI. No live provider was called; integration transport is local and deterministic.

## Phase 01 baseline and canary boundary

Phase 01's first-pass report baseline is 15 accepted and 34 rejected among 49 classifiable initial attempts. A fresh bounded `READ ONLY` fixed-50 cutoff at `2026-09-18T05:05:13.987485Z` supplies the frozen-identity cohorts: Story Memory v14 has 34 jobs (5 valid, 29 invalid); v15 has 4 jobs (2 valid, 1 invalid, 1 with no saved response); non-enrolled `prompt-library-v1-5d636b749d679ddc` has 11 jobs (7 valid, 4 invalid); and non-enrolled `prompt-library-v1-dc1b588a0a37f571` has 1 job (1 valid). The v15 sample is tiny and confounded, so it is not a forecast. `generation_jobs.prompt_protocol_version` is a composite execution protocol; these groups use the frozen Story Memory policy version or non-enrolled prompt-library identity instead. The pre-rollout dataset has no v16 cohort. A coordinator read-only audit found exact primary request-body/hash evidence for 10 jobs and source manifests for 38; that is evidence availability, not an outcome metric. Phase 07 must measure the v16 cohort against the preserved v15 cohort and must not claim a quality gain from these deterministic prompt tests.

## Remaining risks and review focus

This patch clarifies the instruction and preserves protocol bytes; it does not relax strict validation, normalize malformed model output, alter retrieval, or add repair execution. Real provider compliance and any first-pass improvement remain unverified until the Phase 07 canary. Review the v15 exact-contract test and the executor's frozen-policy argument propagation, since those protect historical replay from receiving v16 bytes under a v15 identity.

## Review correction addendum

Change base: `1be74995`, after the original Phase 02 commit `52f2f604`. Review found that a new non-enrolled acknowledged `story_system` override bypassed the appended rule. This correction adds an optional `storyPromptCompatibility` proof to new non-enrolled v2 snapshots. It binds the acknowledged `story_system` hash to `story-v16-fact-wire-distinction|story-output-v2|current-continuity-v2`; execution appends the shared fact-wire contract only when that frozen proof exists and the story-system source is an override. Shipped default text already contains the contract and is not duplicated.

The proof participates in `generation_jobs.prompt_protocol_version` as `story-prompt-v1|<frozen compatibility identity>|<template identity>`, so a new marked job does not share the old raw-template execution, chain, checkpoint, or context-cache identity. Retry recomputes the same identity from the frozen proof. Old non-enrolled snapshots have no marker, retain their raw identity and bytes, and receive no new appended text.

The actual PostgreSQL provider-payload test now covers a non-enrolled acknowledged creative override for both Action and Story Direction, including Story Direction's choice-repair request. It also performs a real retry/reclaim of enrolled v15 and non-enrolled raw v15 jobs. The enrolled assertion uses literal historical text extracted from `9f5986ca`, with fixed SHA-256 `f7760dc26ce74011ebbad21530ab56f41a04ce19ad5bbe0bbf6607da9f6fc5ea`, rather than importing the current compatibility constant.

- **RED:** the real PostgreSQL payload suite failed with the two non-enrolled missing-contract assertions before the repair; its historical fixture also intentionally failed until the verified fixed hash replaced its placeholder.
- **GREEN:** focused prompt/executor units passed 134 tests; `corepack pnpm check` passed.
- **GREEN, real PostgreSQL:** `story-context-payload.integration.test.ts` plus `story-memory-enrollment.integration.test.ts` passed 35 tests with 6 existing known-failure skips. No live provider or browser was used.
