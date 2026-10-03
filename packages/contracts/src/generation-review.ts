import { z } from "zod";
import { providerFailureEvidenceSchema, providerFailureProjectionSchema, projectProviderFailure, projectProviderFailureEvidence } from "./provider-failure.js";
import { continuityReviewSchema } from "./story-continuity-review.js";

/** Safe provider metadata only; raw output and provider-private references never enter this record. */
export const continuityReviewProviderMetadataSchema = z.strictObject({
  finishReason: z.enum(["stop", "length", "max_tokens", "content_filter", "tool_calls", "unknown"]),
  outputTokens: z.number().int().nonnegative().safe().nullable()
});

/** Durable attempt result: technical failures cannot carry a semantic verdict. */
export const continuityReviewAttemptOutcomeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ version: z.literal(2), kind: z.literal("semantic_verdict"), review: continuityReviewSchema,
    providerMetadata: continuityReviewProviderMetadataSchema.nullable() }),
  z.strictObject({ version: z.literal(2), kind: z.literal("technical_failure"),
    failure: z.enum(["output_limit", "invalid_output", "provider_timeout", "provider_failed", "context_budget_exceeded", "evidence_unavailable"]),
    providerMetadata: continuityReviewProviderMetadataSchema.nullable() })
]);
export type ContinuityReviewAttemptOutcome = z.infer<typeof continuityReviewAttemptOutcomeSchema>;

/** Browser-safe continuity-review execution status, separate from semantic findings. */
export const generationReviewTechnicalDiagnosticSchema = z.strictObject({
  version: z.literal(1),
  category: z.enum(["output_limit", "invalid_output", "provider_timeout", "provider_failed", "context_budget_exceeded", "evidence_unavailable"]),
  phase: z.enum(["continuity_review_primary", "continuity_review_fallback", "continuity_review_fallback_preparation"]),
  attemptCount: z.number().int().min(1).max(2),
  maxAttempts: z.number().int().min(1).max(2),
  state: z.enum(["retrying", "incomplete"])
});
export type GenerationReviewTechnicalDiagnostic = z.infer<typeof generationReviewTechnicalDiagnosticSchema>;

/** Selects only named fields before validating an untrusted public diagnostic. */
export function projectGenerationReviewTechnicalDiagnosticProjection(value: unknown): GenerationReviewTechnicalDiagnostic | null {
  const source = typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const parsed = generationReviewTechnicalDiagnosticSchema.safeParse({
    version: source.version, category: source.category, phase: source.phase,
    attemptCount: source.attemptCount, maxAttempts: source.maxAttempts, state: source.state
  });
  return parsed.success ? parsed.data : null;
}

/** Projects private v2 checkpoint evidence to a bounded, provider-safe status. */
export function projectContinuityReviewTechnicalDiagnostic(value: unknown): GenerationReviewTechnicalDiagnostic | null {
  const source = typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
  if (source?.version !== 2 || (source.status !== "dispatched" && source.status !== "completed")) return null;
  const asRecord = (item: unknown): Record<string, unknown> | null => typeof item === "object" && item !== null && !Array.isArray(item) ? item as Record<string, unknown> : null;
  const attempts = Array.isArray(source.attempts) ? source.attempts.map(asRecord) : [];
  const latest = attempts.at(-1) ?? null;
  const prep = asRecord(source.fallbackPreparationFailure);
  const latestOutcome = asRecord(latest?.outcome);
  const primary = attempts.find((attempt) => attempt?.route === "primary");
  const primaryOutcome = asRecord(primary?.outcome);
  const outcome = asRecord(source.outcome);
  const failure = typeof prep?.failure === "string" ? prep.failure
    : source.status === "dispatched" && latest?.route === "fallback" ? primaryOutcome?.failure
    : latestOutcome?.kind === "technical_failure" ? latestOutcome.failure
    : outcome?.kind === "technical_failure" ? outcome.failure
    : source.unavailableReason;
  const phase = prep ? "continuity_review_fallback_preparation"
    : latest?.route === "fallback" ? "continuity_review_fallback" : "continuity_review_primary";
  const attemptCount = Math.min(2, Math.max(1, attempts.length));
  const maxAttempts = prep || attempts.some((attempt) => attempt?.route === "fallback") ? 2 : 1;
  const state = source.status === "dispatched" && latest?.route === "fallback" && latest.reservationStatus !== "completed"
    ? "retrying" : "incomplete";
  const parsed = generationReviewTechnicalDiagnosticSchema.safeParse({ version: 1, category: failure, phase, attemptCount, maxAttempts, state });
  return parsed.success ? parsed.data : null;
}

