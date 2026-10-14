import { describe, expect, it } from "vitest";
import { DEFAULT_ILLUSTRATION_REFINEMENT_PROMPT } from "../../packages/contracts/src/generation.js";
import {
  composeIllustrationProviderPrompt,
  directIllustrationPrompt,
  illustrationScenePrompt,
  isIllustrationSegmentEligible,
  MAX_ILLUSTRATION_PROVIDER_PROMPT_CHARACTERS,
  segmentIllustrationText
} from "../../packages/domain/src/illustrations.js";
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

  it("keeps exclusions out of the positive direct prompt", () => {
    const prompt = directIllustrationPrompt("The lantern swings above the rain-dark bridge.");
    expect(prompt).not.toMatch(/\b(?:do not|don't|no|without|avoid)\b/i);
  });

  it("adds the campaign art style ahead of the character reference and strips both when recomposed", () => {
    const composed = composeIllustrationProviderPrompt(
      "A rope bridge over a black river", "Name: Mira\nHair: silver braid", undefined, { artStyle: "Ink and watercolor storybook" }
    );
    expect(composed.indexOf("ART STYLE:\nInk and watercolor storybook")).toBeGreaterThan(0);
    expect(composed.indexOf("ART STYLE:")).toBeLessThan(composed.indexOf("CANONICAL CHARACTER REFERENCE:"));
    expect(illustrationScenePrompt(composed)).toBe("A rope bridge over a black river");
    expect(composeIllustrationProviderPrompt(composed, "Name: Mira\nHair: silver braid", undefined, { artStyle: "Ink and watercolor storybook" }))
      .toBe(composed);
  });

  it("shortens an oversized scene so the provider prompt stays within its budget", () => {
    const scene = "Rain falls on the long causeway as the procession moves north. ".repeat(200);
    const composed = composeIllustrationProviderPrompt(scene, "Name: Mira\nHair: silver braid", undefined, { artStyle: "Oil painting" });
    expect(composed.length).toBeLessThanOrEqual(MAX_ILLUSTRATION_PROVIDER_PROMPT_CHARACTERS);
    expect(composed).toContain("ART STYLE:\nOil painting");
    expect(composed).toContain("Hair: silver braid");
    expect(composed.startsWith("Rain falls on the long causeway")).toBe(true);
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

  it("keeps the end of the previous turn and the preceding excerpt for continuity", () => {
    const opening = "The caravan left the city at dawn. ".repeat(40);
    const context = buildBriefIllustrationStoryContext({
      campaignTitle: "The Lantern Road",
      worldContent: { world: { title: "Night Roads" } },
      characterSnapshot: null,
      previousNarration: `${opening}At dusk they reached the drowned chapel.`,
      precedingExcerpt: `${"Rain hammered the roof. ".repeat(40)}Mira lit the last candle.`
    });
    expect(context).toContain("At dusk they reached the drowned chapel.");
    expect(context).toContain("Earlier in this turn:");
    expect(context).toContain("Mira lit the last candle.");
    expect(context.length).toBeLessThanOrEqual(2_400);
  });

  it("tells the refiner the campaign's fixed art style", () => {
    const context = buildBriefIllustrationStoryContext({
      campaignTitle: "The Lantern Road",
      worldContent: { world: { title: "Night Roads" } },
      characterSnapshot: null,
      previousNarration: "",
      artStyle: "Ink and watercolor storybook"
    });
    expect(context).toContain("Art style (fixed for every illustration): Ink and watercolor storybook");
  });

  it("asks the refiner for a bounded, positive-only prompt that respects a fixed art style", () => {
    expect(DEFAULT_ILLUSTRATION_REFINEMENT_PROMPT).toMatch(/art style/i);
    expect(DEFAULT_ILLUSTRATION_REFINEMENT_PROMPT).toMatch(/\b\d+ words\b/);
    expect(DEFAULT_ILLUSTRATION_REFINEMENT_PROMPT).toMatch(/negative/i);
    expect(DEFAULT_ILLUSTRATION_REFINEMENT_PROMPT).toMatch(/composition|framing/i);
  });

  it("accepts the default raw prompt output and legacy JSON output", () => {
    expect(parseRefinedPrompt("Mira, raising a glass lantern, fogbound road, eerie moonlight, cinematic fantasy illustration"))
      .toContain("fogbound road");
    expect(parseRefinedPrompt('{"image_prompt":"Mira, glass lantern, eerie moonlight"}'))
      .toBe("Mira, glass lantern, eerie moonlight");
  });
});
