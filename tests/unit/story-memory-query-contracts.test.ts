import { describe, expect, it } from "vitest";
import * as policy from "../../packages/contracts/src/story-memory-policy.js";
import { planChronicleQueries } from "../../packages/domain/src/chronicle-query-plan.js";

describe("versioned Chronicle query identity", () => {
  it("reads the actual frozen historical four-kind wire shape", () => {
    for (const kind of ["action", "entity_expanded", "scene", "open_thread"]) {
      const value = { kind, query: "Quay", entityIds: [] };
      expect(policy.readStoryMemoryQueryVariant(JSON.parse(JSON.stringify(value)))).toEqual({ kind: "legacy", variant: value, rankAggregation: "legacy_sum" });
    }
    const existing = planChronicleQueries({ action: "Visit the quay." });
    expect(existing).toEqual([{ kind: "action", query: "Visit the quay.", entityIds: [] }]);
  });
  it("gives repeated action segments separate identities in one ranking family", () => {
    const first = policy.createStoryMemoryQueryVariant({ kind: "action", query: "Wait.", entityIds: [], actionSegment: { index: 0, start: 0, end: 5 }, temporalHint: null });
    const second = policy.createStoryMemoryQueryVariant({ kind: "action", query: "Wait.", entityIds: [], actionSegment: { index: 1, start: 6, end: 11 }, temporalHint: null });
    expect(first.variantId).not.toBe(second.variantId);
    expect(first.familyId).toBe(second.familyId);
    expect(policy.readStoryMemoryQueryVariant(JSON.parse(policy.serializeStoryMemoryQueryVariant(first)))).toEqual({ kind: "v1", variant: first, rankAggregation: "query_family_max_v1" });
    expect(policy.createStoryMemoryQueryVariant({ query: "Wait.", kind: "action", temporalHint: null, actionSegment: { end: 5, start: 0, index: 0 }, entityIds: [] })).toEqual(first);
    for (const value of [{ ...first, variantId: "tampered" }, { ...first, kind: "unknown" }, { ...first, version: "v99" }, { ...first, actionSegment: null }, { ...first, actionSegment: { index: 0, start: 5, end: 3 } }]) expect(() => policy.readStoryMemoryQueryVariant(value)).toThrow();
  });
  it("preserves optional temporal hints in cache and diagnostic serialization", () => {
    const variant = policy.createStoryMemoryQueryVariant({ kind: "temporal_hint", query: "Before the storm.", entityIds: [], actionSegment: null, temporalHint: { throughTurnNumber: 12, label: "Before the storm" } });
    expect(JSON.parse(policy.serializeStoryMemoryQueryVariant(variant))).toEqual(variant);
    expect(() => policy.readStoryMemoryQueryVariant({ kind: "narration", text: "not the historical schema" })).toThrow();
    expect(() => policy.createStoryMemoryQueryVariant({ kind: "temporal_hint", query: "Before the storm.", entityIds: [], actionSegment: null, temporalHint: null })).toThrow();
  });
});
