import { z } from "zod";
import { castSnapshotSchema, castDetailSchema, castListQuerySchema, createCastCharacterSchema, editCastCharacterSchema, castDiscoveryStatusSchema,
  castCandidateQuerySchema, castCandidateListSchema, resolveCastCandidateSchema, castCandidateResolutionSchema, type CastCandidateQuery, type ResolveCastCandidate,
  castWriteResultSchema, type CastListQuery, type CreateCastCharacter, type EditCastCharacter } from "@infinite-quest/contracts";
import { createNexusHttpClient, type NexusHttpClientOptions } from "./http-client.js";
import { validatedRequest } from "./api-client.js";

const capabilities = z.object({ castEditing: z.boolean() });
export const castListResponseSchema = castSnapshotSchema.extend({ nextCursor: z.uuid().nullable(), capabilities });
export const castDetailResponseSchema = castDetailSchema.extend({ capabilities });
export function createCampaignCastApi(options: NexusHttpClientOptions = {
  basePath: "/api/v1", session: { authorization: async () => ({}), onUnauthorized: async () => false }
}) {
  const http = createNexusHttpClient(options);
  const pathFor = (campaignId: string) => `/campaigns/${encodeURIComponent(campaignId)}/cast`;
  return {
    candidates: (campaignId: string, input: Partial<CastCandidateQuery> = {}) => {
      const path = `${pathFor(campaignId)}/candidates`, query = validatedRequest(castCandidateQuerySchema, input, "GET", path);
      const search = new URLSearchParams({ limit: String(query.limit), ...(query.cursor ? { cursor: query.cursor } : {}) });
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
