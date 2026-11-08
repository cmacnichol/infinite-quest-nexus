import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { CampaignCastError, type CampaignCastApplication } from "../../../packages/application/src/campaign-cast/index.js";
import { registerCampaignCastScanRoutes } from "./campaign-cast-scan-routes.js";

export async function registerCampaignCastRoutes(app: FastifyInstance, options: {
  application: CampaignCastApplication; enabled: boolean; resolveOwner(): Promise<{ ownerUserId: string }>;
}) {
  await registerCampaignCastScanRoutes(app, { ...(options.application.scans ? { application: options.application.scans } : {}), resolveOwner: options.resolveOwner });
  const base = "/api/v1/campaigns/:campaignId/cast";
  const params = z.object({ campaignId: z.uuid(), characterId: z.uuid().optional(), candidateId: z.uuid().optional(), jobId: z.uuid().optional(), eventId: z.uuid().optional() });
  for (const [method, path] of [["GET", base], ["GET", `${base}/from-world-preview`], ["POST", `${base}/from-world`], ["POST", `${base}/:characterId/authored-profile`], ["POST", base], ["GET", `${base}/workspace-status`], ["GET", `${base}/discovery`], ["GET", `${base}/candidates`],
    ["POST", `${base}/:characterId/attachments/:eventId/detach`], ["POST", `${base}/discovery/:jobId/retry`], ["POST", `${base}/candidates/:candidateId/details/resolve`], ["POST", `${base}/candidates/:candidateId/resolve`], ["GET", `${base}/:characterId`], ["PATCH", `${base}/:characterId`]] as const) {
    app.route({ method, url: path, bodyLimit: path.endsWith("/authored-profile") ? 8 * 1024 * 1024
      : method === "PATCH" || method === "POST" && path === base ? 320 * 1024 : 64 * 1024, handler: async (request, reply) => {
      try {
        const ids = params.parse(request.params);
        const scope = { ...await options.resolveOwner(), campaignId: ids.campaignId };
        const capabilities = { castEditing: options.enabled };
        if (path === `${base}/workspace-status`) return await options.application.workspaceStatus(scope);
        if (path === `${base}/discovery`) return await options.application.discoveryStatus(scope);
        if (path === `${base}/candidates`) return await options.application.candidates(scope, request.query as never);
        if (path === `${base}/from-world-preview`) return await options.application.fromWorldPreview(scope, request.query as never);
        if (method === "GET") return ids.characterId
          ? { ...await options.application.detail(scope, ids.characterId), capabilities }
          : { ...await options.application.list(scope, request.query as never), capabilities };
        if (!options.enabled) throw new CampaignCastError("cast_editing_disabled");
        if (path === `${base}/from-world`) {
          const result = await options.application.fromWorld(scope, request.body as never);
          return reply.code((request.body as { targetCastCharacterId?: string }).targetCastCharacterId ? 200 : 201).send(result);
        }
        if (path.endsWith("/authored-profile")) return await options.application.editAuthoredProfile(scope, ids.characterId!, request.body as never);
        if (ids.eventId) return await options.application.detachAttachment(scope, ids.characterId!, ids.eventId, request.body as never);
        if (ids.jobId) return await options.application.retryDiscovery(scope, ids.jobId, request.body as never);
        if (path === `${base}/candidates/:candidateId/details/resolve`) return await options.application.resolveDetail(scope, ids.candidateId!, request.body as never);
        if (ids.candidateId) return await options.application.resolveCandidate(scope, ids.candidateId, request.body as never);
        if (method === "POST") return reply.code(201).send(await options.application.create(scope, request.body as never));
        return await options.application.edit(scope, ids.characterId!, request.body as never);
      } catch (error) {
        if (error instanceof z.ZodError) return reply.code(422).send({ code: "cast_invalid_request",
          error: "CastValidationError", message: "Check the character fields and request limits.", correlationId: request.id, details: { fields: error.issues.map(issue => ({ path: issue.path.join("."), code: issue.code })) } });
        if (!(error instanceof CampaignCastError)) throw error;
        const status = ["cast_not_found", "cast_world_character_unavailable"].includes(error.code) ? 404 : ["cast_presets_disabled", "cast_editing_disabled", "cast_discovery_disabled", "cast_discovery_admission_required", "cast_discovery_unavailable"].includes(error.code) ? 503
          : ["cast_invalid_request", "cast_protagonist_read_only", "cast_invalid_field_class", "cast_not_seeded", "cast_fixed_field_override"].includes(error.code) ? 422 : 409;
        return reply.code(status).send({ code: error.code, error: "CampaignCastError", message: error.message,
          correlationId: request.id, details: { code: error.code, ...(error.fields.length ? { fields: error.fields } : {}) }, ...(error.code === "cast_protagonist_read_only"
          ? { editorDestination: `/api/v1/campaigns/${params.parse(request.params).campaignId}/character-profile` } : {}) });
      }
    } });
  }
}
