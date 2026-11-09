import { describe, expect, it } from "vitest";
import { castAuthoredValuesSchema, castBoundarySchema, castCharacterSchema, castEvidenceSchema, castObservationSchema, castProfileSchema, castScopeSchema, castCommandSchema, castDetailProfileSchema, castOverrideProfileSchema, portableCampaignCastSchema } from "../../packages/contracts/src/campaign-cast.js";

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


it("keeps full detail and goal overrides separate from observation limits", () => {
  expect(castDetailProfileSchema.safeParse({ "story.background": "x".repeat(3000), "story.goals": "g".repeat(20000) }).success).toBe(true);
  expect(castDetailProfileSchema.safeParse({ "state.location": "x".repeat(2001) }).success).toBe(false);
  expect(castOverrideProfileSchema.safeParse({ "story.goals": "x".repeat(20000) }).success).toBe(true);
  expect(castOverrideProfileSchema.safeParse({ "story.role": "x".repeat(2001) }).success).toBe(false);
  expect(castCommandSchema.safeParse({ kind: "edit_authored_profile", characterId: id, seedEventId: id, set: { "identity.aliases": ["alias"] }, reset: [] }).success).toBe(false);
});

it("validates authored edits as one non-overlapping atomic request", async () => {
  const { editAuthoredCastProfileSchema } = await import("../../packages/contracts/src/campaign-cast-authored.js");
  const base = { expectedCastRevision: 1, expectedCharacterRevision: 1, expectedBoundary: { turnNumber: 1, timelineRevision: 0 }, idempotencyKey: "edit" };
  expect(editAuthoredCastProfileSchema.safeParse({ ...base, set: { "story.background": "x".repeat(3000) }, setOverrides: { "story.goals": "y".repeat(20000) } }).success).toBe(true);
  expect(editAuthoredCastProfileSchema.safeParse({ ...base, set: { "story.role": "one" }, reset: ["story.role"] }).success).toBe(false);
  expect(editAuthoredCastProfileSchema.safeParse({ ...base, resetIdentity: true, name: "Mara" }).success).toBe(false);
  expect(editAuthoredCastProfileSchema.safeParse({ ...base }).success).toBe(false);
});

it("rejects a second active seed for the same character", () => {
  const seedId = "22222222-2222-4222-8222-222222222222", laterId = "33333333-3333-4333-8333-333333333333";
  const world = "44444444-4444-4444-8444-444444444444", origin = { kind: "manual" };
  const seed = { kind: "seed_profile", characterId: id, worldVersionId: world, entityId: "mara", rosterName: "Mara", rosterAliases: [],
    legacyCharacterText: "", profile: {}, evidence: { kind: "world", worldVersionId: world, sourcePath: "/playableCharacters/0" } };
  const payload = { formatVersion: 3, revision: 2, characters: [{ id, origin, firstObservedTurn: 0 }], events: [
    { id: seedId, effectiveTurnNumber: 0, revision: 1, commands: [{ characterId: id, command: { kind: "create", name: "Mara", aliases: [], origin } }, { command: seed }] },
    { id: laterId, effectiveTurnNumber: 0, revision: 2, commands: [{ command: seed }] }
  ] };
  expect(portableCampaignCastSchema.safeParse(payload).success).toBe(false);
});

it("rejects authored text that cannot be represented in stored JSON", () => {
  expect(castAuthoredValuesSchema.safeParse({ "story.role": "A\u0000B" }).success).toBe(false);
  expect(castAuthoredValuesSchema.safeParse({ "story.role": "\ud800" }).success).toBe(false);
  expect(castAuthoredValuesSchema.safeParse({ "story.role": "Keeper 🌙" }).success).toBe(true);
});

