import { z } from "zod";
import { sha256Hex } from "./hash.js";
import {
  preparedResponseContractSchema,
  preparedResponseContractV2Schema,
  responseContractAdmissionSchema,
  responseFormatDiagnosticCodeSchema,
  responseInvocationKeySchema,
  responseInvocationKeyV2Schema
} from "./text-response-format.js";
import { getProviderOutputSchemaV2, stableJsonHash } from "./provider-output-schema.js";
import { readTextExecutionPlan, readTextExecutionRouteBasis, type TextExecutionPlan, type TextExecutionRouteBasis } from "./text-execution-plan.js";
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
  for (const [key, contract] of Object.entries(value.contracts)) {
    if (contract.mode === "json_schema" && contract.schemaHash !== sha256Hex(canonicalJson(contract.schema))) {
      context.addIssue({ code: "custom", path: ["contracts", key, "schemaHash"], message: "Frozen schema body does not match its digest." });
    }
  }
  if (value.queuedPolicy.policy === "required" && Object.values(value.contracts).some((contract) => contract.mode !== "json_schema")) {
    context.addIssue({ code: "custom", path: ["contracts"], message: "Required queued policy permits only schema-mode contracts." });
  }
  if (value.selectionHash !== frozenResponseContractsSelectionHash(value)) {
    context.addIssue({ code: "custom", path: ["selectionHash"], message: "Frozen response-contract selection hash is invalid." });
  }
});
export type FrozenResponseContracts = Readonly<z.infer<typeof frozenResponseContractsSchema>>;
/** Digest all selected evidence and contract bodies, excluding its own digest field. */
export function frozenResponseContractsSelectionHash(value: Readonly<Record<string, unknown>>): string {
  const { selectionHash: _selectionHash, ...selection } = value;
  return sha256Hex(canonicalJson(selection));
}
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

const invocationKeysV2Schema = z.array(responseInvocationKeyV2Schema).min(1).max(17).superRefine((keys, context) => {
  if (new Set(keys).size !== keys.length) context.addIssue({ code: "custom", message: "Invocation keys must be unique." });
});
const directResponseContractAuthorityV2Schema = z.object({
  kind: z.literal("model_verified"), providerProfileId: z.uuid(), endpointIdentity: z.string().trim().min(1).max(512), model: z.string().trim().min(1).max(512),
  providerConfigurationHash: hashSchema, routeConfigHash: hashSchema, verificationRegistryHash: hashSchema
}).strict();
const presetResponseContractAuthorityV2Schema = z.object({
  kind: z.literal("preset_trusted"), routeBasisHash: hashSchema,
  selection: z.object({ kind: z.literal("openrouter_preset"), slug: z.string().trim().min(1).max(200) }).strict(),
  endpointReference: z.string().trim().min(1).max(500), credentialReference: z.string().trim().min(1).max(500).nullable(),
  authorityRevision: z.string().trim().min(1).max(500), profileRevision: z.string().trim().min(1).max(500)
}).strict();
const responseContractAuthorityV2Schema = z.discriminatedUnion("kind", [directResponseContractAuthorityV2Schema, presetResponseContractAuthorityV2Schema]);

/** Parallel new-work policy. Historical v1 readers deliberately remain untouched. */
export const queuedResponsePolicyV2Schema = z.object({
  version: z.literal(2), policy: z.literal("required"), providerProfileId: z.uuid(), admission: responseContractAdmissionSchema,
  authority: responseContractAuthorityV2Schema, operationClosureVersion: z.literal(2), invocationKeys: invocationKeysV2Schema
}).strict().superRefine((value, context) => {
  if (value.admission.basis !== value.authority.kind) {
    context.addIssue({ code: "custom", path: ["authority"], message: "Queued admission and authority must agree." });
  }
  if (value.admission.basis === "preset_trusted" && value.authority.kind === "preset_trusted"
    && value.authority.selection.kind !== "openrouter_preset") {
    context.addIssue({ code: "custom", path: ["authority", "selection"], message: "Trusted preset authority requires a preset selection." });
  }
  if (value.admission.basis === "model_verified" && value.authority.kind === "model_verified"
    && value.providerProfileId !== value.authority.providerProfileId) {
    context.addIssue({ code: "custom", path: ["authority", "providerProfileId"], message: "Queued direct-model profile must match verified authority." });
  }
});
export type QueuedResponsePolicyV2 = Readonly<z.infer<typeof queuedResponsePolicyV2Schema>>;
export function readQueuedResponsePolicyV2(value: unknown): QueuedResponsePolicyV2 {
  const parsed = queuedResponsePolicyV2Schema.safeParse(value);
  if (!parsed.success) throw new Error("Queued v2 response policy is invalid or incompatible.");
  return parsed.data;
}

function contractV2MatchesKey(key: z.infer<typeof responseInvocationKeyV2Schema>, contract: z.infer<typeof preparedResponseContractV2Schema>): boolean {
  const [operation, delivery] = key.split(":") as [string, string];
  return contract.operation === operation && contract.streaming === (delivery === "stream");
}

