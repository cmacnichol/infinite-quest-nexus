import { describe, expect, it } from "vitest";
import {
  containsMechanicsLanguage,
  estimateTokens,
  mechanicsLanguageMatches,
  removeProviderSecrets,
  stableStringify,
  stripMechanicsLeakage
} from "../../packages/domain/src/text.js";

describe("fiction-safe text handling", () => {
  it("removes explicit RPG mechanics without removing adjacent fiction", () => {
    const result = stripMechanicsLeakage(
      "Marker One is visible. The d100 roll was 42 and the target was 65%. Object Beta remains present."
    );
    expect(result.changed).toBe(true);
    expect(result.text).toContain("Marker One is visible.");
    expect(result.text).toContain("Object Beta remains present.");
    expect(result.text).not.toMatch(/d100|target was|42/);
  });

  it("does not treat ordinary diegetic uses of rolled as mechanics", () => {
    const result = stripMechanicsLeakage("Test Character rolled their eyes and closed Object Beta.");
    expect(result.changed).toBe(false);
  });

  it("allows ordinary fiction that happens to use roll or difficulty words", () => {
    for (const text of [
      "A large roll-up door closes behind her.",
      "The smooth, rolling approach of wheels echoes through the bay.",
      "He unrolls a map beside a roll of canvas.",
      "She crosses the flooded room with difficulty.",
      "The patient remains in critical condition.",
      "The scoreboard shows the final score."
    ]) {
      expect(containsMechanicsLanguage(text), text).toBe(false);
    }
  });

  it("detects contextual resolution mechanics and engine metadata", () => {
    const contaminated = [
      "She rolls a 17 and opens the lock.",
      "Roll the dice before continuing.",
      "The die shows seventeen.",
      "The RPG stat is hidden.",
      "Make a skill check.",
      "The difficulty class is 15.",
      "Apply a +4 modifier.",
      "The target was 65%.",
      "This is a critical success.",
      "A parser error interrupted the response.",
      "The parser diagnostics mention a missing field.",
      "The raw model response follows.",
      "The rejected model output omitted narration.",
      "Here is my internal reasoning."
    ];
    for (const text of contaminated) {
      expect(containsMechanicsLanguage(text), text).toBe(true);
      expect(mechanicsLanguageMatches(text), text).not.toHaveLength(0);
    }
  });

  it("reports the exact matched span for actionable recovery", () => {
    expect(mechanicsLanguageMatches("She rolls a 17 and opens the lock.")).toEqual([
      { category: "dice", text: "rolls a 17", index: 4 }
    ]);
  });

  it("removes provider credentials while retaining memory settings", () => {
    expect(removeProviderSecrets({ apiKey: "secret", customApiKey: "secret-2", storyHistoryTokenLimit: 90000 }))
      .toEqual({ apiKey: "", customApiKey: "", storyHistoryTokenLimit: 90000 });
  });

  it("produces stable hashes independent of object key order", () => {
    expect(stableStringify({ b: 2, a: { d: 4, c: 3 } })).toBe(stableStringify({ a: { c: 3, d: 4 }, b: 2 }));
  });

  it("estimates non-empty text with a positive token count", () => {
    expect(estimateTokens("A short sentence.")).toBeGreaterThan(0);
    expect(estimateTokens("")).toBe(0);
  });
});
