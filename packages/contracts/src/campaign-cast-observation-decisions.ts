import { z } from "zod";
import { castBoundarySchema, castFieldSchema, castObservationSchema, castWriteBase, castWriteResultSchema } from "./campaign-cast.js";

const decisionBase = { ...castWriteBase, expectedCharacterRevision: z.number().int().nonnegative() };
export const observationDecisionRequestSchema = z.discriminatedUnion("action", [
  z.object({ ...decisionBase, action: z.literal("retract") }).strict(),
  z.object({ ...decisionBase, action: z.literal("restore"), retractionEventId: z.uuid() }).strict()
]);
export const observationDecisionPreviewSchema = z.object({
  field: castFieldSchema, currentValue: z.string().nullable(), projectedValue: z.string().nullable(),
  currentConflict: z.boolean(), projectedConflict: z.boolean(), source: castObservationSchema,
  castRevision: z.number().int().nonnegative(), characterRevision: z.number().int().nonnegative(), boundary: castBoundarySchema
}).strict();
export const observationDecisionResultSchema = castWriteResultSchema.extend({
  observationId: z.uuid(), disposition: z.enum(["retracted", "restored"]), decisionEventId: z.uuid()
}).strict();
export type ObservationDecisionRequest = z.infer<typeof observationDecisionRequestSchema>;
export type ObservationDecisionPreview = z.infer<typeof observationDecisionPreviewSchema>;
export type ObservationDecisionResult = z.infer<typeof observationDecisionResultSchema>;
