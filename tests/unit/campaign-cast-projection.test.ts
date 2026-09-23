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
