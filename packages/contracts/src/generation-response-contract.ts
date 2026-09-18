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
  if ((value.mode === "json_schema") !== (value.schemaVersion !== null && value.schemaHash !== null)) context.addIssue({ code: "custom", message: "Schema audit fields must match the selected mode." });
});
export type AttemptResponseContractAudit = Readonly<z.infer<typeof attemptResponseContractAuditSchema>>;
export function readAttemptResponseContractAudit(value: unknown): AttemptResponseContractAudit { return attemptResponseContractAuditSchema.parse(value); }

export function responseContractInvocationAuditId(jobId: string, invocationKey: z.infer<typeof responseInvocationKeySchema>, logicalOperation: number): string {
  if (!Number.isSafeInteger(logicalOperation) || logicalOperation < 1) throw new Error("Logical operation must be a positive integer.");
  return sha256Hex(JSON.stringify({ version: 1, jobId, invocationKey, logicalOperation }));
}
