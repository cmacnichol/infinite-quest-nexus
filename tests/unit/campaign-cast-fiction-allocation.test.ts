import { describe, expect, it } from "vitest";
import { estimateTokens } from "../../packages/domain/src/text.js";
import { allocateCastFictionContext } from "../../packages/domain/src/campaign-cast-context.js";

const people = Array.from({ length: 30 }, (_, index) => ({ characterId: String(index).padStart(2, "0"), name: `Character ${index}`,
  fields: [{ field: "story.role", value: "R".repeat(150), source: "authored" }, { field: "story.background", value: "B".repeat(400), source: "authored" }] }));

describe("cast context identity and field allocation", () => {
  it("returns no envelope at zero headroom", () => {
    const result = allocateCastFictionContext(people, 0);
    expect(result.content).toBe("");
    expect(result.omittedCharacterIds).toHaveLength(30);
  });
  it("admits only the first identity when exactly one fits", () => {
    const candidates = [{ characterId: "one", name: "Mara", fields: [] }, { characterId: "two", name: "Iven", fields: [] }];
    const coverage = { fromTurn: null, throughTurn: null, baseTurn: 0, current: false };
    const budget = estimateTokens(JSON.stringify({ coverage, notice: "", characters: [{ characterId: "one", name: "Mara", revision: 0, fields: [] }] }));
    const result = allocateCastFictionContext(candidates, budget);
    expect(JSON.parse(result.content).characters.map((item: any) => item.characterId)).toEqual(["one"]);
    expect(result.omittedCharacterIds).toEqual(["two"]);
  });
  it("reserves identities first and distributes core fields before optional fields", () => {
    const result = allocateCastFictionContext(people, 400);
    expect(result.estimatedTokens).toBeLessThanOrEqual(400);
    const sent = JSON.parse(result.content).characters;
    expect(sent.length).toBeGreaterThan(1);
    expect(sent.every((entry: any) => entry.characterId && entry.name)).toBe(true);
    const firstBackground = sent.findIndex((entry: any) => entry.fields.some((field: any) => field.field === "story.background"));
    if (firstBackground >= 0) expect(sent.every((entry: any) => entry.fields.some((field: any) => field.field === "story.role"))).toBe(true);
  });
});
