import { describe, expect, it } from "vitest";
import {
  generationJobSnapshotSchema,
  generationReviewDecisionRequestSchema,
  generationReviewReasonCodeSchema,
  projectGenerationValidationIssues,
  projectGenerationReviewDetail,
  projectGenerationReviewSummary
} from "../../packages/contracts/src/index.js";
import { generationReviewCandidateSchema, generationReviewCheckpointSchema, generationReviewFindingsHash } from "../../packages/application/src/generation/review-checkpoint.js";

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
  it("projects only known structural validation errors into finite safe issues", () => {
    expect(projectGenerationValidationIssues([
      "superseded_facts: Invalid input: expected array, received undefined",
      "canonical_fact_updates: Invalid input: expected array, received undefined"
    ])).toEqual([
      { field: "superseded_facts", code: "missing_array" },
      { field: "canonical_fact_updates", code: "missing_array" }
    ]);
    expect(projectGenerationValidationIssues([
      "canonical_facts.0: Invalid input: expected string, received object",
      "canonical_facts.1: Invalid input: expected string, received object"
    ])).toEqual([{ field: "canonical_facts", code: "expected_string_item" }]);
    expect(projectGenerationValidationIssues([
      "PRIVATE_CANARY: provider response and prompt contents"
    ])).toEqual([]);
  });

  it("rejects malformed, unsupported, repeated, and overlong validation diagnostics", () => {
    const privateCanary = "PRIVATE_VALIDATION_CANARY";
    expect(projectGenerationValidationIssues([
      "canonical_facts.x: Invalid input: expected string, received object",
      "unknown_field: Invalid input: expected array, received undefined",
      "canonical_facts.0: Invalid input: expected number, received string",
      `canonical_facts: ${privateCanary}`,
      "canonical_facts: Invalid input: expected array, received object",
      "canonical_facts: Invalid input: expected array, received object",
      ...Array.from({ length: 20 }, () => "superseded_facts: Invalid input: expected array, received null")
    ])).toEqual([
      { field: "canonical_facts", code: "invalid_field_shape" },
      { field: "superseded_facts", code: "invalid_field_shape" }
    ]);
  });
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
      baseIdentity: {
        operationKind: "append",
        expectedTurnNumber: 1,
        baseTurnNumber: 0,
        campaignActiveTurnNumber: 0,
        campaignStateRevision: 0,
        stateEditRevision: null,
        narrationCorrectionRevision: null,
        baseTurnId: null,
        stateFingerprint: "f".repeat(64),
        narrationFingerprint: null
      },
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
      operationKind: "append",
      replacementTurnId: null,
      eligibility: { complete: true, structurallyValid: true, mechanicsClean: true, authorityValid: true, stageComplete: false, retryAvailable: true },
      originalCandidate: { ...candidate, scope: "main" },
      gateCandidate: { ...candidate, campaignId: "77777777-7777-4777-8777-777777777777" },
      workingCandidate: candidate,
      originalFindings: ["review_unavailable"],
      originalFindingsHash: "d".repeat(64),
      retryFailure: null,
      decisionJournal: []
    }).success).toBe(false);
  });

  it("retains a historical main offer receipt after a final candidate opens a later gate", () => {
    const baseIdentity = {
      operationKind: "append",
      expectedTurnNumber: 1,
      baseTurnNumber: 0,
      campaignActiveTurnNumber: 0,
      campaignStateRevision: 0,
      stateEditRevision: null,
      narrationCorrectionRevision: null,
      baseTurnId: null,
      stateFingerprint: "f".repeat(64),
      narrationFingerprint: null
    };
    const candidate = (scope: "main" | "final", storyHash: string) => ({
      scope, story: null, storyHash, rawOutputReference: `provider-${scope}`, producingRequestHash: null,
      producingResponseId: null, sentFactIds: [], ownerUserId: "33333333-3333-4333-8333-333333333333",
      campaignId: snapshot.campaignId, worldId: "44444444-4444-4444-8444-444444444444",
      // Legacy validated-main checkpoints retain a nullable world-version identity.
      worldVersionId: null, baseTurnNumber: 0, expectedTurnNumber: 1,
      baseIdentity, policy: {}, policyHash: "e".repeat(64), protocol: { version: "story-v1", promptHash: "b".repeat(64) },
      provider: { type: "lmstudio", profileId: null, configurationHash: "c".repeat(64) },
      resumeDependencies: { generationContext: {}, producingProviderResult: {}, stageState: {}, frozenCommitInputs: {}, replacementTarget: null }
    });
    const main = candidate("main", "a".repeat(64));
    const final = candidate("final", "d".repeat(64));
    const originalFindings = ["scene_beats_missing"] as const;
    const offeredReasons = ["scene_beats_missing"] as const;
    const checkpoint = {
      version: 1, reviewId: review.reviewId, revision: 2, state: "pending", stage: "continuity", candidateScope: "final",
      reasons: ["review_uncertain"], operationKind: "append", replacementTurnId: null,
      eligibility: { complete: true, structurallyValid: true, mechanicsClean: true, authorityValid: true, stageComplete: false, retryAvailable: true },
      originalCandidate: main, gateCandidate: final, workingCandidate: final,
      originalFindings, originalFindingsHash: generationReviewFindingsHash(originalFindings), retryFailure: null,
      decisionJournal: [{
        reviewId: "88888888-8888-4888-8888-888888888888", revision: 1, actorUserId: main.ownerUserId, decision: "keep",
        decidedAt: "2026-09-16T00:00:00.000Z", candidateScope: "main", candidateHash: main.storyHash,
        findingsHash: generationReviewFindingsHash(offeredReasons), nextStage: "choices", offeredCandidate: main, offeredReasons,
        actionReceipt: { jobId: snapshot.id, status: "queued", operationKind: "append", replacementTurnId: null }
      }]
    };
    expect(generationReviewCheckpointSchema.safeParse(checkpoint).success).toBe(true);
    expect(generationReviewCheckpointSchema.safeParse({
      ...checkpoint,
      decisionJournal: [{ ...checkpoint.decisionJournal[0], findingsHash: "9".repeat(64) }]
    }).success).toBe(false);
    expect(generationReviewCheckpointSchema.safeParse({ ...checkpoint, originalFindingsHash: "9".repeat(64) }).success).toBe(false);
  });

  it("rejects a checkpoint when candidate base identity changes despite matching turn numbers", () => {
    const candidate = {
      scope: "final", story: null, storyHash: "a".repeat(64), rawOutputReference: "provider-output-1", producingRequestHash: null,
      producingResponseId: null, sentFactIds: [], ownerUserId: "33333333-3333-4333-8333-333333333333", campaignId: snapshot.campaignId,
      worldId: "44444444-4444-4444-8444-444444444444", worldVersionId: "66666666-6666-4666-8666-666666666666",
      baseTurnNumber: 0, expectedTurnNumber: 1, policy: {}, policyHash: "e".repeat(64), protocol: { version: "story-v1", promptHash: "b".repeat(64) },
      provider: { type: "lmstudio", profileId: null, configurationHash: "c".repeat(64) },
      baseIdentity: { operationKind: "append", expectedTurnNumber: 1, baseTurnNumber: 0, campaignActiveTurnNumber: 0, campaignStateRevision: 0, stateEditRevision: null, narrationCorrectionRevision: null, baseTurnId: null, stateFingerprint: "f".repeat(64), narrationFingerprint: null },
      resumeDependencies: { generationContext: {}, producingProviderResult: {}, stageState: {}, frozenCommitInputs: {}, replacementTarget: null }
    };
    expect(generationReviewCheckpointSchema.safeParse({
      version: 1, reviewId: review.reviewId, revision: 1, state: "pending", stage: "continuity", candidateScope: "final", reasons: ["review_unavailable"],
      operationKind: "append", replacementTurnId: null,
      eligibility: { complete: true, structurallyValid: true, mechanicsClean: true, authorityValid: true, stageComplete: false, retryAvailable: true },
      originalCandidate: candidate, gateCandidate: candidate,
      workingCandidate: { ...candidate, baseIdentity: { ...candidate.baseIdentity, campaignStateRevision: 1 } },
      originalFindings: ["review_unavailable"], originalFindingsHash: "d".repeat(64), retryFailure: null, decisionJournal: []
    }).success).toBe(false);
  });

  it("projects static safe findings and fiction preview without private canaries", () => {
    const detail = projectGenerationReviewDetail({
      review: { ...review, reasons: ["review_uncertain", "review_unavailable"] },
      candidate: { narration: "Mira crosses the quay.", choices: ["Follow Mira"] },
      privateFailure: "PRIVATE-CANARY",
      privateFindings: [{ message: "PRIVATE-CANARY" }],
      omittedFindingCount: 2
    });
    expect(detail.findings).toEqual([
      { code: "review_uncertain", message: "The automated review could not reach a conclusive result." },
      { code: "review_unavailable", message: "The automated review was unavailable for this candidate." }
    ]);
    expect(detail).toMatchObject({ narration: "Mira crosses the quay.", choices: ["Follow Mira"], retryFailure: null, omittedFindingCount: 2 });
    expect(JSON.stringify(detail)).not.toContain("PRIVATE-CANARY");
  });

  it("keeps an absent validation issue field valid for stored review details", () => {
    const detail = projectGenerationReviewDetail({ review, candidate: null });
    expect(detail.validationIssues).toBeUndefined();
  });

  it("rejects a typed story candidate whose stable hash does not match its content", () => {
    expect(generationReviewCandidateSchema.safeParse({
      scope: "main", storyHash: "a".repeat(64), rawOutputReference: null, producingRequestHash: "b".repeat(64), producingResponseId: null,
      sentFactIds: [], ownerUserId: "33333333-3333-4333-8333-333333333333", campaignId: snapshot.campaignId,
      worldId: "44444444-4444-4444-8444-444444444444", worldVersionId: null, baseTurnNumber: 0, expectedTurnNumber: 1,
      baseIdentity: { operationKind: "append", expectedTurnNumber: 1, baseTurnNumber: 0, campaignActiveTurnNumber: 0, campaignStateRevision: 0, stateEditRevision: null, narrationCorrectionRevision: null, baseTurnId: null, stateFingerprint: "f".repeat(64), narrationFingerprint: null },
      policy: {}, policyHash: "e".repeat(64), protocol: { version: "story-v1", promptHash: "c".repeat(64) },
      provider: { type: "lmstudio", profileId: null, configurationHash: "d".repeat(64) },
      resumeDependencies: { generationContext: {}, producingProviderResult: {}, stageState: {}, frozenCommitInputs: {}, replacementTarget: null },
      story: { narration: "Mira waits at the quay.", choices: ["Wait", "Look", "Listen", "Leave"], custom_action_suggestion: "Wait", scratchpad: "Mira waits.", tracker_updates: [], image_prompt: "A quiet quay.", continuity_summary: "Mira waits at the quay.", canonical_facts: [], superseded_facts: [], canonical_fact_updates: [], open_threads: [] }
    }).success).toBe(false);
  });
});
