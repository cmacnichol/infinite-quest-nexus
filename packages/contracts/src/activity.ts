import { z } from "zod";
import { generationFailureDiagnosticProjectionSchema, projectGenerationFailureDiagnostic } from "./generation-review.js";

export const ACTIVITY_MAX_BYTES = 4096;
export const activitySequenceSchema = z.string().regex(/^(0|[1-9][0-9]*)$/u).refine(value => BigInt(value) <= 9223372036854775807n);
export const activityScopeSchema = z.strictObject({ ownerUserId: z.uuid(), campaignId: z.uuid() });
export const activityPhaseSchema = z.enum(["queued", "assessing", "generating", "validating", "committing", "indexing", "story", "continuity_review_primary", "continuity_review_fallback", "continuity_review_fallback_preparation", "refining", "provider_pending", "downloading"]);
export const activityRouteTemplateSchema = z.enum(["/api/v1/campaigns/:campaignId", "/api/v1/campaigns/:campaignId/activity", "/api/v1/campaigns/:campaignId/generations", "/api/v1/campaigns/:campaignId/generations/retry-latest", "/api/v1/campaigns/:campaignId/turns/:turnId", "/api/v1/generation-jobs/:jobId", "/api/v1/generation-jobs/:jobId/review", "/api/v1/generation-jobs/:jobId/retry", "/api/v1/generation-jobs/:jobId/cancel", "/api/v1/generation-jobs/:jobId/discard", "/api/v1/generation-jobs/:jobId/review-decision", "/api/v1/generation-jobs/:jobId/result", "/api/v1/generation-jobs/:jobId/stream", "/api/v1/campaigns/:campaignId/turns", "/api/v1/campaigns/:campaignId/state", "/api/v1/campaigns/:campaignId/illustration-segments", "/api/v1/illustration-segments/:segmentId/images", "/api/v1/turns/:turnId/illustrations"]);
export const ACTIVITY_DIAGNOSTIC_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  ...Object.fromEntries(generationFailureDiagnosticProjectionSchema.shape.code.options.map(code => [code, projectGenerationFailureDiagnostic({ version: 1, category: "unknown", code, phase: "activity", attemptNumber: 0, occurredAt: "2026-01-01T00:00:00Z" })!.message])),
  review_required: "Generation requires an explicit review decision.",
  monitoring_degraded: "The browser lost monitoring contact. This does not establish that generation failed.",
  result_unavailable: "The completed result could not be loaded.",
  request_failed: "The request could not be completed.",
  contract_invalid: "The server response did not match the expected contract.",
  image_failed: "The illustration could not be completed.",
  image_expired: "The illustration request expired.",
  history_unavailable: "Activity history could not be loaded."
});
export const activityDiagnosticCodeSchema = z.enum([...generationFailureDiagnosticProjectionSchema.shape.code.options, "review_required", "monitoring_degraded", "result_unavailable", "request_failed", "contract_invalid", "image_failed", "image_expired", "history_unavailable"]);
export const activityDiagnosticSchema = z.strictObject({
  code: activityDiagnosticCodeSchema,
  message: z.string().max(160),
  phase: activityPhaseSchema.optional(),
  correlationId: z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/u).optional(),
  httpStatus: z.number().int().min(100).max(599).optional(),
  providerProfileId: z.uuid().optional(),
  modelId: z.string().min(1).max(200).regex(/^[A-Za-z0-9._:/@+-]+$/u)
    .refine(value => !/^(?:[a-z][a-z0-9+.-]*:\/\/|(?:https?|wss?|ftp|file|data|javascript):|\/\/)/iu.test(value), "Model identifiers cannot be provider URLs")
    .optional(),
  durationMs: z.number().finite().nonnegative().optional(),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).optional(),
  routeTemplate: activityRouteTemplateSchema.optional(),
  metadataTruncated: z.literal(true).optional()
}).refine(value => value.message === ACTIVITY_DIAGNOSTIC_MESSAGES[value.code], "Message must match the public catalog");
export const generationActivityKindSchema = z.enum(["generation.queued", "generation.claimed", "generation.generating", "generation.validating", "generation.committing", "generation.review_required", "generation.review_decided", "generation.retry_queued", "generation.completed", "generation.recoverable", "generation.failed", "generation.cancelled", "generation.discarded"]);
export const imageActivityKindSchema = z.enum(["image.queued", "image.generating", "image.provider_pending", "image.downloading", "image.retry_queued", "image.completed", "image.recoverable", "image.failed", "image.cancelled", "image.expired"]);
export const segmentActivityKindSchema = z.enum(["illustration_segment.refining", "illustration_segment.direct_fallback", "illustration_segment.completed", "illustration_segment.failed"]);
export const browserActivityKindSchema = z.enum(["browser.campaign_load", "browser.submission_failed", "browser.monitoring_degraded", "browser.monitoring_restored", "browser.monitoring_detached", "browser.result_unavailable", "browser.recovery_command_failed", "browser.history_page_failed", "browser.undo_result", "browser.illustration_command_failed"]);
const related = { campaignId: z.uuid(), jobId: z.uuid().nullable(), generationJobId: z.uuid().nullable(), segmentId: z.uuid().nullable(), turnId: z.uuid().nullable() };
const common = { version: z.literal(1), eventId: z.uuid(), occurredAt: z.iso.datetime(), ...related, severity: z.enum(["info", "warning", "error", "success"]), turnNumber: z.number().int().safe().nonnegative().nullable(), attemptNumber: z.number().int().safe().nonnegative().nullable(), diagnostic: activityDiagnosticSchema.nullable() };
export const generationActivityStatusSchema = z.enum(["queued", "replacement_queued", "assessing", "generating", "validating", "committing", "completed", "recoverable", "failed", "discarded", "cancelled"]);
export const imageActivityStatusSchema = z.enum(["queued", "generating", "provider_pending", "downloading", "completed", "recoverable", "failed", "cancelled", "expired"]);
export const segmentActivityStatusSchema = z.enum(["queued", "refining", "generating", "completed", "recoverable", "failed"]);
const sources = [
  { source: z.literal("generation"), kind: generationActivityKindSchema, status: generationActivityStatusSchema },
  { source: z.literal("image"), kind: imageActivityKindSchema, status: imageActivityStatusSchema },
  { source: z.literal("illustration_segment"), kind: segmentActivityKindSchema, status: segmentActivityStatusSchema }
] as const;
export function activitySerializedSize(value: unknown): number {
  let bytes = 0;
  for (const character of JSON.stringify(value)) {
    const point = character.codePointAt(0)!;
    bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
  }
  return bytes;
}
const bounded = (value: unknown) => activitySerializedSize(value) <= ACTIVITY_MAX_BYTES;
export const activityEventDraftSchema = z.discriminatedUnion("source", [z.strictObject({ ...common, ...sources[0] }), z.strictObject({ ...common, ...sources[1] }), z.strictObject({ ...common, ...sources[2] })]).refine(bounded, "Activity exceeds 4 KiB");
const publication = { sequence: activitySequenceSchema, publishedAt: z.iso.datetime() };
export const activityEventSchema = z.discriminatedUnion("source", [z.strictObject({ ...common, ...publication, ...sources[0] }), z.strictObject({ ...common, ...publication, ...sources[1] }), z.strictObject({ ...common, ...publication, ...sources[2] })]).refine(bounded, "Activity exceeds 4 KiB");
export const browserActivityObservationSchema = z.strictObject({ version: z.literal(1), observationId: z.uuid(), sequence: activitySequenceSchema, observedAt: z.iso.datetime(), ...related, kind: browserActivityKindSchema, severity: z.enum(["info", "warning", "error", "success"]), diagnostic: activityDiagnosticSchema.nullable() }).refine(value => value.kind !== "browser.monitoring_degraded" || value.severity === "warning", "Monitoring interruption is a browser warning").refine(bounded, "Activity exceeds 4 KiB");
const cursor = z.string().min(1).max(512);
export const activityPageQuerySchema = z.strictObject({ limit: z.coerce.number().int().min(1).max(200).default(100), before: cursor.optional(), after: cursor.optional() }).refine(value => !(value.before && value.after), "Cursors are mutually exclusive");
export const activityCoverageSchema = z.strictObject({ capturedSince: z.iso.datetime().nullable(), retentionDays: z.literal(30), oldestAvailableSequence: activitySequenceSchema.nullable(), latestPublishedSequence: activitySequenceSchema, pendingPublication: z.boolean(), incomplete: z.boolean(), resetRequired: z.boolean() });
export const activityPageSchema = z.strictObject({ version: z.literal(1), events: z.array(activityEventSchema).max(200), nextBefore: cursor.nullable(), nextAfter: cursor.nullable(), hasMore: z.boolean(), coverage: activityCoverageSchema });
export type ActivityScope = z.infer<typeof activityScopeSchema>;
export type ActivityDiagnostic = z.infer<typeof activityDiagnosticSchema>;
export type ActivityEventDraft = z.infer<typeof activityEventDraftSchema>;
export type ActivityEvent = z.infer<typeof activityEventSchema>;
export type BrowserActivityObservation = z.infer<typeof browserActivityObservationSchema>;
export type ActivityPage = z.infer<typeof activityPageSchema>;
export type ActivityPageQuery = z.infer<typeof activityPageQuerySchema>;
