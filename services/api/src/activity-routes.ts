import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { activityPageQuerySchema, activityPageSchema } from "../../../packages/contracts/src/activity.js";
import { ActivityRepositoryError, type ActivityReadRepository } from "../../../packages/database/src/activity-repository.js";

export async function registerActivityRoutes(app: FastifyInstance, options: {
  resolveOwner(): Promise<{ ownerUserId: string }>;
  activityReader: ActivityReadRepository;
}) {
  app.get("/api/v1/campaigns/:campaignId/activity", async (request, reply) => {
    const params = z.strictObject({ campaignId: z.uuid() }).safeParse(request.params);
    const query = activityPageQuerySchema.safeParse(request.query);
    const sendError = (status: number, code: string, message: string) => reply.code(status).send({
      error: status === 404 ? "Not Found" : "ActivityError", code, message, correlationId: request.id, details: {}
    });
    if (!params.success || !query.success) return sendError(400, "activity_invalid_request", "Invalid activity request.");
    try {
      const scope = { ...await options.resolveOwner(), campaignId: params.data.campaignId };
      const page = await options.activityReader.list(scope, query.data);
      const validated = activityPageSchema.safeParse(page);
      if (!validated.success) return sendError(500, "activity_unavailable", "Activity history is unavailable.");
      return validated.data;
    } catch (error) {
      if (error instanceof ActivityRepositoryError && error.code === "not_found") return sendError(404, "activity_not_found", "Campaign not found.");
      if (error instanceof ActivityRepositoryError && error.code === "invalid_cursor") return sendError(400, "activity_invalid_cursor", "Invalid activity cursor.");
      // Repository scope validation and stored-output validation must never expose schema diagnostics.
      request.log.error({ code: "activity_unavailable", correlationId: request.id }, "activity_read_failed");
      return sendError(500, "activity_unavailable", "Activity history is unavailable.");
    }
  });
}
