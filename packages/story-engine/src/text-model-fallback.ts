export type ModelFallbackReason =
  | "rate_limit"
  | "provider_unavailable"
  | "content_policy_violation"
  | "refusal"
  | "authentication"
  | "invalid_request"
  | "cancelled"
  | "request_timeout"
  | "model_unavailable"
  | "context_length"
  | "transport_failure"
  | "empty_response"
  | "network_policy_denied"
  | "response_too_large"
  | "output_limit"
  | "unknown_failure";

export type ProviderModelAttempt = Readonly<{
  model: string;
  outcome: "succeeded" | "failed" | "refused";
  reason: ModelFallbackReason | null;
  emittedOutput: boolean;
  retryAfterMs?: number;
}>;

export type ProviderModelRouting = Readonly<{
  strategy: "single" | "openrouter_native" | "openrouter_preset_snapshot" | "sequential";
  configuredModels: readonly string[];
  resolvedModel: string;
  fallbackUsed: boolean;
  attempts: readonly ProviderModelAttempt[];
  emittedOutput: boolean;
}>;

export type ProviderModelPlan = Readonly<{
  providerType: string;
  model: string;
  fallbackModels?: readonly string[];
  routingSource?: "models" | "openrouter_preset";
}>;

export type NormalizedModelFailure = Readonly<{
  reason: ModelFallbackReason;
  retryAfterMs?: number;
  /** SSE terminal events can forbid an otherwise generally retryable reason from advancing. */
  advanceEligible?: boolean;
}>;

const advanceReasons = new Set<ModelFallbackReason>([
  "rate_limit",
  "provider_unavailable",
  "content_policy_violation",
  "refusal",
  "request_timeout",
  "model_unavailable",
  "context_length",
  "transport_failure",
  "empty_response"
]);

export function shouldAdvanceModel(input: Readonly<{ reason: ModelFallbackReason; emittedOutput: boolean; advanceEligible?: boolean }>): boolean {
  return !input.emittedOutput && input.advanceEligible !== false && advanceReasons.has(input.reason);
}

export function configuredTextModels(plan: ProviderModelPlan): readonly string[] {
  const models = [plan.model, ...(plan.fallbackModels ?? [])]
    .map((model) => model.trim())
    .filter(Boolean);
  return [...new Set(models)];
}

export function routingStrategy(plan: ProviderModelPlan, configuredModels = configuredTextModels(plan)): ProviderModelRouting["strategy"] {
  if (plan.providerType === "openrouter" && plan.routingSource === "openrouter_preset") return "openrouter_preset_snapshot";
  if (plan.providerType === "openrouter" && configuredModels.length > 1) return "openrouter_native";
  if (configuredModels.length > 1) return "sequential";
  return "single";
}

/** An internal parsed terminal SSE event. Its public wrappers contain only the normalized fields below. */
export class ProviderSseTerminalError extends Error {
  constructor(readonly failure: NormalizedModelFailure) {
    super("The provider stream ended with a terminal error.");
    this.name = "ProviderSseTerminalError";
  }
}

export class ProviderModelFallbackExhaustedError extends Error {
  readonly code = "provider_model_fallback_exhausted";
  readonly statusCode = 502;
  readonly expose = true;
  readonly emittedOutput = false;

  constructor(
    readonly attempts: readonly ProviderModelAttempt[],
    readonly retryAfterMs?: number
  ) {
    super("The configured provider model plan could not complete.");
    this.name = "ProviderModelFallbackExhaustedError";
  }
}

export class ProviderStreamInterruptedError extends Error {
  readonly code = "provider_stream_interrupted";
  readonly statusCode = 502;
  readonly expose = true;
  readonly emittedOutput = true;

  constructor(
    readonly attempts: readonly ProviderModelAttempt[],
    readonly retryAfterMs?: number
  ) {
    super("The provider stream was interrupted after output began.");
    this.name = "ProviderStreamInterruptedError";
  }
}

