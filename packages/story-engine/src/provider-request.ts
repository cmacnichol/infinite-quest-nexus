import { createHash } from "node:crypto";
import type { ProviderRequest, TextProviderProfile } from "./providers.js";

export type ProviderRequestOperation = "story generation";

export type CompleteRejectedDraft = Readonly<{
  content: string;
  complete: true;
}>;

export type CanonicalProviderRequest = Readonly<
  Omit<ProviderRequest, "previousResponseId" | "rejectedResponse"> & {
    completeRejectedDraft?: CompleteRejectedDraft;
  }
>;

/** Task 5 supplies this text-free audit after measuring the serialized request. */
export type ProviderRequestBudgetAudit = Readonly<{
  countMode: "estimated" | "exact";
  requestTokens: number;
  inputLimit: number;
  outputReserveTokens: number;
  safetyAllowanceTokens: number;
}>;

export type PreparedProviderRequest = Readonly<{
  body: string;
  payloadHash: string;
  operation: ProviderRequestOperation;
  budgetAudit: ProviderRequestBudgetAudit | null;
}>;

export type ProviderRequestSerializationOptions = Readonly<{
  operation?: ProviderRequestOperation;
  budgetAudit?: ProviderRequestBudgetAudit | null;
  responseFormat?: boolean;
}>;

function prepare(
  payload: Record<string, unknown>,
  options: ProviderRequestSerializationOptions
): PreparedProviderRequest {
  const body = JSON.stringify(payload);
  const budgetAudit = options.budgetAudit ? Object.freeze({ ...options.budgetAudit }) : null;
  return Object.freeze({
    body,
    payloadHash: createHash("sha256").update(body).digest("hex"),
    operation: options.operation ?? "story generation",
    budgetAudit
  });
}

/** Returns a typed complete JSON draft, or null when the draft is partial. */
export function validateCompleteRejectedDraft(value: unknown): CompleteRejectedDraft | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const content = value.trim();
  try {
    const parsed = JSON.parse(content) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  } catch {
    return null;
  }
  return Object.freeze({ content, complete: true });
}

function completeRejectedDraftContent(request: CanonicalProviderRequest): string | null {
  const draft = request.completeRejectedDraft;
  if (!draft || draft.complete !== true) return null;
  return validateCompleteRejectedDraft(draft.content)?.content ?? null;
}

function recoveryInput(request: CanonicalProviderRequest): string {
  if (!request.recoveryInput) return request.input;
  const rejectedResponse = completeRejectedDraftContent(request);
  return `${request.input}${rejectedResponse ? `\n\nREJECTED RESPONSE TO REWRITE:\n${rejectedResponse}` : ""}\n\nRECOVERY REQUIREMENT:\n${request.recoveryInput}`;
}

/**
 * Produces the body used for both budgeting and transport. Recovery is
 * self-contained: remote response-chain IDs and callback functions are omitted.
 */
export function serializeProviderRequest(
  profile: TextProviderProfile,
  request: CanonicalProviderRequest,
  options: ProviderRequestSerializationOptions = {}
): PreparedProviderRequest {
  const isRecovery = Boolean(request.recoveryInput);
  const rejectedResponse = completeRejectedDraftContent(request);
  const payload = profile.providerType === "lmstudio"
    ? {
        model: profile.model,
        input: recoveryInput(request),
        store: true,
        stream: Boolean(request.onChunk),
        temperature: isRecovery ? 0.2 : profile.temperature,
        max_output_tokens: profile.maxOutputTokens,
        system_prompt: request.systemPrompt
      }
    : {
        model: profile.model,
        messages: [
          { role: "system", content: request.systemPrompt },
          { role: "user", content: request.input },
          ...(isRecovery && rejectedResponse
            ? [{ role: "assistant", content: rejectedResponse }]
            : []),
          ...(isRecovery ? [{ role: "user", content: request.recoveryInput! }] : [])
        ],
        temperature: isRecovery ? 0.2 : profile.temperature,
        max_tokens: profile.maxOutputTokens,
        ...(options.responseFormat === false ? {} : { response_format: { type: "json_object" } }),
        ...(request.onChunk ? { stream: true, stream_options: { include_usage: true } } : {})
      };
  return prepare(payload, options);
}

/**
 * Preserves pre-Task-7 caller framing, including optional LM Studio response
 * chains. New generation paths use serializeProviderRequest instead.
 */
export function serializeLegacyProviderRequest(
  profile: TextProviderProfile,
  request: ProviderRequest,
  options: ProviderRequestSerializationOptions = {}
): PreparedProviderRequest {
  const rejectedResponse = String(request.rejectedResponse || "").trim()
    .slice(0, Math.max(4_000, Math.min(80_000, profile.maxOutputTokens * 4)));
  if (profile.providerType === "lmstudio") {
    const payload: Record<string, unknown> = {
      model: profile.model,
      input: request.previousResponseId && request.recoveryInput
        ? request.recoveryInput
        : request.recoveryInput
          ? `${request.input}${rejectedResponse ? `\n\nREJECTED RESPONSE TO REWRITE:\n${rejectedResponse}` : ""}\n\nRECOVERY REQUIREMENT:\n${request.recoveryInput}`
          : request.input,
      store: true,
      stream: Boolean(request.onChunk),
      temperature: request.recoveryInput ? 0.2 : profile.temperature,
      max_output_tokens: profile.maxOutputTokens
    };
    if (request.previousResponseId) payload.previous_response_id = request.previousResponseId;
    else payload.system_prompt = request.systemPrompt;
    return prepare(payload, options);
  }
  return prepare({
    model: profile.model,
    messages: [
      { role: "system", content: request.systemPrompt },
      { role: "user", content: request.input },
      ...(request.recoveryInput ? [
        { role: "assistant", content: rejectedResponse || "The previous response was incomplete or invalid." },
        { role: "user", content: request.recoveryInput }
      ] : [])
    ],
    temperature: request.recoveryInput ? 0.2 : profile.temperature,
    max_tokens: profile.maxOutputTokens,
    ...(options.responseFormat === false ? {} : { response_format: { type: "json_object" } }),
    ...(request.onChunk ? { stream: true, stream_options: { include_usage: true } } : {})
  }, options);
}
