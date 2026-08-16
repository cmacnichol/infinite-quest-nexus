import { z } from "zod";

export const DEFAULT_EMBEDDING_MODEL = "text-embedding-nomic-embed-text-v1.5";
export const MAX_MEMORY_CONTEXT_BUDGET_TOKENS = 1_000_000;

export const compressionLevelSchema = z.enum(["auto", "full", "balanced", "compact", "summary"]);
export const retrievalImplementationSchema = z.enum(["legacy_hybrid", "chunked_hybrid"]);
export const chronicleRetrievalComparisonImplementationSchema = z.enum([
  "lexical",
  "legacy_hybrid",
  "chunked_hybrid"
]);

const safeTelemetryCodeSchema = z.string().min(1).max(200).regex(/^[a-z0-9][a-z0-9_.:-]*$/u);
const safeFingerprintSchema = z.string().min(1).max(512).regex(/^[A-Za-z0-9_.:-]+$/u);
const nonnegativeIntegerSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

export const CHRONICLE_RETRIEVAL_VERSION = "chronicle-retrieval-v1";

export const chronicleRetrievalCandidateSchema = z.object({
  candidateId: z.string().min(1).max(200).regex(/^[A-Za-z0-9_.:-]+$/u),
  parentMemoryId: z.uuid(),
  rank: z.number().int().min(1).max(10_000),
  reason: safeTelemetryCodeSchema,
  tokenEstimate: nonnegativeIntegerSchema,
  selected: z.boolean()
}).strict();

export const chronicleRetrievalComparisonSchema = z.object({
  implementation: chronicleRetrievalComparisonImplementationSchema,
  latencyMs: nonnegativeIntegerSchema,
  fallbackCode: safeTelemetryCodeSchema.nullable(),
  selectedForProduction: z.boolean(),
  candidates: z.array(chronicleRetrievalCandidateSchema).max(1_000)
}).strict();

export const chronicleRetrievalRunSchema = z.object({
  ownerUserId: z.uuid(),
  campaignId: z.uuid(),
  worldVersionId: z.uuid(),
  queryHash: z.string().regex(/^[0-9a-f]{64}$/u),
  productionImplementation: retrievalImplementationSchema,
  shadowEnabled: z.boolean(),
  retrievalVersion: safeTelemetryCodeSchema,
  embeddingProtocolVersion: safeTelemetryCodeSchema,
  chunkProtocolVersion: safeTelemetryCodeSchema,
  providerFingerprint: safeFingerprintSchema.nullable(),
  queryTokenEstimate: nonnegativeIntegerSchema,
  costIds: z.array(z.uuid()).max(100),
  comparisons: z.array(chronicleRetrievalComparisonSchema).min(1).max(3)
}).strict().superRefine((run, context) => {
  const implementations = new Set(run.comparisons.map((comparison) => comparison.implementation));
  if (implementations.size !== run.comparisons.length) {
    context.addIssue({ code: "custom", path: ["comparisons"], message: "Each retrieval implementation may appear only once." });
  }
  const production = run.comparisons.filter((comparison) => comparison.selectedForProduction);
  if (production.length !== 1 || production[0]?.implementation !== run.productionImplementation) {
    context.addIssue({
      code: "custom",
      path: ["comparisons"],
      message: "Exactly the configured production implementation must be selected for production."
    });
  }
  if (run.shadowEnabled && implementations.size !== chronicleRetrievalComparisonImplementationSchema.options.length) {
    context.addIssue({
      code: "custom",
      path: ["comparisons"],
      message: "Shadow telemetry must include lexical, legacy hybrid, and chunked hybrid comparisons."
    });
  }
  if (!run.shadowEnabled && run.comparisons.length !== 1) {
    context.addIssue({
      code: "custom",
      path: ["comparisons"],
      message: "Non-shadow telemetry may include only the configured production comparison."
    });
  }
});

export const chronicleHealthStatusSchema = z.enum([
  "chronicle_available",
  "semantic_disabled",
  "indexing",
  "healthy",
  "partially_indexed",
  "provider_degraded",
  "provider_unavailable",
  "fallback_active",
  "chunk_protocol_outdated",
  "rebuild_required"
]);

