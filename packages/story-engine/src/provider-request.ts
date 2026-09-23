import { createHash } from "node:crypto";
import type { ProviderRequest, TextProviderProfile } from "./providers.js";
import { ContextBudgetError, assertOutputFeasible } from "./context-budget.js";
import { formatNarrationParagraphs } from "./narration-formatting.js";
import type { PreparedResponseContract, PreparedResponseContractV2 } from "../../contracts/src/text-response-format.js";
import { prepareResponseContract } from "./provider-response-format.js";
import {
  bindFrozenResponseContractInvocationV2,
  type FrozenResponseContractsV2,
  type ResponseContractOperationV2
} from "../../contracts/src/generation-response-contract.js";
import type { ResponseInvocationKeyV2 } from "../../contracts/src/text-response-format.js";
import {
  readTextExecutionPlan,
  readTextExecutionRouteBasis,
  type TextExecutionPlan,
  type TextExecutionRouteBasis,
  type TextGenerationParameters,
  type TextRouteCandidate
} from "../../contracts/src/text-execution-plan.js";

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
  responseContract?: PreparedResponseContract | PreparedResponseContractV2;
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
      /** The reviewer returns findings, never a StoryTurnOutput replacement. */
      kind: "continuity_review";
    }>
  | Readonly<{
      /** A repair may emit only the two unprotected choice fields. */
      kind: "story_choice_repair";
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
  responseContract?: PreparedResponseContract | PreparedResponseContractV2;
}>;

/**
 * The only serializer entry point that can emit a preset-trusted v2 contract.
 * It binds the entire durable closure, route basis, and derived plan at the
 * same request-preparation boundary that creates the transport bytes.
 */
