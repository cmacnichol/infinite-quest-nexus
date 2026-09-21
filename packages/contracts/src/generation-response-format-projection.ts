import { z } from "zod";
import { textModelSelectionSchema } from "./provider-selection.js";
import { providerOutputSchemaOperationV2Schema } from "./provider-output-schema.js";
import { responseInvocationKeyV2Schema } from "./text-response-format.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const boundedIdentifier = z.string().trim().min(1).max(256);
const projectionBaseShape = {
  savedPolicy: z.enum(["legacy", "auto", "required", "unknown"]),
  effectiveMode: z.enum(["legacy", "json_object", "json_schema", "unavailable", "unknown"]),
  schemaVersion: boundedIdentifier.nullable(),
  schemaHash: digest.nullable(),
  streaming: z.boolean().nullable(),
  preflight: z.enum(["pending", "selected", "unavailable", "identity_mismatch", "unknown"]),
  preflightDiagnostic: z.enum(["unsupported_adapter"]).nullable().optional().default(null),
  diagnosticCode: z.enum(["provider_schema_unsupported", "provider_schema_invalid", "provider_route_unavailable", "provider_refusal"]).nullable()
} as const;

export const generationResponseFormatProjectionV1Schema = z.object({
  version: z.literal(1),
  ...projectionBaseShape,
  operation: z.enum(["story", "choices", "continuity_review"]).nullable(),
  requestedModel: boundedIdentifier.nullable(),
  returnedModel: boundedIdentifier.nullable(),
  returnedRoute: boundedIdentifier.nullable()
}).strict();

export const generationResponseFormatProjectionV2Schema = z.object({
  version: z.literal(2),
  ...projectionBaseShape,
  operation: providerOutputSchemaOperationV2Schema.nullable(),
  requestedSelection: textModelSelectionSchema.nullable(),
  assurance: z.enum(["verified_model", "trusted_preset"]).nullable(),
  actualServedIdentity: z.discriminatedUnion("status", [
    z.object({
      status: z.literal("known"),
      model: z.string().trim().min(1).max(500).nullable(),
      providerRoute: z.string().trim().min(1).max(500).nullable()
    }).strict(),
    z.object({ status: z.literal("unknown"), model: z.null(), providerRoute: z.null() }).strict()
  ]).superRefine((identity, context) => {
    if (identity.status === "known" && identity.model === null && identity.providerRoute === null) {
      context.addIssue({ code: "custom", message: "Known served identity requires an observed model or provider route." });
    }
  })
}).strict();

