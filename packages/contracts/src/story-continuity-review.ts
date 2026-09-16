import { z } from "zod";

type DeepReadonly<T> = T extends readonly (infer U)[] ? readonly DeepReadonly<U>[]
  : T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T;

const pointer = z.string().regex(/^(?:\/(?:[^~/]|~[01])*)*$/);
const outputLocation = z.object({ path: pointer, start: z.number().int().min(0), end: z.number().int().min(1), quote: z.string().min(1).max(1_000) }).strict()
  .refine(({ start, end, quote }) => end > start && end - start === quote.length, "Output location must exactly bound its UTF-16 quotation.");
export const reviewEvidenceReferenceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("source"), evidenceId: z.string().regex(/^[a-f0-9]{64}$/), quote: z.string().min(1).max(1_000) }).strict(),
  z.object({ kind: z.literal("candidate"), draftHash: z.string().regex(/^[a-f0-9]{64}$/), location: outputLocation }).strict()
]);
export type ReviewEvidenceReference = DeepReadonly<z.infer<typeof reviewEvidenceReferenceSchema>>;
const category = z.enum(["world_rule", "character_attribute", "relationship", "chronology", "location", "object_state", "thread_loss", "direction_coverage", "replacement_state"]);
const contradiction = z.object({
  kind: z.literal("contradiction"), category, severity: z.literal("contradiction"),
  basis: reviewEvidenceReferenceSchema, output: outputLocation, explanation: z.string().min(1).max(1_000)
}).strict();
const omission = z.object({
  kind: z.literal("omission"), category: z.enum(["thread_loss", "direction_coverage", "replacement_state"]), severity: z.literal("warning"),
  expectedEvidenceIds: z.array(z.string().regex(/^[a-f0-9]{64}$/)).min(1).max(20).refine((ids) => new Set(ids).size === ids.length), outputPath: pointer, explanation: z.string().min(1).max(1_000)
}).strict();
export const continuityFindingSchema = z.union([contradiction, omission]);
export const continuityReviewSchema = z.object({ version: z.literal("story-continuity-review-v1"), verdict: z.enum(["pass", "conflict", "uncertain"]), findings: z.array(continuityFindingSchema).max(20) }).strict()
  .superRefine((value, context) => {
    if (value.verdict === "pass" && value.findings.some((finding) => finding.kind === "contradiction")) context.addIssue({ code: "custom", path: ["verdict"], message: "A pass cannot contain contradictions." });
    if (value.verdict === "conflict" && !value.findings.some((finding) => finding.kind === "contradiction")) context.addIssue({ code: "custom", path: ["verdict"], message: "A conflict requires an evidence-supported contradiction." });
    if (JSON.stringify(value).length > 20_000) context.addIssue({ code: "custom", message: "Review exceeds the serialized size limit." });
  });
export type ContinuityCategory = z.infer<typeof category>;
export type OutputLocation = DeepReadonly<z.infer<typeof outputLocation>>;
export type ContinuityFinding = DeepReadonly<z.infer<typeof continuityFindingSchema>>;
export type ContinuityReview = DeepReadonly<z.infer<typeof continuityReviewSchema>>;

/** Metadata is not the complete executor checkpoint. Payload validation remains caller-owned. */
export const storyContinuityCheckpointMetadataV3Schema = z.object({
  contextProtocol: z.literal("current-continuity-v3"), outputProtocol: z.literal("story-output-v2"),
  memoryPolicyHash: z.string().regex(/^[a-f0-9]{64}$/), evidenceManifestHash: z.string().regex(/^[a-f0-9]{64}$/),
  review: z.discriminatedUnion("status", [
    z.object({ status: z.literal("not_requested"), result: z.null() }).strict(),
    z.object({ status: z.literal("pending"), result: z.null() }).strict(),
    z.object({ status: z.literal("completed"), result: continuityReviewSchema }).strict()
  ]).optional()
}).strict();
export type StoryContinuityCheckpointMetadataV3 = DeepReadonly<z.infer<typeof storyContinuityCheckpointMetadataV3Schema>>;
export function createStoryContinuityCheckpointV3Schema<T extends z.ZodType>(checkpoint: T) {
  return z.object({ version: z.literal(3), metadata: storyContinuityCheckpointMetadataV3Schema, checkpoint }).strict();
}
export type StoryContinuityCheckpointV3<T> = Readonly<{ version: 3; metadata: StoryContinuityCheckpointMetadataV3; checkpoint: T }>;

/** No migration or defaulting: downstream executors must supply their complete payload schema. */
export function readStoryContinuityCheckpoint<T extends z.ZodType>(value: unknown, payloadSchema: T):
  Readonly<{ kind: "legacy_v2"; checkpoint: z.output<T> }> | Readonly<{ kind: "v3"; envelope: z.output<ReturnType<typeof createStoryContinuityCheckpointV3Schema<T>>> }> {
  const version = z.object({ version: z.number().int() }).safeParse(value);
  if (version.success && version.data.version === 2) {
    const checkpoint = payloadSchema.safeParse(value);
    if (checkpoint.success) return { kind: "legacy_v2", checkpoint: checkpoint.data };
  }
  if (version.success && version.data.version === 3) {
    const envelope = createStoryContinuityCheckpointV3Schema(payloadSchema).safeParse(value);
    if (envelope.success) return { kind: "v3", envelope: envelope.data };
  }
  throw Object.assign(new Error("Incompatible continuity checkpoint; discard and reenqueue generation."), {
    code: "generation_checkpoint_incompatible", recoveryAction: "discard_and_reenqueue"
  });
}
