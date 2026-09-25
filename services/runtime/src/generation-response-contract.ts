import {
  frozenResponseContractsSelectionHash,
  frozenResponseContractsV2SelectionHash,
  type FrozenResponseContracts,
  type FrozenResponseContractsV2,
  type QueuedResponsePolicy,
  type QueuedResponsePolicyV2
} from "../../../packages/contracts/src/generation-response-contract.js";
import type {
  PreparedResponseContract,
  ResponseFormatEligibility,
  ResponseInvocationKey,
  ResponseSchemaOperation,
  SchemaVerification,
  TextResponseFormatPolicy
} from "../../../packages/contracts/src/text-response-format.js";
import { getProviderOutputSchema } from "../../../packages/story-engine/src/provider-output-schema.js";
import { getProviderOutputSchemaV2, selectProviderOutputSchemaV2, type ProviderOutputSchemaV2 } from "../../../packages/contracts/src/provider-output-schema.js";
import type { ResponseInvocationKeyV2, ResponseFormatEligibilityV2 } from "../../../packages/contracts/src/text-response-format.js";
import type { TextModelSelection } from "../../../packages/contracts/src/provider-selection.js";
import { resolveResponseContractAdmission } from "../../../packages/application/src/providers/response-format.js";

export type ResponseContractRuntimeProfile = Readonly<{
  id: string;
  providerType: string;
  model: string;
  endpointIdentity: string;
  configurationHash: string;
}>;

export class ResponseContractPreflightError extends Error {
  readonly code: "response_contract_unavailable" | "response_contract_unsupported_adapter" | "response_contract_identity_mismatch";

  constructor(code: ResponseContractPreflightError["code"], message: string) {
    super(message);
    this.name = "ResponseContractPreflightError";
    this.code = code;
  }
}

/** The closure is frozen at enqueue; no later feature flag or policy reload may add an operation. */
export function responseContractInvocationClosure(input: Readonly<{
  streamingPrimary: boolean;
  storyOnly: boolean;
  continuityReview: "off" | "observe" | "enforce";
}>): readonly ResponseInvocationKey[] {
  return [
    "story:nonstream",
    ...(input.streamingPrimary ? ["story:stream" as const] : []),
    ...(input.storyOnly ? ["choices:nonstream" as const] : []),
    ...(input.continuityReview === "off" ? [] : ["continuity_review:nonstream" as const])
  ];
}

/** The v2 Story closure names every schema-producing call before the worker
 * measures, reserves, or dispatches its first provider body.  Repair calls
 * deliberately reuse the Story schema key but retain distinct invocation
 * audit operations. */
export function responseContractInvocationClosureV2(input: Readonly<{
  streamingPrimary: boolean;
  storyOnly: boolean;
  continuityReview: "off" | "observe" | "enforce";
}>): readonly ResponseInvocationKeyV2[] {
  return [
    "story:nonstream",
    ...(input.streamingPrimary ? ["story:stream" as const] : []),
    ...(input.storyOnly ? ["choices:nonstream" as const] : []),
    ...(input.continuityReview === "off" ? [] : ["continuity_review:nonstream" as const]),
    "rpg_assessment:nonstream",
    "event_trigger_before:nonstream",
    "event_trigger_after:nonstream",
    "scene_coverage:nonstream",
    "event_coverage:nonstream"
  ];
}

function v2OperationForKey(key: ResponseInvocationKeyV2): Readonly<{ operation: Parameters<typeof getProviderOutputSchemaV2>[0]; streaming: boolean }> {
  const [operation, delivery] = key.split(":") as [Parameters<typeof getProviderOutputSchemaV2>[0], "stream" | "nonstream"];
  return { operation, streaming: delivery === "stream" };
}

/** Creates a complete immutable v2 schema closure.  Model work proves every
 * operation through the exact v2 tuple; trusted presets intentionally do not
 * consult discovery or the verification registry. */
