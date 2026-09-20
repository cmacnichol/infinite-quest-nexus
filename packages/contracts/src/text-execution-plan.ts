import { z } from "zod";
import { textModelSelectionSchema } from "./provider-selection.js";
import { sha256Hex } from "./hash.js";

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const positiveIntegerSchema = z.number().int().positive();
const finiteNumberSchema = z.number().finite();

export const textGenerationParametersSchema = z.object({
  temperature: finiteNumberSchema.min(0).max(2).optional(), top_p: finiteNumberSchema.min(0).max(1).optional(), top_k: z.number().int().min(0).optional(), frequency_penalty: finiteNumberSchema.min(-2).max(2).optional(), presence_penalty: finiteNumberSchema.min(-2).max(2).optional(), repetition_penalty: finiteNumberSchema.positive().optional(), min_p: finiteNumberSchema.min(0).max(1).optional(), top_a: finiteNumberSchema.min(0).max(1).optional(), seed: z.number().int().min(0).optional(), max_tokens: positiveIntegerSchema.optional(), max_completion_tokens: positiveIntegerSchema.optional()
}).strict();

export const providerRoutingPolicySchema = z.object({
  order: z.array(z.string().trim().min(1)).max(64).optional(), only: z.array(z.string().trim().min(1)).max(64).optional(), ignore: z.array(z.string().trim().min(1)).max(64).optional(), allow_fallbacks: z.boolean().optional(), require_parameters: z.boolean().optional(), data_collection: z.enum(["allow", "deny"]).optional(), sort: z.enum(["price", "throughput", "latency"]).optional(), quantizations: z.array(z.string().trim().min(1)).max(64).optional(), enforce_distillable_text: z.boolean().optional(), preferred_min_throughput: finiteNumberSchema.min(0).optional(), preferred_max_latency: finiteNumberSchema.min(0).optional(), max_price: z.object({ prompt: finiteNumberSchema.min(0).optional(), completion: finiteNumberSchema.min(0).optional(), image: finiteNumberSchema.min(0).optional(), request: finiteNumberSchema.min(0).optional() }).strict().refine((value) => Object.keys(value).length > 0).optional(), zdr: z.boolean().optional()
}).strict().superRefine((value, context) => {
  if (value.order && value.sort) context.addIssue({ code: "custom", path: ["sort"], message: "provider.sort cannot be combined with provider.order." });
});

export const textRouteCandidateSchema = z.object({ modelId: z.string().trim().min(1).max(500), providerPolicy: providerRoutingPolicySchema, contextWindowTokens: positiveIntegerSchema, maxOutputTokens: positiveIntegerSchema }).strict();

/**
 * Prompt-independent immutable route evidence captured before generation is
 * queued. Story operation prompts are not all known at enqueue time; callers
 * derive a complete TextExecutionPlan from this basis only when they have the
 * frozen template and bounded dynamic repair input for an invocation.
 */
const textExecutionRouteShape = {
  version: z.literal(2), selection: textModelSelectionSchema,
  preset: z.object({ slug: z.string().trim().min(1).max(200), versionId: z.string().trim().min(1).max(500), configHash: hashSchema }).strict().nullable(),
  candidates: z.array(textRouteCandidateSchema).min(1).max(32), presetSystemPrompt: z.string().max(200_000),
  parameters: textGenerationParametersSchema, endpointReference: z.string().trim().min(1).max(500),
  credentialReference: z.string().trim().min(1).max(500).nullable(), profileRevision: z.string().trim().min(1).max(500),
  authorityRevision: z.string().trim().min(1).max(500).optional(), requestTimeoutMs: positiveIntegerSchema.optional(),
  protocolVersion: z.string().trim().min(1).max(500)
};

export const textExecutionRouteBasisSchema = z.object({
  ...textExecutionRouteShape, requestTimeoutMs: positiveIntegerSchema, routeBasisHash: hashSchema
}).strict();

export const textExecutionPlanSchema = z.object({
  ...textExecutionRouteShape, prompt: z.string().min(1).max(400_000), promptHash: hashSchema,
  /** Present only for plans derived from a frozen route basis. */
  routeBasisHash: hashSchema.optional(), planHash: hashSchema
}).strict();

