import { z } from "zod";
import { generationReviewSummarySchema, type GenerationReviewSummary } from "../../contracts/src/generation-review.js";
import { canKeepGenerationCandidate } from "../../application/src/generation/review-policy.js";

const generationReviewSummaryEvidenceSchema = generationReviewSummarySchema.omit({ canKeep: true, canRetry: true }).extend({
  eligibility: z.strictObject({
    complete: z.boolean(), structurallyValid: z.boolean(), mechanicsClean: z.boolean(), authorityValid: z.boolean(),
    stageComplete: z.boolean(), retryAvailable: z.boolean()
  }),
  candidatePresent: z.boolean()
}).strict();

/**
 * Builds the bounded JSONB projection used by polling and campaign sync.
 * Callers pass SQL identifiers fixed in source; this expression never selects
 * the private candidate, prompt, provider result, or decision journal.
 */
export function generationReviewSummaryProjection(privateColumn: string): string {
  const review = `${privateColumn} #> '{generationReview}'`;
  const field = (path: string) => `${privateColumn} #> '{generationReview,${path}}'`;
  const text = (path: string) => `${privateColumn} #>> '{generationReview,${path}}'`;
  return `CASE WHEN ${review} IS NULL THEN NULL ELSE jsonb_build_object(
    'version', (${text("version")})::int,
    'reviewId', ${text("reviewId")},
    'revision', (${text("revision")})::int,
    'state', ${text("state")},
    'stage', ${text("stage")},
    'candidateScope', ${text("candidateScope")},
    'reasons', ${field("reasons")},
    'eligibility', jsonb_build_object(
      'complete', COALESCE((${text("eligibility,complete")})::boolean, false),
      'structurallyValid', COALESCE((${text("eligibility,structurallyValid")})::boolean, false),
      'mechanicsClean', COALESCE((${text("eligibility,mechanicsClean")})::boolean, false),
      'authorityValid', COALESCE((${text("eligibility,authorityValid")})::boolean, false),
      'stageComplete', COALESCE((${text("eligibility,stageComplete")})::boolean, false),
      'retryAvailable', COALESCE((${text("eligibility,retryAvailable")})::boolean, false)
    ),
    'candidatePresent', COALESCE(jsonb_typeof(${field("gateCandidate,story")}) = 'object', false)
  ) END`;
}

/** Calculates public action availability with the same policy used by decisions. */
export function projectBoundedGenerationReviewSummary(value: unknown, status: unknown): GenerationReviewSummary | undefined {
  const parsed = generationReviewSummaryEvidenceSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const pending = status === "recoverable" && parsed.data.state === "pending";
  return generationReviewSummarySchema.parse({
    version: parsed.data.version,
    reviewId: parsed.data.reviewId,
    revision: parsed.data.revision,
    state: parsed.data.state,
    stage: parsed.data.stage,
    candidateScope: parsed.data.candidateScope,
    reasons: parsed.data.reasons,
    canKeep: pending && parsed.data.candidatePresent && canKeepGenerationCandidate({
      ...parsed.data.eligibility,
      stage: parsed.data.stage,
      candidateScope: parsed.data.candidateScope,
      reasons: parsed.data.reasons
    }),
    canRetry: pending && parsed.data.eligibility.retryAvailable
  });
}
