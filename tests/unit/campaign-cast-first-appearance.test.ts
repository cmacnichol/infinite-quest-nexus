import { describe, expect, it } from "vitest";
import { firstAppearanceDecision } from "../../packages/domain/src/campaign-cast-first-appearance.js";

describe("first appearance permission", () => {
  const input = { firstAppearanceEligible: true, frozenPermission: true, livePermission: true,
    pinnedWorldId: "world", sourceWorldId: "world", selectedCharacterId: "hero", selectedCharacterWorldId: "world", rosterCharacterId: "guide",
    campaignUse: "supporting" as const, identityStillSupported: true, unique: true, detached: false };
  it("requires both permissions and the campaign's persisted eligibility", () => {
    expect(firstAppearanceDecision(input)).toBe("seed");
    for (const key of ["firstAppearanceEligible", "frozenPermission", "livePermission"] as const) {
      expect(firstAppearanceDecision({ ...input, [key]: false })).toBe("plain");
    }
  });
  it("scopes the selected identity to its source world and conservatively handles unknown history", () => {
    expect(firstAppearanceDecision({ ...input, rosterCharacterId: "hero", selectedCharacterWorldId: "other" })).toBe("seed");
    expect(firstAppearanceDecision({ ...input, rosterCharacterId: "hero", selectedCharacterWorldId: null })).toBe("protagonist");
    expect(firstAppearanceDecision({ ...input, rosterCharacterId: "hero", selectedCharacterWorldId: "world" })).toBe("protagonist");
  });
  it("protects the protagonist and holds changed or ambiguous identities", () => {
    expect(firstAppearanceDecision({ ...input, rosterCharacterId: "hero" })).toBe("protagonist");
    for (const change of [{ identityStillSupported: false }, { unique: false }, { detached: true }, { sourceWorldId: "other" }]) {
      expect(firstAppearanceDecision({ ...input, ...change })).toBe("review");
    }
    expect(firstAppearanceDecision({ ...input, campaignUse: "playable" })).toBe("plain");
  });
});
