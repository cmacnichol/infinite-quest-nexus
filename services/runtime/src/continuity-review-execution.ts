import type { TextExecutionRouteBasis } from "../../../packages/contracts/src/text-execution-plan.js";
import {
  continuityReviewExecutionPolicySchema,
  continuityReviewExecutionSnapshotSchema,
  continuityReviewExecutionSnapshotHash,
  type ContinuityReviewExecutionPolicy,
  type ContinuityReviewExecutionSnapshot
} from "../../../packages/contracts/src/continuity-review-execution.js";
import { resolveTextExecutionRouteBasis, type TextExecutionPlanDiscoveryPorts, type TextExecutionPlanProfile } from "./provider-preset-resolution.js";
import type { FrozenResponseContractsV2 } from "../../../packages/contracts/src/generation-response-contract.js";
import { bindFrozenResponseContractInvocationV2 } from "../../../packages/contracts/src/generation-response-contract.js";
import { deriveTextExecutionPlan } from "./provider-preset-resolution.js";
import { estimatedInputSafetyAllowanceTokens, serializeCheckedBoundFrozenPresetProviderRequest, serializeCheckedProviderRequest } from "../../../packages/story-engine/src/provider-request.js";
import { estimateStoryTokens } from "../../../packages/story-engine/src/token-estimate.js";
import type { ProviderRequest } from "../../../packages/story-engine/src/providers.js";
import { effectiveRequestOutputTokens } from "../../../packages/story-engine/src/provider-request.js";

function frozenRoute(routeBasis: TextExecutionRouteBasis, providerType: string, contextWindowTokens?: number) {
  if (providerType !== "openrouter" && providerType !== "openai_compatible") throw new Error("Continuity reviewer execution requires a provider with verified structured output support.");
  const candidate = routeBasis.candidates[0];
  if (!candidate) throw new Error("A reviewer route must capture at least one candidate.");
  return {
    providerType: providerType as "openrouter" | "openai_compatible",
    routeBasis,
    effectiveContextWindowTokens: Math.min(candidate.contextWindowTokens, contextWindowTokens ?? candidate.contextWindowTokens),
    effectiveOutputTokens: candidate.maxOutputTokens
  };
}

/**
 * Binds and measures the reviewer request from the job's frozen reviewer
 * route.  It deliberately has no dependency on the writer route or writer
 * response-contract closure.
 */
export function prepareFrozenContinuityReviewRequest(
  route: NonNullable<ContinuityReviewExecutionSnapshot["primary"]>,
  request: ProviderRequest
) {
  const trustedOperationPrompt = route.routeBasis.selection.kind === "openrouter_preset"
    && route.routeBasis.presetSystemPrompt
    && request.systemPrompt.startsWith(`${route.routeBasis.presetSystemPrompt}\n\n`)
    ? request.systemPrompt.slice(route.routeBasis.presetSystemPrompt.length + 2)
    : request.systemPrompt;
  const plan = deriveTextExecutionPlan(route.routeBasis, trustedOperationPrompt);
  const contract = bindFrozenResponseContractInvocationV2({
    frozen: route.responseContracts,
    invocationKey: "continuity_review:nonstream",
    operation: "story_continuity_review",
    routeBasis: route.routeBasis,
    plan,
    trustedOperationPrompt
  });
  const boundRequest = { ...request, systemPrompt: plan.prompt, responseContract: contract };
  const canonical = {
    systemPrompt: boundRequest.systemPrompt,
    input: boundRequest.input,
    ...(boundRequest.budgetOutput ? { budgetOutput: boundRequest.budgetOutput } : {})
  };
  const profile = {
    providerType: route.providerType,
    baseUrl: "",
    model: route.routeBasis.candidates[0]!.modelId,
    contextWindowTokens: route.effectiveContextWindowTokens,
    maxOutputTokens: route.effectiveOutputTokens,
    temperature: route.routeBasis.parameters.temperature ?? 0,
    requestTimeoutMs: route.routeBasis.requestTimeoutMs,
    configuration: {}
  };
  const checked = {
    inputLimit: route.effectiveContextWindowTokens - effectiveRequestOutputTokens(route.effectiveOutputTokens, boundRequest),
    count: estimateStoryTokens,
    countMode: "estimated" as const,
    safetyAllowanceTokens: estimatedInputSafetyAllowanceTokens,
    contextWindowTokens: route.effectiveContextWindowTokens,
    output: boundRequest.budgetOutput ?? { kind: "continuity_review" as const }
  };
  const preparedRequest = route.routeBasis.selection.kind === "openrouter_preset"
    ? serializeCheckedBoundFrozenPresetProviderRequest(profile, canonical, {
      frozen: route.responseContracts, routeBasis: route.routeBasis, plan,
      invocationKey: "continuity_review:nonstream", operation: "story_continuity_review",
      trustedOperationPrompt
    }, checked)
    : serializeCheckedProviderRequest(profile, canonical, { ...checked, responseContract: contract });
  return { plan, request: boundRequest, preparedRequest, contract, trustedOperationPrompt };
}

/** Resolves selected reviewer routes with the writer profile's endpoint and credential authority. */
export async function resolveContinuityReviewExecution(input: Readonly<{
  profile: TextExecutionPlanProfile;
  policy: ContinuityReviewExecutionPolicy;
  ports: TextExecutionPlanDiscoveryPorts;
  prepareResponseContracts(routeBasis: TextExecutionRouteBasis, selection: ContinuityReviewExecutionPolicy["primary"]["selection"]): Promise<FrozenResponseContractsV2>;
}>): Promise<ContinuityReviewExecutionSnapshot> {
  const policy = continuityReviewExecutionPolicySchema.parse(input.policy);
  const resolve = async (selection: ContinuityReviewExecutionPolicy["primary"]) => {
    const routeBasis = await resolveTextExecutionRouteBasis({
      profile: { ...input.profile, protocolVersion: "continuity-review-route-basis-v1", ...(input.profile.providerType === "openrouter" ? { presetRouting: "openrouter" as const } : {}) },
      overrides: { ...(selection.overrides?.parameters === undefined ? {} : { parameters: selection.overrides.parameters }),
        ...(selection.overrides?.conservativeContextWindowTokens === undefined ? {} : { conservativeContextWindowTokens: selection.overrides.conservativeContextWindowTokens }),
        selection: selection.selection },
      ports: input.ports
    });
    const responseContracts = await input.prepareResponseContracts(routeBasis, selection.selection);
    return { ...frozenRoute(routeBasis, input.profile.providerType, selection.overrides?.conservativeContextWindowTokens), responseContracts };
  };
  const primary = await resolve(policy.primary);
  const fallback = policy.fallback ? await resolve(policy.fallback) : null;
  const snapshot = { version: 1 as const, enabled: true, maximumAutomaticFallbacks: policy.maximumAutomaticFallbacks, primary, fallback };
  return continuityReviewExecutionSnapshotSchema.parse({ ...snapshot, snapshotHash: continuityReviewExecutionSnapshotHash(snapshot) });
}

export function disabledContinuityReviewExecution(): ContinuityReviewExecutionSnapshot {
  const snapshot = { version: 1 as const, enabled: false, maximumAutomaticFallbacks: 0 as const, primary: null, fallback: null };
  return continuityReviewExecutionSnapshotSchema.parse({ ...snapshot, snapshotHash: continuityReviewExecutionSnapshotHash(snapshot) });
}
