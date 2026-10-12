import { z } from "zod";
import { ApiContractError } from "@infinite-quest/client-core";
import { activityPageQuerySchema, activityPageSchema, type ActivityPage, type ActivityPageQuery } from "@infinite-quest/contracts";
import type { NexusHttpClient } from "./http-client.js";

export interface ActivityApi {
  list(campaignId: string, query: ActivityPageQuery, signal?: AbortSignal): Promise<ActivityPage>;
}

export function createActivityApi({ http }: { http: NexusHttpClient }): ActivityApi {
  return { async list(campaignId, query, signal) {
    const path = `/campaigns/${encodeURIComponent(campaignId)}/activity`;
    const id = z.uuid().safeParse(campaignId);
    const parsed = activityPageQuerySchema.safeParse(query);
    if (!id.success || !parsed.success) throw new ApiContractError("Invalid activity request.", {
      phase: "request", kind: "request_schema_mismatch", method: "GET", path
    });
    const search = new URLSearchParams({ limit: String(parsed.data.limit) });
    if (parsed.data.before) search.set("before", parsed.data.before);
    if (parsed.data.after) search.set("after", parsed.data.after);
    const page = await http.request({ method: "GET", path: `${path}?${search}`, responseSchema: activityPageSchema, ...(signal ? { signal } : {}) });
    signal?.throwIfAborted();
    return page;
  } };
}
