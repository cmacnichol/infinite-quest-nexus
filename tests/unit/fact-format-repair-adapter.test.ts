import { describe, expect, it } from "vitest";
import { visibleFactsFromProducingRequest } from "../../services/runtime/src/fact-format-repair-adapter.js";

describe("fact format repair request evidence", () => {
  it("distinguishes a proven empty frozen inventory from absent authority", () => {
    const empty = JSON.stringify({
      authoritative_context: { currentContinuity: { canonicalFacts: [] }, chronicle: [] }
    });
    expect(visibleFactsFromProducingRequest(empty)).toEqual([]);
    expect(visibleFactsFromProducingRequest(JSON.stringify({ authoritative_context: {} }))).toBeNull();
  });

  it("rejects conflicting frozen current and Chronicle fact content", () => {
    const request = JSON.stringify({ authoritative_context: {
      currentContinuity: { canonicalFacts: [{ id: "11111111-1111-4111-8111-111111111111", content: "Lantern lit." }] },
      chronicle: [{ kind: "canonical_fact", id: "11111111-1111-4111-8111-111111111111", content: "Lantern dark." }]
    } });
    expect(visibleFactsFromProducingRequest(request)).toBeNull();
  });
});