export const textExecutionPlanPublicSummarySchema = z.object({ version: z.literal(2), selection: textModelSelectionSchema, preset: z.object({ slug: z.string().trim().min(1), versionId: z.string().trim().min(1), configHash: hashSchema }).strict().nullable(), candidates: z.array(textRouteCandidateSchema).min(1), parameters: textGenerationParametersSchema, planHash: hashSchema }).strict();

export type TextGenerationParameters = Readonly<z.infer<typeof textGenerationParametersSchema>>;
export type ProviderRoutingPolicy = Readonly<z.infer<typeof providerRoutingPolicySchema>>;
export type TextRouteCandidate = Readonly<z.infer<typeof textRouteCandidateSchema>>;
export type TextExecutionRouteBasis = Readonly<z.infer<typeof textExecutionRouteBasisSchema>>;
export type TextExecutionPlan = Readonly<z.infer<typeof textExecutionPlanSchema>>;
export type TextExecutionPlanPublicSummary = Readonly<z.infer<typeof textExecutionPlanPublicSummarySchema>>;

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

export function textExecutionRouteBasisHash(value: unknown): string {
  const parsed = textExecutionRouteBasisSchema.parse(value);
  const { routeBasisHash: _hash, ...unhashed } = parsed;
  return sha256Hex(canonicalJson(unhashed));
}
export function readTextExecutionRouteBasis(value: unknown): TextExecutionRouteBasis {
  const parsed = textExecutionRouteBasisSchema.parse(value);
  if (parsed.routeBasisHash !== textExecutionRouteBasisHash(parsed)) throw new Error("Text execution route basis hash is invalid.");
  return parsed;
}
export function textExecutionPlanHash(value: unknown): string {
  const parsed = textExecutionPlanSchema.parse(value);
  const { planHash: _hash, ...unhashed } = parsed;
  return sha256Hex(canonicalJson(unhashed));
}
export function readTextExecutionPlan(value: unknown): TextExecutionPlan {
  const parsed = textExecutionPlanSchema.parse(value);
  if (parsed.planHash !== textExecutionPlanHash(parsed)) throw new Error("Text execution plan hash is invalid.");
  return parsed;
}

/** Shared pure composition for frozen route-basis consumers; no provider or runtime dependency. */
export function composeTextExecutionPrompt(input: Readonly<{ presetPrompt: string; operationPrompt: string }>): string {
  const presetPrompt = input.presetPrompt.trim();
  const operationPrompt = input.operationPrompt.trim();
  if (!operationPrompt) throw new Error("An operation prompt is required.");
  return presetPrompt ? `${presetPrompt}\n\n${operationPrompt}` : operationPrompt;
}

/** Derives every inherited plan field from a verified saved route basis and trusted operation prompt. */
export function deriveTextExecutionPlan(routeBasisValue: unknown, operationPrompt: string): TextExecutionPlan {
  const basis = readTextExecutionRouteBasis(routeBasisValue);
  const prompt = composeTextExecutionPrompt({ presetPrompt: basis.presetSystemPrompt, operationPrompt });
  const planWithoutHash = {
    version: basis.version,
    selection: basis.selection,
    preset: basis.preset,
    candidates: basis.candidates,
    presetSystemPrompt: basis.presetSystemPrompt,
    parameters: basis.parameters,
    prompt,
    promptHash: sha256Hex(prompt),
    endpointReference: basis.endpointReference,
    credentialReference: basis.credentialReference,
    profileRevision: basis.profileRevision,
    ...(basis.authorityRevision === undefined ? {} : { authorityRevision: basis.authorityRevision }),
    requestTimeoutMs: basis.requestTimeoutMs,
    protocolVersion: basis.protocolVersion,
    routeBasisHash: basis.routeBasisHash,
    planHash: "0".repeat(64)
  };
  const parsedWithoutHash = textExecutionPlanSchema.parse(planWithoutHash);
  const planHash = textExecutionPlanHash(parsedWithoutHash);
  return deepFreeze(textExecutionPlanSchema.parse({ ...parsedWithoutHash, planHash }));
}

export function publicTextExecutionPlanSummary(plan: TextExecutionPlan): TextExecutionPlanPublicSummary {
  return textExecutionPlanPublicSummarySchema.parse({ version: plan.version, selection: plan.selection, preset: plan.preset, candidates: plan.candidates, parameters: plan.parameters, planHash: plan.planHash });
}
