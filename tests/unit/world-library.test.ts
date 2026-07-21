import { describe, expect, it } from "vitest";
import {
  WORLD_CONTENT_SCHEMA_VERSION,
  campaignCreateSchema,
  canonicalizeWorldContent,
  portableWorldSchema,
  worldContentSchema,
  worldDraftUpdateSchema,
  worldVersionDeleteSchema,
  type WorldContent
} from "../../packages/contracts/src/world-library.js";
import {
  assessWorldCampaignReadiness,
  campaignCharacterSeed,
  characterSnapshot,
  resolvePlayableCharacters,
  selectPlayableCharacter
} from "../../packages/domain/src/world-characters.js";

describe("World Library contracts", () => {
  it("normalizes new, incomplete drafts without requiring a playable character", () => {
    const content = worldContentSchema.parse({ world: { title: "Synthetic Test World" } });
    expect(content).toMatchObject({
      schemaVersion: WORLD_CONTENT_SCHEMA_VERSION,
      playableCharacters: [],
      entities: [],
      relationships: [],
      rpgStats: [],
      defaultTriggers: [],
      eventTriggers: [],
      assets: [],
      defaults: {}
    });
  });

  it("continues to parse older positive schema versions", () => {
    expect(worldContentSchema.parse({
      schemaVersion: 2,
      world: { title: "Older Test World", character: "Historical guidance" }
    })).toMatchObject({
      schemaVersion: 2,
      world: { title: "Older Test World", character: "Historical guidance" }
    });
    expect(() => worldContentSchema.parse({
      schemaVersion: 0,
      world: { title: "Invalid Test World" }
    })).toThrow();
  });

  it("canonicalizes writes to version 4 without dropping unknown lore fields", () => {
    const source = {
      schemaVersion: 2,
      world: {
        title: "Older Test World",
        character: "Obsolete guidance",
        cosmology: { moons: 3 }
      },
      customLore: { factions: ["Synthetic Guild"] }
    };

    const canonical = canonicalizeWorldContent(source);

    expect(canonical.schemaVersion).toBe(WORLD_CONTENT_SCHEMA_VERSION);
    expect("character" in canonical.world).toBe(false);
    expect(canonical.world.cosmology).toEqual({ moons: 3 });
    expect(canonical.customLore).toEqual({ factions: ["Synthetic Guild"] });
    expect(source.world.character).toBe("Obsolete guidance");
  });

  it("requires optimistic revision numbers for draft updates", () => {
    expect(() => worldDraftUpdateSchema.parse({ expectedRevision: 0, content: { world: { title: "Synthetic Test World" } } })).toThrow();
  });

  it("requires an explicit confirmation and expected published version number for deletion", () => {
    expect(worldVersionDeleteSchema.parse({ confirmation: "DELETE", expectedVersionNumber: 2 }))
      .toEqual({ confirmation: "DELETE", expectedVersionNumber: 2 });
    expect(() => worldVersionDeleteSchema.parse({ confirmation: "delete", expectedVersionNumber: 2 })).toThrow();
    expect(() => worldVersionDeleteSchema.parse({ confirmation: "DELETE", expectedVersionNumber: 0 })).toThrow();
  });

  it("keeps portable world and campaign references typed", () => {
    const portable = portableWorldSchema.parse({
      format: "infinite-quest-world",
      formatVersion: 1,
      title: "Synthetic Test World",
      content: { world: { title: "Synthetic Test World" } }
    });
    expect(portable.content.world.title).toBe("Synthetic Test World");
    expect(() => campaignCreateSchema.parse({ title: "Synthetic Campaign", worldVersionId: "not-a-uuid" })).toThrow();
  });
});

