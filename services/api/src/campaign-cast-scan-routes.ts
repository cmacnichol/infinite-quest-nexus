import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { CampaignCastError, type CastBackfillApplication } from "../../../packages/application/src/campaign-cast/index.js";

export async function registerCampaignCastScanRoutes(app: FastifyInstance, options: {
  application?: CastBackfillApplication; resolveOwner(): Promise<{ ownerUserId: string }>;
}) {
  const base = "/api/v1/campaigns/:campaignId/cast/scans";
  const params = z.object({ campaignId: z.uuid(), scanId: z.uuid().optional() }).strict();
  for (const [method, suffix, operation] of [["GET", "", "latest"], ["POST", "", "start"],
    ["POST", "/preview", "preview"], ["GET", "/:scanId", "get"], ["POST", "/:scanId/pause", "pause"],
    ["POST", "/:scanId/resume", "resume"], ["POST", "/:scanId/cancel", "cancel"], ["POST", "/:scanId/retry", "retry"]] as const) {
    app.route({ method, url: base + suffix, bodyLimit: 64 * 1024, handler: async (request, reply) => {
      try {
        const ids = params.parse(request.params), scope = { ...await options.resolveOwner(), campaignId: ids.campaignId };
        const application = options.application;
        if (!application) throw new CampaignCastError("cast_discovery_disabled");
        if (operation === "latest") return { scan: await application.latest(scope), capabilities: { castBackfill: application.enabled } };
        if (operation === "get") return await application.get(scope, ids.scanId!);
        if (operation === "preview") return await application.preview(scope, request.body as never);
        if (operation === "start") return reply.code(201).send(await application.start(scope, request.body as never));
        if (operation === "retry") return await application.retry(scope, ids.scanId!, request.body as never);
        z.object({}).strict().parse(request.body ?? {});
        return await application.control(scope, ids.scanId!, operation);
      } catch (caught) {
        let error = caught;
        if (error instanceof Error && error.message === "cast_stale_boundary") error = new CampaignCastError("cast_revision_conflict");
        if (error instanceof Error && ["cast_history_gap", "cast_disjoint_coverage"].includes(error.message)) error = new CampaignCastError("cast_invalid_request");
        if (error instanceof z.ZodError) error = new CampaignCastError("cast_invalid_request");
        if (!(error instanceof CampaignCastError)) throw error;
        const status = error.code === "cast_not_found" ? 404 : error.code === "cast_invalid_request" ? 422
          : ["cast_discovery_disabled", "cast_discovery_unavailable"].includes(error.code) ? 503 : 409;
        return reply.code(status).send({ code: error.code, error: "CampaignCastError", message: error.message, correlationId: request.id, details: { code: error.code } });
      }
    } });
  }
}
