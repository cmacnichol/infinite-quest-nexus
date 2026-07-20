import { describe, expect, it } from "vitest";
import {
  convertInfiniteWorldsWorld,
  infiniteWorldsStoryToLegacyStory,
  parseInfiniteWorldsStory
} from "../../packages/domain/src/infinite-worlds.js";

describe("Infinite Worlds import conversion", () => {
  it("converts a selected character, percentile skills, trackers, and triggers into a portable world", () => {
    const converted = convertInfiniteWorldsWorld({
      title: "Sanitized Test World",
      background: "A generic test setting.",
      objective: "Resolve the test objective.",
      possibleCharacters: [
        { name: "First", skills: { Insight: 1 } },
        { name: "Second", description: "The selected test character.", skills: { Insight: 5 }, initialTrackedItemValues: [{ name: "Clue", value: "Unknown" }] }
      ],
      triggerEvents: [{ name: "Arrival", triggerOnStartOfGame: true, triggerEffects: ["Introduce the setting."] }]
    }, 1);

    expect(converted.format).toBe("infinite-quest-world");
    expect(converted.content.world.character).toContain("Second");
    expect(converted.content.rpgStats).toContainEqual(expect.objectContaining({ name: "Insight", value: 99 }));
    expect(converted.content.defaultTriggers).toContainEqual(expect.objectContaining({ name: "Clue", value: "Unknown" }));
    expect(converted.content.eventTriggers).toHaveLength(1);
    expect(converted.content).not.toHaveProperty("turns");
  });

  it("parses story turns, reuses the next selected action, and removes mechanic leakage", () => {
    const parsed = parseInfiniteWorldsStory(`-- Story Background --
A sanitized test history.
-- Character --
Test Character
-- Turn 1 --
Outcome
-------
The character reaches the gate. A d20 roll succeeds.
-- Turn 2 --
Action
------
Open the gate
Outcome
-------
The gate opens into a quiet courtyard.`);
    const world = convertInfiniteWorldsWorld({ title: "Test", background: "Test", possibleCharacters: [{ name: "Test Character" }] }).content;
    const story = infiniteWorldsStoryToLegacyStory(parsed, world, "sanitized.txt");

    expect(story.turns).toHaveLength(2);
    expect(story.turns[0]?.choices).toEqual(["Open the gate"]);
    expect(story.turns[0]?.narration).not.toMatch(/d20|roll|succeeds/i);
    expect(story.fullHistory).not.toMatch(/d20|roll succeeds/i);
  });
});