describe("playable character campaign readiness", () => {
  it("reports an empty draft as valid content but not campaign-ready", () => {
    const content = worldContentSchema.parse({ world: { title: "Incomplete Test World" } });
    expect(assessWorldCampaignReadiness(content)).toEqual({
      ready: false,
      issues: [{
        code: "no-playable-characters",
        message: "This world version has no playable characters."
      }]
    });
  });

  it("reports duplicate IDs and incomplete character guidance", () => {
    const parsed = worldContentSchema.parse({
      world: { title: "Roster Test" },
      playableCharacters: [
        { id: "duplicate", name: "First", characterText: "First guidance" },
        { id: "duplicate", name: "Second", characterText: "" }
      ]
    });
    const content = {
      ...parsed,
      playableCharacters: [
        parsed.playableCharacters[0],
        { ...parsed.playableCharacters[1], name: "" }
      ]
    } as WorldContent;

    expect(assessWorldCampaignReadiness(content)).toMatchObject({
      ready: false,
      issues: [
        { code: "duplicate-character-id", characterIndex: 1, characterId: "duplicate" },
        { code: "missing-character-name", characterIndex: 1, characterId: "duplicate" },
        { code: "missing-character-text", characterIndex: 1, characterId: "duplicate" }
      ]
    });
  });

  it("accepts a complete structured roster", () => {
    const content = worldContentSchema.parse({
      world: { title: "Ready Test World" },
      playableCharacters: [{ id: "hero", name: "Hero", characterText: "Hero guidance" }]
    });
    expect(assessWorldCampaignReadiness(content)).toEqual({ ready: true, issues: [] });
  });
});

describe("playable character selection", () => {
  it("never synthesizes a character from historical world guidance", () => {
    const content = worldContentSchema.parse({
      schemaVersion: 2,
      world: { title: "Historical Test World", character: "Historical Hero" }
    });
    expect(resolvePlayableCharacters(content)).toBe(content.playableCharacters);
    expect(resolvePlayableCharacters(content)).toEqual([]);
    expect(() => selectPlayableCharacter(content)).toThrow("This world version has no playable characters.");
  });

  it("selects one character automatically and requires a selection for several", () => {
    const single = worldContentSchema.parse({
      world: { title: "Single Roster Test" },
      playableCharacters: [{ id: "only", name: "Only", characterText: "Only guidance" }]
    });
    expect(selectPlayableCharacter(single)).toMatchObject({ id: "only", characterText: "Only guidance" });

    const multiple = worldContentSchema.parse({
      world: { title: "Multiple Roster Test" },
      playableCharacters: [
        { id: "first", name: "First", characterText: "First guidance" },
        { id: "second", name: "Second", characterText: "Second guidance" }
      ]
    });
    expect(() => selectPlayableCharacter(multiple)).toThrow("Select a playable character for this campaign.");
    expect(selectPlayableCharacter(multiple, "second")).toMatchObject({ id: "second" });
    expect(() => selectPlayableCharacter(multiple, "missing")).toThrow("The selected playable character does not belong to this world version.");
  });

  it("merges world defaults with only the selected character defaults", () => {
    const content = worldContentSchema.parse({
      world: { title: "Defaults Test" },
      rpgStats: [
        { id: "shared-stat", name: "Shared stat", value: 50 },
        { id: "overridden-stat", name: "Resolve", value: 40 }
      ],
      defaultTriggers: [{ id: "shared-trigger", name: "Shared trigger", value: 1 }],
      playableCharacters: [
        {
          id: "first",
          name: "First",
          characterText: "First guidance",
          rpgStats: [{ id: "first-stat", name: "First stat", value: 60 }],
          defaultTriggers: [{ id: "first-trigger", name: "First trigger", value: 2 }]
        },
        {
          id: "second",
          name: "Second",
          characterText: "Second guidance",
          rpgStats: [
            { id: "overridden-stat", name: "Resolve", value: 70 },
            { id: "second-stat", name: "Second stat", value: 80 }
          ],
          defaultTriggers: [{ id: "second-trigger", name: "Second trigger", value: 3 }]
        }
      ]
    });

    expect(campaignCharacterSeed(content, "second")).toMatchObject({
      character: { id: "second", characterText: "Second guidance" },
      rpgStats: [
        { id: "shared-stat" },
        { id: "overridden-stat", value: 70 },
        { id: "second-stat" }
      ],
      defaultTriggers: [{ id: "shared-trigger" }, { id: "second-trigger" }]
    });
  });

  it("does not carry the retired legacy marker into new snapshots", () => {
    const content = worldContentSchema.parse({
      world: { title: "Snapshot Test" },
      playableCharacters: [{
        id: "hero",
        name: "Hero",
        characterText: "Hero guidance",
        legacy: true,
        source: { type: "campaign-import" }
      }]
    });

    expect(characterSnapshot(content.playableCharacters[0]!)).toEqual({
      id: "hero",
      name: "Hero",
      characterText: "Hero guidance",
      rpgStats: [],
      defaultTriggers: [],
      source: { type: "campaign-import" }
    });
  });
});
