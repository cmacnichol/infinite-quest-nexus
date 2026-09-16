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

  it("captures a versioned effective character profile identity for a policy attempt", async () => {
    const responses = [
      { rows: [{ active_turn_number: 1, world_version_id: "world-version", revision: 4, selected_character_id: "hero", character_profile: { name: "Mira", profile: { story: { role: "Cartographer" } } }, character_profile_revision: 2, character_snapshot: { name: "Mira", characterText: "Legacy guidance." } }] },
      { rows: [] },
      { rows: [{ id: "turn", effective_narration: "Mira maps the stars.", correction_revision: 1 }] }
    ];
    const client = { query: async () => responses.shift()! };

    const authority = await resolveGenerationAuthoritySnapshot(client as never, {
      ownerUserId: "owner",
      campaignId: "campaign",
      operationKind: "append",
      expectedTurnNumber: 2,
      baseIdentityVersion: "generation-base-v3"
    });

    expect(authority.baseIdentity).toMatchObject({
      version: "generation-base-v3",
      characterProfileRevision: 2,
      characterProfileFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/)
    });
  });

  it("uses the origin snapshot and legacy guidance only when no campaign profile is stored", async () => {
    const snapshot = { name: "Mira", characterText: "A patient star cartographer.", profile: { story: { role: "Cartographer" } } };
    const resolve = async (characterProfile: unknown) => {
      const responses = [
        { rows: [{ active_turn_number: 0, world_version_id: "world-version", revision: 4, selected_character_id: "hero", character_profile: characterProfile, character_profile_revision: 0, character_snapshot: snapshot }] },
        { rows: [] },
        { rows: [] }
      ];
      return resolveGenerationAuthoritySnapshot({ query: async () => responses.shift()! } as never, {
        ownerUserId: "owner", campaignId: "campaign", operationKind: "append", expectedTurnNumber: 1,
        baseIdentityVersion: "generation-base-v3"
      });
    };

    const inherited = await resolve(null);
    const legacyOnly = await resolve({ name: "Mira", profile: {} });
    expect(inherited.baseIdentity).toMatchObject({ version: "generation-base-v3" });
    if (!("characterProfileFingerprint" in inherited.baseIdentity)
      || !("characterProfileFingerprint" in legacyOnly.baseIdentity)) {
      throw new Error("Expected versioned character authority identities.");
    }
    expect(inherited.baseIdentity.characterProfileFingerprint).not.toBe(legacyOnly.baseIdentity.characterProfileFingerprint);
  });
});
