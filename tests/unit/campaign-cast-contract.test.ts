import { describe, expect, it } from "vitest";
import { castBoundarySchema, castCharacterSchema, castEvidenceSchema, castObservationSchema, castProfileSchema, castScopeSchema } from "../../packages/contracts/src/campaign-cast.js";

const id = "11111111-1111-4111-8111-111111111111";
const evidence = { kind: "turn", turnId: id, turnNumber: 1, narrationRevision: 0, sourceHash: "a".repeat(64), paragraphId: "p1", quote: "Mara arrived." };

describe("campaign cast contracts", () => {
  it("accepts sparse profiles and preserves explicit blank overrides", () => {
    expect(castProfileSchema.parse({ "appearance.description": "" })).toEqual({ "appearance.description": "" });
    expect(castProfileSchema.parse({})).toEqual({});
  });
  it("rejects unsupported profile fields, extra authority, and malformed scope", () => {
    expect(castProfileSchema.safeParse({ "stats.strength": "20" }).success).toBe(false);
    expect(castScopeSchema.safeParse({ ownerUserId: id, campaignId: "foreign" }).success).toBe(false);
    expect(castBoundarySchema.safeParse({ turnNumber: -1, timelineRevision: 0 }).success).toBe(false);
    expect(castEvidenceSchema.safeParse({ ...evidence, ownerUserId: id }).success).toBe(false);
    expect(castEvidenceSchema.safeParse({ ...evidence, sourceHash: "unverified" }).success).toBe(false);
  });
  it("bounds character fields and requires explicit protagonist linkage", () => {
    const character = { id, name: "Mara", aliases: [], origin: { kind: "manual" }, profile: {}, pinned: false, ignored: false, revision: 0, firstObservedTurn: 0, lastObservedTurn: 0 };
    expect(castCharacterSchema.safeParse(character).success).toBe(true);
    expect(castCharacterSchema.safeParse({ ...character, name: "x".repeat(201) }).success).toBe(false);
    expect(castCharacterSchema.safeParse({ ...character, aliases: Array(21).fill("M") }).success).toBe(false);
    expect(castCharacterSchema.safeParse({ ...character, origin: { kind: "protagonist", selectedCharacterId: null } }).success).toBe(true);
    expect(castCharacterSchema.safeParse({ ...character, origin: { kind: "protagonist" } }).success).toBe(false);
    expect(castProfileSchema.safeParse({ "story.role": "x".repeat(2001) }).success).toBe(false);
    expect(castCharacterSchema.safeParse({ ...character, firstObservedTurn: 2, lastObservedTurn: 1 }).success).toBe(false);
  });
  it("requires claims to retain their mode and validates observation evidence", () => {
    const observation = { id, characterId: id, field: "story.role", value: "queen", mode: "claim", speakerCharacterId: null, evidence, supersedesObservationId: null };
    expect(castObservationSchema.parse(observation).mode).toBe("claim");
    expect(castObservationSchema.safeParse({ ...observation, mode: "inferred" }).success).toBe(false);
    expect(castObservationSchema.safeParse({ ...observation, evidence: { ...evidence, quote: "" } }).success).toBe(false);
  });
});
