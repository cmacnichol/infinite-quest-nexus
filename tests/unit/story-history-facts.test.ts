import { describe, expect, it } from "vitest";
import { selectProtectedFacts, type ProtectedFact } from "../../packages/domain/src/story-history-projection.js";

const facts = (values: readonly string[]): readonly ProtectedFact[] => values.map((content, index) => ({
  id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
  turnNumber: index + 1,
  content
}));

describe("selectProtectedFacts", () => {
  it("keeps complete newest fitting records, skips a non-fitting record, and restores chronology", () => {
    const source = facts(["older small fact", "x".repeat(1_000), "newer small fact"]);
    const selected = selectProtectedFacts(source, 20);

    expect(selected.facts.map((fact) => fact.content)).toEqual(["older small fact", "newer small fact"]);
    expect(selected.omittedCount).toBe(1);
  });

  it("does not truncate a fact to make it fit", () => {
    const source = facts(["x".repeat(1_000)]);
    expect(selectProtectedFacts(source, 1)).toEqual({ facts: [], omittedCount: 1 });
  });
});
