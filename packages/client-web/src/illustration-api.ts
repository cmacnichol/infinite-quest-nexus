import {
  illustrationConfigResponseSchema,
  illustrationRematchResponseSchema,
  illustrationResolutionResponseSchema,
  illustrationSegmentsResponseSchema,
  imageJobResponseSchema,
  imageJobsResponseSchema,
  segmentGenerationResponseSchema,
  segmentImageResponseSchema
} from "@infinite-quest/contracts";
import type {
  IllustrationConfigResponse,
  IllustrationRematchResponse,
  IllustrationResolutionResponse,
  IllustrationSegmentsResponse,
  ImageJobResponse,
  ImageJobsResponse,
  SegmentGenerationResponse,
  SegmentImageResponse
} from "@infinite-quest/contracts";
import type { NexusHttpClient } from "./http-client.js";

export interface IllustrationApi {
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

function withSignal<T extends object>(spec: T, signal: AbortSignal | undefined): T | (T & { signal: AbortSignal }) {
  return signal ? { ...spec, signal } : spec;
}

export function createIllustrationApi(http: NexusHttpClient): IllustrationApi {
  return {
    config: (campaignId, signal) => http.request(withSignal({ method: "GET" as const, path: `/campaigns/${segment(campaignId)}/illustration-config`, responseSchema: illustrationConfigResponseSchema }, signal)),
    segments: (campaignId, signal) => http.request(withSignal({ method: "GET" as const, path: `/campaigns/${segment(campaignId)}/illustration-segments`, responseSchema: illustrationSegmentsResponseSchema }, signal)),
    imageJobs: (campaignId, signal) => http.request(withSignal({ method: "GET" as const, path: `/campaigns/${segment(campaignId)}/image-jobs`, responseSchema: imageJobsResponseSchema }, signal)),
    retryImageJob: (jobId, signal) => http.request(withSignal({ method: "POST" as const, path: `/image-jobs/${segment(jobId)}/retry`, responseSchema: imageJobResponseSchema }, signal)),
    regenerateSegmentImage: (segmentId, value, signal) => http.request(withSignal({ method: "POST" as const, path: `/illustration-segments/${segment(segmentId)}/images`, body: { kind: "json" as const, value }, responseSchema: segmentImageResponseSchema }, signal)),
    generateTurnSegments: (turnId, value, signal) => http.request(withSignal({ method: "POST" as const, path: `/turns/${segment(turnId)}/illustration-segments`, body: { kind: "json" as const, value }, responseSchema: segmentGenerationResponseSchema }, signal)),
    resolution: (turnId, signal) => http.request(withSignal({ method: "GET" as const, path: `/turns/${segment(turnId)}/illustration-resolution`, responseSchema: illustrationResolutionResponseSchema }, signal)),
    rematch: (turnId, signal) => http.request(withSignal({ method: "POST" as const, path: `/turns/${segment(turnId)}/illustration-match`, responseSchema: illustrationRematchResponseSchema }, signal))
  };
}
