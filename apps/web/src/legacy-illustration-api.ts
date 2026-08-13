import type { SessionPort } from "@infinite-quest/client-core";
import { createNexusHttpClient } from "@infinite-quest/client-web";
import { apiTimestampSchema, illustrationMatchingScopeSchema } from "@infinite-quest/contracts";
import { z } from "zod";

const nullableTimestampSchema = apiTimestampSchema.nullable();
const nullableUuidSchema = z.uuid().nullable();

const illustrationConfigResponseSchema = z.object({
  enabled: z.boolean(),
  sourcePolicy: z.enum(["off", "library_only", "library_then_generate", "generate_only"]),
  matchingScope: illustrationMatchingScopeSchema,
  confidenceProfile: z.enum(["strict", "balanced", "broad"]),
  repetitionWindow: z.number().int().min(0),
  providerProfileId: nullableUuidSchema,
  model: z.string(),
  size: z.string().trim().min(1),
  aspectRatio: z.string().trim().min(1),
  quality: z.string().trim().min(1),
  outputFormat: z.string().trim().min(1),
  maxAttempts: z.number().int().positive(),
  segmentWordCount: z.number().int().positive(),
  imagesPerSegment: z.union([z.literal(1), z.literal(2)]),
  segmentPromptMode: z.enum(["direct", "ai_refined"]),
  refinementPrompt: z.string().trim().min(1),
  defaultRefinementPrompt: z.string().trim().min(1),
  updatedAt: nullableTimestampSchema
});

const illustrationVariantSchema = z.object({
  assetId: z.uuid(),
  url: z.string().trim().min(1),
  variantIndex: z.number().int().min(0),
  prompt: z.string(),
  providerType: z.string().nullable(),
  model: z.string().nullable(),
  createdAt: apiTimestampSchema,
  selectionReason: z.string().nullable(),
  matchScore: z.number().nullable(),
  matchThreshold: z.number().nullable(),
  matchingAlgorithm: z.string().nullable()
});

const illustrationSegmentSchema = z.object({
  setId: z.uuid(),
  turnId: z.uuid(),
  setStatus: z.string().trim().min(1),
  segmentWordCount: z.number().int().positive(),
  imagesPerSegment: z.union([z.literal(1), z.literal(2)]),
  promptMode: z.enum(["direct", "ai_refined"]),
  id: z.uuid(),
  ordinal: z.number().int().min(0),
  startOffset: z.number().int().min(0),
  endOffset: z.number().int().min(0),
  startWord: z.number().int().min(0),
  endWord: z.number().int().min(0),
  text: z.string(),
  status: z.string().trim().min(1),
  promptSource: z.string().nullable(),
  directPrompt: z.string(),
  resolvedPrompt: z.string(),
  variants: z.array(illustrationVariantSchema),
  imageJobId: nullableUuidSchema,
  imageJobStatus: z.string().nullable(),
  providerStatus: z.string().nullable(),
  providerProgress: z.coerce.number().nullable(),
  errorMessage: z.string().nullable(),
  promptJobStatus: z.string().nullable()
});

const illustrationSegmentsResponseSchema = z.object({
  segments: z.array(illustrationSegmentSchema)
});

const imageJobResponseSchema = z.object({
  id: z.uuid(),
  campaignId: nullableUuidSchema,
  turnId: nullableUuidSchema,
  worldId: nullableUuidSchema,
  targetType: z.string().trim().min(1),
  segmentId: nullableUuidSchema,
  generationJobId: nullableUuidSchema,
  imageCount: z.number().int().positive(),
  providerProfileId: nullableUuidSchema,
  model: z.string(),
  status: z.string().trim().min(1),
  attempts: z.number().int().min(0),
  maxAttempts: z.number().int().positive(),
  size: z.string().trim().min(1),
  aspectRatio: z.string().trim().min(1),
  quality: z.string().trim().min(1),
  outputFormat: z.string().trim().min(1),
  assetId: nullableUuidSchema,
  assetUrl: z.string(),
  providerType: z.string().nullable(),
  generationRevision: z.number().int().min(0),
  remoteJobId: z.string().nullable(),
  providerStatus: z.string().nullable(),
  providerProgress: z.coerce.number().nullable(),
  providerQueuePosition: z.number().int().nullable(),
  providerEtaAt: nullableTimestampSchema,
  submittedAt: nullableTimestampSchema,
  lastPolledAt: nullableTimestampSchema,
  nextPollAt: nullableTimestampSchema,
  generationDeadline: nullableTimestampSchema,
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  createdAt: apiTimestampSchema,
  updatedAt: apiTimestampSchema,
  completedAt: nullableTimestampSchema
});

const imageJobsResponseSchema = z.object({ jobs: z.array(imageJobResponseSchema) });

const segmentImageResponseSchema = z.object({
  id: z.uuid(),
  duplicate: z.boolean(),
  segmentId: z.uuid(),
  variantIndex: z.number().int().min(0),
  status: z.string().trim().min(1).optional()
});

const segmentGenerationResponseSchema = z.object({
  setId: z.uuid(),
  duplicate: z.boolean(),
  segmentCount: z.number().int().min(0)
});

