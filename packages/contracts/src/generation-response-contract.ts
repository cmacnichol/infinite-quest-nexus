import { z } from "zod";
import { sha256Hex } from "./hash.js";
import { preparedResponseContractSchema, responseFormatDiagnosticCodeSchema, responseInvocationKeySchema } from "./text-response-format.js";
export type { ResponseInvocationKey } from "./text-response-format.js";

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const invocationKeysSchema = z.array(responseInvocationKeySchema).min(1).max(4).superRefine((keys, context) => {
  if (new Set(keys).size !== keys.length) context.addIssue({ code: "custom", message: "Invocation keys must be unique." });
});

export const queuedResponsePolicySchema = z.object({
  version: z.literal(1), policy: z.enum(["auto", "required"]), providerProfileId: z.uuid(),
  model: z.string().trim().min(1).max(512), endpointIdentity: z.string().trim().min(1).max(512),
  providerConfigurationHash: hashSchema, verificationRegistryHash: hashSchema, operationClosureVersion: z.literal(1), invocationKeys: invocationKeysSchema
}).strict();
export type QueuedResponsePolicy = Readonly<z.infer<typeof queuedResponsePolicySchema>>;
export function readQueuedResponsePolicy(value: unknown): QueuedResponsePolicy | undefined {
  if (value === undefined) return undefined;
  const parsed = queuedResponsePolicySchema.safeParse(value);
  if (!parsed.success) throw new Error("Queued response policy is invalid or incompatible.");
  return parsed.data;
}
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
/** Stable across PostgreSQL JSONB key ordering; distinct from provider configuration identity. */
export function queuedResponsePolicyHash(value: QueuedResponsePolicy): string {
  return sha256Hex(canonicalJson(queuedResponsePolicySchema.parse(value)));
}

function contractMatchesKey(key: z.infer<typeof responseInvocationKeySchema>, contract: z.infer<typeof preparedResponseContractSchema>): boolean {
  const [operation, delivery] = key.split(":") as [string, string];
  return contract.operation === operation && contract.streaming === (delivery === "stream");
}

export const frozenResponseContractsSchema = z.object({
  version: z.literal(1), queuedPolicy: queuedResponsePolicySchema, selectedAt: z.iso.datetime(), capabilityEvidenceHash: hashSchema,
  contracts: z.partialRecord(responseInvocationKeySchema, preparedResponseContractSchema), selectionHash: hashSchema
}).strict().superRefine((value, context) => {
  const keys = new Set(value.queuedPolicy.invocationKeys);
  for (const [key, contract] of Object.entries(value.contracts)) {
    if (!keys.has(key as z.infer<typeof responseInvocationKeySchema>) || !contractMatchesKey(key as z.infer<typeof responseInvocationKeySchema>, contract)) context.addIssue({ code: "custom", path: ["contracts", key], message: "Frozen response contract does not match its queued invocation." });
  }
  for (const key of keys) if (!Object.hasOwn(value.contracts, key)) context.addIssue({ code: "custom", path: ["contracts", key], message: "Each queued invocation requires a frozen contract." });
  if (value.queuedPolicy.policy === "required" && Object.values(value.contracts).some((contract) => contract.mode !== "json_schema")) {
    context.addIssue({ code: "custom", path: ["contracts"], message: "Required queued policy permits only schema-mode contracts." });
  }
});
export type FrozenResponseContracts = Readonly<z.infer<typeof frozenResponseContractsSchema>>;
export function readFrozenResponseContracts(value: unknown): FrozenResponseContracts | undefined {
  if (value === undefined) return undefined;
  const parsed = frozenResponseContractsSchema.safeParse(value);
  if (!parsed.success) throw new Error("Frozen response contracts are invalid or incompatible.");
  return parsed.data;
}

