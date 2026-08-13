import { describe, expect, it } from "vitest";
import { directIllustrationPrompt, isIllustrationSegmentEligible, segmentIllustrationText } from "../../packages/domain/src/illustrations.js";
import {
  buildBriefIllustrationStoryContext,
  buildIllustrationRefinementInput,
  parseRefinedPrompt
} from "../../services/runtime/src/illustration-segment-job-adapter.js";

describe("illustration segmentation", () => {
  it("keeps sentence boundaries within the configured word maximum", () => {
    const text = "One two three four. Five six seven. Eight nine ten eleven.";
    const segments = segmentIllustrationText(text, 6);
    expect(segments.map((segment) => segment.text.trim())).toEqual([
      "One two three four.",
      "Five six seven.",
      "Eight nine ten eleven."
    ]);
    expect(segments.every((segment) => segment.wordCount <= 6)).toBe(true);
  });

  it("splits an oversized sentence at a word boundary without losing text", () => {
    const text = "one two three four five six seven eight";
    const segments = segmentIllustrationText(text, 3);
    expect(segments.map((segment) => segment.wordCount)).toEqual([3, 3, 2]);
    expect(segments.map((segment) => segment.text).join("")).toBe(text);
  });

  it("skips a final section shorter than half the configured section length", () => {
    const segments = segmentIllustrationText("one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty one two three four five six seven eight nine", 20);

    expect(segments).toHaveLength(2);
    expect(isIllustrationSegmentEligible(segments[1]!, 20)).toBe(false);
    expect(isIllustrationSegmentEligible({ ...segments[1]!, wordCount: 10 }, 20)).toBe(true);
  });

  it("handles Unicode words and creates one segment when the maximum exceeds the turn", () => {
    const text = "Éowyn regarde l’aube. 東京の灯りが揺れる。";
    const segments = segmentIllustrationText(text, 500);
    expect(segments).toHaveLength(1);
    expect(segments[0]?.text).toBe(text);
  });

  it("produces direct visual instructions from the accepted fiction segment", () => {
    const prompt = directIllustrationPrompt("The lantern swings above the rain-dark bridge.");
    expect(prompt).toContain("The lantern swings above the rain-dark bridge.");
    expect(prompt).toContain("depicting only");
    expect(prompt).not.toContain("dice");
    expect(prompt).not.toContain("statistics");
  });

  it("builds brief fiction-only context separately from the excerpt", () => {
    const illustrationContext = {
      campaignTitle: "The Lantern Road",
      worldContent: { world: { title: "Night Roads", genre: "Fantasy", tone: "Eerie", premise: "Roads move after dusk." } },
      characterSnapshot: { name: "Mira", characterText: "A traveler in a silver rain cloak." },
      previousNarration: "The bridge vanished into the fog.",
      // Runtime input is deliberately narrower than the database row. An
      // unexpected private field must not become illustration context.
      scratchpad_private: "PRIVATE_ILLUSTRATION_SCRATCHPAD"
    };
    const context = buildBriefIllustrationStoryContext(illustrationContext);
    const input = buildIllustrationRefinementInput("Mira raises the lantern as the road bends.", context);
    expect(context).toContain("Player character appearance:");
    expect(context).toContain("Mira");
    expect(context).toContain("A traveler in a silver rain cloak.");
    expect(context).toContain("Previous scene: The bridge vanished into the fog.");
    expect(context).not.toContain("PRIVATE_ILLUSTRATION_SCRATCHPAD");
    expect(context.length).toBeLessThanOrEqual(1_800);
    expect(input).toContain("STORY CONTEXT");
    expect(input).toContain("FICTION EXCERPT TO ILLUSTRATE");
  });

  it("accepts the default raw prompt output and legacy JSON output", () => {
    expect(parseRefinedPrompt("Mira, raising a glass lantern, fogbound road, eerie moonlight, cinematic fantasy illustration"))
      .toContain("fogbound road");
    expect(parseRefinedPrompt('{"image_prompt":"Mira, glass lantern, eerie moonlight"}'))
      .toBe("Mira, glass lantern, eerie moonlight");
  });
});
