import { describe, expect, it } from "vitest";
import { projectCastFictionText } from "../../packages/domain/src/character-fiction-authority.js";

describe("provider-bound cast fiction", () => {
  it("removes reasoning and mechanics while preserving ordinary fiction", () => {
    const result = projectCastFictionText("Mara wears a green cloak. <think>private plan survives here.</think> Roll a d20. She guards the old bridge.");
    expect(result).toContain("Mara wears a green cloak.");
    expect(result).toContain("She guards the old bridge.");
    expect(result).not.toContain("private plan");
    expect(result).not.toContain("d20");
  });
  it("drops unterminated reasoning and caps values", () => {
    expect(projectCastFictionText("Mara waits. <analysis>private content")).toBe("Mara waits.");
    expect(projectCastFictionText("x".repeat(700))).toHaveLength(600);
  });
});