it("accepts ordered v4 lifecycle events and rejects earlier format or stale undo", () => {
  const a = "11111111-1111-4111-8111-111111111111", b = "22222222-2222-4222-8222-222222222222";
  const ids = ["33333333-3333-4333-8333-333333333333", "44444444-4444-4444-8444-444444444444", "55555555-5555-4555-8555-555555555555", "66666666-6666-4666-8666-666666666666"];
  const origin = { kind: "manual" };
  const payload = { formatVersion: 4, revision: 4, characters: [a,b].map(id => ({ id, origin, firstObservedTurn: 0 })), events: [
    ...[a,b].map((characterId,i) => ({ id: ids[i], effectiveTurnNumber: 0, revision: i+1, commands: [{ characterId, command: { kind:"create", name: "Mara", aliases: [], origin } }] })),
    { id: ids[2], effectiveTurnNumber: 0, revision: 3, commands: [{ command: { kind: "merge", characterId:a, sourceCharacterId:b, reviewedAliases: [], choices: {}, aliasChanges: { priorTargetAliases: [], added: [], removed: [] } } }, { command: { kind: "identity", characterId: a, name: "Mara", aliases: [] } }] },
    { id: ids[3], effectiveTurnNumber: 0, revision: 4, commands: [{ command: { kind: "unmerge", characterId:a, mergeEventId:ids[2] } }] }
  ] };
  expect(portableCampaignCastSchema.safeParse(payload).success).toBe(true);
  expect(portableCampaignCastSchema.safeParse({ ...payload, formatVersion: 3 }).success).toBe(false);
  expect(portableCampaignCastSchema.safeParse({ ...payload, events: [...payload.events.slice(0,3), { ...payload.events[3], commands: [{ command: { kind: "unmerge", characterId:b, mergeEventId:ids[2] } }] }] }).success).toBe(false);
  expect(portableCampaignCastSchema.safeParse({ ...payload, events: [...payload.events.slice(0,3), { ...payload.events[3], commands: [{ command: { kind: "remove", characterId:b } }] }] }).success).toBe(false);
  const mixed = { ...payload.events[2], commands: [...payload.events[2]!.commands, { command: { kind: "identity", characterId: b, name: "Other", aliases: [] } }] };
  expect(portableCampaignCastSchema.safeParse({ ...payload, events: [...payload.events.slice(0,2), mixed, payload.events[3]] }).success).toBe(false);
  const identityId = "77777777-7777-4777-8777-777777777777";
  const edited = { ...payload, revision: 5, events: [...payload.events.slice(0,3),
    { id: identityId, effectiveTurnNumber: 0, revision: 4, commands: [{ command: { kind: "identity", characterId: a, name: "Mara", aliases: ["M"], aliasChanges: { added: ["M"], removed: [] } } }] },
    { ...payload.events[3], revision: 5 }] };
  expect(portableCampaignCastSchema.safeParse(edited).success).toBe(true);
  const tampered = { ...edited, events: [...edited.events.slice(0, 3), { ...edited.events[3]!, commands: [{ command: { kind: "identity", characterId: a, name: "Mara", aliases: ["M"], aliasChanges: { added: [], removed: [] } } }] }, edited.events[4]!] };
  expect(portableCampaignCastSchema.safeParse(tampered).success).toBe(false);
  const afterUndo = { ...edited, revision: 6, events: [...edited.events,
    { id: "88888888-8888-4888-8888-888888888888", effectiveTurnNumber: 0, revision: 6, commands: [
      { command: { kind: "merge", characterId: a, sourceCharacterId: b, reviewedAliases: ["M"], choices: {}, aliasChanges: { priorTargetAliases: ["M"], added: [], removed: [] } } },
      { command: { kind: "identity", characterId: a, name: "Mara", aliases: ["M"] } }
    ] }] };
  expect(portableCampaignCastSchema.safeParse(afterUndo).success).toBe(true);
  const invalidPrior = { ...afterUndo, events: [...afterUndo.events.slice(0, -1), {
    id: "88888888-8888-4888-8888-888888888888", effectiveTurnNumber: 0, revision: 6, commands: [
      { command: { kind: "merge", characterId: a, sourceCharacterId: b, reviewedAliases: ["M"], choices: {}, aliasChanges: { priorTargetAliases: [], added: [], removed: [] } } },
      { command: { kind: "identity", characterId: a, name: "Mara", aliases: ["M"] } }
    ] }] };
  expect(portableCampaignCastSchema.safeParse(invalidPrior).success).toBe(false);
});

it("allows undoing the latest merge while an earlier merge into the same target remains active", () => {
  const people = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333"];
  const ids = ["44444444-4444-4444-8444-444444444444", "55555555-5555-4555-8555-555555555555", "66666666-6666-4666-8666-666666666666", "77777777-7777-4777-8777-777777777777", "88888888-8888-4888-8888-888888888888", "99999999-9999-4999-8999-999999999999"];
  const origin = { kind: "manual" };
  const merge = (sourceCharacterId: string) => ({ kind: "merge", characterId: people[0], sourceCharacterId, reviewedAliases: [], choices: {}, aliasChanges: { priorTargetAliases: [], added: [], removed: [] } });
  const events = people.map((characterId, i) => ({ id: ids[i], effectiveTurnNumber: 0, revision: i + 1, commands: [{ characterId, command: { kind: "create", name: "Mara", aliases: [], origin } }] }));
  const payload = { formatVersion: 4, revision: 6, characters: people.map(id => ({ id, origin, firstObservedTurn: 0 })), events: [
    ...events,
    { id: ids[3], effectiveTurnNumber: 0, revision: 4, commands: [{ command: merge(people[1]!) }, { command: { kind: "identity", characterId: people[0], name: "Mara", aliases: [] } }] },
    { id: ids[4], effectiveTurnNumber: 0, revision: 5, commands: [{ command: merge(people[2]!) }, { command: { kind: "identity", characterId: people[0], name: "Mara", aliases: [] } }] },
    { id: ids[5], effectiveTurnNumber: 0, revision: 6, commands: [{ command: { kind: "unmerge", characterId: people[0], mergeEventId: ids[4] } }] }
  ] };
  expect(portableCampaignCastSchema.safeParse(payload).success).toBe(true);
});
