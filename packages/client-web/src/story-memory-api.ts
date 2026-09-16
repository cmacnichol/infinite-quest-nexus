import { storyMemorySettingsSchema, storyMemorySettingsUpdateSchema } from "@infinite-quest/contracts";
import type { StoryMemoryLevel, StoryMemorySettings } from "@infinite-quest/contracts";
import { createNexusHttpClient, type NexusHttpClientOptions } from "./http-client.js";
import { validatedRequest } from "./api-client.js";

export interface StoryMemoryApi {
  get(campaignId: string, signal?: AbortSignal): Promise<StoryMemorySettings>;
  update(campaignId: string, value: { level: StoryMemoryLevel }, signal?: AbortSignal): Promise<StoryMemorySettings>;
}

export function createStoryMemoryApi(options: NexusHttpClientOptions = {
  basePath: "/api/v1",
  session: { authorization: async () => ({}), onUnauthorized: async () => false }
}): StoryMemoryApi {
  const http = createNexusHttpClient(options);
  const pathFor = (campaignId: string) => `/campaigns/${encodeURIComponent(campaignId)}/story-memory`;
  return {
    get: (campaignId, signal) => http.request({
      method: "GET", path: pathFor(campaignId), responseSchema: storyMemorySettingsSchema,
      ...(signal ? { signal } : {})
    }),
    update: (campaignId, value, signal) => {
      const path = pathFor(campaignId);
      const body = validatedRequest(storyMemorySettingsUpdateSchema, value, "PUT", path);
      return http.request({
        method: "PUT", path, body: { kind: "json", value: body }, responseSchema: storyMemorySettingsSchema,
        ...(signal ? { signal } : {})
      });
    }
  };
}
