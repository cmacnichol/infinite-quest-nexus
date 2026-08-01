import { z } from "zod";

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
  issues: z.unknown().optional()
});

export type ApiErrorEnvelope = z.infer<typeof apiErrorEnvelopeSchema>;
