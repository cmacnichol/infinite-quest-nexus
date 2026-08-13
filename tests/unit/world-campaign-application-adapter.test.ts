import { describe, expect, it } from "vitest";
import type { WorldCampaignApplication } from "../../packages/application/src/world-campaign/index.js";
import {
  createOwnerBoundPortableWorldApplicationPort,
  createWorldCampaignApplicationAdapter
} from "../../services/api/src/world-campaign-application-adapter.js";

describe("owner-bound portable world application", () => {
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
