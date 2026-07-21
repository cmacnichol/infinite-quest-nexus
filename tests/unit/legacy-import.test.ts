import { describe, expect, it } from "vitest";
import { legacyStorySchema } from "../../packages/contracts/src/imports.js";
import { WORLD_CONTENT_SCHEMA_VERSION } from "../../packages/contracts/src/world-library.js";
import { legacyWorldContent } from "../../services/api/src/import-service.js";

describe("legacy campaign world conversion", () => {
  it("converts unstructured character guidance into a deterministic roster entry", () => {
    const story = legacyStorySchema.parse({
      world: {
        title: "Imported Test",
        character: "Test Character\nA portable campaign protagonist."
      },
      turns: [],
      rpgStats: [{ name: "Insight", value: 70 }],
      defaultTriggers: [{ name: "Clues", value: "None" }]
    });

    const first = legacyWorldContent(story);
    const second = legacyWorldContent(story);

    expect(first.schemaVersion).toBe(WORLD_CONTENT_SCHEMA_VERSION);
    expect(first.world).not.toHaveProperty("character");
    expect(first.playableCharacters).toHaveLength(1);
    expect(first.playableCharacters[0]).toMatchObject({
      id: expect.stringMatching(/^legacy-import-character-[a-f0-9]{24}$/),
      name: "Test Character",
      characterText: "Test Character\nA portable campaign protagonist.",
      rpgStats: [{ name: "Insight", value: 70 }],
      defaultTriggers: [{ name: "Clues", value: "None" }],
      source: { type: "legacy-campaign-import" }
    });
    expect(second.playableCharacters[0]?.id).toBe(first.playableCharacters[0]?.id);
    expect(first.rpgStats).toEqual([]);
    expect(first.defaultTriggers).toEqual([]);
  });

  it("preserves the selected roster identity from a portable campaign export", () => {
    const story = legacyStorySchema.parse({
      world: { title: "Round Trip", character: "Selected character text." },
      turns: [],
      storyImportProvenance: {
        sourceType: "nexus_campaign_export",
        selectedCharacterId: "selected-character-id",
        selectedCharacterName: "Selected Character"
      }
    });

    expect(legacyWorldContent(story).playableCharacters[0]).toMatchObject({
      id: "selected-character-id",
      name: "Selected Character",
      characterText: "Selected character text.",
      source: { type: "nexus-campaign-export" }
    });
  });
});
