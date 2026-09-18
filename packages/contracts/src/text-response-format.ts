import { z } from "zod";

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

export const responseSchemaOperationSchema = z.enum(["story", "choices", "continuity_review"]);
export const responseInvocationKeySchema = z.enum([
  "story:stream", "story:nonstream", "choices:nonstream", "continuity_review:nonstream"
]);
export type ResponseInvocationKey = z.infer<typeof responseInvocationKeySchema>;
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const protocolSchema = z.literal("text-schema-adapter-v1");
const commonPreparedContractSchema = z.object({
  version: z.literal(1), operation: responseSchemaOperationSchema, streaming: z.boolean(),
  forbidFormatFallback: z.literal(true)
});
export const preparedResponseContractSchema = z.discriminatedUnion("mode", [
  commonPreparedContractSchema.extend({ mode: z.literal("json_object") }).strict(),
  commonPreparedContractSchema.extend({
    mode: z.literal("json_schema"), schemaVersion: z.string().min(1).max(200), schemaHash: sha256Schema,
    schemaName: z.string().min(1).max(200), schema: z.record(z.string(), z.unknown()),
    providerRoutingSlugs: z.array(z.string().min(1).max(128).regex(/^[a-z0-9][a-z0-9._/-]*$/i)).max(64), routeConfigHash: sha256Schema,
    adapterProtocol: protocolSchema
  }).strict()
]);
export type PreparedResponseContract = Readonly<z.infer<typeof preparedResponseContractSchema>>;
export const responseFormatDiagnosticCodeSchema = z.enum([
  "provider_schema_unsupported", "provider_schema_invalid", "provider_route_unavailable", "provider_refusal"
]);
export type ResponseFormatDiagnosticCode = z.infer<typeof responseFormatDiagnosticCodeSchema>;
