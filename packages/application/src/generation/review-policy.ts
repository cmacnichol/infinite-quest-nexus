import type { GenerationReviewReasonCode } from "@infinite-quest/contracts";

const keepableReasonCodes = new Set<GenerationReviewReasonCode>([
  "scene_beats_missing", "narrative_conflict", "review_uncertain", "review_unavailable"
]);

export type GenerationReviewEligibility = Readonly<{
  complete: boolean; structurallyValid: boolean; mechanicsClean: boolean; authorityValid: boolean;
  candidateScope: "main" | "final"; stageComplete: boolean; reasons: readonly GenerationReviewReasonCode[];
}>;

/** Keep waives only review uncertainty; hard validation remains server-owned. */
export function canKeepGenerationCandidate(input: GenerationReviewEligibility): boolean {
  return input.complete && input.structurallyValid && input.mechanicsClean && input.authorityValid
    && input.stageComplete && input.reasons.length > 0
    && input.reasons.every((reason) => keepableReasonCodes.has(reason));
}
