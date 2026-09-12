import { describe, expect, it } from "vitest";
import { mergeChoiceRepair, parseChoiceRepair, parseStoryOnlyOutput } from "../../packages/story-engine/src/story-only-output.js";

const base = {
  narration: "The gate closes behind you.", scratchpad: "", tracker_updates: [],
  image_prompt: "", continuity_summary: "You are inside the courtyard.",
  canonical_facts: [], superseded_facts: [], canonical_fact_updates: [], open_threads: []
};

const fields = {
  choices: ["Wait.", "Listen.", "Look around.", "Study the gate."],
  custom_action_suggestion: "Describe the courtyard."
};

describe("story-only output", () => {
  it("classifies normalized duplicate choices while preserving a valid non-choice base", () => {
    const parsed = parseStoryOnlyOutput(JSON.stringify({
      ...base, choices: ["Wait.", " WAIT. ", "Listen.", "Look around."],
      custom_action_suggestion: "Study the gate."
    }));
    expect(parsed).toMatchObject({ ok: false, kind: "choices", reasons: ["duplicate"] });
  });

  it("rejects a duplicate custom suggestion and mechanics-bearing choices", () => {
    expect(parseStoryOnlyOutput(JSON.stringify({ ...base, ...fields, custom_action_suggestion: "  wait.  " })))
      .toMatchObject({ ok: false, kind: "choices", reasons: ["duplicate"] });
    expect(parseStoryOnlyOutput(JSON.stringify({ ...base, ...fields, choices: ["Roll a d20.", "Listen.", "Look around.", "Study."] })))
      .toMatchObject({ ok: false, kind: "choices", reasons: ["mechanics"] });
  });

  it.each([
    ["missing choices", { ...base, custom_action_suggestion: "Study." }, "missing"],
    ["wrong choice count", { ...base, choices: ["Wait."], custom_action_suggestion: "Study." }, "count"],
    ["overlong choice", { ...base, choices: ["x".repeat(2001), "Listen.", "Look.", "Study."], custom_action_suggestion: "Describe." }, "length"],
    ["NFKC and whitespace duplicate", { ...base, choices: ["Cafe\u0301", " CAFÉ ", "Listen.", "Look."], custom_action_suggestion: "Study." }, "duplicate"]
  ])("classifies %s as a repairable choice defect", (_label, content, reason) => {
    expect(parseStoryOnlyOutput(JSON.stringify(content))).toMatchObject({ ok: false, kind: "choices", reasons: [reason] });
  });

  it("does not classify mixed narrative and choice faults as repairable choices", () => {
    expect(parseStoryOnlyOutput(JSON.stringify({ ...base, narration: "Roll a d20.", choices: ["Wait.", " WAIT. ", "Listen.", "Look around."], custom_action_suggestion: "Study." })))
      .toMatchObject({ ok: false, kind: "story" });
  });

  it("strictly parses a repair and merges it without replacing protected fields", () => {
    const repaired = parseChoiceRepair(JSON.stringify(fields));
    const merged = mergeChoiceRepair(base, repaired);
    const { choices, custom_action_suggestion, ...preserved } = merged;
    expect(preserved).toEqual(base);
    expect(choices).toEqual(fields.choices);
    expect(custom_action_suggestion).toBe(fields.custom_action_suggestion);
    expect(() => parseChoiceRepair(JSON.stringify({ ...fields, narration: "Changed" }))).toThrow();
  });

  it("does not let structurally carried extra fields replace the protected base", () => {
    const untrustedFields = { ...fields, narration: "Changed" };
    expect(mergeChoiceRepair(base, untrustedFields)).toMatchObject({ narration: base.narration });
  });
});
