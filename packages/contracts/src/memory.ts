import { z } from "zod";

export const compressionLevelSchema = z.enum(["auto", "full", "balanced", "compact", "summary"]);

export const memoryContextQuerySchema = z.object({
  budgetTokens: z.coerce.number().int().min(512).max(1_000_000).default(32_000),
  compression: compressionLevelSchema.default("auto"),
  query: z.string().max(4000).default(""),
  recentTurns: z.coerce.number().int().min(1).max(100).default(8)
});

export const campaignEmbeddingConfigSchema = z.object({
  enabled: z.boolean().default(false),
  providerProfileId: z.uuid().nullable().default(null),
  model: z.string().trim().max(500).default(""),
  batchSize: z.coerce.number().int().min(1).max(128).default(16)
}).superRefine((value, context) => {
  if (value.enabled && !value.providerProfileId) {
    context.addIssue({ code: "custom", path: ["providerProfileId"], message: "An embedding provider is required when semantic memory is enabled." });
  }
  if (value.enabled && !value.model) {
    context.addIssue({ code: "custom", path: ["model"], message: "An embedding model is required when semantic memory is enabled." });
  }
});

export type CompressionLevel = z.infer<typeof compressionLevelSchema>;
export type MemoryContextQuery = z.infer<typeof memoryContextQuerySchema>;
export type CampaignEmbeddingConfig = z.infer<typeof campaignEmbeddingConfigSchema>;
