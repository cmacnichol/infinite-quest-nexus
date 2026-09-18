import { randomUUID } from "node:crypto";
import {
  generationReviewCheckpointSchema,
  generationReviewFindingsHash,
  type GenerationReviewCandidate,
  type GenerationReviewCheckpoint
} from "../../../packages/application/src/generation/review-checkpoint.js";
import type { GenerationReviewReasonCode, GenerationReviewStage } from "../../../packages/contracts/src/generation-review.js";

/** Builds the immutable offer that the repository later fences and journals. */
export function prepareGenerationReview(input: Readonly<{
  candidate: GenerationReviewCandidate;
  stage: GenerationReviewStage;
  reasons: readonly GenerationReviewReasonCode[];
  operationKind: "append" | "replace_latest";
  replacementTurnId: string | null;
  eligibility?: Partial<GenerationReviewCheckpoint["eligibility"]>;
  reviewId?: string;
  revision?: number;
  originalCandidate?: GenerationReviewCandidate;
  originalFindings?: readonly GenerationReviewReasonCode[];
  decisionJournal?: GenerationReviewCheckpoint["decisionJournal"];
  retryFailure?: string | null;
  factFormatRepair?: NonNullable<GenerationReviewCheckpoint["factFormatRepair"]>;
}>): GenerationReviewCheckpoint {
  const originalFindings = input.originalFindings ?? input.reasons;
  const eligibility = {
    complete: input.candidate.story !== null,
    structurallyValid: false,
    mechanicsClean: false,
    authorityValid: false,
    stageComplete: false,
    retryAvailable: false,
    ...input.eligibility
  };
  return generationReviewCheckpointSchema.parse({
    version: input.factFormatRepair ? 2 : 1,
    reviewId: input.reviewId ?? randomUUID(),
    revision: input.revision ?? 1,
    state: "pending",
    stage: input.stage,
    candidateScope: input.candidate.scope,
    reasons: [...input.reasons],
    operationKind: input.operationKind,
    replacementTurnId: input.replacementTurnId,
    eligibility,
    originalCandidate: input.originalCandidate ?? input.candidate,
    gateCandidate: input.candidate,
    workingCandidate: input.candidate,
    originalFindings: [...originalFindings],
    originalFindingsHash: generationReviewFindingsHash(originalFindings),
    retryFailure: input.retryFailure ?? null,
    ...(input.factFormatRepair ? { factFormatRepair: input.factFormatRepair } : {}),
    decisionJournal: input.decisionJournal ?? []
  });
}
