import { ApiContractError } from "@infinite-quest/client-core";
import {
  campaignListResponseSchema,
  campaignBranchSchema,
  campaignBranchResponseSchema,
  campaignCreateSchema,
  campaignCreateResponseSchema,
  campaignRewindResponseSchema,
  campaignRewindSchema,
  campaignRuntimeStateResponseSchema,
  campaignRuntimeStateUpdateRequestSchema,
  campaignSyncStatusSchema,
  generationActionResponseSchema,
  generationEnqueueResponseSchema,
  generationJobSnapshotSchema,
  generationRequestSchema,
  generationResultSchema,
  generationRetryLatestRequestSchema,
  metaResponseSchema,
  playableCharacterListResponseSchema,
  providerListResponseSchema,
  sessionResponseSchema,
  turnInputClassificationRequestSchema,
  turnInputClassificationResponseSchema,
  turnListResponseSchema,
  userProfileResponseSchema,
  userProfileUpdateSchema,
  worldCreateResponseSchema,
  worldCreateSchema,
  worldListResponseSchema
} from "@infinite-quest/contracts";
import type {
  CampaignBranchRequest,
  CampaignBranchResponse,
  CampaignCreateRequest,
  CampaignCreateResponse,
  CampaignListResponse,
  CampaignRewindRequest,
  CampaignRewindResponse,
  CampaignRuntimeStateResponse,
  CampaignRuntimeStateUpdate,
  CampaignSyncStatus,
  GenerationActionResponse,
  GenerationEnqueueResponse,
  GenerationJobSnapshot,
  GenerationRequest,
  GenerationResult,
  GenerationRetryLatestRequest,
  MetaResponse,
  PlayableCharacterListResponse,
  ProviderListResponse,
  SessionResponse,
  TurnInputClassificationRequest,
  TurnInputClassificationResponse,
  TurnListResponse,
  UserProfileResponse,
  UserProfileUpdate,
  WorldCreateRequest,
  WorldCreateResponse,
  WorldListResponse
} from "@infinite-quest/contracts";
import type { z } from "zod";
import { createNexusHttpClient } from "./http-client.js";
import type { HttpMethod, JsonRequestSpec, NexusHttpClientOptions } from "./http-client.js";

export interface WorldApi {
  list(signal?: AbortSignal): Promise<WorldListResponse>;
  create(request: WorldCreateRequest, signal?: AbortSignal): Promise<WorldCreateResponse>;
  playableCharacters(worldVersionId: string, signal?: AbortSignal): Promise<PlayableCharacterListResponse>;
}

export interface CampaignApi {
  list(signal?: AbortSignal): Promise<CampaignListResponse>;
  turns(campaignId: string, signal?: AbortSignal): Promise<TurnListResponse>;
  state(campaignId: string, turnNumber?: number, signal?: AbortSignal): Promise<CampaignRuntimeStateResponse>;
  updateState(campaignId: string, request: CampaignRuntimeStateUpdate, signal?: AbortSignal): Promise<CampaignRuntimeStateResponse>;
  classifyTurnInput(campaignId: string, request: TurnInputClassificationRequest, signal?: AbortSignal): Promise<TurnInputClassificationResponse>;
  rewind(campaignId: string, request: CampaignRewindRequest, signal?: AbortSignal): Promise<CampaignRewindResponse>;
  branch(campaignId: string, request: CampaignBranchRequest, signal?: AbortSignal): Promise<CampaignBranchResponse>;
  create(request: CampaignCreateRequest, signal?: AbortSignal): Promise<CampaignCreateResponse>;
}

export interface ShellApi {
  get(signal?: AbortSignal): Promise<MetaResponse>;
}

export interface SessionApi {
  get(signal?: AbortSignal): Promise<SessionResponse>;
  updateProfile(request: UserProfileUpdate, signal?: AbortSignal): Promise<UserProfileResponse>;
}

export interface ProviderApi {
  list(signal?: AbortSignal): Promise<ProviderListResponse>;
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
  meta: ShellApi;
  session: SessionApi;
  providers: ProviderApi;
}

function encodedPathSegment(value: string): string {
  return encodeURIComponent(value);
}

