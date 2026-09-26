import {
  authoringResponseContractIdentity,
  authoringTextOperationV2Schema,
  directAuthoringResponseContractIdentity,
  directAuthoringTextOperationV2Schema,
  deriveTextExecutionPlan,
  getProviderOutputSchemaV2,
  type AuthoringTextOperation,
  type AuthoringTextOperationV2,
  type DirectAuthoringTextOperationV2,
  type FrozenResponseContractsV2,
  type ModelParameterAdvertisement,
  type ProviderOutputSchemaOperationV2,
  type ResponseContractOperationV2,
  type ResponseFormatEligibilityV2,
  type ResponseInvocationKeyV2,
  type TextExecutionPlan,
  type TextExecutionRouteBasis,
  type TextExecutionOverrides,
  type TextModelSelection,
  type PhysicalTextAccounting,
  physicalTextAccountingSchema
} from "@infinite-quest/contracts";
import { randomUUID } from "node:crypto";
import { resolveResponseContractAdmission } from "../../../packages/application/src/providers/response-format.js";
import {
  assertDirectResponseContractRouteBasisAuthority,
  bindFrozenResponseContractInvocationV2,
  type QueuedResponsePolicyV2
} from "../../../packages/contracts/src/generation-response-contract.js";
import { effectiveProviderConfigurationFingerprint } from "../../../packages/contracts/src/story-memory-policy.js";
import {
  estimatedInputSafetyAllowanceTokens,
  serializeBoundFrozenPresetProviderRequest,
  serializeCheckedBoundFrozenPresetProviderRequest,
  serializeCheckedProviderRequest,
  serializeProviderRequest,
  validateCompleteRejectedDraft,
  type CanonicalProviderRequest,
  type PreparedProviderRequest
} from "../../../packages/story-engine/src/provider-request.js";
import type { ProviderRequest, ProviderResult, TextProviderProfile } from "../../../packages/story-engine/src/providers.js";
import type { LogicalReservation, PhysicalAttemptAccountingScope, PhysicalAttemptAccountingSummary } from "../../../packages/story-engine/src/preset-route-execution.js";
import { estimateStoryTokens } from "../../../packages/story-engine/src/token-estimate.js";
import { capabilityRouteConfigHash } from "./provider-capability-cache.js";
import type { ProviderResponseFormatCapabilities } from "./provider-response-format-capabilities.js";
import { resolveGenerationResponseContractsV2 } from "./generation-response-contract.js";
import { resolveTextExecutionPlans, type TextExecutionPlanDiscoveryPorts } from "./provider-preset-resolution.js";
import type { RuntimeTextExecution } from "./provider-credential-transport-adapter.js";
import { resolveEffectiveTextExecutionOverrides } from "./text-execution-overrides.js";

export type PreparedTextExecutionOperation = ResponseContractOperationV2 | AuthoringTextOperation
  | "organizer" | "organizerRepair" | "illustrationPromptRefinement";

export type PreparedAuthoringTextExecutor = Readonly<{
  summarize?(scope: PhysicalAttemptAccountingScope): Promise<PhysicalAttemptAccountingSummary>;
  execute(input: Readonly<{
    plan: TextExecutionPlan;
    operation: PreparedTextExecutionOperation;
    ownerUserId: string;
    providerProfileId: string;
    request: ProviderRequest;
    /** Exact canonical body already measured and durably reserved by the caller. */
    preparedRequest?: PreparedProviderRequest;
    currentClaim?: () => Promise<boolean>;
    invocationKey?: ResponseInvocationKeyV2;
    frozenResponseContracts?: FrozenResponseContractsV2;
    routeBasis?: TextExecutionRouteBasis;
    trustedOperationPrompt?: string;
    /** Required by the production prepared executor; Task 5C binds non-Story callers. */
    logicalReservation?: LogicalReservation;
    /** Header-only: sends X-OpenRouter-Cache: false; never alters the hashed body. */
    bypassResponseCache?: boolean;
  }>): Promise<ProviderResult>;
}>;

