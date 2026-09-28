import { describe, expect, it } from "vitest";
import { resolveGenerationAuthoritySnapshot } from "../../packages/database/src/generation-authority.js";

describe("resolveGenerationAuthoritySnapshot", () => {
  it.each([
    { name: "legacy omitted-field two-turn", operationKind: "append" as const, active: 5, expected: 6, window: undefined, rows: [
      { turn_id: "turn-3", turn_number: 3, action: "three", input_mode: "action", effective_narration: "three narration", correction_revision: 0 },
      { turn_id: "turn-4", turn_number: 4, action: "four", input_mode: "scene", effective_narration: "four narration", correction_revision: 0 }
    ], expectedBase: 5, expectedTurns: [3, 4] },
    { name: "empty early v5", operationKind: "append" as const, active: 0, expected: 1, window: 11 as const, rows: [], expectedBase: 0, expectedTurns: [] },
    { name: "contiguous v5 eleven", operationKind: "append" as const, active: 14, expected: 15, window: 11 as const,
      rows: Array.from({ length: 11 }, (_, index) => ({ turn_id: `turn-${index + 3}`, turn_number: index + 3, action: `action ${index + 3}`, input_mode: "action", effective_narration: `narration ${index + 3}`, correction_revision: 0 })), expectedBase: 14,
      expectedTurns: Array.from({ length: 11 }, (_, index) => index + 3) },
    { name: "v5 interior gap keeps newest suffix", operationKind: "append" as const, active: 14, expected: 15, window: 11 as const,
      rows: [3, 4, 5, 6, 7, 9, 10, 11, 12, 13].map((turnNumber) => ({ turn_id: `turn-${turnNumber}`, turn_number: turnNumber, action: `action ${turnNumber}`, input_mode: "action", effective_narration: `narration ${turnNumber}`, correction_revision: 0 })), expectedBase: 14, expectedTurns: [9, 10, 11, 12, 13] },
    { name: "replacement stops before N minus one base", operationKind: "replace_latest" as const, active: 14, expected: 14, window: 11 as const,
      rows: Array.from({ length: 11 }, (_, index) => ({ turn_id: `turn-${index + 2}`, turn_number: index + 2, action: `action ${index + 2}`, input_mode: "action", effective_narration: `narration ${index + 2}`, correction_revision: 0 })), expectedBase: 13,
      expectedTurns: Array.from({ length: 11 }, (_, index) => index + 2) }
  ])("uses the frozen recent-window matrix for $name", async ({ operationKind, active, expected, window, rows, expectedBase, expectedTurns }) => {
    const responses = [
      { rows: [{ active_turn_number: active, world_version_id: "world-version", revision: 4, selected_character_id: null, character_profile: null, character_profile_revision: 0, character_snapshot: null }] },
      { rows: [] },
      ...(expectedBase === 0 ? [] : [{ rows: [{ id: `turn-${expectedBase}`, effective_narration: `narration ${expectedBase}`, correction_revision: 0 }] }]),
      { rows }
    ];
    const calls: unknown[][] = [];
    const authority = await resolveGenerationAuthoritySnapshot({ query: async (_sql: string, parameters?: unknown[]) => {
      calls.push(parameters ?? []); return responses.shift()!;
    } } as never, {
      ownerUserId: "owner", campaignId: "campaign", operationKind, expectedTurnNumber: expected,
      baseIdentityVersion: "generation-base-v3", captureRecentWindow: true,
      ...(window === undefined ? {} : { recentWindowTurns: window })
    });
    expect(authority.baseIdentity).toMatchObject({ baseTurnNumber: expectedBase, ...(window === undefined ? {} : { recentWindowTurns: 11, recentWindowFingerprint: expect.any(String) }) });
    if (window === undefined) expect(authority.baseIdentity).not.toHaveProperty("recentWindowTurns");
    expect(authority.recentTurns?.map((turn) => turn.turnNumber) ?? []).toEqual(expectedTurns);
    const recentParameters = calls.at(-1)!;
    expect(recentParameters.at(-1)).toBe(expectedBase);
  });

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
