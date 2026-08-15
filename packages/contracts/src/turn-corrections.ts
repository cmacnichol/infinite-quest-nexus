import { z } from "zod";

export const acceptedTurnCorrectionSourceSchema = z.enum([
  "user_edit",
  "legacy_import",
  "administrative"
]);

export const acceptedTurnCorrectionRequestSchema = z.object({
  turnId: z.uuid(),
  narration: z.string().trim().min(1).max(200_000),
  expectedCorrectionRevision: z.number().int().min(0),
  expectedActiveTurnNumber: z.number().int().min(1),
  reason: z.string().trim().min(1).max(2_000).optional(),
  source: acceptedTurnCorrectionSourceSchema.default("user_edit")
}).strict();

export const acceptedTurnCorrectionViewSchema = z.object({
  ownerUserId: z.uuid(),
  campaignId: z.uuid(),
  turnId: z.uuid(),
  turnNumber: z.number().int().positive(),
  correctionRevision: z.number().int().min(0),
  originalNarration: z.string().min(1).max(200_000),
  effectiveNarration: z.string().min(1).max(200_000),
  correctedAt: z.iso.datetime().nullable(),
  illustrationsMayBeStale: z.boolean()
}).strict();

export type AcceptedTurnCorrectionSource = z.infer<typeof acceptedTurnCorrectionSourceSchema>;
export type AcceptedTurnCorrectionRequest = z.infer<typeof acceptedTurnCorrectionRequestSchema>;
export type AcceptedTurnCorrectionView = z.infer<typeof acceptedTurnCorrectionViewSchema>;
