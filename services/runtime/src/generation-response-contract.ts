import {
  frozenResponseContractsSelectionHash,
  type FrozenResponseContracts,
  type QueuedResponsePolicy
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

function operationForKey(key: ResponseInvocationKey): Readonly<{ operation: ResponseSchemaOperation; streaming: boolean }> {
  const [operation, delivery] = key.split(":") as [ResponseSchemaOperation, "stream" | "nonstream"];
  return { operation, streaming: delivery === "stream" };
}

function assertPolicyProfile(policy: QueuedResponsePolicy, profile: ResponseContractRuntimeProfile, registryDigest: string): void {
  if (policy.verificationRegistryHash !== registryDigest) {
    throw new ResponseContractPreflightError("response_contract_identity_mismatch", "The queued response-contract registry changed; re-enqueue this generation.");
  }
  if (policy.providerProfileId !== profile.id || policy.model !== profile.model
    || policy.endpointIdentity !== profile.endpointIdentity || policy.providerConfigurationHash !== profile.configurationHash) {
    throw new ResponseContractPreflightError("response_contract_identity_mismatch", "The queued response-contract provider identity changed; re-enqueue this generation.");
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
  capabilityEvidenceHash?: string;
}>): FrozenResponseContracts {
  const { queuedPolicy, profile } = input;
  assertPolicyProfile(queuedPolicy, profile, input.registryDigest);
  if (profile.providerType !== "openrouter" && profile.providerType !== "openai_compatible") {
    throw new ResponseContractPreflightError("response_contract_unsupported_adapter", "The selected provider adapter does not support response contracts.");
  }
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
    capabilityEvidenceHash: input.capabilityEvidenceHash ?? input.registryDigest,
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
