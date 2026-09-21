import { z } from "zod";
import { apiTimestampSchema } from "./http.js";
import { providerRoleSchema, providerTypeSchema } from "./generation.js";
import { textModelSelectionSchema } from "./provider-selection.js";
import { textExecutionOverridesSchema } from "./text-execution-plan.js";

export const CURRENT_STORY_RESPONSE_FORMAT_CAPABILITY_IDENTITY = Object.freeze({
  schemaVersion: "story-native-v1",
  schemaHash: "10765575fa1c47721ba4f72f81d918edc2dbf6df288e952f84ae4f485bcc55d7"
});

export const safeProviderConfigurationSchema = z.object({
  streaming: z.boolean().optional(), streamingSupport: z.boolean().optional(), httpReferer: z.string().optional(),
  modelDiscoveryEnabled: z.boolean().optional(), network: z.enum(["fast", "relaxed"]).optional(),
  tokenType: z.enum(["auto", "sogni", "spark"]).optional(), contentFilter: z.enum(["enabled", "disabled"]).optional(),
  defaultWidth: z.number().finite().optional(), defaultHeight: z.number().finite().optional(), defaultAspectRatio: z.string().optional(),
  defaultSizePreset: z.string().optional(), defaultOutputFormat: z.enum(["png", "jpeg", "webp"]).optional(),
  defaultQuality: z.enum(["auto", "low", "medium", "high"]).optional(), defaultImageCount: z.number().finite().optional(),
  defaultSteps: z.number().finite().optional(), defaultGuidance: z.number().finite().optional(), defaultSeed: z.number().finite().optional(),
  defaultSampler: z.string().optional(), defaultScheduler: z.string().optional(), defaultPreviewCount: z.number().finite().optional(),
  pollIntervalMs: z.number().finite().optional(), maximumPollIntervalMs: z.number().finite().optional(), generationTimeoutMs: z.number().finite().optional(),
  maximumAttempts: z.number().finite().optional(), retryLimit: z.number().int().nonnegative().optional(), allowPrivateArtifactHosts: z.boolean().optional(),
  embeddingMaxInputTokens: z.number().int().optional(), embeddingMaxBatchItems: z.number().int().optional(), embeddingMaxBatchTokens: z.number().int().optional(),
  embeddingDimensions: z.number().int().optional(), embeddingMaxRetries: z.number().int().optional(),
  textResponseFormatPolicy: z.enum(["legacy", "auto", "required"]).optional(), textExecutionOverrides: textExecutionOverridesSchema.optional()
}).strict();

const responseFormatCapabilitySchema = z.object({
  version: z.literal(1), model: z.string().trim().min(1).max(500), expectedRegistryDigest: z.string().trim().min(1).max(500),
  advertisedAt: apiTimestampSchema.nullable(), operations: z.array(z.object({
    operation: z.enum(["story", "choices", "continuity_review"]), streaming: z.boolean(),
    status: z.enum(["verified", "unsupported", "unknown"]), reason: z.string().trim().min(1).max(200).nullable(),
    schemaVersion: z.string().trim().min(1).max(500), schemaHash: z.string().regex(/^[a-f0-9]{64}$/u),
    verifiedAt: apiTimestampSchema.nullable(), expiresAt: apiTimestampSchema.nullable()
  }).strict())
}).strict();

export const safeProviderProfileViewSchema = z.object({
  id: z.uuid(), name: z.string().trim().min(1).max(120), providerType: providerTypeSchema, providerRole: providerRoleSchema,
  baseUrl: z.url(), defaultModel: z.string().max(500), textSelection: textModelSelectionSchema.optional(),
  contextWindowTokens: z.number().int().min(1024).max(4_000_000), maxOutputTokens: z.number().int().min(128).max(262_144),
  temperature: z.number().finite().min(0).max(2), requestTimeoutMs: z.number().int().min(5_000).max(3_600_000),
  configuration: safeProviderConfigurationSchema, enabled: z.boolean(), isDefault: z.boolean(),
  healthStatus: z.enum(["unknown", "healthy", "degraded", "unavailable"]), consecutiveFailures: z.number().int().nonnegative(),
  lastHealthCheckAt: apiTimestampSchema.nullable(), lastHealthError: z.null(), hasApiKey: z.boolean(),
  createdAt: apiTimestampSchema, updatedAt: apiTimestampSchema, responseFormatCapability: responseFormatCapabilitySchema.optional()
}).strict();

export type SafeProviderConfiguration = Readonly<z.infer<typeof safeProviderConfigurationSchema>>;
export type SafeProviderProfileView = Readonly<z.infer<typeof safeProviderProfileViewSchema>>;
