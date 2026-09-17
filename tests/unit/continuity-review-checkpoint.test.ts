import { describe, expect, it } from "vitest";
import { continuityReviewCheckpointSchema, assertContinuityReviewCommit, assertGenerationReviewAcceptance, reviewBindingHash } from "../../packages/application/src/memory/continuity-review-checkpoint.js";
import { generationReviewFindingsHash } from "../../packages/application/src/generation/review-checkpoint.js";
import { canonicalEvidenceJson } from "../../packages/application/src/memory/generation-context.js";
import { sha256Hex, storyTurnOutputSchema } from "../../packages/contracts/src/index.js";
const binding = { draftHash: "a".repeat(64), producingRequestHash: "b".repeat(64), manifestHash: "c".repeat(64), providerConfigurationHash: "d".repeat(64), promptHash: "e".repeat(64), promptProtocol: "story-continuity-review-v1" as const, policyHash: "f".repeat(64) };
const checkpoint = { version: 1, mode: "enforce", binding, bindingHash: reviewBindingHash(binding), status: "completed", verdict: "pass", reviewRequestHash: "0".repeat(64), result: { version: "story-continuity-review-v1", verdict: "pass", findings: [] } };
describe("durable continuity review checkpoint", () => {
  it("requires the completed bound pass for enforcing commits", () => {
    expect(() => assertContinuityReviewCommit("enforce", checkpoint, binding)).not.toThrow();
    expect(() => assertContinuityReviewCommit("enforce", { ...checkpoint, status: "dispatched", result: null, verdict: "unavailable" }, binding)).toThrow();
    expect(() => assertContinuityReviewCommit("enforce", checkpoint, { ...binding, draftHash: "1".repeat(64) })).toThrow();
    expect(() => assertContinuityReviewCommit("enforce", undefined, binding)).toThrow();
  });
  it("permits observed unavailability without calling it a pass, and rejects malformed identities", () => {
    expect(() => assertContinuityReviewCommit("observe", { ...checkpoint, mode: "observe", verdict: "unavailable", result: null }, binding)).not.toThrow();
    expect(continuityReviewCheckpointSchema.safeParse({ ...checkpoint, reviewRequestHash: null }).success).toBe(false);
    expect(continuityReviewCheckpointSchema.safeParse({ ...checkpoint, bindingHash: "2".repeat(64) }).success).toBe(false);
    expect(() => assertContinuityReviewCommit("off", undefined, binding)).not.toThrow();
  });
  it("accepts an enforced final conflict only for its exact persisted Keep receipt", () => {
    const story = storyTurnOutputSchema.parse({ narration: "The archive door opens.", choices: ["Enter the archive.", "Circle the tower.", "Call to the keeper.", "Study the door."], custom_action_suggestion: "Examine the door.", scratchpad: "", tracker_updates: [], image_prompt: "An archive door.", continuity_summary: "The door opened.", canonical_facts: [], superseded_facts: [], canonical_fact_updates: [], open_threads: [] });
    const candidate = {
      scope: "final" as const, story, storyHash: sha256Hex(canonicalEvidenceJson(story)), rawOutputReference: null,
      producingRequestHash: "1".repeat(64), producingResponseId: "response-1", sentFactIds: [],
      ownerUserId: "11111111-1111-4111-8111-111111111111", campaignId: "22222222-2222-4222-8222-222222222222", worldId: "33333333-3333-4333-8333-333333333333", worldVersionId: "44444444-4444-4444-8444-444444444444",
      baseTurnNumber: 2, expectedTurnNumber: 3, policy: {}, policyHash: "2".repeat(64), baseIdentity: { operationKind: "append" as const, baseTurnNumber: 2, expectedTurnNumber: 3, campaignActiveTurnNumber: 2, campaignStateRevision: 1, stateEditRevision: null, narrationCorrectionRevision: null, baseTurnId: null, stateFingerprint: "3".repeat(64), narrationFingerprint: null },
      protocol: { version: "story-v1", promptHash: "6".repeat(64) }, provider: { type: "openai_compatible", profileId: "55555555-5555-4555-8555-555555555555", configurationHash: "7".repeat(64) },
      resumeDependencies: { generationContext: {}, producingProviderResult: null, stageState: {}, frozenCommitInputs: {}, replacementTarget: null }
    };
    const reasons = ["narrative_conflict"] as const;
    const checkpoint = { version: 1 as const, reviewId: "66666666-6666-4666-8666-666666666666", revision: 2, state: "decided" as const, stage: "continuity" as const, candidateScope: "final" as const, reasons,
      operationKind: "append" as const, replacementTurnId: null, eligibility: { complete: true, structurallyValid: true, mechanicsClean: true, authorityValid: true, stageComplete: true, retryAvailable: true },
      originalCandidate: candidate, gateCandidate: candidate, workingCandidate: candidate, originalFindings: reasons, originalFindingsHash: generationReviewFindingsHash(reasons), retryFailure: null,
      decisionJournal: [{ reviewId: "66666666-6666-4666-8666-666666666666", revision: 1, actorUserId: candidate.ownerUserId, decision: "keep" as const, decidedAt: "2026-09-16T00:00:00.000Z", candidateScope: "final" as const, candidateHash: candidate.storyHash, findingsHash: generationReviewFindingsHash(reasons), nextStage: null, offeredCandidate: candidate, offeredReasons: reasons, actionReceipt: { jobId: "77777777-7777-4777-8777-777777777777", status: "queued" as const, operationKind: "append" as const, replacementTurnId: null } }]
    };
    const expected = { jobId: "77777777-7777-4777-8777-777777777777", actorUserId: candidate.ownerUserId, candidateScope: "final" as const, candidateHash: candidate.storyHash, stage: "continuity" as const, findingsHash: generationReviewFindingsHash(reasons), ownerUserId: candidate.ownerUserId, campaignId: candidate.campaignId, worldId: candidate.worldId, worldVersionId: candidate.worldVersionId, baseIdentity: candidate.baseIdentity, protocol: candidate.protocol, policyHash: candidate.policyHash, operationKind: "append" as const, replacementTurnId: null };
    expect(() => assertGenerationReviewAcceptance(checkpoint, expected)).not.toThrow();
    for (const mismatch of [
      { ...expected, candidateHash: "8".repeat(64) }, { ...expected, findingsHash: "9".repeat(64) }, { ...expected, worldId: "88888888-8888-4888-8888-888888888888" },
      { ...expected, baseIdentity: { ...candidate.baseIdentity, campaignStateRevision: 2 } }, { ...expected, protocol: { ...candidate.protocol, version: "story-v2" } },
      { ...expected, operationKind: "replace_latest" as const, replacementTurnId: "99999999-9999-4999-8999-999999999999" }
    ]) expect(() => assertGenerationReviewAcceptance(checkpoint, mismatch)).toThrow();
    expect(() => assertGenerationReviewAcceptance({ ...checkpoint, decisionJournal: [] }, expected)).toThrow();
  });
});
