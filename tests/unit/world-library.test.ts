import { describe, expect, it } from "vitest";
import {
  campaignCreateSchema,
  portableWorldSchema,
  worldContentSchema,
  worldDraftUpdateSchema
} from "../../packages/contracts/src/world-library.js";
import { campaignCharacterSeed, resolvePlayableCharacters } from "../../packages/domain/src/world-characters.js";

describe("World Library contracts", () => {
  it("normalizes optional world collections", () => {
    const content = worldContentSchema.parse({ world: { title: "Synthetic Test World" } });
    expect(content).toMatchObject({
      schemaVersion: 3,
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

  it("resolves legacy worlds as one character and keeps structured character state isolated", () => {
    const legacy = worldContentSchema.parse({
      schemaVersion: 2,
      world: { title: "Legacy Test", character: "Legacy Hero" },
      rpgStats: [{ id: "legacy-stat", name: "Legacy", value: 50 }]
    });
    expect(resolvePlayableCharacters(legacy)).toMatchObject([{ id: "legacy-default", characterText: "Legacy Hero", legacy: true }]);

    const structured = worldContentSchema.parse({
      world: { title: "Roster Test", character: "Default" },
      rpgStats: [{ id: "shared", name: "Shared", value: 50 }],
      playableCharacters: [
        { id: "first", name: "First", characterText: "First text", rpgStats: [{ id: "first-stat", name: "First stat", value: 60 }] },
        { id: "second", name: "Second", characterText: "Second text", rpgStats: [{ id: "second-stat", name: "Second stat", value: 70 }] }
      ]
    });
    expect(() => campaignCharacterSeed(structured)).toThrow(/Select a playable character/);
    expect(campaignCharacterSeed(structured, "second")).toMatchObject({
      character: { id: "second", characterText: "Second text" },
      rpgStats: [{ id: "shared" }, { id: "second-stat" }]
    });
    expect(() => campaignCharacterSeed(structured, "missing")).toThrow(/does not belong/);
  });

  it("requires optimistic revision numbers for draft updates", () => {
    expect(() => worldDraftUpdateSchema.parse({ expectedRevision: 0, content: { world: { title: "Synthetic Test World" } } })).toThrow();
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
