import { describe, expect, it } from "vitest";
import {
  generationJobSnapshotSchema,
  generationReviewDecisionRequestSchema,
  generationReviewReasonCodeSchema,
  projectGenerationReviewSummary
} from "../../packages/contracts/src/index.js";
import { generationReviewCheckpointSchema } from "../../packages/application/src/generation/review-checkpoint.js";

const review = {
  version: 1,
  reviewId: "55555555-5555-4555-8555-555555555555",
  revision: 1,
  state: "pending" as const,
  stage: "continuity" as const,
  candidateScope: "final" as const,
  reasons: ["review_unavailable"] as const,
  canKeep: true,
  canRetry: true
};

const snapshot = {
  id: "11111111-1111-4111-8111-111111111111",
  campaignId: "22222222-2222-4222-8222-222222222222",
  expectedTurnNumber: 1,
  action: "Continue.",
  requestedInputMode: "action",
  resolvedInputMode: "action",
  inputModeSource: "explicit",
  operationKind: "append" as const,
  replacementTurnId: null,
  status: "recoverable",
  attempts: 1,
  resultTurnId: null,
  errorCode: "generation_failed" as const,
  errorMessage: "Generation could not be completed.",
  createdAt: "2026-09-16T00:00:00.000Z",
  updatedAt: "2026-09-16T00:00:00.000Z"
};

describe("generation review contracts", () => {
  it("rejects a decision request with user-controlled bypass fields", () => {
    expect(generationReviewDecisionRequestSchema.safeParse({
      reviewId: review.reviewId,
      revision: 1,
      decision: "keep",
      bypassValidation: true
    }).success).toBe(false);
  });

  it("rejects malformed review decision identity and revision", () => {
    expect(generationReviewDecisionRequestSchema.safeParse({
      reviewId: "not-a-uuid",
      revision: 1,
      decision: "keep"
    }).success).toBe(false);
    expect(generationReviewDecisionRequestSchema.safeParse({
      reviewId: review.reviewId,
      revision: 0,
      decision: "keep"
    }).success).toBe(false);
  });

  it("rejects an unknown review reason", () => {
    expect(generationReviewReasonCodeSchema.safeParse("unreviewed_failure").success).toBe(false);
  });

  it("projects only public review fields", () => {
    expect(projectGenerationReviewSummary({
      ...review,
      candidateHash: "a".repeat(64),
      ownerUserId: "33333333-3333-4333-8333-333333333333",
      rawProviderResponse: "private"
    })).toEqual(review);
  });

  it("accepts old snapshots without a review and projects a supplied review", () => {
    expect(generationJobSnapshotSchema.parse(snapshot).review).toBeUndefined();
    expect(generationJobSnapshotSchema.parse({ ...snapshot, review }).review).toEqual(review);
  });

  it("rejects a private checkpoint whose offered candidate has a different campaign binding", () => {
    const candidate = {
      scope: "final",
      story: null,
      storyHash: "a".repeat(64),
      rawOutputReference: "provider-output-1",
      producingRequestHash: null,
      producingResponseId: null,
      sentFactIds: [],
      ownerUserId: "33333333-3333-4333-8333-333333333333",
      campaignId: snapshot.campaignId,
      worldId: "44444444-4444-4444-8444-444444444444",
      worldVersionId: "66666666-6666-4666-8666-666666666666",
      baseTurnNumber: 0,
      expectedTurnNumber: 1,
      policy: {},
      policyHash: "e".repeat(64),
      protocol: { version: "story-v1", promptHash: "b".repeat(64) },
      provider: { type: "lmstudio", profileId: null, configurationHash: "c".repeat(64) },
      resumeDependencies: { generationContext: {}, producingProviderResult: {}, stageState: {}, frozenCommitInputs: {}, replacementTarget: null }
    };
    expect(generationReviewCheckpointSchema.safeParse({
      version: 1,
      reviewId: review.reviewId,
      revision: 1,
      state: "pending",
      stage: "continuity",
      candidateScope: "final",
      reasons: ["review_unavailable"],
      originalCandidate: { ...candidate, scope: "main" },
      gateCandidate: { ...candidate, campaignId: "77777777-7777-4777-8777-777777777777" },
      workingCandidate: candidate,
      originalFindings: ["review_unavailable"],
      originalFindingsHash: "d".repeat(64),
      retryFailure: null,
      decisionJournal: []
    }).success).toBe(false);
  });
});
