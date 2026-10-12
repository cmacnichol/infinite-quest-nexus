import {
  readerHistoryRequestSchema,
  readerHistoryResponseSchema,
  readerSceneWindowRequestSchema,
  readerSceneWindowResponseSchema,
  readerTurnNumberSchema,
  readerTurnResponseSchema
} from "@infinite-quest/contracts";
import type {
  ReaderHistoryRequest,
  ReaderHistoryResponse,
  ReaderSceneWindowRequestInput,
  ReaderSceneWindowResponse,
  ReaderTurnResponse
} from "@infinite-quest/contracts";
import type { NexusHttpClient } from "./http-client.js";

export interface ReaderHistoryApi {
  getTurn(campaignId: string, turnNumber: number, signal?: AbortSignal): Promise<ReaderTurnResponse>;
  searchHistory(campaignId: string, options?: Partial<ReaderHistoryRequest>, signal?: AbortSignal): Promise<ReaderHistoryResponse>;
  getSceneWindow(
    campaignId: string,
    options: ReaderSceneWindowRequestInput,
    signal?: AbortSignal
  ): Promise<ReaderSceneWindowResponse>;
}

export function createReaderHistoryApi(http: NexusHttpClient): ReaderHistoryApi {
  return {
    getTurn(campaignId, turnNumber, signal) {
      const parsedTurnNumber = readerTurnNumberSchema.parse(turnNumber);
      const request = {
        method: "GET" as const,
        path: `/campaigns/${encodeURIComponent(campaignId)}/reader/turns/${parsedTurnNumber}`,
        responseSchema: readerTurnResponseSchema,
        ...(signal ? { signal } : {})
      };
      return http.request(request);
    },
    searchHistory(campaignId, options = {}, signal) {
      const parsed = readerHistoryRequestSchema.parse(options);
      const params = new URLSearchParams();
      if (parsed.q) params.set("q", parsed.q);
      if (parsed.before) params.set("before", parsed.before);
      params.set("limit", String(parsed.limit));
      return http.request({
        method: "GET",
        path: `/campaigns/${encodeURIComponent(campaignId)}/reader/history?${params.toString()}`,
        responseSchema: readerHistoryResponseSchema,
        ...(signal ? { signal } : {})
      });
    },
    getSceneWindow(campaignId, options, signal) {
      const parsed = readerSceneWindowRequestSchema.parse(options);
      const params = new URLSearchParams({
        anchorTurnNumber: String(parsed.anchorTurnNumber),
        anchorTurnId: parsed.anchorTurnId,
        direction: parsed.direction,
        neighborLimit: String(parsed.neighborLimit)
      });
      if (parsed.historyToken !== undefined) params.set("historyToken", parsed.historyToken);
      return http.request({
        method: "GET",
        path: `/campaigns/${encodeURIComponent(campaignId)}/reader/scene-window?${params.toString()}`,
        responseSchema: readerSceneWindowResponseSchema,
        ...(signal ? { signal } : {})
      });
    }
  };
}
