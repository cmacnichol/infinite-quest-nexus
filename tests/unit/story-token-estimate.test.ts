import { describe, expect, it } from "vitest";
import { estimateStoryTokens } from "../../packages/story-engine/src/token-estimate.js";

describe("story token estimation", () => {
  it.each([
    ["ASCII prose", "one two", 3],
    ["punctuation-heavy JSON", "{\"a\":1}", 6],
    ["ASCII whitespace", "   \n\t", 2],
    ["CJK text", "雪山", 6],
    ["emoji", "🧭", 4],
    ["mixed content", "A雪🧭B", 9]
  ])("returns the documented deterministic estimate for %s", (_name, text, expected) => {
    const estimate = estimateStoryTokens(text);

    expect(estimate).toBe(expected);
    expect(estimate).toBe(estimateStoryTokens(text));
    expect(Number.isInteger(estimate)).toBe(true);
    expect(estimate).toBeGreaterThanOrEqual(0);
  });
});