/** Runtime-owned capabilities for optional native direct-consumer execution. */
export type DirectAuthoringTextPlanOptions = Readonly<{
  nativePresetPlansEnabled?: boolean;
  preparedExecutor?: PreparedAuthoringTextExecutor;
  /** Reloads only current owner/profile authority before each paid dispatch. */
  loadAuthority?(input: Readonly<{ ownerUserId: string; providerProfileId: string }>): Promise<Pick<RuntimeTextExecution, "id" | "providerRole" | "authorityRevision" | "endpointIdentity">>;
  ports: TextExecutionPlanDiscoveryPorts;
  responseFormatCapabilities?: Pick<ProviderResponseFormatCapabilities, "registryDigest" | "now" | "eligibilityV2">;
}>;

export type PreparedDirectAuthoringTextExecution = Readonly<{
  execute(input: Readonly<{ operation: DirectAuthoringTextOperationV2; request: ProviderRequest }>): Promise<ProviderResult>;
  readAccounting?(): Promise<PhysicalTextAccounting | null>;
}>;

export type PreparedAuthoringTextPlans = Readonly<{
  routeBasis: TextExecutionRouteBasis;
  plans: Readonly<Record<string, TextExecutionPlan>>;
  modelAdvertisements: Readonly<Record<string, ModelParameterAdvertisement | null>>;
}>;

/** Private one-read preparation seam shared by durable and direct authoring. */
export async function prepareAuthoringTextExecution(input: Readonly<{
  ownerUserId: string;
  execution: RuntimeTextExecution;
  operationPrompts: Readonly<Record<string, string>>;
  ports: TextExecutionPlanDiscoveryPorts;
  selectionOverride?: TextModelSelection;
  textExecutionOverrides?: TextExecutionOverrides | null;
  protocolVersion?: string;
}>): Promise<PreparedAuthoringTextPlans> {
  if (!input.execution.authorityRevision || !input.execution.executionRevision) {
    throw new Error("Authoring v2 preparation requires current execution and authority revisions.");
  }
  const selection = input.selectionOverride ?? input.execution.textSelection ?? { kind: "model" as const, modelId: input.execution.model };
  const overrides = resolveEffectiveTextExecutionOverrides({
    execution: input.execution,
    selection,
    ...(input.textExecutionOverrides === undefined ? {} : { requestOverrides: input.textExecutionOverrides })
  });
  const resolved = await resolveTextExecutionPlans({
    profile: { ownerUserId: input.ownerUserId, providerProfileId: input.execution.id, profileRevision: input.execution.executionRevision, authorityRevision: input.execution.authorityRevision, providerType: input.execution.providerType, selection, contextWindowTokens: input.execution.contextWindowTokens, maxOutputTokens: input.execution.maxOutputTokens, requestTimeoutMs: input.execution.requestTimeoutMs, parameters: { temperature: input.execution.temperature }, endpointReference: input.execution.endpointIdentity ?? input.execution.id, credentialReference: input.execution.id, protocolVersion: input.protocolVersion ?? "authoring-text-plan-v2" },
    operationPrompts: input.operationPrompts,
    ...(overrides === undefined ? {} : { overrides }),
    ports: input.ports
  });
  return resolved;
}

function frozenProfile(
  execution: Pick<RuntimeTextExecution, "providerType" | "configuration">,
  routeBasis: TextExecutionRouteBasis
): TextProviderProfile {
  const candidate = routeBasis.candidates[0];
  if (!candidate) throw new Error("Native authoring route has no frozen candidate.");
  return {
    providerType: execution.providerType,
    baseUrl: "",
    model: candidate.modelId,
    contextWindowTokens: candidate.contextWindowTokens,
    maxOutputTokens: candidate.maxOutputTokens,
    temperature: routeBasis.parameters.temperature ?? 0,
    requestTimeoutMs: routeBasis.requestTimeoutMs,
    configuration: execution.configuration
  };
}

function canonicalAuthoringRequest(request: ProviderRequest): CanonicalProviderRequest {
  const completeRejectedDraft = validateCompleteRejectedDraft(request.rejectedResponse);
  return {
    systemPrompt: request.systemPrompt,
    input: request.input,
    ...(request.recoveryInput ? { recoveryInput: request.recoveryInput } : {}),
    ...(completeRejectedDraft ? { completeRejectedDraft } : {}),
    ...(request.onChunk ? { onChunk: request.onChunk } : {})
  };
}

