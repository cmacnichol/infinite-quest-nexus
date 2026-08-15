import { describe, expect, it } from "vitest";
import {
  campaignRuntimeStateSchema,
  campaignRuntimeStateUpdateSchema
} from "../../packages/contracts/src/generation.js";

const fullState = {
  continuitySummary: "The lighthouse is open.",
  openThreads: ["Find the missing keeper."],
  canonicalFacts: [{ id: null, content: "The lens is made of moon glass." }],
  scratchpad: "The keeper is hiding below the western stair.",
  trackers: [{ id: "keeper-trust", name: "Keeper trust", value: "wary", rules: "Update after honest exchanges." }],
  rpgStats: [{ id: "resolve", name: "Resolve", value: 61, note: "Steady under pressure." }],
  eventTriggers: [{
    id: "lens-lit", label: "Lens lit", timing: "after", condition: "The lens is illuminated.",
    effect: "Reveal the sea road.", addTextAfter: true, triggeredCount: 0,
    lastTriggeredTurn: null, lastTriggeredAt: null
  }],
  pendingEventTriggers: [{
    id: "sea-road", sourceTriggerId: "lens-lit", name: "Sea road",
    timing: "after", condition: "", effect: "", instructions: "Reveal the road.",
    reason: "", sourceTurn: null
  }]
};

describe("complete campaign runtime state", () => {
  it("accepts every editable field in one update", () => {
    expect(campaignRuntimeStateUpdateSchema.parse({
      expectedTurnNumber: 4,
      expectedRevision: 7,
      effectiveTurnNumber: 2,
      ...fullState
    })).toMatchObject({ ...fullState, effectiveTurnNumber: 2 });
  });

  it("returns stable canonical fact IDs", () => {
    expect(campaignRuntimeStateSchema.parse({
      campaignId: "00000000-0000-4000-8000-000000000001",
      activeTurnNumber: 4,
      viewedTurnNumber: 4,
      isCurrent: true,
      revision: 7,
      updatedAt: new Date().toISOString(),
      ...fullState,
      canonicalFacts: [{
        id: "00000000-0000-4000-8000-000000000002",
        content: "The lens is made of moon glass."
      }]
    }).canonicalFacts[0]?.id).toBe("00000000-0000-4000-8000-000000000002");
  });

  it("rejects invalid nested mechanics and empty list entries", () => {
    expect(() => campaignRuntimeStateUpdateSchema.parse({
      expectedTurnNumber: 4,
      expectedRevision: 7,
      effectiveTurnNumber: 4,
      ...fullState,
      openThreads: [""],
      rpgStats: [{ id: "resolve", name: "Resolve", value: 100, note: "" }]
    })).toThrow();
  });
});
