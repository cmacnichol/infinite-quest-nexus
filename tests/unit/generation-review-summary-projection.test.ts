import { describe, expect, test } from "vitest";
import { generationReviewSummaryProjection, projectBoundedGenerationReviewSummary } from "../../packages/database/src/generation-review-summary-projection.js";

describe("generation review hot-path SQL projection", () => {
  test("reads only summary and eligibility fields, never a candidate or other private payload", () => {
    const sql = generationReviewSummaryProjection("orchestration_private");

    expect(sql).toContain("generationReview,eligibility,complete");
    expect(sql).toContain("generationReview,gateCandidate,story");
    expect(sql).toContain("generationReview,reasons");
    expect(sql).toContain("jsonb_typeof");
    expect(sql).not.toMatch(/originalCandidate|workingCandidate|narration|choices|prompt|provider|journal|retryFailure|raw/i);
  });

  test("uses the shared Keep policy after extracting only bounded evidence", () => {
    const review = projectBoundedGenerationReviewSummary({
      version: 1, reviewId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", revision: 1, state: "pending",
      stage: "continuity", candidateScope: "final", reasons: ["narrative_conflict"],
      eligibility: { complete: true, structurallyValid: true, mechanicsClean: true, authorityValid: true, stageComplete: true, retryAvailable: true },
      candidatePresent: true
    }, "recoverable");
    expect(review).toMatchObject({ canKeep: true, canRetry: true });

    expect(projectBoundedGenerationReviewSummary({
      version: 1, reviewId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", revision: 1, state: "pending",
      stage: "continuity", candidateScope: "final", reasons: ["invalid_structure"],
      eligibility: { complete: true, structurallyValid: true, mechanicsClean: true, authorityValid: true, stageComplete: true, retryAvailable: true },
      candidatePresent: true
    }, "recoverable")).toMatchObject({ canKeep: false, canRetry: true });

    expect(projectBoundedGenerationReviewSummary({
      version: 1, reviewId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", revision: 1, state: "pending",
      stage: "continuity", candidateScope: "final", reasons: ["narrative_conflict"],
      eligibility: { complete: true, structurallyValid: true, mechanicsClean: true, authorityValid: true, stageComplete: true, retryAvailable: true },
      candidatePresent: false
    }, "recoverable")).toMatchObject({ canKeep: false, canRetry: true });
  });

  test("drops a private fixture canary instead of carrying it into a hot-path review", () => {
    const review = projectBoundedGenerationReviewSummary({
      version: 1, reviewId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", revision: 1, state: "pending",
      stage: "continuity", candidateScope: "final", reasons: ["narrative_conflict"],
      eligibility: { complete: true, structurallyValid: true, mechanicsClean: true, authorityValid: true, stageComplete: true, retryAvailable: true },
      candidatePresent: true,
      privateCandidateCanary: "candidate must never reach polling"
    }, "recoverable");
    expect(review).toBeUndefined();
  });
});
