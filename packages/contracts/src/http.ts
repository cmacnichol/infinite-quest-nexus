import { z } from "zod";
import { physicalTextAccountingSchema } from "./physical-text-accounting.js";

export const apiTimestampSchema = z.union([z.iso.datetime(), z.date()]);

export const apiErrorDetailsSchema = z.object({
  code: z.string().trim().min(1).optional()
}).catchall(z.unknown());

export const apiErrorEnvelopeSchema = z.object({
  error: z.string().trim().min(1),
  message: z.string().trim().min(1),
  correlationId: z.string().trim().min(1),
  code: z.string().trim().min(1).optional(),
  details: apiErrorDetailsSchema,
  physicalAccounting: physicalTextAccountingSchema.optional(),
  issues: z.unknown().optional()
});

export type ApiErrorEnvelope = z.infer<typeof apiErrorEnvelopeSchema>;