export type BoundFrozenPresetProviderRequestBinding = Readonly<{
  frozen: FrozenResponseContractsV2;
  routeBasis: TextExecutionRouteBasis;
  plan: TextExecutionPlan;
  invocationKey: ResponseInvocationKeyV2;
  operation: ResponseContractOperationV2;
  trustedOperationPrompt: string;
  /** Zero-based frozen candidate selected by the durable route executor. */
  candidateOrdinal?: number;
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
function serializeProviderRequestInternal(
  profile: TextProviderProfile,
  request: CanonicalProviderRequest,
  options: ProviderRequestSerializationOptions = {},
  boundPreset?: Readonly<{
    contract: PreparedResponseContractV2;
    candidate: TextRouteCandidate;
    parameters: TextGenerationParameters;
  }>
): PreparedProviderRequest {
  const boundPresetContract = boundPreset?.contract;
  if ((options.responseContract || request.responseContract) && options.responseFormat !== undefined) throw new Error("A prepared response contract cannot use legacy response-format options.");
  if (options.responseContract && request.responseContract) throw new Error("A prepared response contract may be supplied only once.");
  const responseContract = boundPresetContract ?? (options.responseContract || request.responseContract
    ? prepareResponseContract(options.responseContract ?? request.responseContract)
    : null);
  if (boundPresetContract && (options.responseContract || request.responseContract)) {
    const supplied = prepareResponseContract(options.responseContract ?? request.responseContract);
    if (boundPresetContract.authority.kind !== "preset_trusted") {
      throw new Error("Bound frozen preset serialization requires preset-trusted authority.");
    }
    const boundAuthority = boundPresetContract.authority;
    const sameBoundPreset = supplied.version === 2 && supplied.admission.basis === "preset_trusted"
      && supplied.operation === boundPresetContract.operation && supplied.streaming === boundPresetContract.streaming
      && supplied.schemaHash === boundPresetContract.schemaHash && supplied.schemaVersion === boundPresetContract.schemaVersion
      && supplied.schemaName === boundPresetContract.schemaName && supplied.authority.kind === "preset_trusted"
      && supplied.authority.routeBasisHash === boundAuthority.routeBasisHash
      && supplied.authority.planHash === boundAuthority.planHash;
    if (!sameBoundPreset) {
      throw new Error("Prepared response contract does not match the bound frozen preset contract.");
    }
  }
  if (responseContract && responseContract.streaming !== Boolean(request.onChunk)) throw new Error("Prepared response contract streaming does not match the request.");
  if (responseContract && profile.providerType !== "openrouter" && profile.providerType !== "openai_compatible") {
    throw new Error("This provider adapter does not support prepared response contracts.");
  }
  if (responseContract?.version === 1 && responseContract.mode === "json_schema" && profile.providerType === "openrouter" && !responseContract.providerRoutingSlugs.length) {
    throw new Error("OpenRouter prepared response contracts require explicit provider routing.");
  }
  if (responseContract?.version === 1 && responseContract.mode === "json_schema" && profile.providerType !== "openrouter" && responseContract.providerRoutingSlugs.length) {
    throw new Error("Non-OpenRouter prepared response contracts cannot carry provider routing.");
  }
  if (responseContract?.version === 2 && responseContract.admission.basis === "preset_trusted" && !boundPresetContract) {
    throw new Error("Trusted preset response contracts require the frozen route executor.");
  }
  if (responseContract?.version === 2 && responseContract.authority.kind === "model_verified"
    && (profile.providerType !== responseContract.authority.providerType || profile.model !== responseContract.authority.model)) {
    throw new Error("Prepared v2 model response contract does not match the provider identity.");
  }
  const isRecovery = Boolean(request.recoveryInput);
  const frozenParameters = boundPreset?.parameters;
  const { temperature: frozenTemperature, max_tokens: _frozenMaxTokens, max_completion_tokens: _frozenMaxCompletionTokens,
    ...frozenOpenAiParameters } = frozenParameters ?? {};
  // An absent frozen value deliberately omits temperature and lets the
  // provider default apply; it never reads a later mutable profile default.
  const temperature = isRecovery ? 0.2 : frozenParameters ? frozenTemperature : profile.temperature;
  const rejectedResponse = completeRejectedDraftContent(request);
  const payload = profile.providerType === "lmstudio"
    ? {
        model: profile.model,
        input: recoveryInput(request),
        store: true,
        stream: Boolean(request.onChunk),
        ...(temperature === undefined ? {} : { temperature }),
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
        ...(temperature === undefined ? {} : { temperature }),
        max_tokens: profile.maxOutputTokens,
        ...frozenOpenAiParameters,
        ...(responseContract?.mode === "json_schema" ? {
          response_format: { type: "json_schema", json_schema: { name: responseContract.schemaName, strict: true, schema: responseContract.schema } },
          ...(profile.providerType === "openrouter" && responseContract.version === 1 ? { provider: { require_parameters: true, only: responseContract.providerRoutingSlugs } }
            : profile.providerType === "openrouter" && responseContract.version === 2 && responseContract.admission.basis === "model_verified"
              ? { provider: { require_parameters: true, only: responseContract.admission.verification.providerRoutingSlugs } } : {}),
          ...(profile.providerType === "openrouter" && responseContract.version === 2 && responseContract.admission.basis === "preset_trusted"
            && boundPreset
            ? { provider: { ...boundPreset.candidate.providerPolicy, require_parameters: true } } : {})
        } : responseContract?.mode === "json_object" ? { response_format: { type: "json_object" } } : options.responseFormat === false ? {} : { response_format: { type: "json_object" } }),
        ...(request.onChunk ? { stream: true, stream_options: { include_usage: true } } : {})
      };
  return prepare(payload, options);
}

/** Generic callers cannot serialize a bare preset-trusted response contract. */
export function serializeProviderRequest(
  profile: TextProviderProfile,
  request: CanonicalProviderRequest,
  options: ProviderRequestSerializationOptions = {}
): PreparedProviderRequest {
  return serializeProviderRequestInternal(profile, request, options);
}

function bindFrozenPresetProviderRequest(
  profile: TextProviderProfile,
  request: CanonicalProviderRequest,
  binding: BoundFrozenPresetProviderRequestBinding
): Readonly<{ contract: PreparedResponseContractV2; routeBasis: TextExecutionRouteBasis; plan: TextExecutionPlan; candidate: TextRouteCandidate }> {
  const routeBasis = readTextExecutionRouteBasis(binding.routeBasis);
  const plan = readTextExecutionPlan(binding.plan);
  const contract = bindFrozenResponseContractInvocationV2({ ...binding, routeBasis, plan });
  if (contract.authority.kind !== "preset_trusted" || contract.admission.basis !== "preset_trusted") {
    throw new Error("Frozen preset serializer requires preset-trusted v2 authority.");
  }
  if (routeBasis.selection.kind !== "openrouter_preset" || profile.providerType !== "openrouter") {
    throw new Error("Frozen preset serializer requires an OpenRouter preset route basis.");
  }
  const candidateOrdinal = binding.candidateOrdinal ?? 0;
  if (!Number.isSafeInteger(candidateOrdinal) || candidateOrdinal < 0) {
    throw new Error("Frozen preset candidate ordinal is invalid.");
  }
  const candidate = routeBasis.candidates[candidateOrdinal];
  if (!candidate || candidate.modelId !== profile.model) {
    throw new Error("Frozen preset serializer requires the selected frozen route candidate.");
  }
  if (request.systemPrompt !== plan.prompt) {
    throw new Error("Frozen preset request prompt does not match the derived frozen plan.");
  }
  return { contract, routeBasis, plan, candidate };
}

function frozenPresetProfile(profile: TextProviderProfile, candidate: TextRouteCandidate, parameters: TextGenerationParameters): TextProviderProfile {
  return {
    ...profile,
    model: candidate.modelId,
    contextWindowTokens: candidate.contextWindowTokens,
    maxOutputTokens: candidate.maxOutputTokens,
    // This required internal profile field is never read for a bound preset:
    // serializeProviderRequestInternal uses `parameters` and omits an absent
    // frozen temperature. Keep a neutral value here rather than reviving the
    // caller's mutable default.
    temperature: parameters.temperature ?? 0
  };
}

/**
 * Serializes one already-derived frozen preset candidate.  The generic
 * serializer remains fail-closed for preset-trusted contracts; this function
 * is deliberately the narrow executor-only alternative.
 */
export function serializeBoundFrozenPresetProviderRequest(
  profile: TextProviderProfile,
  request: CanonicalProviderRequest,
  binding: BoundFrozenPresetProviderRequestBinding,
  options: Omit<ProviderRequestSerializationOptions, "responseContract"> = {}
): PreparedProviderRequest {
  const bound = bindFrozenPresetProviderRequest(profile, request, binding);
  const candidate = bound.candidate;
  const frozenProfile = frozenPresetProfile(profile, candidate, bound.plan.parameters);
  return serializeProviderRequestInternal(frozenProfile, request, options, {
    contract: bound.contract, candidate, parameters: bound.plan.parameters
  });
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
  if (output.kind === "continuity_review") {
    return { version: "story-continuity-review-v1", verdict: "uncertain", findings: [] };
  }
  if (output.kind === "story_choice_repair") {
    return { choices: ["x", "x", "x", "x"], custom_action_suggestion: "x" };
  }
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

type ProviderRequestSerializer = (
  profile: TextProviderProfile,
  request: CanonicalProviderRequest,
  options?: ProviderRequestSerializationOptions
) => PreparedProviderRequest;

/** Serializes once for measurement and again for transport, preserving identical canonical bytes. */
function serializeCheckedProviderRequestWith(
  profile: TextProviderProfile,
  request: CanonicalProviderRequest,
  options: CheckedProviderRequestOptions,
  serialize: ProviderRequestSerializer
): PreparedProviderRequest {
  if ((options.responseContract || request.responseContract) && options.responseFormat !== undefined) {
    throw new Error("A prepared response contract cannot use legacy response-format options.");
  }
  if (options.responseContract && request.responseContract) {
    throw new Error("A prepared response contract may be supplied only once.");
  }
  const serializationOptions = options.responseContract ? { responseContract: options.responseContract }
    : options.responseFormat === undefined ? {} : { responseFormat: options.responseFormat };
  let serializedRequest = request;
  let candidate = serialize(profile, serializedRequest, serializationOptions);
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
    candidate = serialize(profile, serializedRequest, serializationOptions);
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
  return serialize(profile, serializedRequest, {
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

export function serializeCheckedProviderRequest(
  profile: TextProviderProfile,
  request: CanonicalProviderRequest,
  options: CheckedProviderRequestOptions
): PreparedProviderRequest {
  return serializeCheckedProviderRequestWith(profile, request, options, serializeProviderRequest);
}

/** The checked counterpart keeps budgeting and dispatch on the same bound preset bytes. */
export function serializeCheckedBoundFrozenPresetProviderRequest(
  profile: TextProviderProfile,
  request: CanonicalProviderRequest,
  binding: BoundFrozenPresetProviderRequestBinding,
  options: Omit<CheckedProviderRequestOptions, "responseContract">
): PreparedProviderRequest {
  const bound = bindFrozenPresetProviderRequest(profile, request, binding);
  const candidate = bound.candidate;
  const frozenProfile = frozenPresetProfile(profile, candidate, bound.plan.parameters);
  return serializeCheckedProviderRequestWith(frozenProfile, request, options, (candidateProfile, candidateRequest, serializationOptions) => {
    if (serializationOptions?.responseContract) {
      throw new Error("Bound frozen preset serialization cannot accept a caller-supplied response contract.");
    }
    return serializeProviderRequestInternal(candidateProfile, candidateRequest, serializationOptions, {
      contract: bound.contract, candidate, parameters: bound.plan.parameters
    });
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
