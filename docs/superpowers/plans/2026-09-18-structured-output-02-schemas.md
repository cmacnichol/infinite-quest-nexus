# Structured output 02: operation schemas implementation plan

> **For agentic workers:** Use `superpowers:subagent-driven-development`; fresh gpt-5.6-terra implementer and fresh Terra reviewers.

**Goal:** Define versioned provider schemas that prevent known fact-shape failures without changing accepted story semantics.

**Architecture:** Pair a provider-wire schema registry with existing Zod contracts and executable conformance fixtures. Preserve native tracker objects; admit only provider schema profiles capable of representing them.

**Tech Stack:** TypeScript, Zod 4, JSON Schema, Vitest.

**Spec:** [Index](2026-09-18-structured-output.md), including all global constraints. Depends on patch 01 types.

## Files and interfaces

- Create `packages/story-engine/src/provider-output-schema.ts`, `tests/unit/provider-output-schema.test.ts`, `tests/fixtures/generation-validation/structured-output-cases.ts`.
- Read existing contracts in `packages/contracts/src/story-prompt.ts`, `story-continuity-review.ts`; choice contract and parser in `packages/story-engine/src/story-only-output.ts`; review contract in `packages/story-engine/src/continuity-review.ts`.
- Read `docs/architecture/scene-context-mechanics-review.md` before tracker-related conformance work. Preserve its unresolved domain boundary and all existing mechanics safeguards; this patch changes no tracker wire representation or routing authority.
- Extend `tests/unit/story-output.test.ts`, `fact-format-repair.test.ts`, `story-continuity-review-contracts.test.ts` only for behavioral regressions. Do not edit v16 prompt text or the accepted-turn schema to accommodate a provider.

```ts
type ProviderOutputSchema = Readonly<{
  operation: ResponseSchemaOperation;
  version: "story-native-v1" | "choices-v1" | "continuity-review-v1";
  name: string; schema: Readonly<Record<string, unknown>>;
  schemaHash: string; requiresOpenTrackerObjects: boolean;
}>;
// getProviderOutputSchema(operation) returns the immutable registry entry.
```

Hash stable serialized schema content, including constraints and descriptions. Keep versions immutable. A changed schema requires a new version and verification record. Existing `STORY_PROMPT_SCHEMA_VERSION` remains the application contract version, separate from the provider schema digest.

## Task 1: primary story schema and tracker admission

- [ ] RED: executable schema validation accepts a synthetic complete turn and rejects object-valued `canonical_facts`, missing replacement fields, wrong array types, three/five choices, nonempty `superseded_facts`, malformed supersession IDs and 501 open threads. Test empty replacements and empty delta arrays as valid. Keep current parser normalization tests separate from strict-wire tests: the strict wire may reject a shape the compatibility parser normalizes.
- [ ] Use a real JSON Schema validator in tests, not regex/property-presence assertions. Prefer an existing dependency; if absent add Ajv as a dev dependency only, with format support or explicit UUID-pattern tests. Review Zod refinements/default behavior rather than treating automatic conversion as complete.
- [ ] Build all story properties: narration, choices, custom action, scratchpad, trackers, image prompt, continuity summary, canonical facts, superseded facts, structured updates and open threads. Require all keys in the provider schema, including defaultable tracker/image fields. Use closed top-level/known nested objects. Array bounds mirror the application contract; semantic refinements remain application checks.
- [ ] `tracker_updates.items` remains an object permitting arbitrary JSON properties. Verify nested arrays, objects, booleans, numbers and null survive unchanged. A closed-object-only provider profile must be ineligible before dispatch; do not change the schema to `{}` or `[]` to pass a probe.
- [ ] Pair schema acceptance with `storyTurnOutputSchema.safeParse` and normal `parseStoryOutput`. Whitespace normalization and mechanics rejection are explicitly still application work.

Example fixture assertion:

```ts
const original = {
  ...validStory,
  tracker_updates: [{ name: "Trust", value: "wary", metadata: {
    source: "conversation", history: [null, true, 2, { note: "guarded" }]
  } }]
};
expect(validateWire(getProviderOutputSchema("story"), original)).toBe(true);
expect(storyTurnOutputSchema.parse(original).tracker_updates)
  .toEqual(original.tracker_updates);
```

`validateWire` is a test helper wrapping the real validator; `validStory` is the synthetic fixture created in this patch. No production data in fixtures.

## Task 2: operation registry and conformance

- [ ] RED: `choices` accepts only the existing choice-repair result shape; `continuity_review` accepts the existing review union/versions. Neither accepts a full story object. Invalid review references still fail semantic review even when JSON Schema accepts their syntax.
- [ ] Implement separate schema registry entries from the exact current contracts. Keep operation names from patch 01. JSON Schema features unsupported by an endpoint make that operation ineligible; do not remove constraints from one registry entry in place.
- [ ] Document binding table: primary/explicit primary Retry/full-story continuity repair/event extension => story; choice-only repair => choices; continuity review => continuity_review. RPG assessment, event-trigger assessment, authoring, embeddings and images keep existing explicit behavior; they never inherit the story schema from a profile setting.
- [ ] Explicit `repair_format` is a local deterministic transformation, not a provider operation. It has no response schema and makes zero provider requests. Preserve its original producing response contract and raw/request hashes. Do not create a new model-driven repair path when implementing this registry.
- [ ] Add arbitrary tracker preservation tests to deterministic fact repair: protected stable JSON hash unchanged, repaired facts alone differ, mechanics-contaminated tracker values remain rejected by existing validation.
- [ ] Run `corepack pnpm exec vitest run tests/unit/provider-output-schema.test.ts tests/unit/story-output.test.ts tests/unit/fact-format-repair.test.ts tests/unit/story-continuity-review-contracts.test.ts`; record RED/GREEN. Check types and `git diff --check`, then scoped commit.

## Exit gate

Schemas are tested against real validators and application contracts; all current fields and operation distinctions are accounted for. Tracker compatibility is truthful. No provider mode is enabled by this patch and no new wire encoding is introduced.
