import { describe, expect, it } from "vitest";
import { projectCastProfile, validateCastFiction } from "../../packages/domain/src/campaign-cast.js";
import type { CastObservation, CastOverride } from "../../packages/contracts/src/campaign-cast.js";

const characterId = "11111111-1111-4111-8111-111111111111";
const uuid = (n: number) => `22222222-2222-4222-8222-${String(n).padStart(12, "0")}`;
function observation(n: number, value: string, changes: Partial<CastObservation> = {}): CastObservation {
  return { id: uuid(n), characterId, field: "appearance.description", value, mode: "fact", speakerCharacterId: null,
    evidence: { kind: "turn", turnId: uuid(n + 100), turnNumber: n, narrationRevision: 0, sourceHash: "a".repeat(64), paragraphId: "p1", quote: value },
    supersedesObservationId: null, ...changes };
}
const override = (value: string): CastOverride => ({ field: "appearance.description", value, evidence: { kind: "user", editId: uuid(1000), effectiveTurnNumber: 4 } });

describe("campaign cast projection", () => {
  it("does not turn claims into facts", () => {
    expect(projectCastProfile({ observations: [observation(1, "queen", { mode: "claim" })], overrides: [] })).toEqual({});
  });
  it("preserves a user blank over discovered appearance", () => {
    expect(projectCastProfile({ observations: [observation(1, "blue eyes")], overrides: [override("")] })).toEqual({ "appearance.description": "" });
  });
  it("leaves competing unsuperseded static values unresolved", () => {
    expect(projectCastProfile({ observations: [observation(1, "blue eyes"), observation(2, "brown eyes")], overrides: [] })).toEqual({});
  });
  it("applies explicit supersession independently of input order", () => {
    const first = observation(1, "blue eyes");
    const second = observation(2, "brown eyes", { supersedesObservationId: first.id });
    expect(projectCastProfile({ observations: [second, first], overrides: [] })).toEqual({ "appearance.description": "brown eyes" });
  });
  it("selects newer dynamic state and goals by source chronology", () => {
    const field = "state.location";
    expect(projectCastProfile({ observations: [observation(3, "harbor", { field }), observation(1, "forest", { field })], overrides: [] })).toEqual({ "state.location": "harbor" });
    expect(projectCastProfile({ observations: [observation(1, "leave", { field: "story.goals" }), observation(2, "stay", { field: "story.goals" })], overrides: [] })).toEqual({ "story.goals": "stay" });
  });
  it("uses narration revision then recorded input sequence for ties", () => {
    const first = observation(1, "forest", { field: "state.location" });
    const second = observation(2, "harbor", { field: "state.location", evidence: { ...first.evidence, kind: "turn", turnId: uuid(101), turnNumber: 1, narrationRevision: 1, sourceHash: "b".repeat(64), paragraphId: "p1", quote: "harbor" } });
    expect(projectCastProfile({ observations: [second, first], overrides: [] })).toEqual({ "state.location": "harbor" });
  });
  it("rejects missing, cross-character, cross-field, future, self and claim supersession", () => {
    const first = observation(1, "blue eyes");
    for (const prior of [[], [observation(1, "blue eyes", { characterId: uuid(40) })], [observation(1, "blue eyes", { field: "state.location" })]]) {
      expect(() => projectCastProfile({ observations: [...prior, observation(2, "brown eyes", { supersedesObservationId: first.id })], overrides: [] })).toThrow(/supersession/i);
    }
    expect(() => projectCastProfile({ observations: [first, observation(2, "brown eyes", { mode: "claim", supersedesObservationId: first.id })], overrides: [] })).toThrow(/supersession/i);
    expect(() => projectCastProfile({ observations: [observation(1, "blue eyes", { supersedesObservationId: uuid(1) })], overrides: [] })).toThrow(/supersession/i);
    expect(() => projectCastProfile({ observations: [observation(1, "blue eyes", { supersedesObservationId: uuid(2) }), observation(2, "brown eyes")], overrides: [] })).toThrow(/supersession/i);
  });
  it("rejects mechanics and private reasoning without silently sanitizing user content", () => {
    for (const value of ["Strength check DC 15", "Roll 1d20+4", "<think>secret reasoning</think>"]) {
      expect(() => validateCastFiction(value)).toThrow();
      expect(() => projectCastProfile({ observations: [], overrides: [override(value)] })).toThrow();
    }
    expect(validateCastFiction("She rolls the blanket and checks the door.")).toBe("She rolls the blanket and checks the door.");
  });
  it("rejects duplicate observation IDs instead of hiding corrupt evidence", () => {
    expect(() => projectCastProfile({ observations: [observation(1, "blue eyes"), observation(1, "brown eyes")], overrides: [] })).toThrow(/duplicate/i);
  });
  it("rejects mixed character inputs even when no supersession is requested", () => {
    expect(() => projectCastProfile({ observations: [observation(1, "blue eyes"), observation(2, "blue eyes", { characterId: uuid(50) })], overrides: [] })).toThrow(/character/i);
  });
  it("orders same-source supersession by recorded sequence", () => {
    const first = observation(1, "blue eyes");
    const correction = observation(2, "brown eyes", { evidence: first.evidence, supersedesObservationId: first.id });
    expect(projectCastProfile({ observations: [first, correction], overrides: [] })).toEqual({ "appearance.description": "brown eyes" });
    expect(() => projectCastProfile({ observations: [correction, first], overrides: [] })).toThrow(/supersession/i);
  });
});


