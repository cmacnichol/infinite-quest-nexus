import { z } from "zod";
import { findProviderOutputSchemaV2, getProviderOutputSchemaV2, providerOutputSchemaOperationV2Schema, stableJsonHash } from "./provider-output-schema.js";

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

/** New-work admission is intentionally distinct from model verification evidence. */
export const responseContractAdmissionSchema = z.discriminatedUnion("basis", [
  z.object({ mode: z.literal("json_schema"), basis: z.literal("model_verified"), verification: z.object({
    version: z.literal(2), providerType: z.enum(["openrouter", "openai_compatible"]), endpointIdentity: z.string().min(1),
    model: z.string().min(1), routeConfigHash: z.string().regex(/^[a-f0-9]{64}$/), adapterProtocol: z.literal("text-schema-adapter-v2"),
    operation: providerOutputSchemaOperationV2Schema, schemaHash: z.string().regex(/^[a-f0-9]{64}$/), streaming: z.boolean(),
    verifiedAt: z.iso.datetime(), expiresAt: z.iso.datetime(), providerRoutingSlugs: z.array(z.string().min(1)).max(64), nativeOpenTrackerObjects: z.boolean()
  }).strict() }).strict(),
  z.object({ mode: z.literal("json_schema"), basis: z.literal("preset_trusted") }).strict()
]);
export type ResponseContractAdmission = Readonly<z.infer<typeof responseContractAdmissionSchema>>;

export type ResponseSchemaOperationV2 = z.infer<typeof providerOutputSchemaOperationV2Schema>;
export type SchemaVerificationV2 = Readonly<{
  version: 2; providerType: "openrouter" | "openai_compatible"; endpointIdentity: string; model: string;
  routeConfigHash: string; adapterProtocol: "text-schema-adapter-v2"; operation: ResponseSchemaOperationV2;
  schemaHash: string; streaming: boolean; verifiedAt: string; expiresAt: string;
  providerRoutingSlugs: readonly string[]; nativeOpenTrackerObjects: boolean;
}>;
export type ResponseFormatEligibilityV2 = Readonly<{
  status: "verified" | "advertised" | "unsupported" | "unknown";
  reason: "verified" | "missing_metadata" | "not_advertised" | "missing_verification" | "expired" | "schema_incompatible" | "unresolved_model" | "discovery_unavailable";
  verification: SchemaVerificationV2 | null;
}>;

export type ModelVerifiedResponseContractAuthority = Readonly<{
  providerType: "openrouter" | "openai_compatible";
  endpointIdentity: string;
  model: string;
  routeConfigHash: string;
}>;

/** Shared v2 evidence guard for queued policies and prepared invocation contracts. */
export function assertModelVerifiedResponseContractEvidence(input: Readonly<{
  verification: SchemaVerificationV2;
  authority: ModelVerifiedResponseContractAuthority;
  operation: ResponseSchemaOperationV2;
  streaming: boolean;
  schemaVersion: string;
}>): void {
  const { verification, authority, operation, streaming } = input;
  const catalog = getProviderOutputSchemaV2(operation, input.schemaVersion);
  if (verification.providerType !== authority.providerType || verification.endpointIdentity !== authority.endpointIdentity
    || verification.model !== authority.model || verification.routeConfigHash !== authority.routeConfigHash
    || verification.operation !== operation || verification.schemaHash !== catalog.schemaHash || verification.streaming !== streaming
    || (operation === "story" && !verification.nativeOpenTrackerObjects)) {
    throw new Error("Model verification does not bind the exact v2 response-contract authority and schema.");
  }
}

export const responseSchemaOperationSchema = z.enum(["story", "choices", "continuity_review"]);
export const responseInvocationKeySchema = z.enum([
  "story:stream", "story:nonstream", "choices:nonstream", "continuity_review:nonstream"
]);
export type ResponseInvocationKey = z.infer<typeof responseInvocationKeySchema>;
export const responseInvocationKeyV2Schema = z.enum([
  "story:stream", "story:nonstream", "choices:nonstream", "continuity_review:nonstream", "rpg_assessment:nonstream",
  "event_trigger_before:nonstream", "event_trigger_after:nonstream", "scene_coverage:nonstream", "event_coverage:nonstream",
  "world_outline:nonstream", "world_seed_character:nonstream", "standalone_character:nonstream", "character_organizer:nonstream",
  "source_extraction:nonstream", "source_synthesis:nonstream", "source_character:nonstream", "illustration_prompt_refinement:nonstream", "cast_discovery:nonstream"
]);
export type ResponseInvocationKeyV2 = z.infer<typeof responseInvocationKeyV2Schema>;
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
const preparedResponseContractV2SchemaShape = z.object({
  version: z.literal(2), mode: z.literal("json_schema"), admission: responseContractAdmissionSchema,
  operation: providerOutputSchemaOperationV2Schema, streaming: z.boolean(), forbidFormatFallback: z.literal(true),
  schemaVersion: z.string().min(1).max(200), schemaHash: sha256Schema, schemaName: z.string().min(1).max(200), schema: z.record(z.string(), z.unknown()),
  authority: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("model_verified"), providerProfileId: z.uuid(), providerType: z.enum(["openrouter", "openai_compatible"]), endpointIdentity: z.string().min(1), model: z.string().min(1), providerConfigurationHash: sha256Schema, routeConfigHash: sha256Schema, verificationRegistryHash: sha256Schema }).strict(),
    z.object({ kind: z.literal("preset_trusted"), routeBasisHash: sha256Schema, planHash: sha256Schema }).strict()
  ])
}).strict();
export const preparedResponseContractV2Schema = preparedResponseContractV2SchemaShape.superRefine((value, context) => {
  if (value.admission.basis !== value.authority.kind) context.addIssue({ code: "custom", path: ["authority"], message: "Response-contract admission and authority must agree." });
  const catalog = findProviderOutputSchemaV2(value.operation, value.schemaVersion);
  if (!catalog || value.schemaName !== catalog.name || value.schemaHash !== catalog.schemaHash
    || value.schemaHash !== stableJsonHash(value.schema)) {
    context.addIssue({ code: "custom", path: ["schema"], message: "Prepared v2 contract must use the exact catalog schema." });
  }
  if (value.admission.basis === "model_verified" && value.authority.kind === "model_verified") {
    try {
      assertModelVerifiedResponseContractEvidence({
        verification: value.admission.verification,
        authority: value.authority,
        operation: value.operation,
        streaming: value.streaming,
        schemaVersion: value.schemaVersion
      });
    } catch {
      context.addIssue({ code: "custom", path: ["admission", "verification"], message: "Model verification must bind the exact v2 contract authority and schema." });
    }
  }
});
export type PreparedResponseContractV2 = Readonly<z.infer<typeof preparedResponseContractV2Schema>>;
export const responseFormatDiagnosticCodeSchema = z.enum([
  "provider_schema_unsupported", "provider_schema_invalid", "provider_route_unavailable", "provider_refusal"
]);
export type ResponseFormatDiagnosticCode = z.infer<typeof responseFormatDiagnosticCodeSchema>;
