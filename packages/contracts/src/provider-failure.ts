import { z } from "zod";

const statusSchema = z.number().int().min(100).max(599).nullable();
const counterSchema = z.number().int().nonnegative().safe().nullable();
const publicFields = {
  version: z.literal(1),
  source: z.enum(["http_error", "sse_error", "transport_error"]),
  httpStatus: statusSchema,
  upstreamStatus: statusSchema,
  reason: z.enum(["rate_limit", "provider_unavailable", "model_unavailable", "authentication", "schema_invalid", "refusal", "cancelled", "deadline", "ambiguous_transport", "invalid_identity", "unknown"]),
  limitSource: z.enum(["openrouter_platform", "upstream_provider", "upstream_provider_shared_pool", "openrouter_in_flight_budget", "openrouter_key_limit", "openrouter_credits", "unknown"]),
  retryAfterMs: z.number().int().nonnegative().safe().max(86400000).nullable(),
  retryAt: z.iso.datetime().nullable()
};

/** Closed public vocabulary; provider identity and account counters stay private. */
export const providerFailureProjectionSchema = z.strictObject(publicFields);
export type ProviderFailureProjectionV1 = z.infer<typeof providerFailureProjectionSchema>;

/** Bounded operator evidence, never a raw provider response. */
export const providerFailureEvidenceSchema = z.strictObject({
  ...publicFields,
  observedAt: z.iso.datetime(),
  upstreamCode: z.enum(["rate_limit_exceeded", "provider_overloaded", "provider_unavailable", "in_flight_budget_exhausted", "weight_exceeds_budget", "insufficient_credits", "invalid_api_key", "permission_denied"]).nullable(),
  // Identity must be corroborated by the invocation before constructing this record.
  providerName: z.string().trim().min(1).max(256).nullable(),
  rateLimit: z.strictObject({ limit: counterSchema, remaining: counterSchema, resetAt: z.iso.datetime().nullable() }).nullable(),
  successfulResponseStarted: z.boolean(),
  emittedOutput: z.boolean(),
  metadataStatus: z.enum(["recognized", "absent", "unrecognized", "malformed", "oversized"])
}).refine((value) => utf8ByteLength(JSON.stringify(value)) <= 4096, {
  message: "Provider failure evidence exceeds its byte limit."
});
export type ProviderFailureEvidenceV1 = z.infer<typeof providerFailureEvidenceSchema>;

// Keep contracts usable by the pure ES client-core compiler without Web/Node APIs.
function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    bytes += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
  }
  return bytes;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Select named fields before validation, so unknown/private keys cannot propagate. */
export function projectProviderFailure(value: unknown): ProviderFailureProjectionV1 | null {
  const source = asRecord(value);
  const parsed = providerFailureProjectionSchema.safeParse({
    version: source.version, source: source.source, httpStatus: source.httpStatus, upstreamStatus: source.upstreamStatus,
    reason: source.reason, limitSource: source.limitSource, retryAfterMs: source.retryAfterMs, retryAt: source.retryAt
  });
  return parsed.success ? parsed.data : null;
}

/** Selects only recognized evidence fields, including the nested counter object. */
export function projectProviderFailureEvidence(value: unknown): ProviderFailureEvidenceV1 | null {
  const source = asRecord(value);
  const publicValue = projectProviderFailure(source);
  if (!publicValue) return null;
  const rateLimit = asRecord(source.rateLimit);
  const parsed = providerFailureEvidenceSchema.safeParse({
    ...publicValue, observedAt: source.observedAt, upstreamCode: source.upstreamCode, providerName: source.providerName,
    rateLimit: source.rateLimit === null ? null : { limit: rateLimit.limit, remaining: rateLimit.remaining, resetAt: rateLimit.resetAt },
    successfulResponseStarted: source.successfulResponseStarted, emittedOutput: source.emittedOutput, metadataStatus: source.metadataStatus
  });
  return parsed.success ? parsed.data : null;
}