export const generationReviewStageSchema = z.enum(["structure", "choices", "scene_coverage", "event_coverage", "continuity"]);
export const generationReviewReasonCodeSchema = z.enum(["scene_beats_missing", "narrative_conflict", "review_uncertain", "review_unavailable", "invalid_choices", "invalid_structure", "output_incomplete", "mechanics_contamination", "event_coverage_failed", "candidate_stale", "candidate_invalid", "provider_interrupted"]);

const reviewIdRevisionSchema = {
  reviewId: z.uuid(),
  revision: z.number().int().safe().positive()
};

/** v1 decisions deliberately remain closed: a historic Retry is never a repair. */
export const generationReviewDecisionRequestSchema = z.discriminatedUnion("decision", [
  z.strictObject({
    ...reviewIdRevisionSchema,
  decision: z.enum(["keep", "retry"])
  }),
  z.strictObject({
    ...reviewIdRevisionSchema,
    decision: z.literal("repair_format"),
    repairPlanHash: z.string().regex(/^[a-f0-9]{64}$/u)
  })
]);

/**
 * Versioned, private record of the last generation failure. The shape is
 * deliberately closed so raw provider errors cannot become durable API data.
 */
export const generationFailureDiagnosticSchema = z.strictObject({
  version: z.literal(1),
  category: z.enum(["format", "mechanics", "continuity", "provider_timeout", "provider_transport", "provider_rejection", "output_incomplete", "authority", "unknown"]),
  code: z.enum(["provider_rate_limited", "provider_authentication_failed", "provider_route_unavailable", "provider_model_unavailable", "provider_refusal", "provider_schema_invalid", "provider_schema_unsupported", "invalid_schema", "mechanics_leak", "scene_coverage", "provider_request_timeout", "provider_transport_error", "empty_output", "output_limit", "stale_campaign", "generation_failed"]),
  phase: z.string().trim().min(1).max(80),
  attemptNumber: z.number().int().min(0),
  occurredAt: z.iso.datetime(),
  providerFailure: providerFailureEvidenceSchema.optional().catch(undefined)
});

export const generationFailureDiagnosticProjectionSchema = z.strictObject({
  code: z.enum(["provider_rate_limited", "provider_authentication_failed", "provider_route_unavailable", "provider_model_unavailable", "provider_refusal", "provider_schema_invalid", "provider_schema_unsupported", "provider_request_timeout", "provider_transport_error", "empty_output", "output_limit", "generation_failed"]),
  message: z.string().trim().min(1).max(160),
  providerFailure: providerFailureProjectionSchema.optional().catch(undefined)
});

const publicFailureDiagnosticMessages = {
  provider_rate_limited: "The provider rate limit was reached. Wait before retrying.",
  provider_authentication_failed: "The provider rejected authentication or access. Check the provider credentials and permissions.",
  provider_route_unavailable: "The provider route is unavailable. Try again later or choose another provider.",
  provider_model_unavailable: "The requested model is unavailable. Check the selected model or preset.",
  provider_refusal: "The provider refused the request.",
  provider_schema_invalid: "The provider rejected the response schema as invalid.",
  provider_schema_unsupported: "The provider does not support the requested response schema.",
  provider_request_timeout: "The provider request timed out.",
  provider_transport_error: "The provider connection failed.",
  empty_output: "The provider returned no usable output.",
  output_limit: "The provider output was incomplete.",
  generation_failed: "The generation could not be completed."
} as const;

