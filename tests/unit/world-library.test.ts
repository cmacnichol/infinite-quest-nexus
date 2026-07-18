import { describe, expect, it } from "vitest";
import {
  campaignCreateSchema,
  portableWorldSchema,
  worldContentSchema,
  worldDraftUpdateSchema
} from "../../packages/contracts/src/world-library.js";

describe("World Library contracts", () => {
  it("normalizes optional world collections", () => {
    const content = worldContentSchema.parse({ world: { title: "Synthetic Test World" } });
    expect(content).toMatchObject({
      schemaVersion: 2,
      entities: [],
      relationships: [],
      rpgStats: [],
      defaultTriggers: [],
      eventTriggers: [],
      assets: [],
      defaults: {}
    });
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