export function resolveGenerationResponseContractsV2(input: Readonly<{
  queuedPolicy: QueuedResponsePolicyV2;
  eligible?(operation: Parameters<typeof getProviderOutputSchemaV2>[0], streaming: boolean, schema: ProviderOutputSchemaV2): ResponseFormatEligibilityV2;
  selectedAt?: string;
  capabilityEvidenceHash: string | (() => string);
}>): FrozenResponseContractsV2 {
  const contracts: Record<string, unknown> = {};
  const presetTrusted = input.queuedPolicy.authority.kind === "preset_trusted";
  const streamingByOperation = new Map<Parameters<typeof getProviderOutputSchemaV2>[0], boolean[]>();
  for (const key of input.queuedPolicy.invocationKeys) {
    const { operation, streaming } = v2OperationForKey(key);
    streamingByOperation.set(operation, [...(streamingByOperation.get(operation) ?? []), streaming]);
  }
  // One version per operation, so every key of that operation (stream and
  // nonstream) shares one wire shape and one encoding contract.
  const chosen = new Map<Parameters<typeof getProviderOutputSchemaV2>[0], ProviderOutputSchemaV2>();
  for (const [operation, streamings] of streamingByOperation) {
    const schema = selectProviderOutputSchemaV2(operation, (candidate) => presetTrusted
      || streamings.every((streaming) => input.eligible?.(operation, streaming, candidate)?.status === "verified"))
      ?? getProviderOutputSchemaV2(operation);
    chosen.set(operation, schema);
  }
  for (const key of input.queuedPolicy.invocationKeys) {
    const { operation, streaming } = v2OperationForKey(key);
    const schema = chosen.get(operation)!;
    const admission = input.queuedPolicy.authority.kind === "preset_trusted"
      ? input.queuedPolicy.admission
      : resolveResponseContractAdmission({
        selection: { kind: "model", modelId: input.queuedPolicy.authority.model } satisfies TextModelSelection,
        directEligibility: () => {
          const eligibility = input.eligible?.(operation, streaming, schema);
          if (!eligibility) throw new ResponseContractPreflightError("response_contract_unavailable", `The required response contract is unavailable for ${key}.`);
          return eligibility;
        }
      });
    contracts[key] = {
      version: 2,
      mode: "json_schema",
      admission,
      operation,
      streaming,
      forbidFormatFallback: true,
      schemaVersion: schema.version,
      schemaHash: schema.schemaHash,
      schemaName: schema.name,
      schema: schema.schema,
      authority: input.queuedPolicy.authority.kind === "preset_trusted"
        ? { kind: "preset_trusted", routeBasisHash: input.queuedPolicy.authority.routeBasisHash }
        : (() => {
          // authorityRevision fences new queued work and current credential
          // authority. Prepared transport contracts intentionally retain the
          // stable v2 wire authority shape from Task 4A.
          const { authorityRevision: _authorityRevision, ...authority } = input.queuedPolicy.authority;
          return authority;
        })()
    };
  }
  const selected = {
    version: 2 as const,
    queuedPolicy: input.queuedPolicy,
    selectedAt: input.selectedAt ?? new Date().toISOString(),
    capabilityEvidenceHash: typeof input.capabilityEvidenceHash === "function"
      ? input.capabilityEvidenceHash()
      : input.capabilityEvidenceHash,
    contracts
  };
  return {
    ...selected,
    selectionHash: frozenResponseContractsV2SelectionHash(selected)
  } as FrozenResponseContractsV2;
}

function operationForKey(key: ResponseInvocationKey): Readonly<{ operation: ResponseSchemaOperation; streaming: boolean }> {
  const [operation, delivery] = key.split(":") as [ResponseSchemaOperation, "stream" | "nonstream"];
  return { operation, streaming: delivery === "stream" };
}

export function assertQueuedResponseContractProfile(policy: QueuedResponsePolicy, profile: ResponseContractRuntimeProfile, registryDigest: string): void {
  if (policy.verificationRegistryHash !== registryDigest) {
    throw new ResponseContractPreflightError("response_contract_identity_mismatch", "The queued response-contract registry changed; re-enqueue this generation.");
  }
  if (policy.providerProfileId !== profile.id || policy.model !== profile.model
    || policy.endpointIdentity !== profile.endpointIdentity || policy.providerConfigurationHash !== profile.configurationHash) {
    throw new ResponseContractPreflightError("response_contract_identity_mismatch", "The queued response-contract provider identity changed; re-enqueue this generation.");
  }
}

