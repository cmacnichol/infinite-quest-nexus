import { z } from "zod";
import { textExecutionOverridesSchema } from "./text-execution-plan.js";
import { textModelSelectionSchema } from "./provider-selection.js";
import { textExecutionRouteBasisSchema } from "./text-execution-plan.js";
import { frozenResponseContractsV2Schema } from "./generation-response-contract.js";
import { sha256Hex } from "./hash.js";

const reviewSelectionSchema = z.object({
  selection: textModelSelectionSchema,
  overrides: textExecutionOverridesSchema.optional()
}).strict();

/** User-owned, credential-free reviewer intent saved on a text provider profile. */
export const continuityReviewExecutionPolicySchema = z.object({
  version: z.literal(1),
  primary: reviewSelectionSchema,
  fallback: reviewSelectionSchema.optional(),
  maximumAutomaticFallbacks: z.union([z.literal(0), z.literal(1)])
}).strict().superRefine((value, context) => {
  if (value.maximumAutomaticFallbacks === 1 && !value.fallback) {
    context.addIssue({ code: "custom", path: ["fallback"], message: "A fallback selection is required when one automatic fallback is enabled." });
  }
});

export const frozenContinuityReviewerRouteSchema = z.object({
  providerType: z.enum(["openrouter", "openai_compatible"]),
  routeBasis: textExecutionRouteBasisSchema,
  effectiveContextWindowTokens: z.number().int().positive(),
  effectiveOutputTokens: z.number().int().positive(),
  responseContracts: frozenResponseContractsV2Schema
}).strict().superRefine((value, context) => {
  const candidate = value.routeBasis.candidates[0];
  if (!candidate || value.effectiveContextWindowTokens > candidate.contextWindowTokens
    || value.effectiveOutputTokens > candidate.maxOutputTokens) {
    context.addIssue({ code: "custom", message: "Frozen reviewer limits must be within the captured route limits." });
  }
  if (value.responseContracts.queuedPolicy.authority.kind === "preset_trusted"
    && value.responseContracts.queuedPolicy.authority.routeBasisHash !== value.routeBasis.routeBasisHash) {
    context.addIssue({ code: "custom", path: ["responseContracts"], message: "Frozen reviewer response contract must bind the reviewer route." });
  }
  if (value.responseContracts.queuedPolicy.authority.kind === "model_verified"
    && value.responseContracts.queuedPolicy.authority.routeBasisHash !== value.routeBasis.routeBasisHash) {
    context.addIssue({ code: "custom", path: ["responseContracts"], message: "Frozen reviewer response contract must bind the reviewer route." });
  }
});

/** Server-owned job snapshot. Absence of a configured policy freezes an explicit disabled value. */
export const continuityReviewExecutionSnapshotSchema = z.object({
  version: z.literal(1),
  enabled: z.boolean(),
  maximumAutomaticFallbacks: z.union([z.literal(0), z.literal(1)]),
  primary: frozenContinuityReviewerRouteSchema.nullable(),
  fallback: frozenContinuityReviewerRouteSchema.nullable(),
  snapshotHash: z.string().regex(/^[a-f0-9]{64}$/u)
}).strict().superRefine((value, context) => {
  if (value.enabled !== (value.primary !== null)) context.addIssue({ code: "custom", message: "Enabled reviewer snapshots require a primary frozen route." });
  if (value.maximumAutomaticFallbacks === 1 && value.fallback === null) context.addIssue({ code: "custom", message: "Enabled fallback requires a frozen fallback route." });
  if (value.snapshotHash !== continuityReviewExecutionSnapshotHash(value)) context.addIssue({ code: "custom", path: ["snapshotHash"], message: "Reviewer execution snapshot hash differs." });
});

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
export function continuityReviewExecutionSnapshotHash(value: Omit<z.infer<typeof continuityReviewExecutionSnapshotSchema>, "snapshotHash"> | z.infer<typeof continuityReviewExecutionSnapshotSchema>): string {
  const { snapshotHash: _hash, ...unhashed } = value as z.infer<typeof continuityReviewExecutionSnapshotSchema>;
  return sha256Hex(canonicalJson(unhashed));
}

export type ContinuityReviewExecutionPolicy = Readonly<z.infer<typeof continuityReviewExecutionPolicySchema>>;
export type ContinuityReviewExecutionSnapshot = Readonly<z.infer<typeof continuityReviewExecutionSnapshotSchema>>;