export function prepareTextResponseContractAdmission(input: Readonly<{
  execution: RuntimeTextExecution;
  selection: TextModelSelection;
  routeBasis: TextExecutionRouteBasis;
  invocationKeys: readonly ResponseInvocationKeyV2[];
  modelAdvertisements: Readonly<Record<string, ModelParameterAdvertisement | null>>;
  capabilities?: DirectAuthoringTextPlanOptions["responseFormatCapabilities"];
}>): Readonly<{
  queuedPolicy: QueuedResponsePolicyV2;
  eligible?: (operation: ProviderOutputSchemaOperationV2, streaming: boolean) => ResponseFormatEligibilityV2;
  capabilityEvidenceHash: string;
}> {
  const { execution, selection, routeBasis } = input;
  if (!execution.authorityRevision || !execution.executionRevision) {
    throw new Error("Authoring v2 preparation requires current execution and authority revisions.");
  }
  if (selection.kind === "openrouter_preset") {
    return {
      queuedPolicy: {
        version: 2, policy: "required", providerProfileId: execution.id,
        admission: { mode: "json_schema", basis: "preset_trusted" },
        authority: {
          kind: "preset_trusted", routeBasisHash: routeBasis.routeBasisHash,
          selection, endpointReference: routeBasis.endpointReference,
          credentialReference: routeBasis.credentialReference,
          authorityRevision: execution.authorityRevision, profileRevision: execution.executionRevision
        },
        operationClosureVersion: 2, invocationKeys: [...input.invocationKeys]
      },
      capabilityEvidenceHash: routeBasis.routeBasisHash
    };
  }
  const capabilities = input.capabilities;
  if (!capabilities) throw new Error("Direct-model authoring requires response-contract capability verification.");
  const providerType = execution.providerType;
  if (providerType !== "openrouter" && providerType !== "openai_compatible") {
    throw new Error("Direct-model authoring requires a response-contract capable provider.");
  }
  const routeConfigHash = capabilityRouteConfigHash(execution.configuration);
  const eligible = (operation: ProviderOutputSchemaOperationV2, streaming: boolean) => capabilities.eligibilityV2({
    advertisement: input.modelAdvertisements[selection.modelId] ?? null,
    providerType,
    endpointIdentity: execution.endpointIdentity ?? "",
    model: selection.modelId,
    routeConfigHash,
    adapterProtocol: "text-schema-adapter-v2",
    operation,
    schemaHash: getProviderOutputSchemaV2(operation).schemaHash,
    streaming,
    now: capabilities.now(),
    expectedRegistryDigest: capabilities.registryDigest
  });
  const firstKey = input.invocationKeys[0];
  if (!firstKey) throw new Error("Direct authoring requires a response-contract invocation.");
  const [firstOperation] = firstKey.split(":") as [ProviderOutputSchemaOperationV2];
  const admission = resolveResponseContractAdmission({ selection, directEligibility: () => eligible(firstOperation, false) });
  const candidate = routeBasis.candidates[0];
  if (!candidate || candidate.modelId !== selection.modelId) throw new Error("Direct authoring route does not match its selected Model.");
  return {
    queuedPolicy: {
      version: 2, policy: "required", providerProfileId: execution.id, admission,
      authority: {
        kind: "model_verified", providerProfileId: execution.id, providerType,
        endpointIdentity: execution.endpointIdentity ?? "", model: selection.modelId,
        providerConfigurationHash: effectiveProviderConfigurationFingerprint({
          providerId: execution.id, providerType: execution.providerType,
          endpointIdentity: execution.endpointIdentity ?? "", model: selection.modelId,
          contextWindowTokens: candidate.contextWindowTokens, maxOutputTokens: candidate.maxOutputTokens,
          temperature: routeBasis.parameters.temperature ?? 0, requestTimeoutMs: routeBasis.requestTimeoutMs,
          configuration: execution.configuration, effectiveContextWindowTokens: candidate.contextWindowTokens,
          inputSafetyPolicy: "estimated_20_percent_plus_1024"
        }),
        routeConfigHash, verificationRegistryHash: capabilities.registryDigest,
        authorityRevision: execution.authorityRevision, routeBasisHash: routeBasis.routeBasisHash
      },
      operationClosureVersion: 2, invocationKeys: [...input.invocationKeys]
    },
    eligible,
    capabilityEvidenceHash: capabilities.registryDigest
  };
}

export type PreparedAuthoringResponseContractExecution = PreparedAuthoringTextPlans & Readonly<{
  frozenResponseContracts: FrozenResponseContractsV2;
  trustedOperationPrompts: Readonly<Partial<Record<AuthoringTextOperationV2, string>>>;
}>;

