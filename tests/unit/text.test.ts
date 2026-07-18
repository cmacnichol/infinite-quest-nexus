import { describe, expect, it } from "vitest";
import { estimateTokens, removeProviderSecrets, stableStringify, stripMechanicsLeakage } from "../../packages/domain/src/text.js";

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
