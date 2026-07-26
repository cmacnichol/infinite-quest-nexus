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

  it("preserves relative asset URLs in safeExternalImageUrl and detects image mime types from signatures", async () => {
    const { safeExternalImageUrl, detectMimeType } = await import("../../services/api/src/asset-service.js");
    expect(safeExternalImageUrl("/api/v1/assets/9a3f2b1d-8e4c-4a31-b657-123456789abc")).toBe("/api/v1/assets/9a3f2b1d-8e4c-4a31-b657-123456789abc");
    expect(safeExternalImageUrl("assets/9a3f2b1d-8e4c-4a31-b657-123456789abc.png")).toBe("assets/9a3f2b1d-8e4c-4a31-b657-123456789abc.png");
    expect(safeExternalImageUrl("https://example.com/photo.jpg")).toBe("https://example.com/photo.jpg");
    expect(safeExternalImageUrl("javascript:alert(1)")).toBe("");
    expect(safeExternalImageUrl("//example.com/photo.jpg")).toBe("");
    expect(safeExternalImageUrl("/etc/passwd")).toBe("");

    const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const jpegHeader = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
    const webpHeader = Buffer.from("RIFF1234WEBP", "ascii");
    expect(detectMimeType(pngHeader)).toBe("image/png");
    expect(detectMimeType(jpegHeader)).toBe("image/jpeg");
    expect(detectMimeType(webpHeader)).toBe("image/webp");
  });
});