const illustrationCandidateSchema = z.object({
  assetId: z.uuid(),
  rank: z.number().int().positive(),
  score: z.number(),
  scoreComponents: z.record(z.string(), z.unknown()),
  rejectionReasons: z.array(z.string())
});

const illustrationResolutionResponseSchema = z.object({
  id: z.uuid(),
  campaignId: z.uuid(),
  turnId: z.uuid(),
  sourcePolicy: z.string().trim().min(1),
  matchingScope: z.string().trim().min(1),
  confidenceProfile: z.string().trim().min(1),
  status: z.string().trim().min(1),
  selectedAssetId: nullableUuidSchema,
  selectedScore: z.number().nullable(),
  resolvedThreshold: z.number().nullable(),
  algorithmVersion: z.string().trim().min(1),
  imageJobId: nullableUuidSchema,
  reasonCode: z.string().nullable(),
  createdAt: apiTimestampSchema,
  updatedAt: apiTimestampSchema,
  completedAt: nullableTimestampSchema,
  candidates: z.array(illustrationCandidateSchema)
});

const illustrationRematchResponseSchema = z.object({
  id: z.uuid(),
  status: z.literal("queued")
});

export type IllustrationConfigResponse = z.infer<typeof illustrationConfigResponseSchema>;
export type IllustrationSegmentsResponse = z.infer<typeof illustrationSegmentsResponseSchema>;
export type ImageJobsResponse = z.infer<typeof imageJobsResponseSchema>;
export type ImageJobResponse = z.infer<typeof imageJobResponseSchema>;
export type SegmentImageResponse = z.infer<typeof segmentImageResponseSchema>;
export type SegmentGenerationResponse = z.infer<typeof segmentGenerationResponseSchema>;
export type IllustrationResolutionResponse = z.infer<typeof illustrationResolutionResponseSchema>;
export type IllustrationRematchResponse = z.infer<typeof illustrationRematchResponseSchema>;

export interface LegacyIllustrationApi {
  config(campaignId: string, signal?: AbortSignal): Promise<IllustrationConfigResponse>;
  segments(campaignId: string, signal?: AbortSignal): Promise<IllustrationSegmentsResponse>;
  imageJobs(campaignId: string, signal?: AbortSignal): Promise<ImageJobsResponse>;
  retryImageJob(jobId: string, signal?: AbortSignal): Promise<ImageJobResponse>;
  regenerateSegmentImage(segmentId: string, value: { prompt: string; variantIndex: number }, signal?: AbortSignal): Promise<SegmentImageResponse>;
  generateTurnSegments(turnId: string, value: { mode: "missing" | "rebuild"; idempotencyKey: string }, signal?: AbortSignal): Promise<SegmentGenerationResponse>;
  resolution(turnId: string, signal?: AbortSignal): Promise<IllustrationResolutionResponse>;
  rematch(turnId: string, signal?: AbortSignal): Promise<IllustrationRematchResponse>;
}

function segment(value: string): string {
  return encodeURIComponent(value);
}

export interface LegacyIllustrationApiOptions {
  basePath: string;
  session: SessionPort;
  fetchImpl?: typeof fetch;
}

export function createLegacyIllustrationApi(options: LegacyIllustrationApiOptions): LegacyIllustrationApi {
  const http = createNexusHttpClient({
    basePath: options.basePath,
    session: options.session,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {})
  });
  return {
    config: (campaignId, signal) => http.request({ method: "GET", path: `/campaigns/${segment(campaignId)}/illustration-config`, responseSchema: illustrationConfigResponseSchema, ...(signal ? { signal } : {}) }),
    segments: (campaignId, signal) => http.request({ method: "GET", path: `/campaigns/${segment(campaignId)}/illustration-segments`, responseSchema: illustrationSegmentsResponseSchema, ...(signal ? { signal } : {}) }),
    imageJobs: (campaignId, signal) => http.request({ method: "GET", path: `/campaigns/${segment(campaignId)}/image-jobs`, responseSchema: imageJobsResponseSchema, ...(signal ? { signal } : {}) }),
    retryImageJob: (jobId, signal) => http.request({ method: "POST", path: `/image-jobs/${segment(jobId)}/retry`, responseSchema: imageJobResponseSchema, ...(signal ? { signal } : {}) }),
    regenerateSegmentImage: (segmentId, value, signal) => http.request({ method: "POST", path: `/illustration-segments/${segment(segmentId)}/images`, body: { kind: "json", value }, responseSchema: segmentImageResponseSchema, ...(signal ? { signal } : {}) }),
    generateTurnSegments: (turnId, value, signal) => http.request({ method: "POST", path: `/turns/${segment(turnId)}/illustration-segments`, body: { kind: "json", value }, responseSchema: segmentGenerationResponseSchema, ...(signal ? { signal } : {}) }),
    resolution: (turnId, signal) => http.request({ method: "GET", path: `/turns/${segment(turnId)}/illustration-resolution`, responseSchema: illustrationResolutionResponseSchema, ...(signal ? { signal } : {}) }),
    rematch: (turnId, signal) => http.request({ method: "POST", path: `/turns/${segment(turnId)}/illustration-match`, responseSchema: illustrationRematchResponseSchema, ...(signal ? { signal } : {}) })
  };
}