export function assertResponseContractAdapter(profile: ResponseContractRuntimeProfile): void {
  if (profile.providerType !== "openrouter" && profile.providerType !== "openai_compatible") {
    throw new ResponseContractPreflightError("response_contract_unsupported_adapter", "The selected provider adapter does not support response contracts.");
  }
}

function schemaContract(operation: ResponseSchemaOperation, streaming: boolean, verification: SchemaVerification): PreparedResponseContract {
  const schema = getProviderOutputSchema(operation);
  if (verification.schemaHash !== schema.schemaHash || verification.operation !== operation || verification.streaming !== streaming) {
    throw new ResponseContractPreflightError("response_contract_unavailable", "The verified response contract does not cover this operation.");
  }
  if (operation === "story" && schema.requiresOpenTrackerObjects && !verification.nativeOpenTrackerObjects) {
    throw new ResponseContractPreflightError("response_contract_unavailable", "The verified response contract cannot preserve native tracker objects.");
  }
  return {
    version: 1,
    mode: "json_schema",
    operation,
    streaming,
    forbidFormatFallback: true,
    schemaVersion: schema.version,
    schemaHash: schema.schemaHash,
    schemaName: schema.name,
    schema: schema.schema,
    providerRoutingSlugs: [...verification.providerRoutingSlugs],
    routeConfigHash: verification.routeConfigHash,
    adapterProtocol: verification.adapterProtocol
  };
}

/** Resolves the complete durable envelope once, after a job has its lease and before any text dispatch. */
export function resolveGenerationResponseContracts(input: Readonly<{
  queuedPolicy: QueuedResponsePolicy;
  profile: ResponseContractRuntimeProfile;
  registryDigest: string;
  eligible(operation: ResponseSchemaOperation, streaming: boolean): ResponseFormatEligibility;
  selectedAt?: string;
  capabilityEvidenceHash?: string | (() => string);
}>): FrozenResponseContracts {
  const { queuedPolicy, profile } = input;
  assertQueuedResponseContractProfile(queuedPolicy, profile, input.registryDigest);
  assertResponseContractAdapter(profile);
  const contracts: Partial<Record<ResponseInvocationKey, PreparedResponseContract>> = {};
  for (const key of queuedPolicy.invocationKeys) {
    const { operation, streaming } = operationForKey(key);
    const eligibility = input.eligible(operation, streaming);
    if (eligibility.status === "verified" && eligibility.verification) {
      contracts[key] = schemaContract(operation, streaming, eligibility.verification);
      continue;
    }
    if (queuedPolicy.policy === "required") {
      throw new ResponseContractPreflightError("response_contract_unavailable", `The required response contract is unavailable for ${key}.`);
    }
    contracts[key] = { version: 1, mode: "json_object", operation, streaming, forbidFormatFallback: true };
  }
  const selected = {
    version: 1 as const,
    queuedPolicy,
    selectedAt: input.selectedAt ?? new Date().toISOString(),
    capabilityEvidenceHash: typeof input.capabilityEvidenceHash === "function"
      ? input.capabilityEvidenceHash()
      : input.capabilityEvidenceHash ?? input.registryDigest,
    contracts
  };
  return { ...selected, selectionHash: frozenResponseContractsSelectionHash(selected) } as FrozenResponseContracts;
}

/** Queue-time capture intentionally has no inventory or network dependency. */
export function queuedResponseContractPolicy(input: Readonly<{
  policy: TextResponseFormatPolicy | undefined;
  profile: ResponseContractRuntimeProfile;
  verificationRegistryHash: string;
  invocationKeys: readonly ResponseInvocationKey[];
}>): QueuedResponsePolicy | undefined {
  if (!input.policy || input.policy === "legacy") return undefined;
  if (input.invocationKeys.length === 0) throw new Error("A response-contract policy requires an invocation closure.");
  return {
    version: 1,
    policy: input.policy,
    providerProfileId: input.profile.id,
    model: input.profile.model,
    endpointIdentity: input.profile.endpointIdentity,
    providerConfigurationHash: input.profile.configurationHash,
    verificationRegistryHash: input.verificationRegistryHash,
    operationClosureVersion: 1,
    invocationKeys: [...input.invocationKeys]
  };
}