/** Projects a durable private failure category to a fixed public vocabulary. */
export function projectGenerationFailureDiagnostic(value: unknown): GenerationFailureDiagnosticProjection | null {
  const source = typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
  const evidence = projectProviderFailureEvidence(source.providerFailure);
  const parsed = generationFailureDiagnosticSchema.safeParse({
    version: source.version,
    category: source.category,
    code: source.code,
    phase: source.phase,
    attemptNumber: source.attemptNumber,
    occurredAt: source.occurredAt,
    ...(evidence ? { providerFailure: evidence } : {})
  });
  if (!parsed.success || !(parsed.data.code in publicFailureDiagnosticMessages)) return null;
  const code = parsed.data.code as keyof typeof publicFailureDiagnosticMessages;
  const providerFailure = projectProviderFailure(parsed.data.providerFailure);
  return { code, message: publicFailureDiagnosticMessages[code], ...(providerFailure ? { providerFailure } : {}) };
}

export const generationReviewV1SummarySchema = z.strictObject({
  version: z.literal(1), reviewId: z.uuid(), revision: z.number().int().safe().positive(),
  state: z.enum(["pending", "decided"]), stage: generationReviewStageSchema,
  candidateScope: z.enum(["main", "final"]), reasons: z.array(generationReviewReasonCodeSchema).min(1).max(20),
  canKeep: z.boolean(), canRetry: z.boolean(),
  technicalDiagnostic: generationReviewTechnicalDiagnosticSchema.optional()
});

const formatRepairOfferSchema = z.strictObject({
  planHash: z.string().regex(/^[a-f0-9]{64}$/u),
  changedFactCount: z.number().int().min(1).max(100),
  description: z.literal("Repair fact formatting and keep the narration unchanged.")
});

export const generationReviewV2SummarySchema = generationReviewV1SummarySchema.extend({
  version: z.literal(2),
  canRepairFormat: z.boolean(),
  formatRepair: formatRepairOfferSchema.nullable()
}).superRefine((review, context) => {
  if (review.canRepairFormat !== (review.formatRepair !== null)) {
    context.addIssue({ code: "custom", message: "Repair offer availability must match its bounded description." });
  }
});

export const generationReviewSummarySchema = z.union([generationReviewV1SummarySchema, generationReviewV2SummarySchema]);

/** A future review version is deliberately reduced to its version marker. */
export const generationReviewTransportSchema = z.union([
  generationReviewSummarySchema,
  z.object({ version: z.number().int().safe().gt(2) }).passthrough().transform(({ version }) => ({ version }))
]);

export const generationReviewFindingSchema = z.strictObject({
  code: generationReviewReasonCodeSchema,
  message: z.string().trim().min(1).max(500)
});

export const generationValidationIssueFieldSchema = z.enum(["superseded_facts", "canonical_fact_updates", "canonical_facts"]);
export const generationValidationIssueCodeSchema = z.enum(["missing_array", "expected_string_item", "invalid_field_shape"]);
export const generationValidationIssueSchema = z.strictObject({
  field: generationValidationIssueFieldSchema,
  code: generationValidationIssueCodeSchema
});

const generationReviewDetailFields = {
  narration: z.string().max(200_000).nullable(), choices: z.array(z.string().max(20_000)).max(100),
  findings: z.array(generationReviewFindingSchema).max(20), retryDescription: z.string().trim().min(1).max(500),
  retryFailure: z.string().trim().min(1).max(500).nullable(), omittedFindingCount: z.number().int().min(0),
  validationIssues: z.array(generationValidationIssueSchema).max(8).optional()
};
export const generationReviewDetailSchema = z.union([
  generationReviewV1SummarySchema.extend(generationReviewDetailFields).strict(),
  generationReviewV2SummarySchema.extend(generationReviewDetailFields).strict()
]);