/** Resolves one immutable authoring route and freezes its complete operation closure. */
export async function prepareAuthoringResponseContractExecution(input: Readonly<{
  ownerUserId: string;
  execution: RuntimeTextExecution;
  operationPrompts: Readonly<Partial<Record<AuthoringTextOperationV2, string>>>;
  ports: TextExecutionPlanDiscoveryPorts;
  selectionOverride?: TextModelSelection;
  textExecutionOverrides?: TextExecutionOverrides | null;
  responseFormatCapabilities?: DirectAuthoringTextPlanOptions["responseFormatCapabilities"];
}>): Promise<PreparedAuthoringResponseContractExecution> {
  const selection = input.selectionOverride ?? input.execution.textSelection
    ?? { kind: "model" as const, modelId: input.execution.model };
  const promptEntries = Object.entries(input.operationPrompts).map(([operationValue, prompt]) => {
    const operation = authoringTextOperationV2Schema.parse(operationValue);
    if (typeof prompt !== "string" || !prompt.trim()) throw new Error(`Native authoring prompt is missing operation '${operation}'.`);
    return [operation, prompt.trim()] as const;
  });
  if (!promptEntries.length) throw new Error("Native authoring preparation requires at least one operation.");
  const prepared = await prepareAuthoringTextExecution({
    ownerUserId: input.ownerUserId,
    execution: input.execution,
    operationPrompts: Object.fromEntries(promptEntries),
    ports: input.ports,
    selectionOverride: selection,
    ...(input.textExecutionOverrides === undefined ? {} : { textExecutionOverrides: input.textExecutionOverrides })
  });
  const invocationKeys = [...new Set(promptEntries.map(([operation]) => authoringResponseContractIdentity(operation).invocationKey))];
  const contractPreparation = prepareTextResponseContractAdmission({
    execution: input.execution,
    selection,
    routeBasis: prepared.routeBasis,
    invocationKeys,
    modelAdvertisements: prepared.modelAdvertisements,
    ...(input.responseFormatCapabilities === undefined ? {} : { capabilities: input.responseFormatCapabilities })
  });
  const frozenResponseContracts = resolveGenerationResponseContractsV2({
    queuedPolicy: contractPreparation.queuedPolicy,
    ...(contractPreparation.eligible === undefined ? {} : { eligible: contractPreparation.eligible }),
    capabilityEvidenceHash: contractPreparation.capabilityEvidenceHash
  });
  return Object.freeze({
    ...prepared,
    frozenResponseContracts,
    trustedOperationPrompts: Object.freeze(Object.fromEntries(promptEntries))
  });
}

type PreparedAuthoringSerializationInput = Readonly<{
  execution: Pick<RuntimeTextExecution, "providerType" | "configuration">;
  prepared: PreparedAuthoringResponseContractExecution;
  operation: AuthoringTextOperationV2;
  request: ProviderRequest;
}>;

function authoringSerializationContext(input: PreparedAuthoringSerializationInput) {
  const identity = authoringResponseContractIdentity(input.operation);
  const plan = input.prepared.plans[input.operation];
  const trustedOperationPrompt = input.prepared.trustedOperationPrompts[input.operation];
  if (!plan || !trustedOperationPrompt) throw new Error(`Native authoring plan is missing operation '${input.operation}'.`);
  const request = { ...input.request, systemPrompt: plan.prompt };
  const canonicalRequest = canonicalAuthoringRequest(request);
  const profile = frozenProfile(input.execution, input.prepared.routeBasis);
  const binding = {
    frozen: input.prepared.frozenResponseContracts,
    routeBasis: input.prepared.routeBasis,
    plan,
    invocationKey: identity.invocationKey,
    operation: identity.operation,
    trustedOperationPrompt
  };
  return { canonicalRequest, profile, binding };
}

/**
 * Capacity-unchecked canonical rendering for source chunk search.  It binds
 * the exact schema, route, plan and trusted prompt used at dispatch; only the
 * selected chunk proceeds to checked admission.
 */
