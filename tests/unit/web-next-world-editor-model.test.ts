import { describe, expect, it } from "vitest";
import {
  cloneWorldDraft,
  parseWorldAggregate,
  worldEditorPath,
  worldIdFromPath
} from "../../apps/web-next/src/world-editor-model.js";

const worldAggregateFixture = {
  id: "22222222-2222-4222-8222-222222222222",
  title: "The Glass Observatory",
  status: "draft",
  imageUrl: "",
  forkedFromWorldId: null,
  forkedFromWorldVersionId: null,
  createdAt: "2026-08-11T12:00:00.000Z",
  updatedAt: "2026-08-11T12:30:00.000Z",
  draftRevision: 8,
  draftContent: {
    schemaVersion: 4,
    world: {
      title: "The Glass Observatory",
      genre: "Science fantasy",
      tone: "Numinous",
      premise: "A glass observatory watches impossible stars.",
      backgroundStory: "Its astronomers vanished.",
      firstAction: "Open the western dome.",
      rules: "Reflections remember.",
      customLore: { constellation: "The Pilgrim" }
    },
    playableCharacters: [],
    entities: [],
    relationships: [],
    rpgStats: [],
    defaultTriggers: [],
    eventTriggers: [],
    assets: [],
    defaults: {}
  },
  draftBasedOnWorldVersionId: null,
  draftUpdatedAt: "2026-08-11T12:30:00.000Z",
  versions: [{
    id: "33333333-3333-4333-8333-333333333333",
    versionNumber: 1,
    sourceHash: null,
    releaseNotes: "First light",
    createdFromRevision: 7,
    publishedAt: "2026-08-10T12:00:00.000Z",
    createdAt: "2026-08-10T12:00:00.000Z",
    deletable: true,
    deletionBlockers: {
      currentCampaigns: 0,
      campaignMigrations: 0,
      campaignTransfers: 0,
      chronicleMemories: 0,
      modelChains: 0
    },
    detachments: { drafts: 0, forks: 0, imports: 0 }
  }],
  campaigns: [{
    id: "44444444-4444-4444-8444-444444444444",
    title: "The Long Night",
    status: "active",
    activeTurnNumber: 3,
    worldVersionId: "33333333-3333-4333-8333-333333333333",
    worldVersionNumber: 1,
    selectedCharacterId: null,
    selectedCharacterName: null,
    turnControlStyle: "flexible_auto",
    updatedAt: "2026-08-11T12:15:00.000Z"
  }]
};

describe("World Editor browser boundary", () => {
  it("builds and recognizes replacement-app world routes", () => {
    expect(worldEditorPath("world / 1")).toBe("/app/worlds/world%20%2F%201");
    expect(worldIdFromPath("/app/worlds/22222222-2222-4222-8222-222222222222")).toBe(
      "22222222-2222-4222-8222-222222222222"
    );
    expect(worldIdFromPath("/app/")).toBeNull();
  });

  it("strictly parses world aggregates while preserving nested world data", () => {
    const aggregate = parseWorldAggregate(worldAggregateFixture);

    expect(aggregate.draftRevision).toBe(8);
    expect(aggregate.draftContent?.world.title).toBe("The Glass Observatory");
    expect(aggregate.draftContent?.world.customLore).toEqual({ constellation: "The Pilgrim" });
    expect(() => parseWorldAggregate({ id: "missing" })).toThrow("unexpected world response");
  });

  it.each([
    ["world status", { ...worldAggregateFixture, status: { toString: () => "draft" } }],
    ["campaign status", {
      ...worldAggregateFixture,
      campaigns: [{ ...worldAggregateFixture.campaigns[0], status: { toString: () => "active" } }]
    }],
    ["campaign turn control style", {
      ...worldAggregateFixture,
      campaigns: [{
        ...worldAggregateFixture.campaigns[0],
        turnControlStyle: { toString: () => "flexible_auto" }
      }]
    }]
  ])("rejects a non-string %s before checking its allowed values", (_field, response) => {
    expect(() => parseWorldAggregate(response)).toThrow("unexpected world response");
  });

  it.each([
    ["versions collection", { ...worldAggregateFixture, versions: {} }],
    ["campaigns collection", { ...worldAggregateFixture, campaigns: "active" }],
    ["draft content array", {
      ...worldAggregateFixture,
      draftContent: { ...worldAggregateFixture.draftContent, entities: {} }
    }],
    ["version summary", { ...worldAggregateFixture, versions: [{ ...worldAggregateFixture.versions[0], detachments: [] }] }],
    ["campaign summary", {
      ...worldAggregateFixture,
      campaigns: [{ ...worldAggregateFixture.campaigns[0], worldVersionNumber: "1" }]
    }]
  ])("rejects a malformed %s", (_boundary, response) => {
    expect(() => parseWorldAggregate(response)).toThrow("unexpected world response");
  });

  it("clones an editable draft without mutating the parsed aggregate", () => {
    const aggregate = parseWorldAggregate(worldAggregateFixture);
    const draft = cloneWorldDraft(aggregate);

    draft.world.title = "Changed locally";

    expect(draft.schemaVersion).toBe(5);
    expect(aggregate.draftContent?.world.title).toBe("The Glass Observatory");
  });

  it("creates an empty schema-version-five draft when no draft exists", () => {
    const aggregate = parseWorldAggregate({
      ...worldAggregateFixture,
      draftRevision: null,
      draftContent: null,
      draftUpdatedAt: null
    });

    expect(cloneWorldDraft(aggregate)).toEqual({
      schemaVersion: 5,
      world: { title: "", genre: "", tone: "", premise: "", backgroundStory: "", firstAction: "", rules: "" },
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
});