const validationFields = ["superseded_facts", "canonical_fact_updates", "canonical_facts"] as const;
const missingArrayPattern = /^(superseded_facts|canonical_fact_updates|canonical_facts): Invalid input: expected array, received undefined$/u;
const expectedStringItemPattern = /^(superseded_facts|canonical_fact_updates|canonical_facts)\.\d+: Invalid input: expected string, received object$/u;
const invalidFieldShapePattern = /^(superseded_facts|canonical_fact_updates|canonical_facts): Invalid input: expected array, received (?:null|boolean|number|string|object)$/u;

/** Projects only recognized validator shapes; provider text is never retained. */
export function projectGenerationValidationIssues(errors: readonly string[]): GenerationValidationIssue[] {
  const issues: GenerationValidationIssue[] = [];
  const seen = new Set<string>();
  for (const error of errors.slice(0, 100)) {
    const missing = missingArrayPattern.exec(error);
    const item = expectedStringItemPattern.exec(error);
    const shape = invalidFieldShapePattern.exec(error);
    const match = missing ?? item ?? shape;
    if (!match || !validationFields.includes(match[1] as GenerationValidationIssueField)) continue;
    const issue: GenerationValidationIssue = {
      field: match[1] as GenerationValidationIssueField,
      code: missing ? "missing_array" : item ? "expected_string_item" : "invalid_field_shape"
    };
    const key = `${issue.field}:${issue.code}`;
    if (!seen.has(key)) { seen.add(key); issues.push(issue); }
    if (issues.length === 8) break;
  }
  return issues;
}

const reviewReasonMessages: Record<GenerationReviewReasonCode, string> = {
  scene_beats_missing: "The candidate does not cover all requested scene beats.",
  narrative_conflict: "The candidate may conflict with established story continuity.",
  review_uncertain: "The automated review could not reach a conclusive result.",
  review_unavailable: "The automated review was unavailable for this candidate.",
  invalid_choices: "The candidate choices do not meet the required structure.",
  invalid_structure: "The candidate does not meet the required story structure.",
  output_incomplete: "The candidate output is incomplete.",
  provider_interrupted: "The provider stream was interrupted. A complete candidate passed validation and was preserved for your decision.",
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
  review: z.union([generationReviewV1SummarySchema.passthrough(), generationReviewV2SummarySchema.passthrough()]),
  candidate: fictionPreviewSchema.nullable().optional(),
  continuityReview: continuityReviewSchema.nullable().optional(),
  omittedFindingCount: z.number().int().min(0).optional(),
  continuityReviewCheckpoint: z.unknown().optional(),
  validationIssues: z.array(generationValidationIssueSchema).max(8).optional()
}).passthrough();

const continuityCategoryLabels = {
  world_rule: "world-rule", character_attribute: "character-detail", relationship: "relationship", chronology: "chronology",
  location: "location", object_state: "object-state", thread_loss: "open-thread", direction_coverage: "story-direction",
  replacement_state: "replacement-state"
} as const;

function specificContinuityFinding(
  narration: string | undefined,
  review: z.infer<typeof continuityReviewSchema> | null | undefined
): GenerationReviewFinding | null {
  if (!narration || !review || review.verdict !== "conflict") return null;
  const finding = review.findings.find((candidate) => candidate.kind === "contradiction");
  if (!finding || finding.kind !== "contradiction" || finding.output.path !== "/narration"
    || narration.slice(finding.output.start, finding.output.end) !== finding.output.quote) return null;
  return {
    code: "narrative_conflict",
    message: `Possible ${continuityCategoryLabels[finding.category]} contradiction in “${finding.output.quote}”.`
  };
}

/**
 * Converts server-validated fiction preview fields into a public detail. Review
 * messages are static code mappings; persisted errors and reviewer prose never
 * cross this boundary.
 */