const chronicleHealthProgressSchema = z.object({
  embedded: nonnegativeIntegerSchema.optional(),
  total: nonnegativeIntegerSchema.optional(),
  updated: nonnegativeIntegerSchema.optional(),
  skipped: nonnegativeIntegerSchema.optional(),
  processedParents: nonnegativeIntegerSchema.optional(),
  totalParents: nonnegativeIntegerSchema.optional(),
  embeddedChunks: nonnegativeIntegerSchema.optional(),
  skippedChunks: nonnegativeIntegerSchema.optional()
}).strict();

const chronicleHealthShape = {
  message: z.string().max(500),
  chronicleAvailable: z.literal(true),
  enabled: z.boolean(),
  providerProfileId: z.uuid().nullable(),
  providerName: z.string().max(200),
  providerHealth: z.enum(["unknown", "healthy", "degraded", "unavailable"]),
  model: z.string().max(500),
  indexedMemories: nonnegativeIntegerSchema,
  totalMemories: nonnegativeIntegerSchema,
  coveragePercent: z.number().int().min(0).max(100),
  jobId: z.uuid().nullable(),
  jobStatus: z.enum(["queued", "running", "completed", "failed"]).nullable(),
  progress: chronicleHealthProgressSchema,
  errorMessage: z.string().max(500),
  lastCompletedAt: z.iso.datetime({ offset: true }).nullable(),
  retrievalImplementation: retrievalImplementationSchema,
  retrievalShadowEnabled: z.boolean(),
  fallbackCode: safeTelemetryCodeSchema.nullable(),
  chunkProtocolVersion: safeTelemetryCodeSchema
} as const;

function chronicleHealthVariant<TStatus extends z.infer<typeof chronicleHealthStatusSchema>>(status: TStatus) {
  return z.object({ status: z.literal(status), ...chronicleHealthShape }).strict();
}

export const chronicleHealthSchema = z.discriminatedUnion("status", [
  chronicleHealthVariant("chronicle_available"),
  chronicleHealthVariant("semantic_disabled"),
  chronicleHealthVariant("indexing"),
  chronicleHealthVariant("healthy"),
  chronicleHealthVariant("partially_indexed"),
  chronicleHealthVariant("provider_degraded"),
  chronicleHealthVariant("provider_unavailable"),
  chronicleHealthVariant("fallback_active"),
  chronicleHealthVariant("chunk_protocol_outdated"),
  chronicleHealthVariant("rebuild_required")
]);

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
  queryPrefix: z.string().max(200).nullable().default(null),
  retrievalImplementation: retrievalImplementationSchema.default("legacy_hybrid"),
  retrievalShadowEnabled: z.boolean().default(false)
}).superRefine((value, context) => {
  if (value.enabled && !value.model) {
    context.addIssue({ code: "custom", path: ["model"], message: "An embedding model is required when semantic memory is enabled." });
  }
});

export type CompressionLevel = z.infer<typeof compressionLevelSchema>;
export type RetrievalImplementation = z.infer<typeof retrievalImplementationSchema>;
export type ChronicleRetrievalComparisonImplementation = z.infer<typeof chronicleRetrievalComparisonImplementationSchema>;
export type ChronicleRetrievalCandidate = z.infer<typeof chronicleRetrievalCandidateSchema>;
export type ChronicleRetrievalComparison = z.infer<typeof chronicleRetrievalComparisonSchema>;
export type ChronicleRetrievalRun = z.infer<typeof chronicleRetrievalRunSchema>;
export type ChronicleHealthStatus = z.infer<typeof chronicleHealthStatusSchema>;
export type ChronicleHealth = z.infer<typeof chronicleHealthSchema>;
export type MemoryContextQuery = z.infer<typeof memoryContextQuerySchema>;
export type CampaignEmbeddingConfig = Omit<
  z.infer<typeof campaignEmbeddingConfigSchema>,
  "documentPrefix" | "queryPrefix" | "retrievalImplementation" | "retrievalShadowEnabled"
> & {
  documentPrefix?: string | null;
  queryPrefix?: string | null;
  retrievalImplementation?: RetrievalImplementation;
  retrievalShadowEnabled?: boolean;
};
