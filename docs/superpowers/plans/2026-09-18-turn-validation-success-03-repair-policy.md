# Phase 03: Pure fact-format repair policy implementation plan

> **For agentic workers:** Use `superpowers:subagent-driven-development` when delegated. Implement only the pure planner in this patch; phase 04 supplies explicit execution authority.

**Goal:** Produce an auditable repair proposal for known fact-object formats while preserving fiction and rejecting ambiguous authority changes.

**Architecture:** A pure function reads the original JSON and exact visible fact inventory, classifies every malformed item, and creates a proposed strict story plus a private transformation journal. It never changes parser acceptance and is never invoked as automatic acceptance.

**Tech Stack:** TypeScript, Zod, SHA-256 helpers, Vitest.

**Spec:** [Index](2026-09-18-turn-validation-success.md). Depends on phase 01; rebase after phase 02 before integration.

## Ownership and interfaces

Create `packages/story-engine/src/fact-format-repair.ts`, `tests/unit/fact-format-repair.test.ts`, and `tests/fixtures/generation-validation/fact-format-cases.ts`. Read `packages/story-engine/src/output.ts`, `packages/contracts/src/story-prompt.ts`, and `packages/domain/src/text.ts`. Do not widen `parseStoryOutput` or modify its current rejection expectations.

Define these public module types; phase 04 imports them:

```ts
export type VisibleRepairFact = Readonly<{ id: string; content: string }>;
export type FactFormatChange = Readonly<{
  sourceIndex: number;
  kind: "id_label_to_addition" | "visible_reference_removed" |
    "metadata_to_addition" | "misplaced_update_moved";
}>;
export type FactFormatRepairPlan = Readonly<{
  version: 1; rawOutputHash: string; visibleFactsHash: string;
  protectedFieldsHash: string; resultHash: string;
  story: StoryTurnOutput; changes: readonly FactFormatChange[];
}>;
export type FactFormatRepairResult =
  | Readonly<{ eligible: true; plan: FactFormatRepairPlan }>
  | Readonly<{ eligible: false; reason: "not_needed" | "incomplete" |
      "invalid_protected_fields" | "unsupported_fact_shape" |
      "ambiguous_authority" | "invalid_result" }>;
export function planFactFormatRepair(input: Readonly<{
  rawOutput: string; visibleFacts: readonly VisibleRepairFact[];
}>): FactFormatRepairResult;
```

Use the repository `StoryTurnOutput` type import, `sha256`, and stable serialization helpers. A plan is private data, not a public preview or permission to commit. Hash exact raw bytes separately from canonical JSON values.

## Transformation decision table

Apply only after explicit consent in phase 04. Preserve original raw output independently.

| Input item under `canonical_facts` | Proposed action | Required checks |
|---|---|---|
| String or `{content}` | Existing parser behavior | Existing schema and mechanics checks |
| Exactly `{id,content}`, id is null or an ASCII label matching `[A-Za-z0-9_.:-]{0,200}`, absent from visible fact identity | New string addition; discard the ID label only in the explicit proposal | Nonempty bounded content; never use this ID as stored fact ID or supersession ID. UUID-shaped labels must first be checked against visible UUIDs case-insensitively |
| Exactly `{id,content}`, id is visible and content exactly equals that visible fact | Remove redundant reference from additions | Exact code-point equality; journal the index; never mutate the referenced fact |
| Exactly `{id,content}`, id is visible but content differs | Ineligible | Do not infer an update or replacement |
| Exactly `{content,estimatedTokens}` | String addition | `estimatedTokens` finite nonnegative integer; metadata is not story authority |
| Exactly `{content,supersedes_fact_ids}` with empty IDs | String addition | Valid content, preserve once |
| Exactly `{content,supersedes_fact_ids}` with nonempty IDs | Move to `canonical_fact_updates` | Valid UUIDs, each visible, no duplicate/conflicting target in proposed updates |
| Unknown keys, nested/numeric/boolean ID values, non-ASCII/control/overlong labels, malformed content/metadata, unseen or malformed supersession ID | Ineligible | Preserve candidate for existing Retry; never silently drop unknown information |

Do not read other campaigns to classify an ID. An arbitrary ID label is never trusted as authority. Supersession validity is rechecked against the database at commit; the visible inventory alone does not authorize an inactive fact. This proposal changes only representation or removes an exactly proven redundant reference; it does not determine narrative truth.

