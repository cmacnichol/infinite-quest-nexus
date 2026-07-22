import { z } from "zod";

export const campaignTransferFindingSchema = z.object({
  code: z.string().trim().min(1).max(100),
  severity: z.enum(["blocking", "warning", "info"]),
  scope: z.enum(["world", "character", "state", "jobs", "assets"]),
  message: z.string().trim().min(1).max(2_000),
  details: z.record(z.string(), z.unknown()).optional()
});

export const campaignTransferPreviewRequestSchema = z.object({
  targetWorldVersionId: z.uuid(),
  title: z.string().trim().min(1).max(200).optional(),
  characterStrategy: z.literal("preserve_source").default("preserve_source"),
  stateStrategy: z.literal("preserve").default("preserve"),
  targetDefaultsPolicy: z.literal("retain_source").default("retain_source")
}).strict();

export const campaignTransferCommitRequestSchema = campaignTransferPreviewRequestSchema.extend({
  idempotencyKey: z.uuid(),
  expectedActiveTurnNumber: z.coerce.number().int().nonnegative(),
  expectedStateRevision: z.coerce.number().int().nonnegative(),
  sourceFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  note: z.string().trim().max(10_000).default("")
}).strict();

export type CampaignTransferFinding = z.infer<typeof campaignTransferFindingSchema>;
export type CampaignTransferPreviewRequest = z.infer<typeof campaignTransferPreviewRequestSchema>;
export type CampaignTransferCommitRequest = z.infer<typeof campaignTransferCommitRequestSchema>;
