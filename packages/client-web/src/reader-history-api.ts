import { readerTurnNumberSchema, readerTurnResponseSchema } from "@infinite-quest/contracts";
import type { ReaderTurnResponse } from "@infinite-quest/contracts";
import type { NexusHttpClient } from "./http-client.js";

export interface ReaderHistoryApi {
  getTurn(campaignId: string, turnNumber: number, signal?: AbortSignal): Promise<ReaderTurnResponse>;
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
    }
  };
}