export function renderPreparedAuthoringRequest(input: PreparedAuthoringSerializationInput): PreparedProviderRequest {
  const { canonicalRequest, profile, binding } = authoringSerializationContext(input);
  return input.prepared.routeBasis.selection.kind === "openrouter_preset"
    ? serializeBoundFrozenPresetProviderRequest(profile, canonicalRequest, binding)
    : serializeProviderRequest(profile, canonicalRequest, {
      responseContract: bindFrozenResponseContractInvocationV2(binding)
    });
}

/** Canonical checked serialization shared by selected source chunks, durable dispatch and illustration refinement. */
export function serializePreparedAuthoringRequest(input: PreparedAuthoringSerializationInput): PreparedProviderRequest {
  const { canonicalRequest, profile, binding } = authoringSerializationContext(input);
  const candidate = input.prepared.routeBasis.candidates[0]!;
  const checkedOptions = {
    inputLimit: candidate.contextWindowTokens - candidate.maxOutputTokens,
    count: estimateStoryTokens,
    countMode: "estimated" as const,
    safetyAllowanceTokens: estimatedInputSafetyAllowanceTokens,
    contextWindowTokens: candidate.contextWindowTokens,
    output: input.request.budgetOutput ?? { kind: "story_append" as const }
  };
  return input.prepared.routeBasis.selection.kind === "openrouter_preset"
    ? serializeCheckedBoundFrozenPresetProviderRequest(profile, canonicalRequest, binding, checkedOptions)
    : serializeCheckedProviderRequest(profile, canonicalRequest, {
      ...checkedOptions,
      responseContract: bindFrozenResponseContractInvocationV2(binding)
    });
}

/**
 * Prepares one direct workflow and carries exact route, schema, plan, and body
 * identity to the route executor. Local semantic validators and repair remain
 * owned by the caller.
 */
