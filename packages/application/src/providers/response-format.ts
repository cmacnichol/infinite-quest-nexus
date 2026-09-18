import type { ModelParameterAdvertisement, ResponseFormatEligibility, ResponseSchemaOperation, SchemaVerification, TextResponseFormatPolicy } from "@infinite-quest/contracts";

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
  const matching = input.verifications.find((verification) => verification.providerType === input.providerType
    && verification.endpointIdentity === input.endpointIdentity && verification.model === input.model
    && verification.routeConfigHash === input.routeConfigHash && verification.adapterProtocol === input.adapterProtocol
    && verification.operation === input.operation && verification.schemaHash === input.schemaHash
    && verification.streaming === input.streaming && (input.operation !== "story" || verification.nativeOpenTrackerObjects));
  if (!matching) return { status: "advertised", reason: "missing_verification", verification: null };
  if (Date.parse(matching.expiresAt) <= Date.parse(input.now)) return { status: "advertised", reason: "expired", verification: null };
  return { status: "verified", reason: "verified", verification: matching };
}

export function selectResponseFormat(policy: TextResponseFormatPolicy | undefined, eligibility: ResponseFormatEligibility): ResponseFormatSelection {
  if (policy === undefined || policy === "legacy") return "legacy";
  if (eligibility.status === "verified") return "json_schema";
  return policy === "required" ? "unavailable" : "json_object";
}
