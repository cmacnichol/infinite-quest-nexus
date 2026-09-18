# Phase 02: Fact wire prompt alignment implementation plan

> **For agentic workers:** Use `superpowers:subagent-driven-development` when delegated. Follow the index's RED/GREEN and independent review gates.

**Goal:** Prevent the model from copying input reference objects into output fact additions.

**Architecture:** Keep the existing output schema. Put the same concise wire-format rule in the mandatory runtime contract used after creative overrides, and bind it to a new prompt identity for newly queued work only.

**Tech Stack:** TypeScript, Zod, Vitest, existing frozen prompt snapshots.

**Spec:** [Index](2026-09-18-turn-validation-success.md). Dependency: phase 01. This is prompt-only product behavior; parser relaxation, model changes, retrieval changes, and new repair execution are excluded.

## Ownership and files

Modify `packages/contracts/src/story-prompt.ts`, `packages/story-engine/src/story-only-prompt.ts` only if composition needs adjustment, and the existing prompt snapshot compatibility machinery located through `storyMemoryPromptCompatibilityIdentity`. Tests: `tests/unit/story-output.test.ts`, `tests/unit/story-only-prompt.test.ts`, `tests/integration/story-memory-compatibility.integration.test.ts`, `tests/integration/story-memory-enrollment.integration.test.ts`, and `tests/integration/story-context-payload.integration.test.ts`.

Before edits, read the completed phase-3 normalization plan from the previous recovery project. Preserve v13/v14/v15 compatibility constants; choose the next unused protocol number after checking current HEAD. Do not overwrite the text of a frozen old job.

## Task 1: Mandatory field distinction

Use this exact semantic content, adjusting only existing template interpolation conventions:

```text
Input canonical fact records may contain id, content, or retrieval metadata. Those records are references, not the output shape.
Output canonical_facts contains strings only, for facts newly established in this turn: ["The beacon is lit."]. Never put id, estimatedTokens, or supersedes_fact_ids inside this array.
Use canonical_fact_updates only for explicit fact updates: [{"content":"The beacon is dark.","supersedes_fact_ids":["an exact visible fact UUID"]}]. Copy replacement IDs only from supplied visible facts. New additions do not need IDs.
Use [] for superseded_facts. Omitted no-op delta arrays may be normalized by the application, but emit them explicitly.
Return scratchpad, continuity_summary, and open_threads as complete current replacements, even when empty. Do not copy all input facts into output additions.
```

- [ ] Add tests for default, creative-override, Story Direction, and Action prompt composition. Assert the final mandatory contract contains the field distinction even when the creative text describes input facts differently.
- [ ] Use the existing real composition function in `story-only-prompt.test.ts`; the essential new assertion is:

```ts
expect(composedPrompt).toContain("Input canonical fact records");
expect(composedPrompt).toContain("Output canonical_facts contains strings only");
expect(composedPrompt.lastIndexOf("Output canonical_facts contains strings only"))
  .toBeGreaterThan(composedPrompt.indexOf(creativeOverride));
```

`composedPrompt` must come from the production composition function and `creativeOverride` from the existing fixture, not a test-assembled imitation.

- [ ] Run the focused prompt suites to capture RED. Add the mandatory rule once through a shared constant/composer; avoid divergent copies between modes. Keep the required shape preview consistent.
- [ ] Test serialized provider messages, not only a constant: default and acknowledged creative override requests contain the new instructions in their actual system message. A retry of an old frozen job retains its old bytes/hash.
- [ ] Run focused tests and capture GREEN. Update the protocol identity and corresponding compatibility fixtures as a distinct, reviewed change within this patch.

## Task 2: Freeze and migration behavior

- [ ] Add a composed integration case that queues under old identity, changes current defaults, then retries: the old job retains old prompt/protocol or follows the existing explicit incompatibility path. It must never claim the new version while using old text.
- [ ] Queue a new job and assert the new rule and identity are frozen together. Assert same-mode resumption preserves hashes and model-chain compatibility checks.
- [ ] Confirm no existing campaign, accepted turn, or queued job is rewritten during rollout. Document that only new jobs get the prevention change.
- [ ] Record phase-01 first-pass metric cohorts by prompt identity in the handoff. Do not claim live-model improvement from exact-string tests.
- [ ] Review, run `git diff --check`, and commit `Clarify fact additions and updates in frozen story prompts`.

## Exit gate

All current request paths carry the unambiguous contract; historical snapshots retain their identities; existing normalization and strict rejection tests still pass. Any claimed quality gain awaits phase 07's canary.
