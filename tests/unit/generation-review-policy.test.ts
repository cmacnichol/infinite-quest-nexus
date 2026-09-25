import { describe, expect, it } from "vitest";
import { canKeepGenerationCandidate, type GenerationReviewEligibility } from "../../packages/application/src/generation/review-policy.js";

const base = {
  complete: true,
  structurallyValid: true,
  mechanicsClean: true,
  authorityValid: true,
  stage: "continuity" as const,
  candidateScope: "final" as const,
  stageComplete: true,
  reasons: ["review_unavailable"] as const
};

describe("generation review keep policy", () => {
  it.each([
    ["eligible soft review finding", base, true],
    ["validated interrupted final candidate", { ...base, reasons: ["provider_interrupted"] }, true],
    ["interrupted main cannot bypass remaining validation", { ...base, stage: "scene_coverage", candidateScope: "main", reasons: ["provider_interrupted"] }, false],
    ["missing completed output", { ...base, complete: false }, false],
    ["malformed output", { ...base, structurallyValid: false }, false],
    ["mechanics contamination", { ...base, mechanicsClean: false }, false],
    ["stale authority", { ...base, authorityValid: false }, false],
    ["incomplete scoped stage", { ...base, stageComplete: false }, false],
    ["no review reason", { ...base, reasons: [] }, false],
    ["hard structure finding", { ...base, reasons: ["invalid_structure"] }, false],
    ["mixed soft and hard findings", { ...base, reasons: ["review_uncertain", "candidate_stale"] }, false],
    ["eligible scene coverage main candidate", { ...base, stage: "scene_coverage" as const, candidateScope: "main" as const, reasons: ["scene_beats_missing"] }, true],
    ["continuity cannot keep a main candidate", { ...base, candidateScope: "main" as const }, false],
    ["scene coverage cannot keep a final candidate", { ...base, stage: "scene_coverage" as const }, false],
    ["hard structure stage cannot keep spoofed soft findings", { ...base, stage: "structure" as const }, false]
  ])("%s", (_name, input, expected) => {
    expect(canKeepGenerationCandidate(input as GenerationReviewEligibility)).toBe(expected);
  });
});
