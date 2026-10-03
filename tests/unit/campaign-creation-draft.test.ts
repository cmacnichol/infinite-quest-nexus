import { describe, expect, it } from "vitest";
import {
  buildCampaignCreateRequest,
  createCampaignCreationDraft,
  type CampaignCreationDraft
} from "../../packages/client-core/src/campaign-creation-draft.js";

const world = {
  id: "00000000-0000-4000-8000-000000000001",
  worldVersionId: "00000000-0000-4000-8000-000000000002",
  title: "A Test World",
  playableCharacters: [
    { id: "00000000-0000-4000-8000-000000000003", name: "Hero" },
    { id: "00000000-0000-4000-8000-000000000004", name: "Scout" }
  ]
};

function draft(overrides: Partial<CampaignCreationDraft> = {}): CampaignCreationDraft {
  return {
    worldId: world.id,
    worldVersionId: world.worldVersionId,
    title: "My Campaign",
    selectedCharacterId: "00000000-0000-4000-8000-000000000003",
    turnControlStyle: "flexible_action",
    startAfterCreate: true,
    ...overrides
  };
}

describe("campaign creation draft policy", () => {
  it("uses a saved flexible scene preference in every create request", () => {
    const value = {
      ...createCampaignCreationDraft({
        world,
        userSettings: { defaultTurnControlStyle: "flexible_scene" }
      }),
      title: "A campaign"
    };

    expect(value.turnControlStyle).toBe("flexible_scene");
    expect(buildCampaignCreateRequest(value)).toMatchObject({
      worldVersionId: world.worldVersionId,
      turnControlStyle: "flexible_scene"
    });
  });

  it("uses an explicit draft selection over the saved preference", () => {
    const value = {
      ...createCampaignCreationDraft({
        world,
        userSettings: { defaultTurnControlStyle: "flexible_scene" }
      }),
      title: "A campaign"
    };

    expect(buildCampaignCreateRequest({ ...value, turnControlStyle: "action_only" }).turnControlStyle).toBe("action_only");
  });

  it.each([
    ["action_only", "action_only"],
    ["flexible_auto", "flexible_action"],
    ["flexible_action", "flexible_action"],
    ["flexible_scene", "flexible_scene"]
  ] as const)("normalizes historical preference %s to %s", (saved, expected) => {
    const value = createCampaignCreationDraft({ world, userSettings: { defaultTurnControlStyle: saved } });

    expect(value.turnControlStyle).toBe(expected);
  });

  it("rejects a request without an available playable character", () => {
    expect(() => buildCampaignCreateRequest(draft({ selectedCharacterId: null }))).toThrow(/playable character/i);
    expect(() => createCampaignCreationDraft({
      world: { ...world, playableCharacters: [] },
      userSettings: { defaultTurnControlStyle: "flexible_action" }
    })).toThrow(/playable character/i);
  });

  it("validates the selected character against the shared create contract", () => {
    expect(() => buildCampaignCreateRequest(draft({ selectedCharacterId: "x".repeat(201) }))).toThrow();
  });

  it("pins the immutable world version supplied by the server", () => {
    const value = { ...createCampaignCreationDraft({ world, userSettings: {} }), title: "A campaign" };

    expect(value.worldVersionId).toBe(world.worldVersionId);
    expect(value.selectedCharacterId).toBe(world.playableCharacters[0]!.id);
    expect(buildCampaignCreateRequest(value).worldVersionId).toBe(world.worldVersionId);
  });

  it("keeps the draft intact across repeated request builds", () => {
    const value = draft({ title: "Keep these values", turnControlStyle: "flexible_scene", startAfterCreate: false });
    const before = structuredClone(value);
    const firstRequest = buildCampaignCreateRequest(value);
    const secondRequest = buildCampaignCreateRequest(value);

    expect(value).toEqual(before);
    expect(secondRequest).toEqual(firstRequest);
    expect(firstRequest.turnControlStyle).toBe("flexible_scene");
  });

  it("excludes presentation-only draft values from the API payload", () => {
    const value = draft({ startAfterCreate: false });
    const request = buildCampaignCreateRequest(value);

    expect(request).toEqual({
      worldVersionId: world.worldVersionId,
      title: "My Campaign",
      selectedCharacterId: "00000000-0000-4000-8000-000000000003",
      storyLengthProfile: "standard",
      storyContextBudgetTokens: 32_000,
      turnControlStyle: "flexible_action"
    });
    expect(request).not.toHaveProperty("worldId");
    expect(request).not.toHaveProperty("startAfterCreate");
  });
});
