import { describe, expect, it } from "vitest";
import { castBoundarySchema, castCharacterSchema, castEvidenceSchema, castObservationSchema, castProfileSchema, castScopeSchema, portableCampaignCastSchema } from "../../packages/contracts/src/campaign-cast.js";

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


it("rejects v2 attachments that claim another character's observation", () => {
  const a = "11111111-1111-4111-8111-111111111111", b = "22222222-2222-4222-8222-222222222222";
  const event = "33333333-3333-4333-8333-333333333333", obs = "44444444-4444-4444-8444-444444444444";
  const origin = { kind: "manual" };
  const payload = { formatVersion: 2, revision: 3, characters: [a, b].map((id) => ({ id, origin, firstObservedTurn: 0 })), events: [
    ...[a, b].map((characterId, i) => ({ id: i ? "66666666-6666-4666-8666-666666666666" : "55555555-5555-4555-8555-555555555555", effectiveTurnNumber: 0, revision: i + 1,
      commands: [{ characterId, command: { kind: "create", name: "Mara", aliases: [], origin } }] })),
    { id: event, effectiveTurnNumber: 1, revision: 3, commands: [{ observationId: obs, command: { kind: "observe", characterId: b,
      field: "story.role", value: "guide", mode: "fact", speakerCharacterId: null, evidence, supersedesObservationId: null } }],
      attachment: { eventId: event, characterId: a, basis: "unique_name", sourceRanges: [{ turnId: id, narrationRevision: 0,
        sourceHash: "a".repeat(64), paragraphId: "p1", start: 0, end: 4 }], observationIds: [obs] } }
  ] };
  expect(portableCampaignCastSchema.safeParse(payload).success).toBe(false);
});
