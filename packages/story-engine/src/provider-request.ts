import { createHash } from "node:crypto";
import type { ProviderRequest, TextProviderProfile } from "./providers.js";
import { ContextBudgetError, assertOutputFeasible } from "./context-budget.js";
import { formatNarrationParagraphs } from "./narration-formatting.js";

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

/** The legacy body serializer deliberately needs no endpoint or credential data. */
export type LegacyProviderRequestProfile = Readonly<Pick<
  TextProviderProfile,
  "providerType" | "model" | "maxOutputTokens" | "temperature"
>>;

export type ProviderOutputBudget =
  | Readonly<{
      kind: "story_append" | "story_replace";
    }>
  | Readonly<{
      kind: "event_extension";
      protectedStory: Readonly<{
        narration: string;
        scratchpad: string;
        continuitySummary: string;
        openThreads: readonly string[];
      }>;
      narrationCharacterLimit: number;
    }>;

export type CheckedProviderRequestOptions = Readonly<{
  inputLimit: number;
  count: (body: string) => number;
  countMode?: "estimated" | "exact";
  /** For estimated token counts, derive the input/transport uncertainty from the exact serialized body. */
  safetyAllowanceTokens?: number | ((requestTokens: number) => number);
  /** The effective job/provider ceiling used for output feasibility, when narrower than the profile. */
  contextWindowTokens?: number;
  output: ProviderOutputBudget;
  responseFormat?: boolean;
}>;

/** Conservative uncertainty for a serialized body when no compatible tokenizer is available. */
export function estimatedInputSafetyAllowanceTokens(requestTokens: number): number {
  return Math.ceil(requestTokens * 0.2) + 1_024;
}

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

const CLEAN_REGENERATION_REQUIREMENT = "CLEAN REGENERATION REQUIREMENT: Generate a complete replacement from the protected context. Do not reuse, quote, or refer to a rejected draft.";

function cleanRegenerationRequest(request: CanonicalProviderRequest): CanonicalProviderRequest {
  const { completeRejectedDraft: _completeRejectedDraft, recoveryInput: existingRecoveryInput, ...protectedRequest } = request;
  return {
    ...protectedRequest,
    recoveryInput: `${existingRecoveryInput ? `${existingRecoveryInput}\n\n` : ""}${CLEAN_REGENERATION_REQUIREMENT}`
  };
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

const MINIMUM_EVENT_EXTENSION_NARRATION = "x";

function eventExtensionMinimum(output: Extract<ProviderOutputBudget, { kind: "event_extension" }>) {
  const preservedNarration = formatNarrationParagraphs(output.protectedStory.narration);
  return {
    preservedNarration,
    appendedNarration: MINIMUM_EVENT_EXTENSION_NARRATION,
    narrationCharacterLimit: output.narrationCharacterLimit
  };
}

function outputSkeleton(output: ProviderOutputBudget): unknown {
  if (output.kind === "event_extension") {
    const extension = eventExtensionMinimum(output);
    return {
      narration: `${extension.preservedNarration}${extension.appendedNarration}`,
      choices: ["x", "x", "x", "x"],
      custom_action_suggestion: "x",
      scratchpad: output.protectedStory.scratchpad,
      tracker_updates: [],
      image_prompt: "",
      continuity_summary: output.protectedStory.continuitySummary,
      canonical_facts: [],
      superseded_facts: [],
      canonical_fact_updates: [],
      open_threads: output.protectedStory.openThreads
    };
  }
  return {
    narration: "x",
    choices: ["x", "x", "x", "x"],
    custom_action_suggestion: "x",
    scratchpad: "",
    tracker_updates: [],
    image_prompt: "",
    continuity_summary: "",
    canonical_facts: [],
    superseded_facts: [],
    canonical_fact_updates: [],
    open_threads: []
  };
}

/** Serializes once for measurement and again for transport, preserving identical canonical bytes. */
export function serializeCheckedProviderRequest(
  profile: TextProviderProfile,
  request: CanonicalProviderRequest,
  options: CheckedProviderRequestOptions
): PreparedProviderRequest {
  const serializationOptions = options.responseFormat === undefined ? {} : { responseFormat: options.responseFormat };
  let serializedRequest = request;
  let candidate = serializeProviderRequest(profile, serializedRequest, serializationOptions);
  let requestTokens = options.count(candidate.body);
  const safetyAllowanceFor = (tokens: number) => typeof options.safetyAllowanceTokens === "function"
    ? options.safetyAllowanceTokens(tokens)
    : options.safetyAllowanceTokens ?? 0;
  let safetyAllowanceTokens = safetyAllowanceFor(requestTokens);
  if (!Number.isFinite(requestTokens) || requestTokens < 0 || !Number.isInteger(safetyAllowanceTokens) || safetyAllowanceTokens < 0
      || !Number.isInteger(options.inputLimit) || options.inputLimit < 0) {
    throw new ContextBudgetError("context_budget_invalid", 0, 0);
  }
  if (requestTokens + safetyAllowanceTokens > options.inputLimit && completeRejectedDraftContent(request)) {
    serializedRequest = cleanRegenerationRequest(request);
    candidate = serializeProviderRequest(profile, serializedRequest, serializationOptions);
    requestTokens = options.count(candidate.body);
    safetyAllowanceTokens = safetyAllowanceFor(requestTokens);
    if (!Number.isFinite(requestTokens) || requestTokens < 0 || !Number.isInteger(safetyAllowanceTokens) || safetyAllowanceTokens < 0) {
      throw new ContextBudgetError("context_budget_invalid", 0, 0);
    }
  }
  if (requestTokens + safetyAllowanceTokens > options.inputLimit) {
    throw new ContextBudgetError("context_budget_exceeded", requestTokens + safetyAllowanceTokens, options.inputLimit, undefined, { scope: "provider_request" });
  }
  const extension = options.output.kind === "event_extension"
    ? eventExtensionMinimum(options.output)
    : undefined;
  assertOutputFeasible({
    inputTokens: requestTokens,
    contextWindowTokens: options.contextWindowTokens ?? profile.contextWindowTokens,
    outputReserveTokens: profile.maxOutputTokens,
    safetyAllowanceTokens,
    count: options.count,
    serializeOutput: JSON.stringify,
    output: outputSkeleton(options.output),
    ...(extension ? { extension } : {})
  });
  return serializeProviderRequest(profile, serializedRequest, {
    ...serializationOptions,
    budgetAudit: {
      countMode: options.countMode ?? "exact",
      requestTokens,
      inputLimit: options.inputLimit,
      outputReserveTokens: profile.maxOutputTokens,
      safetyAllowanceTokens
    }
  });
}

/**
 * Preserves pre-Task-7 caller framing, including optional LM Studio response
 * chains. New generation paths use serializeProviderRequest instead.
 */
export function serializeLegacyProviderRequest(
  profile: LegacyProviderRequestProfile,
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
