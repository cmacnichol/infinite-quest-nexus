import { describe, expect, it } from "vitest";
import { buildStoryUserPrompt, compactStoryLengthWordRange } from "../../packages/story-engine/src/prompt.js";

describe("compactStoryLengthWordRange", () => {
  it("caps large input limits to the compact profile limits", () => {
    const input = { profile: "standard" as const, minWords: 1000, maxWords: 2000 };
    // standard compact profile has minWords: 300, maxWords: 450
    const result = compactStoryLengthWordRange(input);
    expect(result).toEqual({ profile: "standard", minWords: 300, maxWords: 450 });
  });

  it("retains input limits when they are already smaller than the compact limits", () => {
    const input = { profile: "long" as const, minWords: 100, maxWords: 200 };
    // long compact profile has minWords: 400, maxWords: 600
    const result = compactStoryLengthWordRange(input);
    expect(result).toEqual({ profile: "long", minWords: 100, maxWords: 200 });
  });

  it("handles mixed conditions where min is smaller but max is larger", () => {
    const input = { profile: "extended" as const, minWords: 250, maxWords: 1000 };
    // extended compact profile has minWords: 450, maxWords: 650
    const result = compactStoryLengthWordRange(input);
    expect(result).toEqual({ profile: "extended", minWords: 250, maxWords: 650 });
  });

  it("handles mixed conditions where min is larger but max is smaller (unusual input)", () => {
    const input = { profile: "brief" as const, minWords: 500, maxWords: 150 };
    // brief compact profile has minWords: 200, maxWords: 350
    const result = compactStoryLengthWordRange(input);
    expect(result).toEqual({ profile: "brief", minWords: 200, maxWords: 150 });
  });

  it("returns exactly the compact limits if input matches exactly", () => {
    const input = { profile: "brief" as const, minWords: 200, maxWords: 350 };
    const result = compactStoryLengthWordRange(input);
    expect(result).toEqual({ profile: "brief", minWords: 200, maxWords: 350 });
  });
});

describe("current continuity prompt authority", () => {
  it("places an exact current correction in the authoritative envelope with its conflict rule", () => {
    const currentContinuity = {
      continuitySummary: "The keeper is alive.",
      openThreads: [],
      canonicalFacts: [],
      scratchpad: ""
    };

    const input = JSON.parse(buildStoryUserPrompt({
      worldCanon: {},
      campaignCanon: {},
      chronicle: [],
      currentScene: null,
      currentContinuity
    }, "Ask the keeper about the harbor."));

    expect(input.authoritative_context.currentContinuity).toEqual(currentContinuity);
    expect(input.instructions.join(" ")).toContain("corrected current continuity");
  });
});
