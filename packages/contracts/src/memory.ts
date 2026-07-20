import { z } from "zod";

export const DEFAULT_EMBEDDING_MODEL = "text-embedding-nomic-embed-text-v1.5";
export const MAX_MEMORY_CONTEXT_BUDGET_TOKENS = 1_000_000;

export const compressionLevelSchema = z.enum(["auto", "full", "balanced", "compact", "summary"]);

export const memoryContextQuerySchema = z.object({
  budgetTokens: z.coerce.number().int().min(512).transform((value) => Math.min(value, MAX_MEMORY_CONTEXT_BUDGET_TOKENS)).default(32_000),
  compression: compressionLevelSchema.default("auto"),
  query: z.string().max(4000).default(""),
  recentTurns: z.coerce.number().int().min(1).max(100).default(8)
});

export const campaignEmbeddingConfigSchema = z.object({
  enabled: z.boolean().default(false),
  providerProfileId: z.uuid().nullable().default(null),
  model: z.string().trim().max(500).default(DEFAULT_EMBEDDING_MODEL),
  batchSize: z.coerce.number().int().min(1).max(128).default(16),
  documentPrefix: z.string().max(200).nullable().default(null),
  queryPrefix: z.string().max(200).nullable().default(null)
}).superRefine((value, context) => {
  if (value.enabled && !value.model) {
    context.addIssue({ code: "custom", path: ["model"], message: "An embedding model is required when semantic memory is enabled." });
  }
});

export type CompressionLevel = z.infer<typeof compressionLevelSchema>;
export type MemoryContextQuery = z.infer<typeof memoryContextQuerySchema>;
export type CampaignEmbeddingConfig = Omit<z.infer<typeof campaignEmbeddingConfigSchema>, "documentPrefix" | "queryPrefix"> & {
  documentPrefix?: string | null;
  queryPrefix?: string | null;
};