export function projectGenerationReviewDetail(value: unknown): GenerationReviewDetail {
  const input = generationReviewDetailProjectionInputSchema.parse(value);
  const specific = input.review.reasons.includes("narrative_conflict")
    ? specificContinuityFinding(input.candidate?.narration, input.continuityReview)
    : null;
  return generationReviewDetailSchema.parse({
    ...projectGenerationReviewSummary(input.review),
    narration: input.candidate?.narration ?? null,
    choices: input.candidate?.choices ?? [],
    findings: input.review.reasons.map((code) => specific?.code === code ? specific : ({ code, message: reviewReasonMessages[code] })),
    retryDescription: "Retry this generation stage.",
    // Retry execution errors are private orchestration diagnostics.  The public
    // surface records only that the one authorized replacement was unavailable.
    retryFailure: input.review.retryFailure ? "The authorized retry did not produce an acceptable replacement." : null,
    omittedFindingCount: input.omittedFindingCount ?? 0,
    ...(projectContinuityReviewTechnicalDiagnostic(input.continuityReviewCheckpoint)
      ? { technicalDiagnostic: projectContinuityReviewTechnicalDiagnostic(input.continuityReviewCheckpoint)! } : {}),
    ...(input.validationIssues ? { validationIssues: input.validationIssues } : {})
  });
}

/** Selects the sole browser-safe review fields from private orchestration data. */
export function projectGenerationReviewSummary(value: unknown): GenerationReviewSummary {
  const source = typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const technicalDiagnostic = projectGenerationReviewTechnicalDiagnosticProjection(source.technicalDiagnostic);
  const { technicalDiagnostic: _untrustedDiagnostic, ...summarySource } = source;
  const parsed = z.union([generationReviewV1SummarySchema.passthrough(), generationReviewV2SummarySchema.passthrough()]).parse(summarySource);
  const base = { version: parsed.version, reviewId: parsed.reviewId, revision: parsed.revision, state: parsed.state,
    stage: parsed.stage, candidateScope: parsed.candidateScope, reasons: parsed.reasons,
    canKeep: parsed.canKeep, canRetry: parsed.canRetry,
    ...(technicalDiagnostic ? { technicalDiagnostic } : {}) };
  return parsed.version === 2
    ? { ...base, version: 2, canRepairFormat: parsed.canRepairFormat, formatRepair: parsed.formatRepair }
    : { ...base, version: 1 };
}

export type GenerationReviewStage = z.infer<typeof generationReviewStageSchema>;
export type GenerationFailureDiagnostic = Readonly<z.infer<typeof generationFailureDiagnosticSchema>>;
export type GenerationFailureDiagnosticProjection = Readonly<z.infer<typeof generationFailureDiagnosticProjectionSchema>>;
export type GenerationReviewReasonCode = z.infer<typeof generationReviewReasonCodeSchema>;
export type GenerationReviewDecisionRequest = Readonly<z.infer<typeof generationReviewDecisionRequestSchema>>;
/**
 * The browser treats v2's repair fields as optional at compile time so a
 * stored future/older record cannot be mistaken for an authority grant. The
 * runtime schemas above remain strict for each known version.
 */
export type GenerationReviewSummary = Readonly<z.infer<typeof generationReviewV1SummarySchema> | z.infer<typeof generationReviewV2SummarySchema>>;
export type GenerationReviewTransport = Readonly<z.infer<typeof generationReviewTransportSchema>>;
export type GenerationReviewFinding = Readonly<z.infer<typeof generationReviewFindingSchema>>;
export type GenerationValidationIssueField = z.infer<typeof generationValidationIssueFieldSchema>;
export type GenerationValidationIssueCode = z.infer<typeof generationValidationIssueCodeSchema>;
export type GenerationValidationIssue = Readonly<z.infer<typeof generationValidationIssueSchema>>;
export type GenerationReviewDetail = Readonly<z.infer<typeof generationReviewDetailSchema>>;