Implementation-time evidence correction: a read-only replay of the fixed 50-job cohort found 145 malformed ID-bearing facts: 63 UUID-shaped labels, 66 short ASCII labels, nine empty strings, and seven nulls. The original UUID-only label rule would leave several recent failures unresolved. The expanded rule applies only to explicitly authorized removal of an inert label; replacement references still require exact supplied UUIDs. Include synthetic fixtures for all four observed classes and a UUID-casing collision with changed visible content.

Independent Terra preflight approved this adjustment with these required bounds: match labels against raw `^[A-Za-z0-9_.:-]{0,200}$` with no trimming, coercion, or Unicode normalization; validate visible inventory UUIDs; compare case-insensitively only for ignored ID labels, never supersession references. Same-content comparison remains exact. Test whitespace, control characters, Unicode, every allowed punctuation class, 201-character labels, and mixed eligible/ineligible arrays.

## Task 1: Eligibility and exact preservation

- [ ] Build a synthetic complete story fixture with narration `The beacon is lit.`, four distinct choices, empty replacements/deltas where appropriate, and no real campaign content.
- [ ] Add this focused regression, using the synthetic fixture and the planned function:

```ts
const original = makeSyntheticStory();
const result = planFactFormatRepair({
  rawOutput: JSON.stringify({ ...original, canonical_facts: [
    { id: "11111111-1111-4111-8111-111111111111", content: "The beacon is lit." }
  ] }), visibleFacts: []
});
expect(result.eligible).toBe(true);
if (!result.eligible) throw new Error(result.reason);
expect(result.plan.story.canonical_facts).toEqual(["The beacon is lit."]);
expect(result.plan.story.narration).toBe(original.narration);
expect(result.plan.changes).toEqual([{ sourceIndex: 0, kind: "id_label_to_addition" }]);
```

`makeSyntheticStory` is created in the fixture module in this patch and returns a complete valid `StoryTurnOutput`.

- [ ] Run `corepack pnpm exec vitest run tests/unit/fact-format-repair.test.ts`; capture RED. Implement classification with exact object-key sets, not broad casts or spreading unknown fields.
- [ ] Validate protected fields by replacing only the candidate fact-addition array with `[]` for validation, retaining original `canonical_fact_updates`; reject any unrelated schema/mechanics/choice error. Missing arrays already supported by the parser remain supported; missing full replacements remain invalid.
- [ ] Require Story Direction choice validation when phase 04 supplies that mode; the pure result itself must not conceal unrelated invalid choices. Phase 04 reruns mode-specific validation.
- [ ] Preserve narration bytes as represented by the existing formatter, and prove raw narration before/after has the same value. Preserve choices, custom suggestion, scratchpad, tracker updates, image prompt, summary, open threads, and existing valid updates exactly. Never use historical defaults to fill them.
- [ ] Every nonredundant input content value must appear exactly once in its corresponding output addition/update; preserve valid string additions and existing updates in order. Append moved updates in source order. Reject a collision between an existing update and a moved update rather than choosing one silently.
- [ ] Assign `metadata_to_addition` to the empty-`supersedes_fact_ids` case and `misplaced_update_moved` only to nonempty explicit replacements. The transformation journal must account for every removed or moved object, including exact visible references.

## Task 2: Adversarial and mass-balance matrix

- [ ] Add one named test for each decision-table row, mixed supported shapes, and a supported item followed by an unsupported one. A partially repairable array must produce no plan.
- [ ] Add visible-ID changed content (including differently cased UUID), unseen replacement ID, duplicate targets, UUID-like text containing `ac12`, mechanics in content, empty/oversized content, null fact item, array-as-object, invalid metadata, and excess fact count cases. Separately verify null and empty ID labels are supported without granting authority.
- [ ] Add `{}`, malformed/truncated JSON, missing narration, missing summary, missing choices, and unrelated tracker shape failures. They remain ineligible.
- [ ] Assert deterministic hashes, changes to raw bytes/source inventory affecting bindings, and protected field mutations affecting the protected hash. Use `extractJsonObject` as the production extraction boundary; do not evaluate raw content.
- [ ] Re-run `tests/unit/story-output.test.ts` and `tests/unit/story-only-output.test.ts`. Existing direct-parser rejection of `{id,content}` must still pass.
- [ ] Record supported and deliberately unsupported cases in the handoff; commit `Plan explicit fact format repairs without rewriting fiction`.

## Exit gate

Every table row has executable evidence. Zero provider calls, DB writes, or runtime acceptance changes occur in this patch. Independent review must approve the distinction between an ignored ID label, a visible reference, and a supersession reference before phase 04 begins.
