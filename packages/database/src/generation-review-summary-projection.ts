import { z } from "zod";
import { generationReviewSummarySchema, generationReviewTransportSchema, generationReviewV1SummarySchema, type GenerationReviewTransport } from "../../contracts/src/generation-review.js";
import { canKeepGenerationCandidate } from "../../application/src/generation/review-policy.js";

const generationReviewSummaryEvidenceV1Schema = generationReviewV1SummarySchema.omit({ canKeep: true, canRetry: true }).extend({
  eligibility: z.strictObject({
    complete: z.boolean(), structurallyValid: z.boolean(), mechanicsClean: z.boolean(), authorityValid: z.boolean(),
    stageComplete: z.boolean(), retryAvailable: z.boolean()
  }),
  candidatePresent: z.boolean(),
  technicalDiagnostic: generationReviewV1SummarySchema.shape.technicalDiagnostic,
  repairPlanHash: z.string().regex(/^[a-f0-9]{64}$/u).nullable().optional(),
  repairChangedFactCount: z.number().int().min(1).max(100).nullable().optional(),
  repairStatus: z.enum(["offered", "authorized", "applied", "failed"]).nullable().optional()
}).strict();
const generationReviewSummaryEvidenceSchema = z.union([
  generationReviewSummaryEvidenceV1Schema,
  generationReviewSummaryEvidenceV1Schema.extend({
    version: z.literal(2), repairPlanHash: z.string().regex(/^[a-f0-9]{64}$/u), repairChangedFactCount: z.number().int().min(1).max(100)
  }).strict()
]);

/**
 * Builds the bounded JSONB projection used by polling and campaign sync.
 * Callers pass SQL identifiers fixed in source; this expression never selects
 * the private candidate, prompt, provider result, or decision journal.
 */
export function generationReviewSummaryProjection(privateColumn: string): string {
  const review = `${privateColumn} #> '{generationReview}'`;
  const field = (path: string) => `${privateColumn} #> '{generationReview,${path}}'`;
  const text = (path: string) => `${privateColumn} #>> '{generationReview,${path}}'`;
  const technicalDiagnostic = continuityReviewTechnicalDiagnosticProjection(privateColumn);
  return `CASE WHEN ${review} IS NULL THEN NULL
  WHEN CASE WHEN ${text("version")} ~ '^[0-9]+$' THEN (${text("version")})::int ELSE 0 END > 2
    THEN jsonb_build_object('version', (${text("version")})::int)
  ELSE jsonb_build_object(
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
    , 'repairPlanHash', ${text("factFormatRepair,planHash")}
    , 'repairChangedFactCount', CASE WHEN ${text("factFormatRepair,planHash")} IS NULL THEN NULL ELSE jsonb_array_length(COALESCE(${field("factFormatRepair,plan,changes")}, '[]'::jsonb)) END
    , 'repairStatus', ${text("factFormatRepair,status")}
  ) || CASE WHEN ${technicalDiagnostic} IS NULL THEN '{}'::jsonb
      ELSE jsonb_build_object('technicalDiagnostic', ${technicalDiagnostic}) END
  END`;
}

/** Returns only the bounded diagnostic fields needed to explain continuity-review retries. */
export function continuityReviewTechnicalDiagnosticProjection(privateColumn: string): string {
  const path = (value: string) => `${privateColumn} #>> '{continuityReview,${value}}'`;
  const array = `${privateColumn} #> '{continuityReview,attempts}'`;
  const attemptCount = `GREATEST(CASE WHEN jsonb_typeof(${array}) = 'array' THEN jsonb_array_length(${array}) ELSE 0 END, 1)`;
  const failure = `COALESCE(${path("fallbackPreparationFailure,failure")}, CASE WHEN ${path("status")} = 'dispatched' AND ${path("attempts,-1,route")} = 'fallback' THEN ${privateColumn} #>> '{continuityReview,attempts,0,outcome,failure}' END, ${privateColumn} #>> '{continuityReview,attempts,-1,outcome,failure}', ${path("outcome,failure")}, ${path("unavailableReason")})`;
  const category = `CASE WHEN ${failure} IN ('output_limit','invalid_output','provider_timeout','provider_failed','context_budget_exceeded','evidence_unavailable') THEN ${failure} ELSE NULL END`;
  return `CASE WHEN ${path("version")} = '2' AND ${path("status")} IN ('dispatched', 'completed') AND ${category} IS NOT NULL THEN jsonb_build_object(
    'version', 1,
    'category', ${category},
    'phase', CASE WHEN ${path("fallbackPreparationFailure,failure")} IS NOT NULL THEN 'continuity_review_fallback_preparation'
      WHEN ${path("attempts,-1,route")} = 'fallback' THEN 'continuity_review_fallback' ELSE 'continuity_review_primary' END,
    'attemptCount', ${attemptCount},
    'maxAttempts', CASE WHEN ${path("fallbackPreparationFailure,failure")} IS NOT NULL OR ${attemptCount} > 1 THEN 2 ELSE 1 END,
    'state', CASE WHEN ${path("status")} = 'dispatched' AND ${path("attempts,-1,route")} = 'fallback' THEN 'retrying' ELSE 'incomplete' END
  ) ELSE NULL END`;
}

/** Calculates public action availability with the same policy used by decisions. */
export function projectBoundedGenerationReviewSummary(value: unknown, status: unknown): GenerationReviewTransport | undefined {
  const transport = generationReviewTransportSchema.safeParse(value);
  if (transport.success && transport.data.version > 2) return transport.data;
  const source = typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const technicalDiagnostic = generationReviewV1SummarySchema.shape.technicalDiagnostic.safeParse(source.technicalDiagnostic);
  const { technicalDiagnostic: _untrustedDiagnostic, ...summarySource } = source;
  const parsed = generationReviewSummaryEvidenceSchema.safeParse(summarySource);
  if (!parsed.success) return undefined;
  const pending = status === "recoverable" && parsed.data.state === "pending";
  const base = {
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
    canRetry: pending && parsed.data.eligibility.retryAvailable,
    ...(technicalDiagnostic.success ? { technicalDiagnostic: technicalDiagnostic.data } : {})
  };
  const repairOffered = pending && parsed.data.repairStatus === "offered";
  return parsed.data.version === 2
    ? generationReviewSummarySchema.parse({ ...base, version: 2,
      canRepairFormat: repairOffered, formatRepair: repairOffered ? {
        planHash: parsed.data.repairPlanHash, changedFactCount: parsed.data.repairChangedFactCount,
        description: "Repair fact formatting and keep the narration unchanged."
      } : null })
    : generationReviewSummarySchema.parse({ ...base, version: 1 });
}
