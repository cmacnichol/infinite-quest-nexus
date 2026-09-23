import { CAST_DISCOVERY_PROTOCOL, CAST_DISCOVERY_SYSTEM_PROMPT, bindFrozenResponseContractInvocationV2,
  assertDirectResponseContractRouteBasisAuthority, deriveTextExecutionPlan, readTextExecutionPlan } from "@infinite-quest/contracts";
import { CastDiscoveryExtractionError, type CastDiscoveryExecution, type CastDiscoveryExtractorPort } from "../../../packages/application/src/campaign-cast/discovery.js";
import { buildCastDiscoveryInput } from "../../../packages/domain/src/campaign-cast-discovery.js";
import { ContextBudgetError } from "../../../packages/story-engine/src/context-budget.js";
import { PreparedRouteTerminalError } from "../../../packages/story-engine/src/preset-route-execution.js";
import { estimatedInputSafetyAllowanceTokens, serializeCheckedBoundFrozenPresetProviderRequest, serializeCheckedProviderRequest } from "../../../packages/story-engine/src/provider-request.js";
import { estimateStoryTokens } from "../../../packages/story-engine/src/token-estimate.js";
import { prepareAuthoringTextExecution, prepareTextResponseContractAdmission, type DirectAuthoringTextPlanOptions, type PreparedAuthoringTextExecutor } from "./authoring-text-execution-preparation.js";
import { resolveGenerationResponseContractsV2 } from "./generation-response-contract.js";
import type { RuntimeTextExecution } from "./provider-credential-transport-adapter.js";
import type { TextExecutionPlanDiscoveryPorts } from "./provider-preset-resolution.js";

/** Called before acceptance, never inside its database transaction. Performs discovery but no generation. */
export async function prepareCastDiscoveryExecution(input: {
  ownerUserId: string; execution: RuntimeTextExecution; ports: TextExecutionPlanDiscoveryPorts;
  responseFormatCapabilities?: DirectAuthoringTextPlanOptions["responseFormatCapabilities"];
}): Promise<CastDiscoveryExecution> {
  if (input.execution.providerRole !== "text" || !["openrouter", "openai_compatible"].includes(input.execution.providerType)) {
    throw new Error("Cast discovery requires a schema-capable text provider.");
  }
  const execution = { ...input.execution, requestTimeoutMs: 30000 };
  const prepared = await prepareAuthoringTextExecution({ ownerUserId: input.ownerUserId, execution, ports: input.ports,
    protocolVersion: CAST_DISCOVERY_PROTOCOL, operationPrompts: { cast_discovery: CAST_DISCOVERY_SYSTEM_PROMPT } });
  const admission = prepareTextResponseContractAdmission({ execution, selection: prepared.routeBasis.selection,
    routeBasis: prepared.routeBasis, invocationKeys: ["cast_discovery:nonstream"], modelAdvertisements: prepared.modelAdvertisements,
    ...(input.responseFormatCapabilities === undefined ? {} : { capabilities: input.responseFormatCapabilities }) });
  const frozenResponseContracts = resolveGenerationResponseContractsV2({ queuedPolicy: admission.queuedPolicy,
    capabilityEvidenceHash: admission.capabilityEvidenceHash, ...(admission.eligible === undefined ? {} : { eligible: admission.eligible }) });
  return { providerProfileId: execution.id, plan: prepared.plans.cast_discovery!, admission: {
    routeBasis: prepared.routeBasis, frozenResponseContracts, providerType: execution.providerType as "openrouter" | "openai_compatible",
    configuration: structuredClone(execution.configuration) } };
}

export function createCastDiscoveryExtractor(input: { executor: PreparedAuthoringTextExecutor }): CastDiscoveryExtractorPort {
  return { async extract(claim) {
    const { admission } = claim.execution;
    const plan = readTextExecutionPlan(claim.execution.plan);
    if (!admission || plan.protocolVersion !== CAST_DISCOVERY_PROTOCOL || plan.requestTimeoutMs !== 30000) {
      throw new CastDiscoveryExtractionError("provider_failed");
    }
    if (plan.selection.kind === "model") {
      const basis = assertDirectResponseContractRouteBasisAuthority(admission.frozenResponseContracts.queuedPolicy, admission.routeBasis);
      if (deriveTextExecutionPlan(basis, CAST_DISCOVERY_SYSTEM_PROMPT).planHash !== plan.planHash) {
        throw new CastDiscoveryExtractionError("provider_failed");
      }
    }
    const request = { systemPrompt: plan.prompt, input: buildCastDiscoveryInput({ source: claim.source,
      knownCharacters: claim.identities.characters, worldCharacters: claim.identities.worldCharacters }) };
    const candidate = plan.candidates[0]!;
    const profile = { providerType: admission.providerType, baseUrl: "", model: candidate.modelId,
      contextWindowTokens: candidate.contextWindowTokens, maxOutputTokens: candidate.maxOutputTokens,
      temperature: plan.parameters.temperature ?? 0, requestTimeoutMs: 30000, configuration: admission.configuration };
    const binding = { frozen: admission.frozenResponseContracts, routeBasis: admission.routeBasis, plan,
      invocationKey: "cast_discovery:nonstream" as const, operation: "cast_discovery" as const, trustedOperationPrompt: CAST_DISCOVERY_SYSTEM_PROMPT };
    const checkedOptions = { inputLimit: candidate.contextWindowTokens - candidate.maxOutputTokens,
      count: estimateStoryTokens, countMode: "estimated" as const, safetyAllowanceTokens: estimatedInputSafetyAllowanceTokens,
      contextWindowTokens: candidate.contextWindowTokens, output: { kind: "story_append" as const } };
    try {
      const preparedRequest = plan.selection.kind === "openrouter_preset"
        ? serializeCheckedBoundFrozenPresetProviderRequest(profile, request, binding, checkedOptions)
        : serializeCheckedProviderRequest(profile, request, { ...checkedOptions, responseContract: bindFrozenResponseContractInvocationV2(binding) });
      const result = await input.executor.execute({ plan, routeBasis: admission.routeBasis, frozenResponseContracts: admission.frozenResponseContracts,
        ownerUserId: claim.scope.ownerUserId, providerProfileId: claim.execution.providerProfileId, operation: "cast_discovery",
        invocationKey: "cast_discovery:nonstream", trustedOperationPrompt: CAST_DISCOVERY_SYSTEM_PROMPT, request, preparedRequest,
        logicalReservation: { kind: "cast_discovery", ownerUserId: claim.scope.ownerUserId, jobId: claim.id,
          chunkOrdinal: claim.chunkOrdinal, claimAttempt: claim.attempt, ...(claim.retryGeneration ? { retryGeneration: claim.retryGeneration } : {}), leaseToken: claim.leaseToken } });
      if (result.outputLimited) return null;
      try { return JSON.parse(result.content) as unknown; } catch { return null; }
    } catch (error) {
      if (error instanceof ContextBudgetError) throw new CastDiscoveryExtractionError("source_requires_manual_scan");
      if (error instanceof PreparedRouteTerminalError && error.reason === "deadline") throw new CastDiscoveryExtractionError("provider_timeout");
      throw new CastDiscoveryExtractionError("provider_failed");
    }
  } };
}
