import { describe, expect, test } from "vitest";
import {
  projectGenerationReviewDetailResponse,
  projectGenerationReviewSnapshot
} from "../../services/api/src/generation-review-projection.js";
import { projectGenerationReviewDetail } from "../../packages/contracts/src/generation-review.js";

const reviewId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

describe("generation review public projection", () => {
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

  test("retains a previously revalidated continuity quote through the API detail boundary", () => {
    const detail = projectGenerationReviewDetailResponse({
      version: 1, reviewId, revision: 1, state: "pending", stage: "continuity", candidateScope: "final",
      reasons: ["narrative_conflict"], canKeep: true, canRetry: true, narration: "Mara enters the sealed archive.",
      choices: [], findings: [{ code: "narrative_conflict", message: "Possible location contradiction in “sealed”." }],
      retryDescription: "Retry this generation stage.", retryFailure: null, omittedFindingCount: 0
    });
    expect(detail.findings).toEqual([{ code: "narrative_conflict", message: "Possible location contradiction in “sealed”." }]);
  });
});
