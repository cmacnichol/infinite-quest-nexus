import { castContextPreviewRequestSchema, castContextExplanationSchema, type CastContextPreviewRequest } from "@infinite-quest/contracts";
import { reviewCastDetailSchema, reviewCastDetailResultSchema, type ReviewCastDetail } from "@infinite-quest/contracts";
import { detachCastAttachmentSchema, detachCastAttachmentResultSchema, type DetachCastAttachment } from "@infinite-quest/contracts";
import { z } from "zod";
import { NexusApiError } from "@infinite-quest/client-core";
import { charactersWorkspaceStatusSchema } from "@infinite-quest/contracts";
import { castSnapshotSchema, castDetailSchema, castListQuerySchema, createCastCharacterSchema, editCastCharacterSchema, castDiscoveryStatusSchema,
  castCandidateQuerySchema, castCandidateListSchema, resolveCastCandidateSchema, castCandidateResolutionSchema, type CastCandidateQuery, type ResolveCastCandidate,
  castWriteResultSchema, retryCastDiscoverySchema, castDiscoveryRetryResultSchema, type RetryCastDiscovery,
  type CastListQuery, type CreateCastCharacter, type EditCastCharacter } from "@infinite-quest/contracts";
import { createNexusHttpClient, type NexusHttpClientOptions } from "./http-client.js";
import { validatedRequest } from "./api-client.js";
import { castBackfillRequestSchema, castBackfillPreviewSchema, castBackfillProgressSchema, castBackfillRetrySchema,
  type CastBackfillRequest, type CastBackfillRetry } from "@infinite-quest/contracts";

const capabilities = z.object({ castEditing: z.boolean() });
export const castListResponseSchema = castSnapshotSchema.extend({ nextCursor: z.uuid().nullable(), recentWindow: z.number().int().positive().optional(), capabilities,
  attention: z.array(z.object({ characterId: z.uuid(), review: z.boolean(), conflict: z.boolean() }).strict()).max(50).optional() });
export const castDetailResponseSchema = castDetailSchema.extend({ capabilities });
export function createCampaignCastApi(options: NexusHttpClientOptions = {
  basePath: "/api/v1", session: { authorization: async () => ({}), onUnauthorized: async () => false }
}) {
  const http = createNexusHttpClient(options);
  const pathFor = (campaignId: string) => `/campaigns/${encodeURIComponent(campaignId)}/cast`;
  return {
    async contextPreview(campaignId: string, input: Partial<CastContextPreviewRequest> = {}, signal?: AbortSignal) {
      const value = castContextPreviewRequestSchema.parse(input);
      const search = new URLSearchParams({ view: "characters", query: value.query, inputMode: value.inputMode });
      if (value.budgetTokens !== undefined) search.set("budgetTokens", String(value.budgetTokens));
      return http.request({ method: "GET", path: `/campaigns/${encodeURIComponent(campaignId)}/memory/context-preview?${search}`,
        responseSchema: castContextExplanationSchema, ...(signal ? { signal } : {}) });
    },
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
    async workspaceStatus(campaignId: string, signal?: AbortSignal) {
      const path = pathFor(campaignId), requestSignal = signal ? { signal } : {};
      try {
        return await http.request({ method: "GET", path: `${path}/workspace-status`, responseSchema: charactersWorkspaceStatusSchema, ...requestSignal });
      } catch (error) {
        if (!(error instanceof NexusApiError) || error.statusCode !== 404) throw error;
        const [roster, tracking] = await Promise.all([
          http.request({ method: "GET", path, responseSchema: castListResponseSchema, ...requestSignal }),
          http.request({ method: "GET", path: `${path}/discovery`, responseSchema: castDiscoveryStatusSchema, ...requestSignal }).catch(error => {
            if (error instanceof NexusApiError && error.statusCode === 404) return null;
            throw error;
          })
        ]);
        return charactersWorkspaceStatusSchema.parse({ revision: roster.revision, boundary: roster.boundary,
          capabilities: { editing: roster.capabilities.castEditing, discovery: null, autoMatch: null, backfill: null, context: null },
          contextDisabledReason: null, counts: { identities: null, details: null, conflicts: null }, legacyServer: true, tracking });
      }
    },
    async list(campaignId: string, input: Partial<CastListQuery> = {}, signal?: AbortSignal) {
      const path = pathFor(campaignId), query = validatedRequest(castListQuerySchema, input, "GET", path);
      const search = new URLSearchParams({ limit: String(query.limit), query: query.query });
      if (query.cursor) search.set("cursor", query.cursor);
      if (query.filter !== "all") search.set("filter", query.filter);
      if (query.expectedRevision !== undefined) search.set("expectedRevision", String(query.expectedRevision));
      if (query.expectedTurnNumber !== undefined) search.set("expectedTurnNumber", String(query.expectedTurnNumber));
      if (query.expectedTimelineRevision !== undefined) search.set("expectedTimelineRevision", String(query.expectedTimelineRevision));
      return http.request({ method: "GET", path: `${path}?${search}`, responseSchema: castListResponseSchema, ...(signal ? { signal } : {}) });
    },
    detail: (campaignId: string, id: string, signal?: AbortSignal) => http.request({ method: "GET", path: `${pathFor(campaignId)}/${encodeURIComponent(id)}`, responseSchema: castDetailResponseSchema, ...(signal ? { signal } : {}) }),
    async create(campaignId: string, input: CreateCastCharacter) {
      const path = pathFor(campaignId), value = validatedRequest(createCastCharacterSchema, input, "POST", path);
      return http.request({ method: "POST", path, body: { kind: "json", value }, responseSchema: castWriteResultSchema });
    },
    async resolveDetail(campaignId: string, candidateId: string, input: ReviewCastDetail) {
      const path = `${pathFor(campaignId)}/candidates/${encodeURIComponent(candidateId)}/details/resolve`;
      const value = validatedRequest(reviewCastDetailSchema, input, "POST", path);
      return http.request({ method: "POST", path, body: { kind: "json", value }, responseSchema: reviewCastDetailResultSchema });
    },
    async detachAttachment(campaignId: string, characterId: string, eventId: string, input: DetachCastAttachment) {
      const path = `${pathFor(campaignId)}/${encodeURIComponent(characterId)}/attachments/${encodeURIComponent(eventId)}/detach`;
      const value = validatedRequest(detachCastAttachmentSchema, input, "POST", path);
      return http.request({ method: "POST", path, body: { kind: "json", value }, responseSchema: detachCastAttachmentResultSchema });
    },
    async edit(campaignId: string, id: string, input: EditCastCharacter) {
      const path = `${pathFor(campaignId)}/${encodeURIComponent(id)}`, value = validatedRequest(editCastCharacterSchema, input, "PATCH", path);
      return http.request({ method: "PATCH", path, body: { kind: "json", value }, responseSchema: castWriteResultSchema });
    }
  };
}
export type CampaignCastApi = ReturnType<typeof createCampaignCastApi>;
