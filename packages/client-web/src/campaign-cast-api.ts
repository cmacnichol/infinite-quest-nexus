import { z } from "zod";
import { castSnapshotSchema, castDetailSchema, castListQuerySchema, createCastCharacterSchema, editCastCharacterSchema, castDiscoveryStatusSchema,
  castCandidateQuerySchema, castCandidateListSchema, resolveCastCandidateSchema, castCandidateResolutionSchema, type CastCandidateQuery, type ResolveCastCandidate,
  castWriteResultSchema, retryCastDiscoverySchema, castDiscoveryRetryResultSchema, type RetryCastDiscovery,
  type CastListQuery, type CreateCastCharacter, type EditCastCharacter } from "@infinite-quest/contracts";
import { createNexusHttpClient, type NexusHttpClientOptions } from "./http-client.js";
import { validatedRequest } from "./api-client.js";
import { castBackfillRequestSchema, castBackfillPreviewSchema, castBackfillProgressSchema, castBackfillRetrySchema,
  type CastBackfillRequest, type CastBackfillRetry } from "@infinite-quest/contracts";

const capabilities = z.object({ castEditing: z.boolean() });
export const castListResponseSchema = castSnapshotSchema.extend({ nextCursor: z.uuid().nullable(), capabilities });
export const castDetailResponseSchema = castDetailSchema.extend({ capabilities });
export function createCampaignCastApi(options: NexusHttpClientOptions = {
  basePath: "/api/v1", session: { authorization: async () => ({}), onUnauthorized: async () => false }
}) {
  const http = createNexusHttpClient(options);
  const pathFor = (campaignId: string) => `/campaigns/${encodeURIComponent(campaignId)}/cast`;
  return {
    scans: {
      latest: (campaignId: string) => http.request({ method: "GET", path: `${pathFor(campaignId)}/scans`,
        responseSchema: z.object({ scan: castBackfillProgressSchema.nullable(), capabilities: z.object({ castBackfill: z.boolean() }) }) }),
      get: (campaignId: string, id: string) => http.request({ method: "GET", path: `${pathFor(campaignId)}/scans/${encodeURIComponent(id)}`, responseSchema: castBackfillProgressSchema }),
      async preview(campaignId: string, input: CastBackfillRequest) {
        const path = `${pathFor(campaignId)}/scans/preview`, value = validatedRequest(castBackfillRequestSchema, input, "POST", path);
        return http.request({ method: "POST", path, body: { kind: "json", value }, responseSchema: castBackfillPreviewSchema });
      },
      async start(campaignId: string, input: CastBackfillRequest) {
        const path = `${pathFor(campaignId)}/scans`, value = validatedRequest(castBackfillRequestSchema, input, "POST", path);
        return http.request({ method: "POST", path, body: { kind: "json", value }, responseSchema: castBackfillProgressSchema });
      },
      async control(campaignId: string, id: string, action: "pause" | "resume" | "cancel") {
        const operation = z.enum(["pause", "resume", "cancel"]).parse(action);
        return http.request({ method: "POST", path: `${pathFor(campaignId)}/scans/${encodeURIComponent(id)}/${operation}`,
          body: { kind: "json", value: {} }, responseSchema: castBackfillProgressSchema });
      },
      async retry(campaignId: string, id: string, input: CastBackfillRetry) {
        const path = `${pathFor(campaignId)}/scans/${encodeURIComponent(id)}/retry`, value = validatedRequest(castBackfillRetrySchema, input, "POST", path);
        return http.request({ method: "POST", path, body: { kind: "json", value }, responseSchema: castBackfillProgressSchema });
      }
    },
    retryDiscovery: (campaignId: string, id: string, input: RetryCastDiscovery) => {
      const path = `${pathFor(campaignId)}/discovery/${encodeURIComponent(id)}/retry`, value = validatedRequest(retryCastDiscoverySchema, input, "POST", path);
      return http.request({ method: "POST", path, body: { kind: "json", value }, responseSchema: castDiscoveryRetryResultSchema });
    },
    candidates: (campaignId: string, input: Partial<CastCandidateQuery> = {}) => {
      const path = `${pathFor(campaignId)}/candidates`, query = validatedRequest(castCandidateQuerySchema, input, "GET", path);
      const search = new URLSearchParams({ limit: String(query.limit), view: query.view, ...(query.cursor ? { cursor: query.cursor } : {}) });
      return http.request({ method: "GET", path: `${path}?${search}`, responseSchema: castCandidateListSchema });
    },
    resolveCandidate: (campaignId: string, id: string, input: ResolveCastCandidate) => {
      const path = `${pathFor(campaignId)}/candidates/${encodeURIComponent(id)}/resolve`, value = validatedRequest(resolveCastCandidateSchema, input, "POST", path);
      return http.request({ method: "POST", path, body: { kind: "json", value }, responseSchema: castCandidateResolutionSchema });
    },
    discoveryStatus: (campaignId: string) => http.request({ method: "GET", path: `${pathFor(campaignId)}/discovery`, responseSchema: castDiscoveryStatusSchema }),
    async list(campaignId: string, input: Partial<CastListQuery> = {}) {
      const path = pathFor(campaignId), query = validatedRequest(castListQuerySchema, input, "GET", path);
      const search = new URLSearchParams({ limit: String(query.limit), query: query.query });
      if (query.cursor) search.set("cursor", query.cursor);
      return http.request({ method: "GET", path: `${path}?${search}`, responseSchema: castListResponseSchema });
    },
    detail: (campaignId: string, id: string) => http.request({ method: "GET", path: `${pathFor(campaignId)}/${encodeURIComponent(id)}`, responseSchema: castDetailResponseSchema }),
    async create(campaignId: string, input: CreateCastCharacter) {
      const path = pathFor(campaignId), value = validatedRequest(createCastCharacterSchema, input, "POST", path);
      return http.request({ method: "POST", path, body: { kind: "json", value }, responseSchema: castWriteResultSchema });
    },
    async edit(campaignId: string, id: string, input: EditCastCharacter) {
      const path = `${pathFor(campaignId)}/${encodeURIComponent(id)}`, value = validatedRequest(editCastCharacterSchema, input, "PATCH", path);
      return http.request({ method: "PATCH", path, body: { kind: "json", value }, responseSchema: castWriteResultSchema });
    }
  };
}
export type CampaignCastApi = ReturnType<typeof createCampaignCastApi>;