export function validatedRequest<T>(
  schema: z.ZodType<T>,
  value: unknown,
  method: HttpMethod,
  path: string
): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new ApiContractError("The request does not match its contract.", {
      phase: "request",
      kind: "request_schema_mismatch",
      method,
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
    list: (signal) => http.request(withSignal({ method: "GET", path: "/worlds", responseSchema: worldListResponseSchema }, signal)),
    async create(request, signal) {
      const method: HttpMethod = "POST";
      const path = "/worlds";
      const body = validatedRequest(worldCreateSchema, request, method, path);
      return http.request(withSignal({ method, path, body: { kind: "json", value: body }, responseSchema: worldCreateResponseSchema }, signal));
    },
    playableCharacters: (worldVersionId, signal) => http.request(withSignal({
      method: "GET",
      path: `/world-versions/${encodedPathSegment(worldVersionId)}/playable-characters`,
      responseSchema: playableCharacterListResponseSchema
    }, signal))
  };
  const campaigns: CampaignApi = {
    list: (signal) => http.request(withSignal({ method: "GET", path: "/campaigns", responseSchema: campaignListResponseSchema }, signal)),
    turns: (campaignId, signal) => http.request(withSignal({
      method: "GET",
      path: `/campaigns/${encodedPathSegment(campaignId)}/turns`,
      responseSchema: turnListResponseSchema
    }, signal)),
    state: (campaignId, turnNumber, signal) => http.request(withSignal({
      method: "GET",
      path: `/campaigns/${encodedPathSegment(campaignId)}/state${turnNumber === undefined ? "" : `?turnNumber=${encodeURIComponent(String(turnNumber))}`}`,
      responseSchema: campaignRuntimeStateResponseSchema
    }, signal)),
    async updateState(campaignId, request, signal) {
      const method: HttpMethod = "PATCH";
      const path = `/campaigns/${encodedPathSegment(campaignId)}/state`;
      const body = validatedRequest(campaignRuntimeStateUpdateRequestSchema, request, method, path);
      return http.request(withSignal({ method, path, body: { kind: "json", value: body }, responseSchema: campaignRuntimeStateResponseSchema }, signal));
    },
    async classifyTurnInput(campaignId, request, signal) {
      const method: HttpMethod = "POST";
      const path = `/campaigns/${encodedPathSegment(campaignId)}/turn-input/classify`;
      const body = validatedRequest(turnInputClassificationRequestSchema, request, method, path);
      return http.request(withSignal({ method, path, body: { kind: "json", value: body }, responseSchema: turnInputClassificationResponseSchema }, signal));
    },
    async rewind(campaignId, request, signal) {
      const method: HttpMethod = "POST";
      const path = `/campaigns/${encodedPathSegment(campaignId)}/rewind`;
      const body = validatedRequest(campaignRewindSchema, request, method, path);
      return http.request(withSignal({ method, path, body: { kind: "json", value: body }, responseSchema: campaignRewindResponseSchema }, signal));
    },
    async branch(campaignId, request, signal) {
      const method: HttpMethod = "POST";
      const path = `/campaigns/${encodedPathSegment(campaignId)}/branch`;
      const body = validatedRequest(campaignBranchSchema, request, method, path);
      return http.request(withSignal({ method, path, body: { kind: "json", value: body }, responseSchema: campaignBranchResponseSchema }, signal));
    },
    async create(request, signal) {
      const method: HttpMethod = "POST";
      const path = "/campaigns";
      const body = validatedRequest(campaignCreateSchema, request, method, path);
      return http.request(withSignal({ method, path, body: { kind: "json", value: body }, responseSchema: campaignCreateResponseSchema }, signal));
    }
  };
  const generation: GenerationApi = {
    syncStatus: (campaignId, signal) => http.request(withSignal({
      method: "GET",
      path: `/campaigns/${encodedPathSegment(campaignId)}/sync-status`,
      responseSchema: campaignSyncStatusSchema
    }, signal)),
    async enqueue(campaignId, request, signal) {
      const method: HttpMethod = "POST";
      const path = `/campaigns/${encodedPathSegment(campaignId)}/generations`;
      const body = validatedRequest(generationRequestSchema, request, method, path);
      return http.request(withSignal({ method, path, body: { kind: "json", value: body }, responseSchema: generationEnqueueResponseSchema }, signal));
    },
    async enqueueReplacement(campaignId, request, signal) {
      const method: HttpMethod = "POST";
      const path = `/campaigns/${encodedPathSegment(campaignId)}/generations/retry-latest`;
      const body = validatedRequest(generationRetryLatestRequestSchema, request, method, path);
      return http.request(withSignal({ method, path, body: { kind: "json", value: body }, responseSchema: generationEnqueueResponseSchema }, signal));
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

  const meta: ShellApi = {
    get: (signal) => http.request(withSignal({ method: "GET", path: "/meta", responseSchema: metaResponseSchema }, signal))
  };
  const session: SessionApi = {
    get: (signal) => http.request(withSignal({ method: "GET", path: "/session", responseSchema: sessionResponseSchema }, signal)),
    async updateProfile(request, signal) {
      const method: HttpMethod = "PATCH";
      const path = "/users/me/profile";
      const body = validatedRequest(userProfileUpdateSchema, request, method, path);
      return http.request(withSignal({ method, path, body: { kind: "json", value: body }, responseSchema: userProfileResponseSchema }, signal));
    }
  };
  const providers: ProviderApi = {
    list: (signal) => http.request(withSignal({ method: "GET", path: "/providers", responseSchema: providerListResponseSchema }, signal))
  };

  return { campaigns, generation, worlds, meta, session, providers };
}
