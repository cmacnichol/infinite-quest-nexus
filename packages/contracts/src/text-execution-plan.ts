import { z } from "zod";
import { textModelSelectionSchema } from "./provider-selection.js";

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

export function publicTextExecutionPlanSummary(plan: TextExecutionPlan): TextExecutionPlanPublicSummary {
  return textExecutionPlanPublicSummarySchema.parse({ version: plan.version, selection: plan.selection, preset: plan.preset, candidates: plan.candidates, parameters: plan.parameters, planHash: plan.planHash });
}
