import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { CampaignCastError, type CampaignCastApplication } from "../../../packages/application/src/campaign-cast/index.js";
import { registerCampaignCastScanRoutes } from "./campaign-cast-scan-routes.js";

export async function registerCampaignCastRoutes(app: FastifyInstance, options: {
  application: CampaignCastApplication; enabled: boolean; resolveOwner(): Promise<{ ownerUserId: string }>;
}) {
  await registerCampaignCastScanRoutes(app, { ...(options.application.scans ? { application: options.application.scans } : {}), resolveOwner: options.resolveOwner });
  const base = "/api/v1/campaigns/:campaignId/cast";
  const params = z.object({ campaignId: z.uuid(), characterId: z.uuid().optional(), candidateId: z.uuid().optional(), jobId: z.uuid().optional() });
  for (const [method, path] of [["GET", base], ["POST", base], ["GET", `${base}/discovery`], ["GET", `${base}/candidates`],
    ["POST", `${base}/discovery/:jobId/retry`], ["POST", `${base}/candidates/:candidateId/resolve`], ["GET", `${base}/:characterId`], ["PATCH", `${base}/:characterId`]] as const) {
    app.route({ method, url: path, bodyLimit: 64 * 1024, handler: async (request, reply) => {
      try {
        const ids = params.parse(request.params);
        const scope = { ...await options.resolveOwner(), campaignId: ids.campaignId };
        const capabilities = { castEditing: options.enabled };
        if (path === `${base}/discovery`) return await options.application.discoveryStatus(scope);
        if (path === `${base}/candidates`) return await options.application.candidates(scope, request.query as never);
        if (method === "GET") return ids.characterId
          ? { ...await options.application.detail(scope, ids.characterId), capabilities }
          : { ...await options.application.list(scope, request.query as never), capabilities };
        if (!options.enabled) throw new CampaignCastError("cast_editing_disabled");
        if (ids.jobId) return await options.application.retryDiscovery(scope, ids.jobId, request.body as never);
        if (ids.candidateId) return await options.application.resolveCandidate(scope, ids.candidateId, request.body as never);
        if (method === "POST") return reply.code(201).send(await options.application.create(scope, request.body as never));
        return await options.application.edit(scope, ids.characterId!, request.body as never);
      } catch (error) {
        if (error instanceof z.ZodError) return reply.code(422).send({ code: "cast_invalid_request",
          error: "CastValidationError", message: "Check the character fields and request limits.", correlationId: request.id, details: {} });
        if (!(error instanceof CampaignCastError)) throw error;
        const status = error.code === "cast_not_found" ? 404 : ["cast_editing_disabled", "cast_discovery_disabled", "cast_discovery_admission_required", "cast_discovery_unavailable"].includes(error.code) ? 503
          : ["cast_invalid_request", "cast_protagonist_read_only"].includes(error.code) ? 422 : 409;
        return reply.code(status).send({ code: error.code, error: "CampaignCastError", message: error.message,
          correlationId: request.id, details: { code: error.code }, ...(error.code === "cast_protagonist_read_only"
          ? { editorDestination: `/api/v1/campaigns/${params.parse(request.params).campaignId}/character-profile` } : {}) });
      }
    } });
  }
}
