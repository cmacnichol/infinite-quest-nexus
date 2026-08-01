import { ApiContractError } from "@infinite-quest/client-core";
import {
  campaignListResponseSchema,
  campaignSyncStatusSchema,
  generationActionResponseSchema,
  generationEnqueueResponseSchema,
  generationJobSnapshotSchema,
  generationRequestSchema,
  generationResultSchema,
  generationRetryLatestRequestSchema,
  turnListResponseSchema,
  worldListResponseSchema
} from "../../contracts/src/index.js";
import type {
  CampaignListResponse,
  CampaignSyncStatus,
  GenerationActionResponse,
  GenerationEnqueueResponse,
  GenerationJobSnapshot,
  GenerationRequest,
  GenerationResult,
  GenerationRetryLatestRequest,
  TurnListResponse,
  WorldListResponse
} from "../../contracts/src/index.js";
import type { z } from "zod";
import { createNexusHttpClient } from "./http-client.js";
import type { JsonRequestSpec, NexusHttpClientOptions } from "./http-client.js";

export interface WorldApi {
  list(signal?: AbortSignal): Promise<WorldListResponse>;
}

export interface CampaignApi {
  list(signal?: AbortSignal): Promise<CampaignListResponse>;
  turns(campaignId: string, signal?: AbortSignal): Promise<TurnListResponse>;
}

export interface GenerationApi {
  syncStatus(campaignId: string, signal?: AbortSignal): Promise<CampaignSyncStatus>;
  enqueue(campaignId: string, request: GenerationRequest, signal?: AbortSignal): Promise<GenerationEnqueueResponse>;
  enqueueReplacement(campaignId: string, request: GenerationRetryLatestRequest, signal?: AbortSignal): Promise<GenerationEnqueueResponse>;
  get(jobId: string, signal?: AbortSignal): Promise<GenerationJobSnapshot>;
  result(jobId: string, signal?: AbortSignal): Promise<GenerationResult>;
  retry(jobId: string, signal?: AbortSignal): Promise<GenerationActionResponse>;
  cancel(jobId: string, signal?: AbortSignal): Promise<GenerationActionResponse>;
  discard(jobId: string, signal?: AbortSignal): Promise<GenerationActionResponse>;
}

export interface NexusApiClient {
  campaigns: CampaignApi;
  generation: GenerationApi;
  worlds: WorldApi;
}

function encodedPathSegment(value: string): string {
  return encodeURIComponent(value);
}

function validatedRequest<T>(
  schema: z.ZodType<T>,
  value: unknown,
  path: string
): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new ApiContractError("The request does not match its contract.", {
      phase: "request",
      kind: "request_schema_mismatch",
      method: "POST",
      path,
      issues: parsed.error.issues
    });
  }
  return parsed.data;
}

function withSignal<T>(
  spec: Omit<JsonRequestSpec<T>, "signal">,
  signal: AbortSignal | undefined
): JsonRequestSpec<T> {
  return signal ? { ...spec, signal } : spec;
}

export function createNexusApiClient(options: NexusHttpClientOptions): NexusApiClient {
  const http = createNexusHttpClient(options);

  const worlds: WorldApi = {
    list: (signal) => http.request(withSignal({ method: "GET", path: "/worlds", responseSchema: worldListResponseSchema }, signal))
  };
  const campaigns: CampaignApi = {
    list: (signal) => http.request(withSignal({ method: "GET", path: "/campaigns", responseSchema: campaignListResponseSchema }, signal)),
    turns: (campaignId, signal) => http.request(withSignal({
      method: "GET",
      path: `/campaigns/${encodedPathSegment(campaignId)}/turns`,
      responseSchema: turnListResponseSchema
    }, signal))
  };
  const generation: GenerationApi = {
    syncStatus: (campaignId, signal) => http.request(withSignal({
      method: "GET",
      path: `/campaigns/${encodedPathSegment(campaignId)}/sync-status`,
      responseSchema: campaignSyncStatusSchema
    }, signal)),
    async enqueue(campaignId, request, signal) {
      const path = `/campaigns/${encodedPathSegment(campaignId)}/generations`;
      const body = validatedRequest(generationRequestSchema, request, path);
      return http.request(withSignal({ method: "POST", path, body: { kind: "json", value: body }, responseSchema: generationEnqueueResponseSchema }, signal));
    },
    async enqueueReplacement(campaignId, request, signal) {
      const path = `/campaigns/${encodedPathSegment(campaignId)}/generations/retry-latest`;
      const body = validatedRequest(generationRetryLatestRequestSchema, request, path);
      return http.request(withSignal({ method: "POST", path, body: { kind: "json", value: body }, responseSchema: generationEnqueueResponseSchema }, signal));
    },
    get: (jobId, signal) => http.request(withSignal({
      method: "GET",
      path: `/generation-jobs/${encodedPathSegment(jobId)}`,
      responseSchema: generationJobSnapshotSchema
    }, signal)),
    result: (jobId, signal) => http.request(withSignal({
      method: "GET",
      path: `/generation-jobs/${encodedPathSegment(jobId)}/result`,
      responseSchema: generationResultSchema
    }, signal)),
    retry: (jobId, signal) => http.request(withSignal({
      method: "POST",
      path: `/generation-jobs/${encodedPathSegment(jobId)}/retry`,
      responseSchema: generationActionResponseSchema
    }, signal)),
    cancel: (jobId, signal) => http.request(withSignal({
      method: "POST",
      path: `/generation-jobs/${encodedPathSegment(jobId)}/cancel`,
      responseSchema: generationActionResponseSchema
    }, signal)),
    discard: (jobId, signal) => http.request(withSignal({
      method: "POST",
      path: `/generation-jobs/${encodedPathSegment(jobId)}/discard`,
      responseSchema: generationActionResponseSchema
    }, signal))
  };

  return { campaigns, generation, worlds };
}
