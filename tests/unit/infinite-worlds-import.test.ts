import { describe, expect, it } from "vitest";
import {
  convertInfiniteWorldsWorld,
  infiniteWorldsStoryToLegacyStory,
  parseInfiniteWorldsStory
} from "../../packages/domain/src/infinite-worlds.js";
import { infiniteWorldsImportRequestSchema } from "../../packages/contracts/src/imports.js";
import { WORLD_CONTENT_SCHEMA_VERSION } from "../../packages/contracts/src/world-library.js";
import { previewInfiniteWorldsImport } from "../../services/api/src/infinite-worlds-import-service.js";

describe("Infinite Worlds import conversion", () => {
  it("retains every character with isolated percentile skills and trackers", () => {
    const converted = convertInfiniteWorldsWorld({
      title: "Sanitized Test World",
      background: "A generic test setting.",
      objective: "Resolve the test objective.",
      possibleCharacters: [
        { name: "First", skills: { Insight: 1 } },
        { name: "Second", description: "The selected test character.", skills: { Insight: 5 }, initialTrackedItemValues: [{ name: "Clue", value: "Unknown" }] }
      ],
      triggerEvents: [{ name: "Arrival", triggerOnStartOfGame: true, triggerEffects: ["Introduce the setting."] }]
    });

    expect(converted.format).toBe("infinite-quest-world");
    expect(converted.content.schemaVersion).toBe(WORLD_CONTENT_SCHEMA_VERSION);
    expect(converted.content.world).not.toHaveProperty("character");
    expect(converted.content.playableCharacters).toHaveLength(2);
    expect(converted.content.playableCharacters[0]).toMatchObject({ name: "First", rpgStats: [expect.objectContaining({ name: "Insight", value: 20 })] });
    expect(converted.content.playableCharacters[1]).toMatchObject({
      name: "Second",
      rpgStats: [expect.objectContaining({ name: "Insight", value: 99 })],
      defaultTriggers: [expect.objectContaining({ name: "Clue", value: "Unknown" })]
    });
    expect(converted.content.rpgStats).toEqual([]);
    expect(converted.content.eventTriggers).toHaveLength(1);
    expect(converted.content).not.toHaveProperty("turns");
  });

  it("rejects world exports without a structured character roster", () => {
    expect(() => convertInfiniteWorldsWorld({
      title: "Empty Roster",
      background: "A world without character options.",
      possibleCharacters: []
    })).toThrow("has no playable characters");
  });

  it("reports a zero-character world as an invalid preview", async () => {
    const request = infiniteWorldsImportRequestSchema.parse({
      sourceName: "empty-roster.json",
      sourceKind: "world_json",
      sourceText: JSON.stringify({ title: "Empty Roster", possibleCharacters: [] })
    });

    const preview = await previewInfiniteWorldsImport({} as never, request);

    expect(preview).toMatchObject({
      kind: "world_json",
      valid: false,
      characters: [],
      warnings: [expect.stringContaining("no playable characters")]
    });
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

  it("uses the selected roster character when converting matching story text", () => {
    const world = convertInfiniteWorldsWorld({
      title: "Roster Test",
      possibleCharacters: [
        { name: "First", description: "First description", skills: { FirstSkill: 2 } },
        { name: "Second", description: "Second description", skills: { SecondSkill: 4 } }
      ]
    }).content;
    const parsed = parseInfiniteWorldsStory(`-- Character --\nSecond\n-- Turn 1 --\nOutcome\n-------\nThe story begins.`);
    const second = world.playableCharacters[1]!;
    const story = infiniteWorldsStoryToLegacyStory(parsed, world, "matching.txt", second.id);
    expect(story.world.character).toContain("Second description");
    expect(story.rpgStats).toContainEqual(expect.objectContaining({ name: "SecondSkill", value: 80 }));
    expect(JSON.stringify(story.rpgStats)).not.toContain("FirstSkill");
    expect(story.storyImportProvenance).toMatchObject({ selectedCharacterId: second.id, selectedCharacterName: "Second" });
  });
});
