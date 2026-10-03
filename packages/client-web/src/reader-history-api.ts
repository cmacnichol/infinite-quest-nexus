import {
  readerHistoryRequestSchema,
  readerHistoryResponseSchema,
  readerTurnNumberSchema,
  readerTurnResponseSchema
} from "@infinite-quest/contracts";
import type { ReaderHistoryRequest, ReaderHistoryResponse, ReaderTurnResponse } from "@infinite-quest/contracts";
import type { NexusHttpClient } from "./http-client.js";

export interface ReaderHistoryApi {
  getTurn(campaignId: string, turnNumber: number, signal?: AbortSignal): Promise<ReaderTurnResponse>;
  searchHistory(campaignId: string, options?: Partial<ReaderHistoryRequest>, signal?: AbortSignal): Promise<ReaderHistoryResponse>;
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
    }
  };
}
