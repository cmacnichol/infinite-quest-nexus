import { describe, expect, it } from "vitest";
import { planFactFormatRepair } from "../../packages/story-engine/src/fact-format-repair.js";
import { factFormatRepairHash, factFormatRepairStableJson } from "../../packages/contracts/src/fact-format-repair-hash.js";
import { sha256, stableStringify } from "../../packages/domain/src/text.js";
import {
  makeSyntheticStory,
  rawSyntheticStory,
  visibleBeaconId,
  visibleGateId
} from "../fixtures/generation-validation/fact-format-cases.js";

const visibleFacts = [
  { id: visibleBeaconId, content: "The beacon is dark." },
  { id: visibleGateId, content: "The gate is closed." }
];

function eligible(rawOutput: string, visible = visibleFacts) {
  const result = planFactFormatRepair({ rawOutput, visibleFacts: visible });
  expect(result.eligible).toBe(true);
  if (!result.eligible) throw new Error(result.reason);
  return result.plan;
}

describe("fact format repair planner", () => {
  it("keeps the planner's locale-key serialization distinct from review receipt canonical JSON", () => {
    const tracker = { z: 1, "ä": 2, a: 3 };
    expect(factFormatRepairStableJson(tracker)).toBe(stableStringify(tracker));
    expect(factFormatRepairHash(tracker)).toBe(sha256(stableStringify(tracker)));
  });
  it("plans an inert UUID label as a new string addition without changing protected fiction", () => {
    const original = makeSyntheticStory();
    const rawOutput = rawSyntheticStory({ canonical_facts: [{ id: "33333333-3333-4333-8333-333333333333", content: "The beacon is lit." }] });
    const plan = eligible(rawOutput, []);

    expect(plan.story.canonical_facts).toEqual(["The beacon is lit."]);
    expect(plan.story.narration).toBe(original.narration);
    expect(plan.story.choices).toEqual(original.choices);
    expect(plan.changes).toEqual([{ sourceIndex: 0, kind: "id_label_to_addition" }]);
  });

  it.each([
    ["null", null],
    ["empty", ""],
    ["short ASCII", "model.fact:17"],
    ["UUID-shaped", "33333333-3333-4333-8333-333333333333"]
  ])("treats an observed inert %s label as an addition", (_name, id) => {
    const plan = eligible(rawSyntheticStory({ canonical_facts: [{ id, content: "The beacon is lit." }] }), []);
    expect(plan.story.canonical_facts).toEqual(["The beacon is lit."]);
    expect(plan.changes).toEqual([{ sourceIndex: 0, kind: "id_label_to_addition" }]);
  });

  it("removes an exact visible reference but never mutates the visible fact", () => {
    const plan = eligible(rawSyntheticStory({ canonical_facts: [{ id: visibleBeaconId, content: "The beacon is dark." }] }));
    expect(plan.story.canonical_facts).toEqual([]);
    expect(plan.changes).toEqual([{ sourceIndex: 0, kind: "visible_reference_removed" }]);
  });

  it("protects a visible UUID before treating a differently cased label as inert", () => {
    const plan = eligible(rawSyntheticStory({ canonical_facts: [{ id: visibleBeaconId.toUpperCase(), content: "The beacon is dark." }] }));
    expect(plan.story.canonical_facts).toEqual([]);
    expect(plan.changes).toEqual([{ sourceIndex: 0, kind: "visible_reference_removed" }]);
  });

  it("rejects a visible UUID under different casing when its content changes", () => {
    const result = planFactFormatRepair({
      rawOutput: rawSyntheticStory({ canonical_facts: [{ id: visibleBeaconId.toUpperCase(), content: "The beacon is lit." }] }),
      visibleFacts
    });
    expect(result).toEqual({ eligible: false, reason: "ambiguous_authority" });
  });

  it("rejects mechanics in a redundant visible reference before removing it", () => {
    const mechanical = "Roll a d20 to make a strength check.";
    const result = planFactFormatRepair({
      rawOutput: rawSyntheticStory({ canonical_facts: [{ id: visibleBeaconId, content: mechanical }] }),
      visibleFacts: [{ id: visibleBeaconId, content: mechanical }]
    });
    expect(result).toEqual({ eligible: false, reason: "invalid_protected_fields" });
  });

  it("moves an explicit valid replacement to canonical_fact_updates in source order", () => {
    const plan = eligible(rawSyntheticStory({ canonical_facts: [
      { content: "The beacon is lit.", supersedes_fact_ids: [] },
      { content: "The gate is open.", supersedes_fact_ids: [visibleGateId] }
    ] }));
    expect(plan.story.canonical_facts).toEqual(["The beacon is lit."]);
    expect(plan.story.canonical_fact_updates).toEqual([{ content: "The gate is open.", supersedes_fact_ids: [visibleGateId] }]);
    expect(plan.changes).toEqual([
      { sourceIndex: 0, kind: "metadata_to_addition" },
      { sourceIndex: 1, kind: "misplaced_update_moved" }
    ]);
  });

  it("accepts estimated-token metadata as a fact addition", () => {
    const plan = eligible(rawSyntheticStory({ canonical_facts: [{ content: "The beacon is lit.", estimatedTokens: 4 }] }));
    expect(plan.story.canonical_facts).toEqual(["The beacon is lit."]);
    expect(plan.changes).toEqual([{ sourceIndex: 0, kind: "metadata_to_addition" }]);
  });

  it("keeps valid string additions and existing updates while accounting for every transformed item", () => {
    const plan = eligible(rawSyntheticStory({
      canonical_facts: ["A watchfire burns.", { id: "label_1", content: "The beacon is lit." }, { content: "The gate is open.", supersedes_fact_ids: [visibleGateId] }],
      canonical_fact_updates: [{ content: "The beacon is dark.", supersedes_fact_ids: [visibleBeaconId] }]
    }));
    expect(plan.story.canonical_facts).toEqual(["A watchfire burns.", "The beacon is lit."]);
    expect(plan.story.canonical_fact_updates).toEqual([
      { content: "The beacon is dark.", supersedes_fact_ids: [visibleBeaconId] },
      { content: "The gate is open.", supersedes_fact_ids: [visibleGateId] }
    ]);
    expect(plan.changes).toHaveLength(2);
  });

  it("preserves a content-only wrapper when another item needs repair", () => {
    const plan = eligible(rawSyntheticStory({ canonical_facts: [
      { content: "The gate is open." },
      { id: "f1", content: "The beacon is lit." }
    ] }), []);
    expect(plan.story.canonical_facts).toEqual(["The gate is open.", "The beacon is lit."]);
    expect(plan.changes).toEqual([{ sourceIndex: 1, kind: "id_label_to_addition" }]);
  });

  it("keeps a content-only wrapper under the normal parser instead of proposing repair", () => {
    expect(planFactFormatRepair({
      rawOutput: rawSyntheticStory({ canonical_facts: [{ content: "The beacon is lit." }] }),
      visibleFacts: []
    })).toEqual({ eligible: false, reason: "not_needed" });
  });

  it("does not return a partial plan when a supported item precedes an unsupported item", () => {
    const result = planFactFormatRepair({
      rawOutput: rawSyntheticStory({ canonical_facts: [{ id: "label", content: "The beacon is lit." }, { content: "The gate is open.", other: true }] }),
      visibleFacts: []
    });
    expect(result).toEqual({ eligible: false, reason: "unsupported_fact_shape" });
  });

  it.each([
    ["whitespace label", " label"],
    ["control label", "label\n"],
    ["Unicode label", "béacon"],
    ["overlong label", "a".repeat(201)],
    ["numeric label", 17],
    ["boolean label", true],
    ["nested label", { id: "label" }]
  ])("rejects an unsupported %s without partially planning", (_name, id) => {
    const result = planFactFormatRepair({ rawOutput: rawSyntheticStory({ canonical_facts: [{ id, content: "The beacon is lit." }] }), visibleFacts: [] });
    expect(result).toEqual({ eligible: false, reason: "unsupported_fact_shape" });
  });

  it.each([".", "_", ":", "-", "a.Z_1:-"])('accepts raw allowed ID punctuation %s', (id) => {
    const plan = eligible(rawSyntheticStory({ canonical_facts: [{ id, content: "The beacon is lit." }] }), []);
    expect(plan.story.canonical_facts).toEqual(["The beacon is lit."]);
  });

  it.each([
    ["unseen replacement", ["33333333-3333-4333-8333-333333333333"]],
    ["malformed replacement", ["not-a-uuid"]],
    ["duplicate replacement", [visibleGateId, visibleGateId]]
  ])("rejects %s authority", (_name, supersedes_fact_ids) => {
    const result = planFactFormatRepair({ rawOutput: rawSyntheticStory({ canonical_facts: [{ content: "The gate is open.", supersedes_fact_ids }] }), visibleFacts });
    expect(result).toEqual({ eligible: false, reason: "ambiguous_authority" });
  });

  it("rejects an update collision instead of choosing a replacement", () => {
    const result = planFactFormatRepair({
      rawOutput: rawSyntheticStory({
        canonical_facts: [{ content: "The gate is open.", supersedes_fact_ids: [visibleGateId] }],
        canonical_fact_updates: [{ content: "The gate is barred.", supersedes_fact_ids: [visibleGateId] }]
      }),
      visibleFacts
    });
    expect(result).toEqual({ eligible: false, reason: "ambiguous_authority" });
  });

  it.each([
    ["duplicate visible UUID", [
      { id: visibleBeaconId, content: "The beacon is dark." },
      { id: visibleBeaconId, content: "The beacon is dark." }
    ]],
    ["conflicting folded visible UUID", [
      { id: visibleBeaconId, content: "The beacon is dark." },
      { id: visibleBeaconId.toUpperCase(), content: "Different visible content." }
    ]],
    ["malformed visible UUID", [{ id: "not-a-uuid", content: "The beacon is dark." }]],
    ["invalid UUID variant accepted by a broad shape check", [{ id: "11111111-1111-4111-c111-111111111111", content: "The beacon is dark." }]]
  ])("rejects an invalid %s inventory", (_name, inventory) => {
    const result = planFactFormatRepair({
      rawOutput: rawSyntheticStory({ canonical_facts: [{ id: "label", content: "The beacon is lit." }] }),
      visibleFacts: inventory
    });
    expect(result).toEqual({ eligible: false, reason: "ambiguous_authority" });
  });

  it.each([
    ["unknown keys", { content: "The beacon is lit.", other: true }],
    ["null item", null],
    ["array item", ["The beacon is lit."]],
    ["invalid metadata", { content: "The beacon is lit.", estimatedTokens: -1 }],
    ["empty content", { id: "label", content: "" }],
    ["oversized content", { id: "label", content: "a".repeat(4001) }]
  ])("rejects %s", (_name, fact) => {
    const result = planFactFormatRepair({ rawOutput: rawSyntheticStory({ canonical_facts: [fact] }), visibleFacts: [] });
    expect(result).toEqual({ eligible: false, reason: "unsupported_fact_shape" });
  });

  it.each([
    ["not needed", rawSyntheticStory({ canonical_facts: ["The beacon is lit."] }), "not_needed"],
    ["truncated JSON", '{"narration":"The beacon is lit."', "incomplete"],
    ["empty object", "{}", "invalid_protected_fields"],
    ["missing narration", rawSyntheticStory({ narration: undefined, canonical_facts: [{ id: "label", content: "The beacon is lit." }] }), "invalid_protected_fields"],
    ["missing summary", rawSyntheticStory({ continuity_summary: undefined, canonical_facts: [{ id: "label", content: "The beacon is lit." }] }), "invalid_protected_fields"],
    ["missing choices", rawSyntheticStory({ choices: undefined, canonical_facts: [{ id: "label", content: "The beacon is lit." }] }), "invalid_protected_fields"],
    ["bad tracker", rawSyntheticStory({ tracker_updates: ["not a record"], canonical_facts: [{ id: "label", content: "The beacon is lit." }] }), "invalid_protected_fields"],
    ["mechanics", rawSyntheticStory({ narration: "The die shows seventeen.", canonical_facts: [{ id: "label", content: "The beacon is lit." }] }), "invalid_protected_fields"]
  ])("does not conceal %s", (_name, rawOutput, reason) => {
    expect(planFactFormatRepair({ rawOutput, visibleFacts: [] })).toEqual({ eligible: false, reason });
  });

  it("rejects protected values that strict parsing would trim", () => {
    const result = planFactFormatRepair({
      rawOutput: rawSyntheticStory({
        choices: [" Approach the beacon. ", "Wait at the gate.", "Study the horizon.", "Call to the keeper."],
        canonical_facts: [{ id: "f1", content: "The beacon is lit." }]
      }),
      visibleFacts: []
    });
    expect(result).toEqual({ eligible: false, reason: "invalid_protected_fields" });
  });

  it("rejects fact additions that strict parsing would trim", () => {
    const result = planFactFormatRepair({
      rawOutput: rawSyntheticStory({ canonical_facts: [{ id: "f1", content: " The beacon is lit. " }] }),
      visibleFacts: []
    });
    expect(result).toEqual({ eligible: false, reason: "unsupported_fact_shape" });
  });

  it("rejects existing fact updates that strict parsing would trim", () => {
    const result = planFactFormatRepair({
      rawOutput: rawSyntheticStory({
        canonical_facts: [{ id: "f1", content: "The beacon is lit." }],
        canonical_fact_updates: [{ content: " The beacon is dark. ", supersedes_fact_ids: [visibleBeaconId] }]
      }),
      visibleFacts
    });
    expect(result).toEqual({ eligible: false, reason: "invalid_protected_fields" });
  });

  it("rejects excess facts before a strict result can be proposed", () => {
    const result = planFactFormatRepair({
      rawOutput: rawSyntheticStory({ canonical_facts: Array.from({ length: 101 }, (_, index) => ({ id: `label-${index}`, content: "The beacon is lit." })) }),
      visibleFacts: []
    });
    expect(result).toEqual({ eligible: false, reason: "unsupported_fact_shape" });
  });

  it("binds deterministic plans to exact raw bytes, visible inventory, protected fields, and result", () => {
    const rawOutput = rawSyntheticStory({ canonical_facts: [{ id: "label", content: "The beacon is lit." }] });
    const first = eligible(rawOutput, []);
    const second = eligible(rawOutput, []);
    const changedRaw = eligible(`${rawOutput}\n`, []);
    const changedInventory = eligible(rawOutput, [{ id: visibleBeaconId, content: "The beacon is dark." }]);
    const changedProtected = eligible(rawSyntheticStory({ scratchpad: "Different synthetic note.", canonical_facts: [{ id: "label", content: "The beacon is lit." }] }), []);
    const changedResult = eligible(rawSyntheticStory({ canonical_facts: [{ id: "label", content: "The beacon is dark." }] }), []);

    expect(second).toEqual(first);
    expect(changedRaw.rawOutputHash).not.toBe(first.rawOutputHash);
    expect(changedInventory.visibleFactsHash).not.toBe(first.visibleFactsHash);
    expect(changedProtected.protectedFieldsHash).not.toBe(first.protectedFieldsHash);
    expect(changedResult.resultHash).not.toBe(first.resultHash);
    expect(first.resultHash).toMatch(/^[a-f0-9]{64}$/);
  });
});