it("projects attachment detach only at and after its boundary", async () => {
  const { projectCastAttachments, castRangesOverlap } = await import("../../packages/domain/src/campaign-cast-attachments.js");
  const range = { turnId: uuid(7), narrationRevision: 0, sourceHash: "a".repeat(64), paragraphId: "p1", start: 2, end: 6 };
  const attachment = { eventId: uuid(1), characterId, basis: "unique_name" as const, sourceRanges: [range], observationIds: [uuid(2)] };
  const other = { ...attachment, eventId: uuid(3), characterId: uuid(4), observationIds: [uuid(5)] };
  const events = [
    { id: uuid(1), effective_turn_number: 1, attachment, payload: [] },
    { id: uuid(3), effective_turn_number: 1, attachment: other, payload: [] },
    { id: uuid(6), effective_turn_number: 3, payload: [{ command: { kind: "detach" as const, characterId, eventId: uuid(1) } }] }
  ];
  expect(projectCastAttachments(events, 2).active).toHaveLength(2);
  const projected = projectCastAttachments(events, 3);
  expect(projected.active).toEqual([other]);
  expect([...projected.suppressedObservationIds]).toEqual([uuid(2)]);
  expect(castRangesOverlap(range, { ...range, start: 5, end: 8 })).toBe(true);
  expect(castRangesOverlap(range, { ...range, start: 6, end: 8 })).toBe(false);
  expect(projectCastProfile({ observations: [], overrides: [override("")] })).toEqual({ "appearance.description": "" });
});

it("projects seeded field authority and restored goals after supersession", async () => {
  const { resolveSeededCastProfile } = await import("../../packages/domain/src/campaign-cast.js");
  const { characterProfileSchema } = await import("../../packages/contracts/src/world-library.js");
  const profile = characterProfileSchema.parse({ story: { role: "Keeper", background: "x".repeat(3000), goals: "Old goal" } });
  const facts = [observation(1, "Rival", { field: "story.role" }), observation(2, "New goal", { field: "story.goals" }), observation(3, "blue coat")];
  const result = resolveSeededCastProfile({ profile, observations: facts, overrides: [override("")], restoreGoalsAfterTurn: 2 });
  expect(result.profile["story.role"]).toBe("Keeper");
  expect(result.profile["story.background"]).toHaveLength(3000);
  expect(result.profile["story.goals"]).toBe("Old goal");
  expect(result.profile["appearance.description"]).toBe("");
  expect(result.sources["story.role"]).toBe("authored");
  expect(resolveSeededCastProfile({ profile, observations: [...facts, observation(4, "Later", { field: "story.goals" })], overrides: [], restoreGoalsAfterTurn: 2 }).profile["story.goals"]).toBe("Later");
});

it("keeps editor and server seeded field policy aligned", async () => {
  const { seededCastFieldPolicy } = await import("../../packages/domain/src/campaign-cast.js");
  const { CHARACTER_FIELD_DESCRIPTORS, seededCharacterFieldPolicy } = await import("../../packages/client-core/src/characters/profile-fields.js");
  for (const path of [...CHARACTER_FIELD_DESCRIPTORS.map((field) => field.path), "appearance.description", "state.location", "unknown"]) {
    expect(seededCharacterFieldPolicy(path)).toBe(seededCastFieldPolicy(path));
  }
});

it("hides only populated seeded fixed detail candidates", async () => {
  const { isSeededFixedCandidateHidden } = await import("../../packages/domain/src/campaign-cast.js");
  const { characterProfileSchema } = await import("../../packages/contracts/src/world-library.js");
  const profile = characterProfileSchema.parse({ story: { role: "Keeper", personality: "" } });
  expect(isSeededFixedCandidateHidden(profile, "story.role")).toBe(true);
  expect(isSeededFixedCandidateHidden(profile, "story.personality")).toBe(false);
  expect(isSeededFixedCandidateHidden(profile, "story.goals")).toBe(false);
  expect(isSeededFixedCandidateHidden(profile, "appearance.description")).toBe(false);
});