export const attemptResponseContractAuditSchema = z.object({
  version: z.literal(1), selectionHash: hashSchema, invocationKey: responseInvocationKeySchema, mode: z.enum(["json_object", "json_schema"]),
  schemaVersion: z.string().min(1).max(200).nullable(), schemaHash: hashSchema.nullable(), requestedModel: z.string().trim().min(1).max(512),
  providerRoutingSlugs: z.array(z.string().trim().min(1).max(128)).max(64), returnedModel: z.string().trim().min(1).max(256).nullable(),
  returnedProviderRoute: z.string().trim().min(1).max(256).nullable(), diagnosticCode: responseFormatDiagnosticCodeSchema.nullable()
}).strict().superRefine((value, context) => {
  const schemaFieldsPresent = value.schemaVersion !== null && value.schemaHash !== null;
  const schemaFieldsAbsent = value.schemaVersion === null && value.schemaHash === null;
  if ((value.mode === "json_schema" && !schemaFieldsPresent) || (value.mode === "json_object" && !schemaFieldsAbsent)) context.addIssue({ code: "custom", message: "Schema audit fields must match the selected mode." });
});
export type AttemptResponseContractAudit = Readonly<z.infer<typeof attemptResponseContractAuditSchema>>;
export function readAttemptResponseContractAudit(value: unknown): AttemptResponseContractAudit { return attemptResponseContractAuditSchema.parse(value); }

export const responseContractOperationSchema = z.enum([
  "story_generation", "story_recovery", "story_choice_repair", "event_extension",
  "scene_coverage_rewrite", "story_continuity_review", "story_continuity_repair"
]);
export type ResponseContractOperation = z.infer<typeof responseContractOperationSchema>;

const responseContractInvocationResponseSchema = z.object({
  returnedModel: z.string().trim().min(1).max(256).nullable(),
  returnedProviderRoute: z.string().trim().min(1).max(256).nullable(),
  diagnosticCode: responseFormatDiagnosticCodeSchema.nullable()
}).strict();

export const responseContractInvocationAuditSchema = z.object({
  version: z.literal(1),
  id: hashSchema,
  logicalAttemptId: z.uuid(),
  invocationKey: responseInvocationKeySchema,
  operation: responseContractOperationSchema,
  requestPayloadHash: hashSchema,
  request: attemptResponseContractAuditSchema,
  status: z.enum(["reserved", "dispatched", "completed"]),
  reservedAt: z.iso.datetime(),
  dispatchedAt: z.iso.datetime().nullable(),
  completedAt: z.iso.datetime().nullable(),
  response: responseContractInvocationResponseSchema.nullable()
}).strict().superRefine((value, context) => {
  if (value.request.invocationKey !== value.invocationKey) {
    context.addIssue({ code: "custom", path: ["request", "invocationKey"], message: "Invocation request key must match its ledger key." });
  }
  if (value.status === "reserved" && (value.dispatchedAt !== null || value.completedAt !== null || value.response !== null)) {
    context.addIssue({ code: "custom", message: "Reserved invocation cannot contain dispatch or response data." });
  }
  if (value.status === "dispatched" && (value.dispatchedAt === null || value.completedAt !== null || value.response !== null)) {
    context.addIssue({ code: "custom", message: "Dispatched invocation must contain only its dispatch timestamp." });
  }
  if (value.status === "completed" && (value.dispatchedAt === null || value.completedAt === null || value.response === null)) {
    context.addIssue({ code: "custom", message: "Completed invocation must contain immutable response provenance." });
  }
});
export type ResponseContractInvocationAudit = Readonly<z.infer<typeof responseContractInvocationAuditSchema>>;
export function readResponseContractInvocationAudit(value: unknown): ResponseContractInvocationAudit {
  return responseContractInvocationAuditSchema.parse(value);
}

export function responseContractInvocationAuditId(
  jobId: string,
  logicalAttemptId: string,
  invocationKey: z.infer<typeof responseInvocationKeySchema>,
  operation: ResponseContractOperation,
  requestPayloadHash: string
): string {
  z.uuid().parse(jobId);
  z.uuid().parse(logicalAttemptId);
  responseInvocationKeySchema.parse(invocationKey);
  responseContractOperationSchema.parse(operation);
  hashSchema.parse(requestPayloadHash);
  return sha256Hex(JSON.stringify({ version: 1, jobId, logicalAttemptId, invocationKey, operation, requestPayloadHash }));
}
