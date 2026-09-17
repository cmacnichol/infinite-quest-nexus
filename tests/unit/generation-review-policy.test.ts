import { describe, expect, it } from "vitest";
import { canKeepGenerationCandidate, type GenerationReviewEligibility } from "../../packages/application/src/generation/review-policy.js";

const base = {
  complete: true,
  structurallyValid: true,
  mechanicsClean: true,
  authorityValid: true,
  candidateScope: "final" as const,
  stageComplete: true,
  reasons: ["review_unavailable"] as const
};

describe("generation review keep policy", () => {
  it.each([
    ["eligible soft review finding", base, true],
    ["missing completed output", { ...base, complete: false }, false],
    ["malformed output", { ...base, structurallyValid: false }, false],
    ["mechanics contamination", { ...base, mechanicsClean: false }, false],
    ["stale authority", { ...base, authorityValid: false }, false],
    ["incomplete scoped stage", { ...base, stageComplete: false }, false],
    ["no review reason", { ...base, reasons: [] }, false],
    ["hard structure finding", { ...base, reasons: ["invalid_structure"] }, false],
    ["mixed soft and hard findings", { ...base, reasons: ["review_uncertain", "candidate_stale"] }, false],
    ["eligible main candidate", { ...base, candidateScope: "main" as const, reasons: ["scene_beats_missing"] }, true]
  ])("%s", (_name, input, expected) => {
    expect(canKeepGenerationCandidate(input as GenerationReviewEligibility)).toBe(expected);
  });
});