it("applies restored goals cutoff after resolving supersession, including same-turn evidence", async () => {
  const { resolveSeededCastProfile } = await import("../../packages/domain/src/campaign-cast.js");
  const { characterProfileSchema } = await import("../../packages/contracts/src/world-library.js");
  const profile = characterProfileSchema.parse({ story: { goals: "Authored" } });
  const first = observation(1, "Past", { field: "story.goals" });
  const atRestore = observation(2, "At restore", { field: "story.goals", supersedesObservationId: first.id });
  expect(resolveSeededCastProfile({ profile, observations: [first, atRestore], overrides: [], restoreGoalsAfterTurn: 2 }).profile["story.goals"]).toBe("Authored");
  const later = observation(3, "Later", { field: "story.goals", supersedesObservationId: atRestore.id });
  expect(resolveSeededCastProfile({ profile, observations: [first, atRestore, later], overrides: [], restoreGoalsAfterTurn: 2 }).profile["story.goals"]).toBe("Later");
});

it("retracts contributions after validating the complete supersession graph", async () => {
  const { resolveSeededCastProfile } = await import("../../packages/domain/src/campaign-cast.js");
  const { characterProfileSchema } = await import("../../packages/contracts/src/world-library.js");
  const old = observation(1, "forest", { field: "state.location" });
  const newer = observation(2, "harbor", { field: "state.location" });
  const profile = characterProfileSchema.parse({ story: { goals: "Authored" } });
  const input = { observations: [old, newer], overrides: [], retractedObservationIds: new Set([newer.id]) };
  expect(projectCastProfile(input)["state.location"]).toBe("forest");
  expect(resolveSeededCastProfile({ ...input, profile }).profile["state.location"]).toBe("forest");
  const superseding = { ...newer, supersedesObservationId: old.id };
  expect(projectCastProfile({ ...input, observations: [old, superseding] })).toEqual({});
  expect(resolveSeededCastProfile({ ...input, observations: [old, superseding], profile }).profile["state.location"]).toBeUndefined();
  expect(() => projectCastProfile({ ...input, observations: [superseding] })).toThrow(/supersession/i);
});

it("removes static conflicts and preserves overrides and authored fallbacks", async () => {
  const { resolveSeededCastProfile } = await import("../../packages/domain/src/campaign-cast.js");
  const { characterProfileSchema } = await import("../../packages/contracts/src/world-library.js");
  const one = observation(1, "blue"), two = observation(2, "brown");
  const input = { observations: [one, two], overrides: [], retractedObservationIds: new Set([two.id]) };
  expect(projectCastProfile(input)["appearance.description"]).toBe("blue");
  expect(projectCastProfile({ ...input, retractedObservationIds: new Set() })).toEqual({});
  expect(projectCastProfile({ ...input, overrides: [override("green")] })["appearance.description"]).toBe("green");
  expect(projectCastProfile({ ...input, retractedObservationIds: new Set([one.id, two.id]) })).toEqual({});
  const goal = observation(3, "Observed", { field: "story.goals" });
  expect(resolveSeededCastProfile({ profile: characterProfileSchema.parse({ story: { goals: "Authored" } }), observations: [goal], overrides: [], retractedObservationIds: new Set([goal.id]) }).profile["story.goals"]).toBe("Authored");
});

it("retains each character's appearance policy across retraction and restoration", async () => {
  const { resolveSeededCastProfile } = await import("../../packages/domain/src/campaign-cast.js");
  const { characterProfileSchema } = await import("../../packages/contracts/src/world-library.js");
  const profile = characterProfileSchema.parse({ story: { role: "Keeper", goals: "Authored goal" } });
  const blue = observation(1, "blue eyes"), brown = observation(2, "brown eyes");
  const inputs = { observations: [blue, brown], overrides: [] };
  const retracted = { ...inputs, retractedObservationIds: new Set([brown.id]) };
  expect(projectCastProfile(inputs)["appearance.description"]).toBeUndefined();
  expect(projectCastProfile(retracted)["appearance.description"]).toBe("blue eyes");
  expect(projectCastProfile({ ...inputs, retractedObservationIds: new Set() })["appearance.description"]).toBeUndefined();
  expect(resolveSeededCastProfile({ ...inputs, profile }).profile["appearance.description"]).toBe("brown eyes");
  expect(resolveSeededCastProfile({ ...retracted, profile }).profile["appearance.description"]).toBe("blue eyes");
  expect(resolveSeededCastProfile({ ...inputs, profile, retractedObservationIds: new Set() }).profile["appearance.description"]).toBe("brown eyes");
  for (const retractedObservationIds of [new Set<string>(), new Set([brown.id])]) {
    const seeded = resolveSeededCastProfile({ ...inputs, profile, overrides: [override("green eyes")], retractedObservationIds });
    expect(seeded.profile).toMatchObject({ "appearance.description": "green eyes", "story.role": "Keeper", "story.goals": "Authored goal" });
    expect(projectCastProfile({ ...inputs, overrides: [override("green eyes")], retractedObservationIds })["appearance.description"]).toBe("green eyes");
  }
});
