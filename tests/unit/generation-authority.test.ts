import { describe, expect, it } from "vitest";
import { resolveGenerationAuthoritySnapshot } from "../../packages/database/src/generation-authority.js";

describe("resolveGenerationAuthoritySnapshot", () => {
  it("captures the corrected turn-zero base without derived-index timestamps", async () => {
    const responses = [
      { rows: [{ active_turn_number: 0, world_version_id: "world-version", revision: 4 }] },
      { rows: [{ state_snapshot_private: { scratchpad: "Lanterns are lit.", trackers: [] }, revision: 2 }] },
      { rows: [] }
    ];
    const client = {
      query: async () => responses.shift()!
    };

    const authority = await resolveGenerationAuthoritySnapshot(client as never, {
      ownerUserId: "owner",
      campaignId: "campaign",
      operationKind: "append",
      expectedTurnNumber: 1
    });

    expect(authority).toMatchObject({
      ownerUserId: "owner",
      campaignId: "campaign",
      worldVersionId: "world-version",
      baseIdentity: {
        operationKind: "append",
        expectedTurnNumber: 1,
        baseTurnNumber: 0,
        campaignActiveTurnNumber: 0,
        campaignStateRevision: 4,
        stateEditRevision: 2,
        narrationCorrectionRevision: null
      }
    });
    expect(authority.baseIdentity.stateFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(authority.baseIdentity.narrationFingerprint).toBeNull();
  });
});
