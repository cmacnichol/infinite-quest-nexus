import { describe, expect, it } from "vitest";
import type { WorldCampaignApplication } from "../../packages/application/src/world-campaign/index.js";
import { WorldCampaignApplicationError } from "../../packages/application/src/world-campaign/index.js";
import {
  createOwnerBoundPortableWorldApplicationPort,
  createWorldCampaignApplicationAdapter,
  mapWorldCampaignApplicationError
} from "../../services/api/src/world-campaign-application-adapter.js";

describe("owner-bound portable world application", () => {
  it("maps style fences and unresolved generation to observable API failures", () => {
    const cases = [
      ["turn_control_style_fence_required", "invalid_request", 400, "Reload the campaign before changing Story Direction."],
      ["turn_control_style_changed", "stale_state", 409, "The campaign setting changed. Reload it before saving."],
      ["generation_in_progress", "conflict", 409, "Wait for the current generation to finish before changing Story Direction."]
    ] as const;
    for (const [reason, kind, statusCode, message] of cases) {
      const error = mapWorldCampaignApplicationError(new WorldCampaignApplicationError(
        kind,
        reason,
        { campaignId: "00000000-0000-4000-8000-000000000001" }
      ));
      expect(error).toMatchObject({ statusCode, message, details: { code: reason } });
    }
  });
  it("shows bounded campaign readiness guidance without exposing authored text", () => {
    const error = mapWorldCampaignApplicationError(new WorldCampaignApplicationError(
      "invalid_request", "invalid_transition", {
        issues: [{ code: "invalid-event-rule", message: "Event rule 1 needs a valid condition.", eventIndex: 0, field: "condition" }]
      }
    ));
    expect(error.statusCode).toBe(400);
    expect(error.message).toBe("Event rule 1 needs a valid condition.");
    expect(JSON.stringify(error)).not.toContain("PRIVATE_WORLD_CONTENT");
  });
  it("exports a whole world or exact world version without accepting caller authority", async () => {
    const ownerUserId = crypto.randomUUID();
    const worldId = crypto.randomUUID();
    const worldVersionId = crypto.randomUUID();
    const scopes: unknown[] = [];
    const payload = {
      format: "infinite-quest-world" as const,
      formatVersion: 1 as const,
      title: "Portable World",
      content: {
        world: { title: "Portable World" },
        playableCharacters: [],
        eventTriggers: [],
        defaults: { trackers: [] }
      }
    };
    const application = {
      async exportWorld(scope: unknown) {
        scopes.push(scope);
        return payload;
      }
    } as unknown as WorldCampaignApplication;
    const portableWorld = createOwnerBoundPortableWorldApplicationPort(
      createWorldCampaignApplicationAdapter(application),
      async () => Object.freeze({ ownerUserId })
    );

    await expect(portableWorld.exportWorld({ worldId })).resolves.toEqual(payload);
    await expect(portableWorld.exportWorld({ worldId, worldVersionId })).resolves.toEqual(payload);
    expect(scopes).toEqual([
      { ownerUserId, worldId },
      { ownerUserId, worldId, worldVersionId }
    ]);
  });
});
