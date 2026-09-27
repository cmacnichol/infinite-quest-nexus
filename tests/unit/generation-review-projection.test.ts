import { describe, expect, test } from "vitest";
import {
  projectGenerationReviewDetailResponse,
  projectGenerationReviewSnapshot,
  projectContinuityReviewTechnicalDiagnostic
} from "../../services/api/src/generation-review-projection.js";
import { projectGenerationReviewDetail } from "../../packages/contracts/src/generation-review.js";
import { generationReviewPresentation } from "../../packages/client-core/src/generation/projection.js";

const reviewId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

describe("generation review public projection", () => {
  test.each([
    ["output_limit", "continuity_review_fallback"],
    ["invalid_output", "continuity_review_primary"],
    ["provider_timeout", "continuity_review_primary"],
    ["provider_failed", "continuity_review_primary"],
    ["context_budget_exceeded", "continuity_review_primary"],
    ["evidence_unavailable", "continuity_review_primary"]
  ] as const)("allowlists %s as a technical continuity failure", (failure, phase) => {
    const expectedMaxAttempts = phase.endsWith("fallback") ? 2 : 1;
    expect(projectContinuityReviewTechnicalDiagnostic({
      version: 2, status: "completed", verdict: "unavailable", unavailableReason: failure,
      outcome: { version: 2, kind: "technical_failure", failure, providerMetadata: { finishReason: "length", outputTokens: 12 } },
      attempts: [{ ordinal: 1, route: phase.endsWith("fallback") ? "fallback" : "primary", routePlanHash: "a".repeat(64), requestHash: "b".repeat(64), responseReference: "private", reservationStatus: "completed", outcome: { version: 2, kind: "technical_failure", failure, providerMetadata: null } }]
    })).toEqual({ version: 1, category: failure, phase, attemptCount: 1, maxAttempts: expectedMaxAttempts, state: "incomplete" });
  });

  test("projects a fallback in progress after reload without exposing request identity", () => {
    const secret = "PRIVATE_REVIEW_PROMPT_AND_PROVIDER_CANARY";
    const diagnostic = projectContinuityReviewTechnicalDiagnostic({
      version: 2, status: "dispatched", verdict: "unavailable", reviewRequestHash: "a".repeat(64),
      outcome: null, attempts: [
        { ordinal: 1, route: "primary", routePlanHash: "b".repeat(64), requestHash: "c".repeat(64), responseReference: secret, reservationStatus: "completed", outcome: { version: 2, kind: "technical_failure", failure: "output_limit", providerMetadata: null } },
        { ordinal: 2, route: "fallback", routePlanHash: "d".repeat(64), requestHash: "e".repeat(64), responseReference: null, reservationStatus: "dispatched", outcome: null }
      ], prompt: secret, providerBody: secret, credentials: secret
    });
    expect(diagnostic).toEqual({ version: 1, category: "output_limit", phase: "continuity_review_fallback", attemptCount: 2, maxAttempts: 2, state: "retrying" });
    expect(JSON.stringify(diagnostic)).not.toContain(secret);
  });

  test("projects a no-dispatch fallback preparation failure without overwriting the primary cause", () => {
    expect(projectContinuityReviewTechnicalDiagnostic({
      version: 2, status: "completed", verdict: "unavailable", unavailableReason: "output_limit",
      outcome: { version: 2, kind: "technical_failure", failure: "output_limit", providerMetadata: null },
      attempts: [{ ordinal: 1, route: "primary", routePlanHash: "a".repeat(64), requestHash: "b".repeat(64), responseReference: null, reservationStatus: "completed", outcome: { version: 2, kind: "technical_failure", failure: "output_limit", providerMetadata: null } }],
      fallbackPreparationFailure: { version: 1, route: "fallback", failure: "context_budget_exceeded" },
      providerError: "PRIVATE_PROVIDER_ERROR"
    })).toEqual({ version: 1, category: "context_budget_exceeded", phase: "continuity_review_fallback_preparation", attemptCount: 1, maxAttempts: 2, state: "incomplete" });
  });

  test("adds technical continuity details without changing semantic findings or retaining provider data", () => {
    const secret = "PRIVATE_FALLBACK_CONTEXT_CANARY";
    const detail = projectGenerationReviewDetail({
      review: { version: 1, reviewId, revision: 1, state: "pending", stage: "continuity", candidateScope: "final", reasons: ["review_unavailable"], canKeep: true, canRetry: true },
      candidate: { narration: "Mara waits by the lighthouse.", choices: ["Wait."] },
      continuityReviewCheckpoint: {
        version: 2, status: "completed", verdict: "unavailable", outcome: { version: 2, kind: "technical_failure", failure: "output_limit", providerMetadata: { finishReason: "length", outputTokens: 1024 } },
        attempts: [{ ordinal: 1, route: "primary", routePlanHash: "a".repeat(64), requestHash: "b".repeat(64), responseReference: secret, reservationStatus: "completed", outcome: { version: 2, kind: "technical_failure", failure: "output_limit", providerMetadata: null } }],
        rawResponse: secret, providerBody: secret, prompt: secret
      }
    });
    expect(detail.findings).toEqual([{ code: "review_unavailable", message: "The automated review was unavailable for this candidate." }]);
    expect(detail.technicalDiagnostic).toEqual({ version: 1, category: "output_limit", phase: "continuity_review_primary", attemptCount: 1, maxAttempts: 1, state: "incomplete" });
    expect(JSON.stringify(detail)).not.toContain(secret);
  });

  test("keeps absent historical and malformed continuity diagnostics out of public projection", () => {
    expect(projectContinuityReviewTechnicalDiagnostic(undefined)).toBeNull();
    expect(projectContinuityReviewTechnicalDiagnostic({ version: 9, prompt: "private" })).toBeNull();
    expect(projectContinuityReviewTechnicalDiagnostic({
      version: 2, status: "completed", verdict: "unavailable", outcome: { kind: "technical_failure", failure: "raw provider output", prompt: "private" }
    })).toBeNull();
  });

  test("explains interrupted candidate recovery with fixed public text", () => {
    const detail = projectGenerationReviewDetailResponse({
      version: 1, reviewId, revision: 1, state: "pending", stage: "continuity", candidateScope: "final",
      reasons: ["provider_interrupted"], canKeep: true, canRetry: false,
      narration: "Mira waits.", choices: ["Wait."], retryDescription: "Retry.", retryFailure: null, omittedFindingCount: 0,
      findings: [{ code: "provider_interrupted", message: "PRIVATE_PROVIDER_ERROR" }]
    });
    expect(detail?.findings).toEqual([{ code: "provider_interrupted", message: "The provider stream was interrupted. A complete candidate passed validation and was preserved for your decision." }]);
  });
  test("projects the same safe review identity for polling and streams without private checkpoint data", () => {
    const privateCanary = "PRIVATE_REVIEW_PROMPT_CANARY";
    const source = {
      id: "11111111-1111-4111-8111-111111111111",
      recoveryMetadata: {
        generationReview: {
          version: 1, reviewId, revision: 4, state: "pending", stage: "continuity", candidateScope: "final",
          reasons: ["narrative_conflict"], canKeep: true, canRetry: true,
          prompt: privateCanary, sourceIds: [privateCanary], rawResponse: privateCanary
        }
      }
    };

    const polling = projectGenerationReviewSnapshot(source);
    const stream = projectGenerationReviewSnapshot(source);

    expect(polling).toEqual(stream);
    expect(polling).toEqual({
      review: {
        version: 1, reviewId, revision: 4, state: "pending", stage: "continuity", candidateScope: "final",
        reasons: ["narrative_conflict"], canKeep: true, canRetry: true
      }
    });
    expect(JSON.stringify(polling)).not.toContain(privateCanary);
  });

  test("retains only the public technical diagnostic in polling and stream review summaries", () => {
    const secret = "PRIVATE_REVIEW_REQUEST_CANARY";
    const result = projectGenerationReviewSnapshot({ review: {
      version: 1, reviewId, revision: 4, state: "pending", stage: "continuity", candidateScope: "final",
      reasons: ["review_unavailable"], canKeep: true, canRetry: true,
      technicalDiagnostic: { version: 1, category: "output_limit", phase: "continuity_review_fallback", attemptCount: 2, maxAttempts: 2, state: "incomplete" },
      privateRequest: secret
    } });
    expect(result.review).toMatchObject({ technicalDiagnostic: {
      version: 1, category: "output_limit", phase: "continuity_review_fallback", attemptCount: 2, maxAttempts: 2, state: "incomplete"
    } });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  test("projects a fallback status outside the review gate and drops malformed status without blocking the job", () => {
    const privateCanary = "PRIVATE_FALLBACK_REQUEST_CANARY";
    const fallback = { version: 1, category: "output_limit", phase: "continuity_review_fallback", attemptCount: 2, maxAttempts: 2, state: "retrying", prompt: privateCanary };
    expect(projectGenerationReviewSnapshot({ continuityReviewDiagnostic: fallback })).toEqual({
      continuityReviewDiagnostic: { version: 1, category: "output_limit", phase: "continuity_review_fallback", attemptCount: 2, maxAttempts: 2, state: "retrying" }
    });
    expect(projectGenerationReviewSnapshot({ continuityReviewDiagnostic: { version: 1, category: privateCanary } })).toEqual({});
  });

  test("keeps only a revalidated candidate quote in a continuity detail response", () => {
    const privateCanary = "PRIVATE_CONTINUITY_EXPLANATION_CANARY";
    const detail = projectGenerationReviewDetailResponse({
      version: 1, reviewId, revision: 1, state: "pending", stage: "continuity", candidateScope: "final",
      reasons: ["narrative_conflict"], canKeep: true, canRetry: true,
      narration: "Mara enters the sealed archive.", choices: ["Wait."], retryDescription: "Retry this generation stage.",
      retryFailure: privateCanary, omittedFindingCount: 0,
      findings: [{ code: "narrative_conflict", message: `The archive's location conflicts: ${privateCanary}` }]
    });

    expect(detail).toMatchObject({
      findings: [{ code: "narrative_conflict", message: "The candidate may conflict with established story continuity." }],
      retryFailure: "The authorized retry did not produce an acceptable replacement."
    });
    expect(JSON.stringify(detail)).not.toContain(privateCanary);
  });

  test("uses a deterministic continuity category and exact candidate quote without reviewer rationale", () => {
    const narration = "Mara enters the sealed archive.";
    const privateCanary = "PRIVATE_CONTINUITY_EXPLANATION_CANARY";
    const detail = projectGenerationReviewDetail({
      review: {
        version: 1, reviewId, revision: 1, state: "pending", stage: "continuity", candidateScope: "final",
        reasons: ["narrative_conflict"], canKeep: true, canRetry: true
      },
      candidate: { narration, choices: ["Wait."] },
      continuityReview: {
        version: "story-continuity-review-v1", verdict: "conflict", findings: [{
          kind: "contradiction", category: "location", severity: "contradiction",
          basis: { kind: "source", evidenceId: "a".repeat(64), quote: "The archive is sealed." },
          output: { path: "/narration", start: 16, end: 22, quote: "sealed" },
          explanation: privateCanary
        }]
      }
    });

    expect(detail.findings).toEqual([{ code: "narrative_conflict", message: "Possible location contradiction in “sealed”." }]);
    expect(JSON.stringify(detail)).not.toContain(privateCanary);
  });

  test("renders technical continuity output exhaustion separately from semantic reasons", () => {
    const presentation = generationReviewPresentation({
      version: 1, reviewId, revision: 1, state: "pending", stage: "continuity", candidateScope: "final",
      reasons: ["review_unavailable"], canKeep: true, canRetry: true,
      technicalDiagnostic: { version: 1, category: "output_limit", phase: "continuity_review_fallback", attemptCount: 2, maxAttempts: 2, state: "incomplete" }
    });
    expect(presentation.message).toBe("Continuity review reached its output limit. Your story is saved.");
    expect(presentation.canKeep).toBe(true);
    expect(presentation.canRetry).toBe(true);
    expect(presentation.retryDescription).toBe("Retry the continuity review; your saved story candidate will be reviewed again.");
  });

  test("labels an active automatic fallback as retrying after a reload", () => {
    const presentation = generationReviewPresentation({
      version: 1, reviewId, revision: 1, state: "pending", stage: "continuity", candidateScope: "final",
      reasons: ["review_unavailable"], canKeep: false, canRetry: false,
      technicalDiagnostic: { version: 1, category: "output_limit", phase: "continuity_review_fallback", attemptCount: 2, maxAttempts: 2, state: "retrying" }
    });
    expect(presentation.message).toBe("Retrying continuity review");
    expect(presentation.canKeep).toBe(false);
    expect(presentation.canRetry).toBe(false);
  });

  test("retains a previously revalidated continuity quote through the API detail boundary", () => {
    const detail = projectGenerationReviewDetailResponse({
      version: 1, reviewId, revision: 1, state: "pending", stage: "continuity", candidateScope: "final",
      reasons: ["narrative_conflict"], canKeep: true, canRetry: true, narration: "Mara enters the sealed archive.",
      choices: [], findings: [{ code: "narrative_conflict", message: "Possible location contradiction in “sealed”." }],
      retryDescription: "Retry this generation stage.", retryFailure: null, omittedFindingCount: 0
    });
    expect(detail.findings).toEqual([{ code: "narrative_conflict", message: "Possible location contradiction in “sealed”." }]);
  });

  test("retains only strict validation issue codes at the API response boundary", () => {
    const privateCanary = "PRIVATE_VALIDATION_RESPONSE_CANARY";
    const detail = projectGenerationReviewDetailResponse({
      version: 1, reviewId, revision: 1, state: "pending", stage: "structure", candidateScope: "final",
      reasons: ["invalid_structure"], canKeep: false, canRetry: true, narration: null, choices: [],
      findings: [{ code: "invalid_structure", message: privateCanary }], retryDescription: "Retry this generation stage.",
      retryFailure: null, omittedFindingCount: 0,
      validationIssues: [{ field: "canonical_fact_updates", code: "missing_array" }]
    });
    expect(detail.validationIssues).toEqual([{ field: "canonical_fact_updates", code: "missing_array" }]);
    expect(JSON.stringify(detail)).not.toContain(privateCanary);
  });

  test("rejects malformed validation issues and retains the generic structure fallback", () => {
    const privateCanary = "PRIVATE_MALFORMED_VALIDATION_ISSUE_CANARY";
    const malformed = {
      version: 1, reviewId, revision: 1, state: "pending", stage: "structure", candidateScope: "final",
      reasons: ["invalid_structure"], canKeep: false, canRetry: true, narration: null, choices: [],
      findings: [{ code: "invalid_structure", message: "The candidate does not meet the required story structure." }],
      retryDescription: "Retry this generation stage.", retryFailure: null, omittedFindingCount: 0,
      validationIssues: [{ field: privateCanary, code: "raw_provider_message", message: privateCanary }]
    };
    expect(() => projectGenerationReviewDetailResponse(malformed)).toThrow();
    expect(JSON.stringify(generationReviewPresentation({
      version: 1, reviewId, revision: 1, state: "pending", stage: "structure", candidateScope: "final",
      reasons: ["invalid_structure"], canKeep: false, canRetry: true
    }, undefined, malformed))).not.toContain(privateCanary);
    expect(generationReviewPresentation({
      version: 1, reviewId, revision: 1, state: "pending", stage: "structure", candidateScope: "final",
      reasons: ["invalid_structure"], canKeep: false, canRetry: true
    }, undefined, malformed).message).toBe("The candidate does not meet the required story structure.");
  });

  test("drops only a malformed technical review diagnostic at the detail boundary", () => {
    const privateCanary = "PRIVATE_MALFORMED_CONTINUITY_DIAGNOSTIC_CANARY";
    const detail = projectGenerationReviewDetailResponse({
      version: 1, reviewId, revision: 1, state: "pending", stage: "continuity", candidateScope: "final",
      reasons: ["review_unavailable"], canKeep: true, canRetry: true, narration: "Mara waits.", choices: [],
      findings: [{ code: "review_unavailable", message: privateCanary }], retryDescription: "Retry this generation stage.",
      retryFailure: null, omittedFindingCount: 0,
      technicalDiagnostic: { version: 1, category: privateCanary, phase: "prompt", requestBody: privateCanary }
    });
    expect(detail).toMatchObject({ canKeep: true, canRetry: true, findings: [{ code: "review_unavailable", message: "The automated review was unavailable for this candidate." }] });
    expect(detail).not.toHaveProperty("technicalDiagnostic");
    expect(JSON.stringify(detail)).not.toContain(privateCanary);
  });

  test("keeps format repair separate from a full replacement for an invalid v2 candidate", () => {
    const presentation = generationReviewPresentation({
      version: 2, reviewId, revision: 2, state: "pending", stage: "structure", candidateScope: "final",
      reasons: ["invalid_structure"], canKeep: false, canRetry: true,
      canRepairFormat: true,
      formatRepair: {
        planHash: "a".repeat(64),
        changedFactCount: 2,
        description: "Repair fact formatting and keep the narration unchanged."
      }
    });

    expect(presentation).toMatchObject({
      state: "review",
      canKeep: false,
      canRetry: true,
      canRepairFormat: true,
      repairDescription: "Repair fact formatting and keep the narration unchanged.",
      retryDescription: "Retry replaces this candidate with a new generation."
    });
  });
});
