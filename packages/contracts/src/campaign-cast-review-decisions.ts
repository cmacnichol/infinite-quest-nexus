import { z } from "zod";
import { castBoundarySchema, castWriteBase } from "./campaign-cast.js";
import { castDiscoveryCandidateSchema, castDiscoverySourceSchema } from "./campaign-cast-discovery.js";

const ordinal = z.number().int().nonnegative();
const index = ordinal.max(19);
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const base = { ...castWriteBase, sourceHash: hash, expectedReviewRevision: ordinal };
export const reviewDecisionRequestSchema = z.discriminatedUnion("action", [
  z.object({ ...base, action: z.literal("dismiss_identity") }).strict(),
  z.object({ ...base, action: z.literal("dismiss_detail"), observationIndex: index }).strict(),
  z.object({ ...base, action: z.literal("restore"), decisionId: z.uuid() }).strict()
]);
export const reviewDecisionResultSchema = z.object({ decisionId: z.uuid(), candidateId: z.uuid(), reviewRevision: ordinal,
  revision: ordinal, boundary: castBoundarySchema, disposition: z.enum(["dismiss_identity", "dismiss_detail", "restore"]) }).strict();
export const dismissedReviewQuerySchema = z.object({ cursor: z.uuid().optional(), limit: z.coerce.number().int().min(1).max(50).default(20) }).strict();
export const dismissedReviewItemSchema = z.object({ decisionId: z.uuid(), candidateId: z.uuid(),
  source: castDiscoverySourceSchema, target: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("identity"), proposal: castDiscoveryCandidateSchema }).strict(),
    z.object({ kind: z.literal("detail"), observationIndex: index, observation: castDiscoveryCandidateSchema.shape.observations.element }).strict()
  ]), canRestore: z.boolean() }).strict();
export const dismissedReviewPageSchema = z.object({ reviewRevision: ordinal, revision: ordinal, boundary: castBoundarySchema,
  decisions: z.array(dismissedReviewItemSchema).max(50), nextCursor: z.uuid().nullable() }).strict();
export type ReviewDecisionRequest = z.infer<typeof reviewDecisionRequestSchema>;
export type ReviewDecisionResult = z.infer<typeof reviewDecisionResultSchema>;
export type DismissedReviewPage = z.infer<typeof dismissedReviewPageSchema>;