export async function prepareDirectAuthoringTextExecution(input: Readonly<{
  ownerUserId: string;
  execution: RuntimeTextExecution;
  operationPrompts: Readonly<Partial<Record<DirectAuthoringTextOperationV2, string>>>;
  options?: DirectAuthoringTextPlanOptions;
  selectionOverride?: TextModelSelection;
  textExecutionOverrides?: TextExecutionOverrides | null;
}>): Promise<PreparedDirectAuthoringTextExecution | null> {
  const options = input.options;
  const selection = input.selectionOverride ?? input.execution.textSelection
    ?? { kind: "model" as const, modelId: input.execution.model };
  if (options?.nativePresetPlansEnabled !== true) {
    if (selection.kind === "openrouter_preset") {
      throw Object.assign(new Error("Native text execution is unavailable for this OpenRouter preset."), {
        code: "native_text_execution_unavailable", statusCode: 409
      });
    }
    return null;
  }
  if (!options.preparedExecutor || !options.loadAuthority) {
    if (selection.kind === "openrouter_preset") {
      throw Object.assign(new Error("Native text execution is unavailable for this OpenRouter preset."), {
        code: "native_text_execution_unavailable", statusCode: 409
      });
    }
    throw new Error("Native authoring execution is unavailable.");
  }
  const promptEntries = Object.entries(input.operationPrompts).map(([operation, prompt]) => {
    const typedOperation = directAuthoringTextOperationV2Schema.parse(operation);
    if (typeof prompt !== "string" || !prompt.trim()) throw new Error(`Native authoring prompt is missing operation '${operation}'.`);
    return [typedOperation, prompt.trim()] as const;
  });
  if (!promptEntries.length) throw new Error("Native authoring preparation requires at least one operation.");
  const prepared = await prepareAuthoringTextExecution({
    ownerUserId: input.ownerUserId, execution: input.execution,
    operationPrompts: Object.fromEntries(promptEntries), ports: options.ports,
    selectionOverride: selection,
    ...(input.textExecutionOverrides === undefined ? {} : { textExecutionOverrides: input.textExecutionOverrides })
  });
  const invocationKeys = [...new Set(promptEntries.map(([operation]) => directAuthoringResponseContractIdentity(operation).invocationKey))];
  const contractPreparation = prepareTextResponseContractAdmission({
    execution: input.execution, selection, routeBasis: prepared.routeBasis,
    invocationKeys, modelAdvertisements: prepared.modelAdvertisements,
    ...(options.responseFormatCapabilities === undefined ? {} : { capabilities: options.responseFormatCapabilities })
  });
  const frozenResponseContracts = resolveGenerationResponseContractsV2({
    queuedPolicy: contractPreparation.queuedPolicy,
    ...(contractPreparation.eligible === undefined ? {} : { eligible: contractPreparation.eligible }),
    capabilityEvidenceHash: contractPreparation.capabilityEvidenceHash
  });
  const trustedPrompts = Object.freeze(Object.fromEntries(promptEntries));
  const repairOperations = new Set<DirectAuthoringTextOperationV2>([
    "worldOutlineRepair", "seedCharacterRepair", "standaloneCharacterRepair", "organizerRepair"
  ]);
  const requestScopeId = randomUUID();
  const activeInvocations = new Map<string, string>();
  return Object.freeze({
    readAccounting: async () => {
      if (!options.preparedExecutor?.summarize) return null;
      try {
        const summary = await options.preparedExecutor.summarize({
          kind: "job", ownerUserId: input.ownerUserId, logicalKind: "direct", scopeId: requestScopeId
        });
        return summary.attemptCount ? physicalTextAccountingSchema.parse(summary) : null;
      } catch {
        return null;
      }
    },
    execute: async ({ operation, request }) => {
      const identity = directAuthoringResponseContractIdentity(operation);
      const plan = prepared.plans[operation];
      const trustedOperationPrompt = trustedPrompts[operation];
      if (!plan || !trustedOperationPrompt) throw new Error(`Native authoring plan is missing operation '${operation}'.`);
      const repair = repairOperations.has(operation);
      const operationFamily = operation.replace(/Repair$/u, "");
      if (!repair || !activeInvocations.has(operationFamily)) {
        activeInvocations.set(operationFamily, randomUUID());
      }
      const invocationId = activeInvocations.get(operationFamily)!;
      const authority = await options.loadAuthority!({ ownerUserId: input.ownerUserId, providerProfileId: input.execution.id });
      if (authority.id !== input.execution.id || authority.providerRole !== "text"
        || authority.authorityRevision !== plan.authorityRevision
        || authority.endpointIdentity !== input.execution.endpointIdentity) {
        throw new Error("Native authoring provider authority is unavailable.");
      }
      const executorRequest = { ...request, systemPrompt: plan.prompt };
      const canonicalRequest = canonicalAuthoringRequest(executorRequest);
      const profile = frozenProfile(input.execution, prepared.routeBasis);
      const candidate = prepared.routeBasis.candidates[0]!;
      const checkedOptions = {
        inputLimit: candidate.contextWindowTokens - candidate.maxOutputTokens,
        count: estimateStoryTokens,
        countMode: "estimated" as const,
        safetyAllowanceTokens: estimatedInputSafetyAllowanceTokens,
        contextWindowTokens: candidate.contextWindowTokens,
        output: request.budgetOutput ?? { kind: "story_append" as const }
      };
      if (selection.kind === "model") {
        assertDirectResponseContractRouteBasisAuthority(frozenResponseContracts.queuedPolicy, prepared.routeBasis);
        if (deriveTextExecutionPlan(prepared.routeBasis, trustedOperationPrompt).planHash !== plan.planHash) {
          throw new Error("Direct response-contract basis or plan identity changed.");
        }
      }
      const preparedRequest = selection.kind === "openrouter_preset"
        ? serializeCheckedBoundFrozenPresetProviderRequest(profile, canonicalRequest, {
          frozen: frozenResponseContracts, routeBasis: prepared.routeBasis, plan,
          invocationKey: identity.invocationKey, operation: identity.operation,
          trustedOperationPrompt
        }, checkedOptions)
        : serializeCheckedProviderRequest(profile, canonicalRequest, {
          ...checkedOptions,
          responseContract: bindFrozenResponseContractInvocationV2({
            frozen: frozenResponseContracts, routeBasis: prepared.routeBasis, plan,
            invocationKey: identity.invocationKey, operation: identity.operation,
            trustedOperationPrompt
          })
        });
      return options.preparedExecutor!.execute({
        plan, operation: identity.operation, invocationKey: identity.invocationKey,
        frozenResponseContracts, routeBasis: prepared.routeBasis, trustedOperationPrompt,
        ownerUserId: input.ownerUserId, providerProfileId: input.execution.id,
        request: executorRequest, preparedRequest,
        logicalReservation: {
          kind: "direct",
          ownerUserId: input.ownerUserId,
          requestScopeId,
          invocationId,
          operation: repair ? "repair" : "initial"
        }
      });
    }
  });
}