export const generationResponseFormatProjectionSchema = z.discriminatedUnion("version", [
  generationResponseFormatProjectionV1Schema,
  generationResponseFormatProjectionV2Schema
]);
export type GenerationResponseFormatProjection = z.infer<typeof generationResponseFormatProjectionSchema>;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function nullableIdentifier(value: unknown): string | null {
  const parsed = boundedIdentifier.safeParse(value);
  return parsed.success ? parsed.data : null;
}
function nullableServedIdentifier(value: unknown): string | null {
  const parsed = z.string().trim().min(1).max(500).safeParse(value);
  return parsed.success ? parsed.data : null;
}
function nullableDigest(value: unknown): string | null {
  const parsed = digest.safeParse(value);
  return parsed.success ? parsed.data : null;
}
function operationV1(value: unknown): z.infer<typeof generationResponseFormatProjectionV1Schema>["operation"] {
  const parsed = z.enum(["story", "choices", "continuity_review"]).safeParse(value);
  return parsed.success ? parsed.data : null;
}
function diagnosticCode(value: unknown): GenerationResponseFormatProjection["diagnosticCode"] {
  const parsed = projectionBaseShape.diagnosticCode.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function projectV2(source: Record<string, unknown>, queued: Record<string, unknown>): GenerationResponseFormatProjection {
  const base = {
    version: 2 as const, savedPolicy: queued.policy === "required" ? "required" as const : "unknown" as const,
    schemaVersion: null, schemaHash: null, operation: null, streaming: null,
    requestedSelection: null, assurance: null, actualServedIdentity: { status: "unknown" as const, model: null, providerRoute: null },
    diagnosticCode: null, preflightDiagnostic: null
  };
  const ledger = Array.isArray(source.responseContractInvocations) ? source.responseContractInvocations.at(-1) : null;
  const entry = record(ledger);
  const frozen = record(source.frozenResponseContracts);
  if ((frozen && frozen.version !== undefined && frozen.version !== 2) || (entry && entry.version !== undefined && entry.version !== 2)) {
    return generationResponseFormatProjectionV2Schema.parse({ ...base, effectiveMode: "unknown", preflight: "unknown" });
  }

  const authority = record(queued.authority);
  const requestedSelectionResult = authority?.kind === "preset_trusted"
    ? textModelSelectionSchema.safeParse(authority.selection)
    : authority?.kind === "model_verified"
      ? textModelSelectionSchema.safeParse({ kind: "model", modelId: authority.model })
      : null;
  const requestedSelection = requestedSelectionResult?.success ? requestedSelectionResult.data : null;
  const assurance = requestedSelection === null ? null
    : authority?.kind === "preset_trusted" ? "trusted_preset" as const : "verified_model" as const;

  const invocationKeyResult = responseInvocationKeyV2Schema.safeParse(nullableIdentifier(entry?.invocationKey));
  const invocationKey = invocationKeyResult.success ? invocationKeyResult.data : null;
  const contracts = record(frozen?.contracts);
  const contract = ledger === null || ledger === undefined
    ? record(contracts?.["story:stream"]) ?? record(contracts?.["story:nonstream"])
    : invocationKey === null ? null : record(contracts?.[invocationKey]);
  const request = record(entry?.request);
  const response = record(entry?.response);
  const admission = record(queued.admission);
  const mode = admission?.mode === "json_schema" || contract?.mode === "json_schema" ? "json_schema" as const : null;
  const [invocationOperation, delivery] = invocationKey?.split(":") ?? [];
  const operationResult = providerOutputSchemaOperationV2Schema.safeParse(contract?.operation ?? invocationOperation);
  const operation = operationResult.success ? operationResult.data : null;
  const streaming = typeof contract?.streaming === "boolean" ? contract.streaming
    : delivery === "stream" ? true : delivery === "nonstream" ? false : null;
  const model = nullableServedIdentifier(response?.returnedModel);
  const providerRoute = nullableServedIdentifier(response?.returnedProviderRoute);
  const actualServedIdentity = model === null && providerRoute === null
    ? { status: "unknown" as const, model: null, providerRoute: null }
    : { status: "known" as const, model, providerRoute };
  const errorCode = source.errorCode;
  const hasFrozenMarker = frozen !== null || source.frozenResponseContracts !== undefined;
  const preflight = mode ? "selected"
    : errorCode === "response_contract_unavailable" || errorCode === "response_contract_unsupported_adapter" ? "unavailable"
      : errorCode === "response_contract_identity_mismatch" ? "identity_mismatch" : hasFrozenMarker ? "unknown" : "pending";
  return generationResponseFormatProjectionV2Schema.parse({
    ...base,
    effectiveMode: mode ?? (preflight === "unavailable" ? "unavailable" : "unknown"),
    schemaVersion: nullableIdentifier(request?.schemaVersion ?? contract?.schemaVersion),
    schemaHash: nullableDigest(request?.schemaHash ?? contract?.schemaHash),
    operation, streaming, requestedSelection, assurance, actualServedIdentity, preflight,
    preflightDiagnostic: errorCode === "response_contract_unsupported_adapter" ? "unsupported_adapter" : null,
    diagnosticCode: diagnosticCode(response?.diagnosticCode)
  });
}

/** Redacts durable private contract records into the fixed polling/SSE status shape. */
export function projectGenerationResponseFormat(value: unknown): GenerationResponseFormatProjection {
  const source = record(value) ?? {};
  const queued = record(source.queuedResponsePolicy);
  if (queued?.version === 2) return projectV2(source, queued);
  const queuedCurrent = queued?.version === undefined || queued.version === 1;
  const savedPolicy = queuedCurrent && (queued?.policy === "auto" || queued?.policy === "required") ? queued.policy
    : queued === null && (source.queuedResponsePolicy === undefined || source.queuedResponsePolicy === null) ? "legacy" : "unknown";
  const base = {
    version: 1 as const, savedPolicy, schemaVersion: null, schemaHash: null, operation: null,
    streaming: null, requestedModel: null, returnedModel: null, returnedRoute: null, diagnosticCode: null, preflightDiagnostic: null
  };
  if (savedPolicy === "legacy") return generationResponseFormatProjectionSchema.parse({
    ...base, effectiveMode: "legacy", preflight: "unknown"
  });
  if (savedPolicy === "unknown") return generationResponseFormatProjectionSchema.parse({
    ...base, effectiveMode: "unknown", preflight: "unknown"
  });
  const ledger = Array.isArray(source.responseContractInvocations) ? source.responseContractInvocations.at(-1) : null;
  const entry = record(ledger);
  const request = record(entry?.request);
  const response = record(entry?.response);
  const frozen = record(source.frozenResponseContracts);
  if ((frozen && frozen.version !== undefined && frozen.version !== 1) || (entry && entry.version !== undefined && entry.version !== 1)) return generationResponseFormatProjectionSchema.parse({ ...base, savedPolicy, effectiveMode: "unknown", preflight: "unknown" });
  const contracts = record(frozen?.contracts);
  const selected = record(contracts?.["story:stream"]) ?? record(contracts?.["story:nonstream"]);
  const contract = request ?? selected;
  const mode = contract?.mode === "json_schema" || contract?.mode === "json_object" ? contract.mode : null;
  const invocationKey = nullableIdentifier(entry?.invocationKey);
  const [invocationOperation, delivery] = invocationKey?.split(":") ?? [];
  const entryOperation = operationV1(contract?.operation ?? invocationOperation);
  const streaming = typeof contract?.streaming === "boolean" ? contract.streaming : delivery === "stream" ? true : delivery === "nonstream" ? false : null;
  const errorCode = source.errorCode;
  const hasFrozenMarker = frozen !== null || source.frozenResponseContracts !== undefined;
  const preflight = mode ? "selected"
    : errorCode === "response_contract_unavailable" || errorCode === "response_contract_unsupported_adapter" ? "unavailable"
      : errorCode === "response_contract_identity_mismatch" ? "identity_mismatch" : hasFrozenMarker ? "unknown" : "pending";
  return generationResponseFormatProjectionSchema.parse({
    ...base,
    effectiveMode: mode ?? (preflight === "unavailable" ? "unavailable" : "unknown"),
    schemaVersion: nullableIdentifier(contract?.schemaVersion), schemaHash: nullableDigest(contract?.schemaHash),
    operation: entryOperation, streaming,
    requestedModel: nullableIdentifier(request?.requestedModel ?? queued?.model),
    returnedModel: nullableIdentifier(response?.returnedModel), returnedRoute: nullableIdentifier(response?.returnedProviderRoute),
    preflight, preflightDiagnostic: errorCode === "response_contract_unsupported_adapter" ? "unsupported_adapter" : null,
    diagnosticCode: diagnosticCode(response?.diagnosticCode)
  });
}
