import { describe, expect, it } from "vitest";
import { applyAuthorizedFactFormatRepair, prepareFactFormatRepair, visibleFactsFromProducingRequest } from "../../services/runtime/src/fact-format-repair-adapter.js";
import { sha256 } from "../../packages/domain/src/text.js";
import { rawSyntheticStory } from "../fixtures/generation-validation/fact-format-cases.js";

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

  it("uses the authorized current receipt instead of an older repair receipt", () => {
    const requestBody = JSON.stringify({ authoritative_context: { currentContinuity: { canonicalFacts: [] }, chronicle: [] } });
    const rawOutput = rawSyntheticStory({ canonical_facts: [{ id: "new-label", content: "The beacon is lit." }] });
    const oldRawOutput = rawSyntheticStory({ canonical_facts: [{ id: "old-label", content: "The gate is open." }] });
    const current = prepareFactFormatRepair(rawOutput, requestBody);
    const older = prepareFactFormatRepair(oldRawOutput, requestBody);
    expect(current).not.toBeNull();
    expect(older).not.toBeNull();
    if (!current || !older) throw new Error("Expected eligible repair plans.");
    const source = {
      rawOutputReference: "provider-current", producingRequestHash: sha256(requestBody), sourceResponseId: "response-current"
    };
    const checkpoint = {
      version: 2, reviewId: "22222222-2222-4222-8222-222222222222", revision: 5,
      factFormatRepair: { ...source, ...current, status: "authorized" },
      decisionJournal: [
        {
          decision: "repair_format", reviewId: "11111111-1111-4111-8111-111111111111", revision: 1,
          planHash: older.planHash, repair: { rawOutputReference: "provider-old", producingRequestHash: "b".repeat(64), sourceResponseId: "response-old" }
        },
        {
          decision: "repair_format", reviewId: "22222222-2222-4222-8222-222222222222", revision: 4,
          planHash: current.planHash, repair: source
        }
      ]
    };
    expect(applyAuthorizedFactFormatRepair({
      checkpoint: checkpoint as never, rawOutput, requestBody
    })).toEqual(current.plan);
  });
});
