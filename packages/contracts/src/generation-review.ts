import { z } from "zod";

export const generationReviewStageSchema = z.enum(["structure", "choices", "scene_coverage", "event_coverage", "continuity"]);
export const generationReviewReasonCodeSchema = z.enum(["scene_beats_missing", "narrative_conflict", "review_uncertain", "review_unavailable", "invalid_choices", "invalid_structure", "output_incomplete", "mechanics_contamination", "event_coverage_failed", "candidate_stale", "candidate_invalid"]);

export const generationReviewDecisionRequestSchema = z.strictObject({
  reviewId: z.uuid(),
  revision: z.number().int().safe().positive(),
  decision: z.enum(["keep", "retry"])
});

export const generationReviewSummarySchema = z.strictObject({
  version: z.literal(1), reviewId: z.uuid(), revision: z.number().int().safe().positive(),
  state: z.enum(["pending", "decided"]), stage: generationReviewStageSchema,
  candidateScope: z.enum(["main", "final"]), reasons: z.array(generationReviewReasonCodeSchema).min(1).max(20),
  canKeep: z.boolean(), canRetry: z.boolean()
});

export const generationReviewFindingSchema = z.strictObject({
  code: generationReviewReasonCodeSchema,
  message: z.string().trim().min(1).max(500)
});

export const generationReviewDetailSchema = generationReviewSummarySchema.extend({
  narration: z.string().max(200_000).nullable(), choices: z.array(z.string().max(20_000)).max(100),
  findings: z.array(generationReviewFindingSchema).max(20), retryDescription: z.string().trim().min(1).max(500),
  retryFailure: z.string().trim().min(1).max(500).nullable(), omittedFindingCount: z.number().int().min(0)
}).strict();

const reviewReasonMessages: Record<GenerationReviewReasonCode, string> = {
  scene_beats_missing: "The candidate does not cover all requested scene beats.",
  narrative_conflict: "The candidate may conflict with established story continuity.",
  review_uncertain: "The automated review could not reach a conclusive result.",
  review_unavailable: "The automated review was unavailable for this candidate.",
  invalid_choices: "The candidate choices do not meet the required structure.",
  invalid_structure: "The candidate does not meet the required story structure.",
  output_incomplete: "The candidate output is incomplete.",
  mechanics_contamination: "The candidate contains game mechanics language.",
  event_coverage_failed: "The candidate does not cover required story events.",
  candidate_stale: "The candidate no longer matches the current campaign authority.",
  candidate_invalid: "The candidate is not valid for acceptance."
};

const fictionPreviewSchema = z.strictObject({
  narration: z.string().max(200_000),
  choices: z.array(z.string().max(20_000)).max(100)
});

const generationReviewDetailProjectionInputSchema = z.object({
  review: generationReviewSummarySchema.passthrough(),
  candidate: fictionPreviewSchema.nullable().optional(),
  omittedFindingCount: z.number().int().min(0).optional()
}).passthrough();

/**
 * Converts server-validated fiction preview fields into a public detail. Review
 * messages are static code mappings; persisted errors and reviewer prose never
 * cross this boundary.
 */
export function projectGenerationReviewDetail(value: unknown): GenerationReviewDetail {
  const input = generationReviewDetailProjectionInputSchema.parse(value);
  return generationReviewDetailSchema.parse({
    ...projectGenerationReviewSummary(input.review),
    narration: input.candidate?.narration ?? null,
    choices: input.candidate?.choices ?? [],
    findings: input.review.reasons.map((code) => ({ code, message: reviewReasonMessages[code] })),
    retryDescription: "Retry this generation stage.",
    // Retry execution errors are private orchestration diagnostics.  The public
    // surface records only that the one authorized replacement was unavailable.
    retryFailure: input.review.retryFailure ? "The authorized retry did not produce an acceptable replacement." : null,
    omittedFindingCount: input.omittedFindingCount ?? 0
  });
}

/** Selects the sole browser-safe review fields from private orchestration data. */
export function projectGenerationReviewSummary(value: unknown): GenerationReviewSummary {
  const parsed = generationReviewSummarySchema.passthrough().parse(value);
  return { version: parsed.version, reviewId: parsed.reviewId, revision: parsed.revision, state: parsed.state,
    stage: parsed.stage, candidateScope: parsed.candidateScope, reasons: parsed.reasons,
    canKeep: parsed.canKeep, canRetry: parsed.canRetry };
}

export type GenerationReviewStage = z.infer<typeof generationReviewStageSchema>;
export type GenerationReviewReasonCode = z.infer<typeof generationReviewReasonCodeSchema>;
export type GenerationReviewDecisionRequest = Readonly<z.infer<typeof generationReviewDecisionRequestSchema>>;
export type GenerationReviewSummary = Readonly<z.infer<typeof generationReviewSummarySchema>>;
export type GenerationReviewFinding = Readonly<z.infer<typeof generationReviewFindingSchema>>;
export type GenerationReviewDetail = Readonly<z.infer<typeof generationReviewDetailSchema>>;