export const frozenResponseContractsV2Schema = z.object({
  version: z.literal(2), queuedPolicy: queuedResponsePolicyV2Schema, selectedAt: z.iso.datetime(), capabilityEvidenceHash: hashSchema,
  contracts: z.partialRecord(responseInvocationKeyV2Schema, preparedResponseContractV2Schema), selectionHash: hashSchema
}).strict().superRefine((value, context) => {
  const keys = new Set(value.queuedPolicy.invocationKeys);
  for (const [key, contract] of Object.entries(value.contracts)) {
    if (!keys.has(key as z.infer<typeof responseInvocationKeyV2Schema>) || !contractV2MatchesKey(key as z.infer<typeof responseInvocationKeyV2Schema>, contract)) {
      context.addIssue({ code: "custom", path: ["contracts", key], message: "Frozen v2 response contract does not match its queued invocation." });
    }
    if (contract.schemaHash !== stableJsonHash(contract.schema)) {
      context.addIssue({ code: "custom", path: ["contracts", key, "schemaHash"], message: "Frozen v2 schema body does not match its digest." });
    }
    const catalogOperation = responseInvocationKeyV2Schema.options.find((candidate) => candidate.split(":")[0] === contract.operation)?.split(":")[0];
    if (!catalogOperation) context.addIssue({ code: "custom", path: ["contracts", key, "operation"], message: "Frozen v2 contract operation is unknown." });
    else {
      const catalog = getProviderOutputSchemaV2(catalogOperation as Parameters<typeof getProviderOutputSchemaV2>[0]);
      if (contract.schemaVersion !== catalog.version || contract.schemaName !== catalog.name || contract.schemaHash !== catalog.schemaHash
        || canonicalJson(contract.schema) !== canonicalJson(catalog.schema)) {
        context.addIssue({ code: "custom", path: ["contracts", key], message: "Frozen v2 contract must use the exact catalog schema." });
      }
    }
    if (contract.admission.basis !== value.queuedPolicy.admission.basis || contract.authority.kind !== value.queuedPolicy.authority.kind) {
      context.addIssue({ code: "custom", path: ["contracts", key, "authority"], message: "Frozen v2 contract authority does not match its queue policy." });
    }
    if (contract.authority.kind === "model_verified" && value.queuedPolicy.authority.kind === "model_verified") {
      const authority = value.queuedPolicy.authority;
      if (contract.authority.providerProfileId !== authority.providerProfileId || contract.authority.endpointIdentity !== authority.endpointIdentity
        || contract.authority.model !== authority.model || contract.authority.providerConfigurationHash !== authority.providerConfigurationHash || contract.authority.routeConfigHash !== authority.routeConfigHash
        || contract.authority.verificationRegistryHash !== authority.verificationRegistryHash) {
        context.addIssue({ code: "custom", path: ["contracts", key, "authority"], message: "Frozen model contract authority changed." });
      }
    }
    if (contract.authority.kind === "preset_trusted" && value.queuedPolicy.authority.kind === "preset_trusted"
      && contract.authority.routeBasisHash !== value.queuedPolicy.authority.routeBasisHash) {
      context.addIssue({ code: "custom", path: ["contracts", key, "authority", "routeBasisHash"], message: "Frozen preset contract route basis changed." });
    }
  }
  for (const key of keys) if (!Object.hasOwn(value.contracts, key)) {
    context.addIssue({ code: "custom", path: ["contracts", key], message: "Each queued v2 invocation requires a frozen contract." });
  }
  if (value.selectionHash !== frozenResponseContractsV2SelectionHash(value)) {
    context.addIssue({ code: "custom", path: ["selectionHash"], message: "Frozen v2 response-contract selection hash is invalid." });
  }
});
export type FrozenResponseContractsV2 = Readonly<z.infer<typeof frozenResponseContractsV2Schema>>;
export function frozenResponseContractsV2SelectionHash(value: Readonly<Record<string, unknown>>): string {
  const { selectionHash: _selectionHash, ...selection } = value;
  return sha256Hex(canonicalJson(selection));
}
export function readFrozenResponseContractsV2(value: unknown): FrozenResponseContractsV2 {
  const parsed = frozenResponseContractsV2Schema.safeParse(value);
  if (!parsed.success) throw new Error("Frozen v2 response contracts are invalid or incompatible.");
  return parsed.data;
}

/**
 * Explicit pure binding seam for Task 4B/4C. A preset hash-shaped string is
 * insufficient: callers must validate the saved basis and exact derived plan.
 */
export function assertPresetResponseContractAuthorityBinding(
  policy: QueuedResponsePolicyV2,
  contract: z.infer<typeof preparedResponseContractV2Schema>,
  routeBasisValue: unknown,
  planValue: unknown
): Readonly<{ routeBasis: TextExecutionRouteBasis; plan: TextExecutionPlan }> {
  if (policy.authority.kind !== "preset_trusted" || contract.authority.kind !== "preset_trusted") {
    throw new Error("Preset response-contract binding requires preset-trusted authority.");
  }
  const routeBasis = readTextExecutionRouteBasis(routeBasisValue);
  const plan = readTextExecutionPlan(planValue);
  const authority = policy.authority;
  if (routeBasis.routeBasisHash !== authority.routeBasisHash || routeBasis.selection.kind !== "openrouter_preset"
    || routeBasis.selection.slug !== authority.selection.slug || routeBasis.endpointReference !== authority.endpointReference
    || routeBasis.credentialReference !== authority.credentialReference || routeBasis.authorityRevision !== authority.authorityRevision
    || routeBasis.profileRevision !== authority.profileRevision || plan.routeBasisHash !== routeBasis.routeBasisHash
    || plan.planHash !== contract.authority.planHash || contract.authority.routeBasisHash !== routeBasis.routeBasisHash) {
    throw new Error("Preset response-contract basis or plan identity changed.");
  }
  return Object.freeze({ routeBasis, plan });
}
