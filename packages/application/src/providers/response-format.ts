import type {
  ModelParameterAdvertisement,
  ResponseContractAdmission,
  ResponseFormatEligibility,
  ResponseFormatEligibilityV2,
  ResponseSchemaOperation,
  ResponseSchemaOperationV2,
  SchemaVerification,
  SchemaVerificationV2,
  TextModelSelection,
  TextResponseFormatPolicy
} from "@infinite-quest/contracts";

export type ResponseFormatSelection = "legacy" | "json_object" | "json_schema" | "unavailable";
export type ResponseFormatEligibilityInput = Readonly<{
  advertisement: ModelParameterAdvertisement | null; providerType: "openrouter" | "openai_compatible";
  endpointIdentity: string; model: string; routeConfigHash: string; adapterProtocol: "text-schema-adapter-v1";
  operation: ResponseSchemaOperation; schemaHash: string; streaming: boolean; now: string; verifications: readonly SchemaVerification[];
  nativeOpenTrackerObjects?: boolean;
}>;

export function resolveResponseFormatEligibility(input: ResponseFormatEligibilityInput): ResponseFormatEligibility {
  if (!input.model.trim() || !input.endpointIdentity.trim() || /(^|[/:@])(auto|default|preset)(?:$|[/:@])/i.test(input.model.trim())) return { status: "unknown", reason: "unresolved_model", verification: null };
  if (!input.advertisement || input.advertisement.supportedParameters === null) return { status: "unknown", reason: "missing_metadata", verification: null };
  if (!input.advertisement.supportedParameters.includes("response_format")) return { status: "unsupported", reason: "not_advertised", verification: null };
  if (input.providerType === "openrouter" && !input.advertisement.supportedParameters.includes("structured_outputs")) return { status: "unsupported", reason: "not_advertised", verification: null };
  if (input.operation === "story" && input.nativeOpenTrackerObjects === false) return { status: "unsupported", reason: "schema_incompatible", verification: null };
  const matches = input.verifications.filter((verification) => verification.providerType === input.providerType
    && verification.endpointIdentity === input.endpointIdentity && verification.model === input.model
    && verification.routeConfigHash === input.routeConfigHash && verification.adapterProtocol === input.adapterProtocol
    && verification.operation === input.operation && verification.schemaHash === input.schemaHash
    && verification.streaming === input.streaming && (input.operation !== "story" || verification.nativeOpenTrackerObjects));
  const matching = matches.find((verification) => Date.parse(verification.verifiedAt) <= Date.parse(input.now)
    && Date.parse(verification.expiresAt) > Date.parse(input.now));
  if (!matching) return { status: "advertised", reason: matches.length ? "expired" : "missing_verification", verification: null };
  return { status: "verified", reason: "verified", verification: matching };
}

export function selectResponseFormat(policy: TextResponseFormatPolicy | undefined, eligibility: ResponseFormatEligibility): ResponseFormatSelection {
  if (policy === undefined || policy === "legacy") return "legacy";
  if (eligibility.status === "verified") return "json_schema";
  return policy === "required" ? "unavailable" : "json_object";
}

/**
 * Applies the product default only at a new-work boundary. Historical readers
 * continue to use selectResponseFormat(undefined, ...) and retain legacy mode.
 */
export function normalizeNewTextResponsePolicy(selection: TextModelSelection, policy: TextResponseFormatPolicy | undefined): "legacy" | "auto" | "required" {
  return selection.kind === "openrouter_preset" ? "required" : policy ?? "required";
}

/** Trusted OpenRouter preset selection intentionally has no model-inventory input. */
export function presetResponseAdmission(selection: TextModelSelection): ResponseContractAdmission {
  if (selection.kind !== "openrouter_preset") throw new Error("Preset response admission requires an OpenRouter preset selection.");
  return { mode: "json_schema", basis: "preset_trusted" };
}

export type ResponseFormatEligibilityV2Input = Readonly<{
  advertisement: ModelParameterAdvertisement | null; providerType: "openrouter" | "openai_compatible";
  endpointIdentity: string; model: string; routeConfigHash: string; adapterProtocol: "text-schema-adapter-v2";
  operation: ResponseSchemaOperationV2; schemaHash: string; streaming: boolean; now: string; verifications: readonly SchemaVerificationV2[];
  nativeOpenTrackerObjects?: boolean;
}>;

/** Same exact tuple gate as v1, widened only through an explicit v2 record. */
export function resolveResponseFormatEligibilityV2(input: ResponseFormatEligibilityV2Input): ResponseFormatEligibilityV2 {
  if (!input.model.trim() || !input.endpointIdentity.trim() || /(^|[/:@])(auto|default|preset)(?:$|[/:@])/i.test(input.model.trim())) return { status: "unknown", reason: "unresolved_model", verification: null };
  if (!input.advertisement || input.advertisement.supportedParameters === null) return { status: "unknown", reason: "missing_metadata", verification: null };
  if (!input.advertisement.supportedParameters.includes("response_format")) return { status: "unsupported", reason: "not_advertised", verification: null };
  if (input.providerType === "openrouter" && !input.advertisement.supportedParameters.includes("structured_outputs")) return { status: "unsupported", reason: "not_advertised", verification: null };
  if (input.operation === "story" && input.nativeOpenTrackerObjects === false) return { status: "unsupported", reason: "schema_incompatible", verification: null };
  const matches = input.verifications.filter((verification) => verification.providerType === input.providerType
    && verification.endpointIdentity === input.endpointIdentity && verification.model === input.model
    && verification.routeConfigHash === input.routeConfigHash && verification.adapterProtocol === input.adapterProtocol
    && verification.operation === input.operation && verification.schemaHash === input.schemaHash
    && verification.streaming === input.streaming && (input.operation !== "story" || verification.nativeOpenTrackerObjects));
  const matching = matches.find((verification) => Date.parse(verification.verifiedAt) <= Date.parse(input.now)
    && Date.parse(verification.expiresAt) > Date.parse(input.now));
  if (!matching) return { status: "advertised", reason: matches.length ? "expired" : "missing_verification", verification: null };
  return { status: "verified", reason: "verified", verification: matching };
}

/** Selection-discriminated admission keeps preset trust separate from model evidence. */
export function resolveResponseContractAdmission(input: Readonly<{
  selection: TextModelSelection;
  advertisement?: ModelParameterAdvertisement | null;
  directEligibility?: () => ResponseFormatEligibilityV2;
}>): ResponseContractAdmission {
  if (input.selection.kind === "openrouter_preset") return presetResponseAdmission(input.selection);
  if (!input.directEligibility) throw new Error("Direct-model response admission requires capability verification.");
  const eligibility = input.directEligibility();
  if (eligibility.status !== "verified" || !eligibility.verification) throw new Error("The direct model does not have a verified response contract.");
  if (eligibility.verification.model !== input.selection.modelId) throw new Error("The direct-model verification does not match the selected model.");
  return { mode: "json_schema", basis: "model_verified", verification: { ...eligibility.verification, providerRoutingSlugs: [...eligibility.verification.providerRoutingSlugs] } };
}
