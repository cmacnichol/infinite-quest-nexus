import { z } from "zod";

const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const boundedIdentifier = z.string().trim().min(1).max(256);
export const generationResponseFormatProjectionSchema = z.object({
  version: z.literal(1),
  savedPolicy: z.enum(["legacy", "auto", "required", "unknown"]),
  effectiveMode: z.enum(["legacy", "json_object", "json_schema", "unavailable", "unknown"]),
  schemaVersion: boundedIdentifier.nullable(),
  schemaHash: digest.nullable(),
  operation: z.enum(["story", "choices", "continuity_review"]).nullable(),
  streaming: z.boolean().nullable(),
  requestedModel: boundedIdentifier.nullable(),
  returnedModel: boundedIdentifier.nullable(),
  returnedRoute: boundedIdentifier.nullable(),
  preflight: z.enum(["pending", "selected", "unavailable", "identity_mismatch", "unknown"]),
  diagnosticCode: z.enum(["provider_schema_unsupported", "provider_schema_invalid", "provider_route_unavailable", "provider_refusal"]).nullable()
}).strict();
export type GenerationResponseFormatProjection = z.infer<typeof generationResponseFormatProjectionSchema>;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function nullableIdentifier(value: unknown): string | null {
  const parsed = boundedIdentifier.safeParse(value);
  return parsed.success ? parsed.data : null;
}
function nullableDigest(value: unknown): string | null {
  const parsed = digest.safeParse(value);
  return parsed.success ? parsed.data : null;
}
function operation(value: unknown): GenerationResponseFormatProjection["operation"] {
  const parsed = z.enum(["story", "choices", "continuity_review"]).safeParse(value);
  return parsed.success ? parsed.data : null;
}
function diagnosticCode(value: unknown): GenerationResponseFormatProjection["diagnosticCode"] {
  const parsed = generationResponseFormatProjectionSchema.shape.diagnosticCode.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Redacts durable private contract records into the fixed polling/SSE status shape. */
export function projectGenerationResponseFormat(value: unknown): GenerationResponseFormatProjection {
  const source = record(value) ?? {};
  const queued = record(source.queuedResponsePolicy);
  const queuedCurrent = queued?.version === undefined || queued.version === 1;
  const savedPolicy = queuedCurrent && (queued?.policy === "auto" || queued?.policy === "required") ? queued.policy
    : queued === null && (source.queuedResponsePolicy === undefined || source.queuedResponsePolicy === null) ? "legacy" : "unknown";
  const base = {
    version: 1 as const, savedPolicy, schemaVersion: null, schemaHash: null, operation: null,
    streaming: null, requestedModel: null, returnedModel: null, returnedRoute: null, diagnosticCode: null
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
  const entryOperation = operation(contract?.operation ?? invocationOperation);
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
    preflight, diagnosticCode: diagnosticCode(response?.diagnosticCode)
  });
}
