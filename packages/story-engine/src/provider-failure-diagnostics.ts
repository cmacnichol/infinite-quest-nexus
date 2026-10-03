import { providerFailureEvidenceSchema, type ProviderFailureEvidenceV1 } from "../../contracts/src/provider-failure.js";

const codes = new Set(["rate_limit_exceeded", "provider_overloaded", "provider_unavailable", "in_flight_budget_exhausted", "weight_exceeds_budget", "insufficient_credits", "invalid_api_key", "permission_denied"]);
const sources = new Set(["openrouter_platform", "upstream_provider", "upstream_provider_shared_pool", "openrouter_in_flight_budget", "openrouter_key_limit", "openrouter_credits"]);
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function status(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599 ? value : null;
}
function counter(value: string | null): number | null {
  if (value === null || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}
export function captureProviderFailure(input: {
  source: ProviderFailureEvidenceV1["source"]; httpStatus: number | null; headers: Headers | null; body: unknown;
  bodyStatus: "parsed" | "absent" | "malformed" | "oversized"; observedAt: Date; knownProviderNames: readonly string[];
  successfulResponseStarted: boolean; emittedOutput: boolean; isOpenRouter?: boolean;
}): ProviderFailureEvidenceV1 {
  const rawError = record(input.body).error ?? input.body;
  const error = record(rawError);
  const malformedMetadata = (rawError !== null && typeof rawError !== "object") || Array.isArray(rawError)
    || (error.metadata !== undefined && (error.metadata === null || typeof error.metadata !== "object" || Array.isArray(error.metadata)));
  const metadata = record(error.metadata);
  const values = [error.code, error.type, metadata.error_type, metadata.reason, metadata.provider_code, metadata.provider_error_code];
  const upstreamCode = values.find(value => typeof value === "string" && codes.has(value)) as ProviderFailureEvidenceV1["upstreamCode"] | undefined;
  const upstreamStatus = status(error.code);
  const effectiveStatus = upstreamStatus ?? status(input.httpStatus);
  let reason: ProviderFailureEvidenceV1["reason"] = "unknown";
  if (effectiveStatus === 429 || ["rate_limit_exceeded", "in_flight_budget_exhausted", "weight_exceeds_budget"].includes(upstreamCode ?? "")) reason = "rate_limit";
  else if ([401, 402, 403].includes(effectiveStatus ?? 0) || ["invalid_api_key", "permission_denied", "insufficient_credits"].includes(upstreamCode ?? "")) reason = "authentication";
  else if (effectiveStatus === 404) reason = "model_unavailable";
  else if ((effectiveStatus ?? 0) >= 500 || ["provider_overloaded", "provider_unavailable"].includes(upstreamCode ?? "")) reason = "provider_unavailable";
  else if (input.source === "transport_error") reason = "ambiguous_transport";
  const limit = counter(input.headers?.get("x-ratelimit-limit") ?? null);
  const remaining = counter(input.headers?.get("x-ratelimit-remaining") ?? null);
  let limitSource: ProviderFailureEvidenceV1["limitSource"] = sources.has(String(metadata.limit_source)) ? metadata.limit_source as ProviderFailureEvidenceV1["limitSource"] : "unknown";
  if (limitSource === "unknown" && upstreamCode) {
    if (input.isOpenRouter && upstreamCode === "insufficient_credits") limitSource = "openrouter_credits";
    else if (input.isOpenRouter && ["in_flight_budget_exhausted", "weight_exceeds_budget"].includes(upstreamCode)) limitSource = "openrouter_in_flight_budget";
    else if ([metadata.provider_code, metadata.provider_error_code].includes(upstreamCode)) limitSource = "upstream_provider";
  }
  if (limitSource === "unknown" && input.isOpenRouter && upstreamCode && [metadata.provider_code, metadata.provider_error_code].some(value => typeof value === "string" && value.length > 0 && value.length <= 256)) limitSource = "upstream_provider";
  if (limitSource === "unknown" && input.isOpenRouter && reason === "rate_limit" && (limit !== null || remaining !== null)) limitSource = "openrouter_platform";
  const providerName = typeof metadata.provider_name === "string" && metadata.provider_name.length <= 256 && input.knownProviderNames.includes(metadata.provider_name) ? metadata.provider_name : null;
  const retry = input.headers?.get("retry-after")?.trim();
  let retryAfterMs: number | null = null;
  if (retry) {
    const delay = /^\d+(?:\.\d+)?$/.test(retry) ? Number(retry) * 1000
      : /^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(retry) ? Date.parse(retry) - input.observedAt.getTime() : NaN;
    if (Number.isSafeInteger(delay) && delay >= 0 && delay <= 86400000) retryAfterMs = delay;
  }
  const recognized = upstreamCode || upstreamStatus || providerName || limitSource !== "unknown";
  const hasMetadata = Object.keys(error).length > 0;
  const evidence: ProviderFailureEvidenceV1 = {
    version: 1, source: input.source, observedAt: input.observedAt.toISOString(), httpStatus: status(input.httpStatus), upstreamStatus,
    reason, limitSource, upstreamCode: upstreamCode ?? null, providerName, retryAfterMs,
    retryAt: retryAfterMs === null ? null : new Date(input.observedAt.getTime() + retryAfterMs).toISOString(),
    // OpenRouter documents the reset header but not its units; never infer units from digit count.
    rateLimit: limit !== null || remaining !== null ? { limit, remaining, resetAt: null } : null,
    successfulResponseStarted: input.successfulResponseStarted, emittedOutput: input.emittedOutput,
    metadataStatus: input.bodyStatus === "parsed" ? malformedMetadata ? "malformed" : recognized ? "recognized" : hasMetadata ? "unrecognized" : "absent" : input.bodyStatus
  };
  const parsed = providerFailureEvidenceSchema.safeParse(evidence);
  if (parsed.success) return parsed.data;
  return { ...evidence, upstreamCode: null, providerName: null, rateLimit: null, retryAfterMs: null, retryAt: null, metadataStatus: "oversized" };
}