function retryAfterMs(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined;
  if (typeof value !== "string") return undefined;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric >= 0) return Math.round(numeric * 1_000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

function withRetryHint(reason: ModelFallbackReason, value: unknown): NormalizedModelFailure {
  const retryAfter = retryAfterMs(value);
  return retryAfter === undefined ? { reason } : { reason, retryAfterMs: retryAfter };
}

function sseFailure(reason: ModelFallbackReason, retryAfter: unknown, advanceEligible: boolean): NormalizedModelFailure {
  const normalized = withRetryHint(reason, retryAfter);
  return { ...normalized, advanceEligible };
}

function errorChain(error: unknown): Record<string, unknown>[] {
  const chain: Record<string, unknown>[] = [];
  let current = error;
  for (let index = 0; index < 6 && typeof current === "object" && current !== null; index += 1) {
    chain.push(current as Record<string, unknown>);
    current = (current as { cause?: unknown }).cause;
  }
  return chain;
}

function reasonFromText(value: unknown): ModelFallbackReason | null {
  const text = String(value ?? "").toLowerCase();
  if (/rate.?limit|too many requests/.test(text)) return "rate_limit";
  if (/content.?policy|content.?filter/.test(text)) return "content_policy_violation";
  if (/refusal|refused/.test(text)) return "refusal";
  if (/context.?length|maximum context|token limit/.test(text)) return "context_length";
  if (/model.+(?:not found|unavailable)|no such model/.test(text)) return "model_unavailable";
  if (/timeout|timed out/.test(text)) return "request_timeout";
  if (/unavailable|overload|capacity/.test(text)) return "provider_unavailable";
  return null;
}

export function normalizeSseFailure(
  errorType: unknown,
  retryAfter?: unknown,
  context: Readonly<{ statusCode?: unknown; code?: unknown }> = {}
): NormalizedModelFailure {
  const machineType = typeof errorType === "string" ? errorType.trim().toLowerCase() : "";
  const code = typeof context.code === "string" ? context.code.trim().toLowerCase() : "";
  const statusValue = context.statusCode
    ?? (typeof context.code === "number" || (typeof context.code === "string" && /^\d+$/.test(context.code)) ? context.code : undefined)
    ?? (typeof errorType === "number" || /^\d+$/.test(machineType) ? errorType : undefined);
  const statusCode = Number(statusValue);

  if (["cancelled", "canceled", "aborted", "abort_err", "und_err_aborted"].includes(machineType)
    || ["cancelled", "canceled", "aborted", "abort_err", "und_err_aborted"].includes(code)) return sseFailure("cancelled", retryAfter, false);
  if (statusCode === 401 || statusCode === 403) return sseFailure("authentication", retryAfter, false);
  if (statusCode === 408 || statusCode === 504) return sseFailure("request_timeout", retryAfter, false);
  if (statusCode === 429) return sseFailure("rate_limit", retryAfter, true);
  if (Number.isFinite(statusCode) && statusCode >= 400 && statusCode < 500) return sseFailure("invalid_request", retryAfter, false);
  if (Number.isFinite(statusCode) && statusCode >= 500) return sseFailure("provider_unavailable", retryAfter, true);

  const terminalReasons: Readonly<Record<string, ModelFallbackReason>> = {
    authentication: "authentication",
    authentication_error: "authentication",
    unauthorized: "authentication",
    forbidden: "authentication",
    invalid_request: "invalid_request",
    invalid_request_error: "invalid_request",
    bad_request: "invalid_request",
    cancelled: "cancelled",
    canceled: "cancelled"
  };
  if (machineType in terminalReasons) return sseFailure(terminalReasons[machineType]!, retryAfter, false);

  const advanceReasonsByMachineType: Readonly<Record<string, ModelFallbackReason>> = {
    rate_limit: "rate_limit",
    rate_limited: "rate_limit",
    rate_limit_exceeded: "rate_limit",
    provider_overloaded: "provider_unavailable",
    provider_unavailable: "provider_unavailable",
    service_unavailable: "provider_unavailable",
    service_overloaded: "provider_unavailable"
  };
  const advanceReason = advanceReasonsByMachineType[machineType];
  if (advanceReason !== undefined) return sseFailure(advanceReason, retryAfter, true);

  const terminalSseReasons: Readonly<Record<string, ModelFallbackReason>> = {
    model_unavailable: "model_unavailable",
    model_not_found: "model_unavailable",
    context_length: "context_length",
    context_length_exceeded: "context_length",
    request_timeout: "request_timeout",
    timeout: "request_timeout",
    transport_failure: "transport_failure",
    content_policy_violation: "content_policy_violation",
    content_filter: "content_policy_violation",
    refusal: "refusal",
    empty_response: "empty_response"
  };
  const terminalReason = terminalSseReasons[machineType];
  return terminalReason === undefined
    ? sseFailure("unknown_failure", retryAfter, false)
    : sseFailure(terminalReason, retryAfter, false);
}

/** Converts provider failures into durable-safe routing facts without retaining upstream bodies or credentials. */
export function normalizeModelFailure(error: unknown): NormalizedModelFailure {
  if (error instanceof ProviderSseTerminalError) return error.failure;
  const chain = errorChain(error);
  const values = chain.flatMap((item) => [item.code, item.statusCode, item.providerErrorType, item.providerMessage, item.message]);
  const statusCode = chain.map((item) => Number(item.statusCode)).find(Number.isFinite);
  const retryHint = chain.map((item) => item.retryAfterMs).find((value) => retryAfterMs(value) !== undefined);
  if (values.some((value) => String(value) === "PROVIDER_DESTINATION_NOT_ALLOWED")) return { reason: "network_policy_denied" };
  if (values.some((value) => String(value) === "provider_response_too_large")) return { reason: "response_too_large" };
  if (values.some((value) => String(value) === "provider_request_cancelled" || String(value) === "ABORT_ERR" || String(value) === "UND_ERR_ABORTED")) return { reason: "cancelled" };
  if (values.some((value) => String(value) === "provider_request_timeout")) return { reason: "request_timeout" };
  if (values.some((value) => String(value) === "provider_transport_error")) return { reason: "transport_failure" };
  if (statusCode === 401 || statusCode === 403) return { reason: "authentication" };
  if (statusCode === 408 || statusCode === 504) return { reason: "request_timeout" };
  if (statusCode === 429) return withRetryHint("rate_limit", retryHint);
  const typedReason = chain
    .map((item) => reasonFromText(item.providerErrorType))
    .find((value): value is ModelFallbackReason => value !== null);
  if (typedReason) return withRetryHint(typedReason, retryHint);
  if (statusCode !== undefined && statusCode >= 400 && statusCode < 500) return { reason: "invalid_request" };
  if (statusCode !== undefined && statusCode >= 500) return withRetryHint("provider_unavailable", retryHint);
  const textReason = values.map(reasonFromText).find((value): value is ModelFallbackReason => value !== null);
  if (textReason) return withRetryHint(textReason, retryHint);
  if (statusCode === 400) return { reason: "invalid_request" };
  return { reason: "unknown_failure" };
}
