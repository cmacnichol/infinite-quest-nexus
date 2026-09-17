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
