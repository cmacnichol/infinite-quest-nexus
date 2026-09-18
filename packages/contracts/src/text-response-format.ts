export type TextResponseFormatPolicy = "legacy" | "auto" | "required";
export type ResponseSchemaOperation = "story" | "choices" | "continuity_review";
export type ModelParameterAdvertisement = Readonly<{ supportedParameters: readonly string[] | null; discoveredAt: string }>;
export type SchemaVerification = Readonly<{
  version: 1; providerType: "openrouter" | "openai_compatible"; endpointIdentity: string; model: string;
  routeConfigHash: string; adapterProtocol: "text-schema-adapter-v1"; operation: ResponseSchemaOperation;
  schemaHash: string; streaming: boolean; verifiedAt: string; expiresAt: string;
  providerRoutingSlugs: readonly string[]; nativeOpenTrackerObjects: boolean;
}>;
export type ResponseFormatEligibility = Readonly<{
  status: "verified" | "advertised" | "unsupported" | "unknown";
  reason: "verified" | "missing_metadata" | "not_advertised" | "missing_verification" | "expired" | "schema_incompatible" | "unresolved_model" | "discovery_unavailable";
  verification: SchemaVerification | null;
}>;
